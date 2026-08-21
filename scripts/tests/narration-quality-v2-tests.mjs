import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildNarrationQualityContract,
  validateNarrationQualityContract,
} from "../lib/narration-quality-contract.mjs";
import {
  buildNarrationTextIr,
  narrationTextIrSha256,
  validateNarrationTextIr,
} from "../lib/narration-text-ir.mjs";
import {
  buildNarrationProviderOutputManifest,
  compileNarrationProviderRequest,
  narrationProviderUnitQaSha256,
  narrationSynthesisIdentitySha256,
  validateNarrationProviderOutputManifest,
} from "../lib/narration-provider-adapter.mjs";
import {
  buildNarrationProviderUnitAsrContract,
  validateNarrationProviderUnitAsrReuse,
} from "../lib/narration-provider-unit-asr-reuse.mjs";
import {
  classifyNarrationBoundary,
  planAlignmentSafeUnitEdit,
  planNarrationBoundary,
  validateNarrationStitchAccounting,
} from "../lib/narration-boundary-editor.mjs";
import {
  NARRATION_EXACT_LISTEN_ATTESTATION,
  adjudicateNarrationDeliveryConsensus,
  buildNarrationExactListenReviewDecision,
  exactNarrationListenReviewPacket,
  strictNarrationDeliveryDecision,
  validateNarrationExactListenReviewDecision,
} from "../lib/narration-delivery-quality.mjs";
import {
  masterNarrationTwoPass,
  narrationMasteringPassthroughDecision,
  narrationRenderMasterReuseDecision,
} from "../lib/narration-mastering.mjs";
import {
  defaultNarrationVoiceProviderOptions,
  narrationTtsPolicyForIdentity,
  validateNarrationTtsPolicy,
} from "../lib/narration-tts-policy.mjs";
import {
  validateNarrationTtsPolicyForTests,
} from "../narration-tts-episode.mjs";
import {
  narrationNativeSpeedLockFindingForTests,
} from "../run-status.mjs";
import {
  conservativeNarrationEdgeAlignmentForTests,
  narrationAudioSampleCountForTests,
} from "../narration-provider-output-finalize.mjs";
import {
  planNarrationConfirmationWindows,
} from "../lib/narration-confirmation-windows.mjs";
import {
  buildLocalWhisperTimingCandidate,
  validateLocalWhisperTimingCandidate,
} from "../lib/local-whisper-timing-candidate.mjs";
import {
  emptyNarrationFinalizationCheckpoint,
  narrationFinalizationStageKey,
  narrationFinalizationUnitKey,
  reusableNarrationFinalizationStage,
  reusableNarrationFinalizationUnit,
} from "../lib/narration-finalization-checkpoint.mjs";
import {
  productionLocalWhisperContract,
} from "../lib/local-whisper-policy.mjs";
import {
  reusableUnitOutputQaForTests,
} from "../modelslab-qwen-episode-audio.mjs";
import {
  compileProviderSafeSpokenText,
  PROVIDER_SAFE_SPOKEN_COMPILER_ID,
} from "../lib/narration-spoken-text.mjs";
import {
  NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
  buildNarrationSubjectiveReviewDecision,
  buildNarrationSubjectiveReviewManifest,
  validateNarrationSubjectiveReviewDecision,
  validateNarrationSubjectiveReviewManifest,
} from "../lib/narration-subjective-review.mjs";
import {
  buildNarrationProviderBakeoffManifest,
  buildNarrationProviderPromotion,
  validateNarrationProviderBakeoffManifest,
  validateNarrationProviderPromotion,
} from "../lib/narration-provider-bakeoff-contract.mjs";

const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function strictSpokenTextLineage(unitId, sourceText, spokenText, receipts) {
  const componentReceipts = receipts.map((receipt) => ({
    ...receipt,
    source_unit_id: unitId,
  }));
  const lineage = {
    schema: "goldflow_spoken_text_lineage_v1",
    policy: "test exact lineage",
    components: [{
      source_unit_id: unitId,
      source_text: sourceText,
      source_text_sha256: sha256(sourceText),
      compiled_spoken_text: spokenText,
      compiled_spoken_text_sha256: sha256(spokenText),
      transformation_receipts: componentReceipts,
    }],
    pre_direction_spoken_text: spokenText,
    pre_direction_spoken_text_sha256: sha256(spokenText),
    final_transformations: [],
    final_spoken_text: spokenText,
    final_spoken_text_sha256: sha256(spokenText),
  };
  return {
    receipts: componentReceipts,
    lineage: {
      ...lineage,
      lineage_sha256: sha256(JSON.stringify(lineage)),
    },
  };
}

const contract = buildNarrationQualityContract({
  provider: "qwen_local",
  modelId: "Qwen3-TTS-12Hz-1.7B-Base-8bit",
});
assert.equal(
  compileProviderSafeSpokenText("The IT team fixed it."),
  "The I T team fixed it.",
);
assert.equal(
  compileProviderSafeSpokenText("Maya fixed it before dawn."),
  "Maya fixed it before dawn.",
);
assert.equal(validateNarrationQualityContract(contract).status, "passed");
const treatment = (provider, marker) => ({
  provider,
  model_id: `${provider}-model`,
  model_revision: "2026-08-18",
  voice_id: `${provider}-joel`,
  voice_sha256: marker.repeat(64),
  representative: {
    audio_path: `/tmp/${provider}-representative.wav`,
    audio_sha256: marker.repeat(64),
    duration_sec: 540,
  },
  fatigue: {
    audio_path: `/tmp/${provider}-fatigue.wav`,
    audio_sha256: marker.repeat(64),
    duration_sec: 1_500,
  },
  repeatability: {
    first_audio_sha256: marker.repeat(64),
    second_audio_sha256: marker.repeat(64),
  },
  economics: { latency_sec: 120, estimated_cost_usd: provider === "qwen_local" ? 0 : 3.5 },
});
const providerBakeoff = buildNarrationProviderBakeoffManifest({
  representativeTextSha256: "a".repeat(64),
  fatigueTextSha256: "b".repeat(64),
  voiceIdentitySha256: "c".repeat(64),
  baseline: treatment("qwen_local", "d"),
  challenger: treatment("fish_audio", "e"),
  voiceSimilarityEvidence: { path: "/tmp/similarity.json", sha256: "f".repeat(64) },
  repeatabilityEvidence: { path: "/tmp/repeatability.json", sha256: "1".repeat(64) },
});
assert.equal(validateNarrationProviderBakeoffManifest(providerBakeoff).status, "passed");
const challengerLabel = Object.entries(providerBakeoff.blind.labels)
  .find(([, value]) => value === "challenger")[0];
