#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  buildTtsSpokenTextAudit,
  ttsSpokenTextAuditMatches,
} from "../lib/tts-spoken-text-audit.mjs";
import {
  YOUTUBE_NATIVE_AB_PLAN_SCHEMA,
  YOUTUBE_NATIVE_AB_RECEIPT_SCHEMA,
  validateYoutubeAbCandidates,
  validateYoutubeNativeAbPlan,
  validateYoutubeNativeAbReceipt,
  youtubeAbPlanSha256,
} from "../lib/youtube-ab-test-contract.mjs";
import {
  YOUTUBE_ANALYTICS_SNAPSHOT_SCHEMA,
  analyticsDirectorFeedback,
  buildMidrollRetentionCliffAnalysis,
  buildYoutubeAnalyticsFollowupPlan,
  validateYoutubeAnalyticsSnapshot,
} from "../lib/youtube-analytics-followup-contract.mjs";
import {
  AGENT_DIRECTOR_PHASES,
  agentDirectorStatus,
} from "../lib/agent-director-contract.mjs";
import {
  DIRECTOR_WATCH_SCHEMA,
  directorWatchDecision,
  directorWatchDispatchKey,
  directorWatchRestartState,
  directorWatchSignature,
  executionEventsCursorFromText,
} from "../lib/director-watch-policy.mjs";
import {
  GENERATED_MOTION_PROVIDER_FLOW,
  generatedMotionIdentityContract,
  requiredGeneratedMotionCoverageFindings,
} from "../lib/generated-motion-contract.mjs";
import {
  FEDERATED_PLANNING_ROOM_SCHEMA,
  PLANNING_ROOM_PROVIDER,
  planningRoomContract,
} from "../lib/planner-provider-registry.mjs";
import {
  acquireFederatedPlannerSlot,
  effectivePlannerConcurrencyForTests,
  federatedPlannerPoolSnapshotForTests,
  resetFederatedPlannerPoolForTests,
} from "../lib/planner-capacity-pool.mjs";

const source = "The crew crossed the ruined station while Joey watched every doorway and reported each limit before anyone trusted the next move. Mira changed the route around his warning, Oren secured the loose beam, and Tess guided the last family toward daylight before the damaged ceiling settled behind them.";
const validPlan = {
  units: [{
    unit_id: "unit_001",
    kind: "narration",
    source_text: source,
    caption_text: source,
    spoken_text: source,
  }],
};
const audit = buildTtsSpokenTextAudit({
  plan: validPlan,
  sourceScriptSha256: "script-hash",
  overridesSha256: "override-hash",
  provider: "qwen_local",
  voiceId: "joel_owned_narrator_clone",
});
assert.equal(audit.status, "passed");
assert.equal(ttsSpokenTextAuditMatches({
  audit,
  plan: validPlan,
  sourceScriptSha256: "script-hash",
  overridesSha256: "override-hash",
}), true);
const riskyAudit = buildTtsSpokenTextAudit({
  plan: { units: [{ unit_id: "unit_risky", kind: "narration", source_text: "Kael Voss read the SSS rank notice at 41%.", caption_text: "Kael Voss read the SSS rank notice at 41%.", spoken_text: "Kael Voss read the S S S rank notice at forty-one percent." }] },
  sourceScriptSha256: "script-hash",
});
assert.ok(riskyAudit.pronunciation_homograph_ledger.entry_count >= 4);
assert.ok(riskyAudit.pronunciation_homograph_ledger.entries.some((row) => row.category === "proper_name"));
assert.ok(riskyAudit.pronunciation_homograph_ledger.entries.some((row) => row.category === "homograph"));

const itRegression = buildTtsSpokenTextAudit({
  plan: { units: [{ unit_id: "unit_it", kind: "system", source_text: "IT was over.", caption_text: "IT was over.", spoken_text: "I T was over." }] },
  sourceScriptSha256: "script-hash",
});
assert.equal(itRegression.status, "blocked");
assert.ok(itRegression.blockers.some((row) => row.code === "ordinary_it_pronoun_expanded_as_initialism"));
const numericRegression = buildTtsSpokenTextAudit({
  plan: { units: [{ unit_id: "unit_number", kind: "system", source_text: "Level 418.", caption_text: "Level 418.", spoken_text: "Level 418." }] },
  sourceScriptSha256: "script-hash",
});
assert.ok(numericRegression.blockers.some((row) => row.code === "unresolved_numeric_digit_in_spoken_text"));

