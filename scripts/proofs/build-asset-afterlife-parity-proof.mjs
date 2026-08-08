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
const outputDir = path.resolve(flags["output-dir"] ?? path.join(
  episodeDir,
  "review_samples/hybrid_documentary_parity_proof_v1",
));
const sourceDir = path.join(outputDir, "source_media");
const workDir = path.join(outputDir, "work");
const clipDir = path.join(workDir, "clips");
const graphicFrameRoot = path.join(workDir, "graphic_frames");
const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";
const ffprobeBin = process.env.FFPROBE_BIN ?? "ffprobe";

const narrationSections = [
  "This red suitcase should have been claimed twenty minutes ago. Instead, it keeps circling an empty carousel while its owner stands at an airline desk, trying to prove what was inside.",
  "But the bag is not officially lost. Not yet. First, an enormous tracking system retraces every place it should have been scanned. A checked bag leaves four digital footprints: handoff, loading, transfer, and return.",
  "Miss one scan, and the search expands through belts, carts, storage rooms, and airports hundreds of miles away. Most bags make it home. When the search fails, many airlines declare the bag lost within five to fourteen days.",
  "Then the problem changes from a search into a claim. On a U.S. domestic trip, the carrier's liability can reach forty-seven hundred dollars, plus the baggage fee. Paying that claim closes the financial case. It does not make the suitcase disappear.",
  "The physical bag can keep moving for months. Unclaimed Baggage says airlines search for roughly three to four months before truly orphaned property reaches its operation in Alabama.",
  "There, the suitcase changes identity. It is no longer passenger baggage. It is inventory. Workers open it and divide the contents by value and condition. Clothes are cleaned. Electronics are tested and wiped. Jewelry is appraised. Luxury goods are authenticated.",
  "Some items are sold. Others are donated. What cannot be reused is recycled. So where does lost luggage go? Almost always, back to its owner. But the tiny fraction that survives every search enters a hidden second economy: one suitcase broken into dozens of objects, each beginning a new journey.",
];

const narrationText = narrationSections.join("\n\n");
const scriptSha256 = sha256(narrationText);

const fluxImages = {
  carousel: path.join(episodeDir, "assets/images/ep_01-w000000-w000008-modelslab-image.png"),
  intake: path.join(episodeDir, "assets/images/ep_01-w000293-w000311-modelslab-image.png"),
};

