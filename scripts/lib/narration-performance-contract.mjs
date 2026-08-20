import { createHash } from "node:crypto";

export const NARRATION_ACTIONABLE_DIRECTION_VERSION =
  "narration_actionable_direction_v3";
export const NARRATION_PERFORMANCE_CONTRACT_VERSION =
  "narration_performance_contract_v2";
export const NARRATION_PERFORMANCE_BAKEOFF_APPROVAL_SCHEMA =
  "goldflow_narration_performance_bakeoff_approval_v1";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => ![
        "generated_at",
        "contract_sha256",
        "artifact_path",
      ].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function canonicalNarrationContractSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function narrationSourceRefKey(ref = {}) {
  const segmentId = String(ref.segment_id ?? "").trim();
  const unitIndex = Number(ref.unit_index);
  if (!segmentId || !Number.isInteger(unitIndex) || unitIndex < 1) return null;
  return `${segmentId}:u${String(unitIndex).padStart(3, "0")}`;
}

export function punctuationInsensitiveTokens(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}

export const NARRATION_BOUNDARY_CLASSES = Object.freeze([
  "continuation",
  "clause",
  "sentence",
  "emphasized_sentence",
  "paragraph",
  "reveal",
  "episode_end",
]);

const PERFORMANCE_ENUMS = Object.freeze({
  energy: ["restrained", "low", "controlled", "high", "urgent"],
  tension: ["neutral", "warm", "cold", "social_pressure", "high"],
  intimacy: ["distant", "standard", "close"],
  pace: ["measured", "steady", "steady_forward", "precise", "fast"],
  pause_strategy: ["minimal", "punctuation_led", "short_precise", "reveal_weighted"],
});

export function normalizeNarrationPerformanceIntent(intent = {}) {
  const normalized = {};
  for (const [field, allowed] of Object.entries(PERFORMANCE_ENUMS)) {
    const fallback = {
      energy: "controlled",
      tension: "neutral",
      intimacy: "standard",
      pace: "steady_forward",
      pause_strategy: "punctuation_led",
    }[field];
    normalized[field] = allowed.includes(String(intent?.[field] ?? ""))
      ? String(intent[field])
      : fallback;
  }
  normalized.emphasis = [...new Set(
    (Array.isArray(intent?.emphasis) ? intent.emphasis : [])
      .map(String)
      .map((value) => value.trim())
      .filter(Boolean),
  )].slice(0, 8);
  normalized.style_tags = [...new Set(
    (Array.isArray(intent?.style_tags) ? intent.style_tags : [])
      .map(String)
      .map((value) => value.trim())
      .filter(Boolean),
  )].slice(0, 6);
  normalized.source = String(
    intent?.source ?? "provider_neutral_voice_director_v2",
  );
  return normalized;
}