const providerPromotion = buildNarrationProviderPromotion({
  manifest: providerBakeoff,
  winnerLabel: challengerLabel,
  reviewer: "operator",
  blindPreference: challengerLabel,
  representativePass: true,
  fatiguePass: true,
  repeatabilityPass: true,
  voiceIdentityPass: true,
  voiceDriftVetoClear: true,
  costLatencyJustified: true,
  rationale: "The challenger won blind while preserving the owned voice identity.",
});
assert.equal(validateNarrationProviderPromotion(providerPromotion, providerBakeoff, {
  requiredProvider: "fish_audio",
}).status, "passed");
const qualityVoiceOptions = defaultNarrationVoiceProviderOptions({
  narrationQualityContract: contract,
});
const qualityRuntimePolicy = validateNarrationTtsPolicyForTests({
  schema: "goldflow_run_identity_v2",
  tts_provider: "qwen_local",
  tts_fallback_provider: null,
  narrator_voice_id: "joel_owned_narrator_clone",
  voice_provider_options: qualityVoiceOptions,
  narration_quality_contract: contract,
});
assert.equal(qualityRuntimePolicy.status, "passed");
assert.equal(qualityRuntimePolicy.primary.minimum_cosine_similarity, null);
assert.equal(
  qualityRuntimePolicy.primary.similarity_threshold_source,
  "owned_reference_leave_one_out_calibration",
);
assert.equal(qualityRuntimePolicy.unit_contract.target_words_max, 42);
assert.equal(qualityRuntimePolicy.stitch_contract.semantic_boundary_classes, true);

const externalContract = buildNarrationQualityContract({
  provider: "fish_audio",
  modelId: "fish-premium-model",
  modelRevision: "2026-08-17",
});
const externalVoiceOptions = defaultNarrationVoiceProviderOptions({
  provider: "fish_audio",
  voiceId: "joel-fish-clone",
  narrationQualityContract: externalContract,
  primaryOptions: {
    model_id: "fish-premium-model",
    model_revision: "2026-08-17",
    voice_sha256: "1".repeat(64),
    voice_continuity_contract: "owned-joel-fish-clone-v1",
    reference_manifest_path: "/tmp/reference-manifest.json",
    reference_manifest_sha256: "2".repeat(64),
    reference_voice_id: "joel_owned_narrator_clone",
    reference_voice_sha256: "3".repeat(64),
    speaker_similarity_method: "wespeaker_resnet34_voxceleb",
    speaker_similarity_model_path: "/tmp/speaker-model.onnx",
    speaker_similarity_model_sha256: "4".repeat(64),
    speaker_similarity_calibration_path: "/tmp/calibration.json",
    speaker_similarity_calibration_sha256: "5".repeat(64),
  },
});
const externalRuntimePolicy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity({
  schema: "goldflow_run_identity_v2",
  tts_provider: "fish_audio",
  tts_fallback_provider: null,
  narrator_voice_id: "joel-fish-clone",
  voice_provider_options: externalVoiceOptions,
  narration_quality_contract: externalContract,
}), { production: true });
assert.equal(externalRuntimePolicy.contract, "provider_neutral_external_v2");
assert.equal(externalRuntimePolicy.primary.provider, "fish_audio");
assert.equal(externalVoiceOptions.synthesis_contract, null);
assert.equal(
  narrationNativeSpeedLockFindingForTests([null, undefined], null),
  null,
);
assert.deepEqual(
  narrationNativeSpeedLockFindingForTests([1.1], null),
  { expected: null, actual: 1.1 },
);
assert.equal(
  narrationNativeSpeedLockFindingForTests([1.05], 1.05),
  null,
);
assert.deepEqual(
  narrationNativeSpeedLockFindingForTests([null], 1.05),
  { expected: 1.05, actual: null },
);
const conservativeEdge = conservativeNarrationEdgeAlignmentForTests({
  recognitions: [
    { words: [{ word: "first", start_sec: 0.08, end_sec: 0.3 }] },
    { words: [{ word: "first", start_sec: 0.04, end_sec: 0.34 }] },
  ],
  transcriptQas: [
    { leading_deletion_run: 0, trailing_deletion_run: 0 },
    { leading_deletion_run: 0, trailing_deletion_run: 0 },
  ],
  sampleCount: 24000,
  durationSec: 1,
});
assert.equal(conservativeEdge.status, "passed");
assert.equal(conservativeEdge.first_speech_sample, 960);
assert.equal(conservativeEdge.last_speech_sample_exclusive, 8160);
assert.deepEqual(conservativeNarrationEdgeAlignmentForTests({
  recognitions: [{ words: [{ word: "second", start_sec: 0.3, end_sec: 0.6 }] }],
  transcriptQas: [{ leading_deletion_run: 1, trailing_deletion_run: 0 }],
  sampleCount: 24000,
  durationSec: 1,
}), {
  status: "missing",
  reason: "transcript_edge_uncertain_preserve_entire_unit",
});

const exactWindowUnits = ["u1", "u2", "u3"].map((unitId) => ({
  unit_id: unitId,
  spoken_text: `${unitId} first second.`,
  canonical_token_count: 2,
}));
const exactWindowTimeline = [
  { unit_id: "u1", start_sample: 0, end_sample_exclusive: 100 },
  { unit_id: "u2", start_sample: 110, end_sample_exclusive: 210 },
  { unit_id: "u3", start_sample: 220, end_sample_exclusive: 320 },
];
const boundaryInsertionOperations = [
  { type: "match", intended: "a", recognized: "a" },
  { type: "match", intended: "b", recognized: "b" },
  { type: "insertion", intended: null, recognized: "extra" },
  { type: "match", intended: "c", recognized: "c" },
  { type: "match", intended: "d", recognized: "d" },
  { type: "match", intended: "e", recognized: "e" },
  { type: "match", intended: "f", recognized: "f" },
];
const boundaryWindowPlan = planNarrationConfirmationWindows({
  units: exactWindowUnits,
  timeline: exactWindowTimeline,
  operations: boundaryInsertionOperations,
  audioSampleCount: 320,
});
assert.equal(boundaryWindowPlan.status, "passed");
assert.equal(boundaryWindowPlan.window_count, 1);
assert.deepEqual(boundaryWindowPlan.windows[0].unit_ids, ["u1", "u2"]);
assert.deepEqual(boundaryWindowPlan.windows[0].boundary_ids, ["u1__u2"]);
assert.equal(boundaryWindowPlan.windows[0].start_sample, 0);
assert.equal(boundaryWindowPlan.windows[0].end_sample_exclusive, 210);
assert.equal(boundaryWindowPlan.coverage.opening_confirmation_required, true);
assert.equal(boundaryWindowPlan.coverage.final_confirmation_required, false);

const trailingDeletionOperations = [
  ...["a", "b", "c", "d", "e"].map((token) => ({
    type: "match",
    intended: token,
    recognized: token,
  })),
  { type: "deletion", intended: "f", recognized: null },
];
const trailingWindowPlan = planNarrationConfirmationWindows({
  units: exactWindowUnits,
  timeline: exactWindowTimeline,
  operations: trailingDeletionOperations,
  audioSampleCount: 320,
});
assert.equal(trailingWindowPlan.status, "passed");
assert.deepEqual(trailingWindowPlan.windows[0].unit_ids, ["u3"]);
assert.equal(trailingWindowPlan.coverage.final_confirmation_required, true);
assert.ok(trailingWindowPlan.coverage.final_confirmation_window_ids.length > 0);
assert.equal(planNarrationConfirmationWindows({
  units: exactWindowUnits,
  timeline: exactWindowTimeline,
  operations: trailingDeletionOperations,
  audioSampleCount: 319,
}).status, "blocked", "sample mapping must fail closed instead of widening to full Medium");

