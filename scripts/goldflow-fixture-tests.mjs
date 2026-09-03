#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import {
  allowedRefIdsForScene,
  applyBeatLocationSceneIds,
  applyCanonicalCharacterIdentitySceneIds,
  applyDeterministicLocationSceneIds,
  dropOutOfScopePromptRefs,
  locationCoverageFindings,
  outOfScopeLocationRefMentions,
  referenceTargetsForScene,
} from "./lib/visual-scope-utils.mjs";
import { multiCharacterBleedFindings, sanitizeCharacterStaging } from "./lib/character-staging-utils.mjs";
import {
  backgroundPopulationCuePresent,
  backgroundPopulationFindings,
  sanitizeBackgroundPopulation,
} from "./lib/background-population-utils.mjs";
import { promptTextForImageProvider } from "./lib/image-prompt-utils.mjs";
import {
  normalizeImageProvider,
  routedProviderForPrompt,
  routedProviderForReference,
} from "./lib/image-provider-routing.mjs";
import {
  DEFAULT_GOOGLE_FLOW_HEALTH_PROOF_PATH,
  FEDERATED_WEB_IMAGE_PROVIDER,
  FEDERATED_WEB_IMAGE_ROUTING_POLICY_V2,
  FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY,
  HYBRID_WEB_FLOW_PROVIDER,
  PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY,
  PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY,
  federatedWebImageIdentityOptions,
  federatedWebImageIdentityStatus,
  federatedWebImageProviderLocks,
} from "./lib/image-provider-policy.mjs";
import { stripEmbeddedProviderExclusionPayloadSyntax } from "./lib/prompt-payload-sanitize.mjs";
import { namedCharacterDuplicationFindings } from "./lib/prompt-prose-findings.mjs";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  codexVersionSupportsModel,
  compareCodexVersions,
  isCodexCacheCompatible,
  parseCodexVersion,
} from "./lib/codex-cli-runner.mjs";
import {
  DEFAULT_PLANNING_ROOM_EFFORT_POLICY,
  DEFAULT_WEB_PLANNING_EFFORT_POLICY,
  plannerConcurrencyForIdentity,
  planningProviderForIdentity,
  webPlannerEffortForStage,
} from "./lib/planning-runtime-policy.mjs";
import { parseJsonObjectFromPlannerOutput } from "./lib/json-output-repair.mjs";
import {
  attachReferencePathsToPromptsForTests,
  assertApprovedMaterializedReferenceHashesForTests,
  assertApprovedSourceReferenceHashesForTests,
  assertNoVisualResolutionDeadletterForTests,
  candidateImageIdsForDerivedTargetForTests,
  cumulativeImagegenHistoryForTests,
  episodeImageStatusForTests,
  promptWithReferenceSlotsForTests,
  referencePromptForTests,
  referenceSlotInstructionForTests,
  referenceTargetNeedsGenerationForTests,
  runPoolWithCircuitBreakerForTests,
  scenePromptProductionContractFindingsForTests,
  shotManifestProviderContractForTests,
} from "./imagegen.mjs";
import {
  beginStageExecution,
  executionScopeForTests,
  finishStageExecution,
  materializeProductionManifest,
} from "./lib/execution-provenance.mjs";
import {
  acceptedImageHashesForRows,
  applyImageQaDecisionsToLedger,
  donorRecoveryFinding,
  imageQaNeedsRecovery,
  imageManualReviewPolicy,
  imageRiskReasons,
  mergeRiskReviewDecisions,
  scopedQaRecoveryCommand,
} from "./image-output-qa.mjs";
import { focalAnalysisFromPixelsForTests } from "./image-focal-analysis.mjs";
import {
  deliveryFirstFullStreamFindingsForTests,
  resolveLocalWhisperRuntimeContractForTests,
} from "./local-whisper-word-timing.mjs";
import {
  PRODUCTION_LOCAL_WHISPER_CONTRACT,
  localWhisperCommandFlags,
  localWhisperWordTimingQa,
  validateLockedLocalWhisperReport,
} from "./lib/local-whisper-policy.mjs";
import {
  audioQaFindingsForTests,
  collectQwenUnitsForTests,
  qwenRequestForUnitForTests,
  requiredMediumQaReasonsForTests,
  synthesisIdentityForTests,
  stitchBoundaryPaddingForTests,
  stitchEffectiveBoundaryContractForTests,
  transcriptQaForTests,
  ttsSafeTextForTests,
  untranscribedActiveIntervalsForTests,
  validateRegenerateUnitIdsForTests,
} from "./modelslab-qwen-episode-audio.mjs";
import { validateAmbienceSpecForTests } from "./audio-ambience-repair.mjs";
import { scaledSegmentsForTests } from "./narration-tempo-normalize.mjs";
import { finalizeRenderReport } from "./render-report-finalize.mjs";
import { sha256File } from "./lib/file-hash.mjs";
import { providerBatchManifestEligible } from "./codex-image-import-staged.mjs";
import {
  normalizeRunIntentForTests,
  parseProofScopeForTests,
  validateDirtyWorktreePolicy,
} from "./run-preflight.mjs";
import { validateFinalQaSourceHashesForTests } from "./final-qa.mjs";
import {
  referencePlanApprovalContractSha256,
  referencePlanApprovalMatches,
} from "./lib/reference-plan-contract.mjs";
import {
  codexCreditFallbackEnabled,
  creditExhaustedIdsFromReport,
  isModelslabCreditExhaustion,
} from "./lib/image-fallback-policy.mjs";
import { alignExpandedZeroMultiplierCaptionsForTests, assertLockedRenderProfileForTests, assertRenderImageIntegrityForTests, buildSubtitleEventsForTests, coalesceOverlappingSubtitleEventsForTests, mergeShortSubtitleEvents, motionClipFilterForTests, subpixelPerspectiveCoreForTests, xfadeGroupCacheKeyForTests, xfadeSegmentTimingForTests, xfadeTimelineGroupsForTests } from "./render.mjs";
import { promoteEditorialMotionPlans } from "./editorial-motion-promote-proof.mjs";
import { applyAutomaticFocalAnchorForTests } from "./visual-motion-plan.mjs";
import {
  continuousMotionKeyframes,
  editorialMotionDistributionFindings,
  motionIntentFindings,
  motionIntentForPrompt,
  motionTraceFindings,
  motionTraceForIntent,
  positionAnchorFromStaging,
  sanitizeAuthoredMotionIntent,
  sanitizeDepthCandidate,
  sanitizeLayeredParallaxTreatment,
  sanitizeMotionKeyframes,
} from "./lib/motion-plan-utils.mjs";
import {
  inspectedParallaxCandidateOverrides,
  noticeableParallaxTreatment,
  selectAuthoredParallaxCandidates,
} from "./lib/parallax-policy.mjs";
import {
  MODELSLAB_PARALLAX_BACKGROUND_STRATEGY,
  parallaxBackgroundFilter,
  parallaxBackgroundPrompt,
} from "./editorial-parallax-assets.mjs";
import {
  parallaxApprovalMatches,
  parallaxAssetContractSha256,
} from "./lib/parallax-contract.mjs";
import { resolveTransitionSfxFamily, transitionSfxFamilyGuide } from "./lib/transition-sfx-policy.mjs";
import {
  gptImage2OutputSizeForTests,
  modelslabRequestSettings,
  prepareGptImage2PromptForTests,
} from "./modelslab-image-helper.mjs";
import {
  activeStateConstraintFindingsForTests,
  adaptivePromptChunkLimitsForTests,
  adaptivePromptChunksForTests,
  editorialReuseCandidatesForTests,
  enforceEditorialReusePolicyForTests,
  extractCompletePromptPrefixForTests,
  isSharedPlannerCooldownErrorForTests,
  localBeatFidelityFindingsForTests,
  mapWithConcurrencyForTests,
  normalizePromptPacketForTests,
  relevantReferenceTargetsForTests,
  retimeExistingPromptsForTests,
  visualUnitRiskAssessmentForTests,
  visualPromptCodexCacheEnabledForTests,
  visualPromptConcurrencyForEffortForTests,
} from "./visual-plan.mjs";
import {
  dropUnknownReferenceSceneScopesForTests,
  identityMergeKeyForTests,
  reconcileReferenceIdentityTargetsForTests,
  recurringReferenceCoverageFindingsForTests,
  characterReferenceContentFindingsForTests,
  nonCharacterReferenceContentFindingsForTests,
  referenceCharacterStateFindingsForTests,
  referenceDirectorSelectionFindingsForTests,
  referenceEvidenceLedgerForTests,
  referenceLocationContractLedgerForTests,
  referenceLocationScopeForTests,
  referenceOpeningIdentityFindingsForTests,
  selectedReferenceInventoryForTests,
  sourceOnlyReferenceFindingsForTests,
  shouldSplitReferenceChunkForTests,
  unselectedDistinctNonhumanActorFindingsForTests,
  visualReferenceCodexCacheEnabledForTests,
} from "./visual-reference-plan.mjs";
import { normalizeReferenceLimit } from "./lib/visual-prompt-policy.mjs";
import {
  fluxKleinActionComplexityFindingsForTests,
  fluxKleinStructuralContractFindingsForTests,
} from "./visual-prompt-harden.mjs";
import {
  qwenGenerationPlanForTests,
  qwenTextIntegrityCoverageForTests,
  systemUiSpeechCoverageForTests,
  voiceDirectionMetadataForTests,
  voiceDirectionTransformForTests,
} from "./voice-direction-gate.mjs";
import {
  buildNarrationTextIr,
  validateNarrationTextIr,
} from "./lib/narration-text-ir.mjs";
import { scanScriptMetaContamination } from "./lib/script-meta-contamination-scan.mjs";
import { longLocationSpanFindings, repeatedLocationShotJobFindings } from "./lib/visual-plan-quality-utils.mjs";
import { alignExcerptRowsToWhisper } from "./lib/transcript-excerpt-alignment.mjs";
import {
  PIPELINE_STAGE_REGISTRY,
  buildStageCommand,
  commandStageFor,
  readyStageIds,
  stageOutputPathMatches,
  stageChecklistFor,
} from "./lib/pipeline-stage-registry.mjs";
import {
  DEFAULT_PRODUCTION_PROFILE,
  normalizeProductionProfile,
  productionProfileById,
  productionProfileForIdentity,
} from "./lib/production-profiles.mjs";
import {
  KOKORO_MODEL_LOCK,
  KOKORO_VOICE_LOCKS,
  QWEN_JOEL_PRIMARY_LOCK,
  QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK,
  QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  QWEN_LIAM_PRIMARY_LOCK,
  QWEN_LIAM_RETRY_CONTRACT,
  QWEN_LIAM_STITCH_CONTRACT,
  QWEN_LIAM_UNIT_CONTRACT,
  QWEN_LOCAL_FALLBACK_LOCK,
  defaultNarrationVoiceProviderOptions,
  hasExplicitLegacyQwenIdentity,
  isLegacyQwenIdentity,
  narrationArtifactVoiceIdentityFindings,
  narrationPlanRunIdentityBindingFinding,
  narrationPlanVoiceIdentityFindings,
  narrationStitchContractForQuality,
  narrationTtsPolicyForIdentity,
  narrationUnitContractForQuality,
  validateNarrationTtsPolicy,
} from "./lib/narration-tts-policy.mjs";
import {
  QWEN_PUCK_MINIMUM_COSINE_SIMILARITY,
  QWEN_PUCK_WARNING_BELOW_COSINE_SIMILARITY,
  candidateDisposition,
  fullStreamDecision,
  softenPrimaryQa,
  validateSelectedUnitOrder,
  voiceContinuityDecision,
} from "./lib/tts-selection-policy.mjs";
import {
  equivalentPhrasesForTests,
  joinQaFromPcmForTests,
  normalizeNarrationUnitsForTests,
  selectedQaDecisionForTests,
  validateNarrationTtsPolicyForTests,
} from "./narration-tts-episode.mjs";
import {
  hybridDeadletteredAssetIdsForTests,
  qwenLiamBoundaryContractFindingsForTests,
  runIdentityPlanningCompleteForTests,
  runIdentityTtsCompleteForTests,
  runIdentityWhisperCompleteForTests,
  selectedNarratorVoiceIdForTests,
  transitionRecoveryCommandForTests,
  ttsStatusIdentityFieldsForTests,
} from "./run-status.mjs";
import { plannerChunkIdentityFindings } from "./lib/planner-chunk-ledger.mjs";
import {
  plannerInvocationScope,
  plannerRerunDecision,
  plannerRerunDecisionForEpisode,
} from "./lib/planner-rerun-policy.mjs";
import {
  combineWavefrontPlansForTests,
  dedupeIncrementalAcceptedImagesForTests,
  exactPromptRecoveryAllowedForTests,
  plannerTokensWithWavefrontOverridesForTests,
  stableMotionPrefetchCandidatesForTests,
  shouldFlushWavefrontBatchForTests,
  wavefrontCompletionPartitionForTests,
} from "./run-visual-wavefront.mjs";
import { buildStagedSceneImportInvocation } from "./codex-image-import-staged.mjs";
import {
  findSourceCompatibleHybridCompletions,
  findSourceCompatibleHybridDeadletters,
} from "./hybrid-browser-image-pool.mjs";
import {
  bindReferenceInputsForTests,
  codexWorkSourceRowSha256,
  completeWorkItem,
  createCodexWorkManifest,
  getCodexWorkStatus,
  heartbeatWorkItem,
  leaseNextWorkItem,
  reuseExactWorkCompletions,
  validateCodexWorkManifest,
} from "./lib/codex-image-work-contract.mjs";
import {
  buildEditorialDirectorPrompt,
  buildTranscriptAtoms,
  editorialBeatCoverageFindings,
  editorialRetentionRailFindings,
  normalizeEditorialGrouping,
  projectActiveStateConstraints,
  retimeLockedEditorialBeats,
  retentionRailForTime,
} from "./lib/editorial-beat-director.mjs";
import {
  compatibleHardenFeedbackBlockers,
  hasHardenFeedbackFindings,
  hardenFeedbackBlockersNeedManualAgentReview,
  mergeScopedPromptReplacements,
  resolvedDeadletterPayload,
  visualResolveScopeForBlockers,
} from "./lib/visual-resolution-utils.mjs";
import {
  applyManualLocationRefRepairsForTests,
  applyManualSemanticRepairsForTests,
  canonicalVisibleEntityCoverageFindingsForTests,
  semanticBuildPromptForTests,
  semanticReconciliationPromptForTests,
  sanitizeCanonicalIdForTests,
  semanticProofScopeForTests,
  semanticSceneAnchorFindingsForTests,
  semanticSceneCoverageFindingsForTests,
  semanticSceneQualityFindingsForTests,
  semanticReasoningEffortForStage,
  semanticReusableStageNamesForTests,
  semanticScriptChunksForTests,
  semanticSnapSceneAnchorsForTests,
  semanticCodexCacheEnabledForTests,
  storyFactEvidenceFindingsForTests,
} from "./semantic-scene-plan.mjs";
import {
  proofBaselineArtifactContractForTests,
  scopedBaselineWordsForTests,
} from "./proof-baseline-import.mjs";
import {
  advanceCommandTokensForTests,
  agentApprovalCommandForTests,
  autoAdvanceDecisionForTests,
  parseHumanCheckpointStagesForTests,
} from "./run-advance.mjs";
import { buildRetentionAttributionForTests, normalizeRetentionRowsForTests } from "./youtube-analytics-feedback.mjs";
import {
  closeVisualBeatTimelineForTests,
  factLedgerMatchesScriptForTests,
  mergeEditorialRecoveryBeatsForTests,
  retentionBeatDensityFindingsForTests,
  scriptPrefixForTimedWordsForTests,
  visualBeatInternalsForTests,
} from "./visual-beat-plan.mjs";

const execFileAsync = promisify(execFile);
const VISUAL_BEAT_CONTRACT_VERSION = "visual_beat_ref_strategy_v2";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function testAuthoritativeStageRegistry() {
  const ids = PIPELINE_STAGE_REGISTRY.map((stage) => stage.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice(-14), [
    "image_focal_analysis",
    "image_output_qa",
    "animation_direction_plan",
    "generated_video_motion",
    "generated_video_motion_approval",
    "parallax_asset_generation",
    "parallax_asset_approval",
    "motion_edit_plan",
    "premium_render",
    "final_qa",
    "upload_packaging",
    "youtube_publish_readiness",
    "youtube_studio_upload",
    "youtube_pinned_comment",
  ]);
  assert.equal(ids.includes("visual_prompt_plan_review_harden"), false);
  assert.equal(ids.includes("reference_plan_approval"), true);
  const narratorOnly = stageChecklistFor({ audio_target: "narrator_only" });
  assert.equal(narratorOnly.find((row) => row.stage === "sfx_score_plan")?.status, "skipped_with_waiver");
  assert.equal(stageChecklistFor({ audio_target: "narrator_only", parallax_policy: "disabled" }).find((row) => row.stage === "parallax_asset_generation")?.status, "skipped_with_waiver");
  assert.equal(commandStageFor("visual", "parallax-assets"), "parallax_asset_generation");
  assert.equal(commandStageFor("imagegen", "analyze"), "image_focal_analysis");
  assert.equal(commandStageFor("imagegen", "codex-work"), "image_generation");
  assert.equal(commandStageFor("imagegen", "codex-work", { "references-only": "true" }), "reference_generation");
  assert.equal(commandStageFor("imagegen", "codex-work", { "qa-recovery": "true" }), "image_output_qa");
  assert.equal(commandStageFor("visual", "approve-parallax"), "parallax_asset_approval");
  assert.equal(commandStageFor("visual", "generated-motion"), "generated_video_motion");
  assert.equal(commandStageFor("visual", "ltx-video"), "generated_video_motion");
  assert.equal(commandStageFor("visual", "animation-plan"), "animation_direction_plan");
  assert.equal(commandStageFor("visual", "approve-generated-motion"), "generated_video_motion_approval");
  assert.equal(commandStageFor("visual", "approve-ltx-video"), "generated_video_motion_approval");
  assert.equal(stageChecklistFor({ ltx_video_policy: "disabled" }).find((row) => row.stage === "generated_video_motion")?.status, "skipped_with_waiver");
  assert.equal(stageChecklistFor({ animation_policy: "disabled" }).find((row) => row.stage === "animation_direction_plan")?.status, "skipped_with_waiver");
  assert.equal(commandStageFor("tts", "narrate"), "qwen_tts_stitch");
  assert.equal(commandStageFor("tts", "qwen"), "qwen_tts_stitch");
  assert.equal(commandStageFor("youtube", "approve-packaging"), "upload_packaging");
  assert.equal(commandStageFor("youtube", "prepare"), "youtube_publish_readiness");
  assert.equal(commandStageFor("youtube", "record-upload"), "youtube_studio_upload");
  assert.equal(commandStageFor("youtube", "record-comment"), "youtube_pinned_comment");
  assert.equal(narratorOnly.every((row) => row.validator), true);
}

function testParallelStageDependenciesAndOwnedOutputs() {
  const semantic = PIPELINE_STAGE_REGISTRY.find((stage) => stage.id === "semantic_scene_plan");
  const voice = PIPELINE_STAGE_REGISTRY.find((stage) => stage.id === "voice_plan");
  const tts = PIPELINE_STAGE_REGISTRY.find((stage) => stage.id === "qwen_tts_stitch");
  const timingBind = PIPELINE_STAGE_REGISTRY.find((stage) => stage.id === "timing_bind");
  assert.deepEqual(semantic.dependencies, ["targeted_speakability"]);
  assert.deepEqual(voice.dependencies, ["targeted_speakability"]);
  assert.deepEqual(tts.dependencies, ["voice_plan"]);
  assert.deepEqual(timingBind.dependencies, ["semantic_scene_plan", "audio_pace_check"]);
  const rows = PIPELINE_STAGE_REGISTRY.map((stage) => ({
    stage: stage.id,
    state: ["run_identity", "source_ingest", "script_approval", "script_pace_check", "targeted_speakability"].includes(stage.id)
      ? "passed"
      : "missing",
  }));
  assert.deepEqual(
    readyStageIds(rows).filter((stage) => ["semantic_scene_plan", "voice_plan", "qwen_tts_stitch"].includes(stage)),
    ["semantic_scene_plan", "voice_plan"],
  );
  rows.find((row) => row.stage === "voice_plan").state = "passed";
  assert.equal(readyStageIds(rows).includes("qwen_tts_stitch"), true);
  rows.find((row) => row.stage === "qwen_tts_stitch").state = "passed";
  assert.equal(readyStageIds(rows).includes("local_whisper_word_timing"), true);
  assert.equal(stageOutputPathMatches("semantic_scene_plan", "semantic_scene_plan.json"), true);
  assert.equal(stageOutputPathMatches("semantic_scene_plan", "modelslab_qwen_tts_report_ep_01.json"), false);
  assert.equal(stageOutputPathMatches("qwen_tts_stitch", "modelslab_qwen_tts_report_ep_01.json"), true);
  assert.equal(stageOutputPathMatches("qwen_tts_stitch", "narration_tts_pre_synthesis_gate_ep_01.json"), true);
  assert.equal(stageOutputPathMatches("qwen_tts_stitch", "narration_tts_report_ep_01.json"), true);
  assert.equal(stageOutputPathMatches("qwen_tts_stitch", "semantic_scene_plan.json"), false);
  assert.equal(stageOutputPathMatches("local_whisper_word_timing", "narration_word_timing_ep_01.json"), true);
  assert.equal(stageOutputPathMatches("local_whisper_word_timing", "story_fact_ledger.json"), false);
}

function testNarrationTtsProviderLocksAndLegacyRouting() {
  const voiceProviderOptions = defaultNarrationVoiceProviderOptions();
  const identity = {
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    tts_provider: "qwen_local",
    tts_fallback_provider: null,
    narrator_voice_id: "joel_owned_narrator_clone",
    tts_native_speed: null,
    voice_provider_options: voiceProviderOptions,
  };
  const policy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity));
  assert.equal(policy.contract, "qwen_joel_primary_v1");
  assert.equal(policy.primary.model_id, QWEN_JOEL_PRIMARY_LOCK.model_id);
  assert.equal(policy.primary.model_revision, QWEN_JOEL_PRIMARY_LOCK.model_revision);
  assert.equal(policy.primary.voice_id, "joel_owned_narrator_clone");
  assert.equal(policy.primary.native_speed, null);
  assert.equal(policy.primary.reference_audio_sha256, QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK.reference_audio_sha256);
  assert.equal(policy.primary.reference_manifest_sha256, QWEN_JOEL_PRIMARY_LOCK.reference_manifest_sha256);
  assert.equal(policy.primary.voice_continuity_contract, "qwen_icl_clone_of_joel_owned_dry_deadpan_reference");
  assert.equal(policy.primary.repetition_penalty, 1.2);
  assert.equal(policy.fallback, null);
  assert.deepEqual(policy.unit_contract, QWEN_LIAM_UNIT_CONTRACT);
  assert.deepEqual(policy.stitch_contract, QWEN_LIAM_STITCH_CONTRACT);
  assert.deepEqual(policy.retry_contract, QWEN_LIAM_RETRY_CONTRACT);
  assert.deepEqual(voiceProviderOptions.allowed_production_voice_ids, ["joel_owned_narrator_clone"]);
  assert.equal(voiceProviderOptions.narrator_identity_policy, "single_voice_qwen_joel_owned_icl");
  assert.equal("alternate_voice_ids" in voiceProviderOptions, false);
  const runtimePolicy = validateNarrationTtsPolicyForTests(identity);
  assert.equal(runtimePolicy.status, "passed");
  assert.deepEqual(
    runtimePolicy.synthesis_contract,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  );
  const boundIdentity = {
    ...identity,
    schema: "goldflow_run_identity_v2",
  };
  const boundPlan = {
    schema: "goldflow_tts_generation_plan_v2",
    source_hashes: {
      run_identity_sha256: "current-identity-hash",
    },
  };
  assert.equal(
    narrationPlanRunIdentityBindingFinding(
      boundPlan,
      boundIdentity,
      "current-identity-hash",
    ),
    null,
  );
  assert.equal(
    narrationPlanRunIdentityBindingFinding(
      boundPlan,
      boundIdentity,
      "new-identity-hash",
    )?.code,
    "narration_plan_run_identity_hash_stale",
  );
  assert.equal(
    narrationPlanRunIdentityBindingFinding(
      {
        ...boundPlan,
        source_hashes: {},
      },
      boundIdentity,
      "new-identity-hash",
    )?.code,
    "narration_plan_run_identity_hash_missing",
  );
  assert.equal(
    narrationPlanRunIdentityBindingFinding(
      {
        ...boundPlan,
        schema: "goldflow_tts_generation_plan_proof_import_v2",
        source_hashes: {},
      },
      boundIdentity,
      "new-identity-hash",
    ),
    null,
  );
  assert.match(buildStageCommand("qwen_tts_stitch", identity), /tts narrate/);
  assert.match(buildStageCommand("qwen_tts_stitch", identity), /--concurrency 1/);

  const legacyOptions = defaultNarrationVoiceProviderOptions({
    provider: "kokoro_local",
    fallbackProvider: "qwen_local",
    voiceId: "am_puck",
    nativeSpeed: 1.2,
  });
  const legacyPolicy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity({
    ...identity,
    tts_provider: "kokoro_local",
    tts_fallback_provider: "qwen_local",
    narrator_voice_id: "am_puck",
    tts_native_speed: 1.2,
    voice_provider_options: legacyOptions,
  }));
  assert.equal(legacyPolicy.contract, "legacy_kokoro_puck");
  assert.equal(legacyPolicy.primary.model_id, KOKORO_MODEL_LOCK.model_id);
  assert.equal(legacyPolicy.primary.voice_id, "am_puck");
  assert.equal(legacyPolicy.fallback.model_id, QWEN_LOCAL_FALLBACK_LOCK.model_id);
  assert.match(buildStageCommand("qwen_tts_stitch", {
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    qwen_native_speed: 1.25,
  }), /tts qwen/);
  assert.throws(
    () => validateNarrationTtsPolicy(narrationTtsPolicyForIdentity({
      ...identity,
      narrator_voice_id: "am_fenrir",
    })),
    /approved locked narrator voice/,
  );
  assert.throws(
    () => defaultNarrationVoiceProviderOptions({ voiceId: "am_fenrir" }),
    /require joel_owned_narrator_clone/,
  );
  assert.throws(
    () => defaultNarrationVoiceProviderOptions({ fallbackProvider: "modelslab_qwen" }),
    /fallback must be null/,
  );
  assert.throws(
    () => defaultNarrationVoiceProviderOptions({ nativeSpeed: 1.2 }),
    /no native-speed control/,
  );

  const exactBoundary = {
    after_unit_id: "unit_left",
    before_unit_id: "unit_right",
    status: "passed",
    blocker: null,
    target_gap_sample_count: 1920,
    retained_left_trailing_silence_sample_count: 960,
    retained_right_leading_silence_sample_count: 960,
    inserted_silence_sample_count: 0,
    gap_sample_count: 0,
    effective_gap_sample_count: 1920,
  };
  const exactStitch = {
    stitch_sample_rate: 24000,
    segments: [
      {
        unit_id: "unit_left",
        prepared_trailing_silence_sample_count: 960,
      },
      {
        unit_id: "unit_right",
        prepared_leading_silence_sample_count: 960,
      },
    ],
    boundaries: [exactBoundary],
    boundary_qa: {
      status: "passed",
      boundary_count: 1,
      blockers: [],
    },
  };
  const exactFullQa = {
    join_qa: {
      status: "passed",
      exact_effective_gap_sample_count_required: true,
      required_effective_gap_sample_count: 1920,
      joins: [{ ...exactBoundary }],
    },
  };
  assert.deepEqual(
    qwenLiamBoundaryContractFindingsForTests(exactStitch, exactFullQa),
    [],
  );
  const staleHundredMsBoundary = {
    ...exactBoundary,
    retained_left_trailing_silence_sample_count: 1200,
    retained_right_leading_silence_sample_count: 1200,
    effective_gap_sample_count: 2400,
  };
  const hundredMsFindings = qwenLiamBoundaryContractFindingsForTests({
    ...exactStitch,
    segments: [
      {
        unit_id: "unit_left",
        prepared_trailing_silence_sample_count: 1200,
      },
      {
        unit_id: "unit_right",
        prepared_leading_silence_sample_count: 1200,
      },
    ],
    boundaries: [staleHundredMsBoundary],
  }, {
    join_qa: {
      ...exactFullQa.join_qa,
      joins: [{ ...staleHundredMsBoundary }],
    },
  });
  assert.equal(
    hundredMsFindings.some(
      (finding) => finding.code === "tts_join_effective_gap_sample_count_mismatch"
        && finding.expected === 1920
        && finding.actual === 2400,
    ),
    true,
  );
}

function testPuckOnlyNarrationIdentityFailClosedGates() {
  assert.equal(normalizeRunIntentForTests(" Production "), "production");
  assert.equal(normalizeRunIntentForTests("PROOF"), "proof");
  assert.throws(
    () => normalizeRunIntentForTests("prod"),
    /Unknown run intent/,
  );

  const explicitLegacyV2 = {
    schema: "goldflow_run_identity_v2",
    qwen_narrator_voice_id: "joel_owned_narrator_clone",
    qwen_narrator_voice_policy: "default_joel_owned_narrator_clone",
    qwen_native_speed: 1.25,
    voice_provider_options: {
      qwen_narrator_voice_id: "joel_owned_narrator_clone",
      qwen_narrator_voice_policy: "default_joel_owned_narrator_clone",
      qwen_native_speed: 1.25,
    },
    provider_locks: {
      qwen_narrator_voice_id: "joel_owned_narrator_clone",
    },
    model_versions: {
      tts_model: "qwen-tts",
    },
  };
  assert.equal(hasExplicitLegacyQwenIdentity(explicitLegacyV2), true);
  assert.equal(isLegacyQwenIdentity(explicitLegacyV2), true);
  assert.equal(
    selectedNarratorVoiceIdForTests({
      ...explicitLegacyV2,
      run_identity_schema: explicitLegacyV2.schema,
    }, {
      "qwen-narrator-voice-id": "am_fenrir",
      "narrator-voice-id": "am_michael",
    }),
    "joel_owned_narrator_clone",
  );
  const malformedV2 = {
    schema: "goldflow_run_identity_v2",
    provider_locks: { tts_provider: "kokoro_local" },
    model_versions: { tts_model: KOKORO_MODEL_LOCK.model_id },
  };
  assert.equal(hasExplicitLegacyQwenIdentity(malformedV2), false);
  assert.equal(isLegacyQwenIdentity(malformedV2), false);
  assert.equal(runIdentityTtsCompleteForTests(malformedV2).done, false);
  assert.match(
    runIdentityTtsCompleteForTests(malformedV2).evidence,
    /missing the generic narration identity/,
  );

  const voiceProviderOptions = defaultNarrationVoiceProviderOptions({
    provider: "kokoro_local",
    fallbackProvider: "qwen_local",
    voiceId: "am_puck",
    nativeSpeed: 1.2,
  });
  const puckIdentity = {
    schema: "goldflow_run_identity_v2",
    tts_provider: "kokoro_local",
    tts_fallback_provider: "qwen_local",
    narrator_voice_id: "am_puck",
    tts_voice_id: "am_puck",
    tts_native_speed: 1.2,
    voice_provider_options: voiceProviderOptions,
  };
  const statusIdentity = ttsStatusIdentityFieldsForTests(puckIdentity, {
    "tts-provider": "modelslab_qwen",
    "narrator-voice-id": "am_fenrir",
    "tts-voice-id": "am_michael",
    "qwen-narrator-voice-id": "joel_owned_narrator_clone",
  });
  assert.equal(statusIdentity.tts_provider, "kokoro_local");
  assert.equal(statusIdentity.narrator_voice_id, "am_puck");
  assert.equal(statusIdentity.tts_voice_id, "am_puck");

  const policy = validateNarrationTtsPolicy(
    narrationTtsPolicyForIdentity(puckIdentity),
  );
  const fallbackControls = {
    target_voice_id: "am_puck",
    target_voice_sha256: policy.primary.voice_sha256,
    reference_audio_path: policy.fallback.reference_audio_path,
    reference_audio_sha256: policy.fallback.reference_audio_sha256,
    reference_transcript_path: policy.fallback.reference_text_path,
    reference_transcript_sha256: policy.fallback.reference_text_sha256,
    reference_transcript_file_sha256: policy.fallback.reference_text_file_sha256,
    reference_metadata_path: policy.fallback.reference_metadata_path,
    reference_metadata_sha256: policy.fallback.reference_metadata_sha256,
    voice_continuity_contract: policy.fallback.voice_continuity_contract,
    speaker_similarity_method: policy.fallback.speaker_similarity_method,
    speaker_similarity_model_path: policy.fallback.speaker_similarity_model_path,
    speaker_similarity_model_sha256: policy.fallback.speaker_similarity_model_sha256,
    hard_minimum_cosine_similarity: policy.fallback.minimum_cosine_similarity,
    warning_floor_cosine_similarity: policy.fallback.warning_floor_cosine_similarity,
    fallback_scope: "exact_failed_unit_only",
    exact_unit_only: true,
    whole_episode_fallback_allowed: false,
  };
  const validPlan = {
    narrator_voice_id: "am_puck",
    narrator_voice_sha256: policy.primary.voice_sha256,
    provider_controls: {
      kokoro: { voice_id: "am_puck" },
      qwen3: fallbackControls,
    },
    segments: [{
      narration_units: [{
        unit_id: "unit_001",
        reference_id: "am_puck",
        provider_controls: {
          kokoro: { voice_id: "am_puck" },
          qwen3: fallbackControls,
        },
      }],
    }],
  };
  assert.deepEqual(narrationPlanVoiceIdentityFindings(validPlan, policy), []);
  assert.equal(narrationPlanVoiceIdentityFindings({
    ...validPlan,
    provider_controls: {
      ...validPlan.provider_controls,
      kokoro: { voice_id: "am_fenrir" },
    },
  }, policy).some((finding) => finding.actual === "am_fenrir"), true);
  assert.equal(narrationPlanVoiceIdentityFindings({
    ...validPlan,
    segments: [{
      narration_units: [{
        ...validPlan.segments[0].narration_units[0],
        reference_id: "am_michael",
      }],
    }],
  }, policy).some((finding) => finding.actual === "am_michael"), true);
  assert.equal(narrationPlanVoiceIdentityFindings({
    ...validPlan,
    provider_controls: {
      ...validPlan.provider_controls,
      qwen3: { ...fallbackControls, target_voice_id: "joel_owned_narrator_clone" },
    },
  }, policy).some((finding) => finding.actual === "joel_owned_narrator_clone"), true);

  const fallbackUsage = {
    provider: "qwen_local",
    target_voice_id: "am_puck",
    target_voice_sha256: policy.primary.voice_sha256,
    voice_continuity_contract: policy.fallback.voice_continuity_contract,
    reference_audio_sha256: policy.fallback.reference_audio_sha256,
    speaker_similarity_model_sha256: policy.fallback.speaker_similarity_model_sha256,
    speaker_similarity_calibration_sha256:
      policy.fallback.speaker_similarity_calibration_sha256,
    minimum_cosine_similarity: policy.fallback.minimum_cosine_similarity,
    warning_below_cosine_similarity: policy.fallback.warning_below_cosine_similarity,
    exact_unit_only: true,
    unit_ids: [],
  };
  const validArtifacts = {
    ttsReport: {
      narrator_voice_id: "am_puck",
      primary: {
        voice_id: "am_puck",
        voice_sha256: policy.primary.voice_sha256,
      },
      fallback_usage: fallbackUsage,
      results: [{
        unit_id: "unit_001",
        provider: "kokoro_local",
        voice_id: "am_puck",
        voice_continuity_contract: "native_puck_preset",
      }],
    },
    unitQa: {
      selected_units: [{
        unit_id: "unit_001",
        provider: "kokoro_local",
        voice_id: "am_puck",
        voice_continuity_contract: "native_puck_preset",
      }],
    },
    stitchReport: {
      segments: [{
        unit_id: "unit_001",
        tts_provider: "kokoro_local",
        voice_id: "am_puck",
        voice_continuity_contract: "native_puck_preset",
      }],
    },
    policy,
  };
  assert.deepEqual(narrationArtifactVoiceIdentityFindings(validArtifacts), []);
  assert.equal(narrationArtifactVoiceIdentityFindings({
    ...validArtifacts,
    ttsReport: {
      ...validArtifacts.ttsReport,
      primary: {
        ...validArtifacts.ttsReport.primary,
        voice_id: "am_fenrir",
      },
    },
  }).some((finding) => finding.actual === "am_fenrir"), true);
  assert.equal(narrationArtifactVoiceIdentityFindings({
    ...validArtifacts,
    unitQa: {
      selected_units: [{
        ...validArtifacts.unitQa.selected_units[0],
        voice_id: "am_michael",
      }],
    },
  }).some((finding) => finding.actual === "am_michael"), true);
  assert.equal(narrationArtifactVoiceIdentityFindings({
    ...validArtifacts,
    ttsReport: {
      ...validArtifacts.ttsReport,
      fallback_usage: {
        ...fallbackUsage,
        target_voice_id: "joel_owned_narrator_clone",
      },
    },
  }).some((finding) => finding.actual === "joel_owned_narrator_clone"), true);
}

function testNarrationTtsSelectionAndQaContracts() {
  const isolatedDeletion = transcriptQaForTests(
    "He crossed the broken bridge at dawn.",
    "He crossed broken bridge at dawn.",
  );
  const isolatedSubstitution = transcriptQaForTests(
    "He crossed the broken bridge at dawn.",
    "He crossed the burning bridge at dawn.",
  );
  assert.equal(
    isolatedDeletion.findings.some((finding) => (
      finding.severity === "blocker"
      && finding.code === "tts_transcript_isolated_word_deletion"
    )),
    true,
  );
  assert.equal(
    candidateDisposition({ status: "blocked", findings: isolatedDeletion.findings }, "qwen_local").status,
    "accepted_primary",
  );
  assert.equal(
    isolatedSubstitution.findings.some((finding) => (
      finding.severity === "blocker"
      && finding.code === "tts_transcript_isolated_substitution"
    )),
    true,
  );
  assert.equal(
    candidateDisposition({ status: "blocked", findings: isolatedSubstitution.findings }, "qwen_local").status,
    "accepted_primary",
  );
  const softenedIsolatedDifference = softenPrimaryQa({
    status: "blocked",
    findings: isolatedSubstitution.findings,
  });
  assert.equal(softenedIsolatedDifference.status, "passed_with_warnings");
  assert.equal(
    softenedIsolatedDifference.findings.every((finding) => finding.severity !== "blocker"),
    true,
  );
  const confirmedMissingPassage = {
    status: "blocked",
    transcript: {
      longest_deletion_run: 5,
      deletions: 5,
      intended_canonical_token_count: 20,
    },
    findings: [{
      severity: "blocker",
      code: "tts_transcript_contiguous_words_missing",
      longest_deletion_run: 5,
    }],
  };
  assert.equal(
    candidateDisposition(confirmedMissingPassage, "qwen_local").status,
    "accepted_primary",
  );
  const shortContextualFullStreamGap = deliveryFirstFullStreamFindingsForTests({
    word_error_rate: 0.011,
    longest_deletion_run: 5,
    findings: confirmedMissingPassage.findings,
  });
  assert.equal(shortContextualFullStreamGap[0].severity, "warning");
  const longFullStreamGap = deliveryFirstFullStreamFindingsForTests({
    word_error_rate: 0.011,
    longest_deletion_run: 8,
    findings: [{
      ...confirmedMissingPassage.findings[0],
      longest_deletion_run: 8,
    }],
  });
  assert.equal(longFullStreamGap[0].severity, "blocker");
  const mediumIsolatedDifference = transcriptQaForTests(
    "This is not a story about whether I survive the fall.",
    "This is not a story about whether I survived the fall.",
    {
      maxWer: 0.3,
      blockAnySubstitution: false,
      blockIsolatedEdits: false,
    },
  );
  assert.equal(
    mediumIsolatedDifference.findings.some((finding) => finding.severity === "blocker"),
    false,
  );

  const possibleImpulseWarning = {
    status: "passed_with_warnings",
    findings: [{
      severity: "warning",
      code: "tts_audio_possible_impulsive_discontinuity",
      maximum_sample_step_dbfs: -10.5,
    }],
  };
  assert.deepEqual(candidateDisposition(possibleImpulseWarning, "qwen_local"), {
    status: "accepted_primary",
    accepted: true,
    blocker_codes: [],
  });
  const severeImpulse = {
    status: "blocked",
    findings: [{
      severity: "blocker",
      code: "tts_audio_impulsive_discontinuity",
      maximum_sample_step_dbfs: -2.4,
    }],
  };
  const softenedSevereImpulse = softenPrimaryQa(severeImpulse);
  assert.equal(softenedSevereImpulse.status, "passed_with_warnings");
  assert.equal(softenedSevereImpulse.findings[0].severity, "warning");
  assert.deepEqual(candidateDisposition(softenedSevereImpulse, "qwen_local"), {
    status: "accepted_primary",
    accepted: true,
    blocker_codes: [],
  });
  const joinInputs = [
    {
      unit_id: "unit_001",
      sample_count: 960,
      prepared_qa: { metrics: { trailing_silence_sample_count: 960 } },
    },
    {
      unit_id: "unit_002",
      sample_count: 960,
      prepared_qa: { metrics: { leading_silence_sample_count: 960 } },
    },
  ];
  const joinBoundaries = [{
    after_unit_id: "unit_001",
    before_unit_id: "unit_002",
    target_gap_sample_count: 1920,
    retained_left_trailing_silence_sample_count: 960,
    retained_right_leading_silence_sample_count: 960,
    inserted_silence_sample_count: 0,
    effective_gap_sample_count: 1920,
    gap_sample_count: 0,
  }];
  const warningJoinSamples = new Int16Array(1920);
  warningJoinSamples[960] = 10000;
  const warningJoinQa = joinQaFromPcmForTests(
    warningJoinSamples,
    24000,
    joinInputs,
    joinBoundaries,
  );
  assert.equal(warningJoinQa.status, "passed_with_warnings");
  assert.equal(
    warningJoinQa.warnings.some(
      (finding) => finding.code === "tts_join_possible_impulsive_discontinuity",
    ),
    true,
  );
  const blockingJoinSamples = new Int16Array(1920);
  blockingJoinSamples[960] = 15000;
  const blockingJoinQa = joinQaFromPcmForTests(
    blockingJoinSamples,
    24000,
    joinInputs,
    joinBoundaries,
  );
  assert.equal(blockingJoinQa.status, "passed_with_warnings");
  assert.equal(
    blockingJoinQa.warnings.some(
      (finding) => finding.code === "tts_join_impulsive_discontinuity",
    ),
    true,
  );
  const hundredMsJoinQa = joinQaFromPcmForTests(
    new Int16Array(2400),
    24000,
    [
      {
        unit_id: "unit_100ms_left",
        sample_count: 1200,
        prepared_qa: { metrics: { trailing_silence_sample_count: 1200 } },
      },
      {
        unit_id: "unit_100ms_right",
        sample_count: 1200,
        prepared_qa: { metrics: { leading_silence_sample_count: 1200 } },
      },
    ],
    [{
      after_unit_id: "unit_100ms_left",
      before_unit_id: "unit_100ms_right",
      target_gap_sample_count: 1920,
      retained_left_trailing_silence_sample_count: 1200,
      retained_right_leading_silence_sample_count: 1200,
      inserted_silence_sample_count: 0,
      effective_gap_sample_count: 2400,
      gap_sample_count: 0,
    }],
  );
  assert.equal(hundredMsJoinQa.status, "blocked");
  assert.equal(
    hundredMsJoinQa.blockers.some(
      (finding) => finding.code === "tts_join_effective_gap_sample_count_mismatch"
        && finding.expected_sample_count === 1920
        && finding.actual_sample_count === 2400,
    ),
    true,
  );
  const fullStreamWithJoinWarning = fullStreamDecision({
    leading_deletion_run: 0,
    trailing_deletion_run: 0,
    longest_deletion_run: 0,
    longest_insertion_run: 0,
    deletions: 0,
    insertions: 0,
    word_error_rate: 0,
    findings: [],
  }, {
    orderQa: { blockers: [] },
    joinQa: warningJoinQa,
  });
  assert.equal(fullStreamWithJoinWarning.status, "passed");
  assert.equal(
    fullStreamWithJoinWarning.warnings.some(
      (finding) => finding.code === "tts_join_possible_impulsive_discontinuity",
    ),
    true,
  );
  const deferredTranscriptDecision = fullStreamDecision(null, {
    orderQa: { blockers: [] },
    joinQa: { blockers: [], warnings: [] },
    transcriptDeferred: true,
  });
  assert.equal(deferredTranscriptDecision.status, "passed");
  assert.equal(
    deferredTranscriptDecision.warnings.some(
      (finding) => finding.code === "tts_full_stream_transcript_deferred_to_official_whisper_timing",
    ),
    true,
  );

  const approvedSpokenRewrite = "Whether I live through the fall, I will return.";
  const sourceMeaning = "Whether I survive the fall, I will return.";
  const semanticOverrideAudit = [{
    from: "survive the fall",
    to: "live through the fall",
    asr_equivalence_allowed: false,
  }];
  assert.deepEqual(equivalentPhrasesForTests({
    tts_override_replacements_applied: semanticOverrideAudit,
  }), []);
  assert.deepEqual(equivalentPhrasesForTests({
    tts_override_replacements_applied: [{
      ...semanticOverrideAudit[0],
      asr_equivalence_allowed: true,
    }],
  }), [{
    ...semanticOverrideAudit[0],
    asr_equivalence_allowed: true,
  }]);
  const unapprovedEquivalence = transcriptQaForTests(approvedSpokenRewrite, sourceMeaning);
  assert.equal(
    unapprovedEquivalence.findings.some((finding) => finding.severity === "blocker"),
    true,
    "A semantic TTS rewrite must not become ASR-equivalent by mere presence in the override audit.",
  );
  const explicitlyAllowedEquivalence = transcriptQaForTests(
    approvedSpokenRewrite,
    sourceMeaning,
    {
      equivalentPhrases: [{
        from: "survive the fall",
        to: "live through the fall",
        asr_equivalence_allowed: true,
      }],
    },
  );
  assert.equal(explicitlyAllowedEquivalence.word_error_rate, 0);
  assert.deepEqual(explicitlyAllowedEquivalence.findings, []);

  const plannedUnits = [{ unit_id: "unit_001" }, { unit_id: "unit_002" }];
  const selectedRows = [
    {
      unit_id: "unit_001",
      provider: "qwen_local",
      unit_qa: { status: "passed", findings: [] },
    },
    {
      unit_id: "unit_002",
      provider: "qwen_local",
      unit_qa: { status: "passed", findings: [] },
    },
  ];
  const rejectedCandidateHistory = [{
    unit_id: "unit_002",
    provider: "qwen_local",
    unit_qa: {
      status: "blocked",
      findings: [{ severity: "blocker", code: "tts_transcript_confirmed_deletion" }],
    },
  }];
  assert.equal(rejectedCandidateHistory[0].unit_qa.status, "blocked");
  assert.equal(candidateDisposition(selectedRows[1].unit_qa, "qwen_local").status, "accepted_primary");
  assert.equal(validateSelectedUnitOrder(plannedUnits, selectedRows).status, "passed");
  assert.equal(selectedQaDecisionForTests(selectedRows, {
    orderQa: validateSelectedUnitOrder(plannedUnits, selectedRows),
  }).status, "passed");
  const puckVoiceSha256 = KOKORO_VOICE_LOCKS.am_puck.voice_sha256;
  const similarityModelSha256 = QWEN_LOCAL_FALLBACK_LOCK.speaker_similarity_model_sha256;
  const passingContinuity = voiceContinuityDecision({
    status: "passed",
    audio_sha256: "fallback-audio-hash",
    reference_voice_id: "am_puck",
    reference_voice_sha256: puckVoiceSha256,
    similarity_model_sha256: similarityModelSha256,
    cosine_similarity: 0.925,
    minimum_cosine_similarity: QWEN_PUCK_MINIMUM_COSINE_SIMILARITY,
    warning_below_cosine_similarity:
      QWEN_PUCK_WARNING_BELOW_COSINE_SIMILARITY,
  }, {
    audioSha256: "fallback-audio-hash",
    referenceVoiceId: "am_puck",
    referenceVoiceSha256: puckVoiceSha256,
    similarityModelSha256,
  });
  assert.equal(passingContinuity.status, "passed");
  const fenrirLikeContinuity = voiceContinuityDecision({
    status: "passed",
    audio_sha256: "fallback-audio-hash",
    reference_voice_id: "am_puck",
    reference_voice_sha256: puckVoiceSha256,
    similarity_model_sha256: similarityModelSha256,
    cosine_similarity: 0.863,
    minimum_cosine_similarity: QWEN_PUCK_MINIMUM_COSINE_SIMILARITY,
    warning_below_cosine_similarity:
      QWEN_PUCK_WARNING_BELOW_COSINE_SIMILARITY,
  }, {
    audioSha256: "fallback-audio-hash",
    referenceVoiceId: "am_puck",
    referenceVoiceSha256: puckVoiceSha256,
    similarityModelSha256,
  });
  assert.equal(fenrirLikeContinuity.status, "blocked");
  assert.equal(
    fenrirLikeContinuity.findings.some(
      (finding) => finding.code === "tts_primary_voice_similarity_below_minimum",
    ),
    true,
  );
  const lowMarginPuckContinuity = voiceContinuityDecision({
    status: "passed",
    audio_sha256: "fallback-audio-hash",
    reference_voice_id: "am_puck",
    reference_voice_sha256: puckVoiceSha256,
    similarity_model_sha256: similarityModelSha256,
    cosine_similarity: 0.889,
    minimum_cosine_similarity: QWEN_PUCK_MINIMUM_COSINE_SIMILARITY,
    warning_below_cosine_similarity:
      QWEN_PUCK_WARNING_BELOW_COSINE_SIMILARITY,
  }, {
    audioSha256: "fallback-audio-hash",
    referenceVoiceId: "am_puck",
    referenceVoiceSha256: puckVoiceSha256,
    similarityModelSha256,
  });
  assert.equal(lowMarginPuckContinuity.status, "passed");
  assert.equal(
    lowMarginPuckContinuity.findings.some(
      (finding) => finding.code === "tts_primary_voice_similarity_low_margin"
        && finding.severity === "warning"
        && finding.review_required === true,
    ),
    true,
  );
  assert.equal(voiceContinuityDecision(null, {
    audioSha256: "fallback-audio-hash",
    referenceVoiceId: "am_puck",
    referenceVoiceSha256: puckVoiceSha256,
    similarityModelSha256,
  }).status, "blocked");

  const fullStreamWithConfirmedIsolatedSkip = fullStreamDecision({
    leading_deletion_run: 0,
    trailing_deletion_run: 0,
    longest_deletion_run: 1,
    longest_insertion_run: 0,
    deletions: 1,
    insertions: 0,
    word_error_rate: 0.02,
    findings: [{
      severity: "blocker",
      code: "tts_transcript_isolated_word_deletion",
      adjudication_policy: "medium_whisper_confirmed",
    }],
  }, {
    orderQa: { blockers: [] },
    joinQa: { blockers: [] },
  });
  assert.equal(fullStreamWithConfirmedIsolatedSkip.status, "passed");
  assert.equal(
    fullStreamWithConfirmedIsolatedSkip.warnings.some(
      (finding) => finding.code === "tts_transcript_isolated_word_deletion",
    ),
    true,
  );
}

function testScopedOnlyPlannerRerunPolicy() {
  assert.equal(plannerRerunDecisionForEpisode({
    stage: "visual_prompt_plan",
  }).reason, "episode_identity_required_for_planner_rerun_guard");
  const priorEvents = [{
    event_type: "stage_completed",
    stage: "visual_prompt_plan",
    status: "failed",
  }];
  assert.equal(plannerInvocationScope({ "cut-ids": "cut_001" }).scoped, true);
  assert.equal(plannerRerunDecision({
    stage: "visual_beat_plan",
    flags: { "retime-locked-grouping": "true" },
    priorEvents: [{
      event_type: "stage_completed",
      stage: "visual_beat_plan",
      status: "passed",
    }],
  }).reason, "deterministic_non_authoring_revalidation");
  assert.equal(plannerRerunDecision({
    stage: "visual_reference_plan",
    flags: { "revalidate-existing": "true" },
    priorEvents: [{
      event_type: "stage_completed",
      stage: "visual_reference_plan",
      status: "passed",
    }],
  }).reason, "deterministic_non_authoring_revalidation");
  assert.equal(plannerRerunDecision({
    stage: "visual_prompt_plan",
    flags: { "revalidate-existing": "true", "retime-existing": "true" },
    priorEvents: [{
      event_type: "stage_completed",
      stage: "visual_prompt_plan",
      status: "passed",
    }],
  }).reason, "deterministic_non_authoring_revalidation");
  assert.equal(plannerRerunDecision({
    stage: "visual_prompt_plan",
    flags: {},
    priorEvents,
  }).allowed, false);
  assert.equal(plannerRerunDecision({
    stage: "visual_prompt_plan",
    flags: {
      "workflow-bypass": "true",
      "allow-full-stage-rerun": "true",
      "rerun-reason": "Operator approved replacing an interrupted serialized planner run.",
    },
    priorEvents,
  }).reason, "explicit_operator_approved_full_planner_rerun");
  assert.equal(plannerRerunDecision({
    stage: "visual_prompt_plan",
    flags: {
      "allow-full-stage-rerun": "true",
      "rerun-reason": "Missing workflow bypass.",
    },
    priorEvents,
  }).reason, "full_planner_rerun_override_requires_bypass_and_reason");
  assert.equal(plannerRerunDecision({
    stage: "visual_prompt_plan",
    flags: { "cut-ids": "cut_001" },
    priorEvents,
  }).reason, "scoped_planner_recovery");
  assert.equal(plannerRerunDecision({
    stage: "visual_prompt_plan",
    flags: { "resume-incomplete-chunks": "true" },
    priorEvents,
  }).reason, "visual_prompt_resume_requires_exact_failed_scope");
  const priorTransitionEvents = [{
    event_type: "stage_completed",
    stage: "transition_edit_plan",
    status: "failed",
  }];
  assert.equal(plannerRerunDecision({
    stage: "transition_edit_plan",
    flags: {},
    priorEvents: priorTransitionEvents,
  }).reason, "unscoped_planner_rerun_forbidden");
  assert.equal(plannerRerunDecision({
    stage: "transition_edit_plan",
    flags: { "boundary-ids": "boundary_002" },
    priorEvents: priorTransitionEvents,
  }).reason, "scoped_planner_recovery");
  assert.equal(plannerRerunDecision({
    stage: "transition_edit_plan",
    flags: { "resume-incomplete-chunks": "true" },
    priorEvents: priorTransitionEvents,
  }).reason, "transition_resume_requires_exact_failed_scope");
  assert.match(transitionRecoveryCommandForTests({
    status: "blocked",
    failed_boundary_ids: ["boundary_003", "boundary_002", "boundary_003"],
  }, {
    channel: "test",
    series_slug: "series",
    week: "week",
    episode: "ep_01",
    audio_target: "narrator_only",
  }), /--boundary-ids boundary_003,boundary_002$/);
  assert.equal(plannerRerunDecision({
    stage: "visual_prompt_plan",
    flags: { "resume-incomplete-chunks": "true" },
    priorEvents: [{
      event_type: "stage_completed",
      stage: "visual_prompt_plan",
      status: "passed",
    }],
  }).reason, "completed_planner_requires_exact_scope");
  assert.equal(plannerRerunDecision({
    stage: "visual_prompt_plan",
    flags: { "resume-incomplete-chunks": "true" },
    priorEvents: [{
      event_type: "stage_completed",
      stage: "visual_prompt_plan",
      status: "passed",
    }],
    unresolvedExpectedIds: ["cut_002"],
  }).reason, "visual_prompt_resume_requires_exact_failed_scope");
  assert.equal(plannerRerunDecision({
    stage: "visual_prompt_plan",
    flags: {
      "resume-incomplete-chunks": "true",
      "codex-reuse-cache": "false",
    },
    priorEvents,
  }).allowed, false);
  assert.equal(plannerRerunDecision({
    stage: "visual_prompt_plan",
    flags: { "resume-incomplete-chunks": "true" },
    priorEvents: [{
      event_type: "stage_started",
      stage: "visual_prompt_plan",
    }],
  }).reason, "visual_prompt_resume_requires_exact_failed_scope");
}

function testVisualWavefrontBatchPolicy() {
  assert.equal(exactPromptRecoveryAllowedForTests({
    current_stage: "visual_prompt_plan",
    current_stage_state: "blocked",
  }, {
    "workflow-bypass": "true",
    "beat-ids": "beat_1,beat_2",
  }), true);
  assert.equal(exactPromptRecoveryAllowedForTests({
    current_stage: "visual_prompt_plan",
    current_stage_state: "blocked",
  }, {
    "workflow-bypass": "true",
  }), false);
  assert.equal(exactPromptRecoveryAllowedForTests({
    current_stage: "visual_prompt_plan",
    current_stage_state: "blocked",
  }, {
    "beat-ids": "beat_1,beat_2",
  }), false);
  assert.deepEqual(
    plannerTokensWithWavefrontOverridesForTests(
      ["node", "bin/goldflow.mjs", "visual", "plan", "--cut-ids", "old", "--visual-chunk-concurrency", "10"],
      { "beat-ids": "beat_1,beat_2", "visual-chunk-concurrency": "1", "reasoning-effort": "medium", "workflow-bypass": "true", "allow-full-stage-rerun": "true", "rerun-reason": "Operator approved recovery." },
    ),
    ["node", "bin/goldflow.mjs", "visual", "plan", "--beat-ids", "beat_1,beat_2", "--reasoning-effort", "medium", "--visual-chunk-concurrency", "1", "--workflow-bypass", "true", "--allow-full-stage-rerun", "true", "--rerun-reason", "Operator approved recovery."],
  );
  assert.equal(shouldFlushWavefrontBatchForTests({
    pendingCutCount: 14,
    minCuts: 15,
    oldestPendingMs: 1000,
    nowMs: 5999,
    maxWaitMs: 5000,
  }), false);
  assert.equal(shouldFlushWavefrontBatchForTests({
    pendingCutCount: 15,
    minCuts: 15,
    oldestPendingMs: 1000,
    nowMs: 2000,
  }), true);
  assert.equal(shouldFlushWavefrontBatchForTests({
    pendingCutCount: 4,
    minCuts: 15,
    oldestPendingMs: 1000,
    nowMs: 6000,
    maxWaitMs: 5000,
  }), true);
  const combined = combineWavefrontPlansForTests([
    { source_script_hash: "hash", prompts: [{ image_id: "cut_001" }], wavefront: { chunk_id: "chunk_001" } },
    { source_script_hash: "hash", prompts: [{ image_id: "cut_002" }], wavefront: { chunk_id: "chunk_002" } },
  ], {
    identity: {
      channel: "test",
      series_slug: "series",
      week: "week",
      episode: "ep_01",
      image_provider: "modelslab",
    },
  });
  assert.deepEqual(combined.prompts.map((prompt) => prompt.image_id), ["cut_001", "cut_002"]);
  const hybridCombined = combineWavefrontPlansForTests([
    { source_script_hash: "hash", prompts: [{ image_id: "hybrid_cut_001" }], wavefront: { chunk_id: "hybrid_chunk_001" } },
  ], {
    identity: {
      channel: "test",
      series_slug: "series",
      week: "week",
      episode: "ep_01",
      image_provider: HYBRID_WEB_FLOW_PROVIDER,
    },
  });
  assert.equal(hybridCombined.image_provider, HYBRID_WEB_FLOW_PROVIDER, "wavefront batches must retain the hybrid provider lock for provider-bound hardening and dispatch");
  assert.equal(normalizeImageProvider(hybridCombined.image_provider), HYBRID_WEB_FLOW_PROVIDER);
  const importInvocation = {
    channel: "test",
    series: "series",
    week: "week",
    episode: "ep_01",
    promptPath: "/tmp/wavefront/prompts.json",
    imageId: "hybrid_cut_001",
    sourcePath: "/tmp/wavefront/hybrid_cut_001.png",
    reportPath: "/tmp/wavefront/imagegen.json",
    cutExecutionLedgerPath: "/tmp/wavefront/cut_execution_ledger.json",
  };
  const normalImportArgs = buildStagedSceneImportInvocation({
    ...importInvocation,
    wavefrontPrefetch: false,
  });
  assert.equal(normalImportArgs[0], path.resolve("bin/goldflow.mjs"));
  assert.deepEqual(normalImportArgs.slice(1, 3), ["imagegen", "import-codex"]);
  const prefetchImportArgs = buildStagedSceneImportInvocation({
    ...importInvocation,
    wavefrontPrefetch: true,
  });
  assert.equal(prefetchImportArgs[0], path.resolve("scripts/codex-image-manual-import.mjs"));
  assert.equal(prefetchImportArgs.includes("imagegen"), false);
  assert.equal(prefetchImportArgs.includes("import-codex"), false, "wavefront prefetch must not enter the stage-recording Goldflow wrapper");
  const providerBatchImportArgs = buildStagedSceneImportInvocation({
    ...importInvocation,
    wavefrontPrefetch: false,
    providerBatchImport: true,
  });
  assert.equal(providerBatchImportArgs[0], path.resolve("scripts/codex-image-manual-import.mjs"));
  assert.equal(providerBatchImportArgs.includes("imagegen"), false);
  assert.equal(providerBatchImportArgs.includes("import-codex"), false, "an outer provider batch must own the only image-generation stage event");
  assert.deepEqual(wavefrontCompletionPartitionForTests(
    [{ image_id: "hybrid_cut_001" }, { image_id: "hybrid_cut_002" }, { image_id: "hybrid_cut_003" }],
    {
      status: "partial",
      results: [
        { image_id: "hybrid_cut_001", image_path: "/tmp/one.png" },
        { image_id: "hybrid_cut_003", image_path: "/tmp/three.png" },
      ],
    },
  ), {
    completed_cut_ids: ["hybrid_cut_001", "hybrid_cut_003"],
    deferred_cut_ids: ["hybrid_cut_002"],
  }, "partial hybrid batches must preserve completed cuts for incremental QA and defer only failed IDs");
  assert.throws(() => combineWavefrontPlansForTests([
    { prompts: [{ image_id: "cut_001" }] },
    { prompts: [{ image_id: "cut_001" }] },
  ]), /duplicated/);

  const deduped = dedupeIncrementalAcceptedImagesForTests([
    { incremental_accepted_images: [{ image_id: "cut_static", image_path: "/tmp/a.png", image_sha256: "hash-a", start_sec: 0 }] },
    { incremental_accepted_images: [
      { image_id: "cut_move", image_path: "/tmp/b.png", image_sha256: "hash-b", start_sec: 4 },
      { image_id: "cut_duplicate", image_path: "/tmp/c.png", image_sha256: "hash-a", start_sec: 8 },
    ] },
  ]);
  assert.deepEqual(deduped.accepted_images.map((row) => row.image_id), ["cut_static", "cut_move"]);
  assert.equal(deduped.duplicate_hashes[0].duplicate_of_image_id, "cut_static");

  const stable = stableMotionPrefetchCandidatesForTests({
    prompts: [
      {
        image_id: "cut_static",
        start_sec: 0,
        duration_sec: 4,
        shot_manifest: {
          motion_intent: {
            behavior: "static_hold",
            focal_subject: "Joey",
            start_anchor: { x: 0.5, y: 0.5 },
            end_anchor: { x: 0.5, y: 0.5 },
            start_scale: 1,
            end_scale: 1,
            easing: "linear",
            depth_candidate: { eligible: false, priority: 0, separation_confidence: "low", editorial_reason: "single plane" },
          },
        },
      },
      {
        image_id: "cut_move",
        start_sec: 4,
        duration_sec: 4,
        shot_manifest: {
          motion_intent: {
            behavior: "slow_push_in",
            focal_subject: "Joey",
            start_anchor: { x: 0.5, y: 0.5 },
            end_anchor: { x: 0.5, y: 0.5 },
            start_scale: 1.01,
            end_scale: 1.06,
            easing: "ease_in_out",
            depth_candidate: { eligible: false, priority: 0, separation_confidence: "low", editorial_reason: "single plane" },
          },
        },
      },
      {
        image_id: "cut_depth",
        start_sec: 8,
        duration_sec: 4,
        shot_manifest: {
          motion_intent: {
            behavior: "slow_push_in",
            focal_subject: "Joey",
            start_anchor: { x: 0.5, y: 0.5 },
            end_anchor: { x: 0.5, y: 0.5 },
            start_scale: 1.01,
            end_scale: 1.06,
            easing: "ease_in_out",
            depth_candidate: { eligible: true, priority: 2, separation_confidence: "high", editorial_reason: "clean foreground" },
          },
        },
      },
      {
        image_id: "cut_generated",
        start_sec: 12,
        duration_sec: 4,
        shot_manifest: {
          animation_intent: { eligibility: "animate" },
          motion_intent: {
            behavior: "slow_push_in",
            focal_subject: "Joey",
            start_anchor: { x: 0.5, y: 0.5 },
            end_anchor: { x: 0.5, y: 0.5 },
            start_scale: 1.01,
            end_scale: 1.06,
            easing: "ease_in_out",
            depth_candidate: { eligible: false, priority: 0, separation_confidence: "low", editorial_reason: "single plane" },
          },
        },
      },
    ],
    acceptedImages: [
      ...deduped.accepted_images,
      { image_id: "cut_depth", image_path: "/tmp/depth.png", image_sha256: "hash-depth", start_sec: 8 },
      { image_id: "cut_generated", image_path: "/tmp/generated.png", image_sha256: "hash-generated", start_sec: 12 },
    ],
    timelineEndSec: 16,
    motionPolicy: "selective_editorial_v1",
  });
  assert.deepEqual(stable.map((row) => row.image_id), ["cut_static", "cut_move"], "every QA-passed single-plane still cut should prebuild its exact directed motion cache");
}

function testRunIdentityV2Policies() {
  assert.throws(
    () => validateDirtyWorktreePolicy({ dirty: true, intent: "production", allowDirty: true, reason: "not allowed" }),
    /clean Git worktree/i,
  );
  assert.throws(
    () => validateDirtyWorktreePolicy({ dirty: true, intent: "proof", allowDirty: true, reason: "" }),
    /dirty-reason/i,
  );
  assert.equal(validateDirtyWorktreePolicy({ dirty: true, intent: "proof", allowDirty: true, reason: "bounded fixture" }).waiver, "bounded fixture");
  assert.deepEqual(parseProofScopeForTests({ "proof-scope": "0-300" }, "proof"), {
    mode: "bounded",
    start_sec: 0,
    end_sec: 300,
    label: "proof_0_300",
  });
  assert.throws(() => parseProofScopeForTests({}, "proof"), /requires --proof-scope/i);
  assert.equal(DEFAULT_PRODUCTION_PROFILE, "fast_premium_v2");
  assert.equal(normalizeProductionProfile("fast-premium"), "fast_premium_v2");
  assert.equal(productionProfileForIdentity({ production_profile: "fast_premium_v2" }).defaults.generated_motion_policy, "disabled");
  assert.equal(productionProfileForIdentity({ production_profile: "fast_premium_v2" }).defaults.visual_beat_timing_contract.target_beat_sec, 7.5);
  assert.equal(productionProfileForIdentity({ production_profile: "fast_premium_v2" }).defaults.visual_beat_timing_contract.max_beat_sec, 8);
  assert.equal(productionProfileForIdentity({ production_profile: "fast_premium_v2" }).defaults.visual_beat_timing_contract.retention_ramp_sec, 1200);
  assert.equal(productionProfileForIdentity({ production_profile: "fast_premium_v2" }).orchestration.wall_clock_contract.hard_ceiling_minutes, 420);
  assert.equal(productionProfileForIdentity({ production_profile: "fast_premium_v1" }).planner.visual_chunk_concurrency, 12);
  assert.equal(productionProfileForIdentity({ production_profile: "fast_premium_v1" }).orchestration.parallel_audio_semantic, true);
  assert.equal(productionProfileForIdentity({ production_profile: "fast_premium_v1" }).orchestration.visual_wavefront_prefetch, true);
  assert.equal(productionProfileForIdentity({ production_profile: "fast_premium_v1" }).orchestration.incremental_image_qa, true);
  assert.equal(productionProfileForIdentity({ production_profile: "fast_premium_v1" }).orchestration.incremental_motion_clip_prefetch, true);
  assert.equal(productionProfileForIdentity({ production_profile: "fast_premium_v1" }).orchestration.incremental_generated_motion_prefetch, true);
  assert.equal(productionProfileForIdentity({ production_profile: "fast_premium_v1" }).orchestration.generated_motion_coherence_prefetch, true);
  assert.equal(productionProfileForIdentity({ production_profile: "fast_premium_v1" }).orchestration.planner_recovery_policy, "scoped_only");
  assert.equal(
    productionProfileForIdentity({ production_profile: "fast_premium_v1" }).media.google_flow_worker_session_policy,
    PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY,
  );
  assert.equal(
    productionProfileForIdentity({ production_profile: "fast_premium_v1" }).media.google_gemini_worker_session_policy,
    PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY,
  );
  assert.equal(
    productionProfileForIdentity({ production_profile: "fast_premium_v1" }).orchestration.google_flow_worker_pool_policy,
    "five_persistent_projects_top_off_v1",
  );
  assert.equal(
    productionProfileForIdentity({ production_profile: "fast_premium_v1" }).orchestration.google_gemini_worker_pool_policy,
    "three_persistent_tabs_top_off_v1",
  );
  assert.deepEqual(
    productionProfileForIdentity({
      production_profile: "fast_premium_v1",
    }).audio.local_whisper_timing,
    PRODUCTION_LOCAL_WHISPER_CONTRACT,
  );
  const recordedLegacyFastProfile = productionProfileById("fast_premium_v1");
  recordedLegacyFastProfile.planner.visual_chunk_concurrency = 11;
  recordedLegacyFastProfile.planner.antigravity_cli_structured_concurrency = 3;
  recordedLegacyFastProfile.media.google_flow_worker_session_policy = "fresh_project_per_job";
  const preservedLegacyFastProfile = productionProfileForIdentity({
    production_profile: "fast_premium_v1",
    production_profile_config: recordedLegacyFastProfile,
  });
  assert.equal(preservedLegacyFastProfile.planner.visual_chunk_concurrency, 11);
  assert.equal(preservedLegacyFastProfile.planner.antigravity_cli_structured_concurrency, 3);
  assert.equal(preservedLegacyFastProfile.media.google_flow_worker_session_policy, "fresh_project_per_job");
  assert.equal(productionProfileForIdentity({}).planner.visual_chunk_concurrency, 6);
}

function testLocalWhisperProductionContract() {
  const contract = structuredClone(PRODUCTION_LOCAL_WHISPER_CONTRACT);
  assert.deepEqual(contract, {
    contract_version: "local_whisper_word_timing_v2",
    engine: "faster_whisper",
    model: "small.en",
    device: "cpu",
    compute_type: "int8_float32",
    omp_num_threads: 12,
    cpu_threads: 0,
    language: "en",
    beam_size: 5,
    word_timestamps: true,
    vad_filter: false,
  });
  assert.equal(
    localWhisperCommandFlags(contract),
    "--engine faster_whisper --model small.en --device cpu "
      + "--compute-type int8_float32 --omp-num-threads 12 "
      + "--cpu-threads 0 --language en --beam-size 5 "
      + "--word-timestamps true --vad-filter false",
  );

  const identity = {
    schema: "goldflow_run_identity_v2",
    provider_locks: {
      local_whisper_timing: structuredClone(contract),
    },
    production_profile_config: {
      audio: {
        local_whisper_timing: structuredClone(contract),
      },
    },
    production_gates: {
      local_whisper_contract_required: true,
    },
    model_versions: {
      local_whisper_model: "small.en",
    },
  };
  assert.equal(runIdentityWhisperCompleteForTests(identity).done, true);
  const forbiddenMediumIdentity = structuredClone(identity);
  forbiddenMediumIdentity.provider_locks.local_whisper_timing.model = "medium";
  forbiddenMediumIdentity.production_profile_config.audio
    .local_whisper_timing.model = "medium";
  forbiddenMediumIdentity.model_versions.local_whisper_model = "medium";
  assert.equal(
    runIdentityWhisperCompleteForTests(forbiddenMediumIdentity).done,
    false,
  );
  assert.equal(
    resolveLocalWhisperRuntimeContractForTests({
      identity,
      env: {
        ANIFACTORY_WHISPER_MODEL: "medium",
        OMP_NUM_THREADS: "2",
      },
    }).model,
    "small.en",
  );
  assert.throws(
    () => resolveLocalWhisperRuntimeContractForTests({
      identity,
      inputFlags: { model: "medium" },
    }),
    /conflict.*locked local-Whisper/i,
  );

  const command = buildStageCommand("local_whisper_word_timing", identity);
  assert.match(command, /--model small\.en/);
  assert.match(command, /--device cpu/);
  assert.match(command, /--compute-type int8_float32/);
  assert.match(command, /--omp-num-threads 12/);
  assert.match(command, /--cpu-threads 0/);
  assert.doesNotMatch(command, /--model medium|--cpu-threads 12/);

  const exactReport = {
    alignment_contract: structuredClone(contract),
    alignment_contract_version: contract.contract_version,
    alignment_engine: contract.engine,
    alignment_model: contract.model,
    alignment_device: contract.device,
    alignment_compute_type: contract.compute_type,
    alignment_omp_num_threads: contract.omp_num_threads,
    alignment_cpu_threads: contract.cpu_threads,
    language: contract.language,
    alignment_beam_size: contract.beam_size,
    alignment_word_timestamps: contract.word_timestamps,
    alignment_vad_filter: contract.vad_filter,
    word_timing_qa: { status: "passed" },
  };
  assert.equal(
    validateLockedLocalWhisperReport(exactReport, identity).done,
    true,
  );
  const wrongModel = structuredClone(exactReport);
  wrongModel.alignment_contract.model = "medium";
  assert.equal(
    validateLockedLocalWhisperReport(wrongModel, identity).done,
    false,
  );

  const warningOnly = localWhisperWordTimingQa([
    { word: "zero", start_sec: 0.25, end_sec: 0.25 },
  ], 1);
  assert.equal(warningOnly.status, "passed");
  assert.equal(warningOnly.zero_duration_word_count, 1);
  assert.equal(warningOnly.warnings[0].severity, "warning");
  const structurallyInvalid = localWhisperWordTimingQa([
    { word: "broken", start_sec: 0.4, end_sec: 0.3 },
  ], 1);
  assert.equal(structurallyInvalid.status, "blocked");

  const historicalIdentity = {
    schema: "goldflow_run_identity_v2",
    stage_registry_version: "2026-07-29.1",
  };
  assert.equal(
    runIdentityWhisperCompleteForTests(historicalIdentity).done,
    true,
  );
  assert.deepEqual(
    validateLockedLocalWhisperReport({
      status: "passed",
      alignment_engine: "faster_whisper",
      alignment_model: "medium",
      alignment_device: "auto",
      alignment_compute_type: "auto",
    }, historicalIdentity),
    {
      done: true,
      mode: "legacy_adapter",
      contract: null,
      mismatches: [],
      evidence: "legacy identity has no explicit local-Whisper lock",
    },
  );
  assert.equal(
    resolveLocalWhisperRuntimeContractForTests({
      identity: historicalIdentity,
    }).model,
    "small.en",
  );
  assert.throws(
    () => resolveLocalWhisperRuntimeContractForTests({
      identity: historicalIdentity,
      inputFlags: { model: "medium" },
    }),
    /manual structural-recovery/i,
  );
  assert.match(
    buildStageCommand("local_whisper_word_timing", historicalIdentity),
    /--model small\.en/,
  );
}

function testGuardedRunAdvancePolicies() {
  assert.deepEqual(autoAdvanceDecisionForTests("script_approval", "missing", {}), { executable: false, reason: "approval_required" });
  assert.deepEqual(autoAdvanceDecisionForTests("semantic_scene_plan", "missing", {}), { executable: false, reason: "planner_spend_not_approved" });
  assert.equal(autoAdvanceDecisionForTests("semantic_scene_plan", "missing", { allowPlannerSpend: true }).executable, true);
  assert.deepEqual(
    autoAdvanceDecisionForTests("semantic_scene_plan", "failed", { allowPlannerSpend: true }),
    { executable: false, reason: "planner_triage_and_scoped_recovery_required" },
  );
  assert.deepEqual(autoAdvanceDecisionForTests("image_generation", "missing", { allowPlannerSpend: true }), { executable: false, reason: "media_spend_not_approved" });
  assert.equal(autoAdvanceDecisionForTests("image_generation", "missing", { allowMediaSpend: true }).executable, true);
  assert.deepEqual(
    autoAdvanceDecisionForTests("image_generation", "failed", { allowMediaSpend: true }),
    { executable: false, reason: "stage_blocker_triage_and_scoped_recovery_required" },
  );
  assert.deepEqual(autoAdvanceDecisionForTests("image_output_qa", "needs_manual_review", {}), { executable: false, reason: "risk_decisions_required" });
  assert.equal(autoAdvanceDecisionForTests("image_output_qa", "missing", {}).executable, true);
  assert.deepEqual(autoAdvanceDecisionForTests("visual_beat_plan", "missing", { allowPlannerSpend: true }), { executable: false, reason: "approval_required" });
  assert.equal(autoAdvanceDecisionForTests("visual_beat_plan", "missing", {
    allowPlannerSpend: true,
    agentValidatedStages: ["visual_beat_plan"],
  }).executable, true);
  assert.deepEqual(
    autoAdvanceDecisionForTests("visual_beat_plan", "missing", {
      allowPlannerSpend: true,
      agentValidatedStages: ["visual_beat_plan"],
      humanCheckpointStages: ["visual_beat_plan"],
    }),
    { executable: false, reason: "human_checkpoint_requested" },
  );
  assert.equal(parseHumanCheckpointStagesForTests("all").has("final_qa"), true);
  assert.equal(parseHumanCheckpointStagesForTests("reference_plan_approval,final_qa").has("image_output_qa"), false);
  assert.match(agentApprovalCommandForTests("reference_image_approval", "/tmp/episode"), /--agent-review true/);
  assert.match(agentApprovalCommandForTests("final_qa", "/tmp/episode"), /--master-scan true --agent-review true/);
  const leanImageQaCommand = agentApprovalCommandForTests(
    "image_output_qa",
    "/tmp/episode",
    productionProfileById("fast_premium_v2"),
  );
  assert.match(leanImageQaCommand, /--semantic-audit-sample-rate 0\.01/);
  assert.match(leanImageQaCommand, /--integration-sample-rate 0\.02/);
  const tokens = advanceCommandTokensForTests(
    "node bin/goldflow.mjs visual harden --episode-dir <episode-dir> --prompts <episode-dir>/section_image_prompts.json",
    "/tmp/episode",
  );
  assert.deepEqual(tokens?.slice(1), ["visual", "harden", "--episode-dir", "/tmp/episode", "--prompts", "/tmp/episode/section_image_prompts.json"]);
  const wavefrontTokens = advanceCommandTokensForTests(
    "node bin/goldflow.mjs run visual-wavefront --episode-dir <episode-dir> --min-cuts 15 --max-wait-ms 5000",
    "/tmp/episode",
  );
  assert.deepEqual(wavefrontTokens?.slice(1), ["run", "visual-wavefront", "--episode-dir", "/tmp/episode", "--min-cuts", "15", "--max-wait-ms", "5000"]);
  assert.equal(advanceCommandTokensForTests("Stage images; then run something", "/tmp/episode"), null);
}

function testPlannerChunkIdentityValidation() {
  assert.deepEqual(plannerChunkIdentityFindings(["beat_a", "beat_b"], ["beat_a", "beat_b"]), []);
  assert.deepEqual(
    plannerChunkIdentityFindings(["beat_a", "beat_b"], ["beat_a"]).map((finding) => finding.code),
    ["planner_chunk_output_count_mismatch", "planner_chunk_identity_mismatch"],
  );
  assert.deepEqual(
    plannerChunkIdentityFindings(["beat_a", "beat_b"], ["beat_b", "beat_a"]).map((finding) => finding.code),
    ["planner_chunk_identity_mismatch"],
  );
}

function testYoutubeRetentionAttribution() {
  const retention = normalizeRetentionRowsForTests([
    { "Video position (%)": "0", "Absolute audience retention (%)": "100" },
    { "Video position (%)": "50", "Absolute audience retention (%)": "62" },
    { "Video position (%)": "100", "Absolute audience retention (%)": "41" },
  ], 120);
  assert.deepEqual(retention.map((row) => row.elapsed_sec), [0, 60, 120]);
  const attributed = buildRetentionAttributionForTests({
    retentionRows: retention,
    prompts: [
      { image_id: "cut_001", visual_beat_id: "beat_001", scene_id: "scene_001", start_sec: 0, duration_sec: 60, visual_job: "premise_image", image_provider_route: "modelslab", reference_requirements: [{}], shot_manifest: { shot_job: "interaction", location_contract_id: "hall", motion_intent: { behavior: "slow_push_in" } } },
      { image_id: "cut_002", visual_beat_id: "beat_002", scene_id: "scene_002", start_sec: 60, duration_sec: 60, visual_job: "consequence", image_provider_route: "modelslab", reference_requirements: [{}, {}], shot_manifest: { shot_job: "consequence", location_contract_id: "court", motion_intent: { behavior: "aftermath_reveal" } } },
    ],
    imagegenResults: [{ image_id: "cut_002", image_provider: "editorial_reuse" }],
    motionIntents: [{ image_id: "cut_002", behavior: "static_hold" }],
    transitions: [{ start_sec: 60, transition: "fade" }],
  });
  assert.equal(attributed[1].image_id, "cut_002");
  assert.equal(attributed[1].delta_from_previous_pct, -38);
  assert.equal(attributed[1].transition_type, "fade");
  assert.equal(attributed[1].motion_behavior, "static_hold");
  assert.equal(attributed[1].image_provider, "editorial_reuse");
}

async function testFinalQaSourceHashFreshness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-final-qa-"));
  const sourcePath = path.join(dir, "source.json");
  await fs.writeFile(sourcePath, "first", "utf8");
  const expected = sha256(await fs.readFile(sourcePath));
  let result = await validateFinalQaSourceHashesForTests({ [sourcePath]: expected });
  assert.deepEqual(result.stale, []);
  await fs.writeFile(sourcePath, "changed", "utf8");
  result = await validateFinalQaSourceHashesForTests({ [sourcePath]: expected });
  assert.deepEqual(result.stale, [sourcePath]);
}

async function testRunStatusRejectsFalseGreenFinalQa() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-final-status-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await fs.mkdir(episodeDir, { recursive: true });
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    schema: "goldflow_run_identity_v2",
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    audio_target: "narrator_only",
    image_provider: "modelslab",
  });
  await writeJson(path.join(episodeDir, "qa_report_looks_finished.json"), { status: "passed" });
  let result = await execFileAsync(process.execPath, ["scripts/run-status.mjs", "--episode-dir", episodeDir], {
    cwd: process.cwd(),
    env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot },
  });
  let status = JSON.parse(result.stdout);
  let finalStage = status.stage_ledger.find((row) => row.stage === "final_qa");
  assert.equal(finalStage.state, "missing");
  await writeJson(path.join(episodeDir, "final_qa_ep_01.json"), { status: "failed" });
  result = await execFileAsync(process.execPath, ["scripts/run-status.mjs", "--episode-dir", episodeDir], {
    cwd: process.cwd(),
    env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot },
  });
  status = JSON.parse(result.stdout);
  finalStage = status.stage_ledger.find((row) => row.stage === "final_qa");
  assert.equal(finalStage.state, "failed");
}

async function testRunStatusParallaxDecisionStages() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-parallax-status-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await fs.mkdir(episodeDir, { recursive: true });
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    schema: "goldflow_run_identity_v2",
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    audio_target: "narrator_only",
    image_provider: "modelslab",
    motion_policy: "selective_editorial_v1",
    parallax_policy: "selective_inspected",
    render_profile: "smooth_subpixel_ken_burns",
  });
  const reportPath = path.join(episodeDir, "parallax_asset_report_ep_01.json");
  const sourcePath = path.join(episodeDir, "parallax-source.json");
  await writeJson(sourcePath, { fixture: true });
  const emptyReport = {
    schema: "goldflow_parallax_asset_report_v1",
    status: "passed",
    candidate_count: 0,
    candidates: [],
    no_suitable_parallax: { disposition: "accepted_single_plane_motion_fallback" },
    source_hashes: { [sourcePath]: await sha256File(sourcePath) },
  };
  emptyReport.asset_contract_sha256 = parallaxAssetContractSha256(emptyReport);
  await writeJson(reportPath, emptyReport);
  const result = await execFileAsync(process.execPath, ["scripts/run-status.mjs", "--episode-dir", episodeDir], {
    cwd: process.cwd(),
    env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot },
  });
  const status = JSON.parse(result.stdout);
  assert.equal(status.stage_ledger.find((row) => row.stage === "parallax_asset_generation").state, "passed");
  assert.equal(status.stage_ledger.find((row) => row.stage === "parallax_asset_approval").state, "passed");
}

async function testAppendOnlyExecutionProvenance() {
  const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-events-"));
  await writeJson(path.join(episodeDir, "input.json"), { status: "passed", value: 1 });
  const flags = { "episode-dir": episodeDir, "cut-ids": "cut_001" };
  const first = await beginStageExecution({ stage: "image_generation", command: "imagegen start", flags });
  await writeJson(path.join(episodeDir, "imagegen_report_ep_01.json"), {
    status: "partial",
    estimated_cost: { current_batch: { estimated_cost_usd: 0.08 } },
  });
  await finishStageExecution(first, { exitCode: 0 });
  const second = await beginStageExecution({ stage: "image_generation", command: "imagegen start", flags });
  await writeJson(path.join(episodeDir, "imagegen_report_ep_01.json"), {
    status: "passed",
    estimated_cost: { current_batch: { estimated_cost_usd: 0.04 } },
  });
  await finishStageExecution(second, { exitCode: 0 });
  const references = await beginStageExecution({
    stage: "reference_generation",
    command: "imagegen start",
    flags: { "episode-dir": episodeDir, "references-only": "true" },
  });
  await writeJson(path.join(episodeDir, "visual_reference_generation_report.json"), {
    status: "passed",
    estimated_cost: { estimated_cost_usd: 0.07 },
  });
  const referenceEvent = await finishStageExecution(references, { exitCode: 0 });
  assert.equal(referenceEvent.cost_usd, 0.07);
  const render = await beginStageExecution({ stage: "premium_render", command: "render start", flags: { "episode-dir": episodeDir } });
  await writeJson(path.join(episodeDir, "render_report_ep_01.json"), {
    status: "passed",
    render_motion: { motion_clip_cache_reused_count: 12 },
  });
  const renderEvent = await finishStageExecution(render, { exitCode: 0 });
  assert.equal(renderEvent.cache_reuse_count, 12);

  const batchDir = path.join(episodeDir, "reports", "imagegen-batches");
  await writeJson(path.join(batchDir, "001-references.json"), {
    schema: "goldflow_imagegen_batch_report_v1",
    batch_id: "references-001",
    batch_kind: "references",
    current_batch_status: "passed",
    current_batch_cost: { generated_count: 1, estimated_cost_usd: 0.07 },
    wall_time_sec: 3,
    image_provider: "modelslab",
  });
  await writeJson(path.join(batchDir, "002-scenes.json"), {
    schema: "goldflow_imagegen_batch_report_v1",
    batch_id: "scenes-001",
    batch_kind: "scene_images",
    current_batch_status: "passed",
    current_batch_cost: { generated_count: 1, estimated_cost_usd: 0.08 },
    wall_time_sec: 4,
    image_provider: "modelslab",
  });
  await writeJson(path.join(batchDir, "003-retry.json"), {
    schema: "goldflow_imagegen_batch_report_v1",
    batch_id: "scenes-retry-001",
    batch_kind: "scoped_scene_retry",
    current_batch_status: "passed",
    current_batch_cost: { generated_count: 1, estimated_cost_usd: 0.04 },
    wall_time_sec: 2,
    image_provider: "modelslab",
  });
  const events = (await fs.readFile(path.join(episodeDir, "execution_events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter((row) => row.event_type === "stage_started").length, 4);
  assert.equal(events.filter((row) => row.event_type === "stage_completed").length, 4);
  assert.equal(second.attempt, 2);
  const manifest = await materializeProductionManifest(episodeDir);
  assert.equal(manifest.telemetry.total_stage_calls, 4);
  assert.equal(manifest.telemetry.retry_calls, 1);
  assert.equal(manifest.telemetry.event_recorded_cost_usd, 0.19);
  assert.equal(manifest.telemetry.imagegen_event_recorded_cost_usd, 0.19);
  assert.equal(manifest.telemetry.imagegen_batch_cost_usd, 0.19);
  assert.equal(manifest.telemetry.cumulative_cost_usd, 0.19);
  assert.equal(manifest.telemetry.cache_reuse_count, 12);
  assert.equal(manifest.imagegen_batches.batch_count, 3);
  assert.equal(manifest.imagegen_batches.scoped_retry_batch_count, 1);
  assert.equal(manifest.imagegen_batches.generated_count, 3);
  assert.equal(manifest.imagegen_batches.wall_time_sec, 9);
  assert.equal(manifest.imagegen_batches.by_kind.references.estimated_cost_usd, 0.07);
  const reportFiles = await fs.readdir(path.join(episodeDir, "reports", "stages", "image_generation"));
  assert.equal(reportFiles.length, 2);
}

async function testExecutionProvenanceScopesAndTruthfulCompletion() {
  assert.deepEqual(executionScopeForTests({
    "image-id": "cut_002",
    "cut-ids": "cut_001,cut_002",
    "reference-id": "ref_001",
    "scene-id": "scene_001",
  }), {
    cut_ids: ["cut_001", "cut_002"],
    scene_ids: ["scene_001"],
    beat_ids: [],
    planner_chunk_ids: [],
    reference_ids: ["ref_001"],
    proof_start_sec: null,
    proof_end_sec: null,
    references_only: false,
  });
  assert.deepEqual(executionScopeForTests({
    "image-id": "cut_002",
    "cut-ids": "cut_001,cut_002",
    "reference-id": "ref_001",
    "scene-id": "scene_001",
    "regenerate-unit-ids": "tts_002,tts_001",
    "regenerate-speakers": "system,NARRATOR",
  }), {
    cut_ids: ["cut_001", "cut_002"],
    scene_ids: ["scene_001"],
    beat_ids: [],
    planner_chunk_ids: [],
    reference_ids: ["ref_001"],
    tts_unit_ids: ["tts_001", "tts_002"],
    tts_speakers: ["NARRATOR", "SYSTEM"],
    proof_start_sec: null,
    proof_end_sec: null,
    references_only: false,
  });
  assert.deepEqual(executionScopeForTests({
    "episode-dir": "/tmp/episode",
    "confirmed-retry-unit-ids": "tts_002,tts_001",
  }), {
    cut_ids: [],
    scene_ids: [],
    beat_ids: [],
    planner_chunk_ids: [],
    reference_ids: [],
    tts_unit_ids: ["tts_001", "tts_002"],
    proof_start_sec: null,
    proof_end_sec: null,
    references_only: false,
  });
  assert.deepEqual(executionScopeForTests({
    "episode-dir": "/tmp/episode",
    "stitch-repair-tail-unit-ids": "tts_003,tts_002",
  }), {
    cut_ids: [],
    scene_ids: [],
    beat_ids: [],
    planner_chunk_ids: [],
    reference_ids: [],
    tts_unit_ids: ["tts_002", "tts_003"],
    proof_start_sec: null,
    proof_end_sec: null,
    references_only: false,
  });
  assert.deepEqual(executionScopeForTests({
    "episode-dir": "/tmp/episode",
    "boundary-id": "boundary_003",
    "boundary-ids": "boundary_002,boundary_003",
  }), {
    cut_ids: [],
    scene_ids: [],
    beat_ids: [],
    planner_chunk_ids: [],
    reference_ids: [],
    boundary_ids: ["boundary_002", "boundary_003"],
    proof_start_sec: null,
    proof_end_sec: null,
    references_only: false,
  });

  const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-provenance-truth-"));
  await writeJson(path.join(episodeDir, "cut_execution_ledger.json"), {
    status: "partial",
    cut_count: 2,
    completed_image_count: 1,
    pending_image_qa_count: 1,
    cuts: [
      {
        image_id: "cut_001",
        image_path: path.join(episodeDir, "cut_001.png"),
        image_sha256: "hash_001",
        generation_status: "generated",
        image_qa_status: "passed_structural",
      },
      {
        image_id: "cut_002",
        image_path: path.join(episodeDir, "cut_002.png"),
        image_sha256: "hash_002",
        generation_status: "failed",
        image_qa_status: "passed_manual_risk",
      },
    ],
  });
  const failed = await beginStageExecution({
    stage: "image_generation",
    command: "imagegen import-codex",
    flags: { "episode-dir": episodeDir, "image-id": "cut_001" },
  });
  await finishStageExecution(failed, { exitCode: 1, error: "provider timeout", stderrTail: "provider timeout" });
  const repaired = await beginStageExecution({
    stage: "image_generation",
    command: "imagegen import-codex",
    flags: { "episode-dir": episodeDir, "image-id": "cut_002" },
  });
  assert.equal(failed.attempt, 1);
  assert.equal(repaired.attempt, 1);
  await finishStageExecution(repaired, { exitCode: 0, stdoutTail: "imported cut_002" });
  const finalQa = await beginStageExecution({
    stage: "final_qa",
    command: "final qa",
    flags: { "episode-dir": episodeDir },
  });
  await finishStageExecution(finalQa, { exitCode: 0 });
  const ttsRetry = await beginStageExecution({
    stage: "qwen_tts_stitch",
    command: "tts qwen",
    flags: { "episode-dir": episodeDir, "regenerate-unit-ids": "tts_001" },
  });
  await finishStageExecution(ttsRetry, { exitCode: 0 });
  const manifest = await materializeProductionManifest(episodeDir);
  assert.equal(manifest.status, "completed_with_retries");
  assert.equal(manifest.cut_execution.status, "passed");
  assert.equal(manifest.cut_execution.completed_image_count, 2);
  assert.equal(manifest.cut_execution.accepted_image_count, 2);
  assert.equal(manifest.cut_execution.recovered_manual_import_count, 1);
  assert.equal(manifest.telemetry.retry_calls, 0);
  assert.equal(manifest.telemetry.scoped_execution_calls, 3);
  const failedReport = JSON.parse(await fs.readFile(
    (await fs.readdir(path.join(episodeDir, "reports", "stages", "image_generation")))
      .map((name) => path.join(episodeDir, "reports", "stages", "image_generation", name))
      .sort()[0],
    "utf8",
  ));
  assert.equal(failedReport.error, "provider timeout");
  assert.equal(failedReport.stderr_tail, "provider timeout");
}

function testPlannerCachesDefaultOn() {
  for (const enabled of [
    semanticCodexCacheEnabledForTests,
    visualReferenceCodexCacheEnabledForTests,
    visualPromptCodexCacheEnabledForTests,
  ]) {
    assert.equal(enabled({}), true);
    assert.equal(enabled({ "reuse-codex-calls": "false", "visual-ref-reuse-codex-chunks": "false", "codex-reuse-cache": "false" }), false);
  }
}

function testSemanticChunkAndReconciliationEffortRouting() {
  const stageFlags = {
    "reasoning-effort": "xhigh",
    "semantic-chunk-reasoning-effort": "high",
    "semantic-reconciliation-reasoning-effort": "max",
  };
  assert.equal(
    semanticReasoningEffortForStage("ep_01_semantic_scene_plan_chunk_09_exact_repair", stageFlags),
    "high",
  );
  assert.equal(
    semanticReasoningEffortForStage("ep_01_semantic_scene_plan_global_reconciliation", stageFlags),
    "max",
  );
  assert.equal(
    semanticReasoningEffortForStage("ep_01_semantic_scene_plan_chunk_01", { "reasoning-effort": "xhigh" }),
    "xhigh",
  );
  assert.deepEqual(
    semanticReusableStageNamesForTests("ep_01_semantic_scene_plan_chunk_09_exact_repair"),
    [
      "ep_01_semantic_scene_plan_chunk_09_exact_repair",
      "ep_01_semantic_scene_plan_chunk_09",
    ],
  );
  assert.deepEqual(
    semanticReusableStageNamesForTests("ep_01_semantic_scene_plan_chunk_09"),
    ["ep_01_semantic_scene_plan_chunk_09"],
  );
}

function testPlannerJsonRepairHandlesQuotedProseBeforeComma() {
  const malformed = `{
    "warning": "The chunk begins with "neck.", which continues the prior line.",
    "script_excerpt_end": ""Let's take that one."",
    "next": "ok"
  }`;
  const repaired = parseJsonObjectFromPlannerOutput(malformed);
  assert.equal(repaired.value.warning, 'The chunk begins with "neck.", which continues the prior line.');
  assert.equal(repaired.value.script_excerpt_end, '"Let\'s take that one."');
  assert.equal(repaired.value.next, "ok");
  assert.equal(repaired.syntax_repair?.kind, "escape_unescaped_string_quotes");
  assert.equal(repaired.syntax_repair?.repair_count, 4);
}

function testVisualReferencePlannerSplitsOnlyOversizedChunks() {
  assert.equal(shouldSplitReferenceChunkForTests(48_001, 8), true);
  assert.equal(shouldSplitReferenceChunkForTests(48_000, 8), false);
  assert.equal(shouldSplitReferenceChunkForTests(1_200_000, 1), false);
  assert.equal(shouldSplitReferenceChunkForTests(47_000, 8), false);
}

async function testCumulativeImagegenHistoryAndEpisodeTruth() {
  const cumulative = await cumulativeImagegenHistoryForTests([
    { current_batch_cost: { estimated_cost_usd: 0.08 }, wall_time_sec: 4 },
    { current_batch_cost: { estimated_cost_usd: 0.04 }, wall_time_sec: 2 },
  ]);
  assert.equal(cumulative.batch_count, 2);
  assert.equal(cumulative.estimated_cost_usd, 0.12);
  assert.equal(cumulative.wall_time_sec, 6);
  assert.equal(episodeImageStatusForTests("passed", "partial"), "partial");
  assert.equal(episodeImageStatusForTests("passed", "passed"), "passed");
  assert.equal(episodeImageStatusForTests("failed", "passed"), "passed");
}

function testPinnedCodexRuntimeContracts() {
  assert.equal(DEFAULT_CODEX_MODEL, "gpt-5.6-sol");
  assert.equal(DEFAULT_CODEX_REASONING_EFFORT, "medium");
  const oldCli = parseCodexVersion("codex-cli 0.141.0");
  const qualifyingBundledCli = parseCodexVersion("codex-cli 0.144.0-alpha.4");
  assert.equal(codexVersionSupportsModel(oldCli, DEFAULT_CODEX_MODEL), false);
  assert.equal(codexVersionSupportsModel(qualifyingBundledCli, DEFAULT_CODEX_MODEL), true);
  assert.equal(compareCodexVersions(qualifyingBundledCli, oldCli) > 0, true);

  const promptHash = sha256("fixture prompt");
  const matchingMetadata = {
    status: "passed",
    provider: "codex_cli",
    model: DEFAULT_CODEX_MODEL,
    reasoning_effort: DEFAULT_CODEX_REASONING_EFFORT,
    prompt_sha256: promptHash,
  };
  assert.equal(isCodexCacheCompatible(matchingMetadata, {
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    promptHash,
    provider: "codex_cli",
  }), true);
  assert.equal(isCodexCacheCompatible({ ...matchingMetadata, model: "gpt-5.5" }, {
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    promptHash,
    provider: "codex_cli",
  }), false);
  assert.equal(isCodexCacheCompatible({ ...matchingMetadata, reasoning_effort: "high" }, {
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    promptHash,
    provider: "codex_cli",
  }), false);
  assert.equal(isCodexCacheCompatible({ ...matchingMetadata, prompt_sha256: "stale" }, {
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    promptHash,
    provider: "codex_cli",
  }), false);

  assert.equal(webPlannerEffortForStage("ep_01_semantic_scene_plan_chunk_001"), "xhigh");
  assert.equal(webPlannerEffortForStage("ep_01_semantic_scene_plan_global_reconciliation"), "max");
  assert.equal(webPlannerEffortForStage("ep_01_visual_reference_plan_merge"), "max");
  assert.equal(webPlannerEffortForStage("ep_01_visual_plan_chunk_001"), "high");
  assert.equal(webPlannerEffortForStage("ep_01_audio_sfx_score"), "medium");
  assert.equal(webPlannerEffortForStage("winner_script_generation"), "max");
}

async function testNestedCodexCallsUseSharedRunner() {
  const scriptsDir = path.join(process.cwd(), "scripts");
  const scriptFiles = (await fs.readdir(scriptsDir)).filter((name) => name.endsWith(".mjs"));
  for (const scriptFile of scriptFiles) {
    const source = await fs.readFile(path.join(scriptsDir, scriptFile), "utf8");
    assert.doesNotMatch(source, /spawn\s*\(\s*["']codex["']/, `${scriptFile} must use lib/codex-cli-runner.mjs`);
    assert.equal(source.includes(["codex", "cli", "default"].join("_")), false, `${scriptFile} must report the actual pinned Codex model`);
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeFixtureReferenceInventory(episodeDir, sourceScriptHash = "fixture_hash", assets = []) {
  const ledgerPath = path.join(episodeDir, "reference_inventory_ledger.json");
  await writeJson(ledgerPath, {
    schema: "goldflow_reference_inventory_ledger_v1",
    status: "passed",
    source_script_hash: sourceScriptHash,
    policy: "fixture director inventory",
    summary: {
      asset_count: assets.length,
      by_kind: {},
      by_recommended_generation_mode: {},
      by_director_role: {},
    },
    assets,
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  return ledgerPath;
}

function testSemanticSceneAnchorValidation() {
  const script = [
    "Joey entered the boardroom with the signed receipt.",
    "The screen changed and Victor stopped smiling.",
    "He did not need to speak.",
  ].join(" ");
  const validFindings = semanticSceneAnchorFindingsForTests([
    {
      scene_id: "scene_001",
      title: "Receipt Enters Boardroom",
      script_excerpt_start: "Joey entered the boardroom with the signed receipt.",
      script_excerpt_end: "The screen changed and Victor stopped smiling.",
    },
    {
      scene_id: "scene_002",
      title: "Silence Wins",
      script_excerpt_start: "He did not need to speak.",
      script_excerpt_end: "He did not need to speak.",
    },
  ], script);
  assert.deepEqual(validFindings, []);

  const brokenFindings = semanticSceneAnchorFindingsForTests([
    {
      scene_id: "scene_001",
      title: "Broken End",
      script_excerpt_start: "The screen changed and Victor stopped smiling.",
      script_excerpt_end: "Joey did not need to speak.",
    },
  ], script);
  assert.equal(brokenFindings.some((finding) => finding.code === "semantic_end_anchor_not_found"), true);
}

function testSemanticSceneCoverageRejectsCollapsedTail() {
  const prefix = Array.from({ length: 40 }, (_, index) => `prefix${index}`).join(" ");
  const tail = Array.from({ length: 1700 }, (_, index) => `tail${index}`).join(" ");
  const script = `${prefix} Final arc begins ${tail} Yes`;
  const findings = semanticSceneCoverageFindingsForTests([
    { scene_id: "scene_001", title: "Opening", script_excerpt_start: "prefix0", script_excerpt_end: "prefix39" },
    { scene_id: "scene_002", title: "Collapsed Tail", script_excerpt_start: "Final arc begins", script_excerpt_end: "Yes" },
  ], script);
  assert.equal(findings.some((finding) => finding.code === "semantic_scene_span_too_large"), true);
  assert.equal(findings.some((finding) => finding.code === "semantic_final_scene_does_not_cover_script_end"), false);
  const uncoveredGapFindings = semanticSceneCoverageFindingsForTests([
    {
      scene_id: "scene_001",
      title: "First",
      script_excerpt_start: "Joey entered.",
      script_excerpt_end: "Joey entered.",
    },
    {
      scene_id: "scene_002",
      title: "Second",
      script_excerpt_start: "Mira answered.",
      script_excerpt_end: "Mira answered.",
    },
  ], "Joey entered. Two unassigned sentences remain. Mira answered.");
  assert.equal(
    uncoveredGapFindings.some(
      (finding) => finding.code === "semantic_scene_gap_uncovered_words"
        && finding.uncovered_word_count === 4,
    ),
    true,
  );
}

function testSemanticSceneQualityFindings() {
  const findings = semanticSceneQualityFindingsForTests([
    {
      scene_id: "scene_001",
      title: "Mixed Semantic Fixture",
      location: "Joey's office and phone-message view with system dashboard overlay",
      visible_subjects: ["Joey Manhwa", "online public through comments"],
      character_states: [{ character: "Joey", state: "watching the phone", wardrobe: "dark suit" }],
      props: ["conference room screen", "signed receipt"],
      ui_text_on_screen: ["This is a very long multi-line legal-system notice that should become a concise panel motif instead of baked image text."],
      visual_intent: "Show the hook payoff for the viewer.",
    },
  ]);
  const codes = new Set(findings.map((finding) => finding.code));
  assert.equal(codes.has("semantic_mixed_location_contract"), true);
  assert.equal(codes.has("semantic_generic_visible_subject"), true);
  assert.equal(codes.has("semantic_prop_location_or_ui_bleed"), true);
  assert.equal(codes.has("semantic_dense_ui_text"), true);
  assert.equal(codes.has("semantic_character_alias_churn"), true);
  assert.equal(codes.has("semantic_editorial_meta_language"), true);
  const missingLocationFindings = semanticSceneQualityFindingsForTests([
    {
      scene_id: "scene_002",
      title: "Location Missing Ref",
      location: "tribunal witness floor",
      visible_subjects: ["Joey Manhwa"],
      ref_requirements: [{ kind: "character", ref_id: "char_joey_manhwa" }],
    },
  ]);
  assert.equal(
    missingLocationFindings.some((finding) => finding.code === "semantic_physical_scene_missing_location_ref_requirement" && finding.severity === "warning"),
    true
  );
  const unsupportedRefKindFindings = semanticSceneQualityFindingsForTests([{
    scene_id: "scene_003",
    title: "Unsupported Organization Ref",
    location: "abstract",
    ref_requirements: [{ kind: "organization", ref_id: "apex_vanguard" }],
  }]);
  assert.equal(
    unsupportedRefKindFindings.some(
      (finding) => finding.code === "semantic_ref_requirement_kind_unsupported"
        && finding.severity === "blocker",
    ),
    true,
  );
  const repairedLocationScenes = applyManualLocationRefRepairsForTests(
    [{
      scene_id: "scene_002",
      title: "Location Missing Ref",
      location: "tribunal witness floor",
      visible_subjects: ["Joey Manhwa"],
      ref_requirements: [{ kind: "character", ref_id: "char_joey_manhwa" }],
    }],
    {
      schema: "goldflow_semantic_manual_location_ref_repair_v1",
      status: "approved",
      source_script_hash: "script_hash",
      repairs: [{
        scene_id: "scene_002",
        expected_location: "tribunal witness floor",
        location_ref_requirement: {
          ref_id: "tribunal_witness_floor",
          kind: "location",
          required: true,
          reason: "Manual scoped location coverage.",
        },
      }],
    },
    {
      sourceScriptHash: "script_hash",
      requestedSceneIds: ["scene_002"],
    },
  );
  assert.equal(
    semanticSceneQualityFindingsForTests(repairedLocationScenes.scenes)
      .some((finding) => finding.code === "semantic_physical_scene_missing_location_ref_requirement"),
    false,
  );
  assert.equal(repairedLocationScenes.applied_repairs[0].scene_id, "scene_002");
  const manualSemanticRepair = applyManualSemanticRepairsForTests(
    [{
      scene_id: "scene_001",
      title: "Base",
      script_excerpt_start: "Joey entered.",
      script_excerpt_end: "Joey entered.",
      location: "unsupported room",
      ref_requirements: [{ kind: "organization", ref_id: "apex" }],
    }],
    {
      canonical_locations: [],
      state_transitions: [],
    },
    {
      schema: "goldflow_semantic_manual_repair_v1",
      status: "approved",
      source_script_hash: "script_hash",
      base_reconciliation_sha256: "base_hash",
      scene_updates: [{
        scene_id: "scene_001",
        expected: {
          location: "unsupported room",
          ref_requirements: [{ kind: "organization", ref_id: "apex" }],
        },
        set: {
          location: "abstract",
          ref_requirements: [],
        },
      }],
      scene_insertions: [{
        after_scene_id: "scene_001",
        inserted_scene_id: "scene_001a",
        scene: {
          title: "Inserted",
          script_excerpt_start: "Mira answered.",
          script_excerpt_end: "Mira answered.",
          location: "abstract",
          visible_subjects: ["Mira Kade"],
          primary_subject: "Mira Kade",
          visual_intent: "Preserve the missing beat.",
          ui_text_on_screen: [],
          sfx_cues: [],
          character_states: [],
          props: [],
          ref_requirements: [],
          action_staging: "Mira answers.",
          continuity_notes: [],
        },
      }],
      state_transition_appends: [{
        source_scene_id: "scene_001",
        entity_id: "joey",
        state_kind: "injury",
        from_state: "unhurt",
        to_state: "hurt",
        transition_evidence_excerpt: "Joey entered.",
        evidence: [{ exact_excerpt: "Joey entered.", confidence: 1 }],
      }],
      canonical_location_appends: [{
        location_id: "answer_area",
        display_name: "Answer area",
        aliases: [],
        evidence: [{ exact_excerpt: "Mira answered.", confidence: 1 }],
      }],
    },
    {
      sourceScriptHash: "script_hash",
      baseReconciliationSha256: "base_hash",
      requestedSceneIds: ["scene_001"],
    },
  );
  assert.deepEqual(
    manualSemanticRepair.scenes.map((scene) => scene.scene_id),
    ["scene_001", "scene_001a"],
  );
  assert.equal(manualSemanticRepair.scenes[0].location, "abstract");
  assert.equal(manualSemanticRepair.ledger.state_transitions.length, 1);
  assert.equal(manualSemanticRepair.ledger.canonical_locations[0].location_id, "answer_area");
}

function testReferenceDirectorPreservesRetiredSceneScopesAsAdvisory() {
  const result = dropUnknownReferenceSceneScopesForTests([
    { ref_id: "rail_office_ref", scene_ids: ["scene_069", "scene_070", "scene_070a"] },
  ], new Set(["scene_069", "scene_070a"]));
  assert.deepEqual(result.targets[0].scene_ids, ["scene_069", "scene_070", "scene_070a"]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, "reference_target_unknown_scene_scope_preserved");
  assert.deepEqual(result.findings[0].scene_ids, ["scene_070"]);
}

function testSemanticPlannerPromptContracts() {
  const prompt = semanticBuildPromptForTests("Joey entered the office.", {}, {
    words: 4,
    target: 1,
    minimum: 1,
    maximum: 2,
  });
  assert.match(prompt, /one visible physical environment/i);
  assert.match(prompt, /not a mixture of UI, overlays, phone views, document views, remote call locations, or montage destinations/i);
  assert.match(prompt, /Do not alternate between a first name and a full name/i);
  assert.match(prompt, /props means tangible foreground objects/i);
  assert.match(prompt, /Do not put rooms, doors, windows, desks, walls, stages, screens, dashboards, webpages, feeds, architecture/i);
  assert.match(prompt, /ui_text_on_screen should be concise/i);
  assert.match(prompt, /not automatic standalone image-generation orders/i);
  assert.match(prompt, /Keep character state layers separate/i);
  assert.match(prompt, /visible_state is for physical facts the camera can see/i);
  assert.match(prompt, /financially, or emotionally ruined/i);
  assert.match(prompt, /do not convert abstract phrases like broke, ruined, betrayed, humiliated, indebted, or emotionally collapsed/i);
  assert.match(prompt, /do not summarize, paraphrase, remove clauses, or change quotation marks/i);
  assert.match(prompt, /named or distinct creatures, bosses, guardians, constructs, summons/i);
  assert.match(prompt, /is an entity, not a prop/i);
}

function testSemanticChunkingSplitsLongSingleParagraph() {
  const sentence = "Joey entered the office and the screen changed before anyone spoke.";
  const script = Array.from({ length: 80 }, (_item, index) => `${sentence} Scene ${index + 1} ended with a receipt.`).join(" ");
  const chunks = semanticScriptChunksForTests(script, 120);
  const totalWords = script.trim().split(/\s+/).length;
  assert.equal(chunks.length > 1, true);
  assert.equal(chunks[0].word_start_index, 0);
  assert.equal(chunks.at(-1).word_end_index_exclusive, totalWords);
  assert.equal(chunks.every((chunk) => chunk.words <= 120), true);
  assert.equal(chunks.slice(1).every((chunk, index) => chunk.word_start_index < chunks[index].word_end_index_exclusive), true);
  assert.equal(chunks.slice(1).every((chunk) => chunk.overlap_words > 0), true);
}

function testBoundedProofBaselineScoping() {
  const script = Array.from({ length: 20 }, (_, index) => `word${index}`).join(" ");
  const timing = {
    words: Array.from({ length: 10 }, (_, index) => ({ word: `word${index}`, start_sec: index, end_sec: index + 0.8 })),
  };
  const scope = semanticProofScopeForTests(script, timing, 0, 5, 2);
  assert.equal(scope.scoped, true);
  assert.equal(scope.baseline_timing_word_count, 5);
  assert.equal(scope.source_word_end_exclusive, 7);
  assert.equal(scope.script.trim().split(/\s+/).length, 7);
  const words = scopedBaselineWordsForTests(timing.words, 2, 5);
  assert.equal(words.length, 3);
  assert.equal(words[0].start_sec, 0);
  assert.equal(words.at(-1).end_sec, 2.8);
  assert.equal(commandStageFor("run", "import-proof-baseline", {}), "voice_plan");
  assert.equal(factLedgerMatchesScriptForTests({ status: "passed", source_script_hash: "scoped-hash", source_hashes: { "/script.md": "locked-hash" } }, "/script.md", "locked-hash"), true);
  const identity = { channel: "c", series_slug: "s", week: "w", episode: "ep_01", proof_scope: { mode: "bounded", start_sec: 0, end_sec: 300 } };
  assert.match(buildStageCommand("semantic_scene_plan", identity), /--proof-baseline-word-timing .* --scope-start-sec 0 --scope-end-sec 300/);
  assert.match(buildStageCommand("visual_beat_plan", identity), /--scope-start-sec 0 --scope-end-sec 300/);
  const prefix = scriptPrefixForTimedWordsForTests(
    "One two three. [Opening death avoided.] Later unrelated story continues for hours.",
    ["one", "two", "three", "opening", "death", "avoided"].map((word) => ({ word })),
  );
  assert.equal(prefix.script.trim(), "One two three. [Opening death avoided.]");
  assert.equal(prefix.fallback, false);
  const multilineScope = semanticProofScopeForTests(
    "First line.\n\n[Exact UI line.]\nFinal line.",
    { words: [
      { word: "First", start_sec: 0 },
      { word: "line", start_sec: 0.3 },
      { word: "Exact", start_sec: 0.6 },
      { word: "UI", start_sec: 0.9 },
    ] },
    0,
    1,
    0,
  );
  assert.equal(multilineScope.script, "First line.\n\n[Exact UI");
}

async function testProofBaselineImportSupportsGenericAndLegacyNarrationContracts() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-proof-import-"));
  const baselineEpisodeDir = path.join(dataRoot, "baseline", "episodes", "ep_01");
  const genericEpisodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "generic-proof", "episodes", "ep_01");
  const legacyEpisodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "legacy-proof", "episodes", "ep_01");
  const scriptText = "The ledger opened before dawn. Then the gate answered with a warning.";
  const scriptHash = sha256(Buffer.from(scriptText));
  const baselineAudioPath = path.join(baselineEpisodeDir, "assets", "audio", "narration.m4a");
  await fs.mkdir(path.dirname(baselineAudioPath), { recursive: true });
  await fs.writeFile(path.join(baselineEpisodeDir, "script_clean.md"), scriptText, "utf8");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "anullsrc=r=24000:cl=mono",
    "-t", "4",
    "-c:a", "aac",
    "-b:a", "96k",
    baselineAudioPath,
  ]);
  const baselineAudioHash = sha256(await fs.readFile(baselineAudioPath));
  const baselineWords = scriptText
    .split(/\s+/)
    .map((word, index) => ({
      index,
      word,
      start_sec: Number((index * 0.3).toFixed(3)),
      end_sec: Number((index * 0.3 + 0.24).toFixed(3)),
    }));
  await writeJson(path.join(baselineEpisodeDir, "narration_word_timing_ep_01.json"), {
    schema: "goldflow_narration_word_timing_v1",
    status: "passed",
    source_script_hash: scriptHash,
    narration_audio_path: baselineAudioPath,
    narration_audio_hash: baselineAudioHash,
    audio_duration_sec: 4,
    word_count: baselineWords.length,
    words: baselineWords,
  });
  await writeJson(path.join(baselineEpisodeDir, "longform_audio_bed_report_ep_01.json"), {
    schema: "goldflow_longform_audio_bed_v1",
    status: "completed",
    narration_only: true,
    mix: {
      m4a_path: baselineAudioPath,
      final_audio_sha256: baselineAudioHash,
    },
  });

  const proofScope = {
    mode: "bounded",
    start_sec: 0,
    end_sec: 2.1,
    label: "proof_0_2.1",
  };
  const writeUpstreamGates = async (episodeDir) => {
    await fs.mkdir(episodeDir, { recursive: true });
    await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
    await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
    await writeJson(path.join(episodeDir, "operator_script_approval.json"), {
      operator_approved: true,
      script_clean_hash: scriptHash,
    });
    await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
    await writeJson(path.join(episodeDir, "script_pace_report.json"), {
      status: "passed",
      source_script_hash: scriptHash,
      target_wpm_min: 195,
      target_wpm_max: 220,
    });
    await writeJson(path.join(episodeDir, "script_speakability_report.json"), {
      status: "passed",
      source_script_hash: scriptHash,
    });
    await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), {
      status: "passed",
      source_script_hash: scriptHash,
      replacements: [],
    });
    await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), {
      status: "passed",
      source_script_hash: scriptHash,
    });
    await writeJson(path.join(episodeDir, "story_fact_ledger.json"), {
      status: "passed",
      source_script_hash: scriptHash,
    });
  };
  const importBaseline = async (episodeDir, week) => execFileAsync(process.execPath, [
    "scripts/proof-baseline-import.mjs",
    "--episode-dir", episodeDir,
    "--baseline-episode-dir", baselineEpisodeDir,
    "--channel", "test",
    "--series", "series",
    "--week", week,
    "--episode", "ep_01",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const statusFor = async (episodeDir) => {
    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/run-status.mjs",
      "--episode-dir", episodeDir,
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
    return JSON.parse(stdout);
  };

  await writeUpstreamGates(genericEpisodeDir);
  const voiceProviderOptions = defaultNarrationVoiceProviderOptions({
    provider: "kokoro_local",
    fallbackProvider: "qwen_local",
    voiceId: "am_puck",
    nativeSpeed: 1.2,
  });
  const genericIdentity = {
    schema: "goldflow_run_identity_v2",
    channel: "test",
    series_slug: "series",
    week: "generic-proof",
    episode: "ep_01",
    run_intent: "proof",
    proof_scope: proofScope,
    audio_target: "narrator_only",
    image_provider: "modelslab",
    tts_provider: "kokoro_local",
    tts_fallback_provider: "qwen_local",
    narrator_voice_id: "am_puck",
    tts_native_speed: 1.2,
    voice_provider_options: voiceProviderOptions,
    provider_locks: {
      tts_provider: "kokoro_local",
      tts_fallback_provider: "qwen_local",
      narrator_voice_id: "am_puck",
      tts_native_speed: 1.2,
      fallback_voice_identity: QWEN_LOCAL_FALLBACK_LOCK.reference_voice_id,
      fallback_reference_audio_sha256: QWEN_LOCAL_FALLBACK_LOCK.reference_audio_sha256,
      fallback_reference_metadata_sha256: QWEN_LOCAL_FALLBACK_LOCK.reference_metadata_sha256,
      fallback_similarity_model_sha256:
        QWEN_LOCAL_FALLBACK_LOCK.speaker_similarity_model_sha256,
      fallback_similarity_calibration_sha256:
        QWEN_LOCAL_FALLBACK_LOCK.speaker_similarity_calibration_sha256,
      fallback_minimum_cosine_similarity:
        QWEN_LOCAL_FALLBACK_LOCK.minimum_cosine_similarity,
      fallback_warning_below_cosine_similarity:
        QWEN_LOCAL_FALLBACK_LOCK.warning_below_cosine_similarity,
    },
    model_versions: {
      tts_model: KOKORO_MODEL_LOCK.model_id,
      tts_model_revision: KOKORO_MODEL_LOCK.model_revision,
      fallback_tts_model: QWEN_LOCAL_FALLBACK_LOCK.model_id,
      fallback_tts_model_revision: QWEN_LOCAL_FALLBACK_LOCK.model_revision,
    },
  };
  assert.equal(proofBaselineArtifactContractForTests(genericIdentity), "canonical_narration");
  await writeJson(path.join(genericEpisodeDir, "run_identity.json"), genericIdentity);
  await importBaseline(genericEpisodeDir, "generic-proof");

  const genericImportReport = await readJson(path.join(genericEpisodeDir, "proof_baseline_import_ep_01.json"));
  const genericPlan = await readJson(path.join(genericEpisodeDir, "narration_generation_plan.json"));
  const genericTts = await readJson(path.join(genericEpisodeDir, "narration_tts_report_ep_01.json"));
  const genericUnitQa = await readJson(path.join(genericEpisodeDir, "narration_tts_unit_qa_ep_01.json"));
  const genericFullQa = await readJson(path.join(genericEpisodeDir, "narration_full_stream_qa_ep_01.json"));
  const genericStitch = await readJson(path.join(genericEpisodeDir, "audio_stitch_report_ep_01-narration.json"));
  const genericTiming = await readJson(path.join(genericEpisodeDir, "narration_word_timing_ep_01.json"));
  assert.equal(genericImportReport.schema, "goldflow_proof_baseline_import_v2");
  assert.equal(genericImportReport.artifact_contract, "canonical_narration");
  assert.equal(genericImportReport.synthesis_performed, false);
  assert.equal(genericImportReport.provider_calls, 0);
  assert.equal(genericPlan.artifact_mode, "audited_baseline_import");
  assert.equal(genericPlan.configured_provider_contract.primary_provider, "kokoro_local");
  assert.equal(genericPlan.synthesis_performed, false);
  assert.equal(genericTts.configured_primary_provider, "kokoro_local");
  assert.equal(genericTts.primary_provider, undefined);
  assert.equal(genericTts.synthesis_performed, false);
  assert.equal(genericTts.results[0].selected_provider, "imported_audited_baseline");
  assert.equal(genericUnitQa.qa_mode, "baseline_audio_and_whisper_provenance");
  assert.equal(genericFullQa.transcript_source, "baseline_local_whisper_word_timing");
  assert.equal(genericStitch.stitch_performed, false);
  assert.equal(genericStitch.segments[0].selected_provider, "imported_audited_baseline");
  assert.equal(genericStitch.segments[0].voice_id, undefined);
  assert.equal(genericTiming.full_stream_transcript_qa.status, "passed");
  assert.equal(genericTiming.narration_report_path, path.join(genericEpisodeDir, "audio_stitch_report_ep_01-narration.json"));
  assert.equal(
    await fs.stat(path.join(genericEpisodeDir, "modelslab_qwen_tts_report_ep_01.json")).then(() => true).catch(() => false),
    false,
  );
  let genericStatus = await statusFor(genericEpisodeDir);
  assert.equal(genericStatus.current_stage, "audio_pace_check");
  assert.equal(genericStatus.stage_ledger.find((row) => row.stage === "voice_plan").exists, true);
  assert.match(genericStatus.stage_ledger.find((row) => row.stage === "voice_plan").evidence, /audited bounded baseline import/);
  assert.equal(genericStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch").exists, true);
  assert.match(genericStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch").evidence, /synthesis_performed=false/);
  assert.equal(genericStatus.stage_ledger.find((row) => row.stage === "local_whisper_word_timing").exists, true);

  await writeJson(path.join(genericEpisodeDir, "narration_tts_report_ep_01.json"), {
    ...genericTts,
    proof_baseline_provenance_sha256: "tampered",
  });
  genericStatus = await statusFor(genericEpisodeDir);
  assert.equal(genericStatus.current_stage, "qwen_tts_stitch");
  assert.match(
    genericStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch").evidence,
    /provenance hash missing or stale|hash differs from proof import report/,
  );

  await writeUpstreamGates(legacyEpisodeDir);
  const legacyIdentity = {
    schema: "goldflow_run_identity_v2",
    channel: "test",
    series_slug: "series",
    week: "legacy-proof",
    episode: "ep_01",
    run_intent: "proof",
    proof_scope: proofScope,
    audio_target: "narrator_only",
    image_provider: "modelslab",
    qwen_native_speed: 1.25,
    qwen_narrator_voice_id: "joel_owned_narrator_clone",
    qwen_narrator_voice_policy: "default_joel_owned_narrator_clone",
    voice_provider_options: {
      qwen_native_speed: 1.25,
      qwen_narrator_voice_id: "joel_owned_narrator_clone",
      qwen_narrator_voice_policy: "default_joel_owned_narrator_clone",
    },
    provider_locks: {
      qwen_narrator_voice_id: "joel_owned_narrator_clone",
    },
    model_versions: {
      tts_model: "qwen-tts",
    },
  };
  assert.equal(proofBaselineArtifactContractForTests(legacyIdentity), "legacy_qwen");
  await writeJson(path.join(legacyEpisodeDir, "run_identity.json"), legacyIdentity);
  await importBaseline(legacyEpisodeDir, "legacy-proof");
  const legacyImportReport = await readJson(path.join(legacyEpisodeDir, "proof_baseline_import_ep_01.json"));
  assert.equal(legacyImportReport.artifact_contract, "legacy_qwen");
  assert.equal(legacyImportReport.synthesis_performed, false);
  assert.equal(
    await fs.stat(path.join(legacyEpisodeDir, "qwen_generation_plan.json")).then(() => true).catch(() => false),
    true,
  );
  assert.equal(
    await fs.stat(path.join(legacyEpisodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json")).then(() => true).catch(() => false),
    true,
  );
  assert.equal(
    await fs.stat(path.join(legacyEpisodeDir, "narration_tts_report_ep_01.json")).then(() => true).catch(() => false),
    false,
  );
  const legacyStatus = await statusFor(legacyEpisodeDir);
  assert.equal(legacyStatus.current_stage, "audio_pace_check");
  assert.equal(legacyStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch").exists, true);
  assert.equal(legacyStatus.stage_ledger.find((row) => row.stage === "local_whisper_word_timing").exists, true);
}

function testSemanticReconciliationEvidenceContract() {
  const script = "Joey entered Analytics Hall. He carried the silver key. Joey left for the roof.";
  const prompt = semanticReconciliationPromptForTests(script, {}, [{
    chunk: { chunk_index: 1, word_start_index: 0, word_end_index_exclusive: 13, overlap_words: 0 },
    llm: { parsed: { scenes: [] } },
  }], { target: 2, minimum: 1, maximum: 3 });
  assert.match(prompt, /evidence reconciliation, not story invention/i);
  assert.match(prompt, /exact_excerpt copied verbatim/i);
  assert.match(prompt, /Overlapping chunks intentionally repeat evidence/i);
  assert.match(prompt, /nonhuman actor/i);
  assert.match(prompt, /person\|creature\|construct\|creature_group\|group\|organization/i);
  assert.match(prompt, /alternate name or short descriptive label/i);
  assert.match(prompt, /canonical_props[^\n]+aliases/i);
  assert.match(prompt, /canonical_ui_motifs[^\n]+aliases/i);
  assert.doesNotMatch(prompt, /OVERLAPPING EXTRACTIONS:\n\[\n  \{/);
  const oversizedPrompt = semanticReconciliationPromptForTests("A".repeat(900_001), {}, [{
    chunk: { chunk_index: 1, word_start_index: 0, word_end_index_exclusive: 1, overlap_words: 0 },
    llm: { parsed: { scenes: [] } },
  }], { target: 1, minimum: 1, maximum: 1 });
  assert.match(oversizedPrompt, /LOCKED SCRIPT OMITTED FROM THIS OVERSIZED RECONCILIATION PACKET/);
  assert.ok(oversizedPrompt.length < 100_000);
  assert.equal(sanitizeCanonicalIdForTests("academy_evacu\u200bation_fork"), "academy_evacuation_fork");
  const valid = {
    canonical_entities: [{ entity_id: "joey", evidence: [{ exact_excerpt: "Joey entered Analytics Hall.", confidence: 0.99 }] }],
    canonical_locations: [{ location_id: "analytics_hall", evidence: [{ exact_excerpt: "Analytics Hall", confidence: 0.95 }] }],
    canonical_props: [{ prop_id: "silver_key", evidence: [{ exact_excerpt: "silver key", confidence: 0.9 }] }],
    canonical_ui_motifs: [],
    state_transitions: [{
      entity_id: "joey",
      transition_evidence_excerpt: "Joey left for the roof.",
      evidence: [{ exact_excerpt: "Joey left for the roof.", confidence: 0.9 }],
    }],
  };
  assert.deepEqual(storyFactEvidenceFindingsForTests(valid, script), []);
  const invalid = structuredClone(valid);
  invalid.canonical_props[0].evidence[0] = { exact_excerpt: "gold key", confidence: 2 };
  const findings = storyFactEvidenceFindingsForTests(invalid, script);
  assert.equal(findings.some((finding) => finding.code === "fact_evidence_not_exact"), true);
  assert.equal(findings.some((finding) => finding.code === "fact_confidence_invalid"), true);
  const missingBoundary = structuredClone(valid);
  delete missingBoundary.state_transitions[0].transition_evidence_excerpt;
  assert.equal(storyFactEvidenceFindingsForTests(missingBoundary, script).some((finding) => finding.code === "state_transition_evidence_not_exact"), true);
}

function testSemanticCanonicalizesDistinctVisibleActors() {
  const scenes = [{
    scene_id: "scene_001",
    primary_subject: "the final guardian",
    visible_subjects: ["the final guardian", "ordinary monsters"],
  }, {
    scene_id: "scene_002",
    primary_subject: "Crown Ram",
    visible_subjects: ["Crown Ram"],
  }];
  const missing = canonicalVisibleEntityCoverageFindingsForTests({ canonical_entities: [] }, scenes);
  assert.deepEqual(new Set(missing.map((finding) => finding.subject)), new Set(["the final guardian", "Crown Ram"]));
  assert.equal(missing.every((finding) => finding.code === "canonical_visible_actor_missing"), true);
  assert.equal(missing.some((finding) => finding.subject === "ordinary monsters"), false);
  const covered = canonicalVisibleEntityCoverageFindingsForTests({
    canonical_entities: [
      { entity_id: "bell_guardian", display_name: "Bell Guardian", aliases: ["the final guardian"] },
      { entity_id: "crown_ram", display_name: "Crown Ram", aliases: [] },
    ],
  }, scenes);
  assert.deepEqual(covered, []);
}

function testEditorialBeatDirectorContracts() {
  const script = [
    "Joey enters the hall with calm eyes.",
    "Joey opens the blue system panel slowly.",
    "Joey changes into a black academy coat.",
    "Joey faces Victor beside the exam platform.",
  ].join(" ");
  const spoken = [...script.matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)].map((match, index) => ({
    index,
    word: match[0],
    normalized: match[0].toLowerCase(),
    start_sec: Number((index * 0.4).toFixed(3)),
    end_sec: Number(((index + 1) * 0.4).toFixed(3)),
  }));
  const timedScenes = [{
    scene_id: "scene_001",
    start_sec: 0,
    end_sec: spoken.at(-1).end_sec,
    location: "Academy Exam Hall",
    visible_subjects: ["Joey", "Victor"],
    character_states: [
      { character: "Joey", wardrobe: "plain gray student shirt", visible_state: "calm eyes" },
      { character: "Victor", wardrobe: "Not specified." },
    ],
  }];
  const ledger = {
    canonical_entities: [
      { entity_id: "joey", display_name: "Joey", aliases: [] },
      { entity_id: "victor", display_name: "Victor", aliases: [] },
    ],
    canonical_locations: [{ location_id: "academy_exam\u200b_hall", display_name: "Academy Exam Hall", aliases: [] }],
    canonical_props: [{ prop_id: "silver_key", display_name: "Silver Key", aliases: ["silver key"] }],
    canonical_ui_motifs: [{ ui_id: "blue_system_panel", display_name: "Blue System Panel", aliases: ["blue system panel"] }],
    state_transitions: [
      {
        entity_id: "joey",
        state_kind: "wardrobe",
        from_state: "plain gray student shirt",
        to_state: "black academy coat",
        transition_evidence_excerpt: "Joey opens the blue system panel slowly. Joey changes into a black academy coat.",
        evidence: [{ exact_excerpt: "Joey opens the blue system panel slowly. Joey changes into a black academy coat.", confidence: 1 }],
      },
      {
        entity_id: "joey",
        state_kind: "status",
        from_state: "waiting for the exam challenge",
        to_state: "facing Victor at the exam platform",
        transition_evidence_excerpt: "Joey faces Victor beside the exam platform.",
        evidence: [
          { exact_excerpt: "Joey enters the hall with calm eyes.", confidence: 1 },
          { exact_excerpt: "Joey faces Victor beside the exam platform.", confidence: 1 },
        ],
      },
      {
        entity_id: "joey",
        state_kind: "possession",
        from_state: "Not holding the silver key",
        to_state: "Briefly holding the silver key",
        transition_evidence_excerpt: "Joey opens the blue system panel slowly.",
        evidence: [{ exact_excerpt: "Joey opens the blue system panel slowly.", confidence: 1 }],
      },
    ],
  };
  const atoms = buildTranscriptAtoms(script, spoken, timedScenes, ledger);
  assert.equal(atoms.length, 4);
  assert.equal(atoms[0].source_word_start_index, 0);
  assert.equal(atoms.at(-1).source_word_end_index, spoken.length - 1);
  assert.equal(atoms[1].transition_barrier_before, true);
  assert.equal(atoms[3].transition_barrier_before, true);
  const raw = {
    beats: atoms.map((atom, index) => ({
      source_atom_ids: [atom.atom_id],
      visual_job: index === 1 ? "system_reveal" : "story_progression",
      shot_job: index === 1 ? "ui_reveal" : "interaction",
      depiction_mode: "current_reality",
      location_id: "academy_exam\u200b_hall",
      physically_visible_entity_ids: index === 3 ? ["joey", "victor"] : ["joey"],
      screen_visible_entity_ids: [],
      preview_visible_entity_ids: [],
      mentioned_only_entity_ids: [],
      primary_entity_id: "joey",
      entity_evidence: index === 3 ? { joey: "JOEY", victor: "VICTOR" } : { joey: "JOEY" },
      props: index === 0 ? [{ prop_id: "silver_key", type: "personal_item", name: "silver key" }] : [],
      ui_elements: index === 1 ? [{ ui_id: "blue_system_panel", type: "system_window", text: "blue system panel" }] : [],
      background_population: index === 0 ? {
        presence: "implied",
        description: "exam candidates waiting in the hall",
        evidence: atom.text,
        staging: "small seated groups behind Joey, subordinate to his entrance",
      } : {
        presence: "none",
      },
      foreground_action: atom.text,
      foreground_action_evidence: atom.text,
      composition_intent: "Keep the named action and spatial relationship readable.",
      continuity_note: "",
      visual_information_delta: {
        kind: index === 0 ? "new_location_or_geography" : "new_action_or_contact",
        statement: `Show new visual information for atom ${index + 1}.`,
        compared_to_previous: index === 0
          ? "This is the first establishing image."
          : "The visible action advances beyond the prior atom.",
      },
      sequence_grammar: {
        shot_size: ["wide", "insert", "medium", "close"][index],
        camera_angle: "evidence-led level angle",
        vantage: "camera side preserving the scene axis",
        sequence_role: ["establish", "reveal", "advance", "react"][index],
      },
      spatial_continuity: {
        eyeline_axis: "Joey toward the visible action",
        primary_screen_position: "Joey center-left",
        primary_facing: "screen_right",
        threat_or_counterparty_position: index === 3 ? "Victor screen-right" : "not_applicable",
        travel_direction: "stationary",
        object_geography: index === 0 ? "silver key at Joey's hand" : "not_applicable",
        intentional_axis_break: false,
        axis_break_reason: null,
      },
      beat_value: {
        tier: index === 1 ? "priority" : "connective",
        moment_types: [],
        reason: index === 1 ? "The system reveal changes understanding." : "Clear causal connective coverage.",
      },
      retention_reset: {
        kind: index === 1 ? "story_earned" : "none",
        evidence_ids: [],
        purpose: index === 1 ? "The system reveal creates a new question." : "No additional reset is required.",
      },
      audiovisual_intent: {
        motion_role: index === 1 ? "changes_understanding" : "supports_clarity",
        sfx_event: null,
        score_behavior: "no_change",
        silence_behavior: "not_required",
        subtitle_emphasis: [],
        coordination_note: "Keep the narration dominant and reinforce only the visible story change.",
      },
      editorial_cues: [],
      rail_exception: null,
    })),
  };
  const normalized = normalizeEditorialGrouping(raw, atoms, ledger, "ep_01");
  assert.equal(normalized.beats[0].visual_beat_id.startsWith("beat_w"), true);
  assert.equal(normalized.beats[0].location_id, "academy_exam_hall");
  assert.equal(normalized.beats[0].image_id_hint.startsWith("ep_01-w"), true);
  assert.deepEqual(normalized.beats[0].local_props, ["silver key"]);
  assert.deepEqual(normalized.beats[1].local_ui_elements, ["blue system panel"]);
  assert.deepEqual(normalized.beats[0].local_prop_ids, ["silver_key"]);
  assert.deepEqual(normalized.beats[1].local_ui_ids, ["blue_system_panel"]);
  assert.equal(normalized.beats[0].background_population.presence, "implied");
  assert.equal(normalized.beats[1].background_population.presence, "none");
  assert.deepEqual(editorialBeatCoverageFindings(normalized.beats, spoken.length), []);
  assert.deepEqual(editorialRetentionRailFindings(closeVisualBeatTimelineForTests(normalized.beats, spoken.at(-1).end_sec)), []);
  const lockedBeats = normalized.beats.map((beat, index) => ({
    ...beat,
    visual_beat_id: `locked_beat_${index + 1}`,
    image_id_hint: `locked_image_${index + 1}`,
  }));
  const freshAtoms = atoms.map((atom, index) => {
    const insertedWordShift = index > 1 ? 1 : 0;
    const expandedAtomEnd = index === 1 ? 1 : 0;
    const sourceWordStart = atom.source_word_start_index + insertedWordShift;
    const sourceWordEnd = atom.source_word_end_index + insertedWordShift + expandedAtomEnd;
    return {
      ...atom,
      ...(index === 2 ? {
        scene_id: "scene_repaired",
        semantic_location: "repaired hall",
        semantic_scene: { scene_id: "scene_repaired", location: "repaired hall" },
      } : {}),
      atom_id: `atom_w${String(sourceWordStart).padStart(6, "0")}_w${String(sourceWordEnd).padStart(6, "0")}`,
      source_word_start_index: sourceWordStart,
      source_word_end_index: sourceWordEnd,
      start_sec: Number((atom.start_sec + (index > 1 ? 0.2 : 0)).toFixed(3)),
      end_sec: Number((atom.end_sec + (index > 0 ? 0.2 : 0)).toFixed(3)),
    };
  });
  const retimedLocked = retimeLockedEditorialBeats(lockedBeats, freshAtoms);
  assert.deepEqual(retimedLocked.map((beat) => beat.visual_beat_id), lockedBeats.map((beat) => beat.visual_beat_id));
  assert.deepEqual(retimedLocked.map((beat) => beat.image_id_hint), lockedBeats.map((beat) => beat.image_id_hint));
  assert.notDeepEqual(retimedLocked.flatMap((beat) => beat.source_atom_ids), lockedBeats.flatMap((beat) => beat.source_atom_ids));
  assert.equal(retimedLocked[1].source_word_end_index, lockedBeats[1].source_word_end_index + 1);
  assert.equal(retimedLocked[2].source_word_start_index, lockedBeats[2].source_word_start_index + 1);
  assert.equal(retimedLocked[2].scene_id, "scene_repaired");
  assert.equal(retimedLocked[2].parent_scene_id, "scene_repaired");
  assert.equal(retimedLocked[2].timing_repair.repaired_scene_id, "scene_repaired");
  assert.equal(retimedLocked.every((beat) => beat.timing_repair.identity_preserved), true);
  assert.throws(() => retimeLockedEditorialBeats(lockedBeats, freshAtoms.slice(1)), /atom count changed/i);
  const projected = projectActiveStateConstraints(normalized.beats, atoms, ledger, timedScenes);
  assert.equal(projected[0].active_state_constraints.entities.joey.wardrobe, "plain gray student shirt");
  assert.equal(projected[0].active_state_constraints.entities.joey.visible_state, undefined);
  assert.equal(projected[0].active_state_constraints.entities.joey.status, undefined);
  assert.equal(projected[0].active_state_constraints.entities.joey.possession, undefined);
  assert.equal(projected[1].active_state_constraints.entities.joey.wardrobe, "plain gray student shirt");
  assert.equal(projected[1].active_state_constraints.entities.joey.possession, "Briefly holding the silver key");
  assert.equal(projected[2].active_state_constraints.entities.joey.wardrobe, "black academy coat");
  assert.equal(projected[2].active_state_constraints.entities.joey.possession, undefined);
  assert.equal(projected[3].active_state_constraints.entities.joey.status, "facing Victor at the exam platform");
  assert.equal(projected[3].active_state_constraints.entities.victor.wardrobe, undefined);
  assert.equal(projected[0].active_state_constraints.entities.joey.state_evidence, undefined);
  assert.equal(projected[3].active_state_constraints.entities.joey.state_evidence.status, "Joey faces Victor beside the exam platform.");
  const invalid = structuredClone(raw);
  invalid.beats = [{ ...raw.beats[0], source_atom_ids: [atoms[0].atom_id, atoms[1].atom_id], rail_exception: "mandatory transition" }, raw.beats[2], raw.beats[3]];
  assert.throws(() => normalizeEditorialGrouping(invalid, atoms, ledger, "ep_01"), /editorial beat contract failed/i);
  const missingActionEvidence = structuredClone(raw);
  delete missingActionEvidence.beats[0].foreground_action_evidence;
  const missingActionEvidenceNormalized = normalizeEditorialGrouping(missingActionEvidence, atoms, ledger, "ep_01");
  assert.equal(missingActionEvidenceNormalized.findings.some((finding) => finding.code === "editorial_foreground_action_evidence_missing" && finding.severity === "warning"), true);
  const pauseInflated = structuredClone(atoms);
  pauseInflated[1].start_sec = 5;
  pauseInflated[1].end_sec = Math.max(5.4, pauseInflated[1].end_sec + 2);
  const pauseInflatedNormalized = normalizeEditorialGrouping(raw, pauseInflated, ledger, "ep_01");
  assert.equal(pauseInflatedNormalized.findings.some((finding) => (
    finding.code === "editorial_retention_timing_goal_miss" && finding.severity === "warning"
  )), true);
  const fourSecondAtom = {
    ...atoms[0],
    start_sec: 1300,
    end_sec: 1304,
    duration_sec: 4,
    transition_barrier_before: false,
  };
  const fourSecondRaw = { beats: [{ ...raw.beats[0], source_atom_ids: [fourSecondAtom.atom_id] }] };
  const fourSecondNormalized = normalizeEditorialGrouping(fourSecondRaw, [fourSecondAtom], ledger, "ep_01");
  assert.equal(fourSecondNormalized.beats[0].duration_sec, 4);
  assert.equal(fourSecondNormalized.findings.some((finding) => (
    finding.code === "editorial_retention_timing_goal_miss" && finding.severity === "warning"
  )), true);
  const fourSecondAppliedFinding = editorialRetentionRailFindings(fourSecondNormalized.beats)[0];
  assert.equal(fourSecondAppliedFinding.severity, "warning");
  assert.equal(fourSecondAppliedFinding.code, "editorial_applied_hold_timing_goal_miss");
  const prompt = buildEditorialDirectorPrompt(atoms, ledger, timedScenes);
  assert.match(prompt, /You own visual job, depiction mode/i);
  assert.match(prompt, /Never merge across an atom with transition_barrier_before=true/i);
  assert.match(prompt, /Retention timing is an editorial goal, never a validity gate/i);
  assert.match(prompt, /a 4-second beat is valid in any band/i);
  assert.match(prompt, /nonhuman actor/i);
  assert.match(prompt, /CANONICAL PROPS:/);
  assert.match(prompt, /CANONICAL UI MOTIFS:/);
  assert.match(prompt, /exact prop_id or ui_id/i);
  assert.match(prompt, /You own background population and its depiction for each beat/i);
  assert.match(prompt, /You decide how many supported participants are individually readable/i);
  assert.match(prompt, /There is no default crowd treatment based on location or scene type/i);
  assert.doesNotMatch(prompt, /at most three individually readable foreground actors/i);
  assert.match(prompt, /Do not expand a collective phrase/i);
  assert.match(prompt, /ANIMATION MODE IS DISABLED/);
  assert.doesNotMatch(prompt, /"animation_intent": \{/);
  const animationPrompt = buildEditorialDirectorPrompt(atoms, ledger, timedScenes, { animationEnabled: true });
  assert.match(animationPrompt, /ANIMATION MODE IS LOCKED/);
  assert.match(animationPrompt, /"animation_intent": \{/);
  assert.match(animationPrompt, /UI\/screen shots remain eligible/);
  assert.deepEqual(retentionRailForTime(0), { band: "0_30", min_sec: 2.2, max_sec: 4.5 });
  assert.deepEqual(retentionRailForTime(1300), { band: "1200_plus", min_sec: 7, max_sec: 15 });
  const densityWarnings = retentionBeatDensityFindingsForTests([
    { start_sec: 0, end_sec: 30, duration_sec: 30 },
    { start_sec: 30, end_sec: 180, duration_sec: 150 },
  ]);
  assert.equal(densityWarnings.every((finding) => finding.severity === "warning"), true);
  assert.equal(densityWarnings.some((finding) => finding.code === "hook_beat_density_goal_miss"), true);
  assert.equal(densityWarnings.some((finding) => finding.code === "retention_ramp_beat_density_goal_miss"), true);
  const recoveryMerged = mergeEditorialRecoveryBeatsForTests(
    [normalized.beats[0], normalized.beats[2]],
    [normalized.beats[1], normalized.beats[3]],
  );
  assert.deepEqual(recoveryMerged.map((beat) => beat.visual_beat_id), normalized.beats.map((beat) => beat.visual_beat_id));
  assert.throws(() => mergeEditorialRecoveryBeatsForTests([normalized.beats[0]], [normalized.beats[0]]), /duplicate beat/i);

  const multiplierScript = "The system appeared. [PROJECTED RETURN: 0X] Joey closed the laptop.";
  const multiplierTokens = ["The", "system", "appeared", "PROJECTED", "RETURN", "zero", "times", "Joey", "closed", "the", "laptop"];
  const multiplierWords = multiplierTokens.map((word, index) => ({
    index,
    word,
    normalized: word.toLowerCase(),
    start_sec: index * 0.4,
    end_sec: (index + 1) * 0.4,
  }));
  const multiplierAtoms = buildTranscriptAtoms(multiplierScript, multiplierWords, [{
    scene_id: "scene_multiplier",
    start_sec: 0,
    end_sec: multiplierWords.at(-1).end_sec,
    location: "System Room",
  }]);
  const multiplierAtom = multiplierAtoms.find((atom) => atom.text.startsWith("0X"));
  assert.equal(multiplierAtom.source_word_start_index, 5);
  assert.equal(multiplierWords[multiplierAtom.source_word_start_index].normalized, "zero");

  const driftSentences = Array.from({ length: 220 }, (_value, index) => `At checkpoint ${index}, Joey carefully acquired asset ${index} and moved forward.`);
  const driftScript = driftSentences.join(" ");
  const driftScriptTokens = [...driftScript.matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)].map((match) => match[0]);
  let carefullyCount = 0;
  const driftSpokenTokens = driftScriptTokens.filter((token) => {
    if (token.toLowerCase() !== "carefully") return true;
    carefullyCount += 1;
    return carefullyCount % 3 !== 0;
  });
  const driftWords = driftSpokenTokens.map((word, index) => ({
    index,
    word,
    normalized: word.toLowerCase(),
    start_sec: index * 0.12,
    end_sec: (index + 1) * 0.12,
  }));
  const driftAtoms = buildTranscriptAtoms(driftScript, driftWords, [{
    scene_id: "scene_drift",
    start_sec: 0,
    end_sec: driftWords.at(-1).end_sec,
    location: "Continuity Room",
  }]);
  assert.equal(driftAtoms.at(-1).source_word_end_index, driftWords.length - 1);
  assert.equal(Math.max(...driftAtoms.map((atom) => atom.duration_sec)) < 10, true);
}

function testEditorialBeatTimelineClosure() {
  const closed = closeVisualBeatTimelineForTests([
    { visual_beat_id: "beat_a", start_sec: 0, end_sec: 2.7, duration_sec: 2.7 },
    { visual_beat_id: "beat_b", start_sec: 3, end_sec: 6.5, duration_sec: 3.5 },
    { visual_beat_id: "beat_c", start_sec: 7, end_sec: 9.4, duration_sec: 2.4 },
  ], 10);
  assert.deepEqual(closed.map((beat) => [beat.start_sec, beat.end_sec, beat.duration_sec]), [
    [0, 3, 3],
    [3, 7, 4],
    [7, 10, 3],
  ]);
  assert.throws(() => closeVisualBeatTimelineForTests([
    { visual_beat_id: "beat_a", start_sec: 0 },
    { visual_beat_id: "beat_b", start_sec: 0 },
  ], 3), /non-increasing starts/i);
}

function testSemanticAnchorSnapsToExactScriptTokens() {
  const script = [
    "On Monday morning, Joey arrived with a U.S.B. drive in one hand.",
    "\"I cared.\"",
    "\"Systems outlast anger.\"",
  ].join(" ");
  const { scenes, snaps } = semanticSnapSceneAnchorsForTests([
    {
      scene_id: "scene_001",
      script_excerpt_start: "On Monday morning, Joey arrived with a U. S. B. drive in one hand.",
      script_excerpt_end: "He cared.",
    },
    {
      scene_id: "scene_002",
      script_excerpt_start: "Systems outlast anger.",
      script_excerpt_end: "Systems outlast anger.",
    },
  ], script);
  assert.equal(scenes[0].script_excerpt_start, "On Monday morning, Joey arrived with a U.S.B. drive in one hand");
  assert.equal(scenes[0].script_excerpt_end, "cared");
  assert.equal(scenes[1].script_excerpt_start, "Systems outlast anger");
  assert.equal(snaps.some((snap) => snap.snap_type === "token_suffix"), true);
}

function testFirstPersonBeatKeepsProtagonistVisible() {
  const scene = {
    scene_id: "scene_015",
    primary_subject: "Dorian Vale",
    visible_subjects: ["Dorian Vale"],
    ref_requirements: [
      { kind: "character", ref_id: "joey_manhwa", reason: "recurring protagonist visible during punishment" },
      { kind: "character", ref_id: "dorian_vale", reason: "named antagonist undergoes punishment" },
    ],
  };
  const beatText = "Dorian looked at it, then at me. This is childish. I walked around the desk.";
  const visible = visualBeatInternalsForTests.localVisibleCharacters(scene, beatText);
  assert.deepEqual(visible, ["Joey Manhwa", "Dorian Vale"]);
  const refNeeds = visualBeatInternalsForTests.localBeatReferenceNeeds(scene, {
    scene_id: "scene_015",
    parent_scene_id: "scene_015",
    visual_beat_id: "scene_015_beat_02",
    start_sec: 758.66,
    visual_beat_script_excerpt: beatText,
    visual_job: "interaction",
    suggested_shot_job: "interaction",
  }, { visibleCharacters: visible });
  const characterRefIds = refNeeds.filter((need) => need.kind === "character").map((need) => need.ref_id);
  assert.deepEqual(new Set(characterRefIds), new Set(["joey_manhwa", "dorian_vale"]));
}

function testWhisperExcerptAlignmentInterpolatesUnspokenUi() {
  const result = alignExcerptRowsToWhisper([
    { visual_beat_id: "beat_1", start_sec: 0, end_sec: 2, duration_sec: 2, visual_beat_script_excerpt: "Joey entered the academy gate in the rain." },
    { visual_beat_id: "beat_2", start_sec: 2, end_sec: 4, duration_sec: 2, visual_beat_script_excerpt: "Role assigned Extra 418. Importance disposable." },
    { visual_beat_id: "beat_3", start_sec: 4, end_sec: 6, duration_sec: 2, visual_beat_script_excerpt: "A knight screamed for every candidate to run left." },
  ], [
    { word: "Joey", start_sec: 0 }, { word: "entered", start_sec: 0.2 }, { word: "the", start_sec: 0.4 }, { word: "academy", start_sec: 0.6 }, { word: "gate", start_sec: 0.8 }, { word: "in", start_sec: 1 }, { word: "the", start_sec: 1.2 }, { word: "rain", start_sec: 1.4 },
    { word: "A", start_sec: 3 }, { word: "knight", start_sec: 3.2 }, { word: "screamed", start_sec: 3.4 }, { word: "for", start_sec: 3.6 }, { word: "every", start_sec: 3.8 }, { word: "candidate", start_sec: 4 }, { word: "to", start_sec: 4.2 }, { word: "run", start_sec: 4.4 }, { word: "left", start_sec: 4.6 },
  ], { minimumScore: 0.75 });
  assert.equal(result.summary.matched_count, 2);
  assert.equal(result.summary.interpolated_count, 1);
  assert.equal(result.rows[0].start_sec, 0);
  assert.equal(result.rows[1].start_sec > 0 && result.rows[1].start_sec < 3, true);
  assert.equal(result.rows[2].start_sec, 3.2);
  assert.equal(result.rows[1].whisper_excerpt_alignment.status, "interpolated_unspoken_or_low_confidence");
}

function testPhraseAwareSubtitleGrouping() {
  const coalescedCollapsedTiming = coalesceOverlappingSubtitleEventsForTests([
    { start_sec: 10, end_sec: 10.01, text: "Mm." },
    { start_sec: 10, end_sec: 10.66, text: "A pause." },
    { start_sec: 10.66, end_sec: 11.2, text: "Then she spoke." },
  ]);
  assert.deepEqual(coalescedCollapsedTiming, [
    { start_sec: 10, end_sec: 10.66, text: "Mm. A pause." },
    { start_sec: 10.66, end_sec: 11.2, text: "Then she spoke." },
  ]);

  const merged = mergeShortSubtitleEvents([
    { start_sec: 0, end_sec: 0.45, text: "The" },
    { start_sec: 0.46, end_sec: 1.75, text: "system opened" },
    { start_sec: 1.9, end_sec: 2.2, text: "No!" },
    { start_sec: 2.45, end_sec: 2.78, text: "And" },
    { start_sec: 2.79, end_sec: 4.0, text: "then I ran" },
  ]);
  assert.deepEqual(merged.map((row) => row.text), ["The system opened", "No!", "And then I ran"]);
  assert.equal(merged.filter((row) => row.text.split(/\s+/).length === 1).length, 1);
  const completedPhrases = mergeShortSubtitleEvents([
    { start_sec: 0, end_sec: 1.8, text: "The impact cracked the arena from one side" },
    { start_sec: 1.8, end_sec: 2.4, text: "to the other," },
    { start_sec: 2.8, end_sec: 3.55, text: "Two fingers rose." },
  ]);
  assert.deepEqual(completedPhrases.map((row) => row.text), ["The impact cracked the arena from one side to the other,", "Two fingers rose."]);

  const lockedCaptionRows = buildSubtitleEventsForTests({
    words: ["The", "system", "gave", "Joey", "Manwa", "Roll", "assigned."].map((word, index) => ({
      index,
      word,
      start_sec: index * 0.25,
      end_sec: (index + 1) * 0.25,
    })),
  }, null, {
    status: "passed",
    beats: [
      { source_word_start_index: 0, source_word_end_index: 4, visual_beat_script_excerpt: "The system gave Joey Manhwa" },
      { source_word_start_index: 5, source_word_end_index: 6, visual_beat_script_excerpt: "Role assigned." },
    ],
  });
  assert.equal(lockedCaptionRows.source, "approved_visual_beat_script_text_timed_by_whisper");
  assert.equal(lockedCaptionRows.events.map((row) => row.text).join(" "), "The system gave Joey Manhwa Role assigned.");
  assert.doesNotMatch(lockedCaptionRows.events.map((row) => row.text).join(" "), /Manwa|Roll/);

  const repeatedSegmentUnits = buildSubtitleEventsForTests({
    words: [
      { word: "First", start_sec: 0.1, end_sec: 0.4 },
      { word: "unit.", start_sec: 0.5, end_sec: 0.9 },
      { word: "Second", start_sec: 1.1, end_sec: 1.5 },
      { word: "unit.", start_sec: 1.6, end_sec: 1.9 },
    ],
  }, {
    segments: [
      { unit_id: "u1", segment_id: "voice_seg_01", duration_sec: 1, caption_text: "First unit." },
      { unit_id: "u2", segment_id: "voice_seg_01", duration_sec: 1, caption_text: "Second unit." },
    ],
  });
  assert.equal(repeatedSegmentUnits.source, "audio_stitch_caption_text_word_aligned_to_whisper");
  assert.equal(repeatedSegmentUnits.events.map((row) => row.text).join(" "), "First unit. Second unit.");
  assert.equal(repeatedSegmentUnits.events.every((row, index, rows) => (
    row.end_sec > row.start_sec && (index === 0 || row.start_sec >= rows[index - 1].end_sec)
  )), true);

  const alignedMultiplier = alignExpandedZeroMultiplierCaptionsForTests([
    { start_sec: 178.86, end_sec: 182.18, text: "730] [RECIPROCITY RETURN:" },
    { start_sec: 183.06, end_sec: 183.84, text: "0X]" },
    { start_sec: 185.16, end_sec: 187.86, text: "Seven years." },
  ], [
    { word: ",730", start_sec: 178.86, end_sec: 179.68 },
    { word: "reciprocity", start_sec: 179.68, end_sec: 180.48 },
    { word: "return", start_sec: 180.48, end_sec: 180.96 },
    { word: "zero", start_sec: 180.96, end_sec: 181.64 },
    { word: "times.", start_sec: 181.64, end_sec: 182.18 },
    { word: "Seven", start_sec: 183.06, end_sec: 183.44 },
  ]);
  assert.deepEqual(alignedMultiplier.slice(0, 2), [
    { start_sec: 178.86, end_sec: 180.96, text: "730] [RECIPROCITY RETURN:" },
    { start_sec: 180.96, end_sec: 182.18, text: "0X]" },
  ]);
}

function testQwenKeepsBracketedUiDialogueSpeakable() {
  const spoken = ttsSafeTextForTests("[CHAPTER ZERO ACTIVATED. SURVIVE THE CARRIAGE.]");
  assert.match(spoken, /chapter zero activated/i);
  assert.match(spoken, /survive the carriage/i);
  assert.doesNotMatch(spoken, /[\[\]]/);
}

function testNarratorOnlyQwenHonorsSegmentAndInstructionBoundaries() {
  const unit = (segmentId, unitIndex, sourceSpeaker, text, qwenInstruct = "Keep a firm recap cadence.") => ({
    segment_id: segmentId,
    unit_index: unitIndex,
    speaker: "NARRATOR",
    source_speaker: sourceSpeaker,
    qwen_spoken_text: text,
    caption_text: text,
    qwen_instruct: qwenInstruct,
  });
  const plan = {
    segments: [
      {
        segment_id: "voice_seg_01",
        qwen_generation_units: [
          unit("voice_seg_01", 1, "NARRATOR", "Joey entered the crowded eastern hall and checked every locked door."),
          unit("voice_seg_01", 2, "NARRATOR", "He crossed the marble floor while the witnesses watched in silence."),
          unit("voice_seg_01", 3, "NARRATOR", "Then the warning bell rang above the gate.", "Use a precise system-warning cadence."),
        ],
      },
      {
        segment_id: "voice_seg_02",
        qwen_generation_units: [
          unit("voice_seg_02", 1, "VANESSA", "Vanessa told him to leave before the guards arrived."),
        ],
      },
    ],
  };
  const lock = { narrator_voice_id: "owned_narrator" };
  const units = collectQwenUnitsForTests(plan, lock, {
    maxCharsLimit: 420,
    minWordsLimit: 20,
    maxWordsLimit: 45,
    narratorOnly: true,
  });
  assert.equal(units.length, 1);
  assert.deepEqual(units[0].source_segment_ids, ["voice_seg_01", "voice_seg_02"]);
  assert.deepEqual(units[0].source_speakers, ["NARRATOR", "VANESSA"]);
  assert.deepEqual(units[0].authored_qwen_instructions, [
    "Keep a firm recap cadence.",
    "Use a precise system-warning cadence.",
  ]);
  assert.equal(units[0].chunk_policy.crossed_instruction_boundary, true);
  assert.equal(units[0].chunk_policy.authored_instruction_submitted, false);
  assert.match(units[0].text, /Joey entered.+Vanessa told him to leave/);
  assert.ok(units.every((row) => row.word_count <= 45));
  assert.equal(new Set(units.map((row) => row.unit_id)).size, units.length);
  assert.deepEqual(validateRegenerateUnitIdsForTests(units, [units[0].unit_id]), [units[0].unit_id]);
  assert.throws(
    () => validateRegenerateUnitIdsForTests(units, ["tts_missing_unit"]),
    /unknown unit id/,
  );

  const submittedInstructions = collectQwenUnitsForTests(plan, lock, {
    maxCharsLimit: 420,
    minWordsLimit: 20,
    maxWordsLimit: 45,
    narratorOnly: true,
    instructionField: "qwen_instruct",
  });
  assert.equal(submittedInstructions.length, 3);
  assert.equal(submittedInstructions[0].qwen_instruct, "Keep a firm recap cadence.");
  assert.equal(submittedInstructions[1].qwen_instruct, "Use a precise system-warning cadence.");
  assert.ok(submittedInstructions.every((row) => row.chunk_policy.crossed_instruction_boundary === false));
  assert.equal(new Set(submittedInstructions.map((row) => row.segment_id)).size, submittedInstructions.length);

  const captionPlan = {
    segments: [
      {
        segment_id: "voice_seg_caption_01",
        qwen_generation_units: [
          {
            ...unit(
              "voice_seg_caption_01",
              1,
              "NARRATOR",
              "The C E O approved four hundred and eighteen claims before sunrise.",
            ),
            caption_text: "The CEO approved 418 claims before sunrise.",
          },
        ],
      },
      {
        segment_id: "voice_seg_caption_02",
        qwen_generation_units: [
          {
            ...unit(
              "voice_seg_caption_02",
              1,
              "NARRATOR",
              "Then the C E O rejected forty-one percent of the appeals immediately.",
            ),
            caption_text: "Then the CEO rejected 41% of the appeals immediately.",
          },
        ],
      },
    ],
  };
  const captionUnits = collectQwenUnitsForTests(captionPlan, lock, {
    maxCharsLimit: 100,
    minWordsLimit: 6,
    maxWordsLimit: 10,
    narratorOnly: true,
  });
  assert.ok(captionUnits.length >= 2);
  assert.equal(
    captionUnits.map((row) => row.caption_text).filter(Boolean).join(" "),
    "The CEO approved 418 claims before sunrise. Then the CEO rejected 41% of the appeals immediately.",
  );
  assert.ok(captionUnits.some((row) => row.source_segment_ids.length > 1));
  assert.equal(captionUnits.some((row) => /\bC E O\b|four hundred|forty-one/i.test(row.caption_text)), false);
  assert.equal(new Set(captionUnits.map((row) => row.segment_id)).size, captionUnits.length);
}

function testQwenTtsOutputQaContracts() {
  assert.equal(
    ttsSafeTextForTests("And the mercy in that, the only mercy there is, is that you get to keep living."),
    "And the mercy in that, the only mercy there is, is that you get to keep living.",
  );
  assert.equal(ttsSafeTextForTests("That, that was the approved wording."), "That, that was the approved wording.");
  assert.deepEqual(requiredMediumQaReasonsForTests({
    speaker: "NARRATOR",
    kind: "narration",
    risk_flags: [],
  }), []);
  assert.deepEqual(requiredMediumQaReasonsForTests({
    speaker: "SYSTEM",
    kind: "narration",
  }), ["system_ui_atomic"]);
  assert.deepEqual(requiredMediumQaReasonsForTests({
    speaker: "NARRATOR",
    context_family: "system-ui",
  }), ["system_ui_atomic"]);
  assert.deepEqual(requiredMediumQaReasonsForTests({
    speaker: "NARRATOR",
    protected_terms: [{ spoken_form: "C E O" }],
  }), ["protected_term_or_value"]);
  assert.deepEqual(requiredMediumQaReasonsForTests({
    speaker: "WARNING",
    risk_flags: ["protected_term_or_value"],
    protected_values: ["forty-one percent"],
  }), ["system_ui_atomic", "protected_term_or_value"]);

  const exactTranscript = transcriptQaForTests(
    "The halo shattered and every witness stepped back.",
    "The halo shattered and every witness stepped back.",
  );
  assert.equal(exactTranscript.findings.length, 0);
  const skippedTranscript = transcriptQaForTests(
    "The halo shattered and every frightened witness stepped back from the gate.",
    "The halo shattered and stepped back from the gate.",
  );
  assert.equal(skippedTranscript.findings.some((finding) => finding.code === "tts_transcript_contiguous_words_missing"), true);
  const clippedTranscript = transcriptQaForTests(
    "The orphan crypt will repossess.",
    "The orphan crypt will",
  );
  assert.equal(clippedTranscript.findings.some((finding) => finding.code === "tts_transcript_final_word_missing"), true);
  const equivalentTranscript = transcriptQaForTests(
    "Saint Orison told the C E O that S S S rank paid forty-one percent, fifty out of fifty, and four hundred and eighteen coins.",
    "St. Orison told the CEO that SSS rank paid 41%, 50/50, and 418 coins.",
  );
  assert.equal(equivalentTranscript.word_error_rate, 0);
  assert.deepEqual(equivalentTranscript.findings, []);
  const equivalentAsrNumberNotation = transcriptQaForTests(
    "For the last hundred years, nine hundred and eleven million records covered the Seventh Forge and a man in his twenties.",
    "For the last 100 years, 911 million records covered the 7th Forge and a man in his 20s.",
  );
  assert.equal(equivalentAsrNumberNotation.word_error_rate, 0);
  assert.deepEqual(equivalentAsrNumberNotation.findings, []);
  const ordinaryItPronoun = transcriptQaForTests(
    "It took the gate, and it did not take a person.",
    "It took the gate, and it did not take a person.",
  );
  assert.equal(ordinaryItPronoun.word_error_rate, 0);
  assert.deepEqual(ordinaryItPronoun.findings, []);
  const asrContractedIDidNot = transcriptQaForTests(
    "I did not take his power.",
    "I'd not take his power.",
  );
  assert.equal(asrContractedIDidNot.word_error_rate, 0);
  assert.deepEqual(asrContractedIDidNot.findings, []);
  const asrCompoundSpacing = transcriptQaForTests(
    "New status. Deedholder.",
    "New status. Deed holder.",
  );
  assert.equal(asrCompoundSpacing.word_error_rate, 0);
  assert.deepEqual(asrCompoundSpacing.findings, []);
  const asrAdditionalCompoundSpacing = transcriptQaForTests(
    "Foreclosure and counterclaim increased the balance ten thousandfold.",
    "For closure and counter claim increased the balance 10,000 fold.",
  );
  assert.equal(asrAdditionalCompoundSpacing.word_error_rate, 0);
  assert.deepEqual(asrAdditionalCompoundSpacing.findings, []);
  const asrAfterlifeCompoundSpacing = transcriptQaForTests(
    "Afterlife treasury balance.",
    "After life treasury balance.",
  );
  assert.equal(asrAfterlifeCompoundSpacing.word_error_rate, 0);
  assert.deepEqual(asrAfterlifeCompoundSpacing.findings, []);
  const asrSeparatedDigitGroups = transcriptQaForTests(
    "Eight thousand years and ten thousand coins.",
    "8 ,000 years and 10 ,000 coins.",
  );
  assert.equal(asrSeparatedDigitGroups.word_error_rate, 0);
  assert.deepEqual(asrSeparatedDigitGroups.findings, []);
  const wrongInitialism = transcriptQaForTests(
    "The C E O approved the claim.",
    "The C O approved the claim.",
  );
  assert.equal(wrongInitialism.findings.some((finding) => finding.code === "tts_transcript_protected_value_mismatch"), true);
  const wrongNumber = transcriptQaForTests(
    "The levy was forty-one percent.",
    "The levy was 42%.",
  );
  assert.equal(wrongNumber.findings.some((finding) => finding.code === "tts_transcript_protected_value_mismatch"), true);
  const clippedOpening = transcriptQaForTests(
    "The C E O opened the final gate.",
    "opened the final gate.",
  );
  assert.equal(clippedOpening.findings.some((finding) => finding.code === "tts_transcript_opening_word_missing"), true);
  const approvedOverrideAsr = transcriptQaForTests(
    "The Mahn-wah recap became livestream video content.",
    "The Manhwa recap became live content.",
    {
      equivalentPhrases: [
        { from: "Manhwa", to: "Mahn-wah" },
        { from: "live content", to: "livestream video content" },
      ],
    },
  );
  assert.equal(approvedOverrideAsr.word_error_rate, 0);
  assert.deepEqual(approvedOverrideAsr.findings, []);
  const damagedOverride = transcriptQaForTests(
    "The Mahn-wah recap became livestream video content.",
    "recap became unrelated content.",
    {
      equivalentPhrases: [
        { from: "Manhwa", to: "Mahn-wah" },
        { from: "live content", to: "livestream video content" },
      ],
    },
  );
  assert.equal(damagedOverride.findings.some((finding) => finding.code === "tts_transcript_opening_word_missing"), true);

  const cleanMetrics = {
    sample_count: 144000,
    duration_sec: 6,
    peak_dbfs: -4,
    rms_dbfs: -22,
    clipping_sample_count: 0,
    clipping_ratio: 0,
    first_sample_dbfs: null,
    last_sample_dbfs: null,
    leading_silence_sec: 0.025,
    trailing_silence_sec: 0.09,
    tail_10ms_peak_dbfs: -70,
    tail_50ms_rms_dbfs: -65,
  };
  assert.deepEqual(audioQaFindingsForTests(cleanMetrics, { text: "Twenty words can fit inside this clean synthetic test sentence without an endpoint problem." }), []);
  const clippedMetrics = {
    ...cleanMetrics,
    last_sample_dbfs: -24,
    trailing_silence_sec: 0.002,
    tail_10ms_peak_dbfs: -21,
    tail_50ms_rms_dbfs: -25,
  };
  const audioFindings = audioQaFindingsForTests(clippedMetrics, { text: "The final word is clipped." });
  assert.equal(audioFindings.some((finding) => finding.code === "tts_audio_endpoint_discontinuity"), true);
  assert.equal(audioFindings.some((finding) => finding.code === "tts_audio_tail_not_settled"), true);
  const clickFindings = audioQaFindingsForTests({
    ...cleanMetrics,
    maximum_sample_step_dbfs: -5,
    large_sample_step_count: 1,
    maximum_isolated_impulse_dbfs: -2.5,
    isolated_impulse_count: 1,
  }, { text: "A clean line should not contain a digital impulse." });
  assert.equal(clickFindings.some((finding) => finding.code === "tts_audio_impulsive_discontinuity"), true);
  const ordinarySharpSpeech = audioQaFindingsForTests({
    ...cleanMetrics,
    maximum_sample_step_dbfs: -4,
    large_sample_step_count: 40,
    maximum_isolated_impulse_dbfs: -12,
    isolated_impulse_count: 0,
  }, { text: "Sharp consonants are not isolated digital impulses." });
  assert.equal(ordinarySharpSpeech.some((finding) => finding.code === "tts_audio_impulsive_discontinuity"), false);
  assert.equal(
    audioQaFindingsForTests({
      ...cleanMetrics,
      duration_sec: 0.46,
      sample_count: 11040,
    }, { text: "Mine." }).some((finding) => finding.code === "tts_audio_implausibly_short"),
    false,
  );
  assert.equal(
    audioQaFindingsForTests({
      ...cleanMetrics,
      duration_sec: 0.12,
      sample_count: 2880,
    }, { text: "Mine." }).some((finding) => finding.code === "tts_audio_implausibly_short"),
    true,
  );
  assert.deepEqual(
    untranscribedActiveIntervalsForTests({
      active_intervals_sec: [
        { start_sec: 0, end_sec: 0.8 },
        { start_sec: 1.3, end_sec: 1.8 },
        { start_sec: 2.2, end_sec: 3 },
      ],
    }, [
      { word: "The", start_sec: 0.1, end_sec: 0.7 },
      { word: "gate", start_sec: 2.3, end_sec: 2.9 },
    ]),
    [{ start_sec: 1.3, end_sec: 1.8, duration_sec: 0.5 }],
  );

  assert.deepEqual(
    stitchBoundaryPaddingForTests(
      { trailing_silence_sec: 0.2 },
      { leading_silence_sec: 0.2 },
      0.16,
      0.025,
    ),
    {
      sample_rate_hz: 24000,
      target_gap_sample_count: 3840,
      available_left_trailing_silence_sample_count: 600,
      available_right_leading_silence_sample_count: 600,
      retained_left_trailing_silence_sample_count: 600,
      retained_right_leading_silence_sample_count: 600,
      trimmed_left_trailing_silence_sample_count: 0,
      trimmed_right_leading_silence_sample_count: 0,
      inserted_silence_sample_count: 2640,
      effective_gap_sample_count: 3840,
      target_gap_sec: 0.16,
      retained_left_trailing_silence_sec: 0.025,
      retained_right_leading_silence_sec: 0.025,
      inserted_silence_sec: 0.11,
      effective_gap_sec: 0.16,
    },
  );
  const overRetainedPlan = stitchBoundaryPaddingForTests(
    {
      trailing_silence_sec: 0.05,
      trailing_silence_sample_count: 1200,
    },
    {
      leading_silence_sec: 0.05,
      leading_silence_sample_count: 1200,
    },
    0.08,
    0.05,
    24000,
  );
  assert.equal(overRetainedPlan.target_gap_sample_count, 1920);
  assert.equal(overRetainedPlan.retained_left_trailing_silence_sample_count, 960);
  assert.equal(overRetainedPlan.retained_right_leading_silence_sample_count, 960);
  assert.equal(overRetainedPlan.trimmed_left_trailing_silence_sample_count, 240);
  assert.equal(overRetainedPlan.trimmed_right_leading_silence_sample_count, 240);
  assert.equal(overRetainedPlan.effective_gap_sample_count, 1920);
  const previouslyPassingHundredMs = stitchEffectiveBoundaryContractForTests(
    { trailing_silence_sample_count: 1200 },
    { leading_silence_sample_count: 1200 },
    0.08,
    0,
    24000,
  );
  assert.equal(previouslyPassingHundredMs.status, "blocked");
  assert.equal(previouslyPassingHundredMs.effective_gap_sample_count, 2400);
  assert.equal(
    previouslyPassingHundredMs.blocker.code,
    "tts_join_retained_edge_silence_exceeds_target",
  );

  const authoredUnit = {
    text: "The gate opened.",
    qwen_instruct: "Land the final word cleanly with no added breath.",
  };
  const unsupported = qwenRequestForUnitForTests(authoredUnit, { init_audio: "https://example.invalid/ref.wav" }, 0);
  assert.equal(unsupported.instruction_delivery.submitted, false);
  assert.equal(unsupported.instruction_delivery.provider_support_status, "unsupported_by_current_modelslab_v6_contract_not_submitted");
  assert.equal("qwen_instruct" in unsupported.body, false);
  const supported = qwenRequestForUnitForTests(authoredUnit, { init_audio: "https://example.invalid/ref.wav" }, 0, "qwen_instruct");
  assert.equal(supported.instruction_delivery.submitted, true);
  assert.equal(supported.body.qwen_instruct, authoredUnit.qwen_instruct);

  const identityBase = synthesisIdentityForTests(
    { ...authoredUnit, voice_id: "voice_a" },
    {
      id: "voice_a",
      init_audio: "https://example.invalid/ref-a.wav",
      reference_audio_sha256: "reference-hash-a",
    },
    { speed: 1.25, instructionField: null },
  );
  const identitySame = synthesisIdentityForTests(
    { ...authoredUnit, voice_id: "voice_a" },
    {
      id: "voice_a",
      init_audio: "https://example.invalid/ref-a.wav",
      reference_audio_sha256: "reference-hash-a",
    },
    { speed: 1.25, instructionField: null },
  );
  assert.equal(identityBase.content_sha256, identitySame.content_sha256);
  for (const changed of [
    synthesisIdentityForTests(
      { ...authoredUnit, voice_id: "voice_a" },
      { id: "voice_a", init_audio: "https://example.invalid/ref-a.wav", reference_audio_sha256: "reference-hash-a" },
      { speed: 1, instructionField: null },
    ),
    synthesisIdentityForTests(
      { ...authoredUnit, qwen_instruct: "Use a different delivery.", voice_id: "voice_a" },
      { id: "voice_a", init_audio: "https://example.invalid/ref-a.wav", reference_audio_sha256: "reference-hash-a" },
      { speed: 1.25, instructionField: null },
    ),
    synthesisIdentityForTests(
      { ...authoredUnit, voice_id: "voice_a" },
      { id: "voice_a", init_audio: "https://example.invalid/ref-a.wav", reference_audio_sha256: "reference-hash-b" },
      { speed: 1.25, instructionField: null },
    ),
    synthesisIdentityForTests(
      { ...authoredUnit, voice_id: "voice_a" },
      { id: "voice_a", init_audio: "https://example.invalid/ref-b.wav", reference_audio_sha256: "reference-hash-a" },
      { speed: 1.25, instructionField: "qwen_instruct" },
    ),
  ]) {
    assert.notEqual(identityBase.content_sha256, changed.content_sha256);
  }
}

async function testEpisodeLocalAmbienceSpecContract() {
  const valid = {
    status: "approved",
    source_script_hash: "script-hash",
    ambience_specs: [{
      cue_id: "guild_hall_air",
      scene_ids: ["scene_001"],
      sound_description: "large stone guild hall room tone with distant boots and banner cloth",
      beat_reason: "grounds the current scene",
    }],
  };
  assert.deepEqual(validateAmbienceSpecForTests(valid, "script-hash", ["scene_001"]), []);
  assert.equal(validateAmbienceSpecForTests(valid, "different-hash", ["scene_001"]).includes("ambience_spec_source_hash_mismatch"), true);
  const runtime = await fs.readFile("scripts/audio-ambience-repair.mjs", "utf8");
  assert.doesNotMatch(runtime, /Northbridge|Sarah|Damien|Vivienne/);
  const historicalFixture = await fs.readFile("scripts/fixtures/audio/northbridge_ambience_spec.example.json", "utf8");
  assert.match(historicalFixture, /Northbridge/);
}

function testImageOutputQaRiskAndDonorPolicies() {
  const reasons = imageRiskReasons({
    start_sec: 420,
    visual_beat_action: "Joey lifts the carriage and rescues Arielle",
    shot_manifest: { visible_characters: ["Joey", "Arielle", "Guard"], shot_job: "physical_action" },
    reference_requirements: [{}, {}, {}, {}],
  });
  assert.equal(reasons.includes("physical_action_geometry"), true);
  assert.equal(reasons.includes("dense_cast"), true);
  assert.equal(reasons.includes("four_reference_integration"), true);
  const immutableAndEquipmentReasons = imageRiskReasons({
    start_sec: 420,
    provider_prompt: "Oren's residual left arm ends below the elbow while Joey grips one sword in his right hand.",
    shot_manifest: {
      shot_job: "physical_action",
      anatomy_contracts: [{
        entity: "Oren",
        body_invariant: "left forearm ends below elbow",
        expected_visible_hands: 1,
        prosthetic_allowed: false,
        visibility_required: true,
      }],
      equipment_contracts: [{
        owner: "Joey",
        item: "sword",
        visible_count: 1,
        hand_assignment: "right hand",
        extras_allowed: false,
      }],
    },
  });
  assert.equal(immutableAndEquipmentReasons.includes("immutable_anatomy_adherence"), true);
  assert.equal(immutableAndEquipmentReasons.includes("equipment_count_hand_and_contact_geometry"), true);
  const advisoryAnatomyPolicy = imageManualReviewPolicy({
    image_id: "oren-map",
    start_sec: 420,
    provider_prompt: "Oren's residual left arm ends below the elbow while his intact right hand takes the map.",
    shot_manifest: {
      shot_job: "interaction",
      anatomy_contracts: [{
        entity: "Oren",
        body_invariant: "left forearm ends below elbow",
        expected_visible_hands: 1,
        prosthetic_allowed: false,
        visibility_required: true,
      }],
    },
  }, [], { openingSec: 180, integrationSampleRate: 0 });
  assert.equal(advisoryAnatomyPolicy.tier, "advisory_review_log");
  assert.equal(advisoryAnatomyPolicy.requires_manual_review, false);
  const populationReasons = imageRiskReasons({
    start_sec: 420,
    shot_manifest: {
      visible_characters: ["Joey"],
      background_population: {
        presence: "implied",
        description: "silent hearing attendees",
        evidence: "the hearing turned against him",
        staging: "two restrained rows behind Joey",
      },
    },
  });
  assert.equal(populationReasons.includes("background_population"), true);
  assert.equal(donorRecoveryFinding({ donor_image_id: "cut_001", hash_perturbation: true }, "cut_002")?.code, "scene_image_donor_recovery_forbidden");
  assert.equal(donorRecoveryFinding({ editorial_reuse_approved: true, reuse_source_image_id: "cut_001" }, "cut_002"), null);

  const riskRows = [{
    image_id: "cut_001",
    image_sha256: "hash-a",
    image_path: "/tmp/cut_001.png",
    start_sec: 1,
    risk_reasons: ["opening_retention"],
    requires_manual_risk_review: true,
  }];
  const accepted = mergeRiskReviewDecisions(riskRows, {}, {
    reviewer: "fixture",
    note: "inspected exact image hash",
    acceptedIds: ["cut_001"],
  });
  assert.equal(accepted.status, "complete");
  assert.equal(accepted.decisions[0].decision, "accepted");
  const aestheticReplacement = mergeRiskReviewDecisions(riskRows, {}, {
    reviewer: "fixture",
    note: "usable image retained; prettier replacement requested",
    rejectedIds: ["cut_001"],
  });
  assert.equal(aestheticReplacement.status, "complete");
  assert.equal(aestheticReplacement.decisions[0].decision, "rejected");
  const resumed = mergeRiskReviewDecisions(riskRows, accepted, { reviewer: "", note: "" });
  assert.equal(resumed.reviewer, "fixture");
  assert.equal(resumed.note, "inspected exact image hash");
  assert.equal(resumed.decisions[0].decision, "accepted");
  const stale = mergeRiskReviewDecisions([{ ...riskRows[0], image_sha256: "hash-b" }], accepted);
  assert.equal(stale.status, "pending_review");
  assert.equal(stale.decisions[0].decision, "not_inspected");
  const cumulative = mergeRiskReviewDecisions([{
    ...riskRows[0],
    image_id: "cut_002",
    image_sha256: "hash-c",
  }], accepted, { preserveUnseen: true });
  assert.deepEqual(cumulative.decisions.map((row) => row.image_id), ["cut_002", "cut_001"]);
  assert.equal(cumulative.decisions.find((row) => row.image_id === "cut_001").decision, "accepted");

  const ledgerResult = applyImageQaDecisionsToLedger({
    cuts: [
      { image_id: "cut_001", image_sha256: "hash-a", motion_profile_hash: "motion-a", motion_clip_path: "/tmp/a.mp4", motion_clip_sha256: "clip-a" },
      { image_id: "cut_002", image_sha256: "hash-c", motion_profile_hash: "motion-b", motion_clip_path: "/tmp/b.mp4", motion_clip_sha256: "clip-b" },
      { image_id: "cut_003", image_sha256: null, image_path: null, image_qa_status: "pending" },
      { image_id: "cut_004", image_sha256: "stale-hash", image_path: "/tmp/stale.png", image_qa_status: "pending" },
    ],
  }, [
    riskRows[0],
    { ...riskRows[0], image_id: "cut_002", image_sha256: "hash-c", requires_manual_risk_review: false },
    { ...riskRows[0], image_id: "cut_003", image_sha256: "fresh-hash", image_path: "/tmp/fresh.png", requires_manual_risk_review: false },
    { ...riskRows[0], image_id: "cut_004", image_sha256: "different-hash", image_path: "/tmp/different.png", requires_manual_risk_review: false },
  ], {
    decisions: [{ image_id: "cut_001", image_sha256: "hash-a", decision: "rejected" }],
  }, new Set(), "fixture", "2026-01-01T00:00:00.000Z");
  assert.deepEqual(ledgerResult.invalidated_motion_image_ids, []);
  assert.equal(ledgerResult.ledger.cuts[0].motion_clip_path, "/tmp/a.mp4");
  assert.equal(ledgerResult.ledger.cuts[0].image_qa_status, "passed_with_aesthetic_advisory");
  assert.equal(ledgerResult.ledger.cuts[1].motion_clip_path, "/tmp/b.mp4");
  assert.equal(ledgerResult.ledger.cuts[1].image_qa_status, "passed_structural");
  assert.equal(ledgerResult.ledger.cuts[2].image_sha256, "fresh-hash");
  assert.equal(ledgerResult.ledger.cuts[2].image_path, "/tmp/fresh.png");
  assert.equal(ledgerResult.ledger.cuts[2].image_qa_status, "passed_structural");
  assert.equal(ledgerResult.ledger.cuts[3].image_sha256, "stale-hash");
  assert.equal(ledgerResult.ledger.cuts[3].image_qa_status, "pending");

  const recoveryCommand = scopedQaRecoveryCommand(
    ["cut_001"],
    { prompts: [{ image_id: "cut_001", image_provider_route: "modelslab" }] },
    { image_provider: "modelslab", results: [{ image_id: "cut_001", image_provider: "modelslab" }] },
    { image_provider: "modelslab" },
  );
  assert.match(recoveryCommand, /--skip-reference-generation true/);
  assert.match(recoveryCommand, /--cut-ids cut_001/);
  const codexRecoveryCommand = scopedQaRecoveryCommand(
    ["cut_002"],
    { prompts: [{ image_id: "cut_002", image_provider_route: "codex_imagegen" }] },
    { image_provider: "codex_imagegen", results: [{ image_id: "cut_002", image_provider: "codex_imagegen" }] },
    { image_provider: "codex_imagegen" },
  );
  assert.match(codexRecoveryCommand, /imagegen codex-work/);
  assert.match(codexRecoveryCommand, /--image-ids cut_002/);
  assert.match(codexRecoveryCommand, /--qa-recovery true/);
  assert.equal(imageQaNeedsRecovery([], ["cut_001"]), false);
  assert.equal(imageQaNeedsRecovery([{ image_id: "cut_001" }], []), true);
  assert.equal(imageQaNeedsRecovery([], []), false);
  assert.deepEqual(acceptedImageHashesForRows([
    { image_id: "cut_001", image_sha256: "hash-a" },
    { image_id: "cut_002", image_sha256: "hash-b" },
  ], new Set(["cut_002"])), { cut_001: "hash-a" });
}

function testExceptionDrivenQaAndAutomaticFocalAnalysis() {
  const width = 32;
  const height = 18;
  const pixels = Buffer.alloc(width * height * 3, 24);
  for (let y = 5; y < 14; y += 1) {
    for (let x = 21; x < 30; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = 245;
      pixels[offset + 1] = 190;
      pixels[offset + 2] = 40;
    }
  }
  const analysis = focalAnalysisFromPixelsForTests(pixels, width, height, 3);
  assert.equal(analysis.focal_anchor.x > 0.55, true);
  assert.equal(analysis.confidence > 0.3, true);

  const diffusePixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const value = (x + y) % 2 === 0 ? 230 : 35;
      diffusePixels[offset] = value;
      diffusePixels[offset + 1] = value;
      diffusePixels[offset + 2] = value;
    }
  }
  const diffuseAnalysis = focalAnalysisFromPixelsForTests(diffusePixels, width, height, 3);
  assert.equal(
    diffuseAnalysis.findings.some((finding) => finding.code === "salient_region_edge_clipping_risk"),
    false,
    "diffuse full-frame detail must not be misclassified as a clipped focal subject",
  );

  const fourRefPrompt = {
    image_id: "cut_sample",
    start_sec: 500,
    shot_manifest: { visible_characters: ["Joey"], shot_job: "emotional_reaction" },
    reference_requirements: [{}, {}, {}, {}],
  };
  assert.equal(imageManualReviewPolicy(fourRefPrompt, [], { openingSec: 180, integrationSampleRate: 0 }).tier, "advisory_review_log");
  assert.equal(imageManualReviewPolicy(fourRefPrompt, [], { openingSec: 180, integrationSampleRate: 1 }).tier, "advisory_review_log");
  assert.equal(imageManualReviewPolicy(fourRefPrompt, [], { openingSec: 180, integrationSampleRate: 1 }).requires_manual_review, false);
  assert.equal(imageManualReviewPolicy(fourRefPrompt, [{ severity: "needs_review", code: "focal_anchor_near_frame_edge" }], { openingSec: 180, integrationSampleRate: 0 }).tier, "advisory_review_log");

  const intent = {
    image_id: "cut_sample",
    image_sha256: "hash",
    behavior: "slow_push_in",
    start_anchor: { x: 0.5, y: 0.5 },
    end_anchor: { x: 0.5, y: 0.5 },
    start_scale: 1.01,
    end_scale: 1.1,
    motion_keyframes: [
      { at: 0, anchor: { x: 0.5, y: 0.5 }, scale: 1.01, easing_to_next: "ease_in_out" },
      { at: 1, anchor: { x: 0.5, y: 0.5 }, scale: 1.1, easing_to_next: "linear" },
    ],
  };
  const shifted = applyAutomaticFocalAnchorForTests(intent, { image_sha256: "hash", analysis_source: "fixture", confidence: 0.9, focal_anchor: { x: 0.8, y: 0.45 } });
  assert.equal(shifted.focal_source, "automatic_image_saliency");
  assert.equal(shifted.end_anchor.x > 0.65, true);
  assert.equal(shifted.motion_keyframes[1].anchor.x > 0.65, true);
  assert.equal(applyAutomaticFocalAnchorForTests(intent, { confidence: 0.9, focal_anchor: { x: 0.8, y: 0.45 } }, { focal_override: { start_anchor: { x: 0.2, y: 0.2 } } }), intent);
  const staticIntent = {
    ...intent,
    behavior: "static_hold",
    start_scale: 1,
    end_scale: 1,
    motion_keyframes: [
      { at: 0, anchor: { x: 0.5, y: 0.5 }, scale: 1, easing_to_next: "linear" },
      { at: 1, anchor: { x: 0.5, y: 0.5 }, scale: 1, easing_to_next: "linear" },
    ],
  };
  assert.equal(applyAutomaticFocalAnchorForTests(staticIntent, { confidence: 0.9, focal_anchor: { x: 0.8, y: 0.45 } }), staticIntent);
}

async function testProviderCircuitBreakerStopsUnclaimedWork() {
  const items = Array.from({ length: 8 }, (_, index) => ({ image_id: `cut_${index + 1}` }));
  const result = await runPoolWithCircuitBreakerForTests(items, async () => {
    throw new Error("503 gateway unavailable");
  }, 1);
  assert.equal(result.circuit_open, true);
  assert.equal(result.results.filter((row) => row.status === "failed").length, 3);
  assert.equal(result.results.filter((row) => row.status === "skipped_provider_circuit_open").length, 5);
}

async function testProviderConcurrencyBacksOffAndRecovers() {
  const items = Array.from({ length: 16 }, (_, index) => ({ image_id: `cut_${index + 1}` }));
  let failedOnce = false;
  const result = await runPoolWithCircuitBreakerForTests(items, async (item) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (!failedOnce) {
      failedOnce = true;
      throw new Error("429 provider queue rate limit");
    }
    return { image_id: item.image_id, status: "generated" };
  }, 8);
  assert.equal(result.circuit_open, false);
  assert.equal(result.adaptive_concurrency.configured, 8);
  assert.equal(result.adaptive_concurrency.minimum < 8, true);
  assert.equal(result.adaptive_concurrency.events.some((row) => row.type === "provider_backoff"), true);
}

function testDirectedMotionAndFullTimelineTransitions() {
  assert.deepEqual(positionAnchorFromStaging("small lower-left foreground"), { x: 0.3, y: 0.65 });
  assert.deepEqual(positionAnchorFromStaging("frame-right deep background"), { x: 0.7, y: 0.42 });
  assert.deepEqual(positionAnchorFromStaging("lower-center beneath the system display"), { x: 0.5, y: 0.65 });
  const prompt = {
    image_id: "cut_004",
    scene_id: "scene_002",
    visual_beat_id: "beat_004",
    start_sec: 240,
    duration_sec: 8,
    shot_manifest: {
      shot_job: "physical_action",
      primary_character: "Joey",
      character_staging: [{ name: "Joey", screen_position: "frame-left", pose: "lunges forward" }],
    },
  };
  const intent = motionIntentForPrompt(prompt, "hash-4");
  assert.equal(intent.behavior, "lateral_follow");
  assert.equal(intent.end_anchor.x, 0.3);
  assert.deepEqual(motionIntentFindings([intent], { cut_004: "hash-4" }), []);
  const trace = motionTraceForIntent(intent, 60);
  assert.equal(trace.length, 480);
  assert.deepEqual(motionTraceFindings(trace), []);

  const authoredMotion = {
    behavior: "diagonal_follow",
    focal_subject: "Joey's hand toward the falling blade",
    start_anchor: { x: 0.28, y: 0.62 },
    end_anchor: { x: 0.72, y: 0.34 },
    start_scale: 1.01,
    end_scale: 1.08,
    easing: "ease_in_out",
    reason: "Follow the interception into the visible impact point.",
    depth_candidate: {
      eligible: true,
      priority: 91,
      separation_confidence: "high",
      foreground_subject: "Joey and the stopped blade",
      background_plane: "the guild chamber wall",
      editorial_reason: "Depth makes the interception land as the hero reversal.",
    },
  };
  assert.deepEqual(sanitizeAuthoredMotionIntent(authoredMotion), authoredMotion);
  assert.equal(sanitizeAuthoredMotionIntent({ ...authoredMotion, end_anchor: { x: 1.4, y: 0.3 } }), null);
  assert.equal(sanitizeAuthoredMotionIntent({ ...authoredMotion, behavior: "random_wobble" }), null);
  assert.equal(sanitizeAuthoredMotionIntent({ ...authoredMotion, behavior: "static_hold" }), null);
  const authoredIntent = motionIntentForPrompt({
    image_id: "cut_authored",
    duration_sec: 7,
    shot_manifest: { motion_intent: authoredMotion },
  }, "hash-authored");
  assert.equal(authoredIntent.behavior, "diagonal_follow");
  assert.deepEqual(authoredIntent.start_anchor, authoredMotion.start_anchor);
  assert.deepEqual(authoredIntent.end_anchor, authoredMotion.end_anchor);
  assert.equal(authoredIntent.intent_reason, authoredMotion.reason);
  assert.equal(authoredIntent.focal_source, "llm_authored_shot_manifest_motion_intent");
  assert.equal(authoredIntent.depth_candidate.priority, 91);
  assert.equal(sanitizeDepthCandidate({ eligible: true, priority: 101 }), null);

  const keyframedMotion = {
    behavior: "impact_push",
    focal_subject: "Joey's stopped spear",
    easing: "ease_out",
    motion_keyframes: [
      { at: 0, anchor: { x: 0.5, y: 0.5 }, scale: 1, easing_to_next: "ease_in_out" },
      { at: 0.28, anchor: { x: 0.52, y: 0.49 }, scale: 1.08, easing_to_next: "ease_in_out" },
      { at: 0.52, anchor: { x: 0.52, y: 0.49 }, scale: 1.065, easing_to_next: "linear" },
      { at: 1, anchor: { x: 0.52, y: 0.49 }, scale: 1.065, easing_to_next: "linear" },
    ],
    reason: "Punch into the impact, settle, and hold the evidence.",
  };
  const sanitizedKeyframedMotion = sanitizeAuthoredMotionIntent(keyframedMotion);
  assert.equal(sanitizedKeyframedMotion.start_scale, 1);
  assert.equal(sanitizedKeyframedMotion.end_scale, 1.065);
  assert.deepEqual(sanitizedKeyframedMotion.start_anchor, { x: 0.5, y: 0.5 });
  const delayedMotion = continuousMotionKeyframes([
    { at: 0, anchor: { x: 0.3, y: 0.5 }, scale: 1.01, easing_to_next: "ease_in_out" },
    { at: 0.2, anchor: { x: 0.3, y: 0.5 }, scale: 1.01, easing_to_next: "ease_in_out" },
    { at: 0.75, anchor: { x: 0.7, y: 0.5 }, scale: 1.06, easing_to_next: "ease_out" },
    { at: 1, anchor: { x: 0.7, y: 0.5 }, scale: 1.06, easing_to_next: "linear" },
  ], "lateral_follow");
  assert.equal(delayedMotion.length, 2);
  assert.deepEqual(delayedMotion.map((row) => row.at), [0, 1]);
  assert.equal(motionTraceForIntent({ image_id: "cut_continuous", duration_sec: 4, behavior: "lateral_follow", motion_keyframes: delayedMotion }, 60)[1].x > delayedMotion[0].anchor.x, true);
  const subtleMoveTrace = motionTraceForIntent({
    image_id: "cut_subtle_continuous",
    duration_sec: 10,
    behavior: "slow_push_in",
    motion_keyframes: [
      { at: 0, anchor: { x: 0.5, y: 0.5 }, scale: 1.01, easing_to_next: "ease_in_out" },
      { at: 1, anchor: { x: 0.5, y: 0.5 }, scale: 1.045, easing_to_next: "linear" },
    ],
  }, 60);
  assert.equal(subtleMoveTrace[1].scale > subtleMoveTrace[0].scale, true);
  const staticDelay = continuousMotionKeyframes([
    { at: 0, anchor: { x: 0.5, y: 0.5 }, scale: 1, easing_to_next: "linear" },
    { at: 1, anchor: { x: 0.5, y: 0.5 }, scale: 1, easing_to_next: "linear" },
  ], "static_hold");
  assert.equal(staticDelay.length, 2);
  assert.equal(sanitizeMotionKeyframes([{ at: 0, anchor: { x: 0.5, y: 0.5 }, scale: 1, easing_to_next: "linear" }]), null);
  assert.equal(sanitizeAuthoredMotionIntent({ ...keyframedMotion, motion_keyframes: [...keyframedMotion.motion_keyframes].reverse() }), null);
  const keyframedIntent = motionIntentForPrompt({ image_id: "cut_keyframed", duration_sec: 4, shot_manifest: { motion_intent: keyframedMotion } }, "hash-keyframed");
  const keyframedTrace = motionTraceForIntent(keyframedIntent, 60);
  assert.equal(keyframedTrace.some((row, index) => index > 0 && row.scale < keyframedTrace[index - 1].scale), true);
  assert.deepEqual(motionTraceFindings(keyframedTrace), []);
  const aggressiveTrace = motionTraceForIntent({
    ...keyframedIntent,
    motion_keyframes: [
      { at: 0, anchor: { x: 0.5, y: 0.5 }, scale: 1, easing_to_next: "ease_out" },
      { at: 0.08, anchor: { x: 0.5, y: 0.5 }, scale: 1.12, easing_to_next: "ease_in_out" },
      { at: 1, anchor: { x: 0.5, y: 0.5 }, scale: 1.08, easing_to_next: "linear" },
    ],
  }, 60);
  assert.equal(motionTraceFindings(aggressiveTrace).some((row) => row.code === "motion_keyframe_velocity_excessive"), true);

  const focusShift = motionIntentForPrompt({
    image_id: "cut_focus",
    duration_sec: 6,
    shot_manifest: {
      shot_job: "interaction",
      primary_character: "Joey",
      character_staging: [
        { name: "Joey", screen_position: "frame-left foreground" },
        { name: "Arielle", screen_position: "frame-right midground" },
      ],
    },
  }, "hash-focus");
  assert.equal(focusShift.behavior, "focus_shift");
  assert.deepEqual(focusShift.start_anchor, { x: 0.7, y: 0.5 });
  assert.deepEqual(focusShift.end_anchor, { x: 0.3, y: 0.58 });
  assert.deepEqual(motionTraceFindings(motionTraceForIntent(focusShift, 60)), []);

  const reactionIntent = motionIntentForPrompt({
    image_id: "cut_reaction",
    duration_sec: 5,
    visual_job: "reaction_shot",
    shot_manifest: {
      shot_job: "emotional_reaction",
      primary_character: "Joey",
      character_staging: [{ name: "Joey", screen_position: "frame-right" }],
    },
  }, "hash-reaction");
  assert.equal(reactionIntent.behavior, "reaction_hold");

  const consequenceIntent = motionIntentForPrompt({
    image_id: "cut_consequence",
    duration_sec: 8,
    visual_job: "consequence",
    shot_manifest: {
      shot_job: "consequence",
      primary_character: "Joey",
      character_staging: [{ name: "Joey", screen_position: "frame-left foreground" }],
    },
  }, "hash-consequence");
  assert.equal(consequenceIntent.behavior, "aftermath_reveal");
  assert.equal(consequenceIntent.end_scale < consequenceIntent.start_scale, true);

  const terminalIntent = motionIntentForPrompt({
    image_id: "cut_terminal",
    start_sec: 297.48,
    duration_sec: 2.52,
    shot_manifest: { shot_job: "ui_reveal", primary_character: "Joey" },
  }, "hash-terminal", null, { timelineEndSec: 299.901995 });
  assert.equal(Number(terminalIntent.duration_sec.toFixed(6)), 2.421995);
  assert.equal(terminalIntent.focal_subject, "authored insert focal point");
  assert.deepEqual(terminalIntent.end_anchor, { x: 0.5, y: 0.5 });

  const staticIntent = motionIntentForPrompt({ image_id: "cut_005", duration_sec: 10, shot_manifest: {} }, "hash-5");
  assert.equal(staticIntent.behavior, "static_hold");
  assert.equal(staticIntent.start_scale, staticIntent.end_scale);

  const groups = xfadeTimelineGroupsForTests(
    ["cut_001", "cut_002", "cut_003", "cut_004", "cut_005", "cut_006"],
    ["cut_002", "cut_005"],
  );
  assert.deepEqual(groups, [["cut_001", "cut_002"], ["cut_003"], ["cut_004", "cut_005"], ["cut_006"]]);
  const xfadeTiming = xfadeSegmentTimingForTests([4, 5, 6], [0.25, 0.3]);
  assert.deepEqual(xfadeTiming.boundaries, [
    { offset_sec: 3.75, transition_duration_sec: 0.25, incoming_start_padding_sec: 0.25 },
    { offset_sec: 8.7, transition_duration_sec: 0.3, incoming_start_padding_sec: 0.3 },
  ]);
  assert.equal(xfadeTiming.expected_duration_sec, 15);
  assert.equal(xfadeTiming.duration_after_xfade_sec, 15);
  const xfadeCacheIdentity = {
    inputHashes: ["clip-sha-a", "clip-sha-b"],
    transitions: [{ from_image_id: "cut_001", to_image_id: "cut_002", transition: "dissolve", duration_sec: 0.25, offset_sec: 3.75, incoming_start_padding_sec: 0.25 }],
    encoding: { width: 1920, height: 1080, fps: 60, codec: "libx264", preset: "veryfast", crf: 20, pixel_format: "yuv420p" },
  };
  const xfadeCacheKey = xfadeGroupCacheKeyForTests(xfadeCacheIdentity);
  assert.equal(xfadeGroupCacheKeyForTests(structuredClone(xfadeCacheIdentity)), xfadeCacheKey);
  assert.notEqual(xfadeGroupCacheKeyForTests({ ...xfadeCacheIdentity, inputHashes: ["clip-sha-a", "changed"] }), xfadeCacheKey);
  assert.notEqual(xfadeGroupCacheKeyForTests({
    ...xfadeCacheIdentity,
    transitions: [{ ...xfadeCacheIdentity.transitions[0], duration_sec: 0.3 }],
  }), xfadeCacheKey);
  assert.notEqual(xfadeGroupCacheKeyForTests({
    ...xfadeCacheIdentity,
    encoding: { ...xfadeCacheIdentity.encoding, preset: "fast" },
  }), xfadeCacheKey);

  const subpixel = subpixelPerspectiveCoreForTests(
    "1.02+0.04*(on/599)",
    "0.7-0.4*(on/599)",
    "0.5+0.08*(on/599)",
    "anchor",
  );
  assert.match(subpixel, /^perspective=/);
  assert.match(subpixel, /eval=frame/);
  assert.match(subpixel, /interpolation=cubic/);
  assert.match(subpixel, /clip\(/);
  assert.match(subpixel, /on\/599/);
  assert.doesNotMatch(subpixel, /zoompan/);
  const exactFilter = motionClipFilterForTests(10, 0, {}, 0, null, authoredIntent, "smooth_subpixel_ken_burns");
  assert.match(exactFilter, /perspective=/);
  assert.match(exactFilter, /eval=frame/);
  assert.doesNotMatch(exactFilter, /zoompan=/);
  const keyframedFilter = motionClipFilterForTests(4, 0, {}, 0, null, keyframedIntent, "smooth_subpixel_ken_burns");
  assert.match(keyframedFilter, /if\(lte\(/);
  assert.match(keyframedFilter, /perspective=/);
  const staticFilter = motionClipFilterForTests(4, 0, {}, 0, null, {
    ...staticIntent,
    motion_keyframes: [
      { at: 0, anchor: { x: 0.5, y: 0.5 }, scale: 1, easing_to_next: "linear" },
      { at: 1, anchor: { x: 0.5, y: 0.5 }, scale: 1, easing_to_next: "linear" },
    ],
  }, "smooth_subpixel_ken_burns");
  assert.doesNotMatch(staticFilter, /perspective=/);
  assert.match(staticFilter, /force_original_aspect_ratio=decrease/);

  const hash = "a".repeat(64);
  const backgroundKeyframes = [
    { at: 0, anchor: { x: 0.5, y: 0.5 }, scale: 1.01, easing_to_next: "ease_in_out" },
    { at: 1, anchor: { x: 0.5, y: 0.5 }, scale: 1.02, easing_to_next: "linear" },
  ];
  const foregroundKeyframes = [
    { at: 0, anchor: { x: 0.5, y: 0.5 }, scale: 1.015, easing_to_next: "ease_in_out" },
    { at: 1, anchor: { x: 0.5, y: 0.5 }, scale: 1.035, easing_to_next: "linear" },
  ];
  const parallaxTreatment = sanitizeLayeredParallaxTreatment({
    mode: "layered_parallax",
    source_image_sha256: hash,
    background_path: "/tmp/background.png",
    background_sha256: hash,
    foreground_path: "/tmp/foreground.png",
    foreground_sha256: hash,
    background_keyframes: backgroundKeyframes,
    foreground_keyframes: foregroundKeyframes,
  });
  assert.equal(parallaxTreatment.occlusion_contract, "foreground_cover");
  assert.equal(MODELSLAB_PARALLAX_BACKGROUND_STRATEGY, "modelslab_flux_klein_reconstruction");
  assert.match(parallaxBackgroundFilter(), /maskedmerge/);
  const backgroundPrompt = parallaxBackgroundPrompt({ foregroundSubject: "the hero", backgroundPlane: "the academy hall" });
  assert.match(backgroundPrompt, /clean unoccupied rear plate/);
  assert.match(backgroundPrompt, /academy hall/);
  assert.match(backgroundPrompt, /behind the hero/);
  assert.equal(sanitizeLayeredParallaxTreatment({
    ...parallaxTreatment,
    foreground_keyframes: foregroundKeyframes.map((row) => ({ ...row, anchor: { x: 0.52, y: 0.5 } })),
  }), null);
  const parallaxFilter = motionClipFilterForTests(4, 0, {}, 0, null, {
    ...staticIntent,
    depth_treatment: parallaxTreatment,
  }, "smooth_subpixel_ken_burns");
  assert.match(parallaxFilter, /\[depth_bg\]\[depth_fg\]overlay=/);
  assert.equal((parallaxFilter.match(/perspective=/g) ?? []).length, 2);
  assert.doesNotMatch(parallaxFilter, /zoompan=/);
  const backgroundTrace = motionTraceForIntent({ image_id: "cut_depth", duration_sec: 4, motion_keyframes: backgroundKeyframes }, 60).map((row) => ({ ...row, layer: "background" }));
  const foregroundTrace = motionTraceForIntent({ image_id: "cut_depth", duration_sec: 4, motion_keyframes: foregroundKeyframes }, 60).map((row) => ({ ...row, layer: "foreground" }));
  assert.deepEqual(motionTraceFindings([...backgroundTrace, ...foregroundTrace]), []);

  const editorialRows = Array.from({ length: 10 }, (_, index) => ({
    image_id: `motion_${index}`,
    start_sec: index * 5,
    behavior: index === 2 || index === 7 ? "static_hold" : "slow_push_in",
  }));
  assert.equal(editorialMotionDistributionFindings(editorialRows).filter((row) => row.severity === "blocker").length, 0);
  assert.equal(editorialMotionDistributionFindings(editorialRows.map((row) => ({ ...row, behavior: "slow_push_in" }))).some((row) => row.code === "motion_static_hold_share_too_low"), true);

  const depthPrompts = [
    { image_id: "depth_a", start_sec: 5, duration_sec: 5, shot_manifest: { motion_intent: { behavior: "slow_push_in", depth_candidate: { eligible: true, priority: 75, separation_confidence: "medium", foreground_subject: "hero", background_plane: "hall", editorial_reason: "hero reveal" } } } },
    { image_id: "depth_b", start_sec: 8, duration_sec: 5, shot_manifest: { motion_intent: { behavior: "impact_push", depth_candidate: { eligible: true, priority: 99, separation_confidence: "high", foreground_subject: "blade", background_plane: "arena", editorial_reason: "impact" } } } },
    { image_id: "depth_c", start_sec: 18, duration_sec: 5, shot_manifest: { motion_intent: { behavior: "ui_focus", depth_candidate: { eligible: true, priority: 88, separation_confidence: "high", foreground_subject: "system panel", background_plane: "city", editorial_reason: "system reveal" } } } },
    { image_id: "depth_static", start_sec: 30, duration_sec: 5, shot_manifest: { motion_intent: { behavior: "static_hold", depth_candidate: { eligible: true, priority: 100, separation_confidence: "high", foreground_subject: "hero", background_plane: "hall", editorial_reason: "should remain still" } } } },
    { image_id: "depth_late", start_sec: 200, duration_sec: 5, shot_manifest: { motion_intent: { behavior: "slow_push_in", depth_candidate: { eligible: true, priority: 100, separation_confidence: "high", foreground_subject: "late hero", background_plane: "late hall", editorial_reason: "must not displace retention-window depth" } } } },
  ];
  const selectedDepth = selectAuthoredParallaxCandidates(depthPrompts, { maxCandidates: 2, minSpacingSec: 6 });
  assert.deepEqual(selectedDepth.map((row) => row.image_id), ["depth_b", "depth_c"]);
  const retentionDepthPrompts = Array.from({ length: 18 }, (_, index) => ({
    image_id: `retention_depth_${index}`,
    start_sec: index < 6 ? index * 5 : 30 + ((index - 6) * 12),
    duration_sec: 4,
    shot_manifest: { motion_intent: { behavior: "slow_push_in", depth_candidate: { eligible: true, priority: 100 - index, separation_confidence: "high", foreground_subject: `subject ${index}`, background_plane: `plane ${index}`, editorial_reason: "retention depth" } } },
  }));
  const retentionDepth = selectAuthoredParallaxCandidates(retentionDepthPrompts, {
    maxCandidates: 15,
    minSpacingSec: 3,
    firstWindowSec: 30,
    firstWindowTarget: 5,
    openingWindowSec: 180,
    retentionWindowTarget: 10,
  });
  assert.equal(retentionDepth.filter((row) => row.start_sec < 30).length, 5);
  assert.equal(retentionDepth.filter((row) => row.start_sec >= 30 && row.start_sec < 180).length, 10);
  const inspectedOverrides = inspectedParallaxCandidateOverrides(retentionDepthPrompts, {
    status: "approved",
    reviewer: "fixture",
    note: "inspected generated frames",
    candidates: retentionDepthPrompts.slice(0, 3).map((row) => ({
      image_id: row.image_id,
      priority: 95,
      separation_confidence: "high",
      foreground_subject: "reviewed foreground",
      background_plane: "reviewed background",
      editorial_reason: "reviewed depth opportunity",
    })),
  }, { maxCandidates: 15, openingWindowSec: 180 });
  assert.equal(inspectedOverrides.length, 3);
  assert.equal(inspectedOverrides.every((row) => row.selection_source === "inspected_candidate_override"), true);
  const depthAssetHash = "b".repeat(64);
  const noticeable = noticeableParallaxTreatment({
    intent: { start_anchor: { x: 0.5, y: 0.5 }, end_anchor: { x: 0.55, y: 0.48 } },
    candidate: selectedDepth[0],
    assetReport: {
      status: "passed",
      image_sha256: depthAssetHash,
      background_path: "/tmp/depth-background.png",
      background_sha256: depthAssetHash,
      foreground_path: "/tmp/depth-foreground.png",
      foreground_sha256: depthAssetHash,
      local_separation_evidence: {
        foreground_centroid: { x: 0.61, y: 0.44 },
      },
    },
  });
  assert.equal(noticeable.occlusion_contract, "foreground_cover");
  assert.deepEqual(noticeable.foreground_keyframes[0].anchor, { x: 0.61, y: 0.44 });
  assert.equal(noticeable.foreground_keyframes[0].scale > noticeable.background_keyframes[0].scale, true);
  const finalDepthSeparation = noticeable.foreground_keyframes.at(-1).scale - noticeable.background_keyframes.at(-1).scale;
  const backgroundTravel = noticeable.background_keyframes[0].scale - noticeable.background_keyframes.at(-1).scale;
  assert.equal(finalDepthSeparation >= 0.05 && finalDepthSeparation <= 0.08, true);
  assert.equal(backgroundTravel >= 0.01 && backgroundTravel <= 0.025, true);
  const contractReport = {
    source_hashes: { "/tmp/prompts.json": depthAssetHash },
    candidates: [{
      image_id: "depth_b",
      image_sha256: depthAssetHash,
      priority: 99,
      asset_report_path: "/tmp/depth.json",
      asset_report: {
        mask_sha256: depthAssetHash,
        foreground_sha256: depthAssetHash,
        background_sha256: depthAssetHash,
      },
    }],
  };
  const contractHash = parallaxAssetContractSha256(contractReport);
  const approval = {
    status: "approved",
    asset_report_sha256: depthAssetHash,
    asset_contract_sha256: contractHash,
    approved_image_ids: ["depth_b"],
    declined_image_ids: [],
    decisions: [{ image_id: "depth_b", image_sha256: depthAssetHash, decision: "approved", asset_report_path: "/tmp/depth.json", mask_sha256: depthAssetHash, foreground_sha256: depthAssetHash, background_sha256: depthAssetHash }],
  };
  assert.equal(parallaxApprovalMatches(contractReport, approval, { reportSha256: depthAssetHash }), true);
  assert.equal(parallaxApprovalMatches(contractReport, { ...approval, approved_image_ids: [] }, { reportSha256: depthAssetHash }), false);

  assert.equal(assertLockedRenderProfileForTests({ v2Run: true, lockedRenderProfile: "smooth_subpixel_ken_burns", requestedMotionMode: "smooth_subpixel_ken_burns" }), "smooth_subpixel_ken_burns");
  assert.throws(
    () => assertLockedRenderProfileForTests({ v2Run: true, lockedRenderProfile: "smooth_subpixel_ken_burns", requestedMotionMode: "smooth_fast_ken_burns" }),
    /does not match run_identity\.render_profile/i,
  );
  assert.equal(assertLockedRenderProfileForTests({ v2Run: true, lockedRenderProfile: "smooth_subpixel_ken_burns", requestedMotionMode: "smooth_fast_ken_burns", workflowBypass: true }), "smooth_fast_ken_burns");

  const baseFullMotionIntents = [
    { image_id: "cut_a", scene_id: "scene_1", visual_beat_id: "beat_0", start_sec: 0, duration_sec: 2, behavior: "slow_push_in" },
    { image_id: "cut_open", scene_id: "scene_1", visual_beat_id: "beat_1", start_sec: 2, duration_sec: 4, behavior: "slow_push_in" },
    { image_id: "cut_later", scene_id: "scene_2", visual_beat_id: "beat_2", start_sec: 6, duration_sec: 5, behavior: "lateral_follow" },
  ];
  const promotedEditorial = promoteEditorialMotionPlans({
    baseMotionPlan: { status: "passed", motion_intents: baseFullMotionIntents },
    proofMotionPlan: {
      status: "passed",
      motion_intents: [
        baseFullMotionIntents[0],
        { ...baseFullMotionIntents[1], duration_sec: 3.5, behavior: "static_hold" },
      ],
    },
    baseTransitionPlan: {
      status: "passed",
      transition_events: [
        { from_image_id: "cut_a", to_image_id: "cut_open", start_sec: 2, transition_sfx: false },
        { from_image_id: "cut_open", to_image_id: "cut_later", start_sec: 6, transition_sfx: false },
      ],
    },
    proofTransitionPlan: {
      status: "passed",
      transition_events: [{ from_image_id: "cut_a", to_image_id: "cut_open", start_sec: 2, transition_sfx: true }],
    },
    scopeEndSec: 6,
    variantLabel: "fixture-proof",
  });
  assert.equal(promotedEditorial.motionPlan.motion_intents[1].behavior, "static_hold");
  assert.equal(promotedEditorial.motionPlan.motion_intents[1].duration_sec, 4);
  assert.deepEqual(promotedEditorial.motionPlan.motion_intents[2], baseFullMotionIntents[2]);
  assert.equal(promotedEditorial.transitionPlan.transition_event_count, 2);
  assert.equal(promotedEditorial.transitionPlan.transition_sfx_enabled, true);
  assert.equal(promotedEditorial.metrics.restored_full_timeline_timing_count, 1);
  assert.equal(promotedEditorial.metrics.untouched_motion_intent_count, 1);

  const transitionManifest = {
    cues: [
      {
        cue_id: "hook_impact_flash_with_muted_sub_thud",
        preferred_asset_id: "impact-good",
        assets: [
          { asset_id: "impact-bad", status: "needs_review", path: "/tmp/bad.wav" },
          { asset_id: "impact-good", status: "available", path: "/tmp/good.wav" },
        ],
      },
      {
        cue_id: "hook_swipe_down_whoosh",
        preferred_asset_id: "swipe-good",
        assets: [{ asset_id: "swipe-good", status: "available", path: "/tmp/swipe.wav" }],
      },
    ],
  };
  const resolvedImpact = resolveTransitionSfxFamily(transitionManifest, "impact", { inHook: true });
  assert.equal(resolvedImpact.asset_id, "impact-good");
  assert.equal(resolvedImpact.asset_path, "/tmp/good.wav");
  assert.equal(resolvedImpact.gain_db, -14);
  const resolvedSwipe = resolveTransitionSfxFamily(transitionManifest, "swipe_down", { inHook: true });
  assert.equal(resolvedSwipe.asset_trim_start_sec, 0.55);
  assert.equal(resolvedSwipe.sfx_offset_sec, -0.25);
  assert.equal(transitionSfxFamilyGuide().some((row) => row.family === "system_scan"), true);
}

async function testMotionPlanConsumesApprovedParallax() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-motion-parallax-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await fs.mkdir(episodeDir, { recursive: true });
  const acceptedHashes = {};
  const prompts = Array.from({ length: 8 }, (_, index) => {
    const imageId = `cut_${String(index + 1).padStart(3, "0")}`;
    acceptedHashes[imageId] = String(index + 1).repeat(64).slice(0, 64);
    const isStatic = index === 3;
    return {
      image_id: imageId,
      scene_id: "scene_001",
      visual_beat_id: `beat_${index + 1}`,
      start_sec: index * 5,
      duration_sec: 5,
      image_generation_required: true,
      shot_manifest: {
        motion_intent: {
          behavior: isStatic ? "static_hold" : "slow_push_in",
          focal_subject: "Joey",
          start_anchor: { x: 0.5, y: 0.5 },
          end_anchor: { x: 0.5, y: 0.5 },
          start_scale: 1,
          end_scale: isStatic ? 1 : 1.04,
          easing: isStatic ? "linear" : "ease_in_out",
          reason: isStatic ? "Hold the reaction." : "Push toward the focal subject.",
          depth_candidate: index === 0
            ? { eligible: true, priority: 92, separation_confidence: "high", foreground_subject: "Joey", background_plane: "the guild hall", editorial_reason: "Open the hero reveal in depth." }
            : { eligible: false, priority: 0, separation_confidence: "low", foreground_subject: null, background_plane: null, editorial_reason: "Single-plane cut." },
        },
      },
    };
  });
  const promptPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  const imagegenPath = path.join(episodeDir, "imagegen_report_ep_01.json");
  const imageQaPath = path.join(episodeDir, "image_output_qa_ep_01.json");
  const decisionsPath = path.join(episodeDir, "image_output_review_decisions_ep_01.json");
  const ledgerPath = path.join(episodeDir, "cut_execution_ledger.json");
  const audioPath = path.join(episodeDir, "longform_audio_bed_report_ep_01.json");
  const identityPath = path.join(episodeDir, "run_identity.json");
  await writeJson(promptPath, { status: "passed", prompts });
  await writeJson(imagegenPath, { status: "passed", results: [] });
  await writeJson(decisionsPath, { status: "complete", decisions: prompts.map((row) => ({ image_id: row.image_id, decision: "accepted" })) });
  await writeJson(imageQaPath, { status: "passed", review_decisions_sha256: await sha256File(decisionsPath), accepted_image_hashes: acceptedHashes });
  await writeJson(ledgerPath, { cuts: prompts.map((row) => ({ image_id: row.image_id, image_sha256: acceptedHashes[row.image_id], image_qa_status: "passed_auto" })) });
  await writeJson(audioPath, { status: "passed", mix: { duration_sec: 40 } });
  await writeJson(identityPath, { schema: "goldflow_run_identity_v2", motion_policy: "selective_editorial_v1", parallax_policy: "selective_inspected", render_profile: "smooth_subpixel_ken_burns" });

  const foregroundPath = path.join(episodeDir, "foreground.png");
  const backgroundPath = path.join(episodeDir, "background.png");
  const maskPath = path.join(episodeDir, "mask.png");
  await fs.writeFile(foregroundPath, "foreground");
  await fs.writeFile(backgroundPath, "background");
  await fs.writeFile(maskPath, "mask");
  const candidate = {
    image_id: "cut_001",
    image_sha256: acceptedHashes.cut_001,
    priority: 92,
    foreground_subject: "Joey",
    background_plane: "the guild hall",
    editorial_reason: "Open the hero reveal in depth.",
    asset_report_path: path.join(episodeDir, "cut_001-parallax-assets.json"),
    asset_report: {
      status: "passed",
      image_sha256: acceptedHashes.cut_001,
      mask_path: maskPath,
      mask_sha256: await sha256File(maskPath),
      foreground_path: foregroundPath,
      foreground_sha256: await sha256File(foregroundPath),
      background_path: backgroundPath,
      background_sha256: await sha256File(backgroundPath),
    },
  };
  const parallaxReportPath = path.join(episodeDir, "parallax_asset_report_ep_01.json");
  const parallaxReport = { status: "passed", candidate_count: 1, candidates: [candidate], source_hashes: {} };
  parallaxReport.asset_contract_sha256 = parallaxAssetContractSha256(parallaxReport);
  await writeJson(parallaxReportPath, parallaxReport);
  const parallaxApprovalPath = path.join(episodeDir, "parallax_asset_approval_ep_01.json");
  await writeJson(parallaxApprovalPath, {
    status: "approved",
    asset_report_sha256: await sha256File(parallaxReportPath),
    asset_contract_sha256: parallaxReport.asset_contract_sha256,
    approved_image_ids: ["cut_001"],
    declined_image_ids: [],
    decisions: [{
      image_id: "cut_001",
      image_sha256: acceptedHashes.cut_001,
      decision: "approved",
      asset_report_path: candidate.asset_report_path,
      mask_sha256: candidate.asset_report.mask_sha256,
      foreground_sha256: candidate.asset_report.foreground_sha256,
      background_sha256: candidate.asset_report.background_sha256,
    }],
  });
  const outputPath = path.join(episodeDir, "motion_edit_plan_ep_01.json");
  await execFileAsync(process.execPath, [
    "scripts/visual-motion-plan.mjs",
    "--episode-dir", episodeDir,
    "--episode", "ep_01",
    "--output", outputPath,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const motionPlan = await readJson(outputPath);
  assert.equal(motionPlan.status, "passed");
  assert.equal(motionPlan.layered_parallax_count, 1);
  assert.equal(motionPlan.static_hold_count, 1);
  assert.equal(motionPlan.motion_intents.find((row) => row.image_id === "cut_001").depth_treatment.occlusion_contract, "foreground_cover");
}

async function testStreamingRenderHashFinalization() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-stream-hash-"));
  const outputPath = path.join(tempDir, "longform.mp4");
  const fixtureBytes = Buffer.alloc(3 * 1024 * 1024, 0x5a);
  await fs.writeFile(outputPath, fixtureBytes);
  const expectedHash = createHash("sha256").update(fixtureBytes).digest("hex");
  assert.equal(await sha256File(outputPath), expectedHash);

  const reportPath = path.join(tempDir, "render_report.json");
  await writeJson(reportPath, {
    schema: "goldflow_render_report_v2",
    status: "passed",
    output_path: outputPath,
    output_hash: null,
    final_video_sha256: null,
  });
  const finalized = await finalizeRenderReport({ reportPath });
  assert.equal(finalized.report.output_hash, expectedHash);
  assert.equal(finalized.report.final_video_sha256, expectedHash);
  assert.equal(finalized.report.output_size_bytes, fixtureBytes.length);
  assert.equal(finalized.report.output_hash_method, "streaming_sha256");
}

async function testRenderRequiresHashMatchedImageQa() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-render-qa-"));
  const imagePath = path.join(tempDir, "cut_001.png");
  await fs.writeFile(imagePath, Buffer.from("fixture image bytes"));
  const imageHash = sha256(await fs.readFile(imagePath));
  const promptPlan = { prompts: [{ image_id: "cut_001", image_generation_required: true }] };
  const imagegenReport = { results: [{ image_id: "cut_001", image_path: imagePath }] };
  const promptPlanPath = path.join(tempDir, "prompts.json");
  const imagegenReportPath = path.join(tempDir, "imagegen.json");
  await writeJson(promptPlanPath, promptPlan);
  await writeJson(imagegenReportPath, imagegenReport);
  const identity = { image_output_qa_required: true };
  const imageOutputQa = {
    status: "passed",
    prompt_plan_sha256: sha256(await fs.readFile(promptPlanPath)),
    imagegen_report_sha256: sha256(await fs.readFile(imagegenReportPath)),
    accepted_image_hashes: { cut_001: imageHash },
  };
  const ledger = { cuts: [{ image_id: "cut_001", image_sha256: imageHash, image_qa_status: "passed_manual_risk" }] };
  const options = { promptPlanPath, imagegenReportPath };
  const result = await assertRenderImageIntegrityForTests(promptPlan, imagegenReport, identity, imageOutputQa, ledger, options);
  assert.equal(result.checked_image_count, 1);
  await fs.writeFile(imagePath, Buffer.from("changed after review"));
  await assert.rejects(
    () => assertRenderImageIntegrityForTests(promptPlan, imagegenReport, identity, imageOutputQa, ledger, options),
    /changed after output QA/i,
  );
}

async function testIncrementalMotionClipPrebuildReusesExactCache() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-motion-prebuild-"));
  const imagePath = path.join(tempDir, "cut_static.png");
  const audioPath = path.join(tempDir, "audio.m4a");
  const promptPath = path.join(tempDir, "prompts.json");
  const imagegenPath = path.join(tempDir, "imagegen.json");
  const transitionPath = path.join(tempDir, "transitions.json");
  const motionPath = path.join(tempDir, "motion.json");
  const audioBedPath = path.join(tempDir, "audio-bed.json");
  const workDir = path.join(tempDir, "render-work");
  await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 40, g: 80, b: 140 } } }).png().toFile(imagePath);
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "anullsrc=r=48000:cl=mono",
    "-t", "6",
    "-c:a", "aac",
    audioPath,
  ]);
  const imageHash = await sha256File(imagePath);
  const prompts = [
    { image_id: "cut_before", start_sec: 0, duration_sec: 2, image_generation_required: true },
    {
      image_id: "cut_static",
      start_sec: 2,
      duration_sec: 2,
      image_generation_required: true,
      shot_manifest: {
        motion_intent: {
          behavior: "static_hold",
          focal_subject: "Joey",
          start_anchor: { x: 0.5, y: 0.5 },
          end_anchor: { x: 0.5, y: 0.5 },
          start_scale: 1,
          end_scale: 1,
          easing: "linear",
          depth_candidate: { eligible: false, priority: 0, separation_confidence: "low", editorial_reason: "single plane" },
        },
      },
    },
    { image_id: "cut_after", start_sec: 4, duration_sec: 2, image_generation_required: true },
  ];
  const intent = motionIntentForPrompt(prompts[1], imageHash, null, { timelineEndSec: 6 });
  await writeJson(promptPath, { status: "passed", prompts });
  await writeJson(imagegenPath, { status: "passed", results: [{ image_id: "cut_static", image_path: imagePath }] });
  await writeJson(transitionPath, {
    status: "passed",
    transition_events: [{ from_image_id: "cut_static", to_image_id: "cut_after", xfade_transition: "dissolve", xfade_duration_sec: 0.2 }],
  });
  await writeJson(motionPath, { status: "passed", motion_intents: [intent] });
  await writeJson(audioBedPath, { status: "passed", mix: { m4a_path: audioPath, duration_sec: 6 } });
  const renderArgs = [
    "scripts/render.mjs",
    "--channel", "fixture",
    "--series", "fixture",
    "--week", "fixture",
    "--episode", "ep_01",
    "--prompts", promptPath,
    "--imagegen-report", imagegenPath,
    "--transition-plan", transitionPath,
    "--motion-plan", motionPath,
    "--audio-bed-report", audioBedPath,
    "--prebuild-motion-clips", "true",
    "--prebuild-image-ids", "cut_static",
    "--work-dir", workDir,
    "--motion", "smooth_subpixel_ken_burns",
    "--render-concurrency", "1",
    "--clip-preset", "ultrafast",
    "--width", "320",
    "--height", "180",
    "--fps", "30",
    "--render-scale-multiplier", "1.05",
  ];
  const firstReportPath = path.join(tempDir, "prebuild-first.json");
  await execFileAsync(process.execPath, [...renderArgs, "--report-output", firstReportPath], { cwd: process.cwd() });
  const first = await readJson(firstReportPath);
  assert.equal(first.status, "passed");
  assert.equal(first.motion_clip_cache_generated_count, 1);
  assert.match(path.basename(first.clips[0].motion_clip_path), /^00002-cut_static\.mp4$/);
  const secondReportPath = path.join(tempDir, "prebuild-second.json");
  await execFileAsync(process.execPath, [...renderArgs, "--report-output", secondReportPath], { cwd: process.cwd() });
  const second = await readJson(secondReportPath);
  assert.equal(second.motion_clip_cache_reused_count, 1);
  assert.equal(second.clips[0].motion_clip_cache_key, first.clips[0].motion_clip_cache_key);
}

async function testPreflightLocksNativeTtsSpeedAndSmoothRender() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  await execFileAsync(process.execPath, [
    "scripts/run-preflight.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--title", "Fixture",
    "--image-provider", "modelslab",
    "--image-model", "gpt-image-2-t2i",
    "--reference-model", "gpt-image-2-i2i",
    "--image-fallback-provider", "codex_imagegen",
    "--image-fallback-condition", "modelslab_credit_exhausted",
    "--run-intent", "diagnostic",
    "--allow-dirty-worktree", "true",
    "--dirty-reason", "fixture test",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const identity = await readJson(path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01", "run_identity.json"));
  assert.equal(identity.tts_provider, "qwen_local");
  assert.equal(identity.tts_fallback_provider, null);
  assert.equal(identity.narrator_voice_id, "joel_owned_narrator_clone");
  assert.equal(identity.tts_native_speed, null);
  assert.equal(identity.voice_provider_options.primary.provider, "qwen_local");
  assert.equal(identity.voice_provider_options.primary.voice_id, "joel_owned_narrator_clone");
  assert.equal(identity.voice_provider_options.primary.native_speed, null);
  assert.equal(identity.voice_provider_options.primary.model_id, QWEN_JOEL_PRIMARY_LOCK.model_id);
  assert.equal(identity.voice_provider_options.primary.model_revision, QWEN_JOEL_PRIMARY_LOCK.model_revision);
  assert.equal(identity.voice_provider_options.primary.model_weights_sha256, QWEN_JOEL_PRIMARY_LOCK.model_weights_sha256);
  assert.equal(identity.voice_provider_options.primary.model_config_sha256, QWEN_JOEL_PRIMARY_LOCK.model_config_sha256);
  assert.equal(identity.voice_provider_options.primary.reference_variant_id, "joel_ref_03_dry_deadpan");
  assert.equal(identity.voice_provider_options.primary.reference_audio_sha256, QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK.reference_audio_sha256);
  assert.equal(identity.voice_provider_options.primary.reference_manifest_sha256, QWEN_JOEL_PRIMARY_LOCK.reference_manifest_sha256);
  assert.equal(identity.voice_provider_options.primary.reference_metadata_sha256, QWEN_JOEL_PRIMARY_LOCK.reference_metadata_sha256);
  assert.equal(identity.voice_provider_options.primary.voice_continuity_contract, QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK.voice_continuity_contract);
  assert.equal(identity.voice_provider_options.primary.repetition_penalty, 1.2);
  assert.equal(identity.voice_provider_options.fallback, null);
  const qualityUnitContract = narrationUnitContractForQuality(
    identity.narration_quality_contract,
  );
  const qualityStitchContract = narrationStitchContractForQuality(
    identity.narration_quality_contract,
  );
  assert.deepEqual(identity.voice_provider_options.unit_contract, qualityUnitContract);
  assert.deepEqual(identity.voice_provider_options.stitch_contract, qualityStitchContract);
  assert.deepEqual(identity.voice_provider_options.primary.unit_contract, qualityUnitContract);
  assert.deepEqual(identity.voice_provider_options.primary.stitch_contract, qualityStitchContract);
  assert.deepEqual(identity.voice_provider_options.retry_contract, QWEN_LIAM_RETRY_CONTRACT);
  assert.deepEqual(
    identity.voice_provider_options.synthesis_contract,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  );
  assert.equal(identity.production_profile, "fast_premium_v2");
  assert.equal(identity.generated_motion_policy, "disabled");
  assert.equal(identity.visual_beat_timing_contract.enforcement, "hard_max");
  assert.equal(identity.visual_beat_timing_contract.target_beat_sec, 7.5);
  assert.equal(identity.visual_beat_timing_contract.max_beat_sec, 8);
  assert.equal(identity.visual_beat_timing_contract.retention_ramp_sec, 1200);
  assert.equal(identity.planning_provider, "planning_room");
  assert.equal(identity.planning_effort_policy, DEFAULT_PLANNING_ROOM_EFFORT_POLICY);
  assert.equal(identity.provider_locks.planning_provider, "planning_room");
  assert.equal(identity.provider_locks.planning_model, "stage_routed");
  assert.equal(identity.provider_locks.planning_effort_policy, DEFAULT_PLANNING_ROOM_EFFORT_POLICY);
  assert.equal(identity.planning_room.schema, "goldflow_planning_room_v2");
  assert.equal(identity.planning_room.deterministic_local_reconciliation_provider, "codex_cli");
  assert.equal(identity.planning_room.stage_routes.structured_planning[0], "codex_cli");
  assert.deepEqual(identity.planning_room.structured_pool.providers, {
    codex_cli: {
      concurrency: 12,
      initial_concurrency: 8,
      ramp_successes_per_step: 4,
      ramp_step: 2,
      ramp_policy: "success_gated_in_stage_soak_v1",
    },
    antigravity_cli: { concurrency: 0 },
  });
  assert.equal(identity.provider_locks.planning_default_reasoning_effort, "medium");
  assert.equal(identity.model_versions.planning_reasoning_effort, "medium");
  assert.equal(runIdentityPlanningCompleteForTests(identity).done, true);
  const incompleteWebPlanningIdentity = structuredClone(identity);
  delete incompleteWebPlanningIdentity.provider_locks.planning_default_reasoning_effort;
  assert.equal(runIdentityPlanningCompleteForTests(incompleteWebPlanningIdentity).done, false);
  assert.match(
    runIdentityPlanningCompleteForTests(incompleteWebPlanningIdentity).evidence,
    /provider_locks\.planning_default_reasoning_effort/,
  );
  assert.equal(planningProviderForIdentity(identity), "planning_room");
  assert.equal(identity.production_profile_config.target_wall_clock_minutes, 360);
  assert.deepEqual(identity.production_profile_config.target_wall_clock_band_minutes, { minimum: 300, maximum: 420 });
  assert.equal(identity.production_profile_config.target_wall_clock_policy, "approved_script_to_private_ready_slo_v2");
  assert.equal(identity.production_profile_config.stretch_target_wall_clock_minutes, 300);
  assert.equal(identity.production_profile_config.planner.semantic_concurrency, 12);
  assert.equal(identity.production_profile_config.planner.editorial_concurrency, 12);
  assert.equal(identity.production_profile_config.planner.visual_ref_chunk_concurrency, 12);
  assert.equal(identity.production_profile_config.planner.visual_chunk_concurrency, 12);
  assert.equal(identity.production_profile_config.planner.codex_cli_structured_concurrency, 12);
  assert.equal(identity.production_profile_config.planner.codex_cli_structured_initial_concurrency, 8);
  assert.equal(identity.production_profile_config.planner.antigravity_cli_structured_concurrency, 0);
  assert.equal(identity.production_profile_config.planner.chatgpt_web_semantic_concurrency, 10);
  assert.equal(identity.production_profile_config.planner.chatgpt_web_visual_chunk_concurrency, 10);
  assert.equal(identity.production_profile_config.planner.chatgpt_web_deep_text_concurrency, 1);
  assert.equal(identity.production_profile_config.planner.chatgpt_web_reasoning_starts_per_window, 2);
  assert.equal(identity.production_profile_config.planner.chatgpt_web_reasoning_window_ms, 900_000);
  assert.equal(identity.production_profile_config.media.qwen_tts_concurrency, 1);
  assert.equal(identity.production_profile_config.media.local_qwen_tts_concurrency, 1);
  assert.equal(identity.production_profile_config.media.qwen_tts_batch_size, 4);
  assert.equal(identity.production_profile_config.media.chatgpt_web_reference_concurrency, 0);
  assert.equal(identity.production_profile_config.media.chatgpt_web_image_concurrency, 0);
  assert.equal(identity.production_profile_config.media.chatgpt_web_image_fallback_concurrency, 3);
  assert.equal(identity.production_profile_config.media.google_flow_image_concurrency, 5);
  assert.equal(identity.production_profile_config.media.google_gemini_image_concurrency, 3);
  assert.equal(identity.production_profile_config.media.federated_web_image_concurrency, 8);
  assert.equal(identity.production_profile_config.orchestration.chatgpt_web_browser_host_concurrency, 10);
  assert.deepEqual(
    identity.production_profile_config.audio.local_whisper_timing,
    PRODUCTION_LOCAL_WHISPER_CONTRACT,
  );
  assert.equal(identity.voice_provider_options.pace_strategy, "qwen_reference_native_cadence_no_speed_no_post_tempo");
  assert.equal(identity.production_gates.post_tempo_normalization_default, false);
  assert.equal(identity.render_profile, "smooth_subpixel_ken_burns");
  assert.equal(identity.motion_policy, "selective_editorial_v1");
  assert.equal(identity.parallax_policy, "selective_inspected");
  assert.equal(identity.parallax_target_max, 15);
  assert.equal(identity.parallax_min_spacing_sec, 3);
  assert.equal(identity.parallax_opening_window_sec, 180);
  assert.equal(identity.parallax_first_window_sec, 30);
  assert.equal(identity.parallax_first_window_target, 5);
  assert.equal(identity.parallax_retention_window_target, 10);
  assert.equal(identity.parallax_background_provider, "modelslab_flux_klein");
  assert.equal(identity.provider_locks.parallax_background_provider, "modelslab_flux_klein");
  assert.deepEqual(
    identity.provider_locks.local_whisper_timing,
    PRODUCTION_LOCAL_WHISPER_CONTRACT,
  );
  assert.equal(identity.provider_locks.tts_provider, "qwen_local");
  assert.equal(identity.provider_locks.tts_fallback_provider, null);
  assert.equal(identity.provider_locks.narrator_voice_id, "joel_owned_narrator_clone");
  assert.equal(identity.provider_locks.narrator_voice_identity, "joel_owned_narrator_clone");
  assert.equal(identity.provider_locks.tts_native_speed, null);
  assert.equal(identity.provider_locks.tts_speed_control, "unsupported");
  assert.equal(identity.provider_locks.primary_reference_variant_id, "joel_ref_03_dry_deadpan");
  assert.equal(identity.provider_locks.primary_reference_audio_sha256, QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK.reference_audio_sha256);
  assert.equal(identity.provider_locks.primary_reference_manifest_sha256, QWEN_JOEL_PRIMARY_LOCK.reference_manifest_sha256);
  assert.equal(identity.provider_locks.primary_reference_metadata_sha256, QWEN_JOEL_PRIMARY_LOCK.reference_metadata_sha256);
  assert.equal(identity.provider_locks.primary_voice_continuity_contract, QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK.voice_continuity_contract);
  assert.equal(identity.provider_locks.primary_similarity_model_sha256, QWEN_JOEL_PRIMARY_LOCK.speaker_similarity_model_sha256);
  assert.equal(identity.provider_locks.primary_similarity_calibration_sha256, QWEN_JOEL_PRIMARY_LOCK.speaker_similarity_calibration_sha256);
  assert.equal(identity.provider_locks.primary_minimum_cosine_similarity, null);
  assert.equal(identity.provider_locks.primary_warning_below_cosine_similarity, null);
  assert.equal(identity.provider_locks.primary_similarity_threshold_source, "owned_reference_leave_one_out_calibration");
  assert.equal(identity.provider_locks.primary_universal_similarity_threshold_forbidden, true);
  assert.equal(identity.provider_locks.primary_reference_bank_centroid_required, true);
  assert.equal(identity.provider_locks.primary_reference_bank_minimum_count, 3);
  assert.equal(identity.provider_locks.primary_unit_outliers_review_required, true);
  assert.equal(identity.provider_locks.primary_aggregate_drift_report_required, true);
  assert.equal(identity.provider_locks.tts_unit_target_words_min, 20);
  assert.equal(identity.provider_locks.tts_unit_target_words_max, 42);
  assert.equal(identity.provider_locks.tts_unit_soft_words_max, 48);
  assert.equal(identity.provider_locks.tts_unit_hard_words_max, 60);
  assert.equal(identity.provider_locks.tts_sentence_complete_units, true);
  assert.equal(identity.provider_locks.tts_join_silence_ms, null);
  assert.equal(identity.provider_locks.tts_stitch_contract_version, "narration_alignment_safe_semantic_stitch_v2");
  assert.equal(identity.provider_locks.tts_semantic_boundary_classes, true);
  assert.equal(identity.provider_locks.tts_alignment_required_for_trimming, true);
  assert.equal(identity.provider_locks.tts_missing_alignment_policy, "preserve_entire_unit");
  assert.equal(identity.provider_locks.tts_exact_sample_accounting_required, true);
  assert.equal(identity.provider_locks.tts_continuous_requests, false);
  assert.equal(identity.provider_locks.post_tempo_processing, false);
  assert.equal(identity.provider_locks.tts_retry_policy, QWEN_LIAM_RETRY_CONTRACT.retry_policy);
  assert.equal(identity.provider_locks.tts_automatic_asr_retry, false);
  assert.deepEqual(identity.provider_locks.tts_confirmed_defect_types, ["skip", "truncation", "stutter"]);
  assert.equal(
    identity.provider_locks.tts_synthesis_contract_id,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.contract_id,
  );
  assert.equal(
    identity.provider_locks.tts_synthesis_mode,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode,
  );
  assert.equal(identity.provider_locks.tts_synthesis_api, "Model.batch_generate");
  assert.equal(identity.provider_locks.tts_model_instance_count, 1);
  assert.equal(identity.provider_locks.tts_model_concurrency, 1);
  assert.equal(identity.provider_locks.tts_nominal_batch_size, 4);
  assert.equal(
    identity.provider_locks.tts_batch_scheduler_version,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.scheduler_version,
  );
  assert.equal(
    identity.provider_locks.tts_objective_recovery_mode,
    "serial_exact_unit_recovery_v1",
  );
  assert.equal(
    identity.provider_locks.tts_token_limit_acceptance_allowed,
    false,
  );
  assert.equal(identity.provider_locks.fallback_voice_identity, null);
  assert.equal(identity.provider_locks.fallback_reference_audio_sha256, null);
  assert.equal(identity.production_gates.single_narrator_identity_required, true);
  assert.equal(identity.production_gates.fallback_must_clone_primary_voice_identity, false);
  assert.equal(identity.production_gates.tts_speed_control_supported, false);
  assert.equal(identity.production_gates.sentence_complete_tts_units_required, true);
  assert.equal(identity.production_gates.tts_unit_hard_words_max, 60);
  assert.equal(identity.production_gates.tts_unit_soft_words_max, 48);
  assert.equal(identity.production_gates.tts_join_silence_ms, null);
  assert.equal(identity.production_gates.tts_stitch_contract_version, "narration_alignment_safe_semantic_stitch_v2");
  assert.equal(identity.production_gates.tts_semantic_boundary_classes_required, true);
  assert.equal(identity.production_gates.tts_exact_sample_accounting_required, true);
  assert.equal(identity.production_gates.continuous_longform_tts_requests_forbidden, true);
  assert.equal(
    identity.production_gates.deterministic_length_matched_tts_batching_required,
    true,
  );
  assert.equal(identity.production_gates.tts_nominal_batch_size, 4);
  assert.equal(identity.production_gates.tts_single_resident_model_required, true);
  assert.equal(identity.production_gates.tts_token_limit_outputs_forbidden, true);
  assert.equal(identity.production_gates.tts_objective_recovery_exact_unit_only, true);
  assert.equal(
    identity.production_gates.local_whisper_contract_required,
    true,
  );
  assert.equal(identity.image_output_qa_required, true);
  assert.equal(identity.schema, "goldflow_run_identity_v2");
  assert.equal(typeof identity.git.commit, "string");
  assert.equal(identity.git.commit.length, 40);
  assert.equal(identity.stage_registry_version.length > 0, true);
  assert.equal(identity.model_versions.planning_model, "stage_routed");
  assert.equal(identity.provider_locks.planning_provider_models.chatgpt_web, "gpt-5.6-sol");
  assert.equal(identity.provider_locks.planning_provider_models.codex_cli, "gpt-5.6-sol");
  assert.equal(identity.model_versions.tts_model, QWEN_JOEL_PRIMARY_LOCK.model_id);
  assert.equal(identity.model_versions.tts_model_revision, QWEN_JOEL_PRIMARY_LOCK.model_revision);
  assert.equal(identity.model_versions.fallback_tts_model, null);
  assert.equal(identity.model_versions.fallback_tts_model_revision, null);
  assert.equal(identity.model_versions.local_whisper_model, "small.en");
  assert.equal(identity.model_versions.image_model, "gpt-image-2-t2i");
  assert.equal(identity.model_versions.reference_model, "gpt-image-2-i2i");
  assert.deepEqual(identity.image_provider_options.fallback, {
    provider: "codex_imagegen",
    condition: "modelslab_credit_exhausted",
    operator_approved: true,
    approval_source: "run_preflight_flags",
  });
  assert.equal(codexCreditFallbackEnabled(identity), true);
  assert.equal(runIdentityTtsCompleteForTests(identity).done, true);
  assert.equal(runIdentityWhisperCompleteForTests(identity).done, true);
  assert.match(
    buildStageCommand("local_whisper_word_timing", identity),
    /--engine faster_whisper --model small\.en --device cpu --compute-type int8_float32 --omp-num-threads 12 --cpu-threads 0/,
  );
  assert.match(buildStageCommand("semantic_scene_plan", identity), /--concurrency 12\b/);
  assert.match(buildStageCommand("visual_prompt_plan", identity), /--visual-chunk-concurrency 12\b/);
  assert.match(buildStageCommand("generated_video_motion", identity), /--concurrency 0\b/);
  assert.doesNotMatch(buildStageCommand("generated_video_motion", identity), /--prefetch-coherence-cache true\b/);
  const chatGptWebImageIdentity = structuredClone(identity);
  chatGptWebImageIdentity.image_provider = "chatgpt_web_gpt_image";
  assert.match(buildStageCommand("visual_prompt_plan", chatGptWebImageIdentity), /--visual-chunk-concurrency 12\b/);
  assert.match(buildStageCommand("reference_generation", chatGptWebImageIdentity), /--reference-concurrency 3\b/);
  assert.match(buildStageCommand("image_generation", chatGptWebImageIdentity), /--concurrency 3\b/);
  assert.match(buildStageCommand("image_generation", chatGptWebImageIdentity), /--reference-concurrency 3\b/);
  assert.equal(plannerConcurrencyForIdentity(chatGptWebImageIdentity, 15, { visualPromptWavefront: true }), 15);
  const legacyPlanningIdentity = structuredClone(identity);
  delete legacyPlanningIdentity.planning_provider;
  delete legacyPlanningIdentity.planning_effort_policy;
  delete legacyPlanningIdentity.provider_locks.planning_provider;
  delete legacyPlanningIdentity.provider_locks.planning_model;
  delete legacyPlanningIdentity.provider_locks.planning_effort_policy;
  delete legacyPlanningIdentity.provider_locks.planning_default_reasoning_effort;
  assert.equal(planningProviderForIdentity(legacyPlanningIdentity), "codex_cli");
  assert.equal(runIdentityPlanningCompleteForTests(legacyPlanningIdentity).done, true);
  assert.match(buildStageCommand("semantic_scene_plan", legacyPlanningIdentity), /--concurrency 12\b/);
  const legacySerialQwenIdentity = structuredClone(identity);
  legacySerialQwenIdentity.stage_registry_version = "2026-07-27.1";
  delete legacySerialQwenIdentity.voice_provider_options.synthesis_contract;
  for (const field of [
    "tts_synthesis_contract_id",
    "tts_synthesis_mode",
    "tts_synthesis_api",
    "tts_model_instance_count",
    "tts_model_concurrency",
    "tts_nominal_batch_size",
    "tts_batch_scheduler_version",
    "tts_token_limit_acceptance_allowed",
    "tts_objective_recovery_mode",
  ]) {
    delete legacySerialQwenIdentity.provider_locks[field];
  }
  delete legacySerialQwenIdentity.production_profile_config.media.qwen_tts_batch_size;
  delete legacySerialQwenIdentity.production_gates
    .deterministic_length_matched_tts_batching_required;
  delete legacySerialQwenIdentity.production_gates.tts_single_resident_model_required;
  delete legacySerialQwenIdentity.production_gates.tts_token_limit_outputs_forbidden;
  delete legacySerialQwenIdentity.production_gates.tts_objective_recovery_exact_unit_only;
  assert.equal(
    runIdentityTtsCompleteForTests(legacySerialQwenIdentity).done,
    true,
  );
  assert.match(
    buildStageCommand("qwen_tts_stitch", legacySerialQwenIdentity),
    /--batch-size 1/,
  );
  assert.match(buildStageCommand("reference_generation", identity), /--reference-image-model gpt-image-2-i2i/);
  assert.match(buildStageCommand("qwen_tts_stitch", identity), /tts narrate/);
  assert.match(buildStageCommand("qwen_tts_stitch", identity), /--concurrency 1/);
  assert.match(buildStageCommand("qwen_tts_stitch", identity), /--batch-size 4/);
  assert.match(buildStageCommand("image_generation", identity), /--image-model gpt-image-2-t2i/);
  assert.match(buildStageCommand("semantic_scene_plan", identity), /--concurrency 12/);
  assert.match(buildStageCommand("visual_beat_plan", identity), /--editorial-concurrency 12/);
  assert.match(buildStageCommand("visual_reference_plan", identity), /--visual-ref-chunk-concurrency 12/);
  assert.match(buildStageCommand("visual_prompt_plan", identity), /--visual-chunk-concurrency 12 .*--visual-chunk-validation-attempts 1/);
  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/run-preflight.mjs",
      "--channel", "test",
      "--series", "series",
      "--week", "fenrir-production",
      "--episode", "ep_01",
      "--title", "Fenrir must not enter production",
      "--run-intent", "production",
      "--narrator-voice-id", "am_fenrir",
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } }),
    (error) => /owned Joel reference.*joel_owned_narrator_clone/i.test(String(error?.stderr ?? error?.message ?? error)),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/run-preflight.mjs",
      "--channel", "test",
      "--series", "series",
      "--week", "qwen-primary-production",
      "--episode", "ep_01",
      "--title", "Legacy hosted Qwen is not local Liam",
      "--run-intent", "production",
      "--tts-provider", "modelslab_qwen",
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } }),
    (error) => /production runs require qwen_local with joel_owned_narrator_clone/i.test(
      String(error?.stderr ?? error?.message ?? error),
    ),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/run-preflight.mjs",
      "--channel", "test",
      "--series", "series",
      "--week", "qwen-primary-production-case-bypass",
      "--episode", "ep_01",
      "--title", "Case variants remain production",
      "--run-intent", "Production",
      "--tts-provider", "modelslab_qwen",
      "--qwen-narrator-voice-id", "joel_owned_narrator_clone",
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } }),
    (error) => /production runs require qwen_local with joel_owned_narrator_clone/i.test(
      String(error?.stderr ?? error?.message ?? error),
    ),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/run-preflight.mjs",
      "--channel", "test",
      "--series", "series",
      "--week", "qwen-speed-control-rejected",
      "--episode", "ep_01",
      "--title", "No speed control",
      "--run-intent", "production",
      "--tts-native-speed", "1.2",
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } }),
    (error) => /no native-speed control/i.test(
      String(error?.stderr ?? error?.message ?? error),
    ),
  );
}

function testModelslabCreditFallbackClassification() {
  assert.equal(isModelslabCreditExhaustion("Insufficient credits. Please recharge your wallet."), true);
  assert.equal(isModelslabCreditExhaustion("Cloudflare 524: A timeout occurred"), false);
  assert.equal(isModelslabCreditExhaustion("rate limit, try again"), false);
  assert.deepEqual(creditExhaustedIdsFromReport({
    results: [
      { image_id: "cut_credit", status: "failed", error: "Not enough balance" },
      { image_id: "cut_timeout", status: "failed", error: "524 timeout" },
      { image_id: "cut_pass", status: "generated" },
    ],
  }), ["cut_credit"]);
}

async function testPostTempoRequiresEmergencyApproval() {
  let error = null;
  try {
    await execFileAsync(process.execPath, ["scripts/narration-tempo-normalize.mjs"], { cwd: process.cwd() });
  } catch (caught) {
    error = caught;
  }
  assert.notEqual(error, null);
  assert.match(String(error.stderr ?? error.message), /emergency-only/i);
}

function testPostTempoScalesPreparedStitchTimeline() {
  const [scaled] = scaledSegmentsForTests([{
    unit_id: "tts_001",
    duration_sec: 3.71,
    raw_audio_duration_sec: 4,
    prepared_audio_duration_sec: 3.6,
    inserted_silence_sec: 0.11,
    segment_gap_sec: 0.16,
    unit_gap_sec: 0,
  }], 2);
  assert.equal(scaled.tempo_normalized_from_duration_sec, 3.71);
  assert.equal(scaled.tempo_normalized_from_raw_audio_duration_sec, 4);
  assert.equal(scaled.tempo_normalized_from_prepared_audio_duration_sec, 3.6);
  assert.equal(scaled.tempo_normalized_from_inserted_silence_sec, 0.11);
  assert.equal(scaled.raw_audio_duration_sec, 2);
  assert.equal(scaled.prepared_audio_duration_sec, 1.8);
  assert.equal(scaled.inserted_silence_sec, 0.055);
  assert.equal(scaled.segment_gap_sec, 0.08);
  assert.equal(scaled.unit_gap_sec, 0);
  assert.equal(scaled.duration_sec, 1.855);
  const [legacyScaled] = scaledSegmentsForTests([{
    segment_id: "voice_seg_001",
    duration_sec: 4.16,
    raw_audio_duration_sec: 4,
    prepared_audio_duration_sec: null,
    inserted_silence_sec: null,
    segment_gap_sec: 0.16,
    unit_gap_sec: 0,
  }], 2);
  assert.equal(legacyScaled.raw_audio_duration_sec, 2);
  assert.equal(legacyScaled.segment_gap_sec, 0.08);
  assert.equal(legacyScaled.duration_sec, 2.08);
  assert.equal(legacyScaled.prepared_audio_duration_sec, null);
  assert.equal(legacyScaled.inserted_silence_sec, null);
  const [legacyUnitGapScaled] = scaledSegmentsForTests([{
    segment_id: "voice_seg_002",
    duration_sec: 4.08,
    raw_audio_duration_sec: 4,
    segment_gap_sec: 0,
    unit_gap_sec: 0.08,
  }], 2);
  assert.equal(legacyUnitGapScaled.segment_gap_sec, 0);
  assert.equal(legacyUnitGapScaled.unit_gap_sec, 0.04);
  assert.equal(legacyUnitGapScaled.duration_sec, 2.04);
}

function testLocationSceneIdsDerivation() {
  const semanticScenes = [
    { scene_id: "scene_001", location: "apartment kitchen", ref_requirements: [{ kind: "location", ref_id: "loc_apartment" }] },
    { scene_id: "scene_003", location: "boardroom", ref_requirements: [{ kind: "location", ref_id: "loc_boardroom" }] },
    { scene_id: "scene_005", location: "apartment kitchen", ref_requirements: [{ kind: "location", ref_id: "loc_apartment" }] },
  ];
  const llmTargets = [
    { ref_id: "loc_apartment", kind: "location", scene_ids: ["scene_999"] },
    { ref_id: "loc_boardroom", kind: "location", scene_ids: [] },
    { ref_id: "style_ref", kind: "style", scene_ids: [] },
  ];
  const { targets } = applyDeterministicLocationSceneIds(llmTargets, semanticScenes);
  const apartment = targets.find((target) => target.ref_id === "loc_apartment");
  const boardroom = targets.find((target) => target.ref_id === "loc_boardroom");
  assert.deepEqual(new Set(apartment.scene_ids), new Set(["scene_999", "scene_001", "scene_005"]));
  assert.deepEqual(new Set(boardroom.scene_ids), new Set(["scene_003"]));
  const beatScoped = applyBeatLocationSceneIds([{ ref_id: "loc_gate", kind: "location", scene_ids: ["scene_012"] }], [
    { scene_id: "scene_001", location_id: "loc_gate" },
    { parent_scene_id: "scene_011", location_id: "loc_gate" },
  ]);
  assert.deepEqual(new Set(beatScoped.targets[0].scene_ids), new Set(["scene_012", "scene_001", "scene_011"]));
}

function testCanonicalCharacterIdentitySceneIds() {
  const targets = [
    { ref_id: "joey_identity_ref", kind: "character_state", scene_ids: ["scene_001"] },
    { ref_id: "unrelated_identity_ref", kind: "character_state", scene_ids: ["scene_009"] },
    { ref_id: "hall_ref", kind: "location", scene_ids: ["scene_001"] },
  ];
  const stateRefs = [
    { state_ref_id: "joey_state", character: "Joey Vale", source_ref_id: "joey_identity_ref", scene_ids: ["scene_001"] },
  ];
  const beats = [
    { scene_id: "scene_002", visible_characters: ["Joey Vale"] },
    { parent_scene_id: "scene_003", visible_characters: ["JOEY VALE", "Someone Else"] },
  ];
  const result = applyCanonicalCharacterIdentitySceneIds(targets, stateRefs, beats);
  assert.deepEqual(new Set(result.targets[0].scene_ids), new Set(["scene_001", "scene_002", "scene_003"]));
  assert.deepEqual(result.targets[1].scene_ids, ["scene_009"]);
  assert.deepEqual(result.targets[2].scene_ids, ["scene_001"]);
  assert.deepEqual(result.targets.map((target) => target.ref_id), targets.map((target) => target.ref_id));
  assert.deepEqual(result.additions[0].added_scene_ids, ["scene_002", "scene_003"]);
}

function testReferenceDirectorV2EvidenceAndLocationContracts() {
  const semanticPlan = {
    status: "passed",
    source_script_hash: "fixture_hash",
    scenes: [{
      scene_id: "scene_010",
      location: "marble tribunal hall",
      ref_requirements: [{
        ref_id: "tribunal_hall_contract",
        kind: "location",
        reason: "mandatory scoped location coverage derived from semantic requirements",
      }],
      visual_beats: [{
        visual_beat_id: "beat_w000010_w000020",
        parent_scene_id: "scene_002",
        location_id: "tribunal_hall_contract",
        local_location: "marble tribunal hall",
        ref_needs: [{ kind: "location", ref_id: "tribunal_hall_contract" }],
      }],
    }],
  };
  const evidence = referenceEvidenceLedgerForTests(semanticPlan);
  const locationAsset = evidence.assets.find((asset) => asset.kind === "location" && asset.semantic_ref_ids.includes("tribunal_hall_contract"));
  assert.equal(locationAsset.subject, "marble tribunal hall");
  assert.equal(Object.hasOwn(locationAsset, "generation_mode"), false);

  const contracts = referenceLocationContractLedgerForTests(semanticPlan);
  assert.equal(contracts.status, "passed");
  assert.equal(contracts.contracts.length, 1);
  assert.equal(contracts.contracts[0].description, "marble tribunal hall");
  assert.deepEqual(new Set(contracts.contracts[0].scene_ids), new Set(["scene_010", "scene_002"]));
  assert.equal(Object.hasOwn(contracts.contracts[0], "generation_mode"), false);

  const scoped = referenceLocationScopeForTests([{
    ref_id: "tribunal_clean_plate",
    kind: "location",
    scene_ids: [],
    location_contract_ids: ["tribunal_hall_contract"],
  }], contracts);
  assert.deepEqual(new Set(scoped.targets[0].scene_ids), new Set(["scene_010", "scene_002"]));
  assert.equal(scoped.findings.length, 0);
  const openingFindings = referenceOpeningIdentityFindingsForTests([{
    ref_id: "hero_base",
    kind: "character_state",
    canonical_subject_id: "hero",
    generation_mode: "manual_review",
    required_before_imagegen: false,
  }], {
    status: "passed",
    beats: [{ scene_id: "scene_001", start_sec: 15, preview_visible_entity_ids: ["hero"] }],
  });
  assert.equal(openingFindings.some((finding) => finding.code === "opening_visible_identity_not_generatable"), true);
}

function testReferenceDirectorTreatsDistinctNonhumansAsIdentities() {
  const semanticPlan = {
    status: "passed",
    source_script_hash: "fixture_hash",
    scenes: [{
      scene_id: "scene_001",
      location: "sunken bell chamber",
      visual_beats: [{
        visual_beat_id: "beat_bell_guardian_reveal",
        parent_scene_id: "scene_001",
        start_sec: 20,
        visible_characters: ["Bell Guardian"],
        visible_entities: [{
          entity_id: "bell_guardian",
          display_name: "Bell Guardian",
          kind: "construct",
        }],
        visible_entity_kinds: { bell_guardian: "construct" },
        physically_visible_entity_ids: ["bell_guardian"],
        visual_beat_script_excerpt: "The Bell Guardian lowered its bronze head and charged.",
        local_location: "sunken bell chamber",
      }],
    }],
  };
  const evidence = referenceEvidenceLedgerForTests(semanticPlan);
  const guardian = evidence.assets.find((asset) => asset.subject === "Bell Guardian");
  assert.equal(guardian.kind, "character_state");
  assert.equal(guardian.entity_kind, "construct");
  assert.equal(guardian.entity_type, "distinct_nonhuman_actor");

  const omitted = unselectedDistinctNonhumanActorFindingsForTests(evidence, []);
  assert.equal(omitted.some((finding) => (
    finding.code === "distinct_nonhuman_actor_reference_not_selected"
    && finding.subject === "Bell Guardian"
    && finding.production_blocking === false
  )), true);
  const selected = unselectedDistinctNonhumanActorFindingsForTests(evidence, [{
    ref_id: "bell_guardian_identity",
    kind: "character_state",
    subject: "Bell Guardian",
    canonical_subject_id: "bell_guardian",
    evidence_asset_ids: [guardian.asset_id],
  }]);
  assert.deepEqual(selected, []);
}

function testReferenceDirectorV2RejectsDeterministicExpansionAndDerivedCuts() {
  const baseOptions = {
    llmTargetIds: new Set(["joey_identity_ref", "hall_ref"]),
    knownSceneIds: new Set(["scene_001"]),
  };
  const findings = referenceDirectorSelectionFindingsForTests([
    {
      ref_id: "joey_identity_ref",
      kind: "character_state",
      scene_ids: ["scene_001"],
      generation_mode: "standalone_ref",
      canonical_subject_id: "joey",
      evidence_asset_ids: ["character_state_joey"],
      clean_plate_contract: "single-character plain-background identity card",
    },
    {
      ref_id: "hall_ref",
      kind: "location",
      scene_ids: ["scene_001"],
      generation_mode: "derive_from_best_cut",
      canonical_subject_id: "hall",
      evidence_asset_ids: ["location_hall"],
      clean_plate_contract: "environment-only plate",
    },
    {
      ref_id: "deterministically_restored_prop",
      kind: "prop",
      scene_ids: ["scene_001"],
      generation_mode: "standalone_ref",
      canonical_subject_id: "restored_prop",
      evidence_asset_ids: ["prop_restored"],
      clean_plate_contract: "clean prop plate",
    },
    {
      ref_id: "operator_source_face",
      kind: "character_state",
      scene_ids: ["scene_001"],
      generation_mode: "source_only",
    },
  ], baseOptions);
  assert.equal(findings.some((finding) => finding.code === "director_selected_non_clean_reference_mode" && finding.ref_id === "hall_ref"), true);
  assert.equal(findings.some((finding) => finding.code === "post_llm_reference_target_expansion" && finding.ref_id === "deterministically_restored_prop"), true);
  assert.equal(findings.some((finding) => finding.code === "post_llm_reference_target_expansion" && finding.ref_id === "operator_source_face"), false);
  assert.equal(findings.some((finding) => finding.code === "reference_target_not_single_conditioning_concept" && finding.ref_id === "joey_identity_ref"), true);
}

async function testReferencePlanHashApproval() {
  const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-ref-approval-"));
  const planPath = path.join(episodeDir, "visual_reference_plan.json");
  await writeJson(planPath, {
    status: "passed",
    reference_director_contract_version: "reference_director_v2",
    findings: [],
    reference_targets: [{
      ref_id: "joey_identity_ref",
      kind: "character_state",
      generation_mode: "standalone_ref",
      scene_ids: ["scene_001"],
      conditioning_subject_count: 1,
      conditioning_asset_role: "identity_state",
    }],
  });
  await execFileAsync(process.execPath, [
    "scripts/visual-reference-plan-approve.mjs",
    "--episode-dir", episodeDir,
    "--note", "fixture review",
  ], { cwd: process.cwd() });
  const approval = await readJson(path.join(episodeDir, "reference_plan_approval.json"));
  assert.equal(approval.status, "approved");
  assert.equal(approval.visual_reference_plan_sha256, sha256(await fs.readFile(planPath)));
  const approvedPlan = await readJson(planPath);
  assert.equal(approval.reference_plan_contract_sha256, referencePlanApprovalContractSha256(approvedPlan));
  assert.equal(approval.selected_targets[0].conditioning_asset_role, "identity_state");
  const generatedPlan = {
    ...approvedPlan,
    reference_generation_updated_at: "2026-07-11T12:00:00.000Z",
    reference_targets: approvedPlan.reference_targets.map((target) => ({
      ...target,
      reference_image_path: "/tmp/generated.png",
      conditioning_image_path: "/tmp/generated.png",
    })),
  };
  assert.equal(referencePlanApprovalMatches({ approval, plan: generatedPlan }), true);
  generatedPlan.reference_targets[0].prompt_anchor = "creatively changed identity";
  assert.equal(referencePlanApprovalMatches({ approval, plan: generatedPlan }), false);
}

function testRecurringReferenceCoverageCanonicalizesAliases() {
  const semanticPlan = {
    status: "passed",
    source_script_hash: "fixture_hash",
    scenes: [
      {
        scene_id: "scene_001",
        visual_beats: [{
          visual_beat_id: "beat_001",
          parent_scene_id: "scene_001",
          visible_characters: ["the final guardian"],
          visible_entities: [{ entity_id: "bell_guardian", display_name: "the final guardian", kind: "construct" }],
          physically_visible_entity_ids: ["bell_guardian"],
          local_location: "the drowned vault",
          local_props: ["royal blade"],
          local_ui_elements: ["soul balance"],
        }],
      },
      {
        scene_id: "scene_002",
        visual_beats: [{
          visual_beat_id: "beat_002",
          parent_scene_id: "scene_002",
          visible_characters: ["Bell Guardian"],
          visible_entities: [{ entity_id: "bell_guardian", display_name: "Bell Guardian", kind: "construct" }],
          physically_visible_entity_ids: ["bell_guardian"],
          local_location: "Sunken Vault",
          local_props: ["Death Sword"],
          local_ui_elements: ["Death Ledger"],
        }],
      },
    ],
  };
  const factLedger = {
    canonical_entities: [{ entity_id: "bell_guardian", display_name: "Bell Guardian", aliases: ["the final guardian"] }],
    canonical_locations: [{ location_id: "sunken_vault", display_name: "Sunken Vault", aliases: ["the drowned vault"] }],
    canonical_props: [{ prop_id: "death_sword", display_name: "Death Sword", aliases: ["royal blade"] }],
    canonical_ui_motifs: [{ ui_id: "death_ledger", display_name: "Death Ledger", aliases: ["soul balance"] }],
  };
  const evidence = referenceEvidenceLedgerForTests(semanticPlan, factLedger);
  for (const canonicalId of ["bell_guardian", "sunken_vault", "death_sword", "death_ledger"]) {
    const rows = evidence.assets.filter((asset) => asset.canonical_subject_id === canonicalId);
    assert.equal(rows.length, 1, `${canonicalId} aliases should aggregate into one evidence asset`);
    assert.equal(rows[0].beat_count, 2);
    assert.equal(rows[0].distinct_scene_count, 2);
  }
  const targets = evidence.assets.map((asset) => ({
    ref_id: `${asset.asset_id}_plate`,
    kind: asset.kind,
    subject: asset.subject,
    canonical_subject_id: asset.canonical_subject_id,
    evidence_asset_ids: [asset.asset_id],
    generation_mode: "standalone_ref",
  }));
  assert.deepEqual(recurringReferenceCoverageFindingsForTests(evidence, targets), []);
  const propAsset = evidence.assets.find((asset) => asset.canonical_subject_id === "death_sword");
  const missingProp = recurringReferenceCoverageFindingsForTests(
    evidence,
    targets.filter((target) => !target.evidence_asset_ids.includes(propAsset.asset_id)),
  );
  assert.equal(missingProp.some((finding) => finding.asset_id === propAsset.asset_id), true);

  const characterAsset = evidence.assets.find((asset) => asset.canonical_subject_id === "bell_guardian");
  const faceOnlyDependency = {
    ref_id: "bell_guardian_face_source",
    kind: "character_state",
    subject: "Bell Guardian",
    canonical_subject_id: "bell_guardian",
    evidence_asset_ids: [characterAsset.asset_id],
    generation_mode: "source_only",
    identity_usage: "face_only",
    reference_image_path: "/tmp/bell-guardian-face.png",
    source_origin: "owned_source",
    source_review_status: "approved_clean",
    source_review_receipt_path: "/tmp/bell-guardian-review.json",
    source_image_id: "bell_guardian_face_source",
    source_image_sha256: "a".repeat(64),
  };
  assert.deepEqual(sourceOnlyReferenceFindingsForTests(faceOnlyDependency), []);
  const faceOnlyFindings = recurringReferenceCoverageFindingsForTests(evidence, [
    faceOnlyDependency,
    ...targets.filter((target) => target.canonical_subject_id !== "bell_guardian"),
  ]);
  assert.equal(faceOnlyFindings.some((finding) => finding.asset_id === characterAsset.asset_id), true);

  const evidenceAliasPlan = structuredClone(semanticPlan);
  evidenceAliasPlan.scenes = [{
    scene_id: "scene_001",
    visual_beats: [{ visual_beat_id: "beat_001", parent_scene_id: "scene_001", local_props: ["royal blade"] }],
  }, {
    scene_id: "scene_002",
    visual_beats: [{ visual_beat_id: "beat_002", parent_scene_id: "scene_002", local_props: ["black sword"] }],
  }, {
    scene_id: "scene_003",
    visual_beats: [{ visual_beat_id: "beat_003", parent_scene_id: "scene_003", local_props: ["execution weapon"] }],
  }];
  const evidenceAliasLedger = structuredClone(factLedger);
  evidenceAliasLedger.canonical_props[0].aliases = [];
  evidenceAliasLedger.canonical_props[0].evidence = [
    { exact_excerpt: "He drew the royal blade.", confidence: 0.99 },
    { exact_excerpt: "The black sword drank the light.", confidence: 0.99 },
    { exact_excerpt: "His execution weapon returned.", confidence: 0.99 },
  ];
  const evidenceAliasRows = referenceEvidenceLedgerForTests(evidenceAliasPlan, evidenceAliasLedger)
    .assets.filter((asset) => asset.canonical_subject_id === "death_sword");
  assert.equal(evidenceAliasRows.length, 1, "short exact evidence labels should provide an alias fallback");
  assert.equal(evidenceAliasRows[0].beat_count, 3);
  const oneWordAliasPlan = structuredClone(evidenceAliasPlan);
  oneWordAliasPlan.scenes[0].visual_beats[0].local_props = ["blade"];
  oneWordAliasPlan.scenes[1].visual_beats[0].local_props = ["sword"];
  oneWordAliasPlan.scenes[2].visual_beats[0].local_props = ["weapon"];
  const oneWordAliasRows = referenceEvidenceLedgerForTests(oneWordAliasPlan, evidenceAliasLedger)
    .assets.filter((asset) => asset.canonical_subject_id === "death_sword");
  assert.equal(oneWordAliasRows.length, 1, "unique one-word signature-prop aliases must aggregate");
  assert.equal(oneWordAliasRows[0].beat_count, 3);

  const organizationEvidence = referenceEvidenceLedgerForTests({
    status: "passed",
    source_script_hash: "fixture_hash",
    scenes: [{
      scene_id: "scene_001",
      visual_beats: [{
        visual_beat_id: "beat_organization",
        parent_scene_id: "scene_001",
        ref_needs: [{ kind: "character_state", ref_id: "sample_airline", subject: "Sample Airline" }],
      }],
    }],
  }, {
    canonical_entities: [{
      entity_id: "sample_airline",
      display_name: "Sample Airline",
      kind: "organization",
      aliases: ["the airline"],
    }],
  });
  assert.equal(
    organizationEvidence.assets.some((asset) => asset.canonical_subject_id === "sample_airline"),
    false,
    "organizations must not become character-state reference obligations",
  );
}

function testCharacterReferenceCleanlinessContracts() {
  const validHuman = {
    ref_id: "joey_identity",
    kind: "character_state",
    generation_mode: "standalone_ref",
    conditioning_asset_role: "identity_state",
    reference_cleanliness_contract_version: "empty_hands_no_detachable_props_v1",
    reference_pose: "neutral_single",
    visible_subject_count: 1,
    expected_visible_hands: 2,
    hands_policy: "relaxed_empty",
    detachable_props: [],
    integrated_anatomy_features: [],
    prompt_anchor: "16:9 landscape anime/manhwa reference card, exactly one adult man in a neutral pose on a plain background, exactly two visible hands relaxed and empty.",
  };
  assert.deepEqual(characterReferenceContentFindingsForTests(validHuman), []);
  const carryingCoin = {
    ...validHuman,
    prompt_anchor: `${validHuman.prompt_anchor} He is holding a coin in his right hand.`,
  };
  assert.equal(characterReferenceContentFindingsForTests(carryingCoin).some((finding) => finding.code === "character_reference_anchor_depicts_detachable_prop"), true);
  const negatedAction = {
    ...validHuman,
    prompt_anchor: `${validHuman.prompt_anchor} He is not attacking or fighting.`,
  };
  assert.equal(characterReferenceContentFindingsForTests(negatedAction).some((finding) => finding.code === "character_reference_anchor_depicts_action_pose"), false);
  const amputee = {
    ...validHuman,
    ref_id: "oren_post_amputation",
    expected_visible_hands: 1,
    integrated_anatomy_features: ["left forearm permanently absent below the elbow"],
    prompt_anchor: "16:9 landscape anime/manhwa reference card, exactly one adult man in a neutral pose on a plain background, left forearm permanently absent below the elbow, exactly one visible right hand relaxed and empty.",
  };
  assert.deepEqual(characterReferenceContentFindingsForTests(amputee), []);
  const creature = {
    ...validHuman,
    ref_id: "bell_guardian_identity",
    conditioning_asset_role: "creature_identity",
    identity_subtype: "construct",
    expected_visible_hands: 2,
    hands_policy: "empty_or_unoccupied",
    integrated_anatomy_features: ["one bronze bell integrated into the center of the stone chest"],
    prompt_anchor: "16:9 landscape anime/manhwa creature reference card, exactly one construct in a neutral pose on a plain background, exactly two grasping stone appendages visibly empty and unoccupied, one bronze bell integrated into the center of its chest.",
  };
  assert.deepEqual(characterReferenceContentFindingsForTests(creature), []);
  const embeddedBellCreature = {
    ...creature,
    integrated_anatomy_features: ["one bronze bell embedded in the center of the stone chest beneath a separate stone head"],
    prompt_anchor: "16:9 landscape anime/manhwa creature reference card, exactly one construct in a neutral pose on a plain background, exactly two grasping stone appendages visibly empty and unoccupied, one bronze bell embedded in the center of the stone chest beneath a separate stone head.",
  };
  assert.deepEqual(characterReferenceContentFindingsForTests(embeddedBellCreature), []);
  const contradictoryCreature = {
    ...creature,
    integrated_anatomy_features: ["bell integrated into center of stone chest beneath separate stone head"],
    prompt_anchor: "16:9 landscape anime/manhwa creature reference card, exactly one construct in a neutral pose on a plain background, exactly two grasping stone appendages visibly empty and unoccupied, bronze bell integrated as its head.",
  };
  assert.equal(characterReferenceContentFindingsForTests(contradictoryCreature).some((finding) => finding.code === "integrated_anatomy_missing_from_anchor"), true);
  const underspecifiedBell = {
    ...creature,
    integrated_anatomy_features: ["bronze bell"],
    prompt_anchor: "16:9 landscape anime/manhwa creature reference card, exactly one bronze bell guardian in a neutral pose on a plain background, exactly two grasping stone appendages visibly empty and unoccupied.",
  };
  assert.equal(characterReferenceContentFindingsForTests(underspecifiedBell).some((finding) => finding.code === "integrated_anatomy_attachment_unspecified"), true);
  const contradictoryRole = { ...creature, identity_subtype: "human" };
  assert.equal(characterReferenceContentFindingsForTests(contradictoryRole).some((finding) => finding.code === "character_reference_role_subtype_conflict"), true);
  const noHandsHuman = {
    ...validHuman,
    ref_id: "oren_bilateral_amputee",
    expected_visible_hands: 0,
    integrated_anatomy_features: ["both arms permanently absent at shoulders"],
    prompt_anchor: "16:9 landscape anime/manhwa reference card, exactly one adult man in a neutral pose on a plain background, both arms permanently absent at shoulders, no hands anatomically present.",
  };
  assert.deepEqual(characterReferenceContentFindingsForTests(noHandsHuman), []);
  const noHandsCreature = {
    ...creature,
    ref_id: "serpent_identity",
    expected_visible_hands: 0,
    integrated_anatomy_features: ["long serpentine body without limbs"],
    prompt_anchor: "16:9 landscape anime/manhwa creature reference card, exactly one serpent in a neutral pose on a plain background, long serpentine body without limbs, no grasping appendages anatomically present.",
  };
  assert.deepEqual(characterReferenceContentFindingsForTests(noHandsCreature), []);
  const missingHandCount = { ...validHuman };
  delete missingHandCount.expected_visible_hands;
  assert.equal(characterReferenceContentFindingsForTests(missingHandCount).some((finding) => finding.code === "character_reference_expected_visible_hands_invalid"), true);
  const nullHandCount = { ...validHuman, expected_visible_hands: null };
  assert.equal(characterReferenceContentFindingsForTests(nullHandCount).some((finding) => finding.code === "character_reference_expected_visible_hands_invalid"), true);
  const conflictingHandCount = {
    ...validHuman,
    prompt_anchor: "16:9 landscape anime/manhwa reference card, exactly one adult man in a neutral pose on a plain background, exactly four visible hands relaxed and empty.",
  };
  assert.equal(characterReferenceContentFindingsForTests(conflictingHandCount).some((finding) => finding.code === "character_reference_anchor_hand_count_conflict"), true);

  assert.equal(nonCharacterReferenceContentFindingsForTests({
    ref_id: "sword_prop",
    kind: "prop",
    generation_mode: "standalone_ref",
    prompt_anchor: "16:9 landscape prop plate of a sword held in a warrior's hand.",
  }).some((finding) => finding.code === "prop_reference_anchor_contains_holder"), true);
  assert.equal(nonCharacterReferenceContentFindingsForTests({
    ref_id: "vault_location",
    kind: "location",
    generation_mode: "standalone_ref",
    prompt_anchor: "16:9 landscape environment plate of a vault with two guards in the foreground.",
  }).some((finding) => finding.code === "location_reference_anchor_contains_actor"), true);
  assert.equal(nonCharacterReferenceContentFindingsForTests({
    ref_id: "ledger_ui",
    kind: "ui",
    generation_mode: "standalone_ref",
    prompt_anchor: "16:9 landscape UI plate displayed inside a person's smartphone.",
  }).some((finding) => finding.code === "ui_reference_anchor_contains_actor_or_device"), true);
  for (const safeReference of [{
    ref_id: "clock_prop",
    kind: "prop",
    generation_mode: "standalone_ref",
    prompt_anchor: "16:9 landscape isolated antique clock with a blue clock face and ornate brass hands, no holder.",
  }, {
    ref_id: "automobile_prop",
    kind: "prop",
    generation_mode: "standalone_ref",
    prompt_anchor: "16:9 landscape isolated polished automobile body on a plain neutral field, no people.",
  }, {
    ref_id: "bridge_location",
    kind: "location",
    generation_mode: "standalone_ref",
    prompt_anchor: "16:9 landscape unoccupied bridge with guard rails beside a body of water.",
  }]) {
    assert.deepEqual(nonCharacterReferenceContentFindingsForTests(safeReference), [], `${safeReference.ref_id} must not be a body-part false positive`);
  }
  for (const documentaryReference of [{
    ref_id: "documentary_location",
    kind: "location",
    generation_mode: "standalone_ref",
    prompt_anchor: "16:9 unoccupied baggage hall with realistic human working scale and ample clean space for later characters and luggage, no airline logo, readable signage, people, luggage, or invented machinery.",
  }, {
    ref_id: "documentary_ui",
    kind: "ui",
    generation_mode: "standalone_ref",
    prompt_anchor: "16:9 clean four-node interface motif, no routes, names, flight numbers, timestamps, devices, dense text, location, or people.",
  }, {
    ref_id: "documentary_prop",
    kind: "prop",
    generation_mode: "standalone_ref",
    prompt_anchor: "16:9 isolated sweatshirt on a neutral surface, no logo, readable label, hanger, packaging, person, hand, or additional garment.",
  }]) {
    assert.deepEqual(
      nonCharacterReferenceContentFindingsForTests(documentaryReference),
      [],
      `${documentaryReference.ref_id} comma-separated exclusions must remain negative`,
    );
  }
}

function testFaceOnlySourcesStayDependenciesAndMapNarrowly() {
  const faceTarget = {
    ref_id: "kai_face_source",
    kind: "character_state",
    subject: "Kai",
    canonical_subject_id: "kai",
    generation_mode: "source_only",
    identity_usage: "face_only",
    reference_image_path: "/tmp/kai-face.png",
  };
  const stateTarget = {
    ref_id: "kai_judge_state",
    kind: "character_state",
    subject: "Kai judge state",
    canonical_subject_id: "kai",
    generation_mode: "standalone_ref",
    identity_usage: "full_identity",
  };
  const reconciled = reconcileReferenceIdentityTargetsForTests([faceTarget, stateTarget], [{
    state_ref_id: "kai_judge_state",
    character: "Kai",
    source_ref_id: "kai_judge_state",
    base_identity_ref_id: "kai_face_source",
    identity_usage: "face_only",
  }]);
  assert.equal(reconciled.referenceTargets.find((target) => target.ref_id === "kai_face_source").generation_mode, "source_only");
  assert.equal(reconciled.referenceTargets.find((target) => target.ref_id === "kai_judge_state").generation_mode, "standalone_ref");
  assert.equal(reconciled.characterStateRefs[0].source_ref_id, "kai_judge_state");
  assert.equal(reconciled.characterStateRefs[0].base_identity_ref_id, "kai_face_source");

  assert.equal(referenceTargetNeedsGenerationForTests({ ...faceTarget, required_before_imagegen: true }), false);
  assert.equal(referenceTargetNeedsGenerationForTests({ ...stateTarget, required_before_imagegen: true }), true);
  assert.equal(referenceTargetNeedsGenerationForTests({ ...stateTarget, generation_mode: "manual_review", required_before_imagegen: true }), false);

  const attached = attachReferencePathsToPromptsForTests({
    visual_prompt_hardening_report_path: "/tmp/hardened.json",
    prompts: [{
      image_id: "cut_face_only",
      modelslab_image_prompt: "Kai stands in a black judge coat with both hands empty.",
      reference_requirements: [{ ref_id: "kai_face_source", kind: "character_state", required: true, slot_order: 1 }],
      shot_manifest: { character_staging: [{ name: "Kai", ref_id: "kai_face_source", pose: "standing with empty hands" }] },
    }],
  }, new Map([["kai_face_source", "/tmp/kai-face.png"]]), [], [faceTarget]);
  assert.equal(attached.prompts[0].reference_slots[0].identity_usage, "face_only");
  const mapping = referenceSlotInstructionForTests(attached.prompts[0].reference_slots, attached.prompts[0], { concise: true });
  assert.match(mapping, /facial likeness only/i);
  assert.match(mapping, /scene\/state contract owns body, limbs, hands, wardrobe, pose, objects, and background/i);
}

async function testCleanReferenceApprovalChainIsHashBound() {
  const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-clean-ref-approval-"));
  const sourcePath = path.join(episodeDir, "source-vault.png");
  const generatedPath = path.join(episodeDir, "joey-empty-hands.png");
  const reviewReceiptPath = path.join(episodeDir, "source-clean-review.json");
  const qaReceiptPath = path.join(episodeDir, "source-image-qa.json");
  const planPath = path.join(episodeDir, "visual_reference_plan.json");
  await fs.writeFile(sourcePath, "clean-vault-source");
  await fs.writeFile(generatedPath, "clean-joey-reference");
  const sourceHash = sha256(await fs.readFile(sourcePath));
  await writeJson(reviewReceiptPath, {
    reference_decisions: [{ ref_id: "vault_source", image_id: "cut_vault", image_sha256: sourceHash, decision: "approved_clean" }],
  });
  await writeJson(qaReceiptPath, {
    schema: "goldflow_image_output_qa_v2",
    status: "passed",
    accepted_image_hashes: { cut_vault: sourceHash },
    incremental_accepted_images: [],
  });
  const plan = {
    status: "passed",
    reference_director_contract_version: "reference_director_v2",
    reference_cleanliness_contract_version: "empty_hands_no_detachable_props_v1",
    findings: [],
    reference_targets: [{
      ref_id: "vault_source",
      kind: "location",
      generation_mode: "source_only",
      required_before_imagegen: true,
      reference_image_path: sourcePath,
      conditioning_image_path: sourcePath,
      source_origin: "accepted_production_cut",
      source_review_status: "approved_clean",
      source_review_receipt_path: reviewReceiptPath,
      source_image_id: "cut_vault",
      source_cut_id: "cut_vault",
      source_image_sha256: sourceHash,
      source_image_qa_status: "passed_structural",
      source_image_qa_receipt_path: qaReceiptPath,
    }, {
      ref_id: "joey_identity",
      kind: "character_state",
      generation_mode: "standalone_ref",
      required_before_imagegen: true,
      conditioning_asset_role: "identity_state",
      reference_pose: "neutral_single",
      visible_subject_count: 1,
      expected_visible_hands: 2,
      hands_policy: "relaxed_empty",
      detachable_props: [],
      integrated_anatomy_features: [],
      reference_image_path: generatedPath,
      conditioning_image_path: generatedPath,
    }],
  };
  await writeJson(planPath, plan);
  await execFileAsync(process.execPath, [
    "scripts/visual-reference-plan-approve.mjs",
    "--episode-dir", episodeDir,
    "--note", "fixture clean source review",
  ], { cwd: process.cwd() });
  const planApprovalPath = path.join(episodeDir, "reference_plan_approval.json");
  const planApproval = await readJson(planApprovalPath);
  assert.equal(planApproval.schema, "goldflow_reference_plan_approval_v3");
  assert.equal(planApproval.source_reference_hash_by_ref_id.vault_source, sourceHash);
  assert.equal(Boolean(planApproval.source_reference_hashes[0].source_image_qa_receipt_sha256), true);
  await assertApprovedSourceReferenceHashesForTests(planApproval, plan, { visualReferencePlanPath: planPath });

  const characterStateRefsPath = path.join(episodeDir, "character_state_refs.json");
  await writeJson(characterStateRefsPath, {
    status: "draft_needs_manual_review",
    character_state_refs: [{
      state_ref_id: "joey_identity",
      character: "Joey",
      source_ref_id: "joey_identity",
      reference_image_path: generatedPath,
      conditioning_image_path: generatedPath,
    }],
  });
  await writeJson(path.join(episodeDir, "imagegen_report_codex_manual_ep_01.json"), { status: "passed", reference_only: true });
  await execFileAsync(process.execPath, [
    "scripts/visual-reference-approve.mjs",
    "--episode-dir", episodeDir,
    "--reference-plan-approval", planApprovalPath,
    "--cleanliness-reviewed", "true",
    "--note", "fixture inspected every clean reference",
  ], { cwd: process.cwd() });
  const approvedRefs = await readJson(characterStateRefsPath);
  assert.equal(approvedRefs.reference_cleanliness_decisions.length, 2);
  await assertApprovedMaterializedReferenceHashesForTests(approvedRefs, plan, { visualReferencePlanPath: planPath });

  await fs.writeFile(sourcePath, "mutated-source");
  await assert.rejects(
    assertApprovedSourceReferenceHashesForTests(planApproval, plan, { visualReferencePlanPath: planPath }),
    /hash is stale/i,
  );
  await assert.rejects(
    assertApprovedMaterializedReferenceHashesForTests(approvedRefs, plan, { visualReferencePlanPath: planPath }),
    /approval is stale/i,
  );
}

function testActiveStateValidationSkipsTextOnlyUiMentions() {
  const source = [{
    active_state_constraints: {
      entities: {
        joey_manhwa: { wardrobe: "archive robe" },
      },
    },
  }];
  const uiOnly = [{
    image_id: "cut_ui",
    image_prompt: "A blue system panel names Joey Manhwa as Extra #418.",
    shot_manifest: {
      visible_characters: [],
      mentioned_only_characters: ["Joey Manhwa"],
      character_staging: [],
    },
  }];
  assert.deepEqual(activeStateConstraintFindingsForTests(uiOnly, source), []);
  const visibleJoey = structuredClone(uiOnly);
  visibleJoey[0].shot_manifest.visible_characters = ["Joey Manhwa"];
  const findings = activeStateConstraintFindingsForTests(visibleJoey, source);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].field, "wardrobe");
}

async function testAdaptiveProviderPromptPackets() {
  const highRows = Array.from({ length: 5 }, (_value, index) => ({
    visual_beat_id: `high_${index}`,
    scene_id: "scene_001",
    start_sec: index * 4,
    visible_characters: ["Joey"],
    visual_job: "story_progression",
  }));
  const mediumRows = Array.from({ length: 7 }, (_value, index) => ({
    visual_beat_id: `medium_${index}`,
    scene_id: "scene_002",
    start_sec: 300 + index * 7,
    visible_characters: ["Joey", "Victor"],
    visual_job: "interaction",
  }));
  const simpleRows = Array.from({ length: 12 }, (_value, index) => ({
    visual_beat_id: `simple_${index}`,
    scene_id: "scene_003",
    start_sec: 600 + index * 10,
    visible_characters: ["Joey"],
    visual_job: "story_progression",
  }));
  const chunks = adaptivePromptChunksForTests([...highRows, ...mediumRows, ...simpleRows]);
  assert.deepEqual(chunks.slice(0, 2).map((chunk) => [chunk.risk_class, chunk.ids.length]), [["high", 4], ["high", 4]]);
  assert.equal(chunks.some((chunk) => chunk.risk_class === "medium" && chunk.ids.length === 6), true);
  assert.equal(chunks.some((chunk) => chunk.risk_class === "simple" && chunk.ids.length === 10), true);
  assert.deepEqual(adaptivePromptChunkLimitsForTests({ reasoningEffort: "medium" }), {
    high: 2,
    medium: 3,
    simple: 4,
  });
  assert.deepEqual(adaptivePromptChunkLimitsForTests({
    reasoningEffort: "medium",
    planningProvider: "codex_cli",
  }), {
    high: 4,
    medium: 6,
    simple: 10,
  });
  const mediumWebChunks = adaptivePromptChunksForTests([...highRows, ...mediumRows, ...simpleRows], {
    reasoningEffort: "medium",
  });
  assert.equal(mediumWebChunks.every((chunk) => chunk.ids.length <= 4), true);
  assert.equal(mediumWebChunks.filter((chunk) => chunk.risk_class === "high").every((chunk) => chunk.ids.length <= 2), true);
  assert.equal(mediumWebChunks.filter((chunk) => chunk.risk_class === "medium").every((chunk) => chunk.ids.length <= 3), true);
  assert.equal(visualPromptConcurrencyForEffortForTests(10, "medium"), 1);
  assert.equal(visualPromptConcurrencyForEffortForTests(8, "medium", "codex_cli"), 8);
  assert.equal(visualPromptConcurrencyForEffortForTests(10, "high"), 10);
  assert.equal(isSharedPlannerCooldownErrorForTests("ChatGPT Web cooldown active for 888 more seconds"), true);
  assert.equal(isSharedPlannerCooldownErrorForTests("ChatGPT rate limit: too many requests are being made too quickly"), true);
  assert.equal(isSharedPlannerCooldownErrorForTests("ChatGPT browser stage timed out: browser_page"), false);
  let stopBatch = false;
  const assigned = [];
  const stoppedResults = await mapWithConcurrencyForTests(
    [0, 1, 2, 3, 4],
    3,
    async (item) => {
      assigned.push(item);
      stopBatch = true;
      return { item };
    },
    {
      shouldStop: () => stopBatch,
      stoppedResult: (item) => ({ item, stopped: true }),
    },
  );
  assert.deepEqual(assigned, [0]);
  assert.deepEqual(stoppedResults, [
    { item: 0 },
    { item: 1, stopped: true },
    { item: 2, stopped: true },
    { item: 3, stopped: true },
    { item: 4, stopped: true },
  ]);

  const source = {
    image_id_hint: "ep_01-w000000-w000010",
    visual_beat_id: "beat_w000000_w000010",
    scene_id: "scene_001",
    parent_scene_id: "scene_001",
    start_sec: 0,
    duration_sec: 3.2,
    local_location: "Academy Hall",
    depiction_mode: "document_or_screen",
    physically_visible_entity_ids: [],
    screen_visible_entity_ids: ["joey"],
    preview_visible_entity_ids: [],
    mentioned_only_entity_ids: [],
    visible_characters: ["Joey"],
  };
  const authored = {
    image_id: source.image_id_hint,
    scene_id: "scene_001",
    visual_beat_id: source.visual_beat_id,
    provider_prompt: "Joey raises a blue system panel in Academy Hall. 16:9 landscape anime/manhwa frame.",
    image_provider_route: "modelslab",
    visible_subjects: ["Wrong Duplicate Field"],
    shot_manifest: {
      shot_job: "ui_reveal",
      visible_characters: ["Joey"],
      mentioned_only_characters: [],
      primary_character: "Joey",
      character_state_ref_ids: ["joey_ref"],
      protagonist_state_ref_id: "joey_ref",
      location_contract_id: "hall_contract",
      location_ref_id: null,
      foreground_action: "Joey raises the system panel",
      visible_props: [],
      ui_elements: ["blue system panel"],
      forbidden_ref_ids: [],
      reference_slots: [{ ref_id: "joey_ref", kind: "character_state", slot_order: 1, slot_purpose: "Joey identity" }],
      continuity_notes: "current beat",
      character_staging: [{ name: "Joey", ref_id: "joey_ref", screen_position: "frame-center", wardrobe_from: "character_state_ref:joey_ref", pose: "raising panel" }],
    },
  };
  const visualReferencePlan = { reference_targets: [{ ref_id: "joey_ref", kind: "character_state", scene_ids: ["scene_001"], generation_mode: "standalone_ref" }] };
  const normalized = normalizePromptPacketForTests(authored, source, { activeImageProvider: "modelslab", visualReferencePlan });
  assert.equal(normalized.image_id, source.image_id_hint);
  assert.equal(normalized.modelslab_image_prompt, authored.provider_prompt);
  assert.equal(normalized.codex_image_prompt, null);
  assert.deepEqual(normalized.visible_subjects, ["Joey"]);
  assert.equal(normalized.depiction_mode, "document_or_screen");
  assert.deepEqual(normalized.physically_visible_entity_ids, []);
  assert.deepEqual(normalized.screen_visible_entity_ids, ["joey"]);
  assert.deepEqual(normalized.reference_requirements.map((row) => row.ref_id), ["joey_ref"]);
  const retimed = retimeExistingPromptsForTests([normalized], [{
    ...source,
    start_sec: 0.42,
    duration_sec: 3.48,
    location_timeline_label: "0:00 Academy Hall",
    active_state_constraints: { location_id: "academy_hall", applied_through_source_word_index: 11, entities: {} },
  }]);
  assert.equal(retimed[0].start_sec, 0.42);
  assert.equal(retimed[0].duration_sec, 3.48);
  assert.equal(retimed[0].provider_prompt, normalized.provider_prompt);
  assert.equal(retimed[0].prompt_hash, normalized.prompt_hash);
  assert.deepEqual(retimed[0].shot_manifest, normalized.shot_manifest);
  assert.equal(retimed[0].active_state_constraints.applied_through_source_word_index, 11);
}

function testTruncatedVisualPromptPrefixExtraction() {
  const truncated = '{"style_summary":"dark manhwa","prompts":[{"image_id":"cut_1","visual_beat_id":"beat_1","provider_prompt":"complete"},{"image_id":"cut_2","visual_beat_id":"beat_2","provider_prompt":"truncated';
  assert.deepEqual(extractCompletePromptPrefixForTests(truncated), {
    style_summary: "dark manhwa",
    prompts: [{ image_id: "cut_1", visual_beat_id: "beat_1", provider_prompt: "complete" }],
  });
}

function testRiskClassificationUsesLikelyAttachmentsAndSafeEditorialReuse() {
  const referenceTargets = [
    { ref_id: "joey_ref", kind: "character_state", subject: "Joey", scene_ids: ["scene_001"] },
    { ref_id: "hall_ref", kind: "location", subject: "Academy Hall", scene_ids: ["scene_001"] },
    { ref_id: "unrelated_ui", kind: "ui", subject: "Ranking UI", scene_ids: ["scene_001"] },
    { ref_id: "unrelated_prop", kind: "prop", subject: "Ceremonial Spear", scene_ids: ["scene_001"] },
  ];
  const steady = {
    visual_beat_id: "steady",
    scene_id: "scene_001",
    parent_scene_id: "scene_001",
    start_sec: 600,
    location_id: "academy_hall",
    local_location: "Academy Hall",
    physically_visible_entity_ids: ["joey"],
    visible_characters: ["Joey"],
    visual_job: "story_progression",
    suggested_shot_job: "emotional_reaction",
    local_ui_elements: [],
    local_props: [],
  };
  const assessment = visualUnitRiskAssessmentForTests(steady, { visualReferencePlan: { reference_targets: referenceTargets } });
  assert.equal(assessment.risk_class, "simple");
  assert.equal(assessment.reference_need.candidate_count, 2);
  assert.equal(assessment.reference_need.estimated_count, 2);
  assert.equal(assessment.reasons.includes("four_likely_attached_refs"), false);
  assert.equal(visualUnitRiskAssessmentForTests({ ...steady, start_sec: 20 }, { visualReferencePlan: { reference_targets: referenceTargets } }).risk_class, "high");
  assert.equal(visualUnitRiskAssessmentForTests({ ...steady, visual_job: "physical_action", visual_beat_action: "Joey catches the spear" }, { visualReferencePlan: { reference_targets: referenceTargets } }).risk_class, "simple");

  const rows = [
    { ...steady, image_id_hint: "cut_001", start_sec: 1200, active_state_constraints: { location_id: "academy_hall", entities: { joey: { wardrobe: "blue robe" } } } },
    { ...steady, image_id_hint: "cut_002", start_sec: 1210, active_state_constraints: { location_id: "academy_hall", entities: { joey: { wardrobe: "blue robe" } } } },
    { ...steady, image_id_hint: "cut_003", start_sec: 1220, location_id: "courtyard", local_location: "Courtyard", active_state_constraints: { location_id: "courtyard", entities: { joey: { wardrobe: "blue robe" } } } },
  ];
  const candidates = editorialReuseCandidatesForTests(rows, "ep_01", { thresholdSec: 1200 });
  assert.deepEqual(candidates[0], []);
  assert.deepEqual(candidates[1], ["cut_001"]);
  assert.deepEqual(candidates[2], []);
  const policy = enforceEditorialReusePolicyForTests([
    { image_id: "cut_001", start_sec: 1200, image_strategy: "fresh", editorial_reuse_approved: false },
    { image_id: "cut_002", start_sec: 1210, image_strategy: "reuse_prior_approved", editorial_reuse_approved: true, reuse_source_image_id: "cut_001" },
    { image_id: "cut_003", start_sec: 1220, image_strategy: "reuse_prior_approved", editorial_reuse_approved: true, reuse_source_image_id: "cut_001" },
  ], { thresholdSec: 1200, maxShare: 0.5 });
  assert.equal(policy.policy.accepted_reuse_count, 1);
  assert.equal(policy.prompts[1].editorial_reuse_approved, true);
  assert.equal(policy.prompts[2].editorial_reuse_approved, false);
  assert.equal(policy.prompts[2].editorial_reuse_downgraded_reason, "adjacent_duplicate_hold_forbidden");
}

function testSelectedReferenceInventoryContainsOnlyDirectorSelections() {
  const inventory = selectedReferenceInventoryForTests([
    { ref_id: "joey_ref", kind: "character_state", generation_mode: "standalone_ref", scene_ids: ["scene_001"] },
    { ref_id: "source_face", kind: "character_state", generation_mode: "source_only", scene_ids: ["scene_001"] },
  ]);
  assert.equal(inventory.schema, "goldflow_reference_inventory_ledger_v2");
  assert.deepEqual(inventory.assets.map((asset) => asset.ref_id), ["joey_ref", "source_face"]);
}

function testReferenceDirectorV2BlocksDanglingAndGroupCharacterStates() {
  const findings = referenceCharacterStateFindingsForTests([
    { state_ref_id: "joey_state", character: "Joey", source_ref_id: "joey_ref" },
    { state_ref_id: "dangling_state", character: "Mira", source_ref_id: "missing_mira_ref" },
    { state_ref_id: "guild_masters_state", character: "guild masters", source_ref_id: "guild_uniform_ref" },
  ], [
    { ref_id: "joey_ref", kind: "character_state" },
    { ref_id: "guild_uniform_ref", kind: "prop" },
  ]);
  assert.equal(findings.some((finding) => finding.code === "character_state_ref_missing_selected_source" && finding.state_ref_id === "dangling_state"), true);
  assert.equal(findings.some((finding) => finding.code === "generic_group_character_state_ref" && finding.state_ref_id === "guild_masters_state"), true);
  assert.equal(findings.some((finding) => finding.state_ref_id === "joey_state"), false);
}

function testReferenceIdentityMergePreservesChronologyAndDistinctApexAttackers() {
  const selectedTargets = [
    {
      ref_id: "oren_pike_pre_amputation",
      kind: "character_state",
      subject: "Oren Pike before the forearm amputation",
      canonical_subject_id: "oren_pike",
      base_asset_id: "oren_pike_pre_amputation",
      state_delta: "Pre-amputation operational state with both forearms intact.",
      scene_ids: ["scene_oren_pre"],
      risk_notes: ["preserve both forearms"],
      generation_mode: "standalone_ref",
      required_before_imagegen: true,
      manual_review_required: true,
    },
    {
      ref_id: "oren_pike_post_amputation",
      kind: "character_state",
      subject: "Oren Pike after the permanent forearm amputation",
      canonical_subject_id: "oren_pike",
      base_asset_id: "oren_pike_pre_amputation",
      state_delta: "Post-amputation chronology with both forearms permanently absent.",
      scene_ids: ["scene_oren_post"],
      risk_notes: ["preserve permanent bilateral forearm loss"],
      generation_mode: "standalone_ref",
      required_before_imagegen: true,
      manual_review_required: true,
    },
    ...[
      ["blade_attacker_apex", "Recurring Apex blade attacker", "blade_attacker", "scene_blade"],
      ["fire_caster_apex", "Recurring Apex fire caster", "fire_caster", "scene_fire"],
      ["archer_apex", "Recurring Apex archer", "archer", "scene_archer"],
      ["spear_attacker_apex", "Recurring Apex spear attacker", "spear_attacker", "scene_spear"],
    ].map(([refId, subject, canonicalSubjectId, sceneId]) => ({
      ref_id: refId,
      kind: "character_state",
      subject,
      canonical_subject_id: canonicalSubjectId,
      base_asset_id: null,
      state_delta: null,
      scene_ids: [sceneId],
      risk_notes: [`preserve ${canonicalSubjectId}`],
      generation_mode: "standalone_ref",
      required_before_imagegen: true,
      manual_review_required: true,
    })),
  ];
  const selectedStateRefs = [
    {
      state_ref_id: "oren_pike_pre_amputation",
      character: "Oren Pike",
      source_ref_id: "oren_pike_pre_amputation",
      base_identity_ref_id: null,
      identity_usage: "full_identity",
    },
    {
      state_ref_id: "oren_pike_post_amputation",
      character: "Oren Pike",
      source_ref_id: "oren_pike_post_amputation",
      base_identity_ref_id: "oren_pike_pre_amputation",
      identity_usage: "face_only",
    },
    ...[
      ["blade_attacker_apex", "Blade Attacker"],
      ["fire_caster_apex", "Fire Caster"],
      ["archer_apex", "Archer"],
      ["spear_attacker_apex", "Spear Attacker"],
    ].map(([refId, character]) => ({
      state_ref_id: refId,
      character,
      source_ref_id: refId,
      base_identity_ref_id: null,
      identity_usage: "full_identity",
    })),
  ];

  assert.equal(identityMergeKeyForTests(selectedTargets[0]), "oren_pike");
  assert.equal(identityMergeKeyForTests(selectedTargets[1]), "oren_pike");
  assert.deepEqual(
    selectedTargets.slice(2).map(identityMergeKeyForTests),
    ["blade_attacker", "fire_caster", "archer", "spear_attacker"],
  );

  const reconciled = reconcileReferenceIdentityTargetsForTests(selectedTargets, selectedStateRefs);
  const targetById = new Map(reconciled.referenceTargets.map((target) => [target.ref_id, target]));
  assert.equal(targetById.size, selectedTargets.length);
  for (const selected of selectedTargets) {
    const actual = targetById.get(selected.ref_id);
    assert.ok(actual, `expected ${selected.ref_id} to survive identity reconciliation`);
    assert.equal(actual.generation_mode, "standalone_ref");
    assert.equal(actual.required_before_imagegen, true);
    assert.deepEqual(actual.scene_ids, selected.scene_ids);
    assert.deepEqual(actual.risk_notes, selected.risk_notes);
    assert.equal(actual.canonical_identity_ref_id, undefined);
  }
  assert.deepEqual(reconciled.characterStateRefs, selectedStateRefs);
  assert.equal(
    reconciled.warnings.some((finding) =>
      finding.code === "canonical_identity_ref_merged"
      || finding.code === "character_identity_alias_merged"
    ),
    false,
  );
}

function testLocationCandidateExclusion() {
  const visualReferencePlan = {
    reference_targets: [
      { ref_id: "loc_apartment", kind: "location", scene_ids: ["scene_001", "scene_005"] },
      { ref_id: "loc_boardroom", kind: "location", scene_ids: ["scene_003"] },
      { ref_id: "style_ref", kind: "style", scene_ids: [] },
    ],
  };
  const sceneThreeRefs = referenceTargetsForScene({ scene_id: "scene_003" }, visualReferencePlan).map((target) => target.ref_id);
  assert.deepEqual(new Set(sceneThreeRefs), new Set(["loc_boardroom", "style_ref"]));
  assert.equal(sceneThreeRefs.includes("loc_apartment"), false);
}

function testStarvationGate() {
  const findings = locationCoverageFindings(
    [{ ref_id: "loc_apartment", kind: "location", scene_ids: ["scene_001"] }],
    [
      { scene_id: "scene_001", location: "apartment", ref_requirements: [{ kind: "location", ref_id: "loc_apartment" }] },
      { scene_id: "scene_002", location: "courthouse lobby", ref_requirements: [{ kind: "location", ref_id: "loc_courthouse" }] },
    ]
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "scene_missing_location_ref");
  assert.equal(findings[0].scene_id, "scene_002");
}

function testBroadLocationTargetDoesNotSatisfySemanticLocationRequirement() {
  const findings = locationCoverageFindings(
    [{ ref_id: "creator_classroom_training_refs", kind: "location", scene_ids: ["scene_021"] }],
    [
      {
        scene_id: "scene_021",
        location: "analytics hall replay wall",
        ref_requirements: [{ kind: "location", ref_id: "analytics_hall_replay_wall_ref" }],
      },
    ]
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "scene_missing_location_ref");
  assert.deepEqual(findings[0].required_ref_ids, ["analytics_hall_replay_wall_ref"]);
}

async function testCandidateReferenceBudgetDowngradesScopedOneOffRefs() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const weekDir = path.dirname(path.dirname(episodeDir));
  const hash = "fixture_hash";
  const semanticScenes = [
    {
      scene_id: "scene_001",
      start_sec: 12,
      location: "opening system bedroom",
      ref_requirements: [{ kind: "location", ref_id: "opening_room_ref" }],
    },
    {
      scene_id: "scene_002",
      start_sec: 420,
      location: "late one-off hallway",
      ref_requirements: [{ kind: "location", ref_id: "late_room_ref" }],
    },
    {
      scene_id: "scene_003",
      start_sec: 520,
      location: "minor recurring lobby",
      ref_requirements: [{ kind: "location", ref_id: "minor_lobby_ref" }],
    },
    {
      scene_id: "scene_004",
      start_sec: 620,
      location: "minor recurring lobby",
      ref_requirements: [{ kind: "location", ref_id: "minor_lobby_ref" }],
    },
    {
      scene_id: "scene_005",
      start_sec: 720,
      location: "key recurring throne hall",
      ref_requirements: [{ kind: "location", ref_id: "key_hall_ref" }],
    },
    {
      scene_id: "scene_006",
      start_sec: 820,
      location: "key recurring throne hall",
      ref_requirements: [{ kind: "location", ref_id: "key_hall_ref" }],
    },
    {
      scene_id: "scene_007",
      start_sec: 920,
      location: "key recurring throne hall",
      ref_requirements: [{ kind: "location", ref_id: "key_hall_ref" }],
    },
    {
      scene_id: "scene_008",
      start_sec: 1020,
      location: "late director-selected battle bridge",
      ref_requirements: [{ kind: "location", ref_id: "late_key_anchor_ref" }],
    },
    {
      scene_id: "scene_009",
      start_sec: 1120,
      location: "late director-selected battle bridge",
      ref_requirements: [{ kind: "location", ref_id: "late_key_anchor_ref" }],
    },
  ];
  for (const scene of semanticScenes) {
    scene.visible_subjects = ["Joey Manhwa"];
    if (scene.scene_id === "scene_001" || scene.scene_id === "scene_004") scene.visible_subjects.push("Victor");
    if (scene.scene_id === "scene_004") scene.visible_subjects.push("restrained authority figure");
    scene.props = ["critical recurring poison ring", "one-scene signed receipt"];
    scene.ui_text_on_screen = ["signature system quest UI"];
    if (scene.scene_id === "scene_002") scene.ui_text_on_screen.push("Unauthorized data leak");
  }
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "test",
    series_slug: "manhwa_candidate_validation",
    week: "run",
    episode: "ep_01",
    pace_policy: "diagnostic",
    image_provider: "hybrid_modelslab_refs_codex_opening_modelslab_rest",
    image_provider_options: { codex_opening_sec: 300 },
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    scenes: semanticScenes,
  });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: hash,
    beats: semanticScenes.flatMap((scene) => {
      const repeatCount = scene.scene_id === "scene_008" || scene.scene_id === "scene_009" ? 4 : 1;
      return Array.from({ length: repeatCount }, (_, beatIndex) => ({
        scene_id: scene.scene_id,
        parent_scene_id: scene.scene_id,
        visual_beat_id: `${scene.scene_id}_beat_${String(beatIndex + 1).padStart(2, "0")}`,
        start_sec: scene.start_sec + beatIndex * 8,
        duration_sec: 6,
        visual_beat_script_excerpt: `Joey Manhwa and ${scene.visible_subjects.includes("Victor") ? "Victor" : "the system"} appear in ${scene.location} with the critical poison ring.`,
        visible_characters: scene.visible_subjects,
        local_location: scene.location,
        local_props: scene.scene_id === "scene_002" ? ["one-scene signed receipt", "critical recurring poison ring"] : ["critical recurring poison ring"],
        local_ui_elements: scene.scene_id === "scene_002"
          ? ["signature system quest UI", "Unauthorized data leak"]
          : ["signature system quest UI"],
        ref_needs: [],
      }));
    }),
  });
  await writeJson(path.join(weekDir, "visual_style_bible.json"), { style_summary: "text style bible is sufficient" });
  await writeJson(path.join(weekDir, "character_bible.json"), {});
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: [
      { ref_id: "style_ref", kind: "style", subject: "generated style card", scene_ids: [], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "joey_manhwa_base_identity_ref", kind: "character_state", subject: "Joey Manhwa base identity", scene_ids: ["scene_001"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "char_joey", kind: "character_state", subject: "Joey", scene_ids: ["scene_002"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "victor_base_identity_ref", kind: "character_state", subject: "Victor base identity", scene_ids: ["scene_001"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "char_victor", kind: "character_state", subject: "Victor", scene_ids: ["scene_004"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "restrained_authority_ref", kind: "character_state", subject: "one-scene restrained authority figure", scene_ids: ["scene_004"], prompt_anchor: "16:9 landscape anime/manhwa character card, single restrained authority figure on plain background, restrained styling and composed posture", generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "opening_room_ref", kind: "location", subject: "opening system bedroom", scene_ids: ["scene_001"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "late_room_ref", kind: "location", subject: "late one-off hallway", scene_ids: ["scene_002"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "minor_lobby_ref", kind: "location", subject: "minor recurring lobby", scene_ids: ["scene_003", "scene_004"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "key_hall_ref", kind: "location", subject: "key recurring throne hall", scene_ids: ["scene_005", "scene_006", "scene_007"], priority: "high", generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "late_key_anchor_ref", kind: "location", subject: "late director-selected battle bridge", scene_ids: ["scene_008", "scene_009"], director_role: "key_location_anchor", generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "opening_system_ui_ref", kind: "ui", subject: "signature system quest UI", scene_ids: ["scene_001", "scene_002", "scene_003", "scene_004"], appearance_count: 4, generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "unauthorized_data_leak_ref", kind: "ui", subject: "Unauthorized data leak", scene_ids: ["scene_002"], generation_mode: "no_ref_needed", required_before_imagegen: false },
      { ref_id: "late_ui_ref", kind: "ui", subject: "one-scene hallway notice UI", scene_ids: ["scene_002"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "late_prop_ref", kind: "prop", subject: "one-scene signed receipt", scene_ids: ["scene_002"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "critical_prop_ref", kind: "prop", subject: "critical recurring poison ring", scene_ids: ["scene_002", "scene_003", "scene_004", "scene_005"], priority: "high", generation_mode: "standalone_ref", required_before_imagegen: true },
    ],
    character_state_refs: [
      { state_ref_id: "joey_state", character: "Joey Manhwa", source_ref_id: "char_joey", scene_ids: ["scene_002"] },
      { state_ref_id: "victor_state", character: "Victor", source_ref_id: "char_victor", scene_ids: ["scene_004"] },
    ],
  });
  await execFileAsync(process.execPath, [
    "scripts/visual-reference-plan.mjs",
    "--channel", "test",
    "--series", "manhwa_candidate_validation",
    "--week", "run",
    "--episode", "ep_01",
    "--revalidate-existing", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "visual_reference_plan.json"), "utf8"));
  const byId = new Map(report.reference_targets.map((target) => [target.ref_id, target]));
  assert.equal(report.reference_budget.applied, true);
  assert.equal(byId.has("style_ref"), false);
  assert.equal(byId.get("joey_manhwa_base_identity_ref").required_before_imagegen, true);
  assert.equal(byId.has("char_joey"), false);
  assert.equal(byId.has("char_victor"), false);
  assert.equal(byId.has("restrained_authority_ref"), false);
  assert.equal(byId.get("opening_room_ref").required_before_imagegen, false);
  assert.equal(byId.get("opening_room_ref").generation_mode, "derive_from_first_clean_wide_cut");
  assert.equal(byId.has("late_room_ref"), false);
  assert.equal(byId.has("late_ui_ref"), false);
  assert.equal(byId.has("late_prop_ref"), false);
  assert.equal(byId.get("minor_lobby_ref").generation_mode, "derive_from_first_clean_wide_cut");
  assert.equal(byId.get("key_hall_ref").required_before_imagegen, true);
  assert.equal(byId.get("late_key_anchor_ref").required_before_imagegen, false);
  assert.match(byId.get("late_key_anchor_ref").generation_mode, /^derive_from_/);
  assert.equal(byId.get("late_key_anchor_ref").reference_budget.decision, "text_only");
  assert.equal(byId.get("opening_system_ui_ref").required_before_imagegen, true);
  assert.equal(byId.get("unauthorized_data_leak_ref").required_before_imagegen, true);
  assert.equal(byId.get("critical_prop_ref").required_before_imagegen, true);
  assert.equal(report.reference_targets.some((target) => target.generation_mode === "no_ref_needed"), false);
  const stateRefs = JSON.parse(await fs.readFile(path.join(episodeDir, "character_state_refs.json"), "utf8"));
  const joeyState = stateRefs.character_state_refs.find((ref) => ref.state_ref_id === "joey_state");
  assert.equal(joeyState.source_ref_id, "joey_manhwa_base_identity_ref");

  await execFileAsync(process.execPath, [
    "scripts/visual-reference-plan.mjs",
    "--channel", "test",
    "--series", "manhwa_candidate_validation",
    "--week", "run",
    "--episode", "ep_01",
    "--revalidate-existing", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const revalidated = JSON.parse(await fs.readFile(path.join(episodeDir, "visual_reference_plan.json"), "utf8"));
  assert.equal(revalidated.status, "passed");
  assert.equal(revalidated.reference_targets.some((target) => target.generation_mode === "no_ref_needed"), false);
}

async function testReferenceDirectorInventoryPreventsCollectorBloat() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const weekDir = path.dirname(path.dirname(episodeDir));
  const hash = "fixture_hash";
  const semanticScenes = Array.from({ length: 8 }, (_, index) => ({
    scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
    start_sec: index * 90,
    location: index < 2 ? "opening guild gate" : `one-off chamber ${index + 1}`,
    visible_subjects: index % 2 === 0 ? ["Joey Manhwa", "guild masters"] : ["Joey Manhwa"],
    props: [`one-off relic ${index + 1}`, index < 4 ? "poison ring" : `document ${index + 1}`],
    ref_requirements: [
      { kind: "location", ref_id: index < 2 ? "opening_guild_gate_ref" : `one_off_chamber_${index + 1}_ref`, reason: "semantic scoped location target" },
      { kind: "prop", ref_id: `one_off_relic_${index + 1}_ref`, reason: "semantic prop candidate, not automatic standalone" },
    ],
  }));
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "test",
    series_slug: "manhwa_candidate_validation",
    week: "run",
    episode: "ep_01",
    pace_policy: "diagnostic",
    image_provider: "modelslab",
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    scenes: semanticScenes,
  });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: hash,
    beats: semanticScenes.flatMap((scene, sceneIndex) => [0, 1].map((beatIndex) => ({
      scene_id: scene.scene_id,
      parent_scene_id: scene.scene_id,
      visual_beat_id: `${scene.scene_id}_beat_${String(beatIndex + 1).padStart(2, "0")}`,
      start_sec: scene.start_sec + beatIndex * 8,
      duration_sec: 8,
      location: scene.location,
      local_location: scene.location,
      visual_beat_script_excerpt: beatIndex === 0
        ? `Joey Manhwa faces the guild masters in ${scene.location}.`
        : `The poison ring matters while one-off relic ${sceneIndex + 1} sits nearby.`,
      visible_characters: beatIndex === 0 ? ["Joey Manhwa", "guild masters"] : ["Joey Manhwa"],
      local_props: beatIndex === 1 ? ["poison ring", `one-off relic ${sceneIndex + 1}`] : [],
      local_ui_elements: sceneIndex < 3 && beatIndex === 1 ? ["system ledger UI"] : [],
      ref_needs: [
        {
          ref_id: sceneIndex < 2 ? "opening_guild_gate_ref" : `one_off_chamber_${sceneIndex + 1}_ref`,
          kind: "location",
          subject: scene.location,
          generation_mode: sceneIndex < 2 ? "standalone_ref" : "standalone_ref",
          reason: "fixture advisory location need",
        },
        {
          ref_id: `one_off_relic_${sceneIndex + 1}_ref`,
          kind: "prop",
          subject: `one-off relic ${sceneIndex + 1}`,
          generation_mode: "standalone_ref",
          reason: "fixture advisory prop need that should not force standalone generation",
        },
      ],
    }))),
  });
  await writeJson(path.join(weekDir, "visual_style_bible.json"), { style_summary: "text style bible is sufficient" });
  await writeJson(path.join(weekDir, "character_bible.json"), {});
  const bloatedTargets = [
    { ref_id: "joey_manhwa_base_identity_ref", kind: "character_state", subject: "Joey Manhwa base identity", scene_ids: semanticScenes.map((scene) => scene.scene_id), generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "joey_manhwa_ref", kind: "character_state", subject: "Joey Manhwa", scene_ids: semanticScenes.slice(2, 5).map((scene) => scene.scene_id), generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "joey_manhwa_bloodied_chamber_state_ref", kind: "character_state", subject: "Joey Manhwa bloodied one chamber state", scene_ids: ["scene_006"], generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "char_harlan_voss_ref", kind: "character_state", subject: "Harlan Voss raid captain identity", scene_ids: ["scene_002", "scene_003"], generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "harlan_voss_ref", kind: "character_state", subject: "Harlan Voss", scene_ids: ["scene_004"], generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "captain_harlan_voss_court_restrained_state", kind: "character_state", subject: "Captain Harlan Voss court restrained state", scene_ids: ["scene_005"], generation_mode: "derive_from_best_cut", required_before_imagegen: false },
    { ref_id: "guild_masters_group_faces_ref", kind: "character_state", subject: "guild masters group uniform system", scene_ids: ["scene_001", "scene_003", "scene_005"], generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "opening_guild_gate_ref", kind: "location", subject: "opening guild gate", scene_ids: ["scene_001", "scene_002"], generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "system_ledger_ui_ref", kind: "ui", subject: "signature system ledger UI", scene_ids: ["scene_001", "scene_002", "scene_003"], appearance_count: 3, generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "poison_ring_ref", kind: "prop", subject: "critical recurring poison ring", scene_ids: ["scene_001", "scene_002", "scene_003", "scene_004"], priority: "high", generation_mode: "standalone_ref", required_before_imagegen: true },
    ...semanticScenes.map((scene, index) => ({
      ref_id: `one_off_relic_${index + 1}_ref`,
      kind: "prop",
      subject: `one-off relic ${index + 1}`,
      scene_ids: [scene.scene_id],
      generation_mode: "standalone_ref",
      required_before_imagegen: true,
    })),
    ...semanticScenes.slice(2).map((scene, index) => ({
      ref_id: `one_off_chamber_${index + 3}_ref`,
      kind: "location",
      subject: scene.location,
      scene_ids: [scene.scene_id],
      generation_mode: "standalone_ref",
      required_before_imagegen: true,
    })),
  ];
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: bloatedTargets,
    character_state_refs: [
      { state_ref_id: "joey_base_state", character: "Joey Manhwa", source_ref_id: "joey_manhwa_base_identity_ref", scene_ids: semanticScenes.map((scene) => scene.scene_id) },
      { state_ref_id: "joey_plain_duplicate_state", character: "Joey Manhwa", source_ref_id: "joey_manhwa_ref", scene_ids: ["scene_003"] },
      { state_ref_id: "joey_bloodied_chamber_state", character: "Joey Manhwa", source_ref_id: "joey_manhwa_bloodied_chamber_state_ref", scene_ids: ["scene_006"] },
      { state_ref_id: "captain_harlan_voss_court_restrained_state", character: "Captain Harlan Voss", source_ref_id: "captain_harlan_voss_court_restrained_state", base_identity_ref_id: "char_captain_harlan_voss_ref", scene_ids: ["scene_005"] },
      { state_ref_id: "guild_masters_group_state", character: "guild masters", source_ref_id: "guild_masters_group_faces_ref", scene_ids: ["scene_001", "scene_003", "scene_005"] },
    ],
  });

  await execFileAsync(process.execPath, [
    "scripts/visual-reference-plan.mjs",
    "--channel", "test",
    "--series", "manhwa_candidate_validation",
    "--week", "run",
    "--episode", "ep_01",
    "--revalidate-existing", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });

  const report = await readJson(path.join(episodeDir, "visual_reference_plan.json"));
  const ledger = await readJson(path.join(episodeDir, "reference_inventory_ledger.json"));
  const stateRefs = await readJson(path.join(episodeDir, "character_state_refs.json"));
  const byId = new Map(report.reference_targets.map((target) => [target.ref_id, target]));
  assert.equal(ledger.schema, "goldflow_reference_inventory_ledger_v1");
  assert.equal(report.reference_inventory_ledger_path.endsWith("reference_inventory_ledger.json"), true);
  assert.equal(ledger.summary.asset_count > report.reference_targets.length, true);
  assert.equal(byId.get("joey_manhwa_base_identity_ref").required_before_imagegen, true);
  assert.equal(byId.has("joey_manhwa_ref"), false);
  assert.equal(byId.has("joey_manhwa_bloodied_chamber_state_ref"), false);
  assert.equal(byId.has("char_harlan_voss_ref"), true);
  assert.equal(byId.has("harlan_voss_ref"), false);
  assert.equal(byId.has("captain_harlan_voss_court_restrained_state"), false);
  assert.equal(byId.has("guild_masters_group_faces_ref"), false);
  assert.equal(byId.has("one_off_chamber_3_ref"), false);
  assert.equal(byId.has("one_off_relic_1_ref"), false);
  assert.equal(byId.get("poison_ring_ref").required_before_imagegen, true);
  assert.equal(byId.get("system_ledger_ui_ref").required_before_imagegen, true);
  assert.equal(report.reference_targets.some((target) => target.generation_mode === "no_ref_needed"), false);
  assert.deepEqual(stateRefs.character_state_refs.map((ref) => ref.state_ref_id), ["joey_base_state", "joey_plain_duplicate_state", "captain_harlan_voss_court_restrained_state"]);
  assert.equal(stateRefs.character_state_refs.find((ref) => ref.state_ref_id === "joey_plain_duplicate_state").source_ref_id, "joey_manhwa_base_identity_ref");
  assert.equal(stateRefs.character_state_refs.find((ref) => ref.state_ref_id === "captain_harlan_voss_court_restrained_state").source_ref_id, "char_harlan_voss_ref");
  assert.equal(stateRefs.character_state_refs.find((ref) => ref.state_ref_id === "captain_harlan_voss_court_restrained_state").base_identity_ref_id, "char_harlan_voss_ref");
  assert.equal(report.warnings.some((warning) => warning.code === "director_pruned_text_only_reference_target"), true);
  assert.equal(report.warnings.some((warning) => warning.code === "director_pruned_text_only_character_state_ref"), true);
}

function testOutOfScopeRefDropping() {
  const scene = { scene_id: "scene_001" };
  const visualReferencePlan = {
    reference_targets: [
      { ref_id: "loc_apartment", kind: "location", scene_ids: ["scene_001"] },
      { ref_id: "char_joey_ref", kind: "character_state", scene_ids: ["scene_001"] },
      { ref_id: "style_ref", kind: "style", scene_ids: [] },
    ],
  };
  const characterStateRefs = [
    { state_ref_id: "char_joey_state", source_ref_id: "char_joey_ref", scene_ids: ["scene_001"] },
  ];
  const allowed = allowedRefIdsForScene({ scene, visualReferencePlan, characterStateRefs });
  const prompt = {
    reference_requirements: [
      { ref_id: "loc_apartment", kind: "location" },
      { ref_id: "loc_wrong", kind: "location" },
    ],
    reference_usage: [],
    shot_manifest: {
      location_ref_id: "loc_wrong",
      character_state_ref_ids: ["char_joey_state", "char_wrong_state"],
      protagonist_state_ref_id: "char_wrong_protagonist",
    },
  };
  const sanitized = dropOutOfScopePromptRefs(prompt, allowed);
  assert.equal(sanitized.shot_manifest.location_ref_id, null);
  assert.deepEqual(sanitized.shot_manifest.character_state_ref_ids, ["char_joey_state"]);
  assert.equal(sanitized.shot_manifest.protagonist_state_ref_id, null);
  assert.deepEqual(sanitized.reference_requirements.map((requirement) => requirement.ref_id), ["loc_apartment"]);
  const droppedFields = sanitized.reference_usage
    .filter((usage) => usage.usage === "out_of_scope_ref_dropped")
    .map((usage) => usage.field);
  assert.deepEqual(new Set(droppedFields), new Set([
    "shot_manifest.location_ref_id",
    "shot_manifest.character_state_ref_ids",
    "shot_manifest.protagonist_state_ref_id",
    "reference_requirements.ref_id",
  ]));
}

function testReferenceLimitOmissionIsNotForbidden() {
  const allowed = new Set(["loc_stage", "char_joey_ref", "char_pookie_ref", "char_kai_ref", "char_jinx_ref"]);
  const prompt = {
    reference_requirements: [
      { ref_id: "char_joey_ref", kind: "character_state" },
      { ref_id: "char_pookie_ref", kind: "character_state" },
      { ref_id: "char_kai_ref", kind: "character_state" },
      { ref_id: "char_jinx_ref", kind: "character_state" },
    ],
    reference_usage: [
      {
        ref_id: "loc_stage",
        usage: "available_not_attached_reference_limit",
        reason: "Four visible character refs fill the available reference slots.",
      },
    ],
    shot_manifest: {
      forbidden_ref_ids: ["loc_stage", "wrong_location_ref"],
    },
  };
  const sanitized = dropOutOfScopePromptRefs(prompt, allowed);
  assert.deepEqual(sanitized.shot_manifest.forbidden_ref_ids, ["wrong_location_ref"]);
  assert.equal(sanitized.reference_usage.some((usage) => (
    usage.ref_id === "loc_stage"
    && usage.usage === "non_forbidden_ref_removed_from_forbidden_ref_ids"
    && usage.field === "shot_manifest.forbidden_ref_ids"
  )), true);
}

function testPositiveAttachmentConsensusRemovesForbiddenConflict() {
  const allowed = new Set(["nora_identity", "wrong_prop"]);
  const sanitized = dropOutOfScopePromptRefs({
    reference_requirements: [
      { ref_id: "nora_identity", kind: "character_state" },
      { ref_id: "wrong_prop", kind: "prop" },
    ],
    reference_usage: [],
    shot_manifest: {
      visible_characters: ["Nora"],
      character_state_ref_ids: ["nora_identity"],
      reference_slots: [
        { ref_id: "nora_identity", kind: "character_state" },
        { ref_id: "wrong_prop", kind: "prop" },
      ],
      forbidden_ref_ids: ["nora_identity", "wrong_prop"],
    },
  }, allowed);
  assert.deepEqual(sanitized.shot_manifest.forbidden_ref_ids, ["wrong_prop"]);
  assert.equal(sanitized.reference_usage.some((usage) => (
    usage.ref_id === "nora_identity"
    && usage.usage === "positive_attachment_consensus_removed_from_forbidden_ref_ids"
  )), true);
}

function testOutOfScopeLocationMentionAssertion() {
  const mentions = outOfScopeLocationRefMentions({
    text: "A polished frame accidentally names loc_boardroom inside an apartment beat.",
    locationTargets: [
      { ref_id: "loc_apartment", kind: "location" },
      { ref_id: "loc_boardroom", kind: "location" },
    ],
    allowedLocationRefId: "loc_apartment",
  });
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].code, "out_of_scope_location_ref_mentioned");
  assert.equal(mentions[0].severity, "blocker");
}

function testProviderAwarePromptSelection() {
  const prompt = {
    image_prompt: "generic production prompt",
    modelslab_image_prompt: "modelslab flux prompt",
    codex_image_prompt: "codex openai prompt",
  };
  assert.equal(promptTextForImageProvider(prompt, "modelslab"), "modelslab flux prompt");
  assert.equal(promptTextForImageProvider(prompt, "codex_imagegen"), "codex openai prompt");
  assert.equal(promptTextForImageProvider(prompt, "chatgpt_web_gpt_image"), "codex openai prompt");
  assert.equal(promptTextForImageProvider({ ...prompt, codex_image_prompt: "" }, "codex_imagegen"), "generic production prompt");
}

function testGptImage2PreservesFullPromptAndUsesLandscapeDefault() {
  const prompt = [
    "Anime/manhwa fantasy frame.",
    "Joey Manhwa strains beneath a shattered carriage wheel while Arielle Seorin, an adult silver-haired noble student, remains pinned under the axle.",
    "Preserve Joey's dark academy uniform, Arielle's moon earrings, and the exact physical rescue staging.",
  ].join(" ").repeat(8);
  const prepared = prepareGptImage2PromptForTests(prompt);
  assert.equal(prepared.prompt, prompt);
  assert.equal(prepared.compacted, false);
  assert.equal(prepared.original_length, prompt.length);
  assert.equal(prepared.submitted_length, prompt.length);
  const [width, height] = gptImage2OutputSizeForTests().split("x").map(Number);
  assert.equal(width > height, true, "GPT Image 2 production request must default to native landscape");
}

function testSceneImageProductionContractBlocksDroppedRefsAndStyle() {
  const broken = scenePromptProductionContractFindingsForTests([{
    image_id: "ep_01-cut-044",
    modelslab_image_prompt: "Joey runs toward the carriage.",
    reference_requirements: [{
      ref_id: "char_arielle_ref",
      kind: "character_state",
      required: true,
      reference_image_path: "/tmp/arielle.png",
    }],
    reference_slots: [],
    shot_manifest: { shot_job: "physical_action", foreground_action: "" },
  }], { maxSceneReferences: 0 });
  assert.equal(broken.some((finding) => finding.code === "required_scene_references_disabled"), true);
  assert.equal(broken.some((finding) => finding.code === "required_reference_slot_missing"), true);
  assert.equal(broken.some((finding) => finding.code === "scene_prompt_style_contract_missing"), true);
  assert.equal(broken.some((finding) => finding.code === "physical_action_contract_missing"), true);

  const passed = scenePromptProductionContractFindingsForTests([{
    image_id: "ep_01-cut-044",
    modelslab_image_prompt: "Anime/manhwa frame. Joey runs toward the carriage while silver-haired Arielle remains pinned under the axle.",
    reference_requirements: [{
      ref_id: "char_arielle_ref",
      kind: "character_state",
      required: true,
      reference_image_path: "/tmp/arielle.png",
    }],
    reference_slots: [{ slot: 1, ref_id: "char_arielle_ref", kind: "character_state", path: "/tmp/arielle.png" }],
    shot_manifest: { shot_job: "physical_action", foreground_action: "Joey runs toward pinned Arielle" },
  }], { maxSceneReferences: 4 });
  assert.deepEqual(passed, []);

  const stateAliasPlan = attachReferencePathsToPromptsForTests({
    prompt_policy: "deterministic hardening fixture",
    prompts: [{
      image_id: "ep_01-cut-state-alias",
      modelslab_image_prompt: "Anime/manhwa frame of Arielle studying a curse on her wrist.",
      reference_requirements: [{
        ref_id: "arielle_curse_state",
        base_identity_ref_id: "arielle_base",
        kind: "character_state",
        required: true,
      }],
      shot_manifest: {
        shot_job: "body_state_proof",
        protagonist_state_ref_id: "arielle_curse_state",
        character_state_ref_ids: ["arielle_curse_state"],
      },
    }],
  }, new Map([["arielle_base", "/tmp/arielle-base.png"]]), [{
    state_ref_id: "arielle_curse_state",
    source_ref_id: "arielle_base",
    base_identity_ref_id: "arielle_base",
  }]);
  assert.deepEqual(stateAliasPlan.prompts[0].reference_slots, [{
    slot: 1,
    ref_id: "arielle_curse_state",
    kind: "character_state",
    subject: "arielle_curse_state",
    conditioning_asset_role: null,
    identity_subtype: null,
    identity_usage: null,
    reference_priority: null,
    path: "/tmp/arielle-base.png",
    purpose: "character identity and wardrobe for arielle_curse_state",
    reason: null,
  }]);
  assert.equal(stateAliasPlan.prompts[0].reference_requirements.length, 1);
  assert.deepEqual(scenePromptProductionContractFindingsForTests(stateAliasPlan.prompts, { maxSceneReferences: 4 }), []);

  const duplicateAliasPlan = attachReferencePathsToPromptsForTests({
    prompt_policy: "deterministic hardening fixture",
    prompts: [{
      image_id: "ep_01-cut-duplicate-alias",
      modelslab_image_prompt: "Anime/manhwa frame of Tamsin addressing Joey.",
      reference_requirements: [
        { ref_id: "tamsin_core_state", kind: "character_state", required: true, slot_order: 1 },
        { ref_id: "tamsin_identity_ref", kind: "character_state", required: true, slot_order: 2 },
        { ref_id: "hall_ref", kind: "location", required: true, slot_order: 3 },
      ],
      shot_manifest: { shot_job: "interaction" },
    }],
  }, new Map([
    ["tamsin_identity_ref", "/tmp/tamsin.png"],
    ["hall_ref", "/tmp/hall.png"],
  ]), [{
    state_ref_id: "tamsin_core_state",
    source_ref_id: "tamsin_identity_ref",
    character: "Tamsin",
  }]);
  assert.deepEqual(
    duplicateAliasPlan.prompts[0].reference_slots.map((slot) => slot.ref_id),
    ["tamsin_core_state", "hall_ref"],
    "state aliases that resolve to the same conditioning raster must consume one attachment slot",
  );
  assert.equal(
    duplicateAliasPlan.prompts[0].reference_usage.find((row) => row.ref_id === "tamsin_identity_ref")?.usage,
    "available_not_attached_duplicate_resolved_reference",
  );
  assert.deepEqual(
    scenePromptProductionContractFindingsForTests(duplicateAliasPlan.prompts, { maxSceneReferences: 4 }),
    [],
    "one attached conditioning raster must satisfy every required alias that resolves to that exact asset",
  );
}

async function testWorkManifestDeduplicatesReferenceAliasesByContentHash() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-ref-alias-"));
  const firstPath = path.join(root, "tamsin_core_state.png");
  const aliasPath = path.join(root, "tamsin_identity_ref.png");
  const hallPath = path.join(root, "hall.png");
  await fs.writeFile(firstPath, Buffer.from("same female conditioning raster"));
  await fs.writeFile(aliasPath, Buffer.from("same female conditioning raster"));
  await fs.writeFile(hallPath, Buffer.from("different environment raster"));
  const bound = await bindReferenceInputsForTests([
    { ref_id: "tamsin_core_state", path: firstPath, slot_order: 1 },
    { ref_id: "tamsin_identity_ref", path: aliasPath, slot_order: 2 },
    { ref_id: "hall_ref", path: hallPath, slot_order: 3 },
  ], root);
  assert.deepEqual(bound.map((row) => row.ref_id), ["tamsin_core_state", "hall_ref"]);
  assert.deepEqual(bound.map((row) => row.slot), [1, 2]);
}

function testGroupReferencePromptDoesNotDemandOnePerson() {
  const prompt = referencePromptForTests({
    ref_id: "senior_squad_ref",
    kind: "character_state",
    subject: "senior squad faction group",
    prompt_anchor: "four distinct academy seniors in one shared armor design",
  });
  assert.match(prompt, /three to five clearly distinct visible people/i);
  assert.match(prompt, /every visible hand is relaxed, clearly readable, separated from the body, and empty/i);
  assert.match(prompt, /reusable weapons and props belong to separate prop plates/i);
  assert.doesNotMatch(prompt, /exactly one visible person/i);
}

function testSingleCharacterReferencePromptIgnoresNegativeGroupWords() {
  const prompt = referencePromptForTests({
    ref_id: "joey_identity_ref",
    kind: "character_state",
    subject: "Joey Mercer base identity",
    conditioning_asset_role: "identity_state",
    conditioning_subject_count: 1,
    prompt_anchor: "Exactly one adult man on a plain background; no additional people.",
    risk_notes: ["Used in dense multi-character scenes and team broadcasts."],
  });
  assert.match(prompt, /exactly one visible person/i);
  assert.doesNotMatch(prompt, /three to five clearly distinct visible people/i);
}

function testFluxKleinCreatureActionAndRequestContracts() {
  const creaturePrompt = referencePromptForTests({
    ref_id: "hollow_bell_boss_identity",
    kind: "character_state",
    subject: "Hollow-Bell Boss",
    conditioning_asset_role: "creature_identity",
    identity_subtype: "construct",
    expected_visible_hands: 2,
    prompt_anchor: "One deep bronze bell is integrated into the center of its black-stone chest beneath a separate stone head.",
  });
  assert.match(creaturePrompt, /exactly one canonical nonhuman actor/i);
  assert.match(creaturePrompt, /exact limb and body anatomy/i);
  assert.match(creaturePrompt, /integrated at their exact body attachment point/i);
  assert.match(creaturePrompt, /exactly 2 grasping or hand-like appendages, relaxed, clearly readable, separated from the torso, and empty/i);
  assert.doesNotMatch(creaturePrompt, /exactly one visible person/i);
  const roleAuthoritativeCreaturePrompt = referencePromptForTests({
    ref_id: "contradictory_role_fixture",
    kind: "character_state",
    subject: "Bell Guardian",
    conditioning_asset_role: "creature_identity",
    identity_subtype: "human",
    expected_visible_hands: 2,
    prompt_anchor: "One bell integrated into the center of its chest beneath a separate head.",
  });
  assert.match(roleAuthoritativeCreaturePrompt, /exactly one canonical nonhuman actor/i);
  assert.doesNotMatch(roleAuthoritativeCreaturePrompt, /exactly one visible person/i);

  const humanPrompt = referencePromptForTests({
    ref_id: "archer_identity",
    kind: "character_state",
    subject: "academy archer",
    conditioning_asset_role: "identity_state",
    identity_subtype: "human",
    expected_visible_hands: 2,
    prompt_anchor: "Adult academy scout in fitted green armor.",
  });
  assert.match(humanPrompt, /exactly 2 total visible hands or documented prosthetic hand endpoints/i);
  assert.match(humanPrompt, /reusable weapons and carried objects belong to separate prop plates/i);
  const humanBossPrompt = referencePromptForTests({
    ref_id: "company_boss_identity",
    kind: "Character State",
    subject: "Corrupt Company Boss",
    conditioning_asset_role: "identity_state",
    identity_subtype: "human",
    expected_visible_hands: null,
    prompt_anchor: "One adult executive in a neutral pose with every present hand empty.",
  });
  assert.match(humanBossPrompt, /exactly one visible person/i);
  assert.doesNotMatch(humanBossPrompt, /canonical nonhuman actor/i);
  assert.doesNotMatch(humanBossPrompt, /zero natural or prosthetic hands/i);
  const roleAuthoritativeHumanPrompt = referencePromptForTests({
    ref_id: "human_role_construct_subtype_fixture",
    kind: "character_state",
    subject: "Company Boss",
    conditioning_asset_role: "identity_state",
    identity_subtype: "construct",
    expected_visible_hands: 2,
    prompt_anchor: "One adult executive in a neutral pose.",
  });
  assert.match(roleAuthoritativeHumanPrompt, /exactly one visible person/i);
  assert.doesNotMatch(roleAuthoritativeHumanPrompt, /canonical nonhuman actor/i);

  const capped = normalizeReferenceLimit([
    { ref_id: "hero", kind: "character_state", reference_priority: "readable_identity" },
    { ref_id: "archer", kind: "character_state", reference_priority: "supporting_reference" },
    { ref_id: "knight", kind: "character_state", reference_priority: "supporting_reference" },
    { ref_id: "bell_chamber", kind: "location", reference_priority: "location_geometry" },
    { ref_id: "bell_guardian", kind: "character_state", reference_priority: "decisive_subject" },
  ], 4);
  assert.equal(capped.selected[0].ref_id, "bell_guardian");
  assert.equal(capped.selected.some((row) => row.ref_id === "bell_chamber"), true);
  assert.equal(capped.dropped.some((row) => ["archer", "knight"].includes(row.ref_id)), true);

  const scenePrompt = "Hollow-Bell Boss lunges frame-right through the sunken chamber, one deep bronze bell integrated into the center of its black-stone chest beneath a separate stone head.";
  const shotContractText = shotManifestProviderContractForTests({
    shot_manifest: {
      foreground_action: "Hollow-Bell Boss lunges toward Joey.",
      anatomy_contracts: [{
        entity: "Hollow-Bell Boss",
        body_invariant: "separate stone head above one chest-integrated bell",
        expected_visible_hands: 2,
        visibility_required: true,
      }],
      equipment_contracts: [{
        owner: "Joey",
        item: "sword",
        visible_count: 1,
        hand_assignment: "right hand; left hand empty",
        holder_state: "waist sheath empty",
        extras_allowed: false,
      }],
    },
  });
  assert.match(shotContractText, /Authoritative shot contract/i);
  assert.match(shotContractText, /"expected_visible_hands":2/);
  assert.match(shotContractText, /"visible_count":1/);
  const submitted = promptWithReferenceSlotsForTests({
    modelslab_image_prompt: scenePrompt,
    reference_slots: [{
      slot: 1,
      ref_id: "hollow_bell_boss_identity",
      kind: "character_state",
      subject: "Hollow-Bell Boss",
      conditioning_asset_role: "creature_identity",
      identity_subtype: "construct",
    }],
  }, "modelslab", { concise: true, mappingPosition: "after", shotContractText });
  assert.equal(submitted.startsWith(scenePrompt), true);
  assert.equal(submitted.indexOf("Authoritative shot contract") > scenePrompt.length, true);
  assert.equal(submitted.indexOf("Reference mapping:") > submitted.indexOf("Authoritative shot contract"), true);
  assert.match(submitted, /exact Hollow-Bell Boss identity, integrated anatomy, silhouette, texture, and markings only/i);

  const authoritativeOrder = attachReferencePathsToPromptsForTests({
    visual_prompt_hardening_report_path: "/tmp/visual_prompt_hardening_ep_01.json",
    prompts: [{
      image_id: "ep_01-bell-order",
      modelslab_image_prompt: scenePrompt,
      reference_requirements: [
        { ref_id: "hollow_bell_boss_identity", kind: "character_state", reference_priority: "decisive_subject", slot_order: 1 },
        { ref_id: "bell_chamber", kind: "location", reference_priority: "location_geometry", slot_order: 2 },
        { ref_id: "joey_identity", kind: "character_state", reference_priority: "readable_identity", slot_order: 3 },
      ],
      shot_manifest: {
        character_state_ref_ids: ["hollow_bell_boss_identity", "joey_identity", "peripheral_archer"],
        location_ref_id: "bell_chamber",
      },
    }],
  }, new Map([
    ["hollow_bell_boss_identity", "/tmp/hollow-bell-boss.png"],
    ["bell_chamber", "/tmp/bell-chamber.png"],
    ["joey_identity", "/tmp/joey.png"],
    ["peripheral_archer", "/tmp/archer.png"],
  ]), [{
    state_ref_id: "peripheral_archer",
    source_ref_id: "peripheral_archer",
    character: "Peripheral Archer",
  }], [
    { ref_id: "hollow_bell_boss_identity", kind: "character_state", subject: "Hollow-Bell Boss", conditioning_asset_role: "creature_identity", identity_subtype: "construct" },
    { ref_id: "bell_chamber", kind: "location", subject: "bell chamber" },
    { ref_id: "joey_identity", kind: "character_state", subject: "Joey" },
  ]);
  assert.deepEqual(
    authoritativeOrder.prompts[0].reference_slots.map((slot) => slot.ref_id),
    ["hollow_bell_boss_identity", "bell_chamber", "joey_identity"],
  );
  assert.equal(authoritativeOrder.prompts[0].reference_slots.some((slot) => slot.ref_id === "peripheral_archer"), false);

  const complexity = fluxKleinActionComplexityFindingsForTests({
    image_id: "ep_01-boss-fight",
    image_provider_route: "modelslab",
    image_model_route: "flux-klein",
    provider_prompt: "Joey swings one sword while three allies attack the Bell Guardian with a spear, bow, shield, and blade.",
    shot_manifest: {
      shot_job: "physical_action",
      visible_characters: ["Joey", "Arielle", "Archer", "Knight", "Bell Guardian"],
      foreground_action: "Joey strikes the Bell Guardian.",
    },
  });
  assert.equal(complexity.length, 1);
  assert.equal(complexity[0].severity, "warning");
  assert.equal(complexity[0].production_blocking, false);
  assert.equal(complexity[0].review_disposition, "manual_fix_or_accept");

  const missingContracts = fluxKleinStructuralContractFindingsForTests({
    image_id: "ep_01-oren-map",
    image_provider_route: "modelslab",
    image_model_route: "flux-klein",
    provider_prompt: "Oren's intact right hand takes the map while his residual left arm below the elbow stays clear; one sword hangs from Joey's empty sheath.",
    shot_manifest: {
      shot_job: "physical_action",
      foreground_action: "Oren takes the map beside Joey's sword.",
      anatomy_contracts: [],
      equipment_contracts: [],
    },
  });
  assert.equal(missingContracts.some((finding) => finding.code === "flux_klein_immutable_anatomy_contract_missing"), true);
  assert.equal(missingContracts.some((finding) => finding.code === "flux_klein_equipment_contract_missing"), true);
  assert.equal(missingContracts.every((finding) => finding.production_blocking === false), true);
  const explicitContracts = fluxKleinStructuralContractFindingsForTests({
    image_id: "ep_01-oren-map",
    image_provider_route: "modelslab",
    image_model_route: "flux-klein",
    provider_prompt: "Oren's intact right hand takes the map while his residual left arm below the elbow stays clear; Joey carries one sword.",
    shot_manifest: {
      shot_job: "physical_action",
      anatomy_contracts: [{
        entity: "Oren",
        identity_ref_id: "oren_post_amputation",
        body_invariant: "left forearm ends below the elbow",
        expected_visible_hands: 1,
        missing_limb: "left forearm below elbow",
        prosthetic_allowed: false,
        visibility_required: true,
      }],
      equipment_contracts: [{
        owner: "Joey",
        item: "sword",
        visible_count: 1,
        hand_assignment: "right hand",
        holder_state: "sheath empty",
        extras_allowed: false,
      }],
    },
  });
  assert.deepEqual(explicitContracts, []);

  const incompleteContracts = fluxKleinStructuralContractFindingsForTests({
    image_id: "ep_01-incomplete-contracts",
    image_provider_route: "modelslab",
    image_model_route: "flux-klein",
    provider_prompt: "Joey hands Arielle a phone while gripping one sword.",
    shot_manifest: {
      shot_job: "physical_action",
      anatomy_contracts: [{ entity: "Joey" }],
      equipment_contracts: [{ owner: "Joey", item: "phone" }],
    },
  });
  assert.equal(incompleteContracts.some((finding) => finding.code === "flux_klein_anatomy_contract_incomplete"), true);
  assert.equal(incompleteContracts.some((finding) => finding.code === "flux_klein_equipment_contract_incomplete"), true);

  const ordinaryHandledObject = fluxKleinStructuralContractFindingsForTests({
    image_id: "ep_01-phone-handoff",
    image_provider_route: "modelslab",
    image_model_route: "flux-klein",
    provider_prompt: "Joey passes a smartphone from his right hand into Arielle's open left hand.",
    shot_manifest: { shot_job: "physical_action", anatomy_contracts: [], equipment_contracts: [] },
  });
  assert.equal(ordinaryHandledObject.some((finding) => finding.code === "flux_klein_equipment_contract_missing"), true);

  const settings = modelslabRequestSettings({
    model: "flux-klein",
    referenceCount: 4,
    width: 1024,
    height: 576,
  });
  assert.equal(settings.endpoint, "/api/v6/images/img2img");
  assert.equal(settings.init_image_count, 4);
  assert.equal(settings.guidance_scale, 3.5);
  assert.equal(settings.strength, 0.72);
  assert.equal(settings.seed, null);
}

function testConciseReferenceRoleContract() {
  const instruction = referenceSlotInstructionForTests([
    { slot: 1, ref_id: "char_joey_ref", kind: "character_state", purpose: "Joey identity" },
    { slot: 2, ref_id: "char_arielle_ref", kind: "character_state", purpose: "Arielle identity" },
  ], {}, { concise: true });
  assert.match(instruction, /Reference mapping/i);
  assert.match(instruction, /Image 1/i);
  assert.match(instruction, /Image 2/i);
  assert.doesNotMatch(instruction, /reference sheet/i);
}

function testLocalBeatFidelityEditorialCases() {
  for (const promptText of [
    "Civilians wait behind the safety line.",
    "Local crews work at separate consoles.",
    "Operators monitor the gate from the rear row.",
    "Engineers and stewards remain in the background.",
    "Three teachers review the paper together.",
    "Her unnamed teammate sits at the desk ahead.",
    "An exam proctor observes from the collection point.",
    "Other test takers remain seated in orderly rows.",
  ]) {
    assert.equal(backgroundPopulationCuePresent(promptText), true);
  }
  const impliedPopulation = {
    presence: "implied",
    description: "silent hearing attendees",
    evidence: "The hearing turned against Joey.",
    staging: "two restrained rows behind Joey, subordinate to his reaction",
  };
  assert.deepEqual(sanitizeBackgroundPopulation(impliedPopulation), impliedPopulation);
  assert.deepEqual(backgroundPopulationFindings({
    image_id: "ep_01-cut-hearing",
    provider_prompt: "Joey absorbs the ruling while silent hearing attendees remain seated in two restrained rows behind him.",
    shot_manifest: { background_population: impliedPopulation },
  }), []);
  assert.equal(backgroundPopulationFindings({
    image_id: "ep_01-cut-hearing-empty",
    provider_prompt: "Joey stands completely alone in the hearing chamber.",
    shot_manifest: { background_population: impliedPopulation },
  }).some((finding) => finding.code === "background_population_missing_from_prompt"), true);
  const droppedPopulationFindings = localBeatFidelityFindingsForTests([{
    image_id: "ep_01-cut-hearing-dropped",
    image_prompt: "Joey stands completely alone in the hearing chamber.",
    shot_manifest: {
      visible_characters: ["Joey"],
      background_population: { presence: "none" },
    },
  }], [{
    primary_subject: "Joey",
    visible_subjects: ["Joey"],
    visual_beat_script_excerpt: "The hearing turned against Joey.",
    background_population: impliedPopulation,
  }]);
  assert.equal(droppedPopulationFindings.some((finding) => finding.includes("drops the beat's implied background population")), true);

  const allowedFindings = localBeatFidelityFindingsForTests([
    {
      image_id: "ep_01-cut-collective",
      image_prompt: "Joey Manhwa stands beside a glowing livestream ledger while Lana Vale watches from a campus livestream exam montage, audience seats and creator-screen spaces visible as environmental context.",
      shot_manifest: {
        visible_characters: ["Joey Manhwa", "Lana Vale"],
        location_ref_id: "streamer_university_livestream_exam_spaces_ref",
      },
    },
    {
      image_id: "ep_01-cut-location-list",
      image_prompt: "Joey and ExtraEmily stand before Improv Court doors in a streamer university hallway, panels of livestream challenge rooms glowing behind each door.",
      shot_manifest: {
        visible_characters: ["Joey", "ExtraEmily"],
        location_ref_id: "streamer_university_improv_court_door_hall_ref",
      },
    },
  ], [
    {
      primary_subject: "Joey Manhwa",
      visible_subjects: [
        "Joey Manhwa",
        "Lana Vale watching remotely",
        "Streamer University creators and audience spaces",
      ],
      location: "streamer_university_livestream_exam_spaces",
      location_timeline_label: "Joey's livestream ledger screen transitioning into Streamer University livestream-exam montage",
      visual_beat_script_excerpt: "And somewhere across campus, Lana Vale watched the whole world realize what I had been doing for her in silence. Streamer University did not have normal classes.",
    },
    {
      primary_subject: "Joey",
      visible_subjects: ["Joey", "ExtraEmily", "fake talk show host", "improv room audience"],
      location: "streamer_university_improv_court_door_hall",
      location_timeline_label: "streamer_university_improv_court_door_hall",
      visual_beat_script_excerpt: "Analytics Hall had graphs. Aura class had mirrors. Tax class had jokes. Improv Court had doors. Behind each door was a livestream situation you could not prepare for.",
    },
  ]);
  assert.deepEqual(allowedFindings, []);

  const hyphenatedNameFindings = localBeatFidelityFindingsForTests([
    {
      image_id: "ep_01-cut-hyphenated",
      image_prompt: "Joey Manhwa works beside Do-yun in a document-filled office while Mira watches from the doorway.",
      shot_manifest: {
        visible_characters: ["Joey Manhwa", "Do-yun", "Mira"],
      },
    },
  ], [
    {
      primary_subject: "Joey Manhwa",
      visible_subjects: ["Joey Manhwa", "Do-yun", "Mira"],
      visual_beat_script_excerpt: "Do-yun placed the folder beside Joey while Mira watched from the doorway.",
    },
  ]);
  assert.deepEqual(hyphenatedNameFindings, []);

  const organizationFindings = localBeatFidelityFindingsForTests([
    {
      image_id: "ep_01-cut-organization",
      image_prompt: "Joey studies a launch dashboard in the glass meeting room while regional merchants watch the trial metrics.",
      shot_manifest: {
        visible_characters: ["Joey"],
        location_ref_id: "tenfold_glass_meeting_room_ref",
      },
    },
  ], [
    {
      primary_subject: "Joey",
      visible_subjects: ["Joey", "regional merchants"],
      visual_beat_script_excerpt: "Tenfold opened the regional trial while Joey watched the merchant dashboard.",
    },
  ], {
    canonical_entities: [{
      kind: "organization",
      display_name: "Tenfold",
      aliases: ["Tenfold"],
    }],
  });
  assert.deepEqual(organizationFindings, []);

  const blockedFindings = localBeatFidelityFindingsForTests([
    {
      image_id: "ep_01-cut-missing",
      image_prompt: "Joey stands alone in a dorm room with a blue screen glow.",
      shot_manifest: {
        visible_characters: ["Joey"],
        location_ref_id: "dorm_room_ref",
      },
    },
  ], [
    {
      primary_subject: "Joey",
      visible_subjects: ["Joey", "Agent00"],
      location: "analytics_hall_replay_wall",
      location_timeline_label: "Analytics Hall replay wall",
      visual_beat_script_excerpt: "Joey crossed into Analytics Hall. Agent00 waited beside the replay wall.",
    },
  ]);
  assert.equal(blockedFindings.some((finding) => finding.includes("Agent00")), true);
  assert.equal(blockedFindings.some((finding) => finding.includes("Analytics Hall")), true);
}

function testHybridImageProviderRouting() {
  assert.equal(providerBatchManifestEligible({
    provider: "federated_google_web_image_pool",
    policy: { browser_provider_receipt_required: true },
  }), true);
  assert.equal(providerBatchManifestEligible({
    provider: "hybrid_web_flow",
    policy: { browser_provider_receipt_required: true },
  }), true);
  assert.equal(providerBatchManifestEligible({
    provider: "federated_google_web_image_pool",
    policy: { browser_provider_receipt_required: false },
  }), false);
  assert.equal(normalizeImageProvider("chatgpt web gpt image"), "chatgpt_web_gpt_image");
  assert.equal(routedProviderForReference("chatgpt_web_gpt_image"), "chatgpt_web_gpt_image");
  assert.equal(routedProviderForPrompt({}, "chatgpt_web_gpt_image"), "chatgpt_web_gpt_image");
  assert.equal(normalizeImageProvider("codex refs multichar modelslab simple"), "hybrid_codex_refs_multichar");
  assert.equal(routedProviderForReference("hybrid_codex_refs_multichar"), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    shot_manifest: {
      visible_characters: ["Joey", "Mira"],
      character_state_ref_ids: ["joey_ref", "mira_ref"],
    },
    reference_requirements: [
      { kind: "character_state", ref_id: "joey_ref" },
      { kind: "character_state", ref_id: "mira_ref" },
    ],
  }, "hybrid_codex_refs_multichar"), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    shot_manifest: {
      visible_characters: ["Joey"],
      character_state_ref_ids: ["joey_ref"],
    },
    reference_requirements: [
      { kind: "character_state", ref_id: "joey_ref" },
      { kind: "location", ref_id: "loc_hall" },
    ],
  }, "hybrid_codex_refs_multichar"), "modelslab");
  assert.equal(routedProviderForReference("hybrid_codex_opening_modelslab_rest", { kind: "character_state", ref_id: "joey_ref" }), "codex_imagegen");
  assert.equal(routedProviderForReference("hybrid_codex_opening_modelslab_rest", { kind: "location", ref_id: "loc_stage" }), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    start_sec: 119,
    shot_manifest: { visible_characters: ["Joey"], character_state_ref_ids: ["joey_ref"] },
  }, "hybrid_codex_opening_modelslab_rest", { codexOpeningSec: 120 }), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    start_sec: 121,
    shot_manifest: { visible_characters: ["Joey"], character_state_ref_ids: ["joey_ref"] },
  }, "hybrid_codex_opening_modelslab_rest", { codexOpeningSec: 120 }), "modelslab");
  assert.equal(routedProviderForPrompt({
    start_sec: 121,
    shot_manifest: { visible_characters: ["Joey", "Mira"], character_state_ref_ids: ["joey_ref", "mira_ref"] },
  }, "hybrid_codex_opening_modelslab_rest", { codexOpeningSec: 120 }), "modelslab");
  assert.equal(normalizeImageProvider("codex refs first10 risky modelslab rest"), "hybrid_codex_refs_opening_risky_modelslab_rest");
  assert.equal(routedProviderForReference("hybrid_codex_refs_opening_risky_modelslab_rest", { kind: "character_state", ref_id: "joey_ref" }), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    start_sec: 599.9,
    shot_manifest: { visible_characters: ["Joey"], character_state_ref_ids: ["joey_ref"] },
  }, "hybrid_codex_refs_opening_risky_modelslab_rest", { codexOpeningSec: 600 }), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    start_sec: 601,
    shot_manifest: { visible_characters: ["Joey", "Mira"], character_state_ref_ids: ["joey_ref", "mira_ref"] },
  }, "hybrid_codex_refs_opening_risky_modelslab_rest", { codexOpeningSec: 600 }), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    start_sec: 601,
    shot_manifest: { visible_characters: ["Joey"], character_state_ref_ids: ["joey_ref"] },
  }, "hybrid_codex_refs_opening_risky_modelslab_rest", { codexOpeningSec: 600 }), "modelslab");
  assert.equal(normalizeImageProvider("modelslab refs codex first 5 modelslab rest"), "hybrid_modelslab_refs_codex_opening_modelslab_rest");
  assert.equal(routedProviderForReference("hybrid_modelslab_refs_codex_opening_modelslab_rest", { kind: "character_state", ref_id: "joey_ref" }), "modelslab");
  assert.equal(routedProviderForReference("hybrid_modelslab_refs_codex_opening_modelslab_rest", { kind: "location", ref_id: "loc_stage" }), "modelslab");
  assert.equal(routedProviderForPrompt({
    start_sec: 299.9,
    shot_manifest: { visible_characters: ["Joey"], character_state_ref_ids: ["joey_ref"] },
  }, "hybrid_modelslab_refs_codex_opening_modelslab_rest", { codexOpeningSec: 300 }), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    start_sec: 300,
    shot_manifest: { visible_characters: ["Joey", "Mira"], character_state_ref_ids: ["joey_ref", "mira_ref"] },
  }, "hybrid_modelslab_refs_codex_opening_modelslab_rest", { codexOpeningSec: 300 }), "modelslab");
}

async function testPersistentFederatedImageIdentityPolicy() {
  const healthProof = {
    path: DEFAULT_GOOGLE_FLOW_HEALTH_PROOF_PATH,
    sha256: await sha256File(DEFAULT_GOOGLE_FLOW_HEALTH_PROOF_PATH),
  };
  const options = federatedWebImageIdentityOptions({ healthProof });
  const identity = {
    image_provider: FEDERATED_WEB_IMAGE_PROVIDER,
    image_provider_options: options,
    provider_locks: federatedWebImageProviderLocks(options),
  };
  assert.equal(options.google_flow.project_policy, PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY);
  assert.equal(options.google_flow.worker_session_policy, PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY);
  assert.equal(options.google_gemini.worker_session_policy, PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY);
  assert.equal(identity.provider_locks.google_flow_worker_session_policy, PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY);
  assert.equal(identity.provider_locks.google_gemini_worker_session_policy, PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY);
  assert.equal((await federatedWebImageIdentityStatus(identity)).done, true, "the current fast-premium identity must require persistent browser workers");

  const legacyV2 = structuredClone(identity);
  legacyV2.image_provider_options.routing_policy = FEDERATED_WEB_IMAGE_ROUTING_POLICY_V2;
  legacyV2.image_provider_options.google_flow.project_policy = FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY;
  delete legacyV2.image_provider_options.google_flow.worker_session_policy;
  delete legacyV2.image_provider_options.google_gemini.worker_session_policy;
  legacyV2.provider_locks.image_routing_policy = FEDERATED_WEB_IMAGE_ROUTING_POLICY_V2;
  legacyV2.provider_locks.google_flow_project_policy = FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY;
  delete legacyV2.provider_locks.google_flow_worker_session_policy;
  delete legacyV2.provider_locks.google_gemini_worker_session_policy;
  assert.equal((await federatedWebImageIdentityStatus(legacyV2)).done, true, "existing v2 fresh-project identities must remain valid and reproducible");
}

async function testHybridOpeningWindowPersistsInRunIdentity() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await execFileAsync(process.execPath, [
    "scripts/run-preflight.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--image-provider", "hybrid_codex_opening_modelslab_rest",
    "--codex-opening-sec", "600",
    "--run-intent", "diagnostic",
    "--allow-dirty-worktree", "true",
    "--dirty-reason", "fixture test",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const identity = JSON.parse(await fs.readFile(path.join(episodeDir, "run_identity.json"), "utf8"));
  assert.equal(identity.image_provider, "hybrid_codex_opening_modelslab_rest");
  assert.equal(identity.image_provider_options.codex_opening_sec, 600);

  const preGenerationStatusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const preGenerationStatus = JSON.parse(preGenerationStatusResult.stdout);
  const referenceStage = preGenerationStatus.stage_ledger.find((row) => row.stage === "reference_generation");
  const imageStage = preGenerationStatus.stage_ledger.find((row) => row.stage === "image_generation");
  assert.match(referenceStage.next_command_shape, /imagegen codex-work/);
  assert.match(referenceStage.next_command_shape, /--references-only true/);
  assert.match(imageStage.next_command_shape, /imagegen codex-work/);
  assert.match(imageStage.next_command_shape, /--codex-opening-sec 600/);

  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    findings: [],
    reference_targets: [{
      ref_id: "fixture_manual_style_hold",
      kind: "style",
      generation_mode: "manual_review",
      required_before_imagegen: false,
    }],
  });
  await execFileAsync(process.execPath, [
    "scripts/visual-reference-plan-approve.mjs",
    "--episode-dir", episodeDir,
    "--note", "fixture approval for skip-reference-generation contract",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });

  const imagegenReportPath = path.join(episodeDir, "imagegen_report_ep_01.json");
  await execFileAsync(process.execPath, [
    "scripts/imagegen.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--image-provider", "hybrid_codex_opening_modelslab_rest",
    "--references-only", "true",
    "--skip-reference-generation", "true",
    "--output", imagegenReportPath,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot, ANIFACTORY_CODEX_OPENING_SEC: "" } });
  const imagegenReport = JSON.parse(await fs.readFile(imagegenReportPath, "utf8"));
  assert.equal(imagegenReport.codex_opening_sec, 600);

  let mismatch = null;
  try {
    await execFileAsync(process.execPath, [
      "scripts/imagegen.mjs",
      "--channel", "test",
      "--series", "series",
      "--week", "run",
      "--episode", "ep_01",
      "--image-provider", "hybrid_codex_opening_modelslab_rest",
      "--references-only", "true",
      "--skip-reference-generation", "true",
      "--codex-opening-sec", "120",
      "--output", path.join(episodeDir, "imagegen_report_mismatch.json"),
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  } catch (error) {
    mismatch = error;
  }
  assert.equal(mismatch?.code, 1);
  assert.match(mismatch?.stderr ?? "", /Codex opening window mismatch/);

  const combinedDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const combinedEpisodeDir = path.join(combinedDataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await execFileAsync(process.execPath, [
    "scripts/run-preflight.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--image-provider", "hybrid_codex_refs_opening_risky_modelslab_rest",
    "--codex-opening-sec", "600",
    "--run-intent", "diagnostic",
    "--allow-dirty-worktree", "true",
    "--dirty-reason", "fixture test",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: combinedDataRoot } });
  const combinedIdentity = JSON.parse(await fs.readFile(path.join(combinedEpisodeDir, "run_identity.json"), "utf8"));
  assert.equal(combinedIdentity.image_provider, "hybrid_codex_refs_opening_risky_modelslab_rest");
  assert.equal(combinedIdentity.image_provider_options.codex_opening_sec, 600);
  const combinedStatusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", combinedEpisodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: combinedDataRoot } });
  const combinedStatus = JSON.parse(combinedStatusResult.stdout);
  const combinedReferenceStage = combinedStatus.stage_ledger.find((row) => row.stage === "reference_generation");
  const combinedImageStage = combinedStatus.stage_ledger.find((row) => row.stage === "image_generation");
  assert.match(combinedReferenceStage.next_command_shape, /imagegen codex-work/);
  assert.match(combinedReferenceStage.next_command_shape, /--references-only true/);
  assert.match(combinedImageStage.next_command_shape, /imagegen codex-work/);
  assert.match(combinedImageStage.next_command_shape, /--codex-opening-sec 600/);
  assert.match(combinedImageStage.next_command_shape, /--provider-filter modelslab/);

  const mixedRefsDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const mixedRefsEpisodeDir = path.join(mixedRefsDataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await execFileAsync(process.execPath, [
    "scripts/run-preflight.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--image-provider", "hybrid_modelslab_refs_codex_opening_modelslab_rest",
    "--codex-opening-sec", "300",
    "--pace-policy", "diagnostic",
    "--render-profile", "smooth_subpixel_ken_burns",
    "--run-intent", "diagnostic",
    "--allow-dirty-worktree", "true",
    "--dirty-reason", "fixture test",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: mixedRefsDataRoot } });
  const mixedIdentity = JSON.parse(await fs.readFile(path.join(mixedRefsEpisodeDir, "run_identity.json"), "utf8"));
  assert.equal(mixedIdentity.image_provider, "hybrid_modelslab_refs_codex_opening_modelslab_rest");
  assert.equal(mixedIdentity.image_provider_options.codex_opening_sec, 300);
  assert.equal(mixedIdentity.pace_policy, "diagnostic");
  assert.equal(mixedIdentity.render_profile, "smooth_subpixel_ken_burns");
  const mixedStatusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", mixedRefsEpisodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: mixedRefsDataRoot } });
  const mixedStatus = JSON.parse(mixedStatusResult.stdout);
  const mixedScriptPaceStage = mixedStatus.stage_ledger.find((row) => row.stage === "script_pace_check");
  const mixedReferenceStage = mixedStatus.stage_ledger.find((row) => row.stage === "reference_generation");
  const mixedImageStage = mixedStatus.stage_ledger.find((row) => row.stage === "image_generation");
  const mixedAudioPaceStage = mixedStatus.stage_ledger.find((row) => row.stage === "audio_pace_check");
  const mixedRenderStage = mixedStatus.stage_ledger.find((row) => row.stage === "premium_render");
  assert.match(mixedScriptPaceStage.next_command_shape, /--pace-policy diagnostic/);
  assert.match(mixedScriptPaceStage.next_command_shape, /--allow-hook-warnings true/);
  assert.match(mixedReferenceStage.next_command_shape, /imagegen start/);
  assert.match(mixedReferenceStage.next_command_shape, /--image-provider hybrid_modelslab_refs_codex_opening_modelslab_rest/);
  assert.match(mixedReferenceStage.next_command_shape, /--references-only true/);
  assert.doesNotMatch(mixedReferenceStage.next_command_shape, /import-staged-codex/);
  assert.match(mixedImageStage.next_command_shape, /imagegen codex-work/);
  assert.match(mixedImageStage.next_command_shape, /--action create/);
  assert.match(mixedImageStage.next_command_shape, /--provider-filter modelslab/);
  assert.match(mixedImageStage.next_command_shape, /--codex-opening-sec 300/);
  assert.match(mixedAudioPaceStage.next_command_shape, /--pace-policy diagnostic/);
  assert.match(mixedRenderStage.next_command_shape, /--motion smooth_subpixel_ken_burns/);
  assert.doesNotMatch(mixedRenderStage.next_command_shape, /fill_ken_burns/);
}

async function testVisualPlannerDriftContracts() {
  const files = Object.fromEntries(await Promise.all([
    "AGENTS.md",
    "docs/workflows/video_production_workflow.md",
    "bin/goldflow.mjs",
    "scripts/codex-image-manual-import.mjs",
    "scripts/lib/editorial-beat-director.mjs",
    "scripts/semantic-scene-plan.mjs",
    "scripts/visual-reference-plan.mjs",
    "scripts/visual-plan.mjs",
    "scripts/visual-prompt-review.mjs",
    "scripts/imagegen.mjs",
  ].map(async (file) => [file, await fs.readFile(file, "utf8")])));

  assert.match(files["scripts/semantic-scene-plan.mjs"], /acting as dean and final judge/i);
  assert.match(files["scripts/semantic-scene-plan.mjs"], /instead of creating a new generic character/i);

  assert.match(files["scripts/visual-reference-plan.mjs"], /face-only source identity anchor/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /base_identity_ref_id/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /source_only/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /applySourceFaceAnchors/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /Do not rely on text-only "inspired by" likeness prompts/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /A location contract is not an image reference/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /sole episode-level reference director/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /never restores an asset you omit/i);
  assert.doesNotMatch(files["scripts/visual-reference-plan.mjs"], /function applyReferenceBudgetProfile\b/);
  assert.doesNotMatch(files["scripts/visual-reference-plan.mjs"], /function ensureRequiredDirectorAssets\b/);
  assert.doesNotMatch(files["scripts/visual-reference-plan.mjs"], /termination papers|unauthorized data leak|proposal owner changed/i);
  assert.match(files["scripts/visual-plan.mjs"], /location_contract_id/i);
  assert.match(files["scripts/visual-prompt-review.mjs"], /location_contract_id/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /style refs dropped for this run; use style bible\/text guidance only/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /Keep narrative state separate from visible state/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /abstract_status_as_physical_anchor_risk/i);
  assert.match(files["AGENTS.md"], /Narrative states such as financially ruined, betrayed, humiliated, indebted, rejected, or emotionally broken are not physical costume\/body damage by default/i);
  assert.match(files["docs/workflows/video_production_workflow.md"], /Separate narrative\/status state from visible character state/i);
  assert.match(files["AGENTS.md"], /ANIFACTORY_IMAGE_MODEL=gpt-image-2-t2i/i);
  assert.match(files["docs/workflows/video_production_workflow.md"], /GPT Image 2 through ModelsLab is an explicit premium\/spend-forward variant/i);
  const modelslabImageHelper = await fs.readFile("scripts/modelslab-image-helper.mjs", "utf8");
  assert.match(modelslabImageHelper, /gpt-image-2-i2i/i);
  assert.equal(modelslabImageHelper.includes("/api/v7/images/image-to-image"), true);
  assert.match(modelslabImageHelper, /ANIFACTORY_MODELSLAB_GPT_IMAGE2_SIZE/i);

  for (const file of ["scripts/visual-plan.mjs", "scripts/visual-prompt-review.mjs"]) {
    assert.match(files[file], /16:9 landscape anime\/manhwa frame/i);
    assert.match(files[file], /without (?:adding )?boilerplate/i);
    assert.match(files[file], /Do not impose a universal wide\/full-frame\/medium-wide default/i);
    assert.match(files[file], /Resolve role\/title aliases to canonical named characters/i);
  }

  assert.match(files["scripts/imagegen.mjs"], /Reference usage:/i);
  assert.equal(/Reference image role contract for FLUX multi-image generation/i.test(files["scripts/imagegen.mjs"]), false);
  assert.equal(/Preserve the shot scale, subject count, background population, and composition requested by the prompt/i.test(files["scripts/imagegen.mjs"]), false);
  assert.equal(/Wide 16:9 landscape YouTube frame/i.test(files["scripts/imagegen.mjs"]), false);
  assert.equal(/full-frame composition, keep complete heads/i.test(files["scripts/imagegen.mjs"]), false);
  assert.match(files["scripts/lib/editorial-beat-director.mjs"], /There is no default crowd treatment based on location or scene type/i);
  assert.match(files["scripts/visual-plan.mjs"], /without imposing a default crowd, emptiness, detail level, prominence, lighting, or silhouette treatment/i);
  assert.doesNotMatch(files["scripts/lib/editorial-beat-director.mjs"], /active social situation logically needs anonymous people/i);
  assert.doesNotMatch(files["scripts/visual-plan.mjs"], /Describe those people and their subordinate staging/i);
  assert.doesNotMatch(files["scripts/visual-plan.mjs"], /Keep at most three individually readable foreground actors/i);
  assert.match(files["scripts/codex-image-manual-import.mjs"], /promptTextForImageProvider\(prompt, "codex_imagegen"\)/);
  assert.equal(commandStageFor("visual", "approve-refs", {}), "reference_image_approval");
  assert.equal(commandStageFor("imagegen", "start", {}), "image_generation");
  assert.equal(commandStageFor("imagegen", "start", { "references-only": "true" }), "reference_generation");
  assert.equal(commandStageFor("imagegen", "import-staged-codex", { "references-only": "true" }), "reference_generation");
  assert.equal(commandStageFor("imagegen", "import-staged-codex", { "qa-recovery": "true" }), "image_output_qa");
  assert.equal(commandStageFor("visual", "plan", {}), "visual_prompt_plan");
  assert.equal(commandStageFor("visual", "harden", {}), "visual_prompt_harden");

  for (const file of ["AGENTS.md", "docs/workflows/video_production_workflow.md"]) {
    assert.match(files[file], /Real named public creators, streamers, celebrities, or influencers/i);
    assert.match(files[file], /source-face anchors/i);
    assert.match(files[file], /face-only identity/i);
    assert.match(files[file], /inventing a generic lookalike/i);
    assert.match(files[file], /--codex-opening-sec <seconds>/);
  }
}

function testPromptPayloadMarkerSanitizerPreservesNormalNegation() {
  const textless = stripEmbeddedProviderExclusionPayloadSyntax("clean UI panel, no readable text, no text");
  assert.equal(/clean readable text/i.test(textless), false);
  assert.match(textless, /no readable text/i);
  assert.match(textless, /no text/i);

  const alone = stripEmbeddedProviderExclusionPayloadSyntax("one man alone without a crowd");
  assert.equal(/with a crowd/i.test(alone), false);
  assert.match(alone, /without a crowd/i);

  assert.equal(stripEmbeddedProviderExclusionPayloadSyntax("no second character"), "no second character");
  assert.match(stripEmbeddedProviderExclusionPayloadSyntax("no duplicate hero, no clone"), /no duplicate hero, no clone/i);
  assert.equal(stripEmbeddedProviderExclusionPayloadSyntax("Negative prompt: extra hands, extra weapons --no text"), "");
  assert.equal(
    stripEmbeddedProviderExclusionPayloadSyntax("one coherent adult hero on a plain background. Negative prompt: extra hands, sword"),
    "one coherent adult hero on a plain background.",
  );
}

function testNamedCharacterDuplicationAllowsReflections() {
  const reflectionPrompt = {
    image_id: "cut_reflection",
    scene_id: "scene_reflection",
    shot_manifest: { visible_characters: ["Joey Manhwa"] },
    image_prompt: "Older Joey Manhwa watches the cold reflection of old wealth symbols in the overlook glass. Joey Manhwa stands alone in the foreground.",
  };
  assert.deepEqual(namedCharacterDuplicationFindings([reflectionPrompt]), []);

  const clonePrompt = {
    image_id: "cut_clone",
    scene_id: "scene_clone",
    shot_manifest: { visible_characters: ["Joey Manhwa"] },
    image_prompt: "Joey Manhwa faces a clone of Joey Manhwa in the same hallway.",
  };
  const findings = namedCharacterDuplicationFindings([clonePrompt]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "named_character_duplication_risk");

  const proofCopiesPrompt = {
    image_id: "cut_proof_copies",
    scene_id: "scene_proof_copies",
    shot_manifest: { visible_characters: ["Commander Asha", "Senn", "artificers"] },
    image_prompt: "Commander Asha assigns observers while Senn records proof and artificers etch duplicate ledgers into mana glass. Commander Asha points to papers, Senn watches the crystals, and artificers work at a separate table.",
  };
  assert.deepEqual(namedCharacterDuplicationFindings([proofCopiesPrompt]), []);
}

function testVoiceDirectionCharacterization() {
  const pronounced = voiceDirectionTransformForTests("Manhwa Capital showed an SSS-rank warning.", {
    ttsOverrides: {
      pronunciation_map: [{ term: "Manhwa", spoken: "Mahn-wah" }],
    },
  });
  assert.equal(pronounced.qwen_spoken_text, "Mahn-wah Capital showed an S S S rank warning.");

  const cardinalNumbers = voiceDirectionTransformForTests("418 students connected to 4,812 shadows for 100,000 years.");
  assert.equal(cardinalNumbers.qwen_spoken_text, "four hundred and eighteen students connected to four thousand eight hundred and twelve shadows for one hundred thousand years.");

  const initialisms = voiceDirectionTransformForTests("The CEO told HR to send the NDA as a PDF through the API, but the SYSTEM stayed active.");
  assert.equal(initialisms.qwen_spoken_text, "The C E O told H R to send the N D A as a P D F through the A P I, but the System stayed active.");

  const uppercasePronoun = voiceDirectionTransformForTests('"IF YOU DID SOMETHING, FIX IT."');
  assert.equal(uppercasePronoun.qwen_spoken_text, "If You Did Something, Fix It.");
  const uppercaseSystemPronoun = voiceDirectionTransformForTests("ABILITY: NO ROAD IS DESTINED UNTIL SOMEONE CHOOSES TO WALK IT.", { speaker: "SYSTEM" });
  assert.equal(uppercaseSystemPronoun.qwen_spoken_text, "Ability: No Road Is Destined Until Someone Chooses To Walk It.");
  const contextualItInitialism = voiceDirectionTransformForTests("THE IT TEAM FIXED IT. SHE WORKED IN IT.");
  assert.equal(contextualItInitialism.qwen_spoken_text, "The I T Team Fixed It. She Worked In I T.");

  const ranksDepartmentsTimesAndDecimals = voiceDirectionTransformForTests("SSS called NYPD at 10:53 PM, logged 1053 PM, checked again at 1:08 a.m., and recorded 1.08.");
  assert.equal(
    ranksDepartmentsTimesAndDecimals.qwen_spoken_text,
    "S S S called N Y P D at ten fifty-three P M, logged ten fifty-three P M, checked again at one oh eight A M, and recorded one point zero eight.",
  );

  const systemNumbers = voiceDirectionTransformForTests("BODY CLAIM: 41% SHARED BODY CLAIM: 50 / 50 HELL DURATION: 8.3 YEARS", { speaker: "SYSTEM" });
  assert.equal(systemNumbers.qwen_spoken_text, "Body Claim: forty-one percent Shared Body Claim: fifty out of fifty Hell Duration: eight point three Years");

  const multipliers = voiceDirectionTransformForTests("RECIPROCITY RETURN: 0X. THE 10X SYSTEM ACTIVATED.", { speaker: "SYSTEM" });
  assert.equal(multipliers.qwen_spoken_text, "Reciprocity Return: zero times. The ten times System Activated.");
  const ordinarySystemWords = voiceDirectionTransformForTests("SYSTEM. EQUAL CROWNS RECOGNIZED. DEEDHOLDER CONFIRMED.", { speaker: "SYSTEM" });
  assert.equal(ordinarySystemWords.qwen_spoken_text, "System. Equal Crowns Recognized. Deedholder Confirmed.");
  assert.equal(ttsSafeTextForTests("RECIPROCITY RETURN: 0X. 10X CASHBACK."), "Reciprocity Return: zero times. ten times Cashback.");

  const trailingAttribution = voiceDirectionTransformForTests("\"Run,\" he said.");
  assert.equal(trailingAttribution.clean_narration_attribution, "\"Run,\" he said.");
  assert.deepEqual(trailingAttribution.paragraph_units.map((unit) => unit.text), ["Run.", "he said."]);

  const leadingAttribution = voiceDirectionTransformForTests("The clerk said, \"Door is locked.\"");
  assert.equal(leadingAttribution.clean_narration_attribution, "The clerk said, \"Door is locked.\"");
  assert.equal(leadingAttribution.qwen_spoken_text, "The clerk said, \"Door is locked.\"");
  assert.deepEqual(leadingAttribution.paragraph_units.map((unit) => unit.text), ["The clerk said,", "\"Door is locked.\""]);

  const clean = voiceDirectionTransformForTests("The elevator doors opened with a soft chime.");
  assert.equal(clean.clean_narration_attribution, "The elevator doors opened with a soft chime.");
  assert.equal(clean.qwen_spoken_text, "The elevator doors opened with a soft chime.");

  for (const regressionLine of [
    "The ring snapped shut like a shackle.",
    "The nearest chain snapped.",
    "Joey continued.",
    "Joey ordered the gates of the Afterlife opened.",
    "Her voice broke through the channel.",
    "The great Deathless Hero said nothing.",
  ]) {
    const transformed = voiceDirectionTransformForTests(regressionLine);
    assert.equal(transformed.clean_narration_attribution, regressionLine);
    assert.equal(transformed.qwen_spoken_text, regressionLine);
    assert.deepEqual(transformed.paragraph_units.map((unit) => unit.text), [regressionLine]);
  }

  const colonSystemRecord = voiceDirectionTransformForTests("EMOTIONAL CERTAINTY: ONE HUNDRED PERCENT.");
  assert.deepEqual(colonSystemRecord.paragraph_units.map((unit) => ({
    kind: unit.kind,
    speaker: unit.speaker,
    text: unit.text,
    caption_text: unit.caption_text,
  })), [{
    kind: "system_ui",
    speaker: "SYSTEM",
    text: "EMOTIONAL CERTAINTY: ONE HUNDRED PERCENT.",
    caption_text: "EMOTIONAL CERTAINTY: ONE HUNDRED PERCENT.",
  }]);
  assert.equal(colonSystemRecord.qwen_spoken_text, "Emotional Certainty: One Hundred Percent.");

  const systemStack = voiceDirectionTransformForTests([
    "[Hidden skill awakened.]",
    "",
    "[Skill name: Chapter Zero.]",
    "",
    "[Rank: Sealed.]",
    "",
    "[Effect: Allows user to review a survived scene and identify one hidden cause-and-effect link.]",
  ].join("\n\n"));
  assert.deepEqual(systemStack.paragraph_units.map((unit) => ({
    kind: unit.kind,
    speaker: unit.speaker,
    text: unit.text,
    caption_text: unit.caption_text,
  })), [
    { kind: "system_ui", speaker: "SYSTEM", text: "Hidden skill awakened.", caption_text: "[Hidden skill awakened.]" },
    { kind: "system_ui", speaker: "SYSTEM", text: "Skill name: Chapter Zero.", caption_text: "[Skill name: Chapter Zero.]" },
    { kind: "system_ui", speaker: "SYSTEM", text: "Rank: Sealed.", caption_text: "[Rank: Sealed.]" },
    { kind: "system_ui", speaker: "SYSTEM", text: "Effect: Allows user to review a survived scene and identify one hidden cause-and-effect link.", caption_text: "[Effect: Allows user to review a survived scene and identify one hidden cause-and-effect link.]" },
  ]);

  const nonSpokenDirection = voiceDirectionTransformForTests("[SFX: cold system ping]");
  assert.deepEqual(nonSpokenDirection.paragraph_units.map((unit) => unit.kind), ["sound_design"]);
}

function testQwenTextIntegrityCoverageGate() {
  const script = [
    "The ring snapped shut like a shackle.",
    "Her voice broke through the channel.",
    "EMOTIONAL CERTAINTY: ONE HUNDRED PERCENT.",
    "[Hidden skill awakened.]",
    "[SFX: cold system ping]",
    "Joey ordered the gates of the Afterlife opened.",
  ].join("\n");
  const performanceUnits = voiceDirectionTransformForTests(script).paragraph_units;
  const plan = qwenGenerationPlanForTests([{
    segment_id: "seg_integrity",
    performance_units: performanceUnits,
  }]);
  const passed = qwenTextIntegrityCoverageForTests(script, plan);
  assert.equal(passed.status, "passed");
  assert.equal(passed.script_to_plan_source.status, "passed");
  assert.equal(passed.plan_source_to_spoken.status, "passed");
  const systemCoverage = systemUiSpeechCoverageForTests(script, plan);
  assert.equal(systemCoverage.status, "passed");
  assert.equal(systemCoverage.expected_count, 2);
  assert.equal(systemCoverage.planned_count, 2);

  const dialogueUnits = voiceDirectionTransformForTests(
    "MAYA: Get out of my house.",
  ).paragraph_units;
  assert.match(dialogueUnits[0].performed_text, /^\[/);
  const dialoguePlan = qwenGenerationPlanForTests([{
    segment_id: "seg_no_direction_leak",
    performance_units: dialogueUnits,
  }]);
  assert.equal(dialoguePlan.units[0].spoken_text, "Get out of my house.");
  assert.doesNotMatch(dialoguePlan.units[0].spoken_text, /\[[^\]]+\]/);
  assert.equal(
    dialoguePlan.units[0].spoken_text_lineage.schema,
    "goldflow_spoken_text_lineage_v1",
  );
  const dialogueTextIr = buildNarrationTextIr({ units: dialoguePlan.units });
  assert.equal(
    validateNarrationTextIr(dialogueTextIr, dialoguePlan.units).status,
    "passed",
  );

  const corrupt = structuredClone(plan);
  corrupt.segments[0].qwen_generation_units[0].qwen_spoken_text = "shut like a shackle.";
  const blocked = qwenTextIntegrityCoverageForTests(script, corrupt);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.plan_source_to_spoken.status, "blocked");
  assert.equal(blocked.plan_source_to_spoken.mismatch_unit_count, 1);
  assert.equal(blocked.findings.some((finding) => finding.code === "qwen_plan_source_to_spoken_coverage_mismatch"), true);

  const sourceCorrupt = structuredClone(plan);
  sourceCorrupt.segments[0].qwen_generation_units[0].source_text = "shut like a shackle.";
  sourceCorrupt.segments[0].qwen_generation_units[0].qwen_spoken_text = "shut like a shackle.";
  const sourceBlocked = qwenTextIntegrityCoverageForTests(script, sourceCorrupt);
  assert.equal(sourceBlocked.status, "blocked");
  assert.equal(sourceBlocked.script_to_plan_source.status, "blocked");
  assert.equal(sourceBlocked.findings.some((finding) => finding.code === "script_to_qwen_plan_source_coverage_mismatch"), true);

  const overrideScript = "The clip became live content.";
  const overrides = {
    replacements: [{ from: "live content", to: "livestream video content", scope: "qwen_spoken_text" }],
    pronunciation_map: [],
  };
  const overridePlan = qwenGenerationPlanForTests([{
    segment_id: "seg_override",
    performance_units: voiceDirectionTransformForTests(overrideScript).paragraph_units,
  }], { ttsOverrides: overrides });
  assert.equal(qwenTextIntegrityCoverageForTests(overrideScript, overridePlan, { ttsOverrides: overrides }).status, "passed");

  const compiledTexts = [
    "The IT team fixed 41% of it.",
    "The SSS hero signed the report.",
    "Then Maya walked away from him.",
  ];
  const compiledPlan = qwenGenerationPlanForTests([{
    segment_id: "seg_compiler_lineage",
    performance_units: compiledTexts.map((text) => ({
      kind: "narration",
      speaker: "NARRATOR",
      text,
      performed_text: `[urgent delivery] ${text}`,
      caption_text: text,
    })),
  }]);
  assert.equal(compiledPlan.units.length, 1);
  assert.equal(
    compiledPlan.units[0].spoken_text,
    "The I T team fixed forty-one percent of it. The S S S hero signed the report. Then Maya walked away from him.",
  );
  assert.equal(compiledPlan.units[0].spoken_text_lineage.components.length, 3);
  assert.equal(compiledPlan.units[0].spoken_text_transformations.length, 2);
  const compiledTextIr = buildNarrationTextIr({ units: compiledPlan.units });
  assert.equal(
    validateNarrationTextIr(compiledTextIr, compiledPlan.units).status,
    "passed",
  );
}

function testKokoroNarrationUnitGroupingAndAtomicBarriers() {
  const narrationTexts = [
    "Ronan crossed the ruined courtyard while warning bells echoed behind him.",
    "He counted every sealed doorway and watched the shadows gather overhead.",
    "No guard answered, but the old gate kept trembling under pressure.",
    "Then he found the ledger beneath a broken marble statue.",
    "The final page carried his name beside a debt nobody remembered.",
    "He closed the cover and walked toward the throne without looking back.",
  ];
  const performanceUnits = narrationTexts.map((text) => ({
    kind: "narration",
    speaker: "NARRATOR",
    text,
    performed_text: text,
    caption_text: text,
  }));
  const groupedPlan = qwenGenerationPlanForTests([{
    segment_id: "seg_kokoro_group",
    delivery_mode: "exposition narration",
    performance_units: performanceUnits,
  }], { ttsProvider: "kokoro_local" });
  const repeatedPlan = qwenGenerationPlanForTests([{
    segment_id: "seg_kokoro_group",
    delivery_mode: "exposition narration",
    performance_units: performanceUnits,
  }], { ttsProvider: "kokoro_local" });
  const groupedUnits = groupedPlan.segments[0].narration_units;
  assert.equal(groupedUnits.length, 2);
  assert.deepEqual(groupedUnits.map((unit) => unit.word_count), [33, 33]);
  assert.ok(groupedUnits.every((unit) => unit.word_count >= 24 && unit.word_count <= 50));
  assert.deepEqual(groupedUnits.map((unit) => unit.order_index), [0, 1]);
  assert.deepEqual(groupedUnits.map((unit) => unit.grouped_source_unit_count), [3, 3]);
  assert.deepEqual(groupedUnits.map((unit) => unit.unit_id), repeatedPlan.units.map((unit) => unit.unit_id));
  const groupedTextIr = buildNarrationTextIr({ units: groupedPlan.units });
  assert.equal(
    validateNarrationTextIr(groupedTextIr, groupedPlan.units).status,
    "passed",
  );
  assert.deepEqual(
    groupedUnits.flatMap((unit) => unit.source_unit_refs).map((ref) => ref.source_text),
    narrationTexts,
  );
  assert.deepEqual(
    groupedUnits.flatMap((unit) => unit.source_unit_refs).map((ref) => ref.caption_text),
    narrationTexts,
  );
  for (const ref of groupedUnits.flatMap((unit) => unit.source_unit_refs)) {
    assert.equal(ref.source_text_sha256, sha256(ref.source_text));
    assert.equal(ref.caption_text_sha256, sha256(ref.caption_text));
  }
  assert.ok(groupedUnits.every((unit) => (
    unit.spoken_text === unit.tts_spoken_text
    && unit.tts_spoken_text === unit.qwen_spoken_text
  )));
  assert.ok(groupedUnits.every((unit) => unit.qwen_instruct === null));
  assert.ok(groupedUnits.every((unit) => unit.provider_controls.qwen3.instruct === null));
  assert.ok(groupedUnits.every((unit) => (
    unit.provider_controls.qwen3.delivery_control === "base_icl_reference_audio_only"
    && unit.provider_controls.qwen3.instruct_supported === false
    && unit.provider_controls.qwen3.instruct_submitted === false
    && /exact text/i.test(unit.provider_controls.qwen3.diagnostic_delivery_note)
  )));
  const assertPuckFallbackIdentity = (control) => {
    assert.equal(control.target_voice_id, "am_puck");
    assert.equal(control.target_voice_sha256, "9a8c2e56413bd2063f814cb4c3885fc425876157369117c3f8258d03c8a9ad89");
    assert.equal(control.reference_audio_sha256, QWEN_LOCAL_FALLBACK_LOCK.reference_audio_sha256);
    assert.equal(control.reference_transcript_sha256, QWEN_LOCAL_FALLBACK_LOCK.reference_text_sha256);
    assert.equal(control.reference_transcript_file_sha256, QWEN_LOCAL_FALLBACK_LOCK.reference_text_file_sha256);
    assert.equal(control.reference_metadata_sha256, QWEN_LOCAL_FALLBACK_LOCK.reference_metadata_sha256);
    assert.equal(control.voice_continuity_contract, "clone_primary_puck_identity");
    assert.equal(control.speaker_similarity_model_sha256, QWEN_LOCAL_FALLBACK_LOCK.speaker_similarity_model_sha256);
    assert.equal(control.hard_minimum_cosine_similarity, 0.88);
    assert.equal(control.warning_floor_cosine_similarity, 0.90);
    assert.equal(control.fallback_scope, "exact_failed_unit_only");
    assert.equal(control.exact_unit_only, true);
    assert.equal(control.whole_episode_fallback_allowed, false);
  };
  assertPuckFallbackIdentity(groupedPlan.provider_controls.qwen3);
  assertPuckFallbackIdentity(groupedPlan.instruction_delivery.qwen3);
  for (const unit of groupedPlan.units) assertPuckFallbackIdentity(unit.provider_controls.qwen3);
  assert.equal(groupedPlan.narrator_voice_id, "am_puck");
  assert.equal(groupedPlan.narrator_voice_sha256, "9a8c2e56413bd2063f814cb4c3885fc425876157369117c3f8258d03c8a9ad89");
  assert.equal(groupedPlan.narrator_identity_policy, "single_puck_identity_with_qwen_exact_unit_clone");
  assert.equal(groupedPlan.kokoro_unit_boundary_integrity.status, "passed");
  assert.equal(groupedPlan.kokoro_unit_boundary_integrity.unit_count, groupedUnits.length);
  assert.equal(groupedPlan.kokoro_unit_boundary_integrity.whole_source_units_only, true);
  assert.equal(groupedPlan.kokoro_unit_boundary_integrity.clean_start_count, groupedUnits.length);
  assert.equal(groupedPlan.kokoro_unit_boundary_integrity.terminal_punctuation_count, groupedUnits.length);
  assert.doesNotMatch(JSON.stringify(groupedPlan), /joel_owned_narrator_clone|am_fenrir/i);
  const qwenLiamPlan = qwenGenerationPlanForTests([{
    segment_id: "seg_qwen_liam",
    performance_units: performanceUnits.slice(0, 1),
  }], { ttsProvider: "qwen_local" });
  assert.equal(qwenLiamPlan.provider_controls.qwen3.fallback, false);
  assert.equal(qwenLiamPlan.provider_controls.qwen3.target_voice_id, "joel_owned_narrator_clone");
  assert.equal(qwenLiamPlan.instruction_delivery.qwen3.target_voice_id, "joel_owned_narrator_clone");
  assert.equal(qwenLiamPlan.narrator_voice_id, "joel_owned_narrator_clone");
  assert.equal(
    qwenLiamPlan.provider_controls.qwen3.reference_audio_sha256,
    QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK.reference_audio_sha256,
  );
  assert.equal(
    qwenLiamPlan.provider_controls.qwen3.voice_continuity_contract,
    QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK.voice_continuity_contract,
  );
  assert.deepEqual(
    qwenLiamPlan.provider_controls.qwen3.synthesis_contract,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  );
  assert.equal(
    qwenLiamPlan.qwen_liam_batch_plan.synthesis_contract.contract_id,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.contract_id,
  );
  assert.equal(qwenLiamPlan.qwen_liam_batch_plan.cohort_count, 1);
  const qwenLiamIdentity = {
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    tts_provider: "qwen_local",
    tts_fallback_provider: null,
    narrator_voice_id: "joel_owned_narrator_clone",
    tts_native_speed: null,
    voice_provider_options: defaultNarrationVoiceProviderOptions(),
  };
  assert.deepEqual(
    narrationPlanVoiceIdentityFindings(
      qwenLiamPlan,
      validateNarrationTtsPolicy(
        narrationTtsPolicyForIdentity(qwenLiamIdentity),
      ),
    ),
    [],
  );
  assert.equal(
    qwenLiamPlan.units[0].synthesis_cohort.batch_plan_sha256,
    qwenLiamPlan.qwen_liam_batch_plan.batch_plan_sha256,
  );
  assert.equal(
    qwenTextIntegrityCoverageForTests(narrationTexts.join("\n"), groupedPlan).status,
    "passed",
  );

  const attributionSource = "She looked directly at Joey and said,";
  const attributionPlan = qwenGenerationPlanForTests([{
    segment_id: "seg_attribution_override",
    performance_units: [{
      kind: "narration",
      speaker: "NARRATOR",
      text: attributionSource,
      performed_text: attributionSource,
      caption_text: attributionSource,
    }],
  }], {
    ttsProvider: "qwen_local",
    ttsOverrides: {
      replacements: [{
        from: attributionSource,
        to: "She looked directly at Joey and spoke.",
        scope: "tts_spoken_text",
      }],
      pronunciation_map: [],
    },
  });
  assert.equal(attributionPlan.status, "passed");
  assert.equal(attributionPlan.units[0].source_text, attributionSource);
  assert.equal(attributionPlan.units[0].caption_text, attributionSource);
  assert.equal(
    attributionPlan.units[0].spoken_text,
    "She looked directly at Joey and spoke.",
  );
  assert.equal(
    attributionPlan.sentence_unit_boundary_integrity.status,
    "passed",
  );

  const before = "Ronan stopped beside the gate and listened carefully for movement.";
  const after = "The courtyard answered with another violent crack beneath his boots.";
  const finalLine = "He kept moving because the warning had already named him.";
  const systemUnit = {
    kind: "system_ui",
    speaker: "SYSTEM",
    text: "Hidden skill awakened.",
    performed_text: "Hidden skill awakened.",
    caption_text: "[Hidden skill awakened.]",
  };
  const soundBarrier = {
    kind: "sound_design",
    speaker: "SFX",
    text: "cold system ping",
    performed_text: "cold system ping",
    caption_text: "[SFX: cold system ping]",
  };
  const atomicScript = [
    before,
    "[Hidden skill awakened.]",
    after,
    "[SFX: cold system ping]",
    finalLine,
  ].join("\n");
  const atomicPlan = qwenGenerationPlanForTests([{
    segment_id: "seg_kokoro_atomic",
    performance_units: [
      { kind: "narration", speaker: "NARRATOR", text: before, performed_text: before, caption_text: before },
      systemUnit,
      { kind: "narration", speaker: "NARRATOR", text: after, performed_text: after, caption_text: after },
      soundBarrier,
      { kind: "narration", speaker: "NARRATOR", text: finalLine, performed_text: finalLine, caption_text: finalLine },
    ],
  }], { ttsProvider: "kokoro_local" });
  const atomicUnits = atomicPlan.segments[0].narration_units;
  const plannedSystemUnits = atomicUnits.filter((unit) => unit.kind === "system_ui");
  assert.equal(plannedSystemUnits.length, 1);
  assert.equal(plannedSystemUnits[0].source_text, "Hidden skill awakened.");
  assert.equal(plannedSystemUnits[0].caption_text, "[Hidden skill awakened.]");
  assert.equal(plannedSystemUnits[0].source_unit_refs.length, 1);
  assert.equal(plannedSystemUnits[0].merge_barrier, true);
  assert.equal(atomicUnits.some((unit) => (
    unit.source_unit_refs.some((ref) => ref.unit_index === 3)
    && unit.source_unit_refs.some((ref) => ref.unit_index === 5)
  )), false);
  assert.equal(qwenTextIntegrityCoverageForTests(atomicScript, atomicPlan).status, "passed");
  assert.equal(systemUiSpeechCoverageForTests(atomicScript, atomicPlan).status, "passed");

  const periodDelimitedUi = [
    "SYSTEM. CLAIM ATTEMPT DETECTED.",
    "TARGET. TERRITORY. FIRST GATE.",
    "CONDITION. SURVIVE THE SOVEREIGN.",
    "PENDING.",
  ].join("\n");
  const transformedUi = voiceDirectionTransformForTests(periodDelimitedUi);
  assert.equal(transformedUi.paragraph_units.length, 1);
  assert.equal(transformedUi.paragraph_units[0].kind, "system_ui");
  assert.equal(transformedUi.paragraph_units[0].speaker, "SYSTEM");
  assert.equal(
    transformedUi.paragraph_units[0].text,
    "SYSTEM. CLAIM ATTEMPT DETECTED. TARGET. TERRITORY. FIRST GATE. CONDITION. SURVIVE THE SOVEREIGN. PENDING.",
  );
  assert.equal(transformedUi.paragraph_units[0].caption_text, periodDelimitedUi);
  const periodDelimitedPlan = qwenGenerationPlanForTests([{
    segment_id: "seg_period_delimited_ui",
    performance_units: transformedUi.paragraph_units,
  }], { ttsProvider: "kokoro_local" });
  assert.equal(periodDelimitedPlan.units.length, 1);
  assert.equal(periodDelimitedPlan.units[0].kind, "system_ui");
  assert.equal(periodDelimitedPlan.units[0].merge_barrier, true);
  assert.ok(periodDelimitedPlan.units[0].risk_flags.includes("system_ui_atomic"));
  assert.ok(periodDelimitedPlan.units[0].risk_flags.includes("speaker_or_performance_turn"));
  assert.equal(qwenTextIntegrityCoverageForTests(periodDelimitedUi, periodDelimitedPlan).status, "passed");
  assert.equal(systemUiSpeechCoverageForTests(periodDelimitedUi, periodDelimitedPlan).status, "passed");

  const uppercaseDialogue = voiceDirectionTransformForTests('"GET OUT OF MY HOUSE."');
  assert.equal(uppercaseDialogue.paragraph_units[0].kind, "narration");
}

function testQwenHumanShieldPatternKeepsVoiceSegmentsAtomic() {
  const narration = (text) => ({
    kind: "narration",
    speaker: "NARRATOR",
    text,
    performed_text: text,
    caption_text: text,
  });
  const firstSegmentTexts = [
    "It did not choose a target.",
    "It did not heal the damage already done.",
    "It named what Joey had earned.",
  ];
  const secondSegmentTexts = [
    "Burden Reclaimed had awakened.",
    "Twelve thousand Guard Experience became available.",
    "None came from Serena forcing monsters to target him.",
    "Forced danger had earned nothing.",
    "The inheritance came from what Joey had done afterward.",
  ];
  const plan = qwenGenerationPlanForTests([
    {
      segment_id: "voice_seg_32",
      delivery_mode: "aftermath narration",
      performance_units: firstSegmentTexts.map(narration),
    },
    {
      segment_id: "voice_seg_33",
      delivery_mode: "system reveal narration",
      performance_units: secondSegmentTexts.map(narration),
    },
  ], { ttsProvider: "qwen_local" });

  assert.equal(plan.status, "passed");
  assert.equal(plan.units.length, 2);
  assert.deepEqual(
    plan.units.map((unit) => unit.source_segment_ids),
    [["voice_seg_32"], ["voice_seg_33"]],
  );
  assert.deepEqual(plan.units.map((unit) => unit.word_count), [20, 33]);
  assert.ok(plan.units.every((unit) => unit.word_count < 45));
  assert.ok(plan.units.every((unit) => unit.word_count <= 60));
  assert.deepEqual(
    plan.units.map((unit) => unit.boundary_after),
    ["segment", "episode_end"],
  );
  assert.ok(plan.units.every((unit) => unit.merge_barrier === true));
  assert.deepEqual(
    plan.units.flatMap((unit) => unit.source_unit_refs.map((ref) => ref.source_text)),
    [...firstSegmentTexts, ...secondSegmentTexts],
  );
  assert.equal(
    plan.sentence_unit_boundary_integrity.within_voice_segment_boundary_count,
    2,
  );
  assert.equal(
    plan.sentence_unit_boundary_integrity.blockers.some(
      (finding) => finding.code === "tts_unit_crosses_voice_segment_boundary",
    ),
    false,
  );

  const staleCrossSegmentPlan = structuredClone(plan);
  staleCrossSegmentPlan.units[0].source_segment_ids = [
    "voice_seg_32",
    "voice_seg_33",
  ];
  assert.throws(
    () => normalizeNarrationUnitsForTests(staleCrossSegmentPlan, {
      voiceId: QWEN_LIAM_PRIMARY_LOCK.voice_id,
    }),
    /crosses a hard voice-segment boundary/i,
  );
}

function testVoiceDirectionPreservesFastRecapCadence() {
  const ordinarySegments = Array.from({ length: 30 }, (_, index) => `Joey reviewed sponsor footage and prepared release number ${index + 1}.`);
  const metadata = voiceDirectionMetadataForTests(ordinarySegments);
  assert.ok(metadata.every((row) => row.delivery_mode === "exposition narration"));
  assert.ok(metadata.every((row) => !/\b(?:low voice|quiet|hushed|whisper|slow)\b/i.test(row.performance_tag)));
  assert.ok(metadata.every((row) => row.pause_tag === null));

  const semanticModes = voiceDirectionMetadataForTests([
    "The sponsor approved the release and the audience watched.",
    "His son waited beside the hospital bed.",
    "But he did not know the final investor was waiting for him.",
    "SYSTEM WARNING: release probability changed.",
  ]);
  assert.equal(semanticModes[0].delivery_mode, "exposition narration");
  assert.equal(semanticModes[1].delivery_mode, "memory/child tenderness");
  assert.equal(semanticModes[2].delivery_mode, "cliffhanger landing");
  assert.equal(semanticModes[3].delivery_mode, "warning/system");
  assert.doesNotMatch(semanticModes[3].performance_tag, /low voice/i);
}

function testScriptMetaScanAllowsInStoryAnalyticsObjects() {
  const inStory = scanScriptMetaContamination([
    "Joey showed Nora the retention graph.",
    "The curve proved viewers who found her came back.",
  ].join("\n"));
  assert.equal(inStory.status, "passed");

  const leakedPlanning = scanScriptMetaContamination("That was the hook. Viewer anticipation verified. Opening retention improved.");
  assert.equal(leakedPlanning.status, "blocked");
  assert.deepEqual(leakedPlanning.blockers.map((row) => row.code).sort(), [
    "hook_meta_line",
    "opening_retention_meta",
    "viewer_anticipation_meta",
  ].sort());
}

function testQwenPlanAuditsAppliedTtsOverrides() {
  const plan = qwenGenerationPlanForTests([{
    segment_id: "seg_001",
    performance_units: [{
      kind: "narration",
      speaker: "NARRATOR",
      text: "The clip became live content.",
      performed_text: "The clip became live content.",
      caption_text: "The clip became live content.",
    }],
  }], {
    ttsOverrides: {
      replacements: [{ from: "live content", to: "livestream video content", scope: "qwen_spoken_text" }],
      pronunciation_map: [],
    },
  });
  assert.equal(plan.tts_override_application_audit.loaded_count, 1);
  assert.equal(plan.tts_override_application_audit.applied_rule_count, 1);
  assert.equal(plan.tts_override_application_audit.unmatched_rule_count, 0);
  assert.equal(plan.segments[0].qwen_generation_units[0].qwen_spoken_text, "The clip became livestream video content.");
  assert.deepEqual(plan.segments[0].qwen_generation_units[0].tts_override_replacements_applied.map((row) => row.from), ["live content"]);
}

function testQwenPlanSpeaksStandaloneSystemUiWithoutBrackets() {
  const plan = qwenGenerationPlanForTests([{
    segment_id: "seg_system",
    performance_units: voiceDirectionTransformForTests([
      "[Hidden skill awakened.]",
      "",
      "[Skill name: Chapter Zero.]",
    ].join("\n\n")).paragraph_units,
  }]);
  const units = plan.segments[0].qwen_generation_units;
  assert.equal(plan.system_ui_unit_count, 2);
  assert.deepEqual(units.map((unit) => unit.qwen_spoken_text), [
    "Hidden skill awakened.",
    "Skill name: Chapter Zero.",
  ]);
  assert.deepEqual(units.map((unit) => unit.caption_text), [
    "[Hidden skill awakened.]",
    "[Skill name: Chapter Zero.]",
  ]);
  assert.ok(units.every((unit) => unit.source_speaker === "SYSTEM"));
  assert.ok(units.every((unit) => unit.qwen_instruct === null));
  assert.ok(units.every((unit) => (
    unit.provider_controls.qwen3.instruct_supported === false
    && unit.provider_controls.qwen3.instruct_submitted === false
    && unit.provider_controls.qwen3.instruct === null
    && unit.provider_controls.qwen3.reference_audio_sha256
      === QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK.reference_audio_sha256
  )));
}

async function testNarrationPaceChecks() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "One two three four five six seven.";
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");

  await execFileAsync(process.execPath, [
    "scripts/narration-pace-check.mjs",
    "--mode", "script",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const scriptReport = JSON.parse(await fs.readFile(path.join(episodeDir, "script_pace_report.json"), "utf8"));
  assert.equal(scriptReport.status, "passed");
  assert.equal(scriptReport.target_wpm_min, 180);
  assert.equal(scriptReport.target_wpm_max, 195);
  assert.equal(scriptReport.script_word_count, 7);
  assert.equal(scriptReport.source_hashes[path.join(episodeDir, "script_clean.md")], scriptReport.source_script_hash);

  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptReport.source_script_hash,
    audio_duration_sec: 2,
    word_count: 7,
    words: Array.from({ length: 7 }, (_, index) => ({ word: String(index + 1), start: index * 0.25, end: index * 0.25 + 0.2 })),
  });
  await execFileAsync(process.execPath, [
    "scripts/narration-pace-check.mjs",
    "--mode", "audio",
    "--episode-dir", episodeDir,
    "--episode", "ep_01",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const audioReport = JSON.parse(await fs.readFile(path.join(episodeDir, "narration_pace_report_ep_01.json"), "utf8"));
  assert.equal(audioReport.status, "passed");
  assert.equal(audioReport.actual_wpm, 210);
  assert.equal(audioReport.source_hashes[path.join(episodeDir, "script_clean.md")], scriptReport.source_script_hash);
  assert.ok(audioReport.source_hashes[path.join(episodeDir, "narration_word_timing_ep_01.json")]);

  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptReport.source_script_hash,
    audio_duration_sec: 3,
    word_count: 7,
    words: [],
  });
  await execFileAsync(process.execPath, [
    "scripts/narration-pace-check.mjs",
    "--mode", "audio",
    "--episode-dir", episodeDir,
    "--episode", "ep_01",
    "--pace-policy", "diagnostic",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const diagnosticAudioReport = JSON.parse(await fs.readFile(path.join(episodeDir, "narration_pace_report_ep_01.json"), "utf8"));
  assert.equal(diagnosticAudioReport.status, "passed");
  assert.equal(diagnosticAudioReport.pace_policy, "diagnostic");
  assert.equal(diagnosticAudioReport.pace_gate_enforced, false);
  assert.equal(diagnosticAudioReport.diagnostic_pace_status, "outside_target");
  assert.equal(diagnosticAudioReport.blocker, null);

  const outOfRange = await execFileAsync(process.execPath, [
    "scripts/narration-pace-check.mjs",
    "--mode", "audio",
    "--episode-dir", episodeDir,
    "--episode", "ep_01",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  assert.match(outOfRange.stdout, /"status": "passed"/);
  const outOfRangeReport = JSON.parse(await fs.readFile(path.join(episodeDir, "narration_pace_report_ep_01.json"), "utf8"));
  assert.equal(outOfRangeReport.diagnostic_pace_status, "outside_target");
  assert.equal(outOfRangeReport.pace_gate_enforced, false);
}

async function testScriptPaceDoesNotUseBuiltInEpisodeHookPhrases() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const filler = Array.from({ length: 130 }, (_, index) => `filler${index + 1}`).join(" ");
  const scriptText = `${filler} system activated. first quest complete. report to analytics hall.`;
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await execFileAsync(process.execPath, [
    "scripts/narration-pace-check.mjs",
    "--mode", "script",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "script_pace_report.json"), "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.hook_gate_enforced, false);
  assert.equal(report.diagnostic_hook_status, "not_configured");
  assert.equal(report.hook_milestone_report.configured, false);
  assert.deepEqual(report.hook_milestone_report.warnings, []);

  const hookMilestonesPath = path.join(episodeDir, "hook_milestones.json");
  await writeJson(hookMilestonesPath, {
    milestones: [{
      code: "configured_promise",
      label: "configured promise",
      patterns: ["configured promise"],
      target_sec: 30,
      reason: "Fixture-only configured hook promise is late.",
    }],
  });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), `${filler} configured promise.`, "utf8");
  await execFileAsync(process.execPath, [
    "scripts/narration-pace-check.mjs",
    "--mode", "script",
    "--episode-dir", episodeDir,
    "--hook-milestones", hookMilestonesPath,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const configuredReport = JSON.parse(await fs.readFile(path.join(episodeDir, "script_pace_report.json"), "utf8"));
  assert.equal(configuredReport.status, "passed");
  assert.equal(configuredReport.hook_gate_enforced, false);
  assert.equal(configuredReport.diagnostic_hook_status, "missed_goal");
  assert.equal(configuredReport.hook_milestone_report.configured, true);
  assert.equal(configuredReport.hook_milestone_report.warnings.some((warning) => warning.code === "late_configured_promise"), true);

  await execFileAsync(process.execPath, [
    "scripts/narration-pace-check.mjs",
    "--mode", "script",
    "--episode-dir", episodeDir,
    "--hook-milestones", hookMilestonesPath,
    "--pace-policy", "diagnostic",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const diagnosticReport = JSON.parse(await fs.readFile(path.join(episodeDir, "script_pace_report.json"), "utf8"));
  assert.equal(diagnosticReport.status, "passed");
  assert.equal(diagnosticReport.pace_policy, "diagnostic");
  assert.equal(diagnosticReport.hook_gate_enforced, false);
  assert.equal(diagnosticReport.diagnostic_hook_status, "missed_goal");
  assert.equal(diagnosticReport.blocker, null);
}

async function testTargetedSpeakabilityLiveContentHomograph() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), "The clip became live content before I could breathe. Crown Night was streaming live. Walk there on a live stream. My face became best-performing stream content. I had to go live before the timer hit zero. Then I had to go live again.", "utf8");
  await execFileAsync(process.execPath, [
    "scripts/script-targeted-speakability.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--allow-unlocked-script", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "script_speakability_report.json"), "utf8"));
  const overrides = JSON.parse(await fs.readFile(path.join(episodeDir, "tts_spoken_overrides.json"), "utf8"));
  assert.equal(report.deterministic_risks.some((finding) => finding.code === "tts_homograph_live_content"), true);
  assert.equal(overrides.replacements.some((replacement) => (
    replacement.from === "live content"
    && replacement.to === "livestream video content"
    && replacement.scope === "tts_spoken_text"
  )), true);
  assert.equal(overrides.accepted_scope_aliases.includes("qwen_spoken_text"), true);
  assert.equal(overrides.replacements.some((replacement) => replacement.from === "streaming live" && replacement.to === "livestreaming"), true);
  assert.equal(overrides.replacements.some((replacement) => replacement.from === "live stream" && replacement.to === "livestream"), true);
  assert.equal(overrides.replacements.some((replacement) => replacement.from === "stream content" && replacement.to === "stream videos"), true);
  assert.equal(overrides.replacements.some((replacement) => replacement.from === "go live" && replacement.to === "start a livestream"), true);
  assert.equal(overrides.replacements.filter((replacement) => replacement.from === "go live").length, 1);
}

async function testVisualBeatDensityDefaults() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const sentences = Array.from({ length: 80 }, (_, index) => {
    if (index === 0) return "Joey was humiliated on the stage.";
    if (index === 4) return "The system quest activated in front of him.";
    if (index === 8) return "The viewer count changed on the chat panel.";
    if (index === 16) return "He crossed into the analytics hall.";
    return `Sentence ${index + 1} moves the story forward.`;
  }).join(" ");
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), sentences, "utf8");
  const scriptHash = sha256(sentences);
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    timing_source: "fixture",
    audio_duration_sec: 180,
    scenes: [{
      scene_id: "scene_001",
      start_sec: 0,
      end_sec: 180,
      duration_sec: 180,
      location: "test arena",
      script_excerpt_start: "Joey was humiliated on the stage.",
      script_excerpt_end: "Sentence 80 moves the story forward.",
      visible_subjects: ["Joey", "Pookie"],
      visual_intent: "opening humiliation escalates into system proof",
    }],
  });
  const words = sentences.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    audio_duration_sec: 180,
    word_count: words.length,
    words: words.map((word, index) => ({
      index,
      word,
      start_sec: Number((index * 180 / words.length).toFixed(3)),
      end_sec: Number(((index + 0.82) * 180 / words.length).toFixed(3)),
    })),
  });
  await execFileAsync(process.execPath, [
    "scripts/visual-beat-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "visual_beat_plan.json"), "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.visual_beat_contract_version, VISUAL_BEAT_CONTRACT_VERSION);
  assert.equal(report.hook_visual_beat_count >= 8, true);
  assert.equal(report.retention_ramp_visual_beat_count >= 24, true);
  assert.equal(report.beats.every((beat) => String(beat.visual_beat_script_excerpt ?? "").trim()), true);
  assert.equal(report.beats.every((beat) => Array.isArray(beat.ref_needs)), true);
  assert.equal(report.beats.some((beat) => beat.ref_needs.some((need) => need.generation_mode === "standalone_ref")), true);
  assert.equal(report.beats.some((beat) => Array.isArray(beat.visible_characters)), true);
  assert.equal(report.beats.some((beat) => Array.isArray(beat.local_props)), true);
  assert.equal(report.beats[0].visual_job, "premise_image");
  assert.equal(report.editorial_cue_counts.public_humiliation_or_reversal >= 1, true);
  assert.equal(report.beats.some((beat) => beat.visual_job === "system_reveal"), true);
  assert.equal(report.beats.some((beat) => beat.visual_job === "chat_ui_insert"), true);
  assert.equal(report.beats.some((beat) => beat.visual_job === "location_transition"), true);
  assert.equal(report.location_timeline.some((row) => row.location === "test arena"), true);
  assert.equal(typeof report.visual_beat_quality_summary?.finding_count, "number");
  assert.equal(report.beats.every((beat) => Array.isArray(beat.visual_beat_quality_findings)), true);
}

async function testVisualBeatQualityFindings() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const script = "Joey crossed into Analytics Hall. Agent00 waited beside the replay wall.";
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), script, "utf8");
  const scriptHash = sha256(script);
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    timing_source: "fixture",
    audio_duration_sec: 8,
    scenes: [{
      scene_id: "scene_001",
      start_sec: 0,
      end_sec: 8,
      duration_sec: 8,
      location: "dorm room",
      script_excerpt_start: "Joey crossed into Analytics Hall.",
      script_excerpt_end: "Agent00 waited beside the replay wall.",
      visible_subjects: ["Joey"],
      primary_subject: "Joey",
      character_states: [{ character: "Agent00", state: "waiting beside the replay wall" }],
      visual_intent: "fixture quality warning",
    }],
  });
  const words = script.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    audio_duration_sec: 8,
    word_count: words.length,
    words: words.map((word, index) => ({
      index,
      word,
      start_sec: Number((index * 8 / words.length).toFixed(3)),
      end_sec: Number(((index + 0.82) * 8 / words.length).toFixed(3)),
    })),
  });
  await execFileAsync(process.execPath, [
    "scripts/visual-beat-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--allow-under-target-retention-beats", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "visual_beat_plan.json"), "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.visual_beat_quality_findings.some((finding) => finding.code === "location_mention_not_in_beat_location"), true);
  assert.equal(report.visual_beat_quality_findings.some((finding) => finding.code === "named_character_not_visible_subject"), false);
  assert.equal(report.beats.some((beat) => (beat.visible_characters ?? []).includes("Agent00")), true);
  assert.equal(report.beats.some((beat) => beat.visual_beat_quality_findings?.length), true);
}

async function runVisualBeatGenreFixture({ caseName, cueSentences, scenes, expectedJobs = [], expectedCueCodes = [] }) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", caseName, "episodes", "ep_01");
  const sentences = Array.from({ length: 80 }, (_, index) => (
    cueSentences[index] ?? `${caseName} story beat ${index + 1} keeps the current conflict moving with a clear present-tense action.`
  ));
  const script = sentences.join(" ");
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), script, "utf8");
  const scriptHash = sha256(script);
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    timing_source: "fixture",
    audio_duration_sec: 180,
    scenes: scenes.map((scene) => ({
      scene_id: scene.scene_id,
      start_sec: scene.start_sec,
      end_sec: scene.end_sec,
      duration_sec: Number((scene.end_sec - scene.start_sec).toFixed(3)),
      location: scene.location,
      script_excerpt_start: sentences[scene.start_sentence],
      script_excerpt_end: sentences[scene.end_sentence],
      visible_subjects: scene.visible_subjects,
      primary_subject: scene.primary_subject,
      character_states: scene.character_states ?? [],
      visual_intent: scene.visual_intent,
      action_staging: scene.action_staging ?? "",
    })),
  });
  const words = script.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    audio_duration_sec: 180,
    word_count: words.length,
    words: words.map((word, index) => ({
      index,
      word,
      start_sec: Number((index * 180 / words.length).toFixed(3)),
      end_sec: Number(((index + 0.82) * 180 / words.length).toFixed(3)),
    })),
  });
  await execFileAsync(process.execPath, [
    "scripts/visual-beat-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", caseName,
    "--episode", "ep_01",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "visual_beat_plan.json"), "utf8"));
  assert.equal(report.status, "passed", caseName);
  assert.equal(report.hook_visual_beat_count >= 8, true, `${caseName} hook density`);
  assert.equal(report.retention_ramp_visual_beat_count >= 24, true, `${caseName} ramp density`);
  assert.equal(report.beats.every((beat) => String(beat.visual_beat_script_excerpt ?? "").trim()), true, `${caseName} excerpts`);
  assert.equal(report.beats.every((beat) => String(beat.visual_job ?? "").trim()), true, `${caseName} visual jobs`);
  assert.equal(report.beats.every((beat) => String(beat.suggested_shot_job ?? "").trim()), true, `${caseName} shot jobs`);
  assert.equal(report.location_timeline.length >= scenes.length, true, `${caseName} location timeline`);
  for (const job of expectedJobs) {
    assert.equal(report.beats.some((beat) => beat.visual_job === job), true, `${caseName} expected visual job ${job}`);
  }
  for (const code of expectedCueCodes) {
    assert.equal((report.editorial_cue_counts?.[code] ?? 0) > 0, true, `${caseName} expected cue ${code}`);
  }
  return report;
}

async function testCrossGenreVisualBeatFixtures() {
  const sharedScenes = (locations, subjects) => [
    {
      scene_id: "scene_001",
      start_sec: 0,
      end_sec: 68,
      location: locations[0],
      start_sentence: 0,
      end_sentence: 29,
      visible_subjects: subjects.slice(0, 3),
      primary_subject: subjects[0],
      visual_intent: "opening premise, public pressure, and first rule reveal",
    },
    {
      scene_id: "scene_002",
      start_sec: 68,
      end_sec: 124,
      location: locations[1],
      start_sentence: 30,
      end_sentence: 54,
      visible_subjects: subjects.slice(0, 4),
      primary_subject: subjects[0],
      visual_intent: "new location and first external test",
    },
    {
      scene_id: "scene_003",
      start_sec: 124,
      end_sec: 180,
      location: locations[2],
      start_sentence: 55,
      end_sentence: 79,
      visible_subjects: subjects.slice(0, 3),
      primary_subject: subjects[0],
      visual_intent: "consequence, evidence, and next objective",
    },
  ];

  const cases = [
    {
      caseName: "corporate_evidence",
      cueSentences: {
        0: "Mara Stone exposed Daniel Reed in the boardroom, and every director watched his access badge turn red.",
        3: "A risk ledger opened above the wire transfer.",
        5: "Objective, freeze the shell account before the timer reaches zero.",
        8: "The public investor score dropped on the wall display.",
        12: "The chairman threatened to erase Daniel before the vote finished.",
        20: "Daniel showed the signed receipt and the room stopped laughing.",
        30: "Daniel crossed into the courthouse lobby with the sealed evidence bag.",
        37: "Judge Mora entered beside the witness camera.",
        44: "The audit panel marked the transfer complete.",
        55: "Daniel entered the archive server room and found the deleted contract.",
        70: "The final proof result exposed the betrayal.",
      },
      scenes: sharedScenes(["executive boardroom", "courthouse lobby", "archive server room"], ["Daniel Reed", "Mara Stone", "Chairman Vale", "Judge Mora"]),
      expectedJobs: ["humiliation_image", "system_reveal", "chat_ui_insert", "location_transition", "consequence"],
      expectedCueCodes: ["public_humiliation_or_reversal", "objective_or_reward", "chat_or_viewer_count_change", "location_signal"],
    },
    {
      caseName: "fantasy_gate",
      cueSentences: {
        0: "Ari was exiled in the temple courtyard while the clan elders laughed at his broken rank.",
        2: "A blue ability panel activated over his empty palm.",
        5: "Quest, survive the gate trial before sunset.",
        9: "The crowd's ranking stones changed color.",
        14: "A monster warning flashed beside the cracked gate.",
        18: "The elders mocked Ari again when his broken rank mark started to burn.",
        22: "Ari stepped forward and the courtyard fell silent.",
        30: "Ari crossed into the shadow gate corridor with Lysa behind him.",
        36: "Captain Ren arrived with the rescue lantern.",
        45: "The trial score reached one hundred percent.",
        55: "Ari entered the moon palace roof and saw the enemy banner.",
        72: "The consequence appeared as the clan seal shattered.",
      },
      scenes: sharedScenes(["temple courtyard", "shadow gate corridor", "moon palace roof"], ["Ari", "Lysa", "Elder Sol", "Captain Ren"]),
      expectedJobs: ["humiliation_image", "system_reveal", "chat_ui_insert", "location_transition", "threat_reveal"],
      expectedCueCodes: ["system_message", "objective_or_reward", "threat_reveal", "location_signal"],
    },
    {
      caseName: "romance_betrayal",
      cueSentences: {
        0: "Elena rejected Rowan in the wedding hall, and every guest heard her call him a charity case.",
        4: "His phone messages appeared on the banquet screen.",
        7: "The reputation counter beside her name dropped.",
        11: "Rowan noticed the best man smiling with the stolen ring.",
        15: "The guests mocked Rowan again when the apology card appeared on the banquet screen.",
        18: "Instead of begging, Rowan placed the invitation on the floor.",
        30: "Rowan walked into the airport terminal with one suitcase and no speech.",
        39: "Mira arrived at the gate holding the missing receipt.",
        48: "The message thread proved who planned the humiliation.",
        55: "Rowan entered the hospital corridor after the accident call.",
        68: "The consequence landed when Elena saw the visitor log.",
      },
      scenes: sharedScenes(["wedding hall", "airport terminal", "hospital corridor"], ["Rowan", "Elena", "Mira", "Best Man"]),
      expectedJobs: ["humiliation_image", "chat_ui_insert", "location_transition", "reaction_shot", "consequence"],
      expectedCueCodes: ["public_humiliation_or_reversal", "chat_or_viewer_count_change", "emotional_pivot", "location_signal"],
    },
    {
      caseName: "quiet_investigation",
      cueSentences: {
        0: "Nolan found the missing ledger in the city library while the mayor's aide watched from the stairs.",
        5: "Objective, match the receipt numbers before the archive closes.",
        9: "The trust score on the civic dashboard changed by one point.",
        13: "The aide warned him that the basement cameras were still recording.",
        22: "Nolan turned the page and saw the forged signature.",
        30: "Nolan entered the street market with the ledger hidden under his coat.",
        38: "A witness arrived near the fruit stall and handed him a key.",
        47: "The message on the old phone confirmed the payment route.",
        55: "Nolan crossed into the courthouse archive below the public floor.",
        73: "The proof result appeared when the sealed drawer opened.",
      },
      scenes: sharedScenes(["city library", "street market", "courthouse archive"], ["Nolan", "Mayor's Aide", "Witness", "Archivist"]),
      expectedJobs: ["chat_ui_insert", "location_transition", "reaction_shot", "consequence"],
      expectedCueCodes: ["objective_or_reward", "chat_or_viewer_count_change", "threat_reveal", "location_signal"],
    },
  ];

  for (const item of cases) await runVisualBeatGenreFixture(item);
}

function testLongLocationSpanCrossingRetentionBoundary() {
  const prompts = Array.from({ length: 28 }, (_, index) => ({
    image_id: `cut-${String(index + 1).padStart(3, "0")}`,
    start_sec: 140 + index * 7.2,
    duration_sec: 7.2,
    shot_manifest: { location_ref_id: "analytics_hall_ref" },
  }));
  const findings = longLocationSpanFindings(prompts, {
    maxSameLocationSpanSec: 150,
    retentionStartSec: 180,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].locationId, "analytics_hall_ref");
  assert.equal(findings[0].measured_after_retention_start_sec > 150, true);
}

function testRepeatedRetentionShotJobRunFindings() {
  const prompts = Array.from({ length: 4 }, (_, index) => ({
    image_id: `cut-${String(index + 1).padStart(3, "0")}`,
    start_sec: 42 + index * 4,
    duration_sec: 4,
    shot_manifest: {
      location_ref_id: "analytics_hall_ref",
      shot_job: "ui_reveal",
    },
  }));
  const findings = repeatedLocationShotJobFindings(prompts, {
    maxConsecutiveSameLocationShotJob: 3,
    retentionEndSec: 180,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].locationId, "analytics_hall_ref");
  assert.equal(findings[0].shotJob, "ui_reveal");
  assert.equal(findings[0].count, 4);
}

async function testVisualPlanReportsOverbroadLocationRefCoverageBeforeLlm() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const weekDir = path.dirname(path.dirname(episodeDir));
  const hash = "fixture_hash";
  const beats = Array.from({ length: 9 }, (_, index) => {
    const start = 181 + index * 15;
    return {
      scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
      parent_scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
      visual_beat_id: `scene_${String(index + 1).padStart(3, "0")}_beat_01`,
      start_sec: start,
      end_sec: start + 15,
      duration_sec: 15,
      location: index % 3 === 0 ? "analytics replay wall" : index % 3 === 1 ? "sponsor table floor" : "public campus screen plaza",
      visual_beat_script_excerpt: `Fixture beat ${index + 1} moves the proof through a distinct visible area.`,
      visual_job: index % 2 === 0 ? "consequence" : "reaction_shot",
      suggested_shot_job: index % 2 === 0 ? "consequence" : "emotional_reaction",
      ref_needs: [],
    };
  });
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    timing_source: "fixture",
    scenes: beats.map((beat) => ({
      scene_id: beat.scene_id,
      start_sec: beat.start_sec,
      end_sec: beat.end_sec,
      duration_sec: beat.duration_sec,
      location: beat.location,
    })),
  });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: hash,
    beats,
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: hash, scenes: [] });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: [{
      ref_id: "analytics_hall_ref",
      kind: "location",
      subject: "single broad analytics environment",
      scene_ids: beats.map((beat) => beat.scene_id),
      prompt_anchor: "large analytics media environment with screens, tables, and public display surfaces",
    }],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), { status: "approved", source_script_hash: hash, character_state_refs: [] });
  await writeJson(path.join(weekDir, "visual_style_bible.json"), {});
  await writeJson(path.join(weekDir, "character_bible.json"), {});

  const dryRunOutput = path.join(episodeDir, "dry_run_visual_plan.json");
  await execFileAsync(process.execPath, [
    "scripts/visual-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--dry-run-prompt", "true",
    "--output", dryRunOutput,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const dryRun = JSON.parse(await fs.readFile(dryRunOutput, "utf8"));
  assert.equal(dryRun.context_audit.scoped_location_coverage_findings.length, 1);
  assert.equal(dryRun.context_audit.scoped_location_coverage_findings[0].locationRefId, "analytics_hall_ref");
}

async function testVisualPlanAllowsSameLocationLabelAliases() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const weekDir = path.dirname(path.dirname(episodeDir));
  const hash = "fixture_hash";
  const beats = Array.from({ length: 9 }, (_, index) => {
    const start = 181 + index * 15;
    const location = [
      "blood-smeared dungeon council chamber around a cracked fountain and scattered chests",
      "same dungeon council chamber beside the fountain and defensive chests",
      "dungeon council chamber fountain area with opened chests",
    ][index % 3];
    return {
      scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
      parent_scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
      visual_beat_id: `scene_${String(index + 1).padStart(3, "0")}_beat_01`,
      start_sec: start,
      end_sec: start + 15,
      duration_sec: 15,
      location,
      visual_beat_script_excerpt: `Fixture beat ${index + 1} remains in the same dungeon council chamber fountain area.`,
      visual_job: "humiliation_image",
      suggested_shot_job: "emotional_reaction",
      ref_needs: [],
    };
  });
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    timing_source: "fixture",
    scenes: beats.map((beat) => ({
      scene_id: beat.scene_id,
      start_sec: beat.start_sec,
      end_sec: beat.end_sec,
      duration_sec: beat.duration_sec,
      location: beat.location,
    })),
  });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: hash,
    beats,
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: hash, scenes: [] });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: [{
      ref_id: "dungeon_council_chamber_fountain_area_ref",
      kind: "location",
      subject: "dungeon council chamber fountain area",
      scene_ids: beats.map((beat) => beat.scene_id),
      prompt_anchor: "blood-smeared dungeon council chamber around a cracked fountain and scattered chests",
    }],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), { status: "approved", source_script_hash: hash, character_state_refs: [] });
  await writeJson(path.join(weekDir, "visual_style_bible.json"), {});
  await writeJson(path.join(weekDir, "character_bible.json"), {});

  const dryRunOutput = path.join(episodeDir, "dry_run_visual_plan.json");
  await execFileAsync(process.execPath, [
    "scripts/visual-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--dry-run-prompt", "true",
    "--output", dryRunOutput,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const dryRun = JSON.parse(await fs.readFile(dryRunOutput, "utf8"));
  assert.equal(dryRun.context_audit.scoped_location_coverage_findings.length, 0);
}

function testCharacterStagingSanitizerAndReviewBlockers() {
  const characterStateRefs = [
    {
      state_ref_id: "joey_state_ref",
      source_ref_id: "joey_ref",
      character: "Joey",
      scene_prompt_anchor: "dark varsity jacket over a white T-shirt, black jeans, scuffed sneakers",
    },
    {
      state_ref_id: "mira_state_ref",
      source_ref_id: "mira_ref",
      character: "Mira",
      scene_prompt_anchor: "cream fitted coat over a black dress, gold phone in hand, sharp heels",
    },
  ];
  const sanitized = sanitizeCharacterStaging([
    { name: "Joey", ref_id: "joey_state_ref", screen_position: "frame-left", wardrobe_from: "character_state_ref:joey_state_ref", pose: "half-turned toward Mira" },
  ]);
  assert.deepEqual(sanitized, [
    { name: "Joey", ref_id: "joey_state_ref", screen_position: "frame-left", wardrobe_from: "character_state_ref:joey_state_ref", pose: "half-turned toward Mira" },
  ]);

  const stagedManifest = {
    visible_characters: ["Joey", "Mira"],
    character_staging: [
      { name: "Joey", ref_id: "joey_state_ref", screen_position: "frame-left", wardrobe_from: "character_state_ref:joey_state_ref", pose: "half-turned toward Mira with one shoulder forward" },
      { name: "Mira", ref_id: "mira_state_ref", screen_position: "frame-right", wardrobe_from: "character_state_ref:mira_state_ref", pose: "chin lifted with her weight on the back foot" },
    ],
  };

  const matchingCoatsPrompt = {
    image_id: "ep_01-cut-010",
    scene_id: "scene_010",
    modelslab_image_prompt: "Joey and Mira stand together in matching coats near the lobby doors.",
    shot_manifest: stagedManifest,
  };
  const matchingCoatsFindings = multiCharacterBleedFindings(matchingCoatsPrompt, characterStateRefs);
  const matchingCoatsBlockers = matchingCoatsFindings.filter((finding) => finding.severity === "blocker" && finding.code === "character_attribute_bleed_risk");
  assert.equal(matchingCoatsBlockers.length, 1);

  const identicalHoodiesPrompt = {
    image_id: "ep_01-cut-011",
    scene_id: "scene_011",
    modelslab_image_prompt: "In the hallway, both Joey and Mira wear identical hoodies while staring each other down.",
    shot_manifest: stagedManifest,
  };
  const identicalHoodiesFindings = multiCharacterBleedFindings(identicalHoodiesPrompt, characterStateRefs);
  const identicalHoodiesBlockers = identicalHoodiesFindings.filter((finding) => finding.severity === "blocker" && finding.code === "character_attribute_bleed_risk");
  assert.equal(identicalHoodiesBlockers.length, 1);

  const naturalPositionPrompt = {
    image_id: "ep_01-cut-012",
    scene_id: "scene_012",
    modelslab_image_prompt: "On the left, Joey wears a dark varsity jacket over a white T-shirt and black jeans. On the right, Mira wears a cream fitted coat over a black dress and sharp heels.",
    shot_manifest: stagedManifest,
  };
  assert.equal(multiCharacterBleedFindings(naturalPositionPrompt, characterStateRefs).filter((finding) => finding.severity === "blocker").length, 0);

  const eyelineWithWardrobePrompt = {
    image_id: "ep_01-cut-012b",
    scene_id: "scene_012",
    modelslab_image_prompt: "Center, Mira wears a cream fitted coat over a black dress, tense public composure, eyes caught between Joey and the judge. Frame-left, Joey wears a dark varsity jacket over a white T-shirt and black jeans.",
    shot_manifest: stagedManifest,
  };
  assert.equal(multiCharacterBleedFindings(eyelineWithWardrobePrompt, characterStateRefs).filter((finding) => finding.severity === "blocker").length, 0);

  const separateWardrobeSharedTorsoPrompt = {
    image_id: "ep_01-cut-012c",
    scene_id: "scene_012",
    modelslab_image_prompt: "Frame-left, Joey wears a dark varsity jacket over a white T-shirt and black jeans while Mira wears a cream fitted coat over a black dress on frame-right; both full torsos stay clear above the table edge.",
    shot_manifest: stagedManifest,
  };
  assert.equal(multiCharacterBleedFindings(separateWardrobeSharedTorsoPrompt, characterStateRefs).filter((finding) => finding.severity === "blocker").length, 0);

  const splitSentenceWardrobePrompt = {
    image_id: "ep_01-cut-013",
    scene_id: "scene_013",
    modelslab_image_prompt: "Frame-left stands Joey. He wears a dark varsity jacket over a white T-shirt and black jeans. Frame-right stands Mira. She wears a cream fitted coat over a black dress and sharp heels.",
    shot_manifest: stagedManifest,
  };
  assert.equal(multiCharacterBleedFindings(splitSentenceWardrobePrompt, characterStateRefs).filter((finding) => finding.severity === "blocker").length, 0);

  const ownWardrobePrompt = {
    image_id: "ep_01-cut-014",
    scene_id: "scene_014",
    modelslab_image_prompt: "Joey faces Mira across the lobby in a dark varsity jacket. Mira squares up in a cream fitted coat with her phone in hand.",
    shot_manifest: stagedManifest,
  };
  assert.equal(multiCharacterBleedFindings(ownWardrobePrompt, characterStateRefs).filter((finding) => finding.severity === "blocker").length, 0);

  const paraphrasedWardrobePrompt = {
    image_id: "ep_01-cut-015",
    scene_id: "scene_015",
    modelslab_image_prompt: "On the left, Joey stands in his usual casual layers. On the right, Mira answers him in a polished upscale outfit.",
    shot_manifest: stagedManifest,
  };
  const paraphrasedWardrobeFindings = multiCharacterBleedFindings(paraphrasedWardrobePrompt, characterStateRefs);
  assert.equal(paraphrasedWardrobeFindings.filter((finding) => finding.severity === "blocker").length, 0);
  assert.equal(paraphrasedWardrobeFindings.filter((finding) => finding.severity === "warning").length >= 1, true);

  const contextualStateLabelPrompt = {
    image_id: "ep_01-cut-015b",
    scene_id: "scene_015",
    modelslab_image_prompt: "Center foreground, Joey watches the giant screen. On the giant screen, old Joey appears in the Crown Night clip holding flowers while Lana laughs in the replay panel. Background rows of students watch quietly.",
    shot_manifest: {
      visible_characters: ["Joey", "Joey in Crown Night clip", "Lana in Crown Night clip", "five hundred students"],
      character_staging: [
        { name: "Joey", ref_id: "joey_state_ref", screen_position: "foreground", wardrobe_from: "character_state_ref:joey_state_ref", pose: "watching the replay screen" },
        { name: "Joey in Crown Night clip", ref_id: "joey_state_ref", screen_position: "center", wardrobe_from: "character_state_ref:joey_state_ref", pose: "holding flowers on the giant screen" },
        { name: "Lana in Crown Night clip", ref_id: "mira_state_ref", screen_position: "background-right", wardrobe_from: "character_state_ref:mira_state_ref", pose: "laughing in the replay panel" },
        { name: "five hundred students", screen_position: "background-left", pose: "watching from audience rows" },
      ],
    },
  };
  assert.equal(multiCharacterBleedFindings(contextualStateLabelPrompt, characterStateRefs).filter((finding) => finding.severity === "blocker").length, 0);

  const missingCoveragePrompt = {
    image_id: "ep_01-cut-016",
    scene_id: "scene_016",
    modelslab_image_prompt: "On the left, Joey wears a dark varsity jacket over a white T-shirt and black jeans.",
    shot_manifest: {
      visible_characters: ["Joey", "Mira"],
      character_staging: [
        { name: "Joey", ref_id: "joey_state_ref", screen_position: "frame-left", wardrobe_from: "character_state_ref:joey_state_ref", pose: "half-turned toward Mira with one shoulder forward" },
      ],
    },
  };
  assert.equal(multiCharacterBleedFindings(missingCoveragePrompt, characterStateRefs).some((finding) => finding.severity === "blocker" && /character_staging must cover every visible character/i.test(finding.message)), true);

  const singleCharacterPrompt = {
    image_id: "ep_01-cut-017",
    scene_id: "scene_017",
    modelslab_image_prompt: "Joey pauses alone in the lobby, dark varsity jacket over a white T-shirt, black jeans, scuffed sneakers, one hand tight on the bag strap.",
    shot_manifest: {
      visible_characters: ["Joey"],
    },
  };
  assert.equal(multiCharacterBleedFindings(singleCharacterPrompt, characterStateRefs).length, 0);
}

async function testOnlyScenesDryRun() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const weekDir = path.dirname(path.dirname(episodeDir));
  const hash = "fixture_hash";
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    timing_source: "fixture",
    scenes: [
      { scene_id: "scene_001", start_sec: 0, duration_sec: 5, location: "apartment" },
      { scene_id: "scene_002", start_sec: 5, duration_sec: 5, location: "boardroom" },
    ],
  });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: hash,
    beats: [
      { scene_id: "scene_001", parent_scene_id: "scene_001", visual_beat_id: "scene_001_beat_01", start_sec: 0, duration_sec: 5, location: "apartment", ref_needs: [] },
      { scene_id: "scene_002", parent_scene_id: "scene_002", visual_beat_id: "scene_002_beat_01", start_sec: 5, duration_sec: 5, location: "boardroom", ref_needs: [] },
    ],
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: hash, scenes: [] });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: [{ ref_id: "style_ref", kind: "style", scene_ids: [] }],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), { status: "approved", source_script_hash: hash, character_state_refs: [] });
  await writeJson(path.join(weekDir, "visual_style_bible.json"), {});
  await writeJson(path.join(weekDir, "character_bible.json"), {});
  const output = path.join(episodeDir, "dry_run_visual_plan.json");
  await execFileAsync(process.execPath, [
    "scripts/visual-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--dry-run-prompt", "true",
    "--only-scenes", "scene_002",
    "--output", output,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(report.visual_plan_scope.selected_visual_unit_count, 1);
  assert.deepEqual(report.visual_plan_scope.cut_ids, ["ep_01-cut-002"]);

  const existingOutput = path.join(episodeDir, "section_image_prompts.json");
  await writeJson(existingOutput, {
    schema: "goldflow_section_image_prompts_v1",
    status: "passed",
    prompts: [
      {
        image_id: "ep_01-cut-001",
        scene_id: "scene_001",
        visual_beat_id: "scene_001_beat_01",
        provider_prompt: "16:9 landscape anime/manhwa view of the empty apartment.",
        image_prompt: "16:9 landscape anime/manhwa view of the empty apartment.",
        shot_manifest: { visible_characters: [], mentioned_only_characters: [], character_staging: [] },
      },
      {
        image_id: "ep_01-cut-002",
        scene_id: "scene_002",
        visual_beat_id: "scene_002_beat_01",
        provider_prompt: "16:9 landscape anime/manhwa view of the empty boardroom.",
        image_prompt: "16:9 landscape anime/manhwa view of the empty boardroom.",
        shot_manifest: { visible_characters: [], mentioned_only_characters: [], character_staging: [] },
      },
    ],
  });
  await execFileAsync(process.execPath, [
    "scripts/visual-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--revalidate-existing", "true",
    "--output", existingOutput,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const revalidated = JSON.parse(await fs.readFile(existingOutput, "utf8"));
  assert.equal(revalidated.status, "passed");
  assert.equal(revalidated.prompts.length, 2);
  assert.equal(revalidated.planner.revalidated_without_llm, true);
}

async function testOnlyCutIdsDryRun() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const weekDir = path.dirname(path.dirname(episodeDir));
  const hash = "fixture_hash";
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    timing_source: "fixture",
    scenes: [{ scene_id: "scene_001", start_sec: 0, duration_sec: 15, location: "event hall" }],
  });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: hash,
    beats: [
      { scene_id: "scene_001", parent_scene_id: "scene_001", visual_beat_id: "beat_001", start_sec: 0, duration_sec: 5, location: "event hall", ref_needs: [] },
      { scene_id: "scene_001", parent_scene_id: "scene_001", visual_beat_id: "beat_002", start_sec: 5, duration_sec: 5, location: "event hall", ref_needs: [] },
      { scene_id: "scene_001", parent_scene_id: "scene_001", visual_beat_id: "beat_003", start_sec: 10, duration_sec: 5, location: "event hall", ref_needs: [] },
    ],
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: hash, scenes: [] });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: [{ ref_id: "style_ref", kind: "style", scene_ids: [] }],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), { status: "approved", source_script_hash: hash, character_state_refs: [] });
  await writeJson(path.join(weekDir, "visual_style_bible.json"), {});
  await writeJson(path.join(weekDir, "character_bible.json"), {});
  const output = path.join(episodeDir, "dry_run_visual_plan_cut_ids.json");
  await execFileAsync(process.execPath, [
    "scripts/visual-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--dry-run-prompt", "true",
    "--cut-ids", "ep_01-cut-002",
    "--output", output,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(report.visual_plan_scope.selected_visual_unit_count, 1);
  assert.equal(report.visual_plan_scope.total_visual_unit_count, 3);
  assert.deepEqual(report.visual_plan_scope.cut_ids, ["ep_01-cut-002"]);
}

function testVisualResolveScopePrefersCutIds() {
  const blockers = [
    { severity: "blocker", resolved: false, scene_id: "scene_001", image_id: "ep_01-cut-002", code: "fixture_a" },
    { severity: "blocker", resolved: false, scene_id: "scene_001", image_id: "ep_01-cut-003", code: "fixture_b" },
  ];
  const scope = visualResolveScopeForBlockers(blockers);
  assert.equal(scope.mode, "cut_ids");
  assert.deepEqual(scope.args, ["--cut-ids", "ep_01-cut-002,ep_01-cut-003"]);
  const merged = mergeScopedPromptReplacements(
    [
      { image_id: "ep_01-cut-001", scene_id: "scene_001", prompt: "keep" },
      { image_id: "ep_01-cut-002", scene_id: "scene_001", prompt: "old two" },
      { image_id: "ep_01-cut-003", scene_id: "scene_001", prompt: "old three" },
    ],
    [{ image_id: "ep_01-cut-002", scene_id: "scene_001", prompt: "new two" }],
    scope
  );
  assert.deepEqual(merged.map((prompt) => prompt.prompt), ["keep", "new two", "old three"]);
  const sceneScope = visualResolveScopeForBlockers([{ severity: "blocker", resolved: false, scene_id: "scene_002", code: "scene_level" }]);
  assert.equal(sceneScope.mode, "manual_exact_scope_required");
  assert.deepEqual(sceneScope.args, []);
}

async function testImagegenDeadletterRefusal() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), { status: "passed", reference_targets: [] });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), { status: "approved", character_state_refs: [] });
  await writeJson(path.join(episodeDir, "section_image_prompts_hardened.json"), {
    status: "passed",
    prompt_policy: "deterministic hardening fixture",
    prompts: [{ image_id: "ep_01-cut-001", scene_id: "scene_001", image_prompt: "one visible fixture frame", modelslab_image_prompt: "one visible fixture frame", image_generation_required: true }],
  });
  await writeJson(path.join(episodeDir, "visual_resolution_deadletter.json"), {
    status: "blocked_deadletter",
    scene_ids: ["scene_001"],
  });
  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/imagegen.mjs",
      "--channel", "test",
      "--series", "series",
      "--week", "run",
      "--episode", "ep_01",
      "--skip-reference-generation", "true",
      "--allow-unhardened-prompts", "true",
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } }),
    /dead-lettered visual scenes/
  );

  const deadletterPath = path.join(episodeDir, "visual_resolution_deadletter.json");
  await writeJson(deadletterPath, {
    status: "resolved",
    previous_status: "blocked_deadletter",
    scene_ids: [],
    image_ids: [],
    unresolved_blockers: [],
  });
  await assert.doesNotReject(() => assertNoVisualResolutionDeadletterForTests(
    { status: "passed", visual_resolution_deadletter_path: deadletterPath },
    [{ image_id: "ep_01-cut-001", scene_id: "scene_001" }],
    { deadletterPath }
  ));

  await writeJson(deadletterPath, {
    status: "blocked_deadletter",
    scene_ids: ["scene_999"],
    image_ids: ["ep_01-cut-999"],
  });
  await assert.doesNotReject(() => assertNoVisualResolutionDeadletterForTests(
    { status: "passed", visual_resolution_deadletter_path: deadletterPath },
    [{ image_id: "ep_01-cut-001", scene_id: "scene_001" }],
    { deadletterPath }
  ));

  await writeJson(deadletterPath, {
    status: "blocked_deadletter",
    scene_ids: [],
    image_ids: ["ep_01-cut-001"],
  });
  await assert.rejects(
    () => assertNoVisualResolutionDeadletterForTests(
      { status: "passed", visual_resolution_deadletter_path: deadletterPath },
      [{ image_id: "ep_01-cut-001", scene_id: "scene_001" }],
      { deadletterPath }
    ),
    /dead-lettered visual cuts/
  );
}

function testHardenFeedbackBlockersMapToReviewResolveInput() {
  const promptPlan = {
    source_script_hash: "script_hash",
    prompts: [
      { image_id: "ep_01-cut-001", scene_id: "scene_001" },
      { image_id: "ep_01-cut-002", scene_id: "scene_002" },
    ],
  };
  const hardenReport = {
    status: "blocked",
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    source_script_hash: "script_hash",
    input_prompt_count: 2,
    findings: [
      {
        image_id: "ep_01-cut-002",
        scene_id: "scene_002",
        severity: "blocker",
        code: "physical_location_ref_missing",
        message: "fixture location blocker",
        resolved: false,
      },
      {
        image_id: "ep_01-cut-001",
        scene_id: "scene_001",
        severity: "warning",
        code: "fixture_warning",
        resolved: true,
      },
    ],
  };
  const blockers = compatibleHardenFeedbackBlockers({
    hardenReport,
    promptPlan,
    channel: "test",
    series: "series",
    week: "run",
    episode: "ep_01",
    hardenReportPath: "/tmp/harden.json",
  });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].source_stage, "visual_harden");
  assert.equal(blockers[0].source_report_path, "/tmp/harden.json");
  assert.equal(blockers[0].image_id, "ep_01-cut-002");
  assert.equal(blockers[0].code, "physical_location_ref_missing");
  assert.equal(hasHardenFeedbackFindings(blockers), true);
  assert.equal(hardenFeedbackBlockersNeedManualAgentReview(blockers), true);
  assert.equal(
    hardenFeedbackBlockersNeedManualAgentReview([
      ...blockers,
      { image_id: "ep_01-cut-003", scene_id: "scene_003", severity: "blocker", code: "regular_review_blocker", resolved: false },
    ]),
    false
  );
  assert.deepEqual(
    compatibleHardenFeedbackBlockers({
      hardenReport,
      promptPlan: { ...promptPlan, source_script_hash: "other_hash" },
      channel: "test",
      series: "series",
      week: "run",
      episode: "ep_01",
    }),
    []
  );
}

async function testRunStatusResumesBlockedVisualReviewWithoutFullReplan() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture narration for scoped visual review resume.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(path.join(episodeDir, "assets", "audio"), { recursive: true });
  await fs.mkdir(path.join(episodeDir, "assets", "images", "references"), { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { status: "passed", source_script_hash: scriptHash, replacements: [] });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "modelslab_qwen_tts_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash });
  const narrationPath = path.join(episodeDir, "assets", "audio", "fixture_narration.wav");
  await fs.writeFile(narrationPath, Buffer.from("fixture audio"));
  const narrationHash = sha256(await fs.readFile(narrationPath));
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    output_path: narrationPath,
    final_duration_sec: 1,
  });
  const wordTimingPath = path.join(episodeDir, "narration_word_timing_ep_01.json");
  await writeJson(wordTimingPath, { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash, word_count: 4, audio_duration_sec: 1 });
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    target_wpm_min: 195,
    target_wpm_max: 220,
    actual_wpm: 215,
  });
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    scenes: [
      { scene_id: "scene_001", start_sec: 0, end_sec: 1, duration_sec: 1 },
      { scene_id: "scene_002", start_sec: 1, end_sec: 2, duration_sec: 1 },
    ],
  });
  const finalAudioPath = path.join(episodeDir, "assets", "audio", "final_mix.m4a");
  await fs.writeFile(finalAudioPath, Buffer.from("fixture final audio"));
  await writeJson(path.join(episodeDir, "longform_audio_bed_report_ep_01.json"), { status: "passed", final_audio_path: finalAudioPath });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: scriptHash,
    beats: [],
  });
  const refPath = path.join(episodeDir, "assets", "images", "references", "style_ref.png");
  await fs.writeFile(refPath, Buffer.from("fixture ref"));
  const referenceInventoryPath = await writeFixtureReferenceInventory(episodeDir, scriptHash, [
    { asset_id: "style_ref", ref_id: "style_ref", kind: "style", subject: "fixture style", scene_ids: [], beat_ids: [] },
  ]);
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    reference_inventory_ledger_path: referenceInventoryPath,
    reference_targets: [{ ref_id: "style_ref", kind: "style", generation_mode: "standalone_ref", reference_image_path: refPath }],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), { status: "approved", source_script_hash: scriptHash, character_state_refs: [] });
  const prompts = [
    { image_id: "ep_01-cut-001", scene_id: "scene_001", visual_beat_id: "beat_001", modelslab_image_prompt: "fixture prompt one", image_prompt: "fixture prompt one" },
    { image_id: "ep_01-cut-002", scene_id: "scene_002", visual_beat_id: "beat_002", modelslab_image_prompt: "fixture prompt two", image_prompt: "fixture prompt two" },
  ];
  await writeJson(path.join(episodeDir, "section_image_prompts.json"), { status: "passed", source_script_hash: scriptHash, prompts });

  const { stdout: initialStdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const initialStatus = JSON.parse(initialStdout);
  assert.equal(initialStatus.current_stage, "visual_prompt_harden");
  assert.match(initialStatus.next_command_shape, /visual harden/);
  assert.match(initialStatus.next_command_shape, /section_image_prompts\.json/);
  assert.doesNotMatch(initialStatus.next_command_shape, /visual review/);

  await writeJson(path.join(episodeDir, "section_image_prompts_reviewed.json"), { status: "blocked", source_script_hash: scriptHash, prompts });
  await writeJson(path.join(episodeDir, "visual_prompt_review_ep_01.json"), {
    status: "blocked",
    findings: [{ severity: "blocker", resolved: false, code: "fixture_visual_blocker", scene_id: "scene_002", image_id: "ep_01-cut-002" }],
    unresolved_blocker_count: 1,
  });

  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  assert.equal(status.current_stage, "visual_prompt_harden");
  assert.match(status.next_command_shape, /visual review/);
  assert.match(status.next_command_shape, /--resume-blocked true/);
  assert.doesNotMatch(status.next_command_shape, /visual plan/);
  assert.doesNotMatch(status.next_command_shape, /visual harden/);

  const oldHardenTime = new Date("2026-01-01T00:00:00.000Z");
  const newReviewTime = new Date("2026-01-01T00:01:00.000Z");
  const hardenReportPath = path.join(episodeDir, "visual_prompt_hardening_ep_01.json");
  const hardenedPlanPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  const reviewedPlanPath = path.join(episodeDir, "section_image_prompts_reviewed.json");
  await writeJson(hardenedPlanPath, { status: "blocked", source_script_hash: scriptHash, prompts });
  await writeJson(hardenReportPath, {
    status: "blocked",
    source_script_hash: scriptHash,
    findings: [{ severity: "blocker", resolved: false, code: "fixture_harden_blocker", scene_id: "scene_002", image_id: "ep_01-cut-002" }],
    unresolved_blocker_count: 1,
  });
  await fs.utimes(hardenedPlanPath, oldHardenTime, oldHardenTime);
  await fs.utimes(hardenReportPath, oldHardenTime, oldHardenTime);
  await writeJson(reviewedPlanPath, { status: "passed", source_script_hash: scriptHash, prompts });
  await fs.utimes(reviewedPlanPath, newReviewTime, newReviewTime);

  const { stdout: repairedStdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const repairedStatus = JSON.parse(repairedStdout);
  assert.equal(repairedStatus.current_stage, "visual_prompt_harden");
  assert.match(repairedStatus.next_command_shape, /visual harden/);
  assert.doesNotMatch(repairedStatus.next_command_shape, /--resume-blocked true/);

  const manualReviewPath = path.join(episodeDir, "visual_manual_agent_review_ep_01.json");
  await writeJson(manualReviewPath, {
    status: "needs_manual_agent_review",
    image_ids: ["ep_01-cut-002"],
    unresolved_blockers: [{ severity: "blocker", resolved: false, source_stage: "visual_harden", code: "fixture_harden_blocker" }],
  });
  await writeJson(reviewedPlanPath, {
    status: "needs_manual_agent_review",
    source_script_hash: scriptHash,
    prompts,
    visual_manual_agent_review_path: manualReviewPath,
  });
  const { stdout: manualStdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const manualStatus = JSON.parse(manualStdout);
  const manualStage = manualStatus.stage_ledger.find((row) => row.stage === "visual_prompt_harden");
  assert.equal(manualStatus.current_stage, "visual_prompt_harden");
  assert.equal(manualStage.exists, false);
  assert.match(manualStatus.next_command_shape, /Manual agent review required/);
  assert.match(manualStatus.next_command_shape, /visual_manual_agent_review_ep_01\.json/);
}

function testPassedReviewClearsDeadletterPayload() {
  const resolved = resolvedDeadletterPayload(
    {
      status: "blocked_deadletter",
      channel: "test",
      series_slug: "series",
      week: "run",
      episode: "ep_01",
      scene_ids: ["scene_002"],
      unresolved_blockers: [{ scene_id: "scene_002", code: "missing_ref" }],
    },
    {
      channel: "test",
      series: "series",
      week: "run",
      episode: "ep_01",
      reviewReportPath: "/tmp/review.json",
      reviewedPromptPlanPath: "/tmp/reviewed.json",
      now: "2026-06-30T00:00:00.000Z",
    }
  );
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.previous_status, "blocked_deadletter");
  assert.deepEqual(resolved.scene_ids, []);
  assert.deepEqual(resolved.unresolved_blockers, []);
  assert.equal(resolved.resolved_by_review_report_path, "/tmp/review.json");
  assert.equal(
    resolvedDeadletterPayload({ status: "blocked_deadletter", episode: "ep_02" }, { episode: "ep_01" }),
    null
  );
}

async function runVisualHardenFixture({ dataRoot, promptText, codexPromptText = null, shotManifest = {}, referenceRequirements = [], referenceUsage = [], extraReferenceTargets = [], extraInventoryAssets = [], extraCharacterStateRefs = [], manualTriage = null, includeDefaultLocationRef = true, includeDefaultCharacterRef = true, locationContracts = null, referenceDirectorContractVersion = null, depictionMode = "current_reality", physicallyVisibleEntityIds = ["joey"], visualBeatId = "beat_001" }) {
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const hash = "fixture_hash";
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    scenes: [{ scene_id: "scene_001", start_sec: 0, duration_sec: 5, location: "apartment kitchen" }],
  });
  const referenceTargets = [
    ...(includeDefaultLocationRef ? [{ ref_id: "loc_apartment", kind: "location", subject: "apartment kitchen", scene_ids: ["scene_001"], reference_image_path: "/tmp/loc_apartment.png" }] : []),
    ...(includeDefaultCharacterRef ? [{ ref_id: "char_joey_ref", kind: "character_state", subject: "Joey", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_joey_ref.png" }] : []),
    ...extraReferenceTargets,
  ];
  const referenceInventoryPath = await writeFixtureReferenceInventory(episodeDir, hash, [
    ...referenceTargets.map((target) => ({
      asset_id: target.ref_id,
      ...target,
      recommended_generation_mode: target.generation_mode ?? (target.reference_image_path ? "standalone_ref" : "no_ref_needed"),
      recommended_required_before_imagegen: target.required_before_imagegen ?? Boolean(target.reference_image_path),
    })),
    ...extraInventoryAssets,
  ]);
  const locationContractPath = path.join(episodeDir, "location_contract_ledger.json");
  if (locationContracts) {
    await writeJson(locationContractPath, {
      schema: "goldflow_location_contract_ledger_v1",
      status: "passed",
      source_script_hash: hash,
      contracts: locationContracts,
    });
  }
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_director_contract_version: referenceDirectorContractVersion,
    location_contract_ledger_path: locationContracts ? locationContractPath : null,
    reference_inventory_ledger_path: referenceInventoryPath,
    reference_targets: referenceTargets,
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), {
    status: "approved",
    source_script_hash: hash,
    character_state_refs: [
      ...(includeDefaultCharacterRef ? [{ state_ref_id: "char_joey_state", source_ref_id: "char_joey_ref", character: "Joey", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_joey_ref.png" }] : []),
      ...extraCharacterStateRefs,
    ],
  });
  await writeJson(path.join(episodeDir, "section_image_prompts_reviewed.json"), {
    status: "passed",
    source_script_hash: hash,
    prompts: [{
      image_id: "ep_01-cut-001",
      scene_id: "scene_001",
      visual_beat_id: visualBeatId,
      image_prompt: promptText,
      modelslab_image_prompt: promptText,
      codex_image_prompt: codexPromptText,
      location: "apartment kitchen",
      depiction_mode: depictionMode,
      physically_visible_entity_ids: physicallyVisibleEntityIds,
      reference_requirements: referenceRequirements,
      reference_usage: referenceUsage,
      shot_manifest: {
        visible_characters: ["Joey"],
        character_state_ref_ids: ["char_joey_state"],
        location_contract_id: null,
        location_ref_id: "loc_apartment",
        forbidden_ref_ids: [],
        ...shotManifest,
      },
    }],
  });
  if (manualTriage) {
    await writeJson(path.join(episodeDir, "visual_manual_blocker_triage_ep_01.json"), manualTriage);
  }
  let error = null;
  try {
    await execFileAsync(process.execPath, [
      "scripts/visual-prompt-harden.mjs",
      "--channel", "test",
      "--series", "series",
      "--week", "run",
      "--episode", "ep_01",
      "--prompts", path.join(episodeDir, "section_image_prompts_reviewed.json"),
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  } catch (caught) {
    error = caught;
  }
  const plan = JSON.parse(await fs.readFile(path.join(episodeDir, "section_image_prompts_hardened.json"), "utf8"));
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "visual_prompt_hardening_ep_01.json"), "utf8"));
  return { plan, report, error };
}

async function testVisualHardenAllowsStoryFaithfulNegativeWordsWithoutRewrite() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey at the apartment desk, no second character, no readable text.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 5 },
    ],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(plan.prompts[0].modelslab_image_prompt, promptText);
  assert.equal(plan.prompts[0].image_prompt, promptText);
  assert.equal(report.findings.some((finding) => finding.code === "provider_exclusion_payload"), false);
}

async function testVisualHardenStripsNonAttachableScopedRefs() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey at the apartment desk with a small holographic one-scene notice on his phone.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    extraReferenceTargets: [{
      ref_id: "late_ui_ref",
      kind: "ui",
      subject: "one-scene phone notice",
      scene_ids: ["scene_001"],
      generation_mode: "no_ref_needed",
      required_before_imagegen: false,
      prompt_anchor: "scoped text-only UI target for a simple phone notice",
    }],
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "late_ui_ref", kind: "ui", slot_order: 2 },
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 3 },
    ],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), ["loc_apartment", "char_joey_state"]);
  assert.equal(report.findings.some((finding) => finding.code === "non_attachable_reference_stripped" && finding.ref_id === "late_ui_ref"), true);
}

async function testVisualHardenRetainsPendingDerivedRequirementWithoutSlot() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Anime/manhwa frame. Joey studies the massive black mirror in the academy courtyard.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    extraReferenceTargets: [{
      ref_id: "obsidian_mirror_ref",
      kind: "prop",
      subject: "Obsidian Mirror",
      scene_ids: ["scene_001"],
      generation_mode: "derive_from_best_cut",
      required_before_imagegen: false,
      prompt_anchor: "massive vertical black mirror with an oil-like surface",
    }],
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 2 },
      { ref_id: "obsidian_mirror_ref", kind: "prop", slot_order: 3 },
    ],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  const pending = plan.prompts[0].reference_requirements.find((requirement) => requirement.ref_id === "obsidian_mirror_ref");
  assert.equal(pending.pending_derived_reference, true);
  assert.equal(pending.reference_image_path, null);
  assert.equal(plan.prompts[0].reference_slots.some((slot) => slot.ref_id === "obsidian_mirror_ref"), false);
  assert.equal(report.findings.some((finding) => finding.code === "pending_derived_reference_retained"), true);
}

async function testVisualHardenAcceptsInventoryOnlyLocationContract() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText: "Anime/manhwa frame. Joey stands at a rain-dark academy evacuation fork divided between a forest path and a smoke-covered wall.",
    includeDefaultLocationRef: false,
    extraInventoryAssets: [{
      asset_id: "academy_evacuation_fork",
      ref_id: "academy_evacuation_fork",
      kind: "location",
      subject: "rain-dark academy evacuation fork",
      scene_ids: ["scene_001"],
      recommended_generation_mode: "no_ref_needed",
      recommended_required_before_imagegen: false,
    }],
    shotManifest: {
      visible_characters: [],
      location_ref_id: "academy_evacuation_fork",
      foreground_action: "empty fork under rain",
    },
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(report.findings.some((finding) => finding.code === "unknown_manifest_location_ref"), false);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_location_ref_text_only"), true);
}

async function testVisualHardenLeavesCleanPromptByteIdenticalAndNormalizesRefs() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey at the apartment desk with bills spread across the table in quiet morning light.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 9 },
    ],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(plan.prompts[0].modelslab_image_prompt, promptText);
  assert.equal(plan.prompts[0].image_prompt, promptText);
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), ["loc_apartment", "char_joey_state"]);
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.slot_order), [1, 2]);
  assert.deepEqual(plan.prompts[0].reference_slots.map((slot) => slot.ref_id), ["loc_apartment", "char_joey_state"]);
  assert.deepEqual(
    plan.prompts[0].shot_manifest.reference_slots.map((slot) => slot.ref_id),
    plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id),
  );
  assert.deepEqual(plan.prompts[0].required_reference_paths, plan.prompts[0].reference_slots.map((slot) => slot.path));
  assert.equal(report.findings.some((finding) => finding.code === "provider_exclusion_payload"), false);
}

async function testVisualHardenCanonicalizesStateRefRequirements() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey at the apartment desk with bills spread across the table in quiet morning light.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "char_joey_state", kind: "character_state", slot_order: 2 },
    ],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), ["loc_apartment", "char_joey_state"]);
  assert.equal(plan.prompts[0].shot_manifest.character_state_ref_ids[0], "char_joey_state");
  assert.equal(report.findings.some((finding) => finding.code === "unknown_reference_id"), false);
}

async function testVisualHardenBlocksOnlyUnusablePromptText() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText: "   ",
    includeDefaultCharacterRef: false,
    shotManifest: {
      visible_characters: [],
      character_state_ref_ids: [],
      protagonist_state_ref_id: null,
      location_ref_id: null,
    },
    referenceRequirements: [],
  });
  assert.notEqual(error, null);
  assert.equal(plan.status, "blocked");
  assert.equal(report.hard_stop_count, 1);
  assert.equal(report.findings.some((finding) => (
    finding.code === "prompt_text_unusable"
    && finding.severity === "blocker"
    && finding.production_blocking === true
  )), true);
}

async function testVisualHardenAcceptsExactApprovedBeatScopeAcrossSceneBoundary() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText: "Joey stands at the apartment window in quiet morning light.",
    includeDefaultCharacterRef: false,
    extraReferenceTargets: [{
      ref_id: "char_joey_exact_beat_ref",
      kind: "character_state",
      subject: "Joey",
      scene_ids: ["scene_elsewhere"],
      planned_beat_ids: ["beat_exact_scope"],
      reference_image_path: "/tmp/char_joey_exact_beat_ref.png",
    }],
    extraCharacterStateRefs: [{
      state_ref_id: "char_joey_exact_beat_state",
      source_ref_id: "char_joey_exact_beat_ref",
      character: "Joey",
      scene_ids: ["scene_elsewhere"],
      planned_beat_ids: ["beat_exact_scope"],
      reference_image_path: "/tmp/char_joey_exact_beat_ref.png",
    }],
    visualBeatId: "beat_exact_scope",
    shotManifest: {
      character_state_ref_ids: [],
      protagonist_state_ref_id: null,
    },
    referenceRequirements: [],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(plan.prompts[0].reference_requirements.some((row) => row.ref_id === "char_joey_exact_beat_state"), true);
  assert.equal(report.findings.some((finding) => finding.code === "visible_character_ref_scope_missing"), false);
}

async function testVisualHardenAcceptsRecurringBaseIdentityAcrossSceneBoundary() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText: "Joey stands at the apartment window in quiet morning light.",
    includeDefaultCharacterRef: false,
    extraReferenceTargets: [{
      ref_id: "char_joey_base_ref",
      kind: "character_state",
      subject: "Joey - base facial identity",
      conditioning_asset_role: "identity_state",
      scene_ids: ["scene_elsewhere"],
      reference_image_path: "/tmp/char_joey_base_ref.png",
    }],
    extraCharacterStateRefs: [{
      state_ref_id: "char_joey_base_state",
      source_ref_id: "char_joey_base_ref",
      character: "Joey",
      scene_ids: ["scene_elsewhere"],
      reference_image_path: "/tmp/char_joey_base_ref.png",
    }],
    shotManifest: {
      character_state_ref_ids: [],
      protagonist_state_ref_id: null,
    },
    referenceRequirements: [],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(plan.prompts[0].reference_requirements.some((row) => ["char_joey_base_ref", "char_joey_base_state"].includes(row.ref_id)), true);
  assert.equal(report.findings.some((finding) => finding.code === "visible_character_ref_scope_missing"), false);
}

async function testVisualHardenNormalizesReferenceCapWithoutBlocking() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const extraReferenceTargets = [
    { ref_id: "prop_ref", kind: "prop", subject: "ledger", scene_ids: ["scene_001"], reference_image_path: "/tmp/prop_ref.png" },
    { ref_id: "ui_ref", kind: "ui", subject: "status panel", scene_ids: ["scene_001"], reference_image_path: "/tmp/ui_ref.png" },
    { ref_id: "action_ref", kind: "action", subject: "impact language", scene_ids: ["scene_001"], reference_image_path: "/tmp/action_ref.png" },
  ];
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText: "Joey stands in the apartment kitchen holding a ledger beneath a status panel as impact light crosses the room.",
    extraReferenceTargets,
    referenceRequirements: [
      { ref_id: "action_ref", kind: "action", slot_order: 1 },
      { ref_id: "ui_ref", kind: "ui", slot_order: 2 },
      { ref_id: "prop_ref", kind: "prop", slot_order: 3 },
      { ref_id: "loc_apartment", kind: "location", slot_order: 4 },
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 5 },
    ],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.deepEqual(plan.prompts[0].reference_requirements.map((row) => row.ref_id), [
    "char_joey_state",
    "loc_apartment",
    "ui_ref",
    "prop_ref",
  ]);
  assert.equal(report.findings.some((finding) => (
    finding.code === "reference_limit_normalized"
    && finding.dropped_ref_ids.includes("action_ref")
    && finding.review_disposition === "manual_fix_or_accept"
  )), true);
}

async function testVisualHardenBlocksVisibleCharacterWhenScopedRefOmitted() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey stands at the apartment desk holding a red ledger stamp while the room watches.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    referenceRequirements: [{ ref_id: "loc_apartment", kind: "location", slot_order: 1 }],
    shotManifest: {
      visible_characters: ["Joey"],
      character_state_ref_ids: [],
      protagonist_state_ref_id: null,
    },
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(report.findings.some((finding) => (
    finding.code === "visible_character_ref_auto_attached"
    && finding.character === "Joey"
    && finding.resolved === true
  )), true);
  assert.equal(plan.prompts[0].reference_requirements.some((requirement) => (
    requirement.kind === "character_state"
  )), true);
}

async function testVisualPlannerKeepsCanonicalIdentityTargetsForVisibleCharacters() {
  const scene = {
    scene_id: "scene_001",
    parent_scene_id: "scene_001",
    visible_characters: ["Joey Manhwa", "Alyssa Grant", "Jace Mercer"],
    physically_visible_entity_ids: ["joey_manhwa", "alyssa_grant", "jace_mercer"],
    visual_beat_script_excerpt: "Joey films while Alyssa kisses Jace.",
    visual_job: "premise_image",
  };
  const characterTargets = [
    ["joey_manhwa_identity", "Joey Manhwa — canonical identity", "Joey Manhwa"],
    ["alyssa_grant_identity", "Alyssa Grant — canonical identity", "Alyssa Grant"],
    ["jace_mercer_identity", "Jace Mercer — canonical celebrity streamer identity", "Jace Mercer"],
  ];
  const visualReferencePlan = {
    reference_targets: [
      ...characterTargets.map(([refId, subject]) => ({
        ref_id: refId,
        kind: "character_state",
        subject,
        scene_ids: ["scene_001"],
        generation_mode: "standalone_ref",
        reference_image_path: `/tmp/${refId}.png`,
      })),
      {
        ref_id: "initial_filming_area",
        kind: "location",
        subject: "Initial filming area",
        scene_ids: ["scene_001"],
        generation_mode: "standalone_ref",
        reference_image_path: "/tmp/initial_filming_area.png",
      },
    ],
  };
  const characterStateRefs = {
    character_state_refs: characterTargets.map(([refId, , character]) => ({
      state_ref_id: refId,
      source_ref_id: refId,
      character,
      scene_ids: ["scene_001"],
      scene_prompt_anchor: `${character}, exact approved identity and wardrobe`,
      reference_image_path: `/tmp/${refId}.png`,
    })),
  };

  const targets = relevantReferenceTargetsForTests(scene, visualReferencePlan, characterStateRefs);
  assert.deepEqual(targets.map((target) => target.ref_id), [
    "joey_manhwa_identity",
    "alyssa_grant_identity",
    "jace_mercer_identity",
    "initial_filming_area",
  ]);
  for (const target of targets.slice(0, 3)) {
    assert.equal(target.attachable_reference, true);
    assert.match(target.scene_prompt_anchor, /exact approved identity and wardrobe/);
  }
}

async function testVisualHardenBlocksVisibleCharacterWhenOnlyOutOfScopeRefExists() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey swings the red paddle across a mahogany desk in the contract-sky office chamber.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    includeDefaultCharacterRef: false,
    extraReferenceTargets: [{
      ref_id: "char_joey_ref",
      kind: "character_state",
      subject: "Joey",
      scene_ids: ["scene_002"],
      reference_image_path: "/tmp/char_joey_ref.png",
    }],
    extraCharacterStateRefs: [{
      state_ref_id: "char_joey_state",
      source_ref_id: "char_joey_ref",
      character: "Joey",
      scene_ids: ["scene_002"],
      reference_image_path: "/tmp/char_joey_ref.png",
      scene_prompt_anchor: "Joey, adult male protagonist in dark practical confrontation clothing",
    }],
    referenceRequirements: [{ ref_id: "loc_apartment", kind: "location", slot_order: 1 }],
    shotManifest: {
      visible_characters: ["Joey"],
      character_state_ref_ids: [],
      protagonist_state_ref_id: null,
      foreground_action: "Joey swings the red paddle in the contract-sky office chamber",
    },
  });
  assert.notEqual(error, null);
  assert.equal(plan.status, "blocked");
  assert.equal(report.findings.some((finding) => (
    finding.code === "visible_character_ref_scope_missing"
    && finding.character === "Joey"
    && finding.out_of_scope_ref_ids.includes("char_joey_ref")
  )), true);
}

async function testVisualHardenTreatsCollectiveSubjectsAsGeneric() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "A Crown Academy dean, an academy official, the Goddess Council, raid survivors, and an injured woman occupy the institutional chamber.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    includeDefaultCharacterRef: false,
    extraReferenceTargets: [
      {
        ref_id: "emily_world_goddess_crown_state",
        kind: "character_state",
        subject: "Emily World Goddess Crown",
        scene_ids: ["scene_002"],
        reference_image_path: "/tmp/emily_world_goddess_crown_state.png",
      },
      {
        ref_id: "stoneback_ram_creature_identity",
        kind: "character_state",
        subject: "Stoneback Ram Creature",
        scene_ids: ["scene_002"],
        reference_image_path: "/tmp/stoneback_ram_creature_identity.png",
      },
    ],
    referenceRequirements: [{ ref_id: "loc_apartment", kind: "location", slot_order: 1 }],
    shotManifest: {
      visible_characters: ["Crown Academy dean", "academy official frame-left", "Goddess Council", "Weeping Chapel Raid Survivors", "injured woman"],
      character_state_ref_ids: [],
      protagonist_state_ref_id: null,
    },
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(report.findings.some((finding) => (
    finding.code === "visible_character_ref_not_attached"
    || finding.code === "visible_character_ref_scope_missing"
  )), false);
}

async function testVisualHardenWaivesNonphysicalScreenAndReplayDepictions() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "A projected replay screen shows Jace on a birthday stage while the physical room stays empty.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    includeDefaultCharacterRef: false,
    extraReferenceTargets: [{
      ref_id: "jace_civilian_identity",
      kind: "character_state",
      subject: "Jace",
      scene_ids: ["scene_002"],
      reference_image_path: "/tmp/jace_civilian_identity.png",
    }],
    referenceRequirements: [{ ref_id: "loc_apartment", kind: "location", slot_order: 1 }],
    shotManifest: {
      visible_characters: ["Jace"],
      character_state_ref_ids: [],
      protagonist_state_ref_id: null,
      character_staging: [{
        name: "Jace",
        screen_position: "center of a projected replay screen",
        wardrobe_from: "recorded birthday broadcast",
        pose: "nonphysical portrait inside the replay",
      }],
    },
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(report.findings.some((finding) => (
    finding.code === "preview_character_ref_scope_waived"
    && finding.character === "Jace"
    && finding.resolved === true
  )), true);
}

async function testVisualHardenBlocksAttachedCharacterRefWhenAnchorIgnored() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const vaguePromptText = "Frame-left, Joey in clean academy clothes watches the stage with a controlled expression.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText: vaguePromptText,
    codexPromptText: vaguePromptText,
    extraCharacterStateRefs: [{
      state_ref_id: "char_joey_state",
      source_ref_id: "char_joey_ref",
      character: "Joey",
      scene_ids: ["scene_001"],
      reference_image_path: "/tmp/char_joey_ref.png",
      scene_prompt_anchor: "Joey, dark practical confrontation clothing, controlled survivor-auditor presence, restrained but ready",
    }],
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 2 },
    ],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(report.findings.some((finding) => (
    finding.code === "character_ref_anchor_not_reaffirmed"
    && finding.ref_id === "char_joey_state"
    && finding.prompt_field === "modelslab_image_prompt"
    && finding.severity === "warning"
    && finding.review_disposition === "manual_fix_or_accept"
  )), true);
  assert.equal(report.findings.some((finding) => (
    finding.code === "character_ref_anchor_not_reaffirmed"
    && finding.ref_id === "char_joey_state"
    && finding.prompt_field === "codex_image_prompt"
  )), false);
}

async function testVisualHardenAllowsAttachedCharacterRefWhenAnchorReaffirmed() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Frame-left, Joey in dark practical confrontation clothing stands with controlled survivor-auditor presence, restrained but ready, watching the stage.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    codexPromptText: promptText,
    extraCharacterStateRefs: [{
      state_ref_id: "char_joey_state",
      source_ref_id: "char_joey_ref",
      character: "Joey",
      scene_ids: ["scene_001"],
      reference_image_path: "/tmp/char_joey_ref.png",
      scene_prompt_anchor: "Joey, dark practical confrontation clothing, controlled survivor-auditor presence, restrained but ready",
    }],
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 2 },
    ],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(report.findings.some((finding) => finding.code === "character_ref_anchor_not_reaffirmed"), false);
}

async function testVisualHardenPreservesAttachableFaceOnlyStateRef() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey sits at the office workstation in open-collar work clothes, wrist mark visible, exhausted but steady.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    extraReferenceTargets: [
      {
        ref_id: "joey_office_worker_ref",
        kind: "character_state",
        subject: "Joey",
        scene_ids: ["scene_001"],
        identity_usage: "face_only",
        base_identity_ref_id: "char_joey_ref",
        reference_image_path: "/tmp/joey_office_worker_ref.png",
        scene_prompt_anchor: "Joey in open-collar work clothes with wrist mark visible",
      },
    ],
    extraCharacterStateRefs: [
      {
        state_ref_id: "joey_office_worker_ref",
        source_ref_id: "char_joey_ref",
        character: "Joey",
        scene_ids: ["scene_001"],
        identity_usage: "face_only",
        base_identity_ref_id: "char_joey_ref",
        reference_image_path: "/tmp/joey_office_worker_ref.png",
        scene_prompt_anchor: "Joey in open-collar work clothes with wrist mark visible",
      },
    ],
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "joey_office_worker_ref", kind: "character_state", slot_order: 2 },
    ],
    shotManifest: {
      character_state_ref_ids: ["joey_office_worker_ref"],
      protagonist_state_ref_id: "joey_office_worker_ref",
    },
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), ["loc_apartment", "joey_office_worker_ref"]);
  assert.equal(plan.prompts[0].reference_requirements[1].reference_image_path, "/tmp/joey_office_worker_ref.png");
  assert.equal(plan.prompts[0].reference_requirements[1].base_identity_ref_id, "char_joey_ref");
  assert.equal(plan.prompts[0].shot_manifest.character_state_ref_ids[0], "joey_office_worker_ref");
  assert.equal(plan.prompts[0].shot_manifest.protagonist_state_ref_id, "joey_office_worker_ref");
  assert.equal(report.findings.some((finding) => finding.code === "unknown_reference_id"), false);
}

async function testVisualHardenBlocksMissingManifestLocationWithoutAddingIt() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey at the apartment desk with bills spread across the table in quiet morning light.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    referenceRequirements: [{ ref_id: "char_joey_ref", kind: "character_state", slot_order: 1 }],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), ["char_joey_state"]);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_location_ref_not_attached_report_only"), true);
  assert.equal(report.findings.some((finding) => (
    finding.code === "manifest_location_ref_missing_after_sanitize"
    && finding.severity === "warning"
    && finding.review_disposition === "manual_fix_or_accept"
  )), true);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_location_ref_added"), false);
}

async function testVisualHardenBlocksMissingPendingDerivedLocationContract() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey stands in the academy courtyard under the punishment pillar while students watch from the gate.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    includeDefaultLocationRef: false,
    shotManifest: { location_ref_id: null },
    extraReferenceTargets: [{
      ref_id: "academy_courtyard_ref",
      kind: "location",
      subject: "academy courtyard",
      scene_ids: ["scene_001"],
      generation_mode: "derive_from_first_clean_wide_cut",
      prompt_anchor: "academy courtyard punishment pillar and main gate",
    }],
    referenceRequirements: [{ ref_id: "char_joey_ref", kind: "character_state", slot_order: 1 }],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(report.findings.some((finding) => (
    finding.code === "physical_location_ref_missing"
    && finding.severity === "warning"
    && finding.review_required === true
  )), true);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_location_ref_added"), false);
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), ["char_joey_state"]);
}

async function testVisualHardenV2AcceptsTextLocationContractWithoutImageRef() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey stands alone in the apartment kitchen beside the window in quiet morning light.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    referenceDirectorContractVersion: "reference_director_v2",
    locationContracts: [{
      location_contract_id: "apartment_kitchen_contract",
      scene_ids: ["scene_001"],
      description: "apartment kitchen",
      prompt_anchor: "compact apartment kitchen with one window and dark counters",
    }],
    includeDefaultLocationRef: false,
    shotManifest: {
      location_contract_id: "apartment_kitchen_contract",
      location_ref_id: null,
    },
    referenceRequirements: [{ ref_id: "char_joey_ref", kind: "character_state", slot_order: 1 }],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(plan.prompts[0].shot_manifest.location_contract_id, "apartment_kitchen_contract");
  assert.equal(plan.prompts[0].shot_manifest.location_ref_id, null);
  assert.equal(report.findings.some((finding) => finding.code === "physical_location_contract_missing"), false);
}

async function testVisualHardenV2AllowsPureScreenDepictionWithoutLocationContract() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "A full-screen dashboard fills the apartment monitor while the physical room remains offscreen.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    depictionMode: "document_or_screen",
    physicallyVisibleEntityIds: [],
    referenceDirectorContractVersion: "reference_director_v2",
    locationContracts: [{
      location_contract_id: "apartment_kitchen_contract",
      scene_ids: ["scene_001"],
      description: "apartment kitchen",
      prompt_anchor: "compact apartment kitchen with one window and dark counters",
    }],
    includeDefaultLocationRef: false,
    includeDefaultCharacterRef: false,
    shotManifest: {
      visible_characters: [],
      character_state_ref_ids: [],
      protagonist_state_ref_id: null,
      location_contract_id: null,
      location_ref_id: null,
    },
    referenceRequirements: [],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(report.findings.some((finding) => finding.code === "physical_location_contract_missing"), false);
  assert.equal(report.findings.some((finding) => finding.code === "screen_only_location_contract_not_required"), true);
}

async function testVisualHardenV2StillBlocksCurrentRealityWithoutLocationContract() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "An empty apartment kitchen with a table and morning light fills the frame.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    depictionMode: "current_reality",
    physicallyVisibleEntityIds: [],
    referenceDirectorContractVersion: "reference_director_v2",
    locationContracts: [{
      location_contract_id: "apartment_kitchen_contract",
      scene_ids: ["scene_001"],
      description: "apartment kitchen",
      prompt_anchor: "compact apartment kitchen with one window and dark counters",
    }],
    includeDefaultLocationRef: false,
    includeDefaultCharacterRef: false,
    shotManifest: {
      visible_characters: [],
      character_state_ref_ids: [],
      protagonist_state_ref_id: null,
      location_contract_id: null,
      location_ref_id: null,
    },
    referenceRequirements: [],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(report.findings.some((finding) => (
    finding.code === "physical_location_contract_missing"
    && finding.severity === "warning"
    && finding.review_required === true
  )), true);
}

async function testVisualHardenV2BlocksUnknownLocationContract() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey stands alone in the apartment kitchen beside the window in quiet morning light.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    referenceDirectorContractVersion: "reference_director_v2",
    locationContracts: [{
      location_contract_id: "apartment_kitchen_contract",
      scene_ids: ["scene_001"],
      description: "apartment kitchen",
      prompt_anchor: "compact apartment kitchen with one window and dark counters",
    }],
    includeDefaultLocationRef: false,
    shotManifest: {
      location_contract_id: "invented_location_contract",
      location_ref_id: null,
    },
    referenceRequirements: [{ ref_id: "char_joey_ref", kind: "character_state", slot_order: 1 }],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(report.findings.some((finding) => (
    finding.code === "unknown_location_contract_id"
    && finding.severity === "warning"
    && finding.review_disposition === "manual_fix_or_accept"
  )), true);
}

async function testVisualHardenManualTriageCanDisregardSpecificBlocker() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey at the apartment desk with bills spread across the table in quiet morning light.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    shotManifest: { location_ref_id: null },
    referenceRequirements: [{ ref_id: "char_joey_ref", kind: "character_state", slot_order: 1 }],
    manualTriage: {
      schema: "goldflow_visual_manual_blocker_triage_v1",
      status: "approved",
      dispositions: [{
        image_id: "ep_01-cut-001",
        scene_id: "scene_001",
        code: "physical_location_ref_missing",
        disposition: "manual_disregard",
        rationale: "Fixture agent verified the available location ref is intentionally not applicable.",
      }],
    },
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(report.manual_triage_applied_count, 1);
  assert.equal(report.findings.some((finding) => finding.code === "physical_location_ref_missing" && finding.manual_disposition === "manual_disregard"), true);
  assert.equal(report.unresolved_blocker_count, 0);
}

async function testVisualHardenPreservesCrowdedCharacterRefsOverOmittedLocation() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Four named characters stand on the apartment kitchen floor with clear separate bodies and a visible table edge.";
  const extraReferenceTargets = [
    { ref_id: "char_pookie_ref", kind: "character_state", subject: "Pookie", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_pookie_ref.png" },
    { ref_id: "char_kai_ref", kind: "character_state", subject: "Kai", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_kai_ref.png" },
    { ref_id: "char_jinx_ref", kind: "character_state", subject: "Jinx", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_jinx_ref.png" },
  ];
  const extraCharacterStateRefs = [
    { state_ref_id: "char_pookie_state", source_ref_id: "char_pookie_ref", character: "Pookie", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_pookie_ref.png" },
    { state_ref_id: "char_kai_state", source_ref_id: "char_kai_ref", character: "Kai", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_kai_ref.png" },
    { state_ref_id: "char_jinx_state", source_ref_id: "char_jinx_ref", character: "Jinx", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_jinx_ref.png" },
  ];
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    extraReferenceTargets,
    extraCharacterStateRefs,
    referenceRequirements: [
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 1 },
      { ref_id: "char_pookie_ref", kind: "character_state", slot_order: 2 },
      { ref_id: "char_kai_ref", kind: "character_state", slot_order: 3 },
      { ref_id: "char_jinx_ref", kind: "character_state", slot_order: 4 },
    ],
    referenceUsage: [{
      ref_id: "loc_apartment",
      usage: "available_not_attached_reference_limit",
      reason: "Four visible character refs fill the available reference slots.",
    }],
    shotManifest: {
      visible_characters: ["Joey", "Pookie", "Kai", "Jinx"],
      character_state_ref_ids: ["char_joey_state", "char_pookie_state", "char_kai_state", "char_jinx_state"],
      location_ref_id: "loc_apartment",
    },
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), [
    "char_joey_state",
    "char_pookie_state",
    "char_kai_state",
    "char_jinx_state",
  ]);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_location_ref_omitted_for_reference_limit"), true);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_character_ref_dropped_for_location_ref_limit"), false);
}

async function testLocalWhisperRevalidationAndStatusContract() {
  const dataRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "goldflow-local-whisper-contract-"),
  );
  try {
    const episodeDir = path.join(
      dataRoot,
      "channels",
      "test",
      "weekly_runs",
      "run",
      "episodes",
      "ep_01",
    );
    const scriptPath = path.join(episodeDir, "script_clean.md");
    const runIdentityPath = path.join(episodeDir, "run_identity.json");
    const audioPath = path.join(episodeDir, "assets", "audio", "narration.wav");
    const stitchPath = path.join(
      episodeDir,
      "audio_stitch_report_ep_01-narration.json",
    );
    const timingPath = path.join(
      episodeDir,
      "narration_word_timing_ep_01.json",
    );
    const scriptText = "zero";
    await fs.mkdir(path.dirname(audioPath), { recursive: true });
    await fs.writeFile(scriptPath, scriptText, "utf8");
    await fs.writeFile(audioPath, Buffer.from("synthetic narration bytes"));
    const scriptHash = sha256(Buffer.from(scriptText));
    const audioHash = sha256(await fs.readFile(audioPath));
    const contract = structuredClone(PRODUCTION_LOCAL_WHISPER_CONTRACT);
    await writeJson(runIdentityPath, {
      schema: "goldflow_run_identity_v2",
      stage_registry_version: "2026-07-29.2",
      channel: "test",
      series_slug: "series",
      week: "run",
      episode: "ep_01",
      tts_provider: "qwen_local",
      audio_target: "narrator_only",
      provider_locks: {
        local_whisper_timing: structuredClone(contract),
      },
      production_profile_config: {
        audio: {
          local_whisper_timing: structuredClone(contract),
        },
      },
      production_gates: {
        local_whisper_contract_required: true,
      },
      model_versions: {
        local_whisper_model: "small.en",
      },
    });
    await writeJson(stitchPath, {
      status: "passed",
      source_script_hash: scriptHash,
      output_path: audioPath,
      output_sha256: audioHash,
      segments: [{
        unit_id: "unit_001",
        segment_id: "seg_001",
        text: scriptText,
        duration_sec: 1,
      }],
    });
    await writeJson(timingPath, {
      schema: "goldflow_local_whisper_word_timing_v2",
      status: "passed",
      source_script_hash: scriptHash,
      narration_audio_hash: audioHash,
      alignment_contract_version: "local_whisper_word_timing_v2",
      alignment_engine: "faster_whisper",
      alignment_model: "small.en",
      alignment_device: "cpu",
      alignment_compute_type: "int8_float32",
      alignment_omp_num_threads: 12,
      alignment_cpu_threads: 0,
      alignment_beam_size: 5,
      alignment_word_timestamps: true,
      alignment_vad_filter: false,
      alignment_contract: structuredClone(contract),
      language: "en",
      language_probability: 1,
      audio_duration_sec: 1,
      word_count: 1,
      full_stream_transcript_qa: { status: "passed" },
      words: [{
        index: 0,
        word: "zero",
        start_sec: 0.2,
        end_sec: 0.2,
        probability: 0.99,
      }],
    });

    await execFileAsync(process.execPath, [
      "scripts/local-whisper-word-timing.mjs",
      "--episode-dir", episodeDir,
      "--revalidate-existing", "true",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot },
    });
    const report = await readJson(timingPath);
    assert.equal(report.status, "passed");
    assert.equal(report.alignment_model, "small.en");
    assert.equal(report.alignment_omp_num_threads, 12);
    assert.equal(report.alignment_cpu_threads, 0);
    assert.equal(report.word_timing_qa.status, "passed");
    assert.equal(report.word_timing_qa.zero_duration_word_count, 1);
    assert.equal(report.word_timing_qa.warnings[0].severity, "warning");
    assert.equal(report.source_hashes[scriptPath], scriptHash);
    assert.equal(report.source_hashes[audioPath], audioHash);
    assert.equal(
      report.narration_report_sha256,
      sha256(await fs.readFile(stitchPath)),
    );
    assert.equal(
      report.run_identity_sha256,
      sha256(await fs.readFile(runIdentityPath)),
    );

    const statusFor = async () => {
      const { stdout } = await execFileAsync(process.execPath, [
        "scripts/run-status.mjs",
        "--episode-dir", episodeDir,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot },
      });
      return JSON.parse(stdout);
    };
    const status = await statusFor();
    let timingStage = status.stage_ledger.find(
      (row) => row.stage === "local_whisper_word_timing",
    );
    assert.equal(timingStage.exists, true, timingStage.evidence);
    assert.match(timingStage.evidence, /zero_duration_word_timings=1 warning_only/);

    report.alignment_contract.model = "medium";
    await writeJson(timingPath, report);
    const mismatchedTimingSha256 = sha256(await fs.readFile(timingPath));
    await assert.rejects(
      execFileAsync(process.execPath, [
        "scripts/local-whisper-word-timing.mjs",
        "--episode-dir", episodeDir,
        "--revalidate-existing", "true",
      ], {
        cwd: process.cwd(),
        env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot },
      }),
      (error) => /does not match the locked run identity/i.test(
        String(error?.stderr ?? error?.message ?? error),
      ),
    );
    assert.equal(
      sha256(await fs.readFile(timingPath)),
      mismatchedTimingSha256,
      "failed revalidation must preserve the existing timing artifact",
    );
    assert.equal(
      (await fs.readdir(episodeDir)).some(
        (name) => name.startsWith(
          "local_whisper_word_timing_failure_ep_01_",
        ),
      ),
      true,
    );
    const mismatchedStatus = await statusFor();
    timingStage = mismatchedStatus.stage_ledger.find(
      (row) => row.stage === "local_whisper_word_timing",
    );
    assert.equal(timingStage.exists, false);
    assert.match(timingStage.evidence, /report contract mismatch.*model/i);
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

async function testNarratorOnlyStatusAndMixer() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture narration.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(path.join(episodeDir, "assets", "audio"), { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "modelslab_qwen_tts_report_ep_01.json"), { status: "passed" });
  const narrationPath = path.join(episodeDir, "assets", "audio", "fixture_narration.wav");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "sine=frequency=220:sample_rate=44100",
    "-t", "3",
    "-acodec", "pcm_s16le",
    narrationPath,
  ]);
  const narrationHash = sha256(await fs.readFile(narrationPath));
  const wordTimingPath = path.join(episodeDir, "narration_word_timing_ep_01.json");
  await writeJson(wordTimingPath, { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash, word_count: 3, audio_duration_sec: 3 });
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    target_wpm_min: 195,
    target_wpm_max: 220,
    actual_wpm: 214.286,
    source_hashes: {
      [path.join(episodeDir, "script_clean.md")]: scriptHash,
      [wordTimingPath]: sha256(await fs.readFile(wordTimingPath)),
    },
  });
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), {
    status: "passed",
    output_path: narrationPath,
    segments: [{ segment_id: "seg_001", duration_sec: 3 }],
  });

  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  assert.equal(status.current_stage, "longform_audio_mix");
  assert.match(status.next_command_shape, /--narration-only true/);
  assert.equal(status.stage_ledger.find((row) => row.stage === "script_pace_check").exists, true);
  assert.equal(status.stage_ledger.find((row) => row.stage === "audio_pace_check").exists, true);
  assert.equal(status.stage_ledger.find((row) => row.stage === "sfx_score_plan").exists, true);

  await writeJson(wordTimingPath, { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash, word_count: 4, audio_duration_sec: 3 });
  const staleStatusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const staleStatus = JSON.parse(staleStatusResult.stdout);
  const staleAudioPace = staleStatus.stage_ledger.find((row) => row.stage === "audio_pace_check");
  assert.equal(staleStatus.current_stage, "audio_pace_check");
  assert.equal(staleAudioPace.exists, false);
  assert.match(staleAudioPace.evidence, /narration_word_timing_ep_01\.json stale/);
  await writeJson(wordTimingPath, { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash, word_count: 3, audio_duration_sec: 3 });

  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), { status: "blocked", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220, actual_wpm: 167.54 });
  const blockedStatusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const blockedStatus = JSON.parse(blockedStatusResult.stdout);
  assert.equal(blockedStatus.current_stage, "longform_audio_mix");
  assert.match(blockedStatus.next_command_shape, /audio longform-bed/);
  assert.doesNotMatch(blockedStatus.next_command_shape, /tts qwen|audio tempo-normalize/);
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220, actual_wpm: 214.286 });

  await execFileAsync(process.execPath, [
    "scripts/modelslab-longform-audio-bed.mjs",
    "start",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--episodeDir", episodeDir,
    "--qwenReport", path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"),
    "--outputBase", "fixture-narrator-only",
    "--reportSuffix", "-fixture",
    "--narration-only", "true",
    "--narration-volume-db", "1",
    "--target-lufs", "-16",
    "--true-peak-db", "-1",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "longform_audio_bed_report_ep_01-fixture.json"), "utf8"));
  assert.equal(report.status, "completed");
  assert.equal(report.audio_design_enabled, false);
  assert.equal(report.skip_sfx, true);
  assert.equal(report.transition_sfx_enabled, false);
  assert.equal(await fs.stat(report.mix.m4a_path).then((stat) => stat.isFile()), true);
  assert.equal(report.mix.wav_path, report.mix.intermediate_wav_path);
  assert.equal(report.mix.intermediate_wav_deleted, false);
  assert.equal(await fs.stat(report.mix.intermediate_wav_path).then(() => true).catch(() => false), true);
}

async function testRunCleanupPrunesNarratorOnlyLongformWav() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const mixDir = path.join(episodeDir, "assets", "audio", "longform_mix");
  await fs.mkdir(mixDir, { recursive: true });
  const wavPath = path.join(mixDir, "fixture-narrator-only.wav");
  const m4aPath = path.join(mixDir, "fixture-narrator-only.m4a");
  await fs.writeFile(wavPath, Buffer.alloc(2048));
  await fs.writeFile(m4aPath, Buffer.alloc(1024));
  const legacyFishPath = path.join(episodeDir, "narration_fish_performance_ep_01.txt");
  const legacyFishReportPath = path.join(episodeDir, "fish_reference_requirements_report.json");
  await fs.writeFile(legacyFishPath, "legacy fish narration text", "utf8");
  await writeJson(legacyFishReportPath, { status: "passed", tts_provider: "qwen3-tts" });
  await writeJson(path.join(episodeDir, "narration_generation_plan.json"), { status: "passed", tts_provider: "kokoro_local", segments: [{ segment_id: "seg_001" }] });
  await writeJson(path.join(episodeDir, "voice_reference_completeness_report.json"), { status: "passed", tts_provider: "kokoro_local" });
  await writeJson(path.join(episodeDir, "longform_audio_bed_report_ep_01.json"), {
    status: "completed",
    audio_design_enabled: false,
    narration_only: true,
    mix: {
      audio_design_enabled: false,
      narration_only: true,
      wav_path: wavPath,
      m4a_path: m4aPath,
    },
  });
  const dryRun = await execFileAsync(process.execPath, [
    "scripts/run-cleanup.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const dryPayload = JSON.parse(dryRun.stdout);
  assert.equal(dryPayload.candidate_count, 3);
  assert.equal(dryPayload.actions.filter((row) => row.type === "legacy_fish_voice_artifact_for_unit_narration_run").length, 2);
  assert.equal(await fs.stat(wavPath).then((stat) => stat.isFile()), true);
  assert.equal(await fs.stat(legacyFishPath).then((stat) => stat.isFile()), true);
  await execFileAsync(process.execPath, [
    "scripts/run-cleanup.mjs",
    "--episode-dir", episodeDir,
    "--apply", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "longform_audio_bed_report_ep_01.json"), "utf8"));
  assert.equal(report.mix.wav_path, null);
  assert.equal(report.mix.intermediate_wav_deleted, true);
  assert.equal(await fs.stat(wavPath).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(m4aPath).then((stat) => stat.isFile()), true);
  assert.equal(await fs.stat(legacyFishPath).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(legacyFishReportPath).then(() => true).catch(() => false), false);
}

async function testRunStatusBlocksLegacyScriptPaceHookWarnings() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture script with a slow hook marker.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    target_wpm_min: 195,
    target_wpm_max: 220,
    hook_milestone_report: {
      warnings: [{ code: "late_hidden_power_spark", severity: "warning" }],
    },
  });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const stage = status.stage_ledger.find((row) => row.stage === "script_pace_check");
  assert.equal(status.current_stage, "script_pace_check");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /hook_warnings=1/);
}

async function testRunStatusBlocksMissingQwenStitchedAudio() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture script for missing stitched audio.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { status: "passed", source_script_hash: scriptHash, replacements: [] });
  const semanticPath = path.join(episodeDir, "semantic_scene_plan.json");
  const semanticArtifact = { status: "passed", source_script_hash: scriptHash };
  await writeJson(semanticPath, semanticArtifact);
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "modelslab_qwen_tts_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash });
  const missingAudioPath = path.join(episodeDir, "assets", "audio", "missing.wav");
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), { status: "passed", source_script_hash: scriptHash, output_path: missingAudioPath });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const stage = status.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(status.current_stage, "qwen_tts_stitch");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /stitched narration missing/);
}

async function testRunStatusHashBindsCurrentQwenStitch() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture script for hash-bound stitched audio.";
  const scriptHash = sha256(Buffer.from(scriptText));
  const audioPath = path.join(episodeDir, "assets", "audio", "narration.wav");
  await fs.mkdir(path.dirname(audioPath), { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await fs.writeFile(audioPath, Buffer.from("fixture-audio"));
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { status: "passed", source_script_hash: scriptHash, replacements: [] });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "modelslab_qwen_tts_report_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    unit_qa_policy_version: "fixture_current_policy",
  });
  const stitchReportPath = path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json");
  const baseStitchReport = {
    status: "passed",
    source_script_hash: scriptHash,
    output_path: audioPath,
    unit_qa_policy_version: "fixture_current_policy",
    stitch_policy: { padding_aware: true },
  };
  await writeJson(stitchReportPath, baseStitchReport);

  const statusFor = async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/run-status.mjs",
      "--episode-dir", episodeDir,
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
    return JSON.parse(stdout);
  };

  const missingHashStatus = await statusFor();
  let stage = missingHashStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /hash missing/);

  await writeJson(stitchReportPath, { ...baseStitchReport, output_sha256: "not-the-current-hash" });
  const wrongHashStatus = await statusFor();
  stage = wrongHashStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /report requires not-the-current-hash/);

  await writeJson(stitchReportPath, { ...baseStitchReport, output_sha256: sha256(Buffer.from("fixture-audio")) });
  const matchingHashStatus = await statusFor();
  stage = matchingHashStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(stage.exists, true);
}

async function testRunStatusAcceptsGenericNarrationWithSelectedFallbackRepair() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-generic-narration-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "The ledger opened. Then the gate answered.";
  const scriptHash = sha256(Buffer.from(scriptText));
  const audioBytes = Buffer.from("fixture-puck-and-fallback-audio");
  const audioHash = sha256(audioBytes);
  const audioPath = path.join(episodeDir, "assets", "audio", "narration.wav");
  const m4aPath = path.join(episodeDir, "assets", "audio", "narration.m4a");
  const voiceProviderOptions = defaultNarrationVoiceProviderOptions({
    provider: "kokoro_local",
    fallbackProvider: "qwen_local",
    voiceId: "am_puck",
    nativeSpeed: 1.2,
  });
  const policy = narrationTtsPolicyForIdentity({
    episode: "ep_01",
    tts_provider: "kokoro_local",
    tts_fallback_provider: "qwen_local",
    narrator_voice_id: "am_puck",
    tts_native_speed: 1.2,
    voice_provider_options: voiceProviderOptions,
  });
  await fs.mkdir(path.dirname(audioPath), { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await fs.writeFile(audioPath, audioBytes);
  await fs.writeFile(m4aPath, audioBytes);
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    schema: "goldflow_run_identity_v2",
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    run_intent: "diagnostic",
    audio_target: "narrator_only",
    image_provider: "modelslab",
    tts_provider: "kokoro_local",
    tts_fallback_provider: "qwen_local",
    narrator_voice_id: "am_puck",
    tts_native_speed: 1.2,
    voice_provider_options: voiceProviderOptions,
    provider_locks: {
      tts_provider: "kokoro_local",
      tts_fallback_provider: "qwen_local",
      narrator_voice_id: "am_puck",
      tts_native_speed: 1.2,
      fallback_voice_identity: policy.fallback.reference_voice_id,
      fallback_reference_audio_sha256: policy.fallback.reference_audio_sha256,
      fallback_reference_metadata_sha256: policy.fallback.reference_metadata_sha256,
      fallback_similarity_model_sha256:
        policy.fallback.speaker_similarity_model_sha256,
      fallback_similarity_calibration_sha256:
        policy.fallback.speaker_similarity_calibration_sha256,
      fallback_minimum_cosine_similarity:
        policy.fallback.minimum_cosine_similarity,
      fallback_warning_below_cosine_similarity:
        policy.fallback.warning_below_cosine_similarity,
    },
    model_versions: {
      tts_model: policy.primary.model_id,
      tts_model_revision: policy.primary.model_revision,
      fallback_tts_model: policy.fallback.model_id,
      fallback_tts_model_revision: policy.fallback.model_revision,
    },
  });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), {
    operator_approved: true,
    script_clean_hash: scriptHash,
  });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    target_wpm_min: 195,
    target_wpm_max: 220,
  });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), {
    status: "passed",
    source_script_hash: scriptHash,
  });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    replacements: [],
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
  });
  await writeJson(path.join(episodeDir, "story_fact_ledger.json"), {
    status: "passed",
    source_script_hash: scriptHash,
  });
  const firstText = "The ledger opened.";
  const fallbackText = "Then the gate answered.";
  const firstTextHash = sha256(firstText);
  const fallbackTextHash = sha256(fallbackText);
  const planPath = path.join(episodeDir, "narration_generation_plan.json");
  const ttsReportPath = path.join(episodeDir, "narration_tts_report_ep_01.json");
  const unitQaPath = path.join(episodeDir, "narration_tts_unit_qa_ep_01.json");
  const fullQaPath = path.join(episodeDir, "narration_full_stream_qa_ep_01.json");
  const stitchReportPath = path.join(episodeDir, "audio_stitch_report_ep_01-narration.json");
  const continuityReportPath = path.join(
    episodeDir,
    "assets/audio/narration_tts/runs/qwen-voice-continuity-attempt-1.json",
  );
  const planFallbackControls = {
    target_voice_id: policy.primary.voice_id,
    target_voice_sha256: policy.primary.voice_sha256,
    reference_audio_path: policy.fallback.reference_audio_path,
    reference_audio_sha256: policy.fallback.reference_audio_sha256,
    reference_transcript_path: policy.fallback.reference_text_path,
    reference_transcript_sha256: policy.fallback.reference_text_sha256,
    reference_transcript_file_sha256: policy.fallback.reference_text_file_sha256,
    reference_metadata_path: policy.fallback.reference_metadata_path,
    reference_metadata_sha256: policy.fallback.reference_metadata_sha256,
    voice_continuity_contract: policy.fallback.voice_continuity_contract,
    speaker_similarity_method: policy.fallback.speaker_similarity_method,
    speaker_similarity_model_path: policy.fallback.speaker_similarity_model_path,
    speaker_similarity_model_sha256: policy.fallback.speaker_similarity_model_sha256,
    hard_minimum_cosine_similarity: policy.fallback.minimum_cosine_similarity,
    warning_floor_cosine_similarity: policy.fallback.warning_floor_cosine_similarity,
    fallback_scope: "exact_failed_unit_only",
    exact_unit_only: true,
    whole_episode_fallback_allowed: false,
  };
  const basePlan = {
    status: "passed",
    // Legacy TTS artifacts bind the exact file hash even when a newer producer
    // has also embedded a distinct canonical plan hash.
    plan_sha256: sha256("canonical-plan-hash-distinct-from-file-hash"),
    source_script_hash: scriptHash,
    primary_provider: "kokoro_local",
    fallback_provider: "qwen_local",
    narrator_voice_id: "am_puck",
    narrator_voice_sha256: policy.primary.voice_sha256,
    tts_native_speed: 1.2,
    provider_controls: {
      kokoro: { voice_id: policy.primary.voice_id },
      qwen3: planFallbackControls,
    },
    text_integrity_coverage: { status: "passed" },
    system_ui_speech_coverage: { status: "passed" },
    segments: [{
      segment_id: "seg_001",
      narration_units: [
        {
          unit_id: "unit_001",
          order_index: 0,
          spoken_text: firstText,
          tts_spoken_text: firstText,
          spoken_text_sha256: firstTextHash,
          caption_text: firstText,
          reference_id: policy.primary.voice_id,
          provider_controls: {
            kokoro: { voice_id: policy.primary.voice_id },
            qwen3: planFallbackControls,
          },
        },
        {
          unit_id: "unit_002",
          order_index: 1,
          spoken_text: fallbackText,
          tts_spoken_text: fallbackText,
          spoken_text_sha256: fallbackTextHash,
          caption_text: fallbackText,
          reference_id: policy.primary.voice_id,
          provider_controls: {
            kokoro: { voice_id: policy.primary.voice_id },
            qwen3: planFallbackControls,
          },
        },
      ],
    }],
  };
  await writeJson(planPath, basePlan);
  const planSha256 = sha256(await fs.readFile(planPath));
  const passingUnitQa = { status: "passed", findings: [] };
  await writeJson(continuityReportPath, {
    schema: "goldflow_tts_voice_continuity_qa_v1",
    status: "passed",
  });
  const continuityReportSha256 = sha256(await fs.readFile(continuityReportPath));
  const passingFallbackContinuity = {
    schema: "goldflow_tts_voice_continuity_unit_qa_v1",
    status: "passed",
    audio_sha256: audioHash,
    cosine_similarity: 0.925,
    minimum_cosine_similarity: policy.fallback.minimum_cosine_similarity,
    warning_below_cosine_similarity:
      policy.fallback.warning_below_cosine_similarity,
    reference_voice_id: policy.primary.voice_id,
    reference_voice_sha256: policy.primary.voice_sha256,
    reference_audio_sha256: policy.fallback.reference_audio_sha256,
    similarity_model_sha256: policy.fallback.speaker_similarity_model_sha256,
    similarity_calibration_sha256:
      policy.fallback.speaker_similarity_calibration_sha256,
    voice_continuity_contract: policy.fallback.voice_continuity_contract,
    report_path: continuityReportPath,
    report_sha256: continuityReportSha256,
  };
  const passingFallbackUnitQa = {
    status: "passed",
    findings: [],
    voice_continuity: passingFallbackContinuity,
  };
  const baseResults = [
    {
      unit_id: "unit_001",
      selected_provider: "kokoro_local",
      provider: "kokoro_local",
      spoken_text_sha256: firstTextHash,
      primary_spoken_text_sha256: firstTextHash,
      selected_spoken_text_sha256: firstTextHash,
      fallback_spoken_text_sha256: null,
      voice_id: policy.primary.voice_id,
      voice_continuity_contract: "native_puck_preset",
      voice_continuity: null,
      audio_path: audioPath,
      audio_sha256: audioHash,
      selected_qa: passingUnitQa,
    },
    {
      unit_id: "unit_002",
      selected_provider: "qwen_local",
      provider: "qwen_local",
      spoken_text_sha256: fallbackTextHash,
      primary_spoken_text_sha256: fallbackTextHash,
      selected_spoken_text_sha256: fallbackTextHash,
      fallback_spoken_text_sha256: fallbackTextHash,
      voice_id: policy.primary.voice_id,
      voice_continuity_contract: policy.fallback.voice_continuity_contract,
      voice_continuity: passingFallbackContinuity,
      audio_path: audioPath,
      audio_sha256: audioHash,
      selected_qa: passingFallbackUnitQa,
    },
  ];
  const baseTtsReport = {
    schema: "goldflow_narration_tts_report_v1",
    status: "passed",
    source_script_hash: scriptHash,
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: planSha256,
    primary_provider: "kokoro_local",
    primary_model_id: policy.primary.model_id,
    primary_model_revision: policy.primary.model_revision,
    narrator_voice_id: "am_puck",
    voice_sha256: policy.primary.voice_sha256,
    tts_native_speed: 1.2,
    qa_policy: policy.qa_policy,
    unit_qa_status: "passed",
    full_stream_qa_status: "passed",
    expected_unit_count: 2,
    selected_unit_count: 2,
    fallback_unit_ids: ["unit_002"],
    fallback_selected_unit_ids: ["unit_002"],
    fallback_usage: {
      provider: policy.fallback.provider,
      unit_ids: ["unit_002"],
      exact_unit_only: true,
      target_voice_id: policy.primary.voice_id,
      target_voice_sha256: policy.primary.voice_sha256,
      voice_continuity_contract: policy.fallback.voice_continuity_contract,
      reference_audio_sha256: policy.fallback.reference_audio_sha256,
      speaker_similarity_model_sha256: policy.fallback.speaker_similarity_model_sha256,
      speaker_similarity_calibration_sha256:
        policy.fallback.speaker_similarity_calibration_sha256,
      minimum_cosine_similarity: policy.fallback.minimum_cosine_similarity,
      warning_below_cosine_similarity:
        policy.fallback.warning_below_cosine_similarity,
    },
    unit_qa_path: unitQaPath,
    full_stream_qa_path: fullQaPath,
    final_wav: audioPath,
    final_wav_sha256: audioHash,
    final_m4a: m4aPath,
    final_m4a_sha256: audioHash,
    results: baseResults,
    candidate_history: [{
      unit_id: "unit_002",
      provider: "kokoro_local",
      status: "rejected",
      unit_qa: {
        status: "blocked",
        findings: [{
          severity: "blocker",
          code: "tts_transcript_confirmed_deletion",
        }],
      },
    }],
  };
  const baseUnitQa = {
    schema: "goldflow_narration_tts_unit_qa_v1",
    status: "passed",
    source_script_hash: scriptHash,
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: planSha256,
    selected_blocker_count: 0,
    selected_blockers: [],
    selected_units: baseResults.map((row) => ({
      unit_id: row.unit_id,
      provider: row.selected_provider,
      voice_id: row.voice_id,
      voice_continuity_contract: row.voice_continuity_contract,
      spoken_text_sha256: row.spoken_text_sha256,
      audio_path: row.audio_path,
      audio_sha256: row.audio_sha256,
      qa: row.selected_qa,
    })),
  };
  const baseFullQa = {
    schema: "goldflow_narration_full_stream_qa_v1",
    status: "passed",
    source_script_hash: scriptHash,
    narration_generation_plan_sha256: planSha256,
    audio_path: audioPath,
    audio_sha256: audioHash,
    intended_text_sha256: sha256(`${firstText} ${fallbackText}`),
    order_qa: {
      status: "passed",
      expected_unit_ids: ["unit_001", "unit_002"],
      actual_unit_ids: ["unit_001", "unit_002"],
      blockers: [],
    },
    join_qa: {
      status: "passed",
      blockers: [],
      warnings: [],
    },
    blockers: [],
    warnings: [],
  };
  const baseSegments = [
    {
      unit_id: "unit_001",
      text: firstText,
      tts_provider: "kokoro_local",
      voice_id: policy.primary.voice_id,
      voice_continuity_contract: "native_puck_preset",
      voice_continuity: null,
      raw_audio_path: audioPath,
      raw_audio_sha256: audioHash,
      unit_qa: passingUnitQa,
    },
    {
      unit_id: "unit_002",
      text: fallbackText,
      tts_provider: "qwen_local",
      voice_id: policy.primary.voice_id,
      voice_continuity_contract: policy.fallback.voice_continuity_contract,
      voice_continuity: passingFallbackContinuity,
      raw_audio_path: audioPath,
      raw_audio_sha256: audioHash,
      unit_qa: passingFallbackUnitQa,
    },
  ];
  const baseStitchReport = {
    schema: "goldflow_narration_stitch_report_v1",
    status: "passed",
    source_script_hash: scriptHash,
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: planSha256,
    primary_provider: "kokoro_local",
    native_speed: 1.2,
    stitch_qa_status: "passed",
    full_stream_qa_status: "passed",
    output_path: audioPath,
    output_sha256: audioHash,
    final_m4a_path: m4aPath,
    final_m4a_sha256: audioHash,
    final_duration_sec: 1.8,
    full_stream_qa_path: fullQaPath,
    segments: baseSegments,
  };
  const restorePassingArtifacts = async () => {
    await writeJson(continuityReportPath, {
      schema: "goldflow_tts_voice_continuity_qa_v1",
      status: "passed",
    });
    await writeJson(planPath, basePlan);
    await writeJson(ttsReportPath, baseTtsReport);
    await writeJson(unitQaPath, baseUnitQa);
    await writeJson(fullQaPath, baseFullQa);
    await writeJson(stitchReportPath, baseStitchReport);
  };
  await restorePassingArtifacts();

  const statusFor = async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/run-status.mjs",
      "--episode-dir", episodeDir,
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
    return JSON.parse(stdout);
  };
  const repairedStatus = await statusFor();
  let stage = repairedStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(stage.exists, true, stage.evidence);
  assert.match(stage.evidence, /fallback_units=1/);
  assert.equal(repairedStatus.current_stage, "local_whisper_word_timing");
  assert.match(repairedStatus.next_command_shape, /audio whisper-timing/);
  assert.match(repairedStatus.next_command_shape, /--model small\.en/);
  assert.match(repairedStatus.next_command_shape, /--omp-num-threads 12/);
  assert.match(repairedStatus.next_command_shape, /--cpu-threads 0/);
  assert.doesNotMatch(repairedStatus.next_command_shape, /--model medium/);

  await writeJson(ttsReportPath, {
    ...baseTtsReport,
    results: baseResults.map((row) => (
      row.unit_id === "unit_002"
        ? {
            ...row,
            voice_continuity: {
              ...row.voice_continuity,
              cosine_similarity: 0.863,
            },
          }
        : row
    )),
  });
  const wrongVoiceStatus = await statusFor();
  stage = wrongVoiceStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /lacks passing Puck voice-continuity evidence/);
  await restorePassingArtifacts();

  await writeJson(ttsReportPath, {
    ...baseTtsReport,
    results: baseResults.map((row) => (
      row.unit_id === "unit_002"
        ? { ...row, voice_id: "am_fenrir" }
        : row
    )),
  });
  const alternateVoiceIdentityStatus = await statusFor();
  stage = alternateVoiceIdentityStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /is not declared as the selected Puck voice/);
  await restorePassingArtifacts();

  await writeJson(continuityReportPath, {
    schema: "goldflow_tts_voice_continuity_qa_v1",
    status: "tampered",
  });
  const staleContinuityReportStatus = await statusFor();
  stage = staleContinuityReportStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /voice-continuity report hash is stale/);
  await restorePassingArtifacts();

  await writeJson(planPath, {
    ...basePlan,
    diagnostic_metadata: "changed after synthesis",
  });
  const stalePlanStatus = await statusFor();
  stage = stalePlanStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /narration plan hash is missing or stale/);
  await restorePassingArtifacts();

  await writeJson(unitQaPath, {
    ...baseUnitQa,
    status: "blocked",
  });
  const tamperedUnitQaStatus = await statusFor();
  stage = tamperedUnitQaStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /narration_tts_unit_qa_ep_01\.json.*status=blocked/);
  await restorePassingArtifacts();

  await writeJson(fullQaPath, {
    ...baseFullQa,
    audio_sha256: sha256("tampered-full-stream-audio"),
  });
  const tamperedFullQaStatus = await statusFor();
  stage = tamperedFullQaStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /full-stream QA audio hash differs from stitched narration/);
  await restorePassingArtifacts();

  await writeJson(ttsReportPath, {
    ...baseTtsReport,
    results: [...baseResults].reverse(),
  });
  const swappedResultsStatus = await statusFor();
  stage = swappedResultsStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /TTS result unit IDs are missing, reordered, duplicated, or unexpected/);
  await restorePassingArtifacts();

  await writeJson(ttsReportPath, {
    ...baseTtsReport,
    results: baseResults.map((row) => (
      row.unit_id === "unit_002"
        ? { ...row, spoken_text_sha256: sha256("Wrong selected text.") }
        : row
    )),
  });
  const wrongResultTextHashStatus = await statusFor();
  stage = wrongResultTextHashStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /unit unit_002 TTS spoken text hash is stale/);
  await restorePassingArtifacts();

  await writeJson(stitchReportPath, {
    ...baseStitchReport,
    segments: [...baseSegments].reverse(),
  });
  const reorderedStitchStatus = await statusFor();
  stage = reorderedStitchStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /stitch segment unit IDs are missing, reordered, duplicated, or unexpected/);
  await restorePassingArtifacts();

  await writeJson(ttsReportPath, {
    ...baseTtsReport,
    results: baseTtsReport.results.map((row) => (
      row.unit_id === "unit_002"
        ? { ...row, fallback_spoken_text_sha256: sha256("A changed fallback sentence.") }
        : row
    )),
  });
  const mismatchedFallbackStatus = await statusFor();
  stage = mismatchedFallbackStatus.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /does not preserve the exact planned spoken text hash/);
}

async function testTimingBindMatchesPossessiveAnchorsAfterCursor() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = [
    "Earlier, he thought of his mother's piano and kept walking.",
    "",
    "But emotional payoff still waited in one place.",
    "",
    "His mother's piano.",
    "",
    "Joey almost laughed.",
    "",
    "He bought the lounge contract.",
  ].join("\n");
  const scriptHash = sha256(scriptText);
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    scenes: [
      {
        scene_id: "scene_001",
        title: "Earlier Memory",
        script_excerpt_start: "Earlier, he thought of his mother's piano and kept walking.",
        script_excerpt_end: "But emotional payoff still waited in one place.",
      },
      {
        scene_id: "scene_002",
        title: "Later Possessive Anchor",
        script_excerpt_start: "His mother's piano.",
        script_excerpt_end: "Joey almost laughed.",
      },
      {
        scene_id: "scene_003",
        title: "Next Scene",
        script_excerpt_start: "He bought the lounge contract.",
        script_excerpt_end: "He bought the lounge contract.",
      },
    ],
  });
  const narrationPath = path.join(episodeDir, "narration.m4a");
  await fs.writeFile(narrationPath, "fixture audio bytes");
  const narrationHash = sha256(await fs.readFile(narrationPath));
  const word = (text, start, end) => ({ word: text, start_sec: start, end_sec: end });
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    narration_audio_hash: narrationHash,
    audio_duration_sec: 16,
    words: [
      word("Earlier", 0, 0.2), word("he", 0.2, 0.4), word("thought", 0.4, 0.6), word("of", 0.6, 0.8),
      word("his", 0.8, 1), word("mother's", 1, 1.2), word("piano", 1.2, 1.4), word("and", 1.4, 1.6),
      word("kept", 1.6, 1.8), word("walking", 1.8, 2),
      word("But", 4, 4.2), word("emotional", 4.2, 4.4), word("payoff", 4.4, 4.6),
      word("still", 4.6, 4.8), word("waited", 4.8, 5), word("in", 5, 5.2),
      word("one", 5.2, 5.4), word("place", 5.4, 5.6),
      word("His", 12, 12.2), word("mother's", 12.2, 12.4), word("piano", 12.4, 12.6),
      word("Joey", 14, 14.2), word("almost", 14.2, 14.4), word("laughed", 14.4, 14.6),
      word("He", 15, 15.2), word("bought", 15.2, 15.4), word("the", 15.4, 15.6),
      word("lounge", 15.6, 15.8), word("contract", 15.8, 16),
    ],
  });
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), {
    status: "passed",
    output_path: narrationPath,
  });
  await execFileAsync(process.execPath, [
    "scripts/timing-bind.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--max-scene-duration-sec", "2",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const timed = JSON.parse(await fs.readFile(path.join(episodeDir, "timed_scene_plan.json"), "utf8"));
  const scene = timed.scenes.find((item) => item.scene_id === "scene_002");
  assert.equal(scene.start_resolution, "whisper_phrase_match");
  assert.equal(scene.matched_start_words, "His mother's piano");
  assert.equal(scene.start_sec, 12);
  assert.equal(scene.duration_sec > 2, true);
  assert.equal(timed.status, "passed");
  assert.equal(timed.timing_advisories.some((row) => row.scene_id === "scene_002" && row.code === "scene_duration_above_editorial_goal"), true);
}

async function testRunStatusBlocksStaleVisualBeatSourceHashes() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture narration for stale visual beats.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { status: "passed", source_script_hash: scriptHash });
  const semanticPath = path.join(episodeDir, "semantic_scene_plan.json");
  const semanticArtifact = { status: "passed", source_script_hash: scriptHash };
  await writeJson(semanticPath, semanticArtifact);
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "modelslab_qwen_tts_report_ep_01.json"), { status: "passed" });
  const narrationPath = path.join(episodeDir, "narration.wav");
  await fs.writeFile(narrationPath, "fixture audio bytes");
  const narrationHash = sha256(await fs.readFile(narrationPath));
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), { status: "passed", output_path: narrationPath });
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash });
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220, actual_wpm: 214.286 });
  const mixPath = path.join(episodeDir, "longform_mix.m4a");
  await fs.writeFile(mixPath, "fixture mix bytes");
  await writeJson(path.join(episodeDir, "longform_audio_bed_report_ep_01.json"), { status: "completed", mix: { m4a_path: mixPath } });
  const timedPath = path.join(episodeDir, "timed_scene_plan.json");
  await writeJson(timedPath, {
    status: "passed",
    source_script_hash: scriptHash,
    source_hashes: { [semanticPath]: sha256(await fs.readFile(semanticPath)) },
    scenes: [],
  });
  const scriptPath = path.join(episodeDir, "script_clean.md");
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    source_hashes: {
      [timedPath]: sha256(await fs.readFile(timedPath)),
      [scriptPath]: sha256(await fs.readFile(scriptPath)),
    },
    beats: [],
  });
  let statusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  let status = JSON.parse(statusResult.stdout);
  let visualBeatStage = status.stage_ledger.find((row) => row.stage === "visual_beat_plan");
  assert.equal(status.current_stage, "visual_beat_plan");
  assert.equal(visualBeatStage.exists, false);
  assert.match(visualBeatStage.evidence, /stale planner_contract_version=missing/);

  await writeJson(semanticPath, { ...semanticArtifact, scenes: [{ scene_id: "scene_changed" }] });
  statusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  status = JSON.parse(statusResult.stdout);
  const timingStage = status.stage_ledger.find((row) => row.stage === "timing_bind");
  assert.equal(status.current_stage, "timing_bind");
  assert.equal(timingStage.state, "stale");
  assert.match(timingStage.evidence, /semantic_scene_plan\.json stale/);
  await writeJson(semanticPath, semanticArtifact);

  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: scriptHash,
    source_hashes: {
      [timedPath]: sha256(await fs.readFile(timedPath)),
      [scriptPath]: sha256(await fs.readFile(scriptPath)),
    },
    beats: [],
  });
  await writeJson(timedPath, { status: "passed", source_script_hash: scriptHash, scenes: [{ scene_id: "scene_001" }] });
  statusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  status = JSON.parse(statusResult.stdout);
  visualBeatStage = status.stage_ledger.find((row) => row.stage === "visual_beat_plan");
  assert.equal(status.current_stage, "visual_beat_plan");
  assert.equal(visualBeatStage.exists, false);
  assert.match(visualBeatStage.evidence, /timed_scene_plan\.json stale/);
}

async function testRunStatusBlocksStaleVisualReferenceSourceHashes() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture narration for stale visual references.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { status: "passed", source_script_hash: scriptHash });
  const semanticPath = path.join(episodeDir, "semantic_scene_plan.json");
  await writeJson(semanticPath, { status: "passed", source_script_hash: scriptHash, scenes: [{ scene_id: "scene_001", location: "hall" }] });
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "modelslab_qwen_tts_report_ep_01.json"), { status: "passed" });
  const narrationPath = path.join(episodeDir, "narration.wav");
  await fs.writeFile(narrationPath, "fixture audio bytes");
  const narrationHash = sha256(await fs.readFile(narrationPath));
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), { status: "passed", output_path: narrationPath });
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash });
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220, actual_wpm: 214.286 });
  const timedPath = path.join(episodeDir, "timed_scene_plan.json");
  await writeJson(timedPath, { status: "passed", source_script_hash: scriptHash, scenes: [{ scene_id: "scene_001" }] });
  const mixPath = path.join(episodeDir, "longform_mix.m4a");
  await fs.writeFile(mixPath, "fixture mix bytes");
  await writeJson(path.join(episodeDir, "longform_audio_bed_report_ep_01.json"), { status: "completed", mix: { m4a_path: mixPath } });
  const scriptPath = path.join(episodeDir, "script_clean.md");
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: scriptHash,
    source_hashes: {
      [timedPath]: sha256(await fs.readFile(timedPath)),
      [scriptPath]: sha256(await fs.readFile(scriptPath)),
    },
    beats: [{ visual_beat_id: "scene_001_beat_01", scene_id: "scene_001", ref_needs: [] }],
  });
  const visualRefPath = path.join(episodeDir, "visual_reference_plan.json");
  const referenceInventoryPath = await writeFixtureReferenceInventory(episodeDir, scriptHash, [
    { asset_id: "style_ref", ref_id: "style_ref", kind: "style", subject: "fixture style", scene_ids: [], beat_ids: [] },
  ]);
  await writeJson(visualRefPath, {
    status: "passed",
    source_script_hash: scriptHash,
    reference_inventory_ledger_path: referenceInventoryPath,
    source_hashes: {
      [semanticPath]: sha256(await fs.readFile(semanticPath)),
    },
    reference_targets: [{ ref_id: "style_ref", kind: "style", generation_mode: "standalone_ref", required_before_imagegen: true }],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), {
    status: "draft_needs_manual_review",
    source_script_hash: scriptHash,
    source_visual_reference_plan_path: visualRefPath,
    source_hashes: {
      [visualRefPath]: sha256(await fs.readFile(visualRefPath)),
    },
    character_state_refs: [],
  });
  await writeJson(semanticPath, { status: "passed", source_script_hash: scriptHash, scenes: [{ scene_id: "scene_001", location: "changed hall" }] });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const refStage = status.stage_ledger.find((row) => row.stage === "visual_reference_plan");
  assert.equal(status.current_stage, "visual_reference_plan");
  assert.equal(refStage.exists, false);
  assert.match(refStage.evidence, /semantic_scene_plan\.json stale/);
}

async function testRunStatusSurfacesDraftReferenceApprovalCommand() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture narration for draft visual reference approval.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { status: "passed", source_script_hash: scriptHash });
  const semanticPath = path.join(episodeDir, "semantic_scene_plan.json");
  await writeJson(semanticPath, { status: "passed", source_script_hash: scriptHash, scenes: [{ scene_id: "scene_001", location: "hall" }] });
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "modelslab_qwen_tts_report_ep_01.json"), { status: "passed" });
  const narrationPath = path.join(episodeDir, "narration.wav");
  await fs.writeFile(narrationPath, "fixture audio bytes");
  const narrationHash = sha256(await fs.readFile(narrationPath));
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), { status: "passed", output_path: narrationPath });
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash });
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220, actual_wpm: 214.286 });
  const timedPath = path.join(episodeDir, "timed_scene_plan.json");
  await writeJson(timedPath, { status: "passed", source_script_hash: scriptHash, scenes: [{ scene_id: "scene_001" }] });
  const mixPath = path.join(episodeDir, "longform_mix.m4a");
  await fs.writeFile(mixPath, "fixture mix bytes");
  await writeJson(path.join(episodeDir, "longform_audio_bed_report_ep_01.json"), { status: "completed", mix: { m4a_path: mixPath } });
  const scriptPath = path.join(episodeDir, "script_clean.md");
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: scriptHash,
    source_hashes: {
      [timedPath]: sha256(await fs.readFile(timedPath)),
      [scriptPath]: sha256(await fs.readFile(scriptPath)),
    },
    beats: [{ visual_beat_id: "scene_001_beat_01", scene_id: "scene_001", ref_needs: [] }],
  });
  const visualRefPath = path.join(episodeDir, "visual_reference_plan.json");
  const referenceInventoryPath = await writeFixtureReferenceInventory(episodeDir, scriptHash, [
    { asset_id: "style_ref", ref_id: "style_ref", kind: "style", subject: "fixture style", scene_ids: [], beat_ids: [] },
  ]);
  await writeJson(visualRefPath, {
    status: "passed",
    source_script_hash: scriptHash,
    reference_inventory_ledger_path: referenceInventoryPath,
    source_hashes: {
      [semanticPath]: sha256(await fs.readFile(semanticPath)),
    },
    reference_targets: [
      { ref_id: "style_ref", kind: "style", generation_mode: "no_ref_needed", required_before_imagegen: false },
      { ref_id: "optional_action_review", kind: "action", generation_mode: "manual_review", required_before_imagegen: false },
    ],
    character_state_refs: [],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), {
    status: "draft_needs_manual_review",
    source_script_hash: scriptHash,
    source_visual_reference_plan_path: visualRefPath,
    source_hashes: {
      [visualRefPath]: sha256(await fs.readFile(visualRefPath)),
    },
    character_state_refs: [],
  });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const refStage = status.stage_ledger.find((row) => row.stage === "visual_reference_plan");
  const referenceGenerationStage = status.stage_ledger.find((row) => row.stage === "reference_generation");
  const referenceApprovalStage = status.stage_ledger.find((row) => row.stage === "reference_image_approval");
  assert.equal(status.current_stage, "reference_image_approval");
  assert.equal(refStage.exists, true);
  assert.equal(referenceGenerationStage.exists, true);
  assert.equal(referenceApprovalStage.exists, false);
  assert.match(referenceApprovalStage.evidence, /generated reference approval missing/);
  assert.match(status.next_command_shape, /visual approve-refs/);
  assert.match(referenceApprovalStage.next_command_shape, /visual approve-refs/);
}

async function testRunStatusBlocksQwenPlanMissingOverrideAudit() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "The clip became live content.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    replacements: [{ from: "live content", to: "livestream video content", scope: "qwen_spoken_text" }],
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    segments: [{ segment_id: "seg_001", qwen_generation_units: [{ qwen_spoken_text: "The clip became live content." }] }],
  });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const voiceStage = status.stage_ledger.find((row) => row.stage === "voice_plan");
  assert.equal(status.current_stage, "voice_plan");
  assert.equal(voiceStage.exists, false);
  assert.match(voiceStage.evidence, /missing tts_override_application_audit/);
}

async function testRunStatusIgnoresProofImageReportWithoutCurrentHardenedPlan() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await fs.mkdir(episodeDir, { recursive: true });
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    audio_target: "narrator_only",
    image_provider: "modelslab",
  });
  await writeJson(path.join(episodeDir, "imagegen_report_first5_current_modelslab.json"), {
    schema: "goldflow_imagegen_report_v1",
    status: "passed",
    reference_only: false,
    missing_image_count: 0,
    image_count: 5,
    prompt_plan_hash: "old-proof-hash",
    results: [],
  });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const imageStage = status.stage_ledger.find((row) => row.stage === "image_generation");
  assert.equal(imageStage.exists, false);
  assert.match(imageStage.evidence, /section_image_prompts_hardened\.json missing or empty/);
}

async function testRunStatusRoutesOnlyCreditFailuresToCodexFallback() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-credit-fallback-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await fs.mkdir(episodeDir, { recursive: true });
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    schema: "goldflow_run_identity_v2",
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    audio_target: "narrator_only",
    image_provider: "modelslab",
    image_provider_options: {
      fallback: {
        provider: "codex_imagegen",
        condition: "modelslab_credit_exhausted",
        operator_approved: true,
      },
    },
    model_versions: {
      image_model: "gpt-image-2-t2i",
      reference_model: "gpt-image-2-i2i",
    },
  });
  const promptPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  await writeJson(promptPath, {
    status: "passed",
    prompts: [{ image_id: "cut_credit", image_generation_required: true }],
  });
  const promptHash = sha256(await fs.readFile(promptPath));
  const reportPath = path.join(episodeDir, "imagegen_report_ep_01.json");
  await writeJson(reportPath, {
    status: "failed",
    prompt_plan_hash: promptHash,
    image_count: 0,
    results: [{ image_id: "cut_credit", status: "failed", error: "Insufficient credits. Recharge wallet." }],
  });
  let result = await execFileAsync(process.execPath, ["scripts/run-status.mjs", "--episode-dir", episodeDir], {
    cwd: process.cwd(),
    env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot },
  });
  let status = JSON.parse(result.stdout);
  let imageStage = status.stage_ledger.find((row) => row.stage === "image_generation");
  assert.match(imageStage.evidence, /modelslab_credit_exhausted=1/);
  assert.match(imageStage.next_command_shape, /imagegen codex-work/);
  assert.match(imageStage.next_command_shape, /--image-ids cut_credit/);

  await writeJson(reportPath, {
    status: "failed",
    prompt_plan_hash: promptHash,
    image_count: 0,
    results: [{ image_id: "cut_credit", status: "failed", error: "Cloudflare 524 timeout" }],
  });
  result = await execFileAsync(process.execPath, ["scripts/run-status.mjs", "--episode-dir", episodeDir], {
    cwd: process.cwd(),
    env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot },
  });
  status = JSON.parse(result.stdout);
  imageStage = status.stage_ledger.find((row) => row.stage === "image_generation");
  assert.doesNotMatch(imageStage.next_command_shape, /codex-work/);
  assert.match(imageStage.next_command_shape, /--image-model gpt-image-2-t2i/);
  assert.match(imageStage.next_command_shape, /--cut-ids cut_credit/);
}

async function testRunStatusRecoversFailedAndCircuitSkippedSpanCuts() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-image-recovery-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const imageDir = path.join(episodeDir, "assets", "images");
  await fs.mkdir(imageDir, { recursive: true });
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    schema: "goldflow_run_identity_v2",
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    audio_target: "narrator_only",
    image_provider: "modelslab",
    model_versions: {
      image_model: "flux-klein",
      reference_model: "flux-klein",
    },
  });

  const prompts = Array.from({ length: 501 }, (_value, index) => {
    const start = index * 20;
    return {
      image_id: `ep_01-w${String(start).padStart(6, "0")}-w${String(start + 19).padStart(6, "0")}`,
      image_generation_required: true,
    };
  });
  const promptPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  await writeJson(promptPath, { status: "passed", prompts });
  const generatedPrompts = prompts.slice(0, 350);
  const failedPrompts = prompts.slice(350, 364);
  const skippedPrompts = prompts.slice(364);
  for (const prompt of generatedPrompts) {
    await fs.writeFile(
      path.join(imageDir, `${prompt.image_id}-modelslab-image.png`),
      Buffer.from(`fixture image ${prompt.image_id}`),
    );
  }
  // The latest scoped report may omit successful rows from an earlier batch;
  // exact on-disk cut files remain valid completion evidence.
  const generatedResults = generatedPrompts.slice(0, 340).map((prompt) => ({
    image_id: prompt.image_id,
    status: "generated",
    image_path: path.join(imageDir, `${prompt.image_id}-modelslab-image.png`),
  }));
  await writeJson(path.join(episodeDir, "imagegen_report_ep_01.json"), {
    schema: "goldflow_imagegen_report_v1",
    status: "failed",
    prompt_plan_hash: sha256(await fs.readFile(promptPath)),
    image_count: 501,
    expected_image_count: 501,
    missing_image_count: 151,
    results: [
      ...generatedResults,
      ...failedPrompts.map((prompt) => ({
        image_id: prompt.image_id,
        status: "failed",
        error: "fixture provider rate limit",
      })),
      ...skippedPrompts.map((prompt) => ({
        image_id: prompt.image_id,
        status: "skipped_provider_circuit_open",
        error: "fixture provider circuit open",
      })),
    ],
  });

  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const imageStage = status.stage_ledger.find((row) => row.stage === "image_generation");
  assert.match(imageStage.evidence, /image files=350\/501/);
  assert.match(imageStage.evidence, /failed=14/);
  assert.match(imageStage.evidence, /skipped_provider_circuit_open=137/);
  const cutIdsMatch = imageStage.next_command_shape.match(/--cut-ids ([^ ]+)/);
  assert.ok(cutIdsMatch, "image recovery command must contain an explicit cut scope");
  const recoveryIds = cutIdsMatch[1].split(",");
  const expectedRecoveryIds = [...failedPrompts, ...skippedPrompts].map((prompt) => prompt.image_id);
  assert.deepEqual(recoveryIds, expectedRecoveryIds);
  assert.equal(recoveryIds.some((imageId) => generatedPrompts.some((prompt) => prompt.image_id === imageId)), false);
}

async function testRunStatusIncludesManualBlockerTriagePolicy() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await fs.mkdir(episodeDir, { recursive: true });
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    audio_target: "narrator_only",
    image_provider: "modelslab",
  });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  assert.equal(status.manual_blocker_triage_policy.mode, "agent_review_first");
  assert.match(status.manual_blocker_triage_policy.summary, /narrowest valid recovery/);
  assert.match(status.manual_blocker_triage_policy.artifact_pattern, /manual_blocker_triage/);

  const { stdout: markdown } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
    "--format", "markdown",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  assert.match(markdown, /Manual blocker triage:/);
  assert.match(markdown, /narrowest valid recovery/);
}

function testDerivedReferenceCandidateSelectionAndManifestAttach() {
  const promptPlan = {
    prompt_policy: "deterministic hardening",
    prompts: [
      {
        image_id: "ep_01-cut-000",
        scene_id: "scene_001",
        start_sec: 10,
        visual_job: "location_transition",
        suggested_shot_job: "environment_establishing",
        image_prompt: "empty anime manhwa audit hall environment establishing frame with no characters",
        modelslab_image_prompt: "empty anime manhwa audit hall environment establishing frame with no characters",
        shot_manifest: {
          shot_job: "environment_establishing",
          location_ref_id: "loc_audit_hall",
        },
        reference_requirements: [],
      },
      {
        image_id: "ep_01-cut-001",
        scene_id: "scene_001",
        start_sec: 12,
        visual_job: "humiliation_image",
        suggested_shot_job: "character_interaction",
        image_prompt: "Joey and Selena arguing inside the audit hall",
        modelslab_image_prompt: "Joey and Selena arguing inside the audit hall",
        shot_manifest: {
          location_ref_id: "loc_audit_hall",
          protagonist_state_ref_id: "joey_floor_state",
          character_state_ref_ids: ["selena_phone_state"],
          visible_characters: ["Joey Manhwa", "Selena"],
          visible_props: ["phone"],
        },
        reference_requirements: [],
      },
      {
        image_id: "ep_01-cut-002",
        scene_id: "scene_002",
        start_sec: 18,
        shot_manifest: { location_ref_id: "loc_dorm" },
        reference_requirements: [],
      },
    ],
  };
  const target = { ref_id: "loc_audit_hall", kind: "location", generation_mode: "derive_from_first_clean_cut", scene_ids: ["scene_001"] };
  assert.deepEqual(candidateImageIdsForDerivedTargetForTests(target, promptPlan), ["ep_01-cut-000"]);
  assert.deepEqual(
    candidateImageIdsForDerivedTargetForTests(target, { ...promptPlan, prompts: promptPlan.prompts.filter((prompt) => prompt.image_id !== "ep_01-cut-000") }),
    [],
    "derived location refs must not promote contaminated character/prop cuts as location anchors"
  );

  const attached = attachReferencePathsToPromptsForTests(
    promptPlan,
    new Map([
      ["loc_audit_hall", "/tmp/loc_audit_hall.png"],
      ["joey_base_ref", "/tmp/joey.png"],
      ["selena_base_ref", "/tmp/selena.png"],
    ]),
    [
      { state_ref_id: "joey_floor_state", source_ref_id: "joey_base_ref", character: "Joey Manhwa" },
      { state_ref_id: "selena_phone_state", source_ref_id: "selena_base_ref", character: "Selena" },
    ],
    [target]
  );
  const firstPrompt = attached.prompts.find((prompt) => prompt.image_id === "ep_01-cut-001");
  assert.deepEqual(new Set(firstPrompt.required_reference_paths), new Set(["/tmp/loc_audit_hall.png", "/tmp/joey.png", "/tmp/selena.png"]));
  assert.equal(firstPrompt.reference_requirements.every((requirement) => requirement.inferred_from_shot_manifest === true), true);
  assert.deepEqual(new Set(firstPrompt.reference_requirements.map((requirement) => requirement.ref_id)), new Set(["loc_audit_hall", "joey_base_ref", "selena_base_ref"]));
}

async function testDerivedReferencePromotionFromSeedCut() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const imageDir = path.join(episodeDir, "assets", "images");
  const imagePath = path.join(imageDir, "ep_01-cut-001-modelslab-image.png");
  await fs.mkdir(imageDir, { recursive: true });
  await fs.writeFile(imagePath, Buffer.from("fixture image bytes"));
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    image_provider: "modelslab",
  });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    reference_targets: [
      {
        ref_id: "loc_audit_hall",
        kind: "location",
        generation_mode: "derive_from_first_clean_cut",
        scene_ids: ["scene_001"],
      },
    ],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), {
    status: "approved",
    character_state_refs: [],
  });
  const promptPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  await writeJson(promptPath, {
    status: "passed",
    prompt_policy: "deterministic hardening",
    prompts: [
      {
        image_id: "ep_01-cut-001",
        scene_id: "scene_001",
        start_sec: 3,
        image_prompt: "anime manhwa audit hall",
        modelslab_image_prompt: "anime manhwa audit hall",
        shot_manifest: { location_ref_id: "loc_audit_hall" },
        reference_requirements: [],
      },
    ],
  });
  await writeJson(path.join(episodeDir, "imagegen_report_ep_01.json"), {
    schema: "goldflow_imagegen_report_v1",
    status: "passed",
    prompt_plan_hash: sha256(await fs.readFile(promptPath)),
    image_count: 1,
    expected_image_count: 1,
    missing_image_count: 0,
    results: [
      { image_id: "ep_01-cut-001", status: "generated", image_path: imagePath },
    ],
  });

  await execFileAsync(process.execPath, [
    "scripts/imagegen.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--prompts", promptPath,
    "--promote-derived-refs", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });

  const referencePlan = await readJson(path.join(episodeDir, "visual_reference_plan.json"));
  const updatedTarget = referencePlan.reference_targets[0];
  assert.equal(updatedTarget.derived_reference_status, "promoted");
  assert.equal(updatedTarget.derived_from_image_id, "ep_01-cut-001");
  assert.equal(await fs.stat(updatedTarget.reference_image_path).then((stat) => stat.isFile()), true);
  const promotionReport = await readJson(path.join(episodeDir, "derived_reference_promotion_report_ep_01.json"));
  assert.equal(promotionReport.promoted_count, 1);
  assert.equal(promotionReport.unresolved_count, 0);
}

async function testImagegenReusesImportedCodexOpeningCut() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const imageDir = path.join(episodeDir, "assets", "images");
  const promptPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    image_provider: "hybrid_modelslab_refs_codex_opening_modelslab_rest",
    image_provider_options: { codex_opening_sec: 300 },
    audio_target: "narrator_only",
    run_intent: "production",
  });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    reference_targets: [],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), {
    status: "approved",
    character_state_refs: [],
  });
  await writeJson(promptPath, {
    status: "passed",
    prompt_policy: "deterministic hardening fixture",
    prompts: [
      {
        image_id: "ep_01-cut-001",
        scene_id: "scene_001",
        start_sec: 0,
        image_prompt: "Joey stands under a blue system window.",
        codex_image_prompt: "anime manhwa frame of Joey under a blue system window",
        image_generation_required: true,
      },
    ],
  });
  const imagePath = path.join(imageDir, "ep_01-cut-001-codex-imagegen-image.png");
  await fs.mkdir(imageDir, { recursive: true });
  await fs.writeFile(imagePath, Buffer.from("fixture imported codex image"));
  await writeJson(`${imagePath}.metadata.json`, {
    image_id: "ep_01-cut-001",
    image_provider: "codex_imagegen_manual_import",
    source_prompt_path: promptPath,
    generated: {
      output_sha256: sha256("fixture imported codex image"),
      manual_source_sha256: sha256("fixture imported codex image"),
    },
  });

  const result = await execFileAsync(process.execPath, [
    "scripts/imagegen.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--image-provider", "hybrid_modelslab_refs_codex_opening_modelslab_rest",
    "--codex-opening-sec", "300",
    "--prompts", promptPath,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const stdout = JSON.parse(result.stdout);
  assert.equal(stdout.status, "passed");
  const report = await readJson(path.join(episodeDir, "imagegen_report_ep_01.json"));
  assert.equal(report.status, "passed");
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].status, "reused_imported_codex");
  assert.equal(report.results[0].image_path, imagePath);
}

async function testRunStatusDerivedReferenceSeedPromoteAndScopedRetry() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const promptPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  await fs.mkdir(path.join(episodeDir, "assets", "images"), { recursive: true });
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    audio_target: "narrator_only",
    image_provider: "modelslab",
  });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    reference_targets: [
      { ref_id: "loc_audit_hall", kind: "location", generation_mode: "derive_from_first_clean_cut", scene_ids: ["scene_001"] },
    ],
  });
  await writeJson(promptPath, {
    status: "passed",
    prompt_policy: "deterministic hardening",
    prompts: [
      { image_id: "ep_01-cut-001", scene_id: "scene_001", start_sec: 1, image_prompt: "anime manhwa audit hall", shot_manifest: { location_ref_id: "loc_audit_hall" }, reference_requirements: [] },
      { image_id: "ep_01-cut-002", scene_id: "scene_002", start_sec: 7, image_prompt: "anime manhwa dorm room", shot_manifest: { location_ref_id: "loc_dorm" }, reference_requirements: [] },
    ],
  });
  const promptPlanHash = sha256(await fs.readFile(promptPath));
  let statusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  let status = JSON.parse(statusResult.stdout);
  let referenceStage = status.stage_ledger.find((row) => row.stage === "reference_generation");
  let imageStage = status.stage_ledger.find((row) => row.stage === "image_generation");
  assert.equal(referenceStage.exists, true);
  assert.match(referenceStage.evidence, /no standalone reference images required/);
  assert.match(imageStage.next_command_shape, /--skip-reference-generation true/);
  assert.match(imageStage.next_command_shape, /--seed-derived-refs true/);
  assert.match(imageStage.next_command_shape, /--cut-ids ep_01-cut-001/);

  const generatedPath = path.join(episodeDir, "assets", "images", "ep_01-cut-001-modelslab-image.png");
  await fs.writeFile(generatedPath, Buffer.from("seed cut bytes"));
  await writeJson(path.join(episodeDir, "imagegen_report_ep_01.json"), {
    schema: "goldflow_imagegen_report_v1",
    status: "passed",
    prompt_plan_hash: promptPlanHash,
    image_count: 1,
    expected_image_count: 2,
    missing_image_count: 1,
    results: [
      { image_id: "ep_01-cut-001", status: "generated", image_path: generatedPath },
    ],
  });
  statusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  status = JSON.parse(statusResult.stdout);
  imageStage = status.stage_ledger.find((row) => row.stage === "image_generation");
  assert.match(imageStage.next_command_shape, /imagegen promote-derived-refs/);

  const promotedReferencePath = path.join(episodeDir, "assets", "images", "references", "loc_audit_hall-derived-reference.png");
  await fs.mkdir(path.dirname(promotedReferencePath), { recursive: true });
  await fs.writeFile(promotedReferencePath, Buffer.from("promoted ref bytes"));
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    reference_targets: [
      {
        ref_id: "loc_audit_hall",
        kind: "location",
        generation_mode: "derive_from_first_clean_cut",
        scene_ids: ["scene_001"],
        reference_image_path: promotedReferencePath,
      },
    ],
  });
  await writeJson(path.join(episodeDir, "imagegen_report_ep_01.json"), {
    schema: "goldflow_imagegen_report_v1",
    status: "failed",
    prompt_plan_hash: promptPlanHash,
    image_count: 1,
    expected_image_count: 2,
    missing_image_count: 1,
    results: [
      { image_id: "ep_01-cut-001", status: "generated", image_path: generatedPath },
      { image_id: "ep_01-cut-002", status: "failed", error: "fixture failure" },
    ],
  });
  statusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  status = JSON.parse(statusResult.stdout);
  imageStage = status.stage_ledger.find((row) => row.stage === "image_generation");
  assert.match(imageStage.next_command_shape, /--skip-reference-generation true/);
  assert.match(imageStage.next_command_shape, /--cut-ids ep_01-cut-002/);
  assert.doesNotMatch(imageStage.next_command_shape, /visual plan/);
}

async function testSilentTransitionsWithoutSfxBank() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const promptPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  await writeJson(promptPath, {
    status: "passed",
    prompts: [
      { image_id: "ep_01-cut-001", scene_id: "scene_001", start_sec: 0, visual_beat_action: "cold open begins" },
      { image_id: "ep_01-cut-002", scene_id: "scene_001", start_sec: 2, visual_beat_action: "system reveal lands" },
    ],
  });
  const output = path.join(episodeDir, "transition_edit_plan_ep_01.json");
  await execFileAsync(process.execPath, [
    "scripts/visual-transition-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--prompts", promptPath,
    "--output", output,
    "--transition-sfx", "false",
    "--dry-run", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.transition_sfx_enabled, false);
  assert.equal(report.sfx_manifest_path, null);
  assert.equal(report.transition_events.every((event) => event.transition_sfx === false), true);
}

async function testTransitionRevalidationUsesAllAdjacentCuts() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const promptPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  const prompts = Array.from({ length: 225 }, (_value, index) => ({
    image_id: `ep_01-cut-${String(index + 1).padStart(3, "0")}`,
    scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
    start_sec: index * 2,
    visual_beat_action: "scene change",
  }));
  await writeJson(promptPath, { status: "passed", prompts });
  const output = path.join(episodeDir, "transition_edit_plan_ep_01.json");
  const existingPlan = path.join(episodeDir, "archived_transition_edit_plan_ep_01.json");
  await writeJson(existingPlan, {
    status: "passed",
    transition_events: [{
      boundary_id: "boundary_legacy_224",
      from_image_id: "ep_01-cut-224",
      to_image_id: "ep_01-cut-225",
      start_sec: 999,
      transition_sfx: false,
      sfx_family: "none",
    }],
  });
  await execFileAsync(process.execPath, [
    "scripts/visual-transition-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--prompts", promptPath,
    "--output", output,
    "--existing-plan", existingPlan,
    "--transition-sfx", "false",
    "--revalidate-existing", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.transition_events[0].boundary_id, "boundary_legacy_224");
  assert.equal(report.transition_events[0].start_sec, 448);
  assert.equal(report.planner.timing_revalidated_without_llm, true);
  assert.equal(report.planner.timing_revalidated_from_path, existingPlan);
}

async function testGlobalStylePromptDoesNotInjectCrowdExtras() {
  const files = [
    "scripts/imagegen.mjs",
    "scripts/visual-plan.mjs",
    "scripts/visual-prompt-review.mjs",
    "AGENTS.md",
    "docs/workflows/video_production_workflow.md",
  ];
  for (const filePath of files) {
    const text = await fs.readFile(path.join(process.cwd(), filePath), "utf8");
    assert.equal(/crowd extras/i.test(text), false, `${filePath} must not globally request crowd extras`);
  }
}

async function testCodexImageWorkQueueContracts() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-codex-work-"));
  const episodeDir = path.join(root, "episode");
  await fs.mkdir(episodeDir, { recursive: true });
  const promptsPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  const imageIds = Array.from({ length: 4 }, (_value, index) => `ep_01-cut-${String(index + 1).padStart(3, "0")}`);
  await writeJson(promptsPath, {
    status: "passed",
    image_provider: "codex_imagegen",
    prompts: imageIds.map((imageId, index) => ({
      image_id: imageId,
      image_provider_route: "codex_imagegen",
      codex_image_prompt: `Anime/manhwa scene ${index + 1}, 16:9 landscape.`,
      reference_slots: [],
    })),
  });
  const created = await createCodexWorkManifest({ mode: "scene", episodeDir, promptsPath, imageIds, leaseSeconds: 30, maxAttempts: 2 });
  assert.equal(created.manifest.item_count, 4);
  assert.equal(created.manifest.policy.recommended_concurrency, 8);
  assert.equal(created.manifest.policy.max_concurrency, 12);
  const leases = await Promise.all(imageIds.map((_id, index) => leaseNextWorkItem({ manifestPath: created.manifest.manifest_path, workerId: `worker-${index}` })));
  assert.equal(new Set(leases.map((row) => row.assignment.asset_id)).size, 4);
  for (const [index, lease] of leases.entries()) {
    const assignment = lease.assignment;
    await heartbeatWorkItem({
      manifestPath: created.manifest.manifest_path,
      assetId: assignment.asset_id,
      leaseToken: assignment.lease_token,
      workerId: assignment.worker_id,
      leaseSeconds: 30,
    });
    await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 30 + index * 20, g: 80, b: 140 } } })
      .png()
      .toFile(assignment.expected_output_path);
    await completeWorkItem({
      manifestPath: created.manifest.manifest_path,
      assetId: assignment.asset_id,
      leaseToken: assignment.lease_token,
      workerId: assignment.worker_id,
      sourcePath: assignment.expected_output_path,
      reportedSha256: await sha256File(assignment.expected_output_path),
    });
  }
  assert.equal((await getCodexWorkStatus({ manifestPath: created.manifest.manifest_path })).status, "completed");
  const initialValidation = await validateCodexWorkManifest({ manifestPath: created.manifest.manifest_path });
  assert.equal(initialValidation.status, "passed", JSON.stringify(initialValidation.findings, null, 2));

  async function createConcurrencyQueue({ slug, itemCount, maxConcurrency, verificationGateBypass = undefined }) {
    const queueEpisodeDir = path.join(root, slug);
    await fs.mkdir(queueEpisodeDir, { recursive: true });
    const queuePromptsPath = path.join(queueEpisodeDir, "section_image_prompts_hardened.json");
    const queueImageIds = Array.from({ length: itemCount }, (_value, index) => `${slug}-${String(index + 1).padStart(3, "0")}`);
    await writeJson(queuePromptsPath, {
      status: "passed",
      image_provider: "codex_imagegen",
      prompts: queueImageIds.map((imageId, index) => ({
        image_id: imageId,
        image_provider_route: "codex_imagegen",
        codex_image_prompt: `${slug} concurrency frame ${index + 1}, anime/manhwa, 16:9 landscape.`,
        reference_slots: [],
      })),
    });
    const queue = await createCodexWorkManifest({
      mode: "scene",
      episodeDir: queueEpisodeDir,
      promptsPath: queuePromptsPath,
      imageIds: queueImageIds,
      leaseSeconds: 300,
      maxAttempts: 1,
      recommendedConcurrency: maxConcurrency,
      maxConcurrency,
      verificationGateBypass,
    });
    return { ...queue, imageIds: queueImageIds, promptsPath: queuePromptsPath };
  }

  const defaultGate = await createConcurrencyQueue({
    slug: "default-verification-gate",
    itemCount: 6,
    maxConcurrency: 20,
  });
  assert.equal(defaultGate.manifest.policy.verification_asset_ids.length, 4);
  assert.equal(defaultGate.manifest.policy.verification_required_before_full_queue, true);
  assert.equal(defaultGate.manifest.policy.verification_gate_bypass, null);
  const defaultGateLeases = await Promise.all(defaultGate.imageIds.map((_imageId, index) => leaseNextWorkItem({
    manifestPath: defaultGate.manifest.manifest_path,
    workerId: `default-gate-worker-${index}`,
  })));
  assert.equal(defaultGateLeases.filter((row) => row.status === "leased").length, 4);
  assert.equal(defaultGateLeases.filter((row) => row.status === "no_work").length, 2);
  assert.equal((await getCodexWorkStatus({ manifestPath: defaultGate.manifest.manifest_path, reconcile: false })).verification_wave.status, "in_progress");

  const healthProofPath = path.join(root, "prior-flow-health-proof.json");
  await writeJson(healthProofPath, {
    schema: "goldflow_google_flow_health_proof_v1",
    status: "passed",
    verified_reference_counts: [0, 1, 2, 4],
  });
  const healthProofSha256 = await sha256File(healthProofPath);
  await assert.rejects(() => createConcurrencyQueue({
    slug: "boolean-bypass-forbidden",
    itemCount: 6,
    maxConcurrency: 5,
    verificationGateBypass: true,
  }), /evidence object/);
  await assert.rejects(() => createConcurrencyQueue({
    slug: "unbound-bypass-forbidden",
    itemCount: 6,
    maxConcurrency: 5,
    verificationGateBypass: { kind: "prior_health_proof", path: healthProofPath },
  }), /exact lowercase SHA-256/);
  await assert.rejects(() => createConcurrencyQueue({
    slug: "stale-bypass-forbidden",
    itemCount: 6,
    maxConcurrency: 5,
    verificationGateBypass: { kind: "prior_health_proof", path: healthProofPath, sha256: "0".repeat(64) },
  }), /evidence hash mismatch/);

  const verificationGateBypass = {
    kind: "prior_health_proof",
    path: healthProofPath,
    sha256: healthProofSha256,
  };
  const maxFiveQueue = await createConcurrencyQueue({
    slug: "max-five-concurrency",
    itemCount: 6,
    maxConcurrency: 5,
    verificationGateBypass,
  });
  assert.equal(maxFiveQueue.manifest.policy.verification_required_before_full_queue, false);
  assert.deepEqual(maxFiveQueue.manifest.policy.verification_gate_bypass, {
    kind: "prior_health_proof",
    evidence_path: healthProofPath,
    evidence_sha256: healthProofSha256,
  });
  assert.deepEqual(maxFiveQueue.manifest.sources.verification_health_proof, {
    path: healthProofPath,
    sha256: healthProofSha256,
  });
  const maxFiveAttempts = await Promise.all(maxFiveQueue.imageIds.map((_imageId, index) => leaseNextWorkItem({
    manifestPath: maxFiveQueue.manifest.manifest_path,
    workerId: `max-five-worker-${index}`,
  })));
  const fiveLeases = maxFiveAttempts.filter((row) => row.status === "leased");
  const deniedSixthLease = maxFiveAttempts.find((row) => row.status === "no_work");
  assert.equal(fiveLeases.length, 5);
  assert.equal(new Set(fiveLeases.map((row) => row.assignment.asset_id)).size, 5);
  assert.equal(deniedSixthLease?.no_work_reason, "max_concurrency_reached");
  assert.equal(deniedSixthLease?.live_lease_count, 5);
  const sameWorkerAtCapacity = await leaseNextWorkItem({
    manifestPath: maxFiveQueue.manifest.manifest_path,
    workerId: fiveLeases[0].assignment.worker_id,
  });
  assert.equal(sameWorkerAtCapacity.status, "leased");
  assert.equal(sameWorkerAtCapacity.reused_existing_lease, true);
  assert.equal(sameWorkerAtCapacity.assignment.lease_token, fiveLeases[0].assignment.lease_token);
  assert.equal((await getCodexWorkStatus({ manifestPath: maxFiveQueue.manifest.manifest_path, reconcile: false })).verification_wave.status, "bypassed_with_prior_health_proof");

  const maxTwentyQueue = await createConcurrencyQueue({
    slug: "max-twenty-concurrency",
    itemCount: 21,
    maxConcurrency: 20,
    verificationGateBypass,
  });
  const maxTwentyAttempts = await Promise.all(maxTwentyQueue.imageIds.map((_imageId, index) => leaseNextWorkItem({
    manifestPath: maxTwentyQueue.manifest.manifest_path,
    workerId: `max-twenty-worker-${index}`,
  })));
  const twentyLeases = maxTwentyAttempts.filter((row) => row.status === "leased");
  const deniedTwentyFirstLease = maxTwentyAttempts.find((row) => row.status === "no_work");
  assert.equal(twentyLeases.length, 20);
  assert.equal(new Set(twentyLeases.map((row) => row.assignment.asset_id)).size, 20);
  assert.equal(deniedTwentyFirstLease?.no_work_reason, "max_concurrency_reached");
  assert.equal(deniedTwentyFirstLease?.live_lease_count, 20);
  assert.equal(deniedTwentyFirstLease?.max_concurrency, 20);

  const duplicateWorkerEpisodeDir = path.join(root, "duplicate-worker-episode");
  await fs.mkdir(duplicateWorkerEpisodeDir, { recursive: true });
  const duplicateWorkerPromptsPath = path.join(duplicateWorkerEpisodeDir, "section_image_prompts_hardened.json");
  const duplicateWorkerIds = ["ep_01-duplicate-001", "ep_01-duplicate-002"];
  await writeJson(duplicateWorkerPromptsPath, {
    status: "passed",
    image_provider: "codex_imagegen",
    prompts: duplicateWorkerIds.map((imageId) => ({
      image_id: imageId,
      image_provider_route: "codex_imagegen",
      codex_image_prompt: `${imageId}, anime/manhwa, 16:9 landscape.`,
      reference_slots: [],
    })),
  });
  const duplicateWorkerManifest = await createCodexWorkManifest({
    mode: "scene",
    episodeDir: duplicateWorkerEpisodeDir,
    promptsPath: duplicateWorkerPromptsPath,
    imageIds: duplicateWorkerIds,
    leaseSeconds: 30,
    maxAttempts: 2,
  });
  const firstWorkerLease = await leaseNextWorkItem({ manifestPath: duplicateWorkerManifest.manifest.manifest_path, workerId: "same-worker" });
  const repeatedWorkerLease = await leaseNextWorkItem({ manifestPath: duplicateWorkerManifest.manifest.manifest_path, workerId: "same-worker" });
  assert.equal(repeatedWorkerLease.reused_existing_lease, true);
  assert.equal(repeatedWorkerLease.assignment.asset_id, firstWorkerLease.assignment.asset_id);
  const duplicateWorkerStatus = await getCodexWorkStatus({ manifestPath: duplicateWorkerManifest.manifest.manifest_path });
  assert.equal(duplicateWorkerStatus.counts.leased, 1);
  assert.equal(duplicateWorkerStatus.counts.pending, 1);

  const refreshedPromptsPath = path.join(episodeDir, "section_image_prompts_hardened_refreshed.json");
  const originalPrompts = await readJson(promptsPath);
  await writeJson(refreshedPromptsPath, { ...originalPrompts, provenance_refresh: "fixture" });
  const refreshed = await createCodexWorkManifest({ mode: "scene", episodeDir, promptsPath: refreshedPromptsPath, imageIds, leaseSeconds: 30, maxAttempts: 2 });
  const reused = await reuseExactWorkCompletions({
    sourceManifestPath: created.manifest.manifest_path,
    targetManifestPath: refreshed.manifest.manifest_path,
  });
  assert.equal(reused.reused_count, 4);
  assert.equal((await validateCodexWorkManifest({ manifestPath: refreshed.manifest.manifest_path })).status, "passed");

  const referencePlanPath = path.join(episodeDir, "visual_reference_plan.json");
  const characterStateRefsPath = path.join(episodeDir, "character_state_refs.json");
  await writeJson(referencePlanPath, {
    status: "passed",
    image_provider: "codex_imagegen",
    reference_targets: [
      { ref_id: "joey_base", inventory_asset_id: "char_joey_identity", kind: "character_identity", generation_mode: "standalone_ref", required_before_imagegen: true, codex_image_prompt: "Joey identity reference, anime/manhwa, 16:9 landscape." },
      { ref_id: "joey_state", kind: "character_state", generation_mode: "standalone_ref", required_before_imagegen: false, base_asset_id: "joey_state", codex_image_prompt: "Joey state reference, anime/manhwa, 16:9 landscape." },
    ],
  });
  await writeJson(characterStateRefsPath, {
    status: "draft_needs_manual_review",
    character_state_refs: [{
      state_ref_id: "joey_state",
      base_identity_ref_id: "char_joey_identity",
    }],
  });
  const refCreated = await createCodexWorkManifest({
    mode: "reference",
    episodeDir,
    referencePlanPath,
    characterStateRefsPath,
    referenceIds: ["joey_base", "joey_state"],
    leaseSeconds: 30,
  });
  assert.deepEqual(refCreated.manifest.items.find((item) => item.asset_id === "joey_state").dependency_asset_ids, ["joey_base"]);
  const baseLease = await leaseNextWorkItem({ manifestPath: refCreated.manifest.manifest_path, workerId: "ref-worker-a" });
  assert.equal(baseLease.assignment.asset_id, "joey_base");
  await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 120, g: 40, b: 80 } } }).png().toFile(baseLease.assignment.expected_output_path);
  await completeWorkItem({
    manifestPath: refCreated.manifest.manifest_path,
    assetId: baseLease.assignment.asset_id,
    leaseToken: baseLease.assignment.lease_token,
    workerId: baseLease.assignment.worker_id,
    sourcePath: baseLease.assignment.expected_output_path,
    reportedSha256: await sha256File(baseLease.assignment.expected_output_path),
  });
  const stateLease = await leaseNextWorkItem({ manifestPath: refCreated.manifest.manifest_path, workerId: "ref-worker-b" });
  assert.equal(stateLease.assignment.asset_id, "joey_state");
  assert.equal(stateLease.assignment.item.ordered_references.some((row) => row.ref_id === "joey_base"), true);
}

async function testHybridDeadletterSourceCompatibility() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-hybrid-deadletter-"));
  const episodeDir = path.join(root, "episode");
  const manifestDir = path.join(episodeDir, "assets", "images", "codex_worker_staging", "wavefront-deadletter-manifest");
  const manifestPath = path.join(manifestDir, "work_manifest.json");
  const deadletterPath = path.join(manifestDir, "deadletters", "ep_01-cut-001.json");
  const referencePath = path.join(episodeDir, "style-ref.bin");
  await fs.mkdir(path.dirname(deadletterPath), { recursive: true });
  await fs.writeFile(referencePath, "reference-v1", "utf8");
  const referenceSha256 = await sha256File(referencePath);
  const currentRow = {
    image_id: "ep_01-cut-001",
    image_generation_required: true,
    codex_image_prompt: "Current exact prompt",
    reference_slots: [{ ref_id: "style", reference_image_path: referencePath }],
  };
  const manifest = {
    schema: "goldflow_codex_image_work_manifest_v1",
    manifest_id: "wavefront-deadletter-manifest",
    manifest_path: manifestPath,
    episode_dir: episodeDir,
    mode: "scene",
    provider: HYBRID_WEB_FLOW_PROVIDER,
    items: [{
      asset_id: currentRow.image_id,
      source_row_sha256: codexWorkSourceRowSha256(currentRow),
      ordered_references: [{ ref_id: "style", path: referencePath, sha256: referenceSha256 }],
    }],
  };
  await writeJson(manifestPath, manifest);
  await writeJson(deadletterPath, {
    schema: "goldflow_codex_image_deadletter_v1",
    status: "deadlettered",
    manifest_id: manifest.manifest_id,
    asset_id: currentRow.image_id,
  });

  const compatible = await findSourceCompatibleHybridDeadletters({
    episodeDir,
    mode: "scene",
    currentRows: [currentRow],
    requestedIds: new Set([currentRow.image_id]),
  });
  assert.equal(compatible.has(currentRow.image_id), true, "wavefront manifests must contribute compatible deadletters to the official pool");
  assert.equal(compatible.get(currentRow.image_id).records.some((row) => row.path === manifestPath), true);
  assert.equal(compatible.get(currentRow.image_id).records.some((row) => row.path === referencePath), true);
  assert.equal(
    (await hybridDeadletteredAssetIdsForTests(episodeDir, "scene", [currentRow])).has(currentRow.image_id),
    true,
    "run status must authorize exact repair only from a source-compatible deadletter",
  );

  await writeJson(deadletterPath, {
    schema: "goldflow_codex_image_deadletter_v1",
    status: "deadlettered",
    manifest_id: "wrong-manifest",
    asset_id: currentRow.image_id,
  });
  assert.equal((await findSourceCompatibleHybridDeadletters({
    episodeDir,
    mode: "scene",
    currentRows: [currentRow],
  })).size, 0, "a copied or mismatched deadletter must not authorize repair");

  await writeJson(deadletterPath, {
    schema: "goldflow_codex_image_deadletter_v1",
    status: "deadlettered",
    manifest_id: manifest.manifest_id,
    asset_id: currentRow.image_id,
  });
  assert.equal((await findSourceCompatibleHybridDeadletters({
    episodeDir,
    mode: "scene",
    currentRows: [{ ...currentRow, codex_image_prompt: "Changed prompt" }],
  })).size, 0, "a stale same-ID creative contract must not authorize repair");
  assert.equal(
    (await hybridDeadletteredAssetIdsForTests(episodeDir, "scene", [{ ...currentRow, codex_image_prompt: "Changed prompt" }])).size,
    0,
    "run status must ignore a stale same-ID deadletter after prompt drift",
  );

  await fs.writeFile(referencePath, "reference-v2", "utf8");
  assert.equal((await findSourceCompatibleHybridDeadletters({
    episodeDir,
    mode: "scene",
    currentRows: [currentRow],
  })).size, 0, "changed conditioning bytes must invalidate prior deadletter evidence");
}

async function testHybridRepairCompletionReconciliationSelection() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-hybrid-repair-completion-"));
  const episodeDir = path.join(root, "episode");
  const currentRows = [
    { image_id: "ep_01-cut-001", image_generation_required: true, codex_image_prompt: "Repair cut one" },
    { image_id: "ep_01-cut-002", image_generation_required: true, codex_image_prompt: "Repair cut two" },
  ];
  const acceptedPath = path.join(episodeDir, "accepted.png");
  const downloadsRoot = path.join(root, "downloads");
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.mkdir(downloadsRoot, { recursive: true });
  await sharp({ create: { width: 320, height: 180, channels: 3, background: "#15243d" } }).png().toFile(acceptedPath);
  const acceptedHash = await sha256File(acceptedPath);

  async function writeCompletedManifest({
    slug,
    color,
    completedAt,
    validReceipt = true,
    reuseAccepted = false,
    browserProvider = "chatgpt",
    assetIndex = 0,
    flowReferenceBinding = null,
  }) {
    const sourceRow = currentRows[assetIndex];
    const assetId = sourceRow.image_id;
    const manifestId = `repair-completion-${slug}`;
    const manifestDir = path.join(episodeDir, "assets", "images", "codex_worker_staging", manifestId);
    const manifestPath = path.join(manifestDir, "work_manifest.json");
    const attemptDir = path.join(manifestDir, "attempts", assetId, `attempt-001-${slug}`);
    const outputPath = path.join(attemptDir, `${assetId}.png`);
    await fs.mkdir(path.join(manifestDir, "completions"), { recursive: true });
    await fs.mkdir(attemptDir, { recursive: true });
    if (reuseAccepted) await fs.copyFile(acceptedPath, outputPath);
    else await sharp({ create: { width: 320, height: 180, channels: 3, background: color } }).png().toFile(outputPath);
    const outputSha256 = await sha256File(outputPath);
    const promptSha256 = createHash("sha256").update(sourceRow.codex_image_prompt).digest("hex");
    const item = {
      asset_id: assetId,
      source_row_sha256: codexWorkSourceRowSha256(sourceRow),
      prompt_sha256: promptSha256,
      ordered_references: [],
      expected_output: { filename: `${assetId}.png` },
    };
    await writeJson(manifestPath, {
      schema: "goldflow_codex_image_work_manifest_v1",
      manifest_id: manifestId,
      manifest_path: manifestPath,
      episode_dir: episodeDir,
      mode: "scene",
      provider: HYBRID_WEB_FLOW_PROVIDER,
      policy: {
        browser_provider_receipt_required: true,
        allowed_browser_providers: ["chatgpt", "google-flow"],
      },
      items: [item],
    });
    await writeJson(path.join(attemptDir, "assignment.json"), {
      schema: "goldflow_codex_image_assignment_v1",
      manifest_id: manifestId,
      asset_id: assetId,
      browser_provider: browserProvider,
      item,
    });
    await writeJson(path.join(attemptDir, browserProvider === "google-flow" ? "google_flow_receipt.json" : "chatgpt_web_receipt.json"), {
      schema: browserProvider === "google-flow"
        ? "goldflow_google_flow_image_receipt_v1"
        : "goldflow_chatgpt_web_image_receipt_v1",
      status: "downloaded",
      manifest_id: manifestId,
      asset_id: assetId,
      browser_provider: browserProvider,
      prompt_sha256: promptSha256,
      ordered_reference_hashes: [],
      accepted_png_sha256: validReceipt ? outputSha256 : "0".repeat(64),
      ...(browserProvider === "google-flow" ? { ui_contract: { reference_binding: flowReferenceBinding } } : {}),
      completed_at: completedAt,
    });
    await writeJson(path.join(manifestDir, "completions", `${assetId}.json`), {
      schema: "goldflow_codex_image_completion_v1",
      status: "completed",
      manifest_id: manifestId,
      asset_id: assetId,
      attempt_dir: attemptDir,
      browser_provider: browserProvider,
      source_path: outputPath,
      sha256: outputSha256,
      prompt_sha256: promptSha256,
      ordered_reference_hashes: [],
      completed_at: completedAt,
    });
    return { manifestPath, outputSha256 };
  }

  const reusable = await writeCompletedManifest({ slug: "valid-new", color: "#a33f4b", completedAt: "2026-01-02T00:00:00.000Z" });
  await writeCompletedManifest({ slug: "invalid-newer", color: "#42a36c", completedAt: "2026-01-03T00:00:00.000Z", validReceipt: false });
  await writeCompletedManifest({ slug: "same-as-current", color: "#000000", completedAt: "2026-01-04T00:00:00.000Z", reuseAccepted: true });
  await writeCompletedManifest({
    slug: "malformed-flow-binding",
    color: "#8751a8",
    completedAt: "2026-01-05T00:00:00.000Z",
    browserProvider: "google-flow",
    assetIndex: 1,
    flowReferenceBinding: {
      schema: "goldflow_google_flow_reference_binding_v1",
      status: "verified",
      expected_count: 0,
      observed_count: 0,
      ordered_references: [],
    },
  });
  const requestedIds = new Set(currentRows.map((row) => row.image_id));
  const selected = await findSourceCompatibleHybridCompletions({
    episodeDir,
    mode: "scene",
    currentRows,
    requestedIds,
    currentAcceptedHashesById: new Map([[currentRows[0].image_id, acceptedHash]]),
    currentAcceptedAtById: new Map([[currentRows[0].image_id, "2026-01-01T00:00:00.000Z"]]),
    downloadsRoot,
  });
  assert.equal(selected.size, 1);
  assert.equal(selected.get(currentRows[0].image_id).manifestPath, reusable.manifestPath, "newest receipt-valid different completion must be reconciled");
  assert.equal(selected.has(currentRows[1].image_id), false, "a top-level-valid Flow receipt with a malformed full reference binding must not be reconciled");
  assert.deepEqual([...requestedIds].filter((assetId) => !selected.has(assetId)), [currentRows[1].image_id], "only IDs without a reusable completion should remain for generation");

  const noHistoricalRollback = await findSourceCompatibleHybridCompletions({
    episodeDir,
    mode: "scene",
    currentRows,
    requestedIds,
    currentAcceptedHashesById: new Map([[currentRows[0].image_id, acceptedHash]]),
    currentAcceptedAtById: new Map([[currentRows[0].image_id, "2026-01-03T12:00:00.000Z"]]),
    downloadsRoot,
  });
  assert.equal(noHistoricalRollback.size, 0, "repair reconciliation must not roll back to a completion older than the current materialization");
}

const FIXTURE_SUITES = {
  "stage-contract": [
    testAuthoritativeStageRegistry,
    testParallelStageDependenciesAndOwnedOutputs,
    testNarrationTtsProviderLocksAndLegacyRouting,
    testPuckOnlyNarrationIdentityFailClosedGates,
    testNarrationTtsSelectionAndQaContracts,
    testProofBaselineImportSupportsGenericAndLegacyNarrationContracts,
    testScopedOnlyPlannerRerunPolicy,
    testVisualWavefrontBatchPolicy,
    testRunIdentityV2Policies,
    testLocalWhisperProductionContract,
    testGuardedRunAdvancePolicies,
    testPlannerChunkIdentityValidation,
    testFinalQaSourceHashFreshness,
    testRunStatusRejectsFalseGreenFinalQa,
    testRunStatusParallaxDecisionStages,
    testAppendOnlyExecutionProvenance,
    testExecutionProvenanceScopesAndTruthfulCompletion,
    testPlannerCachesDefaultOn,
    testVisualReferencePlannerSplitsOnlyOversizedChunks,
    testCumulativeImagegenHistoryAndEpisodeTruth,
    testPinnedCodexRuntimeContracts,
    testNestedCodexCallsUseSharedRunner,
    testPreflightLocksNativeTtsSpeedAndSmoothRender,
    testModelslabCreditFallbackClassification,
    testPostTempoRequiresEmergencyApproval,
    testPostTempoScalesPreparedStitchTimeline,
    testHybridImageProviderRouting,
    testPersistentFederatedImageIdentityPolicy,
    testHybridOpeningWindowPersistsInRunIdentity,
    testRunStatusResumesBlockedVisualReviewWithoutFullReplan,
    testRunStatusBlocksLegacyScriptPaceHookWarnings,
    testRunStatusBlocksMissingQwenStitchedAudio,
    testRunStatusHashBindsCurrentQwenStitch,
    testRunStatusAcceptsGenericNarrationWithSelectedFallbackRepair,
    testLocalWhisperRevalidationAndStatusContract,
    testRunStatusBlocksStaleVisualBeatSourceHashes,
    testRunStatusBlocksStaleVisualReferenceSourceHashes,
    testRunStatusSurfacesDraftReferenceApprovalCommand,
    testRunStatusBlocksQwenPlanMissingOverrideAudit,
    testRunStatusIgnoresProofImageReportWithoutCurrentHardenedPlan,
    testRunStatusRoutesOnlyCreditFailuresToCodexFallback,
    testRunStatusRecoversFailedAndCircuitSkippedSpanCuts,
    testRunStatusIncludesManualBlockerTriagePolicy,
    testRunStatusDerivedReferenceSeedPromoteAndScopedRetry,
  ],
  planner: [
    testSemanticChunkAndReconciliationEffortRouting,
    testPlannerJsonRepairHandlesQuotedProseBeforeComma,
    testSemanticSceneAnchorValidation,
    testSemanticSceneCoverageRejectsCollapsedTail,
    testSemanticSceneQualityFindings,
    testReferenceDirectorPreservesRetiredSceneScopesAsAdvisory,
    testSemanticPlannerPromptContracts,
    testSemanticChunkingSplitsLongSingleParagraph,
    testBoundedProofBaselineScoping,
    testSemanticReconciliationEvidenceContract,
    testSemanticCanonicalizesDistinctVisibleActors,
    testEditorialBeatDirectorContracts,
    testEditorialBeatTimelineClosure,
    testSemanticAnchorSnapsToExactScriptTokens,
    testFirstPersonBeatKeepsProtagonistVisible,
    testWhisperExcerptAlignmentInterpolatesUnspokenUi,
    testLocationSceneIdsDerivation,
    testCanonicalCharacterIdentitySceneIds,
    testReferenceDirectorV2EvidenceAndLocationContracts,
    testReferenceDirectorTreatsDistinctNonhumansAsIdentities,
    testReferenceDirectorV2RejectsDeterministicExpansionAndDerivedCuts,
    testReferencePlanHashApproval,
    testRecurringReferenceCoverageCanonicalizesAliases,
    testCharacterReferenceCleanlinessContracts,
    testFaceOnlySourcesStayDependenciesAndMapNarrowly,
    testCleanReferenceApprovalChainIsHashBound,
    testActiveStateValidationSkipsTextOnlyUiMentions,
    testAdaptiveProviderPromptPackets,
    testTruncatedVisualPromptPrefixExtraction,
    testRiskClassificationUsesLikelyAttachmentsAndSafeEditorialReuse,
    testSelectedReferenceInventoryContainsOnlyDirectorSelections,
    testReferenceDirectorV2BlocksDanglingAndGroupCharacterStates,
    testReferenceIdentityMergePreservesChronologyAndDistinctApexAttackers,
    testLocationCandidateExclusion,
    testStarvationGate,
    testBroadLocationTargetDoesNotSatisfySemanticLocationRequirement,
    testOutOfScopeRefDropping,
    testReferenceLimitOmissionIsNotForbidden,
    testPositiveAttachmentConsensusRemovesForbiddenConflict,
    testOutOfScopeLocationMentionAssertion,
    testProviderAwarePromptSelection,
    testSceneImageProductionContractBlocksDroppedRefsAndStyle,
    testGroupReferencePromptDoesNotDemandOnePerson,
    testSingleCharacterReferencePromptIgnoresNegativeGroupWords,
    testFluxKleinCreatureActionAndRequestContracts,
    testConciseReferenceRoleContract,
    testLocalBeatFidelityEditorialCases,
    testVisualPlannerDriftContracts,
    testPromptPayloadMarkerSanitizerPreservesNormalNegation,
    testCharacterStagingSanitizerAndReviewBlockers,
    testVisualBeatDensityDefaults,
    testVisualBeatQualityFindings,
    testCrossGenreVisualBeatFixtures,
    testLongLocationSpanCrossingRetentionBoundary,
    testRepeatedRetentionShotJobRunFindings,
    testVisualPlanReportsOverbroadLocationRefCoverageBeforeLlm,
    testVisualPlanAllowsSameLocationLabelAliases,
    testOnlyScenesDryRun,
    testOnlyCutIdsDryRun,
    testNamedCharacterDuplicationAllowsReflections,
    testVisualResolveScopePrefersCutIds,
    testHardenFeedbackBlockersMapToReviewResolveInput,
    testPassedReviewClearsDeadletterPayload,
    testVisualHardenAllowsStoryFaithfulNegativeWordsWithoutRewrite,
    testVisualHardenStripsNonAttachableScopedRefs,
    testVisualHardenRetainsPendingDerivedRequirementWithoutSlot,
    testVisualHardenAcceptsInventoryOnlyLocationContract,
    testVisualHardenLeavesCleanPromptByteIdenticalAndNormalizesRefs,
    testVisualHardenCanonicalizesStateRefRequirements,
    testVisualHardenBlocksOnlyUnusablePromptText,
    testVisualHardenAcceptsExactApprovedBeatScopeAcrossSceneBoundary,
    testVisualHardenAcceptsRecurringBaseIdentityAcrossSceneBoundary,
    testVisualHardenNormalizesReferenceCapWithoutBlocking,
    testVisualPlannerKeepsCanonicalIdentityTargetsForVisibleCharacters,
    testVisualHardenBlocksVisibleCharacterWhenScopedRefOmitted,
    testVisualHardenBlocksVisibleCharacterWhenOnlyOutOfScopeRefExists,
    testVisualHardenTreatsCollectiveSubjectsAsGeneric,
    testVisualHardenWaivesNonphysicalScreenAndReplayDepictions,
    testVisualHardenBlocksAttachedCharacterRefWhenAnchorIgnored,
    testVisualHardenAllowsAttachedCharacterRefWhenAnchorReaffirmed,
    testVisualHardenPreservesAttachableFaceOnlyStateRef,
    testVisualHardenBlocksMissingManifestLocationWithoutAddingIt,
    testVisualHardenBlocksMissingPendingDerivedLocationContract,
    testVisualHardenV2AcceptsTextLocationContractWithoutImageRef,
    testVisualHardenV2AllowsPureScreenDepictionWithoutLocationContract,
    testVisualHardenV2StillBlocksCurrentRealityWithoutLocationContract,
    testVisualHardenV2BlocksUnknownLocationContract,
    testVisualHardenManualTriageCanDisregardSpecificBlocker,
    testVisualHardenPreservesCrowdedCharacterRefsOverOmittedLocation,
    testGlobalStylePromptDoesNotInjectCrowdExtras,
  ],
  media: [
    testPhraseAwareSubtitleGrouping,
    testQwenKeepsBracketedUiDialogueSpeakable,
    testNarratorOnlyQwenHonorsSegmentAndInstructionBoundaries,
    testQwenTtsOutputQaContracts,
    testEpisodeLocalAmbienceSpecContract,
    testImageOutputQaRiskAndDonorPolicies,
    testExceptionDrivenQaAndAutomaticFocalAnalysis,
    testProviderCircuitBreakerStopsUnclaimedWork,
    testProviderConcurrencyBacksOffAndRecovers,
    testDirectedMotionAndFullTimelineTransitions,
    testMotionPlanConsumesApprovedParallax,
    testStreamingRenderHashFinalization,
    testRenderRequiresHashMatchedImageQa,
    testIncrementalMotionClipPrebuildReusesExactCache,
    testGptImage2PreservesFullPromptAndUsesLandscapeDefault,
    testVoiceDirectionCharacterization,
    testQwenTextIntegrityCoverageGate,
    testKokoroNarrationUnitGroupingAndAtomicBarriers,
    testQwenHumanShieldPatternKeepsVoiceSegmentsAtomic,
    testVoiceDirectionPreservesFastRecapCadence,
    testScriptMetaScanAllowsInStoryAnalyticsObjects,
    testQwenPlanAuditsAppliedTtsOverrides,
    testQwenPlanSpeaksStandaloneSystemUiWithoutBrackets,
    testNarrationPaceChecks,
    testScriptPaceDoesNotUseBuiltInEpisodeHookPhrases,
    testTargetedSpeakabilityLiveContentHomograph,
    testImagegenDeadletterRefusal,
    testNarratorOnlyStatusAndMixer,
    testRunCleanupPrunesNarratorOnlyLongformWav,
    testTimingBindMatchesPossessiveAnchorsAfterCursor,
    testDerivedReferenceCandidateSelectionAndManifestAttach,
    testDerivedReferencePromotionFromSeedCut,
    testImagegenReusesImportedCodexOpeningCut,
    testCodexImageWorkQueueContracts,
    testHybridDeadletterSourceCompatibility,
    testHybridRepairCompletionReconciliationSelection,
    testSilentTransitionsWithoutSfxBank,
    testTransitionRevalidationUsesAllAdjacentCuts,
  ],
  integration: [
    testYoutubeRetentionAttribution,
  ],
};

export async function runFixtureSuite(name = "all") {
  const selected = name === "all" ? Object.entries(FIXTURE_SUITES) : [[name, FIXTURE_SUITES[name]]];
  if (selected.some(([, tests]) => !tests)) throw new Error(`Unknown fixture suite ${name}. Expected: ${Object.keys(FIXTURE_SUITES).join(", ")}, all.`);
  for (const [suiteName, tests] of selected) {
    for (const test of tests) await test();
    console.log(`goldflow ${suiteName} fixture suite passed (${tests.length} tests)`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const suiteIndex = process.argv.indexOf("--suite");
  await runFixtureSuite(suiteIndex >= 0 ? process.argv[suiteIndex + 1] : "all");
}
