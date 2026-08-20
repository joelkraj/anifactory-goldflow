#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildOperatorReviewTelemetry, buildRunPerformanceAudit, renderRunPerformanceAuditMarkdown } from "../lib/run-performance-audit.mjs";
import {
  buildEpisodeProductionForecast,
  stageLatencyPercentiles,
} from "../lib/production-forecast.mjs";
import { buildReferenceRoiAudit } from "../lib/reference-roi-audit.mjs";

const event = (executionId, stage, status, startMinute, endMinute) => ({
  event_type: "stage_completed",
  execution_id: executionId,
  stage,
  status,
  started_at: new Date(Date.UTC(2026, 0, 1, 0, startMinute)).toISOString(),
  completed_at: new Date(Date.UTC(2026, 0, 1, 0, endMinute)).toISOString(),
});

const events = [
  { event_type: "stage_started", execution_id: "a" },
  { event_type: "stage_started", execution_id: "b" },
  { event_type: "stage_started", execution_id: "c" },
  event("a", "semantic_scene_plan", "passed", 0, 10),
  event("b", "voice_plan", "passed", 5, 15),
  event("c", "qwen_tts_stitch", "failed", 20, 25),
  event("d", "local_whisper_word_timing", "passed", 40, 45),
  event("e", "script_approval", "passed", 50, 51),
];

const report = buildRunPerformanceAudit(events, {
  targetWallClockMinutes: 30,
  idleThresholdSec: 60,
  now: new Date("2026-01-02T00:00:00.000Z"),
});
assert.equal(report.observation.elapsed_minutes, 51);
assert.equal(report.observation.active_union_minutes, 26);
assert.equal(report.observation.idle_minutes, 25);
assert.equal(report.execution.failed_invocation_count, 1);
assert.equal(report.execution.orphaned_started_execution_ids.length, 0);
assert.equal(report.largest_gaps[0].classification, "blocker_recovery");
assert.equal(report.largest_gaps.at(-1).classification, "out_of_order_rework");
assert.ok(report.findings.some((finding) => finding.code === "target_wall_clock_exceeded"));
assert.match(renderRunPerformanceAuditMarkdown(report), /Goldflow Run Performance Audit/);

const approvalTelemetry = buildOperatorReviewTelemetry([
  event("source", "source_ingest", "passed", 0, 2),
  event("script-review", "script_approval", "passed", 12, 13),
  event("ref-plan", "visual_reference_plan", "passed", 20, 22),
  event("ref-review", "reference_plan_approval", "passed", 42, 43),
], { reviewTollThresholdMinutes: 15 });
assert.equal(approvalTelemetry.sample_count, 2);
assert.equal(approvalTelemetry.wait_minutes_p50, 15);
assert.equal(approvalTelemetry.wait_minutes_p90, 19);
assert.equal(approvalTelemetry.review_toll_candidate_count, 1);
assert.equal(approvalTelemetry.reduction_priority[0].review_toll_class, "agent_delegation_or_packet_readiness");

const stageLatency = stageLatencyPercentiles(events);
assert.equal(stageLatency.by_stage.find((row) => row.stage === "semantic_scene_plan")?.p50_minutes, 10);
assert.equal(stageLatency.by_task_class.find((row) => row.task_class === "audio_analysis")?.sample_count, 1);

const smallForecast = buildEpisodeProductionForecast({
  scriptWordCount: 2_000,
  requiredStillCount: 80,
  referenceCount: 12,
  generatedMotionCount: 8,
  imageFailureRate: 0.05,
  earlyGeneratedMotionWavefront: true,
});
const largeForecast = buildEpisodeProductionForecast({
  scriptWordCount: 10_000,
  requiredStillCount: 400,
  referenceCount: 80,
  generatedMotionCount: 30,
  imageFailureRate: 0.05,
  earlyGeneratedMotionWavefront: true,
});
const degradedForecast = buildEpisodeProductionForecast({
  scriptWordCount: 10_000,
  requiredStillCount: 400,
  referenceCount: 80,
  generatedMotionCount: 30,
  imageFailureRate: 0.5,
  earlyGeneratedMotionWavefront: true,
});
const serializedForecast = buildEpisodeProductionForecast({
  scriptWordCount: 10_000,
  requiredStillCount: 400,
  referenceCount: 80,
  generatedMotionCount: 30,
  imageFailureRate: 0.05,
  earlyGeneratedMotionWavefront: false,
});
assert.ok(largeForecast.forecast.total_p50_minutes > smallForecast.forecast.total_p50_minutes);
assert.ok(degradedForecast.forecast.total_p50_minutes > largeForecast.forecast.total_p50_minutes);
assert.ok(largeForecast.forecast.total_p90_minutes >= largeForecast.forecast.total_p50_minutes);
assert.ok(largeForecast.forecast.total_p50_minutes < serializedForecast.forecast.total_p50_minutes);

const roiEpisodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-reference-roi-"));
const refId = "ref_joey";
const imageId = "cut_001";
const attemptDir = path.join(roiEpisodeDir, "attempts", refId);
const referenceDir = path.join(roiEpisodeDir, "assets", "images", "references");
await fs.mkdir(attemptDir, { recursive: true });
await fs.mkdir(referenceDir, { recursive: true });
await fs.writeFile(path.join(roiEpisodeDir, "reference_inventory_ledger.json"), `${JSON.stringify({
  assets: [{
    asset_id: "asset_joey",
    ref_id: refId,
    kind: "character_identity",
    subject: "Joey",
    generation_mode: "standalone_ref",
    estimated_use_count: 2,
    planned_beat_ids: ["beat_001"],
    reference_value_reason: "Protect protagonist identity.",
    why_text_is_insufficient: "The face recurs across the episode.",
  }],
}, null, 2)}\n`);
await fs.writeFile(path.join(roiEpisodeDir, "visual_reference_plan.json"), `${JSON.stringify({
  reference_targets: [{ ref_id: refId, kind: "character_identity", subject: "Joey" }],
}, null, 2)}\n`);
await fs.writeFile(path.join(roiEpisodeDir, "section_image_prompts_hardened.json"), `${JSON.stringify({
  prompts: [{ image_id: imageId, visual_beat_id: "beat_001", required_reference_ids: [refId] }],
}, null, 2)}\n`);
await fs.writeFile(path.join(roiEpisodeDir, "cut_execution_ledger.json"), `${JSON.stringify({
  cuts: [{ image_id: imageId, reference_ids: [refId], image_qa_status: "passed", start_sec: 0 }],
}, null, 2)}\n`);
await fs.writeFile(path.join(roiEpisodeDir, "image_output_qa_ep_01.json"), `${JSON.stringify({
  rows: [{ image_id: imageId, findings: [] }],
}, null, 2)}\n`);
await fs.writeFile(path.join(roiEpisodeDir, "visual_reference_approval_ep_01.json"), `${JSON.stringify({
  updated_at: "2026-01-01T00:04:00.000Z",
  reference_decisions: [{ ref_id: refId, status: "approved", reviewed_at: "2026-01-01T00:04:00.000Z" }],
}, null, 2)}\n`);
await fs.writeFile(path.join(attemptDir, "assignment.json"), `${JSON.stringify({
  asset_id: refId,
  leased_at: "2026-01-01T00:00:00.000Z",
}, null, 2)}\n`);
await fs.writeFile(path.join(attemptDir, "receipt.json"), `${JSON.stringify({
  completed_at: "2026-01-01T00:03:00.000Z",
}, null, 2)}\n`);
await fs.writeFile(path.join(referenceDir, `${refId}.metadata.json`), `${JSON.stringify({
  ref_id: refId,
  source_path: path.join(attemptDir, "output.png"),
  provider_receipt_path: path.join(attemptDir, "receipt.json"),
  image_provider: "google-flow",
  model: "imagen",
  updated_at: "2026-01-01T00:03:00.000Z",
}, null, 2)}\n`);
const roi = await buildReferenceRoiAudit({
  episodeDir: roiEpisodeDir,
  episode: "ep_01",
  generatedAt: new Date("2026-01-01T01:00:00.000Z"),
});
assert.equal(roi.status, "passed");
assert.equal(roi.summary.zero_attachment_reference_count, 0);
assert.equal(roi.assets[0].generation_minutes, 3);
assert.equal(roi.assets[0].attachment_count, 1);
assert.equal(roi.assets[0].accepted_cut_count, 1);
assert.equal(roi.assets[0].prevention_measurement.status, "not_causally_measured");
await fs.rm(roiEpisodeDir, { recursive: true, force: true });

console.log("run performance audit tests passed");
