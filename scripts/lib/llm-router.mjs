// LLM Router
// ANIFACTORY_LLM_ROUTE values:
//   codex       - Codex/GPT-5.5 via API/CLI (default)
//   local-qwen  - local Qwen via Rapid-MLX OpenAI-compatible endpoint
//   auto        - local-qwen for volume stages, codex for quality stages

const VOLUME_STAGES = new Set(["visual-author", "visual-review", "enhancement", "qa"]);
const QUALITY_STAGES = new Set(["chatbot-package", "enhancement-judge"]);

function normalizeStage(stage = "") {
  const value = String(stage ?? "").toLowerCase();
  if (/\b(?:visual[-_]?author|visual[-_]?planner|reference[-_]?anchor)\b/.test(value)) return "visual-author";
  if (/\bvisual[-_]?review\b/.test(value)) return "visual-review";
  if (/\b(?:dopamine|density|enhancement|repair[-_]?chunk)\b/.test(value)) return "enhancement";
  if (/\b(?:qa|quality|semantic|dependency[-_]?sync|targeted[-_]?repair)\b/.test(value)) return "qa";
  if (/\b(?:chatbot|series[-_]?package|foundation|weekly[-_]?arc|outline|story[-_]?selection|hybrid[-_]?assembly|cold[-_]?audience|script[-_]?contract)\b/.test(value)) return "chatbot-package";
  if (/\bjudge\b/.test(value)) return "enhancement-judge";
  if (/\b(?:audio[-_]?sfx|sfx[-_]?score|score[-_]?enrichment)\b/.test(value)) return "enhancement";
  return value;
}

export function getLLMRoute(stage = "") {
  const route = String(process.env.ANIFACTORY_LLM_ROUTE ?? "codex").trim().toLowerCase() || "codex";
  if (route === "auto") {
    const normalized = normalizeStage(stage);
    if (VOLUME_STAGES.has(normalized)) return "local-qwen";
    if (QUALITY_STAGES.has(normalized)) return "codex";
    return "codex";
  }
  if (route === "local" || route === "qwen") return "local-qwen";
  return route;
}

export function getLLMBaseURL(stage = "") {
  const route = getLLMRoute(stage);
  if (route === "local-qwen") {
    return process.env.ANIFACTORY_LOCAL_LLM_URL ?? "http://localhost:8000/v1";
  }
  return null;
}

export function getLLMModel(stage = "") {
  const route = getLLMRoute(stage);
  if (route === "local-qwen") {
    return process.env.ANIFACTORY_LOCAL_LLM_MODEL
      ?? "Qwen3.6-35B-A3B-OptiQ-4bit";
  }
  return null;
}

export function isLocalLLMRoute(stage = "") {
  return getLLMRoute(stage) === "local-qwen";
}

export function localLLMProviderLabel(stage = "") {
  return getLLMRoute(stage);
}

export function localLLMChatCompletionURL(stage = "") {
  const baseURL = getLLMBaseURL(stage);
  if (!baseURL) return null;
  return `${baseURL.replace(/\/+$/g, "")}/chat/completions`;
}

export function localLLMAuthHeaders() {
  const token = process.env.ANIFACTORY_LOCAL_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  return token ? { authorization: `Bearer ${token}` } : {};
}
