import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  exactUnitRecoveryProvenanceForTests,
  narrationSynthesisScopeForTests,
  preservedTtsSelectionsForTests,
} from "../narration-tts-episode.mjs";
import { canonicalQwenBatchSha256 } from "../lib/qwen-liam-batch-contract.mjs";
import { narrationTtsRetryReportPolicy } from "../lib/narration-tts-policy.mjs";
import { validateStructuralNoAudioRetryEvidence } from "../lib/tts-structural-no-audio-retry.mjs";
import { narrationStructuralNoAudioRetryReportValidForTests } from "../run-status.mjs";

const hash = (letter) => letter.repeat(64);
const [kept, failed] = [
  { unit_id: "unit_kept", spoken_text_sha256: hash("a") },
  { unit_id: "unit_failed", spoken_text_sha256: hash("b") },
];
const batchPlan = { batch_plan_sha256: hash("c"), cohorts: [
  { cohort_id: "cohort_1", cohort_sha256: hash("d"), members: [
    { unit_id: kept.unit_id }, { unit_id: failed.unit_id },
  ] },
] };
const retained = {
  unit_id: kept.unit_id, attempt: 1, provider: "qwen_local", model_id: "qwen-model",
  voice_id: "voice", voice_sha256: hash("e"),
  voice_continuity_contract: "voice-contract", spoken_text_sha256: kept.spoken_text_sha256,
  synthesis_identity_sha256: hash("f"), audio_path: "/fixture/kept.wav",
  audio_sha256: hash("1"), selected_qa: { status: "passed" },
};
const runner = {
  unit_id: failed.unit_id, status: "failed", attempt: 1,
  spoken_text_sha256: failed.spoken_text_sha256,
  synthesis_identity_sha256: hash("2"), cohort_id: "cohort_1",
  cohort_sha256: hash("d"), output_path: null, output_sha256: null,
  error_code: "tts_batch_token_limit_reached", token_limit_reached: true,
};
const candidate = {
  unit_id: failed.unit_id, attempt: 1,
  spoken_text_sha256: failed.spoken_text_sha256,
  synthesis_identity_sha256: runner.synthesis_identity_sha256,
  batch_plan_sha256: batchPlan.batch_plan_sha256,
  cohort_id: runner.cohort_id, cohort_sha256: runner.cohort_sha256,
  runner_report_path: "/fixture/runner.json", runner_report_sha256: hash("3"),
  audio_path: null, audio_sha256: null, duration_sec: null,
  qa: { status: "blocked", findings: [
    { severity: "blocker", code: "tts_batch_token_limit_reached" },
  ] },
  disposition: { accepted: false, blocker_codes: ["tts_batch_token_limit_reached"] },
};
const priorReport = {
  schema: "goldflow_narration_tts_report_v1", status: "blocked",
  source_script_hash: hash("4"), narration_generation_plan_sha256: hash("5"),
  narration_generation_plan_file_sha256: hash("6"), results: [retained],
  blockers: [{ unit_id: failed.unit_id, code: "narration_selected_unit_missing" }],
};
const priorUnitQa = {
  source_script_hash: hash("4"), narration_generation_plan_sha256: hash("5"),
  narration_generation_plan_file_sha256: hash("6"),
  selected_units: [{ ...retained, qa: { status: "passed" } }],
  candidates: [retained, candidate],
};
const runnerReport = { status: "completed_with_job_failures",
  batch_plan_sha256: batchPlan.batch_plan_sha256, results: [runner] };