const timingContract = productionLocalWhisperContract();
const timingCandidate = buildLocalWhisperTimingCandidate({
  transcription: {
    text: "Opening ending",
    language: "en",
    language_probability: 0.999,
    duration_sec: 1,
    words: [
      { word: "Opening", start_sec: 0.05, end_sec: 0.35, probability: 0.99 },
      { word: "ending", start_sec: 0.5, end_sec: 0.9, probability: 0.99 },
    ],
  },
  contract: timingContract,
  sourceScriptPath: "/tmp/script_clean.md",
  sourceScriptSha256: "1".repeat(64),
  narrationAudioPath: "/tmp/narration.wav",
  narrationAudioSha256: "2".repeat(64),
  narrationReportPath: "/tmp/stitch.json",
  narrationReportSha256: "3".repeat(64),
  runIdentityPath: "/tmp/run_identity.json",
  runIdentitySha256: "4".repeat(64),
  narrationQualityContractSha256: "5".repeat(64),
});
const timingBindings = {
  contract: timingContract,
  sourceScriptSha256: "1".repeat(64),
  narrationAudioSha256: "2".repeat(64),
  narrationReportSha256: "3".repeat(64),
  runIdentitySha256: "4".repeat(64),
  narrationQualityContractSha256: "5".repeat(64),
};
assert.equal(
  validateLocalWhisperTimingCandidate(timingCandidate, timingBindings).status,
  "passed",
);
assert.equal(validateLocalWhisperTimingCandidate(timingCandidate, {
  ...timingBindings,
  narrationAudioSha256: "9".repeat(64),
}).status, "blocked");

const checkpointUnit = {
  unit_id: "u-checkpoint",
  spoken_text_sha256: "6".repeat(64),
  audio_sha256: "7".repeat(64),
  synthesis_identity_sha256: "8".repeat(64),
  provider: "qwen_local",
};
const checkpointUnitKey = narrationFinalizationUnitKey({
  unit: checkpointUnit,
  qualityContractSha256: "a".repeat(64),
});
const finalizationCheckpoint = emptyNarrationFinalizationCheckpoint();
finalizationCheckpoint.status = "in_progress";
finalizationCheckpoint.units[checkpointUnit.unit_id] = {
  unit_key: checkpointUnitKey,
  primary_recognition: { text: "cached" },
};
assert.equal(
  reusableNarrationFinalizationUnit(
    finalizationCheckpoint,
    checkpointUnit.unit_id,
    checkpointUnitKey,
  ).primary_recognition.text,
  "cached",
  "an interrupted finalizer must resume an immutable passed unit",
);
const preservedCheckpointUnit = {
  ...checkpointUnit,
  unit_id: "u-preserved",
  audio_sha256: "e".repeat(64),
};
const preservedCheckpointUnitKey = narrationFinalizationUnitKey({
  unit: preservedCheckpointUnit,
  qualityContractSha256: "a".repeat(64),
});
finalizationCheckpoint.units[preservedCheckpointUnit.unit_id] = {
  unit_key: preservedCheckpointUnitKey,
  primary_recognition: { text: "preserved after exact peer repair" },
};
const repairedUnitKey = narrationFinalizationUnitKey({
  unit: { ...checkpointUnit, audio_sha256: "b".repeat(64) },
  qualityContractSha256: "a".repeat(64),
});
assert.equal(
  reusableNarrationFinalizationUnit(
    finalizationCheckpoint,
    checkpointUnit.unit_id,
    repairedUnitKey,
  ),
  null,
  "an exact-unit audio repair must invalidate only that unit checkpoint",
);
assert.equal(
  reusableNarrationFinalizationUnit(
    finalizationCheckpoint,
    preservedCheckpointUnit.unit_id,
    preservedCheckpointUnitKey,
  ).primary_recognition.text,
  "preserved after exact peer repair",
  "a stale repaired peer must not invalidate an unrelated exact unit",
);
const stitchStageKey = narrationFinalizationStageKey("semantic_stitch", {
  unit_keys: [checkpointUnitKey],
});
finalizationCheckpoint.stages.semantic_stitch = {
  input_key: stitchStageKey,
  status: "passed",
  payload: { raw_wav_sha256: "c".repeat(64) },
};
assert.ok(reusableNarrationFinalizationStage(
  finalizationCheckpoint,
  "semantic_stitch",
  stitchStageKey,
), "an interrupted run may resume a completed content-addressed aggregate");
assert.equal(reusableNarrationFinalizationStage(
  finalizationCheckpoint,
  "semantic_stitch",
  narrationFinalizationStageKey("semantic_stitch", { unit_keys: [repairedUnitKey] }),
), null, "a repaired unit must invalidate downstream stitch while preserving other unit caches");

const reusableWaveformQa = {
  policy_version: "tts_output_qa_v3_review_warnings",
  status: "passed_with_warnings",
  audio_sha256: checkpointUnit.audio_sha256,
  metrics: { sample_count: 24_000, duration_sec: 1 },
  findings: [{ severity: "warning", code: "diagnostic" }],
};
const reusableWaveformRow = {
  audio_sha256: checkpointUnit.audio_sha256,
  audio_hash_verified: true,
  unit_qa: reusableWaveformQa,
};
const discoveredWaveformPolicy = reusableUnitOutputQaForTests(
  reusableWaveformRow,
  { reuseHashValidQa: true },
);
assert.ok(discoveredWaveformPolicy, "exact hash-valid cohort waveform QA should be reusable");
assert.equal(reusableUnitOutputQaForTests({
  ...reusableWaveformRow,
  audio_sha256: "d".repeat(64),
}, { reuseHashValidQa: true }), null);

const sourceText = "The SSS hero said it was 41% certain.";
const spokenText = "The S S S hero said it was forty-one percent certain.";
const strictLineage = strictSpokenTextLineage("u1", sourceText, spokenText, [{
  stage: "compile_provider_safe_spoken_text",
  before_text: sourceText,
  before_sha256: sha256(sourceText),
  after_text: spokenText,
  after_sha256: sha256(spokenText),
  compiler_id: PROVIDER_SAFE_SPOKEN_COMPILER_ID,
}]);
const units = [{
  unit_id: "u1",
  order_index: 0,
  source_text: sourceText,
  caption_text: sourceText,
  spoken_text: spokenText,
  spoken_text_transformations: strictLineage.receipts,
  spoken_text_lineage: strictLineage.lineage,
}];
const ir = buildNarrationTextIr({ sourceScriptSha256: "a".repeat(64), units });
assert.equal(ir.unit_count, 1);
assert.ok(ir.units[0].transformation_count > 0);
assert.equal(validateNarrationTextIr(ir, units).status, "passed");

const silentItMutationUnits = [{
  unit_id: "u-it",
  order_index: 0,
  source_text: "The IT team fixed it.",
  caption_text: "The IT team fixed it.",
  spoken_text: "The I T team fixed it.",
}];
const silentItMutationIr = buildNarrationTextIr({ units: silentItMutationUnits });
const silentItMutationValidation = validateNarrationTextIr(
  silentItMutationIr,
  silentItMutationUnits,
);
assert.equal(silentItMutationValidation.status, "blocked");
assert.ok(silentItMutationValidation.findings.some(
  (finding) => finding.code === "narration_text_ir_unreceipted_text_change",
));

