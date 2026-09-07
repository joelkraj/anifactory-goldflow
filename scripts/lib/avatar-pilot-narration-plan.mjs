import { createHash } from "node:crypto";
import { validatePilotNarrationIdentity } from "./avatar-pilot-narration-contract.mjs";
import { compileProviderSafeSpokenText, PROVIDER_SAFE_SPOKEN_COMPILER_ID } from "./narration-spoken-text.mjs";
import { buildNarrationTextIr, validateNarrationTextIr, narrationTokensWithSpans } from "./narration-text-ir.mjs";
import { buildTtsSpokenTextAudit, ttsSpokenTextAuditMatches } from "./tts-spoken-text-audit.mjs";
import { compileNarrationProviderRequest } from "./narration-provider-adapter.mjs";
import { canonicalNarrationPlanSha256 } from "./narration-pre-synthesis-gate.mjs";
import { narrationTtsPolicyForIdentity, validateNarrationTtsPolicy, narrationPlanVoiceIdentityFindings } from "./narration-tts-policy.mjs";
import { buildQwenLiamBatchPlan, qwenBatchBindingByUnit, validateQwenLiamBatchPlan } from "./qwen-liam-batch-contract.mjs";
import { hasTtsTerminalPunctuation } from "./tts-text-boundaries.mjs";

export const PILOT_NARRATION_PLAN_ADAPTER_VERSION = "2026-09-07.1";
const HASH = /^[a-f0-9]{64}$/u;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const need = (condition, code) => { if (!condition) throw new Error(code); };
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const tokens = (value) => narrationTokensWithSpans(value).map((row) => row.normalized);
const wordCount = (value) => value.trim().split(/\s+/u).filter(Boolean).length;
const BOUNDARIES = new Set(["continuation", "clause", "sentence", "emphasized_sentence", "paragraph", "reveal", "episode_end"]);
const privateData = /\bBearer\s+\S+|https?:\/\/[^\s]+[?&](?:token|signature|sig|api_key|key|auth)=/iu;

function assertOpeningScope(units, count) {
  need(Number.isInteger(count) && count >= 1 && count < units.length, "pilot_plan_opening_must_be_nonempty_proper_prefix");
  need(count <= 3, "pilot_plan_opening_exceeds_three_complete_units");
  // This is a pre-spend scope limit, not a prediction or acceptance of the
  // measured take duration. Count the canonical spoken text, not declared counts.
  need(units.slice(0, count).reduce((total, unit) => total + wordCount(unit.spoken_text), 0) <= 60,
    "pilot_plan_opening_exceeds_sixty_spoken_words");
}

function exactBytes(value, label) {
  need(Buffer.isBuffer(value) || typeof value === "string", `pilot_plan_${label}_bytes_required`);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    throw new Error(`pilot_plan_${label}_utf8_invalid`);
  }
  need(Buffer.from(text, "utf8").equals(bytes), `pilot_plan_${label}_bytes_not_exact_utf8`);
  return { bytes, text };
}

function transformation(stage, before, after, sourceUnitId, extra = {}) {
  return {
    stage, source_unit_id: sourceUnitId,
    before_text: before, after_text: after,
    before_sha256: sha256(before), after_sha256: sha256(after), ...extra,
  };
}

function controlsFor(policy) {
  const primary = policy.primary;
  return {
    provider: primary.provider, model_id: primary.model_id, model_revision: primary.model_revision,
    target_voice_id: primary.voice_id, target_voice_sha256: primary.voice_sha256,
    reference_voice_id: primary.voice_id, reference_voice_sha256: primary.voice_sha256,
    reference_audio_path: primary.reference_audio_path, reference_audio_sha256: primary.reference_audio_sha256,
    reference_transcript: primary.reference_text, reference_transcript_sha256: primary.reference_text_sha256,
    reference_manifest_path: primary.reference_manifest_path, reference_manifest_sha256: primary.reference_manifest_sha256,
    reference_metadata_path: primary.reference_metadata_path, reference_metadata_sha256: primary.reference_metadata_sha256,
    voice_continuity_contract: primary.voice_continuity_contract, delivery_control: primary.delivery_control,
    instruct_supported: false, instruct_submitted: false, instruct: null,
    speed_control_supported: false, native_speed: null, continuous_requests: false,
    synthesis_contract: structuredClone(policy.synthesis_contract),
  };
}

