import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { QWEN_JOEL_PRIMARY_LOCK as PIN, defaultNarrationVoiceProviderOptions, validateNarrationTtsPolicy } from "./narration-tts-policy.mjs";
import { buildNarrationQualityContract } from "./narration-quality-contract.mjs";
import { buildNarrationTextIr, validateNarrationTextIr, narrationTokensWithSpans } from "./narration-text-ir.mjs";
import { buildTtsSpokenTextAudit } from "./tts-spoken-text-audit.mjs";
import { compileNarrationProviderRequest } from "./narration-provider-adapter.mjs";
import { buildQwenLiamBatchPlan, qwenBatchBindingByUnit } from "./qwen-liam-batch-contract.mjs";
import { canonicalNarrationPlanSha256, buildNarrationPreSynthesisGate, authorizeNarrationPreSynthesisGate } from "./narration-pre-synthesis-gate.mjs";
import { hasTtsTerminalPunctuation } from "./tts-text-boundaries.mjs";
import { strictNarrationDeliveryDecision, narrationDeliveryNeedsConfirmation, adjudicateNarrationDeliveryConsensus } from "./narration-delivery-quality.mjs";
import { runNarrationVoiceContinuityQa } from "./narration-voice-continuity.mjs";
import { inspectTrueCrimeProofWav } from "./true-crime-proof-narration.mjs";

export const CRIME_FOOTAGE_NARRATION_VERSION = "2026-09-09.2";
export const CRIME_FOOTAGE_QWEN_PYTHON = "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-kokoro-mlx-audio-0.4.6/bin/python";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha = value => createHash("sha256").update(value).digest("hex");
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const need = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const words = text => text.trim().split(/\s+/u).length;
const tokens = text => narrationTokensWithSpans(text).length;
const voiceOf = identity => Object.fromEntries(["provider", "model", "model_revision", "voice_id", "voice_sha256"].map(key => [key, identity.narration[key]]));
async function bound(file) { return { path: file, sha256: sha(await fs.readFile(file)) }; }
async function writeNew(file, value) { await fs.writeFile(file, json(value), { flag: "wx", mode: 0o600 }); return bound(file); }
async function readBound(ref) {
  need(path.isAbsolute(ref?.path ?? "") && /^[a-f0-9]{64}$/u.test(ref?.sha256 ?? ""), "Exact absolute source binding required.");
  const bytes = await fs.readFile(ref.path);
  need(sha(bytes) === ref.sha256, `Bound source changed: ${ref.path}`);
  return bytes;
}

function narratorPolicy(identity) {
  need(identity.schema === "goldflow_crime_footage_proof_identity_v1" && identity.production_eligible === false && identity.publish_allowed === false,
    "Only the new private footage proof identity can synthesize this narration.");
  for (const [key, expected] of Object.entries({ provider: PIN.provider, model: PIN.model_id, model_revision: PIN.model_revision,
    voice_id: PIN.voice_id, voice_sha256: PIN.voice_sha256 })) {
    need(identity.narration?.[key] === expected, `Narrator voice/model lock mismatch: ${key}`);
  }
  need(identity.narration.reference_audio?.path === PIN.reference_audio_path
    && identity.narration.reference_audio.sha256 === PIN.reference_audio_sha256
    && identity.narration.reference_text?.sha256 === PIN.reference_text_sha256, "Narrator reference lock mismatch.");
  const quality = buildNarrationQualityContract({ provider: PIN.provider, modelId: PIN.model_id, modelRevision: PIN.model_revision });
  const policy = { contract: "qwen_joel_primary_v1", ...defaultNarrationVoiceProviderOptions({
    narrationQualityContract: quality, referenceVariantId: "joel_ref_02_tense_narration" }) };
  policy.primary.reference_variant_id = "joel_ref_02_tense_narration";
  validateNarrationTtsPolicy(policy, { production: true });
  return { ...policy, status: "passed", findings: [] };
}

/** Pure compilation closes exact source/caption/spoken lineage. This neither
 * invokes a provider nor authorizes an episode stage. */
