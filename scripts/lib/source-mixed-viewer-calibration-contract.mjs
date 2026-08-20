import { createHash } from "node:crypto";

export const MIXED_VIEWER_CALIBRATION_POLICY_SCHEMA =
  "goldflow_mixed_viewer_calibration_policy_v1";
export const MIXED_VIEWER_CALIBRATION_APPROVAL_SCHEMA =
  "goldflow_mixed_viewer_calibration_promotion_approval_v1";

export const DEFAULT_MIXED_VIEWER_CALIBRATION_THRESHOLDS = Object.freeze({
  minimum_distinct_episodes: 3,
  minimum_package_prediction_samples: 3,
  minimum_package_prediction_hit_rate: 0.6,
  maximum_mean_absolute_error: Object.freeze({
    leave_point_sec: 45,
    first_30_sec_retention_percent: 10,
    first_60_sec_retention_percent: 12,
    average_percentage_viewed: 10,
    average_view_duration_sec: 180,
  }),
  minimum_provider_family_samples: 3,
});

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function hashWithout(value, field) {
  const copy = structuredClone(value ?? {});
  delete copy[field];
  return sha256(JSON.stringify(copy));
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function clean(value) {
  return String(value ?? "").trim();
}

function thresholdsSha256(thresholds) {
  return sha256(JSON.stringify(thresholds));
}

export function mixedViewerCalibrationApprovalSha256(document) {
  return hashWithout(document, "approval_sha256");
}

export function mixedViewerCalibrationPolicySha256(document) {
  return hashWithout(document, "policy_sha256");
}

export function validateMixedViewerCalibrationApproval(document, {
  learningLedgerSha256 = null,
  thresholdPolicySha256 = null,
} = {}) {
  const blockers = [];
  if (document?.schema !== MIXED_VIEWER_CALIBRATION_APPROVAL_SCHEMA) blockers.push("mixed_viewer_calibration_approval_schema_invalid");
  if (document?.status !== "approved") blockers.push("mixed_viewer_calibration_approval_status_invalid");
  if (document?.production_mode !== "calibrated_decision_support") blockers.push("mixed_viewer_calibration_approval_mode_invalid");
  if (!clean(document?.approved_by)) blockers.push("mixed_viewer_calibration_approval_reviewer_missing");
  if (!clean(document?.approved_at)) blockers.push("mixed_viewer_calibration_approval_timestamp_missing");
  if (!/^[a-f0-9]{64}$/iu.test(clean(document?.learning_ledger_sha256))) blockers.push("mixed_viewer_calibration_approval_learning_hash_invalid");
  if (!/^[a-f0-9]{64}$/iu.test(clean(document?.threshold_policy_sha256))) blockers.push("mixed_viewer_calibration_approval_threshold_hash_invalid");
  if (learningLedgerSha256 && document?.learning_ledger_sha256 !== learningLedgerSha256) blockers.push("mixed_viewer_calibration_approval_learning_hash_mismatch");
  if (thresholdPolicySha256 && document?.threshold_policy_sha256 !== thresholdPolicySha256) blockers.push("mixed_viewer_calibration_approval_threshold_hash_mismatch");
  if (document?.approval_sha256 !== mixedViewerCalibrationApprovalSha256(document)) blockers.push("mixed_viewer_calibration_approval_hash_invalid");
  return { done: blockers.length === 0, blockers };
}

export function buildMixedViewerCalibrationPolicy({
  learningLedger = null,
  learningLedgerSha256 = null,
  approval = null,
  thresholds = DEFAULT_MIXED_VIEWER_CALIBRATION_THRESHOLDS,
  createdAt = new Date().toISOString(),
} = {}) {
  const summary = learningLedger?.mixed_viewer_shadow_calibration ?? {};
  const episodeCount = Number(summary.episode_count ?? 0);
  const packageSamples = Number(summary.package_prediction_sample_count ?? 0);
  const packageHitRate = Number(summary.package_prediction_hit_rate);
  const metricRows = summary.aggregate_absolute_error ?? {};
  const providerRows = summary.provider_family_absolute_error ?? {};
  const thresholdHash = thresholdsSha256(thresholds);
  const checks = [];
  checks.push({
    id: "distinct_episodes",
    passed: episodeCount >= thresholds.minimum_distinct_episodes,
    actual: episodeCount,
    required: thresholds.minimum_distinct_episodes,
  });
  checks.push({
    id: "package_prediction_samples",
    passed: packageSamples >= thresholds.minimum_package_prediction_samples,
    actual: packageSamples,
    required: thresholds.minimum_package_prediction_samples,
  });
  checks.push({
    id: "package_prediction_hit_rate",
    passed: packageSamples >= thresholds.minimum_package_prediction_samples
      && finite(packageHitRate)
      && packageHitRate >= thresholds.minimum_package_prediction_hit_rate,
    actual: finite(packageHitRate) ? packageHitRate : null,
    required: thresholds.minimum_package_prediction_hit_rate,
  });
  for (const [metric, maximum] of Object.entries(thresholds.maximum_mean_absolute_error)) {
    const row = metricRows?.[metric] ?? {};
    const sampleCount = Number(row.sample_count ?? 0);
    const error = Number(row.mean_absolute_error);
    checks.push({
      id: `aggregate_${metric}`,
      passed: sampleCount >= thresholds.minimum_distinct_episodes
        && finite(error)
        && error <= maximum,
      sample_count: sampleCount,
      actual: finite(error) ? error : null,
      maximum,
    });
  }
  for (const provider of ["chatgpt_web", "gemini_web"]) {
    const rows = providerRows?.[provider] ?? {};
    const minimumObserved = Math.min(...Object.values(rows).map((row) => Number(row?.sample_count ?? 0)));
    checks.push({
      id: `provider_family_${provider}_coverage`,
      passed: Number.isFinite(minimumObserved)
        && minimumObserved >= thresholds.minimum_provider_family_samples,
      actual: Number.isFinite(minimumObserved) ? minimumObserved : 0,
      required: thresholds.minimum_provider_family_samples,
    });
  }
  const calibrationPassed = checks.every((row) => row.passed === true);
  const approvalValidation = approval
    ? validateMixedViewerCalibrationApproval(approval, {
      learningLedgerSha256,
      thresholdPolicySha256: thresholdHash,
    })
    : { done: false, blockers: ["mixed_viewer_calibration_operator_approval_missing"] };
  const active = calibrationPassed && approvalValidation.done;
  const base = {
    schema: MIXED_VIEWER_CALIBRATION_POLICY_SCHEMA,
    status: active
      ? "active"
      : calibrationPassed
        ? "promotion_ready"
        : "insufficient_or_unreliable_evidence",
    production_mode: active
      ? "calibrated_decision_support"
      : "mandatory_advisory",
    selection_authority: active
      ? "operator_approved_robust_mixed_majority"
      : "none_until_calibrated",
    learning_ledger_path_required: true,
    learning_ledger_sha256: learningLedgerSha256 ?? null,
    learning_episode_count: episodeCount,
    threshold_policy: thresholds,
    threshold_policy_sha256: thresholdHash,
    threshold_checks: checks,
    calibration_passed: calibrationPassed,
    operator_approval_sha256: approvalValidation.done
      ? approval.approval_sha256
      : null,
    operator_approval_blockers: approvalValidation.done
      ? []
      : approvalValidation.blockers,
    policy: "The panel is mandatory evidence. It gains decision-support authority only after multi-episode outcome calibration and explicit operator promotion; it never changes creative defaults automatically.",
    created_at: createdAt,
  };
  return { ...base, policy_sha256: mixedViewerCalibrationPolicySha256(base) };
}

export function validateMixedViewerCalibrationPolicy(document, {
  learningLedgerSha256 = null,
  requireActive = false,
} = {}) {
  const blockers = [];
  if (document?.schema !== MIXED_VIEWER_CALIBRATION_POLICY_SCHEMA) blockers.push("mixed_viewer_calibration_policy_schema_invalid");
  if (!["active", "promotion_ready", "insufficient_or_unreliable_evidence"].includes(document?.status)) blockers.push("mixed_viewer_calibration_policy_status_invalid");
  if (!["mandatory_advisory", "calibrated_decision_support"].includes(document?.production_mode)) blockers.push("mixed_viewer_calibration_policy_mode_invalid");
  if (requireActive && document?.status !== "active") blockers.push("mixed_viewer_calibration_policy_not_active");
  if (document?.status === "active" && document?.production_mode !== "calibrated_decision_support") blockers.push("mixed_viewer_calibration_active_mode_invalid");
  if (document?.status !== "active" && document?.production_mode !== "mandatory_advisory") blockers.push("mixed_viewer_calibration_advisory_mode_invalid");
  if (learningLedgerSha256 && document?.learning_ledger_sha256 !== learningLedgerSha256) blockers.push("mixed_viewer_calibration_learning_hash_mismatch");
  if (document?.policy_sha256 !== mixedViewerCalibrationPolicySha256(document)) blockers.push("mixed_viewer_calibration_policy_hash_invalid");
  const checks = Array.isArray(document?.threshold_checks) ? document.threshold_checks : [];
  if (!checks.length) blockers.push("mixed_viewer_calibration_threshold_checks_missing");
  if (document?.calibration_passed !== checks.every((row) => row?.passed === true)) blockers.push("mixed_viewer_calibration_pass_state_invalid");
  if (document?.status === "active" && !/^[a-f0-9]{64}$/iu.test(clean(document?.operator_approval_sha256))) blockers.push("mixed_viewer_calibration_active_approval_missing");
  return { done: blockers.length === 0, blockers };
}