const unaccountedMutationUnits = [{
  ...units[0],
  spoken_text: "The S S S hero said it was forty-one percent wrong.",
}];
const unaccountedMutationIr = buildNarrationTextIr({ units: unaccountedMutationUnits });
const unaccountedMutationValidation = validateNarrationTextIr(
  unaccountedMutationIr,
  unaccountedMutationUnits,
);
assert.equal(unaccountedMutationValidation.status, "blocked");
assert.ok(unaccountedMutationValidation.findings.some(
  (finding) => finding.code === "narration_text_ir_final_chain_not_closed",
));

const legacyUnchangedUnits = [{
  unit_id: "legacy-u1",
  order_index: 0,
  source_text: "Legacy accepted narration remains readable.",
  caption_text: "Legacy accepted narration remains readable.",
  spoken_text: "Legacy accepted narration remains readable.",
}];
const legacyUnchangedIr = buildNarrationTextIr({ units: legacyUnchangedUnits });
for (const row of legacyUnchangedIr.units) {
  delete row.spoken_text_lineage_required;
  delete row.spoken_text_lineage_source;
  delete row.spoken_text_lineage_sha256;
  delete row.spoken_text_lineage;
}
legacyUnchangedIr.ir_sha256 = narrationTextIrSha256(legacyUnchangedIr);
assert.equal(
  validateNarrationTextIr(legacyUnchangedIr, legacyUnchangedUnits).status,
  "passed",
);

const qwenRequest = compileNarrationProviderRequest({
  ...units[0],
  performance_intent: { energy: "urgent", pace: "fast" },
}, {
  provider: "qwen_local",
  referenceAudioPath: "/tmp/ref.wav",
  referenceText: "Reference words.",
  seed: 17,
  nativeSpeed: 1.1,
});
assert.equal(qwenRequest.request.instruction, undefined);
assert.equal(qwenRequest.request.reference_audio_path, "/tmp/ref.wav");
assert.ok(qwenRequest.capability_losses.some((row) => row.control === "performance_intent"));
assert.ok(qwenRequest.capability_losses.some((row) => row.control === "native_speed"));

const instructionalRequest = compileNarrationProviderRequest(units[0], {
  provider: "fish_audio",
  modelId: "test-model",
  modelRevision: "test-revision",
  voiceId: "test-voice",
  voiceSha256: "d".repeat(64),
  voiceContinuityContract: "test-owned-voice-continuity-v1",
  referenceAudioPath: "/tmp/ref.wav",
  nativeSpeed: 1,
});
assert.match(instructionalRequest.request.instruction, /Narrate with/);
assert.equal(instructionalRequest.capability_losses.length, 0);

const elevenRequest = compileNarrationProviderRequest({
  ...units[0],
  performance_intent: { style_tags: ["restrained", "cinematic"] },
}, {
  provider: "elevenlabs",
  modelId: "eleven-model",
  modelRevision: "eleven-revision",
  voiceId: "eleven-voice",
  voiceSha256: "7".repeat(64),
  voiceContinuityContract: "owned-eleven-continuity-v1",
  referenceAudioPath: "/tmp/reference-not-supported.wav",
  seed: 22,
  nativeSpeed: 1.03,
});
assert.equal(elevenRequest.request.seed, 22);
assert.equal(elevenRequest.request.native_speed, 1.03);
assert.deepEqual(elevenRequest.request.style_tags, ["restrained", "cinematic"]);
assert.ok(elevenRequest.capability_losses.some(
  (row) => row.control === "reference_audio",
));

const genericRequest = compileNarrationProviderRequest(units[0], {
  provider: "generic_tts",
  modelId: "generic-model",
  modelRevision: "generic-revision",
  voiceId: "generic-voice",
  voiceSha256: "8".repeat(64),
  voiceContinuityContract: "owned-generic-continuity-v1",
  nativeSpeed: 1.02,
});
assert.equal(genericRequest.request.instruction, undefined);
assert.ok(genericRequest.capability_losses.some(
  (row) => row.control === "performance_intent",
));
assert.ok(genericRequest.capability_losses.some(
  (row) => row.control === "native_speed",
));

const providerUnits = [{
  ...units[0],
  provider_request: instructionalRequest,
}];
const providerOutput = buildNarrationProviderOutputManifest({
  provider: "fish_audio",
  modelId: "test-model",
  modelRevision: "test-revision",
  voiceId: "test-voice",
  voiceSha256: "d".repeat(64),
  voiceContinuityContract: "test-owned-voice-continuity-v1",
  generationPlanSha256: "b".repeat(64),
  qualityContractSha256: contract.contract_sha256,
  units: providerUnits,
  results: [{
    unit_id: "u1",
    audio_path: "/tmp/u1.wav",
    audio_sha256: "c".repeat(64),
    duration_sec: 1,
  }],
});
assert.equal(providerOutput.status, "passed");
assert.equal(validateNarrationProviderOutputManifest(providerOutput, providerUnits, {
  generationPlanSha256: "b".repeat(64),
  qualityContractSha256: contract.contract_sha256,
}).status, "passed");

