#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const flags = parseFlags(process.argv.slice(2));
const proofDir = requiredPath(flags["proof-dir"], "--proof-dir");
const recipePaths = String(flags.recipes ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => path.resolve(value));
const lockPath = path.join(proofDir, "BASELINE_LOCK.json");
const recipeDir = path.join(proofDir, "recipe_snapshot");

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = parts[index + 1];
    parsed[key] = next && !next.startsWith("--") ? next : "true";
    if (parsed[key] !== "true") index += 1;
  }
  return parsed;
}

function requiredPath(value, flag) {
  if (!value || value === "true") throw new Error(`${flag} is required.`);
  return path.resolve(value);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fileRecord(filePath, root) {
  const stat = await fs.stat(filePath);
  const content = await fs.readFile(filePath);
  return {
    path: path.relative(root, filePath),
    size_bytes: stat.size,
    sha256: sha256(content),
  };
}

async function walkFiles(root) {
  const records = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entryPath === lockPath) continue;
      if (entry.isDirectory() && (
        entry.name === "work"
        || entry.name.startsWith("work_")
        || entry.name === "recipe_snapshot"
      )) continue;
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile()) records.push(await fileRecord(entryPath, root));
    }
  }
  await walk(root);
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

async function snapshotRecipes() {
  await fs.mkdir(recipeDir, { recursive: true });
  const records = [];
  for (const sourcePath of recipePaths) {
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) throw new Error(`Recipe is not a file: ${sourcePath}`);
    const snapshotName = path.basename(sourcePath);
    const targetPath = path.join(recipeDir, snapshotName);
    if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
      await fs.copyFile(sourcePath, targetPath);
    }
    records.push({
      source_path: sourcePath,
      snapshot_path: targetPath,
      source_sha256: sha256(await fs.readFile(sourcePath)),
      snapshot_sha256: sha256(await fs.readFile(targetPath)),
    });
  }
  return records;
}

async function verifyExistingLock() {
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  if (lock?.status !== "locked" || !Array.isArray(lock?.artifacts)) {
    throw new Error(`Invalid baseline lock: ${lockPath}`);
  }
  const mismatches = [];
  for (const record of lock.artifacts) {
    const filePath = path.join(proofDir, record.path);
    try {
      const actual = await fileRecord(filePath, proofDir);
      if (actual.sha256 !== record.sha256 || actual.size_bytes !== record.size_bytes) {
        mismatches.push({ path: record.path, expected: record, actual });
      }
    } catch (error) {
      mismatches.push({ path: record.path, expected: record, error: error.message });
    }
  }
  for (const recipe of lock.recipes ?? []) {
    try {
      const actual = sha256(await fs.readFile(recipe.snapshot_path));
      if (actual !== recipe.snapshot_sha256) {
        mismatches.push({
          path: recipe.snapshot_path,
          expected_sha256: recipe.snapshot_sha256,
          actual_sha256: actual,
        });
      }
    } catch (error) {
      mismatches.push({ path: recipe.snapshot_path, error: error.message });
    }
  }
  const currentArtifacts = await walkFiles(proofDir);
  const expectedPaths = new Set(lock.artifacts.map((record) => record.path));
  const unexpectedPaths = currentArtifacts
    .map((record) => record.path)
    .filter((filePath) => !expectedPaths.has(filePath));
  if (unexpectedPaths.length) mismatches.push({ unexpected_paths: unexpectedPaths });
  const result = {
    schema: "goldflow_proof_baseline_verification_v1",
    status: mismatches.length ? "failed" : "verified",
    proof_dir: proofDir,
    lock_path: lockPath,
    lock_sha256: sha256(await fs.readFile(lockPath)),
    content_sha256: lock.content_sha256,
    artifact_count: lock.artifact_count,
    verified_at: new Date().toISOString(),
    mismatches,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (mismatches.length) process.exitCode = 1;
}

async function main() {
  const stat = await fs.stat(proofDir);
  if (!stat.isDirectory()) throw new Error(`Proof directory does not exist: ${proofDir}`);
  if (flags.verify === "true") {
    await verifyExistingLock();
    return;
  }
  const previous = await fs.readFile(lockPath, "utf8").catch(() => null);
  if (previous && flags.force !== "true") {
    throw new Error(`Baseline is already locked: ${lockPath}`);
  }
  const recipes = await snapshotRecipes();
  const artifacts = await walkFiles(proofDir);
  const canonical = JSON.stringify({ artifacts, recipes });
  const lock = {
    schema: "goldflow_proof_baseline_lock_v1",
    status: "locked",
    proof_dir: proofDir,
    created_at: new Date().toISOString(),
    official_pipeline_artifacts_modified: false,
    rollback_contract: "Restore or compare against the exact files and hashes in this manifest; later proof versions must use a different output directory.",
    artifact_count: artifacts.length,
    artifacts,
    recipes,
    content_sha256: sha256(Buffer.from(canonical)),
  };
  await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: lock.status,
    lock_path: lockPath,
    artifact_count: lock.artifact_count,
    content_sha256: lock.content_sha256,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
