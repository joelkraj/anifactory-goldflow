import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildPilotOpeningValidationFixture } from "./avatar-pilot-opening-validation-tests.mjs";
import { buildPilotOpeningExecutionFixture } from "./avatar-pilot-opening-execution-tests.mjs";
import { canonicalQwenBatchSha256, qwenBatchBindingByUnit } from "../lib/qwen-liam-batch-contract.mjs";
import { deterministicTtsSeed } from "../lib/tts-selection-policy.mjs";
import { buildNarrationSubjectiveReviewDecision, NARRATION_SUBJECTIVE_REVIEW_ATTESTATION } from "../lib/narration-subjective-review.mjs";
import { buildNarrationPreSynthesisGate, authorizeNarrationPreSynthesisGate } from "../lib/narration-pre-synthesis-gate.mjs";
import { authenticateAcceptedPilotOpening, validatePilotRemainingExecutionInputs,
  validatePilotRemainingExecutionResults } from "../lib/avatar-pilot-remaining-execution.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Provider-free fixture: actual temp files, synthetic silence and explicitly
// synthetic QA/listening assertions. No model, provider or real episode writes.
export async function buildPilotRemainingExecutionFixture({ unitDurationSec = 8, remainingParagraphs = null,
  identityFields = {}, evidenceFixture = null } = {}) {
  const openingFixture = await buildPilotOpeningValidationFixture({ executionFixture:
    await buildPilotOpeningExecutionFixture({ unitDurationSec: 8, remainingParagraphs, identityFields, evidenceFixture }) });
  const { root, identity, result: sample, options: openingOptions, execution: openingExecution,
    writeJson, wavFixture, cleanup } = openingFixture;
  let ready = false;
  try {
    sample.finalized = { phase_context: { phase: "opening", outputNamespace: openingFixture.namespace,
      unitIds: sample.unit_ids, identitySha256: openingOptions.identityFileSha256,
      sourceScriptSha256: openingOptions.scriptSha256, generationPlanFileSha256: sample.generation_plan.sha256,
      providerManifestFileSha256: sample.provider_output_manifest.sha256,
      sourceArtifacts: {}, preSynthesisGatePath: sample.pre_synthesis_gate.path,
      preSynthesisGateFileSha256: sample.pre_synthesis_gate.sha256,
      textIrPath: sample.spoken_text_ir.path, textIrFileSha256: sample.spoken_text_ir.sha256,
      spokenTextAuditPath: sample.spoken_text_audit.path, spokenTextAuditFileSha256: sample.spoken_text_audit.sha256 } };
    const producerPath = path.join(root, "pilot_narration_work", "opening_producer_result.json");
    const producerRef = { path: producerPath, sha256: await writeJson(producerPath, sample) };
    const common = { schema: "goldflow_avatar_pilot_stage_v1", fixture_only: true,
      identity_sha256: openingOptions.identityFileSha256, created_at: "2026-01-01T00:00:00.000Z" };
    const sampleStage = { ...common, stage: "pilot_voice_sample", payload: sample, inputs: [
      { role: "upstream", path: openingOptions.preSynthesisGate.scope.evidence_path,
        sha256: openingOptions.preSynthesisGate.scope.evidence_sha256 },
      { role: "produced_opening", ...producerRef },
    ] };
    const samplePath = path.join(root, "pilot_voice_sample.json");
    const sampleRef = { path: samplePath, sha256: await writeJson(samplePath, sampleStage) };
    const subjective = openingFixture.jsonValues.get("subjective_manifest");
    const note = "Synthetic fixture only: no actual voice or human listening is represented.";
    const decision = buildNarrationSubjectiveReviewDecision({ manifest: subjective, reviewer: "fixture-only reviewer",
      attestation: NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
      decisions: subjective.samples.map((row) => ({ sample_id: row.sample_id, decision: "accept", note })) });
    const decisionPath = path.join(openingFixture.namespace, "narration_subjective_review_decision_fixture.json");
    const decisionRef = { path: decisionPath, sha256: await writeJson(decisionPath, decision) };
    const refs = sample.finalization_artifacts;
    const approval = { review: { approved: true, reviewer: "fixture-only reviewer", note,
      attestation: "complete_opening_listened_end_to_end" }, subjective_decision: decisionRef,
      listening_attestation_mapping: { schema: "goldflow_pilot_opening_listening_attestation_mapping_v1",
        operator_attestation: "complete_opening_listened_end_to_end",
        canonical_attestation: NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
        manifest_sha256: refs.subjective_manifest.sha256, audio_sha256: refs.audio.sha256,
        all_samples_contained_in_opening: true, sample_ids: subjective.samples.map((row) => row.sample_id) } };
    const approvalStage = { ...common, stage: "pilot_voice_sample_approval", payload: approval, inputs: [
      { role: "upstream", ...sampleRef }, { role: "subjective_manifest", ...refs.subjective_manifest },
      { role: "opening_audio", ...refs.audio }, { role: "subjective_decision", ...decisionRef },
    ] };
    const approvalPath = path.join(root, "pilot_voice_sample_approval.json");
    const acceptedOpening = { sample: sampleRef, approval: { path: approvalPath,
      sha256: await writeJson(approvalPath, approvalStage) } };
    const accepted = await authenticateAcceptedPilotOpening({ acceptedOpening, episodeDir: root, identity });
    const { plan, policy } = openingOptions;
    const units = plan.units.slice(plan.pilot_opening_unit_ids.length), batchPlan = plan.pilot_phase_batch_plans.remaining;
    const remainingRoot = path.join(root, "pilot_narration_work", "remaining");
    const executionDir = path.join(remainingRoot, "execution");
    await fs.mkdir(executionDir, { recursive: true }); await fs.mkdir(path.join(remainingRoot, "inputs"));
    const gateArgs = { ...openingFixture.gateArgs, synthesisScope: { mode: "pilot_remaining_only",
      authorized_synthesis_unit_ids: units.map((unit) => unit.unit_id), preserved_unit_ids: plan.pilot_opening_unit_ids,
      preserved_artifacts: accepted.preservedArtifacts,
      evidence_path: acceptedOpening.approval.path, evidence_sha256: acceptedOpening.approval.sha256 } };
    const validationGate = buildNarrationPreSynthesisGate(gateArgs);
    assert.equal(validationGate.status, "passed", JSON.stringify(validationGate.findings));
    const preSynthesisGate = authorizeNarrationPreSynthesisGate(validationGate);
    const preSynthesisGatePath = path.join(remainingRoot, "inputs", "pre_synthesis_authorized.json");
    const preSynthesisGateFileSha256 = await writeJson(preSynthesisGatePath, preSynthesisGate);
    const options = { ...openingOptions, units, batchPlan, preSynthesisGate, preSynthesisGatePath,
      preSynthesisGateFileSha256, acceptedUnitIds: plan.pilot_opening_unit_ids, acceptedOpening, episodeDir: root, identity };
    const bindings = qwenBatchBindingByUnit(batchPlan);
    const jobs = JSON.parse(await fs.readFile(openingExecution.report.jobs_path, "utf8"));
    jobs.batch_plan = batchPlan; jobs.batch_plan_sha256 = batchPlan.batch_plan_sha256;
    jobs.pre_synthesis_gate = { path: preSynthesisGatePath, file_sha256: preSynthesisGateFileSha256, gate_sha256: preSynthesisGate.gate_sha256 };
    jobs.jobs = units.map((unit) => ({ ...jobs.jobs[0], unit_id: unit.unit_id, spoken_text: unit.spoken_text,
      spoken_text_sha256: unit.spoken_text_sha256, original_order_index: unit.order_index,
      spoken_word_count: unit.word_count, spoken_text_utf8_bytes: Buffer.byteLength(unit.spoken_text),
      seed: deterministicTtsSeed(unit.unit_id, policy.primary.provider, 1), synthesis_cohort: bindings.get(unit.unit_id) }));
    const jobsPath = path.join(executionDir, "jobs.json"), jobsHash = await writeJson(jobsPath, jobs);
    const results = [];
    for (const [index, unit] of units.entries()) {
      const binding = bindings.get(unit.unit_id), cohort = batchPlan.cohorts[binding.cohort_index];
      const si = { ...openingExecution.results[0].synthesis_identity, unit_id: unit.unit_id,
        spoken_text: unit.spoken_text, spoken_text_sha256: unit.spoken_text_sha256, ...binding,
        cohort_members: cohort.members, seed: cohort.batch_seed, per_unit_serial_seed: jobs.jobs[index].seed };
      const outputPath = path.join(executionDir, `${unit.unit_id}.wav`), audio = wavFixture(unitDurationSec);
      await fs.writeFile(outputPath, audio);
      const row = { ...openingExecution.results[0], unit_id: unit.unit_id, spoken_text: unit.spoken_text,
        spoken_text_sha256: unit.spoken_text_sha256, batch_plan_sha256: batchPlan.batch_plan_sha256,
        cohort_id: binding.cohort_id, cohort_sha256: binding.cohort_sha256, seed: binding.batch_seed,
        per_unit_serial_seed: jobs.jobs[index].seed,
        duration_sec: Number((Math.round(unitDurationSec * 24000) / 24000).toFixed(6)),
        sample_count: Math.round(unitDurationSec * 24000), output_path: outputPath, output_sha256: hash(audio),
        sidecar_path: outputPath.replace(/\.wav$/u, ".json"), synthesis_identity: si,
        synthesis_identity_sha256: canonicalQwenBatchSha256(si) };
      await writeJson(row.sidecar_path, row); results.push(row);
    }
    const cohorts = batchPlan.cohorts.map((cohort) => ({ cohort_id: cohort.cohort_id, cohort_sha256: cohort.cohort_sha256,
      cohort_index: cohort.cohort_index, nominal_batch_size: 4, effective_batch_size: cohort.effective_batch_size,
      batch_seed: cohort.batch_seed, unit_ids: cohort.members.map((member) => member.unit_id),
      status: "generated", model_call_performed: true }));
    const events = batchPlan.cohorts.map((cohort, index) => ({ schema: "goldflow_local_tts_cohort_event_v1", event: "cohort_complete",
      jobs_sha256: jobsHash, batch_plan_sha256: batchPlan.batch_plan_sha256, cohort_id: cohort.cohort_id,
      cohort_sha256: cohort.cohort_sha256, cohort_index: cohort.cohort_index, execution: cohorts[index],
      results: cohort.members.map((member) => results.find((row) => row.unit_id === member.unit_id)) }));
    const cohortEventsPath = path.join(executionDir, "events.jsonl");
    const eventBytes = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    await fs.writeFile(cohortEventsPath, eventBytes);
    const report = { ...openingExecution.report, job_count: units.length, result_count: units.length,
      original_order_unit_ids: units.map((unit) => unit.unit_id), results,
      preserved_unit_count: plan.pilot_opening_unit_ids.length, preserved_unit_ids: plan.pilot_opening_unit_ids,
      batch_plan_sha256: batchPlan.batch_plan_sha256, pre_synthesis_gate_sha256: preSynthesisGate.gate_sha256,
      pre_synthesis_gate_path: preSynthesisGatePath, pre_synthesis_gate_file_sha256: preSynthesisGateFileSha256,
      jobs_path: jobsPath, jobs_sha256: jobsHash, cohort_executions: cohorts,
      cohort_event_path: cohortEventsPath, cohort_event_count: events.length };
    const reportPath = path.join(executionDir, "runner.json"), reportSha256 = await writeJson(reportPath, report);
    const execution = { report, reportPath, reportSha256, results, cohortEventsPath, cohortEventsSha256: hash(eventBytes) };
    ready = true;
    return { openingFixture, root, identity, options, execution, acceptedOpening, accepted, gateArgs, validationGate,
      jobs, sampleStage, approvalStage, writeJson, wavFixture, cleanup };
  } finally { if (!ready) await cleanup(); }
}

