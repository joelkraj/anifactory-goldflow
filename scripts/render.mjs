#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFile = promisify(execFileCb);
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const assetsDir = path.join(episodeDir, "assets");
const renderDir = path.join(assetsDir, "renders");
const workDir = path.join(assetsDir, "render-work");
const promptPlanPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts.json");
const imagegenReportPath = flags.imagegenReport ?? flags["imagegen-report"] ?? path.join(episodeDir, `imagegen_report_${episode}.json`);
const wordTimingPath = flags.wordTiming ?? flags["word-timing"] ?? path.join(episodeDir, `narration_word_timing_${episode}.json`);
const audioBedReportPath = flags.audioBedReport ?? flags["audio-bed-report"] ?? path.join(episodeDir, `longform_audio_bed_report_${episode}.json`);
const audioStitchReportPath = flags.audioStitchReport ?? flags["audio-stitch-report"] ?? path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
const transitionEditPlanPath = flags.transitionPlan ?? flags["transition-plan"] ?? path.join(episodeDir, `transition_edit_plan_${episode}.json`);
const engagementOverlayPlanPath = flags.engagementPlan ?? flags["engagement-plan"] ?? path.join(episodeDir, `engagement_overlay_plan_${episode}.json`);
const outputPath = flags.output ?? path.join(renderDir, `${episode}-${channel}-goldflow.mp4`);
const renderReportPath = flags.reportOutput ?? flags["report-output"] ?? path.join(episodeDir, `render_report_${episode}.json`);
const width = Number(flags.width ?? 1920);
const height = Number(flags.height ?? 1080);
const fps = Number(flags.fps ?? 30);
const motionMode = flags.motion ?? process.env.ANIFACTORY_RENDER_MOTION ?? "fill_ken_burns";
const foregroundScale = Number(flags["foreground-scale"] ?? process.env.ANIFACTORY_RENDER_FOREGROUND_SCALE ?? 0.93);
const motionStrength = Number(flags["motion-strength"] ?? process.env.ANIFACTORY_RENDER_MOTION_STRENGTH ?? 1.75);
const visualFadeSec = Number(flags["visual-fade-sec"] ?? process.env.ANIFACTORY_RENDER_VISUAL_FADE_SEC ?? 0);
const hookTransitionSec = Number(flags["hook-transition-sec"] ?? process.env.ANIFACTORY_RENDER_HOOK_TRANSITION_SEC ?? 30);
const retentionXfadeSec = Number(flags["retention-xfade-sec"] ?? process.env.ANIFACTORY_RENDER_RETENTION_XFADE_SEC ?? 180);
const transitionTailSec = Number(flags["transition-tail-sec"] ?? process.env.ANIFACTORY_RENDER_TRANSITION_TAIL_SEC ?? 0.28);
const hookXfadeEnabled = flags["hook-xfade"] !== "false" && !/^(false|0|no)$/i.test(String(process.env.ANIFACTORY_RENDER_HOOK_XFADE ?? "true"));
const hookXfadeDurationSec = Number(flags["hook-xfade-duration-sec"] ?? process.env.ANIFACTORY_RENDER_HOOK_XFADE_DURATION_SEC ?? 0.28);
const renderConcurrency = Math.max(1, Number(flags["render-concurrency"] ?? process.env.ANIFACTORY_RENDER_CONCURRENCY ?? 4));
const renderScaleMultiplier = Math.max(1.05, Number(flags["render-scale-multiplier"] ?? process.env.ANIFACTORY_RENDER_SCALE_MULTIPLIER ?? 1.45));
const clipPreset = flags["clip-preset"] ?? process.env.ANIFACTORY_RENDER_CLIP_PRESET ?? "veryfast";
const finalPreset = flags["final-preset"] ?? process.env.ANIFACTORY_RENDER_FINAL_PRESET ?? "veryfast";
const finalAudioLoudnormEnabled = flags["final-audio-loudnorm"] !== "false" && !/^(false|0|no)$/i.test(String(process.env.ANIFACTORY_RENDER_FINAL_AUDIO_LOUDNORM ?? "true"));
const finalAudioTargetLufsFlag = flags["final-audio-target-lufs"] ?? process.env.ANIFACTORY_RENDER_FINAL_AUDIO_TARGET_LUFS;
const finalAudioTruePeakFlag = flags["final-audio-true-peak-db"] ?? process.env.ANIFACTORY_RENDER_FINAL_AUDIO_TRUE_PEAK_DB;
const finalAudioLraFlag = flags["final-audio-lra"] ?? process.env.ANIFACTORY_RENDER_FINAL_AUDIO_LRA;

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function hashFile(filePath) {
  try {
    return sha256(await fs.readFile(filePath));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function mediaDuration(filePath) {
  const { stdout } = await execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath]);
  return Number(stdout.trim());
}

async function ffmpegHasFilter(filterName) {
  try {
    const { stdout } = await execFile("ffmpeg", ["-hide_banner", "-filters"]);
    return new RegExp(`\\s${filterName}\\s`).test(stdout);
  } catch {
    return false;
  }
}

function assTime(seconds) {
  const centis = Math.max(0, Math.round(Number(seconds) * 100));
  const cs = centis % 100;
  const totalSeconds = Math.floor(centis / 100);
  const sec = totalSeconds % 60;
  const min = Math.floor(totalSeconds / 60) % 60;
  const hour = Math.floor(totalSeconds / 3600);
  return `${hour}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function assEscape(value) {
  return String(value ?? "").replace(/[{}]/g, "").replace(/\r?\n/g, " ").trim();
}

function svgEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function captionTokens(value) {
  return String(value ?? "").match(/\S+/g) ?? [];
}

function timedCaptionSegments(stitchReport) {
  const segments = Array.isArray(stitchReport?.segments) ? stitchReport.segments : [];
  let cursor = 0;
  return segments.map((segment) => {
    const duration = Math.max(0, Number(segment.duration_sec ?? segment.raw_audio_duration_sec ?? 0));
    const start = cursor;
    const end = cursor + duration;
    cursor = end;
    return {
      segment_id: segment.segment_id,
      start_sec: start,
      end_sec: end,
      caption_text: String(segment.caption_text ?? segment.stripped_text ?? segment.text ?? "").trim(),
    };
  }).filter((segment) => segment.segment_id && segment.caption_text && segment.end_sec > segment.start_sec);
}

function whisperSubtitleGroups(words) {
  const events = [];
  let row = [];
  for (const word of words) {
    row.push(word);
    const text = row.map((item) => item.word).join(" ").trim();
    const duration = Number(row.at(-1)?.end_sec ?? 0) - Number(row[0]?.start_sec ?? 0);
    if (row.length >= 8 || duration >= 3.2 || /[.!?]$/.test(String(word.word))) {
      events.push(row);
      row = [];
    }
  }
  if (row.length) events.push(row);
  return events;
}

function subtitleEventsFromScript(words, stitchReport) {
  const segments = timedCaptionSegments(stitchReport);
  if (!segments.length) return null;
  const wordsBySegment = new Map();
  for (const word of words) {
    const segmentId = word.segment_id_guess;
    if (!segmentId) continue;
    if (!wordsBySegment.has(segmentId)) wordsBySegment.set(segmentId, []);
    wordsBySegment.get(segmentId).push(word);
  }
  const events = [];
  for (const segment of segments) {
    const segmentWords = wordsBySegment.get(segment.segment_id) ?? [];
    const groups = whisperSubtitleGroups(segmentWords);
    const tokens = captionTokens(segment.caption_text);
    if (!tokens.length) continue;
    if (!groups.length) {
      events.push({ start_sec: segment.start_sec, end_sec: segment.end_sec, text: segment.caption_text });
      continue;
    }
    let tokenCursor = 0;
    let wordCursor = 0;
    const totalWords = Math.max(1, segmentWords.length);
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      wordCursor += group.length;
      const targetTokenEnd = index === groups.length - 1
        ? tokens.length
        : Math.max(tokenCursor + 1, Math.round((wordCursor / totalWords) * tokens.length));
      const text = tokens.slice(tokenCursor, Math.min(tokens.length, targetTokenEnd)).join(" ").replace(/\s+/g, " ").trim();
      tokenCursor = Math.min(tokens.length, targetTokenEnd);
      if (text) {
        events.push({
          start_sec: Number(group[0].start_sec),
          end_sec: Number(group.at(-1).end_sec),
          text,
        });
      }
    }
  }
  return events.filter((row) => row.text && row.end_sec > row.start_sec);
}

function subtitleEvents(words, stitchReport = null) {
  const scriptEvents = subtitleEventsFromScript(words, stitchReport);
  if (scriptEvents?.length) return scriptEvents;
  return whisperSubtitleGroups(words).map((items) => ({
    start_sec: Number(items[0].start_sec),
    end_sec: Number(items.at(-1).end_sec),
    text: items.map((item) => item.word).join(" ").replace(/\s+/g, " ").trim(),
  })).filter((row) => row.text && row.end_sec > row.start_sec);
}

function buildSubtitleEvents(wordTiming, audioStitchReport = null) {
  const scriptEvents = subtitleEventsFromScript(wordTiming.words ?? [], audioStitchReport);
  if (scriptEvents?.length) {
    return {
      events: scriptEvents,
      source: "audio_stitch_caption_text_timed_by_whisper",
    };
  }
  return {
    events: subtitleEvents(wordTiming.words ?? []),
    source: "whisper_recognized_words_fallback",
  };
}

async function writeAss(filePath, events) {
  const header = `[Script Info]
ScriptType: v4.00+
ScaledBorderAndShadow: yes
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,62,&H0000FFFF,&H0000FFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3,0,2,90,90,86,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const body = events.map((event) => `Dialogue: 0,${assTime(event.start_sec)},${assTime(event.end_sec)},Default,,0,0,0,,${assEscape(event.text)}`).join("\n");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${header}${body}\n`, "utf8");
  return { subtitle_count: events.length, path: filePath };
}

function concatEscape(filePath) {
  return filePath.replace(/'/g, "'\\''");
}

function ffmpegFilterFilename(filePath) {
  return `'${String(filePath).replace(/\\/g, "\\\\").replace(/'/g, "'\\''")}'`;
}

