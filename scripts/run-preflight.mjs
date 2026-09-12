#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib/file-hash.mjs";
import { normalizeImageProvider } from "./lib/image-provider-routing.mjs";
import {
  DEFAULT_GOOGLE_GEMINI_MODEL,
  DEFAULT_GOOGLE_GEMINI_PLAN,
  DEFAULT_GOOGLE_FLOW_HEALTH_PROOF_PATH,
  DEFAULT_GOOGLE_FLOW_MODEL,
  DEFAULT_GOOGLE_FLOW_PLAN,
  GOOGLE_FLOW_IMAGE_PROVIDER,
  federatedWebImageIdentityOptions,
  federatedWebImageProviderLocks,
  federatedWebImageProviderModels,
  googleFlowPrimaryIdentityOptions,
  googleFlowPrimaryProviderLocks,
  hybridWebFlowIdentityOptions,
  hybridWebFlowProviderLocks,
  hybridWebFlowProviderModels,
  isFederatedWebImageProvider,
  isHybridWebFlowProvider,
  isGoogleFlowPrimaryProvider,
  loadGoogleFlowHealthProof,
} from "./lib/image-provider-policy.mjs";
import {
  MODELSLAB_CREDIT_EXHAUSTED,
  normalizeImageFallbackCondition,
} from "./lib/image-fallback-policy.mjs";
import {
  PIPELINE_STAGE_REGISTRY_VERSION,
  stageChecklistFor,
} from "./lib/pipeline-stage-registry.mjs";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
} from "./lib/codex-cli-runner.mjs";
import {
  DEFAULT_PLANNING_PROVIDER,
  DEFAULT_PLANNING_ROOM_EFFORT_POLICY,
  DEFAULT_UNIFORM_PLANNING_EFFORT_POLICY,
  DEFAULT_WEB_PLANNING_EFFORT_POLICY,
  DEFAULT_WEB_PLANNING_REASONING_EFFORT,
  CHATGPT_WEB_PLANNING_MODEL,
  normalizePlanningEffort,
  normalizePlanningEffortPolicy,
  normalizePlanningProvider,
} from "./lib/planning-runtime-policy.mjs";
import {
  PLANNING_ROOM_PROVIDER,
  PLANNER_PROVIDER_REGISTRY,
  plannerModelForProvider,
  planningRoomContract,
} from "./lib/planner-provider-registry.mjs";
import {
  DEFAULT_PRODUCTION_PROFILE,
  normalizeProductionProfile,
  productionProfileSummary,
} from "./lib/production-profiles.mjs";
import {
  DEFAULT_CONTENT_PROFILE,
  contentProfileDefinition,
  contentProfileRequiresEvidenceLedger,
} from "./lib/content-profiles.mjs";
import {
  assertAvailableMediaWorkflow,
  mediaWorkflowForPreflight,
} from "./lib/media-workflows.mjs";
import {
  factualEvidenceBinding,
} from "./lib/factual-evidence-contract.mjs";
import {
  validateLocalWhisperIdentityContract,
} from "./lib/local-whisper-policy.mjs";
import {
  DEFAULT_NARRATOR_VOICE_ID,
  DEFAULT_TTS_FALLBACK_PROVIDER,
  DEFAULT_TTS_PROVIDER,
  EXTERNAL_NARRATION_TTS_PROVIDERS,
  KOKORO_MODEL_LOCK,
  QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK,
  QWEN_JOEL_PRIMARY_LOCK,
  QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  QWEN_LOCAL_FALLBACK_LOCK,
  defaultNarrationVoiceProviderOptions,
  normalizeTtsProvider,
  narrationStitchContractForQuality,
  narrationUnitContractForQuality,
  narrationTtsPolicyForIdentity,
  validateNarrationTtsPolicy,
} from "./lib/narration-tts-policy.mjs";
import {
  buildNarrationQualityContract,
} from "./lib/narration-quality-contract.mjs";
import {
  DEFAULT_NARRATION_DELIVERY_BANK_PATH,
  loadNarrationDeliveryReferenceBank,
  validateNarrationDeliveryBankPrimaryBinding,
} from "./lib/narration-delivery-reference-bank.mjs";
import {
  validateNarrationProviderBakeoffManifest,
  validateNarrationProviderPromotion,
} from "./lib/narration-provider-bakeoff-contract.mjs";
import {
  LTX_VIDEO_MODEL_ID,
  LTX_VIDEO_PROVIDER,
} from "./lib/ltx-video-contract.mjs";
import {
  DEFAULT_GENERATED_MOTION_MODEL,
  DEFAULT_GENERATED_MOTION_POLICY,
  GENERATED_MOTION_PROVIDER_FLOW,
  GENERATED_MOTION_PROVIDER_LTX,
  normalizeGeneratedMotionPolicy,
  normalizeGeneratedMotionProvider,
} from "./lib/generated-motion-contract.mjs";
import {
  normalizeWinnerNarration,
  sha256Text,
  validateWinnerPackageContract,
  validateWinnerStoryBlueprintApproval,
  validateWinnerSourceRelease,
} from "./lib/winner-source-contract.mjs";
import { validateWinnerBlueprintForPackage } from "./lib/winner-source-room-contract.mjs";
import { loadWinnerSourceRoomLineage } from "./lib/winner-source-room-lineage.mjs";
import { loadSourceRoomReleaseV2Binding } from "./lib/winner-source-room-v2-lineage.mjs";
import { SOURCE_ROOM_RELEASE_V2_SCHEMA } from "./lib/winner-source-room-v2-contract.mjs";
import {
  CHATGPT_WEB_PROJECT_CLEANUP_POLICY,
  normalizeChatGptWebProjectUrl,
} from "./lib/chatgpt-web-project.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_QWEN_NARRATOR_VOICE_ID = "joel_owned_narrator_clone";
const DEFAULT_QWEN_NARRATOR_VOICE_POLICY = "default_joel_owned_narrator_clone";
const invokedAsCommand = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel;
const series = flags.series ?? flags.seriesSlug;
const week = flags.week;
const episode = flags.episode;
let mediaWorkflowBinding = null;
// Imported fixture helpers must remain side-effect free. Actual preflight commands
// select their route and refuse identity replacement before provider/reference reads.
if (invokedAsCommand) {
  try {
    mediaWorkflowBinding = mediaWorkflowForPreflight({
      contentProfile: flags["content-profile"],
      mediaWorkflow: flags["media-workflow"],
    });
    if (mediaWorkflowBinding.media_workflow !== "generated_visuals_v1") throw new Error("Use pilot preflight for the bounded avatar proof; this preflight is generated-visuals only.");
    requiredFlag("channel", channel);
    requiredFlag("series", series);
    requiredFlag("week", week);
    requiredFlag("episode", episode);
    await assertNewIdentityPath(path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode, "run_identity.json"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
const contentProfileDefinitionValue = contentProfileDefinition(
  flags["content-profile"] ?? DEFAULT_CONTENT_PROFILE,
);
const contentProfile = contentProfileDefinitionValue.config;
if (invokedAsCommand) {
  assertAvailableMediaWorkflow({
    ...mediaWorkflowBinding,
    content_profile: contentProfile.id,
    content_profile_config: contentProfile,
  });
}
const title = flags.title ?? flags["episode-title"] ?? "";
const sourcePath = flags.source ? path.resolve(flags.source) : null;
const winnerReleasePath = flags["winner-release"] ? path.resolve(flags["winner-release"]) : null;
const allowPartInWeek = flags["allow-part-in-week"] === "true";
const confirmEpisodeIdentity = flags["confirm-episode-identity"] === "true";
const audioTarget = normalizeAudioTarget(flags["audio-target"] ?? flags.audio ?? "narrator_only");
const runIntent = normalizeRunIntent(flags.intent ?? flags["run-intent"] ?? "production");
const productionProfile = normalizeProductionProfile(
  flags["production-profile"] ?? flags.profile ?? DEFAULT_PRODUCTION_PROFILE,
);
const productionProfileConfig = productionProfileSummary(productionProfile);
const imageProvider = normalizeImageProvider(
  flags["image-provider"]
    ?? flags.provider
    ?? productionProfileConfig.media.default_image_provider
    ?? "chatgpt_web_gpt_image",
);
const imageFallbackProvider = flags["image-fallback-provider"]
  ? normalizeImageProvider(flags["image-fallback-provider"])
  : null;
const imageFallbackCondition = normalizeImageFallbackCondition(
  flags["image-fallback-condition"] ?? (imageFallbackProvider ? MODELSLAB_CREDIT_EXHAUSTED : null),
);
const planningProvider = normalizePlanningProvider(
  flags["planning-provider"] ?? DEFAULT_PLANNING_PROVIDER,
);
const explicitPlanningReasoningEffort = flags["planning-reasoning-effort"] ?? null;
const planningEffortPolicy = normalizePlanningEffortPolicy(
  flags["planning-effort-policy"]
    ?? (planningProvider === PLANNING_ROOM_PROVIDER
      ? DEFAULT_PLANNING_ROOM_EFFORT_POLICY
      : explicitPlanningReasoningEffort != null || planningProvider !== "chatgpt_web"
      ? DEFAULT_UNIFORM_PLANNING_EFFORT_POLICY
      : DEFAULT_WEB_PLANNING_EFFORT_POLICY),
);
const planningDefaultReasoningEffort = normalizePlanningEffort(
  explicitPlanningReasoningEffort
    ?? (planningProvider === "chatgpt_web"
      ? DEFAULT_WEB_PLANNING_REASONING_EFFORT
      : DEFAULT_CODEX_REASONING_EFFORT),
);
const planningModel = String(flags["planning-model"]
  ?? (planningProvider === PLANNING_ROOM_PROVIDER
    ? "stage_routed"
    : planningProvider === "chatgpt_web" ? CHATGPT_WEB_PLANNING_MODEL : DEFAULT_CODEX_MODEL)).trim();
if (planningProvider !== "chatgpt_web" && planningEffortPolicy === DEFAULT_WEB_PLANNING_EFFORT_POLICY) {
  throw new Error(`${DEFAULT_WEB_PLANNING_EFFORT_POLICY} requires --planning-provider chatgpt_web.`);
}
if (planningProvider === "chatgpt_web" && planningModel !== CHATGPT_WEB_PLANNING_MODEL) {
  throw new Error(`Authenticated ChatGPT Web planning is locked to ${CHATGPT_WEB_PLANNING_MODEL}; received ${planningModel}.`);
}
if (!["chatgpt_web", PLANNING_ROOM_PROVIDER].includes(planningProvider) && planningDefaultReasoningEffort === "max") {
  throw new Error("Pro/max reasoning is available only through --planning-provider chatgpt_web.");
}
const factualEvidenceLedgerPath = flags["evidence-ledger"]
  ? path.resolve(flags["evidence-ledger"])
  : null;
const proofSourceComplete = flags["proof-source-complete"] === "true";
const localWhisperTimingContract = structuredClone(
  productionProfileConfig.audio.local_whisper_timing,
);
const allowDirtyWorktree = flags["allow-dirty-worktree"] === "true";
const dirtyReason = String(flags["dirty-reason"] ?? "").trim();
const codexOpeningSecRaw = flags["codex-opening-sec"] ?? flags["codex-opening-duration-sec"] ?? process.env.ANIFACTORY_CODEX_OPENING_SEC ?? null;
const chatGptProjectUrlRaw = flags["chatgpt-project-url"] ?? process.env.GOLDFLOW_CHATGPT_PROJECT_URL ?? null;
const chatGptProjectUrl = normalizeChatGptWebProjectUrl(chatGptProjectUrlRaw);
const googleFlowPlan = String(flags["google-flow-plan"] ?? process.env.GOLDFLOW_FLOW_PLAN ?? DEFAULT_GOOGLE_FLOW_PLAN);
const googleFlowModel = String(flags["google-flow-model"] ?? process.env.GOLDFLOW_FLOW_MODEL ?? DEFAULT_GOOGLE_FLOW_MODEL);
const googleGeminiPlan = String(flags["google-gemini-plan"] ?? process.env.GOLDFLOW_GEMINI_PLAN ?? DEFAULT_GOOGLE_GEMINI_PLAN);
const googleGeminiModel = String(flags["google-gemini-model"] ?? process.env.GOLDFLOW_GEMINI_MODEL ?? DEFAULT_GOOGLE_GEMINI_MODEL);
const googleImageScheduling = String(flags["google-image-scheduling"] ?? "").trim();
if (googleImageScheduling && !isFederatedWebImageProvider(imageProvider)) {
  throw new Error("--google-image-scheduling requires the federated_google_web_image_pool provider.");
}
const googleFlowHealthProofPath = (isHybridWebFlowProvider(imageProvider) || isGoogleFlowPrimaryProvider(imageProvider) || isFederatedWebImageProvider(imageProvider))
  ? path.resolve(flags["google-flow-health-proof"] ?? process.env.GOLDFLOW_FLOW_HEALTH_PROOF ?? DEFAULT_GOOGLE_FLOW_HEALTH_PROOF_PATH)
  : null;
const googleFlowHealthProof = (isHybridWebFlowProvider(imageProvider) || isGoogleFlowPrimaryProvider(imageProvider) || isFederatedWebImageProvider(imageProvider))
  ? await loadGoogleFlowHealthProof(googleFlowHealthProofPath, {
      expectedSha256: flags["google-flow-health-proof-sha256"] ?? null,
      expectedPlan: googleFlowPlan,
      expectedModel: googleFlowModel,
    })
  : null;
const pacePolicy = normalizePacePolicy(flags["pace-policy"] ?? flags["wpm-policy"] ?? "diagnostic");
const targetWpmMin = positiveNumber(flags["target-wpm-min"] ?? flags["wpm-min"] ?? null, 180);
const targetWpmMax = positiveNumber(flags["target-wpm-max"] ?? flags["wpm-max"] ?? null, 195);
const renderProfile = normalizeRenderProfile(flags["render-profile"] ?? flags.render ?? "premium");
const motionPolicy = normalizeMotionPolicy(flags["motion-policy"] ?? "selective_editorial_v1");
const productionDefaults = productionProfileConfig.defaults ?? {};
const humanCheckpointValue = String(flags["human-checkpoints"] ?? "").trim();
const humanCheckpoints = humanCheckpointValue
  ? humanCheckpointValue.toLowerCase() === "all"
    ? ["all"]
    : [...new Set(humanCheckpointValue.split(",").map((value) => value.trim()).filter(Boolean))]
  : [];
const generatedMotionPolicy = normalizeGeneratedMotionPolicy(
  flags["generated-motion-policy"]
    ?? flags["animation-policy"]
    ?? flags["ltx-video-policy"]
    ?? productionDefaults.generated_motion_policy
    ?? DEFAULT_GENERATED_MOTION_POLICY,
);
const generatedMotionProvider = generatedMotionPolicy === "disabled"
  ? null
  : normalizeGeneratedMotionProvider(flags["generated-motion-provider"] ?? flags["video-provider"] ?? GENERATED_MOTION_PROVIDER_FLOW);
const generatedMotionModel = generatedMotionPolicy === "disabled"
  ? null
  : String(flags["generated-motion-model"] ?? flags["video-model"] ?? (
      generatedMotionProvider === GENERATED_MOTION_PROVIDER_FLOW ? DEFAULT_GENERATED_MOTION_MODEL : LTX_VIDEO_MODEL_ID
    )).trim();
const generatedMotionRequiredThroughSec = boundedNumber(
  flags["generated-motion-required-through-sec"],
  productionDefaults.generated_motion_required_through_sec ?? 0,
  0,
  3600,
);
const visualBeatTimingDefaults = productionDefaults.visual_beat_timing_contract ?? {};
const visualBeatTimingContract = {
  enforcement: normalizeVisualBeatTimingEnforcement(
    flags["beat-timing-enforcement"]
      ?? visualBeatTimingDefaults.enforcement
      ?? "advisory",
  ),
  target_beat_sec: boundedNumber(flags["target-beat-sec"], visualBeatTimingDefaults.target_beat_sec ?? 8.5, 2, 20),
  max_beat_sec: boundedNumber(flags["max-beat-sec"], visualBeatTimingDefaults.max_beat_sec ?? 15, 2, 30),
  min_beat_sec: boundedNumber(flags["min-beat-sec"], visualBeatTimingDefaults.min_beat_sec ?? 3, 1, 15),
  hook_duration_sec: boundedNumber(flags["hook-duration-sec"], visualBeatTimingDefaults.hook_duration_sec ?? 30, 0, 180),
  hook_target_beat_sec: boundedNumber(flags["hook-target-beat-sec"], visualBeatTimingDefaults.hook_target_beat_sec ?? 3.2, 1, 10),
  hook_max_beat_sec: boundedNumber(flags["hook-max-beat-sec"], visualBeatTimingDefaults.hook_max_beat_sec ?? 4.2, 1, 15),
  hook_min_beat_sec: boundedNumber(flags["hook-min-beat-sec"], visualBeatTimingDefaults.hook_min_beat_sec ?? 2.2, 0.5, 10),
  retention_ramp_sec: boundedNumber(flags["retention-ramp-sec"], visualBeatTimingDefaults.retention_ramp_sec ?? 180, 0, 1200),
  ramp_target_beat_sec: boundedNumber(flags["ramp-target-beat-sec"], visualBeatTimingDefaults.ramp_target_beat_sec ?? 5.2, 1, 15),
  ramp_max_beat_sec: boundedNumber(flags["ramp-max-beat-sec"], visualBeatTimingDefaults.ramp_max_beat_sec ?? 6.5, 1, 20),
  ramp_min_beat_sec: boundedNumber(flags["ramp-min-beat-sec"], visualBeatTimingDefaults.ramp_min_beat_sec ?? 3.2, 0.5, 15),
};
if (visualBeatTimingContract.enforcement === "hard_max" && visualBeatTimingContract.max_beat_sec > 8) {
  throw new Error("Hard visual-beat timing caps may not exceed 8 seconds.");
}
for (const [label, minimum, target, maximum] of [
  ["episode", visualBeatTimingContract.min_beat_sec, visualBeatTimingContract.target_beat_sec, visualBeatTimingContract.max_beat_sec],
  ["hook", visualBeatTimingContract.hook_min_beat_sec, visualBeatTimingContract.hook_target_beat_sec, visualBeatTimingContract.hook_max_beat_sec],
  ["retention ramp", visualBeatTimingContract.ramp_min_beat_sec, visualBeatTimingContract.ramp_target_beat_sec, visualBeatTimingContract.ramp_max_beat_sec],
]) {
  if (!(minimum <= target && target <= maximum)) {
    throw new Error(`Visual ${label} beat timing must satisfy min <= target <= max.`);
  }
}
if (generatedMotionPolicy === "disabled" && generatedMotionRequiredThroughSec > 0) {
  throw new Error("--generated-motion-required-through-sec requires generated motion to be enabled.");
}
const ltxVideoPolicy = generatedMotionProvider === GENERATED_MOTION_PROVIDER_LTX
  ? generatedMotionPolicy === "full_generated_video" ? "full_ltx23" : "selective_ltx23"
  : "disabled";
const parallaxPolicy = normalizeParallaxPolicy(flags["parallax-policy"] ?? "selective_inspected");
const parallaxTargetMax = boundedInteger(flags["parallax-target-max"], 15, 0, 20);
const parallaxMinSpacingSec = boundedNumber(flags["parallax-min-spacing-sec"], 3, 0, 120);
const parallaxOpeningWindowSec = boundedNumber(flags["parallax-opening-window-sec"], 180, 0, 600);
const parallaxFirstWindowSec = boundedNumber(flags["parallax-first-window-sec"], 30, 0, parallaxOpeningWindowSec);
const parallaxFirstWindowTarget = boundedInteger(flags["parallax-first-window-target"], 5, 0, parallaxTargetMax);
const parallaxRetentionWindowTarget = boundedInteger(flags["parallax-retention-window-target"], 10, 0, parallaxTargetMax);
const parallaxBackgroundProvider = normalizeParallaxBackgroundProvider(
  flags["parallax-background-provider"] ?? (imageProvider === "modelslab" ? "modelslab_flux_klein" : "local_blur_legacy"),
);
const explicitLegacyQwenFlags = flags["qwen-narrator-voice-id"] != null || flags["qwen-native-speed"] != null;
const ttsProvider = normalizeTtsProvider(
  flags["tts-provider"] ?? DEFAULT_TTS_PROVIDER,
);
if (!["qwen_local", "kokoro_local", "modelslab_qwen", ...EXTERNAL_NARRATION_TTS_PROVIDERS].includes(ttsProvider)) {
  throw new Error(`Unsupported TTS provider: ${ttsProvider}.`);
}
if (runIntent === "production" && ttsProvider === "modelslab_qwen") {
  throw new Error(
    "Production runs require qwen_local with joel_owned_narrator_clone; "
    + "modelslab_qwen remains a legacy diagnostic adapter.",
  );
}
if (explicitLegacyQwenFlags && flags["tts-provider"] == null) {
  throw new Error("Legacy Qwen flags do not select the local production provider. Omit them for the Joel/Qwen default, or explicitly pass --tts-provider modelslab_qwen for a legacy diagnostic.");
}
if (ttsProvider === "qwen_local"
  && flags["tts-model"] != null
  && flags["tts-model"] !== QWEN_JOEL_PRIMARY_LOCK.model_id) {
  throw new Error(`Joel/Qwen production requires the audited model ${QWEN_JOEL_PRIMARY_LOCK.model_id}; --tts-model may not override it.`);
}
const fallbackDefault = ttsProvider === "kokoro_local" ? "qwen_local" : DEFAULT_TTS_FALLBACK_PROVIDER;
const fallbackValue = flags["tts-fallback-provider"] ?? fallbackDefault;
const ttsFallbackProvider = fallbackValue ? normalizeTtsProvider(fallbackValue) : null;
const narratorVoiceId = cleanOptionalId(
  flags["narrator-voice-id"]
  ?? flags["tts-voice-id"]
  ?? (ttsProvider === "qwen_local"
    ? DEFAULT_NARRATOR_VOICE_ID
    : ttsProvider === "kokoro_local" ? "am_puck" : null),
);
if (EXTERNAL_NARRATION_TTS_PROVIDERS.includes(ttsProvider)
  && !narratorVoiceId) {
  throw new Error(
    "External TTS preflight requires --narrator-voice-id with a stable provider voice identifier.",
  );
}
const narratorReferenceVariantId = cleanOptionalId(
  flags["narrator-reference-variant"]
    ?? (ttsProvider === "qwen_local"
      ? QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK.reference_variant_id
      : null),
);
if (ttsProvider === "qwen_local"
  && narratorReferenceVariantId
    !== QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK.reference_variant_id) {
  throw new Error(
    `New Joel/Qwen narration requires --narrator-reference-variant ${QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK.reference_variant_id}.`,
  );
}
if (ttsProvider === "qwen_local" && narratorVoiceId !== DEFAULT_NARRATOR_VOICE_ID) {
  throw new Error(`New narration identities use the owned Joel reference: --narrator-voice-id must be ${DEFAULT_NARRATOR_VOICE_ID}.`);
}
if (ttsProvider === "qwen_local" && ttsFallbackProvider !== null) {
  throw new Error("Joel/Qwen is the sole production voice; --tts-fallback-provider must be omitted.");
}
if (ttsProvider === "kokoro_local" && narratorVoiceId !== "am_puck") {
  throw new Error("Legacy Kokoro compatibility is Puck-only: --narrator-voice-id must be am_puck.");
}
if (ttsProvider === "kokoro_local" && ttsFallbackProvider !== "qwen_local") {
  throw new Error("Legacy Kokoro compatibility requires qwen_local as its exact-unit fallback.");
}
const requestedTtsNativeSpeed = flags["tts-native-speed"]
  ?? (ttsProvider === "modelslab_qwen" ? flags["qwen-native-speed"] : null)
  ?? process.env.ANIFACTORY_TTS_NATIVE_SPEED;
if (ttsProvider === "qwen_local" && requestedTtsNativeSpeed != null) {
  throw new Error("Joel/Qwen has no native-speed control. Omit --tts-native-speed; post-tempo processing is also disabled.");
}
const ttsNativeSpeed = ttsProvider === "qwen_local"
  ? null
  : requestedTtsNativeSpeed == null
    ? ttsProvider === "kokoro_local" ? 1.2 : null
    : boundedNumber(
        requestedTtsNativeSpeed,
        ttsProvider === "kokoro_local" ? 1.2 : 1,
        0.75,
        1.5,
      );
const externalNarrationProvider = EXTERNAL_NARRATION_TTS_PROVIDERS.includes(
  ttsProvider,
);
const narratorVoiceSha256 = externalNarrationProvider
  ? cleanOptionalId(flags["narrator-voice-sha256"] ?? flags["tts-voice-sha256"])
  : ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.voice_sha256 : null;
const externalTtsPrimaryOptions = externalNarrationProvider
  ? {
      model_id: cleanOptionalId(flags["tts-model"]),
      model_revision: cleanOptionalId(flags["tts-model-revision"]),
      voice_sha256: narratorVoiceSha256,
      voice_continuity_contract: cleanOptionalId(
        flags["voice-continuity-contract"],
      ),
      reference_audio_path: cleanOptionalId(flags["voice-reference-audio"]),
      reference_audio_sha256: cleanOptionalId(
        flags["voice-reference-audio-sha256"],
      ),
      reference_text: cleanOptionalId(flags["voice-reference-text"]),
      reference_text_sha256: cleanOptionalId(
        flags["voice-reference-text-sha256"],
      ),
      reference_manifest_path: path.resolve(
        flags["voice-reference-manifest"]
          ?? QWEN_JOEL_PRIMARY_LOCK.reference_manifest_path,
      ),
      reference_manifest_sha256: cleanOptionalId(
        flags["voice-reference-manifest-sha256"]
          ?? QWEN_JOEL_PRIMARY_LOCK.reference_manifest_sha256,
      ),
      reference_voice_id: cleanOptionalId(
        flags["voice-reference-id"] ?? DEFAULT_NARRATOR_VOICE_ID,
      ),
      reference_voice_sha256: cleanOptionalId(
        flags["voice-reference-sha256"]
          ?? QWEN_JOEL_PRIMARY_LOCK.reference_voice_sha256,
      ),
      speaker_similarity_method: cleanOptionalId(
        flags["speaker-similarity-method"]
          ?? QWEN_JOEL_PRIMARY_LOCK.speaker_similarity_method,
      ),
      speaker_similarity_model_path: path.resolve(
        flags["speaker-similarity-model"]
          ?? QWEN_JOEL_PRIMARY_LOCK.speaker_similarity_model_path,
      ),
      speaker_similarity_model_sha256: cleanOptionalId(
        flags["speaker-similarity-model-sha256"]
          ?? QWEN_JOEL_PRIMARY_LOCK.speaker_similarity_model_sha256,
      ),
      speaker_similarity_calibration_path: path.resolve(
        flags["speaker-similarity-calibration"]
          ?? QWEN_JOEL_PRIMARY_LOCK.speaker_similarity_calibration_path,
      ),
      speaker_similarity_calibration_sha256: cleanOptionalId(
        flags["speaker-similarity-calibration-sha256"]
          ?? QWEN_JOEL_PRIMARY_LOCK.speaker_similarity_calibration_sha256,
      ),
    }
  : null;
if (externalNarrationProvider) {
  const missing = [
    ["--tts-model", externalTtsPrimaryOptions.model_id],
    ["--tts-model-revision", externalTtsPrimaryOptions.model_revision],
    ["--narrator-voice-sha256", externalTtsPrimaryOptions.voice_sha256],
    ["--voice-continuity-contract", externalTtsPrimaryOptions.voice_continuity_contract],
  ].filter(([, value]) => !value).map(([label]) => label);
  if (missing.length) {
    throw new Error(
      `External TTS preflight requires ${missing.join(", ")}.`,
    );
  }
}
const operatorQwenNarratorVoiceId = cleanOptionalId(flags["qwen-narrator-voice-id"] ?? flags["narrator-voice-id"] ?? null);
const qwenNarratorVoiceId = operatorQwenNarratorVoiceId ?? DEFAULT_QWEN_NARRATOR_VOICE_ID;
const qwenNarratorVoicePolicy = operatorQwenNarratorVoiceId
  ? "operator_locked_qwen_narrator_voice_design"
  : DEFAULT_QWEN_NARRATOR_VOICE_POLICY;
const qwenNativeSpeed = boundedNumber(
  flags["qwen-native-speed"] ?? flags["tts-native-speed"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_NATIVE_SPEED,
  1.25,
  0.75,
  1.5,
);
const proofScope = parseProofScope(flags, runIntent);

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeAudioTarget(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized || ["narrator", "narration", "narrator_only", "narration_only", "voice_only"].includes(normalized)) return "narrator_only";
  return normalized;
}

function normalizeRunIntent(value) {
  const normalized = String(value ?? "production").trim().toLowerCase();
  if (!["production", "proof", "diagnostic", "test"].includes(normalized)) {
    throw new Error(`Unknown run intent: ${value}. Expected production, proof, diagnostic, or test.`);
  }
  return normalized;
}

function normalizePacePolicy(value) {
  void value;
  return "diagnostic";
}

function normalizeRenderProfile(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["fill", "fill_ken_burns", "oversampled_ken_burns", "legacy_premium"].includes(normalized)) return "fill_ken_burns";
  if (["smooth_subpixel", "subpixel", "subpixel_ken_burns", "smooth_subpixel_ken_burns"].includes(normalized)) return "smooth_subpixel_ken_burns";
  if (["smooth_fast", "smooth_ken_burns", "smooth_fast_kenburns", "smooth_fast_ken_burns"].includes(normalized)) return "smooth_fast_ken_burns";
  if (!normalized || normalized === "premium") return "smooth_subpixel_ken_burns";
  throw new Error(`Unknown render profile: ${value}`);
}

function normalizeMotionPolicy(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["selective_editorial_v1", "legacy"].includes(normalized)) return normalized;
  throw new Error(`Unknown motion policy: ${value}`);
}

function normalizeParallaxPolicy(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["selective_inspected", "disabled"].includes(normalized)) return normalized;
  throw new Error(`Unknown parallax policy: ${value}`);
}

