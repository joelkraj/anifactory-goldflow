import assert from "node:assert/strict";
import {
  referencePlanApprovalContract,
  referencePlanApprovalContractSha256,
  referencePlanApprovalMatches,
} from "../lib/reference-plan-contract.mjs";

const plan = {
  schema: "goldflow_visual_reference_plan_v1",
  status: "passed",
  source_script_hash: "a".repeat(64),
  source_hashes: { "/fixture/script_clean.md": "a".repeat(64) },
  reference_targets: [{
    ref_id: "style_ref", kind: "style", generation_mode: "standalone_ref",
    prompt_anchor: "One abstract cel-shaded material study.", scene_ids: ["scene_001"],
    conditioning_subject_count: 1, clean_plate_contract: "One unpopulated style concept.",
  }, {
    ref_id: "owned_face_ref", kind: "character_state", generation_mode: "source_only",
    source_image_sha256: "b".repeat(64), source_review_receipt_sha256: "c".repeat(64),
  }],
};
const original = structuredClone(plan);
const approval = { status: "approved", reference_plan_contract_sha256: referencePlanApprovalContractSha256(plan) };
const matches = candidate => referencePlanApprovalMatches({ approval, plan: candidate });
assert.equal(matches(plan), true);

const generated = structuredClone(plan);
Object.assign(generated.reference_targets[0], {
  reference_image_path: "/fixture/generated.png", conditioning_image_path: "/fixture/generated.png",
  image_provider: "codex_image", image_provider_route: "hybrid_browser_pool",
  browser_provider: "google-gemini", provider_receipt_path: "/fixture/google_gemini_receipt.json",
  provider_receipt_sha256: "d".repeat(64),
});
generated.reference_generation_updated_at = "2026-09-12T21:15:22.041Z";
assert.equal(matches(generated), true, "Provider output materialization must preserve prior creative approval");
assert.deepEqual(referencePlanApprovalContract(generated), referencePlanApprovalContract(plan));
assert.equal(generated.reference_targets[0].provider_receipt_sha256, "d".repeat(64), "Hash projection must not remove actual provider evidence");

for (const change of [
  candidate => { candidate.reference_targets[0].prompt_anchor = "A different creative concept."; },
  candidate => { candidate.reference_targets[0].scene_ids.push("scene_002"); },
  candidate => { candidate.reference_targets[0].clean_plate_contract = "A populated story scene."; },
  candidate => { candidate.reference_targets[0].ref_id = "different_ref"; },
  candidate => { candidate.reference_targets.pop(); },
  candidate => { candidate.source_script_hash = "e".repeat(64); },
  candidate => { candidate.source_hashes["/fixture/script_clean.md"] = "e".repeat(64); },
  candidate => { candidate.reference_targets[1].source_image_sha256 = "e".repeat(64); },
  candidate => { candidate.reference_targets[1].source_review_receipt_sha256 = "e".repeat(64); },
]) {
  const changed = structuredClone(generated);
  change(changed);
  assert.equal(matches(changed), false, "Creative, scope, selection and source provenance changes must still invalidate approval");
}
assert.deepEqual(plan, original, "Approval hashing must not mutate inputs");
assert.equal(referencePlanApprovalMatches({ approval: { ...approval, status: "blocked" }, plan: generated }), false);
assert.equal(referencePlanApprovalMatches({ approval: { status: "approved", visual_reference_plan_sha256: "f".repeat(64) }, plan, fileSha256: "f".repeat(64) }), true, "Legacy exact-file approval remains supported");
assert.equal(referencePlanApprovalMatches({ approval: { status: "approved", visual_reference_plan_sha256: "f".repeat(64) }, plan: generated, fileSha256: "e".repeat(64) }), false, "Legacy approval must not silently gain projection semantics");

console.log("PASS reference plan approval survives provider materialization only");
