import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SOURCE_HANDOFF_SCHEMA, validateSourceHandoff } from "./source-manufacturer-contract.mjs";

// Channel preset: an explicit, operator-authored, hash-recorded file that supplies the
// operational preflight flags for one channel. It never supplies the content profile, media
// workflow or run intent (AGENTS.md: a channel name never infers a content family), and it
// never supplies per-run identity (series, week, episode, title, source).
export const CHANNEL_PRESET_SCHEMA = "goldflow_channel_preset_v1";

// Flags a preset may carry, keyed exactly like the CLI flag without the leading dashes.
export const CHANNEL_PRESET_OPERATIONAL_FLAGS = Object.freeze([
  // planning
  "planning-provider", "planning-effort-policy", "planning-model", "planning-reasoning-effort",
  // images
  "image-provider", "image-model", "reference-model", "image-fallback-provider", "image-fallback-condition",
  "google-flow-plan", "google-flow-model", "google-gemini-plan", "google-gemini-model", "google-image-scheduling",
  "google-flow-health-proof", "google-flow-health-proof-sha256", "chatgpt-project-url",
  // narration
  "audio-target", "tts-provider", "narrator-voice-id", "narrator-reference-variant", "narration-delivery-bank",
  // pace
  "pace-policy", "target-wpm-min", "target-wpm-max",
  // render / motion / parallax
  "render-profile", "motion-policy", "generated-motion-policy", "generated-motion-provider", "generated-motion-model",
  "generated-motion-required-through-sec", "parallax-policy", "parallax-target-max", "parallax-min-spacing-sec",
  "parallax-opening-window-sec", "parallax-first-window-sec", "parallax-first-window-target",
  "parallax-retention-window-target", "parallax-background-provider",
  // beat timing
  "beat-timing-enforcement", "target-beat-sec", "max-beat-sec", "min-beat-sec", "hook-duration-sec",
  "hook-target-beat-sec", "hook-max-beat-sec", "hook-min-beat-sec", "retention-ramp-sec",
  "ramp-target-beat-sec", "ramp-max-beat-sec", "ramp-min-beat-sec",
  // production profile and autopilot
  "production-profile", "autopilot", "episode-budget-usd",
]);

// Flags that preflight refuses from a preset. The first three are the editorial/format/intent
// choices that must stay explicit; the rest are per-run identity or operator attestations.
export const CHANNEL_PRESET_FORBIDDEN_FLAGS = Object.freeze([
  "content-profile", "media-workflow", "run-intent", "intent",
  "channel", "series", "week", "episode", "title", "episode-title", "source", "source-handoff", "channel-preset",
  "evidence-ledger", "winner-release", "allow-dirty-worktree", "dirty-reason", "confirm-episode-identity",
  "allow-part-in-week", "proof-source-complete", "proof-scope", "proof-start-sec", "proof-end-sec", "human-checkpoints",
]);

