#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    parsed[token.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required.`);
  return value;
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

function slugToken(slug) {
  return slug
    .replace(/^2026-W\d+-/, "")
    .replace(/-v\d+(?:-full-v\d+)?$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 3)
    .join("-");
}

function titleFor(headline) {
  const suffix = " #shorts";
  const limit = 100 - suffix.length;
  const trimmed = headline.length <= limit ? headline : `${headline.slice(0, limit - 1).trimEnd()}…`;
  return `${trimmed}${suffix}`;
}

const args = parseArgs(process.argv.slice(2));
const catalogPaths = required(args.catalogs, "--catalogs").split(",").map((value) => path.resolve(value));
const outputDir = path.resolve(required(args["output-dir"], "--output-dir"));
const uploadLedgerPath = path.resolve(args["upload-ledger"] ?? "/Users/joel/AniFactoryData/channels/53rebirth/youtube_upload_ledger.json");
const catalogs = await Promise.all(catalogPaths.map(async (catalogPath) => ({
  path: catalogPath,
  data: JSON.parse(await fs.readFile(catalogPath, "utf8")),
  sha256: await sha256(catalogPath),
})));
const candidates = catalogs.flatMap(({ data }) => data.candidates ?? data.items ?? []);
const ledger = JSON.parse(await fs.readFile(uploadLedgerPath, "utf8"));
const ledgerByWeek = new Map(ledger.entries.map((entry) => [entry.week, entry]));

const episodeKeys = {
  ninety_nine: "2026-W31-ninety-nine-gates-world-architect-v1",
  afterlife: "2026-W30-afterlife-one-coin-sovereign-v1",
  jilted: "2026-W31-jilted-altar-boss-mother-v1",
  driver: "2026-W31-reborn-drivers-daughter-hidden-billionaire-v1",
  robot: "2026-W31-ai-robot-v1",
  sigma: "2026-W31-sigma-sovereign-v1",
};
const scheduleBlueprint = [
  ["2026-08-02T14:00:00-04:00", "jilted"],
  ["2026-08-02T17:30:00-04:00", "ninety_nine"],
  ["2026-08-02T21:30:00-04:00", "afterlife"],
  ["2026-08-03T09:00:00-04:00", "driver"],
  ["2026-08-03T14:00:00-04:00", "ninety_nine"],
  ["2026-08-03T20:00:00-04:00", "afterlife"],
  ["2026-08-04T09:00:00-04:00", "driver"],
  ["2026-08-04T14:00:00-04:00", "driver"],
  ["2026-08-04T20:00:00-04:00", "jilted"],
  ["2026-08-05T09:00:00-04:00", "robot"],
  ["2026-08-05T14:00:00-04:00", "ninety_nine"],
  ["2026-08-05T20:00:00-04:00", "afterlife"],
  ["2026-08-06T09:00:00-04:00", "robot"],
  ["2026-08-06T14:00:00-04:00", "robot"],
  ["2026-08-06T20:00:00-04:00", "jilted"],
  ["2026-08-07T09:00:00-04:00", "sigma"],
  ["2026-08-07T14:00:00-04:00", "driver"],
  ["2026-08-07T20:00:00-04:00", "afterlife"],
  ["2026-08-08T09:00:00-04:00", "sigma"],
  ["2026-08-08T14:00:00-04:00", "sigma"],
  ["2026-08-08T20:00:00-04:00", "ninety_nine"],
  ["2026-08-09T09:00:00-04:00", "robot"],
  ["2026-08-09T14:00:00-04:00", "sigma"],
  ["2026-08-09T20:00:00-04:00", "jilted"],
];

const selectedByWeek = new Map();
for (const week of Object.values(episodeKeys)) {
  const matching = candidates
    .filter((candidate) => candidate.episode_slug === week || candidate.source_id === week || candidate.week === week)
    .sort((left, right) => Number(right.quality_score ?? 0) - Number(left.quality_score ?? 0));
  if (matching.length < 4) throw new Error(`${week} has only ${matching.length} candidates; four are required.`);
  selectedByWeek.set(week, matching.slice(0, 4));
}

