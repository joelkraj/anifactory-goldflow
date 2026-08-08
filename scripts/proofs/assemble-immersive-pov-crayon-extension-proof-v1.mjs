#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const flags = parseFlags(process.argv.slice(2));
const promptsPath = requiredPath("prompts");
const remainingManifestPath = requiredPath("remaining-manifest");
const firstAcceptedDir = requiredPath("first-accepted-dir");
const downloadsDir = requiredPath("downloads-dir");
const outputDir = requiredPath("output-dir");
const reportPath = path.resolve(
  flags["report"] ?? path.join(path.dirname(outputDir), "assembly_report.json"),
);
const since = Date.parse(flags.since ?? "");

if (!Number.isFinite(since)) {
  throw new Error("--since must be an ISO-8601 timestamp or another Date.parse-compatible value");
}

const prompts = JSON.parse(await readFile(promptsPath, "utf8"));
const remainingManifest = JSON.parse(await readFile(remainingManifestPath, "utf8"));
const allCuts = prompts.prompts ?? [];
const remainingCuts = remainingManifest.cuts ?? [];

if (allCuts.length !== 46) throw new Error(`Expected 46 prompt cuts, found ${allCuts.length}`);
if (remainingCuts.length !== 37) throw new Error(`Expected 37 remaining cuts, found ${remainingCuts.length}`);
if (remainingCuts[0]?.ordinal !== 10 || remainingCuts.at(-1)?.ordinal !== 46) {
  throw new Error("Remaining manifest must cover ordinals 10 through 46 in order");
}

const firstFiles = (await readdir(firstAcceptedDir))
  .filter((name) => /^\d{2}-ep_01-w\d+-w\d+\.png$/u.test(name))
  .sort();
if (firstFiles.length !== 9) throw new Error(`Expected 9 accepted opening images, found ${firstFiles.length}`);

const downloadRows = [];
for (const name of await readdir(downloadsDir)) {
  if (!name.toLowerCase().endsWith(".png")) continue;
  const sourcePath = path.join(downloadsDir, name);
  const sourceStat = await stat(sourcePath);
  if (sourceStat.mtimeMs < since) continue;
  downloadRows.push({ name, sourcePath, mtimeMs: sourceStat.mtimeMs });
}
downloadRows.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));

if (downloadRows.length !== 37) {
  throw new Error(`Expected exactly 37 post-cutoff downloads, found ${downloadRows.length}`);
}

await mkdir(outputDir, { recursive: true });
const assembled = [];

for (let index = 0; index < 9; index += 1) {
  const sourcePath = path.join(firstAcceptedDir, firstFiles[index]);
  assembled.push(await materialize({
    ordinal: index + 1,
    imageId: allCuts[index].image_id,
    sourcePath,
    sourceKind: "accepted_first_batch",
  }));
}

for (let index = 0; index < remainingCuts.length; index += 1) {
  const cut = remainingCuts[index];
  assembled.push(await materialize({
    ordinal: cut.ordinal,
    imageId: cut.image_id,
    sourcePath: downloadRows[index].sourcePath,
    sourceKind: "chatgpt_extension_download",
  }));
}

const hashes = assembled.map((row) => row.sha256);
if (new Set(hashes).size !== hashes.length) {
  throw new Error("Duplicate image hashes detected; refusing to assemble ambiguous proof inputs");
}

const report = {
  schema_version: "goldflow_crayon_extension_assembly_v1",
  intent: "proof_only",
  status: "passed",
  since: new Date(since).toISOString(),
  prompts_path: promptsPath,
  prompts_sha256: await sha256File(promptsPath),
  remaining_manifest_path: remainingManifestPath,
  remaining_manifest_sha256: await sha256File(remainingManifestPath),
  first_accepted_dir: firstAcceptedDir,
  downloads_dir: downloadsDir,
  output_dir: outputDir,
  image_count: assembled.length,
  images: assembled,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: report.status, imageCount: assembled.length, reportPath }, null, 2)}\n`);

async function materialize({ ordinal, imageId, sourcePath, sourceKind }) {
  const metadata = await sharp(sourcePath).metadata();
  if (!metadata.width || !metadata.height || metadata.format !== "png") {
    throw new Error(`Unreadable or non-PNG source for ordinal ${ordinal}: ${sourcePath}`);
  }
  const ratio = metadata.width / metadata.height;
  if (Math.abs(ratio - 16 / 9) > 0.03) {
    throw new Error(`Wrong geometry for ordinal ${ordinal}: ${metadata.width}x${metadata.height}`);
  }
  const outputPath = path.join(outputDir, `${imageId}-modelslab-image.png`);
  await copyFile(sourcePath, outputPath);
  return {
    ordinal,
    image_id: imageId,
    source_kind: sourceKind,
    source_path: sourcePath,
    source_mtime: (await stat(sourcePath)).mtime.toISOString(),
    output_path: outputPath,
    width: metadata.width,
    height: metadata.height,
    sha256: await sha256File(outputPath),
  };
}

function requiredPath(name) {
  if (!flags[name]) throw new Error(`Missing required --${name}`);
  return path.resolve(flags[name]);
}

function parseFlags(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`Malformed flag near ${key ?? "end"}`);
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}
