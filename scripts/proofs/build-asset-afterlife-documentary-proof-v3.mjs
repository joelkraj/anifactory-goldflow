#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

import {
  loadModelslabAccount,
  publicModelslabAccount,
} from "../lib/modelslab-account-pool.mjs";

const execFile = promisify(execFileCb);
const flags = parseFlags(process.argv.slice(2));
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const DEFAULT_EPISODE_DIR = "/Users/joel/AniFactoryData/channels/assetafterlife/weekly_runs/2026-W31-asset-afterlife-lost-luggage-proof-v5/episodes/ep_01";
const episodeDir = path.resolve(flags["episode-dir"] ?? DEFAULT_EPISODE_DIR);
const sourceProofDir = path.resolve(flags["source-proof-dir"] ?? path.join(
  episodeDir,
  "review_samples/hybrid_documentary_parity_proof_v1",
));
const parentProofDir = path.resolve(flags["parent-proof-dir"] ?? path.join(
  episodeDir,
  "review_samples/hybrid_documentary_cold_open_v2",
));
const outputDir = path.resolve(flags["output-dir"] ?? path.join(
  episodeDir,
  "review_samples/hybrid_documentary_cold_open_v3",
));
const sourceDir = path.join(sourceProofDir, "source_media");
const workDir = path.join(outputDir, "work");
const clipDir = path.join(workDir, "clips");
const graphicFrameRoot = path.join(workDir, "graphic_frames");
const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";
const ffprobeBin = process.env.FFPROBE_BIN ?? "ffprobe";
const baselineLockPath = path.join(parentProofDir, "BASELINE_LOCK.json");
const sourceLockPath = path.join(sourceProofDir, "BASELINE_LOCK.json");
const baselineMusicPath = path.join(sourceProofDir, "documentary_underscore.provider-audio");

const narrationSections = [
  "This red suitcase should have been claimed twenty minutes ago. Instead, it keeps circling an empty carousel while its owner argues at the airline desk. Clothes, electronics, photographs, and perhaps thousands of dollars in value are still moving through the airport. It is not officially lost. Not yet.",
  "First, airline systems retrace four digital footprints: handoff, loading, transfer, and return. Each scan records control and the next destination. Miss one, and the search expands through belts, carts, storage rooms, and distant airports. One ordinary suitcase has become a network-wide custody problem.",
  "Most delayed bags are reunited quickly. But when the trail stays cold, many airlines declare a bag lost between five and fourteen days. The question changes. The airline must now calculate what the passenger can prove was inside.",
  "Now the suitcase becomes two problems. The passenger has a financial claim. The airline still has a physical object in its system. On a United States domestic trip, liability can reach forty-seven hundred dollars, plus the baggage fee. Paying the claim closes the financial case. It does not make the suitcase disappear.",
  "The physical search can continue for months. Unclaimed Baggage says airlines search roughly three to four months before orphaned property reaches Alabama. By then, claims are paid and identifying information removed. The bag crosses a boundary: it stops being passenger baggage and becomes inventory.",
  "It arrives by tractor-trailer with thousands of orphaned objects. Workers open each suitcase and make new decisions. What can be sold? Donated? Repurposed? And what is too damaged, too personal, or too unsafe to keep?",
  "Reusable clothing is cleaned. Electronics are tested and personal data erased. Jewelry is assessed. Luxury goods are authenticated. Every item receives its own verdict, because a lost suitcase's surprising value is rarely in the shell. It is scattered across everything packed inside.",
  "Some objects return to retail shelves. Others go to charities. Unclaimed Baggage says it donates one item for every item it sells. Identifying material is shredded. Recyclable textiles and damaged goods enter separate waste streams. The suitcase is being dismantled economically, even when nobody cuts it apart.",
  "So where does lost luggage go? Almost always, back to its owner. But the tiny fraction that survives every scan, search, claim, and recovery enters a hidden second economy. One bag becomes dozens of independent assets, each with a new owner, value, and destination. The first journey ended at baggage claim. The things inside kept going.",
];

const narrationText = narrationSections.join("\n\n");
const scriptSha256 = sha256(narrationText);

const fluxImages = {
  carousel: path.join(episodeDir, "assets/images/ep_01-w000000-w000008-modelslab-image.png"),
  passengerDesk: path.join(episodeDir, "assets/images/ep_01-w000009-w000016-modelslab-image.png"),
  delayedBag: path.join(episodeDir, "assets/images/ep_01-w000088-w000095-modelslab-image.png"),
  claimLedger: path.join(episodeDir, "assets/images/ep_01-w000190-w000201-modelslab-image.png"),
  receiving: path.join(episodeDir, "assets/images/ep_01-w000261-w000270-modelslab-image.png"),
  intake: path.join(episodeDir, "assets/images/ep_01-w000293-w000311-modelslab-image.png"),
  electronics: path.join(episodeDir, "assets/images/ep_01-w000376-w000388-modelslab-image.png"),
  luxury: path.join(episodeDir, "assets/images/ep_01-w000392-w000395-modelslab-image.png"),
  recycling: path.join(episodeDir, "assets/images/ep_01-w000438-w000448-modelslab-image.png"),
};