export function validateActionableNarrationDirection({
  artifact,
  atomicUnits,
  sourceScriptSha256,
  hardWordMax = 60,
} = {}) {
  const findings = [];
  if (!artifact || typeof artifact !== "object") {
    return {
      status: "not_provided",
      authoring_kind: "deterministic_fallback",
      findings: [],
      groups: [],
    };
  }
  const directionSchema = String(artifact.schema ?? "");
  const v3 = directionSchema === "goldflow_narration_actionable_direction_v3";
  const v2 = directionSchema === "goldflow_narration_actionable_direction_v2";
  if (!v3 && !v2 && directionSchema !== "goldflow_narration_actionable_direction_v1") {
    findings.push({ code: "actionable_direction_schema_invalid" });
  }
  if (artifact.status !== "approved") {
    findings.push({ code: "actionable_direction_not_approved" });
  }
  if (artifact.source_script_sha256 !== sourceScriptSha256) {
    findings.push({ code: "actionable_direction_script_hash_stale" });
  }
  if (artifact.authoring?.kind !== "llm_authored"
    || !String(artifact.authoring?.provider ?? "").trim()
    || !String(artifact.authoring?.model ?? "").trim()) {
    findings.push({ code: "actionable_direction_llm_provenance_missing" });
  }

  const expectedKeys = atomicUnits.map((unit) => (
    narrationSourceRefKey(unit.source_unit_refs?.[0])
  ));
  if (expectedKeys.some((key) => !key)) {
    findings.push({ code: "actionable_direction_atomic_source_ref_invalid" });
  }
  const unitByKey = new Map(
    atomicUnits.map((unit, index) => [expectedKeys[index], unit]),
  );
  const groups = Array.isArray(artifact.units) ? artifact.units : [];
  const actualKeys = [];
  for (const [groupIndex, group] of groups.entries()) {
    const sourceRefKeys = Array.isArray(group.source_ref_keys)
      ? group.source_ref_keys.map(String)
      : [];
    if (!sourceRefKeys.length) {
      findings.push({ code: "actionable_direction_unit_has_no_source_refs", group_index: groupIndex });
      continue;
    }
    const rows = sourceRefKeys.map((key) => unitByKey.get(key));
    if (rows.some((row) => !row)) {
      findings.push({ code: "actionable_direction_unknown_source_ref", group_index: groupIndex, source_ref_keys: sourceRefKeys });
      continue;
    }
    const segmentIds = new Set(rows.flatMap((row) => row.source_segment_ids ?? [row.segment_id]));
    if (segmentIds.size !== 1) {
      findings.push({ code: "actionable_direction_crosses_voice_segment", group_index: groupIndex });
    }
    const crossesAtomicBarrier = rows.length > 1 && rows.some((row) => (
      row.source_merge_barrier === true
      || row.risk_flags?.includes("system_ui_atomic")
      || row.risk_flags?.includes("speaker_or_performance_turn")
      || row.risk_flags?.includes("tts_override_applied")
    ));
    if (crossesAtomicBarrier) {
      findings.push({ code: "actionable_direction_crosses_atomic_barrier", group_index: groupIndex });
    }
    const submitted = String(group.spoken_text ?? "").trim();
    const deterministic = rows.map((row) => row.spoken_text).join(" ").trim();
    if (JSON.stringify(punctuationInsensitiveTokens(submitted))
      !== JSON.stringify(punctuationInsensitiveTokens(deterministic))) {
      findings.push({ code: "actionable_direction_changes_spoken_words", group_index: groupIndex });
    }
    const wordCount = punctuationInsensitiveTokens(submitted).length;
    if (wordCount > hardWordMax) {
      findings.push({
        code: "actionable_direction_exceeds_hard_word_maximum",
        group_index: groupIndex,
        spoken_word_count: wordCount,
        hard_word_max: hardWordMax,
      });
    }
    if (v2 || v3) {
      if (!NARRATION_BOUNDARY_CLASSES.includes(String(group.boundary_after ?? ""))) {
        findings.push({
          code: "actionable_direction_boundary_class_invalid",
          group_index: groupIndex,
          value: group.boundary_after ?? null,
        });
      }
      if (!group.performance_intent || typeof group.performance_intent !== "object") {
        findings.push({
          code: "actionable_direction_performance_intent_missing",
          group_index: groupIndex,
        });
      } else {
        for (const [field, allowed] of Object.entries(PERFORMANCE_ENUMS)) {
          if (!allowed.includes(String(group.performance_intent[field] ?? ""))) {
            findings.push({
              code: "actionable_direction_performance_intent_invalid",
              group_index: groupIndex,
              field,
              value: group.performance_intent[field] ?? null,
            });
          }
        }
        const submittedLower = submitted.toLocaleLowerCase("en-US");
        for (const phrase of group.performance_intent.emphasis ?? []) {
          if (!submittedLower.includes(String(phrase).toLocaleLowerCase("en-US"))) {
            findings.push({
              code: "actionable_direction_emphasis_not_in_spoken_text",
              group_index: groupIndex,
              phrase,
            });
          }
        }
      }
    }
    actualKeys.push(...sourceRefKeys);
  }
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    findings.push({
      code: "actionable_direction_source_coverage_invalid",
      expected_source_ref_keys: expectedKeys,
      actual_source_ref_keys: actualKeys,
    });
  }
  if ((v2 || v3) && groups.length) {
    if (groups.at(-1)?.boundary_after !== "episode_end") {
      findings.push({ code: "actionable_direction_episode_end_boundary_missing" });
    }
    if (groups.slice(0, -1).some((group) => group.boundary_after === "episode_end")) {
      findings.push({ code: "actionable_direction_episode_end_boundary_early" });
    }
  }
  if (v3) {
    const spine = artifact?.chapter_prosody_spine;
    if (spine?.schema !== "goldflow_narration_chapter_prosody_spine_v1") {
      findings.push({ code: "actionable_direction_prosody_spine_schema_invalid" });
    }
    const rows = Array.isArray(spine?.chapters) ? spine.chapters : [];
    const expectedSegmentIds = [...new Set(atomicUnits.map((unit) => String(unit.segment_id ?? "")).filter(Boolean))];
    const actualSegmentIds = rows.map((row) => String(row?.segment_id ?? ""));
    if (JSON.stringify(actualSegmentIds) !== JSON.stringify(expectedSegmentIds)) {
      findings.push({
        code: "actionable_direction_prosody_spine_coverage_invalid",
        expected_segment_ids: expectedSegmentIds,
        actual_segment_ids: actualSegmentIds,
      });
    }
    for (const [index, row] of rows.entries()) {
      for (const field of ["dramatic_function", "audience_effect", "transition_from_previous", "avoidance"]) {
        if (!String(row?.[field] ?? "").trim()) findings.push({ code: `actionable_direction_prosody_spine_${field}_missing`, chapter_index: index });
      }
      for (const field of ["energy_start", "energy_end", "tension_peak", "intimacy", "reveal_weight"]) {
        const value = Number(row?.[field]);
        if (!Number.isInteger(value) || value < 1 || value > 5) {
          findings.push({ code: `actionable_direction_prosody_spine_${field}_invalid`, chapter_index: index });
        }
      }
      if (!["measured", "steady", "steady_forward", "precise", "fast"].includes(String(row?.pace ?? ""))) {
        findings.push({ code: "actionable_direction_prosody_spine_pace_invalid", chapter_index: index });
      }
    }
  }
  return {
    status: findings.length ? "blocked" : "passed",
    authoring_kind: "llm_authored",
    findings,
    groups,
  };
}

