#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTargetedSpeakabilityArtifacts } from "./lib/script-speakability-targeted.mjs";

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

// The homograph rules (and nothing story-specific) live in scripts/lib/script-speakability-targeted.mjs;
// the same builder runs inside the folded script lock on registry ≥ 2026-10-20.1 identities.

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
  const archivedReport = await archiveFile(reportPath, "script_speakability_report");
  const archivedOverrides = await archiveFile(overridesPath, "tts_spoken_overrides");
  const { report, overrides, problemReport, replacements } = buildTargetedSpeakabilityArtifacts({
    script,
    scriptPath,
    scriptHash,
    channel,
    series,
    week,
    episode,
    archivedReportPath: archivedReport,
    archivedOverridesPath: archivedOverrides,
  });
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