const EXPLICIT_WHEN_BRIDGED = Object.freeze(["content-profile", "media-workflow", "run-intent"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateChannelPreset(document, { channel = null } = {}) {
  const blockers = [];
  if (document?.schema !== CHANNEL_PRESET_SCHEMA) blockers.push("channel_preset_schema_invalid");
  if (typeof document?.channel !== "string" || !document.channel.trim()) blockers.push("channel_preset_channel_missing");
  else if (channel && document.channel !== channel) blockers.push("channel_preset_channel_mismatch");
  if (typeof document?.version !== "string" || !document.version.trim()) blockers.push("channel_preset_version_missing");
  if (typeof document?.authored_by !== "string" || !document.authored_by.trim()) blockers.push("channel_preset_author_missing");
  if (!isRecord(document?.flags)) {
    blockers.push("channel_preset_flags_missing");
    return { done: false, blockers };
  }
  for (const [key, value] of Object.entries(document.flags)) {
    if (CHANNEL_PRESET_FORBIDDEN_FLAGS.includes(key)) blockers.push(`channel_preset_forbidden_flag:${key}`);
    else if (!CHANNEL_PRESET_OPERATIONAL_FLAGS.includes(key)) blockers.push(`channel_preset_unknown_flag:${key}`);
    if (!["string", "number", "boolean"].includes(typeof value) || String(value).trim() === "") blockers.push(`channel_preset_flag_value_invalid:${key}`);
  }
  return { done: blockers.length === 0, blockers };
}

export function loadChannelPresetSync(presetPath, { channel = null, readFile = (file) => readFileSync(file) } = {}) {
  const resolved = path.resolve(presetPath);
  let bytes;
  try {
    bytes = readFile(resolved);
  } catch (error) {
    throw new Error(`Missing channel preset: ${resolved} (${error instanceof Error ? error.message : String(error)})`);
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid channel preset JSON at ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validation = validateChannelPreset(document, { channel });
  if (!validation.done) {
    const forbidden = validation.blockers.filter((row) => row.startsWith("channel_preset_forbidden_flag:"));
    if (forbidden.length) {
      throw new Error(`Channel preset ${resolved} may not supply ${forbidden.map((row) => `--${row.split(":")[1]}`).join(", ")}: the content profile, media workflow and run intent stay explicit flags, and a channel never infers a content family.`);
    }
    throw new Error(`Channel preset ${resolved} is invalid: ${validation.blockers.join(", ")}.`);
  }
  return { path: resolved, sha256: sha256(bytes), document };
}

export function loadSourceHandoffSync(handoffPath, { readFile = (file) => readFileSync(file) } = {}) {
  const resolved = path.resolve(handoffPath);
  let bytes;
  try {
    bytes = readFile(resolved);
  } catch (error) {
    throw new Error(`Missing source hand-off: ${resolved} (${error instanceof Error ? error.message : String(error)})`);
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid source hand-off JSON at ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validation = validateSourceHandoff(document);
  if (!validation.done) throw new Error(`Source hand-off ${resolved} is invalid (${SOURCE_HANDOFF_SCHEMA}): ${validation.blockers.join(", ")}.`);
  return { path: resolved, sha256: sha256(bytes), document };
}

/**
 * Expands `--channel-preset` and `--source-handoff` into the preflight flag map.
 * Explicit CLI flags always win over the preset and are recorded as overrides. The hand-off
 * supplies `--title` and `--source`; an explicit `--source` must name the same file. Both
 * inputs require `--content-profile`, `--media-workflow` and `--run-intent` on the command
 * line. Returns the merged flags plus the identity bindings to record.
 */
export function expandPreflightFlags(cliFlags = {}, { readFile = (file) => readFileSync(file) } = {}) {
  const flags = { ...cliFlags };
  const presetPath = cliFlags["channel-preset"] ?? null;
  const handoffPath = cliFlags["source-handoff"] ?? null;
  if (!presetPath && !handoffPath) return { flags, channel_preset: null, source_handoff: null };
  const missing = EXPLICIT_WHEN_BRIDGED.filter((key) => !String(cliFlags[key] ?? "").trim());
  if (missing.length) {
    throw new Error(`--channel-preset/--source-handoff require explicit ${missing.map((key) => `--${key}`).join(", ")}; neither the preset nor the hand-off may decide the editorial profile, media workflow or run intent.`);
  }
  let channelPreset = null;
  if (presetPath) {
    const loaded = loadChannelPresetSync(presetPath, { channel: cliFlags.channel ?? null, readFile });
    const applied = {};
    const overridden = {};
    for (const [key, value] of Object.entries(loaded.document.flags)) {
      if (Object.hasOwn(cliFlags, key)) overridden[key] = { preset: String(value), cli: String(cliFlags[key]) };
      else {
        flags[key] = String(value);
        applied[key] = String(value);
      }
    }
    channelPreset = {
      schema: CHANNEL_PRESET_SCHEMA,
      path: loaded.path,
      sha256: loaded.sha256,
      version: loaded.document.version,
      authored_by: loaded.document.authored_by,
      applied_flags: applied,
      overridden_by_cli: overridden,
      explicit_flags_required: [...EXPLICIT_WHEN_BRIDGED],
    };
  }
  let sourceHandoff = null;
  if (handoffPath) {
    const loaded = loadSourceHandoffSync(handoffPath, { readFile });
    const scriptPath = path.resolve(loaded.document.final_script_path);
    if (cliFlags.source && path.resolve(cliFlags.source) !== scriptPath) {
      throw new Error(`--source ${path.resolve(cliFlags.source)} does not match the hand-off's final_script_path ${scriptPath}.`);
    }
    flags.source = scriptPath;
    const explicitTitle = String(cliFlags.title ?? cliFlags["episode-title"] ?? "").trim();
    if (!explicitTitle) {
      if (!loaded.document.title) throw new Error(`Source hand-off ${loaded.path} carries no title (brought script without a brief); pass --title explicitly.`);
      flags.title = loaded.document.title;
    }
    sourceHandoff = {
      schema: loaded.document.schema,
      path: loaded.path,
      sha256: loaded.sha256,
      script_sha256: loaded.document.sha256,
      final_script_path: scriptPath,
      title: loaded.document.title,
      title_overridden_by_cli: explicitTitle && explicitTitle !== loaded.document.title ? explicitTitle : null,
      brief_sha256: loaded.document.brief_sha256 ?? null,
      model_lock_sha256: loaded.document.model_lock_sha256 ?? null,
      evidence_sha256: loaded.document.evidence_sha256 ?? null,
      development_dir: loaded.document.development_dir ?? null,
    };
  }
  return { flags, channel_preset: channelPreset, source_handoff: sourceHandoff };
}

/** Preflight verifies the ingested script bytes against the hand-off before locking identity. */
export function assertSourceMatchesHandoff(sourceHandoff, sourceSha256) {
  if (!sourceHandoff) return;
  if (sourceHandoff.script_sha256 !== sourceSha256) {
    throw new Error(`Source hand-off script hash ${sourceHandoff.script_sha256} does not match ${sourceHandoff.final_script_path} (${sourceSha256}); re-run source manufacture revise or pass the exact retained script.`);
  }
}
