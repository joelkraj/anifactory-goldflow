#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  codexWorkSourceRowSha256,
  loadWorkManifest,
  validateCodexWorkManifest,
} from "./lib/codex-image-work-contract.mjs";
import { FEDERATED_WEB_IMAGE_PROVIDER, HYBRID_WEB_FLOW_PROVIDER } from "./lib/image-provider-policy.mjs";

const execFile = promisify(execFileCb);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));

const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json");
const visualReferencePlanPath = flags.referencePlan ?? flags["reference-plan"] ?? path.join(episodeDir, "visual_reference_plan.json");
const characterStateRefsPath = flags.characterStateRefs ?? flags["character-state-refs"] ?? path.join(episodeDir, "character_state_refs.json");
const stagingDir = flags["staging-dir"] ?? path.join(episodeDir, "assets", "images", "codex_worker_staging");
const referencesOnly = flags["references-only"] === "true";
const reportPath = flags.output ?? flags.report ?? flags["report-output"] ?? path.join(episodeDir, referencesOnly ? `imagegen_report_${episode}_codex_references.json` : `imagegen_report_${episode}.json`);
const cutExecutionLedgerPath = flags["cut-execution-ledger"] ?? path.join(episodeDir, "cut_execution_ledger.json");
const dryRun = flags["dry-run"] === "true";
const force = flags.force === "true" || flags["force-import"] === "true";
const workflowBypass = flags["workflow-bypass"] === "true";
const wavefrontPrefetch = flags["wavefront-prefetch"] === "true";
const providerBatchImport = flags["provider-batch-import"] === "true";
const qaRecovery = flags["qa-recovery"] === "true";
const allowPartialManifest = flags["allow-partial-manifest"] === "true";
const allowSourceArtifactDrift = flags["allow-source-artifact-drift"] === "true";
const manifestPath = flags.manifest ? path.resolve(flags.manifest) : null;
const referenceDir = path.join(episodeDir, "assets", "images", "references");

export function providerBatchManifestEligible(manifest) {
  const provider = String(manifest?.provider ?? "");
  return [HYBRID_WEB_FLOW_PROVIDER, "hybrid_web_flow", FEDERATED_WEB_IMAGE_PROVIDER].includes(provider)
    && manifest?.policy?.browser_provider_receipt_required === true;
}

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function writeImmutableBatchReport(report, label) {
  if (dryRun) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifestId = manifestPath ? path.basename(path.dirname(manifestPath)) : "legacy-staged";
  const outputPath = wavefrontPrefetch
    ? path.join(path.dirname(reportPath), `${stamp}-${label}-${manifestId}.json`)
    : path.join(episodeDir, "reports", "imagegen-batches", `${stamp}-${label}-${manifestId}.json`);
  await writeJson(outputPath, {
    ...report,
    immutable_batch: true,
    work_manifest_path: manifestPath,
    immutable_report_path: outputPath,
  });
  return outputPath;
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function verifyPng(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`Missing or empty staged image: ${filePath}`);
  const metadata = await sharp(filePath, { failOn: "error" }).metadata();
  if (metadata.format !== "png" || !metadata.width || !metadata.height) throw new Error(`Staged file is not a decodable PNG: ${filePath}`);
  if (metadata.width <= metadata.height) throw new Error(`Staged image must be landscape: ${filePath} (${metadata.width}x${metadata.height})`);
  const aspect = metadata.width / metadata.height;
  if (Math.abs(aspect - (16 / 9)) > 0.08) throw new Error(`Staged image must be 16:9 within 0.08 tolerance: ${filePath} (${metadata.width}x${metadata.height})`);
  return metadata;
}

function requestedIds(...values) {
  return new Set(values.flatMap((value) => String(value ?? "").split(",")).map((value) => value.trim()).filter(Boolean));
}

function assertExactFilesById(rows, scope, kind) {
  const byId = new Map();
  for (const row of rows) {
    const list = byId.get(row.assetId) ?? [];
    list.push(row);
    byId.set(row.assetId, list);
  }
  const duplicateIds = [...byId.entries()].filter(([, entries]) => entries.length !== 1);
  if (duplicateIds.length) throw new Error(`Expected exactly one staged PNG per ${kind}; duplicates: ${duplicateIds.map(([id, entries]) => `${id}=${entries.length}`).join(", ")}`);
  if (scope.size) {
    const missing = [...scope].filter((id) => !byId.has(id));
    const extra = [...byId.keys()].filter((id) => !scope.has(id));
    if (missing.length || extra.length) throw new Error(`Staged ${kind} scope mismatch; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}`);
  }
  return new Map([...byId.entries()].map(([id, entries]) => [id, entries[0]]));
}

