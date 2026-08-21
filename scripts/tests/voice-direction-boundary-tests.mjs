import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  hasTtsTerminalPunctuation,
  isInlineQuotedNarrationTerm,
  normalizeAtomicSpokenTerminal,
} from "../voice-direction-gate.mjs";
import {
  buildNarrationPerformanceContract,
  narrationSourceRefKey,
  validateActionableNarrationDirection,
  validateNarrationPerformanceBakeoffApproval,
} from "../lib/narration-performance-contract.mjs";
import {
  QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK,
  QWEN_LIAM_UNIT_CONTRACT,
  QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  defaultNarrationVoiceProviderOptions,
  narrationTtsPolicyForIdentity,
} from "../lib/narration-tts-policy.mjs";
import {
  validateNarrationPerformanceGateForTests,
} from "../narration-tts-episode.mjs";
import {
  NARRATION_PERFORMANCE_SAFE_MAX_BYTES,
  NARRATION_PERFORMANCE_TARGET_ATOMS,
  authorNarrationPerformanceDirection,
  narrationPerformancePacketPlanForTests,
} from "../lib/narration-performance-author.mjs";

assert.equal(isInlineQuotedNarrationTerm({
  before: "The second time, because I wrote",
  quotedText: "currently uncertain",
}), true);
assert.equal(isInlineQuotedNarrationTerm({
  before: "Serena said,",
  quotedText: "You are coming with me.",
}), false);

assert.equal(
  normalizeAtomicSpokenTerminal("Current Rank: B", {
    sourceText: "CURRENT RANK: B",
    kind: "narration",
  }),
  "Current Rank: B.",
);
assert.equal(
  normalizeAtomicSpokenTerminal("Elara Venn", {
    sourceText: "ELARA VENN",
    kind: "narration",
  }),
  "Elara Venn.",
);
assert.equal(
  normalizeAtomicSpokenTerminal("because I wrote", {
    sourceText: "because I wrote",
    kind: "narration",
  }),
  "because I wrote",
);
assert.equal(hasTtsTerminalPunctuation("I knew you would—"), true);

assert.equal(QWEN_LIAM_UNIT_CONTRACT.target_words_min, null);
assert.equal(QWEN_LIAM_UNIT_CONTRACT.minimum_word_target_enforced, false);
assert.equal(QWEN_LIAM_UNIT_CONTRACT.hard_words_max, 60);

const dryDeadpanPolicy = narrationTtsPolicyForIdentity({
  schema: "goldflow_run_identity_v2",
  episode: "ep_01",
  tts_provider: "qwen_local",
  narrator_voice_id: "joel_owned_narrator_clone",
  voice_provider_options: {
    primary: {
      provider: "qwen_local",
      voice_id: "joel_owned_narrator_clone",
      reference_variant_id: "joel_ref_03_dry_deadpan",
    },
    synthesis_contract: QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  },
});
assert.equal(
  defaultNarrationVoiceProviderOptions().primary.reference_variant_id,
  "joel_ref_03_dry_deadpan",
);
assert.equal(
  dryDeadpanPolicy.primary.reference_audio_sha256,
  QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK.reference_audio_sha256,
);
assert.equal(
  dryDeadpanPolicy.primary.reference_variant_id,
  "joel_ref_03_dry_deadpan",
);
assert.equal(
  dryDeadpanPolicy.synthesis_contract.mode,
  QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode,
);

