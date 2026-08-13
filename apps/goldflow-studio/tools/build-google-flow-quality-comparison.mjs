#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const PAIR_SCHEMA = "goldflow_google_flow_gpt_image_pair_proof_v1";
const REVIEW_SCHEMA = "goldflow_provider_pair_human_review_v1";
const TAXONOMY_SCHEMA = "google_flow_vs_gpt_image_quality_review_v1";
const OUTPUT_DIRECTORY_NAME = "quality-comparison";
const PAIR_REPORT_NAME = "google_flow_gpt_image_pair_proof.json";
const HUMAN_REVIEW_NAME = "provider_pair_human_review.json";
const DEFAULT_ASPECT_RATIO = 16 / 9;
const DEFAULT_ASPECT_TOLERANCE = 0.08;

const SCORE_CATEGORIES = Object.freeze({
  story_prompt_fidelity: "Named subject, action, location, props, and explicit exclusions.",
  reference_identity_continuity: "Face/identity, wardrobe/state, location/prop/UI anchor fidelity. N/A is allowed only for a zero-reference row.",
  anatomy_action_coherence: "Limb and hand count, contacts, pose, object interaction, and perspective.",
  composition_readability: "Focal hierarchy, shot intent, spatial clarity, crop, and 16:9 framing.",
  manhwa_finish_quality: "Linework, rendering, lighting/color, depth, polish, and artifact-free finish.",
});

const ADVISORY_TAGS = Object.freeze([
  "prompt_subject_omission",
  "prompt_action_miss",
  "prompt_location_drift",
  "prompt_prop_or_ui_drift",
  "unprompted_subject_or_object",
  "reference_identity_drift",
  "reference_wardrobe_or_state_drift",
  "reference_location_or_prop_drift",
  "reference_bleed_or_subject_merge",
  "subject_count_error",
  "anatomy_or_limb_error",
  "hand_or_contact_error",
  "pose_or_perspective_error",
  "weak_focal_hierarchy",
  "composition_or_crop_miss",
  "flat_depth_or_staging",
  "style_drift",
  "linework_or_render_artifact",
  "lighting_or_color_weakness",
  "background_artifact",
  "incidental_text_or_gibberish",
  "watermark_or_logo",
  "multi_panel_or_collage",
  "other_advisory",
]);

const flags = parseFlags(process.argv.slice(2));
const selectionPath = requiredPathFlag(flags, "selection");
const requestedProofDir = requiredPathFlag(flags, "proof-dir");
const proofDir = await existingDirectory(requestedProofDir, "--proof-dir");
const outputDir = ensureInside(path.join(proofDir, OUTPUT_DIRECTORY_NAME), proofDir, "quality comparison output directory");
const contactSheetsDir = ensureInside(path.join(outputDir, "contact_sheets"), proofDir, "contact sheet directory");
const pairReportPath = ensureInside(path.join(outputDir, PAIR_REPORT_NAME), proofDir, "pair proof report");
const humanReviewPath = ensureInside(path.join(outputDir, HUMAN_REVIEW_NAME), proofDir, "human review artifact");

const selection = await readJson(selectionPath, "selection");
validateSelectionHeader(selection);
const selectionSha256 = await sha256File(selectionPath);
const executionInputs = await loadExecutionInputs(flags, proofDir);
const sourceArtifacts = await loadLockedSourceArtifacts(selection, path.dirname(selectionPath));
const waves = normalizeSelectionWaves(selection);
const canonicalRows = await buildCanonicalRows({ selection, waves, sourceArtifacts });
const proofEvidence = await discoverProofEvidence(proofDir, outputDir);
const referenceEchoAudit = await loadReferenceEchoAudit({
  proofDir,
  proofEvidence,
  canonicalRows,
  flowCandidate: selection.flow_candidate ?? {},
});
const execution = normalizeExecutionEvidence(executionInputs, waves, selectionPath, selectionSha256);
const flowEvidence = await bindFlowEvidence({
  waves,
  canonicalRows,
  proofEvidence,
  referenceEchoAudit,
  execution,
  flowCandidate: selection.flow_candidate ?? {},
  proofDir,
});
const flowBindings = flowEvidence.successfulBindings;

if (flowBindings.length === 0) {
  throw new Error("No successful Google Flow proof outputs were found; there is nothing to compare.");
}

const pairs = [];
const invalidAttributionRows = [];
for (const invalid of flowEvidence.invalidAttributionBindings) {
  const canonical = canonicalRows.get(invalid.binding.imageId);
  const flow = await validateFlowOutput({
    binding: invalid.binding,
    canonical,
    flowCandidate: selection.flow_candidate ?? {},
    proofDir,
  });
  invalidAttributionRows.push({
    target_concurrency: canonical.targetConcurrency,
    image_id: canonical.imageId,
    status: "invalid_attribution_reference_echo",
    reason: "completed Google Flow output is a re-encoded ordered reference rather than a new prompt result",
    reference_echo_audit: invalid.auditRow,
    google_flow_candidate: flow,
    quality_pair_created: false,
  });
}
flowEvidence.invalidAttributionRows = invalidAttributionRows;
for (const binding of flowBindings) {
  const canonical = canonicalRows.get(binding.imageId);
  const gpt = await validateGptBaseline({ selection, canonical, sourceArtifacts });
  const flow = await validateFlowOutput({ binding, canonical, flowCandidate: selection.flow_candidate ?? {}, proofDir });
  pairs.push({
    ordinal: canonical.ordinal,
    waveOrdinal: canonical.waveOrdinal,
    targetConcurrency: canonical.targetConcurrency,
    imageId: canonical.imageId,
    canonical,
    gpt,
    flow,
  });
}

pairs.sort((left, right) => left.ordinal - right.ordinal || left.imageId.localeCompare(right.imageId));
validateUniqueOutputHashes(pairs);
await refuseToOverwriteCompletedReview(humanReviewPath);

await mkdir(contactSheetsDir, { recursive: true });
const renderedPairs = [];
for (const pair of pairs) {
  const blind = blindAssignment(selection.blind_assignment_seed ?? selection.seed, pair);
  const contactSheetPath = ensureInside(
    path.join(contactSheetsDir, `${String(pair.ordinal).padStart(3, "0")}-${safeSegment(pair.imageId)}-blind-ab.jpg`),
    proofDir,
    `contact sheet for ${pair.imageId}`,
  );
  const contactSheetBytes = await buildPairContactSheet({ pair, blind });
  await writeBufferAtomic(contactSheetPath, contactSheetBytes);
  renderedPairs.push({
    ...pair,
    blind,
    contactSheetPath,
    contactSheetSha256: sha256Bytes(contactSheetBytes),
  });
}

const generatedAt = new Date().toISOString();
const pairReport = buildPairReport({
  generatedAt,
  selection,
  selectionPath,
  selectionSha256,
  proofDir,
  outputDir,
  humanReviewPath,
  executionInputs,
  sourceArtifacts,
  waves,
  execution,
  flowEvidence,
  referenceEchoAudit,
  renderedPairs,
});
await writeJsonAtomic(pairReportPath, pairReport);
const pairReportSha256 = await sha256File(pairReportPath);

const humanReview = buildHumanReview({
  generatedAt,
  pairReportPath,
  pairReportSha256,
  selectionPath,
  selectionSha256,
  renderedPairs,
});
await writeJsonAtomic(humanReviewPath, humanReview);

process.stdout.write(`${JSON.stringify({
  status: "passed",
  pair_count: renderedPairs.length,
  pair_report_path: pairReportPath,
  human_review_path: humanReviewPath,
  contact_sheets_dir: contactSheetsDir,
}, null, 2)}\n`);

function parseFlags(argv) {
  const allowed = new Set(["selection", "proof-dir", "progress", "report"]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) throw new Error(`Malformed flag near ${token ?? "end"}.`);
    const equalsAt = token.indexOf("=");
    const name = token.slice(2, equalsAt === -1 ? undefined : equalsAt);
    if (!allowed.has(name)) throw new Error(`Unknown flag --${name}.`);
    const value = equalsAt === -1 ? argv[++index] : token.slice(equalsAt + 1);
    if (value == null || value === "" || value.startsWith("--")) throw new Error(`Missing value for --${name}.`);
    if (parsed[name] != null) throw new Error(`Duplicate --${name} flag.`);
    parsed[name] = value;
  }
  return parsed;
}

function requiredPathFlag(parsed, name) {
  const value = parsed[name];
  if (!value) throw new Error(`Missing required --${name}.`);
  return path.resolve(value);
}

async function existingDirectory(value, label) {
  const resolved = await realpath(path.resolve(value)).catch(() => null);
  if (!resolved) throw new Error(`${label} does not exist: ${path.resolve(value)}.`);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${resolved}.`);
  return resolved;
}

function ensureInside(candidate, root, label) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  throw new Error(`${label} must stay inside proof directory ${root}: ${resolved}.`);
}

async function existingFileInside(candidate, root, label) {
  const lexical = ensureInside(candidate, root, label);
  const resolved = await realpath(lexical).catch(() => null);
  if (!resolved) throw new Error(`${label} does not exist: ${lexical}.`);
  ensureInside(resolved, root, label);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`${label} is not a file: ${resolved}.`);
  return resolved;
}

async function readJson(filePath, label = "JSON artifact") {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label} at ${filePath}: ${error.message}`);
  }
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSha256(value, label) {
  assert(/^[a-f0-9]{64}$/.test(String(value ?? "")), `${label} must be an exact lowercase SHA-256 digest.`);
  return String(value);
}

function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
}

function assertStringArrayEqual(actual, expected, label) {
  assert(Array.isArray(actual), `${label} must be an array.`);
  assertEqual(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < expected.length; index += 1) {
    assertEqual(String(actual[index]), String(expected[index]), `${label}[${index}]`);
  }
}

function validateSelectionHeader(selection) {
  assert(selection && typeof selection === "object" && !Array.isArray(selection), "Selection must be a JSON object.");
  assertEqual(selection.schema, "goldflow_google_flow_gpt_image_pair_selection_v1", "selection schema");
  assert(["locked", "passed", "ready"].includes(String(selection.status ?? "")), "Selection must be hash-locked before comparison.");
  if ("production_artifacts_mutated" in selection) {
    assertEqual(selection.production_artifacts_mutated, false, "selection production_artifacts_mutated");
  }
  const seed = selection.blind_assignment_seed ?? selection.seed;
  assert(typeof seed === "string" && seed.trim().length > 0, "Selection must provide blind_assignment_seed or seed.");
}

async function loadExecutionInputs(parsed, proofRoot) {
  const rows = [];
  for (const flagName of ["progress", "report"]) {
    if (!parsed[flagName]) continue;
    const artifactPath = await existingFileInside(path.resolve(parsed[flagName]), proofRoot, `--${flagName}`);
    if (rows.some((row) => row.path === artifactPath)) continue;
    rows.push({
      kind: flagName,
      path: artifactPath,
      sha256: await sha256File(artifactPath),
      document: await readJson(artifactPath, `${flagName} artifact`),
    });
  }
  const progress = rows.find((row) => row.kind === "progress") ?? null;
  const report = rows.find((row) => row.kind === "report") ?? null;
  if (progress && report?.document.execution_progress_path != null) {
    assertEqual(path.resolve(report.document.execution_progress_path), progress.path, "execution report progress path");
    assertEqual(assertSha256(report.document.execution_progress_sha256, "execution report progress"), progress.sha256, "execution report progress hash");
  }
  return rows;
}

function firstValue(...values) {
  return values.find((value) => value != null && value !== "");
}

