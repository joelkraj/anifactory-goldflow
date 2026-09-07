import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { sha256File } from "./file-hash.mjs";
import { canonicalNarrationPlanSha256, narrationPreSynthesisGateSha256 } from "./narration-pre-synthesis-gate.mjs";
import { narrationTokensWithSpans, validateNarrationTextIr } from "./narration-text-ir.mjs";
import { ttsSpokenTextAuditMatches } from "./tts-spoken-text-audit.mjs";
import { canonicalQwenBatchSha256, qwenBatchBindingByUnit, validateQwenLiamBatchPlan } from "./qwen-liam-batch-contract.mjs";
import { validatePilotOpeningExecutionResults } from "./avatar-pilot-opening-execution.mjs";
import { validatePilotNarrationPlanPolicy } from "./avatar-pilot-narration-plan.mjs";
import { validatePilotNarrationIdentity } from "./avatar-pilot-narration-contract.mjs";
import { narrationTtsPolicyForIdentity, validateNarrationTtsPolicy } from "./narration-tts-policy.mjs";

export const NARRATION_OPENING_FINALIZATION_SCHEMA = "goldflow_narration_opening_finalization_v1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (left, right) => canonicalQwenBatchSha256(left ?? null) === canonicalQwenBatchSha256(right ?? null);
const demand = (condition, message) => { if (!condition) throw new Error(`Opening finalization: ${message}.`); };
const validHash = (value) => /^[a-f0-9]{64}$/u.test(String(value ?? ""));

