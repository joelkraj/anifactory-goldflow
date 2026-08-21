import {
  federatedPlanningRoomEnabled,
  plannerStageClass,
  planningProvidersForStage,
} from "./planner-provider-registry.mjs";
import {
  planningIdentityFromProcessContext,
  planningProviderForIdentity,
} from "./planning-runtime-policy.mjs";

const activeByProvider = new Map();
const healthByProvider = new Map();
const waiters = [];
const TRANSIENT_FAILURE_THRESHOLD = 3;

function providerHealth(provider) {
  return healthByProvider.get(provider) ?? {
    open: false,
    consecutive_failures: 0,
    reason: null,
  };
}

function fatalProviderFailure(error) {
  return /authentication required|authentication timed out|eligibility check failed|oauth|unauthorized|forbidden|credentials? (?:expired|missing|invalid)/i
    .test(String(error instanceof Error ? error.message : error ?? ""));
}

function recordProviderSuccess(provider) {
  const current = providerHealth(provider);
  if (current.open) return;
  healthByProvider.set(provider, { open: false, consecutive_failures: 0, reason: null });
}

function recordProviderFailure(provider, error) {
  const current = providerHealth(provider);
  const message = String(error instanceof Error ? error.message : error ?? "unknown provider failure").slice(0, 2_000);
  const consecutiveFailures = current.consecutive_failures + 1;
  const open = current.open || fatalProviderFailure(error) || consecutiveFailures >= TRANSIENT_FAILURE_THRESHOLD;
  healthByProvider.set(provider, {
    open,
    consecutive_failures: consecutiveFailures,
    reason: open ? message : null,
  });
  dispatchWaiters();
}

function nonnegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function poolRows(identity, stageName, env) {
  if (planningProviderForIdentity(identity, { missingIsLegacy: true }) !== "planning_room") return [];
  if (!federatedPlanningRoomEnabled(identity) || plannerStageClass(stageName) !== "structured_planning") return [];
  const configured = identity?.planning_room?.structured_pool?.providers
    ?? identity?.provider_locks?.planning_room?.structured_pool?.providers
    ?? {};
  const available = new Set(planningProvidersForStage(identity, stageName, { env }));
  return ["codex_cli", "antigravity_cli"]
    .filter((provider) => available.has(provider))
    .map((provider) => ({
      provider,
      concurrency: nonnegativeInteger(configured?.[provider]?.concurrency, provider === "codex_cli" ? 8 : 0),
    }))
    .filter((row) => row.concurrency > 0);
}

function claim(rows) {
  const candidates = rows
    .filter((row) => providerHealth(row.provider).open !== true)
    .filter((row) => Number(activeByProvider.get(row.provider) ?? 0) < row.concurrency)
    .sort((left, right) => {
      const leftRatio = Number(activeByProvider.get(left.provider) ?? 0) / left.concurrency;
      const rightRatio = Number(activeByProvider.get(right.provider) ?? 0) / right.concurrency;
      return leftRatio - rightRatio || right.concurrency - left.concurrency || left.provider.localeCompare(right.provider);
    });
  const selected = candidates[0];
  if (!selected) return null;
  activeByProvider.set(selected.provider, Number(activeByProvider.get(selected.provider) ?? 0) + 1);
  return selected.provider;
}

function dispatchWaiters() {
  for (let index = 0; index < waiters.length;) {
    const waiter = waiters[index];
    const healthyRows = waiter.rows.filter((row) => providerHealth(row.provider).open !== true);
    if (!healthyRows.length) {
      waiters.splice(index, 1);
      waiter.reject(new Error(`All federated planner providers opened their circuit for ${waiter.stageName}.`));
      continue;
    }
    const provider = claim(waiter.rows);
    if (!provider) {
      index += 1;
      continue;
    }
    waiters.splice(index, 1);
    waiter.resolve(provider);
  }
}

function releaseProvider(provider) {
  activeByProvider.set(provider, Math.max(0, Number(activeByProvider.get(provider) ?? 0) - 1));
  dispatchWaiters();
}

export async function acquireFederatedPlannerSlot({
  stageName,
  explicitProvider = null,
  identity = null,
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  if (explicitProvider) return null;
  const resolvedIdentity = identity ?? planningIdentityFromProcessContext({ argv, env }).identity;
  const rows = poolRows(resolvedIdentity, stageName, env);
  if (!rows.length) return null;
  const provider = claim(rows) ?? await new Promise((resolve, reject) => waiters.push({ rows, resolve, reject, stageName }));
  let released = false;
  return {
    provider,
    recordSuccess() {
      recordProviderSuccess(provider);
    },
    recordFailure(error) {
      recordProviderFailure(provider, error);
    },
    release() {
      if (released) return;
      released = true;
      releaseProvider(provider);
    },
  };
}

export function federatedPlannerPoolSnapshotForTests() {
  return {
    active: Object.fromEntries(activeByProvider),
    health: Object.fromEntries(healthByProvider),
    waiting: waiters.length,
  };
}

export function resetFederatedPlannerPoolForTests() {
  if (waiters.length) throw new Error("Cannot reset the planner pool while calls are waiting.");
  activeByProvider.clear();
  healthByProvider.clear();
}
