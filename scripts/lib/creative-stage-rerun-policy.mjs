import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const ONE_SHOT_CREATIVE_COMMANDS = Object.freeze(new Map([
  ["voice plan", Object.freeze({
    stage: "voice_plan",
    scope_flags: Object.freeze([
      "performance-packet-ids",
      "performance-packet-id",
    ]),
  })],
  ["tts narrate", Object.freeze({
    stage: "qwen_tts_stitch",
    scope_flags: Object.freeze([
      "confirmed-retry-unit-ids",
      "regenerate-unit-ids",
      "stitch-repair-tail-unit-ids",
    ]),
  })],
  ["tts qwen", Object.freeze({
    stage: "qwen_tts_stitch",
    scope_flags: Object.freeze([
      "regenerate-unit-ids",
      "unit-ids",
    ]),
  })],
  ["imagegen browser-pool", Object.freeze({
    stage: null,
    scope_flags: Object.freeze([
      "reference-ids",
      "reference-id",
      "image-ids",
      "image-id",
      "cut-ids",
      "cut-id",
    ]),
  })],
  ["imagegen start", Object.freeze({
    stage: null,
    scope_flags: Object.freeze([
      "reference-ids",
      "reference-id",
      "image-ids",
      "image-id",
      "cut-ids",
      "cut-id",
    ]),
  })],
  ["imagegen codex-work", Object.freeze({
    stage: null,
    scope_flags: Object.freeze([
      "reference-ids",
      "reference-id",
      "image-ids",
      "image-id",
      "cut-ids",
      "cut-id",
    ]),
  })],
  ["visual generated-motion", Object.freeze({
    stage: "generated_video_motion",
    scope_flags: Object.freeze(["cut-ids", "image-ids"]),
  })],
  ["visual parallax-assets", Object.freeze({
    stage: "parallax_asset_generation",
    scope_flags: Object.freeze(["image-ids"]),
  })],
]));

const PASSED_FULL_STAGE_COMMANDS = Object.freeze(new Map([
  ["render start", "premium_render"],
]));