async function main() {
  const fixture = await buildPilotRemainingExecutionFixture();
  const { options, execution, gateArgs, acceptedOpening, accepted, root, identity, writeJson } = fixture;
  let checks = 0;
  try {
    assert.equal((await validatePilotRemainingExecutionInputs(options)).status, "passed");
    const checked = await validatePilotRemainingExecutionResults({ ...options, execution });
    assert.equal(checked.status, "passed");
    assert.deepEqual(checked.units.map((unit) => unit.unit_id), options.units.map((unit) => unit.unit_id));
    assert(checked.units.every((unit) => unit.batch_plan_sha256 === options.batchPlan.batch_plan_sha256));
    assert(accepted.preservedArtifacts.every((unit) => unit.batch_plan_sha256 === options.plan.pilot_phase_batch_plans.opening.batch_plan_sha256));
    const zeroPath = path.join(root, "remaining-zero-spend.json");
    assert.equal((await validatePilotRemainingExecutionInputs({ ...options, preSynthesisGate: fixture.validationGate,
      preSynthesisGatePath: zeroPath, preSynthesisGateFileSha256: await writeJson(zeroPath, fixture.validationGate), requireAuthorized: false })).model_load_performed, false);
    for (const mutate of [
      (row) => { row.units = row.plan.units; },
      (row) => { row.acceptedUnitIds = []; },
      (row) => { row.batchPlan = row.plan.pilot_phase_batch_plans.opening; },
      (row) => { row.planPath = `${row.planPath}.copied`; },
      (row) => { row.acceptedOpening.approval.sha256 = "0".repeat(64); },
      (row) => { row.acceptedOpening.sample.path = row.acceptedOpening.approval.path; },
      (row) => { row.identity.source_script.sha256 = "0".repeat(64); },
    ]) {
      const changed = structuredClone(options); mutate(changed);
      await assert.rejects(() => validatePilotRemainingExecutionInputs(changed)); checks++;
    }
    for (const mutate of [
      (row) => { row.synthesisScope.authorized_synthesis_unit_ids = row.plan.pilot_opening_unit_ids; },
      (row) => { row.synthesisScope.preserved_unit_ids = []; },
      (row) => { row.synthesisScope.preserved_artifacts = []; },
      (row) => { row.synthesisScope.evidence_sha256 = null; },
      (row) => { row.plan.pilot_phase_batch_plans.remaining = row.plan.pilot_phase_batch_plans.opening; },
    ]) {
      const changed = structuredClone(gateArgs); mutate(changed);
      assert.equal(buildNarrationPreSynthesisGate(changed).status, "blocked"); checks++;
    }
    // Rehashed gates cannot replace, omit or weaken any original acceptance evidence.
    for (const mutate of [
      (row) => { delete row.synthesisScope.preserved_artifacts[0].opening_finalization_artifacts; },
      (row) => { row.synthesisScope.preserved_artifacts[0].batch_seed++; },
      (row) => { row.synthesisScope.evidence_path = row.synthesisScope.preserved_artifacts[0].audio_path; row.synthesisScope.evidence_sha256 = row.synthesisScope.preserved_artifacts[0].audio_sha256; },
      (row) => { row.textIrPath = `${row.textIrPath}.copy`; },
      (row) => { row.spokenTextAuditPath = `${row.spokenTextAuditPath}.copy`; },
    ]) {
      const args = structuredClone(gateArgs); mutate(args);
      const gate = authorizeNarrationPreSynthesisGate(buildNarrationPreSynthesisGate(args));
      const changed = { ...options, preSynthesisGate: gate,
        preSynthesisGateFileSha256: await writeJson(options.preSynthesisGatePath, gate) };
      await assert.rejects(() => validatePilotRemainingExecutionInputs(changed)); checks++;
    }
    await writeJson(options.preSynthesisGatePath, options.preSynthesisGate);
    for (const mutate of [
      (row) => { row.payload.review.attestation = "looks_good"; },
      (row) => { row.payload.review.approved = false; },
      (row) => { row.payload.review.note = "Different approval"; },
      (row) => { row.payload.listening_attestation_mapping.sample_ids = []; },
      (row) => { row.inputs.find((ref) => ref.role === "upstream").sha256 = "0".repeat(64); },
    ]) {
      const stage = structuredClone(fixture.approvalStage); mutate(stage);
      const changed = structuredClone(acceptedOpening);
      changed.approval.sha256 = await writeJson(changed.approval.path, stage);
      await assert.rejects(() => authenticateAcceptedPilotOpening({ acceptedOpening: changed, episodeDir: root, identity })); checks++;
    }
    await writeJson(acceptedOpening.approval.path, fixture.approvalStage);
    // Recheck every class of preserved original evidence, not only the final
    // sample hash. Restoring bytes restores the same original approval hashes.
    const preservedFiles = new Set([
      ...Object.values(accepted.sample.finalization_artifacts).map((ref) => ref.path),
      accepted.sample.runner_report.path, accepted.sample.cohort_events.path,
      accepted.sample.provider_output_manifest.path, accepted.sample.generation_plan.path,
      accepted.sample.spoken_text_ir.path, accepted.sample.spoken_text_audit.path,
      accepted.sample.pre_synthesis_gate.path, accepted.approval.subjective_decision.path,
      ...accepted.preservedArtifacts.map((unit) => unit.synthesis_sidecar_path),
    ]);
    for (const file of preservedFiles) {
      const original = await fs.readFile(file);
      await fs.appendFile(file, "changed");
      await assert.rejects(() => validatePilotRemainingExecutionInputs(options)); checks++;
      await fs.writeFile(file, original);
    }
    for (const mutate of [
      (row) => { row.preserved_unit_count = 0; row.preserved_unit_ids = []; },
      (row) => { row.results = [...fixture.openingFixture.execution.results, ...row.results]; row.result_count = row.results.length; },
      (row) => { row.results[0].status = "cached"; },
      (row) => { row.cohort_executions[0].batch_seed++; },
    ]) {
      const report = structuredClone(execution.report); mutate(report);
      const reportSha256 = await writeJson(execution.reportPath, report);
      await assert.rejects(() => validatePilotRemainingExecutionResults({ ...options, execution: { ...execution, report,
        results: report.results, reportSha256 } })); checks++;
    }
    await writeJson(execution.reportPath, execution.report);
    // The real Python entry validators accept phase-only jobs with global order
    // indexes and preserved opening. No ML dependencies are loaded here.
    const runnerPath = fileURLToPath(new URL("../tts-local-production-runner.py", import.meta.url));
    const output = execFileSync("python3", ["-c", `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("remaining_fixture_runner", sys.argv[1])
runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
manifest = json.load(open(sys.argv[2])); jobs = runner.validate_jobs(manifest)
preserved = runner.validate_pre_synthesis_gate(manifest, jobs)
mode, contract, batch = runner.validate_qwen_synthesis_manifest(manifest, jobs)
assert mode == runner.BATCH4_SYNTHESIS_MODE and len(preserved) == 2
assert len(jobs) == 1 and jobs[0]["original_order_index"] == 2
assert batch["original_order_unit_ids"] == [jobs[0]["unit_id"]]
runner.verify_preserved_artifacts_unchanged(preserved)
target = preserved[0]["audio_path"]; original = open(target, "rb").read()
try:
    open(target, "ab").write(b"changed")
    for check in [lambda: runner.validate_pre_synthesis_gate(manifest, jobs), lambda: runner.verify_preserved_artifacts_unchanged(preserved)]:
        try: check()
        except (ValueError, RuntimeError): pass
        else: raise AssertionError("changed accepted WAV was not blocked")
finally: open(target, "wb").write(original)
assert runner.mx is None and runner.np is None and runner.load_model is None
print("remaining and preservation validators passed without model imports")
`, runnerPath, execution.report.jobs_path], { encoding: "utf8" });
    assert.match(output, /preservation validators passed without model imports/u);
    const originalAudio = await fs.readFile(accepted.preservedArtifacts[0].audio_path);
    await fs.appendFile(accepted.preservedArtifacts[0].audio_path, "changed");
    await assert.rejects(() => validatePilotRemainingExecutionInputs(options)); checks++;
    await fs.writeFile(accepted.preservedArtifacts[0].audio_path, originalAudio);
    assert.equal((await validatePilotRemainingExecutionResults({ ...options, execution })).status, "passed");
    const multi = await buildPilotRemainingExecutionFixture({ remainingParagraphs: [
      "Her companion waits outside until a small lamp appears in the distant window.",
      "A messenger crosses the courtyard carrying a sealed letter from the northern village.",
      "The guards study his expression while the old bell rings above the square.",
      "No one speaks until a quiet voice explains what happened beyond the mountains.",
      "The traveler considers the warning before turning back toward the open stone doorway.",
    ] });
    try {
      assert.deepEqual(multi.options.batchPlan.cohorts.map((cohort) => cohort.effective_batch_size), [4, 1]);
      const multiChecked = await validatePilotRemainingExecutionResults({ ...multi.options, execution: multi.execution });
      assert.equal(multiChecked.units.length, 5);
      assert.deepEqual(multiChecked.units.map((unit) => unit.synthesis_identity), multi.execution.results.map((row) => row.synthesis_identity));
      const multiOutput = execFileSync("python3", ["-c", `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("multi_remaining_fixture_runner", sys.argv[1])
runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
manifest = json.load(open(sys.argv[2])); jobs = runner.validate_jobs(manifest)
preserved = runner.validate_pre_synthesis_gate(manifest, jobs)
mode, contract, batch = runner.validate_qwen_synthesis_manifest(manifest, jobs)
assert [cohort["effective_batch_size"] for cohort in batch["cohorts"]] == [4, 1]
assert [job["original_order_index"] for job in jobs] == [2, 3, 4, 5, 6]
assert len(preserved) == 2 and runner.mx is None and runner.np is None and runner.load_model is None
print("multiple remaining cohorts validated without model imports")
`, runnerPath, multi.execution.report.jobs_path], { encoding: "utf8" });
      assert.match(multiOutput, /multiple remaining cohorts validated/u);
    } finally { await multi.cleanup(); }
    console.log(`avatar pilot remaining execution tests passed (${checks} blocked mutations; actual Python pre-model preservation checks; synthetic only)`);
  } finally { await fixture.cleanup(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
