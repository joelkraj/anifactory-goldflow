import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildPilotNarrationPlans } from "./avatar-pilot-narration-plan.mjs";
import { buildNarrationPreSynthesisGate, authorizeNarrationPreSynthesisGate, narrationPreSynthesisGateSha256 } from "./narration-pre-synthesis-gate.mjs";
import { buildNarrationProviderOutputManifest } from "./narration-provider-adapter.mjs";
import { validatePilotOpeningExecutionInputs, validatePilotOpeningExecutionResults } from "./avatar-pilot-opening-execution.mjs";
import { pilotArtifactContainsPrivateData } from "./avatar-pilot-artifacts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-kokoro-mlx-audio-0.4.6/bin/python";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const need = (ok, message) => { if (!ok) throw new Error(message); };
const passed = (result, label) => need(result?.status === "passed", `${label}: ${JSON.stringify(result?.findings ?? [])}`);
const execute = promisify(execFile);

export async function inspectOpeningRuntime({ runnerPath, policy, bank }) {
  const git = async (...args) => (await execute("git", args, { cwd: ROOT, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim();
  need(!(await git("status", "--porcelain")), "Opening synthesis requires the tested adapter to be committed in a clean worktree.");
  const referenceAssetHashes = {};
  for (const [label, file, expected] of [
    ["reference_audio", policy.primary.reference_audio_path, policy.primary.reference_audio_sha256],
    ["reference_manifest", policy.primary.reference_manifest_path, policy.primary.reference_manifest_sha256],
    ["reference_metadata", policy.primary.reference_metadata_path, policy.primary.reference_metadata_sha256],
    ["speaker_similarity_model", policy.primary.speaker_similarity_model_path, policy.primary.speaker_similarity_model_sha256],
    ["speaker_similarity_calibration", policy.primary.speaker_similarity_calibration_path, policy.primary.speaker_similarity_calibration_sha256],
    ["delivery_bank", bank.path, bank.sha256],
  ]) referenceAssetHashes[label] = { path: file, expected, actual: hash(await readBound({ path: file, sha256: expected })) };
  referenceAssetHashes.reference_text = { path: null, expected: policy.primary.reference_text_sha256, actual: hash(policy.primary.reference_text) };
  for (const file of [PYTHON, runnerPath]) need((await fs.stat(file)).isFile(), "Pinned local runner runtime missing.");
  return { referenceAssetHashes, provenance: { git_commit: await git("rev-parse", "HEAD"), git_branch: await git("branch", "--show-current"),
    worktree_clean: true, python_path: PYTHON, runner: await binding(runnerPath) } };
}

export async function readBound(ref) {
  need(path.isAbsolute(ref?.path ?? "") && /^[a-f0-9]{64}$/.test(ref?.sha256 ?? ""), "Exact absolute file binding required.");
  const stat = await fs.lstat(ref.path);
  need(stat.isFile() && !stat.isSymbolicLink(), "Bound input must be a regular local file.");
  const data = await fs.readFile(ref.path);
  need(hash(data) === ref.sha256, "Bound input hash changed.");
  return data;
}
export async function binding(file) { return { path: file, sha256: hash(await fs.readFile(file)) }; }
export async function writeNew(file, value) {
  // The canonical authorization is a hash/date receipt, not an HTTP credential.
  // Permit only its exact shape, while scanning every value and all other keys.
  let scanned = value;
  if (value?.schema === "goldflow_narration_pre_synthesis_gate_v2" && value.authorization) {
    const auth = value.authorization;
    need(value.gate_sha256 === narrationPreSynthesisGateSha256(value)
      && JSON.stringify(Object.keys(auth).sort()) === JSON.stringify(["authorized_at", "schema", "timing", "validation_gate_sha256"])
      && auth.schema === "goldflow_narration_synthesis_authorization_v1"
      && /^[a-f0-9]{64}$/u.test(auth.validation_gate_sha256)
      && Number.isFinite(Date.parse(auth.authorized_at))
      && auth.timing === "atomically_persisted_immediately_before_helper_import_and_runner_execution", "Malformed canonical synthesis authorization.");
    const { authorization, ...rest } = value;
    scanned = { ...rest, canonical_synthesis_authorization_receipt: authorization };
  }
  need(!pilotArtifactContainsPrivateData(scanned), "Private credentials cannot enter a pilot narration artifact.");
  await fs.writeFile(file, bytes(value), { flag: "wx", mode: 0o600 });
  return binding(file);
}

/** Dependency seam for provider-free orchestration fixtures, never a CLI flag. */
export function createPilotOpeningProducer({
  getStatus = async (episodeDir) => (await import("./avatar-pilot-workflow.mjs")).pilotStatus(episodeDir),
  synthesize = async (args) => (await import("../narration-tts-episode.mjs")).runSynthesis(args),
  finalize = async (...args) => (await import("../narration-provider-output-finalize.mjs")).finalizeNarrationProviderOutput(...args),
  inspectRuntime = inspectOpeningRuntime,
} = {}) {
return async function produceOpening({ episodeDir, editorialPath }) {
  episodeDir = path.resolve(episodeDir);
  editorialPath = path.resolve(editorialPath);
  const current = await getStatus(episodeDir);
  need(current.current_stage === "pilot_voice_sample" && current.allowed_command_stages.includes("pilot_voice_sample"), "The pilot opening stage is not authorized by run status.");
  const identity = current.identity;
  need(identity.pilot_narration_contract && identity.proof_scope.duration_frames === 2700, "Canonical private 90-second identity required.");
  const identityPath = path.join(episodeDir, "run_identity.json");
  const identityBytes = await fs.readFile(identityPath);
  const identityFileSha256 = hash(identityBytes);
  const sourceBytes = await readBound(identity.source_script);
  const editorialBytes = await fs.readFile(editorialPath);
  need(editorialBytes.length <= 1024 * 1024, "Editorial input exceeds bounded pilot scope.");
  const editorial = JSON.parse(editorialBytes);
  need(editorial.schema === "goldflow_avatar_pilot_narration_editorial_v1" && editorial.source_script_sha256 === hash(sourceBytes), "Pilot editorial source is stale.");
  need(!pilotArtifactContainsPrivateData(editorial), "Editorial input contains private credentials.");
  need(editorial.opening_unit_count === 2, "This initial pilot route permits exactly two complete opening units.");
  for (const [field, filename] of [["script_approval", "pilot_script_approval.json"], ["evidence_approval", "pilot_evidence.json"]]) {
    need(editorial[field]?.path === path.join(episodeDir, filename), "Editorial approval must belong to this proof.");
    await readBound(editorial[field]);
  }
  const speakability = editorial.targeted_speakability;
  need(speakability?.source_text_unchanged === true && Array.isArray(speakability.spoken_overrides) && speakability.spoken_overrides.length === 0 && typeof speakability.reviewer === "string", "Initial opening requires a targeted, unchanged-source speakability review.");
  const bank = identity.narration_delivery_reference_bank;
  const bankBytes = await readBound(bank);
  const overrides = { schema: "goldflow_tts_spoken_overrides_v1", source_script_sha256: hash(sourceBytes), overrides: [], note: "No spoken-text substitutions selected for this initial opening." };
  const sourceArtifactHashes = {
    script_clean_sha256: hash(sourceBytes), run_identity_sha256: identityFileSha256,
    script_speakability_report_sha256: hash(editorialBytes), tts_spoken_overrides_sha256: hash(bytes(overrides)),
    pilot_script_approval_sha256: editorial.script_approval.sha256, pilot_evidence_approval_sha256: editorial.evidence_approval.sha256,
  };
  const built = buildPilotNarrationPlans({ sourceBytes, sourceScriptSha256: hash(sourceBytes), identity, identityBytes, identityFileSha256,
    deliveryBank: { path: bank.path, bytes: bankBytes }, editorialUnits: editorial.editorial_units,
    openingUnitCount: editorial.opening_unit_count, sourceArtifactHashes });
  passed(built.policy, "Narrator identity blocked");
  passed(built.planPolicy, "Pilot narration plan blocked");
  const { plan, textIr, spokenTextAudit, policy } = built;
  const opening = built.phases.opening;
  need(opening.units.length === 2 && opening.word_count <= 60, "Opening exceeds the bounded two-unit, sixty-word synthesis scope.");
  const runnerPath = path.join(ROOT, "scripts/tts-local-production-runner.py");
  const { referenceAssetHashes, provenance: runtimeProvenance } = await inspectRuntime({ runnerPath, policy, bank });
  // Exclusive creation is a durable cross-process no-resubmission barrier. An
  // interrupted or failed invocation requires explicit scoped recovery work.
  const workRoot = path.join(episodeDir, "pilot_narration_work");
  await fs.mkdir(workRoot);
  const inputDir = path.join(workRoot, "inputs");
  await fs.mkdir(inputDir);
  const planRef = await writeNew(path.join(inputDir, "narration_generation_plan.json"), plan);
  const irRef = await writeNew(path.join(inputDir, "narration_text_ir.json"), textIr);
  const auditRef = await writeNew(path.join(inputDir, "tts_spoken_text_audit.json"), spokenTextAudit);
  const overridesRef = await writeNew(path.join(inputDir, "tts_spoken_overrides.json"), overrides);
  await fs.writeFile(path.join(inputDir, "editorial_input.json"), editorialBytes, { flag: "wx", mode: 0o600 });
  const editorialRef = await binding(path.join(inputDir, "editorial_input.json"));
  await writeNew(path.join(inputDir, "runtime_provenance.json"), runtimeProvenance);
  const gate = buildNarrationPreSynthesisGate({ plan, planPath: planRef.path, planFileSha256: planRef.sha256,
    identityPath, identityFileSha256, scriptPath: identity.source_script.path, scriptSha256: hash(sourceBytes), policy, planPolicy: built.planPolicy,
    sourceArtifactHashes, textIr, textIrPath: irRef.path, textIrFileSha256: irRef.sha256, spokenTextAudit,
    spokenTextAuditPath: auditRef.path, spokenTextAuditFileSha256: auditRef.sha256,
    overridesSha256: sourceArtifactHashes.tts_spoken_overrides_sha256, referenceAssetHashes,
    synthesisScope: { mode: "pilot_opening_only", authorized_synthesis_unit_ids: opening.unit_ids, preserved_unit_ids: [],
      evidence_path: editorial.evidence_approval.path, evidence_sha256: editorial.evidence_approval.sha256 } });
  const validationGateRef = await writeNew(path.join(inputDir, "pre_synthesis_validation.json"), gate);
  passed(gate, "Opening gate blocked before model load");
  const executionArgs = { plan, units: opening.units, policy, planPolicy: built.planPolicy, batchPlan: opening.batch_plan,
    planPath: planRef.path, planSha256: plan.plan_sha256, planFileSha256: planRef.sha256,
    identityPath, identityFileSha256, scriptPath: identity.source_script.path, scriptSha256: hash(sourceBytes), acceptedUnitIds: [] };
  passed(await validatePilotOpeningExecutionInputs({ ...executionArgs, preSynthesisGate: gate,
    preSynthesisGatePath: validationGateRef.path, preSynthesisGateFileSha256: validationGateRef.sha256,
    requireAuthorized: false }), "Opening zero-spend execution inputs blocked");
  // Recheck approvals and every execution input immediately before recording
  // authorization. The runner checks persisted files again before model load.
  await readBound(editorial.script_approval);
  await readBound(editorial.evidence_approval);
  const authorized = authorizeNarrationPreSynthesisGate(gate);
  const gateRef = await writeNew(path.join(inputDir, "pre_synthesis_authorized.json"), authorized);
  Object.assign(executionArgs, { preSynthesisGate: authorized, preSynthesisGatePath: gateRef.path, preSynthesisGateFileSha256: gateRef.sha256 });
  passed(await validatePilotOpeningExecutionInputs(executionArgs), "Opening execution inputs blocked");
  const execution = await synthesize({ ...executionArgs, route: "qwen", attempt: 1, synthesisMode: policy.synthesis_contract.mode,
    outputDir: path.join(workRoot, "opening_execution"), python: PYTHON, runnerPath, invocationId: randomUUID() });
  passed(await validatePilotOpeningExecutionResults({ ...executionArgs, execution }), "Opening execution results blocked");
  const manifest = buildNarrationProviderOutputManifest({ provider: policy.primary.provider, modelId: policy.primary.model_id,
    modelRevision: policy.primary.model_revision, voiceId: policy.primary.voice_id, voiceSha256: policy.primary.voice_sha256,
    voiceContinuityContract: policy.primary.voice_continuity_contract, generationPlanSha256: plan.plan_sha256,
    generationPlanFileSha256: planRef.sha256, qualityContractSha256: policy.narration_quality_contract.contract_sha256,
    providerExecution: { synthesis_contract: policy.synthesis_contract, batch_plan_sha256: opening.batch_plan.batch_plan_sha256,
      synthesis_runs: [{ attempt: 1, synthesis_mode: policy.synthesis_contract.mode,
        batch_plan_sha256: opening.batch_plan.batch_plan_sha256, report_path: execution.reportPath, report_sha256: execution.reportSha256,
        cohort_events_path: execution.cohortEventsPath, cohort_events_sha256: execution.cohortEventsSha256 }], effective_concurrency: 1, phase: "opening" },
    units: opening.units, results: execution.results.map((row) => ({ ...row, audio_path: row.output_path, audio_sha256: row.output_sha256,
      runner_report_path: execution.reportPath, runner_report_sha256: execution.reportSha256 })) });
  passed(manifest, "Opening provider manifest blocked");
  const manifestRef = await writeNew(path.join(inputDir, "provider_output_manifest_opening.json"), manifest);
  const outputNamespace = path.join(workRoot, "opening_finalization");
  const finalized = await finalize(["--episode-dir", episodeDir, "--script", identity.source_script.path,
    "--plan", planRef.path, "--manifest", manifestRef.path], { phaseContext: { phase: "opening", outputNamespace,
      unitIds: opening.unit_ids, identitySha256: identityFileSha256, sourceScriptSha256: hash(sourceBytes),
      generationPlanFileSha256: planRef.sha256, providerManifestFileSha256: manifestRef.sha256,
      sourceArtifacts: {
        script_speakability_report_sha256: editorialRef,
        tts_spoken_overrides_sha256: overridesRef,
        pilot_script_approval_sha256: editorial.script_approval,
        pilot_evidence_approval_sha256: editorial.evidence_approval,
      },
      preSynthesisGatePath: gateRef.path, preSynthesisGateFileSha256: gateRef.sha256,
      textIrPath: irRef.path, textIrFileSha256: irRef.sha256, spokenTextAuditPath: auditRef.path, spokenTextAuditFileSha256: auditRef.sha256 } });
  const finalizationArtifacts = {};
  for (const [key, file] of Object.entries({
    audio: finalized.final_wav, tts_report: finalized.tts_report_path, stitch_report: finalized.stitch_report_path,
    full_stream_qa: finalized.full_stream_qa_path, voice_continuity: finalized.voice_continuity_qa_path,
    unit_delivery_qa: finalized.unit_delivery_qa_path, unit_qa: finalized.unit_qa_path,
    subjective_manifest: finalized.subjective_review_manifest_path, timing_candidate: finalized.timing_candidate_path,
  })) {
    if (file == null) continue; // A deferred listen/mastering result remains blocked by the sample validator.
    need(path.resolve(file).startsWith(`${outputNamespace}${path.sep}`), "Opening finalizer output escaped its namespace.");
    finalizationArtifacts[key] = await binding(file);
  }
  const output = { schema: "goldflow_avatar_pilot_opening_producer_result_v1", phase: "opening", status: "technical_finalization_returned_pending_validation_and_listening",
    identity_sha256: identityFileSha256, source_script_sha256: hash(sourceBytes), unit_ids: opening.unit_ids,
    generation_plan: planRef, spoken_text_ir: irRef, spoken_text_audit: auditRef, pre_synthesis_gate: gateRef,
    provider_output_manifest: manifestRef, runner_report: { path: execution.reportPath, sha256: execution.reportSha256 },
    cohort_events: { path: execution.cohortEventsPath, sha256: execution.cohortEventsSha256 },
    finalization_artifacts: finalizationArtifacts,
    finalized, runtime_provenance: runtimeProvenance, production_eligible: false, publish_allowed: false, subjective_approval: null };
  await writeNew(path.join(workRoot, "opening_producer_result.json"), output);
  return output;
};
}

/** Internal workflow component, not an alternate CLI. Never performs a retry. */
export const producePilotOpeningSample = createPilotOpeningProducer();
