import assert from 'node:assert/strict';
import { cameraAt, detourPoint, motionEase } from '../lib/avatar-pilot-polish-renderer.mjs';
import { SENTRY_POLISH_EDITORIAL as edit } from '../lib/sentry-polish-editorial.mjs';

// Pure renderer-math checks only. No image generation, media render, subjective
// listening, source review or operator approval occurs in this test.
const near = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} should be near ${expected}`);
const curves = ['linear', 'smoothstep', 'ease_in_cubic', 'ease_out_quint', 'ease_in_out_cubic', 'ease_out_back', 'ease_out_cubic'];
for (const name of curves) {
  near(motionEase(0, name), 0);
  near(motionEase(1, name), 1);
  near(motionEase(-1, name), 0);
  near(motionEase(2, name), 1);
  for (let step = 0; step <= 100; step++) assert.ok(Number.isFinite(motionEase(step / 100, name)));
}
assert.ok(motionEase(0.35, 'ease_out_quint') > motionEase(0.35, 'smoothstep'), 'fast interception does not inherit a slow camera ease');
assert.ok(motionEase(0.65, 'ease_out_back') > 1, 'small authored label overshoot exists');
assert.ok(motionEase(0.35, 'ease_in_cubic') < motionEase(0.35, 'linear'), 'fall starts slowly before accelerating');

for (const shot of edit.shots) {
  const c = shot.framing.camera;
  near(cameraAt(shot, shot.start_frame).scale, c.start_scale);
  near(cameraAt(shot, shot.end_frame - 1).scale, c.end_scale);
  for (const f of [shot.start_frame, (shot.start_frame + shot.end_frame - 1) / 2, shot.end_frame - 1]) {
    const transform = cameraAt(shot, f);
    near(c.anchor_x * transform.scale + transform.x, c.target_x);
    near(c.anchor_y * transform.scale + transform.y, c.target_y);
  }
  if (shot.film) {
    for (let f = shot.start_frame; f < shot.end_frame; f++) {
      const transform = cameraAt(shot, f);
      near(transform.scale, 1);
      near(transform.x, 0);
      near(transform.y, 0);
    }
  }
}
const doomClose = edit.shots.find((shot) => shot.framing.id === 'doom_risk_close');
const closeTransform = cameraAt(doomClose, doomClose.start_frame);
near(330 * closeTransform.scale + closeTransform.x, 960);
assert.ok(closeTransform.scale >= 1.5, 'Doom is reframed toward output center, not merely drifted left');
const heldVoid = edit.shots.find((shot) => shot.framing.id === 'void_hold_close');
assert.ok(cameraAt(heldVoid, heldVoid.end_frame - 1).scale > cameraAt(heldVoid, heldVoid.start_frame).scale, 'the authored hold gets a real camera push');

const start = detourPoint(0), end = detourPoint(1);
assert.ok(end.x > start.x + 900, 'detour crosses the doorway width');
near(start.y, end.y);
const positions = Array.from({ length: 101 }, (_, i) => detourPoint(i / 100));
assert.ok(Math.min(...positions.map((p) => p.y)) < start.y - 200, 'detour visibly rises before crossing');
for (const p of positions) assert.ok(p.x >= 0 && p.x <= 1920 && p.y >= 0 && p.y <= 1080);
for (const t of [0.28, 0.76]) {
  const a = detourPoint(t - 1e-7), b = detourPoint(t + 1e-7);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 0.001, 'detour segments join without teleportation');
}
assert.ok(Math.abs(detourPoint(0.5).y - start.y) > 200, 'midpoint is not a straight diagonal between endpoints');

console.log('Sentry motion math checks passed: real anchored camera transforms, identity evidence cameras, distinct authored easing and continuous curved Doom detour.');
