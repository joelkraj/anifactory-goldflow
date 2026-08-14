import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  LTX_SINGLE_SHOT_POLICY,
  clampLtxDuration,
  approvedLtxCoverageByImage,
  hashFile,
  ltxApprovalMatches,
  ltxMotionPromptForCut,
  ltxMotionPromptForSequence,
  ltxNegativePrompt,
  ltxProviderPayloadForClip,
  ltxSingleShotIntentFindings,
  normalizeLtxVideoPolicy,
  sanitizeAnimationIntent,
} from "../lib/ltx-video-contract.mjs";
import {
  publicLtxClipResult,
  publicLtxModelslabAccountPool,
  redactLtxAccountProfileNames,
} from "../lib/ltx-video-report-contract.mjs";

const execFile = promisify(execFileCb);

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
assert.match(richFallbackPrompt, /Starting physical state.*both characters face each other/u);
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
assert.throws(() => ltxMotionPromptForSequence({
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
}), /single-shot.*multi-cut transformation/u);
assert.equal(ltxMotionPromptForCut({ ltx_video_prompt: "Authored motion." }), "Authored motion.");

const completeSingleShotIntent = {
  eligibility: "animate",
  shot_class: "physical_contact",
  start_state: "Joey's open hand rests beside the inert control panel",
  subject_motion: "Joey closes his hand around the control key once",
  camera_motion: "slow push toward his hand",
  environmental_motion: "one status light fades",
  end_state: "Joey holds the key firmly while the panel stays dark",
  animation_ready_composition: "Joey's hand and the panel are both fully visible",
  continuity_bridge: "hold the key at frame right for the next reaction shot",
  preferred_generation_duration_sec: 6,
  camera_end_state: "tight stable insert on Joey's hand",
  end_frame_composition: "the key fills frame right while the dark panel remains at left",
};
assert.deepEqual(ltxSingleShotIntentFindings(completeSingleShotIntent), []);
assert.deepEqual(
  ltxSingleShotIntentFindings({ ...completeSingleShotIntent, end_frame_composition: "" }),
  ["missing_end_frame_composition"],
);
const singleShotPrompt = ltxMotionPromptForCut({
  duration_sec: 6,
  shot_manifest: { animation_intent: completeSingleShotIntent },
});
assert.match(singleShotPrompt, /Starting physical state in the accepted first frame:/u);
assert.match(singleShotPrompt, /Terminal physical state:/u);
assert.match(singleShotPrompt, /Terminal camera state:/u);
assert.match(singleShotPrompt, /Terminal composition:/u);
assert.match(singleShotPrompt, /Next-shot continuity bridge:/u);
assert.match(singleShotPrompt, /physically reachable/u);
assert.equal(LTX_SINGLE_SHOT_POLICY.candidates_per_motion_moment, 1);
assert.equal(LTX_SINGLE_SHOT_POLICY.automatic_generation_retries, 0);
const providerPayload = ltxProviderPayloadForClip({
  init_image_url: "https://example.test/first.png",
  end_image_url: "https://example.test/forbidden.png",
  motion_prompt: singleShotPrompt,
  negative_prompt: "drift",
  duration_sec: 6,
}, { trackId: "fixture-track" });
assert.equal(providerPayload.init_image, "https://example.test/first.png");
assert.equal(Object.hasOwn(providerPayload, "end_image"), false);
assert.equal(Object.hasOwn(providerPayload, "end_image_url"), false);
assert.deepEqual(LTX_SINGLE_SHOT_POLICY.provider_image_inputs, ["init_image"]);

