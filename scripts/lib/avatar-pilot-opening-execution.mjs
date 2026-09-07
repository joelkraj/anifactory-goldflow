import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  buildNarrationPreSynthesisGate,
  canonicalNarrationPlanSha256,
  narrationPreSynthesisGateSha256,
} from "./narration-pre-synthesis-gate.mjs";
import {
  canonicalQwenBatchSha256,
  qwenBatchBindingByUnit,
  QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  validateQwenLiamBatchPlan,
} from "./qwen-liam-batch-contract.mjs";
import { validatePilotNarrationPlanPolicy } from "./avatar-pilot-narration-plan.mjs";
import { narrationProviderRequestSha256 } from "./narration-provider-adapter.mjs";
import { narrationTtsPolicyForIdentity, validateNarrationTtsPolicy } from "./narration-tts-policy.mjs";
import { deterministicTtsSeed } from "./tts-selection-policy.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equal = (left, right) => left === undefined || right === undefined
  ? left === right : canonicalQwenBatchSha256(left) === canonicalQwenBatchSha256(right);
const assert = (condition, message) => {
  if (!condition) throw new Error(`Pilot opening execution blocked: ${message}`);
};

async function boundFile(filePath, hash, label) {
  assert(typeof filePath === "string" && path.isAbsolute(filePath), `${label} requires an absolute path`);
  assert(/^[a-f0-9]{64}$/u.test(String(hash ?? "")), `${label} requires an exact hash`);
  const bytes = await fs.readFile(filePath);
  assert(digest(bytes) === hash, `${label} file hash is stale`);
  return bytes;
}

async function boundJson(filePath, hash, expected, label) {
  const bytes = await boundFile(filePath, hash, label);
  const value = JSON.parse(bytes.toString("utf8"));
  if (expected != null) assert(equal(value, expected), `${label} content differs from its bound file`);
  return value;
}

function validateWavAccounting(bytes, result) {
  assert(bytes.length >= 44 && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WAVE"
    && bytes.readUInt32LE(4) + 8 === bytes.length, `invalid WAV container: ${result.unit_id}`);
  let format = null; let dataSize = null; let offset = 12;
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4); const start = offset + 8;
    assert(start + size <= bytes.length, `truncated WAV chunk: ${result.unit_id}`);
    if (name === "fmt ") {
      assert(format === null && size >= 16, `invalid WAV format: ${result.unit_id}`);
      format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14) };
    } else if (name === "data") {
      assert(dataSize === null, `duplicate WAV data: ${result.unit_id}`); dataSize = size;
    }
    offset = start + size + (size % 2);
  }
  assert(offset === bytes.length && format && [1, 3].includes(format.encoding)
    && format.channels === 1 && format.sampleRate === 24000 && format.blockAlign > 0
    && format.bits === format.blockAlign * 8 && format.byteRate === 24000 * format.blockAlign
    && dataSize > 0 && dataSize % format.blockAlign === 0
    && dataSize / format.blockAlign === result.sample_count
    && format.sampleRate === result.sample_rate_hz, `WAV bytes disagree with native sample accounting: ${result.unit_id}`);
}

