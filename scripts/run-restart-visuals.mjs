#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertAvailableMediaWorkflow } from "./lib/media-workflows.mjs";
import { beginStageExecution, finishStageExecution } from "./lib/execution-provenance.mjs";
import {
  RESTART_SCHEMA, assertRestartBaselineIdentity, collectBaselineFiles, collectHistoricalVisualInventory,
  createOpenArtRestartIdentity, fileSha256, jsonBytes, readJson,
  validateBaselineStages, validateOpenArtContract,
} from "./lib/openart-visual-restart.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--") || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Every restart flag requires a value.");
    flags[argv[i].slice(2)] = argv[++i];
  }
  return flags;
}
function git(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Cannot inspect repository state: ${result.stderr}`);
  return result.stdout.trim();
}
function cleanGitSnapshot() {
  if (git(["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Visual production restart requires clean committed adapter code; diagnostic dirty-worktree flags are not supported.");
  return { commit: git(["rev-parse", "HEAD"]), branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), dirty: false, dirty_diff_sha256: null, dirty_status: [] };
}
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function absent(target) {
  try { await fs.lstat(target); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error(`Restart target already exists and will not be overwritten: ${target}`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const supported = new Set(["baseline-episode-dir", "week", "openart-contract", "approved-by", "note"]);
  for (const key of Object.keys(flags)) if (!supported.has(key)) throw new Error(`Unsupported restart flag --${key}; provider and nonvisual overrides are forbidden.`);
  for (const key of supported) if (!flags[key]?.trim()) throw new Error(`Required --${key} is missing.`);
  if (flags.note.trim().length < 20) throw new Error("Record the explicit authorization to restart visuals and preserve approved nonvisual production.");
  const gitSnapshot = cleanGitSnapshot();
  const baselineDir = await fs.realpath(path.resolve(flags["baseline-episode-dir"]));
  const baseline = await readJson(path.join(baselineDir, "run_identity.json"));
  assertRestartBaselineIdentity(baseline);
  assertAvailableMediaWorkflow(baseline);
  if (baseline.episode_dir !== baselineDir) throw new Error("Baseline identity episode_dir differs from its actual directory.");
  const expectedSuffix = path.join("weekly_runs", baseline.week, "episodes", baseline.episode);
  if (!baselineDir.endsWith(path.sep + expectedSuffix)) throw new Error("Baseline is not in its locked weekly-run directory.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]+$/.test(flags.week) || flags.week === baseline.week) throw new Error("Use a distinct safe new --week run slug; episode identity is retained.");
  const targetDir = path.join(baselineDir.slice(0, -expectedSuffix.length), "weekly_runs", flags.week, "episodes", baseline.episode);
  const targetRunDir = path.dirname(path.dirname(targetDir));
  await absent(targetRunDir);
  const contract = await validateOpenArtContract(await readJson(path.resolve(flags["openart-contract"])));
  const sourceHash = await fileSha256(baseline.source_path);
  if (sourceHash !== baseline.source_sha256) throw new Error("The baseline source no longer matches its immutable identity.");
  const baselineIdentityHash = await fileSha256(path.join(baselineDir, "run_identity.json"));
  const result = spawnSync(process.execPath, [path.join(repoRoot, "bin/goldflow.mjs"), "run", "status", "--episode-dir", baselineDir, "--format", "json"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Baseline status failed: ${result.stderr || result.stdout}`);
  const baselineStatus = JSON.parse(result.stdout);
  const acceptedStages = validateBaselineStages(baselineStatus);
  const files = await collectBaselineFiles(baselineDir, baseline);
  const historicalInventoryBytes = jsonBytes(await collectHistoricalVisualInventory(baselineDir, baseline.episode));
  const scriptHash = await fileSha256(path.join(baselineDir, "script_clean.md"));
  if (scriptHash !== baseline.source_sha256) throw new Error("This narrow restart requires the already-approved exact source text; changed source is not accepted.");
  const packageRows = (baselineStatus.stages ?? baselineStatus.stage_ledger ?? []).filter(row => ["upload_packaging", "youtube_publish_readiness"].includes(row.stage));
  if (packageRows.some(row => ["passed", "skipped_with_waiver"].includes(row.state))) throw new Error("This baseline has an accepted package. A package-specific carryforward adapter is required to preserve its text approvals while replacing historical visual assets.");
  const createdAt = new Date().toISOString();
  const snapshotBytes = jsonBytes(baselineStatus);
  const receipt = {
    schema: RESTART_SCHEMA, restart_id: randomUUID(), created_at: createdAt,
    target_episode_dir: targetDir, target_week: flags.week,
    baseline_episode_dir: baselineDir, baseline_identity_sha256: baselineIdentityHash,
    baseline_source_path: baseline.source_path, baseline_source_sha256: sourceHash,
    script_sha256: scriptHash, baseline_status_sha256: digest(snapshotBytes),
    historical_visual_inventory_sha256: digest(historicalInventoryBytes),
    accepted_baseline_stages: acceptedStages, files,
    package_carryforward: { state: "no_accepted_package_in_baseline", preserved_title: baseline.title },
    authorization: { approved_by: flags["approved-by"], note: flags.note },
    exclusions: ["all_historical_generated_images", "all_historical_canonical_visual_references", "all_historical_visual_approvals", "prompts_and_hardening", "transition_motion_render_and_qa", "provider_execution_ledgers"],
    provenance_policy: "byte_identical_copies_retain_original_internal_paths_and_approvals; no_resynthesis_no_retiming_no_new_listening_claim",
    provider_requests: 0, credit_cost: 0,
    git: gitSnapshot,
  };
  const receiptBytes = jsonBytes(receipt);
  const identity = createOpenArtRestartIdentity({ baseline, targetDir, week: flags.week, contract, git: gitSnapshot, receiptSha256: digest(receiptBytes), baselineIdentitySha256: baselineIdentityHash, createdAt });
  // All validation occurs before this first production-directory creation.
  // mkdir without recursive atomically reserves the distinct run; never resume
  // or overwrite a partial attempt through this command.
  await fs.mkdir(targetRunDir);
  await fs.mkdir(targetDir, { recursive: true });
  const execution = await beginStageExecution({ stage: "run_identity", command: "run restart-visuals", flags: { "episode-dir": targetDir }, args: process.argv.slice(2) });
  try {
    for (const row of files) {
      const destination = path.join(targetDir, row.relative_path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(row.source_path, destination, 1); // COPYFILE_EXCL; no links to mutable originals.
      if (await fileSha256(destination) !== row.sha256 || await fileSha256(row.source_path) !== row.sha256) throw new Error(`Artifact changed during carryforward: ${row.relative_path}`);
    }
    if (await fileSha256(path.join(baselineDir, "run_identity.json")) !== baselineIdentityHash) throw new Error("Baseline identity changed during restart.");
    await fs.writeFile(path.join(targetDir, "baseline_status_snapshot.json"), snapshotBytes, { flag: "wx" });
    await fs.writeFile(path.join(targetDir, "historical_visual_inventory.json"), historicalInventoryBytes, { flag: "wx" });
    await fs.writeFile(path.join(targetDir, "visual_restart_receipt.json"), receiptBytes, { flag: "wx" });
    await fs.writeFile(path.join(targetDir, "run_identity.json"), jsonBytes(identity), { flag: "wx" });
    await finishStageExecution(execution, { exitCode: 0 });
    console.log(JSON.stringify({ status: "created", episode_dir: targetDir, baseline_unchanged: true, provider_requests: 0, next_command: `node bin/goldflow.mjs run status --episode-dir ${targetDir} --format markdown` }, null, 2));
  } catch (error) {
    await finishStageExecution(execution, { exitCode: 1, error: error.message });
    throw error; // Retain failed attempt evidence; never delete it or retry automatically.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
