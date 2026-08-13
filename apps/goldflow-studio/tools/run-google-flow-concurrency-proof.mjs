#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolDir, "../../..");
const desktopMainPath = path.join(repoRoot, "apps", "goldflow-studio", "desktop", "main.mjs");
const REQUIRED_TIERS = [5, 10, 15, 20];
const PROGRESS_NAME = "google_flow_concurrency_progress.json";
const REPORT_NAME = "google_flow_concurrency_report.json";

function nowIso() {
  return new Date().toISOString();
}

function compactError(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    flags[key] = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[++index] : "true";
  }
  return flags;
}

function firstFlag(flags, ...names) {
  for (const name of names) {
    if (flags[name] !== undefined) return flags[name];
  }
  return undefined;
}

function requiredFlag(flags, ...names) {
  const value = firstFlag(flags, ...names);
  if (!String(value ?? "").trim()) throw new Error(`Missing required flag --${names[0]}.`);
  return String(value);
}

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function booleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

function assertSha256(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${label} must be an exact lowercase SHA-256.`);
  return normalized;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function readJson(filePath, label = "JSON") {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${label} at ${filePath}: ${compactError(error)}`);
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function pathExists(filePath) {
  return fs.stat(filePath).then(() => true).catch(() => false);
}

function ensureInside(filePath, rootPath, label) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(rootPath);
  const relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return resolved;
  throw new Error(`${label} must remain inside ${root}: ${resolved}.`);
}

function resolveSelectionPath(value, sourceEpisodeDir, label) {
  const expanded = String(value ?? "").replaceAll("${EP}", sourceEpisodeDir);
  if (!expanded.trim()) throw new Error(`${label} is required in the selection JSON.`);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(sourceEpisodeDir, expanded));
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function helpText() {
  return `Google Flow concurrency proof runner

Required:
  --source-episode-dir <dir>
  --selection-json <json>
  --proof-dir <empty-dir>
  --prior-health-proof <file>
  --prior-health-proof-sha256 <sha256>

Browser/controller:
  --port <number>                 default: 4327
  --profile-dir <dir>             default: ~/.goldflow-studio/google-flow-browser-profile
  --state-dir <dir>               default: ~/.goldflow-studio
  --downloads-root <dir>          default: <proof-dir>/downloads
  --data-root <dir>               default: ANIFACTORY_DATA_ROOT or /Users/joel/AniFactoryData
  --flow-plan <label>             default: PLUS
  --flow-model <label>            default: Nano Banana Pro
  --headless <true|false>         default: false

Timing:
  --startup-timeout-ms <ms>       default: 120000
  --wave-timeout-ms <ms>          default: 2700000
  --settle-timeout-ms <ms>        default: 2100000
  --poll-ms <ms>                  default: 500

The selection must contain exact 5/10/15/20 waves, honest baseline-provider
metadata, accepted GPT-image paths and hashes, and ordered reference paths.
No tier or asset is retried.
`;
}

function normalizeWaveEntries(selection) {
  const raw = selection.waves ?? selection.batches;
  if (!raw) throw new Error("Selection JSON must contain waves or batches.");
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([key, value]) => ({
      ...(value && typeof value === "object" && !Array.isArray(value) ? value : { candidates: value }),
      concurrency: Number(key),
    }));
  }
  throw new Error("Selection waves/batches must be an array or keyed object.");
}

function candidateId(value) {
  return String(typeof value === "string" ? value : value?.image_id ?? value?.asset_id ?? value?.id ?? "").trim();
}

function candidateRegistry(selection) {
  const registry = new Map();
  const rows = Array.isArray(selection.candidates) ? selection.candidates : [];
  for (const row of rows) {
    const id = candidateId(row);
    if (!id) continue;
    if (registry.has(id)) throw new Error(`Selection contains duplicate candidate metadata for ${id}.`);
    registry.set(id, row);
  }
  return registry;
}

function candidatesForWave(rawWave, registry) {
  const rawCandidates = rawWave.candidates ?? rawWave.items ?? rawWave.image_ids ?? rawWave.imageIds ?? rawWave.asset_ids ?? rawWave.assetIds;
  if (!Array.isArray(rawCandidates)) throw new Error(`Wave ${rawWave.concurrency ?? rawWave.tier ?? "unknown"} must contain a candidate or image-id array.`);
  return rawCandidates.map((entry) => {
    if (typeof entry === "object" && entry !== null) return entry;
    const id = candidateId(entry);
    return registry.get(id) ?? { image_id: id };
  });
}

function selectedReferencePaths(candidate, sourceEpisodeDir) {
  const hasExplicitReferences = ["reference_paths", "ordered_reference_paths", "references", "ordered_references"]
    .some((key) => Object.hasOwn(candidate, key));
  if (!hasExplicitReferences) return null;
  const raw = candidate.reference_paths
    ?? candidate.ordered_reference_paths
    ?? candidate.references
    ?? candidate.ordered_references
    ?? [];
  if (!Array.isArray(raw)) throw new Error(`Candidate ${candidateId(candidate)} references must be an array.`);
  return raw.map((entry, index) => resolveSelectionPath(
    typeof entry === "string" ? entry : entry?.path ?? entry?.reference_image_path,
    sourceEpisodeDir,
    `Candidate ${candidateId(candidate)} reference slot ${index + 1}`,
  ));
}

function promptReferenceRows(promptRow, promptPath) {
  const requirements = Array.isArray(promptRow.reference_requirements)
    ? [...promptRow.reference_requirements].sort((left, right) => Number(left?.slot_order ?? 0) - Number(right?.slot_order ?? 0))
    : [];
  if (requirements.length) {
    return requirements.map((row, index) => ({
      slot: index + 1,
      ref_id: String(row?.ref_id ?? `slot_${index + 1}`),
      path: path.resolve(path.dirname(promptPath), String(row?.reference_image_path ?? row?.path ?? "")),
    }));
  }
  const explicitPaths = Array.isArray(promptRow.required_reference_paths) ? promptRow.required_reference_paths : [];
  return explicitPaths.map((value, index) => ({
    slot: index + 1,
    ref_id: `slot_${index + 1}`,
    path: path.resolve(path.dirname(promptPath), String(value)),
  }));
}

function acceptedResultSha256(result) {
  return result?.generated?.output_sha256
    ?? result?.output_sha256
    ?? result?.image_sha256
    ?? result?.sha256
    ?? null;
}

