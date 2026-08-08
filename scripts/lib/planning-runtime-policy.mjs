import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_PLANNING_PROVIDER = "chatgpt_web";
export const LEGACY_PLANNING_PROVIDER = "codex_cli";
export const DEFAULT_WEB_PLANNING_EFFORT_POLICY = "web_pro_adaptive_v1";
export const DEFAULT_UNIFORM_PLANNING_EFFORT_POLICY = "uniform_v1";
export const DEFAULT_WEB_PLANNING_REASONING_EFFORT = "high";
export const CHATGPT_WEB_PLANNING_MODEL = "gpt-5.6-sol";
export const CHATGPT_WEB_PLANNER_MAX_CONCURRENCY = 10;
export const CHATGPT_WEB_WAVEFRONT_PLANNER_CONCURRENCY = 10;

const supportedEfforts = new Set(["low", "medium", "high", "xhigh", "max"]);

function cliFlags(argv = process.argv.slice(2)) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!String(token).startsWith("--")) continue;
    const key = String(token).slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = "true";
    }
  }
  return flags;
}

export function normalizePlanningProvider(value, fallback = DEFAULT_PLANNING_PROVIDER) {
  const normalized = String(value ?? fallback).trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (["chatgpt-web", "chatgpt", "web", "web-pro"].includes(normalized)) return "chatgpt_web";
  if (["codex", "codex-cli", "native-codex"].includes(normalized)) return "codex_cli";
  if (["local", "qwen", "local-qwen"].includes(normalized)) return "local_qwen";
  throw new Error(`Unsupported planning provider: ${value}`);
}

export function normalizePlanningEffort(value, fallback = DEFAULT_WEB_PLANNING_REASONING_EFFORT) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (!supportedEfforts.has(normalized)) {
    throw new Error(`Unsupported planning reasoning effort: ${value}. Expected low, medium, high, xhigh, or max.`);
  }
  return normalized;
}

export function normalizePlanningEffortPolicy(value, fallback = DEFAULT_WEB_PLANNING_EFFORT_POLICY) {
  const normalized = String(value ?? fallback).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ([DEFAULT_WEB_PLANNING_EFFORT_POLICY, DEFAULT_UNIFORM_PLANNING_EFFORT_POLICY].includes(normalized)) {
    return normalized;
  }
  throw new Error(`Unsupported planning effort policy: ${value}`);
}

export function episodeDirFromProcessContext({ argv = process.argv.slice(2), env = process.env } = {}) {
  const flags = cliFlags(argv);
  if (flags["episode-dir"]) return path.resolve(String(flags["episode-dir"]));
  if (!flags.channel || !flags.week || !flags.episode) return null;
  const dataRoot = env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
  return path.join(
    dataRoot,
    "channels",
    String(flags.channel),
    "weekly_runs",
    String(flags.week),
    "episodes",
    String(flags.episode),
  );
}

