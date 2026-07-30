#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeImageProvider } from "./lib/image-provider-routing.mjs";
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
  DEFAULT_PRODUCTION_PROFILE,
  normalizeProductionProfile,
  productionProfileSummary,
} from "./lib/production-profiles.mjs";
import {
  validateLocalWhisperIdentityContract,
} from "./lib/local-whisper-policy.mjs";
import {
  DEFAULT_NARRATOR_VOICE_ID,
  DEFAULT_TTS_FALLBACK_PROVIDER,
  DEFAULT_TTS_PROVIDER,
  KOKORO_MODEL_LOCK,
  QWEN_JOEL_PRIMARY_LOCK,
  QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  QWEN_LOCAL_FALLBACK_LOCK,
  defaultNarrationVoiceProviderOptions,
  normalizeTtsProvider,
  narrationTtsPolicyForIdentity,
  validateNarrationTtsPolicy,
} from "./lib/narration-tts-policy.mjs";
import {
  LTX_VIDEO_MODEL_ID,
  LTX_VIDEO_PROVIDER,
  normalizeLtxVideoPolicy,
} from "./lib/ltx-video-contract.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_QWEN_NARRATOR_VOICE_ID = "joel_owned_narrator_clone";
const DEFAULT_QWEN_NARRATOR_VOICE_POLICY = "default_joel_owned_narrator_clone";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel;
const series = flags.series ?? flags.seriesSlug;
const week = flags.week;
const episode = flags.episode;
const title = flags.title ?? flags["episode-title"] ?? "";
const sourcePath = flags.source ? path.resolve(flags.source) : null;
const allowPartInWeek = flags["allow-part-in-week"] === "true";
const confirmEpisodeIdentity = flags["confirm-episode-identity"] === "true";
const imageProvider = normalizeImageProvider(flags["image-provider"] ?? flags.provider ?? "modelslab");
const imageFallbackProvider = flags["image-fallback-provider"]
  ? normalizeImageProvider(flags["image-fallback-provider"])
  : null;
