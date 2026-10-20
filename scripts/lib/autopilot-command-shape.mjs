// Turns a run-status next_command_shape into an exact argv, without a shell.
// Only `node bin/goldflow.mjs …` shapes are executable; prose holds and shapes
// with unresolved <placeholders> are never guessed.

const PREFIX = ["node", "bin/goldflow.mjs"];
export const GOLDFLOW_SHAPE_PREFIX = PREFIX.join(" ");

/** Shell-quotes one token for a status shape; plain tokens (and <placeholders>) stay plain. */
export function quoteShapeToken(value) {
  const text = String(value);
  if (text === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./<>-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Composes `node bin/goldflow.mjs <command> <subcommand> --flag value …` from
 * [name, value] pairs (order kept; `true` renders as `--name true`; null,
 * undefined and false pairs are skipped). The inverse of `goldflowArgv`.
 */
export function composeShape(command, subcommand, flags = [], { positional = [] } = {}) {
  const pairs = Array.isArray(flags) ? flags : Object.entries(flags);
  const parts = [GOLDFLOW_SHAPE_PREFIX, command, subcommand, ...positional.map(quoteShapeToken)];
  for (const [name, value] of pairs) {
    if (value === null || value === undefined || value === false) continue;
    parts.push(`--${name}`, value === true ? "true" : quoteShapeToken(value));
  }
  return parts.join(" ");
}

/** Episode-dir-targeted `imagegen fal --action <action> …` shapes. */
export function falShape(episodeDir, action, flags = []) {
  return composeShape("imagegen", "fal", [["episode-dir", episodeDir], ["action", action], ...(Array.isArray(flags) ? flags : Object.entries(flags))]);
}

export function tokenizeShape(shape) {
  const text = String(shape ?? "").trim();
  const tokens = [];
  let current = "";
  let quote = null;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === "\"" && index + 1 < text.length) current += text[++index];
      else current += char;
    } else if (char === "'" || char === "\"") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else if (char === ";" || char === "|" || char === "&" || char === "`" || char === "$" && text[index + 1] === "(") {
      return null;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) tokens.push(current);
  return tokens;
}

/** Returns goldflow argv (after `node bin/goldflow.mjs`) or null for prose/compound shapes. */
export function goldflowArgv(shape) {
  const tokens = tokenizeShape(shape);
  if (!tokens || tokens.length < 4 || tokens[0] !== PREFIX[0] || tokens[1] !== PREFIX[1]) return null;
  return tokens.slice(2);
}

export function placeholdersIn(argv = []) {
  return [...new Set(argv.flatMap((token) => String(token).match(/<[^<>]+>/g) ?? []))];
}

/** Fills only mechanical placeholders whose value is fully determined. */
export function fillMechanicalPlaceholders(argv, { episodeDir, values = {} } = {}) {
  return argv.map((token) => String(token).replace(/<([^<>]+)>/g, (match, name) => {
    if (name === "episode-dir" || name === "dir") return episodeDir;
    return Object.hasOwn(values, name) ? String(values[name]) : match;
  }));
}

export function flagValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith("--") ? argv[index + 1] : null;
}

export function setFlag(argv, name, value) {
  const out = [...argv];
  const index = out.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < out.length && !out[index + 1].startsWith("--")) out[index + 1] = String(value);
  else if (index >= 0) out.splice(index + 1, 0, String(value));
  else out.push(`--${name}`, String(value));
  return out;
}

export function removeFlag(argv, name) {
  const out = [...argv];
  const index = out.indexOf(`--${name}`);
  if (index < 0) return out;
  out.splice(index, index + 1 < out.length && !out[index + 1].startsWith("--") ? 2 : 1);
  return out;
}

/** On a budget-locked identity, the episode budget replaces the exact per-dispatch token. */
export function useEpisodeBudgetToken(argv, { budgetLocked }) {
  const token = flagValue(argv, "confirm-spend");
  if (!budgetLocked || !token || !/^exact_[a-z0-9_]+$/.test(token)) return argv;
  return setFlag(argv, "confirm-spend", "episode_budget");
}

const REPAIR_PATTERNS = [
  /^repair-/, /^recover-/, /-repair$/, /^prepare-zone-repair$/, /^dispatch-zone-repair$/,
  /^dispatch-validation-recovery$/, /^dispatch-validation-second$/,
];
const ID_FLAGS = ["image-ids", "image-id", "reference-ids", "unit-ids", "confirmed-retry-unit-ids", "repair-unit-ids", "cut-ids", "zone-id", "spec", "request", "beat-ids", "packet-ids", "performance-packet-ids"];

/**
 * A repair command and its exact scope. One bounded repair per failed item:
 * the key names the stage, the repair verb and the exact ids it touches.
 */
export function repairScope(argv = [], stage = null) {
  const verb = flagValue(argv, "action") ?? argv[1] ?? "";
  const isRepair = REPAIR_PATTERNS.some((pattern) => pattern.test(verb) || pattern.test(argv[1] ?? ""))
    || argv.includes("--repair-reason") || argv.includes("--confirmed-retry-unit-ids")
    || flagValue(argv, "qa-recovery") === "true";
  if (!isRepair) return null;
  const items = ID_FLAGS.flatMap((flag) => String(flagValue(argv, flag) ?? "").split(",").map((value) => value.trim()).filter(Boolean)
    .map((value) => `${flag}=${value}`));
  return { stage, verb: `${argv[0]} ${verb}`.trim(), items: items.length ? items : [`${argv[0]} ${verb}`] };
}