const timelineBlueprint = [
  { section: 0, kind: "still", id: "carousel_flux", source: fluxImages.carousel, weight: 1.25 },
  { section: 0, kind: "source", id: "carousel_real", source: "_4w9jFDV3Do.mp4", start: 112.0, weight: 0.9 },
  { section: 0, kind: "source", id: "luggage_backlog", source: "r2DUoXRlwOk.mp4", start: 2.4, weight: 0.9 },

  { section: 1, kind: "graphic", id: "question", graphic: "question", weight: 0.7 },
  { section: 1, kind: "source", id: "bag_checkin", source: "4NuTfvLPTas.mp4", start: 0.0, weight: 0.9 },
  { section: 1, kind: "source", id: "tag_scan", source: "_4w9jFDV3Do.mp4", start: 118.0, weight: 0.9 },
  { section: 1, kind: "graphic", id: "checkpoints", graphic: "checkpoints", weight: 1.45 },

  { section: 2, kind: "source", id: "belt_pov_a", source: "_4w9jFDV3Do.mp4", start: 205.0, weight: 0.9 },
  { section: 2, kind: "source", id: "belt_pov_b", source: "4NuTfvLPTas.mp4", start: 61.0, weight: 0.9 },
  { section: 2, kind: "source", id: "sorting_belts", source: "_4w9jFDV3Do.mp4", start: 327.0, weight: 0.9 },
  { section: 2, kind: "graphic", id: "status", graphic: "status", weight: 1.25 },

  { section: 3, kind: "source", id: "airport_backlog", source: "r2DUoXRlwOk.mp4", start: 22.0, weight: 0.8 },
  { section: 3, kind: "source", id: "handheld_scan", source: "WkN7eRmv7E8.mp4", start: 111.0, weight: 0.75 },
  { section: 3, kind: "graphic", id: "claim_value", graphic: "money", weight: 1.45 },
  { section: 3, kind: "source", id: "digital_bag_drop", source: "dDfGMQ_iffA.mp4", start: 7.0, weight: 0.8 },

  { section: 4, kind: "source", id: "belt_pov_c", source: "_4w9jFDV3Do.mp4", start: 227.0, weight: 0.8 },
  { section: 4, kind: "graphic", id: "route", graphic: "route", weight: 1.55 },
  { section: 4, kind: "still", id: "intake_flux", source: fluxImages.intake, weight: 0.7 },
  { section: 4, kind: "source", id: "storefront", source: "YiwZ3kbtHj4.mp4", start: 4.5, weight: 0.8 },

  { section: 5, kind: "source", id: "bag_opening", source: "YiwZ3kbtHj4.mp4", start: 94.0, weight: 1.0 },
  { section: 5, kind: "source", id: "contents_sorting", source: "YiwZ3kbtHj4.mp4", start: 18.0, weight: 1.0 },
  { section: 5, kind: "source", id: "clothing_racks", source: "YiwZ3kbtHj4.mp4", start: 154.0, weight: 1.0 },
  { section: 5, kind: "source", id: "jewelry_appraisal", source: "YiwZ3kbtHj4.mp4", start: 216.0, weight: 1.0 },

  { section: 6, kind: "graphic", id: "outcomes", graphic: "paths", weight: 1.45 },
  { section: 6, kind: "source", id: "second_life_store", source: "YiwZ3kbtHj4.mp4", start: 184.0, weight: 0.9 },
  { section: 6, kind: "source", id: "packed_for_sale", source: "YiwZ3kbtHj4.mp4", start: 231.5, weight: 0.8 },
  { section: 6, kind: "graphic", id: "final_verdict", graphic: "final", weight: 1.25 },
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
      stability: 0.58,
      similarity_boost: 0.76,
      style: 0.12,
      use_speaker_boost: true,
      speed: 1.06,
    },
  };
  const generated = await generateProviderAudio({
    account,
    id: "narration_elevenlabs_adam",
    endpoint: "/api/v7/voice/text-to-speech",
    request,
  });
  const narrationPath = path.join(outputDir, "narration_elevenlabs_adam.wav");
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

