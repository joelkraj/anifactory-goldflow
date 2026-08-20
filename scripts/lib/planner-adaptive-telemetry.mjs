import { promises as fs } from "node:fs";
import path from "node:path";

const RISK_CLASSES = ["high", "medium", "simple"];
export const ADAPTIVE_PLANNER_STAGE_POLICY = Object.freeze({
  visual_prompt_plan: "active",
  semantic_scene_plan: "evidence_gated",
  visual_beat_plan: "evidence_gated",
  visual_reference_plan: "evidence_gated",
});

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedToken(value, fallback = "unknown") {
  const token = String(value ?? "").trim().toLowerCase();
  return token || fallback;
}

function clampInteger(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.round(Number(value) || minimum)));
}

export function percentile(values, quantile) {
  const sorted = values
    .map(finiteNumber)
    .filter((value) => value != null)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const bounded = Math.max(0, Math.min(1, Number(quantile) || 0));
  const position = (sorted.length - 1) * bounded;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * weight);
}

export function plannerChunkTelemetryPath(dataRoot) {
  return path.join(dataRoot, "telemetry", "planner_chunk_history.jsonl");
}

export async function readPlannerChunkTelemetry(filePath, { maxRows = 20_000 } = {}) {
  const text = await fs.readFile(filePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Number(maxRows) || 20_000));
  const rows = [];
  let invalidRowCount = 0;
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object") rows.push(row);
      else invalidRowCount += 1;
    } catch {
      invalidRowCount += 1;
    }
  }
  return { rows, invalid_row_count: invalidRowCount, source_path: filePath };
}

export async function appendPlannerChunkTelemetry(filePath, row) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const record = {
    schema: "goldflow_planner_chunk_telemetry_v1",
    recorded_at: new Date().toISOString(),
    ...row,
  };
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

function matchingRows(rows, {
  plannerStage,
  requestedProvider,
  reasoningEffort,
  riskClass,
  nowMs,
  maxAgeDays,
  maxSamples,
}) {
  const minimumRecordedMs = nowMs - (maxAgeDays * 24 * 60 * 60 * 1000);
  return rows
    .filter((row) => row?.schema === "goldflow_planner_chunk_telemetry_v1")
    .filter((row) => row.reused !== true)
    .filter((row) => normalizedToken(row.planner_stage) === normalizedToken(plannerStage))
    .filter((row) => normalizedToken(row.requested_provider) === normalizedToken(requestedProvider))
    .filter((row) => normalizedToken(row.reasoning_effort) === normalizedToken(reasoningEffort))
    .filter((row) => normalizedToken(row.risk_class) === normalizedToken(riskClass))
    .filter((row) => {
      const recordedMs = Date.parse(row.recorded_at ?? row.completed_at ?? "");
      return !Number.isFinite(recordedMs) || recordedMs >= minimumRecordedMs;
    })
    .slice(-maxSamples);
}

function riskLimitCap(riskClass, baseLimit) {
  const hardCap = { high: 6, medium: 8, simple: 12 }[riskClass] ?? 12;
  return Math.min(hardCap, Math.max(baseLimit, baseLimit + 2));
}

