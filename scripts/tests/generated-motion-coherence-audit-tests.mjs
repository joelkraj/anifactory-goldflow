#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildGeneratedMotionCoherenceAudit,
  generatedMotionSampleTimesForTests,
  normalizeGeneratedMotionAuditForTests,
} from "../lib/generated-motion-coherence-audit.mjs";
import { generatedMotionDirectionContractSha256 } from "../lib/generated-motion-contract.mjs";

const clip = {
  image_id: "cut_001",
  candidate_id: "cut_001-candidate-01",
  cut_duration_sec: 5,
  requested_duration_sec: 8,
  normalized_probe: { duration_sec: 8 },
  motion_prompt: "Joey catches one hammer strike and settles behind the shield.",
  coverage: [{
    foreground_action: "Joey blocks the hammer once",
    animation_intent: { shot_class: "physical_contact", primary_action: "Joey blocks one hammer strike" },
  }],
  start_frame_contract: { state: "Joey braces before contact" },
  end_frame_contract: { state: "hammer stopped on shield", camera_state: "medium frontal", continuity_bridge: "Joey remains frame-center" },
};

assert.deepEqual(generatedMotionSampleTimesForTests(8), [0.04, 2, 4, 6, 7.92]);
assert.equal(
  generatedMotionDirectionContractSha256({ ...clip, aggregate_plan_sha256: "early-wavefront" }),
  generatedMotionDirectionContractSha256({ ...clip, aggregate_plan_sha256: "official-complete-plan" }),
  "Flow idempotency must bind the per-cut contract rather than an aggregate-plan hash",
);

const failed = normalizeGeneratedMotionAuditForTests(clip, {
  checks: [
    { dimension: "source_first_frame_fidelity", verdict: "pass", visible_evidence: "First sample matches." },
    { dimension: "identity_body_and_prop_continuity", verdict: "pass", visible_evidence: "Identity holds." },
    { dimension: "physical_reachability", verdict: "pass", visible_evidence: "One reachable swing." },
    { dimension: "action_and_contact_continuity", verdict: "fail", visible_evidence: "Hammer passes through the shield." },
    { dimension: "terminal_subject_state", verdict: "fail", visible_evidence: "No settled block." },
    { dimension: "terminal_camera_and_composition", verdict: "pass", visible_evidence: "Medium frontal ending." },
    { dimension: "next_shot_continuity_bridge", verdict: "pass", visible_evidence: "Joey remains centered." },
    { dimension: "artifact_and_motion_stability", verdict: "pass", visible_evidence: "No visible morphing." },
  ],
  usable_window: { disposition: "reject", start_sec: 0, end_sec: 0 },
  confidence: "high",
});
assert.equal(failed.overall_verdict, "reject_recommended");
assert.equal(failed.usable_window.disposition, "reject");

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-motion-audit-"));
const videoPath = path.join(temporaryRoot, "clip.mp4");
const sourcePath = path.join(temporaryRoot, "source.png");
await fs.writeFile(videoPath, "fake-video");
await fs.writeFile(sourcePath, "fake-source");
const crypto = await import("node:crypto");
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const report = {
  status: "passed",
  clips: [{
    ...clip,
    normalized_video_path: videoPath,
    normalized_video_sha256: digest("fake-video"),
    source_image_path: sourcePath,
    source_image_sha256: digest("fake-source"),
  }],
};
const outputPath = path.join(temporaryRoot, "audit.json");
const rowCacheDir = path.join(temporaryRoot, "row-cache");
const dimensions = [
  "source_first_frame_fidelity",
  "identity_body_and_prop_continuity",
  "physical_reachability",
  "action_and_contact_continuity",
  "terminal_subject_state",
  "terminal_camera_and_composition",
  "next_shot_continuity_bridge",
  "artifact_and_motion_stability",
];
const fakeFrameExtractor = async ({ frameDir }) => {
  await fs.mkdir(frameDir, { recursive: true });
  return Promise.all([0.04, 2, 4, 6, 7.92].map(async (timestampSec, index) => {
    const framePath = path.join(frameDir, `${index}.jpg`);
    const bytes = `frame-${index}`;
    await fs.writeFile(framePath, bytes);
    return { index: index + 1, timestamp_sec: timestampSec, path: framePath, sha256: digest(bytes) };
  }));
};
const artifact = await buildGeneratedMotionCoherenceAudit({
  report,
  outputPath,
  framesRoot: path.join(temporaryRoot, "frames"),
  callsDir: path.join(temporaryRoot, "calls"),
  rowCacheDir,
  repoRoot: temporaryRoot,
  frameExtractor: fakeFrameExtractor,
  auditExecutor: async () => ({
    checks: dimensions.map((dimension) => ({ dimension, verdict: "pass", visible_evidence: `${dimension} is visibly coherent.` })),
    overall_verdict: "pass",
    usable_window: { disposition: "trim_tail", start_sec: 0, end_sec: 6 },
    confidence: "high",
    one_sentence_verdict: "The complete action is coherent through six seconds.",
  }),
});
assert.equal(artifact.summary.pass_count, 1);
assert.equal(artifact.rows[0].usable_window.disposition, "trim_tail");
assert.equal(artifact.rows[0].usable_window.end_sec, 6);

const reused = await buildGeneratedMotionCoherenceAudit({ report, outputPath, repoRoot: temporaryRoot });
assert.equal(reused.reused, true);

const prefetched = await buildGeneratedMotionCoherenceAudit({
  report: { ...report, prefetch_batch: "different aggregate provenance" },
  outputPath: path.join(temporaryRoot, "official-audit.json"),
  framesRoot: path.join(temporaryRoot, "official-frames"),
  callsDir: path.join(temporaryRoot, "official-calls"),
  rowCacheDir,
  repoRoot: temporaryRoot,
  frameExtractor: async () => { throw new Error("content-addressed rows must be reused before frame extraction"); },
  auditExecutor: async () => { throw new Error("content-addressed rows must be reused before model audit"); },
});
assert.equal(prefetched.summary.row_cache_reused_count, 1);
assert.equal(prefetched.rows[0].reuse_source, "content_addressed_row_cache");

let changedConfigurationAuditCalls = 0;
const changedConfiguration = await buildGeneratedMotionCoherenceAudit({
  report,
  outputPath,
  framesRoot: path.join(temporaryRoot, "changed-effort-frames"),
  callsDir: path.join(temporaryRoot, "changed-effort-calls"),
  rowCacheDir,
  repoRoot: temporaryRoot,
  reasoningEffort: "high",
  frameExtractor: fakeFrameExtractor,
  auditExecutor: async () => {
    changedConfigurationAuditCalls += 1;
    return {
      checks: dimensions.map((dimension) => ({ dimension, verdict: "pass", visible_evidence: `${dimension} remains coherent.` })),
      usable_window: { disposition: "full_clip", start_sec: 0, end_sec: 8 },
      confidence: "high",
    };
  },
});
assert.equal(changedConfigurationAuditCalls, 1, "a changed audit configuration must not reuse a row from another effort policy");
assert.equal(changedConfiguration.summary.row_cache_reused_count, 0);

await fs.rm(temporaryRoot, { recursive: true, force: true });
console.log("generated motion coherence audit tests passed");