function acceptedCandidatePath(candidate, sourceEpisodeDir, selection) {
  const template = String(selection.gpt_baseline?.image_path_template ?? "").replaceAll("{image_id}", candidateId(candidate));
  return resolveSelectionPath(
    candidate.accepted_gpt_image_path
      ?? candidate.accepted_image_path
      ?? candidate.baseline_image_path
      ?? candidate.image_path
      ?? template,
    sourceEpisodeDir,
    `Candidate ${candidateId(candidate)} accepted GPT baseline path`,
  );
}

function acceptedCandidateSha(candidate, fallbackSha256 = null) {
  return assertSha256(
    candidate.accepted_gpt_image_sha256
      ?? candidate.accepted_image_sha256
      ?? candidate.baseline_image_sha256
      ?? candidate.image_sha256
      ?? candidate.sha256
      ?? fallbackSha256,
    `Candidate ${candidateId(candidate)} accepted GPT baseline hash`,
  );
}

function declaredBaselineMetadata(selection) {
  if (selection.gpt_baseline && typeof selection.gpt_baseline === "object") {
    const baseline = selection.gpt_baseline;
    const provider = String(baseline.provider ?? "").trim();
    const declaredModel = String(baseline.declared_model ?? "").trim();
    const referencedModel = String(baseline.referenced_model ?? declaredModel).trim();
    const transportNote = String(baseline.transport_note ?? "").trim();
    if (!provider || !declaredModel || !referencedModel || !transportNote) {
      throw new Error("Selection gpt_baseline must declare provider, zero/reference models, and an honest transport_note.");
    }
    return {
      kind: "accepted_gpt_image_comparison_baseline",
      content_provider: provider,
      zero_reference_model: declaredModel,
      referenced_model: referencedModel,
      transport_note: transportNote,
      run_identity_image_provider: null,
      report_image_provider: null,
    };
  }
  const nested = selection.baseline_provider_metadata ?? selection.baseline_provider ?? {};
  const nestedObject = nested && typeof nested === "object" && !Array.isArray(nested) ? nested : {};
  const kind = String(selection.baseline_kind ?? nestedObject.kind ?? "").trim();
  const identityProvider = String(selection.run_identity_image_provider ?? nestedObject.run_identity_image_provider ?? nestedObject.identity_provider ?? "").trim();
  const reportProvider = String(selection.report_image_provider ?? nestedObject.report_image_provider ?? nestedObject.report_provider ?? "").trim();
  if (!kind || !identityProvider || !reportProvider) {
    throw new Error("Selection JSON must declare baseline_kind, run_identity_image_provider, and report_image_provider honestly.");
  }
  return { kind, run_identity_image_provider: identityProvider, report_image_provider: reportProvider };
}

