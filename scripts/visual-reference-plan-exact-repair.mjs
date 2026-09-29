#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repairReferencePlanExact } from "./lib/reference-plan-exact-repair.mjs";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index].startsWith("--")) throw new Error(`Unexpected argument: ${parts[index]}`);
    const key = parts[index].slice(2);
    const value = parts[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    if (Object.hasOwn(flags, key)) throw new Error(`Duplicate --${key}.`);
    flags[key] = value;
    index += 1;
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  for (const key of Object.keys(flags)) {
    if (!["episode-dir", "repair-spec"].includes(key)) throw new Error(`Unsupported --${key} for exact reference-plan repair.`);
  }
  if (!flags["episode-dir"] || !flags["repair-spec"]) throw new Error("Use --episode-dir <existing-episode> --repair-spec <reviewed-json>.");
  const episodeDir = path.resolve(flags["episode-dir"]);
  const specPath = path.resolve(flags["repair-spec"]);
  const status = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "run-status.mjs"), "--episode-dir", episodeDir], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (status.status !== 0) throw new Error(`Run status failed: ${status.stderr || status.stdout}`);
  const currentStage = JSON.parse(status.stdout).current_stage;
  const spec = JSON.parse(await fs.readFile(specPath, "utf8"));
  const result = await repairReferencePlanExact({ episodeDir, spec, specPath, currentStage });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