async function hashFile(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function providerSlug(provider) {
  if (provider === "google_flow") return "google-flow-nano-banana-pro";
  if (provider === "chatgpt_web_gpt_image") return "chatgpt-web-gpt-image";
  return "codex-imagegen";
}

async function completionProviderProvenance(completion) {
  const browserProvider = completion?.browser_provider ?? null;
  if (!browserProvider) {
    return {
      browser_provider: null,
      image_provider: "codex_imagegen",
      model: "codex_builtin_imagegen_manual",
      receipt_path: null,
      receipt_sha256: null,
    };
  }
  const receiptName = browserProvider === "google-flow"
    ? "google_flow_receipt.json"
    : browserProvider === "google-gemini" ? "google_gemini_receipt.json" : "chatgpt_web_receipt.json";
  const receiptPath = path.join(completion.attempt_dir, receiptName);
  const receipt = await readJson(receiptPath).catch(() => null);
  if (!receipt || receipt.asset_id !== completion.asset_id) {
    throw new Error(`Missing provider receipt for completed browser asset ${completion.asset_id}: ${receiptPath}`);
  }
  if (receipt.browser_provider && receipt.browser_provider !== browserProvider) {
    throw new Error(`Provider receipt mismatch for ${completion.asset_id}: completion=${browserProvider}, receipt=${receipt.browser_provider}.`);
  }
  if (receipt.accepted_png_sha256 && receipt.accepted_png_sha256 !== completion.sha256) {
    throw new Error(`Provider receipt output hash is stale for ${completion.asset_id}.`);
  }
  const imageProvider = browserProvider === "google-flow" ? "google_flow" : "chatgpt_web_gpt_image";
  return {
    browser_provider: browserProvider,
    image_provider: imageProvider,
    model: imageProvider === "google_flow"
      ? receipt.ui_contract?.model_label ?? "Nano Banana Pro"
      : "chatgpt_web_gpt_image",
    receipt_path: receiptPath,
    receipt_sha256: await hashFile(receiptPath),
  };
}

async function walk(dir) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(filePath));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) files.push(filePath);
  }
  return files;
}

async function validatedManifestRows(expectedMode, scope) {
  if (!manifestPath) return null;
  if (allowPartialManifest && !scope.size) {
    throw new Error("--allow-partial-manifest true requires exact --image-ids/--reference-ids scope.");
  }
  const { manifest, manifestDir } = await loadWorkManifest(manifestPath);
  if (manifest.mode !== expectedMode) throw new Error(`Codex work manifest mode is ${manifest.mode}; expected ${expectedMode}.`);
  const manifestIds = new Set(manifest.items.map((item) => item.asset_id));
  if (scope.size) {
    const outOfManifest = [...scope].filter((id) => !manifestIds.has(id));
    if (outOfManifest.length) throw new Error(`Requested IDs are outside Codex work manifest: ${outOfManifest.join(", ")}`);
  }
  const selectedIds = scope.size ? [...scope] : [...manifestIds];
  if (allowSourceArtifactDrift) {
    if (!allowPartialManifest || !scope.size) {
      throw new Error("--allow-source-artifact-drift true requires exact-scope --allow-partial-manifest true.");
    }
    const currentPlan = await readJson(expectedMode === "scene" ? promptPath : visualReferencePlanPath);
    const currentRows = expectedMode === "scene" ? currentPlan.prompts ?? [] : currentPlan.reference_targets ?? [];
    const currentById = new Map(currentRows.map((row) => [String(expectedMode === "scene" ? row.image_id : row.ref_id), row]));
    const itemById = new Map(manifest.items.map((item) => [item.asset_id, item]));
    for (const assetId of selectedIds) {
      const currentRow = currentById.get(assetId);
      const item = itemById.get(assetId);
      if (!currentRow || !item || codexWorkSourceRowSha256(currentRow) !== item.source_row_sha256) {
        throw new Error(`Current ${expectedMode} row is not creative-contract-identical to completed manifest item ${assetId}.`);
      }
    }
  }
  const validation = await validateCodexWorkManifest({
    manifestPath,
    assetIds: allowPartialManifest ? selectedIds : [],
    allowIncomplete: allowPartialManifest,
    allowSourceArtifactDrift,
  });
  if (validation.status !== "passed") throw new Error(`Codex work manifest is not importable; ${validation.finding_count} validation finding(s). Inspect ${manifestPath}.`);
  return Promise.all(selectedIds.map(async (assetId) => {
    const completion = await readJson(path.join(manifestDir, "completions", `${assetId}.json`));
    return {
      assetId,
      filePath: completion.source_path,
      provenance: await completionProviderProvenance(completion),
    };
  }));
}

