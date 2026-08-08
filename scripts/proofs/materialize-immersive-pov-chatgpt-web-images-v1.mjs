#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const EPISODE_DIR = "/Users/joel/AniFactoryData/channels/immersivepov/weekly_runs/2026-W32-immersive-pov-illegal-brothel-proof-v1/episodes/ep_01";
const PACKET_DIR = path.join(EPISODE_DIR, "review_samples/gpt_web_crayon_full_proof_v1");
const LEDGER_PATH = path.join(PACKET_DIR, "cut_job_ledger.json");
const OUTPUT_DIR = path.join(PACKET_DIR, "chatgpt_web_stills_v1");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const ledger = JSON.parse(await fs.readFile(LEDGER_PATH, "utf8"));
const expectedCuts = new Set(ledger.cuts.map((cut) => cut.cut_id));
const runEntries = await fs.readdir(PACKET_DIR, { withFileTypes: true });
const receiptPaths = [];
for (const entry of runEntries) {
  if (!entry.isDirectory() || !entry.name.startsWith("chatgpt_web_")) continue;
  const receiptsDir = path.join(PACKET_DIR, entry.name, "receipts");
  let receiptNames;
  try {
    receiptNames = await fs.readdir(receiptsDir);
  } catch {
    continue;
  }
  for (const name of receiptNames) {
    if (name.endsWith(".json")) receiptPaths.push(path.join(receiptsDir, name));
  }
}

const accepted = new Map();
for (const receiptPath of receiptPaths.sort()) {
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  if (receipt.status !== "completed" || receipt.artifacts?.length !== 1) continue;
  const match = receipt.jobId.match(/(ep_01-w\d+-w\d+)/u);
  if (!match || !expectedCuts.has(match[1])) continue;
  if (accepted.has(match[1])) throw new Error(`Multiple completed ChatGPT images exist for ${match[1]}`);
  const artifact = receipt.artifacts[0];
  const bytes = await fs.readFile(artifact.path);
  if (sha256(bytes) !== artifact.sha256) throw new Error(`Artifact hash mismatch for ${match[1]}`);
  if (artifact.width / artifact.height < 1.72 || artifact.width / artifact.height > 1.83) {
    throw new Error(`Unexpected aspect ratio for ${match[1]}: ${artifact.width}x${artifact.height}`);
  }
  accepted.set(match[1], { receiptPath, receipt, artifact, bytes });
}

await fs.mkdir(OUTPUT_DIR, { recursive: true });
const materialized = [];
for (const cut of ledger.cuts) {
  const source = accepted.get(cut.cut_id);
  if (!source) continue;
  const outputPath = path.join(OUTPUT_DIR, `${cut.cut_id}-modelslab-image.png`);
  await fs.writeFile(outputPath, source.bytes, { flag: "wx" });
  materialized.push({
    cut_id: cut.cut_id,
    output_path: outputPath,
    sha256: source.artifact.sha256,
    width: source.artifact.width,
    height: source.artifact.height,
    receipt_path: source.receiptPath,
    conversation_url: source.artifact.conversationUrl,
  });
}

const missing = ledger.cuts.map((cut) => cut.cut_id).filter((cutId) => !accepted.has(cutId));
const report = {
  schema: "immersive_pov_chatgpt_web_still_materialization_v1",
  status: missing.length === 0 ? "complete" : "incomplete",
  expected_cut_count: ledger.cut_count,
  materialized_cut_count: materialized.length,
  missing_cut_ids: missing,
  output_dir: OUTPUT_DIR,
  images: materialized,
};
await fs.writeFile(path.join(PACKET_DIR, "materialization_report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(report, null, 2));

if (missing.length > 0) process.exitCode = 2;
