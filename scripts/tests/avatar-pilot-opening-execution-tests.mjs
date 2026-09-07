import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildPilotNarrationIdentityFields } from "../lib/avatar-pilot-narration-contract.mjs";
import { buildPilotNarrationPlans } from "../lib/avatar-pilot-narration-plan.mjs";
import { QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK as JOEL } from "../lib/narration-tts-policy.mjs";
import { deterministicTtsSeed } from "../lib/tts-selection-policy.mjs";
import { canonicalQwenBatchSha256, qwenBatchBindingByUnit } from "../lib/qwen-liam-batch-contract.mjs";
import {
  authorizeNarrationPreSynthesisGate, buildNarrationPreSynthesisGate,
  narrationPreSynthesisGateSha256,
} from "../lib/narration-pre-synthesis-gate.mjs";
import {
  validatePilotOpeningExecutionInputs, validatePilotOpeningExecutionResults,
} from "../lib/avatar-pilot-opening-execution.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await fs.writeFile(filePath, bytes);
  return hash(bytes);
}
function wavFixture(durationSec = 0.01) {
  assert(Number.isFinite(durationSec) && durationSec > 0 && durationSec <= 90);
  const samples = Math.round(durationSec * 24000);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

// Importing this module is side-effect free. Other boundary tests may explicitly
// build a fresh fixture; the direct CLI invocation additionally runs mutations.
export async function buildPilotOpeningExecutionFixture({ runTests = false, unitDurationSec = 0.01,
  remainingParagraphs = null, identityFields = {}, evidenceFixture = null } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-opening-gate-test-")));
  const bankPath = fileURLToPath(new URL("../../config/narration_delivery_reference_bank.json", import.meta.url));
  const deliveryBank = { path: bankPath, bytes: await fs.readFile(bankPath) };
  const cleanup = () => fs.rm(root, { recursive: true, force: true });
  let fixtureReady = false;
  let assertions = 0;
  try {
  const sourceBytes = Buffer.from([
    "The door opens as our traveler reaches the end of the quiet road.",
    "She studies the empty hall before stepping carefully past the broken stone arch.",
    ...(remainingParagraphs ?? ["Her companion waits outside until a small lamp appears in the distant window."]),
  ].join("\n\n") + "\n");
  const scriptSha256 = hash(sourceBytes);
  const scriptPath = path.join(root, "source.md"); await fs.writeFile(scriptPath, sourceBytes);
  const narrationLock = { provider: JOEL.provider, model: JOEL.model_id, model_revision: JOEL.model_revision,
    voice_id: JOEL.voice_id, voice_sha256: JOEL.voice_sha256,
    reference_audio_sha256: JOEL.reference_audio_sha256, reference_text_sha256: JOEL.reference_text_sha256 };
  const identity = {
    episode: "ep_fixture", proof_scope: { start_sec: 0, end_sec: 90, duration_frames: 2700, fps: 30, width: 1920, height: 1080 },
    ...identityFields,
    media_workflow: "avatar_footage_pilot_v1", content_profile: "mcu_what_if_pilot_v1",
    run_intent: "proof", production_eligible: false, publish_allowed: false,
    pilot_providers: { ...identityFields.pilot_providers, narration: narrationLock }, source_script: { path: scriptPath, sha256: scriptSha256 },
    ...buildPilotNarrationIdentityFields({ narrationLock, deliveryBank }),
  };
  const identityBytes = Buffer.from(`${JSON.stringify(identity, null, 2)}\n`);
  const identityPath = path.join(root, "run_identity.json");
  await fs.writeFile(identityPath, identityBytes);
  const identityFileSha256 = hash(identityBytes);
  const source = sourceBytes.toString("utf8"); let cursor = 0;
  const paragraphs = source.trim().split("\n\n");
  const editorialUnits = paragraphs.map((paragraph, index) => {
    const start = source.indexOf(paragraph, cursor); cursor = start + paragraph.length;
    return { source_start_utf16: start, source_end_utf16: cursor,
      boundary_class: index === paragraphs.length - 1 ? "episode_end" : "paragraph" };
  });
  const built = buildPilotNarrationPlans({ sourceBytes, sourceScriptSha256: scriptSha256,
    identity, identityBytes, identityFileSha256, deliveryBank, editorialUnits, openingUnitCount: 2 });
  const { plan, policy, planPolicy, textIr, spokenTextAudit } = built;
  const planPath = path.join(root, "plan.json"); const planFileSha256 = await writeJson(planPath, plan);
  const textIrPath = path.join(root, "ir.json"); const textIrFileSha256 = await writeJson(textIrPath, textIr);
  const spokenTextAuditPath = path.join(root, "audit.json");
  const spokenTextAuditFileSha256 = await writeJson(spokenTextAuditPath, spokenTextAudit);
  const evidence = evidenceFixture ? await evidenceFixture({ root, identity, identityPath, identityFileSha256,
    sourceBytes, scriptPath, scriptSha256, writeJson }) : null;
  const evidencePath = evidence?.path ?? path.join(root, "evidence.json");
  const evidenceSha256 = evidence?.sha256 ?? await writeJson(evidencePath, { fixture: true });
  // Exercise the complete canonical reference-binding shape without opening
  // actual voice/model assets. Distinct harmless files stand in for file bytes.
  const referenceAssetHashes = {};
  for (const label of ["reference_audio", "reference_manifest", "reference_metadata", "speaker_similarity_model", "speaker_similarity_calibration", "delivery_bank"]) {
    const fixturePath = path.join(root, `${label}.fixture`);
    const fixtureBytes = Buffer.from(`synthetic fixture ${label}`); await fs.writeFile(fixturePath, fixtureBytes);
    referenceAssetHashes[label] = { path: fixturePath, expected: hash(fixtureBytes), actual: hash(fixtureBytes) };
  }
  referenceAssetHashes.reference_text = { path: null, expected: policy.primary.reference_text_sha256, actual: hash(policy.primary.reference_text) };
  const gateArgs = { plan, policy, planPolicy, planPath, planFileSha256, identityPath, identityFileSha256,
    scriptPath, scriptSha256, textIr, textIrPath, textIrFileSha256,
    spokenTextAudit, spokenTextAuditPath, spokenTextAuditFileSha256, referenceAssetHashes,
    synthesisScope: { mode: "pilot_opening_only", authorized_synthesis_unit_ids: built.phases.opening.unit_ids,
      preserved_unit_ids: [], preserved_artifacts: [], evidence_path: evidencePath, evidence_sha256: evidenceSha256 } };
  const validationGate = buildNarrationPreSynthesisGate(gateArgs);
  assert.equal(validationGate.status, "passed", JSON.stringify(validationGate.findings));
  assert.equal(validationGate.bindings.batch_plan_sha256, built.phases.opening.batch_plan.batch_plan_sha256);
  if (runTests) for (const mutate of [
    (args) => { args.synthesisScope.authorized_synthesis_unit_ids.reverse(); },
    (args) => { args.synthesisScope.authorized_synthesis_unit_ids = plan.units.map((unit) => unit.unit_id); },
    (args) => { args.synthesisScope.evidence_path = null; },
    (args) => { args.plan.pilot_phase_batch_plans.opening = args.plan.pilot_phase_batch_plans.remaining; },
  ]) {
    const changed = structuredClone(gateArgs); mutate(changed);
    assert.equal(buildNarrationPreSynthesisGate(changed).status, "blocked"); assertions++;
  }
  const preSynthesisGatePath = path.join(root, "gate.json");
  const preSynthesisGate = authorizeNarrationPreSynthesisGate(validationGate);
  const preSynthesisGateFileSha256 = await writeJson(preSynthesisGatePath, preSynthesisGate);
  const options = { plan, units: built.phases.opening.units, policy, planPolicy,
    batchPlan: built.phases.opening.batch_plan, preSynthesisGate, preSynthesisGatePath,
    preSynthesisGateFileSha256, planPath, planFileSha256, identityPath, identityFileSha256,
    scriptPath, scriptSha256 };
  if (runTests) {
  assert.equal((await validatePilotOpeningExecutionInputs(options)).status, "passed");
  const zeroSpendPath = path.join(root, "validation-gate.json");
  const zeroSpendHash = await writeJson(zeroSpendPath, validationGate);
  const zeroSpend = await validatePilotOpeningExecutionInputs({ ...options, preSynthesisGate: validationGate,
    preSynthesisGatePath: zeroSpendPath, preSynthesisGateFileSha256: zeroSpendHash, requireAuthorized: false });
  assert.equal(zeroSpend.model_load_performed, false); assert.equal(zeroSpend.synthesis_invoked, false);
  for (const mutate of [
    (copy) => { copy.units.reverse(); },
    (copy) => { copy.units = copy.plan.units; },
    (copy) => { copy.units[0].spoken_text += " Changed."; },
    (copy) => { copy.batchPlan.cohorts[0].batch_seed++; },
    (copy) => { copy.acceptedUnitIds = [copy.units[0].unit_id]; },
    (copy) => { copy.preSynthesisGate.scope.mode = "initial_full_synthesis"; },
    (copy) => { copy.preSynthesisGate.historical_synthesis_authorized = true; },
    (copy) => { copy.preSynthesisGate = validationGate; },
    (copy) => { copy.planFileSha256 = "0".repeat(64); },
  ]) {
    const changed = structuredClone(options); mutate(changed);
    await assert.rejects(() => validatePilotOpeningExecutionInputs(changed), /blocked/u); assertions++;
  }
  // Rehashing a forged passed report cannot bypass the complete canonical gate.
  const forged = structuredClone(options); forged.preSynthesisGate.authorization.validation_gate_sha256 = "0".repeat(64);
  forged.preSynthesisGate.gate_sha256 = narrationPreSynthesisGateSha256(forged.preSynthesisGate);
  forged.preSynthesisGateFileSha256 = await writeJson(preSynthesisGatePath, forged.preSynthesisGate);
  await assert.rejects(() => validatePilotOpeningExecutionInputs(forged), /authorization is not bound/u); assertions++;
  await writeJson(preSynthesisGatePath, preSynthesisGate);
  for (const mutate of [
    (gate) => { gate.bindings.reference_asset_hashes.reference_text.actual = "0".repeat(64); },
    (gate) => { gate.bindings.reference_asset_hashes.reference_audio.path = null; },
  ]) {
    const changed = structuredClone(options); mutate(changed.preSynthesisGate);
    changed.preSynthesisGate.gate_sha256 = narrationPreSynthesisGateSha256(changed.preSynthesisGate);
    changed.preSynthesisGateFileSha256 = await writeJson(preSynthesisGatePath, changed.preSynthesisGate);
    await assert.rejects(() => validatePilotOpeningExecutionInputs(changed), /reference/u); assertions++;
  }
  await writeJson(preSynthesisGatePath, preSynthesisGate);

  }
  const { units, batchPlan } = options; const bindings = qwenBatchBindingByUnit(batchPlan);
  const jobs = {
    schema: "goldflow_narration_tts_jobs_v2", route: "qwen", attempt: 1,
    provider: policy.primary.provider, model_id: policy.primary.model_id, model_revision: policy.primary.model_revision,
    voice_id: policy.primary.voice_id, voice_sha256: policy.primary.voice_sha256,
    voice_continuity_contract: policy.primary.voice_continuity_contract,
    qwen_reference_audio_sha256: policy.primary.reference_audio_sha256, qwen_reference_text: policy.primary.reference_text,
    qwen_reference_manifest_sha256: policy.primary.reference_manifest_sha256,
    qwen_reference_voice_id: policy.primary.reference_voice_id, qwen_reference_voice_sha256: policy.primary.reference_voice_sha256,
    qwen_voice_continuity_contract: policy.primary.voice_continuity_contract,
    synthesis_mode: policy.synthesis_contract.mode, synthesis_contract: policy.synthesis_contract,
    batch_plan: batchPlan, batch_plan_sha256: batchPlan.batch_plan_sha256,
    pre_synthesis_gate: { path: preSynthesisGatePath, file_sha256: preSynthesisGateFileSha256, gate_sha256: preSynthesisGate.gate_sha256 },
    narration_generation_plan_path: planPath, narration_generation_plan_sha256: plan.plan_sha256,
    narration_generation_plan_file_sha256: planFileSha256, run_identity_path: identityPath,
    run_identity_file_sha256: identityFileSha256, source_script_path: scriptPath, source_script_sha256: scriptSha256,
    qwen_native_speed: null, qwen_post_tts_tempo_processing: false, continuous_longform_request: false,
    jobs: units.map((unit, index) => ({ unit_id: unit.unit_id, spoken_text: unit.spoken_text,
      spoken_text_sha256: unit.spoken_text_sha256, original_order_index: unit.order_index,
      spoken_word_count: unit.word_count, spoken_text_utf8_bytes: Buffer.byteLength(unit.spoken_text),
      seed: deterministicTtsSeed(unit.unit_id, policy.primary.provider, 1), attempt: 1, recovery_provenance: null, synthesis_cohort: bindings.get(unit.unit_id) })),
  };
  const jobsPath = path.join(root, "jobs.json"); const jobsHash = await writeJson(jobsPath, jobs);
  const runnerPath = fileURLToPath(new URL("../tts-local-production-runner.py", import.meta.url));
  // Execute only dependency-free Python validators against the fixture jobs.
  // In particular, verify that phase cohorts pass the real runner's rules while
  // the bound canonical plan still contains the untouched remaining narration.
  if (runTests) {
  const pythonCheck = execFileSync("python3", ["-c", `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("opening_fixture_runner", sys.argv[1])
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
manifest = json.load(open(sys.argv[2]))
jobs = runner.validate_jobs(manifest)
assert runner.validate_pre_synthesis_gate(manifest, jobs) == []
mode, contract, batch = runner.validate_qwen_synthesis_manifest(manifest, jobs)
assert mode == runner.BATCH4_SYNTHESIS_MODE
assert len(jobs) == 2 and batch["unit_count"] == 2
assert runner.mx is None and runner.np is None and runner.load_model is None
print("phase validators passed without model imports")
`, runnerPath, jobsPath], { encoding: "utf8" });
  assert.match(pythonCheck, /phase validators passed without model imports/u);
  }
  const modelAssets = Object.fromEntries(["model_weights_sha256", "model_config_sha256", "generation_config_sha256",
    "speech_tokenizer_weights_sha256", "speech_tokenizer_config_sha256"].map((field) => [field, policy.primary[field]]));
  const results = [];
  for (const [index, unit] of units.entries()) {
    const binding = bindings.get(unit.unit_id); const cohort = batchPlan.cohorts[binding.cohort_index];
    const outputPath = path.join(root, `${unit.unit_id}.wav`); const sidecarPath = outputPath.replace(/\.wav$/u, ".json");
    const audioBytes = wavFixture(unitDurationSec); await fs.writeFile(outputPath, audioBytes);
    const si = { schema: "goldflow_local_tts_synthesis_identity_v2", unit_id: unit.unit_id,
      spoken_text: unit.spoken_text, spoken_text_sha256: unit.spoken_text_sha256, attempt: 1,
      provider: policy.primary.provider, model_id: policy.primary.model_id, model_revision: policy.primary.model_revision,
      voice: policy.primary.voice_id, voice_sha256: policy.primary.voice_sha256,
      voice_clone_contract: policy.primary.voice_clone_contract, voice_continuity_contract: policy.primary.voice_continuity_contract,
      reference_audio_sha256: policy.primary.reference_audio_sha256, reference_text: policy.primary.reference_text,
      reference_manifest_sha256: policy.primary.reference_manifest_sha256, ...modelAssets, ...binding,
      cohort_members: cohort.members, seed: cohort.batch_seed, per_unit_serial_seed: jobs.jobs[index].seed,
      synthesis_api: "Model.batch_generate", native_speed_applied: null, post_tts_tempo_processing: false,
      continuous_batching: false, model_instance_count: 1, model_concurrency: 1, token_limit_acceptance_allowed: false };
    const result = { unit_id: unit.unit_id, status: "generated", attempt: 1,
      provider: policy.primary.provider, model_id: policy.primary.model_id, voice_id: policy.primary.voice_id,
      synthesis_mode: policy.synthesis_contract.mode, batch_plan_sha256: batchPlan.batch_plan_sha256,
      cohort_id: binding.cohort_id, cohort_sha256: binding.cohort_sha256,
      seed: binding.batch_seed, per_unit_serial_seed: jobs.jobs[index].seed,
      spoken_text: unit.spoken_text, spoken_text_sha256: unit.spoken_text_sha256,
      generated_token_count: 30, effective_token_limit: 1200, token_limit_reached: false,
      duration_sec: Number((Math.round(unitDurationSec * 24000) / 24000).toFixed(6)), sample_count: Math.round(unitDurationSec * 24000), sample_rate_hz: 24000,
      output_path: outputPath, output_sha256: hash(audioBytes), sidecar_path: sidecarPath,
      synthesis_identity: si, synthesis_identity_sha256: canonicalQwenBatchSha256(si) };
    await writeJson(sidecarPath, result); results.push(result);
  }
  const cohortExecutions = batchPlan.cohorts.map((cohort) => ({ cohort_id: cohort.cohort_id,
    cohort_sha256: cohort.cohort_sha256, cohort_index: cohort.cohort_index, nominal_batch_size: 4,
    effective_batch_size: cohort.effective_batch_size, batch_seed: cohort.batch_seed,
    unit_ids: cohort.members.map((member) => member.unit_id), status: "generated", model_call_performed: true }));
  const eventsPath = path.join(root, "events.jsonl");
  const events = batchPlan.cohorts.map((cohort, index) => ({ schema: "goldflow_local_tts_cohort_event_v1",
    event: "cohort_complete", jobs_sha256: jobsHash, batch_plan_sha256: batchPlan.batch_plan_sha256,
    cohort_id: cohort.cohort_id, cohort_sha256: cohort.cohort_sha256, cohort_index: cohort.cohort_index,
    execution: cohortExecutions[index], results: cohort.members.map((member) => results.find((row) => row.unit_id === member.unit_id)) }));
  const eventBytes = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`); await fs.writeFile(eventsPath, eventBytes);
  const report = { schema: "goldflow_local_tts_production_run_v2", status: "passed", route: "qwen",
    job_count: units.length, result_count: units.length, results_restored_to_original_order: true,
    original_order_unit_ids: units.map((unit) => unit.unit_id), results,
    provider: policy.primary.provider, model_id: policy.primary.model_id, model_revision: policy.primary.model_revision,
    voice_id: policy.primary.voice_id, voice_sha256: policy.primary.voice_sha256,
    voice_clone_contract: policy.primary.voice_clone_contract, voice_continuity_contract: policy.primary.voice_continuity_contract,
    effective_concurrency: 1, model_load_count: 1, resident_model_count: 1, model_instance_concurrency: 1,
    continuous_batching: false, token_limit_acceptance_allowed: false, accepted_token_limit_result_count: 0,
    reference_audio_preloaded_once: true, preserved_unit_count: 0, preserved_unit_ids: [],
    batch_plan_sha256: batchPlan.batch_plan_sha256, synthesis_mode: policy.synthesis_contract.mode,
    synthesis_contract: policy.synthesis_contract, pre_synthesis_gate_sha256: preSynthesisGate.gate_sha256,
    pre_synthesis_gate_path: preSynthesisGatePath, pre_synthesis_gate_file_sha256: preSynthesisGateFileSha256,
    jobs_path: jobsPath, jobs_sha256: jobsHash, cohort_executions: cohortExecutions,
    cohort_event_path: eventsPath, cohort_event_count: events.length, ...modelAssets };
  const reportPath = path.join(root, "runner.json"); const reportSha256 = await writeJson(reportPath, report);
  const execution = { report, reportPath, reportSha256, results, cohortEventsPath: eventsPath, cohortEventsSha256: hash(eventBytes) };
  if (!runTests) {
    fixtureReady = true;
    return { root, options, execution, sourceBytes, identity, built, plan,
      gateArgs, validationGate, writeJson, wavFixture, cleanup };
  }
  const passed = await validatePilotOpeningExecutionResults({ ...options, execution });
  assert.equal(passed.status, "passed"); assert.equal(passed.listening_qa_performed, false);
  assert(passed.units.every((row) => /^[a-f0-9]{64}$/u.test(row.provider_request_sha256)
    && /^[a-f0-9]{64}$/u.test(row.provider_payload_sha256)
    && /^[a-f0-9]{64}$/u.test(row.provider_request_synthesis_identity_sha256)));
  assert.deepEqual(passed.units.map((row) => row.synthesis_identity), results.map((row) => row.synthesis_identity));
  for (const mutate of [
    (copy) => { copy.results.reverse(); },
    (copy) => { copy.results[0].generated_token_count = 1200; },
    (copy) => { copy.results[0].synthesis_identity.cohort_position++; },
    (copy) => { copy.results[0].status = "cached"; },
    (copy) => { copy.model_load_count = 2; },
    (copy) => { copy.pre_synthesis_gate_sha256 = "0".repeat(64); },
    (copy) => { copy.cohort_executions[0].unit_ids.reverse(); },
    (copy) => { copy.model_weights_sha256 = "0".repeat(64); },
  ]) {
    const altered = structuredClone(report); mutate(altered);
    const alteredHash = await writeJson(reportPath, altered);
    await assert.rejects(() => validatePilotOpeningExecutionResults({ ...options,
      execution: { ...execution, report: altered, results: altered.results, reportSha256: alteredHash } }), /blocked/u);
    assertions++;
  }
  await writeJson(reportPath, report);
  await fs.appendFile(results[0].output_path, "stale");
  await assert.rejects(() => validatePilotOpeningExecutionResults({ ...options, execution }), /WAV.*hash is stale/u); assertions++;
  await fs.writeFile(results[0].output_path, wavFixture());
  const changedSidecar = structuredClone(results[0]); changedSidecar.synthesis_identity.batch_seed++;
  await writeJson(results[0].sidecar_path, changedSidecar);
  await assert.rejects(() => validatePilotOpeningExecutionResults({ ...options, execution }), /sidecar evidence differs/u); assertions++;
  console.log(`avatar pilot opening execution tests passed (${assertions} blocked mutations; synthetic fixtures only, no models or real episode writes)`);
  } finally {
    if (!fixtureReady) await cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPilotOpeningExecutionFixture({ runTests: true });
}
