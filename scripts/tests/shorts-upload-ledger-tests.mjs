#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const recorderPath = path.join(repoRoot, "scripts", "shorts-record-upload.mjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createFixture(root, { shortId, scheduleAt, videoBytes, campaignId = "fixture-shorts-campaign-v1" }) {
  const campaignDir = path.join(root, "campaign");
  const itemDir = path.join(campaignDir, "items", shortId);
  const videoPath = path.join(itemDir, `${shortId}.mp4`);
  const sourceManifestPath = path.join(root, "source", `${shortId}.json`);
  const publishManifestPath = path.join(itemDir, "youtube_shorts_publish_manifest.json");
  const renderReportPath = path.join(itemDir, "short_render_report.json");
  await fs.mkdir(itemDir, { recursive: true });
  await fs.writeFile(videoPath, videoBytes);
  const videoSha256 = await sha256File(videoPath);
  const channel = {
    channel_id: "UCZah1gv3wyUfEIvJdTacWjw",
    expected_name: "Manhwa Joey",
    expected_handle: "@ManhwaJoey",
  };
  const approval = {
    approved: true,
    approved_by: "operator",
    approval_basis: "Fixture approval",
    approved_at: "2026-08-01T10:00:00Z",
  };
  const relatedLongform = {
    video_id: "W94xrqnsLlY",
    watch_url: "https://youtu.be/W94xrqnsLlY",
    title: "Fixture Longform | Manhwa Recap",
    release_at: "2026-08-02T11:30:00-04:00",
    state_at_plan_time: "scheduled",
  };
  const packaging = {
    title: `Fixture ${shortId} #shorts`,
    description: `Fixture description for ${shortId}\n\n#shorts`,
    tags: ["shorts", "manhwa"],
  };
  await writeJson(sourceManifestPath, {
    schema: "goldflow_youtube_publish_manifest_v1",
    status: "passed",
    title: relatedLongform.title,
  });
  const campaign = {
    schema: "goldflow_shorts_story_card_campaign_v1",
    status: "approved_for_render_and_schedule",
    campaign_id: campaignId,
    output_dir: campaignDir,
    youtube_channel: channel,
    schedule: { timezone: "America/New_York" },
    operator_approval: approval,
    items: [{
      id: shortId,
      schedule_at: scheduleAt,
      source: { source_publish_manifest_path: sourceManifestPath },
      packaging,
      related_longform: relatedLongform,
    }],
  };
  await writeJson(path.join(campaignDir, "shorts_campaign.json"), campaign);
  const publishManifest = {
    schema: "goldflow_youtube_shorts_publish_manifest_v1",
    status: "passed",
    campaign_id: campaignId,
    short_id: shortId,
    youtube_channel: channel,
    video: { path: videoPath, sha256: videoSha256, duration_sec: 10 },
    title: packaging.title,
    description: packaging.description,
    tags: packaging.tags,
    publish_settings: {
      initial_visibility: "private",
      final_visibility: "scheduled",
      schedule_at: scheduleAt,
      timezone: "America/New_York",
      made_for_kids: false,
      age_restriction: false,
      altered_content: false,
      comments: "allow_all",
      monetization: "on",
    },
    related_longform: relatedLongform,
    approval,
  };
  await writeJson(publishManifestPath, publishManifest);
  const publishManifestSha256 = await sha256File(publishManifestPath);
  const sourceHashes = Object.fromEntries([
    "visual_video_sha256",
    "audio_video_sha256",
    "script_sha256",
    "final_qa_sha256",
    "word_timing_sha256",
    "avatar_sha256",
    "brand_contract_sha256",
  ].map((key) => [key, sha256(`${shortId}:${key}`)]));
  await writeJson(renderReportPath, {
    schema: "goldflow_shorts_story_card_render_report_v1",
    status: "passed",
    campaign_id: campaignId,
    short_id: shortId,
    output_video_path: videoPath,
    output_video_sha256: videoSha256,
    youtube_publish_manifest_path: publishManifestPath,
    youtube_publish_manifest_sha256: publishManifestSha256,
    source_hashes: sourceHashes,
  });
  return { publishManifestPath, publishManifest, campaignDir };
}

function receiptArgs({ fixture, ledgerPath, videoId, uploadedAt, savedAt, scheduleAt }) {
  const recordedAt = new Date(Date.parse(savedAt) + 5 * 60 * 1000).toISOString();
  return [
    recorderPath,
    "--publish-manifest", fixture.publishManifestPath,
    "--ledger", ledgerPath,
    "--video-id", videoId,
    "--watch-url", `https://youtube.com/shorts/${videoId}`,
    "--studio-url", `https://studio.youtube.com/video/${videoId}/edit`,
    "--uploaded-at", uploadedAt,
    "--initial-private-verified", "true",
    "--saved-private-at", savedAt,
    "--saved-private-proof", "Studio visibly showed Private after the first save.",
    "--schedule-at", scheduleAt,
    "--timezone", "America/New_York",
    "--channel-verified", "true",
    "--video-id-verified", "true",
    "--title-verified", "true",
    "--description-verified", "true",
    "--tags-verified", "true",
    "--audience-verified", "true",
    "--age-restriction-verified", "true",
    "--altered-content-verified", "true",
    "--comments-verified", "true",
    "--monetization-verified", "true",
    "--schedule-verified", "true",
    "--checks-result", "no_issues",
    "--checks-verified", "true",
    "--recorded-by", "fixture-agent",
    "--recorded-at", recordedAt,
  ];
}

