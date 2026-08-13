#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_DIRECTOR_CHECKPOINT_SCHEMA,
  AGENT_DIRECTOR_CHECKPOINTS,
  agentDirectorPhase,
  agentDirectorStatus,
  nextAgentDirectorPhase,
} from "./lib/agent-director-contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = parseFlags(process.argv.slice(2));
const action = String(flags.action ?? "status").toLowerCase();

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[++index] : "true";
    parsed[key] = value;
  }
  return parsed;
}

function boolFlag(value) {
  return /^(?:true|1|yes)$/i.test(String(value ?? ""));
}

function identityArgs() {
  if (flags["episode-dir"]) return ["--episode-dir", path.resolve(flags["episode-dir"])];
  const required = ["channel", "week", "episode"];
  if (required.some((key) => !flags[key])) throw new Error("Agent director requires --episode-dir or --channel/--week/--episode.");
  const args = ["--channel", flags.channel, "--week", flags.week, "--episode", flags.episode];
  if (flags.series) args.push("--series", flags.series);
  return args;
}

async function runNode(args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    }
    child.once("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() }));
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}

async function readRunStatus() {
  const result = await runNode([path.join(repoRoot, "scripts", "run-status.mjs"), ...identityArgs()], { capture: true });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "run status failed");
  return JSON.parse(result.stdout);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function readAnalyticsFeedbackState(episodeDir, episode) {
  const planPath = path.join(episodeDir, `youtube_analytics_followup_plan_${episode}.json`);
  const plan = await readJson(planPath);
  if (!plan) {
    return {
      state: "plan_missing",
      non_blocking: true,
      plan_path: planPath,
      checkpoints: [],
      next_command_shape: `node bin/goldflow.mjs analytics plan-followups --episode-dir ${episodeDir}`,
    };
  }
  const now = Date.now();
  const checkpoints = await Promise.all((plan.checkpoints ?? []).map(async (checkpoint) => {
    const snapshotPath = path.join(episodeDir, `youtube_analytics_snapshot_${episode}_${checkpoint.id}.json`);
    const snapshot = await readJson(snapshotPath);
    const due = checkpoint.due_at && new Date(checkpoint.due_at).getTime() <= now;
    return {
      id: checkpoint.id,
      due_at: checkpoint.due_at ?? null,
      state: snapshot ? "captured" : due ? "due" : checkpoint.state,
      snapshot_path: snapshot ? snapshotPath : null,
      director_feedback: snapshot?.director_feedback ?? null,
    };
  }));
  const dueCheckpoint = checkpoints.find((row) => row.state === "due") ?? null;
  const allCaptured = checkpoints.length > 0 && checkpoints.every((row) => row.state === "captured");
  const state = allCaptured
    ? "complete"
    : plan.status === "awaiting_release_anchor"
      ? "awaiting_release_anchor"
      : dueCheckpoint
        ? "due"
        : checkpoints.some((row) => row.state === "captured")
          ? "observing"
          : "scheduled";
  return {
    state,
    non_blocking: true,
    plan_path: planPath,
    analytics_anchor_at: plan.analytics_anchor_at ?? null,
    video_id: plan.video_id ?? null,
    checkpoints,
    next_command_shape: state === "awaiting_release_anchor"
      ? `node bin/goldflow.mjs analytics plan-followups --episode-dir ${episodeDir} --anchor-at <public-release-iso>`
      : dueCheckpoint
        ? `node bin/goldflow.mjs analytics record-followup --episode-dir ${episodeDir} --window ${dueCheckpoint.id} --metrics <metrics.json> --captured-by <name>`
        : null,
  };
}

async function checkpoint(runStatus) {
  const checkpointId = String(flags.checkpoint ?? "").trim();
  if (!AGENT_DIRECTOR_CHECKPOINTS.includes(checkpointId)) throw new Error(`Unknown --checkpoint ${checkpointId}.`);
  if (!boolFlag(flags.approve)) throw new Error("Checkpoint recording requires --approve true.");
  const approvedBy = String(flags["approved-by"] ?? "").trim();
  const note = String(flags.note ?? "").trim();
  if (!approvedBy || !note) throw new Error("Checkpoint recording requires --approved-by and --note.");
  const episodeDir = path.resolve(runStatus.episode_dir);
  const checkpointPath = path.join(episodeDir, `agent_director_checkpoints_${runStatus.identity?.episode ?? flags.episode ?? "ep_01"}.json`);
  const existing = await readJson(checkpointPath, { approvals: {} });
  const artifact = {
    schema: AGENT_DIRECTOR_CHECKPOINT_SCHEMA,
    status: "passed",
    approvals: {
      ...(existing.approvals ?? {}),
      [checkpointId]: {
        approved: true,
        approved_by: approvedBy,
        note,
        approved_at: new Date().toISOString(),
      },
    },
    updated_at: new Date().toISOString(),
  };
  await writeJson(checkpointPath, artifact);
  console.log(JSON.stringify({ status: "passed", checkpoint: checkpointId, output_path: checkpointPath }, null, 2));
}

async function main() {
  let runStatus = await readRunStatus();
  if (action === "checkpoint") {
    await checkpoint(runStatus);
    return;
  }
  const episodeDir = path.resolve(runStatus.episode_dir);
  const episode = runStatus.identity?.episode ?? flags.episode ?? "ep_01";
  const checkpointPath = path.join(episodeDir, `agent_director_checkpoints_${episode}.json`);
  let checkpoints = await readJson(checkpointPath, { approvals: {} });
  let analyticsFeedback = await readAnalyticsFeedbackState(episodeDir, episode);
  if (action === "advance") {
    const current = agentDirectorStatus(runStatus, checkpoints, { analyticsFeedback });
    if (current.checkpoint_hold.length) {
      console.log(JSON.stringify({ ...current, advance_status: "operator_checkpoint_required" }, null, 2));
      return;
    }
    const requested = flags.phase ? agentDirectorPhase(flags.phase) : agentDirectorPhase(current.current_phase);
    if (requested.id !== current.current_phase) {
      throw new Error(`Current macro phase is ${current.current_phase}; refusing to skip directly to ${requested.id}.`);
    }
    const next = nextAgentDirectorPhase(requested.id);
    if (requested.nonblocking) {
      console.log(JSON.stringify({ ...current, advance_status: "nonblocking_analytics_phase" }, null, 2));
      return;
    }
    const args = [path.join(repoRoot, "scripts", "run-advance.mjs"), ...identityArgs(), "--max-steps", String(flags["max-steps"] ?? 50)];
    if (next?.stages?.[0]) args.push("--until", next.stages[0]);
    if (boolFlag(flags["dry-run"])) args.push("--dry-run", "true");
    const advanced = await runNode(args, { capture: true });
    if (advanced.stdout) process.stdout.write(advanced.stdout);
    if (advanced.stderr) process.stderr.write(advanced.stderr);
    if (advanced.code !== 0) process.exitCode = advanced.code;
    runStatus = await readRunStatus();
    checkpoints = await readJson(checkpointPath, { approvals: {} });
    analyticsFeedback = await readAnalyticsFeedbackState(episodeDir, episode);
  } else if (action !== "status") {
    throw new Error("Agent director --action must be status, advance, or checkpoint.");
  }
  const director = agentDirectorStatus(runStatus, checkpoints, { analyticsFeedback });
  const outputPath = path.join(episodeDir, "agent_director_state.json");
  await writeJson(outputPath, {
    ...director,
    run_status_stage_registry_version: runStatus.stage_registry_version,
    checkpoint_path: checkpointPath,
    updated_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({ ...director, output_path: outputPath }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
