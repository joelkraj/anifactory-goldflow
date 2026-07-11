#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const DEFAULT_TARGET_WPM_MIN = 195;
const DEFAULT_TARGET_WPM_MAX = 220;
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

function normalizePacePolicy(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["diagnostic", "diagnostic_only", "non_blocking", "report_only", "wpm_diagnostic"].includes(normalized)) return "diagnostic";
  return "enforced";
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

function normalizePhrase(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function estimatedPhraseTime(script, phrase, wpm) {
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

function hookTargetShape() {
  return {
    first_30_sec_words: [98, 110],
    first_60_sec_words: [195, 220],
    first_90_sec_words: [293, 330],
    first_180_sec_words: [585, 660],
  };
}

function normalizeHookConfig(config) {
  const rows = Array.isArray(config) ? config : config?.milestones;
  if (!Array.isArray(rows)) {
    throw new Error(`Invalid hook milestone config at ${hookMilestonesPath}: expected an array or { "milestones": [...] }.`);
  }
  return rows.map((row, index) => {
    const patterns = Array.isArray(row.patterns) ? row.patterns : [row.phrase ?? row.pattern].filter(Boolean);
    const code = String(row.code ?? `hook_milestone_${index + 1}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return {
      code,
      label: row.label ?? code.replace(/_/g, " "),
      patterns: patterns.map((pattern) => String(pattern ?? "").trim()).filter(Boolean),
      target_sec: Number(row.target_sec ?? row.targetSec),
      warning_code: row.warning_code ?? row.warningCode ?? `late_${code}`,
      reason: row.reason ?? "Configured hook milestone landed later than its configured target.",
    };
  }).filter((row) => row.code && row.patterns.length);
}

async function hookMilestoneReport(script, wpm) {
  if (!hookMilestonesPath) {
    return {
      target_shape: hookTargetShape(),
      configured: false,
      hook_milestones_path: null,
      milestones: [],
      warnings: [],
      policy: "No built-in story-family hook phrases are used. Hook milestone checks require an explicit --hook-milestones config.",
    };
  }
  const phraseGroups = normalizeHookConfig(await readJson(hookMilestonesPath, null));
  const milestones = [];
  for (const group of phraseGroups) {
    const match = group.patterns
      .map((phrase) => estimatedPhraseTime(script, phrase, wpm))
      .filter(Boolean)
      .sort((a, b) => a.estimated_sec - b.estimated_sec)[0] ?? null;
    if (match) milestones.push({ code: group.code, label: group.label, ...match });
  }
  const warnings = [];
  for (const group of phraseGroups) {
    const milestone = milestones.find((row) => row.code === group.code);
    if (!milestone || !Number.isFinite(group.target_sec) || milestone.estimated_sec <= group.target_sec) continue;
    warnings.push({
      code: group.warning_code,
      severity: "warning",
      estimated_sec: milestone.estimated_sec,
      target_sec: group.target_sec,
      reason: group.reason,
    });
  }
  return {
    target_shape: hookTargetShape(),
    configured: true,
    hook_milestones_path: hookMilestonesPath,
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

  const hookReport = await hookMilestoneReport(script, targetMidWpm);
  const hookWarnings = hookReport.warnings ?? [];
  const hookGateEnforced = hookReport.configured !== false && paceGateEnforced && !allowHookWarnings;
  const measuredHookStatus = hookReport.configured === false ? "not_configured" : hookWarnings.length ? "blocked" : "passed";
  const status = hookWarnings.length && hookGateEnforced ? "blocked" : "passed";
  const report = {
    ...base,
    status,
    estimated: true,
    hook_gate_enforced: hookGateEnforced,
    allow_hook_warnings: allowHookWarnings,
    diagnostic_hook_status: measuredHookStatus,
    hook_milestone_report: hookReport,
    blocker: status === "passed" ? null : `Script hook timing has ${hookWarnings.length} blocker(s). Tighten the source/chatbot hook or rerun with --allow-hook-warnings true only for diagnostics.`,
    note: hookReport.configured === false
      ? "Script-stage WPM is a target budget. No built-in story-family hook phrase gate is active; hook milestone checks require an explicit --hook-milestones config. Actual spoken WPM enforcement happens after Qwen stitch and local Whisper timing."
      : hookGateEnforced
        ? "Script-stage WPM is a target budget; configured hook milestone timing is enforced here. Actual spoken WPM enforcement happens after Qwen stitch and local Whisper timing."
        : "Script-stage WPM and configured hook milestone timing are recorded diagnostically for this run policy. Actual spoken WPM is measured after Qwen stitch and local Whisper timing.",
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