const candidates = {
  schema: "goldflow_youtube_ab_candidates_v1",
  test_type: "title_and_thumbnail",
  baseline_variant_id: "baseline",
  candidates: [
    { id: "baseline", title: "My Fiancée Betrayed Me, So I Stole the Hero's Healer", thumbnail_path: "/tmp/a.png", hypothesis: "Direct betrayal wins browse." },
    { id: "revenge", title: "She Chose the SSS Hero, Then I Took His S-Rank Healer", thumbnail_path: "/tmp/b.png", hypothesis: "The concrete takeback wins suggested." },
  ],
};
assert.equal(validateYoutubeAbCandidates(candidates).status, "passed");
const plan = {
  schema: YOUTUBE_NATIVE_AB_PLAN_SCHEMA,
  status: "approved",
  episode: "ep_01",
  test_type: candidates.test_type,
  baseline_variant_id: candidates.baseline_variant_id,
  packaging_spec_path: "/tmp/package.json",
  packaging_spec_sha256: "package-hash",
  approved_by: "operator",
  approved_at: "2026-08-11T12:00:00.000Z",
  variants: candidates.candidates.map((row, index) => ({
    ...row,
    title_sha256: createHash("sha256").update(row.title).digest("hex"),
    thumbnail_sha256: String(index + 1).repeat(64),
  })),
};
plan.plan_sha256 = youtubeAbPlanSha256(plan);
assert.equal(validateYoutubeNativeAbPlan(plan, {
  packagingSpecSha256: "package-hash",
  baselineTitle: plan.variants[0].title,
  baselineThumbnailSha256: plan.variants[0].thumbnail_sha256,
}).status, "passed");
const uploadReceipt = { video_id: "abc123" };
const abReceipt = {
  schema: YOUTUBE_NATIVE_AB_RECEIPT_SCHEMA,
  status: "passed",
  plan_sha256: "plan-file-hash",
  upload_receipt_sha256: "upload-hash",
  video_id: "abc123",
  studio_url: "https://studio.youtube.com/video/abc123/edit",
  experiment_state: "active",
  configured_variant_ids: ["baseline", "revenge"],
  field_verification: { active_channel: true, native_test: true },
  recorded_by: "operator",
  recorded_at: "2026-08-11T12:05:00.000Z",
};
assert.equal(validateYoutubeNativeAbReceipt(abReceipt, {
  plan,
  planSha256: "plan-file-hash",
  uploadReceipt,
  uploadReceiptSha256: "upload-hash",
}).status, "passed");

const followupPlan = buildYoutubeAnalyticsFollowupPlan({
  episode: "ep_01",
  uploadReceiptPath: "/tmp/upload.json",
  uploadReceiptSha256: "upload-hash",
  uploadReceipt: { video_id: "abc123", visibility: "scheduled", schedule_at: "2026-08-12T12:00:00.000Z" },
});
assert.equal(followupPlan.status, "scheduled");
assert.deepEqual(followupPlan.checkpoints.map((row) => row.id), ["24h", "72h", "7d"]);
assert.equal(followupPlan.checkpoints[0].due_at, "2026-08-13T12:00:00.000Z");
const metrics = {
  impressions: 10000,
  browse_ctr_percent: 7.2,
  suggested_ctr_percent: 5.1,
  first_30_sec_retention_percent: 74,
  first_60_sec_retention_percent: 65,
  average_view_duration_sec: 820,
  average_percentage_viewed: 31,
  traffic_sources: { browse: 60, suggested: 25 },
  new_viewers_percent: 82,
  returning_viewers_percent: 18,
  native_ab_watch_time: { status: "active", leader: "baseline" },
};
const snapshot = {
  schema: YOUTUBE_ANALYTICS_SNAPSHOT_SCHEMA,
  status: "passed",
  video_id: "abc123",
  window: "24h",
  captured_at: "2026-08-13T12:05:00.000Z",
  captured_by: "operator",
  followup_plan_sha256: "followup-hash",
  upload_receipt_sha256: "upload-hash",
  metrics,
};
assert.equal(validateYoutubeAnalyticsSnapshot(snapshot, { plan: followupPlan, planSha256: "followup-hash" }).status, "passed");
assert.equal(analyticsDirectorFeedback(metrics).opening.first_30_sec_retention_percent, 74);