function wrapSubtitleText(text, maxChars = 42) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function subtitleSvg(text) {
  const fontSize = Math.round(Math.max(42, Math.min(66, height * 0.057)));
  const lineHeight = Math.round(fontSize * 1.18);
  const lines = wrapSubtitleText(text);
  const firstY = height - 92 - Math.max(0, lines.length - 1) * lineHeight;
  const tspans = lines.map((line, index) => `<tspan x="${Math.round(width / 2)}" y="${firstY + index * lineHeight}">${svgEscape(line)}</tspan>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="none"/>
  <text text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffff00" stroke="#000000" stroke-width="6" paint-order="stroke fill" stroke-linejoin="round">${tspans}</text>
</svg>`;
}

function blankSubtitleSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="none"/></svg>`;
}

function wrapEngagementText(text) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > 17 && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function engagementPalette(style) {
  if (style === "red_subscribe_bubble") return { fill: "#ff3030", stroke: "#ffffff", text: "#ffffff", textStroke: "#111111" };
  if (style === "blue_system_bubble") return { fill: "#45d4ff", stroke: "#07121f", text: "#06101a", textStroke: "#ffffff" };
  if (style === "white_comment_bubble") return { fill: "#ffffff", stroke: "#111111", text: "#111111", textStroke: "#ffffff" };
  return { fill: "#ffd91a", stroke: "#111111", text: "#111111", textStroke: "#ffffff" };
}

function engagementBox(position, lineCount) {
  const boxW = Math.round(width * 0.28);
  const boxH = Math.round(96 + Math.max(0, lineCount - 1) * 46);
  const marginX = Math.round(width * 0.045);
  const topY = Math.round(height * 0.085);
  const midY = Math.round(height * 0.33);
  if (position === "top_left") return { x: marginX, y: topY, w: boxW, h: boxH };
  if (position === "mid_left") return { x: marginX, y: midY, w: boxW, h: boxH };
  if (position === "mid_right") return { x: width - boxW - marginX, y: midY, w: boxW, h: boxH };
  if (position === "top_center") return { x: Math.round((width - boxW) / 2), y: topY, w: boxW, h: boxH };
  return { x: width - boxW - marginX, y: topY, w: boxW, h: boxH };
}

function easeOutCubic(value) {
  const t = Math.max(0, Math.min(1, value));
  return 1 - Math.pow(1 - t, 3);
}

function engagementAnimation(event, progress) {
  const enter = easeOutCubic(Math.min(1, progress / 0.18));
  const exit = progress > 0.86 ? Math.max(0, 1 - ((progress - 0.86) / 0.14)) : 1;
  const opacity = Math.max(0, Math.min(1, enter * exit));
  const animation = String(event.animation ?? "pop");
  const scale = animation === "bounce"
    ? 0.82 + 0.18 * enter + Math.sin(enter * Math.PI) * 0.045
    : animation === "pop"
      ? 0.78 + 0.22 * enter
      : 1;
  const slide = animation === "slide_in" || animation === "sweep"
    ? Math.round((1 - enter) * (String(event.position ?? "").includes("left") ? -70 : 70))
    : 0;
  return { opacity, scale, slide };
}

function engagementSvg(event, progress) {
  const lines = wrapEngagementText(event.text);
  const box = engagementBox(event.position, lines.length);
  const palette = engagementPalette(event.style);
  const anim = engagementAnimation(event, progress);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const fontSize = Math.round(Math.max(34, Math.min(48, height * 0.041)));
  const lineHeight = Math.round(fontSize * 1.08);
  const firstY = box.y + Math.round(box.h / 2) - Math.round((lines.length - 1) * lineHeight / 2) + Math.round(fontSize * 0.36);
  const tspans = lines.map((line, index) => `<tspan x="${box.x + Math.round(box.w / 2)}" y="${firstY + index * lineHeight}">${svgEscape(line.toUpperCase())}</tspan>`).join("");
  const pointerX = String(event.position ?? "").includes("left") ? box.x + Math.round(box.w * 0.23) : box.x + Math.round(box.w * 0.77);
  const pointer = `${pointerX},${box.y + box.h} ${pointerX + 34},${box.y + box.h} ${pointerX + 14},${box.y + box.h + 34}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="bubbleShadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="8" flood-color="#000000" flood-opacity="0.42"/>
    </filter>
  </defs>
  <rect width="100%" height="100%" fill="none"/>
  <g opacity="${anim.opacity.toFixed(3)}" transform="translate(${anim.slide} 0) translate(${cx} ${cy}) scale(${anim.scale.toFixed(3)}) translate(${-cx} ${-cy})" filter="url(#bubbleShadow)">
    <polygon points="${pointer}" fill="${palette.fill}" stroke="${palette.stroke}" stroke-width="8" stroke-linejoin="round"/>
    <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="34" ry="34" fill="${palette.fill}" stroke="${palette.stroke}" stroke-width="8"/>
    <rect x="${box.x + 13}" y="${box.y + 12}" width="${box.w - 26}" height="${box.h - 24}" rx="24" ry="24" fill="none" stroke="#ffffff" stroke-width="4" opacity="0.62"/>
    <text text-anchor="middle" font-family="Arial Black, Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900" fill="${palette.text}" stroke="${palette.textStroke}" stroke-width="3" paint-order="stroke fill" stroke-linejoin="round">${tspans}</text>
  </g>
</svg>`;
}

async function writeSubtitlePng(filePath, svg) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

async function writeSubtitleOverlayVideo(filePath, events, audioDuration) {
  const frameDir = path.join(workDir, "subtitle-frames");
  await fs.rm(frameDir, { recursive: true, force: true });
  await fs.mkdir(frameDir, { recursive: true });
  const blankPath = path.join(frameDir, "blank.png");
  await writeSubtitlePng(blankPath, blankSubtitleSvg());
  const rows = [];
  let cursor = 0;
  let frameIndex = 0;
  for (const event of events) {
    const start = Math.max(0, Number(event.start_sec));
    const end = Math.min(Number(audioDuration), Number(event.end_sec));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (start > cursor + 0.03) {
      rows.push({ filePath: blankPath, duration: start - cursor });
    }
    const framePath = path.join(frameDir, `${String(frameIndex).padStart(5, "0")}.png`);
    await writeSubtitlePng(framePath, subtitleSvg(event.text));
    rows.push({ filePath: framePath, duration: end - start });
    cursor = Math.max(cursor, end);
    frameIndex += 1;
  }
  if (audioDuration > cursor + 0.03) rows.push({ filePath: blankPath, duration: audioDuration - cursor });
  if (!rows.length) rows.push({ filePath: blankPath, duration: Math.max(1, audioDuration) });
  const concatPath = path.join(workDir, "subtitles.concat.txt");
  const lines = [];
  for (const row of rows) {
    lines.push(`file '${concatEscape(row.filePath)}'`);
    lines.push(`duration ${Math.max(0.05, row.duration).toFixed(3)}`);
  }
  lines.push(`file '${concatEscape(rows.at(-1).filePath)}'`);
  await fs.writeFile(concatPath, `${lines.join("\n")}\n`, "utf8");
  await execFile("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatPath,
    "-vf", "fps=10,format=argb",
    "-c:v", "qtrle",
    filePath,
  ], { maxBuffer: 1024 * 1024 * 32 });
  return { path: filePath, frame_count: frameIndex };
}

function normalizeEngagementEvents(engagementPlan, audioDuration) {
  if (engagementPlan?.status !== "passed") return [];
  const rows = Array.isArray(engagementPlan.engagement_overlays) ? engagementPlan.engagement_overlays : [];
  return rows
    .map((event) => {
      const start = Number(event.start_sec);
      const duration = Math.max(1.5, Number(event.duration_sec ?? 4));
      const end = Number(event.end_sec ?? start + duration);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start >= audioDuration) return null;
      return {
        ...event,
        start_sec: Math.max(0, start),
        end_sec: Math.min(audioDuration, end),
        duration_sec: Math.min(duration, Math.max(0.5, audioDuration - start)),
        text: String(event.text ?? "").trim().slice(0, 72),
      };
    })
    .filter((event) => event?.text)
    .sort((left, right) => left.start_sec - right.start_sec);
}

async function writeEngagementOverlayVideo(filePath, engagementPlan, audioDuration) {
  const events = normalizeEngagementEvents(engagementPlan, audioDuration);
  if (!events.length) return { path: null, frame_count: 0, events: [] };
  const overlayFps = 10;
  const frameDuration = 1 / overlayFps;
  const frameDir = path.join(workDir, "engagement-frames");
  await fs.rm(frameDir, { recursive: true, force: true });
  await fs.mkdir(frameDir, { recursive: true });
  const blankPath = path.join(frameDir, "blank.png");
  await writeSubtitlePng(blankPath, blankSubtitleSvg());
  const rows = [];
  let cursor = 0;
  let frameIndex = 0;
  for (const event of events) {
    const start = Math.max(cursor, Number(event.start_sec));
    const end = Math.min(Number(audioDuration), Number(event.end_sec));
    if (end <= start) continue;
    if (start > cursor + 0.03) rows.push({ filePath: blankPath, duration: start - cursor });
    const frameCount = Math.max(1, Math.ceil((end - start) * overlayFps));
    for (let index = 0; index < frameCount; index += 1) {
      const progress = frameCount <= 1 ? 1 : index / (frameCount - 1);
      const framePath = path.join(frameDir, `${String(frameIndex).padStart(5, "0")}.png`);
      await writeSubtitlePng(framePath, engagementSvg(event, progress));
      rows.push({ filePath: framePath, duration: frameDuration });
      frameIndex += 1;
    }
    cursor = Math.max(cursor, end);
  }
  if (audioDuration > cursor + 0.03) rows.push({ filePath: blankPath, duration: audioDuration - cursor });
  const concatPath = path.join(workDir, "engagement.concat.txt");
  const lines = [];
  for (const row of rows) {
    lines.push(`file '${concatEscape(row.filePath)}'`);
    lines.push(`duration ${Math.max(0.05, row.duration).toFixed(3)}`);
  }
  lines.push(`file '${concatEscape(rows.at(-1).filePath)}'`);
  await fs.writeFile(concatPath, `${lines.join("\n")}\n`, "utf8");
  await execFile("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatPath,
    "-vf", `fps=${overlayFps},format=argb`,
    "-c:v", "qtrle",
    filePath,
  ], { maxBuffer: 1024 * 1024 * 32 });
  return { path: filePath, frame_count: frameIndex, events };
}

function imageDuration(prompt, scale = 1) {
  return Math.max(1, Number(prompt.duration_sec ?? 6) * scale);
}

function clipFrameCount(duration) {
  return Math.max(1, Math.round(Number(duration) * fps));
}

function hashUnit(value, salt = "0") {
  const hex = sha256(`${value}:${salt}`).slice(0, 8);
  return Number.parseInt(hex, 16) / 0xffffffff;
}

function promptSeed(prompt, index) {
  return [
    prompt.image_id,
    prompt.visual_beat_id,
    prompt.scene_id,
    index,
  ].filter(Boolean).join("|");
}

function variedZoom(baseZoom, variance) {
  return 1 + (baseZoom - 1) * variance;
}

function sceneChanged(prompt, previousPrompt = null) {
  return Boolean(previousPrompt?.scene_id && prompt?.scene_id && previousPrompt.scene_id !== prompt.scene_id);
}

function promptTextBundle(prompt) {
  return [
    prompt.visual_beat_focus,
    prompt.visual_beat_action,
    prompt.visual_beat_script_excerpt,
    prompt.primary_subject,
    prompt.location,
    prompt.modelslab_image_prompt,
    prompt.image_prompt,
    prompt.shot_manifest?.shot_job,
    prompt.shot_manifest?.foreground_action,
    ...(prompt.visible_subjects ?? []),
    ...(prompt.ui_text_on_screen ?? []),
  ].filter(Boolean).join(" ");
}

function motionProfile(prompt, index, startSec = 0, previousPrompt = null) {
  const structured = [
    prompt.visual_beat_focus,
    prompt.visual_beat_action,
    prompt.visual_beat_script_excerpt,
    prompt.primary_subject,
    prompt.location,
    prompt.shot_manifest?.shot_job,
    prompt.shot_manifest?.foreground_action,
    ...(prompt.visible_subjects ?? []),
    ...(prompt.ui_text_on_screen ?? []),
  ].filter(Boolean).join(" ");
  const promptText = [
    prompt.modelslab_image_prompt,
    prompt.image_prompt,
  ].filter(Boolean).join(" ");
  const hasUi = /\b(?:system|interface|window|counter|stored kills|redeem|verdict|settlement|rank|orb|file|liability|debtors|audit|record|screen|monitor|broadcast|forum|tablet|license|stamp|goddess board|attention throne)\b/i.test(structured);
  const hasAction = /\b(?:fight|combat|attack|horde|swarm|monster|gate break|strike|kill|collapse|rescue|chase|battle|explosion|impact|fall|lunge|crater|tyrant|boss|detonated|shattered|charge|wave|barricade|tide|pivots|steps|climbs|refuses|walks past)\b/i.test(structured);
  const isReveal = /\b(?:reveal|revealed|realization|truth|exposed|offer|throne|crown|capital|tower|mirror|transmigrator|phase|objective|activated|awakening|failure condition)\b/i.test(structured);
  const isWide = /\b(?:wide|establish|city|street|arena|hall|office|tower|rooftop|district|crowd|environment|skyline|gate|den|dungeon|capital|stadium|plaza|train|hotel|gym)\b/i.test(structured);
  const isEmotional = /\b(?:quiet|silence|alone|stares|tears|smile|afraid|cold|patient|threshold|memory|decision|reaction|watched|looked|remembered|hesitated|waiting|doorstep|river|dawn|sorry|free|tired|pity|hand)\b/i.test(structured);
  const promptWide = /\b(?:wide composition|establishing|panoramic|city|street|arena|crowd)\b/i.test(promptText);
  const promptClose = /\b(?:close-up|closeup|portrait|face|eyes|expression|hand|phone|tablet|file|orb|license)\b/i.test(promptText);
  const seed = promptSeed(prompt, index);
  const direction = Math.floor(hashUnit(seed, "direction") * 8);
  const variance = 0.92 + hashUnit(seed, "variance") * 0.22;
  const sceneStart = sceneChanged(prompt, previousPrompt);
  const rotation = Math.floor(hashUnit(seed, "camera-grammar") * 1000) % 6;
  if (Number(startSec) < hookTransitionSec) {
    return { name: "hook_burst", behavior: rotation % 3 === 0 ? "snap_zoom_out" : "snap_push_in", zoom: variedZoom(1.13, variance), driftX: 0.072, driftY: 0.05, direction, hook: true, sceneStart };
  }
  if (sceneStart && (isWide || promptWide)) {
    return { name: "scene_slam_establish", behavior: "zoom_out_expose", zoom: variedZoom(1.105, variance), driftX: 0.058, driftY: 0.036, direction, sceneStart };
  }
  if (hasAction) {
    return { name: "action_push", behavior: rotation % 2 === 0 ? "lateral_truck_push" : "diagonal_push_in", zoom: variedZoom(1.104, variance), driftX: 0.064, driftY: 0.042, direction, sceneStart };
  }
  if (hasUi) {
    return { name: "ui_reveal", behavior: rotation % 3 === 0 ? "micro_zoom_out" : "controlled_push_in", zoom: variedZoom(1.064, variance), driftX: 0.03, driftY: 0.022, direction, sceneStart };
  }
  if (isReveal) {
    return { name: "reveal_push", behavior: rotation % 4 === 0 ? "zoom_out_expose" : "controlled_push_in", zoom: variedZoom(1.084, variance), driftX: 0.044, driftY: 0.03, direction, sceneStart };
  }
  if (isWide || promptWide) {
    return { name: "wide_drift", behavior: "zoom_out_expose", zoom: variedZoom(1.078, variance), driftX: 0.052, driftY: 0.03, direction, sceneStart };
  }
  if (isEmotional || promptClose) {
    return { name: "emotional_hold", behavior: rotation % 2 === 0 ? "breathing_hold" : "micro_zoom_out", zoom: variedZoom(1.045, variance), driftX: 0.018, driftY: 0.014, direction, sceneStart };
  }
  return { name: "steady_push", behavior: rotation % 3 === 0 ? "lateral_truck" : "controlled_push_in", zoom: variedZoom(1.056, variance), driftX: 0.036, driftY: 0.024, direction, sceneStart };
}

function zoomRange(profile) {
  const zoomDelta = Math.max(0.01, (Number(profile.zoom ?? 1.05) - 1) * Math.max(1, motionStrength));
  const maxZoom = 1 + zoomDelta;
  const midZoom = 1 + zoomDelta * 0.58;
  const lowZoom = 1 + zoomDelta * 0.12;
  switch (profile.behavior) {
    case "zoom_out_expose":
      return { startZoom: maxZoom, endZoom: lowZoom, curve: "ease_out" };
    case "snap_zoom_out":
      return { startZoom: maxZoom, endZoom: 1 + zoomDelta * 0.24, curve: "fast_out" };
    case "micro_zoom_out":
      return { startZoom: midZoom, endZoom: 1 + zoomDelta * 0.26, curve: "ease_out" };
    case "breathing_hold":
      return { startZoom: 1 + zoomDelta * 0.28, endZoom: 1 + zoomDelta * 0.42, curve: "slow_in" };
    case "lateral_truck":
      return { startZoom: midZoom, endZoom: midZoom, curve: "linear" };
    case "lateral_truck_push":
      return { startZoom: 1 + zoomDelta * 0.18, endZoom: maxZoom, curve: "slow_in" };
    case "diagonal_push_in":
    case "snap_push_in":
    case "controlled_push_in":
    default:
      return { startZoom: 1 + zoomDelta * 0.08, endZoom: maxZoom, curve: profile.behavior === "snap_push_in" ? "fast_in" : "slow_in" };
  }
}

function progressExpr(frameCount, curve = "linear") {
  const base = `(on/${Math.max(1, frameCount - 1)})`;
  if (curve === "slow_in") return `pow(${base},1.35)`;
  if (curve === "fast_in") return `pow(${base},0.72)`;
  if (curve === "ease_out") return `(1-pow(1-${base},1.35))`;
  if (curve === "fast_out") return `(1-pow(1-${base},0.72))`;
  return base;
}

function motionProfileOffsets(profile) {
  const x = Math.round(width * profile.driftX * motionStrength);
  const y = Math.round(height * profile.driftY * motionStrength);
  const variants = [
    { startX: -x, endX: x, startY: -Math.round(y / 2), endY: Math.round(y / 2) },
    { startX: x, endX: -x, startY: Math.round(y / 2), endY: -Math.round(y / 2) },
    { startX: -Math.round(x / 2), endX: Math.round(x / 2), startY: y, endY: -y },
    { startX: Math.round(x / 2), endX: -Math.round(x / 2), startY: -y, endY: y },
    { startX: 0, endX: x, startY: -y, endY: 0 },
    { startX: 0, endX: -x, startY: y, endY: 0 },
    { startX: -x, endX: Math.round(x / 3), startY: 0, endY: -y },
    { startX: x, endX: -Math.round(x / 3), startY: 0, endY: y },
  ];
  return variants[profile.direction % variants.length];
}

function enableBetween(start, end) {
  return `between(t\\,${Number(start).toFixed(3)}\\,${Number(end).toFixed(3)})`;
}

function transitionProfile(duration, profile, prompt = {}, startSec = 0, previousPrompt = null, index = 0) {
  const structured = promptTextBundle(prompt);
  const isHook = Number(startSec) < hookTransitionSec;
  const isSceneStart = sceneChanged(prompt, previousPrompt);
  const isImpact = /\b(?:impact|strike|hit|crack|shatter|blast|thunder|explosion|blood|collapse|fall|launch|lunge|attack|counter|gate|payoff|cliffhanger|shocked|hush|chant)\b/i.test(structured);
  const isSystem = /\b(?:system|ledger|board|interface|screen|monitor|broadcast|counter|objective|warning|phase|corruption|window|goddess board|attention throne)\b/i.test(structured);
  const isReveal = /\b(?:reveal|revealed|truth|verdict|debt|offer|crown|throne|mirror|mother|transmigrator|failure condition|refused|awakening|activated)\b/i.test(structured);
  const seed = promptSeed(prompt, index);
  const sweepWidth = Math.round(width * (0.13 + hashUnit(seed, "sweep-width") * 0.06));
  const sweepSpeed = Math.round(width * (1.18 + hashUnit(seed, "sweep-speed") * 0.44));
  const sweepX = -sweepWidth;
  const endStart = Math.max(0, Number(duration) - transitionTailSec);
  const endEnd = Math.max(endStart + 0.02, Number(duration));
  const treatments = ["eq=contrast=1.035:saturation=1.045:brightness=0.004", "unsharp=5:5:0.38:3:3:0.12"];
  let name = "polished_motion";

  if (isHook) {
    const variants = ["hook_flash_swipe", "hook_manga_snap", "hook_attention_scan"];
    name = variants[Math.floor(hashUnit(seed, "hook-style") * variants.length) % variants.length];
    treatments.push(
      `drawbox=x=0:y=0:w=${width}:h=${height}:color=white@0.24:t=fill:enable='${enableBetween(0, 0.065)}'`,
      `drawbox=x=0:y=0:w=${width}:h=${Math.round(height * 0.075)}:color=black@0.23:t=fill:enable='${enableBetween(0.03, 0.24)}'`,
      `drawbox=x=0:y=${Math.round(height * 0.925)}:w=${width}:h=${Math.round(height * 0.075)}:color=black@0.20:t=fill:enable='${enableBetween(0.03, 0.24)}'`,
      `drawbox=x='${sweepX}+t*${sweepSpeed}':y=0:w=${sweepWidth}:h=${height}:color=white@0.18:t=fill:enable='${enableBetween(0.04, 0.44)}'`,
      `drawbox=x='${width}-t*${Math.round(sweepSpeed * 0.88)}':y=0:w=${Math.round(sweepWidth * 0.72)}:h=${height}:color=#99ccff@0.12:t=fill:enable='${enableBetween(0.15, 0.58)}'`,
      `drawbox=x=0:y='${Math.round(height * 0.18)}+t*${Math.round(height * 1.08)}':w=${width}:h=4:color=#b8dcff@0.26:t=fill:enable='${enableBetween(0.08, 0.56)}'`,
    );
  } else if (isSceneStart) {
    const variants = ["manga_scene_wipe", "hard_scene_card", "attention_cut"];
    name = variants[Math.floor(hashUnit(seed, "scene-style") * variants.length) % variants.length];
    treatments.push(
      `drawbox=x=0:y=0:w=${width}:h=${height}:color=white@0.14:t=fill:enable='${enableBetween(0, 0.055)}'`,
      `drawbox=x='${sweepX}+t*${Math.round(sweepSpeed * 0.9)}':y=0:w=${Math.round(sweepWidth * 0.86)}:h=${height}:color=white@0.12:t=fill:enable='${enableBetween(0.02, 0.34)}'`,
      `drawbox=x=0:y=0:w=${width}:h=${Math.round(height * 0.04)}:color=black@0.18:t=fill:enable='${enableBetween(0.02, 0.20)}'`,
      `drawbox=x=0:y=${Math.round(height * 0.96)}:w=${width}:h=${Math.round(height * 0.04)}:color=black@0.16:t=fill:enable='${enableBetween(0.02, 0.20)}'`,
    );
  } else if (isImpact || isReveal) {
    name = isImpact ? "impact_flash_push" : "reveal_flash_push";
    treatments.push(
      `drawbox=x=0:y=0:w=${width}:h=${height}:color=white@0.12:t=fill:enable='${enableBetween(0, 0.045)}'`,
      `drawbox=x='${sweepX}+t*${Math.round(sweepSpeed * 0.78)}':y=0:w=${Math.round(sweepWidth * 0.68)}:h=${height}:color=white@0.09:t=fill:enable='${enableBetween(0.03, 0.30)}'`,
    );
  } else if (isSystem) {
    name = "system_scan";
    treatments.push(
      `drawbox=x=0:y='${Math.round(height * 0.18)}+t*${Math.round(height * 0.72)}':w=${width}:h=3:color=#9fd2ff@0.20:t=fill:enable='${enableBetween(0.05, 0.42)}'`,
      `drawbox=x='${sweepX}+t*${Math.round(sweepSpeed * 0.62)}':y=0:w=${Math.round(sweepWidth * 0.48)}:h=${height}:color=#9fd2ff@0.055:t=fill:enable='${enableBetween(0.04, 0.36)}'`,
    );
  }

  if (duration > 0.55 && (isHook || isSceneStart || isImpact || isReveal || isSystem)) {
    treatments.push(
      `drawbox=x='${width}-(t-${endStart.toFixed(3)})*${Math.round(sweepSpeed * 1.05)}':y=0:w=${Math.round(sweepWidth * 0.66)}:h=${height}:color=white@0.07:t=fill:enable='${enableBetween(endStart, endEnd)}'`,
    );
  }
  return { name, filters: treatments.join(",") };
}