async function runRecorder(args, expectedCode = 0) {
  try {
    const result = await execFile(process.execPath, args, { cwd: repoRoot });
    assert.equal(expectedCode, 0, `Expected recorder failure, received success: ${result.stdout}`);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    assert.equal(error.code, expectedCode, `Unexpected exit code. stdout=${error.stdout} stderr=${error.stderr}`);
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-shorts-ledger-test-"));
try {
  const ledgerPath = path.join(temporaryRoot, "shorts_upload_ledger.json");
  const first = await createFixture(temporaryRoot, {
    shortId: "fixture-short-a",
    scheduleAt: "2026-08-02T14:00:00-04:00",
    videoBytes: Buffer.from("fixture-video-a"),
  });
  const firstArgs = receiptArgs({
    fixture: first,
    ledgerPath,
    videoId: "AbCdEf123_-",
    uploadedAt: "2026-08-02T12:00:00-04:00",
    savedAt: "2026-08-02T12:05:00-04:00",
    scheduleAt: "2026-08-02T14:00:00-04:00",
  });

  const initial = JSON.parse((await runRecorder(firstArgs)).stdout);
  assert.equal(initial.status, "passed");
  assert.equal(initial.reused, false);
  const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
  assert.equal(ledger.schema, "goldflow_youtube_shorts_upload_ledger_v1");
  assert.equal(ledger.entry_count, 1);
  assert.equal(ledger.daily_schedule_counts["2026-08-02"], 1);
  assert.equal(ledger.entries[0].video_id, "AbCdEf123_-");
  assert.equal(ledger.entries[0].saved_private_proof.verified, true);
  assert.equal(ledger.entries[0].checks.result, "no_issues");
  assert.match(ledger.entries[0].source_publish_manifest_sha256, /^[a-f0-9]{64}$/);
  assert.match(ledger.entries[0].publish_manifest_sha256, /^[a-f0-9]{64}$/);

  const idempotent = JSON.parse((await runRecorder(firstArgs)).stdout);
  assert.equal(idempotent.reused, true);
  assert.equal((JSON.parse(await fs.readFile(ledgerPath, "utf8"))).entry_count, 1);

  const conflictingShort = [...firstArgs];
  conflictingShort[conflictingShort.indexOf("--video-id") + 1] = "ZyXwVu987_-";
  conflictingShort[conflictingShort.indexOf("--watch-url") + 1] = "https://youtube.com/shorts/ZyXwVu987_-";
  conflictingShort[conflictingShort.indexOf("--studio-url") + 1] = "https://studio.youtube.com/video/ZyXwVu987_-/edit";
  const shortConflictResult = await runRecorder(conflictingShort, 2);
  assert.match(shortConflictResult.stderr, /already has a conflicting verified receipt/);

  const secondRoot = path.join(temporaryRoot, "second");
  const second = await createFixture(secondRoot, {
    shortId: "fixture-short-b",
    scheduleAt: "2026-08-03T14:00:00-04:00",
    videoBytes: Buffer.from("fixture-video-b"),
    campaignId: "fixture-shorts-campaign-v2",
  });
  const duplicateVideoArgs = receiptArgs({
    fixture: second,
    ledgerPath,
    videoId: "AbCdEf123_-",
    uploadedAt: "2026-08-03T12:00:00-04:00",
    savedAt: "2026-08-03T12:05:00-04:00",
    scheduleAt: "2026-08-03T14:00:00-04:00",
  });
  const duplicateVideoResult = await runRecorder(duplicateVideoArgs, 2);
  assert.match(duplicateVideoResult.stderr, /already bound to fixture-short-a/);

  const originalPublish = await fs.readFile(first.publishManifestPath, "utf8");
  const drifted = { ...first.publishManifest, unexpected_drift_marker: true };
  await writeJson(first.publishManifestPath, drifted);
  const driftResult = await runRecorder(firstArgs, 2);
  assert.match(driftResult.stderr, /does not bind the current Shorts publish manifest hash/);
  await fs.writeFile(first.publishManifestPath, originalPublish, "utf8");

  const forbiddenLedgerArgs = [...firstArgs];
  forbiddenLedgerArgs[forbiddenLedgerArgs.indexOf("--ledger") + 1] = path.join(temporaryRoot, "youtube_upload_ledger.json");
  const forbiddenLedgerResult = await runRecorder(forbiddenLedgerArgs, 2);
  assert.match(forbiddenLedgerResult.stderr, /longform ledger is intentionally out of scope/);

  console.log(JSON.stringify({
    status: "passed",
    tests: 5,
    covered: [
      "atomic first record",
      "idempotent exact replay",
      "conflicting short ID",
      "duplicate YouTube video ID",
      "publish-manifest drift and longform-ledger refusal",
    ],
  }, null, 2));
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
