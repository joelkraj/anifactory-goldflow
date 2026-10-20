#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { materializePowerSystemComprehensionAudit } from "./lib/power-system-comprehension-contract.mjs";
import { authorScriptComprehensionAudit } from "./lib/script-comprehension-audit.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.resolve(flags["episode-dir"] ?? path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode));
const scriptPath = path.join(episodeDir, "script_clean.md");
const auditPath = path.resolve(flags.output ?? path.join(episodeDir, "power_system_comprehension_audit.json"));

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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// `--input <candidate.json> --reviewed-by <name>`: materialize and validate an already authored
// candidate (operator or autopilot gate). Without --input (`--author planner`): the registered
// stage authors the candidate itself through the single planner call layer.
async function main() {
  if (flags.input) {
    const script = await fs.readFile(scriptPath, "utf8");
    const candidate = JSON.parse(await fs.readFile(path.resolve(flags.input), "utf8"));
    const reviewedBy = String(flags["reviewed-by"] ?? "").trim();
    if (!reviewedBy) throw new Error("--reviewed-by is required with --input: name the reviewer who read the complete script.");
    const audit = materializePowerSystemComprehensionAudit(candidate, script, { sourceScriptPath: scriptPath, reviewedBy });
    await writeJson(auditPath, audit);
    console.log(JSON.stringify({ status: audit.status, audit_path: auditPath, source_script_hash: createHash("sha256").update(script).digest("hex"), ability_count: audit.ability_count, blockers: audit.validation.blockers }, null, 2));
    if (audit.status !== "passed") process.exitCode = 1;
    return;
  }
  const author = String(flags.author ?? "planner");
  if (author !== "planner") throw new Error(`Unknown --author ${author}; use --author planner or supply --input <candidate.json> --reviewed-by <name>.`);
  const result = await authorScriptComprehensionAudit({ episodeDir, scriptPath, auditPath });
  const summary = {
    status: result.status,
    audit_path: result.auditPath,
    source_script_hash: result.scriptHash,
    ability_count: result.audit?.ability_count ?? null,
    reviewed_by: result.audit?.reviewed_by ?? null,
    planner_call: result.call,
    blockers: result.audit?.validation?.blockers ?? [],
  };
  if (result.status === "held") {
    console.error(result.reason);
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(summary, null, 2));
  if (result.status === "blocked") {
    console.error("Comprehension audit blocked: written as triage evidence; the planner is not re-called and the script is not edited.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
