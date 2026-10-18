#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { productionProfileForIdentity } from "./lib/production-profiles.mjs";
import {
  PROVIDER_READINESS_SCHEMA,
  PROVIDER_READINESS_VERSION,
  inspectProviderLane,
  providerLaneSpecs,
  providerReadinessDecision,
  sha256,
} from "./lib/provider-readiness.mjs";
import { googleImageSchedulingForIdentity } from "./lib/google-image-scheduling.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = parseFlags(process.argv.slice(2));

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[++index] : "true";
    parsed[key] = value;
  }
  return parsed;
}

function isTrue(value, fallback = false) {
  if (value == null) return fallback;
  return /^(?:true|1|yes)$/i.test(String(value));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function portIsOccupied(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(800);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function launchProviderHost(spec, logDir) {
  if (await portIsOccupied(spec.port)) {
    return { launched: false, reason: "port_occupied_by_unverified_process", port: spec.port };
  }
  await fs.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `${spec.provider}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const logHandle = await fs.open(logPath, "a");
  const args = [
    path.join(repoRoot, "apps", "goldflow-studio", "desktop", "main.mjs"),
    "--provider", spec.provider,
    "--port", String(spec.port),
    "--concurrency", String(spec.concurrency),
    "--types", spec.worker_types,
    "--open-dashboard", "false",
    "--login-bootstrap", "false",
    "--prewarm-persistent", "true",
    `--${spec.plan_flag}`, spec.plan_label,
    `--${spec.model_flag}`, spec.model_label,
    ...(spec.google_submit_gate_dir ? [
      "--state-dir", spec.state_root,
      "--google-submit-gate-dir", spec.google_submit_gate_dir,
      "--google-submit-interval-ms", String(spec.google_submit_interval_ms),
      "--google-submit-jitter-max-ms", String(spec.google_submit_jitter_max_ms),
    ] : []),
  ];
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
    env: { ...process.env },
  });
  child.unref();
  await logHandle.close();
  return { launched: true, pid: child.pid, log_path: logPath, command: [process.execPath, ...args] };
}

async function waitForLanes(specs, { timeoutMs, pollMs = 1_000 } = {}) {
  const started = Date.now();
  let lanes = await Promise.all(specs.map((spec) => inspectProviderLane(spec)));
  while (lanes.some((lane) => lane.status !== "passed") && Date.now() - started < timeoutMs) {
    await delay(pollMs);
    lanes = await Promise.all(specs.map((spec) => inspectProviderLane(spec)));
  }
  return lanes;
}

async function main() {
  const episodeDir = flags["episode-dir"] ? path.resolve(flags["episode-dir"]) : null;
  if (!episodeDir) throw new Error("run media-ready requires --episode-dir.");
  const identityPath = path.join(episodeDir, "run_identity.json");
  const identityBytes = await fs.readFile(identityPath);
  const identity = JSON.parse(identityBytes.toString("utf8"));
  const scheduling = googleImageSchedulingForIdentity(identity);
  const profile = productionProfileForIdentity(identity);
  const readinessPolicy = profile.orchestration?.provider_readiness_gate ?? {};
  if (readinessPolicy.required !== true) {
    console.log(JSON.stringify({ status: "skipped", reason: "profile_provider_readiness_not_required", production_profile: profile.id }, null, 2));
    return;
  }
  const stateRoot = path.resolve(flags["state-root"] ?? process.env.GOLDFLOW_STUDIO_STATE_DIR ?? path.join(os.homedir(), ".goldflow-studio"));
  const flowModelOverride = String(flags["flow-model-override"] ?? "").trim();
  const flowConcurrencyOverrideRaw = String(flags["flow-concurrency-override"] ?? "").trim();
  const flowConcurrencyOverride = flowConcurrencyOverrideRaw ? Number(flowConcurrencyOverrideRaw) : null;
  const repairReason = String(flags["repair-reason"] ?? "").trim();
  if ((flowModelOverride || flowConcurrencyOverride != null) && !repairReason) {
    throw new Error("run media-ready Flow repair overrides require --repair-reason.");
  }
  if (flowConcurrencyOverride != null
    && (!Number.isInteger(flowConcurrencyOverride) || flowConcurrencyOverride < 1 || flowConcurrencyOverride > 5)) {
    throw new Error("run media-ready --flow-concurrency-override must be an integer from 1 through 5.");
  }
  if (scheduling && flowConcurrencyOverride != null && flowConcurrencyOverride > scheduling.google_flow_concurrency) {
    throw new Error("Flow repair concurrency exceeds the identity-locked Google image scheduling limit.");
  }
  const specs = providerLaneSpecs(identity, profile, { stateRoot }).map((spec) => (
    spec.provider === "google-flow"
      ? {
          ...spec,
          ...(flowModelOverride ? { model_label: flowModelOverride } : {}),
          ...(flowConcurrencyOverride != null ? { concurrency: flowConcurrencyOverride } : {}),
        }
      : spec
  ));
  const phase = String(flags.phase ?? "early");
  const prepare = isTrue(flags.prepare, true);
  const waitForReady = isTrue(flags["wait-for-ready"], phase !== "early");
  const timeoutMs = Math.max(1_000, Number(flags["timeout-ms"] ?? 180_000));
  const initial = await Promise.all(specs.map((spec) => inspectProviderLane(spec)));
  const launches = prepare
    ? (await Promise.all(specs.map(async (spec, index) => initial[index].status === "passed"
      ? null
      : ({ provider: spec.provider, ...await launchProviderHost(
          spec,
          path.join(stateRoot, "provider-host-logs"),
        ) })))).filter(Boolean)
    : [];
  const lanes = prepare && waitForReady && initial.some((lane) => lane.status !== "passed")
    ? await waitForLanes(specs, { timeoutMs })
    : initial;
  const decision = providerReadinessDecision(lanes, {
    phase,
    geminiRequiredThroughStyleBarrier: readinessPolicy.gemini_required_through_style_reference_barrier !== false,
  });
  const reportStatus = !waitForReady && decision.status === "blocked"
    ? "preparing"
    : decision.status;
  const generatedAt = new Date();
  const report = {
    schema: PROVIDER_READINESS_SCHEMA,
    version: PROVIDER_READINESS_VERSION,
    status: reportStatus,
    generated_at: generatedAt.toISOString(),
    phase,
    episode_dir: episodeDir,
    run_identity_path: identityPath,
    run_identity_sha256: sha256(identityBytes),
    production_profile: profile.id,
    policy: readinessPolicy,
    ...(scheduling ? { image_scheduling: scheduling, image_admission_capacity: {
      combined_submission_ceiling_per_hour: 3_600_000 / scheduling.minimum_submit_interval_ms,
      combined_submission_rate_at_max_jitter_per_hour: 3_600_000 / (scheduling.minimum_submit_interval_ms + scheduling.submit_jitter_max_ms),
      combined_submission_rate_at_mean_jitter_per_hour: 3_600_000 / (scheduling.minimum_submit_interval_ms + scheduling.submit_jitter_max_ms / 2),
      interpretation: "admission_only; actual accepted throughput may be lower due to generation latency and failures; stock wall-clock SLO remains report-only",
    } } : {}),
    provider_model_override: flowModelOverride || flowConcurrencyOverride != null ? {
      provider: "google-flow",
      identity_locked_model: identity.image_provider_options?.google_flow?.model_label ?? null,
      repair_model: flowModelOverride || null,
      repair_concurrency: flowConcurrencyOverride,
      reason: repairReason,
    } : null,
    preparation_requested: prepare,
    wait_for_ready: waitForReady,
    launches,
    decision,
    lanes,
  };
  const currentPath = path.join(episodeDir, `provider_readiness_${identity.episode ?? path.basename(episodeDir)}.json`);
  const immutablePath = path.join(
    episodeDir,
    "reports",
    "provider_readiness",
    `provider_readiness_${phase}_${generatedAt.toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await writeJsonAtomic(immutablePath, report);
  await writeJsonAtomic(currentPath, { ...report, immutable_report_path: immutablePath });
  console.log(JSON.stringify({
    status: reportStatus,
    report_path: currentPath,
    immutable_report_path: immutablePath,
    phase,
    blocking_providers: decision.blocking_providers,
    dispatch_policy: decision.dispatch_policy,
    launches,
  }, null, 2));
  if (reportStatus === "blocked") process.exitCode = 2;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}

export { launchProviderHost, portIsOccupied, waitForLanes };
