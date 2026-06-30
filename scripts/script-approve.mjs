#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { scanScriptMetaContamination } from "./lib/script-meta-contamination-scan.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const scriptPath = path.join(episodeDir, "script_clean.md");

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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const script = await fs.readFile(scriptPath, "utf8");
  const scriptHash = sha256(script);
  const expectedHash = flags.hash ?? flags["script-hash"] ?? null;
  if (expectedHash && expectedHash !== scriptHash) {
    throw new Error(`Refusing approval: expected hash ${expectedHash}, current script hash is ${scriptHash}.`);
  }
  const metaScan = {
    ...scanScriptMetaContamination(script),
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    updated_at: new Date().toISOString(),
  };
  await writeJson(path.join(episodeDir, "script_meta_contamination_report.json"), metaScan);
  if (metaScan.status !== "passed" && flags["allow-script-meta-contamination"] !== "true") {
    const preview = metaScan.blockers.slice(0, 5).map((row) => `${row.code} line ${row.line}: ${row.match}`).join("; ");
    throw new Error(`Refusing approval: script contains production/meta narration contamination (${preview}). Fix script_clean.md or pass --allow-script-meta-contamination true only for explicit diagnostic approval.`);
  }
  const approvedAt = new Date().toISOString();
  const base = {
    channel,
    series_slug: series,
    week,
    episode,
    script_clean_path: scriptPath,
    script_clean_hash: scriptHash,
    script_hash: scriptHash,
    source_hash: scriptHash,
    source_script_hash: scriptHash,
    approved: true,
    operator_approved: true,
    status: "approved",
    updated_at: approvedAt,
  };
  const manualReview = {
    schema: "goldflow_manual_agent_script_review_v1",
    ...base,
    manual_agent_script_review: true,
    review_summary: flags.summary ?? "Operator confirmed script_clean.md is approved for production.",
  };
  const operatorApproval = {
    schema: "goldflow_operator_script_approval_v1",
    ...base,
    approval_status: "operator_approved",
    approval_scope: "exact_script_hash",
  };
  const scriptLock = {
    schema: "goldflow_script_lock_v1",
    ...base,
    status: "script_locked",
  };
  await writeJson(path.join(episodeDir, "manual_agent_script_review.json"), manualReview);
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), operatorApproval);
  await writeJson(path.join(episodeDir, "script_lock.json"), scriptLock);
  console.log(JSON.stringify({ status: "approved", script_clean_hash: scriptHash, files_written: ["script_meta_contamination_report.json", "manual_agent_script_review.json", "operator_script_approval.json", "script_lock.json"] }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