async function buildMusic(account) {
  const request = {
    prompt: "Instrumental documentary underscore for a modern logistics investigation. Restrained electronic pulse, warm muted plucks, subtle ticking percussion, soft bass, curious and precise rather than ominous, gentle forward momentum, clean optimistic resolution, no vocals, no spoken words, no cinematic trailer hits.",
    model_id: "music_v1",
  };
  return generateProviderAudio({
    account,
    id: "documentary_underscore",
    endpoint: "/api/v7/voice/music-gen",
    request,
  });
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
  await run(ffmpegBin, [
    "-y", "-v", "error",
    "-i", sourcePath,
    "-ss", String(item.start ?? 0),
    "-t", String(item.duration_sec),
    "-an",
    "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS},eq=contrast=1.035:saturation=0.96:gamma=0.99`,
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
  const zoomDirection = item.id.includes("intake") ? -1 : 1;
  const zoom = zoomDirection > 0
    ? "min(zoom+0.0008,1.085)"
    : "if(eq(on,1),1.085,max(zoom-0.00055,1.0))";
  await run(ffmpegBin, [
    "-y", "-v", "error",
    "-loop", "1",
    "-i", item.source,
    "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS},trim=duration=${item.duration_sec},setsar=1`,
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

async function mixFinal({ silentPath, narrationPath, musicPath, outputPath, targetDuration }) {
  const inputs = ["-i", silentPath, "-i", narrationPath];
  let filter;
  let audioMap;
  if (musicPath) {
    inputs.push("-stream_loop", "-1", "-i", musicPath);
    const fadeOutStart = Math.max(0, targetDuration - 2.4);
    filter = [
      `[1:a]highpass=f=58,apad=pad_dur=1.2,atrim=0:${targetDuration},asetpts=N/SR/TB,asplit=2[voice][voicekey]`,
      `[2:a]atrim=0:${targetDuration},asetpts=N/SR/TB,highpass=f=35,lowpass=f=12500,volume=0.12,afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutStart}:d=2.2[bed]`,
      "[bed][voicekey]sidechaincompress=threshold=0.025:ratio=7:attack=15:release=420[ducked]",
      "[voice][ducked]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[mix]",
    ].join(";");
    audioMap = "[mix]";
  } else {
    filter = `[1:a]apad=pad_dur=1.2,atrim=0:${targetDuration},alimiter=limit=0.95[mix]`;
    audioMap = "[mix]";
  }
  await run(ffmpegBin, [
    "-y", "-v", "error",
    ...inputs,
    "-filter_complex", filter,
    "-map", "0:v:0",
    "-map", audioMap,
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
    "-vf", "fps=1/6,scale=480:270:force_original_aspect_ratio=increase,crop=480:270,tile=4x4:padding=4:margin=4:color=0x101923",
    "-frames:v", "1",
    outputPath,
  ]);
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
      })),
    });
  }
  return records;
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(graphicFrameRoot, { recursive: true });
  for (const sourcePath of Object.values(fluxImages)) await ensurePath(sourcePath, "FLUX Klein continuity image");
  for (const item of timelineBlueprint.filter((entry) => entry.kind === "source")) {
    await ensurePath(path.join(sourceDir, item.source), item.id);
  }

  await fs.writeFile(path.join(outputDir, "proof_script.md"), `${narrationText}\n`);
  const account = await loadModelslabAccount(flags["modelslab-profile"] ?? "default");
  process.stderr.write("[audio] generating documentary narration and underscore\n");
  const [narration, musicResult] = await Promise.all([
    buildNarration(account),
    buildMusic(account).catch((error) => ({ error: error.message })),
  ]);
  const narrationDuration = durationFromProbe(narration.probe);
  if (!(narrationDuration > 20)) throw new Error(`Narration duration is invalid: ${narrationDuration}`);
  const narrationWords = wordCount(narrationText);
  const measuredWpm = narrationWords / (narrationDuration / 60);
  const timeline = materializeTimeline(narrationDuration);
  const visual = await buildTimeline(timeline);
  const finalPath = path.join(outputDir, "lost_luggage_hybrid_parity_proof.mp4");
  const targetDuration = durationFromProbe(visual.probe);
  await mixFinal({
    silentPath: visual.silentPath,
    narrationPath: narration.narrationPath,
    musicPath: musicResult?.providerPath ?? null,
    outputPath: finalPath,
    targetDuration,
  });
  const finalProbe = await probe(finalPath);
  const contactSheetPath = path.join(outputDir, "hybrid_parity_contact_sheet.jpg");
  await buildContactSheet(finalPath, contactSheetPath);
  const sources = await sourceMetadata(visual.encoded);
  const report = {
    schema: "goldflow_asset_afterlife_hybrid_parity_proof_v1",
    status: "passed",
    proof_intent: "private_editorial_and_pipeline_diagnostic",
    official_pipeline_artifacts_modified: false,
    episode_dir: episodeDir,
    output_dir: outputDir,
    created_at: new Date().toISOString(),
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
    visuals: {
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      source_footage_clip_count: visual.encoded.filter((item) => item.kind === "source").length,
      flux_klein_still_clip_count: visual.encoded.filter((item) => item.kind === "still").length,
      deterministic_motion_graphic_count: visual.encoded.filter((item) => item.kind === "graphic").length,
      clip_count: visual.encoded.length,
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
    },
  };
  const reportPath = path.join(outputDir, "hybrid_parity_proof_report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    video_path: finalPath,
    report_path: reportPath,
    contact_sheet_path: contactSheetPath,
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
