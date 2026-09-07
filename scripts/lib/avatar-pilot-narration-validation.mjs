import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { narrationTtsPolicyForIdentity, validateNarrationTtsPolicy } from "./narration-tts-policy.mjs";
import { validatePilotNarrationPlanPolicy } from "./avatar-pilot-narration-plan.mjs";
import { validateNarrationProviderOutputManifest } from "./narration-provider-adapter.mjs";
import { canonicalQwenBatchSha256 } from "./qwen-liam-batch-contract.mjs";
import { validatePilotNarrationTechnicalReports } from "./avatar-pilot-opening-validation.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => canonicalQwenBatchSha256(a) === canonicalQwenBatchSha256(b);
const need = (ok, message) => { if (!ok) throw new Error(message); };
const passed = (row, label) => need(row?.status === "passed", `${label}: ${JSON.stringify(row?.findings ?? [])}`);
async function bound(ref, json = true) {
  need(path.isAbsolute(ref?.path ?? "") && /^[a-f0-9]{64}$/u.test(ref?.sha256 ?? ""), "Full narration requires an exact local artifact binding.");
  const stat = await fs.lstat(ref.path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= (json ? 32 : 512) * 1024 * 1024, "Full narration input must be a bounded regular file.");
  const bytes = await fs.readFile(ref.path);
  need(hash(bytes) === ref.sha256, "Full narration artifact hash mismatch.");
  return json ? JSON.parse(bytes.toString("utf8")) : bytes;
}

/** Authenticates a produced full proof, never an arbitrary audio import. The
 * original opening raw units are reused, while the complete mastered stream is
 * new and requires a new genuine listening decision before timing promotion. */