const experimentId = "manhwa_joey_75min_manual_midroll_v1";
const experimentPlan = buildYoutubeAnalyticsFollowupPlan({
  episode: "ep_02",
  uploadReceiptPath: "/tmp/upload-experiment.json",
  uploadReceiptSha256: "upload-experiment-hash",
  uploadReceipt: {
    video_id: "experiment123",
    visibility: "scheduled",
    schedule_at: "2026-08-12T12:00:00.000Z",
    channel_experiment: { experiment_id: experimentId, config_sha256: "config-hash", ordinal: 1 },
  },
  publishManifest: {
    publish_settings: { manual_mid_roll_positions_sec: [1125, 2250, 3375] },
    channel_experiment: {
      experiment_id: experimentId,
      config_sha256: "config-hash",
      ordinal: 1,
      eligible_upload_count: 3,
      final_duration_sec: 4500,
      measurement: {
        within_video_ad_cliff_control: {
          enabled: true,
          curve_metric: "audience_retention",
          curve_x_dimension: "elapsedVideoTimeRatio",
          curve_y_metric: "audienceWatchRatio",
          sample_offsets_seconds: [-135, -45, 0, 45, 135],
        },
      },
    },
  },
});
assert.equal(experimentPlan.channel_experiment.experiment_id, experimentId);
assert.ok(experimentPlan.required_metrics.includes("audience_retention"));
const experimentMetrics = {
  ...metrics,
  audience_retention: {
    status: "available",
    source: "youtube_analytics_elapsedVideoTimeRatio",
    points: Array.from({ length: 101 }, (_, index) => {
      const elapsedVideoTimeRatio = index / 100;
      const adAlignedPenalty = [0.25, 0.5, 0.75]
        .filter((position) => elapsedVideoTimeRatio >= position)
        .length * 0.03;
      return {
        elapsedVideoTimeRatio,
        audienceWatchRatio: 1 - (elapsedVideoTimeRatio * 0.4) - adAlignedPenalty,
      };
    }),
  },
};
const midrollAnalysis = buildMidrollRetentionCliffAnalysis({ metrics: experimentMetrics, plan: experimentPlan });
assert.equal(midrollAnalysis.status, "available");
assert.equal(midrollAnalysis.insertions.length, 3);
assert.ok(midrollAnalysis.insertions.every((row) => row.excess_local_drop_percentage_points > 0));
const experimentSnapshot = {
  schema: YOUTUBE_ANALYTICS_SNAPSHOT_SCHEMA,
  status: "passed",
  video_id: "experiment123",
  window: "24h",
  captured_at: "2026-08-13T12:05:00.000Z",
  captured_by: "operator",
  followup_plan_sha256: "experiment-followup-hash",
  upload_receipt_sha256: "upload-experiment-hash",
  metrics: experimentMetrics,
  midroll_retention_cliff_analysis: midrollAnalysis,
};
assert.equal(validateYoutubeAnalyticsSnapshot(experimentSnapshot, {
  plan: experimentPlan,
  planSha256: "experiment-followup-hash",
}).status, "passed");
const unavailableMetrics = {
  ...metrics,
  audience_retention: {
    status: "unavailable",
    reason: "YouTube has not exposed a retention curve yet.",
  },
};
const unavailableAnalysis = buildMidrollRetentionCliffAnalysis({ metrics: unavailableMetrics, plan: experimentPlan });
assert.equal(unavailableAnalysis.status, "unavailable");

