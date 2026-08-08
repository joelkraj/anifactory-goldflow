#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CAMPAIGN_SCHEMA = "goldflow_shorts_story_card_campaign_v1";
const VALIDATION_SCHEMA = "goldflow_shorts_story_card_campaign_validation_v1";
const PUBLISH_SCHEMA = "goldflow_youtube_shorts_publish_manifest_v1";
const RENDER_SCHEMA = "goldflow_shorts_story_card_render_report_v1";
const QUEUE_SCHEMA = "goldflow_youtube_shorts_publish_queue_v1";
const CAMPAIGN_REPORT_SCHEMA = "goldflow_shorts_story_card_campaign_report_v1";
const RECEIPT_LEDGER_SCHEMA = "goldflow_youtube_shorts_upload_ledger_v1";
const AUDIT_SCHEMA = "goldflow_shorts_schedule_adjustment_audit_v1";
const TRANSACTION_SCHEMA = "goldflow_shorts_schedule_adjustment_transaction_v1";

function usage() {
  return `Usage:
  node scripts/shorts-adjust-schedule.mjs \\
    --manifest <campaign/shorts_campaign.json> \\
    --short-id <campaign short id> \\
    --schedule-at <future RFC3339 timestamp with explicit offset>`;
}

function parseArgs(argv) {
  const allowed = new Set(["manifest", "short-id", "schedule-at", "help"]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error(`Unknown flag: --${key}`);
    if (Object.hasOwn(parsed, key)) throw new Error(`Duplicate flag: --${key}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requireString(value, label) {
  const result = clean(value);
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function parseRfc3339(value, label) {
  const result = requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(result)) {
    throw new Error(`${label} must be RFC3339 with an explicit Z or ±HH:MM offset.`);
  }
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is not a valid timestamp.`);
  return { value: result, milliseconds };
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash.`);
  return value;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256JsonCompact(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function readJsonArtifact(filePath, label) {
  let bytes;
  try {
    bytes = await fs.readFile(filePath);
  } catch (error) {
    throw new Error(`${label} is unreadable at ${filePath}: ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON at ${filePath}: ${error.message}`);
  }
  return { path: filePath, bytes, sha256: sha256Bytes(bytes), data };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone(value) {
  return structuredClone(value);
}

function diffPaths(left, right, prefix = "") {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const paths = [];
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) paths.push(...diffPaths(left[index], right[index], `${prefix}${prefix ? "." : ""}${index}`));
    return paths;
  }
  if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
    const paths = [];
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) paths.push(...diffPaths(left[key], right[key], `${prefix}${prefix ? "." : ""}${key}`));
    return paths;
  }
  return [prefix || "<root>"];
}

function itemSpec(campaign, item, rendererVersion = null) {
  return {
    schema: "goldflow_shorts_story_card_item_spec_v1",
    ...(rendererVersion ? { renderer_version: rendererVersion } : {}),
    campaign_id: campaign.campaign_id,
    item,
    brand: campaign.brand,
    canvas: campaign.canvas,
    reading_wpm: campaign.reading_wpm,
  };
}

function itemSpecHash(campaign, item, rendererVersion = null) {
  return sha256JsonCompact(itemSpec(campaign, item, rendererVersion));
}

function validateTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Campaign timezone is invalid: ${timeZone}`);
  }
}

function localDate(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateRange(startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(endDate ?? "")) {
    throw new Error("Campaign schedule start_date/end_date must be YYYY-MM-DD.");
  }
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  if (start > end) throw new Error("Campaign schedule start_date is after end_date.");
  const values = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) values.push(cursor.toISOString().slice(0, 10));
  return values;
}

