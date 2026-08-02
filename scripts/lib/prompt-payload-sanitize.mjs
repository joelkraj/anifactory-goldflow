export function stripEmbeddedProviderExclusionPayloadSyntax(value) {
  const raw = String(value ?? "");
  const markers = [
    raw.search(/\bnegative\s+prompt\s*[:=]/i),
    raw.search(/--no\b/i),
  ].filter((index) => index >= 0);
  const retained = markers.length ? raw.slice(0, Math.min(...markers)) : raw;
  return retained
    .replace(/\s+/g, " ")
    .trim();
}