/** Read-only validation. Call before loading any synthesis/QA model or writing jobs. */
export async function validatePilotOpeningExecutionInputs({
  plan, units, policy, planPolicy, batchPlan,
  preSynthesisGate, preSynthesisGatePath, preSynthesisGateFileSha256,
  planPath, planFileSha256, identityPath, identityFileSha256,
  scriptPath, scriptSha256, acceptedUnitIds = [], requireAuthorized = true,
} = {}) {
  assert(Array.isArray(units) && units.length > 0, "opening units are missing");
  assert(Array.isArray(plan?.units) && plan.units.length > units.length,
    "opening must be a proper prefix of the complete plan");
  assert(Array.isArray(acceptedUnitIds) && acceptedUnitIds.length === 0,
    "initial opening must not regenerate any accepted units");
  const ids = units.map((unit) => unit.unit_id);
  assert(ids.every((id) => typeof id === "string" && id.length > 0)
    && new Set(ids).size === ids.length, "opening unit IDs must be unique");
  assert(units.every((unit, index) => equal(unit, plan.units[index])),
    "opening units must equal the complete plan's exact ordered prefix");
  assert(equal(ids, plan.pilot_opening_unit_ids), "opening differs from the plan's locked selection");
  assert(plan.status === "passed" && plan.plan_sha256 === canonicalNarrationPlanSha256(plan),
    "complete canonical plan is missing or stale");
  assert(policy?.status === "passed" && planPolicy?.status === "passed",
    "identity and complete-plan policies must pass");
  assert(equal(policy.synthesis_contract, QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT),
    "only pinned batch-four synthesis is supported");
  assert(equal(batchPlan, plan.pilot_phase_batch_plans?.opening),
    "execution batch plan is not the immutable opening phase");
  assert(validateQwenLiamBatchPlan(batchPlan, units, policy.synthesis_contract).status === "passed",
    "opening cohort membership, seed, or scheduler is stale");

  const gate = preSynthesisGate;
  assert(gate?.status === "passed" && gate.gate_sha256 === narrationPreSynthesisGateSha256(gate),
    "canonical pre-synthesis gate is blocked or stale");
  assert(gate.scope?.mode === "pilot_opening_only"
    && equal(gate.scope.authorized_synthesis_unit_ids, ids)
    && gate.scope.authorized_synthesis_unit_count === ids.length
    && gate.scope.preserved_unit_count === 0
    && equal(gate.scope.preserved_unit_ids, [])
    && equal(gate.scope.preserved_artifacts, []), "gate exceeds the opening-only scope");
  assert(gate.unit_count === plan.units.length && gate.historical_synthesis_authorized === false,
    "gate must validate the whole plan without prior ambiguous synthesis");
  if (requireAuthorized) {
    assert(gate.phase === "synthesis_authorized_immediately_before_helper_import"
      && gate.model_load_performed === true && gate.synthesis_invoked === true
      && gate.authorization?.schema === "goldflow_narration_synthesis_authorization_v1",
    "synthesis has not been explicitly authorized");
  } else {
    assert(gate.phase === "before_model_load_and_synthesis"
      && gate.model_load_performed === false && gate.synthesis_invoked === false,
    "pre-authorization validation must remain zero-spend");
  }
  const b = gate.bindings ?? {};
  for (const [field, expected] of Object.entries({
    run_identity_path: identityPath, run_identity_file_sha256: identityFileSha256,
    script_path: scriptPath, script_sha256: scriptSha256,
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: plan.plan_sha256,
    narration_generation_plan_file_sha256: planFileSha256,
    batch_plan_sha256: batchPlan.batch_plan_sha256,
  })) assert(b[field] === expected && expected != null, `gate binding mismatch: ${field}`);
  await boundJson(planPath, planFileSha256, plan, "complete plan");
  const identity = await boundJson(identityPath, identityFileSha256, null, "run identity");
  assert(identity.media_workflow === "avatar_footage_pilot_v1"
    && identity.run_intent === "proof" && identity.production_eligible === false
    && identity.publish_allowed === false, "identity is not a private avatar proof");
  const identityPolicy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), { production: true });
  const suppliedPolicy = { ...policy }; delete suppliedPolicy.status; delete suppliedPolicy.findings;
  assert(equal(identityPolicy, suppliedPolicy), "execution policy differs from the locked identity");
  const sourceBytes = await boundFile(scriptPath, scriptSha256, "approved script");
  await boundJson(preSynthesisGatePath, preSynthesisGateFileSha256, gate, "pre-synthesis gate");
  await boundFile(gate.scope.evidence_path, gate.scope.evidence_sha256, "opening authority evidence");
  const textIr = await boundJson(b.narration_text_ir_path, b.narration_text_ir_file_sha256, null, "spoken-text IR");
  const audit = await boundJson(b.tts_spoken_text_audit_path, b.tts_spoken_text_audit_file_sha256, null, "spoken-text audit");
  const currentPlanPolicy = validatePilotNarrationPlanPolicy(plan, policy, {
    sourceBytes, identityFileSha256, textIr, spokenTextAudit: audit,
  });
  assert(currentPlanPolicy.status === "passed", "current complete source-to-request plan policy failed");
  assert(Object.keys(b.reference_asset_hashes ?? {}).length > 0, "reference asset bindings are missing");
  for (const [label, binding] of Object.entries(b.reference_asset_hashes)) {
    assert(binding.actual === binding.expected, `reference binding is stale: ${label}`);
    if (label === "reference_text" && binding.path === null) {
      assert(binding.expected === policy.primary.reference_text_sha256
        && binding.expected === digest(policy.primary.reference_text), "reference transcript hash is stale");
    } else await boundFile(binding.path, binding.expected, `reference ${label}`);
  }
  const rebuilt = buildNarrationPreSynthesisGate({
    plan, planPath, planFileSha256, identityPath, identityFileSha256,
    scriptPath, scriptSha256, policy, planPolicy,
    sourceArtifactHashes: b.source_artifact_hashes,
    textIr, textIrPath: b.narration_text_ir_path, textIrFileSha256: b.narration_text_ir_file_sha256,
    spokenTextAudit: audit, spokenTextAuditPath: b.tts_spoken_text_audit_path,
    spokenTextAuditFileSha256: b.tts_spoken_text_audit_file_sha256,
    overridesSha256: b.tts_spoken_overrides_sha256,
    referenceAssetHashes: b.reference_asset_hashes, synthesisScope: gate.scope,
    historicalSynthesisAuthorized: false,
  });
  assert(rebuilt.status === "passed", `complete-plan gate recomputation failed: ${JSON.stringify(rebuilt.findings)}`);
  assert(rebuilt.gate_sha256 === (requireAuthorized
    ? gate.authorization.validation_gate_sha256 : gate.gate_sha256),
  "authorization is not bound to the current complete-plan validation");
  return {
    status: "passed", unit_ids: ids,
    plan_sha256: plan.plan_sha256, batch_plan_sha256: batchPlan.batch_plan_sha256,
    gate_sha256: gate.gate_sha256, model_load_performed: false, synthesis_invoked: false,
  };
}

