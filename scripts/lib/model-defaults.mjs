// Single place to change the default model for NEW planning runs.
// Existing run identities keep the model recorded in run_identity.json; nothing
// here rewrites or migrates them.

export const CODEX_PLANNING_DEFAULTS = Object.freeze({
  model: "gpt-6.1-sol",
  reasoning_effort: "medium",
});

export const CLAUDE_PLANNING_DEFAULTS = Object.freeze({
  model: "claude-sonnet-5-5",
  reasoning_effort: "medium",
});

// Minimum Codex CLI release required per model family. First match wins; the
// final entry is the fallback for unlisted models.
// gpt-6.1-sol: the model entered the bundled catalog in 0.159.1 (third-party
// release-note summaries, not OpenAI's own text). Treat as a floor; account
// access can still be required beyond the CLI version.
export const CODEX_MINIMUM_CLI_BY_MODEL = Object.freeze([
  Object.freeze({ pattern: /^gpt-6\.1(?:-|$)/i, minimum: "0.159.1" }),
  Object.freeze({ pattern: /^gpt-5\.6(?:-|$)/i, minimum: "0.144.0" }),
  Object.freeze({ pattern: /./, minimum: "0.0.0" }),
]);

export function minimumCodexCliForModel(model) {
  const name = String(model ?? "");
  return CODEX_MINIMUM_CLI_BY_MODEL.find((row) => row.pattern.test(name)).minimum;
}