function validateCampaignSchedules(campaign) {
  if (!Array.isArray(campaign.items) || campaign.items.length === 0) throw new Error("Campaign has no items.");
  const timeZone = requireString(campaign.schedule?.timezone, "campaign.schedule.timezone");
  validateTimeZone(timeZone);
  const expectedDates = dateRange(campaign.schedule?.start_date, campaign.schedule?.end_date);
  const allowedDates = new Set(expectedDates);
  const instantOwners = new Map();
  const dailyCounts = Object.fromEntries(expectedDates.map((date) => [date, 0]));
  const ids = new Set();
  for (const item of campaign.items) {
    const shortId = requireString(item?.id, "campaign item id");
    if (ids.has(shortId)) throw new Error(`Campaign repeats short ID ${shortId}.`);
    ids.add(shortId);
    const parsed = parseRfc3339(item.schedule_at, `${shortId}.schedule_at`);
    if (instantOwners.has(parsed.milliseconds)) throw new Error(`Duplicate schedule instant for ${shortId} and ${instantOwners.get(parsed.milliseconds)}.`);
    instantOwners.set(parsed.milliseconds, shortId);
    const date = localDate(parsed.value, timeZone);
    if (!allowedDates.has(date)) throw new Error(`${shortId} schedules outside campaign date range on ${date}.`);
    dailyCounts[date] += 1;
    const releaseAt = clean(item.related_longform?.release_at);
    if (releaseAt) {
      const releaseMs = parseRfc3339(releaseAt, `${shortId}.related_longform.release_at`).milliseconds;
      const blackoutMinutes = Number(campaign.schedule?.longform_blackout_minutes ?? 90);
      if (!Number.isFinite(blackoutMinutes) || blackoutMinutes < 0) throw new Error("Campaign longform blackout minutes are invalid.");
      if (Math.abs(parsed.milliseconds - releaseMs) < blackoutMinutes * 60 * 1000) {
        throw new Error(`${shortId} collides with its related longform blackout window.`);
      }
    }
  }
  for (const [date, count] of Object.entries(dailyCounts)) {
    if (count < 2 || count > 4) throw new Error(`Campaign must retain 2–4 Shorts on ${date}; found ${count}.`);
  }
  return dailyCounts;
}

function inferReceiptLedgerPath(campaignDir) {
  const marker = `${path.sep}shorts_campaigns${path.sep}`;
  const markerIndex = campaignDir.lastIndexOf(marker);
  if (markerIndex < 1) throw new Error("Campaign must live beneath a channel shorts_campaigns directory so the receipt ledger can be checked.");
  return path.join(campaignDir.slice(0, markerIndex), "shorts_upload_ledger.json");
}

async function readReceiptLedger(ledgerPath, shortId) {
  try {
    await fs.access(ledgerPath);
  } catch (error) {
    if (error.code === "ENOENT") return { path: ledgerPath, sha256: null, exists: false };
    throw error;
  }
  const artifact = await readJsonArtifact(ledgerPath, "Shorts upload receipt ledger");
  if (artifact.data.schema !== RECEIPT_LEDGER_SCHEMA || !Array.isArray(artifact.data.entries)) {
    throw new Error("Existing Shorts receipt ledger has an invalid schema or entries collection.");
  }
  const receipt = artifact.data.entries.find((entry) => entry?.short_id === shortId);
  if (receipt) throw new Error(`Short ${shortId} already has a verified receipt in ${ledgerPath}; its schedule metadata is immutable.`);
  return { path: ledgerPath, sha256: artifact.sha256, exists: true };
}

async function withExclusiveLock(lockPath, callback) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another operation holds ${lockPath}.`);
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`, "utf8");
    await handle.sync();
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}