assert.equal(AGENT_DIRECTOR_PHASES.length, 8);
const stageLedger = AGENT_DIRECTOR_PHASES.flatMap((phase) => phase.stages.map((stage) => ({ stage, state: "passed" })));
const director = agentDirectorStatus(
  { current_stage: "complete", current_stage_state: "passed", stage_ledger: stageLedger },
  {},
  { analyticsFeedback: { state: "complete", non_blocking: true, checkpoints: [] } },
);
assert.equal(director.phases.every((phase) => phase.state === "passed"), true);
const observingDirector = agentDirectorStatus(
  { current_stage: "complete", current_stage_state: "passed", stage_ledger: stageLedger },
  {},
  { analyticsFeedback: { state: "due", non_blocking: true, checkpoints: [{ id: "24h", state: "due" }] } },
);
assert.equal(observingDirector.phases.at(-1).state, "active");
assert.equal(observingDirector.analytics_feedback.state, "due");
const motionStageLedger = stageLedger.map((row) => ({
  ...row,
  state: AGENT_DIRECTOR_PHASES.slice(0, 4).some((phase) => phase.stages.includes(row.stage)) ? "passed" : "missing",
}));
const proofHeldDirector = agentDirectorStatus({
  current_stage: "animation_direction_plan",
  current_stage_state: "missing",
  stage_ledger: motionStageLedger,
});
assert.deepEqual(proofHeldDirector.checkpoint_hold, [], "V2 does not impose an opening-proof pause unless a human stage flag requests one");
const proofApprovedDirector = agentDirectorStatus({
  current_stage: "animation_direction_plan",
  current_stage_state: "missing",
  stage_ledger: motionStageLedger,
}, { approvals: { opening_audiovisual_proof: { approved: true } } });
assert.deepEqual(proofApprovedDirector.checkpoint_hold, []);
const watchStatus = {
  episode_dir: "/episode",
  identity: { episode: "ep_01" },
  current_stage: "semantic_scene_plan",
  current_stage_state: "missing",
  next_command_shape: "node bin/goldflow.mjs semantic plan --episode-dir /episode",
  stage_ledger: [{ stage: "semantic_scene_plan", state: "missing" }],
};
const emptyExecutionCursor = executionEventsCursorFromText("");
const watchSignature = directorWatchSignature(watchStatus, { approvals: {} }, emptyExecutionCursor);
const watchDispatchKey = directorWatchDispatchKey(watchStatus);
assert.equal(watchSignature, directorWatchSignature(watchStatus, { approvals: {} }, emptyExecutionCursor));
const startedExecutionLine = `${JSON.stringify({
  schema: "goldflow_execution_event_v1",
  event_type: "stage_started",
  execution_id: "execution-semantic-1",
  stage: "semantic_scene_plan",
})}\n`;
const openExecutionCursor = executionEventsCursorFromText(startedExecutionLine);
assert.notEqual(
  watchSignature,
  directorWatchSignature(watchStatus, { approvals: {} }, openExecutionCursor),
  "execution-event advancement must participate in the watcher state signature",
);
assert.equal(
  watchDispatchKey,
  directorWatchDispatchKey(watchStatus),
  "an unchanged stage must keep one dispatch key",
);
assert.equal(
  watchDispatchKey,
  directorWatchDispatchKey({ ...watchStatus }),
  "observation-only changes must not authorize another dispatch",
);
assert.deepEqual(openExecutionCursor.open_execution_ids, ["execution-semantic-1"]);
const completedExecutionCursor = executionEventsCursorFromText(`${startedExecutionLine}${JSON.stringify({
  schema: "goldflow_execution_event_v1",
  event_type: "stage_completed",
  execution_id: "execution-semantic-1",
  stage: "semantic_scene_plan",
  status: "passed",
})}\n`);
assert.deepEqual(completedExecutionCursor.open_execution_ids, []);
assert.deepEqual(directorWatchDecision({
  runStatus: watchStatus,
  director: { checkpoint_hold: [] },
  profile: { advance: { agent_validated_stages: ["visual_beat_plan"] } },
  signature: watchSignature,
}), { action: "advance", reason: "automatic_stage_ready" });
assert.deepEqual(directorWatchDecision({
  runStatus: watchStatus,
  director: { checkpoint_hold: [] },
  signature: watchSignature,
  lastActionedSignature: watchSignature,
  dispatchKey: watchDispatchKey,
  lastActionedDispatchKey: watchDispatchKey,
}), { action: "wait", reason: "awaiting_state_change" });
assert.deepEqual(directorWatchDecision({
  runStatus: { ...watchStatus, current_stage: "script_approval" },
  director: { checkpoint_hold: [] },
}), { action: "wait", reason: "operator_stage_approval_required" });
assert.deepEqual(directorWatchDecision({
  runStatus: { ...watchStatus, current_stage_state: "blocked" },
  director: { checkpoint_hold: [] },
}), { action: "stop", reason: "blocker_triage_required" });
assert.deepEqual(directorWatchDecision({
  runStatus: watchStatus,
  director: { checkpoint_hold: ["reference_plan_review"] },
}), { action: "wait", reason: "operator_checkpoint_required" });
assert.deepEqual(directorWatchDecision({
  runStatus: watchStatus,
  director: { checkpoint_hold: [] },
  humanCheckpointStages: ["semantic_scene_plan"],
}), { action: "wait", reason: "human_checkpoint_requested" });

const persistedWatchState = {
  schema: DIRECTOR_WATCH_SCHEMA,
  status: "watching",
  episode_dir: "/episode",
  episode: "ep_01",
  current_stage: watchStatus.current_stage,
  state_signature: watchSignature,
  dispatch_key: watchDispatchKey,
  last_actioned_signature: watchSignature,
  last_actioned_dispatch_key: watchDispatchKey,
  execution_events_cursor: emptyExecutionCursor,
  execution_events_cursor_sha256: emptyExecutionCursor.sha256,
  in_flight_advance: null,
  last_progress_at: "2026-08-21T12:00:00.000Z",
};
assert.deepEqual(directorWatchRestartState({
  state: persistedWatchState,
  episodeDir: "/episode",
  episode: "ep_01",
  runStatus: watchStatus,
  checkpoints: { approvals: {} },
  executionEventsCursor: emptyExecutionCursor,
  signature: watchSignature,
}), {
  state_present: true,
  state_valid: true,
  preserve_last_actioned_signature: true,
  last_actioned_signature: watchSignature,
  preserve_last_actioned_dispatch_key: true,
  last_actioned_dispatch_key: watchDispatchKey,
  hold: false,
  hold_reason: null,
  in_flight_advance: null,
  validation: {
    schema_matches: true,
    episode_dir_matches: true,
    episode_matches: true,
    signature_matches: true,
    dispatch_key_matches: true,
    execution_cursor_matches: true,
    stage_matches: true,
  },
});

const crashWindowState = {
  ...persistedWatchState,
  status: "advancing",
  in_flight_advance: {
    active: true,
    phase: "spawn_pending",
    stage: watchStatus.current_stage,
    state_signature: watchSignature,
    execution_events_cursor: emptyExecutionCursor,
    child_pid: null,
  },
};
const crashWindowRestart = directorWatchRestartState({
  state: crashWindowState,
  episodeDir: "/episode",
  episode: "ep_01",
  runStatus: watchStatus,
  checkpoints: { approvals: {} },
  executionEventsCursor: emptyExecutionCursor,
  signature: watchSignature,
});
assert.equal(crashWindowRestart.hold, true);
assert.equal(crashWindowRestart.hold_reason, "restart_inflight_spawn_window_ambiguous");
assert.equal(crashWindowRestart.last_actioned_signature, null);

