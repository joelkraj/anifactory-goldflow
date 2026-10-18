#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyVisualBeatExactRepair } from "./lib/visual-beat-exact-repair.mjs";

const flags = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  if (!args[index]?.startsWith("--") || !args[index + 1]) throw new Error("Repair flags require explicit values.");
  flags[args[index].slice(2)] = args[index + 1];
}
const episodeDir = flags["episode-dir"] && path.resolve(flags["episode-dir"]);
if (!episodeDir) throw new Error("--episode-dir is required.");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const status = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "run-status.mjs"),
  "--episode-dir", episodeDir], { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (status.status !== 0) throw new Error(`Cannot read guarded run status: ${status.stderr || status.stdout}`);
const result = await applyVisualBeatExactRepair({
  episodeDir,
  specPath: flags["repair-spec"],
  beatIds: String(flags["beat-ids"] ?? "").split(",").map((id) => id.trim()).filter(Boolean),
  status: JSON.parse(status.stdout),
});
console.log(JSON.stringify(result, null, 2));