const providerSmallAsrContract = buildNarrationProviderUnitAsrContract({
  model: contract.delivery_qa.unit_screening_model,
  device: "cpu",
  computeType: "int8_float32",
});
const providerOutputWithExactSmallAsr = buildNarrationProviderOutputManifest({
  provider: "fish_audio",
  modelId: "test-model",
  modelRevision: "test-revision",
  voiceId: "test-voice",
  voiceSha256: "d".repeat(64),
  voiceContinuityContract: "test-owned-voice-continuity-v1",
  generationPlanSha256: "b".repeat(64),
  qualityContractSha256: contract.contract_sha256,
  units: providerUnits,
  results: [{
    unit_id: "u1",
    audio_path: "/tmp/u1.wav",
    audio_sha256: "c".repeat(64),
    duration_sec: 1,
    unit_qa: {
      ...reusableWaveformQa,
      audio_sha256: "c".repeat(64),
      transcript: {
        engine: "faster_whisper",
        model: contract.delivery_qa.unit_screening_model,
        device: "cpu",
        compute_type: "int8_float32",
        language: "en",
        language_probability: 0.999,
        asr_contract: providerSmallAsrContract,
        asr_contract_sha256: providerSmallAsrContract.contract_sha256,
        recognized_text: spokenText,
        recognized_words: [{
          word: "The",
          start_sec: 0,
          end_sec: 0.1,
          probability: 0.99,
        }],
      },
    },
  }],
});
assert.equal(providerOutputWithExactSmallAsr.status, "passed");
const exactSmallAsrUnit = providerOutputWithExactSmallAsr.units[0];
assert.match(
  exactSmallAsrUnit.provider_unit_qa.primary_asr_reuse_binding.binding_sha256,
  /^[a-f0-9]{64}$/u,
);
const freshProviderSmallAsrReuse = validateNarrationProviderUnitAsrReuse({
  unitId: exactSmallAsrUnit.unit_id,
  audioSha256: exactSmallAsrUnit.audio_sha256,
  audioHashVerified: true,
  providerUnitQa: exactSmallAsrUnit.provider_unit_qa,
  providerUnitQaSha256: exactSmallAsrUnit.provider_unit_qa_sha256,
  narrationQualityContractSha256: contract.contract_sha256,
  expectedAsrContract: providerSmallAsrContract,
  providerUnitQaContentSha256: narrationProviderUnitQaSha256,
});
assert.equal(freshProviderSmallAsrReuse.status, "reused");
assert.equal(freshProviderSmallAsrReuse.recognition.text, spokenText);
assert.equal(
  freshProviderSmallAsrReuse.recognition.reuse_source,
  "provider_unit_qa_exact_bound_small_asr",
);
const staleProviderSmallAsrReuse = validateNarrationProviderUnitAsrReuse({
  unitId: exactSmallAsrUnit.unit_id,
  audioSha256: exactSmallAsrUnit.audio_sha256,
  audioHashVerified: true,
  providerUnitQa: exactSmallAsrUnit.provider_unit_qa,
  providerUnitQaSha256: exactSmallAsrUnit.provider_unit_qa_sha256,
  narrationQualityContractSha256: "e".repeat(64),
  expectedAsrContract: providerSmallAsrContract,
  providerUnitQaContentSha256: narrationProviderUnitQaSha256,
});
assert.equal(staleProviderSmallAsrReuse.status, "fresh_asr_required");
assert.equal(staleProviderSmallAsrReuse.recognition, null);
assert.ok(staleProviderSmallAsrReuse.findings.some(
  (finding) => finding.code === "provider_unit_asr_quality_contract_binding_invalid",
));
const repairedAudioProviderSmallAsrReuse = validateNarrationProviderUnitAsrReuse({
  unitId: exactSmallAsrUnit.unit_id,
  audioSha256: "f".repeat(64),
  audioHashVerified: true,
  providerUnitQa: exactSmallAsrUnit.provider_unit_qa,
  providerUnitQaSha256: exactSmallAsrUnit.provider_unit_qa_sha256,
  narrationQualityContractSha256: contract.contract_sha256,
  expectedAsrContract: providerSmallAsrContract,
  providerUnitQaContentSha256: narrationProviderUnitQaSha256,
});
assert.equal(repairedAudioProviderSmallAsrReuse.status, "fresh_asr_required");
assert.equal(repairedAudioProviderSmallAsrReuse.recognition, null);
assert.ok(repairedAudioProviderSmallAsrReuse.findings.some(
  (finding) => finding.code === "provider_unit_asr_audio_binding_invalid",
));
const mismatchedComputeProviderSmallAsrReuse =
  validateNarrationProviderUnitAsrReuse({
    unitId: exactSmallAsrUnit.unit_id,
    audioSha256: exactSmallAsrUnit.audio_sha256,
    audioHashVerified: true,
    providerUnitQa: exactSmallAsrUnit.provider_unit_qa,
    providerUnitQaSha256: exactSmallAsrUnit.provider_unit_qa_sha256,
    narrationQualityContractSha256: contract.contract_sha256,
    expectedAsrContract: buildNarrationProviderUnitAsrContract({
      model: contract.delivery_qa.unit_screening_model,
      device: "cpu",
      computeType: "auto",
    }),
    providerUnitQaContentSha256: narrationProviderUnitQaSha256,
  });
assert.equal(
  mismatchedComputeProviderSmallAsrReuse.status,
  "fresh_asr_required",
);
assert.equal(mismatchedComputeProviderSmallAsrReuse.recognition, null);
assert.ok(mismatchedComputeProviderSmallAsrReuse.findings.some(
  (finding) => finding.code === "provider_unit_asr_contract_mismatch",
));
const partialProviderSmallAsrQa = structuredClone(
  exactSmallAsrUnit.provider_unit_qa,
);
partialProviderSmallAsrQa.transcript.recognized_words = [];
const partialProviderSmallAsrReuse = validateNarrationProviderUnitAsrReuse({
  unitId: exactSmallAsrUnit.unit_id,
  audioSha256: exactSmallAsrUnit.audio_sha256,
  audioHashVerified: true,
  providerUnitQa: partialProviderSmallAsrQa,
  providerUnitQaSha256: narrationProviderUnitQaSha256(partialProviderSmallAsrQa),
  narrationQualityContractSha256: contract.contract_sha256,
  expectedAsrContract: providerSmallAsrContract,
  providerUnitQaContentSha256: narrationProviderUnitQaSha256,
});
assert.equal(partialProviderSmallAsrReuse.status, "fresh_asr_required");
assert.equal(partialProviderSmallAsrReuse.recognition, null);

const qwenLockedRequest = compileNarrationProviderRequest(units[0], {
  provider: "qwen_local",
  modelId: "qwen-model",
  modelRevision: "qwen-revision",
  voiceId: "joel-owned-voice",
  voiceSha256: "6".repeat(64),
  voiceContinuityContract: "owned-qwen-continuity-v1",
  referenceAudioPath: "/tmp/ref.wav",
  referenceText: "Reference words.",
  seed: 17,
});
const richQwenSynthesisIdentity = {
  ...qwenLockedRequest.synthesis_identity,
  schema: "goldflow_local_tts_synthesis_identity_v2",
  synthesis_contract_id: "qwen-batch4-v1",
  synthesis_mode: "fixed_batch4_length_matched_v1",
  batch_plan_sha256: "7".repeat(64),
  cohort_id: "cohort-001",
  cohort_sha256: "8".repeat(64),
};
const qwenProviderUnits = [{
  ...units[0],
  provider_request: qwenLockedRequest,
}];
const qwenProviderOutput = buildNarrationProviderOutputManifest({
  provider: "qwen_local",
  modelId: "qwen-model",
  modelRevision: "qwen-revision",
  voiceId: "joel-owned-voice",
  voiceSha256: "6".repeat(64),
  voiceContinuityContract: "owned-qwen-continuity-v1",
  generationPlanSha256: "9".repeat(64),
  qualityContractSha256: contract.contract_sha256,
  providerExecution: {
    synthesis_contract: { mode: "fixed_batch4_length_matched_v1" },
    batch_plan_sha256: "7".repeat(64),
    synthesis_runs: [{ attempt: 1 }],
    effective_concurrency: 1,
  },
  units: qwenProviderUnits,
  results: [{
    unit_id: "u1",
    model_id: "qwen-model",
    model_revision: "qwen-revision",
    voice_id: "joel-owned-voice",
    voice_sha256: "6".repeat(64),
    voice_continuity_contract: "owned-qwen-continuity-v1",
    audio_path: "/tmp/qwen-u1.wav",
    audio_sha256: "a".repeat(64),
    duration_sec: 1,
    attempt: 1,
    synthesis_mode: "fixed_batch4_length_matched_v1",
    batch_plan_sha256: "7".repeat(64),
    cohort_id: "cohort-001",
    cohort_sha256: "8".repeat(64),
    generated_token_count: 100,
    effective_token_limit: 500,
    token_limit_reached: false,
    synthesis_identity: richQwenSynthesisIdentity,
    synthesis_identity_sha256: narrationSynthesisIdentitySha256(
      richQwenSynthesisIdentity,
    ),
    unit_qa: {
      ...reusableWaveformQa,
      audio_sha256: "a".repeat(64),
      voice_continuity: {
        report_path: "/tmp/qwen-full-set-voice-continuity.json",
        report_sha256: "f".repeat(64),
      },
    },
  }],
});
assert.equal(qwenProviderOutput.status, "passed");
assert.equal(
  qwenProviderOutput.units[0].provider_unit_qa.audio_sha256,
  "a".repeat(64),
);
assert.match(qwenProviderOutput.units[0].provider_unit_qa_sha256, /^[a-f0-9]{64}$/u);
assert.equal(
  qwenProviderOutput.units[0].provider_unit_qa.voice_continuity.report_sha256,
  "f".repeat(64),
);
assert.notEqual(
  qwenProviderOutput.units[0].provider_request_synthesis_identity_sha256,
  qwenProviderOutput.units[0].synthesis_identity_sha256,
);
assert.equal(
  qwenProviderOutput.provider_execution.batch_plan_sha256,
  "7".repeat(64),
);

