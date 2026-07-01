#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeImageProvider } from "./lib/image-provider-routing.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
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
const renderProfile = normalizeRenderProfile(flags["render-profile"] ?? flags.render ?? "premium");

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
  if (["smooth", "smooth_fast", "smooth_fast_ken_burns", "premium_smooth", "no_oversample_smooth"].includes(normalized)) return "smooth_fast_ken_burns";
  return "fill_ken_burns";
}

function imageProviderOptions(provider) {
  if (provider !== "hybrid_codex_opening_modelslab_rest" && provider !== "hybrid_modelslab_refs_codex_opening_modelslab_rest") return {};
  const defaultOpeningSec = provider === "hybrid_modelslab_refs_codex_opening_modelslab_rest" ? 300 : 120;
  const value = Number(codexOpeningSecRaw ?? defaultOpeningSec);
  return {
    codex_opening_sec: Number.isFinite(value) && value > 0 ? value : defaultOpeningSec,
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

function stageChecklist(target) {
  const narratorOnly = target === "narrator_only";
  return [
    ["source_story", "pending"],
    ["script_clean", "pending"],
    ["operator_script_hash_approval", "pending"],
    ["targeted_speakability", "pending"],
    ["semantic_scene_plan", "pending"],
    ["voice_plan", "pending"],
    ["qwen_tts_stitch", "pending"],
    ["local_whisper_word_timing", "pending"],
    ["timing_bound_sfx_score_plan", narratorOnly ? "skipped_audio_target_narrator_only" : "pending"],
    ["longform_audio_mix", "pending"],
    ["visual_beat_plan", "pending"],
    ["visual_reference_plan_and_review", "pending"],
    ["reference_generation_and_qa", "pending"],
    ["visual_prompt_plan_review_harden", "pending"],
    ["image_generation_and_qa", "pending"],
    ["premium_render_from_continuous_mix", "pending"],
    ["final_render_qa", "pending"],
    ["upload_packaging", "pending"],
  ].map(([stage, status]) => ({ stage, status }));
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
    status: "preflight_passed_pending_ingest",
    channel,
    series_slug: series,
    week,
    episode,
    episode_number: epNumber,
    title,
    image_provider: imageProvider,
    image_provider_options: imageProviderOptions(imageProvider),
    audio_target: audioTarget,
    pace_policy: pacePolicy,
    render_profile: renderProfile,
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
    },
    stage_checklist: stageChecklist(audioTarget),
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
