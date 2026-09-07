import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalQwenBatchSha256 } from "./qwen-liam-batch-contract.mjs";
import { validateNarrationProviderOutputManifest } from "./narration-provider-adapter.mjs";
import { validateFullPilotNarrationFinalizationInputs, validatePilotFinalizationRuntimeReferences,
  validatePilotFinalizationManifestRows } from "./narration-opening-finalization.mjs";

export const NARRATION_FULL_PILOT_FINALIZATION_SCHEMA = "goldflow_narration_full_pilot_finalization_v1";
const same = (left, right) => canonicalQwenBatchSha256(left ?? null) === canonicalQwenBatchSha256(right ?? null);
const demand = (condition, message) => { if (!condition) throw new Error(`Full-pilot finalization: ${message}.`); };
async function boundJson(file, expected, label) {
  demand(path.isAbsolute(file ?? "") && /^[a-f0-9]{64}$/u.test(expected ?? ""), `${label} needs an exact local file binding`);
  const stat = await fs.lstat(file);
  demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024, `${label} must be a bounded regular JSON file`);
  const bytes = await fs.readFile(file);
  demand(createHash("sha256").update(bytes).digest("hex") === expected, `${label} hash is stale`);
  return JSON.parse(bytes.toString("utf8"));
}

/** Read-only authentic execution evidence, not QA or listening approval. The
 * complete source contract is checked independently even when called directly. */
