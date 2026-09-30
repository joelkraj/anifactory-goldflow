import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { QWEN_JOEL_PRIMARY_LOCK, defaultNarrationVoiceProviderOptions, validateNarrationTtsPolicy } from "./narration-tts-policy.mjs";
import { buildNarrationQualityContract } from "./narration-quality-contract.mjs";
import { buildNarrationTextIr, validateNarrationTextIr, narrationTokensWithSpans } from "./narration-text-ir.mjs";
import { buildTtsSpokenTextAudit } from "./tts-spoken-text-audit.mjs";
import { compileNarrationProviderRequest } from "./narration-provider-adapter.mjs";
import { buildQwenLiamBatchPlan, qwenBatchBindingByUnit } from "./qwen-liam-batch-contract.mjs";
import { canonicalNarrationPlanSha256, buildNarrationPreSynthesisGate, authorizeNarrationPreSynthesisGate } from "./narration-pre-synthesis-gate.mjs";
import { hasTtsTerminalPunctuation } from "./tts-text-boundaries.mjs";
import { planNarrationBoundary, validateNarrationStitchAccounting } from "./narration-boundary-editor.mjs";
import { masterNarrationTwoPass } from "./narration-mastering.mjs";
import { runNarrationVoiceContinuityQa } from "./narration-voice-continuity.mjs";
import { strictNarrationDeliveryDecision, narrationDeliveryNeedsConfirmation, adjudicateNarrationDeliveryConsensus } from "./narration-delivery-quality.mjs";