const privateAccount = {
  profile: "fixture-secondary",
  apiKey: "fixture-secret-key",
  email: "operator@example.com",
  fingerprint: "ml_fixture1234",
  credential_source: "modelslab_cli_profile",
};
const publicAccountPool = publicLtxModelslabAccountPool([privateAccount]);
const publicClip = publicLtxClipResult({
  image_id: "cut_account_fixture",
  candidate_id: "cut_account_fixture-candidate-01",
  candidate_index: 1,
  creative_generation_attempt: 1,
  automatic_generation_retry_allowed: false,
  duration_sec: 5,
  modelslab_account: privateAccount,
  status: "omitted",
  disposition: "accepted_still_fallback",
  omission_stage: "creative_generation_submission",
  error: "ModelsLab CLI profile fixture-secondary failed.",
}, { accountProfiles: [privateAccount.profile] });
const persistedProvenance = JSON.stringify({
  modelslab_account_pool: publicAccountPool,
  clips: [publicClip],
});
assert.deepEqual(publicAccountPool, [{
  fingerprint: "ml_fixture1234",
  credential_source: "modelslab_cli_profile",
}]);
assert.equal(publicClip.modelslab_account_fingerprint, "ml_fixture1234");
assert.equal(publicClip.modelslab_account_credential_source, "modelslab_cli_profile");
assert.equal(publicClip.creative_generation_attempt, 1);
assert.equal(publicClip.automatic_generation_retry_allowed, false);
assert.equal(publicClip.disposition, "accepted_still_fallback");
assert.equal(publicClip.omission_stage, "creative_generation_submission");
assert.equal(Object.hasOwn(publicClip, "modelslab_account_profile"), false);
assert.doesNotMatch(persistedProvenance, /fixture-secondary/u);
assert.doesNotMatch(persistedProvenance, /fixture-secret-key/u);
assert.doesNotMatch(persistedProvenance, /operator@example\.com/u);
assert.match(persistedProvenance, /ml_fixture1234/u);
assert.match(persistedProvenance, /modelslab_cli_profile/u);
assert.equal(
  redactLtxAccountProfileNames("Profile fixture-secondary failed", ["fixture-secondary"]),
  "Profile [redacted-account-profile] failed",
);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-ltx-test-"));
const sourcePath = path.join(tempDir, "source.png");
const videoPath = path.join(tempDir, "clip.mp4");
const reportPath = path.join(tempDir, "report.json");
await fs.writeFile(sourcePath, "source");
await fs.writeFile(videoPath, "video");
const identityFixturePath = path.join(tempDir, "run_identity.json");
const beatFixturePath = path.join(tempDir, "visual_beat_plan.json");
const promptFixturePath = path.join(tempDir, "section_image_prompts_hardened.json");
const imagegenFixturePath = path.join(tempDir, "imagegen_report_ep_01.json");
const imageQaFixturePath = path.join(tempDir, "image_output_qa_ep_01.json");
const directionFixturePath = path.join(tempDir, "animation_direction_plan_ep_01.json");
const acceptedSourceHash = await hashFile(sourcePath);
const promptFixtureRows = ["cut_001", "cut_002"].map((imageId, index) => ({
  image_id: imageId,
  scene_id: "scene_same_room",
  visual_beat_id: `beat_00${index + 1}`,
  start_sec: index * 4,
  duration_sec: 4,
  image_generation_required: true,
  visual_beat_action: index === 0 ? "Joey reaches for the key" : "Joey closes his hand",
  shot_manifest: {
    visible_characters: ["joey"],
    animation_intent: {
      ...completeSingleShotIntent,
      sequence_eligible_with_next: true,
      subject_motion: index === 0
        ? "Joey reaches toward the key once"
        : "Joey closes his hand around the key once",
    },
  },
}));
promptFixtureRows.push({
  image_id: "cut_003",
  scene_id: "scene_same_room",
  visual_beat_id: "beat_003",
  start_sec: 8,
  duration_sec: 4,
  image_generation_required: true,
  shot_manifest: {
    animation_intent: { ...completeSingleShotIntent, end_state: "" },
  },
});
await Promise.all([
  fs.writeFile(identityFixturePath, `${JSON.stringify({
    animation_policy: "selective_ltx23",
    generated_motion_required_through_sec: 8,
  })}\n`),
  fs.writeFile(beatFixturePath, `${JSON.stringify({
    status: "passed",
    beats: promptFixtureRows.map((row) => ({
      visual_beat_id: row.visual_beat_id,
      animation_intent: row.shot_manifest.animation_intent,
    })),
  })}\n`),
  fs.writeFile(promptFixturePath, `${JSON.stringify({ status: "passed", prompts: promptFixtureRows })}\n`),
  fs.writeFile(imagegenFixturePath, `${JSON.stringify({
    status: "passed",
    results: promptFixtureRows.slice(0, 2).map((row) => ({ image_id: row.image_id, image_path: sourcePath })),
  })}\n`),
  fs.writeFile(imageQaFixturePath, `${JSON.stringify({
    status: "passed",
    accepted_image_hashes: { cut_001: acceptedSourceHash, cut_002: acceptedSourceHash },
  })}\n`),
]);
await execFile(process.execPath, [
  path.resolve("scripts/visual-animation-plan.mjs"),
  "--episode-dir", tempDir,
  "--run-identity", identityFixturePath,
  "--beats", beatFixturePath,
  "--prompts", promptFixturePath,
  "--imagegen-report", imagegenFixturePath,
  "--image-output-qa", imageQaFixturePath,
  "--output", directionFixturePath,
]);
const directionFixture = JSON.parse(await fs.readFile(directionFixturePath, "utf8"));
assert.equal(directionFixture.status, "passed");
assert.equal(directionFixture.direction_count, 2);
assert.equal(directionFixture.candidate_generation_count, 2);
assert.equal(directionFixture.required_motion_through_sec, 8);
assert.equal(directionFixture.required_motion_direction_count, 2);
assert.equal(directionFixture.still_fallback_count, 1);
assert.equal(directionFixture.still_fallbacks[0].image_id, "cut_003");
assert.equal(directionFixture.still_fallbacks[0].disposition, "accepted_still_fallback");
for (const direction of directionFixture.directions) {
  assert.equal(direction.sequence_mode, "standalone_shot");
  assert.equal(direction.coverage.length, 1);
  assert.equal(direction.coverage[0].image_id, direction.image_id);
  assert.equal(direction.candidate_count, 1);
  assert.deepEqual(direction.provider_image_inputs, ["init_image"]);
  assert.equal(direction.end_frame_contract.provider_input, false);
  assert.ok(direction.end_frame_contract.state);
  assert.ok(direction.end_frame_contract.camera_state);
  assert.ok(direction.end_frame_contract.composition);
  assert.ok(direction.end_frame_contract.continuity_bridge);
}
const blockedOpeningPromptPath = path.join(tempDir, "section_image_prompts_blocked_opening.json");
const blockedOpeningOutputPath = path.join(tempDir, "animation_direction_plan_blocked_opening.json");
await fs.writeFile(blockedOpeningPromptPath, `${JSON.stringify({
  status: "passed",
  prompts: promptFixtureRows.map((row, index) => index === 1 ? {
    ...row,
    shot_manifest: {
      ...row.shot_manifest,
      animation_intent: { ...row.shot_manifest.animation_intent, eligibility: "still_preferred" },
    },
  } : row),
})}\n`);
await assert.rejects(
  execFile(process.execPath, [
    path.resolve("scripts/visual-animation-plan.mjs"),
    "--episode-dir", tempDir,
    "--run-identity", identityFixturePath,
    "--beats", beatFixturePath,
    "--prompts", blockedOpeningPromptPath,
    "--imagegen-report", imagegenFixturePath,
    "--image-output-qa", imageQaFixturePath,
    "--output", blockedOpeningOutputPath,
  ]),
  /Required generated-motion opening coverage is incomplete/u,
);
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

