#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const action = args[0] ?? "ingest";
const flags = parseFlags(args.slice(1));
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return fallback; }
}

async function hashFile(filePath) {
  return fs.readFile(filePath).then(sha256).catch(() => null);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  row.push(field.replace(/\r$/, ""));
  if (row.some((value) => value.trim())) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0].map((value) => value.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function normalizedKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function normalizedObject(row = {}) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizedKey(key), value]));
}

function numberValue(value) {
  const cleaned = String(value ?? "").replace(/[,%]/g, "").trim();
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function timeValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function firstValue(row, keys) {
  for (const key of keys) if (row[key] !== undefined && String(row[key]).trim() !== "") return row[key];
  return null;
}

export function normalizeRetentionRowsForTests(rows = [], durationSec) {
  const normalized = [];
  for (const source of rows) {
    const row = normalizedObject(source);
    const directTime = timeValue(firstValue(row, ["elapsed_sec", "timestamp_sec", "time_sec", "elapsed", "timestamp", "time"]));
    const positionPct = numberValue(firstValue(row, ["video_position", "video_position_percent", "video_position_pct", "position_percent", "position_pct"]));
    const elapsedSec = directTime ?? (positionPct != null && Number.isFinite(durationSec) ? durationSec * positionPct / 100 : null);
    let retentionPct = numberValue(firstValue(row, ["audience_retention", "audience_retention_percent", "audience_retention_pct", "absolute_audience_retention", "absolute_audience_retention_percent", "retention", "retention_percent", "retention_pct"]));
    if (!Number.isFinite(elapsedSec) || retentionPct == null) continue;
    if (retentionPct >= 0 && retentionPct <= 1) retentionPct *= 100;
    normalized.push({ elapsed_sec: Number(elapsedSec.toFixed(3)), retention_pct: Number(retentionPct.toFixed(4)) });
  }
  return normalized.sort((left, right) => left.elapsed_sec - right.elapsed_sec);
}

function cutAtTime(prompts, elapsedSec) {
  let selected = prompts[0] ?? null;
  for (const prompt of prompts) {
    if (Number(prompt.start_sec ?? 0) > elapsedSec) break;
    selected = prompt;
  }
  return selected;
}

function transitionAtTime(transitions, elapsedSec, toleranceSec = 1.25) {
  const candidates = transitions.map((row) => ({ row, distance: Math.abs(Number(row.start_sec ?? row.at_sec ?? row.boundary_sec ?? -999) - elapsedSec) }));
  candidates.sort((left, right) => left.distance - right.distance);
  return candidates[0]?.distance <= toleranceSec ? candidates[0].row : null;
}

function dimensionSummary(rows, selector) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(selector(row) ?? "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups.entries()].map(([key, values]) => [key, {
    sample_count: values.length,
    average_retention_pct: Number((values.reduce((sum, row) => sum + row.retention_pct, 0) / values.length).toFixed(3)),
    average_point_delta_pct: Number((values.reduce((sum, row) => sum + Number(row.delta_from_previous_pct ?? 0), 0) / values.length).toFixed(3)),
  }]));
}

export function buildRetentionAttributionForTests({ retentionRows, prompts, imagegenResults = [], motionIntents = [], transitions = [] }) {
  const imageById = new Map(imagegenResults.map((row) => [String(row.image_id ?? ""), row]));
  const motionById = new Map(motionIntents.map((row) => [String(row.image_id ?? ""), row]));
  return retentionRows.map((row, index) => {
    const prompt = cutAtTime(prompts, row.elapsed_sec);
    const imageId = String(prompt?.image_id ?? "");
    const prior = retentionRows[index - 1];
    const delta = prior ? row.retention_pct - prior.retention_pct : 0;
    const transition = transitionAtTime(transitions, row.elapsed_sec);
    return {
      ...row,
      delta_from_previous_pct: Number(delta.toFixed(4)),
      image_id: imageId || null,
      visual_beat_id: prompt?.visual_beat_id ?? null,
      scene_id: prompt?.scene_id ?? null,
      visual_job: prompt?.visual_job ?? null,
      shot_job: prompt?.shot_manifest?.shot_job ?? null,
      location_contract_id: prompt?.shot_manifest?.location_contract_id ?? null,
      cut_duration_sec: Number(prompt?.duration_sec ?? 0),
      reference_count: Math.max(prompt?.reference_slots?.length ?? 0, prompt?.reference_requirements?.length ?? 0),
      image_provider: imageById.get(imageId)?.image_provider ?? prompt?.image_provider_route ?? null,
      motion_behavior: motionById.get(imageId)?.behavior ?? prompt?.shot_manifest?.motion_intent?.behavior ?? null,
      transition_type: transition?.transition ?? transition?.transition_type ?? transition?.type ?? "hard_cut_or_none",
    };
  });
}

