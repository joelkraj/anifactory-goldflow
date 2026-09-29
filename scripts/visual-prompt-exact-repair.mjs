#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repairVisualPromptExact } from "./lib/visual-prompt-exact-repair.mjs";

const flags = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith("--") || !args[i + 1]?.length) throw new Error("Exact prompt repair requires explicit flag values.");
  const key = args[i].slice(2);
  if (!["episode-dir", "repair-spec"].includes(key) || Object.hasOwn(flags, key)) throw new Error(`Unsupported or repeated --${key}.`);
  flags[key] = args[i + 1];
}
if (!flags["episode-dir"] || !flags["repair-spec"]) throw new Error("Use --episode-dir <episode> --repair-spec <reviewed JSON>.");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const episodeDir = path.resolve(flags["episode-dir"]);
const specPath = path.resolve(flags["repair-spec"]);
const status = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "run-status.mjs"), "--episode-dir", episodeDir],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (status.status !== 0) throw new Error(`Cannot read guarded status: ${status.stderr || status.stdout}`);
const result = await repairVisualPromptExact({ episodeDir, spec: JSON.parse(await fs.readFile(specPath, "utf8")), specPath,
  status: JSON.parse(status.stdout) });
console.log(JSON.stringify(result, null, 2));
