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
  buildYoutubeAnalyticsFollowupPlan,
  validateYoutubeAnalyticsSnapshot,
} from "../lib/youtube-analytics-followup-contract.mjs";
import {
  AGENT_DIRECTOR_PHASES,
  agentDirectorStatus,
} from "../lib/agent-director-contract.mjs";
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
assert.deepEqual(proofHeldDirector.checkpoint_hold, ["opening_audiovisual_proof"]);
const proofApprovedDirector = agentDirectorStatus({
  current_stage: "animation_direction_plan",
  current_stage_state: "missing",
  stage_ledger: motionStageLedger,
}, { approvals: { opening_audiovisual_proof: { approved: true } } });
assert.deepEqual(proofApprovedDirector.checkpoint_hold, []);

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
assert.ok(room.stage_routes.structured_planning.includes("antigravity_cli"));
assert.equal(room.stage_routes.structured_planning[0], "codex_cli");

const federatedIdentity = {
  planning_provider: PLANNING_ROOM_PROVIDER,
  production_profile_config: {
    planner: {
      federated_structured_pool: true,
      codex_cli_structured_concurrency: 8,
      antigravity_cli_structured_concurrency: 3,
    },
  },
};
federatedIdentity.planning_room = planningRoomContract(federatedIdentity);
assert.equal(federatedIdentity.planning_room.schema, FEDERATED_PLANNING_ROOM_SCHEMA);
const plannerSlots = await Promise.all(Array.from({ length: 11 }, () => acquireFederatedPlannerSlot({
  identity: federatedIdentity,
  stageName: "ep_01_visual_prompt_chunk",
  env: {
    ...process.env,
    ANIFACTORY_CODEX_CLI_PATH: process.execPath,
    ANIFACTORY_ANTIGRAVITY_CLI_PATH: process.execPath,
  },
})));
assert.deepEqual(
  plannerSlots.reduce((counts, slot) => ({ ...counts, [slot.provider]: (counts[slot.provider] ?? 0) + 1 }), {}),
  { codex_cli: 8, antigravity_cli: 3 },
);
assert.deepEqual(federatedPlannerPoolSnapshotForTests().active, { codex_cli: 8, antigravity_cli: 3 });
for (const slot of plannerSlots) slot.release();
resetFederatedPlannerPoolForTests();

console.log("production direction contract tests passed");
