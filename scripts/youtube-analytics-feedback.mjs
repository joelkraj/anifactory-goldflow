#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calibrateMixedViewerShadow } from "./lib/source-mixed-viewer-shadow-contract.mjs";
import {
  buildEpisodeQualityOutcomeRecord,
  validateEpisodeQualityOutcomeRecord,
} from "./lib/episode-quality-outcome.mjs";
import { classifyUploadedEpisodeScriptOrigin } from "./lib/youtube-script-origin.mjs";
import {
  buildAnalyticsLearningReadiness,
  latestDistinctEpisodeReports,
} from "./lib/analytics-learning-policy.mjs";

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
  const isSourceRoomV2 = lineage?.schema === "goldflow_run_identity_source_room_release_binding_v2";
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

  const storyTruthIrPath = resolvedArtifactPath(preferredArtifact.path, lineage.story_truth_ir_path);
  const storyTruthScriptMapPath = resolvedArtifactPath(preferredArtifact.path, lineage.story_truth_script_map_path);
  const viewerTournamentManifestPath = resolvedArtifactPath(preferredArtifact.path, lineage.viewer_tournament_manifest_path);
  const sourceScriptPath = resolvedArtifactPath(preferredArtifact.path, lineage.source_path);
  for (const [label, filePath, expectedHash] of [
    ["story_truth_ir", storyTruthIrPath, lineage.story_truth_ir_sha256],
    ["story_truth_script_map", storyTruthScriptMapPath, lineage.story_truth_script_map_sha256],
    ["viewer_tournament_manifest", viewerTournamentManifestPath, lineage.viewer_tournament_manifest_sha256],
    ["released_source_script", sourceScriptPath, lineage.source_file_sha256],
  ]) {
    if (!filePath) continue;
    const actualHash = await hashFile(filePath);
    if (!actualHash) warnings.push(`${label}_missing`);
    else if (expectedHash && actualHash !== expectedHash) warnings.push(`${label}_hash_mismatch`);
  }

  return {
    schema: "goldflow_youtube_winner_source_lineage_v1",
    status: packageContract || (isSourceRoomV2 && storyTruthIrPath && storyTruthScriptMapPath) ? "bound" : "partial_lineage",
    bound: Boolean(packageContract || (isSourceRoomV2 && storyTruthIrPath && storyTruthScriptMapPath)),
    binding_source: preferredArtifact.kind,
    release_sha256: nonEmptyText(lineage.release_sha256),
    source_script_sha256: nonEmptyText(lineage.source_script_sha256),
    source_artifact_paths: uniqueValues([
      ...existingArtifacts.map((row) => row.path),
      sourceScriptPath,
      storyTruthIrPath,
      storyTruthScriptMapPath,
      viewerTournamentManifestPath,
    ]),
    source_artifact_hashes: Object.fromEntries((await Promise.all(uniqueValues([
      ...existingArtifacts.map((row) => row.path),
      sourceScriptPath,
      storyTruthIrPath,
      storyTruthScriptMapPath,
      viewerTournamentManifestPath,
    ]).map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
    package_path: packagePath,
    package_sha256: actualPackageSha256,
    package_hash_status: packageHashStatus,
    source_room_v2: isSourceRoomV2,
    source_script_path: sourceScriptPath,
    story_truth_ir_path: storyTruthIrPath,
    story_truth_ir_sha256: nonEmptyText(lineage.story_truth_ir_sha256),
    story_truth_script_map_path: storyTruthScriptMapPath,
    story_truth_script_map_sha256: nonEmptyText(lineage.story_truth_script_map_sha256),
    viewer_tournament_manifest_path: viewerTournamentManifestPath,
    viewer_tournament_manifest_sha256: nonEmptyText(lineage.viewer_tournament_manifest_sha256),
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

function pearsonCorrelation(pairs) {
  const rows = pairs.filter(([left, right]) => Number.isFinite(left) && Number.isFinite(right));
  if (rows.length < 3) return null;
  const leftMean = rows.reduce((sum, row) => sum + row[0], 0) / rows.length;
  const rightMean = rows.reduce((sum, row) => sum + row[1], 0) / rows.length;
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (const [left, right] of rows) {
    const leftDelta = left - leftMean;
    const rightDelta = right - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquare += leftDelta ** 2;
    rightSquare += rightDelta ** 2;
  }
  if (leftSquare === 0 || rightSquare === 0) return null;
  return Number((numerator / Math.sqrt(leftSquare * rightSquare)).toFixed(4));
}

function qualityOutcomeScalarRows(reports) {
  const byEpisode = new Map();
  for (const report of reports) {
    const outcome = report?.episode_quality_outcome;
    if (!outcome?.quality_signals || !outcome?.observed_outcomes) continue;
    const episode = nonEmptyText(report.video_id) ?? nonEmptyText(report.episode);
    if (!episode) continue;
    const prior = byEpisode.get(episode);
    const impressions = numberValue(outcome.observed_outcomes.impressions) ?? 0;
    if (prior && (numberValue(prior.observed_outcomes.impressions) ?? 0) > impressions) continue;
    byEpisode.set(episode, outcome);
  }
  return [...byEpisode.entries()].map(([episode, outcome]) => {
    const quality = outcome.quality_signals;
    const repairs = [
      quality.prompt_and_raster?.structural_blocker_count,
      quality.prompt_and_raster?.semantic_raster?.needs_review_count,
      quality.generated_motion?.needs_review_count,
      quality.generated_motion?.reject_recommended_count,
      quality.narration?.repair_unit_count,
    ].map(numberValue).filter((value) => value != null).reduce((sum, value) => sum + value, 0);
    return {
      episode,
      signals: {
        prompt_first_pass_acceptance: numberValue(quality.prompt_and_raster?.explicit_first_pass_acceptance_rate),
        raster_acceptance: numberValue(quality.prompt_and_raster?.raster_acceptance_rate),
        semantic_raster_pass: numberValue(quality.prompt_and_raster?.semantic_raster?.pass_rate),
        hero_selected_semantic_advantage: numberValue(quality.hero_alternatives?.mean_selected_semantic_advantage),
        generated_motion_coherence: numberValue(quality.generated_motion?.coherence_pass_rate),
        narration_clean_subjective_pass: quality.narration?.decision_status === "missing"
          ? null
          : quality.narration?.clean_subjective_pass ? 1 : 0,
        mixed_viewer_package_margin: numberValue(quality.package?.mixed_viewer_candidate_margin),
      },
      outcomes: {
        ctr_percent: numberValue(outcome.observed_outcomes.ctr_percent),
        average_percentage_viewed: numberValue(outcome.observed_outcomes.average_percentage_viewed),
        average_view_duration_sec: numberValue(outcome.observed_outcomes.average_view_duration_sec),
        repair_burden: repairs,
      },
    };
  });
}

export function buildQualityOutcomeCalibrationForTests(reports = []) {
  const rows = qualityOutcomeScalarRows(reports);
  const signalIds = [...new Set(rows.flatMap((row) => Object.keys(row.signals)))];
  const outcomeIds = ["ctr_percent", "average_percentage_viewed", "average_view_duration_sec", "repair_burden"];
  const signals = Object.fromEntries(signalIds.map((signalId) => {
    const available = rows.filter((row) => numberValue(row.signals[signalId]) != null);
    const correlations = Object.fromEntries(outcomeIds.map((outcomeId) => [
      outcomeId,
      pearsonCorrelation(available.map((row) => [
        numberValue(row.signals[signalId]),
        numberValue(row.outcomes[outcomeId]),
      ])),
    ]));
    const positiveOutcomeStrength = Math.max(
      ...["ctr_percent", "average_percentage_viewed", "average_view_duration_sec"]
        .map((key) => Math.abs(correlations[key] ?? 0)),
    );
    const repairStrength = Math.abs(correlations.repair_burden ?? 0);
    const predictive = available.length >= 3
      && Math.max(positiveOutcomeStrength, repairStrength) >= 0.35;
    return [signalId, {
      episode_count: available.length,
      correlations,
      predictive_signal: predictive,
      disposition: available.length < 3
        ? "hold_insufficient_distinct_episodes"
        : predictive
          ? "operator_review_allowed"
          : "hold_no_measured_control_signal",
    }];
  }));
  return {
    schema: "goldflow_quality_outcome_calibration_v1",
    status: "observational",
    episode_count: rows.length,
    policy: "Quality checks earn promotion only after repeated hash-bound episodes show blind-preference, repair, CTR, or retention signal. Correlation never changes a default automatically.",
    signals,
    promoted_default_count: 0,
  };
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

export function buildStoryLearningLedgerForTests(reports = []) {
  const storyRows = reports.flatMap((report) => (report.attributed_retention ?? []).flatMap((row) => (
    (row.story_truth_matches ?? []).map((match) => ({
      episode: report.video_id ?? report.episode,
      snapshot_label: report.snapshot_label,
      retention_pct: Number(row.retention_pct),
      delta_pct: Number(row.delta_from_previous_pct),
      truth_collection: match.truth_collection,
      truth_id: match.truth_id,
      phase: match.phase,
      story_function: match.story_function,
    }))
  )));
  const groups = new Map();
  for (const row of storyRows) {
    const key = `${row.truth_collection}:${row.phase}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const storyFunctionSummaries = Object.fromEntries([...groups.entries()].map(([key, rows]) => [key, {
    episode_count: new Set(rows.map((row) => row.episode)).size,
    snapshot_count: new Set(rows.map((row) => `${row.episode}:${row.snapshot_label}`)).size,
    sample_count: rows.length,
    average_retention_pct: arithmeticAverage(rows.map((row) => row.retention_pct)),
    average_point_delta_pct: arithmeticAverage(rows.map((row) => row.delta_pct)),
  }]));
  const calibrationRows = reports.flatMap((report) => report.viewer_simulation_calibration?.predictions ?? []);
  const calibrationByPersona = new Map();
  for (const row of calibrationRows) {
    if (!calibrationByPersona.has(row.persona_id)) calibrationByPersona.set(row.persona_id, []);
    calibrationByPersona.get(row.persona_id).push(row);
  }
  const viewerCalibration = Object.fromEntries([...calibrationByPersona.entries()].map(([personaId, rows]) => [personaId, {
    prediction_count: rows.length,
    hit_count: rows.filter((row) => row.calibrated_hit).length,
    hit_rate: Number((rows.filter((row) => row.calibrated_hit).length / Math.max(1, rows.length)).toFixed(4)),
    mean_absolute_error_sec: arithmeticAverage(rows.map((row) => row.absolute_error_sec)),
    calibration_status: rows.length >= 3 ? "measured" : "insufficient_sample",
  }]));
  const mixedRows = reports
    .map((report) => report?.mixed_viewer_shadow_calibration)
    .filter((row) => row?.status === "observed");
  const mixedMetricKeys = [
    "leave_point_sec",
    "first_30_sec_retention_percent",
    "first_60_sec_retention_percent",
    "average_percentage_viewed",
    "average_view_duration_sec",
  ];
  const summarizeErrors = (rows, getter) => Object.fromEntries(mixedMetricKeys.map((key) => {
    const values = rows.map((row) => Number(getter(row)?.[key])).filter(Number.isFinite);
    return [key, { sample_count: values.length, mean_absolute_error: arithmeticAverage(values) }];
  }));
  const providerFamilies = ["chatgpt_web", "gemini_web"];
  const mixedViewerCalibration = {
    episode_count: mixedRows.length,
    aggregate_absolute_error: summarizeErrors(mixedRows, (row) => row.absolute_errors),
    package_prediction_sample_count: mixedRows.filter((row) => row.package_prediction_correct != null).length,
    package_prediction_hit_rate: arithmeticAverage(mixedRows
      .filter((row) => row.package_prediction_correct != null)
      .map((row) => row.package_prediction_correct ? 1 : 0)),
    provider_family_absolute_error: Object.fromEntries(providerFamilies.map((provider) => [provider, summarizeErrors(
      mixedRows.filter((row) => row.provider_family_calibration?.[provider]),
      (row) => row.provider_family_calibration?.[provider]?.absolute_errors,
    )])),
    promotion_eligibility: mixedRows.length >= 3 ? "operator_review_allowed" : "shadow_hold_for_more_distinct_episodes",
  };
  const episodeCount = new Set(reports.map((report) => report.video_id ?? report.episode).filter(Boolean)).size;
  const qualityOutcomeCalibration = buildQualityOutcomeCalibrationForTests(reports);
  return {
    schema: "goldflow_source_learning_ledger_v1",
    status: "observational",
    policy: "Correlations guide premise and story review only. No single upload or retention point changes a creative default automatically.",
    episode_count: episodeCount,
    snapshot_count: reports.length,
    story_function_summaries: storyFunctionSummaries,
    viewer_persona_calibration: viewerCalibration,
    mixed_viewer_shadow_calibration: mixedViewerCalibration,
    quality_outcome_calibration: qualityOutcomeCalibration,
    default_change_eligibility: episodeCount >= 3 ? "operator_review_allowed" : "hold_for_more_distinct_episodes",
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

function scriptTokensWithOffsets(scriptText) {
  return [...String(scriptText ?? "").matchAll(/\S+/g)].map((match, index) => ({
    index,
    text: match[0],
    start_offset: match.index,
    end_offset: match.index + match[0].length,
  }));
}

function nearestTimingWord(words, elapsedSec) {
  if (!Array.isArray(words) || words.length === 0) return null;
  let selected = words[0];
  let selectedDistance = Number.POSITIVE_INFINITY;
  for (const word of words) {
    const start = Number(word?.start_sec ?? 0);
    const end = Number(word?.end_sec ?? start);
    const distance = elapsedSec < start ? start - elapsedSec : elapsedSec > end ? elapsedSec - end : 0;
    if (distance < selectedDistance) {
      selected = word;
      selectedDistance = distance;
    }
    if (start > elapsedSec && distance > selectedDistance) break;
  }
  return selected;
}

function exactPassageAroundOffset(scriptText, offset, radius = 220) {
  const text = String(scriptText ?? "");
  if (!text) return { start_offset: 0, end_offset: 0, exact_text: "" };
  const center = Math.max(0, Math.min(text.length - 1, Number(offset) || 0));
  const floor = Math.max(0, center - radius);
  const ceiling = Math.min(text.length, center + radius);
  const priorBreak = Math.max(text.lastIndexOf(". ", center), text.lastIndexOf("? ", center), text.lastIndexOf("! ", center), text.lastIndexOf("\n", center));
  const nextCandidates = [text.indexOf(". ", center), text.indexOf("? ", center), text.indexOf("! ", center), text.indexOf("\n", center)].filter((value) => value >= 0);
  const nextBreak = nextCandidates.length ? Math.min(...nextCandidates) + 1 : ceiling;
  const start = priorBreak >= floor ? priorBreak + 1 : floor;
  const end = nextBreak <= ceiling ? nextBreak : ceiling;
  return { start_offset: start, end_offset: end, exact_text: text.slice(start, end).trim() };
}

function storyMappingsNearOffset(storyMap, scriptOffset, maximum = 6) {
  return (storyMap?.mappings ?? [])
    .map((row) => {
      const start = Number(row.start_offset ?? 0);
      const end = Number(row.end_offset ?? start);
      const distance = scriptOffset < start ? start - scriptOffset : scriptOffset > end ? scriptOffset - end : 0;
      return { ...row, distance_chars: distance };
    })
    .sort((left, right) => left.distance_chars - right.distance_chars || Number(left.start_offset) - Number(right.start_offset))
    .slice(0, maximum);
}

export function buildStoryRetentionAttributionForTests({
  attributedRows = [],
  wordTiming = null,
  scriptText = "",
  storyTruthIr = null,
  storyTruthScriptMap = null,
  storyTruthIrSha256 = null,
}) {
  const words = Array.isArray(wordTiming?.words) ? wordTiming.words : [];
  const scriptTokens = scriptTokensWithOffsets(scriptText);
  return attributedRows.map((row) => {
    const timingWord = nearestTimingWord(words, Number(row.elapsed_sec ?? 0));
    const timingIndex = Number(timingWord?.index ?? words.indexOf(timingWord));
    const tokenIndex = words.length > 1 && scriptTokens.length > 1
      ? Math.round(Math.max(0, timingIndex) / (words.length - 1) * (scriptTokens.length - 1))
      : Math.max(0, Math.min(scriptTokens.length - 1, timingIndex));
    const scriptToken = scriptTokens[tokenIndex] ?? null;
    const scriptOffset = scriptToken?.start_offset ?? 0;
    const passage = exactPassageAroundOffset(scriptText, scriptOffset);
    const nearbyMappings = storyMappingsNearOffset(storyTruthScriptMap, scriptOffset);
    return {
      ...row,
      narration_word_index: Number.isFinite(timingIndex) ? timingIndex : null,
      narration_word: timingWord?.word ?? null,
      script_token_index: scriptToken?.index ?? null,
      script_offset: scriptToken?.start_offset ?? null,
      narration_passage: passage,
      story_truth_matches: nearbyMappings,
      promise_ids: uniqueValues(nearbyMappings.filter((match) => match.truth_collection === "promises").map((match) => match.truth_id)),
      causal_chain_ids: uniqueValues(nearbyMappings.filter((match) => match.truth_collection === "causal_chains").map((match) => match.truth_id)),
      character_agency_ids: uniqueValues(nearbyMappings.filter((match) => match.truth_collection === "character_agency").map((match) => match.truth_id)),
      movement_ids: uniqueValues(nearbyMappings.map((match) => match.movement_id)),
      mapping_policy: "whisper_index_to_exact_script_token_ratio_v1",
      story_truth_ir_sha256: storyTruthIrSha256,
    };
  });
}

function predictedCandidateLeaveRows({ manifest, reports, scriptText, durationSec }) {
  const rows = [];
  const scriptTokens = scriptTokensWithOffsets(scriptText);
  for (const report of reports ?? []) {
    const candidateLabel = report?.script_label_map?.candidate;
    const anchor = nonEmptyText(report?.earliest_leave_risk?.[candidateLabel]?.exact_anchor);
    if (!anchor) continue;
    const offset = scriptText.indexOf(anchor);
    if (offset < 0) continue;
    const tokenIndex = scriptTokens.findIndex((token) => token.start_offset >= offset);
    const predictedSec = scriptTokens.length > 1
      ? Math.max(0, tokenIndex) / (scriptTokens.length - 1) * durationSec
      : 0;
    rows.push({
      persona_id: report.persona_id,
      exact_anchor: anchor,
      script_offset: offset,
      predicted_leave_sec: Number(predictedSec.toFixed(3)),
      manifest_sha256: manifest?._file_sha256 ?? null,
    });
  }
  return rows;
}

export function buildViewerCalibrationForTests({ manifest = null, reports = [], scriptText = "", durationSec = 0, significantDrops = [], toleranceSec = 45 }) {
  const predictions = predictedCandidateLeaveRows({ manifest, reports, scriptText, durationSec });
  return predictions.map((prediction) => {
    const nearest = [...significantDrops]
      .map((drop) => ({ drop, distance: Math.abs(Number(drop.elapsed_sec ?? 0) - prediction.predicted_leave_sec) }))
      .sort((left, right) => left.distance - right.distance)[0] ?? null;
    return {
      ...prediction,
      nearest_actual_drop_sec: nearest ? Number(nearest.drop.elapsed_sec) : null,
      nearest_actual_drop_delta_pct: nearest ? Number(nearest.drop.delta_from_previous_pct) : null,
      absolute_error_sec: nearest ? Number(nearest.distance.toFixed(3)) : null,
      calibrated_hit: Boolean(nearest && nearest.distance <= toleranceSec),
      tolerance_sec: toleranceSec,
      interpretation: "Association only. Retention data does not prove why a viewer left.",
    };
  });
}

function nearestRetentionPercent(retentionRows, targetSec) {
  const row = [...(retentionRows ?? [])]
    .filter((item) => Number.isFinite(Number(item?.elapsed_sec)) && Number.isFinite(Number(item?.retention_pct)))
    .sort((left, right) => Math.abs(Number(left.elapsed_sec) - targetSec) - Math.abs(Number(right.elapsed_sec) - targetSec))[0];
  return row ? Number(row.retention_pct) : null;
}

export function buildMixedViewerShadowCalibrationForTests({
  aggregate,
  retentionRows = [],
  significantDrops = [],
  averagePercentageViewed = null,
  averageViewDurationSec = null,
  actualPackageWinner = null,
}) {
  if (!aggregate || aggregate?.status !== "complete") return null;
  const strongestDrop = [...significantDrops]
    .filter((row) => Number.isFinite(Number(row?.delta_from_previous_pct)))
    .sort((left, right) => Number(left.delta_from_previous_pct) - Number(right.delta_from_previous_pct))[0] ?? null;
  return calibrateMixedViewerShadow(aggregate, {
    actual30SecRetention: nearestRetentionPercent(retentionRows, 30),
    actual60SecRetention: nearestRetentionPercent(retentionRows, 60),
    actualAveragePercentageViewed: averagePercentageViewed,
    actualAverageViewDurationSec: averageViewDurationSec,
    actualLeavePointSec: strongestDrop ? Number(strongestDrop.elapsed_sec) : null,
    actualPackageWinner,
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

async function readViewerTournament(manifestPath) {
  if (!manifestPath) return { manifest: null, reports: [] };
  const manifest = await readJson(manifestPath);
  if (!manifest || !Array.isArray(manifest.panel_profile_ids)) return { manifest: null, reports: [] };
  const manifestBytes = await fs.readFile(manifestPath).catch(() => null);
  const reports = (await Promise.all(manifest.panel_profile_ids.map(async (personaId) => {
    const reportPath = path.join(path.dirname(manifestPath), `${personaId}.json`);
    return readJson(reportPath);
  }))).filter(Boolean);
  return {
    manifest: { ...manifest, _file_sha256: manifestBytes ? sha256(manifestBytes) : null },
    reports,
  };
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
  const wordTimingPath = flags["word-timing"] ?? path.join(episodeDir, `narration_word_timing_${episode}.json`);
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
  const visualAttributed = buildRetentionAttributionForTests({
    retentionRows,
    prompts: promptPlan.prompts,
    imagegenResults: imagegen.results ?? [],
    motionIntents: motionPlan.motion_intents ?? [],
    transitions: transitionPlan.transition_events ?? [],
  });
  const scriptPath = flags.script
    ? path.resolve(flags.script)
    : winnerSourceLineage.source_script_path ?? path.join(episodeDir, "script_clean.md");
  const storyTruthIrPath = flags["story-truth-ir"]
    ? path.resolve(flags["story-truth-ir"])
    : winnerSourceLineage.story_truth_ir_path;
  const storyTruthMapPath = flags["story-truth-map"]
    ? path.resolve(flags["story-truth-map"])
    : winnerSourceLineage.story_truth_script_map_path;
  const viewerManifestPath = flags["viewer-manifest"]
    ? path.resolve(flags["viewer-manifest"])
    : winnerSourceLineage.viewer_tournament_manifest_path;
  const mixedViewerAggregatePath = flags["mixed-viewer-shadow-aggregate"]
    ? path.resolve(flags["mixed-viewer-shadow-aggregate"])
    : null;
  const [wordTiming, scriptText, storyTruthIr, storyTruthScriptMap, viewerTournament, mixedViewerAggregate] = await Promise.all([
    readJson(wordTimingPath),
    fs.readFile(scriptPath, "utf8").catch(() => ""),
    storyTruthIrPath ? readJson(storyTruthIrPath) : null,
    storyTruthMapPath ? readJson(storyTruthMapPath) : null,
    readViewerTournament(viewerManifestPath),
    mixedViewerAggregatePath ? readJson(mixedViewerAggregatePath) : null,
  ]);
  const storyAttributionAvailable = Boolean(
    wordTiming?.status === "passed"
      && Array.isArray(wordTiming?.words)
      && scriptText
      && storyTruthIr?.status === "locked"
      && storyTruthScriptMap?.status === "mapped",
  );
  const attributed = storyAttributionAvailable
    ? buildStoryRetentionAttributionForTests({
      attributedRows: visualAttributed,
      wordTiming,
      scriptText,
      storyTruthIr,
      storyTruthScriptMap,
      storyTruthIrSha256: winnerSourceLineage.story_truth_ir_sha256,
    })
    : visualAttributed;
  const dropThreshold = Math.abs(Number(flags["drop-threshold-pct"] ?? 4));
  const riseThreshold = Math.abs(Number(flags["rise-threshold-pct"] ?? 4));
  const drops = attributed.filter((row) => row.delta_from_previous_pct <= -dropThreshold);
  const rises = attributed.filter((row) => row.delta_from_previous_pct >= riseThreshold);
  const viewerCalibration = scriptText && viewerTournament.manifest
    ? buildViewerCalibrationForTests({
      manifest: viewerTournament.manifest,
      reports: viewerTournament.reports,
      scriptText,
      durationSec,
      significantDrops: drops,
      toleranceSec: Math.abs(Number(flags["viewer-calibration-tolerance-sec"] ?? 45)),
    })
    : [];
  const averagePercentageViewed = numberValue(flags["average-percentage-viewed"]);
  const averageViewDurationSec = timeValue(flags["average-view-duration-sec"]);
  const mixedViewerCalibration = buildMixedViewerShadowCalibrationForTests({
    aggregate: mixedViewerAggregate,
    retentionRows: attributed,
    significantDrops: drops,
    averagePercentageViewed,
    averageViewDurationSec,
    actualPackageWinner: nonEmptyText(flags["actual-package-winner"]),
  });
  const sourcePaths = uniqueValues([
    inputPath,
    finalQaPath,
    promptPath,
    imagegenPath,
    motionPath,
    transitionPath,
    wordTimingPath,
    scriptPath,
    storyTruthIrPath,
    storyTruthMapPath,
    viewerManifestPath,
    mixedViewerAggregatePath,
    ...(winnerSourceLineage.source_artifact_paths ?? []),
    winnerSourceLineage.package_path,
  ]);
  const scriptOriginLineage = await classifyUploadedEpisodeScriptOrigin({ episodeDir });
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
      average_view_duration_sec: averageViewDurationSec,
      average_percentage_viewed: averagePercentageViewed,
    },
    production_lineage: scriptOriginLineage.production_lineage,
    script_origin: scriptOriginLineage.script_origin,
    source_room_lineage: scriptOriginLineage.source_room_lineage,
    script_origin_lineage: scriptOriginLineage,
    winner_source_lineage: winnerSourceLineage,
    story_attribution: {
      status: storyAttributionAvailable ? "available" : "unavailable",
      word_timing_path: wordTimingPath,
      script_path: scriptPath,
      story_truth_ir_path: storyTruthIrPath,
      story_truth_script_map_path: storyTruthMapPath,
      mapping_policy: storyAttributionAvailable ? "whisper_index_to_exact_script_token_ratio_v1" : null,
      warning: storyAttributionAvailable ? null : "Story-level attribution requires passed word timing plus hash-bound V4 Story Truth IR and script map.",
    },
    viewer_simulation_calibration: {
      status: viewerCalibration.length ? "observed" : "unavailable",
      association_only: true,
      predictions: viewerCalibration,
      hit_count: viewerCalibration.filter((row) => row.calibrated_hit).length,
      prediction_count: viewerCalibration.length,
    },
    mixed_viewer_shadow_calibration: mixedViewerCalibration
      ? {
          status: "observed",
          mode: "shadow_non_blocking",
          aggregate_path: mixedViewerAggregatePath,
          aggregate_sha256: await hashFile(mixedViewerAggregatePath),
          ...mixedViewerCalibration,
        }
      : {
          status: "unavailable",
          mode: "shadow_non_blocking",
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
  const qualityOutcome = await buildEpisodeQualityOutcomeRecord({
    episodeDir,
    episode,
    analytics: report,
    analyticsInputPath: inputPath,
    paths: {
      prompts: promptPath,
      imagegen: imagegenPath,
      motion: flags["motion-coherence-audit"],
      narrationManifest: flags["narration-subjective-manifest"],
      narrationDecision: flags["narration-subjective-decision"],
      packaging: flags["packaging-spec"],
      mixedViewer: mixedViewerAggregatePath,
    },
  });
  const qualityOutcomeValidation = validateEpisodeQualityOutcomeRecord(qualityOutcome);
  if (qualityOutcomeValidation.status !== "passed") {
    throw new Error(`Episode quality outcome is blocked: ${qualityOutcomeValidation.findings.map((row) => row.code).join(", ")}`);
  }
  const qualityOutcomePath = path.resolve(
    flags["quality-outcome-output"]
      ?? path.join(episodeDir, `episode_quality_outcome_${episode}_${label}.json`),
  );
  await writeJson(qualityOutcomePath, qualityOutcome);
  report.episode_quality_outcome = qualityOutcome;
  report.episode_quality_outcome_path = qualityOutcomePath;
  report.episode_quality_outcome_sha256 = await hashFile(qualityOutcomePath);
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: "passed", output_path: outputPath, retention_point_count: attributed.length, significant_drop_count: drops.length, significant_rise_count: rises.length }, null, 2));
}

async function aggregate() {
  const inputPaths = String(flags.inputs ?? flags.input ?? "").split(",").map((value) => value.trim()).filter(Boolean).map(path.resolve);
  if (inputPaths.length < 2) throw new Error("analytics aggregate requires --inputs <feedback1.json,feedback2.json,...>.");
  const reports = await Promise.all(inputPaths.map((filePath) => readJson(filePath)));
  if (reports.some((report) => report?.status !== "passed" || report?.schema !== "goldflow_youtube_performance_feedback_v1")) throw new Error("Every analytics aggregate input must be a passed Goldflow feedback report.");
  const latestReports = latestDistinctEpisodeReports(reports);
  const dimensions = ["visual_job", "shot_job", "cut_duration_band", "transition_type", "motion_behavior", "reference_count", "image_provider"];
  const aggregateDimensions = {};
  for (const dimension of dimensions) {
    const groups = {};
    for (const report of latestReports) {
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
  const learningReadiness = buildAnalyticsLearningReadiness(reports);
  const scriptOriginForReport = (report) => report.script_origin
    ?? (report.winner_source_lineage?.bound === true ? "goldflow_native" : "legacy_unclassified");
  const scriptOriginGroups = new Map();
  for (const report of latestReports) {
    const origin = scriptOriginForReport(report);
    if (!scriptOriginGroups.has(origin)) scriptOriginGroups.set(origin, []);
    scriptOriginGroups.get(origin).push(report);
  }
  const scriptOriginCohorts = Object.fromEntries([...scriptOriginGroups.entries()].map(([origin, rows]) => [origin, {
    ...winnerPerformanceSummary(rows),
    source_room_eligible: origin === "goldflow_native",
  }]));
  const sourceRoomEligibleEpisodeIds = new Set(learningReadiness.domains.source_room.episode_ids ?? []);
  const sourceRoomReports = latestReports.filter((report) => (
    scriptOriginForReport(report) === "goldflow_native"
    && sourceRoomEligibleEpisodeIds.has(String(report?.video_id ?? report?.episode ?? "").trim())
  ));
  const winnerSourceAggregate = buildWinnerSourceDimensionSummariesForTests(sourceRoomReports);
  const downstreamLearningLedger = buildStoryLearningLedgerForTests(latestReports);
  const sourceRoomLearningLedger = buildStoryLearningLedgerForTests(sourceRoomReports);
  const sourceRoomEligibleEpisodeCount = learningReadiness.domains.source_room.distinct_episode_count;
  sourceRoomLearningLedger.default_change_eligibility = learningReadiness.domains.source_room.status === "operator_review_allowed"
    ? "operator_review_allowed"
    : "hold_for_more_mature_goldflow_native_episodes";
  sourceRoomLearningLedger.eligible_episode_count = sourceRoomEligibleEpisodeCount;
  const outputPath = flags.output ? path.resolve(flags.output) : path.resolve("youtube_performance_feedback_aggregate.json");
  const aggregateDocument = {
    schema: "goldflow_youtube_performance_feedback_aggregate_v1",
    status: "passed",
    policy: "Cross-episode observational evidence. Policy changes still require operator review and a documented sample-size judgment.",
    input_paths: inputPaths,
    input_hashes: Object.fromEntries(await Promise.all(inputPaths.map(async (filePath) => [filePath, await hashFile(filePath)]))),
    episode_count: latestReports.length,
    snapshot_count: reports.length,
    script_origin_cohorts: scriptOriginCohorts,
    source_room_eligible_episode_count: sourceRoomEligibleEpisodeCount,
    source_room_default_change_eligibility: learningReadiness.domains.source_room.status === "operator_review_allowed"
      ? "operator_review_allowed"
      : "hold_for_more_mature_goldflow_native_episodes",
    script_origin_policy: "External-ingest episodes inform downstream production, packaging, and audience preference. Only hash-bound goldflow_native episodes evaluate native premise, drafting, selection, and revision performance.",
    learning_readiness: learningReadiness,
    dimension_summaries: aggregateDimensions,
    winner_source_lineage_coverage: winnerSourceAggregate.coverage,
    winner_source_dimension_summaries: winnerSourceAggregate.dimension_summaries,
    winner_source_review_policy: "Source criticism and retention audits remain review-only. These groupings correlate released package attributes with observed performance and never act as source gates.",
    downstream_learning_ledger: downstreamLearningLedger,
    source_room_learning_ledger: sourceRoomLearningLedger,
    story_learning_ledger: sourceRoomLearningLedger,
    default_change_policy: "No analytics artifact may edit a prompt, policy, production profile, or default. Eligible findings require a separate hash-bound operator approval.",
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, aggregateDocument);
  const learningOutputPath = flags["learning-output"] ? path.resolve(flags["learning-output"]) : null;
  if (learningOutputPath) {
    await writeJson(learningOutputPath, {
      ...sourceRoomLearningLedger,
      learning_readiness: learningReadiness,
      downstream_learning_ledger: downstreamLearningLedger,
      input_paths: inputPaths,
      input_hashes: aggregateDocument.input_hashes,
      aggregate_path: outputPath,
      aggregate_sha256: await hashFile(outputPath),
      updated_at: new Date().toISOString(),
    });
  }
  console.log(JSON.stringify({
    status: "passed",
    output_path: outputPath,
    learning_output_path: learningOutputPath,
    episode_count: latestReports.length,
    snapshot_count: reports.length,
    source_room_default_change_eligibility: aggregateDocument.source_room_default_change_eligibility,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  (action === "aggregate" ? aggregate() : ingest()).catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