export async function validateFullPilotFinalizationExecutionEvidence(options = {}) {
  const { phaseContext: context, episodeDir, identity, identityPath, scriptPath, plan, planPath, manifest, policy } = options;
  const inputs = await validateFullPilotNarrationFinalizationInputs(options);
  const openingIds = plan.pilot_opening_unit_ids;
  const remaining = plan.units.slice(openingIds.length);
  const phasePlans = plan.pilot_phase_batch_plans;
  const execution = manifest.provider_execution;
  demand(execution?.phase === "full_pilot" && execution.batch_plan_sha256 == null && execution.batch_plan == null
    && same(execution.phase_batch_plans, phasePlans) && same(execution.synthesis_contract, policy.synthesis_contract)
    && execution.effective_concurrency === 1, "full manifest must retain two frozen phase batch plans without a fictitious aggregate batch");
  demand(same(manifest.units?.map((row) => row.unit_id), plan.units.map((unit) => unit.unit_id)),
    "full manifest changed source order or omitted units");
  demand(validateNarrationProviderOutputManifest(manifest, plan.units, {
    generationPlanSha256: plan.plan_sha256, generationPlanFileSha256: context.generationPlanFileSha256,
    qualityContractSha256: policy.narration_quality_contract.contract_sha256, provider: policy.primary.provider,
    voiceId: policy.primary.voice_id, voiceSha256: policy.primary.voice_sha256,
  }).status === "passed", "full provider manifest contract is invalid");
  const runs = execution.synthesis_runs;
  demand(Array.isArray(runs) && runs.length === 2, "full narration requires exactly the original opening and remaining execution receipts");
  for (const [index, phase] of ["opening", "remaining"].entries()) {
    demand(runs[index]?.attempt === 1 && runs[index].synthesis_mode === policy.synthesis_contract.mode
      && runs[index].batch_plan_sha256 === phasePlans[phase].batch_plan_sha256,
    `${phase} execution changed its original attempt, mode or phase batch`);
  }
  const { authenticateAcceptedPilotOpening, validatePilotRemainingExecutionResults } = await import("./avatar-pilot-remaining-execution.mjs");
  const accepted = await authenticateAcceptedPilotOpening({ acceptedOpening: context.acceptedOpening, episodeDir, identity });
  const opening = accepted.sample;
  for (const [ref, expectedPath, expectedHash, label] of [
    [opening.generation_plan, planPath, context.generationPlanFileSha256, "full plan"],
    [opening.spoken_text_ir, context.textIrPath, context.textIrFileSha256, "text IR"],
    [opening.spoken_text_audit, context.spokenTextAuditPath, context.spokenTextAuditFileSha256, "spoken audit"],
  ]) demand(ref?.path === expectedPath && ref?.sha256 === expectedHash, `accepted opening ${label} differs from the original full-plan input`);
  demand(opening.identity_sha256 === context.identitySha256 && opening.source_script_sha256 === context.sourceScriptSha256,
    "accepted opening uses a different identity or source");
  demand(runs[0].report_path === opening.runner_report.path && runs[0].report_sha256 === opening.runner_report.sha256
    && runs[0].cohort_events_path === opening.cohort_events.path && runs[0].cohort_events_sha256 === opening.cohort_events.sha256,
  "opening execution receipt differs from the genuinely approved sample");
  demand(same(manifest.units.slice(0, openingIds.length), accepted.openingManifest.units),
    "approved opening provider units cannot be replaced, resynthesized or rebound");
  validatePilotFinalizationManifestRows(manifest.units.slice(0, openingIds.length), accepted.openingReport, runs[0]);
  const run = runs[1];
  demand(run.report_path !== runs[0].report_path && run.report_sha256 !== runs[0].report_sha256,
    "remaining narration cannot reuse an opening report as a new phase");
  const report = await boundJson(run.report_path, run.report_sha256, "remaining runner report");
  const authenticated = await validatePilotRemainingExecutionResults({
    plan, units: remaining, policy: { ...policy, status: "passed", findings: [] }, planPolicy: inputs.planPolicy,
    batchPlan: phasePlans.remaining, preSynthesisGate: inputs.gate,
    preSynthesisGatePath: context.preSynthesisGatePath, preSynthesisGateFileSha256: context.preSynthesisGateFileSha256,
    planPath, planFileSha256: context.generationPlanFileSha256, identityPath, identityFileSha256: context.identitySha256,
    scriptPath, scriptSha256: context.sourceScriptSha256, acceptedUnitIds: openingIds,
    acceptedOpening: context.acceptedOpening, episodeDir, identity,
    execution: { report, results: report.results, reportPath: run.report_path, reportSha256: run.report_sha256,
      cohortEventsPath: run.cohort_events_path, cohortEventsSha256: run.cohort_events_sha256 },
  });
  demand(authenticated.status === "passed", "remaining execution evidence did not pass");
  validatePilotFinalizationManifestRows(manifest.units.slice(openingIds.length), report, run);
  return { ...inputs, phaseBatchPlans: structuredClone(phasePlans), synthesisRuns: structuredClone(runs), scope: {
    schema: NARRATION_FULL_PILOT_FINALIZATION_SCHEMA, phase: "full_pilot", complete_episode: true,
    production_eligible: false, unit_ids: plan.units.map((unit) => unit.unit_id), full_plan_unit_count: plan.units.length,
    preserved_unit_ids: [...openingIds], newly_synthesized_unit_ids: remaining.map((unit) => unit.unit_id),
    source_script_sha256: context.sourceScriptSha256, run_identity_sha256: context.identitySha256,
    generation_plan_sha256: plan.plan_sha256, generation_plan_file_sha256: context.generationPlanFileSha256,
    provider_manifest_file_sha256: context.providerManifestFileSha256,
    pre_synthesis_gate_file_sha256: context.preSynthesisGateFileSha256,
    phase_batch_plan_sha256: { opening: phasePlans.opening.batch_plan_sha256, remaining: phasePlans.remaining.batch_plan_sha256 },
    accepted_opening: structuredClone(context.acceptedOpening),
    opening_reuse_contract: "original_raw_unit_wav_and_synthesis_identity_v1",
    subjective_review_status: "pending",
  } };
}

/** Gate all effects before invoking the existing full-stream canonical QA path.
 * The raw opening units remain immutable; mastering the complete program is a
 * new operation and does not promise equality to the separately mastered sample. */
export async function prepareFullPilotNarrationFinalization(options = {}) {
  const inputs = await validateFullPilotFinalizationExecutionEvidence(options);
  await validatePilotFinalizationRuntimeReferences({ policy: options.policy, identity: options.identity, gate: inputs.gate });
  return inputs;
}
