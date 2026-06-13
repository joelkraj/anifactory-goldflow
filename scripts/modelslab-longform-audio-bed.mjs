#!/usr/bin/env node

import { execFile as execFileCb, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCb);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const args = process.argv.slice(2);
const flags = parseFlags(args);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "start";

const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = flags.episodeDir ?? path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const audioDir = path.join(episodeDir, "assets", "audio");
const scoreProvider = flags["score-provider"] ?? process.env.ANIFACTORY_SCORE_PROVIDER ?? "modelslab";
const scoreDir = path.join(audioDir, scoreProvider === "local_ace_step" ? "ace_step_score_beds" : "modelslab_score_beds");
const scoreDropDir = path.join(audioDir, "ace_step_score_drops");
const mixDir = path.join(audioDir, "longform_mix");
const sfxBankManifestPath = path.join(dataRoot, "sfx_bank", "sfx_manifest.json");
const scorePlanPath = flags.scorePlan ?? path.join(episodeDir, "score_chapter_plan.json");
const scoreDropPlanPath = flags.scoreDropPlan ?? flags["score-drop-plan"] ?? path.join(episodeDir, `score_drop_plan_${episode}.json`);
const sfxPlanPath = flags.sfxPlan ?? path.join(episodeDir, `sfx_event_plan_${episode}.json`);
const qwenReportPath = flags.qwenReport ?? path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
const outputBase = flags.outputBase ?? `${episode}-${channel}-modelslab-qwen-scored-sfx`;
const forceScore = flags["force-score"] === "true";
const forceScoreDrops = flags["force-score-drops"] === "true";
const forceSfx = flags["force-sfx"] === "true";
const dryRun = flags["dry-run"] === "true";
const maxDurationSec = Number(flags["max-duration-sec"] ?? 0);
const reportSuffix = flags.reportSuffix ?? (maxDurationSec > 0 ? `-test-${Math.round(maxDurationSec)}s` : "");
const scoreVolumeDb = Number(flags["score-volume-db"] ?? -26);
const scoreDropVolumeDb = Number(flags["score-drop-volume-db"] ?? -18);
const scoreDropDuckDb = Number(flags["score-drop-duck-db"] ?? -8);
const sfxVolumeBoostDb = Number(flags["sfx-boost-db"] ?? 0);
const narrationVolumeDb = Number(flags["narration-volume-db"] ?? 0);
const skipScore = flags["skip-score"] === "true";

