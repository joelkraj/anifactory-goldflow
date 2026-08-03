#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHORTS_PUBLISH_SCHEMA = "goldflow_youtube_shorts_publish_manifest_v1";
const SHORTS_RENDER_SCHEMA = "goldflow_shorts_story_card_render_report_v1";
const SHORTS_CAMPAIGN_SCHEMA = "goldflow_shorts_story_card_campaign_v1";
const SHORTS_RECEIPT_SCHEMA = "goldflow_youtube_shorts_upload_receipt_v1";
const SHORTS_LEDGER_SCHEMA = "goldflow_youtube_shorts_upload_ledger_v1";
const LONGFORM_PUBLISH_SCHEMA = "goldflow_youtube_publish_manifest_v1";
const DEFAULT_LEDGER_PATH = "/Users/joel/AniFactoryData/channels/53rebirth/shorts_upload_ledger.json";
const EXPECTED_CHANNEL_ID = "UCZah1gv3wyUfEIvJdTacWjw";
const REQUIRED_SOURCE_HASHES = [
  "visual_video_sha256",
  "audio_video_sha256",
  "script_sha256",
  "final_qa_sha256",
  "word_timing_sha256",
  "avatar_sha256",
  "brand_contract_sha256",
];
const REQUIRED_VERIFICATION_FLAGS = [
  ["channel-verified", "active_channel"],
  ["video-id-verified", "video_id"],
  ["title-verified", "title"],
  ["description-verified", "description"],
  ["tags-verified", "tags"],
  ["audience-verified", "audience"],
  ["age-restriction-verified", "age_restriction"],
  ["altered-content-verified", "altered_content"],
  ["comments-verified", "comments"],
  ["monetization-verified", "monetization"],
  ["schedule-verified", "schedule"],
];
const ALLOWED_FLAGS = new Set([
  "publish-manifest",
  "ledger",
  "video-id",
  "watch-url",
  "studio-url",
  "uploaded-at",
  "initial-private-verified",
  "saved-private-at",
  "saved-private-proof",
  "schedule-at",
  "timezone",
  ...REQUIRED_VERIFICATION_FLAGS.map(([flag]) => flag),
  "checks-result",
  "checks-verified",
  "recorded-by",
  "recorded-at",
  "note",
  "dry-run",
  "help",
]);

function usage() {
  return `Usage:
  node scripts/shorts-record-upload.mjs \\
    --publish-manifest <item/youtube_shorts_publish_manifest.json> \\
    --video-id <11-character YouTube id> \\
    --watch-url <https://youtube.com/shorts/...|https://youtu.be/...> \\
    --studio-url <https://studio.youtube.com/video/.../edit> \\
    --uploaded-at <RFC3339 timestamp> \\
    --initial-private-verified true \\
    --saved-private-at <RFC3339 timestamp> \\
    --saved-private-proof <visible Studio evidence> \\
    --schedule-at <exact manifest RFC3339 timestamp> \\
    --timezone <exact manifest IANA timezone> \\
    --channel-verified true --video-id-verified true \\
    --title-verified true --description-verified true --tags-verified true \\
    --audience-verified true --age-restriction-verified true \\
    --altered-content-verified true --comments-verified true \\
    --monetization-verified true --schedule-verified true \\
    --checks-result no_issues --checks-verified true \\
    --recorded-by <name>

Optional: --recorded-at <RFC3339> --note <text> --dry-run true
The ledger defaults to ${DEFAULT_LEDGER_PATH}. A --ledger override must still be named shorts_upload_ledger.json.`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!ALLOWED_FLAGS.has(key)) throw new Error(`Unknown flag: --${key}`);
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

function requireTrue(value, label) {
  if (value !== "true") throw new Error(`${label} must be exactly true.`);
  return true;
}

function optionalBoolean(value, fallback = false) {
  if (value == null) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected true or false, received ${value}.`);
}

function requireRfc3339(value, label) {
  const result = requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(result)) {
    throw new Error(`${label} must be an RFC3339 timestamp with an explicit offset.`);
  }
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is not a valid timestamp.`);
  return { value: result, milliseconds };
}

