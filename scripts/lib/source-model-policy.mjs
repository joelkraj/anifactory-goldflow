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
export const SOURCE_MODEL_MODEL = "gpt-6-sol";
export const SOURCE_MODEL_REASONING_EFFORT = "medium";
export const SOURCE_MODEL_VISIBLE_EFFORT = "Medium";

export const SOURCE_DRAFT_CANDIDATE_SPECS = Object.freeze([
  Object.freeze({
    id: "draft_56_velocity",
    blind_id: "candidate_a",
    provider: "chatgpt_web",
    model: "gpt-6-sol",
    reasoning_effort: "max",
    visible_effort: "Pro",
    transport: "authenticated_chatgpt_web",
    creative_lens: "velocity_reversal",
  }),
  Object.freeze({
    id: "draft_56_relationship",
    blind_id: "candidate_c",
    provider: "chatgpt_web",
    model: "gpt-6-sol",
    reasoning_effort: "max",
    visible_effort: "Pro",
    transport: "authenticated_chatgpt_web",
    creative_lens: "relationship_pressure",
  }),
  Object.freeze({
    id: "draft_56_strategy",
    blind_id: "candidate_e",
    provider: "chatgpt_web",
    model: "gpt-6-sol",
    reasoning_effort: "max",
    visible_effort: "Pro",
    transport: "authenticated_chatgpt_web",
    creative_lens: "strategic_outplay",
  }),
  Object.freeze({
    id: "draft_55_velocity",
    blind_id: "candidate_b",
    provider: "chatgpt_web",
    model: "gpt-6-sol",
    reasoning_effort: "max",
    visible_effort: "Pro",
    transport: "authenticated_chatgpt_web",
    creative_lens: "velocity_reversal",
  }),
  Object.freeze({
    id: "draft_55_relationship",
    blind_id: "candidate_d",
    provider: "chatgpt_web",
    model: "gpt-6-sol",
    reasoning_effort: "max",
    visible_effort: "Pro",
    transport: "authenticated_chatgpt_web",
    creative_lens: "relationship_pressure",
  }),
  Object.freeze({
    id: "draft_55_strategy",
    blind_id: "candidate_f",
    provider: "chatgpt_web",
    model: "gpt-6-sol",
    reasoning_effort: "max",
    visible_effort: "Pro",
    transport: "authenticated_chatgpt_web",
    creative_lens: "strategic_outplay",
  }),
]);

function effortForProvider(provider) {
  return "medium";
}

function allowsMediumPlanningOverride(stageName) {
  return /^winner_source_(?:ideate|premise|package_tournament|creative_treatment_|story_architecture_creative$)/.test(String(stageName ?? ""));
}

function allowsReconciliationEffortOverride(stageName) {
  return String(stageName ?? "") === "winner_source_story_truth_ir_v2";
}

function visibleEffortForProvider(provider, reasoningEffort) {
  if (provider !== "chatgpt_web") return null;
  if (reasoningEffort === "medium") return "Medium";
  return SOURCE_MODEL_VISIBLE_EFFORT;
}

function transportForProvider(provider) {
  if (provider === "chatgpt_web") return "authenticated_chatgpt_web";
  if (provider === "gemini_web") return "authenticated_gemini_web";
  if (provider === "antigravity_cli") return "authenticated_antigravity_cli";
  return "local_codex_harness";
}

function transportSatisfiesRequirement(actualTransport, requirement) {
  const actual = String(actualTransport ?? "").trim();
  if (!actual) return false;
  if (requirement === "authenticated_chatgpt_web") {
    return ["goldflow_authenticated_browser_jobs", "goldflow_studio_local_api"].includes(actual);
  }
  if (requirement === "authenticated_gemini_web") {
    return ["goldflow_authenticated_gemini_web", "goldflow_studio_local_api"].includes(actual);
  }
  if (requirement === "authenticated_antigravity_cli") return actual === "antigravity_cli";
  if (requirement === "local_codex_harness") return actual === "codex_cli";
  return actual === requirement;
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
  const defaultReasoningEffort = effortForProvider(provider);
  const normalizedRequestedEffort = requestedEffort == null ? null : normalizePlanningEffort(requestedEffort);
  const mediumPlanningOverride = provider === "chatgpt_web"
    && allowsMediumPlanningOverride(stageName)
    && normalizedRequestedEffort === "medium";
  const reconciliationEffortOverride = provider === "codex_cli"
    && allowsReconciliationEffortOverride(stageName)
    && normalizedRequestedEffort === "medium";
  const reasoningEffort = mediumPlanningOverride
    ? "medium"
    : reconciliationEffortOverride
      ? normalizedRequestedEffort
      : defaultReasoningEffort;
  if (requestedModel != null && String(requestedModel).trim() !== model) {
    throw new Error(`Source stage ${stageName} requires model ${model} for provider ${provider}.`);
  }
  if (requestedEffort != null && normalizedRequestedEffort !== reasoningEffort) {
    throw new Error(`Source stage ${stageName} requires --reasoning-effort ${reasoningEffort} for provider ${provider}.`);
  }

  return {
    schema: SOURCE_MODEL_CONTRACT_SCHEMA,
    provider,
    model,
    reasoning_effort: reasoningEffort,
    visible_effort: visibleEffortForProvider(provider, reasoningEffort),
    transport_requirement: transportForProvider(provider),
    stage_name: stageName,
    stage_class: plannerStageClass(stageName),
    selection_policy: "planning_room_stage_first_available_v1",
  };
}

export function sourceDraftCandidateContract(candidateSpec, { stageName } = {}) {
  const spec = SOURCE_DRAFT_CANDIDATE_SPECS.find((row) => row.id === candidateSpec?.id);
  if (!spec) throw new Error(`Unknown source draft candidate contract: ${candidateSpec?.id ?? "missing"}.`);
  for (const field of ["provider", "model", "reasoning_effort", "transport", "creative_lens", "blind_id"]) {
    if (candidateSpec?.[field] !== spec[field]) {
      throw new Error(`Source draft candidate ${spec.id} changed locked ${field}.`);
    }
  }
  return {
    schema: SOURCE_MODEL_CONTRACT_SCHEMA,
    provider: spec.provider,
    model: spec.model,
    reasoning_effort: spec.reasoning_effort,
    visible_effort: spec.visible_effort,
    transport_requirement: spec.transport,
    stage_name: stageName ?? `winner_source_script_v3_${spec.id}`,
    stage_class: "premium_creative",
    selection_policy: "first_class_story_six_candidate_portfolio_v1",
    candidate_id: spec.id,
    blind_id: spec.blind_id,
    creative_lens: spec.creative_lens,
  };
}

export function validateSourceModelReceipt(receipt, { expectedContract = sourceModelContract({}) } = {}) {
  const blockers = [];
  if (receipt?.provider !== expectedContract.provider) blockers.push("source_provider_not_stage_locked");
  if (receipt?.model !== expectedContract.model) blockers.push("source_model_not_locked");
  if (receipt?.reasoning_effort !== expectedContract.reasoning_effort) blockers.push("source_reasoning_not_stage_locked");
  if (!transportSatisfiesRequirement(receipt?.transport, expectedContract.transport_requirement)) blockers.push("source_transport_not_stage_locked");
  return { done: blockers.length === 0, blockers };
}