async function readAnalyticsRows(inputPath) {
  const text = await fs.readFile(inputPath, "utf8");
  if (path.extname(inputPath).toLowerCase() === ".json") {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : parsed.rows ?? parsed.retention ?? parsed.data ?? [];
  }
  return csvRows(text);
}

async function ingest() {
  const episodeDir = flags["episode-dir"] ? path.resolve(flags["episode-dir"]) : path.join(dataRoot, "channels", flags.channel ?? "53rebirth", "weekly_runs", flags.week ?? "current", "episodes", flags.episode ?? "ep_01");
  const episode = flags.episode ?? path.basename(episodeDir);
  const inputPath = flags.input ? path.resolve(flags.input) : null;
  if (!inputPath) throw new Error("analytics ingest requires --input <youtube-retention.csv|json>.");
  const label = normalizedKey(flags["snapshot-label"] ?? "snapshot") || "snapshot";
  const finalQaPath = flags["final-qa"] ?? path.join(episodeDir, `final_qa_${episode}.json`);
  const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json");
  const imagegenPath = flags["imagegen-report"] ?? path.join(episodeDir, `imagegen_report_${episode}.json`);
  const motionPath = flags["motion-plan"] ?? path.join(episodeDir, `motion_edit_plan_${episode}.json`);
  const transitionPath = flags["transition-plan"] ?? path.join(episodeDir, `transition_edit_plan_${episode}.json`);
  const outputPath = flags.output ?? path.join(episodeDir, `youtube_performance_feedback_${episode}_${label}.json`);
  const [finalQa, promptPlan, imagegen, motionPlan, transitionPlan, sourceRows] = await Promise.all([
    readJson(finalQaPath),
    readJson(promptPath),
    readJson(imagegenPath, { results: [] }),
    readJson(motionPath, { motion_intents: [] }),
    readJson(transitionPath, { transition_events: [] }),
    readAnalyticsRows(inputPath),
  ]);
  if (finalQa?.status !== "passed" || !finalQa.final_video_sha256) throw new Error(`Analytics feedback requires passed final QA: ${finalQaPath}`);
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts)) throw new Error(`Analytics feedback requires passed prompt plan: ${promptPath}`);
  const durationSec = Number(finalQa.media_probe?.duration_sec ?? finalQa.final_duration_sec ?? Math.max(...promptPlan.prompts.map((row) => Number(row.start_sec ?? 0) + Number(row.duration_sec ?? 0))));
  const retentionRows = normalizeRetentionRowsForTests(sourceRows, durationSec);
  if (retentionRows.length < 2) throw new Error("Analytics input did not contain at least two recognizable retention points.");
  const attributed = buildRetentionAttributionForTests({
    retentionRows,
    prompts: promptPlan.prompts,
    imagegenResults: imagegen.results ?? [],
    motionIntents: motionPlan.motion_intents ?? [],
    transitions: transitionPlan.transition_events ?? [],
  });
  const dropThreshold = Math.abs(Number(flags["drop-threshold-pct"] ?? 4));
  const riseThreshold = Math.abs(Number(flags["rise-threshold-pct"] ?? 4));
  const drops = attributed.filter((row) => row.delta_from_previous_pct <= -dropThreshold);
  const rises = attributed.filter((row) => row.delta_from_previous_pct >= riseThreshold);
  const sourcePaths = [inputPath, finalQaPath, promptPath, imagegenPath, motionPath, transitionPath];
  const report = {
    schema: "goldflow_youtube_performance_feedback_v1",
    status: "passed",
    policy: "Observational feedback only. Never auto-modify production policy from one video or one snapshot; aggregate repeated patterns before changing defaults.",
    episode,
    snapshot_label: label,
    video_id: flags["video-id"] ?? null,
    final_video_sha256: finalQa.final_video_sha256,
    duration_sec: durationSec,
    summary_metrics: {
      ctr_percent: numberValue(flags["ctr-percent"]),
      impressions: numberValue(flags.impressions),
      average_view_duration_sec: timeValue(flags["average-view-duration-sec"]),
      average_percentage_viewed: numberValue(flags["average-percentage-viewed"]),
    },
    source_paths: sourcePaths,
    source_hashes: Object.fromEntries((await Promise.all(sourcePaths.map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
    retention_point_count: attributed.length,
    drop_threshold_pct: dropThreshold,
    rise_threshold_pct: riseThreshold,
    significant_drops: drops,
    significant_rises: rises,
    dimension_summaries: {
      visual_job: dimensionSummary(attributed, (row) => row.visual_job),
      shot_job: dimensionSummary(attributed, (row) => row.shot_job),
      cut_duration_band: dimensionSummary(attributed, (row) => row.cut_duration_sec < 4 ? "under_4s" : row.cut_duration_sec < 7 ? "4_to_7s" : row.cut_duration_sec < 12 ? "7_to_12s" : "12s_plus"),
      transition_type: dimensionSummary(attributed, (row) => row.transition_type),
      motion_behavior: dimensionSummary(attributed, (row) => row.motion_behavior),
      reference_count: dimensionSummary(attributed, (row) => row.reference_count),
      image_provider: dimensionSummary(attributed, (row) => row.image_provider),
    },
    attributed_retention: attributed,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: "passed", output_path: outputPath, retention_point_count: attributed.length, significant_drop_count: drops.length, significant_rise_count: rises.length }, null, 2));
}

