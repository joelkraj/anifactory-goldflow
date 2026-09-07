import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256File } from "./file-hash.mjs";
import { readFootageSource, validateFootageClipReceipt } from "./footage-library.mjs";
import { validateNarrationSubjectiveReviewDecision } from "./narration-subjective-review.mjs";
import { QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK as JOEL } from "./narration-tts-policy.mjs";
import { canonicalNarrationPlanSha256, narrationPreSynthesisGateSha256, NARRATION_PRE_SYNTHESIS_GATE_SCHEMA } from "./narration-pre-synthesis-gate.mjs";
import { validateNarrationTextIr } from "./narration-text-ir.mjs";
import { narrationProviderRequestSha256, narrationSynthesisIdentitySha256, validateNarrationProviderOutputManifest } from "./narration-provider-adapter.mjs";
import { ttsSpokenTextAuditMatches } from "./tts-spoken-text-audit.mjs";
import { canonicalQwenBatchSha256 } from "./qwen-liam-batch-contract.mjs";

const execute = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[a-z][a-z0-9_-]{0,79}$/u;
const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value) => typeof value === "string" && Boolean(value.trim());
const pass = (findings, extra = {}) => ({ status: findings.length ? "blocked" : "passed", findings, ...extra });
const check = (findings, condition, code, id = null) => { if (!condition) findings.push({ code, ...(id ? { id } : {}) }); };
const KINDS = Object.freeze({ movie_clip: "film_evidence", host_pose: "original_host", background: "original_background", concept_still: "hypothetical_concept", concept_video: "hypothetical_concept", narration: "original_commentary" });
const sensitiveKey = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|cookies|bearer|password|signed[_-]?(?:media[_-]?)?url|session[_-]?(?:state|token))$/iu;
const sensitiveText = /(?:\bBearer\s+[a-z0-9._-]+|https?:\/\/[^\s"<>]*(?:[?&](?:token|sig(?:nature)?|api_key|key|auth|x-amz-[^=]*)=|\/apikey\/)|https?:\/\/[^\s/]+:[^\s/]+@)/iu;
export const PILOT_NARRATION_IMPORT_ADAPTER_STATUS = "unproven";
export const PILOT_NARRATION_IMPORT_BLOCKER = "pilot_narration_lineage_import_adapter_not_proven";
const narrationResult = (findings, extra = {}) => pass(
  [...findings, { code: PILOT_NARRATION_IMPORT_BLOCKER }],
  { import_adapter_status: PILOT_NARRATION_IMPORT_ADAPTER_STATUS, ...extra },
);

export function pilotArtifactContainsPrivateData(value) {
  if (typeof value === "string") return sensitiveText.test(value);
  if (Array.isArray(value)) return value.some(pilotArtifactContainsPrivateData);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, child]) => sensitiveKey.test(key) || pilotArtifactContainsPrivateData(child));
}

function identityFindings(identity) {
  const findings = [];
  check(findings, identity?.media_workflow === "avatar_footage_pilot_v1" && identity?.content_profile === "mcu_what_if_pilot_v1", "pilot_identity_route_invalid");
  check(findings, identity?.production_eligible === false && identity?.run_intent === "proof", "pilot_identity_proof_required");
  check(findings, !pilotArtifactContainsPrivateData(identity), "pilot_identity_private_data_forbidden");
  return findings;
}