const FFMPEG_XFADE_TRANSITIONS = new Set([
  "fade",
  "wipeleft",
  "wiperight",
  "wipeup",
  "wipedown",
  "slideleft",
  "slideright",
  "slideup",
  "slidedown",
  "circlecrop",
  "rectcrop",
  "distance",
  "fadeblack",
  "fadewhite",
  "radial",
  "smoothleft",
  "smoothright",
  "smoothup",
  "smoothdown",
  "circleopen",
  "circleclose",
  "vertopen",
  "vertclose",
  "horzopen",
  "horzclose",
  "dissolve",
  "pixelize",
  "diagtl",
  "diagtr",
  "diagbl",
  "diagbr",
  "hlslice",
  "hrslice",
  "vuslice",
  "vdslice",
  "hblur",
  "fadegrays",
  "wipetl",
  "wipetr",
  "wipebl",
  "wipebr",
  "squeezeh",
  "squeezev",
  "zoomin",
  "fadefast",
  "fadeslow",
  "hlwind",
  "hrwind",
  "vuwind",
  "vdwind",
  "coverleft",
  "coverright",
  "coverup",
  "coverdown",
  "revealleft",
  "revealright",
  "revealup",
  "revealdown",
]);

const XFADE_TRANSITION_ALIASES = new Map([
  ["swipeup", "slideup"],
  ["swipedown", "slidedown"],
  ["swipeleft", "slideleft"],
  ["swiperight", "slideright"],
]);

