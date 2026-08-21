export const EPISODE_SIZE_AWARE_FORECAST_POLICY = "episode_size_aware_p50_p90_v1";

const STAGE_TASK_CLASS = Object.freeze({
  run_identity: "setup",
  source_ingest: "setup",
  script_approval: "story_quality",
  script_pace_check: "story_quality",
  targeted_speakability: "story_quality",
  semantic_scene_plan: "semantic_planning",
  voice_plan: "audio_planning",
  qwen_tts_stitch: "audio_generation",
  local_whisper_word_timing: "audio_analysis",
  audio_pace_check: "audio_analysis",
  timing_bind: "audio_analysis",
  sfx_score_plan: "audio_design",
  longform_audio_mix: "audio_design",
  visual_beat_plan: "visual_planning",
  visual_reference_plan: "visual_planning",
  reference_plan_approval: "operator_checkpoint",
  reference_generation: "reference_generation",
  reference_image_approval: "operator_checkpoint",
  visual_prompt_plan: "visual_planning",
  visual_prompt_harden: "visual_planning",
  visual_prompt_blocker_repair: "visual_planning",
  transition_edit_plan: "edit_planning",
  image_generation: "still_generation",
  image_focal_analysis: "image_qa",
  image_output_qa: "image_qa",
  animation_direction_plan: "motion_planning",
  generated_video_motion: "video_generation",
  generated_video_motion_approval: "operator_checkpoint",
  parallax_asset_generation: "motion_generation",
  parallax_asset_approval: "operator_checkpoint",
  motion_edit_plan: "motion_planning",
  premium_render: "render",
  final_qa: "final_qa",
  upload_packaging: "packaging",
  youtube_publish_readiness: "publishing",
  youtube_studio_upload: "publishing",
  youtube_pinned_comment: "publishing",
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

function round(value, digits = 3) {
  return Number(Number(value ?? 0).toFixed(digits));
}

function percentile(values, fraction) {
  const rows = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!rows.length) return null;
  if (rows.length === 1) return rows[0];
  const index = (rows.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return rows[lower];
  return rows[lower] + (rows[upper] - rows[lower]) * (index - lower);
}

function dateMs(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function stageLatencyPercentiles(events = []) {
  const taskSamples = new Map();
  const stageSamples = new Map();
  for (const event of events) {
    if (event?.event_type !== "stage_completed") continue;
    const started = dateMs(event.started_at);
    const completed = dateMs(event.completed_at);
    if (started === null || completed === null || completed < started) continue;
    const durationMinutes = (completed - started) / 60_000;
    const stage = String(event.stage ?? "unknown");
    const taskClass = STAGE_TASK_CLASS[stage] ?? "other";
    const stageRows = stageSamples.get(stage) ?? [];
    stageRows.push(durationMinutes);
    stageSamples.set(stage, stageRows);
    const taskRows = taskSamples.get(taskClass) ?? [];
    taskRows.push(durationMinutes);
    taskSamples.set(taskClass, taskRows);
  }
  const summarize = (entries) => [...entries.entries()]
    .map(([id, values]) => ({
      id,
      sample_count: values.length,
      p50_minutes: round(percentile(values, 0.5)),
      p90_minutes: round(percentile(values, 0.9)),
      maximum_minutes: round(Math.max(...values)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    schema: "goldflow_stage_latency_percentiles_v1",
    by_task_class: summarize(taskSamples).map(({ id, ...row }) => ({ task_class: id, ...row })),
    by_stage: summarize(stageSamples).map(({ id, ...row }) => ({ stage: id, ...row })),
  };
}

function workstream(id, p50, p90, basis) {
  return {
    id,
    p50_minutes: round(Math.max(0, p50)),
    p90_minutes: round(Math.max(p50, p90)),
    basis,
  };
}

export function buildEpisodeProductionForecast({
  scriptWordCount = 0,
  narrationDurationMinutes = null,
  requiredStillCount = 0,
  referenceCount = 0,
  generatedMotionCount = 0,
  imageConcurrency = 8,
  plannerConcurrency = 8,
  plannerInitialConcurrency = null,
  generatedMotionConcurrency = 3,
  imageFailureRate = 0.1,
  expectedOperatorCheckpointCount = 5,
  expectedMinutesPerCheckpoint = 5,
  renderCacheWarm = false,
  earlyGeneratedMotionWavefront = true,
  stageLatency = null,
  stretchTargetMinutes = 180,
} = {}) {
  const words = Math.max(0, finiteNumber(scriptWordCount));
  const duration = positiveNumber(narrationDurationMinutes, Math.max(1, words / 185));
  const stills = Math.max(0, Math.round(finiteNumber(requiredStillCount)));
  const references = Math.max(0, Math.round(finiteNumber(referenceCount)));
  const motion = Math.max(0, Math.round(finiteNumber(generatedMotionCount)));
  const baseImageConcurrency = Math.max(1, Math.round(positiveNumber(imageConcurrency, 8)));
  const plannerCeiling = Math.max(1, Math.round(positiveNumber(plannerConcurrency, 8)));
  const plannerInitial = Math.min(
    plannerCeiling,
    Math.max(1, Math.round(positiveNumber(plannerInitialConcurrency, plannerCeiling))),
  );
  const effectivePlannerConcurrency = Math.max(1, Math.round((plannerInitial + plannerCeiling) / 2));
  const failureRate = Math.min(0.75, Math.max(0, finiteNumber(imageFailureRate, 0.1)));
  const effectiveImageConcurrency = Math.max(1, baseImageConcurrency * (1 - failureRate));
  const videoConcurrency = Math.max(1, Math.round(positiveNumber(generatedMotionConcurrency, 3)));

  const setup = workstream(
    "setup_and_story_gates",
    10 + words / 1_000 * 1.2,
    16 + words / 1_000 * 2,
    "source ingest, approvals, pace, and speakability",
  );
  const audio = workstream(
    "audio_branch",
    9 + duration * 0.48,
    15 + duration * 0.78,
    "voice planning, resident Qwen synthesis, Whisper, pace, and mix",
  );
  const semantic = workstream(
    "semantic_branch",
    12 + words / 1_000 * 2.2,
    20 + words / 1_000 * 3.5,
    "federated semantic extraction and reconciliation",
  );
  const forkJoin = workstream(
    "audio_semantic_fork_join",
    Math.max(audio.p50_minutes, semantic.p50_minutes),
    Math.max(audio.p90_minutes, semantic.p90_minutes),
    "audio and semantic branches execute concurrently",
  );
  const beats = workstream(
    "beat_and_reference_direction",
    8 + stills * 0.04,
    15 + stills * 0.075,
    "editorial beats, global reference direction, and approvals",
  );
  const referenceGeneration = workstream(
    "reference_generation",
    Math.ceil(references / baseImageConcurrency) * 3.2,
    Math.ceil(references / baseImageConcurrency) * 5.5,
    `${references} references across ${baseImageConcurrency} image workers`,
  );
  const promptPlanning = workstream(
    "prompt_planning",
    Math.ceil(stills / effectivePlannerConcurrency) * 1.35,
    Math.ceil(stills / effectivePlannerConcurrency) * 2.25,
    `${stills} cuts through the ${plannerInitial}-${plannerCeiling}-slot success-ramped Codex Medium structured planning pool`,
  );
  const stillGeneration = workstream(
    "still_generation",
    Math.ceil(stills / effectiveImageConcurrency) * 3.4,
    Math.ceil(stills / effectiveImageConcurrency) * 5.4,
    `${stills} cuts at ${round(effectiveImageConcurrency, 2)} failure-adjusted concurrent workers`,
  );
  const promptImageWavefront = workstream(
    "prompt_image_wavefront",
    Math.max(promptPlanning.p50_minutes, stillGeneration.p50_minutes)
      + Math.min(promptPlanning.p50_minutes, stillGeneration.p50_minutes) * 0.15,
    Math.max(promptPlanning.p90_minutes, stillGeneration.p90_minutes)
      + Math.min(promptPlanning.p90_minutes, stillGeneration.p90_minutes) * 0.2,
    "accepted prompt chunks feed image generation before the full prompt plan finishes",
  );
  const video = workstream(
    "generated_video",
    Math.ceil(motion / videoConcurrency) * 7,
    Math.ceil(motion / videoConcurrency) * 12,
    `${motion} selected clips across ${videoConcurrency} Flow video workers`,
  );
  const videoCriticalAddition = earlyGeneratedMotionWavefront
    ? workstream(
      "generated_video_critical_addition",
      Math.max(0, video.p50_minutes - stillGeneration.p50_minutes * 0.25),
      Math.max(0, video.p90_minutes - stillGeneration.p90_minutes * 0.2),
      "hero clips overlap the final still-generation window",
    )
    : workstream(
      "generated_video_critical_addition",
      video.p50_minutes,
      video.p90_minutes,
      "video starts only after still generation",
    );
  const imageMotionQa = workstream(
    "image_motion_qa",
    10 + stills * 0.025 + motion * 0.35,
    18 + stills * 0.045 + motion * 0.7,
    "incremental focal, structural, generated-motion, parallax, and motion-plan QA",
  );
  const render = workstream(
    "render_and_final_qa",
    (renderCacheWarm ? 6 : 12) + duration * (renderCacheWarm ? 0.12 : 0.22),
    (renderCacheWarm ? 12 : 22) + duration * (renderCacheWarm ? 0.2 : 0.36),
    renderCacheWarm ? "warm motion/render cache" : "cold motion/render cache",
  );
  const publishing = workstream(
    "packaging_and_publish_readiness",
    18,
    35,
    "packaging, final manifest, private-first upload preparation",
  );
  const checkpoints = workstream(
    "expected_operator_checkpoints",
    Math.max(0, expectedOperatorCheckpointCount) * Math.max(0, expectedMinutesPerCheckpoint),
    Math.max(0, expectedOperatorCheckpointCount) * Math.max(0, expectedMinutesPerCheckpoint) * 2,
    `${expectedOperatorCheckpointCount} checkpoints at ${expectedMinutesPerCheckpoint} assumed minutes each`,
  );
  const automatedRows = [
    setup,
    forkJoin,
    beats,
    referenceGeneration,
    promptImageWavefront,
    videoCriticalAddition,
    imageMotionQa,
    render,
    publishing,
  ];
  const automatedP50 = automatedRows.reduce((sum, row) => sum + row.p50_minutes, 0);
  const automatedP90 = automatedRows.reduce((sum, row) => sum + row.p90_minutes, 0);
  const totalP50 = automatedP50 + checkpoints.p50_minutes;
  const totalP90 = automatedP90 + checkpoints.p90_minutes;

  return {
    schema: "goldflow_episode_production_forecast_v1",
    policy: EPISODE_SIZE_AWARE_FORECAST_POLICY,
    status: "forecast",
    inputs: {
      script_word_count: words,
      narration_duration_minutes: round(duration),
      required_still_count: stills,
      reference_count: references,
      generated_motion_count: motion,
      image_concurrency: baseImageConcurrency,
      effective_image_concurrency: round(effectiveImageConcurrency, 2),
      generated_motion_concurrency: videoConcurrency,
      image_failure_rate_percent: round(failureRate * 100, 2),
      expected_operator_checkpoint_count: expectedOperatorCheckpointCount,
      expected_minutes_per_checkpoint: expectedMinutesPerCheckpoint,
      render_cache_warm: Boolean(renderCacheWarm),
      early_generated_motion_wavefront: Boolean(earlyGeneratedMotionWavefront),
    },
    forecast: {
      automated_p50_minutes: round(automatedP50),
      automated_p90_minutes: round(automatedP90),
      operator_p50_minutes: checkpoints.p50_minutes,
      operator_p90_minutes: checkpoints.p90_minutes,
      total_p50_minutes: round(totalP50),
      total_p90_minutes: round(totalP90),
      stretch_target_minutes: Number.isFinite(Number(stretchTargetMinutes))
        ? Number(stretchTargetMinutes)
        : null,
    },
    workstreams: [...automatedRows, checkpoints],
    observed_stage_latency: stageLatency,
    confidence: stageLatency?.by_stage?.length >= 5 ? "measured_plus_baseline" : "baseline",
    caveats: [
      "Forecasts are capacity plans, not completion guarantees.",
      "Operator wait is reported separately from automated critical-path time.",
      "Provider throttles, manual creative repairs, and quota exhaustion can exceed p90.",
    ],
  };
}