function normalizeVisualBeatTimingEnforcement(value) {
  const normalized = String(value ?? "advisory").trim().toLowerCase();
  if (["advisory", "hard_max"].includes(normalized)) return normalized;
  throw new Error(`Unknown visual beat timing enforcement: ${value}. Expected advisory or hard_max.`);
}

function normalizeParallaxBackgroundProvider(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["modelslab_flux_klein", "local_blur_legacy"].includes(normalized)) return normalized;
  throw new Error(`Unknown parallax background provider: ${value}`);
}

function cleanOptionalId(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function boundedInteger(value, fallback, min, max) {
  return Math.floor(boundedNumber(value, fallback, min, max));
}

function gitCommand(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 32,
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return String(result.stdout ?? "").trim();
}

async function gitSnapshot() {
  const commit = gitCommand(["rev-parse", "HEAD"]);
  const branch = gitCommand(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = gitCommand(["status", "--porcelain=v1", "--untracked-files=all"]);
  const trackedDiff = gitCommand(["diff", "--binary", "HEAD"]);
  const untrackedRaw = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });
  if (untrackedRaw.status !== 0) throw new Error(untrackedRaw.stderr || "git ls-files failed");
  const untracked = String(untrackedRaw.stdout ?? "").split("\0").filter(Boolean).sort();
  const untrackedHashes = [];
  for (const relativePath of untracked) {
    const absolutePath = path.join(repoRoot, relativePath);
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) continue;
    untrackedHashes.push(`${relativePath}:${sha256(await fs.readFile(absolutePath))}`);
  }
  const dirty = Boolean(status);
  return {
    commit,
    branch,
    dirty,
    dirty_diff_sha256: dirty ? sha256([status, trackedDiff, ...untrackedHashes].join("\n")) : null,
    dirty_status: dirty ? status.split("\n").filter(Boolean) : [],
  };
}

