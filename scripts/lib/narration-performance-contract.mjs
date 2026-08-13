import { createHash } from "node:crypto";

export const NARRATION_ACTIONABLE_DIRECTION_VERSION =
  "narration_actionable_direction_v1";
export const NARRATION_PERFORMANCE_CONTRACT_VERSION =
  "narration_performance_contract_v1";
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
  if (artifact.schema !== "goldflow_narration_actionable_direction_v1") {
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
    actualKeys.push(...sourceRefKeys);
  }
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    findings.push({
      code: "actionable_direction_source_coverage_invalid",
      expected_source_ref_keys: expectedKeys,
      actual_source_ref_keys: actualKeys,
    });
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
      controls_submitted_to_qwen_base: [
        "spoken_text",
        "punctuation",
        "sentence_complete_unit_boundaries",
        "dialogue_separation",
        "reference_audio",
        "reference_text",
      ],
      unsupported_controls_not_submitted: [
        "emotion_tags",
        "natural_language_instruct",
        "speed_control",
      ],
    },
    unit_contract: {
      sentence_complete: true,
      target_words_min: null,
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
