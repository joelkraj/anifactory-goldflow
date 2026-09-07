import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readBound, binding, writeNew, inspectOpeningRuntime } from "./avatar-pilot-opening-producer.mjs";
import { narrationTtsPolicyForIdentity, validateNarrationTtsPolicy } from "./narration-tts-policy.mjs";
import { validatePilotNarrationPlanPolicy } from "./avatar-pilot-narration-plan.mjs";
import { buildNarrationPreSynthesisGate, authorizeNarrationPreSynthesisGate } from "./narration-pre-synthesis-gate.mjs";
import { buildNarrationProviderOutputManifest } from "./narration-provider-adapter.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-kokoro-mlx-audio-0.4.6/bin/python";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const need = (ok, message) => { if (!ok) throw new Error(message); };
const passed = (result, label) => need(result?.status === "passed", `${label}: ${JSON.stringify(result?.findings ?? [])}`);
const json = async (ref) => JSON.parse((await readBound(ref)).toString("utf8"));

/** Provider-free test seam; the CLI always uses the canonical dependencies. */
export function createPilotNarrationProducer({
  getStatus = async (episodeDir) => (await import("./avatar-pilot-workflow.mjs")).pilotStatus(episodeDir),
  synthesize = async (args) => (await import("../narration-tts-episode.mjs")).runSynthesis(args),
  finalize = async (...args) => (await import("../narration-provider-output-finalize.mjs")).finalizeNarrationProviderOutput(...args),
  inspectRuntime = inspectOpeningRuntime,
} = {}) {
  return async function produceNarration({ episodeDir }) {
    episodeDir = path.resolve(episodeDir);
    const current = await getStatus(episodeDir);
    need(current.current_stage === "pilot_narration" && current.allowed_command_stages.includes("pilot_narration"), "Remaining narration is not authorized by run status.");
    const identity = current.identity;
    need(identity.pilot_narration_contract && identity.proof_scope.duration_frames === 2700, "Canonical private 90-second identity required.");
    const acceptedOpening = { sample: await binding(path.join(episodeDir, "pilot_voice_sample.json")),
      approval: await binding(path.join(episodeDir, "pilot_voice_sample_approval.json")) };
    const sample = (await json(acceptedOpening.sample)).payload;
    const identityPath = path.join(episodeDir, "run_identity.json"), identityFileSha256 = hash(await fs.readFile(identityPath));
    const sourceBytes = await readBound(identity.source_script);
    const plan = await json(sample.generation_plan), textIr = await json(sample.spoken_text_ir), audit = await json(sample.spoken_text_audit);
    const openingGate = await json(sample.pre_synthesis_gate), openingManifest = await json(sample.provider_output_manifest);
    const openingReport = await json(sample.runner_report);
    const policy = { ...validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), { production: true }), status: "passed", findings: [] };
    const planPolicy = validatePilotNarrationPlanPolicy(plan, policy, { sourceBytes, identityFileSha256, textIr, spokenTextAudit: audit });
    passed(planPolicy, "Frozen narration plan invalid");
    const units = plan.units.slice(plan.pilot_opening_unit_ids.length), batchPlan = plan.pilot_phase_batch_plans.remaining;
    need(units.length > 0 && units.every((unit) => unit.execution_phase === "remaining"), "Exact remaining scope required.");
    const remaining = await import("./avatar-pilot-remaining-execution.mjs");
    const preserved = await remaining.authenticateAcceptedPilotOpening({ acceptedOpening, episodeDir, identity });
    const runnerPath = path.join(ROOT, "scripts/tts-local-production-runner.py");
    const { referenceAssetHashes, provenance } = await inspectRuntime({ runnerPath, policy, bank: identity.narration_delivery_reference_bank });
    const workRoot = path.join(episodeDir, "pilot_narration_work"), remainingRoot = path.join(workRoot, "remaining");
    // A second process must never recreate this phase or resubmit either cohort.
    await fs.mkdir(remainingRoot);
    const inputDir = path.join(remainingRoot, "inputs"); await fs.mkdir(inputDir);
    await writeNew(path.join(inputDir, "runtime_provenance.json"), provenance);
    const gate = buildNarrationPreSynthesisGate({ plan, planPath: sample.generation_plan.path, planFileSha256: sample.generation_plan.sha256,
      identityPath, identityFileSha256, scriptPath: identity.source_script.path, scriptSha256: hash(sourceBytes), policy, planPolicy,
      sourceArtifactHashes: openingGate.bindings.source_artifact_hashes, textIr, textIrPath: sample.spoken_text_ir.path,
      textIrFileSha256: sample.spoken_text_ir.sha256, spokenTextAudit: audit, spokenTextAuditPath: sample.spoken_text_audit.path,
      spokenTextAuditFileSha256: sample.spoken_text_audit.sha256, overridesSha256: openingGate.bindings.tts_spoken_overrides_sha256,
      referenceAssetHashes, synthesisScope: { mode: "pilot_remaining_only", authorized_synthesis_unit_ids: units.map((unit) => unit.unit_id),
        preserved_unit_ids: plan.pilot_opening_unit_ids, preserved_artifacts: preserved.preservedArtifacts,
        evidence_path: acceptedOpening.approval.path, evidence_sha256: acceptedOpening.approval.sha256 } });
    const validationRef = await writeNew(path.join(inputDir, "pre_synthesis_validation.json"), gate);
    passed(gate, "Remaining gate blocked before synthesis");
    const executionArgs = { plan, units, policy, planPolicy, batchPlan, acceptedOpening, episodeDir, identity, acceptedUnitIds: plan.pilot_opening_unit_ids,
      planPath: sample.generation_plan.path, planSha256: plan.plan_sha256, planFileSha256: sample.generation_plan.sha256,
      identityPath, identityFileSha256, scriptPath: identity.source_script.path, scriptSha256: hash(sourceBytes) };
    passed(await remaining.validatePilotRemainingExecutionInputs({ ...executionArgs, preSynthesisGate: gate,
      preSynthesisGatePath: validationRef.path, preSynthesisGateFileSha256: validationRef.sha256, requireAuthorized: false }), "Remaining zero-spend validation failed");
    const authorized = authorizeNarrationPreSynthesisGate(gate);
    const gateRef = await writeNew(path.join(inputDir, "pre_synthesis_authorized.json"), authorized);
    Object.assign(executionArgs, { preSynthesisGate: authorized, preSynthesisGatePath: gateRef.path, preSynthesisGateFileSha256: gateRef.sha256 });
    passed(await remaining.validatePilotRemainingExecutionInputs(executionArgs), "Remaining execution validation failed");
    const execution = await synthesize({ ...executionArgs, route: "qwen", attempt: 1, synthesisMode: policy.synthesis_contract.mode,
      outputDir: path.join(remainingRoot, "execution"), python: PYTHON, runnerPath, invocationId: randomUUID() });
    passed(await remaining.validatePilotRemainingExecutionResults({ ...executionArgs, execution }), "Remaining results failed validation");
    const newRun = { attempt: 1, synthesis_mode: policy.synthesis_contract.mode, batch_plan_sha256: batchPlan.batch_plan_sha256,
      report_path: execution.reportPath, report_sha256: execution.reportSha256,
      cohort_events_path: execution.cohortEventsPath, cohort_events_sha256: execution.cohortEventsSha256 };
    const manifest = buildNarrationProviderOutputManifest({ provider: policy.primary.provider, modelId: policy.primary.model_id,
      modelRevision: policy.primary.model_revision, voiceId: policy.primary.voice_id, voiceSha256: policy.primary.voice_sha256,
      voiceContinuityContract: policy.primary.voice_continuity_contract, generationPlanSha256: plan.plan_sha256,
      generationPlanFileSha256: sample.generation_plan.sha256, qualityContractSha256: policy.narration_quality_contract.contract_sha256,
      providerExecution: { phase: "full_pilot", synthesis_contract: policy.synthesis_contract,
        phase_batch_plans: plan.pilot_phase_batch_plans, synthesis_runs: [...openingManifest.provider_execution.synthesis_runs, newRun], effective_concurrency: 1 },
      units: plan.units, results: [
        ...openingReport.results.map((row) => ({ ...row, audio_path: row.output_path, audio_sha256: row.output_sha256,
          runner_report_path: sample.runner_report.path, runner_report_sha256: sample.runner_report.sha256 })),
        ...execution.results.map((row) => ({ ...row, audio_path: row.output_path, audio_sha256: row.output_sha256,
          runner_report_path: execution.reportPath, runner_report_sha256: execution.reportSha256 })),
      ] });
    passed(manifest, "Full proof provider manifest invalid");
    const manifestRef = await writeNew(path.join(inputDir, "provider_output_manifest_full.json"), manifest);
    const outputNamespace = path.join(workRoot, "full_finalization");
    const finalized = await finalize(["--episode-dir", episodeDir, "--script", identity.source_script.path,
      "--plan", sample.generation_plan.path, "--manifest", manifestRef.path], { phaseContext: {
      ...sample.finalized.phase_context, phase: "full_pilot", outputNamespace, acceptedOpening,
      unitIds: plan.units.map((unit) => unit.unit_id), providerManifestFileSha256: manifestRef.sha256,
      preSynthesisGatePath: gateRef.path, preSynthesisGateFileSha256: gateRef.sha256,
    } });
    const refs = {};
    for (const [name, file] of Object.entries({ audio: finalized.final_wav, tts_report: finalized.tts_report_path,
      stitch_report: finalized.stitch_report_path, full_stream_qa: finalized.full_stream_qa_path, voice_continuity: finalized.voice_continuity_qa_path,
      unit_delivery_qa: finalized.unit_delivery_qa_path, unit_qa: finalized.unit_qa_path, subjective_manifest: finalized.subjective_review_manifest_path,
      timing_candidate: finalized.timing_candidate_path })) {
      if (file == null) continue;
      need(path.resolve(file) === file && file.startsWith(`${outputNamespace}${path.sep}`), "Full finalizer output escaped its namespace.");
      refs[name] = await binding(file);
    }
    const result = { schema: "goldflow_avatar_pilot_narration_producer_result_v1", phase: "full_pilot",
      status: "technical_finalization_returned_pending_validation_and_listening", identity_sha256: identityFileSha256,
      source_script_sha256: hash(sourceBytes), unit_ids: plan.units.map((unit) => unit.unit_id), accepted_opening: acceptedOpening,
      generation_plan: sample.generation_plan, spoken_text_ir: sample.spoken_text_ir, spoken_text_audit: sample.spoken_text_audit,
      pre_synthesis_gate: gateRef, provider_output_manifest: manifestRef,
      runner_report: { path: execution.reportPath, sha256: execution.reportSha256 },
      cohort_events: { path: execution.cohortEventsPath, sha256: execution.cohortEventsSha256 },
      finalization_artifacts: refs, finalized, runtime_provenance: provenance, production_eligible: false, publish_allowed: false, subjective_approval: null };
    await writeNew(path.join(workRoot, "narration_producer_result.json"), result);
    return result;
  };
}
export const producePilotNarration = createPilotNarrationProducer();