function parseProofScope(parsedFlags, intent) {
  const explicit = String(parsedFlags["proof-scope"] ?? "").trim();
  const match = /^(\d+(?:\.\d+)?)\s*[-:]\s*(\d+(?:\.\d+)?)$/.exec(explicit);
  const start = Number(parsedFlags["proof-start-sec"] ?? parsedFlags["scope-start-sec"] ?? match?.[1] ?? 0);
  const end = Number(parsedFlags["proof-end-sec"] ?? parsedFlags["scope-end-sec"] ?? match?.[2] ?? 0);
  const bounded = Number.isFinite(end) && end > start;
  if (String(intent).toLowerCase() === "proof" && !bounded) {
    throw new Error("Proof preflight requires --proof-scope <start-end> or --proof-start-sec/--proof-end-sec.");
  }
  return {
    mode: bounded ? "bounded" : "full_episode",
    start_sec: bounded ? start : 0,
    end_sec: bounded ? end : null,
    label: String(parsedFlags["proof-label"] ?? parsedFlags["scope-label"] ?? (bounded ? `proof_${start}_${end}` : "full_episode")),
  };
}

function lockedModelVersions() {
  const genericTts = ttsProvider === "qwen_local" || ttsProvider === "kokoro_local";
  const primaryLock = ttsProvider === "qwen_local"
    ? QWEN_JOEL_PRIMARY_LOCK
    : ttsProvider === "kokoro_local" ? KOKORO_MODEL_LOCK : null;
  const fallbackLock = ttsProvider === "kokoro_local" ? QWEN_LOCAL_FALLBACK_LOCK : null;
  const defaultBrowserImageModel = isGoogleFlowPrimaryProvider(imageProvider)
    ? googleFlowModel
    : isFederatedWebImageProvider(imageProvider)
      ? "federated_google_web_image_pool"
    : imageProvider === "chatgpt_web_gpt_image" || isHybridWebFlowProvider(imageProvider)
      ? "chatgpt_web_gpt_image"
    : "flux-klein";
  return {
    planning_model: planningModel,
    planning_reasoning_effort: planningDefaultReasoningEffort,
    tts_model: genericTts
      ? primaryLock.model_id
      : externalNarrationProvider
        ? externalTtsPrimaryOptions.model_id
        : flags["tts-model"] ?? "qwen-tts",
    tts_model_revision: genericTts
      ? primaryLock.model_revision
      : externalNarrationProvider
        ? externalTtsPrimaryOptions.model_revision
        : null,
    tts_runtime: genericTts ? `${primaryLock.runtime}@${primaryLock.runtime_version}` : null,
    fallback_tts_model: fallbackLock?.model_id ?? null,
    fallback_tts_model_revision: fallbackLock?.model_revision ?? null,
    fallback_tts_runtime: fallbackLock
      ? `${fallbackLock.runtime}@${fallbackLock.runtime_version}`
      : null,
    local_whisper_model: localWhisperTimingContract.model,
    image_model: flags["image-model"] ?? process.env.ANIFACTORY_IMAGE_MODEL ?? defaultBrowserImageModel,
    reference_model: flags["reference-model"] ?? process.env.ANIFACTORY_REFERENCE_MODEL ?? process.env.ANIFACTORY_IMAGE_MODEL ?? defaultBrowserImageModel,
    image_provider_models: isFederatedWebImageProvider(imageProvider)
      ? federatedWebImageProviderModels({ flowModel: googleFlowModel, geminiModel: googleGeminiModel })
      : isHybridWebFlowProvider(imageProvider)
      ? hybridWebFlowProviderModels({ flowModel: googleFlowModel })
      : isGoogleFlowPrimaryProvider(imageProvider)
        ? googleFlowPrimaryProviderLocks(null, { flowModel: googleFlowModel }).image_provider_models
        : null,
    render_profile: renderProfile,
  };
}

