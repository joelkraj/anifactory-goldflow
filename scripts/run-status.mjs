#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PIPELINE_STAGE_REGISTRY_VERSION,
  stageRegistryFor,
  buildStageCommand,
  readyStageIds,
  stageDefinition,
  stageIsSatisfied,
} from "./lib/pipeline-stage-registry.mjs";
import { assertCommandWorkflowRoute, assertEpisodeWorkflowFlags, readEpisodeRoutingIdentity } from "./lib/episode-workflow-routing.mjs";
import { referencePlanApprovalMatches } from "./lib/reference-plan-contract.mjs";
import { readReferenceImageQaRecoveryScope } from "./lib/reference-image-recovery.mjs";
import {
  parallaxApprovalMatches,
  parallaxAssetContractSha256,
} from "./lib/parallax-contract.mjs";
import {
  codexCreditFallbackEnabled,
  creditExhaustedIdsFromReport,
  creditExhaustedIdsFromRows,
} from "./lib/image-fallback-policy.mjs";
import { normalizeImageProvider } from "./lib/image-provider-routing.mjs";
import { openartRestartBaselineState } from "./lib/openart-visual-restart.mjs";
import { falRestartBaselineState } from "./lib/fal-visual-restart.mjs";
import {
  federatedWebImageIdentityStatus,
  googleFlowPrimaryIdentityStatus,
  hybridWebFlowIdentityStatus,
  isBrowserPoolImageProvider,
  isFederatedWebImageProvider,
  isGoogleFlowPrimaryProvider,
} from "./lib/image-provider-policy.mjs";
import { findSourceCompatibleHybridDeadletters } from "./hybrid-browser-image-pool.mjs";
import { sha256File as streamSha256File } from "./lib/file-hash.mjs";
import { loadNarrationSourceStructure } from "./lib/narration-source-structure.mjs";
import { loadLowMarginDisposition } from "./lib/narration-low-margin-disposition.mjs";
import { validateAppliedFullStreamManualReview } from "./lib/narration-full-stream-manual-review.mjs";
import {
  EXTERNAL_NARRATION_TTS_PROVIDERS,
  hasExplicitLegacyQwenIdentity,
  hasGenericTtsIdentity,
  isLegacyQwenIdentity,
  narrationArtifactVoiceIdentityFindings,
  narrationPlanRunIdentityBindingFinding,
  narrationPlanVoiceIdentityFindings,
  narrationUnitContractForQuality,
  narrationStitchContractForQuality,
  narrationTtsPolicyForIdentity,
  narrationTtsRetryReportPolicy,
  QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  QWEN_LIAM_PRIMARY_LOCK,
  QWEN_LIAM_RETRY_CONTRACT,
  QWEN_LIAM_STITCH_CONTRACT,
  QWEN_LIAM_UNIT_CONTRACT,
  validateNarrationTtsPolicy,
} from "./lib/narration-tts-policy.mjs";
import {
  QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE,
  canonicalQwenBatchSha256,
  qwenBatchBindingByUnit,
  validateQwenLiamBatchPlan,
} from "./lib/qwen-liam-batch-contract.mjs";
import {
  validateLocalWhisperIdentityContract,
  validateLockedLocalWhisperReport,
} from "./lib/local-whisper-policy.mjs";
import {
  youtubePinnedCommentReceiptComplete,
  youtubePublishManifestComplete,
  youtubePublishingRequired,
  youtubeUploadPackagingComplete,
  youtubeUploadReceiptComplete,
} from "./lib/youtube-publish-contract.mjs";
import {
  GENERATED_MOTION_PROVIDER_LTX,
  GENERATED_MOTION_REPORT_SCHEMA,
  generatedMotionApprovalMatches,
  generatedMotionArtifactPaths,
  generatedMotionEnabled,
  generatedMotionProviderForIdentity,
  requiredGeneratedMotionCoverageFindings,
} from "./lib/generated-motion-contract.mjs";
import { noLtxOverrideStatus } from "./lib/operator-motion-route-override.mjs";
import { effectiveImageIdentityForEpisode } from "./lib/operator-image-route-override.mjs";
import { semanticFailedRecoveryScope } from "./lib/semantic-planner-recovery.mjs";
import { readVisualBeatRecoveryScope } from "./lib/visual-beat-recovery.mjs";
import { readVisualPromptRecoveryScope, visualPromptRecoveryAdmission } from "./lib/visual-prompt-recovery.mjs";
import { hasTtsTerminalPunctuation } from "./lib/tts-text-boundaries.mjs";
import {
  ttsSpokenTextAuditMatches,
  ttsSpokenTextAuditSha256,
} from "./lib/tts-spoken-text-audit.mjs";
import {
  DEFAULT_PLANNING_ROOM_EFFORT_POLICY,
  DEFAULT_WEB_PLANNING_EFFORT_POLICY,
  normalizePlanningEffort,
  normalizePlanningEffortPolicy,
  normalizePlanningProvider,
} from "./lib/planning-runtime-policy.mjs";
import {
  PLANNING_ROOM_PROVIDER,
  PLANNER_PROVIDER_REGISTRY,
  planningRoomContract,
} from "./lib/planner-provider-registry.mjs";
import {
  narrationQualityContractForIdentity,
  narrationUsesAutomatedAsrAcceptance,
} from "./lib/narration-quality-contract.mjs";
import {
  validateNarrationTextIr,
} from "./lib/narration-text-ir.mjs";
import {
  validateNarrationProviderOutputManifest,
} from "./lib/narration-provider-adapter.mjs";
import {
  NARRATION_EXACT_LISTEN_REVIEW_PACKET_SCHEMA,
  narrationExactListenReviewPacketSha256,
  validateNarrationExactListenReviewDecision,
} from "./lib/narration-delivery-quality.mjs";
import {
  narrationSubjectiveReviewManifestSha256,
  validateNarrationSubjectiveReviewDecision,
  validateNarrationSubjectiveReviewManifest,
} from "./lib/narration-subjective-review.mjs";
import {
  CURRENT_VISUAL_BEAT_CONTRACT_VERSION,
  LEGACY_VISUAL_BEAT_CONTRACT_VERSION,
} from "./lib/visual-beat-contract.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
// Legacy identities may omit pace targets. New preflights always bind the
// current 180-195 contract explicitly, while missing historical values retain
// their original compatibility defaults.
const DEFAULT_TARGET_WPM_MIN = 195;
const DEFAULT_TARGET_WPM_MAX = 220;
const DEFAULT_TARGET_WPM_MID = 208;
const DEFAULT_QWEN_NARRATOR_VOICE_ID = "joel_owned_narrator_clone";
const DEFAULT_QWEN_NATIVE_SPEED = 1.25;
const MANUAL_BLOCKER_TRIAGE_POLICY = {
  mode: "agent_review_first",
  summary: "For any blocked or missing gate, the active agent must inspect the blocker evidence and choose the narrowest valid recovery: manual structured repair, scoped rerun, recorded waiver/bypass with evidence, or operator hold.",
  artifact_pattern: "manual_blocker_triage_<stage>_<episode>.json or a stage-specific manual triage artifact",
  guardrails: [
    "Do not skip upstream approvals or missing production assets.",
    "Do not rewrite approved creative content through deterministic code.",
    "Record manual waivers/bypasses with cut/stage evidence and rerun run status after the repair.",
  ],
};

export function contentStatusIdentityFields(runIdentity = {}) {
  return {
    ...(Object.hasOwn(runIdentity, "media_workflow") ? { media_workflow: runIdentity.media_workflow } : {}),
    ...(Object.hasOwn(runIdentity, "workflow_contract") ? { workflow_contract: runIdentity.workflow_contract } : {}),
    source_path: runIdentity.source_path ?? null,
    proof_source_mode: runIdentity.proof_source_mode ?? null,
    content_profile: runIdentity.content_profile ?? null,
    content_profile_version: runIdentity.content_profile_version ?? null,
    content_profile_sha256: runIdentity.content_profile_sha256 ?? null,
    content_profile_config: runIdentity.content_profile_config ?? null,
    factual_evidence: runIdentity.factual_evidence ?? null,
  };
}

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

async function exists(filePath) {
  if (!filePath) return false;
  return fs.stat(filePath).then((stat) => stat.isFile() || stat.isDirectory()).catch(() => false);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function fileMtimeMs(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat?.mtimeMs ?? 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  try {
    return await streamSha256File(filePath);
  } catch {
    return null;
  }
}

async function listFiles(dirPath) {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

async function latestMatching(dirPath, pattern) {
  const names = await listFiles(dirPath);
  const matches = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const filePath = path.join(dirPath, name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile()) matches.push({ name, filePath, mtimeMs: stat.mtimeMs });
  }
  matches.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  return matches[0] ?? null;
}

async function matchingJsonReports(dirPath, pattern) {
  const reports = [];
  for (const name of (await listFiles(dirPath)).filter((item) => pattern.test(item))) {
    const filePath = path.join(dirPath, name);
    const stat = await fs.stat(filePath).catch(() => null);
    const report = await readJson(filePath, null);
    if (stat?.isFile() && report) reports.push({ name, filePath, report, mtimeMs: stat.mtimeMs });
  }
  return reports.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
}

function requiredFlag(name, value) {
  if (!value) throw new Error(`Missing required --${name}. Pass --episode-dir, or pass --channel --week --episode.`);
}

function normalizeAudioTarget(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized || ["narrator", "narration", "narrator_only", "narration_only", "voice_only"].includes(normalized)) return "narrator_only";
  return normalized;
}

function isNarratorOnlyAudio(identity) {
  return normalizeAudioTarget(identity.audio_target) === "narrator_only";
}

function codexOpeningSec(identity) {
  const value = Number(identity?.image_provider_options?.codex_opening_sec ?? identity?.codex_opening_sec ?? 120);
  return Number.isFinite(value) && value > 0 ? value : 120;
}

function imagegenOpeningFlag(identity) {
  const provider = normalizeImageProvider(identity?.image_provider ?? "chatgpt_web_gpt_image");
  return provider === "hybrid_codex_opening_modelslab_rest"
    || provider === "hybrid_codex_refs_opening_risky_modelslab_rest"
    || provider === "hybrid_modelslab_refs_codex_opening_modelslab_rest" ? ` --codex-opening-sec ${codexOpeningSec(identity)}` : "";
}

function usesCodexReferences(identity) {
  const provider = normalizeImageProvider(identity?.image_provider ?? "chatgpt_web_gpt_image");
  return provider === "codex_imagegen"
    || provider === "hybrid_codex_refs_multichar"
    || provider === "hybrid_codex_opening_modelslab_rest"
    || provider === "hybrid_codex_refs_opening_risky_modelslab_rest";
}

function usesCodexSceneCuts(identity) {
  const provider = normalizeImageProvider(identity?.image_provider ?? "chatgpt_web_gpt_image");
  return provider === "codex_imagegen"
    || provider === "hybrid_codex_refs_multichar"
    || provider === "hybrid_codex_opening_modelslab_rest"
    || provider === "hybrid_codex_refs_opening_risky_modelslab_rest"
    || provider === "hybrid_modelslab_refs_codex_opening_modelslab_rest";
}

function paceDiagnosticOnly(identity) {
  void identity;
  return true;
}

