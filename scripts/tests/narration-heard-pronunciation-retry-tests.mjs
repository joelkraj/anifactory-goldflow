import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  exactUnitRecoveryProvenanceForTests,
  narrationSynthesisScopeForTests,
  preservedTtsFinalInputsForTests,
  validateConfirmedRetryEvidenceForTests,
} from "../narration-tts-episode.mjs";
import { narrationTtsRetryReportPolicy, QWEN_LIAM_RETRY_CONTRACT } from "../lib/narration-tts-policy.mjs";
import { narrationHeardPronunciationRetryReportValidForTests } from "../run-status.mjs";

const hash = (letter) => letter.repeat(64);
const digest = (text) => createHash("sha256").update(text).digest("hex");
const sourceHash = hash("a"), planHash = hash("b"), planFileHash = hash("c"), reportHash = hash("d");
const unit = { unit_id: "u98", spoken_text: "He asked the Eye for an answer." };
unit.spoken_text_sha256 = digest(unit.spoken_text);
const prior = { ...unit, attempt: 1, audio_sha256: hash("e"), synthesis_identity_sha256: hash("f") };
const priorReport = { schema: "goldflow_narration_tts_report_v1", status: "blocked",
  source_script_hash: sourceHash, narration_generation_plan_sha256: planHash,
  narration_generation_plan_file_sha256: planFileHash, results: [prior] };
const evidence = { schema: "goldflow_confirmed_tts_retry_evidence_v2",
  evidence_basis: "operator_confirmed_pronunciation", human_listening_performed: true,
  attestation: "operator_heard_pronunciation_in_exact_selected_audio",
  operator_quote: "The clip said A-I and not eye.",
  operator_reason: "The operator heard the two letter pronunciation in this exact selected clip and requests one unchanged-text retake.",
  authorized_by: "operator", authorized_at: "2026-09-21T23:00:00.000Z", maximum_attempts_per_unit: 1,
  source_script_sha256: sourceHash, narration_generation_plan_sha256: planHash,
  narration_generation_plan_file_sha256: planFileHash, pre_retry_narration_report_sha256: reportHash,
  pre_retry_narration_report_path: "/review/prior-report.json",
  confirmed_units: [{ unit_id: unit.unit_id, defect_type: "pronunciation",
    listen_note: "The operator identified the spoken letters A-I instead of the word Eye.",
    expected_spoken_word: "Eye", heard_pronunciation: "A-I (two letters)",
    spoken_text_sha256: unit.spoken_text_sha256, selected_attempt: 1,
    audio_sha256: prior.audio_sha256, synthesis_identity_sha256: prior.synthesis_identity_sha256 }] };
const args = { evidence, requestedUnitIds: [unit.unit_id], planSha256: planHash,
  planFileSha256: planFileHash, sourceScriptSha256: sourceHash, priorReport,
  priorReportSha256: reportHash, currentCandidates: [prior], currentUnits: [unit], priorCandidates: [prior] };