function linearCorrelation(pairs) {
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

function plannerChunkSize(row) {
  for (const key of ["item_count", "visual_unit_count", "atom_count", "scene_count", "word_count", "target_chunk_size"]) {
    const value = finiteNumber(row?.[key] ?? row?.metadata?.[key]);
    if (value != null && value > 0) return value;
  }
  return null;
}

function plannerStageRows(rows, stage) {
  return rows
    .filter((row) => row?.schema === "goldflow_planner_chunk_telemetry_v1")
    .filter((row) => row.reused !== true)
    .filter((row) => normalizedToken(row.planner_stage) === normalizedToken(stage));
}

export function derivePlannerStageAdaptiveEligibility(rows = [], {
  stages = Object.keys(ADAPTIVE_PLANNER_STAGE_POLICY),
  minimumSamples = 12,
  maximumSafeFailureRate = 0.15,
  usefulFailureFloor = 0.02,
  usefulSizeServiceCorrelation = 0.25,
  usefulTailRatio = 1.5,
} = {}) {
  const stageRows = Object.fromEntries(stages.map((stage) => {
    const samples = plannerStageRows(rows, stage);
    const service = samples
      .map((row) => finiteNumber(row.service_ms) ?? finiteNumber(row.duration_ms))
      .filter((value) => value != null);
    const failedCount = samples.filter((row) => row.status !== "passed").length;
    const failureRate = samples.length ? failedCount / samples.length : null;
    const sizes = samples.map(plannerChunkSize).filter((value) => value != null);
    const sizeServiceCorrelation = linearCorrelation(samples.map((row) => [
      plannerChunkSize(row),
      finiteNumber(row.service_ms) ?? finiteNumber(row.duration_ms),
    ]));
    const serviceP50 = percentile(service, 0.5);
    const serviceP90 = percentile(service, 0.9);
    const tailRatio = serviceP50 && serviceP90 ? serviceP90 / serviceP50 : null;
    const enoughEvidence = samples.length >= minimumSamples;
    const stable = enoughEvidence && (failureRate ?? 1) <= maximumSafeFailureRate;
    const usefulSignal = enoughEvidence && (
      ((failureRate ?? 0) >= usefulFailureFloor)
        || Math.abs(sizeServiceCorrelation ?? 0) >= usefulSizeServiceCorrelation
        || (tailRatio ?? 0) >= usefulTailRatio
    );
    const configuredPolicy = ADAPTIVE_PLANNER_STAGE_POLICY[stage] ?? "evidence_gated";
    let disposition;
    if (configuredPolicy === "active") disposition = "active_stage_scoped_tuning";
    else if (!enoughEvidence) disposition = "fixed_hold_insufficient_evidence";
    else if (!stable) disposition = "fixed_hold_unstable_failure_rate";
    else if (!usefulSignal) disposition = "fixed_hold_no_useful_control_signal";
    else disposition = "eligible_for_scoped_operator_activation";
    return [stage, {
      configured_policy: configuredPolicy,
      disposition,
      sample_count: samples.length,
      passed_count: samples.length - failedCount,
      failed_count: failedCount,
      failure_rate: failureRate,
      service_ms_p50: serviceP50,
      service_ms_p90: serviceP90,
      service_tail_ratio_p90_to_p50: tailRatio == null ? null : Number(tailRatio.toFixed(4)),
      chunk_size_sample_count: sizes.length,
      distinct_chunk_size_count: new Set(sizes).size,
      chunk_size_service_correlation: sizeServiceCorrelation,
      enough_evidence: enoughEvidence,
      stable_enough_for_activation: stable,
      useful_control_signal: usefulSignal,
    }];
  }));
  return {
    schema: "goldflow_planner_adaptive_eligibility_v1",
    status: "advisory",
    policy: "Each planner earns only its own stage-scoped controller. No global auto-tuner may transfer visual-prompt behavior into semantic, beat, or reference planning.",
    thresholds: {
      minimum_samples: minimumSamples,
      maximum_safe_failure_rate: maximumSafeFailureRate,
      useful_failure_floor: usefulFailureFloor,
      useful_size_service_correlation: usefulSizeServiceCorrelation,
      useful_tail_ratio: usefulTailRatio,
    },
    stages: stageRows,
    eligible_stage_ids: Object.entries(stageRows)
      .filter(([, row]) => row.disposition === "eligible_for_scoped_operator_activation")
      .map(([stage]) => stage),
    automatic_activation_count: 0,
  };
}

export function derivePlannerChunkTuning(rows, {
  plannerStage = "visual_prompt_plan",
  requestedProvider = "identity_locked",
  reasoningEffort = "medium",
  baseLimits = { high: 4, medium: 6, simple: 10 },
  nowMs = Date.now(),
  maxAgeDays = 30,
  maxSamples = 120,
  minimumSamples = 8,
  growthMinimumSamples = 12,
  failureShrinkThreshold = 0.15,
  growthFailureCeiling = 0.03,
  slowServiceP90Ms = 420_000,
  fastServiceP75Ms = 150_000,
} = {}) {
  const risk_metrics = {};
  const effective_limits = {};
  for (const riskClass of RISK_CLASSES) {
    const baseLimit = Math.max(1, Number(baseLimits?.[riskClass]) || 1);
    const samples = matchingRows(rows, {
      plannerStage,
      requestedProvider,
      reasoningEffort,
      riskClass,
      nowMs,
      maxAgeDays,
      maxSamples,
    });
    const failed = samples.filter((row) => row.status !== "passed");
    const serviceTimes = samples
      .map((row) => finiteNumber(row.service_ms) ?? finiteNumber(row.duration_ms))
      .filter((value) => value != null);
    const queueWaitTimes = samples.map((row) => finiteNumber(row.queue_wait_ms)).filter((value) => value != null);
    const failureRate = samples.length ? failed.length / samples.length : null;
    const serviceP75 = percentile(serviceTimes, 0.75);
    const serviceP90 = percentile(serviceTimes, 0.90);
    let effectiveLimit = baseLimit;
    let decision = "insufficient_evidence";
    if (samples.length >= minimumSamples) {
      if ((failureRate ?? 0) >= failureShrinkThreshold) {
        effectiveLimit = Math.max(1, baseLimit - 1);
        decision = "shrink_failure_cluster";
      } else if (serviceP90 != null && serviceP90 >= slowServiceP90Ms) {
        effectiveLimit = Math.max(1, baseLimit - 1);
        decision = "shrink_slow_service";
      } else if (
        samples.length >= growthMinimumSamples
        && (failureRate ?? 1) <= growthFailureCeiling
        && serviceP75 != null
        && serviceP75 <= fastServiceP75Ms
      ) {
        effectiveLimit = clampInteger(baseLimit + 1, 1, riskLimitCap(riskClass, baseLimit));
        decision = "grow_sustained_first_pass_success";
      } else {
        decision = "hold_measured_baseline";
      }
    }
    effective_limits[riskClass] = effectiveLimit;
    risk_metrics[riskClass] = {
      base_limit: baseLimit,
      effective_limit: effectiveLimit,
      decision,
      sample_count: samples.length,
      passed_count: samples.length - failed.length,
      failed_count: failed.length,
      failure_rate: failureRate,
      service_ms_p50: percentile(serviceTimes, 0.50),
      service_ms_p75: serviceP75,
      service_ms_p90: serviceP90,
      queue_wait_ms_p50: percentile(queueWaitTimes, 0.50),
      queue_wait_ms_p90: percentile(queueWaitTimes, 0.90),
    };
  }
  return {
    schema: "goldflow_planner_adaptive_chunk_tuning_v1",
    planner_stage: plannerStage,
    requested_provider: normalizedToken(requestedProvider),
    reasoning_effort: normalizedToken(reasoningEffort),
    history_window_days: maxAgeDays,
    effective_limits,
    risk_metrics,
    policy: {
      queue_wait_is_diagnostic_only: true,
      minimum_samples: minimumSamples,
      growth_minimum_samples: growthMinimumSamples,
      failure_shrink_threshold: failureShrinkThreshold,
      growth_failure_ceiling: growthFailureCeiling,
      slow_service_p90_ms: slowServiceP90Ms,
      fast_service_p75_ms: fastServiceP75Ms,
      passed_chunk_content_policy: "immutable",
    },
  };
}

export async function loadPlannerChunkTuning({
  telemetryPath,
  plannerStage,
  requestedProvider,
  reasoningEffort,
  baseLimits,
  ...options
}) {
  const history = await readPlannerChunkTelemetry(telemetryPath, options);
  return {
    ...derivePlannerChunkTuning(history.rows, {
      plannerStage,
      requestedProvider,
      reasoningEffort,
      baseLimits,
      ...options,
    }),
    telemetry_path: telemetryPath,
    telemetry_row_count: history.rows.length,
    invalid_telemetry_row_count: history.invalid_row_count,
  };
}