const stalePidState = {
  ...crashWindowState,
  in_flight_advance: {
    ...crashWindowState.in_flight_advance,
    phase: "running",
    child_pid: 424242,
  },
};
const stalePidRestart = directorWatchRestartState({
  state: stalePidState,
  episodeDir: "/episode",
  episode: "ep_01",
  runStatus: watchStatus,
  checkpoints: { approvals: {} },
  executionEventsCursor: emptyExecutionCursor,
  signature: watchSignature,
  isProcessAlive: () => false,
});
assert.equal(stalePidRestart.hold, true);
assert.equal(stalePidRestart.hold_reason, "restart_inflight_stale_pid_stage_unchanged");
assert.equal(stalePidRestart.child_pid, 424242);

const liveChildRestart = directorWatchRestartState({
  state: stalePidState,
  episodeDir: "/episode",
  episode: "ep_01",
  runStatus: watchStatus,
  checkpoints: { approvals: {} },
  executionEventsCursor: emptyExecutionCursor,
  signature: watchSignature,
  isProcessAlive: (pid) => pid === 424242,
});
assert.equal(liveChildRestart.hold, true);
assert.equal(liveChildRestart.hold_reason, "restart_inflight_child_active");

const openExecutionRestart = directorWatchRestartState({
  state: stalePidState,
  episodeDir: "/episode",
  episode: "ep_01",
  runStatus: watchStatus,
  checkpoints: { approvals: {} },
  executionEventsCursor: openExecutionCursor,
  signature: directorWatchSignature(watchStatus, { approvals: {} }, openExecutionCursor),
  isProcessAlive: () => false,
});
assert.equal(openExecutionRestart.hold, true);
assert.equal(openExecutionRestart.hold_reason, "restart_inflight_execution_open");
assert.deepEqual(openExecutionRestart.open_execution_ids, ["execution-semantic-1"]);
const externalOpenExecutionRestart = directorWatchRestartState({
  state: persistedWatchState,
  episodeDir: "/episode",
  episode: "ep_01",
  runStatus: watchStatus,
  checkpoints: { approvals: {} },
  executionEventsCursor: openExecutionCursor,
  signature: directorWatchSignature(watchStatus, { approvals: {} }, openExecutionCursor),
});
assert.equal(externalOpenExecutionRestart.hold, true);
assert.equal(externalOpenExecutionRestart.hold_reason, "restart_inflight_execution_open");

const advancedWatchStatus = {
  ...watchStatus,
  current_stage: "voice_plan",
  next_command_shape: "node bin/goldflow.mjs voice plan --episode-dir /episode",
  stage_ledger: [
    { stage: "semantic_scene_plan", state: "passed" },
    { stage: "voice_plan", state: "missing" },
  ],
};
const advancedWatchSignature = directorWatchSignature(advancedWatchStatus, { approvals: {} }, completedExecutionCursor);
const completedChildRestart = directorWatchRestartState({
  state: stalePidState,
  episodeDir: "/episode",
  episode: "ep_01",
  runStatus: advancedWatchStatus,
  checkpoints: { approvals: {} },
  executionEventsCursor: completedExecutionCursor,
  signature: advancedWatchSignature,
  isProcessAlive: () => false,
});
assert.equal(completedChildRestart.hold, false);
assert.equal(completedChildRestart.preserve_last_actioned_signature, false);
assert.equal(completedChildRestart.last_actioned_signature, null);

const wrongEpisodeRestart = directorWatchRestartState({
  state: { ...persistedWatchState, episode: "ep_02" },
  episodeDir: "/episode",
  episode: "ep_01",
  runStatus: watchStatus,
  checkpoints: { approvals: {} },
  executionEventsCursor: emptyExecutionCursor,
  signature: watchSignature,
});
assert.equal(wrongEpisodeRestart.hold, true);
assert.equal(wrongEpisodeRestart.hold_reason, "restart_state_binding_unverifiable");
const legacyUnverifiableRestart = directorWatchRestartState({
  state: { ...persistedWatchState, schema: "goldflow_agent_director_watch_v1", episode: undefined },
  episodeDir: "/episode",
  episode: "ep_01",
  runStatus: watchStatus,
  checkpoints: { approvals: {} },
  executionEventsCursor: emptyExecutionCursor,
  signature: watchSignature,
});
assert.equal(legacyUnverifiableRestart.hold, true);
assert.equal(legacyUnverifiableRestart.hold_reason, "restart_state_binding_unverifiable");
const unreadableRestart = directorWatchRestartState({
  stateReadError: new Error("Unexpected token at byte 17"),
  episodeDir: "/episode",
  episode: "ep_01",
  runStatus: watchStatus,
  checkpoints: { approvals: {} },
  executionEventsCursor: emptyExecutionCursor,
  signature: watchSignature,
});
assert.equal(unreadableRestart.hold, true);
assert.equal(unreadableRestart.hold_reason, "restart_state_unreadable");
assert.equal(unreadableRestart.validation_error, "Unexpected token at byte 17");