function nestedArtifact(sourceArtifacts, ...keys) {
  for (const key of keys) {
    const value = sourceArtifacts?.[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return {};
}

function resolveReadPath(value, baseDirectory, label) {
  assert(typeof value === "string" && value.trim(), `${label} path is required.`);
  return path.resolve(path.isAbsolute(value) ? value : path.join(baseDirectory, value));
}

async function lockedSourceArtifact({ label, artifactPath, expectedSha256, baseDirectory }) {
  const resolved = resolveReadPath(artifactPath, baseDirectory, label);
  const real = await realpath(resolved).catch(() => null);
  if (!real) throw new Error(`${label} does not exist: ${resolved}.`);
  const info = await stat(real);
  assert(info.isFile(), `${label} must be a file: ${real}.`);
  const lockedSha = assertSha256(expectedSha256, `${label} lock`);
  const currentSha = await sha256File(real);
  assertEqual(currentSha, lockedSha, `${label} SHA-256`);
  return { label, path: real, sha256: currentSha, document: await readJson(real, label) };
}

async function loadLockedSourceArtifacts(selection, selectionDirectory) {
  const source = selection.source_artifacts ?? {};
  const locks = selection.source_hash_locks ?? {};
  const promptNested = nestedArtifact(source, "prompt_plan", "section_image_prompts_hardened");
  const imagegenNested = nestedArtifact(source, "imagegen_report", "image_generation_report");
  const ledgerNested = nestedArtifact(source, "cut_ledger", "cut_execution_ledger");
  const decisionsNested = nestedArtifact(source, "qa_decisions", "image_review_decisions", "image_output_review_decisions");

  const promptPlan = await lockedSourceArtifact({
    label: "locked prompt plan",
    artifactPath: firstValue(
      promptNested.path,
      source.prompt_plan_path,
      selection.source_prompt_plan_path,
    ),
    expectedSha256: firstValue(
      promptNested.sha256,
      promptNested.hash,
      source.prompt_plan_sha256,
      source.prompt_plan_hash,
      locks.section_image_prompts_hardened_sha256,
      locks.prompt_plan_sha256,
    ),
    baseDirectory: selectionDirectory,
  });
  const imagegenReport = await lockedSourceArtifact({
    label: "locked GPT image generation report",
    artifactPath: firstValue(
      imagegenNested.path,
      source.imagegen_report_path,
      selection.source_imagegen_report_path,
    ),
    expectedSha256: firstValue(
      imagegenNested.sha256,
      imagegenNested.hash,
      source.imagegen_report_sha256,
      source.imagegen_report_hash,
      locks.imagegen_report_sha256,
    ),
    baseDirectory: selectionDirectory,
  });
  const cutLedger = await lockedSourceArtifact({
    label: "locked cut execution ledger",
    artifactPath: firstValue(
      ledgerNested.path,
      source.cut_ledger_path,
      source.cut_execution_ledger_path,
      selection.source_cut_execution_ledger_path,
    ),
    expectedSha256: firstValue(
      ledgerNested.sha256,
      ledgerNested.hash,
      source.cut_ledger_sha256,
      source.cut_ledger_hash,
      locks.cut_execution_ledger_sha256,
      locks.cut_ledger_sha256,
    ),
    baseDirectory: selectionDirectory,
  });
  const reviewDecisions = await lockedSourceArtifact({
    label: "locked GPT image review decisions",
    artifactPath: firstValue(
      decisionsNested.path,
      source.qa_decisions_path,
      source.image_review_decisions_path,
      selection.source_image_review_decisions_path,
    ),
    expectedSha256: firstValue(
      decisionsNested.sha256,
      decisionsNested.hash,
      source.qa_decisions_sha256,
      source.qa_decisions_hash,
      locks.image_output_review_decisions_sha256,
      locks.qa_decisions_sha256,
    ),
    baseDirectory: selectionDirectory,
  });

  assert(Array.isArray(promptPlan.document.prompts), "Locked prompt plan must contain prompts[].");
  assert(Array.isArray(imagegenReport.document.results), "Locked image generation report must contain results[].");
  assert(Array.isArray(cutLedger.document.cuts), "Locked cut execution ledger must contain cuts[].");
  assert(Array.isArray(reviewDecisions.document.decisions), "Locked image review decisions must contain decisions[].");
  return { promptPlan, imagegenReport, cutLedger, reviewDecisions };
}

function normalizeSelectionWaves(selection) {
  assert(Array.isArray(selection.waves) && selection.waves.length > 0, "Selection must contain at least one wave.");
  const seenConcurrencies = new Set();
  const seenImageIds = new Set();
  let ordinal = 0;
  const waves = selection.waves.map((wave, waveIndex) => {
    const targetConcurrency = Number(wave.target_concurrency ?? wave.concurrency);
    assert(Number.isInteger(targetConcurrency) && targetConcurrency > 0 && targetConcurrency <= 20, `Selection wave ${waveIndex + 1} has invalid concurrency ${targetConcurrency}.`);
    assert(!seenConcurrencies.has(targetConcurrency), `Selection repeats concurrency ${targetConcurrency}.`);
    seenConcurrencies.add(targetConcurrency);
    const rawRows = Array.isArray(wave.rows)
      ? wave.rows
      : (wave.image_ids ?? []).map((imageId) => ({ image_id: imageId }));
    assertEqual(rawRows.length, targetConcurrency, `selection wave ${targetConcurrency} row count`);
    const rows = rawRows.map((row, rowIndex) => {
      const imageId = String(row?.image_id ?? row?.asset_id ?? "").trim();
      assert(imageId, `Selection wave ${targetConcurrency} row ${rowIndex + 1} is missing image_id.`);
      assert(!seenImageIds.has(imageId), `Selection repeats image_id ${imageId}.`);
      seenImageIds.add(imageId);
      ordinal += 1;
      return {
        raw: row,
        imageId,
        ordinal: Number.isInteger(Number(row.ordinal)) ? Number(row.ordinal) : ordinal,
        waveOrdinal: waveIndex + 1,
        waveRowOrdinal: rowIndex + 1,
        targetConcurrency,
      };
    });
    return {
      raw: wave,
      waveOrdinal: waveIndex + 1,
      targetConcurrency,
      rows,
      imageIds: rows.map((row) => row.imageId),
    };
  });
  for (let index = 1; index < waves.length; index += 1) {
    assert(waves[index].targetConcurrency > waves[index - 1].targetConcurrency, "Selection concurrency waves must be strictly increasing.");
  }
  return waves;
}

function uniqueIndex(rows, idField, label) {
  const index = new Map();
  for (const row of rows) {
    const id = String(row?.[idField] ?? "");
    if (!id) continue;
    assert(!index.has(id), `${label} contains duplicate ${idField} ${id}.`);
    index.set(id, row);
  }
  return index;
}

function normalizeExpectedReferences(rawReferences, baseDirectory, label) {
  if (!Array.isArray(rawReferences)) return null;
  return rawReferences.map((reference, index) => ({
    slot: Number(reference.slot ?? reference.slot_order ?? index + 1),
    refId: String(reference.ref_id ?? ""),
    path: resolveReadPath(reference.path ?? reference.reference_image_path, baseDirectory, `${label} reference ${index + 1}`),
    sha256: assertSha256(reference.sha256, `${label} reference ${index + 1}`),
  }));
}

async function buildCanonicalRows({ selection, waves, sourceArtifacts }) {
  const promptIndex = uniqueIndex(sourceArtifacts.promptPlan.document.prompts, "image_id", "locked prompt plan");
  const ledgerIndex = uniqueIndex(sourceArtifacts.cutLedger.document.cuts, "image_id", "locked cut execution ledger");
  const canonicalRows = new Map();
  for (const wave of waves) {
    for (const selectionRow of wave.rows) {
      const prompt = promptIndex.get(selectionRow.imageId);
      const ledger = ledgerIndex.get(selectionRow.imageId);
      assert(prompt, `Locked prompt plan is missing selected image ${selectionRow.imageId}.`);
      assert(ledger, `Locked cut execution ledger is missing selected image ${selectionRow.imageId}.`);
      const canonicalPromptField = String(selectionRow.raw.canonical_prompt_field ?? selection.canonical_prompt_field ?? "provider_prompt");
      const canonicalPrompt = prompt[canonicalPromptField];
      assert(typeof canonicalPrompt === "string" && canonicalPrompt.trim(), `${selectionRow.imageId} has no usable ${canonicalPromptField}.`);
      const canonicalPromptSha256 = sha256Text(canonicalPrompt);
      assertEqual(prompt.prompt_hash, canonicalPromptSha256, `${selectionRow.imageId} locked prompt hash`);
      const selectedPromptSha = selectionRow.raw.canonical_prompt_sha256;
      if (selectedPromptSha != null) assertEqual(assertSha256(selectedPromptSha, `${selectionRow.imageId} selection prompt hash`), canonicalPromptSha256, `${selectionRow.imageId} selection prompt hash`);

      const referenceSlots = Array.isArray(prompt.reference_slots) ? prompt.reference_slots : [];
      assert(referenceSlots.length <= 4, `${selectionRow.imageId} has ${referenceSlots.length} references; comparison supports at most four.`);
      const references = [];
      for (let index = 0; index < referenceSlots.length; index += 1) {
        const reference = referenceSlots[index];
        const slot = Number(reference.slot ?? reference.slot_order ?? index + 1);
        assertEqual(slot, index + 1, `${selectionRow.imageId} reference slot order`);
        const refId = String(reference.ref_id ?? "").trim();
        assert(refId, `${selectionRow.imageId} reference slot ${slot} is missing ref_id.`);
        const referencePath = resolveReadPath(reference.path ?? reference.reference_image_path, path.dirname(sourceArtifacts.promptPlan.path), `${selectionRow.imageId} reference ${slot}`);
        const realReferencePath = await realpath(referencePath).catch(() => null);
        assert(realReferencePath, `${selectionRow.imageId} reference ${slot} does not exist: ${referencePath}.`);
        const referenceSha256 = await sha256File(realReferencePath);
        references.push({
          slot,
          ref_id: refId,
          kind: reference.kind ?? null,
          path: realReferencePath,
          sha256: referenceSha256,
        });
      }

      const selectedReferences = normalizeExpectedReferences(
        selectionRow.raw.ordered_references,
        path.dirname(selectionPath),
        `${selectionRow.imageId} selection`,
      );
      if (selectedReferences) compareReferenceContracts(selectedReferences, references, `${selectionRow.imageId} selection references`);
      compareLedgerReferences(ledger, references, selectionRow.imageId);

      canonicalRows.set(selectionRow.imageId, {
        ...selectionRow,
        canonicalPromptField,
        canonicalPrompt,
        canonicalPromptSha256,
        promptRow: prompt,
        ledgerRow: ledger,
        references,
      });
    }
  }
  return canonicalRows;
}

function compareReferenceContracts(actual, expected, label) {
  assertEqual(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < expected.length; index += 1) {
    const left = actual[index];
    const right = expected[index];
    assertEqual(Number(left.slot), Number(right.slot), `${label}[${index}].slot`);
    assertEqual(String(left.refId ?? left.ref_id), String(right.refId ?? right.ref_id), `${label}[${index}].ref_id`);
    assertEqual(String(left.sha256), String(right.sha256), `${label}[${index}].sha256`);
    if (left.path && right.path) assertEqual(path.resolve(left.path), path.resolve(right.path), `${label}[${index}].path`);
  }
}

function compareLedgerReferences(ledger, expected, imageId) {
  assertStringArrayEqual(ledger.reference_ids ?? [], expected.map((reference) => reference.ref_id), `${imageId} ledger reference_ids`);
  const actual = ledger.references ?? [];
  assertEqual(actual.length, expected.length, `${imageId} ledger references length`);
  for (let index = 0; index < expected.length; index += 1) {
    assertEqual(assertSha256(actual[index]?.sha256, `${imageId} ledger reference ${index + 1}`), expected[index].sha256, `${imageId} ledger reference ${index + 1} hash`);
    assertEqual(path.resolve(actual[index]?.path ?? ""), expected[index].path, `${imageId} ledger reference ${index + 1} path`);
  }
}

async function discoverProofEvidence(proofRoot, excludedOutputDir) {
  const files = await walkFiles(proofRoot, excludedOutputDir);
  const manifestPaths = files.filter((filePath) => path.basename(filePath) === "work_manifest.json");
  const receiptPaths = files.filter((filePath) => path.basename(filePath) === "google_flow_receipt.json");
  const deadletterPaths = files.filter((filePath) => path.basename(path.dirname(filePath)) === "deadletters" && filePath.endsWith(".json"));
  const failurePaths = files.filter((filePath) => path.basename(filePath) === "failure.json");
  const manifests = [];
  for (const manifestPath of manifestPaths) {
    const document = await readJson(manifestPath, "Google Flow work manifest");
    if (document.schema !== "goldflow_codex_image_work_manifest_v1") continue;
    assert(Array.isArray(document.items), `Work manifest is missing items[]: ${manifestPath}.`);
    const manifestId = String(document.manifest_id ?? "");
    assert(manifestId, `Work manifest has no manifest_id: ${manifestPath}.`);
    manifests.push({
      path: manifestPath,
      sha256: await sha256File(manifestPath),
      document,
      manifestId,
      itemIds: document.items.map((item) => String(item.asset_id ?? "")),
    });
  }
  const receipts = [];
  for (const receiptPath of receiptPaths) {
    const document = await readJson(receiptPath, "Google Flow receipt");
    if (document.schema !== "goldflow_google_flow_image_receipt_v1") continue;
    receipts.push({
      path: receiptPath,
      sha256: await sha256File(receiptPath),
      document,
      manifestId: String(document.manifest_id ?? ""),
      imageId: String(document.asset_id ?? ""),
    });
  }
  const deadletters = [];
  for (const deadletterPath of deadletterPaths) {
    const document = await readJson(deadletterPath, "Google Flow deadletter");
    if (document.schema !== "goldflow_codex_image_deadletter_v1") continue;
    deadletters.push({
      path: deadletterPath,
      sha256: await sha256File(deadletterPath),
      document,
      manifestId: String(document.manifest_id ?? ""),
      imageId: String(document.asset_id ?? ""),
    });
  }
  const failures = [];
  for (const failurePath of failurePaths) {
    const document = await readJson(failurePath, "Google Flow attempt failure");
    if (document.schema !== "goldflow_codex_image_attempt_failure_v1") continue;
    failures.push({
      path: failurePath,
      sha256: await sha256File(failurePath),
      document,
      manifestId: String(document.manifest_id ?? ""),
      imageId: String(document.asset_id ?? ""),
    });
  }
  assert(manifests.length > 0, `No Google Flow work manifests were found under ${proofRoot}.`);
  return { manifests, receipts, deadletters, failures };
}

async function loadReferenceEchoAudit({ proofDir: proofRoot, proofEvidence, canonicalRows, flowCandidate }) {
  const requestedPath = path.join(proofRoot, "reference-echo-audit.json");
  if (!await pathExists(requestedPath)) {
    return {
      present: false,
      path: null,
      sha256: null,
      schema: null,
      status: null,
      threshold_normalized_pixel_mae: null,
      rows: [],
      byReceiptPath: new Map(),
    };
  }
  const auditPath = await existingFileInside(requestedPath, proofRoot, "reference echo audit");
  const document = await readJson(auditPath, "reference echo audit");
  assertEqual(document.schema, "goldflow_google_flow_reference_echo_audit_v1", "reference echo audit schema");
  assert(["passed", "failed"].includes(String(document.status ?? "")), "Reference echo audit must have terminal passed or failed status.");
  assertEqual(document.production_artifacts_mutated, false, "reference echo audit production_artifacts_mutated");
  const threshold = Number(document.threshold_normalized_pixel_mae);
  assert(Number.isFinite(threshold) && threshold > 0, "Reference echo audit must bind a positive normalized-pixel-MAE threshold.");
  assert(Array.isArray(document.rows), "Reference echo audit must contain rows[].");

  const selectedReceipts = proofEvidence.receipts.filter((receipt) => canonicalRows.has(receipt.imageId));
  assertEqual(Number(document.receipt_count), selectedReceipts.length, "reference echo audit receipt_count");
  assertEqual(document.rows.length, selectedReceipts.length, "reference echo audit row count");
  const receiptByPath = new Map(selectedReceipts.map((receipt) => [receipt.path, receipt]));
  const byReceiptPath = new Map();
  let echoCount = 0;
  for (const row of document.rows) {
    const imageId = String(row?.asset_id ?? "");
    const canonical = canonicalRows.get(imageId);
    assert(canonical, `Reference echo audit contains out-of-selection asset ${imageId}.`);
    const receiptPath = await existingFileInside(path.resolve(row.receipt_path ?? ""), proofRoot, `${imageId} reference echo receipt`);
    assert(!byReceiptPath.has(receiptPath), `Reference echo audit repeats receipt ${receiptPath}.`);
    const receipt = receiptByPath.get(receiptPath);
    assert(receipt, `Reference echo audit receipt is not part of selected proof evidence: ${receiptPath}.`);
    assertEqual(receipt.imageId, imageId, `${imageId} reference echo receipt asset_id`);
    validateFlowReceiptContract(receipt.document, receipt.manifestId, canonical, flowCandidate);
    const outputPath = await existingFileInside(path.resolve(row.output_path ?? ""), proofRoot, `${imageId} reference echo output`);
    assertEqual(outputPath, path.resolve(receipt.document.accepted_png_path ?? ""), `${imageId} reference echo output path`);
    const outputSha256 = await sha256File(outputPath);
    assertEqual(assertSha256(row.output_sha256, `${imageId} reference echo output`), outputSha256, `${imageId} reference echo output hash`);
    assertEqual(assertSha256(receipt.document.accepted_png_sha256, `${imageId} Flow receipt output`), outputSha256, `${imageId} reference echo receipt output hash`);
    assertEqual(Number(row.reference_count), canonical.references.length, `${imageId} reference echo reference_count`);
    const comparisons = row.comparisons ?? [];
    assertEqual(comparisons.length, canonical.references.length, `${imageId} reference echo comparisons length`);
    for (let index = 0; index < canonical.references.length; index += 1) {
      const comparison = comparisons[index];
      const reference = canonical.references[index];
      assertEqual(Number(comparison?.slot), reference.slot, `${imageId} reference echo comparison ${index + 1} slot`);
      assertEqual(String(comparison?.ref_id ?? ""), reference.ref_id, `${imageId} reference echo comparison ${index + 1} ref_id`);
      assertEqual(path.resolve(comparison?.path ?? ""), reference.path, `${imageId} reference echo comparison ${index + 1} path`);
      assertEqual(assertSha256(comparison?.source_sha256, `${imageId} reference echo comparison ${index + 1}`), reference.sha256, `${imageId} reference echo comparison ${index + 1} source hash`);
      assert(Number.isFinite(Number(comparison?.normalized_pixel_mae)) && Number(comparison.normalized_pixel_mae) >= 0, `${imageId} reference echo comparison ${index + 1} has invalid normalized_pixel_mae.`);
    }
    const closest = row.closest_reference ?? null;
    if (canonical.references.length === 0) {
      assertEqual(closest, null, `${imageId} zero-reference closest_reference`);
      assertEqual(row.reference_echo, false, `${imageId} zero-reference echo decision`);
    } else {
      assert(closest && typeof closest === "object", `${imageId} reference echo audit is missing closest_reference.`);
      const matchingComparison = comparisons.find((comparison) => Number(comparison.slot) === Number(closest.slot));
      assert(matchingComparison, `${imageId} closest reference slot is not in comparisons.`);
      assertEqual(String(closest.ref_id ?? ""), String(matchingComparison.ref_id ?? ""), `${imageId} closest reference ref_id`);
      assertEqual(path.resolve(closest.path ?? ""), path.resolve(matchingComparison.path ?? ""), `${imageId} closest reference path`);
      assertEqual(assertSha256(closest.source_sha256, `${imageId} closest reference`), matchingComparison.source_sha256, `${imageId} closest reference hash`);
      assertEqual(Number(closest.normalized_pixel_mae), Number(matchingComparison.normalized_pixel_mae), `${imageId} closest reference MAE`);
      const minimumMae = Math.min(...comparisons.map((comparison) => Number(comparison.normalized_pixel_mae)));
      assertEqual(Number(closest.normalized_pixel_mae), minimumMae, `${imageId} minimum reference MAE`);
      assertEqual(row.reference_echo, minimumMae <= threshold, `${imageId} reference echo threshold decision`);
    }
    if (row.reference_echo === true) echoCount += 1;
    byReceiptPath.set(receiptPath, {
      asset_id: imageId,
      receipt_path: receiptPath,
      output_path: outputPath,
      output_sha256: outputSha256,
      reference_count: canonical.references.length,
      closest_reference: closest,
      reference_echo: row.reference_echo === true,
      comparisons,
    });
  }
  for (const receipt of selectedReceipts) {
    assert(byReceiptPath.has(receipt.path), `Reference echo audit is missing receipt ${receipt.path}.`);
  }
  assertEqual(Number(document.reference_echo_count), echoCount, "reference echo audit reference_echo_count");
  assertEqual(document.status, echoCount > 0 ? "failed" : "passed", "reference echo audit status");
  return {
    present: true,
    path: auditPath,
    sha256: await sha256File(auditPath),
    schema: document.schema,
    status: document.status,
    threshold_normalized_pixel_mae: threshold,
    rows: [...byReceiptPath.values()],
    byReceiptPath,
  };
}

async function walkFiles(root, excludedDirectory) {
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (path.resolve(candidate) === path.resolve(excludedDirectory)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  };
  await visit(root);
  return files;
}

function normalizeExecutionEvidence(executionInputs, waves, lockedSelectionPath, lockedSelectionSha256) {
  const selectedById = new Map(waves.flatMap((wave) => wave.rows.map((row) => [row.imageId, row])));
  const rows = [];
  const waveSummaries = [];
  for (const input of executionInputs) {
    if (input.document.selection_path != null) assertEqual(path.resolve(input.document.selection_path), lockedSelectionPath, `${input.kind} selection path`);
    if (input.document.selection_sha256 != null) assertEqual(assertSha256(input.document.selection_sha256, `${input.kind} selection`), lockedSelectionSha256, `${input.kind} selection hash`);
    if ("production_artifacts_mutated" in input.document) assertEqual(input.document.production_artifacts_mutated, false, `${input.kind} production_artifacts_mutated`);
    assert(!["running", "in_progress"].includes(String(input.document.status ?? "").toLowerCase()), `${input.kind} artifact is not terminal; wait for the proof to stop before building comparisons.`);
    for (const wave of input.document?.waves ?? []) {
      const targetConcurrency = Number(wave.target_concurrency ?? wave.concurrency);
      assert(Number.isInteger(targetConcurrency), `${input.kind} artifact contains a wave without integer concurrency.`);
      const selectedWave = waves.find((candidate) => candidate.targetConcurrency === targetConcurrency);
      assert(selectedWave, `${input.kind} artifact contains out-of-selection concurrency ${targetConcurrency}.`);
      const imageIds = (wave.image_ids ?? wave.rows?.map((row) => row.image_id ?? row.asset_id) ?? []).map(String);
      if (imageIds.length) assert(sameMembers(imageIds, selectedWave.imageIds), `${input.kind} concurrency ${targetConcurrency} image scope does not match selection.`);
      waveSummaries.push({
        sourceKind: input.kind,
        sourcePath: input.path,
        targetConcurrency,
        status: String(wave.status ?? "").toLowerCase(),
        imageIds: imageIds.length ? imageIds : selectedWave.imageIds,
        manifestId: wave.manifest_id ? String(wave.manifest_id) : null,
        manifestPath: wave.manifest_path ? path.resolve(wave.manifest_path) : null,
        finalManifestStatus: wave.final_manifest_status ?? null,
        finalCounts: wave.final_counts ?? wave.summary ?? null,
        firstFailure: wave.first_failure ?? null,
        startedAt: wave.started_at ?? null,
        completedAt: wave.completed_at ?? wave.ended_at ?? null,
        durationSec: wave.duration_sec ?? null,
        peakInFlight: wave.max_observed_active_jobs ?? wave.peak_in_flight ?? null,
        stopReason: wave.stop_reason ?? null,
      });
    }
    for (const candidate of executionRows(input.document)) {
      const imageId = String(candidate.row?.image_id ?? candidate.row?.asset_id ?? "").trim();
      if (!imageId) continue;
      assert(selectedById.has(imageId), `${input.kind} artifact contains out-of-selection image ${imageId}.`);
      const selected = selectedById.get(imageId);
      const targetConcurrency = Number(candidate.targetConcurrency ?? candidate.row?.target_concurrency ?? candidate.row?.concurrency ?? selected.targetConcurrency);
      assertEqual(targetConcurrency, selected.targetConcurrency, `${imageId} execution target concurrency`);
      rows.push({
        sourceKind: input.kind,
        sourcePath: input.path,
        imageId,
        targetConcurrency,
        status: String(candidate.row?.status ?? "").toLowerCase(),
        outputPath: candidate.row?.output_path ? path.resolve(candidate.row.output_path) : null,
        outputSha256: candidate.row?.output_sha256 ? assertSha256(candidate.row.output_sha256, `${imageId} execution output`) : null,
        receiptPath: candidate.row?.receipt_path ? path.resolve(candidate.row.receipt_path) : null,
        errorClass: candidate.row?.error_class ?? null,
        error: candidate.row?.error ?? null,
      });
    }
  }
  const byImageId = new Map();
  for (const row of rows) {
    const list = byImageId.get(row.imageId) ?? [];
    list.push(row);
    byImageId.set(row.imageId, list);
  }
  for (const [imageId, list] of byImageId) {
    const successful = list.filter(isSuccessfulExecutionRow);
    if (successful.length <= 1) continue;
    const signatures = new Set(successful.map((row) => JSON.stringify([row.outputPath, row.outputSha256, row.receiptPath])));
      assert(signatures.size === 1, `Execution inputs disagree about the successful Google Flow evidence for ${imageId}.`);
  }
  const byWave = new Map();
  for (const summary of waveSummaries) {
    const list = byWave.get(summary.targetConcurrency) ?? [];
    list.push(summary);
    byWave.set(summary.targetConcurrency, list);
  }
  for (const [targetConcurrency, list] of byWave) {
    const signatures = new Set(list.map((summary) => JSON.stringify([
      summary.status,
      summary.manifestId,
      summary.manifestPath,
      summary.finalManifestStatus,
      summary.finalCounts,
      summary.firstFailure,
    ])));
    assert(signatures.size === 1, `Execution inputs disagree about concurrency ${targetConcurrency}.`);
  }
  let stoppedAtFailure = null;
  for (const selectedWave of waves) {
    const summary = byWave.get(selectedWave.targetConcurrency)?.[0] ?? null;
    if (!summary) continue;
    assert(stoppedAtFailure == null, `Execution continued to concurrency ${selectedWave.targetConcurrency} after failure at concurrency ${stoppedAtFailure}.`);
    const deadlettered = Number(summary.finalCounts?.deadlettered ?? summary.finalCounts?.failed ?? 0);
    if (["failed", "stopped_on_failure"].includes(summary.status) || deadlettered > 0 || summary.firstFailure) {
      stoppedAtFailure = selectedWave.targetConcurrency;
    }
  }
  return {
    supplied: executionInputs.length > 0,
    rows,
    byImageId,
    waveSummaries,
    byWave: new Map([...byWave].map(([target, list]) => [target, list[0]])),
  };
}

function executionRows(document) {
  const found = [];
  const addRows = (rows, targetConcurrency = null) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) found.push({ row, targetConcurrency });
  };
  if (Array.isArray(document?.waves)) {
    for (const wave of document.waves) {
      const target = wave.target_concurrency ?? wave.concurrency ?? null;
      addRows(wave.rows, target);
      addRows(wave.results, target);
      addRows(wave.successful_jobs, target);
      addRows(wave.failed_jobs, target);
    }
  }
  addRows(document?.rows, document?.target_concurrency ?? document?.concurrency ?? null);
  addRows(document?.results, document?.target_concurrency ?? document?.concurrency ?? null);
  addRows(document?.successful_jobs, document?.target_concurrency ?? document?.concurrency ?? null);
  addRows(document?.failed_jobs, document?.target_concurrency ?? document?.concurrency ?? null);
  return found;
}

