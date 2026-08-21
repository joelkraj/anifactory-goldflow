#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { episodeDirForFlags } from "./lib/execution-provenance.mjs";
import {
  buildRunPerformanceAudit,
  renderRunPerformanceAuditMarkdown,
} from "./lib/run-performance-audit.mjs";
import {
  buildEpisodeProductionForecast,
  EPISODE_SIZE_AWARE_FORECAST_POLICY,
  stageLatencyPercentiles,
} from "./lib/production-forecast.mjs";
import { runReferenceRoiAudit } from "./reference-roi-audit.mjs";
import {
  derivePlannerStageAdaptiveEligibility,
  plannerChunkTelemetryPath,
  readPlannerChunkTelemetry,
} from "./lib/planner-adaptive-telemetry.mjs";
import { buildProviderTaskTelemetry } from "./lib/provider-task-telemetry.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[++index]
      : "true";
    flags[key] = value;
  }
  return flags;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function collectNamedFiles(root, names, output = []) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) await collectNamedFiles(filePath, names, output);
    else if (names.has(entry.name)) output.push(filePath);
  }
  return output;
}

async function imageProviderAttempts(episodeDir) {
  const root = path.join(episodeDir, "assets", "images", "codex_worker_staging");
  const paths = await collectNamedFiles(root, new Set(["assignment.json"]));
  const providers = new Map();
  const manifestCache = new Map();
  const telemetryRows = [];
  const elapsedMs = (start, end) => {
    const startMs = Date.parse(start ?? "");
    const endMs = Date.parse(end ?? "");
    return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
  };
  for (const assignmentPath of paths) {
    const assignment = await readJson(assignmentPath);
    if (!assignment) continue;
    const manifestPath = assignment.manifest_path ?? assignment.item?.manifest_path ?? null;
    let manifest = null;
    if (manifestPath) {
      if (!manifestCache.has(manifestPath)) manifestCache.set(manifestPath, await readJson(manifestPath, {}));
      manifest = manifestCache.get(manifestPath);
    }
    const provider = String(assignment.browser_provider ?? manifest?.provider ?? "unknown");
    const current = providers.get(provider) ?? {
      provider,
      attempt_count: 0,
      failure_count: 0,
      failure_codes: {},
      unique_asset_ids: new Set(),
    };
    current.attempt_count += 1;
    current.unique_asset_ids.add(String(assignment.asset_id ?? "unknown"));
    const completion = await readJson(path.join(path.dirname(assignmentPath), "completion.json"));
    const failure = await readJson(path.join(path.dirname(assignmentPath), "failure.json"));
    if (failure) {
      current.failure_count += 1;
      const code = String(failure.error ?? "unknown").split(":", 1)[0].trim() || "unknown";
      current.failure_codes[code] = Number(current.failure_codes[code] ?? 0) + 1;
    }
    providers.set(provider, current);
    const completedAt = completion?.completed_at
      ?? failure?.failed_at
      ?? failure?.updated_at
      ?? null;
    const leasedAt = assignment.leased_at ?? null;
    const queuedAt = manifest?.created_at ?? null;
    const failureCode = failure
      ? String(failure.code ?? failure.error ?? "unknown").split(":", 1)[0].trim() || "unknown"
      : null;
    const attemptNumber = Number(assignment.attempt_number ?? 1);
    telemetryRows.push({
      source: "codex_image_work",
      provider,
      task_class: assignment.asset_kind === "reference" ? "image.reference_generation" : "image.scene_generation",
      asset_id: assignment.asset_id ?? null,
      status: completion ? "passed" : failure ? "failed" : assignment.status ?? "leased",
      attempt_number: attemptNumber,
      exact_repair: attemptNumber > 1 || Boolean(assignment.item?.prior_accepted_sha256) || /repair/i.test(String(manifest?.mode ?? "")),
      failure_code: failureCode,
      queue_wait_ms: elapsedMs(queuedAt, leasedAt),
      service_ms: elapsedMs(leasedAt, completedAt),
      total_ms: elapsedMs(queuedAt, completedAt),
      started_at: leasedAt,
      completed_at: completedAt,
      quota_units: 1,
    });
  }
  return {
    attempt_count: [...providers.values()].reduce((sum, row) => sum + row.attempt_count, 0),
    failure_count: [...providers.values()].reduce((sum, row) => sum + row.failure_count, 0),
    providers: [...providers.values()].map((row) => ({
      provider: row.provider,
      attempt_count: row.attempt_count,
      failure_count: row.failure_count,
      failure_rate_percent: Number((row.attempt_count ? row.failure_count / row.attempt_count * 100 : 0).toFixed(2)),
      unique_asset_count: row.unique_asset_ids.size,
      failure_codes: row.failure_codes,
    })).sort((left, right) => right.attempt_count - left.attempt_count),
    telemetry_rows: telemetryRows,
  };
}

