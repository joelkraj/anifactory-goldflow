import assert from "node:assert/strict";
import {
  QWEN_LIAM_PROFILE_ID,
  relockedIdentityForTests,
  requireCanonicalQwenLiamOptions,
} from "../run-relock-tts.mjs";
import { commandStageFor } from "../lib/pipeline-stage-registry.mjs";

function fixtureVoiceProviderOptions() {
  return {
    primary: {
      provider: "qwen_local",
      model_id: "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
      model_revision: "model-revision",
      model_weights_sha256: "weights-sha",
      model_config_sha256: "config-sha",
      generation_config_sha256: "generation-sha",
      speech_tokenizer_weights_sha256: "tokenizer-weights-sha",
      speech_tokenizer_config_sha256: "tokenizer-config-sha",
      runtime: "mlx-audio",
      runtime_version: "0.4.6",
      sample_rate_hz: 24000,
      voice_id: "am_liam",
      voice_sha256: "liam-voice-sha",
      reference_audio_path: "/voice/am_liam.wav",
      reference_audio_sha256: "reference-audio-sha",
      reference_text: "Audited Liam reference transcript.",
      reference_text_sha256: "reference-text-sha",
      reference_manifest_path: "/voice/am_liam_manifest.json",
      reference_manifest_sha256: "reference-manifest-sha",
      reference_voice_sha256: "liam-voice-sha",
      voice_continuity_contract: "qwen_icl_clone_of_liam_reference",
      reference_metadata_sha256: "reference-metadata-sha",
      speaker_similarity_model_sha256: "speaker-model-sha",
      speaker_similarity_calibration_sha256: "speaker-calibration-sha",
      minimum_cosine_similarity: 0.88,
      warning_below_cosine_similarity: 0.9,
    },
    fallback: null,
    qa_policy: "narration_tts_qa_v1",
    pace_strategy: "qwen_reference_native_cadence_no_speed_no_post_tempo",
    narrator_identity_policy: "single_voice_qwen_liam_icl",
    allowed_production_voice_ids: ["am_liam"],
    unit_contract: {
      sentence_complete: true,
      target_words_min: 45,
      target_words_max: 60,
      hard_words_max: 60,
      continuous_requests: false,
    },
    stitch_contract: {
      join_silence_ms: 80,
      post_tempo_processing: false,
    },
    retry_policy: "confirmed_skips_truncations_or_stutters_only",
    retry_contract: {
      retry_policy: "confirmed_skips_truncations_or_stutters_only",
      automatic_asr_retry: false,
      confirmed_defect_types: ["skip", "truncation", "stutter"],
    },
  };
}

