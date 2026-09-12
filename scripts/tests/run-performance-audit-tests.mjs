#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildOperatorReviewTelemetry,
  buildRepeatInvocationTelemetry,
  buildRunPerformanceAudit,
  renderRunPerformanceAuditMarkdown,
} from "../lib/run-performance-audit.mjs";
import {
  buildEpisodeProductionForecast,
  stageLatencyPercentiles,
} from "../lib/production-forecast.mjs";
import { buildReferenceRoiAudit } from "../lib/reference-roi-audit.mjs";
import { CONSERVATIVE_GOOGLE_IMAGE_SCHEDULING } from "../lib/google-image-scheduling.mjs";
import { runPerformanceAudit } from "../run-performance-audit.mjs";

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

const repeatTelemetry = buildRepeatInvocationTelemetry([
  { ...event("img-1", "image_generation", "failed", 0, 2), command: "imagegen browser-pool", scope_sha256: "full", scope: {} },
  { ...event("img-2", "image_generation", "passed", 3, 5), command: "imagegen start", scope_sha256: "full", scope: {} },
  { ...event("img-repair-1", "image_generation", "failed", 6, 7), command: "imagegen browser-pool", scope_sha256: "cut-7", scope: { cut_ids: ["cut_007"] } },
  { ...event("img-repair-2", "image_generation", "passed", 8, 9), command: "imagegen browser-pool", scope_sha256: "cut-7", scope: { cut_ids: ["cut_007"] } },
]);
assert.equal(repeatTelemetry.repeated_same_scope_invocation_count, 2);
assert.equal(repeatTelemetry.repeated_full_scope_invocation_count, 1);
assert.equal(repeatTelemetry.costly_repeated_active_minutes, 3);
assert.equal(repeatTelemetry.groups.find((row) => row.scope_sha256 === "full")?.repeated_active_minutes, 2);
assert.equal(repeatTelemetry.groups.find((row) => row.scope_sha256 === "cut-7")?.exact_scope, true);

const narratorWideRepeatTelemetry = buildRepeatInvocationTelemetry([
  { ...event("tts-1", "qwen_tts_stitch", "failed", 0, 2), command: "tts qwen", scope_sha256: "narrator", scope: { tts_speakers: ["NARRATOR"] } },
  { ...event("tts-2", "qwen_tts_stitch", "passed", 3, 5), command: "tts qwen", scope_sha256: "narrator", scope: { tts_speakers: ["NARRATOR"] } },
]);
assert.equal(narratorWideRepeatTelemetry.repeated_full_scope_invocation_count, 1);
assert.equal(narratorWideRepeatTelemetry.groups[0]?.exact_scope, false);

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
assert.equal(largeForecast.inputs.image_concurrency, 8);
assert.equal(largeForecast.forecast.total_p50_minutes, 425.613, "historical forecast remains unchanged");
assert.equal(largeForecast.forecast.total_p90_minutes, 748.081);
assert.equal(largeForecast.image_submission_capacity, undefined);

const conservativeIdentity = {
  episode: "ep_01",
  image_provider_options: { scheduling: { ...CONSERVATIVE_GOOGLE_IMAGE_SCHEDULING } },
  provider_locks: { image_scheduling: { ...CONSERVATIVE_GOOGLE_IMAGE_SCHEDULING } },
  production_profile_config: {
    target_wall_clock_minutes: 360,
    target_wall_clock_policy: "approved_script_to_private_ready_slo_v2",
    media: { federated_web_image_concurrency: 8 },
    orchestration: { wall_clock_contract: { hard_ceiling_minutes: 420 } },
  },
};
const conservativeForecast = buildEpisodeProductionForecast({
  identity: conservativeIdentity,
  requiredStillCount: 700,
  referenceCount: 0,
  imageConcurrency: 8,
  imageFailureRate: 0,
});
assert.equal(conservativeForecast.inputs.image_concurrency, 3, "identity cap overrides stock profile capacity");
assert.equal(conservativeForecast.image_submission_capacity.maximum_submissions_per_hour, 80);
assert.equal(conservativeForecast.image_submission_capacity.submissions_per_hour_at_maximum_jitter, 72);
assert.equal(conservativeForecast.image_submission_capacity.submissions_per_hour_at_mean_jitter, 75.789);
assert.equal(conservativeForecast.image_submission_capacity.minimum_submission_window_minutes, 524.25);
assert.equal(conservativeForecast.image_submission_capacity.maximum_jitter_submission_window_minutes, 582.5);
assert.ok(conservativeForecast.forecast.total_p50_minutes > 420, "accepted scheduling bottleneck is not hidden by stock SLO");
assert.ok(conservativeForecast.forecast.automated_p50_minutes
  >= conservativeForecast.image_submission_capacity.mean_jitter_submission_window_minutes);
assert.ok(conservativeForecast.forecast.automated_p90_minutes
  >= conservativeForecast.image_submission_capacity.maximum_jitter_submission_window_minutes);
assert.equal(buildEpisodeProductionForecast({ identity: conservativeIdentity, imageConcurrency: 1 }).inputs.image_concurrency, 1,
  "forecast never raises an explicitly reduced runtime capacity");
for (const count of [0, 1]) {
  const capacity = buildEpisodeProductionForecast({ identity: conservativeIdentity, requiredStillCount: count }).image_submission_capacity;
  assert.equal(capacity.minimum_submission_window_minutes, 0, "no fictitious wait precedes the first submission");
}
assert.equal(conservativeIdentity.production_profile_config.orchestration.wall_clock_contract.hard_ceiling_minutes, 420);
const invalidSchedulingIdentity = structuredClone(conservativeIdentity);
invalidSchedulingIdentity.provider_locks.image_scheduling.total_concurrency = 8;
assert.throws(() => buildEpisodeProductionForecast({ identity: invalidSchedulingIdentity }), /scheduling identity mismatch/);
const conservativeMarkdown = renderRunPerformanceAuditMarkdown({ ...report, production_forecast: conservativeForecast });
assert.match(conservativeMarkdown, /Shared Google submission capacity: at most 80\/hour; 72\/hour/);
assert.match(conservativeMarkdown, /Stock production SLO is unchanged/);

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
await fs.writeFile(path.join(roiEpisodeDir, "run_identity.json"), JSON.stringify(conservativeIdentity));
await fs.writeFile(path.join(roiEpisodeDir, "execution_events.jsonl"), events.map((row) => JSON.stringify(row)).join("\n"));
await fs.writeFile(path.join(roiEpisodeDir, "script_clean.md"), "A bounded local forecast fixture.");
const conservativeAudit = await runPerformanceAudit({ "episode-dir": roiEpisodeDir });
assert.equal(conservativeAudit.report.production_forecast.inputs.image_concurrency, 3,
  "performance audit passes locked identity into forecast despite stock profile concurrency eight");
assert.equal(conservativeAudit.report.production_forecast.image_submission_capacity.required_image_submission_count, 2,
  "both selected references and scenes consume shared submission capacity");
assert.equal(conservativeAudit.report.observation.target_wall_clock_minutes, 360, "stock performance target remains unchanged");
await fs.rm(roiEpisodeDir, { recursive: true, force: true });

console.log("run performance audit tests passed");
