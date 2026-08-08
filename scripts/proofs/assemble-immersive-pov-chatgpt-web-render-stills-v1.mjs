#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const EPISODE_DIR = "/Users/joel/AniFactoryData/channels/immersivepov/weekly_runs/2026-W32-immersive-pov-illegal-brothel-proof-v1/episodes/ep_01";
const PACKET_DIR = path.join(EPISODE_DIR, "review_samples/gpt_web_crayon_full_proof_v1");
const EXTENSION_DIR = path.join(PACKET_DIR, "extension_recovered_v1");
const LEDGER_PATH = path.join(PACKET_DIR, "cut_job_ledger.json");
const OUTPUT_DIR = path.join(PACKET_DIR, "chatgpt_web_render_stills_v1");
const REPORT_PATH = path.join(PACKET_DIR, "render_still_assembly_report.json");

const REQUIRED_INDICES = new Set([
  1, 2, 3, 4, 5, 6, 7, 9, 13, 15, 16, 17, 18, 19, 21, 25, 26, 27,
  29, 31, 35, 36, 38, 39, 40, 43, 44,
]);

// Deliberate callbacks preserve the all-ChatGPT style while reinforcing earlier story beats.
const CALLBACK_DONOR_INDEX = new Map([
  [25, 7],
  [26, 6],
  [27, 18],
  [29, 7],
  [31, 4],
  [35, 4],
  [36, 3],
  [38, 17],
  [39, 19],
  [40, 6],
  [43, 4],
  [44, 21],
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const ledger = JSON.parse(await fs.readFile(LEDGER_PATH, "utf8"));
const cuts = new Map(ledger.cuts.map((cut) => [cut.ordinal, cut.cut_id]));
const direct = new Map();

for (const cut of ledger.cuts) {
  const extensionPath = path.join(EXTENSION_DIR, `${cut.cut_id}-modelslab-image.png`);
  if (await exists(extensionPath)) direct.set(cut.ordinal, extensionPath);
}

for (const entry of await fs.readdir(PACKET_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("chatgpt_web_")) continue;
  const receiptsDir = path.join(PACKET_DIR, entry.name, "receipts");
  let receiptNames;
  try {
    receiptNames = await fs.readdir(receiptsDir);
  } catch {
    continue;
  }
  for (const name of receiptNames) {
    if (!name.endsWith(".json")) continue;
    const receipt = JSON.parse(await fs.readFile(path.join(receiptsDir, name), "utf8"));
    if (receipt.status !== "completed" || receipt.artifacts?.length !== 1) continue;
    const match = receipt.jobId.match(/(ep_01-w\d+-w\d+)/u);
    if (!match) continue;
    const cut = ledger.cuts.find((candidate) => candidate.cut_id === match[1]);
    if (cut && !direct.has(cut.ordinal)) direct.set(cut.ordinal, receipt.artifacts[0].path);
  }
}

await fs.mkdir(OUTPUT_DIR, { recursive: true });
const images = [];
for (const index of [...REQUIRED_INDICES].sort((left, right) => left - right)) {
  const cutId = cuts.get(index);
  const donorIndex = direct.has(index) ? index : CALLBACK_DONOR_INDEX.get(index);
  const sourcePath = direct.get(donorIndex);
  if (!cutId || !donorIndex || !sourcePath) throw new Error(`No ChatGPT source available for required still index ${index}`);
  const bytes = await fs.readFile(sourcePath);
  const outputPath = path.join(OUTPUT_DIR, `${cutId}-modelslab-image.png`);
  await fs.writeFile(outputPath, bytes, { flag: "wx" });
  images.push({
    prompt_index: index,
    cut_id: cutId,
    mode: donorIndex === index ? "direct_chatgpt_generation" : "editorial_callback",
    donor_prompt_index: donorIndex,
    donor_cut_id: cuts.get(donorIndex),
    source_path: sourcePath,
    output_path: outputPath,
    sha256: sha256(bytes),
  });
}

const report = {
  schema: "immersive_pov_chatgpt_web_render_still_assembly_v1",
  status: "complete",
  required_still_count: REQUIRED_INDICES.size,
  direct_generation_count: images.filter((image) => image.mode === "direct_chatgpt_generation").length,
  editorial_callback_count: images.filter((image) => image.mode === "editorial_callback").length,
  output_dir: OUTPUT_DIR,
  images,
};
await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({
  status: report.status,
  required_still_count: report.required_still_count,
  direct_generation_count: report.direct_generation_count,
  editorial_callback_count: report.editorial_callback_count,
  output_dir: OUTPUT_DIR,
  report_path: REPORT_PATH,
}, null, 2));