export function buildNarrationPerformanceContract({
  provider,
  modelId,
  modelRevision,
  voiceId,
  voiceSha256,
  referenceAudioSha256,
  referenceTextSha256,
  synthesisContract,
  actionableDirection,
  preferredWordsMin = 20,
  preferredWordsMax = 42,
  softWordMax = 48,
  hardWordMax = 60,
} = {}) {
  const contract = {
    schema: NARRATION_PERFORMANCE_CONTRACT_VERSION,
    provider,
    model_id: modelId,
    model_revision: modelRevision,
    voice_id: voiceId,
    voice_sha256: voiceSha256,
    reference_audio_sha256: referenceAudioSha256,
    reference_text_sha256: referenceTextSha256,
    synthesis_contract: synthesisContract,
    actionable_direction: {
      version: NARRATION_ACTIONABLE_DIRECTION_VERSION,
      authoring_kind: actionableDirection?.authoring_kind ?? "deterministic_fallback",
      artifact_sha256: actionableDirection?.artifact_sha256 ?? null,
      provider_neutral_controls: [
        "spoken_text",
        "punctuation",
        "sentence_complete_unit_boundaries",
        "dialogue_separation",
        "semantic_boundary_class",
        "performance_intent",
        "reference_audio",
        "reference_text",
      ],
      capability_compilation_required: true,
      unsupported_controls_must_be_reported: true,
    },
    unit_contract: {
      sentence_complete: true,
      preferred_words_min: preferredWordsMin,
      preferred_words_max: preferredWordsMax,
      soft_words_max: softWordMax,
      target_words_min: preferredWordsMin,
      target_words_max: preferredWordsMax,
      hard_words_max: hardWordMax,
      continuous_requests: false,
    },
    bakeoff_required_before_full_synthesis: true,
  };
  return {
    ...contract,
    contract_sha256: canonicalNarrationContractSha256(contract),
  };
}

export function validateNarrationPerformanceBakeoffApproval({
  approval,
  contract,
} = {}) {
  const findings = [];
  if (!approval || typeof approval !== "object") {
    return { status: "blocked", findings: [{ code: "narration_performance_bakeoff_approval_missing" }] };
  }
  if (approval.schema !== NARRATION_PERFORMANCE_BAKEOFF_APPROVAL_SCHEMA) {
    findings.push({ code: "narration_performance_bakeoff_schema_invalid" });
  }
  if (approval.status !== "approved") {
    findings.push({ code: "narration_performance_bakeoff_not_approved" });
  }
  if (approval.performance_contract_sha256 !== contract?.contract_sha256) {
    findings.push({ code: "narration_performance_bakeoff_contract_stale" });
  }
  if (!String(approval.reviewer ?? "").trim()
    || !String(approval.reviewed_at ?? "").trim()
    || !String(approval.listen_note ?? "").trim()) {
    findings.push({ code: "narration_performance_bakeoff_human_receipt_incomplete" });
  }
  const qa = approval.human_performance_qa ?? {};
  for (const field of [
    "stable_identity",
    "energetic_recap_cadence",
    "natural_phrasing",
    "emotional_variation",
    "dialogue_clarity",
  ]) {
    if (qa[field] !== "passed") {
      findings.push({ code: "narration_performance_bakeoff_criterion_failed", field });
    }
  }
  if (qa.audible_defects !== "none") {
    findings.push({ code: "narration_performance_bakeoff_audible_defect", value: qa.audible_defects ?? null });
  }
  const samples = Array.isArray(approval.samples) ? approval.samples : [];
  if (!samples.length) {
    findings.push({ code: "narration_performance_bakeoff_sample_missing" });
  }
  for (const [index, sample] of samples.entries()) {
    if (!String(sample.audio_path ?? "").trim()
      || !/^[a-f0-9]{64}$/i.test(String(sample.audio_sha256 ?? ""))
      || !/^[a-f0-9]{64}$/i.test(String(sample.spoken_text_sha256 ?? ""))
      || !/^[a-f0-9]{64}$/i.test(String(sample.synthesis_identity_sha256 ?? ""))
      || sample.decision !== "accepted") {
      findings.push({ code: "narration_performance_bakeoff_sample_invalid", sample_index: index });
    }
  }
  return { status: findings.length ? "blocked" : "passed", findings };
}
