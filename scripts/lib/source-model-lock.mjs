// Per-run model choice for source manufacture. The lock is written once per development folder
// and every later stage uses it; flags that disagree with it stop instead of switching models.
export const MANUFACTURING_MODEL_LOCK_SCHEMA = "goldflow_manhwa_manufacturing_model_lock_v1";
// planning covers ideation, the shortlist and template filling.
export const MANUFACTURING_MODEL_LOCK_ROLES = Object.freeze(["planning", "writer", "diagnose", "revise", "verify"]);

// Selectable models, CLI transports only. gpt-6.1-sol was confirmed by an accepted codex exec
// smoke call (docs/proofs/codex_gpt61_sol_smoke_v1). Browser automation is retired.
export const SUPPORTED_SOURCE_MODELS = Object.freeze({
  codex_cli: Object.freeze(["gpt-6.1-sol", "gpt-6-sol"]),
  claude_cli: Object.freeze(["claude-fable-5-1", "claude-opus-5-5"]),
});
// Historical providers stay readable in recorded locks; they are never selected for new work.
export const HISTORICAL_SOURCE_PROVIDERS = Object.freeze(["chatgpt_web"]);
export const DEFAULT_SOURCE_MODEL = "gpt-6.1-sol";
export const DEFAULT_CLAUDE_SOURCE_MODEL = "claude-fable-5-1";
const DEFAULT_EFFORTS = Object.freeze({ planning: "medium", writer: "max", diagnose: "high", revise: "high", verify: "medium" });

export function providerForSourceModel(model) {
  const value = String(model ?? "").trim();
  const provider = Object.keys(SUPPORTED_SOURCE_MODELS).find((key) => SUPPORTED_SOURCE_MODELS[key].includes(value));
  if (!provider) {
    throw new Error(`Unsupported source model: ${model}. Supported: ${Object.values(SUPPORTED_SOURCE_MODELS).flat().join(", ")}.`);
  }
  return provider;
}

function revisionEffort(value, role) {
  const effort = String(value).trim();
  if (!["medium", "high"].includes(effort)) throw new Error(`Revision ${role} effort supports only medium or high; max is reserved for drafts.`);
  return effort;
}

function roleSpec(model, effort) {
  return { provider: providerForSourceModel(model), model: String(model).trim(), reasoning_effort: effort };
}

// Flags: --writer-model, --revision-model (all three revision roles), --diagnose-model,
// --revise-model, --verify-model, and the existing --diagnose-effort/--revise-effort/--verify-effort.
export function requestedModelLock(flags = {}) {
  const revisionModel = flags["revision-model"] ?? DEFAULT_SOURCE_MODEL;
  return {
    planning: roleSpec(flags["planning-model"] ?? DEFAULT_SOURCE_MODEL, DEFAULT_EFFORTS.planning),
    writer: roleSpec(flags["writer-model"] ?? DEFAULT_SOURCE_MODEL, DEFAULT_EFFORTS.writer),
    diagnose: roleSpec(flags["diagnose-model"] ?? revisionModel, revisionEffort(flags["diagnose-effort"] ?? DEFAULT_EFFORTS.diagnose, "diagnose")),
    revise: roleSpec(flags["revise-model"] ?? revisionModel, revisionEffort(flags["revise-effort"] ?? DEFAULT_EFFORTS.revise, "revise")),
    verify: roleSpec(flags["verify-model"] ?? revisionModel, revisionEffort(flags["verify-effort"] ?? DEFAULT_EFFORTS.verify, "verify")),
  };
}

const ROLE_FLAGS = Object.freeze({
  planning: { model: ["planning-model"], effort: null },
  writer: { model: ["writer-model"], effort: null },
  diagnose: { model: ["diagnose-model", "revision-model"], effort: "diagnose-effort" },
  revise: { model: ["revise-model", "revision-model"], effort: "revise-effort" },
  verify: { model: ["verify-model", "revision-model"], effort: "verify-effort" },
});

// Returns the roles whose explicitly passed flags differ from the recorded lock.
export function modelLockConflicts(lock, flags = {}) {
  const conflicts = [];
  for (const role of MANUFACTURING_MODEL_LOCK_ROLES) {
    const recorded = lock?.roles?.[role];
    if (!recorded) continue;
    const modelFlag = ROLE_FLAGS[role].model.find((name) => flags[name] != null);
    if (modelFlag && String(flags[modelFlag]).trim() !== recorded.model) conflicts.push(`${role}_model`);
    const effortFlag = ROLE_FLAGS[role].effort;
    if (effortFlag && flags[effortFlag] != null && String(flags[effortFlag]).trim() !== recorded.reasoning_effort) conflicts.push(`${role}_effort`);
  }
  return conflicts;
}

export function validateModelLock(document) {
  const blockers = [];
  if (document?.schema !== MANUFACTURING_MODEL_LOCK_SCHEMA) blockers.push("model_lock_schema_invalid");
  for (const role of MANUFACTURING_MODEL_LOCK_ROLES) {
    const spec = document?.roles?.[role];
    if (spec == null && role === "writer" && document?.writer_recorded_in_portfolio === true) continue;
    if (!spec?.provider || !spec?.model || !spec?.reasoning_effort) {
      blockers.push(`model_lock_${role}_missing`);
      continue;
    }
    // Historical model IDs stay readable; the provider must still match the recorded model.
    if (SUPPORTED_SOURCE_MODELS[spec.provider] == null && !HISTORICAL_SOURCE_PROVIDERS.includes(spec.provider)) blockers.push(`model_lock_${role}_provider_unknown`);
  }
  return { done: blockers.length === 0, blockers };
}
