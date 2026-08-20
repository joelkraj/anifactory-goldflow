#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildAnalyticsLearningReadiness,
  latestDistinctEpisodeReports,
} from "../lib/analytics-learning-policy.mjs";

function report({ id, window, origin = "external_ingest", production = "pipeline_native", impressions = 1000 }) {
  return {
    video_id: id,
    snapshot_label: window,
    production_lineage: production,
    script_origin: origin,
    source_room_lineage: origin === "goldflow_native" ? "hash_bound_winner_source_release" : "unavailable",
    retention_point_count: 10,
    summary_metrics: {
      ctr_percent: 5,
      impressions,
      average_percentage_viewed: 31,
      average_view_duration_sec: 900,
    },
  };
}

const duplicateSnapshots = [
  report({ id: "native-a", window: "24h", origin: "goldflow_native", impressions: 500 }),
  report({ id: "native-a", window: "72h", origin: "goldflow_native", impressions: 1400 }),
  report({ id: "external-a", window: "7d" }),
];
const latest = latestDistinctEpisodeReports(duplicateSnapshots);
assert.equal(latest.length, 2);
assert.equal(latest.find((row) => row.video_id === "native-a").snapshot_label, "72h");

const held = buildAnalyticsLearningReadiness(duplicateSnapshots);
assert.equal(held.domains.source_room.status, "hold");
assert.equal(held.domains.source_room.distinct_episode_count, 1);
assert.deepEqual(held.domains.source_room.episode_ids, ["native-a"]);
assert.equal(held.automatic_default_changes_allowed, false);

const ready = buildAnalyticsLearningReadiness([
  report({ id: "native-a", window: "72h", origin: "goldflow_native" }),
  report({ id: "native-b", window: "7d", origin: "goldflow_native" }),
  report({ id: "native-c", window: "72h", origin: "goldflow_native" }),
  report({ id: "external-a", window: "7d" }),
]);
assert.equal(ready.domains.source_room.status, "operator_review_allowed");
assert.equal(ready.domains.source_room.distinct_episode_count, 3);
assert.equal(ready.domains.packaging.distinct_episode_count, 4);
assert.equal(ready.domains.production.distinct_episode_count, 4);
assert.equal(ready.domains.source_room.episode_ids.includes("external-a"), false);
assert.equal(ready.domains.source_room.operator_approval_required, true);

const immature = buildAnalyticsLearningReadiness([
  report({ id: "native-a", window: "24h", origin: "goldflow_native" }),
  report({ id: "native-b", window: "24h", origin: "goldflow_native" }),
  report({ id: "native-c", window: "24h", origin: "goldflow_native" }),
]);
assert.equal(immature.domains.source_room.status, "hold");
assert.equal(immature.domains.source_room.distinct_episode_count, 0);

console.log("analytics learning policy tests passed");