function isSuccessfulExecutionRow(row) {
  const status = String(row.status ?? "").toLowerCase();
  if (/^(?:success|succeeded|completed|generated|passed|downloaded)$/.test(status)) return true;
  return !status && Boolean(row.receiptPath || row.outputPath);
}

function sameMembers(left, right) {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

async function bindFlowEvidence({ waves, canonicalRows, proofEvidence, referenceEchoAudit, execution, flowCandidate, proofDir: proofRoot }) {
  const receiptByPath = new Map(proofEvidence.receipts.map((receipt) => [path.resolve(receipt.path), receipt]));
  const manifestById = new Map();
  for (const manifest of proofEvidence.manifests) {
    const rows = manifestById.get(manifest.manifestId) ?? [];
    rows.push(manifest);
    manifestById.set(manifest.manifestId, rows);
  }
  const successfulBindings = [];
  const failedRows = [];
  const waveEvidence = [];
  for (const wave of waves) {
    const summary = execution.byWave.get(wave.targetConcurrency) ?? null;
    const rowExecutionEvidence = wave.rows.flatMap((selected) => execution.byImageId.get(selected.imageId) ?? []);
    if (execution.supplied && !summary && rowExecutionEvidence.length === 0) continue;
    const explicitManifestIds = new Set();
    if (summary?.manifestId) explicitManifestIds.add(summary.manifestId);
    for (const row of rowExecutionEvidence) {
      if (!row.receiptPath) continue;
      const receiptPath = await existingFileInside(row.receiptPath, proofRoot, `${row.imageId} execution receipt`);
      const receipt = receiptByPath.get(receiptPath);
      assert(receipt, `${row.imageId} execution receipt is not a Google Flow receipt discovered under the proof directory.`);
      explicitManifestIds.add(receipt.manifestId);
    }
    assert(explicitManifestIds.size <= 1, `Concurrency ${wave.targetConcurrency} rows point to multiple work manifests.`);

    let manifestCandidates;
    if (summary?.manifestPath) {
      const manifestPath = await existingFileInside(summary.manifestPath, proofRoot, `concurrency ${wave.targetConcurrency} manifest`);
      manifestCandidates = proofEvidence.manifests.filter((manifest) => manifest.path === manifestPath);
      if (summary.manifestId) manifestCandidates = manifestCandidates.filter((manifest) => manifest.manifestId === summary.manifestId);
    } else if (explicitManifestIds.size === 1) {
      manifestCandidates = manifestById.get([...explicitManifestIds][0]) ?? [];
    } else {
      manifestCandidates = proofEvidence.manifests.filter((manifest) => sameMembers(manifest.itemIds, wave.imageIds));
    }
    manifestCandidates = manifestCandidates.filter((manifest) => sameMembers(manifest.itemIds, wave.imageIds));
    if (!execution.supplied && manifestCandidates.length === 0) continue;
    assertEqual(manifestCandidates.length, 1, `concurrency ${wave.targetConcurrency} exact-scope manifest candidate count`);
    const manifest = manifestCandidates[0];
    await validateWaveManifest({ wave, manifest, canonicalRows, proofRoot });

    const completedImageIds = [];
    const failedImageIds = [];
    for (const selected of wave.rows) {
      const item = manifest.document.items.find((candidate) => String(candidate.asset_id ?? "") === selected.imageId);
      const canonical = canonicalRows.get(selected.imageId);
      assert(item && canonical, `Manifest ${manifest.manifestId} is missing selected item ${selected.imageId}.`);
      const completionCandidate = path.join(path.dirname(manifest.path), "completions", `${selected.imageId}.json`);
      const completionExists = await pathExists(completionCandidate);
      const deadletters = proofEvidence.deadletters.filter((candidate) => candidate.manifestId === manifest.manifestId && candidate.imageId === selected.imageId);
      assert(!(completionExists && deadletters.length), `${selected.imageId} has both completion and deadletter evidence.`);
      assert(deadletters.length <= 1, `${selected.imageId} has multiple deadletter artifacts.`);
      if (completionExists) {
        const receiptCandidates = proofEvidence.receipts.filter((candidate) => candidate.manifestId === manifest.manifestId && candidate.imageId === selected.imageId);
        assertEqual(receiptCandidates.length, 1, `${selected.imageId} successful Google Flow receipt count`);
        const executionRowsForImage = (execution.byImageId.get(selected.imageId) ?? []).filter(isSuccessfulExecutionRow);
        successfulBindings.push({
          imageId: selected.imageId,
          wave,
          manifest,
          item,
          receipt: receiptCandidates[0],
          completionPath: await existingFileInside(completionCandidate, proofRoot, `${selected.imageId} completion`),
          executionRow: executionRowsForImage[0] ?? null,
        });
        completedImageIds.push(selected.imageId);
        continue;
      }
      if (deadletters.length === 1) {
        failedRows.push(await validateDeadletterEvidence({
          wave,
          manifest,
          item,
          canonical,
          deadletter: deadletters[0],
          proofEvidence,
          flowCandidate,
          proofRoot,
        }));
        failedImageIds.push(selected.imageId);
        continue;
      }
      throw new Error(`Attempted concurrency ${wave.targetConcurrency} item ${selected.imageId} has neither completion nor deadletter evidence.`);
    }

    if (summary?.finalCounts) {
      if (summary.finalCounts.completed != null) assertEqual(Number(summary.finalCounts.completed), completedImageIds.length, `concurrency ${wave.targetConcurrency} completed count`);
      if (summary.finalCounts.deadlettered != null) assertEqual(Number(summary.finalCounts.deadlettered), failedImageIds.length, `concurrency ${wave.targetConcurrency} deadletter count`);
      if (summary.finalCounts.pending != null) assertEqual(Number(summary.finalCounts.pending), 0, `concurrency ${wave.targetConcurrency} pending count`);
      if (summary.finalCounts.leased != null) assertEqual(Number(summary.finalCounts.leased), 0, `concurrency ${wave.targetConcurrency} leased count`);
    }
    if (summary?.status === "passed") {
      assertEqual(completedImageIds.length, wave.targetConcurrency, `passed concurrency ${wave.targetConcurrency} completion count`);
      assertEqual(failedImageIds.length, 0, `passed concurrency ${wave.targetConcurrency} failure count`);
    }
    if (["failed", "stopped_on_failure"].includes(summary?.status)) {
      assert(failedImageIds.length > 0, `Failed concurrency ${wave.targetConcurrency} has no deadletter evidence.`);
    }
    waveEvidence.push({
      target_concurrency: wave.targetConcurrency,
      status: summary?.status ?? (failedImageIds.length ? "failed" : "passed"),
      manifest_id: manifest.manifestId,
      manifest_path: manifest.path,
      manifest_sha256: manifest.sha256,
      final_manifest_status: summary?.finalManifestStatus ?? null,
      final_counts: summary?.finalCounts ?? {
        completed: completedImageIds.length,
        deadlettered: failedImageIds.length,
      },
      peak_in_flight: summary?.peakInFlight ?? null,
      started_at: summary?.startedAt ?? null,
      completed_at: summary?.completedAt ?? null,
      duration_sec: summary?.durationSec ?? null,
      stop_reason: summary?.stopReason ?? null,
      first_failure: summary?.firstFailure ?? null,
      completed_image_ids: completedImageIds,
      failed_image_ids: failedImageIds,
    });
  }

  const successfulHashesByImageId = new Map(successfulBindings.map((binding) => [
    binding.imageId,
    String(binding.receipt.document.accepted_png_sha256 ?? ""),
  ]));
  for (const failed of failedRows) {
    if (!failed.duplicate_owner_image_id) continue;
    const ownerHash = successfulHashesByImageId.get(failed.duplicate_owner_image_id);
    assert(ownerHash, `${failed.image_id} duplicate owner ${failed.duplicate_owner_image_id} is not a successful output in the attempted proof scope.`);
    assertEqual(failed.generated_output_sha256, ownerHash, `${failed.image_id} duplicate owner output hash`);
  }
  const invalidAttributionBindings = [];
  const qualityEligibleBindings = [];
  for (const binding of successfulBindings) {
    const auditRow = referenceEchoAudit.present ? referenceEchoAudit.byReceiptPath.get(binding.receipt.path) : null;
    if (referenceEchoAudit.present) assert(auditRow, `Reference echo audit is missing completed receipt ${binding.receipt.path}.`);
    if (auditRow?.reference_echo === true) invalidAttributionBindings.push({ binding, auditRow });
    else qualityEligibleBindings.push(binding);
  }
  for (const failed of failedRows) {
    const auditRow = referenceEchoAudit.present && failed.flow_receipt_path
      ? referenceEchoAudit.byReceiptPath.get(failed.flow_receipt_path)
      : null;
    if (referenceEchoAudit.present && failed.flow_receipt_path) assert(auditRow, `Reference echo audit is missing failed receipt ${failed.flow_receipt_path}.`);
    failed.reference_echo_audit = auditRow ?? null;
  }
  for (const wave of waveEvidence) {
    wave.invalid_attribution_image_ids = invalidAttributionBindings
      .filter((row) => row.binding.wave.targetConcurrency === wave.target_concurrency)
      .map((row) => row.binding.imageId);
    wave.quality_eligible_completed_image_ids = qualityEligibleBindings
      .filter((row) => row.wave.targetConcurrency === wave.target_concurrency)
      .map((row) => row.imageId);
  }
  return {
    successfulBindings: qualityEligibleBindings,
    completedBindings: successfulBindings,
    invalidAttributionBindings,
    invalidAttributionRows: [],
    failedRows,
    waveEvidence,
  };
}

async function validateDeadletterEvidence({ wave, manifest, item, canonical, deadletter, proofEvidence, flowCandidate, proofRoot }) {
  const document = deadletter.document;
  assertEqual(document.schema, "goldflow_codex_image_deadletter_v1", `${canonical.imageId} deadletter schema`);
  assertEqual(document.status, "deadlettered", `${canonical.imageId} deadletter status`);
  assertEqual(document.manifest_id, manifest.manifestId, `${canonical.imageId} deadletter manifest_id`);
  assertEqual(document.asset_id, canonical.imageId, `${canonical.imageId} deadletter asset_id`);
  assertEqual(Number(document.attempt_count), 1, `${canonical.imageId} deadletter attempt_count`);
  assertEqual(Number(document.max_attempts), 1, `${canonical.imageId} deadletter max_attempts`);

  const failures = proofEvidence.failures.filter((candidate) => candidate.manifestId === manifest.manifestId && candidate.imageId === canonical.imageId);
  assert(failures.length <= 1, `${canonical.imageId} has multiple attempt failure artifacts.`);
  const failure = failures[0] ?? null;
  if (failure) {
    assertEqual(failure.document.status, "failed", `${canonical.imageId} attempt failure status`);
    assertEqual(Number(failure.document.attempt_number), 1, `${canonical.imageId} attempt failure number`);
  }

  const receipts = proofEvidence.receipts.filter((candidate) => candidate.manifestId === manifest.manifestId && candidate.imageId === canonical.imageId);
  assert(receipts.length <= 1, `${canonical.imageId} has multiple failed-attempt Flow receipts.`);
  const receipt = receipts[0] ?? null;
  let generatedOutputPath = null;
  let generatedOutputSha256 = null;
  let generatedOutputImage = null;
  if (receipt) {
    validateFlowReceiptContract(receipt.document, manifest.manifestId, canonical, flowCandidate);
    generatedOutputPath = await existingFileInside(
      path.resolve(receipt.document.accepted_png_path ?? ""),
      proofRoot,
      `${canonical.imageId} failed-attempt generated PNG`,
    );
    generatedOutputSha256 = await sha256File(generatedOutputPath);
    assertEqual(assertSha256(receipt.document.accepted_png_sha256, `${canonical.imageId} failed receipt output`), generatedOutputSha256, `${canonical.imageId} failed receipt output hash`);
    generatedOutputImage = await inspectPng(generatedOutputPath, `${canonical.imageId} failed-attempt generated PNG`, {
      aspectRatio: Number(item.expected_output?.aspect_ratio ?? DEFAULT_ASPECT_RATIO),
      aspectTolerance: Number(item.expected_output?.aspect_tolerance ?? DEFAULT_ASPECT_TOLERANCE),
    });
  }
  const detail = String(document.details ?? failure?.document.error ?? "");
  const duplicateMatch = detail.match(/Duplicate output SHA-256 for\s+[^;]+;\s+already accepted for\s+([A-Za-z0-9_-]+)/i);
  if (duplicateMatch) {
    assert(receipt && generatedOutputSha256, `${canonical.imageId} duplicate-output deadletter is missing its hash-bound Flow receipt.`);
  }
  return {
    target_concurrency: wave.targetConcurrency,
    image_id: canonical.imageId,
    status: "deadlettered",
    reason: document.reason ?? null,
    details: document.details ?? null,
    error_class: duplicateMatch ? "duplicate_output_sha256" : failure?.document.error?.split(":", 1)[0] ?? document.reason ?? "generation_failure",
    duplicate_owner_image_id: duplicateMatch?.[1] ?? null,
    deadletter_path: deadletter.path,
    deadletter_sha256: deadletter.sha256,
    attempt_failure_path: failure?.path ?? null,
    attempt_failure_sha256: failure?.sha256 ?? null,
    flow_receipt_path: receipt?.path ?? null,
    flow_receipt_sha256: receipt?.sha256 ?? null,
    generated_output_path: generatedOutputPath,
    generated_output_sha256: generatedOutputSha256,
    generated_output_image: generatedOutputImage,
    canonical_prompt_sha256: canonical.canonicalPromptSha256,
    ordered_references: canonical.references.map(referenceReceiptRow),
    quality_pair_created: false,
  };
}

function validateFlowReceiptContract(document, manifestId, canonical, expectedContract = {}) {
  assertEqual(document.schema, "goldflow_google_flow_image_receipt_v1", `${canonical.imageId} Flow receipt schema`);
  assertEqual(document.browser_provider, "google-flow", `${canonical.imageId} Flow receipt provider`);
  assertEqual(document.status, "downloaded", `${canonical.imageId} Flow receipt status`);
  assertEqual(document.manifest_id, manifestId, `${canonical.imageId} Flow receipt manifest_id`);
  assertEqual(document.asset_id, canonical.imageId, `${canonical.imageId} Flow receipt asset_id`);
  assertEqual(document.prompt_sha256, canonical.canonicalPromptSha256, `${canonical.imageId} Flow receipt prompt hash`);
  compareReferenceHashRows(document.ordered_reference_hashes ?? [], canonical.references, `${canonical.imageId} Flow receipt references`);
  const ui = document.ui_contract ?? {};
  assertEqual(ui.provider, "google-flow", `${canonical.imageId} Flow UI provider`);
  assertEqual(ui.aspect_ratio, "16:9", `${canonical.imageId} Flow UI aspect ratio`);
  assertEqual(Number(ui.output_count), 1, `${canonical.imageId} Flow UI output count`);
  if (expectedContract.provider != null) assertEqual(ui.provider, expectedContract.provider, `${canonical.imageId} selected Flow provider`);
  if (expectedContract.model != null) assertEqual(ui.model_label, expectedContract.model, `${canonical.imageId} selected Flow model`);
  if (expectedContract.account_plan != null) assertEqual(ui.account_plan, expectedContract.account_plan, `${canonical.imageId} selected Flow account plan`);
  if (expectedContract.aspect_ratio != null) assertEqual(ui.aspect_ratio, expectedContract.aspect_ratio, `${canonical.imageId} selected Flow aspect ratio`);
  if (expectedContract.output_count != null) assertEqual(Number(ui.output_count), Number(expectedContract.output_count), `${canonical.imageId} selected Flow output count`);
}

async function pathExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function validateWaveManifest({ wave, manifest, canonicalRows, proofRoot }) {
  const document = manifest.document;
  assertEqual(document.item_count, wave.imageIds.length, `manifest ${manifest.manifestId} item_count`);
  assert(sameMembers(document.items.map((item) => String(item.asset_id ?? "")), wave.imageIds), `Manifest ${manifest.manifestId} does not exactly match concurrency ${wave.targetConcurrency} scope.`);
  assertEqual(Number(document.policy?.max_attempts), 1, `manifest ${manifest.manifestId} max_attempts`);
  assertEqual(Number(document.policy?.max_concurrency), wave.targetConcurrency, `manifest ${manifest.manifestId} max_concurrency`);
  assertEqual(document.policy?.output_format, "png", `manifest ${manifest.manifestId} output format`);
  assertEqual(document.policy?.orientation, "landscape", `manifest ${manifest.manifestId} orientation`);
  const promptPlanSource = document.sources?.prompt_plan;
  assert(promptPlanSource?.path, `Manifest ${manifest.manifestId} is missing sources.prompt_plan.path.`);
  const slicePath = await existingFileInside(path.resolve(promptPlanSource.path), proofRoot, `manifest ${manifest.manifestId} prompt slice`);
  const sliceSha256 = await sha256File(slicePath);
  assertEqual(sliceSha256, assertSha256(promptPlanSource.sha256, `manifest ${manifest.manifestId} prompt slice`), `manifest ${manifest.manifestId} prompt slice hash`);
  const slice = await readJson(slicePath, `manifest ${manifest.manifestId} prompt slice`);
  assert(Array.isArray(slice.prompts), `Manifest ${manifest.manifestId} prompt slice must contain prompts[].`);
  assert(sameMembers(slice.prompts.map((row) => String(row.image_id ?? "")), wave.imageIds), `Manifest ${manifest.manifestId} prompt slice does not exactly match its wave.`);
  const sliceIndex = uniqueIndex(slice.prompts, "image_id", `manifest ${manifest.manifestId} prompt slice`);
  for (const item of document.items) {
    const imageId = String(item.asset_id ?? "");
    const canonical = canonicalRows.get(imageId);
    const sliceRow = sliceIndex.get(imageId);
    assert(canonical && sliceRow, `Manifest ${manifest.manifestId} has an out-of-selection item ${imageId}.`);
    assertEqual(item.prompt, canonical.canonicalPrompt, `${imageId} manifest prompt text`);
    assertEqual(item.prompt_sha256, canonical.canonicalPromptSha256, `${imageId} manifest prompt hash`);
    assertEqual(item.source_plan_path, slicePath, `${imageId} manifest source plan path`);
    assertEqual(item.source_plan_sha256, sliceSha256, `${imageId} manifest source plan hash`);
    const slicePrompt = sliceRow[canonical.canonicalPromptField] ?? sliceRow.provider_prompt ?? sliceRow.image_prompt ?? sliceRow.codex_image_prompt;
    assertEqual(slicePrompt, canonical.canonicalPrompt, `${imageId} prompt slice text`);
    assertEqual(sliceRow.prompt_hash, canonical.canonicalPromptSha256, `${imageId} prompt slice hash`);
    compareFlowReferenceArray(item.ordered_references ?? [], canonical.references, `${imageId} manifest references`);
    comparePromptSliceReferences(sliceRow.reference_slots ?? [], canonical.references, `${imageId} prompt slice references`);
  }
}

function compareFlowReferenceArray(actual, expected, label) {
  assertEqual(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < expected.length; index += 1) {
    assertEqual(Number(actual[index]?.slot), expected[index].slot, `${label}[${index}].slot`);
    assertEqual(String(actual[index]?.ref_id ?? ""), expected[index].ref_id, `${label}[${index}].ref_id`);
    assertEqual(assertSha256(actual[index]?.sha256, `${label}[${index}]`), expected[index].sha256, `${label}[${index}].sha256`);
    assertEqual(path.resolve(actual[index]?.path ?? ""), expected[index].path, `${label}[${index}].path`);
  }
}

function comparePromptSliceReferences(actual, expected, label) {
  assertEqual(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < expected.length; index += 1) {
    assertEqual(Number(actual[index]?.slot ?? actual[index]?.slot_order), expected[index].slot, `${label}[${index}].slot`);
    assertEqual(String(actual[index]?.ref_id ?? ""), expected[index].ref_id, `${label}[${index}].ref_id`);
    assertEqual(path.resolve(actual[index]?.path ?? actual[index]?.reference_image_path ?? ""), expected[index].path, `${label}[${index}].path`);
  }
}

function resolveTemplate(template, imageId, episodeDir, label) {
  assert(typeof template === "string" && template, `${label} template is required.`);
  const expanded = template.replaceAll("{image_id}", imageId);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(episodeDir, expanded));
}

