#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repairIdentityBindings } from "./lib/visual-identity-binding-repair.mjs";

const flags = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  if (!args[index]?.startsWith("--") || !args[index + 1]?.length) throw new Error("Explicit exact-repair flag values required.");
  const key = args[index].slice(2);
  if (!["episode-dir", "repair-spec"].includes(key) || Object.hasOwn(flags, key)) throw new Error(`Unsupported or repeated --${key}.`);
  flags[key] = args[index + 1];
}
if (!flags["episode-dir"] || !flags["repair-spec"]) throw new Error("Use --episode-dir <episode> --repair-spec <reviewed JSON>.");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const episodeDir = path.resolve(flags["episode-dir"]);
const specPath = path.resolve(flags["repair-spec"]);
const status = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "run-status.mjs"), "--episode-dir", episodeDir],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (status.status !== 0) throw new Error(`Cannot read guarded status: ${status.stderr || status.stdout}`);
const result = await repairIdentityBindings({ episodeDir, specPath,
  spec: JSON.parse(await fs.readFile(specPath, "utf8")), status: JSON.parse(status.stdout) });
console.log(JSON.stringify(result, null, 2));