function imageIdFromPath(filePath) {
  return path.basename(filePath).match(/(ep_\d+-(?:cut-\d+|w\d+-w\d+))/)?.[1] ?? null;
}

function refIdFromPath(filePath, validIds) {
  const base = path.basename(filePath, path.extname(filePath));
  if (validIds.has(base)) return base;
  for (const suffix of ["-codex-imagegen-reference", "-codex-reference", "-reference"]) {
    if (base.endsWith(suffix)) {
      const candidate = base.slice(0, -suffix.length);
      if (validIds.has(candidate)) return candidate;
    }
  }
  return null;
}

export function buildStagedSceneImportInvocation({
  wavefrontPrefetch,
  providerBatchImport = false,
  channel,
  series,
  week,
  episode,
  promptPath,
  imageId,
  sourcePath,
  reportPath,
  cutExecutionLedgerPath,
  workflowBypass = false,
  qaRecovery = false,
  manifestPath = null,
  provenance = null,
}) {
  const importArgs = [
    "--channel",
    channel,
    "--series",
    series,
    "--week",
    week,
    "--episode",
    episode,
    "--prompts",
    promptPath,
    "--image-id",
    imageId,
    "--source",
    sourcePath,
    "--output",
    reportPath,
    "--cut-execution-ledger",
    cutExecutionLedgerPath,
  ];
  const args = wavefrontPrefetch || providerBatchImport
    ? [path.join(repoRoot, "scripts", "codex-image-manual-import.mjs"), ...importArgs]
    : [path.join(repoRoot, "bin", "goldflow.mjs"), "imagegen", "import-codex", ...importArgs];
  if (workflowBypass) args.push("--workflow-bypass", "true");
  if (qaRecovery) args.push("--qa-recovery", "true");
  if (manifestPath) {
    args.push(
      "--import-route", provenance?.image_provider ?? "codex_imagegen",
      "--work-manifest", manifestPath,
      "--model", provenance?.model ?? "codex_builtin_imagegen_manual",
    );
    if (provenance?.browser_provider) args.push("--browser-provider", provenance.browser_provider);
    if (provenance?.receipt_path) {
      args.push("--provider-receipt", provenance.receipt_path, "--provider-receipt-sha256", provenance.receipt_sha256);
    }
  }
  return args;
}

async function importOne(imageId, sourcePath, provenance) {
  const args = buildStagedSceneImportInvocation({
    wavefrontPrefetch,
    providerBatchImport,
    channel,
    series,
    week,
    episode,
    promptPath,
    imageId,
    sourcePath,
    reportPath,
    cutExecutionLedgerPath,
    workflowBypass,
    qaRecovery,
    manifestPath,
    provenance,
  });
  const { stdout } = await execFile(process.execPath, args, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 4 });
  return JSON.parse(stdout);
}

