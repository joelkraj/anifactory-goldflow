#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  imageManualReviewPolicy,
  promptHasVehicleTopologyRisk,
} from "../image-output-qa.mjs";

const cabin = {
  image_id: "cabin",
  start_sec: 500,
  visual_beat_action: "Joey looks through the rearview mirror while Emily remains in the rear seat.",
  modelslab_image_prompt: "A left-hand-drive sedan cabin with one steering wheel and an empty front passenger seat.",
};
assert.equal(promptHasVehicleTopologyRisk(cabin), true);
assert.deepEqual(imageManualReviewPolicy(cabin, [], { openingSec: 180, integrationSampleRate: 0 }), {
  tier: "mandatory_story_geometry_review",
  requires_manual_review: true,
  reasons: ["vehicle_cabin_topology"],
  sampled: false,
});

const mapOnly = {
  image_id: "map",
  start_sec: 500,
  visual_beat_action: "Blue vehicle markers spread across a city map.",
  modelslab_image_prompt: "A clean dispatch map with abstract fleet icons.",
};
assert.equal(promptHasVehicleTopologyRisk(mapOnly), false);
assert.equal(imageManualReviewPolicy(mapOnly, [], { openingSec: 180 }).requires_manual_review, false);

const exterior = {
  image_id: "exterior",
  start_sec: 500,
  visual_beat_action: "Three sedans cross a bridge in a convoy.",
  modelslab_image_prompt: "Wide exterior road view with three separate cars.",
};
assert.equal(promptHasVehicleTopologyRisk(exterior), false);

console.log("image output QA vehicle topology tests passed");
