export function normalizeImageProvider(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["codex", "codex_imagen", "codex_imagegen", "openai", "openai_imagegen", "gpt_image"].includes(normalized)) return "codex_imagegen";
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
  return "modelslab";
}

export function providerSlug(provider) {
  const normalized = normalizeImageProvider(provider);
  if (normalized === "codex_imagegen") return "codex-imagegen";
  if (normalized === "hybrid_codex_refs_multichar") return "hybrid";
  if (normalized === "hybrid_codex_opening_modelslab_rest") return "hybrid-opening";
  return "modelslab";
}

export function isCodexImageProvider(provider) {
  return normalizeImageProvider(provider) === "codex_imagegen";
}

export function isHybridImageProvider(provider) {
  return normalizeImageProvider(provider).startsWith("hybrid_codex_");
}

export function routedProviderForReference(globalProvider, target = null) {
  const normalized = normalizeImageProvider(globalProvider);
  if (normalized === "hybrid_codex_refs_multichar") return "codex_imagegen";
  if (normalized === "hybrid_codex_opening_modelslab_rest") return "codex_imagegen";
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
  if (!normalized.startsWith("hybrid_codex_")) return normalized;
  const requested = normalizeImageProvider(prompt?.image_provider_route ?? "");
  if (requested === "codex_imagegen") return "codex_imagegen";
  if (normalized === "hybrid_codex_refs_multichar") {
    return isRiskyMultiCharacterPrompt(prompt) ? "codex_imagegen" : "modelslab";
  }
  if (normalized === "hybrid_codex_opening_modelslab_rest") {
    const openingSec = Number(options.codexOpeningSec ?? 120);
    const startSec = Number(prompt?.start_sec ?? Number.POSITIVE_INFINITY);
    if (Number.isFinite(openingSec) && openingSec > 0 && Number.isFinite(startSec) && startSec < openingSec) return "codex_imagegen";
    return "modelslab";
  }
  return "modelslab";
}
