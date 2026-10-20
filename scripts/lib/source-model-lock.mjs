// Per-run model choice for source manufacture. The lock is written once per development folder
// and every later stage uses it; flags that disagree with it stop instead of switching models.
export const MANUFACTURING_MODEL_LOCK_SCHEMA = "goldflow_manhwa_manufacturing_model_lock_v1";
// planning covers ideation, the shortlist and template filling.
export const MANUFACTURING_MODEL_LOCK_ROLES = Object.freeze(["planning", "writer", "diagnose", "revise", "verify"]);

// Selectable models. gpt-6.1-sol was confirmed by an accepted codex exec smoke call
// (docs/proofs/codex_gpt61_sol_smoke_v1). chatgpt_web is an opt-in writer-only transport
// (`--transport chatgpt_web --writer-model gpt-6-astra`): its one slug maps to the "GPT-6" picker
// label read from the live Studio profile on 2026-10-20
// (docs/proofs/chatgpt_web_picker_probe_2026-10-20.json). No 6.1 Sol label exists in the web
// picker, so gpt-6.1-sol stays CLI-only.
export const SUPPORTED_SOURCE_MODELS = Object.freeze({
  codex_cli: Object.freeze(["gpt-6.1-sol", "gpt-6-sol"]),
  claude_cli: Object.freeze(["claude-fable-5-1", "claude-opus-5-5"]),
  chatgpt_web: Object.freeze(["gpt-6-astra"]),
});
export const BROWSER_SOURCE_PROVIDERS = Object.freeze(["chatgpt_web"]);
// Historical providers stay readable in recorded locks (older chatgpt_web locks name gpt-6-sol).
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
  const roles = {
    planning: roleSpec(flags["planning-model"] ?? DEFAULT_SOURCE_MODEL, DEFAULT_EFFORTS.planning),
    writer: roleSpec(flags["writer-model"] ?? DEFAULT_SOURCE_MODEL, DEFAULT_EFFORTS.writer),
    diagnose: roleSpec(flags["diagnose-model"] ?? revisionModel, revisionEffort(flags["diagnose-effort"] ?? DEFAULT_EFFORTS.diagnose, "diagnose")),
    revise: roleSpec(flags["revise-model"] ?? revisionModel, revisionEffort(flags["revise-effort"] ?? DEFAULT_EFFORTS.revise, "revise")),
    verify: roleSpec(flags["verify-model"] ?? revisionModel, revisionEffort(flags["verify-effort"] ?? DEFAULT_EFFORTS.verify, "verify")),
  };
  // The browser transport is verified only for the one Pro draft; planning and revision stay CLI.
  for (const role of MANUFACTURING_MODEL_LOCK_ROLES) {
    if (role !== "writer" && BROWSER_SOURCE_PROVIDERS.includes(roles[role].provider)) {
      throw new Error(`ChatGPT Web models draft only: ${roles[role].model} cannot take the ${role} role. Use a CLI model for ${role}.`);
    }
  }
  return roles;
}

// `--writer-fallback <cli-model>`: the CLI writer used, at the same max effort and prompt, when
// the browser draft fails after its one recorded resubmit. Only a browser writer may name one.
export function requestedWriterFallback(flags = {}, roles) {
  const requested = flags["writer-fallback"];
  if (requested == null) return null;
  const spec = roleSpec(requested, DEFAULT_EFFORTS.writer);
  if (BROWSER_SOURCE_PROVIDERS.includes(spec.provider)) throw new Error(`--writer-fallback must name a CLI model, not ${spec.model}.`);
  if (!BROWSER_SOURCE_PROVIDERS.includes(roles?.writer?.provider)) {
    throw new Error("--writer-fallback applies only to a ChatGPT Web writer (--transport chatgpt_web --writer-model gpt-6-astra).");
  }
  return spec;
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
  if (flags["writer-fallback"] != null && String(flags["writer-fallback"]).trim() !== (lock?.writer_fallback?.model ?? null)) conflicts.push("writer_fallback");
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
  const fallback = document?.writer_fallback;
  if (fallback != null) {
    if (!fallback.provider || !fallback.model || !fallback.reasoning_effort) blockers.push("model_lock_writer_fallback_incomplete");
    else if (!SUPPORTED_SOURCE_MODELS[fallback.provider]?.includes(fallback.model) || BROWSER_SOURCE_PROVIDERS.includes(fallback.provider)) blockers.push("model_lock_writer_fallback_not_cli");
    if (!BROWSER_SOURCE_PROVIDERS.includes(document?.roles?.writer?.provider)) blockers.push("model_lock_writer_fallback_without_browser_writer");
  }
  return { done: blockers.length === 0, blockers };
}
