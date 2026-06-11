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
const outputPath = flags.output ?? path.join(renderDir, `${episode}-${channel}-goldflow.mp4`);
const renderReportPath = flags.reportOutput ?? flags["report-output"] ?? path.join(episodeDir, `render_report_${episode}.json`);
const width = Number(flags.width ?? 1920);
const height = Number(flags.height ?? 1080);
const fps = Number(flags.fps ?? 30);
const motionMode = flags.motion ?? process.env.ANIFACTORY_RENDER_MOTION ?? "blurred_ken_burns";
const foregroundScale = Number(flags["foreground-scale"] ?? process.env.ANIFACTORY_RENDER_FOREGROUND_SCALE ?? 0.93);
const motionStrength = Number(flags["motion-strength"] ?? process.env.ANIFACTORY_RENDER_MOTION_STRENGTH ?? 1.0);
const visualFadeSec = Number(flags["visual-fade-sec"] ?? process.env.ANIFACTORY_RENDER_VISUAL_FADE_SEC ?? 0.16);

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

function subtitleEvents(words) {
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
  return events.map((items) => ({
    start_sec: Number(items[0].start_sec),
    end_sec: Number(items.at(-1).end_sec),
    text: items.map((item) => item.word).join(" ").replace(/\s+/g, " ").trim(),
  })).filter((row) => row.text && row.end_sec > row.start_sec);
}

