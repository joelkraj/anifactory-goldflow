import { workflowStageIds } from "./pipeline-stage-registry.mjs";

export const PRODUCTION_SLO_STATE_SCHEMA = "goldflow_production_slo_state_v1";

const CHECKPOINT_STAGE = Object.freeze({
  health_ready: null,
  audio_semantic_join: "timing_bind",
  visual_direction_complete: "reference_plan_approval",
  first_scene_wave_leased: "visual_prompt_plan",
  first_100_scene_images_measured: null,
  scene_images_and_incremental_qa_complete: "image_output_qa",
  master_render_complete: "premium_render",
  private_ready: "upload_packaging",
});

function stageReached(runStatus, stageId) {
  if (!stageId) return false;
  const ids = workflowStageIds();
  const currentIndex = ids.indexOf(String(runStatus?.current_stage ?? ""));
  const targetIndex = ids.indexOf(stageId);
  const row = runStatus?.stage_ledger?.find((candidate) => candidate.stage === stageId);
  return ["passed", "skipped_with_waiver"].includes(String(row?.state ?? ""))
    || currentIndex > targetIndex
    || runStatus?.current_stage === "complete";
}

export function buildProductionSloState({
  runStatus,
  profile,
  startedAt,
  now = new Date(),
  firstHundredMeasured = false,
} = {}) {
  const contract = profile?.orchestration?.wall_clock_contract ?? null;
  if (!contract || !startedAt) return null;
  const startMs = Date.parse(startedAt);
  const nowMs = now.getTime();
  const elapsedMinutes = Number.isFinite(startMs)
    ? Math.max(0, (nowMs - startMs) / 60_000)
    : 0;
  const checkpoints = (contract.checkpoints ?? []).map((checkpoint) => {
    const targetStage = CHECKPOINT_STAGE[checkpoint.id] ?? null;
    const reached = checkpoint.id === "health_ready"
      ? true
      : checkpoint.id === "first_100_scene_images_measured"
        ? firstHundredMeasured
        : stageReached(runStatus, targetStage);
    return {
      ...checkpoint,
      target_stage: targetStage,
      state: reached ? "passed" : elapsedMinutes > Number(checkpoint.deadline_minutes) ? "missed" : "pending",
    };
  });
  const missed = checkpoints.filter((checkpoint) => checkpoint.state === "missed");
  const hardCeiling = Number(contract.hard_ceiling_minutes ?? profile.target_wall_clock_band_minutes?.maximum ?? 420);
  const target = Number(contract.target_minutes ?? profile.target_wall_clock_minutes ?? 360);
  const state = elapsedMinutes > hardCeiling
    ? "breached"
    : missed.length ? "at_risk" : elapsedMinutes > target ? "over_target" : "on_track";
  return {
    schema: PRODUCTION_SLO_STATE_SCHEMA,
    status: "passed",
    production_profile: profile.id,
    clock_scope: contract.clock_scope,
    started_at: new Date(startMs).toISOString(),
    measured_at: now.toISOString(),
    elapsed_minutes: Number(elapsedMinutes.toFixed(3)),
    target_minutes: target,
    hard_ceiling_minutes: hardCeiling,
    state,
    current_stage: runStatus?.current_stage ?? null,
    missed_checkpoint_ids: missed.map((checkpoint) => checkpoint.id),
    checkpoints,
    overrun_policy: "continue_the_single_critical_path_and_surface_the_breach; never_start_optional_retries_or_hide_elapsed_time",
  };
}
