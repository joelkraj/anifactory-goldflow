#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { adjustShortsSchedule } from "../shorts-adjust-schedule.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const helperPath = path.join(repoRoot, "scripts", "shorts-adjust-schedule.mjs");

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compactHash(value) {
  return sha256(JSON.stringify(value));
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, jsonBytes(value));
}

function itemSpecHash(campaign, item, rendererVersion = null) {
  return compactHash({
    schema: "goldflow_shorts_story_card_item_spec_v1",
    ...(rendererVersion ? { renderer_version: rendererVersion } : {}),
    campaign_id: campaign.campaign_id,
    item,
    brand: campaign.brand,
    canvas: campaign.canvas,
    reading_wpm: campaign.reading_wpm,
  });
}

function diffPaths(left, right, prefix = "") {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => index)
      .flatMap((index) => diffPaths(left[index], right[index], `${prefix}${prefix ? "." : ""}${index}`));
  }
  if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key) => diffPaths(left[key], right[key], `${prefix}${prefix ? "." : ""}${key}`));
  }
  return [prefix || "<root>"];
}

function futureCampaignDate(dayOffset = 3) {
  const date = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

async function createFixture(root, fixtureName) {
  const campaignDir = path.join(root, "channels", "53rebirth", "shorts_campaigns", fixtureName);
  const campaignManifestPath = path.join(campaignDir, "shorts_campaign.json");
  const date = futureCampaignDate();
  const schedules = [`${date}T09:00:00Z`, `${date}T14:00:00Z`, `${date}T20:00:00Z`];
  const campaign = {
    schema: "goldflow_shorts_story_card_campaign_v1",
    status: "approved_for_render_and_schedule",
    campaign_id: `${fixtureName}-campaign-v1`,
    output_dir: campaignDir,
    brand: { display_name: "Manhwa Joey", handle: "@ManhwaJoey" },
    canvas: { width: 1080, height: 1920, fps: 60 },
    reading_wpm: 200,
    schedule: {
      timezone: "UTC",
      start_date: date,
      end_date: date,
      daily_target: 3,
      daily_min: 2,
      daily_max: 4,
      longform_blackout_minutes: 90,
    },
    items: schedules.map((scheduleAt, index) => ({
      id: `${fixtureName}-short-${index + 1}`,
      schedule_at: scheduleAt,
      packaging: {
        title: `Fixture Short ${index + 1} #shorts`,
        description: `Fixture ${index + 1}\n\n#shorts`,
        tags: ["shorts", "manhwa"],
      },
      related_longform: {
        video_id: "W94xrqnsLlY",
        watch_url: "https://youtu.be/W94xrqnsLlY",
        title: "Fixture Longform | Manhwa Recap",
        release_at: `${date}T00:00:00Z`,
        state_at_plan_time: "scheduled",
      },
    })),
  };
  await writeJson(campaignManifestPath, campaign);
  const campaignManifestSha256 = await sha256File(campaignManifestPath);
  const validationItems = [];
  const queueItems = [];
  const reportItems = [];
  const artifactPaths = [campaignManifestPath];
  for (let index = 0; index < campaign.items.length; index += 1) {
    const item = campaign.items[index];
    const itemDir = path.join(campaignDir, "items", item.id);
    const videoPath = path.join(itemDir, `${item.id}.mp4`);
    const publishPath = path.join(itemDir, "youtube_shorts_publish_manifest.json");
    const renderPath = path.join(itemDir, "short_render_report.json");
    await fs.mkdir(itemDir, { recursive: true });
    await fs.writeFile(videoPath, Buffer.from(`immutable-video-${item.id}`));
    const videoSha256 = await sha256File(videoPath);
    const publish = {
      schema: "goldflow_youtube_shorts_publish_manifest_v1",
      status: "passed",
      campaign_id: campaign.campaign_id,
      short_id: item.id,
      youtube_channel: {
        channel_id: "UCZah1gv3wyUfEIvJdTacWjw",
        expected_name: "Manhwa Joey",
        expected_handle: "@ManhwaJoey",
      },
      video: { path: videoPath, sha256: videoSha256, duration_sec: 10 },
      title: item.packaging.title,
      description: item.packaging.description,
      tags: item.packaging.tags,
      publish_settings: {
        initial_visibility: "private",
        final_visibility: "scheduled",
        schedule_at: item.schedule_at,
        timezone: "UTC",
        made_for_kids: false,
        age_restriction: false,
        altered_content: false,
        comments: "allow_all",
        monetization: "on",
      },
      related_longform: item.related_longform,
      approval: { approved: true, approved_by: "operator", approved_at: new Date().toISOString() },
    };
    await writeJson(publishPath, publish);
    const publishSha256 = await sha256File(publishPath);
    const rendererVersion = "fixture-renderer-v1";
    const render = {
      schema: "goldflow_shorts_story_card_render_report_v1",
      status: "passed",
      created_at: new Date().toISOString(),
      renderer_version: rendererVersion,
      campaign_id: campaign.campaign_id,
      short_id: item.id,
      item_spec_sha256: itemSpecHash(campaign, item, rendererVersion),
      output_video_path: videoPath,
      output_video_sha256: videoSha256,
      youtube_publish_manifest_path: publishPath,
      youtube_publish_manifest_sha256: publishSha256,
      schedule_at: item.schedule_at,
      reading_time_to_runtime_ratio: 2,
    };
    await writeJson(renderPath, render);
    validationItems.push({
      schema: "goldflow_shorts_story_card_item_validation_v1",
      status: "passed",
      short_id: item.id,
      schedule_at: item.schedule_at,
      item_spec_sha256: itemSpecHash(campaign, item, null),
      reading_time_to_runtime_ratio: 2,
    });
    queueItems.push(publish);
    reportItems.push({
      short_id: item.id,
      status: "passed",
      video_path: videoPath,
      video_sha256: videoSha256,
      schedule_at: item.schedule_at,
      reading_ratio: 2,
      report_path: renderPath,
    });
    artifactPaths.push(publishPath, renderPath);
  }
  const dailyCounts = { [date]: 3 };
  const validationPath = path.join(campaignDir, "campaign_validation_report.json");
  const queuePath = path.join(campaignDir, "youtube_shorts_publish_queue.json");
  const campaignReportPath = path.join(campaignDir, "campaign_render_report.json");
  await writeJson(validationPath, {
    schema: "goldflow_shorts_story_card_campaign_validation_v1",
    status: "passed",
    created_at: new Date().toISOString(),
    campaign_manifest_path: campaignManifestPath,
    campaign_manifest_sha256: campaignManifestSha256,
    campaign_id: campaign.campaign_id,
    item_count: campaign.items.length,
    daily_schedule_counts: dailyCounts,
    items: validationItems,
  });
  await writeJson(queuePath, {
    schema: "goldflow_youtube_shorts_publish_queue_v1",
    status: "passed",
    campaign_id: campaign.campaign_id,
    item_count: queueItems.length,
    items: queueItems,
  });
  await writeJson(campaignReportPath, {
    schema: "goldflow_shorts_story_card_campaign_report_v1",
    status: "passed",
    created_at: new Date().toISOString(),
    campaign_manifest_path: campaignManifestPath,
    campaign_manifest_sha256: campaignManifestSha256,
    campaign_id: campaign.campaign_id,
    item_count: reportItems.length,
    passed_count: reportItems.length,
    blocked_count: 0,
    rendered_count: reportItems.length,
    reused_count: 0,
    daily_schedule_counts: dailyCounts,
    publish_queue_path: queuePath,
    items: reportItems,
  });
  artifactPaths.push(validationPath, queuePath, campaignReportPath);
  return {
    campaign,
    campaignDir,
    campaignManifestPath,
    validationPath,
    queuePath,
    campaignReportPath,
    targetId: campaign.items[0].id,
    targetPublishPath: path.join(campaignDir, "items", campaign.items[0].id, "youtube_shorts_publish_manifest.json"),
    targetRenderPath: path.join(campaignDir, "items", campaign.items[0].id, "short_render_report.json"),
    newScheduleAt: `${date}T10:00:00Z`,
    secondScheduleAt: `${date}T11:00:00Z`,
    ledgerPath: path.join(root, "channels", "53rebirth", "shorts_upload_ledger.json"),
    artifactPaths,
    videoPaths: campaign.items.map((item) => path.join(campaignDir, "items", item.id, `${item.id}.mp4`)),
  };
}

async function hashes(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async (filePath) => [filePath, await sha256File(filePath)])));
}

