import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  hashFile,
  ltxPlanHash,
  sha256,
} from "../lib/ltx-video-contract.mjs";

const execFile = promisify(execFileCb);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const animationScript = path.join(repoRoot, "scripts", "visual-animation-plan.mjs");
const ltxScript = path.join(repoRoot, "scripts", "ltx-video-generate.mjs");
const approvalScript = path.join(repoRoot, "scripts", "ltx-video-approve.mjs");
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-ltx-revalidation-"));
const ltxDir = path.join(tempDir, "assets", "motion", "ltx23");
await fs.mkdir(ltxDir, { recursive: true });

const identityPath = path.join(tempDir, "run_identity.json");
const beatPath = path.join(tempDir, "visual_beat_plan.json");
const promptPath = path.join(tempDir, "section_image_prompts_hardened.json");
const imagegenPath = path.join(tempDir, "imagegen_report_ep_01.json");
const imageQaPath = path.join(tempDir, "image_output_qa_ep_01.json");
const directionPath = path.join(tempDir, "animation_direction_plan_ep_01.json");
const planPath = path.join(ltxDir, "ltx_video_plan_ep_01.json");
const reportPath = path.join(ltxDir, "ltx_video_report_ep_01.json");
const approvalPath = path.join(ltxDir, "ltx_video_approval_ep_01.json");
const imagePaths = [path.join(tempDir, "cut_001.png"), path.join(tempDir, "cut_002.png")];
const videoPath = path.join(ltxDir, "cut_001-candidate-01.mp4");
await Promise.all([
  fs.writeFile(imagePaths[0], "accepted-source-one"),
  fs.writeFile(imagePaths[1], "accepted-source-two"),
  fs.writeFile(videoPath, "normalized-video-one"),
]);
const imageHashes = await Promise.all(imagePaths.map(hashFile));
const videoHash = await hashFile(videoPath);

const intent = (subjectMotion) => ({
  eligibility: "animate",
  shot_class: "physical_contact",
  start_state: "Joey's hand rests beside the control key.",
  subject_motion: subjectMotion,
  camera_motion: "A slow push toward Joey's hand.",
  environmental_motion: "One status light fades.",
  end_state: "Joey holds the key while the panel stays dark.",
  timing_priority: "early_action",
  animation_ready_composition: "Keep Joey's hand and the panel fully visible.",
  continuity_bridge: "Hold the key at frame right for the next shot.",
  sequence_eligible_with_next: false,
  preferred_generation_duration_sec: 6,
  camera_end_state: "A tight stable insert on Joey's hand.",
  end_frame_composition: "The key fills frame right and the dark panel remains at left.",
  locked_elements: ["Joey identity", "control key", "dark panel"],
});
const providerPrompts = [
  "Joey reaches toward one control key beside a dark panel.",
  "Joey closes his hand around one control key beside a dark panel.",
];
const makePrompts = (timings) => providerPrompts.map((providerPrompt, index) => ({
  image_id: `cut_00${index + 1}`,
  scene_id: "scene_control_room",
  visual_beat_id: `beat_00${index + 1}`,
  start_sec: timings[index].start,
  duration_sec: timings[index].duration,
  image_generation_required: true,
  visual_beat_action: index === 0 ? "Joey reaches for the key." : "Joey closes his hand.",
  visual_beat_script_excerpt: index === 0 ? "First repaired line." : "Second repaired line.",
  provider_prompt: providerPrompt,
  image_prompt: providerPrompt,
  modelslab_image_prompt: providerPrompt,
  prompt_hash: sha256(providerPrompt),
  image_provider_route: "modelslab",
  image_model_route: "flux-klein",
  shot_manifest: {
    visible_characters: ["joey"],
    animation_intent: intent(index === 0
      ? "Joey reaches toward the key once."
      : "Joey closes his hand around the key once."),
  },
}));

const originalTimings = [{ start: 0, duration: 4 }, { start: 4, duration: 4 }];
let currentPrompts = makePrompts(originalTimings);
await Promise.all([
  fs.writeFile(identityPath, `${JSON.stringify({ animation_policy: "full_ltx23" }, null, 2)}\n`),
  fs.writeFile(beatPath, `${JSON.stringify({
    status: "passed",
    beats: currentPrompts.map((row) => ({
      visual_beat_id: row.visual_beat_id,
      foreground_action: row.visual_beat_action,
      animation_intent: row.shot_manifest.animation_intent,
    })),
  }, null, 2)}\n`),
  fs.writeFile(promptPath, `${JSON.stringify({ status: "passed", prompts: currentPrompts }, null, 2)}\n`),
  fs.writeFile(imagegenPath, `${JSON.stringify({
    status: "passed",
    results: currentPrompts.map((row, index) => ({ image_id: row.image_id, image_path: imagePaths[index] })),
  }, null, 2)}\n`),
  fs.writeFile(imageQaPath, `${JSON.stringify({
    status: "passed",
    accepted_image_hashes: { cut_001: imageHashes[0], cut_002: imageHashes[1] },
  }, null, 2)}\n`),
]);

