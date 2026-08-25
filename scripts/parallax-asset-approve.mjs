#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib/file-hash.mjs";
import { parallaxAssetContractSha256 } from "./lib/parallax-contract.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));

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

function parseList(value) {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function isTrue(value) {
  return /^(true|1|yes)$/i.test(String(value ?? ""));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const channel = flags.channel ?? "53rebirth";
  const week = flags.week ?? "current";
  const episode = flags.episode ?? "ep_01";
  const episodeDir = flags["episode-dir"]
    ? path.resolve(flags["episode-dir"])
    : path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
  const reportPath = path.resolve(flags.report ?? path.join(episodeDir, `parallax_asset_report_${episode}.json`));
  const outputPath = path.resolve(flags.output ?? path.join(episodeDir, `parallax_asset_approval_${episode}.json`));
  const report = await readJson(reportPath);
  if (report?.status !== "passed") throw new Error("Parallax asset report must pass before approval.");
  if (!Number(report.candidate_count ?? 0)) {
    throw new Error("No parallax candidates require approval; the accepted still/single-plane fallback is already complete.");
  }
  const agentReview = isTrue(flags["agent-review"]);
  const reviewer = String(flags.reviewer ?? (agentReview ? "codex-agent" : "")).trim();
  const note = String(flags.note ?? (agentReview
    ? "Agent applied the hash-bound local separation classification; strong layers approved, marginal layers limited to low motion, and unsafe layers declined without retry."
    : "")).trim();
  if (!reviewer || !note) throw new Error("Parallax approval requires --reviewer and --note.");
  const candidateIds = new Set((report.candidates ?? []).map((row) => String(row.image_id)));
  const agentDisposition = new Map((report.candidates ?? []).map((candidate) => [
    String(candidate.image_id),
    String(candidate.separation_evidence_classification?.recommended_disposition ?? "declined"),
  ]));
  const approvedIds = new Set(agentReview
    ? [...agentDisposition].filter(([, disposition]) => disposition === "approved").map(([id]) => id)
    : isTrue(flags["approve-all"]) ? [...candidateIds] : parseList(flags["approve-ids"]));
  const approvedLowMotionIds = new Set(agentReview
    ? [...agentDisposition].filter(([, disposition]) => disposition === "approved_low_motion").map(([id]) => id)
    : parseList(flags["approved-low-motion-ids"]));
  const repairableIds = new Set(agentReview
    ? []
    : parseList(flags["repairable-ids"]));
  const declinedIds = new Set(agentReview
    ? [...agentDisposition].filter(([, disposition]) => !["approved", "approved_low_motion"].includes(disposition)).map(([id]) => id)
    : parseList(flags["decline-ids"]));
  const dispositionSets = [approvedIds, approvedLowMotionIds, repairableIds, declinedIds];
  const overlap = [...candidateIds].filter((id) => dispositionSets.filter((set) => set.has(id)).length > 1);
  if (overlap.length) throw new Error(`Parallax ids can have only one disposition: ${overlap.join(", ")}`);
  const unknown = [...new Set(dispositionSets.flatMap((set) => [...set]))].filter((id) => !candidateIds.has(id));
  if (unknown.length) throw new Error(`Unknown parallax candidate ids: ${unknown.join(", ")}`);
  const undecided = [...candidateIds].filter((id) => dispositionSets.every((set) => !set.has(id)));
  if (undecided.length) throw new Error(`Every parallax candidate requires approved, approved_low_motion, repairable, or declined: ${undecided.join(", ")}`);
  const decisions = (report.candidates ?? []).map((candidate) => ({
    image_id: candidate.image_id,
    image_sha256: candidate.image_sha256,
    decision: approvedIds.has(candidate.image_id)
      ? "approved"
      : approvedLowMotionIds.has(candidate.image_id)
        ? "approved_low_motion"
        : repairableIds.has(candidate.image_id)
          ? "repairable"
          : "declined",
    asset_report_path: candidate.asset_report_path,
    mask_sha256: candidate.asset_report?.mask_sha256 ?? null,
    foreground_sha256: candidate.asset_report?.foreground_sha256 ?? null,
    background_sha256: candidate.asset_report?.background_sha256 ?? null,
  }));
  const approval = {
    schema: "goldflow_parallax_asset_approval_v2",
    status: "approved",
    asset_report_path: reportPath,
    asset_report_sha256: await sha256File(reportPath),
    asset_contract_sha256: parallaxAssetContractSha256(report),
    reviewer,
    note,
    review_mode: agentReview ? "agent_local_separation_policy" : "human_review",
    approved_image_ids: [...approvedIds],
    approved_low_motion_image_ids: [...approvedLowMotionIds],
    repairable_image_ids: [...repairableIds],
    declined_image_ids: [...declinedIds],
    decisions,
    approved_at: new Date().toISOString(),
  };
  await writeJson(outputPath, approval);
  console.log(JSON.stringify({
    status: "approved",
    output_path: outputPath,
    approved_count: approvedIds.size,
    approved_low_motion_count: approvedLowMotionIds.size,
    repairable_count: repairableIds.size,
    declined_count: declinedIds.size,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
