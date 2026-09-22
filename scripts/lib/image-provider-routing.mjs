import {
  CHATGPT_WEB_IMAGE_PROVIDER,
  FEDERATED_WEB_IMAGE_PROVIDER,
  GOOGLE_FLOW_IMAGE_PROVIDER,
  HYBRID_WEB_FLOW_PROVIDER,
  isBrowserPoolImageProvider,
  isHybridWebFlowProvider,
  isStyleReferenceTarget,
} from "./image-provider-policy.mjs";

export function normalizeImageProvider(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["openart", "openart_cli"].includes(normalized)) return "openart_cli";
  if (["codex", "codex_imagen", "codex_imagegen", "openai", "openai_imagegen", "gpt_image"].includes(normalized)) return "codex_imagegen";
  if (["chatgpt_web", "chatgpt_web_image", "chatgpt_web_gpt_image", "web_gpt_image"].includes(normalized)) return "chatgpt_web_gpt_image";
  if (["google_flow", "flow", "nano_banana", "nano_banana_pro", "google_flow_nano_banana_pro"].includes(normalized)) return GOOGLE_FLOW_IMAGE_PROVIDER;
  if ([
    "federated_google_web_image_pool",
    "federated_web_image_pool",
    "flow_gemini_gpt_pool",
    "all_web_images",
  ].includes(normalized)) return FEDERATED_WEB_IMAGE_PROVIDER;
  if ([
    "hybrid_chatgpt_web_style_google_flow_pool",
    "hybrid_chatgpt_flow",
    "hybrid_web_flow",
    "web_flow_speed",
    "speed_first_web_flow_v1",
  ].includes(normalized)) return HYBRID_WEB_FLOW_PROVIDER;
  if ([
    "hybrid",
    "hybrid_codex_refs_multichar",
    "hybrid_codex_references_multichar",
    "codex_refs_multichar",
    "codex_refs_multichar_modelslab_simple",
    "codex_references_multichar_modelslab_simple",
  ].includes(normalized)) return "hybrid_codex_refs_multichar";
  if ([
    "hybrid_codex_opening_modelslab_rest",
    "hybrid_codex_first20_modelslab_rest",
    "hybrid_codex_first_20_modelslab_rest",
    "codex_first20_modelslab_rest",
    "codex_opening_modelslab_rest",
  ].includes(normalized)) return "hybrid_codex_opening_modelslab_rest";
  if ([
    "hybrid_codex_refs_opening_risky_modelslab_rest",
    "hybrid_codex_refs_first10_risky_modelslab_rest",
    "hybrid_codex_references_opening_risky_modelslab_rest",
    "codex_refs_opening_risky_modelslab_rest",
    "codex_refs_first10_risky_modelslab_rest",
    "codex_references_opening_risky_modelslab_rest",
  ].includes(normalized)) return "hybrid_codex_refs_opening_risky_modelslab_rest";
  if ([
    "hybrid_modelslab_refs_codex_opening_modelslab_rest",
    "modelslab_refs_codex_opening_modelslab_rest",
    "modelslab_references_codex_opening_modelslab_rest",
    "modelslab_refs_codex_first5_modelslab_rest",
    "modelslab_refs_codex_first_5_modelslab_rest",
    "codex_first5_modelslab_rest_modelslab_refs",
  ].includes(normalized)) return "hybrid_modelslab_refs_codex_opening_modelslab_rest";
  return "modelslab";
}

export function providerSlug(provider) {
  const normalized = normalizeImageProvider(provider);
  if (normalized === "openart_cli") return "openart-cli";
  if (normalized === "codex_imagegen") return "codex-imagegen";
  if (normalized === "chatgpt_web_gpt_image") return "chatgpt-web-gpt-image";
  if (normalized === GOOGLE_FLOW_IMAGE_PROVIDER) return "google-flow-imagen";
  if (normalized === FEDERATED_WEB_IMAGE_PROVIDER) return "federated-google-web-images";
  if (normalized === HYBRID_WEB_FLOW_PROVIDER) return "hybrid-web-flow";
  if (normalized === "hybrid_codex_refs_multichar") return "hybrid";
  if (normalized === "hybrid_codex_opening_modelslab_rest") return "hybrid-opening";
  if (normalized === "hybrid_codex_refs_opening_risky_modelslab_rest") return "hybrid-codex-refs-opening-risky";
  if (normalized === "hybrid_modelslab_refs_codex_opening_modelslab_rest") return "hybrid-modelslab-refs-opening";
  return "modelslab";
}

export function isCodexImageProvider(provider) {
  return normalizeImageProvider(provider) === "codex_imagegen";
}

export function isHybridImageProvider(provider) {
  return normalizeImageProvider(provider).startsWith("hybrid_");
}

