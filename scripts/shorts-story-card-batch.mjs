#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

const execFile = promisify(execFileCallback);
const RENDERER_VERSION = "story_card_v1_2026-08-02.2";
const sourceHashCache = new Map();
const sourceProbeCache = new Map();

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function finiteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number.`);
  return parsed;
}

function boolArg(value, fallback = false) {
  if (value == null) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected true or false, received ${value}.`);
}

function svgEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function widthUnits(value) {
  return [...String(value)].reduce((sum, character) => {
    if (/\s/.test(character)) return sum + 0.35;
    if (/[ilI1.,'’“”]/.test(character)) return sum + 0.45;
    if (/[MW@]/.test(character)) return sum + 1.25;
    return sum + 0.82;
  }, 0);
}

function wrapText(text, maxUnits) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && widthUnits(candidate) > maxUnits) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function textTspans(lines, { x, firstY, lineHeight }) {
  return lines.map((line, index) => `<tspan x="${x}" y="${firstY + index * lineHeight}">${svgEscape(line)}</tspan>`).join("");
}

function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function normalizedProse(value) {
  return String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function sha256Source(filePath) {
  if (!sourceHashCache.has(filePath)) sourceHashCache.set(filePath, sha256(filePath));
  return sourceHashCache.get(filePath);
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function probe(filePath) {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=index,codec_name,codec_type,width,height,pix_fmt,r_frame_rate,sample_rate,channels,duration,start_time",
    "-of", "json",
    filePath,
  ], { maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function probeSource(filePath) {
  if (!sourceProbeCache.has(filePath)) sourceProbeCache.set(filePath, probe(filePath));
  return sourceProbeCache.get(filePath);
}

async function foregroundOverlayMatchRatio(foregroundPath, framePath) {
  const [foreground, frame] = await Promise.all([
    sharp(foregroundPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(framePath).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (foreground.info.width !== frame.info.width || foreground.info.height !== frame.info.height) return 0;
  let opaquePixels = 0;
  let matchingPixels = 0;
  for (let foregroundIndex = 0, frameIndex = 0; foregroundIndex < foreground.data.length; foregroundIndex += 4, frameIndex += 3) {
    if (foreground.data[foregroundIndex + 3] < 250) continue;
    opaquePixels += 1;
    const meanDifference = (
      Math.abs(foreground.data[foregroundIndex] - frame.data[frameIndex])
      + Math.abs(foreground.data[foregroundIndex + 1] - frame.data[frameIndex + 1])
      + Math.abs(foreground.data[foregroundIndex + 2] - frame.data[frameIndex + 2])
    ) / 3;
    if (meanDifference <= 35) matchingPixels += 1;
  }
  return opaquePixels === 0 ? 0 : matchingPixels / opaquePixels;
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

function localScheduleDate(isoTimestamp, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoTimestamp));
}

function validateCampaign(campaign) {
  const blockers = [];
  if (campaign.schema !== "goldflow_shorts_story_card_campaign_v1") blockers.push("wrong_campaign_schema");
  if (!Array.isArray(campaign.items) || campaign.items.length === 0) blockers.push("missing_campaign_items");
  const timeZone = campaign.schedule?.timezone ?? "America/New_York";
  const requiredStart = campaign.schedule?.start_date;
  const requiredEnd = campaign.schedule?.end_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredStart ?? "")) blockers.push("missing_or_invalid_schedule_start_date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredEnd ?? "")) blockers.push("missing_or_invalid_schedule_end_date");
  if (requiredStart && requiredEnd && requiredStart > requiredEnd) blockers.push("reversed_schedule_date_range");
  if (campaign.operator_approval?.approved !== true) blockers.push("missing_operator_campaign_approval");
  if (!campaign.youtube_channel?.channel_id || !campaign.youtube_channel?.expected_name || !campaign.youtube_channel?.expected_handle) blockers.push("missing_youtube_channel_identity");
  const byDate = new Map();
  const ids = new Set();
  const scheduleTimes = new Set();
  for (const item of campaign.items ?? []) {
    if (ids.has(item.id)) blockers.push(`duplicate_item_id:${item.id}`);
    ids.add(item.id);
    if (typeof item.schedule_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(item.schedule_at) || !Number.isFinite(Date.parse(item.schedule_at))) {
      blockers.push(`invalid_schedule_at:${item.id}`);
      continue;
    }
    const normalizedScheduleAt = new Date(item.schedule_at).toISOString();
    if (scheduleTimes.has(normalizedScheduleAt)) blockers.push(`duplicate_schedule_at:${item.schedule_at}`);
    scheduleTimes.add(normalizedScheduleAt);
    if (Date.parse(item.schedule_at) <= Date.now() + 10 * 60_000) blockers.push(`schedule_not_safely_future:${item.id}`);
    const date = localScheduleDate(item.schedule_at, timeZone);
    if (requiredStart && date < requiredStart) blockers.push(`schedule_before_campaign:${item.id}`);
    if (requiredEnd && date > requiredEnd) blockers.push(`schedule_after_campaign:${item.id}`);
    const longformReleaseAt = item.related_longform?.release_at;
    if (longformReleaseAt && Number.isFinite(Date.parse(longformReleaseAt))) {
      const separationMinutes = Math.abs(Date.parse(item.schedule_at) - Date.parse(longformReleaseAt)) / 60_000;
      const blackoutMinutes = Number(campaign.schedule?.longform_blackout_minutes ?? 90);
      if (separationMinutes < blackoutMinutes) blockers.push(`longform_blackout_collision:${item.id}`);
    }
    byDate.set(date, (byDate.get(date) ?? 0) + 1);
  }
  const minPerDay = Number(campaign.schedule?.daily_min ?? 2);
  const maxPerDay = Number(campaign.schedule?.daily_max ?? 4);
  if (!Number.isInteger(minPerDay) || !Number.isInteger(maxPerDay) || minPerDay < 2 || maxPerDay > 4 || minPerDay > maxPerDay) {
    blockers.push("invalid_daily_schedule_bounds");
  }
  if (requiredStart && requiredEnd) {
    const cursor = new Date(`${requiredStart}T12:00:00Z`);
    const end = new Date(`${requiredEnd}T12:00:00Z`);
    while (cursor <= end) {
      const date = cursor.toISOString().slice(0, 10);
      const count = byDate.get(date) ?? 0;
      if (count < minPerDay || count > maxPerDay) blockers.push(`daily_schedule_count:${date}:${count}`);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return { blockers, daily_counts: Object.fromEntries([...byDate.entries()].sort()) };
}

function itemPaths(campaign, item) {
  const itemDir = path.join(campaign.output_dir, "items", item.id);
  return {
    itemDir,
    video: path.join(itemDir, `${item.id}.mp4`),
    background: path.join(itemDir, "card-overlay.png"),
    foreground: path.join(itemDir, "card-foreground.png"),
    firstFrame: path.join(itemDir, "review-first.png"),
    midpointFrame: path.join(itemDir, "review-midpoint.png"),
    finalFrame: path.join(itemDir, "review-final.png"),
    report: path.join(itemDir, "short_render_report.json"),
    publishManifest: path.join(itemDir, "youtube_shorts_publish_manifest.json"),
  };
}

async function renderItem(campaign, item, { force, validateOnly }) {
  if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{2,159}$/.test(item.id)) throw new Error(`Unsafe short item id: ${item.id}`);
  requireString(item.pill_label, `${item.id}.pill_label`);
  requireString(item.cta_label, `${item.id}.cta_label`);
  const packageTitle = requireString(item.packaging?.title, `${item.id}.packaging.title`);
  const packageDescription = requireString(item.packaging?.description, `${item.id}.packaging.description`);
  if (packageTitle.length > 100) throw new Error(`${item.id} YouTube title exceeds 100 characters.`);
  if (packageDescription.length > 5000) throw new Error(`${item.id} YouTube description exceeds 5000 characters.`);
  if (!Array.isArray(item.packaging?.tags) || item.packaging.tags.some((tag) => typeof tag !== "string" || tag.trim() === "")) {
    throw new Error(`${item.id} packaging tags must be a non-empty string array.`);
  }
  if (!Array.isArray(item.copy_evidence_quotes) || item.copy_evidence_quotes.length === 0) {
    throw new Error(`${item.id} must contain at least one exact locked-script evidence quote.`);
  }
  const output = itemPaths(campaign, item);
  await fs.mkdir(output.itemDir, { recursive: true });

  const startSec = finiteNumber(item.clip?.start_sec, `${item.id}.clip.start_sec`);
  const endSec = finiteNumber(item.clip?.end_sec, `${item.id}.clip.end_sec`);
  const durationSec = endSec - startSec;
  if (durationSec < 7 || durationSec > 15) throw new Error(`${item.id} duration ${durationSec.toFixed(3)} is outside 7–15 seconds.`);

  const sourceVisual = requireString(item.source?.visual_video_path, `${item.id}.source.visual_video_path`);
  const sourceAudio = requireString(item.source?.audio_video_path, `${item.id}.source.audio_video_path`);
  const sourceScript = requireString(item.source?.script_path, `${item.id}.source.script_path`);
  const sourceFinalQa = requireString(item.source?.final_qa_path, `${item.id}.source.final_qa_path`);
  const sourceWordTiming = requireString(item.source?.word_timing_path, `${item.id}.source.word_timing_path`);
  const avatarPath = requireString(campaign.brand?.avatar_path, "campaign.brand.avatar_path");
  const brandContractPath = requireString(campaign.brand?.contract_path, "campaign.brand.contract_path");
  const requiredPaths = [sourceVisual, sourceAudio, sourceScript, sourceFinalQa, sourceWordTiming, avatarPath, brandContractPath];
  for (const requiredPath of requiredPaths) {
    if (!(await pathExists(requiredPath))) throw new Error(`${item.id} is missing required source ${requiredPath}`);
  }

  const [scriptText, finalQa, wordTiming, currentSourceHashes, visualSourceProbe, audioSourceProbe] = await Promise.all([
    fs.readFile(sourceScript, "utf8"),
    fs.readFile(sourceFinalQa, "utf8").then(JSON.parse),
    fs.readFile(sourceWordTiming, "utf8").then(JSON.parse),
    Promise.all([
      sha256Source(sourceVisual),
      sha256Source(sourceAudio),
      sha256Source(sourceScript),
      sha256Source(sourceFinalQa),
      sha256Source(sourceWordTiming),
      sha256Source(avatarPath),
      sha256Source(brandContractPath),
    ]),
    probeSource(sourceVisual),
    probeSource(sourceAudio),
  ]);
  const [sourceVisualSha256, sourceAudioSha256, sourceScriptSha256, sourceFinalQaSha256, sourceWordTimingSha256, avatarSha256, brandContractSha256] = currentSourceHashes;
  if (finalQa.status !== "passed" || finalQa.approved !== true) throw new Error(`${item.id} source final QA is not passed and approved.`);
  if (finalQa.final_video_path !== sourceAudio || finalQa.final_video_sha256 !== sourceAudioSha256) {
    throw new Error(`${item.id} source audio/video does not match the hash-bound final QA render.`);
  }
  const expectedVisualPath = path.join(item.source.episode_dir, "assets/render-work/silent_video.mp4");
  if (sourceVisual !== expectedVisualPath) throw new Error(`${item.id} clean visual source is not the episode's canonical silent_video.mp4.`);
  const visualDuration = Number(visualSourceProbe.format?.duration ?? 0);
  const audioDuration = Number(audioSourceProbe.format?.duration ?? 0);
  if (visualDuration < endSec || audioDuration < endSec) throw new Error(`${item.id} source media does not cover the selected clip window.`);
  if (!Array.isArray(wordTiming.words) || wordTiming.status !== "passed") throw new Error(`${item.id} source word timing is not passed.`);
  if (wordTiming.source_script_hash !== sourceScriptSha256) throw new Error(`${item.id} word timing is stale for the current locked script hash.`);
  const clipWords = wordTiming.words.filter((word) => word.end_sec > startSec && word.start_sec < endSec);
  if (!clipWords.length) throw new Error(`${item.id} clip window has no current Whisper timing coverage.`);
  if (Math.abs(clipWords[0].start_sec - startSec) > 0.90 || Math.abs(clipWords.at(-1).end_sec - endSec) > 0.90) {
    throw new Error(`${item.id} clip bounds are not aligned to current Whisper word boundaries.`);
  }
  if (!normalizedProse(scriptText).includes(normalizedProse(item.clip.transcript))) {
    throw new Error(`${item.id} clip transcript is not a normalized contiguous excerpt of the locked script.`);
  }
  const brandContract = JSON.parse(await fs.readFile(brandContractPath, "utf8"));
  if (brandContract.status !== "passed"
    || brandContract.youtube_channel_id !== campaign.youtube_channel.channel_id
    || brandContract.display_name !== campaign.brand.display_name
    || brandContract.handle !== campaign.brand.handle
    || brandContract.assets?.avatar?.sha256 !== avatarSha256) {
    throw new Error(`${item.id} channel brand contract does not match the campaign identity or avatar hash.`);
  }
  const normalizedScript = normalizedProse(scriptText);
  const missingEvidence = (item.copy_evidence_quotes ?? []).filter((quote) => !normalizedScript.includes(normalizedProse(quote)));
  if (missingEvidence.length) throw new Error(`${item.id} has copy evidence missing from the locked script: ${missingEvidence.join(" | ")}`);

  const headline = requireString(item.copy?.headline, `${item.id}.copy.headline`);
  const body = requireString(item.copy?.body, `${item.id}.copy.body`);
  const footer = requireString(item.copy?.footer, `${item.id}.copy.footer`);
  const headlineLines = wrapText(headline, 28);
  const bodyLines = wrapText(body, 33);
  const footerLines = wrapText(footer, 40);
  if (headlineLines.length > 2) throw new Error(`${item.id} headline wraps to ${headlineLines.length} lines; maximum is 2.`);
  if (bodyLines.length > 7) throw new Error(`${item.id} body wraps to ${bodyLines.length} lines; maximum is 7.`);
  if (footerLines.length > 3) throw new Error(`${item.id} footer wraps to ${footerLines.length} lines; maximum is 3.`);

  const supportingCopy = [item.pill_label, campaign.brand.display_name, campaign.brand.handle, item.cta_label, "WATCH"];
  const allVisibleWordCount = wordCount(`${headline} ${body} ${footer} ${supportingCopy.join(" ")}`);
  const readingWpm = finiteNumber(campaign.reading_wpm ?? 200, "campaign.reading_wpm");
  if (readingWpm < 100 || readingWpm > 400) throw new Error("campaign.reading_wpm is outside 100–400.");
  const readingSeconds = allVisibleWordCount / (readingWpm / 60);
  const readingRatio = readingSeconds / durationSec;
  const minRatio = finiteNumber(campaign.reading_ratio?.min ?? 1.8, "campaign.reading_ratio.min");
  const maxRatio = finiteNumber(campaign.reading_ratio?.max ?? 2.6, "campaign.reading_ratio.max");
  if (minRatio <= 0 || maxRatio <= minRatio) throw new Error("campaign reading ratio bounds are invalid.");
  if (readingRatio < minRatio || readingRatio > maxRatio) {
    throw new Error(`${item.id} reading ratio ${readingRatio.toFixed(3)} is outside ${minRatio}–${maxRatio}.`);
  }

  const itemSpec = {
    schema: "goldflow_shorts_story_card_item_spec_v1",
    renderer_version: RENDERER_VERSION,
    campaign_id: campaign.campaign_id,
    item,
    brand: campaign.brand,
    canvas: campaign.canvas,
    reading_wpm: campaign.reading_wpm,
  };
  const itemSpecSha256 = sha256Json(itemSpec);
  if (validateOnly) {
    return {
      schema: "goldflow_shorts_story_card_item_validation_v1",
      status: "passed",
      short_id: item.id,
      schedule_at: item.schedule_at,
      item_spec_sha256: itemSpecSha256,
      reading_time_to_runtime_ratio: Number(readingRatio.toFixed(3)),
      source_hashes: {
        visual_video_sha256: sourceVisualSha256,
        audio_video_sha256: sourceAudioSha256,
        script_sha256: sourceScriptSha256,
        final_qa_sha256: sourceFinalQaSha256,
        word_timing_sha256: sourceWordTimingSha256,
        avatar_sha256: avatarSha256,
        brand_contract_sha256: brandContractSha256,
      },
    };
  }
  if (!force && await pathExists(output.report) && await pathExists(output.video)) {
    const existing = JSON.parse(await fs.readFile(output.report, "utf8"));
    const sourcesCurrent = existing.source_hashes?.visual_video_sha256 === sourceVisualSha256
      && existing.source_hashes?.audio_video_sha256 === sourceAudioSha256
      && existing.source_hashes?.script_sha256 === sourceScriptSha256
      && existing.source_hashes?.final_qa_sha256 === sourceFinalQaSha256
      && existing.source_hashes?.word_timing_sha256 === sourceWordTimingSha256
      && existing.source_hashes?.avatar_sha256 === avatarSha256
      && existing.source_hashes?.brand_contract_sha256 === brandContractSha256;
    const derivedPaths = [
      existing.youtube_publish_manifest_path,
      existing.review_artifacts?.first_frame_path,
      existing.review_artifacts?.midpoint_frame_path,
      existing.review_artifacts?.final_frame_path,
    ];
    const derivedExist = (await Promise.all(derivedPaths.map((filePath) => typeof filePath === "string" && pathExists(filePath)))).every(Boolean);
    const derivedCurrent = derivedExist
      && existing.youtube_publish_manifest_sha256 === await sha256(existing.youtube_publish_manifest_path)
      && existing.review_artifacts.first_frame_sha256 === await sha256(existing.review_artifacts.first_frame_path)
      && existing.review_artifacts.midpoint_frame_sha256 === await sha256(existing.review_artifacts.midpoint_frame_path)
      && existing.review_artifacts.final_frame_sha256 === await sha256(existing.review_artifacts.final_frame_path);
    if (existing.status === "passed"
      && existing.item_spec_sha256 === itemSpecSha256
      && sourcesCurrent
      && existing.output_video_sha256 === await sha256(output.video)
      && derivedCurrent) {
      return { ...existing, reused: true };
    }
    throw new Error(`${item.id} has stale output; rerun with --force true or create a new campaign identity.`);
  }

  const avatarDataUri = `data:image/jpeg;base64,${(await fs.readFile(avatarPath)).toString("base64")}`;
  const backgroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
    <defs>
      <linearGradient id="veil" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#090400" stop-opacity="0.66"/>
        <stop offset="0.48" stop-color="#0b0703" stop-opacity="0.80"/>
        <stop offset="1" stop-color="#030201" stop-opacity="0.90"/>
      </linearGradient>
      <radialGradient id="gold" cx="0.76" cy="0.04" r="0.85">
        <stop offset="0" stop-color="#f1bd59" stop-opacity="0.28"/>
        <stop offset="0.48" stop-color="#8e491c" stop-opacity="0.08"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0"/>
      </radialGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="22" stdDeviation="28" flood-color="#000000" flood-opacity="0.66"/>
      </filter>
    </defs>
    <rect width="1080" height="1920" fill="url(#veil)"/>
    <rect width="1080" height="1920" fill="url(#gold)"/>
    <g opacity="0.20">
      <circle cx="930" cy="160" r="128" fill="none" stroke="#f1bd59" stroke-width="3"/>
      <circle cx="930" cy="160" r="174" fill="none" stroke="#a96227" stroke-width="1"/>
      <path d="M-120 1760 L1200 1420" stroke="#d79a42" stroke-width="2"/>
    </g>
    <rect x="98" y="96" width="884" height="1530" rx="34" fill="#080603" fill-opacity="0.93" filter="url(#shadow)"/>
    <rect x="98" y="96" width="884" height="1530" rx="34" fill="#080603" fill-opacity="0.93" stroke="#77521e" stroke-width="2"/>
    <rect x="104" y="710" width="872" height="490" fill="#020201"/>
  </svg>`;

  const foregroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
    <defs>
      <linearGradient id="pill" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#f2d083"/>
        <stop offset="1" stop-color="#b56b25"/>
      </linearGradient>
      <clipPath id="avatarLarge"><circle cx="142" cy="176" r="38"/></clipPath>
      <clipPath id="avatarSmall"><circle cx="142" cy="1289" r="27"/></clipPath>
    </defs>
    <image href="${avatarDataUri}" x="104" y="138" width="76" height="76" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarLarge)"/>
    <circle cx="142" cy="176" r="38" fill="none" stroke="#d7a347" stroke-width="3"/>
    <text x="202" y="170" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="800">${svgEscape(campaign.brand.display_name)}</text>
    <text x="202" y="207" fill="#9f917c" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="500">${svgEscape(campaign.brand.handle)} · now</text>
    <rect x="787" y="145" width="158" height="52" rx="26" fill="url(#pill)"/>
    <text x="866" y="180" text-anchor="middle" fill="#1b0c02" font-family="Arial, Helvetica, sans-serif" font-size="21" font-weight="900" letter-spacing="1.2">${svgEscape(item.pill_label)}</text>
    <text fill="#f2c66d" font-family="Arial, Helvetica, sans-serif" font-size="48" font-weight="900">${textTspans(headlineLines, { x: 134, firstY: 293, lineHeight: 55 })}</text>
    <text fill="#f4f1ec" font-family="Arial, Helvetica, sans-serif" font-size="33" font-weight="680">${textTspans(bodyLines, { x: 134, firstY: 408, lineHeight: 40 })}</text>
    <rect x="104" y="710" width="872" height="490" fill="none" stroke="#9b6b28" stroke-width="3"/>
    <line x1="128" y1="1238" x2="952" y2="1238" stroke="#47351e" stroke-width="2"/>
    <image href="${avatarDataUri}" x="115" y="1262" width="54" height="54" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarSmall)"/>
    <circle cx="142" cy="1289" r="27" fill="none" stroke="#d7a347" stroke-width="2"/>
    <text x="186" y="1284" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="25" font-weight="800">${svgEscape(campaign.brand.display_name)}</text>
    <text x="186" y="1314" fill="#9f917c" font-family="Arial, Helvetica, sans-serif" font-size="21">${svgEscape(campaign.brand.handle)}</text>
    <text fill="#eee8df" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="650">${textTspans(footerLines, { x: 134, firstY: 1371, lineHeight: 38 })}</text>
    <line x1="128" y1="1500" x2="952" y2="1500" stroke="#47351e" stroke-width="2"/>
    <text x="134" y="1564" fill="#a99576" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="700" letter-spacing="1.1">${svgEscape(item.cta_label)}</text>
    <text x="944" y="1564" text-anchor="end" fill="#efbd61" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="800">WATCH →</text>
    <text x="540" y="1802" text-anchor="middle" fill="#f1c36b" font-family="Georgia, Times New Roman, serif" font-size="51" font-weight="900" letter-spacing="3">MANHWA JOEY</text>
    <text x="540" y="1852" text-anchor="middle" fill="#9a8666" font-family="Arial, Helvetica, sans-serif" font-size="21" font-weight="700" letter-spacing="4">MANHWA RECAPS • ORIGINAL STORIES</text>
  </svg>`;

  await Promise.all([
    sharp(Buffer.from(backgroundSvg)).png().toFile(output.background),
    sharp(Buffer.from(foregroundSvg)).png().toFile(output.foreground),
  ]);

  const renderVideoPath = path.join(output.itemDir, `${item.id}.partial-${Date.now()}.mp4`);
  await execFile("ffmpeg", [
    "-y",
    "-ss", startSec.toFixed(3), "-t", durationSec.toFixed(3), "-i", sourceVisual,
    "-ss", startSec.toFixed(3), "-t", durationSec.toFixed(3), "-i", sourceAudio,
    "-loop", "1", "-framerate", String(campaign.canvas?.fps ?? 60), "-i", output.background,
    "-loop", "1", "-framerate", String(campaign.canvas?.fps ?? 60), "-i", output.foreground,
    "-filter_complex",
    `[0:v]setpts=PTS-STARTPTS,split=2[clip_source][back_source];[clip_source]scale=872:490:flags=lanczos,setsar=1[clip];[back_source]scale=360:640:force_original_aspect_ratio=increase,crop=360:640,gblur=sigma=20:steps=2,eq=brightness=-0.22:saturation=0.82,scale=1080:1920:flags=bicubic,setsar=1[blur];[2:v]format=rgba[card];[blur][card]overlay=0:0:shortest=1[bg];[bg][clip]overlay=104:710:shortest=1[base];[3:v]format=rgba[fg];[base][fg]overlay=0:0:shortest=1,format=yuv420p[v];[1:a]atrim=start=0:end=${durationSec.toFixed(3)},asetpts=PTS-STARTPTS[a]`,
    "-map", "[v]", "-map", "[a]",
    "-t", durationSec.toFixed(3), "-r", String(campaign.canvas?.fps ?? 60),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart", renderVideoPath,
  ], { maxBuffer: 32 * 1024 * 1024 });

  const [outputVideoSha256, mediaProbe] = await Promise.all([sha256(renderVideoPath), probe(renderVideoPath)]);
  const videoStream = mediaProbe.streams.find((stream) => stream.codec_type === "video") ?? {};
  const audioStream = mediaProbe.streams.find((stream) => stream.codec_type === "audio") ?? {};
  const actualDurationSec = Number(mediaProbe.format?.duration ?? 0);
  const blockers = [];
  if (videoStream.width !== 1080 || videoStream.height !== 1920) blockers.push("wrong_canvas_geometry");
  if (videoStream.pix_fmt !== "yuv420p" || videoStream.codec_name !== "h264") blockers.push("wrong_video_contract");
  if (videoStream.r_frame_rate !== "60/1") blockers.push("wrong_frame_rate");
  if (audioStream.codec_name !== "aac" || audioStream.sample_rate !== "44100" || audioStream.channels !== 2) blockers.push("wrong_audio_contract");
  if (Math.abs(actualDurationSec - durationSec) > 0.08) blockers.push("duration_mismatch");
  const videoDurationSec = Number(videoStream.duration ?? actualDurationSec);
  const audioDurationSec = Number(audioStream.duration ?? actualDurationSec);
  if (!Number.isFinite(videoDurationSec) || Math.abs(videoDurationSec - durationSec) > 0.10) blockers.push("video_stream_duration_mismatch");
  if (!Number.isFinite(audioDurationSec) || Math.abs(audioDurationSec - durationSec) > 0.10) blockers.push("audio_stream_duration_mismatch");
  try {
    await execFile("ffmpeg", ["-v", "error", "-i", renderVideoPath, "-f", "null", "-"], { maxBuffer: 8 * 1024 * 1024 });
  } catch {
    blockers.push("full_decode_failed");
  }
  if (blockers.length) throw new Error(`${item.id} rendered output failed validation: ${blockers.join(", ")}. Partial file retained at ${renderVideoPath}`);
  await Promise.all([
    execFile("ffmpeg", ["-y", "-v", "error", "-ss", "0.250", "-i", renderVideoPath, "-frames:v", "1", "-update", "1", output.firstFrame]),
    execFile("ffmpeg", ["-y", "-v", "error", "-ss", (durationSec / 2).toFixed(3), "-i", renderVideoPath, "-frames:v", "1", "-update", "1", output.midpointFrame]),
    execFile("ffmpeg", ["-y", "-v", "error", "-ss", Math.max(0, durationSec - 0.25).toFixed(3), "-i", renderVideoPath, "-frames:v", "1", "-update", "1", output.finalFrame]),
  ]);
  const foregroundOverlayRatios = await Promise.all([
    foregroundOverlayMatchRatio(output.foreground, output.firstFrame),
    foregroundOverlayMatchRatio(output.foreground, output.midpointFrame),
    foregroundOverlayMatchRatio(output.foreground, output.finalFrame),
  ]);
  if (foregroundOverlayRatios.some((ratio) => ratio < 0.97)) {
    throw new Error(`${item.id} foreground overlay retention failed visual QA. Partial file retained at ${renderVideoPath}`);
  }
  await fs.rename(renderVideoPath, output.video);

  const publishManifest = {
    schema: "goldflow_youtube_shorts_publish_manifest_v1",
    status: blockers.length ? "blocked" : "passed",
    campaign_id: campaign.campaign_id,
    short_id: item.id,
    youtube_channel: campaign.youtube_channel,
    video: { path: output.video, sha256: outputVideoSha256, duration_sec: actualDurationSec },
    title: item.packaging.title,
    description: item.packaging.description,
    tags: item.packaging.tags,
    publish_settings: {
      initial_visibility: "private",
      final_visibility: "scheduled",
      schedule_at: item.schedule_at,
      timezone: campaign.schedule.timezone,
      made_for_kids: false,
      age_restriction: false,
      altered_content: false,
      comments: "allow_all",
      monetization: "on",
    },
    related_longform: item.related_longform,
    pinned_comment: null,
    approval: campaign.operator_approval,
  };
  await writeJsonAtomic(output.publishManifest, publishManifest);
  const [youtubePublishManifestSha256, firstFrameSha256, midpointFrameSha256, finalFrameSha256] = await Promise.all([
    sha256(output.publishManifest), sha256(output.firstFrame), sha256(output.midpointFrame), sha256(output.finalFrame),
  ]);

  const report = {
    schema: "goldflow_shorts_story_card_render_report_v1",
    status: blockers.length ? "blocked" : "passed",
    created_at: new Date().toISOString(),
    renderer_version: RENDERER_VERSION,
    campaign_id: campaign.campaign_id,
    short_id: item.id,
    item_spec_sha256: itemSpecSha256,
    output_video_path: output.video,
    output_video_sha256: outputVideoSha256,
    youtube_publish_manifest_path: output.publishManifest,
    youtube_publish_manifest_sha256: youtubePublishManifestSha256,
    source_hashes: {
      visual_video_sha256: sourceVisualSha256,
      audio_video_sha256: sourceAudioSha256,
      script_sha256: sourceScriptSha256,
      final_qa_sha256: sourceFinalQaSha256,
      word_timing_sha256: sourceWordTimingSha256,
      avatar_sha256: avatarSha256,
      brand_contract_sha256: brandContractSha256,
    },
    copy_evidence_quotes: item.copy_evidence_quotes,
    schedule_at: item.schedule_at,
    reading_time_sec: Number(readingSeconds.toFixed(3)),
    reading_time_to_runtime_ratio: Number(readingRatio.toFixed(3)),
    technical_probe: mediaProbe,
    technical_blockers: blockers,
    review_artifacts: {
      first_frame_path: output.firstFrame,
      first_frame_sha256: firstFrameSha256,
      midpoint_frame_path: output.midpointFrame,
      midpoint_frame_sha256: midpointFrameSha256,
      final_frame_path: output.finalFrame,
      final_frame_sha256: finalFrameSha256,
      foreground_overlay_match_ratios: foregroundOverlayRatios.map((ratio) => Number(ratio.toFixed(6))),
    },
    validation: {
      source_rights_basis: "operator-owned Goldflow production render",
      locked_script_evidence_bound: true,
      source_final_qa_bound: true,
      source_audio_retained: true,
      clean_pre_caption_motion_master_used: true,
      synchronized_video_background_used: true,
      card_horizontally_centered: true,
      reactor_panel_omitted: true,
      mobile_canvas: "1080x1920",
    },
  };
  await writeJsonAtomic(output.report, report);
  return report;
}

async function buildDailyContactSheets(campaign, reports) {
  const timeZone = campaign.schedule.timezone;
  const groups = new Map();
  for (const report of reports) {
    const date = localScheduleDate(report.schedule_at, timeZone);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(report);
  }
  const reviewDir = path.join(campaign.output_dir, "review");
  await fs.mkdir(reviewDir, { recursive: true });
  const paths = {};
  for (const [date, dailyReports] of [...groups.entries()].sort()) {
    const frames = await Promise.all(dailyReports.map(async (report) => {
      const input = report.review_artifacts.first_frame_path;
      return sharp(input).resize(360, 640, { fit: "cover" }).png().toBuffer();
    }));
    const sheetPath = path.join(reviewDir, `${date}-first-frames.png`);
    await sharp({ create: { width: frames.length * 360, height: 640, channels: 3, background: "#05070b" } })
      .composite(frames.map((input, index) => ({ input, left: index * 360, top: 0 })))
      .png()
      .toFile(sheetPath);
    paths[date] = sheetPath;
  }
  return paths;
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(requireString(args.manifest, "--manifest"));
const requestedConcurrency = Number(args.concurrency ?? 4);
if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > 8) throw new Error("--concurrency must be an integer from 1 through 8.");
const concurrency = requestedConcurrency;
const force = boolArg(args.force, false);
const validateOnly = boolArg(args["validate-only"], false);
const campaign = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const resolvedOutputDir = path.resolve(requireString(campaign.output_dir, "campaign.output_dir"));
const requiredOutputRoot = "/Users/joel/AniFactoryData/channels/53rebirth/shorts_campaigns/";
if (!resolvedOutputDir.startsWith(requiredOutputRoot) || resolvedOutputDir === requiredOutputRoot.slice(0, -1)) {
  throw new Error(`campaign.output_dir must be a dedicated child of ${requiredOutputRoot}`);
}
campaign.output_dir = resolvedOutputDir;
const campaignValidation = validateCampaign(campaign);
if (campaignValidation.blockers.length) throw new Error(`Campaign validation failed: ${campaignValidation.blockers.join(", ")}`);
await fs.mkdir(campaign.output_dir, { recursive: true });

const reports = await mapLimit(campaign.items, concurrency, (item) => renderItem(campaign, item, { force, validateOnly }));
if (validateOnly) {
  const validationReportPath = path.join(campaign.output_dir, "campaign_validation_report.json");
  const validationReport = {
    schema: "goldflow_shorts_story_card_campaign_validation_v1",
    status: "passed",
    created_at: new Date().toISOString(),
    campaign_manifest_path: manifestPath,
    campaign_manifest_sha256: await sha256(manifestPath),
    campaign_id: campaign.campaign_id,
    item_count: reports.length,
    daily_schedule_counts: campaignValidation.daily_counts,
    items: reports,
  };
  await writeJsonAtomic(validationReportPath, validationReport);
  console.log(JSON.stringify({ status: "passed", validation_only: true, item_count: reports.length, report: validationReportPath }, null, 2));
  process.exit(0);
}
const contactSheets = await buildDailyContactSheets(campaign, reports);
const queue = await Promise.all(reports.map(async (report) => JSON.parse(await fs.readFile(report.youtube_publish_manifest_path, "utf8"))));
const queuePath = path.join(campaign.output_dir, "youtube_shorts_publish_queue.json");
const queueDocument = {
  schema: "goldflow_youtube_shorts_publish_queue_v1",
  status: queue.every((item) => item.status === "passed") ? "passed" : "blocked",
  campaign_id: campaign.campaign_id,
  item_count: queue.length,
  items: queue,
};
await writeJsonAtomic(queuePath, queueDocument);

const campaignReport = {
  schema: "goldflow_shorts_story_card_campaign_report_v1",
  status: reports.every((report) => report.status === "passed") && queueDocument.status === "passed" ? "passed" : "blocked",
  created_at: new Date().toISOString(),
  campaign_manifest_path: manifestPath,
  campaign_manifest_sha256: await sha256(manifestPath),
  campaign_id: campaign.campaign_id,
  item_count: reports.length,
  passed_count: reports.filter((report) => report.status === "passed").length,
  blocked_count: reports.filter((report) => report.status !== "passed").length,
  rendered_count: reports.filter((report) => report.reused !== true).length,
  reused_count: reports.filter((report) => report.reused === true).length,
  daily_schedule_counts: campaignValidation.daily_counts,
  publish_queue_path: queuePath,
  daily_contact_sheets: contactSheets,
  items: reports.map((report) => ({
    short_id: report.short_id,
    status: report.status,
    video_path: report.output_video_path,
    video_sha256: report.output_video_sha256,
    schedule_at: report.schedule_at,
    reading_ratio: report.reading_time_to_runtime_ratio,
    report_path: itemPaths(campaign, { id: report.short_id }).report,
  })),
};
const campaignReportPath = path.join(campaign.output_dir, "campaign_render_report.json");
await writeJsonAtomic(campaignReportPath, campaignReport);

console.log(JSON.stringify({
  status: campaignReport.status,
  campaign_id: campaign.campaign_id,
  item_count: campaignReport.item_count,
  passed_count: campaignReport.passed_count,
  output_dir: campaign.output_dir,
  publish_queue: queuePath,
  report: campaignReportPath,
}, null, 2));
