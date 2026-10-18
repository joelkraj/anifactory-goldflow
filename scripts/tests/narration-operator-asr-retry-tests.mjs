import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  exactUnitRecoveryProvenanceForTests,
  validateConfirmedRetryEvidenceForTests,
} from "../narration-tts-episode.mjs";
import { canonicalQwenBatchSha256 } from "../lib/qwen-liam-batch-contract.mjs";
import { narrationTtsRetryReportPolicy, QWEN_LIAM_RETRY_CONTRACT } from "../lib/narration-tts-policy.mjs";
import { narrationOperatorAsrRetryReportValidForTests } from "../run-status.mjs";

const hash = (letter) => letter.repeat(64);
const sourceHash = hash("a"), planHash = hash("b"), planFileHash = hash("c"), reportHash = hash("d");
const make = (unitId, defectType, codes, audioHash, identityHash) => {
  const delivery = { schema: "goldflow_narration_delivery_consensus_v2", status: "blocked",
    confirmation_required: true, primary_model: "small.en", confirmation_model: "medium",
    blockers: codes.map((code) => ({ code, severity: "blocker" })), warnings: [] };
  const prior = { unit_id: unitId, attempt: 1, audio_sha256: audioHash,
    synthesis_identity_sha256: identityHash, selected_qa: { status: "blocked", delivery } };
  return { prior, evidence: { unit_id: unitId, defect_type: defectType,
    evidence_note: "Retained Small and Medium both report this exact defect; no listening performed.",
    reviewed_blocker_codes: codes, selected_attempt: 1, audio_sha256: audioHash,
    synthesis_identity_sha256: identityHash, selected_delivery_qa_sha256: canonicalQwenBatchSha256(delivery) } };
};
const first = make("u51", "unexpected_words", ["narration_confirmed_unexpected_word"], hash("e"), hash("f"));
const second = make("u176", "truncation", ["narration_confirmed_final_word_missing", "narration_confirmed_word_omission"], hash("1"), hash("2"));
const priorReport = { schema: "goldflow_narration_tts_report_v1", status: "blocked",
  source_script_hash: sourceHash, narration_generation_plan_sha256: planHash,
  narration_generation_plan_file_sha256: planFileHash, results: [first.prior, second.prior],
  blockers: [first.prior, second.prior].flatMap((row) => row.selected_qa.delivery.blockers
    .map((finding) => ({ ...finding, unit_id: row.unit_id }))) };
const evidence = { schema: "goldflow_confirmed_tts_retry_evidence_v2",
  evidence_basis: "operator_authorized_asr_consensus", human_listening_performed: false,
  operator_quote: "No listening. Just make the call and get this prod done.",
  operator_reason: "The user explicitly waived listening and authorized bounded retakes of independently confirmed ASR defects.",
  authorized_by: "operator", authorized_at: "2026-09-12T18:00:00Z", maximum_attempts_per_unit: 1,
  source_script_sha256: sourceHash, narration_generation_plan_sha256: planHash,
  narration_generation_plan_file_sha256: planFileHash, pre_retry_narration_report_sha256: reportHash,
  confirmed_units: [first.evidence, second.evidence] };
const args = { evidence, requestedUnitIds: ["u51", "u176"], planSha256: planHash,
  planFileSha256: planFileHash, sourceScriptSha256: sourceHash, priorReport,
  priorReportSha256: reportHash, currentCandidates: priorReport.results };
const before = JSON.stringify(args);
const valid = validateConfirmedRetryEvidenceForTests(args);
assert.equal(valid.length, 2);
assert.ok(valid.every((row) => row.evidence_basis === "operator_authorized_asr_consensus"
  && row.human_listening_performed === false));