const emptyReportPath = path.join(tempDir, "empty-ltx-report.json");
const emptyReport = {
  schema: "goldflow_ltx23_video_report_v1",
  status: "passed",
  planned_count: 2,
  generated_count: 0,
  failed_count: 0,
  omitted_count: 2,
  omitted_disposition: "accepted_still_fallback",
  clips: [],
  omitted_clips: [{ image_id: "cut_a" }, { image_id: "cut_b" }],
};
await fs.writeFile(emptyReportPath, `${JSON.stringify(emptyReport)}\n`);
const emptyApproval = {
  schema: "goldflow_ltx23_video_approval_v1",
  status: "passed",
  report_sha256: await hashFile(emptyReportPath),
  accepted_count: 0,
  rejected_count: 0,
  decisions: [],
};
assert.equal(await ltxApprovalMatches(emptyReport, emptyApproval, { reportPath: emptyReportPath }), true);
assert.equal((await approvedLtxCoverageByImage(emptyReport, emptyApproval, { reportPath: emptyReportPath })).size, 0);
const emptyApprovalPath = path.join(tempDir, "empty-ltx-approval.json");
await execFile(process.execPath, [
  path.resolve("scripts/ltx-video-approve.mjs"),
  "--episode-dir", tempDir,
  "--report", emptyReportPath,
  "--output", emptyApprovalPath,
  "--reviewer", "fixture-reviewer",
  "--note", "No generated clips survived; accepted stills remain authoritative.",
]);
const emptyApprovalFromCli = JSON.parse(await fs.readFile(emptyApprovalPath, "utf8"));
assert.equal(emptyApprovalFromCli.status, "passed");
assert.equal(emptyApprovalFromCli.accepted_count, 0);
assert.equal(emptyApprovalFromCli.rejected_count, 0);

console.log("ltx video tests passed");