const animationArgs = [
  animationScript,
  "--episode-dir", tempDir,
  "--run-identity", identityPath,
  "--beats", beatPath,
  "--prompts", promptPath,
  "--imagegen-report", imagegenPath,
  "--image-output-qa", imageQaPath,
  "--output", directionPath,
];
await execFile(process.execPath, animationArgs, { cwd: repoRoot });
const originalDirection = JSON.parse(await fs.readFile(directionPath, "utf8"));
assert.equal(originalDirection.direction_count, 2);
originalDirection.channel = "fixture-channel";
originalDirection.series_slug = "fixture-series";
originalDirection.week = "fixture-week";
await fs.writeFile(directionPath, `${JSON.stringify(originalDirection, null, 2)}\n`);

const planClips = originalDirection.directions.map((row) => ({
  image_id: row.image_id,
  scene_id: row.scene_id,
  visual_beat_id: row.visual_beat_id,
  start_sec: row.start_sec,
  cut_duration_sec: row.cut_duration_sec,
  duration_sec: row.requested_generation_duration_sec,
  animation_sequence_id: row.animation_sequence_id,
  sequence_mode: row.sequence_mode,
  sequence_timeline_duration_sec: row.sequence_timeline_duration_sec,
  coverage: row.coverage,
  start_frame_contract: row.start_frame_contract,
  end_frame_contract: row.end_frame_contract,
  provider_image_inputs: row.provider_image_inputs,
  source_image_path: row.source_image_path,
  source_image_sha256: row.source_image_sha256,
  source_prompt_sha256: row.source_prompt_sha256,
  motion_prompt: row.motion_prompt,
  motion_prompt_sha256: sha256(row.motion_prompt),
  negative_prompt: row.negative_prompt,
  candidate_count: 1,
}));
const originalPlan = {
  schema: "goldflow_ltx23_video_plan_v1",
  status: "passed",
  channel: "53rebirth",
  series_slug: "fixture",
  week: "fixture-week",
  episode: "ep_01",
  proof: false,
  provider: "modelslab",
  model_id: "ltx-2.3",
  resolution: "16:9",
  provider_image_inputs: ["init_image"],
  automatic_generation_retries: 0,
  animation_direction_plan_path: directionPath,
  source_hashes: { ...originalDirection.source_hashes, [directionPath]: await hashFile(directionPath) },
  clip_count: 2,
  clips: planClips,
  updated_at: new Date().toISOString(),
};
originalPlan.plan_sha256 = ltxPlanHash(originalPlan);
await fs.writeFile(planPath, `${JSON.stringify(originalPlan, null, 2)}\n`);
const generatedRow = {
  ...planClips[0],
  candidate_id: "cut_001-candidate-01",
  candidate_index: 1,
  creative_generation_attempt: 1,
  automatic_generation_retry_allowed: false,
  requested_duration_sec: planClips[0].duration_sec,
  request_id: 123456,
  normalized_video_path: videoPath,
  normalized_video_sha256: videoHash,
  normalized_probe: { duration_sec: 6, width: 1920, height: 1080, fps: 24, has_audio: false },
  status: "generated",
};
delete generatedRow.duration_sec;
delete generatedRow.motion_prompt;
delete generatedRow.negative_prompt;
delete generatedRow.candidate_count;
delete generatedRow.provider_image_inputs;
const omittedRow = {
  ...planClips[1],
  candidate_id: "cut_002-candidate-01",
  candidate_index: 1,
  creative_generation_attempt: 1,
  automatic_generation_retry_allowed: false,
  requested_duration_sec: planClips[1].duration_sec,
  request_id: null,
  normalized_video_path: null,
  normalized_video_sha256: null,
  status: "omitted",
  disposition: "accepted_still_fallback",
  omission_stage: "creative_generation_submission",
  error: "fixture omission",
};
delete omittedRow.duration_sec;
delete omittedRow.motion_prompt;
delete omittedRow.negative_prompt;
delete omittedRow.candidate_count;
delete omittedRow.provider_image_inputs;
const originalReport = {
  schema: "goldflow_ltx23_video_report_v1",
  status: "passed",
  channel: "53rebirth",
  series_slug: "fixture",
  week: "fixture-week",
  episode: "ep_01",
  proof: false,
  provider: "modelslab",
  model_id: "ltx-2.3",
  plan_path: planPath,
  plan_sha256: await hashFile(planPath),
  plan_contract_sha256: originalPlan.plan_sha256,
  source_hashes: originalPlan.source_hashes,
  candidate_policy: "one_candidate_per_motion_moment",
  automatic_generation_retries: 0,
  planned_count: 2,
  attempted_count: 2,
  creative_submission_count: 2,
  creative_resubmission_count: 0,
  clip_count: 1,
  generated_count: 1,
  failed_count: 0,
  omitted_count: 1,
  omitted_disposition: "accepted_still_fallback",
  clips: [generatedRow],
  omitted_clips: [omittedRow],
  updated_at: new Date().toISOString(),
};
await fs.writeFile(reportPath, `${JSON.stringify(originalReport, null, 2)}\n`);
const originalReportHash = await hashFile(reportPath);
await fs.writeFile(approvalPath, `${JSON.stringify({
  schema: "goldflow_ltx23_video_approval_v1",
  status: "passed",
  channel: "53rebirth",
  series_slug: "fixture",
  week: "fixture-week",
  episode: "ep_01",
  proof: false,
  production_eligible: true,
  report_path: reportPath,
  report_sha256: originalReportHash,
  accepted_count: 1,
  rejected_count: 0,
  decisions: [{
    image_id: "cut_001",
    candidate_id: "cut_001-candidate-01",
    decision: "accepted",
    source_image_sha256: imageHashes[0],
    video_sha256: videoHash,
    reviewer: "fixture-reviewer",
    note: "Original clip review.",
  }],
  reviewer: "fixture-reviewer",
  note: "Original clip review.",
  updated_at: new Date().toISOString(),
}, null, 2)}\n`);