const usedByWeek = new Map();
const items = scheduleBlueprint.map(([scheduleAt, key], scheduleIndex) => {
  const week = episodeKeys[key];
  const ledgerEntry = ledgerByWeek.get(week);
  if (!ledgerEntry) throw new Error(`Upload ledger is missing ${week}.`);
  const itemIndex = usedByWeek.get(week) ?? 0;
  usedByWeek.set(week, itemIndex + 1);
  const candidate = selectedByWeek.get(week)[itemIndex];
  const episodeDir = candidate.episode_dir ?? ledgerEntry.episode_dir;
  const publishManifestPath = path.join(episodeDir, `youtube_publish_manifest_${ledgerEntry.episode}.json`);
  const sourcePublishManifest = candidate.source_publish_manifest
    ?? JSON.parse(readFileSync(publishManifestPath, "utf8"));
  const audioVideoPath = sourcePublishManifest.video?.path;
  if (!audioVideoPath) throw new Error(`${week} publish manifest does not contain video.path.`);
  const scheduleDate = scheduleAt.slice(0, 10).replaceAll("-", "");
  const ordinal = String(scheduleIndex + 1).padStart(2, "0");
  const segmentToken = String(candidate.segment_id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const shortId = `mj-${scheduleDate}-${ordinal}-${slugToken(week)}-${segmentToken}`;
  const releaseAt = ledgerEntry.schedule_at ?? ledgerEntry.recorded_at;
  const isTeaser = new Date(scheduleAt) < new Date(releaseAt);
  const releaseLabel = releaseAt ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }).format(new Date(releaseAt)).toUpperCase() : null;
  const ctaLabel = isTeaser ? `FULL STORY ${releaseLabel}` : "FULL STORY ON CHANNEL";
  const description = `${candidate.headline}\n\nWatch the full story: ${ledgerEntry.watch_url}\n\n#shorts #manhwa #anime`;
  return {
    id: shortId,
    schedule_at: scheduleAt,
    pill_label: isTeaser ? "TEASER" : "STORY DROP",
    cta_label: ctaLabel,
    source: {
      episode_dir: episodeDir,
      visual_video_path: path.join(episodeDir, "assets/render-work/silent_video.mp4"),
      audio_video_path: audioVideoPath,
      script_path: path.join(episodeDir, "script_clean.md"),
      final_qa_path: path.join(episodeDir, `final_qa_${ledgerEntry.episode}.json`),
      word_timing_path: path.join(episodeDir, `narration_word_timing_${ledgerEntry.episode}.json`),
      source_publish_manifest_path: publishManifestPath,
    },
    clip: {
      segment_id: candidate.segment_id,
      start_sec: candidate.start_sec,
      end_sec: candidate.end_sec,
      transcript: candidate.transcript,
    },
    copy: {
      headline: candidate.headline,
      body: candidate.body,
      footer: candidate.footer,
    },
    copy_evidence_quotes: candidate.copy_evidence_quotes ?? candidate.evidence_quotes,
    packaging: {
      title: titleFor(candidate.headline),
      description,
      tags: ["shorts", "manhwa", "manhwa recap", "anime", "story"],
    },
    related_longform: {
      video_id: ledgerEntry.video_id,
      watch_url: ledgerEntry.watch_url,
      title: ledgerEntry.title,
      release_at: releaseAt,
      state_at_plan_time: ledgerEntry.visibility,
    },
    candidate_quality_score: candidate.quality_score,
    spoiler_risk: candidate.spoiler_risk ?? candidate.spoiler_rating,
  };
});

const campaign = {
  schema: "goldflow_shorts_story_card_campaign_v1",
  status: "approved_for_render_and_schedule",
  campaign_id: "manhwa-joey-story-cards-2026-08-02-through-2026-08-09-v1",
  created_at: new Date().toISOString(),
  output_dir: outputDir,
  source_catalogs: catalogs.map((catalog) => ({ path: catalog.path, sha256: catalog.sha256 })),
  source_upload_ledger: { path: uploadLedgerPath, sha256: await sha256(uploadLedgerPath) },
  youtube_channel: {
    channel_id: "UCZah1gv3wyUfEIvJdTacWjw",
    expected_name: "Manhwa Joey",
    expected_handle: "@ManhwaJoey",
  },
  brand: {
    display_name: "Manhwa Joey",
    handle: "@ManhwaJoey",
    contract_path: "/Users/joel/AniFactoryData/channels/53rebirth/channel_brand/channel_brand_contract.json",
    avatar_path: "/Users/joel/AniFactoryData/channels/53rebirth/channel_brand/manhwa-joey-avatar.jpg",
    banner_path: "/Users/joel/AniFactoryData/channels/53rebirth/channel_brand/manhwa-joey-banner.jpg"
  },
  schedule: {
    timezone: "America/New_York",
    start_date: "2026-08-02",
    end_date: "2026-08-09",
    daily_target: 3,
    daily_min: 2,
    daily_max: 4,
    longform_blackout_minutes: 90,
  },
  canvas: { width: 1080, height: 1920, fps: 60 },
  reading_wpm: 200,
  reading_ratio: { min: 1.7, target: 2.0, max: 2.65 },
  operator_approval: {
    approved: true,
    approved_by: "operator",
    approval_basis: "User explicitly requested 2–4 Shorts scheduled per day through the end of next week.",
    approved_at: new Date().toISOString(),
  },
  items,
};

await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "shorts_campaign.json");
await fs.writeFile(outputPath, `${JSON.stringify(campaign, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: "passed", campaign_path: outputPath, item_count: items.length }, null, 2));
