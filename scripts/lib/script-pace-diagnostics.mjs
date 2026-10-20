// Script-stage pace diagnostics (word-count WPM budget + optional configured hook milestones).
// Shared by `script pace-check` (historical registry row) and the folded script lock
// (registry ≥ 2026-10-20.1). Diagnostic only: WPM never blocks production.
import { promises as fs } from "node:fs";

export const SCRIPT_PACE_REPORT_SCHEMA = "goldflow_narration_pace_report_v1";
export const DEFAULT_TARGET_WPM_MIN = 180;
export const DEFAULT_TARGET_WPM_MAX = 195;

export function spokenWordCount(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+.*$/gm, " ")
    .replace(/<[^>]+>/g, " ")
    .match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function normalizePacePolicy(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["diagnostic", "diagnostic_only", "non_blocking", "report_only", "wpm_diagnostic"].includes(normalized)) return "diagnostic";
  return "enforced";
}

function normalizePhrase(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function estimatedPhraseTime(script, phrase, wpm) {
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

export function hookTargetShape() {
  return {
    first_30_sec_words: [98, 110],
    first_60_sec_words: [195, 220],
    first_90_sec_words: [293, 330],
    first_180_sec_words: [585, 660],
  };
}

export function normalizeHookConfig(config, hookMilestonesPath = null) {
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

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function hookMilestoneReport(script, wpm, { hookMilestonesPath = null, readJson = readJsonFile } = {}) {
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
  const phraseGroups = normalizeHookConfig(await readJson(hookMilestonesPath), hookMilestonesPath);
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

/** Builds the script-mode pace report exactly as `script pace-check` writes it. */
export async function buildScriptPaceReport({
  script,
  scriptPath,
  sourceScriptHash,
  channel,
  series,
  week,
  episode,
  targetMinWpm = DEFAULT_TARGET_WPM_MIN,
  targetMaxWpm = DEFAULT_TARGET_WPM_MAX,
  requestedPacePolicy = "diagnostic",
  allowHookWarnings = false,
  hookMilestonesPath = null,
  sourceHashes = {},
  updatedAt = new Date().toISOString(),
} = {}) {
  const targetMidWpm = Number(((targetMinWpm + targetMaxWpm) / 2).toFixed(3));
  const pacePolicy = "diagnostic";
  const paceGateEnforced = false;
  const scriptWordCount = spokenWordCount(script);
  const hookReport = await hookMilestoneReport(script, targetMidWpm, { hookMilestonesPath });
  const hookWarnings = hookReport.warnings ?? [];
  const hookGateEnforced = hookReport.configured !== false && paceGateEnforced && !allowHookWarnings;
  const measuredHookStatus = hookReport.configured === false ? "not_configured" : hookWarnings.length ? "missed_goal" : "within_target";
  const status = hookWarnings.length && hookGateEnforced ? "blocked" : "passed";
  return {
    schema: SCRIPT_PACE_REPORT_SCHEMA,
    channel,
    series_slug: series,
    week,
    episode,
    mode: "script",
    source_script_path: scriptPath,
    source_script_hash: sourceScriptHash,
    target_wpm_min: targetMinWpm,
    target_wpm_max: targetMaxWpm,
    target_wpm_midpoint: targetMidWpm,
    pace_policy: pacePolicy,
    requested_pace_policy: normalizePacePolicy(requestedPacePolicy),
    pace_gate_enforced: paceGateEnforced,
    script_word_count: scriptWordCount,
    estimated_runtime_at_target_mid_sec: Number((scriptWordCount / targetMidWpm * 60).toFixed(3)),
    estimated_runtime_at_target_min_sec: Number((scriptWordCount / targetMinWpm * 60).toFixed(3)),
    estimated_runtime_at_target_max_sec: Number((scriptWordCount / targetMaxWpm * 60).toFixed(3)),
    policy: `Goldflow records ${targetMinWpm}-${targetMaxWpm} spoken words per minute as a diagnostic target. WPM does not block production.`,
    source_hashes: sourceHashes,
    updated_at: updatedAt,
    status,
    estimated: true,
    hook_gate_enforced: hookGateEnforced,
    allow_hook_warnings: allowHookWarnings,
    diagnostic_hook_status: measuredHookStatus,
    hook_milestone_report: hookReport,
    blocker: null,
    note: hookReport.configured === false
      ? "Script-stage WPM is a target budget. No built-in story-family hook phrase gate is active; hook milestone checks require an explicit --hook-milestones config. Actual spoken WPM measurement happens after narration stitch and local Whisper timing."
      : hookGateEnforced
        ? "Script-stage WPM is a target budget; configured hook milestone timing is enforced here. Actual spoken WPM measurement happens after narration stitch and local Whisper timing."
        : "Script-stage WPM and configured hook milestone timing are recorded diagnostically for this run policy. Actual spoken WPM is measured after narration stitch and local Whisper timing.",
  };
}
