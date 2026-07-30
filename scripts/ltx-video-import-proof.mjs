#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LTX_VIDEO_MODEL_ID,
  LTX_VIDEO_PROVIDER,
  hashFile,
} from "./lib/ltx-video-contract.mjs";

const flags = parseFlags(process.argv.slice(2));
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.resolve(flags["episode-dir"] ?? path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode));
const outputDir = path.resolve(flags["output-dir"] ?? path.join(episodeDir, "assets", "motion", "ltx23"));
const outputPath = path.resolve(flags.output ?? path.join(outputDir, `ltx_video_report_${episode}.json`));
const triagePath = path.resolve(flags["triage-output"] ?? path.join(episodeDir, `manual_blocker_triage_generated_video_motion_${episode}.json`));

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

function boolFlag(value) {
  return /^(true|1|yes)$/i.test(String(value ?? "false"));
}

function listFlag(value) {
  return String(value ?? "").split(",").map((row) => row.trim()).filter(Boolean).map((row) => path.resolve(row));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  if (!boolFlag(flags["confirm-production-promotion"])) {
    throw new Error("--confirm-production-promotion true is required to promote reviewed diagnostic clips.");
  }
  const reviewer = String(flags.reviewer ?? "").trim();
  const note = String(flags.note ?? "").trim();
  if (!reviewer || !note) throw new Error("--reviewer and --note are required.");
  const reportPaths = listFlag(flags.reports ?? flags["proof-reports"]);
  if (!reportPaths.length) throw new Error("--reports requires one or more comma-separated proof report paths.");

  const reports = await Promise.all(reportPaths.map(readJson));
  const clips = [];
  const seenCandidates = new Set();
  for (let index = 0; index < reports.length; index += 1) {
    const report = reports[index];
    const reportPath = reportPaths[index];
    if (report?.schema !== "goldflow_ltx23_video_report_v1" || report?.status !== "passed" || report?.proof !== true) {
      throw new Error(`Promotion requires a passed diagnostic proof report: ${reportPath}`);
    }
    if (report.model_id !== LTX_VIDEO_MODEL_ID || report.provider !== LTX_VIDEO_PROVIDER) {
      throw new Error(`Unexpected provider/model in ${reportPath}.`);
    }
    if (report.episode !== episode) throw new Error(`Episode mismatch in ${reportPath}.`);
    for (const clip of report.clips ?? []) {
      const candidateId = String(clip.candidate_id ?? clip.image_id ?? "");
      if (!candidateId || seenCandidates.has(candidateId)) throw new Error(`Missing or duplicate candidate id ${candidateId || "<empty>"}.`);
      if (clip.status !== "generated") throw new Error(`Only generated clips may be promoted: ${candidateId}.`);
      if (await hashFile(clip.source_image_path) !== clip.source_image_sha256) throw new Error(`Stale source image for ${candidateId}.`);
      if (await hashFile(clip.normalized_video_path) !== clip.normalized_video_sha256) throw new Error(`Stale normalized video for ${candidateId}.`);
      seenCandidates.add(candidateId);
      clips.push(clip);
    }
  }

  clips.sort((left, right) => Number(left.start_sec ?? 0) - Number(right.start_sec ?? 0));
  const sourceReports = await Promise.all(reportPaths.map(async (reportPath) => ({
    path: reportPath,
    sha256: await hashFile(reportPath),
  })));
  const report = {
    schema: "goldflow_ltx23_video_report_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    proof: false,
    proof_label: null,
    production_promotion: {
      mode: "reviewed_diagnostic_proof_import",
      source_reports: sourceReports,
      reviewer,
      note,
    },
    provider: LTX_VIDEO_PROVIDER,
    model_id: LTX_VIDEO_MODEL_ID,
    generated_count: clips.length,
    failed_count: 0,
    clip_count: clips.length,
    clips,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  await writeJson(triagePath, {
    schema: "goldflow_manual_blocker_triage_v1",
    status: "passed",
    stage: "generated_video_motion",
    episode,
    disposition: "promote_hash_verified_proof_clips_for_existing_run",
    source_reports: sourceReports,
    promoted_report_path: outputPath,
    promoted_report_sha256: await hashFile(outputPath),
    evidence_reviewed: [
      "Every promoted source image still matches its recorded SHA-256.",
      "Every normalized LTX 2.3 clip still matches its recorded SHA-256.",
      "Per-clip human acceptance remains required in the production approval artifact.",
    ],
    reviewer,
    note,
    updated_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({
    status: "passed",
    output_path: outputPath,
    triage_path: triagePath,
    clip_count: clips.length,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