async function aggregate() {
  const inputPaths = String(flags.inputs ?? flags.input ?? "").split(",").map((value) => value.trim()).filter(Boolean).map(path.resolve);
  if (inputPaths.length < 2) throw new Error("analytics aggregate requires --inputs <feedback1.json,feedback2.json,...>.");
  const reports = await Promise.all(inputPaths.map((filePath) => readJson(filePath)));
  if (reports.some((report) => report?.status !== "passed" || report?.schema !== "goldflow_youtube_performance_feedback_v1")) throw new Error("Every analytics aggregate input must be a passed Goldflow feedback report.");
  const dimensions = ["visual_job", "shot_job", "cut_duration_band", "transition_type", "motion_behavior", "reference_count", "image_provider"];
  const aggregateDimensions = {};
  for (const dimension of dimensions) {
    const groups = {};
    for (const report of reports) {
      for (const [key, value] of Object.entries(report.dimension_summaries?.[dimension] ?? {})) {
        if (!groups[key]) groups[key] = { episode_count: 0, sample_count: 0, weighted_retention_sum: 0, weighted_delta_sum: 0 };
        groups[key].episode_count += 1;
        groups[key].sample_count += Number(value.sample_count ?? 0);
        groups[key].weighted_retention_sum += Number(value.average_retention_pct ?? 0) * Number(value.sample_count ?? 0);
        groups[key].weighted_delta_sum += Number(value.average_point_delta_pct ?? 0) * Number(value.sample_count ?? 0);
      }
    }
    aggregateDimensions[dimension] = Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, {
      episode_count: value.episode_count,
      sample_count: value.sample_count,
      average_retention_pct: Number((value.weighted_retention_sum / Math.max(1, value.sample_count)).toFixed(3)),
      average_point_delta_pct: Number((value.weighted_delta_sum / Math.max(1, value.sample_count)).toFixed(3)),
    }]));
  }
  const outputPath = flags.output ? path.resolve(flags.output) : path.resolve("youtube_performance_feedback_aggregate.json");
  await writeJson(outputPath, {
    schema: "goldflow_youtube_performance_feedback_aggregate_v1",
    status: "passed",
    policy: "Cross-episode observational evidence. Policy changes still require operator review and a documented sample-size judgment.",
    input_paths: inputPaths,
    input_hashes: Object.fromEntries(await Promise.all(inputPaths.map(async (filePath) => [filePath, await hashFile(filePath)]))),
    episode_count: reports.length,
    dimension_summaries: aggregateDimensions,
    updated_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({ status: "passed", output_path: outputPath, episode_count: reports.length }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  (action === "aggregate" ? aggregate() : ingest()).catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
