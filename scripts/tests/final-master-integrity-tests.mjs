#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildFinalMasterIntegrity,
  parseFinalMasterDiagnosticsForTests,
  renderContractFindingsForTests,
  resolvedGeneratedMotionSourceHashes,
} from "../lib/final-master-integrity.mjs";

const cleanReport = {
  output_duration_sec: 120,
  duration_integrity: { status: "passed" },
  subtitle_count: 48,
  subtitle_timeline_validated: true,
  subtitle_text_source: "audio_stitch_caption_text_word_aligned_to_whisper",
  run_identity_schema: "goldflow_run_identity_v2",
  render_motion: {
    planned_approved_generated_video_count: 3,
    generated_video_clip_count: 3,
    generated_video_clip_ids: ["cut_001", "cut_004", "cut_009"],
    motion_trace_blocker_count: 0,
    planned_transition_count: 10,
    applied_transition_count: 9,
    suppressed_continuous_ltx_transition_count: 1,
  },
};

const clean = renderContractFindingsForTests(cleanReport, 120.02);
assert.equal(clean.blockers.length, 0);
assert.equal(clean.review.length, 0);

const missingMotion = renderContractFindingsForTests({
  ...cleanReport,
  render_motion: {
    ...cleanReport.render_motion,
    generated_video_clip_count: 2,
    generated_video_clip_ids: ["cut_001", "cut_004"],
  },
}, 120);
assert.ok(missingMotion.blockers.some((row) => row.code === "approved_generated_motion_missing_from_master"));

const diagnostics = parseFinalMasterDiagnosticsForTests({
  durationSec: 100,
  videoStderr: [
    "[blackdetect] black_start:12 black_end:13 black_duration:1",
    "[freezedetect] freeze_start: 40 freeze_duration: 2.5 freeze_end: 42.5",
  ].join("\n"),
  audioStderr: "[silencedetect] silence_start: 65.2\n[silencedetect] silence_end: 67.2 | silence_duration: 2",
});
assert.equal(diagnostics.black_intervals.length, 1);
assert.equal(diagnostics.freeze_intervals.length, 1);
assert.equal(diagnostics.silence_intervals.length, 1);
assert.deepEqual(new Set(diagnostics.review_findings.map((row) => row.code)), new Set([
  "interior_black_span_detected",
  "long_frozen_span_detected",
  "interior_audio_silence_detected",
]));

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-master-integrity-"));
const generatedVideoPath = path.join(tempDir, "generated.mp4");
const generatedBytes = Buffer.from("generated-motion-fixture", "utf8");
await fs.writeFile(generatedVideoPath, generatedBytes);
const generatedSha256 = createHash("sha256").update(generatedBytes).digest("hex");
const motionPlanPath = path.join(tempDir, "motion_edit_plan_ep_01.json");
await fs.writeFile(motionPlanPath, JSON.stringify({
  motion_intents: [{
    image_id: "cut_legacy",
    generated_video_treatment: { video_path: generatedVideoPath },
  }],
}));
const legacyRenderReport = {
  ...cleanReport,
  source_hashes: { [motionPlanPath]: "fixture-motion-plan-hash" },
  render_motion: {
    ...cleanReport.render_motion,
    planned_approved_generated_video_count: 1,
    generated_video_clip_count: 1,
    generated_video_clip_ids: ["cut_legacy"],
    generated_video_source_hashes: { cut_legacy: generatedSha256 },
  },
};
assert.deepEqual(await resolvedGeneratedMotionSourceHashes(legacyRenderReport), {
  [generatedVideoPath]: generatedSha256,
});
const legacyIntegrity = await buildFinalMasterIntegrity({
  videoPath: path.join(tempDir, "master.mp4"),
  finalVideoSha256: "master-fixture-hash",
  durationSec: 120,
  renderReport: legacyRenderReport,
  renderReportPath: null,
  outputPath: null,
  scanner: async () => ({ video_stderr: "", audio_stderr: "" }),
});
assert.equal(legacyIntegrity.status, "passed");
assert.equal(legacyIntegrity.generated_motion_delivery.source_hash_checks[0].path, generatedVideoPath);

const missingSourceIntegrity = await buildFinalMasterIntegrity({
  videoPath: path.join(tempDir, "master.mp4"),
  finalVideoSha256: "master-fixture-hash",
  durationSec: 120,
  renderReport: {
    ...cleanReport,
    render_motion: {
      ...cleanReport.render_motion,
      planned_approved_generated_video_count: 1,
      generated_video_clip_count: 1,
      generated_video_clip_ids: ["cut_missing"],
      generated_video_source_hashes: { [path.join(tempDir, "missing.mp4")]: "missing-hash" },
    },
  },
  renderReportPath: null,
  outputPath: null,
  scanner: async () => ({ video_stderr: "", audio_stderr: "" }),
});
assert.ok(missingSourceIntegrity.blockers.some((row) => row.code === "generated_motion_source_stale_or_missing"));
await fs.rm(tempDir, { recursive: true, force: true });

console.log("final master integrity tests passed");
