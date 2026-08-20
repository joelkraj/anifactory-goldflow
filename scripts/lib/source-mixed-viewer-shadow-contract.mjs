export const MIXED_VIEWER_SHADOW_REPORT_SCHEMA = "goldflow_mixed_viewer_shadow_report_v1";
export const MIXED_VIEWER_SHADOW_MANIFEST_SCHEMA = "goldflow_mixed_viewer_shadow_manifest_v1";
export const MIXED_VIEWER_SHADOW_AGGREGATE_SCHEMA = "goldflow_mixed_viewer_shadow_aggregate_v1";
export const MIXED_VIEWER_PANEL_MODES = Object.freeze([
  "shadow_non_blocking",
  "mandatory_advisory",
  "calibrated_decision_support",
]);
export const MIXED_VIEWER_CATASTROPHIC_VETO_TYPES = Object.freeze([
  "deception",
  "incoherence",
  "missing_payoff",
  "severe_confusion",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function finitePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100;
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function validateMixedViewerShadowReport(document, {
  candidateText = "",
  referenceText = "",
} = {}) {
  const blockers = [];
  const add = (condition, code) => {
    if (condition) blockers.push(code);
  };
  add(document?.schema !== MIXED_VIEWER_SHADOW_REPORT_SCHEMA, "mixed_viewer_report_schema_invalid");
  add(!clean(document?.persona_id), "mixed_viewer_report_persona_missing");
  add(!["chatgpt_web", "gemini_web"].includes(document?.provider_family), "mixed_viewer_report_provider_invalid");
  add(!["A", "B"].includes(document?.script_label_map?.candidate), "mixed_viewer_report_candidate_label_invalid");
  add(!["A", "B"].includes(document?.script_label_map?.reference), "mixed_viewer_report_reference_label_invalid");
  add(document?.script_label_map?.candidate === document?.script_label_map?.reference, "mixed_viewer_report_label_collision");
  add(!["candidate", "reference", "tie"].includes(document?.package_preference), "mixed_viewer_report_package_preference_invalid");
  add(!["accept", "reject", "uncertain"].includes(document?.recommendation), "mixed_viewer_report_recommendation_invalid");
  add(!["low", "medium", "high"].includes(document?.confidence), "mixed_viewer_report_confidence_invalid");
  for (const field of ["predicted_30_sec_retention_percent", "predicted_60_sec_retention_percent", "predicted_average_percentage_viewed"]) {
    add(!finitePercent(document?.predictions?.[field]), `mixed_viewer_report_${field}_invalid`);
  }
  add(!Number.isFinite(Number(document?.predictions?.predicted_average_view_duration_sec)) || Number(document.predictions.predicted_average_view_duration_sec) < 0, "mixed_viewer_report_avd_invalid");
  add(!Number.isFinite(Number(document?.predictions?.predicted_leave_point_sec)) || Number(document.predictions.predicted_leave_point_sec) < 0, "mixed_viewer_report_leave_point_invalid");
  add(!Number.isInteger(Number(document?.predictions?.full_story_satisfaction)) || Number(document.predictions.full_story_satisfaction) < 1 || Number(document.predictions.full_story_satisfaction) > 5, "mixed_viewer_report_satisfaction_invalid");
  const leaveAnchor = clean(document?.predictions?.leave_point_exact_anchor);
  add(!leaveAnchor || !candidateText.includes(leaveAnchor), "mixed_viewer_report_leave_anchor_invalid");
  const packageAnchor = clean(document?.package_reason_exact_anchor);
  const packageSource = document?.package_preference === "reference" ? referenceText : candidateText;
  add(!packageAnchor || !packageSource.includes(packageAnchor), "mixed_viewer_report_package_anchor_invalid");
  const vetoes = Array.isArray(document?.catastrophic_vetoes) ? document.catastrophic_vetoes : [];
  for (const [index, veto] of vetoes.entries()) {
    add(!MIXED_VIEWER_CATASTROPHIC_VETO_TYPES.includes(veto?.type), `mixed_viewer_report_veto_${index}_type_invalid`);
    add(!clean(veto?.exact_anchor) || !candidateText.includes(clean(veto?.exact_anchor)), `mixed_viewer_report_veto_${index}_anchor_invalid`);
    add(!clean(veto?.reason), `mixed_viewer_report_veto_${index}_reason_missing`);
  }
  return { done: blockers.length === 0, blockers };
}

export function aggregateMixedViewerShadow(reports, {
  candidateSha256 = null,
  referenceSha256 = null,
  mode = "shadow_non_blocking",
} = {}) {
  const blockers = [];
  if (!Array.isArray(reports) || reports.length !== 10) blockers.push("mixed_viewer_report_count_not_10");
  const ids = reports.map((row) => row?.persona_id);
  if (new Set(ids).size !== reports.length) blockers.push("mixed_viewer_persona_ids_duplicate");
  const providerCounts = {
    chatgpt_web: reports.filter((row) => row?.provider_family === "chatgpt_web").length,
    gemini_web: reports.filter((row) => row?.provider_family === "gemini_web").length,
  };
  if (providerCounts.chatgpt_web !== 5 || providerCounts.gemini_web !== 5) blockers.push("mixed_viewer_provider_split_not_5_5");
  const recommendation = { accept: 0, reject: 0, uncertain: 0 };
  const packagePreference = { candidate: 0, reference: 0, tie: 0 };
  const family = {
    chatgpt_web: { accept: 0, reject: 0, uncertain: 0 },
    gemini_web: { accept: 0, reject: 0, uncertain: 0 },
  };
  const familyPackage = {
    chatgpt_web: { candidate: 0, reference: 0, tie: 0 },
    gemini_web: { candidate: 0, reference: 0, tie: 0 },
  };
  const vetoCounts = Object.fromEntries(MIXED_VIEWER_CATASTROPHIC_VETO_TYPES.map((type) => [type, {
    total: 0,
    chatgpt_web: 0,
    gemini_web: 0,
  }]));
  for (const report of reports) {
    if (recommendation[report?.recommendation] !== undefined) recommendation[report.recommendation] += 1;
    if (packagePreference[report?.package_preference] !== undefined) packagePreference[report.package_preference] += 1;
    if (family[report?.provider_family]?.[report?.recommendation] !== undefined) family[report.provider_family][report.recommendation] += 1;
    if (familyPackage[report?.provider_family]?.[report?.package_preference] !== undefined) familyPackage[report.provider_family][report.package_preference] += 1;
    for (const veto of report?.catastrophic_vetoes ?? []) {
      if (!vetoCounts[veto?.type]) continue;
      vetoCounts[veto.type].total += 1;
      vetoCounts[veto.type][report.provider_family] += 1;
    }
  }
  const catastrophicConsensus = Object.entries(vetoCounts)
    .filter(([, row]) => row.total >= 3 && row.chatgpt_web >= 1 && row.gemini_web >= 1)
    .map(([type, row]) => ({ type, ...row }));
  const robustMajority = recommendation.accept >= 6
    && family.chatgpt_web.accept >= 2
    && family.gemini_web.accept >= 2
    && catastrophicConsensus.length === 0;
  const predictionSummary = (rows) => ({
    median_leave_point_sec: median(rows.map((row) => row?.predictions?.predicted_leave_point_sec)),
    median_30_sec_retention_percent: median(rows.map((row) => row?.predictions?.predicted_30_sec_retention_percent)),
    median_60_sec_retention_percent: median(rows.map((row) => row?.predictions?.predicted_60_sec_retention_percent)),
    median_average_percentage_viewed: median(rows.map((row) => row?.predictions?.predicted_average_percentage_viewed)),
    median_average_view_duration_sec: median(rows.map((row) => row?.predictions?.predicted_average_view_duration_sec)),
    median_full_story_satisfaction: median(rows.map((row) => row?.predictions?.full_story_satisfaction)),
  });
  const aggregate = {
    schema: MIXED_VIEWER_SHADOW_AGGREGATE_SCHEMA,
    status: blockers.length ? "blocked" : "complete",
    mode,
    candidate_sha256: candidateSha256,
    reference_sha256: referenceSha256,
    report_count: reports.length,
    provider_counts: providerCounts,
    recommendation_tallies: recommendation,
    package_preference_tallies: packagePreference,
    provider_family_tallies: family,
    provider_family_package_tallies: familyPackage,
    catastrophic_veto_tallies: vetoCounts,
    catastrophic_consensus: catastrophicConsensus,
    robust_mixed_model_majority: robustMajority,
    exceptional_confidence_10_0: recommendation.accept === 10 && catastrophicConsensus.length === 0,
    shadow_decision: catastrophicConsensus.length
      ? "catastrophic_veto"
      : robustMajority
        ? "shadow_accept"
        : "shadow_hold",
    calibrated_decision: catastrophicConsensus.length
      ? "reject"
      : robustMajority
        ? "accept"
        : "hold",
    predictions: predictionSummary(reports),
    provider_family_predictions: Object.fromEntries(Object.keys(family).map((provider) => [
      provider,
      predictionSummary(reports.filter((row) => row?.provider_family === provider)),
    ])),
    calibration_status: "unmeasured",
    blockers,
  };
  return aggregate;
}

export function validateMixedViewerShadowManifest(document, {
  requireProductionGate = false,
  calibrationPolicySha256 = null,
} = {}) {
  const blockers = [];
  if (document?.schema !== MIXED_VIEWER_SHADOW_MANIFEST_SCHEMA) blockers.push("mixed_viewer_manifest_schema_invalid");
  if (document?.status !== "completed") blockers.push("mixed_viewer_manifest_not_completed");
  if (!MIXED_VIEWER_PANEL_MODES.includes(document?.mode)) blockers.push("mixed_viewer_manifest_mode_invalid");
  if (requireProductionGate && document?.mode === "shadow_non_blocking") blockers.push("mixed_viewer_manifest_production_gate_missing");
  const expectedAuthority = document?.mode === "calibrated_decision_support"
    ? "operator_approved_robust_mixed_majority"
    : "none_until_calibrated";
  if (document?.selection_authority !== expectedAuthority) blockers.push("mixed_viewer_manifest_selection_authority_invalid");
  if (document?.mode !== "shadow_non_blocking") {
    if (!/^[a-f0-9]{64}$/iu.test(clean(document?.calibration_policy_sha256))) blockers.push("mixed_viewer_manifest_calibration_policy_hash_missing");
    if (calibrationPolicySha256 && document?.calibration_policy_sha256 !== calibrationPolicySha256) blockers.push("mixed_viewer_manifest_calibration_policy_hash_mismatch");
  }
  const receipts = Array.isArray(document?.receipts) ? document.receipts : [];
  if (receipts.length !== 10) blockers.push("mixed_viewer_manifest_receipt_count_not_10");
  if (new Set(receipts.map((row) => row?.persona_id)).size !== receipts.length) blockers.push("mixed_viewer_manifest_persona_ids_duplicate");
  if (receipts.filter((row) => row?.provider_family === "chatgpt_web").length !== 5) blockers.push("mixed_viewer_manifest_gpt_count_not_5");
  if (receipts.filter((row) => row?.provider_family === "gemini_web").length !== 5) blockers.push("mixed_viewer_manifest_gemini_count_not_5");
  return { done: blockers.length === 0, blockers };
}

export function calibrateMixedViewerShadow(aggregate, {
  actual30SecRetention = null,
  actual60SecRetention = null,
  actualAveragePercentageViewed = null,
  actualAverageViewDurationSec = null,
  actualLeavePointSec = null,
  actualPackageWinner = null,
} = {}) {
  const predicted = aggregate?.predictions ?? {};
  const error = (forecast, actual) => Number.isFinite(Number(forecast)) && Number.isFinite(Number(actual))
    ? Number((Number(forecast) - Number(actual)).toFixed(3))
    : null;
  const absolute = (value) => value == null ? null : Math.abs(value);
  const signedErrors = {
    leave_point_sec: error(predicted.median_leave_point_sec, actualLeavePointSec),
    first_30_sec_retention_percent: error(predicted.median_30_sec_retention_percent, actual30SecRetention),
    first_60_sec_retention_percent: error(predicted.median_60_sec_retention_percent, actual60SecRetention),
    average_percentage_viewed: error(predicted.median_average_percentage_viewed, actualAveragePercentageViewed),
    average_view_duration_sec: error(predicted.median_average_view_duration_sec, actualAverageViewDurationSec),
  };
  const predictedPackageWinner = Object.entries(aggregate?.package_preference_tallies ?? {})
    .sort((left, right) => Number(right[1]) - Number(left[1]))[0]?.[0] ?? null;
  const providerFamilyCalibration = Object.fromEntries(Object.entries(aggregate?.provider_family_predictions ?? {}).map(([provider, familyPrediction]) => {
    const errors = {
      leave_point_sec: error(familyPrediction.median_leave_point_sec, actualLeavePointSec),
      first_30_sec_retention_percent: error(familyPrediction.median_30_sec_retention_percent, actual30SecRetention),
      first_60_sec_retention_percent: error(familyPrediction.median_60_sec_retention_percent, actual60SecRetention),
      average_percentage_viewed: error(familyPrediction.median_average_percentage_viewed, actualAveragePercentageViewed),
      average_view_duration_sec: error(familyPrediction.median_average_view_duration_sec, actualAverageViewDurationSec),
    };
    const familyWinner = Object.entries(aggregate?.provider_family_package_tallies?.[provider] ?? {})
      .sort((left, right) => Number(right[1]) - Number(left[1]))[0]?.[0] ?? null;
    return [provider, {
      signed_errors: errors,
      absolute_errors: Object.fromEntries(Object.entries(errors).map(([key, value]) => [key, absolute(value)])),
      predicted_package_winner: familyWinner,
      package_prediction_correct: actualPackageWinner == null ? null : familyWinner === actualPackageWinner,
    }];
  }));
  return {
    schema: "goldflow_mixed_viewer_shadow_calibration_v1",
    status: "observed",
    association_only: true,
    signed_errors: signedErrors,
    absolute_errors: Object.fromEntries(Object.entries(signedErrors).map(([key, value]) => [key, absolute(value)])),
    predicted_package_winner: predictedPackageWinner,
    actual_package_winner: actualPackageWinner,
    package_prediction_correct: actualPackageWinner == null ? null : predictedPackageWinner === actualPackageWinner,
    provider_family_calibration: providerFamilyCalibration,
  };
}
