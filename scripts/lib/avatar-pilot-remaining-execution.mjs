import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalQwenBatchSha256 } from "./qwen-liam-batch-contract.mjs";
import { validatePilotOpeningSampleResult } from "./avatar-pilot-opening-validation.mjs";
import {
  validatePilotOpeningExecutionResults, validatePilotPhaseExecutionInputs,
  validatePilotPhaseExecutionResults,
} from "./avatar-pilot-opening-execution.mjs";
import { narrationTtsPolicyForIdentity, validateNarrationTtsPolicy } from "./narration-tts-policy.mjs";
import { validatePilotNarrationPlanPolicy } from "./avatar-pilot-narration-plan.mjs";
import { validatePilotNarrationIdentity } from "./avatar-pilot-narration-contract.mjs";
import {
  validateNarrationSubjectiveReviewManifest, validateNarrationSubjectiveReviewDecision,
  NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
} from "./narration-subjective-review.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equal = (a, b) => a === undefined || b === undefined ? a === b
  : canonicalQwenBatchSha256(a) === canonicalQwenBatchSha256(b);
const need = (ok, message) => { if (!ok) throw new Error(`Pilot remaining execution blocked: ${message}`); };
const passed = (result, label) => need(result?.status === "passed", `${label}: ${JSON.stringify(result?.findings ?? [])}`);
const attestation = "complete_opening_listened_end_to_end";

async function read(ref, json = true) {
  need(typeof ref?.path === "string" && path.isAbsolute(ref.path)
    && /^[a-f0-9]{64}$/u.test(ref?.sha256 ?? ""), "exact local artifact binding required");
  const stat = await fs.lstat(ref.path);
  need(stat.isFile() && !stat.isSymbolicLink()
    && stat.size <= (json ? 32 : 512) * 1024 * 1024, "artifact must be a bounded regular file");
  need(await fs.realpath(ref.path) === ref.path, "artifact path must be canonical without symlink aliases");
  const bytes = await fs.readFile(ref.path);
  need(hash(bytes) === ref.sha256, `accepted opening artifact hash is stale: ${path.basename(ref.path)}`);
  return json ? JSON.parse(bytes.toString("utf8")) : bytes;
}

async function inputs(stage) {
  need(Array.isArray(stage.inputs) && stage.inputs.length > 0
    && new Set(stage.inputs.map((ref) => ref.role)).size === stage.inputs.length, "stage input roles must be unique");
  for (const ref of stage.inputs) await read(ref, false);
  return new Map(stage.inputs.map(({ role, path: filePath, sha256 }) => [role, { path: filePath, sha256 }]));
}

/** Authenticate the original produced sample and actual operator listening
 * stage. This is read-only: no decision, QA result, or accepted take is created. */
