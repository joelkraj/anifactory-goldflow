#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { materializePowerSystemComprehensionAudit } from "./lib/power-system-comprehension-contract.mjs";

const flags = parseFlags(process.argv.slice(2));
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const episodeDir = path.resolve(flags["episode-dir"] ?? path.join(
  dataRoot,
  "channels",
  flags.channel ?? "53rebirth",
  "weekly_runs",
  flags.week ?? "current",
  "episodes",
  flags.episode ?? "ep_01",
));
const scriptPath = path.resolve(flags.script ?? path.join(episodeDir, "script_clean.md"));
const inputPath = flags.input ? path.resolve(flags.input) : null;
const outputPath = path.resolve(flags.output ?? path.join(episodeDir, "power_system_comprehension_audit.json"));

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

async function main() {
  if (!inputPath) throw new Error("Power-system audit requires --input <candidate-json>.");
  const reviewedBy = String(flags["reviewed-by"] ?? "").trim();
  if (!reviewedBy) throw new Error("Power-system audit requires --reviewed-by <agent-or-operator>.");
  const [script, candidate] = await Promise.all([
    fs.readFile(scriptPath, "utf8"),
    fs.readFile(inputPath, "utf8").then(JSON.parse),
  ]);
  const artifact = materializePowerSystemComprehensionAudit(candidate, script, {
    sourceScriptPath: scriptPath,
    reviewedBy,
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status: artifact.status,
    output_path: outputPath,
    source_script_hash: artifact.source_script_hash,
    ability_count: artifact.ability_count,
    blockers: artifact.validation.blockers,
  }, null, 2));
  if (artifact.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
