#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  NO_LTX_OVERRIDE_SCHEMA,
  NO_LTX_OVERRIDE_STAGES,
  enforceInPlaceSubjectGrowth,
  validateNoLtxOverrideArtifact,
} from "../lib/operator-motion-route-override.mjs";

const artifact = {
  schema: NO_LTX_OVERRIDE_SCHEMA,
  status: "approved",
  episode: "ep_01",
  run_identity_sha256: "identity-hash",
  disable_ltx: true,
  fallback_motion_route: "selective_inspected_parallax",
  subject_motion: {
    lateral_translation: "forbidden",
    scale_behavior: "grow_in_place",
  },
  waived_stages: NO_LTX_OVERRIDE_STAGES,
  operator_instruction: "No LTX; use parallax and grow subjects in place.",
};

assert.equal(validateNoLtxOverrideArtifact(artifact, {
  episode: "ep_01",
  runIdentitySha256: "identity-hash",
  parallaxPolicy: "selective_inspected",
}).done, true);

assert.deepEqual(validateNoLtxOverrideArtifact({ ...artifact, run_identity_sha256: "stale" }, {
  episode: "ep_01",
  runIdentitySha256: "identity-hash",
  parallaxPolicy: "selective_inspected",
}).findings, ["run_identity_hash_mismatch"]);

assert.deepEqual(validateNoLtxOverrideArtifact({ ...artifact, waived_stages: ["generated_video_motion"] }, {
  episode: "ep_01",
  runIdentitySha256: "identity-hash",
  parallaxPolicy: "selective_inspected",
}).findings, ["waived_stage_scope_mismatch"]);

assert.deepEqual(validateNoLtxOverrideArtifact(artifact, {
  episode: "ep_01",
  runIdentitySha256: "identity-hash",
  parallaxPolicy: "disabled",
}).findings, ["run_identity_parallax_not_selective_inspected"]);

const inPlace = enforceInPlaceSubjectGrowth({
  behavior: "push_in",
  start_anchor: { x: 0.2, y: 0.4 },
  end_anchor: { x: 0.7, y: 0.55 },
  start_scale: 1,
  end_scale: 1.1,
  motion_keyframes: [
    { at: 0, anchor: { x: 0.2, y: 0.4 }, scale: 1 },
    { at: 1, anchor: { x: 0.7, y: 0.55 }, scale: 1.1 },
  ],
});
assert.deepEqual(inPlace.start_anchor, { x: 0.7, y: 0.55 });
assert.deepEqual(inPlace.end_anchor, { x: 0.7, y: 0.55 });
assert(inPlace.motion_keyframes.every((row) => row.anchor.x === 0.7 && row.anchor.y === 0.55));
assert.equal(inPlace.start_scale, 1);
assert.equal(inPlace.end_scale, 1.1);
assert.equal(enforceInPlaceSubjectGrowth({ behavior: "static_hold" }).behavior, "static_hold");

console.log("operator motion route override tests passed");
