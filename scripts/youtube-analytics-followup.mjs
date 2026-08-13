#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib/file-hash.mjs";
import {
  YOUTUBE_ANALYTICS_AGGREGATE_SCHEMA,
  YOUTUBE_ANALYTICS_FOLLOWUP_PLAN_SCHEMA,
  YOUTUBE_ANALYTICS_SNAPSHOT_SCHEMA,
  analyticsDirectorFeedback,
  analyticsSnapshotContentSha256,
  buildYoutubeAnalyticsFollowupPlan,
  validateYoutubeAnalyticsSnapshot,
} from "./lib/youtube-analytics-followup-contract.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const action = process.argv[2] ?? "status";
const flags = parseFlags(process.argv.slice(3));

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

function clean(value) {
  return String(value ?? "").trim();
}

function required(name, value) {
  if (!clean(value)) throw new Error(`Missing required --${name}.`);
}

async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return null; }
}

async function writeJson(filePath, value, { exclusive = false } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (exclusive) {
    const handle = await fs.open(filePath, "wx");
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); } finally { await handle.close(); }
    return;
  }
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

function episodeDirectory() {
  if (flags["episode-dir"]) return path.resolve(flags["episode-dir"]);
  required("channel", flags.channel);
  required("week", flags.week);
  required("episode", flags.episode);
  return path.join(dataRoot, "channels", flags.channel, "weekly_runs", flags.week, "episodes", flags.episode);
}

async function context() {
  const episodeDir = episodeDirectory();
  const identity = await readJson(path.join(episodeDir, "run_identity.json"));
  if (!identity) throw new Error(`Missing run identity in ${episodeDir}`);
  return { episodeDir, episode: flags.episode ?? identity.episode ?? path.basename(episodeDir) };
}

export async function createAnalyticsFollowupPlanForUpload({ episodeDir, episode, anchorAt = null } = {}) {
  const uploadReceiptPath = path.join(episodeDir, `youtube_upload_receipt_${episode}.json`);
  const planPath = path.join(episodeDir, `youtube_analytics_followup_plan_${episode}.json`);
  const [uploadReceipt, uploadReceiptSha256, existing] = await Promise.all([
    readJson(uploadReceiptPath),
    sha256File(uploadReceiptPath).catch(() => null),
    readJson(planPath),
  ]);
  if (!uploadReceipt || !uploadReceiptSha256) throw new Error(`Passed upload receipt required: ${uploadReceiptPath}`);
  if (existing?.upload_receipt_sha256 === uploadReceiptSha256 && (!anchorAt || existing.analytics_anchor_at)) return { planPath, plan: existing, reused: true };
  const snapshots = (await fs.readdir(episodeDir).catch(() => []))
    .filter((name) => name.startsWith(`youtube_analytics_snapshot_${episode}_`));
  if (snapshots.length) throw new Error("Refusing to replace the analytics follow-up plan after snapshots exist.");
  const plan = buildYoutubeAnalyticsFollowupPlan({
    episode,
    uploadReceiptPath,
    uploadReceiptSha256,
    uploadReceipt,
    anchorAt,
  });
  await writeJson(planPath, plan);
  return { planPath, plan, reused: false };
}

async function planFollowups() {
  const { episodeDir, episode } = await context();
  const result = await createAnalyticsFollowupPlanForUpload({
    episodeDir,
    episode,
    anchorAt: clean(flags["anchor-at"]) || null,
  });
  console.log(JSON.stringify({
    status: result.plan.status,
    plan_path: result.planPath,
    analytics_anchor_at: result.plan.analytics_anchor_at,
    checkpoints: result.plan.checkpoints,
    reused: result.reused,
  }, null, 2));
}

