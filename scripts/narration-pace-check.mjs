#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const mode = String(flags.mode ?? "script");
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = flags["episode-dir"]
  ? path.resolve(flags["episode-dir"])
  : path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const scriptPath = flags.script ?? path.join(episodeDir, "script_clean.md");
const wordTimingPath = flags.wordTiming ?? flags["word-timing"] ?? path.join(episodeDir, `narration_word_timing_${episode}.json`);
const outputPath = flags.output ?? path.join(episodeDir, mode === "audio" ? `narration_pace_report_${episode}.json` : "script_pace_report.json");
const targetMinWpm = Number(flags["target-wpm-min"] ?? process.env.GOLDFLOW_TARGET_WPM_MIN ?? 210);
const targetMaxWpm = Number(flags["target-wpm-max"] ?? process.env.GOLDFLOW_TARGET_WPM_MAX ?? 220);
const targetMidWpm = Number(((targetMinWpm + targetMaxWpm) / 2).toFixed(3));
const allowHookWarnings = flags["allow-hook-warnings"] === "true"
  || process.env.GOLDFLOW_ALLOW_HOOK_WARNINGS === "true";

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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function hashFile(filePath) {
  try {
    return sha256(await fs.readFile(filePath));
  } catch {
    return null;
  }
}

async function sourceHashesFor(paths) {
  return Object.fromEntries(
    (await Promise.all(paths.filter(Boolean).map(async (filePath) => [filePath, await hashFile(filePath)])))
      .filter(([, hash]) => hash),
  );
}

function spokenWordCount(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+.*$/gm, " ")
    .replace(/<[^>]+>/g, " ")
    .match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function spokenWordsWithOffsets(text) {
  const rows = [];
  const pattern = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
  for (const match of String(text ?? "").matchAll(pattern)) {
    rows.push({ word: match[0], index: match.index ?? 0 });
  }
  return rows;
}

