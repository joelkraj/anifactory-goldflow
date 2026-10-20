// One command builder for every `node bin/goldflow.mjs …` shape that run-status,
// the stage registry, the Fal production state and run-advance emit or read.
//
// It composes shapes from (command, subcommand, flags) and parses shapes back
// into { stage, recovery, argv } with the autopilot tokenizer (`goldflowArgv`),
// so the guard, the driver and the ledger all agree on what a shape means.
// There is no regex stage inference here: stage comes from the registry's
// `commandStageFor`, recovery from the parsed flags.
import { commandStageFor } from "./pipeline-stage-registry.mjs";
import { flagValue, goldflowArgv, placeholdersIn } from "./autopilot-command-shape.mjs";

export { GOLDFLOW_SHAPE_PREFIX, composeShape, falShape, quoteShapeToken } from "./autopilot-command-shape.mjs";

const RECOVERY_ID_FLAGS = Object.freeze([
  "confirmed-retry-unit-ids", "repair-unit-ids", "regenerate-unit-ids", "stitch-repair-tail-unit-ids",
  "performance-packet-ids", "performance-packet-id", "semantic-chunk-ids", "beat-ids", "cut-ids", "cut-id",
  "image-ids", "image-id", "reference-ids", "reference-id", "zone-id", "boundary-ids", "boundary-id",
]);
const RECOVERY_FILE_FLAGS = Object.freeze(["spec", "repair-spec", "request", "directives", "manifest", "review-spec", "interrupted-adoption-receipt", "inventory", "narration-retime-receipt"]);
const RECOVERY_ACTION = /^(repair-|recover-|dispatch-zone-repair$|prepare-zone-repair$|dispatch-validation-recovery$|dispatch-validation-second$|observe-.*repair|inspect-repair-failure$|correct-validation-review$|prepare-validation-recovery$|adjudicate-no-job$|dispatch-adjudicated$|apply-postplan-prompt-correction$)/;
const RECOVERY_SUBCOMMANDS = new Set([
  "repair-beats", "repair-beat-density", "repair-prompt", "repair-prompt-multiplier", "review-prop-repair", "repair-screen-identity",
  "repair-identity-binding", "repair-reviewed-ref-scope", "repair-boundary", "repair-pronunciation-auto", "repair-contraction", "review-contraction",
  "retime-final-narration", "patch-final-narration", "adopt-interrupted", "finalize-provider",
]);

function recoveryFor(argv) {
  const [command, subcommand] = argv;
  const action = flagValue(argv, "action");
  const flags = Object.fromEntries(argv.map((token, index) => (token.startsWith("--") ? [token.slice(2), argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : "true"] : null)).filter(Boolean));
  const ids = RECOVERY_ID_FLAGS.flatMap((name) => (flags[name] ? String(flags[name]).split(",").map((v) => v.trim()).filter(Boolean).map((v) => `${name}=${v}`) : []));
  const files = RECOVERY_FILE_FLAGS.filter((name) => flags[name]).map((name) => `${name}=${flags[name]}`);
  const kinds = [];
  if (action && RECOVERY_ACTION.test(action)) kinds.push(`action:${action}`);
  if (RECOVERY_SUBCOMMANDS.has(subcommand)) kinds.push(`subcommand:${subcommand}`);
  if (flags["qa-recovery"] === "true") kinds.push("qa-recovery");
  if (flags["repair-reason"]) kinds.push("repair-reason");
  if (flags["confirmed-retry-unit-ids"]) kinds.push("confirmed-retry");
  if (flags["performance-packet-ids"] || flags["performance-packet-id"]) kinds.push("performance-packet");
  if (flags["resume-incomplete-chunks"] === "true") kinds.push("resume-incomplete-chunks");
  if (flags["semantic-chunk-ids"]) kinds.push("semantic-chunk");
  if (flags["allow-full-stage-rerun"] === "true") kinds.push("full-stage-rerun");
  if (command === "tts" && ["approve-listen", "approve-subjective"].includes(subcommand)) kinds.push("listening-attestation");
  if (!kinds.length && !ids.length) return null;
  return { kinds, ids, files, full_stage_rerun: kinds.includes("full-stage-rerun"), listening_attestation: kinds.includes("listening-attestation") };
}

/**
 * Parses one status shape. Returns
 *   { executable, prose, argv, command, subcommand, action, stage, recovery, placeholders, spend_token }
 * `stage` is null for commands outside the registry (read-only or unknown);
 * `recovery` is null for ordinary stage commands. Prose and compound shapes
 * are never guessed: executable=false, prose=true.
 */
export function parseShape(shape, identity = {}) {
  const argv = goldflowArgv(shape);
  if (!argv) return { executable: false, prose: true, argv: null, command: null, subcommand: null, action: null, stage: null, recovery: null, placeholders: [], spend_token: null };
  const [command, subcommand] = argv;
  const flags = Object.fromEntries(argv.map((token, index) => (token.startsWith("--") ? [token.slice(2), argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : "true"] : null)).filter(Boolean));
  const stage = command === "crime-proof" ? null : commandStageFor(command, subcommand, flags, identity);
  const placeholders = placeholdersIn(argv);
  return {
    executable: placeholders.length === 0,
    prose: false,
    argv,
    command,
    subcommand,
    action: flagValue(argv, "action"),
    stage,
    recovery: recoveryFor(argv),
    placeholders,
    spend_token: flagValue(argv, "confirm-spend"),
  };
}

/**
 * The stage a blocked/failed `next` row's shape repairs, or null. This replaces
 * the regex stage inference in run-status: the shape must be a concrete
 * recovery command for the row's own stage (or the stages the caller allows).
 */
export function recoveryStageFor(next, identity = {}, { allowStages = null } = {}) {
  if (!next?.stage || !["blocked", "failed", "stale"].includes(String(next.state ?? ""))) return null;
  const parsed = parseShape(next.next_command_shape, identity);
  if (parsed.prose || !parsed.recovery) return null;
  const stage = parsed.stage ?? next.stage;
  const allowed = allowStages ?? [next.stage];
  return allowed.includes(stage) ? { stage, recovery: parsed.recovery, parsed } : null;
}

/** Classifies many recorded shapes; used by the replay test and `run auto --dry-run`. */
export function classifyShapes(shapes, identity = {}) {
  const rows = shapes.map((entry) => {
    const shape = typeof entry === "string" ? entry : entry.shape;
    const parsed = parseShape(shape, identity);
    const disposition = parsed.prose ? "triage:prose" : parsed.placeholders.length ? "triage:placeholder" : parsed.recovery?.listening_attestation ? "triage:listening" : "run";
    return { ...(typeof entry === "string" ? {} : entry), shape, disposition, stage: parsed.stage, recovery: parsed.recovery, placeholders: parsed.placeholders };
  });
  const counts = {};
  for (const row of rows) counts[row.disposition] = (counts[row.disposition] ?? 0) + 1;
  return { rows, counts, run: counts.run ?? 0, triage: rows.length - (counts.run ?? 0) };
}
