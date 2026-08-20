#!/usr/bin/env node

import assert from "node:assert/strict";

import { buildProviderTaskTelemetry } from "../lib/provider-task-telemetry.mjs";

const rows = [
  {
    provider: "gemini_web",
    task_class: "planner.visual_prompt_plan",
    status: "passed",
    attempt_number: 1,
    queue_wait_ms: 100,
    service_ms: 1000,
    total_ms: 1100,
    started_at: "2026-08-18T12:00:00.000Z",
    completed_at: "2026-08-18T12:00:01.000Z",
    quota_units: 1,
  },
  {
    provider: "gemini_web",
    task_class: "planner.visual_prompt_plan",
    status: "failed",
    attempt_number: 1,
    queue_wait_ms: 300,
    service_ms: 3000,
    total_ms: 3300,
    started_at: "2026-08-18T12:00:00.500Z",
    completed_at: "2026-08-18T12:00:03.500Z",
    failure_code: "schema_validation_failed",
    quota_units: 1,
  },
  {
    provider: "gemini_web",
    task_class: "planner.visual_prompt_plan",
    status: "passed",
    attempt_number: 2,
    exact_repair: true,
    queue_wait_ms: 200,
    service_ms: 2000,
    total_ms: 2200,
    started_at: "2026-08-18T12:00:04.000Z",
    completed_at: "2026-08-18T12:00:06.000Z",
    quota_units: 1,
  },
  {
    provider: "gemini_web",
    task_class: "planner.visual_prompt_plan",
    status: "passed",
    reused: true,
    queue_wait_ms: 0,
    service_ms: 5,
    total_ms: 5,
  },
];

const report = buildProviderTaskTelemetry(rows);
assert.equal(report.task_class_count, 1);
const row = report.task_classes[0];
assert.equal(row.creative_attempt_count, 3);
assert.equal(row.cache_reuse_count, 1);
assert.equal(row.accepted_count, 2);
assert.equal(row.first_pass_count, 2);
assert.equal(row.first_pass_accepted_count, 1);
assert.equal(row.first_pass_acceptance_rate_percent, 50);
assert.equal(row.exact_repair_count, 1);
assert.equal(row.malformed_output_count, 1);
assert.equal(row.service_ms.p50, 2000);
assert.equal(row.peak_observed_concurrency, 2);
assert.equal(row.quota_units_observed, 3);

console.log("provider task telemetry tests passed");