const timelineBlueprint = [
  { section: 0, kind: "still", id: "carousel_flux", source: fluxImages.carousel, motion: "push_in", weight: 1.0 },
  { section: 0, kind: "graphic", id: "question", graphic: "question", weight: 0.75 },
  { section: 0, kind: "source", id: "carousel_clean", source: "wXZ17FOhY5M.mp4", start: 1.0, weight: 0.9 },
  { section: 0, kind: "still", id: "passenger_desk_flux", source: fluxImages.passengerDesk, motion: "pan_right", weight: 0.8 },

  { section: 1, kind: "source", id: "bag_checkin", source: "_4w9jFDV3Do.mp4", start: 112.0, cropTop: 140, weight: 0.75 },
  { section: 1, kind: "source", id: "tag_scan", source: "_4w9jFDV3Do.mp4", start: 118.0, cropTop: 140, weight: 0.75 },
  { section: 1, kind: "graphic", id: "checkpoints", graphic: "checkpoints", weight: 1.35 },
  { section: 1, kind: "source", id: "scanner_close", source: "WkN7eRmv7E8.mp4", start: 111.0, cropTop: 55, weight: 0.65 },
  { section: 1, kind: "source", id: "sorting_network", source: "wL0wkmah60k.mp4", start: 25.0, cropTop: 45, weight: 0.8 },

  { section: 2, kind: "source", id: "belt_pov_a", source: "_4w9jFDV3Do.mp4", start: 205.0, cropTop: 140, weight: 0.75 },
  { section: 2, kind: "still", id: "delayed_bag_flux", source: fluxImages.delayedBag, motion: "pull_out", weight: 0.8 },
  { section: 2, kind: "graphic", id: "status", graphic: "status", weight: 1.35 },
  { section: 2, kind: "source", id: "empty_belt", source: "wL0wkmah60k.mp4", start: 42.0, cropTop: 45, weight: 0.75 },

  { section: 3, kind: "graphic", id: "two_problems", graphic: "two_problems", weight: 1.05 },
  { section: 3, kind: "source", id: "digital_bag_drop", source: "dDfGMQ_iffA.mp4", start: 7.0, cropTop: 35, weight: 0.7 },
  { section: 3, kind: "graphic", id: "claim_value", graphic: "money", weight: 1.25 },
  { section: 3, kind: "still", id: "claim_ledger_flux", source: fluxImages.claimLedger, motion: "pan_left", weight: 0.75 },

  { section: 4, kind: "source", id: "belt_pov_c", source: "_4w9jFDV3Do.mp4", start: 227.0, cropTop: 140, weight: 0.65 },
  { section: 4, kind: "graphic", id: "route", graphic: "route", weight: 1.25 },
  { section: 4, kind: "source", id: "storefront_arrival", source: "YiwZ3kbtHj4.mp4", start: 4.5, cropTop: 140, weight: 0.7 },
  { section: 4, kind: "still", id: "receiving_flux", source: fluxImages.receiving, motion: "push_in", weight: 0.75 },
  { section: 4, kind: "graphic", id: "identity_change", graphic: "identity", weight: 1.0 },

  { section: 5, kind: "source", id: "bag_opening", source: "YiwZ3kbtHj4.mp4", start: 94.0, cropTop: 140, weight: 0.8 },
  { section: 5, kind: "source", id: "contents_sorting", source: "YiwZ3kbtHj4.mp4", start: 18.0, cropTop: 140, weight: 0.8 },
  { section: 5, kind: "still", id: "intake_flux", source: fluxImages.intake, motion: "push_in", weight: 0.75 },
  { section: 5, kind: "graphic", id: "decision_gate", graphic: "decision_gate", weight: 1.15 },
  { section: 5, kind: "source", id: "sorting_bins", source: "YiwZ3kbtHj4.mp4", start: 231.5, cropTop: 140, weight: 0.75 },

  { section: 6, kind: "source", id: "clothing_racks", source: "YiwZ3kbtHj4.mp4", start: 154.0, cropTop: 140, weight: 0.75 },
  { section: 6, kind: "still", id: "electronics_flux", source: fluxImages.electronics, motion: "pan_right", weight: 0.75 },
  { section: 6, kind: "source", id: "jewelry_appraisal", source: "YiwZ3kbtHj4.mp4", start: 216.0, cropTop: 140, weight: 0.8 },
  { section: 6, kind: "still", id: "luxury_flux", source: fluxImages.luxury, motion: "pull_out", weight: 0.7 },
  { section: 6, kind: "graphic", id: "value_reveal", graphic: "value_reveal", weight: 1.1 },

  { section: 7, kind: "source", id: "second_life_store", source: "YiwZ3kbtHj4.mp4", start: 184.0, cropTop: 140, weight: 0.75 },
  { section: 7, kind: "graphic", id: "one_for_one", graphic: "one_for_one", weight: 1.1 },
  { section: 7, kind: "source", id: "packed_for_sale", source: "YiwZ3kbtHj4.mp4", start: 231.5, cropTop: 140, weight: 0.7 },
  { section: 7, kind: "still", id: "recycling_flux", source: fluxImages.recycling, motion: "pan_left", weight: 0.7 },
  { section: 7, kind: "graphic", id: "outcomes", graphic: "paths", weight: 1.15 },

  { section: 8, kind: "source", id: "final_store", source: "YiwZ3kbtHj4.mp4", start: 168.0, cropTop: 140, weight: 0.7 },
  { section: 8, kind: "graphic", id: "fragmentation", graphic: "fragmentation", weight: 1.25 },
  { section: 8, kind: "source", id: "final_belt", source: "_4w9jFDV3Do.mp4", start: 327.0, cropTop: 140, weight: 0.75 },
  { section: 8, kind: "graphic", id: "final_verdict", graphic: "final", weight: 1.2 },
];

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = parts[index + 1];
    const value = next && !next.startsWith("--") ? next : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

function wordCount(text) {
  return String(text).trim().split(/\s+/u).filter(Boolean).length;
}

function round(value, digits = 3) {
  return Number(Number(value).toFixed(digits));
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function easeOutCubic(value) {
  const t = clamp(value);
  return 1 - ((1 - t) ** 3);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function ensurePath(filePath, label) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size === 0) throw new Error("empty or not a file");
  } catch (error) {
    throw new Error(`${label} is unavailable: ${filePath} (${error.message})`);
  }
}

async function run(command, args, options = {}) {
  return execFile(command, args, {
    cwd: options.cwd ?? process.cwd(),
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  });
}

async function probe(filePath) {
  const { stdout } = await run(ffprobeBin, [
    "-v", "error",
    "-show_entries", "format=duration,size,bit_rate:stream=index,codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels",
    "-of", "json",
    filePath,
  ]);
  return JSON.parse(stdout);
}

function durationFromProbe(value) {
  return Number(value?.format?.duration ?? 0);
}

