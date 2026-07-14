#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { loadWorkManifest, validateCodexWorkManifest } from "./lib/codex-image-work-contract.mjs";

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
const dryRun = flags["dry-run"] === "true";
const force = flags.force === "true" || flags["force-import"] === "true";
const workflowBypass = flags["workflow-bypass"] === "true";
const qaRecovery = flags["qa-recovery"] === "true";
const manifestPath = flags.manifest ? path.resolve(flags.manifest) : null;
const referenceDir = path.join(episodeDir, "assets", "images", "references");

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
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeImmutableBatchReport(report, label) {
  if (dryRun) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifestId = manifestPath ? path.basename(path.dirname(manifestPath)) : "legacy-staged";
  const outputPath = path.join(episodeDir, "reports", "imagegen-batches", `${stamp}-${label}-${manifestId}.json`);
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
    list.push(row.filePath);
    byId.set(row.assetId, list);
  }
  const duplicateIds = [...byId.entries()].filter(([, paths]) => paths.length !== 1);
  if (duplicateIds.length) throw new Error(`Expected exactly one staged PNG per ${kind}; duplicates: ${duplicateIds.map(([id, paths]) => `${id}=${paths.length}`).join(", ")}`);
  if (scope.size) {
    const missing = [...scope].filter((id) => !byId.has(id));
    const extra = [...byId.keys()].filter((id) => !scope.has(id));
    if (missing.length || extra.length) throw new Error(`Staged ${kind} scope mismatch; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}`);
  }
  return new Map([...byId.entries()].map(([id, paths]) => [id, paths[0]]));
}

