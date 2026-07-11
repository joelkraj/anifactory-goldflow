#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function collectMjs(dirPath) {
  const rows = [];
  for (const entry of await fs.readdir(dirPath, { withFileTypes: true })) {
    const filePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) rows.push(...await collectMjs(filePath));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) rows.push(filePath);
  }
  return rows;
}

const files = [
  ...await collectMjs(path.join(repoRoot, "bin")),
  ...await collectMjs(path.join(repoRoot, "scripts")),
].sort();

for (const filePath of files) {
  const result = spawnSync(process.execPath, ["--check", filePath], { cwd: repoRoot, encoding: "utf8" });
  if (result.status === 0) continue;
  process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${filePath}\n`);
  process.exit(result.status ?? 1);
}

console.log(`syntax check passed: ${files.length} modules`);
