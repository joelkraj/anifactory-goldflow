#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

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
const width = Number(flags.width ?? 1920);
const height = Number(flags.height ?? 1080);
const fps = Number(flags.fps ?? 30);

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

async function buildImageConcat(promptPlan, imagegenReport, audioDuration) {
  const imageById = new Map((imagegenReport.results ?? []).map((row) => [row.image_id, row.image_path]));
  const prompts = (promptPlan.prompts ?? []).filter((prompt) => imageById.has(prompt.image_id));
  if (!prompts.length) throw new Error("No generated images found for prompt plan.");
  const totalPromptDuration = prompts.reduce((sum, prompt) => sum + Math.max(1, Number(prompt.duration_sec ?? 6)), 0);
  const scale = audioDuration > 0 && totalPromptDuration > 0 ? audioDuration / totalPromptDuration : 1;
  const lines = [];
  for (const prompt of prompts) {
    const imagePath = imageById.get(prompt.image_id);
    if (!(await exists(imagePath))) throw new Error(`Missing generated image for ${prompt.image_id}: ${imagePath}`);
    const duration = Math.max(1, Number(prompt.duration_sec ?? 6) * scale);
    lines.push(`file '${concatEscape(imagePath)}'`);
    lines.push(`duration ${duration.toFixed(3)}`);
  }
  lines.push(`file '${concatEscape(imageById.get(prompts.at(-1).image_id))}'`);
  const concatPath = path.join(workDir, "images.concat.txt");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(concatPath, `${lines.join("\n")}\n`, "utf8");
  return { concatPath, prompt_count: prompts.length, duration_scale: scale };
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
  const concat = await buildImageConcat(promptPlan, imagegenReport, audioDuration);
  const ass = await writeAss(path.join(workDir, "subtitles.ass"), wordTiming);
  const videoPath = path.join(workDir, "silent_video.mp4");
  await execFile("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concat.concatPath,
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps}`,
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    videoPath,
  ], { maxBuffer: 1024 * 1024 * 32 });
  await execFile("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-vf", `ass=${ass.path}`,
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
    subtitle_count: ass.subtitle_count,
    image_count: concat.prompt_count,
    updated_at: new Date().toISOString(),
  };
  const reportPath = path.join(episodeDir, `render_report_${episode}.json`);
  await writeJson(reportPath, report);
  console.log(JSON.stringify({ status: "passed", output_path: outputPath, report_path: reportPath, duration_sec: report.output_duration_sec }, null, 2));
}

main().catch(async (error) => {
  const reportPath = path.join(episodeDir, `render_report_${episode}.json`);
  await writeJson(reportPath, { schema: "goldflow_render_report_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