const evidence = {
  schema: "goldflow_qwen_structural_no_audio_retry_evidence_v1",
  evidence_basis: "reviewed_structural_no_audio",
  human_listening_performed: false,
  authorization_origin: "user_authorized_autonomous_production",
  reviewer: "operator", reviewed_at: "2026-10-01T17:00:00Z",
  review_note: "The first submitted cohort hit its objective token limit, returned no audio, and exactly one unit needs another attempt.",
  maximum_additional_attempts: 1,
  source_script_sha256: hash("4"), narration_generation_plan_sha256: hash("5"),
  narration_generation_plan_file_sha256: hash("6"),
  pre_retry_narration_report_sha256: hash("7"), pre_retry_unit_qa_sha256: hash("8"),
  confirmed_units: [{
    unit_id: failed.unit_id, defect_type: "token_limit_no_audio", selected_attempt: 1,
    audio_sha256: null, spoken_text_sha256: failed.spoken_text_sha256,
    synthesis_identity_sha256: candidate.synthesis_identity_sha256,
    failure_candidate_sha256: canonicalQwenBatchSha256(candidate),
    runner_result_sha256: canonicalQwenBatchSha256(runner),
    runner_report_sha256: hash("3"),
    batch_plan_sha256: batchPlan.batch_plan_sha256,
    cohort_id: "cohort_1", cohort_sha256: hash("d"),
  }],
};
const args = {
  evidence, requestedUnitIds: [failed.unit_id],
  sourceScriptSha256: hash("4"), planSha256: hash("5"), planFileSha256: hash("6"),
  priorReport, priorReportSha256: hash("7"),
  priorUnitQa, priorUnitQaSha256: hash("8"),
  runnerReport, runnerReportSha256: hash("3"),
  units: [kept, failed], batchPlan,
};
const before = JSON.stringify(args);
const validated = validateStructuralNoAudioRetryEvidence(args);
assert.equal(validated.unit_id, failed.unit_id);
assert.equal(validated.candidate, candidate);
assert.equal(JSON.stringify(args), before);
const refuses = (change) => {
  const copy = structuredClone(args);
  change(copy);
  assert.throws(() => validateStructuralNoAudioRetryEvidence(copy));
};
for (const field of ["source_script_sha256", "narration_generation_plan_sha256",
  "narration_generation_plan_file_sha256", "pre_retry_narration_report_sha256",
  "pre_retry_unit_qa_sha256"]) {
  refuses((copy) => { copy.evidence[field] = hash("0"); });
}
refuses((copy) => { copy.requestedUnitIds = [kept.unit_id]; });
refuses((copy) => { copy.requestedUnitIds.push(failed.unit_id); });
refuses((copy) => { copy.evidence.human_listening_performed = true; });
refuses((copy) => { copy.evidence.review_note = "too short"; });
refuses((copy) => { copy.evidence.maximum_additional_attempts = 2; });
refuses((copy) => { copy.priorReport.status = "passed"; });
refuses((copy) => { copy.priorReport.results.push({ unit_id: failed.unit_id }); });
refuses((copy) => { copy.priorUnitQa.candidates.push(copy.priorUnitQa.candidates[1]); });
refuses((copy) => { copy.priorUnitQa.candidates[1].attempt = 2; });
refuses((copy) => { copy.priorUnitQa.candidates[1].audio_path = "/fixture/failed.wav"; });
refuses((copy) => { copy.priorUnitQa.candidates[1].disposition.blocker_codes = ["other"]; });
refuses((copy) => { copy.priorUnitQa.candidates[1].cohort_sha256 = hash("0"); });
refuses((copy) => { copy.runnerReport.results[0].error_code = "tts_serial_synthesis_failed"; });
refuses((copy) => { copy.runnerReport.results[0].output_sha256 = hash("0"); });
refuses((copy) => { copy.runnerReportSha256 = hash("0"); });
refuses((copy) => { copy.evidence.confirmed_units[0].failure_candidate_sha256 = hash("0"); });
refuses((copy) => { copy.evidence.confirmed_units[0].runner_result_sha256 = hash("0"); });

const preservation = preservedTtsSelectionsForTests({
  units: [kept, failed], priorReport, priorUnitQa,
  policy: { primary: { provider: "qwen_local", model_id: "qwen-model",
    voice_id: "voice", voice_sha256: hash("e"),
    voice_continuity_contract: "voice-contract" } },
  canonicalPlanSha256: hash("5"), planFileSha256: hash("6"),
  requestedUnitIds: [failed.unit_id], requireAllUnrequested: true,
});
assert.equal(preservation.status, "passed");
assert.deepEqual(preservation.preserved_unit_ids, [kept.unit_id]);
const scope = narrationSynthesisScopeForTests({ units: [kept, failed],
  preservedCandidates: [{ ...retained, qa: { status: "passed" } }],
  requestedRecoveryScope: { requested_unit_ids: [failed.unit_id] },
  evidencePath: "/fixture/review.json", evidenceSha256: hash("9") });