function isTrue(value) {
  return /^(?:true|1|yes)$/i.test(String(value ?? ""));
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function readEvents(episodeDir) {
  if (!episodeDir) return [];
  try {
    return readFileSync(path.join(episodeDir, "execution_events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function fileSha256(filePath) {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function provenZeroSpendNarrationAttempt(episodeDir, priorEvents) {
  if (!episodeDir) return null;
  const relevantEvents = priorEvents.filter((event) => (
    event?.stage === "qwen_tts_stitch"
    && String(event?.command ?? "").trim() === "tts narrate"
    && ["stage_started", "stage_completed"].includes(event?.event_type)
  ));
  const latestEvent = relevantEvents.at(-1) ?? null;
  if (latestEvent?.event_type !== "stage_completed") return null;
  const outputHashes = latestEvent.output_hashes ?? {};
  const gateEntries = Object.entries(outputHashes).filter(([relativePath]) => (
    /^narration_tts_pre_synthesis_gate_.*\.json$/u.test(relativePath)
  ));
  if (gateEntries.length !== 1) return null;
  const [relativePath, recordedSha256] = gateEntries[0];
  const gatePath = path.join(episodeDir, relativePath);
  if (fileSha256(gatePath) !== recordedSha256) return null;
  let gate;
  try {
    gate = JSON.parse(readFileSync(gatePath, "utf8"));
  } catch {
    return null;
  }
  if (gate?.schema !== "goldflow_narration_pre_synthesis_gate_v2"
    || gate?.production_stage_passed !== false
    || gate?.model_load_performed !== false
    || gate?.synthesis_invoked !== false
    || gate?.historical_synthesis_authorized !== false
    || !/^[a-f0-9]{64}$/u.test(String(gate?.gate_sha256 ?? ""))) {
    return null;
  }
  return {
    execution_id: latestEvent.execution_id ?? null,
    gate_path: gatePath,
    gate_file_sha256: recordedSha256,
    gate_status: gate.status ?? null,
  };
}

function normalizedCommand(command, subcommand) {
  return `${String(command ?? "").trim()} ${String(subcommand ?? "").trim()}`.trim();
}

function commandLane(commandKey, stage, flags = {}) {
  if (["tts narrate", "tts qwen"].includes(commandKey)) return "tts:qwen_tts_stitch";
  if (["imagegen browser-pool", "imagegen start", "imagegen codex-work"].includes(commandKey)) {
    const referencesOnly = stage === "reference_generation" || isTrue(flags["references-only"]);
    return `imagegen:${referencesOnly ? "references" : "scenes"}`;
  }
  return commandKey;
}

function priorCommandLane(event = {}) {
  const key = String(event.command ?? "").trim();
  if (["tts narrate", "tts qwen"].includes(key)) return "tts:qwen_tts_stitch";
  if (["imagegen browser-pool", "imagegen start", "imagegen codex-work"].includes(key)) {
    const referencesOnly = event.stage === "reference_generation"
      || event.scope?.references_only === true
      || isTrue(event.flags?.["references-only"]);
    return `imagegen:${referencesOnly ? "references" : "scenes"}`;
  }
  return key;
}

function explicitFullRerunOverride(flags = {}) {
  const allowed = isTrue(flags["workflow-bypass"])
    && isTrue(flags["allow-full-stage-rerun"])
    && hasValue(flags["rerun-reason"]);
  return {
    allowed,
    requested: isTrue(flags["allow-full-stage-rerun"]),
  };
}

export function creativeStageRerunDecision({
  command,
  subcommand,
  stage,
  flags = {},
  priorEvents = [],
  zeroSpendNarrationEvidence = null,
} = {}) {
  const commandKey = normalizedCommand(command, subcommand);
  if (commandKey === "imagegen codex-work"
    && String(flags.action ?? "create").trim().toLowerCase() !== "create") {
    return { allowed: true, reason: "codex_work_noncreative_control_action" };
  }
  const oneShot = ONE_SHOT_CREATIVE_COMMANDS.get(commandKey) ?? null;
  const passedOnlyStage = PASSED_FULL_STAGE_COMMANDS.get(commandKey) ?? null;
  if (!oneShot && !passedOnlyStage) {
    return { allowed: true, reason: "not_a_guarded_creative_command" };
  }

  const override = explicitFullRerunOverride(flags);
  if (override.requested && !override.allowed) {
    return {
      allowed: false,
      reason: "full_stage_rerun_override_requires_bypass_and_reason",
      required_recovery: "A full-stage rerun override requires --workflow-bypass true --allow-full-stage-rerun true --rerun-reason <operator-approved-evidence>.",
    };
  }

  const expectedStage = oneShot?.stage ?? passedOnlyStage;
  if (expectedStage && stage && expectedStage !== stage) {
    return { allowed: true, reason: "guarded_command_stage_mismatch" };
  }
  const scopeFlags = oneShot?.scope_flags ?? [];
  const activeScopeFlags = scopeFlags.filter((name) => hasValue(flags[name]));
  if (activeScopeFlags.length) {
    return {
      allowed: true,
      reason: "exact_scope_repair",
      scope_flags: activeScopeFlags,
    };
  }
  if (override.allowed) {
    return {
      allowed: true,
      reason: "explicit_operator_approved_full_stage_rerun",
      rerun_reason: String(flags["rerun-reason"]).trim(),
    };
  }

  const lane = commandLane(commandKey, stage, flags);
  const relevantEvents = priorEvents.filter((event) => (
    event?.stage === stage
    && priorCommandLane(event) === lane
    && ["stage_started", "stage_completed"].includes(event?.event_type)
  ));
  const completedEvents = relevantEvents.filter((event) => event.event_type === "stage_completed");
  const passedEvents = completedEvents.filter((event) => event.status === "passed");
  const blockedByPrior = passedOnlyStage ? passedEvents.length > 0 : relevantEvents.length > 0;
  if (!blockedByPrior) {
    return { allowed: true, reason: "first_full_scope_submission", command_lane: lane };
  }
  const latestRelevantEvent = relevantEvents.at(-1) ?? null;
  if (commandKey === "tts narrate"
    && latestRelevantEvent?.event_type === "stage_completed"
    && zeroSpendNarrationEvidence
    && zeroSpendNarrationEvidence?.execution_id === latestRelevantEvent.execution_id) {
    return {
      allowed: true,
      reason: "proven_zero_spend_pre_synthesis_retry",
      command_lane: lane,
      zero_spend_evidence: zeroSpendNarrationEvidence,
    };
  }

  const attemptedScope = oneShot
    ? "Use the stage report/ledger to name only the failed IDs. Passed assets and cached work remain immutable."
    : "The passed full render is immutable. Use an explicitly named diagnostic variant or an operator-approved full-stage rerun override when a new render is genuinely required.";
  return {
    allowed: false,
    reason: passedOnlyStage
      ? "passed_full_stage_rerun_forbidden"
      : "creative_full_scope_already_submitted",
    command_lane: lane,
    prior_start_count: relevantEvents.filter((event) => event.event_type === "stage_started").length,
    prior_completion_count: completedEvents.length,
    prior_pass_count: passedEvents.length,
    required_recovery: attemptedScope,
  };
}

export function creativeStageRerunDecisionForEpisode({
  command,
  subcommand,
  stage,
  flags = {},
  episodeDir,
} = {}) {
  const commandKey = normalizedCommand(command, subcommand);
  const guarded = ONE_SHOT_CREATIVE_COMMANDS.has(commandKey)
    || PASSED_FULL_STAGE_COMMANDS.has(commandKey);
  const nonCreativeCodexControl = commandKey === "imagegen codex-work"
    && String(flags.action ?? "create").trim().toLowerCase() !== "create";
  if (guarded && !nonCreativeCodexControl && !episodeDir) {
    return {
      allowed: false,
      reason: "episode_identity_required_for_creative_rerun_guard",
      required_recovery: "Pass --episode-dir <absolute-episode-dir> or the complete --channel/--week/--episode identity so Goldflow can inspect durable attempt history before creative work.",
    };
  }
  const priorEvents = readEvents(episodeDir);
  return creativeStageRerunDecision({
    command,
    subcommand,
    stage,
    flags,
    priorEvents,
    zeroSpendNarrationEvidence: commandKey === "tts narrate"
      ? provenZeroSpendNarrationAttempt(episodeDir, priorEvents)
      : null,
  });
}

export const guardedCreativeCommandsForTests = Object.freeze([
  ...ONE_SHOT_CREATIVE_COMMANDS.keys(),
  ...PASSED_FULL_STAGE_COMMANDS.keys(),
]);