export function buildCrimeFootageNarrationPlan({ editorialPlan, editorialPlanBytes, identity, identityBytes, scriptText } = {}) {
  need(Buffer.isBuffer(editorialPlanBytes) && Buffer.isBuffer(identityBytes), "Exact plan and identity bytes required.");
  need(equal(JSON.parse(editorialPlanBytes), editorialPlan) && equal(JSON.parse(identityBytes), identity), "Objects differ from their bound bytes.");
  const scriptHash = sha(Buffer.from(scriptText)), identityHash = sha(identityBytes);
  need(sha(editorialPlanBytes) === identity.plan?.sha256 && scriptHash === identity.script?.sha256, "Narration source hashes changed.");
  need(editorialPlan.schema === "goldflow_crime_footage_proof_plan_v1", "Unsupported footage proof plan.");
  const drafts = editorialPlan.narration_units;
  need(Array.isArray(drafts) && drafts.length >= 1 && drafts.length <= 4, "Footage proof requires one to four narrator units.");
  need(new Set(drafts.map(row => row.id)).size === drafts.length, "Duplicate narrator unit id.");
  const joined = drafts.map(row => row.text).join("\n\n");
  need(scriptText === joined || scriptText === `${joined}\n`, "Script must exactly concatenate narrator units in order.");
  const policy = narratorPolicy(identity), evidence = new Set((identity.sources ?? []).map(row => row.id));
  let offset = 0;
  const units = drafts.map((draft, index) => {
    const text = draft.text;
    need(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(draft.id ?? ""), "Stable narrator unit id required.");
    need(draft.speaker === undefined || draft.speaker === "NARRATOR", "This adapter synthesizes the narrator only.");
    need(draft.audio_origin === undefined || draft.audio_origin === "narration", "Recreated dialogue is outside this narrator scope.");
    need(typeof text === "string" && text === text.trim() && text && words(text) <= 60 && hasTtsTerminalPunctuation(text),
      "Each narrator unit requires exact sentence-complete text of at most sixty words.");
    need(!/[\p{N}\u0000-\u0008\u000b\u000c\u000e-\u001f]|\[[^\]\n]+\]|<\|speaker:|```/u.test(text), "Unresolved numeric text or performance/system tags.");
    need(Array.isArray(draft.source_ids) && draft.source_ids.length > 0 && draft.source_ids.every(id => evidence.has(id)), "Narrator evidence source coverage incomplete.");
    const textHash = sha(text), unitId = `${draft.id}-${sha(`${scriptHash}\0${draft.id}\0${text}`).slice(0, 12)}`, componentId = `${unitId}-source`;
    const sourceRef = { source_unit_id: componentId, segment_id: draft.id, source_text: text, caption_text: text,
      source_text_sha256: textHash, caption_text_sha256: textHash, source_start_utf16: offset, source_end_utf16: offset + text.length,
      source_start_utf8: Buffer.byteLength(scriptText.slice(0, offset)), source_end_utf8: Buffer.byteLength(scriptText.slice(0, offset + text.length)),
      evidence_source_ids: [...draft.source_ids], claim_ids: draft.claim_ids ?? [] };
    const lineage = { schema: "goldflow_spoken_text_lineage_v1", policy: "Exact footage-proof narrator text; no lexical or punctuation transformation.",
      components: [{ source_unit_id: componentId, source_text: text, source_text_sha256: textHash,
        compiled_spoken_text: text, compiled_spoken_text_sha256: textHash, transformation_receipts: [] }],
      pre_direction_spoken_text: text, pre_direction_spoken_text_sha256: textHash, final_transformations: [],
      final_spoken_text: text, final_spoken_text_sha256: textHash };
    lineage.lineage_sha256 = sha(JSON.stringify(lineage));
    offset += text.length + 2;
    return { unit_id: unitId, narrator_unit_id: draft.id, scene_id: draft.id, order_index: index, kind: "narration", speaker: "NARRATOR",
      source_text: text, caption_text: text, spoken_text: text, tts_spoken_text: text, qwen_spoken_text: text,
      source_text_sha256: textHash, caption_text_sha256: textHash, spoken_text_sha256: textHash, word_count: words(text),
      source_unit_refs: [sourceRef], source_segment_ids: [draft.id], spoken_text_lineage: lineage, spoken_text_transformations: [],
      merge_barrier: true, boundary_after: index === drafts.length - 1 ? "episode_end" : "paragraph",
      voice_id: PIN.voice_id, voice_sha256: PIN.voice_sha256, performance_intent: {}, evidence_source_ids: [...draft.source_ids],
      audio_origin: "narration", text_mode: "paraphrase", qwen_instruct: null };
  });
  need(units.reduce((sum, row) => sum + row.word_count, 0) <= 180, "Narrator bridges exceed the bounded proof word budget.");
  const batchPlan = buildQwenLiamBatchPlan(units, policy.synthesis_contract), cohorts = qwenBatchBindingByUnit(batchPlan);
  for (const unit of units) {
    unit.synthesis_cohort = cohorts.get(unit.unit_id);
    unit.provider_request = compileNarrationProviderRequest(unit, { provider: PIN.provider, modelId: PIN.model_id,
      modelRevision: PIN.model_revision, voiceId: PIN.voice_id, voiceSha256: PIN.voice_sha256,
      voiceContinuityContract: PIN.voice_continuity_contract, referenceAudioPath: PIN.reference_audio_path,
      referenceText: PIN.reference_text, seed: unit.synthesis_cohort.batch_seed });
  }
  const sourceArtifactHashes = { editorial_plan_sha256: identity.plan.sha256 };
  const plan = { schema: "goldflow_tts_generation_plan_v2", status: "passed", crime_footage_narration_version: CRIME_FOOTAGE_NARRATION_VERSION,
    source_script_hash: scriptHash, source_hashes: { ...sourceArtifactHashes, script_clean_sha256: scriptHash, run_identity_sha256: identityHash },
    primary_provider: PIN.provider, fallback_provider: null, narrator_voice_id: PIN.voice_id, narrator_voice_sha256: PIN.voice_sha256,
    tts_native_speed: null, unit_count: units.length, units, qwen_liam_batch_plan: batchPlan,
    segments: units.map(unit => ({ segment_id: unit.narrator_unit_id, generation_units: [unit], narration_generation_units: [unit], qwen_generation_units: [unit] })),
    sentence_unit_boundary_integrity: { status: "passed", unit_count: units.length, clean_start_count: units.length,
      terminal_punctuation_count: units.length, within_hard_word_maximum_count: units.length, within_voice_segment_boundary_count: units.length,
      blocker_count: 0, blockers: [] },
    text_integrity_coverage: { status: "passed", verification: "exact_narrator_units_in_contiguous_script_order",
      script_to_plan_source: { status: "passed", expected_token_count: tokens(scriptText), actual_token_count: units.reduce((sum, row) => sum + tokens(row.source_text), 0) },
      plan_source_to_spoken: { status: "passed", unit_count: units.length, expected_token_count: tokens(scriptText), actual_token_count: tokens(scriptText), mismatch_unit_count: 0 }, findings: [] },
    system_ui_speech_coverage: { status: "passed", expected_count: 0, planned_count: 0, missing_count: 0, unexpected_count: 0, missing: [], unexpected: [] } };
  const spokenTextAudit = buildTtsSpokenTextAudit({ plan, sourceScriptSha256: scriptHash, provider: PIN.provider, voiceId: PIN.voice_id });
  need(spokenTextAudit.status === "passed", "Narrator spoken-text audit failed.");
  plan.tts_spoken_text_audit = { status: "passed", audit_sha256: spokenTextAudit.audit_sha256,
    unit_contract_sha256: spokenTextAudit.unit_contract_sha256, blocker_count: spokenTextAudit.blocker_count };
  plan.plan_sha256 = canonicalNarrationPlanSha256(plan);
  const textIr = buildNarrationTextIr({ sourceScriptSha256: scriptHash, generationPlanSha256: plan.plan_sha256, units });
  const planPolicy = validateNarrationTextIr(textIr, units, { sourceScriptSha256: scriptHash, generationPlanSha256: plan.plan_sha256 });
  need(planPolicy.status === "passed", "Narrator source lineage did not close.");
  return { plan, policy, textIr, spokenTextAudit, planPolicy, sourceArtifactHashes, identityHash, scriptHash, batchPlan };
}

/** Diagnostic stream only: concatenate each complete PCM once, with no pad,
 * trim, gain, fade or tempo operation. Program placement uses individual WAVs. */
export function concatenateCrimeNarrationForQa(units, wavs) {
  need(units.length >= 1 && units.length === wavs.length, "Every ordered unit needs one WAV.");
  let cursor = 0;
  const parts = [], timeline = [];
  for (const [index, unit] of units.entries()) {
    const audio = inspectTrueCrimeProofWav(wavs[index]);
    parts.push(audio.data);
    timeline.push({ unit_id: unit.unit_id, narrator_unit_id: unit.narrator_unit_id, start_sample: cursor,
      sample_count: audio.sample_count, end_sample: cursor + audio.sample_count, duration_sec: audio.duration_sec });
    cursor += audio.sample_count;
  }
  need(cursor > 0 && cursor / 24000 <= 90, "Narrator diagnostic stream exceeds private proof duration.");
  const pcm = Buffer.concat(parts), header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return { bytes: Buffer.concat([header, pcm]), sample_count: cursor, duration_sec: cursor / 24000, timeline,
    raw_units_preserved: true, added_silence_samples: 0, tempo: 1, program_timeline: false };
}

async function pinnedReferences() {
  const entries = [["reference_audio", PIN.reference_audio_path, PIN.reference_audio_sha256],
    ["reference_manifest", PIN.reference_manifest_path, PIN.reference_manifest_sha256],
    ["reference_metadata", PIN.reference_metadata_path, PIN.reference_metadata_sha256],
    ["speaker_similarity_model", PIN.speaker_similarity_model_path, PIN.speaker_similarity_model_sha256],
    ["speaker_similarity_calibration", PIN.speaker_similarity_calibration_path, PIN.speaker_similarity_calibration_sha256]];
  const result = {};
  for (const [label, file, expected] of entries) {
    const actual = sha(await fs.readFile(file)); need(actual === expected, `Pinned narrator asset changed: ${label}`);
    result[label] = { path: file, expected, actual };
  }
  result.reference_text = { path: null, expected: PIN.reference_text_sha256, actual: sha(PIN.reference_text) };
  return result;
}

async function inspectDelivery(units, rows, diagnosticPath, contract) {
  const helpers = await import("../modelslab-qwen-episode-audio.mjs");
  const inputs = [...rows, { unit_id: "full-stream", wav: diagnosticPath, text: units.map(row => row.spoken_text).join(" ") }];
  const primary = await helpers.runFasterWhisperUnitBatchForDiagnostics(inputs, { model: "small.en", device: "cpu", computeType: "int8_float32" });
  const first = new Map(), confirm = [];
  for (const row of inputs) {
    const recognized = primary.get(row.unit_id); need(recognized, `ASR omitted ${row.unit_id}`);
    const transcriptQa = helpers.transcriptQaForTests(row.text, recognized.text, { maxWer: 0.05, blockAnySubstitution: false });
    const decision = strictNarrationDeliveryDecision(transcriptQa, { orderQa: { blockers: [] }, joinQa: { blockers: [], warnings: [] }, contract });
    first.set(row.unit_id, { recognized, transcript_qa: transcriptQa, decision });
    if (narrationDeliveryNeedsConfirmation(transcriptQa, decision)) confirm.push(row);
  }
  const second = confirm.length ? await helpers.runFasterWhisperUnitBatchForDiagnostics(confirm, { model: "medium", device: "cpu", computeType: "int8_float32" }) : new Map();
  const results = inputs.map(row => {
    const p = first.get(row.unit_id), recognized = second.get(row.unit_id);
    const confirmationQa = recognized ? helpers.transcriptQaForTests(row.text, recognized.text, { maxWer: 0.05, blockAnySubstitution: false }) : null;
    return { unit_id: row.unit_id, primary: p, confirmation: recognized ? { recognized, transcript_qa: confirmationQa } : null,
      consensus: adjudicateNarrationDeliveryConsensus({ primaryTranscriptQa: p.transcript_qa, confirmationTranscriptQa: confirmationQa,
        primaryModel: "small.en", confirmationModel: "medium", contract }) };
  });
  return { schema: "goldflow_crime_footage_narration_delivery_qa_v1", status: results.every(row => row.consensus.status === "passed") ? "passed" : "needs_review",
    full_stream_included: true, units: results, human_listening_performed: false, automatic_retry_allowed: false };
}

/** Fixed guarded producer. There is no provider, identity or QA callback seam;
 * provider-free tests exercise compilation, samples and refusal paths instead. */
export async function produceCrimeFootageProofNarration({ proofDir, outputDir, attemptToken } = {}) {
  need(path.isAbsolute(proofDir ?? "") && path.isAbsolute(outputDir ?? ""), "Narration needs absolute proof and output directories.");
  need(outputDir === path.join(proofDir, "attempts/narration/output"), "Narration output must belong to its guarded attempt.");
  const { loadCrimeFootageProofAttempt } = await import("./crime-footage-editorial-workflow.mjs");
  const current = await loadCrimeFootageProofAttempt({ proofDir, stage: "narration", attemptToken }), identity = current.identity;
  need(current.outputDir === outputDir, "Narration output differs from the guarded attempt.");
  const identityPath = path.join(proofDir, "run_identity.json"), identityBytes = await fs.readFile(identityPath);
  const attemptPath = path.join(proofDir, "attempts/narration/start.json");
  const attempt = JSON.parse(await fs.readFile(attemptPath, "utf8"));
  need(attempt.stage === "narration" && attempt.identity_sha256 === current.identity_sha256 && attempt.automatic_retry_allowed === false,
    "A current guarded narration attempt is required.");
  need(!await fs.stat(path.join(proofDir, "attempts/narration/result.json")).catch(() => null), "A closed narration attempt cannot synthesize again.");
  const planBytes = await readBound(identity.plan), scriptBytes = await readBound(identity.script);
  need(sha(identityBytes) === current.identity_sha256 && scriptBytes.toString("utf8") === current.scriptText, "Narration identity/script changed.");
  need((await readBound(identity.narration.reference_text)).toString("utf8") === PIN.reference_text, "Pinned reference transcript changed.");
  await readBound(identity.narration.reference_audio);
  const built = buildCrimeFootageNarrationPlan({ editorialPlan: current.plan, editorialPlanBytes: planBytes, identity, identityBytes, scriptText: current.scriptText });
  const referenceHashes = await pinnedReferences(), runnerPath = path.join(ROOT, "scripts/tts-local-production-runner.py");
  await fs.mkdir(outputDir, { recursive: true });
  await writeNew(path.join(outputDir, "narration-invocation.json"), { schema: "goldflow_crime_footage_narration_invocation_v1",
    version: CRIME_FOOTAGE_NARRATION_VERSION, identity_sha256: built.identityHash, source_script_sha256: built.scriptHash,
    attempt_start: await bound(attemptPath), one_creative_submission_per_unit: true, automatic_retry_allowed: false, started_at: new Date().toISOString() });
  const planRef = await writeNew(path.join(outputDir, "narration-generation-plan.json"), built.plan);
  const irRef = await writeNew(path.join(outputDir, "narration-text-ir.json"), built.textIr);
  const auditRef = await writeNew(path.join(outputDir, "spoken-text-audit.json"), built.spokenTextAudit);
  const runtimeRef = await writeNew(path.join(outputDir, "runtime-provenance.json"), { adapter: await bound(fileURLToPath(import.meta.url)),
    worker: await bound(runnerPath), python_path: CRIME_FOOTAGE_QWEN_PYTHON, policy: built.policy,
    reference_asset_hashes: referenceHashes, provider_cost_usd: 0, provider_network_required: false });
  const gate = buildNarrationPreSynthesisGate({ plan: built.plan, planPath: planRef.path, planFileSha256: planRef.sha256,
    identityPath, identityFileSha256: built.identityHash, scriptPath: identity.script.path, scriptSha256: built.scriptHash,
    policy: built.policy, planPolicy: built.planPolicy, sourceArtifactHashes: built.sourceArtifactHashes,
    textIr: built.textIr, textIrPath: irRef.path, textIrFileSha256: irRef.sha256,
    spokenTextAudit: built.spokenTextAudit, spokenTextAuditPath: auditRef.path, spokenTextAuditFileSha256: auditRef.sha256,
    referenceAssetHashes: referenceHashes, synthesisScope: { mode: "initial_full_synthesis",
      authorized_synthesis_unit_ids: built.plan.units.map(row => row.unit_id), preserved_unit_ids: [], evidence_path: identityPath, evidence_sha256: built.identityHash } });
  await writeNew(path.join(outputDir, "pre-synthesis-validation.json"), gate);
  need(gate.status === "passed", `Narration blocked before model load: ${JSON.stringify(gate.findings)}`);
  // The loader rechecks current bound source/code before the first model load.
  const beforeSynthesis = await loadCrimeFootageProofAttempt({ proofDir, stage: "narration", attemptToken });
  need(beforeSynthesis.identity_sha256 === built.identityHash, "Narration identity changed before synthesis.");
  const authorized = authorizeNarrationPreSynthesisGate(gate);
  const gateRef = await writeNew(path.join(outputDir, "pre-synthesis-authorized.json"), authorized);
  const { runSynthesis } = await import("../narration-tts-episode.mjs");
  const execution = await runSynthesis({ route: "qwen", attempt: 1, units: built.plan.units, policy: built.policy, batchPlan: built.batchPlan,
    synthesisMode: built.policy.synthesis_contract.mode, outputDir: path.join(outputDir, "execution"), python: CRIME_FOOTAGE_QWEN_PYTHON,
    runnerPath, invocationId: randomUUID(), preSynthesisGate: authorized, preSynthesisGatePath: gateRef.path,
    preSynthesisGateFileSha256: gateRef.sha256, planPath: planRef.path, planSha256: built.plan.plan_sha256,
    planFileSha256: planRef.sha256, identityPath, identityFileSha256: built.identityHash, scriptPath: identity.script.path, scriptSha256: built.scriptHash });
  need(execution.report.status === "passed" && equal(execution.results.map(row => row.unit_id), built.plan.units.map(row => row.unit_id)),
    "Synthesis failed or reordered units; preserve outputs for exact-scope triage.");
  const rows = [], wavs = [];
  for (const [index, result] of execution.results.entries()) {
    const unit = built.plan.units[index], bytes = await fs.readFile(result.output_path), info = inspectTrueCrimeProofWav(bytes);
    need(result.output_path.startsWith(`${outputDir}${path.sep}`) && sha(bytes) === result.output_sha256
      && result.spoken_text_sha256 === unit.spoken_text_sha256 && result.token_limit_reached === false, "Narration output/text/token binding failed.");
    wavs.push(bytes);
    rows.push({ unit_id: unit.unit_id, narrator_unit_id: unit.narrator_unit_id, scene_id: unit.narrator_unit_id, text: unit.spoken_text,
      spoken_text_sha256: unit.spoken_text_sha256, source_ids: unit.evidence_source_ids, wav: result.output_path,
      audio_sha256: result.output_sha256, duration_sec: info.duration_sec, sample_count: info.sample_count,
      metrics: { ...info, data: undefined }, synthesis_identity_sha256: result.synthesis_identity_sha256,
      provider_request_sha256: unit.provider_request.provider_request_sha256 ?? unit.provider_request.request_sha256,
      source_lineage_sha256: unit.spoken_text_lineage.lineage_sha256 });
  }
  const diagnostic = concatenateCrimeNarrationForQa(built.plan.units, wavs), diagnosticPath = path.join(outputDir, "narration-diagnostic-concatenated.wav");
  await fs.writeFile(diagnosticPath, diagnostic.bytes, { flag: "wx" });
  const diagnosticRef = await bound(diagnosticPath);
  const accountingRef = await writeNew(path.join(outputDir, "narration-sample-accounting.json"), { ...diagnostic, bytes: undefined,
    diagnostic_audio: diagnosticRef, raw_units: rows, no_program_padding: true });
  let delivery, voice;
  try { delivery = await inspectDelivery(built.plan.units, rows, diagnosticPath, built.policy.narration_quality_contract); }
  catch (error) { delivery = { status: "needs_review", error: error.message, human_listening_performed: false }; }
  const deliveryRef = await writeNew(path.join(outputDir, "delivery-qa.json"), delivery);
  try { voice = await runNarrationVoiceContinuityQa({ rows, profile: built.policy.primary, qualityContract: built.policy.narration_quality_contract,
    reportPath: path.join(outputDir, "voice-continuity-measurement.json") }); }
  catch (error) { voice = { status: "needs_review", error: error.message }; }
  const voiceRef = await writeNew(path.join(outputDir, "voice-continuity-result.json"), voice);
  const technicalQa = delivery.status === "passed" && voice.status === "passed" && rows.every(row => row.metrics.clipped_sample_count === 0) ? "passed" : "needs_review";
  // Raw units are the render inputs. Mastering belongs to the later program mix;
  // a source-unit pass is not a mastered narration or subjective acceptance.
  const report = { schema: "goldflow_crime_footage_proof_narration_result_v1", status: "candidate_awaiting_listening",
    adapter_version: CRIME_FOOTAGE_NARRATION_VERSION, identity_sha256: built.identityHash, editorial_plan_sha256: identity.plan.sha256,
    source_text_sha256: built.scriptHash, voice: voiceOf(identity), raw_units: rows, unit_ids: rows.map(row => row.unit_id),
    narrator_unit_ids: rows.map(row => row.narrator_unit_id), measured_duration_sec: diagnostic.duration_sec,
    diagnostic_audio: diagnosticRef, sample_accounting: accountingRef, generation_plan: planRef, pre_synthesis_gate: gateRef,
    runner_report: { path: execution.reportPath, sha256: execution.reportSha256 },
    cohort_events: { path: execution.cohortEventsPath, sha256: execution.cohortEventsSha256 },
    delivery_qa: delivery, voice_continuity: voice, technical_qa: technicalQa, technical_qa_scope: "raw_narrator_units_only",
    mastering: { status: "pending_program_mix", raw_units_unchanged: true, per_unit_normalization: false },
    human_listening_performed: false, subjective_approval: null, tempo: 1, production_eligible: false, publish_allowed: false,
    cost_usd: 0, completed_at: new Date().toISOString() };
  const after = await loadCrimeFootageProofAttempt({ proofDir, stage: "narration", attemptToken });
  need(after.identity_sha256 === built.identityHash, "Narration identity changed during execution.");
  for (const row of rows) need((await bound(row.wav)).sha256 === row.audio_sha256, "Raw narrator unit changed during QA.");
  const receiptRef = await writeNew(path.join(outputDir, "narration-result.json"), report);
  const artifacts = [{ id: "narration-receipt", ...receiptRef, kind: "narration_receipt" },
    { id: "narration-diagnostic", ...diagnosticRef, kind: "narration_audio" },
    { id: "narration-sample-accounting", ...accountingRef, kind: "narration_timing" },
    ...rows.map(row => ({ id: `raw-${row.narrator_unit_id}`, path: row.wav, sha256: row.audio_sha256, kind: "narration_unit", source_ids: row.source_ids })),
    { id: "qwen-runner-report", path: execution.reportPath, sha256: execution.reportSha256, kind: "provider_receipt" },
    { id: "qwen-cohort-events", path: execution.cohortEventsPath, sha256: execution.cohortEventsSha256, kind: "provider_events" },
    { id: "pre-synthesis-gate", ...gateRef, kind: "synthesis_gate" }, { id: "narration-plan", ...planRef, kind: "narration_plan" },
    { id: "narration-text-ir", ...irRef, kind: "text_lineage" }, { id: "narration-text-audit", ...auditRef, kind: "text_audit" },
    { id: "narration-runtime", ...runtimeRef, kind: "runtime_provenance" }, { id: "narration-delivery", ...deliveryRef, kind: "delivery_qa" },
    { id: "narration-voice", ...voiceRef, kind: "voice_qa" }];
  return { artifacts: artifacts.map(artifact => ({ ...artifact, source_ids: artifact.source_ids ?? [] })),
    metadata: { source_text_sha256: built.scriptHash, voice: voiceOf(identity), measured_duration_sec: diagnostic.duration_sec,
      tempo: 1, technical_qa: technicalQa, technical_qa_scope: "raw_narrator_units_only", mastering_status: "pending_program_mix",
      human_listening_performed: false, raw_unit_count: rows.length, narrator_unit_ids: rows.map(row => row.narrator_unit_id),
      units: rows.map(row => ({ id: row.narrator_unit_id, artifact_id: `raw-${row.narrator_unit_id}`, text: row.text,
        text_sha256: row.spoken_text_sha256, measured_duration_sec: row.duration_sec })) }, cost_usd: 0 };
}
