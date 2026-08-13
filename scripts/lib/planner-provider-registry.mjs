import { existsSync } from "node:fs";
import { plannerRouteFromRegistry } from "../../apps/goldflow-studio/lib/planning-route-registry.mjs";

export const PLANNING_ROOM_PROVIDER = "planning_room";
export const FEDERATED_PLANNING_ROOM_SCHEMA = "goldflow_planning_room_v2";
export const FEDERATED_PLANNING_ROOM_SELECTION_POLICY = "stage_class_capacity_pool_v1";
export const PLANNER_PROVIDER_IDS = Object.freeze([
  PLANNING_ROOM_PROVIDER,
  "codex_cli",
  "antigravity_cli",
  "gemini_web",
  "chatgpt_web",
  "local_qwen",
]);

export const DEFAULT_PLANNING_ROOM_ROUTES = Object.freeze({
  source_research: Object.freeze(["gemini_web", "chatgpt_web", "codex_cli"]),
  premium_creative: Object.freeze(["chatgpt_web", "gemini_web", "codex_cli"]),
  global_reasoning: Object.freeze(["gemini_web", "chatgpt_web", "codex_cli"]),
  // Antigravity moves ahead of Codex only after its task-class benchmark is
  // explicitly promoted into a future route lock.
  structured_planning: Object.freeze(["codex_cli", "antigravity_cli", "gemini_web", "chatgpt_web"]),
  local_reconciliation: Object.freeze(["codex_cli"]),
});

export const PLANNER_PROVIDER_REGISTRY = Object.freeze({
  codex_cli: Object.freeze({
    id: "codex_cli",
    role: "local_execution_and_reconciliation",
    transport: "codex_cli",
    default_model: "gpt-5.6-sol",
    environment: Object.freeze(["ANIFACTORY_CODEX_CLI_PATH", "CODEX_CLI_PATH"]),
  }),
  antigravity_cli: Object.freeze({
    id: "antigravity_cli",
    role: "structured_concurrent_planning",
    transport: "external_cli",
    default_model: "gemini-3.6-flash-medium",
    environment: Object.freeze(["ANIFACTORY_ANTIGRAVITY_CLI_PATH"]),
  }),
  gemini_web: Object.freeze({
    id: "gemini_web",
    role: "premium_long_context_planning",
    transport: "goldflow_studio_local_api",
    default_model: "gemini-3.6-flash-web",
    environment: Object.freeze(["ANIFACTORY_GEMINI_WEB_URL", "ANIFACTORY_GEMINI_WEB_TOKEN"]),
  }),
  chatgpt_web: Object.freeze({
    id: "chatgpt_web",
    role: "premium_creative_planning",
    transport: "goldflow_studio_or_authenticated_browser",
    default_model: "gpt-5.6-sol",
    environment: Object.freeze(["ANIFACTORY_CHATGPT_WEB_URL", "ANIFACTORY_CHATGPT_WEB_TOKEN"]),
  }),
  local_qwen: Object.freeze({
    id: "local_qwen",
    role: "optional_local_volume_planning",
    transport: "openai_compatible_local_api",
    default_model: "Qwen3.6-35B-A3B-OptiQ-4bit",
    environment: Object.freeze(["ANIFACTORY_LOCAL_LLM_URL"]),
  }),
});

export function normalizePlannerProviderId(value, fallback = PLANNING_ROOM_PROVIDER) {
  const normalized = String(value ?? fallback).trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (["room", "planning-room", "multi-agent", "multi-provider"].includes(normalized)) return PLANNING_ROOM_PROVIDER;
  if (["chatgpt-web", "chatgpt", "web", "web-pro"].includes(normalized)) return "chatgpt_web";
  if (["gemini-web", "gemini", "google-gemini", "gemini-pro"].includes(normalized)) return "gemini_web";
  if (["antigravity", "antigravity-cli", "google-antigravity"].includes(normalized)) return "antigravity_cli";
  if (["codex", "codex-cli", "native-codex"].includes(normalized)) return "codex_cli";
  if (["local", "qwen", "local-qwen"].includes(normalized)) return "local_qwen";
  throw new Error(`Unsupported planning provider: ${value}`);
}

