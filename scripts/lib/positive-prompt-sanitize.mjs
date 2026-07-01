export function sanitizePositiveVisualPrompt(value) {
  return String(value ?? "")
    .replace(/\bnegative\s+prompt\s*[:=]\s*/gi, "")
    .replace(/--no\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
