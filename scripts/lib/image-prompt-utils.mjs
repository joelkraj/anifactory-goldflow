export function normalizeImageProviderForPrompt(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["codex", "codex_imagen", "codex_imagegen", "openai", "openai_imagegen", "gpt_image"].includes(normalized)) return "codex_imagegen";
  return "modelslab";
}

function firstNonEmpty(values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

export function promptTextForImageProvider(prompt, provider) {
  const normalized = normalizeImageProviderForPrompt(provider);
  if (normalized === "codex_imagegen") {
    return firstNonEmpty([
      prompt?.codex_image_prompt,
      prompt?.image_prompt,
      prompt?.modelslab_image_prompt,
    ]);
  }
  return firstNonEmpty([
    prompt?.modelslab_image_prompt,
    prompt?.image_prompt,
    prompt?.codex_image_prompt,
  ]);
}
