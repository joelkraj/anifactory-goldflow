import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageOutputPathMatches } from "./pipeline-stage-registry.mjs";
import { resolveMediaWorkflow } from "./media-workflows.mjs";

const DEFAULT_DATA_ROOT = "/Users/joel/AniFactoryData";
const MODULE_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CODE_DRIFT_EVENT_SCHEMA = "goldflow_code_drift_event_v1";
export const CODE_DRIFT_REASON_CODE = /^[a-z][a-z0-9_]{2,63}$/;
const HASHABLE_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".txt", ".sha256", ".ass", ".vtt", ".srt"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeTimestamp(value = new Date()) {
  return value.toISOString().replace(/[:.]/g, "-");
}

async function fileSha256(filePath) {
  return sha256(await fs.readFile(filePath));
}

export function episodeDirForFlags(flags = {}, env = process.env) {
  if (flags["episode-dir"]) return path.resolve(flags["episode-dir"]);
  if (!flags.channel || !flags.week || !flags.episode) return null;
  return path.join(env.ANIFACTORY_DATA_ROOT || DEFAULT_DATA_ROOT, "channels", flags.channel, "weekly_runs", flags.week, "episodes", flags.episode);
}

function scopeFromFlags(flags = {}) {
  const list = (...names) => [...new Set(names
    .flatMap((name) => String(flags[name] ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean))].sort();
  const ttsUnitIds = list(
    "confirmed-retry-unit-ids",
    "regenerate-unit-ids",
    "unit-ids",
    "stitch-repair-tail-unit-ids",
  );
  const ttsSpeakers = [...new Set(
    list("regenerate-speakers").map((value) => value.toUpperCase()),
  )].sort();
  const boundaryIds = list("boundary-ids", "boundary-id");
  return {
    cut_ids: list("cut-ids", "cut-id", "image-ids", "image-id", "only-cut-ids"),
    scene_ids: list("only-scenes", "scene-ids", "scene-id"),
    beat_ids: list("beat-ids", "beat-id"),
    planner_chunk_ids: list(
      "chunk-ids",
      "chunk-id",
      "semantic-chunk-ids",
      "semantic-chunk-id",
      "repair-chunk-ids",
      "performance-packet-ids",
      "performance-packet-id",
    ),
    reference_ids: list("reference-ids", "reference-id"),
    ...(ttsUnitIds.length ? { tts_unit_ids: ttsUnitIds } : {}),
    ...(ttsSpeakers.length ? { tts_speakers: ttsSpeakers } : {}),
    ...(boundaryIds.length ? { boundary_ids: boundaryIds } : {}),
    proof_start_sec: Number.isFinite(Number(flags["proof-start-sec"] ?? flags["scope-start-sec"]))
      ? Number(flags["proof-start-sec"] ?? flags["scope-start-sec"])
      : null,
    proof_end_sec: Number.isFinite(Number(flags["proof-end-sec"] ?? flags["scope-end-sec"]))
      ? Number(flags["proof-end-sec"] ?? flags["scope-end-sec"])
      : null,
    references_only: /^(true|1|yes)$/i.test(String(flags["references-only"] ?? "")),
  };
}

async function walkHashableFiles(root, current = root, out = {}) {
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (["node_modules", ".git", "assets", "reports"].includes(entry.name)) continue;
    const filePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkHashableFiles(root, filePath, out);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!HASHABLE_EXTENSIONS.has(ext) || entry.name === "execution_events.jsonl") continue;
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.size > 64 * 1024 * 1024) continue;
    out[path.relative(root, filePath)] = await fileSha256(filePath);
  }
  return out;
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 16 });
  return result.status === 0 ? String(result.stdout ?? "").trim() : null;
}