function responseLinks(value) {
  const links = [];
  for (const candidate of [value?.output, value?.proxy_links, value?.future_links]) {
    if (Array.isArray(candidate)) links.push(...candidate);
    else if (typeof candidate === "string" && candidate.trim()) links.push(candidate.trim());
  }
  return links.filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postModelslab(account, endpoint, body, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(`https://modelslab.com${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: account.apiKey, ...body }),
    });
    const raw = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const status = String(parsed?.status ?? "").toLowerCase();
    if (response.ok && !["failed", "error"].includes(status)) return parsed;
    const message = String(parsed?.message ?? raw);
    const retryable = response.status === 429 || response.status >= 500 || /queue|rate limit|try again/iu.test(message);
    if (!retryable || attempt === attempts) {
      throw new Error(`${endpoint} failed (${response.status}): ${message.slice(0, 800)}`);
    }
    await sleep(2500 * attempt);
  }
  throw new Error(`${endpoint} exhausted retries`);
}

async function resolveModelslabAudio(account, initial) {
  let current = initial;
  const requestId = initial?.id;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const links = responseLinks(current);
    const status = String(current?.status ?? "").toLowerCase();
    if (links.length && ["success", "completed"].includes(status)) return { response: current, url: links[0] };
    if (["failed", "error"].includes(status)) {
      throw new Error(`ModelsLab audio request failed: ${String(current?.message ?? "unknown failure")}`);
    }
    if (!requestId) {
      if (links.length) return { response: current, url: links[0] };
      throw new Error("ModelsLab audio request returned neither an output URL nor a request id.");
    }
    await sleep(4000);
    current = await postModelslab(account, `/api/v7/voice/fetch/${requestId}`, {});
  }
  throw new Error(`ModelsLab audio request ${requestId} timed out.`);
}

async function download(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  await ensurePath(outputPath, "downloaded provider audio");
}

async function generateProviderAudio({
  account,
  id,
  endpoint,
  request,
}) {
  const providerPath = path.join(outputDir, `${id}.provider-audio`);
  const metaPath = path.join(outputDir, `${id}.provider.json`);
  const requestHash = sha256(JSON.stringify(request));
  try {
    const previous = JSON.parse(await fs.readFile(metaPath, "utf8"));
    if (previous.request_sha256 === requestHash) {
      await ensurePath(providerPath, `${id} cached provider audio`);
      return {
        providerPath,
        requestId: previous.request_id ?? null,
        requestHash,
        reused: true,
      };
    }
  } catch {
    // A missing or stale cache is regenerated below.
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const initial = await postModelslab(account, endpoint, request);
  const resolved = await resolveModelslabAudio(account, initial);
  await download(resolved.url, providerPath);
  const record = {
    schema: "goldflow_private_proof_provider_audio_v1",
    id,
    endpoint,
    request,
    request_sha256: requestHash,
    request_id: initial?.id ?? resolved.response?.id ?? null,
    account: publicModelslabAccount(account),
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    elapsed_sec: round((Date.now() - started) / 1000),
    provider_audio_path: providerPath,
    provider_audio_sha256: await sha256File(providerPath),
    output_url: resolved.url,
  };
  await fs.writeFile(metaPath, `${JSON.stringify(record, null, 2)}\n`);
  return {
    providerPath,
    requestId: record.request_id,
    requestHash,
    reused: false,
  };
}

async function buildNarration(account) {
  const request = {
    prompt: narrationText,
    voice_id: "pNInz6obpgDQGcFmaJgB",
    model_id: "eleven_multilingual_v2",
    voice_settings: {
      stability: 0.56,
      similarity_boost: 0.78,
      style: 0.15,
      use_speaker_boost: true,
      speed: 1.1,
    },
  };
  const generated = await generateProviderAudio({
    account,
    id: "narration_elevenlabs_adam_v3",
    endpoint: "/api/v7/voice/text-to-speech",
    request,
  });
  const narrationPath = path.join(outputDir, "narration_elevenlabs_adam_v3.wav");
  await run(ffmpegBin, [
    "-y", "-v", "error",
    "-i", generated.providerPath,
    "-vn",
    "-af", "highpass=f=58,loudnorm=I=-16:LRA=6:TP=-1.5",
    "-ar", "48000",
    "-ac", "2",
    "-c:a", "pcm_s24le",
    narrationPath,
  ]);
  return {
    ...generated,
    narrationPath,
    probe: await probe(narrationPath),
  };
}

async function buildMusic() {
  await ensurePath(baselineMusicPath, "locked v1 documentary underscore");
  return {
    providerPath: baselineMusicPath,
    requestId: null,
    requestHash: null,
    reused: true,
    source: "locked_v1_baseline",
  };
}

async function buildSfxBank() {
  const specs = [
    {
      id: "sfx_carousel_room",
      prompt: "Close clean ambience of an airport baggage carousel running in a mostly empty hall, soft motor hum, rubber belt movement, occasional suitcase wheel rattle, no voices, no announcements, no music",
    },
    {
      id: "sfx_scanner_beep",
      prompt: "A single crisp airport baggage barcode scanner confirmation beep with a short electronic tail, isolated, no voices, no music",
    },
    {
      id: "sfx_bag_thump",
      prompt: "One medium hard-shell suitcase landing on a rubber luggage conveyor with a controlled low thump and brief wheel rattle, isolated, no voices, no music",
    },
    {
      id: "sfx_zipper_sort",
      prompt: "A suitcase zipper opening followed by a brief clean rustle of folded clothing on a sorting table, close microphone, isolated, no voices, no music",
    },
  ];
  const results = await Promise.all(specs.map(async (spec) => {
    const providerPath = path.join(parentProofDir, `${spec.id}.provider-audio`);
    try {
      await ensurePath(providerPath, `${spec.id} locked v2 sound cue`);
      return {
        ...spec,
        providerPath,
        requestId: null,
        requestHash: null,
        reused: true,
        source: "locked_v2_baseline",
        status: "available",
      };
    } catch (error) {
      return { ...spec, status: "omitted_after_provider_failure", error: error.message };
    }
  }));
  return Object.fromEntries(results.map((item) => [item.id, item]));
}

function suitcaseSvg({ x, y, scale = 1, fill = "#E35732", stroke = "#101923", opacity = 1 }) {
  const bodyWidth = 112 * scale;
  const bodyHeight = 142 * scale;
  const radius = 18 * scale;
  const strokeWidth = 7 * scale;
  return `
    <g opacity="${opacity}">
      <rect x="${x}" y="${y}" width="${bodyWidth}" height="${bodyHeight}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>
      <path d="M ${x + 34 * scale} ${y} v ${-27 * scale} q 0 ${-13 * scale} ${13 * scale} ${-13 * scale} h ${18 * scale} q ${13 * scale} 0 ${13 * scale} ${13 * scale} v ${27 * scale}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
      <path d="M ${x + 30 * scale} ${y + 30 * scale} v ${82 * scale} M ${x + 56 * scale} ${y + 30 * scale} v ${82 * scale} M ${x + 82 * scale} ${y + 30 * scale} v ${82 * scale}" stroke="#F8EBDD" stroke-width="${4 * scale}" opacity="0.42"/>
      <circle cx="${x + 25 * scale}" cy="${y + bodyHeight + 7 * scale}" r="${8 * scale}" fill="${stroke}"/>
      <circle cx="${x + bodyWidth - 25 * scale}" cy="${y + bodyHeight + 7 * scale}" r="${8 * scale}" fill="${stroke}"/>
    </g>`;
}

function baseSvg({ background = "#F5F0E6", content }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${background}"/>
    <g font-family="Avenir Next, Helvetica Neue, sans-serif">${content}</g>
  </svg>`;
}

function graphicSvg(kind, progress) {
  const p = clamp(progress);
  const eased = easeOutCubic(p);
  if (kind === "question") {
    const titleX = 138 - ((1 - eased) * 90);
    const opacity = clamp(p * 4);
    const suitcaseX = 1430 - ((1 - eased) * 190);
    return baseSvg({
      background: "#101923",
      content: `
        <circle cx="1680" cy="130" r="420" fill="#18323B" opacity="0.68"/>
        <path d="M 0 908 H ${Math.round(1920 * eased)}" stroke="#E35732" stroke-width="22"/>
        <text x="${titleX}" y="190" fill="#78B4A8" font-size="34" font-weight="700" letter-spacing="7" opacity="${opacity}">ASSET AFTERLIFE</text>
        <text x="${titleX}" y="465" fill="#F5F0E6" font-size="146" font-weight="800" letter-spacing="-5" opacity="${opacity}">WHERE DOES</text>
        <text x="${titleX}" y="625" fill="#F5F0E6" font-size="146" font-weight="800" letter-spacing="-5" opacity="${opacity}">IT GO?</text>
        <text x="145" y="750" fill="#A6B4B4" font-size="34" font-weight="500" opacity="${opacity}">The public journey ends. The hidden one begins.</text>
        ${suitcaseSvg({ x: suitcaseX, y: 390, scale: 2.25, stroke: "#F5F0E6", opacity })}
      `,
    });
  }

  if (kind === "checkpoints") {
    const points = [250, 720, 1190, 1660];
    const labels = ["HANDOFF", "LOADING", "TRANSFER", "RETURN"];
    const lineStart = points[0];
    const lineEnd = points.at(-1);
    const lineProgress = clamp((p - 0.12) / 0.76);
    const dotX = lineStart + ((lineEnd - lineStart) * lineProgress);
    const nodes = points.map((x, index) => {
      const nodeProgress = clamp((lineProgress * 3.2) - (index * 0.95));
      const active = nodeProgress > 0.15;
      return `
        <circle cx="${x}" cy="585" r="54" fill="${active ? "#E35732" : "#E7DED0"}" stroke="#101923" stroke-width="7"/>
        <text x="${x}" y="596" text-anchor="middle" fill="${active ? "#F5F0E6" : "#101923"}" font-size="34" font-weight="800">${index + 1}</text>
        <text x="${x}" y="705" text-anchor="middle" fill="#101923" font-size="30" font-weight="800" letter-spacing="2">${labels[index]}</text>`;
    }).join("");
    return baseSvg({
      content: `
        <text x="130" y="165" fill="#E35732" font-size="31" font-weight="800" letter-spacing="6">THE TRACKING SYSTEM</text>
        <text x="130" y="285" fill="#101923" font-size="88" font-weight="800" letter-spacing="-3">EVERY BAG LEAVES A TRAIL</text>
        <line x1="${lineStart}" y1="585" x2="${lineEnd}" y2="585" stroke="#D7CDBF" stroke-width="18" stroke-linecap="round"/>
        <line x1="${lineStart}" y1="585" x2="${dotX}" y2="585" stroke="#78B4A8" stroke-width="18" stroke-linecap="round"/>
        ${nodes}
        ${suitcaseSvg({ x: dotX - 33, y: 455, scale: 0.58, stroke: "#101923" })}
        <text x="130" y="930" fill="#667473" font-size="34" font-weight="500">One missing scan can send the search across the entire network.</text>
      `,
    });
  }

  if (kind === "status") {
    const arrow = clamp((p - 0.15) / 0.55);
    const lostOpacity = clamp((p - 0.48) * 3.8);
    return baseSvg({
      background: "#101923",
      content: `
        <text x="130" y="150" fill="#78B4A8" font-size="31" font-weight="800" letter-spacing="6">WHEN THE SEARCH FAILS</text>
        <rect x="130" y="255" width="680" height="520" rx="34" fill="#1D3941" stroke="#78B4A8" stroke-width="5"/>
        <text x="470" y="435" text-anchor="middle" fill="#A7D2C8" font-size="48" font-weight="800" letter-spacing="6">DELAYED</text>
        <text x="470" y="585" text-anchor="middle" fill="#F5F0E6" font-size="118" font-weight="800">SEARCHING</text>
        <path d="M 830 515 H ${830 + (230 * arrow)}" stroke="#F5F0E6" stroke-width="20" stroke-linecap="round"/>
        <path d="M ${1030 + (30 * arrow)} 465 L ${1090 + (30 * arrow)} 515 L ${1030 + (30 * arrow)} 565" fill="none" stroke="#F5F0E6" stroke-width="20" stroke-linecap="round" stroke-linejoin="round" opacity="${arrow}"/>
        <rect x="1110" y="255" width="680" height="520" rx="34" fill="#E35732" opacity="${0.18 + (0.82 * lostOpacity)}" stroke="#F29A75" stroke-width="5"/>
        <text x="1450" y="435" text-anchor="middle" fill="#FFE3D6" font-size="48" font-weight="800" letter-spacing="6" opacity="${lostOpacity}">LOST</text>
        <text x="1450" y="585" text-anchor="middle" fill="#FFFFFF" font-size="124" font-weight="800" opacity="${lostOpacity}">5–14 DAYS</text>
        <text x="960" y="915" text-anchor="middle" fill="#A6B4B4" font-size="34" font-weight="500">For many airlines, that is when the case changes.</text>
      `,
    });
  }

  if (kind === "money") {
    const value = Math.round(4700 * easeOutCubic(clamp((p - 0.08) / 0.72)));
    const receiptHeight = 180 + (420 * easeOutCubic(clamp((p - 0.2) / 0.7)));
    return baseSvg({
      background: "#142A30",
      content: `
        <rect x="1210" y="185" width="500" height="${receiptHeight}" rx="28" fill="#F5F0E6" transform="rotate(4 1460 480)"/>
        <path d="M 1270 315 H 1640 M 1270 390 H 1580 M 1270 465 H 1610 M 1270 540 H 1510" stroke="#C8BEB0" stroke-width="18" stroke-linecap="round" transform="rotate(4 1460 480)"/>
        <text x="130" y="175" fill="#78B4A8" font-size="31" font-weight="800" letter-spacing="6">THE SEARCH BECOMES A CLAIM</text>
        <text x="130" y="545" fill="#F5F0E6" font-size="230" font-weight="800" letter-spacing="-10">$${value.toLocaleString("en-US")}</text>
        <text x="145" y="665" fill="#F29A75" font-size="41" font-weight="800" letter-spacing="3">MAXIMUM LIABILITY</text>
        <text x="145" y="735" fill="#A6B4B4" font-size="32" font-weight="500">U.S. domestic baggage</text>
        <path d="M 130 865 H ${130 + (900 * eased)}" stroke="#E35732" stroke-width="18"/>
        <text x="130" y="945" fill="#F5F0E6" font-size="36" font-weight="600">The claim can close while the suitcase keeps moving.</text>
      `,
    });
  }

  if (kind === "route") {
    const routeProgress = easeOutCubic(clamp((p - 0.12) / 0.75));
    const x1 = 250;
    const x2 = 1670;
    const dotX = x1 + ((x2 - x1) * routeProgress);
    return baseSvg({
      content: `
        <text x="130" y="155" fill="#E35732" font-size="31" font-weight="800" letter-spacing="6">THE PHYSICAL BAG</text>
        <text x="130" y="275" fill="#101923" font-size="91" font-weight="800" letter-spacing="-3">THE JOURNEY ISN'T OVER</text>
        <path d="M ${x1} 620 C 610 420, 1240 820, ${x2} 560" fill="none" stroke="#D7CDBF" stroke-width="18" stroke-linecap="round"/>
        <path d="M ${x1} 620 C ${x1 + ((360) * routeProgress)} ${620 - (200 * routeProgress)}, ${x1 + ((990) * routeProgress)} ${620 + (200 * routeProgress)}, ${dotX} ${620 - (60 * routeProgress)}" fill="none" stroke="#78B4A8" stroke-width="18" stroke-linecap="round"/>
        ${suitcaseSvg({ x: dotX - 45, y: 492 - (60 * routeProgress), scale: 0.78 })}
        <circle cx="250" cy="620" r="26" fill="#E35732"/>
        <circle cx="1670" cy="560" r="26" fill="#E35732"/>
        <text x="250" y="760" text-anchor="middle" fill="#101923" font-size="31" font-weight="800">AIRLINE SEARCH</text>
        <text x="960" y="565" text-anchor="middle" fill="#E35732" font-size="91" font-weight="800" opacity="${clamp((p - 0.32) * 2.5)}">3–4 MONTHS</text>
        <text x="1670" y="700" text-anchor="middle" fill="#101923" font-size="31" font-weight="800">ALABAMA</text>
        <text x="960" y="930" text-anchor="middle" fill="#667473" font-size="34" font-weight="500">Only the truly orphaned bags reach the second system.</text>
      `,
    });
  }

  if (kind === "two_problems") {
    const split = easeOutCubic(clamp((p - 0.08) / 0.72));
    const leftX = 130 - ((1 - split) * 120);
    const rightX = 1030 + ((1 - split) * 120);
    return baseSvg({
      background: "#101923",
      content: `
        <text x="130" y="150" fill="#78B4A8" font-size="31" font-weight="800" letter-spacing="6">THE MOMENT IT BECOMES LOST</text>
        <text x="130" y="270" fill="#F5F0E6" font-size="92" font-weight="800" letter-spacing="-3">ONE SUITCASE.</text>
        <text x="130" y="375" fill="#F5F0E6" font-size="92" font-weight="800" letter-spacing="-3">TWO PROBLEMS.</text>
        <rect x="${leftX}" y="490" width="760" height="355" rx="32" fill="#1D3941" stroke="#78B4A8" stroke-width="5" opacity="${split}"/>
        <text x="${leftX + 380}" y="610" text-anchor="middle" fill="#A7D2C8" font-size="31" font-weight="800" letter-spacing="5" opacity="${split}">THE PERSON</text>
        <text x="${leftX + 380}" y="735" text-anchor="middle" fill="#F5F0E6" font-size="68" font-weight="800" opacity="${split}">FINANCIAL CLAIM</text>
        <rect x="${rightX}" y="490" width="760" height="355" rx="32" fill="#422B29" stroke="#E35732" stroke-width="5" opacity="${split}"/>
        <text x="${rightX + 380}" y="610" text-anchor="middle" fill="#F6B49A" font-size="31" font-weight="800" letter-spacing="5" opacity="${split}">THE OBJECT</text>
        <text x="${rightX + 380}" y="735" text-anchor="middle" fill="#F5F0E6" font-size="68" font-weight="800" opacity="${split}">PHYSICAL ASSET</text>
        <line x1="960" y1="470" x2="960" y2="900" stroke="#F5F0E6" stroke-width="7" opacity="${0.35 * split}"/>
      `,
    });
  }

  if (kind === "identity") {
    const arrow = easeOutCubic(clamp((p - 0.15) / 0.65));
    const inventoryOpacity = clamp((p - 0.48) * 3.4);
    return baseSvg({
      content: `
        <text x="130" y="155" fill="#E35732" font-size="31" font-weight="800" letter-spacing="6">THE CUSTODY CHANGE</text>
        <text x="130" y="285" fill="#101923" font-size="92" font-weight="800" letter-spacing="-3">THE BAG CHANGES IDENTITY</text>
        <rect x="145" y="455" width="610" height="315" rx="34" fill="#E7DED0" stroke="#101923" stroke-width="6"/>
        <text x="450" y="585" text-anchor="middle" fill="#667473" font-size="32" font-weight="800" letter-spacing="5">BEFORE</text>
        <text x="450" y="690" text-anchor="middle" fill="#101923" font-size="75" font-weight="800">BAGGAGE</text>
        <path d="M 800 610 H ${800 + (270 * arrow)}" stroke="#78B4A8" stroke-width="22" stroke-linecap="round"/>
        <path d="M ${1030 + (20 * arrow)} 555 L ${1100 + (20 * arrow)} 610 L ${1030 + (20 * arrow)} 665" fill="none" stroke="#78B4A8" stroke-width="22" stroke-linecap="round" stroke-linejoin="round" opacity="${arrow}"/>
        <rect x="1165" y="455" width="610" height="315" rx="34" fill="#E35732" opacity="${0.15 + (0.85 * inventoryOpacity)}"/>
        <text x="1470" y="585" text-anchor="middle" fill="#FFE3D6" font-size="32" font-weight="800" letter-spacing="5" opacity="${inventoryOpacity}">AFTER</text>
        <text x="1470" y="690" text-anchor="middle" fill="#FFFFFF" font-size="75" font-weight="800" opacity="${inventoryOpacity}">INVENTORY</text>
        <text x="960" y="930" text-anchor="middle" fill="#667473" font-size="34" font-weight="500">The owner leaves the route. The value does not.</text>
      `,
    });
  }

  if (kind === "decision_gate") {
    const options = [
      { x: 120, label: "SELL?", color: "#78B4A8" },
      { x: 555, label: "DONATE?", color: "#F1B45B" },
      { x: 990, label: "REPURPOSE?", color: "#8E9BB8" },
      { x: 1425, label: "DISCARD?", color: "#E35732" },
    ];
    const cards = options.map((item, index) => {
      const reveal = clamp((p * 5) - (index + 0.45));
      const y = 455 + ((1 - easeOutCubic(reveal)) * 90);
      return `
        <rect x="${item.x}" y="${y}" width="375" height="330" rx="32" fill="${item.color}" opacity="${0.12 + (0.88 * reveal)}"/>
        <text x="${item.x + 187.5}" y="${y + 195}" text-anchor="middle" fill="#F5F0E6" font-size="47" font-weight="800" letter-spacing="2" opacity="${reveal}">${item.label}</text>`;
    }).join("");
    return baseSvg({
      background: "#101923",
      content: `
        <text x="130" y="150" fill="#78B4A8" font-size="31" font-weight="800" letter-spacing="6">THE SECOND INSPECTION</text>
        <text x="130" y="285" fill="#F5F0E6" font-size="94" font-weight="800" letter-spacing="-3">EVERY OBJECT FACES A DECISION</text>
        ${cards}
        <text x="960" y="930" text-anchor="middle" fill="#A6B4B4" font-size="34" font-weight="500">The suitcase is no longer judged as one thing.</text>
      `,
    });
  }

  if (kind === "value_reveal") {
    const reveal = easeOutCubic(clamp((p - 0.08) / 0.78));
    const rays = Array.from({ length: 7 }, (_, index) => {
      const angle = (-120 + (index * 40)) * (Math.PI / 180);
      const x2 = 960 + (400 * reveal * Math.cos(angle));
      const y2 = 610 + (290 * reveal * Math.sin(angle));
      return `<line x1="960" y1="610" x2="${x2}" y2="${y2}" stroke="#78B4A8" stroke-width="9" opacity="${0.58 * reveal}"/>`;
    }).join("");
    return baseSvg({
      content: `
        <text x="130" y="150" fill="#E35732" font-size="31" font-weight="800" letter-spacing="6">THE VALUABLE REVEAL</text>
        <text x="130" y="280" fill="#101923" font-size="91" font-weight="800" letter-spacing="-3">THE SHELL ISN'T THE ASSET</text>
        ${rays}
        ${suitcaseSvg({ x: 864, y: 485, scale: 1.7, stroke: "#101923", opacity: reveal })}
        <text x="960" y="930" text-anchor="middle" fill="#101923" font-size="58" font-weight="800" opacity="${reveal}">THE VALUE IS SCATTERED INSIDE</text>
      `,
    });
  }

  if (kind === "one_for_one") {
    const sold = easeOutCubic(clamp((p - 0.08) / 0.55));
    const donated = easeOutCubic(clamp((p - 0.35) / 0.55));
    return baseSvg({
      background: "#142A30",
      content: `
        <text x="130" y="150" fill="#78B4A8" font-size="31" font-weight="800" letter-spacing="6">THE SURPRISING SPLIT</text>
        <text x="130" y="285" fill="#F5F0E6" font-size="95" font-weight="800" letter-spacing="-3">FOR EVERY ITEM SOLD...</text>
        <circle cx="520" cy="635" r="210" fill="#78B4A8" opacity="${sold}"/>
        <text x="520" y="615" text-anchor="middle" fill="#101923" font-size="126" font-weight="800" opacity="${sold}">1</text>
        <text x="520" y="720" text-anchor="middle" fill="#101923" font-size="45" font-weight="800" letter-spacing="5" opacity="${sold}">SOLD</text>
        <text x="960" y="670" text-anchor="middle" fill="#F5F0E6" font-size="118" font-weight="700" opacity="${clamp((p - 0.25) * 3)}">=</text>
        <circle cx="1400" cy="635" r="210" fill="#F1B45B" opacity="${donated}"/>
        <text x="1400" y="615" text-anchor="middle" fill="#101923" font-size="126" font-weight="800" opacity="${donated}">1</text>
        <text x="1400" y="720" text-anchor="middle" fill="#101923" font-size="45" font-weight="800" letter-spacing="5" opacity="${donated}">DONATED</text>
        <text x="960" y="965" text-anchor="middle" fill="#A6B4B4" font-size="31" font-weight="500">Published average from Unclaimed Baggage</text>
      `,
    });
  }

  if (kind === "fragmentation") {
    const reveal = easeOutCubic(clamp((p - 0.08) / 0.78));
    const destinations = [
      { x: 250, y: 660, label: "NEW OWNER", color: "#78B4A8" },
      { x: 680, y: 820, label: "CHARITY", color: "#F1B45B" },
      { x: 1240, y: 820, label: "RAW MATERIAL", color: "#8E9BB8" },
      { x: 1670, y: 660, label: "DISCARD", color: "#E35732" },
    ];
    const paths = destinations.map((item, index) => {
      const itemReveal = clamp((reveal * 4.4) - (index * 0.65));
      return `
        <line x1="960" y1="545" x2="${960 + ((item.x - 960) * itemReveal)}" y2="${545 + ((item.y - 545) * itemReveal)}" stroke="${item.color}" stroke-width="11" opacity="${itemReveal}"/>
        <circle cx="${item.x}" cy="${item.y}" r="92" fill="${item.color}" opacity="${itemReveal}"/>
        <text x="${item.x}" y="${item.y + 145}" text-anchor="middle" fill="#101923" font-size="29" font-weight="800" letter-spacing="2" opacity="${itemReveal}">${item.label}</text>`;
    }).join("");
    return baseSvg({
      content: `
        <text x="130" y="150" fill="#E35732" font-size="31" font-weight="800" letter-spacing="6">THE FINAL ANSWER</text>
        <text x="130" y="275" fill="#101923" font-size="94" font-weight="800" letter-spacing="-3">THE SUITCASE DISAPPEARS IN PIECES</text>
        ${suitcaseSvg({ x: 882, y: 390, scale: 1.4, stroke: "#101923", opacity: reveal })}
        ${paths}
      `,
    });
  }

  if (kind === "paths") {
    const labels = [
      { x: 250, label: "SELL", color: "#78B4A8" },
      { x: 730, label: "DONATE", color: "#F1B45B" },
      { x: 1210, label: "RECYCLE", color: "#E35732" },
    ];
    const reveals = labels.map((item, index) => {
      const reveal = clamp((p * 4) - (index + 0.6));
      return `
        <path d="M 960 535 C 960 670, ${item.x + 160} 650, ${item.x + 160} 760" fill="none" stroke="${item.color}" stroke-width="13" stroke-linecap="round" opacity="${reveal}"/>
        <rect x="${item.x}" y="760" width="320" height="145" rx="28" fill="${item.color}" opacity="${0.14 + (0.86 * reveal)}"/>
        <text x="${item.x + 160}" y="855" text-anchor="middle" fill="#F5F0E6" font-size="44" font-weight="800" letter-spacing="3" opacity="${reveal}">${item.label}</text>`;
    }).join("");
    return baseSvg({
      background: "#101923",
      content: `
        <text x="130" y="150" fill="#78B4A8" font-size="31" font-weight="800" letter-spacing="6">THE FINAL SORT</text>
        <text x="130" y="285" fill="#F5F0E6" font-size="96" font-weight="800" letter-spacing="-3">ONE BAG. THREE OUTCOMES.</text>
        ${suitcaseSvg({ x: 866, y: 380, scale: 1.7, stroke: "#F5F0E6" })}
        ${reveals}
      `,
    });
  }

  const reveal = easeOutCubic(clamp(p * 1.5));
  return baseSvg({
    background: "#F5F0E6",
    content: `
      <rect x="0" y="0" width="${Math.round(650 * reveal)}" height="1080" fill="#E35732"/>
      ${suitcaseSvg({ x: 235 - ((1 - reveal) * 100), y: 340, scale: 2.7, stroke: "#F5F0E6", opacity: reveal })}
      <text x="760" y="260" fill="#78B4A8" font-size="31" font-weight="800" letter-spacing="6" opacity="${reveal}">THE VERDICT</text>
      <text x="760" y="455" fill="#101923" font-size="108" font-weight="800" letter-spacing="-4" opacity="${reveal}">A HIDDEN</text>
      <text x="760" y="575" fill="#101923" font-size="108" font-weight="800" letter-spacing="-4" opacity="${reveal}">SECOND ECONOMY</text>
      <text x="765" y="710" fill="#667473" font-size="38" font-weight="500" opacity="${reveal}">The bag stops being luggage.</text>
      <text x="765" y="775" fill="#667473" font-size="38" font-weight="500" opacity="${reveal}">Its contents begin new journeys.</text>
      <path d="M 760 880 H ${760 + (870 * reveal)}" stroke="#E35732" stroke-width="20"/>
    `,
  });
}

async function encodeGraphicClip(item, outputPath) {
  const frameDir = path.join(graphicFrameRoot, item.id);
  await fs.rm(frameDir, { recursive: true, force: true });
  await fs.mkdir(frameDir, { recursive: true });
  const frameCount = Math.max(2, Math.ceil(item.duration_sec * FPS));
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= frameCount) return;
      const progress = frameCount <= 1 ? 1 : index / (frameCount - 1);
      const svg = graphicSvg(item.graphic, progress);
      await sharp(Buffer.from(svg))
        .png({ compressionLevel: 4, adaptiveFiltering: true })
        .toFile(path.join(frameDir, `frame-${String(index).padStart(5, "0")}.png`));
    }
  }
  await Promise.all(Array.from({ length: 10 }, () => worker()));
  await run(ffmpegBin, [
    "-y", "-v", "error",
    "-framerate", String(FPS),
    "-i", path.join(frameDir, "frame-%05d.png"),
    "-t", String(item.duration_sec),
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "17",
    "-pix_fmt", "yuv420p",
    "-r", String(FPS),
    "-movflags", "+faststart",
    outputPath,
  ]);
  await fs.rm(frameDir, { recursive: true, force: true });
}

