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
  compactLocationContractLedgerForPromptForTests,
  compactLocationContractLedgerForDirectorCardsForTests,
  compactPromptDictionaryTableForTests,
  compactPromptJsonForTests,
  compactPromptTableForTests,
  compactReferenceEvidenceLedgerForDirectorCardsForTests,
  compactStoryFactLedgerForPromptForTests,
  buildReferenceDirectorCandidateCardsForTests,
  dropUnknownReferenceSceneScopesForTests,
  mergeReferencePartialRepairForTests,
  expandPromptDictionaryTableForTests,
  materializeReferenceDirectorSelectionForTests,
  nonCharacterReferenceContentFindingsForTests,
  recurringReferenceCoverageFindingsForTests,
  referenceDirectorSelectionFindingsForTests,
  selectReferencePartialRepairScopeForTests,
} from "../visual-reference-plan.mjs";

const compactPromptFixture = {
  rows: Array.from({ length: 100 }, (_, index) => ({
    ref_id: `ref_${index}`,
    scene_ids: [`scene_${index}`, `scene_${index + 1}`],
    prompt_anchor: "A complete evidence-backed reference anchor with no omitted fields.",
  })),
};
const compactPromptJson = compactPromptJsonForTests(compactPromptFixture);
assert.deepEqual(JSON.parse(compactPromptJson), compactPromptFixture);
assert(compactPromptJson.length < JSON.stringify(compactPromptFixture, null, 2).length);
const compactPromptFields = ["ref_id", "scene_ids", "prompt_anchor"];
const compactPromptTable = compactPromptTableForTests(compactPromptFixture.rows, compactPromptFields);
const restoredPromptRows = compactPromptTable.rows.map((values) => ({
  ...compactPromptTable.constants,
  ...Object.fromEntries(compactPromptTable.fields.map((field, index) => [field, values[index]])),
}));
assert.deepEqual(restoredPromptRows, compactPromptFixture.rows);
assert(JSON.stringify(compactPromptTable).length < JSON.stringify(compactPromptFixture.rows).length);
const dictionaryPromptRows = Array.from({ length: 100 }, (_, index) => ({
  ref_id: `ref_${index % 5}`,
  scene_ids: [`scene_${index % 10}`, `scene_${(index + 1) % 10}`],
  prompt_anchor: `Repeated evidence-backed anchor family ${index % 4} with detailed construction language.`,
}));
const compactPromptDictionaryTable = compactPromptDictionaryTableForTests(dictionaryPromptRows, compactPromptFields);
assert.deepEqual(expandPromptDictionaryTableForTests(compactPromptDictionaryTable), dictionaryPromptRows);
assert(JSON.stringify(compactPromptDictionaryTable).length < JSON.stringify(dictionaryPromptRows).length);

const readableCandidateCards = buildReferenceDirectorCandidateCardsForTests([{
  referenceTargets: [
    {
      candidate_id: "rt_0001",
      ref_id: "kael_chunk_1",
      kind: "character_state",
      subject: "Kael",
      scene_ids: ["scene_001"],
      planned_beat_ids: ["beat_001", "beat_002"],
      inventory_asset_id: "char_kael",
      canonical_subject_id: "kael",
      prompt_anchor: "Kael in his base identity state.",
    },
    {
      candidate_id: "rt_0002",
      ref_id: "kael_chunk_2",
      kind: "character_state",
      subject: "Kael",
      scene_ids: ["scene_002"],
      planned_beat_ids: ["beat_003"],
      inventory_asset_id: "char_kael",
      canonical_subject_id: "kael",
      prompt_anchor: "Kael in his later field state.",
    },
    {
      candidate_id: "rt_0003",
      ref_id: "kael_attack_effect",
      kind: "action",
      subject: "Kael's attack effect",
      scene_ids: ["scene_002"],
      planned_beat_ids: ["beat_004"],
      inventory_asset_id: "char_kael",
      prompt_anchor: "A clean effect study for Kael's attack.",
    },
  ],
  characterStateRefs: [{
    candidate_id: "cs_0001",
    state_ref_id: "kael_chunk_1",
    character: "Kael",
    source_ref_id: "kael_chunk_1",
    source_target_candidate_id: "rt_0001",
    scene_prompt_anchor: "Kael in his base state",
  }],
}]);
assert.equal(readableCandidateCards.reference_target_proposal_count, 3);
assert.equal(readableCandidateCards.character_state_proposal_count, 1);
assert.equal(readableCandidateCards.card_count, 2);
assert.deepEqual(readableCandidateCards.cards.flatMap((card) => (
  card.target_candidate_lines.flatMap((line) => line.split(" | ")[0].split(","))
)), ["rt_0001", "rt_0002", "rt_0003"]);
assert.equal(readableCandidateCards.cards[0].union_scene_scope, "scene_001,scene_002");
assert.deepEqual(
  readableCandidateCards.cards[0].character_state_candidate_lines[0].split(" | ")[0].split(","),
  ["cs_0001"],
);
assert.equal(readableCandidateCards.unlinked_character_state_candidates.length, 0);

const compactDirectorEvidence = compactReferenceEvidenceLedgerForDirectorCardsForTests({
  schema: "goldflow_reference_evidence_ledger_v1",
  summary: { asset_count: 1 },
  assets: [{
    asset_id: "char_kael",
    kind: "character_state",
    subject: "Kael",
    entity_type: "named_or_distinct_character",
    scene_ids: ["scene_001", "scene_002"],
    distinct_scene_count: 2,
    beat_count: 5,
    reuse_span_sec: 90,
    canonical_subject_key: "kael",
  }],
});
assert.equal(compactDirectorEvidence.asset_count, 1);
assert.match(compactDirectorEvidence.asset_lines[0], /char_kael \| kind=character_state/);