export function routedProviderForReference(globalProvider, target = null) {
  const normalized = normalizeImageProvider(globalProvider);
  if (isHybridWebFlowProvider(normalized)) {
    return isStyleReferenceTarget(target) ? CHATGPT_WEB_IMAGE_PROVIDER : HYBRID_WEB_FLOW_PROVIDER;
  }
  if (normalized === "hybrid_codex_refs_multichar") return "codex_imagegen";
  if (normalized === "hybrid_codex_opening_modelslab_rest") return "codex_imagegen";
  if (normalized === "hybrid_codex_refs_opening_risky_modelslab_rest") return "codex_imagegen";
  if (normalized === "hybrid_modelslab_refs_codex_opening_modelslab_rest") return "modelslab";
  return normalized;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueCount(values) {
  return new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)).size;
}

export function promptCharacterRefCount(prompt) {
  const refRequirementIds = asArray(prompt?.reference_requirements)
    .filter((ref) => String(ref?.kind ?? "").includes("character"))
    .map((ref) => ref?.ref_id);
  const manifest = prompt?.shot_manifest ?? {};
  return uniqueCount([
    ...refRequirementIds,
    ...asArray(manifest.character_state_ref_ids),
    manifest.protagonist_state_ref_id,
  ]);
}

export function promptVisibleCharacterCount(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  const manifestCharacters = asArray(manifest.visible_characters)
    .map((row) => typeof row === "string" ? row : row?.name ?? row?.character ?? row?.id);
  const visibleSubjects = asArray(prompt?.visible_subjects)
    .map((row) => typeof row === "string" ? row : row?.name ?? row?.character ?? row?.id);
  const stagedCharacters = asArray(manifest.character_staging)
    .map((row) => row?.character ?? row?.name ?? row?.id);
  return uniqueCount([...manifestCharacters, ...visibleSubjects, ...stagedCharacters]);
}

export function isRiskyMultiCharacterPrompt(prompt) {
  return promptCharacterRefCount(prompt) >= 2 || promptVisibleCharacterCount(prompt) >= 2;
}

export function routedProviderForPrompt(prompt, globalProvider, options = {}) {
  const normalized = normalizeImageProvider(globalProvider);
  if (isHybridWebFlowProvider(normalized)) return HYBRID_WEB_FLOW_PROVIDER;
  if (!normalized.startsWith("hybrid_")) return normalized;
  const requested = normalizeImageProvider(prompt?.image_provider_route ?? "");
  if (requested === "codex_imagegen") return "codex_imagegen";
  if (normalized === "hybrid_codex_refs_multichar") {
    return isRiskyMultiCharacterPrompt(prompt) ? "codex_imagegen" : "modelslab";
  }
  if (normalized === "hybrid_codex_refs_opening_risky_modelslab_rest") {
    const openingSec = Number(options.codexOpeningSec ?? 120);
    const startSec = Number(prompt?.start_sec ?? Number.POSITIVE_INFINITY);
    if (Number.isFinite(openingSec) && openingSec > 0 && Number.isFinite(startSec) && startSec < openingSec) return "codex_imagegen";
    return isRiskyMultiCharacterPrompt(prompt) ? "codex_imagegen" : "modelslab";
  }
  if (normalized === "hybrid_codex_opening_modelslab_rest" || normalized === "hybrid_modelslab_refs_codex_opening_modelslab_rest") {
    const openingSec = Number(options.codexOpeningSec ?? 120);
    const startSec = Number(prompt?.start_sec ?? Number.POSITIVE_INFINITY);
    if (Number.isFinite(openingSec) && openingSec > 0 && Number.isFinite(startSec) && startSec < openingSec) return "codex_imagegen";
    return "modelslab";
  }
  return "modelslab";
}

export function eligibleProvidersForReference(globalProvider, target = null) {
  const normalized = normalizeImageProvider(globalProvider);
  if (normalized === GOOGLE_FLOW_IMAGE_PROVIDER) return [GOOGLE_FLOW_IMAGE_PROVIDER];
  if (!isHybridWebFlowProvider(normalized)) return [routedProviderForReference(normalized, target)];
  return isStyleReferenceTarget(target)
    ? [CHATGPT_WEB_IMAGE_PROVIDER]
    : [CHATGPT_WEB_IMAGE_PROVIDER, GOOGLE_FLOW_IMAGE_PROVIDER];
}

export function eligibleProvidersForPrompt(prompt, globalProvider) {
  const normalized = normalizeImageProvider(globalProvider);
  if (normalized === GOOGLE_FLOW_IMAGE_PROVIDER) return [GOOGLE_FLOW_IMAGE_PROVIDER];
  if (!isHybridWebFlowProvider(normalized)) return [routedProviderForPrompt(prompt, normalized)];
  return [CHATGPT_WEB_IMAGE_PROVIDER, GOOGLE_FLOW_IMAGE_PROVIDER];
}

export { isBrowserPoolImageProvider };