const motion = generatedMotionIdentityContract({
  animation_policy: "selective_generated_video",
  generated_motion_provider: "google_flow",
  generated_motion_required_through_sec: 180,
});
assert.equal(motion.provider, GENERATED_MOTION_PROVIDER_FLOW);
assert.equal(motion.automatic_generation_retries, 0);
assert.equal(motion.required_through_sec, 180);
assert.deepEqual(requiredGeneratedMotionCoverageFindings({
  required_image_ids: ["cut_001", "cut_002"],
  clips: [{ image_id: "cut_001" }],
}), [{ code: "required_generated_motion_missing", image_id: "cut_002" }]);
assert.deepEqual(requiredGeneratedMotionCoverageFindings({
  required_image_ids: ["cut_001"],
  clips: [{ image_id: "cut_001" }],
}, {
  decisions: [{ image_id: "cut_001", decision: "rejected" }],
}), [{ code: "required_generated_motion_not_accepted", image_id: "cut_001" }]);

const room = planningRoomContract({ planning_provider: PLANNING_ROOM_PROVIDER });
assert.equal(room.deterministic_local_reconciliation_provider, "codex_cli");
assert.deepEqual(room.stage_routes.structured_planning, ["codex_cli"]);
assert.deepEqual(room.stage_routes.global_reasoning, ["codex_cli"]);
assert.deepEqual(room.stage_routes.premium_creative, ["chatgpt_web", "codex_cli"]);

const federatedIdentity = {
  schema: "goldflow_run_identity_v2",
  channel: "planner-pool-fixture",
  series_slug: "scope-isolation",
  week: "2026-W34-a",
  episode: "ep_01",
  planning_provider: PLANNING_ROOM_PROVIDER,
  production_profile_config: {
    planner: {
      federated_structured_pool: true,
      codex_cli_structured_concurrency: 12,
      codex_cli_structured_initial_concurrency: 8,
      codex_cli_structured_ramp_successes_per_step: 4,
      codex_cli_structured_ramp_step: 2,
      antigravity_cli_structured_concurrency: 0,
    },
  },
};
federatedIdentity.planning_room = planningRoomContract(federatedIdentity);
assert.equal(federatedIdentity.planning_room.schema, FEDERATED_PLANNING_ROOM_SCHEMA);
assert.equal(effectivePlannerConcurrencyForTests({
  concurrency: 12,
  initial_concurrency: 8,
  ramp_successes_per_step: 4,
  ramp_step: 2,
}, { successful_completions: 0 }), 8);
assert.equal(effectivePlannerConcurrencyForTests({
  concurrency: 12,
  initial_concurrency: 8,
  ramp_successes_per_step: 4,
  ramp_step: 2,
}, { successful_completions: 4 }), 10);
assert.equal(effectivePlannerConcurrencyForTests({
  concurrency: 12,
  initial_concurrency: 8,
  ramp_successes_per_step: 4,
  ramp_step: 2,
}, { successful_completions: 8 }), 12);
const plannerSlots = await Promise.all(Array.from({ length: 8 }, (_, index) => acquireFederatedPlannerSlot({
  identity: federatedIdentity,
  stageName: `ep_01_semantic_scene_plan_chunk_${String(index + 1).padStart(3, "0")}`,
  env: {
    ...process.env,
    ANIFACTORY_CODEX_CLI_PATH: process.execPath,
    ANIFACTORY_ANTIGRAVITY_CLI_PATH: process.execPath,
  },
})));
assert.deepEqual(
  plannerSlots.reduce((counts, slot) => ({ ...counts, [slot.provider]: (counts[slot.provider] ?? 0) + 1 }), {}),
  { codex_cli: 8 },
);
assert.ok(plannerSlots.every((slot) => slot.planner_stage_key === "semantic_scene_plan"));
assert.equal(new Set(plannerSlots.map((slot) => slot.pool_scope_key)).size, 1);
assert.deepEqual(federatedPlannerPoolSnapshotForTests().active, { codex_cli: 8 });
for (const slot of plannerSlots.slice(0, 4)) {
  slot.recordSuccess();
  slot.release();
}
const rampedSlots = await Promise.all(Array.from({ length: 6 }, (_, index) => acquireFederatedPlannerSlot({
  identity: federatedIdentity,
  stageName: `ep_01_semantic_scene_plan_chunk_${String(index + 9).padStart(3, "0")}`,
  env: {
    ...process.env,
    ANIFACTORY_CODEX_CLI_PATH: process.execPath,
    ANIFACTORY_ANTIGRAVITY_CLI_PATH: process.execPath,
  },
})));
assert.equal(federatedPlannerPoolSnapshotForTests().active.codex_cli, 10);
for (const slot of plannerSlots.slice(4)) {
  slot.recordSuccess();
  slot.release();
}
for (const slot of rampedSlots) slot.release();
const semanticScopeKey = plannerSlots[0].pool_scope_key;
assert.equal(federatedPlannerPoolSnapshotForTests().health[semanticScopeKey].successful_completions, 8);

