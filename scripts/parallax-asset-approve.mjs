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
  if (!Number(report.candidate_count ?? 0)) throw new Error("No parallax candidates require approval; use the recorded no-suitable waiver.");
  const reviewer = String(flags.reviewer ?? "").trim();
  const note = String(flags.note ?? "").trim();
  if (!reviewer || !note) throw new Error("Parallax approval requires --reviewer and --note.");
  const candidateIds = new Set((report.candidates ?? []).map((row) => String(row.image_id)));
  const approvedIds = new Set(isTrue(flags["approve-all"]) ? [...candidateIds] : parseList(flags["approve-ids"]));
  const declinedIds = new Set(parseList(flags["decline-ids"]));
  const overlap = [...approvedIds].filter((id) => declinedIds.has(id));
  if (overlap.length) throw new Error(`Parallax ids cannot be both approved and declined: ${overlap.join(", ")}`);
  const unknown = [...new Set([...approvedIds, ...declinedIds])].filter((id) => !candidateIds.has(id));
  if (unknown.length) throw new Error(`Unknown parallax candidate ids: ${unknown.join(", ")}`);
  const undecided = [...candidateIds].filter((id) => !approvedIds.has(id) && !declinedIds.has(id));
  if (undecided.length) throw new Error(`Every parallax candidate requires an explicit approved or declined decision: ${undecided.join(", ")}`);
  const decisions = (report.candidates ?? []).map((candidate) => ({
    image_id: candidate.image_id,
    image_sha256: candidate.image_sha256,
    decision: approvedIds.has(candidate.image_id) ? "approved" : "declined",
    asset_report_path: candidate.asset_report_path,
    mask_sha256: candidate.asset_report?.mask_sha256 ?? null,
    foreground_sha256: candidate.asset_report?.foreground_sha256 ?? null,
    background_sha256: candidate.asset_report?.background_sha256 ?? null,
  }));
  const approval = {
    schema: "goldflow_parallax_asset_approval_v1",
    status: "approved",
    asset_report_path: reportPath,
    asset_report_sha256: await sha256File(reportPath),
    asset_contract_sha256: parallaxAssetContractSha256(report),
    reviewer,
    note,
    approved_image_ids: [...approvedIds],
    declined_image_ids: [...declinedIds],
    decisions,
    approved_at: new Date().toISOString(),
  };
  await writeJson(outputPath, approval);
  console.log(JSON.stringify({ status: "approved", output_path: outputPath, approved_count: approvedIds.size, declined_count: declinedIds.size }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