export function plannerStageClass(stageName = "") {
  const stage = String(stageName ?? "").trim().toLowerCase();
  if (/(?:source_(?:deep_)?research|market_research|fact_research|research_dossier)/.test(stage)) return "source_research";
  if (/(?:global_reconciliation|global_reasoning|continuity|reference_plan_merge|full_dependent|retention_review|retention_map|diagnostic|enhancement_judge|audit)/.test(stage)) return "global_reasoning";
  if (/(?:winner_(?:ideation|story_blueprint|opening_generation|script_generation|integrated_revision|line_flow_polish)|source_(?:ideate|blueprint|opening|script|revise|polish)|package|thumbnail|title|premise|creative)/.test(stage)) return "premium_creative";
  if (/(?:semantic|narration_performance|visual_beat|editorial_beat|visual_reference|reference_anchor|visual_plan|visual_prompt|visual_review|transition|audio|sfx|score|engagement|overlay)/.test(stage)) return "structured_planning";
  return "local_reconciliation";
}

function executableAvailable(explicitPath, fallbackCommand) {
  if (explicitPath) return existsSync(explicitPath);
  const searchPath = String(process.env.PATH ?? "").split(":").filter(Boolean);
  return searchPath.some((directory) => existsSync(`${directory}/${fallbackCommand}`));
}

export function plannerProviderAvailability(provider, env = process.env) {
  const id = normalizePlannerProviderId(provider);
  if (id === PLANNING_ROOM_PROVIDER) return { available: true, reason: "planning_room_router" };
  if (id === "codex_cli") {
    const explicit = env.ANIFACTORY_CODEX_CLI_PATH ?? env.CODEX_CLI_PATH ?? null;
    return executableAvailable(explicit, "codex")
      ? { available: true, reason: explicit ? "explicit_executable" : "path_executable" }
      : { available: false, reason: "codex_cli_not_found" };
  }
  if (id === "antigravity_cli") {
    const explicit = env.ANIFACTORY_ANTIGRAVITY_CLI_PATH ?? null;
    return (executableAvailable(explicit, "agy") || (!explicit && executableAvailable(null, "antigravity")))
      ? { available: true, reason: explicit ? "explicit_executable" : "path_executable" }
      : { available: false, reason: "antigravity_cli_not_found" };
  }
  if (id === "gemini_web") {
    const registered = plannerRouteFromRegistry("gemini_web", env);
    return (String(env.ANIFACTORY_GEMINI_WEB_URL ?? "").trim() && String(env.ANIFACTORY_GEMINI_WEB_TOKEN ?? "").trim()) || registered
      ? { available: true, reason: "studio_endpoint_configured" }
      : { available: false, reason: "gemini_web_studio_endpoint_not_configured" };
  }
  if (id === "chatgpt_web") {
    const registered = plannerRouteFromRegistry("chatgpt_web", env);
    const localConfigured = String(env.ANIFACTORY_CHATGPT_WEB_URL ?? "").trim()
      && String(env.ANIFACTORY_CHATGPT_WEB_TOKEN ?? "").trim() || Boolean(registered);
    const browserRuntime = String(env.GOLDFLOW_CHATGPT_WEB_RUNTIME ?? "").trim();
    return localConfigured || browserRuntime
      ? { available: true, reason: localConfigured ? "studio_endpoint_configured" : "authenticated_browser_runtime_configured" }
      : { available: true, reason: "authenticated_browser_runtime_default_path" };
  }
  if (id === "local_qwen") {
    return String(env.ANIFACTORY_LOCAL_LLM_URL ?? "").trim()
      ? { available: true, reason: "local_endpoint_configured" }
      : { available: false, reason: "local_qwen_endpoint_not_configured" };
  }
  return { available: false, reason: "unsupported_provider" };
}

function normalizedRouteRows(identity = {}) {
  const configured = identity?.planning_room?.stage_routes
    ?? identity?.provider_locks?.planning_room?.stage_routes
    ?? {};
  return Object.fromEntries(Object.entries(DEFAULT_PLANNING_ROOM_ROUTES).map(([stageClass, defaults]) => {
    const requested = Array.isArray(configured?.[stageClass]) ? configured[stageClass] : defaults;
    const rows = [...new Set(requested.map((provider) => normalizePlannerProviderId(provider)))]
      .filter((provider) => provider !== PLANNING_ROOM_PROVIDER);
    return [stageClass, rows.length ? rows : [...defaults]];
  }));
}

export function federatedPlanningRoomEnabled(identity = {}) {
  return identity?.planning_room?.schema === FEDERATED_PLANNING_ROOM_SCHEMA
    || identity?.provider_locks?.planning_room?.schema === FEDERATED_PLANNING_ROOM_SCHEMA
    || identity?.production_profile_config?.planner?.federated_structured_pool === true;
}

