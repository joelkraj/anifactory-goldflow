import {
  productionLocalWhisperContract,
} from "./local-whisper-policy.mjs";

const profiles = {
  fast_premium_v1: {
    id: "fast_premium_v1",
    label: "Fast premium",
    // Production SLO: a normal longform episode should finish private-ready
    // inside five to seven elapsed hours. The size-aware forecast may set a
    // tighter target, but it must not quietly normalize a >7h critical path.
    target_wall_clock_minutes: 420,
    target_wall_clock_band_minutes: Object.freeze({ minimum: 300, maximum: 420 }),
    target_wall_clock_policy: "episode_size_aware_p50_p90_v1",
    stretch_target_wall_clock_minutes: 300,
    forecast: {
      expected_operator_checkpoint_count: 5,
      expected_minutes_per_checkpoint: 5,
    },
    planner: {
      federated_structured_pool: true,
      structured_pool_assignment_policy: "weighted_least_utilized_v1",
      // New stages begin with the proven eight-slot load, then the shared
      // capacity pool promotes itself to twelve only after clean completions.
      // Existing run identities retain the exact concurrency they recorded.
      codex_cli_structured_concurrency: 12,
      codex_cli_structured_initial_concurrency: 8,
      codex_cli_structured_ramp_successes_per_step: 4,
      codex_cli_structured_ramp_step: 2,
      codex_cli_structured_ramp_policy: "success_gated_in_stage_soak_v1",
      semantic_concurrency: 12,
      editorial_concurrency: 12,
      visual_ref_chunk_concurrency: 12,
      visual_chunk_concurrency: 12,
      // Disabled for production structured planning until the task-class
      // benchmark, permissions, and schema-output reliability are re-approved.
      antigravity_cli_structured_concurrency: 0,
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
      default_image_provider: "federated_google_web_image_pool",
      tts_concurrency: 1,
      kokoro_tts_concurrency: 1,
      local_qwen_tts_concurrency: 1,
      qwen_tts_concurrency: 1,
      qwen_tts_batch_size: 4,
      reference_concurrency: 8,
      image_concurrency: 8,
      chatgpt_web_reference_concurrency: 0,
      chatgpt_web_image_concurrency: 0,
      chatgpt_web_image_fallback_concurrency: 3,
      google_flow_reference_concurrency: 5,
      google_flow_image_concurrency: 5,
      google_flow_worker_session_policy: "persistent_project_per_worker_slot_v1",
      google_gemini_reference_concurrency: 3,
      google_gemini_image_concurrency: 3,
      google_gemini_worker_session_policy: "persistent_tab_per_worker_slot_v1",
      federated_google_primary_concurrency: 8,
      federated_web_image_concurrency: 8,
      generated_motion_concurrency: 3,
      hybrid_web_flow_reference_concurrency: 8,
      hybrid_web_flow_image_concurrency: 8,
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
      agent_director: {
        enabled: true,
        contract: "eight_macro_phases_v1",
        routine_stage_advancement: "automatic_until_approval_or_blocker",
        persistent_watch_resume: true,
        persistent_watch_policy: "state_change_resume_never_auto_approve_v1",
        analytics_feedback_nonblocking: true,
      },
      chatgpt_web_browser_host_concurrency: 10,
      google_flow_browser_host_concurrency: 5,
      google_flow_worker_pool_policy: "five_persistent_projects_top_off_v1",
      google_gemini_browser_host_concurrency: 3,
      google_gemini_worker_pool_policy: "three_persistent_tabs_top_off_v1",
      image_dispatch_policy: "first_available_top_off_v1",
      style_reference_barrier: true,
      google_flow_reference_binding_required: true,
      parallel_audio_semantic: true,
      visual_wavefront_prefetch: true,
      incremental_image_qa: true,
      incremental_motion_clip_prefetch: true,
      incremental_generated_motion_prefetch: true,
      generated_motion_coherence_prefetch: true,
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
      default_image_provider: "chatgpt_web_gpt_image",
      tts_concurrency: 1,
      kokoro_tts_concurrency: 1,
      local_qwen_tts_concurrency: 1,
      qwen_tts_concurrency: 1,
      qwen_tts_batch_size: 4,
      reference_concurrency: 15,
      image_concurrency: 15,
      generated_motion_concurrency: 1,
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
      agent_director: {
        enabled: false,
        contract: "detailed_stage_legacy_adapter",
        routine_stage_advancement: "explicit",
        analytics_feedback_nonblocking: true,
      },
      parallel_audio_semantic: false,
      visual_wavefront_prefetch: false,
      incremental_image_qa: false,
      incremental_motion_clip_prefetch: false,
      incremental_generated_motion_prefetch: false,
      generated_motion_coherence_prefetch: false,
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

function mergeProfileConfig(base, override) {
  if (Array.isArray(override)) return clone(override);
  if (!override || typeof override !== "object") return override;
  const result = base && typeof base === "object" && !Array.isArray(base)
    ? clone(base)
    : {};
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeProfileConfig(result[key], value)
      : clone(value);
  }
  return result;
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
  // A run identity is an immutable execution lock. Once preflight records the
  // full profile, later code releases must use that recorded contract rather
  // than silently migrating an in-flight or historical run to new defaults.
  if (identity?.production_profile_config
    && typeof identity.production_profile_config === "object"
    && !Array.isArray(identity.production_profile_config)) {
    const recorded = identity.production_profile_config;
    const completeRecordedProfile = [
      "planner",
      "media",
      "audio",
      "render",
      "orchestration",
      "advance",
    ].every((section) => recorded[section] && typeof recorded[section] === "object");
    if (completeRecordedProfile) return clone(recorded);
    const explicit = identity.production_profile ?? identity.throughput_profile ?? null;
    const baseline = productionProfileById(
      explicit,
      explicit ? DEFAULT_PRODUCTION_PROFILE : LEGACY_PRODUCTION_PROFILE,
    );
    return mergeProfileConfig(baseline, recorded);
  }
  const explicit = identity.production_profile ?? identity.throughput_profile ?? null;
  return productionProfileById(explicit, explicit ? DEFAULT_PRODUCTION_PROFILE : LEGACY_PRODUCTION_PROFILE);
}

export function productionProfileSummary(value = DEFAULT_PRODUCTION_PROFILE) {
  const profile = productionProfileById(value);
  return {
    id: profile.id,
    target_wall_clock_minutes: profile.target_wall_clock_minutes,
    target_wall_clock_band_minutes: profile.target_wall_clock_band_minutes ?? null,
    target_wall_clock_policy: profile.target_wall_clock_policy ?? null,
    stretch_target_wall_clock_minutes: profile.stretch_target_wall_clock_minutes ?? null,
    forecast: profile.forecast ?? null,
    planner: profile.planner,
    media: profile.media,
    audio: profile.audio,
    render: profile.render,
    orchestration: profile.orchestration,
    advance: profile.advance,
  };
}