const driftedProviderOutput = structuredClone(providerOutput);
driftedProviderOutput.units[0].voice_sha256 = "e".repeat(64);
assert.equal(validateNarrationProviderOutputManifest(
  driftedProviderOutput,
  providerUnits,
  {
    generationPlanSha256: "b".repeat(64),
    qualityContractSha256: contract.contract_sha256,
  },
).status, "blocked");
assert.ok(validateNarrationProviderOutputManifest(
  driftedProviderOutput,
  providerUnits,
  {
    generationPlanSha256: "b".repeat(64),
    qualityContractSha256: contract.contract_sha256,
  },
).findings.some((finding) => (
  finding.code === "narration_provider_output_unit_identity_mismatch"
)));

const duplicateProviderOutput = structuredClone(providerOutput);
duplicateProviderOutput.units.push(structuredClone(providerOutput.units[0]));
assert.ok(validateNarrationProviderOutputManifest(
  duplicateProviderOutput,
  providerUnits,
  {
    generationPlanSha256: "b".repeat(64),
    qualityContractSha256: contract.contract_sha256,
  },
).findings.some((finding) => (
  finding.code === "narration_provider_output_unit_ids_missing_or_duplicated"
)));

const staleSynthesisOutput = structuredClone(providerOutput);
staleSynthesisOutput.units[0].synthesis_identity_sha256 = "0".repeat(64);
assert.ok(validateNarrationProviderOutputManifest(
  staleSynthesisOutput,
  providerUnits,
  {
    generationPlanSha256: "b".repeat(64),
    qualityContractSha256: contract.contract_sha256,
  },
).findings.some((finding) => (
  finding.code === "narration_provider_output_synthesis_identity_mismatch"
)));

const tokenLimitedOutput = structuredClone(providerOutput);
tokenLimitedOutput.units[0].token_limit_reached = true;
assert.ok(validateNarrationProviderOutputManifest(
  tokenLimitedOutput,
  providerUnits,
  {
    generationPlanSha256: "b".repeat(64),
    qualityContractSha256: contract.contract_sha256,
  },
).findings.some((finding) => (
  finding.code === "narration_provider_output_token_limit_reached"
)));

const noAlignment = planAlignmentSafeUnitEdit({
  unitId: "u1",
  sampleCount: 24000,
  sampleRate: 24000,
  contract,
});
assert.equal(noAlignment.trim_start_sample, 0);
assert.equal(noAlignment.trim_end_sample, 24000);
assert.equal(noAlignment.fade_in_samples, 0);
assert.equal(noAlignment.fade_out_samples, 0);

const aligned = planAlignmentSafeUnitEdit({
  unitId: "u1",
  sampleCount: 24000,
  sampleRate: 24000,
  alignment: {
    status: "passed",
    first_speech_sample: 4800,
    last_speech_sample_exclusive: 19200,
  },
  contract,
});
assert.equal(aligned.trim_start_sample, 2880);
assert.equal(aligned.trim_end_sample, 22560);
assert.equal(aligned.status, "passed");

assert.equal(classifyNarrationBoundary({ spoken_text: "Then he saw it…" }, {}), "reveal");
assert.equal(classifyNarrationBoundary({ spoken_text: "He refused." }, {}), "sentence");
const boundary = planNarrationBoundary({
  leftUnit: { spoken_text: "He refused." },
  rightUnit: { spoken_text: "The room went quiet." },
  leftPrepared: { retained_trailing_silence_sample_count: 1200 },
  rightPrepared: { retained_leading_silence_sample_count: 1200 },
  contract,
});
assert.equal(boundary.boundary_class, "sentence");
assert.equal(boundary.effective_pause_ms, 230);
const stitchAccounting = validateNarrationStitchAccounting({
  preparedInputs: [
    { unit_id: "u1", sample_count: 24000 },
    { unit_id: "u2", sample_count: 12000 },
  ],
  boundaries: [{
    boundary_id: "u1__u2",
    after_unit_id: "u1",
    before_unit_id: "u2",
    boundary_class: "sentence",
    retained_natural_silence_sample_count: 2400,
    inserted_silence_sample_count: 3120,
    effective_pause_sample_count: 5520,
    gap_sample_count: 3120,
  }],
  finalSampleCount: 39120,
  sampleRate: 24000,
});
assert.equal(stitchAccounting.status, "passed");
assert.equal(stitchAccounting.exact_sample_accounting, true);

const strictFailure = strictNarrationDeliveryDecision({
  leading_deletion_run: 1,
  trailing_deletion_run: 1,
  longest_deletion_run: 2,
  longest_insertion_run: 2,
  deletions: 2,
  insertions: 2,
  word_error_rate: 0.5,
}, { contract, orderQa: { blockers: [] }, joinQa: { blockers: [], warnings: [] } });
assert.equal(strictFailure.status, "blocked");
assert.ok(strictFailure.blockers.some((row) => row.code === "narration_opening_word_missing"));
assert.ok(strictFailure.blockers.some((row) => row.code === "narration_final_word_missing"));

const deduplicatedWer = strictNarrationDeliveryDecision({
  leading_deletion_run: 0,
  trailing_deletion_run: 0,
  longest_deletion_run: 0,
  longest_insertion_run: 0,
  deletions: 0,
  insertions: 0,
  substitutions: 3,
  word_error_rate: 0.3,
  findings: [{ severity: "blocker", code: "tts_transcript_wer_exceeded" }],
}, { contract, orderQa: { blockers: [] }, joinQa: { blockers: [], warnings: [] } });
assert.equal(deduplicatedWer.blockers.length, 1);

const confirmedOmission = adjudicateNarrationDeliveryConsensus({
  primaryTranscriptQa: {
    leading_deletion_run: 0,
    trailing_deletion_run: 0,
    longest_deletion_run: 1,
    longest_insertion_run: 0,
    deletions: 1,
    insertions: 0,
    substitutions: 0,
    word_error_rate: 0.04,
    operations: [{ type: "deletion", intended: "shield", recognized: null }],
    findings: [],
  },
  confirmationTranscriptQa: {
    leading_deletion_run: 0,
    trailing_deletion_run: 0,
    longest_deletion_run: 1,
    longest_insertion_run: 0,
    deletions: 1,
    insertions: 0,
    substitutions: 0,
    word_error_rate: 0.04,
    operations: [{ type: "deletion", intended: "shield", recognized: null }],
    findings: [],
  },
  contract,
});
assert.equal(confirmedOmission.status, "blocked");
assert.ok(confirmedOmission.blockers.some((row) => row.code === "narration_confirmed_word_omission"));

