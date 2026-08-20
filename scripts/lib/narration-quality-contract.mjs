import { createHash } from "node:crypto";
import { PROVIDER_SAFE_SPOKEN_COMPILER_ID } from "./narration-spoken-text.mjs";

export const NARRATION_QUALITY_CONTRACT_SCHEMA =
  "goldflow_narration_quality_contract_v2";
export const NARRATION_QUALITY_CONTRACT_VERSION =
  "narration_quality_v2_extreme_r4";
const LEGACY_NARRATION_QUALITY_CONTRACT_VERSION =
  "narration_quality_v2_extreme";
const PRIOR_NARRATION_QUALITY_CONTRACT_VERSION =
  "narration_quality_v2_extreme_r2";
const PRIOR_NARRATION_QUALITY_CONTRACT_VERSION_R3 =
  "narration_quality_v2_extreme_r3";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["contract_sha256", "generated_at"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function narrationQualityContractSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function buildNarrationQualityContract({
  provider = "qwen_local",
  modelId = null,
  modelRevision = null,
} = {}) {
  const contract = {
    schema: NARRATION_QUALITY_CONTRACT_SCHEMA,
    version: NARRATION_QUALITY_CONTRACT_VERSION,
    provider_binding: {
      provider,
      model_id: modelId,
      model_revision: modelRevision,
      policy: "Provider capabilities are compiled through an adapter; unsupported direction is reported rather than silently discarded.",
    },
    text_ir: {
      schema: "goldflow_narration_text_ir_v2",
      tracks: ["source_text", "caption_text", "spoken_text"],
      exact_transformation_ledger_required: true,
      exact_text_receipt_chain_required: true,
      spoken_text_lineage_schema: "goldflow_spoken_text_lineage_v1",
      canonical_spoken_compiler_id: PROVIDER_SAFE_SPOKEN_COMPILER_ID,
      performance_metadata_in_spoken_text_forbidden: true,
      provider_request_must_equal_final_spoken_text: true,
      broad_bracket_deletion_forbidden: true,
      known_production_tags_may_be_removed: ["speaker_tag", "sound_design_tag"],
      protected_token_audit_required: true,
    },
    unitization: {
      sentence_complete: true,
      preferred_words_min: 20,
      preferred_words_max: 42,
      soft_words_max: 48,
      hard_words_max: 60,
      short_unit_merge_preferred_below_words: 12,
      continuous_longform_requests: false,
      preserve_atomic_dialogue_system_and_emphasis_units: true,
      llm_may_change_punctuation_but_not_lexical_tokens: true,
      semantic_boundary_class_required: true,
      performance_intent_required: true,
      chapter_prosody_spine_required: true,
    },
    provider_output: {
      schema: "goldflow_narration_provider_output_manifest_v1",
      exact_unit_ids_and_order_required: true,
      model_id_and_revision_required: true,
      voice_id_hash_and_continuity_contract_required: true,
      request_and_synthesis_identity_hash_required: true,
      positive_duration_and_audio_hash_required: true,
      one_creative_submission_per_unit: true,
      automatic_cross_provider_failover: false,
    },
    edge_editing: {
      sample_rate_hz: 24000,
      amplitude_only_trimming_forbidden: true,
      speech_alignment_required_for_trimming: true,
      preserve_before_first_aligned_word_ms: 80,
      preserve_after_last_aligned_word_ms: 140,
      minimum_unedited_head_ms: 40,
      minimum_unedited_tail_ms: 80,
      fade_over_aligned_speech_forbidden: true,
      fade_in_verified_silence_ms: 4,
      fade_out_verified_silence_ms: 4,
      missing_alignment_policy: "preserve_entire_unit",
      spectral_edge_diagnostics_required: true,
      noise_floor_continuity_diagnostics_required: true,
      prosodic_reset_diagnostics_required: true,
    },
    boundary_classes: {
      continuation: { target_ms: 90, minimum_ms: 60, maximum_ms: 130 },
      clause: { target_ms: 130, minimum_ms: 90, maximum_ms: 180 },
      sentence: { target_ms: 230, minimum_ms: 160, maximum_ms: 320 },
      emphasized_sentence: { target_ms: 300, minimum_ms: 220, maximum_ms: 400 },
      paragraph: { target_ms: 430, minimum_ms: 320, maximum_ms: 580 },
      reveal: { target_ms: 600, minimum_ms: 450, maximum_ms: 800 },
      episode_end: { target_ms: 0, minimum_ms: 0, maximum_ms: 0 },
    },
    delivery_qa: {
      maximum_word_error_rate: 0.05,
      unit_screening_model: "small.en",
      exact_suspect_confirmation_model: "medium",
      full_stream_screening_model: "small.en",
      full_stream_confirmation_model: "medium",
      confirm_any_unit_transcript_difference: true,
      confirmed_isolated_deletion_is_blocking: true,
      confirmed_isolated_insertion_is_blocking: true,
      substitution_only_asr_disagreement_requires_exact_listen: true,
      hard_block_opening_deletion_run: 1,
      hard_block_trailing_deletion_run: 1,
      hard_block_contiguous_deletion_run: 2,
      hard_block_contiguous_insertion_run: 2,
      hard_block_duplicate_phrase_tokens: 2,
      isolated_low_confidence_asr_differences_are_advisory: true,
      exact_unit_order_required: true,
      exact_unit_count_required: true,
      final_stream_verification_required: true,
      full_stream_dual_asr_on_any_difference: true,
      approved_repair_scope: "exact_unit_or_exact_boundary_only",
    },
    pronunciation_qa: {
      exact_spoken_text_preview_required: true,
      categories: ["proper_name", "possessive_name", "rank", "initialism", "currency_or_number", "homograph", "protected_term"],
      contextual_homographs_required: true,
      subjective_sampling_for_unresolved_risks: true,
    },
    voice_identity_qa: {
      reference_bank_centroid_required: true,
      minimum_reference_count: 3,
      threshold_source: "owned_reference_leave_one_out_calibration",
      universal_absolute_similarity_threshold_forbidden: true,
      unit_outliers_are_review_required: true,
      aggregate_drift_report_required: true,
      automatic_voice_switch_forbidden: true,
    },
    delivery_reference_bank: {
      schema: "goldflow_narration_delivery_reference_bank_v1",
      required_delivery_ids: ["neutral_forward", "urgent", "intimate", "cold_reveal", "restrained_grief"],
      hash_locked_bank_required: true,
      same_owned_speaker_required: true,
      unpromoted_style_falls_back_to_default: true,
      blind_8_to_10_minute_preference_required_for_promotion: true,
      fatigue_20_to_30_minute_soak_required_for_promotion: true,
      voice_drift_is_veto: true,
      operator_promotion_required: true,
    },
    subjective_review: {
      hash_bound_sampling_manifest_required: true,
      required_coverage: ["complete_opening", "every_chapter_boundary", "system_or_pronunciation_risk", "middle_fatigue", "climax", "final_minute"],
      exact_audio_attestation_required: true,
      repair_scope: "exact_unit_only",
    },
    mastering: {
      enabled_after_delivery_acceptance_only: true,
      mono: true,
      sample_rate_hz: 24000,
      integrated_lufs_target: -16,
      integrated_lufs_tolerance: 1,
      true_peak_dbtp_max: -1.5,
      loudness_normalization_passes: 2,
      duration_delta_ms_max: 10,
      broadband_denoise_default: false,
      tempo_processing_default: false,
      limiting_must_not_hide_clipping: true,
    },
    proof: {
      before_after_bakeoff_required: true,
      transcript_edge_join_voice_and_mastering_metrics_required: true,
      human_listening_required_before_production_promotion: true,
    },
    provider_promotion: {
      incumbent_provider: "qwen_local",
      external_provider_requires_hash_bound_longform_bakeoff: true,
      representative_blind_minutes_min: 8,
      representative_blind_minutes_max: 10,
      fatigue_soak_minutes_min: 20,
      fatigue_soak_minutes_max: 30,
      repeatability_pass_required: true,
      same_voice_identity_pass_required: true,
      voice_drift_is_veto: true,
      cost_and_latency_justification_required: true,
      explicit_operator_promotion_required: true,
      incumbent_retained_on_tie_or_incomplete_evidence: true,
    },
  };
  return {
    ...contract,
    contract_sha256: narrationQualityContractSha256(contract),
  };
}

export function validateNarrationQualityContract(contract) {
  const findings = [];
  if (!contract || typeof contract !== "object") {
    return { status: "blocked", findings: [{ code: "narration_quality_contract_missing" }] };
  }
  if (contract.schema !== NARRATION_QUALITY_CONTRACT_SCHEMA) {
    findings.push({ code: "narration_quality_contract_schema_invalid" });
  }
  if (![NARRATION_QUALITY_CONTRACT_VERSION, PRIOR_NARRATION_QUALITY_CONTRACT_VERSION_R3, PRIOR_NARRATION_QUALITY_CONTRACT_VERSION, LEGACY_NARRATION_QUALITY_CONTRACT_VERSION]
    .includes(contract.version)) {
    findings.push({ code: "narration_quality_contract_version_invalid" });
  }
  if (contract.contract_sha256 !== narrationQualityContractSha256(contract)) {
    findings.push({ code: "narration_quality_contract_hash_invalid" });
  }
  if (contract.edge_editing?.amplitude_only_trimming_forbidden !== true) {
    findings.push({ code: "narration_quality_amplitude_only_trim_not_forbidden" });
  }
  if (contract.edge_editing?.speech_alignment_required_for_trimming !== true) {
    findings.push({ code: "narration_quality_alignment_not_required_for_trim" });
  }
  if (contract.delivery_qa?.final_stream_verification_required !== true) {
    findings.push({ code: "narration_quality_final_stream_verification_not_required" });
  }
  if (contract.text_ir?.exact_transformation_ledger_required !== true) {
    findings.push({ code: "narration_quality_transform_ledger_not_required" });
  }
  if (contract.version === NARRATION_QUALITY_CONTRACT_VERSION) {
    if (contract.text_ir?.exact_text_receipt_chain_required !== true
      || contract.text_ir?.spoken_text_lineage_schema !== "goldflow_spoken_text_lineage_v1") {
      findings.push({ code: "narration_quality_exact_text_lineage_not_required" });
    }
    if (contract.text_ir?.canonical_spoken_compiler_id
      !== PROVIDER_SAFE_SPOKEN_COMPILER_ID) {
      findings.push({ code: "narration_quality_spoken_compiler_not_locked" });
    }
    if (contract.text_ir?.performance_metadata_in_spoken_text_forbidden !== true
      || contract.text_ir?.provider_request_must_equal_final_spoken_text !== true) {
      findings.push({ code: "narration_quality_spoken_payload_separation_not_required" });
    }
    if (contract.unitization?.chapter_prosody_spine_required !== true) {
      findings.push({ code: "narration_quality_chapter_prosody_spine_not_required" });
    }
    if (contract.pronunciation_qa?.exact_spoken_text_preview_required !== true
      || contract.pronunciation_qa?.subjective_sampling_for_unresolved_risks !== true) {
      findings.push({ code: "narration_quality_pronunciation_preview_not_required" });
    }
    if (contract.edge_editing?.spectral_edge_diagnostics_required !== true
      || contract.edge_editing?.noise_floor_continuity_diagnostics_required !== true
      || contract.edge_editing?.prosodic_reset_diagnostics_required !== true) {
      findings.push({ code: "narration_quality_boundary_continuity_diagnostics_not_required" });
    }
    if (contract.delivery_reference_bank?.hash_locked_bank_required !== true
      || contract.delivery_reference_bank?.operator_promotion_required !== true
      || contract.delivery_reference_bank?.unpromoted_style_falls_back_to_default !== true
      || contract.delivery_reference_bank?.voice_drift_is_veto !== true) {
      findings.push({ code: "narration_quality_delivery_reference_bank_not_locked" });
    }
    const requiredSubjectiveCoverage = [
      "complete_opening",
      "every_chapter_boundary",
      "system_or_pronunciation_risk",
      "middle_fatigue",
      "climax",
      "final_minute",
    ];
    if (contract.subjective_review?.hash_bound_sampling_manifest_required !== true
      || contract.subjective_review?.exact_audio_attestation_required !== true
      || contract.subjective_review?.repair_scope !== "exact_unit_only"
      || requiredSubjectiveCoverage.some((value) => !contract.subjective_review?.required_coverage?.includes(value))) {
      findings.push({ code: "narration_quality_subjective_review_not_mandatory" });
    }
    if (contract.provider_promotion?.incumbent_provider !== "qwen_local"
      || contract.provider_promotion?.external_provider_requires_hash_bound_longform_bakeoff !== true
      || contract.provider_promotion?.repeatability_pass_required !== true
      || contract.provider_promotion?.same_voice_identity_pass_required !== true
      || contract.provider_promotion?.voice_drift_is_veto !== true
      || contract.provider_promotion?.explicit_operator_promotion_required !== true
      || contract.provider_promotion?.incumbent_retained_on_tie_or_incomplete_evidence !== true) {
      findings.push({ code: "narration_quality_provider_promotion_gate_not_locked" });
    }
  }
  return { status: findings.length ? "blocked" : "passed", findings };
}

export function narrationQualityContractForIdentity(identity = {}) {
  const contract = identity.narration_quality_contract
    ?? identity.voice_provider_options?.narration_quality_contract
    ?? null;
  return validateNarrationQualityContract(contract).status === "passed"
    ? contract
    : null;
}
