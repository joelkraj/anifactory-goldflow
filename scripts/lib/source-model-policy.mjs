import {
  normalizePlanningEffort,
  normalizePlanningProvider,
} from "./planning-runtime-policy.mjs";
import {
  PLANNING_ROOM_PROVIDER,
  plannerModelForProvider,
  plannerStageClass,
  planningProviderForStage,
} from "./planner-provider-registry.mjs";

export const SOURCE_MODEL_CONTRACT_SCHEMA = "goldflow_source_model_contract_v1";
export const SOURCE_MODEL_PROVIDER = "chatgpt_web";
export const SOURCE_MODEL_MODEL = "gpt-5.6-sol";
export const SOURCE_MODEL_REASONING_EFFORT = "max";
export const SOURCE_MODEL_VISIBLE_EFFORT = "Pro";

function effortForProvider(provider) {
  return provider === "chatgpt_web" ? "max" : provider === "gemini_web" ? "high" : "xhigh";
}

function transportForProvider(provider) {
  if (provider === "chatgpt_web") return "authenticated_chatgpt_web";
  if (provider === "gemini_web") return "authenticated_gemini_web";
  if (provider === "antigravity_cli") return "authenticated_antigravity_cli";
  return "local_codex_harness";
}

export function sourceModelContract(flags = {}, { stageName = "winner_source_creative" } = {}) {
  const requestedProvider = flags["planning-provider"] ?? flags.provider ?? null;
  const requestedModel = flags.model ?? null;
  const requestedEffort = flags["reasoning-effort"] ?? null;
  const normalizedRequestedProvider = requestedProvider ? normalizePlanningProvider(requestedProvider) : null;
  const provider = planningProviderForStage(
    { planning_provider: PLANNING_ROOM_PROVIDER },
    stageName,
    { explicitProvider: normalizedRequestedProvider === PLANNING_ROOM_PROVIDER ? null : normalizedRequestedProvider },
  );
  const model = plannerModelForProvider(provider);
  const reasoningEffort = effortForProvider(provider);
  if (requestedModel != null && String(requestedModel).trim() !== model) {
    throw new Error(`Source stage ${stageName} requires model ${model} for provider ${provider}.`);
  }
  if (requestedEffort != null && normalizePlanningEffort(requestedEffort) !== reasoningEffort) {
    throw new Error(`Source stage ${stageName} requires --reasoning-effort ${reasoningEffort} for provider ${provider}.`);
  }

  return {
    schema: SOURCE_MODEL_CONTRACT_SCHEMA,
    provider,
    model,
    reasoning_effort: reasoningEffort,
    visible_effort: provider === "chatgpt_web" ? SOURCE_MODEL_VISIBLE_EFFORT : null,
    transport_requirement: transportForProvider(provider),
    stage_name: stageName,
    stage_class: plannerStageClass(stageName),
    selection_policy: "planning_room_stage_first_available_v1",
  };
}

export function validateSourceModelReceipt(receipt, { expectedContract = sourceModelContract({}) } = {}) {
  const blockers = [];
  if (receipt?.provider !== expectedContract.provider) blockers.push("source_provider_not_stage_locked");
  if (receipt?.model !== expectedContract.model) blockers.push("source_model_not_locked");
  if (receipt?.reasoning_effort !== expectedContract.reasoning_effort) blockers.push("source_reasoning_not_stage_locked");
  return { done: blockers.length === 0, blockers };
}