export const TRUE_CRIME_PROOF_NARRATION_VERSION = "2026-09-08.1";
export const TRUE_CRIME_PROOF_QWEN_PYTHON = "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-kokoro-mlx-audio-0.4.6/bin/python";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PIN = QWEN_JOEL_PRIMARY_LOCK;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (ok, message) => { if (!ok) throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const count = (text) => text.trim().split(/\s+/u).length;
const tokens = (text) => narrationTokensWithSpans(text).length;
const identityVoice = (identity) => ({ provider: identity.narration.provider, model: identity.narration.model,
  model_revision: identity.narration.model_revision, voice_id: identity.narration.voice_id, voice_sha256: identity.narration.voice_sha256 });
async function binding(file) { return { path: file, sha256: hash(await fs.readFile(file)) }; }
async function writeNew(file, value) { await fs.writeFile(file, jsonBytes(value), { flag: "wx", mode: 0o600 }); return binding(file); }
async function readBound(ref) {
  need(path.isAbsolute(ref?.path ?? "") && /^[a-f0-9]{64}$/u.test(ref?.sha256 ?? ""), "Exact local file binding required.");
  const data = await fs.readFile(ref.path); need(hash(data) === ref.sha256, `Bound file changed: ${ref.path}`); return data;
}

function pinnedPolicy(identity) {
  need(identity.schema === "goldflow_true_crime_proof_identity_v1" && identity.production_eligible === false,
    "Narration requires a private true-crime proof identity.");
  const voice = identity.narration ?? {};
  for (const [field, expected] of Object.entries({ provider: PIN.provider, model: PIN.model_id,
    model_revision: PIN.model_revision, voice_id: PIN.voice_id, voice_sha256: PIN.voice_sha256 })) {
    need(voice[field] === expected, `Private proof Qwen voice lock mismatch: ${field}`);
  }
  need(voice.reference_audio?.path === PIN.reference_audio_path && voice.reference_audio?.sha256 === PIN.reference_audio_sha256
    && voice.reference_text?.sha256 === PIN.reference_text_sha256, "Private proof reference lock mismatch.");
  const quality = buildNarrationQualityContract({ provider: PIN.provider, modelId: PIN.model_id, modelRevision: PIN.model_revision });
  const policy = { contract: "qwen_joel_primary_v1", ...defaultNarrationVoiceProviderOptions({ narrationQualityContract: quality,
    referenceVariantId: "joel_ref_02_tense_narration" }) };
  policy.primary.reference_variant_id = "joel_ref_02_tense_narration";
  validateNarrationTtsPolicy(policy, { production: true });
  return { ...policy, status: "passed", findings: [] };
}

/** Exact source compiler for this private proof. It never authorizes synthesis,
 * normalizes speech, selects a new voice, or infers approval from a plan status. */
export function buildTrueCrimeProofNarrationPlan({ editorialPlan, editorialPlanBytes, identity, identityBytes, scriptText } = {}) {
  need(Buffer.isBuffer(editorialPlanBytes) && Buffer.isBuffer(identityBytes), "Exact plan and identity bytes required.");
  need(same(JSON.parse(editorialPlanBytes), editorialPlan) && same(JSON.parse(identityBytes), identity), "Input objects differ from bound bytes.");
  const scriptBytes = Buffer.from(scriptText, "utf8"), scriptHash = hash(scriptBytes), identityHash = hash(identityBytes);
  need(hash(editorialPlanBytes) === identity.plan?.sha256 && scriptHash === identity.script?.sha256, "Authorized source hashes changed.");
  need(editorialPlan.schema === "goldflow_true_crime_editorial_proof_plan_v1", "Unsupported editorial plan.");
  const scenes = editorialPlan.scenes;
  need(Array.isArray(scenes) && scenes.length === 7 && new Set(scenes.map((row) => row.id)).size === scenes.length,
    "This private narration proof requires exactly seven unique scenes.");
  const joined = scenes.map((row) => row.audio?.text).join("\n\n");
  need(scriptText === joined || scriptText === `${joined}\n`, "Script must exactly concatenate the seven approved scene texts.");
  const policy = pinnedPolicy(identity);
  let offset = 0;
  const units = scenes.map((scene, index) => {
    const text = scene.audio?.text;
    need(scene.audio?.origin === "narration" && ["paraphrase", "document_reading"].includes(scene.audio?.text_mode), "This proof synthesizes narrator speech only.");
    need(typeof text === "string" && text === text.trim() && text && count(text) <= 60 && hasTtsTerminalPunctuation(text), "Exact sentence-complete text of at most sixty words required.");
    need(!/[\p{N}\u0000-\u0008\u000b\u000c\u000e-\u001f]|\[[^\]\n]+\]|<\|speaker:|```/u.test(text), "Spoken text contains unresolved digits or performance/system tags.");
    need(Array.isArray(scene.source_ids) && scene.source_ids.length > 0 && scene.source_ids.every((id) => editorialPlan.sources?.some((s) => s.id === id)), "Scene source coverage incomplete.");
    const unitId = `${scene.id}-${hash(`${scriptHash}\0${scene.id}\0${text}`).slice(0, 12)}`, componentId = `${unitId}-source`;
    const lineage = { schema: "goldflow_spoken_text_lineage_v1", policy: "Exact approved narration; no source, caption or spoken-text transformations.",
      components: [{ source_unit_id: componentId, source_text: text, source_text_sha256: hash(text), compiled_spoken_text: text,
        compiled_spoken_text_sha256: hash(text), transformation_receipts: [] }], pre_direction_spoken_text: text,
      pre_direction_spoken_text_sha256: hash(text), final_transformations: [], final_spoken_text: text, final_spoken_text_sha256: hash(text) };
    lineage.lineage_sha256 = hash(JSON.stringify(lineage));
    const sourceRef = { source_unit_id: componentId, segment_id: scene.id, source_text: text, caption_text: text,
      source_text_sha256: hash(text), caption_text_sha256: hash(text), source_start_utf16: offset, source_end_utf16: offset + text.length,
      source_start_utf8: Buffer.byteLength(scriptText.slice(0, offset)), source_end_utf8: Buffer.byteLength(scriptText.slice(0, offset + text.length)),
      evidence_source_ids: scene.source_ids, claim_ids: scene.claim_ids };
    offset += text.length + 2;
    return { unit_id: unitId, scene_id: scene.id, order_index: index, kind: "narration", speaker: "NARRATOR",
      source_text: text, caption_text: text, spoken_text: text, tts_spoken_text: text, qwen_spoken_text: text,
      source_text_sha256: hash(text), caption_text_sha256: hash(text), spoken_text_sha256: hash(text), word_count: count(text),
      source_unit_refs: [sourceRef], source_segment_ids: [scene.id], spoken_text_lineage: lineage, spoken_text_transformations: [],
      merge_barrier: true, boundary_after: index === scenes.length - 1 ? "episode_end" : "paragraph",
      voice_id: PIN.voice_id, voice_sha256: PIN.voice_sha256, performance_intent: {}, evidence_source_ids: scene.source_ids,
      audio_origin: "narration", text_mode: scene.audio.text_mode, qwen_instruct: null };
  });
  need(units.reduce((sum, row) => sum + row.word_count, 0) <= 300, "Private proof text exceeds three hundred words.");
  const batchPlan = buildQwenLiamBatchPlan(units, policy.synthesis_contract), cohorts = qwenBatchBindingByUnit(batchPlan);
  for (const unit of units) {
    unit.synthesis_cohort = cohorts.get(unit.unit_id);
    unit.provider_request = compileNarrationProviderRequest(unit, { provider: PIN.provider, modelId: PIN.model_id,
      modelRevision: PIN.model_revision, voiceId: PIN.voice_id, voiceSha256: PIN.voice_sha256,
      voiceContinuityContract: PIN.voice_continuity_contract, referenceAudioPath: PIN.reference_audio_path,
      referenceText: PIN.reference_text, seed: unit.synthesis_cohort.batch_seed });
  }
  const sourceArtifactHashes = { editorial_plan_sha256: identity.plan.sha256 };
  const plan = { schema: "goldflow_tts_generation_plan_v2", status: "passed", true_crime_proof_adapter_version: TRUE_CRIME_PROOF_NARRATION_VERSION,
    source_script_hash: scriptHash, source_hashes: { ...sourceArtifactHashes, script_clean_sha256: scriptHash, run_identity_sha256: identityHash },
    primary_provider: PIN.provider, fallback_provider: null, narrator_voice_id: PIN.voice_id, narrator_voice_sha256: PIN.voice_sha256,
    tts_native_speed: null, unit_count: units.length, units, qwen_liam_batch_plan: batchPlan,
    segments: units.map((unit) => ({ segment_id: unit.scene_id, generation_units: [unit], narration_generation_units: [unit], qwen_generation_units: [unit] })),
    sentence_unit_boundary_integrity: { status: "passed", unit_count: units.length, clean_start_count: units.length,
      terminal_punctuation_count: units.length, within_hard_word_maximum_count: units.length, within_voice_segment_boundary_count: units.length, blocker_count: 0, blockers: [] },
    text_integrity_coverage: { status: "passed", verification: "exact_authorized_scene_text_and_contiguous_script_bytes",
      script_to_plan_source: { status: "passed", expected_token_count: tokens(scriptText), actual_token_count: units.reduce((sum, row) => sum + tokens(row.source_text), 0) },
      plan_source_to_spoken: { status: "passed", unit_count: units.length, expected_token_count: tokens(scriptText), actual_token_count: tokens(scriptText), mismatch_unit_count: 0 }, findings: [] },
    system_ui_speech_coverage: { status: "passed", expected_count: 0, planned_count: 0, missing_count: 0, unexpected_count: 0, missing: [], unexpected: [] } };
  const spokenTextAudit = buildTtsSpokenTextAudit({ plan, sourceScriptSha256: scriptHash, provider: PIN.provider, voiceId: PIN.voice_id });
  need(spokenTextAudit.status === "passed", "Exact spoken-text audit blocked.");
  plan.tts_spoken_text_audit = { status: "passed", audit_sha256: spokenTextAudit.audit_sha256,
    unit_contract_sha256: spokenTextAudit.unit_contract_sha256, blocker_count: spokenTextAudit.blocker_count };
  plan.plan_sha256 = canonicalNarrationPlanSha256(plan);
  const textIr = buildNarrationTextIr({ sourceScriptSha256: scriptHash, generationPlanSha256: plan.plan_sha256, units });
  const planPolicy = validateNarrationTextIr(textIr, units, { sourceScriptSha256: scriptHash, generationPlanSha256: plan.plan_sha256 });
  need(planPolicy.status === "passed", "Exact text lineage failed.");
  return { plan, textIr, spokenTextAudit, policy, planPolicy, sourceArtifactHashes, identityHash, scriptHash, batchPlan };
}

/** Lossless PCM inspection; no trimming, normalization or inferred speech edges. */
export function inspectTrueCrimeProofWav(bytes) {
  need(bytes.length >= 44 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE", "Unreadable WAV.");
  let format = null, data = null;
  for (let cursor = 12; cursor + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", cursor, cursor + 4), size = bytes.readUInt32LE(cursor + 4), start = cursor + 8;
    need(start + size <= bytes.length, "Truncated WAV chunk.");
    if (id === "fmt ") { need(size >= 16, "Invalid WAV format."); format = { code: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sample_rate_hz: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) }; }
    if (id === "data") { need(data === null, "Duplicate WAV data."); data = bytes.subarray(start, start + size); }
    cursor = start + size + size % 2;
  }
  need(format?.code === 1 && format.channels === 1 && format.sample_rate_hz === 24000 && format.bits === 16 && data?.length > 0 && data.length % 2 === 0, "Expected positive 24 kHz mono PCM16 WAV.");
  let peak = 0, energy = 0, clipped = 0;
  for (let i = 0; i < data.length; i += 2) { const value = data.readInt16LE(i) / 32768; peak = Math.max(peak, Math.abs(value)); energy += value * value; if (Math.abs(value) >= 0.999) clipped++; }
  need(peak > 0 && energy > 0, "Silent WAV cannot be accepted.");
  return { data, sample_count: data.length / 2, duration_sec: data.length / 48000, sample_rate_hz: 24000, channels: 1,
    sample_peak: peak, clipped_sample_count: clipped, rms_dbfs: 20 * Math.log10(Math.sqrt(energy / (data.length / 2))) };
}

function wavBytes(data) {
  const h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(data.length + 36, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export function stitchTrueCrimeProofUnits({ units, wavs, qualityContract }) {
  need(units.length === wavs.length && units.length > 0, "Every ordered unit requires its WAV.");
  const pieces = [], prepared = [], boundaries = [], timeline = []; let cursor = 0;
  for (const [index, unit] of units.entries()) {
    const info = inspectTrueCrimeProofWav(wavs[index]);
    pieces.push(info.data); prepared.push({ unit_id: unit.unit_id, sample_count: info.sample_count });
    timeline.push({ scene_id: unit.scene_id, unit_id: unit.unit_id, text: unit.spoken_text, source_text_sha256: unit.spoken_text_sha256,
      start_sample: cursor, end_sample: cursor + info.sample_count, start_sec: cursor / 24000, end_sec: (cursor + info.sample_count) / 24000, duration_sec: info.duration_sec });
    cursor += info.sample_count;
    if (index < units.length - 1) {
      // Alignment is deliberately absent: preserve the complete raw units. The
      // authored paragraph gap is additional, not an amplitude-based trim.
      const gap = planNarrationBoundary({ leftUnit: unit, rightUnit: units[index + 1], leftPrepared: {}, rightPrepared: {}, contract: qualityContract });
      need(gap.status === "passed", "Invalid semantic boundary.");
      boundaries.push({ ...gap, after_unit_id: unit.unit_id, before_unit_id: units[index + 1].unit_id, gap_sample_count: gap.inserted_silence_sample_count });
      pieces.push(Buffer.alloc(gap.inserted_silence_sample_count * 2)); cursor += gap.inserted_silence_sample_count;
    }
  }
  const accounting = validateNarrationStitchAccounting({ preparedInputs: prepared, boundaries, finalSampleCount: cursor, sampleRate: 24000 });
  need(accounting.status === "passed", "Narration sample accounting failed.");
  const output = wavBytes(Buffer.concat(pieces));
  need(inspectTrueCrimeProofWav(output).sample_count === cursor && cursor / 24000 <= 150, "Narration exceeds its bounded duration or sample count.");
  return { bytes: output, timeline, boundaries, accounting, duration_sec: cursor / 24000,
    policy: { raw_units_preserved: true, edge_trimming: false, fades: false, tempo_processing: false, minimum_duration_padding: false } };
}

async function references() {
  const result = {};
  for (const [label, file, expected] of [
    ["reference_audio", PIN.reference_audio_path, PIN.reference_audio_sha256], ["reference_manifest", PIN.reference_manifest_path, PIN.reference_manifest_sha256],
    ["reference_metadata", PIN.reference_metadata_path, PIN.reference_metadata_sha256], ["speaker_similarity_model", PIN.speaker_similarity_model_path, PIN.speaker_similarity_model_sha256],
  ]) { const actual = hash(await fs.readFile(file)); need(actual === expected, `Pinned runtime reference changed: ${label}`); result[label] = { path: file, expected, actual }; }
  result.reference_text = { path: null, expected: PIN.reference_text_sha256, actual: hash(PIN.reference_text) };
  return result;
}

async function deliveryQa(units, rows, rawPath, quality, outputDir) {
  const helpers = await import("../modelslab-qwen-episode-audio.mjs");
  const inputs = [...rows, { unit_id: "full-stream", wav: rawPath, text: units.map((row) => row.spoken_text).join(" ") }];
  const primary = await helpers.runFasterWhisperUnitBatchForDiagnostics(inputs, { model: "small.en", device: "cpu", computeType: "int8_float32" });
  const first = new Map(), confirm = [];
  for (const row of inputs) {
    const transcript = primary.get(row.unit_id); need(transcript, `ASR omitted ${row.unit_id}`);
    const qa = helpers.transcriptQaForTests(row.text, transcript.text, { maxWer: 0.05, blockAnySubstitution: false });
    const decision = strictNarrationDeliveryDecision(qa, { orderQa: { blockers: [] }, joinQa: { blockers: [], warnings: [] }, contract: quality });
    first.set(row.unit_id, { recognized: transcript, transcript_qa: qa, decision });
    if (narrationDeliveryNeedsConfirmation(qa, decision)) confirm.push(row);
  }
  const secondary = confirm.length ? await helpers.runFasterWhisperUnitBatchForDiagnostics(confirm, { model: "medium", device: "cpu", computeType: "int8_float32" }) : new Map();
  const findings = inputs.map((row) => {
    const p = first.get(row.unit_id), recognized = secondary.get(row.unit_id);
    const q = recognized ? helpers.transcriptQaForTests(row.text, recognized.text, { maxWer: 0.05, blockAnySubstitution: false }) : null;
    const consensus = adjudicateNarrationDeliveryConsensus({ primaryTranscriptQa: p.transcript_qa, confirmationTranscriptQa: q,
      primaryModel: "small.en", confirmationModel: "medium", contract: quality });
    return { unit_id: row.unit_id, primary: p, confirmation: recognized ? { recognized, transcript_qa: q } : null, consensus };
  });
  const report = { schema: "goldflow_true_crime_proof_delivery_qa_v1", status: findings.every((row) => row.consensus.status === "passed") ? "passed" : "needs_review",
    full_stream_included: true, units: findings, human_listening_performed: false, automatic_retry_allowed: false };
  await writeNew(path.join(outputDir, "delivery-qa.json"), report); return report;
}

/** Called by the dedicated private-proof stage controller, after its immutable
 * identity, exact script authorization and one-attempt marker have been written.
 * The dependency seam is only for provider-free tests, never a CLI override. */
export function createTrueCrimeProofNarrationProducer({
  loadIdentity = async (args) => (await import("./true-crime-proof-workflow.mjs")).loadTrueCrimeProofIdentity(args),
  synthesize = async (args) => (await import("../narration-tts-episode.mjs")).runSynthesis(args),
  inspectReferences = references, readReference = readBound, checkDelivery = deliveryQa, checkVoice = runNarrationVoiceContinuityQa, master = masterNarrationTwoPass,
} = {}) {
  return async function produceTrueCrimeProofNarration({ proofDir, outputDir }) {
    proofDir = path.resolve(proofDir); outputDir = path.resolve(outputDir);
    need(outputDir === path.join(proofDir, "attempts/narration/output"), "Narration output must belong to its guarded attempt.");
    const current = await loadIdentity({ proofDir }), identity = current.identity;
    const identityPath = path.join(proofDir, "run_identity.json"), identityBytes = await fs.readFile(identityPath);
    const attempt = JSON.parse(await fs.readFile(path.join(proofDir, "attempts/narration/start.json"), "utf8"));
    need(attempt.stage === "narration" && attempt.identity_sha256 === current.identity_sha256 && attempt.automatic_retry_allowed === false,
      "A current guarded narration attempt must exist before calling the producer.");
    const planBytes = await readBound(identity.plan), scriptBytes = await readBound(identity.script);
    need(hash(identityBytes) === current.identity_sha256 && scriptBytes.toString("utf8") === current.scriptText, "Workflow identity or script changed.");
    const referenceText = await readReference(identity.narration.reference_text); need(referenceText.toString("utf8") === PIN.reference_text, "Pinned reference transcript changed.");
    await readReference(identity.narration.reference_audio);
    const built = buildTrueCrimeProofNarrationPlan({ editorialPlan: current.plan, editorialPlanBytes: planBytes, identity, identityBytes, scriptText: current.scriptText });
    const refHashes = await inspectReferences(), runnerPath = path.join(ROOT, "scripts/tts-local-production-runner.py");
    const marker = path.join(outputDir, "narration-invocation.json");
    await fs.mkdir(outputDir, { recursive: true });
    await writeNew(marker, { adapter: TRUE_CRIME_PROOF_NARRATION_VERSION, identity_sha256: built.identityHash,
      source_script_sha256: built.scriptHash, one_creative_attempt: true, started_at: new Date().toISOString() });
    const refs = {};
    refs.plan = await writeNew(path.join(outputDir, "narration-generation-plan.json"), built.plan);
    refs.ir = await writeNew(path.join(outputDir, "narration-text-ir.json"), built.textIr);
    refs.audit = await writeNew(path.join(outputDir, "spoken-text-audit.json"), built.spokenTextAudit);
    const runtime = { adapter: await binding(fileURLToPath(import.meta.url)), worker: await binding(runnerPath), python_path: TRUE_CRIME_PROOF_QWEN_PYTHON,
      voice_policy: built.policy, reference_asset_hashes: refHashes, provider_cost_usd: 0, provider_network_required: false };
    await writeNew(path.join(outputDir, "runtime-provenance.json"), runtime);
    const gate = buildNarrationPreSynthesisGate({ plan: built.plan, planPath: refs.plan.path, planFileSha256: refs.plan.sha256,
      identityPath, identityFileSha256: built.identityHash, scriptPath: identity.script.path, scriptSha256: built.scriptHash,
      policy: built.policy, planPolicy: built.planPolicy, sourceArtifactHashes: built.sourceArtifactHashes,
      textIr: built.textIr, textIrPath: refs.ir.path, textIrFileSha256: refs.ir.sha256,
      spokenTextAudit: built.spokenTextAudit, spokenTextAuditPath: refs.audit.path, spokenTextAuditFileSha256: refs.audit.sha256,
      referenceAssetHashes: refHashes, synthesisScope: { mode: "initial_full_synthesis", authorized_synthesis_unit_ids: built.plan.units.map((row) => row.unit_id),
        preserved_unit_ids: [], evidence_path: identityPath, evidence_sha256: built.identityHash } });
    await writeNew(path.join(outputDir, "pre-synthesis-validation.json"), gate);
    need(gate.status === "passed", `Narration blocked before synthesis: ${JSON.stringify(gate.findings)}`);
    const authorized = authorizeNarrationPreSynthesisGate(gate), authorizedRef = await writeNew(path.join(outputDir, "pre-synthesis-authorized.json"), authorized);
    const execution = await synthesize({ route: "qwen", attempt: 1, units: built.plan.units, policy: built.policy, batchPlan: built.batchPlan,
      synthesisMode: built.policy.synthesis_contract.mode, outputDir: path.join(outputDir, "execution"), python: TRUE_CRIME_PROOF_QWEN_PYTHON,
      runnerPath, invocationId: randomUUID(), preSynthesisGate: authorized, preSynthesisGatePath: authorizedRef.path,
      preSynthesisGateFileSha256: authorizedRef.sha256, planPath: refs.plan.path, planSha256: built.plan.plan_sha256,
      planFileSha256: refs.plan.sha256, identityPath, identityFileSha256: built.identityHash, scriptPath: identity.script.path, scriptSha256: built.scriptHash });
    need(execution.report.status === "passed" && same(execution.results.map((row) => row.unit_id), built.plan.units.map((row) => row.unit_id)), "Synthesis failed or changed unit coverage; preserve evidence and inspect exact units.");
    const rows = [], wavs = [];
    for (const [index, result] of execution.results.entries()) {
      const unit = built.plan.units[index], bytes = await fs.readFile(result.output_path);
      need(hash(bytes) === result.output_sha256 && result.spoken_text_sha256 === unit.spoken_text_sha256 && result.token_limit_reached === false, "Synthesis output hash/text/token evidence failed.");
      const metrics = inspectTrueCrimeProofWav(bytes); wavs.push(bytes);
      rows.push({ unit_id: unit.unit_id, scene_id: unit.scene_id, text: unit.spoken_text, spoken_text_sha256: unit.spoken_text_sha256,
        wav: result.output_path, audio_sha256: result.output_sha256, duration_sec: metrics.duration_sec, metrics: { ...metrics, data: undefined },
        synthesis_identity_sha256: result.synthesis_identity_sha256, source_ids: unit.evidence_source_ids });
    }
    const stitched = stitchTrueCrimeProofUnits({ units: built.plan.units, wavs, qualityContract: built.policy.narration_quality_contract });
    const rawPath = path.join(outputDir, "narration-raw-concatenated.wav"); await fs.writeFile(rawPath, stitched.bytes, { flag: "wx" });
    const stitchRef = await writeNew(path.join(outputDir, "narration-stitch.json"), { ...stitched, bytes: undefined, raw_audio: await binding(rawPath), raw_units: rows });
    const quality = built.policy.narration_quality_contract;
    let delivery, voice;
    try { delivery = await checkDelivery(built.plan.units, rows, rawPath, quality, outputDir); }
    catch (error) { delivery = { status: "needs_review", error: error.message, human_listening_performed: false }; await writeNew(path.join(outputDir, "delivery-qa-unavailable.json"), delivery); }
    try { voice = await checkVoice({ rows, profile: built.policy.primary, qualityContract: quality, reportPath: path.join(outputDir, "voice-continuity.json") }); }
    catch (error) { voice = { status: "needs_review", error: error.message }; }
    await writeNew(path.join(outputDir, "voice-continuity-result.json"), voice);
    const clips = rows.some((row) => row.metrics.clipped_sample_count > 0);
    const deliveryAccepted = delivery.status === "passed" && voice.status === "passed" && !clips;
    let mastering = { status: "pending_delivery_review", input_path: rawPath, reason: "No mastering before delivery acceptance; untouched candidate remains reviewable." }, candidatePath = rawPath;
    if (deliveryAccepted) {
      mastering = await master({ inputPath: rawPath, outputPath: path.join(outputDir, "narration-mastered.wav"), reportPath: path.join(outputDir, "narration-mastering.json"),
        targetLufs: -16, truePeakDbtp: -1.5, sampleRateHz: 24000, channels: 1, integratedTolerance: 1, durationDeltaMsMax: 10 });
      if (mastering.status === "passed") candidatePath = mastering.output_path;
    }
    const audioRef = await binding(candidatePath), technicalQa = deliveryAccepted && mastering.status === "passed" ? "passed" : "needs_review";
    const report = { schema: "goldflow_true_crime_proof_narration_result_v1", status: "candidate_awaiting_listening", adapter_version: TRUE_CRIME_PROOF_NARRATION_VERSION,
      identity_sha256: built.identityHash, source_text_sha256: built.scriptHash, editorial_plan_sha256: identity.plan.sha256,
      voice: identityVoice(identity), unit_ids: built.plan.units.map((row) => row.unit_id), raw_units: rows, timeline: stitched.timeline,
      measured_duration_sec: stitched.duration_sec, audio: audioRef, stitch: stitchRef, generation_plan: refs.plan,
      runner_report: { path: execution.reportPath, sha256: execution.reportSha256 }, cohort_events: { path: execution.cohortEventsPath, sha256: execution.cohortEventsSha256 },
      pre_synthesis_gate: authorizedRef, delivery_qa: delivery, voice_continuity: voice, mastering, technical_qa: technicalQa,
      human_listening_performed: false, subjective_approval: null, production_eligible: false, publish_allowed: false, cost_usd: 0, completed_at: new Date().toISOString() };
    const receipt = await writeNew(path.join(outputDir, "narration-result.json"), report);
    return { artifacts: [{ id: "narration-audio", ...audioRef, kind: "narration_audio", source_text_sha256: built.scriptHash },
      { id: "narration-receipt", ...receipt, kind: "narration_receipt" }, { id: "narration-stitch", ...stitchRef, kind: "narration_timing" },
      ...rows.map((row) => ({ id: `raw-${row.scene_id}`, path: row.wav, sha256: row.audio_sha256, kind: "raw_narration_unit" })),
      { id: "qwen-runner-report", path: execution.reportPath, sha256: execution.reportSha256, kind: "provider_receipt" },
      { id: "qwen-cohort-events", path: execution.cohortEventsPath, sha256: execution.cohortEventsSha256, kind: "provider_events" },
      { id: "pre-synthesis-gate", ...authorizedRef, kind: "synthesis_gate" },
      { id: "narration-plan", ...refs.plan, kind: "narration_plan" }, { id: "narration-text-ir", ...refs.ir, kind: "text_lineage" },
      { id: "narration-text-audit", ...refs.audit, kind: "text_audit" }],
      metadata: { source_text_sha256: built.scriptHash, voice: identityVoice(identity), measured_duration_sec: stitched.duration_sec,
        tempo: 1, technical_qa: technicalQa, human_listening_performed: false }, cost_usd: 0 };
  };
}

export const produceTrueCrimeProofNarration = createTrueCrimeProofNarrationProducer();
