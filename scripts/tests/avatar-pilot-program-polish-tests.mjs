import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { PROGRAM_REVIEW_SCHEMA, validateProgramReviewShape, validateProgramPolishScope, prepareProgramPolish } from "../lib/avatar-pilot-program-review.mjs";
import { SENTRY_PROGRAM_EDITORIAL } from "../lib/sentry-program-editorial.mjs";

// Structural fixtures only: no real source, operator review, media dispatch or model calls.
const hash = (value) => createHash("sha256").update(value).digest("hex");
const ref = (file) => ({ path: file, sha256: hash(file) });
const clone = (value) => structuredClone(value);
const prior = {
  schema: PROGRAM_REVIEW_SCHEMA, intent: "local_program_review", candidate_id: "full90-v2",
  identity_sha256: hash("fixture identity"), duration_frames: 2700, width: 1920, height: 1080, fps: 30,
  production_eligible: false, publish_allowed: false,
  accepted_style_preview: ref("/fixture/pilot_visual_reviews/style-v4/result.json"),
  style_direction_approval: { reviewer: "Fixture only", note: "Synthetic authority does not represent a human decision.",
    operator_messages: ["Fixture full-program scope."], authorizes_full_90_second_review: true },
  narration: { asset_id: "narration_joel", source_in_sec: 0, source_out_sec: 72.22, output_in_sec: 0 },
  narration_placements: SENTRY_PROGRAM_EDITORIAL.narration.map((row) => ({
    source_in_sec: row.source_in_sec, source_out_sec: row.source_out_sec, output_in_sec: row.output_start_frame / 30,
  })),
  assets: [
    ["narration_joel", "narration"], ["host_room", "background"],
    ...["host_open_palm", "host_presenting", "host_thinking", "host_skeptical", "host_confident"].map((id) => [id, "host_pose"]),
    ...["sentry_illustration", "doom_illustration", "void_illustration"].map((id) => [id, "illustration"]),
    ...["film_sentry_window", "film_void_shadow"].map((id) => [id, "movie_clip"]),
  ].map(([id, kind]) => ({ id, kind, ...ref(`/fixture/${id}`), provenance: { type: "fixture_only" } })),
  recipe: { captions: [], new_synthesis: false, added_music_or_sfx: false, timeline: clone(SENTRY_PROGRAM_EDITORIAL) },
};
const identity = { path: "/fixture/run_identity.json", sha256: prior.identity_sha256 };
const priorResult = {
  schema: "goldflow_avatar_pilot_program_review_result_v1", status: "awaiting_program_review", identity,
  request: ref("/fixture/pilot_program_reviews/full90-v2/request.json"), output: ref("/fixture/pilot_program_reviews/full90-v2/proof.mp4"),
  duration_frames: 2700, width: 1920, height: 1080, fps: 30, provider_calls: 0,
  official_stage_completed: false, exact_program_approval_recorded: false, production_eligible: false, publish_allowed: false,
};
const soundtrackAsset = {
  id: "licensed_whoosh", kind: "sfx", ...ref("/fixture/pilot_media_work/polish_audio_v1/whoosh.wav"),
  source: ref("/fixture/pilot_media_work/polish_audio_v1/whoosh.wav"), duration_sec: 1, contains_speech: false,
  source_url: "https://example.org/whoosh.wav", source_page: "https://example.org/whoosh", intended_use: "Short motion punctuation.",
  license_application_evidence: ref("/fixture/pilot_media_work/polish_audio_v1/source-page.html"),
  license: { id: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", attribution: "Fixture-only sound source.",
    permits_modification: true, permits_synchronization: true, text: ref("/fixture/pilot_media_work/polish_audio_v1/license.txt") },
};
const request = {
  ...clone(prior), candidate_id: "polish-v1", prior_program: ref("/fixture/pilot_program_reviews/full90-v2/result.json"),
  preserved_program_mix: ref("/fixture/pilot_program_reviews/full90-v1/program-mix-unmastered.wav"),
  polish_authorization: { reviewer: "Fixture only", note: "Synthetic authorization only; no real human decision.",
    operator_messages: ["Fixture scoped sound and motion polish."], authorizes_sound_motion_polish: true },
  polish_budget: { provider_calls: 0, provider_cost_usd: 0, new_voice_takes: 0, new_visual_assets: 0, max_soundtrack_assets: 14, max_soundtrack_cues: 36 },
  soundtrack_manifest: ref("/fixture/pilot_media_work/polish_audio_v1/asset_manifest.json"), soundtrack_assets: [soundtrackAsset],
};
request.recipe.added_music_or_sfx = true;
request.recipe.timeline.added_music_or_sfx = true;
request.recipe.timeline.soundtrack = [{ id: "motion_accent", asset_id: soundtrackAsset.id, start_frame: 78, end_frame: 108,
  source_in_sec: 0, source_out_sec: 1, gain_db: -15, fade_in_sec: 0.01, fade_out_sec: 0.04, loop: false, role: "punctuation" }];