const fusedCompound = adjudicateNarrationDeliveryConsensus({
  primaryTranscriptQa: {
    leading_deletion_run: 0,
    trailing_deletion_run: 0,
    longest_deletion_run: 1,
    longest_insertion_run: 0,
    deletions: 1,
    insertions: 0,
    substitutions: 1,
    word_error_rate: 0.1,
    operations: [
      { type: "deletion", intended: "heart", recognized: null },
      { type: "substitution", intended: "core", recognized: "hardcore" },
    ],
    findings: [],
  },
  confirmationTranscriptQa: {
    leading_deletion_run: 0,
    trailing_deletion_run: 0,
    longest_deletion_run: 1,
    longest_insertion_run: 0,
    deletions: 1,
    insertions: 0,
    substitutions: 1,
    word_error_rate: 0.1,
    operations: [
      { type: "deletion", intended: "heart", recognized: null },
      { type: "substitution", intended: "core", recognized: "heartcore" },
    ],
    findings: [],
  },
  contract,
});
assert.equal(fusedCompound.status, "passed_with_warnings");
assert.ok(fusedCompound.warnings.some(
  (row) => row.code === "narration_possible_compound_fusion_not_omission",
));

const resegmentedInsertion = adjudicateNarrationDeliveryConsensus({
  primaryTranscriptQa: {
    leading_deletion_run: 0,
    trailing_deletion_run: 0,
    longest_deletion_run: 0,
    longest_insertion_run: 1,
    deletions: 0,
    insertions: 1,
    substitutions: 1,
    word_error_rate: 0.1,
    operations: [
      { type: "insertion", intended: null, recognized: "request" },
      { type: "substitution", intended: "requesting", recognized: "an" },
    ],
    findings: [],
  },
  confirmationTranscriptQa: {
    leading_deletion_run: 0,
    trailing_deletion_run: 0,
    longest_deletion_run: 0,
    longest_insertion_run: 1,
    deletions: 0,
    insertions: 1,
    substitutions: 1,
    word_error_rate: 0.1,
    operations: [
      { type: "insertion", intended: null, recognized: "request" },
      { type: "substitution", intended: "requesting", recognized: "an" },
    ],
    findings: [],
  },
  contract,
});
assert.equal(resegmentedInsertion.status, "passed_with_warnings");
assert.ok(resegmentedInsertion.warnings.some(
  (row) => row.code === "narration_possible_asr_token_resegmentation",
));

const lexicalUncertainty = adjudicateNarrationDeliveryConsensus({
  primaryTranscriptQa: {
    leading_deletion_run: 0,
    trailing_deletion_run: 0,
    longest_deletion_run: 0,
    longest_insertion_run: 0,
    deletions: 0,
    insertions: 0,
    substitutions: 1,
    word_error_rate: 0.25,
    operations: [{ type: "substitution", intended: "ruk", recognized: "rook" }],
    findings: [{ severity: "blocker", code: "tts_transcript_wer_exceeded" }],
  },
  confirmationTranscriptQa: {
    leading_deletion_run: 0,
    trailing_deletion_run: 0,
    longest_deletion_run: 0,
    longest_insertion_run: 0,
    deletions: 0,
    insertions: 0,
    substitutions: 1,
    word_error_rate: 0.25,
    operations: [{ type: "substitution", intended: "ruk", recognized: "rook" }],
    findings: [{ severity: "blocker", code: "tts_transcript_wer_exceeded" }],
  },
  contract,
});
assert.equal(lexicalUncertainty.status, "passed_with_warnings");
assert.equal(lexicalUncertainty.review_required, true);

const confirmedFinalTokenCorruption = adjudicateNarrationDeliveryConsensus({
  primaryTranscriptQa: {
    leading_deletion_run: 0,
    trailing_deletion_run: 0,
    longest_deletion_run: 0,
    longest_insertion_run: 0,
    deletions: 0,
    insertions: 0,
    substitutions: 1,
    word_error_rate: 0.04,
    first_token_ok: true,
    last_token_ok: false,
    operations: [{ type: "substitution", intended: "fall", recognized: "f" }],
    findings: [],
  },
  confirmationTranscriptQa: {
    leading_deletion_run: 0,
    trailing_deletion_run: 0,
    longest_deletion_run: 0,
    longest_insertion_run: 0,
    deletions: 0,
    insertions: 0,
    substitutions: 1,
    word_error_rate: 0.04,
    first_token_ok: true,
    last_token_ok: false,
    operations: [{ type: "substitution", intended: "fall", recognized: "fight" }],
    findings: [],
  },
  contract,
});
assert.equal(confirmedFinalTokenCorruption.status, "blocked");
assert.ok(confirmedFinalTokenCorruption.blockers.some(
  (row) => row.code === "narration_confirmed_final_token_mismatch",
));
const listenPacket = exactNarrationListenReviewPacket({
  rows: [{
    unit_id: "u-pronunciation",
    audio_path: "/tmp/pronunciation.wav",
    audio_sha256: "d".repeat(64),
    intended_text: "Ruk stood.",
    primary_recognized_text: "Rook stood.",
    confirmation_recognized_text: "Rook stood.",
    decision: lexicalUncertainty,
  }],
  generationPlanSha256: "e".repeat(64),
  qualityContractSha256: contract.contract_sha256,
});
assert.deepEqual(listenPacket.unit_ids, ["u-pronunciation"]);
const listenDecision = buildNarrationExactListenReviewDecision({
  packet: listenPacket,
  reviewer: "fixture-reviewer",
  attestation: NARRATION_EXACT_LISTEN_ATTESTATION,
  decisions: [{ unit_id: "u-pronunciation", decision: "accept" }],
});
assert.equal(
  validateNarrationExactListenReviewDecision(listenPacket, listenDecision).status,
  "approved",
);
const staleListenDecision = structuredClone(listenDecision);
staleListenDecision.decisions[0].audio_sha256 = "f".repeat(64);
delete staleListenDecision.decision_sha256;
assert.equal(
  validateNarrationExactListenReviewDecision(listenPacket, staleListenDecision).status,
  "blocked",
);
const repairListenDecision = buildNarrationExactListenReviewDecision({
  packet: listenPacket,
  reviewer: "fixture-reviewer",
  decisions: [{
    unit_id: "u-pronunciation",
    decision: "repair_required",
    defect_type: "stutter",
    note: "The final word repeated.",
  }],
});
const repairListenValidation = validateNarrationExactListenReviewDecision(
  listenPacket,
  repairListenDecision,
);
assert.equal(repairListenValidation.status, "repair_required");
assert.deepEqual(repairListenValidation.repair_unit_ids, ["u-pronunciation"]);