const beatSlots = await Promise.all(Array.from({ length: 8 }, (_, index) => acquireFederatedPlannerSlot({
  identity: federatedIdentity,
  stageName: `ep_01_editorial_beats_${String(index + 1).padStart(3, "0")}_attempt_1`,
  env: {
    ...process.env,
    ANIFACTORY_CODEX_CLI_PATH: process.execPath,
    ANIFACTORY_ANTIGRAVITY_CLI_PATH: process.execPath,
  },
})));
assert.ok(beatSlots.every((slot) => slot.planner_stage_key === "visual_beat_plan"));
assert.equal(new Set(beatSlots.map((slot) => slot.pool_scope_key)).size, 1);
assert.notEqual(beatSlots[0].pool_scope_key, semanticScopeKey);
assert.equal(federatedPlannerPoolSnapshotForTests().health[beatSlots[0].pool_scope_key], undefined);
let ninthBeatSlot = null;
const ninthBeatPromise = acquireFederatedPlannerSlot({
  identity: federatedIdentity,
  stageName: "ep_01_editorial_beats_009_attempt_1",
  env: {
    ...process.env,
    ANIFACTORY_CODEX_CLI_PATH: process.execPath,
    ANIFACTORY_ANTIGRAVITY_CLI_PATH: process.execPath,
  },
}).then((slot) => {
  ninthBeatSlot = slot;
  return slot;
});
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(ninthBeatSlot, null, "semantic successes must not raise the visual-beat initial ceiling");
beatSlots[0].release();
await ninthBeatPromise;
assert.ok(ninthBeatSlot);
ninthBeatSlot.release();
for (const slot of beatSlots.slice(1)) slot.release();
resetFederatedPlannerPoolForTests();

// Real CLI failures may include echoed creative/schema text before ERROR lines.
// Exercise circuit decisions, not only the classifier's regular expression.
async function recordFixturePlannerFailure(message) {
  const slot = await acquireFederatedPlannerSlot({
    identity: federatedIdentity,
    stageName: "ep_01_visual_plan_chunk_023",
    env: { ...process.env, ANIFACTORY_CODEX_CLI_PATH: process.execPath },
  });
  slot.recordFailure(new Error(message));
  slot.release();
  return federatedPlannerPoolSnapshotForTests().health[slot.pool_scope_key];
}
const retainedCapacityError = `Codex ep_01_visual_plan_chunk_023 exited 1: ,
    "ui_elements": [],
    "forbidden_ref_ids": [],
    "reference_slots": []
Return that object as one minified JSON line. Do not use markdown fences or commentary.
2026-09-22T06:02:48.812274Z WARN codex_skills::interface: ignoring interface.icon_small
ERROR: Selected model is at capacity. Please try a different model.
ERROR: Selected model is at capacity. Please try a different model.
[truncated from 42357 chars]`;
for (const message of [
  retainedCapacityError,
  "Selected model is at capacity. Please try a different model.",
  'Codex fixture exited 1: {"forbidden_ref_ids":[],"oauth_panel":false}',
  'Codex fixture exited 1: Story: forbidden chamber; authentication required is a sign; OAuth is a prop label.\nERROR: Selected model is at capacity. Please try a different model.',
]) {
  resetFederatedPlannerPoolForTests();
  const health = await recordFixturePlannerFailure(message);
  assert.equal(health.open, false, "prompt echo must not promote a transient failure to fatal auth");
  assert.equal(health.consecutive_failures, 1, "duplicate diagnostic lines are one failed call");
}
for (const message of [
  "Authentication required. Authentication timed out.",
  "eligibility check failed",
  "OAuth token expired",
  "Unauthorized",
  "HTTP 403 Forbidden",
  "credentials invalid",
  'Codex fixture exited 1: {"forbidden_ref_ids":[]}\nERROR: authentication required',
  'Prompt says: Selected model is at capacity.\nERROR: Unauthorized',
  "ERROR: Selected model is at capacity.\nFATAL: credentials missing",
]) {
  resetFederatedPlannerPoolForTests();
  assert.equal((await recordFixturePlannerFailure(message)).open, true, "real auth/permission errors remain immediately fatal");
}
resetFederatedPlannerPoolForTests();
for (let failure = 1; failure <= 3; failure += 1) {
  const health = await recordFixturePlannerFailure(retainedCapacityError);
  assert.equal(health.open, failure === 3, "three consecutive transient calls still open the circuit");
  assert.equal(health.consecutive_failures, failure);
}
await Promise.race([
  assert.rejects(acquireFederatedPlannerSlot({
    identity: federatedIdentity,
    stageName: "ep_01_visual_plan_chunk_024",
    env: { ...process.env, ANIFACTORY_CODEX_CLI_PATH: process.execPath },
  }), /All federated planner providers opened their circuit/),
  new Promise((_, reject) => setImmediate(() => reject(new Error("An already-open circuit left an orphaned planner waiter.")))),
]);
assert.equal(federatedPlannerPoolSnapshotForTests().waiting, 0);
resetFederatedPlannerPoolForTests();

