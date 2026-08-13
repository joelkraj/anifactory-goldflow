export const AGENT_DIRECTOR_SCHEMA = "goldflow_agent_director_v1";
export const AGENT_DIRECTOR_CHECKPOINT_SCHEMA = "goldflow_agent_director_checkpoints_v1";

export const AGENT_DIRECTOR_PHASES = Object.freeze([
  Object.freeze({
    id: "package_and_story",
    label: "Package and story",
    stages: Object.freeze(["run_identity", "source_ingest", "script_approval"]),
    operator_stops: Object.freeze(["winner_package", "final_script"]),
  }),
  Object.freeze({
    id: "script_and_audio",
    label: "Script and audio",
    stages: Object.freeze(["script_pace_check", "targeted_speakability", "semantic_scene_plan", "voice_plan", "qwen_tts_stitch", "local_whisper_word_timing", "audio_pace_check", "timing_bind", "sfx_score_plan", "longform_audio_mix"]),
    operator_stops: Object.freeze([]),
  }),
  Object.freeze({
    id: "semantic_and_visual_direction",
    label: "Semantic and visual direction",
    stages: Object.freeze(["visual_beat_plan", "visual_reference_plan", "reference_plan_approval"]),
    operator_stops: Object.freeze(["core_style_and_identity"]),
  }),
  Object.freeze({
    id: "references_and_images",
    label: "References and images",
    stages: Object.freeze(["reference_generation", "reference_image_approval", "visual_prompt_plan", "visual_prompt_harden", "visual_prompt_blocker_repair", "transition_edit_plan", "image_generation", "image_focal_analysis", "image_output_qa"]),
    operator_stops: Object.freeze(["opening_audiovisual_proof"]),
  }),
  Object.freeze({
    id: "motion_and_audio_design",
    label: "Motion and audio design",
    stages: Object.freeze(["animation_direction_plan", "generated_video_motion", "generated_video_motion_approval", "parallax_asset_generation", "parallax_asset_approval", "motion_edit_plan"]),
    operator_stops: Object.freeze([]),
  }),
  Object.freeze({
    id: "render_and_qa",
    label: "Render and QA",
    stages: Object.freeze(["premium_render", "final_qa"]),
    operator_stops: Object.freeze(["final_master"]),
  }),
  Object.freeze({
    id: "publish_and_ab_test",
    label: "Publish and A/B test",
    stages: Object.freeze(["upload_packaging", "youtube_publish_readiness", "youtube_studio_upload", "youtube_pinned_comment"]),
    operator_stops: Object.freeze(["release_and_ab_test"]),
  }),
  Object.freeze({
    id: "analytics_feedback",
    label: "Analytics feedback",
    stages: Object.freeze([]),
    operator_stops: Object.freeze([]),
    nonblocking: true,
  }),
]);

export const AGENT_DIRECTOR_CHECKPOINTS = Object.freeze([
  "winner_package",
  "final_script",
  "core_style_and_identity",
  "opening_audiovisual_proof",
  "final_master",
  "release_and_ab_test",
]);

const satisfiedStates = new Set(["passed", "skipped_with_waiver"]);
const explicitBoundaryCheckpoints = new Set(["opening_audiovisual_proof"]);

function unresolvedBoundaryCheckpoints(currentPhase, checkpoints = {}) {
  if (currentPhase.id !== "motion_and_audio_design") return [];
  const currentIndex = AGENT_DIRECTOR_PHASES.findIndex((phase) => phase.id === currentPhase.id);
  return AGENT_DIRECTOR_PHASES.slice(0, Math.max(0, currentIndex))
    .flatMap((phase) => phase.operator_stops)
    .filter((checkpoint) => explicitBoundaryCheckpoints.has(checkpoint))
    .filter((checkpoint) => checkpoints?.approvals?.[checkpoint]?.approved !== true);
}

export function agentDirectorPhase(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const phase = AGENT_DIRECTOR_PHASES.find((row) => row.id === normalized);
  if (!phase) throw new Error(`Unknown agent-director phase ${value}.`);
  return phase;
}

export function agentDirectorPhaseForStage(stageId) {
  return AGENT_DIRECTOR_PHASES.find((phase) => phase.stages.includes(String(stageId))) ?? AGENT_DIRECTOR_PHASES.at(-1);
}

export function nextAgentDirectorPhase(phaseId) {
  const index = AGENT_DIRECTOR_PHASES.findIndex((phase) => phase.id === String(phaseId));
  return index >= 0 ? AGENT_DIRECTOR_PHASES[index + 1] ?? null : null;
}

export function agentDirectorStatus(runStatus, checkpoints = {}, options = {}) {
  const rows = new Map((runStatus?.stage_ledger ?? []).map((row) => [String(row.stage), row]));
  const currentStage = String(runStatus?.current_stage ?? "complete");
  const analyticsFeedback = options.analyticsFeedback ?? null;
  const currentPhase = currentStage === "complete"
    ? AGENT_DIRECTOR_PHASES.at(-1)
    : agentDirectorPhaseForStage(currentStage);
  const checkpointHold = unresolvedBoundaryCheckpoints(currentPhase, checkpoints);
  const phases = AGENT_DIRECTOR_PHASES.map((phase) => {
    const stageRows = phase.stages.map((stageId) => rows.get(stageId)).filter(Boolean);
    const complete = phase.nonblocking
      ? currentStage === "complete" && (!analyticsFeedback || analyticsFeedback.state === "complete")
      : stageRows.length === phase.stages.length && stageRows.every((row) => satisfiedStates.has(String(row.state)));
    const blocking = stageRows.find((row) => ["blocked", "failed", "stale"].includes(String(row.state))) ?? null;
    const phaseState = phase.nonblocking && currentStage === "complete" && !complete
      ? "active"
      : complete
        ? "passed"
        : blocking
          ? "blocked"
          : currentPhase.id === phase.id
            ? "active"
            : "pending";
    return {
      id: phase.id,
      label: phase.label,
      state: phaseState,
      stages: stageRows.map((row) => ({ stage: row.stage, state: row.state })),
      operator_stops: phase.operator_stops.map((checkpoint) => ({
        checkpoint,
        approved: checkpoints?.approvals?.[checkpoint]?.approved === true,
      })),
      nonblocking: phase.nonblocking === true,
    };
  });
  return {
    schema: AGENT_DIRECTOR_SCHEMA,
    status: "passed",
    current_phase: currentPhase.id,
    current_phase_label: currentPhase.label,
    current_stage: currentStage,
    current_stage_state: runStatus?.current_stage_state ?? null,
    phases,
    analytics_feedback: analyticsFeedback,
    checkpoint_hold: checkpointHold,
    next_command_shape: checkpointHold.length
      ? `node bin/goldflow.mjs run director --episode-dir <episode-dir> --action checkpoint --checkpoint ${checkpointHold[0]} --approve true --approved-by <name> --note <evidence>`
      : runStatus?.next_command_shape ?? null,
  };
}