assert.deepEqual(scope.authorized_synthesis_unit_ids, [failed.unit_id]);
assert.deepEqual(scope.preserved_unit_ids, [kept.unit_id]);
const provenance = exactUnitRecoveryProvenanceForTests({
  unit: failed, candidate,
  cohortBinding: { batch_plan_sha256: batchPlan.batch_plan_sha256,
    cohort_id: "cohort_1", cohort_sha256: hash("d") },
  batchPlanSha256: batchPlan.batch_plan_sha256,
  confirmedDefect: "token_limit_no_audio",
  confirmedEvidenceBasis: "reviewed_structural_no_audio",
  confirmedEvidencePath: "/fixture/review.json", confirmedEvidenceSha256: hash("9"),
});
assert.deepEqual(provenance.trigger_codes, ["tts_batch_token_limit_reached"]);
assert.equal(provenance.origin_audio_sha256, null);
assert.equal(provenance.human_listening_performed, false);
const retryPolicy = narrationTtsRetryReportPolicy({ recoveryProvenances: [provenance] });
assert.equal(retryPolicy.retry_only_confirmed_skip_truncation_or_stutter, false);
assert.equal(retryPolicy.reviewed_structural_no_audio_repairs[0].unit_id, failed.unit_id);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-no-audio-retry-"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const bytes = JSON.stringify(value);
  await fs.writeFile(filePath, bytes);
  return digest(bytes);
};
try {
  const planPath = path.join(temp, "narration_generation_plan.json");
  const plan = { source_script_hash: hash("4"), plan_sha256: hash("5"),
    units: [kept, failed], qwen_liam_batch_plan: batchPlan };
  const actualPlanFileHash = await writeJson(planPath, plan);
  const runnerPath = path.join(temp, "assets/audio/narration_tts/runs/original.json");
  const actualRunnerHash = await writeJson(runnerPath, runnerReport);
  const archivedReport = { ...priorReport,
    narration_generation_plan_file_sha256: actualPlanFileHash };
  const reportArchivePath = path.join(temp, "assets/audio/narration_tts/structural-retry-predecessors/report.json");
  const actualReportHash = await writeJson(reportArchivePath, archivedReport);
  const archivedCandidate = { ...candidate, runner_report_path: runnerPath,
    runner_report_sha256: actualRunnerHash };
  const archivedQa = { ...priorUnitQa,
    narration_generation_plan_file_sha256: actualPlanFileHash,
    candidates: [retained, archivedCandidate] };
  const qaArchivePath = path.join(temp, "assets/audio/narration_tts/structural-retry-predecessors/qa.json");
  const actualQaHash = await writeJson(qaArchivePath, archivedQa);
  const reviewedEvidence = structuredClone(evidence);
  reviewedEvidence.narration_generation_plan_file_sha256 = actualPlanFileHash;
  reviewedEvidence.pre_retry_narration_report_sha256 = actualReportHash;
  reviewedEvidence.pre_retry_unit_qa_sha256 = actualQaHash;
  reviewedEvidence.confirmed_units[0].runner_report_sha256 = actualRunnerHash;
  reviewedEvidence.confirmed_units[0].failure_candidate_sha256 = canonicalQwenBatchSha256(archivedCandidate);
  const evidencePath = path.join(temp, "narration_structural_no_audio_retry_evidence_ep_01.json");
  const actualEvidenceHash = await writeJson(evidencePath, reviewedEvidence);
  const actualProvenance = exactUnitRecoveryProvenanceForTests({
    unit: failed, candidate: archivedCandidate,
    cohortBinding: { batch_plan_sha256: batchPlan.batch_plan_sha256,
      cohort_id: "cohort_1", cohort_sha256: hash("d") },
    batchPlanSha256: batchPlan.batch_plan_sha256,
    confirmedDefect: "token_limit_no_audio",
    confirmedEvidenceBasis: "reviewed_structural_no_audio",
    confirmedEvidencePath: evidencePath,
    confirmedEvidenceSha256: actualEvidenceHash,
  });
  const wavPath = path.join(temp, "assets/audio/narration_tts/units/repaired.wav");
  await fs.mkdir(path.dirname(wavPath), { recursive: true });
  await fs.writeFile(wavPath, "fixture audio bytes");
  const wavHash = digest("fixture audio bytes");
  const repaired = { unit_id: failed.unit_id, attempt: 2,
    spoken_text_sha256: failed.spoken_text_sha256,
    audio_sha256: wavHash, synthesis_identity_sha256: hash("9"),
    recovery_provenance: actualProvenance };
  const manifestPath = path.join(temp, "narration_provider_output_manifest_ep_01.json");
  const manifestHash = await writeJson(manifestPath, { units: [
    { ...repaired, audio_path: wavPath },
  ] });
  const completed = { source_script_hash: hash("4"),
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: hash("5"),
    narration_generation_plan_file_sha256: actualPlanFileHash,
    provider_output_manifest_path: manifestPath,
    provider_output_manifest_sha256: manifestHash,
    results: [repaired],
    recovery_scope: {
      pre_retry_narration_report_sha256: actualReportHash,
      pre_retry_narration_report_archive_path: reportArchivePath,
      pre_retry_unit_qa_sha256: actualQaHash,
      pre_retry_unit_qa_archive_path: qaArchivePath,
    },
    retry_policy: narrationTtsRetryReportPolicy({ recoveryProvenances: [actualProvenance] }),
  };
  assert.equal(await narrationStructuralNoAudioRetryReportValidForTests(completed, hash("4")), true);
  const tampered = structuredClone(completed);
  tampered.retry_policy.reviewed_structural_no_audio_repairs[0].unit_id = "other";
  assert.equal(await narrationStructuralNoAudioRetryReportValidForTests(tampered, hash("4")), false);
  await fs.appendFile(evidencePath, "\n");
  assert.equal(await narrationStructuralNoAudioRetryReportValidForTests(completed, hash("4")), false);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
console.log("narration structural no-audio retry tests passed");