async function readCurrentArtifacts(manifestPath, shortId) {
  const campaignDir = path.dirname(manifestPath);
  const campaignArtifact = await readJsonArtifact(manifestPath, "Shorts campaign manifest");
  const campaign = campaignArtifact.data;
  if (campaign.schema !== CAMPAIGN_SCHEMA || campaign.status !== "approved_for_render_and_schedule") throw new Error("Campaign manifest is not approved production truth.");
  if (path.resolve(campaign.output_dir ?? "") !== campaignDir) throw new Error("Campaign output_dir does not match --manifest.");
  const targetIndexes = campaign.items.map((item, index) => item?.id === shortId ? index : -1).filter((index) => index >= 0);
  if (targetIndexes.length !== 1) throw new Error(`--short-id must match exactly one campaign item; found ${targetIndexes.length}.`);
  const targetIndex = targetIndexes[0];
  const currentDailyCounts = validateCampaignSchedules(campaign);
  const validationPath = path.join(campaignDir, "campaign_validation_report.json");
  const queuePath = path.join(campaignDir, "youtube_shorts_publish_queue.json");
  const campaignReportPath = path.join(campaignDir, "campaign_render_report.json");
  const [validationArtifact, queueArtifact, campaignReportArtifact] = await Promise.all([
    readJsonArtifact(validationPath, "campaign validation report"),
    readJsonArtifact(queuePath, "Shorts publish queue"),
    readJsonArtifact(campaignReportPath, "campaign render report"),
  ]);
  const validation = validationArtifact.data;
  const queue = queueArtifact.data;
  const campaignReport = campaignReportArtifact.data;
  if (validation.schema !== VALIDATION_SCHEMA || validation.status !== "passed") throw new Error("Campaign validation report is not passed v1 truth.");
  if (queue.schema !== QUEUE_SCHEMA || queue.status !== "passed") throw new Error("Shorts publish queue is not passed v1 truth.");
  if (campaignReport.schema !== CAMPAIGN_REPORT_SCHEMA || campaignReport.status !== "passed") throw new Error("Campaign render report is not passed v1 truth.");
  for (const [label, value] of [["validation", validation], ["queue", queue], ["campaign report", campaignReport]]) {
    if (value.campaign_id !== campaign.campaign_id) throw new Error(`${label} campaign ID is stale.`);
    if (value.item_count !== campaign.items.length) throw new Error(`${label} item_count is stale.`);
  }
  if (path.resolve(validation.campaign_manifest_path ?? "") !== manifestPath || validation.campaign_manifest_sha256 !== campaignArtifact.sha256) {
    throw new Error("Campaign validation report does not bind the current campaign manifest hash.");
  }
  if (path.resolve(campaignReport.campaign_manifest_path ?? "") !== manifestPath || campaignReport.campaign_manifest_sha256 !== campaignArtifact.sha256) {
    throw new Error("Campaign render report does not bind the current campaign manifest hash.");
  }
  if (!sameJson(validation.daily_schedule_counts, currentDailyCounts) || !sameJson(campaignReport.daily_schedule_counts, currentDailyCounts)) {
    throw new Error("Campaign daily schedule counts are stale.");
  }
  if (!Array.isArray(validation.items) || validation.items.length !== campaign.items.length
    || !Array.isArray(queue.items) || queue.items.length !== campaign.items.length
    || !Array.isArray(campaignReport.items) || campaignReport.items.length !== campaign.items.length) {
    throw new Error("Campaign aggregate item arrays are incomplete.");
  }

  const itemArtifacts = [];
  const validationSpecStyles = new Map();
  for (let index = 0; index < campaign.items.length; index += 1) {
    const item = campaign.items[index];
    const itemDir = path.join(campaignDir, "items", item.id);
    const publishPath = path.join(itemDir, "youtube_shorts_publish_manifest.json");
    const renderPath = path.join(itemDir, "short_render_report.json");
    const [publishArtifact, renderArtifact] = await Promise.all([
      readJsonArtifact(publishPath, `${item.id} publish manifest`),
      readJsonArtifact(renderPath, `${item.id} render report`),
    ]);
    const publish = publishArtifact.data;
    const render = renderArtifact.data;
    if (publish.schema !== PUBLISH_SCHEMA || publish.status !== "passed" || publish.short_id !== item.id || publish.campaign_id !== campaign.campaign_id) {
      throw new Error(`${item.id} publish manifest identity/status is stale.`);
    }
    if (render.schema !== RENDER_SCHEMA || render.status !== "passed" || render.short_id !== item.id || render.campaign_id !== campaign.campaign_id) {
      throw new Error(`${item.id} render report identity/status is stale.`);
    }
    if (publish.publish_settings?.schedule_at !== item.schedule_at || render.schedule_at !== item.schedule_at) throw new Error(`${item.id} schedule metadata is inconsistent.`);
    if (path.resolve(render.youtube_publish_manifest_path ?? "") !== publishPath || render.youtube_publish_manifest_sha256 !== publishArtifact.sha256) {
      throw new Error(`${item.id} render report does not bind its current publish manifest.`);
    }
    if (path.resolve(render.output_video_path ?? "") !== path.resolve(publish.video?.path ?? "") || render.output_video_sha256 !== publish.video?.sha256) {
      throw new Error(`${item.id} rendered video identity differs across report and publish manifest.`);
    }
    requireSha256(render.output_video_sha256, `${item.id} output_video_sha256`);
    const expectedRenderSpecHash = itemSpecHash(campaign, item, clean(render.renderer_version) || null);
    if (render.item_spec_sha256 !== expectedRenderSpecHash) throw new Error(`${item.id} render item spec hash is stale.`);
    if (!sameJson(queue.items[index], publish)) throw new Error(`${item.id} queue entry differs from its publish manifest.`);
    const validationRow = validation.items[index];
    if (validationRow?.short_id !== item.id || validationRow?.schedule_at !== item.schedule_at) throw new Error(`${item.id} campaign validation row is stale.`);
    const legacyValidationHash = itemSpecHash(campaign, item, null);
    const versionedValidationHash = expectedRenderSpecHash;
    if (validationRow.item_spec_sha256 === legacyValidationHash) validationSpecStyles.set(item.id, null);
    else if (validationRow.item_spec_sha256 === versionedValidationHash) validationSpecStyles.set(item.id, clean(render.renderer_version) || null);
    else throw new Error(`${item.id} campaign validation item spec hash is stale.`);
    const summary = campaignReport.items[index];
    if (summary?.short_id !== item.id
      || summary.status !== render.status
      || path.resolve(summary.video_path ?? "") !== path.resolve(render.output_video_path)
      || summary.video_sha256 !== render.output_video_sha256
      || summary.schedule_at !== item.schedule_at
      || path.resolve(summary.report_path ?? "") !== renderPath) {
      throw new Error(`${item.id} campaign report summary is stale.`);
    }
    if (summary.report_sha256 && summary.report_sha256 !== renderArtifact.sha256) throw new Error(`${item.id} campaign report render hash is stale.`);
    if (summary.publish_manifest_sha256 && summary.publish_manifest_sha256 !== publishArtifact.sha256) throw new Error(`${item.id} campaign report publish hash is stale.`);
    itemArtifacts.push({ item, itemDir, publishArtifact, renderArtifact, validationRow, summary });
  }
  if (campaignReport.publish_queue_sha256 && campaignReport.publish_queue_sha256 !== queueArtifact.sha256) throw new Error("Campaign report publish queue hash is stale.");
  if (campaignReport.campaign_validation_report_sha256 && campaignReport.campaign_validation_report_sha256 !== validationArtifact.sha256) {
    throw new Error("Campaign report validation hash is stale.");
  }
  const passedCount = itemArtifacts.filter(({ renderArtifact }) => renderArtifact.data.status === "passed").length;
  if (campaignReport.passed_count !== passedCount
    || campaignReport.blocked_count !== itemArtifacts.length - passedCount
    || campaignReport.rendered_count + campaignReport.reused_count !== itemArtifacts.length) {
    throw new Error("Campaign report completion counts are stale.");
  }
  return {
    campaignDir,
    campaignArtifact,
    validationArtifact,
    queueArtifact,
    campaignReportArtifact,
    itemArtifacts,
    validationSpecStyles,
    targetIndex,
    target: itemArtifacts[targetIndex],
  };
}