export async function runRelockTtsTests() {
  assert.equal(
    commandStageFor("run", "relock-tts", {}),
    "run_identity",
    "the relock command must receive normal append-only stage execution provenance",
  );

  const options = fixtureVoiceProviderOptions();
  assert.equal(requireCanonicalQwenLiamOptions(options), options);
  assert.throws(
    () => requireCanonicalQwenLiamOptions({
      ...options,
      unit_contract: { ...options.unit_contract, hard_words_max: 61 },
    }),
    /hard_words_max=61/,
  );

  const before = {
    schema: "goldflow_run_identity_v2",
    stage_registry_version: "old-registry",
    channel: "53rebirth",
    series_slug: "human-shield-strongest-tank",
    week: "2026-W31-human-shield-strongest-tank-v1",
    episode: "ep_01",
    title: "Keep this exact title",
    source_sha256: "approved-script-sha",
    image_provider: "modelslab",
    image_provider_options: { fallback: { provider: "codex_imagegen" } },
    tts_provider: "kokoro_local",
    tts_fallback_provider: "qwen_local",
    narrator_voice_id: "am_puck",
    tts_voice_id: "am_puck",
    tts_native_speed: 1.2,
    provider_locks: {
      image_provider: "modelslab",
      image_model: "flux-klein",
      reference_model: "flux-klein",
      tts_provider: "kokoro_local",
      fallback_reference_audio_sha256: "old-puck-reference",
    },
    model_versions: {
      image_model: "flux-klein",
      reference_model: "flux-klein",
      tts_model: "kokoro",
      fallback_tts_model: "qwen",
    },
    production_profile_config: {
      media: {
        tts_concurrency: 1,
        kokoro_tts_concurrency: 1,
        qwen_tts_concurrency: 15,
        image_concurrency: 15,
      },
    },
    production_gates: {
      single_narrator_identity_required: true,
      fallback_must_clone_primary_voice_identity: true,
      image_output_qa_required: true,
    },
    git: { commit: "old-commit", dirty: false },
  };
  const cleanGit = {
    commit: "new-clean-commit",
    branch: "main",
    dirty: false,
    dirty_diff_sha256: null,
    dirty_status: [],
  };
  const after = relockedIdentityForTests(before, {
    voiceProviderOptions: options,
    git: cleanGit,
    timestamp: "2026-07-28T23:59:00.000Z",
    archiveDir: "/episode/reports/recovery/relock",
    previousIdentitySha256: "old-identity-sha",
    reason: "operator approved Qwen Liam",
  });

  assert.equal(after.tts_profile, QWEN_LIAM_PROFILE_ID);
  assert.equal(after.tts_provider, "qwen_local");
  assert.equal(after.tts_fallback_provider, null);
  assert.equal(after.narrator_voice_id, "am_liam");
  assert.equal(after.tts_native_speed, null);
  assert.equal(after.provider_locks.narrator_voice_sha256, "liam-voice-sha");
  assert.equal(after.provider_locks.tts_model_weights_sha256, "weights-sha");
  assert.equal(after.provider_locks.tts_unit_target_words_min, 45);
  assert.equal(after.provider_locks.tts_unit_target_words_max, 60);
  assert.equal(after.provider_locks.tts_unit_hard_words_max, 60);
  assert.equal(after.provider_locks.tts_sentence_complete_units, true);
  assert.equal(after.provider_locks.tts_join_silence_ms, 80);
  assert.equal(after.provider_locks.tts_continuous_requests, false);
  assert.equal(after.provider_locks.post_tempo_processing, false);
  assert.equal(after.provider_locks.tts_retry_policy, "confirmed_skips_truncations_or_stutters_only");
  assert.equal(after.provider_locks.tts_automatic_asr_retry, false);
  assert.deepEqual(after.provider_locks.tts_confirmed_defect_types, ["skip", "truncation", "stutter"]);
  assert.equal(after.provider_locks.primary_reference_manifest_sha256, "reference-manifest-sha");
  assert.equal(after.provider_locks.primary_voice_continuity_contract, "qwen_icl_clone_of_liam_reference");
  assert.equal(after.provider_locks.fallback_reference_audio_sha256, null);
  assert.equal(after.model_versions.fallback_tts_model, null);
  assert.equal(after.production_profile_config.media.qwen_tts_concurrency, 1);
  assert.equal(after.production_profile_config.media.local_qwen_tts_concurrency, 1);
  assert.deepEqual(after.git, cleanGit);
  assert.equal(after.narration_identity_relock.invalidation_boundary, "voice_plan");
  assert.equal(after.narration_identity_relock.preserved_upstream_boundary, "semantic_scene_plan");
  assert.equal("qwen_narrator_voice_id" in after, false);
  assert.equal(after.provider_locks.qwen_narrator_voice_id, null);
  assert.equal(after.production_gates.tts_speed_control_supported, false);
  assert.equal(after.production_gates.sentence_complete_tts_units_required, true);

  assert.equal(after.title, before.title);
  assert.equal(after.source_sha256, before.source_sha256);
  assert.equal(after.image_provider, before.image_provider);
  assert.deepEqual(after.image_provider_options, before.image_provider_options);
  assert.equal(after.provider_locks.image_provider, before.provider_locks.image_provider);
  assert.equal(after.provider_locks.image_model, before.provider_locks.image_model);
  assert.equal(after.model_versions.image_model, before.model_versions.image_model);
  assert.equal(after.production_profile_config.media.image_concurrency, 15);
  assert.equal(after.production_gates.image_output_qa_required, true);
}