async function encodeSourceClip(item, outputPath) {
  const sourcePath = path.join(sourceDir, item.source);
  await ensurePath(sourcePath, item.id);
  const cropTop = Math.max(0, Number(item.cropTop ?? 0));
  const cropBottom = Math.max(0, Number(item.cropBottom ?? 0));
  const sourceCrop = cropTop || cropBottom
    ? `crop=iw:ih-${cropTop + cropBottom}:0:${cropTop},`
    : "";
  await run(ffmpegBin, [
    "-y", "-v", "error",
    "-i", sourcePath,
    "-ss", String(item.start ?? 0),
    "-t", String(item.duration_sec),
    "-an",
    "-vf", `${sourceCrop}scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS},eq=contrast=1.045:saturation=0.92:gamma=0.985,vignette=PI/11`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "17",
    "-pix_fmt", "yuv420p",
    "-r", String(FPS),
    "-movflags", "+faststart",
    outputPath,
  ]);
}

async function encodeStillClip(item, outputPath) {
  await ensurePath(item.source, item.id);
  const frames = Math.max(2, Math.ceil(item.duration_sec * FPS));
  const motion = item.motion ?? "push_in";
  const pullOut = motion === "pull_out";
  const zoom = pullOut
    ? "if(eq(on,1),1.085,max(zoom-0.00055,1.0))"
    : "min(zoom+0.0007,1.075)";
  const x = motion === "pan_right"
    ? `min(iw-iw/zoom,(on/${frames})*(iw-iw/zoom))`
    : motion === "pan_left"
      ? `max(0,(iw-iw/zoom)-((on/${frames})*(iw-iw/zoom)))`
      : "iw/2-(iw/zoom/2)";
  await run(ffmpegBin, [
    "-y", "-v", "error",
    "-loop", "1",
    "-i", item.source,
    "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},zoompan=z='${zoom}':x='${x}':y='ih/2-(ih/zoom/2)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS},trim=duration=${item.duration_sec},setsar=1,eq=contrast=1.025:saturation=0.94:gamma=0.99,vignette=PI/14`,
    "-frames:v", String(frames),
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "17",
    "-pix_fmt", "yuv420p",
    "-r", String(FPS),
    "-movflags", "+faststart",
    outputPath,
  ]);
}

