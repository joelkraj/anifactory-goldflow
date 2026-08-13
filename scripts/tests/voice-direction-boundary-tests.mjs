import assert from "node:assert/strict";

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
  narrationTtsPolicyForIdentity,
} from "../lib/narration-tts-policy.mjs";
import {
  validateNarrationPerformanceGateForTests,
} from "../narration-tts-episode.mjs";

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
  schema: "goldflow_narration_actionable_direction_v1",
  status: "approved",
  source_script_sha256: sourceScriptSha256,
  authoring: { kind: "llm_authored", provider: "test", model: "test-model" },
  units: [
    {
      source_ref_keys: ["voice_seg_01:u001"],
      spoken_text: "He opened the door!",
      dialogue_separation: "narration",
    },
    {
      source_ref_keys: ["voice_seg_01:u002"],
      spoken_text: "She said: run now.",
      dialogue_separation: "isolated_dialogue_turn",
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
assert.equal(validateNarrationPerformanceGateForTests({
  plan: {},
  approval: null,
}).status, "legacy_not_required");

console.log("voice-direction boundary tests passed");
