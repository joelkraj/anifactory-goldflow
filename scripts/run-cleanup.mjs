#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = flags.episodeDir
  ?? flags["episode-dir"]
  ?? path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const apply = flags.apply === "true";
const includeArchives = flags["include-archives"] === "true";

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

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function dirExists(dirPath) {
  return Boolean(dirPath) && fs.stat(dirPath).then((stat) => stat.isDirectory()).catch(() => false);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function sizeBytes(filePath) {
  return fs.stat(filePath).then((stat) => stat.size).catch(() => 0);
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}

async function latestReport() {
  const entries = await fs.readdir(episodeDir).catch(() => []);
  const reports = [];
  for (const name of entries) {
    if (!new RegExp(`^longform_audio_bed_report_${episode}.*\\.json$`).test(name)) continue;
    const filePath = path.join(episodeDir, name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat) reports.push({ name, filePath, mtimeMs: stat.mtimeMs });
  }
  return reports.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

async function collectLongformWavPruneCandidate() {
  const latest = await latestReport();
  if (!latest) return [];
  const report = await readJson(latest.filePath, null);
  if (!report) return [];
  const narrationOnly = report.narration_only === true
    || report.audio_design_enabled === false
    || report.mix?.narration_only === true
    || report.mix?.audio_design_enabled === false;
  const m4aPath = report.mix?.m4a_path ?? report.final_m4a_path ?? report.output_m4a_path ?? null;
  const wavPath = report.mix?.wav_path ?? null;
  if (!narrationOnly || !wavPath || !(await exists(wavPath)) || !(await exists(m4aPath))) return [];
  return [{
    type: "narrator_only_longform_intermediate_wav",
    path: wavPath,
    size_bytes: await sizeBytes(wavPath),
    report_path: latest.filePath,
    replacement_path: m4aPath,
  }];
}

async function collectArchiveCandidates() {
  if (!includeArchives) return [];
  const entries = await fs.readdir(episodeDir, { withFileTypes: true }).catch(() => []);
  const archiveNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^_(?:rerun_from_|relocation_stale_episode_artifacts)/.test(name));
  const candidates = [];
  for (const name of archiveNames) {
    const dirPath = path.join(episodeDir, name);
    if (!(await dirExists(dirPath))) continue;
    candidates.push({
      type: "stale_episode_archive",
      path: dirPath,
      size_bytes: 0,
      report_path: null,
      replacement_path: null,
    });
  }
  return candidates;
}

async function collectLegacyFishArtifactCandidates() {
  const voiceReferencePath = path.join(episodeDir, "voice_reference_completeness_report.json");
  const qwenPlanPath = path.join(episodeDir, "qwen_generation_plan.json");
  if (!(await exists(voiceReferencePath)) || !(await exists(qwenPlanPath))) return [];
  const qwenPlan = await readJson(qwenPlanPath, null);
  const voiceReference = await readJson(voiceReferencePath, null);
  const qwenActive = /qwen/i.test(String(qwenPlan?.provider ?? qwenPlan?.tts_provider ?? voiceReference?.tts_provider ?? ""));
  if (!qwenActive && !qwenPlan?.segments?.length) return [];
  const names = [
    "fish_reference_requirements_report.json",
    `narration_fish_performance_${episode}.txt`,
    `narration_fish_stripped_${episode}.txt`,
    `narration_fish_diff_${episode}.json`,
    "narration_fish_performance_ep_01.txt",
    "narration_fish_stripped_ep_01.txt",
    "narration_fish_diff_ep_01.json",
  ];
  const candidates = [];
  const seen = new Set();
  for (const name of names) {
    const filePath = path.join(episodeDir, name);
    if (seen.has(filePath) || !(await exists(filePath))) continue;
    seen.add(filePath);
    candidates.push({
      type: "legacy_fish_voice_artifact_for_qwen_run",
      path: filePath,
      size_bytes: await sizeBytes(filePath),
      report_path: voiceReferencePath,
      replacement_path: voiceReferencePath,
    });
  }
  return candidates;
}

async function applyCandidate(candidate) {
  if (candidate.type === "narrator_only_longform_intermediate_wav") {
    const report = await readJson(candidate.report_path, null);
    await fs.rm(candidate.path, { force: true });
    if (report?.mix?.wav_path === candidate.path) {
      report.mix.intermediate_wav_path = candidate.path;
      report.mix.intermediate_wav_deleted = true;
      report.mix.wav_path = null;
      report.updated_at = new Date().toISOString();
      await writeJson(candidate.report_path, report);
    }
    return;
  }
  if (candidate.type === "stale_episode_archive") {
    await fs.rm(candidate.path, { recursive: true, force: true });
    return;
  }
  if (candidate.type === "legacy_fish_voice_artifact_for_qwen_run") {
    await fs.rm(candidate.path, { force: true });
  }
}

async function main() {
  const candidates = [
    ...(await collectLongformWavPruneCandidate()),
    ...(await collectLegacyFishArtifactCandidates()),
    ...(await collectArchiveCandidates()),
  ];
  let reclaimed = 0;
  const actions = [];
  for (const candidate of candidates) {
    reclaimed += Number(candidate.size_bytes ?? 0);
    if (apply) await applyCandidate(candidate);
    actions.push({
      ...candidate,
      size: candidate.size_bytes ? formatBytes(candidate.size_bytes) : null,
      action: apply ? "deleted" : "would_delete",
    });
  }
  console.log(JSON.stringify({
    status: "passed",
    mode: apply ? "apply" : "dry_run",
    episode_dir: episodeDir,
    candidate_count: candidates.length,
    reclaimable_bytes: reclaimed,
    reclaimable: formatBytes(reclaimed),
    actions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