const materializedDirectorSelection = materializeReferenceDirectorSelectionForTests({
  selection_contract: "goldflow_reference_director_selection_rows_v2",
  reference_selection_rows: [
    ["kael_base_identity", ["rt_0001", "rt_0002"], "required", "standalone_ref", 1],
  ],
  character_state_selection_rows: [
    ["kael_base_identity", ["cs_0001"], "kael_base_identity", "full_identity", null],
  ],
  reference_overrides: {},
  character_state_overrides: {},
  warnings: [],
}, {
  referenceTargetCatalog: new Map([
    ["rt_0001", {
      ref_id: "kael_identity_chunk_1",
      kind: "character_state",
      subject: "Kael",
      scene_ids: ["scene_001"],
      planned_beat_ids: ["beat_001"],
      evidence_asset_ids: ["character_kael"],
      prompt_anchor: "Kael base identity anchor",
      appearance_count: 2,
    }],
    ["rt_0002", {
      ref_id: "kael_identity_chunk_2",
      kind: "character_state",
      subject: "Kael",
      scene_ids: ["scene_002"],
      planned_beat_ids: ["beat_002"],
      evidence_asset_ids: ["character_kael"],
      prompt_anchor: "Kael base identity anchor",
      appearance_count: 3,
    }],
  ]),
  characterStateRefCatalog: new Map([["cs_0001", {
    state_ref_id: "kael_identity_chunk_1",
    character: "Kael",
    scene_ids: ["scene_001"],
    prompt_anchor: "Kael base identity anchor",
    scene_prompt_anchor: "Kael in his base state",
    source_ref_id: "kael_identity_chunk_1",
    identity_usage: "full_identity",
  }]]),
});
assert.equal(materializedDirectorSelection.reference_targets.length, 1);
assert.deepEqual(materializedDirectorSelection.reference_targets[0].scene_ids, ["scene_001", "scene_002"]);
assert.deepEqual(materializedDirectorSelection.reference_targets[0].evidence_asset_ids, ["character_kael"]);
assert.equal(materializedDirectorSelection.reference_targets[0].appearance_count, 3);
assert.equal(materializedDirectorSelection.character_state_refs[0].source_ref_id, "kael_base_identity");

const compactLocationContracts = compactLocationContractLedgerForPromptForTests({
  schema: "goldflow_location_contract_ledger_v1",
  status: "passed",
  contracts: [{
    location_contract_id: "guild_hall",
    description: "Guild hall",
    scene_ids: ["scene_001"],
    beat_ids: ["beat_001", "beat_002"],
    local_location_labels: ["main floor"],
    reasons: ["semantic location scope"],
  }],
});
assert.equal(compactLocationContracts.contracts[0].beat_count, 2);
assert.equal(Object.hasOwn(compactLocationContracts.contracts[0], "beat_ids"), false);
const compactDirectorLocationContracts = compactLocationContractLedgerForDirectorCardsForTests({
  schema: "goldflow_location_contract_ledger_v1",
  status: "passed",
  contracts: [{
    location_contract_id: "guild_hall",
    description: "Guild hall",
    scene_ids: ["scene_001"],
    beat_ids: ["beat_001", "beat_002"],
    local_location_labels: ["main floor"],
  }],
});
assert.equal(compactDirectorLocationContracts.contract_count, 1);
assert.match(compactDirectorLocationContracts.contract_lines[0], /guild_hall \| description=Guild hall/);

const compactStoryFacts = compactStoryFactLedgerForPromptForTests({
  canonical_entities: [{ entity_id: "kael", display_name: "Kael", kind: "person", aliases: ["Kael"], evidence: [{ exact_excerpt: "unused" }] }],
  state_transitions: [{
    entity_id: "kael",
    state_kind: "location",
    from_state: "gate",
    to_state: "guild",
    transition_evidence_excerpt: "Kael left the gate and entered the guild.",
    evidence: [{ exact_excerpt: "unused" }],
  }],
});
assert.equal(Object.hasOwn(compactStoryFacts.canonical_entities[0], "evidence"), false);
assert.equal(Object.hasOwn(compactStoryFacts.state_transitions[0], "evidence"), false);

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
  local_separation_evidence: {
    foreground_centroid: { x: 0.64, y: 0.42 },
  },
};
const intent = { behavior: "slow_push_in", start_anchor: { x: 0.5, y: 0.5 }, end_anchor: { x: 0.5, y: 0.5 } };
const fullMotion = noticeableParallaxTreatment({ intent, assetReport, candidate: { priority: 90 }, disposition: "approved" });
const lowMotion = noticeableParallaxTreatment({ intent, assetReport, candidate: { priority: 90 }, disposition: "approved_low_motion" });
assert(fullMotion && lowMotion);
assert(lowMotion.foreground_keyframes.at(-1).scale < fullMotion.foreground_keyframes.at(-1).scale);
assert.deepEqual(fullMotion.background_keyframes[0].anchor, { x: 0.64, y: 0.42 });
assert.deepEqual(fullMotion.foreground_keyframes[0].anchor, { x: 0.64, y: 0.42 });
assert(fullMotion.foreground_keyframes[0].scale > fullMotion.background_keyframes[0].scale);

console.log("reference/parallax policy tests passed");