async function hashFile(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
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
  const validation = await validateCodexWorkManifest({ manifestPath });
  if (validation.status !== "passed") throw new Error(`Codex work manifest is not importable; ${validation.finding_count} validation finding(s). Inspect ${manifestPath}.`);
  const { manifest, manifestDir } = await loadWorkManifest(manifestPath);
  if (manifest.mode !== expectedMode) throw new Error(`Codex work manifest mode is ${manifest.mode}; expected ${expectedMode}.`);
  const manifestIds = new Set(manifest.items.map((item) => item.asset_id));
  if (scope.size) {
    const outOfManifest = [...scope].filter((id) => !manifestIds.has(id));
    if (outOfManifest.length) throw new Error(`Requested IDs are outside Codex work manifest: ${outOfManifest.join(", ")}`);
  }
  const selectedIds = scope.size ? [...scope] : [...manifestIds];
  return Promise.all(selectedIds.map(async (assetId) => {
    const completion = await readJson(path.join(manifestDir, "completions", `${assetId}.json`));
    return { assetId, filePath: completion.source_path };
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

async function importOne(imageId, sourcePath) {
  const args = [
    path.join(repoRoot, "bin", "goldflow.mjs"),
    "imagegen",
    "import-codex",
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
  ];
  if (workflowBypass) args.push("--workflow-bypass", "true");
  if (qaRecovery) args.push("--qa-recovery", "true");
  if (manifestPath) args.push("--import-route", "codex_imagegen_worker_queue", "--work-manifest", manifestPath);
  const { stdout } = await execFile(process.execPath, args, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 4 });
  return JSON.parse(stdout);
}

async function importReferenceOne(refId, sourcePath, referencePlan, characterRefs) {
  const outputPath = path.join(referenceDir, `${refId}-codex-imagegen-reference.png`);
  if (!force && await exists(outputPath)) {
    return { ref_id: refId, source_path: sourcePath, image_path: outputPath, status: "skipped_existing" };
  }
  if (dryRun) return { ref_id: refId, source_path: sourcePath, image_path: outputPath, status: "dry_run" };
  await fs.mkdir(referenceDir, { recursive: true });
  await fs.copyFile(sourcePath, outputPath);
  await verifyPng(outputPath);
  const sourceHash = await hashFile(sourcePath);
  const target = (referencePlan.reference_targets ?? []).find((row) => row.ref_id === refId) ?? {};
  const metadata = {
    ref_id: refId,
    kind: target.kind ?? null,
    subject: target.subject ?? null,
    source_reference_plan_path: visualReferencePlanPath,
    source_path: sourcePath,
    conditioning_image_path: outputPath,
    image_provider: "codex_imagegen",
    image_provider_route: "staged_codex_reference_import",
    generated: {
      downloaded_path: outputPath,
      output_sha256: sourceHash,
      source: "staged_codex_reference_import",
    },
    updated_at: new Date().toISOString(),
  };
  await writeJson(`${outputPath}.metadata.json`, metadata);
  const updatedReferencePlan = {
    ...referencePlan,
    reference_targets: (referencePlan.reference_targets ?? []).map((row) => row.ref_id === refId ? {
      ...row,
      reference_image_path: outputPath,
      conditioning_image_path: outputPath,
      image_provider: "codex_imagegen",
      image_provider_route: "staged_codex_reference_import",
    } : row),
    reference_generation_updated_at: new Date().toISOString(),
  };
  await writeJson(visualReferencePlanPath, updatedReferencePlan);
  if (Array.isArray(characterRefs?.character_state_refs)) {
    const currentPlanHash = await hashFile(visualReferencePlanPath);
    const updatedCharacterRefs = {
      ...characterRefs,
      source_hashes: {
        ...(characterRefs.source_hashes ?? {}),
        [visualReferencePlanPath]: currentPlanHash,
      },
      character_state_refs: characterRefs.character_state_refs.map((row) => row.source_ref_id === refId ? {
        ...row,
        reference_image_path: outputPath,
        conditioning_image_path: outputPath,
        image_provider: "codex_imagegen",
        image_provider_route: "staged_codex_reference_import",
      } : row),
      reference_generation_updated_at: new Date().toISOString(),
    };
    await writeJson(characterStateRefsPath, updatedCharacterRefs);
  }
  return { ref_id: refId, source_path: sourcePath, image_path: outputPath, status: "imported", sha256: sourceHash };
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
  let currentReferencePlan = referencePlan;
  let currentCharacterRefs = characterRefs;
  for (const [refId, filePath] of byId.entries()) {
    await verifyPng(filePath);
    const sourceHash = await hashFile(filePath);
    const duplicateOwner = !force ? importedHashOwners.get(sourceHash) : null;
    if (duplicateOwner && duplicateOwner !== refId) {
      const skipped = { ref_id: refId, source_path: filePath, status: "skipped_duplicate_hash", duplicate_of: duplicateOwner };
      imports.push(skipped);
      console.log(JSON.stringify(skipped));
      continue;
    }
    const result = await importReferenceOne(refId, filePath, currentReferencePlan, currentCharacterRefs);
    importedHashOwners.set(sourceHash, refId);
    imports.push(result);
    console.log(JSON.stringify(result));
    currentReferencePlan = await readJson(visualReferencePlanPath);
    currentCharacterRefs = await exists(characterStateRefsPath) ? await readJson(characterStateRefsPath) : null;
  }
  const report = {
    schema: "goldflow_codex_staged_reference_import_v1",
    status: imports.every((row) => ["imported", "skipped_existing", "dry_run"].includes(row.status)) ? "passed" : "failed",
    channel,
    series_slug: series,
    week,
    episode,
    reference_only: true,
    staging_dir: stagingDir,
    work_manifest_path: manifestPath,
    visual_reference_plan_path: visualReferencePlanPath,
    character_state_refs_path: characterStateRefsPath,
    imported_count: imports.length,
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
  if (!force && Array.isArray(priorReport?.results)) {
    for (const row of priorReport.results) {
      if (!row?.image_id || !row.image_path || !(await exists(row.image_path))) continue;
      alreadyImported.add(row.image_id);
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
  for (const [imageId, filePath] of byId.entries()) {
    await verifyPng(filePath);
    if (alreadyImported.has(imageId)) {
      imports.push({ image_id: imageId, source_path: filePath, status: "skipped_existing" });
      continue;
    }
    const sourceHash = await hashFile(filePath);
    const duplicateOwner = !force ? importedHashOwners.get(sourceHash) : null;
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
    const result = await importOne(imageId, filePath);
    importedHashOwners.set(sourceHash, imageId);
    imports.push({ image_id: imageId, source_path: filePath, status: result.status, image_count: result.image_count, missing_image_count: result.missing_image_count });
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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