currentPrompts = makePrompts([{ start: 0.5, duration: 4.5 }, { start: 5, duration: 3.5 }]);
await fs.writeFile(promptPath, `${JSON.stringify({ status: "passed", prompts: currentPrompts }, null, 2)}\n`);
await execFile(process.execPath, [...animationArgs, "--revalidate-existing", "true"], { cwd: repoRoot });
const revalidatedDirection = JSON.parse(await fs.readFile(directionPath, "utf8"));
assert.equal(revalidatedDirection.timing_revalidated_without_creative_replan, true);
assert.equal(revalidatedDirection.channel, "fixture-channel");
assert.equal(revalidatedDirection.series_slug, "fixture-series");
assert.equal(revalidatedDirection.week, "fixture-week");
assert.deepEqual(
  revalidatedDirection.directions.map((row) => row.animation_sequence_id),
  originalDirection.directions.map((row) => row.animation_sequence_id),
);
assert.deepEqual(revalidatedDirection.directions.map((row) => row.start_sec), [0.5, 5]);
assert.deepEqual(revalidatedDirection.directions.map((row) => row.cut_duration_sec), [4.5, 3.5]);
for (let index = 0; index < 2; index += 1) {
  const before = originalDirection.directions[index];
  const after = revalidatedDirection.directions[index];
  assert.equal(after.source_image_path, before.source_image_path);
  assert.equal(after.source_image_sha256, before.source_image_sha256);
  assert.equal(after.source_prompt_sha256, before.source_prompt_sha256);
  assert.equal(after.motion_prompt, before.motion_prompt);
  assert.equal(after.negative_prompt, before.negative_prompt);
  assert.equal(after.requested_generation_duration_sec, before.requested_generation_duration_sec);
  assert.deepEqual(after.start_frame_contract, before.start_frame_contract);
  assert.deepEqual(after.end_frame_contract, before.end_frame_contract);
}