function materializeTimeline(narrationDuration) {
  const tailSec = 0.8;
  const visualDuration = narrationDuration + tailSec;
  const sectionWordCounts = narrationSections.map(wordCount);
  const totalWords = sectionWordCounts.reduce((sum, value) => sum + value, 0);
  const sectionDurations = sectionWordCounts.map((count) => visualDuration * (count / totalWords));
  const items = timelineBlueprint.map((item) => ({ ...item }));
  for (let section = 0; section < narrationSections.length; section += 1) {
    const scoped = items.filter((item) => item.section === section);
    const weightTotal = scoped.reduce((sum, item) => sum + item.weight, 0);
    let allocated = 0;
    for (let index = 0; index < scoped.length; index += 1) {
      const item = scoped[index];
      const isLast = index === scoped.length - 1;
      const rawDuration = isLast
        ? sectionDurations[section] - allocated
        : sectionDurations[section] * (item.weight / weightTotal);
      item.duration_sec = round(Math.max(1.5, rawDuration), 4);
      allocated += item.duration_sec;
    }
  }
  let cursor = 0;
  for (const item of items) {
    item.timeline_start_sec = round(cursor, 4);
    cursor += item.duration_sec;
    item.timeline_end_sec = round(cursor, 4);
  }
  return {
    items,
    visual_duration_sec: round(cursor, 4),
    requested_visual_duration_sec: round(visualDuration, 4),
    section_word_counts: sectionWordCounts,
    section_durations_sec: sectionDurations.map((value) => round(value, 4)),
  };
}