async function expectCliFailure(args, pattern) {
  try {
    await execFile(process.execPath, [helperPath, ...args], { cwd: repoRoot });
    assert.fail("Expected schedule adjustment to fail.");
  } catch (error) {
    assert.equal(error.code, 2);
    assert.match(error.stderr, pattern);
  }
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-shorts-schedule-test-"));
try {
  const fixture = await createFixture(temporaryRoot, "schedule-success");
  const campaignBefore = JSON.parse(await fs.readFile(fixture.campaignManifestPath, "utf8"));
  const videoHashesBefore = await hashes(fixture.videoPaths);
  const { stdout } = await execFile(process.execPath, [
    helperPath,
    "--manifest", fixture.campaignManifestPath,
    "--short-id", fixture.targetId,
    "--schedule-at", fixture.newScheduleAt,
  ], { cwd: repoRoot });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "passed");
  assert.equal(result.previous_schedule_at, campaignBefore.items[0].schedule_at);
  assert.equal(result.schedule_at, fixture.newScheduleAt);
  const campaignAfter = JSON.parse(await fs.readFile(fixture.campaignManifestPath, "utf8"));
  assert.deepEqual(diffPaths(campaignBefore, campaignAfter), ["items.0.schedule_at"]);
  assert.deepEqual(await hashes(fixture.videoPaths), videoHashesBefore);

  const publish = JSON.parse(await fs.readFile(fixture.targetPublishPath, "utf8"));
  const render = JSON.parse(await fs.readFile(fixture.targetRenderPath, "utf8"));
  const validation = JSON.parse(await fs.readFile(fixture.validationPath, "utf8"));
  const queue = JSON.parse(await fs.readFile(fixture.queuePath, "utf8"));
  const campaignReport = JSON.parse(await fs.readFile(fixture.campaignReportPath, "utf8"));
  assert.equal(publish.publish_settings.schedule_at, fixture.newScheduleAt);
  assert.equal(render.schedule_at, fixture.newScheduleAt);
  assert.equal(render.youtube_publish_manifest_sha256, await sha256File(fixture.targetPublishPath));
  assert.equal(render.schedule_adjustments.at(-1).campaign_item_changed_paths[0], "schedule_at");
  assert.equal(render.schedule_adjustments.at(-1).video_sha256_before, render.schedule_adjustments.at(-1).video_sha256_after);
  assert.equal(validation.campaign_manifest_sha256, await sha256File(fixture.campaignManifestPath));
  assert.equal(validation.items[0].schedule_at, fixture.newScheduleAt);
  assert.deepEqual(queue.items[0], publish);
  assert.equal(campaignReport.publish_queue_sha256, await sha256File(fixture.queuePath));
  assert.equal(campaignReport.campaign_validation_report_sha256, await sha256File(fixture.validationPath));
  assert.equal(campaignReport.items[0].report_sha256, await sha256File(fixture.targetRenderPath));
  assert.equal(campaignReport.items[0].publish_manifest_sha256, await sha256File(fixture.targetPublishPath));
  assert.equal(campaignReport.daily_schedule_counts[futureCampaignDate()], 3);

  await writeJson(fixture.ledgerPath, {
    schema: "goldflow_youtube_shorts_upload_ledger_v1",
    status: "passed",
    entries: [{ short_id: fixture.targetId, video_id: "AbCdEf123_-" }],
  });
  const hashesBeforeReceiptRefusal = await hashes(fixture.artifactPaths);
  await expectCliFailure([
    "--manifest", fixture.campaignManifestPath,
    "--short-id", fixture.targetId,
    "--schedule-at", fixture.secondScheduleAt,
  ], /already has a verified receipt/);
  assert.deepEqual(await hashes(fixture.artifactPaths), hashesBeforeReceiptRefusal);

  const rollbackFixture = await createFixture(temporaryRoot, "schedule-rollback");
  const rollbackHashesBefore = await hashes(rollbackFixture.artifactPaths);
  const rollbackVideoHashesBefore = await hashes(rollbackFixture.videoPaths);
  await assert.rejects(
    adjustShortsSchedule({
      manifestPath: rollbackFixture.campaignManifestPath,
      shortId: rollbackFixture.targetId,
      scheduleAt: rollbackFixture.newScheduleAt,
      failAfterWrites: 2,
    }),
    /Injected transaction failure/,
  );
  assert.deepEqual(await hashes(rollbackFixture.artifactPaths), rollbackHashesBefore);
  assert.deepEqual(await hashes(rollbackFixture.videoPaths), rollbackVideoHashesBefore);
  const residualFiles = (await fs.readdir(rollbackFixture.campaignDir, { recursive: true })).filter((entry) => /schedule-adjustment|\.stage-|\.backup-/.test(entry));
  assert.deepEqual(residualFiles, []);

  console.log(JSON.stringify({
    status: "passed",
    tests: 3,
    covered: [
      "schedule-only six-artifact commit with preserved video hashes",
      "receipt-ledger immutability refusal",
      "injected mid-commit rollback to all original hashes",
    ],
  }, null, 2));
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