function imageOutputQaRequired(identity = {}) {
  return identity.image_output_qa_required === true
    || identity.production_gates?.image_output_qa_required_before_render === true;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function targetWpmMin(identity = {}) {
  return numberOr(identity.target_wpm_min ?? identity.pace_targets?.target_wpm_min ?? identity.pace_targets?.min, DEFAULT_TARGET_WPM_MIN);
}

function targetWpmMax(identity = {}) {
  return numberOr(identity.target_wpm_max ?? identity.pace_targets?.target_wpm_max ?? identity.pace_targets?.max, DEFAULT_TARGET_WPM_MAX);
}

function targetWpmMid(identity = {}) {
  return numberOr(
    identity.target_wpm_midpoint ?? identity.pace_targets?.target_wpm_midpoint ?? identity.pace_targets?.mid,
    Number(((targetWpmMin(identity) + targetWpmMax(identity)) / 2).toFixed(3)) || DEFAULT_TARGET_WPM_MID,
  );
}

function targetWpmRange(identity = {}) {
  return `${targetWpmMin(identity)}-${targetWpmMax(identity)}`;
}

function lockedTtsNativeSpeed(identity = {}) {
  if (isLegacyQwenIdentity(identity)) {
    const raw = identity?.voice_provider_options?.qwen_native_speed ?? identity?.qwen_native_speed;
    const legacyValue = Number(raw);
    return Number.isFinite(legacyValue) && legacyValue > 0 ? legacyValue : null;
  }
  const policy = narrationTtsPolicyForIdentity(identity);
  const value = Number(policy.primary?.native_speed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function stitchReportPathForIdentity(episodeDir, episode, identity = {}) {
  return path.join(
    episodeDir,
    isLegacyQwenIdentity(identity)
      ? `audio_stitch_report_${episode}-modelslab-qwen.json`
      : `audio_stitch_report_${episode}-narration.json`,
  );
}

function runIdentityTtsComplete(runIdentity = {}) {
  if (runIdentity.schema === "goldflow_run_identity_v2"
    && !hasGenericTtsIdentity(runIdentity)
    && !hasExplicitLegacyQwenIdentity(runIdentity)) {
    return {
      done: false,
      evidence: "run_identity.json v2 is missing the generic narration identity and does not contain the complete explicit legacy-Qwen marker set",
    };
  }
  if (isLegacyQwenIdentity(runIdentity)) {
    return { done: true, evidence: "legacy Qwen TTS identity adapter" };
  }
  try {
    const policy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(runIdentity), {
      production: String(runIdentity.run_intent ?? "production") === "production",
    });
    const mismatches = [];
    if (runIdentity.provider_locks?.tts_provider !== policy.primary.provider) mismatches.push("provider_locks.tts_provider");
    if ((runIdentity.provider_locks?.tts_fallback_provider ?? null) !== (policy.fallback?.provider ?? null)) mismatches.push("provider_locks.tts_fallback_provider");
    if (runIdentity.provider_locks?.narrator_voice_id !== policy.primary.voice_id) mismatches.push("provider_locks.narrator_voice_id");
    if (runIdentity.model_versions?.tts_model !== policy.primary.model_id) mismatches.push("model_versions.tts_model");
    if (runIdentity.model_versions?.tts_model_revision !== policy.primary.model_revision) mismatches.push("model_versions.tts_model_revision");
    if ((runIdentity.model_versions?.fallback_tts_model ?? null) !== (policy.fallback?.model_id ?? null)) mismatches.push("model_versions.fallback_tts_model");
    if ((runIdentity.model_versions?.fallback_tts_model_revision ?? null) !== (policy.fallback?.model_revision ?? null)) mismatches.push("model_versions.fallback_tts_model_revision");
    if (policy.primary.provider === "qwen_local") {
      const qualityContract = narrationQualityContractForIdentity(runIdentity);
      const unitContract = narrationUnitContractForQuality(qualityContract);
      const stitchContract = narrationStitchContractForQuality(qualityContract);
      const exactQwenLocks = {
        tts_native_speed: null,
        tts_speed_control: "unsupported",
        primary_reference_audio_sha256: policy.primary.reference_audio_sha256,
        primary_reference_manifest_sha256: policy.primary.reference_manifest_sha256,
        primary_reference_metadata_sha256: policy.primary.reference_metadata_sha256,
        primary_voice_sha256: policy.primary.voice_sha256,
        primary_similarity_model_sha256: policy.primary.speaker_similarity_model_sha256,
        primary_similarity_calibration_sha256: policy.primary.speaker_similarity_calibration_sha256,
        primary_minimum_cosine_similarity: policy.primary.minimum_cosine_similarity,
        primary_warning_below_cosine_similarity: policy.primary.warning_below_cosine_similarity,
        primary_voice_continuity_contract: policy.primary.voice_continuity_contract,
        tts_unit_target_words_min: unitContract.target_words_min,
        tts_unit_target_words_max: unitContract.target_words_max,
        tts_unit_hard_words_max: unitContract.hard_words_max,
        tts_sentence_complete_units: unitContract.sentence_complete,
        tts_continuous_requests: unitContract.continuous_requests,
        tts_join_silence_ms: qualityContract
          ? null
          : QWEN_LIAM_STITCH_CONTRACT.join_silence_ms,
        post_tempo_processing: stitchContract.post_tempo_processing,
        tts_retry_policy: QWEN_LIAM_RETRY_CONTRACT.retry_policy,
        tts_automatic_asr_retry: QWEN_LIAM_RETRY_CONTRACT.automatic_asr_retry,
      };
      if (qualityContract) {
        Object.assign(exactQwenLocks, {
          primary_similarity_threshold_source:
            qualityContract.voice_identity_qa.threshold_source,
          primary_universal_similarity_threshold_forbidden: true,
          primary_reference_bank_centroid_required: true,
          primary_reference_bank_minimum_count:
            qualityContract.voice_identity_qa.minimum_reference_count,
          primary_unit_outliers_review_required: true,
          primary_aggregate_drift_report_required: true,
          tts_unit_soft_words_max: unitContract.soft_words_max,
          tts_stitch_contract_version: stitchContract.contract_version,
          tts_semantic_boundary_classes: true,
          tts_alignment_required_for_trimming: true,
          tts_missing_alignment_policy: stitchContract.missing_alignment_policy,
          tts_exact_sample_accounting_required: true,
        });
      }
      for (const [field, expected] of Object.entries(exactQwenLocks)) {
        if (runIdentity.provider_locks?.[field] !== expected) {
          mismatches.push(`provider_locks.${field}`);
        }
      }
      if (JSON.stringify(runIdentity.provider_locks?.tts_confirmed_defect_types)
        !== JSON.stringify(QWEN_LIAM_RETRY_CONTRACT.confirmed_defect_types)) {
        mismatches.push("provider_locks.tts_confirmed_defect_types");
      }
      const batch4Required =
        runIdentity.stage_registry_version === "2026-07-29.1"
        || runIdentity.stage_registry_version
          === PIPELINE_STAGE_REGISTRY_VERSION
        || runIdentity.provider_locks?.tts_synthesis_contract_id
          === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.contract_id;
      if (batch4Required) {
        const exactBatchLocks = {
          tts_synthesis_contract_id:
            QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.contract_id,
          tts_synthesis_mode: QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode,
          tts_synthesis_api: QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.api,
          tts_model_instance_count:
            QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.resident_model_count,
          tts_model_concurrency:
            QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.model_concurrency,
          tts_nominal_batch_size:
            QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.nominal_batch_size,
          tts_batch_scheduler_version:
            QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.scheduler_version,
          tts_token_limit_acceptance_allowed: false,
          tts_objective_recovery_mode:
            QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.objective_recovery_mode,
        };
        for (const [field, expected] of Object.entries(exactBatchLocks)) {
          if (runIdentity.provider_locks?.[field] !== expected) {
            mismatches.push(`provider_locks.${field}`);
          }
        }
        if (JSON.stringify(policy.synthesis_contract)
          !== JSON.stringify(QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT)) {
          mismatches.push("voice_provider_options.synthesis_contract");
        }
        if (runIdentity.production_gates
          ?.deterministic_length_matched_tts_batching_required !== true) {
          mismatches.push(
            "production_gates.deterministic_length_matched_tts_batching_required",
          );
        }
        if (runIdentity.production_gates?.tts_single_resident_model_required
          !== true) {
          mismatches.push(
            "production_gates.tts_single_resident_model_required",
          );
        }
        if (runIdentity.production_gates?.tts_token_limit_outputs_forbidden
          !== true) {
          mismatches.push(
            "production_gates.tts_token_limit_outputs_forbidden",
          );
        }
        if (runIdentity.production_gates
          ?.tts_objective_recovery_exact_unit_only !== true) {
          mismatches.push(
            "production_gates.tts_objective_recovery_exact_unit_only",
          );
        }
        if (Number(runIdentity.production_profile_config?.media
          ?.qwen_tts_batch_size)
          !== QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.nominal_batch_size) {
          mismatches.push(
            "production_profile_config.media.qwen_tts_batch_size",
          );
        }
        if (Number(runIdentity.production_profile_config?.media
          ?.qwen_tts_concurrency) !== 1
          || Number(runIdentity.production_profile_config?.media
            ?.local_qwen_tts_concurrency) !== 1) {
          mismatches.push(
            "production_profile_config.media.qwen_tts_concurrency",
          );
        }
      }
      if (runIdentity.production_gates?.tts_speed_control_supported !== false) {
        mismatches.push("production_gates.tts_speed_control_supported");
      }
      if (runIdentity.production_gates?.sentence_complete_tts_units_required !== true) {
        mismatches.push("production_gates.sentence_complete_tts_units_required");
      }
      if (runIdentity.production_gates?.tts_spoken_text_audit_required != null
        && runIdentity.production_gates.tts_spoken_text_audit_required !== true) {
        mismatches.push("production_gates.tts_spoken_text_audit_required");
      }
      if (runIdentity.production_gates?.continuous_longform_tts_requests_forbidden !== true) {
        mismatches.push("production_gates.continuous_longform_tts_requests_forbidden");
      }
    } else {
      if (Number(runIdentity.provider_locks?.tts_native_speed) !== Number(policy.primary.native_speed)) mismatches.push("provider_locks.tts_native_speed");
      if ((runIdentity.provider_locks?.fallback_voice_identity ?? null) !== (policy.fallback?.reference_voice_id ?? null)) mismatches.push("provider_locks.fallback_voice_identity");
      if ((runIdentity.provider_locks?.fallback_reference_audio_sha256 ?? null) !== (policy.fallback?.reference_audio_sha256 ?? null)) mismatches.push("provider_locks.fallback_reference_audio_sha256");
      if ((runIdentity.provider_locks?.fallback_reference_metadata_sha256 ?? null) !== (policy.fallback?.reference_metadata_sha256 ?? null)) mismatches.push("provider_locks.fallback_reference_metadata_sha256");
      if ((runIdentity.provider_locks?.fallback_similarity_model_sha256 ?? null) !== (policy.fallback?.speaker_similarity_model_sha256 ?? null)) mismatches.push("provider_locks.fallback_similarity_model_sha256");
      if ((runIdentity.provider_locks?.fallback_similarity_calibration_sha256 ?? null) !== (policy.fallback?.speaker_similarity_calibration_sha256 ?? null)) mismatches.push("provider_locks.fallback_similarity_calibration_sha256");
      if (Number(runIdentity.provider_locks?.fallback_minimum_cosine_similarity) !== Number(policy.fallback?.minimum_cosine_similarity)) mismatches.push("provider_locks.fallback_minimum_cosine_similarity");
      if (Number(runIdentity.provider_locks?.fallback_warning_below_cosine_similarity) !== Number(policy.fallback?.warning_below_cosine_similarity)) mismatches.push("provider_locks.fallback_warning_below_cosine_similarity");
    }
    if (mismatches.length) {
      return { done: false, evidence: `run_identity.json narration locks missing/stale: ${mismatches.join(", ")}` };
    }
    return {
      done: true,
      evidence: policy.primary.provider === "qwen_local"
        ? `run_identity.json TTS locked: ${policy.primary.provider}/${policy.primary.voice_id}; owned reference clone; 20-42 words preferred (48 soft/60 hard); semantic joins; alignment-safe edges; batch-four; no fallback/speed/continuous/post-tempo`
        : `run_identity.json TTS locked: ${policy.primary.provider}/${policy.primary.voice_id}@${policy.primary.native_speed}; fallback=${policy.fallback?.provider ?? "none"}`,
    };
  } catch (error) {
    return { done: false, evidence: `run_identity.json TTS policy invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function runIdentityWhisperComplete(runIdentity = {}) {
  return validateLocalWhisperIdentityContract(runIdentity);
}

function runIdentityPlanningComplete(runIdentity = {}) {
  const topProvider = runIdentity.planning_provider ?? null;
  const lockedProvider = runIdentity.provider_locks?.planning_provider ?? null;
  if (!topProvider && !lockedProvider) {
    return {
      done: true,
      evidence: "legacy planning identity adapter: codex_cli + uniform effort",
      provider: "codex_cli",
      legacy: true,
    };
  }
  const mismatches = [];
  const lockedEffortPolicy = runIdentity.provider_locks?.planning_effort_policy ?? null;
  const topEffortPolicy = runIdentity.planning_effort_policy ?? null;
  const lockedDefaultEffort = runIdentity.provider_locks?.planning_default_reasoning_effort ?? null;
  const modelDefaultEffort = runIdentity.model_versions?.planning_reasoning_effort ?? null;
  if (!lockedProvider) mismatches.push("provider_locks.planning_provider");
  if (!topProvider) mismatches.push("planning_provider");
  if (!lockedEffortPolicy) mismatches.push("provider_locks.planning_effort_policy");
  if (!topEffortPolicy) mismatches.push("planning_effort_policy");
  if (!lockedDefaultEffort) mismatches.push("provider_locks.planning_default_reasoning_effort");
  if (!modelDefaultEffort) mismatches.push("model_versions.planning_reasoning_effort");
  let provider;
  let effortPolicy;
  let defaultEffort;
  try { provider = normalizePlanningProvider(lockedProvider ?? topProvider); } catch { mismatches.push("planning_provider"); }
  try {
    effortPolicy = normalizePlanningEffortPolicy(
      lockedEffortPolicy ?? topEffortPolicy,
    );
  } catch { mismatches.push("planning_effort_policy"); }
  try {
    defaultEffort = normalizePlanningEffort(
      lockedDefaultEffort ?? modelDefaultEffort,
    );
  } catch { mismatches.push("planning_default_reasoning_effort"); }
  if (topProvider && lockedProvider) {
    try {
      if (normalizePlanningProvider(topProvider) !== normalizePlanningProvider(lockedProvider)) {
        mismatches.push("provider_locks.planning_provider");
      }
    } catch {
      mismatches.push("provider_locks.planning_provider");
    }
  }
  if (topEffortPolicy && lockedEffortPolicy) {
    try {
      if (normalizePlanningEffortPolicy(topEffortPolicy) !== normalizePlanningEffortPolicy(lockedEffortPolicy)) {
        mismatches.push("provider_locks.planning_effort_policy");
      }
    } catch {
      mismatches.push("provider_locks.planning_effort_policy");
    }
  }
  if (lockedDefaultEffort && modelDefaultEffort) {
    try {
      if (normalizePlanningEffort(lockedDefaultEffort) !== normalizePlanningEffort(modelDefaultEffort)) {
        mismatches.push("model_versions.planning_reasoning_effort");
      }
    } catch {
      mismatches.push("model_versions.planning_reasoning_effort");
    }
  }
  const model = runIdentity.model_versions?.planning_model ?? null;
  const lockedModel = runIdentity.provider_locks?.planning_model ?? null;
  if (!model || !lockedModel || model !== lockedModel) mismatches.push("planning_model");
  if (provider === PLANNING_ROOM_PROVIDER) {
    const room = runIdentity.provider_locks?.planning_room ?? runIdentity.planning_room ?? null;
    const expected = planningRoomContract(runIdentity);
    const providerModels = runIdentity.provider_locks?.planning_provider_models
      ?? runIdentity.planning_room?.provider_models
      ?? null;
    if (room?.schema !== expected.schema) mismatches.push("planning_room.schema");
    if (room?.selection_policy !== expected.selection_policy) mismatches.push("planning_room.selection_policy");
    if (JSON.stringify(room?.stage_routes ?? null) !== JSON.stringify(expected.stage_routes)) {
      mismatches.push("planning_room.stage_routes");
    }
    if (expected.structured_pool
      && JSON.stringify(room?.structured_pool ?? null) !== JSON.stringify(expected.structured_pool)) {
      mismatches.push("planning_room.structured_pool");
    }
    for (const providerId of Object.keys(PLANNER_PROVIDER_REGISTRY)) {
      if (!String(providerModels?.[providerId] ?? "").trim()) {
        mismatches.push(`planning_provider_models.${providerId}`);
      }
    }
    if (effortPolicy !== DEFAULT_PLANNING_ROOM_EFFORT_POLICY) mismatches.push("planning_effort_policy");
    if (model !== "stage_routed") mismatches.push("planning_model");
  }
  if (provider === "chatgpt_web" && effortPolicy !== DEFAULT_WEB_PLANNING_EFFORT_POLICY
    && effortPolicy !== "uniform_v1") mismatches.push("planning_effort_policy");
  if (!["chatgpt_web", PLANNING_ROOM_PROVIDER].includes(provider) && defaultEffort === "max") mismatches.push("planning_default_reasoning_effort");
  return {
    done: mismatches.length === 0,
    evidence: mismatches.length
      ? `planning identity mismatch: ${[...new Set(mismatches)].join(", ")}`
      : `${provider}; ${effortPolicy}; default ${defaultEffort}; ${model}`,
    provider,
    effort_policy: effortPolicy,
    default_effort: defaultEffort,
    legacy: false,
  };
}

function renderCommand(identity, base, episode) {
  const profile = String(identity?.render_profile ?? "smooth_subpixel_ken_burns").toLowerCase();
  const common = `node bin/goldflow.mjs render start ${base} --prompts <episode-dir>/section_image_prompts_hardened.json --audio-bed-report <episode-dir>/<final-longform-audio-report>.json --transition-plan <episode-dir>/transition_edit_plan_${episode}.json --hook-xfade true --hook-xfade-duration-sec 0.28 --retention-xfade-sec 180`;
  if (profile === "smooth_subpixel_ken_burns") {
    return `${common} --motion smooth_subpixel_ken_burns --motion-strength 1.75 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast`;
  }
  if (profile === "smooth_fast_ken_burns") {
    return `${common} --motion smooth_fast_ken_burns --motion-strength 1.75 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast`;
  }
  return [
    `${common} --motion fill_ken_burns --motion-strength 1.75 --render-scale-multiplier 1.45 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast`,
    `${common} --motion smooth_fast_ken_burns --motion-strength 1.75 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast --output <episode-dir>/assets/renders/<title>-smooth-fast.mp4 --report-output <episode-dir>/render_report_${episode}-smooth-fast.json`,
  ].join("; optional A/B smoother sibling without overwriting premium: ");
}

function commandBase(identity) {
  const channel = identity.channel ?? "<channel>";
  const series = identity.series_slug ?? "<series>";
  const week = identity.week ?? "<week>";
  const episode = identity.episode ?? "<episode>";
  return `--channel ${channel} --series ${series} --week ${week} --episode ${episode}`;
}

function visualRefsApproveCommand(identity) {
  return `node bin/goldflow.mjs visual approve-refs ${commandBase(identity)} --cleanliness-reviewed true --note "<reference review notes>"`;
}

function imagegenStartCommand(identity, extra = "") {
  const provider = normalizeImageProvider(identity?.image_provider ?? "chatgpt_web_gpt_image");
  const imageModel = identity?.model_versions?.image_model ?? identity?.provider_locks?.image_model ?? (provider === "chatgpt_web_gpt_image" ? "chatgpt_web_gpt_image" : "flux-klein");
  const providerConcurrency = provider === "chatgpt_web_gpt_image" ? 3 : 15;
  return `node bin/goldflow.mjs imagegen start ${commandBase(identity)}${imagegenOpeningFlag(identity)} --image-provider ${provider} --image-model ${imageModel} --prompts <episode-dir>/section_image_prompts_hardened.json --skip-reference-generation true --concurrency ${providerConcurrency} --reference-concurrency ${providerConcurrency}${extra}`;
}

function codexWorkCommand(identity, ids, { references = false, qaRecovery = false, seedDerivedRefs = false } = {}) {
  const idFlag = references ? "--reference-ids" : "--image-ids";
  const modeFlags = [
    references ? "--references-only true" : "--prompts <episode-dir>/section_image_prompts_hardened.json",
    qaRecovery ? "--qa-recovery true" : "",
    seedDerivedRefs ? "--seed-derived-refs true" : "",
  ].filter(Boolean).join(" ");
  return `node bin/goldflow.mjs imagegen codex-work ${commandBase(identity)} --action create ${modeFlags} ${idFlag} ${ids.join(",")} --max-attempts 1 --lease-sec 900`;
}

function browserPoolCommand(identity, ids = [], { references = false, qaRecovery = false, repair = false } = {}) {
  const scopeFlag = references ? "--reference-ids" : "--image-ids";
  const flags = [
    references ? "--references-only true" : "",
    ids.length ? `${scopeFlag} ${ids.join(",")}` : "",
    qaRecovery ? "--qa-recovery true" : "",
    repair ? '--repair-reason "<reviewed exact-ID blocker evidence>"' : "",
  ].filter(Boolean).join(" ");
  return `node bin/goldflow.mjs imagegen browser-pool ${commandBase(identity)}${flags ? ` ${flags}` : ""}`;
}

async function hybridDeadletteredAssetIds(episodeDir, mode, currentRows = []) {
  return new Set((await findSourceCompatibleHybridDeadletters({
    episodeDir,
    mode,
    currentRows,
  })).keys());
}

function promptUsesCodex(prompt, identity) {
  const explicit = String(prompt?.image_provider_route ?? prompt?.provider_route ?? prompt?.provider ?? "").toLowerCase();
  if (explicit.includes("codex")) return true;
  if (explicit.includes("modelslab")) return false;
  const provider = normalizeImageProvider(identity?.image_provider ?? "chatgpt_web_gpt_image");
  if (provider === "codex_imagegen") return true;
  if (provider === "modelslab") return false;
  if (provider === "hybrid_codex_opening_modelslab_rest" || provider === "hybrid_modelslab_refs_codex_opening_modelslab_rest") {
    return promptStartSec(prompt) < codexOpeningSec(identity);
  }
  if (provider === "hybrid_codex_refs_opening_risky_modelslab_rest") {
    return promptStartSec(prompt) < codexOpeningSec(identity)
      || visibleCharacterCount(prompt) >= 2
      || (prompt?.risk_tags ?? []).length > 0;
  }
  return provider === "hybrid_codex_refs_multichar" && visibleCharacterCount(prompt) >= 2;
}

function scopedImagegenRecoveryCommand(identity, ids, promptPlan, options = {}) {
  if (isBrowserPoolImageProvider(normalizeImageProvider(identity?.image_provider))) {
    return browserPoolCommand(identity, ids.map(String), {
      qaRecovery: options.qaRecovery === true,
      repair: options.seedDerivedRefs !== true,
    });
  }
  const idSet = new Set(ids.map(String));
  const prompts = (promptPlan?.prompts ?? []).filter((prompt) => idSet.has(String(prompt?.image_id ?? "")));
  const codexIds = prompts.filter((prompt) => promptUsesCodex(prompt, identity)).map((prompt) => String(prompt.image_id));
  const codexSet = new Set(codexIds);
  const providerIds = ids.map(String).filter((id) => !codexSet.has(id));
  const commands = [];
  if (codexIds.length) commands.push(codexWorkCommand(identity, codexIds, options));
  if (providerIds.length) {
    const providerFilter = usesCodexSceneCuts(identity) ? " --provider-filter modelslab" : "";
    const recoveryFlags = `${options.seedDerivedRefs ? " --seed-derived-refs true" : ""}${options.qaRecovery ? " --qa-recovery true" : ""}`;
    commands.push(imagegenStartCommand(identity, ` --cut-ids ${providerIds.join(",")}${providerFilter}${recoveryFlags}`));
  }
  return commands.join("; then ") || imagegenStartCommand(identity);
}

function codexCreditFallbackCommand(identity, ids, { references = false } = {}) {
  return `ModelsLab credit exhaustion confirmed for ${ids.length} ${references ? "reference" : "scene"} asset(s). ${codexWorkCommand(identity, ids, { references })}`;
}

function imagegenPromoteDerivedRefsCommand(identity) {
  return `node bin/goldflow.mjs imagegen promote-derived-refs ${commandBase(identity)} --prompts <episode-dir>/section_image_prompts_hardened.json`;
}

function commandFor(stage, identity) {
  return buildStageCommand(stage, identity);
}

export function semanticRecoveryCommandForTests(artifact, identity, sourceScriptHash = artifact?.source_script_hash) {
  const failedIds = semanticFailedRecoveryScope(artifact, sourceScriptHash);
  if (!failedIds.length) return null;
  const base = commandFor("semantic_scene_plan", identity)
    .replace(/\s+--semantic-chunk-ids\s+\S+/g, "")
    .replace(/\s+--resume-incomplete-chunks\s+true\b/g, "");
  return `${base} --semantic-chunk-ids ${failedIds.join(",")}`;
}

export function visualBeatRecoveryCommandForTests(scope, identity) {
  if (!scope?.failed_chunk_ids?.length || scope.source_hashes_current !== true) return null;
  const base = commandFor("visual_beat_plan", identity)
    .replace(/\s+--resume-incomplete-chunks\s+true\b/g, "");
  return `${base} --resume-incomplete-chunks true`;
}

export function visualPromptRecoveryCommandForTests(scope, identity) {
  if (!scope?.failed_cut_ids?.length || scope.source_hashes_current !== true) return null;
  const base = commandFor("visual_prompt_plan", identity)
    .replace(/\s+--resume-incomplete-chunks\s+true\b/g, "");
  return `${base} --cut-ids ${scope.failed_cut_ids.join(",")}`;
}

export function transitionRecoveryCommandForTests(artifact, identity) {
  const failedBoundaryIds = String(artifact?.status ?? "").toLowerCase() === "blocked"
    && Array.isArray(artifact?.failed_boundary_ids)
    ? [...new Set(artifact.failed_boundary_ids.map(String).filter(Boolean))]
    : [];
  if (!failedBoundaryIds.length) return null;
  const base = commandFor("transition_edit_plan", identity)
    .replace(/\s+--boundary-ids?\s+\S+/g, "")
    .replace(/\s+--resume-incomplete-chunks\s+true\b/g, "");
  return `${base} --boundary-ids ${failedBoundaryIds.join(",")}`;
}

function inferredState(validation = {}) {
  if (validation.state) return validation.state;
  if (validation.done) return "passed";
  const evidence = String(validation.evidence ?? "").toLowerCase();
  if (evidence.includes("stale")) return "stale";
  if (evidence.includes("blocked") || evidence.includes("deadletter")) return "blocked";
  if (evidence.includes("failed") || evidence.includes("invalid")) return "failed";
  return "missing";
}

function stage(stageId, validation, identity, nextCommandOverride = null) {
  const definition = stageDefinition(stageId);
  if (!definition) throw new Error(`Stage ${stageId} is missing from the pipeline registry.`);
  const state = inferredState(validation);
  return {
    stage: stageId,
    title: definition.title,
    state,
    required_input: definition.required_input,
    output_artifact: definition.output_artifact,
    operator_approval_required: definition.approval !== "automatic",
    approval_policy: definition.approval,
    validator: definition.validator,
    exists: stageIsSatisfied(state),
    evidence: validation.evidence ?? null,
    next_command_shape: stageIsSatisfied(state) ? null : nextCommandOverride ?? validation.next_command_shape ?? commandFor(stageId, identity),
  };
}

async function visualPromptPlanReviewHardenCommand(episodeDir, identity, recoveryScope = null) {
  const channel = identity.channel ?? "<channel>";
  const series = identity.series_slug ?? "<series>";
  const week = identity.week ?? "<week>";
  const episode = identity.episode ?? "<episode>";
  const base = `--channel ${channel} --series ${series} --week ${week} --episode ${episode}`;
  const planCommand = commandFor("visual_prompt_plan", identity);
  const promptPlan = await readJson(path.join(episodeDir, "section_image_prompts.json"), null);
  if (promptPlan?.status === "blocked") {
    return visualPromptRecoveryCommandForTests(recoveryScope, identity)
      ?? "Manual triage required: blocked visual prompt base is incomplete, stale, or lacks exact unresolved scope.";
  }
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts) || !promptPlan.prompts.length) return planCommand;
  const reviewedPlanPath = path.join(episodeDir, "section_image_prompts_reviewed.json");
  const hardenedPlanPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  const hardenReportPath = path.join(episodeDir, `visual_prompt_hardening_${episode}.json`);
  const reviewedPlan = await readJson(reviewedPlanPath, null);
  const hardenedPlan = await readJson(hardenedPlanPath, null);
  const hardenReport = await readJson(hardenReportPath, null);
  const reviewedStatus = String(reviewedPlan?.status ?? "").toLowerCase();
  const hardenStatus = String(hardenReport?.status ?? "").toLowerCase();
  const manualReviewPath = reviewedPlan?.visual_manual_agent_review_path ?? path.join(episodeDir, `visual_manual_agent_review_${episode}.json`);
  const blockerReviewCommand = `node bin/goldflow.mjs visual review ${base} --prompts <episode-dir>/section_image_prompts.json --blockers-only true --auto-resolve true --max-resolve-iterations 1 --harden-report <episode-dir>/visual_prompt_hardening_${episode}.json`;
  const scopedReviewCommand = `node bin/goldflow.mjs visual review ${base} --resume-blocked true --auto-resolve true --max-resolve-iterations 1`;
  const hardenOriginalCommand = `node bin/goldflow.mjs visual harden ${base} --prompts <episode-dir>/section_image_prompts.json`;
  const hardenReviewedCommand = `node bin/goldflow.mjs visual harden ${base} --prompts <episode-dir>/section_image_prompts_reviewed.json`;
  if (hardenedPlan?.status === "passed" && Array.isArray(hardenedPlan.prompts) && hardenedPlan.prompts.length) {
    return hardenOriginalCommand;
  }
  if (reviewedStatus === "needs_manual_agent_review") {
    return `Manual agent review required: inspect ${manualReviewPath}; then patch detector/review logic or run a scoped visual review/replan for the listed cut ids before rerunning run status.`;
  }
  if (["blocked", "blocked_deadletter"].includes(reviewedStatus)) {
    return scopedReviewCommand;
  }
  if (reviewedStatus === "passed") {
    const [reviewedMtime, hardenMtime] = await Promise.all([
      fileMtimeMs(reviewedPlanPath),
      fileMtimeMs(hardenReportPath),
    ]);
    if (reviewedMtime > hardenMtime || !hardenStatus) return hardenReviewedCommand;
  }
  if (hardenStatus === "blocked") return blockerReviewCommand;
  return hardenOriginalCommand;
}

function isDerivedReferenceTarget(target) {
  return /^derive_from_/i.test(String(target?.generation_mode ?? ""));
}

function referencePathValue(target) {
  return target?.conditioning_image_path ?? target?.reference_image_path ?? target?.required_reference_path ?? target?.path ?? null;
}

function promptStartSec(prompt) {
  const value = Number(prompt?.start_sec ?? prompt?.start ?? prompt?.timestamp_sec ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
}

function isLocationTarget(target) {
  return String(target?.kind ?? "").toLowerCase() === "location";
}

function promptRequirementKind(prompt, kindPattern) {
  return (prompt?.reference_requirements ?? []).some((requirement) => kindPattern.test(String(requirement?.kind ?? "").toLowerCase()));
}

function visibleCharacterCount(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  const names = new Set([
    ...arrayOfStrings(prompt?.visible_characters),
    ...arrayOfStrings(prompt?.visible_subjects),
    ...arrayOfStrings(manifest.visible_characters),
    ...arrayOfStrings(manifest.character_state_ref_ids),
    ...arrayOfStrings(manifest.character_staging?.map?.((entry) => entry?.name) ?? []),
    ...arrayOfStrings(manifest.character_staging?.map?.((entry) => entry?.ref_id) ?? []),
  ]);
  if (manifest.primary_character) names.add(String(manifest.primary_character));
  if (manifest.protagonist_state_ref_id) names.add(String(manifest.protagonist_state_ref_id));
  return [...names].filter(Boolean).length;
}

function promptHasPromotableLocationContamination(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  if (visibleCharacterCount(prompt) > 0) return true;
  if (promptRequirementKind(prompt, /character/)) return true;
  if (promptRequirementKind(prompt, /(?:prop|ui|action|effect)/)) return true;
  if (arrayOfStrings(manifest.visible_props).length) return true;
  if (arrayOfStrings(manifest.ui_elements).length) return true;
  const text = [
    prompt?.visual_job,
    prompt?.suggested_shot_job,
    manifest.shot_job,
    prompt?.image_prompt,
    prompt?.modelslab_image_prompt,
    prompt?.codex_image_prompt,
  ].filter(Boolean).join(" ");
  return /\b(?:close[- ]?up|portrait|reaction|hand|phone|screen|panel|ui|sword|weapon|document|letter|book|cup|mug|tabletop|object insert|prop insert)\b/i.test(text);
}

function promptIsCleanLocationSeed(prompt, target) {
  if (!isLocationTarget(target)) return true;
  if (promptHasPromotableLocationContamination(prompt)) return false;
  const text = [
    prompt?.visual_job,
    prompt?.suggested_shot_job,
    prompt?.shot_manifest?.shot_job,
    prompt?.image_prompt,
    prompt?.modelslab_image_prompt,
    prompt?.codex_image_prompt,
  ].filter(Boolean).join(" ");
  return /\b(?:environment|establishing|location|empty|no characters|architecture|interior|exterior|room|hall|corridor|courtyard|street|stage|arena|chapel|cathedral|academy|manor)\b/i.test(text);
}

function promptMentionsRef(prompt, refId) {
  const wanted = String(refId ?? "").trim();
  if (!wanted) return false;
  if ((prompt.reference_requirements ?? []).some((req) => String(req?.ref_id ?? "").trim() === wanted)) return true;
  const manifest = prompt.shot_manifest ?? {};
  return String(manifest.location_ref_id ?? "").trim() === wanted
    || String(manifest.protagonist_state_ref_id ?? "").trim() === wanted
    || (manifest.character_state_ref_ids ?? []).some((id) => String(id ?? "").trim() === wanted);
}

function explicitCandidateIds(target) {
  return [
    ...(Array.isArray(target?.candidate_image_ids) ? target.candidate_image_ids : []),
    ...(Array.isArray(target?.anchor_image_ids) ? target.anchor_image_ids : []),
    ...(Array.isArray(target?.seed_image_ids) ? target.seed_image_ids : []),
    ...(Array.isArray(target?.derived_candidate_image_ids) ? target.derived_candidate_image_ids : []),
  ].map((id) => String(id ?? "").trim()).filter(Boolean);
}

function candidateImageIdsForDerivedTarget(target, promptPlan) {
  const prompts = Array.isArray(promptPlan?.prompts) ? promptPlan.prompts : [];
  const byId = new Map(prompts.map((prompt) => [String(prompt.image_id ?? ""), prompt]));
  const explicit = explicitCandidateIds(target).filter((id) => byId.has(id));
  if (explicit.length) return [...new Set(explicit)];
  const sceneIds = new Set((Array.isArray(target?.scene_ids) ? target.scene_ids : []).map((id) => String(id ?? "").trim()).filter(Boolean));
  const rows = [
    ...prompts.filter((prompt) => promptMentionsRef(prompt, target.ref_id)),
    ...prompts.filter((prompt) => sceneIds.has(String(prompt.scene_id ?? "")) || sceneIds.has(String(prompt.parent_scene_id ?? ""))),
  ].filter((prompt) => prompt?.image_id)
    .filter((prompt) => promptIsCleanLocationSeed(prompt, target))
    .sort((left, right) => promptStartSec(left) - promptStartSec(right) || String(left.image_id).localeCompare(String(right.image_id), undefined, { numeric: true }))
    .map((prompt) => String(prompt.image_id));
  return [...new Set(rows)];
}

function successfulImageIdsFromReport(report) {
  const ids = new Set();
  for (const row of report?.results ?? []) {
    const status = String(row?.status ?? "").toLowerCase();
    if (!row?.image_id || status === "failed" || !row.image_path) continue;
    ids.add(String(row.image_id));
  }
  return ids;
}

function failedImageIdsFromReport(report) {
  return [...new Set((report?.results ?? [])
    .filter((row) => row?.image_id && String(row.status ?? "").toLowerCase() === "failed")
    .map((row) => String(row.image_id)))];
}

export async function imageLedgerMatchesPromptCreativeContractForTests({ promptPlan, ledger, report, hashFile = fileSha256, fileExists = exists }) {
  const prompts = (promptPlan?.prompts ?? []).filter((prompt) => prompt?.image_generation_required !== false);
  const cutsById = new Map((ledger?.cuts ?? []).map((cut) => [String(cut.image_id ?? ""), cut]));
  const resultsById = new Map((report?.results ?? []).map((row) => [String(row.image_id ?? ""), row]));
  if (!prompts.length || cutsById.size < prompts.length || resultsById.size < prompts.length) return false;
  const hashCache = new Map();
  const currentHash = async (filePath) => {
    if (!filePath) return null;
    if (!hashCache.has(filePath)) hashCache.set(filePath, await hashFile(filePath));
    return hashCache.get(filePath);
  };
  for (const prompt of prompts) {
    const imageId = String(prompt.image_id ?? "");
    const cut = cutsById.get(imageId);
    const result = resultsById.get(imageId);
    if (!cut || !result || !cut.image_path || !(await fileExists(cut.image_path))) return false;
    if (String(result.status ?? "").toLowerCase() === "failed" || result.image_path !== cut.image_path) return false;
    const authoredPromptHash = sha256(JSON.stringify({
      image_prompt: prompt.image_prompt ?? null,
      modelslab_image_prompt: prompt.modelslab_image_prompt ?? null,
      codex_image_prompt: prompt.codex_image_prompt ?? null,
      shot_manifest: prompt.shot_manifest ?? null,
      reference_requirements: prompt.reference_requirements ?? [],
    }));
    if (cut.authored_prompt_hash !== authoredPromptHash) return false;
    const currentImageHash = await currentHash(cut.image_path);
    if (!currentImageHash || currentImageHash !== cut.image_sha256) return false;
    const resultImageHash = result.generated?.output_sha256 ?? result.generated?.manual_source_sha256 ?? null;
    if (resultImageHash && resultImageHash !== currentImageHash) return false;
    const currentRefIds = (prompt.reference_slots ?? prompt.reference_requirements ?? []).map((row) => row?.ref_id).filter(Boolean).map(String).sort();
    const ledgerRefIds = (cut.reference_ids ?? []).map(String).sort();
    if (JSON.stringify(currentRefIds) !== JSON.stringify(ledgerRefIds)) return false;
    for (const reference of cut.references ?? []) {
      if (!reference?.path || !(await fileExists(reference.path))) return false;
      if ((await currentHash(reference.path)) !== reference.sha256) return false;
    }
  }
  return true;
}

async function derivedReferenceImagegenStatus(episodeDir, promptPlan, latestImageReport, identity) {
  const visualReferencePlan = await readJson(path.join(episodeDir, "visual_reference_plan.json"), null);
  const targets = [];
  for (const target of visualReferencePlan?.reference_targets ?? []) {
    if (!target?.ref_id || !isDerivedReferenceTarget(target)) continue;
    const refPath = referencePathValue(target);
    if (refPath && await exists(refPath)) continue;
    targets.push({ ...target, candidate_image_ids: candidateImageIdsForDerivedTarget(target, promptPlan) });
  }
  if (!targets.length) return null;
  const successIds = successfulImageIdsFromReport(latestImageReport);
  const promotable = targets.filter((target) => (target.candidate_image_ids ?? []).some((id) => successIds.has(id)));
  if (promotable.length) {
    return {
      next_command_shape: imagegenPromoteDerivedRefsCommand(identity),
      evidence: `pending derived refs=${targets.length}; promotable=${promotable.map((target) => target.ref_id).slice(0, 6).join(", ")}${promotable.length > 6 ? ` +${promotable.length - 6} more` : ""}`,
    };
  }
  const seedIds = [...new Set(targets.flatMap((target) => target.candidate_image_ids ?? []))];
  if (seedIds.length) {
    return {
      next_command_shape: scopedImagegenRecoveryCommand(identity, seedIds.slice(0, 60), promptPlan, { seedDerivedRefs: true }),
      evidence: `pending derived refs=${targets.length}; seed cuts needed=${seedIds.slice(0, 8).join(", ")}${seedIds.length > 8 ? ` +${seedIds.length - 8} more` : ""}`,
    };
  }
  return {
    next_command_shape: "Manual reference review required: derived reference targets have no candidate_image_ids and no scene-scoped prompt candidates.",
    evidence: `pending derived refs=${targets.length}; no candidate seed cuts found`,
  };
}

async function imageReportComplete(episodeDir, episode, identity) {
  const promptPlanPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  const promptPlan = await readJson(promptPlanPath, null);
  const currentPromptRows = Array.isArray(promptPlan)
    ? promptPlan
    : Array.isArray(promptPlan?.prompts) ? promptPlan.prompts : [];
  const promptCount = currentPromptRows.length;
  const promptPlanHash = promptCount > 0 ? await fileSha256(promptPlanPath) : null;
  if (!promptCount || !promptPlanHash) {
    return { done: false, evidence: `image files=0/${promptCount || "unknown"}; section_image_prompts_hardened.json missing or empty` };
  }
  const names = await listFiles(episodeDir);
  const reports = [];
  for (const name of names.filter((item) => /^imagegen_report.*\.json$/.test(item))) {
    const filePath = path.join(episodeDir, name);
    const stat = await fs.stat(filePath).catch(() => null);
    const report = await readJson(filePath, null);
    if (!stat?.isFile() || !report) continue;
    reports.push({ name, filePath, report, mtimeMs: stat.mtimeMs });
  }
  reports.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  async function duplicateSummary(report) {
    const byHash = new Map();
    for (const row of report.results ?? []) {
      if (!row?.image_id || !row.image_path || !(await exists(row.image_path))) continue;
      const hash = row.generated?.output_sha256 ?? await fileSha256(row.image_path);
      if (!hash) continue;
      const rows = byHash.get(hash) ?? [];
      rows.push(row.image_id);
      byHash.set(hash, rows);
    }
    return [...byHash.values()].filter((rows) => rows.length > 1).map((rows) => rows.join("="));
  }
  async function duplicateLoserIds(report) {
    const byHash = new Map();
    for (const row of report.results ?? []) {
      if (!row?.image_id || !row.image_path || !(await exists(row.image_path))) continue;
      const hash = row.generated?.output_sha256 ?? await fileSha256(row.image_path);
      if (!hash) continue;
      const rows = byHash.get(hash) ?? [];
      rows.push(String(row.image_id));
      byHash.set(hash, rows);
    }
    return [...byHash.values()].filter((rows) => rows.length > 1).flatMap((rows) => rows.slice(1));
  }
  const latestReport = reports[0]?.report ?? null;
  const cutExecutionLedger = await readJson(path.join(episodeDir, "cut_execution_ledger.json"), null);
  const derivedStatus = await derivedReferenceImagegenStatus(episodeDir, promptPlan, latestReport, identity);
  if (derivedStatus) {
    return {
      done: false,
      evidence: derivedStatus.evidence,
      next_command_shape: derivedStatus.next_command_shape,
    };
  }
  const timingOnlyCreativeCompatibleReports = new Set();
  for (const candidate of reports) {
    const report = candidate.report;
    if (report.prompt_plan_hash === promptPlanHash) continue;
    const status = String(report.status ?? "").toLowerCase();
    const missing = Number(report.missing_image_count ?? report.missing_count ?? 0);
    if (report.reference_only === true || status !== "passed" || missing !== 0) continue;
    if (await imageLedgerMatchesPromptCreativeContractForTests({ promptPlan, ledger: cutExecutionLedger, report })) {
      timingOnlyCreativeCompatibleReports.add(candidate.filePath);
    }
  }
  const passed = reports.find(({ report, filePath }) => {
    const status = String(report.status ?? "").toLowerCase();
    const missing = Number(report.missing_image_count ?? report.missing_count ?? 0);
    const hashOk = report.prompt_plan_hash === promptPlanHash || timingOnlyCreativeCompatibleReports.has(filePath);
    const countOk = Number(report.expected_image_count ?? report.image_count ?? 0) >= promptCount
      && Number(report.image_count ?? 0) >= promptCount;
    return report.reference_only !== true && status === "passed" && missing === 0 && hashOk && countOk;
  });
  if (passed) {
    const duplicates = await duplicateSummary(passed.report);
    if (duplicates.length) {
      const duplicateLosers = await duplicateLoserIds(passed.report);
      return {
        done: false,
        state: "blocked",
        evidence: `${passed.name}; duplicate_hashes=${duplicates.slice(0, 4).join(", ")}${duplicates.length > 4 ? ` +${duplicates.length - 4} more` : ""}`,
        next_command_shape: isBrowserPoolImageProvider(normalizeImageProvider(identity?.image_provider)) && duplicateLosers.length
          ? browserPoolCommand(identity, duplicateLosers, { repair: true })
          : null,
      };
    }
    return { done: true, evidence: `${passed.name}${passed.report.prompt_plan_hash !== promptPlanHash ? "; timing-only prompt rebind verified against per-cut creative hashes and accepted rasters" : ""}` };
  }
  const imageDir = path.join(episodeDir, "assets", "images");
  const imageNames = await listFiles(imageDir);
  const requiredPromptIds = (promptPlan.prompts ?? [])
    .filter((prompt) => prompt?.image_generation_required !== false)
    .map((prompt) => String(prompt.image_id ?? "").trim())
    .filter(Boolean);
  const generatedIdSet = new Set(requiredPromptIds.filter((imageId) =>
    imageNames.some((name) => name.startsWith(`${imageId}-`) && /\.(png|jpe?g|webp)$/i.test(name))
  ));
  const generated = generatedIdSet.size;
  const failedProbe = reports.find(({ report }) => String(report.status ?? "").toLowerCase() === "failed");
  const duplicates = latestReport ? await duplicateSummary(latestReport) : [];
  const failedIds = failedImageIdsFromReport(latestReport);
  const successIds = successfulImageIdsFromReport(latestReport);
  for (const imageId of generatedIdSet) successIds.add(imageId);
  const missingIds = requiredPromptIds.filter((id) => !successIds.has(id));
  if (missingIds.length && latestReport?.prompt_plan_hash === promptPlanHash) {
    const creditIds = codexCreditFallbackEnabled(identity) ? creditExhaustedIdsFromReport(latestReport) : [];
    const creditIdSet = new Set(creditIds);
    const providerRecoveryIds = missingIds.filter((id) => !creditIdSet.has(id));
    const skippedCount = (latestReport?.results ?? []).filter((row) =>
      row?.image_id && String(row.status ?? "").toLowerCase() === "skipped_provider_circuit_open"
    ).length;
    let providerRecoveryCommand = providerRecoveryIds.length
      ? scopedImagegenRecoveryCommand(identity, providerRecoveryIds, promptPlan)
      : null;
    if (providerRecoveryIds.length && isBrowserPoolImageProvider(normalizeImageProvider(identity?.image_provider))) {
      const deadletters = await hybridDeadletteredAssetIds(episodeDir, "scene", currentPromptRows);
      const exactFailedIds = providerRecoveryIds.filter((id) => deadletters.has(id));
      providerRecoveryCommand = exactFailedIds.length
        ? browserPoolCommand(identity, exactFailedIds, { repair: true })
        : browserPoolCommand(identity);
    }
    const recoveryCommands = [
      creditIds.length ? codexCreditFallbackCommand(identity, creditIds) : null,
      providerRecoveryCommand,
    ].filter(Boolean);
    return {
      done: false,
      evidence: `image files=${generated}/${promptCount || "unknown"}; recovery cuts=${missingIds.slice(0, 8).join(", ")}${missingIds.length > 8 ? ` +${missingIds.length - 8} more` : ""}${failedIds.length ? `; failed=${failedIds.length}` : ""}${skippedCount ? `; skipped_provider_circuit_open=${skippedCount}` : ""}${creditIds.length ? `; modelslab_credit_exhausted=${creditIds.length}; codex_fallback=approved` : ""}`,
      next_command_shape: recoveryCommands.join("; then "),
    };
  }
  if (failedIds.length) {
    const creditIds = codexCreditFallbackEnabled(identity) ? creditExhaustedIdsFromReport(latestReport) : [];
    return {
      done: false,
      evidence: `image files=${generated}/${promptCount || "unknown"}; failed cuts=${failedIds.slice(0, 8).join(", ")}${failedIds.length > 8 ? ` +${failedIds.length - 8} more` : ""}${creditIds.length ? `; modelslab_credit_exhausted=${creditIds.length}; codex_fallback=approved` : ""}`,
      next_command_shape: creditIds.length
        ? codexCreditFallbackCommand(identity, creditIds)
        : scopedImagegenRecoveryCommand(identity, failedIds, promptPlan),
    };
  }
  const hybridProvider = isBrowserPoolImageProvider(normalizeImageProvider(identity?.image_provider));
  const hybridDeadletters = hybridProvider
    ? await hybridDeadletteredAssetIds(episodeDir, "scene", currentPromptRows)
    : new Set();
  const hybridFailedIds = requiredPromptIds.filter((id) => !successIds.has(id) && hybridDeadletters.has(id));
  return {
    done: !hybridProvider && promptCount > 0 && generated >= promptCount && duplicates.length === 0,
    evidence: `image files=${generated}/${promptCount || "unknown"}${duplicates.length ? `; duplicate_hashes=${duplicates.slice(0, 4).join(", ")}${duplicates.length > 4 ? ` +${duplicates.length - 4} more` : ""}` : ""}${failedProbe ? `; failed probe/report also present: ${failedProbe.name}` : ""}`,
    next_command_shape: hybridProvider
      ? hybridFailedIds.length
        ? browserPoolCommand(identity, hybridFailedIds, { repair: true })
        : browserPoolCommand(identity)
      : usesCodexSceneCuts(identity)
      ? scopedImagegenRecoveryCommand(identity, (promptPlan.prompts ?? []).filter((prompt) => prompt?.image_generation_required !== false).map((prompt) => String(prompt.image_id)), promptPlan)
      : imagegenStartCommand(identity),
  };
}

async function referenceGenerationComplete(episodeDir, identity, currentScriptHash) {
  const planPath = path.join(episodeDir, "visual_reference_plan.json");
  const plan = await readJson(planPath, null);
  if (!plan) return { done: false, evidence: "visual_reference_plan.json missing" };
  const characterRefs = await readJson(path.join(episodeDir, "character_state_refs.json"), null);
  const characterStatus = String(characterRefs?.status ?? "").toLowerCase();
  const targets = Array.isArray(plan.reference_targets) ? plan.reference_targets : [];
  const required = targets.filter((target) => {
    const mode = String(target.generation_mode ?? "");
    return Boolean(target.required_before_imagegen)
      || mode === "standalone_ref";
  });
  const missing = [];
  const byHash = new Map();
  let present = 0;
  if (!required.length) {
    return {
      done: true,
      evidence: "required refs=0/0; no standalone reference images required",
    };
  }
  for (const target of required) {
    const targetPath = referencePathValue(target);
    if (targetPath && await exists(targetPath)) {
      present += 1;
      const hash = await fileSha256(targetPath);
      if (hash) {
        const rows = byHash.get(hash) ?? [];
        rows.push(target.ref_id ?? target.id ?? "unknown_ref");
        byHash.set(hash, rows);
      }
    } else {
      missing.push(target.ref_id ?? target.id ?? "unknown_ref");
    }
  }
  const duplicates = [...byHash.values()].filter((rows) => rows.length > 1);
  const duplicateSummary = duplicates.map((rows) => rows.join("="));
  if (!missing.length && !duplicates.length && isBrowserPoolImageProvider(normalizeImageProvider(identity?.image_provider))) {
    const recovery = await readReferenceImageQaRecoveryScope({ episodeDir, episode: identity.episode,
      plan, currentScriptHash });
    if (recovery) return { done: false, state: "blocked",
      evidence: `reference_image_qa_${identity.episode}.json; current reviewed rejected refs=${recovery.rejected_ref_ids.join(",")}`,
      next_command_shape: browserPoolCommand(identity, recovery.rejected_ref_ids, { references: true, qaRecovery: true, repair: true }),
      reference_image_qa_recovery_scope: recovery };
  }
  let fallbackCommand = null;
  let fallbackEvidence = "";
  if (missing.length && isBrowserPoolImageProvider(normalizeImageProvider(identity?.image_provider))) {
    const deadletters = await hybridDeadletteredAssetIds(episodeDir, "reference", plan.reference_targets ?? []);
    const exactFailedIds = missing.filter((id) => deadletters.has(id));
    fallbackCommand = exactFailedIds.length
      ? browserPoolCommand(identity, exactFailedIds, { references: true, repair: true })
      : browserPoolCommand(identity, [], { references: true });
    fallbackEvidence = exactFailedIds.length
      ? `; hybrid_browser_pool_repair=${exactFailedIds.length}`
      : `; hybrid_browser_pool_initial=${missing.length}`;
  } else if (missing.length && usesCodexReferences(identity)) {
    fallbackCommand = codexWorkCommand(identity, missing, { references: true });
    fallbackEvidence = `; codex_worker_queue=${missing.length}`;
  } else if (missing.length && codexCreditFallbackEnabled(identity)) {
    const reports = await matchingJsonReports(episodeDir, new RegExp(`^imagegen_report_${identity.episode ?? "ep_01"}.*\\.json$`));
    const latestReferenceReport = reports
      .filter(({ report }) => report?.reference_only === true)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.report ?? null;
    const creditRefIds = creditExhaustedIdsFromRows(latestReferenceReport?.reference_results ?? [], "ref_id")
      .filter((refId) => missing.includes(refId));
    if (creditRefIds.length) {
      fallbackCommand = codexCreditFallbackCommand(identity, creditRefIds, { references: true });
      fallbackEvidence = `; modelslab_credit_exhausted=${creditRefIds.length}; codex_fallback=approved`;
    }
  }
  return {
    done: required.length > 0 && missing.length === 0 && duplicates.length === 0,
    ...(!missing.length && duplicates.length ? { state: "blocked" } : {}),
    evidence: `required refs=${present}/${required.length}${missing.length ? `; missing=${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` +${missing.length - 8} more` : ""}` : ""}${duplicates.length ? `; duplicate_hashes=${duplicateSummary.slice(0, 4).join(", ")}${duplicates.length > 4 ? ` +${duplicates.length - 4} more` : ""}` : ""}${fallbackEvidence}`,
    next_command_shape: fallbackCommand
      ?? (!missing.length && duplicates.length && isBrowserPoolImageProvider(normalizeImageProvider(identity?.image_provider))
        ? browserPoolCommand(identity, duplicates.flatMap((rows) => rows.slice(1)), { references: true, repair: true })
        : null),
  };
}

async function referenceImageApprovalComplete(episodeDir, episode) {
  const characterRefs = await readJson(path.join(episodeDir, "character_state_refs.json"), null);
  const approval = await readJson(path.join(episodeDir, `visual_reference_approval_${episode}.json`), null);
  const characterStatus = String(characterRefs?.status ?? "").toLowerCase();
  const approvalStatus = String(approval?.status ?? "").toLowerCase();
  const done = ["approved", "passed"].includes(characterStatus)
    && ["approved", "passed"].includes(approvalStatus);
  return {
    done,
    evidence: done
      ? `visual_reference_approval_${episode}.json status=${approvalStatus}`
      : `generated reference approval missing; character_state_refs status=${characterStatus || "missing"}`,
  };
}

async function longformMixComplete(episodeDir, episode, identity) {
  const latest = await latestMatching(episodeDir, new RegExp(`^longform_audio_bed_report_${episode}.*\\.json$`));
  if (!latest) return { done: false, evidence: null };
  const report = await readJson(latest.filePath, {});
  const status = String(report.status ?? "").toLowerCase();
  if (!["passed", "completed"].includes(status)) {
    return { done: false, state: status === "failed" ? "failed" : "blocked", evidence: `${latest.name} status=${status || "missing"}` };
  }
  const finalAudio = report.final_audio_path
    ?? report.final_m4a_path
    ?? report.output_m4a_path
    ?? report.output_path
    ?? report.mix?.m4a_path
    ?? report.mix?.wav_path;
  if (!finalAudio || !(await exists(finalAudio))) return { done: false, evidence: `${latest.name}; final audio missing` };

  if (report.narration_path) {
    const narrationReportPath = report.narration_report_path
      ?? report.qwen_report_path
      ?? stitchReportPathForIdentity(episodeDir, episode, identity);
    const narrationReport = await readJson(narrationReportPath, null);
    const currentNarrationPath = narrationReport?.output_path ?? null;
    if (!currentNarrationPath || !(await exists(currentNarrationPath))) {
      return { done: false, state: "stale", evidence: `${latest.name}; current stitched narration missing` };
    }
    if (path.resolve(report.narration_path) !== path.resolve(currentNarrationPath)) {
      return { done: false, state: "stale", evidence: `${latest.name}; narration path does not match current stitch report` };
    }
    const currentDuration = Number(narrationReport.final_duration_sec);
    const reportDuration = Number(report.narration_duration_sec);
    if (Number.isFinite(currentDuration) && Number.isFinite(reportDuration) && Math.abs(currentDuration - reportDuration) > 0.25) {
      return { done: false, state: "stale", evidence: `${latest.name}; narration duration does not match current stitch report` };
    }
    const expectedReportHash = report.narration_report_sha256 ?? report.qwen_report_sha256;
    if (expectedReportHash && await fileSha256(narrationReportPath) !== expectedReportHash) {
      return { done: false, state: "stale", evidence: `${latest.name}; narration stitch report hash stale` };
    }
    if (report.narration_sha256 && await fileSha256(currentNarrationPath) !== report.narration_sha256) {
      return { done: false, state: "stale", evidence: `${latest.name}; narration audio hash stale` };
    }
  }
  if (report.final_audio_sha256 && await fileSha256(finalAudio) !== report.final_audio_sha256) {
    return { done: false, state: "stale", evidence: `${latest.name}; final mix hash stale` };
  }
  const narrationQualityContract = narrationQualityContractForIdentity(identity);
  if (narrationQualityContract && report.narration_only === true) {
    const mastering = report.mix?.mastering ?? null;
    const masteringPath = report.mix?.mastering_report_path ?? null;
    const masteringFile = masteringPath ? await readJson(masteringPath, null) : null;
    const masteringCurrent = mastering?.status === "passed"
      && masteringFile?.status === "passed"
      && mastering?.output_sha256 === masteringFile?.output_sha256
      && mastering?.input_sha256 === report.narration_sha256
      && Number(mastering?.policy?.target_lufs)
        === Number(narrationQualityContract.mastering.integrated_lufs_target)
      && Number(mastering?.policy?.true_peak_dbtp_max)
        === Number(narrationQualityContract.mastering.true_peak_dbtp_max)
      && Number(mastering?.duration_delta_ms)
        <= Number(narrationQualityContract.mastering.duration_delta_ms_max)
      && mastering?.policy?.tempo_processing === false
      && mastering?.policy?.broadband_denoise === false
      && mastering?.policy?.per_unit_normalization === false;
    if (!masteringCurrent) {
      return {
        done: false,
        state: "stale",
        evidence: `${latest.name}; deterministic two-pass narration mastering report missing or stale`,
      };
    }
  }
  return {
    done: true,
    evidence: `${latest.name} -> ${finalAudio}; narration source current`,
  };
}

async function sourceHashState(sourceHashes = {}) {
  const entries = Object.entries(sourceHashes ?? {}).filter(([sourcePath, hash]) => sourcePath && hash);
  const stale = [];
  for (const [sourcePath, expectedHash] of entries) {
    const currentHash = await fileSha256(sourcePath);
    if (currentHash !== expectedHash) stale.push(sourcePath);
  }
  return { count: entries.length, stale };
}

async function renderComplete(episodeDir, episode, identity) {
  const latest = await latestMatching(episodeDir, new RegExp(`^render_report_${episode}.*\\.json$`));
  if (!latest) return { done: false, evidence: null };
  const report = await readJson(latest.filePath, {});
  const finalVideo = report.final_video_path ?? report.output_path ?? report.render_path;
  const status = String(report.status ?? "").toLowerCase();
  if (status !== "passed") return { done: false, state: status === "failed" ? "failed" : "blocked", evidence: `${latest.name} status=${status || "missing"}` };
  if (!finalVideo || !(await exists(finalVideo))) return { done: false, evidence: `${latest.name}; final video missing` };
  const expectedHash = report.final_video_sha256 ?? report.output_hash ?? null;
  const currentHash = await fileSha256(finalVideo);
  if (!expectedHash || currentHash !== expectedHash) {
    return { done: false, state: "stale", evidence: `${latest.name}; final video hash missing or stale` };
  }
  const sourceState = await sourceHashState(report.source_hashes);
  if (sourceState.stale.length) {
    return { done: false, state: "stale", evidence: `${latest.name}; stale render sources=${sourceState.stale.slice(0, 4).join(", ")}` };
  }
  if (identity.run_identity_schema === "goldflow_run_identity_v2" && sourceState.count === 0) {
    return { done: false, state: "stale", evidence: `${latest.name}; v2 render report has no source hashes` };
  }
  return {
    done: true,
    evidence: `${latest.name} -> ${finalVideo}; source_hashes=${sourceState.count}`,
  };
}

async function finalQaComplete(episodeDir, episode, identity) {
  const exactPath = path.join(episodeDir, `final_qa_${episode}.json`);
  const legacyLatest = identity.run_identity_schema === "goldflow_run_identity_v2"
    ? null
    : await latestMatching(episodeDir, /^final_qa_.*\.json$|^upload_qa_.*\.json$|^qa_report_.*\.json$/);
  const reportPath = await exists(exactPath) ? exactPath : legacyLatest?.filePath ?? null;
  if (!reportPath) return { done: false, evidence: `final_qa_${episode}.json missing` };
  const report = await readJson(reportPath, null);
  const status = String(report?.status ?? "").toLowerCase();
  if (identity.run_identity_schema !== "goldflow_run_identity_v2") {
    if (!status || ["passed", "approved", "complete", "completed"].includes(status)) {
      return { done: true, evidence: `${path.basename(reportPath)} legacy adapter` };
    }
    return { done: false, state: status === "failed" ? "failed" : "blocked", evidence: `${path.basename(reportPath)} status=${status}` };
  }
  if (status !== "passed") return { done: false, state: status === "failed" ? "failed" : "blocked", evidence: `${path.basename(reportPath)} status=${status || "missing"}` };
  const finalVideoPath = report.final_video_path;
  const finalVideoHash = finalVideoPath ? await fileSha256(finalVideoPath) : null;
  if (!finalVideoHash || finalVideoHash !== report.final_video_sha256) {
    return { done: false, state: "stale", evidence: `${path.basename(reportPath)} final video hash stale` };
  }
  const renderReportPath = report.render_report_path;
  const renderReportHash = renderReportPath ? await fileSha256(renderReportPath) : null;
  if (!renderReportHash || renderReportHash !== report.render_report_sha256) {
    return { done: false, state: "stale", evidence: `${path.basename(reportPath)} render report hash stale` };
  }
  if (Array.isArray(report.blockers) && report.blockers.length) {
    return { done: false, state: "blocked", evidence: `${path.basename(reportPath)} blockers=${report.blockers.join(",")}` };
  }
  return { done: true, evidence: `${path.basename(reportPath)} status=passed; hashes=current` };
}

async function imageOutputQaComplete(episodeDir, episode, identity) {
  if (!imageOutputQaRequired(identity)) return { done: true, evidence: "skipped for legacy run identity; new preflights require output QA" };
  const reportPath = path.join(episodeDir, `image_output_qa_${episode}.json`);
  const report = await readJson(reportPath, null);
  if (!report) return { done: false, evidence: `image_output_qa_${episode}.json missing` };
  const imagegenReportPath = path.join(episodeDir, `imagegen_report_${episode}.json`);
  const [qaMtime, imagegenMtime] = await Promise.all([fileMtimeMs(reportPath), fileMtimeMs(imagegenReportPath)]);
  if (imagegenMtime > qaMtime) {
    return {
      done: false,
      evidence: `${path.basename(reportPath)} is stale after newer image generation`,
      next_command_shape: commandFor("image_output_qa", identity),
    };
  }
  const status = String(report.status ?? "").toLowerCase();
  if (status === "passed" && identity.run_identity_schema === "goldflow_run_identity_v2") {
    const decisionsPath = report.review_decisions_path ?? path.join(episodeDir, `image_output_review_decisions_${episode}.json`);
    const decisions = await readJson(decisionsPath, null);
    const decisionsHash = await fileSha256(decisionsPath);
    const rows = Array.isArray(decisions?.decisions) ? decisions.decisions : [];
    const unresolvedDecision = rows.find((row) => String(row?.decision ?? "").toLowerCase() === "not_inspected");
    if (!decisionsHash || decisionsHash !== report.review_decisions_sha256) {
      return { done: false, state: "stale", evidence: `${path.basename(reportPath)} review decisions hash stale`, next_command_shape: commandFor("image_output_qa", identity) };
    }
    if (String(decisions?.status ?? "").toLowerCase() !== "complete" || unresolvedDecision) {
      return { done: false, state: "blocked", evidence: `${path.basename(decisionsPath)} has unresolved per-cut decisions`, next_command_shape: commandFor("image_output_qa", identity) };
    }
  }
  if (status === "passed") return { done: true, evidence: `${path.basename(reportPath)} passed; risk_cuts=${report.risk_cut_count ?? "?"}` };
  return {
    done: false,
    evidence: `${path.basename(reportPath)} status=${status || "missing"}; blockers=${report.unresolved_blocker_count ?? "?"}`,
    next_command_shape: report.next_command ?? commandFor("image_output_qa", identity),
  };
}

async function imageFocalAnalysisComplete(episodeDir, episode) {
  const reportPath = path.join(episodeDir, `image_focal_analysis_${episode}.json`);
  const report = await readJson(reportPath, null);
  if (!report) return { done: false, evidence: `${path.basename(reportPath)} missing` };
  const status = String(report.status ?? "").toLowerCase();
  if (status !== "passed") {
    return { done: false, state: status === "failed" ? "failed" : "blocked", evidence: `${path.basename(reportPath)} status=${status || "missing"}` };
  }
  const promptPath = report.prompt_plan_path ?? path.join(episodeDir, "section_image_prompts_hardened.json");
  const imagegenPath = report.imagegen_report_path ?? path.join(episodeDir, `imagegen_report_${episode}.json`);
  const [promptHash, imagegenHash] = await Promise.all([fileSha256(promptPath), fileSha256(imagegenPath)]);
  if (!promptHash || promptHash !== report.prompt_plan_sha256 || !imagegenHash || imagegenHash !== report.imagegen_report_sha256) {
    return { done: false, state: "stale", evidence: `${path.basename(reportPath)} source hashes stale`, next_command_shape: `node bin/goldflow.mjs imagegen analyze --episode-dir ${episodeDir}` };
  }
  if (!Array.isArray(report.analyses) || report.analyses.length !== Number(report.image_count ?? -1)) {
    return { done: false, state: "failed", evidence: `${path.basename(reportPath)} analysis count mismatch` };
  }
  return { done: true, evidence: `${path.basename(reportPath)} passed; images=${report.image_count}; exceptions=${report.composition_exception_count ?? 0}` };
}

async function parallaxAssetGenerationComplete(episodeDir, episode) {
  const reportPath = path.join(episodeDir, `parallax_asset_report_${episode}.json`);
  const report = await readJson(reportPath, null);
  if (!report) return { done: false, evidence: `${path.basename(reportPath)} missing` };
  const status = String(report.status ?? "").toLowerCase();
  if (status !== "passed") {
    return {
      done: false,
      state: status === "failed" ? "failed" : "blocked",
      evidence: `${path.basename(reportPath)} status=${status || "missing"}; blockers=${(report.blockers ?? []).map((row) => row.code ?? row).join(",") || "none"}`,
      next_command_shape: report.next_command_shape ?? null,
    };
  }
  const sourceState = await sourceHashState(report.source_hashes);
  if (!sourceState.count || sourceState.stale.length) {
    return { done: false, state: "stale", evidence: `${path.basename(reportPath)} source hashes stale or missing` };
  }
  if (report.asset_contract_sha256 !== parallaxAssetContractSha256(report)) {
    return { done: false, state: "stale", evidence: `${path.basename(reportPath)} asset contract hash stale` };
  }
  const candidates = Array.isArray(report.candidates) ? report.candidates : [];
  if (Number(report.candidate_count ?? 0) !== candidates.length) {
    return { done: false, state: "failed", evidence: `${path.basename(reportPath)} candidate count mismatch` };
  }
  if (!candidates.length) {
    return { done: true, evidence: `${path.basename(reportPath)} candidates=0; accepted still/single-plane fallback` };
  }
  if (!report.review_sheet_path || !(await exists(report.review_sheet_path))) {
    return { done: false, state: "stale", evidence: `${path.basename(reportPath)} review sheet missing` };
  }
  for (const candidate of candidates) {
    for (const [assetPath, expectedHash] of [
      [candidate.image_path, candidate.image_sha256],
      [candidate.asset_report?.mask_path, candidate.asset_report?.mask_sha256],
      [candidate.asset_report?.foreground_path, candidate.asset_report?.foreground_sha256],
      [candidate.asset_report?.background_path, candidate.asset_report?.background_sha256],
    ]) {
      if (!assetPath || !expectedHash || await fileSha256(assetPath) !== expectedHash) {
        return { done: false, state: "stale", evidence: `${path.basename(reportPath)} stale asset for ${candidate.image_id}: ${assetPath ?? "missing path"}` };
      }
    }
  }
  return { done: true, evidence: `${path.basename(reportPath)} candidates=${candidates.length}; review sheet=current` };
}

async function generatedMotionGenerationComplete(episodeDir, episode, identity) {
  const generic = generatedMotionArtifactPaths(episodeDir, episode);
  const legacyPath = path.join(episodeDir, "assets", "motion", "ltx23", `ltx_video_report_${episode}.json`);
  const provider = generatedMotionProviderForIdentity(identity);
  const reportPath = await exists(generic.reportPath)
    ? generic.reportPath
    : provider === GENERATED_MOTION_PROVIDER_LTX ? legacyPath : generic.reportPath;
  const report = await readJson(reportPath, null);
  if (!report) return { done: false, evidence: `${path.basename(reportPath)} missing` };
  if (report.status !== "passed" || Number(report.failed_count ?? 0) > 0) {
    return {
      done: false,
      state: report.status === "failed" ? "failed" : "blocked",
      evidence: `${path.basename(reportPath)} status=${report.status ?? "missing"}; failed=${report.failed_count ?? "?"}`,
    };
  }
  const validSchema = report.schema === GENERATED_MOTION_REPORT_SCHEMA
    || (provider === GENERATED_MOTION_PROVIDER_LTX && report.schema === "goldflow_ltx23_video_report_v1");
  if (!validSchema) return { done: false, state: "failed", evidence: `${path.basename(reportPath)} schema invalid for ${provider}` };
  const sourceState = await sourceHashState(report.source_hashes);
  if (!sourceState.count || sourceState.stale.length) {
    return { done: false, state: "stale", evidence: `${path.basename(reportPath)} source hashes stale or missing` };
  }
  for (const clip of report.clips ?? []) {
    if (await fileSha256(clip.source_image_path) !== clip.source_image_sha256
      || await fileSha256(clip.normalized_video_path) !== clip.normalized_video_sha256) {
      return { done: false, state: "stale", evidence: `${path.basename(reportPath)} stale clip/source for ${clip.image_id}` };
    }
  }
  const requiredFindings = requiredGeneratedMotionCoverageFindings(report);
  if (requiredFindings.length) {
    return {
      done: false,
      state: "blocked",
      evidence: `${path.basename(reportPath)} required opening Flow clips missing: ${requiredFindings.map((row) => row.image_id).join(", ")}`,
    };
  }
  return {
    done: true,
    evidence: `${path.basename(reportPath)} generated=${report.generated_count}; omitted_to_still=${report.omitted_count ?? 0}; hashes=current`,
  };
}

async function animationDirectionPlanComplete(episodeDir, episode) {
  const reportPath = path.join(episodeDir, `animation_direction_plan_${episode}.json`);
  const report = await readJson(reportPath, null);
  if (!report) return { done: false, evidence: `${path.basename(reportPath)} missing` };
  const directions = report.directions ?? [];
  const validEmptyFallback = directions.length === 0
    && report.no_suitable_motion_fallback?.disposition === "accepted_stills_for_all_cuts";
  if (report.schema !== "goldflow_animation_direction_plan_v1" || report.status !== "passed"
    || (!directions.length && !validEmptyFallback)) {
    return { done: false, state: report.status === "failed" ? "failed" : "blocked", evidence: `${path.basename(reportPath)} invalid or empty without still fallback` };
  }
  const sourceState = await sourceHashState(report.source_hashes);
  if (!sourceState.count || sourceState.stale.length) {
    return { done: false, state: "stale", evidence: `${path.basename(reportPath)} source hashes stale or missing` };
  }
  for (const row of directions) {
    if (await fileSha256(row.source_image_path) !== row.source_image_sha256 || !String(row.motion_prompt ?? "").trim()) {
      return { done: false, state: "stale", evidence: `${path.basename(reportPath)} stale image or missing direction for ${row.image_id}` };
    }
  }
  return {
    done: true,
    evidence: `${path.basename(reportPath)} directions=${report.direction_count}; candidates=${report.candidate_generation_count}; still_fallbacks=${report.still_fallback_count ?? 0}; hashes=current`,
  };
}

async function generatedMotionApprovalComplete(episodeDir, episode, identity) {
  const generic = generatedMotionArtifactPaths(episodeDir, episode);
  const legacyBase = path.join(episodeDir, "assets", "motion", "ltx23");
  const provider = generatedMotionProviderForIdentity(identity);
  const useGeneric = await exists(generic.reportPath);
  const reportPath = useGeneric
    ? generic.reportPath
    : provider === GENERATED_MOTION_PROVIDER_LTX
      ? path.join(legacyBase, `ltx_video_report_${episode}.json`)
      : generic.reportPath;
  const approvalPath = useGeneric
    ? generic.approvalPath
    : provider === GENERATED_MOTION_PROVIDER_LTX
      ? path.join(legacyBase, `ltx_video_approval_${episode}.json`)
      : generic.approvalPath;
  const [report, approval] = await Promise.all([readJson(reportPath, null), readJson(approvalPath, null)]);
  if (!report || !approval) return { done: false, evidence: `${path.basename(approvalPath)} missing` };
  if (!await generatedMotionApprovalMatches(report, approval, { reportPath })) {
    return { done: false, state: "stale", evidence: `${path.basename(approvalPath)} decisions or hashes stale` };
  }
  return { done: true, evidence: `${path.basename(approvalPath)} accepted=${approval.accepted_count}; rejected=${approval.rejected_count}` };
}

async function parallaxAssetApprovalComplete(episodeDir, episode) {
  const reportPath = path.join(episodeDir, `parallax_asset_report_${episode}.json`);
  const approvalPath = path.join(episodeDir, `parallax_asset_approval_${episode}.json`);
  const [report, approval, reportHash] = await Promise.all([
    readJson(reportPath, null),
    readJson(approvalPath, null),
    fileSha256(reportPath),
  ]);
  if (report?.status !== "passed") return { done: false, evidence: `${path.basename(reportPath)} not passed` };
  if (!Number(report.candidate_count ?? 0)) {
    return { done: true, evidence: `${path.basename(reportPath)} candidates=0; approval skipped for still/single-plane fallback` };
  }
  if (!approval) return { done: false, evidence: `${path.basename(approvalPath)} missing` };
  if (!parallaxApprovalMatches(report, approval, { reportSha256: reportHash })) {
    return { done: false, state: "stale", evidence: `${path.basename(approvalPath)} decisions or hashes stale` };
  }
  return {
    done: true,
    evidence: `${path.basename(approvalPath)} approved=${approval.approved_image_ids?.length ?? 0}; low_motion=${approval.approved_low_motion_image_ids?.length ?? 0}; repairable=${approval.repairable_image_ids?.length ?? 0}; declined=${approval.declined_image_ids?.length ?? 0}`,
  };
}

async function scriptApprovalComplete(episodeDir, currentScriptHash) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const approvalPath = path.join(episodeDir, "operator_script_approval.json");
  const lockPath = path.join(episodeDir, "script_lock.json");
  const approval = await readJson(approvalPath, null);
  const lock = await readJson(lockPath, null);
  const approvalHash = approval?.script_clean_hash ?? approval?.script_hash ?? null;
  const lockHash = lock?.script_clean_hash ?? lock?.script_hash ?? null;
  const done = Boolean(approval?.operator_approved && approvalHash === currentScriptHash && lockHash === currentScriptHash);
  return {
    done,
    evidence: done ? `operator_script_approval.json -> ${currentScriptHash}` : `stale/missing approval for current script hash ${currentScriptHash}`,
  };
}

async function jsonArtifactHashComplete(filePath, currentScriptHash, label) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const artifact = await readJson(filePath, null);
  if (!artifact) return { done: false, evidence: `${label} missing` };
  const artifactHash = artifact.script_clean_hash
    ?? artifact.script_hash
    ?? artifact.source_script_hash
    ?? artifact.source_hash
    ?? null;
  const status = String(artifact.status ?? "").toLowerCase();
  const statusOk = !status || ["passed", "completed", "approved", "skipped", "draft_needs_manual_review"].includes(status);
  const done = artifactHash === currentScriptHash && statusOk;
  return {
    done,
    evidence: done
      ? `${label} -> ${currentScriptHash}${status ? `; status=${status}` : ""}`
      : `${label} ${status || "missing_status"} for hash ${artifactHash ?? "none"}; required hash ${currentScriptHash}`,
  };
}

async function paceReportComplete(filePath, currentScriptHash, label, identity = {}) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const report = await readJson(filePath, null);
  if (!report) return { done: false, evidence: `${label} missing` };
  const artifactHash = report.source_script_hash ?? report.script_clean_hash ?? report.script_hash ?? null;
  const min = Number(report.target_wpm_min);
  const max = Number(report.target_wpm_max);
  const requiredMin = targetWpmMin(identity);
  const requiredMax = targetWpmMax(identity);
  const requiredRange = targetWpmRange(identity);
  const status = String(report.status ?? "").toLowerCase();
  const hookWarnings = Array.isArray(report.hook_milestone_report?.warnings)
    ? report.hook_milestone_report.warnings
    : [];
  const hookGateEnforced = report.hook_gate_enforced !== false && report.allow_hook_warnings !== true;
  const scriptHookBlocked = label === "script_pace_report.json" && hookWarnings.length > 0 && hookGateEnforced;
  const sourceHashes = report.source_hashes && typeof report.source_hashes === "object" && !Array.isArray(report.source_hashes)
    ? report.source_hashes
    : null;
  const staleSource = sourceHashes
    ? (await Promise.all(Object.entries(sourceHashes).map(async ([sourcePath, expectedHash]) => {
      const actualHash = await fileSha256(sourcePath);
      return actualHash && expectedHash && actualHash !== expectedHash ? `${path.basename(sourcePath)} stale` : null;
    }))).filter(Boolean)[0] ?? null
    : null;
  const audioWpmDiagnostic = label.startsWith("narration_pace_report_") && Number.isFinite(Number(report.actual_wpm));
  const statusAccepted = status === "passed" || (audioWpmDiagnostic && status === "blocked");
  const done = artifactHash === currentScriptHash && statusAccepted && min === requiredMin && max === requiredMax && !scriptHookBlocked && !staleSource;
  const wpm = Number.isFinite(Number(report.actual_wpm)) ? `; actual_wpm=${Number(report.actual_wpm).toFixed(3)}` : "";
  const hook = scriptHookBlocked ? `; hook_warnings=${hookWarnings.length}` : "";
  const sourceHashEvidence = sourceHashes ? (staleSource ? `; ${staleSource}` : "; source_hashes=current") : "; source_hashes=missing";
  return {
    done,
    evidence: done
      ? `${label} -> ${currentScriptHash}; target_wpm=${requiredRange}${wpm}${sourceHashEvidence}`
      : `${label} ${status || "missing"} for hash ${artifactHash ?? "none"} target ${Number.isFinite(min) ? min : "?"}-${Number.isFinite(max) ? max : "?"}; required hash ${currentScriptHash} target ${requiredRange}${wpm}${hook}${sourceHashEvidence}`,
  };
}

async function audioPaceRecoveryCommand(episodeDir, identity) {
  void episodeDir;
  void identity;
  return null;
}

async function whisperTimingComplete(episodeDir, episode, currentScriptHash, identity) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const timingPath = path.join(episodeDir, `narration_word_timing_${episode}.json`);
  const stitchPath = stitchReportPathForIdentity(episodeDir, episode, identity);
  const timing = await readJson(timingPath, null);
  if (!timing) return { done: false, evidence: `narration_word_timing_${episode}.json missing` };
  const artifactHash = timing.source_script_hash ?? null;
  if (artifactHash !== currentScriptHash) {
    return { done: false, evidence: `narration_word_timing_${episode}.json hash ${artifactHash ?? "none"}; required hash ${currentScriptHash}` };
  }
  const proofImport = await proofBaselineImportArtifactComplete({
    episodeDir,
    episode,
    currentScriptHash,
    identity,
    artifact: timing,
    artifactPath: timingPath,
    label: `narration_word_timing_${episode}.json`,
  });
  if (proofImport.applicable) return { done: proofImport.done, evidence: proofImport.evidence };
  const stitch = await readJson(stitchPath, null);
  const currentAudioPath = stitch?.output_path ?? null;
  const currentAudioHash = currentAudioPath ? await fileSha256(currentAudioPath) : null;
  if (currentAudioHash && timing.narration_audio_hash !== currentAudioHash) {
    return {
      done: false,
      evidence: `narration_word_timing_${episode}.json stale audio hash ${timing.narration_audio_hash ?? "none"}; current audio hash ${currentAudioHash}`,
    };
  }
  const reportContract = validateLockedLocalWhisperReport(timing, identity);
  if (!reportContract.done) {
    return {
      done: false,
      evidence: `narration_word_timing_${episode}.json ${reportContract.evidence}`,
    };
  }
  if (reportContract.mode === "locked") {
    const scriptPath = path.join(episodeDir, "script_clean.md");
    const runIdentityPath = path.join(episodeDir, "run_identity.json");
    const [stitchHash, runIdentityHash] = await Promise.all([
      fileSha256(stitchPath),
      fileSha256(runIdentityPath),
    ]);
    const sourceHashes = timing.source_hashes
      && typeof timing.source_hashes === "object"
      && !Array.isArray(timing.source_hashes)
      ? timing.source_hashes
      : {};
    const provenanceMismatches = [];
    if (sourceHashes[scriptPath] !== currentScriptHash) {
      provenanceMismatches.push("source_hashes.script_clean.md");
    }
    if (!currentAudioPath
      || sourceHashes[currentAudioPath] !== currentAudioHash) {
      provenanceMismatches.push("source_hashes.narration_audio");
    }
    if (!stitchHash || timing.narration_report_sha256 !== stitchHash) {
      provenanceMismatches.push("narration_report_sha256");
    }
    if (!runIdentityHash || timing.run_identity_sha256 !== runIdentityHash) {
      provenanceMismatches.push("run_identity_sha256");
    }
    if (provenanceMismatches.length) {
      return {
        done: false,
        evidence:
          `narration_word_timing_${episode}.json hash provenance stale: `
          + provenanceMismatches.join(", "),
      };
    }
  }
  const manualMediumRepairs = (timing.manual_timing_repairs ?? []).filter(
    (repair) => repair?.alignment_contract?.model === "medium"
      || repair?.method === "independent_exact_unit_medium_whisper",
  );
  const modernManualMediumRecovery = reportContract.mode === "locked"
    || manualMediumRepairs.some(
      (repair) => repair?.alignment_contract?.contract_version
        === "local_whisper_manual_structural_recovery_v1",
    );
  if (manualMediumRepairs.length && modernManualMediumRecovery) {
    const triagePath = path.join(
      episodeDir,
      `manual_blocker_triage_local_whisper_word_timing_${episode}.json`,
    );
    const [triage, timingSha256] = await Promise.all([
      readJson(triagePath, null),
      fileSha256(timingPath),
    ]);
    const triageCurrent = triage?.stage === "local_whisper_word_timing"
      && triage?.resolution === "hash_bound_exact_unit_timing_repair"
      && triage?.evidence_reviewed?.source_script_sha256
        === currentScriptHash
      && triage?.evidence_reviewed?.narration_audio_sha256
        === timing.narration_audio_hash
      && triage?.repair?.repaired_timing_sha256 === timingSha256;
    if (!triageCurrent) {
      return {
        done: false,
        evidence:
          `narration_word_timing_${episode}.json contains manual medium `
          + "structural recovery without current hash-bound triage",
      };
    }
  }
  const narrationQualityContract = narrationQualityContractForIdentity(identity);
  if (narrationQualityContract) {
    const finalDeliveryPath = path.join(
      episodeDir,
      `narration_final_delivery_qa_${episode}.json`,
    );
    const finalDelivery = await readJson(finalDeliveryPath, null);
    if (finalDelivery?.schema !== "goldflow_narration_final_delivery_qa_v2"
      || finalDelivery?.status !== "passed"
      || finalDelivery?.quality_contract_sha256
        !== narrationQualityContract.contract_sha256
      || finalDelivery?.narration_audio_hash !== currentAudioHash
      || (finalDelivery?.blockers ?? []).length !== 0) {
      return {
        done: false,
        evidence: `narration_final_delivery_qa_${episode}.json missing, blocked, or stale`,
      };
    }
  }
  if (!isLegacyQwenIdentity(identity) && timing.full_stream_transcript_qa?.status !== "passed") {
    return {
      done: false,
      evidence: `narration_word_timing_${episode}.json full-stream transcript QA=${timing.full_stream_transcript_qa?.status ?? "missing"}`,
    };
  }
  const zeroDurationCount = Number(
    timing.word_timing_qa?.zero_duration_word_count ?? 0,
  );
  return {
    done: String(timing.status ?? "").toLowerCase() === "passed",
    evidence:
      `narration_word_timing_${episode}.json -> ${currentScriptHash}; `
      + `audio_hash=${timing.narration_audio_hash ?? "none"}; `
      + `${reportContract.evidence}`
      + (zeroDurationCount > 0
        ? `; zero_duration_word_timings=${zeroDurationCount} warning_only`
        : ""),
  };
}

function cleanOptionalId(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function selectedNarratorVoiceId(identity = {}, statusFlags = flags) {
  if (!isLegacyQwenIdentity(identity)) {
    return narrationTtsPolicyForIdentity(identity).primary.voice_id;
  }
  const lockedV2 = (identity.schema ?? identity.run_identity_schema)
    === "goldflow_run_identity_v2";
  return (!lockedV2
    ? cleanOptionalId(statusFlags["qwen-narrator-voice-id"])
      ?? cleanOptionalId(statusFlags["narrator-voice-id"])
    : null)
    ?? cleanOptionalId(identity?.voice_provider_options?.qwen_narrator_voice_id)
    ?? cleanOptionalId(identity?.qwen_narrator_voice_id)
    ?? cleanOptionalId(identity?.narrator_voice_id)
    ?? DEFAULT_QWEN_NARRATOR_VOICE_ID;
}

function narratorReferenceIdsFromPlan(plan) {
  const ids = new Set();
  for (const segment of plan?.segments ?? []) {
    for (const unit of segment?.narration_units ?? segment?.tts_generation_units ?? segment?.qwen_generation_units ?? []) {
      const speaker = String(unit?.speaker ?? unit?.source_speaker ?? "NARRATOR").toUpperCase();
      const role = String(unit?.role ?? "").toLowerCase();
      if (!["NARRATOR", "MC_INTERNAL"].includes(speaker) && role !== "narrator") continue;
      const referenceId = cleanOptionalId(unit?.reference_id) ?? cleanOptionalId(unit?.voice_id);
      if (referenceId) ids.add(referenceId);
    }
  }
  return ids;
}

function voiceIdsFromTtsArtifacts(ttsReport, stitchReport) {
  const ids = new Set();
  for (const row of ttsReport?.results ?? []) {
    const voiceId = cleanOptionalId(row?.voice_id);
    if (voiceId) ids.add(voiceId);
  }
  for (const segment of stitchReport?.segments ?? []) {
    const voiceId = cleanOptionalId(segment?.voice_id);
    if (voiceId) ids.add(voiceId);
  }
  return ids;
}

function statusPassed(value) {
  return ["passed", "passed_with_warnings", "completed"].includes(String(value ?? "").toLowerCase());
}

function boundedProofIdentity(identity = {}) {
  return identity.run_intent === "proof"
    && identity.proof_scope?.mode === "bounded"
    && Number(identity.proof_scope?.end_sec) > Number(identity.proof_scope?.start_sec);
}

function auditedBaselineImportArtifact(artifact) {
  return artifact?.artifact_mode === "audited_baseline_import"
    || artifact?.proof_baseline_provenance?.mode === "audited_baseline_scope_import";
}

function proofScopeEqual(left, right) {
  return Number(left?.start_sec) === Number(right?.start_sec)
    && Number(left?.end_sec) === Number(right?.end_sec);
}

async function proofBaselineImportArtifactComplete({
  episodeDir,
  episode,
  currentScriptHash,
  identity,
  artifact,
  artifactPath,
  label,
}) {
  if (!auditedBaselineImportArtifact(artifact)) return { applicable: false, done: false, evidence: null };
  if (isLegacyQwenIdentity(identity)) return { applicable: false, done: false, evidence: null };
  const findings = [];
  const add = (message) => findings.push(message);
  if (!boundedProofIdentity(identity)) add("run identity is not a bounded proof");
  if (!statusPassed(artifact?.status)) add(`${label} status=${artifact?.status ?? "missing"}`);
  if (artifact?.source_script_hash !== currentScriptHash) add(`${label} source script hash is stale`);
  if (artifact?.synthesis_performed !== false) add(`${label} must record synthesis_performed=false`);
  if (Number(artifact?.provider_calls ?? 0) !== 0) add(`${label} must record provider_calls=0`);

  const provenance = artifact?.proof_baseline_provenance ?? null;
  const provenanceHash = provenance ? sha256(JSON.stringify(provenance)) : null;
  if (!provenance) add(`${label} proof provenance missing`);
  if (!provenanceHash || artifact?.proof_baseline_provenance_sha256 !== provenanceHash) {
    add(`${label} proof provenance hash missing or stale`);
  }
  const importReportPath = artifact?.proof_baseline_import_report_path
    ?? path.join(episodeDir, `proof_baseline_import_${episode}.json`);
  const importReport = await readJson(importReportPath, null);
  if (!importReport || importReport.status !== "passed") {
    add(`${path.basename(importReportPath)} missing or not passed`);
  } else {
    if (importReport.schema !== "goldflow_proof_baseline_import_v2") add("proof import report schema is not v2");
    if (importReport.artifact_contract !== "canonical_narration") add("proof import report is not canonical narration");
    if (importReport.source_script_hash !== currentScriptHash) add("proof import report source script hash is stale");
    if (!proofScopeEqual(importReport.proof_scope, identity.proof_scope)) add("proof import report scope differs from run identity");
    if (importReport.synthesis_performed !== false || Number(importReport.provider_calls ?? 0) !== 0) {
      add("proof import report does not record a zero-provider-call import");
    }
    if (importReport.proof_baseline_provenance_sha256 !== provenanceHash) {
      add("proof import report provenance hash differs from artifact");
    }
    const expectedArtifactHash = importReport.artifact_sha256?.[path.basename(artifactPath)];
    const currentArtifactHash = await fileSha256(artifactPath);
    if (!expectedArtifactHash || currentArtifactHash !== expectedArtifactHash) {
      add(`${label} hash differs from proof import report`);
    }
  }

  if (provenance) {
    if (provenance.mode !== "audited_baseline_scope_import") add("proof provenance mode is invalid");
    if (provenance.artifact_contract !== "canonical_narration") add("proof provenance contract is not canonical narration");
    const [provenanceEpisodeDir, currentEpisodeDir] = await Promise.all([
      fs.realpath(provenance.target_episode_dir ?? "").catch(() => path.resolve(provenance.target_episode_dir ?? "")),
      fs.realpath(episodeDir).catch(() => path.resolve(episodeDir)),
    ]);
    if (provenanceEpisodeDir !== currentEpisodeDir) add("proof provenance target episode differs");
    if (!proofScopeEqual(provenance.scope, identity.proof_scope)) add("proof provenance scope differs from run identity");
    if (provenance.target_script_sha256 !== currentScriptHash) add("proof provenance target script hash is stale");
    if (provenance.synthesis_performed !== false
      || provenance.stitch_performed !== false
      || Number(provenance.provider_calls ?? 0) !== 0) {
      add("proof provenance falsely claims provider synthesis or stitching");
    }
    const pathHashPairs = [
      ["target_identity_path", "target_identity_sha256"],
      ["target_script_path", "target_script_sha256"],
      ["baseline_script_path", "baseline_script_sha256"],
      ["baseline_word_timing_path", "baseline_word_timing_sha256"],
      ["baseline_audio_report_path", "baseline_audio_report_sha256"],
      ["baseline_audio_path", "baseline_audio_sha256"],
      ["imported_audio_path", "imported_audio_sha256"],
    ];
    for (const [pathKey, hashKey] of pathHashPairs) {
      const sourcePath = provenance[pathKey];
      const expectedHash = provenance[hashKey];
      const currentHash = sourcePath ? await fileSha256(sourcePath) : null;
      if (!sourcePath || !expectedHash || currentHash !== expectedHash) {
        add(`${pathKey}/${hashKey} missing or stale`);
      }
    }
    if (importReport) {
      if (importReport.output_audio_path !== provenance.imported_audio_path
        || importReport.output_audio_sha256 !== provenance.imported_audio_sha256) {
        add("proof import report output audio differs from provenance");
      }
    }
  }

  return {
    applicable: true,
    done: findings.length === 0,
    evidence: findings.length
      ? `${label} imported-baseline provenance invalid: ${findings.join("; ")}`
      : `${label} -> audited bounded baseline import; provider_calls=0; synthesis_performed=false; provenance=${provenanceHash}`,
  };
}

async function genericProofBaselineNarrationComplete({
  episodeDir,
  episode,
  currentScriptHash,
  identity,
  ttsReport,
  stitchReport,
}) {
  if (!auditedBaselineImportArtifact(ttsReport) && !auditedBaselineImportArtifact(stitchReport)) {
    return { applicable: false, done: false, evidence: null };
  }
  const artifactSpecs = [
    [`narration_tts_report_${episode}.json`, ttsReport],
    [`narration_tts_unit_qa_${episode}.json`, await readJson(path.join(episodeDir, `narration_tts_unit_qa_${episode}.json`), null)],
    [`narration_full_stream_qa_${episode}.json`, await readJson(path.join(episodeDir, `narration_full_stream_qa_${episode}.json`), null)],
    [`audio_stitch_report_${episode}-narration.json`, stitchReport],
  ];
  const validations = [];
  for (const [name, artifact] of artifactSpecs) {
    if (!artifact) {
      validations.push({ applicable: true, done: false, evidence: `${name} missing for canonical proof import` });
      continue;
    }
    validations.push(await proofBaselineImportArtifactComplete({
      episodeDir,
      episode,
      currentScriptHash,
      identity,
      artifact,
      artifactPath: path.join(episodeDir, name),
      label: name,
    }));
  }
  const failed = validations.find((row) => !row.done);
  if (failed) return { applicable: true, done: false, evidence: failed.evidence };
  const provenance = stitchReport.proof_baseline_provenance;
  return {
    applicable: true,
    done: true,
    evidence: `audio_stitch_report_${episode}-narration.json -> ${provenance.imported_audio_path}; imported audited baseline; provider_calls=0; synthesis_performed=false; duration=${Number(provenance.imported_audio_duration_sec).toFixed(3)}s`,
  };
}

function narrationPlanUnitsForStatus(plan) {
  const rows = Array.isArray(plan?.units)
    ? plan.units
    : (plan?.segments ?? []).flatMap((segment) => (
        segment?.narration_generation_units
        ?? segment?.narration_units
        ?? segment?.tts_generation_units
        ?? segment?.qwen_generation_units
        ?? []
      ));
  return rows.map((row) => {
    const aliases = [
      row?.spoken_text,
      row?.tts_spoken_text,
      row?.qwen_spoken_text,
    ].filter((value) => value != null).map(String);
    const spokenText = aliases[0] ?? "";
    return {
      unit_id: String(row?.unit_id ?? ""),
      spoken_text: spokenText,
      spoken_text_aliases_equal: aliases.length > 0 && aliases.every((value) => value === spokenText),
      spoken_text_sha256: row?.spoken_text_sha256 ?? null,
      computed_spoken_text_sha256: spokenText ? sha256(spokenText) : null,
      provider_request: row?.provider_request ?? null,
    };
  });
}

function exactOrderedIds(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return left.length === right.length
    && left.every((value, index) => String(value) === String(right[index]));
}

function qaStatusPassed(value) {
  return ["passed", "passed_with_warnings"].includes(String(value ?? "").toLowerCase());
}

async function sameResolvedFilePath(left, right) {
  if (!left || !right) return false;
  const [resolvedLeft, resolvedRight] = await Promise.all([
    fs.realpath(left).catch(() => path.resolve(left)),
    fs.realpath(right).catch(() => path.resolve(right)),
  ]);
  return resolvedLeft === resolvedRight;
}

async function synthesizedNarrationArtifactsComplete({
  episodeDir,
  episode,
  currentScriptHash,
  policy,
  ttsReport,
  stitchReport,
}) {
  const planPath = path.join(episodeDir, "narration_generation_plan.json");
  const unitQaPath = path.join(episodeDir, `narration_tts_unit_qa_${episode}.json`);
  const fullQaPath = path.join(episodeDir, `narration_full_stream_qa_${episode}.json`);
  const [plan, unitQa, fullQa, planFileSha256] = await Promise.all([
    readJson(planPath, null),
    readJson(unitQaPath, null),
    readJson(fullQaPath, null),
    fileSha256(planPath),
  ]);
  const canonicalPlanSha256 = plan?.plan_sha256 ?? planFileSha256;
  // Legacy synthesis artifacts predate the canonical in-document plan hash and
  // intentionally bind the exact plan file. Narration Quality V2 binds both.
  const artifactPlanSha256 = policy.narration_quality_contract
    ? canonicalPlanSha256
    : planFileSha256;
  const findings = [];
  const add = (message) => findings.push(message);
  if (!plan || plan.status !== "passed") add("narration_generation_plan.json missing or not passed");
  if (!planFileSha256 || !canonicalPlanSha256 || !artifactPlanSha256) {
    add("narration_generation_plan.json canonical or file hash missing");
  }
  if (plan?.source_script_hash !== currentScriptHash) add("narration generation plan source script hash is stale");
  if (!unitQa || !qaStatusPassed(unitQa.status)) add(`narration_tts_unit_qa_${episode}.json missing or status=${unitQa?.status ?? "missing"}`);
  if (!fullQa || !qaStatusPassed(fullQa.status)) add(`narration_full_stream_qa_${episode}.json missing or status=${fullQa?.status ?? "missing"}`);
  if (unitQa?.source_script_hash !== currentScriptHash) add("unit QA source script hash is stale");
  if (fullQa?.source_script_hash !== currentScriptHash) add("full-stream QA source script hash is stale");
  try {
    await validateAppliedFullStreamManualReview(fullQa);
    if (fullQa?.full_stream_manual_review) {
      const manifestHash = await fileSha256(path.join(episodeDir, `narration_provider_output_manifest_${episode}.json`));
      if (fullQa.provider_output_manifest_file_sha256 !== manifestHash) add("full-stream review provider manifest hash is stale");
      for (const report of [ttsReport, stitchReport]) {
        if (JSON.stringify(report?.full_stream_manual_review) !== JSON.stringify(fullQa.full_stream_manual_review)) {
          add("full-stream manual review provenance differs across narration reports");
        }
      }
    }
  } catch (error) {
    add(error.message);
  }

  const planBoundArtifacts = [
    ["TTS report", ttsReport],
    ["stitch report", stitchReport],
    ["unit QA", unitQa],
    ["full-stream QA", fullQa],
  ];
  for (const [label, artifact] of planBoundArtifacts) {
    if (artifact?.narration_generation_plan_sha256 !== artifactPlanSha256) {
      add(`${label} narration plan hash is missing or stale`);
    }
    if (policy.narration_quality_contract
      && artifact?.narration_generation_plan_file_sha256 !== planFileSha256) {
      add(`${label} narration plan file hash is missing or stale`);
    }
  }
  const planPathArtifacts = [
    ["TTS report", ttsReport?.narration_generation_plan_path],
    ["stitch report", stitchReport?.narration_generation_plan_path],
    ["unit QA", unitQa?.narration_generation_plan_path],
    ...(policy.narration_quality_contract
      ? [["full-stream QA", fullQa?.narration_generation_plan_path]]
      : []),
  ];
  for (const [label, artifactPath] of planPathArtifacts) {
    if (!artifactPath || !(await sameResolvedFilePath(artifactPath, planPath))) {
      add(`${label} narration plan path is missing or stale`);
    }
  }
  if (!ttsReport?.unit_qa_path || !(await sameResolvedFilePath(ttsReport.unit_qa_path, unitQaPath))) {
    add("TTS report unit QA path is missing or stale");
  }
  if (!ttsReport?.full_stream_qa_path || !(await sameResolvedFilePath(ttsReport.full_stream_qa_path, fullQaPath))) {
    add("TTS report full-stream QA path is missing or stale");
  }
  if (!stitchReport?.full_stream_qa_path
    || !(await sameResolvedFilePath(stitchReport.full_stream_qa_path, fullQaPath))) {
    add("stitch report full-stream QA path is missing or stale");
  }

  const plannedUnits = narrationPlanUnitsForStatus(plan);
  const plannedIds = plannedUnits.map((row) => row.unit_id);
  if (!plannedUnits.length) add("narration plan contains no units");
  if (new Set(plannedIds).size !== plannedIds.length || plannedIds.some((unitId) => !unitId)) {
    add("narration plan unit IDs are missing or duplicated");
  }
  for (const unit of plannedUnits) {
    if (!unit.spoken_text || !unit.spoken_text_aliases_equal) {
      add(`planned unit ${unit.unit_id || "<missing>"} spoken-text aliases are missing or unequal`);
    }
    if (!unit.spoken_text_sha256
      || unit.spoken_text_sha256 !== unit.computed_spoken_text_sha256) {
      add(`planned unit ${unit.unit_id || "<missing>"} spoken_text_sha256 is missing or stale`);
    }
  }
  const results = Array.isArray(ttsReport?.results) ? ttsReport.results : [];
  const resultIds = results.map((row) => String(row?.unit_id ?? ""));
  if (!exactOrderedIds(plannedIds, resultIds)) add("TTS result unit IDs are missing, reordered, duplicated, or unexpected");
  const selectedUnits = Array.isArray(unitQa?.selected_units) ? unitQa.selected_units : [];
  const selectedUnitIds = selectedUnits.map((row) => String(row?.unit_id ?? ""));
  if (!exactOrderedIds(plannedIds, selectedUnitIds)) add("unit QA selected unit IDs are missing, reordered, duplicated, or unexpected");
  const stitchSegments = Array.isArray(stitchReport?.segments) ? stitchReport.segments : [];
  const stitchUnitIds = stitchSegments.map((row) => String(row?.unit_id ?? ""));
  if (!exactOrderedIds(plannedIds, stitchUnitIds)) add("stitch segment unit IDs are missing, reordered, duplicated, or unexpected");
  let expectedBatchBindings = null;
  let synthesisRuns = [];
  if (policy.synthesis_contract?.mode
    === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode) {
    const batchValidation = validateQwenLiamBatchPlan(
      plan?.qwen_liam_batch_plan,
      plannedUnits.map((unit, index) => ({
        ...unit,
        order_index: index,
      })),
      policy.synthesis_contract,
    );
    if (batchValidation.status !== "passed") {
      add(`narration batch plan is stale: ${batchValidation.findings
        .map((finding) => finding.code)
        .join(", ")}`);
    } else {
      expectedBatchBindings = qwenBatchBindingByUnit(batchValidation.expected);
    }
    if (JSON.stringify(ttsReport?.synthesis_contract)
      !== JSON.stringify(QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT)) {
      add("TTS report deterministic batch-four synthesis contract is missing or stale");
    }
    if (ttsReport?.batch_plan_sha256
      !== plan?.qwen_liam_batch_plan?.batch_plan_sha256) {
      add("TTS report batch plan hash differs from the narration plan");
    }
    synthesisRuns = Array.isArray(ttsReport?.synthesis_runs)
      ? ttsReport.synthesis_runs
      : [];
    const firstTakeRun = synthesisRuns.find(
      (run) => Number(run?.attempt) === 1
        && run?.synthesis_mode
          === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode,
    );
    if (!firstTakeRun) {
      add("TTS report lacks its batch-four first-take runner provenance");
    } else {
      if (firstTakeRun.batch_plan_sha256
        !== plan?.qwen_liam_batch_plan?.batch_plan_sha256
        || Number(firstTakeRun.model_load_count) !== 1
        || Number(firstTakeRun.resident_model_count) !== 1
        || Number(firstTakeRun.model_instance_concurrency) !== 1
        || firstTakeRun.results_restored_to_original_order !== true) {
        add("batch-four first-take runner provenance is stale");
      }
      const expectedCohorts = plan?.qwen_liam_batch_plan?.cohorts ?? [];
      const actualCohorts = firstTakeRun.cohort_executions ?? [];
      if (expectedCohorts.length !== actualCohorts.length
        || expectedCohorts.some((cohort, index) => {
          const actual = actualCohorts[index];
          return actual?.cohort_id !== cohort.cohort_id
            || actual?.cohort_sha256 !== cohort.cohort_sha256
            || Number(actual?.nominal_batch_size)
              !== Number(cohort.nominal_batch_size)
            || Number(actual?.effective_batch_size)
              !== Number(cohort.effective_batch_size)
            || JSON.stringify(actual?.unit_ids ?? [])
              !== JSON.stringify(
                cohort.members.map((member) => member.unit_id),
              );
        })) {
        add("batch-four cohort execution report differs from the voice plan");
      }
      const firstTakeRunnerReport = firstTakeRun.report_path
        ? await readJson(firstTakeRun.report_path, null)
        : null;
      if (!firstTakeRun.report_path || !firstTakeRun.report_sha256
        || await fileSha256(firstTakeRun.report_path)
          !== firstTakeRun.report_sha256) {
        add("batch-four first-take runner report path/hash is stale");
      } else if (!firstTakeRunnerReport
        || firstTakeRunnerReport.synthesis_mode
          !== QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode
        || JSON.stringify(firstTakeRunnerReport.synthesis_contract)
          !== JSON.stringify(QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT)
        || firstTakeRunnerReport.batch_plan_sha256
          !== plan?.qwen_liam_batch_plan?.batch_plan_sha256
        || Number(firstTakeRunnerReport.model_load_count) !== 1
        || Number(firstTakeRunnerReport.resident_model_count) !== 1
        || Number(firstTakeRunnerReport.model_instance_concurrency) !== 1
        || firstTakeRunnerReport.continuous_batching !== false
        || firstTakeRunnerReport.reference_audio_preloaded_once !== true
        || firstTakeRunnerReport.token_limit_acceptance_allowed !== false
        || Number(firstTakeRunnerReport.accepted_token_limit_result_count) !== 0
        || firstTakeRunnerReport.results_restored_to_original_order !== true
        || !exactOrderedIds(
          plan?.qwen_liam_batch_plan?.original_order_unit_ids,
          firstTakeRunnerReport.original_order_unit_ids,
        )
        || JSON.stringify(firstTakeRunnerReport.cohort_executions ?? [])
          !== JSON.stringify(firstTakeRun.cohort_executions ?? [])) {
        add("batch-four first-take runner report content is stale");
      }
    }
  }
  for (const finding of narrationArtifactVoiceIdentityFindings({
    ttsReport,
    stitchReport,
    unitQa,
    policy,
  })) {
    add(`${finding.path}=${finding.actual ?? "missing"}; required ${finding.expected}`);
  }

  for (let index = 0; index < plannedUnits.length; index += 1) {
    const planned = plannedUnits[index];
    const result = results[index];
    const selected = selectedUnits[index];
    const segment = stitchSegments[index];
    if (!result || !selected || !segment) continue;
    const provider = result.selected_provider ?? result.provider;
    const selectedProvider = selected.provider ?? selected.selected_provider;
    const stitchProvider = segment.tts_provider ?? segment.selected_provider ?? segment.provider;
    if (![policy.primary.provider, policy.fallback?.provider].includes(provider)) {
      add(`unit ${planned.unit_id} selected undeclared provider ${provider ?? "missing"}`);
    }
    if (selectedProvider !== provider || stitchProvider !== provider) {
      add(`unit ${planned.unit_id} provider differs across TTS, unit QA, and stitch`);
    }
    const resultTextHash = result.spoken_text_sha256;
    const selectedTextHash = selected.spoken_text_sha256;
    const segmentTextHash = segment.spoken_text_sha256
      ?? (String(segment.text ?? "") ? sha256(String(segment.text)) : null);
    if (resultTextHash !== planned.spoken_text_sha256) add(`unit ${planned.unit_id} TTS spoken text hash is stale`);
    if (result.selected_spoken_text_sha256 != null
      && result.selected_spoken_text_sha256 !== planned.spoken_text_sha256) {
      add(`unit ${planned.unit_id} selected TTS spoken text hash is stale`);
    }
    if (result.primary_spoken_text_sha256 != null
      && result.primary_spoken_text_sha256 !== planned.spoken_text_sha256) {
      add(`unit ${planned.unit_id} primary TTS spoken text hash is stale`);
    }
    if (selectedTextHash !== planned.spoken_text_sha256) add(`unit ${planned.unit_id} unit-QA spoken text hash is stale`);
    if (segmentTextHash !== planned.spoken_text_sha256) add(`unit ${planned.unit_id} stitch spoken text hash is stale`);
    if (expectedBatchBindings) {
      const synthesisIdentityHashes = [
        result.synthesis_identity_sha256,
        selected.synthesis_identity_sha256,
        segment.synthesis_identity_sha256,
      ];
      if (synthesisIdentityHashes.some((value) => !value)
        || new Set(synthesisIdentityHashes).size !== 1) {
        add(`unit ${planned.unit_id} synthesis identity differs across artifacts`);
      }
    }
    const generatedTokenCount = Number(result.generated_token_count);
    const effectiveTokenLimit = Number(result.effective_token_limit);
    const unsafeTokenEvidence = expectedBatchBindings
      ? result.token_limit_reached !== false
        || !Number.isFinite(generatedTokenCount)
        || generatedTokenCount < 0
        || !Number.isFinite(effectiveTokenLimit)
        || effectiveTokenLimit <= 0
        || generatedTokenCount >= effectiveTokenLimit
      : result.token_limit_reached === true
        || result.synthesis_identity?.token_limit_reached === true
        || (Number.isFinite(generatedTokenCount)
          && Number.isFinite(effectiveTokenLimit)
          && effectiveTokenLimit > 0
          && generatedTokenCount >= effectiveTokenLimit);
    if (unsafeTokenEvidence) {
      add(`unit ${planned.unit_id} reached or lacks safe generation-token-limit evidence and may not be accepted`);
    }
    if (expectedBatchBindings) {
      const expectedBinding = expectedBatchBindings.get(String(planned.unit_id));
      const synthesisIdentity = result.synthesis_identity ?? {};
      const mode = result.synthesis_mode ?? synthesisIdentity.synthesis_mode;
      if (mode === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode) {
        const actualBinding = {
          synthesis_contract_id: synthesisIdentity.synthesis_contract_id,
          synthesis_mode: synthesisIdentity.synthesis_mode,
          batch_plan_sha256: synthesisIdentity.batch_plan_sha256,
          cohort_id: synthesisIdentity.cohort_id,
          cohort_index: synthesisIdentity.cohort_index,
          cohort_sha256: synthesisIdentity.cohort_sha256,
          cohort_position: synthesisIdentity.cohort_position,
          nominal_batch_size: synthesisIdentity.nominal_batch_size,
          effective_batch_size: synthesisIdentity.effective_batch_size,
          batch_seed: synthesisIdentity.batch_seed,
        };
        if (JSON.stringify(actualBinding) !== JSON.stringify(expectedBinding)) {
          add(`unit ${planned.unit_id} selected batch cohort identity is stale`);
        }
      } else if (mode === QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE) {
        const recovery = synthesisIdentity.recovery_provenance
          ?? result.recovery_provenance;
        if (!recovery
          || recovery.batch_plan_sha256
            !== plan?.qwen_liam_batch_plan?.batch_plan_sha256
          || recovery.origin_cohort_sha256 !== expectedBinding?.cohort_sha256
          || !recovery.origin_synthesis_identity_sha256
          || !recovery.trigger_evidence_sha256
          || !Array.isArray(recovery.trigger_codes)
          || !recovery.trigger_codes.length) {
          add(`unit ${planned.unit_id} exact-unit recovery provenance is missing or stale`);
        }
        const recoveryRunCandidates = synthesisRuns.filter(
          (run) => run?.synthesis_mode === QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE
            && Number(run?.attempt) === Number(result.attempt),
        );
        let matchingRecoveryRunner = false;
        for (const run of recoveryRunCandidates) {
          if (!run?.report_path || !run?.report_sha256
            || await fileSha256(run.report_path) !== run.report_sha256) {
            continue;
          }
          const runnerReport = await readJson(run.report_path, null);
          const runnerResult = (runnerReport?.results ?? []).find(
            (row) => String(row?.unit_id) === String(planned.unit_id)
              && row?.synthesis_identity_sha256
                === result.synthesis_identity_sha256,
          );
          if (runnerReport?.synthesis_mode
              === QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE
            && runnerReport?.batch_plan_sha256
              === plan?.qwen_liam_batch_plan?.batch_plan_sha256
            && Number(runnerReport?.model_load_count) === 1
            && Number(runnerReport?.resident_model_count) === 1
            && Number(runnerReport?.model_instance_concurrency) === 1
            && runnerReport?.continuous_batching === false
            && runnerReport?.token_limit_acceptance_allowed === false
            && Number(runnerReport?.accepted_token_limit_result_count) === 0
            && runnerReport?.results_restored_to_original_order === true
            && runnerResult?.status !== "failed"
            && runnerResult?.output_sha256 === result.audio_sha256
            && runnerResult?.token_limit_reached === false
            && Number.isFinite(Number(runnerResult?.generated_token_count))
            && Number.isFinite(Number(runnerResult?.effective_token_limit))
            && Number(runnerResult?.effective_token_limit) > 0
            && Number(runnerResult?.generated_token_count)
              < Number(runnerResult?.effective_token_limit)) {
            matchingRecoveryRunner = true;
            break;
          }
        }
        if (!matchingRecoveryRunner) {
          add(`unit ${planned.unit_id} exact-unit recovery runner provenance is missing or stale`);
        }
      } else {
        add(`unit ${planned.unit_id} selected synthesis mode ${mode ?? "missing"} is not allowed by the batch-four contract`);
      }
    }
    const selectedQaStatus = result.selected_qa?.status ?? result.qa_status;
    const unitQaStatus = selected.qa?.status ?? selected.qa_status;
    const stitchQaStatus = segment.unit_qa?.status ?? segment.qa_status;
    if (!qaStatusPassed(selectedQaStatus)) add(`unit ${planned.unit_id} selected TTS QA is not passed`);
    if (!qaStatusPassed(unitQaStatus)) add(`unit ${planned.unit_id} selected unit QA is not passed`);
    if (!qaStatusPassed(stitchQaStatus)) add(`unit ${planned.unit_id} stitch unit QA is not passed`);
    const audioHashes = [
      result.audio_sha256,
      selected.audio_sha256,
      segment.raw_audio_sha256,
    ].filter(Boolean);
    if (audioHashes.length > 1 && new Set(audioHashes).size !== 1) {
      add(`unit ${planned.unit_id} selected audio hashes differ across artifacts`);
    }
    const audioPaths = [
      result.audio_path,
      selected.audio_path,
      segment.raw_audio_path,
    ].filter(Boolean);
    if (audioPaths.length > 1) {
      const firstAudioPath = audioPaths[0];
      for (const audioPath of audioPaths.slice(1)) {
        if (!(await sameResolvedFilePath(firstAudioPath, audioPath))) {
          add(`unit ${planned.unit_id} selected audio paths differ across artifacts`);
          break;
        }
      }
    }
    if (policy.fallback && provider === policy.fallback.provider) {
      const fallbackPolicy = policy.fallback;
      const primaryHash = result.primary_spoken_text_sha256;
      const fallbackHash = result.fallback_spoken_text_sha256;
      if (!primaryHash
        || primaryHash !== planned.spoken_text_sha256
        || !fallbackHash
        || fallbackHash !== planned.spoken_text_sha256) {
        add(`fallback unit ${planned.unit_id} does not preserve the exact planned spoken text hash`);
      }
      const voiceIds = [
        result.voice_id,
        selected.voice_id,
        segment.voice_id,
      ];
      if (voiceIds.some((voiceId) => voiceId !== policy.primary.voice_id)) {
        add(`fallback unit ${planned.unit_id} is not declared as the selected Puck voice`);
      }
      const contracts = [
        result.voice_continuity_contract,
        selected.voice_continuity_contract,
        segment.voice_continuity_contract,
      ];
      if (contracts.some(
        (contract) => contract !== fallbackPolicy.voice_continuity_contract,
      )) {
        add(`fallback unit ${planned.unit_id} voice-continuity contract is missing or stale`);
      }
      const continuityArtifacts = [
        ["TTS result", result.voice_continuity],
        ["unit QA", selected.qa?.voice_continuity ?? selected.voice_continuity],
        ["stitch segment", segment.voice_continuity],
      ];
      for (const [label, continuity] of continuityArtifacts) {
        const similarity = Number(continuity?.cosine_similarity);
        if (continuity?.status !== "passed"
          || continuity?.audio_sha256 !== result.audio_sha256
          || continuity?.reference_voice_id !== policy.primary.voice_id
          || continuity?.reference_voice_sha256 !== policy.primary.voice_sha256
          || continuity?.reference_audio_sha256 !== fallbackPolicy.reference_audio_sha256
          || continuity?.similarity_model_sha256
            !== fallbackPolicy.speaker_similarity_model_sha256
          || continuity?.similarity_calibration_sha256
            !== fallbackPolicy.speaker_similarity_calibration_sha256
          || continuity?.voice_continuity_contract
            !== fallbackPolicy.voice_continuity_contract
          || Number(continuity?.minimum_cosine_similarity)
            !== Number(fallbackPolicy.minimum_cosine_similarity)
          || Number(continuity?.warning_below_cosine_similarity)
            !== Number(fallbackPolicy.warning_below_cosine_similarity)
          || !Number.isFinite(similarity)
          || similarity < Number(fallbackPolicy.minimum_cosine_similarity)) {
          add(`fallback unit ${planned.unit_id} ${label} lacks passing Puck voice-continuity evidence`);
        }
      }
      const continuity = result.voice_continuity;
      if (!continuity?.report_path || !continuity?.report_sha256) {
        add(`fallback unit ${planned.unit_id} voice-continuity report provenance is missing`);
      } else {
        const continuityReportHash = await fileSha256(continuity.report_path);
        if (continuityReportHash !== continuity.report_sha256) {
          add(`fallback unit ${planned.unit_id} voice-continuity report hash is stale`);
        }
      }
    }
  }

  const expectedFallbackIds = policy.fallback
    ? results
        .filter((row) => (row.selected_provider ?? row.provider) === policy.fallback.provider)
        .map((row) => String(row.unit_id))
    : [];
  const declaredFallbackIdsValue = ttsReport.fallback_unit_ids
    ?? ttsReport.fallback_selected_unit_ids
    ?? ttsReport.fallback_usage?.unit_ids
    ?? [];
  const declaredFallbackIds = Array.isArray(declaredFallbackIdsValue)
    ? declaredFallbackIdsValue.map(String)
    : [];
  if (!exactOrderedIds(expectedFallbackIds, declaredFallbackIds)) {
    add("declared fallback unit IDs differ from selected result providers");
  }
  if (expectedFallbackIds.length && policy.fallback) {
    const fallbackPolicy = policy.fallback;
    const fallbackUsage = ttsReport.fallback_usage ?? {};
    if (fallbackUsage.provider !== fallbackPolicy.provider
      || fallbackUsage.target_voice_id !== policy.primary.voice_id
      || fallbackUsage.target_voice_sha256 !== policy.primary.voice_sha256
      || fallbackUsage.voice_continuity_contract
        !== fallbackPolicy.voice_continuity_contract
      || fallbackUsage.reference_audio_sha256
        !== fallbackPolicy.reference_audio_sha256
      || fallbackUsage.speaker_similarity_model_sha256
        !== fallbackPolicy.speaker_similarity_model_sha256
      || fallbackUsage.speaker_similarity_calibration_sha256
        !== fallbackPolicy.speaker_similarity_calibration_sha256
      || Number(fallbackUsage.minimum_cosine_similarity)
        !== Number(fallbackPolicy.minimum_cosine_similarity)
      || Number(fallbackUsage.warning_below_cosine_similarity)
        !== Number(fallbackPolicy.warning_below_cosine_similarity)
      || fallbackUsage.exact_unit_only !== true) {
      add("declared fallback usage lacks the locked Puck clone continuity provenance");
    }
  }
  if (Number(unitQa?.selected_blocker_count ?? 0) !== 0
    || (unitQa?.selected_blockers ?? []).length > 0) {
    add("unit QA retains blockers on selected units");
  }
  if (!qaStatusPassed(fullQa?.order_qa?.status)) add("full-stream unit order QA is not passed");
  if (!exactOrderedIds(plannedIds, fullQa?.order_qa?.expected_unit_ids ?? [])) {
    add("full-stream expected unit IDs differ from narration plan");
  }
  if (!exactOrderedIds(plannedIds, fullQa?.order_qa?.actual_unit_ids ?? [])) {
    add("full-stream actual unit IDs differ from narration plan");
  }
  if (fullQa?.join_qa && !qaStatusPassed(fullQa.join_qa.status)) add("full-stream join QA is not passed");
  if ((fullQa?.blockers ?? []).length > 0) add("full-stream QA retains blockers");
  const intendedTextHash = sha256(plannedUnits.map((row) => row.spoken_text).join(" "));
  if (fullQa?.intended_text_sha256 !== intendedTextHash) add("full-stream intended text hash differs from narration plan");

  const outputPath = stitchReport?.output_path ?? stitchReport?.final_audio_path ?? stitchReport?.final_wav_path;
  const outputHash = stitchReport?.output_sha256 ?? stitchReport?.final_wav_sha256 ?? ttsReport?.final_wav_sha256;
  if (fullQa?.audio_path && !(await sameResolvedFilePath(fullQa.audio_path, outputPath))) {
    add("full-stream QA audio path differs from stitched narration");
  }
  if (fullQa?.audio_sha256 && fullQa.audio_sha256 !== outputHash) {
    add("full-stream QA audio hash differs from stitched narration");
  }
  if (ttsReport?.final_wav && !(await sameResolvedFilePath(ttsReport.final_wav, outputPath))) {
    add("TTS report final WAV path differs from stitched narration");
  }
  if (ttsReport?.final_wav_sha256 && ttsReport.final_wav_sha256 !== outputHash) {
    add("TTS report final WAV hash differs from stitched narration");
  }
  if (policy.narration_quality_contract) {
    const ttsMaster = ttsReport?.mastering ?? {};
    const stitchMaster = stitchReport?.mastering ?? {};
    if (ttsMaster.status !== "passed" || stitchMaster.status !== "passed") {
      add("canonical narration lacks passing two-pass stream mastering");
    }
    if (ttsMaster.output_sha256 !== outputHash
      || stitchMaster.output_sha256 !== outputHash) {
      add("canonical narration hash differs from the mastered output hash");
    }
    if (!ttsMaster.output_path
      || !(await sameResolvedFilePath(ttsMaster.output_path, outputPath))
      || !stitchMaster.output_path
      || !(await sameResolvedFilePath(stitchMaster.output_path, outputPath))) {
      add("canonical narration path differs from the mastered output path");
    }
    if (ttsMaster.policy?.tempo_processing !== false
      || stitchMaster.policy?.tempo_processing !== false) {
      add("canonical narration mastering used or failed to prohibit tempo processing");
    }
  }

  return {
    done: findings.length === 0,
    evidence: findings.length
      ? `synthesized narration artifact contract stale: ${findings.join("; ")}`
      : `synthesized narration artifacts current; plan_sha256=${canonicalPlanSha256}; plan_file_sha256=${planFileSha256}; artifact_plan_binding=${policy.narration_quality_contract ? "canonical_and_file" : "file"}; units=${plannedUnits.length}`,
    planned_units: plannedUnits,
  };
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

export function narrationNativeSpeedLockFindingForTests(
  reportedValues = [],
  expectedSpeed = null,
) {
  const populated = reportedValues.filter(
    (value) => value !== undefined && value !== null && value !== "",
  );
  if (expectedSpeed === undefined || expectedSpeed === null || expectedSpeed === "") {
    return populated.length
      ? { expected: null, actual: populated[0] }
      : null;
  }
  const expected = Number(expectedSpeed);
  const actualValue = firstPresent(...reportedValues);
  const actual = Number(actualValue);
  if (!Number.isFinite(expected) || !Number.isFinite(actual)
    || Math.abs(actual - expected) > 0.001) {
    return {
      expected: Number.isFinite(expected) ? expected : expectedSpeed,
      actual: Number.isFinite(actual) ? actual : actualValue ?? null,
    };
  }
  return null;
}

export function qwenLiamBoundaryContractFindingsForTests(
  stitchReport = {},
  fullQa = {},
) {
  const findings = [];
  const segments = Array.isArray(stitchReport.segments)
    ? stitchReport.segments
    : [];
  const boundaries = Array.isArray(stitchReport.boundaries)
    ? stitchReport.boundaries
    : [];
  const joins = Array.isArray(fullQa?.join_qa?.joins)
    ? fullQa.join_qa.joins
    : [];
  const sampleRate = Number(stitchReport.stitch_sample_rate);
  const expectedSamples = Number.isInteger(sampleRate) && sampleRate > 0
    ? Math.round(QWEN_LIAM_STITCH_CONTRACT.join_silence_ms * sampleRate / 1000)
    : null;
  const add = (code, details = {}) => findings.push({ code, ...details });
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    add("tts_join_stitch_sample_rate_missing", {
      expected: QWEN_LIAM_PRIMARY_LOCK.sample_rate_hz,
      actual: stitchReport.stitch_sample_rate ?? null,
    });
  } else if (sampleRate !== QWEN_LIAM_PRIMARY_LOCK.sample_rate_hz) {
    add("tts_join_stitch_sample_rate_mismatch", {
      expected: QWEN_LIAM_PRIMARY_LOCK.sample_rate_hz,
      actual: sampleRate,
    });
  }
  if (boundaries.length !== Math.max(0, segments.length - 1)) {
    add("tts_join_boundary_count_mismatch", {
      expected: Math.max(0, segments.length - 1),
      actual: boundaries.length,
    });
  }
  if (stitchReport.boundary_qa?.status !== "passed"
    || stitchReport.boundary_qa?.boundary_count !== boundaries.length
    || (stitchReport.boundary_qa?.blockers ?? []).length > 0) {
    add("tts_join_boundary_qa_not_passed");
  }
  if (fullQa?.join_qa?.exact_effective_gap_sample_count_required !== true
    || Number(fullQa?.join_qa?.required_effective_gap_sample_count)
      !== expectedSamples) {
    add("tts_join_full_stream_exact_gap_contract_missing", {
      expected: expectedSamples,
      actual: fullQa?.join_qa?.required_effective_gap_sample_count ?? null,
    });
  }
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index];
    const left = segments[index];
    const right = segments[index + 1];
    const join = joins[index];
    const retainedLeft = Number(left?.prepared_trailing_silence_sample_count);
    const retainedRight = Number(right?.prepared_leading_silence_sample_count);
    const inserted = Number(boundary?.gap_sample_count);
    const actualEffective = retainedLeft + inserted + retainedRight;
    const context = {
      after_unit_id: boundary?.after_unit_id ?? left?.unit_id ?? null,
      before_unit_id: boundary?.before_unit_id ?? right?.unit_id ?? null,
    };
    if (boundary?.after_unit_id !== left?.unit_id
      || boundary?.before_unit_id !== right?.unit_id) {
      add("tts_join_boundary_unit_order_mismatch", context);
    }
    for (const [field, value] of [
      ["prepared_trailing_silence_sample_count", retainedLeft],
      ["gap_sample_count", inserted],
      ["prepared_leading_silence_sample_count", retainedRight],
    ]) {
      if (!Number.isInteger(value) || value < 0) {
        add("tts_join_actual_sample_evidence_missing", {
          ...context,
          field,
          actual: Number.isFinite(value) ? value : null,
        });
      }
    }
    if (Number(boundary?.target_gap_sample_count) !== expectedSamples) {
      add("tts_join_target_gap_sample_count_mismatch", {
        ...context,
        expected: expectedSamples,
        actual: boundary?.target_gap_sample_count ?? null,
      });
    }
    if (Number(boundary?.retained_left_trailing_silence_sample_count)
      !== retainedLeft
      || Number(boundary?.retained_right_leading_silence_sample_count)
        !== retainedRight
      || Number(boundary?.inserted_silence_sample_count) !== inserted) {
      add("tts_join_boundary_sample_provenance_mismatch", context);
    }
    if (actualEffective !== expectedSamples
      || Number(boundary?.effective_gap_sample_count) !== actualEffective) {
      add("tts_join_effective_gap_sample_count_mismatch", {
        ...context,
        expected: expectedSamples,
        actual: actualEffective,
      });
    }
    if (boundary?.status !== "passed" || boundary?.blocker != null) {
      add("tts_join_boundary_status_not_passed", context);
    }
    if (!join
      || join.after_unit_id !== boundary.after_unit_id
      || join.before_unit_id !== boundary.before_unit_id
      || Number(join.target_gap_sample_count) !== expectedSamples
      || Number(join.retained_left_trailing_silence_sample_count)
        !== retainedLeft
      || Number(join.retained_right_leading_silence_sample_count)
        !== retainedRight
      || Number(join.inserted_silence_sample_count) !== inserted
      || Number(join.effective_gap_sample_count) !== actualEffective
      || !["passed", "passed_with_warning", "passed_with_warnings"].includes(
        String(join.status ?? "").toLowerCase(),
      )) {
      add("tts_join_full_stream_boundary_evidence_mismatch", context);
    }
  }
  if (joins.length !== boundaries.length) {
    add("tts_join_full_stream_join_count_mismatch", {
      expected: boundaries.length,
      actual: joins.length,
    });
  }
  return findings;
}

async function wavPcm16SampleCount(filePath) {
  const buffer = await fs.readFile(filePath);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "data") return Math.floor(chunkSize / 2);
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error(`Could not find WAV data chunk: ${filePath}`);
}

export async function narrationOperatorAsrRetryReportValidForTests(ttsReport, currentScriptHash) {
  const expectedPolicy = narrationTtsRetryReportPolicy({
    recoveryProvenances: (ttsReport.results ?? []).map((row) => row.recovery_provenance),
  });
  const expected = expectedPolicy.operator_authorized_asr_consensus_exceptions ?? [];
  if (!expected.length || ttsReport.retry_policy?.retry_only_confirmed_skip_truncation_or_stutter
      !== expectedPolicy.retry_only_confirmed_skip_truncation_or_stutter
    || canonicalQwenBatchSha256(expected) !== canonicalQwenBatchSha256(
      ttsReport.retry_policy?.operator_authorized_asr_consensus_exceptions ?? [])) return false;
  const manifestPath = ttsReport.provider_output_manifest_path;
  if (!manifestPath || await fileSha256(manifestPath) !== ttsReport.provider_output_manifest_sha256) return false;
  const manifest = await readJson(manifestPath, null);
  for (const exception of expected) {
    const result = ttsReport.results.find((row) => row.unit_id === exception.unit_id);
    const providerUnit = manifest?.units?.find((row) => row.unit_id === exception.unit_id);
    const recovery = result?.recovery_provenance;
    if (!recovery || Number(result.attempt) !== 2 || recovery.human_listening_performed !== false
      || recovery.unit_id !== result.unit_id || !providerUnit
      || providerUnit.audio_sha256 !== result.audio_sha256
      || providerUnit.synthesis_identity_sha256 !== result.synthesis_identity_sha256
      || canonicalQwenBatchSha256(providerUnit.recovery_provenance ?? null) !== canonicalQwenBatchSha256(recovery)
      || !recovery.confirmed_evidence_path
      || await fileSha256(recovery.confirmed_evidence_path) !== recovery.confirmed_evidence_sha256) return false;
    const evidence = await readJson(recovery.confirmed_evidence_path, null);
    const reviewed = evidence?.confirmed_units?.find((row) => row.unit_id === result.unit_id);
    if (evidence?.schema !== "goldflow_confirmed_tts_retry_evidence_v2"
      || evidence.evidence_basis !== "operator_authorized_asr_consensus"
      || evidence.human_listening_performed !== false || evidence.attestation != null
      || evidence.maximum_attempts_per_unit !== 1 || !String(evidence.operator_quote ?? "").trim()
      || String(evidence.operator_reason ?? "").trim().length < 40
      || evidence.source_script_sha256 !== currentScriptHash
      || evidence.narration_generation_plan_sha256 !== ttsReport.narration_generation_plan_sha256
      || evidence.narration_generation_plan_file_sha256 !== ttsReport.narration_generation_plan_file_sha256
      || !reviewed || reviewed.selected_attempt !== 1
      || !["truncation", "unexpected_words"].includes(reviewed.defect_type)
      || canonicalQwenBatchSha256(recovery.trigger_codes) !== canonicalQwenBatchSha256([
        `operator_authorized_asr_consensus_${reviewed.defect_type}`,
      ])
      || reviewed.audio_sha256 !== recovery.origin_audio_sha256
      || reviewed.synthesis_identity_sha256 !== recovery.origin_synthesis_identity_sha256) return false;
  }
  return true;
}

async function reviewedAutomatedDeliveryRetryReportValid(ttsReport, currentScriptHash) {
  const expectedPolicy = narrationTtsRetryReportPolicy({
    recoveryProvenances: (ttsReport.results ?? []).map((row) => row.recovery_provenance),
  });
  const expected = expectedPolicy.reviewed_automated_delivery_repairs ?? [];
  if (!expected.length || ttsReport.retry_policy?.retry_only_confirmed_skip_truncation_or_stutter !== false
    || canonicalQwenBatchSha256(expected) !== canonicalQwenBatchSha256(
      ttsReport.retry_policy?.reviewed_automated_delivery_repairs ?? [])) return false;
  for (const exception of expected) {
    const result = (ttsReport.results ?? []).find((row) => row.unit_id === exception.unit_id);
    const recovery = result?.recovery_provenance;
    if (!recovery || Number(result.attempt) !== 2
      || recovery.evidence_basis !== "reviewed_automated_delivery_qa"
      || recovery.human_listening_performed !== false
      || !recovery.confirmed_evidence_path
      || await fileSha256(recovery.confirmed_evidence_path) !== recovery.confirmed_evidence_sha256) return false;
    const evidence = await readJson(recovery.confirmed_evidence_path, null);
    const reviewed = evidence?.confirmed_units?.find((row) => row.unit_id === result.unit_id);
    if (evidence?.schema !== "goldflow_confirmed_tts_retry_evidence_v2"
      || evidence.evidence_basis !== "reviewed_automated_delivery_qa"
      || evidence.authorization_origin !== "user_authorized_autonomous_asr_qa"
      || evidence.human_listening_performed !== false
      || evidence.source_script_sha256 !== currentScriptHash
      || evidence.narration_generation_plan_sha256 !== ttsReport.narration_generation_plan_sha256
      || evidence.narration_generation_plan_file_sha256 !== ttsReport.narration_generation_plan_file_sha256
      || !reviewed || reviewed.defect_type !== "delivery"
      || canonicalQwenBatchSha256(recovery.trigger_codes)
        !== canonicalQwenBatchSha256(["reviewed_automated_delivery_qa_delivery"])
      || reviewed.audio_sha256 !== recovery.origin_audio_sha256
      || reviewed.synthesis_identity_sha256 !== recovery.origin_synthesis_identity_sha256) return false;
  }
  return true;
}

export async function narrationHeardPronunciationRetryReportValidForTests(ttsReport, currentScriptHash) {
  const results = ttsReport?.results ?? [];
  const expectedPolicy = narrationTtsRetryReportPolicy({
    recoveryProvenances: results.map((row) => row.recovery_provenance),
  });
  const expected = expectedPolicy.operator_confirmed_pronunciation_exceptions ?? [];
  const hashValid = (value) => /^[a-f0-9]{64}$/u.test(String(value ?? ""));
  if (expected.length !== 1 || !hashValid(currentScriptHash)
    || ttsReport.source_script_hash !== currentScriptHash
    || ttsReport.retry_policy?.retry_only_confirmed_skip_truncation_or_stutter
      !== expectedPolicy.retry_only_confirmed_skip_truncation_or_stutter
    || canonicalQwenBatchSha256(expected) !== canonicalQwenBatchSha256(
      ttsReport.retry_policy?.operator_confirmed_pronunciation_exceptions ?? [])) return false;
  const planPath = ttsReport.narration_generation_plan_path;
  const manifestPath = ttsReport.provider_output_manifest_path;
  if (!planPath || !manifestPath
    || !hashValid(ttsReport.narration_generation_plan_sha256)
    || !hashValid(ttsReport.narration_generation_plan_file_sha256)
    || await fileSha256(planPath) !== ttsReport.narration_generation_plan_file_sha256
    || await fileSha256(manifestPath) !== ttsReport.provider_output_manifest_sha256) return false;
  const [plan, manifest] = await Promise.all([readJson(planPath, null), readJson(manifestPath, null)]);
  if (plan?.plan_sha256 !== ttsReport.narration_generation_plan_sha256
    || plan?.source_script_hash !== currentScriptHash) return false;
  const unitId = expected[0].unit_id;
  const matching = (rows) => (rows ?? []).filter((row) => row.unit_id === unitId);
  const resultRows = matching(results);
  const providerRows = matching(manifest?.units);
  const planRows = matching(narrationPlanUnitsForStatus(plan));
  if (resultRows.length !== 1 || providerRows.length !== 1 || planRows.length !== 1) return false;
  const [result] = resultRows;
  const [providerUnit] = providerRows;
  const [unit] = planRows;
  const recovery = result.recovery_provenance;
  const spokenHash = sha256(String(unit.spoken_text ?? ""));
  if (Number(result.attempt) !== 2 || Number(providerUnit.attempt) !== 2
    || recovery?.schema !== "goldflow_qwen_exact_unit_recovery_provenance_v1"
    || recovery.recovery_mode !== QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE
    || recovery.evidence_basis !== "operator_confirmed_pronunciation"
    || recovery.human_listening_performed !== true || recovery.unit_id !== unitId
    || unit.spoken_text_sha256 !== spokenHash || result.spoken_text_sha256 !== spokenHash
    || providerUnit.spoken_text_sha256 !== spokenHash || recovery.spoken_text_sha256 !== spokenHash
    || canonicalQwenBatchSha256(recovery.trigger_codes) !== canonicalQwenBatchSha256(["operator_confirmed_pronunciation"])
    || !hashValid(result.audio_sha256) || !hashValid(result.synthesis_identity_sha256)
    || providerUnit.audio_sha256 !== result.audio_sha256
    || providerUnit.synthesis_identity_sha256 !== result.synthesis_identity_sha256
    || !providerUnit.audio_path || await fileSha256(providerUnit.audio_path) !== result.audio_sha256
    || canonicalQwenBatchSha256(providerUnit.recovery_provenance ?? null) !== canonicalQwenBatchSha256(recovery)
    || !recovery.confirmed_evidence_path || !hashValid(recovery.confirmed_evidence_sha256)
    || await fileSha256(recovery.confirmed_evidence_path) !== recovery.confirmed_evidence_sha256) return false;
  const evidence = await readJson(recovery.confirmed_evidence_path, null);
  const reviewed = evidence?.confirmed_units?.[0];
  const word = String(reviewed?.expected_spoken_word ?? "").trim();
  const heard = String(reviewed?.heard_pronunciation ?? "").trim();
  if (evidence?.schema !== "goldflow_confirmed_tts_retry_evidence_v2"
    || evidence.evidence_basis !== "operator_confirmed_pronunciation"
    || evidence.human_listening_performed !== true
    || evidence.attestation !== "operator_heard_pronunciation_in_exact_selected_audio"
    || evidence.maximum_attempts_per_unit !== 1
    || !String(evidence.operator_quote ?? "").trim()
    || String(evidence.operator_reason ?? "").trim().length < 40
    || !String(evidence.authorized_by ?? "").trim() || !Number.isFinite(Date.parse(evidence.authorized_at))
    || evidence.source_script_sha256 !== currentScriptHash
    || evidence.narration_generation_plan_sha256 !== ttsReport.narration_generation_plan_sha256
    || evidence.narration_generation_plan_file_sha256 !== ttsReport.narration_generation_plan_file_sha256
    || evidence.confirmed_units?.length !== 1 || reviewed?.unit_id !== unitId
    || reviewed.selected_attempt !== 1 || reviewed.defect_type !== "pronunciation"
    || !String(reviewed.listen_note ?? "").trim()
    || !/^[\p{L}]+(?:['’][\p{L}]+)*$/u.test(word)
    || !(String(unit.spoken_text).match(/[\p{L}]+(?:['’][\p{L}]+)*/gu) ?? []).includes(word)
    || !heard || heard.toLocaleLowerCase() === word.toLocaleLowerCase()
    || reviewed.spoken_text_sha256 !== spokenHash
    || reviewed.audio_sha256 !== recovery.origin_audio_sha256
    || reviewed.synthesis_identity_sha256 !== recovery.origin_synthesis_identity_sha256
    || !evidence.pre_retry_narration_report_path || !hashValid(evidence.pre_retry_narration_report_sha256)
    || await fileSha256(evidence.pre_retry_narration_report_path) !== evidence.pre_retry_narration_report_sha256) return false;
  const prior = await readJson(evidence.pre_retry_narration_report_path, null);
  const priorRows = matching(prior?.results);
  const original = priorRows[0];
  if (prior?.schema !== "goldflow_narration_tts_report_v1" || prior.status !== "blocked"
    || prior.source_script_hash !== currentScriptHash
    || prior.narration_generation_plan_sha256 !== ttsReport.narration_generation_plan_sha256
    || prior.narration_generation_plan_file_sha256 !== ttsReport.narration_generation_plan_file_sha256
    || priorRows.length !== 1 || Number(original?.attempt) !== 1
    || original.spoken_text_sha256 !== spokenHash
    || original.audio_sha256 !== recovery.origin_audio_sha256
    || original.synthesis_identity_sha256 !== recovery.origin_synthesis_identity_sha256
    || !hashValid(original.audio_sha256) || !hashValid(original.synthesis_identity_sha256)
    || !original.audio_path || await fileSha256(original.audio_path) !== original.audio_sha256) return false;
  return true;
}

async function narrationTtsStitchComplete(episodeDir, episode, currentScriptHash, identity) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const narrationQualityContract = narrationQualityContractForIdentity(identity);
  let policy;
  try {
    policy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), {
      production: String(identity.run_intent ?? "production").toLowerCase() === "production",
    });
  } catch (error) {
    return {
      done: false,
      evidence: `narration TTS run identity policy invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const ttsReportPath = path.join(episodeDir, `narration_tts_report_${episode}.json`);
  const stitchReportPath = path.join(episodeDir, `audio_stitch_report_${episode}-narration.json`);
  const [ttsReport, stitchReport] = await Promise.all([
    readJson(ttsReportPath, null),
    readJson(stitchReportPath, null),
  ]);
  // A new or removed policy receipt invalidates only derived review decisions,
  // never the retained synthesis. Re-finalization reuses exact QA checkpoints.
  try {
    await loadLowMarginDisposition({ episodeDir, episode,
      expectedBinding: ttsReport?.voice_low_margin_disposition ?? null });
  } catch (error) {
    return { done: false, state: "blocked",
      evidence: `Narration low-margin disposition provenance requires review refresh: ${error.message}`,
      next_command_shape: `node bin/goldflow.mjs tts finalize-provider --episode-dir ${episodeDir}` };
  }
  if (!ttsReport) {
    if (EXTERNAL_NARRATION_TTS_PROVIDERS.includes(policy.primary?.provider)) {
      const providerOutputPath = path.join(
        episodeDir,
        `narration_provider_output_manifest_${episode}.json`,
      );
      if (!(await exists(providerOutputPath))) {
        return {
          done: false,
          evidence: `identity-locked ${policy.primary.provider} provider output manifest missing`,
          next_command_shape: `node bin/goldflow.mjs tts import-provider --episode-dir ${episodeDir} --results <provider-results.json>`,
        };
      }
      return {
        done: false,
        evidence: `provider output is imported; delivery/stitch/mastering report missing`,
        next_command_shape: `node bin/goldflow.mjs tts finalize-provider --episode-dir ${episodeDir}`,
      };
    }
    return { done: false, evidence: `narration_tts_report_${episode}.json missing` };
  }
  if (!statusPassed(ttsReport.status)) {
    const triage = await readJson(path.join(episodeDir,
      `manual_blocker_triage_qwen_tts_stitch_${episode}.json`), null);
    if (ttsReport.status === "blocked"
      && triage?.status === "operator_hold_pending_exact_boundary_recovery"
      && triage.source_script_sha256 === currentScriptHash
      && triage.blocked_report_sha256 === await fileSha256(ttsReportPath)) {
      return { done: false, state: "blocked",
        evidence: "Reviewed second-take narration blockers remain; two-attempt limit forbids another full-unit submission",
        next_command_shape: "Operator hold: implement a guarded exact-boundary repair for the material defects; do not rerun all narration units or waive confirmed omissions." };
    }
    if (narrationQualityContract && ttsReport.status === "blocked"
      && policy.primary.provider === "qwen_local") {
      const retryEvidencePath = path.join(episodeDir, `narration_confirmed_retry_evidence_${episode}.json`);
      const retryEvidence = await readJson(retryEvidencePath, null);
      const blockedIds = [...new Set((ttsReport.blockers ?? []).map((row) => row.unit_id).filter(Boolean))];
      const retryIds = (retryEvidence?.confirmed_units ?? []).map((row) => row.unit_id);
      if (blockedIds.length && retryEvidence?.evidence_basis === "reviewed_automated_delivery_qa"
        && retryEvidence.source_script_sha256 === currentScriptHash
        && retryEvidence.narration_generation_plan_sha256 === ttsReport.narration_generation_plan_sha256
        && retryEvidence.pre_retry_narration_report_sha256 === await fileSha256(ttsReportPath)
        && canonicalQwenBatchSha256([...blockedIds].sort())
          === canonicalQwenBatchSha256([...retryIds].sort())) {
        return { done: false, state: "blocked",
          evidence: `Reviewed automated delivery QA requires exact retakes of ${blockedIds.length} units; accepted units remain immutable`,
          next_command_shape: `node bin/goldflow.mjs tts narrate --episode-dir ${episodeDir} --confirmed-retry-unit-ids ${blockedIds.join(",")} --confirmed-retry-evidence ${retryEvidencePath}` };
      }
    }
    return { done: false, evidence: `narration_tts_report_${episode}.json status=${ttsReport.status ?? "missing"}` };
  }
  if (!stitchReport) return { done: false, evidence: `audio_stitch_report_${episode}-narration.json missing` };
  if (!statusPassed(stitchReport.status)) {
    return { done: false, evidence: `audio_stitch_report_${episode}-narration.json status=${stitchReport.status ?? "missing"}` };
  }
  for (const [label, artifact] of [["TTS", ttsReport], ["stitch", stitchReport]]) {
    const sourceHash = artifact.source_script_hash ?? artifact.script_hash ?? null;
    if (sourceHash !== currentScriptHash) {
      return { done: false, evidence: `${label} narration source hash ${sourceHash ?? "missing"}; required ${currentScriptHash}` };
    }
  }
  const proofImport = await genericProofBaselineNarrationComplete({
    episodeDir,
    episode,
    currentScriptHash,
    identity,
    ttsReport,
    stitchReport,
  });
  if (proofImport.applicable) return { done: proofImport.done, evidence: proofImport.evidence };
  if (narrationQualityContract) {
    const planPath = path.join(episodeDir, "narration_generation_plan.json");
    const unitDeliveryPath = path.join(
      episodeDir,
      `narration_unit_delivery_qa_${episode}.json`,
    );
    const providerOutputPath = path.join(
      episodeDir,
      `narration_provider_output_manifest_${episode}.json`,
    );
    const listenPacketPath = path.join(
      episodeDir,
      `narration_exact_listen_review_packet_${episode}.json`,
    );
    const listenDecisionPath = path.join(
      episodeDir,
      `narration_exact_listen_review_decision_${episode}.json`,
    );
    const [plan, unitDelivery, providerOutput, listenPacket, listenDecision] = await Promise.all([
      readJson(planPath, null),
      readJson(unitDeliveryPath, null),
      readJson(providerOutputPath, null),
      readJson(listenPacketPath, null),
      readJson(listenDecisionPath, null),
    ]);
    const planUnits = narrationPlanUnitsForStatus(plan);
    const planFileSha256 = await fileSha256(planPath);
    const expectedUnits = planUnits;
    const providerValidation = validateNarrationProviderOutputManifest(
      providerOutput,
      expectedUnits,
      {
        generationPlanSha256: plan?.plan_sha256 ?? planFileSha256,
        generationPlanFileSha256: planFileSha256,
        qualityContractSha256: narrationQualityContract.contract_sha256,
        provider: policy.primary.provider,
        voiceId: policy.primary.voice_id,
        voiceSha256: policy.primary.voice_sha256,
      },
    );
    const v2Findings = [];
    try {
      await loadLowMarginDisposition({ episodeDir, episode,
        expectedBinding: unitDelivery?.voice_low_margin_disposition ?? null });
    } catch (error) {
      return { done: false, state: "blocked", evidence: `Narration low-margin delivery binding is stale: ${error.message}`,
        next_command_shape: `node bin/goldflow.mjs tts finalize-provider --episode-dir ${episodeDir}` };
    }
    if (!qaStatusPassed(unitDelivery?.status)
      || unitDelivery?.quality_contract_sha256
        !== narrationQualityContract.contract_sha256
      || Number(unitDelivery?.blocked_unit_count ?? 0) !== 0
      || (unitDelivery?.blockers ?? []).length !== 0) {
      const retryEvidencePath = path.join(episodeDir, `narration_confirmed_retry_evidence_${episode}.json`);
      const retryEvidence = await readJson(retryEvidencePath, null);
      const blockedIds = [...new Set((unitDelivery?.blockers ?? []).map((row) => row.unit_id).filter(Boolean))];
      const retryIds = (retryEvidence?.confirmed_units ?? []).map((row) => row.unit_id);
      if (policy.primary.provider === "qwen_local" && blockedIds.length
        && retryEvidence?.evidence_basis === "reviewed_automated_delivery_qa"
        && retryEvidence.source_script_sha256 === currentScriptHash
        && retryEvidence.narration_generation_plan_sha256 === plan?.plan_sha256
        && retryEvidence.pre_retry_narration_report_sha256 === await fileSha256(ttsReportPath)
        && canonicalQwenBatchSha256([...blockedIds].sort())
          === canonicalQwenBatchSha256([...retryIds].sort())) {
        return { done: false, state: "blocked",
          evidence: `Reviewed automated delivery QA requires exact retakes of ${blockedIds.length} units; accepted units remain immutable`,
          next_command_shape: `node bin/goldflow.mjs tts narrate --episode-dir ${episodeDir} --confirmed-retry-unit-ids ${blockedIds.join(",")} --confirmed-retry-evidence ${retryEvidencePath}` };
      }
      v2Findings.push("unit_delivery_qa");
    }
    if (providerValidation.status !== "passed") {
      v2Findings.push(...providerValidation.findings.map((finding) => finding.code));
    }
    for (const row of providerOutput?.units ?? []) {
      if (!row.audio_path || !row.audio_sha256
        || !(await exists(row.audio_path))
        || await fileSha256(row.audio_path) !== row.audio_sha256) {
        v2Findings.push(`provider_audio_hash:${row.unit_id ?? "unknown"}`);
      }
    }
    const expectedListenCount = Number(unitDelivery?.listen_review_unit_count ?? 0);
    const listenPacketCurrent =
      listenPacket?.schema === NARRATION_EXACT_LISTEN_REVIEW_PACKET_SCHEMA
      && listenPacket?.packet_sha256
        === narrationExactListenReviewPacketSha256(listenPacket)
      && listenPacket?.narration_generation_plan_sha256
        === (plan?.plan_sha256 ?? planFileSha256)
      && listenPacket?.narration_generation_plan_file_sha256 === planFileSha256
      && listenPacket?.narration_quality_contract_sha256
        === narrationQualityContract.contract_sha256
      && Number(listenPacket?.item_count ?? -1) === expectedListenCount;
    if (!listenPacketCurrent) {
      v2Findings.push("exact_listen_review_packet");
    } else {
      for (const item of listenPacket.items ?? []) {
        if (!item.audio_path || !item.audio_sha256
          || !(await exists(item.audio_path))
          || await fileSha256(item.audio_path) !== item.audio_sha256) {
          v2Findings.push(`exact_listen_audio_hash:${item.unit_id ?? "unknown"}`);
        }
      }
    }
    if (!narrationUsesAutomatedAsrAcceptance(narrationQualityContract)
      && listenPacketCurrent && expectedListenCount > 0) {
      const listenDecisionValidation = validateNarrationExactListenReviewDecision(
        listenPacket,
        listenDecision,
      );
      if (listenDecisionValidation.status === "repair_required") {
        const retryEvidencePath = path.join(
          episodeDir,
          `narration_confirmed_retry_evidence_${episode}.json`,
        );
        const repairUnitIds = listenDecisionValidation.repair_unit_ids;
        return {
          done: false,
          state: "blocked",
          evidence: `Exact narration listen review confirmed audible defects in ${repairUnitIds.join(", ")}; passed units remain immutable`,
          next_command_shape: policy.primary.provider === "qwen_local"
            && await exists(retryEvidencePath)
            ? `node bin/goldflow.mjs tts narrate --episode-dir ${episodeDir} --confirmed-retry-unit-ids ${repairUnitIds.join(",")} --confirmed-retry-evidence ${retryEvidencePath}`
            : EXTERNAL_NARRATION_TTS_PROVIDERS.includes(policy.primary.provider)
              ? `Regenerate only ${repairUnitIds.join(",")} with ${policy.primary.provider}, preserve every other accepted WAV/hash, then run node bin/goldflow.mjs tts import-provider --episode-dir ${episodeDir} --results <complete-provider-results-with-exact-repair.json>`
              : "Manual exact-unit repair planning required: inspect the hash-bound listen decision; do not regenerate passed audio.",
        };
      }
      if (listenDecisionValidation.status !== "approved") {
        const unitIds = (listenPacket.unit_ids ?? []).join(",");
        return {
          done: false,
          state: "blocked",
          evidence: `Exact narration listen approval missing or stale for ${expectedListenCount} immutable unit(s): ${listenDecisionValidation.findings.map((finding) => finding.code).join(", ")}`,
          next_command_shape: `node bin/goldflow.mjs tts approve-listen --episode-dir ${episodeDir} --reviewer <name> --accept-unit-ids ${unitIds} --attestation exact_audio_listened_end_to_end`,
        };
      }
    }
    if (ttsReport.mastering?.status !== "passed"
      || stitchReport.mastering?.status !== "passed") {
      return {
        done: false,
        evidence: "Exact narration delivery is accepted; canonical mastering/final-stream materialization is pending",
        next_command_shape: `node bin/goldflow.mjs tts finalize-provider --episode-dir ${episodeDir}`,
      };
    }
    const subjectiveReviewWaiver = ttsReport?.subjective_review_waiver ?? null;
    const subjectiveReviewWaived =
      subjectiveReviewWaiver?.schema
        === "goldflow_operator_narration_qa_waiver_v1"
      && subjectiveReviewWaiver?.status === "skipped_with_waiver"
      && subjectiveReviewWaiver?.skip_subjective_review === true
      && subjectiveReviewWaiver?.human_listening_performed === false
      && String(subjectiveReviewWaiver?.reason ?? "").trim().length > 0
      && subjectiveReviewWaiver?.narration_generation_plan_sha256
        === (plan?.plan_sha256 ?? planFileSha256)
      && subjectiveReviewWaiver?.narration_generation_plan_file_sha256
        === planFileSha256
      && subjectiveReviewWaiver?.narration_quality_contract_sha256
        === narrationQualityContract.contract_sha256
      && subjectiveReviewWaiver?.narration_audio_sha256
        === stitchReport.output_sha256;
    if (narrationQualityContract.subjective_review
      ?.hash_bound_sampling_manifest_required === true
      && !subjectiveReviewWaived) {
      const subjectiveManifestPath = path.join(
        episodeDir,
        `narration_subjective_review_manifest_${episode}.json`,
      );
      const subjectiveDecisionPath = path.join(
        episodeDir,
        `narration_subjective_review_decision_${episode}.json`,
      );
      const [subjectiveManifest, subjectiveDecision] = await Promise.all([
        readJson(subjectiveManifestPath, null),
        readJson(subjectiveDecisionPath, null),
      ]);
      try {
        await loadNarrationSourceStructure({
          episodeDir, episode, plan,
          sourceScriptSha256: currentScriptHash,
          generationPlanSha256: plan?.plan_sha256 ?? planFileSha256,
          generationPlanFileSha256: planFileSha256,
          expectedBinding: subjectiveManifest?.source_structure ?? null,
        });
      } catch (error) {
        return {
          done: false,
          state: "blocked",
          evidence: `Narration source-structure review provenance failed: ${error.message}`,
          next_command_shape: `node bin/goldflow.mjs tts finalize-provider --episode-dir ${episodeDir}`,
        };
      }
      const subjectiveValidation = validateNarrationSubjectiveReviewManifest(
        subjectiveManifest,
      );
      const subjectiveAudioCurrent = subjectiveValidation.status === "passed"
        && subjectiveManifest?.audio_path
        && await exists(subjectiveManifest.audio_path)
        && await fileSha256(subjectiveManifest.audio_path)
          === subjectiveManifest.audio_sha256;
      const subjectiveLineageCurrent = subjectiveValidation.status === "passed"
        && subjectiveManifest?.manifest_sha256
          === narrationSubjectiveReviewManifestSha256(subjectiveManifest)
        && subjectiveManifest?.narration_generation_plan_sha256
          === (plan?.plan_sha256 ?? planFileSha256)
        && subjectiveManifest?.narration_generation_plan_file_sha256
          === planFileSha256
        && subjectiveManifest?.narration_quality_contract_sha256
          === narrationQualityContract.contract_sha256
        && subjectiveManifest?.audio_sha256 === stitchReport.output_sha256;
      if (!subjectiveAudioCurrent || !subjectiveLineageCurrent) {
        return {
          done: false,
          state: "blocked",
          evidence: `Mandatory canonical narration subjective-review manifest is missing or stale: ${subjectiveValidation.findings.map((finding) => finding.code).join(", ") || "lineage_or_audio_hash"}`,
          next_command_shape: `node bin/goldflow.mjs tts finalize-provider --episode-dir ${episodeDir}`,
        };
      }
      const subjectiveDecisionValidation =
        validateNarrationSubjectiveReviewDecision(
          subjectiveManifest,
          subjectiveDecision,
        );
      if (subjectiveDecisionValidation.status === "repair_required") {
        return {
          done: false,
          state: "blocked",
          evidence: `Subjective narration review confirmed defects in exact unit scope ${subjectiveDecisionValidation.repair_unit_ids.join(", ")}; every other unit remains immutable`,
          next_command_shape: "Inspect the subjective review decision and authorize the narrowest exact-unit or exact-boundary repair; never regenerate the full narration.",
        };
      }
      if (subjectiveDecisionValidation.status !== "approved") {
        return {
          done: false,
          state: "blocked",
          evidence: `Mandatory subjective narration review is pending for ${subjectiveManifest.sample_count} hash-bound canonical-stream sample(s): ${subjectiveDecisionValidation.findings.map((finding) => finding.code).join(", ")}`,
          next_command_shape: `node bin/goldflow.mjs tts approve-subjective --episode-dir ${episodeDir} --reviewer <name> --accept-all true --attestation all_hash_bound_narration_samples_listened_end_to_end`,
        };
      }
    }
    if (stitchReport.narration_quality_contract_sha256
        !== narrationQualityContract.contract_sha256
      || stitchReport.stitch_policy_version
        !== "narration_alignment_safe_semantic_stitch_v2"
      || stitchReport.stitch_policy?.amplitude_only_trimming !== false
      || stitchReport.stitch_policy?.fade_over_speech !== false
      || stitchReport.stitch_policy?.semantic_boundary_classes !== true
      || stitchReport.sample_accounting?.status !== "passed"
      || stitchReport.sample_accounting?.exact_sample_accounting !== true
      || stitchReport.boundary_qa?.status !== "passed") {
      v2Findings.push("alignment_safe_semantic_stitch");
    }
    if (v2Findings.length) {
      return {
        done: false,
        evidence: `narration quality V2 artifacts missing or stale: ${[...new Set(v2Findings)].slice(0, 12).join(", ")}`,
      };
    }
  }

  const synthesizedArtifacts = await synthesizedNarrationArtifactsComplete({
    episodeDir,
    episode,
    currentScriptHash,
    policy,
    ttsReport,
    stitchReport,
  });
  if (!synthesizedArtifacts.done) {
    return { done: false, evidence: synthesizedArtifacts.evidence };
  }

  const reportedProvider = firstPresent(
    ttsReport.primary_provider,
    ttsReport.primary?.provider,
    ttsReport.provider,
    stitchReport.primary_provider,
  );
  if (reportedProvider !== policy.primary.provider) {
    return { done: false, evidence: `narration primary provider=${reportedProvider ?? "missing"}; required ${policy.primary.provider}` };
  }
  const reportedModelId = firstPresent(
    ttsReport.primary_model_id,
    ttsReport.primary?.model_id,
    ttsReport.model?.model_id,
    ttsReport.model_id,
  );
  const reportedRevision = firstPresent(
    ttsReport.primary_model_revision,
    ttsReport.primary?.model_revision,
    ttsReport.model?.model_revision,
    ttsReport.model_revision,
  );
  const reportedVoiceId = firstPresent(
    ttsReport.narrator_voice_id,
    ttsReport.primary?.voice_id,
    ttsReport.model?.voice_id,
    ttsReport.voice_id,
  );
  const reportedVoiceHash = firstPresent(
    ttsReport.primary?.voice_sha256,
    ttsReport.model?.voice_sha256,
    ttsReport.voice_sha256,
  );
  const reportedSpeedValues = [
    ttsReport.tts_native_speed,
    ttsReport.primary?.native_speed,
    ttsReport.native_speed,
    stitchReport.native_speed,
  ];
  const reportedSpeedValue = firstPresent(...reportedSpeedValues);
  const pinMismatches = [];
  if (reportedModelId !== policy.primary.model_id) pinMismatches.push(`model=${reportedModelId ?? "missing"}`);
  if (reportedRevision !== policy.primary.model_revision) pinMismatches.push(`revision=${reportedRevision ?? "missing"}`);
  if (reportedVoiceId !== policy.primary.voice_id) pinMismatches.push(`voice=${reportedVoiceId ?? "missing"}`);
  if (reportedVoiceHash !== policy.primary.voice_sha256) pinMismatches.push(`voice_hash=${reportedVoiceHash ?? "missing"}`);
  const speedFinding = narrationNativeSpeedLockFindingForTests(
    reportedSpeedValues,
    policy.primary.native_speed,
  );
  if (speedFinding) {
    pinMismatches.push(
      `speed=${speedFinding.actual ?? "missing"}; expected=${speedFinding.expected ?? "none"}`,
    );
  }
  if (pinMismatches.length) {
    return { done: false, evidence: `narration provider lock mismatch: ${pinMismatches.join(", ")}` };
  }
  if (ttsReport.post_tempo_normalized === true || stitchReport.post_tempo_normalized === true) {
    return { done: false, evidence: "stitched narration uses forbidden post-TTS tempo processing" };
  }
  if (policy.primary.provider === "qwen_local") {
    if (Number(ttsReport.effective_concurrency) !== 1) {
      return { done: false, evidence: `Qwen Liam effective concurrency=${ttsReport.effective_concurrency ?? "missing"}; required 1` };
    }
    if (!narrationQualityContract
      && (Number(stitchReport.unit_gap_sec) !== QWEN_LIAM_STITCH_CONTRACT.join_silence_ms / 1000
        || Number(stitchReport.segment_gap_sec) !== QWEN_LIAM_STITCH_CONTRACT.join_silence_ms / 1000)) {
      return { done: false, evidence: `Qwen Liam joins must be ${QWEN_LIAM_STITCH_CONTRACT.join_silence_ms} ms at every unit/segment boundary` };
    }
    const declaredFallbackIds = ttsReport.fallback_unit_ids
      ?? ttsReport.fallback_selected_unit_ids
      ?? [];
    if ((Array.isArray(declaredFallbackIds) && declaredFallbackIds.length)
      || ttsReport.fallback_usage != null) {
      return { done: false, evidence: "Qwen Liam narration must not select a fallback provider or voice" };
    }
    const warningOnlyAutomatedQaRequired = String(
      ttsReport.selection_policy_version ?? "",
    ).startsWith("narration_tts_selection_v4_");
    const explicitSingleSubmissionRepairPolicy =
      Number(ttsReport.retry_policy?.maximum_creative_submissions_per_invocation) === 1
      && ttsReport.retry_policy?.structural_failure_action === "stop_and_emit_exact_unit_repair_scope";
    const warningOnlyAutomatedQaPassed = !warningOnlyAutomatedQaRequired || (
      ttsReport.retry_policy?.automated_acoustic_findings_are_review_warnings === true
      && ttsReport.retry_policy?.automated_asr_findings_are_review_warnings === true
      && ttsReport.retry_policy?.automated_voice_continuity_findings_are_review_warnings === true
      && ttsReport.retry_policy?.automated_qa_warnings_block_stitching === false
      && ttsReport.retry_policy?.automated_qa_warnings_trigger_retry === false
      && (explicitSingleSubmissionRepairPolicy
        ? ttsReport.retry_policy?.automatic_retry_limited_to_structural_audio_or_synthesis_process_failures === false
        : ttsReport.retry_policy?.automatic_retry_limited_to_structural_audio_or_synthesis_process_failures === true)
    );
    const qualityV2RetryPolicyPassed = narrationQualityContract
      ? ttsReport.retry_policy?.uncertain_asr_findings_are_warning_only === true
        && ttsReport.retry_policy?.confirmed_dual_asr_delivery_defects_block_stitching === true
        && ttsReport.retry_policy?.exact_suspect_confirmation_required === true
        && ttsReport.retry_policy?.automated_qa_warnings_trigger_retry === false
        && ttsReport.retry_policy?.structural_failure_action
          === "stop_and_emit_exact_unit_repair_scope"
      : true;
    const hasOperatorAsrRetry = (ttsReport.results ?? []).some((row) => (
      row.recovery_provenance?.evidence_basis === "operator_authorized_asr_consensus"
    )) || (ttsReport.retry_policy?.operator_authorized_asr_consensus_exceptions?.length ?? 0) > 0;
    const hasHeardPronunciationRetry = (ttsReport.results ?? []).some((row) => (
      row.recovery_provenance?.evidence_basis === "operator_confirmed_pronunciation"
    )) || (ttsReport.retry_policy?.operator_confirmed_pronunciation_exceptions?.length ?? 0) > 0;
    const hasReviewedAutomatedRetry = (ttsReport.results ?? []).some((row) => (
      row.recovery_provenance?.evidence_basis === "reviewed_automated_delivery_qa"
    )) || (ttsReport.retry_policy?.reviewed_automated_delivery_repairs?.length ?? 0) > 0;
    const exactRetryTypePolicyPassed = hasOperatorAsrRetry || hasHeardPronunciationRetry || hasReviewedAutomatedRetry
      ? narrationQualityContract
        && (!hasOperatorAsrRetry || await narrationOperatorAsrRetryReportValidForTests(ttsReport, currentScriptHash))
        && (!hasHeardPronunciationRetry || await narrationHeardPronunciationRetryReportValidForTests(ttsReport, currentScriptHash))
        && (!hasReviewedAutomatedRetry || await reviewedAutomatedDeliveryRetryReportValid(ttsReport, currentScriptHash))
      : ttsReport.retry_policy?.retry_only_confirmed_skip_truncation_or_stutter === true;
    if (ttsReport.retry_policy?.uncertain_asr_findings_are_warning_only !== true
      || !exactRetryTypePolicyPassed
      || (explicitSingleSubmissionRepairPolicy
        ? ttsReport.retry_policy?.automatic_retry_limited_to_failed_empty_or_objectively_truncated_audio !== false
        : ttsReport.retry_policy?.automatic_retry_limited_to_failed_empty_or_objectively_truncated_audio !== true)
      || ttsReport.retry_policy?.other_acoustic_or_voice_identity_blockers_require_review !== true
      || !warningOnlyAutomatedQaPassed
      || !qualityV2RetryPolicyPassed) {
      return { done: false, evidence: "Qwen narration retry policy is stale: uncertain findings remain review-only, confirmed dual-ASR delivery defects block, and all recovery stays exact-unit with no automatic creative resubmission" };
    }
    if (!narrationQualityContract) {
      const fullQaForBoundaryContract = await readJson(
        path.join(episodeDir, `narration_full_stream_qa_${episode}.json`),
        null,
      );
      const boundaryFindings = qwenLiamBoundaryContractFindingsForTests(
        stitchReport,
        fullQaForBoundaryContract,
      );
      if (boundaryFindings.length) {
        return {
          done: false,
          evidence: `Qwen Liam exact 80 ms boundary contract stale: ${boundaryFindings
            .slice(0, 8)
            .map((finding) => finding.code)
            .join(", ")}`,
        };
      }
    }
    for (const boundary of stitchReport.boundaries ?? []) {
      const gapPath = boundary?.gap_wav;
      const declaredGapSamples = Number(boundary?.gap_sample_count);
      if (declaredGapSamples > 0) {
        if (!gapPath || !(await exists(gapPath))) {
          return {
            done: false,
            evidence: `Qwen Liam boundary ${boundary.after_unit_id ?? "unknown"} gap WAV missing`,
          };
        }
        const actualGapSamples = await wavPcm16SampleCount(gapPath).catch(() => null);
        if (actualGapSamples !== declaredGapSamples) {
          return {
            done: false,
            evidence: `Qwen Liam boundary ${boundary.after_unit_id ?? "unknown"} gap WAV samples=${actualGapSamples ?? "unreadable"}; report requires ${declaredGapSamples}`,
          };
        }
      }
    }
  }

  const unitQaStatus = firstPresent(ttsReport.unit_qa_status, ttsReport.unit_qa?.status);
  const stitchQaStatus = firstPresent(
    stitchReport.stitch_qa_status,
    stitchReport.stitch?.status,
    stitchReport.join_qa?.status,
  );
  const fullStreamQaStatus = firstPresent(
    ttsReport.full_stream_qa_status,
    ttsReport.full_stream_qa?.status,
    stitchReport.full_stream_qa_status,
    stitchReport.full_stream_qa?.status,
  );
  if (!statusPassed(unitQaStatus)) {
    return { done: false, evidence: `narration per-unit QA status=${unitQaStatus ?? "missing"}` };
  }
  if (!statusPassed(stitchQaStatus)) {
    return { done: false, evidence: `narration stitch/join QA status=${stitchQaStatus ?? "missing"}` };
  }
  if (!statusPassed(fullStreamQaStatus)) {
    return { done: false, evidence: `narration full-stream QA status=${fullStreamQaStatus ?? "missing"}` };
  }
  if (firstPresent(ttsReport.qa_policy, ttsReport.unit_qa_policy_version) !== policy.qa_policy) {
    return {
      done: false,
      evidence: `narration QA policy=${firstPresent(ttsReport.qa_policy, ttsReport.unit_qa_policy_version) ?? "missing"}; required ${policy.qa_policy}`,
    };
  }

  const results = Array.isArray(ttsReport.results) ? ttsReport.results : [];
  const fallbackUnitIds = ttsReport.fallback_unit_ids
    ?? ttsReport.fallback_usage?.unit_ids
    ?? results.filter((row) => row.selected_provider === policy.fallback?.provider).map((row) => row.unit_id);
  if (fallbackUnitIds.length) {
    if (policy.fallback?.provider !== "qwen_local") {
      return { done: false, evidence: "narration used undeclared Qwen fallback units" };
    }
    const byUnitId = new Map(results.map((row) => [String(row.unit_id), row]));
    for (const unitId of fallbackUnitIds) {
      const row = byUnitId.get(String(unitId));
      const selectedProvider = row?.selected_provider ?? row?.provider;
      const qaStatus = row?.selected_qa?.status ?? row?.unit_qa?.status ?? row?.qa_status;
      const primaryTextHash = row?.primary_spoken_text_sha256 ?? row?.spoken_text_sha256;
      const fallbackTextHash = row?.fallback_spoken_text_sha256 ?? row?.selected_spoken_text_sha256 ?? row?.spoken_text_sha256;
      if (!row || selectedProvider !== "qwen_local" || !statusPassed(qaStatus) || !primaryTextHash || primaryTextHash !== fallbackTextHash) {
        return { done: false, evidence: `fallback unit ${unitId} lacks passing identical-text Qwen QA evidence` };
      }
    }
  }

  const expectedUnitCount = Number(ttsReport.expected_unit_count ?? ttsReport.unit_count);
  const selectedUnitCount = Number(ttsReport.selected_unit_count ?? results.length);
  if (!Number.isFinite(expectedUnitCount) || expectedUnitCount <= 0 || selectedUnitCount !== expectedUnitCount) {
    return { done: false, evidence: `narration selected unit coverage ${selectedUnitCount || 0}/${expectedUnitCount || "missing"}` };
  }
  const outputPath = stitchReport.output_path ?? stitchReport.final_audio_path ?? stitchReport.final_wav_path;
  const outputSha256 = stitchReport.output_sha256 ?? stitchReport.final_wav_sha256 ?? ttsReport.final_wav_sha256;
  if (!outputPath || !(await exists(outputPath))) {
    return { done: false, evidence: `stitched narration missing: ${outputPath ?? "missing_path"}` };
  }
  if (!outputSha256 || await streamSha256File(outputPath) !== outputSha256) {
    return { done: false, evidence: `stitched narration hash missing or stale: ${outputPath}` };
  }
  const finalM4aPath = stitchReport.final_m4a_path ?? ttsReport.final_m4a;
  const finalM4aSha256 = stitchReport.final_m4a_sha256 ?? ttsReport.final_m4a_sha256;
  if (!finalM4aPath || !finalM4aSha256 || !(await exists(finalM4aPath))
    || await streamSha256File(finalM4aPath) !== finalM4aSha256) {
    return { done: false, evidence: "final narration M4A missing or hash stale" };
  }
  const duration = Number(stitchReport.final_duration_sec ?? stitchReport.duration_sec);
  return {
    done: true,
    evidence: `audio_stitch_report_${episode}-narration.json -> ${outputPath}; provider=${policy.primary.provider}; voice=${policy.primary.voice_id}; fallback_units=${fallbackUnitIds.length}${Number.isFinite(duration) ? `; duration=${duration.toFixed(3)}s` : ""}`,
  };
}

async function qwenTtsStitchComplete(episodeDir, episode, currentScriptHash, identity) {
  if (!isLegacyQwenIdentity(identity)) {
    return narrationTtsStitchComplete(episodeDir, episode, currentScriptHash, identity);
  }
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const ttsReportPath = path.join(episodeDir, `modelslab_qwen_tts_report_${episode}.json`);
  const stitchReportPath = path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
  const ttsReport = await readJson(ttsReportPath, null);
  if (!ttsReport) return { done: false, evidence: `modelslab_qwen_tts_report_${episode}.json missing` };
  const ttsStatus = String(ttsReport.status ?? "").toLowerCase();
  if (!["passed", "completed"].includes(ttsStatus)) {
    return { done: false, evidence: `modelslab_qwen_tts_report_${episode}.json status=${ttsStatus || "missing_status"}` };
  }
  const ttsHash = ttsReport.source_script_hash ?? ttsReport.script_hash ?? null;
  if (ttsHash && ttsHash !== currentScriptHash) {
    return { done: false, evidence: `modelslab_qwen_tts_report_${episode}.json hash ${ttsHash}; required hash ${currentScriptHash}` };
  }
  const stitchReport = await readJson(stitchReportPath, null);
  if (!stitchReport) return { done: false, evidence: `audio_stitch_report_${episode}-modelslab-qwen.json missing` };
  const stitchStatus = String(stitchReport.status ?? "").toLowerCase();
  if (!["passed", "completed"].includes(stitchStatus)) {
    return { done: false, evidence: `audio_stitch_report_${episode}-modelslab-qwen.json status=${stitchStatus || "missing_status"}` };
  }
  const stitchHash = stitchReport.source_script_hash ?? stitchReport.script_hash ?? null;
  if (stitchHash && stitchHash !== currentScriptHash) {
    return { done: false, evidence: `audio_stitch_report_${episode}-modelslab-qwen.json hash ${stitchHash}; required hash ${currentScriptHash}` };
  }
  if (isNarratorOnlyAudio(identity)) {
    const requiredVoiceId = selectedNarratorVoiceId(identity);
    const voiceIds = voiceIdsFromTtsArtifacts(ttsReport, stitchReport);
    const staleVoiceIds = [...voiceIds].filter((voiceId) => voiceId !== requiredVoiceId);
    if (staleVoiceIds.length > 0) {
      return {
        done: false,
        evidence: `stitched Qwen narration voice_id=${staleVoiceIds.join(", ")}; required narrator voice ${requiredVoiceId}`,
      };
    }
  }
  const requiredNativeSpeed = lockedTtsNativeSpeed(identity);
  if (requiredNativeSpeed !== null) {
    const reportedNativeSpeed = Number(ttsReport?.native_speed ?? stitchReport?.native_speed);
    if (!Number.isFinite(reportedNativeSpeed) || Math.abs(reportedNativeSpeed - requiredNativeSpeed) > 0.001) {
      return {
        done: false,
        evidence: `stitched Qwen narration native_speed=${Number.isFinite(reportedNativeSpeed) ? reportedNativeSpeed : "missing"}; required ${requiredNativeSpeed}`,
      };
    }
    if (ttsReport?.post_tempo_normalized === true || stitchReport?.tempo_normalized === true || stitchReport?.post_tempo_normalized === true) {
      return { done: false, evidence: "stitched narration uses post tempo normalization; new runs require provider-native Qwen speed" };
    }
  }
  const outputPath = stitchReport.output_path ?? stitchReport.final_audio_path ?? stitchReport.final_wav_path ?? null;
  if (!outputPath) return { done: false, evidence: `audio_stitch_report_${episode}-modelslab-qwen.json missing output_path` };
  if (!(await exists(outputPath))) return { done: false, evidence: `stitched narration missing: ${outputPath}` };
  const outputSha256 = stitchReport.output_sha256
    ?? stitchReport.final_wav_sha256
    ?? ttsReport.final_wav_sha256
    ?? null;
  const hashRequired = Boolean(
    stitchReport.unit_qa_policy_version
    || ttsReport.unit_qa_policy_version
    || stitchReport.stitch_policy?.padding_aware,
  );
  if (hashRequired && !outputSha256) {
    return { done: false, evidence: `stitched narration hash missing for current Qwen QA/stitch schema: ${outputPath}` };
  }
  if (outputSha256) {
    const actualOutputSha256 = await streamSha256File(outputPath);
    if (actualOutputSha256 !== outputSha256) {
      return {
        done: false,
        evidence: `stitched narration hash ${actualOutputSha256}; report requires ${outputSha256}: ${outputPath}`,
      };
    }
  }
  const stitchOwnsFinalM4aPath = Object.hasOwn(stitchReport, "final_m4a_path");
  const stitchOwnsFinalM4aSha256 = Object.hasOwn(stitchReport, "final_m4a_sha256");
  const finalM4aPath = stitchOwnsFinalM4aPath
    ? stitchReport.final_m4a_path
    : ttsReport.final_m4a ?? null;
  const finalM4aSha256 = stitchOwnsFinalM4aSha256
    ? stitchReport.final_m4a_sha256
    : ttsReport.final_m4a_sha256 ?? null;
  if (hashRequired && finalM4aPath && !finalM4aSha256) {
    return { done: false, evidence: `stitched narration M4A hash missing: ${finalM4aPath}` };
  }
  if (finalM4aSha256) {
    if (!(await exists(finalM4aPath))) {
      return { done: false, evidence: `stitched narration M4A missing: ${finalM4aPath ?? "missing_path"}` };
    }
    const actualM4aSha256 = await streamSha256File(finalM4aPath);
    if (actualM4aSha256 !== finalM4aSha256) {
      return {
        done: false,
        evidence: `stitched narration M4A hash ${actualM4aSha256}; report requires ${finalM4aSha256}: ${finalM4aPath}`,
      };
    }
  }
  const duration = Number(stitchReport.final_duration_sec ?? stitchReport.duration_sec);
  return {
    done: true,
    evidence: `audio_stitch_report_${episode}-modelslab-qwen.json -> ${outputPath}${Number.isFinite(duration) ? `; duration=${duration.toFixed(3)}s` : ""}`,
  };
}

async function narrationVoicePlanComplete(episodeDir, currentScriptHash, identity) {
  const label = "narration_generation_plan.json";
  const planPath = path.join(episodeDir, label);
  const actionableDirection = await readJson(
    path.join(episodeDir, "narration_actionable_direction.json"),
    null,
  );
  const failedPerformancePackets = Array.isArray(actionableDirection?.repair_scope?.failed_packet_ids)
    ? [...new Set(actionableDirection.repair_scope.failed_packet_ids.map(String).filter(Boolean))]
    : [];
  if (actionableDirection?.status === "blocked" && failedPerformancePackets.length) {
    return {
      done: false,
      state: "blocked",
      evidence: `narration_actionable_direction.json blocked on exact performance packets: ${failedPerformancePackets.join(", ")}`,
      next_command_shape: `${commandFor("voice_plan", identity)} --performance-packet-ids ${failedPerformancePackets.join(",")} --performance-repair-reason "<reviewed packet evidence>"`,
    };
  }
  const base = await jsonArtifactHashComplete(planPath, currentScriptHash, label);
  if (!base.done) return base;
  const plan = await readJson(planPath, null);
  const proofImport = await proofBaselineImportArtifactComplete({
    episodeDir,
    episode: identity.episode,
    currentScriptHash,
    identity,
    artifact: plan,
    artifactPath: planPath,
    label,
  });
  if (proofImport.applicable) return { done: proofImport.done, evidence: proofImport.evidence };
  const runIdentityBindingFinding = narrationPlanRunIdentityBindingFinding(
    plan,
    identity,
    await fileSha256(path.join(episodeDir, "run_identity.json")),
  );
  if (runIdentityBindingFinding) {
    return {
      done: false,
      state: "stale",
      evidence: `${label} ${runIdentityBindingFinding.message} `
        + `Recorded ${runIdentityBindingFinding.actual ?? "missing"}; `
        + `current ${runIdentityBindingFinding.expected ?? "missing"}.`,
    };
  }
  if (plan?.schema === "goldflow_tts_generation_plan_v2") {
    const planSourceHashes = plan?.source_hashes ?? {};
    const sourceBindings = [
      ["script_clean_sha256", path.join(episodeDir, "script_clean.md")],
      [
        "script_speakability_report_sha256",
        path.join(episodeDir, "script_speakability_report.json"),
      ],
      [
        "tts_spoken_overrides_sha256",
        path.join(episodeDir, "tts_spoken_overrides.json"),
      ],
    ];
    for (const [field, sourcePath] of sourceBindings) {
      const expectedHash = String(planSourceHashes[field] ?? "").trim();
      const actualHash = await fileSha256(sourcePath);
      if (!expectedHash || expectedHash !== actualHash) {
        return {
          done: false,
          state: "stale",
          evidence: `${label} source_hashes.${field} is missing or stale; `
            + `recorded ${expectedHash || "missing"}; current ${actualHash ?? "missing"}.`,
        };
      }
    }
  }
  let policy;
  try {
    policy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), {
      production: String(identity.run_intent ?? "production").toLowerCase() === "production",
    });
  } catch (error) {
    return {
      done: false,
      evidence: `${label} run identity TTS policy invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const narrationQualityContract = narrationQualityContractForIdentity(identity);
  const planProvider = plan?.primary_provider ?? plan?.provider ?? plan?.tts_provider;
  const planFallback = plan?.fallback_provider ?? plan?.provider_policy?.fallback_provider ?? null;
  const primaryControls = plan?.provider_controls?.primary
    ?? (policy.primary.provider === "qwen_local"
    ? plan?.provider_controls?.qwen3 ?? plan?.provider_controls?.qwen_local ?? {}
    : plan?.provider_controls?.kokoro ?? plan?.provider_controls?.kokoro_local ?? {});
  const planVoiceId = plan?.narrator_voice_id
    ?? primaryControls.voice_id
    ?? primaryControls.voice
    ?? primaryControls.reference_voice_id
    ?? primaryControls.target_voice_id
    ?? null;
  const rawPlanSpeed = plan?.tts_native_speed
    ?? primaryControls.native_speed
    ?? primaryControls.speed
    ?? null;
  const planSpeed = rawPlanSpeed == null ? null : Number(rawPlanSpeed);
  const speedMismatch = policy.primary.provider === "qwen_local"
    ? rawPlanSpeed != null || primaryControls.speed_control_supported !== false
    : policy.primary.native_speed == null
      ? rawPlanSpeed != null
      : !Number.isFinite(planSpeed)
        || Math.abs(planSpeed - Number(policy.primary.native_speed)) > 0.001;
  if (planProvider !== policy.primary.provider
    || (planFallback ?? null) !== (policy.fallback?.provider ?? null)
    || planVoiceId !== policy.primary.voice_id
    || speedMismatch) {
    return {
      done: false,
      evidence: `${label} provider lock mismatch: primary=${planProvider ?? "missing"}, fallback=${planFallback ?? "none"}, voice=${planVoiceId ?? "missing"}, speed=${rawPlanSpeed == null ? "unsupported" : Number.isFinite(planSpeed) ? planSpeed : "invalid"}`,
    };
  }
  const units = Array.isArray(plan?.units) && plan.units.length
    ? plan.units
    : (plan?.segments ?? []).flatMap((segment) => (
        segment?.narration_units
        ?? segment?.narration_generation_units
        ?? segment?.tts_generation_units
        ?? segment?.qwen_generation_units
        ?? []
      ));
  if (!units.length) return { done: false, evidence: `${label} contains no narration units` };
  if (narrationQualityContract?.unitization?.semantic_boundary_class_required === true) {
    const grouping = plan?.provider_neutral_unit_grouping ?? {};
    const expectedUnitContract = narrationUnitContractForQuality(
      narrationQualityContract,
    );
    const allowedBoundaryClasses = new Set([
      "continuation",
      "clause",
      "sentence",
      "emphasized_sentence",
      "paragraph",
      "reveal",
      "episode_end",
    ]);
    const groupingValid = grouping.enabled === true
      && grouping.sentence_complete === true
      && Number(grouping.target_spoken_words_min)
        === Number(expectedUnitContract.target_words_min)
      && Number(grouping.target_spoken_words_max)
        === Number(expectedUnitContract.target_words_max)
      && Number(grouping.soft_spoken_words_max)
        === Number(expectedUnitContract.soft_words_max)
      && Number(grouping.hard_spoken_words_max)
        === Number(expectedUnitContract.hard_words_max)
      && grouping.semantic_boundary_class_required === true
      && grouping.performance_intent_required === true
      && grouping.continuous_requests_allowed === false;
    const invalidDirectedUnit = units.find((unit, index) => {
      const text = String(unit?.spoken_text ?? unit?.tts_spoken_text ?? "").trim();
      const sourceSegmentIds = [...new Set([
        ...(unit?.source_segment_ids ?? []),
        ...(unit?.source_unit_refs ?? []).map((row) => row?.segment_id),
      ].filter(Boolean).map(String))];
      const boundary = String(unit?.boundary_after ?? "");
      const performance = unit?.performance_intent;
      return text.split(/\s+/u).filter(Boolean).length
          > Number(expectedUnitContract.hard_words_max)
        || !hasTtsTerminalPunctuation(text)
        || sourceSegmentIds.length > 1
        || !allowedBoundaryClasses.has(boundary)
        || (index === units.length - 1 && boundary !== "episode_end")
        || (index < units.length - 1 && boundary === "episode_end")
        || !performance
        || !String(performance.energy ?? "").trim()
        || !String(performance.pace ?? "").trim()
        || !String(performance.pause_strategy ?? "").trim();
    });
    if (!groupingValid || invalidDirectedUnit) {
      return {
        done: false,
        evidence: `${label} provider-neutral unit/direction contract mismatch${invalidDirectedUnit ? ` at ${invalidDirectedUnit.unit_id ?? "unknown"}` : ""}`,
      };
    }
  }
  if (policy.primary.provider === "qwen_local") {
    const qwenGrouping = plan?.qwen_liam_unit_grouping ?? {};
    const expectedUnitContract = narrationUnitContractForQuality(
      narrationQualityContract,
    );
    const nullableNumberMatches = (actual, expected) => (
      expected == null ? actual == null : Number(actual) === Number(expected)
    );
    const groupingMismatches = [
      qwenGrouping.enabled !== true ? "enabled" : null,
      qwenGrouping.sentence_complete !== expectedUnitContract.sentence_complete ? "sentence_complete" : null,
      !nullableNumberMatches(qwenGrouping.target_spoken_words_min, expectedUnitContract.target_words_min) ? "target_spoken_words_min" : null,
      !nullableNumberMatches(qwenGrouping.target_spoken_words_max, expectedUnitContract.target_words_max) ? "target_spoken_words_max" : null,
      narrationQualityContract
        && !nullableNumberMatches(qwenGrouping.soft_spoken_words_max, expectedUnitContract.soft_words_max)
        ? "soft_spoken_words_max"
        : null,
      Number(qwenGrouping.hard_spoken_words_max) !== expectedUnitContract.hard_words_max ? "hard_spoken_words_max" : null,
      qwenGrouping.continuous_requests_allowed !== expectedUnitContract.continuous_requests ? "continuous_requests_allowed" : null,
      plan?.sentence_unit_boundary_integrity?.status !== "passed" ? "sentence_unit_boundary_integrity.status" : null,
    ].filter(Boolean);
    const invalidUnit = units.find((unit) => {
      const text = String(unit?.spoken_text ?? unit?.tts_spoken_text ?? "").trim();
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const sourceSegmentIds = [...new Set([
        ...(Array.isArray(unit?.source_segment_ids) ? unit.source_segment_ids : []),
        ...(Array.isArray(unit?.source_unit_refs)
          ? unit.source_unit_refs.map((ref) => ref?.segment_id)
          : []),
      ].map((value) => String(value ?? "").trim()).filter(Boolean))];
      return wordCount > expectedUnitContract.hard_words_max
        || !hasTtsTerminalPunctuation(text)
        || sourceSegmentIds.length > 1;
    });
    if (groupingMismatches.length || invalidUnit) {
      return {
        done: false,
        evidence: `${label} Qwen Liam unit contract mismatch${groupingMismatches.length ? `: ${groupingMismatches.join(", ")}` : ""}${invalidUnit ? `; invalid unit=${invalidUnit.unit_id ?? "unknown"} (must stay inside one voice segment, end at a sentence, and stay at or below 60 words)` : ""}`,
      };
    }
    if (policy.synthesis_contract?.mode
      === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode) {
      const batchValidation = validateQwenLiamBatchPlan(
        plan?.qwen_liam_batch_plan,
        units,
        policy.synthesis_contract,
      );
      if (batchValidation.status !== "passed") {
        return {
          done: false,
          evidence: `${label} deterministic batch-four plan mismatch: ${batchValidation.findings
            .map((finding) => finding.code)
            .join(", ")}`,
        };
      }
      const expectedBindings = qwenBatchBindingByUnit(
        batchValidation.expected,
      );
      const invalidBindingUnit = units.find((unit) => (
        JSON.stringify(unit?.synthesis_cohort ?? null)
        !== JSON.stringify(expectedBindings.get(String(unit?.unit_id)) ?? null)
      ));
      if (invalidBindingUnit) {
        return {
          done: false,
          evidence: `${label} unit ${invalidBindingUnit.unit_id ?? "unknown"} has a stale deterministic batch-four cohort binding`,
        };
      }
    }
  }
  const voiceIdentityFindings = narrationPlanVoiceIdentityFindings(plan, policy);
  if (voiceIdentityFindings.length) {
    return {
      done: false,
      evidence: `${label} narration identity mismatch: ${voiceIdentityFindings
        .slice(0, 8)
        .map((finding) => `${finding.path}=${finding.actual ?? "missing"} (required ${finding.expected})`)
        .join("; ")}`,
    };
  }
  const missingNeutralFields = units.filter((unit) => (
    !cleanOptionalId(unit.unit_id)
    || !String(unit.spoken_text ?? unit.tts_spoken_text ?? "").trim()
    || !String(unit.caption_text ?? "").trim()
  ));
  if (missingNeutralFields.length) {
    return { done: false, evidence: `${label} has ${missingNeutralFields.length} unit(s) missing stable id/spoken/caption fields` };
  }
  const duplicateIds = units
    .map((unit) => String(unit.unit_id))
    .filter((unitId, index, rows) => rows.indexOf(unitId) !== index);
  if (duplicateIds.length) {
    return { done: false, evidence: `${label} duplicate unit ids: ${[...new Set(duplicateIds)].slice(0, 8).join(", ")}` };
  }
  if (narrationQualityContract) {
    if (plan?.narration_quality_contract?.contract_sha256
      !== narrationQualityContract.contract_sha256) {
      return {
        done: false,
        evidence: `${label} narration quality contract is missing or stale`,
      };
    }
    const invalidProviderRequestUnit = units.find((unit) => {
      const compiled = unit?.provider_request;
      return compiled?.status !== "compiled"
        || compiled?.adapter?.provider !== policy.primary.provider
        || String(compiled?.request?.unit_id ?? "") !== String(unit?.unit_id ?? "")
        || String(compiled?.request?.text ?? "")
          !== String(unit?.spoken_text ?? unit?.tts_spoken_text ?? "");
    });
    if (invalidProviderRequestUnit) {
      return {
        done: false,
        evidence: `${label} provider-neutral request is missing or stale for unit ${invalidProviderRequestUnit.unit_id ?? "unknown"}`,
      };
    }
    const textIrPath = path.join(episodeDir, "narration_text_ir.json");
    const textIr = await readJson(textIrPath, null);
    const textIrValidation = validateNarrationTextIr(textIr, units, {
      sourceScriptSha256: currentScriptHash,
      generationPlanSha256: plan.plan_sha256,
    });
    if (textIrValidation.status !== "passed") {
      return {
        done: false,
        evidence: `narration_text_ir.json missing or stale: ${textIrValidation.findings
          .slice(0, 8)
          .map((finding) => finding.code)
          .join(", ")}`,
      };
    }
  }
  if (plan?.text_integrity_coverage?.status !== "passed"
    || plan?.system_ui_speech_coverage?.status !== "passed") {
    return {
      done: false,
      evidence: `${label} exact coverage failed: text=${plan?.text_integrity_coverage?.status ?? "missing"}, system_ui=${plan?.system_ui_speech_coverage?.status ?? "missing"}`,
    };
  }
  const overrides = await readJson(path.join(episodeDir, "tts_spoken_overrides.json"), null);
  const overridesSha256 = await fileSha256(path.join(episodeDir, "tts_spoken_overrides.json"));
  if (identity.production_gates?.tts_spoken_text_audit_required === true) {
    const auditPath = plan?.tts_spoken_text_audit?.path
      ?? path.join(episodeDir, `tts_spoken_text_audit_${identity.episode}.json`);
    const spokenTextAudit = await readJson(auditPath, null);
    if (!ttsSpokenTextAuditMatches({
      audit: spokenTextAudit,
      plan,
      sourceScriptSha256: currentScriptHash,
      overridesSha256,
    })) {
      return {
        done: false,
        evidence: `${label} spoken-text audit is missing, blocked, or stale: ${auditPath}`,
      };
    }
    if (plan?.tts_spoken_text_audit?.audit_sha256 !== ttsSpokenTextAuditSha256(spokenTextAudit)
      || plan?.tts_spoken_text_audit?.unit_contract_sha256 !== spokenTextAudit.unit_contract_sha256) {
      return {
        done: false,
        evidence: `${label} spoken-text audit binding is stale: ${auditPath}`,
      };
    }
  }
  const loadedOverrideCount = Array.isArray(overrides?.replacements) ? overrides.replacements.length : 0;
  const audit = plan?.tts_override_application_audit ?? null;
  if (loadedOverrideCount > 0 && !audit) {
    return { done: false, evidence: `${label} missing TTS override audit for ${loadedOverrideCount} loaded rule(s)` };
  }
  return {
    done: true,
    evidence: `${label} -> ${currentScriptHash}; units=${units.length}; provider=${policy.primary.provider}; voice=${policy.primary.voice_id}; overrides=${audit?.applied_rule_count ?? 0}/${audit?.loaded_count ?? loadedOverrideCount}`,
  };
}

async function qwenVoicePlanComplete(episodeDir, currentScriptHash, identity) {
  if (!isLegacyQwenIdentity(identity)) {
    return narrationVoicePlanComplete(episodeDir, currentScriptHash, identity);
  }
  const label = "qwen_generation_plan.json";
  const base = await jsonArtifactHashComplete(path.join(episodeDir, label), currentScriptHash, label);
  if (!base.done) return base;
  const plan = await readJson(path.join(episodeDir, label), null);
  if (isNarratorOnlyAudio(identity)) {
    const requiredVoiceId = selectedNarratorVoiceId(identity);
    const narratorReferenceIds = narratorReferenceIdsFromPlan(plan);
    const staleReferenceIds = [...narratorReferenceIds].filter((voiceId) => voiceId !== requiredVoiceId);
    if (staleReferenceIds.length > 0) {
      return {
        done: false,
        evidence: `${label} narrator reference_id=${staleReferenceIds.join(", ")}; required narrator voice ${requiredVoiceId}`,
      };
    }
  }
  const overrides = await readJson(path.join(episodeDir, "tts_spoken_overrides.json"), null);
  const loadedOverrideCount = Array.isArray(overrides?.replacements) ? overrides.replacements.length : 0;
  const audit = plan?.tts_override_application_audit ?? null;
  if (loadedOverrideCount > 0 && !audit) {
    return {
      done: false,
      evidence: `${base.evidence}; missing tts_override_application_audit for ${loadedOverrideCount} loaded override(s)`,
    };
  }
  if (audit) {
    return {
      done: base.done,
      evidence: `${base.evidence}; tts_overrides applied=${audit.applied_rule_count ?? 0}/${audit.loaded_count ?? loadedOverrideCount}; unmatched=${audit.unmatched_rule_count ?? 0}`,
    };
  }
  return base;
}

async function jsonStatusComplete(filePath, label) {
  const artifact = await readJson(filePath, null);
  if (!artifact) return { done: false, evidence: `${label} missing` };
  const status = String(artifact.status ?? "").toLowerCase();
  const done = !["failed", "blocked", "blocked_deadletter", "failed_repairable", "needs_manual_agent_review"].includes(status);
  return { done, evidence: `${label}; status=${status || "missing_status"}` };
}

function statusAllowsDownstreamUse(status) {
  return !["failed", "blocked", "blocked_deadletter", "failed_repairable", "needs_manual_agent_review"].includes(String(status ?? "").toLowerCase());
}

async function sourceHashesCurrent(artifact) {
  const sourceHashes = artifact?.source_hashes && typeof artifact.source_hashes === "object" && !Array.isArray(artifact.source_hashes)
    ? artifact.source_hashes
    : null;
  if (!sourceHashes) return true;
  for (const [sourcePath, recordedHash] of Object.entries(sourceHashes)) {
    const currentHash = await fileSha256(sourcePath);
    if (!currentHash || currentHash !== recordedHash) return false;
  }
  return true;
}

function sortedJson(value) {
  if (Array.isArray(value)) return JSON.stringify([...value].sort());
  return JSON.stringify(value ?? null);
}

function characterStateRefsCompatible(dependentRefs, currentRefs) {
  const currentById = new Map((currentRefs ?? []).map((ref) => [ref.state_ref_id, ref]));
  for (const ref of dependentRefs ?? []) {
    const current = currentById.get(ref.state_ref_id);
    if (!current) return false;
    for (const key of ["character", "prompt_anchor", "scene_prompt_anchor", "source_ref_id", "base_identity_ref_id", "identity_usage"]) {
      if ((ref[key] ?? null) !== (current[key] ?? null)) return false;
    }
    if (sortedJson(ref.scene_ids) !== sortedJson(current.scene_ids)) return false;
  }
  return true;
}

function referencedIdsFromPromptPlan(artifact) {
  const ids = new Set();
  for (const prompt of artifact?.prompts ?? []) {
    for (const req of prompt.reference_requirements ?? []) {
      if (req?.ref_id) ids.add(req.ref_id);
    }
    const manifest = prompt.shot_manifest ?? {};
    if (manifest.location_ref_id) ids.add(manifest.location_ref_id);
    if (manifest.protagonist_state_ref_id) ids.add(manifest.protagonist_state_ref_id);
    for (const refId of manifest.character_state_ref_ids ?? []) {
      if (refId) ids.add(refId);
    }
  }
  return ids;
}

async function visualReferencePlanHashDriftIsVolatile(sourcePath, dependentArtifact) {
  if (path.basename(sourcePath) !== "visual_reference_plan.json") return false;
  const currentPlan = await readJson(sourcePath, null);
  if (!currentPlan || !statusAllowsDownstreamUse(currentPlan.status) || !(await sourceHashesCurrent(currentPlan))) return false;
  if (Array.isArray(dependentArtifact?.character_state_refs)) {
    return characterStateRefsCompatible(dependentArtifact.character_state_refs, currentPlan.character_state_refs ?? []);
  }
  if (Array.isArray(dependentArtifact?.prompts)) {
    const targetIds = new Set((currentPlan.reference_targets ?? []).map((target) => target.ref_id).filter(Boolean));
    for (const ref of currentPlan.character_state_refs ?? []) {
      if (ref.state_ref_id) targetIds.add(ref.state_ref_id);
      if (ref.source_ref_id) targetIds.add(ref.source_ref_id);
    }
    for (const refId of referencedIdsFromPromptPlan(dependentArtifact)) {
      if (!targetIds.has(refId)) return false;
    }
  }
  return true;
}

async function characterStateRefsHashDriftIsVolatile(sourcePath, dependentArtifact) {
  if (path.basename(sourcePath) !== "character_state_refs.json") return false;
  const currentRefs = await readJson(sourcePath, null);
  if (!currentRefs || !statusAllowsDownstreamUse(currentRefs.status)) return false;
  const sourceHashes = currentRefs.source_hashes && typeof currentRefs.source_hashes === "object" && !Array.isArray(currentRefs.source_hashes)
    ? currentRefs.source_hashes
    : null;
  if (sourceHashes) {
    for (const [currentSourcePath, recordedHash] of Object.entries(sourceHashes)) {
      const currentHash = await fileSha256(currentSourcePath);
      if (!currentHash) return false;
      if (currentHash !== recordedHash && !(await visualReferencePlanHashDriftIsVolatile(currentSourcePath, currentRefs))) return false;
    }
  }
  if (Array.isArray(dependentArtifact?.prompts)) {
    const currentIds = new Set();
    for (const ref of currentRefs.character_state_refs ?? []) {
      if (ref.state_ref_id) currentIds.add(ref.state_ref_id);
      if (ref.source_ref_id) currentIds.add(ref.source_ref_id);
      if (ref.base_identity_ref_id) currentIds.add(ref.base_identity_ref_id);
    }
    for (const sourcePath of Object.keys(sourceHashes ?? {})) {
      if (path.basename(sourcePath) !== "visual_reference_plan.json") continue;
      const visualPlan = await readJson(sourcePath, null);
      for (const target of visualPlan?.reference_targets ?? []) {
        if (target.ref_id) currentIds.add(target.ref_id);
      }
      for (const ref of visualPlan?.character_state_refs ?? []) {
        if (ref.state_ref_id) currentIds.add(ref.state_ref_id);
        if (ref.source_ref_id) currentIds.add(ref.source_ref_id);
        if (ref.base_identity_ref_id) currentIds.add(ref.base_identity_ref_id);
      }
    }
    for (const prompt of dependentArtifact.prompts ?? []) {
      const manifest = prompt.shot_manifest ?? {};
      const stateIds = [
        manifest.protagonist_state_ref_id,
        ...(manifest.character_state_ref_ids ?? []),
      ].filter(Boolean);
      for (const refId of stateIds) {
        if (!currentIds.has(refId)) return false;
      }
    }
  }
  return true;
}

async function jsonStatusWithSourceHashesComplete(filePath, label) {
  const artifact = await readJson(filePath, null);
  if (!artifact) return { done: false, evidence: `${label} missing` };
  const status = String(artifact.status ?? "").toLowerCase();
  if (!statusAllowsDownstreamUse(status)) {
    return { done: false, evidence: `${label}; status=${status || "missing_status"}` };
  }
  if (label === "visual_beat_plan.json") {
    const contractVersion = artifact.visual_beat_contract_version ?? artifact.planner_contract_version ?? null;
    if (![CURRENT_VISUAL_BEAT_CONTRACT_VERSION, LEGACY_VISUAL_BEAT_CONTRACT_VERSION].includes(contractVersion)) {
      return {
        done: false,
        evidence: `${label}; status=${status || "missing_status"}; stale planner_contract_version=${contractVersion ?? "missing"} required=${CURRENT_VISUAL_BEAT_CONTRACT_VERSION}`,
      };
    }
    const beats = Array.isArray(artifact.beats) ? artifact.beats : [];
    const missingRefNeeds = beats.filter((beat) => !Array.isArray(beat.ref_needs) && !Array.isArray(beat.beat_ref_requirements));
    if (beats.length && missingRefNeeds.length) {
      return {
        done: false,
        evidence: `${label}; status=${status || "missing_status"}; ${missingRefNeeds.length}/${beats.length} beats missing ref_needs contract`,
      };
    }
  }
  const sourceHashes = artifact.source_hashes && typeof artifact.source_hashes === "object" && !Array.isArray(artifact.source_hashes)
    ? artifact.source_hashes
    : null;
  if (!sourceHashes) return { done: true, evidence: `${label}; status=${status || "missing_status"}; source_hashes=missing` };
  const stale = [];
  const ignored = [];
  for (const [sourcePath, recordedHash] of Object.entries(sourceHashes)) {
    const currentHash = await fileSha256(sourcePath);
    if (!currentHash) {
      stale.push(`${path.basename(sourcePath)} missing`);
    } else if (currentHash !== recordedHash) {
      if (await visualReferencePlanHashDriftIsVolatile(sourcePath, artifact)) {
        ignored.push(`${path.basename(sourcePath)} reference_paths_updated`);
      } else if (await characterStateRefsHashDriftIsVolatile(sourcePath, artifact)) {
        ignored.push(`${path.basename(sourcePath)} reference_paths_updated`);
      } else {
        stale.push(`${path.basename(sourcePath)} stale`);
      }
    }
  }
  if (stale.length) {
    return { done: false, evidence: `${label}; status=${status || "missing_status"}; ${stale.slice(0, 4).join(", ")}` };
  }
  return {
    done: true,
    evidence: `${label}; status=${status || "missing_status"}; source_hashes=current${ignored.length ? `; ignored=${ignored.slice(0, 4).join(", ")}` : ""}`,
  };
}

async function visualReferencePlanComplete(episodeDir, currentScriptHash, identity) {
  const visualPlanPath = path.join(episodeDir, "visual_reference_plan.json");
  const inventoryLedgerPath = path.join(episodeDir, "reference_inventory_ledger.json");
  const characterRefsPath = path.join(episodeDir, "character_state_refs.json");
  const partialPath = path.join(episodeDir, `visual_reference_partial_${identity.episode ?? "ep_01"}.json`);
  const partial = await readJson(partialPath, null);
  if (["needs_chunk_repair", "needs_global_repair", "needs_explicit_repair"].includes(String(partial?.status ?? ""))) {
    if (!currentScriptHash || partial.source_script_hash !== currentScriptHash) {
      return { done: false, state: "stale", evidence: `${path.basename(partialPath)} source script hash is missing or stale` };
    }
    const failedChunks = Array.isArray(partial.failed_chunks) ? partial.failed_chunks : [];
    const failedChunkIds = [...new Set(failedChunks.map((row) => String(row?.chunk_id ?? "")).filter(Boolean))];
    const failedSceneIds = [...new Set(failedChunks.flatMap((row) => row?.scene_ids ?? []).map(String).filter(Boolean))];
    const base = commandFor("visual_reference_plan", identity);
    const nextCommand = failedChunkIds.length
      ? `${base} --repair-chunk-ids ${failedChunkIds.join(",")}`
      : failedSceneIds.length
        ? `${base} --repair-scene-ids ${failedSceneIds.join(",")}`
        : String(partial.status) === "needs_global_repair" || partial.global_director?.status === "failed"
          ? `${base} --repair-global true`
          : "Manual structured reference repair required: inspect the preserved visual_reference_partial artifact; do not rerun passed chunks.";
    return {
      done: false,
      state: "blocked",
      evidence: `${path.basename(partialPath)} status=${partial.status}; passed_chunks=${partial.passed_chunk_count ?? partial.passed_chunks?.length ?? 0}; failed_chunks=${failedChunks.length}; passed candidates preserved`,
      next_command_shape: nextCommand,
      recovery_scope: {
        source_script_hash: currentScriptHash,
        source_hash_current: true,
        partial_sha256: await fileSha256(partialPath),
      },
    };
  }
  const authoringArtifacts = [
    visualPlanPath,
    inventoryLedgerPath,
    characterRefsPath,
    partialPath,
    path.join(episodeDir, "reference_evidence_ledger.json"),
    path.join(episodeDir, "location_contract_ledger.json"),
  ];
  if (!(await Promise.all(authoringArtifacts.map(exists))).some(Boolean)) {
    return { done: false, state: "missing", evidence: "visual reference authoring artifacts not created" };
  }
  const visual = await jsonStatusWithSourceHashesComplete(visualPlanPath, "visual_reference_plan.json");
  const visualPlan = await readJson(visualPlanPath, null);
  const inventoryPath = visualPlan?.reference_inventory_ledger_path ?? inventoryLedgerPath;
  const inventoryLedger = await readJson(inventoryPath, null);
  if (!inventoryLedger || inventoryLedger.status !== "passed" || !Array.isArray(inventoryLedger.assets)) {
    return {
      done: false,
      evidence: `${visual.evidence}; reference_inventory_ledger.json missing or invalid`,
    };
  }
  let directorLedgerEvidence = "";
  if (["reference_director_v2", "reference_director_v3_full_selection"].includes(visualPlan?.reference_director_contract_version)) {
    const evidenceLedgerPath = visualPlan.reference_evidence_ledger_path ?? path.join(episodeDir, "reference_evidence_ledger.json");
    const locationContractLedgerPath = visualPlan.location_contract_ledger_path ?? path.join(episodeDir, "location_contract_ledger.json");
    const [evidenceLedger, locationContractLedger] = await Promise.all([
      readJson(evidenceLedgerPath, null),
      readJson(locationContractLedgerPath, null),
    ]);
    if (evidenceLedger?.status !== "passed" || !Array.isArray(evidenceLedger?.assets)) {
      return {
        done: false,
        evidence: `${visual.evidence}; reference_evidence_ledger.json missing or invalid for the reference-director contract`,
      };
    }
    if (locationContractLedger?.status !== "passed" || !Array.isArray(locationContractLedger?.contracts)) {
      return {
        done: false,
        evidence: `${visual.evidence}; location_contract_ledger.json missing or invalid for the reference-director contract`,
      };
    }
    directorLedgerEvidence = `; evidence_assets=${evidenceLedger.assets.length}; location_contracts=${locationContractLedger.contracts.length}`;
  }
  const characterRefs = await readJson(characterRefsPath, null);
  if (!characterRefs) {
    return { done: false, evidence: `${visual.evidence}; character_state_refs.json missing` };
  }
  const characterStatus = String(characterRefs.status ?? "").toLowerCase();
  const statusOk = ["approved", "passed", "draft_needs_manual_review"].includes(characterStatus);
  const characterHash = characterRefs.source_script_hash ?? characterRefs.script_hash ?? characterRefs.script_clean_hash ?? null;
  if (!statusOk || characterHash !== currentScriptHash) {
    return {
      done: false,
      evidence: `${visual.evidence}; character_state_refs.json ${characterStatus || "missing_status"} for hash ${characterHash ?? "none"}; required hash ${currentScriptHash}`,
    };
  }
  const charSourceHashes = characterRefs.source_hashes && typeof characterRefs.source_hashes === "object" && !Array.isArray(characterRefs.source_hashes)
    ? characterRefs.source_hashes
    : null;
  if (charSourceHashes) {
    const stale = [];
    const ignored = [];
    for (const [sourcePath, recordedHash] of Object.entries(charSourceHashes)) {
      const currentHash = await fileSha256(sourcePath);
      if (!currentHash) stale.push(`${path.basename(sourcePath)} missing`);
      else if (currentHash !== recordedHash) {
        if (await visualReferencePlanHashDriftIsVolatile(sourcePath, characterRefs)) {
          ignored.push(`${path.basename(sourcePath)} reference_paths_updated`);
        } else {
          stale.push(`${path.basename(sourcePath)} stale`);
        }
      }
    }
    if (stale.length) {
      return { done: false, evidence: `${visual.evidence}; character_state_refs.json ${stale.slice(0, 4).join(", ")}` };
    }
    if (ignored.length) {
      return {
        done: visual.done,
        evidence: `${visual.evidence}; character_state_refs.json status=${characterStatus}; source_hashes=current; ignored=${ignored.slice(0, 4).join(", ")}`,
      };
    }
  }
  return {
    done: visual.done,
    evidence: `${visual.evidence}; reference_inventory_ledger.json selected_assets=${inventoryLedger.assets.length}${directorLedgerEvidence}; character_state_refs.json status=${characterStatus}${charSourceHashes ? "; source_hashes=current" : ""}`,
  };
}

function ttsStatusIdentityFields(runIdentity = {}, statusFlags = {}) {
  const lockedV2 = runIdentity.schema === "goldflow_run_identity_v2";
  const choose = (overrideValue, lockedValue) => (
    lockedV2 ? lockedValue : overrideValue ?? lockedValue
  );
  return {
    voice_provider_options: runIdentity.voice_provider_options ?? {},
    tts_provider: choose(
      statusFlags["tts-provider"],
      runIdentity.tts_provider ?? runIdentity.voice_provider_options?.primary?.provider ?? null,
    ),
    tts_fallback_provider: choose(
      statusFlags["tts-fallback-provider"],
      runIdentity.tts_fallback_provider
        ?? runIdentity.voice_provider_options?.fallback?.provider
        ?? null,
    ),
    narrator_voice_id: choose(
      statusFlags["narrator-voice-id"] ?? statusFlags["tts-voice-id"],
      runIdentity.narrator_voice_id
        ?? runIdentity.tts_voice_id
        ?? runIdentity.voice_provider_options?.primary?.voice_id
        ?? null,
    ),
    tts_voice_id: choose(
      statusFlags["tts-voice-id"] ?? statusFlags["narrator-voice-id"],
      runIdentity.tts_voice_id
        ?? runIdentity.narrator_voice_id
        ?? runIdentity.voice_provider_options?.primary?.voice_id
        ?? null,
    ),
    tts_native_speed: choose(
      statusFlags["tts-native-speed"],
      runIdentity.tts_native_speed
        ?? runIdentity.voice_provider_options?.primary?.native_speed
        ?? null,
    ),
    tts_qa_policy: runIdentity.tts_qa_policy
      ?? runIdentity.voice_provider_options?.qa_policy
      ?? null,
    qwen_narrator_voice_id: choose(
      statusFlags["qwen-narrator-voice-id"] ?? statusFlags["narrator-voice-id"],
      runIdentity.voice_provider_options?.qwen_narrator_voice_id
        ?? runIdentity.qwen_narrator_voice_id
        ?? DEFAULT_QWEN_NARRATOR_VOICE_ID,
    ),
    qwen_native_speed: choose(
      statusFlags["qwen-native-speed"] ?? statusFlags["native-speed"],
      runIdentity.voice_provider_options?.qwen_native_speed
        ?? runIdentity.qwen_native_speed
        ?? null,
    ),
  };
}

async function main() {
  const episodeDir = flags["episode-dir"]
    ? path.resolve(flags["episode-dir"])
    : (() => {
        requiredFlag("channel", flags.channel);
        requiredFlag("week", flags.week);
        requiredFlag("episode", flags.episode);
        return path.join(dataRoot, "channels", flags.channel, "weekly_runs", flags.week, "episodes", flags.episode);
      })();
  const runIdentityPath = path.join(episodeDir, "run_identity.json");
  const persistedRunIdentity = readEpisodeRoutingIdentity(episodeDir);
  const runIdentity = persistedRunIdentity ?? {};
  // Flags on an uninitialized directory are prospective choices, not an override
  // of a nonexistent manhwa lock. Validate them but do not materialize identity.
  if (!persistedRunIdentity) {
    assertCommandWorkflowRoute({ command: "run", subcommand: "status", script: "run-status.mjs", flags, episodeDir });
  }
  const mediaWorkflow = assertEpisodeWorkflowFlags(runIdentity, persistedRunIdentity ? flags : {});
  if (mediaWorkflow.id === "true_crime_hybrid_proof_v1") {
    const { trueCrimeProofStatus, formatTrueCrimeProofStatus } = await import("./lib/true-crime-proof-workflow.mjs");
    const report = await trueCrimeProofStatus({ proofDir: episodeDir });
    console.log(flags.format === "markdown" ? formatTrueCrimeProofStatus(report) : JSON.stringify(report, null, 2));
    return;
  }
  if (mediaWorkflow.id === "avatar_footage_pilot_v1") {
    const { pilotStatus, formatPilotStatus } = await import("./lib/avatar-pilot-workflow.mjs");
    const report = await pilotStatus(episodeDir);
    console.log(flags.format === "markdown" ? formatPilotStatus(report) : JSON.stringify(report, null, 2));
    return;
  }
  const stageRegistry = stageRegistryFor(runIdentity);
  const productionManifest = await readJson(path.join(episodeDir, "production_manifest.json"), null);
  const ttsIdentityFields = ttsStatusIdentityFields(runIdentity, flags);
  const identity = {
    schema: runIdentity.schema ?? "missing",
    channel: flags.channel ?? runIdentity.channel,
    series_slug: flags.series ?? flags.seriesSlug ?? runIdentity.series_slug,
    week: flags.week ?? runIdentity.week,
    episode: flags.episode ?? runIdentity.episode ?? path.basename(episodeDir),
    planning_provider: runIdentity.planning_provider ?? runIdentity.provider_locks?.planning_provider ?? null,
    planning_effort_policy: runIdentity.planning_effort_policy ?? runIdentity.provider_locks?.planning_effort_policy ?? null,
    audio_target: flags["audio-target"] ?? runIdentity.audio_target ?? "narrator_only",
    image_provider: flags["image-provider"] ?? flags.provider ?? runIdentity.image_provider ?? "chatgpt_web_gpt_image",
    image_provider_options: runIdentity.image_provider_options ?? {},
    ...ttsIdentityFields,
    image_output_qa_required: runIdentity.image_output_qa_required ?? runIdentity.production_gates?.image_output_qa_required_before_render ?? false,
    production_gates: runIdentity.production_gates ?? {},
    pace_policy: "diagnostic",
    target_wpm_min: flags["target-wpm-min"] ?? flags["wpm-min"] ?? runIdentity.target_wpm_min ?? runIdentity.pace_targets?.target_wpm_min ?? runIdentity.pace_targets?.min ?? DEFAULT_TARGET_WPM_MIN,
    target_wpm_max: flags["target-wpm-max"] ?? flags["wpm-max"] ?? runIdentity.target_wpm_max ?? runIdentity.pace_targets?.target_wpm_max ?? runIdentity.pace_targets?.max ?? DEFAULT_TARGET_WPM_MAX,
    target_wpm_midpoint: flags["target-wpm-mid"] ?? flags["wpm-mid"] ?? runIdentity.target_wpm_midpoint ?? runIdentity.pace_targets?.target_wpm_midpoint ?? runIdentity.pace_targets?.mid ?? DEFAULT_TARGET_WPM_MID,
    pace_targets: runIdentity.pace_targets ?? null,
    render_profile: flags["render-profile"] ?? runIdentity.render_profile ?? "smooth_subpixel_ken_burns",
    motion_policy: runIdentity.motion_policy ?? null,
    animation_policy: runIdentity.animation_policy ?? runIdentity.ltx_video_policy ?? "disabled",
    ltx_video_policy: runIdentity.ltx_video_policy ?? runIdentity.animation_policy ?? "disabled",
    parallax_policy: runIdentity.parallax_policy ?? null,
    parallax_target_max: runIdentity.parallax_target_max ?? null,
    parallax_min_spacing_sec: runIdentity.parallax_min_spacing_sec ?? null,
    run_intent: runIdentity.run_intent ?? "production",
    proof_scope: runIdentity.proof_scope ?? { mode: "full_episode", start_sec: 0, end_sec: null },
    ...contentStatusIdentityFields(runIdentity),
    git: runIdentity.git ?? null,
    provider_locks: runIdentity.provider_locks ?? null,
    model_versions: runIdentity.model_versions ?? null,
    production_profile: runIdentity.production_profile ?? runIdentity.provider_locks?.production_profile ?? null,
    production_profile_config: runIdentity.production_profile_config ?? null,
    run_identity_schema: runIdentity.schema ?? "missing",
    stage_registry_version: runIdentity.stage_registry_version ?? runIdentity.workflow_contract?.stage_registry_version ?? null,
  };
  const effectiveImageRoute = await effectiveImageIdentityForEpisode(episodeDir, runIdentityPath, identity);
  Object.assign(identity, effectiveImageRoute.identity);
  const legacyIdentity = runIdentity.schema !== "goldflow_run_identity_v2";
  const episode = identity.episode;
  const scriptHash = await fileSha256(path.join(episodeDir, "script_clean.md"));
  const scriptApproval = await scriptApprovalComplete(episodeDir, scriptHash);
  const scriptPace = await paceReportComplete(path.join(episodeDir, "script_pace_report.json"), scriptHash, "script_pace_report.json", identity);
  const speakability = await jsonArtifactHashComplete(path.join(episodeDir, "script_speakability_report.json"), scriptHash, "script_speakability_report.json");
  const ttsOverrides = await jsonArtifactHashComplete(path.join(episodeDir, "tts_spoken_overrides.json"), scriptHash, "tts_spoken_overrides.json");
  const qwenVoicePlan = await qwenVoicePlanComplete(episodeDir, scriptHash, identity);
  const qwenTtsStitch = await qwenTtsStitchComplete(episodeDir, episode, scriptHash, identity);
  const whisperTiming = await whisperTimingComplete(episodeDir, episode, scriptHash, identity);
  const audioPace = await paceReportComplete(path.join(episodeDir, `narration_pace_report_${episode}.json`), scriptHash, `narration_pace_report_${episode}.json`, identity);
  const audioPaceNextCommand = await audioPaceRecoveryCommand(episodeDir, identity);
  const semanticPlanPath = path.join(episodeDir, "semantic_scene_plan.json");
  const semanticPlan = await jsonStatusWithSourceHashesComplete(semanticPlanPath, "semantic_scene_plan.json");
  const semanticPlanArtifact = await readJson(semanticPlanPath, null);
  const semanticManualRepairV2Path = path.join(episodeDir, "semantic_reconciliation_evidence_repair_v2.json");
  const semanticManualRepairPath = await exists(semanticManualRepairV2Path)
    ? semanticManualRepairV2Path
    : path.join(episodeDir, "semantic_reconciliation_evidence_repair.json");
  const semanticManualRepair = await readJson(semanticManualRepairPath, null);
  const semanticRecoveryBase = semanticRecoveryCommandForTests(semanticPlanArtifact, identity, scriptHash);
  const semanticRecoveryCommand = semanticRecoveryBase
    && semanticManualRepair?.schema === "goldflow_semantic_reconciliation_repair_v1"
    && semanticManualRepair?.status === "approved"
    && semanticManualRepair?.source_script_hash === scriptHash
    && /--semantic-chunk-ids global_reconciliation\b/.test(semanticRecoveryBase)
    ? `${semanticRecoveryBase} --manual-reconciliation-evidence ${semanticManualRepairPath}`
    : semanticRecoveryBase;
  const storyFactLedger = await jsonStatusWithSourceHashesComplete(path.join(episodeDir, "story_fact_ledger.json"), "story_fact_ledger.json");
  const timedScenePlan = await jsonStatusWithSourceHashesComplete(path.join(episodeDir, "timed_scene_plan.json"), "timed_scene_plan.json");
  const visualBeatPlanPath = path.join(episodeDir, "visual_beat_plan.json");
  let visualBeatPlan = await jsonStatusWithSourceHashesComplete(visualBeatPlanPath, "visual_beat_plan.json");
  const visualBeatRepairScope = !legacyIdentity
    ? await readVisualBeatRecoveryScope({ episodeDir, sourceScriptHash: scriptHash, identity }) : null;
  const visualBeatRecoveryCommand = visualBeatRecoveryCommandForTests(visualBeatRepairScope, identity);
  if (visualBeatRecoveryCommand) visualBeatPlan = { ...visualBeatPlan, next_command_shape: visualBeatRecoveryCommand };
  if (!legacyIdentity && visualBeatPlan.done) {
    const [beatArtifact, beatApproval, beatPlanHash] = await Promise.all([
      readJson(visualBeatPlanPath, null),
      readJson(path.join(episodeDir, "visual_beat_approval.json"), null),
      fileSha256(visualBeatPlanPath),
    ]);
    const contract = beatArtifact?.visual_beat_contract_version ?? beatArtifact?.planner_contract_version;
    const approvalCurrent = beatApproval?.status === "approved" && beatApproval.visual_beat_plan_sha256 === beatPlanHash;
    if (contract !== CURRENT_VISUAL_BEAT_CONTRACT_VERSION || !approvalCurrent) {
      visualBeatPlan = {
        done: false,
        state: contract !== CURRENT_VISUAL_BEAT_CONTRACT_VERSION ? "stale" : "missing",
        evidence: `visual_beat_plan.json requires ${CURRENT_VISUAL_BEAT_CONTRACT_VERSION} and current visual_beat_approval.json`,
      };
    } else {
      const timing = identity.visual_beat_timing_contract
        ?? identity.provider_locks?.visual_beat_timing_contract
        ?? {};
      if (String(timing.enforcement ?? "advisory") === "hard_max") {
        const globalMax = Number(timing.max_beat_sec ?? 8);
        const hookEnd = Number(timing.hook_duration_sec ?? 30);
        const hookMax = Math.min(globalMax, Number(timing.hook_max_beat_sec ?? globalMax));
        const rampEnd = Number(timing.retention_ramp_sec ?? 1200);
        const rampMax = Math.min(globalMax, Number(timing.ramp_max_beat_sec ?? globalMax));
        const overlong = (beatArtifact?.beats ?? []).filter((beat) => {
          const start = Number(beat.start_sec ?? 0);
          const duration = Number(beat.duration_sec ?? (Number(beat.end_sec ?? 0) - start));
          const activeMax = start < hookEnd ? hookMax : start < rampEnd ? rampMax : globalMax;
          return Number.isFinite(duration) && duration > activeMax + 0.1;
        });
        if (overlong.length) {
          visualBeatPlan = {
            done: false,
            state: "blocked",
            evidence: `visual_beat_plan.json violates hard visual density: ${overlong.length} beat(s) exceed their active ceiling; first=${overlong[0].visual_beat_id ?? overlong[0].image_id_hint ?? "unknown"}`,
          };
        }
      }
    }
  }
  const visualReferencePlan = await visualReferencePlanComplete(episodeDir, scriptHash, identity);
  const visualPromptPlan = await jsonStatusWithSourceHashesComplete(path.join(episodeDir, "section_image_prompts.json"), "section_image_prompts.json");
  const visualPromptRepairScope = await readVisualPromptRecoveryScope({ episodeDir, sourceScriptHash: scriptHash, identity });
  const hardenedPromptPlan = await jsonStatusWithSourceHashesComplete(path.join(episodeDir, "section_image_prompts_hardened.json"), "section_image_prompts_hardened.json");
  const longformMix = await longformMixComplete(episodeDir, episode, identity);
  const referenceGeneration = await referenceGenerationComplete(episodeDir, identity, scriptHash);
  const referenceImageApproval = await referenceImageApprovalComplete(episodeDir, episode);
  const legacyCharacterRefs = await readJson(path.join(episodeDir, "character_state_refs.json"), null);
  const legacyCharacterRefStatus = String(legacyCharacterRefs?.status ?? "").toLowerCase();
  const imagegen = await imageReportComplete(episodeDir, episode, identity);
  const focalAnalysisContractCurrent = String(identity.stage_registry_version ?? "") >= "2026-07-12.2";
  const imageFocalAnalysis = focalAnalysisContractCurrent ? await imageFocalAnalysisComplete(episodeDir, episode) : null;
  const imageOutputQa = await imageOutputQaComplete(episodeDir, episode, identity);
  const noLtxOverride = await noLtxOverrideStatus(episodeDir, episode, runIdentityPath, identity);
  const generatedMotionPolicyCurrent = generatedMotionEnabled(identity) && !noLtxOverride.done;
  const animationDirectionPlan = generatedMotionPolicyCurrent ? await animationDirectionPlanComplete(episodeDir, episode) : null;
  const generatedMotionGeneration = generatedMotionPolicyCurrent ? await generatedMotionGenerationComplete(episodeDir, episode, identity) : null;
  const generatedMotionApproval = generatedMotionPolicyCurrent ? await generatedMotionApprovalComplete(episodeDir, episode, identity) : null;
  const parallaxPolicyCurrent = identity.parallax_policy === "selective_inspected";
  const parallaxGeneration = parallaxPolicyCurrent ? await parallaxAssetGenerationComplete(episodeDir, episode) : null;
  const parallaxApproval = parallaxPolicyCurrent ? await parallaxAssetApprovalComplete(episodeDir, episode) : null;
  const render = await renderComplete(episodeDir, episode, identity);
  const finalQa = await finalQaComplete(episodeDir, episode, identity);
  const latestPackaging = await latestMatching(episodeDir, /^upload_packaging.*\.md$|^title_thumbnail.*\.json$|^thumbnail.*\.png$/);
  const youtubeContractCurrent = youtubePublishingRequired(identity);
  const youtubeUploadPackaging = youtubeContractCurrent
    ? await youtubeUploadPackagingComplete(episodeDir, episode, runIdentity)
    : { done: Boolean(latestPackaging), evidence: latestPackaging?.name ?? "upload packaging missing" };
  const youtubePublishManifest = youtubeContractCurrent
    ? await youtubePublishManifestComplete(episodeDir, episode)
    : null;
  const youtubeUploadReceipt = youtubeContractCurrent
    ? await youtubeUploadReceiptComplete(episodeDir, episode)
    : null;
  const youtubePinnedCommentReceipt = youtubeContractCurrent
    ? await youtubePinnedCommentReceiptComplete(episodeDir, episode)
    : null;
  const visualPromptNextCommand = await visualPromptPlanReviewHardenCommand(episodeDir, identity, visualPromptRepairScope);
  const narratorOnly = isNarratorOnlyAudio(identity);
  const sfxScoreDone = narratorOnly
    ? { done: true, evidence: "skipped: audio_target narrator_only" }
    : {
        done: await exists(path.join(episodeDir, `sfx_event_plan_${episode}.json`)) && await exists(path.join(episodeDir, `score_drop_plan_${episode}.json`)),
        evidence: `sfx_event_plan_${episode}.json`,
      };

  const referencePlanPath = path.join(episodeDir, "visual_reference_plan.json");
  const referencePlanHash = await fileSha256(referencePlanPath);
  const referencePlanArtifact = await readJson(referencePlanPath, null);
  const referencePlanApproval = await readJson(path.join(episodeDir, "reference_plan_approval.json"), null);
  const referencePlanApprovalDone = Boolean(referencePlanArtifact && referencePlanApprovalMatches({
    approval: referencePlanApproval,
    plan: referencePlanArtifact,
    fileSha256: referencePlanHash,
  }));
  const hardenReport = await readJson(path.join(episodeDir, `visual_prompt_hardening_${episode}.json`), null);
  const hardenStatus = String(hardenReport?.status ?? "").toLowerCase();
  const transitionPlanPath = path.join(episodeDir, `transition_edit_plan_${episode}.json`);
  const transitionPlanArtifact = await readJson(transitionPlanPath, null);
  const transitionRecoveryCommand = transitionRecoveryCommandForTests(
    transitionPlanArtifact,
    identity,
  );
  const transitionPlan = {
    ...await jsonStatusWithSourceHashesComplete(
      transitionPlanPath,
      `transition_edit_plan_${episode}.json`,
    ),
    ...(transitionRecoveryCommand
      ? { next_command_shape: transitionRecoveryCommand }
      : {}),
  };
  const motionPlan = await jsonStatusWithSourceHashesComplete(path.join(episodeDir, `motion_edit_plan_${episode}.json`), `motion_edit_plan_${episode}.json`);
  const semanticValidation = legacyIdentity
    ? {
        ...semanticPlan,
        evidence: `${semanticPlan.evidence ?? "semantic_scene_plan.json"}; legacy run: story_fact_ledger waived`,
        ...(semanticRecoveryCommand ? { next_command_shape: semanticRecoveryCommand } : {}),
      }
    : {
        done: semanticPlan.done && storyFactLedger.done,
        evidence: `${semanticPlan.evidence}; ${storyFactLedger.evidence}`,
        state: semanticPlan.state ?? storyFactLedger.state,
        ...(semanticRecoveryCommand ? { next_command_shape: semanticRecoveryCommand } : {}),
      };
  const runIdentityTts = runIdentityTtsComplete(runIdentity);
  const runIdentityWhisper = runIdentityWhisperComplete(runIdentity);
  const runIdentityPlanning = runIdentityPlanningComplete(runIdentity);
  const openartBaseline = runIdentity.image_provider === "openart_cli"
    ? await openartRestartBaselineState({ episodeDir, identity: runIdentity }) : null;
  const falBaseline = runIdentity.image_provider === "fal_ai"
    ? await falRestartBaselineState({ episodeDir, identity: runIdentity }) : null;
  const visualRestartBaseline = openartBaseline ?? falBaseline;
  const runIdentityImage = visualRestartBaseline
    ? visualRestartBaseline
    : isFederatedWebImageProvider(identity.image_provider)
    ? await federatedWebImageIdentityStatus(identity)
    : isGoogleFlowPrimaryProvider(identity.image_provider)
      ? await googleFlowPrimaryIdentityStatus(identity)
      : await hybridWebFlowIdentityStatus(identity);
  const validationByStage = {
    run_identity: {
      done: await exists(runIdentityPath)
        && runIdentityTts.done
        && runIdentityWhisper.done
        && runIdentityPlanning.done
        && runIdentityImage.done,
      evidence:
        `${legacyIdentity ? "run_identity.json legacy adapter" : "run_identity.json v2"}; `
        + `${runIdentityTts.evidence}; ${runIdentityWhisper.evidence}; ${runIdentityPlanning.evidence}; ${runIdentityImage.evidence}`,
    },
    source_ingest: {
      done: await exists(path.join(episodeDir, "script_clean.md")) && await exists(path.join(episodeDir, "source_story_ingest_report.json")),
      evidence: "script_clean.md + source_story_ingest_report.json",
    },
    script_approval: scriptApproval,
    script_pace_check: scriptPace,
    targeted_speakability: { done: speakability.done && ttsOverrides.done, evidence: `${speakability.evidence}; ${ttsOverrides.evidence}` },
    semantic_scene_plan: semanticValidation,
    voice_plan: qwenVoicePlan,
    qwen_tts_stitch: qwenTtsStitch,
    local_whisper_word_timing: whisperTiming,
    audio_pace_check: { ...audioPace, next_command_shape: audioPaceNextCommand },
    timing_bind: timedScenePlan,
    sfx_score_plan: narratorOnly
      ? { state: "skipped_with_waiver", evidence: "audio_target narrator_only; audio design intentionally disabled" }
      : sfxScoreDone,
    longform_audio_mix: longformMix,
    visual_beat_plan: visualBeatPlan,
    visual_reference_plan: visualReferencePlan,
    reference_plan_approval: legacyIdentity
      ? { state: "skipped_with_waiver", evidence: "legacy run predates reference-plan hash approval" }
      : { done: referencePlanApprovalDone, evidence: referencePlanApprovalDone ? "reference_plan_approval.json creative contract hash=current" : "reference plan creative contract approval missing or stale" },
    reference_generation: referenceGeneration,
    reference_image_approval: legacyIdentity && legacyCharacterRefStatus !== "draft_needs_manual_review" && !referenceImageApproval.done
      ? { state: "skipped_with_waiver", evidence: "legacy run predates separate generated-reference approval report" }
      : referenceImageApproval,
    visual_prompt_plan: visualPromptPlan.done
      ? visualPromptPlan
      : { ...visualPromptPlan, next_command_shape: visualPromptNextCommand },
    visual_prompt_harden: hardenStatus === "blocked" || /visual review|manual agent review/i.test(String(visualPromptNextCommand ?? ""))
      ? { state: "blocked", evidence: `${hardenedPromptPlan.evidence ?? "hardened prompts"}; harden blockers present`, next_command_shape: visualPromptNextCommand }
      : hardenedPromptPlan,
    visual_prompt_blocker_repair: hardenedPromptPlan.done
      ? { state: "skipped_with_waiver", evidence: "hardening passed with no unresolved prompt blockers" }
      : { state: hardenStatus === "blocked" ? "missing" : "blocked", evidence: hardenStatus ? `hardening status=${hardenStatus}` : "awaiting hardening result", next_command_shape: visualPromptNextCommand },
    transition_edit_plan: legacyIdentity
      ? { done: await exists(path.join(episodeDir, `transition_edit_plan_${episode}.json`)), evidence: `transition_edit_plan_${episode}.json legacy adapter` }
      : transitionPlan,
    image_generation: imagegen,
    image_focal_analysis: focalAnalysisContractCurrent
      ? imageFocalAnalysis
      : { state: "skipped_with_waiver", evidence: "run predates hash-bound image focal analysis contract" },
    image_output_qa: legacyIdentity && !imageOutputQaRequired(identity)
      ? { state: "skipped_with_waiver", evidence: "legacy run predates required per-cut image QA" }
      : imageOutputQa,
    animation_direction_plan: generatedMotionPolicyCurrent
      ? animationDirectionPlan
      : { state: "skipped_with_waiver", evidence: noLtxOverride.done ? noLtxOverride.evidence : "animation_policy disabled in run identity" },
    generated_video_motion: generatedMotionPolicyCurrent
      ? generatedMotionGeneration
      : { state: "skipped_with_waiver", evidence: noLtxOverride.done ? noLtxOverride.evidence : "generated_motion_policy disabled in run identity" },
    generated_video_motion_approval: generatedMotionPolicyCurrent
      ? generatedMotionApproval
      : { state: "skipped_with_waiver", evidence: noLtxOverride.done ? noLtxOverride.evidence : "generated_motion_policy disabled in run identity" },
    parallax_asset_generation: parallaxPolicyCurrent
      ? parallaxGeneration
      : { state: "skipped_with_waiver", evidence: identity.parallax_policy === "disabled" ? "parallax explicitly disabled in run identity" : "run predates selective inspected parallax contract" },
    parallax_asset_approval: parallaxPolicyCurrent
      ? parallaxApproval
      : { state: "skipped_with_waiver", evidence: identity.parallax_policy === "disabled" ? "parallax explicitly disabled in run identity" : "run predates selective inspected parallax contract" },
    motion_edit_plan: legacyIdentity
      ? { state: "skipped_with_waiver", evidence: "legacy run predates directed motion-plan contract" }
      : motionPlan,
    premium_render: render,
    final_qa: finalQa,
    upload_packaging: youtubeUploadPackaging,
    youtube_publish_readiness: youtubeContractCurrent
      ? youtubePublishManifest
      : { state: "skipped_with_waiver", evidence: "run predates hash-bound YouTube publish manifest" },
    youtube_studio_upload: youtubeContractCurrent
      ? youtubeUploadReceipt
      : { state: "skipped_with_waiver", evidence: "run predates browser-assisted YouTube upload receipt" },
    youtube_pinned_comment: youtubeContractCurrent
      ? youtubePinnedCommentReceipt
      : { state: "skipped_with_waiver", evidence: "run predates pinned-comment receipt contract" },
  };

  if (openartBaseline) {
    if (!openartBaseline.done) {
      validationByStage.run_identity = { done: false, state: "blocked", evidence: openartBaseline.evidence };
    } else {
      Object.assign(validationByStage, openartBaseline.stageStates);
      const { openartProductionStageStates } = await import("./lib/openart-production-state.mjs");
      const openart = await openartProductionStageStates({ episodeDir, identity: runIdentity });
      const ownedStages = new Set(["visual_reference_plan", "reference_plan_approval", "reference_generation", "reference_image_approval", "visual_prompt_plan", "visual_prompt_harden", "visual_prompt_blocker_repair", "image_generation"]);
      for (const [stageId, state] of Object.entries(openart.stageStates ?? {})) {
        if (!ownedStages.has(stageId)) throw new Error(`OpenArt adapter cannot replace native ${stageId} gate.`);
        validationByStage[stageId] = state;
      }
    }
  }

  if (falBaseline) {
    if (!falBaseline.done) {
      validationByStage.run_identity = { done: false, state: "blocked", evidence: falBaseline.evidence };
    } else {
      Object.assign(validationByStage, falBaseline.stageStates);
      const { falProductionStageStates } = await import("./lib/fal-production-state.mjs");
      const fal = await falProductionStageStates({ episodeDir, identity: runIdentity });
      const ownedStages = runIdentity.visual_restart?.fork_at === "visual_reference_plan"
        ? new Set(["reference_generation", "image_generation"])
        : new Set(["reference_image_approval", "image_generation"]);
      for (const [stageId, state] of Object.entries(fal.stageStates ?? {})) {
        if (!ownedStages.has(stageId)) throw new Error(`Fal adapter cannot replace native ${stageId} gate.`);
        validationByStage[stageId] = state;
      }
    }
  }

  const rows = stageRegistry.map((definition) => {
    const validation = validationByStage[definition.id] ?? { state: "missing", evidence: "validator not materialized" };
    return stage(definition.id, validation, identity, validation.next_command_shape);
  });

  const next = rows.find((row) => !stageIsSatisfied(row.state)) ?? null;
  const readyCommandStages = readyStageIds(rows, identity);
  const semanticRepairUnitIds = next?.stage === "semantic_scene_plan" && next?.state === "blocked"
    ? semanticFailedRecoveryScope(semanticPlanArtifact, scriptHash)
    : [];
  const promptRecoveryStatus = { current_stage: next?.stage, current_stage_state: next?.state,
    identity, stage_ledger: rows, visual_prompt_recovery_scope: visualPromptRepairScope };
  const promptRecoveryAllowed = visualPromptRecoveryAdmission(promptRecoveryStatus,
    { "cut-ids": visualPromptRepairScope?.failed_cut_ids?.join(",") ?? "" }).allowed;
  const repairCommandStages = semanticRepairUnitIds.length
    ? ["semantic_scene_plan"]
    : next?.stage === "voice_plan" && next?.state === "blocked"
      && /voice plan\b.*--performance-packet-ids\s+\S+/.test(String(next.next_command_shape ?? ""))
    ? ["voice_plan"]
    : next?.stage === "visual_beat_plan" && next?.state === "blocked" && visualBeatRepairScope
    ? ["visual_beat_plan"]
    : promptRecoveryAllowed
    ? ["visual_prompt_plan"]
    : next?.stage === "visual_prompt_harden" && next?.state === "blocked"
    ? ["visual_prompt_harden", "visual_prompt_blocker_repair"]
    : next?.stage === "qwen_tts_stitch"
      && next?.state === "blocked"
      && /tts (?:approve-listen|narrate|finalize-provider)\b/.test(String(next.next_command_shape ?? ""))
      ? ["qwen_tts_stitch"]
    : ["reference_generation", "image_generation"].includes(next?.stage)
      && next?.state === "blocked"
      && !(next?.stage === "reference_generation" && referenceGeneration.reference_image_qa_recovery_scope)
      && /imagegen browser-pool\b.*--(?:reference|image)-ids\s+\S+.*--repair-reason\b/.test(String(next.next_command_shape ?? ""))
      ? [next.stage]
    : next?.stage === "image_output_qa"
      && next?.state === "blocked"
      && /imagegen browser-pool\b.*--image-ids\s+\S+.*--qa-recovery\s+true\b.*--repair-reason\b/.test(String(next.next_command_shape ?? ""))
      ? ["image_output_qa"]
      : [];
  const result = {
    schema: "goldflow_run_status_v2",
    media_workflow: mediaWorkflow,
    workflow_selection_state: !persistedRunIdentity ? "missing" : mediaWorkflow.legacy ? "legacy_adapter" : "locked",
    stage_registry_version: PIPELINE_STAGE_REGISTRY_VERSION,
    episode_dir: episodeDir,
    identity,
    run_identity_path: await exists(runIdentityPath) ? runIdentityPath : null,
    current_stage: next?.stage ?? "complete",
    current_stage_state: next?.state ?? "passed",
    ...(semanticRepairUnitIds.length ? {
      semantic_recovery_scope: { failed_unit_ids: semanticRepairUnitIds, source_script_hash: scriptHash },
    } : {}),
    ...(next?.stage === "visual_beat_plan" && next?.state === "blocked" && visualBeatRepairScope
      ? { visual_beat_recovery_scope: visualBeatRepairScope } : {}),
    ...(next?.stage === "reference_generation" && next?.state === "blocked" && referenceGeneration.reference_image_qa_recovery_scope
      ? { reference_image_qa_recovery_scope: referenceGeneration.reference_image_qa_recovery_scope } : {}),
    ...(next?.stage === "visual_reference_plan" && next?.state === "blocked" && visualReferencePlan.recovery_scope
      ? { visual_reference_recovery_scope: visualReferencePlan.recovery_scope } : {}),
    ...(promptRecoveryAllowed ? { visual_prompt_recovery_scope: visualPromptRepairScope } : {}),
    allowed_command_stages: [...new Set([
      ...readyCommandStages,
      ...repairCommandStages,
      ...(next?.stage && !["blocked", "failed"].includes(String(next.state ?? "")) ? [next.stage] : []),
    ])],
    next_required_input: next?.required_input ?? null,
    next_output_artifact: next?.output_artifact ?? null,
    operator_approval_required: next?.operator_approval_required ?? false,
    next_command_shape: next?.next_command_shape ?? null,
    manual_blocker_triage_policy: MANUAL_BLOCKER_TRIAGE_POLICY,
    execution_telemetry: productionManifest?.telemetry ?? null,
    production_manifest_path: productionManifest ? path.join(episodeDir, "production_manifest.json") : null,
    stage_ledger: rows,
  };

  if (flags.format === "markdown" || flags.md === "true") {
    console.log(`# Goldflow Run Status\n`);
    console.log(`Episode dir: ${episodeDir}`);
    console.log(`Content profile: ${!persistedRunIdentity ? "unselected (preflight required)" : identity.content_profile_config?.id ?? identity.content_profile ?? "manhwa_recap_v1 (legacy default)"}`);
    console.log(`Media workflow: ${!persistedRunIdentity ? "unselected (generated registry preview only)" : `${mediaWorkflow.id}${mediaWorkflow.legacy ? " (legacy adapter; identity unchanged)" : " (identity-locked)"}`}`);
    console.log(`Current stage: ${result.current_stage}`);
    if (result.next_command_shape) console.log(`Next command shape: \`${result.next_command_shape}\``);
    console.log(`Manual blocker triage: ${MANUAL_BLOCKER_TRIAGE_POLICY.summary}`);
    console.log("\n| Stage | State | Approval | Output |");
    console.log("| --- | --- | --- | --- |");
    for (const row of rows) {
      console.log(`| ${row.stage} | ${row.state} | ${row.operator_approval_required ? "yes" : "no"} | ${row.output_artifact} |`);
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  referenceGenerationComplete as referenceGenerationCompleteForTests,
  inferredState as inferredStateForTests,
  visualReferencePlanComplete as visualReferencePlanCompleteForTests,
  hybridDeadletteredAssetIds as hybridDeadletteredAssetIdsForTests,
  runIdentityPlanningComplete as runIdentityPlanningCompleteForTests,
  runIdentityTtsComplete as runIdentityTtsCompleteForTests,
  runIdentityWhisperComplete as runIdentityWhisperCompleteForTests,
  narrationPlanUnitsForStatus as narrationPlanUnitsForStatusForTests,
  selectedNarratorVoiceId as selectedNarratorVoiceIdForTests,
  ttsStatusIdentityFields as ttsStatusIdentityFieldsForTests,
};