export function planningIdentityFromProcessContext(options = {}) {
  const episodeDir = episodeDirFromProcessContext(options);
  if (!episodeDir) return { episodeDir: null, identityPath: null, identity: null };
  const identityPath = path.join(episodeDir, "run_identity.json");
  if (!existsSync(identityPath)) return { episodeDir, identityPath, identity: null };
  try {
    return {
      episodeDir,
      identityPath,
      identity: JSON.parse(readFileSync(identityPath, "utf8")),
    };
  } catch (error) {
    throw new Error(`Invalid planning run identity at ${identityPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function planningProviderForIdentity(identity, { missingIsLegacy = true } = {}) {
  const explicit = identity?.provider_locks?.planning_provider ?? identity?.planning_provider ?? null;
  if (explicit) return normalizePlanningProvider(explicit);
  return missingIsLegacy ? LEGACY_PLANNING_PROVIDER : DEFAULT_PLANNING_PROVIDER;
}

export function planningEffortPolicyForIdentity(identity, provider = planningProviderForIdentity(identity)) {
  const explicit = identity?.provider_locks?.planning_effort_policy ?? identity?.planning_effort_policy ?? null;
  if (explicit) return normalizePlanningEffortPolicy(explicit);
  return provider === "chatgpt_web"
    ? DEFAULT_WEB_PLANNING_EFFORT_POLICY
    : DEFAULT_UNIFORM_PLANNING_EFFORT_POLICY;
}

function providerFromEnvironment(env = process.env) {
  const route = String(env.ANIFACTORY_LLM_ROUTE ?? "").trim();
  if (!route || route.toLowerCase() === "auto") return null;
  return normalizePlanningProvider(route);
}

export function planningRuntimeFromProcessContext({
  explicitProvider = null,
  explicitModel = null,
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const context = planningIdentityFromProcessContext({ argv, env });
  const identityProvider = context.identity
    ? planningProviderForIdentity(context.identity, { missingIsLegacy: true })
    : null;
  const requestedProvider = explicitProvider ? normalizePlanningProvider(explicitProvider) : null;
  if (identityProvider && requestedProvider && identityProvider !== requestedProvider) {
    throw new Error(`Planning provider ${requestedProvider} does not match the run identity lock ${identityProvider}.`);
  }
  const provider = identityProvider
    ?? requestedProvider
    ?? providerFromEnvironment(env)
    ?? DEFAULT_PLANNING_PROVIDER;
  const identityModel = context.identity?.model_versions?.planning_model
    ?? context.identity?.provider_locks?.planning_model
    ?? null;
  if (identityModel && explicitModel && String(identityModel) !== String(explicitModel)) {
    throw new Error(`Planning model ${explicitModel} does not match the run identity lock ${identityModel}.`);
  }
  const model = String(identityModel
    ?? explicitModel
    ?? (provider === "chatgpt_web" ? CHATGPT_WEB_PLANNING_MODEL : env.ANIFACTORY_CODEX_MODEL ?? CHATGPT_WEB_PLANNING_MODEL)).trim();
  if (provider === "chatgpt_web" && model !== CHATGPT_WEB_PLANNING_MODEL) {
    throw new Error(`Authenticated ChatGPT Web planning is locked to ${CHATGPT_WEB_PLANNING_MODEL}; received ${model}.`);
  }
  const effortPolicy = context.identity
    ? planningEffortPolicyForIdentity(context.identity, provider)
    : provider === "chatgpt_web"
      ? DEFAULT_WEB_PLANNING_EFFORT_POLICY
      : DEFAULT_UNIFORM_PLANNING_EFFORT_POLICY;
  const defaultEffort = normalizePlanningEffort(
    context.identity?.provider_locks?.planning_default_reasoning_effort
      ?? context.identity?.model_versions?.planning_reasoning_effort
      ?? (provider === "chatgpt_web"
        ? env.ANIFACTORY_CHATGPT_WEB_REASONING_EFFORT ?? DEFAULT_WEB_PLANNING_REASONING_EFFORT
        : env.ANIFACTORY_CODEX_REASONING_EFFORT ?? "medium"),
    provider === "chatgpt_web" ? DEFAULT_WEB_PLANNING_REASONING_EFFORT : "medium",
  );
  return {
    ...context,
    provider,
    model,
    effortPolicy,
    defaultEffort,
    legacyIdentityAdapter: Boolean(context.identity && !(
      context.identity?.provider_locks?.planning_provider ?? context.identity?.planning_provider
    )),
  };
}

export function webPlannerEffortForStage(stageName, {
  explicitEffort = null,
  policy = DEFAULT_WEB_PLANNING_EFFORT_POLICY,
  fallback = DEFAULT_WEB_PLANNING_REASONING_EFFORT,
} = {}) {
  if (explicitEffort != null) return normalizePlanningEffort(explicitEffort, fallback);
  if (normalizePlanningEffortPolicy(policy) === DEFAULT_UNIFORM_PLANNING_EFFORT_POLICY) {
    return normalizePlanningEffort(fallback);
  }
  const stage = String(stageName ?? "").trim().toLowerCase();
  if (/goldflow_(?:codex|planner)_doctor_probe/.test(stage)) return "medium";
  if (/(?:global_reconciliation|visual_reference_plan_merge|reference_plan_merge|winner_|source_(?:ideate|script)|full_dependent|retention_review|enhancement_judge)/.test(stage)) {
    return "max";
  }
  if (/(?:semantic_scene_plan|visual_reference_plan|reference_anchor|planner_ab)/.test(stage)) return "xhigh";
  if (/(?:editorial_beats|visual_beat|visual_plan|visual_review|script_speakability|transition)/.test(stage)) return "high";
  if (/(?:audio|sfx|score|engagement|overlay)/.test(stage)) return "medium";
  return normalizePlanningEffort(fallback);
}

export function planningEffortForStage(stageName, {
  explicitEffort = null,
  runtime = planningRuntimeFromProcessContext(),
} = {}) {
  if (runtime.provider === "chatgpt_web") {
    return webPlannerEffortForStage(stageName, {
      explicitEffort,
      policy: runtime.effortPolicy,
      fallback: runtime.defaultEffort,
    });
  }
  return normalizePlanningEffort(explicitEffort ?? runtime.defaultEffort, "medium");
}

export function plannerConcurrencyForIdentity(identity, configuredConcurrency, {
  visualPromptWavefront = false,
} = {}) {
  const configured = Math.max(1, Number(configuredConcurrency) || 1);
  if (planningProviderForIdentity(identity, { missingIsLegacy: true }) !== "chatgpt_web") return configured;
  const cap = visualPromptWavefront && identity?.image_provider === "chatgpt_web_gpt_image"
    ? CHATGPT_WEB_WAVEFRONT_PLANNER_CONCURRENCY
    : CHATGPT_WEB_PLANNER_MAX_CONCURRENCY;
  return Math.min(configured, cap);
}