async function buildTimeline(timeline) {
  await fs.mkdir(clipDir, { recursive: true });
  const encoded = [];
  for (let index = 0; index < timeline.items.length; index += 1) {
    const item = timeline.items[index];
    const outputPath = path.join(clipDir, `${String(index + 1).padStart(2, "0")}-${item.id}.mp4`);
    process.stderr.write(`[visual ${index + 1}/${timeline.items.length}] ${item.id}\n`);
    if (item.kind === "source") await encodeSourceClip(item, outputPath);
    else if (item.kind === "still") await encodeStillClip(item, outputPath);
    else await encodeGraphicClip(item, outputPath);
    const itemProbe = await probe(outputPath);
    encoded.push({
      ...item,
      output_path: outputPath,
      output_sha256: await sha256File(outputPath),
      encoded_duration_sec: round(durationFromProbe(itemProbe), 4),
    });
  }
  const concatPath = path.join(workDir, "timeline.ffconcat");
  const concatText = ["ffconcat version 1.0", ...encoded.map((item) => `file '${item.output_path.replaceAll("'", "'\\''")}'`)].join("\n");
  await fs.writeFile(concatPath, `${concatText}\n`);
  const silentPath = path.join(workDir, "hybrid_visual_silent.mp4");
  await run(ffmpegBin, [
    "-y", "-v", "error",
    "-f", "concat",
    "-safe", "0",
    "-i", concatPath,
    "-an",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "16",
    "-pix_fmt", "yuv420p",
    "-r", String(FPS),
    "-movflags", "+faststart",
    silentPath,
  ]);
  return { encoded, silentPath, probe: await probe(silentPath) };
}

