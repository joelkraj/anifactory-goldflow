#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  YOUTUBE_ANALYTICS_FOLLOWUP_PLAN_SCHEMA,
  YOUTUBE_ANALYTICS_SNAPSHOT_SCHEMA,
} from "../lib/youtube-analytics-followup-contract.mjs";
import { discoverYoutubeAnalyticsCheckpoints } from "../lib/youtube-analytics-monitor.mjs";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function scheduledPlan({ episode, videoId }) {
  return {
    schema: YOUTUBE_ANALYTICS_FOLLOWUP_PLAN_SCHEMA,
    status: "scheduled",
    episode,
    video_id: videoId,
    analytics_anchor_at: "2026-08-14T12:00:00.000Z",
    checkpoints: [
      { id: "24h", due_at: "2026-08-15T12:00:00.000Z", state: "pending" },
      { id: "72h", due_at: "2026-08-17T12:00:00.000Z", state: "pending" },
      { id: "7d", due_at: "2026-08-21T12:00:00.000Z", state: "pending" },
    ],
  };
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-analytics-monitor-"));
try {
  const episodeDir = path.join(tempDir, "channels", "53rebirth", "weekly_runs", "run-a", "episodes", "ep_01");
  const planPath = path.join(episodeDir, "youtube_analytics_followup_plan_ep_01.json");
  await writeJson(planPath, scheduledPlan({ episode: "ep_01", videoId: "video-a" }));
  await writeJson(path.join(episodeDir, "youtube_analytics_snapshot_ep_01_24h.json"), {
    schema: YOUTUBE_ANALYTICS_SNAPSHOT_SCHEMA,
    status: "passed",
    captured_at: "2026-08-15T13:00:00.000Z",
    timing_delta_hours: 1,
  });

  const awaitingDir = path.join(tempDir, "channels", "53rebirth", "weekly_runs", "run-b", "episodes", "ep_02");
  await writeJson(path.join(awaitingDir, "youtube_analytics_followup_plan_ep_02.json"), {
    schema: YOUTUBE_ANALYTICS_FOLLOWUP_PLAN_SCHEMA,
    status: "awaiting_release_anchor",
    episode: "ep_02",
    video_id: "video-b",
    checkpoints: [{ id: "24h", due_at: null, state: "awaiting_release_anchor" }],
  });

  const otherChannelDir = path.join(tempDir, "channels", "asset-afterlife", "weekly_runs", "run-c", "episodes", "ep_01");
  await writeJson(path.join(otherChannelDir, "youtube_analytics_followup_plan_ep_01.json"), scheduledPlan({ episode: "ep_01", videoId: "video-c" }));

  const report = await discoverYoutubeAnalyticsCheckpoints({
    dataRoot: tempDir,
    channel: "53rebirth",
    now: "2026-08-18T12:00:00.000Z",
  });
  assert.equal(report.status, "passed");
  assert.equal(report.plan_count, 2);
  assert.equal(report.captured_count, 1);
  assert.equal(report.due_count, 1);
  assert.equal(report.pending_count, 1);
  assert.equal(report.awaiting_release_anchor_count, 1);
  assert.equal(report.due[0].window, "72h");
  assert.equal(report.due[0].lateness_hours, 24);
  assert.match(report.due[0].next_command, /--episode-dir/);
  assert.match(report.due[0].next_command, /--window '72h'/);
  assert.equal(report.pending[0].window, "7d");
  assert.match(report.awaiting_release_anchor[0].next_command, /verified-public-release-iso/);
  assert.ok(report.due.every((row) => row.video_id !== "video-c"));

  await fs.writeFile(path.join(episodeDir, "youtube_analytics_snapshot_ep_01_72h.json"), "not-json", "utf8");
  const blocked = await discoverYoutubeAnalyticsCheckpoints({
    dataRoot: tempDir,
    channel: "53rebirth",
    now: "2026-08-18T12:00:00.000Z",
  });
  assert.equal(blocked.status, "partial");
  assert.equal(blocked.due_count, 0);
  assert.equal(blocked.blockers[0].code, "analytics_snapshot_unreadable");

  console.log("youtube analytics monitor tests passed");
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