function normalizeXfadeTransition(value) {
  const key = String(value ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const normalized = XFADE_TRANSITION_ALIASES.get(key) ?? key;
  return FFMPEG_XFADE_TRANSITIONS.has(normalized) ? normalized : "dissolve";
}

function xfadeTransitionForBoundary(prompt = {}, nextPrompt = {}, index = 0, planned = null) {
  if (planned?.xfade_transition) return normalizeXfadeTransition(planned.xfade_transition);
  const text = `${promptTextBundle(prompt)} ${promptTextBundle(nextPrompt)}`;
  const seed = promptSeed(nextPrompt, index);
  const pick = (items, salt) => items[Math.floor(hashUnit(seed, salt) * items.length) % items.length];
  if (/\b(?:system|ledger|interface|screen|broadcast|window|phase|warning|glitch|board)\b/i.test(text)) {
    return pick(["smoothup", "smoothdown", "vuslice", "hlslice", "pixelize"], "system-xfade");
  }
  if (/\b(?:impact|hit|strike|collapse|attack|refuse|throne|crown|offer|mirror|failure condition|activated)\b/i.test(text)) {
    return pick(["slideup", "slidedown", "wipeup", "wipedown", "distance"], "impact-xfade");
  }
  if (/\b(?:memory|flashback|first life|dream|remembered|past)\b/i.test(text)) {
    return pick(["fade", "dissolve", "fadegrays", "hblur"], "memory-xfade");
  }
  if (sceneChanged(nextPrompt, prompt)) {
    return pick(["wipeleft", "wiperight", "slideleft", "slideright", "smoothleft", "smoothright"], "scene-xfade");
  }
  return pick(["smoothup", "smoothdown", "dissolve", "wipeup", "wipedown"], "default-xfade");
}

function xfadeDurationForBoundary(row, nextRow) {
  const maxAllowed = Math.max(0.08, Math.min(row.duration, nextRow.duration) * 0.42);
  return Math.max(0.08, Math.min(hookXfadeDurationSec, maxAllowed));
}

function clampXfadeDuration(value, row, nextRow) {
  const maxAllowed = Math.max(0.08, Math.min(row.duration, nextRow.duration) * 0.42);
  return Math.max(0.08, Math.min(Number(value) || hookXfadeDurationSec, maxAllowed));
}

function visualTransitionTreatment(duration, profile, prompt = {}, startSec = 0, previousPrompt = null, index = 0) {
  return transitionProfile(duration, profile, prompt, startSec, previousPrompt, index).filters;
}

function fadeFilters(duration) {
  if (!(visualFadeSec > 0)) return "";
  const fadeOutStart = Math.max(0, duration - visualFadeSec);
  return `,fade=t=in:st=0:d=${visualFadeSec},fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${visualFadeSec}`;
}

function motionClipFilter(duration, index, prompt = {}, startSec = 0, previousPrompt = null) {
  const fgW = Math.round(width * Math.max(0.45, Math.min(1, foregroundScale)));
  const fgH = Math.round(height * Math.max(0.45, Math.min(1, foregroundScale)));
  const profile = motionProfile(prompt, index, startSec, previousPrompt);
  const offsets = motionProfileOffsets(profile);
  const transitionFilters = visualTransitionTreatment(duration, profile, prompt, startSec, previousPrompt, index);
  const transitionPrefix = transitionFilters ? `${transitionFilters},` : "";
  const transitionSuffix = transitionFilters ? `,${transitionFilters}` : "";
  const fades = fadeFilters(duration);
  if (motionMode === "fill_ken_burns") {
    const { startZoom, endZoom, curve } = zoomRange(profile);
    const startXBias = offsets.startX / width;
    const endXBias = offsets.endX / width;
    const startYBias = offsets.startY / height;
    const endYBias = offsets.endY / height;
    const frameCount = clipFrameCount(duration);
    const progress = progressExpr(frameCount, curve);
    const xBiasExpr = `${startXBias.toFixed(4)}+${(endXBias - startXBias).toFixed(4)}*${progress}`;
    const yBiasExpr = `${startYBias.toFixed(4)}+${(endYBias - startYBias).toFixed(4)}*${progress}`;
    const xExpr = `max(0,min(iw-iw/zoom,iw/2-(iw/zoom/2)+(${xBiasExpr})*iw))`;
    const yExpr = `max(0,min(ih-ih/zoom,ih/2-(ih/zoom/2)+(${yBiasExpr})*ih))`;
    const zoomExpr = `${startZoom.toFixed(4)}+${(endZoom - startZoom).toFixed(7)}*${progress}`;
    const renderW = Math.ceil((width * renderScaleMultiplier) / 2) * 2;
    const renderH = Math.ceil((height * renderScaleMultiplier) / 2) * 2;
    return `scale=${renderW}:${renderH}:force_original_aspect_ratio=increase,crop=${renderW}:${renderH},zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${frameCount}:s=${width}x${height}:fps=${fps},${transitionPrefix}format=yuv420p${fades}`;
  }
  if (motionMode === "fill_pan") {
    const renderW = Math.ceil((width * renderScaleMultiplier) / 2) * 2;
    const renderH = Math.ceil((height * renderScaleMultiplier) / 2) * 2;
    const maxX = Math.max(0, Math.floor((renderW - width) / 2));
    const maxY = Math.max(0, Math.floor((renderH - height) / 2));
    const startX = Math.max(-maxX, Math.min(maxX, offsets.startX));
    const endX = Math.max(-maxX, Math.min(maxX, offsets.endX));
    const startY = Math.max(-maxY, Math.min(maxY, offsets.startY));
    const endY = Math.max(-maxY, Math.min(maxY, offsets.endY));
    const progress = `min(1,t/${Math.max(0.1, duration).toFixed(3)})`;
    const xExpr = `(in_w-out_w)/2+${startX}+(${endX - startX})*${progress}`;
    const yExpr = `(in_h-out_h)/2+${startY}+(${endY - startY})*${progress}`;
    return `scale=${renderW}:${renderH}:force_original_aspect_ratio=increase,crop=${renderW}:${renderH},crop=${width}:${height}:x='${xExpr}':y='${yExpr}',fps=${fps},${transitionPrefix}format=yuv420p${fades}`;
  }
  const progress = `min(1,t/${Math.max(0.1, duration).toFixed(3)})`;
  const xExpr = `(W-w)/2+${offsets.startX}+(${offsets.endX - offsets.startX})*${progress}`;
  const yExpr = `(H-h)/2+${offsets.startY}+(${offsets.endY - offsets.startY})*${progress}`;
  return `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=34,eq=brightness=-0.055:saturation=0.92[bg];[0:v]scale=${fgW}:${fgH}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=x='${xExpr}':y='${yExpr}'${transitionSuffix}${fades},fps=${fps},format=yuv420p`;
}

function transitionPlanByToImage(transitionEditPlan) {
  return new Map((transitionEditPlan?.transition_events ?? []).map((event) => [event.to_image_id, event]));
}

async function buildMotionClips(promptPlan, imagegenReport, audioDuration, transitionEditPlan = null) {
  const imageById = new Map((imagegenReport.results ?? []).map((row) => [row.image_id, row.image_path]));
  const plannedTransitionByToImage = transitionPlanByToImage(transitionEditPlan);
  const prompts = (promptPlan.prompts ?? []).filter((prompt) => imageById.has(prompt.image_id));
  if (!prompts.length) throw new Error("No generated images found for prompt plan.");
  const totalPromptDuration = prompts.reduce((sum, prompt) => sum + Math.max(1, Number(prompt.duration_sec ?? 6)), 0);
  const hasAbsoluteStarts = prompts.every((prompt) => Number.isFinite(Number(prompt.start_sec)));
  const scale = hasAbsoluteStarts ? 1 : audioDuration > 0 && totalPromptDuration > 0 ? audioDuration / totalPromptDuration : 1;
  const clipDir = path.join(workDir, "motion-clips");
  await fs.rm(clipDir, { recursive: true, force: true });
  await fs.mkdir(clipDir, { recursive: true });
  const lines = [];
  const motionProfiles = {};
  const motionBehaviors = {};
  const transitionProfiles = {};
  const hookXfadeTransitions = [];
  const hookClipIds = [];
  const transitionClipIds = [];
  const clipJobs = [];
  const plannedStarts = prompts.map((prompt, index) => {
    if (hasAbsoluteStarts) return Number(prompt.start_sec);
    return prompts.slice(0, index).reduce((sum, row) => sum + imageDuration(row, scale), 0);
  });
  const clipRows = [];
  for (let index = 0; index < prompts.length; index += 1) {
    const prompt = prompts[index];
    const imagePath = imageById.get(prompt.image_id);
    if (!(await exists(imagePath))) throw new Error(`Missing generated image for ${prompt.image_id}: ${imagePath}`);
    const previousPrompt = prompts[index - 1] ?? null;
    const startSec = hasAbsoluteStarts ? Math.max(0, plannedStarts[index]) : plannedStarts[index];
    const nextStartSec = hasAbsoluteStarts ? plannedStarts[index + 1] : null;
    const plannedDuration = hasAbsoluteStarts
      ? Number.isFinite(nextStartSec) && nextStartSec > startSec
        ? nextStartSec - startSec
        : audioDuration - startSec
      : imageDuration(prompt, scale);
    const duration = Math.max(1 / fps, Math.min(plannedDuration, Math.max(1 / fps, audioDuration - startSec)));
    const profile = motionProfile(prompt, index, startSec, previousPrompt);
    const transition = transitionProfile(duration, profile, prompt, startSec, previousPrompt, index);
    motionProfiles[profile.name] = (motionProfiles[profile.name] ?? 0) + 1;
    motionBehaviors[profile.behavior ?? "unspecified"] = (motionBehaviors[profile.behavior ?? "unspecified"] ?? 0) + 1;
    transitionProfiles[transition.name] = (transitionProfiles[transition.name] ?? 0) + 1;
    if (profile.hook) hookClipIds.push(prompt.image_id);
    if (transition.name !== "polished_motion") transitionClipIds.push(prompt.image_id);
    const clipPath = path.join(clipDir, `${String(index + 1).padStart(5, "0")}-${prompt.image_id}.mp4`);
    clipRows.push({ index, prompt, imagePath, clipPath, startSec, duration, profile, previousPrompt });
  }
  const hookRows = hookXfadeEnabled
    ? clipRows.filter((row) => row.startSec < retentionXfadeSec)
    : [];
  const hookXfadeCount = hookRows.length >= 2 ? hookRows.length : 0;
  const hookXfadeDurations = new Map();
  if (hookXfadeCount) {
    for (let index = 0; index < hookRows.length - 1; index += 1) {
      const planned = plannedTransitionByToImage.get(hookRows[index + 1].prompt.image_id);
      hookXfadeDurations.set(
        hookRows[index].index,
        planned?.xfade_duration_sec
          ? clampXfadeDuration(planned.xfade_duration_sec, hookRows[index], hookRows[index + 1])
          : xfadeDurationForBoundary(hookRows[index], hookRows[index + 1]),
      );
    }
  }
  for (const row of clipRows) {
    const tailSec = hookXfadeDurations.get(row.index) ?? 0;
    const renderDuration = row.duration + tailSec;
    const frameCount = clipFrameCount(renderDuration);
    clipJobs.push(async () => {
      await execFile("ffmpeg", [
        "-y",
        "-loop", "1",
        "-t", renderDuration.toFixed(3),
        "-i", row.imagePath,
        "-filter_complex", motionClipFilter(renderDuration, row.index, row.prompt, row.startSec, row.previousPrompt),
        "-an",
        "-c:v", "libx264",
        "-preset", clipPreset,
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        "-frames:v", String(frameCount),
        row.clipPath,
      ], { maxBuffer: 1024 * 1024 * 32 });
      const actualDuration = await mediaDuration(row.clipPath);
      const expectedDuration = frameCount / fps;
      if (Math.abs(actualDuration - expectedDuration) > Math.max(0.1, expectedDuration * 0.03)) {
        throw new Error(`Rendered malformed motion clip ${path.basename(row.clipPath)}: expected ${expectedDuration.toFixed(3)}s, got ${actualDuration.toFixed(3)}s`);
      }
    });
  }
  await runLimited(clipJobs, renderConcurrency);
  if (hookXfadeCount) {
    const hookXfadePath = path.join(clipDir, "00000-hook-xfade-segment.mp4");
    const filterParts = [];
    let previousLabel = "0:v";
    let cumulative = 0;
    for (let index = 0; index < hookRows.length - 1; index += 1) {
      cumulative += hookRows[index].duration;
      const duration = hookXfadeDurations.get(hookRows[index].index) ?? hookXfadeDurationSec;
      const offset = Math.max(0, cumulative - duration);
      const planned = plannedTransitionByToImage.get(hookRows[index + 1].prompt.image_id);
      const transition = xfadeTransitionForBoundary(hookRows[index].prompt, hookRows[index + 1].prompt, index, planned);
      const outLabel = index === hookRows.length - 2 ? "hookout" : `xv${index + 1}`;
      filterParts.push(`[${previousLabel}][${index + 1}:v]xfade=transition=${transition}:duration=${duration.toFixed(3)}:offset=${offset.toFixed(3)}[${outLabel}]`);
      hookXfadeTransitions.push({
        from_image_id: hookRows[index].prompt.image_id,
        to_image_id: hookRows[index + 1].prompt.image_id,
        cut_start_sec: Number(cumulative.toFixed(3)),
        transition_offset_sec: Number(offset.toFixed(3)),
        transition,
        duration_sec: Number(duration.toFixed(3)),
      });
      previousLabel = outLabel;
    }
    await execFile("ffmpeg", [
      "-y",
      ...hookRows.flatMap((row) => ["-i", row.clipPath]),
      "-filter_complex", filterParts.join(";"),
      "-map", "[hookout]",
      "-an",
      "-c:v", "libx264",
      "-preset", clipPreset,
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-r", String(fps),
      hookXfadePath,
    ], { maxBuffer: 1024 * 1024 * 64 });
    const hookExpected = hookRows.reduce((sum, row) => sum + row.duration, 0);
    const hookActual = await mediaDuration(hookXfadePath);
    if (Math.abs(hookActual - hookExpected) > Math.max(0.12, hookExpected * 0.015)) {
      throw new Error(`Rendered malformed hook xfade segment: expected ${hookExpected.toFixed(3)}s, got ${hookActual.toFixed(3)}s`);
    }
    lines.push(`file '${concatEscape(hookXfadePath)}'`);
    for (const row of clipRows.slice(hookRows.length)) lines.push(`file '${concatEscape(row.clipPath)}'`);
  } else {
    for (const row of clipRows) lines.push(`file '${concatEscape(row.clipPath)}'`);
  }
  const concatPath = path.join(workDir, "motion-clips.concat.txt");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(concatPath, `${lines.join("\n")}\n`, "utf8");
  return {
    concatPath,
    prompt_count: prompts.length,
    duration_scale: scale,
    clip_dir: clipDir,
    motion_mode: motionMode,
    motion_profiles: motionProfiles,
    motion_behaviors: motionBehaviors,
    transition_profiles: transitionProfiles,
    hook_xfade_enabled: hookXfadeEnabled,
    hook_xfade_applied: Boolean(hookXfadeCount),
    hook_xfade_duration_sec: hookXfadeDurationSec,
    hook_xfade_transition_count: hookXfadeTransitions.length,
    hook_xfade_transitions: hookXfadeTransitions,
    hook_transition_sec: hookTransitionSec,
    retention_xfade_sec: retentionXfadeSec,
    transition_tail_sec: transitionTailSec,
    hook_clip_ids: hookClipIds,
    transition_clip_ids: transitionClipIds,
  };
}

function renderTransitionSfxEvents(transitionEditPlan, audioDuration) {
  return (transitionEditPlan?.transition_events ?? [])
    .filter((event) => event.transition_sfx === true && event.asset_path)
    .map((event, index) => ({
      event_id: `render_transition_sfx_${String(index + 1).padStart(3, "0")}`,
      ...event,
      start_sec: Math.max(0, Math.min(audioDuration, Number(event.start_sec ?? 0) + Number(event.sfx_offset_sec ?? 0))),
      duration_sec: Math.max(0.12, Math.min(1.4, Number(event.duration_sec ?? 0.85) || 0.85)),
      gain_db: Math.max(-36, Math.min(-8, Number(event.gain_db ?? -20) || -20)),
    }))
    .filter((event) => event.start_sec < audioDuration);
}

function audioReportDisablesTransitionSfx(audioBedReport) {
  return audioBedReport?.audio_design_enabled === false
    || audioBedReport?.narration_only === true
    || audioBedReport?.skip_sfx === true
    || audioBedReport?.transition_sfx_enabled === false
    || audioBedReport?.mix?.audio_design_enabled === false
    || audioBedReport?.mix?.narration_only === true
    || audioBedReport?.mix?.skip_sfx === true
    || audioBedReport?.mix?.transition_sfx_enabled === false;
}

function withoutTransitionSfx(transitionEditPlan) {
  if (!transitionEditPlan) return null;
  return {
    ...transitionEditPlan,
    transition_sfx_enabled: false,
    transition_events: (transitionEditPlan.transition_events ?? []).map((event) => ({
      ...event,
      transition_sfx: false,
      cue_id: null,
      asset_path: null,
      asset_id: null,
      gain_db: null,
      sfx_offset_sec: 0,
    })),
  };
}

async function audioWithRenderTransitionSfx(audioPath, transitionEditPlan, audioDuration) {
  const events = renderTransitionSfxEvents(transitionEditPlan, audioDuration);
  if (!events.length) return { audio_path: audioPath, transition_sfx_events: [], transition_sfx_applied: false };
  const output = path.join(workDir, "audio_with_render_transition_sfx.m4a");
  const args = ["-y", "-i", audioPath];
  for (const event of events) args.push("-i", event.asset_path);
  const filters = [];
  const labels = ["[0:a]"];
  events.forEach((event, index) => {
    const input = index + 1;
    const delayMs = Math.max(0, Math.round(event.start_sec * 1000));
    const label = `sfx${index}`;
    filters.push(`[${input}:a]atrim=0:${event.duration_sec.toFixed(3)},asetpts=PTS-STARTPTS,volume=${event.gain_db.toFixed(2)}dB,adelay=${delayMs}|${delayMs}[${label}]`);
    labels.push(`[${label}]`);
  });
  filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=0,alimiter=limit=0.98[aout]`);
  await execFile("ffmpeg", [
    ...args,
    "-filter_complex", filters.join(";"),
    "-map", "[aout]",
    "-c:a", "aac",
    "-b:a", "192k",
    output,
  ], { maxBuffer: 1024 * 1024 * 64 });
  return { audio_path: output, transition_sfx_events: events, transition_sfx_applied: true };
}

function numericOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finalAudioLoudnormSettings(audioBedReport) {
  if (!finalAudioLoudnormEnabled) return { enabled: false };
  const targetLufs = numericOrNull(finalAudioTargetLufsFlag)
    ?? numericOrNull(audioBedReport?.mix?.target_lufs)
    ?? -13;
  const truePeakDb = numericOrNull(finalAudioTruePeakFlag)
    ?? numericOrNull(audioBedReport?.mix?.true_peak_db)
    ?? -1;
  const lra = numericOrNull(finalAudioLraFlag)
    ?? numericOrNull(audioBedReport?.mix?.loudness_range)
    ?? 11;
  return {
    enabled: true,
    target_lufs: targetLufs,
    true_peak_db: truePeakDb,
    loudness_range: lra,
  };
}

async function applyFinalAudioLoudnorm(inputMp4Path, outputMp4Path, settings) {
  if (!settings.enabled) {
    if (inputMp4Path !== outputMp4Path) await fs.copyFile(inputMp4Path, outputMp4Path);
    return { applied: false, output_path: outputMp4Path };
  }
  await execFile("ffmpeg", [
    "-y",
    "-i", inputMp4Path,
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-c:v", "copy",
    "-af", `loudnorm=I=${settings.target_lufs}:TP=${settings.true_peak_db}:LRA=${settings.loudness_range}:print_format=summary`,
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outputMp4Path,
  ], { maxBuffer: 1024 * 1024 * 32 });
  return { applied: true, output_path: outputMp4Path, ...settings };
}

async function runLimited(jobs, limit) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor];
      cursor += 1;
      await job();
    }
  });
  await Promise.all(workers);
}

async function main() {
  const [promptPlan, imagegenReport, wordTiming, audioBedReport, audioStitchReport, transitionEditPlan, engagementOverlayPlan] = await Promise.all([
    readJson(promptPlanPath, null),
    readJson(imagegenReportPath, null),
    readJson(wordTimingPath, null),
    readJson(audioBedReportPath, null),
    readJson(audioStitchReportPath, null),
    readJson(transitionEditPlanPath, null),
    readJson(engagementOverlayPlanPath, null),
  ]);
  if (promptPlan?.status !== "passed") throw new Error(`Missing passed prompt plan: ${promptPlanPath}`);
  if (imagegenReport?.status !== "passed") throw new Error(`Missing passed imagegen report: ${imagegenReportPath}`);
  if (wordTiming?.status !== "passed") throw new Error(`Missing passed Whisper word timing: ${wordTimingPath}`);
  const audioPath = flags.audio ?? audioBedReport?.mix?.m4a_path ?? audioBedReport?.mix?.wav_path;
  if (!audioPath || !(await exists(audioPath))) throw new Error(`Missing final mixed audio from ${audioBedReportPath}`);
  await fs.mkdir(renderDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });
  const audioDuration = await mediaDuration(audioPath);
  const transitionSfxDisabledByAudio = audioReportDisablesTransitionSfx(audioBedReport);
  const rawTransitionPlan = transitionEditPlan?.status === "passed" ? transitionEditPlan : null;
  const strippedTransitionSfxCount = transitionSfxDisabledByAudio
    ? (rawTransitionPlan?.transition_events ?? []).filter((event) => event.transition_sfx === true).length
    : 0;
  const usableTransitionPlan = transitionSfxDisabledByAudio ? withoutTransitionSfx(rawTransitionPlan) : rawTransitionPlan;
  const renderAudio = await audioWithRenderTransitionSfx(audioPath, usableTransitionPlan, audioDuration);
  const concat = await buildMotionClips(promptPlan, imagegenReport, audioDuration, usableTransitionPlan);
  const subtitleRows = buildSubtitleEvents(wordTiming, audioStitchReport);
  const ass = await writeAss(path.join(workDir, "subtitles.ass"), subtitleRows.events);
  const engagementOverlay = await writeEngagementOverlayVideo(path.join(workDir, "engagement_overlay.mov"), engagementOverlayPlan, audioDuration);
  const videoPath = path.join(workDir, "silent_video.mp4");
  await execFile("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concat.concatPath,
    "-c", "copy",
    "-movflags", "+faststart",
    videoPath,
  ], { maxBuffer: 1024 * 1024 * 32 });
  await execFile("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-t", audioDuration.toFixed(3),
    "-vf", `setsar=1,fps=${fps}`,
    "-c:v", "libx264",
    "-preset", clipPreset,
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    path.join(workDir, "silent_video_normalized.mp4"),
  ], { maxBuffer: 1024 * 1024 * 32 });
  const normalizedVideoPath = path.join(workDir, "silent_video_normalized.mp4");
  const hasAssFilter = await ffmpegHasFilter("ass");
  let subtitleRenderer = "ffmpeg_ass_filter";
  let subtitleOverlay = null;
  const muxOutputPath = finalAudioLoudnormEnabled ? path.join(workDir, "pre_final_audio_loudnorm.mp4") : outputPath;
  let finalAudioNormalization = { applied: false, output_path: outputPath };
  if (hasAssFilter) {
    if (engagementOverlay.path) {
      await execFile("ffmpeg", [
        "-y",
        "-i", normalizedVideoPath,
        "-i", engagementOverlay.path,
        "-i", renderAudio.audio_path,
        "-filter_complex", `[0:v][1:v]overlay=0:0:format=auto,ass=filename=${ffmpegFilterFilename(ass.path)}[v]`,
        "-map", "[v]",
        "-map", "2:a:0",
        "-c:v", "libx264",
        "-preset", finalPreset,
        "-crf", "18",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        muxOutputPath,
      ], { maxBuffer: 1024 * 1024 * 32 });
    } else {
      await execFile("ffmpeg", [
        "-y",
        "-i", normalizedVideoPath,
        "-i", renderAudio.audio_path,
        "-vf", `ass=filename=${ffmpegFilterFilename(ass.path)}`,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "libx264",
        "-preset", finalPreset,
        "-crf", "18",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        muxOutputPath,
      ], { maxBuffer: 1024 * 1024 * 32 });
    }
  } else {
    subtitleRenderer = "sharp_png_overlay_video";
    subtitleOverlay = await writeSubtitleOverlayVideo(path.join(workDir, "subtitle_overlay.mov"), subtitleRows.events, audioDuration);
    if (engagementOverlay.path) {
      await execFile("ffmpeg", [
        "-y",
        "-i", normalizedVideoPath,
        "-i", engagementOverlay.path,
        "-i", subtitleOverlay.path,
        "-i", renderAudio.audio_path,
        "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto[v1];[v1][2:v]overlay=0:0:format=auto[v]",
        "-map", "[v]",
        "-map", "3:a:0",
        "-c:v", "libx264",
        "-preset", finalPreset,
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        muxOutputPath,
      ], { maxBuffer: 1024 * 1024 * 32 });
    } else {
      await execFile("ffmpeg", [
        "-y",
        "-i", normalizedVideoPath,
        "-i", subtitleOverlay.path,
        "-i", renderAudio.audio_path,
        "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto[v]",
        "-map", "[v]",
        "-map", "2:a:0",
        "-c:v", "libx264",
        "-preset", finalPreset,
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        muxOutputPath,
      ], { maxBuffer: 1024 * 1024 * 32 });
    }
  }
  finalAudioNormalization = await applyFinalAudioLoudnorm(muxOutputPath, outputPath, finalAudioLoudnormSettings(audioBedReport));
  const report = {
    schema: "goldflow_render_report_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    output_path: outputPath,
    output_hash: await hashFile(outputPath),
    output_duration_sec: await mediaDuration(outputPath),
    audio_path: audioPath,
    render_audio_path: renderAudio.audio_path,
    final_mux_audio_path: muxOutputPath,
    final_audio_loudnorm: finalAudioNormalization,
    transition_edit_plan_path: usableTransitionPlan ? transitionEditPlanPath : null,
    transition_sfx_disabled_by_audio_report: transitionSfxDisabledByAudio,
    transition_sfx_stripped_count: strippedTransitionSfxCount,
    transition_sfx_applied: renderAudio.transition_sfx_applied,
    transition_sfx_event_count: renderAudio.transition_sfx_events.length,
    transition_sfx_events: renderAudio.transition_sfx_events,
    engagement_overlay_plan_path: engagementOverlay.events.length ? engagementOverlayPlanPath : null,
    engagement_overlay_applied: Boolean(engagementOverlay.path),
    engagement_overlay_path: engagementOverlay.path,
    engagement_overlay_count: engagementOverlay.events.length,
    engagement_overlay_frame_count: engagementOverlay.frame_count,
    engagement_overlays: engagementOverlay.events,
    prompt_plan_path: promptPlanPath,
    imagegen_report_path: imagegenReportPath,
    word_timing_path: wordTimingPath,
    audio_bed_report_path: audioBedReportPath,
    audio_stitch_report_path: audioStitchReportPath,
    subtitle_text_source: subtitleRows.source,
    subtitle_style: "yellow text, black outline, no background box",
    subtitle_renderer: subtitleRenderer,
    subtitle_overlay_path: subtitleOverlay?.path ?? null,
    subtitle_overlay_frame_count: subtitleOverlay?.frame_count ?? null,
    subtitle_count: ass.subtitle_count,
    image_count: concat.prompt_count,
    render_motion: {
      mode: concat.motion_mode,
      clip_dir: concat.clip_dir,
      foreground_scale: foregroundScale,
      motion_strength: motionStrength,
      visual_fade_sec: visualFadeSec,
      hook_transition_sec: concat.hook_transition_sec,
      transition_tail_sec: concat.transition_tail_sec,
      render_concurrency: renderConcurrency,
      render_scale_multiplier: renderScaleMultiplier,
      clip_preset: clipPreset,
      final_preset: finalPreset,
      hook_clip_ids: concat.hook_clip_ids,
      transition_clip_ids: concat.transition_clip_ids,
      motion_profiles: concat.motion_profiles,
      motion_behaviors: concat.motion_behaviors,
      transition_profiles: concat.transition_profiles,
      hook_xfade_enabled: concat.hook_xfade_enabled,
      hook_xfade_applied: concat.hook_xfade_applied,
      hook_xfade_duration_sec: concat.hook_xfade_duration_sec,
      hook_xfade_transition_count: concat.hook_xfade_transition_count,
      hook_xfade_transitions: concat.hook_xfade_transitions,
    },
    updated_at: new Date().toISOString(),
  };
  await writeJson(renderReportPath, report);
  console.log(JSON.stringify({ status: "passed", output_path: outputPath, report_path: renderReportPath, duration_sec: report.output_duration_sec }, null, 2));
}

main().catch(async (error) => {
  await writeJson(renderReportPath, { schema: "goldflow_render_report_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