const subjectivePlan = {
  units: [
    { unit_id: "u1", order_index: 0, segment_id: "chapter_1", spoken_text_sha256: "1".repeat(64), risk_flags: ["episode_opening_unit"] },
    { unit_id: "u2", order_index: 1, segment_id: "chapter_1", spoken_text_sha256: "2".repeat(64), risk_flags: ["system_ui_atomic"] },
    { unit_id: "u3", order_index: 2, segment_id: "chapter_2", spoken_text_sha256: "3".repeat(64), risk_flags: [], performance_intent: { energy: "urgent", tension: "high" } },
    { unit_id: "u4", order_index: 3, segment_id: "chapter_2", spoken_text_sha256: "4".repeat(64), risk_flags: ["episode_final_unit"] },
  ],
  chapter_prosody_spine: {
    schema: "goldflow_narration_chapter_prosody_spine_v1",
    chapters: [
      { segment_id: "chapter_1", dramatic_function: "pressure", tension_peak: 3, reveal_weight: 2 },
      { segment_id: "chapter_2", dramatic_function: "climax", tension_peak: 5, reveal_weight: 5 },
    ],
  },
};
const subjectiveStitch = {
  prepared_inputs: subjectivePlan.units.map((unit) => ({
    unit_id: unit.unit_id,
    sample_count: 240000,
  })),
  boundaries: subjectivePlan.units.slice(0, -1).map((unit, index) => ({
    boundary_id: `b${index + 1}`,
    after_unit_id: unit.unit_id,
    before_unit_id: subjectivePlan.units[index + 1].unit_id,
    gap_sample_count: 2400,
  })),
};
const subjectiveManifest = buildNarrationSubjectiveReviewManifest({
  plan: subjectivePlan,
  stitch: subjectiveStitch,
  audioPath: "/tmp/canonical-narration.wav",
  audioSha256: "a".repeat(64),
  generationPlanSha256: "b".repeat(64),
  generationPlanFileSha256: "c".repeat(64),
  qualityContractSha256: contract.contract_sha256,
});
assert.equal(validateNarrationSubjectiveReviewManifest(subjectiveManifest).status, "passed");
assert.equal(subjectiveManifest.expected_chapter_boundary_count, 1);
assert.equal(subjectiveManifest.expected_system_or_pronunciation_risk_count, 1);
assert.ok(subjectiveManifest.samples.some((row) => row.coverage_class === "complete_opening"));
assert.ok(subjectiveManifest.samples.some((row) => row.coverage_class === "climax"));
const subjectiveDecision = buildNarrationSubjectiveReviewDecision({
  manifest: subjectiveManifest,
  reviewer: "fixture-reviewer",
  attestation: NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
  decisions: subjectiveManifest.samples.map((row) => ({
    sample_id: row.sample_id,
    decision: "accept",
  })),
});
assert.equal(
  validateNarrationSubjectiveReviewDecision(
    subjectiveManifest,
    subjectiveDecision,
  ).status,
  "approved",
);
const subjectiveDecisionWithoutAttestation = buildNarrationSubjectiveReviewDecision({
  manifest: subjectiveManifest,
  reviewer: "fixture-reviewer",
  decisions: subjectiveManifest.samples.map((row) => ({
    sample_id: row.sample_id,
    decision: "accept",
  })),
});
assert.equal(
  validateNarrationSubjectiveReviewDecision(
    subjectiveManifest,
    subjectiveDecisionWithoutAttestation,
  ).status,
  "blocked",
);

const strictPass = strictNarrationDeliveryDecision({
  leading_deletion_run: 0,
  trailing_deletion_run: 0,
  longest_deletion_run: 0,
  longest_insertion_run: 0,
  deletions: 0,
  insertions: 0,
  word_error_rate: 0,
}, { contract, orderQa: { blockers: [] }, joinQa: { blockers: [], warnings: [] } });
assert.equal(strictPass.status, "passed");

const masteringDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-narration-master-test-"));
try {
  const inputPath = path.join(masteringDir, "input.wav");
  const outputPath = path.join(masteringDir, "output.wav");
  const reportPath = path.join(masteringDir, "report.json");
  await execFileAsync("ffmpeg", [
    "-y", "-nostdin", "-hide_banner", "-v", "error",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=24000:duration=3",
    "-af", "volume=-16dB",
    "-ac", "1", "-acodec", "pcm_s16le", inputPath,
  ]);
  const mastering = await masterNarrationTwoPass({
    inputPath,
    outputPath,
    reportPath,
    maxDurationSec: 2,
  });
  assert.equal(mastering.status, "passed");
  const masteredSampleCount = await narrationAudioSampleCountForTests(outputPath);
  assert.equal(masteredSampleCount.sample_rate_hz, 24_000);
  assert.equal(masteredSampleCount.sample_count, 48_000);
  assert.equal(mastering.policy.passes, 2);
  assert.equal(mastering.policy.tempo_processing, false);
  assert.equal(mastering.policy.per_unit_normalization, false);
  assert.ok(Math.abs(mastering.output_probe.duration_sec - 2) <= 0.01);
  assert.ok(mastering.duration_delta_ms <= 10);
  assert.ok(mastering.measured_true_peak_dbtp <= -1.4);
  const passthrough = narrationMasteringPassthroughDecision({
    narrationPath: outputPath,
    narrationSha256: mastering.output_sha256,
    durationSec: mastering.output_probe.duration_sec,
    narrationVolumeDb: 0,
    narrationReport: { mastering },
    targetLufs: -16,
    truePeakDbtp: -1.5,
    loudnessRange: 11,
  });
  assert.equal(passthrough.status, "eligible");
  const changedTarget = narrationMasteringPassthroughDecision({
    narrationPath: outputPath,
    narrationSha256: mastering.output_sha256,
    durationSec: mastering.output_probe.duration_sec,
    narrationVolumeDb: 0,
    narrationReport: { mastering },
    targetLufs: -14,
    truePeakDbtp: -1.5,
    loudnessRange: 11,
  });
  assert.equal(changedTarget.status, "not_eligible");
  assert.ok(changedTarget.findings.some(
    (finding) => finding.code === "upstream_loudness_target_mismatch",
  ));
  const audioBedReport = {
    narration_only: true,
    audio_design_enabled: false,
    mix: {
      narration_only: true,
      audio_design_enabled: false,
      narration_volume_db: 0,
      duration_sec: mastering.output_probe.duration_sec,
      transition_sfx_enabled: false,
      transition_sfx_event_count: 0,
      mastering,
    },
  };
  assert.equal(narrationRenderMasterReuseDecision({
    audioPath: outputPath,
    audioSha256: mastering.output_sha256,
    audioBedReport,
    targetLufs: -16,
    truePeakDbtp: -1.5,
    loudnessRange: 11,
  }).status, "eligible");
  const changedAudioBedReport = structuredClone(audioBedReport);
  changedAudioBedReport.mix.transition_sfx_enabled = true;
  assert.ok(narrationRenderMasterReuseDecision({
    audioPath: outputPath,
    audioSha256: mastering.output_sha256,
    audioBedReport: changedAudioBedReport,
    targetLufs: -16,
    truePeakDbtp: -1.5,
    loudnessRange: 11,
  }).findings.some((finding) => finding.code === "transition_sfx_changes_present"));
} finally {
  await fs.rm(masteringDir, { recursive: true, force: true });
}

console.log("narration quality v2 tests passed");