const before = JSON.stringify(args);
const valid = validateConfirmedRetryEvidenceForTests(args);
assert.equal(valid.length, 1);
assert.equal(valid[0].evidence_basis, "operator_confirmed_pronunciation");
assert.equal(valid[0].human_listening_performed, true);
assert.equal(valid[0].expected_spoken_word, "Eye");
assert.equal(JSON.stringify(args), before, "validation must not change text, evidence or candidates");
const refuses = (change) => {
  const candidate = structuredClone(args);
  change(candidate);
  assert.throws(() => validateConfirmedRetryEvidenceForTests(candidate));
};
for (const key of ["source_script_sha256", "narration_generation_plan_sha256",
  "narration_generation_plan_file_sha256", "pre_retry_narration_report_sha256"]) {
  refuses((a) => { a.evidence[key] = hash("0"); });
}
for (const key of ["audio_sha256", "synthesis_identity_sha256", "spoken_text_sha256"]) {
  refuses((a) => { a.evidence.confirmed_units[0][key] = hash("0"); });
}
for (const key of ["operator_quote", "operator_reason", "authorized_by", "authorized_at", "attestation"]) {
  refuses((a) => { a.evidence[key] = ""; });
}
refuses((a) => { a.evidence.authorized_at = "yesterday"; });
refuses((a) => { delete a.evidence.pre_retry_narration_report_path; });
refuses((a) => { a.evidence.pre_retry_narration_report_path = "relative.json"; });
refuses((a) => { a.evidence.human_listening_performed = false; });
refuses((a) => { a.evidence.evidence_basis = "human_listening"; });
refuses((a) => { delete a.evidence.evidence_basis; });
refuses((a) => { a.evidence.maximum_attempts_per_unit = 2; });
refuses((a) => { a.evidence.confirmed_units[0].defect_type = "skip"; });
refuses((a) => { a.evidence.confirmed_units[0].defect_type = "Pronunciation"; });
refuses((a) => { a.evidence.confirmed_units[0].selected_attempt = "1"; });
refuses((a) => { a.evidence.confirmed_units[0].listen_note = ""; });
refuses((a) => { a.evidence.confirmed_units[0].heard_pronunciation = ""; });
refuses((a) => { a.evidence.confirmed_units[0].heard_pronunciation = "eye"; });
refuses((a) => { a.evidence.confirmed_units[0].expected_spoken_word = "AI"; });
refuses((a) => { a.evidence.confirmed_units[0].expected_spoken_word = "the Eye"; });
refuses((a) => { a.currentUnits = []; });
refuses((a) => { a.currentUnits[0].spoken_text = "He asked AI for an answer."; });
refuses((a) => { a.priorReport.results[0].spoken_text_sha256 = hash("0"); });
refuses((a) => { a.currentCandidates[0].audio_sha256 = hash("0"); });
refuses((a) => { a.evidence.confirmed_units.push(a.evidence.confirmed_units[0]); });
refuses((a) => { a.requestedUnitIds = [unit.unit_id, unit.unit_id]; });
refuses((a) => { a.requestedUnitIds = []; });
refuses((a) => { a.requestedUnitIds = [unit.unit_id, "u99"];
  a.evidence.confirmed_units.push({ ...a.evidence.confirmed_units[0], unit_id: "u99" }); });
refuses((a) => { a.priorReport.results[0].attempt = 2; a.evidence.confirmed_units[0].selected_attempt = 2; });
refuses((a) => { a.priorCandidates.push({ ...prior, attempt: 2 }); });
refuses((a) => { a.currentCandidates.push({ ...prior, attempt: 2 }); });

const provenance = exactUnitRecoveryProvenanceForTests({ unit, candidate: prior,
  cohortBinding: { cohort_id: "cohort_1", cohort_sha256: hash("1"), batch_plan_sha256: hash("2") },
  batchPlanSha256: hash("2"), confirmedDefect: "pronunciation",
  confirmedEvidenceBasis: "operator_confirmed_pronunciation",
  confirmedEvidencePath: "/heard-evidence.json", confirmedEvidenceSha256: hash("3") });
assert.deepEqual(provenance.trigger_codes, ["operator_confirmed_pronunciation"]);
assert.equal(provenance.evidence_basis, "operator_confirmed_pronunciation");
assert.equal(provenance.human_listening_performed, true);
assert.equal(provenance.spoken_text_sha256, unit.spoken_text_sha256);
const reportPolicy = narrationTtsRetryReportPolicy({ recoveryProvenances: [provenance] });
assert.equal(reportPolicy.retry_only_confirmed_skip_truncation_or_stutter, false);
assert.equal(reportPolicy.operator_confirmed_pronunciation_exceptions.length, 1);
assert.equal(reportPolicy.operator_confirmed_pronunciation_exceptions[0].human_listening_performed, true);
assert.equal(reportPolicy.automated_qa_warnings_trigger_retry, false);
assert.equal(narrationTtsRetryReportPolicy().retry_only_confirmed_skip_truncation_or_stutter, true);
assert.deepEqual(QWEN_LIAM_RETRY_CONTRACT.confirmed_defect_types, ["skip", "truncation", "stutter"]);

