#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
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
const reportPath = flags.output ?? path.join(episodeDir, "script_speakability_report.json");
const overridesPath = flags.overrides ?? path.join(episodeDir, "tts_spoken_overrides.json");
const problemReportPath = flags.problemReport ?? flags["problem-report"] ?? path.join(episodeDir, "script_speakability_problem_areas_report.json");
const archiveExisting = flags["archive-existing"] !== "false";

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

function approvedForHash(artifact, hash) {
  if (!artifact) return false;
  const status = String(artifact.status ?? artifact.approval_status ?? "").toLowerCase();
  return (artifact.approved === true || artifact.operator_approved === true || status.includes("approved") || status === "script_locked")
    && [artifact.script_clean_hash, artifact.source_script_hash, artifact.script_hash].filter(Boolean).includes(hash);
}

async function requireApproval(scriptHash) {
  if (flags["allow-unlocked-script"] === "true") return;
  const manual = await readJson(path.join(episodeDir, "manual_agent_script_review.json"), null);
  const operator = await readJson(path.join(episodeDir, "operator_script_approval.json"), null);
  const lock = await readJson(path.join(episodeDir, "script_lock.json"), null);
  if (approvedForHash(manual, scriptHash) && approvedForHash(operator, scriptHash) && approvedForHash(lock, scriptHash)) return;
  throw new Error(`Refusing targeted speakability: script hash ${scriptHash} is not approved/locked. Run script approve for the exact hash.`);
}

function lineNumberForIndex(text, index) {
  return String(text ?? "").slice(0, Math.max(0, index)).split("\n").length;
}

function excerptAround(text, index, length) {
  const start = Math.max(0, index - 120);
  const end = Math.min(text.length, index + length + 160);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

const targetedPatterns = [
  {
    code: "meta_narrator_self_reference",
    pattern: /\bthe narrator will tell you what the shaman could not have known:/gi,
    replacement: "what the shaman could not have known was this:",
  },
  {
    code: "meta_narrator_self_reference",
    pattern: /\bthe narrator will share what the log told her:/gi,
    replacement: "the gate log told her this:",
  },
  {
    code: "meta_narrator_self_reference",
    pattern: /\bThe narrator wants you to understand what the party saw:/g,
    replacement: "What the party saw was impossible:",
  },
  {
    code: "meta_narrator_self_reference",
    pattern: /\bThe narrator will tell you what the Association’s anomaly desk was learning at that exact moment, as a second flagged incident landed on the same one-day-old file:/g,
    replacement: "At that exact moment, as a second flagged incident landed on the same one-day-old file, the Association’s anomaly desk was learning this:",
  },
  {
    code: "meta_narrator_self_reference",
    pattern: /\bThe narrator swears this is true, because the news cameras caught all of it:/g,
    replacement: "The news cameras caught all of it:",
  },
  {
    code: "meta_narrator_self_reference",
    pattern: /\bThe narrator will describe what the drones recorded, because eleven million people would watch this clip by morning:/g,
    replacement: "The drones recorded what eleven million people would watch by morning:",
  },
  {
    code: "meta_narrator_self_reference",
    pattern: /\bThe narrator will give it to you in the rhythm the street heard it:/g,
    replacement: "The street heard it like this:",
  },
  {
    code: "meta_narrator_self_reference",
    pattern: /\bthe narrator confirms: nothing touched them\./gi,
    replacement: "the record confirms it: nothing touched them.",
  },
  {
    code: "meta_narrator_self_reference",
    pattern: /\bThe narrator will move fast now, the way the clips did\./g,
    replacement: "The clips moved fast now.",
  },
];

function targetedFindings(script) {
  const findings = [];
  for (const item of targetedPatterns) {
    for (const match of script.matchAll(item.pattern)) {
      findings.push({
        severity: "warning",
        code: item.code,
        line: lineNumberForIndex(script, match.index ?? 0),
        source_text: match[0],
        suggested_spoken_text: item.replacement,
        excerpt: excerptAround(script, match.index ?? 0, match[0].length),
        reason: "Explicit narrator self-reference sounds artificial when voiced literally; use direct narration in TTS only.",
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.source_text.localeCompare(b.source_text));
}

function replacementsFromFindings(findings) {
  return findings.map((finding) => ({
    from: finding.source_text,
    to: finding.suggested_spoken_text,
    regex: false,
    flags: "g",
    scope: "qwen_spoken_text",
    reason: finding.reason,
  }));
}

async function archiveFile(filePath, label) {
  if (!archiveExisting || !(existsSync(filePath))) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(episodeDir, "_archived_speakability", `${stamp}-${label}.json`);
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.copyFile(filePath, archivePath);
  return archivePath;
}

async function main() {
  if (!existsSync(scriptPath)) throw new Error(`Missing script_clean.md: ${scriptPath}`);
  const script = await fs.readFile(scriptPath, "utf8");
  const scriptHash = sha256(script);
  await requireApproval(scriptHash);
  const findings = targetedFindings(script);
  const replacements = replacementsFromFindings(findings);
  const archivedReport = await archiveFile(reportPath, "script_speakability_report");
  const archivedOverrides = await archiveFile(overridesPath, "tts_spoken_overrides");
  const updatedAt = new Date().toISOString();
  const report = {
    schema: "goldflow_script_speakability_report_v1",
    status: "passed",
    mode: "targeted_problem_areas_only",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    policy: "Targeted TTS-only problem-area replacements. Do not mutate script_clean.md, captions, semantic scenes, or visual prompts. Broad speakability is intentionally skipped.",
    planner: { provider: "deterministic_targeted", model: null, output_path: null },
    deterministic_risk_count: findings.length,
    deterministic_risks: findings,
    summary: `Targeted speakability found ${findings.length} narrator self-reference phrase(s).`,
    warnings: findings,
    pronunciation_map: [],
    pacing_notes: [],
    blocked_story_rewrite_requests: [],
    replacements,
    archived_previous_report_path: archivedReport,
    archived_previous_overrides_path: archivedOverrides,
    updated_at: updatedAt,
  };
  const overrides = {
    schema: "goldflow_tts_spoken_overrides_v1",
    status: "passed",
    mode: "targeted_problem_areas_only",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    apply_to: ["qwen_generation_plan.qwen_spoken_text"],
    script_text_policy: "Do not mutate script_clean.md, captions, semantic scenes, or visual prompts.",
    replacements,
    pronunciation_map: [],
    archived_previous_overrides_path: archivedOverrides,
    updated_at: updatedAt,
  };
  const problemReport = {
    schema: "goldflow_targeted_speakability_problem_areas_v1",
    status: "passed",
    scope: "meta_narrator_self_reference_only",
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    mutated_script: false,
    mutated_tts_overrides: true,
    finding_count: findings.length,
    findings,
    updated_at: updatedAt,
  };
  await writeJson(reportPath, report);
  await writeJson(overridesPath, overrides);
  await writeJson(problemReportPath, problemReport);
  console.log(JSON.stringify({
    status: "passed",
    mode: "targeted_problem_areas_only",
    report_path: reportPath,
    overrides_path: overridesPath,
    problem_report_path: problemReportPath,
    replacement_count: replacements.length,
    source_script_hash: scriptHash,
  }, null, 2));
}

main().catch(async (error) => {
  await writeJson(reportPath, { schema: "goldflow_script_speakability_report_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
