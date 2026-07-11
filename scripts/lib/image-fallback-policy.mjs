import { normalizeImageProvider } from "./image-provider-routing.mjs";

export const MODELSLAB_CREDIT_EXHAUSTED = "modelslab_credit_exhausted";

const CREDIT_EXHAUSTION_PATTERN = /(?:insufficient|not enough|exhausted|depleted|low|zero|no)\s+(?:wallet\s+)?(?:credit|credits|balance|funds)|(?:credit|wallet|balance)\s+(?:is\s+)?(?:insufficient|exhausted|depleted|empty|too low)|recharge\s+(?:your\s+)?(?:wallet|account)|add\s+(?:more\s+)?credits/i;

export function isModelslabCreditExhaustion(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return CREDIT_EXHAUSTION_PATTERN.test(text);
}

export function normalizeImageFallbackCondition(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (["credit", "credits", "credit_exhausted", "insufficient_credits", "modelslab_credit_exhausted"].includes(normalized)) {
    return MODELSLAB_CREDIT_EXHAUSTED;
  }
  return normalized || null;
}

export function imageFallbackPolicy(identity = {}) {
  const fallback = identity?.image_provider_options?.fallback ?? null;
  if (!fallback) return null;
  return {
    provider: normalizeImageProvider(fallback.provider ?? ""),
    condition: normalizeImageFallbackCondition(fallback.condition),
    operator_approved: fallback.operator_approved === true,
  };
}

export function codexCreditFallbackEnabled(identity = {}) {
  const policy = imageFallbackPolicy(identity);
  return normalizeImageProvider(identity?.image_provider ?? "modelslab") === "modelslab"
    && policy?.provider === "codex_imagegen"
    && policy?.condition === MODELSLAB_CREDIT_EXHAUSTED
    && policy?.operator_approved === true;
}

export function creditExhaustedIdsFromReport(report, idField = "image_id") {
  return creditExhaustedIdsFromRows(report?.results ?? [], idField);
}

export function creditExhaustedIdsFromRows(rows, idField = "image_id") {
  return [...new Set((rows ?? [])
    .filter((row) => row?.[idField] && String(row.status ?? "").toLowerCase() === "failed")
    .filter((row) => isModelslabCreditExhaustion(row.error ?? row.generated?.error ?? row))
    .map((row) => String(row[idField])))];
}