const sourceScriptSha256 = "a".repeat(64);
const atomicUnits = [
  {
    segment_id: "voice_seg_01",
    source_segment_ids: ["voice_seg_01"],
    source_unit_refs: [{ segment_id: "voice_seg_01", unit_index: 1 }],
    spoken_text: "He opened the door.",
    merge_barrier: false,
  },
  {
    segment_id: "voice_seg_01",
    source_segment_ids: ["voice_seg_01"],
    source_unit_refs: [{ segment_id: "voice_seg_01", unit_index: 2 }],
    spoken_text: "She said, run now.",
    merge_barrier: false,
  },
];
assert.equal(narrationSourceRefKey(atomicUnits[0].source_unit_refs[0]), "voice_seg_01:u001");
const actionable = {
  schema: "goldflow_narration_actionable_direction_v2",
  status: "approved",
  source_script_sha256: sourceScriptSha256,
  authoring: { kind: "llm_authored", provider: "test", model: "test-model" },
  units: [
    {
      source_ref_keys: ["voice_seg_01:u001"],
      spoken_text: "He opened the door!",
      dialogue_separation: "narration",
      boundary_after: "sentence",
      performance_intent: {
        energy: "controlled",
        tension: "neutral",
        intimacy: "standard",
        pace: "steady_forward",
        pause_strategy: "punctuation_led",
        emphasis: [],
      },
    },
    {
      source_ref_keys: ["voice_seg_01:u002"],
      spoken_text: "She said: run now.",
      dialogue_separation: "isolated_dialogue_turn",
      boundary_after: "episode_end",
      performance_intent: {
        energy: "urgent",
        tension: "high",
        intimacy: "close",
        pace: "fast",
        pause_strategy: "short_precise",
        emphasis: ["run now"],
      },
    },
  ],
};
assert.equal(validateActionableNarrationDirection({
  artifact: actionable,
  atomicUnits,
  sourceScriptSha256,
}).status, "passed");
const changedWords = structuredClone(actionable);
changedWords.units[1].spoken_text = "She said, hide now.";
assert.equal(validateActionableNarrationDirection({
  artifact: changedWords,
  atomicUnits,
  sourceScriptSha256,
}).status, "blocked");
const missingCoverage = structuredClone(actionable);
missingCoverage.units.pop();
assert.equal(validateActionableNarrationDirection({
  artifact: missingCoverage,
  atomicUnits,
  sourceScriptSha256,
}).status, "blocked");
const invalidBoundary = structuredClone(actionable);
invalidBoundary.units[0].boundary_after = "fixed_80ms";
assert.equal(validateActionableNarrationDirection({
  artifact: invalidBoundary,
  atomicUnits,
  sourceScriptSha256,
}).status, "blocked");

const actionableV3 = {
  ...structuredClone(actionable),
  schema: "goldflow_narration_actionable_direction_v3",
  chapter_prosody_spine: {
    schema: "goldflow_narration_chapter_prosody_spine_v1",
    status: "approved",
    chapters: [{
      segment_id: "voice_seg_01",
      dramatic_function: "Turn refusal into immediate forward pressure.",
      audience_effect: "Relief followed by curiosity.",
      energy_start: 2,
      energy_end: 4,
      tension_peak: 4,
      intimacy: 3,
      pace: "steady_forward",
      reveal_weight: 3,
      transition_from_previous: "Episode opening; enter without a reset pause.",
      avoidance: "Avoid trailer-voice melodrama.",
    }],
  },
};
assert.equal(validateActionableNarrationDirection({
  artifact: actionableV3,
  atomicUnits,
  sourceScriptSha256,
}).status, "passed");
const missingSpine = structuredClone(actionableV3);
missingSpine.chapter_prosody_spine.chapters = [];
assert.equal(validateActionableNarrationDirection({
  artifact: missingSpine,
  atomicUnits,
  sourceScriptSha256,
}).status, "blocked");

const performanceContract = buildNarrationPerformanceContract({
  provider: "qwen_local",
  modelId: "Qwen3-TTS-Base",
  modelRevision: "revision",
  voiceId: "joel",
  voiceSha256: "b".repeat(64),
  referenceAudioSha256: "c".repeat(64),
  referenceTextSha256: "d".repeat(64),
  synthesisContract: { mode: "serial" },
  actionableDirection: {
    authoring_kind: "llm_authored",
    artifact_sha256: "e".repeat(64),
  },
});
assert.equal(performanceContract.unit_contract.preferred_words_min, 20);
assert.equal(performanceContract.unit_contract.preferred_words_max, 42);
assert.equal(performanceContract.unit_contract.soft_words_max, 48);
assert.equal(performanceContract.unit_contract.hard_words_max, 60);
const approval = {
  schema: "goldflow_narration_performance_bakeoff_approval_v1",
  status: "approved",
  performance_contract_sha256: performanceContract.contract_sha256,
  reviewer: "human-operator",
  reviewed_at: "2026-08-13T12:00:00.000Z",
  listen_note: "Identity and delivery remained stable across the short probe.",
  human_performance_qa: {
    stable_identity: "passed",
    energetic_recap_cadence: "passed",
    natural_phrasing: "passed",
    emotional_variation: "passed",
    dialogue_clarity: "passed",
    audible_defects: "none",
  },
  samples: [{
    audio_path: "/tmp/bakeoff.wav",
    audio_sha256: "f".repeat(64),
    spoken_text_sha256: "1".repeat(64),
    synthesis_identity_sha256: "2".repeat(64),
    decision: "accepted",
  }],
};
assert.equal(validateNarrationPerformanceBakeoffApproval({
  approval,
  contract: performanceContract,
}).status, "passed");
assert.equal(validateNarrationPerformanceGateForTests({
  plan: { performance_contract: performanceContract },
  approval,
}).status, "passed");
const staleApproval = { ...approval, performance_contract_sha256: "0".repeat(64) };
assert.equal(validateNarrationPerformanceGateForTests({
  plan: { performance_contract: performanceContract },
  approval: staleApproval,
}).status, "blocked");

