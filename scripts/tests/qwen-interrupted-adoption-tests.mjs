import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildQwenLiamBatchPlan,
  canonicalQwenBatchSha256,
  qwenBatchBindingByUnit,
  QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
} from "../lib/qwen-liam-batch-contract.mjs";
import {
  verifyCompletedInterruptedQwenRunner,
  verifyInterruptedQwenAdoptionReceipt,
  verifyInterruptedQwenFinalRun,
  verifyInterruptedQwenInventory,
} from "../lib/qwen-interrupted-adoption.mjs";
import { creativeStageRerunDecision } from "../lib/creative-stage-rerun-policy.mjs";
import { interruptedQwenGuardAdmission } from "../lib/qwen-interrupted-guard.mjs";
import { narrationSynthesisScopeForTests, preservedTtsSelectionsForTests } from "../narration-tts-episode.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return hash(await fs.readFile(filePath));
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-qwen-adoption-"));
try {
  const episodeDir = path.join(root, "ep_01");
  const outputDir = path.join(episodeDir, "assets/audio/narration_tts");
  const unitDir = path.join(outputDir, "units/qwen_local");
  const identityPath = path.join(episodeDir, "run_identity.json");
  const planPath = path.join(episodeDir, "narration_generation_plan.json");
  const scriptPath = path.join(episodeDir, "script_clean.md");
  const gatePath = path.join(episodeDir, "narration_tts_pre_synthesis_gate_ep_01.json");
  await fs.mkdir(unitDir, { recursive: true });
  const units = Array.from({ length: 5 }, (_, index) => {
    const spoken_text = `Unit ${index + 1} has spoken words.`;
    return { unit_id: `unit_${index + 1}`, order_index: index, spoken_text,
      spoken_text_sha256: hash(spoken_text), word_count: 5 };
  });
  const batchPlan = buildQwenLiamBatchPlan(units, QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT);
  const bindings = qwenBatchBindingByUnit(batchPlan);
  const policy = { primary: {
    provider: "qwen_local", model_id: "pinned-model", model_revision: "revision",
    voice_id: "owned-voice", voice_sha256: "voice-hash",
    voice_continuity_contract: "owned-clone",
  }, synthesis_contract: QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT };
  const identityHash = await writeJson(identityPath, { id: "locked-run" });
  const planSha256 = hash("canonical-plan");
  const planFileHash = await writeJson(planPath, { plan_sha256: planSha256 });
  await fs.writeFile(scriptPath, "Exact locked script.\n");
  const scriptHash = hash(await fs.readFile(scriptPath));
  const gateSha256 = hash("original-gate");
  const gateHash = await writeJson(gatePath, { status: "passed", gate_sha256: gateSha256,
    model_load_performed: true, synthesis_invoked: true });
  const jobPath = path.join(outputDir, "jobs/original-qwen-attempt-1.json");
  const eventsPath = path.join(outputDir, "runs/original-qwen-attempt-1-cohorts.jsonl");
  const job = {
    schema: "goldflow_narration_tts_jobs_v2", provider: policy.primary.provider,
    model_id: policy.primary.model_id, model_revision: policy.primary.model_revision,
    voice_id: policy.primary.voice_id, voice_sha256: policy.primary.voice_sha256,
    voice_continuity_contract: policy.primary.voice_continuity_contract,
    synthesis_contract: policy.synthesis_contract, batch_plan: batchPlan,
    batch_plan_sha256: batchPlan.batch_plan_sha256,
    narration_generation_plan_sha256: planSha256,
    narration_generation_plan_file_sha256: planFileHash,
    run_identity_file_sha256: identityHash,
    source_script_sha256: scriptHash,
    pre_synthesis_gate: { path: gatePath, file_sha256: gateHash,
      gate_sha256: gateSha256 },
    jobs: units.map((unit) => ({ ...unit,
      synthesis_cohort: bindings.get(unit.unit_id) })),
  };
  const jobHash = await writeJson(jobPath, job);
  const cohort = batchPlan.cohorts[0];
  const results = [];
  const listed = [];
  for (const member of cohort.members) {
    const unit = units.find((row) => row.unit_id === member.unit_id);
    const binding = bindings.get(unit.unit_id);
    const synthesisIdentity = { unit_id: unit.unit_id,
      provider: policy.primary.provider, voice: policy.primary.voice_id,
      batch_plan_sha256: batchPlan.batch_plan_sha256,
      cohort_id: binding.cohort_id, cohort_sha256: binding.cohort_sha256 };
    const synthesisHash = canonicalQwenBatchSha256(synthesisIdentity);
    const wavPath = path.join(unitDir, `${unit.unit_id}-${synthesisHash}.wav`);
    const sidecarPath = wavPath.replace(/\.wav$/u, ".json");
    await fs.writeFile(wavPath, `mock-waveform-${unit.unit_id}`);
    const wavHash = hash(await fs.readFile(wavPath));
    const sidecar = { status: "generated", unit_id: unit.unit_id,
      provider: policy.primary.provider, model_id: policy.primary.model_id,
      voice_id: policy.primary.voice_id, output_path: wavPath,
      output_sha256: wavHash, spoken_text_sha256: unit.spoken_text_sha256,
      synthesis_identity: synthesisIdentity,
      synthesis_identity_sha256: synthesisHash,
      batch_plan_sha256: batchPlan.batch_plan_sha256,
      cohort_id: binding.cohort_id, cohort_sha256: binding.cohort_sha256,
      seed: 7, per_unit_serial_seed: 8, sample_count: 24000,
      duration_sec: 1, token_limit_reached: false,
      generated_token_count: 10, effective_token_limit: 30 };
    const sidecarHash = await writeJson(sidecarPath, sidecar);
    results.push({ ...sidecar, sidecar_path: sidecarPath });
    listed.push({ unit_id: unit.unit_id, original_order_index: unit.order_index,
      cohort_id: binding.cohort_id, cohort_sha256: binding.cohort_sha256,
      spoken_text_sha256: unit.spoken_text_sha256,
      synthesis_identity_sha256: synthesisHash,
      sidecar_path: sidecarPath, sidecar_file_sha256: sidecarHash,
      wav_path: wavPath, wav_sha256: wavHash, sample_count: 24000,
      status: "generated_unaccepted_pending_qa" });
  }
  const event = { schema: "goldflow_local_tts_cohort_event_v1",
    event: "cohort_complete", jobs_sha256: jobHash,
    batch_plan_sha256: batchPlan.batch_plan_sha256,
    cohort_id: cohort.cohort_id, cohort_sha256: cohort.cohort_sha256,
    cohort_index: cohort.cohort_index, results };
  await fs.mkdir(path.dirname(eventsPath), { recursive: true });
  await fs.writeFile(eventsPath, `${JSON.stringify(event)}\n`);
  const eventsHash = hash(await fs.readFile(eventsPath));
  listed.sort((left, right) => left.original_order_index - right.original_order_index);
  const acceptedIds = listed.map((row) => row.unit_id);
  const remainingIds = units.map((unit) => unit.unit_id).filter((id) => !acceptedIds.includes(id));
  const inventoryPath = path.join(episodeDir, "interrupted-inventory.json");
  const inventory = {
    schema: "anifactory_operator_interrupted_qwen_triage_inventory_v1",
    production_stage_passed: false, qa_acceptance_recorded: false,
    episode_dir: episodeDir, run_identity_path: identityPath,
    run_identity_file_sha256: identityHash,
    narration_generation_plan_path: planPath,
    narration_generation_plan_file_sha256: planFileHash,
    narration_generation_plan_canonical_sha256: planSha256,
    source_script_path: scriptPath, source_script_sha256: scriptHash,
    pre_synthesis_gate_path: gatePath, pre_synthesis_gate_file_sha256: gateHash,
    pre_synthesis_gate_sha256: gateSha256,
    original_job_path: jobPath, original_job_file_sha256: jobHash,
    cohort_events_path: eventsPath, cohort_events_file_sha256: eventsHash,
    provider: policy.primary.provider, model_id: policy.primary.model_id,
    model_revision: policy.primary.model_revision, voice_id: policy.primary.voice_id,
    voice_sha256: policy.primary.voice_sha256,
    voice_continuity_contract: policy.primary.voice_continuity_contract,
    batch_plan_sha256: batchPlan.batch_plan_sha256,
    job_unit_count: units.length, complete_cohort_count: 1,
    generated_unaccepted_unit_count: listed.length,
    never_submitted_unit_count: remainingIds.length,
    generated_unaccepted_units: listed,
    never_submitted_unit_ids: remainingIds,
  };
  await writeJson(inventoryPath, inventory);
  const inputs = { inventoryPath, episodeDir, outputDir, identityPath,
    planPath, scriptPath, gatePath, units, policy, batchPlan, planSha256 };
  const verified = await verifyInterruptedQwenInventory(inputs);
  assert.equal(verified.verified_units.length, 4);
  assert.deepEqual(verified.never_submitted_unit_ids, remainingIds);
  const exactInventoryPath = path.join(episodeDir,
    "narration_interrupted_qwen_triage_inventory_ep_01.json");
  const adoptStatus = { episode_dir: episodeDir, current_stage: "qwen_tts_stitch",
    current_stage_state: "blocked",
    next_command_shape: `node bin/goldflow.mjs tts adopt-interrupted --episode-dir ${episodeDir} --inventory ${exactInventoryPath}` };
  const adoptFlags = { "adopt-interrupted": "true", "episode-dir": episodeDir,
    inventory: exactInventoryPath };
  assert.equal(interruptedQwenGuardAdmission(adoptStatus, "tts", "adopt-interrupted",
    adoptFlags).allowed, true);
  assert.equal(interruptedQwenGuardAdmission({ ...adoptStatus,
    current_stage: "voice_plan" }, "tts", "adopt-interrupted", adoptFlags).allowed, false);
  assert.equal(interruptedQwenGuardAdmission(adoptStatus, "tts", "adopt-interrupted",
    { ...adoptFlags, inventory: inventoryPath }).allowed, false);
  await fs.writeFile(listed[0].wav_path, "changed waveform");
  await assert.rejects(verifyInterruptedQwenInventory(inputs), /WAV or sidecar changed/);
  await fs.writeFile(listed[0].wav_path, `mock-waveform-${listed[0].unit_id}`);
  await fs.writeFile(path.join(unitDir, "unreviewed.wav"), "no receipt");
  await assert.rejects(verifyInterruptedQwenInventory(inputs), /unreviewed or unlisted/);
  await fs.unlink(path.join(unitDir, "unreviewed.wav"));

  const receiptPath = path.join(episodeDir, "narration_interrupted_qwen_adoption_ep_01.json");
  const resumeFlags = { "episode-dir": episodeDir, concurrency: "1", "batch-size": "4",
    "interrupted-adoption-receipt": receiptPath };
  const resumeStatus = { episode_dir: episodeDir, current_stage: "qwen_tts_stitch",
    current_stage_state: "blocked",
    next_command_shape: `node bin/goldflow.mjs tts narrate --episode-dir ${episodeDir} --concurrency 1 --batch-size 4 --interrupted-adoption-receipt ${receiptPath}` };
  assert.equal(interruptedQwenGuardAdmission(resumeStatus, "tts", "narrate",
    resumeFlags).allowed, true);
  assert.equal(interruptedQwenGuardAdmission(resumeStatus, "tts", "narrate",
    { ...resumeFlags, "batch-size": "5" }).allowed, false);
  assert.equal(interruptedQwenGuardAdmission({ ...resumeStatus,
    current_stage_state: "passed" }, "tts", "narrate", resumeFlags).allowed, false);
  const reportPath = path.join(episodeDir, "narration_tts_report_ep_01.json");
  const unitQaPath = path.join(episodeDir, "narration_tts_unit_qa_ep_01.json");
  const gateArchivePath = path.join(episodeDir, "original-gate.json");
  await fs.copyFile(gatePath, gateArchivePath);
  const qa = { status: "passed_with_warnings", audio_sha256: listed[0].wav_sha256,
    findings: [{ severity: "warning", code: "transcript_deferred" }] };
  const reportRows = listed.map((row) => ({ unit_id: row.unit_id,
    audio_path: row.wav_path, audio_sha256: row.wav_sha256,
    spoken_text_sha256: row.spoken_text_sha256,
    synthesis_identity_sha256: row.synthesis_identity_sha256,
    provider: policy.primary.provider, model_id: policy.primary.model_id,
    voice_id: policy.primary.voice_id, selected_qa: { ...qa, audio_sha256: row.wav_sha256 } }));
  const selectedRows = listed.map((row) => ({ unit_id: row.unit_id,
    audio_path: row.wav_path, audio_sha256: row.wav_sha256,
    spoken_text_sha256: row.spoken_text_sha256,
    synthesis_identity_sha256: row.synthesis_identity_sha256,
    provider: policy.primary.provider, model_id: policy.primary.model_id,
    voice_id: policy.primary.voice_id, voice_sha256: policy.primary.voice_sha256,
    voice_continuity_contract: policy.primary.voice_continuity_contract,
    qa: { ...qa, audio_sha256: row.wav_sha256 } }));
  const originalRun = { attempt: 1, status: "interrupted_after_completed_cohorts",
    synthesis_mode: policy.synthesis_contract.mode,
    jobs_path: jobPath, jobs_sha256: jobHash,
    cohort_events_path: eventsPath, cohort_events_sha256: eventsHash,
    runner_report_path: null };
  const reportHash = await writeJson(reportPath, { schema: "goldflow_narration_tts_report_v1",
    status: "interrupted_adoption_partial", narration_generation_plan_sha256: planSha256,
    narration_generation_plan_file_sha256: planFileHash,
    recovery_scope: { adoption_receipt_path: receiptPath },
    synthesis_runs: [originalRun], results: reportRows });
  const qaHash = await writeJson(unitQaPath, { schema: "goldflow_narration_tts_unit_qa_v1",
    status: "interrupted_adoption_partial", narration_generation_plan_sha256: planSha256,
    narration_generation_plan_file_sha256: planFileHash,
    recovery_scope: { adoption_receipt_path: receiptPath },
    selected_units: selectedRows,
    candidates: selectedRows.map((row) => ({ unit_id: row.unit_id, qa: row.qa })) });
  const partialReportArchivePath = path.join(episodeDir, "partial-report.json");
  const partialUnitQaArchivePath = path.join(episodeDir, "partial-unit-qa.json");
  await fs.copyFile(reportPath, partialReportArchivePath);
  await fs.copyFile(unitQaPath, partialUnitQaArchivePath);
  const adoptionQaPath = path.join(episodeDir, "adoption-qa.json");
  const adoptionQaHash = await writeJson(adoptionQaPath, { status: "passed_partial" });
  const receipt = { schema: "goldflow_interrupted_qwen_adoption_v1",
    status: "passed_partial", episode_dir: episodeDir,
    run_identity_path: identityPath, run_identity_file_sha256: identityHash,
    narration_generation_plan_path: planPath,
    narration_generation_plan_file_sha256: planFileHash,
    narration_generation_plan_canonical_sha256: planSha256,
    source_script_path: scriptPath, source_script_sha256: scriptHash,
    inventory_path: inventoryPath, inventory_file_sha256: hash(await fs.readFile(inventoryPath)),
    original_job_path: jobPath, original_job_file_sha256: jobHash,
    cohort_events_path: eventsPath, cohort_events_file_sha256: eventsHash,
    original_pre_synthesis_gate_path: gateArchivePath,
    original_pre_synthesis_gate_file_sha256: gateHash,
    original_pre_synthesis_gate_sha256: gateSha256,
    adoption_qa_path: adoptionQaPath, adoption_qa_file_sha256: adoptionQaHash,
    partial_report_path: partialReportArchivePath, partial_report_file_sha256: reportHash,
    partial_unit_qa_path: partialUnitQaArchivePath, partial_unit_qa_file_sha256: qaHash,
    canonical_report_path: reportPath, canonical_unit_qa_path: unitQaPath,
    accepted_unit_ids: acceptedIds, never_submitted_unit_ids: remainingIds,
    accepted_artifacts: listed.map((row) => ({ unit_id: row.unit_id,
      audio_path: row.wav_path, audio_sha256: row.wav_sha256,
      synthesis_sidecar_path: row.sidecar_path,
      synthesis_sidecar_sha256: row.sidecar_file_sha256 })) };
  await writeJson(receiptPath, receipt);
  const checked = await verifyInterruptedQwenAdoptionReceipt({
    receiptPath, episodeDir, outputDir, identityPath, planPath, scriptPath,
    reportPath, unitQaPath, units, planSha256,
  });
  assert.deepEqual(checked.receipt.never_submitted_unit_ids, remainingIds);
  const preserved = preservedTtsSelectionsForTests({ units,
    priorReport: checked.report, priorUnitQa: checked.unitQa,
    policy, canonicalPlanSha256: planSha256, planFileSha256: planFileHash });
  assert.equal(preserved.status, "passed");
  const scope = narrationSynthesisScopeForTests({ units,
    preservedCandidates: preserved.rows.map((row) => ({
      unit_id: row.unit.unit_id, spoken_text_sha256: row.unit.spoken_text_sha256,
      audio_path: row.result.audio_path, audio_sha256: row.result.audio_sha256,
    })) });
  assert.deepEqual(scope.authorized_synthesis_unit_ids, remainingIds);
  assert.equal(creativeStageRerunDecision({ command: "tts", subcommand: "narrate",
    stage: "qwen_tts_stitch",
    flags: { "interrupted-adoption-receipt": receiptPath },
    priorEvents: [{ event_type: "stage_started", stage: "qwen_tts_stitch",
      command: "tts narrate" }] }).reason, "interrupted_adoption_exact_resume");
  const resumeGatePath = path.join(episodeDir,
    "narration_tts_interrupted_resume_gate_ep_01.json");
  const resumeGateHashValue = hash("resume-gate");
  const receiptHash = hash(await fs.readFile(receiptPath));
  const resumeGateFileHash = await writeJson(resumeGatePath, {
    status: "passed", gate_sha256: resumeGateHashValue,
    scope: { mode: "interrupted_full_synthesis_resume_preserving_accepted_units",
      evidence_path: receiptPath, evidence_sha256: receiptHash,
      preserved_unit_ids: acceptedIds,
      authorized_synthesis_unit_ids: remainingIds },
  });
  const remainingId = remainingIds[0];
  const remainingUnit = units.find((row) => row.unit_id === remainingId);
  const remainingBinding = bindings.get(remainingId);
  const provenance = {
    schema: "goldflow_qwen_incomplete_unit_resume_provenance_v1",
    resume_mode: "serial_incomplete_unit_resume_v1",
    unit_id: remainingId,
    spoken_text_sha256: remainingUnit.spoken_text_sha256,
    batch_plan_sha256: batchPlan.batch_plan_sha256,
    origin_cohort_id: remainingBinding.cohort_id,
    origin_cohort_sha256: remainingBinding.cohort_sha256,
    pre_synthesis_gate_sha256: resumeGateHashValue,
  };
  const resumeJobPath = path.join(outputDir, "jobs/resume.json");
  const resumeJobHash = await writeJson(resumeJobPath, {
    schema: "goldflow_narration_tts_jobs_v2",
    synthesis_mode: "serial_incomplete_unit_resume_v1",
    synthesis_contract: policy.synthesis_contract,
    batch_plan_sha256: batchPlan.batch_plan_sha256,
    narration_generation_plan_sha256: planSha256,
    run_identity_file_sha256: identityHash,
    source_script_sha256: scriptHash,
    pre_synthesis_gate: { file_sha256: resumeGateFileHash,
      gate_sha256: resumeGateHashValue },
    jobs: [{ unit_id: remainingId, recovery_provenance: provenance }],
  });
  const resumeWavPath = path.join(unitDir, "resume.wav");
  const resumeSidecarPath = path.join(unitDir, "resume.json");
  await fs.writeFile(resumeWavPath, "mock-resumed-waveform");
  const resumeWavHash = hash(await fs.readFile(resumeWavPath));
  const resumeIdentity = { unit_id: remainingId, recovery_provenance: provenance };
  const resumeIdentityHash = canonicalQwenBatchSha256(resumeIdentity);
  const resumeResult = {
    unit_id: remainingId, status: "generated",
    spoken_text_sha256: remainingUnit.spoken_text_sha256,
    output_path: resumeWavPath, output_sha256: resumeWavHash,
    sidecar_path: resumeSidecarPath,
    synthesis_identity: resumeIdentity,
    synthesis_identity_sha256: resumeIdentityHash,
    recovery_provenance: provenance,
    token_limit_reached: false,
    generated_token_count: 10, effective_token_limit: 30,
  };
  await writeJson(resumeSidecarPath, resumeResult);
  const resumeRunPath = path.join(outputDir, "runs/resume.json");
  const resumeRunHash = await writeJson(resumeRunPath, {
    schema: "goldflow_local_tts_production_run_v2",
    status: "passed", synthesis_mode: "serial_incomplete_unit_resume_v1",
    synthesis_contract: policy.synthesis_contract,
    batch_plan_sha256: batchPlan.batch_plan_sha256,
    provider: policy.primary.provider, model_id: policy.primary.model_id,
    model_revision: policy.primary.model_revision,
    voice_id: policy.primary.voice_id, voice_sha256: policy.primary.voice_sha256,
    model_load_count: 1, resident_model_count: 1,
    model_instance_concurrency: 1, continuous_batching: false,
    token_limit_acceptance_allowed: false, accepted_token_limit_result_count: 0,
    results_restored_to_original_order: true,
    original_order_unit_ids: remainingIds,
    jobs_path: resumeJobPath, jobs_sha256: resumeJobHash,
    cohort_event_path: path.join(outputDir, "runs/resume-cohorts.jsonl"),
    cohort_event_count: 0, cohort_executions: [],
    job_count: 1, result_count: 1, failed_result_count: 0,
    pre_synthesis_gate_file_sha256: resumeGateFileHash,
    pre_synthesis_gate_sha256: resumeGateHashValue,
    results: [resumeResult],
  });
  const finalReport = {
    results: [...reportRows, { unit_id: remainingId,
      synthesis_mode: "serial_incomplete_unit_resume_v1",
      audio_path: resumeWavPath, audio_sha256: resumeWavHash,
      synthesis_identity_sha256: resumeIdentityHash }],
    synthesis_runs: [
      originalRun,
      { attempt: 1, synthesis_mode: "serial_incomplete_unit_resume_v1",
        batch_plan_sha256: batchPlan.batch_plan_sha256,
        report_path: resumeRunPath, report_sha256: resumeRunHash },
    ],
  };
  const finalInputs = { episodeDir, outputDir, identityPath, planPath,
    scriptPath, reportPath, unitQaPath, units, planSha256,
    batchPlan, policy, finalReport };
  const finalCheck = await verifyInterruptedQwenFinalRun(finalInputs);
  assert.deepEqual(finalCheck.resumed_unit_ids, remainingIds);
  const completedInputs = { ...finalInputs, finalReport: undefined,
    runnerReportPath: resumeRunPath, receiptPath };
  const completed = await verifyCompletedInterruptedQwenRunner(completedInputs);
  assert.equal(completed.runner_sha256, resumeRunHash);
  const finalizeStatus = { episode_dir: episodeDir, current_stage: "qwen_tts_stitch",
    current_stage_state: "blocked",
    next_command_shape: `node bin/goldflow.mjs tts finalize-interrupted --episode-dir ${episodeDir} --interrupted-adoption-receipt ${receiptPath} --completed-runner-report ${resumeRunPath}` };
  const finalizeFlags = { "episode-dir": episodeDir,
    "interrupted-adoption-receipt": receiptPath,
    "completed-runner-report": resumeRunPath,
    "finalize-interrupted": "true" };
  assert.equal(interruptedQwenGuardAdmission(finalizeStatus, "tts", "finalize-interrupted",
    finalizeFlags).allowed, true);
  assert.equal(interruptedQwenGuardAdmission(finalizeStatus, "tts", "finalize-interrupted",
    { ...finalizeFlags, "completed-runner-report": path.join(outputDir, "runs/other.json") }).allowed, false);
  assert.equal(interruptedQwenGuardAdmission({ ...finalizeStatus,
    current_stage_state: "passed" }, "tts", "finalize-interrupted", finalizeFlags).allowed, false);
  await fs.writeFile(path.join(unitDir, "unbound.json"), "{}");
  await assert.rejects(verifyCompletedInterruptedQwenRunner(completedInputs), /output tree/);
  await fs.unlink(path.join(unitDir, "unbound.json"));
  await fs.writeFile(path.join(outputDir, "runs/resume-cohorts.jsonl"), "unexpected event\n");
  await assert.rejects(verifyCompletedInterruptedQwenRunner(completedInputs), /not empty/);
  await fs.unlink(path.join(outputDir, "runs/resume-cohorts.jsonl"));
  await fs.writeFile(resumeWavPath, "tampered-resume");
  await assert.rejects(verifyInterruptedQwenFinalRun(finalInputs), /waveform/);
  await fs.writeFile(resumeWavPath, "mock-resumed-waveform");
  await fs.writeFile(listed[1].sidecar_path, "stale");
  await assert.rejects(verifyInterruptedQwenAdoptionReceipt({
    receiptPath, episodeDir, outputDir, identityPath, planPath, scriptPath,
    reportPath, unitQaPath, units, planSha256,
  }), /adopted artifact/);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
console.log("qwen interrupted adoption tests passed");