async function validateGptBaseline({ selection, canonical, sourceArtifacts }) {
  const resultIndex = uniqueIndex(sourceArtifacts.imagegenReport.document.results, "image_id", "locked image generation report");
  const decisionIndex = uniqueIndex(sourceArtifacts.reviewDecisions.document.decisions, "image_id", "locked image review decisions");
  const result = resultIndex.get(canonical.imageId);
  const decision = decisionIndex.get(canonical.imageId);
  const ledger = canonical.ledgerRow;
  assert(result, `Locked GPT image generation report is missing ${canonical.imageId}.`);
  assert(decision, `Locked GPT image review decisions are missing ${canonical.imageId}.`);

  const rowBaseline = canonical.raw.gpt_baseline ?? {};
  const baselineConfig = { ...(selection.gpt_baseline ?? {}), ...rowBaseline };
  const episodeDir = resolveReadPath(
    selection.source_episode_dir ?? selection.episode_dir,
    path.dirname(selectionPath),
    "selection source episode",
  );
  const imagePath = baselineConfig.path
    ? resolveReadPath(baselineConfig.path, episodeDir, `${canonical.imageId} GPT baseline`)
    : resolveTemplate(baselineConfig.image_path_template, canonical.imageId, episodeDir, `${canonical.imageId} GPT baseline`);
  const metadataPath = baselineConfig.metadata_path
    ? resolveReadPath(baselineConfig.metadata_path, episodeDir, `${canonical.imageId} GPT metadata`)
    : baselineConfig.metadata_path_template
      ? resolveTemplate(baselineConfig.metadata_path_template, canonical.imageId, episodeDir, `${canonical.imageId} GPT metadata`)
      : `${imagePath}.metadata.json`;
  const realImagePath = await realpath(imagePath).catch(() => null);
  const realMetadataPath = await realpath(metadataPath).catch(() => null);
  assert(realImagePath, `${canonical.imageId} accepted GPT baseline does not exist: ${imagePath}.`);
  assert(realMetadataPath, `${canonical.imageId} GPT metadata does not exist: ${metadataPath}.`);
  const imageSha256 = await sha256File(realImagePath);
  const metadataSha256 = await sha256File(realMetadataPath);
  if (baselineConfig.sha256 != null) assertEqual(assertSha256(baselineConfig.sha256, `${canonical.imageId} selected GPT baseline`), imageSha256, `${canonical.imageId} selected GPT baseline hash`);

  assertEqual(String(result.status), "generated", `${canonical.imageId} GPT generation status`);
  assertEqual(path.resolve(result.image_path ?? ""), realImagePath, `${canonical.imageId} GPT report image path`);
  assertEqual(path.resolve(ledger.image_path ?? ""), realImagePath, `${canonical.imageId} GPT ledger image path`);
  assertEqual(path.resolve(decision.image_path ?? ""), realImagePath, `${canonical.imageId} GPT decision image path`);
  assertEqual(assertSha256(ledger.image_sha256, `${canonical.imageId} GPT ledger image`), imageSha256, `${canonical.imageId} GPT ledger image hash`);
  assertEqual(assertSha256(decision.image_sha256, `${canonical.imageId} GPT decision image`), imageSha256, `${canonical.imageId} GPT decision image hash`);
  assertEqual(String(ledger.generation_status), "generated", `${canonical.imageId} GPT ledger generation status`);
  assert(/^passed/.test(String(ledger.image_qa_status ?? "")), `${canonical.imageId} GPT ledger image_qa_status is not passed.`);
  assertEqual(String(decision.decision), "accepted", `${canonical.imageId} GPT review decision`);
  if (baselineConfig.qa_status != null) assertEqual(String(baselineConfig.qa_status), String(ledger.image_qa_status), `${canonical.imageId} selected GPT QA status`);
  if (baselineConfig.review_decision != null) assertEqual(String(baselineConfig.review_decision), String(decision.decision), `${canonical.imageId} selected GPT review decision`);

  const metadata = await readJson(realMetadataPath, `${canonical.imageId} GPT metadata`);
  assertEqual(String(metadata.image_id), canonical.imageId, `${canonical.imageId} GPT metadata image_id`);
  assertEqual(path.resolve(metadata.source_prompt_path ?? ""), sourceArtifacts.promptPlan.path, `${canonical.imageId} GPT metadata source prompt path`);
  for (const field of ["source_image_prompt", "source_modelslab_image_prompt"]) {
    if (metadata[field] != null) assertEqual(metadata[field], canonical.canonicalPrompt, `${canonical.imageId} GPT metadata ${field}`);
  }
  const sourcePrompt = metadata.source_image_prompt ?? metadata.source_modelslab_image_prompt ?? metadata.source_provider_prompt;
  assertEqual(sourcePrompt, canonical.canonicalPrompt, `${canonical.imageId} GPT canonical source prompt`);
  compareMetadataReferences(metadata, canonical.references, canonical.imageId);

  const submittedPrompt = metadata.image_prompt;
  assert(typeof submittedPrompt === "string" && submittedPrompt, `${canonical.imageId} GPT metadata is missing image_prompt.`);
  assert(typeof metadata.modelslab_prompt === "string" && metadata.modelslab_prompt, `${canonical.imageId} GPT metadata is missing modelslab_prompt.`);
  assert(typeof metadata.generated?.modelslab_submitted_prompt === "string" && metadata.generated.modelslab_submitted_prompt, `${canonical.imageId} GPT metadata is missing generated.modelslab_submitted_prompt.`);
  assertEqual(metadata.modelslab_prompt, submittedPrompt, `${canonical.imageId} GPT modelslab_prompt`);
  assertEqual(metadata.generated.modelslab_submitted_prompt, submittedPrompt, `${canonical.imageId} GPT transport prompt`);
  assert(submittedPrompt.includes(canonical.canonicalPrompt), `${canonical.imageId} GPT submitted prompt does not contain the exact canonical provider prompt.`);
  const submittedPromptTextSha256 = sha256Text(submittedPrompt);
  const submittedPromptContractSha256 = assertSha256(metadata.prompt_hash, `${canonical.imageId} GPT metadata prompt contract`);
  assertEqual(assertSha256(result.prompt_hash, `${canonical.imageId} GPT report prompt contract`), submittedPromptContractSha256, `${canonical.imageId} GPT report prompt contract hash`);
  assertEqual(assertSha256(ledger.submitted_prompt_hash, `${canonical.imageId} GPT ledger prompt contract`), submittedPromptContractSha256, `${canonical.imageId} GPT ledger submitted prompt contract hash`);

  const referenceCount = canonical.references.length;
  const expectedModel = referenceCount > 0
    ? firstValue(baselineConfig.generated_model_id, baselineConfig.referenced_model)
    : firstValue(baselineConfig.generated_model_id, baselineConfig.declared_model);
  const expectedEndpoint = referenceCount > 0
    ? firstValue(baselineConfig.endpoint, baselineConfig.referenced_endpoint)
    : firstValue(baselineConfig.endpoint, baselineConfig.zero_reference_endpoint);
  const actualModel = metadata.generated?.modelslab_model_id ?? ledger.image_model;
  const actualEndpoint = metadata.generated?.modelslab_endpoint ?? result.generated?.modelslab_endpoint;
  if (expectedModel != null) assertEqual(String(actualModel), String(expectedModel), `${canonical.imageId} GPT generated model`);
  if (expectedEndpoint != null) assertEqual(String(actualEndpoint), String(expectedEndpoint), `${canonical.imageId} GPT endpoint`);
  assertEqual(Number(metadata.generated?.modelslab_reference_count ?? referenceCount), referenceCount, `${canonical.imageId} GPT reference count`);
  if (baselineConfig.provider != null) assertEqual(String(metadata.image_provider ?? metadata.image_provider_route), String(baselineConfig.provider), `${canonical.imageId} GPT provider`);

  const image = await inspectPng(realImagePath, `${canonical.imageId} GPT baseline`, {
    aspectRatio: DEFAULT_ASPECT_RATIO,
    aspectTolerance: DEFAULT_ASPECT_TOLERANCE,
  });
  return {
    provider: "gpt-image-2-via-modelslab",
    image_path: realImagePath,
    image_sha256: imageSha256,
    metadata_path: realMetadataPath,
    metadata_sha256: metadataSha256,
    canonical_prompt_sha256: canonical.canonicalPromptSha256,
    submitted_prompt_contract_sha256: submittedPromptContractSha256,
    submitted_prompt_text_sha256: submittedPromptTextSha256,
    ordered_references: canonical.references.map(referenceReceiptRow),
    declared_model: metadata.model ?? baselineConfig.declared_model ?? null,
    generated_model_id: actualModel ?? null,
    endpoint: actualEndpoint ?? null,
    qa_status: ledger.image_qa_status,
    review_decision: decision.decision,
    image,
  };
}

