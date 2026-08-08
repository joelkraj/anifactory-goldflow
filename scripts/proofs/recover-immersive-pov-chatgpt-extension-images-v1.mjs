#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const EPISODE_DIR = "/Users/joel/AniFactoryData/channels/immersivepov/weekly_runs/2026-W32-immersive-pov-illegal-brothel-proof-v1/episodes/ep_01";
const FIRST_DIR = path.join(EPISODE_DIR, "review_samples/gpt_crayon_style_first10_v1/generated");
const REMAINING_MANIFEST = path.join(EPISODE_DIR, "review_samples/gpt_crayon_style_full_proof_v1/remaining_37_manifest.json");
const DOWNLOAD_DIR = "/Users/joel/Downloads/ChatGPT-Auto";
const OUTPUT_DIR = path.join(EPISODE_DIR, "review_samples/gpt_web_crayon_full_proof_v1/extension_recovered_v1");
const REPORT_PATH = path.join(EPISODE_DIR, "review_samples/gpt_web_crayon_full_proof_v1/extension_recovery_report.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const firstNames = (await fs.readdir(FIRST_DIR)).filter((name) => name.endsWith(".png")).sort();
if (firstNames.length !== 9) throw new Error(`Expected 9 named first-batch images, found ${firstNames.length}`);

const remaining = JSON.parse(await fs.readFile(REMAINING_MANIFEST, "utf8"));
const continuationCutIds = remaining.cuts.slice(0, 9).map((cut) => cut.image_id);
const downloadEntries = [];
for (const name of await fs.readdir(DOWNLOAD_DIR)) {
  if (!name.endsWith(".png") || !name.startsWith("2026-08-06_14-")) continue;
  const sourcePath = path.join(DOWNLOAD_DIR, name);
  const stat = await fs.stat(sourcePath);
  downloadEntries.push({ name, sourcePath, mtimeMs: stat.mtimeMs });
}
downloadEntries.sort((left, right) => left.mtimeMs - right.mtimeMs);
if (downloadEntries.length !== 9) {
  throw new Error(`Expected 9 continuation downloads from the extension run, found ${downloadEntries.length}`);
}

const sources = [
  ...firstNames.map((name) => ({
    cutId: name.replace(/^\d+-/u, "").replace(/\.png$/u, ""),
    sourcePath: path.join(FIRST_DIR, name),
    provenance: "approved_first_nine_extension_run",
  })),
  ...downloadEntries.map((entry, index) => ({
    cutId: continuationCutIds[index],
    sourcePath: entry.sourcePath,
    provenance: "recovered_continuation_extension_download",
  })),
];

await fs.mkdir(OUTPUT_DIR, { recursive: true });
const images = [];
for (const source of sources) {
  const bytes = await fs.readFile(source.sourcePath);
  const targetPath = path.join(OUTPUT_DIR, `${source.cutId}-modelslab-image.png`);
  await fs.writeFile(targetPath, bytes, { flag: "wx" });
  images.push({
    cut_id: source.cutId,
    source_path: source.sourcePath,
    output_path: targetPath,
    sha256: sha256(bytes),
    bytes: bytes.length,
    provenance: source.provenance,
  });
}

const report = {
  schema: "immersive_pov_chatgpt_extension_recovery_v1",
  status: "complete",
  recovered_cut_count: images.length,
  output_dir: OUTPUT_DIR,
  images,
};
await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ recovered: images.length, output_dir: OUTPUT_DIR, report: REPORT_PATH }, null, 2));