function validateJobs(jobs, options) {
  const { units, policy, batchPlan, preSynthesisGate: gate } = options;
  assert(jobs.schema === "goldflow_narration_tts_jobs_v2" && jobs.route === "qwen"
    && jobs.attempt === 1 && jobs.synthesis_mode === policy.synthesis_contract.mode,
  "runner jobs are not a first opening attempt");
  assert(equal(jobs.batch_plan, batchPlan) && equal(jobs.synthesis_contract, policy.synthesis_contract)
    && jobs.batch_plan_sha256 === batchPlan.batch_plan_sha256, "runner jobs changed phase cohorts");
  for (const field of ["provider", "model_id", "model_revision", "voice_id", "voice_sha256", "voice_continuity_contract"])
    assert(jobs[field] === policy.primary[field], `runner jobs changed ${field}`);
  for (const [field, value] of Object.entries({
    qwen_reference_audio_sha256: policy.primary.reference_audio_sha256,
    qwen_reference_text: policy.primary.reference_text,
    qwen_reference_manifest_sha256: policy.primary.reference_manifest_sha256,
    qwen_reference_voice_id: policy.primary.reference_voice_id,
    qwen_reference_voice_sha256: policy.primary.reference_voice_sha256,
    qwen_voice_continuity_contract: policy.primary.voice_continuity_contract,
  })) assert(jobs[field] === value, `runner jobs changed reference conditioning: ${field}`);
  const b = gate.bindings;
  for (const [field, value] of Object.entries({
    narration_generation_plan_path: options.planPath,
    narration_generation_plan_sha256: b.narration_generation_plan_sha256,
    narration_generation_plan_file_sha256: b.narration_generation_plan_file_sha256,
    run_identity_path: options.identityPath, run_identity_file_sha256: b.run_identity_file_sha256,
    source_script_path: options.scriptPath, source_script_sha256: b.script_sha256,
  })) assert(jobs[field] === value, `runner job artifact binding changed: ${field}`);
  assert(equal(jobs.pre_synthesis_gate, {
    path: options.preSynthesisGatePath, file_sha256: options.preSynthesisGateFileSha256,
    gate_sha256: gate.gate_sha256,
  }), "runner jobs used a different gate");
  assert(jobs.qwen_native_speed === null && jobs.qwen_post_tts_tempo_processing === false
    && jobs.continuous_longform_request === false, "runner jobs permit hidden tempo or longform synthesis");
  const bindings = qwenBatchBindingByUnit(batchPlan);
  assert(Array.isArray(jobs.jobs) && jobs.jobs.length === units.length, "runner jobs changed the opening count");
  jobs.jobs.forEach((job, index) => {
    const unit = units[index];
    assert(job.unit_id === unit.unit_id && job.spoken_text === unit.spoken_text
      && job.spoken_text_sha256 === unit.spoken_text_sha256
      && job.original_order_index === unit.order_index && job.spoken_word_count === unit.word_count
      && job.spoken_text_utf8_bytes === Buffer.byteLength(unit.spoken_text)
      && job.attempt === 1 && job.recovery_provenance == null
      && job.seed === deterministicTtsSeed(unit.unit_id, policy.primary.provider, 1)
      && equal(job.synthesis_cohort, bindings.get(unit.unit_id)), `runner job drift: ${unit.unit_id}`);
  });
}

