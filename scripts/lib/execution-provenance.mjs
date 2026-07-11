import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_DATA_ROOT = "/Users/joel/AniFactoryData";
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
  const list = (name) => String(flags[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return {
    cut_ids: list("cut-ids"),
    scene_ids: list("only-scenes"),
    reference_ids: list("reference-ids"),
    proof_start_sec: Number.isFinite(Number(flags["proof-start-sec"])) ? Number(flags["proof-start-sec"]) : null,
    proof_end_sec: Number.isFinite(Number(flags["proof-end-sec"])) ? Number(flags["proof-end-sec"]) : null,
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
      ?? row?.current_batch_cost_usd
      ?? row?.batch_cost_usd
      ?? 0;
    if (Number.isFinite(Number(cost))) costUsd += Number(cost);
    cacheReuseCount += Number(row?.current_batch_cache_reuse_count ?? row?.cache_reuse_count ?? 0) || 0;
  }
  return { cost_usd: Number(costUsd.toFixed(6)), cache_reuse_count: cacheReuseCount };
}

export async function beginStageExecution({ stage, command, flags = {}, args = [], env = process.env }) {
  const episodeDir = episodeDirForFlags(flags, env);
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

export async function finishStageExecution(execution, { exitCode, signal = null, error = null, env = process.env } = {}) {
  let episodeDir = execution.episode_dir;
  if (!episodeDir) episodeDir = episodeDirForFlags(execution.flags, env);
  if (!episodeDir || !(await fs.stat(episodeDir).catch(() => null))) return null;
  const completedAt = new Date();
  const outputSnapshot = await walkHashableFiles(episodeDir);
  const outputHashes = changedHashes(execution.input_hashes, outputSnapshot);
  const cost = await costAndReuseFromOutputs(episodeDir, outputHashes);
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
    input_hashes: execution.input_hashes,
    output_hashes: outputHashes,
    exit_code: exitCode,
    signal,
    error,
    wall_time_sec: Number(((completedAt.getTime() - execution.started_ms) / 1000).toFixed(3)),
    cost_usd: cost.cost_usd,
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
    });
  }
  await appendJsonLine(eventPath, {
    schema: "goldflow_execution_event_v1",
    event_type: "stage_completed",
    ...report,
    immutable_report_path: reportPath,
  });
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
  const manifest = {
    schema: "goldflow_production_manifest_v1",
    status: completed.some((row) => row.status === "failed") ? "has_failures" : "active",
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
      failed_stage_calls: completed.filter((row) => row.status === "failed").length,
      retry_calls: completed.filter((row) => Number(row.attempt ?? 1) > 1).length,
      total_wall_time_sec: Number(completed.reduce((sum, row) => sum + Number(row.wall_time_sec ?? 0), 0).toFixed(3)),
      cumulative_cost_usd: Number(completed.reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0).toFixed(6)),
      cache_reuse_count: completed.reduce((sum, row) => sum + Number(row.cache_reuse_count ?? 0), 0),
    },
    cut_execution: cutLedger ? {
      ledger_path: cutLedgerPath,
      ledger_sha256: await fileSha256(cutLedgerPath),
      status: cutLedger.status ?? "unknown",
      cut_count: Number(cutLedger.cut_count ?? cutLedger.cuts?.length ?? 0),
      completed_image_count: Number(cutLedger.completed_image_count ?? 0),
      pending_image_qa_count: Number(cutLedger.pending_image_qa_count ?? 0),
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
