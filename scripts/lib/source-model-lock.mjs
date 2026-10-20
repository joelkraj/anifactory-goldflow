// Per-run model choice for source manufacture. The lock is written once per development folder
// and every later stage uses it; flags that disagree with it stop instead of switching models.
export const MANUFACTURING_MODEL_LOCK_SCHEMA = "goldflow_manhwa_manufacturing_model_lock_v1";
export const MANUFACTURING_MODEL_LOCK_ROLES = Object.freeze(["writer", "diagnose", "revise", "verify"]);

// Only models whose exact slug the transport is known to accept. ChatGPT Web models must also
// have a verified picker label in apps/goldflow-studio/lib/chatgpt-ui-contract.mjs.
export const SUPPORTED_SOURCE_MODELS = Object.freeze({
  chatgpt_web: Object.freeze(["gpt-6-sol"]),
  claude_cli: Object.freeze(["claude-fable-5-1", "claude-opus-5-5"]),
});
export const DEFAULT_SOURCE_MODEL = "gpt-6-sol";
export const DEFAULT_CLAUDE_SOURCE_MODEL = "claude-fable-5-1";
const DEFAULT_EFFORTS = Object.freeze({ writer: "max", diagnose: "high", revise: "high", verify: "medium" });

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
    writer: roleSpec(flags["writer-model"] ?? DEFAULT_SOURCE_MODEL, DEFAULT_EFFORTS.writer),
    diagnose: roleSpec(flags["diagnose-model"] ?? revisionModel, revisionEffort(flags["diagnose-effort"] ?? DEFAULT_EFFORTS.diagnose, "diagnose")),
    revise: roleSpec(flags["revise-model"] ?? revisionModel, revisionEffort(flags["revise-effort"] ?? DEFAULT_EFFORTS.revise, "revise")),
    verify: roleSpec(flags["verify-model"] ?? revisionModel, revisionEffort(flags["verify-effort"] ?? DEFAULT_EFFORTS.verify, "verify")),
  };
}

const ROLE_FLAGS = Object.freeze({
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
    if (SUPPORTED_SOURCE_MODELS[spec.provider] == null) blockers.push(`model_lock_${role}_provider_unknown`);
  }
  return { done: blockers.length === 0, blockers };
}
