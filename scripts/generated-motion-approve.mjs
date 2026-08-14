#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GENERATED_MOTION_APPROVAL_SCHEMA,
  GENERATED_MOTION_REPORT_SCHEMA,
  requiredGeneratedMotionCoverageFindings,
} from "./lib/generated-motion-contract.mjs";
import { hashFile } from "./lib/ltx-video-contract.mjs";

const flags = parseFlags(process.argv.slice(2));
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.resolve(flags["episode-dir"] ?? path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode));
const motionDir = path.join(episodeDir, "assets", "motion", "generated");
const reportPath = path.resolve(flags.report ?? path.join(motionDir, `generated_motion_report_${episode}.json`));
const outputPath = path.resolve(flags.output ?? path.join(motionDir, `generated_motion_approval_${episode}.json`));

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[++index] : "true";
    parsed[key] = value;
  }
  return parsed;
}

function idSet(value) {
  return new Set(String(value ?? "").split(",").map((row) => row.trim()).filter(Boolean));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const report = await readJson(reportPath).catch(() => null);
  if (!report) {
    const legacyReportPath = path.join(episodeDir, "assets", "motion", "ltx23", `ltx_video_report_${episode}.json`);
    if (!await fs.stat(legacyReportPath).then((stat) => stat.isFile()).catch(() => false)) {
      throw new Error(`Generated-motion report is missing: ${reportPath}`);
    }
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "ltx-video-approve.mjs"), ...process.argv.slice(2)], {
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) reject(new Error(`Legacy LTX approval exited on ${signal}.`));
        else if (code !== 0) reject(new Error(`Legacy LTX approval exited ${code}.`));
        else resolve();
      });
    });
    return;
  }
  if (report?.schema !== GENERATED_MOTION_REPORT_SCHEMA || report?.status !== "passed") {
    throw new Error(`Generated-motion approval requires a passed generic report: ${reportPath}`);
  }
  const approve = idSet(flags["approve-ids"]);
  const reject = idSet(flags["reject-ids"] ?? flags["decline-ids"]);
  const clipId = (row) => String(row.candidate_id ?? row.image_id ?? "");
  const known = new Set((report.clips ?? []).map(clipId));
  for (const id of [...approve, ...reject]) if (!known.has(id)) throw new Error(`Unknown generated-motion candidate ${id}.`);
  for (const id of approve) if (reject.has(id)) throw new Error(`${id} cannot be accepted and rejected.`);
  const missing = [...known].filter((id) => !approve.has(id) && !reject.has(id));
  if (missing.length) throw new Error(`Every generated clip requires a decision. Missing: ${missing.join(", ")}`);
  const requiredGenerationFindings = requiredGeneratedMotionCoverageFindings(report);
  if (requiredGenerationFindings.length) {
    throw new Error(`Required opening Flow clips are missing: ${requiredGenerationFindings.map((row) => row.image_id).join(", ")}`);
  }
  const requiredImages = new Set((report.required_image_ids ?? []).map(String));
  const rejectedRequired = (report.clips ?? [])
    .filter((clip) => requiredImages.has(String(clip.image_id)) && reject.has(clipId(clip)))
    .map((clip) => String(clip.image_id));
  if (rejectedRequired.length) {
    throw new Error(`Required opening Flow clips cannot fall back to stills; repair these cuts instead: ${rejectedRequired.join(", ")}`);
  }
  const reviewer = String(flags.reviewer ?? "").trim();
  const note = String(flags.note ?? "").trim();
  if (!reviewer || !note) throw new Error("--reviewer and --note are required.");
  const decisions = [];
  const acceptedImages = new Set();
  for (const clip of report.clips ?? []) {
    if (await hashFile(clip.source_image_path) !== clip.source_image_sha256) throw new Error(`Source image is stale for ${clip.image_id}.`);
    if (await hashFile(clip.normalized_video_path) !== clip.normalized_video_sha256) throw new Error(`Video is stale for ${clip.image_id}.`);
    const id = clipId(clip);
    const accepted = approve.has(id);
    if (accepted && acceptedImages.has(String(clip.image_id))) throw new Error(`Only one generated clip may be accepted for ${clip.image_id}.`);
    if (accepted) acceptedImages.add(String(clip.image_id));
    decisions.push({
      image_id: clip.image_id,
      candidate_id: id,
      provider: clip.provider ?? report.provider,
      model_id: clip.model_id ?? report.model_id,
      decision: accepted ? "accepted" : "rejected",
      source_image_sha256: clip.source_image_sha256,
      video_sha256: clip.normalized_video_sha256,
      reviewer,
      note,
    });
  }
  const approval = {
    schema: GENERATED_MOTION_APPROVAL_SCHEMA,
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    report_path: reportPath,
    report_sha256: await hashFile(reportPath),
    production_eligible: report.proof !== true,
    accepted_count: decisions.filter((row) => row.decision === "accepted").length,
    rejected_count: decisions.filter((row) => row.decision === "rejected").length,
    decisions,
    reviewer,
    note,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, approval);
  console.log(JSON.stringify({ status: "passed", output_path: outputPath, accepted_count: approval.accepted_count, rejected_count: approval.rejected_count }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeJson(outputPath, { schema: GENERATED_MOTION_APPROVAL_SCHEMA, status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
