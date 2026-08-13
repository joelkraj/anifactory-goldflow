import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INTERRUPTED_QWEN_REUSE_POLICY,
  PUCK_TO_QWEN_RECOVERY_KIND,
  QWEN_PLANNER_FIX_RECOVERY_KIND,
  QWEN_LIAM_PROFILE_ID,
  plannerFixProfileCompatibleForTests,
  interruptedQwenTtsInventoryForTests,
  recoveryDisposition,
  recoveryEvidence,
  recoveryKindForIdentityForTests,
  recoveryTriageFilename,
  relockedIdentityForTests,
  requireCanonicalQwenLiamOptions,
} from "../run-relock-tts.mjs";
import {
  QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT,
} from "../lib/qwen-liam-batch-contract.mjs";
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
      voice_id: "joel_owned_narrator_clone",
      voice_sha256: "joel-voice-sha",
      reference_audio_path: "/voice/joel_owned_narrator_clone.wav",
      reference_audio_sha256: "reference-audio-sha",
      reference_text: "Audited owned Joel reference transcript.",
      reference_text_sha256: "reference-text-sha",
      reference_manifest_path: "/voice/joel_owned_narrator_clone_manifest.json",
      reference_manifest_sha256: "reference-manifest-sha",
      reference_voice_sha256: "joel-voice-sha",
      voice_continuity_contract: "qwen_icl_clone_of_joel_owned_reference",
      reference_metadata_sha256: "reference-metadata-sha",
      speaker_similarity_model_sha256: "speaker-model-sha",
      speaker_similarity_calibration_sha256: "speaker-calibration-sha",
      minimum_cosine_similarity: 0.88,
      warning_below_cosine_similarity: 0.9,
    },
    fallback: null,
    qa_policy: "narration_tts_qa_v1",
    pace_strategy: "qwen_reference_native_cadence_no_speed_no_post_tempo",
    narrator_identity_policy: "single_voice_qwen_joel_owned_icl",
    allowed_production_voice_ids: ["joel_owned_narrator_clone"],
    unit_contract: {
      sentence_complete: true,
      target_words_min: null,
      target_words_max: 60,
      hard_words_max: 60,
      continuous_requests: false,
      boundary_authoring: "llm_actionable_or_deterministic_fallback",
      minimum_word_target_enforced: false,
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
    synthesis_contract: QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function runInterruptedQwenInventoryFixture() {
  const episodeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "goldflow-relock-tts-inventory-"),
  );
  try {
    const mediaRoot = path.join(episodeDir, "assets", "audio", "narration_tts");
    const jobsDir = path.join(mediaRoot, "jobs");
    const runsDir = path.join(mediaRoot, "runs");
    const unitsDir = path.join(mediaRoot, "units", "qwen_local");
    await fs.mkdir(jobsDir, { recursive: true });
    await fs.mkdir(runsDir, { recursive: true });
    await fs.mkdir(unitsDir, { recursive: true });

    const activeManifestName = "20260729002735577-59463-qwen-attempt-1.json";
    await writeJson(path.join(jobsDir, activeManifestName), {
      schema: "goldflow_narration_tts_jobs_v1",
      provider: "qwen_local",
      attempt: 1,
      jobs: [
        {
          unit_id: "unit_single",
          spoken_text_sha256: "single-text-sha",
        },
        {
          unit_id: "unit_cross",
          spoken_text_sha256: "cross-text-sha",
        },
      ],
    });
    const completedManifestName = "20260728000000000-11111-qwen-attempt-1.json";
    await writeJson(path.join(jobsDir, completedManifestName), {
      schema: "goldflow_narration_tts_jobs_v1",
      provider: "qwen_local",
      attempt: 1,
      jobs: [{ unit_id: "completed_unit", spoken_text_sha256: "completed" }],
    });
    await writeJson(path.join(runsDir, completedManifestName), {
      schema: "goldflow_local_tts_production_run_v1",
      status: "passed",
    });
    await writeJson(path.join(episodeDir, "narration_generation_plan.json"), {
      schema: "goldflow_narration_generation_plan_v1",
      units: [
        {
          unit_id: "unit_single",
          spoken_text_sha256: "single-text-sha",
          source_segment_ids: ["seg_01"],
        },
        {
          unit_id: "unit_cross",
          spoken_text_sha256: "cross-text-sha",
          source_segment_ids: ["seg_02", "seg_03"],
        },
      ],
    });

    for (const row of [
      {
        file: "unit_single-synthesis.wav",
        unit_id: "unit_single",
        spoken_text_sha256: "single-text-sha",
        contents: "single wav bytes",
      },
      {
        file: "unit_cross-synthesis.wav",
        unit_id: "unit_cross",
        spoken_text_sha256: "cross-text-sha",
        contents: "cross wav bytes",
      },
      {
        file: "historical_unit-synthesis.wav",
        unit_id: "historical_unit",
        spoken_text_sha256: "historical-text-sha",
        contents: "historical wav bytes",
      },
    ]) {
      const wavPath = path.join(unitsDir, row.file);
      await fs.writeFile(wavPath, row.contents);
      await writeJson(wavPath.replace(/\.wav$/, ".json"), {
        unit_id: row.unit_id,
        spoken_text_sha256: row.spoken_text_sha256,
        output_sha256: sha256(row.contents),
        synthesis_identity_sha256: "qwen-liam-identity-sha",
      });
    }

    const inventory = await interruptedQwenTtsInventoryForTests(episodeDir);
    assert.equal(inventory.status, "retained_unselected_history");
    assert.equal(inventory.active_job_manifest.path, path.join(jobsDir, activeManifestName));
    assert.equal(inventory.active_job_manifest.job_count, 2);
    assert.equal(inventory.orphaned_qwen_job_manifest_count, 1);
    assert.equal(inventory.interrupted_partial_unit_wav_count, 3);
    assert.equal(inventory.active_job_partial_unit_wav_count, 2);
    assert.equal(inventory.active_job_cross_segment_partial_unit_wav_count, 1);
    assert.equal(inventory.active_job_single_segment_partial_unit_wav_count, 1);
    assert.equal(inventory.historical_partial_unit_wav_count_outside_active_job, 1);
    assert.equal(inventory.selected_for_new_production_count, 0);
    assert.equal(inventory.reuse_policy, INTERRUPTED_QWEN_REUSE_POLICY);
    assert.ok(inventory.partial_unit_wavs.every(
      (row) => row.retained_in_place && !row.selected_for_new_production,
    ));
    assert.ok(inventory.partial_unit_wavs.every(
      (row) => row.sidecar_output_sha256_matches === true,
    ));
  } finally {
    await fs.rm(episodeDir, { recursive: true, force: true });
  }
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
  assert.throws(
    () => requireCanonicalQwenLiamOptions({
      ...options,
      synthesis_contract: QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT,
    }),
    /synthesis_contract=qwen_liam_serial_unit_v1/,
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
  assert.equal(
    recoveryKindForIdentityForTests(before),
    PUCK_TO_QWEN_RECOVERY_KIND,
  );
  const after = relockedIdentityForTests(before, {
    voiceProviderOptions: options,
    git: cleanGit,
    timestamp: "2026-07-28T23:59:00.000Z",
    archiveDir: "/episode/reports/recovery/relock",
    previousIdentitySha256: "old-identity-sha",
    reason: "operator approved Qwen with the owned Joel reference",
  });

  assert.equal(after.tts_profile, QWEN_LIAM_PROFILE_ID);
  assert.equal(after.tts_provider, "qwen_local");
  assert.equal(after.tts_fallback_provider, null);
  assert.equal(after.narrator_voice_id, "joel_owned_narrator_clone");
  assert.equal(after.tts_native_speed, null);
  assert.equal(after.provider_locks.narrator_voice_sha256, "joel-voice-sha");
  assert.equal(after.provider_locks.tts_model_weights_sha256, "weights-sha");
  assert.equal(after.provider_locks.tts_unit_target_words_min, null);
  assert.equal(after.provider_locks.tts_unit_target_words_max, 60);
  assert.equal(after.provider_locks.tts_unit_hard_words_max, 60);
  assert.equal(after.provider_locks.tts_sentence_complete_units, true);
  assert.equal(after.provider_locks.tts_join_silence_ms, 80);
  assert.equal(after.provider_locks.tts_continuous_requests, false);
  assert.equal(after.provider_locks.post_tempo_processing, false);
  assert.equal(after.provider_locks.tts_retry_policy, "confirmed_skips_truncations_or_stutters_only");
  assert.equal(after.provider_locks.tts_automatic_asr_retry, false);
  assert.deepEqual(after.provider_locks.tts_confirmed_defect_types, ["skip", "truncation", "stutter"]);
  assert.equal(
    after.provider_locks.tts_synthesis_contract_id,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.contract_id,
  );
  assert.equal(
    after.provider_locks.tts_synthesis_mode,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode,
  );
  assert.equal(after.provider_locks.tts_synthesis_api, "Model.batch_generate");
  assert.equal(after.provider_locks.tts_model_instance_count, 1);
  assert.equal(after.provider_locks.tts_model_concurrency, 1);
  assert.equal(after.provider_locks.tts_nominal_batch_size, 4);
  assert.equal(
    after.provider_locks.tts_batch_scheduler_version,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.scheduler_version,
  );
  assert.equal(after.provider_locks.tts_token_limit_acceptance_allowed, false);
  assert.equal(
    after.provider_locks.tts_objective_recovery_mode,
    "serial_exact_unit_recovery_v1",
  );
  assert.equal(after.provider_locks.primary_reference_manifest_sha256, "reference-manifest-sha");
  assert.equal(after.provider_locks.primary_voice_continuity_contract, "qwen_icl_clone_of_joel_owned_reference");
  assert.equal(after.provider_locks.fallback_reference_audio_sha256, null);
  assert.equal(after.model_versions.fallback_tts_model, null);
  assert.equal(after.production_profile_config.media.qwen_tts_concurrency, 1);
  assert.equal(after.production_profile_config.media.local_qwen_tts_concurrency, 1);
  assert.equal(after.production_profile_config.media.qwen_tts_batch_size, 4);
  assert.equal(
    after.provider_locks.local_whisper_timing,
    undefined,
    "TTS relock must not retrofit a new Whisper lock onto an existing identity",
  );
  assert.equal(
    after.production_gates.local_whisper_contract_required,
    undefined,
    "registry migration alone must not activate strict Whisper validation",
  );
  assert.deepEqual(after.git, cleanGit);
  assert.equal(after.narration_identity_relock.invalidation_boundary, "voice_plan");
  assert.equal(after.narration_identity_relock.preserved_upstream_boundary, "semantic_scene_plan");
  assert.equal(
    after.narration_identity_relock.recovery_kind,
    PUCK_TO_QWEN_RECOVERY_KIND,
  );
  assert.equal(after.narration_identity_relock.identity_changed, true);
  assert.equal(after.narration_identity_relock.voice_identity_changed, true);
  assert.equal(
    after.narration_identity_relock.synthesis_contract_changed,
    true,
  );
  assert.equal(
    after.narration_identity_relock.recovery_scope,
    "operator_approved_narrator_identity_migration",
  );
  assert.equal("qwen_narrator_voice_id" in after, false);
  assert.equal(after.provider_locks.qwen_narrator_voice_id, null);
  assert.equal(after.production_gates.tts_speed_control_supported, false);
  assert.equal(after.production_gates.sentence_complete_tts_units_required, true);
  assert.equal(
    after.production_gates.deterministic_length_matched_tts_batching_required,
    true,
  );
  assert.equal(after.production_gates.tts_nominal_batch_size, 4);
  assert.equal(after.production_gates.tts_single_resident_model_required, true);
  assert.equal(after.production_gates.tts_token_limit_outputs_forbidden, true);
  assert.equal(
    after.production_gates.tts_objective_recovery_exact_unit_only,
    true,
  );

  assert.equal(after.title, before.title);
  assert.equal(after.source_sha256, before.source_sha256);
  assert.equal(after.image_provider, before.image_provider);
  assert.deepEqual(after.image_provider_options, before.image_provider_options);
  assert.equal(after.provider_locks.image_provider, before.provider_locks.image_provider);
  assert.equal(after.provider_locks.image_model, before.provider_locks.image_model);
  assert.equal(after.model_versions.image_model, before.model_versions.image_model);
  assert.equal(after.production_profile_config.media.image_concurrency, 15);
  assert.equal(after.production_gates.image_output_qa_required, true);

  const beforeSerialPromotion = structuredClone(after);
  beforeSerialPromotion.stage_registry_version = "2026-07-27.1";
  delete beforeSerialPromotion.voice_provider_options.synthesis_contract;
  delete beforeSerialPromotion.production_profile_config.media.qwen_tts_batch_size;
  for (const field of [
    "tts_synthesis_contract_id",
    "tts_synthesis_mode",
    "tts_synthesis_api",
    "tts_model_instance_count",
    "tts_model_concurrency",
    "tts_nominal_batch_size",
    "tts_batch_scheduler_version",
    "tts_token_limit_acceptance_allowed",
    "tts_objective_recovery_mode",
  ]) {
    delete beforeSerialPromotion.provider_locks[field];
  }
  for (const field of [
    "deterministic_length_matched_tts_batching_required",
    "tts_nominal_batch_size",
    "tts_single_resident_model_required",
    "tts_token_limit_outputs_forbidden",
    "tts_objective_recovery_exact_unit_only",
  ]) {
    delete beforeSerialPromotion.production_gates[field];
  }
  const afterSerialPromotion = relockedIdentityForTests(
    beforeSerialPromotion,
    {
      voiceProviderOptions: options,
      git: cleanGit,
      timestamp: "2026-07-29T00:30:00.000Z",
      archiveDir: "/episode/reports/recovery/batch4-promotion",
      previousIdentitySha256: "serial-identity-sha",
      reason: "operator approved deterministic batch-four promotion",
    },
  );
  assert.equal(
    afterSerialPromotion.narration_identity_relock.identity_changed,
    true,
  );
  assert.equal(
    afterSerialPromotion.narration_identity_relock.voice_identity_changed,
    false,
  );
  assert.equal(
    afterSerialPromotion.narration_identity_relock.synthesis_contract_changed,
    true,
  );
  assert.equal(
    afterSerialPromotion.narration_identity_relock.recovery_scope,
    "same_voice_batch4_synthesis_contract_promotion",
  );
  assert.deepEqual(
    afterSerialPromotion.narration_identity_relock.previous_synthesis_contract,
    QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT,
  );
  assert.deepEqual(
    afterSerialPromotion.narration_identity_relock.synthesis_contract,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  );
  assert.match(
    recoveryEvidence(
      QWEN_PLANNER_FIX_RECOVERY_KIND,
      {},
      { synthesisContractChanged: true },
    ).join(" "),
    /explicit relock records the synthesis-contract change/,
  );

  const beforePlannerFix = structuredClone(after);
  beforePlannerFix.git = {
    commit: "qwen-before-planner-fix",
    branch: "main",
    dirty: false,
    dirty_diff_sha256: null,
    dirty_status: [],
  };
  assert.equal(
    recoveryKindForIdentityForTests(beforePlannerFix),
    QWEN_PLANNER_FIX_RECOVERY_KIND,
  );
  assert.equal(plannerFixProfileCompatibleForTests(beforePlannerFix), true);
  const unlabeledCanonicalPlannerFix = structuredClone(beforePlannerFix);
  delete unlabeledCanonicalPlannerFix.tts_profile;
  assert.equal(plannerFixProfileCompatibleForTests(unlabeledCanonicalPlannerFix), true);
  assert.equal(plannerFixProfileCompatibleForTests({
    ...beforePlannerFix,
    tts_profile: "conflicting_profile",
  }), false);
  assert.equal(
    recoveryDisposition(QWEN_PLANNER_FIX_RECOVERY_KIND),
    "full_official_qwen_joel_voice_plan_and_narration_rebuild_after_committed_planner_fix",
  );
  const plannerFixEvidence = recoveryEvidence(
    QWEN_PLANNER_FIX_RECOVERY_KIND,
    { interrupted_partial_unit_wav_count: 82 },
  );
  assert.match(plannerFixEvidence.join(" "), /identity and canonical delivery profile remain unchanged/);
  assert.match(plannerFixEvidence.join(" "), /82 retained Qwen unit WAVs/);
  assert.doesNotMatch(plannerFixEvidence.join(" "), /Puck|identity migration/i);
  assert.equal(
    recoveryTriageFilename(
      QWEN_PLANNER_FIX_RECOVERY_KIND,
      "ep_01",
      "2026-07-29T01-00-00-000Z",
    ),
    "manual_blocker_triage_qwen_joel_planner_fix_relock_ep_01_2026-07-29T01-00-00-000Z.json",
  );
  assert.match(
    recoveryEvidence(PUCK_TO_QWEN_RECOVERY_KIND).join(" "),
    /superseded the prior narrator lock/,
  );
  const afterPlannerFix = relockedIdentityForTests(beforePlannerFix, {
    voiceProviderOptions: options,
    git: {
      ...cleanGit,
      commit: "qwen-after-planner-fix",
    },
    timestamp: "2026-07-29T01:00:00.000Z",
    archiveDir: "/episode/reports/recovery/qwen-planner-fix",
    previousIdentitySha256: "qwen-before-planner-fix-identity-sha",
    reason: "operator approved recovery after tested planner fix",
  });
  assert.equal(afterPlannerFix.tts_profile, QWEN_LIAM_PROFILE_ID);
  assert.equal(afterPlannerFix.tts_provider, "qwen_local");
  assert.equal(afterPlannerFix.narrator_voice_id, "joel_owned_narrator_clone");
  assert.equal(afterPlannerFix.tts_fallback_provider, null);
  assert.deepEqual(afterPlannerFix.voice_provider_options, options);
  assert.equal(afterPlannerFix.git.commit, "qwen-after-planner-fix");
  assert.equal(
    afterPlannerFix.narration_identity_relock.recovery_kind,
    QWEN_PLANNER_FIX_RECOVERY_KIND,
  );
  assert.equal(afterPlannerFix.narration_identity_relock.identity_changed, false);
  assert.equal(
    afterPlannerFix.narration_identity_relock.voice_identity_changed,
    false,
  );
  assert.equal(
    afterPlannerFix.narration_identity_relock.synthesis_contract_changed,
    false,
  );
  assert.equal(
    afterPlannerFix.narration_identity_relock.recovery_scope,
    "same_identity_relock_after_committed_tts_planner_fix",
  );
  assert.equal(
    afterPlannerFix.narration_identity_relock.invalidation_reason,
    "committed_tts_planner_unit_boundary_fix_invalidates_the_prior_voice_plan",
  );
  assert.equal(
    afterPlannerFix.narration_identity_relock.previous_git_commit,
    "qwen-before-planner-fix",
  );
  assert.equal(
    afterPlannerFix.narration_identity_relock.relock_git_commit,
    "qwen-after-planner-fix",
  );
  assert.equal(afterPlannerFix.narration_identity_relock_history.length, 1);
  assert.deepEqual(
    afterPlannerFix.narration_identity_relock_history[0],
    beforePlannerFix.narration_identity_relock,
  );
  assert.equal(
    JSON.stringify(afterPlannerFix.narration_identity_relock).includes("Puck"),
    false,
  );
  assert.equal(afterPlannerFix.title, beforePlannerFix.title);
  assert.equal(afterPlannerFix.source_sha256, beforePlannerFix.source_sha256);
  assert.equal(afterPlannerFix.image_provider, beforePlannerFix.image_provider);
  assert.deepEqual(
    afterPlannerFix.image_provider_options,
    beforePlannerFix.image_provider_options,
  );
  assert.throws(
    () => recoveryKindForIdentityForTests({
      tts_provider: "kokoro_local",
      narrator_voice_id: "am_michael",
    }),
    /supports Kokoro\/Puck or Qwen\/Liam migration to Joel\/Qwen/,
  );

  await runInterruptedQwenInventoryFixture();
}
