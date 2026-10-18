import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  PLANNING_ROOM_PROVIDER,
  normalizePlannerProviderId,
  plannerModelForProvider,
  planningProviderForStage,
  planningRoomContract,
} from "./planner-provider-registry.mjs";

export const DEFAULT_PLANNING_PROVIDER = PLANNING_ROOM_PROVIDER;
export const LEGACY_PLANNING_PROVIDER = "codex_cli";
export const DEFAULT_WEB_PLANNING_EFFORT_POLICY = "web_pro_adaptive_v1";
export const DEFAULT_UNIFORM_PLANNING_EFFORT_POLICY = "uniform_v1";
export const DEFAULT_PLANNING_ROOM_EFFORT_POLICY = "planning_room_stage_routed_v1";
export const DEFAULT_WEB_PLANNING_REASONING_EFFORT = "high";
export const CHATGPT_WEB_PLANNING_MODEL = "gpt-6-sol";
export const CHATGPT_WEB_SOURCE_DRAFT_MODELS = Object.freeze(["gpt-6-sol", "gpt-5.5", "gpt-6-astra"]);
export const CHATGPT_WEB_PLANNER_MAX_CONCURRENCY = 10;
export const CHATGPT_WEB_WAVEFRONT_PLANNER_CONCURRENCY = 10;
export const OPERATOR_PLANNING_ROUTE_OVERRIDE_SCHEMA = "goldflow_operator_planning_route_override_v1";

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
  return normalizePlannerProviderId(value, fallback);
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
  if ([
    DEFAULT_WEB_PLANNING_EFFORT_POLICY,
    DEFAULT_UNIFORM_PLANNING_EFFORT_POLICY,
    DEFAULT_PLANNING_ROOM_EFFORT_POLICY,
  ].includes(normalized)) {
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

function sha256FileSync(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function approvedPlanningRouteOverride(context, overrideStage, requestedProvider) {
  if (!context?.episodeDir || !context?.identityPath || !context?.identity || !overrideStage || !requestedProvider) return null;
  const episode = String(context.identity.episode ?? path.basename(context.episodeDir));
  const overridePath = path.join(context.episodeDir, `operator_planning_route_override_${episode}.json`);
  if (!existsSync(overridePath)) return null;
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(overridePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid operator planning route override at ${overridePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const findings = [];
  if (artifact.schema !== OPERATOR_PLANNING_ROUTE_OVERRIDE_SCHEMA) findings.push("schema_mismatch");
  if (artifact.status !== "approved") findings.push("status_not_approved");
  if (artifact.episode !== episode) findings.push("episode_mismatch");
  if (artifact.run_identity_sha256 !== sha256FileSync(context.identityPath)) findings.push("run_identity_hash_mismatch");
  if (normalizePlanningProvider(artifact.from_planning_provider) !== planningProviderForIdentity(context.identity, { missingIsLegacy: true })) findings.push("source_provider_mismatch");
  if (normalizePlanningProvider(artifact.to_planning_provider) !== requestedProvider) findings.push("target_provider_mismatch");
  if (!Array.isArray(artifact.allowed_stages) || !artifact.allowed_stages.includes(String(overrideStage))) findings.push("stage_not_allowed");
  if (artifact.preserve_existing_accepted_outputs !== true) findings.push("preserve_existing_outputs_not_locked");
  if (artifact.exact_id_recovery_only !== true) findings.push("exact_id_recovery_not_locked");
  if (findings.length) throw new Error(`Operator planning route override is invalid for ${overrideStage}: ${findings.join(", ")}`);
  return {
    path: overridePath,
    sha256: sha256FileSync(overridePath),
    stage: String(overrideStage),
    artifact,
  };
}

export function planningEffortPolicyForIdentity(identity, provider = planningProviderForIdentity(identity)) {
  const explicit = identity?.provider_locks?.planning_effort_policy ?? identity?.planning_effort_policy ?? null;
  if (explicit) return normalizePlanningEffortPolicy(explicit);
  if (provider === PLANNING_ROOM_PROVIDER) return DEFAULT_PLANNING_ROOM_EFFORT_POLICY;
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
  overrideStage = null,
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const context = planningIdentityFromProcessContext({ argv, env });
  const identityProviderLock = context.identity
    ? planningProviderForIdentity(context.identity, { missingIsLegacy: true })
    : null;
  const requestedProvider = explicitProvider ? normalizePlanningProvider(explicitProvider) : null;
  const planningRoomLocked = identityProviderLock === PLANNING_ROOM_PROVIDER
    || (!identityProviderLock && (requestedProvider ?? providerFromEnvironment(env) ?? DEFAULT_PLANNING_PROVIDER) === PLANNING_ROOM_PROVIDER);
  const approvedOverride = !planningRoomLocked && identityProviderLock && requestedProvider && identityProviderLock !== requestedProvider
    ? approvedPlanningRouteOverride(context, overrideStage, requestedProvider)
    : null;
  if (!planningRoomLocked && identityProviderLock && requestedProvider && identityProviderLock !== requestedProvider && !approvedOverride) {
    throw new Error(`Planning provider ${requestedProvider} does not match the run identity lock ${identityProviderLock}.`);
  }
  const provider = planningRoomLocked
    ? planningProviderForStage(context.identity ?? { planning_provider: PLANNING_ROOM_PROVIDER }, overrideStage ?? "local_reconciliation", {
        env,
        explicitProvider: requestedProvider && requestedProvider !== PLANNING_ROOM_PROVIDER ? requestedProvider : null,
      })
    : approvedOverride?.artifact
      ? requestedProvider
      : identityProviderLock
        ?? requestedProvider
        ?? providerFromEnvironment(env)
        ?? LEGACY_PLANNING_PROVIDER;
  const identityModel = context.identity?.model_versions?.planning_model
    ?? context.identity?.provider_locks?.planning_model
    ?? null;
  if (!planningRoomLocked && identityModel && explicitModel && String(identityModel) !== String(explicitModel)) {
    throw new Error(`Planning model ${explicitModel} does not match the run identity lock ${identityModel}.`);
  }
  const model = String((planningRoomLocked
    ? explicitModel ?? plannerModelForProvider(provider, context.identity ?? {}, env)
    : identityModel
      ?? explicitModel
      ?? plannerModelForProvider(provider, context.identity ?? {}, env))).trim();
  const sourceDraftModelAllowed = (/^winner_source_script_v3_draft_55_/.test(String(overrideStage ?? ""))
    && model === "gpt-5.5") || (/^winner_source_script_v3_draft_6_/.test(String(overrideStage ?? ""))
    && model === "gpt-6-astra");
  // Explicit directed source edits/reviews do not change a production identity's model lock.
  const directedSourceModelAllowed = !context.identity && explicitModel === "gpt-6-astra"
    && model === "gpt-6-astra"
    && /^winner_source_script_v3_directed_(?:edit|review)_gpt6_[a-z0-9_]+$/.test(String(overrideStage ?? ""));
  if (provider === "chatgpt_web" && model !== CHATGPT_WEB_PLANNING_MODEL && !sourceDraftModelAllowed && !directedSourceModelAllowed) {
    throw new Error(`Authenticated ChatGPT Web planning is locked to ${CHATGPT_WEB_PLANNING_MODEL} except declared GPT-5.5 or GPT-6 source-draft candidates and explicit pre-production GPT-6 directed edits/reviews; received ${model}.`);
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
    providerLock: identityProviderLock,
    planningRoom: planningRoomLocked ? planningRoomContract(context.identity ?? {}) : null,
    model,
    effortPolicy,
    defaultEffort,
    operatorPlanningRouteOverride: approvedOverride,
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
  const normalizedPolicy = normalizePlanningEffortPolicy(policy);
  if (normalizedPolicy === DEFAULT_UNIFORM_PLANNING_EFFORT_POLICY) {
    return normalizePlanningEffort(fallback);
  }
  // Planning-room Web assignments are bounded premium/advisory work. Medium
  // is the locked latency/quality point; critical structured work routes to
  // Codex rather than escalating Web effort on the production path.
  if (normalizedPolicy === DEFAULT_PLANNING_ROOM_EFFORT_POLICY) return "medium";
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
  stageName = "structured_planning",
} = {}) {
  const configured = Math.max(1, Number(configuredConcurrency) || 1);
  const lockedProvider = planningProviderForIdentity(identity, { missingIsLegacy: true });
  const activeProvider = lockedProvider === PLANNING_ROOM_PROVIDER
    ? planningProviderForStage(identity, stageName)
    : lockedProvider;
  if (activeProvider !== "chatgpt_web") return configured;
  const cap = visualPromptWavefront && identity?.image_provider === "chatgpt_web_gpt_image"
    ? CHATGPT_WEB_WAVEFRONT_PLANNER_CONCURRENCY
    : CHATGPT_WEB_PLANNER_MAX_CONCURRENCY;
  return Math.min(configured, cap);
}
