import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  creativeStageRerunDecision,
  creativeStageRerunDecisionForEpisode,
  guardedCreativeCommandsForTests,
} from "../lib/creative-stage-rerun-policy.mjs";

function completed({ stage, command, status = "failed", referencesOnly = false }) {
  return {
    event_type: "stage_completed",
    stage,
    command,
    status,
    scope: { references_only: referencesOnly },
  };
}

assert.equal(guardedCreativeCommandsForTests.includes("tts narrate"), true);
assert.equal(guardedCreativeCommandsForTests.includes("imagegen browser-pool"), true);

assert.equal(creativeStageRerunDecisionForEpisode({
  command: "imagegen",
  subcommand: "browser-pool",
  stage: "image_generation",
}).reason, "episode_identity_required_for_creative_rerun_guard");
assert.equal(creativeStageRerunDecisionForEpisode({
  command: "imagegen",
  subcommand: "codex-work",
  stage: "image_generation",
  flags: { action: "status" },
}).reason, "codex_work_noncreative_control_action");

assert.equal(creativeStageRerunDecision({
  command: "imagegen",
  subcommand: "browser-pool",
  stage: "image_generation",
}).reason, "first_full_scope_submission");

const failedSceneBatch = completed({
  stage: "image_generation",
  command: "imagegen browser-pool",
});
assert.equal(creativeStageRerunDecision({
  command: "imagegen",
  subcommand: "browser-pool",
  stage: "image_generation",
  priorEvents: [failedSceneBatch],
}).reason, "creative_full_scope_already_submitted");
assert.equal(creativeStageRerunDecision({
  command: "imagegen",
  subcommand: "browser-pool",
  stage: "image_generation",
  flags: { "image-ids": "cut_017,cut_031" },
  priorEvents: [failedSceneBatch],
}).reason, "exact_scope_repair");
assert.equal(creativeStageRerunDecision({
  command: "imagegen",
  subcommand: "start",
  stage: "image_generation",
  priorEvents: [failedSceneBatch],
}).reason, "creative_full_scope_already_submitted", "switching scene image commands must not bypass the shared creative lane");
assert.equal(creativeStageRerunDecision({
  command: "imagegen",
  subcommand: "start",
  stage: "image_generation",
  flags: { "cut-id": "cut_017" },
  priorEvents: [failedSceneBatch],
}).reason, "exact_scope_repair", "the singular scene cut flag must remain valid exact scope");
assert.equal(creativeStageRerunDecision({
  command: "imagegen",
  subcommand: "codex-work",
  stage: "image_generation",
  flags: { action: "create" },
  priorEvents: [failedSceneBatch],
}).reason, "creative_full_scope_already_submitted", "codex-work create must share the scene image lane");

assert.equal(creativeStageRerunDecision({
  command: "imagegen",
  subcommand: "browser-pool",
  stage: "reference_generation",
  flags: { "references-only": "true" },
  priorEvents: [failedSceneBatch],
}).reason, "first_full_scope_submission");

const orphanedVoiceStart = {
  event_type: "stage_started",
  stage: "voice_plan",
  command: "voice plan",
};
assert.equal(creativeStageRerunDecision({
  command: "voice",
  subcommand: "plan",
  stage: "voice_plan",
  priorEvents: [orphanedVoiceStart],
}).allowed, false, "an ambiguous/orphaned creative submission must not be repeated wholesale");

assert.equal(creativeStageRerunDecision({
  command: "tts",
  subcommand: "narrate",
  stage: "qwen_tts_stitch",
  flags: { "confirmed-retry-unit-ids": "tts_004" },
  priorEvents: [completed({ stage: "qwen_tts_stitch", command: "tts narrate" })],
}).reason, "exact_scope_repair");
assert.equal(creativeStageRerunDecision({
  command: "tts",
  subcommand: "narrate",
  stage: "qwen_tts_stitch",
  flags: { "stitch-repair-tail-unit-ids": "tts_004" },
  priorEvents: [completed({ stage: "qwen_tts_stitch", command: "tts qwen" })],
}).reason, "exact_scope_repair");
assert.equal(creativeStageRerunDecision({
  command: "tts",
  subcommand: "qwen",
  stage: "qwen_tts_stitch",
  priorEvents: [completed({ stage: "qwen_tts_stitch", command: "tts narrate" })],
}).reason, "creative_full_scope_already_submitted", "switching TTS commands must not bypass the shared creative lane");
assert.equal(creativeStageRerunDecision({
  command: "tts",
  subcommand: "qwen",
  stage: "qwen_tts_stitch",
  flags: { "regenerate-speakers": "NARRATOR" },
  priorEvents: [completed({ stage: "qwen_tts_stitch", command: "tts narrate" })],
}).allowed, false, "speaker-wide regeneration is a full-stage request, not exact unit scope");
assert.equal(creativeStageRerunDecision({
  command: "tts",
  subcommand: "narrate",
  stage: "qwen_tts_stitch",
  flags: { "unit-ids": "tts_004" },
  priorEvents: [completed({ stage: "qwen_tts_stitch", command: "tts narrate" })],
}).allowed, false, "unsupported scope aliases must not bypass the full-stage guard");
assert.equal(creativeStageRerunDecision({
  command: "tts",
  subcommand: "import-provider",
  stage: "qwen_tts_stitch",
  priorEvents: [completed({ stage: "qwen_tts_stitch", command: "tts narrate" })],
}).reason, "not_a_guarded_creative_command");
assert.equal(creativeStageRerunDecision({
  command: "imagegen",
  subcommand: "codex-work",
  stage: "image_generation",
  flags: { action: "lease" },
  priorEvents: [completed({ stage: "image_generation", command: "imagegen codex-work" })],
}).reason, "codex_work_noncreative_control_action");

