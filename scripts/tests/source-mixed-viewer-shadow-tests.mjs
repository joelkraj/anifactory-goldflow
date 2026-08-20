import assert from "node:assert/strict";
import {
  MIXED_VIEWER_SHADOW_MANIFEST_SCHEMA,
  MIXED_VIEWER_SHADOW_REPORT_SCHEMA,
  aggregateMixedViewerShadow,
  calibrateMixedViewerShadow,
  validateMixedViewerShadowManifest,
  validateMixedViewerShadowReport,
} from "../lib/source-mixed-viewer-shadow-contract.mjs";
import {
  MIXED_VIEWER_CALIBRATION_APPROVAL_SCHEMA,
  buildMixedViewerCalibrationPolicy,
  mixedViewerCalibrationApprovalSha256,
  validateMixedViewerCalibrationPolicy,
} from "../lib/source-mixed-viewer-calibration-contract.mjs";

const candidate = "Joey refuses the sacrifice and forces Serena to reveal the recall list. He protects the healer by choice.";
const reference = "The reference opens with a visible betrayal and completes its revenge before the ending.";
const reports = Array.from({ length: 10 }, (_, index) => ({
  schema: MIXED_VIEWER_SHADOW_REPORT_SCHEMA,
  persona_id: `persona_${index + 1}`,
  provider_family: index % 2 === 0 ? "chatgpt_web" : "gemini_web",
  script_label_map: { candidate: "A", reference: "B" },
  package_preference: index < 7 ? "candidate" : "reference",
  package_reason_exact_anchor: index < 7 ? "Joey refuses the sacrifice" : "visible betrayal",
  predictions: {
    predicted_leave_point_sec: 84 + index,
    leave_point_exact_anchor: "forces Serena to reveal the recall list",
    predicted_30_sec_retention_percent: 78 - index,
    predicted_60_sec_retention_percent: 70 - index,
    predicted_average_percentage_viewed: 48 - index / 2,
    predicted_average_view_duration_sec: 980 - index * 5,
    full_story_satisfaction: 4,
  },
  recommendation: index < 7 ? "accept" : index < 9 ? "uncertain" : "reject",
  confidence: "medium",
  catastrophic_vetoes: [],
  one_sentence_verdict: "The candidate remains competitive.",
}));

for (const report of reports) {
  assert.equal(validateMixedViewerShadowReport(report, { candidateText: candidate, referenceText: reference }).done, true);
}
const aggregate = aggregateMixedViewerShadow(reports, {
  candidateSha256: "a".repeat(64),
  referenceSha256: "b".repeat(64),
});
assert.equal(aggregate.status, "complete");
assert.equal(aggregate.robust_mixed_model_majority, true);
assert.equal(aggregate.shadow_decision, "shadow_accept");
assert.equal(aggregate.provider_counts.chatgpt_web, 5);
assert.equal(aggregate.provider_counts.gemini_web, 5);

const manifest = {
  schema: MIXED_VIEWER_SHADOW_MANIFEST_SCHEMA,
  status: "completed",
  mode: "shadow_non_blocking",
  selection_authority: "none_until_calibrated",
  receipts: reports.map((report) => ({
    persona_id: report.persona_id,
    provider_family: report.provider_family,
  })),
};
assert.equal(validateMixedViewerShadowManifest(manifest).done, true);

const learningLedgerSha256 = "c".repeat(64);
const learningLedger = {
  mixed_viewer_shadow_calibration: {
    episode_count: 3,
    package_prediction_sample_count: 3,
    package_prediction_hit_rate: 2 / 3,
    aggregate_absolute_error: {
      leave_point_sec: { sample_count: 3, mean_absolute_error: 20 },
      first_30_sec_retention_percent: { sample_count: 3, mean_absolute_error: 4 },
      first_60_sec_retention_percent: { sample_count: 3, mean_absolute_error: 5 },
      average_percentage_viewed: { sample_count: 3, mean_absolute_error: 4 },
      average_view_duration_sec: { sample_count: 3, mean_absolute_error: 90 },
    },
    provider_family_absolute_error: Object.fromEntries(["chatgpt_web", "gemini_web"].map((provider) => [provider, {
      leave_point_sec: { sample_count: 3, mean_absolute_error: 20 },
      first_30_sec_retention_percent: { sample_count: 3, mean_absolute_error: 4 },
      first_60_sec_retention_percent: { sample_count: 3, mean_absolute_error: 5 },
      average_percentage_viewed: { sample_count: 3, mean_absolute_error: 4 },
      average_view_duration_sec: { sample_count: 3, mean_absolute_error: 90 },
    }])),
  },
};
const promotionReady = buildMixedViewerCalibrationPolicy({ learningLedger, learningLedgerSha256 });
assert.equal(promotionReady.status, "promotion_ready");
assert.equal(promotionReady.production_mode, "mandatory_advisory");
const approvalBase = {
  schema: MIXED_VIEWER_CALIBRATION_APPROVAL_SCHEMA,
  status: "approved",
  production_mode: "calibrated_decision_support",
  learning_ledger_sha256: learningLedgerSha256,
  threshold_policy_sha256: promotionReady.threshold_policy_sha256,
  approved_by: "fixture",
  approved_at: "2026-08-18T00:00:00.000Z",
};
const approval = { ...approvalBase, approval_sha256: mixedViewerCalibrationApprovalSha256(approvalBase) };
const activePolicy = buildMixedViewerCalibrationPolicy({ learningLedger, learningLedgerSha256, approval });
assert.equal(activePolicy.status, "active");
assert.equal(validateMixedViewerCalibrationPolicy(activePolicy, { learningLedgerSha256 }).done, true);
const productionManifest = {
  ...manifest,
  mode: "calibrated_decision_support",
  selection_authority: "operator_approved_robust_mixed_majority",
  calibration_policy_sha256: activePolicy.policy_sha256,
};
assert.equal(validateMixedViewerShadowManifest(productionManifest, {
  requireProductionGate: true,
  calibrationPolicySha256: activePolicy.policy_sha256,
}).done, true);

const calibration = calibrateMixedViewerShadow(aggregate, {
  actual30SecRetention: 74,
  actual60SecRetention: 66,
  actualAveragePercentageViewed: 45,
  actualAverageViewDurationSec: 950,
  actualLeavePointSec: 90,
  actualPackageWinner: "candidate",
});
assert.equal(calibration.status, "observed");
assert.equal(calibration.package_prediction_correct, true);
assert.ok(Number.isFinite(calibration.absolute_errors.first_30_sec_retention_percent));

const vetoReports = reports.map((report, index) => index < 3 ? {
  ...report,
  provider_family: index === 1 ? "gemini_web" : report.provider_family,
  catastrophic_vetoes: [{
    type: "missing_payoff",
    exact_anchor: "He protects the healer by choice.",
    reason: "The title promise would remain unresolved.",
  }],
} : report);
const vetoAggregate = aggregateMixedViewerShadow(vetoReports);
assert.equal(vetoAggregate.shadow_decision, "catastrophic_veto");

console.log("source mixed viewer shadow tests passed");
