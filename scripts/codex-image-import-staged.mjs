#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCb);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));

const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json");
const stagingDir = flags["staging-dir"] ?? path.join(episodeDir, "assets", "images", "codex_worker_staging");
const reportPath = flags.output ?? flags.report ?? flags["report-output"] ?? path.join(episodeDir, `imagegen_report_codex_manual_${episode}.json`);
const dryRun = flags["dry-run"] === "true";
const force = flags.force === "true" || flags["force-import"] === "true";

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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function verifyPng(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`Missing or empty staged image: ${filePath}`);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(8);
    await handle.read(buffer, 0, 8, 0);
    if (!buffer.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error(`Staged file is not a PNG: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
}

async function hashFile(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function walk(dir) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(filePath));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) files.push(filePath);
  }
  return files;
}

function imageIdFromPath(filePath) {
  return path.basename(filePath).match(/(ep_\d+-cut-\d+)/)?.[1] ?? null;
}

async function importOne(imageId, sourcePath) {
  const args = [
    path.join(repoRoot, "bin", "goldflow.mjs"),
    "imagegen",
    "import-codex",
    "--channel",
    channel,
    "--series",
    series,
    "--week",
    week,
    "--episode",
    episode,
    "--prompts",
    promptPath,
    "--image-id",
    imageId,
    "--source",
    sourcePath,
    "--output",
    reportPath,
  ];
  const { stdout } = await execFile(process.execPath, args, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 4 });
  return JSON.parse(stdout);
}

async function main() {
  const plan = await readJson(promptPath);
  if (plan?.status !== "passed" || !Array.isArray(plan.prompts)) throw new Error(`Missing passed prompt plan: ${promptPath}`);
  const validIds = new Set(plan.prompts.filter((prompt) => prompt.image_generation_required !== false).map((prompt) => prompt.image_id));
  const priorReport = await exists(reportPath) ? await readJson(reportPath) : null;
  const alreadyImported = new Set();
  const importedHashOwners = new Map();
  if (!force && Array.isArray(priorReport?.results)) {
    for (const row of priorReport.results) {
      if (!row?.image_id || !row.image_path || !(await exists(row.image_path))) continue;
      alreadyImported.add(row.image_id);
      const hash = row.generated?.output_sha256 ?? await hashFile(row.image_path);
      if (!importedHashOwners.has(hash)) importedHashOwners.set(hash, row.image_id);
    }
  }
  const files = (await walk(stagingDir))
    .map((filePath) => ({ filePath, imageId: imageIdFromPath(filePath) }))
    .filter((row) => row.imageId && validIds.has(row.imageId))
    .sort((left, right) => left.imageId.localeCompare(right.imageId, undefined, { numeric: true }));
  const byId = new Map();
  for (const row of files) byId.set(row.imageId, row.filePath);
  const imports = [];
  for (const [imageId, filePath] of byId.entries()) {
    await verifyPng(filePath);
    if (alreadyImported.has(imageId)) {
      imports.push({ image_id: imageId, source_path: filePath, status: "skipped_existing" });
      continue;
    }
    const sourceHash = await hashFile(filePath);
    const duplicateOwner = !force ? importedHashOwners.get(sourceHash) : null;
    if (duplicateOwner && duplicateOwner !== imageId) {
      const skipped = { image_id: imageId, source_path: filePath, status: "skipped_duplicate_hash", duplicate_of: duplicateOwner };
      imports.push(skipped);
      console.log(JSON.stringify(skipped));
      continue;
    }
    if (dryRun) {
      imports.push({ image_id: imageId, source_path: filePath, status: "dry_run" });
      continue;
    }
    const result = await importOne(imageId, filePath);
    importedHashOwners.set(sourceHash, imageId);
    imports.push({ image_id: imageId, source_path: filePath, status: result.status, image_count: result.image_count, missing_image_count: result.missing_image_count });
    console.log(JSON.stringify(imports.at(-1)));
  }
  const report = dryRun || !(await exists(reportPath)) ? null : await readJson(reportPath);
  console.log(JSON.stringify({
    status: dryRun ? "dry_run" : "completed",
    staging_dir: stagingDir,
    imported_count: imports.length,
    report_path: reportPath,
    image_count: report?.image_count ?? null,
    missing_image_count: report?.missing_image_count ?? null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