async function validateSelection(config, selection) {
  const declaredEpisodeDir = selection.episode_dir ?? selection.source_episode_dir;
  if (declaredEpisodeDir && !samePath(resolveSelectionPath(declaredEpisodeDir, config.sourceEpisodeDir, "selection episode_dir"), config.sourceEpisodeDir)) {
    throw new Error(`Selection episode_dir does not match --source-episode-dir: ${declaredEpisodeDir}.`);
  }
  if (selection.run_status && String(selection.run_status) !== "complete") {
    throw new Error(`Selection source run is not complete: ${selection.run_status}.`);
  }

  const promptPath = resolveSelectionPath(
    selection.prompt_path ?? selection.source_prompt_plan_path ?? path.join(config.sourceEpisodeDir, "section_image_prompts_hardened.json"),
    config.sourceEpisodeDir,
    "selection prompt_path",
  );
  ensureInside(promptPath, config.sourceEpisodeDir, "Selection prompt path");
  const promptPlan = await readJson(promptPath, "source hardened prompt plan");
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts)) {
    throw new Error(`Source prompt plan must be passed and contain prompts: ${promptPath}.`);
  }
  const promptFileSha256 = await sha256File(promptPath);
  const declaredPromptFileSha256 = selection.prompt_file_sha256 ?? selection.source_hash_locks?.section_image_prompts_hardened_sha256;
  if (declaredPromptFileSha256 && assertSha256(declaredPromptFileSha256, "selection prompt file hash") !== promptFileSha256) {
    throw new Error(`Selection prompt hash is stale for ${promptPath}.`);
  }

  const runIdentityPath = resolveSelectionPath(selection.run_identity_path ?? path.join(config.sourceEpisodeDir, "run_identity.json"), config.sourceEpisodeDir, "run identity path");
  ensureInside(runIdentityPath, config.sourceEpisodeDir, "Run identity path");
  const runIdentity = await readJson(runIdentityPath, "source run identity");
  const baselineReportPath = resolveSelectionPath(selection.baseline_report_path ?? selection.source_imagegen_report_path, config.sourceEpisodeDir, "baseline_report_path");
  ensureInside(baselineReportPath, config.sourceEpisodeDir, "Baseline report path");
  const baselineReport = await readJson(baselineReportPath, "accepted GPT baseline report");
  if (baselineReport?.status !== "passed" || !Array.isArray(baselineReport.results)) {
    throw new Error(`Accepted GPT baseline report must be passed and contain results: ${baselineReportPath}.`);
  }
  if (Number(baselineReport.missing_image_count ?? 0) !== 0) {
    throw new Error(`Accepted GPT baseline report has missing images: ${baselineReport.missing_image_count}.`);
  }
  const declaredReportSha256 = selection.source_hash_locks?.imagegen_report_sha256;
  const baselineReportSha256 = await sha256File(baselineReportPath);
  if (declaredReportSha256 && assertSha256(declaredReportSha256, "selection baseline report hash") !== baselineReportSha256) {
    throw new Error(`Selection baseline report hash is stale for ${baselineReportPath}.`);
  }

  const cutLedgerPath = resolveSelectionPath(selection.source_cut_execution_ledger_path, config.sourceEpisodeDir, "source_cut_execution_ledger_path");
  ensureInside(cutLedgerPath, config.sourceEpisodeDir, "Cut execution ledger path");
  const cutLedger = await readJson(cutLedgerPath, "accepted cut execution ledger");
  if (!Array.isArray(cutLedger.cuts)) throw new Error(`Cut execution ledger must contain cuts: ${cutLedgerPath}.`);
  const cutLedgerSha256 = await sha256File(cutLedgerPath);
  const declaredLedgerSha256 = selection.source_hash_locks?.cut_execution_ledger_sha256;
  if (declaredLedgerSha256 && assertSha256(declaredLedgerSha256, "selection cut ledger hash") !== cutLedgerSha256) {
    throw new Error(`Selection cut execution ledger hash is stale for ${cutLedgerPath}.`);
  }

  const declaredBaseline = declaredBaselineMetadata(selection);
  const actualIdentityProvider = String(runIdentity.image_provider ?? runIdentity.provider_locks?.image_provider ?? "").trim();
  const actualReportProvider = String(baselineReport.image_provider ?? baselineReport.provider ?? "").trim();
  if (declaredBaseline.run_identity_image_provider && declaredBaseline.run_identity_image_provider !== actualIdentityProvider) {
    throw new Error(`Selection run-identity baseline provider ${declaredBaseline.run_identity_image_provider} does not match ${actualIdentityProvider}.`);
  }
  if (declaredBaseline.report_image_provider && declaredBaseline.report_image_provider !== actualReportProvider) {
    throw new Error(`Selection report baseline provider ${declaredBaseline.report_image_provider} does not match ${actualReportProvider}.`);
  }

  const promptById = new Map();
  for (const row of promptPlan.prompts) {
    const id = candidateId(row);
    if (!id) throw new Error("Source prompt plan contains a row without image_id.");
    if (promptById.has(id)) throw new Error(`Source prompt plan contains duplicate image_id ${id}.`);
    promptById.set(id, row);
  }
  const resultById = new Map();
  for (const result of baselineReport.results) {
    const id = candidateId(result);
    if (id) resultById.set(id, result);
  }
  const ledgerById = new Map(cutLedger.cuts.map((row) => [candidateId(row), row]));

  const registry = candidateRegistry(selection);
  const rawWaves = normalizeWaveEntries(selection);
  const waveByTier = new Map();
  const globallySelected = new Set();
  for (const rawWave of rawWaves) {
    const tier = Number(rawWave.concurrency ?? rawWave.tier ?? rawWave.max_concurrency ?? rawWave.maxConcurrency);
    if (!REQUIRED_TIERS.includes(tier)) throw new Error(`Unexpected concurrency tier ${tier}; required tiers are 5, 10, 15, 20.`);
    if (waveByTier.has(tier)) throw new Error(`Selection contains duplicate tier ${tier}.`);
    const candidates = candidatesForWave(rawWave, registry);
    if (candidates.length !== tier) throw new Error(`Tier ${tier} must contain exactly ${tier} candidates, received ${candidates.length}.`);
    waveByTier.set(tier, candidates);
  }
  if (waveByTier.size !== REQUIRED_TIERS.length || REQUIRED_TIERS.some((tier) => !waveByTier.has(tier))) {
    throw new Error("Selection must contain exactly the 5, 10, 15, and 20 tiers.");
  }

  const trackedSources = new Map();
  const track = async (filePath) => {
    if (!trackedSources.has(filePath)) trackedSources.set(filePath, await sha256File(filePath));
    return trackedSources.get(filePath);
  };
  await Promise.all([track(promptPath), track(runIdentityPath), track(baselineReportPath), track(cutLedgerPath), track(config.selectionPath), track(config.priorHealthProofPath)]);
  const optionalLockedSources = [
    [selection.source_image_review_decisions_path, selection.source_hash_locks?.image_output_review_decisions_sha256, "image output review decisions"],
    [selection.source_image_qa_path, null, "image output QA"],
  ];
  for (const [sourcePath, expectedSha256, label] of optionalLockedSources) {
    if (!sourcePath) continue;
    const resolved = resolveSelectionPath(sourcePath, config.sourceEpisodeDir, label);
    ensureInside(resolved, config.sourceEpisodeDir, label);
    const actualSha256 = await track(resolved);
    if (expectedSha256 && assertSha256(expectedSha256, `${label} hash`) !== actualSha256) throw new Error(`Selection ${label} hash is stale.`);
  }
  const models = new Set();
  const providers = new Set();
  const normalizedWaves = [];

  for (const tier of REQUIRED_TIERS) {
    const normalizedCandidates = [];
    for (const candidate of waveByTier.get(tier)) {
      const id = candidateId(candidate);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`Tier ${tier} contains an unsafe or empty image id: ${JSON.stringify(id)}.`);
      if (globallySelected.has(id)) throw new Error(`Image id ${id} is reused across concurrency tiers; every proof submission must be unique.`);
      globallySelected.add(id);
      const promptRow = promptById.get(id);
      if (!promptRow) throw new Error(`Selected image ${id} is absent from the source hardened prompt plan.`);
      if (promptRow.image_generation_required === false) throw new Error(`Selected image ${id} is marked image_generation_required=false.`);
      const activePrompt = String(promptRow.codex_image_prompt ?? promptRow.provider_prompt ?? promptRow.image_prompt ?? "").trim();
      if (!activePrompt) throw new Error(`Selected image ${id} has no usable source prompt.`);
      if (candidate.current_hardened_prompt_sha256 && String(candidate.current_hardened_prompt_sha256) !== String(promptRow.prompt_hash ?? "")) {
        throw new Error(`Selected image ${id} has a stale current_hardened_prompt_sha256.`);
      }

      const promptRefs = promptReferenceRows(promptRow, promptPath);
      const selectedRefs = selectedReferencePaths(candidate, config.sourceEpisodeDir) ?? promptRefs.map((row) => row.path);
      const expectedRefCount = Number(candidate.ref_count ?? candidate.reference_count ?? selectedRefs.length);
      if (!Number.isInteger(expectedRefCount) || expectedRefCount < 0 || expectedRefCount > 4 || selectedRefs.length !== expectedRefCount) {
        throw new Error(`Selected image ${id} has an invalid reference count/path binding.`);
      }
      if (promptRefs.length !== selectedRefs.length || promptRefs.some((row, index) => !samePath(row.path, selectedRefs[index]))) {
        throw new Error(`Selected image ${id} ordered references differ from the source hardened prompt row.`);
      }
      const orderedReferences = [];
      for (const [index, reference] of promptRefs.entries()) {
        if (!(await pathExists(reference.path))) throw new Error(`Selected image ${id} reference slot ${index + 1} is missing: ${reference.path}.`);
        orderedReferences.push({ ...reference, sha256: await track(reference.path) });
      }

      const ledgerRow = ledgerById.get(id);
      if (!ledgerRow) throw new Error(`Selected image ${id} is absent from the accepted cut execution ledger.`);
      if (!/^passed/i.test(String(ledgerRow.image_qa_status ?? ""))) throw new Error(`Selected image ${id} did not pass image QA: ${ledgerRow.image_qa_status}.`);
      const imagePath = acceptedCandidatePath(candidate, config.sourceEpisodeDir, selection);
      ensureInside(imagePath, config.sourceEpisodeDir, `Selected image ${id} accepted baseline path`);
      if (!(await pathExists(imagePath))) throw new Error(`Selected image ${id} accepted GPT baseline is missing: ${imagePath}.`);
      const selectedImageSha256 = acceptedCandidateSha(candidate, ledgerRow.image_sha256);
      const actualImageSha256 = await track(imagePath);
      if (selectedImageSha256 !== actualImageSha256) throw new Error(`Selected image ${id} accepted GPT baseline hash mismatch.`);

      const baselineResult = resultById.get(id);
      if (!baselineResult) throw new Error(`Selected image ${id} is absent from the accepted GPT baseline report.`);
      if (!samePath(baselineResult.image_path ?? baselineResult.generated?.downloaded_path ?? "", imagePath)) {
        throw new Error(`Selected image ${id} baseline report path does not match the selection.`);
      }
      const resultSha256 = acceptedResultSha256(baselineResult);
      if (resultSha256 && resultSha256 !== actualImageSha256) throw new Error(`Selected image ${id} baseline report hash is stale.`);
      if (/fail|missing|error|pending/i.test(String(baselineResult.status ?? ""))) {
        throw new Error(`Selected image ${id} baseline result is not accepted: ${baselineResult.status}.`);
      }
      const resultProvider = String(baselineResult.image_provider ?? actualReportProvider).trim();
      if (candidate.baseline_provider && String(candidate.baseline_provider) !== resultProvider) {
        throw new Error(`Selected image ${id} baseline_provider does not match its accepted report row.`);
      }
      if (declaredBaseline.content_provider && resultProvider !== declaredBaseline.content_provider) {
        throw new Error(`Selected image ${id} content provider ${resultProvider} does not match declared GPT baseline provider ${declaredBaseline.content_provider}.`);
      }
      if (!samePath(ledgerRow.image_path ?? "", imagePath) || String(ledgerRow.image_sha256 ?? "") !== actualImageSha256) {
        throw new Error(`Selected image ${id} cut ledger path/hash is stale.`);
      }
      if (String(ledgerRow.image_provider ?? "") !== resultProvider) throw new Error(`Selected image ${id} provider differs between report and cut ledger.`);
      const expectedModel = selectedRefs.length ? declaredBaseline.referenced_model : declaredBaseline.zero_reference_model;
      if (expectedModel && String(ledgerRow.image_model ?? "") !== expectedModel) {
        throw new Error(`Selected image ${id} model ${ledgerRow.image_model} does not match declared GPT baseline model ${expectedModel}.`);
      }
      providers.add(resultProvider);

      const metadataPath = candidate.baseline_metadata_path
        ? resolveSelectionPath(candidate.baseline_metadata_path, config.sourceEpisodeDir, `${id} baseline metadata path`)
        : `${imagePath}.metadata.json`;
      let metadata = null;
      let metadataSha256 = null;
      if (await pathExists(metadataPath)) {
        metadata = await readJson(metadataPath, `${id} accepted GPT metadata`);
        metadataSha256 = await track(metadataPath);
        const metadataReferences = (metadata.reference_image_paths ?? []).map((value) => path.resolve(String(value)));
        if (metadataReferences.length !== selectedRefs.length || metadataReferences.some((value, index) => !samePath(value, selectedRefs[index]))) {
          throw new Error(`Selected image ${id} generation metadata has different ordered references.`);
        }
        const metadataSha = metadata.generated?.output_sha256 ?? metadata.source_manual_codex_image_sha256;
        if (metadataSha && metadataSha !== actualImageSha256) throw new Error(`Selected image ${id} generation metadata hash is stale.`);
        const generatedPrompt = String(metadata.codex_prompt ?? metadata.image_prompt ?? "");
        if (generatedPrompt && !generatedPrompt.endsWith(activePrompt)) {
          throw new Error(`Selected image ${id} current hardened prose differs from the accepted GPT generation prompt.`);
        }
        if (metadata.image_provider) providers.add(String(metadata.image_provider));
        const submittedModel = metadata.generated?.modelslab_model_id ?? ledgerRow.image_model ?? metadata.model;
        if (expectedModel && String(submittedModel ?? "") !== expectedModel) throw new Error(`Selected image ${id} submitted model metadata is stale.`);
        if (submittedModel) models.add(String(submittedModel));
      } else if (String(baselineResult.prompt_hash ?? "") !== String(promptRow.prompt_hash ?? "")) {
        throw new Error(`Selected image ${id} lacks generation metadata and cannot prove prompt equivalence.`);
      }

      normalizedCandidates.push({
        image_id: id,
        start_sec: Number(promptRow.start_sec ?? candidate.start_sec ?? 0),
        reference_count: orderedReferences.length,
        ordered_references: orderedReferences,
        source_prompt_hash: String(promptRow.prompt_hash ?? ""),
        accepted_gpt_baseline: {
          path: imagePath,
          sha256: actualImageSha256,
          status: baselineResult.status ?? "accepted",
          provider: resultProvider,
          model: metadata?.generated?.modelslab_model_id ?? ledgerRow.image_model ?? metadata?.model ?? candidate.baseline_model ?? null,
          metadata_path: metadata ? metadataPath : null,
          metadata_sha256: metadataSha256,
          generation_prompt_sha256: String(baselineResult.prompt_hash ?? candidate.baseline_generation_prompt_sha256 ?? "") || null,
        },
      });
    }
    normalizedWaves.push({ tier, candidates: normalizedCandidates });
  }

  return {
    promptPath,
    promptFileSha256,
    promptPlan,
    runIdentityPath,
    runIdentitySha256: trackedSources.get(runIdentityPath),
    baselineReportPath,
    baselineReportSha256,
    cutLedgerPath,
    cutLedgerSha256,
    declaredBaseline,
    actualBaseline: {
      run_identity_image_provider: actualIdentityProvider,
      report_image_provider: actualReportProvider,
      accepted_content_provider: declaredBaseline.content_provider ?? null,
      accepted_result_providers: [...providers].sort(),
      accepted_models: [...models].sort(),
      transport: declaredBaseline.content_provider === "modelslab"
        ? "modelslab_api"
        : actualIdentityProvider === "chatgpt_web_gpt_image" ? "chatgpt_web" : "codex_openai_builtin_imagegen",
    },
    waves: normalizedWaves,
    trackedSources,
  };
}