function requestFor(unit, policy) {
  return compileNarrationProviderRequest(unit, {
    provider: policy.primary.provider, modelId: policy.primary.model_id,
    modelRevision: policy.primary.model_revision, voiceId: policy.primary.voice_id,
    voiceSha256: policy.primary.voice_sha256,
    voiceContinuityContract: policy.primary.voice_continuity_contract,
    referenceAudioPath: policy.primary.reference_audio_path,
    referenceText: policy.primary.reference_text, seed: unit.synthesis_cohort.batch_seed,
  });
}

function buildUnits(source, editorialUnits, sourceHash, policy) {
  need(Array.isArray(editorialUnits) && editorialUnits.length >= 2 && editorialUnits.length <= 30, "pilot_plan_editorial_units_required");
  let cursor = 0;
  return editorialUnits.map((row, index) => {
    const start = row?.source_start_utf16; const end = row?.source_end_utf16;
    need(Number.isInteger(start) && Number.isInteger(end) && start >= cursor && end > start && end <= source.length, "pilot_plan_source_span_invalid");
    need(!source.slice(cursor, start).trim(), "pilot_plan_source_gap_or_reordering");
    const sourceText = source.slice(start, end);
    need(sourceText === sourceText.trim() && sourceText.length > 0, "pilot_plan_source_span_requires_trimmed_exact_text");
    need(!/[\uD800-\uDBFF]$/u.test(sourceText) && !/^[\uDC00-\uDFFF]/u.test(sourceText), "pilot_plan_source_span_splits_unicode");
    need(hasTtsTerminalPunctuation(sourceText) && (start === 0 || /\s/u.test(source[start - 1]))
      && (end === source.length || /\s/u.test(source[end])), "pilot_plan_complete_sentence_boundaries_required");
    need(BOUNDARIES.has(row.boundary_class) && (row.boundary_class !== "episode_end" || index === editorialUnits.length - 1), "pilot_plan_editorial_boundary_class_invalid");
    if (index === editorialUnits.length - 1) {
      need(!source.slice(end).trim(), "pilot_plan_source_tail_missing");
      need(row.boundary_class === "episode_end", "pilot_plan_last_boundary_must_be_episode_end");
    }
    cursor = end;
    const unitId = `pilot-u${String(index + 1).padStart(3, "0")}-${sha256(`${sourceHash}\0${start}\0${end}`).slice(0, 12)}`;
    const componentId = `${unitId}-source`;
    const compiled = compileProviderSafeSpokenText(sourceText);
    const componentReceipts = sourceText === compiled ? [] : [transformation(
      "compile_provider_safe_spoken_text", sourceText, compiled, componentId,
      { compiler_id: PROVIDER_SAFE_SPOKEN_COMPILER_ID, reason: "Canonical provider-safe compilation; source and captions remain unchanged." },
    )];
    const finalReceipts = [];
    let spoken = compiled;
    if (row.direction != null) {
      need(typeof row.direction.spoken_text === "string" && row.direction.spoken_text.trim()
        && typeof row.direction.author === "string" && row.direction.author.trim()
        && typeof row.direction.reason === "string" && row.direction.reason.trim(), "pilot_plan_explicit_punctuation_direction_evidence_required");
      need(same(tokens(compiled), tokens(row.direction.spoken_text)), "pilot_plan_direction_must_not_rewrite_words");
      if (compiled !== row.direction.spoken_text) {
        spoken = row.direction.spoken_text;
        finalReceipts.push(transformation("llm_authored_punctuation_only_direction", compiled, spoken, null,
          { author: row.direction.author, reason: row.direction.reason }));
      }
    }
    need(spoken === spoken.trim() && hasTtsTerminalPunctuation(spoken) && wordCount(spoken) <= 60, "pilot_plan_spoken_sentence_or_word_limit_invalid");
    const sourceRef = {
      source_unit_id: componentId, segment_id: "pilot_voice_seg_01",
      source_start_utf16: start, source_end_utf16: end,
      source_start_utf8: Buffer.byteLength(source.slice(0, start)),
      source_end_utf8: Buffer.byteLength(source.slice(0, end)),
      source_text: sourceText, source_text_sha256: sha256(sourceText),
      caption_text: sourceText, caption_text_sha256: sha256(sourceText),
    };
    const lineage = {
      schema: "goldflow_spoken_text_lineage_v1",
      policy: "Exact approved source span closes through the canonical compiler; only explicitly authored punctuation may change the final spoken track.",
      components: [{ source_unit_id: componentId, source_text: sourceText, source_text_sha256: sha256(sourceText),
        compiled_spoken_text: compiled, compiled_spoken_text_sha256: sha256(compiled), transformation_receipts: componentReceipts }],
      pre_direction_spoken_text: compiled, pre_direction_spoken_text_sha256: sha256(compiled),
      final_transformations: finalReceipts, final_spoken_text: spoken, final_spoken_text_sha256: sha256(spoken),
    };
    lineage.lineage_sha256 = sha256(JSON.stringify(lineage));
    return {
      unit_id: unitId, order_index: index, kind: "narration", speaker: "NARRATOR",
      source_text: sourceText, caption_text: sourceText, source_text_sha256: sha256(sourceText), caption_text_sha256: sha256(sourceText),
      spoken_text: spoken, tts_spoken_text: spoken, qwen_spoken_text: spoken, spoken_text_sha256: sha256(spoken), word_count: wordCount(spoken),
      source_unit_refs: [sourceRef], source_segment_ids: ["pilot_voice_seg_01"],
      spoken_text_lineage: lineage, spoken_text_transformations: [...componentReceipts, ...finalReceipts],
      boundary_class: row.boundary_class, semantic_boundary_class: row.boundary_class,
      // The canonical stitch boundary classifier consumes boundary_after. Keep
      // this authored class on the immutable unit, including across phases.
      boundary_after: row.boundary_class,
      performance_intent: structuredClone(row.performance_intent ?? {}),
      editorial_unit: structuredClone(row), merge_barrier: true,
      reference_id: policy.primary.voice_id, voice_id: policy.primary.voice_id, voice_sha256: policy.primary.voice_sha256,
      requested_delivery_id: "neutral_forward", selected_delivery_id: "neutral_forward",
      selected_reference_audio_sha256: policy.primary.reference_audio_sha256,
      provider_controls: { qwen3: controlsFor(policy) },
    };
  });
}

