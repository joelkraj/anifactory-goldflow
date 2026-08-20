#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMixedViewerShadowCalibrationForTests,
  buildQualityOutcomeCalibrationForTests,
  buildStoryLearningLedgerForTests,
  buildStoryRetentionAttributionForTests,
  buildViewerCalibrationForTests,
  buildWinnerSourceDimensionSummariesForTests,
  readWinnerSourceLineageForTests,
} from "../youtube-analytics-feedback.mjs";
import {
  buildEpisodeQualityOutcomeRecord,
  validateEpisodeQualityOutcomeRecord,
} from "../lib/episode-quality-outcome.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, text, "utf8");
  return { text, sha256: sha256(text) };
}

function feedback({ episode, ctr, impressions, avd, apv, retention, lineage }) {
  return {
    schema: "goldflow_youtube_performance_feedback_v1",
    status: "passed",
    episode,
    summary_metrics: {
      ctr_percent: ctr,
      impressions,
      average_view_duration_sec: avd,
      average_percentage_viewed: apv,
    },
    significant_drops: retention.length > 1 ? [{}] : [],
    significant_rises: [],
    attributed_retention: retention.map((retentionPct) => ({ retention_pct: retentionPct })),
    ...(lineage ? { winner_source_lineage: lineage } : {}),
  };
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-youtube-lineage-"));
try {
  const packagePath = path.join(tempDir, "winner_package_contract.json");
  const sourceReportPath = path.join(tempDir, "source_story_ingest_report.json");
  const storyLockPath = path.join(tempDir, "operator_story_lock.json");
  const packageContract = {
    schema: "goldflow_source_winner_package_v1",
    status: "approved",
    formula_version: "2026-08-01.1",
    selected_candidate_id: "wife_sold_home",
    weighted_score: 91.5,
    title_contract: {
      betrayer: "wife",
      betrayal_action: "sold Joey's home",
      reversal_action: "Joey bought her company",
      antagonist_loss: "control of the company",
    },
    core_advantage: { type: "knowledge" },
    thumbnail_contract: {
      main_text: "HE OWNS IT",
      additive_fact: "Her signed sale becomes his proof of ownership.",
    },
  };
  const packageWrite = await writeJson(packagePath, packageContract);
  const boundLineage = {
    schema: "goldflow_ingest_winner_source_lineage_v1",
    release_sha256: "release-hash",
    source_script_sha256: "script-hash",
    formula_version: packageContract.formula_version,
    selected_candidate_id: packageContract.selected_candidate_id,
    winner_package_path: packagePath,
    winner_package_sha256: packageWrite.sha256,
  };
  await writeJson(sourceReportPath, {
    status: "source_ingested_pending_review_and_approval",
    winner_source_release: boundLineage,
    source_review_log_decision: "REJECT",
  });
  await writeJson(storyLockPath, {
    status: "source_locked_ingest",
    winner_source_release: boundLineage,
  });

  const lineage = await readWinnerSourceLineageForTests({
    sourceIngestReportPath: sourceReportPath,
    operatorStoryLockPath: storyLockPath,
  });
  assert.equal(lineage.status, "bound");
  assert.equal(lineage.package_hash_status, "matched");
  assert.equal(lineage.dimensions.formula_version, "2026-08-01.1");
  assert.equal(lineage.dimensions.selected_candidate_id, "wife_sold_home");
  assert.equal(lineage.dimensions.betrayer_relationship, "wife");
  assert.equal(lineage.dimensions.betrayal_action, "sold Joey's home");
  assert.equal(lineage.dimensions.reversal_action, "Joey bought her company");
  assert.equal(lineage.dimensions.antagonist_loss, "control of the company");
  assert.equal(lineage.dimensions.mechanic_type, "knowledge");
  assert.equal(lineage.dimensions.thumbnail_main_text, "HE OWNS IT");
  assert.equal(lineage.dimensions.thumbnail_additive_fact, "Her signed sale becomes his proof of ownership.");
  assert.equal(lineage.dimensions.package_score, 91.5);
  assert.match(lineage.review_policy, /review logs only/i);

  const aggregate = buildWinnerSourceDimensionSummariesForTests([
    feedback({ episode: "ep_01", ctr: 4, impressions: 1000, avd: 600, apv: 20, retention: [70, 60], lineage }),
    feedback({ episode: "ep_02", ctr: 6, impressions: 3000, avd: 900, apv: 30, retention: [80], lineage }),
    feedback({ episode: "legacy_ep", ctr: 2, impressions: 500, avd: 300, apv: 10, retention: [50] }),
  ]);
  assert.deepEqual(aggregate.coverage, {
    report_count: 3,
    bound_report_count: 2,
    partial_lineage_report_count: 0,
    legacy_unbound_report_count: 1,
    bound_fraction: 0.6667,
  });
  const formulaGroup = aggregate.dimension_summaries.formula_version["2026-08-01.1"];
  assert.equal(formulaGroup.episode_count, 2);
  assert.equal(formulaGroup.average_ctr_percent, 5);
  assert.equal(formulaGroup.impression_weighted_ctr_percent, 5.5);
  assert.equal(formulaGroup.total_impressions, 4000);
  assert.equal(formulaGroup.average_view_duration_sec, 750);
  assert.equal(formulaGroup.average_percentage_viewed, 25);
  assert.equal(formulaGroup.average_retention_pct, 70);
  assert.equal(formulaGroup.average_package_score, 91.5);
  assert.equal(aggregate.dimension_summaries.formula_version.unbound_legacy.average_ctr_percent, 2);
  assert.ok(aggregate.dimension_summaries.package_score["91.5"]);

  const storyScript = "Joey chose the shield. Serena saw the reversal. The crew changed its plan.";
  const promiseText = "Serena saw the reversal.";
  const promiseStart = storyScript.indexOf(promiseText);
  const storyAttributed = buildStoryRetentionAttributionForTests({
    attributedRows: [{ elapsed_sec: 4, retention_pct: 74, delta_from_previous_pct: -6 }],
    wordTiming: {
      words: storyScript.split(/\s+/).map((word, index) => ({ index, word, start_sec: index, end_sec: index + 0.8 })),
    },
    scriptText: storyScript,
    storyTruthIr: { status: "locked" },
    storyTruthScriptMap: {
      status: "mapped",
      mappings: [{
        map_id: "map_promise_1_first_proof",
        truth_collection: "promises",
        truth_id: "promise_1",
        phase: "first_proof",
        movement_id: "movement_2",
        start_offset: promiseStart,
        end_offset: promiseStart + promiseText.length,
        exact_text: promiseText,
        story_function: "reversal_proof",
      }],
    },
    storyTruthIrSha256: "a".repeat(64),
  });
  assert.deepEqual(storyAttributed[0].promise_ids, ["promise_1"]);
  assert.equal(storyAttributed[0].story_truth_matches[0].story_function, "reversal_proof");
  assert.match(storyAttributed[0].narration_passage.exact_text, /Serena saw the reversal/);

  const calibrationScript = "one two three four five six seven eight nine ten";
  const calibration = buildViewerCalibrationForTests({
    manifest: { _file_sha256: "b".repeat(64) },
    reports: [{
      persona_id: "impatient_power_fantasy_viewer",
      script_label_map: { candidate: "A", reference: "B" },
      earliest_leave_risk: { A: { exact_anchor: "six", reason: "Momentum stalls." } },
    }],
    scriptText: calibrationScript,
    durationSec: 90,
    significantDrops: [{ elapsed_sec: 52, delta_from_previous_pct: -8 }],
    toleranceSec: 5,
  });
  assert.equal(calibration.length, 1);
  assert.equal(calibration[0].calibrated_hit, true);
  assert.equal(calibration[0].absolute_error_sec, 2);

  const mixedCalibration = buildMixedViewerShadowCalibrationForTests({
    aggregate: {
      status: "complete",
      predictions: {
        median_leave_point_sec: 50,
        median_30_sec_retention_percent: 80,
        median_60_sec_retention_percent: 70,
        median_average_percentage_viewed: 45,
        median_average_view_duration_sec: 800,
      },
      package_preference_tallies: { candidate: 7, reference: 2, tie: 1 },
      provider_family_predictions: {
        chatgpt_web: { median_leave_point_sec: 48, median_30_sec_retention_percent: 81, median_60_sec_retention_percent: 69, median_average_percentage_viewed: 46, median_average_view_duration_sec: 810 },
        gemini_web: { median_leave_point_sec: 52, median_30_sec_retention_percent: 79, median_60_sec_retention_percent: 71, median_average_percentage_viewed: 44, median_average_view_duration_sec: 790 },
      },
      provider_family_package_tallies: {
        chatgpt_web: { candidate: 4, reference: 1, tie: 0 },
        gemini_web: { candidate: 3, reference: 1, tie: 1 },
      },
    },
    retentionRows: [{ elapsed_sec: 30, retention_pct: 78 }, { elapsed_sec: 60, retention_pct: 67 }],
    significantDrops: [{ elapsed_sec: 53, delta_from_previous_pct: -8 }],
    averagePercentageViewed: 43,
    averageViewDurationSec: 780,
    actualPackageWinner: "candidate",
  });
  assert.equal(mixedCalibration.package_prediction_correct, true);
  assert.equal(mixedCalibration.absolute_errors.leave_point_sec, 3);
  assert.equal(mixedCalibration.provider_family_calibration.chatgpt_web.package_prediction_correct, true);

  await writeJson(path.join(tempDir, "section_image_prompts_hardened.json"), {
    status: "passed",
    prompts: [{ image_id: "cut_001" }, { image_id: "cut_002" }],
  });
  await writeJson(path.join(tempDir, "imagegen_report_ep_01.json"), {
    status: "passed",
    results: [
      { image_id: "cut_001", first_pass: true, status: "passed" },
      { image_id: "cut_002", first_pass: true, status: "failed" },
    ],
  });
  await writeJson(path.join(tempDir, "image_output_qa_ep_01.json"), {
    status: "passed",
    image_count: 2,
    structurally_valid_count: 2,
    advisory_risk_cut_count: 1,
  });
  await writeJson(path.join(tempDir, "image_semantic_audit_ep_01.json"), {
    status: "passed",
    audited_count: 2,
    passed_count: 1,
    needs_review_count: 1,
    rows: [],
  });
  await fs.mkdir(path.join(tempDir, "assets", "motion", "generated"), { recursive: true });
  await writeJson(path.join(tempDir, "assets", "motion", "generated", "generated_motion_coherence_audit_ep_01.json"), {
    status: "passed",
    summary: { clip_count: 2, pass_count: 1, needs_review_count: 1, reject_recommended_count: 0, unavailable_count: 0 },
  });
  await writeJson(path.join(tempDir, "narration_subjective_review_manifest_ep_01.json"), {
    status: "review_required",
    sample_count: 6,
  });
  await writeJson(path.join(tempDir, "narration_subjective_review_decision_ep_01.json"), {
    status: "approved",
    decisions: Array.from({ length: 6 }, (_, index) => ({ sample_id: `sample_${index}`, decision: "accepted", repair_unit_ids: [] })),
  });
  await writeJson(path.join(tempDir, "youtube_packaging_spec_ep_01.json"), {
    status: "approved",
    selected_title: "A complete betrayal and revenge title",
    selected_thumbnail_candidate_id: "thumb_a",
    title_candidates: [{}, {}, {}],
    thumbnail_candidates: [{}, {}],
  });
  const mixedViewerPath = path.join(tempDir, "mixed_viewer.json");
  await writeJson(mixedViewerPath, {
    status: "complete",
    package_preference_tallies: { candidate: 7, reference: 2, tie: 1 },
  });
  const heroDir = path.join(tempDir, "reports", "hero-image-candidates", "cut_001");
  await fs.mkdir(heroDir, { recursive: true });
  await writeJson(path.join(heroDir, "selection.json"), {
    schema: "goldflow_hero_image_candidate_selection_v1",
    status: "selected",
    canonical_image_id: "cut_001",
    selection_method: "blind_visual_selector",
    selected_candidate: { label: "A", semantic_score: { score: 95 } },
    rejected_candidate: { label: "B", semantic_score: { score: 88 } },
  });
  const analyticsInputPath = path.join(tempDir, "analytics.json");
  await writeJson(analyticsInputPath, [{ elapsed_sec: 0, retention_pct: 100 }]);
  const qualityOutcome = await buildEpisodeQualityOutcomeRecord({
    episodeDir: tempDir,
    episode: "ep_01",
    analytics: {
      snapshot_label: "72h",
      final_video_sha256: "9".repeat(64),
      summary_metrics: { ctr_percent: 6, impressions: 10000, average_view_duration_sec: 900, average_percentage_viewed: 40 },
      significant_drops: [{ elapsed_sec: 60 }],
      significant_rises: [],
    },
    analyticsInputPath,
    paths: { mixedViewer: mixedViewerPath },
  });
  assert.equal(validateEpisodeQualityOutcomeRecord(qualityOutcome).status, "passed");
  assert.equal(qualityOutcome.quality_signals.prompt_and_raster.explicit_first_pass_acceptance_rate, 0.5);
  assert.equal(qualityOutcome.quality_signals.hero_alternatives.selected_hero_count, 1);
  assert.equal(qualityOutcome.quality_signals.generated_motion.coherence_pass_rate, 0.5);
  assert.equal(qualityOutcome.quality_signals.narration.clean_subjective_pass, true);
  assert.equal(qualityOutcome.quality_signals.package.mixed_viewer_candidate_margin, 0.5);

  const qualityCalibration = buildQualityOutcomeCalibrationForTests([
    { episode: "quality_1", episode_quality_outcome: qualityOutcome },
    { episode: "quality_2", episode_quality_outcome: {
      ...qualityOutcome,
      observed_outcomes: { ...qualityOutcome.observed_outcomes, ctr_percent: 7, average_percentage_viewed: 45 },
      quality_signals: { ...qualityOutcome.quality_signals, generated_motion: { ...qualityOutcome.quality_signals.generated_motion, coherence_pass_rate: 0.75 } },
    } },
    { episode: "quality_3", episode_quality_outcome: {
      ...qualityOutcome,
      observed_outcomes: { ...qualityOutcome.observed_outcomes, ctr_percent: 8, average_percentage_viewed: 50 },
      quality_signals: { ...qualityOutcome.quality_signals, generated_motion: { ...qualityOutcome.quality_signals.generated_motion, coherence_pass_rate: 1 } },
    } },
  ]);
  assert.equal(qualityCalibration.episode_count, 3);
  assert.equal(qualityCalibration.signals.generated_motion_coherence.disposition, "operator_review_allowed");

  const learningReports = ["ep_a", "ep_b", "ep_c"].map((episode, index) => ({
    episode,
    snapshot_label: "72h",
    attributed_retention: [{
      retention_pct: 70 - index,
      delta_from_previous_pct: -5 - index,
      story_truth_matches: [{
        truth_collection: "promises",
        truth_id: `promise_${index + 1}`,
        phase: "first_proof",
        story_function: "reversal_proof",
      }],
    }],
    viewer_simulation_calibration: {
      predictions: [{
        persona_id: "impatient_power_fantasy_viewer",
        calibrated_hit: index !== 1,
        absolute_error_sec: index + 1,
      }],
    },
    mixed_viewer_shadow_calibration: {
      status: "observed",
      absolute_errors: {
        leave_point_sec: 3 + index,
        first_30_sec_retention_percent: 2 + index,
        first_60_sec_retention_percent: 3 + index,
        average_percentage_viewed: 4 + index,
        average_view_duration_sec: 20 + index,
      },
      package_prediction_correct: index !== 1,
      provider_family_calibration: {
        chatgpt_web: { absolute_errors: { leave_point_sec: 2 + index } },
        gemini_web: { absolute_errors: { leave_point_sec: 4 + index } },
      },
    },
  }));
  const earlyLearning = buildStoryLearningLedgerForTests(learningReports.slice(0, 2));
  assert.equal(earlyLearning.default_change_eligibility, "hold_for_more_distinct_episodes");
  const matureLearning = buildStoryLearningLedgerForTests(learningReports);
  assert.equal(matureLearning.default_change_eligibility, "operator_review_allowed");
  assert.equal(matureLearning.story_function_summaries["promises:first_proof"].episode_count, 3);
  assert.equal(matureLearning.viewer_persona_calibration.impatient_power_fantasy_viewer.calibration_status, "measured");
  assert.equal(matureLearning.mixed_viewer_shadow_calibration.promotion_eligibility, "operator_review_allowed");
  assert.equal(matureLearning.mixed_viewer_shadow_calibration.aggregate_absolute_error.leave_point_sec.sample_count, 3);

  await fs.writeFile(packagePath, `${packageWrite.text} `, "utf8");
  const mismatched = await readWinnerSourceLineageForTests({
    sourceIngestReportPath: sourceReportPath,
    operatorStoryLockPath: storyLockPath,
  });
  assert.equal(mismatched.status, "partial_lineage");
  assert.equal(mismatched.package_hash_status, "mismatch");
  assert.equal(mismatched.dimensions.formula_version, "2026-08-01.1");
  assert.equal(mismatched.dimensions.betrayer_relationship, null);
  assert.ok(mismatched.warnings.includes("winner_package_hash_mismatch"));

  const legacy = await readWinnerSourceLineageForTests({
    sourceIngestReportPath: path.join(tempDir, "missing-source-report.json"),
    operatorStoryLockPath: path.join(tempDir, "missing-story-lock.json"),
  });
  assert.equal(legacy.status, "legacy_unbound");
  assert.equal(legacy.bound, false);

  console.log("youtube analytics winner lineage tests passed");
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