export async function validatePilotNarrationResult(result, { episodeDir, identity } = {}) {
  const findings = [];
  try {
    need(result?.schema === "goldflow_avatar_pilot_narration_producer_result_v1" && result.phase === "full_pilot"
      && result.production_eligible === false && result.publish_allowed === false && result.subjective_approval === null,
    "Full pilot narration must remain private and pending full listening.");
    const identityPath = path.join(episodeDir, "run_identity.json");
    const identityHash = hash(await fs.readFile(identityPath));
    const actualIdentity = await bound({ path: identityPath, sha256: identityHash });
    need(same(identity, actualIdentity) && result.identity_sha256 === identityHash
      && result.source_script_sha256 === identity.source_script.sha256, "Full narration identity/source changed.");
    const sourceBytes = await bound(identity.source_script, false);
    const plan = await bound(result.generation_plan), ir = await bound(result.spoken_text_ir), audit = await bound(result.spoken_text_audit);
    const gate = await bound(result.pre_synthesis_gate), manifest = await bound(result.provider_output_manifest), report = await bound(result.runner_report);
    const policy = { ...validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), { production: true }), status: "passed", findings: [] };
    const planPolicy = validatePilotNarrationPlanPolicy(plan, policy, { sourceBytes, identityFileSha256: identityHash, textIr: ir, spokenTextAudit: audit });
    passed(planPolicy, "Full source/request lineage invalid");
    need(same(result.unit_ids, plan.units.map((unit) => unit.unit_id)), "Full narration must include every immutable source unit in order.");
    const { authenticateAcceptedPilotOpening, validatePilotRemainingExecutionResults } = await import("./avatar-pilot-remaining-execution.mjs");
    const accepted = await authenticateAcceptedPilotOpening({ acceptedOpening: result.accepted_opening, episodeDir, identity });
    const opening = accepted.sample;
    for (const key of ["generation_plan", "spoken_text_ir", "spoken_text_audit"]) {
      need(same(result[key], opening[key]), `Full narration changed the accepted opening's frozen ${key}.`);
    }
    need(result.source_script_sha256 === opening.source_script_sha256 && result.identity_sha256 === opening.identity_sha256,
      "Accepted opening belongs to another script or identity.");
    const openingManifest = await bound(opening.provider_output_manifest);
    const remainingUnits = plan.units.slice(plan.pilot_opening_unit_ids.length);
    const execution = { report, results: report.results, reportPath: result.runner_report.path,
      reportSha256: result.runner_report.sha256, cohortEventsPath: result.cohort_events.path, cohortEventsSha256: result.cohort_events.sha256 };
    passed(await validatePilotRemainingExecutionResults({ plan, units: remainingUnits, policy, planPolicy,
      batchPlan: plan.pilot_phase_batch_plans.remaining, acceptedOpening: result.accepted_opening, episodeDir, identity,
      acceptedUnitIds: [...plan.pilot_opening_unit_ids],
      preSynthesisGate: gate, preSynthesisGatePath: result.pre_synthesis_gate.path, preSynthesisGateFileSha256: result.pre_synthesis_gate.sha256,
      planPath: result.generation_plan.path, planFileSha256: result.generation_plan.sha256,
      identityPath, identityFileSha256: identityHash, scriptPath: identity.source_script.path, scriptSha256: result.source_script_sha256,
      execution }), "Remaining execution provenance invalid");
    passed(validateNarrationProviderOutputManifest(manifest, plan.units, {
      generationPlanSha256: plan.plan_sha256, generationPlanFileSha256: result.generation_plan.sha256,
      qualityContractSha256: policy.narration_quality_contract.contract_sha256, provider: policy.primary.provider,
      voiceId: policy.primary.voice_id, voiceSha256: policy.primary.voice_sha256,
    }), "Full provider manifest invalid");
    const pe = manifest.provider_execution;
    need(pe?.phase === "full_pilot" && pe.effective_concurrency === 1
      && same(pe.synthesis_contract, policy.synthesis_contract) && same(pe.phase_batch_plans, plan.pilot_phase_batch_plans)
      && !Object.hasOwn(pe, "batch_plan_sha256") && Array.isArray(pe.synthesis_runs) && pe.synthesis_runs.length === 2,
    "Full narration must retain two original phase runs, never a rebatched global synthesis.");
    need(same(pe.synthesis_runs[0], openingManifest.provider_execution.synthesis_runs[0]), "Original accepted opening run was replaced.");
    const remainingRun = pe.synthesis_runs[1];
    need(remainingRun.attempt === 1 && remainingRun.synthesis_mode === policy.synthesis_contract.mode
      && remainingRun.batch_plan_sha256 === plan.pilot_phase_batch_plans.remaining.batch_plan_sha256
      && remainingRun.report_path === result.runner_report.path && remainingRun.report_sha256 === result.runner_report.sha256
      && remainingRun.cohort_events_path === result.cohort_events.path && remainingRun.cohort_events_sha256 === result.cohort_events.sha256,
    "Remaining runner receipt differs from the complete manifest.");
    const unitResults = [...accepted.openingReport.results, ...report.results];
    need(unitResults.length === plan.units.length, "Complete narration result count differs from the frozen plan.");
    for (const [index, unit] of plan.units.entries()) {
      const row = manifest.units[index], original = unitResults[index];
      need(row.unit_id === unit.unit_id && original.unit_id === unit.unit_id
        && row.audio_path === original.output_path && row.audio_sha256 === original.output_sha256
        && row.spoken_text_sha256 === unit.spoken_text_sha256
        && row.synthesis_identity_sha256 === original.synthesis_identity_sha256
        && same(row.synthesis_identity, original.synthesis_identity), "A full narration unit changed its actual raw WAV or execution identity.");
      if (index < plan.pilot_opening_unit_ids.length) {
        need(same(row, openingManifest.units[index]), "Accepted opening unit must retain its original raw audio, cohort, seed and provider receipt.");
      }
    }
    const tts = await bound(result.finalization_artifacts?.tts_report);
    need(same(tts.synthesis_runs, pe.synthesis_runs) && tts.batch_plan_sha256 === null
      && same(tts.synthesis_contract, policy.synthesis_contract) && tts.effective_concurrency === 1,
    "Full TTS report must retain the original two-phase execution ledger.");
    const technical = await validatePilotNarrationTechnicalReports({ result, episodeDir, identity, identityHash,
      plan, units: plan.units, policy, unitResults, phase: "full_pilot" });
    passed(technical, "Complete pilot technical QA invalid");
    return { ...technical, accepted_opening: structuredClone(result.accepted_opening),
      preserved_unit_ids: [...plan.pilot_opening_unit_ids], newly_synthesized_unit_ids: remainingUnits.map((unit) => unit.unit_id),
      production_eligible: false, publish_allowed: false, subjective_review_status: "pending", official_full_narration_timing: false };
  } catch (error) { findings.push({ code: error.message }); }
  return { status: "blocked", findings, subjective_review_status: "pending", official_full_narration_timing: false };
}
