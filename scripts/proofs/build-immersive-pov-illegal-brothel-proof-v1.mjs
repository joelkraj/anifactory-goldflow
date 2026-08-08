#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import sharp from "sharp";

const execFile = promisify(execFileCb);
const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "../..");
const flags = parseFlags(process.argv.slice(2));

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const GRAPHIC_FPS = 12;
const DEFAULT_EPISODE_DIR = "/Users/joel/AniFactoryData/channels/immersivepov/weekly_runs/2026-W32-immersive-pov-illegal-brothel-proof-v1/episodes/ep_01";
const episodeDir = path.resolve(flags["episode-dir"] ?? DEFAULT_EPISODE_DIR);
const outputDir = path.resolve(flags["output-dir"] ?? path.join(
  episodeDir,
  "review_samples/immersive_pov_illegal_brothel_proof_v1",
));
const imageDir = path.resolve(flags["image-dir"] ?? path.join(episodeDir, "assets/images"));
const sourceAssetsDir = path.resolve(flags["source-assets-dir"] ?? outputDir);
const sourceMediaDir = path.join(sourceAssetsDir, "source_media");
const sfxDir = path.join(sourceAssetsDir, "sfx_source_downloads");
const proofVersion = flags["proof-version"] ?? "v1";
const generatedImageModel = String(flags["generated-image-model"] ?? "flux_klein");
const generatedStillKind = `${generatedImageModel.replaceAll(/[^a-zA-Z0-9_-]/gu, "_")}_scene_raster`;
const workDir = path.join(outputDir, `work_custom_edit_${proofVersion.replaceAll(/[^a-zA-Z0-9_-]/gu, "_")}`);
const clipDir = path.join(workDir, "clips");
const graphicDir = path.join(workDir, "graphics");
const overlayDir = path.join(workDir, "overlays");
const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";
const ffprobeBin = process.env.FFPROBE_BIN ?? "ffprobe";
const concurrency = Number(flags.concurrency ?? 4);
const scoreBedTrimDb = -3.5;
const scoreBedFixedDuckDb = -16.228;
const scoreBedEffectiveTrimDb = scoreBedTrimDb + scoreBedFixedDuckDb;
const scoreBedGain = 0.95 * (10 ** (scoreBedEffectiveTrimDb / 20));
const RENDERED_STILL_INDICES = new Set([
  1, 2, 3, 4, 5, 6, 7, 9, 13, 15, 16, 17, 18, 19, 21, 25, 26, 27,
  29, 31, 35, 36, 38, 39, 40, 43, 44,
]);

const inputs = {
  prompts: path.join(episodeDir, "section_image_prompts_hardened.json"),
  imageReport: path.join(episodeDir, "imagegen_report_ep_01.json"),
  imageQa: path.join(episodeDir, "image_output_qa_ep_01.json"),
  runIdentity: path.join(episodeDir, "run_identity.json"),
  script: path.join(episodeDir, "script_clean.md"),
  scriptApproval: path.join(episodeDir, "operator_script_approval.json"),
  wordTiming: path.join(episodeDir, "narration_word_timing_ep_01.json"),
  narration: path.join(
    episodeDir,
    "assets/audio/longform_mix/ep_01-immersivepov-narration-narrator-only.m4a",
  ),
  narrationReport: path.join(episodeDir, "longform_audio_bed_report_ep_01.json"),
  music: "/Users/joel/AniFactoryData/channels/assetafterlife/weekly_runs/2026-W31-asset-afterlife-lost-luggage-proof-v5/episodes/ep_01/review_samples/hybrid_documentary_parity_proof_v1/documentary_underscore.provider-audio",
  musicMetadata: "/Users/joel/AniFactoryData/channels/assetafterlife/weekly_runs/2026-W31-asset-afterlife-lost-luggage-proof-v5/episodes/ep_01/review_samples/hybrid_documentary_parity_proof_v1/documentary_underscore.provider.json",
};

const broll = {
  police: sourceRecord("MKEHyX5vPzM", sourceMediaDir, "mp4"),
  cash: sourceRecord("JIz1iltVrjg", sourceMediaDir, "mp4"),
};

const sfxSources = {
  bass: sourceRecord("7DYBjzrhdWw", sfxDir, "wav"),
  notification: sourceRecord("9dMzP8clB4c", sfxDir, "wav"),
  phone: sourceRecord("Fk9Uw22cbrU", sfxDir, "wav"),
  police: sourceRecord("HKieGUH9pzg", sfxDir, "wav"),
  money: sourceRecord("Hiax3Se-JeI", sfxDir, "wav"),
  ambulance: sourceRecord("jCwpMWL61pk", sfxDir, "wav"),
  envelope: sourceRecord("mAADPoUjXCs", sfxDir, "wav"),
  lock: sourceRecord("oh9aCj3V7cg", sfxDir, "wav"),
  knock: sourceRecord("r1pJzw6Q-98", sfxDir, "wav"),
  reverseWhoosh: sourceRecord("tt5cs51iTDA", sfxDir, "wav"),
  doorKick: sourceRecord("vAnMhtrlXlE", sfxDir, "wav"),
};

