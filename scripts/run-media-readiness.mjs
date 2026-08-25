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
    `--${spec.plan_flag}`, spec.plan_label,
    `--${spec.model_flag}`, spec.model_label,
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

async function waitForLanes(specs, { timeoutMs, pollMs = 2_000 } = {}) {
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
  const profile = productionProfileForIdentity(identity);
  const readinessPolicy = profile.orchestration?.provider_readiness_gate ?? {};
  if (readinessPolicy.required !== true) {
    console.log(JSON.stringify({ status: "skipped", reason: "profile_provider_readiness_not_required", production_profile: profile.id }, null, 2));
    return;
  }
  const stateRoot = path.resolve(flags["state-root"] ?? process.env.GOLDFLOW_STUDIO_STATE_DIR ?? path.join(os.homedir(), ".goldflow-studio"));
  const specs = providerLaneSpecs(identity, profile, { stateRoot });
  const phase = String(flags.phase ?? "early");
  const prepare = isTrue(flags.prepare, true);
  const timeoutMs = Math.max(1_000, Number(flags["timeout-ms"] ?? 180_000));
  const initial = await Promise.all(specs.map((spec) => inspectProviderLane(spec)));
  const launches = [];
  if (prepare) {
    for (let index = 0; index < specs.length; index += 1) {
      if (initial[index].status === "passed") continue;
      launches.push({ provider: specs[index].provider, ...await launchProviderHost(
        specs[index],
        path.join(stateRoot, "provider-host-logs"),
      ) });
    }
  }
  const lanes = prepare && launches.some((row) => row.launched)
    ? await waitForLanes(specs, { timeoutMs })
    : initial;
  const decision = providerReadinessDecision(lanes, {
    phase,
    geminiRequiredThroughStyleBarrier: readinessPolicy.gemini_required_through_style_reference_barrier !== false,
  });
  const generatedAt = new Date();
  const report = {
    schema: PROVIDER_READINESS_SCHEMA,
    version: PROVIDER_READINESS_VERSION,
    status: decision.status,
    generated_at: generatedAt.toISOString(),
    phase,
    episode_dir: episodeDir,
    run_identity_path: identityPath,
    run_identity_sha256: sha256(identityBytes),
    production_profile: profile.id,
    policy: readinessPolicy,
    preparation_requested: prepare,
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
    status: decision.status,
    report_path: currentPath,
    immutable_report_path: immutablePath,
    phase,
    blocking_providers: decision.blocking_providers,
    dispatch_policy: decision.dispatch_policy,
    launches,
  }, null, 2));
  if (decision.status === "blocked") process.exitCode = 2;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}

export { launchProviderHost, portIsOccupied, waitForLanes };