function compareMetadataReferences(metadata, expected, imageId) {
  const slots = metadata.reference_slots ?? [];
  const inputs = metadata.reference_inputs ?? [];
  const paths = metadata.reference_image_paths ?? [];
  assertEqual(slots.length, expected.length, `${imageId} GPT metadata reference_slots length`);
  assertEqual(inputs.length, expected.length, `${imageId} GPT metadata reference_inputs length`);
  assertEqual(paths.length, expected.length, `${imageId} GPT metadata reference_image_paths length`);
  for (let index = 0; index < expected.length; index += 1) {
    assertEqual(Number(slots[index]?.slot ?? index + 1), expected[index].slot, `${imageId} GPT metadata reference slot ${index + 1}`);
    assertEqual(String(slots[index]?.ref_id ?? ""), expected[index].ref_id, `${imageId} GPT metadata reference ref_id ${index + 1}`);
    assertEqual(path.resolve(slots[index]?.path ?? ""), expected[index].path, `${imageId} GPT metadata reference slot path ${index + 1}`);
    assertEqual(path.resolve(inputs[index]?.path ?? ""), expected[index].path, `${imageId} GPT metadata reference input path ${index + 1}`);
    assertEqual(assertSha256(inputs[index]?.sha256, `${imageId} GPT metadata reference ${index + 1}`), expected[index].sha256, `${imageId} GPT metadata reference hash ${index + 1}`);
    assertEqual(path.resolve(paths[index] ?? ""), expected[index].path, `${imageId} GPT metadata reference path ${index + 1}`);
  }
}