const graphicSpecs = new Map([
  [8, {
    type: "system_lock",
    eyebrow: "THE UNWRITTEN RULE",
    headline: ["NO SAFE WAY", "TO ASK FOR HELP"],
    footer: "The address is illegal. The danger is not.",
  }],
  [10, {
    type: "verdict",
    eyebrow: "THE FIRST MISTAKE",
    headline: ["BASIC DECENCY", "HAS A PRICE"],
    footer: "In this building, protecting people destroys the margin.",
  }],
  [12, {
    type: "rent",
    eyebrow: "COST LEAK 01",
    headline: "THE LANDLORD RAISES RENT",
    footer: "He knows you cannot challenge him without exposing yourself.",
  }],
  [14, {
    type: "list",
    eyebrow: "COST LEAK 03",
    headline: "THE MONEY KEEPS LEAVING",
    rows: ["DRIVERS CANCEL", "CUSTOMERS VANISH", "PAYMENTS DISAPPEAR"],
    footer: "Revenue is a promise. Cash is what survives.",
  }],
  [20, {
    type: "choice",
    eyebrow: "DAY 9 // FIRST REAL CHOICE",
    headline: "KEEP EARNING OR GET EVERYONE OUT?",
    left: "KEEP ROOMS OPEN",
    right: "CLOSE TONIGHT",
    selected: "right",
    footer: "You close the entire building.",
  }],
  [22, {
    type: "notification",
    eyebrow: "THE NEXT MORNING",
    headline: ["HE KNOWS", "WHY YOU CLOSED"],
    footer: "The lost money was only the warning.",
  }],
  [23, {
    type: "intel",
    eyebrow: "VICTOR ALREADY KNOWS",
    headline: "YOUR OPERATION IS NOT PRIVATE",
    rows: ["WHY YOU CLOSED", "WHO OWNS THE BUILDING", "WHERE TO FIND YOU"],
    footer: "Information is his first payment demand.",
  }],
  [24, {
    type: "metric",
    eyebrow: "THE PROTECTION PRICE",
    value: 30,
    suffix: "%",
    headline: "OF EVERYTHING YOU MAKE",
    footer: "Pay once, and the demand becomes permanent.",
  }],
  [28, {
    type: "choice",
    eyebrow: "DAY 17 // THE SAFE IS SHRINKING",
    headline: "PAY MARA OR KEEP THE DOORS OPEN?",
    left: "DELAY HER PAY",
    right: "PAY WHAT YOU OWE",
    selected: "right",
    footer: "Protecting one person empties half the safe.",
  }],
  [30, {
    type: "transfer",
    eyebrow: "THE BUSINESS MODEL",
    headline: "PROTECTION BECOMES A COST",
    left: "PROTECTED PERSON",
    right: "EXPENSE TO AVOID",
    footer: "The operation survives by moving risk onto somebody else.",
  }],
  [32, {
    type: "choice",
    eyebrow: "VICTOR RETURNS",
    headline: "BOTH ANSWERS MAKE HIM STRONGER",
    left: "PAY HIM\nDEMAND GROWS",
    right: "REFUSE\nDANGER MOVES",
    selected: "none",
    footer: "Someone pays either way.",
  }],
  [33, {
    type: "branches",
    eyebrow: "NO WINNING BRANCH",
    headline: "YOU ONLY CHOOSE WHO LOSES FIRST",
    rows: ["PAY", "REFUSE", "CLOSE"],
    outcomes: ["MORE DEMANDS", "SOMEONE GETS HURT", "DEBT FOLLOWS HOME"],
    footer: "Illegal profit survives by exporting the consequence.",
  }],
  [37, {
    type: "consequence",
    eyebrow: "CALLING AN AMBULANCE",
    headline: "ONE CALL ENDS THE OPERATION",
    rows: ["ADDRESS EXPOSED", "DOORS CLOSED", "HANDCUFFS POSSIBLE"],
    footer: "The safe choice for a person is fatal to the business.",
  }],
  [41, {
    type: "metric",
    eyebrow: "BY SUNRISE",
    prefix: "$",
    value: 0,
    headline: "CASH LEFT",
    footer: "Thirty days of revenue disappears before morning.",
  }],
  [42, {
    type: "denial",
    eyebrow: "THE LANDLORD'S ANSWER",
    headline: ["NO RECORD", "OF YOU"],
    footer: "The person collecting rent now denies knowing your name.",
  }],
  [45, {
    type: "risk",
    eyebrow: "THE REAL ARITHMETIC",
    headline: "PROFIT REQUIRES SOMEONE ELSE'S RISK",
    left: "PROFIT",
    right: "HUMAN COST",
    footer: "The books balance only while people do not.",
  }],
  [46, {
    type: "final",
    eyebrow: "DAY 30 // FINAL VERDICT",
    headline: ["YOU DIDN'T BEAT", "THE SYSTEM."],
    subheadline: "YOU STOPPED FEEDING IT.",
    footer: "Everyone leaves alive. The business does not.",
  }],
]);

const stillOverlays = new Map([
  [1, { badge: "2:13 AM", label: "POLICE LIGHTS OUTSIDE" }],
  [4, { badge: "2:13 AM", label: "CASH BY SUNRISE" }],
  [6, { badge: "DAY 1", label: "IT LOOKS EASY" }],
  [7, { badge: "DAY 1", label: "3 ROOMS  /  $20,000  /  1 LOCKED OFFICE" }],
  [9, { badge: "YOUR PROMISE", label: "NO ONE GETS TRAPPED" }],
  [13, { badge: "COST LEAK 02", label: "CLEANING DOUBLES  /  DOOR REPLACED" }],
  [15, { badge: "DAY 6", label: "$11,000 EARNED" }],
  [16, { badge: "THE SAFE", label: "$4,300 LEFT" }],
  [18, { badge: "DAY 9", label: "A BOUNDARY IS IGNORED" }],
  [19, { badge: "BEHIND THE DOOR", label: "SHE LOCKS IT  /  HE KEEPS KICKING" }],
  [21, { badge: "YOUR DECISION", label: "EVERYONE GETS OUT" }],
  [25, { badge: "YOUR ANSWER", label: "NO" }],
  [26, { badge: "3 DAYS LATER", label: "INSPECTORS ARRIVE" }],
  [27, { badge: "DAY 17", label: "MARA WANTS WHAT SHE IS OWED", corner: "LEAVING TOWN", cornerStyle: "panel_dark_small" }],
  [29, { badge: "YOUR DECISION", label: "PAY HER" }],
  [31, { badge: "DAY 23", label: "VICTOR RETURNS" }],
  [35, { badge: "DAY 30", label: "THE OPENING SCENE MAKES SENSE NOW" }],
  [36, { badge: "UPSTAIRS", label: "SOMEONE NEEDS AN AMBULANCE" }],
  [38, { badge: "THE LAST CHOICE", label: "THE SAFE  /  THE LOCKED BATHROOM" }],
  [39, { badge: "YOUR DECISION", label: "CALL" }],
  [40, { badge: "SUNRISE", label: "THE BUILDING IS EMPTY" }],
  [43, { badge: "AFTER", label: "VICTOR DISAPPEARS" }],
  [44, { badge: "WHAT SURVIVED", label: "EVERY WORKER LEAVES ALIVE AND PAID", corner: "PAID IN FULL", cornerStyle: "panel_dark" }],
]);

const sfxCues = [
  cue("opening_police_siren", "police", 0, 0.2, 4.2, 0.035, 0.15, 1.1),
  cue("opening_bass_impact", "bass", 0, 0, 1.15, 0.13, 0, 0.4),
  cue("four_people_freeze", "bass", 4.74, 0.28, 0.62, 0.07, 0, 0.25),
  cue("back_door_pounding", "knock", 8.78, 0, 3.9, 0.17, 0, 0.2),
  cue("thirty_days_reverse", "reverseWhoosh", 14.82, 0, 1.2, 0.08, 0.05, 0.12),
  cue("money_leaking", "money", 44.1, 0.2, 3.25, 0.052, 0.12, 0.35),
  cue("safe_latch", "lock", 61.18, 0, 0.85, 0.11, 0, 0.18),
  cue("bathroom_lock", "lock", 70.4, 0, 0.8, 0.13, 0, 0.16),
  cue("bathroom_door_kicks", "doorKick", 71.0, 0.1, 2.35, 0.16, 0.04, 0.22),
  cue("victor_message", "notification", 78.2, 0, 1.05, 0.11, 0, 0.24),
  cue("protection_price", "bass", 86.12, 0.16, 0.72, 0.08, 0, 0.25),
  cue("refusal", "bass", 88.86, 0, 0.84, 0.105, 0, 0.3),
  cue("inspectors_at_front", "knock", 90.04, 0.1, 1.45, 0.09, 0, 0.18),
  cue("mara_paid", "envelope", 104.48, 0.1, 1.25, 0.07, 0, 0.25),
  cue("victor_returns", "notification", 114.5, 0, 0.95, 0.08, 0, 0.25),
  cue("day_thirty_transition", "reverseWhoosh", 127.28, 0, 1.1, 0.08, 0.05, 0.15),
  cue("day_thirty_pounding", "knock", 129.44, 0, 3.7, 0.2, 0, 0.3),
  cue("ambulance_needed", "ambulance", 135.96, 7.0, 7.3, 0.025, 0.6, 1.4),
  cue("phone_call", "phone", 146.7, 0, 2.45, 0.07, 0, 0.45),
  cue("ambulance_answer", "ambulance", 147.54, 18.0, 5.0, 0.034, 0.4, 1.1),
  cue("final_system_impact", "bass", 166.18, 0, 1.2, 0.09, 0, 0.45),
];

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = parts[index + 1];
    parsed[key] = next && !next.startsWith("--") ? next : "true";
    if (parsed[key] !== "true") index += 1;
  }
  return parsed;
}

