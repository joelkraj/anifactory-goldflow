import assert from "node:assert/strict";
import { assertMuxDurationIntegrity } from "../lib/media-duration-integrity.mjs";
import { assertTransitionAccounting } from "../render.mjs";

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

const continuousLtxSuppression = assertTransitionAccounting({
  plannedTransitionCount: 99,
  selectedBoundaryCount: 98,
  suppressedContinuousLtxTransitionCount: 1,
  appliedTransitionCount: 98,
});
assert.equal(continuousLtxSuppression.planned_transition_count, 99);
assert.equal(continuousLtxSuppression.applied_transition_count, 98);
assert.equal(continuousLtxSuppression.suppressed_continuous_ltx_transition_count, 1);

assert.throws(
  () => assertTransitionAccounting({
    plannedTransitionCount: 99,
    selectedBoundaryCount: 98,
    suppressedContinuousLtxTransitionCount: 1,
    appliedTransitionCount: 97,
  }),
  /Planned\/applied transition mismatch/,
);

console.log("render duration integrity tests passed");
