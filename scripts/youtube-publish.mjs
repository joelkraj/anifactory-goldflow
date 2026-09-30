#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { sha256File } from "./lib/file-hash.mjs";
import {
  YOUTUBE_PACKAGING_SPEC_SCHEMA,
  YOUTUBE_PINNED_COMMENT_RECEIPT_SCHEMA,
  YOUTUBE_PUBLISH_MANIFEST_SCHEMA,
  YOUTUBE_UPLOAD_RECEIPT_SCHEMA,
  validateYoutubePackagingSpec,
  validateYoutubePinnedCommentReceipt,
  validateYoutubeUploadReceipt,
  youtubeTextSha256,
} from "./lib/youtube-publish-contract.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const action = process.argv[2] ?? "";
const flags = parseFlags(process.argv.slice(3));

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function isTrue(value) {
  return /^(true|1|yes)$/i.test(String(value ?? ""));
}

function clean(value) {
  return String(value ?? "").trim();
}

function requiredFlag(name, value) {
  if (!clean(value)) throw new Error(`Missing required --${name}.`);
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

function episodeDirectory() {
  if (flags["episode-dir"]) return path.resolve(flags["episode-dir"]);
  requiredFlag("channel", flags.channel);
  requiredFlag("week", flags.week);
  requiredFlag("episode", flags.episode);
  return path.join(
    dataRoot,
    "channels",
    flags.channel,
    "weekly_runs",
    flags.week,
    "episodes",
    flags.episode,
  );
}

function channelDirectoryForEpisode(episodeDir, identity) {
  const resolved = path.resolve(episodeDir);
  const parts = resolved.split(path.sep);
  const channelsIndex = parts.lastIndexOf("channels");
  const channel = clean(identity?.channel);
  if (channelsIndex >= 0 && parts[channelsIndex + 1] && (!channel || parts[channelsIndex + 1] === channel)) {
    return path.join(path.sep, ...parts.slice(1, channelsIndex + 2));
  }
  // Isolated fixtures and diagnostics must never write into the real data root.
  return resolved;
}

async function findFilesRecursive(rootDir, predicate) {
  const matches = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && predicate(entry.name, entryPath)) matches.push(entryPath);
    }
  }
  return matches.sort();
}