const legacyFederatedIdentity = {
  schema: "goldflow_run_identity_v2",
  channel: "planner-pool-fixture",
  series_slug: "circuit-isolation",
  week: "2026-W34-a",
  episode: "ep_01",
  planning_provider: PLANNING_ROOM_PROVIDER,
  production_profile_config: {
    planner: {
      federated_structured_pool: true,
      codex_cli_structured_concurrency: 8,
      antigravity_cli_structured_concurrency: 3,
    },
  },
  planning_room: {
    schema: FEDERATED_PLANNING_ROOM_SCHEMA,
    stage_routes: { structured_planning: ["codex_cli", "antigravity_cli"] },
  },
};
legacyFederatedIdentity.planning_room = planningRoomContract(legacyFederatedIdentity);
const circuitProbeSlots = await Promise.all(Array.from({ length: 11 }, (_, index) => acquireFederatedPlannerSlot({
  identity: legacyFederatedIdentity,
  stageName: `ep_01_semantic_scene_plan_chunk_${String(index + 1).padStart(3, "0")}`,
  env: {
    ...process.env,
    ANIFACTORY_CODEX_CLI_PATH: process.execPath,
    ANIFACTORY_ANTIGRAVITY_CLI_PATH: process.execPath,
  },
})));
const failedAntigravitySlot = circuitProbeSlots.find((slot) => slot.provider === "antigravity_cli");
assert.ok(failedAntigravitySlot);
failedAntigravitySlot.recordFailure(new Error("Authentication required. Authentication timed out."));
for (const slot of circuitProbeSlots) slot.release();
assert.equal(federatedPlannerPoolSnapshotForTests().health[failedAntigravitySlot.pool_scope_key].open, true);
const postCircuitSlots = await Promise.all(Array.from({ length: 8 }, () => acquireFederatedPlannerSlot({
  identity: legacyFederatedIdentity,
  stageName: "ep_01_semantic_scene_plan_chunk_012",
  env: {
    ...process.env,
    ANIFACTORY_CODEX_CLI_PATH: process.execPath,
    ANIFACTORY_ANTIGRAVITY_CLI_PATH: process.execPath,
  },
})));
assert.ok(postCircuitSlots.every((slot) => slot.provider === "codex_cli"));
for (const slot of postCircuitSlots) slot.release();

const crossStageSlots = await Promise.all(Array.from({ length: 11 }, (_, index) => acquireFederatedPlannerSlot({
  identity: legacyFederatedIdentity,
  stageName: `ep_01_visual_reference_plan_chunk_${String(index + 1).padStart(2, "0")}`,
  env: {
    ...process.env,
    ANIFACTORY_CODEX_CLI_PATH: process.execPath,
    ANIFACTORY_ANTIGRAVITY_CLI_PATH: process.execPath,
  },
})));
assert.ok(crossStageSlots.some((slot) => slot.provider === "antigravity_cli"), "semantic circuit must not leak into reference planning");
assert.ok(crossStageSlots.every((slot) => slot.planner_stage_key === "visual_reference_plan"));
for (const slot of crossStageSlots) slot.release();

const secondRunIdentity = structuredClone(legacyFederatedIdentity);
secondRunIdentity.week = "2026-W34-b";
const crossIdentitySlots = await Promise.all(Array.from({ length: 11 }, (_, index) => acquireFederatedPlannerSlot({
  identity: secondRunIdentity,
  stageName: `ep_01_semantic_scene_plan_chunk_${String(index + 1).padStart(3, "0")}`,
  env: {
    ...process.env,
    ANIFACTORY_CODEX_CLI_PATH: process.execPath,
    ANIFACTORY_ANTIGRAVITY_CLI_PATH: process.execPath,
  },
})));
assert.ok(crossIdentitySlots.some((slot) => slot.provider === "antigravity_cli"), "semantic circuit must not leak into another run identity");
assert.notEqual(crossIdentitySlots[0].run_identity_key, circuitProbeSlots[0].run_identity_key);
for (const slot of crossIdentitySlots) slot.release();
resetFederatedPlannerPoolForTests();

console.log("production direction contract tests passed");
