import { createHash } from "node:crypto";

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
const healthByScope = new Map();
const waiters = [];
const TRANSIENT_FAILURE_THRESHOLD = 3;

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => [key, canonicalJsonValue(value[key])]));
}

function runIdentityKey(identity) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(identity ?? {})))
    .digest("hex");
}

function plannerStageKey(stageName) {
  const stage = String(stageName ?? "structured_planning").trim().toLowerCase();
  const families = [
    ["semantic_scene_plan", /semantic_scene_plan/],
    ["visual_beat_plan", /(?:visual_beat|editorial_beats?)/],
    ["visual_reference_plan", /(?:visual_reference_plan|reference_anchor)/],
    ["visual_prompt_review", /visual_review/],
    ["visual_prompt_plan", /(?:visual_prompt|visual_plan)/],
    ["targeted_speakability", /script_speakability/],
    ["voice_plan", /narration_performance/],
    ["transition_edit_plan", /(?:transition_edit_plan|visual_transition)/],
    ["audio_design_plan", /(?:audio|sfx|score)/],
    ["engagement_plan", /engagement/],
    ["overlay_plan", /overlay/],
  ];
  return families.find(([, pattern]) => pattern.test(stage))?.[0] ?? stage;
}

function scopeKey(identityKey, stageKey, provider) {
  return `${identityKey}:${stageKey}:${provider}`;
}

function scopedProviderHealth(row) {
  return healthByScope.get(row.scope_key) ?? {
    open: false,
    consecutive_failures: 0,
    successful_completions: 0,
    reason: null,
  };
}

function fatalProviderFailure(error) {
  return /authentication required|authentication timed out|eligibility check failed|oauth|unauthorized|forbidden|credentials? (?:expired|missing|invalid)/i
    .test(String(error instanceof Error ? error.message : error ?? ""));
}

function recordProviderSuccess(row) {
  const current = scopedProviderHealth(row);
  if (current.open) return;
  healthByScope.set(row.scope_key, {
    open: false,
    consecutive_failures: 0,
    successful_completions: nonnegativeInteger(current.successful_completions, 0) + 1,
    reason: null,
  });
  dispatchWaiters();
}

function recordProviderFailure(row, error) {
  const current = scopedProviderHealth(row);
  const message = String(error instanceof Error ? error.message : error ?? "unknown provider failure").slice(0, 2_000);
  const consecutiveFailures = current.consecutive_failures + 1;
  const open = current.open || fatalProviderFailure(error) || consecutiveFailures >= TRANSIENT_FAILURE_THRESHOLD;
  healthByScope.set(row.scope_key, {
    open,
    consecutive_failures: consecutiveFailures,
    successful_completions: nonnegativeInteger(current.successful_completions, 0),
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
  const identityKey = runIdentityKey(identity);
  const stageKey = plannerStageKey(stageName);
  return ["codex_cli", "antigravity_cli"]
    .filter((provider) => available.has(provider))
    .map((provider) => ({
      provider,
      run_identity_key: identityKey,
      planner_stage_key: stageKey,
      scope_key: scopeKey(identityKey, stageKey, provider),
      concurrency: nonnegativeInteger(configured?.[provider]?.concurrency, provider === "codex_cli" ? 8 : 0),
      initial_concurrency: nonnegativeInteger(
        configured?.[provider]?.initial_concurrency,
        nonnegativeInteger(configured?.[provider]?.concurrency, provider === "codex_cli" ? 8 : 0),
      ),
      ramp_successes_per_step: nonnegativeInteger(configured?.[provider]?.ramp_successes_per_step, 0),
      ramp_step: nonnegativeInteger(configured?.[provider]?.ramp_step, 0),
    }))
    .filter((row) => row.concurrency > 0);
}

export function effectivePlannerConcurrencyForTests(row, health = {}) {
  const ceiling = Math.max(0, nonnegativeInteger(row?.concurrency, 0));
  const initial = Math.min(ceiling, nonnegativeInteger(row?.initial_concurrency, ceiling));
  const successesPerStep = nonnegativeInteger(row?.ramp_successes_per_step, 0);
  const rampStep = nonnegativeInteger(row?.ramp_step, 0);
  if (!successesPerStep || !rampStep || initial >= ceiling) return ceiling;
  const completedSteps = Math.floor(nonnegativeInteger(health?.successful_completions, 0) / successesPerStep);
  return Math.min(ceiling, initial + completedSteps * rampStep);
}

function claim(rows) {
  const candidates = rows
    .filter((row) => scopedProviderHealth(row).open !== true)
    .filter((row) => Number(activeByProvider.get(row.provider) ?? 0) < effectivePlannerConcurrencyForTests(row, scopedProviderHealth(row)))
    .sort((left, right) => {
      const leftConcurrency = effectivePlannerConcurrencyForTests(left, scopedProviderHealth(left));
      const rightConcurrency = effectivePlannerConcurrencyForTests(right, scopedProviderHealth(right));
      const leftRatio = Number(activeByProvider.get(left.provider) ?? 0) / leftConcurrency;
      const rightRatio = Number(activeByProvider.get(right.provider) ?? 0) / rightConcurrency;
      return leftRatio - rightRatio || rightConcurrency - leftConcurrency || left.provider.localeCompare(right.provider);
    });
  const selected = candidates[0];
  if (!selected) return null;
  activeByProvider.set(selected.provider, Number(activeByProvider.get(selected.provider) ?? 0) + 1);
  return selected;
}

function dispatchWaiters() {
  for (let index = 0; index < waiters.length;) {
    const waiter = waiters[index];
    const healthyRows = waiter.rows.filter((row) => scopedProviderHealth(row).open !== true);
    if (!healthyRows.length) {
      waiters.splice(index, 1);
      waiter.reject(new Error(`All federated planner providers opened their circuit for ${waiter.stageName}.`));
      continue;
    }
    const selected = claim(waiter.rows);
    if (!selected) {
      index += 1;
      continue;
    }
    waiters.splice(index, 1);
    waiter.resolve(selected);
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
  const selected = claim(rows) ?? await new Promise((resolve, reject) => waiters.push({ rows, resolve, reject, stageName }));
  const provider = selected.provider;
  let released = false;
  return {
    provider,
    run_identity_key: selected.run_identity_key,
    planner_stage_key: selected.planner_stage_key,
    pool_scope_key: selected.scope_key,
    recordSuccess() {
      recordProviderSuccess(selected);
    },
    recordFailure(error) {
      recordProviderFailure(selected, error);
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
    health: Object.fromEntries(healthByScope),
    waiting: waiters.length,
  };
}

export function resetFederatedPlannerPoolForTests() {
  if (waiters.length) throw new Error("Cannot reset the planner pool while calls are waiting.");
  activeByProvider.clear();
  healthByScope.clear();
}