function scheduleDateKey(scheduleAt) {
  const value = clean(scheduleAt);
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

async function rebuildChannelUploadLedger(channelDir, channelOverride = null) {
  const weeklyRunsDir = path.join(channelDir, "weekly_runs");
  const scanRoot = await fs.stat(weeklyRunsDir)
    .then((stat) => stat.isDirectory() ? weeklyRunsDir : channelDir)
    .catch(() => channelDir);
  const receiptPaths = await findFilesRecursive(
    scanRoot,
    (name) => /^youtube_upload_receipt_.+\.json$/.test(name),
  );
  const entries = [];
  for (const receiptPath of receiptPaths) {
    const receipt = await readJson(receiptPath);
    if (!receipt || receipt.schema !== YOUTUBE_UPLOAD_RECEIPT_SCHEMA || receipt.status !== "passed") continue;
    const episodeDir = path.dirname(receiptPath);
    const identity = await readJson(path.join(episodeDir, "run_identity.json"));
    const episode = receipt.episode ?? identity?.episode ?? path.basename(episodeDir);
    const manifestPath = path.join(episodeDir, `youtube_publish_manifest_${episode}.json`);
    const manifest = await readJson(manifestPath);
    entries.push({
      channel: clean(identity?.channel) || clean(manifest?.channel) || clean(channelOverride) || path.basename(channelDir),
      series: clean(identity?.series) || null,
      week: clean(identity?.week) || null,
      episode,
      episode_dir: episodeDir,
      video_id: clean(receipt.video_id),
      watch_url: clean(receipt.watch_url),
      studio_url: clean(receipt.studio_url) || null,
      title: clean(manifest?.title) || null,
      visibility: clean(receipt.visibility),
      initial_visibility: clean(receipt.initial_visibility),
      schedule_at: clean(receipt.schedule_at) || null,
      schedule_date: scheduleDateKey(receipt.schedule_at),
      recorded_at: clean(receipt.recorded_at),
      recorded_by: clean(receipt.recorded_by),
      video_sha256: clean(manifest?.video?.sha256) || null,
      thumbnail_sha256: clean(manifest?.thumbnail?.sha256) || null,
      manifest_sha256: clean(receipt.manifest_sha256) || null,
      receipt_path: receiptPath,
      receipt_sha256: await sha256File(receiptPath),
    });
  }
  const scheduleChangePaths = await findFilesRecursive(
    scanRoot,
    (name) => /^youtube_schedule_change_receipt_.+\.json$/.test(name),
  );
  const latestScheduleChangeByVideo = new Map();
  for (const scheduleChangePath of scheduleChangePaths) {
    const change = await readJson(scheduleChangePath);
    if (change?.schema !== "goldflow_youtube_schedule_change_receipt_v1" || change?.status !== "passed" || change?.verified !== true) continue;
    const videoId = clean(change.video_id);
    if (!videoId || !clean(change.schedule_at)) continue;
    const previous = latestScheduleChangeByVideo.get(videoId);
    if (!previous || clean(previous.change.recorded_at) < clean(change.recorded_at)) {
      latestScheduleChangeByVideo.set(videoId, { change, scheduleChangePath });
    }
  }
  for (const entry of entries) {
    const latest = latestScheduleChangeByVideo.get(entry.video_id);
    if (!latest) continue;
    entry.original_schedule_at = entry.schedule_at;
    entry.visibility = "scheduled";
    entry.schedule_at = clean(latest.change.schedule_at);
    entry.schedule_date = scheduleDateKey(entry.schedule_at);
    entry.schedule_change_receipt_path = latest.scheduleChangePath;
    entry.schedule_change_receipt_sha256 = await sha256File(latest.scheduleChangePath);
  }
  entries.sort((a, b) => {
    const aTime = a.schedule_at || a.recorded_at || "";
    const bTime = b.schedule_at || b.recorded_at || "";
    return aTime.localeCompare(bTime) || a.video_id.localeCompare(b.video_id);
  });
  const scheduledByDate = new Map();
  for (const entry of entries) {
    if (entry.visibility !== "scheduled" || !entry.schedule_date) continue;
    const sameDay = scheduledByDate.get(entry.schedule_date) ?? [];
    sameDay.push(entry);
    scheduledByDate.set(entry.schedule_date, sameDay);
  }
  const scheduleConflicts = [...scheduledByDate.entries()]
    .filter(([, sameDay]) => sameDay.length > 1)
    .map(([date, sameDay]) => ({
      date,
      video_ids: sameDay.map((entry) => entry.video_id),
      schedule_times: sameDay.map((entry) => entry.schedule_at),
    }));
  const ledger = {
    schema: "goldflow_youtube_upload_ledger_v1",
    status: "passed",
    channel: clean(channelOverride) || entries[0]?.channel || path.basename(channelDir),
    updated_at: new Date().toISOString(),
    channel_dir: channelDir,
    entry_count: entries.length,
    schedule_conflicts: scheduleConflicts,
    entries,
  };
  const ledgerPath = path.join(channelDir, "youtube_upload_ledger.json");
  await writeJson(ledgerPath, ledger);
  return { ledgerPath, ledger };
}

async function episodeContext() {
  const episodeDir = episodeDirectory();
  const identityPath = path.join(episodeDir, "run_identity.json");
  const identity = await readJson(identityPath);
  if (!identity) throw new Error(`Missing or invalid run identity: ${identityPath}`);
  const episode = flags.episode ?? identity.episode ?? path.basename(episodeDir);
  return { episodeDir, identity, identityPath, episode };
}

async function packagingInputs(episodeDir, episode) {
  const packagePath = path.join(episodeDir, `upload_packaging_${episode}.md`);
  const specPath = path.join(episodeDir, `youtube_packaging_spec_${episode}.json`);
  if (!(await exists(packagePath))) throw new Error(`Missing upload package: ${packagePath}`);
  const [markdown, spec] = await Promise.all([
    fs.readFile(packagePath, "utf8"),
    readJson(specPath),
  ]);
  if (!spec) throw new Error(`Missing or invalid packaging spec: ${specPath}`);
  if (spec.schema !== YOUTUBE_PACKAGING_SPEC_SCHEMA) {
    throw new Error(`Unsupported packaging spec schema: ${spec.schema ?? "missing"}`);
  }
  const thumbnailPath = path.resolve(episodeDir, clean(spec.thumbnail_final_path));
  if (!(await exists(thumbnailPath))) throw new Error(`Missing final thumbnail: ${thumbnailPath}`);
  const [metadata, stat] = await Promise.all([
    sharp(thumbnailPath).metadata(),
    fs.stat(thumbnailPath),
  ]);
  return {
    packagePath,
    specPath,
    markdown,
    spec,
    thumbnailPath,
    thumbnailMetadata: {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    },
    thumbnailBytes: stat.size,
  };
}

function packagingValidation(inputs, options = {}) {
  return validateYoutubePackagingSpec(inputs.spec, {
    markdown: inputs.markdown,
    thumbnailMetadata: inputs.thumbnailMetadata,
    thumbnailBytes: inputs.thumbnailBytes,
    ...options,
  });
}

async function approvePackaging() {
  const { episodeDir, episode } = await episodeContext();
  if (!isTrue(flags.approve)) throw new Error("Packaging approval requires --approve true.");
  requiredFlag("approved-by", flags["approved-by"]);
  const inputs = await packagingInputs(episodeDir, episode);
  const approvedSpec = {
    ...inputs.spec,
    status: "approved",
    approved_by: clean(flags["approved-by"]),
    approved_at: new Date().toISOString(),
    approval_note: clean(flags.note) || "Title, thumbnail, description, and pinned-comment package reviewed.",
  };
  const validation = validateYoutubePackagingSpec(approvedSpec, {
    markdown: inputs.markdown,
    thumbnailMetadata: inputs.thumbnailMetadata,
    thumbnailBytes: inputs.thumbnailBytes,
  });
  if (validation.status !== "passed") {
    console.log(JSON.stringify({ status: "blocked", blockers: validation.blockers }, null, 2));
    process.exitCode = 2;
    return;
  }
  await writeJson(inputs.specPath, approvedSpec);
  console.log(JSON.stringify({
    status: "passed",
    packaging_spec_path: inputs.specPath,
    selected_title: approvedSpec.selected_title,
    selected_thumbnail_candidate_id: approvedSpec.selected_thumbnail_candidate_id,
  }, null, 2));
}

async function prepareManifest() {
  const { episodeDir, identity, identityPath, episode } = await episodeContext();
  const inputs = await packagingInputs(episodeDir, episode);
  const validation = packagingValidation(inputs);
  if (validation.status !== "passed") {
    console.log(JSON.stringify({ status: "blocked", blockers: validation.blockers }, null, 2));
    process.exitCode = 2;
    return;
  }

  const finalQaPath = path.join(episodeDir, `final_qa_${episode}.json`);
  const finalQa = await readJson(finalQaPath);
  if (!finalQa || clean(finalQa.status) !== "passed") {
    throw new Error(`Passed final QA required: ${finalQaPath}`);
  }
  const videoPath = path.resolve(finalQa.final_video_path ?? "");
  if (!(await exists(videoPath))) throw new Error(`Final upload video missing: ${videoPath}`);
  const [videoStat, videoSha256] = await Promise.all([
    fs.stat(videoPath),
    sha256File(videoPath),
  ]);
  if (videoSha256 !== clean(finalQa.final_video_sha256)) {
    throw new Error("Final video hash no longer matches final QA.");
  }

  const selectedThumbnail = validation.selected_thumbnail_candidate;
  const sourcePaths = [
    identityPath,
    finalQaPath,
    inputs.packagePath,
    inputs.specPath,
    inputs.thumbnailPath,
  ];
  const sourceHashes = Object.fromEntries(await Promise.all(
    sourcePaths.map(async (sourcePath) => [sourcePath, await sha256File(sourcePath)]),
  ));
  const manifestPath = path.join(episodeDir, `youtube_publish_manifest_${episode}.json`);
  const manifest = {
    schema: YOUTUBE_PUBLISH_MANIFEST_SCHEMA,
    status: "passed",
    episode,
    channel: identity.channel ?? null,
    youtube_channel: inputs.spec.youtube_channel,
    prepared_at: new Date().toISOString(),
    prepared_by: clean(flags["prepared-by"]) || "goldflow",
    source_hashes: sourceHashes,
    packaging_spec_path: inputs.specPath,
    packaging_spec_sha256: sourceHashes[inputs.specPath],
    upload_package_path: inputs.packagePath,
    video: {
      path: videoPath,
      sha256: videoSha256,
      bytes: videoStat.size,
    },
    title: clean(inputs.spec.selected_title),
    description: clean(inputs.spec.description),
    tags: [...new Set((inputs.spec.tags ?? []).map(clean).filter(Boolean))],
    thumbnail: {
      path: inputs.thumbnailPath,
      sha256: sourceHashes[inputs.thumbnailPath],
      bytes: inputs.thumbnailBytes,
      width: inputs.thumbnailMetadata.width,
      height: inputs.thumbnailMetadata.height,
      format: inputs.thumbnailMetadata.format,
      candidate_id: selectedThumbnail.id,
      main_text: clean(selectedThumbnail.main_text),
      subjects: selectedThumbnail.subjects,
      labels: selectedThumbnail.labels ?? [],
      arrows: selectedThumbnail.arrows ?? [],
    },
    pinned_comment: {
      text: clean(inputs.spec.pinned_comment?.text),
      text_sha256: youtubeTextSha256(inputs.spec.pinned_comment?.text),
      betrayal_choice: clean(inputs.spec.pinned_comment?.betrayal_choice),
    },
    publish_settings: {
      ...inputs.spec.publish_settings,
      automatic_chapters: inputs.spec.publish_settings?.automatic_chapters ?? false,
    },
    studio_handoff: {
      url: "https://studio.youtube.com/",
      upload_private_first: true,
      verify_active_channel_before_upload: true,
      public_or_scheduled_release_requires_operator_confirmation: true,
      pinned_comment_requires_separate_operator_confirmation: true,
      browser_skill: "youtube-studio-publish",
    },
  };
  await writeJson(manifestPath, manifest);
  console.log(JSON.stringify({
    status: "passed",
    manifest_path: manifestPath,
    video_path: videoPath,
    thumbnail_path: inputs.thumbnailPath,
    title: manifest.title,
    next_action: "Use the youtube-studio-publish skill to upload privately and record the verified result.",
  }, null, 2));
}

async function recordUpload() {
  const { episodeDir, identity, episode } = await episodeContext();
  const manifestPath = path.join(episodeDir, `youtube_publish_manifest_${episode}.json`);
  const manifest = await readJson(manifestPath);
  if (!manifest || manifest.schema !== YOUTUBE_PUBLISH_MANIFEST_SCHEMA || manifest.status !== "passed") {
    throw new Error(`Passed YouTube publish manifest required: ${manifestPath}`);
  }
  requiredFlag("video-id", flags["video-id"]);
  requiredFlag("watch-url", flags["watch-url"]);
  requiredFlag("visibility", flags.visibility);
  requiredFlag("recorded-by", flags["recorded-by"]);
  const visibility = clean(flags.visibility).toLowerCase();
  const nonPrivate = visibility !== "private";
  const receiptPath = path.join(episodeDir, `youtube_upload_receipt_${episode}.json`);
  const receipt = {
    schema: YOUTUBE_UPLOAD_RECEIPT_SCHEMA,
    status: "passed",
    episode,
    manifest_path: manifestPath,
    manifest_sha256: await sha256File(manifestPath),
    video_id: clean(flags["video-id"]),
    watch_url: clean(flags["watch-url"]),
    studio_url: clean(flags["studio-url"]) || null,
    initial_visibility: "private",
    visibility,
    schedule_at: clean(flags["schedule-at"]) || null,
    field_verification: {
      active_channel: isTrue(flags["channel-verified"]),
      initial_private: isTrue(flags["initial-private-verified"]),
      title: isTrue(flags["title-verified"]),
      description: isTrue(flags["description-verified"]),
      thumbnail: isTrue(flags["thumbnail-verified"]),
      audience: isTrue(flags["audience-verified"]),
      monetization: isTrue(flags["monetization-verified"]),
      comments: isTrue(flags["comments-verified"]),
      checks_complete: isTrue(flags["checks-complete"]),
    },
    publish_approval: {
      required: nonPrivate,
      approved: nonPrivate ? isTrue(flags["publish-approved"]) : false,
      approved_by: nonPrivate ? clean(flags["publish-approved-by"]) || null : null,
      approved_at: nonPrivate && isTrue(flags["publish-approved"]) ? new Date().toISOString() : null,
    },
    recorded_by: clean(flags["recorded-by"]),
    recorded_at: new Date().toISOString(),
    note: clean(flags.note) || null,
  };
  const validation = validateYoutubeUploadReceipt(receipt, {
    manifest,
    manifestHash: receipt.manifest_sha256,
  });
  if (validation.status !== "passed") {
    console.log(JSON.stringify({
      status: "blocked",
      receipt_path: null,
      video_id: receipt.video_id,
      visibility: receipt.visibility,
      blockers: validation.blockers,
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  receipt.blockers = [];
  await writeJson(receiptPath, receipt);
  const channelDir = channelDirectoryForEpisode(episodeDir, identity);
  const { ledgerPath, ledger } = await rebuildChannelUploadLedger(channelDir, identity.channel);
  console.log(JSON.stringify({
    status: receipt.status,
    receipt_path: receiptPath,
    channel_upload_ledger_path: ledgerPath,
    channel_upload_ledger_entries: ledger.entry_count,
    schedule_conflicts: ledger.schedule_conflicts,
    video_id: receipt.video_id,
    visibility: receipt.visibility,
    blockers: receipt.blockers,
  }, null, 2));
}

async function rebuildUploadLedger() {
  requiredFlag("channel", flags.channel);
  const channelDir = path.join(dataRoot, "channels", clean(flags.channel));
  const { ledgerPath, ledger } = await rebuildChannelUploadLedger(channelDir, clean(flags.channel));
  console.log(JSON.stringify({
    status: ledger.status,
    ledger_path: ledgerPath,
    channel: ledger.channel,
    entry_count: ledger.entry_count,
    schedule_conflicts: ledger.schedule_conflicts,
  }, null, 2));
}

async function recordComment() {
  const { episodeDir, episode } = await episodeContext();
  const manifestPath = path.join(episodeDir, `youtube_publish_manifest_${episode}.json`);
  const uploadReceiptPath = path.join(episodeDir, `youtube_upload_receipt_${episode}.json`);
  const [manifest, uploadReceipt] = await Promise.all([
    readJson(manifestPath),
    readJson(uploadReceiptPath),
  ]);
  if (!manifest || manifest.schema !== YOUTUBE_PUBLISH_MANIFEST_SCHEMA || manifest.status !== "passed") {
    throw new Error(`Passed YouTube publish manifest required: ${manifestPath}`);
  }
  if (!uploadReceipt || uploadReceipt.schema !== YOUTUBE_UPLOAD_RECEIPT_SCHEMA || uploadReceipt.status !== "passed") {
    throw new Error(`Passed YouTube upload receipt required: ${uploadReceiptPath}`);
  }
  requiredFlag("recorded-by", flags["recorded-by"]);
  if (!clean(flags["comment-id"]) && !clean(flags["comment-url"])) {
    throw new Error("Comment receipt requires --comment-id or --comment-url.");
  }
  const uploadReceiptHash = await sha256File(uploadReceiptPath);
  const receiptPath = path.join(episodeDir, `youtube_pinned_comment_receipt_${episode}.json`);
  const receipt = {
    schema: YOUTUBE_PINNED_COMMENT_RECEIPT_SCHEMA,
    status: "passed",
    episode,
    upload_receipt_path: uploadReceiptPath,
    upload_receipt_sha256: uploadReceiptHash,
    video_id: uploadReceipt.video_id,
    comment_id: clean(flags["comment-id"]) || null,
    comment_url: clean(flags["comment-url"]) || null,
    comment_text_sha256: isTrue(flags["text-verified"])
      ? youtubeTextSha256(manifest.pinned_comment?.text)
      : null,
    post_approval: {
      approved: isTrue(flags["post-approved"]),
      approved_by: clean(flags["post-approved-by"]) || null,
      approved_at: isTrue(flags["post-approved"]) ? new Date().toISOString() : null,
    },
    pinned: isTrue(flags["pinned-verified"]),
    recorded_by: clean(flags["recorded-by"]),
    recorded_at: new Date().toISOString(),
    note: clean(flags.note) || null,
  };
  const validation = validateYoutubePinnedCommentReceipt(receipt, {
    manifest,
    uploadReceipt,
    uploadReceiptHash,
  });
  if (validation.status !== "passed") {
    console.log(JSON.stringify({
      status: "blocked",
      receipt_path: null,
      video_id: receipt.video_id,
      pinned: receipt.pinned,
      blockers: validation.blockers,
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  receipt.blockers = [];
  await writeJson(receiptPath, receipt);
  console.log(JSON.stringify({
    status: receipt.status,
    receipt_path: receiptPath,
    video_id: receipt.video_id,
    pinned: receipt.pinned,
    blockers: receipt.blockers,
  }, null, 2));
}

async function main() {
  if (action === "approve-packaging") return approvePackaging();
  if (action === "prepare") return prepareManifest();
  if (action === "record-upload") return recordUpload();
  if (action === "rebuild-ledger") return rebuildUploadLedger();
  if (action === "record-comment") return recordComment();
  throw new Error(`Unknown YouTube publishing action: ${action || "missing"}.`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  approvePackaging as approveYoutubePackagingForTests,
  prepareManifest as prepareYoutubeManifestForTests,
};