async function prepareProofDirectory(config, validation) {
  const existing = await fs.readdir(config.proofDir).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  const reserved = new Set([
    PROGRESS_NAME,
    REPORT_NAME,
    "execution-progress.json",
    "execution-report.json",
    "source-comparison-catalog.json",
    "controller-state",
    "downloads",
  ]);
  const conflicting = (existing ?? []).filter((name) => reserved.has(name) || /^wave[-_]\d+$/i.test(name));
  if (conflicting.length) {
    throw new Error(`Proof directory already contains runtime output (${conflicting.join(", ")}); refusing a retry or output reuse.`);
  }
  await fs.mkdir(config.proofDir, { recursive: true });
  const waves = [];
  for (const selectedWave of validation.waves) {
    const waveDir = path.join(config.proofDir, `wave_${String(selectedWave.tier).padStart(2, "0")}`);
    await fs.mkdir(waveDir, { recursive: false });
    const promptSlicePath = path.join(waveDir, "section_image_prompts_hardened.json");
    const ids = new Set(selectedWave.candidates.map((candidate) => candidate.image_id));
    const promptRows = validation.promptPlan.prompts.filter((row) => ids.has(candidateId(row)));
    if (promptRows.length !== selectedWave.tier) throw new Error(`Internal prompt-slice mismatch for tier ${selectedWave.tier}.`);
    await writeJsonAtomic(promptSlicePath, {
      ...validation.promptPlan,
      status: "passed",
      image_provider: validation.promptPlan.image_provider ?? "codex_imagegen",
      prompts: promptRows,
      concurrency_proof_scope: {
        schema: "goldflow_google_flow_concurrency_prompt_slice_v1",
        tier: selectedWave.tier,
        source_prompt_path: validation.promptPath,
        source_prompt_sha256: validation.promptFileSha256,
        image_ids: selectedWave.candidates.map((candidate) => candidate.image_id),
        prior_health_proof_path: config.priorHealthProofPath,
        prior_health_proof_sha256: config.priorHealthProofSha256,
        prepared_at: nowIso(),
      },
    });
    waves.push({
      tier: selectedWave.tier,
      status: "prepared",
      wave_dir: waveDir,
      prompt_slice_path: promptSlicePath,
      prompt_slice_sha256: await sha256File(promptSlicePath),
      selected_candidates: selectedWave.candidates,
      manifest_id: null,
      manifest_path: null,
      max_observed_active: 0,
      target_concurrency_observed_at: null,
      timings: {},
      item_transitions: {},
      failures: [],
    });
  }
  return waves;
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Port ${port} is already in use.`));
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (["ECONNREFUSED", "EHOSTUNREACH"].includes(error?.code)) resolve();
      else reject(error);
    });
  });
}

function appendTail(lines, chunk, maxLines = 120) {
  lines.push(...String(chunk).split(/\r?\n/).filter(Boolean));
  if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
}

function spawnDesktopHost(config, wave, adminToken) {
  const logPath = path.join(wave.wave_dir, "desktop_host.log");
  const logStream = createWriteStream(logPath, { flags: "wx" });
  const args = [
    desktopMainPath,
    "--provider", "google-flow",
    "--types", "image",
    "--concurrency", String(wave.tier),
    "--port", String(config.port),
    "--state-dir", config.stateDir,
    "--profile-dir", config.profileDir,
    "--downloads-root", config.downloadsRoot,
    "--data-root", config.dataRoot,
    "--flow-plan", config.flowPlan,
    "--flow-model", config.flowModel,
    "--headless", String(config.headless),
    "--open-dashboard", "false",
    "--login-bootstrap", "false",
    "--login", "false",
    "--label", `Google Flow concurrency proof tier ${wave.tier}`,
  ];
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      GOLDFLOW_STUDIO_ADMIN_TOKEN: adminToken,
      ANIFACTORY_DATA_ROOT: config.dataRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = [];
  child.stdout.on("data", (chunk) => {
    logStream.write(chunk);
    appendTail(tail, chunk);
  });
  child.stderr.on("data", (chunk) => {
    logStream.write(chunk);
    appendTail(tail, chunk);
  });
  let exitInfo = null;
  const exitPromise = new Promise((resolve) => {
    child.once("error", (error) => {
      exitInfo = { code: null, signal: null, error: compactError(error), at: nowIso() };
      resolve(exitInfo);
    });
    child.once("close", (code, signal) => {
      exitInfo ??= { code, signal, error: null, at: nowIso() };
      logStream.end();
      resolve(exitInfo);
    });
  });
  return { child, exitPromise, tail, logPath, getExitInfo: () => exitInfo };
}

async function apiRequest(baseUrl, adminToken, route, { method = "GET", body = null, timeoutMs = 30_000, auth = true } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${adminToken}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : null,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const value = await response.json().catch(() => ({ status: "invalid_json" }));
  if (!response.ok) throw new Error(`Goldflow Studio ${route} failed with HTTP ${response.status}: ${value.error ?? value.code ?? JSON.stringify(value)}`);
  return value;
}

async function waitForController(config, host, adminToken) {
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const deadline = Date.now() + config.startupTimeoutMs;
  while (Date.now() < deadline) {
    if (host.getExitInfo()) throw new Error(`Desktop host exited before controller health passed: ${JSON.stringify(host.getExitInfo())}.`);
    try {
      const health = await apiRequest(baseUrl, adminToken, "/v1/health", { auth: false, timeoutMs: 2_000 });
      if (health.status === "ok" && health.browser_provider === "google-flow" && Number(health.worker_slot_ceiling) === 19) return { baseUrl, health };
    } catch {
      // The controller and persistent browser start in the same process.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for the Google Flow controller on ${baseUrl}.`);
}

