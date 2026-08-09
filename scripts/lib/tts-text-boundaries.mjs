export function hasTtsTerminalPunctuation(text) {
  return /[.!?…—]["”’\])]*$/u.test(String(text ?? "").trim());
}