assert.equal(validateProgramReviewShape(request), request);
validateProgramPolishScope(request, prior, priorResult, identity);
const naturalTail = clone(request);
naturalTail.recipe.timeline.soundtrack[0].source_out_sec = 0.987;
naturalTail.recipe.timeline.soundtrack[0].end_frame = 78 + 0.987 * 30;
assert.equal(validateProgramReviewShape(naturalTail), naturalTail, "natural SFX sample tail need not be truncated to a video frame");

const deny = (change, regex = /Program review blocked|Style preview blocked/) => {
  const next = clone(request); change(next);
  assert.throws(() => { validateProgramReviewShape(next); validateProgramPolishScope(next, prior, priorResult, identity); }, regex);
};
deny((next) => { next.duration_frames = 2701; });
deny((next) => { next.polish_budget = undefined; }, /budget/);
deny((next) => { next.preserved_program_mix = undefined; }, /successful prior program/);
deny((next) => { next.polish_budget.provider_cost_usd = 1; }, /budget/);
deny((next) => { next.polish_budget.new_voice_takes = 1; }, /budget/);
deny((next) => { next.polish_authorization.authorizes_sound_motion_polish = false; }, /direction/);
deny((next) => { next.polish_authorization.operator_messages = []; }, /direction/);
deny((next) => { next.program_approval = { accepted: true }; }, /cannot claim/);
deny((next) => { next.recipe.new_synthesis = true; }, /synthesis/);
deny((next) => { next.narration_placements[1].output_in_sec += 0.1; });
deny((next) => { next.recipe.timeline.narration[0].tempo = 1.01; }, /tempo/);
deny((next) => { next.assets[0].sha256 = hash("different narration"); }, /preserved assets/);
deny((next) => { next.recipe.timeline.source_audio[0].gain_db -= 1; }, /source_audio/);
deny((next) => { next.recipe.timeline.shots.find((shot) => shot.film).film.source_in_sec += 0.1; });
deny((next) => { next.soundtrack_assets[0].license.id = "unknown"; }, /license/);
deny((next) => { next.soundtrack_assets[0].license.permits_synchronization = false; }, /license/);
deny((next) => { next.soundtrack_assets[0].license.text.sha256 = "unbound"; }, /license/);
deny((next) => { next.soundtrack_assets[0].contains_speech = true; }, /non-speech/);
deny((next) => { next.soundtrack_assets[0].sha256 = next.assets[0].sha256; }, /never narration or film/);
deny((next) => { next.soundtrack_assets[0].source.sha256 = next.assets[0].sha256; }, /never narration or film/);
deny((next) => { next.soundtrack_assets[0].source_url += "?token=secret"; });
deny((next) => { next.recipe.timeline.soundtrack[0].end_frame = 2701; }, /2700 frames/);
deny((next) => { next.recipe.timeline.soundtrack[0].source_out_sec = 2; }, /source-bound/);
deny((next) => { next.recipe.timeline.soundtrack[0].loop = true; }, /unlooped/);
deny((next) => { next.recipe.timeline.soundtrack[0].gain_db = 0; }, /gains/);
deny((next) => { next.recipe.timeline.soundtrack[0].fade_in_sec = 2; }, /fades/);
deny((next) => { const cue = next.recipe.timeline.soundtrack[0]; cue.start_frame = 670; cue.end_frame = 700; }, /spotlights/);
deny((next) => { const cue = next.recipe.timeline.soundtrack[0]; cue.start_frame = 1400; cue.end_frame = 1430; }, /spotlights/);
deny((next) => { next.soundtrack_assets.push({ ...clone(soundtrackAsset), id: "unused" }); }, /unused/);
deny((next) => { next.recipe.timeline.shots[0].framing = { camera: { start_scale: 1, end_scale: 3, anchor_x: 500, anchor_y: 500, ease: "linear" } }; }, /camera/);
deny((next) => { next.recipe.timeline.shots[0].transition_in = { kind: "slide", frames: 30 }; }, /transition/);
assert.throws(() => validateProgramPolishScope(request, { ...prior, polish_authorization: {} }, priorResult, identity), /chained polish/);
assert.throws(() => validateProgramPolishScope(request, prior, { ...priorResult, status: "failed" }, identity), /successful matching/);
const noPolish = clone(request); delete noPolish.polish_authorization;
assert.throws(() => validateProgramReviewShape(noPolish), /separately bounded/);

const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-program-polish-test-")));
try {
  const resultPath = path.join(directory, "result.json");
  await fs.writeFile(resultPath, JSON.stringify(priorResult));
  const stale = clone(request); stale.prior_program = { path: resultPath, sha256: hash("stale prior result") };
  await assert.rejects(() => prepareProgramPolish({ manifest: stale, refs: [], identity, assets: {} }, directory), /stale source binding/);
  assert.deepEqual(await fs.readdir(directory), ["result.json"], "stale prior is refused before any new review output");
} finally {
  await fs.rm(directory, { recursive: true }); // Exact synthetic mkdtemp namespace only.
}
console.log("Program polish guard tests passed: preserved prior/speech/film, explicit zero-spend budget, licensed non-speech cues, bounded timing and no fake approval.");
