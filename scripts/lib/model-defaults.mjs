// Default planner models for NEW runs, read from config/planner-models.json so a
// model change is a data edit, not a code change. Existing run identities keep
// the model recorded in run_identity.json; nothing here rewrites or migrates them.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLANNER_MODELS_SCHEMA = "goldflow_planner_models_v1";
export const PLANNER_MODELS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../config/planner-models.json");
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MODEL_ALIASES = new Set(["latest", "default", "current"]);
const VERSION = /^\d+\.\d+\.\d+$/;

export function parsePlannerModelsConfig(raw, source = "planner models config") {
  let doc;
  try { doc = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  if (doc?.schema !== PLANNER_MODELS_SCHEMA) throw new Error(`${source} must declare schema ${PLANNER_MODELS_SCHEMA}.`);
  const providers = {};
  for (const id of ["codex_cli", "claude_cli"]) {
    const row = doc.providers?.[id];
    if (!row || typeof row.model !== "string" || !row.model.trim()) throw new Error(`${source}: providers.${id}.model is required.`);
    if (MODEL_ALIASES.has(row.model.trim().toLowerCase())) throw new Error(`${source}: providers.${id}.model must be concrete, not an alias.`);
    if (!EFFORTS.has(row.reasoning_effort)) throw new Error(`${source}: providers.${id}.reasoning_effort must be one of ${[...EFFORTS].join(", ")}.`);
    if (row.minimum_cli_by_model != null && !Array.isArray(row.minimum_cli_by_model)) throw new Error(`${source}: providers.${id}.minimum_cli_by_model must be an array.`);
    const gates = (row.minimum_cli_by_model ?? []).map((gate, index) => {
      if (!VERSION.test(String(gate?.minimum ?? ""))) throw new Error(`${source}: providers.${id}.minimum_cli_by_model[${index}].minimum must be x.y.z.`);
      if (typeof gate.pattern !== "string" || !gate.pattern.trim()) throw new Error(`${source}: providers.${id}.minimum_cli_by_model[${index}].pattern is required.`);
      return Object.freeze({ pattern: new RegExp(String(gate.pattern), "i"), minimum: gate.minimum });
    });
    // Optional recorded fallback: provenance for operators, never automatic failover.
    const fallback = row.fallback_model == null ? null : String(row.fallback_model).trim();
    if (fallback !== null && (!fallback || MODEL_ALIASES.has(fallback.toLowerCase()))) {
      throw new Error(`${source}: providers.${id}.fallback_model must be a concrete model id when present.`);
    }
    providers[id] = Object.freeze({
      model: row.model.trim(),
      fallback_model: fallback,
      reasoning_effort: row.reasoning_effort,
      minimum_cli_by_model: Object.freeze(gates),
    });
  }
  return Object.freeze(providers);
}

const PLANNER_MODELS = parsePlannerModelsConfig(readFileSync(PLANNER_MODELS_PATH, "utf8"), PLANNER_MODELS_PATH);

export const CODEX_PLANNING_DEFAULTS = Object.freeze({
  model: PLANNER_MODELS.codex_cli.model,
  fallback_model: PLANNER_MODELS.codex_cli.fallback_model,
  reasoning_effort: PLANNER_MODELS.codex_cli.reasoning_effort,
});

export const CLAUDE_PLANNING_DEFAULTS = Object.freeze({
  model: PLANNER_MODELS.claude_cli.model,
  fallback_model: PLANNER_MODELS.claude_cli.fallback_model,
  reasoning_effort: PLANNER_MODELS.claude_cli.reasoning_effort,
});

// The recorded fallback for a provider, or null. Read for provenance and operator
// choice only; no runner selects it on its own.
export function plannerFallbackModel(provider, config = PLANNER_MODELS) {
  return config[provider]?.fallback_model ?? null;
}

export function plannerDefaultEffort(provider, env = process.env, config = PLANNER_MODELS) {
  const key = provider === "claude_cli" ? "ANIFACTORY_CLAUDE_REASONING_EFFORT" : "ANIFACTORY_CODEX_REASONING_EFFORT";
  return env[key] ?? config[provider]?.reasoning_effort ?? "medium";
}

// Minimum Codex CLI release per model; unlisted models have no minimum. A model's
// own row wins, first match first.
export function minimumCodexCliForModel(model, config = PLANNER_MODELS) {
  const name = String(model ?? "");
  return config.codex_cli.minimum_cli_by_model.find((row) => row.pattern.test(name))?.minimum ?? "0.0.0";
}

// "latest"/"default"/"current" resolve to the configured default for the provider.
// The caller records the concrete result, so a run never stores an alias.
export function resolveModelAlias(provider, value, config = PLANNER_MODELS) {
  const text = String(value ?? "").trim();
  if (!MODEL_ALIASES.has(text.toLowerCase())) return text;
  const row = config[provider];
  if (!row) throw new Error(`Model alias "${text}" is not supported for provider ${provider}.`);
  return row.model;
}
