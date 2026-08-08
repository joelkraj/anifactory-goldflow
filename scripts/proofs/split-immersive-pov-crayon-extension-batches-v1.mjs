#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const flags = parseFlags(process.argv.slice(2));
const promptFile = requiredPath("prompt-file");
const manifestFile = requiredPath("manifest");
const outputDir = requiredPath("output-dir");
const completedCount = parseInteger("completed-count", 0);
const batchCount = parseInteger("batch-count", 5);

const promptBuffer = await readFile(promptFile);
const manifestBuffer = await readFile(manifestFile);
const manifest = JSON.parse(manifestBuffer.toString("utf8"));
const prompts = promptBuffer.toString("utf8").trimEnd().split("\n");
const cuts = manifest.cuts ?? [];

if (prompts.length !== cuts.length) {
  throw new Error(`Prompt/manifest mismatch: ${prompts.length} prompts, ${cuts.length} cuts`);
}
if (completedCount < 0 || completedCount > cuts.length) {
  throw new Error(`Invalid completed count ${completedCount} for ${cuts.length} cuts`);
}

const pendingPrompts = prompts.slice(completedCount);
const pendingCuts = cuts.slice(completedCount);
if (pendingCuts.length < batchCount) {
  throw new Error(`Cannot split ${pendingCuts.length} pending cuts into ${batchCount} non-empty batches`);
}

await mkdir(outputDir, { recursive: true });
const baseSize = Math.floor(pendingCuts.length / batchCount);
const extra = pendingCuts.length % batchCount;
const batches = [];
let cursor = 0;

for (let index = 0; index < batchCount; index += 1) {
  const size = baseSize + (index < extra ? 1 : 0);
  const batchPrompts = pendingPrompts.slice(cursor, cursor + size);
  const batchCuts = pendingCuts.slice(cursor, cursor + size);
  const batchId = `batch_${String(index + 1).padStart(2, "0")}`;
  const batchDir = path.join(outputDir, batchId);
  const batchPromptFile = path.join(batchDir, `${batchId}_prompts.txt`);
  const batchManifestFile = path.join(batchDir, `${batchId}_manifest.json`);
  const downloadDir = path.join(batchDir, "downloads");
  const promptText = `${batchPrompts.join("\n")}\n`;

  await mkdir(downloadDir, { recursive: true });
  await writeFile(batchPromptFile, promptText, "utf8");

  const batchManifest = {
    schema_version: "goldflow_crayon_extension_parallel_batch_v1",
    intent: "proof_only",
    batch_id: batchId,
    prompt_count: size,
    first_ordinal: batchCuts[0].ordinal,
    last_ordinal: batchCuts.at(-1).ordinal,
    prompt_file: batchPromptFile,
    prompt_sha256: sha256(Buffer.from(promptText, "utf8")),
    download_dir: downloadDir,
    cuts: batchCuts,
  };
  await writeFile(batchManifestFile, `${JSON.stringify(batchManifest, null, 2)}\n`, "utf8");
  batches.push(batchManifest);
  cursor += size;
}

const index = {
  schema_version: "goldflow_crayon_extension_parallel_index_v1",
  intent: "proof_only",
  source_prompt_file: promptFile,
  source_prompt_sha256: sha256(promptBuffer),
  source_manifest_file: manifestFile,
  source_manifest_sha256: sha256(manifestBuffer),
  completed_count: completedCount,
  completed_ordinals: cuts.slice(0, completedCount).map((cut) => cut.ordinal),
  pending_count: pendingCuts.length,
  batch_count: batchCount,
  batches: batches.map(({ cuts: batchCuts, ...batch }) => ({
    ...batch,
    cut_ids: batchCuts.map((cut) => cut.image_id),
  })),
};
const indexPath = path.join(outputDir, "parallel_batch_index.json");
await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ indexPath, pendingCount: pendingCuts.length, batchSizes: batches.map((batch) => batch.prompt_count) }, null, 2)}\n`);

function requiredPath(name) {
  if (!flags[name]) throw new Error(`Missing required --${name}`);
  return path.resolve(flags[name]);
}

function parseInteger(name, fallback) {
  const value = Number.parseInt(flags[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid --${name}: ${flags[name]}`);
  return value;
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

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