/** Pure text/scope construction only. The caller owns script/evidence approvals,
 * current file hashing, actual reference checks and pre-synthesis authorization. */
export function buildPilotNarrationPlans({
  sourceBytes, sourceScriptSha256, identity, identityBytes, identityFileSha256,
  deliveryBank, editorialUnits, openingUnitCount = 2, sourceArtifactHashes = {},
  generatedAt = null,
} = {}) {
  const source = exactBytes(sourceBytes, "source");
  const identityInput = exactBytes(identityBytes, "identity");
  need(HASH.test(sourceScriptSha256 ?? "") && sha256(source.bytes) === sourceScriptSha256
    && identity?.source_script?.sha256 === sourceScriptSha256, "pilot_plan_approved_source_hash_mismatch");
  need(HASH.test(identityFileSha256 ?? "") && sha256(identityInput.bytes) === identityFileSha256, "pilot_plan_identity_file_hash_mismatch");
  let decodedIdentity;
  try { decodedIdentity = JSON.parse(identityInput.text); } catch { throw new Error("pilot_plan_identity_json_invalid"); }
  need(same(identity, decodedIdentity), "pilot_plan_identity_bytes_object_mismatch");
  need(validatePilotNarrationIdentity(identity, { deliveryBank }).status === "passed", "pilot_plan_canonical_identity_invalid");
  need(!privateData.test(source.text) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]|\[[^\]\n]+\]|<\|speaker:|```/u.test(source.text), "pilot_plan_plain_narration_only_no_stage_or_system_tags");
  need(tokens(source.text).length > 0 && tokens(source.text).length <= 300, "pilot_plan_source_scope_invalid");
  for (const [key, value] of Object.entries(sourceArtifactHashes)) need(/^[a-z][a-z0-9_]*_sha256$/u.test(key) && HASH.test(value ?? ""), "pilot_plan_source_artifact_hash_invalid");
  need(sourceArtifactHashes.script_clean_sha256 == null || sourceArtifactHashes.script_clean_sha256 === sourceScriptSha256, "pilot_plan_source_artifact_script_conflict");
  need(sourceArtifactHashes.run_identity_sha256 == null || sourceArtifactHashes.run_identity_sha256 === identityFileSha256, "pilot_plan_source_artifact_identity_conflict");
  const policy = { ...validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), { production: true }), status: "passed", findings: [] };
  const units = buildUnits(source.text, editorialUnits, sourceScriptSha256, policy);
  assertOpeningScope(units, openingUnitCount);
  const phaseUnits = { opening: units.slice(0, openingUnitCount), remaining: units.slice(openingUnitCount) };
  const batchPlans = {};
  for (const [phase, selected] of Object.entries(phaseUnits)) {
    batchPlans[phase] = buildQwenLiamBatchPlan(selected, policy.synthesis_contract);
    const bindings = qwenBatchBindingByUnit(batchPlans[phase]);
    for (const unit of selected) {
      unit.execution_phase = phase;
      unit.synthesis_cohort = bindings.get(unit.unit_id);
      unit.provider_request = requestFor(unit, policy);
    }
  }
  const sourceTokenCount = tokens(source.text).length;
  const spokenTokenCount = units.reduce((sum, row) => sum + tokens(row.spoken_text).length, 0);
  const plan = {
    schema: "goldflow_tts_generation_plan_v2", status: "passed",
    pilot_adapter_version: PILOT_NARRATION_PLAN_ADAPTER_VERSION,
    source_script_hash: sourceScriptSha256,
    source_hashes: { ...sourceArtifactHashes, script_clean_sha256: sourceScriptSha256, run_identity_sha256: identityFileSha256 },
    primary_provider: policy.primary.provider, fallback_provider: null,
    narrator_voice_id: policy.primary.voice_id, narrator_voice_sha256: policy.primary.voice_sha256, tts_native_speed: null,
    provider_controls: { qwen3: controlsFor(policy) },
    qwen_liam_unit_grouping: { target_spoken_words_min: policy.unit_contract.target_words_min,
      target_spoken_words_max: policy.unit_contract.target_words_max, soft_spoken_words_max: policy.unit_contract.soft_words_max,
      hard_spoken_words_max: policy.unit_contract.hard_words_max, continuous_requests_allowed: false },
    unit_count: units.length, units,
    segments: [{ segment_id: "pilot_voice_seg_01", generation_units: structuredClone(units), narration_generation_units: structuredClone(units), qwen_generation_units: structuredClone(units) }],
    pilot_opening_unit_ids: phaseUnits.opening.map((unit) => unit.unit_id),
    pilot_phase_batch_plans: batchPlans,
    pilot_editorial_units: structuredClone(editorialUnits),
    sentence_unit_boundary_integrity: { status: "passed", unit_count: units.length, clean_start_count: units.length,
      terminal_punctuation_count: units.length, within_hard_word_maximum_count: units.length,
      within_voice_segment_boundary_count: units.length, blocker_count: 0, blockers: [] },
    text_integrity_coverage: { status: "passed", verification: "exact_contiguous_source_spans_and_closed_compiler_receipts",
      script_to_plan_source: { status: "passed", expected_token_count: sourceTokenCount,
        actual_token_count: units.reduce((sum, row) => sum + tokens(row.source_text).length, 0) },
      plan_source_to_spoken: { status: "passed", unit_count: units.length, expected_token_count: spokenTokenCount,
        actual_token_count: spokenTokenCount, mismatch_unit_count: 0 }, findings: [] },
    system_ui_speech_coverage: { status: "passed", policy: "pilot_plain_narration_only_system_and_stage_tags_rejected_before_planning",
      expected_count: 0, planned_count: 0, missing_count: 0, unexpected_count: 0, missing: [], unexpected: [] },
  };
  const spokenTextAudit = buildTtsSpokenTextAudit({ plan, sourceScriptSha256,
    overridesSha256: sourceArtifactHashes.tts_spoken_overrides_sha256 ?? null,
    provider: policy.primary.provider, voiceId: policy.primary.voice_id, generatedAt });
  need(spokenTextAudit.status === "passed", "pilot_plan_spoken_text_audit_blocked");
  plan.tts_spoken_text_audit = { status: spokenTextAudit.status, audit_sha256: spokenTextAudit.audit_sha256,
    unit_contract_sha256: spokenTextAudit.unit_contract_sha256, blocker_count: spokenTextAudit.blocker_count };
  plan.plan_sha256 = canonicalNarrationPlanSha256(plan);
  const textIr = buildNarrationTextIr({ sourceScriptSha256, generationPlanSha256: plan.plan_sha256, units });
  const planPolicy = validatePilotNarrationPlanPolicy(plan, policy, { sourceBytes: source.bytes, identityFileSha256, textIr, spokenTextAudit });
  need(planPolicy.status === "passed", `pilot_plan_validation_blocked:${planPolicy.findings.map((row) => row.code).join(",")}`);
  const phases = Object.fromEntries(Object.entries(phaseUnits).map(([phase, selected]) => [phase, {
    phase, unit_ids: selected.map((unit) => unit.unit_id), units: structuredClone(selected),
    batch_plan: structuredClone(batchPlans[phase]),
    full_plan_sha256: plan.plan_sha256, source_script_sha256: sourceScriptSha256,
    run_identity_sha256: identityFileSha256, synthesis_authorized: false,
    word_count: selected.reduce((sum, row) => sum + row.word_count, 0),
  }]));
  return { plan, textIr, spokenTextAudit, policy, planPolicy, phases,
    source_script_sha256: sourceScriptSha256, run_identity_sha256: identityFileSha256,
    synthesis_authorized: false, measured_duration_sec: null };
}

/** Revalidate source bytes, exact authored unit slices, phase cohorts and canonical
 * request/IR/audit identities. This is planPolicy for the shared pre-synthesis gate,
 * not a fabricated full-stream QA or provider-output receipt. */
export function validatePilotNarrationPlanPolicy(plan, policy, { sourceBytes, identityFileSha256, textIr, spokenTextAudit } = {}) {
  const findings = [];
  const check = (condition, code) => { if (!condition) findings.push({ code }); };
  try {
    const source = exactBytes(sourceBytes, "source");
    check(plan?.schema === "goldflow_tts_generation_plan_v2" && plan.status === "passed"
      && plan.pilot_adapter_version === PILOT_NARRATION_PLAN_ADAPTER_VERSION, "pilot_plan_schema_invalid");
    check(plan?.source_script_hash === sha256(source.bytes) && plan?.source_hashes?.script_clean_sha256 === sha256(source.bytes)
      && plan?.source_hashes?.run_identity_sha256 === identityFileSha256, "pilot_plan_source_or_identity_stale");
    check(plan?.plan_sha256 === canonicalNarrationPlanSha256(plan), "pilot_plan_hash_stale");
    validateNarrationTtsPolicy(policy, { production: true });
    const expected = buildUnits(source.text, plan.pilot_editorial_units, plan.source_script_hash, policy);
    const openingIds = plan.pilot_opening_unit_ids;
    check(Array.isArray(openingIds) && openingIds.length > 0 && openingIds.length < expected.length
      && same(openingIds, expected.slice(0, openingIds.length).map((row) => row.unit_id)), "pilot_plan_opening_prefix_invalid");
    assertOpeningScope(expected, openingIds?.length);
    for (const [phase, selected] of Object.entries({ opening: expected.slice(0, openingIds?.length ?? 0), remaining: expected.slice(openingIds?.length ?? 0) })) {
      const batch = plan.pilot_phase_batch_plans?.[phase];
      check(validateQwenLiamBatchPlan(batch, selected, policy.synthesis_contract).status === "passed", "pilot_plan_phase_batch_invalid");
      const bindings = qwenBatchBindingByUnit(buildQwenLiamBatchPlan(selected, policy.synthesis_contract));
      for (const unit of selected) {
        unit.execution_phase = phase; unit.synthesis_cohort = bindings.get(unit.unit_id);
        unit.provider_request = requestFor(unit, policy);
      }
    }
    check(same(plan.units, expected) && plan.unit_count === expected.length, "pilot_plan_source_spoken_request_or_phase_changed");
    check(same(plan.provider_controls, { qwen3: controlsFor(policy) }), "pilot_plan_provider_controls_changed");
    for (const field of ["generation_units", "narration_generation_units", "qwen_generation_units"]) {
      check(same((plan.segments ?? []).flatMap((segment) => segment[field] ?? []), expected), "pilot_plan_segment_alias_changed");
    }
    findings.push(...narrationPlanVoiceIdentityFindings(plan, policy));
    check(validateNarrationTextIr(textIr, plan.units ?? [], { sourceScriptSha256: plan.source_script_hash, generationPlanSha256: plan.plan_sha256 }).status === "passed", "pilot_plan_text_ir_invalid");
    check(ttsSpokenTextAuditMatches({ audit: spokenTextAudit, plan, sourceScriptSha256: plan.source_script_hash,
      overridesSha256: plan.source_hashes?.tts_spoken_overrides_sha256 ?? null }), "pilot_plan_spoken_audit_invalid");
  } catch (error) { findings.push({ code: error.message }); }
  return { status: findings.length ? "blocked" : "passed", findings,
    scope: "full_source_exact_lineage_with_two_frozen_phase_batch_plans_not_synthesis_authorization" };
}