async function importReferenceOne(refId, sourcePath, referencePlan, characterRefs, provenance) {
  const imageProvider = provenance?.image_provider ?? "codex_imagegen";
  const importRoute = provenance?.browser_provider ? "hybrid_browser_pool" : "staged_codex_reference_import";
  const outputPath = path.join(referenceDir, `${refId}-${providerSlug(imageProvider)}-reference.png`);
  const sourceHash = await hashFile(sourcePath);
  if (dryRun) return { ref_id: refId, source_path: sourcePath, image_path: outputPath, status: "dry_run" };
  await fs.mkdir(referenceDir, { recursive: true });
  let status = "imported";
  if (await exists(outputPath)) {
    const existingHash = await hashFile(outputPath);
    if (existingHash === sourceHash && !force) status = "skipped_existing";
    else await fs.copyFile(sourcePath, outputPath);
  } else {
    await fs.copyFile(sourcePath, outputPath);
  }
  await verifyPng(outputPath);
  const target = (referencePlan.reference_targets ?? []).find((row) => row.ref_id === refId) ?? {};
  const metadata = {
    ref_id: refId,
    kind: target.kind ?? null,
    subject: target.subject ?? null,
    source_reference_plan_path: visualReferencePlanPath,
    source_path: sourcePath,
    conditioning_image_path: outputPath,
    image_provider: imageProvider,
    image_provider_route: importRoute,
    browser_provider: provenance?.browser_provider ?? null,
    model: provenance?.model ?? "codex_builtin_imagegen_manual",
    provider_receipt_path: provenance?.receipt_path ?? null,
    provider_receipt_sha256: provenance?.receipt_sha256 ?? null,
    generated: {
      downloaded_path: outputPath,
      output_sha256: sourceHash,
      source: importRoute,
    },
    updated_at: new Date().toISOString(),
  };
  await writeJson(`${outputPath}.metadata.json`, metadata);
  return {
    ref_id: refId,
    source_path: sourcePath,
    image_path: outputPath,
    status,
    sha256: sourceHash,
    image_provider: imageProvider,
    browser_provider: provenance?.browser_provider ?? null,
    model: provenance?.model ?? null,
    provider_receipt_path: provenance?.receipt_path ?? null,
    provider_receipt_sha256: provenance?.receipt_sha256 ?? null,
  };
}

async function importReferences() {
  const referencePlan = await readJson(visualReferencePlanPath);
  const characterRefs = await exists(characterStateRefsPath) ? await readJson(characterStateRefsPath) : null;
  const validIds = new Set((referencePlan.reference_targets ?? []).map((row) => row.ref_id).filter(Boolean));
  const scope = requestedIds(flags["reference-ids"], flags["reference-id"]);
  const unknownScope = [...scope].filter((id) => !validIds.has(id));
  if (unknownScope.length) throw new Error(`Unknown reference ids requested: ${unknownScope.join(", ")}`);
  const manifestRows = await validatedManifestRows("reference", scope);
  const files = (manifestRows ?? (await walk(stagingDir))
    .map((filePath) => ({ filePath, assetId: refIdFromPath(filePath, validIds) }))
    .filter((row) => row.assetId && (!scope.size || scope.has(row.assetId))))
    .sort((left, right) => left.assetId.localeCompare(right.assetId, undefined, { numeric: true }));
  const byId = assertExactFilesById(files, scope, "reference id");
  const imports = [];
  const importedHashOwners = new Map();
  for (const target of referencePlan.reference_targets ?? []) {
    const targetPath = target.reference_image_path ?? target.conditioning_image_path;
    if (!target.ref_id || !targetPath || !(await exists(targetPath))) continue;
    const targetHash = await hashFile(targetPath);
    if (!importedHashOwners.has(targetHash)) importedHashOwners.set(targetHash, target.ref_id);
  }
  for (const [refId, entry] of byId.entries()) {
    const filePath = entry.filePath;
    await verifyPng(filePath);
    const sourceHash = await hashFile(filePath);
    const duplicateOwner = importedHashOwners.get(sourceHash);
    if (duplicateOwner && duplicateOwner !== refId) {
      const skipped = { ref_id: refId, source_path: filePath, status: "skipped_duplicate_hash", duplicate_of: duplicateOwner };
      imports.push(skipped);
      console.log(JSON.stringify(skipped));
      continue;
    }
    const result = await importReferenceOne(refId, filePath, referencePlan, characterRefs, entry.provenance);
    importedHashOwners.set(sourceHash, refId);
    imports.push(result);
    console.log(JSON.stringify(result));
  }
  const materializedById = new Map(imports
    .filter((row) => ["imported", "skipped_existing"].includes(row.status))
    .map((row) => [row.ref_id, row]));
  if (!dryRun && materializedById.size) {
    const updatedAt = new Date().toISOString();
    const patchReferenceRow = (row, materialized) => ({
      ...row,
      reference_image_path: materialized.image_path,
      conditioning_image_path: materialized.image_path,
      image_provider: materialized.image_provider,
      image_provider_route: materialized.browser_provider ? "hybrid_browser_pool" : "staged_codex_reference_import",
      browser_provider: materialized.browser_provider,
      provider_receipt_path: materialized.provider_receipt_path,
      provider_receipt_sha256: materialized.provider_receipt_sha256,
    });
    const updatedReferencePlan = {
      ...referencePlan,
      reference_targets: (referencePlan.reference_targets ?? []).map((row) => {
        const materialized = materializedById.get(row.ref_id);
        return materialized ? patchReferenceRow(row, materialized) : row;
      }),
      reference_generation_updated_at: updatedAt,
    };
    if (Array.isArray(characterRefs?.character_state_refs)) {
      const projectedPlanHash = createHash("sha256").update(`${JSON.stringify(updatedReferencePlan, null, 2)}\n`).digest("hex");
      const updatedCharacterRefs = {
        ...characterRefs,
        source_hashes: {
          ...(characterRefs.source_hashes ?? {}),
          [visualReferencePlanPath]: projectedPlanHash,
        },
        character_state_refs: characterRefs.character_state_refs.map((row) => {
          const materialized = materializedById.get(row.source_ref_id);
          return materialized ? patchReferenceRow(row, materialized) : row;
        }),
        reference_generation_updated_at: updatedAt,
      };
      await writeJson(characterStateRefsPath, updatedCharacterRefs);
    }
    await writeJson(visualReferencePlanPath, updatedReferencePlan);
  }
  const report = {
    schema: "goldflow_codex_staged_reference_import_v1",
    status: imports.every((row) => ["imported", "skipped_existing", "dry_run"].includes(row.status)) ? "passed" : "failed",
    channel,
    series_slug: series,
    week,
    episode,
    reference_only: true,
    image_provider: manifestPath ? "hybrid_browser_pool_or_staged_worker" : "staged_codex_reference_import",
    staging_dir: stagingDir,
    work_manifest_path: manifestPath,
    visual_reference_plan_path: visualReferencePlanPath,
    character_state_refs_path: characterStateRefsPath,
    imported_count: imports.length,
    imported_by_provider: Object.fromEntries(
      [...new Set(imports.map((row) => row.image_provider).filter(Boolean))]
        .map((provider) => [provider, imports.filter((row) => row.image_provider === provider).length]),
    ),
    reference_results: imports,
    updated_at: new Date().toISOString(),
  };
  if (!dryRun) await writeJson(reportPath, report);
  const immutableReportPath = await writeImmutableBatchReport(report, "codex-references");
  console.log(JSON.stringify({
    status: dryRun ? "dry_run" : report.status,
    staging_dir: stagingDir,
    report_path: dryRun ? null : reportPath,
    imported_count: imports.length,
    immutable_report_path: immutableReportPath,
  }, null, 2));
  if (report.status !== "passed") throw new Error(`Staged Codex reference import failed; inspect ${reportPath}`);
}