async function plannerTaskTelemetryRows(identity) {
  const history = await readPlannerChunkTelemetry(plannerChunkTelemetryPath(dataRoot));
  const channel = String(identity.channel ?? "");
  const seriesSlug = String(identity.series_slug ?? identity.series ?? "");
  const week = String(identity.week ?? identity.run_slug ?? "");
  const episode = String(identity.episode ?? "");
  return history.rows
    .filter((row) => !channel || String(row.channel ?? "") === channel)
    .filter((row) => !seriesSlug || String(row.series_slug ?? "") === seriesSlug)
    .filter((row) => !week || String(row.week ?? "") === week)
    .filter((row) => !episode || String(row.episode ?? "") === episode)
    .map((row) => {
      const completedAt = row.completed_at ?? row.recorded_at ?? null;
      const durationMs = Number(row.duration_ms ?? 0);
      const completedMs = Date.parse(completedAt ?? "");
      const startedAt = Number.isFinite(completedMs) && Number.isFinite(durationMs)
        ? new Date(completedMs - durationMs).toISOString()
        : null;
      return {
        source: "planner_chunk_history",
        provider: row.actual_provider ?? row.requested_provider ?? "unknown",
        task_class: `planner.${row.planner_stage ?? "unknown"}`,
        status: row.status,
        attempt_number: Number(row.attempt ?? 1),
        exact_repair: Number(row.attempt ?? 1) > 1 || /repair/i.test(String(row.chunk_id ?? "")),
        reused: row.reused === true,
        failure_code: row.finding_codes?.[0] ?? null,
        queue_wait_ms: row.queue_wait_ms ?? null,
        service_ms: row.service_ms ?? null,
        total_ms: row.duration_ms ?? row.provider_total_ms ?? null,
        started_at: startedAt,
        completed_at: completedAt,
        quota_units: row.reused === true ? 0 : 1,
      };
    });
}

async function plannerAdaptiveRows(identity) {
  const history = await readPlannerChunkTelemetry(plannerChunkTelemetryPath(dataRoot));
  const identityFields = {
    channel: String(identity.channel ?? ""),
    series_slug: String(identity.series_slug ?? identity.series ?? ""),
    week: String(identity.week ?? identity.run_slug ?? ""),
    episode: String(identity.episode ?? ""),
  };
  return history.rows.filter((row) => Object.entries(identityFields).every(([key, value]) => (
    !value || String(row?.[key] ?? "") === value
  )));
}

async function generatedMotionTaskTelemetryRows(episodeDir, episode) {
  const report = await readJson(path.join(
    episodeDir,
    "assets",
    "motion",
    "generated",
    `generated_motion_report_${episode}.json`,
  ), {});
  const rows = [];
  for (const clip of report.clips ?? []) {
    const timing = clip.provider_timing ?? {};
    rows.push({
      source: "generated_motion_report",
      provider: clip.provider ?? report.provider ?? "unknown",
      task_class: "video.generated_motion",
      asset_id: clip.image_id ?? null,
      status: "passed",
      attempt_number: Number(clip.creative_generation_attempt ?? 1),
      exact_repair: Number(clip.creative_generation_attempt ?? 1) > 1,
      queue_wait_ms: timing.queue_wait_ms ?? null,
      service_ms: timing.service_ms ?? null,
      total_ms: timing.total_ms ?? null,
      started_at: timing.last_leased_at ?? null,
      completed_at: timing.completed_at ?? null,
      quota_units: 1,
    });
  }
  for (const clip of report.omitted_clips ?? []) {
    rows.push({
      source: "generated_motion_report",
      provider: clip.provider ?? report.provider ?? "unknown",
      task_class: "video.generated_motion",
      asset_id: clip.image_id ?? null,
      status: "omitted",
      attempt_number: Number(clip.creative_generation_attempt ?? 1),
      exact_repair: Number(clip.creative_generation_attempt ?? 1) > 1,
      failure_code: String(clip.error ?? clip.omission_stage ?? "omitted").split(":", 1)[0],
      quota_units: 1,
    });
  }
  return rows;
}