function validateDirtyWorktreePolicy({ dirty, intent, allowDirty, reason }) {
  if (!dirty) return { allowed: true, waiver: null };
  const diagnosticIntent = ["diagnostic", "proof", "test"].includes(String(intent).toLowerCase());
  if (!diagnosticIntent || !allowDirty || !String(reason ?? "").trim()) {
    throw new Error("Production preflight requires a clean Git worktree. For an explicit diagnostic/proof only, pass --allow-dirty-worktree true --dirty-reason <reason>.");
  }
  return { allowed: true, waiver: String(reason).trim() };
}

function imageProviderOptions(provider) {
  if (isFederatedWebImageProvider(provider)) {
    return federatedWebImageIdentityOptions({
      chatGptProjectUrl,
      flowPlan: googleFlowPlan,
      flowModel: googleFlowModel,
      geminiPlan: googleGeminiPlan,
      geminiModel: googleGeminiModel,
      healthProof: googleFlowHealthProof,
      schedulingPolicy: googleImageScheduling,
    });
  }
  if (isGoogleFlowPrimaryProvider(provider)) {
    return googleFlowPrimaryIdentityOptions({
      flowPlan: googleFlowPlan,
      flowModel: googleFlowModel,
      healthProof: googleFlowHealthProof,
    });
  }
  if (isHybridWebFlowProvider(provider)) {
    return hybridWebFlowIdentityOptions({
      chatGptProjectUrl,
      flowPlan: googleFlowPlan,
      flowModel: googleFlowModel,
      healthProof: googleFlowHealthProof,
    });
  }
  const options = {};
  if (
    provider !== "hybrid_codex_opening_modelslab_rest"
    && provider !== "hybrid_codex_refs_opening_risky_modelslab_rest"
    && provider !== "hybrid_modelslab_refs_codex_opening_modelslab_rest"
  ) {
    // Non-hybrid providers may still carry an explicit conditional fallback.
  } else {
    const defaultOpeningSec = provider === "hybrid_modelslab_refs_codex_opening_modelslab_rest" ? 300 : 120;
    const value = Number(codexOpeningSecRaw ?? defaultOpeningSec);
    options.codex_opening_sec = Number.isFinite(value) && value > 0 ? value : defaultOpeningSec;
  }
  if (imageFallbackProvider) {
    options.fallback = {
      provider: imageFallbackProvider,
      condition: imageFallbackCondition,
      operator_approved: true,
      approval_source: "run_preflight_flags",
    };
  }
  if (provider === "chatgpt_web_gpt_image" && chatGptProjectUrl) {
    options.chatgpt_project_url = chatGptProjectUrl;
    options.chatgpt_project_cleanup_policy = CHATGPT_WEB_PROJECT_CLEANUP_POLICY;
  }
  return options;
}

function validateImageFallbackPolicy() {
  if (!imageFallbackProvider && imageFallbackCondition) {
    throw new Error("--image-fallback-condition requires --image-fallback-provider.");
  }
  if (!imageFallbackProvider) return;
  if (imageProvider !== "modelslab") {
    throw new Error("Conditional image fallback is supported only when the primary --image-provider is modelslab.");
  }
  if (imageFallbackProvider !== "codex_imagegen") {
    throw new Error("The guarded image fallback currently supports only --image-fallback-provider codex_imagegen.");
  }
  if (imageFallbackCondition !== MODELSLAB_CREDIT_EXHAUSTED) {
    throw new Error(`Codex fallback may trigger only on ${MODELSLAB_CREDIT_EXHAUSTED}.`);
  }
}

function voiceProviderOptions(narrationQualityContract) {
  if (ttsProvider !== "modelslab_qwen") {
    const options = defaultNarrationVoiceProviderOptions({
      provider: ttsProvider,
      fallbackProvider: ttsFallbackProvider,
      voiceId: narratorVoiceId,
      nativeSpeed: ttsNativeSpeed,
      referenceVariantId: narratorReferenceVariantId,
      narrationQualityContract,
      primaryOptions: externalTtsPrimaryOptions ?? {},
    });
    validateNarrationTtsPolicy(narrationTtsPolicyForIdentity({
      episode,
      tts_provider: ttsProvider,
      tts_fallback_provider: ttsFallbackProvider,
      narrator_voice_id: narratorVoiceId,
      provider_locks: {
        primary_reference_variant_id: narratorReferenceVariantId,
      },
      tts_native_speed: ttsNativeSpeed,
      voice_provider_options: options,
      narration_quality_contract: narrationQualityContract,
    }), { production: runIntent === "production" });
    return options;
  }
  return {
    qwen_narrator_voice_id: qwenNarratorVoiceId,
    qwen_narrator_voice_policy: qwenNarratorVoicePolicy,
    qwen_native_speed: qwenNativeSpeed,
    pace_strategy: "provider_native_speed_no_post_tempo",
  };
}

