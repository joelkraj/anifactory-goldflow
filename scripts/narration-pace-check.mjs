#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_TARGET_WPM_MAX,
  DEFAULT_TARGET_WPM_MIN,
  buildScriptPaceReport,
  normalizePacePolicy,
  spokenWordCount,
} from "./lib/script-pace-diagnostics.mjs";

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
const targetMinWpm = Number(flags["target-wpm-min"] ?? process.env.GOLDFLOW_TARGET_WPM_MIN ?? DEFAULT_TARGET_WPM_MIN);
const targetMaxWpm = Number(flags["target-wpm-max"] ?? process.env.GOLDFLOW_TARGET_WPM_MAX ?? DEFAULT_TARGET_WPM_MAX);
const targetMidWpm = Number(((targetMinWpm + targetMaxWpm) / 2).toFixed(3));
const requestedPacePolicy = normalizePacePolicy(flags["pace-policy"] ?? flags["wpm-policy"] ?? "diagnostic");
const pacePolicy = "diagnostic";
const paceGateEnforced = false;
const allowHookWarnings = flags["allow-hook-warnings"] === "true"
  || process.env.GOLDFLOW_ALLOW_HOOK_WARNINGS === "true";
const hookMilestonesPath = flags["hook-milestones"] ? path.resolve(flags["hook-milestones"]) : null;

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

function paceStatus(wpm) {
  if (!Number.isFinite(wpm)) return "invalid_measurement";
  return wpm >= targetMinWpm && wpm <= targetMaxWpm ? "within_target" : "outside_target";
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
    pace_policy: pacePolicy,
    requested_pace_policy: requestedPacePolicy,
    pace_gate_enforced: paceGateEnforced,
    script_word_count: scriptWordCount,
    estimated_runtime_at_target_mid_sec: Number((scriptWordCount / targetMidWpm * 60).toFixed(3)),
    estimated_runtime_at_target_min_sec: Number((scriptWordCount / targetMinWpm * 60).toFixed(3)),
    estimated_runtime_at_target_max_sec: Number((scriptWordCount / targetMaxWpm * 60).toFixed(3)),
    policy: `Goldflow records ${targetMinWpm}-${targetMaxWpm} spoken words per minute as a diagnostic target. WPM does not block production.`,
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
    const measuredStatus = paceStatus(actualWpm);
    const status = paceGateEnforced ? measuredStatus : "passed";
    const report = {
      ...base,
      status,
      diagnostic_pace_status: measuredStatus,
      word_timing_path: wordTimingPath,
      narration_audio_path: wordTiming.narration_audio_path ?? null,
      narration_audio_hash: wordTiming.narration_audio_hash ?? null,
      measured_word_count: wordCount,
      measured_duration_sec: durationSec,
      actual_wpm: Number.isFinite(actualWpm) ? Number(actualWpm.toFixed(3)) : null,
      blocker: null,
    };
    await writeJson(outputPath, report);
    console.log(JSON.stringify({ status, output_path: outputPath, actual_wpm: report.actual_wpm }, null, 2));
    if (status !== "passed") process.exitCode = 1;
    return;
  }

  // Script mode is the shared library's report (also folded into the script lock on
  // registry ≥ 2026-10-20.1 identities); this stage command keeps it for historical identities.
  const report = await buildScriptPaceReport({
    script,
    scriptPath,
    sourceScriptHash,
    channel,
    series,
    week,
    episode,
    targetMinWpm,
    targetMaxWpm,
    requestedPacePolicy,
    allowHookWarnings,
    hookMilestonesPath,
    sourceHashes: base.source_hashes,
    updatedAt: base.updated_at,
  });
  const status = report.status;
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: report.status, output_path: outputPath, target_wpm: `${targetMinWpm}-${targetMaxWpm}`, estimated_runtime_at_target_mid_sec: report.estimated_runtime_at_target_mid_sec }, null, 2));
  if (status !== "passed") process.exitCode = 1;
}

main().catch(async (error) => {
  await writeJson(outputPath, { schema: "goldflow_narration_pace_report_v1", status: "failed", mode, error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