async function validateFlowOutput({ binding, canonical, flowCandidate, proofDir: proofRoot }) {
  const { manifest, item, receipt, completionPath, executionRow } = binding;
  const completion = await readJson(completionPath, `${canonical.imageId} Google Flow completion`);
  assertEqual(completion.schema, "goldflow_codex_image_completion_v1", `${canonical.imageId} completion schema`);
  assertEqual(completion.manifest_id, manifest.manifestId, `${canonical.imageId} completion manifest_id`);
  assertEqual(completion.asset_id, canonical.imageId, `${canonical.imageId} completion asset_id`);
  assertEqual(completion.prompt_sha256, canonical.canonicalPromptSha256, `${canonical.imageId} completion prompt hash`);
  compareReferenceHashRows(completion.ordered_reference_hashes ?? [], canonical.references, `${canonical.imageId} completion references`);

  const receiptDocument = receipt.document;
  validateFlowReceiptContract(receiptDocument, manifest.manifestId, canonical, flowCandidate);

  const outputPath = await existingFileInside(
    path.resolve(receiptDocument.accepted_png_path ?? completion.source_path ?? ""),
    proofRoot,
    `${canonical.imageId} Flow accepted PNG`,
  );
  assertEqual(path.resolve(completion.source_path ?? ""), outputPath, `${canonical.imageId} completion source path`);
  const outputSha256 = await sha256File(outputPath);
  assertEqual(assertSha256(receiptDocument.accepted_png_sha256, `${canonical.imageId} Flow receipt output`), outputSha256, `${canonical.imageId} Flow receipt output hash`);
  assertEqual(assertSha256(completion.sha256, `${canonical.imageId} Flow completion output`), outputSha256, `${canonical.imageId} Flow completion output hash`);
  if (executionRow?.outputPath) assertEqual(path.resolve(executionRow.outputPath), outputPath, `${canonical.imageId} execution output path`);
  if (executionRow?.outputSha256) assertEqual(executionRow.outputSha256, outputSha256, `${canonical.imageId} execution output hash`);
  if (executionRow?.receiptPath) assertEqual(path.resolve(executionRow.receiptPath), receipt.path, `${canonical.imageId} execution receipt path`);

  const expectedOutput = item.expected_output ?? {};
  assertEqual(expectedOutput.format, "png", `${canonical.imageId} manifest expected format`);
  assertEqual(expectedOutput.orientation, "landscape", `${canonical.imageId} manifest expected orientation`);
  const image = await inspectPng(outputPath, `${canonical.imageId} Google Flow output`, {
    aspectRatio: Number(expectedOutput.aspect_ratio ?? DEFAULT_ASPECT_RATIO),
    aspectTolerance: Number(expectedOutput.aspect_tolerance ?? DEFAULT_ASPECT_TOLERANCE),
  });
  if (completion.image) {
    assertEqual(completion.image.format, "png", `${canonical.imageId} completion image format`);
    assertEqual(Number(completion.image.width), image.width, `${canonical.imageId} completion image width`);
    assertEqual(Number(completion.image.height), image.height, `${canonical.imageId} completion image height`);
  }
  const ui = receiptDocument.ui_contract ?? {};

  return {
    provider: "google-flow",
    model: ui.model_label ?? null,
    account_plan: ui.account_plan ?? null,
    image_path: outputPath,
    image_sha256: outputSha256,
    manifest_id: manifest.manifestId,
    manifest_path: manifest.path,
    manifest_sha256: manifest.sha256,
    completion_path: completionPath,
    completion_sha256: await sha256File(completionPath),
    receipt_path: receipt.path,
    receipt_sha256: receipt.sha256,
    canonical_prompt_sha256: canonical.canonicalPromptSha256,
    ordered_references: canonical.references.map(referenceReceiptRow),
    conversation_or_project_url: receiptDocument.conversation_url ?? null,
    image,
  };
}

