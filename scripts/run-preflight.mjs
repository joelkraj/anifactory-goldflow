#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeImageProvider } from "./lib/image-provider-routing.mjs";
import {
  PIPELINE_STAGE_REGISTRY_VERSION,
  stageChecklistFor,
} from "./lib/pipeline-stage-registry.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
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
const audioTarget = normalizeAudioTarget(flags["audio-target"] ?? flags.audio ?? "narrator_only");
const runIntent = flags.intent ?? flags["run-intent"] ?? "production";
const codexOpeningSecRaw = flags["codex-opening-sec"] ?? flags["codex-opening-duration-sec"] ?? process.env.ANIFACTORY_CODEX_OPENING_SEC ?? null;
const pacePolicy = normalizePacePolicy(flags["pace-policy"] ?? flags["wpm-policy"] ?? "enforced");
const targetWpmMin = positiveNumber(flags["target-wpm-min"] ?? flags["wpm-min"] ?? null, 195);
const targetWpmMax = positiveNumber(flags["target-wpm-max"] ?? flags["wpm-max"] ?? null, 220);
const renderProfile = normalizeRenderProfile(flags["render-profile"] ?? flags.render ?? "premium");
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

function normalizePacePolicy(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["diagnostic", "diagnostic_only", "non_blocking", "report_only", "wpm_diagnostic"].includes(normalized)) return "diagnostic";
  return "enforced";
}

function normalizeRenderProfile(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["fill", "fill_ken_burns", "oversampled_ken_burns", "legacy_premium"].includes(normalized)) return "fill_ken_burns";
  return "smooth_fast_ken_burns";
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

function imageProviderOptions(provider) {
  if (
    provider !== "hybrid_codex_opening_modelslab_rest"
    && provider !== "hybrid_codex_refs_opening_risky_modelslab_rest"
    && provider !== "hybrid_modelslab_refs_codex_opening_modelslab_rest"
  ) return {};
  const defaultOpeningSec = provider === "hybrid_modelslab_refs_codex_opening_modelslab_rest" ? 300 : 120;
  const value = Number(codexOpeningSecRaw ?? defaultOpeningSec);
  return {
    codex_opening_sec: Number.isFinite(value) && value > 0 ? value : defaultOpeningSec,
  };
}

function voiceProviderOptions() {
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
  const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
  const now = new Date().toISOString();
  const manifest = {
    schema: "goldflow_run_identity_v1",
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
    qwen_narrator_voice_id: qwenNarratorVoiceId,
    qwen_narrator_voice_policy: qwenNarratorVoicePolicy,
    qwen_native_speed: qwenNativeSpeed,
    audio_target: audioTarget,
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
    image_output_qa_required: true,
    visual_prompt_review_policy: "blockers_only_after_harden",
    run_intent: runIntent,
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
      longform_mix_required_for_production_render: true,
      proof_renders_must_be_labeled_and_must_not_replace_final_render: true,
      provider_native_tts_speed_required: true,
      post_tempo_normalization_default: false,
      image_output_qa_required_before_render: true,
    },
    stage_checklist: stageChecklistFor({ audio_target: audioTarget }),
    episode_dir: episodeDir,
    updated_at: now,
  };
  const manifestPath = path.join(episodeDir, "run_identity.json");
  await writeJson(manifestPath, manifest);
  console.log(JSON.stringify({ status: "passed", run_identity_path: manifestPath, episode_dir: episodeDir, next_required_stage: "ingest source" }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
