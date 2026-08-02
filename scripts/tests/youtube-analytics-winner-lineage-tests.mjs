#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildWinnerSourceDimensionSummariesForTests,
  readWinnerSourceLineageForTests,
} from "../youtube-analytics-feedback.mjs";

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
