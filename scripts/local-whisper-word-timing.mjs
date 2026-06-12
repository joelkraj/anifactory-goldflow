#!/usr/bin/env node

import { execFile as execFileCb, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const args = process.argv.slice(2);
const flags = parseFlags(args);

const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const scriptPath = path.join(episodeDir, "script_clean.md");
const qwenReportPath = flags.qwenReport ?? path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
const outputPath = flags.output ?? path.join(episodeDir, `narration_word_timing_${episode}.json`);

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

function nowIso() {
  return new Date().toISOString();
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

async function hashFile(filePath) {
  try {
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function segmentStarts(qwenReport) {
  const starts = new Map();
  let cursor = 0;
  for (const segment of qwenReport.segments ?? []) {
    starts.set(String(segment.segment_id), cursor);
    cursor += Number(segment.duration_sec ?? segment.raw_audio_duration_sec ?? 0);
  }
  return starts;
}

function narrationAudioPath(qwenReport) {
  const explicit = flags.audio ?? flags.narrationAudio;
  if (explicit) return explicit;
  if (qwenReport.output_path) return qwenReport.output_path;
  throw new Error("No clean stitched narration audio path found. Pass --audio <path>.");
}

async function runFasterWhisper(audioPath) {
  const model = flags.model ?? process.env.ANIFACTORY_WHISPER_MODEL ?? "small";
  const device = flags.device ?? process.env.ANIFACTORY_WHISPER_DEVICE ?? "auto";
  const computeType = flags.computeType ?? flags["compute-type"] ?? process.env.ANIFACTORY_WHISPER_COMPUTE_TYPE ?? "auto";
  const language = flags.language ?? process.env.ANIFACTORY_WHISPER_LANGUAGE ?? "en";
  const tmpPath = path.join(os.tmpdir(), `goldflow-whisper-${process.pid}-${Date.now()}.json`);
  const py = String.raw`
import json, sys
from faster_whisper import WhisperModel

audio_path = sys.argv[1]
model_name = sys.argv[2]
device = sys.argv[3]
compute_type = sys.argv[4]
language = sys.argv[5]
output_path = sys.argv[6]

model = WhisperModel(model_name, device=device, compute_type=compute_type)
segments, info = model.transcribe(
    audio_path,
    language=language,
    word_timestamps=True,
    vad_filter=False,
    beam_size=5,
)

rows = []
for seg in segments:
    seg_words = []
    for word in (seg.words or []):
        item = {
            "word": word.word.strip(),
            "start_sec": round(float(word.start), 3),
            "end_sec": round(float(word.end), 3),
            "probability": round(float(getattr(word, "probability", 0.0) or 0.0), 4),
        }
        rows.append(item)
        seg_words.append(item)

with open(output_path, "w", encoding="utf-8") as handle:
    json.dump({
    "language": info.language,
    "language_probability": info.language_probability,
    "duration_sec": info.duration,
    "words": rows,
    }, handle, ensure_ascii=False)

print(json.dumps({"status": "ok", "word_count": len(rows)}, ensure_ascii=False))
`;
  await new Promise((resolve, reject) => {
    const timeoutMs = Number(process.env.ANIFACTORY_WHISPER_TIMEOUT_MS ?? 7_200_000);
    const child = spawn("python3", ["-c", py, audioPath, model, device, computeType, language, tmpPath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Whisper transcription timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Whisper transcription failed with code ${code ?? "null"} signal ${signal ?? "null"}`));
    });
  });
  const result = JSON.parse(await fs.readFile(tmpPath, "utf8"));
  await fs.rm(tmpPath, { force: true });
  return { model, device, compute_type: computeType, language, ...result };
}

function normalizeWord(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function attachSegments(words, qwenReport) {
  const starts = segmentStarts(qwenReport);
  const rows = (qwenReport.segments ?? []).map((segment) => {
    const start = starts.get(String(segment.segment_id)) ?? 0;
    const duration = Number(segment.duration_sec ?? segment.raw_audio_duration_sec ?? 0);
    return {
      segment_id: segment.segment_id,
      start_sec: Number(start.toFixed(3)),
      end_sec: Number((start + duration).toFixed(3)),
      text: segment.stripped_text ?? segment.text ?? "",
    };
  });
  let segmentIndex = 0;
  return words.map((word, index) => {
    while (segmentIndex < rows.length - 1 && word.start_sec > rows[segmentIndex].end_sec + 0.35) segmentIndex += 1;
    const segment = rows[segmentIndex] ?? null;
    return {
      index,
      ...word,
      normalized: normalizeWord(word.word),
      segment_id_guess: segment?.segment_id ?? null,
      segment_start_sec_guess: segment?.start_sec ?? null,
      segment_end_sec_guess: segment?.end_sec ?? null,
    };
  });
}

async function main() {
  const qwenReport = await readJson(qwenReportPath, null);
  if (!qwenReport?.segments?.length) throw new Error(`Missing Qwen stitch report: ${qwenReportPath}`);
  const audioPath = narrationAudioPath(qwenReport);
  const [scriptHash, audioHash] = await Promise.all([hashFile(scriptPath), hashFile(audioPath)]);
  const transcription = await runFasterWhisper(audioPath);
  const words = attachSegments(transcription.words ?? [], qwenReport);
  const report = {
    status: words.length ? "passed" : "failed",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    narration_audio_path: audioPath,
    narration_audio_hash: audioHash,
    qwen_report_path: qwenReportPath,
    alignment_engine: "faster_whisper",
    alignment_model: transcription.model,
    alignment_device: transcription.device,
    alignment_compute_type: transcription.compute_type,
    language: transcription.language,
    language_probability: transcription.language_probability,
    audio_duration_sec: transcription.duration_sec,
    word_count: words.length,
    words,
    updated_at: nowIso(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({
    status: report.status,
    output_path: outputPath,
    word_count: report.word_count,
    source_script_hash: report.source_script_hash,
    narration_audio_hash: report.narration_audio_hash,
    alignment_model: report.alignment_model,
  }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch(async (error) => {
  await writeJson(outputPath, {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
    updated_at: nowIso(),
  }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