async function validateExternalNarrationVoiceAssets() {
  if (!externalNarrationProvider) return;
  const profile = externalTtsPrimaryOptions;
  const requiredAssets = [
    ["voice reference manifest", profile.reference_manifest_path, profile.reference_manifest_sha256],
    ["speaker-similarity model", profile.speaker_similarity_model_path, profile.speaker_similarity_model_sha256],
    ["speaker-similarity calibration", profile.speaker_similarity_calibration_path, profile.speaker_similarity_calibration_sha256],
  ];
  if (profile.reference_audio_path || profile.reference_audio_sha256) {
    requiredAssets.push([
      "voice reference audio",
      profile.reference_audio_path,
      profile.reference_audio_sha256,
    ]);
  }
  for (const [label, filePath, expectedSha256] of requiredAssets) {
    if (!filePath || !/^[a-f0-9]{64}$/iu.test(String(expectedSha256 ?? ""))) {
      throw new Error(`${label} requires an absolute path and a SHA-256 lock.`);
    }
    const actualSha256 = await sha256File(filePath).catch(() => null);
    if (!actualSha256 || actualSha256 !== expectedSha256) {
      throw new Error(
        `${label} is missing or stale: ${filePath}; expected ${expectedSha256}, found ${actualSha256 ?? "missing"}.`,
      );
    }
  }
  const referenceManifest = await readJsonWithBytes(
    profile.reference_manifest_path,
    "voice reference manifest",
  ).then((row) => row.value);
  const referenceRows = referenceManifest?.references
    ?? referenceManifest?.reference_variants
    ?? referenceManifest?.samples
    ?? [];
  const readyReferences = referenceRows.filter((row) => (
    row?.status === "ready" && (row?.wav_path || row?.audio_path)
  ));
  if (readyReferences.length < 3) {
    throw new Error(
      `Voice reference bank requires at least three ready samples; found ${readyReferences.length}.`,
    );
  }
  for (const reference of readyReferences) {
    const audioPath = path.resolve(reference.wav_path ?? reference.audio_path);
    const currentSha256 = await sha256File(audioPath).catch(() => null);
    const lockedSha256 = reference.wav_sha256
      ?? reference.audio_sha256
      ?? reference.sha256
      ?? null;
    if (!currentSha256 || (lockedSha256 && currentSha256 !== lockedSha256)) {
      throw new Error(
        `Voice reference bank sample is missing or stale: ${audioPath}.`,
      );
    }
  }
}

async function loadNarrationProviderPromotionBinding({
  provider,
  modelId,
  modelRevision,
  voiceId,
  voiceSha256,
  promotionPath,
  bakeoffManifestPath,
}) {
  if (!promotionPath) {
    throw new Error(
      `Production provider ${provider} requires --narration-provider-promotion <approved receipt>.`,
    );
  }
  const resolvedPromotionPath = path.resolve(promotionPath);
  const resolvedManifestPath = path.resolve(
    bakeoffManifestPath
      ?? path.join(path.dirname(resolvedPromotionPath), "narration_provider_bakeoff_manifest.json"),
  );
  const [promotionRead, manifestRead] = await Promise.all([
    readJsonWithBytes(resolvedPromotionPath, "narration provider promotion"),
    readJsonWithBytes(resolvedManifestPath, "narration provider bakeoff manifest"),
  ]);
  const manifestValidation = validateNarrationProviderBakeoffManifest(
    manifestRead.value,
  );
  if (manifestValidation.status !== "passed") {
    throw new Error(
      `Narration provider bakeoff manifest is blocked: ${manifestValidation.findings.map((row) => row.code).join(", ")}.`,
    );
  }
  const promotionValidation = validateNarrationProviderPromotion(
    promotionRead.value,
    manifestRead.value,
    { requiredProvider: provider },
  );
  if (promotionValidation.status !== "passed") {
    throw new Error(
      `Narration provider promotion is blocked: ${promotionValidation.findings.map((row) => row.code).join(", ")}.`,
    );
  }
  const expected = {
    promoted_provider: provider,
    promoted_model_id: modelId,
    promoted_model_revision: modelRevision,
    promoted_voice_id: voiceId,
    promoted_voice_sha256: voiceSha256,
  };
  const mismatches = Object.entries(expected)
    .filter(([, value]) => value != null)
    .filter(([key, value]) => promotionRead.value?.[key] !== value)
    .map(([key]) => key);
  if (mismatches.length) {
    throw new Error(
      `Narration provider promotion does not match preflight identity: ${mismatches.join(", ")}.`,
    );
  }
  return {
    schema: "goldflow_run_identity_narration_provider_promotion_binding_v1",
    promotion_path: resolvedPromotionPath,
    promotion_file_sha256: sha256(promotionRead.bytes),
    promotion_sha256: promotionRead.value.promotion_sha256,
    bakeoff_manifest_path: resolvedManifestPath,
    bakeoff_manifest_file_sha256: sha256(manifestRead.bytes),
    bakeoff_manifest_sha256: manifestRead.value.manifest_sha256,
    promoted_provider: promotionRead.value.promoted_provider,
    promoted_model_id: promotionRead.value.promoted_model_id,
    promoted_model_revision: promotionRead.value.promoted_model_revision,
    promoted_voice_id: promotionRead.value.promoted_voice_id,
    promoted_voice_sha256: promotionRead.value.promoted_voice_sha256,
    operator_reviewer: promotionRead.value.reviewer,
    reviewed_at: promotionRead.value.reviewed_at,
  };
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Run identity already exists. Preflight cannot overwrite or migrate an existing identity; resume its recorded workflow or choose a new explicit run identity.");
    }
    throw error;
  }
}

async function assertNewIdentityPath(filePath) {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Run identity already exists. Preflight cannot overwrite or migrate an existing identity; resume its recorded workflow or choose a new explicit run identity.");
}

async function readJsonWithBytes(filePath, label) {
  const bytes = await fs.readFile(filePath).catch(() => null);
  if (!bytes) throw new Error(`Missing ${label}: ${filePath}`);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { bytes, value };
}