assert.equal(JSON.stringify(args), before);
const refuses = (change) => {
  const candidate = structuredClone(args);
  change(candidate);
  assert.throws(() => validateConfirmedRetryEvidenceForTests(candidate));
};
for (const key of ["source_script_sha256", "narration_generation_plan_sha256",
  "narration_generation_plan_file_sha256", "pre_retry_narration_report_sha256"]) {
  refuses((a) => { a.evidence[key] = hash("0"); });
}
for (const key of ["audio_sha256", "synthesis_identity_sha256", "selected_delivery_qa_sha256"]) {
  refuses((a) => { a.evidence.confirmed_units[0][key] = hash("0"); });
}
refuses((a) => { a.evidence.human_listening_performed = true; });
refuses((a) => { a.evidence.attestation = "exact_audio_listened_end_to_end"; });
refuses((a) => { a.evidence.operator_quote = ""; });
refuses((a) => { a.evidence.operator_reason = "too short"; });
refuses((a) => { a.evidence.maximum_attempts_per_unit = 2; });
refuses((a) => { a.evidence.confirmed_units[0].defect_type = "stutter"; });
refuses((a) => { a.evidence.confirmed_units[0].defect_type = "truncation"; });
refuses((a) => { a.evidence.confirmed_units[0].reviewed_blocker_codes = []; });
refuses((a) => { a.evidence.confirmed_units[0].evidence_note = ""; });
refuses((a) => { a.evidence.confirmed_units.push(a.evidence.confirmed_units[0]); });
refuses((a) => { a.requestedUnitIds = ["u176"]; });
refuses((a) => { a.requestedUnitIds = ["u51", "u51"]; });
refuses((a) => { a.priorReport.results[0].selected_qa.delivery.confirmation_required = false; });
refuses((a) => { a.priorReport.results[0].selected_qa.delivery.confirmation_model = "small.en"; });
refuses((a) => { a.priorReport.blockers = []; });
refuses((a) => { a.currentCandidates[0].audio_sha256 = hash("0"); });
refuses((a) => { a.evidence.evidence_basis = "model_guess"; });
refuses((a) => { a.priorReport.results[0].attempt = 2; a.evidence.confirmed_units[0].selected_attempt = 2; });

// Existing heard evidence is unchanged; unexpected words cannot enter that
// route simply by assigning a new defect string or omitting the explicit basis.
const legacy = structuredClone(args);
legacy.evidence = { narration_generation_plan_sha256: planHash,
  pre_retry_narration_report_sha256: reportHash,
  confirmed_units: [{ ...second.evidence, listen_note: "The listener confirmed the final word was cut off." }] };
legacy.requestedUnitIds = ["u176"];
const legacyResult = validateConfirmedRetryEvidenceForTests(legacy);
assert.equal(legacyResult.length, 1);
assert.equal(legacyResult[0].evidence_basis, undefined);
assert.throws(() => validateConfirmedRetryEvidenceForTests({ ...args,
  evidence: { ...evidence, evidence_basis: undefined } }));

const automated = structuredClone(args);
automated.requestedUnitIds = ["u51"];
automated.evidence = {
  ...evidence,
  evidence_basis: "reviewed_automated_delivery_qa",
  authorization_origin: "user_authorized_autonomous_asr_qa",
  operator_quote: undefined,
  confirmed_units: [{
    ...first.evidence, defect_type: "delivery",
    selected_qa_sha256: canonicalQwenBatchSha256(first.prior.selected_qa),
  }],
};
assert.equal(validateConfirmedRetryEvidenceForTests(automated)[0].evidence_basis,
  "reviewed_automated_delivery_qa");
for (const mutate of [
  (copy) => { copy.evidence.confirmed_units[0].selected_qa_sha256 = hash("0"); },
  (copy) => { copy.evidence.confirmed_units[0].reviewed_blocker_codes = []; },
  (copy) => { copy.evidence.authorization_origin = "unknown"; },
  (copy) => { copy.priorReport.results[0].attempt = 2; },
]) {
  const copy = structuredClone(automated);
  mutate(copy);
  assert.throws(() => validateConfirmedRetryEvidenceForTests(copy));
}