const multibytePerformanceUnits = Array.from({ length: 20 }, (_, index) => ({
  segment_id: "voice_seg_packet",
  source_segment_ids: ["voice_seg_packet"],
  source_unit_refs: [{ segment_id: "voice_seg_packet", unit_index: index + 1 }],
  spoken_text: `Unit ${index + 1} ${"界".repeat(180)}.`,
}));
const performancePackets = narrationPerformancePacketPlanForTests(multibytePerformanceUnits, {
  maximumAtoms: 20,
  maxPromptBytes: 4_500,
});
assert.ok(performancePackets.length > 1);
assert.ok(performancePackets.every((packet) => packet.prompt_bytes <= 4_500));
assert.deepEqual(
  performancePackets.flatMap((packet) => packet.source_ref_keys),
  multibytePerformanceUnits.map((unit) => narrationSourceRefKey(unit.source_unit_refs[0])),
);
assert.equal(NARRATION_PERFORMANCE_SAFE_MAX_BYTES, 48_000);
assert.equal(NARRATION_PERFORMANCE_TARGET_ATOMS, 96);
const defaultSizedPerformanceUnits = Array.from({ length: 190 }, (_, index) => ({
  segment_id: "voice_seg_default_packet",
  source_unit_refs: [{
    segment_id: "voice_seg_default_packet",
    unit_index: index + 1,
  }],
  kind: "narration",
  source_speaker: "NARRATOR",
  spoken_text: `Exact compact packet sentence ${index + 1}.`,
}));
const defaultSizedPackets = narrationPerformancePacketPlanForTests(
  defaultSizedPerformanceUnits,
);
assert.deepEqual(
  defaultSizedPackets.map((packet) => packet.chunk.length),
  [96, 94],
);
assert.ok(defaultSizedPackets.every(
  (packet) => packet.prompt_bytes <= NARRATION_PERFORMANCE_SAFE_MAX_BYTES,
));
assert.throws(() => narrationPerformancePacketPlanForTests([{
  segment_id: "voice_seg_oversized",
  source_segment_ids: ["voice_seg_oversized"],
  source_unit_refs: [{ segment_id: "voice_seg_oversized", unit_index: 1 }],
  spoken_text: `${"🔥".repeat(20_000)}.`,
}]), /safe ceiling is 48000 bytes/);

const performanceTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-performance-author-"));
try {
  let creativeSubmissionCount = 0;
  const invalidPlannerExecutor = async () => {
    creativeSubmissionCount += 1;
    return { content: "{}", provider: "codex_cli", model: "gpt-5.6-sol", reasoning_effort: "medium" };
  };
  await assert.rejects(() => authorNarrationPerformanceDirection({
    atomicUnits,
    sourceScriptSha256,
    episodeDir: performanceTempDir,
    repoRoot: performanceTempDir,
    provider: "codex_cli",
    plannerExecutor: invalidPlannerExecutor,
  }), /failed exact packet scope/);
  assert.equal(creativeSubmissionCount, 1, "a failed packet must not trigger an automatic second creative submission");
  const blockedDirection = JSON.parse(await fs.readFile(path.join(performanceTempDir, "narration_actionable_direction.json"), "utf8"));
  assert.equal(blockedDirection.status, "blocked");
  assert.equal(blockedDirection.authoring.packet_policy.automatic_creative_retry, false);
  assert.equal(blockedDirection.repair_scope.failed_packet_ids.length, 1);
  const failedPacketId = blockedDirection.repair_scope.failed_packet_ids[0];
  const passedPacketArtifact = structuredClone(blockedDirection);
  passedPacketArtifact.authoring.calls[0].status = "passed";
  passedPacketArtifact.repair_scope.failed_packet_ids = [];
  await fs.writeFile(
    path.join(performanceTempDir, "narration_actionable_direction.json"),
    `${JSON.stringify(passedPacketArtifact, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(() => authorNarrationPerformanceDirection({
    atomicUnits,
    sourceScriptSha256,
    episodeDir: performanceTempDir,
    repoRoot: performanceTempDir,
    provider: "codex_cli",
    repairPacketIds: [failedPacketId],
    repairReason: "Attempted repair of an already passed packet.",
    plannerExecutor: invalidPlannerExecutor,
  }), /not failed in the blocked artifact.*Passed packets are immutable/);
  assert.equal(creativeSubmissionCount, 1, "a passed packet must be rejected before provider submission");
  await fs.writeFile(
    path.join(performanceTempDir, "narration_actionable_direction.json"),
    `${JSON.stringify(blockedDirection, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(() => authorNarrationPerformanceDirection({
    atomicUnits,
    sourceScriptSha256,
    episodeDir: performanceTempDir,
    repoRoot: performanceTempDir,
    provider: "codex_cli",
    plannerExecutor: invalidPlannerExecutor,
  }), /unscoped resubmission is forbidden/);
  assert.equal(creativeSubmissionCount, 1);
  await assert.rejects(() => authorNarrationPerformanceDirection({
    atomicUnits,
    sourceScriptSha256,
    episodeDir: performanceTempDir,
    repoRoot: performanceTempDir,
    provider: "codex_cli",
    repairPacketIds: [failedPacketId],
    repairReason: "界".repeat(20_000),
    plannerExecutor: invalidPlannerExecutor,
  }), /failed exact packet scope/);
  assert.equal(creativeSubmissionCount, 1, "an over-ceiling final repair prompt must fail before provider submission");
  const overCeilingDirection = JSON.parse(await fs.readFile(path.join(performanceTempDir, "narration_actionable_direction.json"), "utf8"));
  assert.match(overCeilingDirection.authoring.calls[0].error, /final serialized prompt is .*safe ceiling is 48000 bytes/);
  const validPlannerExecutor = async (options) => {
    creativeSubmissionCount += 1;
    assert.equal(options.reasoningEffort, "medium");
    assert.ok(options.timeoutMs <= 480_000);
    return {
      provider: "codex_cli",
      model: "gpt-5.6-sol",
      reasoning_effort: "medium",
      content: JSON.stringify({
        chapters: [{
          segment_id: "voice_seg_01",
          dramatic_function: "Open and accelerate.",
          audience_effect: "Immediate curiosity.",
          energy_start: 2,
          energy_end: 4,
          tension_peak: 4,
          intimacy: 3,
          pace: "steady_forward",
          reveal_weight: 2,
          transition_from_previous: "Episode opening.",
          avoidance: "Avoid melodrama.",
        }],
        units: [
          {
            source_ref_keys: ["voice_seg_01:u001"],
            spoken_text: "He opened the door.",
            dialogue_separation: "preserve",
            boundary_after: "sentence",
            performance_intent: { energy: "controlled", tension: "neutral", intimacy: "standard", pace: "steady_forward", emphasis: [], pause_strategy: "punctuation_led", style_tags: [] },
          },
          {
            source_ref_keys: ["voice_seg_01:u002"],
            spoken_text: "She said, run now.",
            dialogue_separation: "preserve",
            boundary_after: "episode_end",
            performance_intent: { energy: "urgent", tension: "high", intimacy: "close", pace: "fast", emphasis: ["run now"], pause_strategy: "short_precise", style_tags: [] },
          },
        ],
      }),
    };
  };
  const repaired = await authorNarrationPerformanceDirection({
    atomicUnits,
    sourceScriptSha256,
    episodeDir: performanceTempDir,
    repoRoot: performanceTempDir,
    provider: "codex_cli",
    repairPacketIds: [failedPacketId],
    repairReason: "Reviewed exact packet: prior response omitted required source refs.",
    plannerExecutor: validPlannerExecutor,
  });
  assert.equal(creativeSubmissionCount, 2);
  assert.equal(repaired.artifact.status, "approved");
  assert.deepEqual(repaired.artifact.repair_scope.submitted_repair_packet_ids, [failedPacketId]);
} finally {
  await fs.rm(performanceTempDir, { recursive: true, force: true });
}
assert.equal(validateNarrationPerformanceGateForTests({
  plan: {},
  approval: null,
}).status, "legacy_not_required");

console.log("voice-direction boundary tests passed");