let cachedKey = null;

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
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hashText(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function slug(value) {
  return String(value ?? "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function scoreProviderMeta() {
  if (scoreProvider === "local_ace_step") {
    return {
      provider: "local_ace_step",
      model_id: process.env.ANIFACTORY_ACE_STEP_CONFIG_PATH ?? "acestep-v15-turbo",
      lm_model_id: process.env.ANIFACTORY_ACE_STEP_LM_MODEL ?? "acestep-5Hz-lm-1.7B",
      endpoint: "local:ace-step-1.5",
    };
  }
  return {
    provider: "modelslab",
    model_id: "ai-music-generator",
    endpoint: "/api/v6/voice/music_gen",
  };
}

function firstFiniteNumber(values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function audioLinks(response) {
  return [
    ...(Array.isArray(response.output) ? response.output : []),
    ...(Array.isArray(response.proxy_links) ? response.proxy_links : []),
    ...(Array.isArray(response.future_links) ? response.future_links : []),
  ].filter(Boolean);
}

async function apiKey() {
  if (cachedKey) return cachedKey;
  if (process.env.MODELSLAB_API_KEY || process.env.API_KEY) {
    cachedKey = process.env.MODELSLAB_API_KEY || process.env.API_KEY;
    return cachedKey;
  }
  const { stdout: listStdout } = await execFile("modelslab", ["keys", "list", "-o", "json", "--no-color"], { cwd: repoRoot, maxBuffer: 1024 * 1024 });
  const keys = JSON.parse(listStdout)?.data?.items ?? [];
  const selected = keys.find((key) => key.is_default === 1 || key.is_default === true) ?? keys[0];
  if (!selected?.id) throw new Error("No ModelsLab API key available.");
  const { stdout: detailStdout } = await execFile("modelslab", ["keys", "get", "--id", String(selected.id), "-o", "json", "--no-color"], { cwd: repoRoot, maxBuffer: 1024 * 1024 });
  cachedKey = JSON.parse(detailStdout)?.data?.key;
  if (!cachedKey) throw new Error(`Could not read ModelsLab key ${selected.id}.`);
  return cachedKey;
}

async function postModelslab(endpoint, body, label, retries = 2) {
  const key = await apiKey();
  let lastError = null;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const response = await fetch(`https://modelslab.com${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, ...body }),
        signal: AbortSignal.timeout(300000),
      });
      const text = await response.text();
      const json = JSON.parse(text);
      if (!response.ok || json.status === "error" || json.status === "failed") {
        throw new Error(`${label} failed ${response.status}: ${JSON.stringify(json).slice(0, 1000)}`);
      }
      return json;
    } catch (error) {
      lastError = error;
      if (attempt <= retries) await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    }
  }
  throw lastError;
}

async function resolveModelslabAudio(initial, fetchEndpoint, label) {
  let current = initial;
  let requestId = initial?.id ?? null;
  for (let attempt = 0; attempt < 96; attempt += 1) {
    const links = audioLinks(current);
    if (links.length) return current;
    if (current?.status === "failed" || current?.status === "error") throw new Error(`${label} failed while polling: ${JSON.stringify(current).slice(0, 1000)}`);
    if (current?.id) requestId = current.id;
    if (!requestId) throw new Error(`${label} returned no request id or URL: ${JSON.stringify(current).slice(0, 1000)}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    current = await postModelslab(`${fetchEndpoint}/${requestId}`, {}, `${label} fetch`, 1);
  }
  throw new Error(`${label} timed out`);
}

async function downloadAudio(urls, outputPath) {
  let lastError = null;
  for (let round = 1; round <= 10; round += 1) {
    for (const url of urls) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(String(response.status));
        const tmp = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.download`);
        await fs.writeFile(tmp, Buffer.from(await response.arrayBuffer()));
        await execFile("ffmpeg", ["-y", "-i", tmp, "-ar", "44100", "-ac", "2", "-acodec", "pcm_s16le", outputPath], { maxBuffer: 1024 * 1024 * 8 });
        await fs.rm(tmp, { force: true }).catch(() => {});
        return url;
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, round * 2000));
  }
  throw lastError ?? new Error(`Could not download audio to ${outputPath}`);
}

async function mediaDuration(filePath) {
  const { stdout } = await execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath]);
  return Number(stdout.trim());
}

function activeChapters(scorePlan, durationSec) {
  return (scorePlan.chapters ?? []).filter((chapter) => {
    const start = Number(chapter.start_sec ?? 0);
    return !durationSec || start < durationSec;
  });
}

function activeScoreDrops(scoreDropPlan, durationSec) {
  return (scoreDropPlan?.drops ?? []).filter((drop) => {
    const start = Number(drop.start_sec ?? 0);
    return Number.isFinite(start) && (!durationSec || start < durationSec);
  });
}

function dbToAmplitude(dbValue) {
  return Number(Math.pow(10, Number(dbValue) / 20).toFixed(6));
}

function scoreVolumeFilter(gainDb, chapterStart, chapterEnd, scoreDrops) {
  const overlapping = scoreDrops
    .map((drop) => {
      const start = Number(drop.start_sec ?? 0);
      const duration = Number(drop.duration_sec ?? 6);
      const end = start + Math.max(0.5, duration);
      return { start: Math.max(chapterStart, start), end: Math.min(chapterEnd, end) };
    })
    .filter((drop) => drop.end > drop.start)
    .map((drop) => ({
      start: Number((drop.start - chapterStart).toFixed(3)),
      end: Number((drop.end - chapterStart).toFixed(3)),
    }));
  if (!overlapping.length) return `volume=${gainDb}dB`;
  const baseAmp = dbToAmplitude(gainDb);
  const duckAmp = dbToAmplitude(gainDb + scoreDropDuckDb);
  const conditions = overlapping
    .map((drop) => `between(t\\,${drop.start.toFixed(3)}\\,${drop.end.toFixed(3)})`)
    .join("+");
  return `volume='if(${conditions}\\,${duckAmp}\\,${baseAmp})'`;
}

async function generateScoreChapter(chapter, durationSec) {
  await fs.mkdir(scoreDir, { recursive: true });
  const prompt = `${chapter.ace_step_prompt ?? chapter.score_intent ?? "anime recap cinematic score bed"}. Instrumental only, no vocals, no lyrics, no speech, no crowd noise. Loopable longform anime recap background score.`;
  const promptHash = hashText(prompt).slice(0, 12);
  const scoreMeta = scoreProviderMeta();
  if (!forceScore && chapter.asset_path && await exists(chapter.asset_path)) {
    return {
      chapter_id: chapter.chapter_id,
      provider: chapter.asset_provider ?? scoreMeta.provider,
      model_id: chapter.asset_model_id ?? scoreMeta.model_id,
      lm_model_id: chapter.asset_lm_model_id ?? scoreMeta.lm_model_id ?? null,
      endpoint: chapter.asset_endpoint ?? scoreMeta.endpoint,
      asset_path: chapter.asset_path,
      status: "reused_planned_asset",
      prompt,
      prompt_hash: promptHash,
      duration_sec: await mediaDuration(chapter.asset_path).catch(() => durationSec),
    };
  }
  const outPath = path.join(scoreDir, `${chapter.chapter_id}-${promptHash}.wav`);
  const metaPath = outPath.replace(/\.wav$/, ".json");
  if (!forceScore && await exists(outPath)) {
    return { ...await readJson(metaPath, {}), chapter_id: chapter.chapter_id, provider: scoreMeta.provider, model_id: scoreMeta.model_id, lm_model_id: scoreMeta.lm_model_id ?? null, endpoint: scoreMeta.endpoint, asset_path: outPath, status: "reused" };
  }
  if (dryRun) {
    return { chapter_id: chapter.chapter_id, provider: scoreMeta.provider, model_id: scoreMeta.model_id, lm_model_id: scoreMeta.lm_model_id ?? null, endpoint: scoreMeta.endpoint, asset_path: outPath, status: "dry_run", prompt, duration_sec: durationSec };
  }
  if (scoreProvider === "local_ace_step") {
    console.error(`[longform-audio] ACE-Step score ${chapter.chapter_id} ${durationSec}s`);
    const { stdout } = await execFile(process.env.ANIFACTORY_ACE_STEP_PYTHON ?? "/Users/joel/AniFactoryTools/ACE-Step-1.5/.venv/bin/python", [
      path.join(repoRoot, "scripts", "ace-step-score-generate.py"),
      "--output", outPath,
      "--caption", prompt,
      "--duration", String(Math.max(30, Math.min(480, Math.ceil(durationSec)))),
    ], {
      cwd: process.env.ANIFACTORY_ACE_STEP_ROOT ?? "/Users/joel/AniFactoryTools/ACE-Step-1.5",
      maxBuffer: 1024 * 1024 * 10,
      env: { ...process.env },
    });
    const localResult = JSON.parse(stdout.trim().split(/\n/).at(-1));
    const result = { chapter_id: chapter.chapter_id, provider: scoreMeta.provider, model_id: scoreMeta.model_id, lm_model_id: scoreMeta.lm_model_id ?? null, endpoint: scoreMeta.endpoint, asset_path: outPath, duration_sec: await mediaDuration(outPath), prompt, prompt_hash: promptHash, status: "generated", local_generation: localResult };
    await writeJson(metaPath, result);
    return result;
  }
  console.error(`[longform-audio] score ${chapter.chapter_id} ${durationSec}s`);
  const initial = await postModelslab("/api/v6/voice/music_gen", {
    model_id: "ai-music-generator",
    prompt,
    duration: Math.max(30, Math.min(480, Math.ceil(durationSec))),
    bitrate: "320k",
    output_format: "wav",
    track_id: `${episode}-${chapter.chapter_id}-${Date.now()}`,
  }, `${chapter.chapter_id} score`, 1);
  const resolved = await resolveModelslabAudio(initial, "/api/v6/voice/fetch", `${chapter.chapter_id} score`);
  const url = await downloadAudio(audioLinks(resolved), outPath);
  const result = { chapter_id: chapter.chapter_id, provider: "modelslab", model_id: "ai-music-generator", endpoint: "/api/v6/voice/music_gen", asset_path: outPath, duration_sec: await mediaDuration(outPath), prompt, prompt_hash: promptHash, request_id: initial.id ?? resolved.id ?? null, url, status: "generated" };
  await writeJson(metaPath, result);
  return result;
}

async function generateScoreDrop(drop) {
  await fs.mkdir(scoreDropDir, { recursive: true });
  const prompt = `${drop.ace_step_prompt ?? drop.music_prompt ?? drop.score_intent ?? "short cinematic anime recap riser hit accent"}. Instrumental only, no vocals, no lyrics, no speech, no crowd noise. Short dramatic riser hit that blends into a background score bed.`;
  const promptHash = hashText(prompt).slice(0, 12);
  const dropId = slug(drop.drop_id ?? drop.event_id ?? `score_drop_${Math.round(Number(drop.start_sec ?? 0) * 1000)}`);
  const outPath = path.join(scoreDropDir, `${dropId}-${promptHash}.wav`);
  const metaPath = outPath.replace(/\.wav$/, ".json");
  if (!forceScoreDrops && drop.asset_path && await exists(drop.asset_path)) {
    return {
      drop_id: dropId,
      provider: drop.asset_provider ?? "local_ace_step",
      model_id: drop.asset_model_id ?? process.env.ANIFACTORY_ACE_STEP_CONFIG_PATH ?? "acestep-v15-turbo",
      lm_model_id: drop.asset_lm_model_id ?? process.env.ANIFACTORY_ACE_STEP_LM_MODEL ?? "acestep-5Hz-lm-1.7B",
      endpoint: drop.asset_endpoint ?? "local:ace-step-1.5",
      asset_path: drop.asset_path,
      status: "reused_planned_asset",
      prompt,
      prompt_hash: promptHash,
      duration_sec: await mediaDuration(drop.asset_path).catch(() => Number(drop.duration_sec ?? 6)),
    };
  }
  if (!forceScoreDrops && await exists(outPath)) {
    return { ...await readJson(metaPath, {}), drop_id: dropId, asset_path: outPath, status: "reused" };
  }
  if (dryRun) {
    return {
      drop_id: dropId,
      provider: "local_ace_step",
      model_id: process.env.ANIFACTORY_ACE_STEP_CONFIG_PATH ?? "acestep-v15-turbo",
      lm_model_id: process.env.ANIFACTORY_ACE_STEP_LM_MODEL ?? "acestep-5Hz-lm-1.7B",
      endpoint: "local:ace-step-1.5",
      asset_path: outPath,
      status: "dry_run",
      prompt,
      prompt_hash: promptHash,
      duration_sec: Number(drop.duration_sec ?? 6),
    };
  }
  console.error(`[longform-audio] ACE-Step score drop ${dropId} ${drop.duration_sec ?? 6}s`);
  const { stdout } = await execFile(process.env.ANIFACTORY_ACE_STEP_PYTHON ?? "/Users/joel/AniFactoryTools/ACE-Step-1.5/.venv/bin/python", [
    path.join(repoRoot, "scripts", "ace-step-score-generate.py"),
    "--output", outPath,
    "--caption", prompt,
    "--duration", "30",
  ], {
    cwd: process.env.ANIFACTORY_ACE_STEP_ROOT ?? "/Users/joel/AniFactoryTools/ACE-Step-1.5",
    maxBuffer: 1024 * 1024 * 10,
    env: { ...process.env },
  });
  const localResult = JSON.parse(stdout.trim().split(/\n/).at(-1));
  const result = {
    drop_id: dropId,
    provider: "local_ace_step",
    model_id: process.env.ANIFACTORY_ACE_STEP_CONFIG_PATH ?? "acestep-v15-turbo",
    lm_model_id: process.env.ANIFACTORY_ACE_STEP_LM_MODEL ?? "acestep-5Hz-lm-1.7B",
    endpoint: "local:ace-step-1.5",
    asset_path: outPath,
    duration_sec: await mediaDuration(outPath),
    prompt,
    prompt_hash: promptHash,
    status: "generated",
    local_generation: localResult,
  };
  await writeJson(metaPath, result);
  return result;
}

function segmentStarts(qwenReport) {
  const starts = new Map();
  let cursor = 0;
  for (const segment of qwenReport.segments ?? []) {
    starts.set(String(segment.segment_id), cursor);
    cursor += Number(segment.duration_sec ?? segment.raw_audio_duration_sec ?? 0);
  }
  return starts;
}

function allSfxEvents(sfxPlan) {
  return [
    ...(sfxPlan.resolved_events ?? []),
    ...(sfxPlan.explicit_sound_design_resolutions ?? []),
  ].filter((event) => event?.asset_path);
}

function preferredSfxAsset(cue) {
  return cue?.assets?.find((asset) => asset.asset_id === cue.preferred_asset_id)
    ?? [...(cue?.assets ?? [])].reverse().find((asset) => asset?.path)
    ?? null;
}

async function latestSfxAssetByCueId() {
  const manifest = await readJson(sfxBankManifestPath, { cues: {} });
  const entries = new Map();
  for (const [cueId, cue] of Object.entries(manifest.cues ?? {})) {
    const asset = preferredSfxAsset(cue);
    if (asset?.path) entries.set(cueId, asset);
  }
  return entries;
}

function eventStartSec(event, starts) {
  const absolute = firstFiniteNumber([
    event?.absolute_start_sec,
    event?.timeline_start_sec,
    event?.start_sec,
    event?.start_time_sec,
  ]);
  if (absolute !== null) return Math.max(0, absolute);
  const segmentStart = event.segment_id && starts.has(String(event.segment_id))
    ? starts.get(String(event.segment_id))
    : 0;
  const offset = Number.isFinite(Number(event.offset_sec)) ? Number(event.offset_sec) : 0;
  return Math.max(0, segmentStart + offset);
}

async function ensureSfxEvents(sfxPlan) {
  const cueIds = [...new Set(allSfxEvents(sfxPlan).map((event) => event.cue_id).filter(Boolean))];
  const ensured = [];
  for (const cueId of cueIds) {
    if (!forceSfx) {
      ensured.push({ cue_id: cueId, status: "existing_or_bank_resolved" });
      continue;
    }
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(repoRoot, "scripts", "sfx-generate.mjs"), "generate", "--cue", cueId, "--provider", "modelslab_sound_effect", "--duration", "3", "--prefer", "true"], { cwd: repoRoot, stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`sfx-generate failed for ${cueId}`)));
    });
    ensured.push({ cue_id: cueId, status: "regenerated_modelslab_sfx" });
  }
  return ensured;
}

function eventsWithLockedSfxAssets(sfxPlan) {
  return allSfxEvents(sfxPlan).map((event) => {
    const lockedPath = event.locked_asset_path ?? event.asset_path;
    return {
      ...event,
      asset_path: lockedPath,
      locked_asset_path: lockedPath,
      asset_resolution_mode: lockedPath ? "locked_event_asset" : "missing_locked_event_asset",
    };
  });
}

function validateScorePlanForProduction(scorePlan) {
  if (scorePlan?.planner !== "llm_audio_enrichment_v1") {
    throw new Error("Refusing longform audio mix: score_chapter_plan.json is not an llm_audio_enrichment_v1 beat-mapped plan. Deterministic/windowed score plans are seed-only and must not feed music generation.");
  }
  if (scorePlan?.timing_source !== "local_whisper_word_timing" || scorePlan?.timing_gate?.status !== "passed") {
    throw new Error("Refusing longform audio mix: score_chapter_plan.json was not planned from current local Whisper timing. Rerun `audio whisper-timing` after final stitched narration, then rerun `audio enrich-sfx-score`.");
  }
  const chapters = Array.isArray(scorePlan?.chapters) ? scorePlan.chapters : [];
  const missingTiming = chapters.filter((chapter) => !Number.isFinite(Number(chapter.start_sec)) || !Number.isFinite(Number(chapter.end_sec)));
  if (missingTiming.length) {
    throw new Error(`Refusing longform audio mix: score chapters missing absolute timing: ${missingTiming.map((chapter) => chapter.chapter_id ?? "unknown").join(", ")}`);
  }
}

function validateSfxPlanForProduction(sfxPlan) {
  if (sfxPlan?.planner !== "llm_audio_enrichment_v1") {
    throw new Error("Refusing longform audio mix: SFX event plan is not an llm_audio_enrichment_v1 plan. Regex SFX resolution is diagnostic/seed-only.");
  }
  if (sfxPlan?.timing_source !== "local_whisper_word_timing" || sfxPlan?.timing_gate?.status !== "passed") {
    throw new Error("Refusing longform audio mix: SFX event plan was not planned from current local Whisper timing. Rerun `audio whisper-timing` after final stitched narration, then rerun `audio enrich-sfx-score`.");
  }
  const events = allSfxEvents(sfxPlan);
  const unresolvedAssets = events.filter((event) => !(event.locked_asset_path ?? event.asset_path));
  if (unresolvedAssets.length) {
    throw new Error(`Refusing longform audio mix: SFX events missing locked asset paths: ${unresolvedAssets.slice(0, 12).map((event) => event.event_id ?? event.cue_id ?? "unknown").join(", ")}`);
  }
  const unresolvedTiming = events.filter((event) => {
    if (Number.isFinite(Number(event.absolute_start_sec ?? event.timeline_start_sec ?? event.start_sec ?? event.start_time_sec))) return false;
    return !(event.segment_id && Number.isFinite(Number(event.offset_sec)));
  });
  if (unresolvedTiming.length) {
    throw new Error(`Refusing longform audio mix: SFX events missing absolute timing or segment-relative fallback timing: ${unresolvedTiming.slice(0, 12).map((event) => event.event_id ?? event.cue_id ?? "unknown").join(", ")}`);
  }
}

function validateScoreDropPlanForProduction(scoreDropPlan, scorePlan) {
  if (!scoreDropPlan) return;
  if (scoreDropPlan.status !== "passed") {
    throw new Error(`Refusing longform audio mix: score drop plan is ${scoreDropPlan.status ?? "missing_status"}.`);
  }
  if (scoreDropPlan.source_script_hash && scoreDropPlan.source_script_hash !== scorePlan.source_script_hash) {
    throw new Error("Refusing longform audio mix: score drop plan script hash does not match score_chapter_plan.json.");
  }
  if (scoreDropPlan.timing_source && scoreDropPlan.timing_source !== "local_whisper_word_timing") {
    throw new Error("Refusing longform audio mix: score drop plan must use local Whisper timing.");
  }
  const missingTiming = (scoreDropPlan.drops ?? []).filter((drop) => !Number.isFinite(Number(drop.start_sec)) || !Number.isFinite(Number(drop.duration_sec)));
  if (missingTiming.length) {
    throw new Error(`Refusing longform audio mix: score drops missing absolute start_sec/duration_sec: ${missingTiming.slice(0, 12).map((drop) => drop.drop_id ?? "unknown").join(", ")}`);
  }
}

async function mixLongform({ narrationPath, scoreRows, scorePlan, scoreDropPlan, scoreDropRows, sfxPlan, durationSec, qwenReport }) {
  await fs.mkdir(mixDir, { recursive: true });
  const wavPath = path.join(mixDir, `${outputBase}.wav`);
  const m4aPath = path.join(mixDir, `${outputBase}.m4a`);
  const starts = segmentStarts(qwenReport);
  const chapters = activeChapters(scorePlan, durationSec);
  const scoreDrops = activeScoreDrops(scoreDropPlan, durationSec);
  const events = eventsWithLockedSfxAssets(sfxPlan);
  const existingEvents = [];
  const inputs = ["-i", narrationPath];
  const filters = [`[0:a]volume=${narrationVolumeDb}dB[narr]`];
  const labels = ["[narr]"];
  let inputIndex = 1;

  for (const chapter of chapters) {
    const score = scoreRows.find((row) => row.chapter_id === chapter.chapter_id);
    if (!score?.asset_path || !(await exists(score.asset_path))) continue;
    const start = Number(chapter.start_sec ?? 0);
    const end = Math.min(durationSec, Number(chapter.end_sec ?? start + 180));
    const chapterDuration = Math.max(0.5, end - start);
    const gain = Number.isFinite(Number(chapter.gain_db)) ? Number(chapter.gain_db) : scoreVolumeDb;
    inputs.push("-stream_loop", "-1", "-i", score.asset_path);
    const label = `score${inputIndex}`;
    const delay = Math.max(0, Math.round(start * 1000));
    filters.push(`[${inputIndex}:a]atrim=0:${chapterDuration.toFixed(3)},asetpts=PTS-STARTPTS,${scoreVolumeFilter(gain, start, end, scoreDrops)},adelay=${delay}|${delay}[${label}]`);
    labels.push(`[${label}]`);
    inputIndex += 1;
  }

  for (const drop of scoreDrops) {
    const scoreDrop = scoreDropRows.find((row) => row.drop_id === slug(drop.drop_id ?? drop.event_id ?? `score_drop_${Math.round(Number(drop.start_sec ?? 0) * 1000)}`));
    if (!scoreDrop?.asset_path || !(await exists(scoreDrop.asset_path))) continue;
    const start = Number(drop.start_sec ?? 0);
    if (maxDurationSec && start >= maxDurationSec) continue;
    const dropDuration = Math.max(0.5, Math.min(Number(drop.duration_sec ?? 6), durationSec - start));
    const gain = Number.isFinite(Number(drop.gain_db)) ? Number(drop.gain_db) : scoreDropVolumeDb;
    inputs.push("-i", scoreDrop.asset_path);
    const label = `scoreDrop${inputIndex}`;
    const delay = Math.max(0, Math.round(start * 1000));
    const fadeOutStart = Math.max(0, dropDuration - 0.35);
    filters.push(`[${inputIndex}:a]atrim=0:${dropDuration.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.120,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.350,volume=${gain}dB,adelay=${delay}|${delay}[${label}]`);
    labels.push(`[${label}]`);
    inputIndex += 1;
  }

  for (const event of events) {
    if (!event.asset_path || !(await exists(event.asset_path))) continue;
    existingEvents.push(event);
    const start = eventStartSec(event, starts);
    if (maxDurationSec && start >= maxDurationSec) continue;
    const eventDuration = event.loop ? Math.max(0.5, (Number(event.duration_sec) || durationSec) - start) : Math.max(0.25, Number(event.duration_sec ?? 3));
    const gain = (Number.isFinite(Number(event.gain_db)) ? Number(event.gain_db) : -18) + sfxVolumeBoostDb;
    if (event.loop) inputs.push("-stream_loop", "-1");
    inputs.push("-i", event.asset_path);
    const label = `sfx${inputIndex}`;
    const delay = Math.max(0, Math.round(start * 1000));
    filters.push(`[${inputIndex}:a]atrim=0:${Math.min(eventDuration, durationSec).toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain}dB,adelay=${delay}|${delay}[${label}]`);
    labels.push(`[${label}]`);
    inputIndex += 1;
  }

  filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,alimiter=limit=0.98[aout]`);
  await execFile("ffmpeg", ["-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "[aout]", "-t", durationSec.toFixed(3), "-ar", "44100", "-ac", "2", "-acodec", "pcm_s16le", wavPath], { maxBuffer: 1024 * 1024 * 32 });
  await execFile("ffmpeg", ["-y", "-i", wavPath, "-c:a", "aac", "-b:a", "192k", m4aPath], { maxBuffer: 1024 * 1024 * 8 });
  return {
    wav_path: wavPath,
    m4a_path: m4aPath,
    duration_sec: await mediaDuration(wavPath),
    score_input_count: scoreRows.length,
    score_drop_input_count: scoreDropRows.length,
    score_drop_event_count: scoreDrops.length,
    score_drop_mix_policy: "Short local ACE-Step accents are faded in/out and normal score beds are ducked during overlapping drop windows.",
    sfx_input_count: existingEvents.length,
    sfx_event_count: events.length,
    sfx_asset_resolution_policy: "locked_event_asset_path_only_no_bank_repick",
    sfx_locked_event_count: existingEvents.filter((event) => event.asset_resolution_mode === "locked_event_asset").length,
    sfx_missing_asset_count: events.length - existingEvents.length,
  };
}

async function start() {
  const [scorePlan, scoreDropPlan, sfxPlan, qwenReport] = await Promise.all([
    readJson(scorePlanPath, null),
    readJson(scoreDropPlanPath, null),
    readJson(sfxPlanPath, null),
    readJson(qwenReportPath, null),
  ]);
  if (!skipScore && !scorePlan?.chapters?.length) throw new Error(`Missing score chapters: ${scorePlanPath}`);
  if (!sfxPlan) throw new Error(`Missing SFX event plan: ${sfxPlanPath}`);
  if (!skipScore) {
    validateScorePlanForProduction(scorePlan);
    validateScoreDropPlanForProduction(scoreDropPlan, scorePlan);
  }
  validateSfxPlanForProduction(sfxPlan);
  const narrationPath = flags.narration ?? qwenReport?.output_path;
  if (!narrationPath || !(await exists(narrationPath))) throw new Error(`Missing narration audio. Pass --narration or create ${qwenReportPath}`);
  const narrationDuration = await mediaDuration(narrationPath);
  const durationSec = maxDurationSec > 0 ? Math.min(maxDurationSec, narrationDuration) : narrationDuration;
  const chapters = skipScore ? [] : activeChapters(scorePlan, durationSec);
  const scoreRows = [];
  for (const chapter of chapters) {
    const start = Number(chapter.start_sec ?? 0);
    const end = Math.min(durationSec, Number(chapter.end_sec ?? start + Number(chapter.target_duration_sec ?? 180)));
    scoreRows.push(await generateScoreChapter(chapter, Math.max(30, end - start)));
  }
  const scoreDropRows = [];
  for (const drop of (skipScore ? [] : activeScoreDrops(scoreDropPlan, durationSec))) {
    scoreDropRows.push(await generateScoreDrop(drop));
  }
  const sfxEnsured = await ensureSfxEvents(sfxPlan);
  const mix = dryRun ? null : await mixLongform({ narrationPath, scoreRows, scorePlan: scorePlan ?? { chapters: [] }, scoreDropPlan: skipScore ? null : scoreDropPlan, scoreDropRows, sfxPlan, durationSec, qwenReport });
  const scoreMeta = scoreProviderMeta();
  const report = {
    status: dryRun ? "dry_run" : "completed",
    created_at: new Date().toISOString(),
    channel,
    series,
    week,
    episode,
    provider: scoreMeta.provider === "local_ace_step" ? "local-ace-step-plus-modelslab-sfx" : "modelslab-inhouse",
    skip_score: skipScore,
    score_provider: scoreMeta.provider,
    score_model_id: scoreMeta.model_id,
    score_lm_model_id: scoreMeta.lm_model_id ?? null,
    score_endpoint: scoreMeta.endpoint,
    sfx_model_id: "sfx",
    sfx_endpoint: "/api/v6/voice/sfx",
    narration_path: narrationPath,
    narration_duration_sec: narrationDuration,
    mixed_duration_sec: mix?.duration_sec ?? durationSec,
    score_chapter_plan_path: skipScore ? null : scorePlanPath,
    score_drop_plan_path: !skipScore && scoreDropPlan ? scoreDropPlanPath : null,
    sfx_event_plan_path: sfxPlanPath,
    score_chapters: scoreRows,
    score_drops: scoreDropRows,
    sfx_ensured: sfxEnsured,
    mix,
  };
  const reportPath = path.join(episodeDir, `longform_audio_bed_report_${episode}${reportSuffix}.json`);
  await writeJson(reportPath, report);
  console.log(JSON.stringify({ status: report.status, report_path: reportPath, mix }, null, 2));
}

async function status() {
  const reportPath = path.join(episodeDir, `longform_audio_bed_report_${episode}${reportSuffix}.json`);
  console.log(JSON.stringify(await readJson(reportPath, { status: "missing", report_path: reportPath }), null, 2));
}

if (command === "status") await status();
else if (command === "start") await start();
else {
  console.log(`Usage:
  node scripts/modelslab-longform-audio-bed.mjs start --channel 53rebirth --week current --episode ep_01
  node scripts/modelslab-longform-audio-bed.mjs status --channel 53rebirth --week current --episode ep_01`);
}