export function validatePilotScript(script, evidence) {
  const findings = [];
  const wordCount = typeof script === "string" ? (script.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length : 0;
  check(findings, text(script) && wordCount > 0 && wordCount <= 300 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]|```|<script\b|<iframe\b/iu.test(script ?? ""), "pilot_script_plain_markdown_and_300_word_limit");
  check(findings, !pilotArtifactContainsPrivateData({ script, evidence }), "pilot_script_private_data_forbidden");
  check(findings, evidence?.schema === "goldflow_avatar_pilot_evidence_v1", "pilot_evidence_schema_invalid");
  check(findings, evidence?.source_script_sha256 === digest(typeof script === "string" ? script : ""), "pilot_evidence_script_hash_mismatch");
  const claims = Array.isArray(evidence?.claims) ? evidence.claims : [];
  check(findings, claims.length > 0 && claims.length <= 80, "pilot_evidence_claims_missing_or_excessive");
  check(findings, new Set(claims.map((row) => row?.id)).size === claims.length, "pilot_evidence_duplicate_claim_ids");
  for (const claim of claims) {
    check(findings, ID.test(claim?.id ?? "") && text(claim?.text) && ["film_fact", "assumption", "speculation", "limitation"].includes(claim?.kind), "pilot_evidence_claim_invalid", claim?.id);
    if (claim?.kind === "film_fact") {
      const source = claim.source;
      check(findings, text(source?.title) && text(source?.edition) && text(source?.locator) && text(source?.rights_basis)
        && Number.isFinite(source?.source_in_sec) && source.source_in_sec >= 0
        && Number.isFinite(source?.source_out_sec) && source.source_out_sec > source.source_in_sec
        && source?.reviewed === true, "pilot_film_fact_requires_exact_reviewed_source", claim.id);
    }
  }
  for (const kind of ["film_fact", "assumption", "speculation", "limitation"]) {
    check(findings, claims.some((row) => row?.kind === kind), `pilot_evidence_${kind}_required`);
  }
  check(findings, text(evidence?.review?.reviewer) && text(evidence?.review?.note)
    && evidence?.review?.all_factual_abilities_reviewed === true && evidence?.review?.mcu_only === true, "pilot_evidence_human_coverage_review_required");
  return pass(findings, { word_count: wordCount, verification_scope: "structural_and_recorded_review_only_not_independent_canon_or_rights_verification" });
}

export function validatePilotAssetPlan(plan, identity) {
  const findings = identityFindings(identity);
  check(findings, plan?.schema === "goldflow_avatar_pilot_asset_plan_v1" && HASH.test(plan?.source_script_sha256 ?? ""), "pilot_asset_plan_schema_or_script_hash_invalid");
  check(findings, !pilotArtifactContainsPrivateData(plan), "pilot_asset_plan_private_data_forbidden");
  const assets = Array.isArray(plan?.assets) ? plan.assets : [];
  check(findings, assets.length > 0 && assets.length <= 40, "pilot_asset_plan_scope_invalid");
  check(findings, new Set(assets.map((row) => row?.id)).size === assets.length, "pilot_asset_plan_duplicate_ids");
  check(findings, assets.filter((row) => row?.kind === "narration").length === 1, "pilot_asset_plan_one_narration_required");
  for (const row of assets) {
    check(findings, ID.test(row?.id ?? "") && Object.hasOwn(KINDS, row?.kind ?? "") && text(row?.purpose) && text(row?.provider) && text(row?.model), "pilot_asset_plan_row_invalid", row?.id);
    check(findings, row?.truth_mode === KINDS[row?.kind], "pilot_asset_truth_mode_invalid", row?.id);
    if (row?.kind === "movie_clip") {
      check(findings, ["local", "torbox", "real_debrid"].includes(row.provider) && row.model === "source_native", "pilot_movie_source_provider_invalid", row.id);
    } else if (row?.kind === "narration") {
      const lock = identity?.pilot_providers?.narration;
      check(findings, row.provider === "qwen_local" && row.provider === lock?.provider && row.model === lock?.model && lock?.voice_id === JOEL.voice_id, "pilot_narration_provider_not_locked", row.id);
    } else if (row?.kind === "concept_video") {
      const lock = identity?.pilot_providers?.video;
      check(findings, lock?.enabled === true && row.provider === "google_flow" && row.provider === lock.provider && row.model === lock.model, "pilot_flow_video_not_opted_in", row.id);
      check(findings, ID.test(row.first_frame_asset_id ?? "") && assets.some((asset) => asset.id === row.first_frame_asset_id && asset.kind === "concept_still"), "pilot_flow_first_frame_plan_missing", row.id);
    } else {
      const allowed = ["google_gemini_imagen", "google_flow", "codex_imagegen"];
      const locks = Array.isArray(identity?.pilot_providers?.stills) ? identity.pilot_providers.stills : [];
      check(findings, allowed.includes(row?.provider) && locks.some((lock) => lock.provider === row.provider && lock.model === row.model), "pilot_still_provider_not_locked", row?.id);
      check(findings, row?.provider !== "codex_imagegen" || ["host_pose", "background"].includes(row?.kind), "pilot_codex_original_host_background_only", row?.id);
    }
  }
  return pass(findings);
}

async function boundFile(ref, episodeDir) {
  if (!text(ref?.path) || !HASH.test(ref?.sha256 ?? "") || /^[a-z][a-z0-9+.-]*:/iu.test(ref.path) || ref.path.includes("\u0000")) throw new Error("local_file_binding_invalid");
  const resolved = path.resolve(episodeDir, ref.path);
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || await sha256File(resolved) !== ref.sha256) throw new Error("local_file_missing_or_hash_mismatch");
  return resolved;
}

async function boundJson(ref, episodeDir) {
  const resolved = await boundFile(ref, episodeDir);
  if ((await fs.stat(resolved)).size > 32 * 1024 * 1024) throw new Error("receipt_size_limit");
  const document = JSON.parse(await fs.readFile(resolved, "utf8"));
  if (!isObject(document) || pilotArtifactContainsPrivateData(document)) throw new Error("receipt_malformed_or_private_data_forbidden");
  return { document, path: resolved };
}

async function probe(filePath) {
  const { stdout } = await execute("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,duration,sample_rate,channels:format=duration", "-of", "json", filePath], {
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin", LANG: "C" },
  });
  return JSON.parse(stdout);
}

const unitsFrom = (plan) => Array.isArray(plan?.units) ? plan.units : (plan?.segments ?? []).flatMap((segment) => segment.generation_units ?? segment.narration_generation_units ?? segment.qwen_generation_units ?? []);
const sourceTokens = (value) => (String(value ?? "").toLowerCase().replaceAll("’", "'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []);

export function validatePilotNarrationSourceCoverage(script, units, phase) {
  const findings = [];
  const expected = sourceTokens(script);
  const actual = units.flatMap((unit) => sourceTokens(unit?.source_text));
  check(findings, expected.length > 0 && actual.length > 0 && actual.length <= expected.length && actual.every((word, index) => word === expected[index])
    && (phase === "sample" || actual.length === expected.length), "pilot_narration_approved_source_coverage_invalid");
  check(findings, units.every((unit) => JSON.stringify(sourceTokens(unit?.caption_text)) === JSON.stringify(sourceTokens(unit?.source_text))), "pilot_narration_caption_source_mismatch");
  return pass(findings);
}

export async function validatePilotNarrationBundle(bundle, { episodeDir, identity, phase = bundle?.phase, sourceScriptSha256 } = {}) {
  const findings = identityFindings(identity);
  check(findings, bundle?.schema === "goldflow_avatar_pilot_narration_bundle_v1" && ["sample", "full"].includes(phase) && bundle?.phase === phase, "pilot_narration_bundle_schema_or_phase_invalid");
  check(findings, HASH.test(sourceScriptSha256 ?? "") && bundle?.source_script_sha256 === sourceScriptSha256, "pilot_narration_current_script_required");
  check(findings, !pilotArtifactContainsPrivateData(bundle), "pilot_narration_private_data_forbidden");
  const lock = identity?.pilot_providers?.narration ?? {};
  for (const key of ["voice_id", "voice_sha256", "reference_audio_sha256", "reference_text_sha256"]) {
    check(findings, lock[key] === JOEL[key], `pilot_narration_owned_joel_${key}_required`);
  }
  check(findings, lock.provider === "qwen_local" && lock.model === JOEL.model_id && lock.model_revision === JOEL.model_revision, "pilot_narration_model_lock_required");
  const lineageKeys = ["pre_synthesis_gate", "spoken_text_ir", "spoken_text_audit", "provider_output_manifest"];
  check(findings, lineageKeys.every((key) => text(bundle?.[key]?.path) && HASH.test(bundle?.[key]?.sha256 ?? "")), "pilot_narration_canonical_lineage_receipts_required");
  if (findings.length) return narrationResult(findings);
  try {
    const scriptPath = await boundFile(identity.source_script, episodeDir);
    check(findings, identity.source_script.sha256 === sourceScriptSha256, "pilot_narration_identity_source_hash_mismatch");
    const approvedScript = await fs.readFile(scriptPath, "utf8");
    const audioPath = await boundFile(bundle.audio, episodeDir);
    const audioProbe = await probe(audioPath);
    const streams = audioProbe.streams ?? [];
    const duration = Number(audioProbe.format?.duration);
    check(findings, streams.length === 1 && streams[0].codec_type === "audio" && streams[0].codec_name === "pcm_s16le" && Number(streams[0].sample_rate) === 24000 && streams[0].channels === 1, "pilot_narration_canonical_wav_required");
    check(findings, phase === "sample" ? duration >= 14.85 && duration <= 20.15 : duration > 20 && duration <= 90, "pilot_narration_phase_duration_invalid");
    const refs = {};
    for (const key of ["generation_plan", "tts_report", "stitch_report", "full_stream_qa", "voice_continuity", "subjective_manifest", "subjective_decision", "whisper_timing", ...lineageKeys]) refs[key] = await boundJson(bundle[key], episodeDir);
    const plan = refs.generation_plan.document;
    const tts = refs.tts_report.document;
    const stitch = refs.stitch_report.document;
    const delivery = refs.full_stream_qa.document;
    const continuity = refs.voice_continuity.document;
    const subjective = refs.subjective_manifest.document;
    const decision = refs.subjective_decision.document;
    const timing = refs.whisper_timing.document;
    const audioHash = bundle.audio.sha256;
    const canonicalUnits = unitsFrom(plan);
    findings.push(...validatePilotNarrationSourceCoverage(approvedScript, canonicalUnits, phase).findings);
    const gate = refs.pre_synthesis_gate.document;
    const ir = refs.spoken_text_ir.document;
    const audit = refs.spoken_text_audit.document;
    const providerOutput = refs.provider_output_manifest.document;
    check(findings, plan.schema === "goldflow_tts_generation_plan_v2" && plan.status === "passed" && plan.plan_sha256 === canonicalNarrationPlanSha256(plan), "pilot_narration_canonical_plan_invalid");
    check(findings, canonicalUnits.every((unit) => unit.spoken_text_lineage?.schema === "goldflow_spoken_text_lineage_v1" && unit.spoken_text_lineage.final_spoken_text === unit.spoken_text)
      && ir.units?.every((unit) => unit.spoken_text_lineage_required === true)
      && validateNarrationTextIr(ir, canonicalUnits, { sourceScriptSha256, generationPlanSha256: plan.plan_sha256 }).status === "passed", "pilot_narration_closed_spoken_lineage_invalid");
    check(findings, ttsSpokenTextAuditMatches({ audit, plan, sourceScriptSha256, overridesSha256: gate.bindings?.tts_spoken_overrides_sha256 }) && audit.blocker_count === 0, "pilot_narration_spoken_audit_invalid");
    check(findings, gate.schema === NARRATION_PRE_SYNTHESIS_GATE_SCHEMA && gate.status === "passed" && gate.gate_sha256 === narrationPreSynthesisGateSha256(gate)
      && gate.model_load_performed === true && gate.synthesis_invoked === true && !(gate.findings ?? []).length
      && gate.bindings?.script_sha256 === sourceScriptSha256 && gate.bindings?.narration_generation_plan_file_sha256 === bundle.generation_plan.sha256
      && gate.bindings?.narration_generation_plan_sha256 === plan.plan_sha256 && gate.bindings?.narration_text_ir_file_sha256 === bundle.spoken_text_ir.sha256
      && gate.bindings?.tts_spoken_text_audit_file_sha256 === bundle.spoken_text_audit.sha256, "pilot_narration_pre_synthesis_lineage_invalid");
    for (const [key, expected] of Object.entries({ provider: lock.provider, model_id: lock.model, model_revision: lock.model_revision, voice_id: lock.voice_id, voice_sha256: lock.voice_sha256, reference_audio_sha256: lock.reference_audio_sha256, reference_text_sha256: lock.reference_text_sha256 })) check(findings, gate.contract?.[key] === expected, "pilot_narration_pre_synthesis_identity_invalid");
    for (const unit of canonicalUnits) {
      const compiled = unit.provider_request; const request = compiled?.request; const synthesis = compiled?.synthesis_identity;
      check(findings, compiled?.status === "compiled" && request?.text === unit.spoken_text && compiled.request_sha256 === narrationProviderRequestSha256(request)
        && compiled.synthesis_identity_sha256 === narrationSynthesisIdentitySha256(synthesis) && synthesis?.provider_request_sha256 === compiled.request_sha256
        && request?.provider === lock.provider && request?.model_id === lock.model && request?.model_revision === lock.model_revision
        && request?.voice_id === lock.voice_id && request?.voice_sha256 === lock.voice_sha256 && request?.reference_text === JOEL.reference_text
        && request?.reference_audio_path === JOEL.reference_audio_path && request?.instruction == null && request?.style_tags == null && request?.native_speed == null, "pilot_narration_exact_provider_payload_invalid", unit.unit_id);
    }
    check(findings, validateNarrationProviderOutputManifest(providerOutput, canonicalUnits, { generationPlanSha256: plan.plan_sha256, generationPlanFileSha256: bundle.generation_plan.sha256,
      qualityContractSha256: tts.narration_quality_contract_sha256, provider: lock.provider, voiceId: lock.voice_id, voiceSha256: lock.voice_sha256 }).status === "passed"
      && tts.provider_output_manifest_sha256 === bundle.provider_output_manifest.sha256, "pilot_narration_provider_output_lineage_invalid");
    check(findings, (plan.source_script_hash ?? plan.source_script_sha256) === sourceScriptSha256, "pilot_narration_plan_script_stale");
    check(findings, tts.schema === "goldflow_provider_neutral_narration_tts_report_v2" && tts.status === "passed" && tts.source_script_hash === sourceScriptSha256
      && tts.primary_provider === lock.provider && tts.primary_model_id === lock.model && tts.primary_model_revision === lock.model_revision
      && tts.voice_id === lock.voice_id && tts.voice_sha256 === lock.voice_sha256 && tts.post_tempo_normalized === false
      && !tts.operator_narration_qa_waiver && !(tts.fallback_unit_ids ?? []).length, "pilot_narration_tts_contract_invalid");
    for (const key of ["reference_audio_sha256", "reference_text_sha256"]) check(findings, tts.primary?.[key] === lock[key], "pilot_narration_reference_lock_mismatch");
    check(findings, stitch.schema === "goldflow_provider_neutral_narration_stitch_v2" && stitch.status === "passed" && stitch.source_script_hash === sourceScriptSha256
      && stitch.final_wav_sha256 === audioHash && stitch.output_sha256 === audioHash && Math.abs(stitch.final_duration_sec - duration) <= 0.02
      && stitch.sample_accounting?.exact_sample_accounting === true && stitch.sample_accounting.expected_sample_count === stitch.sample_accounting.actual_sample_count
      && !stitch.subjective_review_waiver, "pilot_narration_stitch_contract_invalid");
    check(findings, delivery.schema === "goldflow_narration_full_stream_qa_v2" && delivery.status === "passed" && delivery.source_script_hash === sourceScriptSha256 && delivery.audio_sha256 === audioHash
      && !delivery.operator_narration_qa_waiver && !(delivery.blockers ?? []).length, "pilot_narration_delivery_qa_invalid");
    check(findings, continuity.schema === "goldflow_narration_voice_continuity_qa_v2" && ["passed", "passed_with_warnings"].includes(continuity.status) && continuity.voice_id === lock.voice_id && continuity.voice_sha256 === lock.voice_sha256 && !(continuity.blockers ?? []).length, "pilot_narration_voice_continuity_invalid");
    for (const report of [tts, stitch, delivery, subjective]) check(findings, report.narration_generation_plan_file_sha256 === bundle.generation_plan.sha256, "pilot_narration_report_plan_lineage_stale");
    check(findings, tts.voice_continuity_report_sha256 === bundle.voice_continuity.sha256 && stitch.subjective_review_manifest_sha256 === subjective.manifest_sha256, "pilot_narration_qa_receipt_lineage_stale");
    check(findings, subjective.audio_sha256 === audioHash && validateNarrationSubjectiveReviewDecision(subjective, decision).status === "approved", "pilot_narration_subjective_listen_required");
    const opening = subjective.samples?.find((row) => row.coverage_class === "complete_opening");
    check(findings, opening?.start_sample === 0 && opening?.end_sample_exclusive === subjective.total_sample_count, "pilot_narration_complete_phase_listen_required");
    check(findings, timing.schema === "goldflow_local_whisper_word_timing_v2" && timing.status === "passed" && timing.source_script_hash === sourceScriptSha256
      && timing.narration_audio_hash === audioHash && timing.narration_report_sha256 === bundle.tts_report.sha256
      && timing.alignment_model === "small.en" && timing.alignment_device === "cpu" && timing.alignment_compute_type === "int8_float32"
      && timing.alignment_omp_num_threads === 12 && timing.alignment_cpu_threads === 0, "pilot_narration_whisper_contract_invalid");
    let prior = -1;
    const words = Array.isArray(timing.words) ? timing.words : [];
    check(findings, words.length > 0, "pilot_narration_whisper_words_required");
    for (const word of words) {
      check(findings, text(word.word) && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= prior && word.end >= word.start && word.end <= duration + 0.02, "pilot_narration_whisper_word_invalid");
      prior = word.start;
    }
    const units = unitsFrom(plan);
    const results = Array.isArray(tts.results) ? tts.results : [];
    check(findings, units.length > 0 && units.length === results.length && new Set(units.map((row) => row.unit_id)).size === units.length, "pilot_narration_unit_scope_invalid");
    for (let index = 0; index < results.length; index += 1) {
      const row = results[index]; const unit = units[index];
      check(findings, row.unit_id === unit?.unit_id && row.spoken_text_sha256 === digest(unit?.spoken_text ?? "") && row.token_limit_reached === false && row.voice_id === lock.voice_id && row.voice_sha256 === lock.voice_sha256 && row.model_id === lock.model && row.model_revision === lock.model_revision, "pilot_narration_unit_identity_invalid", row.unit_id);
      await boundFile({ path: row.audio_path, sha256: row.audio_sha256 }, episodeDir);
    }
    if (phase === "full") {
      const accepted = await boundJson(bundle.opening_bundle, episodeDir);
      const sample = await validatePilotNarrationBundle(accepted.document, { episodeDir, identity, phase: "sample", sourceScriptSha256 });
      check(findings, sample.status === "passed", "pilot_narration_opening_bundle_invalid");
      const sampleTts = (await boundJson(accepted.document.tts_report, episodeDir)).document;
      check(findings, (sampleTts.results ?? []).every((row, index) => results[index]?.unit_id === row.unit_id && results[index]?.audio_sha256 === row.audio_sha256 && results[index]?.spoken_text_sha256 === row.spoken_text_sha256), "pilot_narration_accepted_opening_units_changed");
    }
    // The pilot has no proven canonical sample/full synthesis-scope import
    // adapter yet. Keep this explicit hold even if structural receipts agree;
    // remove only with a complete guarded lineage/import proof, never a waiver.
    return narrationResult(findings, { duration_sec: duration, audio_path: audioPath, audio_sha256: audioHash, unit_ids: results.map((row) => row.unit_id), import_only: true });
  } catch {
    findings.push({ code: "pilot_narration_bound_receipt_or_local_media_invalid" });
    return narrationResult(findings);
  }
}

/** Pure receipt accounting, with authority resolved from retained artifacts by
 * validatePilotMedia. An imported receipt cannot grant its own replacement. */
export function validatePilotGeneratedAttempt(proof, { row, planned, hostRevision = null } = {}) {
  const findings = [];
  const same = (a, b) => a === undefined || b === undefined ? a === b : canonicalQwenBatchSha256(a) === canonicalQwenBatchSha256(b);
  const revisedHost = Boolean(hostRevision && planned.kind === "host_pose");
  const replacement = revisedHost && row.id === "host_neutral";
  check(findings, proof.creative_submission_count === (replacement ? 2 : 1), "pilot_generated_submission_lifetime_invalid", row.id);
  if (replacement) {
    check(findings, proof.attempt_number === 2 && proof.creative_submissions_this_attempt === 1
      && same(proof.replacement_authority, hostRevision.authorization)
      && proof.prompt_sha256 === hostRevision.request.replacement_prompt.sha256
      && row.sha256 !== hostRevision.request.prior_attempt.output.sha256,
    "pilot_host_replacement_lineage_invalid", row.id);
    check(findings, same(proof.external_inspiration_bindings, hostRevision.request.external_inspiration_bindings),
      "pilot_host_external_inspiration_lineage_invalid", row.id);
    check(findings, proof.host_design_authority === undefined || same(proof.host_design_authority, hostRevision.authorization),
      "pilot_host_design_authorization_invalid", row.id);
  } else {
    check(findings, proof.replacement_authority === undefined
      && (proof.attempt_number === undefined || proof.attempt_number === 1)
      && (proof.creative_submissions_this_attempt === undefined || proof.creative_submissions_this_attempt === 1),
    "pilot_generated_unscoped_replacement_forbidden", row.id);
    check(findings, proof.external_inspiration_bindings === undefined
      || Array.isArray(proof.external_inspiration_bindings) && proof.external_inspiration_bindings.length === 0,
    "pilot_generated_unapproved_external_inspiration", row.id);
    check(findings, revisedHost ? same(proof.host_design_authority, hostRevision.authorization)
      : proof.host_design_authority === undefined, "pilot_host_design_authorization_invalid", row.id);
  }
  if (revisedHost) {
    const expected = planned.reference_asset_ids ?? [];
    const actual = Array.isArray(proof.reference_bindings) ? proof.reference_bindings.map((ref) => ref.id) : null;
    check(findings, actual && new Set(actual).size === actual.length
      && same([...actual].sort(), [...expected].sort()), "pilot_host_exact_identity_references_required", row.id);
  }
  return pass(findings);
}

export async function validatePilotMedia(manifest, { episodeDir, identity, assetPlan } = {}) {
  const findings = [...validatePilotAssetPlan(assetPlan, identity).findings];
  check(findings, manifest?.schema === "goldflow_avatar_pilot_media_v1" && manifest?.source_script_sha256 === assetPlan?.source_script_sha256, "pilot_media_schema_or_script_hash_invalid");
  check(findings, !pilotArtifactContainsPrivateData(manifest), "pilot_media_private_data_forbidden");
  const rows = Array.isArray(manifest?.assets) ? manifest.assets : [];
  const plans = Array.isArray(assetPlan?.assets) ? assetPlan.assets : [];
  check(findings, rows.length === plans.length && new Set(rows.map((row) => row?.id)).size === rows.length && rows.every((row) => plans.some((plan) => plan.id === row?.id)), "pilot_media_exact_complete_asset_scope_required");
  if (findings.length) return pass(findings);
  let hostRevision = null;
  try {
    // Resolve from the episode, not a caller-asserted receipt or a validator
    // option. A stale/partial/deleted recorded amendment blocks all imports.
    const { resolvePilotHostDesignRevision } = await import("./avatar-pilot-host-design-revision.mjs");
    hostRevision = await resolvePilotHostDesignRevision({ episodeDir, identity });
    check(findings, !hostRevision || canonicalQwenBatchSha256(assetPlan) === canonicalQwenBatchSha256(hostRevision.plan.row.payload),
      "pilot_media_current_host_design_plan_required");
  } catch {
    findings.push({ code: "pilot_media_host_design_revision_invalid" });
  }
  if (findings.length) return pass(findings);
  const probes = [];
  const firstByHash = new Map();
  for (const row of rows) {
    const planned = plans.find((plan) => plan.id === row.id);
    for (const key of ["kind", "provider", "model", "truth_mode"]) check(findings, row[key] === planned[key], "pilot_media_plan_identity_mismatch", row.id);
    check(findings, row.review?.approved === true && text(row.review?.reviewer) && text(row.review?.note), "pilot_media_exact_pilot_review_required", row.id);
    const priorId = firstByHash.get(row.sha256);
    if (priorId) check(findings, planned.reuse_of_asset_id === priorId && row.review?.editorial_reuse_approved === true, "pilot_media_duplicate_requires_deliberate_reuse", row.id);
    else firstByHash.set(row.sha256, row.id);
    try {
      const assetPath = await boundFile(row, episodeDir);
      const receipt = await boundJson({ path: row.receipt_path, sha256: row.receipt_sha256 }, episodeDir);
      const inspected = await probe(assetPath);
      const video = inspected.streams?.find((stream) => stream.codec_type === "video");
      const audio = inspected.streams?.find((stream) => stream.codec_type === "audio");
      const duration = Number(inspected.format?.duration);
      if (["movie_clip", "concept_video", "narration"].includes(row.kind)) {
        check(findings, Number.isFinite(row.duration_sec) && row.duration_sec > 0 && Number.isFinite(duration)
          && Math.abs(row.duration_sec - duration) <= 0.02, "pilot_media_declared_duration_must_match_probe", row.id);
      }
      if (row.kind === "movie_clip") {
        const verified = await validateFootageClipReceipt(receipt.path);
        const sourceRef = { path: row.source_manifest_path, sha256: row.source_manifest_sha256 };
        const sourcePath = await boundFile(sourceRef, episodeDir);
        const source = await readFootageSource(sourcePath);
        const approval = (await boundJson({ path: row.library_approval_path, sha256: row.library_approval_sha256 }, episodeDir)).document;
        const clip = verified.receipt;
        check(findings, clip.clip_sha256 === row.sha256 && clip.source_manifest_sha256 === source.manifest_sha256 && clip.source_title === source.title && clip.source_edition === source.edition && source.title === row.title && source.edition === row.edition && source.provider === row.provider
          && clip.request.start_sec === row.source_in_sec && clip.request.start_sec + clip.request.duration_sec === row.source_out_sec
          && text(row.rights_basis) && source.rights?.operator_confirmed === true, "pilot_movie_source_lineage_invalid", row.id);
        check(findings, approval.schema === "goldflow_footage_clip_approval_v1" && approval.decision === "approved" && approval.production_eligible === false && approval.clip_sha256 === row.sha256 && approval.receipt_sha256 === clip.receipt_sha256 && text(approval.reviewer) && text(approval.note), "pilot_movie_library_approval_invalid", row.id);
        check(findings, video?.codec_name === "h264" && video.pix_fmt === "yuv420p" && video.width === clip.width && video.height === clip.height
          && Math.abs(duration - clip.actual_duration_sec) <= 0.15 && duration >= 2.85 && duration <= 5.15
          && (clip.audio_policy === "retained_aac_stereo" ? audio?.codec_name === "aac" && audio.channels === 2 && Number(audio.sample_rate) === 48000 : !audio), "pilot_movie_probe_contract_invalid", row.id);
      } else if (row.kind === "narration") {
        const produced = receipt.document?.schema === "goldflow_avatar_pilot_stage_v1" && receipt.document.stage === "pilot_narration"
          && receipt.document.payload?.schema === "goldflow_avatar_pilot_narration_accepted_v1";
        let result;
        if (produced) {
          check(findings, receipt.path === path.join(episodeDir, "pilot_narration.json")
            && receipt.document.identity_sha256 === await sha256File(path.join(episodeDir, "run_identity.json")), "pilot_narration_original_stage_required", row.id);
          const { validatePilotNarrationAcceptance } = await import("./avatar-pilot-narration-acceptance.mjs");
          result = await validatePilotNarrationAcceptance(receipt.document.payload, { episodeDir, identity });
        } else result = await validatePilotNarrationBundle(receipt.document, { episodeDir, identity, phase: "full", sourceScriptSha256: assetPlan.source_script_sha256 });
        findings.push(...result.findings.map((finding) => ({ ...finding, id: row.id })));
        check(findings, (produced ? receipt.document.payload : receipt.document).audio?.sha256 === row.sha256, "pilot_narration_media_hash_mismatch", row.id);
      } else {
        const proof = receipt.document;
        check(findings, proof.schema === "goldflow_avatar_pilot_provider_receipt_v1" && proof.status === "passed" && proof.asset_id === row.id && proof.provider === row.provider && proof.model === row.model && proof.output_sha256 === row.sha256 && HASH.test(proof.prompt_sha256 ?? "") && proof.review?.approved === true && text(proof.review?.reviewer) && text(proof.review?.note), "pilot_generated_receipt_invalid", row.id);
        findings.push(...validatePilotGeneratedAttempt(proof, { row, planned, hostRevision }).findings);
        // This is an explicit manual import adapter. Preserve actual provider
        // evidence; a locally written wrapper alone is not provider provenance.
        await boundFile(proof.provider_evidence, episodeDir);
        for (const ref of proof.external_inspiration_bindings ?? []) await boundFile(ref, episodeDir);
        check(findings, Array.isArray(proof.reference_bindings), "pilot_generated_reference_bindings_required", row.id);
        for (const ref of proof.reference_bindings ?? []) {
          await boundFile(ref, episodeDir);
          check(findings, rows.some((asset) => asset.id === ref.id && asset.sha256 === ref.sha256 && asset.id !== row.id), "pilot_generated_reference_not_planned_current_asset", row.id);
        }
        check(findings, video && video.width > 0 && video.height > 0, "pilot_generated_visual_unreadable", row.id);
        if (row.kind === "concept_video") {
          const first = rows.find((asset) => asset.id === planned.first_frame_asset_id);
          check(findings, proof.reference_bindings?.length === 1 && proof.reference_bindings[0].id === first?.id && proof.reference_bindings[0].sha256 === first?.sha256 && duration > 0 && duration <= 12 && !audio, "pilot_flow_video_first_frame_or_audio_invalid", row.id);
        } else {
          check(findings, ["png", "mjpeg", "webp"].includes(video?.codec_name) && !audio, "pilot_generated_still_raster_required", row.id);
          if (row.kind === "host_pose") check(findings, /(?:rgba|bgra|argb|abgr|yuva|gbrap)/u.test(video?.pix_fmt ?? ""), "pilot_host_pose_real_alpha_required", row.id);
        }
      }
      probes.push({ id: row.id, path: assetPath, duration_sec: Number.isFinite(duration) ? duration : null, width: video?.width ?? null, height: video?.height ?? null, has_audio: Boolean(audio) });
    } catch {
      findings.push({ code: "pilot_media_bound_receipt_or_local_media_invalid", id: row.id });
    }
  }
  return pass(findings, { assets: probes, import_only: true, verification_scope: "hash_provenance_structure_and_recorded_reviews_not_independent_provider_or_rights_attestation" });
}
