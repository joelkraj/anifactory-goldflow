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

function experimentCliffControl(plan) {
  const experiment = plan?.channel_experiment ?? null;
  const control = experiment?.within_video_ad_cliff_control ?? null;
  return control?.enabled === true ? { experiment, control } : null;
}

function retentionCurve(metrics = {}) {
  const raw = metrics?.audience_retention;
  if (Array.isArray(raw)) return { status: "available", points: raw, source: null };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return {
      status: clean(raw.status).toLowerCase() || (Array.isArray(raw.points) ? "available" : "unavailable"),
      points: Array.isArray(raw.points) ? raw.points : [],
      source: clean(raw.source) || null,
      reason: clean(raw.reason) || null,
    };
  }
  return null;
}

function normalizeRetentionPoints(metrics = {}) {
  const curve = retentionCurve(metrics);
  if (!curve || curve.status !== "available") return [];
  const points = curve.points.map((row) => {
    const ratio = finite(row?.elapsedVideoTimeRatio ?? row?.elapsed_video_time_ratio);
    const watchRatio = finite(row?.audienceWatchRatio ?? row?.audience_watch_ratio);
    return ratio != null && watchRatio != null ? { ratio, retention_percent: watchRatio * 100 } : null;
  }).filter(Boolean).filter((row) => row.ratio >= 0 && row.ratio <= 1 && row.retention_percent >= 0);
  points.sort((left, right) => left.ratio - right.ratio);
  return points.filter((row, index) => index === 0 || row.ratio !== points[index - 1].ratio);
}

function interpolateRetention(points, ratio) {
  if (!points.length || ratio < points[0].ratio || ratio > points.at(-1).ratio) return null;
  const exact = points.find((row) => row.ratio === ratio);
  if (exact) return exact.retention_percent;
  let rightIndex = points.findIndex((row) => row.ratio > ratio);
  if (rightIndex < 1) return null;
  const left = points[rightIndex - 1];
  const right = points[rightIndex];
  const distance = right.ratio - left.ratio;
  if (!(distance > 0)) return null;
  const progress = (ratio - left.ratio) / distance;
  return left.retention_percent + ((right.retention_percent - left.retention_percent) * progress);
}

