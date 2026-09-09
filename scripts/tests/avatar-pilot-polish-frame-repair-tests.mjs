import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { POLISH_FRAME_REPAIR_SCHEMA, validatePolishFrameRepairShape, validatePolishFrameRepairScope, preparePolishFrameRepair } from "../lib/avatar-pilot-polish-frame-repair.mjs";
import { SENTRY_POLISH_EDITORIAL } from "../lib/sentry-polish-editorial.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ref = (file) => ({ path: file, sha256: hash(file) });
const clone = structuredClone;
const identity = ref("/fixture/run_identity.json");
const request = {
  candidate_id: "polish-v1", identity_sha256: identity.sha256,
  duration_frames: 2700, width: 1920, height: 1080, fps: 30,
  production_eligible: false, publish_allowed: false,
  polish_authorization: { authorizes_sound_motion_polish: true },
  narration_placements: [{ source_in_sec: 0, source_out_sec: 72.22, output_in_sec: 0.2 }],
  recipe: { timeline: { ...clone(SENTRY_POLISH_EDITORIAL), soundtrack: [{ id: "fixture_cue" }] } },
  soundtrack_manifest: ref("/fixture/pilot_media_work/polish_audio_v1/manifest.json"),
};
const prior = {
  schema: "goldflow_avatar_pilot_program_review_result_v1", status: "awaiting_program_review", identity,
  request: ref("/fixture/pilot_media_work/polish_request/request.json"), output: ref("/fixture/pilot_program_reviews/polish-v1/proof.mp4"),
  technical_report: ref("/fixture/pilot_program_reviews/polish-v1/render-qa.json"),
  duration_frames: 2700, width: 1920, height: 1080, fps: 30, provider_calls: 0,
  official_stage_completed: false, exact_program_approval_recorded: false, production_eligible: false, publish_allowed: false,
};
const qa = {
  schema: "goldflow_avatar_program_polish_render_qa_v1", duration_frames: 2700, review_only: true, exact_program_approval_recorded: false,
  audio: { master: ref("/fixture/pilot_program_reviews/polish-v1/program-mix-mastered.wav"), narration_tempo: 1, accepted_master_unchanged: true,
    placements: request.narration_placements, source_audio: request.recipe.timeline.source_audio, soundtrack: request.recipe.timeline.soundtrack,
    soundtrack_manifest: request.soundtrack_manifest },
  frames: [{ frame: 2123, ...ref("/fixture/pilot_program_reviews/polish-v1/24_objective_approaches_exit.png") }],
};
const next = { ...clone(request), candidate_id: "polish-v1-card-repair", polish_frame_repair: {
  schema: POLISH_FRAME_REPAIR_SCHEMA, cause: "route_chip_clipped_before_camera_reframe",
  interval: { start_frame: 2079, end_frame: 2145 }, repair: "recompose_exact_span_preserve_other_frames_and_aac",
  prior_program: ref("/fixture/pilot_program_reviews/polish-v1/result.json"), prior_request: prior.request,
  prior_qa: prior.technical_report, prior_video: prior.output, preserved_master: qa.audio.master,
  defect_evidence: { path: qa.frames[0].path, sha256: qa.frames[0].sha256 },
  operator_scope: { reviewer: "Fixture only", note: "Synthetic quality-polish direction, not a real human acceptance.",
    operator_messages: ["Fixture-only deterministic quality defect repair."], authorizes_quality_defect_repair: true },
} };
assert.equal(validatePolishFrameRepairShape(next), next);
validatePolishFrameRepairScope(next, request, prior, qa, identity);
const deny = (change, pattern = /Polish frame repair blocked/) => {
  const value = clone(next); change(value);
  assert.throws(() => validatePolishFrameRepairScope(value, request, prior, qa, identity), pattern);
};
deny((value) => { value.polish_frame_repair.interval.start_frame--; }, /66-frame/);
deny((value) => { value.polish_frame_repair.interval.end_frame++; }, /66-frame/);
deny((value) => { value.polish_frame_repair.repair = "render_entire_program_again"; }, /66-frame/);
deny((value) => { value.polish_frame_repair.cause = "creative_revision"; }, /66-frame/);
deny((value) => { value.duration_frames = 2701; }, /90-second/);
deny((value) => { value.publish_allowed = true; }, /private/);
deny((value) => { value.polish_frame_repair.operator_scope.authorizes_quality_defect_repair = false; }, /actual quality/);
deny((value) => { value.polish_frame_repair.program_approval = true; value.polish_frame_repair.approved = true; }, /invent/);
deny((value) => { value.narration_placements[0].output_in_sec += 1; }, /cannot change/);
deny((value) => { value.recipe.timeline.source_audio[0].gain_db--; }, /cannot change/);
deny((value) => { value.recipe.timeline.soundtrack[0].id = "new_cue"; }, /cannot change/);
deny((value) => { value.recipe.timeline.shots[23].heading = "different edit"; }, /cannot change/);
deny((value) => { value.polish_frame_repair.prior_video.sha256 = hash("different source"); }, /successful private polish/);
deny((value) => { value.polish_frame_repair.preserved_master.sha256 = hash("different mix"); }, /complete measured/);
deny((value) => { value.polish_frame_repair.defect_evidence.sha256 = hash("another image"); }, /defect evidence/);
assert.throws(() => validatePolishFrameRepairScope(next, { ...request, polish_frame_repair: {} }, prior, qa, identity), /never a chained repair/);
assert.throws(() => validatePolishFrameRepairScope(next, request, { ...prior, status: "failed" }, qa, identity), /successful private polish/);
assert.throws(() => validatePolishFrameRepairScope(next, request, prior, { ...qa, exact_program_approval_recorded: true }, identity), /complete measured/);
assert.throws(() => validatePolishFrameRepairScope(next, request, prior, { ...qa, frames: [{ ...qa.frames[0], frame: 2200 }] }, identity), /defect evidence/);

const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-frame-repair-test-")));
try {
  const file = path.join(directory, "result.json"); await fs.writeFile(file, JSON.stringify(prior));
  const stale = clone(next); stale.polish_frame_repair.prior_program = { path: file, sha256: hash("stale") };
  await assert.rejects(() => preparePolishFrameRepair({ manifest: stale, refs: [], identity }, directory), /stale retained artifact/);
  assert.deepEqual(await fs.readdir(directory), ["result.json"], "invalid scope performs no new render writes");
} finally { await fs.rm(directory, { recursive: true }); }
console.log("Polish frame-repair scope tests passed: exact 66 frames, immutable edit/audio, real retained evidence, no chained replay or new approval.");