function normalizePhrase(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function estimatedPhraseTime(script, phrase, words, wpm) {
  const normalizedScript = normalizePhrase(script);
  const normalizedPhrase = normalizePhrase(phrase);
  if (!normalizedPhrase) return null;
  const charIndex = normalizedScript.indexOf(normalizedPhrase);
  if (charIndex < 0) return null;
  const beforeWords = normalizePhrase(normalizedScript.slice(0, charIndex)).split(/\s+/).filter(Boolean).length;
  return {
    phrase,
    estimated_sec: Number((beforeWords / wpm * 60).toFixed(3)),
    estimated_word_index: beforeWords,
  };
}

function hookMilestoneReport(script, wpm) {
  const words = spokenWordsWithOffsets(script);
  const phraseGroups = [
    { code: "system_activated", label: "system activation", patterns: ["system activated", "system awakened", "system opened", "system flashed"] },
    { code: "first_quest_declared", label: "first quest declared", patterns: ["first quest"] },
    { code: "first_quest_complete", label: "first quest complete", patterns: ["first quest complete", "quest complete"] },
    { code: "core_mechanic", label: "core mechanic", patterns: ["gold was attention", "blue was truth", "authenticity", "clout"] },
    { code: "next_arc", label: "next arc", patterns: ["analytics hall", "report to analytics hall", "agent00"] },
  ];
  const milestones = [];
  for (const group of phraseGroups) {
    const match = group.patterns
      .map((phrase) => estimatedPhraseTime(script, phrase, words, wpm))
      .filter(Boolean)
      .sort((a, b) => a.estimated_sec - b.estimated_sec)[0] ?? null;
    if (match) milestones.push({ code: group.code, label: group.label, ...match });
  }
  const warnings = [];
  const firstQuestComplete = milestones.find((row) => row.code === "first_quest_complete");
  if (firstQuestComplete && firstQuestComplete.estimated_sec > 60) {
    warnings.push({
      code: "late_first_quest_completion",
      severity: "warning",
      estimated_sec: firstQuestComplete.estimated_sec,
      target_sec: 45,
      reason: "Streamer/system hooks should usually complete the first live/system proof around 45 seconds when the premise supports it.",
    });
  }
  const nextArc = milestones.find((row) => row.code === "next_arc");
  if (nextArc && nextArc.estimated_sec > 90) {
    warnings.push({
      code: "late_next_arc_entry",
      severity: "warning",
      estimated_sec: nextArc.estimated_sec,
      target_sec: 60,
      reason: "The next major arc should usually start around 60 seconds for a compressed retention proof when the premise supports it.",
    });
  }
  const systemActivated = milestones.find((row) => row.code === "system_activated");
  if (systemActivated && systemActivated.estimated_sec > 30) {
    warnings.push({
      code: "late_hidden_power_spark",
      severity: "warning",
      estimated_sec: systemActivated.estimated_sec,
      target_sec: 30,
      reason: "The hidden-power spark should land in the first 30 seconds for title-promise retention hooks.",
    });
  }
  return {
    target_shape: {
      first_30_sec_words: [105, 110],
      first_60_sec_words: [210, 220],
      first_90_sec_words: [315, 330],
      first_180_sec_words: [630, 660],
    },
    milestones,
    warnings,
  };
}

function paceStatus(wpm) {
  if (!Number.isFinite(wpm)) return "failed";
  return wpm >= targetMinWpm && wpm <= targetMaxWpm ? "passed" : "blocked";
}

async function main() {
  const script = await fs.readFile(scriptPath, "utf8");
  const sourceScriptHash = sha256(script);
  const scriptWordCount = spokenWordCount(script);
  const base = {
    schema: "goldflow_narration_pace_report_v1",
    channel,
    series_slug: series,
    week,
    episode,
    mode,
    source_script_path: scriptPath,
    source_script_hash: sourceScriptHash,
    target_wpm_min: targetMinWpm,
    target_wpm_max: targetMaxWpm,
    target_wpm_midpoint: targetMidWpm,
    script_word_count: scriptWordCount,
    estimated_runtime_at_target_mid_sec: Number((scriptWordCount / targetMidWpm * 60).toFixed(3)),
    estimated_runtime_at_target_min_sec: Number((scriptWordCount / targetMinWpm * 60).toFixed(3)),
    estimated_runtime_at_target_max_sec: Number((scriptWordCount / targetMaxWpm * 60).toFixed(3)),
    policy: "Goldflow narration pace target is 210-220 spoken words per minute for new production scripts.",
    source_hashes: await sourceHashesFor(mode === "audio" ? [scriptPath, wordTimingPath] : [scriptPath]),
    updated_at: new Date().toISOString(),
  };

  if (mode === "audio") {
    const wordTiming = await readJson(wordTimingPath, null);
    if (!wordTiming) throw new Error(`Missing word timing report: ${wordTimingPath}`);
    if (wordTiming.source_script_hash && wordTiming.source_script_hash !== sourceScriptHash) {
      throw new Error(`Stale word timing report: ${wordTiming.source_script_hash} does not match current script ${sourceScriptHash}.`);
    }
    const wordCount = Number(wordTiming.word_count ?? wordTiming.words?.length ?? scriptWordCount);
    const durationSec = Number(wordTiming.audio_duration_sec ?? wordTiming.duration_sec ?? 0);
    const actualWpm = durationSec > 0 ? wordCount / (durationSec / 60) : NaN;
    const status = paceStatus(actualWpm);
    const report = {
      ...base,
      status,
      word_timing_path: wordTimingPath,
      narration_audio_path: wordTiming.narration_audio_path ?? null,
      narration_audio_hash: wordTiming.narration_audio_hash ?? null,
      measured_word_count: wordCount,
      measured_duration_sec: durationSec,
      actual_wpm: Number.isFinite(actualWpm) ? Number(actualWpm.toFixed(3)) : null,
      blocker: status === "passed" ? null : `Actual narration pace must be ${targetMinWpm}-${targetMaxWpm} WPM.`,
    };
    await writeJson(outputPath, report);
    console.log(JSON.stringify({ status, output_path: outputPath, actual_wpm: report.actual_wpm }, null, 2));
    if (status !== "passed") process.exitCode = 1;
    return;
  }

  const hookReport = hookMilestoneReport(script, targetMidWpm);
  const hookWarnings = hookReport.warnings ?? [];
  const status = hookWarnings.length && !allowHookWarnings ? "blocked" : "passed";
  const report = {
    ...base,
    status,
    estimated: true,
    hook_milestone_report: hookReport,
    blocker: status === "passed" ? null : `Script hook timing has ${hookWarnings.length} blocker(s). Tighten the source/chatbot hook or rerun with --allow-hook-warnings true only for diagnostics.`,
    note: "Script-stage WPM is a target budget; hook milestone timing is enforced here when detected. Actual spoken WPM enforcement happens after Qwen stitch and local Whisper timing.",
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: report.status, output_path: outputPath, target_wpm: `${targetMinWpm}-${targetMaxWpm}`, estimated_runtime_at_target_mid_sec: report.estimated_runtime_at_target_mid_sec }, null, 2));
  if (status !== "passed") process.exitCode = 1;
}

main().catch(async (error) => {
  await writeJson(outputPath, { schema: "goldflow_narration_pace_report_v1", status: "failed", mode, error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
