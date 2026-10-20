#!/usr/bin/env node
// goldflow run auto --episode-dir <dir>: drive an autopilot episode to its
// final watch or publish approval. Every command goes through bin/goldflow.mjs,
// so the workflow guard, provenance and rerun policies still apply.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { episodeDirForFlags } from "./lib/execution-provenance.mjs";
import { runAutopilot } from "./lib/autopilot-driver.mjs";
import { createModelReviewer } from "./lib/autopilot-reviewer.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  if (!args[index].startsWith("--")) continue;
  const next = args[index + 1];
  flags[args[index].slice(2)] = next && !next.startsWith("--") ? (index += 1, next) : "true";
}

function readStatus(episodeDir) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "run-status.mjs"), "--episode-dir", episodeDir], {
    cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: process.env,
  });
  if (result.status !== 0) throw new Error(`run status failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function runCommand(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "bin", "goldflow.mjs"), ...argv], { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (chunk, stream) => { stream.write(chunk); output = `${output}${chunk}`.slice(-64 * 1024); };
    child.stdout.on("data", (chunk) => keep(chunk, process.stdout));
    child.stderr.on("data", (chunk) => keep(chunk, process.stderr));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
    child.on("error", (error) => resolve({ code: 1, output: error.message }));
  });
}

try {
  if (!flags["episode-dir"]) throw new Error("run auto requires --episode-dir <dir>.");
  const episodeDir = episodeDirForFlags(flags, process.env);
  const result = await runAutopilot({
    episodeDir,
    maxSteps: Number(flags["max-steps"] ?? 400),
    deps: {
      readStatus: () => readStatus(episodeDir),
      runCommand,
      reviewer: createModelReviewer({ episodeDir, repoRoot }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  });
  console.log(JSON.stringify(result, null, 2));
  if (!["final_watch", "publish_approval", "complete"].includes(result.reason)) process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