export async function authenticateAcceptedPilotOpening({ acceptedOpening, episodeDir, identity } = {}) {
  need(path.isAbsolute(episodeDir ?? ""), "episode namespace is required");
  const root = await fs.realpath(episodeDir);
  need(root === episodeDir, "episode namespace must be canonical");
  need(acceptedOpening?.sample?.path === path.join(root, "pilot_voice_sample.json")
    && acceptedOpening?.approval?.path === path.join(root, "pilot_voice_sample_approval.json"),
  "accepted opening must reference the real sample and approval stage artifacts");
  const identityPath = path.join(root, "run_identity.json");
  const identityBytes = await fs.readFile(identityPath); const identityHash = hash(identityBytes);
  const currentIdentity = JSON.parse(identityBytes.toString("utf8"));
  need(equal(identity, currentIdentity), "supplied identity differs from the current immutable identity");
  const bank = currentIdentity.narration_delivery_reference_bank;
  passed(validatePilotNarrationIdentity(currentIdentity, { deliveryBank: {
    path: bank?.path, bytes: await read(bank, false),
  } }), "canonical pilot narration identity is invalid");
  const sampleStage = await read(acceptedOpening.sample), approvalStage = await read(acceptedOpening.approval);
  for (const [stage, name] of [[sampleStage, "pilot_voice_sample"], [approvalStage, "pilot_voice_sample_approval"]]) {
    need(stage.schema === "goldflow_avatar_pilot_stage_v1" && stage.stage === name
      && stage.identity_sha256 === identityHash, "accepted opening stage identity is stale");
  }
  const sampleInputs = await inputs(sampleStage), approvalInputs = await inputs(approvalStage);
  need(equal(approvalInputs.get("upstream"), acceptedOpening.sample), "approval does not bind the exact original sample stage");
  const sample = sampleStage.payload, approval = approvalStage.payload;
  const produced = sampleInputs.get("produced_opening");
  need(produced?.path === path.join(root, "pilot_narration_work", "opening_producer_result.json")
    && equal(await read(produced), sample), "sample stage differs from the original producer receipt");
  const technical = await validatePilotOpeningSampleResult(sample, { episodeDir: root, identity: currentIdentity });
  passed(technical, "accepted opening technical evidence is invalid");
  const openingGate = await read(sample.pre_synthesis_gate);
  need(equal(sampleInputs.get("upstream"), { path: openingGate.scope.evidence_path, sha256: openingGate.scope.evidence_sha256 }),
    "sample stage does not bind its original execution authority");
  const review = approval.review;
  need(review?.approved === true && typeof review.reviewer === "string" && review.reviewer.trim()
    && typeof review.note === "string" && review.note.trim() && review.attestation === attestation,
  "remaining synthesis requires explicit complete-opening listening approval");
  const refs = sample.finalization_artifacts;
  need(equal(approvalInputs.get("subjective_manifest"), refs.subjective_manifest)
    && equal(approvalInputs.get("opening_audio"), refs.audio)
    && equal(approvalInputs.get("subjective_decision"), approval.subjective_decision),
  "approval input hashes do not bind the original audio, listening manifest and decision");
  const subjective = await read(refs.subjective_manifest), decision = await read(approval.subjective_decision);
  passed(validateNarrationSubjectiveReviewManifest(subjective), "opening listening manifest is invalid");
  need(validateNarrationSubjectiveReviewDecision(subjective, decision).status === "approved"
    && decision.status === "approved" && decision.reviewer === review.reviewer
    && decision.decisions.every((row) => row.decision === "accept" && row.note === review.note),
  "canonical listening decision is not the operator's exact approval");
  const decisionDir = path.join(root, "pilot_narration_work", "opening_finalization");
  need(path.dirname(approval.subjective_decision.path) === decisionDir,
    "original listening decision must remain in opening finalization");
  need(subjective.audio_path === refs.audio.path && subjective.audio_sha256 === refs.audio.sha256
    && subjective.samples.some((row) => row.coverage_class === "complete_opening"
      && row.start_sample === 0 && row.end_sample_exclusive === subjective.total_sample_count)
    && subjective.samples.every((row) => row.start_sample >= 0 && row.end_sample_exclusive <= subjective.total_sample_count
      && row.unit_ids.every((id) => sample.unit_ids.includes(id))), "listening attestation exceeds the exact opening");
  need(equal(approval.listening_attestation_mapping, {
    schema: "goldflow_pilot_opening_listening_attestation_mapping_v1", operator_attestation: attestation,
    canonical_attestation: NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
    manifest_sha256: refs.subjective_manifest.sha256, audio_sha256: refs.audio.sha256,
    all_samples_contained_in_opening: true, sample_ids: subjective.samples.map((row) => row.sample_id),
  }), "opening listening attestation mapping is missing or stale");
  const plan = await read(sample.generation_plan), textIr = await read(sample.spoken_text_ir), audit = await read(sample.spoken_text_audit);
  const openingReport = await read(sample.runner_report), openingManifest = await read(sample.provider_output_manifest);
  const policy = { ...validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(currentIdentity), { production: true }), status: "passed", findings: [] };
  const planPolicy = validatePilotNarrationPlanPolicy(plan, policy, {
    sourceBytes: await read(currentIdentity.source_script, false), identityFileSha256: identityHash, textIr, spokenTextAudit: audit,
  });
  const openingExecutionArgs = { plan, units: plan.units.slice(0, sample.unit_ids.length), policy, planPolicy,
    batchPlan: plan.pilot_phase_batch_plans.opening, preSynthesisGate: openingGate,
    preSynthesisGatePath: sample.pre_synthesis_gate.path, preSynthesisGateFileSha256: sample.pre_synthesis_gate.sha256,
    planPath: sample.generation_plan.path, planFileSha256: sample.generation_plan.sha256,
    identityPath, identityFileSha256: identityHash, scriptPath: currentIdentity.source_script.path,
    scriptSha256: currentIdentity.source_script.sha256, acceptedUnitIds: [],
    execution: { report: openingReport, results: openingReport.results, reportPath: sample.runner_report.path,
      reportSha256: sample.runner_report.sha256, cohortEventsPath: sample.cohort_events.path,
      cohortEventsSha256: sample.cohort_events.sha256 } };
  const executionValidation = await validatePilotOpeningExecutionResults(openingExecutionArgs);
  const tts = await read(refs.tts_report);
  const preservedArtifacts = executionValidation.units.map((unit) => {
    const selected = tts.results.find((row) => row.unit_id === unit.unit_id);
    need(selected?.synthesis_identity_sha256 === unit.synthesis_identity_sha256,
      "accepted opening selected-unit identity differs from its original execution");
    return { ...unit, selected_report_synthesis_identity_sha256: selected.synthesis_identity_sha256,
      accepted_opening: structuredClone(acceptedOpening), subjective_decision: approval.subjective_decision,
      opening_finalization_artifacts: structuredClone(refs),
      opening_provider_output_manifest: sample.provider_output_manifest,
      opening_pre_synthesis_gate: sample.pre_synthesis_gate,
      opening_generation_plan: sample.generation_plan,
      opening_spoken_text_ir: sample.spoken_text_ir, opening_spoken_text_audit: sample.spoken_text_audit };
  });
  return { status: "passed", sample, approval, sampleStage, approvalStage, openingReport, openingManifest,
    openingGate, preservedArtifacts, executionValidation, openingExecutionArgs, technical };
}

export async function validatePilotRemainingExecutionInputs(options = {}) {
  return validatePilotPhaseExecutionInputs(options, "remaining");
}

export async function validatePilotRemainingExecutionResults(options = {}) {
  return validatePilotPhaseExecutionResults(options, "remaining");
}