assert.equal(creativeStageRerunDecision({
  command: "imagegen",
  subcommand: "browser-pool",
  stage: "image_generation",
  flags: { "allow-full-stage-rerun": "true" },
  priorEvents: [failedSceneBatch],
}).reason, "full_stage_rerun_override_requires_bypass_and_reason");
assert.equal(creativeStageRerunDecision({
  command: "imagegen",
  subcommand: "browser-pool",
  stage: "image_generation",
  flags: {
    "workflow-bypass": "true",
    "allow-full-stage-rerun": "true",
    "rerun-reason": "operator approved diagnostic after provider contract migration",
  },
  priorEvents: [failedSceneBatch],
}).reason, "explicit_operator_approved_full_stage_rerun");

const failedRender = completed({
  stage: "premium_render",
  command: "render start",
  status: "failed",
});
assert.equal(creativeStageRerunDecision({
  command: "render",
  subcommand: "start",
  stage: "premium_render",
  priorEvents: [failedRender],
}).allowed, true, "a failed render may resume from the immutable clip cache");
assert.equal(creativeStageRerunDecision({
  command: "render",
  subcommand: "start",
  stage: "premium_render",
  priorEvents: [{ ...failedRender, status: "passed" }],
}).reason, "passed_full_stage_rerun_forbidden");

const zeroSpendEpisodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-zero-spend-rerun-"));
const gateRelativePath = "narration_tts_pre_synthesis_gate_ep_01.json";
const gatePath = path.join(zeroSpendEpisodeDir, gateRelativePath);
const gate = {
  schema: "goldflow_narration_pre_synthesis_gate_v2",
  status: "blocked",
  production_stage_passed: false,
  model_load_performed: false,
  synthesis_invoked: false,
  historical_synthesis_authorized: false,
  gate_sha256: "a".repeat(64),
};
await fs.writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf8");
const gateFileSha256 = createHash("sha256")
  .update(await fs.readFile(gatePath))
  .digest("hex");
const zeroSpendEvent = completed({
  stage: "qwen_tts_stitch",
  command: "tts narrate",
});
zeroSpendEvent.execution_id = "zero-spend-attempt";
zeroSpendEvent.output_hashes = { [gateRelativePath]: gateFileSha256 };
await fs.writeFile(
  path.join(zeroSpendEpisodeDir, "execution_events.jsonl"),
  `${JSON.stringify(zeroSpendEvent)}\n`,
  "utf8",
);
assert.equal(creativeStageRerunDecisionForEpisode({
  command: "tts",
  subcommand: "narrate",
  stage: "qwen_tts_stitch",
  episodeDir: zeroSpendEpisodeDir,
}).reason, "proven_zero_spend_pre_synthesis_retry");

gate.synthesis_invoked = true;
await fs.writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf8");
zeroSpendEvent.output_hashes[gateRelativePath] = createHash("sha256")
  .update(await fs.readFile(gatePath))
  .digest("hex");
await fs.writeFile(
  path.join(zeroSpendEpisodeDir, "execution_events.jsonl"),
  `${JSON.stringify(zeroSpendEvent)}\n`,
  "utf8",
);
assert.equal(creativeStageRerunDecisionForEpisode({
  command: "tts",
  subcommand: "narrate",
  stage: "qwen_tts_stitch",
  episodeDir: zeroSpendEpisodeDir,
}).allowed, false, "a mutated or spend-authorized gate must not unlock a full retry");
gate.synthesis_invoked = false;
gate.historical_synthesis_authorized = true;
await fs.writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf8");
zeroSpendEvent.output_hashes[gateRelativePath] = createHash("sha256")
  .update(await fs.readFile(gatePath))
  .digest("hex");
await fs.writeFile(
  path.join(zeroSpendEpisodeDir, "execution_events.jsonl"),
  `${JSON.stringify(zeroSpendEvent)}\n`,
  "utf8",
);
assert.equal(creativeStageRerunDecisionForEpisode({
  command: "tts",
  subcommand: "narrate",
  stage: "qwen_tts_stitch",
  episodeDir: zeroSpendEpisodeDir,
}).allowed, false, "a zero-spend latest attempt must not erase an earlier synthesis authorization");
await fs.rm(zeroSpendEpisodeDir, { recursive: true, force: true });

console.log("creative stage rerun policy tests passed");