async function main() {
  if (providerBatchImport || wavefrontPrefetch) {
    if (!manifestPath) throw new Error("Provider-batch materialization requires a provider-attributed work manifest.");
    const loaded = await loadWorkManifest(manifestPath);
    if (!providerBatchManifestEligible(loaded.manifest)) {
      throw new Error("Direct provider-batch materialization is restricted to receipt-required hybrid or federated Web/Flow manifests.");
    }
  }
  if (providerBatchImport) {
    if (referencesOnly) throw new Error("--provider-batch-import true is valid only for scene images.");
    const exactScope = requestedIds(flags["image-ids"], flags["image-id"], flags["cut-ids"], flags["cut-id"]);
    if (!exactScope.size) throw new Error("--provider-batch-import true requires exact image IDs.");
  }
  if (wavefrontPrefetch) {
    if (referencesOnly) throw new Error("--wavefront-prefetch true is valid only for scene images.");
    if (qaRecovery || workflowBypass) throw new Error("Wavefront prefetch cannot be combined with QA recovery or a generic workflow bypass.");
    const exactScope = requestedIds(flags["image-ids"], flags["image-id"], flags["cut-ids"], flags["cut-id"]);
    if (!exactScope.size) throw new Error("--wavefront-prefetch true requires exact image IDs.");
    const wavefrontRoot = path.join(episodeDir, "reports", "visual-wavefront");
    const insideWavefrontRoot = (filePath) => {
      const relative = path.relative(wavefrontRoot, path.resolve(filePath));
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    };
    if (!flags.output || !flags["cut-execution-ledger"] || !insideWavefrontRoot(reportPath) || !insideWavefrontRoot(cutExecutionLedgerPath)) {
      throw new Error("Wavefront prefetch requires explicit image report and cut ledger paths beneath reports/visual-wavefront.");
    }
  }
  if (referencesOnly) {
    await importReferences();
    return;
  }
  const plan = await readJson(promptPath);
  if (plan?.status !== "passed" || !Array.isArray(plan.prompts)) throw new Error(`Missing passed prompt plan: ${promptPath}`);
  const validIds = new Set(plan.prompts.filter((prompt) => prompt.image_generation_required !== false).map((prompt) => prompt.image_id));
  const scope = requestedIds(flags["image-ids"], flags["image-id"], flags["cut-ids"], flags["cut-id"]);
  const unknownScope = [...scope].filter((id) => !validIds.has(id));
  if (unknownScope.length) throw new Error(`Unknown image ids requested: ${unknownScope.join(", ")}`);
  const priorReport = await exists(reportPath) ? await readJson(reportPath) : null;
  const alreadyImported = new Set();
  const importedHashOwners = new Map();
  if (Array.isArray(priorReport?.results)) {
    for (const row of priorReport.results) {
      if (!row?.image_id || !row.image_path || !(await exists(row.image_path))) continue;
      if (!force) alreadyImported.add(row.image_id);
      const hash = row.generated?.output_sha256 ?? await hashFile(row.image_path);
      if (!importedHashOwners.has(hash)) importedHashOwners.set(hash, row.image_id);
    }
  }
  const manifestRows = await validatedManifestRows("scene", scope);
  const files = (manifestRows ?? (await walk(stagingDir))
    .map((filePath) => ({ filePath, assetId: imageIdFromPath(filePath) }))
    .filter((row) => row.assetId && validIds.has(row.assetId) && (!scope.size || scope.has(row.assetId))))
    .sort((left, right) => left.assetId.localeCompare(right.assetId, undefined, { numeric: true }));
  const byId = assertExactFilesById(files, scope, "image id");
  const imports = [];
  for (const [imageId, entry] of byId.entries()) {
    const filePath = entry.filePath;
    await verifyPng(filePath);
    if (alreadyImported.has(imageId)) {
      imports.push({ image_id: imageId, source_path: filePath, status: "skipped_existing" });
      continue;
    }
    const sourceHash = await hashFile(filePath);
    const duplicateOwner = importedHashOwners.get(sourceHash);
    if (duplicateOwner && duplicateOwner !== imageId) {
      const skipped = { image_id: imageId, source_path: filePath, status: "skipped_duplicate_hash", duplicate_of: duplicateOwner };
      imports.push(skipped);
      console.log(JSON.stringify(skipped));
      continue;
    }
    if (dryRun) {
      imports.push({ image_id: imageId, source_path: filePath, status: "dry_run" });
      continue;
    }
    const result = await importOne(imageId, filePath, entry.provenance);
    importedHashOwners.set(sourceHash, imageId);
    imports.push({
      image_id: imageId,
      source_path: filePath,
      status: result.status,
      image_count: result.image_count,
      missing_image_count: result.missing_image_count,
      image_provider: entry.provenance?.image_provider ?? "codex_imagegen",
      browser_provider: entry.provenance?.browser_provider ?? null,
      model: entry.provenance?.model ?? null,
      provider_receipt_path: entry.provenance?.receipt_path ?? null,
      provider_receipt_sha256: entry.provenance?.receipt_sha256 ?? null,
    });
    console.log(JSON.stringify(imports.at(-1)));
  }
  const report = dryRun || !(await exists(reportPath)) ? null : await readJson(reportPath);
  const immutableReportPath = report ? await writeImmutableBatchReport(report, "codex-scenes") : null;
  console.log(JSON.stringify({
    status: dryRun ? "dry_run" : "completed",
    staging_dir: stagingDir,
    imported_count: imports.length,
    report_path: reportPath,
    image_count: report?.image_count ?? null,
    missing_image_count: report?.missing_image_count ?? null,
    immutable_report_path: immutableReportPath,
  }, null, 2));
  const importFailures = imports.filter((row) => row.status === "skipped_duplicate_hash");
  if (importFailures.length) {
    throw new Error(`Staged scene import rejected duplicate outputs for: ${importFailures.map((row) => row.image_id).join(", ")}.`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
