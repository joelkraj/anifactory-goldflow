import { canonicalQwenBatchSha256 } from "./qwen-liam-batch-contract.mjs";

const TOKEN_LIMIT_CODE = "tts_batch_token_limit_reached";
const HEX_SHA256 = /^[a-f0-9]{64}$/u;

export function validateStructuralNoAudioRetryEvidence({
  evidence,
  requestedUnitIds,
  sourceScriptSha256,
  planSha256,
  planFileSha256,
  priorReport,
  priorReportSha256,
  priorUnitQa,
  priorUnitQaSha256,
  runnerReport,
  runnerReportSha256,
  units,
  batchPlan,
} = {}) {
  const ids = (requestedUnitIds ?? []).map(String);
  if (ids.length !== 1 || !units?.some((unit) => String(unit.unit_id) === ids[0])) {
    throw new Error("Structural no-audio retry must name exactly one current unit.");
  }
  const unitId = ids[0];
  const unit = units.find((row) => String(row.unit_id) === unitId);
  const reviewed = evidence?.confirmed_units;
  if (evidence?.schema !== "goldflow_qwen_structural_no_audio_retry_evidence_v1"
    || evidence.evidence_basis !== "reviewed_structural_no_audio"
    || evidence.human_listening_performed !== false
    || evidence.authorization_origin !== "user_authorized_autonomous_production"
    || !String(evidence.reviewer ?? "").trim()
    || !Number.isFinite(Date.parse(evidence.reviewed_at))
    || String(evidence.review_note ?? "").trim().length < 40
    || evidence.maximum_additional_attempts !== 1
    || !Array.isArray(reviewed) || reviewed.length !== 1
    || reviewed[0]?.unit_id !== unitId
    || evidence.source_script_sha256 !== sourceScriptSha256
    || evidence.narration_generation_plan_sha256 !== planSha256
    || evidence.narration_generation_plan_file_sha256 !== planFileSha256
    || evidence.pre_retry_narration_report_sha256 !== priorReportSha256
    || evidence.pre_retry_unit_qa_sha256 !== priorUnitQaSha256
    || ![sourceScriptSha256, planSha256, planFileSha256,
      priorReportSha256, priorUnitQaSha256].every((value) => HEX_SHA256.test(String(value ?? "")))) {
    throw new Error("Structural no-audio retry evidence lacks exact current bindings or review authorization.");
  }
  if (priorReport?.schema !== "goldflow_narration_tts_report_v1"
    || priorReport.status !== "blocked"
    || priorReport.source_script_hash !== sourceScriptSha256
    || priorReport.narration_generation_plan_sha256 !== planSha256
    || priorReport.narration_generation_plan_file_sha256 !== planFileSha256
    || priorUnitQa?.source_script_hash !== sourceScriptSha256
    || priorUnitQa.narration_generation_plan_sha256 !== planSha256
    || priorUnitQa.narration_generation_plan_file_sha256 !== planFileSha256
    || (priorReport.results ?? []).some((row) => String(row.unit_id) === unitId)
    || (priorUnitQa.selected_units ?? []).some((row) => String(row.unit_id) === unitId)) {
    throw new Error("Structural no-audio retry requires a current blocked report with no selected audio for the exact unit.");
  }
  const expectedRetainedIds = (units ?? []).map((row) => String(row.unit_id))
    .filter((id) => id !== unitId);
  const reportRetainedIds = (priorReport.results ?? []).map((row) => String(row.unit_id));
  const qaRetainedIds = (priorUnitQa.selected_units ?? []).map((row) => String(row.unit_id));
  if (JSON.stringify(reportRetainedIds) !== JSON.stringify(expectedRetainedIds)
    || JSON.stringify(qaRetainedIds) !== JSON.stringify(expectedRetainedIds)) {
    throw new Error("Structural no-audio retry requires every other unit selected in exact source order.");
  }
  const matches = (priorUnitQa.candidates ?? []).filter((row) => String(row?.unit_id) === unitId);
  if (matches.length !== 1) {
    throw new Error("Structural no-audio retry requires exactly one original candidate for the unit.");
  }
  const candidate = matches[0];
  const candidateCodes = candidate.disposition?.blocker_codes
    ?? candidate.qa?.findings?.filter((row) => row.severity === "blocker")
      .map((row) => row.code) ?? [];
  const cohort = batchPlan?.cohorts?.flatMap((row) =>
    (row.members ?? []).some((member) => member.unit_id === unitId) ? [row] : [])?.[0];
  const runnerRows = (runnerReport?.results ?? []).filter((row) => String(row?.unit_id) === unitId);
  const runner = runnerRows[0];
  const row = reviewed[0];
  if (Number(candidate.attempt) !== 1
    || candidate.audio_path != null || candidate.audio_sha256 != null
    || candidate.duration_sec != null
    || candidate.qa?.status !== "blocked"
    || candidateCodes.length !== 1 || candidateCodes[0] !== TOKEN_LIMIT_CODE
    || !HEX_SHA256.test(String(candidate.synthesis_identity_sha256 ?? ""))
    || candidate.spoken_text_sha256 !== unit.spoken_text_sha256
    || candidate.batch_plan_sha256 !== batchPlan?.batch_plan_sha256
    || !cohort || candidate.cohort_id !== cohort.cohort_id
    || candidate.cohort_sha256 !== cohort.cohort_sha256
    || candidate.runner_report_sha256 !== runnerReportSha256
    || runnerReport?.status !== "completed_with_job_failures"
    || runnerReport.batch_plan_sha256 !== batchPlan.batch_plan_sha256
    || runnerRows.length !== 1 || runner.status !== "failed"
    || Number(runner.attempt) !== 1
    || runner.output_path != null || runner.output_sha256 != null
    || runner.error_code !== TOKEN_LIMIT_CODE
    || runner.token_limit_reached !== true
    || runner.synthesis_identity_sha256 !== candidate.synthesis_identity_sha256
    || runner.spoken_text_sha256 !== unit.spoken_text_sha256
    || runner.cohort_id !== cohort.cohort_id
    || runner.cohort_sha256 !== cohort.cohort_sha256
    || row.defect_type !== "token_limit_no_audio"
    || row.selected_attempt !== 1
    || row.audio_sha256 !== null
    || row.spoken_text_sha256 !== unit.spoken_text_sha256
    || row.synthesis_identity_sha256 !== candidate.synthesis_identity_sha256
    || row.failure_candidate_sha256 !== canonicalQwenBatchSha256(candidate)
    || row.runner_result_sha256 !== canonicalQwenBatchSha256(runner)
    || row.runner_report_sha256 !== runnerReportSha256
    || row.batch_plan_sha256 !== batchPlan.batch_plan_sha256
    || row.cohort_id !== cohort.cohort_id
    || row.cohort_sha256 !== cohort.cohort_sha256) {
    throw new Error("Structural no-audio retry evidence does not match the exact token-limit candidate and original cohort.");
  }
  return {
    unit_id: unitId,
    defect_type: "token_limit_no_audio",
    selected_attempt: 1,
    audio_sha256: null,
    synthesis_identity_sha256: candidate.synthesis_identity_sha256,
    evidence_basis: "reviewed_structural_no_audio",
    human_listening_performed: false,
    candidate,
  };
}
