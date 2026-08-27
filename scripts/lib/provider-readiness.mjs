import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROVIDER_READINESS_SCHEMA = "goldflow_provider_readiness_v1";
export const PROVIDER_READINESS_VERSION = "2026-08-27.1";

export const PROVIDER_LANE_DEFAULTS = Object.freeze({
  "google-flow": Object.freeze({
    provider: "google-flow",
    port: 4318,
    concurrency: 5,
    worker_types: "image",
    worker_session_policy: "persistent_project_per_worker_slot_v1",
    plan_flag: "flow-plan",
    model_flag: "flow-model",
  }),
  "google-gemini": Object.freeze({
    provider: "google-gemini",
    port: 4319,
    concurrency: 3,
    worker_types: "llm,image",
    worker_session_policy: "persistent_tab_per_worker_slot_v1",
    plan_flag: "gemini-plan",
    model_flag: "gemini-model",
  }),
});

function cleanText(value) {
  return String(value ?? "").trim();
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function processIsLive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

export function providerStatePaths(provider, stateRoot = path.join(os.homedir(), ".goldflow-studio")) {
  const root = path.resolve(stateRoot);
  return {
    state_root: root,
    studio_runtime_path: path.join(root, "providers", provider, "studio-runtime.json"),
    worker_runtime_path: path.join(root, `${provider}-desktop-worker-runtime.json`),
  };
}

function identityProviderSettings(identity, provider) {
  const options = identity?.image_provider_options ?? {};
  const locks = identity?.provider_locks ?? {};
  if (provider === "google-flow") {
    return {
      plan_label: cleanText(options?.google_flow?.plan_label ?? locks.google_flow_plan_label ?? process.env.GOLDFLOW_FLOW_PLAN ?? "ULTRA"),
      model_label: cleanText(options?.google_flow?.model_label ?? locks.google_flow_model_label ?? process.env.GOLDFLOW_FLOW_MODEL ?? "Nano Banana Pro"),
    };
  }
  return {
    plan_label: cleanText(options?.google_gemini?.plan_label ?? locks.google_gemini_plan_label ?? process.env.GOLDFLOW_GEMINI_PLAN ?? "Ultra"),
    model_label: cleanText(options?.google_gemini?.model_label ?? locks.google_gemini_model_label ?? process.env.GOLDFLOW_GEMINI_MODEL ?? "Nano Banana 2"),
  };
}

export function providerLaneSpecs(identity, profile, { stateRoot = null } = {}) {
  const readiness = profile?.orchestration?.provider_readiness_gate ?? {};
  if (readiness.required !== true) return [];
  return ["google-flow", "google-gemini"].map((provider) => {
    const base = PROVIDER_LANE_DEFAULTS[provider];
    const settings = identityProviderSettings(identity, provider);
    const paths = providerStatePaths(provider, stateRoot ?? undefined);
    return {
      ...base,
      ...settings,
      ...paths,
      endpoint: `http://127.0.0.1:${base.port}`,
      runtime_freshness_max_ms: Math.max(15_000, Number(
        readiness.worker_runtime_freshness_max_ms ?? 60_000,
      )),
      required_role: provider === "google-flow" ? "deadline_primary" : "style_barrier_then_top_off",
    };
  });
}

export async function fetchHealth(endpoint, { timeoutMs = 5_000, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${String(endpoint).replace(/\/+$/, "")}/v1/health`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectProviderLane(spec, {
  readJsonImpl = readJson,
  processLiveImpl = processIsLive,
  fetchHealthImpl = fetchHealth,
  nowMs = Date.now(),
} = {}) {
  const checkedAt = new Date(nowMs).toISOString();
  const [studioRuntime, workerRuntime, healthResult] = await Promise.all([
    readJsonImpl(spec.studio_runtime_path, null),
    readJsonImpl(spec.worker_runtime_path, null),
    fetchHealthImpl(spec.endpoint).then((health) => ({ health, error: null })).catch((error) => ({
      health: null,
      error: error instanceof Error ? error.message : String(error),
    })),
  ]);
  const health = healthResult.health;
  const readySlots = Array.isArray(workerRuntime?.worker_pool?.ready_slots)
    ? workerRuntime.worker_pool.ready_slots
    : [];
  const preparedPolicies = Array.isArray(workerRuntime?.worker_pool?.prepared_session_policies)
    ? workerRuntime.worker_pool.prepared_session_policies
    : [];
  const findings = [];
  const require = (condition, code, detail) => {
    if (!condition) findings.push({ code, detail });
  };
  require(Boolean(health), "health_endpoint_unavailable", healthResult.error ?? "No health response.");
  require(health?.status === "ok", "health_status_not_ok", cleanText(health?.status) || "missing");
  require(health?.service === "goldflow-studio", "wrong_health_service", cleanText(health?.service) || "missing");
  require(health?.browser_provider === spec.provider, "health_provider_mismatch", `${health?.browser_provider ?? "missing"} != ${spec.provider}`);
  require(cleanText(health?.ui_contract?.account_plan) === spec.plan_label, "health_plan_mismatch", `${health?.ui_contract?.account_plan ?? "missing"} != ${spec.plan_label}`);
  require(cleanText(health?.ui_contract?.model_label) === spec.model_label, "health_model_mismatch", `${health?.ui_contract?.model_label ?? "missing"} != ${spec.model_label}`);
  require(studioRuntime?.status === "running", "studio_runtime_not_running", cleanText(studioRuntime?.status) || "missing");
  require(studioRuntime?.browser_provider === spec.provider, "studio_provider_mismatch", cleanText(studioRuntime?.browser_provider) || "missing");
  require(Number(studioRuntime?.port) === spec.port, "studio_port_mismatch", `${studioRuntime?.port ?? "missing"} != ${spec.port}`);
  require(processLiveImpl(studioRuntime?.pid), "studio_pid_not_live", String(studioRuntime?.pid ?? "missing"));
  require(workerRuntime?.status === "running", "worker_runtime_not_running", cleanText(workerRuntime?.status) || "missing");
  require(workerRuntime?.browser_provider === spec.provider, "worker_provider_mismatch", cleanText(workerRuntime?.browser_provider) || "missing");
  require(processLiveImpl(workerRuntime?.pid), "worker_pid_not_live", String(workerRuntime?.pid ?? "missing"));
  require(Number(workerRuntime?.concurrency) === spec.concurrency, "worker_concurrency_mismatch", `${workerRuntime?.concurrency ?? "missing"} != ${spec.concurrency}`);
  require(workerRuntime?.worker_pool?.policy === spec.worker_session_policy, "worker_policy_mismatch", cleanText(workerRuntime?.worker_pool?.policy) || "missing");
  require(preparedPolicies.includes(spec.worker_session_policy), "worker_policy_not_prepared", spec.worker_session_policy);
  const observedSlotIds = readySlots
    .map((row) => Number(row?.slot))
    .filter((slot) => Number.isInteger(slot))
    .sort((left, right) => left - right);
  const expectedSlotIds = Array.from({ length: spec.concurrency }, (_, slot) => slot);
  require(
    readySlots.length === spec.concurrency
      && new Set(observedSlotIds).size === spec.concurrency
      && JSON.stringify(observedSlotIds) === JSON.stringify(expectedSlotIds),
    "worker_slots_not_ready",
    `${JSON.stringify(observedSlotIds)}/${JSON.stringify(expectedSlotIds)}`,
  );
  const slotSurfacesReady = readySlots.every((row) => {
    const surface = cleanText(spec.provider === "google-flow" ? row?.project_url : row?.surface_url);
    if (!surface) return false;
    try {
      const url = new URL(surface);
      return spec.provider === "google-flow"
        ? url.origin === "https://labs.google" && /\/fx\/tools\/flow\/project\//.test(url.pathname)
        : url.origin === "https://gemini.google.com" && /^\/images(?:[/?#]|$)/.test(url.pathname);
    } catch {
      return false;
    }
  });
  require(slotSurfacesReady, "worker_slot_surface_not_ready", spec.provider);
  const workerUpdatedAtMs = Date.parse(cleanText(workerRuntime?.updated_at));
  const workerRuntimeAgeMs = Number.isFinite(workerUpdatedAtMs)
    ? Math.max(0, nowMs - workerUpdatedAtMs)
    : null;
  require(
    workerRuntimeAgeMs != null && workerRuntimeAgeMs <= spec.runtime_freshness_max_ms,
    "worker_runtime_stale",
    workerRuntimeAgeMs == null ? "missing updated_at" : `${workerRuntimeAgeMs}ms > ${spec.runtime_freshness_max_ms}ms`,
  );
  require(!workerRuntime?.dispatch_policy?.provider_circuit, "provider_circuit_open", JSON.stringify(workerRuntime?.dispatch_policy?.provider_circuit ?? null));
  return {
    provider: spec.provider,
    status: findings.length ? "blocked" : "passed",
    checked_at: checkedAt,
    endpoint: spec.endpoint,
    expected: {
      port: spec.port,
      concurrency: spec.concurrency,
      plan_label: spec.plan_label,
      model_label: spec.model_label,
      worker_session_policy: spec.worker_session_policy,
      runtime_freshness_max_ms: spec.runtime_freshness_max_ms,
    },
    observed: {
      health: health ? {
        status: health.status ?? null,
        service: health.service ?? null,
        browser_provider: health.browser_provider ?? null,
        worker_slot_ceiling: health.worker_slot_ceiling ?? null,
        active_image_worker_session_policies: health.active_image_worker_session_policies ?? [],
        ui_contract: health.ui_contract ?? null,
      } : null,
      studio_runtime: studioRuntime ? {
        status: studioRuntime.status ?? null,
        pid: studioRuntime.pid ?? null,
        port: studioRuntime.port ?? null,
        browser_provider: studioRuntime.browser_provider ?? null,
      } : null,
      worker_runtime: workerRuntime ? {
        status: workerRuntime.status ?? null,
        pid: workerRuntime.pid ?? null,
        browser_provider: workerRuntime.browser_provider ?? null,
        concurrency: workerRuntime.concurrency ?? null,
        updated_at: workerRuntime.updated_at ?? null,
        runtime_age_ms: workerRuntimeAgeMs,
        worker_pool: workerRuntime.worker_pool ?? null,
        provider_circuit: workerRuntime.dispatch_policy?.provider_circuit ?? null,
      } : null,
    },
    findings,
  };
}

export function providerReadinessDecision(lanes, {
  phase = "early",
  geminiRequiredThroughStyleBarrier = true,
} = {}) {
  const byProvider = new Map((lanes ?? []).map((lane) => [lane.provider, lane]));
  const flowReady = byProvider.get("google-flow")?.status === "passed";
  const geminiReady = byProvider.get("google-gemini")?.status === "passed";
  const styleBarrierPending = ["early", "reference_generation", "style_reference_barrier"].includes(String(phase));
  const blockingProviders = [
    ...(!flowReady ? ["google-flow"] : []),
    ...(geminiRequiredThroughStyleBarrier && styleBarrierPending && !geminiReady ? ["google-gemini"] : []),
  ];
  return {
    status: blockingProviders.length ? "blocked" : geminiReady ? "passed" : "degraded",
    phase,
    flow_ready: flowReady,
    gemini_ready: geminiReady,
    style_reference_barrier_pending: styleBarrierPending,
    blocking_providers: blockingProviders,
    dispatch_policy: flowReady
      ? geminiReady ? "flow_deadline_primary_plus_gemini_top_off" : "flow_deadline_primary_only"
      : "dispatch_held",
  };
}