// Executing-code provenance for new execution events: the HEAD commit, the
// worktree it runs from and whether that worktree is dirty. Additive fields;
// events written before this existed simply lack them (legacy/unrecorded,
// never rewritten). Cached per process so one stage command spawns git once.
const gitProvenanceCache = new Map();
export function gitExecutionProvenance(repoRoot = MODULE_REPO_ROOT) {
  const key = path.resolve(repoRoot);
  if (gitProvenanceCache.has(key)) return gitProvenanceCache.get(key);
  const commit = git(["rev-parse", "HEAD"], key);
  const status = commit === null ? null : git(["status", "--porcelain=v1", "--untracked-files=all"], key);
  const provenance = Object.freeze({
    git_commit: commit,
    git_worktree: commit === null ? null : git(["rev-parse", "--show-toplevel"], key) ?? key,
    git_dirty: status === null ? null : status.length > 0,
  });
  gitProvenanceCache.set(key, provenance);
  return provenance;
}

export function resetGitExecutionProvenanceCacheForTests() {
  gitProvenanceCache.clear();
}

// The commit an identity was preflighted on. New identities record code_commit;
// identities from before that field carry it under git.commit. Neither present
// means a legacy identity, which the drift guard never touches.
export function identityCodeCommit(identity = null) {
  const value = identity?.code_commit ?? identity?.git?.commit ?? null;
  return typeof value === "string" && /^[0-9a-f]{7,40}$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/**
 * Ancestry rule, not equality: the executing HEAD must contain the identity's
 * commit. A missing identity commit is legacy and not applicable. An unknown
 * commit (not in this repository) counts as drift. `allowReasonCode` comes
 * from `--allow-code-drift <reason-code>` and is validated, never free prose.
 */
export function codeDriftDecision({ identity = null, repoRoot = MODULE_REPO_ROOT, allowReasonCode = null } = {}) {
  const identityCommit = identityCodeCommit(identity);
  if (!identityCommit) return { applicable: false, allowed: true, reason: "legacy_identity_without_code_commit", identity_commit: null, head_commit: null, ancestor: null, allow_reason_code: null };
  const head = gitExecutionProvenance(repoRoot).git_commit;
  if (!head) return { applicable: true, allowed: false, reason: "executing_worktree_has_no_git_head", identity_commit: identityCommit, head_commit: null, ancestor: null, allow_reason_code: null };
  const known = spawnSync("git", ["cat-file", "-e", `${identityCommit}^{commit}`], { cwd: repoRoot, encoding: "utf8" }).status === 0;
  const ancestor = known && spawnSync("git", ["merge-base", "--is-ancestor", identityCommit, head], { cwd: repoRoot, encoding: "utf8" }).status === 0;
  const reasonCode = allowReasonCode == null ? null : String(allowReasonCode).trim();
  if (ancestor) return { applicable: true, allowed: true, reason: "head_contains_identity_commit", identity_commit: identityCommit, head_commit: head, ancestor: true, allow_reason_code: null };
  if (reasonCode && CODE_DRIFT_REASON_CODE.test(reasonCode)) {
    return { applicable: true, allowed: true, reason: "code_drift_allowed_by_recorded_reason", identity_commit: identityCommit, head_commit: head, ancestor: false, allow_reason_code: reasonCode, unknown_commit: !known };
  }
  return {
    applicable: true,
    allowed: false,
    reason: reasonCode ? "invalid_code_drift_reason_code" : (known ? "head_does_not_contain_identity_commit" : "identity_commit_unknown_to_repository"),
    identity_commit: identityCommit,
    head_commit: head,
    ancestor: false,
    allow_reason_code: reasonCode || null,
    unknown_commit: !known,
  };
}

// Append-only drift record written beside the stage_started event when an
// operator passed a valid --allow-code-drift reason. The identity is never
// rewritten; the workflow contract hash is rechecked against the live registry.
export async function appendCodeDriftEvent({ episodeDir, identity = null, decision, execution = null, repoRoot = MODULE_REPO_ROOT }) {
  if (!episodeDir || !decision?.applicable || decision.ancestor !== false || !decision.allow_reason_code) return null;
  const diffPaths = decision.unknown_commit
    ? null
    : (git(["diff", "--name-only", `${decision.identity_commit}..${decision.head_commit}`], repoRoot) ?? "").split("\n").filter(Boolean).slice(0, 500);
  let contractRecheck = null;
  if (identity?.workflow_contract?.sha256) {
    try {
      // resolveMediaWorkflow recomputes the canonical contract hash from the live
      // registry and throws when the recorded sha256 no longer matches it.
      resolveMediaWorkflow(identity);
      contractRecheck = { recorded_sha256: identity.workflow_contract.sha256, matches: true };
    } catch (error) {
      contractRecheck = { recorded_sha256: identity.workflow_contract.sha256, matches: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const row = {
    schema: CODE_DRIFT_EVENT_SCHEMA,
    event_type: "code_drift",
    execution_id: execution?.execution_id ?? null,
    stage: execution?.stage ?? null,
    command: execution?.command ?? null,
    identity_commit: decision.identity_commit,
    head_commit: decision.head_commit,
    identity_commit_known: decision.unknown_commit !== true,
    ...gitExecutionProvenance(repoRoot),
    diff_paths: diffPaths,
    diff_path_count: diffPaths?.length ?? null,
    reason_code: decision.allow_reason_code,
    workflow_contract_recheck: contractRecheck,
    recorded_at: new Date().toISOString(),
  };
  await appendJsonLine(path.join(episodeDir, "execution_events.jsonl"), row);
  return row;
}

async function appendJsonLine(filePath, row) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

async function readEvents(filePath) {
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function changedHashes(before = {}, after = {}) {
  return Object.fromEntries(Object.entries(after).filter(([name, hash]) => before[name] !== hash));
}

async function costAndReuseFromOutputs(episodeDir, outputHashes) {
  let costUsd = 0;
  let cacheReuseCount = 0;
  for (const relativePath of Object.keys(outputHashes)) {
    if (path.extname(relativePath) !== ".json") continue;
    const row = await fs.readFile(path.join(episodeDir, relativePath), "utf8").then(JSON.parse).catch(() => null);
    const cost = row?.estimated_cost?.current_batch?.estimated_cost_usd
      ?? row?.estimated_cost?.estimated_cost_usd
      ?? row?.current_batch_cost?.estimated_cost_usd
      ?? row?.current_batch_cost_usd
      ?? row?.batch_cost_usd
      ?? 0;
    if (Number.isFinite(Number(cost))) costUsd += Number(cost);
    cacheReuseCount += Number(
      row?.current_batch_cache_reuse_count
      ?? row?.cache_reuse_count
      ?? row?.render_motion?.motion_clip_cache_reused_count
      ?? 0,
    ) || 0;
  }
  return { cost_usd: Number(costUsd.toFixed(6)), cache_reuse_count: cacheReuseCount };
}

function imagegenBatchCost(report = {}) {
  return Number(
    report?.current_batch_cost?.estimated_cost_usd
    ?? report?.estimated_cost?.current_batch?.estimated_cost_usd
    ?? report?.estimated_cost?.estimated_cost_usd
    ?? 0,
  ) || 0;
}

function imagegenBatchGeneratedCount(report = {}) {
  return Number(
    report?.current_batch_cost?.generated_count
    ?? report?.current_batch_image_count
    ?? report?.current_batch_results?.filter?.((row) => String(row?.status ?? "").toLowerCase() === "generated")?.length
    ?? 0,
  ) || 0;
}

async function immutableImagegenBatchSummary(episodeDir) {
  const batchDir = path.join(episodeDir, "reports", "imagegen-batches");
  const names = await fs.readdir(batchDir).catch(() => []);
  const batches = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    const filePath = path.join(batchDir, name);
    const report = await fs.readFile(filePath, "utf8").then(JSON.parse).catch(() => null);
    if (report?.schema !== "goldflow_imagegen_batch_report_v1") continue;
    const status = String(report.current_batch_status ?? report.status ?? "unknown").toLowerCase();
    batches.push({
      batch_id: report.batch_id ?? path.basename(name, ".json"),
      batch_kind: report.batch_kind ?? "unknown",
      status,
      generated_count: imagegenBatchGeneratedCount(report),
      estimated_cost_usd: Number(imagegenBatchCost(report).toFixed(6)),
      wall_time_sec: Number(Number(report.wall_time_sec ?? 0).toFixed(3)),
      provider: report.image_provider ?? null,
      report_path: filePath,
      report_sha256: await fileSha256(filePath),
    });
  }

  const byKind = {};
  for (const batch of batches) {
    const key = batch.batch_kind;
    const current = byKind[key] ?? {
      batch_count: 0,
      passed_batch_count: 0,
      failed_batch_count: 0,
      generated_count: 0,
      estimated_cost_usd: 0,
      wall_time_sec: 0,
    };
    current.batch_count += 1;
    if (batch.status === "passed") current.passed_batch_count += 1;
    if (batch.status === "failed") current.failed_batch_count += 1;
    current.generated_count += batch.generated_count;
    current.estimated_cost_usd += batch.estimated_cost_usd;
    current.wall_time_sec += batch.wall_time_sec;
    byKind[key] = current;
  }
  for (const value of Object.values(byKind)) {
    value.estimated_cost_usd = Number(value.estimated_cost_usd.toFixed(6));
    value.wall_time_sec = Number(value.wall_time_sec.toFixed(3));
  }

  return {
    batch_count: batches.length,
    passed_batch_count: batches.filter((row) => row.status === "passed").length,
    failed_batch_count: batches.filter((row) => row.status === "failed").length,
    // Legacy field includes historical `scoped_scene_retry` labels. New runs
    // call these exact-ID repairs and never auto-resubmit a passed/failed batch.
    scoped_retry_batch_count: batches.filter((row) => /scoped_.*(?:retry|repair)/i.test(row.batch_kind)).length,
    scoped_repair_batch_count: batches.filter((row) => /scoped_.*(?:retry|repair)/i.test(row.batch_kind)).length,
    automatic_retry_batch_count: 0,
    generated_count: batches.reduce((sum, row) => sum + row.generated_count, 0),
    estimated_cost_usd: Number(batches.reduce((sum, row) => sum + row.estimated_cost_usd, 0).toFixed(6)),
    wall_time_sec: Number(batches.reduce((sum, row) => sum + row.wall_time_sec, 0).toFixed(3)),
    by_kind: byKind,
    batches,
  };
}

function isImagegenExecution(event = {}) {
  return /^imagegen(?:\s|$)/i.test(String(event.command ?? ""));
}

const CALL_RECEIPT_SCHEMA = "goldflow_codex_call_metadata_v1";
const ATTEMPT_SIDECAR = /\.attempt-\d+\.meta\.json$/;
async function walkCallReceipts(root, current = root, out = []) {
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (["node_modules", ".git", "assets"].includes(entry.name)) continue;
    const filePath = path.join(current, entry.name);
    if (entry.isDirectory()) { await walkCallReceipts(root, filePath, out); continue; }
    if (!entry.name.endsWith(".meta.json") || ATTEMPT_SIDECAR.test(entry.name)) continue;
    out.push(filePath);
  }
  return out;
}

/**
 * Planner/CLI call receipts written since `startedAt`: calls, attempts and
 * transport retries per provider, token usage summed per usage key, and the
 * billed cost field (Claude) summed. Subscription CLIs contribute tokens only
 * (cost null); nothing here is projected.
 */
export async function providerCallUsageSince(episodeDir, startedAt) {
  const since = Date.parse(startedAt);
  const byProvider = {};
  let costUsd = 0;
  let callCount = 0;
  for (const filePath of await walkCallReceipts(episodeDir)) {
    const receipt = await fs.readFile(filePath, "utf8").then(JSON.parse).catch(() => null);
    if (receipt?.schema !== CALL_RECEIPT_SCHEMA) continue;
    const started = Date.parse(receipt.started_at ?? "");
    if (!Number.isFinite(started) || started < since) continue;
    const provider = String(receipt.provider ?? "unknown");
    const row = byProvider[provider] ??= { calls: 0, passed: 0, failed: 0, attempts: 0, transport_retries: 0, usage_totals: {}, cost_usd: null, cost_recorded_calls: 0 };
    row.calls += 1;
    callCount += 1;
    row[receipt.status === "passed" ? "passed" : "failed"] += 1;
    const attempts = Array.isArray(receipt.attempts) && receipt.attempts.length ? receipt.attempts : [{ class: receipt.status === "passed" ? "passed" : "failure" }];
    row.attempts += attempts.length;
    row.transport_retries += attempts.filter((attempt) => attempt.class === "transport").length;
    for (const [key, value] of Object.entries(receipt.provider_usage ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) row.usage_totals[key] = (row.usage_totals[key] ?? 0) + value;
    }
    const cost = Number(receipt.provider_cost_usd);
    if (receipt.provider_cost_usd != null && Number.isFinite(cost)) {
      row.cost_usd = Number(((row.cost_usd ?? 0) + cost).toFixed(6));
      row.cost_recorded_calls += 1;
      costUsd += cost;
    }
  }
  return { call_count: callCount, by_provider: byProvider, cost_usd: Number(costUsd.toFixed(6)), cost_basis: costUsd > 0 ? "billed" : "unrecorded" };
}

const FAL_SUBMISSION_RECEIPT = /^fal\/.*submission-receipts\/[^/]+\.json$/;
async function falExecutionCost(episodeDir, execution, newRelativePaths) {
  if (!/^imagegen fal(?:\s|$)/i.test(String(execution.command ?? ""))) return null;
  const receiptPaths = newRelativePaths.filter((relativePath) => FAL_SUBMISSION_RECEIPT.test(relativePath.split(path.sep).join("/")));
  if (!receiptPaths.length) return { new_submissions: 0, usd: 0, cost_basis: "none" };
  const { falBilledRateState, falSubmissionCostState } = await import("./fal-retry-budget.mjs");
  const rows = [];
  for (const relativePath of receiptPaths) {
    const receipt = await fs.readFile(path.join(episodeDir, relativePath), "utf8").then(JSON.parse).catch(() => null);
    if (receipt?.schema !== "goldflow_fal_submission_receipt_v1") continue;
    rows.push({ request_id: receipt.request_id, endpoint: receipt.endpoint ?? null, image_size: receipt.params?.image_size ?? null });
  }
  const state = falSubmissionCostState(rows, await falBilledRateState(episodeDir));
  return { new_submissions: rows.length, usd: state.total_usd, cost_basis: state.cost_basis, rate_sources: state.rate_sources };
}

function combinedCostBasis(parts) {
  const bases = new Set(parts.filter(Boolean));
  if (!bases.size) return "none";
  if (bases.size === 1) return [...bases][0];
  return "mixed";
}

export async function beginStageExecution({ stage, command, flags = {}, args = [], env = process.env, repoRoot = MODULE_REPO_ROOT, codeDrift = null, workflowBypass = null }) {
  const episodeDir = episodeDirForFlags(flags, env);
  const provenance = gitExecutionProvenance(repoRoot);
  const now = new Date();
  const scope = scopeFromFlags(flags);
  const scopeHash = sha256(JSON.stringify(scope));
  const eventPath = episodeDir ? path.join(episodeDir, "execution_events.jsonl") : null;
  const episodeExists = Boolean(episodeDir && await fs.stat(episodeDir).catch(() => null));
  const priorEvents = eventPath && episodeExists ? await readEvents(eventPath) : [];
  const attempt = priorEvents.filter((row) => row.event_type === "stage_started" && row.stage === stage && row.scope_sha256 === scopeHash).length + 1;
  const execution = {
    execution_id: randomUUID(),
    stage,
    command,
    args,
    flags,
    scope,
    scope_sha256: scopeHash,
    attempt,
    episode_dir: episodeDir,
    started_at: now.toISOString(),
    started_ms: now.getTime(),
    input_hashes: episodeDir && await fs.stat(episodeDir).catch(() => null) ? await walkHashableFiles(episodeDir) : {},
    provider: flags["image-provider"] ?? flags.provider ?? flags["score-provider"] ?? null,
    model: flags.model ?? flags["planning-model"] ?? env.ANIFACTORY_IMAGE_MODEL ?? env.ANIFACTORY_CODEX_MODEL ?? null,
    ...provenance,
    code_drift: codeDrift && codeDrift.applicable
      ? { identity_commit: codeDrift.identity_commit, head_commit: codeDrift.head_commit, ancestor: codeDrift.ancestor, allow_reason_code: codeDrift.allow_reason_code ?? null }
      : null,
    // Structured bypass record (R07): only new events carry it; historical
    // events with prose reasons stay readable and are never backfilled.
    workflow_bypass: workflowBypass ?? null,
    started_event_written: false,
  };
  if (eventPath && episodeExists) {
    await appendJsonLine(eventPath, {
      schema: "goldflow_execution_event_v1",
      event_type: "stage_started",
      ...execution,
      started_ms: undefined,
      started_event_written: undefined,
    });
    execution.started_event_written = true;
  }
  return execution;
}

export async function finishStageExecution(execution, {
  exitCode,
  signal = null,
  error = null,
  stdoutTail = null,
  stderrTail = null,
  env = process.env,
} = {}) {
  let episodeDir = execution.episode_dir;
  if (!episodeDir) episodeDir = episodeDirForFlags(execution.flags, env);
  if (!episodeDir || !(await fs.stat(episodeDir).catch(() => null))) return null;
  const completedAt = new Date();
  const outputSnapshot = await walkHashableFiles(episodeDir);
  const changed = changedHashes(execution.input_hashes, outputSnapshot);
  const outputHashes = Object.fromEntries(
    Object.entries(changed).filter(([relativePath]) => stageOutputPathMatches(execution.stage, relativePath)),
  );
  const cost = await costAndReuseFromOutputs(episodeDir, outputHashes);
  // Real cost recording (R02): billed CLI cost from call receipts written during this
  // execution plus billed-or-projected Fal cost of submissions it created. Additive fields;
  // historical events without them are never rewritten.
  const providerCalls = await providerCallUsageSince(episodeDir, execution.started_at);
  const falCost = await falExecutionCost(episodeDir, execution, Object.keys(changed).filter((relativePath) => !(relativePath in execution.input_hashes)));
  const costUsd = Number((cost.cost_usd + providerCalls.cost_usd + (falCost?.usd ?? 0)).toFixed(6));
  const costBasis = combinedCostBasis([
    cost.cost_usd > 0 ? "projected" : null,
    providerCalls.cost_usd > 0 ? "billed" : null,
    falCost && falCost.usd > 0 ? falCost.cost_basis : null,
  ]);
  const report = {
    schema: "goldflow_stage_execution_report_v1",
    status: exitCode === 0 ? "passed" : "failed",
    execution_id: execution.execution_id,
    stage: execution.stage,
    command: execution.command,
    scope: execution.scope,
    scope_sha256: execution.scope_sha256,
    attempt: execution.attempt,
    provider: execution.provider,
    model: execution.model,
    git_commit: execution.git_commit ?? null,
    git_worktree: execution.git_worktree ?? null,
    git_dirty: execution.git_dirty ?? null,
    code_drift: execution.code_drift ?? null,
    workflow_bypass: execution.workflow_bypass ?? null,
    input_hashes: execution.input_hashes,
    output_hashes: outputHashes,
    exit_code: exitCode,
    signal,
    error,
    stdout_tail: stdoutTail || null,
    stderr_tail: stderrTail || null,
    wall_time_sec: Number(((completedAt.getTime() - execution.started_ms) / 1000).toFixed(3)),
    cost_usd: costUsd,
    cost_basis: costBasis,
    provider_calls: providerCalls,
    fal_cost: falCost,
    cache_reuse_count: cost.cache_reuse_count,
    started_at: execution.started_at,
    completed_at: completedAt.toISOString(),
  };
  const reportDir = path.join(episodeDir, "reports", "stages", execution.stage);
  const reportPath = path.join(reportDir, `${safeTimestamp(completedAt)}-${execution.execution_id}.json`);
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const eventPath = path.join(episodeDir, "execution_events.jsonl");
  if (!execution.started_event_written) {
    await appendJsonLine(eventPath, {
      schema: "goldflow_execution_event_v1",
      event_type: "stage_started",
      execution_id: execution.execution_id,
      stage: execution.stage,
      command: execution.command,
      args: execution.args,
      flags: execution.flags,
      scope: execution.scope,
      scope_sha256: execution.scope_sha256,
      attempt: execution.attempt,
      episode_dir: episodeDir,
      started_at: execution.started_at,
      input_hashes: execution.input_hashes,
      provider: execution.provider,
      model: execution.model,
      git_commit: execution.git_commit ?? null,
      git_worktree: execution.git_worktree ?? null,
      git_dirty: execution.git_dirty ?? null,
      code_drift: execution.code_drift ?? null,
      workflow_bypass: execution.workflow_bypass ?? null,
    });
  }
  await appendJsonLine(eventPath, {
    schema: "goldflow_execution_event_v1",
    event_type: "stage_completed",
    ...report,
    immutable_report_path: reportPath,
  });
  // Billed CLI cost counts against the locked episode budget through the gates'
  // append-only spend ledger (Fal spend is read from its own receipts there).
  if (providerCalls.cost_usd > 0) {
    const identity = await fs.readFile(path.join(episodeDir, "run_identity.json"), "utf8").then(JSON.parse).catch(() => null);
    const { episodeBudgetFor, recordEpisodeSpend } = await import("./episode-budget.mjs");
    if (episodeBudgetFor(identity ?? {})) {
      for (const [provider, row] of Object.entries(providerCalls.by_provider)) {
        if (!(row.cost_usd > 0)) continue;
        await recordEpisodeSpend({ episodeDir, provider, usd: row.cost_usd, scope: `${execution.stage}_${String(execution.execution_id).slice(0, 8)}`, receipt: reportPath, costBasis: "billed" });
      }
    }
  }
  await materializeProductionManifest(episodeDir);
  return { ...report, immutable_report_path: reportPath };
}

export async function materializeProductionManifest(episodeDir) {
  const eventPath = path.join(episodeDir, "execution_events.jsonl");
  const events = await readEvents(eventPath);
  const completed = events.filter((row) => row.event_type === "stage_completed");
  const latestByStage = {};
  for (const event of completed) latestByStage[event.stage] = event;
  const cutLedgerPath = path.join(episodeDir, "cut_execution_ledger.json");
  const cutLedger = await fs.readFile(cutLedgerPath, "utf8").then(JSON.parse).catch(() => null);
  const imagegenBatches = await immutableImagegenBatchSummary(episodeDir);
  const eventRecordedCostUsd = completed.reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);
  const imagegenEventRecordedCostUsd = completed
    .filter(isImagegenExecution)
    .reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);
  const nonImagegenEventCostUsd = eventRecordedCostUsd - imagegenEventRecordedCostUsd;
  const authoritativeImagegenCostUsd = imagegenBatches.batch_count > 0
    ? imagegenBatches.estimated_cost_usd
    : imagegenEventRecordedCostUsd;
  const latestFailures = Object.values(latestByStage).filter((row) => row.status === "failed");
  const historicalFailures = completed.filter((row) => row.status === "failed");
  const finalQaPassed = latestByStage.final_qa?.status === "passed";
  const manifestStatus = finalQaPassed
    ? (historicalFailures.length ? "completed_with_retries" : "completed")
    : latestFailures.length
      ? "blocked"
      : historicalFailures.length
        ? "active_with_retries"
        : "active";
  const cuts = Array.isArray(cutLedger?.cuts) ? cutLedger.cuts : [];
  const cutsWithImages = cuts.filter((row) => row?.image_path && row?.image_sha256);
  const cutsWithPassedQa = cutsWithImages.filter((row) => /^(?:passed|accepted)/i.test(String(row?.image_qa_status ?? "")));
  const pendingQaCuts = cutsWithImages.filter((row) => !/^(?:passed|accepted)/i.test(String(row?.image_qa_status ?? "")));
  const recoveredImportCuts = cutsWithPassedQa.filter((row) => String(row?.generation_status ?? "").toLowerCase() === "failed");
  const derivedCutStatus = cuts.length && cutsWithImages.length === cuts.length
    ? (cutsWithPassedQa.length === cuts.length ? "passed" : "images_complete_qa_pending")
    : (cuts.length ? "partial" : (cutLedger?.status ?? "unknown"));
  const manifest = {
    schema: "goldflow_production_manifest_v1",
    status: manifestStatus,
    execution_event_path: eventPath,
    stage_latest: Object.fromEntries(Object.entries(latestByStage).map(([stage, row]) => [stage, {
      status: row.status,
      execution_id: row.execution_id,
      attempt: row.attempt,
      scope_sha256: row.scope_sha256,
      immutable_report_path: row.immutable_report_path,
      completed_at: row.completed_at,
    }])),
    telemetry: {
      total_stage_calls: completed.length,
      failed_stage_calls: historicalFailures.length,
      unresolved_latest_stage_failures: latestFailures.length,
      retry_calls: completed.filter((row) => Number(row.attempt ?? 1) > 1).length,
      same_scope_retry_calls: completed.filter((row) => Number(row.attempt ?? 1) > 1).length,
      scoped_execution_calls: completed.filter((row) => [
        ...(row.scope?.cut_ids ?? []),
        ...(row.scope?.scene_ids ?? []),
        ...(row.scope?.beat_ids ?? []),
        ...(row.scope?.planner_chunk_ids ?? []),
        ...(row.scope?.reference_ids ?? []),
        ...(row.scope?.tts_unit_ids ?? []),
        ...(row.scope?.tts_speakers ?? []),
      ].length > 0).length,
      manual_image_import_calls: completed.filter((row) => /^imagegen import-(?:codex|staged-codex)$/i.test(String(row.command ?? ""))).length,
      total_wall_time_sec: Number(completed.reduce((sum, row) => sum + Number(row.wall_time_sec ?? 0), 0).toFixed(3)),
      cumulative_cost_usd: Number((nonImagegenEventCostUsd + authoritativeImagegenCostUsd).toFixed(6)),
      event_recorded_cost_usd: Number(eventRecordedCostUsd.toFixed(6)),
      provider_call_cost_usd: Number(completed.reduce((sum, row) => sum + Number(row.provider_calls?.cost_usd ?? 0), 0).toFixed(6)),
      provider_call_count: completed.reduce((sum, row) => sum + Number(row.provider_calls?.call_count ?? 0), 0),
      imagegen_event_recorded_cost_usd: Number(imagegenEventRecordedCostUsd.toFixed(6)),
      imagegen_batch_cost_usd: Number(imagegenBatches.estimated_cost_usd.toFixed(6)),
      cache_reuse_count: completed.reduce((sum, row) => sum + Number(row.cache_reuse_count ?? 0), 0),
    },
    imagegen_batches: imagegenBatches,
    cut_execution: cutLedger ? {
      ledger_path: cutLedgerPath,
      ledger_sha256: await fileSha256(cutLedgerPath),
      status: derivedCutStatus,
      cut_count: Number(cutLedger.cut_count ?? cuts.length ?? 0),
      completed_image_count: cutsWithImages.length,
      accepted_image_count: cutsWithPassedQa.length,
      pending_image_qa_count: pendingQaCuts.length,
      recovered_manual_import_count: recoveredImportCuts.length,
      ledger_reported_status: cutLedger.status ?? "unknown",
      ledger_reported_completed_image_count: Number(cutLedger.completed_image_count ?? 0),
      ledger_reported_pending_image_qa_count: Number(cutLedger.pending_image_qa_count ?? 0),
    } : null,
    updated_at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(episodeDir, "production_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const episodeReportDir = path.join(episodeDir, "reports", "episode");
  await fs.mkdir(episodeReportDir, { recursive: true });
  await fs.writeFile(path.join(episodeReportDir, "episode_execution_summary.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export { changedHashes as changedExecutionHashesForTests, scopeFromFlags as executionScopeForTests };