function wordCount(text) {
  return String(text ?? "").trim().match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu)?.length ?? 0;
}

function firstArray(document, keys) {
  for (const key of keys) if (Array.isArray(document?.[key])) return document[key];
  return [];
}

async function productionForecastInputs({ episodeDir, identity, events, providerAttempts }) {
  const episode = identity.episode ?? "ep_01";
  const [scriptText, timing, prompts, inventory, animationPlan, generatedMotionReport, renderReport] = await Promise.all([
    fs.readFile(path.join(episodeDir, "script_clean.md"), "utf8").catch(() => ""),
    readJson(path.join(episodeDir, `narration_word_timing_${episode}.json`), {}),
    readJson(path.join(episodeDir, "section_image_prompts_hardened.json"), {}),
    readJson(path.join(episodeDir, "reference_inventory_ledger.json"), {}),
    readJson(path.join(episodeDir, `animation_direction_plan_${episode}.json`), {}),
    readJson(path.join(episodeDir, "assets", "motion", "generated", `generated_motion_report_${episode}.json`), {}),
    readJson(path.join(episodeDir, `render_report_${episode}.json`), {}),
  ]);
  const providerRows = providerAttempts.providers ?? [];
  const attemptCount = providerRows.reduce((sum, row) => sum + Number(row.attempt_count ?? 0), 0);
  const failureCount = providerRows.reduce((sum, row) => sum + Number(row.failure_count ?? 0), 0);
  const motionDirections = firstArray(animationPlan, ["directions", "shots", "selected_shots"]);
  const generatedMotionCount = Number.isFinite(Number(generatedMotionReport.planned_count))
    ? Number(generatedMotionReport.planned_count)
    : Number.isFinite(Number(generatedMotionReport.generated_count))
      ? Number(generatedMotionReport.generated_count)
      : Number.isFinite(Number(animationPlan.required_motion_direction_count))
        ? Number(animationPlan.required_motion_direction_count)
    : motionDirections.filter((row) => row?.eligibility === "animate" || row?.selected_for_generation === true).length;
  return {
    scriptWordCount: wordCount(scriptText),
    narrationDurationMinutes: Number(timing.audio_duration_sec ?? 0) > 0
      ? Number(timing.audio_duration_sec) / 60
      : null,
    requiredStillCount: firstArray(prompts, ["prompts", "images", "cuts"]).length,
    referenceCount: firstArray(inventory, ["assets", "references"]).length,
    generatedMotionCount,
    imageConcurrency: Number(identity?.production_profile_config?.media?.federated_web_image_concurrency
      ?? identity?.production_profile_config?.media?.image_concurrency
      ?? 8),
    generatedMotionConcurrency: Number(identity?.production_profile_config?.media?.generated_motion_concurrency ?? 3),
    imageFailureRate: attemptCount ? failureCount / attemptCount : 0.1,
    expectedOperatorCheckpointCount: Number(identity?.production_profile_config?.forecast?.expected_operator_checkpoint_count ?? 5),
    expectedMinutesPerCheckpoint: Number(identity?.production_profile_config?.forecast?.expected_minutes_per_checkpoint ?? 5),
    renderCacheWarm: renderReport?.status === "passed"
      && renderReport?.render_motion?.motion_clip_cache_reused_count > 0,
    earlyGeneratedMotionWavefront: identity?.production_profile_config?.orchestration?.incremental_generated_motion_prefetch === true
      || identity?.production_profile_config?.orchestration?.early_generated_motion_wavefront === true,
    stageLatency: stageLatencyPercentiles(events),
    stretchTargetMinutes: identity?.production_profile_config?.stretch_target_wall_clock_minutes ?? 180,
  };
}