// Exact recovery leaves all other selected artifacts and their QA untouched.
const retained = Array.from({ length: 1109 }, (_, i) => ({ unit_id: `keep_${i}`,
  audio_sha256: digest(String(i)), attempt: 1, qa: { status: "passed_with_warnings" } }));
const retainedBefore = JSON.stringify(retained);
const scope = narrationSynthesisScopeForTests({ units: [unit, ...retained],
  preservedCandidates: [prior, ...retained], requestedRecoveryScope: { requested_unit_ids: [unit.unit_id] },
  evidencePath: "/heard-evidence.json", evidenceSha256: hash("3") });
assert.deepEqual(scope.authorized_synthesis_unit_ids, [unit.unit_id]);
assert.equal(scope.preserved_unit_ids.length, 1109);
assert.deepEqual(scope.preserved_artifacts.map((row) => row.audio_sha256), retained.map((row) => row.audio_sha256));
assert.equal(JSON.stringify(retained), retainedBefore);
const finalInputs = preservedTtsFinalInputsForTests({ units: [unit, ...retained],
  candidatePool: [prior, ...retained], preservedForInvocation: retained,
  policy: { primary: { provider: "qwen_local" } } });
assert.equal(finalInputs.selectedRows.some((row) => row.unit_id === unit.unit_id), false,
  "the rejected first take must not prepopulate selection and prevent selecting a passed replacement");
assert.equal(finalInputs.candidates.find((row) => row.unit_id === unit.unit_id).attempt, 1,
  "the first take remains in history as the recovery origin");

