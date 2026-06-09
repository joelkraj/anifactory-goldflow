#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const scriptPath = path.join(episodeDir, "script_clean.md");
const semanticPath = flags.semantic ?? path.join(episodeDir, "semantic_scene_plan.json");
const wordTimingPath = flags.wordTiming ?? flags["word-timing"] ?? path.join(episodeDir, `narration_word_timing_${episode}.json`);
const qwenReportPath = flags.qwenReport ?? path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
const outputPath = flags.output ?? path.join(episodeDir, "timed_scene_plan.json");

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

async function readText(filePath, fallback = "") {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
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

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function phraseTokens(value) {
  return normalize(value).split(/\s+/).filter(Boolean);
}

function findPhrase(words, phrase) {
  const tokens = phraseTokens(phrase);
  if (!tokens.length) return null;
  const wordTokens = words.map((word) => normalize(word.word));
  for (let index = 0; index <= wordTokens.length - tokens.length; index += 1) {
    let ok = true;
    for (let offset = 0; offset < tokens.length; offset += 1) {
      if (wordTokens[index + offset] !== tokens[offset]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const start = words[index];
      const end = words[index + tokens.length - 1] ?? start;
      return { start_sec: start.start_sec, end_sec: end.end_sec, matched_words: words.slice(index, index + tokens.length).map((word) => word.word).join(" ") };
    }
  }
  return null;
}

function sceneBounds(scene, words, fallbackStart) {
  const startMatch = findPhrase(words, scene.script_excerpt_start);
  const endMatch = findPhrase(words, scene.script_excerpt_end);
  const start = Number(startMatch?.start_sec ?? fallbackStart ?? 0);
  const end = Number(endMatch?.end_sec ?? Math.max(start + 6, start));
  return {
    start_sec: Number(start.toFixed(3)),
    end_sec: Number(Math.max(start + 1, end).toFixed(3)),
    start_resolution: startMatch ? "whisper_phrase_match" : "fallback_previous_scene_end",
    end_resolution: endMatch ? "whisper_phrase_match" : "fallback_min_duration",
    matched_start_words: startMatch?.matched_words ?? null,
    matched_end_words: endMatch?.matched_words ?? null,
  };
}

async function main() {
  const [script, semantic, wordTiming, qwenReport] = await Promise.all([
    readText(scriptPath),
    readJson(semanticPath, null),
    readJson(wordTimingPath, null),
    readJson(qwenReportPath, null),
  ]);
  if (!script.trim()) throw new Error(`Missing script: ${scriptPath}`);
  const scriptHash = sha256(script);
  if (semantic?.source_script_hash !== scriptHash) throw new Error("semantic_scene_plan.json is stale for current script_clean.md.");
  if (wordTiming?.status !== "passed" || !Array.isArray(wordTiming.words) || !wordTiming.words.length) throw new Error("Missing passed local Whisper word timing.");
  if (wordTiming.source_script_hash && wordTiming.source_script_hash !== scriptHash) throw new Error("Whisper timing is stale for current script_clean.md.");
  const audioHash = qwenReport?.output_path ? await hashFile(qwenReport.output_path) : null;
  if (audioHash && wordTiming.narration_audio_hash && wordTiming.narration_audio_hash !== audioHash) throw new Error("Whisper timing is stale for current stitched narration audio.");
  let cursor = 0;
  const scenes = (semantic.scenes ?? []).map((scene) => {
    const bounds = sceneBounds(scene, wordTiming.words, cursor);
    cursor = bounds.end_sec;
    return {
      ...scene,
      ...bounds,
      duration_sec: Number((bounds.end_sec - bounds.start_sec).toFixed(3)),
      timing_source: "local_whisper_word_timing",
    };
  });
  const report = {
    schema: "goldflow_timed_scene_plan_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: scriptHash,
    source_artifact_paths: [scriptPath, semanticPath, wordTimingPath, qwenReportPath],
    source_hashes: Object.fromEntries((await Promise.all([scriptPath, semanticPath, wordTimingPath, qwenReportPath].map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
    timing_source: "local_whisper_word_timing",
    audio_duration_sec: wordTiming.audio_duration_sec ?? qwenReport?.final_duration_sec ?? null,
    scene_count: scenes.length,
    scenes,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: "passed", output_path: outputPath, scene_count: scenes.length, timing_source: report.timing_source }, null, 2));
}

main().catch(async (error) => {
  await writeJson(outputPath, { schema: "goldflow_timed_scene_plan_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