export function planningProvidersForStage(identity, stageName, { env = process.env, availableOnly = true } = {}) {
  const providers = normalizedRouteRows(identity)[plannerStageClass(stageName)] ?? [];
  return availableOnly
    ? providers.filter((provider) => plannerProviderAvailability(provider, env).available)
    : providers;
}

function structuredPoolContract(identity = {}) {
  const planner = identity?.production_profile_config?.planner ?? {};
  return {
    assignment_policy: String(planner.structured_pool_assignment_policy ?? "weighted_least_utilized_v1"),
    providers: {
      codex_cli: { concurrency: Math.max(1, Number(planner.codex_cli_structured_concurrency) || 8) },
      antigravity_cli: { concurrency: Math.max(1, Number(planner.antigravity_cli_structured_concurrency) || 3) },
    },
  };
}

export function planningRoomContract(identity = {}) {
  const federated = federatedPlanningRoomEnabled(identity);
  return {
    schema: federated ? FEDERATED_PLANNING_ROOM_SCHEMA : "goldflow_planning_room_v1",
    selection_policy: federated ? FEDERATED_PLANNING_ROOM_SELECTION_POLICY : "stage_class_first_available_v1",
    deterministic_local_reconciliation_provider: "codex_cli",
    stage_routes: normalizedRouteRows(identity),
    ...(federated ? {
      structured_pool: structuredPoolContract(identity),
      premium_web_policy: "distinct_stage_assignments_no_duplicate_authoring_v1",
    } : {}),
    provider_registry: Object.fromEntries(Object.entries(PLANNER_PROVIDER_REGISTRY).map(([id, row]) => [id, {
      role: row.role,
      transport: row.transport,
      default_model: row.default_model,
    }])),
  };
}

export function planningProviderForStage(identity, stageName, { env = process.env, explicitProvider = null } = {}) {
  const topLevel = normalizePlannerProviderId(
    identity?.provider_locks?.planning_provider
      ?? identity?.planning_provider
      ?? PLANNING_ROOM_PROVIDER,
  );
  if (topLevel !== PLANNING_ROOM_PROVIDER) return topLevel;
  const stageClass = plannerStageClass(stageName);
  const route = normalizedRouteRows(identity)[stageClass];
  if (explicitProvider) {
    const requested = normalizePlannerProviderId(explicitProvider);
    if (!route.includes(requested)) {
      throw new Error(`Planning provider ${requested} is not approved for ${stageClass}; route is ${route.join(", ")}.`);
    }
    const availability = plannerProviderAvailability(requested, env);
    if (!availability.available) throw new Error(`Planning provider ${requested} is unavailable: ${availability.reason}.`);
    return requested;
  }
  const selected = route.find((provider) => plannerProviderAvailability(provider, env).available);
  if (!selected) {
    const evidence = route.map((provider) => `${provider}:${plannerProviderAvailability(provider, env).reason}`).join(", ");
    throw new Error(`No planning provider is available for ${stageClass}: ${evidence}.`);
  }
  return selected;
}

export function plannerModelForProvider(provider, identity = {}, env = process.env) {
  const id = normalizePlannerProviderId(provider);
  const locked = identity?.provider_locks?.planning_provider_models?.[id]
    ?? identity?.planning_room?.provider_models?.[id]
    ?? null;
  if (locked) return String(locked);
  if (id === "codex_cli") return String(env.ANIFACTORY_CODEX_MODEL ?? PLANNER_PROVIDER_REGISTRY[id].default_model);
  if (id === "antigravity_cli") return String(env.ANIFACTORY_ANTIGRAVITY_MODEL ?? PLANNER_PROVIDER_REGISTRY[id].default_model);
  if (id === "gemini_web") return String(env.ANIFACTORY_GEMINI_WEB_MODEL ?? PLANNER_PROVIDER_REGISTRY[id].default_model);
  if (id === "chatgpt_web") return String(env.ANIFACTORY_CHATGPT_WEB_MODEL ?? PLANNER_PROVIDER_REGISTRY[id].default_model);
  if (id === "local_qwen") return String(env.ANIFACTORY_LOCAL_LLM_MODEL ?? PLANNER_PROVIDER_REGISTRY[id].default_model);
  throw new Error(`Planning-room provider ${id} has no direct model.`);
}
