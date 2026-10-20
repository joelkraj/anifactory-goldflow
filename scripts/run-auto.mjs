#!/usr/bin/env node
// goldflow run auto --episode-dir <dir> [--dry-run true] [--allow-code-drift <reason-code>] [--max-steps <n>]
// Drive an autopilot episode to its final watch or publish approval. Every
// command goes through bin/goldflow.mjs, so the workflow guard, provenance and
// rerun policies still apply. The driver itself never adds a bypass flag;
// --allow-code-drift is forwarded only when the operator passed it here.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { episodeDirForFlags } from "./lib/execution-provenance.mjs";
import { STAGE_WALL_BUDGETS, planAutopilot, runAutopilot } from "./lib/autopilot-driver.mjs";
import { createModelReviewer } from "./lib/autopilot-reviewer.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  if (!args[index].startsWith("--")) continue;
  const next = args[index + 1];
  flags[args[index].slice(2)] = next && !next.startsWith("--") ? (index += 1, next) : "true";
}
const isTrue = (value) => /^(true|1|yes)$/i.test(String(value ?? ""));

function git(argv) {
  const result = spawnSync("git", argv, { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
const gitDeps = {
  head() {
    const commit = git(["rev-parse", "HEAD"]);
    if (!commit) return null;
    const porcelain = git(["status", "--porcelain=v1", "--untracked-files=all"]) ?? "";
    const dirty = porcelain.length > 0;
    const diff = dirty ? `${porcelain}\n${git(["diff", "HEAD"]) ?? ""}` : "";
    return { commit, dirty, dirty_diff_sha256: dirty ? createHash("sha256").update(diff).digest("hex") : null };
  },
  isAncestor(ancestor, descendant) {
    return spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repoRoot, encoding: "utf8" }).status === 0;
  },
  intervening(ancestor, descendant) {
    return (git(["rev-list", "--reverse", `${ancestor}..${descendant}`]) ?? "").split("\n").filter(Boolean);
  },
};
const lockDeps = {
  pid: process.pid,
  host: os.hostname(),
  processAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
  },
};

/** Spawns in its own process group; a timeout signals the whole group (CLI children, ffmpeg) and is terminal. */
function spawnGroup(argv, { timeoutMs, capture, graceMs = STAGE_WALL_BUDGETS.kill_grace_sec * 1000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let timedOut = false;
    let signalSent = null;
    const keep = (chunk, stream) => { if (!capture) stream.write(chunk); output = `${output}${chunk}`.slice(-(capture ? 64 * 1024 * 1024 : 64 * 1024)); };
    child.stdout.on("data", (chunk) => keep(chunk, process.stdout));
    child.stderr.on("data", (chunk) => keep(chunk, process.stderr));
    const kill = (signal) => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } } };
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      signalSent = "SIGTERM";
      kill("SIGTERM");
      setTimeout(() => { signalSent = "SIGKILL"; kill("SIGKILL"); }, graceMs).unref();
    }, timeoutMs) : null;
    child.on("close", (code, signal) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, signal: signalSent ?? signal ?? null, output, timed_out: timedOut }); });
    child.on("error", (error) => { if (timer) clearTimeout(timer); resolve({ code: 1, output: error.message, timed_out: false }); });
  });
}

async function readStatus(episodeDir, { timeoutMs } = {}) {
  const result = await spawnGroup([path.join(repoRoot, "scripts", "run-status.mjs"), "--episode-dir", episodeDir], { timeoutMs, capture: true });
  if (result.timed_out) throw new Error(`run status exceeded ${Math.round((timeoutMs ?? 0) / 1000)} s`);
  if (result.code !== 0) throw new Error(`run status failed: ${result.output.slice(-2000)}`);
  const jsonStart = result.output.indexOf("{");
  return JSON.parse(result.output.slice(jsonStart));
}

function runCommand(argv, { timeoutMs } = {}) {
  return spawnGroup([path.join(repoRoot, "bin", "goldflow.mjs"), ...argv], { timeoutMs, capture: false });
}

try {
  if (!flags["episode-dir"]) throw new Error("run auto requires --episode-dir <dir>.");
  const episodeDir = episodeDirForFlags(flags, process.env);
  const allowCodeDrift = Object.hasOwn(flags, "allow-code-drift") ? String(flags["allow-code-drift"]) : null;
  const deps = {
    readStatus: (options) => readStatus(episodeDir, options),
    runCommand,
    reviewer: createModelReviewer({ episodeDir, repoRoot }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    git: gitDeps,
    lock: lockDeps,
  };
  if (isTrue(flags["dry-run"])) {
    console.log(JSON.stringify(await planAutopilot({ episodeDir, deps, allowCodeDrift }), null, 2));
  } else {
    const result = await runAutopilot({ episodeDir, maxSteps: Number(flags["max-steps"] ?? 400), deps, allowCodeDrift });
    console.log(JSON.stringify(result, null, 2));
    if (!["final_watch", "publish_approval", "complete"].includes(result.reason)) process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
