#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const action = args[0] ?? "ingest";
const flags = parseFlags(args.slice(1));
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const WINNER_SOURCE_DIMENSIONS = [
  "formula_version",
  "selected_candidate_id",
  "betrayer_relationship",
  "betrayal_action",
  "reversal_action",
  "antagonist_loss",
  "mechanic_type",
  "thumbnail_main_text",
  "thumbnail_additive_fact",
  "package_score",
];
const LEGACY_LINEAGE_VALUE = "unbound_legacy";

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
  if (!cleaned) return null;
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

function nonEmptyText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function resolvedArtifactPath(ownerPath, artifactPath) {
  const value = nonEmptyText(artifactPath);
  if (!value) return null;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(path.dirname(ownerPath), value);
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function winnerLineageDimensions(lineage = {}, packageContract = null) {
  const titleContract = packageContract?.title_contract ?? {};
  const thumbnailContract = packageContract?.thumbnail_contract ?? {};
  return {
    formula_version: nonEmptyText(packageContract?.formula_version ?? lineage.formula_version),
    selected_candidate_id: nonEmptyText(packageContract?.selected_candidate_id ?? lineage.selected_candidate_id),
    betrayer_relationship: nonEmptyText(titleContract.betrayer),
    betrayal_action: nonEmptyText(titleContract.betrayal_action),
    reversal_action: nonEmptyText(titleContract.reversal_action),
    antagonist_loss: nonEmptyText(titleContract.antagonist_loss),
    mechanic_type: nonEmptyText(packageContract?.core_advantage?.type),
    thumbnail_main_text: nonEmptyText(thumbnailContract.main_text),
    thumbnail_additive_fact: nonEmptyText(thumbnailContract.additive_fact),
    package_score: numberValue(packageContract?.weighted_score ?? lineage.winner_package_score),
  };
}

export async function readWinnerSourceLineageForTests({ sourceIngestReportPath, operatorStoryLockPath }) {
  const artifactSpecs = [
    { kind: "source_story_ingest_report", filePath: sourceIngestReportPath },
    { kind: "operator_story_lock", filePath: operatorStoryLockPath },
  ].filter((row) => nonEmptyText(row.filePath));
  const artifacts = await Promise.all(artifactSpecs.map(async ({ kind, filePath }) => {
    const resolvedPath = path.resolve(filePath);
    return {
      kind,
      path: resolvedPath,
      hash: await hashFile(resolvedPath),
      document: await readJson(resolvedPath),
    };
  }));
  const existingArtifacts = artifacts.filter((row) => row.hash);
  const lineageArtifacts = existingArtifacts.filter((row) => row.document?.winner_source_release && typeof row.document.winner_source_release === "object");
  const reviewPolicy = "Source criticism and retention audits are observational review logs only. They never qualify, reject, regenerate, or rewrite a source in analytics.";
  if (lineageArtifacts.length === 0) {
    return {
      schema: "goldflow_youtube_winner_source_lineage_v1",
      status: "legacy_unbound",
      bound: false,
      source_artifact_paths: existingArtifacts.map((row) => row.path),
      source_artifact_hashes: Object.fromEntries(existingArtifacts.map((row) => [row.path, row.hash])),
      package_path: null,
      package_sha256: null,
      package_hash_status: "not_available",
      dimensions: winnerLineageDimensions(),
      warnings: [],
      review_policy: reviewPolicy,
    };
  }

  const preferredArtifact = lineageArtifacts.find((row) => row.kind === "source_story_ingest_report") ?? lineageArtifacts[0];
  const lineage = preferredArtifact.document.winner_source_release;
  const warnings = [];
  for (const other of lineageArtifacts.filter((row) => row !== preferredArtifact)) {
    for (const field of ["release_sha256", "winner_package_sha256", "formula_version", "selected_candidate_id"]) {
      const preferredValue = lineage[field];
      const otherValue = other.document.winner_source_release?.[field];
      if (preferredValue != null && otherValue != null && preferredValue !== otherValue) {
        warnings.push(`lineage_conflict:${field}:${preferredArtifact.kind}:${other.kind}`);
      }
    }
  }

  const packagePath = resolvedArtifactPath(
    preferredArtifact.path,
    lineage.winner_package_path ?? lineage.package_path,
  );
  let packageContract = null;
  let actualPackageSha256 = null;
  let packageHashStatus = "not_available";
  if (!packagePath) {
    warnings.push("winner_package_path_missing");
  } else {
    const packageBytes = await fs.readFile(packagePath).catch(() => null);
    if (!packageBytes) {
      packageHashStatus = "missing";
      warnings.push("winner_package_missing");
    } else {
      actualPackageSha256 = sha256(packageBytes);
      const expectedPackageSha256 = nonEmptyText(lineage.winner_package_sha256);
      if (expectedPackageSha256 && expectedPackageSha256 !== actualPackageSha256) {
        packageHashStatus = "mismatch";
        warnings.push("winner_package_hash_mismatch");
      } else {
        packageHashStatus = expectedPackageSha256 ? "matched" : "unbound_legacy";
        try {
          packageContract = JSON.parse(packageBytes.toString("utf8"));
        } catch {
          packageHashStatus = "invalid_json";
          warnings.push("winner_package_json_invalid");
        }
      }
    }
  }

  return {
    schema: "goldflow_youtube_winner_source_lineage_v1",
    status: packageContract ? "bound" : "partial_lineage",
    bound: Boolean(packageContract),
    binding_source: preferredArtifact.kind,
    release_sha256: nonEmptyText(lineage.release_sha256),
    source_script_sha256: nonEmptyText(lineage.source_script_sha256),
    source_artifact_paths: existingArtifacts.map((row) => row.path),
    source_artifact_hashes: Object.fromEntries(existingArtifacts.map((row) => [row.path, row.hash])),
    package_path: packagePath,
    package_sha256: actualPackageSha256,
    package_hash_status: packageHashStatus,
    dimensions: winnerLineageDimensions(lineage, packageContract),
    warnings: uniqueValues(warnings),
    review_policy: reviewPolicy,
  };
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

function arithmeticAverage(values, digits = 3) {
  const finite = values
    .filter((value) => value != null && String(value).trim() !== "")
    .map(Number)
    .filter(Number.isFinite);
  if (finite.length === 0) return null;
  return Number((finite.reduce((sum, value) => sum + value, 0) / finite.length).toFixed(digits));
}

function winnerPerformanceSummary(reports) {
  const metricRows = reports.map((report) => ({
    ctr: numberValue(report.summary_metrics?.ctr_percent),
    impressions: numberValue(report.summary_metrics?.impressions),
  }));
  const ctrRows = metricRows
    .filter((row) => Number.isFinite(row.ctr));
  const impressionWeightedCtrRows = ctrRows.filter((row) => Number.isFinite(row.impressions) && row.impressions > 0);
  const impressionTotal = metricRows
    .filter((row) => Number.isFinite(row.impressions) && row.impressions > 0)
    .reduce((sum, row) => sum + row.impressions, 0);
  const weightedCtrImpressionTotal = impressionWeightedCtrRows.reduce((sum, row) => sum + row.impressions, 0);
  const attributedRows = reports.flatMap((report) => Array.isArray(report.attributed_retention) ? report.attributed_retention : []);
  const packageScores = reports.map((report) => report.winner_source_lineage?.dimensions?.package_score);
  const uniqueEpisodes = new Set(reports.map((report) => nonEmptyText(report.video_id) ?? nonEmptyText(report.episode)).filter(Boolean));
  return {
    report_count: reports.length,
    episode_count: uniqueEpisodes.size,
    ctr_sample_count: ctrRows.length,
    average_ctr_percent: arithmeticAverage(ctrRows.map((row) => row.ctr)),
    impression_weighted_ctr_percent: weightedCtrImpressionTotal > 0
      ? Number((impressionWeightedCtrRows.reduce((sum, row) => sum + row.ctr * row.impressions, 0) / weightedCtrImpressionTotal).toFixed(3))
      : null,
    total_impressions: impressionTotal || null,
    avd_sample_count: reports.filter((report) => numberValue(report.summary_metrics?.average_view_duration_sec) != null).length,
    average_view_duration_sec: arithmeticAverage(reports.map((report) => report.summary_metrics?.average_view_duration_sec)),
    apv_sample_count: reports.filter((report) => numberValue(report.summary_metrics?.average_percentage_viewed) != null).length,
    average_percentage_viewed: arithmeticAverage(reports.map((report) => report.summary_metrics?.average_percentage_viewed)),
    retention_point_count: attributedRows.length,
    average_retention_pct: arithmeticAverage(attributedRows.map((row) => row.retention_pct)),
    average_significant_drop_count: arithmeticAverage(reports.map((report) => report.significant_drops?.length ?? 0)),
    average_significant_rise_count: arithmeticAverage(reports.map((report) => report.significant_rises?.length ?? 0)),
    average_package_score: arithmeticAverage(packageScores),
  };
}

function winnerDimensionGroupValue(report, dimension) {
  const value = report.winner_source_lineage?.dimensions?.[dimension];
  if (dimension === "package_score" && value != null && Number.isFinite(Number(value))) return String(Number(value));
  return nonEmptyText(value) ?? LEGACY_LINEAGE_VALUE;
}

export function buildWinnerSourceDimensionSummariesForTests(reports = []) {
  const summaries = {};
  for (const dimension of WINNER_SOURCE_DIMENSIONS) {
    const groups = new Map();
    for (const report of reports) {
      const key = winnerDimensionGroupValue(report, dimension);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(report);
    }
    summaries[dimension] = Object.fromEntries(
      [...groups.entries()].map(([key, rows]) => [key, winnerPerformanceSummary(rows)]),
    );
  }
  const boundReports = reports.filter((report) => report.winner_source_lineage?.bound === true);
  const partialReports = reports.filter((report) => report.winner_source_lineage?.status === "partial_lineage");
  const legacyReports = reports.filter((report) => !report.winner_source_lineage || report.winner_source_lineage.status === "legacy_unbound");
  return {
    coverage: {
      report_count: reports.length,
      bound_report_count: boundReports.length,
      partial_lineage_report_count: partialReports.length,
      legacy_unbound_report_count: legacyReports.length,
      bound_fraction: reports.length > 0 ? Number((boundReports.length / reports.length).toFixed(4)) : 0,
    },
    dimension_summaries: summaries,
  };
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
  const sourceIngestReportPath = flags["source-ingest-report"] ?? path.join(episodeDir, "source_story_ingest_report.json");
  const operatorStoryLockPath = flags["operator-story-lock"] ?? path.join(episodeDir, "operator_story_lock.json");
  const outputPath = flags.output ?? path.join(episodeDir, `youtube_performance_feedback_${episode}_${label}.json`);
  const [finalQa, promptPlan, imagegen, motionPlan, transitionPlan, sourceRows, winnerSourceLineage] = await Promise.all([
    readJson(finalQaPath),
    readJson(promptPath),
    readJson(imagegenPath, { results: [] }),
    readJson(motionPath, { motion_intents: [] }),
    readJson(transitionPath, { transition_events: [] }),
    readAnalyticsRows(inputPath),
    readWinnerSourceLineageForTests({ sourceIngestReportPath, operatorStoryLockPath }),
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
  const sourcePaths = uniqueValues([
    inputPath,
    finalQaPath,
    promptPath,
    imagegenPath,
    motionPath,
    transitionPath,
    ...(winnerSourceLineage.source_artifact_paths ?? []),
    winnerSourceLineage.package_path,
  ]);
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
    winner_source_lineage: winnerSourceLineage,
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
  const winnerSourceAggregate = buildWinnerSourceDimensionSummariesForTests(reports);
  const outputPath = flags.output ? path.resolve(flags.output) : path.resolve("youtube_performance_feedback_aggregate.json");
  await writeJson(outputPath, {
    schema: "goldflow_youtube_performance_feedback_aggregate_v1",
    status: "passed",
    policy: "Cross-episode observational evidence. Policy changes still require operator review and a documented sample-size judgment.",
    input_paths: inputPaths,
    input_hashes: Object.fromEntries(await Promise.all(inputPaths.map(async (filePath) => [filePath, await hashFile(filePath)]))),
    episode_count: reports.length,
    dimension_summaries: aggregateDimensions,
    winner_source_lineage_coverage: winnerSourceAggregate.coverage,
    winner_source_dimension_summaries: winnerSourceAggregate.dimension_summaries,
    winner_source_review_policy: "Source criticism and retention audits remain review-only. These groupings correlate released package attributes with observed performance and never act as source gates.",
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