function compareReferenceHashRows(actual, expected, label) {
  assertEqual(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < expected.length; index += 1) {
    assertEqual(String(actual[index]?.ref_id ?? ""), expected[index].ref_id, `${label}[${index}].ref_id`);
    assertEqual(assertSha256(actual[index]?.sha256, `${label}[${index}]`), expected[index].sha256, `${label}[${index}].sha256`);
  }
}

function referenceReceiptRow(reference) {
  return {
    slot: reference.slot,
    ref_id: reference.ref_id,
    path: reference.path,
    sha256: reference.sha256,
  };
}

async function inspectPng(filePath, label, { aspectRatio, aspectTolerance }) {
  let metadata;
  let statsResult;
  try {
    const image = sharp(filePath, { failOn: "error" });
    [metadata, statsResult] = await Promise.all([image.metadata(), sharp(filePath, { failOn: "error" }).stats()]);
  } catch (error) {
    throw new Error(`${label} is unreadable or corrupt: ${error.message}`);
  }
  assertEqual(metadata.format, "png", `${label} format`);
  const width = Number(metadata.width ?? 0);
  const height = Number(metadata.height ?? 0);
  assert(width >= 512 && height >= 288, `${label} is too small for the proof contract: ${width}x${height}.`);
  assert(width > height, `${label} is not landscape: ${width}x${height}.`);
  const actualAspectRatio = width / height;
  assert(Number.isFinite(aspectRatio) && aspectRatio > 0, `${label} expected aspect ratio is invalid.`);
  assert(Number.isFinite(aspectTolerance) && aspectTolerance >= 0, `${label} aspect tolerance is invalid.`);
  assert(Math.abs(actualAspectRatio - aspectRatio) <= aspectTolerance, `${label} has wrong geometry ${width}x${height}; expected aspect ${aspectRatio} ± ${aspectTolerance}.`);
  const fileSize = (await stat(filePath)).size;
  const colorChannels = (statsResult.channels ?? []).slice(0, 3);
  const maximumRange = Math.max(0, ...colorChannels.map((channel) => Number(channel.max ?? 0) - Number(channel.min ?? 0)));
  const maximumStdev = Math.max(0, ...colorChannels.map((channel) => Number(channel.stdev ?? 0)));
  const entropy = Number(statsResult.entropy ?? 0);
  assert(fileSize > 1024 && maximumRange >= 4 && maximumStdev >= 1 && entropy >= 0.02, `${label} appears blank or degenerate (bytes=${fileSize}, range=${maximumRange}, stdev=${maximumStdev}, entropy=${entropy}).`);
  return {
    format: metadata.format,
    width,
    height,
    aspect_ratio: Number(actualAspectRatio.toFixed(6)),
    file_size_bytes: fileSize,
    nonblank_metrics: {
      maximum_channel_range: Number(maximumRange.toFixed(4)),
      maximum_channel_stdev: Number(maximumStdev.toFixed(4)),
      entropy: Number(entropy.toFixed(6)),
    },
    structural_status: "passed",
  };
}

function validateUniqueOutputHashes(pairs) {
  const gptOwners = new Map();
  const flowOwners = new Map();
  const referenceOwners = new Map();
  for (const pair of pairs) {
    for (const reference of pair.canonical.references) {
      const owners = referenceOwners.get(reference.sha256) ?? [];
      owners.push({ image_id: pair.imageId, ref_id: reference.ref_id });
      referenceOwners.set(reference.sha256, owners);
    }
  }
  for (const pair of pairs) {
    const priorGpt = gptOwners.get(pair.gpt.image_sha256);
    assert(!priorGpt, `GPT baseline duplicate hash: ${pair.imageId} is byte-identical to ${priorGpt}.`);
    gptOwners.set(pair.gpt.image_sha256, pair.imageId);
    const priorFlow = flowOwners.get(pair.flow.image_sha256);
    assert(!priorFlow, `Google Flow duplicate hash: ${pair.imageId} is byte-identical to ${priorFlow}.`);
    flowOwners.set(pair.flow.image_sha256, pair.imageId);
    const gptReferenceOwners = referenceOwners.get(pair.gpt.image_sha256) ?? [];
    assertEqual(gptReferenceOwners.length, 0, `${pair.imageId} GPT baseline reference-echo hash count`);
    const flowReferenceOwners = referenceOwners.get(pair.flow.image_sha256) ?? [];
    assertEqual(flowReferenceOwners.length, 0, `${pair.imageId} Google Flow reference-echo hash count`);
  }
  const crossProvider = [];
  for (const [sha256, flowImageId] of flowOwners) {
    const gptImageId = gptOwners.get(sha256);
    if (gptImageId) crossProvider.push({ sha256, flow_image_id: flowImageId, gpt_image_id: gptImageId });
  }
  assertEqual(crossProvider.length, 0, "cross-provider duplicate hash count");
}

function blindAssignment(seedValue, pair) {
  const seed = String(seedValue);
  const assignmentSha256 = sha256Text([
    TAXONOMY_SCHEMA,
    seed,
    pair.imageId,
    pair.canonical.canonicalPromptSha256,
    ...pair.canonical.references.map((reference) => `${reference.ref_id}:${reference.sha256}`),
    pair.gpt.image_sha256,
    pair.flow.image_sha256,
  ].join("\n"));
  const flowIsA = Number.parseInt(assignmentSha256.slice(0, 8), 16) % 2 === 0;
  const A = flowIsA
    ? { provider: "google-flow", imagePath: pair.flow.image_path, sha256: pair.flow.image_sha256 }
    : { provider: "gpt-image-2-via-modelslab", imagePath: pair.gpt.image_path, sha256: pair.gpt.image_sha256 };
  const B = flowIsA
    ? { provider: "gpt-image-2-via-modelslab", imagePath: pair.gpt.image_path, sha256: pair.gpt.image_sha256 }
    : { provider: "google-flow", imagePath: pair.flow.image_path, sha256: pair.flow.image_sha256 };
  return { algorithm: "sha256_low_bit_v1", assignment_sha256: assignmentSha256, A, B };
}