function summaryForManifest(state, manifestId) {
  return (state.image_manifests ?? []).find((row) => row.manifest_id === manifestId) ?? null;
}

function observeSummary(wave, summary, observedAt) {
  const active = Number(summary?.counts?.leased ?? 0);
  const completed = Number(summary?.counts?.completed ?? 0);
  if (active > wave.max_observed_active) {
    wave.max_observed_active = active;
    wave.timings.max_active_observed_at = observedAt;
  }
  if (active > 0 && !wave.timings.first_lease_observed_at) wave.timings.first_lease_observed_at = observedAt;
  if (completed > 0 && !wave.timings.first_completion_observed_at) wave.timings.first_completion_observed_at = observedAt;
  if (active >= wave.tier && !wave.target_concurrency_observed_at) wave.target_concurrency_observed_at = observedAt;
  for (const item of summary?.items ?? []) {
    const current = wave.item_transitions[item.asset_id] ?? { history: [] };
    const last = current.history[current.history.length - 1];
    if (!last || last.status !== item.status) current.history.push({ status: item.status, observed_at: observedAt });
    current.attempt_count = item.attempt_count;
    current.completion_sha256 = item.completion_sha256;
    current.deadletter_reason = item.deadletter_reason;
    wave.item_transitions[item.asset_id] = current;
  }
}

