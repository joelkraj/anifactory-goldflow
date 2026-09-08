import assert from "node:assert/strict";
import { PROGRAM_REVIEW_SCHEMA, validateProgramReviewShape, validateProgramNarrationPlacements, validateProgramRepairScope, preparePilotProgramReview } from "../lib/avatar-pilot-program-review.mjs";
import { SENTRY_PROGRAM_EDITORIAL } from "../lib/sentry-program-editorial.mjs";

const request = {
  schema: PROGRAM_REVIEW_SCHEMA, intent: "local_program_review", candidate_id: "program-v1",
  identity_sha256: "a".repeat(64), duration_frames: 2700, width: 1920, height: 1080, fps: 30,
  production_eligible: false, publish_allowed: false,
  accepted_style_preview: { path: "/fixture/pilot_visual_reviews/style-v4/result.json", sha256: "b".repeat(64) },
  style_direction_approval: { reviewer: "Fixture", note: "Fixture-only authorization, not a real operator decision.",
    operator_messages: ["Use this style for the full private review."], authorizes_full_90_second_review: true },
  narration: { asset_id: "narration_joel", source_in_sec: 0, source_out_sec: 72.22, output_in_sec: 0 },
  narration_placements: [
    { source_in_sec: 0, source_out_sec: 30, output_in_sec: 0 },
    { source_in_sec: 30, source_out_sec: 72.22, output_in_sec: 40 },
  ],
  assets: [
    { id: "narration_joel", kind: "narration", provenance: { type: "accepted_narration" } },
    { id: "host_neutral", kind: "host_pose", provenance: { type: "accepted_host_identity" } },
    { id: "host_room", kind: "background", provenance: { type: "accepted_generated" } },
  ],
  recipe: { captions: [], new_synthesis: false, added_music_or_sfx: false },
};
request.recipe.timeline = {
  width: 1920, height: 1080, fps: 30, duration_frames: 2700, production_eligible: false, publish_allowed: false,
  narration: request.narration_placements.map((row) => ({ ...row, asset_id: "narration_joel", tempo: 1,
    output_start_frame: row.output_in_sec * 30, output_end_frame: (row.output_in_sec + row.source_out_sec - row.source_in_sec) * 30 })),
  shots: [{ id: "host", start_frame: 0, end_frame: 2700, type: "room", truth_mode: "commentary", label: "OUR VERDICT", host_pose: "host_neutral" }],
  source_audio: [], captions: [], added_music_or_sfx: false,
};
assert.equal(validateProgramReviewShape(request), request);
for (const patch of [
  { duration_frames: 360 }, { duration_frames: 2701 }, { fps: 29.97 }, { width: 1280 },
  { review: { approved: true } }, { timeline_approval: {} }, { program_approval: {} },
  { style_direction_approval: { ...request.style_direction_approval, authorizes_full_90_second_review: false } },
  { style_direction_approval: { ...request.style_direction_approval, operator_messages: [] } },
  { accepted_style_preview: { ...request.accepted_style_preview, sha256: "stale" } },
  { narration: { ...request.narration, source_in_sec: 0.25 } },
  { recipe: { ...request.recipe, new_synthesis: true } },
  { recipe: { ...request.recipe, captions: ["caption"] } },
  { recipe: { ...request.recipe, timeline: { ...request.recipe.timeline, shots: [{ ...request.recipe.timeline.shots[0], start_frame: 1 }] } } },
  { recipe: { ...request.recipe, timeline: { ...request.recipe.timeline, shots: [{ ...request.recipe.timeline.shots[0], truth_mode: "film_evidence" }] } } },
  { recipe: { ...request.recipe, timeline: { ...request.recipe.timeline, narration: request.recipe.timeline.narration.map((row) => ({ ...row, tempo: 1.1 })) } } },
]) assert.throws(() => validateProgramReviewShape({ ...request, ...patch }), /review blocked/i);
for (const placements of [
  [{ source_in_sec: 0, source_out_sec: 70, output_in_sec: 0 }], // end clipped
  [{ source_in_sec: 0, source_out_sec: 30, output_in_sec: 0 }, { source_in_sec: 31, source_out_sec: 72.22, output_in_sec: 40 }], // missing source
  [{ source_in_sec: 0, source_out_sec: 30, output_in_sec: 0 }, { source_in_sec: 29, source_out_sec: 72.22, output_in_sec: 40 }], // repeated source
  [{ source_in_sec: 0, source_out_sec: 30, output_in_sec: 0 }, { source_in_sec: 30, source_out_sec: 72.22, output_in_sec: 29 }], // overlapping speech
  [{ source_in_sec: 0, source_out_sec: 72.22, output_in_sec: 20 }], // out of scope
]) assert.throws(() => validateProgramNarrationPlacements({ ...request, narration_placements: placements }, 72.22), /Program review blocked/);
assert.throws(() => validateProgramNarrationPlacements(request, 72.23), /every accepted narration sample/);
for (const report of [
  { current_stage: "pilot_script", allowed_command_stages: ["pilot_script"] },
  { current_stage: "pilot_media", allowed_command_stages: [] },
]) await assert.rejects(() => preparePilotProgramReview({ report }), /current unresolved pilot_media/);
const authoredRequest = { ...request, narration_placements: SENTRY_PROGRAM_EDITORIAL.narration.map((row) => ({
  source_in_sec: row.source_in_sec, source_out_sec: row.source_out_sec, output_in_sec: row.output_start_frame / 30,
})), recipe: { ...request.recipe, timeline: SENTRY_PROGRAM_EDITORIAL }, assets: [
  ...request.assets,
  ...["host_confident", "host_presenting", "host_open_palm", "host_thinking", "host_skeptical"].map((id) => ({ id, kind: "host_pose", provenance: {} })),
  ...["film_sentry_window", "film_void_shadow"].map((id) => ({ id, kind: "movie_clip", provenance: {} })),
  ...["sentry_illustration", "doom_illustration", "void_illustration"].map((id) => ({ id, kind: "illustration", provenance: {} })),
] };
assert.equal(validateProgramReviewShape(authoredRequest), authoredRequest, "authored edit preserves complete speech and places five-second source audio wholly in pauses");
const repair = { cause: "ffmpeg_loudnorm_json_trailing_status", repair: "parse_bounded_loudnorm_json_preserve_raw_mix",
  prior_request: { path: "/fixture/pilot_program_reviews/program-v1/request.json", sha256: "c".repeat(64) },
  prior_execution: { path: "/fixture/pilot_program_reviews/program-v1/execution_started.json", sha256: "d".repeat(64) },
  retained_raw_mix: { path: "/fixture/pilot_program_reviews/program-v1/program-mix-unmastered.wav", sha256: "e".repeat(64) },
};
const identity = { path: "/fixture/run_identity.json", sha256: request.identity_sha256 };
const repairRequest = { ...request, candidate_id: "program-v2", exact_scope_repair: repair };
const execution = { schema: "goldflow_avatar_pilot_program_review_execution_v1", identity, request: repair.prior_request,
  duration_frames: 2700, provider_calls: 0, production_eligible: false, publish_allowed: false, exact_program_approval_recorded: false };
assert.equal(validateProgramReviewShape(repairRequest), repairRequest);
validateProgramRepairScope(repairRequest, request, execution, identity);
for (const next of [
  { ...repairRequest, candidate_id: request.candidate_id },
  { ...repairRequest, narration: { ...request.narration, source_out_sec: 70 } },
  { ...repairRequest, assets: request.assets.slice(1) },
  { ...repairRequest, recipe: { ...request.recipe, changed_mix: true } },
]) assert.throws(() => validateProgramRepairScope(next, request, execution, identity), /Program review blocked/);
assert.throws(() => validateProgramRepairScope(repairRequest, { ...request, exact_scope_repair: repair }, execution, identity), /chained repairs/);
assert.throws(() => validateProgramRepairScope(repairRequest, request, { ...execution, request: { ...execution.request, sha256: "f".repeat(64) } }, identity), /matching guarded private execution/);
assert.throws(() => validateProgramReviewShape({ ...repairRequest, exact_scope_repair: { ...repair, repair: "recreate_mix" } }), /only the retained raw-mix/);
console.log("Program-review scope tests passed: exact 90-second private review, retained authorization, complete source-ordered speech; no media rendered or approvals created.");