const provenance = exactUnitRecoveryProvenanceForTests({
  unit: { unit_id: "u51", spoken_text_sha256: hash("3") },
  candidate: { ...first.prior, qa: first.prior.selected_qa },
  cohortBinding: { cohort_id: "cohort_1", cohort_sha256: hash("4"), batch_plan_sha256: hash("5") },
  batchPlanSha256: hash("5"), confirmedDefect: "unexpected_words",
  confirmedEvidenceBasis: "operator_authorized_asr_consensus",
  confirmedEvidencePath: "/operator-evidence.json", confirmedEvidenceSha256: hash("6"),
});
assert.deepEqual(provenance.trigger_codes, ["operator_authorized_asr_consensus_unexpected_words"]);
assert.equal(provenance.human_listening_performed, false);
assert.equal(provenance.evidence_basis, "operator_authorized_asr_consensus");
assert.equal(narrationTtsRetryReportPolicy().retry_only_confirmed_skip_truncation_or_stutter, true);
assert.equal(narrationTtsRetryReportPolicy().operator_authorized_asr_consensus_exceptions, undefined);
const reportPolicy = narrationTtsRetryReportPolicy({ recoveryProvenances: [provenance] });
assert.equal(reportPolicy.retry_only_confirmed_skip_truncation_or_stutter, false);
assert.equal(reportPolicy.operator_authorized_asr_consensus_exceptions[0].human_listening_performed, false);
assert.deepEqual(QWEN_LIAM_RETRY_CONTRACT.confirmed_defect_types, ["skip", "truncation", "stutter"]);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-asr-retry-policy-"));
try {
  const evidencePath = path.join(temp, "evidence.json");
  const evidenceBytes = JSON.stringify(evidence);
  await fs.writeFile(evidencePath, evidenceBytes);
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const actualRecovery = { ...provenance, confirmed_evidence_path: evidencePath,
    confirmed_evidence_sha256: digest(evidenceBytes) };
  const result = { unit_id: "u51", attempt: 2, audio_sha256: hash("7"),
    synthesis_identity_sha256: hash("8"), recovery_provenance: actualRecovery };
  const manifestPath = path.join(temp, "manifest.json");
  const manifestBytes = JSON.stringify({ units: [result] });
  await fs.writeFile(manifestPath, manifestBytes);
  const completed = { source_script_hash: sourceHash,
    narration_generation_plan_sha256: planHash, narration_generation_plan_file_sha256: planFileHash,
    provider_output_manifest_path: manifestPath, provider_output_manifest_sha256: digest(manifestBytes),
    results: [result], retry_policy: narrationTtsRetryReportPolicy({ recoveryProvenances: [actualRecovery] }) };
  assert.equal(await narrationOperatorAsrRetryReportValidForTests(completed, sourceHash), true);
  assert.equal(await narrationOperatorAsrRetryReportValidForTests(completed, hash("0")), false);
  const wrong = structuredClone(completed);
  wrong.retry_policy.operator_authorized_asr_consensus_exceptions[0].unit_id = "unknown";
  assert.equal(await narrationOperatorAsrRetryReportValidForTests(wrong, sourceHash), false);
  const staleManifest = { ...completed, provider_output_manifest_sha256: hash("0") };
  assert.equal(await narrationOperatorAsrRetryReportValidForTests(staleManifest, sourceHash), false);
  const truncationRecovery = { ...actualRecovery, unit_id: "u176",
    origin_audio_sha256: second.prior.audio_sha256,
    origin_synthesis_identity_sha256: second.prior.synthesis_identity_sha256,
    trigger_codes: ["operator_authorized_asr_consensus_truncation"] };
  const truncationResult = { ...result, unit_id: "u176", recovery_provenance: truncationRecovery };
  const truncationManifest = JSON.stringify({ units: [truncationResult] });
  await fs.writeFile(manifestPath, truncationManifest);
  const truncationReport = { ...completed, results: [truncationResult],
    provider_output_manifest_sha256: digest(truncationManifest),
    retry_policy: narrationTtsRetryReportPolicy({ recoveryProvenances: [truncationRecovery] }) };
  assert.equal(truncationReport.retry_policy.retry_only_confirmed_skip_truncation_or_stutter, true);
  assert.equal(await narrationOperatorAsrRetryReportValidForTests(truncationReport, sourceHash), true);
  await fs.appendFile(evidencePath, "\n");
  assert.equal(await narrationOperatorAsrRetryReportValidForTests(truncationReport, sourceHash), false);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
console.log("narration operator ASR retry tests passed");