const imageFallbackCondition = normalizeImageFallbackCondition(
  flags["image-fallback-condition"] ?? (imageFallbackProvider ? MODELSLAB_CREDIT_EXHAUSTED : null),
);
const audioTarget = normalizeAudioTarget(flags["audio-target"] ?? flags.audio ?? "narrator_only");
const runIntent = normalizeRunIntent(flags.intent ?? flags["run-intent"] ?? "production");
const productionProfile = normalizeProductionProfile(
  flags["production-profile"] ?? flags.profile ?? DEFAULT_PRODUCTION_PROFILE,
);
const productionProfileConfig = productionProfileSummary(productionProfile);
const localWhisperTimingContract = structuredClone(
  productionProfileConfig.audio.local_whisper_timing,
);
const allowDirtyWorktree = flags["allow-dirty-worktree"] === "true";
const dirtyReason = String(flags["dirty-reason"] ?? "").trim();
const codexOpeningSecRaw = flags["codex-opening-sec"] ?? flags["codex-opening-duration-sec"] ?? process.env.ANIFACTORY_CODEX_OPENING_SEC ?? null;
const pacePolicy = normalizePacePolicy(flags["pace-policy"] ?? flags["wpm-policy"] ?? "diagnostic");
const targetWpmMin = positiveNumber(flags["target-wpm-min"] ?? flags["wpm-min"] ?? null, 180);
const targetWpmMax = positiveNumber(flags["target-wpm-max"] ?? flags["wpm-max"] ?? null, 195);
const renderProfile = normalizeRenderProfile(flags["render-profile"] ?? flags.render ?? "premium");
const motionPolicy = normalizeMotionPolicy(flags["motion-policy"] ?? "selective_editorial_v1");
const ltxVideoPolicy = normalizeLtxVideoPolicy(
  flags["animation-policy"] ?? flags["ltx-video-policy"] ?? "selective_ltx23",
);
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
if (!["qwen_local", "kokoro_local", "modelslab_qwen"].includes(ttsProvider)) {
  throw new Error(`Unsupported TTS provider: ${ttsProvider}.`);
}
if (explicitLegacyQwenFlags && flags["tts-provider"] == null) {
  throw new Error("Legacy Qwen flags do not select the local production provider. Omit them for the Joel/Qwen default, or explicitly pass --tts-provider modelslab_qwen for a legacy diagnostic.");
}
if (runIntent === "production" && ttsProvider !== DEFAULT_TTS_PROVIDER) {
  throw new Error(`New production runs require ${DEFAULT_TTS_PROVIDER} with ${DEFAULT_NARRATOR_VOICE_ID}.`);
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
  : boundedNumber(
      requestedTtsNativeSpeed,
      ttsProvider === "kokoro_local" ? 1.2 : 1.25,
      0.75,
      1.5,
    );
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
  return {
    planning_model: flags["planning-model"] ?? process.env.ANIFACTORY_CODEX_MODEL ?? DEFAULT_CODEX_MODEL,
    planning_reasoning_effort: flags["planning-reasoning-effort"] ?? process.env.ANIFACTORY_CODEX_REASONING_EFFORT ?? DEFAULT_CODEX_REASONING_EFFORT,
    tts_model: genericTts ? primaryLock.model_id : flags["tts-model"] ?? "qwen-tts",
    tts_model_revision: genericTts ? primaryLock.model_revision : null,
    tts_runtime: genericTts ? `${primaryLock.runtime}@${primaryLock.runtime_version}` : null,
    fallback_tts_model: fallbackLock?.model_id ?? null,
    fallback_tts_model_revision: fallbackLock?.model_revision ?? null,
    fallback_tts_runtime: fallbackLock
      ? `${fallbackLock.runtime}@${fallbackLock.runtime_version}`
      : null,
    local_whisper_model: localWhisperTimingContract.model,
    image_model: flags["image-model"] ?? process.env.ANIFACTORY_IMAGE_MODEL ?? "flux-klein",
    reference_model: flags["reference-model"] ?? process.env.ANIFACTORY_REFERENCE_MODEL ?? process.env.ANIFACTORY_IMAGE_MODEL ?? "flux-klein",
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

function voiceProviderOptions() {
  if (ttsProvider === "qwen_local" || ttsProvider === "kokoro_local") {
    const options = defaultNarrationVoiceProviderOptions({
      provider: ttsProvider,
      fallbackProvider: ttsFallbackProvider,
      voiceId: narratorVoiceId,
      nativeSpeed: ttsNativeSpeed,
    });
    validateNarrationTtsPolicy(narrationTtsPolicyForIdentity({
      episode,
      tts_provider: ttsProvider,
      tts_fallback_provider: ttsFallbackProvider,
      narrator_voice_id: narratorVoiceId,
      tts_native_speed: ttsNativeSpeed,
      voice_provider_options: options,
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

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  validateImageFallbackPolicy();
  const git = await gitSnapshot();
  validateDirtyWorktreePolicy({ dirty: git.dirty, intent: runIntent, allowDirty: allowDirtyWorktree, reason: dirtyReason });
  const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
  const now = new Date().toISOString();
  const manifest = {
    schema: "goldflow_run_identity_v2",
    stage_registry_version: PIPELINE_STAGE_REGISTRY_VERSION,
    status: "preflight_passed_pending_ingest",
    channel,
    series_slug: series,
    week,
    episode,
    episode_number: epNumber,
    title,
    image_provider: imageProvider,
    image_provider_options: imageProviderOptions(imageProvider),
    voice_provider_options: voiceProviderOptions(),
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
    production_profile: productionProfile,
    production_profile_config: productionProfileConfig,
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
    animation_policy: ltxVideoPolicy,
    ltx_video_policy: ltxVideoPolicy,
    ltx_video_provider: ltxVideoPolicy === "disabled" ? null : LTX_VIDEO_PROVIDER,
    ltx_video_model: ltxVideoPolicy === "disabled" ? null : LTX_VIDEO_MODEL_ID,
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
    git,
    dirty_worktree_waiver: git.dirty ? {
      allowed: true,
      reason: dirtyReason,
      intent: runIntent,
      recorded_at: now,
    } : null,
    provider_locks: {
      image_provider: imageProvider,
      image_model: lockedModelVersions().image_model,
      reference_model: lockedModelVersions().reference_model,
      image_fallback_provider: imageFallbackProvider,
      image_fallback_condition: imageFallbackCondition,
      parallax_background_provider: parallaxBackgroundProvider,
      ltx_video_provider: ltxVideoPolicy === "disabled" ? null : LTX_VIDEO_PROVIDER,
      ltx_video_model: ltxVideoPolicy === "disabled" ? null : LTX_VIDEO_MODEL_ID,
      audio_target: audioTarget,
      local_whisper_timing: structuredClone(localWhisperTimingContract),
      tts_provider: ttsProvider,
      tts_fallback_provider: ttsFallbackProvider,
      narrator_voice_id: ttsProvider !== "modelslab_qwen" ? narratorVoiceId : qwenNarratorVoiceId,
      tts_native_speed: ttsProvider !== "modelslab_qwen" ? ttsNativeSpeed : qwenNativeSpeed,
      tts_speed_control: ttsProvider === "qwen_local" ? "unsupported" : "provider_native",
      tts_model: lockedModelVersions().tts_model,
      tts_model_revision: lockedModelVersions().tts_model_revision,
      fallback_tts_model: lockedModelVersions().fallback_tts_model,
      fallback_tts_model_revision: lockedModelVersions().fallback_tts_model_revision,
      narrator_voice_identity: ttsProvider !== "modelslab_qwen" ? narratorVoiceId : qwenNarratorVoiceId,
      primary_reference_audio_sha256: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.reference_audio_sha256 : null,
      primary_reference_manifest_sha256: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.reference_manifest_sha256 : null,
      primary_reference_metadata_sha256: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.reference_metadata_sha256 : null,
      primary_voice_sha256: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.voice_sha256 : null,
      primary_similarity_model_sha256: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.speaker_similarity_model_sha256 : null,
      primary_similarity_calibration_sha256: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.speaker_similarity_calibration_sha256 : null,
      primary_minimum_cosine_similarity: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.minimum_cosine_similarity : null,
      primary_warning_below_cosine_similarity: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.warning_below_cosine_similarity : null,
      primary_voice_continuity_contract: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.voice_continuity_contract : null,
      tts_unit_target_words_min: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.unit_contract.target_words_min : null,
      tts_unit_target_words_max: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.unit_contract.target_words_max : null,
      tts_unit_hard_words_max: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.unit_contract.hard_words_max : null,
      tts_sentence_complete_units: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.unit_contract.sentence_complete : null,
      tts_continuous_requests: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.unit_contract.continuous_requests : null,
      tts_join_silence_ms: ttsProvider === "qwen_local" ? QWEN_JOEL_PRIMARY_LOCK.stitch_contract.join_silence_ms : null,
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
    episode_identity_policy: {
      episode_number_lives_in: "--episode",
      week_slug_policy: "Do not encode Part 2/Part 3 in --week for sequel episodes unless the operator explicitly approves a standalone run.",
      sequel_rule: "Part 2 implies ep_02 by default; Part 3 implies ep_03 by default.",
    },
    production_gates: {
      script_hash_approval_required_before_downstream: true,
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
      tts_unit_hard_words_max: ttsProvider === "qwen_local"
        ? QWEN_JOEL_PRIMARY_LOCK.unit_contract.hard_words_max
        : null,
      tts_join_silence_ms: ttsProvider === "qwen_local"
        ? QWEN_JOEL_PRIMARY_LOCK.stitch_contract.join_silence_ms
        : null,
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
      animation_direction_required_after_image_qa: ltxVideoPolicy !== "disabled",
      generated_video_approval_required_before_motion: ltxVideoPolicy !== "disabled",
      automatic_stage_spend_authorized_by_profile: productionProfileConfig.advance.authorize_planner_spend
        && productionProfileConfig.advance.authorize_media_spend
        && productionProfileConfig.advance.authorize_render,
    },
    stage_checklist: stageChecklistFor({ audio_target: audioTarget, parallax_policy: parallaxPolicy, ltx_video_policy: ltxVideoPolicy }),
    episode_dir: episodeDir,
    updated_at: now,
  };
  const localWhisperIdentityValidation =
    validateLocalWhisperIdentityContract(manifest);
  if (!localWhisperIdentityValidation.done) {
    throw new Error(localWhisperIdentityValidation.evidence);
  }
  const manifestPath = path.join(episodeDir, "run_identity.json");
  await writeJson(manifestPath, manifest);
  console.log(JSON.stringify({ status: "passed", run_identity_path: manifestPath, episode_dir: episodeDir, next_required_stage: "ingest source" }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
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