const ltxArgs = [
  ltxScript,
  "--episode-dir", tempDir,
  "--run-identity", identityPath,
  "--prompts", promptPath,
  "--imagegen-report", imagegenPath,
  "--image-output-qa", imageQaPath,
  "--animation-direction-plan", directionPath,
  "--plan", planPath,
  "--output", reportPath,
  "--revalidate-existing", "true",
];
await execFile(process.execPath, ltxArgs, {
  cwd: repoRoot,
  env: { ...process.env, MODELSLAB_API_KEY: "must-not-be-used" },
});
const revalidatedPlan = JSON.parse(await fs.readFile(planPath, "utf8"));
const revalidatedReport = JSON.parse(await fs.readFile(reportPath, "utf8"));
assert.equal(revalidatedReport.timing_revalidated_without_provider_submission, true);
assert.equal(revalidatedReport.generation_requests_submitted, 0);
assert.equal(revalidatedReport.creative_resubmission_count, 0);
assert.equal(revalidatedReport.creative_submission_count, 2);
assert.equal(revalidatedReport.clip_count, 1);
assert.equal(revalidatedReport.omitted_count, 1);
assert.deepEqual(
  [...revalidatedReport.clips, ...revalidatedReport.omitted_clips].map((row) => row.candidate_id).sort(),
  ["cut_001-candidate-01", "cut_002-candidate-01"],
);
assert.equal(revalidatedReport.clips[0].request_id, 123456);
assert.equal(revalidatedReport.clips[0].normalized_video_path, videoPath);
assert.equal(revalidatedReport.clips[0].normalized_video_sha256, videoHash);
assert.deepEqual(revalidatedPlan.clips.map((row) => row.duration_sec), originalPlan.clips.map((row) => row.duration_sec));
assert.deepEqual(revalidatedPlan.clips.map((row) => row.motion_prompt_sha256), originalPlan.clips.map((row) => row.motion_prompt_sha256));
assert.deepEqual(revalidatedPlan.clips.map((row) => row.start_sec), [0.5, 5]);
assert.deepEqual(revalidatedPlan.clips.map((row) => row.cut_duration_sec), [4.5, 3.5]);
assert.equal(revalidatedReport.timing_revalidated_from_report_sha256, originalReportHash);

await execFile(process.execPath, [
  approvalScript,
  "--episode-dir", tempDir,
  "--report", reportPath,
  "--output", approvalPath,
  "--revalidate-existing", "true",
], { cwd: repoRoot });
const reboundApproval = JSON.parse(await fs.readFile(approvalPath, "utf8"));
assert.equal(reboundApproval.timing_revalidated_without_review_change, true);
assert.equal(reboundApproval.report_sha256, await hashFile(reportPath));
assert.equal(reboundApproval.decisions[0].decision, "accepted");
assert.equal(reboundApproval.decisions[0].note, "Original clip review.");

await execFile(process.execPath, [
  approvalScript,
  "--episode-dir", tempDir,
  "--report", reportPath,
  "--output", approvalPath,
  "--reject-ids", "cut_001-candidate-01",
  "--reviewer", "final-qa-reviewer",
  "--note", "Final QA found one additional generated-motion defect; use the accepted still fallback.",
], { cwd: repoRoot });
const revisedApproval = JSON.parse(await fs.readFile(approvalPath, "utf8"));
assert.equal(revisedApproval.accepted_count, 0);
assert.equal(revisedApproval.rejected_count, 1);
assert.equal(revisedApproval.decisions[0].decision, "rejected");

const directionHashBeforeCreativeMismatch = await hashFile(directionPath);
const mismatchedPrompts = structuredClone(currentPrompts);
mismatchedPrompts[0].provider_prompt = "A creatively different frame that was never generated.";
await fs.writeFile(promptPath, `${JSON.stringify({ status: "passed", prompts: mismatchedPrompts }, null, 2)}\n`);
await assert.rejects(
  execFile(process.execPath, [...animationArgs, "--revalidate-existing", "true"], { cwd: repoRoot }),
  /creative\/hash mismatch/u,
);
assert.equal(await hashFile(directionPath), directionHashBeforeCreativeMismatch);
await fs.writeFile(promptPath, `${JSON.stringify({ status: "passed", prompts: currentPrompts }, null, 2)}\n`);

const reportHashBeforeMediaMismatch = await hashFile(reportPath);
const planHashBeforeMediaMismatch = await hashFile(planPath);
await fs.writeFile(videoPath, "corrupt-replacement-video");
await assert.rejects(
  execFile(process.execPath, ltxArgs, { cwd: repoRoot }),
  /normalized-video hash mismatch/u,
);
assert.equal(await hashFile(reportPath), reportHashBeforeMediaMismatch);
assert.equal(await hashFile(planPath), planHashBeforeMediaMismatch);
await fs.writeFile(videoPath, "normalized-video-one");

console.log("ltx zero-submit timing revalidation tests passed");
