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
import {
  DIRECTOR_WATCH_SCHEMA,
  directorWatchDecision,
  directorWatchDispatchKey,
  directorWatchRestartState,
  directorWatchSignature,
  executionEventsCursorFromText,
} from "./lib/director-watch-policy.mjs";
import { productionProfileForIdentity } from "./lib/production-profiles.mjs";

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

function boundedNumberFlag(value, fallback, { minimum, maximum }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function identityArgs() {
  if (flags["episode-dir"]) return ["--episode-dir", path.resolve(flags["episode-dir"])];
  const required = ["channel", "week", "episode"];
  if (required.some((key) => !flags[key])) throw new Error("Agent director requires --episode-dir or --channel/--week/--episode.");
  const args = ["--channel", flags.channel, "--week", flags.week, "--episode", flags.episode];
  if (flags.series) args.push("--series", flags.series);
  return args;
}

async function runNode(args, { capture = false, onSpawn = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    let spawnTrackingError = null;
    const spawnTracking = typeof onSpawn === "function"
      ? Promise.resolve(onSpawn({
          pid: child.pid,
          spawned_at: new Date().toISOString(),
        })).catch((error) => {
          spawnTrackingError = error instanceof Error ? error : new Error(String(error));
        })
      : Promise.resolve();
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    }
    child.once("error", async (error) => {
      await spawnTracking;
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim(), spawn_tracking_error: spawnTrackingError?.message ?? null });
    });
    child.once("close", async (code, signal) => {
      await spawnTracking;
      const trackingMessage = spawnTrackingError ? `\n${spawnTrackingError.message}` : "";
      resolve({
        code: spawnTrackingError ? 1 : code ?? 1,
        signal,
        stdout,
        stderr: `${stderr}${trackingMessage}`.trim(),
        spawn_tracking_error: spawnTrackingError?.message ?? null,
      });
    });
  });
}

async function readRunStatus() {
  const result = await runNode([path.join(repoRoot, "scripts", "run-status.mjs"), ...identityArgs()], { capture: true });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "run status failed");
  return JSON.parse(result.stdout);
}

