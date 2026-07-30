import assert from "node:assert/strict";
import { assertMuxDurationIntegrity } from "../lib/media-duration-integrity.mjs";

const valid = assertMuxDurationIntegrity({
  outputDurationSec: 9415.87,
  videoDurationSec: 9416.48,
  audioDurationSec: 9415.88,
});
assert.equal(valid.status, "passed");
assert.ok(valid.delta_sec < valid.tolerance_sec);

assert.throws(
  () => assertMuxDurationIntegrity({
    outputDurationSec: 2754.15,
    videoDurationSec: 9416.48,
    audioDurationSec: 9415.88,
  }),
  /Final mux duration mismatch/,
);

assert.throws(
  () => assertMuxDurationIntegrity({
    outputDurationSec: 0,
    videoDurationSec: 10,
    audioDurationSec: 10,
  }),
  /positive finite output_duration_sec/,
);

console.log("render duration integrity tests passed");
