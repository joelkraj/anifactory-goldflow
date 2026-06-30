import { normalizeImageProvider as normalizeImageProviderForPrompt } from "./image-provider-routing.mjs";

export { normalizeImageProviderForPrompt };

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