async function sourceIntegrity(trackedSources) {
  const findings = [];
  for (const [filePath, expectedSha256] of trackedSources.entries()) {
    const currentSha256 = await sha256File(filePath).catch(() => null);
    if (currentSha256 !== expectedSha256) findings.push({ path: filePath, expected_sha256: expectedSha256, current_sha256: currentSha256 });
  }
  return { status: findings.length ? "failed" : "passed", checked_file_count: trackedSources.size, findings, checked_at: nowIso() };
}

async function stopHost(host, timeoutMs = 90_000) {
  if (!host) return { status: "not_started" };
  if (host.getExitInfo()) return { status: "already_stopped", exit: host.getExitInfo() };
  host.child.kill("SIGTERM");
  const outcome = await Promise.race([
    host.exitPromise.then((exit) => ({ status: "stopped", exit })),
    sleep(timeoutMs).then(() => ({ status: "timeout" })),
  ]);
  if (outcome.status === "timeout") {
    host.child.kill("SIGKILL");
    const exit = await host.exitPromise;
    return { status: "forced", exit };
  }
  return outcome;
}

async function deactivateManifest(baseUrl, adminToken, wave) {
  if (!wave.manifest_path) return { status: "not_created" };
  return apiRequest(baseUrl, adminToken, "/v1/dashboard/manifests/deactivate", {
    method: "POST",
    body: { manifestPath: wave.manifest_path },
  });
}

async function monitorWave({ config, report, wave, host, baseUrl, adminToken, writeProgress, interrupted }) {
  const deadline = Date.now() + config.waveTimeoutMs;
  let lastSummary = null;
  let failure = null;
  let consecutiveControllerErrors = 0;
  while (Date.now() < deadline && !failure) {
    if (interrupted.value) {
      failure = { code: "operator_interrupt", message: interrupted.value, detected_at: nowIso() };
      break;
    }
    if (host.getExitInfo()) {
      failure = { code: "desktop_host_exited", message: JSON.stringify(host.getExitInfo()), detected_at: nowIso() };
      break;
    }
    try {
      const state = await apiRequest(baseUrl, adminToken, "/v1/dashboard/state", { timeoutMs: 10_000 });
      consecutiveControllerErrors = 0;
      const observedAt = nowIso();
      const summary = summaryForManifest(state, wave.manifest_id);
      if (summary) {
        lastSummary = summary;
        observeSummary(wave, summary, observedAt);
      }
      wave.last_dashboard_observation = {
        at: observedAt,
        runtime_paused: state.runtime?.paused === true,
        pause_reason: state.runtime?.pause_reason ?? null,
        manifest_status: summary?.status ?? null,
        counts: summary?.counts ?? null,
      };
      if (state.runtime?.paused === true) {
        failure = {
          code: state.runtime?.pause_reason?.code ?? "controller_paused",
          message: state.runtime?.pause_reason?.message ?? "Google Flow controller paused dispatch.",
          pause_reason: state.runtime?.pause_reason ?? null,
          detected_at: observedAt,
        };
      } else if (summary?.status === "blocked_deadletter" || Number(summary?.counts?.deadlettered ?? 0) > 0) {
        failure = { code: "manifest_deadletter", message: "At least one Google Flow submission failed.", detected_at: observedAt };
      } else if (summary?.status === "completed") {
        if (Number(summary?.counts?.completed ?? 0) !== wave.tier) {
          failure = { code: "completion_count_mismatch", message: `Tier ${wave.tier} completed ${summary?.counts?.completed ?? 0} items.`, detected_at: observedAt };
        } else if (wave.max_observed_active < wave.tier) {
          failure = { code: "target_concurrency_not_observed", message: `Tier ${wave.tier} only demonstrated ${wave.max_observed_active} simultaneous live leases.`, detected_at: observedAt };
        } else {
          wave.status = "passed";
          wave.timings.completed_at = observedAt;
          wave.final_manifest_summary = summary;
          await writeProgress();
          return { status: "passed", summary };
        }
      }
      await writeProgress();
    } catch (error) {
      consecutiveControllerErrors += 1;
      if (consecutiveControllerErrors >= 3) failure = { code: "controller_monitor_failure", message: compactError(error), detected_at: nowIso() };
    }
    if (!failure) await sleep(config.pollMs);
  }
  if (!failure) failure = { code: "wave_timeout", message: `Tier ${wave.tier} exceeded ${config.waveTimeoutMs} ms.`, detected_at: nowIso() };

  wave.status = "settling_after_failure";
  wave.failures.push(failure);
  wave.timings.failure_detected_at = failure.detected_at;
  await apiRequest(baseUrl, adminToken, "/v1/dashboard/pause", {
    method: "POST",
    body: { paused: true, reason: `Concurrency proof stopped at tier ${wave.tier}: ${failure.code}.` },
  }).catch((error) => wave.failures.push({ code: "pause_request_failed", message: compactError(error), detected_at: nowIso() }));
  await writeProgress();

  const settleDeadline = Date.now() + config.settleTimeoutMs;
  while (Date.now() < settleDeadline && !host.getExitInfo()) {
    try {
      const state = await apiRequest(baseUrl, adminToken, "/v1/dashboard/state", { timeoutMs: 10_000 });
      const summary = summaryForManifest(state, wave.manifest_id);
      if (summary) {
        lastSummary = summary;
        observeSummary(wave, summary, nowIso());
        wave.last_dashboard_observation = {
          at: nowIso(),
          runtime_paused: state.runtime?.paused === true,
          pause_reason: state.runtime?.pause_reason ?? null,
          manifest_status: summary.status,
          counts: summary.counts,
        };
        await writeProgress();
        if (Number(summary.counts?.leased ?? 0) === 0) {
          wave.timings.submitted_jobs_settled_at = nowIso();
          break;
        }
      }
    } catch (error) {
      wave.failures.push({ code: "settle_monitor_failure", message: compactError(error), detected_at: nowIso() });
      break;
    }
    await sleep(config.pollMs);
  }
  if (Number(lastSummary?.counts?.leased ?? 0) > 0) {
    wave.failures.push({
      code: "settle_timeout",
      message: `${lastSummary.counts.leased} submitted job(s) did not settle within ${config.settleTimeoutMs} ms.`,
      detected_at: nowIso(),
    });
  }
  wave.status = "failed";
  wave.final_manifest_summary = lastSummary;
  wave.timings.settle_finished_at = nowIso();
  await writeProgress();
  return { status: "failed", summary: lastSummary, failure };
}

