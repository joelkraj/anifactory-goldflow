import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function planningRouteRegistryPath(env = process.env) {
  return path.resolve(env.GOLDFLOW_PLANNING_ROUTE_REGISTRY
    ?? path.join(env.GOLDFLOW_STUDIO_STATE_DIR ?? path.join(os.homedir(), ".goldflow-studio"), "planning-routes.json"));
}

function processIsLive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function readPlanningRouteRegistrySync(env = process.env) {
  try {
    const artifact = JSON.parse(readFileSync(planningRouteRegistryPath(env), "utf8"));
    return artifact?.schema === "goldflow_studio_planning_routes_v1" && processIsLive(artifact.pid) ? artifact : null;
  } catch {
    return null;
  }
}

export function plannerRouteFromRegistry(provider, env = process.env) {
  return readPlanningRouteRegistrySync(env)?.routes?.[provider] ?? null;
}

export async function writePlanningRouteRegistry(routes, env = process.env) {
  const outputPath = planningRouteRegistryPath(env);
  const artifact = {
    schema: "goldflow_studio_planning_routes_v1",
    status: "running",
    pid: process.pid,
    routes,
    updated_at: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, outputPath);
  await fs.chmod(outputPath, 0o600);
  return outputPath;
}

export async function removePlanningRouteRegistry(env = process.env) {
  const outputPath = planningRouteRegistryPath(env);
  const current = readPlanningRouteRegistrySync(env);
  if (current?.pid === process.pid) await fs.rm(outputPath, { force: true });
}