/** Authenticate actual runner/job/sidecar/WAV bytes; this is provenance, not listening QA. */
export async function validatePilotOpeningExecutionResults(options = {}) {
  await validatePilotOpeningExecutionInputs({ ...options, requireAuthorized: true });
  const { execution, units, policy, batchPlan, preSynthesisGate: gate } = options;
  assert(execution?.reportPath && execution.reportSha256, "runner receipt binding is missing");
  const report = await boundJson(execution.reportPath, execution.reportSha256, execution.report, "runner report");
  const jobs = await boundJson(report.jobs_path, report.jobs_sha256, null, "runner jobs");
  validateJobs(jobs, options);
  assert(report.schema === "goldflow_local_tts_production_run_v2" && report.status === "passed"
    && report.route === "qwen" && report.job_count === units.length && report.result_count === units.length
    && report.results_restored_to_original_order === true
    && equal(report.original_order_unit_ids, units.map((unit) => unit.unit_id))
    && equal(report.results, execution.results), "runner results are incomplete or out of order");
  for (const field of ["provider", "model_id", "model_revision", "voice_id", "voice_sha256", "voice_clone_contract", "voice_continuity_contract"])
    assert(report[field] === policy.primary[field], `runner identity mismatch: ${field}`);
  for (const field of ["effective_concurrency", "model_load_count", "resident_model_count", "model_instance_concurrency"])
    assert(report[field] === 1, `runner must use one resident model: ${field}`);
  assert(report.continuous_batching === false && report.token_limit_acceptance_allowed === false
    && report.accepted_token_limit_result_count === 0 && report.reference_audio_preloaded_once === true
    && report.preserved_unit_count === 0 && equal(report.preserved_unit_ids, [])
    && report.batch_plan_sha256 === batchPlan.batch_plan_sha256
    && report.synthesis_mode === policy.synthesis_contract.mode
    && equal(report.synthesis_contract, policy.synthesis_contract)
    && report.pre_synthesis_gate_sha256 === gate.gate_sha256
    && report.pre_synthesis_gate_path === options.preSynthesisGatePath
    && report.pre_synthesis_gate_file_sha256 === options.preSynthesisGateFileSha256,
  "runner execution policy or gate binding drifted");
  assert(Array.isArray(report.cohort_executions) && report.cohort_executions.length === batchPlan.cohorts.length,
    "runner cohort ledger is incomplete");
  report.cohort_executions.forEach((actual, index) => {
    const expected = batchPlan.cohorts[index];
    for (const field of ["cohort_id", "cohort_sha256", "cohort_index", "nominal_batch_size", "effective_batch_size", "batch_seed"])
      assert(actual[field] === expected[field], `runner cohort mismatch: ${field}`);
    assert(equal(actual.unit_ids, expected.members.map((member) => member.unit_id))
      && actual.status === "generated" && actual.model_call_performed === true,
    "initial opening did not receive exactly one fresh cohort submission");
  });
  assert(execution.cohortEventsPath === report.cohort_event_path, "cohort event path changed");
  const eventBytes = await boundFile(execution.cohortEventsPath, execution.cohortEventsSha256, "cohort events");
  const events = eventBytes.toString("utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert(events.length === report.cohort_event_count && events.length === batchPlan.cohorts.length,
    "cohort event count differs from actual phase");
  events.forEach((event, index) => {
    const cohort = batchPlan.cohorts[index];
    assert(event.schema === "goldflow_local_tts_cohort_event_v1" && event.event === "cohort_complete"
      && event.jobs_sha256 === report.jobs_sha256 && event.batch_plan_sha256 === batchPlan.batch_plan_sha256
      && event.cohort_id === cohort.cohort_id && event.cohort_sha256 === cohort.cohort_sha256
      && event.cohort_index === cohort.cohort_index
      && equal(event.execution, report.cohort_executions[index])
      && equal(event.results, cohort.members.map((member) => report.results.find((row) => row.unit_id === member.unit_id))),
    "cohort event identity mismatch");
  });
  const bindings = qwenBatchBindingByUnit(batchPlan);
  const authenticated = [];
  assert(Array.isArray(report.results) && report.results.length === units.length, "missing result rows");
  for (const [index, result] of report.results.entries()) {
    const unit = units[index];
    assert(result.unit_id === unit.unit_id && result.status === "generated" && result.attempt === 1,
      "results contain missing, duplicate, cached, failed or reordered opening units");
    assert(result.spoken_text === unit.spoken_text && result.spoken_text_sha256 === digest(unit.spoken_text),
      `result text drift: ${unit.unit_id}`);
    for (const [field, value] of Object.entries({
      provider: policy.primary.provider, model_id: policy.primary.model_id, voice_id: policy.primary.voice_id,
      synthesis_mode: policy.synthesis_contract.mode, batch_plan_sha256: batchPlan.batch_plan_sha256,
      cohort_id: bindings.get(unit.unit_id).cohort_id, cohort_sha256: bindings.get(unit.unit_id).cohort_sha256,
      seed: bindings.get(unit.unit_id).batch_seed, per_unit_serial_seed: jobs.jobs[index].seed,
    })) assert(result[field] === value, `result execution identity drift: ${unit.unit_id}/${field}`);
    assert(Number.isInteger(result.generated_token_count) && result.generated_token_count > 0
      && Number.isInteger(result.effective_token_limit) && result.effective_token_limit > result.generated_token_count
      && result.token_limit_reached === false, `token-limited result: ${unit.unit_id}`);
    assert(Number.isFinite(result.duration_sec) && result.duration_sec > 0
      && Number.isInteger(result.sample_count) && result.sample_count > 0
      && Number.isInteger(result.sample_rate_hz) && result.sample_rate_hz > 0
      && Math.abs(result.duration_sec - result.sample_count / result.sample_rate_hz) < 0.000002,
    `invalid audio accounting: ${unit.unit_id}`);
    const audio = await boundFile(result.output_path, result.output_sha256, `unit WAV ${unit.unit_id}`);
    validateWavAccounting(audio, result);
    assert(result.sidecar_path === result.output_path.replace(/\.wav$/iu, ".json")
      && result.sidecar_path !== result.output_path, `unexpected unit sidecar path: ${unit.unit_id}`);
    const sidecarBytes = await fs.readFile(result.sidecar_path);
    const sidecar = JSON.parse(sidecarBytes.toString("utf8"));
    assert(equal(sidecar, result), `runner/sidecar evidence differs: ${unit.unit_id}`);
    const si = sidecar.synthesis_identity;
    assert(si?.schema === "goldflow_local_tts_synthesis_identity_v2"
      && canonicalQwenBatchSha256(si) === sidecar.synthesis_identity_sha256
      && si.unit_id === unit.unit_id && si.spoken_text === unit.spoken_text
      && si.spoken_text_sha256 === unit.spoken_text_sha256 && si.attempt === 1,
    `synthesis identity is stale: ${unit.unit_id}`);
    for (const [field, value] of Object.entries({
      provider: policy.primary.provider, model_id: policy.primary.model_id, model_revision: policy.primary.model_revision,
      voice: policy.primary.voice_id, voice_sha256: policy.primary.voice_sha256,
      voice_clone_contract: policy.primary.voice_clone_contract,
      voice_continuity_contract: policy.primary.voice_continuity_contract,
      reference_audio_sha256: policy.primary.reference_audio_sha256,
      reference_text: policy.primary.reference_text, reference_manifest_sha256: policy.primary.reference_manifest_sha256,
      ...bindings.get(unit.unit_id),
    })) assert(si[field] === value, `synthesis identity drift for ${unit.unit_id}: ${field}`);
    const cohort = batchPlan.cohorts[si.cohort_index];
    assert(equal(si.cohort_members, cohort.members) && si.seed === cohort.batch_seed
      && si.per_unit_serial_seed === jobs.jobs[index].seed
      && si.synthesis_api === "Model.batch_generate" && si.native_speed_applied === null
      && si.post_tts_tempo_processing === false && si.continuous_batching === false
      && si.model_instance_count === 1 && si.model_concurrency === 1
      && si.token_limit_acceptance_allowed === false,
    `synthesis execution contract drift: ${unit.unit_id}`);
    for (const field of ["model_weights_sha256", "model_config_sha256", "generation_config_sha256", "speech_tokenizer_weights_sha256", "speech_tokenizer_config_sha256"])
      assert(si[field] === policy.primary[field] && report[field] === policy.primary[field],
        `model asset identity drift: ${field}`);
    authenticated.push({
      unit_id: unit.unit_id, audio_path: result.output_path, audio_sha256: result.output_sha256,
      duration_sec: result.duration_sec, spoken_text_sha256: unit.spoken_text_sha256,
      provider_request_sha256: narrationProviderRequestSha256(unit.provider_request),
      provider_payload_sha256: unit.provider_request.request_sha256,
      provider_request_synthesis_identity_sha256: unit.provider_request.synthesis_identity_sha256,
      synthesis_identity_sha256: result.synthesis_identity_sha256,
      synthesis_identity: structuredClone(si),
      synthesis_sidecar_path: result.sidecar_path, synthesis_sidecar_sha256: digest(sidecarBytes),
      runner_report_path: execution.reportPath, runner_report_sha256: execution.reportSha256,
      batch_plan_sha256: batchPlan.batch_plan_sha256, cohort_id: si.cohort_id,
      cohort_sha256: si.cohort_sha256, batch_seed: si.batch_seed,
    });
  }
  return {
    schema: "goldflow_avatar_pilot_opening_execution_validation_v1", status: "passed",
    production_stage_passed: false, listening_qa_performed: false, units: authenticated,
    runner_report_path: execution.reportPath, runner_report_sha256: execution.reportSha256,
    cohort_events_path: execution.cohortEventsPath, cohort_events_sha256: execution.cohortEventsSha256,
  };
}
