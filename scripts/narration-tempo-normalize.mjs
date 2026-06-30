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
const episodeDir = flags["episode-dir"]
  ? path.resolve(flags["episode-dir"])
  : path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const stitchReportPath = flags.qwenReport ?? flags["qwen-report"] ?? path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
const paceReportPath = flags.paceReport ?? flags["pace-report"] ?? path.join(episodeDir, `narration_pace_report_${episode}.json`);
const outputReportPath = flags.output ?? flags.report ?? path.join(episodeDir, `narration_tempo_normalize_${episode}.json`);
const targetWpm = Number(flags["target-wpm"] ?? process.env.GOLDFLOW_TARGET_WPM_MID ?? 215);
const minFactor = Number(flags["min-factor"] ?? 0.85);
const maxFactor = Number(flags["max-factor"] ?? 1.45);
const replaceStitchReport = flags["replace-stitch-report"] !== "false";

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

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function hashFile(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function mediaDuration(filePath) {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return Number(stdout.trim());
}

function atempoChain(factor) {
  const filters = [];
  let remaining = factor;
  while (remaining > 2) {
    filters.push("atempo=2.0");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(6)}`);
  return filters.join(",");
}

function scaledSegments(segments, factor) {
  return (segments ?? []).map((segment) => {
    const raw = Number(segment.raw_audio_duration_sec ?? segment.duration_sec ?? 0);
    const gap = Number(segment.segment_gap_sec ?? 0);
    const scaledRaw = raw > 0 ? raw / factor : raw;
    const scaledGap = gap > 0 ? gap / factor : gap;
    return {
      ...segment,
      tempo_normalized_from_duration_sec: segment.duration_sec ?? null,
      tempo_normalized_from_raw_audio_duration_sec: segment.raw_audio_duration_sec ?? null,
      raw_audio_duration_sec: Number(scaledRaw.toFixed(6)),
      segment_gap_sec: Number(scaledGap.toFixed(6)),
      duration_sec: Number((scaledRaw + scaledGap).toFixed(6)),
    };
  });
}

async function main() {
  if (!Number.isFinite(targetWpm) || targetWpm <= 0) throw new Error(`Invalid --target-wpm ${targetWpm}`);
  const stitch = await readJson(stitchReportPath, null);
  if (!stitch?.output_path) throw new Error(`Missing stitch report output_path: ${stitchReportPath}`);
  const pace = await readJson(paceReportPath, null);
  const actualWpm = Number(flags["actual-wpm"] ?? pace?.actual_wpm);
  if (!Number.isFinite(actualWpm) || actualWpm <= 0) throw new Error(`Missing actual WPM. Run audio pace-check first or pass --actual-wpm.`);
  const inputAudio = flags.audio ? path.resolve(flags.audio) : stitch.output_path;
  if (!(await exists(inputAudio))) throw new Error(`Missing narration audio: ${inputAudio}`);
  const factor = Number((targetWpm / actualWpm).toFixed(6));
  if (factor < minFactor || factor > maxFactor) {
    throw new Error(`Refusing tempo factor ${factor}; allowed range is ${minFactor}-${maxFactor}. Pass adjusted limits only for an explicit recovery run.`);
  }
  const parsed = path.parse(inputAudio);
  const outputAudio = flags.audioOutput
    ? path.resolve(flags.audioOutput)
    : path.join(parsed.dir, `${parsed.name}-tempo-${String(targetWpm).replace(/\./g, "p")}wpm${parsed.ext || ".wav"}`);
  const filter = atempoChain(factor);
  await execFile("ffmpeg", [
    "-y",
    "-i", inputAudio,
    "-filter:a", filter,
    "-ar", "44100",
    "-ac", "1",
    outputAudio,
  ]);
  const [inputDuration, outputDuration, inputHash, outputHash] = await Promise.all([
    mediaDuration(inputAudio),
    mediaDuration(outputAudio),
    hashFile(inputAudio),
    hashFile(outputAudio),
  ]);
  const updatedStitch = {
    ...stitch,
    status: "passed",
    output_path: outputAudio,
    tempo_normalized: true,
    tempo_normalize_report_path: outputReportPath,
    original_output_path: stitch.original_output_path ?? inputAudio,
    original_final_duration_sec: stitch.original_final_duration_sec ?? stitch.final_duration_sec ?? inputDuration,
    final_duration_sec: Number(outputDuration.toFixed(6)),
    tempo_factor: factor,
    target_wpm: targetWpm,
    previous_actual_wpm: actualWpm,
    segments: scaledSegments(stitch.segments ?? [], factor),
  };
  if (replaceStitchReport) await writeJson(stitchReportPath, updatedStitch);
  const report = {
    schema: "goldflow_narration_tempo_normalize_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    stitch_report_path: stitchReportPath,
    pace_report_path: paceReportPath,
    input_audio_path: inputAudio,
    output_audio_path: outputAudio,
    input_audio_hash: inputHash,
    output_audio_hash: outputHash,
    input_duration_sec: Number(inputDuration.toFixed(6)),
    output_duration_sec: Number(outputDuration.toFixed(6)),
    previous_actual_wpm: actualWpm,
    target_wpm: targetWpm,
    tempo_factor: factor,
    ffmpeg_filter: filter,
    stitch_report_updated: replaceStitchReport,
    policy: "Non-destructive narration tempo normalization after provider TTS. Raw TTS is preserved; Whisper timing must be rerun after this stage.",
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputReportPath, report);
  console.log(JSON.stringify({ status: "passed", report_path: outputReportPath, output_audio_path: outputAudio, tempo_factor: factor, output_duration_sec: report.output_duration_sec }, null, 2));
}

main().catch(async (error) => {
  await writeJson(outputReportPath, { schema: "goldflow_narration_tempo_normalize_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