function sourceRecord(id, directory, extension) {
  return {
    id,
    path: path.join(directory, `${id}.${extension}`),
    info_path: path.join(directory, `${id}.info.json`),
  };
}

function cue(id, sourceKey, start, sourceStart, duration, volume, fadeIn = 0, fadeOut = 0) {
  return {
    id,
    sourceKey,
    start,
    source_start: sourceStart,
    duration,
    volume,
    fade_in: fadeIn,
    fade_out: fadeOut,
  };
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

function round(value, digits = 3) {
  return Number(Number(value).toFixed(digits));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function ensureFile(filePath, expectedHash = null) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < 1) throw new Error(`Missing input file: ${filePath}`);
  const actualHash = await sha256File(filePath);
  if (expectedHash && actualHash !== expectedHash) throw new Error(`Hash mismatch: ${filePath}`);
  return { path: filePath, sha256: actualHash, size_bytes: stat.size };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function run(command, args, options = {}) {
  const { stdout = "", stderr = "" } = await execFile(command, args, {
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  if (stderr && flags.verbose === "true") process.stderr.write(stderr);
  return stdout;
}

async function probe(filePath) {
  return JSON.parse(await run(ffprobeBin, [
    "-v", "error",
    "-show_entries", "format=duration,size,bit_rate:stream=index,codec_name,codec_type,width,height,r_frame_rate,pix_fmt,sample_rate,channels",
    "-of", "json",
    filePath,
  ]));
}

async function mapLimit(values, limit, callback) {
  const results = Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await callback(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function imagePath(imageId) {
  return path.join(imageDir, `${imageId}-modelslab-image.png`);
}

function baseGraphicSvg(content, dark = false) {
  const background = dark ? "#171717" : "#F4EEDC";
  const grid = dark ? "#2B2B2B" : "#DDD2BB";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${background}"/>
    <path d="M 0 160 H 1920 M 0 900 H 1920" stroke="${grid}" stroke-width="2" opacity="0.55"/>
    <path d="M 1510 -40 L 2020 -40 L 2020 470 Z" fill="#B90E18" opacity="${dark ? 0.24 : 0.12}"/>
    <circle cx="1725" cy="120" r="315" fill="none" stroke="${grid}" stroke-width="2" opacity="0.45"/>
    <g font-family="Avenir Next, Helvetica Neue, sans-serif">${content}</g>
  </svg>`;
}

function personIcon(x, y, scale = 1, fill = "#202020") {
  return `<g transform="translate(${x} ${y}) scale(${scale})" fill="${fill}">
    <circle cx="0" cy="0" r="42"/>
    <rect x="-34" y="45" width="68" height="160" rx="28"/>
    <rect x="-70" y="65" width="34" height="138" rx="17" transform="rotate(10 -53 134)"/>
    <rect x="36" y="65" width="34" height="138" rx="17" transform="rotate(-10 53 134)"/>
    <rect x="-31" y="198" width="27" height="140" rx="14"/>
    <rect x="4" y="198" width="27" height="140" rx="14"/>
  </g>`;
}

function graphicSvg(spec, progress) {
  const p = clamp(progress);
  const enter = easeOutCubic(clamp(p / 0.22));
  const opacity = clamp(p * 4);
  const x = 130 - ((1 - enter) * 80);
  const dark = ["verdict", "final", "denial"].includes(spec.type);
  const primary = dark ? "#F4EEDC" : "#202020";
  const muted = dark ? "#B7B0A2" : "#696356";
  const eyebrow = `<text x="${x}" y="135" fill="#C4111B" font-size="31" font-weight="800" letter-spacing="6" opacity="${opacity}">${escapeXml(spec.eyebrow)}</text>`;
  const footer = `<text x="130" y="958" fill="${muted}" font-size="30" font-weight="600" opacity="${opacity}">${escapeXml(spec.footer ?? "")}</text>`;

  if (spec.type === "verdict" || spec.type === "final" || spec.type === "denial") {
    const lines = Array.isArray(spec.headline) ? spec.headline : [spec.headline];
    const fontSize = spec.type === "final" ? 112 : 126;
    const startY = spec.type === "final" ? 420 : 430;
    const headline = lines.map((line, index) => `<text x="${x}" y="${startY + (index * 145)}" fill="${primary}" font-size="${fontSize}" font-weight="900" letter-spacing="-4" opacity="${opacity}">${escapeXml(line)}</text>`).join("");
    const sub = spec.subheadline
      ? `<text x="${x}" y="760" fill="#C4111B" font-size="66" font-weight="900" letter-spacing="-1" opacity="${opacity}">${escapeXml(spec.subheadline)}</text>`
      : "";
    const slash = `<path d="M 1550 330 L 1785 735" stroke="#C4111B" stroke-width="34" stroke-linecap="round" opacity="${0.3 + (0.7 * enter)}"/>`;
    return baseGraphicSvg(`${eyebrow}${headline}${sub}${slash}${footer}`, true);
  }

  if (spec.type === "metric") {
    const animated = Number(spec.value) * easeOutCubic(clamp((p - 0.02) / 0.2));
    const metric = Math.round(animated).toLocaleString("en-US");
    const lineWidth = 1520 * easeOutCubic(clamp((p - 0.16) / 0.68));
    return baseGraphicSvg(`${eyebrow}
      <text x="${x}" y="565" fill="#C4111B" font-size="250" font-weight="900" letter-spacing="-10" opacity="${opacity}">${escapeXml(spec.prefix ?? "")}${metric}${escapeXml(spec.suffix ?? "")}</text>
      <text x="${x}" y="710" fill="${primary}" font-size="78" font-weight="900" letter-spacing="-2" opacity="${opacity}">${escapeXml(spec.headline)}</text>
      <rect x="130" y="790" width="1520" height="22" rx="11" fill="#D7CEBB"/>
      <rect x="130" y="790" width="${lineWidth}" height="22" rx="11" fill="#C4111B"/>
      ${footer}`);
  }

  if (spec.type === "system_lock") {
    const barrier = 960 + ((1 - enter) * 160);
    return baseGraphicSvg(`${eyebrow}
      <text x="${x}" y="350" fill="${primary}" font-size="96" font-weight="900" letter-spacing="-3" opacity="${opacity}">${escapeXml(spec.headline[0])}</text>
      <text x="${x}" y="470" fill="#C4111B" font-size="96" font-weight="900" letter-spacing="-3" opacity="${opacity}">${escapeXml(spec.headline[1])}</text>
      <g transform="translate(270 590)" opacity="${opacity}">
        <path d="M 0 190 V 35 L 165 0 L 330 35 V 190 Z" fill="none" stroke="#202020" stroke-width="16"/>
        <rect x="125" y="90" width="80" height="100" fill="#202020"/>
      </g>
      <rect x="${barrier}" y="560" width="44" height="285" rx="22" fill="#C4111B" opacity="${opacity}"/>
      ${personIcon(1450, 610, 0.72, "#202020")}
      <circle cx="1450" cy="590" r="155" fill="none" stroke="#C4111B" stroke-width="20" opacity="${opacity}"/>
      <path d="M 1338 700 L 1562 480" stroke="#C4111B" stroke-width="20" opacity="${opacity}"/>
      ${footer}`);
  }

  if (spec.type === "rent") {
    const oldHeight = 150;
    const newHeight = 150 + (340 * easeOutCubic(clamp((p - 0.1) / 0.65)));
    return baseGraphicSvg(`${eyebrow}
      <text x="${x}" y="330" fill="${primary}" font-size="80" font-weight="900" letter-spacing="-2" opacity="${opacity}">${escapeXml(spec.headline)}</text>
      <line x1="250" y1="820" x2="1640" y2="820" stroke="#202020" stroke-width="12"/>
      <rect x="430" y="${820 - oldHeight}" width="320" height="${oldHeight}" fill="#918A7B"/>
      <rect x="1110" y="${820 - newHeight}" width="320" height="${newHeight}" fill="#C4111B"/>
      <text x="590" y="880" text-anchor="middle" fill="#202020" font-size="34" font-weight="900">BEFORE</text>
      <text x="1270" y="880" text-anchor="middle" fill="#202020" font-size="34" font-weight="900">NOW</text>
      <path d="M 810 650 C 910 560 950 520 1030 430" fill="none" stroke="#C4111B" stroke-width="20" stroke-linecap="round"/>
      <path d="M 1000 438 L 1046 415 L 1040 466" fill="#C4111B"/>
      ${footer}`);
  }

  if (["list", "intel", "consequence"].includes(spec.type)) {
    const rows = spec.rows.map((label, index) => {
      const rowEnter = easeOutCubic(clamp((p * 3.2) - (index * 0.35)));
      const rowY = 470 + (index * 135);
      return `<rect x="130" y="${rowY}" width="1570" height="105" rx="18" fill="${index === spec.rows.length - 1 ? "#202020" : "#E3D9C5"}" opacity="${rowEnter}"/>
        <rect x="130" y="${rowY}" width="18" height="105" rx="9" fill="#C4111B" opacity="${rowEnter}"/>
        <text x="185" y="${rowY + 70}" fill="${index === spec.rows.length - 1 ? "#F4EEDC" : "#202020"}" font-size="44" font-weight="900" letter-spacing="1" opacity="${rowEnter}">${escapeXml(label)}</text>`;
    }).join("");
    return baseGraphicSvg(`${eyebrow}
      <text x="${x}" y="330" fill="${primary}" font-size="80" font-weight="900" letter-spacing="-2" opacity="${opacity}">${escapeXml(spec.headline)}</text>
      ${rows}${footer}`);
  }

  if (spec.type === "choice") {
    const selectedLeft = spec.selected === "left";
    const selectedRight = spec.selected === "right";
    const leftLines = spec.left.split("\n");
    const rightLines = spec.right.split("\n");
    const renderLines = (lines, center, selected) => lines.map((line, index) => `<text x="${center}" y="${590 + (index * 76)}" text-anchor="middle" fill="${selected ? "#F4EEDC" : "#202020"}" font-size="46" font-weight="900">${escapeXml(line)}</text>`).join("");
    return baseGraphicSvg(`${eyebrow}
      <text x="${x}" y="320" fill="${primary}" font-size="72" font-weight="900" letter-spacing="-2" opacity="${opacity}">${escapeXml(spec.headline)}</text>
      <rect x="130" y="440" width="760" height="330" rx="32" fill="${selectedLeft ? "#C4111B" : "#E3D9C5"}" stroke="${selectedLeft ? "#202020" : "#B9AF9B"}" stroke-width="8" opacity="${opacity}"/>
      <rect x="1030" y="440" width="760" height="330" rx="32" fill="${selectedRight ? "#C4111B" : "#E3D9C5"}" stroke="${selectedRight ? "#202020" : "#B9AF9B"}" stroke-width="8" opacity="${opacity}"/>
      ${renderLines(leftLines, 510, selectedLeft)}
      ${renderLines(rightLines, 1410, selectedRight)}
      <circle cx="960" cy="605" r="54" fill="#202020"/>
      <text x="960" y="620" text-anchor="middle" fill="#F4EEDC" font-size="32" font-weight="900">OR</text>
      ${footer}`);
  }

  if (spec.type === "notification") {
    const phoneX = 1240 + ((1 - enter) * 150);
    return baseGraphicSvg(`${eyebrow}
      <text x="${x}" y="420" fill="${primary}" font-size="118" font-weight="900" letter-spacing="-4" opacity="${opacity}">${escapeXml(spec.headline[0])}</text>
      <text x="${x}" y="555" fill="#C4111B" font-size="118" font-weight="900" letter-spacing="-4" opacity="${opacity}">${escapeXml(spec.headline[1])}</text>
      <rect x="${phoneX}" y="300" width="420" height="570" rx="58" fill="#202020"/>
      <rect x="${phoneX + 30}" y="350" width="360" height="420" rx="32" fill="#F4EEDC"/>
      <circle cx="${phoneX + 210}" cy="825" r="22" fill="#C4111B"/>
      <circle cx="${phoneX + 210}" cy="515" r="76" fill="#C4111B" opacity="${0.55 + (0.45 * Math.sin(p * Math.PI * 8) ** 2)}"/>
      ${footer}`);
  }

  if (spec.type === "transfer") {
    const line = 500 * easeOutCubic(clamp((p - 0.15) / 0.65));
    return baseGraphicSvg(`${eyebrow}
      <text x="${x}" y="330" fill="${primary}" font-size="82" font-weight="900" letter-spacing="-3" opacity="${opacity}">${escapeXml(spec.headline)}</text>
      ${personIcon(400, 520, 0.62, "#202020")}
      <text x="400" y="890" text-anchor="middle" fill="#202020" font-size="34" font-weight="900">${escapeXml(spec.left)}</text>
      <line x1="710" y1="670" x2="${710 + line}" y2="670" stroke="#C4111B" stroke-width="24" stroke-linecap="round"/>
      <path d="M ${1190 + line - 500} 625 L ${1260 + line - 500} 670 L ${1190 + line - 500} 715 Z" fill="#C4111B"/>
      <rect x="1320" y="500" width="390" height="320" rx="28" fill="#202020"/>
      <text x="1515" y="640" text-anchor="middle" fill="#F4EEDC" font-size="48" font-weight="900">EXPENSE</text>
      <text x="1515" y="720" text-anchor="middle" fill="#C4111B" font-size="86" font-weight="900">$</text>
      <text x="1515" y="890" text-anchor="middle" fill="#202020" font-size="34" font-weight="900">${escapeXml(spec.right)}</text>
      ${footer}`);
  }

  if (spec.type === "branches") {
    const rows = spec.rows.map((label, index) => {
      const y = 480 + (index * 135);
      const rowEnter = easeOutCubic(clamp((p * 3) - (index * 0.34)));
      return `<circle cx="220" cy="${y + 48}" r="42" fill="#C4111B" opacity="${rowEnter}"/>
        <text x="295" y="${y + 61}" fill="#202020" font-size="43" font-weight="900" opacity="${rowEnter}">${escapeXml(label)}</text>
        <line x1="560" y1="${y + 48}" x2="870" y2="${y + 48}" stroke="#202020" stroke-width="10" opacity="${rowEnter}"/>
        <rect x="900" y="${y}" width="760" height="96" rx="18" fill="#202020" opacity="${rowEnter}"/>
        <text x="1280" y="${y + 63}" text-anchor="middle" fill="#F4EEDC" font-size="37" font-weight="900" opacity="${rowEnter}">${escapeXml(spec.outcomes[index])}</text>`;
    }).join("");
    return baseGraphicSvg(`${eyebrow}
      <text x="${x}" y="320" fill="${primary}" font-size="76" font-weight="900" letter-spacing="-2" opacity="${opacity}">${escapeXml(spec.headline)}</text>
      ${rows}${footer}`);
  }

  if (spec.type === "risk") {
    const tilt = 8 * easeOutCubic(clamp((p - 0.1) / 0.6));
    return baseGraphicSvg(`${eyebrow}
      <text x="${x}" y="315" fill="${primary}" font-size="72" font-weight="900" letter-spacing="-2" opacity="${opacity}">${escapeXml(spec.headline)}</text>
      <g transform="rotate(${tilt} 960 670)" opacity="${opacity}">
        <line x1="520" y1="650" x2="1400" y2="650" stroke="#202020" stroke-width="30" stroke-linecap="round"/>
        <circle cx="960" cy="650" r="72" fill="#C4111B"/>
        <line x1="620" y1="650" x2="620" y2="790" stroke="#202020" stroke-width="12"/>
        <line x1="1300" y1="650" x2="1300" y2="790" stroke="#202020" stroke-width="12"/>
        <rect x="410" y="790" width="420" height="120" rx="18" fill="#E3D9C5" stroke="#202020" stroke-width="8"/>
        <rect x="1090" y="790" width="420" height="120" rx="18" fill="#202020" stroke="#C4111B" stroke-width="8"/>
        <text x="620" y="865" text-anchor="middle" fill="#202020" font-size="40" font-weight="900">${escapeXml(spec.left)}</text>
        <text x="1300" y="865" text-anchor="middle" fill="#F4EEDC" font-size="40" font-weight="900">${escapeXml(spec.right)}</text>
      </g>${footer}`);
  }

  throw new Error(`Unknown graphic type: ${spec.type}`);
}

function chronologySvg(label, sublabel, progress) {
  const p = easeOutCubic(clamp(progress / 0.25));
  return baseGraphicSvg(`<text x="130" y="150" fill="#C4111B" font-size="31" font-weight="900" letter-spacing="7" opacity="${p}">POV // CONSEQUENCE SIMULATION</text>
    <text x="${130 - ((1 - p) * 120)}" y="555" fill="#202020" font-size="178" font-weight="900" letter-spacing="-7" opacity="${p}">${escapeXml(label)}</text>
    <rect x="130" y="650" width="${1120 * p}" height="24" rx="12" fill="#C4111B"/>
    <text x="130" y="770" fill="#5D574D" font-size="48" font-weight="700" opacity="${p}">${escapeXml(sublabel)}</text>`, false);
}

function overlaySvg(overlay) {
  const badge = overlay.badge
    ? `<rect x="92" y="76" width="${Math.max(260, (overlay.badge.length * 28) + 85)}" height="76" rx="12" fill="#C4111B"/>
       <text x="126" y="128" fill="#FFFFFF" font-size="36" font-weight="900" letter-spacing="3">${escapeXml(overlay.badge)}</text>`
    : "";
  const label = overlay.label
    ? `<rect x="92" y="886" width="${Math.min(1680, Math.max(620, (overlay.label.length * 24) + 110))}" height="112" rx="14" fill="#171717" fill-opacity="0.9"/>
       <rect x="92" y="886" width="14" height="112" rx="7" fill="#C4111B"/>
       <text x="136" y="956" fill="#F4EEDC" font-size="40" font-weight="900" letter-spacing="1">${escapeXml(overlay.label)}</text>`
    : "";
  let corner = "";
  if (overlay.cornerStyle === "panel_dark_small") {
    corner = `<rect x="1480" y="38" width="410" height="205" rx="16" fill="#171717"/>
      <rect x="1480" y="38" width="14" height="205" rx="7" fill="#C4111B"/>
      <text x="1530" y="128" fill="#F4EEDC" font-size="38" font-weight="900" letter-spacing="2">${escapeXml(overlay.corner)}</text>
      <text x="1530" y="190" fill="#C8C0B1" font-size="25" font-weight="700" letter-spacing="2">MARA'S EXIT</text>`;
  } else if (overlay.cornerStyle === "panel_dark") {
    corner = `<rect x="1328" y="38" width="562" height="272" rx="16" fill="#171717"/>
      <rect x="1328" y="38" width="15" height="272" rx="7" fill="#C4111B"/>
      <text x="1380" y="155" fill="#F4EEDC" font-size="49" font-weight="900" letter-spacing="3">${escapeXml(overlay.corner)}</text>
      <text x="1380" y="225" fill="#C8C0B1" font-size="27" font-weight="700" letter-spacing="2">EVERY PERSON PAID</text>`;
  } else if (overlay.corner) {
    corner = `<rect x="1525" y="76" width="305" height="76" rx="12" fill="#171717"/>
      <rect x="1525" y="76" width="12" height="76" rx="6" fill="#C4111B"/>
      <text x="1558" y="127" fill="#F4EEDC" font-size="31" font-weight="900" letter-spacing="2">${escapeXml(overlay.corner)}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <g font-family="Avenir Next, Helvetica Neue, sans-serif">${badge}${label}${corner}</g>
  </svg>`;
}

function buildTimeline(prompts, narrationEndSec) {
  const targetDuration = Math.min(174, narrationEndSec + 1.5);
  const items = [];
  prompts.forEach((prompt, zeroIndex) => {
    const index = zeroIndex + 1;
    const start = Number(prompt.start_sec);
    const nominalEnd = start + Number(prompt.duration_sec);
    const end = Math.min(targetDuration, nominalEnd);
    if (start >= targetDuration) return;
    const image = imagePath(prompt.image_id);

    if (index === 1) {
      items.push({
        id: "opening_police_motion",
        prompt_index: index,
        kind: "broll",
        source: broll.police.path,
        source_info: broll.police.info_path,
        source_start: 0,
        start_sec: start,
        end_sec: 0.9,
      });
      items.push({
        id: `${prompt.image_id}_opening_curtains`,
        prompt_index: index,
        kind: "still",
        source: image,
        start_sec: 0.9,
        end_sec: end,
        overlay: stillOverlays.get(index),
        direction: 1,
      });
      return;
    }

    if (index === 5) {
      const split = Math.min(end, start + 2.12);
      items.push({
        id: "thirty_days_earlier_card",
        prompt_index: index,
        kind: "chronology",
        start_sec: start,
        end_sec: split,
        label: "30 DAYS EARLIER",
        sublabel: "You take control. The hidden cost starts now.",
      });
      if (split < end) items.push({
        id: `${prompt.image_id}_entry`,
        prompt_index: index,
        kind: "still",
        source: image,
        start_sec: split,
        end_sec: end,
        direction: -1,
      });
      return;
    }

    if (index === 11) {
      items.push({
        id: "cash_counting_money_leaks",
        prompt_index: index,
        kind: "broll",
        source: broll.cash.path,
        source_info: broll.cash.info_path,
        source_start: 2.4,
        start_sec: start,
        end_sec: end,
        overlay: { badge: "THE ILLUSION", label: "MONEY IN DOES NOT MEAN MONEY KEPT" },
      });
      return;
    }

    if (index === 34) {
      items.push({
        id: "day_thirty_card",
        prompt_index: index,
        kind: "chronology",
        start_sec: start,
        end_sec: end,
        label: "DAY 30",
        sublabel: "The opening crisis arrives.",
      });
      return;
    }

    const spec = graphicSpecs.get(index);
    items.push({
      id: spec ? `${prompt.image_id}_deterministic_graphic` : prompt.image_id,
      prompt_index: index,
      image_id: prompt.image_id,
      kind: spec ? "graphic" : "still",
      source: spec ? null : image,
      spec,
      start_sec: start,
      end_sec: end,
      overlay: spec ? null : stillOverlays.get(index),
      direction: index % 2 === 0 ? -1 : 1,
    });
  });

  items.sort((left, right) => left.start_sec - right.start_sec);
  const targetFrames = Math.round(targetDuration * FPS);
  items.forEach((item, index) => {
    const startFrame = Math.round(item.start_sec * FPS);
    const endFrame = index === items.length - 1
      ? targetFrames
      : Math.round(item.end_sec * FPS);
    item.start_frame = startFrame;
    item.end_frame = endFrame;
    item.frames = endFrame - startFrame;
    item.duration_sec = item.frames / FPS;
    item.output_path = path.join(clipDir, `${String(index + 1).padStart(3, "0")}-${item.id}.mp4`);
    if (item.frames < 1) throw new Error(`Invalid duration for ${item.id}`);
    if (index > 0 && item.start_frame !== items[index - 1].end_frame) {
      throw new Error(`Timeline gap or overlap before ${item.id}`);
    }
  });
  if (items.at(-1).end_frame !== targetFrames) throw new Error("Timeline does not end on target frame.");
  return { items, targetDuration, targetFrames };
}

async function renderOverlay(item) {
  if (!item.overlay) return null;
  const outputPath = path.join(overlayDir, `${item.id}.png`);
  try {
    await ensureFile(outputPath);
    return outputPath;
  } catch {
    await sharp(Buffer.from(overlaySvg(item.overlay))).png().toFile(outputPath);
    return outputPath;
  }
}

async function clipIsReusable(item) {
  try {
    const details = await probe(item.output_path);
    const video = details.streams.find((stream) => stream.codec_type === "video");
    return Math.abs(Number(details.format.duration) - item.duration_sec) <= (2 / FPS)
      && Number(video?.width) === WIDTH
      && Number(video?.height) === HEIGHT;
  } catch {
    return false;
  }
}

async function encodeStill(item) {
  const overlay = await renderOverlay(item);
  const zoom = item.direction > 0
    ? "min(zoom+0.00034,1.085)"
    : "if(eq(on,1),1.085,max(zoom-0.0003,1.0))";
  const base = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS},setsar=1`;
  if (!overlay) {
    await run(ffmpegBin, [
      "-y", "-v", "error", "-loop", "1", "-i", item.source,
      "-vf", base,
      "-frames:v", String(item.frames), "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS),
      "-movflags", "+faststart", item.output_path,
    ]);
    return;
  }
  const duration = item.duration_sec;
  const filters = `[0:v]${base},trim=duration=${duration},setpts=PTS-STARTPTS[base];[1:v]format=rgba,fade=t=in:st=0:d=0.12:alpha=1,trim=duration=${duration},setpts=PTS-STARTPTS[ol];[base][ol]overlay=0:0:format=auto,trim=duration=${duration},fps=${FPS},format=yuv420p[out]`;
  await run(ffmpegBin, [
    "-y", "-v", "error", "-loop", "1", "-i", item.source,
    "-loop", "1", "-i", overlay,
    "-filter_complex", filters, "-map", "[out]", "-frames:v", String(item.frames), "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-movflags", "+faststart", item.output_path,
  ]);
}

async function encodeBroll(item) {
  const overlay = await renderOverlay(item);
  const duration = item.duration_sec;
  const base = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS},eq=contrast=1.035:saturation=0.86:gamma=0.97,trim=duration=${duration},setpts=PTS-STARTPTS`;
  if (!overlay) {
    await run(ffmpegBin, [
      "-y", "-v", "error", "-ss", String(item.source_start), "-i", item.source,
      "-vf", base, "-frames:v", String(item.frames), "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS),
      "-movflags", "+faststart", item.output_path,
    ]);
    return;
  }
  const filters = `[0:v]${base}[base];[1:v]format=rgba,fade=t=in:st=0:d=0.12:alpha=1,trim=duration=${duration},setpts=PTS-STARTPTS[ol];[base][ol]overlay=0:0:format=auto,trim=duration=${duration},fps=${FPS},format=yuv420p[out]`;
  await run(ffmpegBin, [
    "-y", "-v", "error", "-ss", String(item.source_start), "-i", item.source,
    "-loop", "1", "-i", overlay,
    "-filter_complex", filters, "-map", "[out]", "-frames:v", String(item.frames), "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-movflags", "+faststart", item.output_path,
  ]);
}

async function encodeGraphic(item) {
  const frameDir = path.join(graphicDir, item.id);
  await fs.mkdir(frameDir, { recursive: true });
  const frameCount = Math.max(2, Math.ceil(item.duration_sec * GRAPHIC_FPS));
  await mapLimit(Array.from({ length: frameCount }, (_, index) => index), 8, async (index) => {
    const framePath = path.join(frameDir, `${String(index).padStart(5, "0")}.png`);
    try {
      await ensureFile(framePath);
      return;
    } catch {
      const progress = frameCount <= 1 ? 1 : index / (frameCount - 1);
      const svg = item.kind === "chronology"
        ? chronologySvg(item.label, item.sublabel, progress)
        : graphicSvg(item.spec, progress);
      await sharp(Buffer.from(svg)).png().toFile(framePath);
    }
  });
  await run(ffmpegBin, [
    "-y", "-v", "error", "-framerate", String(GRAPHIC_FPS), "-i", path.join(frameDir, "%05d.png"),
    "-vf", `fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos,setsar=1`,
    "-frames:v", String(item.frames), "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-movflags", "+faststart", item.output_path,
  ]);
}

async function encodeItem(item) {
  if (await clipIsReusable(item)) return { ...item, reused: true };
  if (item.kind === "still") await encodeStill(item);
  else if (item.kind === "broll") await encodeBroll(item);
  else if (item.kind === "graphic" || item.kind === "chronology") await encodeGraphic(item);
  else throw new Error(`Unknown visual kind: ${item.kind}`);
  await ensureFile(item.output_path);
  return { ...item, reused: false };
}

async function buildSilentVideo(items, targetDuration, outputPath) {
  const concatPath = path.join(workDir, "visual_timeline.ffconcat");
  const lines = ["ffconcat version 1.0", ...items.map((item) => `file '${item.output_path.replaceAll("'", "'\\''")}'`)];
  await fs.writeFile(concatPath, `${lines.join("\n")}\n`, "utf8");
  await run(ffmpegBin, [
    "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", concatPath,
    "-t", String(targetDuration), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
    "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart", outputPath,
  ]);
  return concatPath;
}

function cueFilter(item, inputIndex, label) {
  const operations = [
    `atrim=start=${item.source_start}:duration=${item.duration}`,
    "asetpts=N/SR/TB",
    "aresample=48000",
    "aformat=sample_rates=48000:channel_layouts=stereo",
    "highpass=f=38",
    "lowpass=f=15500",
    `volume=${item.volume}`,
  ];
  if (item.fade_in) operations.push(`afade=t=in:st=0:d=${item.fade_in}`);
  if (item.fade_out) operations.push(`afade=t=out:st=${Math.max(0, item.duration - item.fade_out)}:d=${item.fade_out}`);
  operations.push(`adelay=${Math.round(item.start * 1000)}:all=1`);
  return `[${inputIndex}:a]${operations.join(",")}[${label}]`;
}

async function mixFinal(silentVideo, targetDuration, outputPath) {
  const scopedCues = sfxCues.filter((item) => item.start < targetDuration);
  const args = ["-y", "-v", "error", "-i", silentVideo, "-i", inputs.narration, "-stream_loop", "-1", "-i", inputs.music];
  scopedCues.forEach((item) => args.push("-i", sfxSources[item.sourceKey].path));
  const filters = [
    `[1:a]atrim=0:${targetDuration},asetpts=N/SR/TB,highpass=f=58,aformat=sample_rates=48000:channel_layouts=stereo[voice]`,
    `[2:a]atrim=0:${targetDuration},asetpts=N/SR/TB,loudnorm=I=-24:LRA=8:TP=-2,volume=${scoreBedGain.toFixed(7)},afade=t=in:st=0:d=0.9,afade=t=out:st=${Math.max(0, targetDuration - 2)}:d=1.8,aformat=sample_rates=48000:channel_layouts=stereo[bed]`,
  ];
  const labels = ["[voice]", "[bed]"];
  scopedCues.forEach((item, index) => {
    const label = `fx${index}`;
    filters.push(cueFilter(item, index + 3, label));
    labels.push(`[${label}]`);
  });
  filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,loudnorm=I=-14.5:LRA=8:TP=-1.5,alimiter=limit=0.84:level=false[mix]`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "0:v:0", "-map", "[mix]", "-t", String(targetDuration),
    "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-movflags", "+faststart", outputPath,
  );
  await run(ffmpegBin, args);
  return scopedCues;
}

async function sourceMetadata(infoPath) {
  const value = await readJson(infoPath);
  return {
    youtube_id: value.id ?? null,
    youtube_url: value.webpage_url ?? value.original_url ?? null,
    title: value.title ?? null,
    channel: value.channel ?? value.uploader ?? null,
    duration_sec: value.duration ?? null,
  };
}

async function buildLedgers(items, cues) {
  const visualRows = [];
  for (const item of items) {
    if (item.kind === "broll") {
      visualRows.push({
        cut_id: item.id,
        kind: "sourced_motion",
        timeline_start_sec: round(item.start_sec),
        timeline_end_sec: round(item.end_sec),
        source_start_sec: item.source_start,
        source_end_sec: round(item.source_start + item.duration_sec),
        source_path: item.source,
        source_sha256: await sha256File(item.source),
        source_metadata_path: item.source_info,
        source_metadata_sha256: await sha256File(item.source_info),
        ...(await sourceMetadata(item.source_info)),
      });
    } else if (item.kind === "still") {
      visualRows.push({
        cut_id: item.id,
        kind: generatedStillKind,
        prompt_index: item.prompt_index,
        timeline_start_sec: round(item.start_sec),
        timeline_end_sec: round(item.end_sec),
        source_path: item.source,
        source_sha256: await sha256File(item.source),
      });
    } else {
      visualRows.push({
        cut_id: item.id,
        kind: "deterministic_editorial_graphic",
        prompt_index: item.prompt_index,
        timeline_start_sec: round(item.start_sec),
        timeline_end_sec: round(item.end_sec),
        source_path: currentFile,
        source_sha256: await sha256File(currentFile),
      });
    }
  }

  const audioRows = [];
  for (const item of cues) {
    const source = sfxSources[item.sourceKey];
    audioRows.push({
      cue_id: item.id,
      timeline_start_sec: item.start,
      source_start_sec: item.source_start,
      source_end_sec: round(item.source_start + item.duration),
      gain_scalar: item.volume,
      source_path: source.path,
      source_sha256: await sha256File(source.path),
      source_metadata_path: source.info_path,
      source_metadata_sha256: await sha256File(source.info_path),
      ...(await sourceMetadata(source.info_path)),
    });
  }

  const visualPath = path.join(outputDir, "proof_visual_source_ledger.json");
  const audioPath = path.join(outputDir, "proof_audio_source_ledger.json");
  await writeJson(visualPath, {
    schema: "goldflow_immersive_pov_proof_visual_source_ledger_v1",
    status: "passed",
    proof_only: true,
    rights_review_deferred_by_operator: true,
    rows: visualRows,
  });
  await writeJson(audioPath, {
    schema: "goldflow_immersive_pov_proof_audio_source_ledger_v1",
    status: "passed",
    proof_only: true,
    rights_review_deferred_by_operator: true,
    fixed_score_level: true,
    narration_linked_score_recovery: false,
    score_bed_effective_trim_db: scoreBedEffectiveTrimDb,
    narration: {
      path: inputs.narration,
      sha256: await sha256File(inputs.narration),
    },
    music: {
      path: inputs.music,
      sha256: await sha256File(inputs.music),
      metadata_path: inputs.musicMetadata,
      metadata_sha256: await sha256File(inputs.musicMetadata),
    },
    sfx_cues: audioRows,
  });
  return { visualPath, audioPath, visualRows, audioRows };
}

async function buildContactSheet(videoPath, outputPath) {
  await run(ffmpegBin, [
    "-y", "-v", "error", "-i", videoPath,
    "-vf", "fps=1/11.5,scale=384:216,tile=5x4:padding=5:margin=5:color=0x171717",
    "-frames:v", "1", outputPath,
  ]);
}

async function validateInputs() {
  const [prompts, imageReport, imageQa, runIdentity, approval, timing, narrationReport] = await Promise.all([
    readJson(inputs.prompts),
    readJson(inputs.imageReport),
    readJson(inputs.imageQa),
    readJson(inputs.runIdentity),
    readJson(inputs.scriptApproval),
    readJson(inputs.wordTiming),
    readJson(inputs.narrationReport),
  ]);
  const scriptHash = await sha256File(inputs.script);
  const approvedScriptHash = approval.script_clean_hash ?? approval.script_hash;
  if (approval.status !== "approved" || approvedScriptHash !== scriptHash) throw new Error("Script approval is stale.");
  if (prompts.status !== "passed" || prompts.prompts?.length !== 46) throw new Error("Expected 46 passed hardened prompts.");
  if (imageQa.status !== "passed") throw new Error("Image QA has not passed.");
  if (runIdentity.run_intent !== "proof") throw new Error("This builder is restricted to the proof identity.");
  if (runIdentity.image_provider !== "modelslab") throw new Error("Expected ModelsLab/Flux proof identity.");
  if (narrationReport.final_audio_sha256 !== await sha256File(inputs.narration)) throw new Error("Narration master hash mismatch.");
  if (timing.status !== "passed" || !timing.words?.length) throw new Error("Whisper timing is missing.");
  const lastWordEnd = Number(timing.words.at(-1).end_sec);
  const required = [
    inputs.script,
    inputs.prompts,
    inputs.imageReport,
    inputs.imageQa,
    inputs.runIdentity,
    inputs.narration,
    inputs.music,
    inputs.musicMetadata,
    ...Object.values(broll).flatMap((source) => [source.path, source.info_path]),
    ...Object.values(sfxSources).flatMap((source) => [source.path, source.info_path]),
    ...prompts.prompts
      .filter((_, index) => RENDERED_STILL_INDICES.has(index + 1))
      .map((prompt) => imagePath(prompt.image_id)),
  ];
  await Promise.all([...new Set(required)].map((filePath) => ensureFile(filePath)));
  return { prompts, imageReport, imageQa, runIdentity, timing, narrationReport, scriptHash, lastWordEnd };
}

async function main() {
  const finalPath = path.join(outputDir, `immersive_pov_illegal_brothel_30_days_proof_${proofVersion}.mp4`);
  try {
    await fs.access(finalPath);
    throw new Error(`Append-only proof already exists: ${finalPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const validated = await validateInputs();
  await fs.mkdir(clipDir, { recursive: true });
  await fs.mkdir(graphicDir, { recursive: true });
  await fs.mkdir(overlayDir, { recursive: true });
  const timeline = buildTimeline(validated.prompts.prompts, validated.lastWordEnd);
  const encoded = await mapLimit(timeline.items, concurrency, encodeItem);
  const silentPath = path.join(workDir, "immersive_pov_silent_edit_v1.mp4");
  const concatPath = await buildSilentVideo(encoded, timeline.targetDuration, silentPath);
  const scopedCues = await mixFinal(silentPath, timeline.targetDuration, finalPath);
  const outputProbe = await probe(finalPath);

  const openingPreviewPath = path.join(outputDir, `immersive_pov_illegal_brothel_opening_45s_${proofVersion}.mp4`);
  await run(ffmpegBin, [
    "-y", "-v", "error", "-i", finalPath, "-t", "45", "-c", "copy", "-movflags", "+faststart", openingPreviewPath,
  ]);
  const contactSheetPath = path.join(outputDir, `immersive_pov_illegal_brothel_contact_sheet_${proofVersion}.jpg`);
  await buildContactSheet(finalPath, contactSheetPath);
  const ledgers = await buildLedgers(timeline.items, scopedCues);
  const kindDurations = Object.fromEntries(["still", "graphic", "chronology", "broll"].map((kind) => [
    kind,
    round(timeline.items.filter((item) => item.kind === kind).reduce((sum, item) => sum + item.duration_sec, 0)),
  ]));
  const report = {
    schema: "goldflow_immersive_pov_illegal_brothel_proof_v1",
    status: "rendered_pending_operator_review",
    proof_only: true,
    official_pipeline_artifacts_modified: false,
    created_at: new Date().toISOString(),
    output_dir: outputDir,
    lineage: {
      proof_version: proofVersion,
      pacing_reference: "asset_afterlife_full_proof_v1",
      score_policy_reference: "asset_afterlife_fixed_ducked_v1",
      generated_image_model: generatedImageModel,
      accepted_source_rasters_modified: false,
      garbled_generated_graphics_replaced_at_edit_time: true,
    },
    sources: {
      run_identity_path: inputs.runIdentity,
      run_identity_sha256: await sha256File(inputs.runIdentity),
      script_path: inputs.script,
      script_sha256: validated.scriptHash,
      hardened_prompt_path: inputs.prompts,
      hardened_prompt_sha256: await sha256File(inputs.prompts),
      image_report_path: inputs.imageReport,
      image_report_sha256: await sha256File(inputs.imageReport),
      image_qa_path: inputs.imageQa,
      image_qa_sha256: await sha256File(inputs.imageQa),
      narration_path: inputs.narration,
      narration_sha256: await sha256File(inputs.narration),
      whisper_timing_path: inputs.wordTiming,
      whisper_timing_sha256: await sha256File(inputs.wordTiming),
    },
    edit: {
      target_duration_sec: timeline.targetDuration,
      total_cut_count: timeline.items.length,
      source_visual_beat_count: validated.prompts.prompts.length,
      average_cut_duration_sec: round(timeline.targetDuration / timeline.items.length),
      kind_duration_sec: kindDurations,
      real_motion_share: round(kindDurations.broll / timeline.targetDuration, 4),
      deterministic_graphic_share: round((kindDurations.graphic + kindDurations.chronology) / timeline.targetDuration, 4),
      generated_still_share: round(kindDurations.still / timeline.targetDuration, 4),
      hard_cut_timeline: true,
      cached_clip_count: encoded.filter((item) => item.reused).length,
      concat_manifest_path: concatPath,
      timeline: timeline.items.map((item) => ({
        id: item.id,
        prompt_index: item.prompt_index,
        kind: item.kind,
        start_sec: round(item.start_sec),
        end_sec: round(item.end_sec),
        duration_sec: round(item.duration_sec),
        frames: item.frames,
        output_path: item.output_path,
      })),
    },
    audio: {
      sourced_sfx_cue_count: scopedCues.length,
      generated_sfx_used: false,
      continuous_score_used: true,
      score_bed_trim_db: scoreBedTrimDb,
      score_bed_fixed_duck_db: scoreBedFixedDuckDb,
      score_bed_effective_trim_db: scoreBedEffectiveTrimDb,
      score_level_mode: "fixed_ducked",
      narration_linked_ducking_applied: false,
      narration_gap_music_recovery: false,
      target_lufs: -14.5,
      target_true_peak_dbtp: -1.5,
      visual_source_ledger_path: ledgers.visualPath,
      audio_source_ledger_path: ledgers.audioPath,
    },
    output: {
      video_path: finalPath,
      video_sha256: await sha256File(finalPath),
      duration_sec: Number(outputProbe.format.duration),
      size_bytes: Number(outputProbe.format.size),
      probe: outputProbe,
      opening_preview_path: openingPreviewPath,
      opening_preview_sha256: await sha256File(openingPreviewPath),
      contact_sheet_path: contactSheetPath,
      contact_sheet_sha256: await sha256File(contactSheetPath),
    },
  };
  const reportPath = path.join(outputDir, `immersive_pov_illegal_brothel_proof_${proofVersion}_report.json`);
  await writeJson(reportPath, report);
  const recipeDir = path.join(outputDir, `recipe_snapshot_${proofVersion}`);
  await fs.mkdir(recipeDir, { recursive: true });
  await fs.copyFile(currentFile, path.join(recipeDir, path.basename(currentFile)));
  await fs.copyFile(path.join(repoRoot, "AGENTS.md"), path.join(recipeDir, "AGENTS.md"));

  process.stdout.write(`${JSON.stringify({
    status: report.status,
    video_path: finalPath,
    video_sha256: report.output.video_sha256,
    duration_sec: report.output.duration_sec,
    cut_count: report.edit.total_cut_count,
    opening_preview_path: openingPreviewPath,
    contact_sheet_path: contactSheetPath,
    report_path: reportPath,
  }, null, 2)}\n`);
}

await main();