async function recordSnapshot() {
  const { episodeDir, episode } = await context();
  required("window", flags.window);
  required("metrics", flags.metrics);
  required("captured-by", flags["captured-by"]);
  const planPath = path.join(episodeDir, `youtube_analytics_followup_plan_${episode}.json`);
  const metricsPath = path.resolve(flags.metrics);
  const [plan, planSha256, metrics, metricsSha256] = await Promise.all([
    readJson(planPath),
    sha256File(planPath).catch(() => null),
    readJson(metricsPath),
    sha256File(metricsPath).catch(() => null),
  ]);
  if (!plan || plan.schema !== YOUTUBE_ANALYTICS_FOLLOWUP_PLAN_SCHEMA || plan.status !== "scheduled") {
    throw new Error(`Scheduled analytics follow-up plan required: ${planPath}`);
  }
  if (!metrics || !metricsSha256) throw new Error(`Metrics JSON missing or invalid: ${metricsPath}`);
  const windowId = clean(flags.window).toLowerCase();
  const checkpoint = plan.checkpoints.find((row) => row.id === windowId);
  if (!checkpoint) throw new Error(`Unknown analytics window: ${windowId}`);
  const capturedAt = clean(flags["captured-at"]) || new Date().toISOString();
  const snapshotPath = path.join(episodeDir, `youtube_analytics_snapshot_${episode}_${windowId}.json`);
  const snapshot = {
    schema: YOUTUBE_ANALYTICS_SNAPSHOT_SCHEMA,
    status: "passed",
    episode,
    video_id: plan.video_id,
    window: windowId,
    due_at: checkpoint.due_at,
    captured_at: capturedAt,
    timing_delta_hours: Number(((new Date(capturedAt).getTime() - new Date(checkpoint.due_at).getTime()) / 3_600_000).toFixed(3)),
    followup_plan_path: planPath,
    followup_plan_sha256: planSha256,
    upload_receipt_path: plan.upload_receipt_path,
    upload_receipt_sha256: plan.upload_receipt_sha256,
    metrics_source_path: metricsPath,
    metrics_source_sha256: metricsSha256,
    metrics,
    director_feedback: analyticsDirectorFeedback(metrics),
    captured_by: clean(flags["captured-by"]),
    note: clean(flags.note) || null,
  };
  snapshot.snapshot_content_sha256 = analyticsSnapshotContentSha256(snapshot);
  const validation = validateYoutubeAnalyticsSnapshot(snapshot, { plan, planSha256 });
  if (validation.status !== "passed") {
    console.log(JSON.stringify({ status: "blocked", blockers: validation.blockers }, null, 2));
    process.exitCode = 2;
    return;
  }
  await writeJson(snapshotPath, snapshot, { exclusive: true });
  console.log(JSON.stringify({ status: "passed", snapshot_path: snapshotPath, window: windowId }, null, 2));
}

async function showStatus() {
  const { episodeDir, episode } = await context();
  const planPath = path.join(episodeDir, `youtube_analytics_followup_plan_${episode}.json`);
  const plan = await readJson(planPath);
  if (!plan) throw new Error(`Analytics follow-up plan missing: ${planPath}`);
  const now = Date.now();
  const checkpoints = await Promise.all(plan.checkpoints.map(async (checkpoint) => {
    const snapshotPath = path.join(episodeDir, `youtube_analytics_snapshot_${episode}_${checkpoint.id}.json`);
    const snapshot = await readJson(snapshotPath);
    return {
      ...checkpoint,
      state: snapshot ? "captured" : checkpoint.due_at && new Date(checkpoint.due_at).getTime() <= now ? "due" : checkpoint.state,
      snapshot_path: snapshot ? snapshotPath : null,
    };
  }));
  console.log(JSON.stringify({ status: plan.status, plan_path: planPath, non_blocking: true, checkpoints }, null, 2));
}

function average(rows, key) {
  const values = rows.map((row) => Number(row.metrics?.[key])).filter(Number.isFinite);
  return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)) : null;
}

async function aggregateSnapshots() {
  const inputPaths = clean(flags.inputs).split(",").map(clean).filter(Boolean).map(path.resolve);
  if (!inputPaths.length) throw new Error("analytics followup-aggregate requires --inputs <snapshot.json,...>.");
  const snapshots = await Promise.all(inputPaths.map(readJson));
  if (snapshots.some((row) => row?.schema !== YOUTUBE_ANALYTICS_SNAPSHOT_SCHEMA || row?.status !== "passed")) {
    throw new Error("Every aggregate input must be a passed analytics snapshot.");
  }
  const outputPath = path.resolve(flags.output ?? "youtube_analytics_feedback_aggregate.json");
  const metricKeys = [
    "impressions", "browse_ctr_percent", "suggested_ctr_percent",
    "first_30_sec_retention_percent", "first_60_sec_retention_percent",
    "average_view_duration_sec", "average_percentage_viewed",
    "new_viewers_percent", "returning_viewers_percent",
  ];
  const aggregate = {
    schema: YOUTUBE_ANALYTICS_AGGREGATE_SCHEMA,
    status: "passed",
    non_blocking: true,
    policy: "Cross-upload evidence only. Directors may use repeated patterns; no single snapshot changes defaults automatically.",
    input_paths: inputPaths,
    input_sha256: Object.fromEntries(await Promise.all(inputPaths.map(async (filePath) => [filePath, await sha256File(filePath)]))),
    snapshot_count: snapshots.length,
    video_count: new Set(snapshots.map((row) => row.video_id)).size,
    by_window: Object.fromEntries(["24h", "72h", "7d"].map((window) => {
      const rows = snapshots.filter((row) => row.window === window);
      return [window, {
        sample_count: rows.length,
        averages: Object.fromEntries(metricKeys.map((key) => [key, average(rows, key)])),
      }];
    })),
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, aggregate);
  console.log(JSON.stringify({ status: "passed", output_path: outputPath, snapshot_count: snapshots.length }, null, 2));
}

async function main() {
  if (action === "plan") return planFollowups();
  if (action === "record") return recordSnapshot();
  if (action === "status") return showStatus();
  if (action === "aggregate") return aggregateSnapshots();
  throw new Error(`Unknown analytics follow-up action: ${action}`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