async function fsyncPath(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicSingle(filePath, bytes) {
  const stat = await fs.stat(filePath).catch(() => null);
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", stat ? stat.mode & 0o777 : 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
    await fsyncPath(path.dirname(filePath));
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function commitJsonTransaction(updates, campaignDir, adjustmentId, failAfterWrites = null) {
  const journalPath = path.join(campaignDir, ".shorts-schedule-adjustment-transaction.json");
  try {
    await fs.access(journalPath);
    throw new Error(`Unresolved schedule-adjustment transaction exists: ${journalPath}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const records = [];
  let committed = false;
  const cleanupWarnings = [];
  try {
    for (const update of updates) {
      const currentHash = await sha256File(update.path);
      if (currentHash !== update.beforeSha256) throw new Error(`Concurrent metadata change detected at ${update.path}.`);
      const stat = await fs.stat(update.path);
      const stagedPath = path.join(path.dirname(update.path), `.${path.basename(update.path)}.stage-${adjustmentId}`);
      const backupPath = path.join(path.dirname(update.path), `.${path.basename(update.path)}.backup-${adjustmentId}`);
      const handle = await fs.open(stagedPath, "wx", stat.mode & 0o777);
      try {
        await handle.writeFile(update.afterBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      records.push({ ...update, stagedPath, backupPath });
    }
    const journal = {
      schema: TRANSACTION_SCHEMA,
      state: "prepared",
      adjustment_id: adjustmentId,
      created_at: new Date().toISOString(),
      files: records.map((record) => ({
        path: record.path,
        before_sha256: record.beforeSha256,
        after_sha256: record.afterSha256,
        staged_path: record.stagedPath,
        backup_path: record.backupPath,
      })),
    };
    await writeAtomicSingle(journalPath, jsonBytes(journal));
    for (const record of records) {
      await fs.copyFile(record.path, record.backupPath, fsConstants.COPYFILE_EXCL);
      await fsyncPath(record.backupPath);
    }
    await writeAtomicSingle(journalPath, jsonBytes({ ...journal, state: "backed_up" }));
    let writeCount = 0;
    for (const record of records) {
      await fs.rename(record.stagedPath, record.path);
      await fsyncPath(path.dirname(record.path));
      writeCount += 1;
      if (Number.isInteger(failAfterWrites) && writeCount === failAfterWrites) throw new Error(`Injected transaction failure after ${writeCount} writes.`);
    }
    for (const record of records) {
      if (await sha256File(record.path) !== record.afterSha256) throw new Error(`Committed metadata hash mismatch at ${record.path}.`);
    }
    await writeAtomicSingle(journalPath, jsonBytes({ ...journal, state: "committed", committed_at: new Date().toISOString() }));
    committed = true;
    for (const record of records) {
      try {
        await fs.unlink(record.backupPath);
      } catch (error) {
        cleanupWarnings.push(`${record.backupPath}: ${error.message}`);
      }
    }
    try {
      await fs.unlink(journalPath);
    } catch (error) {
      cleanupWarnings.push(`${journalPath}: ${error.message}`);
    }
    await fsyncPath(campaignDir);
  } catch (error) {
    if (committed) {
      cleanupWarnings.push(`post-commit cleanup: ${error.message}`);
      return { cleanupWarnings };
    }
    const rollbackErrors = [];
    for (const record of records) {
      try {
        await fs.access(record.backupPath);
        await fs.rename(record.backupPath, record.path);
        await fsyncPath(path.dirname(record.path));
      } catch (rollbackError) {
        if (rollbackError.code !== "ENOENT") rollbackErrors.push(`${record.path}: ${rollbackError.message}`);
      }
      await fs.unlink(record.stagedPath).catch(() => {});
    }
    for (const record of records) {
      try {
        if (await sha256File(record.path) !== record.beforeSha256) rollbackErrors.push(`${record.path}: rollback hash mismatch`);
      } catch (rollbackError) {
        rollbackErrors.push(`${record.path}: ${rollbackError.message}`);
      }
    }
    await fs.unlink(journalPath).catch(() => {});
    if (rollbackErrors.length) throw new Error(`${error.message} Rollback failed: ${rollbackErrors.join("; ")}`);
    throw error;
  } finally {
    for (const record of records) {
      await fs.unlink(record.stagedPath).catch(() => {});
      if (committed) await fs.unlink(record.backupPath).catch(() => {});
    }
  }
  return { cleanupWarnings };
}

function appendAudit(document, audit) {
  const prior = Array.isArray(document.schedule_adjustments) ? document.schedule_adjustments : [];
  document.schedule_adjustments = [...prior, audit];
}

async function buildAdjustment(current, newScheduleAt, receiptLedger) {
  const adjustedAt = new Date().toISOString();
  const campaign = current.campaignArtifact.data;
  const targetItem = campaign.items[current.targetIndex];
  const oldScheduleAt = targetItem.schedule_at;
  if (oldScheduleAt === newScheduleAt) throw new Error("--schedule-at is already the current schedule; no adjustment is needed.");
  const newCampaign = clone(campaign);
  newCampaign.items[current.targetIndex].schedule_at = newScheduleAt;
  const campaignDiff = diffPaths(campaign, newCampaign);
  const expectedCampaignDiff = `items.${current.targetIndex}.schedule_at`;
  if (!sameJson(campaignDiff, [expectedCampaignDiff])) throw new Error(`Campaign mutation is not schedule-only: ${campaignDiff.join(", ")}`);
  const itemDiff = diffPaths(targetItem, newCampaign.items[current.targetIndex]);
  if (!sameJson(itemDiff, ["schedule_at"])) throw new Error(`Campaign item mutation is not schedule-only: ${itemDiff.join(", ")}`);
  const dailyCounts = validateCampaignSchedules(newCampaign);
  const newCampaignBytes = jsonBytes(newCampaign);
  const newCampaignSha256 = sha256Bytes(newCampaignBytes);

  const newPublish = clone(current.target.publishArtifact.data);
  newPublish.publish_settings.schedule_at = newScheduleAt;
  const publishDiff = diffPaths(current.target.publishArtifact.data, newPublish);
  if (!sameJson(publishDiff, ["publish_settings.schedule_at"])) throw new Error(`Publish manifest mutation is not schedule-only: ${publishDiff.join(", ")}`);
  const newPublishBytes = jsonBytes(newPublish);
  const newPublishSha256 = sha256Bytes(newPublishBytes);
  const videoPath = path.resolve(newPublish.video.path);
  const videoSha256 = await sha256File(videoPath);
  if (videoSha256 !== current.target.publishArtifact.data.video.sha256
    || videoSha256 !== current.target.renderArtifact.data.output_video_sha256
    || videoSha256 !== current.target.summary.video_sha256) {
    throw new Error("Selected rendered Short bytes/hash are stale before adjustment.");
  }

  const auditSeed = {
    schema: AUDIT_SCHEMA,
    campaign_id: campaign.campaign_id,
    short_id: targetItem.id,
    previous_schedule_at: oldScheduleAt,
    schedule_at: newScheduleAt,
    campaign_manifest_before_sha256: current.campaignArtifact.sha256,
    campaign_manifest_after_sha256: newCampaignSha256,
    publish_manifest_before_sha256: current.target.publishArtifact.sha256,
    publish_manifest_after_sha256: newPublishSha256,
    render_report_before_sha256: current.target.renderArtifact.sha256,
    video_path: videoPath,
    video_sha256_before: videoSha256,
    video_sha256_after: videoSha256,
    campaign_item_changed_paths: ["schedule_at"],
    receipt_ledger_path: receiptLedger.path,
    receipt_ledger_sha256: receiptLedger.sha256,
    receipt_absence_verified: true,
  };
  const adjustmentId = sha256JsonCompact(auditSeed).slice(0, 20);
  const audit = {
    ...auditSeed,
    adjustment_id: adjustmentId,
    adjusted_at: adjustedAt,
    adjusted_by: "shorts-adjust-schedule.mjs",
    disposition: "schedule_metadata_only_video_bytes_preserved",
  };

  const newRender = clone(current.target.renderArtifact.data);
  newRender.schedule_at = newScheduleAt;
  newRender.item_spec_sha256 = itemSpecHash(newCampaign, newCampaign.items[current.targetIndex], clean(newRender.renderer_version) || null);
  newRender.youtube_publish_manifest_sha256 = newPublishSha256;
  newRender.updated_at = adjustedAt;
  appendAudit(newRender, audit);
  const newRenderBytes = jsonBytes(newRender);
  const newRenderSha256 = sha256Bytes(newRenderBytes);

  const validationStyle = current.validationSpecStyles.get(targetItem.id);
  const newValidation = clone(current.validationArtifact.data);
  newValidation.campaign_manifest_sha256 = newCampaignSha256;
  newValidation.daily_schedule_counts = dailyCounts;
  newValidation.items[current.targetIndex].schedule_at = newScheduleAt;
  newValidation.items[current.targetIndex].item_spec_sha256 = itemSpecHash(newCampaign, newCampaign.items[current.targetIndex], validationStyle);
  newValidation.updated_at = adjustedAt;
  const extendedAudit = { ...audit, render_report_after_sha256: newRenderSha256 };
  appendAudit(newValidation, extendedAudit);
  const newValidationBytes = jsonBytes(newValidation);
  const newValidationSha256 = sha256Bytes(newValidationBytes);

  const newQueue = clone(current.queueArtifact.data);
  newQueue.items[current.targetIndex] = newPublish;
  newQueue.item_count = newQueue.items.length;
  newQueue.status = newQueue.items.every((item) => item.status === "passed") ? "passed" : "blocked";
  const queueDiff = diffPaths(current.queueArtifact.data, newQueue);
  const expectedQueueDiff = `items.${current.targetIndex}.publish_settings.schedule_at`;
  if (!sameJson(queueDiff, [expectedQueueDiff])) throw new Error(`Publish queue mutation is not the embedded schedule-only change: ${queueDiff.join(", ")}`);
  const newQueueBytes = jsonBytes(newQueue);
  const newQueueSha256 = sha256Bytes(newQueueBytes);

  const reportHashes = {};
  const publishHashes = {};
  const effectiveReports = current.itemArtifacts.map(({ renderArtifact }, index) => index === current.targetIndex ? newRender : renderArtifact.data);
  for (let index = 0; index < current.itemArtifacts.length; index += 1) {
    const itemId = current.itemArtifacts[index].item.id;
    reportHashes[itemId] = index === current.targetIndex ? newRenderSha256 : current.itemArtifacts[index].renderArtifact.sha256;
    publishHashes[itemId] = index === current.targetIndex ? newPublishSha256 : current.itemArtifacts[index].publishArtifact.sha256;
  }
  const newCampaignReport = clone(current.campaignReportArtifact.data);
  newCampaignReport.campaign_manifest_sha256 = newCampaignSha256;
  newCampaignReport.daily_schedule_counts = dailyCounts;
  newCampaignReport.item_count = effectiveReports.length;
  newCampaignReport.passed_count = effectiveReports.filter((report) => report.status === "passed").length;
  newCampaignReport.blocked_count = effectiveReports.length - newCampaignReport.passed_count;
  newCampaignReport.status = newCampaignReport.blocked_count === 0 && newQueue.status === "passed" ? "passed" : "blocked";
  newCampaignReport.publish_queue_sha256 = newQueueSha256;
  newCampaignReport.campaign_validation_report_sha256 = newValidationSha256;
  newCampaignReport.items[current.targetIndex].schedule_at = newScheduleAt;
  for (let index = 0; index < newCampaignReport.items.length; index += 1) {
    const itemId = newCampaignReport.items[index].short_id;
    newCampaignReport.items[index].report_sha256 = reportHashes[itemId];
    newCampaignReport.items[index].publish_manifest_sha256 = publishHashes[itemId];
  }
  newCampaignReport.artifact_hashes = {
    campaign_manifest_sha256: newCampaignSha256,
    campaign_validation_report_sha256: newValidationSha256,
    publish_queue_sha256: newQueueSha256,
    item_render_report_sha256s: reportHashes,
    item_publish_manifest_sha256s: publishHashes,
  };
  newCampaignReport.updated_at = adjustedAt;
  appendAudit(newCampaignReport, {
    ...extendedAudit,
    campaign_validation_report_before_sha256: current.validationArtifact.sha256,
    campaign_validation_report_after_sha256: newValidationSha256,
    publish_queue_before_sha256: current.queueArtifact.sha256,
    publish_queue_after_sha256: newQueueSha256,
  });
  const newCampaignReportBytes = jsonBytes(newCampaignReport);
  const newCampaignReportSha256 = sha256Bytes(newCampaignReportBytes);

  if (newRender.output_video_sha256 !== videoSha256 || newPublish.video.sha256 !== videoSha256 || newCampaignReport.items[current.targetIndex].video_sha256 !== videoSha256) {
    throw new Error("Schedule adjustment changed or detached the selected video hash.");
  }
  if (!sameJson(newQueue.items[current.targetIndex], newPublish)) throw new Error("Adjusted queue does not contain the exact adjusted publish manifest.");
  if (newRender.youtube_publish_manifest_sha256 !== newPublishSha256) throw new Error("Adjusted render report publish hash is stale.");
  if (newValidation.campaign_manifest_sha256 !== newCampaignSha256 || newCampaignReport.campaign_manifest_sha256 !== newCampaignSha256) {
    throw new Error("Adjusted aggregate campaign hashes are stale.");
  }

  const updates = [
    { path: current.campaignArtifact.path, beforeSha256: current.campaignArtifact.sha256, afterBytes: newCampaignBytes, afterSha256: newCampaignSha256 },
    { path: current.target.publishArtifact.path, beforeSha256: current.target.publishArtifact.sha256, afterBytes: newPublishBytes, afterSha256: newPublishSha256 },
    { path: current.target.renderArtifact.path, beforeSha256: current.target.renderArtifact.sha256, afterBytes: newRenderBytes, afterSha256: newRenderSha256 },
    { path: current.validationArtifact.path, beforeSha256: current.validationArtifact.sha256, afterBytes: newValidationBytes, afterSha256: newValidationSha256 },
    { path: current.queueArtifact.path, beforeSha256: current.queueArtifact.sha256, afterBytes: newQueueBytes, afterSha256: newQueueSha256 },
    { path: current.campaignReportArtifact.path, beforeSha256: current.campaignReportArtifact.sha256, afterBytes: newCampaignReportBytes, afterSha256: newCampaignReportSha256 },
  ];
  return {
    adjustmentId,
    audit,
    updates,
    videoPath,
    videoSha256,
    result: {
      status: "passed",
      adjustment_id: adjustmentId,
      campaign_id: campaign.campaign_id,
      short_id: targetItem.id,
      previous_schedule_at: oldScheduleAt,
      schedule_at: newScheduleAt,
      timezone: campaign.schedule.timezone,
      daily_schedule_counts: dailyCounts,
      campaign_manifest_sha256: newCampaignSha256,
      publish_manifest_sha256: newPublishSha256,
      render_report_sha256: newRenderSha256,
      campaign_validation_report_sha256: newValidationSha256,
      publish_queue_sha256: newQueueSha256,
      campaign_report_sha256: newCampaignReportSha256,
      video_path: videoPath,
      video_sha256: videoSha256,
      receipt_ledger_checked: receiptLedger.path,
    },
  };
}

export async function adjustShortsSchedule({ manifestPath, shortId, scheduleAt, nowMs = Date.now(), failAfterWrites = null }) {
  const resolvedManifestPath = path.resolve(requireString(manifestPath, "--manifest"));
  if (path.basename(resolvedManifestPath) !== "shorts_campaign.json") throw new Error("--manifest must name shorts_campaign.json.");
  const resolvedShortId = requireString(shortId, "--short-id");
  if (!/^[a-z0-9][a-z0-9-]{2,159}$/.test(resolvedShortId)) throw new Error("--short-id is not a safe campaign ID.");
  const parsedSchedule = parseRfc3339(scheduleAt, "--schedule-at");
  if (parsedSchedule.milliseconds <= nowMs) throw new Error("--schedule-at must be in the future.");
  const campaignDir = path.dirname(resolvedManifestPath);
  const receiptLedgerPath = inferReceiptLedgerPath(campaignDir);
  const campaignLockPath = path.join(campaignDir, ".shorts-schedule-adjustment.lock");
  return withExclusiveLock(campaignLockPath, async () => withExclusiveLock(`${receiptLedgerPath}.lock`, async () => {
    const receiptLedger = await readReceiptLedger(receiptLedgerPath, resolvedShortId);
    const current = await readCurrentArtifacts(resolvedManifestPath, resolvedShortId);
    const adjustment = await buildAdjustment(current, parsedSchedule.value, receiptLedger);
    const transactionResult = await commitJsonTransaction(adjustment.updates, campaignDir, adjustment.adjustmentId, failAfterWrites);
    const finalVideoSha256 = await sha256File(adjustment.videoPath);
    if (finalVideoSha256 !== adjustment.videoSha256) throw new Error("Rendered Short bytes changed during metadata commit.");
    for (const update of adjustment.updates) {
      if (await sha256File(update.path) !== update.afterSha256) throw new Error(`Post-commit hash verification failed at ${update.path}.`);
    }
    return {
      ...adjustment.result,
      ...(transactionResult.cleanupWarnings.length ? { cleanup_warnings: transactionResult.cleanupWarnings } : {}),
    };
  }));
}

export async function previewShortsScheduleAdjustment({ manifestPath, shortId, scheduleAt, nowMs = Date.now() }) {
  const resolvedManifestPath = path.resolve(requireString(manifestPath, "--manifest"));
  if (path.basename(resolvedManifestPath) !== "shorts_campaign.json") throw new Error("--manifest must name shorts_campaign.json.");
  const resolvedShortId = requireString(shortId, "--short-id");
  if (!/^[a-z0-9][a-z0-9-]{2,159}$/.test(resolvedShortId)) throw new Error("--short-id is not a safe campaign ID.");
  const parsedSchedule = parseRfc3339(scheduleAt, "--schedule-at");
  if (parsedSchedule.milliseconds <= nowMs) throw new Error("--schedule-at must be in the future.");
  const campaignDir = path.dirname(resolvedManifestPath);
  const receiptLedgerPath = inferReceiptLedgerPath(campaignDir);
  const receiptLedger = await readReceiptLedger(receiptLedgerPath, resolvedShortId);
  const current = await readCurrentArtifacts(resolvedManifestPath, resolvedShortId);
  const adjustment = await buildAdjustment(current, parsedSchedule.value, receiptLedger);
  return {
    ...adjustment.result,
    preview_only: true,
    would_update_paths: adjustment.updates.map((update) => update.path),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === "true") {
    console.log(usage());
    return;
  }
  const result = await adjustShortsSchedule({
    manifestPath: args.manifest,
    shortId: args["short-id"],
    scheduleAt: args["schedule-at"],
  });
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "blocked", error: error.message }, null, 2));
    process.exitCode = 2;
  });
}