async function buildPairContactSheet({ pair, blind }) {
  const width = 2000;
  const margin = 40;
  const gap = 24;
  const headerHeight = 150;
  const referenceStripHeight = pair.canonical.references.length ? 230 : 0;
  const panelTop = margin + headerHeight + referenceStripHeight + (referenceStripHeight ? 20 : 0);
  const panelWidth = Math.floor((width - (margin * 2) - gap) / 2);
  const imageHeight = Math.round(panelWidth / DEFAULT_ASPECT_RATIO);
  const panelLabelHeight = 72;
  const panelHeight = panelLabelHeight + imageHeight;
  const height = panelTop + panelHeight + margin;
  const composites = [];

  const promptLines = wrapText(pair.canonical.canonicalPrompt, 142, 2);
  composites.push({
    input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width - margin * 2}" height="${headerHeight}">
      <text x="0" y="34" fill="#f4f7fb" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700">BLIND A/B • ${svgEscape(pair.imageId)}</text>
      <text x="0" y="73" fill="#aeb8c8" font-family="Arial, Helvetica, sans-serif" font-size="18">Wave concurrency ${pair.targetConcurrency} • ${pair.canonical.references.length} ordered reference${pair.canonical.references.length === 1 ? "" : "s"}</text>
      <text x="0" y="108" fill="#d7dde8" font-family="Arial, Helvetica, sans-serif" font-size="17">${svgEscape(promptLines[0] ?? "")}</text>
      <text x="0" y="135" fill="#d7dde8" font-family="Arial, Helvetica, sans-serif" font-size="17">${svgEscape(promptLines[1] ?? "")}</text>
    </svg>`),
    left: margin,
    top: margin,
  });

  if (referenceStripHeight) {
    const count = pair.canonical.references.length;
    const thumbGap = 18;
    const thumbWidth = Math.floor((width - margin * 2 - thumbGap * 3) / 4);
    const thumbImageHeight = 164;
    for (let index = 0; index < count; index += 1) {
      const reference = pair.canonical.references[index];
      const image = await sharp(reference.path, { failOn: "error" })
        .resize({ width: thumbWidth, height: thumbImageHeight, fit: "contain", background: "#0a0d12" })
        .png()
        .toBuffer();
      const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${thumbWidth}" height="46">
        <rect width="100%" height="100%" fill="#161c25"/>
        <text x="14" y="30" fill="#e7ecf4" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="700">REFERENCE ${index + 1}</text>
      </svg>`);
      const left = margin + index * (thumbWidth + thumbGap);
      const top = margin + headerHeight;
      composites.push({ input: image, left, top });
      composites.push({ input: label, left, top: top + thumbImageHeight });
    }
  }

  for (const [index, side] of [blind.A, blind.B].entries()) {
    const labelText = index === 0 ? "A" : "B";
    const left = margin + index * (panelWidth + gap);
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth}" height="${panelLabelHeight}">
      <rect width="100%" height="100%" fill="#1b2431"/>
      <text x="${panelWidth / 2}" y="51" text-anchor="middle" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="44" font-weight="700">${labelText}</text>
    </svg>`);
    const image = await sharp(side.imagePath, { failOn: "error" })
      .resize({ width: panelWidth, height: imageHeight, fit: "contain", background: "#07090d" })
      .png()
      .toBuffer();
    composites.push({ input: label, left, top: panelTop });
    composites.push({ input: image, left, top: panelTop + panelLabelHeight });
  }

  return sharp({ create: { width, height, channels: 3, background: "#0b0f15" } })
    .composite(composites)
    .jpeg({ quality: 91, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

function wrapText(value, maximumCharacters, maximumLines) {
  const words = String(value ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maximumCharacters || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maximumLines) break;
  }
  if (lines.length < maximumLines && current) lines.push(current);
  if (lines.length === maximumLines && words.join(" ").length > lines.join(" ").length) {
    lines[maximumLines - 1] = `${lines[maximumLines - 1].slice(0, Math.max(0, maximumCharacters - 1)).trimEnd()}…`;
  }
  return lines;
}

function svgEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeSegment(value) {
  return String(value ?? "pair").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "pair";
}

function buildPairReport({
  generatedAt,
  selection,
  selectionPath: lockedSelectionPath,
  selectionSha256: lockedSelectionSha256,
  proofDir: proofRoot,
  outputDir: comparisonOutputDir,
  humanReviewPath: reviewPath,
  executionInputs,
  sourceArtifacts,
  waves,
  execution,
  flowEvidence,
  referenceEchoAudit,
  renderedPairs,
}) {
  return {
    schema: PAIR_SCHEMA,
    status: "passed",
    intent: "proof_only_structural_pair_build_and_advisory_quality_review",
    quality_review_taxonomy: TAXONOMY_SCHEMA,
    generated_at: generatedAt,
    proof_dir: proofRoot,
    output_dir: comparisonOutputDir,
    production_artifacts_mutated: false,
    production_import_invoked: false,
    production_qa_invoked: false,
    selection: {
      path: lockedSelectionPath,
      sha256: lockedSelectionSha256,
      status: selection.status,
      blind_assignment_seed: selection.blind_assignment_seed ?? selection.seed,
    },
    source_artifacts: Object.fromEntries(Object.entries(sourceArtifacts).map(([key, artifact]) => [key, {
      path: artifact.path,
      sha256: artifact.sha256,
      schema: artifact.document.schema ?? null,
    }])),
    execution_inputs: executionInputs.map((input) => ({
      kind: input.kind,
      path: input.path,
      sha256: input.sha256,
      schema: input.document.schema ?? null,
      status: input.document.status ?? null,
    })),
    execution_evidence_supplied: execution.supplied,
    reference_echo_audit: {
      present: referenceEchoAudit.present,
      path: referenceEchoAudit.path,
      sha256: referenceEchoAudit.sha256,
      schema: referenceEchoAudit.schema,
      status: referenceEchoAudit.status,
      threshold_normalized_pixel_mae: referenceEchoAudit.threshold_normalized_pixel_mae,
    },
    execution_wave_evidence: flowEvidence.waveEvidence,
    selected_waves: waves.map((wave) => ({
      target_concurrency: wave.targetConcurrency,
      selected_image_ids: wave.imageIds,
      paired_image_ids: renderedPairs.filter((pair) => pair.targetConcurrency === wave.targetConcurrency).map((pair) => pair.imageId),
      invalid_attribution_image_ids: flowEvidence.invalidAttributionRows.filter((row) => row.target_concurrency === wave.targetConcurrency).map((row) => row.image_id),
      failed_or_deadlettered_image_ids: flowEvidence.failedRows.filter((row) => row.target_concurrency === wave.targetConcurrency).map((row) => row.image_id),
      not_attempted_image_ids: flowEvidence.waveEvidence.some((row) => row.target_concurrency === wave.targetConcurrency)
        ? []
        : wave.imageIds,
    })),
    blind_assignment: {
      algorithm: "sha256_low_bit_v1",
      binding_fields: [
        "taxonomy_schema",
        "selection_seed",
        "image_id",
        "canonical_prompt_sha256",
        "ordered_ref_id_and_sha256",
        "gpt_baseline_sha256",
        "flow_output_sha256",
      ],
      labels: ["A", "B"],
    },
    validation: {
      exact_prompt_hashes: "passed",
      exact_ordered_reference_ids_and_hashes: "passed",
      prompt_slice_manifest_completion_receipt_chain: "passed",
      accepted_gpt_baseline_and_metadata_chain: "passed",
      png_geometry_and_nonblank: "passed",
      within_paired_gpt_duplicate_hashes: [],
      within_paired_flow_duplicate_hashes: [],
      cross_provider_duplicate_hashes: [],
      paired_output_reference_echo_hashes: [],
      duplicate_validation_scope: "successful quality-pair outputs only; failed duplicate Flow outputs are preserved separately below",
      failed_flow_duplicate_outputs: flowEvidence.failedRows
        .filter((row) => row.error_class === "duplicate_output_sha256")
        .map((row) => ({
          image_id: row.image_id,
          duplicate_owner_image_id: row.duplicate_owner_image_id,
          sha256: row.generated_output_sha256,
        })),
      pair_count: renderedPairs.length,
      completed_reference_echo_rows_excluded_from_quality_pairs: flowEvidence.invalidAttributionRows.length,
      failed_or_deadlettered_rows_excluded_from_quality_pairs: flowEvidence.failedRows.length,
    },
    invalid_attribution_rows: flowEvidence.invalidAttributionRows,
    failed_or_deadlettered_rows: flowEvidence.failedRows,
    outputs: {
      contact_sheets_dir: path.join(comparisonOutputDir, "contact_sheets"),
      human_review_path: reviewPath,
    },
    pairs: renderedPairs.map((pair) => ({
      pair_id: pair.blind.assignment_sha256,
      ordinal: pair.ordinal,
      wave_ordinal: pair.waveOrdinal,
      target_concurrency: pair.targetConcurrency,
      image_id: pair.imageId,
      canonical_contract: {
        prompt_field: pair.canonical.canonicalPromptField,
        prompt: pair.canonical.canonicalPrompt,
        prompt_sha256: pair.canonical.canonicalPromptSha256,
        ordered_references: pair.canonical.references.map(referenceReceiptRow),
      },
      gpt_baseline: pair.gpt,
      google_flow_candidate: pair.flow,
      blind_assignment: {
        algorithm: pair.blind.algorithm,
        assignment_sha256: pair.blind.assignment_sha256,
        A: { provider: pair.blind.A.provider, image_sha256: pair.blind.A.sha256 },
        B: { provider: pair.blind.B.provider, image_sha256: pair.blind.B.sha256 },
      },
      contact_sheet_path: pair.contactSheetPath,
      contact_sheet_sha256: pair.contactSheetSha256,
    })),
  };
}

function emptyScores() {
  return Object.fromEntries(Object.keys(SCORE_CATEGORIES).map((category) => [category, null]));
}

function emptyCategoryWinners() {
  return Object.fromEntries(Object.keys(SCORE_CATEGORIES).map((category) => [category, null]));
}

function buildHumanReview({
  generatedAt,
  pairReportPath: proofReportPath,
  pairReportSha256,
  selectionPath: lockedSelectionPath,
  selectionSha256: lockedSelectionSha256,
  renderedPairs,
}) {
  return {
    schema: REVIEW_SCHEMA,
    taxonomy_schema: TAXONOMY_SCHEMA,
    status: "pending_human_review",
    advisory_only: true,
    generated_at: generatedAt,
    pair_proof_path: proofReportPath,
    pair_proof_sha256: pairReportSha256,
    selection_path: lockedSelectionPath,
    selection_sha256: lockedSelectionSha256,
    reviewer_instructions: "Review the anonymous left/right images on each contact sheet. Score each category independently from 1 to 5, choose category and overall winners, add only closed-enum advisory tags, and leave provider identity sealed until review is complete.",
    structural_blocker_boundary: "Scores and tags are advisory. Only missing, unreadable, corrupt, wrong-geometry, stale/hash-mismatched, or duplicate-as-donor images are structural blockers; those checks already passed before this review artifact was written.",
    score_scale: {
      type: "integer_1_to_5",
      anchors: {
        1: "unusable or major failure",
        2: "weak with material defects",
        3: "acceptable with visible issues",
        4: "strong with minor issues",
        5: "excellent and production-leading",
      },
    },
    categories: Object.entries(SCORE_CATEGORIES).map(([id, description]) => ({ id, description })),
    category_winner_enum: ["left", "right", "tie", "not_applicable"],
    overall_preference_enum: ["left", "right", "tie"],
    confidence_enum: ["low", "medium", "high"],
    advisory_tag_enum: ADVISORY_TAGS,
    rows: renderedPairs.map((pair) => ({
      image_id: pair.imageId,
      pair_id: pair.blind.assignment_sha256,
      contact_sheet_path: pair.contactSheetPath,
      contact_sheet_sha256: pair.contactSheetSha256,
      blind_left_provider: "A",
      blind_right_provider: "B",
      blind_left_image_sha256: pair.blind.A.sha256,
      blind_right_image_sha256: pair.blind.B.sha256,
      canonical_provider_prompt: pair.canonical.canonicalPrompt,
      canonical_prompt_sha256: pair.canonical.canonicalPromptSha256,
      ordered_references: pair.canonical.references.map(referenceReceiptRow),
      reference_count: pair.canonical.references.length,
      reference_identity_continuity_not_applicable_allowed: pair.canonical.references.length === 0,
      reference_identity_continuity_score_state: pair.canonical.references.length === 0 ? "not_applicable" : "pending_review",
      scores: {
        left: emptyScores(),
        right: emptyScores(),
      },
      category_winners: emptyCategoryWinners(),
      overall_preference: null,
      confidence: null,
      left_tags: [],
      right_tags: [],
      note: "",
      reviewer: null,
      reviewed_at: null,
      source_hashes: {
        canonical_prompt_sha256: pair.canonical.canonicalPromptSha256,
        ordered_reference_sha256s: pair.canonical.references.map((reference) => reference.sha256),
        gpt_baseline_sha256: pair.gpt.image_sha256,
        flow_output_sha256: pair.flow.image_sha256,
      },
    })),
  };
}

async function refuseToOverwriteCompletedReview(reviewPath) {
  if (!await pathExists(reviewPath)) return;
  const existing = await readJson(reviewPath, "existing human review");
  const populated = (existing.rows ?? []).some((row) => {
    const scoreValues = [
      ...Object.values(row?.scores?.left ?? {}),
      ...Object.values(row?.scores?.right ?? {}),
    ];
    return scoreValues.some((value) => value != null)
      || Object.values(row?.category_winners ?? {}).some((value) => value != null)
      || row?.overall_preference != null
      || row?.confidence != null
      || (row?.left_tags ?? []).length > 0
      || (row?.right_tags ?? []).length > 0
      || String(row?.note ?? "").trim()
      || row?.reviewer != null
      || row?.reviewed_at != null;
  });
  assert(!populated, `Refusing to overwrite populated human review artifact: ${reviewPath}.`);
}

async function writeBufferAtomic(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, bytes);
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function writeJsonAtomic(filePath, value) {
  await writeBufferAtomic(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}
