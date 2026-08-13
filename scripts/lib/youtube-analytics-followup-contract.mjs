import { createHash } from "node:crypto";

export const YOUTUBE_ANALYTICS_FOLLOWUP_PLAN_SCHEMA = "goldflow_youtube_analytics_followup_plan_v1";
export const YOUTUBE_ANALYTICS_SNAPSHOT_SCHEMA = "goldflow_youtube_analytics_snapshot_v1";
export const YOUTUBE_ANALYTICS_AGGREGATE_SCHEMA = "goldflow_youtube_analytics_feedback_aggregate_v1";
export const YOUTUBE_ANALYTICS_WINDOWS = Object.freeze([
  { id: "24h", offset_hours: 24 },
  { id: "72h", offset_hours: 72 },
  { id: "7d", offset_hours: 168 },
]);

function clean(value) {
  return String(value ?? "").trim();
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentage(value) {
  const number = finite(value);
  return number != null && number >= 0 && number <= 100;
}

export function buildYoutubeAnalyticsFollowupPlan({
  episode,
  uploadReceiptPath,
  uploadReceiptSha256,
  uploadReceipt,
  anchorAt = null,
  createdAt = new Date().toISOString(),
} = {}) {
  const visibility = clean(uploadReceipt?.visibility);
  const inferredAnchor = anchorAt
    ?? (visibility === "scheduled" ? uploadReceipt?.schedule_at : null)
    ?? (["public", "unlisted"].includes(visibility) ? uploadReceipt?.recorded_at : null);
  const anchorDate = inferredAnchor ? new Date(inferredAnchor) : null;
  const validAnchor = anchorDate && !Number.isNaN(anchorDate.getTime());
  return {
    schema: YOUTUBE_ANALYTICS_FOLLOWUP_PLAN_SCHEMA,
    status: validAnchor ? "scheduled" : "awaiting_release_anchor",
    episode,
    video_id: clean(uploadReceipt?.video_id) || null,
    upload_receipt_path: uploadReceiptPath,
    upload_receipt_sha256: uploadReceiptSha256,
    analytics_anchor_at: validAnchor ? anchorDate.toISOString() : null,
    checkpoints: YOUTUBE_ANALYTICS_WINDOWS.map((window) => ({
      id: window.id,
      offset_hours: window.offset_hours,
      due_at: validAnchor
        ? new Date(anchorDate.getTime() + window.offset_hours * 60 * 60 * 1000).toISOString()
        : null,
      snapshot_path: null,
      snapshot_sha256: null,
      state: validAnchor ? "pending" : "awaiting_release_anchor",
    })),
    required_metrics: [
      "impressions",
      "browse_ctr_percent",
      "suggested_ctr_percent",
      "first_30_sec_retention_percent",
      "first_60_sec_retention_percent",
      "average_view_duration_sec",
      "average_percentage_viewed",
      "traffic_sources",
      "new_viewers_percent",
      "returning_viewers_percent",
      "native_ab_watch_time",
    ],
    non_blocking: true,
    policy: "Analytics follow-ups inform premise, opening, visual, and packaging direction but never block the next production or auto-change policy from one upload.",
    created_at: createdAt,
  };
}

export function validateYoutubeAnalyticsMetrics(metrics = {}) {
  const blockers = [];
  if (!(finite(metrics.impressions) >= 0)) blockers.push("analytics_impressions_invalid");
  for (const key of [
    "browse_ctr_percent",
    "suggested_ctr_percent",
    "first_30_sec_retention_percent",
    "first_60_sec_retention_percent",
    "average_percentage_viewed",
    "new_viewers_percent",
    "returning_viewers_percent",
  ]) {
    if (!percentage(metrics[key])) blockers.push(`analytics_${key}_invalid`);
  }
  if (!(finite(metrics.average_view_duration_sec) >= 0)) blockers.push("analytics_average_view_duration_sec_invalid");
  if (!metrics.traffic_sources || typeof metrics.traffic_sources !== "object" || Array.isArray(metrics.traffic_sources)) {
    blockers.push("analytics_traffic_sources_invalid");
  }
  if (!metrics.native_ab_watch_time || typeof metrics.native_ab_watch_time !== "object" || Array.isArray(metrics.native_ab_watch_time)) {
    blockers.push("analytics_native_ab_watch_time_invalid");
  }
  const audienceTotal = finite(metrics.new_viewers_percent) + finite(metrics.returning_viewers_percent);
  if (!Number.isFinite(audienceTotal) || Math.abs(audienceTotal - 100) > 2) blockers.push("analytics_new_returning_total_invalid");
  return { status: blockers.length ? "blocked" : "passed", blockers: [...new Set(blockers)] };
}

export function validateYoutubeAnalyticsSnapshot(snapshot, options = {}) {
  const blockers = [];
  const plan = options.plan ?? null;
  if (snapshot?.schema !== YOUTUBE_ANALYTICS_SNAPSHOT_SCHEMA) blockers.push("analytics_snapshot_schema_invalid");
  if (clean(snapshot?.status) !== "passed") blockers.push("analytics_snapshot_not_passed");
  if (!plan || clean(snapshot?.followup_plan_sha256) !== clean(options.planSha256)) blockers.push("analytics_snapshot_plan_hash_stale");
  if (clean(snapshot?.upload_receipt_sha256) !== clean(plan?.upload_receipt_sha256)) blockers.push("analytics_snapshot_upload_hash_stale");
  if (clean(snapshot?.video_id) !== clean(plan?.video_id)) blockers.push("analytics_snapshot_video_id_mismatch");
  if (!YOUTUBE_ANALYTICS_WINDOWS.some((window) => window.id === clean(snapshot?.window))) blockers.push("analytics_snapshot_window_invalid");
  const checkpoint = plan?.checkpoints?.find((row) => row.id === clean(snapshot?.window));
  if (!checkpoint) blockers.push("analytics_snapshot_checkpoint_missing");
  const capturedAt = new Date(snapshot?.captured_at);
  if (Number.isNaN(capturedAt.getTime())) blockers.push("analytics_snapshot_capture_time_invalid");
  if (!clean(snapshot?.captured_by)) blockers.push("analytics_snapshot_captured_by_missing");
  blockers.push(...validateYoutubeAnalyticsMetrics(snapshot?.metrics).blockers);
  return { status: blockers.length ? "blocked" : "passed", blockers: [...new Set(blockers)] };
}

export function analyticsDirectorFeedback(metrics = {}) {
  return {
    packaging: {
      browse_ctr_percent: finite(metrics.browse_ctr_percent),
      suggested_ctr_percent: finite(metrics.suggested_ctr_percent),
      evidence_use: "Compare title-thumbnail promise strength by traffic surface and native A/B watch time.",
    },
    opening: {
      first_30_sec_retention_percent: finite(metrics.first_30_sec_retention_percent),
      first_60_sec_retention_percent: finite(metrics.first_60_sec_retention_percent),
      evidence_use: "Audit promise payment, narration start, opening motion, and early visual changes.",
    },
    story: {
      average_view_duration_sec: finite(metrics.average_view_duration_sec),
      average_percentage_viewed: finite(metrics.average_percentage_viewed),
      evidence_use: "Compare premise depth, progression density, and runtime fit across repeated uploads.",
    },
    audience: {
      traffic_sources: metrics.traffic_sources ?? {},
      new_viewers_percent: finite(metrics.new_viewers_percent),
      returning_viewers_percent: finite(metrics.returning_viewers_percent),
      evidence_use: "Separate acquisition packaging from returning-viewer satisfaction before changing channel direction.",
    },
  };
}

export function analyticsSnapshotContentSha256(snapshot) {
  return sha256(JSON.stringify({
    video_id: snapshot?.video_id,
    window: snapshot?.window,
    captured_at: snapshot?.captured_at,
    metrics: snapshot?.metrics,
  }));
}
