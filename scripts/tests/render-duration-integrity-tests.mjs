import assert from "node:assert/strict";
import { assertMuxDurationIntegrity } from "../lib/media-duration-integrity.mjs";
import {
  assertGeneratedVideoRenderCoverageForTests,
  assertTransitionAccounting,
  preferredAudioBedRenderPathForTests,
} from "../render.mjs";

assert.equal(preferredAudioBedRenderPathForTests({
  audioBedReport: {
    mix: {
      render_input_path: "/tmp/canonical.wav",
      wav_path: "/tmp/fallback.wav",
      m4a_path: "/tmp/lossy.m4a",
    },
  },
}), "/tmp/canonical.wav");
assert.equal(preferredAudioBedRenderPathForTests({
  explicitAudio: "/tmp/operator.wav",
  audioBedReport: { mix: { render_input_path: "/tmp/canonical.wav" } },
}), "/tmp/operator.wav");

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

const providerNeutralFlowCoverage = assertGeneratedVideoRenderCoverageForTests({
  approved_generated_video_count: 1,
  motion_intents: [{
    image_id: "cut_flow_001",
    generated_video_treatment: { mode: "generated_video", provider: "google_flow" },
  }],
});
assert.equal(providerNeutralFlowCoverage.declared_count, 1);
assert.equal(providerNeutralFlowCoverage.treatment_count, 1);
assert.deepEqual(providerNeutralFlowCoverage.image_ids, ["cut_flow_001"]);

assert.equal(assertGeneratedVideoRenderCoverageForTests({
  approved_generated_video_count: 1,
  motion_intents: [{
    image_id: "cut_ltx_001",
    generated_video_treatment: { mode: "generated_video_ltx23", provider: "modelslab" },
  }],
}).treatment_count, 1);

assert.throws(
  () => assertGeneratedVideoRenderCoverageForTests({
    approved_generated_video_count: 1,
    motion_intents: [{
      image_id: "cut_unknown_001",
      generated_video_treatment: { mode: "generated_video_future" },
    }],
  }),
  /Unsupported generated-video render mode/,
);

assert.throws(
  () => assertGeneratedVideoRenderCoverageForTests({
    approved_generated_video_count: 2,
    motion_intents: [{
      image_id: "cut_flow_001",
      generated_video_treatment: { mode: "generated_video", provider: "google_flow" },
    }],
  }),
  /Approved generated-video count mismatch/,
);

console.log("render duration integrity tests passed");
