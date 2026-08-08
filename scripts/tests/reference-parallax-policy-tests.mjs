#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildReferenceDirectorSelectionReceipt,
  referenceDirectorSelectionFidelityFindings,
} from "../lib/reference-selection-fidelity.mjs";
import {
  classifyParallaxSeparationEvidence,
  noticeableParallaxTreatment,
  selectEvidenceBackedParallaxCandidates,
} from "../lib/parallax-policy.mjs";
import {
  parallaxApprovalMatches,
  parallaxAssetContractSha256,
} from "../lib/parallax-contract.mjs";
import { plannerInvocationScope } from "../lib/planner-rerun-policy.mjs";
import {
  characterReferenceContentFindingsForTests,
  dropUnknownReferenceSceneScopesForTests,
  mergeReferencePartialRepairForTests,
  nonCharacterReferenceContentFindingsForTests,
  recurringReferenceCoverageFindingsForTests,
  referenceDirectorSelectionFindingsForTests,
  selectReferencePartialRepairScopeForTests,
} from "../visual-reference-plan.mjs";

const references = Array.from({ length: 96 }, (_, index) => ({
  ref_id: `ref_${String(index + 1).padStart(3, "0")}`,
  kind: index % 2 ? "location" : "character_state",
  generation_mode: "standalone_ref",
}));
const receipt = buildReferenceDirectorSelectionReceipt(references);
assert.equal(receipt.selected_target_count, 96);
assert.deepEqual(referenceDirectorSelectionFidelityFindings({
  reference_director_contract_version: "reference_director_v3_full_selection",
  reference_director_selection_receipt: receipt,
  reference_targets: references,
}), []);
const reducedFindings = referenceDirectorSelectionFidelityFindings({
  reference_director_contract_version: "reference_director_v3_full_selection",
  reference_director_selection_receipt: receipt,
  reference_targets: references.slice(0, 95),
});
assert(reducedFindings.some((finding) => finding.code === "post_director_reference_reduction"));
const downgradedFindings = referenceDirectorSelectionFidelityFindings({
  reference_director_contract_version: "reference_director_v3_full_selection",
  reference_director_selection_receipt: receipt,
  reference_targets: references.map((row, index) => index === 0 ? { ...row, generation_mode: "manual_review" } : row),
});
assert(downgradedFindings.some((finding) => finding.code === "post_director_reference_generation_downgrade"));

const partial = {
  schema: "goldflow_visual_reference_partial_v2",
  status: "needs_chunk_repair",
  passed_chunks: [{
    chunk_id: "chunk_01",
    scene_ids: ["scene_01"],
    candidate_plan: { reference_targets: [{ ref_id: "passed_ref" }], character_state_refs: [] },
  }],
  failed_chunks: [
    { chunk_id: "chunk_02", scene_ids: ["scene_02"] },
    { chunk_id: "chunk_03", scene_ids: ["scene_03"] },
  ],
};
const repairScope = selectReferencePartialRepairScopeForTests(partial, { chunkIds: ["chunk_02"] });
assert.deepEqual(repairScope.selected_chunks.map((row) => row.chunk_id), ["chunk_02"]);
const repairedPartial = mergeReferencePartialRepairForTests(partial, [{
  status: "passed",
  original_chunk_id: "chunk_02",
  repair_scene_ids: ["scene_02"],
  passed_chunk: {
    chunk_id: "chunk_02",
    scene_ids: ["scene_02"],
    candidate_plan: { reference_targets: [{ ref_id: "repaired_ref" }], character_state_refs: [] },
  },
}]);
assert.deepEqual(repairedPartial.passed_chunks.map((row) => row.chunk_id), ["chunk_01", "chunk_02"]);
assert.deepEqual(repairedPartial.failed_chunks.map((row) => row.chunk_id), ["chunk_03"]);
assert.equal(repairedPartial.passed_chunks[0].candidate_plan.reference_targets[0].ref_id, "passed_ref");
assert.throws(
  () => selectReferencePartialRepairScopeForTests(partial, { chunkIds: ["chunk_99"] }),
  /non-failed IDs/,
);
assert.throws(
  () => selectReferencePartialRepairScopeForTests(partial, { repairGlobal: true }),
  /Repair the exact failed reference chunks/,
);
assert.equal(plannerInvocationScope({ "repair-chunk-ids": "chunk_02" }).scoped, true);
assert.equal(plannerInvocationScope({ "repair-global": "true" }).scoped, true);