async function writeAss(filePath, wordTiming) {
  const events = subtitleEvents(wordTiming.words ?? []);
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

function imageDuration(prompt, scale = 1) {
  return Math.max(1, Number(prompt.duration_sec ?? 6) * scale);
}

function motionPhase(index) {
  return Number(((index * 0.73) % (Math.PI * 2)).toFixed(3));
}

function motionClipFilter(duration, index) {
  const fgW = Math.round(width * Math.max(0.45, Math.min(1, foregroundScale)));
  const fgH = Math.round(height * Math.max(0.45, Math.min(1, foregroundScale)));
  const phase = motionPhase(index);
  const xDrift = Math.round(width * 0.035 * motionStrength);
  const yDrift = Math.round(height * 0.032 * motionStrength);
  const fadeOutStart = Math.max(0, duration - visualFadeSec);
  if (motionMode === "fill_ken_burns") {
    const zoomMax = 1 + 0.11 * motionStrength;
    const xExpr = index % 2 === 0 ? "iw/2-(iw/zoom/2)" : "iw/2-(iw/zoom/2)+sin(on/45)*iw*0.04";
    const yExpr = index % 3 === 0 ? "ih/2-(ih/zoom/2)+cos(on/50)*ih*0.035" : "ih/2-(ih/zoom/2)";
    return `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},zoompan=z='min(${zoomMax.toFixed(3)},1+on*0.00085*${motionStrength.toFixed(3)})':x='${xExpr}':y='${yExpr}':d=${Math.max(1, Math.ceil(duration * fps))}:s=${width}x${height}:fps=${fps},fade=t=in:st=0:d=${visualFadeSec},fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${visualFadeSec},format=yuv420p`;
  }
  return `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=34,eq=brightness=-0.055:saturation=0.92[bg];[0:v]scale=${fgW}:${fgH}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=x='(W-w)/2+sin(t*0.62+${phase})*${xDrift}':y='(H-h)/2+cos(t*0.47+${phase})*${yDrift}',fade=t=in:st=0:d=${visualFadeSec},fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${visualFadeSec},fps=${fps},format=yuv420p`;
}

async function buildMotionClips(promptPlan, imagegenReport, audioDuration) {
  const imageById = new Map((imagegenReport.results ?? []).map((row) => [row.image_id, row.image_path]));
  const prompts = (promptPlan.prompts ?? []).filter((prompt) => imageById.has(prompt.image_id));
  if (!prompts.length) throw new Error("No generated images found for prompt plan.");
  const totalPromptDuration = prompts.reduce((sum, prompt) => sum + Math.max(1, Number(prompt.duration_sec ?? 6)), 0);
  const scale = audioDuration > 0 && totalPromptDuration > 0 ? audioDuration / totalPromptDuration : 1;
  const clipDir = path.join(workDir, "motion-clips");
  await fs.rm(clipDir, { recursive: true, force: true });
  await fs.mkdir(clipDir, { recursive: true });
  const lines = [];
  for (let index = 0; index < prompts.length; index += 1) {
    const prompt = prompts[index];
    const imagePath = imageById.get(prompt.image_id);
    if (!(await exists(imagePath))) throw new Error(`Missing generated image for ${prompt.image_id}: ${imagePath}`);
    const duration = imageDuration(prompt, scale);
    const clipPath = path.join(clipDir, `${String(index + 1).padStart(5, "0")}-${prompt.image_id}.mp4`);
    await execFile("ffmpeg", [
      "-y",
      "-loop", "1",
      "-t", duration.toFixed(3),
      "-i", imagePath,
      "-filter_complex", motionClipFilter(duration, index),
      "-an",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-r", String(fps),
      clipPath,
    ], { maxBuffer: 1024 * 1024 * 32 });
    lines.push(`file '${concatEscape(clipPath)}'`);
  }
  const concatPath = path.join(workDir, "motion-clips.concat.txt");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(concatPath, `${lines.join("\n")}\n`, "utf8");
  return { concatPath, prompt_count: prompts.length, duration_scale: scale, clip_dir: clipDir, motion_mode: motionMode };
}

async function main() {
  const [promptPlan, imagegenReport, wordTiming, audioBedReport] = await Promise.all([
    readJson(promptPlanPath, null),
    readJson(imagegenReportPath, null),
    readJson(wordTimingPath, null),
    readJson(audioBedReportPath, null),
  ]);
  if (promptPlan?.status !== "passed") throw new Error(`Missing passed prompt plan: ${promptPlanPath}`);
  if (imagegenReport?.status !== "passed") throw new Error(`Missing passed imagegen report: ${imagegenReportPath}`);
  if (wordTiming?.status !== "passed") throw new Error(`Missing passed Whisper word timing: ${wordTimingPath}`);
  const audioPath = flags.audio ?? audioBedReport?.mix?.m4a_path ?? audioBedReport?.mix?.wav_path;
  if (!audioPath || !(await exists(audioPath))) throw new Error(`Missing final mixed audio from ${audioBedReportPath}`);
  await fs.mkdir(renderDir, { recursive: true });
  const audioDuration = await mediaDuration(audioPath);
  const concat = await buildMotionClips(promptPlan, imagegenReport, audioDuration);
  const ass = await writeAss(path.join(workDir, "subtitles.ass"), wordTiming);
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
    "-vf", `setsar=1,fps=${fps}`,
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    path.join(workDir, "silent_video_normalized.mp4"),
  ], { maxBuffer: 1024 * 1024 * 32 });
  const normalizedVideoPath = path.join(workDir, "silent_video_normalized.mp4");
  const hasAssFilter = await ffmpegHasFilter("ass");
  let subtitleRenderer = "ffmpeg_ass_filter";
  let subtitleOverlay = null;
  if (hasAssFilter) {
    await execFile("ffmpeg", [
      "-y",
      "-i", normalizedVideoPath,
      "-i", audioPath,
      "-vf", `ass=filename=${ffmpegFilterFilename(ass.path)}`,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "18",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      outputPath,
    ], { maxBuffer: 1024 * 1024 * 32 });
  } else {
    subtitleRenderer = "sharp_png_overlay_video";
    subtitleOverlay = await writeSubtitleOverlayVideo(path.join(workDir, "subtitle_overlay.mov"), subtitleEvents(wordTiming.words ?? []), audioDuration);
    await execFile("ffmpeg", [
      "-y",
      "-i", normalizedVideoPath,
      "-i", subtitleOverlay.path,
      "-i", audioPath,
      "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto[v]",
      "-map", "[v]",
      "-map", "2:a:0",
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "18",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      outputPath,
    ], { maxBuffer: 1024 * 1024 * 32 });
  }
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
    prompt_plan_path: promptPlanPath,
    imagegen_report_path: imagegenReportPath,
    word_timing_path: wordTimingPath,
    audio_bed_report_path: audioBedReportPath,
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
