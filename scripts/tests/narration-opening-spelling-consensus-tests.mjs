import assert from "node:assert/strict";
import { transcriptQaForTests, TRANSCRIPT_QA_COMPARISON_VERSION } from "../modelslab-qwen-episode-audio.mjs";
import { buildNarrationQualityContract } from "../lib/narration-quality-contract.mjs";
import {
  NARRATION_DELIVERY_CONSENSUS_VERSION,
  adjudicateNarrationDeliveryConsensus,
} from "../lib/narration-delivery-quality.mjs";
import { blockedNarrationComparatorRefreshEligibleForTests } from "../run-status.mjs";

const base = buildNarrationQualityContract({ provider: "qwen_local", modelId: "fixture" });
const automated = { ...base, delivery_qa: { ...base.delivery_qa,
  acceptance_mode: "automated_asr_v1",
  substitution_only_asr_disagreement_requires_exact_listen: false,
  substitution_only_high_wer_requires_exact_listen: false } };
const decide = (source, small, medium, contract = automated) =>
  adjudicateNarrationDeliveryConsensus({
    primaryTranscriptQa: transcriptQaForTests(source, small, { blockAnySubstitution: false }),
    confirmationTranscriptQa: transcriptQaForTests(source, medium, { blockAnySubstitution: false }),
    contract,
  });
const blockerCodes = (decision) => decision.blockers.map((row) => row.code);

const spelling = decide("Vale watched my face.", "Vail watched my face.", "Veil watch, my face.");
assert.equal(NARRATION_DELIVERY_CONSENSUS_VERSION, "protected_operations_edge_spelling_v2");
assert.deepEqual(blockerCodes(spelling), []);
assert.equal(spelling.status, "passed_with_warnings");
assert.ok(spelling.warnings.some((row) => row.code === "narration_opening_asr_spelling_ambiguity"
  && row.review_required === false && row.intended === "vale"
  && row.primary === "vail" && row.confirmation === "veil"));

// One recognizer's near spelling cannot excuse the other's different word.
assert.ok(blockerCodes(decide("Venn left without his sword.",
  "then left without his sword.", "Ven left without his sword."))
  .includes("narration_confirmed_opening_token_mismatch"));
for (const [source, small, medium] of [
  ["Gate watched my face.", "Late watched my face.", "Late watched my face."],
  ["Vale watched my face.", "Vail watched my face.", "Vail watched my face."],
  ["Dear watched my face.", "Door watched my face.", "Dour watched my face."],
  ["Vale watched my face.", "watched my face.", "watched my face."],
  ["Vale watched my face.", "Vail my face.", "Veil my face."],
  ["Vale watched my face.", "Vail saw my face.", "Veil saw my face."],
  ["Vale", "Vail", "Veil"],
  ["Name watched my face.", "None watched my face.", "None watched my face."],
]) {
  assert.ok(blockerCodes(decide(source, small, medium)).length > 0, `${source} / ${small}`);
}
// The historical listening contract is unchanged by automated-ASR guidance.
assert.ok(blockerCodes(decide("Vale watched my face.", "Vail watched my face.",
  "Veil watched my face.", base)).includes("narration_confirmed_opening_token_mismatch"));

const oldConsensus = "protected_operations_same_intended_slot_v1";
const reportBoundManifestPath = "/episode/exact-boundary/manifest.json";
const report = {
  status: "blocked", unit_qa_status: "blocked", full_stream_qa_status: "not_run_due_to_unit_blockers",
  source_script_hash: "script", narration_generation_plan_sha256: "plan",
  narration_generation_plan_file_sha256: "plan-file", narration_quality_contract_sha256: "contract",
  provider_output_manifest_path: reportBoundManifestPath,
  provider_output_manifest_sha256: "manifest-file",
  blockers: [{ unit_id: "unit-1", code: "narration_confirmed_opening_token_mismatch" }],
};
const delivery = {
  status: "blocked", transcript_comparison_version: TRANSCRIPT_QA_COMPARISON_VERSION,
  source_script_hash: "script", narration_generation_plan_sha256: "plan",
  narration_generation_plan_file_sha256: "plan-file", quality_contract_sha256: "contract",
  blockers: report.blockers,
  units: [{ unit_id: "unit-1", decision: { adjudication_version: oldConsensus } }],
};
const fixture = {
  ttsReport: report, unitDelivery: delivery,
  providerOutput: { status: "passed", narration_generation_plan_sha256: "plan",
    narration_generation_plan_file_sha256: "plan-file", narration_quality_contract_sha256: "contract" },
  plan: { source_script_hash: "script", plan_sha256: "plan" },
  planFileSha256: "plan-file", currentScriptHash: "script",
  qualityContractSha256: "contract", providerValidation: { status: "passed" },
  providerAudioHashesValid: true, providerOutputPath: reportBoundManifestPath,
  providerOutputFileSha256: "manifest-file",
};
assert.equal(blockedNarrationComparatorRefreshEligibleForTests(fixture), true);
assert.equal(blockedNarrationComparatorRefreshEligibleForTests({ ...fixture,
  providerOutputFileSha256: "tampered" }), false);
assert.equal(blockedNarrationComparatorRefreshEligibleForTests({ ...fixture,
  providerAudioHashesValid: false }), false);
assert.equal(blockedNarrationComparatorRefreshEligibleForTests({ ...fixture,
  unitDelivery: { ...delivery, units: [{ decision: {
    adjudication_version: NARRATION_DELIVERY_CONSENSUS_VERSION } }] } }), false);
assert.equal(blockedNarrationComparatorRefreshEligibleForTests({ ...fixture,
  ttsReport: { ...report, blockers: [{ unit_id: "unit-2", code: "narration_confirmed_opening_token_mismatch" }] } }), false);
assert.equal(blockedNarrationComparatorRefreshEligibleForTests({ ...fixture,
  unitDelivery: { ...delivery, blockers: [{ unit_id: "unit-1", code: "narration_unsettled_raw_audio_edge" }] },
  ttsReport: { ...report, blockers: [{ unit_id: "unit-1", code: "narration_unsettled_raw_audio_edge" }] } }), false);
console.log("narration opening spelling consensus tests passed");
