import assert from "node:assert/strict";
import { validateStylePreviewShape, preparePilotStylePreview, STYLE_PREVIEW_SCHEMA } from "../lib/avatar-pilot-style-preview.mjs";

const request = {
  schema: STYLE_PREVIEW_SCHEMA, intent: "local_visual_review", candidate_id: "style-v2",
  identity_sha256: "a".repeat(64), duration_frames: 360, production_eligible: false, publish_allowed: false,
  narration: { asset_id: "narration_joel", source_in_sec: 15, source_out_sec: 25.4, output_in_sec: 0.75 },
  assets: [
    { id: "narration_joel", kind: "narration", provenance: { type: "accepted_narration" } },
    { id: "host_neutral", kind: "host_pose", provenance: { type: "accepted_host_identity" } },
    { id: "host_room", kind: "background", provenance: { type: "accepted_generated" } },
  ],
  recipe: { id: "fixture_no_media_rendered" },
};
assert.equal(validateStylePreviewShape(request), request);
for (const patch of [
  { duration_frames: 239 }, { duration_frames: 361 }, { duration_frames: 300.5 },
  { production_eligible: true }, { publish_allowed: true }, { intent: "production" },
  { candidate_id: "../existing" }, { identity_sha256: "stale" },
  { review: { approved: true } }, { approved: false },
  { assets: [...request.assets, request.assets[0]] },
  { assets: request.assets.filter((row) => row.kind !== "narration") },
  { assets: request.assets.map((row) => ({ ...row, review: { approved: true } })) },
  { narration: { ...request.narration, output_in_sec: 2 } },
  { narration: { ...request.narration, source_out_sec: 14 } },
  { narration: { ...request.narration, source_in_sec: -1 } },
]) assert.throws(() => validateStylePreviewShape({ ...request, ...patch }), /Style preview blocked/);

for (const report of [
  { current_stage: "pilot_script", allowed_command_stages: ["pilot_script"] },
  { current_stage: "pilot_media", allowed_command_stages: [] },
  { current_stage: "pilot_media", allowed_command_stages: ["pilot_media"], production_eligible: true, publish_allowed: false },
]) await assert.rejects(() => preparePilotStylePreview({ report }), /current unresolved pilot_media/);
console.log("Avatar pilot style-preview request and pre-write scope tests passed; no media or approvals created.");