function rounded(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

export function buildMidrollRetentionCliffAnalysis({ metrics = {}, plan = null } = {}) {
  const contract = experimentCliffControl(plan);
  if (!contract) return null;
  const curve = retentionCurve(metrics);
  const base = {
    schema: "goldflow_midroll_retention_cliff_analysis_v1",
    experiment_id: clean(contract.experiment.experiment_id),
    curve_metric: clean(contract.control.curve_metric) || "audience_retention",
    curve_x_dimension: clean(contract.control.curve_x_dimension) || "elapsedVideoTimeRatio",
    curve_y_metric: clean(contract.control.curve_y_metric) || "audienceWatchRatio",
  };
  if (!curve || curve.status !== "available") {
    return {
      ...base,
      status: "unavailable",
      reason: clean(curve?.reason) || "YouTube audience-retention curve was not available at this checkpoint.",
      insertions: [],
    };
  }
  const points = normalizeRetentionPoints(metrics);
  const durationSec = finite(contract.experiment.final_duration_sec);
  const positions = Array.isArray(contract.experiment.manual_mid_roll_positions_sec)
    ? contract.experiment.manual_mid_roll_positions_sec.map(finite).filter((value) => value != null)
    : [];
  const offsets = Array.isArray(contract.control.sample_offsets_seconds)
    ? contract.control.sample_offsets_seconds.map(finite).filter((value) => value != null)
    : [-135, -45, 0, 45, 135];
  if (!(durationSec > 0) || positions.length !== 3 || points.length < 5 || offsets.length !== 5) {
    return {
      ...base,
      status: "blocked",
      reason: "A usable duration, three exact ad positions, five sample offsets, and at least five retention points are required.",
      curve_point_count: points.length,
      insertions: [],
    };
  }
  const insertions = positions.map((positionSec, index) => {
    const samples = offsets.map((offsetSec) => {
      const elapsedVideoTimeRatio = (positionSec + offsetSec) / durationSec;
      return {
        offset_sec: offsetSec,
        elapsedVideoTimeRatio: rounded(elapsedVideoTimeRatio),
        retention_percent: rounded(interpolateRetention(points, elapsedVideoTimeRatio)),
      };
    });
    const values = samples.map((row) => row.retention_percent);
    const complete = values.every((value) => value != null);
    if (!complete) {
      return {
        ordinal: index + 1,
        position_sec: positionSec,
        elapsedVideoTimeRatio: rounded(positionSec / durationSec),
        status: "unavailable",
        samples,
        reason: "The retention curve did not cover every required adjacent sample.",
      };
    }
    const [farBefore, before, atBreak, after, farAfter] = values;
    const insertionCenteredDrop = before - after;
    const leftAdjacentDrop = farBefore - before;
    const rightAdjacentDrop = after - farAfter;
    const adjacentBaselineDrop = (leftAdjacentDrop + rightAdjacentDrop) / 2;
    return {
      ordinal: index + 1,
      position_sec: positionSec,
      elapsedVideoTimeRatio: rounded(positionSec / durationSec),
      status: "measured",
      samples,
      retention_at_break_percent: atBreak,
      insertion_centered_drop_percentage_points: rounded(insertionCenteredDrop),
      left_adjacent_drop_percentage_points: rounded(leftAdjacentDrop),
      right_adjacent_drop_percentage_points: rounded(rightAdjacentDrop),
      adjacent_baseline_drop_percentage_points: rounded(adjacentBaselineDrop),
      excess_local_drop_percentage_points: rounded(insertionCenteredDrop - adjacentBaselineDrop),
    };
  });
  return {
    ...base,
    status: insertions.every((row) => row.status === "measured") ? "available" : "partial",
    final_duration_sec: durationSec,
    curve_point_count: points.length,
    sample_offsets_seconds: offsets,
    calculation: "Centered 90-second drop minus the mean of equal-width adjacent 90-second drops.",
    interpretation: "Ad-aligned excess drop is a possible interruption signal, not proof of whole-video causality or individual ad exposure.",
    insertions,
  };
}

export function buildYoutubeAnalyticsFollowupPlan({
  episode,
  uploadReceiptPath,
  uploadReceiptSha256,
  uploadReceipt,
  publishManifest = null,
  anchorAt = null,
  createdAt = new Date().toISOString(),
} = {}) {
  const visibility = clean(uploadReceipt?.visibility);
  const inferredAnchor = anchorAt
    ?? (visibility === "scheduled" ? uploadReceipt?.schedule_at : null)
    ?? (["public", "unlisted"].includes(visibility) ? uploadReceipt?.recorded_at : null);
  const anchorDate = inferredAnchor ? new Date(inferredAnchor) : null;
  const validAnchor = anchorDate && !Number.isNaN(anchorDate.getTime());
  const manifestExperiment = publishManifest?.channel_experiment ?? null;
  const receiptExperiment = uploadReceipt?.channel_experiment ?? null;
  const channelExperiment = manifestExperiment && receiptExperiment
    && clean(manifestExperiment.experiment_id) === clean(receiptExperiment.experiment_id)
    ? {
        experiment_id: clean(manifestExperiment.experiment_id),
        config_sha256: clean(manifestExperiment.config_sha256),
        ordinal: Number(manifestExperiment.ordinal),
        eligible_upload_count: Number(manifestExperiment.eligible_upload_count),
        final_duration_sec: finite(manifestExperiment.final_duration_sec),
        manual_mid_roll_positions_sec: Array.isArray(publishManifest?.publish_settings?.manual_mid_roll_positions_sec)
          ? publishManifest.publish_settings.manual_mid_roll_positions_sec.map(Number)
          : [],
        within_video_ad_cliff_control: manifestExperiment?.measurement?.within_video_ad_cliff_control ?? null,
      }
    : null;
  const requiredMetrics = [
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
  ];
  if (channelExperiment?.within_video_ad_cliff_control?.enabled === true) requiredMetrics.push("audience_retention");
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
    channel_experiment: channelExperiment,
    required_metrics: requiredMetrics,
    non_blocking: true,
    policy: "Analytics follow-ups inform premise, opening, visual, and packaging direction but never block the next production or auto-change policy from one upload.",
    created_at: createdAt,
  };
}

export function validateYoutubeAnalyticsMetrics(metrics = {}, options = {}) {
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
  if (options.requireAudienceRetentionCurve === true) {
    const curve = retentionCurve(metrics);
    if (!curve || !["available", "unavailable"].includes(curve.status)) {
      blockers.push("analytics_audience_retention_capture_missing");
    } else if (curve.status === "unavailable" && !clean(curve.reason)) {
      blockers.push("analytics_audience_retention_unavailable_reason_missing");
    } else if (curve.status === "available" && normalizeRetentionPoints(metrics).length < 5) {
      blockers.push("analytics_audience_retention_points_invalid");
    }
  }
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
  const cliffControl = experimentCliffControl(plan);
  blockers.push(...validateYoutubeAnalyticsMetrics(snapshot?.metrics, {
    requireAudienceRetentionCurve: Boolean(cliffControl),
  }).blockers);
  if (cliffControl) {
    const expectedAnalysis = buildMidrollRetentionCliffAnalysis({ metrics: snapshot?.metrics, plan });
    if (!snapshot?.midroll_retention_cliff_analysis) {
      blockers.push("analytics_midroll_retention_cliff_analysis_missing");
    } else if (JSON.stringify(snapshot.midroll_retention_cliff_analysis) !== JSON.stringify(expectedAnalysis)) {
      blockers.push("analytics_midroll_retention_cliff_analysis_mismatch");
    }
  }
  return { status: blockers.length ? "blocked" : "passed", blockers: [...new Set(blockers)] };
}

export function analyticsDirectorFeedback(metrics = {}, options = {}) {
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
    ad_friction: {
      midroll_retention_cliff_analysis: options.midrollRetentionCliffAnalysis ?? null,
      evidence_use: "Compare local insertion-centered retention drops with adjacent segments; do not infer ad causality from whole-video APV alone.",
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
