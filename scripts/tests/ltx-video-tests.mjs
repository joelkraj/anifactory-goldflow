import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clampLtxDuration,
  approvedLtxCoverageByImage,
  hashFile,
  ltxApprovalMatches,
  ltxMotionPromptForCut,
  ltxMotionPromptForSequence,
  ltxNegativePrompt,
  normalizeLtxVideoPolicy,
  sanitizeAnimationIntent,
} from "../lib/ltx-video-contract.mjs";

assert.equal(normalizeLtxVideoPolicy("selective-ltx23"), "selective_ltx23");
assert.equal(normalizeLtxVideoPolicy("full_ltx23"), "full_ltx23");
assert.throws(() => normalizeLtxVideoPolicy("always"), /Unsupported LTX video policy/);
assert.equal(clampLtxDuration(2), 5);
assert.equal(clampLtxDuration(8.6), 9);
assert.equal(clampLtxDuration(20), 12);

const fallbackPrompt = ltxMotionPromptForCut({
  modelslab_image_prompt: "A hero holds a glowing sword in a ruined hall.",
  shot_manifest: {
    motion_intent: {
      behavior: "slow_push_in",
      focal_subject: "the hero",
      editorial_reason: "reveal resolve",
    },
  },
});
assert.match(fallbackPrompt, /accepted image as the exact first frame/);
assert.match(fallbackPrompt, /slow_push_in/);
assert.match(fallbackPrompt, /No new people/);
const richFallbackPrompt = ltxMotionPromptForCut({
  modelslab_image_prompt: "",
  image_prompt: "A complete apartment confrontation with two characters and a desk.",
  duration_sec: 2,
  animation_intent: {
    eligibility: "animate",
    shot_class: "dialogue_pair",
    start_state: "both characters face each other",
    subject_motion: "the woman looks away while the man raises his eyes",
    camera_motion: "a slow push toward the man",
    environmental_motion: "a curtain moves gently",
    end_state: "both settle with visible emotional distance",
    timing_priority: "early_action",
    animation_ready_composition: "separate silhouettes",
    continuity_bridge: "the woman is ready to leave",
    locked_elements: ["faces", "wardrobe", "desk"],
  },
});
assert.doesNotMatch(richFallbackPrompt, /complete apartment confrontation/);
assert.doesNotMatch(richFallbackPrompt, /both characters face each other/);
assert.match(richFallbackPrompt, /woman looks away/);
assert.match(richFallbackPrompt, /from 0\.0 to 1\.8 seconds/);
assert.match(richFallbackPrompt, /exact text legibility is not required/);
assert.doesNotMatch(ltxNegativePrompt(), /text mutation/);
const sequenceIntent = sanitizeAnimationIntent({
  eligibility: "animate",
  shot_class: "ui_or_screen",
  subject_motion: "screen pulses",
  camera_motion: "locked",
  end_state: "settles",
  sequence_eligible_with_next: true,
  preferred_generation_duration_sec: 9,
  camera_end_state: "locked medium framing",
  end_frame_composition: "screen centered",
});
assert.equal(sequenceIntent?.shot_class, "ui_or_screen");
assert.equal(sequenceIntent?.sequence_eligible_with_next, true);
assert.equal(sequenceIntent?.preferred_generation_duration_sec, 9);
const sequencePrompt = ltxMotionPromptForSequence({
  coverage: [
    {
      source_offset_sec: 0,
      source_end_offset_sec: 4,
      animation_intent: {
        ...sequenceIntent,
        subject_motion: "the screen pulses once",
      },
    },
    {
      source_offset_sec: 4,
      source_end_offset_sec: 9,
      animation_intent: {
        ...sequenceIntent,
        subject_motion: "the hero lowers his hand",
        end_state: "the hero holds still beside the dim screen",
      },
    },
  ],
});
assert.match(sequencePrompt, /Phase 1, 0\.0-4\.0 seconds/);
assert.match(sequencePrompt, /Phase 2, 4\.0-9\.0 seconds/);
assert.match(sequencePrompt, /one continuous anime\/manhwa shot/);
assert.equal(ltxMotionPromptForCut({ ltx_video_prompt: "Authored motion." }), "Authored motion.");

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-ltx-test-"));
const sourcePath = path.join(tempDir, "source.png");
const videoPath = path.join(tempDir, "clip.mp4");
const reportPath = path.join(tempDir, "report.json");
await fs.writeFile(sourcePath, "source");
await fs.writeFile(videoPath, "video");
const report = {
  schema: "goldflow_ltx23_video_report_v1",
  status: "passed",
  clips: [{
    image_id: "cut_001",
    candidate_id: "cut_001-candidate-01",
    source_image_sha256: await hashFile(sourcePath),
    normalized_video_path: videoPath,
    normalized_video_sha256: await hashFile(videoPath),
  }],
};
await fs.writeFile(reportPath, `${JSON.stringify(report)}\n`);
const approval = {
  schema: "goldflow_ltx23_video_approval_v1",
  status: "passed",
  report_sha256: await hashFile(reportPath),
  decisions: [{
    image_id: "cut_001",
    candidate_id: "cut_001-candidate-01",
    decision: "accepted",
    source_image_sha256: report.clips[0].source_image_sha256,
    video_sha256: report.clips[0].normalized_video_sha256,
  }],
};
assert.equal(await ltxApprovalMatches(report, approval, { reportPath }), true);
report.clips[0].coverage = [
  { image_id: "cut_001", image_sha256: "hash_001", source_offset_sec: 0, source_end_offset_sec: 3 },
  { image_id: "cut_002", image_sha256: "hash_002", source_offset_sec: 3, source_end_offset_sec: 5 },
];
await fs.writeFile(reportPath, `${JSON.stringify(report)}\n`);
approval.report_sha256 = await hashFile(reportPath);
const coverage = await approvedLtxCoverageByImage(report, approval, { reportPath });
assert.equal(coverage.size, 2);
assert.equal(coverage.get("cut_002").covered.source_offset_sec, 3);
approval.decisions[0].video_sha256 = "stale";
assert.equal(await ltxApprovalMatches(report, approval, { reportPath }), false);

console.log("ltx video tests passed");
