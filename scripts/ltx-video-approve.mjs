#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "./lib/ltx-video-contract.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.resolve(flags["episode-dir"] ?? path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode));
const proofLabel = cleanSlug(flags["proof-label"] ?? "ltx23-15-cut-proof");
const proof = boolFlag(flags["diagnostic-proof"] ?? flags.proof);
const outputDir = path.resolve(flags["output-dir"] ?? (proof
  ? path.join(episodeDir, "review_samples", proofLabel)
  : path.join(episodeDir, "assets", "motion", "ltx23")));
const reportPath = path.resolve(flags.report ?? path.join(outputDir, `ltx_video_report_${episode}${proof ? `-${proofLabel}` : ""}.json`));
const outputPath = path.resolve(flags.output ?? path.join(outputDir, `ltx_video_approval_${episode}${proof ? `-${proofLabel}` : ""}.json`));
const revalidateExisting = boolFlag(flags["revalidate-existing"]);

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

function cleanSlug(value) {
  return String(value ?? "proof").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "proof";
}

function ids(value) {
  return new Set(String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const report = await readJson(reportPath);
  if (report?.schema !== "goldflow_ltx23_video_report_v1" || report?.status !== "passed") {
    throw new Error(`LTX approval requires a passed generation report: ${reportPath}`);
  }
  if (revalidateExisting) {
    const existing = await readJson(outputPath);
    if (existing?.schema !== "goldflow_ltx23_video_approval_v1" || existing?.status !== "passed") {
      throw new Error(`LTX approval revalidation requires an existing passed approval: ${outputPath}`);
    }
    if (report.timing_revalidated_without_provider_submission !== true
      || Number(report.generation_requests_submitted) !== 0
      || Number(report.creative_resubmission_count) !== 0
      || existing.report_sha256 !== report.timing_revalidated_from_report_sha256) {
      throw new Error("LTX approval revalidation requires the exact zero-submit timing-revalidation chain.");
    }
    const decisionId = (row) => String(row.candidate_id ?? row.image_id ?? "");
    const clips = Array.isArray(report.clips) ? report.clips : [];
    const decisions = Array.isArray(existing.decisions) ? existing.decisions : [];
    const decisionById = new Map(decisions.map((row) => [decisionId(row), row]));
    if (decisionById.size !== decisions.length || decisions.length !== clips.length) {
      throw new Error("LTX approval revalidation decision identities no longer exactly cover generated clips.");
    }
    for (const clip of clips) {
      const id = decisionId(clip);
      const decision = decisionById.get(id);
      if (!decision || !["accepted", "rejected"].includes(String(decision.decision ?? ""))) {
        throw new Error(`LTX approval revalidation is missing a valid preserved decision for ${id}.`);
      }
      if (decision.image_id !== clip.image_id
        || decision.source_image_sha256 !== clip.source_image_sha256
        || decision.video_sha256 !== clip.normalized_video_sha256
        || await hashFile(clip.source_image_path) !== clip.source_image_sha256
        || await hashFile(clip.normalized_video_path) !== clip.normalized_video_sha256) {
        throw new Error(`LTX approval revalidation creative/media hash mismatch for ${id}.`);
      }
    }
    const revalidated = {
      ...existing,
      report_path: reportPath,
      report_sha256: await hashFile(reportPath),
      contact_sheet_path: report.contact_sheet_path ?? null,
      accepted_count: decisions.filter((row) => row.decision === "accepted").length,
      rejected_count: decisions.filter((row) => row.decision === "rejected").length,
      decisions,
      timing_revalidated_without_review_change: true,
      timing_revalidated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await writeJson(outputPath, revalidated);
    console.log(JSON.stringify({
      status: revalidated.status,
      output_path: outputPath,
      accepted_count: revalidated.accepted_count,
      rejected_count: revalidated.rejected_count,
      timing_revalidated_without_review_change: true,
    }, null, 2));
    return;
  }
  const approveIds = ids(flags["approve-ids"]);
  const rejectIds = ids(flags["reject-ids"] ?? flags["decline-ids"]);
  const decisionId = (row) => String(row.candidate_id ?? row.image_id ?? "");
  const known = new Set((report.clips ?? []).map(decisionId));
  for (const id of [...approveIds, ...rejectIds]) {
    if (!known.has(id)) throw new Error(`Unknown LTX clip id in approval flags: ${id}`);
  }
  for (const id of approveIds) {
    if (rejectIds.has(id)) throw new Error(`LTX clip ${id} cannot be both approved and rejected.`);
  }
  const missing = [...known].filter((id) => !approveIds.has(id) && !rejectIds.has(id));
  if (missing.length) throw new Error(`Every LTX clip requires a decision. Missing: ${missing.join(", ")}`);
  const reviewer = String(flags.reviewer ?? "").trim();
  const note = String(flags.note ?? "").trim();
  if (!reviewer || !note) throw new Error("--reviewer and --note are required.");
  const decisions = [];
  const acceptedImages = new Set();
  for (const clip of report.clips ?? []) {
    if (await hashFile(clip.source_image_path) !== clip.source_image_sha256) {
      throw new Error(`Source image is stale for ${clip.image_id}.`);
    }
    if (await hashFile(clip.normalized_video_path) !== clip.normalized_video_sha256) {
      throw new Error(`Normalized video is stale for ${clip.image_id}.`);
    }
    const id = decisionId(clip);
    const accepted = approveIds.has(id);
    if (accepted && acceptedImages.has(String(clip.image_id))) {
      throw new Error(`Only one LTX candidate may be accepted for ${clip.image_id}.`);
    }
    if (accepted) acceptedImages.add(String(clip.image_id));
    decisions.push({
      image_id: clip.image_id,
      candidate_id: clip.candidate_id ?? clip.image_id,
      decision: accepted ? "accepted" : "rejected",
      source_image_sha256: clip.source_image_sha256,
      video_sha256: clip.normalized_video_sha256,
      reviewer,
      note,
    });
  }
  const approval = {
    schema: "goldflow_ltx23_video_approval_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    proof: Boolean(report.proof),
    proof_label: report.proof_label ?? null,
    production_eligible: !report.proof,
    report_path: reportPath,
    report_sha256: await hashFile(reportPath),
    contact_sheet_path: report.contact_sheet_path ?? null,
    accepted_count: decisions.filter((row) => row.decision === "accepted").length,
    rejected_count: decisions.filter((row) => row.decision === "rejected").length,
    decisions,
    reviewer,
    note,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, approval);
  console.log(JSON.stringify({
    status: approval.status,
    output_path: outputPath,
    accepted_count: approval.accepted_count,
    rejected_count: approval.rejected_count,
    production_eligible: approval.production_eligible,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    if (!revalidateExisting) {
      await writeJson(outputPath, {
        schema: "goldflow_ltx23_video_approval_v1",
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
