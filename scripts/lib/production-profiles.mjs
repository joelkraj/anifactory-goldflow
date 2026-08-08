import {
  productionLocalWhisperContract,
} from "./local-whisper-policy.mjs";

const profiles = {
  fast_premium_v1: {
    id: "fast_premium_v1",
    label: "Fast premium",
    target_wall_clock_minutes: 180,
    planner: {
      semantic_concurrency: 8,
      editorial_concurrency: 8,
      visual_ref_chunk_concurrency: 8,
      visual_chunk_concurrency: 8,
      chatgpt_web_semantic_concurrency: 10,
      chatgpt_web_editorial_concurrency: 10,
      chatgpt_web_visual_ref_chunk_concurrency: 10,
      chatgpt_web_deep_text_concurrency: 1,
      chatgpt_web_reasoning_starts_per_window: 2,
      chatgpt_web_reasoning_window_ms: 900_000,
      // Text and GPT Image retain independent queues beneath the shared browser-host cap.
      chatgpt_web_visual_chunk_concurrency: 10,
      // One authored response per planner unit. A failed unit is repaired later
      // by exact ID/chunk while every passed content-addressed unit stays frozen.
      chunk_validation_attempts: 1,
    },
    media: {
      tts_concurrency: 1,
      kokoro_tts_concurrency: 1,
      local_qwen_tts_concurrency: 1,
      qwen_tts_concurrency: 1,
      qwen_tts_batch_size: 4,
      reference_concurrency: 15,
      image_concurrency: 15,
      chatgpt_web_reference_concurrency: 3,
      chatgpt_web_image_concurrency: 3,
      focal_analysis_concurrency: 8,
      // A value of one means one creative provider submission, not one retry.
      // Status polling for an already-created provider job is still allowed.
      creative_submission_attempts: 1,
    },
    audio: {
      local_whisper_timing: productionLocalWhisperContract(),
    },
    render: {
      render_concurrency: 4,
      clip_preset: "veryfast",
      final_preset: "veryfast",
    },
    orchestration: {
      chatgpt_web_browser_host_concurrency: 10,
      parallel_audio_semantic: true,
      visual_wavefront_prefetch: true,
      incremental_image_qa: true,
      incremental_motion_clip_prefetch: true,
      wavefront_min_cuts: 15,
      wavefront_max_wait_ms: 5000,
      planner_recovery_policy: "scoped_only",
      passed_artifact_policy: "immutable",
      automatic_retry_policy: "none",
      aesthetic_finding_policy: "advisory",
      timing_rail_policy: "advisory",
    },
    advance: {
      authorize_planner_spend: true,
      authorize_media_spend: true,
      authorize_render: true,
      agent_validated_stages: ["visual_beat_plan"],
      max_attempts_per_stage: 1,
    },
  },
  balanced_v1: {
    id: "balanced_v1",
    label: "Balanced legacy",
    target_wall_clock_minutes: null,
    planner: {
      semantic_concurrency: 4,
      editorial_concurrency: 4,
      visual_ref_chunk_concurrency: 6,
      visual_chunk_concurrency: 6,
      chatgpt_web_semantic_concurrency: 4,
      chatgpt_web_editorial_concurrency: 4,
      chatgpt_web_visual_ref_chunk_concurrency: 5,
      chatgpt_web_visual_chunk_concurrency: 5,
      chunk_validation_attempts: 1,
    },
    media: {
      tts_concurrency: 1,
      kokoro_tts_concurrency: 1,
      local_qwen_tts_concurrency: 1,
      qwen_tts_concurrency: 1,
      qwen_tts_batch_size: 4,
      reference_concurrency: 15,
      image_concurrency: 15,
      focal_analysis_concurrency: 8,
      creative_submission_attempts: 1,
    },
    audio: {
      local_whisper_timing: productionLocalWhisperContract(),
    },
    render: {
      render_concurrency: 4,
      clip_preset: "veryfast",
      final_preset: "veryfast",
    },
    orchestration: {
      parallel_audio_semantic: false,
      visual_wavefront_prefetch: false,
      incremental_image_qa: false,
      incremental_motion_clip_prefetch: false,
      wavefront_min_cuts: 15,
      wavefront_max_wait_ms: 5000,
      planner_recovery_policy: "scoped_only",
      passed_artifact_policy: "immutable",
      automatic_retry_policy: "none",
      aesthetic_finding_policy: "advisory",
      timing_rail_policy: "advisory",
    },
    advance: {
      authorize_planner_spend: false,
      authorize_media_spend: false,
      authorize_render: false,
      agent_validated_stages: [],
      max_attempts_per_stage: 1,
    },
  },
};

const aliases = new Map([
  ["fast", "fast_premium_v1"],
  ["fast_premium", "fast_premium_v1"],
  ["fast-premium", "fast_premium_v1"],
  ["fast_premium_v1", "fast_premium_v1"],
  ["premium", "fast_premium_v1"],
  ["balanced", "balanced_v1"],
  ["balanced_v1", "balanced_v1"],
  ["legacy", "balanced_v1"],
]);

function clone(value) {
  return structuredClone(value);
}

export const DEFAULT_PRODUCTION_PROFILE = "fast_premium_v1";
export const LEGACY_PRODUCTION_PROFILE = "balanced_v1";

export function normalizeProductionProfile(value, fallback = DEFAULT_PRODUCTION_PROFILE) {
  const normalized = String(value ?? fallback).trim().toLowerCase().replace(/\s+/g, "_");
  const profileId = aliases.get(normalized);
  if (!profileId) throw new Error(`Unknown production profile: ${value}. Expected fast-premium or balanced.`);
  return profileId;
}

export function productionProfileById(value, fallback = DEFAULT_PRODUCTION_PROFILE) {
  const profileId = normalizeProductionProfile(value, fallback);
  return clone(profiles[profileId]);
}

export function productionProfileForIdentity(identity = {}) {
  const explicit = identity.production_profile ?? identity.throughput_profile ?? null;
  return productionProfileById(explicit, explicit ? DEFAULT_PRODUCTION_PROFILE : LEGACY_PRODUCTION_PROFILE);
}

export function productionProfileSummary(value = DEFAULT_PRODUCTION_PROFILE) {
  const profile = productionProfileById(value);
  return {
    id: profile.id,
    target_wall_clock_minutes: profile.target_wall_clock_minutes,
    planner: profile.planner,
    media: profile.media,
    audio: profile.audio,
    render: profile.render,
    orchestration: profile.orchestration,
    advance: profile.advance,
  };
}