async function assertNoActiveFlowManifests(stateDir) {
  const activePath = path.join(stateDir, "providers", "google-flow", "active-image-manifests.json");
  const state = await readJson(activePath, "Google Flow active manifest state").catch((error) => {
    if (/ENOENT/.test(compactError(error))) return { manifests: [] };
    throw error;
  });
  const active = (state?.manifests ?? []).filter((entry) => typeof entry === "string" || entry?.browser_provider === "google-flow");
  if (active.length) throw new Error(`Google Flow has ${active.length} pre-existing active manifest(s). Deactivate them before starting an isolated proof.`);
}

async function runProof(config) {
  const selection = await readJson(config.selectionPath, "concurrency selection");
  const actualPriorSha256 = await sha256File(config.priorHealthProofPath);
  if (actualPriorSha256 !== config.priorHealthProofSha256) throw new Error(`Prior health proof hash mismatch for ${config.priorHealthProofPath}.`);
  const validation = await validateSelection(config, selection);
  await assertPortFree(config.port);
  await assertNoActiveFlowManifests(config.stateDir);
  const waves = await prepareProofDirectory(config, validation);
  const progressPath = path.join(config.proofDir, PROGRESS_NAME);
  const reportPath = path.join(config.proofDir, REPORT_NAME);
  const adminToken = randomBytes(32).toString("hex");
  const interrupted = { value: null };
  let activeHost = null;
  const signalHandler = (signal) => {
    interrupted.value ??= `Received ${signal}.`;
    activeHost?.child.kill("SIGTERM");
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);

  const report = {
    schema: "goldflow_google_flow_concurrency_proof_v1",
    status: "running",
    created_at: nowIso(),
    updated_at: nowIso(),
    finished_at: null,
    source: {
      episode_dir: config.sourceEpisodeDir,
      hardened_prompt_path: validation.promptPath,
      hardened_prompt_sha256: validation.promptFileSha256,
      run_identity_path: validation.runIdentityPath,
      run_identity_sha256: validation.runIdentitySha256,
      baseline_report_path: validation.baselineReportPath,
      baseline_report_sha256: validation.baselineReportSha256,
      cut_execution_ledger_path: validation.cutLedgerPath,
      cut_execution_ledger_sha256: validation.cutLedgerSha256,
      selection_path: config.selectionPath,
      selection_sha256: await sha256File(config.selectionPath),
    },
    baseline_provider: {
      declared_by_selection: validation.declaredBaseline,
      validated_actual: validation.actualBaseline,
    },
    prior_health_proof: {
      path: config.priorHealthProofPath,
      sha256: config.priorHealthProofSha256,
    },
    policy: {
      tiers: REQUIRED_TIERS,
      exact_unique_submission_count: REQUIRED_TIERS.reduce((sum, tier) => sum + tier, 0),
      max_attempts_per_item: 1,
      retry_allowed: false,
      stop_after_first_failed_or_paused_tier: true,
      source_artifact_mutation_allowed: false,
      contact_sheets: false,
    },
    controller: {
      provider: "google-flow",
      port: config.port,
      profile_dir: config.profileDir,
      state_dir: config.stateDir,
      downloads_root: config.downloadsRoot,
      data_root: config.dataRoot,
      flow_plan: config.flowPlan,
      flow_model: config.flowModel,
      dashboard_opened: false,
      login_bootstrap: false,
      admin_token_mode: "single_ephemeral_static_token_for_all_waves_not_recorded",
    },
    waves,
    highest_passed_concurrency: 0,
    stopped_after_tier: null,
    source_integrity: null,
  };
  const writeProgress = async () => {
    report.updated_at = nowIso();
    await writeJsonAtomic(progressPath, report);
  };
  await writeProgress();

  try {
    for (const wave of waves) {
      if (interrupted.value) throw new Error(interrupted.value);
      wave.status = "starting_host";
      wave.timings.wave_started_at = nowIso();
      await writeProgress();
      activeHost = spawnDesktopHost(config, wave, adminToken);
      wave.desktop_host_log_path = activeHost.logPath;
      const { baseUrl, health } = await waitForController(config, activeHost, adminToken);
      wave.controller_health = health;
      wave.timings.controller_ready_at = nowIso();
      const initialState = await apiRequest(baseUrl, adminToken, "/v1/dashboard/state");
      if ((initialState.image_manifests ?? []).length) throw new Error(`Tier ${wave.tier} controller started with an unexpected active manifest.`);

      const manifest = await apiRequest(baseUrl, adminToken, "/v1/dashboard/manifests/create", {
        method: "POST",
        body: {
          mode: "scene",
          episodeDir: wave.wave_dir,
          promptsPath: wave.prompt_slice_path,
          imageIds: wave.selected_candidates.map((candidate) => candidate.image_id),
          concurrency: wave.tier,
          maxConcurrency: wave.tier,
          concurrencyProof: true,
          priorHealthProofPath: config.priorHealthProofPath,
          priorHealthProofSha256: config.priorHealthProofSha256,
          leaseSeconds: 1800,
        },
      });
      if (manifest.item_count !== wave.tier || manifest.asset_ids?.length !== wave.tier) {
        throw new Error(`Tier ${wave.tier} manifest did not bind exactly ${wave.tier} assets.`);
      }
      if (manifest.created !== true) throw new Error(`Tier ${wave.tier} manifest was reused; concurrency proofs require fresh one-attempt queues.`);
      wave.manifest_id = manifest.manifest_id;
      wave.manifest_path = manifest.manifest_path;
      wave.manifest_asset_ids = manifest.asset_ids;
      wave.status = "running";
      wave.timings.manifest_created_at = nowIso();
      await writeProgress();

      const outcome = await monitorWave({ config, report, wave, host: activeHost, baseUrl, adminToken, writeProgress, interrupted });
      try {
        wave.deactivation = await deactivateManifest(baseUrl, adminToken, wave);
      } catch (error) {
        wave.deactivation = { status: "failed", error: compactError(error) };
        wave.failures.push({ code: "manifest_deactivation_failed", message: compactError(error), detected_at: nowIso() });
        wave.status = "failed";
      }
      wave.timings.manifest_deactivated_at = nowIso();
      wave.host_stop = await stopHost(activeHost);
      wave.desktop_host_log_tail = [...activeHost.tail];
      wave.timings.host_stopped_at = nowIso();
      activeHost = null;

      const integrity = await sourceIntegrity(validation.trackedSources);
      wave.source_integrity_after_wave = integrity;
      if (integrity.status !== "passed") {
        wave.failures.push({ code: "source_artifact_mutated", message: "A bound source artifact changed during the proof.", detected_at: nowIso(), findings: integrity.findings });
        wave.status = "failed";
      }
      if (wave.deactivation?.status === "failed" || wave.host_stop?.status === "forced") wave.status = "failed";
      if (outcome.status === "passed" && wave.status !== "failed") {
        wave.status = "passed";
        report.highest_passed_concurrency = wave.tier;
      } else {
        wave.status = "failed";
        report.stopped_after_tier = wave.tier;
      }
      wave.timings.wave_finished_at = nowIso();
      await writeProgress();
      if (wave.status !== "passed") break;
      await assertPortFree(config.port);
      await assertNoActiveFlowManifests(config.stateDir);
    }

    report.source_integrity = await sourceIntegrity(validation.trackedSources);
    const allPassed = waves.every((wave) => wave.status === "passed");
    report.status = allPassed && report.source_integrity.status === "passed" ? "passed" : "failed";
    if (!allPassed && report.stopped_after_tier === null) {
      report.stopped_after_tier = waves.find((wave) => wave.status !== "passed")?.tier ?? null;
    }
  } catch (error) {
    report.status = "failed";
    report.fatal_error = { message: compactError(error), at: nowIso() };
    const activeWave = waves.find((wave) => !["passed", "failed", "prepared"].includes(wave.status));
    if (activeWave) {
      activeWave.failures.push({ code: "orchestrator_failure", message: compactError(error), detected_at: nowIso() });
      activeWave.status = "failed";
      report.stopped_after_tier ??= activeWave.tier;
    }
  } finally {
    if (activeHost) {
      const baseUrl = `http://127.0.0.1:${config.port}`;
      const wave = waves.find((candidate) => candidate.manifest_id && !candidate.host_stop);
      if (wave) {
        await apiRequest(baseUrl, adminToken, "/v1/dashboard/pause", {
          method: "POST",
          body: { paused: true, reason: "Concurrency proof orchestrator is stopping." },
        }).catch(() => {});
        const settleDeadline = Date.now() + config.settleTimeoutMs;
        while (Date.now() < settleDeadline) {
          const state = await apiRequest(baseUrl, adminToken, "/v1/dashboard/state", { timeoutMs: 5_000 }).catch(() => null);
          const summary = state ? summaryForManifest(state, wave.manifest_id) : null;
          if (!summary || Number(summary.counts?.leased ?? 0) === 0) break;
          await sleep(config.pollMs);
        }
        wave.deactivation ??= await deactivateManifest(baseUrl, adminToken, wave).catch((error) => ({ status: "failed", error: compactError(error) }));
      }
      const stopped = await stopHost(activeHost);
      if (wave) {
        wave.host_stop ??= stopped;
        wave.desktop_host_log_tail ??= [...activeHost.tail];
      }
      activeHost = null;
    }
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
    report.source_integrity ??= await sourceIntegrity(validation.trackedSources);
    report.finished_at = nowIso();
    report.updated_at = report.finished_at;
    await writeJsonAtomic(progressPath, report);
    await writeJsonAtomic(reportPath, report);
  }

  process.stdout.write(`${JSON.stringify({
    status: report.status,
    report_path: reportPath,
    progress_path: progressPath,
    highest_passed_concurrency: report.highest_passed_concurrency,
    stopped_after_tier: report.stopped_after_tier,
  }, null, 2)}\n`);
  if (report.status !== "passed") process.exitCode = 2;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (booleanFlag(flags.help) || booleanFlag(flags.h)) {
    process.stdout.write(helpText());
    return;
  }
  const sourceEpisodeDir = path.resolve(requiredFlag(flags, "source-episode-dir", "source-episode"));
  const selectionPath = path.resolve(requiredFlag(flags, "selection-json", "selection"));
  const proofDir = path.resolve(requiredFlag(flags, "proof-dir"));
  const priorHealthProofPath = path.resolve(requiredFlag(flags, "prior-health-proof", "prior-health-proof-path"));
  const priorHealthProofSha256 = assertSha256(requiredFlag(flags, "prior-health-proof-sha256"), "--prior-health-proof-sha256");
  const stateDir = path.resolve(firstFlag(flags, "state-dir") ?? path.join(os.homedir(), ".goldflow-studio"));
  const profileDir = path.resolve(firstFlag(flags, "profile-dir") ?? path.join(stateDir, "google-flow-browser-profile"));
  const downloadsRoot = path.resolve(firstFlag(flags, "downloads-root", "download-dir") ?? path.join(proofDir, "downloads"));
  const dataRoot = path.resolve(firstFlag(flags, "data-root") ?? process.env.ANIFACTORY_DATA_ROOT ?? "/Users/joel/AniFactoryData");
  const port = positiveInteger(firstFlag(flags, "port"), 4327, "--port");
  if (port > 65535) throw new Error("--port must be at most 65535.");
  ensureInside(sourceEpisodeDir, dataRoot, "Source episode");
  ensureInside(selectionPath, dataRoot, "Selection JSON");
  ensureInside(proofDir, dataRoot, "Proof directory");
  ensureInside(priorHealthProofPath, dataRoot, "Prior health proof");
  if (samePath(sourceEpisodeDir, proofDir)) throw new Error("--proof-dir cannot be the source episode directory.");
  for (const [filePath, label] of [[sourceEpisodeDir, "source episode"], [selectionPath, "selection JSON"], [priorHealthProofPath, "prior health proof"], [desktopMainPath, "desktop host"]]) {
    if (!(await pathExists(filePath))) throw new Error(`Missing ${label}: ${filePath}.`);
  }
  await runProof({
    sourceEpisodeDir,
    selectionPath,
    proofDir,
    priorHealthProofPath,
    priorHealthProofSha256,
    stateDir,
    profileDir,
    downloadsRoot,
    dataRoot,
    port,
    flowPlan: String(firstFlag(flags, "flow-plan") ?? "PLUS"),
    flowModel: String(firstFlag(flags, "flow-model") ?? "Nano Banana Pro"),
    headless: booleanFlag(firstFlag(flags, "headless"), false),
    startupTimeoutMs: positiveInteger(firstFlag(flags, "startup-timeout-ms"), 120_000, "--startup-timeout-ms"),
    waveTimeoutMs: positiveInteger(firstFlag(flags, "wave-timeout-ms"), 45 * 60_000, "--wave-timeout-ms"),
    settleTimeoutMs: positiveInteger(firstFlag(flags, "settle-timeout-ms"), 35 * 60_000, "--settle-timeout-ms"),
    pollMs: positiveInteger(firstFlag(flags, "poll-ms"), 500, "--poll-ms"),
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