async function readExecutionEventsCursor(episodeDir) {
  const eventPath = path.join(episodeDir, "execution_events.jsonl");
  const content = await fs.readFile(eventPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return executionEventsCursorFromText(content);
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

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireWatchLock(episodeDir) {
  const lockPath = path.join(episodeDir, ".agent_director_watch.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`, "utf8");
      await handle.close();
      return {
        path: lockPath,
        async release() {
          const current = await readJson(lockPath);
          if (Number(current?.pid) === process.pid) await fs.unlink(lockPath).catch(() => {});
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = await readJson(lockPath);
      if (processIsAlive(Number(current?.pid))) {
        throw new Error(`Another agent-director watcher is already active for this episode (pid ${current.pid}).`);
      }
      await fs.unlink(lockPath).catch(() => {});
    }
  }
  throw new Error(`Unable to acquire agent-director watcher lock: ${lockPath}`);
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

async function refreshPerformanceAudit(episodeDir) {
  const result = await runNode([
    path.join(repoRoot, "scripts", "run-performance-audit.mjs"),
    "--episode-dir", episodeDir,
  ], { capture: true });
  if (result.code !== 0) {
    return {
      status: "unavailable",
      non_blocking: true,
      error: String(result.stderr || result.stdout || "performance audit unavailable").trim(),
    };
  }
  try {
    return { status: "passed", ...JSON.parse(result.stdout) };
  } catch {
    return { status: "unavailable", non_blocking: true, error: "performance audit output was not valid JSON" };
  }
}

async function persistDirectorSnapshot({ runStatus, checkpoints, analyticsFeedback, checkpointPath }) {
  const director = agentDirectorStatus(runStatus, checkpoints, { analyticsFeedback });
  const episodeDir = path.resolve(runStatus.episode_dir);
  const performanceAudit = await refreshPerformanceAudit(episodeDir);
  const outputPath = path.join(episodeDir, "agent_director_state.json");
  await writeJson(outputPath, {
    ...director,
    performance_audit: performanceAudit,
    run_status_stage_registry_version: runStatus.stage_registry_version,
    checkpoint_path: checkpointPath,
    updated_at: new Date().toISOString(),
  });
  return { director, performanceAudit, outputPath };
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

async function babysit(initialRunStatus) {
  const episodeDir = path.resolve(initialRunStatus.episode_dir);
  const episode = initialRunStatus.identity?.episode ?? flags.episode ?? "ep_01";
  const checkpointPath = path.join(episodeDir, `agent_director_checkpoints_${episode}.json`);
  const statePath = path.join(episodeDir, "agent_director_watch_state.json");
  const pollMs = boundedNumberFlag(flags["poll-ms"], 5_000, { minimum: 1_000, maximum: 60_000 });
  const idleTimeoutMs = boundedNumberFlag(flags["idle-timeout-minutes"], 480, { minimum: 1, maximum: 2_880 }) * 60_000;
  const maxRuntimeMs = boundedNumberFlag(flags["max-runtime-minutes"], 1_440, { minimum: 1, maximum: 4_320 }) * 60_000;
  const maxSteps = String(flags["max-steps"] ?? 50);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let runStatus = initialRunStatus;
  let executionEventsCursor = null;
  let lastSignature = null;
  let lastActionedSignature = null;
  let lastActionedDispatchKey = null;
  let lastProgressAtMs = startedAtMs;
  let lastPersistAtMs = 0;
  let lastPersistedReason = null;
  let inFlightAdvance = null;
  let restartRecovery = null;
  const watchLock = await acquireWatchLock(episodeDir);

  const persistWatchState = async ({ decision, signature, dispatchKey, director, force = false }) => {
    const now = Date.now();
    if (!force && decision.reason === lastPersistedReason && now - lastPersistAtMs < 60_000) return;
    await writeJson(statePath, {
      schema: DIRECTOR_WATCH_SCHEMA,
      status: decision.action === "stop"
        ? decision.reason === "pipeline_complete" ? "complete" : "held"
        : decision.action === "advance" ? "advancing" : "watching",
      decision,
      episode_dir: episodeDir,
      episode,
      current_stage: runStatus.current_stage,
      current_stage_state: runStatus.current_stage_state ?? null,
      state_signature: signature,
      dispatch_key: dispatchKey,
      last_actioned_signature: lastActionedSignature,
      last_actioned_dispatch_key: lastActionedDispatchKey,
      execution_events_cursor: executionEventsCursor,
      execution_events_cursor_sha256: executionEventsCursor?.sha256 ?? null,
      in_flight_advance: inFlightAdvance,
      restart_recovery: restartRecovery,
      checkpoint_hold: director.checkpoint_hold ?? [],
      started_at: startedAt,
      last_progress_at: new Date(lastProgressAtMs).toISOString(),
      heartbeat_at: new Date(now).toISOString(),
      pid: process.pid,
      poll_ms: pollMs,
      idle_timeout_ms: idleTimeoutMs,
      max_runtime_ms: maxRuntimeMs,
      approval_policy: "observe_hash_bound_approvals_never_auto_approve",
    });
    lastPersistAtMs = now;
    lastPersistedReason = decision.reason;
  };

  try {
    const initialCheckpoints = await readJson(checkpointPath, { approvals: {} });
    executionEventsCursor = await readExecutionEventsCursor(episodeDir);
    const initialSignature = directorWatchSignature(runStatus, initialCheckpoints, executionEventsCursor);
    const initialDispatchKey = directorWatchDispatchKey(runStatus);
    let previousWatchState = null;
    let previousWatchStateReadError = null;
    try {
      previousWatchState = await readJson(statePath);
    } catch (error) {
      previousWatchStateReadError = error instanceof Error ? error : new Error(String(error));
    }
    restartRecovery = directorWatchRestartState({
      state: previousWatchState,
      stateReadError: previousWatchStateReadError,
      episodeDir,
      episode,
      runStatus,
      checkpoints: initialCheckpoints,
      executionEventsCursor,
      signature: initialSignature,
      dispatchKey: initialDispatchKey,
      isProcessAlive: processIsAlive,
    });
    lastActionedSignature = restartRecovery.last_actioned_signature;
    lastActionedDispatchKey = restartRecovery.last_actioned_dispatch_key;
    inFlightAdvance = restartRecovery.in_flight_advance;
    if (restartRecovery.state_valid) {
      const restoredProgressAtMs = new Date(previousWatchState?.last_progress_at ?? "").getTime();
      if (Number.isFinite(restoredProgressAtMs)) lastProgressAtMs = restoredProgressAtMs;
      lastSignature = initialSignature;
    }
    if (restartRecovery.hold) {
      const analyticsFeedback = await readAnalyticsFeedbackState(episodeDir, episode);
      const director = agentDirectorStatus(runStatus, initialCheckpoints, { analyticsFeedback });
      const decision = {
        action: "stop",
        reason: restartRecovery.hold_reason,
        prior_child_pid: restartRecovery.child_pid ?? inFlightAdvance?.child_pid ?? null,
        open_execution_ids: restartRecovery.open_execution_ids ?? [],
      };
      await persistWatchState({ decision, signature: initialSignature, dispatchKey: initialDispatchKey, director, force: true });
      console.log(JSON.stringify({
        status: "held",
        stop_reason: decision.reason,
        current_stage: runStatus.current_stage,
        prior_child_pid: decision.prior_child_pid,
        output_path: statePath,
      }, null, 2));
      return;
    }

    while (true) {
      const now = Date.now();
      executionEventsCursor = await readExecutionEventsCursor(episodeDir);
      if (now - startedAtMs >= maxRuntimeMs) {
        const checkpoints = await readJson(checkpointPath, { approvals: {} });
        const analyticsFeedback = await readAnalyticsFeedbackState(episodeDir, episode);
        const director = agentDirectorStatus(runStatus, checkpoints, { analyticsFeedback });
        const signature = directorWatchSignature(runStatus, checkpoints, executionEventsCursor);
        const dispatchKey = directorWatchDispatchKey(runStatus);
        const decision = { action: "stop", reason: "maximum_runtime_reached" };
        await persistWatchState({ decision, signature, dispatchKey, director, force: true });
        console.log(JSON.stringify({ status: "held", stop_reason: decision.reason, output_path: statePath }, null, 2));
        return;
      }

      const checkpoints = await readJson(checkpointPath, { approvals: {} });
      const analyticsFeedback = await readAnalyticsFeedbackState(episodeDir, episode);
      const director = agentDirectorStatus(runStatus, checkpoints, { analyticsFeedback });
      const signature = directorWatchSignature(runStatus, checkpoints, executionEventsCursor);
      const dispatchKey = directorWatchDispatchKey(runStatus);
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastProgressAtMs = now;
        await persistDirectorSnapshot({ runStatus, checkpoints, analyticsFeedback, checkpointPath });
      }
      const profile = productionProfileForIdentity(runStatus.identity ?? {});
      const decision = directorWatchDecision({
        runStatus,
        director,
        profile,
        signature,
        lastActionedSignature,
        dispatchKey,
        lastActionedDispatchKey,
        idleElapsedMs: now - lastProgressAtMs,
        idleTimeoutMs,
      });
      await persistWatchState({ decision, signature, dispatchKey, director, force: decision.action !== "wait" });

      if (decision.action === "stop") {
        console.log(JSON.stringify({
          status: decision.reason === "pipeline_complete" ? "complete" : "held",
          stop_reason: decision.reason,
          current_stage: runStatus.current_stage,
          output_path: statePath,
        }, null, 2));
        return;
      }
      if (decision.action === "advance") {
        const actionedStage = runStatus.current_stage;
        const actionedDispatchKey = dispatchKey;
        lastActionedSignature = signature;
        lastActionedDispatchKey = actionedDispatchKey;
        inFlightAdvance = {
          active: true,
          phase: "spawn_pending",
          stage: actionedStage,
          state_signature: signature,
          dispatch_key: actionedDispatchKey,
          execution_events_cursor: executionEventsCursor,
          execution_events_cursor_sha256: executionEventsCursor?.sha256 ?? null,
          child_pid: null,
          watcher_pid: process.pid,
          requested_at: new Date().toISOString(),
        };
        await persistWatchState({ decision, signature, dispatchKey, director, force: true });
        const advanced = await runNode([
          path.join(repoRoot, "scripts", "run-advance.mjs"),
          ...identityArgs(),
          "--max-steps", maxSteps,
        ], {
          capture: true,
          onSpawn: async ({ pid, spawned_at: spawnedAt }) => {
            inFlightAdvance = {
              ...inFlightAdvance,
              phase: "running",
              child_pid: Number(pid) || null,
              spawned_at: spawnedAt,
            };
            await persistWatchState({ decision, signature, dispatchKey, director, force: true });
          },
        });
        if (advanced.stdout) process.stdout.write(advanced.stdout);
        if (advanced.stderr) process.stderr.write(advanced.stderr);
        runStatus = await readRunStatus();
        const completedCheckpoints = await readJson(checkpointPath, { approvals: {} });
        const completedAnalyticsFeedback = await readAnalyticsFeedbackState(episodeDir, episode);
        const completedDirector = agentDirectorStatus(runStatus, completedCheckpoints, { analyticsFeedback: completedAnalyticsFeedback });
        executionEventsCursor = await readExecutionEventsCursor(episodeDir);
        const completedSignature = directorWatchSignature(runStatus, completedCheckpoints, executionEventsCursor);
        const completedDispatchKey = directorWatchDispatchKey(runStatus);
        inFlightAdvance = null;
        if (completedDispatchKey === actionedDispatchKey) {
          // The child returned without moving the authoritative stage. Rebind
          // the observation guard to the post-child cursor. The independent
          // dispatch key remains consumed even if unrelated observations move.
          lastActionedSignature = completedSignature;
        }
        if (advanced.code !== 0) {
          const failedDecision = {
            action: "stop",
            reason: advanced.spawn_tracking_error ? "advance_child_tracking_failed" : "advance_process_failed",
            exit_code: advanced.code,
          };
          await persistWatchState({
            decision: failedDecision,
            signature: completedSignature,
            dispatchKey: completedDispatchKey,
            director: completedDirector,
            force: true,
          });
          console.log(JSON.stringify({ status: "held", stop_reason: failedDecision.reason, current_stage: runStatus.current_stage, output_path: statePath }, null, 2));
          return;
        }
        await persistWatchState({
          decision: {
            action: "wait",
            reason: completedDispatchKey === actionedDispatchKey
              ? "advance_process_completed_awaiting_state_change"
              : "advance_process_completed",
          },
          signature: completedSignature,
          dispatchKey: completedDispatchKey,
          director: completedDirector,
          force: true,
        });
        continue;
      }

      await sleep(pollMs);
      runStatus = await readRunStatus();
    }
  } finally {
    await watchLock.release();
  }
}

async function main() {
  let runStatus = await readRunStatus();
  if (action === "checkpoint") {
    await checkpoint(runStatus);
    return;
  }
  if (action === "babysit" || action === "watch") {
    await babysit(runStatus);
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
      const snapshot = await persistDirectorSnapshot({ runStatus, checkpoints, analyticsFeedback, checkpointPath });
      console.log(JSON.stringify({
        ...snapshot.director,
        performance_audit: snapshot.performanceAudit,
        advance_status: "operator_checkpoint_required",
        output_path: snapshot.outputPath,
      }, null, 2));
      return;
    }
    const requested = flags.phase ? agentDirectorPhase(flags.phase) : agentDirectorPhase(current.current_phase);
    if (requested.id !== current.current_phase) {
      throw new Error(`Current macro phase is ${current.current_phase}; refusing to skip directly to ${requested.id}.`);
    }
    const next = nextAgentDirectorPhase(requested.id);
    if (requested.nonblocking) {
      const snapshot = await persistDirectorSnapshot({ runStatus, checkpoints, analyticsFeedback, checkpointPath });
      console.log(JSON.stringify({
        ...snapshot.director,
        performance_audit: snapshot.performanceAudit,
        advance_status: "nonblocking_analytics_phase",
        output_path: snapshot.outputPath,
      }, null, 2));
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
    throw new Error("Agent director --action must be status, advance, babysit, watch, or checkpoint.");
  }
  const snapshot = await persistDirectorSnapshot({ runStatus, checkpoints, analyticsFeedback, checkpointPath });
  console.log(JSON.stringify({
    ...snapshot.director,
    performance_audit: snapshot.performanceAudit,
    output_path: snapshot.outputPath,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
