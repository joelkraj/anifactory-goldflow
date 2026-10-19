import assert from "node:assert/strict";
import { narrationFinalPatchAdmission, parsePcm16Wav, spliceRetakes, unitWindows, validatePlacement, MIN_PATCH_PAUSE_SAMPLES } from "../lib/narration-final-patch.mjs";

function wav(samples, rate = 24000) {
  const data = Buffer.alloc(samples.length * 2); samples.forEach((v, i) => data.writeInt16LE(v, i * 2));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8); head.write("fmt ", 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const pcm = (values) => { const b = Buffer.alloc(values.length * 2); values.forEach((v, i) => b.writeInt16LE(v, i * 2)); return b; };

const parsed = parsePcm16Wav(wav([1, 2, 3]));
assert.equal(parsed.samples, 3);
assert.throws(() => parsePcm16Wav(wav([1, 2], 48000)), /24 kHz mono/);

const windows = unitWindows([3000, 2000, 4000], [1500, 1300]);
assert.deepEqual(windows.map((w) => [w.offset, w.windowSamples]), [[0, 4500], [4500, 3300], [7800, 4000]]);

const raw = pcm(Array.from({ length: 11800 }, (_, i) => (i % 97) + 1));
const retake = pcm(Array.from({ length: 3200 }, () => 7));
const patched = spliceRetakes(raw, [{ window: windows[0], pcm: retake }]);
assert.equal(patched.length, raw.length);
assert.equal(patched.readInt16LE(0), 7);
assert.equal(patched.readInt16LE(3199 * 2), 7);
assert.equal(patched.readInt16LE(3200 * 2), 0, "rest of the patched window is silence");
assert.ok(patched.subarray(4500 * 2).equals(raw.subarray(4500 * 2)), "samples outside the window are byte-identical");
assert.equal(raw.readInt16LE(0), 1, "input buffer is not mutated");

assert.throws(() => validatePlacement(windows[1], 3300 - MIN_PATCH_PAUSE_SAMPLES + 1), /needs/);
validatePlacement(windows[1], 3300 - MIN_PATCH_PAUSE_SAMPLES);
assert.throws(() => spliceRetakes(raw, [{ window: { ...windows[0], windowSamples: 9000 }, pcm: retake }, { window: windows[1], pcm: retake }]), /overlap/);
const passedStatus = { identity: { schema: "goldflow_run_identity_v2" }, media_workflow: { id: "generated_visuals_v1" },
  stage_ledger: [{ stage: "final_qa", state: "passed" }] };
const exactFlags = { "episode-dir": "/tmp/ep", spec: "/tmp/ep/spec.json" };
assert.equal(narrationFinalPatchAdmission(passedStatus, exactFlags).allowed, true);
assert.equal(narrationFinalPatchAdmission({ ...passedStatus, stage_ledger: [{ stage: "final_qa", state: "missing" }] }, exactFlags).allowed, false);
assert.equal(narrationFinalPatchAdmission(passedStatus, { ...exactFlags, "workflow-bypass": "true" }).allowed, false);
assert.equal(narrationFinalPatchAdmission({ ...passedStatus, media_workflow: { id: "source_footage_v1" } }, exactFlags).allowed, false);
console.log("narration-final-patch-tests passed");
