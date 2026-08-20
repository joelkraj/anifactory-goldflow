#!/usr/bin/env node

import assert from "node:assert/strict";

import { derivePlannerChunkTuning, derivePlannerStageAdaptiveEligibility, percentile } from "../lib/planner-adaptive-telemetry.mjs";

const baseOptions = {
  plannerStage: "visual_prompt_plan",
  requestedProvider: "planning_room",
  reasoningEffort: "medium",
  baseLimits: { high: 2, medium: 3, simple: 4 },
  nowMs: Date.parse("2026-08-18T12:00:00.000Z"),
};

function sample({ riskClass = "medium", status = "passed", serviceMs = 90_000, queueWaitMs = 20_000, index = 0 } = {}) {
  return {
    schema: "goldflow_planner_chunk_telemetry_v1",
    recorded_at: new Date(baseOptions.nowMs - (index * 60_000)).toISOString(),
    planner_stage: "visual_prompt_plan",
    requested_provider: "planning_room",
    reasoning_effort: "medium",
    risk_class: riskClass,
    status,
    service_ms: serviceMs,
    queue_wait_ms: queueWaitMs,
    reused: false,
  };
}

assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);

const insufficient = derivePlannerChunkTuning(
  Array.from({ length: 7 }, (_, index) => sample({ index })),
  baseOptions,
);
assert.equal(insufficient.effective_limits.medium, 3);
assert.equal(insufficient.risk_metrics.medium.decision, "insufficient_evidence");

const failing = derivePlannerChunkTuning(
  Array.from({ length: 10 }, (_, index) => sample({
    index,
    status: index < 2 ? "failed" : "passed",
    serviceMs: 120_000,
  })),
  baseOptions,
);
assert.equal(failing.effective_limits.medium, 2);
assert.equal(failing.risk_metrics.medium.decision, "shrink_failure_cluster");

const slow = derivePlannerChunkTuning(
  Array.from({ length: 10 }, (_, index) => sample({ index, serviceMs: 500_000 })),
  baseOptions,
);
assert.equal(slow.effective_limits.medium, 2);
assert.equal(slow.risk_metrics.medium.decision, "shrink_slow_service");

const fast = derivePlannerChunkTuning(
  Array.from({ length: 12 }, (_, index) => sample({ index, serviceMs: 70_000, queueWaitMs: 800_000 })),
  baseOptions,
);
assert.equal(fast.effective_limits.medium, 4);
assert.equal(fast.risk_metrics.medium.decision, "grow_sustained_first_pass_success");
assert.ok(fast.risk_metrics.medium.queue_wait_ms_p90 >= 800_000);

const cachedRows = Array.from({ length: 20 }, (_, index) => ({ ...sample({ index }), reused: true }));
const cachedIgnored = derivePlannerChunkTuning(cachedRows, baseOptions);
assert.equal(cachedIgnored.risk_metrics.medium.sample_count, 0);
assert.equal(cachedIgnored.effective_limits.medium, 3);

const stageTelemetry = [
  ...Array.from({ length: 12 }, (_, index) => ({
    ...sample({ index, serviceMs: 60_000 + index * 15_000 }),
    planner_stage: "semantic_scene_plan",
    item_count: 20 + index * 5,
  })),
  ...Array.from({ length: 4 }, (_, index) => ({
    ...sample({ index, serviceMs: 80_000 }),
    planner_stage: "visual_beat_plan",
    item_count: 40,
  })),
];
const eligibility = derivePlannerStageAdaptiveEligibility(stageTelemetry);
assert.equal(eligibility.stages.semantic_scene_plan.disposition, "eligible_for_scoped_operator_activation");
assert.equal(eligibility.stages.visual_beat_plan.disposition, "fixed_hold_insufficient_evidence");
assert.equal(eligibility.stages.visual_prompt_plan.disposition, "active_stage_scoped_tuning");
assert.equal(eligibility.automatic_activation_count, 0);

console.log("planner adaptive telemetry tests passed");