async function boundFile(filePath, expected, label, json = true) {
  demand(path.isAbsolute(filePath ?? "") && !filePath.includes("\0") && validHash(expected), `${label} needs an exact local path and SHA-256`);
  const stat = await fs.lstat(filePath);
  demand(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular local file`);
  demand(await sha256File(filePath) === expected, `${label} hash is stale`);
  if (!json) return null;
  demand(stat.size <= 16 * 1024 * 1024, `${label} exceeds the bounded JSON size`);
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

/** Read-only path check. The caller creates this fresh namespace only after all validation. */
export async function validateOpeningFinalizationNamespace(episodeDir, outputNamespace) {
  demand(path.isAbsolute(outputNamespace ?? "") && !outputNamespace.includes("\0"), "an explicit absolute output namespace is required");
  const episode = path.resolve(episodeDir);
  const output = path.resolve(outputNamespace);
  const relative = path.relative(episode, output);
  demand(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), "output namespace must be a strict episode child");
  demand((await fs.stat(episode)).isDirectory(), "episode directory must already exist");
  demand((await fs.stat(path.dirname(output))).isDirectory(), "output namespace parent must already exist");
  let current = episode;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    demand(!stat.isSymbolicLink() && stat.isDirectory(), "output namespace cannot traverse symlinks or files");
    demand(current !== output, "output namespace must be new; existing opening evidence is immutable");
  }
  return output;
}

export function validateOpeningFinalizationFlags(flags = {}) {
  for (const flag of ["workflow-bypass", "accept-asr-delivery-blockers", "accept-review-warnings", "skip-subjective-review",
    "delivery-waiver-reason", "manual-review-evidence", "listen-decision", "output-dir", "checkpoint"]) {
    demand(!Object.hasOwn(flags, flag), `--${flag} is unavailable for the initial opening phase`);
  }
}

/** Authenticates only existing local artifacts; never imports a model, writes or synthesizes. */
async function validatePilotNarrationFinalizationInputs({ phaseContext: context, episodeDir, identityPath, identity,
  scriptPath, planPath, plan, manifestPath, manifest, policy, flags = {} } = {}, phase) {
  demand(context?.phase === phase, phase === "opening"
    ? "only the opening phase is implemented by this helper; use the guarded full-pilot finalizer"
    : "the exact full_pilot phase is required");
  validateOpeningFinalizationFlags(flags);
  demand(phase === "full_pilot" || context.reviewContinuation == null,
    "review continuation is unavailable for the initial opening phase");
  if (context.reviewContinuation != null) demand(flags.master == null
    || /^(?:1|true|yes|on)$/iu.test(String(flags.master)), "review continuation cannot disable canonical mastering");
  demand(identity?.media_workflow === "avatar_footage_pilot_v1" && identity.run_intent === "proof"
    && identity.production_eligible === false && identity.publish_allowed === false, "a private pilot proof identity is required");
  const outputNamespace = await validateOpeningFinalizationNamespace(episodeDir, context.outputNamespace);
  if (phase === "full_pilot") demand(outputNamespace === path.join(path.resolve(episodeDir), "pilot_narration_work",
    context.reviewContinuation == null ? "full_finalization" : "full_finalization_reviewed"),
    "full-pilot output must use its separate full_finalization namespace");
  const [actualIdentity, actualPlan, actualManifest, gate, textIr, audit] = await Promise.all([
    boundFile(identityPath, context.identitySha256, "run identity"),
    boundFile(planPath, context.generationPlanFileSha256, "full generation plan"),
    boundFile(manifestPath, context.providerManifestFileSha256, "provider manifest"),
    boundFile(context.preSynthesisGatePath, context.preSynthesisGateFileSha256, "pre-synthesis gate"),
    boundFile(context.textIrPath, context.textIrFileSha256, "text IR"),
    boundFile(context.spokenTextAuditPath, context.spokenTextAuditFileSha256, "spoken audit"),
    boundFile(scriptPath, context.sourceScriptSha256, "approved source", false),
  ]);
  demand(same(identity, actualIdentity) && same(plan, actualPlan) && same(manifest, actualManifest), "parsed inputs differ from their verified file bytes");
  demand(identity.source_script?.path === scriptPath && identity.source_script?.sha256 === context.sourceScriptSha256,
    "approved source differs from the immutable pilot identity");
  const bankLock = identity.narration_delivery_reference_bank;
  await boundFile(bankLock?.path, bankLock?.sha256, "owned delivery bank", false);
  demand(validatePilotNarrationIdentity(identity, { deliveryBank: {
    path: bankLock.path, bytes: await fs.readFile(bankLock.path), sha256: bankLock.sha256,
  } }).status === "passed", "canonical pilot narration identity is invalid");
  demand(same(policy, validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), { production: true })), "supplied policy differs from the canonical identity");
  demand(plan.schema === "goldflow_tts_generation_plan_v2" && plan.status === "passed"
    && plan.plan_sha256 === canonicalNarrationPlanSha256(plan)
    && plan.source_script_hash === context.sourceScriptSha256
    && plan.source_hashes?.script_clean_sha256 === context.sourceScriptSha256
    && plan.source_hashes?.run_identity_sha256 === context.identitySha256, "full source/plan identity is stale");
  const allUnits = plan.units;
  const ids = context.unitIds;
  const openingIds = plan.pilot_opening_unit_ids;
  demand(Array.isArray(allUnits) && allUnits.length > 1 && Array.isArray(openingIds)
    && openingIds.length > 0 && openingIds.length < allUnits.length
    && new Set(openingIds).size === openingIds.length
    && same(openingIds, allUnits.slice(0, openingIds.length).map((unit) => unit.unit_id)), "scope must be the exact nonempty planned opening prefix");
  demand(Array.isArray(ids) && same(ids, phase === "opening" ? openingIds : allUnits.map((unit) => unit.unit_id)),
    phase === "opening" ? "scope must be the exact nonempty planned opening prefix" : "full-pilot scope must contain every original unit in source order");
  demand(allUnits.every((unit, index) => unit.order_index === index
    && unit.execution_phase === (index < openingIds.length ? "opening" : "remaining")), "source order or immutable execution phase is invalid");
  const units = phase === "opening" ? allUnits.slice(0, openingIds.length) : allUnits;
  const script = await fs.readFile(scriptPath, "utf8");
  const planPolicy = validatePilotNarrationPlanPolicy(plan, { ...policy, status: "passed", findings: [] }, {
    sourceBytes: Buffer.from(script), identityFileSha256: context.identitySha256, textIr, spokenTextAudit: audit,
  });
  demand(planPolicy.status === "passed", "canonical full source-to-spoken plan validation failed");
  const sourceText = allUnits.flatMap((unit) => unit.source_unit_refs ?? []).map((ref) => ref.source_text ?? "").join(" ");
  const tokens = (text) => narrationTokensWithSpans(text).map((row) => row.normalized);
  demand(tokens(script).length > 0 && same(tokens(script), tokens(sourceText)), "complete source-component coverage differs from the approved script");
  demand(validateNarrationTextIr(textIr, allUnits, { sourceScriptSha256: context.sourceScriptSha256,
    generationPlanSha256: plan.plan_sha256 }).status === "passed", "full text IR lineage is invalid");
  demand(ttsSpokenTextAuditMatches({ audit, plan, sourceScriptSha256: context.sourceScriptSha256,
    overridesSha256: gate.bindings?.tts_spoken_overrides_sha256 ?? null }) && audit.blocker_count === 0, "spoken audit is invalid");
  demand(gate.status === "passed" && gate.gate_sha256 === narrationPreSynthesisGateSha256(gate)
    && gate.model_load_performed === true && gate.synthesis_invoked === true
    && gate.authorization?.schema === "goldflow_narration_synthesis_authorization_v1"
    && validHash(gate.authorization?.validation_gate_sha256)
    && same(gate.scope?.authorized_synthesis_unit_ids, phase === "opening" ? openingIds : ids.slice(openingIds.length))
    && same(gate.scope?.preserved_unit_ids, phase === "opening" ? [] : openingIds),
  phase === "opening" ? "an exact authorized opening pre-synthesis gate is required" : "an exact authorized remaining-only pre-synthesis gate is required");
  for (const [field, expected] of Object.entries({ run_identity_path: identityPath, run_identity_file_sha256: context.identitySha256,
    script_path: scriptPath, script_sha256: context.sourceScriptSha256,
    narration_generation_plan_path: planPath, narration_generation_plan_sha256: plan.plan_sha256,
    narration_generation_plan_file_sha256: context.generationPlanFileSha256,
    narration_text_ir_path: context.textIrPath, narration_text_ir_file_sha256: context.textIrFileSha256,
    tts_spoken_text_audit_path: context.spokenTextAuditPath, tts_spoken_text_audit_file_sha256: context.spokenTextAuditFileSha256 })) {
    demand(gate.bindings?.[field] === expected, `pre-synthesis ${field} is stale`);
  }
  const upstreamHashes = gate.bindings?.source_artifact_hashes ?? {};
  const upstreamFields = Object.keys(upstreamHashes).filter((field) => !["script_clean_sha256", "run_identity_sha256"].includes(field));
  demand(same(Object.keys(context.sourceArtifacts ?? {}).sort(), upstreamFields.sort()), "exact upstream source-artifact file bindings are required");
  for (const field of upstreamFields) {
    const ref = context.sourceArtifacts[field];
    demand(ref?.sha256 === upstreamHashes[field] && ref.sha256 === plan.source_hashes?.[field], `upstream ${field} is stale`);
    await boundFile(ref.path, ref.sha256, `upstream ${field}`, false);
  }
  for (const field of ["provider", "model_id", "model_revision", "voice_id", "voice_sha256", "voice_continuity_contract", "reference_audio_sha256", "reference_text_sha256"]) {
    demand(gate.contract?.[field] === policy.primary[field], `gate ${field} differs from the owned identity`);
  }
  demand(same(gate.contract?.synthesis_contract, policy.synthesis_contract), "gate synthesis contract differs from the identity");
  return { outputNamespace, units, gate, planPolicy };
}

export const validateOpeningNarrationFinalizationInputs = (options = {}) => validatePilotNarrationFinalizationInputs(options, "opening");
export const validateFullPilotNarrationFinalizationInputs = (options = {}) => validatePilotNarrationFinalizationInputs(options, "full_pilot");

export async function validatePilotFinalizationRuntimeReferences({ policy, identity, gate }) {
  await boundFile(policy.primary.reference_audio_path, policy.primary.reference_audio_sha256, "owned voice reference", false);
  demand(sha256(policy.primary.reference_text) === policy.primary.reference_text_sha256, "owned reference transcript is stale");
  const requiredReferences = {
    reference_audio: [policy.primary.reference_audio_path, policy.primary.reference_audio_sha256],
    reference_manifest: [policy.primary.reference_manifest_path, policy.primary.reference_manifest_sha256],
    reference_metadata: [policy.primary.reference_metadata_path, policy.primary.reference_metadata_sha256],
    speaker_similarity_model: [policy.primary.speaker_similarity_model_path, policy.primary.speaker_similarity_model_sha256],
    speaker_similarity_calibration: [policy.primary.speaker_similarity_calibration_path, policy.primary.speaker_similarity_calibration_sha256],
    delivery_bank: [identity.narration_delivery_reference_bank.path, identity.narration_delivery_reference_bank.sha256],
  };
  for (const [label, [refPath, refHash]] of Object.entries(requiredReferences)) {
    const ref = gate.bindings?.reference_asset_hashes?.[label];
    demand(ref?.expected === refHash && ref?.actual === refHash && ref?.path === refPath, `reference ${label} did not pass the synthesis gate`);
    await boundFile(ref.path, ref.expected, `reference ${label}`, false);
  }
  demand(gate.bindings?.reference_asset_hashes?.reference_text?.path === null
    && gate.bindings.reference_asset_hashes.reference_text.expected === policy.primary.reference_text_sha256
    && gate.bindings.reference_asset_hashes.reference_text.actual === policy.primary.reference_text_sha256,
  "reference text did not pass the synthesis gate");
}

export function validatePilotFinalizationManifestRows(outputs, report, run) {
  demand(Array.isArray(outputs) && Array.isArray(report.results) && outputs.length === report.results.length,
    "provider manifest differs from the authenticated original runner count");
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index];
    const result = report.results[index];
    demand(output.unit_id === result.unit_id && output.audio_path === result.output_path && output.audio_sha256 === result.output_sha256
      && output.duration_sec === result.duration_sec && same(output.synthesis_identity, result.synthesis_identity)
      && output.synthesis_identity_sha256 === result.synthesis_identity_sha256
      && output.runner_report_path === run.report_path && output.runner_report_sha256 === run.report_sha256,
    "provider manifest differs from the authenticated original runner output");
    for (const field of ["batch_plan_sha256", "cohort_id", "cohort_sha256", "generated_token_count",
      "effective_token_limit", "token_limit_reached", "attempt", "synthesis_mode"]) {
      demand(output[field] === result[field], `manifest ${field} differs from the original execution`);
    }
  }
}

export async function prepareOpeningNarrationFinalization(options = {}) {
  const { phaseContext: context, policy, plan, manifest, planPath, identityPath, scriptPath, identity } = options;
  const { outputNamespace, units, gate, planPolicy } = await validateOpeningNarrationFinalizationInputs(options);
  const ids = context.unitIds;
  await validatePilotFinalizationRuntimeReferences({ policy, identity, gate });
  const batchPlan = plan.pilot_phase_batch_plans?.opening;
  demand(validateQwenLiamBatchPlan(batchPlan, units, policy.synthesis_contract).status === "passed", "opening batch/cohort plan is stale");
  const bindings = qwenBatchBindingByUnit(batchPlan);
  demand(units.every((unit) => same(unit.synthesis_cohort, bindings.get(unit.unit_id))), "plan unit cohort binding was changed");
  demand(same(manifest.units?.map((row) => row.unit_id), ids)
    && manifest.provider_execution?.batch_plan_sha256 === batchPlan.batch_plan_sha256, "manifest scope or execution batch is stale");
  const runs = manifest.provider_execution?.synthesis_runs;
  demand(Array.isArray(runs) && runs.length === 1 && runs[0].attempt === 1, "opening requires one original runner receipt, not inferred repair history");
  const run = runs[0];
  const report = await boundFile(run.report_path, run.report_sha256, "opening runner report");
  const authenticated = await validatePilotOpeningExecutionResults({
    plan, units, policy: { ...policy, status: "passed", findings: [] }, planPolicy, batchPlan,
    preSynthesisGate: gate, preSynthesisGatePath: context.preSynthesisGatePath,
    preSynthesisGateFileSha256: context.preSynthesisGateFileSha256,
    planPath, planFileSha256: context.generationPlanFileSha256, identityPath, identityFileSha256: context.identitySha256,
    scriptPath, scriptSha256: context.sourceScriptSha256, acceptedUnitIds: [],
    execution: { reportPath: run.report_path, reportSha256: run.report_sha256, report, results: report.results,
      cohortEventsPath: run.cohort_events_path, cohortEventsSha256: run.cohort_events_sha256 },
  });
  demand(authenticated.status === "passed", "original opening execution evidence did not pass");
  validatePilotFinalizationManifestRows(manifest.units, report, run);
  return { outputNamespace, units, batchPlan, synthesisRuns: structuredClone(runs), scope: {
    schema: NARRATION_OPENING_FINALIZATION_SCHEMA, phase: "opening", complete_episode: false,
    production_eligible: false, unit_ids: [...ids], full_plan_unit_count: plan.units.length,
    source_script_sha256: context.sourceScriptSha256, run_identity_sha256: context.identitySha256,
    generation_plan_sha256: plan.plan_sha256, generation_plan_file_sha256: context.generationPlanFileSha256,
    provider_manifest_file_sha256: context.providerManifestFileSha256,
    pre_synthesis_gate_file_sha256: context.preSynthesisGateFileSha256,
    batch_plan_sha256: batchPlan.batch_plan_sha256, subjective_review_status: "pending",
  } };
}