// Status revalidates the completed replacement through real retained files,
// rather than trusting report flags or a detached hearing claim.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-heard-retry-status-"));
try {
  const planPath = path.join(temp, "plan.json");
  const priorPath = path.join(temp, "prior-report.json");
  const evidencePath = path.join(temp, "heard-evidence.json");
  const manifestPath = path.join(temp, "manifest.json");
  const firstAudio = path.join(temp, "first.wav");
  const secondAudio = path.join(temp, "second.wav");
  const writeJson = async (file, value) => {
    const bytes = JSON.stringify(value);
    await fs.writeFile(file, bytes);
    return digest(bytes);
  };
  const buildReport = async ({ changeEvidence, changePrior, changeResult, changeManifest, changePlan } = {}) => {
    await fs.writeFile(firstAudio, "retained first take");
    await fs.writeFile(secondAudio, "unchanged-text replacement");
    const firstHash = digest("retained first take");
    const secondHash = digest("unchanged-text replacement");
    const plan = { plan_sha256: planHash, source_script_hash: sourceHash, units: [structuredClone(unit)] };
    changePlan?.(plan);
    const actualPlanFileHash = await writeJson(planPath, plan);
    const original = { ...prior, audio_path: firstAudio, audio_sha256: firstHash };
    const retainedReport = { ...priorReport,
      narration_generation_plan_file_sha256: actualPlanFileHash, results: [original] };
    changePrior?.(retainedReport);
    const priorHash = await writeJson(priorPath, retainedReport);
    const boundEvidence = { ...structuredClone(evidence),
      narration_generation_plan_file_sha256: actualPlanFileHash,
      pre_retry_narration_report_path: priorPath, pre_retry_narration_report_sha256: priorHash };
    boundEvidence.confirmed_units[0].audio_sha256 = firstHash;
    changeEvidence?.(boundEvidence);
    const evidenceHash = await writeJson(evidencePath, boundEvidence);
    const recovery = { ...structuredClone(provenance), origin_audio_sha256: firstHash,
      confirmed_evidence_path: evidencePath, confirmed_evidence_sha256: evidenceHash };
    const result = { ...unit, attempt: 2, audio_path: secondAudio, audio_sha256: secondHash,
      synthesis_identity_sha256: hash("7"), recovery_provenance: recovery };
    changeResult?.(result);
    const manifest = { units: [structuredClone(result)] };
    changeManifest?.(manifest);
    const manifestHash = await writeJson(manifestPath, manifest);
    return { source_script_hash: sourceHash, narration_generation_plan_path: planPath,
      narration_generation_plan_sha256: planHash, narration_generation_plan_file_sha256: actualPlanFileHash,
      provider_output_manifest_path: manifestPath, provider_output_manifest_sha256: manifestHash,
      results: [result], retry_policy: narrationTtsRetryReportPolicy({ recoveryProvenances: [result.recovery_provenance] }) };
  };
  let completed = await buildReport();
  assert.equal(await narrationHeardPronunciationRetryReportValidForTests(completed, sourceHash), true);
  assert.equal(await narrationHeardPronunciationRetryReportValidForTests(completed, hash("0")), false);
  for (const changeEvidence of [
    (e) => { e.human_listening_performed = false; },
    (e) => { e.operator_quote = ""; },
    (e) => { e.operator_reason = "short"; },
    (e) => { e.authorized_by = ""; },
    (e) => { e.authorized_at = "yesterday"; },
    (e) => { e.attestation = "unheard"; },
    (e) => { e.maximum_attempts_per_unit = 2; },
    (e) => { e.confirmed_units.push(structuredClone(e.confirmed_units[0])); },
    (e) => { e.confirmed_units[0].selected_attempt = 2; },
    (e) => { e.confirmed_units[0].expected_spoken_word = "AI"; },
    (e) => { e.confirmed_units[0].heard_pronunciation = "Eye"; },
    (e) => { e.confirmed_units[0].spoken_text_sha256 = hash("0"); },
    (e) => { e.source_script_sha256 = hash("0"); },
    (e) => { e.narration_generation_plan_file_sha256 = hash("0"); },
    (e) => { e.pre_retry_narration_report_sha256 = hash("0"); },
    (e) => { delete e.pre_retry_narration_report_path; },
  ]) {
    completed = await buildReport({ changeEvidence });
    assert.equal(await narrationHeardPronunciationRetryReportValidForTests(completed, sourceHash), false);
  }
  for (const changes of [
    { changePrior: (r) => { r.results[0].attempt = 2; } },
    { changePrior: (r) => { r.results[0].audio_sha256 = hash("0"); } },
    { changePrior: (r) => { r.results[0].spoken_text_sha256 = hash("0"); } },
    { changeResult: (r) => { r.attempt = 3; } },
    { changeResult: (r) => { r.recovery_provenance.human_listening_performed = false; } },
    { changeResult: (r) => { r.recovery_provenance.origin_synthesis_identity_sha256 = hash("0"); } },
    { changeResult: (r) => { r.recovery_provenance.trigger_codes = ["operator_confirmed_skip"]; } },
    { changeManifest: (m) => { m.units[0].recovery_provenance.spoken_text_sha256 = hash("0"); } },
    { changeManifest: (m) => { m.units.push(structuredClone(m.units[0])); } },
    { changePlan: (p) => { p.units[0].spoken_text = "He asked AI for an answer."; } },
  ]) {
    completed = await buildReport(changes);
    assert.equal(await narrationHeardPronunciationRetryReportValidForTests(completed, sourceHash), false);
  }
  for (const changedFile of [planPath, priorPath, evidencePath, manifestPath, firstAudio, secondAudio]) {
    completed = await buildReport();
    await fs.appendFile(changedFile, " ");
    assert.equal(await narrationHeardPronunciationRetryReportValidForTests(completed, sourceHash), false);
  }
  completed = await buildReport();
  completed.retry_policy.operator_confirmed_pronunciation_exceptions[0].unit_id = "not-reviewed";
  assert.equal(await narrationHeardPronunciationRetryReportValidForTests(completed, sourceHash), false);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
console.log("narration heard pronunciation retry tests passed");