function requireTimezone(value, label) {
  const result = requireString(value, label);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: result }).format(new Date(0));
  } catch {
    throw new Error(`${label} must be a valid IANA timezone.`);
  }
  return result;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash.`);
  return value;
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`${label} is unreadable at ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is invalid JSON at ${filePath}: ${error.message}`);
  }
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

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(value));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function extractVideoId(urlValue) {
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (hostname === "youtu.be") return parsed.pathname.split("/").filter(Boolean)[0] ?? null;
  if (hostname !== "youtube.com" && hostname !== "m.youtube.com") return null;
  if (parsed.pathname === "/watch") return parsed.searchParams.get("v");
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] === "shorts") return parts[1] ?? null;
  return null;
}

function validateStudioUrl(urlValue, videoId) {
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    return false;
  }
  return parsed.protocol === "https:"
    && parsed.hostname === "studio.youtube.com"
    && parsed.pathname.split("/").filter(Boolean)[0] === "video"
    && parsed.pathname.split("/").filter(Boolean)[1] === videoId;
}

function identityMaterial(entry) {
  return {
    schema: entry.schema,
    campaign_id: entry.campaign_id,
    short_id: entry.short_id,
    channel_id: entry.youtube_channel?.channel_id,
    video_id: entry.video_id,
    watch_url: entry.watch_url,
    studio_url: entry.studio_url,
    uploaded_at: entry.uploaded_at,
    saved_private_proof: entry.saved_private_proof,
    final_visibility: entry.final_visibility,
    scheduled_release: entry.scheduled_release,
    visible_field_verification: entry.visible_field_verification,
    checks: entry.checks,
    publish_approval: entry.publish_approval,
    artifacts: entry.artifacts,
    source_hashes: entry.source_hashes,
  };
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

function summarizeLedger(entries) {
  const daily = {};
  const campaigns = {};
  for (const entry of entries) {
    const date = localDate(entry.scheduled_release.schedule_at, entry.scheduled_release.timezone);
    daily[date] = (daily[date] ?? 0) + 1;
    campaigns[entry.campaign_id] = (campaigns[entry.campaign_id] ?? 0) + 1;
  }
  return {
    daily_schedule_counts: Object.fromEntries(Object.entries(daily).sort(([a], [b]) => a.localeCompare(b))),
    campaign_entry_counts: Object.fromEntries(Object.entries(campaigns).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function validateExistingLedger(ledger, ledgerPath, channelId) {
  if (ledger.schema !== SHORTS_LEDGER_SCHEMA) throw new Error(`Existing ledger schema is not ${SHORTS_LEDGER_SCHEMA}.`);
  if (ledger.status !== "passed") throw new Error("Existing Shorts ledger is not passed.");
  if (ledger.channel !== "53rebirth") throw new Error(`Existing Shorts ledger channel is ${ledger.channel ?? "missing"}, not 53rebirth.`);
  if (ledger.channel_id !== channelId) throw new Error("Existing Shorts ledger channel ID conflicts with the publish manifest.");
  if (path.resolve(ledger.ledger_path ?? "") !== ledgerPath) throw new Error("Existing Shorts ledger path binding is stale.");
  if (!Array.isArray(ledger.entries)) throw new Error("Existing Shorts ledger entries are missing.");
  if (ledger.entry_count !== ledger.entries.length) throw new Error("Existing Shorts ledger entry_count is stale.");
  const shortIds = new Set();
  const videoIds = new Set();
  const publishHashes = new Set();
  const outputHashes = new Set();
  for (const entry of ledger.entries) {
    if (entry?.schema !== SHORTS_RECEIPT_SCHEMA || entry?.status !== "passed") throw new Error("Existing Shorts ledger contains an invalid receipt entry.");
    requireString(entry.short_id, "existing entry short_id");
    requireString(entry.video_id, "existing entry video_id");
    if (!/^[A-Za-z0-9_-]{11}$/.test(entry.video_id)) throw new Error(`Existing receipt has an invalid YouTube video ID for ${entry.short_id}.`);
    if (entry.youtube_channel?.channel_id !== channelId) throw new Error(`Existing receipt channel ID conflicts for ${entry.short_id}.`);
    if (extractVideoId(entry.watch_url) !== entry.video_id || !validateStudioUrl(entry.studio_url, entry.video_id)) {
      throw new Error(`Existing receipt URLs conflict with the video ID for ${entry.short_id}.`);
    }
    requireRfc3339(entry.uploaded_at, `existing entry ${entry.short_id} uploaded_at`);
    requireRfc3339(entry.saved_private_proof?.saved_at, `existing entry ${entry.short_id} saved_private_proof.saved_at`);
    requireString(entry.saved_private_proof?.evidence, `existing entry ${entry.short_id} saved-private evidence`);
    if (entry.saved_private_proof?.verified !== true) throw new Error(`Existing receipt lacks private-first verification for ${entry.short_id}.`);
    if (entry.final_visibility !== "scheduled" || entry.scheduled_release?.verified !== true) throw new Error(`Existing receipt is not a verified scheduled result for ${entry.short_id}.`);
    requireRfc3339(entry.scheduled_release?.schedule_at, `existing entry ${entry.short_id} schedule_at`);
    requireTimezone(entry.scheduled_release?.timezone, `existing entry ${entry.short_id} timezone`);
    if (REQUIRED_VERIFICATION_FLAGS.some(([, field]) => entry.visible_field_verification?.[field] !== true)
      || entry.visible_field_verification?.initial_private !== true) {
      throw new Error(`Existing receipt field verification is incomplete for ${entry.short_id}.`);
    }
    if (entry.checks?.verified !== true || entry.checks?.result !== "no_issues") throw new Error(`Existing receipt checks are incomplete for ${entry.short_id}.`);
    if (entry.publish_approval?.approved !== true || !clean(entry.publish_approval?.approved_by)) throw new Error(`Existing receipt schedule approval is incomplete for ${entry.short_id}.`);
    requireSha256(entry.publish_manifest_sha256, "existing entry publish_manifest_sha256");
    requireSha256(entry.source_publish_manifest_sha256, "existing entry source_publish_manifest_sha256");
    requireSha256(entry.artifacts?.campaign_manifest_sha256, "existing entry campaign manifest hash");
    requireSha256(entry.artifacts?.render_report_sha256, "existing entry render report hash");
    requireSha256(entry.artifacts?.shorts_publish_manifest_sha256, "existing entry Shorts publish manifest hash");
    requireSha256(entry.artifacts?.source_longform_publish_manifest_sha256, "existing entry source publish manifest hash");
    requireSha256(entry.artifacts?.short_video_sha256, "existing entry short video hash");
    if (entry.publish_manifest_sha256 !== entry.artifacts.shorts_publish_manifest_sha256
      || entry.source_publish_manifest_sha256 !== entry.artifacts.source_longform_publish_manifest_sha256) {
      throw new Error(`Existing receipt duplicates conflicting manifest hashes for ${entry.short_id}.`);
    }
    for (const key of REQUIRED_SOURCE_HASHES) requireSha256(entry.source_hashes?.[key], `existing entry ${entry.short_id} source_hashes.${key}`);
    requireSha256(entry.receipt_identity_sha256, "existing entry receipt_identity_sha256");
    if (entry.receipt_identity_sha256 !== sha256Json(identityMaterial(entry))) throw new Error(`Existing receipt identity hash is stale for ${entry.short_id}.`);
    if (shortIds.has(entry.short_id)) throw new Error(`Existing ledger repeats short ID ${entry.short_id}.`);
    if (videoIds.has(entry.video_id)) throw new Error(`Existing ledger repeats YouTube video ID ${entry.video_id}.`);
    if (publishHashes.has(entry.publish_manifest_sha256)) throw new Error(`Existing ledger repeats Shorts publish manifest hash ${entry.publish_manifest_sha256}.`);
    if (outputHashes.has(entry.artifacts.short_video_sha256)) throw new Error(`Existing ledger repeats rendered Short hash ${entry.artifacts.short_video_sha256}.`);
    shortIds.add(entry.short_id);
    videoIds.add(entry.video_id);
    publishHashes.add(entry.publish_manifest_sha256);
    outputHashes.add(entry.artifacts.short_video_sha256);
  }
}

async function buildReceipt(flags) {
  const publishManifestPath = path.resolve(requireString(flags["publish-manifest"], "--publish-manifest"));
  if (path.basename(publishManifestPath) !== "youtube_shorts_publish_manifest.json") {
    throw new Error("--publish-manifest must name youtube_shorts_publish_manifest.json.");
  }
  const itemDir = path.dirname(publishManifestPath);
  const campaignDir = path.resolve(itemDir, "..", "..");
  const campaignManifestPath = path.join(campaignDir, "shorts_campaign.json");
  const renderReportPath = path.join(itemDir, "short_render_report.json");
  const [manifest, campaign, renderReport] = await Promise.all([
    readJson(publishManifestPath, "Shorts publish manifest"),
    readJson(campaignManifestPath, "Shorts campaign manifest"),
    readJson(renderReportPath, "Shorts render report"),
  ]);
  if (manifest.schema !== SHORTS_PUBLISH_SCHEMA || manifest.status !== "passed") throw new Error("Shorts publish manifest is not passed v1 truth.");
  if (campaign.schema !== SHORTS_CAMPAIGN_SCHEMA || campaign.status !== "approved_for_render_and_schedule") throw new Error("Shorts campaign manifest is not approved production truth.");
  if (renderReport.schema !== SHORTS_RENDER_SCHEMA || renderReport.status !== "passed") throw new Error("Shorts render report is not passed v1 truth.");

  const shortId = requireString(manifest.short_id, "publish manifest short_id");
  const campaignId = requireString(manifest.campaign_id, "publish manifest campaign_id");
  if (campaign.campaign_id !== campaignId || renderReport.campaign_id !== campaignId) throw new Error("Campaign ID differs across Shorts artifacts.");
  if (renderReport.short_id !== shortId) throw new Error("Short ID differs between render report and publish manifest.");
  if (path.resolve(campaign.output_dir ?? "") !== campaignDir) throw new Error("Campaign output_dir does not own the publish manifest.");
  const expectedPublishPath = path.join(campaignDir, "items", shortId, "youtube_shorts_publish_manifest.json");
  if (expectedPublishPath !== publishManifestPath) throw new Error("Publish manifest is outside its campaign short ID path.");

  const campaignItem = campaign.items?.find((item) => item?.id === shortId);
  if (!campaignItem) throw new Error(`Campaign item ${shortId} is missing.`);
  if (campaign.items.filter((item) => item?.id === shortId).length !== 1) throw new Error(`Campaign item ${shortId} is duplicated.`);
  if (campaignItem.schedule_at !== manifest.publish_settings?.schedule_at) throw new Error("Campaign and publish-manifest schedule timestamps differ.");
  if (campaign.schedule?.timezone !== manifest.publish_settings?.timezone) throw new Error("Campaign and publish-manifest timezones differ.");
  if (campaignItem.packaging?.title !== manifest.title || campaignItem.packaging?.description !== manifest.description || !sameJson(campaignItem.packaging?.tags, manifest.tags)) {
    throw new Error("Campaign packaging differs from the Shorts publish manifest.");
  }
  if (!sameJson(campaign.youtube_channel, manifest.youtube_channel)) throw new Error("Campaign channel identity differs from the Shorts publish manifest.");
  if (manifest.youtube_channel?.channel_id !== EXPECTED_CHANNEL_ID) throw new Error("Shorts publish manifest is not bound to the 53rebirth Manhwa Joey channel ID.");
  if (manifest.publish_settings?.initial_visibility !== "private" || manifest.publish_settings?.final_visibility !== "scheduled") {
    throw new Error("Shorts publish manifest must require private-first scheduling.");
  }
  if (manifest.approval?.approved !== true
    || !clean(manifest.approval?.approved_by)
    || !clean(manifest.approval?.approved_at)
    || campaign.operator_approval?.approved !== true
    || !sameJson(manifest.approval, campaign.operator_approval)) {
    throw new Error("Current operator schedule approval is missing or differs across campaign artifacts.");
  }

  const publishManifestSha256 = await sha256File(publishManifestPath);
  if (path.resolve(renderReport.youtube_publish_manifest_path ?? "") !== publishManifestPath
    || renderReport.youtube_publish_manifest_sha256 !== publishManifestSha256) {
    throw new Error("Render report does not bind the current Shorts publish manifest hash.");
  }
  const shortVideoPath = path.resolve(requireString(manifest.video?.path, "publish manifest video.path"));
  const shortVideoSha256 = await sha256File(shortVideoPath);
  if (manifest.video?.sha256 !== shortVideoSha256
    || path.resolve(renderReport.output_video_path ?? "") !== shortVideoPath
    || renderReport.output_video_sha256 !== shortVideoSha256) {
    throw new Error("Rendered Short path/hash is stale across publish and render artifacts.");
  }
  const sourceHashes = {};
  for (const key of REQUIRED_SOURCE_HASHES) sourceHashes[key] = requireSha256(renderReport.source_hashes?.[key], `render report source_hashes.${key}`);

  const sourcePublishManifestPath = path.resolve(requireString(campaignItem.source?.source_publish_manifest_path, "campaign source publish manifest path"));
  const sourcePublishManifest = await readJson(sourcePublishManifestPath, "source longform publish manifest");
  if (sourcePublishManifest.schema !== LONGFORM_PUBLISH_SCHEMA || sourcePublishManifest.status !== "passed") {
    throw new Error("Source longform publish manifest is not passed production truth.");
  }
  if (!sameJson(campaignItem.related_longform, manifest.related_longform)) {
    throw new Error("Related longform truth differs between the ledger-backed campaign and Shorts publish manifest.");
  }

  const videoId = requireString(flags["video-id"], "--video-id");
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("--video-id must be an 11-character YouTube video ID.");
  const watchUrl = requireString(flags["watch-url"], "--watch-url");
  if (extractVideoId(watchUrl) !== videoId) throw new Error("--watch-url is not a supported YouTube URL for --video-id.");
  const studioUrl = requireString(flags["studio-url"], "--studio-url");
  if (!validateStudioUrl(studioUrl, videoId)) throw new Error("--studio-url must be the Studio video URL for --video-id.");

  const uploadedAt = requireRfc3339(flags["uploaded-at"], "--uploaded-at");
  requireTrue(flags["initial-private-verified"], "--initial-private-verified");
  const savedPrivateAt = requireRfc3339(flags["saved-private-at"], "--saved-private-at");
  const savedPrivateProof = requireString(flags["saved-private-proof"], "--saved-private-proof");
  if (savedPrivateProof.length < 12) throw new Error("--saved-private-proof must describe the visible Studio evidence.");
  const scheduleAt = requireRfc3339(flags["schedule-at"], "--schedule-at");
  const timezone = requireTimezone(flags.timezone, "--timezone");
  if (scheduleAt.value !== manifest.publish_settings.schedule_at) throw new Error("--schedule-at must exactly match the approved Shorts publish manifest.");
  if (timezone !== manifest.publish_settings.timezone) throw new Error("--timezone must exactly match the approved Shorts publish manifest.");
  if (uploadedAt.milliseconds > savedPrivateAt.milliseconds) throw new Error("--saved-private-at cannot precede --uploaded-at.");
  if (savedPrivateAt.milliseconds >= scheduleAt.milliseconds) throw new Error("Private-first save must occur before the scheduled release.");

  const visibleFieldVerification = {};
  for (const [flag, field] of REQUIRED_VERIFICATION_FLAGS) visibleFieldVerification[field] = requireTrue(flags[flag], `--${flag}`);
  const checksResult = requireString(flags["checks-result"], "--checks-result");
  if (checksResult !== "no_issues") throw new Error("--checks-result must be no_issues; do not record a scheduled pass through unresolved checks.");
  const checksVerified = requireTrue(flags["checks-verified"], "--checks-verified");
  const recordedBy = requireString(flags["recorded-by"], "--recorded-by");
  const recordedAt = flags["recorded-at"]
    ? requireRfc3339(flags["recorded-at"], "--recorded-at")
    : requireRfc3339(new Date().toISOString(), "recorded_at");
  if (recordedAt.milliseconds < savedPrivateAt.milliseconds) throw new Error("--recorded-at cannot precede the private-first proof.");
  const sourcePublishManifestSha256 = await sha256File(sourcePublishManifestPath);
  const campaignManifestSha256 = await sha256File(campaignManifestPath);
  const renderReportSha256 = await sha256File(renderReportPath);

  const receipt = {
    schema: SHORTS_RECEIPT_SCHEMA,
    status: "passed",
    campaign_id: campaignId,
    short_id: shortId,
    youtube_channel: manifest.youtube_channel,
    video_id: videoId,
    watch_url: watchUrl,
    studio_url: studioUrl,
    uploaded_at: uploadedAt.value,
    saved_private_proof: {
      verified: true,
      saved_at: savedPrivateAt.value,
      evidence: savedPrivateProof,
    },
    final_visibility: "scheduled",
    scheduled_release: {
      verified: true,
      schedule_at: scheduleAt.value,
      timezone,
    },
    visible_field_verification: {
      ...visibleFieldVerification,
      initial_private: true,
      expected_title: manifest.title,
      expected_description_sha256: sha256Text(manifest.description),
      expected_tags_sha256: sha256Json(manifest.tags),
    },
    checks: {
      verified: checksVerified,
      result: checksResult,
    },
    publish_approval: manifest.approval,
    publish_manifest_path: publishManifestPath,
    publish_manifest_sha256: publishManifestSha256,
    source_publish_manifest_path: sourcePublishManifestPath,
    source_publish_manifest_sha256: sourcePublishManifestSha256,
    artifacts: {
      campaign_manifest_path: campaignManifestPath,
      campaign_manifest_sha256: campaignManifestSha256,
      render_report_path: renderReportPath,
      render_report_sha256: renderReportSha256,
      shorts_publish_manifest_path: publishManifestPath,
      shorts_publish_manifest_sha256: publishManifestSha256,
      source_longform_publish_manifest_path: sourcePublishManifestPath,
      source_longform_publish_manifest_sha256: sourcePublishManifestSha256,
      short_video_path: shortVideoPath,
      short_video_sha256: shortVideoSha256,
    },
    source_hashes: sourceHashes,
    recorded_by: recordedBy,
    recorded_at: recordedAt.value,
    note: clean(flags.note) || null,
  };
  receipt.receipt_identity_sha256 = sha256Json(identityMaterial(receipt));
  return receipt;
}

async function readLedgerIfPresent(ledgerPath) {
  try {
    return JSON.parse(await fs.readFile(ledgerPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`Existing Shorts ledger is invalid JSON: ${error.message}`);
    throw error;
  }
}

function mergeReceipt(existingLedger, receipt, ledgerPath) {
  const channelId = receipt.youtube_channel.channel_id;
  if (existingLedger) validateExistingLedger(existingLedger, ledgerPath, channelId);
  const entries = existingLedger ? [...existingLedger.entries] : [];
  const sameShort = entries.find((entry) => entry.short_id === receipt.short_id);
  if (sameShort) {
    if (sameShort.receipt_identity_sha256 === receipt.receipt_identity_sha256) {
      return { ledger: existingLedger, receipt: sameShort, reused: true };
    }
    throw new Error(`Short ID ${receipt.short_id} already has a conflicting verified receipt.`);
  }
  const sameVideo = entries.find((entry) => entry.video_id === receipt.video_id);
  if (sameVideo) throw new Error(`YouTube video ID ${receipt.video_id} is already bound to ${sameVideo.short_id}.`);
  const samePublishHash = entries.find((entry) => entry.publish_manifest_sha256 === receipt.publish_manifest_sha256);
  if (samePublishHash) throw new Error(`Shorts publish manifest hash is already bound to ${samePublishHash.short_id}.`);
  const sameOutputHash = entries.find((entry) => entry.artifacts.short_video_sha256 === receipt.artifacts.short_video_sha256);
  if (sameOutputHash) throw new Error(`Rendered Short hash is already bound to ${sameOutputHash.short_id}.`);
  const sameCampaign = entries.find((entry) => entry.campaign_id === receipt.campaign_id);
  if (sameCampaign && sameCampaign.artifacts.campaign_manifest_sha256 !== receipt.artifacts.campaign_manifest_sha256) {
    throw new Error(`Campaign ID ${receipt.campaign_id} already has a conflicting campaign manifest hash.`);
  }
  entries.push(receipt);
  entries.sort((left, right) => left.scheduled_release.schedule_at.localeCompare(right.scheduled_release.schedule_at) || left.short_id.localeCompare(right.short_id));
  const now = new Date().toISOString();
  const summary = summarizeLedger(entries);
  return {
    reused: false,
    receipt,
    ledger: {
      schema: SHORTS_LEDGER_SCHEMA,
      status: "passed",
      channel: "53rebirth",
      channel_id: channelId,
      ledger_path: ledgerPath,
      created_at: existingLedger?.created_at ?? now,
      updated_at: now,
      entry_count: entries.length,
      ...summary,
      entries,
    },
  };
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
    const directoryHandle = await fs.open(path.dirname(filePath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function withLedgerLock(ledgerPath, callback) {
  const lockPath = `${ledgerPath}.lock`;
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  let lockHandle;
  try {
    lockHandle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Shorts ledger is locked by another recorder: ${lockPath}`);
    throw error;
  }
  try {
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`, "utf8");
    await lockHandle.sync();
    return await callback();
  } finally {
    await lockHandle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}

export async function recordShortsUpload(flags) {
  const ledgerPath = path.resolve(flags.ledger ?? DEFAULT_LEDGER_PATH);
  if (path.basename(ledgerPath) !== "shorts_upload_ledger.json") {
    throw new Error("Shorts receipts may only be written to a file named shorts_upload_ledger.json; the longform ledger is intentionally out of scope.");
  }
  const dryRun = optionalBoolean(flags["dry-run"], false);
  if (dryRun) {
    const receipt = await buildReceipt(flags);
    const existingLedger = await readLedgerIfPresent(ledgerPath);
    const result = mergeReceipt(existingLedger, receipt, ledgerPath);
    return {
      status: "passed",
      dry_run: true,
      reused: result.reused,
      would_append: !result.reused,
      ledger_path: ledgerPath,
      entry_count: result.ledger?.entry_count ?? existingLedger?.entry_count ?? 0,
      short_id: result.receipt.short_id,
      video_id: result.receipt.video_id,
      schedule_at: result.receipt.scheduled_release.schedule_at,
      receipt_identity_sha256: result.receipt.receipt_identity_sha256,
    };
  }
  return withLedgerLock(ledgerPath, async () => {
    const receipt = await buildReceipt(flags);
    const existingLedger = await readLedgerIfPresent(ledgerPath);
    const result = mergeReceipt(existingLedger, receipt, ledgerPath);
    if (!result.reused) await writeJsonAtomic(ledgerPath, result.ledger);
    return {
      status: "passed",
      dry_run: false,
      reused: result.reused,
      ledger_path: ledgerPath,
      entry_count: result.ledger.entry_count,
      short_id: result.receipt.short_id,
      video_id: result.receipt.video_id,
      watch_url: result.receipt.watch_url,
      schedule_at: result.receipt.scheduled_release.schedule_at,
      timezone: result.receipt.scheduled_release.timezone,
      receipt_identity_sha256: result.receipt.receipt_identity_sha256,
    };
  });
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help === "true") {
    console.log(usage());
    return;
  }
  const result = await recordShortsUpload(flags);
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "blocked", error: error.message }, null, 2));
    process.exitCode = 2;
  });
}
