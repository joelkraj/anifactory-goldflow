import assert from 'node:assert/strict';
import { SENTRY_PROGRAM_EDITORIAL as base } from '../lib/sentry-program-editorial.mjs';
import { SENTRY_POLISH_EDITORIAL as polish } from '../lib/sentry-polish-editorial.mjs';

// Provider-free authored-data checks. These do not establish actual audiovisual
// quality, user acceptance, source rights, or that a renderer implements motion.
assert.equal(polish.schema, 'goldflow_sentry_polish_editorial_review_v1');
assert.equal(polish.production_eligible, false);
assert.equal(polish.publish_allowed, false);
assert.equal(polish.duration_frames, 2700);
assert.equal(polish.fps, 30);
assert.equal(polish.width, 1920);
assert.equal(polish.height, 1080);
assert.deepEqual(polish.narration, base.narration, 'all accepted speech placements and source samples survive unchanged');
assert.deepEqual(polish.narration_policy, base.narration_policy);
assert.deepEqual(polish.source_audio, base.source_audio, 'film sound intervals and gains remain exact');
assert.deepEqual(polish.captions, [], 'no burned-in narration caption plan');
assert.equal(polish.narration.length, 13);
assert.equal(polish.narration.at(-1).word_end_index_exclusive, 232);
assert.equal(polish.narration.at(-1).source_out_sec, 72.22);

const seen = new Set();
let edge = 0;
for (const shot of polish.shots) {
  assert.ok(!seen.has(shot.id), `unique shot ${shot.id}`);
  seen.add(shot.id);
  assert.equal(shot.start_frame, edge, `contiguous start of ${shot.id}`);
  assert.ok(Number.isInteger(shot.start_frame) && Number.isInteger(shot.end_frame));
  assert.ok(shot.end_frame > shot.start_frame);
  edge = shot.end_frame;
  const source = base.shots.find((row) => row.id === shot.scene.id);
  assert.ok(source, `preserved source scene for ${shot.id}`);
  assert.equal(shot.scene.start_frame, source.start_frame);
  assert.equal(shot.scene.end_frame, source.end_frame);
  assert.ok(shot.start_frame >= shot.scene.start_frame && shot.end_frame <= shot.scene.end_frame);
  assert.equal(shot.type, source.type);
  assert.equal(shot.variant, source.variant);
  assert.equal(shot.truth_mode, source.truth_mode);
  assert.equal(shot.label, source.label, 'hypothesis and film labels cannot be weakened by a framing edit');
  for (const cue of shot.cues) {
    assert.ok(Number.isInteger(cue.frame));
    assert.ok(cue.frame >= shot.scene.start_frame && cue.frame < shot.scene.end_frame,
      'continued action may precede a new framing cut, but never its actual scene');
    assert.ok(cue.duration_frames > 0);
  }
  const camera = shot.framing.camera;
  assert.ok(shot.framing.id);
  for (const value of [camera.start_scale, camera.end_scale]) assert.ok(value >= 1 && value <= 1.85);
  for (const value of [camera.anchor_x, camera.target_x]) assert.ok(value >= 0 && value <= 1920);
  for (const value of [camera.anchor_y, camera.target_y]) assert.ok(value >= 0 && value <= 1080);
  assert.ok(['linear', 'smoothstep', 'ease_out_cubic'].includes(camera.ease));
  assert.ok(['cut', 'match_move', 'card_handoff'].includes(shot.transition_in.kind));
  assert.ok(shot.transition_in.frames >= 0 && shot.transition_in.frames <= 15);
  assert.ok(shot.transition_in.frames < shot.end_frame - shot.start_frame);
  if (shot.film) {
    assert.equal(shot.start_frame, source.start_frame);
    assert.equal(shot.end_frame, source.end_frame);
    assert.equal(shot.end_frame - shot.start_frame, 150);
    assert.deepEqual(shot.film, source.film);
    assert.equal(camera.start_scale, 1);
    assert.equal(camera.end_scale, 1);
    assert.equal(camera.target_x, camera.anchor_x);
    assert.equal(camera.target_y, camera.anchor_y);
  }
}
assert.equal(edge, 2700);
assert.equal(polish.shots.length, 30, 'this exact authored edit has thirty views, not a global cutting quota');
assert.equal(polish.shots.filter((row) => row.film).length, 2);

const lateViews = polish.shots.filter((row) => row.start_frame >= 1733 && row.end_frame <= 2245);
assert.deepEqual(lateViews.map((row) => row.framing.id), polish.visual_direction.framing_sequence_57_to_75_sec);
assert.equal(new Set(lateViews.map((row) => row.framing.id)).size, 7);
assert.ok(lateViews.some((row) => row.framing.camera.start_scale >= 1.5), 'Doom receives an actual reaction crop');
assert.ok(lateViews.some((row) => row.framing.id === 'void_hold_close'), 'holding receives a distinct close view');
assert.ok(lateViews.some((row) => row.framing.id === 'protected_route_detail'), 'escape has a distinct spatial view');

const splitShot = polish.shots.find((row) => row.id === '10_device_escape_detail');
assert.ok(splitShot.cues.some((row) => row.frame < splitShot.start_frame),
  'split framing deliberately retains earlier action cues to prevent resetting the Sentry block');
assert.equal(polish.camera_contract.scene_clock_not_shot_clock, true);
assert.equal(polish.camera_contract.labels_and_credits_in_output_space, true);

assert.equal(polish.sound_design.cues.length, 10);
assert.equal(polish.sound_design.source_spotlight_soundtrack_silent, true);
for (const cue of polish.sound_design.cues) {
  const start = cue.frame / 30;
  const end = start + cue.source_out_sec - cue.source_in_sec;
  assert.ok(start >= 0 && end <= 90 && end > start);
  assert.ok(cue.gain_db <= -16 && cue.gain_db >= -22, 'restrained starting gain intent');
  for (const film of polish.source_audio) {
    assert.ok(end <= film.start_frame / 30 || start >= film.end_frame / 30,
      `${cue.id} must not intrude on an exact movie-audio spotlight`);
  }
}
assert.deepEqual(polish.sound_design.cues.filter((cue) => ['opening_recoil', 'corridor_drop', 'void_reveal', 'objective_clears'].includes(cue.id)).map((cue) => cue.frame),
  [80, 1116, 1384, 2184]);

console.log('Sentry editorial checks passed: thirty scene-clocked views, unchanged complete narration/film, distinct late-sequence framing and ten bounded sound cues.');