function cueStart(timeline, clipId, offset = 0) {
  const item = timeline.find((entry) => entry.id === clipId);
  return Math.max(0, Number(item?.timeline_start_sec ?? 0) + offset);
}

async function mixFinal({ silentPath, narrationPath, musicPath, sfxBank, timeline, outputPath, targetDuration }) {
  const inputs = ["-i", silentPath, "-i", narrationPath];
  const filters = [
    `[1:a]highpass=f=58,acompressor=threshold=-20dB:ratio=1.7:attack=12:release=160:makeup=1.2dB,apad=pad_dur=1.2,atrim=0:${targetDuration},asetpts=N/SR/TB,asplit=2[voice][voicekey]`,
  ];
  const mixLabels = ["[voice]"];
  let inputIndex = 2;
  if (musicPath) {
    inputs.push("-stream_loop", "-1", "-i", musicPath);
    const fadeOutStart = Math.max(0, targetDuration - 3.2);
    filters.push(
      `[${inputIndex}:a]atrim=0:${targetDuration},asetpts=N/SR/TB,highpass=f=35,lowpass=f=12500,volume='if(lt(t,8),0.075,if(between(t,62,69),0.045,if(between(t,128,136),0.05,0.105)))':eval=frame,afade=t=in:st=0:d=1.4,afade=t=out:st=${fadeOutStart}:d=3[bedraw]`,
      "[bedraw][voicekey]sidechaincompress=threshold=0.022:ratio=8:attack=12:release=360[bed]",
    );
    mixLabels.push("[bed]");
    inputIndex += 1;
  }
  const cueSpecs = [
    { id: "sfx_carousel_room", clip: "carousel_flux", offset: 0, duration: 8.5, volume: 0.095, loop: true },
    { id: "sfx_scanner_beep", clip: "scanner_close", offset: 0.45, duration: 1.15, volume: 0.24 },
    { id: "sfx_bag_thump", clip: "delayed_bag_flux", offset: 0.25, duration: 1.5, volume: 0.2 },
    { id: "sfx_zipper_sort", clip: "bag_opening", offset: 0.1, duration: 3.2, volume: 0.18 },
  ];
  for (const cue of cueSpecs) {
    const asset = sfxBank?.[cue.id];
    if (!asset?.providerPath) continue;
    if (cue.loop) inputs.push("-stream_loop", "-1");
    inputs.push("-i", asset.providerPath);
    const delayMs = Math.round(cueStart(timeline, cue.clip, cue.offset) * 1000);
    const label = `sfx${inputIndex}`;
    filters.push(
      `[${inputIndex}:a]atrim=0:${cue.duration},asetpts=N/SR/TB,highpass=f=45,volume=${cue.volume},afade=t=out:st=${Math.max(0.1, cue.duration - 0.35)}:d=0.3,adelay=${delayMs}|${delayMs}[${label}]`,
    );
    mixLabels.push(`[${label}]`);
    inputIndex += 1;
  }
  filters.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=longest:normalize=0,loudnorm=I=-14.5:LRA=7:TP=-1.5,alimiter=limit=0.94[mix]`,
  );
  const filter = filters.join(";");
  await run(ffmpegBin, [
    "-y", "-v", "error",
    ...inputs,
    "-filter_complex", filter,
    "-map", "0:v:0",
    "-map", "[mix]",
    "-t", String(targetDuration),
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "256k",
    "-ar", "48000",
    "-movflags", "+faststart",
    outputPath,
  ]);
}

async function buildContactSheet(videoPath, outputPath) {
  await run(ffmpegBin, [
    "-y", "-v", "error",
    "-i", videoPath,
    "-vf", "fps=1/7.4,scale=360:203:force_original_aspect_ratio=increase,crop=360:203,tile=5x5:padding=4:margin=4:color=0x101923",
    "-frames:v", "1",
    outputPath,
  ]);
}

async function buildOpeningContactSheet(videoPath, outputPath) {
  await run(ffmpegBin, [
    "-y", "-v", "error",
    "-i", videoPath,
    "-t", "32",
    "-vf", "fps=1/2,scale=480:270:force_original_aspect_ratio=increase,crop=480:270,tile=4x4:padding=4:margin=4:color=0x101923",
    "-frames:v", "1",
    outputPath,
  ]);
}

async function verifyProofLock(proofDir, lockPath, label) {
  await ensurePath(lockPath, `${label} baseline lock`);
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  if (lock?.status !== "locked" || !Array.isArray(lock?.artifacts)) {
    throw new Error(`Invalid ${label} baseline lock: ${lockPath}`);
  }
  const mismatches = [];
  for (const record of lock.artifacts) {
    const filePath = path.join(proofDir, record.path);
    try {
      const actual = await sha256File(filePath);
      if (actual !== record.sha256) mismatches.push({ path: filePath, expected: record.sha256, actual });
    } catch (error) {
      mismatches.push({ path: filePath, expected: record.sha256, error: error.message });
    }
  }
  for (const recipe of lock.recipes ?? []) {
    try {
      const actual = await sha256File(recipe.snapshot_path);
      if (actual !== recipe.snapshot_sha256) {
        mismatches.push({ path: recipe.snapshot_path, expected: recipe.snapshot_sha256, actual });
      }
    } catch (error) {
      mismatches.push({ path: recipe.snapshot_path, expected: recipe.snapshot_sha256, error: error.message });
    }
  }
  if (mismatches.length) {
    throw new Error(`Locked ${label} baseline changed:\n${JSON.stringify(mismatches, null, 2)}`);
  }
  return {
    label,
    lock_path: lockPath,
    lock_sha256: await sha256File(lockPath),
    content_sha256: lock.content_sha256,
    artifact_count: lock.artifact_count,
    verified_at: new Date().toISOString(),
  };
}

async function verifyBaseline() {
  const [parent, source] = await Promise.all([
    verifyProofLock(parentProofDir, baselineLockPath, "v2 parent"),
    verifyProofLock(sourceProofDir, sourceLockPath, "v1 source"),
  ]);
  return { parent, source };
}

async function sourceMetadata(encoded) {
  const names = [...new Set(encoded.filter((item) => item.kind === "source").map((item) => item.source))];
  const records = [];
  for (const name of names) {
    const id = path.basename(name, path.extname(name));
    const infoPath = path.join(sourceDir, `${id}.info.json`);
    let info = {};
    try {
      info = JSON.parse(await fs.readFile(infoPath, "utf8"));
    } catch {
      // Proof assembly can proceed from a downloaded source when metadata is absent.
    }
    const mediaPath = path.join(sourceDir, name);
    records.push({
      id,
      title: info.title ?? null,
      channel: info.channel ?? info.uploader ?? null,
      webpage_url: info.webpage_url ?? null,
      media_path: mediaPath,
      media_sha256: await sha256File(mediaPath),
      uses: encoded.filter((item) => item.source === name).map((item) => ({
        clip_id: item.id,
        source_start_sec: item.start ?? 0,
        duration_sec: item.duration_sec,
        crop_top_px: item.cropTop ?? 0,
        crop_bottom_px: item.cropBottom ?? 0,
      })),
    });
  }
  return records;
}

async function main() {
  const reportPath = path.join(outputDir, "documentary_cold_open_v3_report.json");
  const previousReport = await fs.readFile(reportPath, "utf8").catch(() => null);
  if (previousReport) {
    throw new Error(`The append-only v3 proof already exists. Use a new output directory instead of overwriting it: ${reportPath}`);
  }
  const baseline = await verifyBaseline();
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(graphicFrameRoot, { recursive: true });
  for (const sourcePath of Object.values(fluxImages)) await ensurePath(sourcePath, "FLUX Klein continuity image");
  for (const item of timelineBlueprint.filter((entry) => entry.kind === "source")) {
    await ensurePath(path.join(sourceDir, item.source), item.id);
  }

  await fs.writeFile(path.join(outputDir, "proof_script.md"), `${narrationText}\n`);
  const account = await loadModelslabAccount(flags["modelslab-profile"] ?? "default");
  process.stderr.write("[audio] generating v2 narration and restrained sound accents\n");
  const [narration, musicResult, sfxBank] = await Promise.all([
    buildNarration(account),
    buildMusic().catch((error) => ({ error: error.message })),
    buildSfxBank(),
  ]);
  const narrationDuration = durationFromProbe(narration.probe);
  if (!(narrationDuration > 20)) throw new Error(`Narration duration is invalid: ${narrationDuration}`);
  const narrationWords = wordCount(narrationText);
  const measuredWpm = narrationWords / (narrationDuration / 60);
  const timeline = materializeTimeline(narrationDuration);
  const visual = await buildTimeline(timeline);
  const finalPath = path.join(outputDir, "lost_luggage_documentary_cold_open_v3.mp4");
  const targetDuration = durationFromProbe(visual.probe);
  await mixFinal({
    silentPath: visual.silentPath,
    narrationPath: narration.narrationPath,
    musicPath: musicResult?.providerPath ?? null,
    sfxBank,
    timeline: visual.encoded,
    outputPath: finalPath,
    targetDuration,
  });
  const finalProbe = await probe(finalPath);
  const contactSheetPath = path.join(outputDir, "documentary_cold_open_v3_contact_sheet.jpg");
  const openingContactSheetPath = path.join(outputDir, "documentary_cold_open_v3_opening_contact_sheet.jpg");
  await Promise.all([
    buildContactSheet(finalPath, contactSheetPath),
    buildOpeningContactSheet(finalPath, openingContactSheetPath),
  ]);
  const sources = await sourceMetadata(visual.encoded);
  const report = {
    schema: "goldflow_asset_afterlife_documentary_cold_open_v3",
    status: "passed",
    proof_intent: "private_editorial_and_pipeline_diagnostic",
    official_pipeline_artifacts_modified: false,
    overwrite_policy: "append_only_new_version_directory",
    episode_dir: episodeDir,
    output_dir: outputDir,
    created_at: new Date().toISOString(),
    lineage: {
      baseline_version: "hybrid_documentary_cold_open_v2",
      baseline,
      baseline_video_path: path.join(parentProofDir, "lost_luggage_documentary_cold_open_v2.mp4"),
      baseline_video_sha256: "ba533d4f367476c9f289bad4c9636c9061b8e1c9d55902d80c6d0411e6ee1ef0",
      narrow_changes: [
        "Question card moved into the first eight seconds",
        "Narration reduced from 455 to 405 words using measured Adam longform pace",
        "Top-edge source crops increased to suppress embedded broadcaster branding",
      ],
      preserved_traits: [
        "Adam documentary narrator",
        "cream dark-teal orange mint visual system",
        "red suitcase continuity object",
        "hybrid real-footage motion-graphic FLUX reconstruction grammar",
        "restrained investigative score",
      ],
    },
    script: {
      path: path.join(outputDir, "proof_script.md"),
      sha256: scriptSha256,
      word_count: narrationWords,
      section_count: narrationSections.length,
    },
    narration: {
      model_id: "eleven_multilingual_v2",
      voice_id: "pNInz6obpgDQGcFmaJgB",
      voice_name: "Adam",
      output_path: narration.narrationPath,
      output_sha256: await sha256File(narration.narrationPath),
      duration_sec: round(narrationDuration),
      measured_wpm: round(measuredWpm, 1),
      request_id: narration.requestId,
      cache_reused: narration.reused,
      account: publicModelslabAccount(account),
    },
    audio_bed: musicResult?.providerPath ? {
      model_id: "music_v1",
      output_path: musicResult.providerPath,
      output_sha256: await sha256File(musicResult.providerPath),
      request_id: musicResult.requestId,
      cache_reused: musicResult.reused,
    } : {
      status: "omitted_after_provider_failure",
      error: musicResult?.error ?? "unknown",
    },
    sound_design: {
      model_id: "eleven_sound_effect",
      cue_count: Object.values(sfxBank).filter((item) => item.status === "available").length,
      cues: await Promise.all(Object.values(sfxBank).map(async (item) => ({
        id: item.id,
        prompt: item.prompt,
        status: item.status,
        output_path: item.providerPath ?? null,
        output_sha256: item.providerPath ? await sha256File(item.providerPath) : null,
        request_id: item.requestId ?? null,
        cache_reused: item.reused ?? false,
        error: item.error ?? null,
      }))),
    },
    visuals: {
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      source_footage_clip_count: visual.encoded.filter((item) => item.kind === "source").length,
      flux_klein_still_clip_count: visual.encoded.filter((item) => item.kind === "still").length,
      deterministic_motion_graphic_count: visual.encoded.filter((item) => item.kind === "graphic").length,
      clip_count: visual.encoded.length,
      average_clip_duration_sec: round(
        visual.encoded.reduce((sum, item) => sum + item.duration_sec, 0) / visual.encoded.length,
      ),
      generated_image_provider_contract: "modelslab_flux_klein_only",
      timeline: visual.encoded,
      flux_klein_images: await Promise.all(Object.entries(fluxImages).map(async ([id, imagePath]) => ({
        id,
        path: imagePath,
        sha256: await sha256File(imagePath),
      }))),
      source_records: sources,
    },
    output: {
      video_path: finalPath,
      video_sha256: await sha256File(finalPath),
      duration_sec: round(durationFromProbe(finalProbe)),
      size_bytes: Number(finalProbe?.format?.size ?? 0),
      bit_rate: Number(finalProbe?.format?.bit_rate ?? 0),
      probe: finalProbe,
      contact_sheet_path: contactSheetPath,
      contact_sheet_sha256: await sha256File(contactSheetPath),
      opening_contact_sheet_path: openingContactSheetPath,
      opening_contact_sheet_sha256: await sha256File(openingContactSheetPath),
    },
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    video_path: finalPath,
    report_path: reportPath,
    contact_sheet_path: contactSheetPath,
    opening_contact_sheet_path: openingContactSheetPath,
    duration_sec: report.output.duration_sec,
    narration_wpm: report.narration.measured_wpm,
    source_clip_count: report.visuals.source_footage_clip_count,
    graphic_count: report.visuals.deterministic_motion_graphic_count,
    flux_clip_count: report.visuals.flux_klein_still_clip_count,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
