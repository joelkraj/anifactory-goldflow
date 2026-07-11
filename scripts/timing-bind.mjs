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
const maxSceneDurationSec = Number(flags["max-scene-duration-sec"] ?? process.env.ANIFACTORY_TIMING_MAX_SCENE_DURATION_SEC ?? 240);
const allowTimingFallbacks = flags["allow-timing-fallbacks"] === "true" || process.env.ANIFACTORY_ALLOW_TIMING_FALLBACKS === "true";

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

function wordTokenEntries(words) {
  const entries = [];
  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    for (const token of phraseTokens(words[wordIndex]?.word)) {
      entries.push({ token, wordIndex });
    }
  }
  return entries;
}

function levenshteinDistance(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_item, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function similarityRatio(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  const maxLength = Math.max(left.length, right.length);
  if (!maxLength) return 1;
  return 1 - (levenshteinDistance(left, right) / maxLength);
}

function findPhrase(words, phrase, minStartSec = 0, maxStartSec = null) {
  const tokens = phraseTokens(phrase);
  if (!tokens.length) return null;
  const entries = wordTokenEntries(words);
  const firstIndex = entries.findIndex((entry) => (
    Number(words[entry.wordIndex]?.end_sec ?? words[entry.wordIndex]?.start_sec ?? 0) >= Number(minStartSec ?? 0)
  ));
  const startIndex = Math.max(0, firstIndex);
  const maxStart = maxStartSec === null || maxStartSec === undefined ? null : Number(maxStartSec);
  for (let index = startIndex; index <= entries.length - tokens.length; index += 1) {
    const startWordIndex = entries[index]?.wordIndex ?? 0;
    const candidateStart = Number(words[startWordIndex]?.start_sec ?? 0);
    if (maxStart !== null && Number.isFinite(maxStart) && candidateStart > maxStart) break;
    let ok = true;
    for (let offset = 0; offset < tokens.length; offset += 1) {
      if (entries[index + offset]?.token !== tokens[offset]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const endWordIndex = entries[index + tokens.length - 1]?.wordIndex ?? startWordIndex;
      const start = words[startWordIndex];
      const end = words[endWordIndex] ?? start;
      return { start_sec: start.start_sec, end_sec: end.end_sec, matched_words: words.slice(startWordIndex, endWordIndex + 1).map((word) => word.word).join(" ") };
    }
  }
  const target = tokens.join(" ");
  const minWindow = Math.max(1, tokens.length - 3);
  const maxWindow = Math.min(tokens.length + 3, tokens.length < 4 ? tokens.length + 2 : tokens.length + 4);
  let best = null;
  for (let index = startIndex; index < entries.length; index += 1) {
    const startWordIndex = entries[index]?.wordIndex ?? 0;
    const candidateStart = Number(words[startWordIndex]?.start_sec ?? 0);
    if (maxStart !== null && Number.isFinite(maxStart) && candidateStart > maxStart) break;
    for (let windowSize = minWindow; windowSize <= maxWindow && index + windowSize <= entries.length; windowSize += 1) {
      const candidateEntries = entries.slice(index, index + windowSize);
      const candidate = candidateEntries.map((entry) => entry.token).join(" ");
      const score = similarityRatio(target, candidate);
      const threshold = target.length < 32 ? 0.78 : 0.84;
      if (score < threshold || (best && score <= best.score)) continue;
      const endWordIndex = candidateEntries[candidateEntries.length - 1]?.wordIndex ?? startWordIndex;
      const start = words[startWordIndex];
      const end = words[endWordIndex] ?? start;
      best = {
        start_sec: start.start_sec,
        end_sec: end.end_sec,
        matched_words: words.slice(startWordIndex, endWordIndex + 1).map((word) => word.word).join(" "),
        score,
      };
    }
  }
  if (best) {
    return {
      start_sec: best.start_sec,
      end_sec: best.end_sec,
      matched_words: best.matched_words,
      fuzzy_score: Number(best.score.toFixed(4)),
    };
  }
  return null;
}

function scriptTokenPosition(script, phrase) {
  const phraseNorm = normalize(phrase);
  if (!phraseNorm) return null;
  const scriptNorm = normalize(script);
  const charIndex = scriptNorm.indexOf(phraseNorm);
  if (charIndex < 0) return null;
  const before = scriptNorm.slice(0, charIndex).split(/\s+/).filter(Boolean).length;
  const total = Math.max(1, scriptNorm.split(/\s+/).filter(Boolean).length);
  return { token_index: before, token_count: total, ratio: Math.max(0, Math.min(1, before / total)) };
}

function timeFromScriptPosition(words, script, phrase) {
  const position = scriptTokenPosition(script, phrase);
  if (!position || !words.length) return null;
  const wordIndex = Math.max(0, Math.min(words.length - 1, Math.round(position.ratio * (words.length - 1))));
  const word = words[wordIndex];
  return {
    start_sec: Number(word.start_sec ?? 0),
    end_sec: Number(word.end_sec ?? word.start_sec ?? 0),
    script_token_index: position.token_index,
    script_token_count: position.token_count,
    script_ratio: Number(position.ratio.toFixed(6)),
  };
}

function sceneStartBounds(scenes, words, script) {
  let cursor = 0;
  return scenes.map((scene) => {
    const startMatch = findPhrase(words, scene.script_excerpt_start, Math.max(0, Number(cursor ?? 0) - 0.5));
    const scriptPosition = startMatch ? null : timeFromScriptPosition(words, script, scene.script_excerpt_start);
    const start = Number(startMatch?.start_sec ?? scriptPosition?.start_sec ?? cursor ?? 0);
    if (startMatch || scriptPosition) cursor = Math.max(cursor, Number(startMatch?.end_sec ?? scriptPosition?.end_sec ?? start) + 0.01);
    return {
      start_sec: Number(start.toFixed(3)),
      start_resolution: startMatch ? (startMatch.fuzzy_score ? "whisper_fuzzy_phrase_match" : "whisper_phrase_match") : scriptPosition ? "script_position_estimate" : "fallback_previous_scene_end",
      matched_start_words: startMatch?.matched_words ?? null,
      start_fuzzy_score: startMatch?.fuzzy_score ?? null,
      start_script_ratio: scriptPosition?.script_ratio ?? null,
    };
  });
}

function sceneBounds(scene, words, script, startBound, nextStartSec = null) {
  const start = Number(startBound.start_sec ?? 0);
  const nextStart = Number(nextStartSec);
  const endSearchMax = Number.isFinite(nextStart) && nextStart > start ? Math.max(start, nextStart - 0.01) : null;
  const endMatch = findPhrase(words, scene.script_excerpt_end, start, endSearchMax);
  const scriptPosition = endMatch ? null : timeFromScriptPosition(words, script, scene.script_excerpt_end);
  let end = Number(endMatch?.end_sec ?? scriptPosition?.end_sec ?? Math.max(start + 6, start));
  let endResolution = endMatch ? (endMatch.fuzzy_score ? "whisper_fuzzy_phrase_match" : "whisper_phrase_match") : scriptPosition ? "script_position_estimate" : "fallback_min_duration";
  if ((!endMatch || (Number.isFinite(nextStart) && end > nextStart)) && Number.isFinite(nextStart) && nextStart > start + 1) {
    end = nextStart;
    endResolution = endMatch ? "bounded_next_scene_start" : scriptPosition ? "bounded_script_position_estimate" : "fallback_next_scene_start";
  }
  return {
    start_sec: Number(start.toFixed(3)),
    end_sec: Number(Math.max(start + 1, end).toFixed(3)),
    start_resolution: startBound.start_resolution,
    end_resolution: endResolution,
    matched_start_words: startBound.matched_start_words ?? null,
    matched_end_words: endMatch?.matched_words ?? null,
    start_fuzzy_score: startBound.start_fuzzy_score ?? null,
    end_fuzzy_score: endMatch?.fuzzy_score ?? null,
    start_script_ratio: startBound.start_script_ratio ?? null,
    end_script_ratio: scriptPosition?.script_ratio ?? null,
  };
}

function fillEndFallbackGaps(scenes) {
  for (let index = 0; index < scenes.length - 1; index += 1) {
    const scene = scenes[index];
    const next = scenes[index + 1];
    if (scene.end_resolution !== "fallback_min_duration") continue;
    const nextStart = Number(next?.start_sec);
    if (!Number.isFinite(nextStart) || nextStart <= Number(scene.end_sec)) continue;
    scene.end_sec = Number(nextStart.toFixed(3));
    scene.duration_sec = Number((scene.end_sec - scene.start_sec).toFixed(3));
    scene.end_resolution = "fallback_next_scene_start";
  }
  return scenes;
}

function applyBoundedProofEnd(scenes, semantic, wordTiming) {
  const scope = semantic?.proof_scope;
  if (scope?.scoped !== true || !Number.isFinite(Number(scope.end_sec)) || !scenes.length) return scenes;
  const audioEnd = Number(wordTiming?.audio_duration_sec ?? scope.end_sec) - Number(scope.start_sec ?? 0);
  if (!(audioEnd > 0)) return scenes;
  const last = scenes.at(-1);
  last.end_sec = Number(Math.max(Number(last.start_sec) + 0.25, audioEnd).toFixed(3));
  last.duration_sec = Number((last.end_sec - Number(last.start_sec)).toFixed(3));
  last.end_resolution = "bounded_proof_audio_end";
  return scenes;
}

function assertTimingQuality(scenes) {
  const failures = [];
  for (const scene of scenes) {
    const duration = Number(scene.duration_sec ?? 0);
    if (Number.isFinite(maxSceneDurationSec) && maxSceneDurationSec > 0 && duration > maxSceneDurationSec) {
      failures.push(`${scene.scene_id} duration ${duration.toFixed(1)}s exceeds max ${maxSceneDurationSec}s (${scene.title ?? "untitled"})`);
    }
    if (!allowTimingFallbacks && scene.start_resolution === "fallback_previous_scene_end") {
      failures.push(`${scene.scene_id} start anchor did not bind to Whisper (${scene.title ?? "untitled"})`);
    }
    if (!allowTimingFallbacks && scene.end_resolution === "fallback_min_duration") {
      failures.push(`${scene.scene_id} end anchor did not bind or bound to next scene (${scene.title ?? "untitled"})`);
    }
  }
  if (failures.length) {
    throw new Error(`Timing bind quality gate failed:\n${failures.slice(0, 40).join("\n")}`);
  }
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
  const semanticScenes = semantic.scenes ?? [];
  const startBounds = sceneStartBounds(semanticScenes, wordTiming.words, script);
  const scenes = applyBoundedProofEnd(fillEndFallbackGaps(semanticScenes.map((scene, index) => {
    const bounds = sceneBounds(scene, wordTiming.words, script, startBounds[index], startBounds[index + 1]?.start_sec);
    return {
      ...scene,
      ...bounds,
      duration_sec: Number((bounds.end_sec - bounds.start_sec).toFixed(3)),
      timing_source: "local_whisper_word_timing",
    };
  })), semantic, wordTiming);
  assertTimingQuality(scenes);
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