export async function runPerformanceAudit(flags = {}) {
  const episodeDir = episodeDirForFlags(flags, process.env);
  if (!episodeDir) throw new Error("run performance-audit requires --episode-dir or channel/week/episode flags.");
  const eventText = await fs.readFile(path.join(episodeDir, "execution_events.jsonl"), "utf8");
  const events = eventText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const identity = await readJson(path.join(episodeDir, "run_identity.json"), {});
  const rawProviderAttempts = await imageProviderAttempts(episodeDir);
  const imageTelemetryRows = rawProviderAttempts.telemetry_rows ?? [];
  const providerAttempts = { ...rawProviderAttempts };
  delete providerAttempts.telemetry_rows;
  const [plannerTelemetryRows, plannerAdaptiveTelemetryRows, motionTelemetryRows] = await Promise.all([
    plannerTaskTelemetryRows(identity),
    plannerAdaptiveRows(identity),
    generatedMotionTaskTelemetryRows(episodeDir, identity.episode ?? flags.episode ?? "ep_01"),
  ]);
  const providerTaskTelemetry = buildProviderTaskTelemetry([
    ...plannerTelemetryRows,
    ...imageTelemetryRows,
    ...motionTelemetryRows,
  ]);
  providerTaskTelemetry.sources = {
    planner_chunk_observations: plannerTelemetryRows.length,
    image_generation_observations: imageTelemetryRows.length,
    generated_motion_observations: motionTelemetryRows.length,
  };
  const forecast = buildEpisodeProductionForecast(await productionForecastInputs({
    episodeDir,
    identity,
    events,
    providerAttempts,
  }));
  const configuredPolicy = identity?.production_profile_config?.target_wall_clock_policy ?? null;
  const fixedTargetWallClockMinutes = Number(
    identity?.production_profile_config?.target_wall_clock_minutes,
  );
  const forecastTargetWallClockMinutes = configuredPolicy === EPISODE_SIZE_AWARE_FORECAST_POLICY
    ? Number(forecast.forecast.total_p90_minutes)
    : Number.NaN;
  const targetWallClockMinutes = Number.isFinite(forecastTargetWallClockMinutes)
    && Number.isFinite(fixedTargetWallClockMinutes)
    ? Math.min(forecastTargetWallClockMinutes, fixedTargetWallClockMinutes)
    : Number.isFinite(forecastTargetWallClockMinutes)
      ? forecastTargetWallClockMinutes
      : Number.isFinite(fixedTargetWallClockMinutes)
        ? fixedTargetWallClockMinutes
        : null;
  const report = buildRunPerformanceAudit(events, {
    targetWallClockMinutes,
    idleThresholdSec: Number(flags["idle-threshold-sec"] ?? 60),
  });
  report.episode_dir = episodeDir;
  report.episode = identity.episode ?? flags.episode ?? null;
  report.production_profile = identity.production_profile ?? identity.production_profile_id ?? null;
  report.target_wall_clock_policy = configuredPolicy
    ?? (targetWallClockMinutes === null ? "none" : "fixed_legacy");
  report.target_wall_clock_band_minutes = identity?.production_profile_config
    ?.target_wall_clock_band_minutes ?? null;
  report.production_forecast = forecast;
  report.image_provider_attempts = providerAttempts;
  report.provider_task_telemetry = providerTaskTelemetry;
  report.planner_adaptive_eligibility = derivePlannerStageAdaptiveEligibility(
    plannerAdaptiveTelemetryRows,
  );
  const outputDir = path.resolve(flags["output-dir"] ?? path.join(episodeDir, "reports", "performance"));
  await fs.mkdir(outputDir, { recursive: true });
  const episode = report.episode ?? "episode";
  const jsonPath = path.join(outputDir, `performance_audit_${episode}.json`);
  const markdownPath = path.join(outputDir, `performance_audit_${episode}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, renderRunPerformanceAuditMarkdown(report), "utf8");
  const referenceRoi = await runReferenceRoiAudit({ ...flags, "episode-dir": episodeDir, "output-dir": outputDir });
  report.reference_roi = {
    status: referenceRoi.report.status,
    summary: referenceRoi.report.summary ?? null,
    json_path: referenceRoi.jsonPath,
    markdown_path: referenceRoi.markdownPath,
  };
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, renderRunPerformanceAuditMarkdown(report), "utf8");
  return { report, jsonPath, markdownPath, referenceRoi };
}

async function main() {
  try {
    const result = await runPerformanceAudit(parseFlags(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      status: result.report.status,
      elapsed_minutes: result.report.observation.elapsed_minutes,
      active_union_minutes: result.report.observation.active_union_minutes,
      idle_minutes: result.report.observation.idle_minutes,
      utilization_percent: result.report.observation.utilization_percent,
      target_wall_clock_policy: result.report.target_wall_clock_policy,
      forecast_p50_minutes: result.report.production_forecast?.forecast?.total_p50_minutes ?? null,
      forecast_p90_minutes: result.report.production_forecast?.forecast?.total_p90_minutes ?? null,
      json_path: result.jsonPath,
      markdown_path: result.markdownPath,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