const noisyCharacter = {
  ref_id: "joey_action_plate",
  kind: "character_state",
  generation_mode: "standalone_ref",
  conditioning_asset_role: "identity_state",
  identity_subtype: "human",
  reference_pose: "running",
  visible_subject_count: 2,
  hands_policy: "holding_sword",
  expected_visible_hands: null,
  detachable_props: ["sword"],
  integrated_anatomy_features: [],
  prompt_anchor: "Joey running while holding a sword",
};
const noisyCharacterFindings = characterReferenceContentFindingsForTests(noisyCharacter);
assert(noisyCharacterFindings.length > 0);
assert(noisyCharacterFindings.every((finding) => finding.severity === "warning" && finding.production_blocking === false));
const heldPropFindings = nonCharacterReferenceContentFindingsForTests({
  ref_id: "sword_ref",
  kind: "prop",
  generation_mode: "standalone_ref",
  prompt_anchor: "a sword held by a warrior's hand",
});
assert(heldPropFindings.some((finding) => finding.code === "prop_reference_anchor_contains_holder"));
assert(heldPropFindings.every((finding) => finding.severity === "warning"));
const coverageWarnings = recurringReferenceCoverageFindingsForTests({
  assets: [{ asset_id: "joey", kind: "character_state", subject: "Joey", beat_count: 3, scene_ids: ["scene_01", "scene_02"] }],
}, []);
assert.equal(coverageWarnings[0].severity, "warning");
const familyWarnings = referenceDirectorSelectionFindingsForTests([
  { ref_id: "joey_a", kind: "character_state", generation_mode: "standalone_ref", canonical_subject_id: "joey", state_delta: "base", conditioning_subject_count: 1, conditioning_asset_role: "identity_state", clean_plate_contract: "clean", scene_ids: ["scene_01"] },
  { ref_id: "joey_b", kind: "character_state", generation_mode: "standalone_ref", canonical_subject_id: "joey", state_delta: "base", conditioning_subject_count: 1, conditioning_asset_role: "identity_state", clean_plate_contract: "clean", scene_ids: ["scene_01"] },
], { llmTargetIds: new Set(["joey_a", "joey_b"]), knownSceneIds: new Set(["scene_01"]) });
assert.equal(familyWarnings.find((finding) => finding.code === "duplicate_canonical_reference_family")?.severity, "warning");
const preservedUnknownScope = dropUnknownReferenceSceneScopesForTests([
  { ref_id: "room", scene_ids: ["scene_01", "retired_scene"] },
], new Set(["scene_01"]));
assert.deepEqual(preservedUnknownScope.targets[0].scene_ids, ["scene_01", "retired_scene"]);
assert.equal(preservedUnknownScope.findings[0].code, "reference_target_unknown_scene_scope_preserved");

const evidence = (coverage, instanceCount = 1, edges = {}) => ({
  width: 1920,
  height: 1080,
  foreground_coverage_ratio: coverage,
  instance_count: instanceCount,
  edge_contact_ratios: { left: 0, right: 0, top: 0, bottom: 0.4, ...edges },
});
assert.equal(classifyParallaxSeparationEvidence(evidence(0.3)).recommended_disposition, "approved");
assert.equal(classifyParallaxSeparationEvidence(evidence(0.72, 2)).recommended_disposition, "approved_low_motion");
assert.equal(classifyParallaxSeparationEvidence(evidence(0.95)).recommended_disposition, "repairable");

const selected = selectEvidenceBackedParallaxCandidates([
  { image_id: "weak", start_sec: 1, priority: 100, local_separation_evidence: evidence(0.95) },
  { image_id: "strong_a", start_sec: 2, priority: 80, local_separation_evidence: evidence(0.3) },
  { image_id: "strong_b", start_sec: 3, priority: 70, local_separation_evidence: evidence(0.25) },
  { image_id: "low", start_sec: 40, priority: 90, local_separation_evidence: evidence(0.72, 2) },
], {
  maxCandidates: 3,
  minSpacingSec: 5,
  firstWindowSec: 30,
  openingWindowSec: 180,
  firstWindowTarget: 2,
  retentionWindowTarget: 1,
});
assert.deepEqual(selected.map((row) => row.image_id), ["strong_a", "strong_b", "low"]);

const hash = "a".repeat(64);
const candidates = ["full", "low", "repair", "decline"].map((imageId) => ({
  image_id: imageId,
  image_sha256: hash,
  priority: 80,
  asset_report_path: `/tmp/${imageId}.json`,
  asset_report: {
    mask_sha256: hash,
    foreground_sha256: hash,
    background_sha256: hash,
  },
}));
const report = { source_hashes: { input: hash }, candidates };
const decisions = [
  ["full", "approved"],
  ["low", "approved_low_motion"],
  ["repair", "repairable"],
  ["decline", "declined"],
].map(([imageId, decision]) => ({
  image_id: imageId,
  image_sha256: hash,
  decision,
  asset_report_path: `/tmp/${imageId}.json`,
  mask_sha256: hash,
  foreground_sha256: hash,
  background_sha256: hash,
}));
const approval = {
  status: "approved",
  asset_contract_sha256: parallaxAssetContractSha256(report),
  approved_image_ids: ["full"],
  approved_low_motion_image_ids: ["low"],
  repairable_image_ids: ["repair"],
  declined_image_ids: ["decline"],
  decisions,
};
assert.equal(parallaxApprovalMatches(report, approval), true);

const assetReport = {
  status: "passed",
  image_sha256: hash,
  background_path: "/tmp/background.png",
  background_sha256: hash,
  foreground_path: "/tmp/foreground.png",
  foreground_sha256: hash,
};
const intent = { behavior: "slow_push_in", start_anchor: { x: 0.5, y: 0.5 }, end_anchor: { x: 0.5, y: 0.5 } };
const fullMotion = noticeableParallaxTreatment({ intent, assetReport, candidate: { priority: 90 }, disposition: "approved" });
const lowMotion = noticeableParallaxTreatment({ intent, assetReport, candidate: { priority: 90 }, disposition: "approved_low_motion" });
assert(fullMotion && lowMotion);
assert(lowMotion.foreground_keyframes.at(-1).scale < fullMotion.foreground_keyframes.at(-1).scale);

console.log("reference/parallax policy tests passed");