function resolveReleaseArtifactPath(releaseFilePath, value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Winner source release is missing ${label}.`);
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(path.dirname(releaseFilePath), text);
}

async function loadWinnerSourceReleaseBinding(releaseFilePath, {
  expectedChannel,
  expectedTitle,
  expectedSourcePath,
}) {
  if (!expectedSourcePath) {
    throw new Error("--winner-release requires --source so preflight can bind the exact released narration bytes.");
  }
  if (!String(expectedTitle ?? "").trim()) {
    throw new Error("--winner-release requires --title matching the approved winner package.");
  }
  const resolvedReleasePath = path.resolve(releaseFilePath);
  const { bytes: releaseBytes, value: release } = await readJsonWithBytes(
    resolvedReleasePath,
    "winner source release",
  );
  const releaseSourcePath = resolveReleaseArtifactPath(
    resolvedReleasePath,
    release.source_path,
    "source_path",
  );
  const winnerPackagePath = resolveReleaseArtifactPath(
    resolvedReleasePath,
    release.winner_package_path ?? release.package_path,
    "winner_package_path",
  );
  const releaseSourceBytes = await fs.readFile(releaseSourcePath).catch(() => null);
  if (!releaseSourceBytes) throw new Error(`Missing winner release source: ${releaseSourcePath}`);
  const requestedSourceBytes = await fs.readFile(expectedSourcePath).catch(() => null);
  if (!requestedSourceBytes) throw new Error(`Missing preflight source: ${expectedSourcePath}`);
  const { bytes: packageBytes, value: packageContract } = await readJsonWithBytes(
    winnerPackagePath,
    "winner package",
  );
  const packageValidation = validateWinnerPackageContract(packageContract);
  if (!packageValidation.done) {
    throw new Error(`Invalid winner package contract: ${packageValidation.blockers.join(", ")}`);
  }
  const releaseValidation = validateWinnerSourceRelease(release, {
    sourceText: releaseSourceBytes.toString("utf8"),
    packageContract,
  });
  if (!releaseValidation.done) {
    throw new Error(`Invalid winner source release: ${releaseValidation.blockers.join(", ")}`);
  }
  const actualPackageSha256 = sha256(packageBytes);
  if (release.winner_package_sha256 !== actualPackageSha256) {
    throw new Error(`Winner package hash mismatch: release records ${release.winner_package_sha256}, current file is ${actualPackageSha256}.`);
  }
  let winnerStoryBlueprintPath = null;
  let winnerStoryBlueprintSha256 = null;
  let winnerStoryBlueprintApprovalPath = null;
  let winnerStoryBlueprintDocument = null;
  if (release.winner_story_blueprint_sha256) {
    winnerStoryBlueprintPath = resolveReleaseArtifactPath(
      resolvedReleasePath,
      release.winner_story_blueprint_path,
      "winner_story_blueprint_path",
    );
    winnerStoryBlueprintApprovalPath = resolveReleaseArtifactPath(
      resolvedReleasePath,
      release.winner_story_blueprint_approval_path,
      "winner_story_blueprint_approval_path",
    );
    const { bytes: blueprintBytes, value: blueprintDocument } = await readJsonWithBytes(
      winnerStoryBlueprintPath,
      "winner story blueprint",
    );
    winnerStoryBlueprintSha256 = sha256(blueprintBytes);
    winnerStoryBlueprintDocument = blueprintDocument;
    if (winnerStoryBlueprintSha256 !== release.winner_story_blueprint_sha256) {
      throw new Error(`Winner story blueprint hash mismatch: release records ${release.winner_story_blueprint_sha256}, current file is ${winnerStoryBlueprintSha256}.`);
    }
    const blueprintValidation = validateWinnerBlueprintForPackage(blueprintDocument, {
      packageContract,
      packageSha256: actualPackageSha256,
    });
    if (!blueprintValidation.done) {
      throw new Error(`Invalid winner story blueprint: ${blueprintValidation.blockers.join(", ")}`);
    }
    const { value: blueprintApproval } = await readJsonWithBytes(
      winnerStoryBlueprintApprovalPath,
      "winner story blueprint approval",
    );
    const blueprintApprovalValidation = validateWinnerStoryBlueprintApproval(blueprintApproval, {
      blueprintSha256: winnerStoryBlueprintSha256,
    });
    if (!blueprintApprovalValidation.done || blueprintApproval.winner_package_sha256 !== actualPackageSha256) {
      throw new Error(`Invalid winner story blueprint approval: ${blueprintApprovalValidation.blockers.join(", ") || "winner_blueprint_approval_package_hash_mismatch"}`);
    }
  }
  const requestedSourceScriptSha256 = sha256Text(normalizeWinnerNarration(requestedSourceBytes.toString("utf8")));
  if (requestedSourceScriptSha256 !== release.source_script_sha256) {
    throw new Error(`--source does not match the released narration: expected ${release.source_script_sha256}, found ${requestedSourceScriptSha256}.`);
  }
  if (release.channel !== expectedChannel || packageContract.channel !== expectedChannel) {
    throw new Error(`Winner release channel mismatch: expected ${expectedChannel}, release has ${release.channel}, package has ${packageContract.channel}.`);
  }
  if (release.selected_title !== expectedTitle || packageContract.selected_title !== expectedTitle) {
    throw new Error(`--title does not match the approved winner package: expected "${packageContract.selected_title}", received "${expectedTitle}".`);
  }
  if (release.development_slug !== packageContract.development_slug) {
    throw new Error("Winner release development_slug does not match the current winner package.");
  }
  if (release.selected_candidate_id && release.selected_candidate_id !== packageContract.selected_candidate_id) {
    throw new Error("Winner release selected_candidate_id does not match the current winner package.");
  }
  if (release.formula_version && release.formula_version !== packageContract.formula_version) {
    throw new Error("Winner release formula_version does not match the current winner package.");
  }
  if (release.formula_sha256 && release.formula_sha256 !== packageContract.formula_sha256) {
    throw new Error("Winner release formula_sha256 does not match the current winner package.");
  }
  const sourceRoomLineage = await loadWinnerSourceRoomLineage({
    release,
    releasePath: resolvedReleasePath,
    packageContract,
    packageSha256: actualPackageSha256,
    blueprintDocument: winnerStoryBlueprintDocument,
    blueprintPath: winnerStoryBlueprintPath,
    blueprintSha256: winnerStoryBlueprintSha256,
    releasedSourceScriptSha256: release.source_script_sha256,
  });
  return {
    schema: "goldflow_run_identity_winner_source_release_binding_v1",
    release_path: resolvedReleasePath,
    release_sha256: sha256(releaseBytes),
    channel: release.channel,
    development_slug: release.development_slug,
    selected_candidate_id: packageContract.selected_candidate_id,
    selected_title: release.selected_title,
    source_path: releaseSourcePath,
    source_file_sha256: sha256(releaseSourceBytes),
    source_script_sha256: release.source_script_sha256,
    preflight_source_path: path.resolve(expectedSourcePath),
    preflight_source_file_sha256: sha256(requestedSourceBytes),
    winner_package_path: winnerPackagePath,
    winner_package_sha256: actualPackageSha256,
    winner_story_blueprint_path: winnerStoryBlueprintPath,
    winner_story_blueprint_sha256: winnerStoryBlueprintSha256,
    winner_story_blueprint_approval_path: winnerStoryBlueprintApprovalPath,
    ...(sourceRoomLineage ?? {}),
    winner_gate_sha256: release.winner_gate_sha256,
    formula_version: packageContract.formula_version,
    formula_sha256: packageContract.formula_sha256,
    released_by: release.released_by,
    released_at: release.released_at,
    bound_at: new Date().toISOString(),
  };
}

function requiredFlag(name, value) {
  if (!value) throw new Error(`Missing required --${name}. Run identity must be explicit before ingest.`);
}

function episodeNumber(value) {
  const match = /^ep_(\d{2,3})$/.exec(String(value ?? ""));
  return match ? Number(match[1]) : null;
}

function impliedEpisodeNumber(value) {
  const text = String(value ?? "").toLowerCase();
  if (/\b(?:part|episode|ep)\s*(?:two|2|ii)\b/.test(text)) return 2;
  if (/\b(?:part|episode|ep)\s*(?:three|3|iii)\b/.test(text)) return 3;
  if (/\b(?:part|episode|ep)\s*(?:four|4|iv)\b/.test(text)) return 4;
  if (/\b(?:part|episode|ep)\s*(?:five|5|v)\b/.test(text)) return 5;
  return null;
}

async function main() {
  requiredFlag("channel", channel);
  requiredFlag("series", series);
  requiredFlag("week", week);
  requiredFlag("episode", episode);
  const epNumber = episodeNumber(episode);
  if (!epNumber) throw new Error(`Invalid --episode ${episode}. Use ep_01, ep_02, etc.; episode number belongs in --episode.`);
  const titleEpisode = impliedEpisodeNumber(title);
  const weekEpisode = impliedEpisodeNumber(week);
  const seriesEpisode = impliedEpisodeNumber(series);
  const implied = titleEpisode ?? weekEpisode ?? seriesEpisode;
  if (weekEpisode && !allowPartInWeek) {
    throw new Error(`Run slug "${week}" looks like it contains an episode/part number. Put sequels in --episode ep_02/ep_03 and keep --week as the stable run slug. Use --allow-part-in-week true only for an explicitly approved standalone run.`);
  }
  if (implied && implied !== epNumber && !confirmEpisodeIdentity) {
    throw new Error(`Episode identity mismatch: title/series/week implies episode ${implied}, but --episode is ${episode}. Use ep_${String(implied).padStart(2, "0")} or pass --confirm-episode-identity true with operator approval.`);
  }
  if (sourcePath && !(await exists(sourcePath))) throw new Error(`Missing source file: ${sourcePath}`);
  if (proofSourceComplete && runIntent !== "proof") {
    throw new Error("--proof-source-complete is valid only with --run-intent proof.");
  }
  if (proofSourceComplete && !sourcePath) {
    throw new Error("A standalone bounded proof requires --source <proof narration> with --proof-source-complete true.");
  }
  if (contentProfileRequiresEvidenceLedger(contentProfile) && !factualEvidenceLedgerPath) {
    throw new Error(`Content profile ${contentProfile.id} requires --evidence-ledger <factual-evidence.json>.`);
  }
  let factualEvidence = null;
  if (factualEvidenceLedgerPath) {
    const evidenceBytes = await fs.readFile(factualEvidenceLedgerPath).catch(() => null);
    if (!evidenceBytes) throw new Error(`Missing factual evidence ledger: ${factualEvidenceLedgerPath}`);
    let evidenceLedger;
    try {
      evidenceLedger = JSON.parse(evidenceBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Invalid factual evidence ledger JSON at ${factualEvidenceLedgerPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    factualEvidence = factualEvidenceBinding(
      evidenceLedger,
      evidenceBytes,
      factualEvidenceLedgerPath,
      { expectedProfileId: contentProfile.id },
    );
    if (title && factualEvidence.title !== title) {
      throw new Error(`Factual evidence title mismatch: preflight title is "${title}", ledger title is "${factualEvidence.title}".`);
    }
  }
  let winnerSourceRelease = null;
  if (winnerReleasePath) {
    const { value: releaseDocument } = await readJsonWithBytes(winnerReleasePath, "winner source release");
    winnerSourceRelease = releaseDocument?.schema === SOURCE_ROOM_RELEASE_V2_SCHEMA
      ? await loadSourceRoomReleaseV2Binding(winnerReleasePath, {
          expectedChannel: channel,
          expectedTitle: title,
          expectedSourcePath: sourcePath,
        })
      : await loadWinnerSourceReleaseBinding(winnerReleasePath, {
          expectedChannel: channel,
          expectedTitle: title,
          expectedSourcePath: sourcePath,
        });
  }
  validateImageFallbackPolicy();
  await validateExternalNarrationVoiceAssets();
  const narrationProviderPromotion = externalNarrationProvider
    && runIntent === "production"
    ? await loadNarrationProviderPromotionBinding({
        provider: ttsProvider,
        modelId: externalTtsPrimaryOptions.model_id,
        modelRevision: externalTtsPrimaryOptions.model_revision,
        voiceId: narratorVoiceId,
        voiceSha256: narratorVoiceSha256,
        promotionPath: flags["narration-provider-promotion"],
        bakeoffManifestPath: flags["narration-provider-bakeoff-manifest"],
      })
    : null;
  const git = await gitSnapshot();
  validateDirtyWorktreePolicy({ dirty: git.dirty, intent: runIntent, allowDirty: allowDirtyWorktree, reason: dirtyReason });
  const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
  const now = new Date().toISOString();
  const narrationQualityContract = buildNarrationQualityContract({
    provider: ttsProvider,
    modelId: lockedModelVersions().tts_model,
    modelRevision: lockedModelVersions().tts_model_revision,
    deliveryQaPolicy: productionProfileConfig.audio?.narration_delivery_qa ?? null,
  });
  const resolvedImageProviderOptions = imageProviderOptions(imageProvider);
  const resolvedVoiceProviderOptions = voiceProviderOptions(
    narrationQualityContract,
  );
  const narrationDeliveryBank = ttsProvider === "qwen_local"
    ? await loadNarrationDeliveryReferenceBank(
      flags["narration-delivery-bank"] ?? DEFAULT_NARRATION_DELIVERY_BANK_PATH,
    )
    : null;
  if (narrationDeliveryBank?.validation.status === "blocked") {
    throw new Error(`Narration delivery reference bank is blocked: ${narrationDeliveryBank.validation.findings.map((row) => row.code).join(", ")}`);
  }
  if (narrationDeliveryBank) {
    const binding = validateNarrationDeliveryBankPrimaryBinding(
      narrationDeliveryBank.document,
      resolvedVoiceProviderOptions.primary,
    );
    if (binding.status !== "passed") {
      throw new Error(`Narration delivery bank does not match the identity-locked primary reference: ${binding.findings.map((row) => row.code).join(", ")}`);
    }
  }
  if (narrationProviderPromotion) {
    resolvedVoiceProviderOptions.provider_promotion = narrationProviderPromotion;
  }
  if (narrationDeliveryBank) {
    resolvedVoiceProviderOptions.delivery_reference_bank = {
      path: narrationDeliveryBank.path,
      sha256: narrationDeliveryBank.sha256,
      schema: narrationDeliveryBank.document.schema,
      default_delivery_id: narrationDeliveryBank.document.default_delivery_id,
      production_active_delivery_ids: narrationDeliveryBank.document.production_active_delivery_ids,
      unpromoted_fallback: narrationDeliveryBank.document.promotion_policy.unpromoted_fallback,
    };
    resolvedVoiceProviderOptions.primary.delivery_reference_bank_path = narrationDeliveryBank.path;
    resolvedVoiceProviderOptions.primary.delivery_reference_bank_sha256 = narrationDeliveryBank.sha256;
  }
  const narrationUnitContract = narrationUnitContractForQuality(
    narrationQualityContract,
  );
  const narrationStitchContract = narrationStitchContractForQuality(
    narrationQualityContract,
  );
  const planningRoom = planningProvider === PLANNING_ROOM_PROVIDER
    ? planningRoomContract({
        planning_provider: planningProvider,
        production_profile_config: productionProfileConfig,
        planning_room: {
          provider_models: Object.fromEntries(
            Object.keys(PLANNER_PROVIDER_REGISTRY).map((provider) => [
              provider,
              plannerModelForProvider(provider, {}, process.env),
            ]),
          ),
        },
      })
    : null;
  if (planningRoom) {
    planningRoom.provider_models = Object.fromEntries(
      Object.keys(PLANNER_PROVIDER_REGISTRY).map((provider) => [
        provider,
        plannerModelForProvider(provider, { planning_room: planningRoom }, process.env),
      ]),
    );
  }
  const manifest = {
    schema: "goldflow_run_identity_v2",
    stage_registry_version: PIPELINE_STAGE_REGISTRY_VERSION,
    ...mediaWorkflowBinding,
    status: "preflight_passed_pending_ingest",
    channel,
    series_slug: series,
    week,
    episode,
    episode_number: epNumber,
    title,
    planning_provider: planningProvider,
    planning_effort_policy: planningEffortPolicy,
    planning_room: planningRoom,
    chatgpt_web_project: chatGptProjectUrl ? {
      url: chatGptProjectUrl,
      scope: "planning_and_images",
      cleanup_policy: CHATGPT_WEB_PROJECT_CLEANUP_POLICY,
    } : null,
    image_provider: imageProvider,
    image_provider_options: resolvedImageProviderOptions,
    voice_provider_options: resolvedVoiceProviderOptions,
    narration_quality_contract: narrationQualityContract,
    narration_delivery_reference_bank: narrationDeliveryBank ? {
      path: narrationDeliveryBank.path,
      sha256: narrationDeliveryBank.sha256,
      schema: narrationDeliveryBank.document.schema,
      default_delivery_id: narrationDeliveryBank.document.default_delivery_id,
      production_active_delivery_ids: narrationDeliveryBank.document.production_active_delivery_ids,
    } : null,
    narration_provider_promotion: narrationProviderPromotion,
    ...(ttsProvider !== "modelslab_qwen" ? {
      tts_provider: ttsProvider,
      tts_fallback_provider: ttsFallbackProvider,
      narrator_voice_id: narratorVoiceId,
      tts_voice_id: narratorVoiceId,
      tts_native_speed: ttsNativeSpeed,
    } : {
      qwen_narrator_voice_id: qwenNarratorVoiceId,
      qwen_narrator_voice_policy: qwenNarratorVoicePolicy,
      qwen_native_speed: qwenNativeSpeed,
    }),
    audio_target: audioTarget,
    content_profile: contentProfile.id,
    content_profile_version: contentProfile.version,
    content_profile_path: contentProfileDefinitionValue.path,
    content_profile_sha256: contentProfileDefinitionValue.sha256,
    content_profile_config: contentProfile,
    factual_evidence: factualEvidence,
    production_profile: productionProfile,
    production_profile_config: productionProfileConfig,
    approval_control: {
      mode: productionProfileConfig.orchestration?.approval_policy?.mode ?? "profile_default",
      human_checkpoints: humanCheckpoints,
      human_checkpoint_flag: "human-checkpoints",
    },
    pace_policy: pacePolicy,
    target_wpm_min: targetWpmMin,
    target_wpm_max: targetWpmMax,
    target_wpm_midpoint: Number(((targetWpmMin + targetWpmMax) / 2).toFixed(3)),
    pace_targets: {
      target_wpm_min: targetWpmMin,
      target_wpm_max: targetWpmMax,
      target_wpm_midpoint: Number(((targetWpmMin + targetWpmMax) / 2).toFixed(3)),
    },
    render_profile: renderProfile,
    motion_policy: motionPolicy,
    animation_policy: generatedMotionPolicy,
    generated_motion_policy: generatedMotionPolicy,
    generated_motion_provider: generatedMotionProvider,
    generated_motion_model: generatedMotionModel,
    generated_motion_required_through_sec: generatedMotionRequiredThroughSec,
    visual_beat_timing_contract: visualBeatTimingContract,
    ltx_video_policy: ltxVideoPolicy,
    ltx_video_provider: generatedMotionProvider === GENERATED_MOTION_PROVIDER_LTX ? LTX_VIDEO_PROVIDER : null,
    ltx_video_model: generatedMotionProvider === GENERATED_MOTION_PROVIDER_LTX ? LTX_VIDEO_MODEL_ID : null,
    parallax_policy: parallaxPolicy,
    parallax_target_max: parallaxTargetMax,
    parallax_min_spacing_sec: parallaxMinSpacingSec,
    parallax_opening_window_sec: parallaxOpeningWindowSec,
    parallax_first_window_sec: parallaxFirstWindowSec,
    parallax_first_window_target: parallaxFirstWindowTarget,
    parallax_retention_window_target: parallaxRetentionWindowTarget,
    parallax_background_provider: parallaxBackgroundProvider,
    image_output_qa_required: true,
    visual_prompt_review_policy: "blockers_only_after_harden",
    run_intent: runIntent,
    proof_scope: proofScope,
    proof_source_mode: proofSourceComplete ? "standalone_bounded_source" : "audited_baseline_or_full_source",
    git,
    dirty_worktree_waiver: git.dirty ? {
      allowed: true,
      reason: dirtyReason,
      intent: runIntent,
      recorded_at: now,
    } : null,
    provider_locks: {
      planning_provider: planningProvider,
      planning_model: planningModel,
      planning_provider_models: planningRoom?.provider_models ?? null,
      planning_room: planningRoom,
      planning_effort_policy: planningEffortPolicy,
      planning_default_reasoning_effort: planningDefaultReasoningEffort,
      chatgpt_web_project_url: chatGptProjectUrl,
      content_profile: contentProfile.id,
      content_profile_version: contentProfile.version,
      content_profile_sha256: contentProfileDefinitionValue.sha256,
      image_provider: imageProvider,
      image_model: lockedModelVersions().image_model,
      reference_model: lockedModelVersions().reference_model,
      ...(isFederatedWebImageProvider(imageProvider)
        ? federatedWebImageProviderLocks(resolvedImageProviderOptions, {
            flowModel: googleFlowModel,
            geminiModel: googleGeminiModel,
          })
        : isHybridWebFlowProvider(imageProvider)
        ? hybridWebFlowProviderLocks(resolvedImageProviderOptions, { flowModel: googleFlowModel })
        : isGoogleFlowPrimaryProvider(imageProvider)
          ? googleFlowPrimaryProviderLocks(resolvedImageProviderOptions, { flowModel: googleFlowModel })
        : {}),
      image_fallback_provider: imageFallbackProvider,
      image_fallback_condition: imageFallbackCondition,
      parallax_background_provider: parallaxBackgroundProvider,
      generated_motion_provider: generatedMotionProvider,
      generated_motion_model: generatedMotionModel,
      generated_motion_required_through_sec: generatedMotionRequiredThroughSec,
      visual_beat_timing_contract: visualBeatTimingContract,
      generated_motion_candidates_per_moment: generatedMotionPolicy === "disabled" ? 0 : 1,
      generated_motion_automatic_retries: 0,
      generated_motion_failure_disposition: "accepted_still_fallback",
      ltx_video_provider: generatedMotionProvider === GENERATED_MOTION_PROVIDER_LTX ? LTX_VIDEO_PROVIDER : null,
      ltx_video_model: generatedMotionProvider === GENERATED_MOTION_PROVIDER_LTX ? LTX_VIDEO_MODEL_ID : null,
      audio_target: audioTarget,
      local_whisper_timing: structuredClone(localWhisperTimingContract),
      tts_provider: ttsProvider,
      tts_fallback_provider: ttsFallbackProvider,
      narrator_voice_id: ttsProvider !== "modelslab_qwen" ? narratorVoiceId : qwenNarratorVoiceId,
      tts_native_speed: ttsProvider !== "modelslab_qwen" ? ttsNativeSpeed : qwenNativeSpeed,
      tts_speed_control: ttsProvider === "qwen_local"
        ? "unsupported"
        : ttsNativeSpeed == null ? "unused" : "provider_native",
      tts_model: lockedModelVersions().tts_model,
      tts_model_revision: lockedModelVersions().tts_model_revision,
      fallback_tts_model: lockedModelVersions().fallback_tts_model,
      fallback_tts_model_revision: lockedModelVersions().fallback_tts_model_revision,
      narrator_voice_identity: ttsProvider !== "modelslab_qwen" ? narratorVoiceId : qwenNarratorVoiceId,
      primary_reference_variant_id: ttsProvider === "qwen_local" ? narratorReferenceVariantId : null,
      primary_reference_audio_sha256:
        resolvedVoiceProviderOptions.primary?.reference_audio_sha256 ?? null,
      primary_reference_manifest_sha256:
        resolvedVoiceProviderOptions.primary?.reference_manifest_sha256 ?? null,
      primary_reference_metadata_sha256:
        resolvedVoiceProviderOptions.primary?.reference_metadata_sha256 ?? null,
      primary_voice_sha256:
        resolvedVoiceProviderOptions.primary?.voice_sha256 ?? null,
      primary_similarity_model_sha256:
        resolvedVoiceProviderOptions.primary?.speaker_similarity_model_sha256
          ?? null,
      primary_similarity_calibration_sha256:
        resolvedVoiceProviderOptions.primary
          ?.speaker_similarity_calibration_sha256 ?? null,
      primary_minimum_cosine_similarity: null,
      primary_warning_below_cosine_similarity: null,
      primary_similarity_threshold_source:
        narrationQualityContract.voice_identity_qa.threshold_source,
      primary_universal_similarity_threshold_forbidden: true,
      primary_reference_bank_centroid_required: true,
      primary_reference_bank_minimum_count:
        narrationQualityContract.voice_identity_qa.minimum_reference_count,
      primary_unit_outliers_review_required: true,
      primary_aggregate_drift_report_required: true,
      primary_voice_continuity_contract:
        resolvedVoiceProviderOptions.primary?.voice_continuity_contract ?? null,
      narration_provider_promotion_sha256:
        narrationProviderPromotion?.promotion_sha256 ?? null,
      narration_provider_bakeoff_manifest_sha256:
        narrationProviderPromotion?.bakeoff_manifest_sha256 ?? null,
      narration_quality_contract_version: narrationQualityContract.version,
      narration_quality_contract_sha256: narrationQualityContract.contract_sha256,
      narration_text_ir_schema: narrationQualityContract.text_ir.schema,
      narration_edge_editing_mode: "alignment_safe_preserve_on_missing_alignment",
      narration_boundary_policy: "semantic_boundary_classes_v2",
      narration_final_delivery_gate: "strict_transcript_edges_joins_order_v2",
      tts_unit_target_words_min: narrationUnitContract.target_words_min,
      tts_unit_target_words_max: narrationUnitContract.target_words_max,
      tts_unit_soft_words_max: narrationUnitContract.soft_words_max,
      tts_unit_hard_words_max: narrationUnitContract.hard_words_max,
      tts_sentence_complete_units: narrationUnitContract.sentence_complete,
      tts_continuous_requests: narrationUnitContract.continuous_requests,
      tts_stitch_contract_version: narrationStitchContract.contract_version,
      tts_semantic_boundary_classes: narrationStitchContract.semantic_boundary_classes,
      tts_join_silence_ms: null,
      tts_alignment_required_for_trimming: ttsProvider === "qwen_local" ? narrationStitchContract.alignment_required_for_trimming : null,
      tts_missing_alignment_policy: ttsProvider === "qwen_local" ? narrationStitchContract.missing_alignment_policy : null,
      tts_exact_sample_accounting_required: ttsProvider === "qwen_local" ? narrationStitchContract.exact_sample_accounting_required : null,
      post_tempo_processing: false,
      tts_retry_policy: ttsProvider === "qwen_local"
        ? QWEN_JOEL_PRIMARY_LOCK.retry_contract.retry_policy
        : null,
      tts_automatic_asr_retry: ttsProvider === "qwen_local"
        ? QWEN_JOEL_PRIMARY_LOCK.retry_contract.automatic_asr_retry
        : null,
      tts_confirmed_defect_types: ttsProvider === "qwen_local"
        ? [...QWEN_JOEL_PRIMARY_LOCK.retry_contract.confirmed_defect_types]
        : null,
      tts_synthesis_contract_id: ttsProvider === "qwen_local"
        ? QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.contract_id
        : null,
      tts_synthesis_mode: ttsProvider === "qwen_local"
        ? QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode
        : null,
      tts_synthesis_api: ttsProvider === "qwen_local"
        ? QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.api
        : null,
      tts_model_instance_count: ttsProvider === "qwen_local"
        ? QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.resident_model_count
        : null,
      tts_model_concurrency: ttsProvider === "qwen_local"
        ? QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.model_concurrency
        : null,
      tts_nominal_batch_size: ttsProvider === "qwen_local"
        ? QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.nominal_batch_size
        : null,
      tts_batch_scheduler_version: ttsProvider === "qwen_local"
        ? QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.scheduler_version
        : null,
      tts_token_limit_acceptance_allowed: ttsProvider === "qwen_local"
        ? QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.token_limit_acceptance_allowed
        : null,
      tts_objective_recovery_mode: ttsProvider === "qwen_local"
        ? QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.objective_recovery_mode
        : null,
      fallback_voice_identity: ttsProvider === "kokoro_local" ? QWEN_LOCAL_FALLBACK_LOCK.reference_voice_id : null,
      fallback_reference_audio_sha256: ttsProvider === "kokoro_local" ? QWEN_LOCAL_FALLBACK_LOCK.reference_audio_sha256 : null,
      fallback_reference_metadata_sha256: ttsProvider === "kokoro_local" ? QWEN_LOCAL_FALLBACK_LOCK.reference_metadata_sha256 : null,
      fallback_similarity_model_sha256: ttsProvider === "kokoro_local" ? QWEN_LOCAL_FALLBACK_LOCK.speaker_similarity_model_sha256 : null,
      fallback_similarity_calibration_sha256: ttsProvider === "kokoro_local" ? QWEN_LOCAL_FALLBACK_LOCK.speaker_similarity_calibration_sha256 : null,
      fallback_minimum_cosine_similarity: ttsProvider === "kokoro_local" ? QWEN_LOCAL_FALLBACK_LOCK.minimum_cosine_similarity : null,
      fallback_warning_below_cosine_similarity: ttsProvider === "kokoro_local" ? QWEN_LOCAL_FALLBACK_LOCK.warning_below_cosine_similarity : null,
      qwen_narrator_voice_id: ttsProvider === "modelslab_qwen" ? qwenNarratorVoiceId : null,
      production_profile: productionProfile,
    },
    model_versions: lockedModelVersions(),
    source_path: sourcePath,
    source_sha256: sourcePath ? sha256(await fs.readFile(sourcePath)) : null,
    winner_source_release: winnerSourceRelease,
    episode_identity_policy: {
      episode_number_lives_in: "--episode",
      week_slug_policy: "Do not encode Part 2/Part 3 in --week for sequel episodes unless the operator explicitly approves a standalone run.",
      sequel_rule: "Part 2 implies ep_02 by default; Part 3 implies ep_03 by default.",
    },
    production_gates: {
      planning_provider_identity_lock_required: true,
      planning_effort_policy_identity_lock_required: true,
      chatgpt_web_local_tools_required: false,
      deterministic_local_validation_after_web_planning_required: ["chatgpt_web", PLANNING_ROOM_PROVIDER].includes(planningProvider),
      script_hash_approval_required_before_downstream: true,
      factual_evidence_required: contentProfileRequiresEvidenceLedger(contentProfile),
      whisper_timing_required_before_sfx_score_visual_beats_and_render: true,
      local_whisper_contract_required: true,
      longform_mix_required_for_production_render: true,
      proof_renders_must_be_labeled_and_must_not_replace_final_render: true,
      provider_native_tts_speed_required: ttsProvider !== "qwen_local",
      tts_speed_control_supported: ttsProvider !== "qwen_local",
      post_tempo_normalization_default: false,
      single_narrator_identity_required: ttsProvider !== "modelslab_qwen",
      fallback_must_clone_primary_voice_identity: ttsProvider === "kokoro_local",
      sentence_complete_tts_units_required: ttsProvider === "qwen_local",
      tts_spoken_text_audit_required: ttsProvider === "qwen_local",
      narration_text_ir_required: true,
      narration_exact_transformation_ledger_required: true,
      narration_alignment_required_for_edge_trimming: true,
      narration_amplitude_only_edge_trimming_forbidden: true,
      narration_strict_final_stream_delivery_qa_required: true,
      tts_unit_hard_words_max: ttsProvider === "qwen_local"
        ? narrationUnitContract.hard_words_max
        : null,
      tts_unit_soft_words_max: ttsProvider === "qwen_local"
        ? narrationUnitContract.soft_words_max
        : null,
      tts_join_silence_ms: null,
      tts_stitch_contract_version: ttsProvider === "qwen_local"
        ? narrationStitchContract.contract_version
        : null,
      tts_semantic_boundary_classes_required: ttsProvider === "qwen_local",
      tts_exact_sample_accounting_required: ttsProvider === "qwen_local",
      continuous_longform_tts_requests_forbidden: ttsProvider === "qwen_local",
      deterministic_length_matched_tts_batching_required:
        ttsProvider === "qwen_local",
      tts_nominal_batch_size: ttsProvider === "qwen_local"
        ? QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.nominal_batch_size
        : null,
      tts_single_resident_model_required: ttsProvider === "qwen_local",
      tts_token_limit_outputs_forbidden: ttsProvider === "qwen_local",
      tts_objective_recovery_exact_unit_only: ttsProvider === "qwen_local",
      image_output_qa_required_before_render: true,
      directed_motion_plan_required_before_render: true,
      inspected_parallax_decision_required_before_motion: parallaxPolicy === "selective_inspected",
      animation_direction_required_after_image_qa: generatedMotionPolicy !== "disabled",
      generated_video_approval_required_before_motion: generatedMotionPolicy !== "disabled",
      automatic_stage_spend_authorized_by_profile: productionProfileConfig.advance.authorize_planner_spend
        && productionProfileConfig.advance.authorize_media_spend
        && productionProfileConfig.advance.authorize_render,
    },
    stage_checklist: stageChecklistFor({
      ...mediaWorkflowBinding,
      content_profile: contentProfile.id,
      content_profile_config: contentProfile,
      audio_target: audioTarget,
      parallax_policy: parallaxPolicy,
      generated_motion_policy: generatedMotionPolicy,
      generated_motion_provider: generatedMotionProvider,
    }),
    episode_dir: episodeDir,
    updated_at: now,
  };
  assertAvailableMediaWorkflow(manifest);
  const localWhisperIdentityValidation =
    validateLocalWhisperIdentityContract(manifest);
  if (!localWhisperIdentityValidation.done) {
    throw new Error(localWhisperIdentityValidation.evidence);
  }
  const manifestPath = path.join(episodeDir, "run_identity.json");
  await writeJson(manifestPath, manifest);
  console.log(JSON.stringify({ status: "passed", run_identity_path: manifestPath, episode_dir: episodeDir, next_required_stage: "ingest source" }, null, 2));
}

if (invokedAsCommand) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  normalizeRunIntent as normalizeRunIntentForTests,
  parseProofScope as parseProofScopeForTests,
  validateDirtyWorktreePolicy,
};
