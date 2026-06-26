#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCb);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));

const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const ambienceMinCount = Number(flags["ambience-min-count"] ?? process.env.ANIFACTORY_AUDIO_REPAIR_AMBIENCE_MIN_COUNT ?? 18);
const concurrency = Math.max(1, Math.min(5, Number(flags.concurrency ?? process.env.ANIFACTORY_AUDIO_REPAIR_CONCURRENCY ?? 3)));
const dryRun = flags["dry-run"] === "true";

const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const sfxAssetDir = path.join(dataRoot, "sfx_bank", "assets", "llm_enriched");
const sfxManifestPath = path.join(dataRoot, "sfx_bank", "sfx_manifest.json");
const sfxPlanPath = path.join(episodeDir, `sfx_event_plan_${episode}.json`);
const enrichmentReportPath = path.join(episodeDir, `audio_enrichment_report_${episode}.json`);
const qwenReportPath = path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
const wordTimingPath = path.join(episodeDir, `narration_word_timing_${episode}.json`);
const timedScenePlanPath = path.join(episodeDir, "timed_scene_plan.json");
const scoreDropPlanPath = path.join(episodeDir, `score_drop_plan_${episode}.json`);
const repairReportPath = path.join(episodeDir, `audio_ambience_repair_report_${episode}.json`);

const repairPlanner = "codex_agent_manual_ambience_repair_v1";

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

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath) {
  return fs.readFile(filePath).then((buffer) => sha256(buffer)).catch(() => null);
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

function slug(value, fallback = "ambience") {
  return String(value ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || fallback;
}

async function apiKey() {
  if (process.env.MODELSLAB_API_KEY || process.env.API_KEY) return process.env.MODELSLAB_API_KEY || process.env.API_KEY;
  const { stdout: listStdout } = await execFile("modelslab", ["keys", "list", "-o", "json", "--no-color", "--no-update-check"], { cwd: repoRoot, maxBuffer: 1024 * 1024 });
  const keys = JSON.parse(listStdout)?.data?.items ?? [];
  const selected = keys.find((key) => key.is_default === 1 || key.is_default === true) ?? keys[0];
  if (!selected?.id) throw new Error("No ModelsLab API key available.");
  const { stdout: detailStdout } = await execFile("modelslab", ["keys", "get", "--id", String(selected.id), "-o", "json", "--no-color", "--no-update-check"], { cwd: repoRoot, maxBuffer: 1024 * 1024 });
  const key = JSON.parse(detailStdout)?.data?.key;
  if (!key) throw new Error(`Could not read ModelsLab key ${selected.id}.`);
  return key;
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
      if (attempt <= retries) await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    }
  }
  throw lastError;
}

function audioLinks(response) {
  return [
    ...(Array.isArray(response?.output) ? response.output : []),
    ...(Array.isArray(response?.proxy_links) ? response.proxy_links : []),
    ...(Array.isArray(response?.future_links) ? response.future_links : []),
  ].filter(Boolean);
}

async function resolveAudio(initial, fetchEndpoint, label) {
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
        try {
          await execFile("ffmpeg", ["-y", "-i", tmp, "-ar", "44100", "-ac", "2", "-acodec", "pcm_s16le", outputPath], { maxBuffer: 1024 * 1024 * 16 });
        } catch {
          await execFile("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@44100", tmp, outputPath], { maxBuffer: 1024 * 1024 * 16 });
        }
        await fs.rm(tmp, { force: true }).catch(() => {});
        return url;
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000 * round));
  }
  throw lastError ?? new Error(`Could not download audio to ${outputPath}`);
}

async function mediaDuration(filePath) {
  const { stdout } = await execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath]);
  return Number(stdout.trim());
}

async function validateAudioAsset(filePath, targetDurationSec) {
  const stat = await fs.stat(filePath).catch(() => null);
  const duration = stat ? await mediaDuration(filePath).catch(() => null) : null;
  const issues = [];
  if (!stat || stat.size < 2048) issues.push("asset_missing_or_too_small");
  if (!Number.isFinite(duration) || duration <= 0) issues.push("duration_unreadable");
  if (Number.isFinite(duration) && duration < 0.2) issues.push("duration_too_short");
  if (Number.isFinite(duration) && duration > Math.max(3, Number(targetDurationSec) * 2.5)) issues.push("duration_too_long");
  return {
    status: issues.length ? "failed" : "passed",
    issues,
    file_size_bytes: stat?.size ?? 0,
    duration_sec: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null,
    target_duration_sec: Number.isFinite(Number(targetDurationSec)) ? Number(Number(targetDurationSec).toFixed(3)) : null,
    technical_gate: "file exists, decodes with ffprobe, size/duration sane; operator spot-listen still required for semantic fit",
  };
}

async function loadManifest() {
  const manifest = await readJson(sfxManifestPath, null);
  if (manifest) {
    manifest.cues = Array.isArray(manifest.cues)
      ? Object.fromEntries(manifest.cues.filter(Boolean).map((cue) => [slug(cue.cue_id ?? cue.id ?? cue.name, "cue"), cue]))
      : (manifest.cues ?? {});
    return manifest;
  }
  return {
    schema_version: 1,
    bank_dir: path.join(dataRoot, "sfx_bank"),
    created_at: nowIso(),
    updated_at: nowIso(),
    cues: {},
  };
}

async function saveManifest(manifest) {
  manifest.updated_at = nowIso();
  await writeJson(sfxManifestPath, manifest);
}

async function generateAmbienceAsset(event) {
  const cueId = slug(event.cue_id ?? event.sound_description, "ambience");
  const duration = Math.max(8, Math.min(12, Number(event.asset_duration_sec ?? 10) || 10));
  const prompt = `${event.sound_description}. ${event.palette_note ?? ""} Loopable nonmusical ambience bed, no melody, no rhythm, no vocals, no speech, no crowd dialogue.`;
  const outDir = path.join(sfxAssetDir, cueId);
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${cueId}-${sha256(`${prompt}:${duration}`).slice(0, 12)}.wav`);
  if (!dryRun && !(await exists(outPath))) {
    const initial = await postModelslab("/api/v7/voice/sound-generation", {
      model_id: "eleven_sound_effect",
      prompt,
      duration: Math.round(duration),
      track_id: `${episode}-${cueId}-${Date.now()}`,
    }, `${cueId} ambience`, 2);
    const resolved = await resolveAudio(initial, "/api/v7/voice/fetch", `${cueId} ambience`);
    const url = await downloadAudio(audioLinks(resolved), outPath);
    const validation = await validateAudioAsset(outPath, duration);
    return { outPath, prompt, duration, request_id: initial.id ?? resolved.id ?? null, url, validation };
  }
  const validation = dryRun
    ? { status: "dry_run", issues: [], target_duration_sec: duration, technical_gate: "dry run; asset not generated" }
    : await validateAudioAsset(outPath, duration);
  return { outPath, prompt, duration, request_id: null, url: null, validation };
}

async function registerGeneratedAmbience(manifest, event, generation) {
  const cueId = slug(event.cue_id ?? event.sound_description, "ambience");
  const fileHash = await hashFile(generation.outPath);
  manifest.cues[cueId] ??= {
    cue_id: cueId,
    aliases: [event.sound_description].filter(Boolean),
    queries: [event.sound_description, event.beat_reason].filter(Boolean),
    generation_prompt: generation.prompt,
    default_duration_sec: generation.duration,
    assets: [],
    preferred_asset_id: null,
  };
  const cue = manifest.cues[cueId];
  const assetId = `${cueId}_${String(fileHash ?? sha256(generation.prompt)).slice(0, 10)}`;
  const asset = {
    asset_id: assetId,
    cue_id: cueId,
    path: generation.outPath,
    sha256: fileHash,
    source: "modelslab_voice_sfx",
    provider: "modelslab_sound_generation",
    model: "eleven_sound_effect",
    endpoint: "/api/v7/voice/sound-generation",
    downloaded_url: generation.url,
    request_id: generation.request_id,
    prompt: generation.prompt,
    prompt_hash: sha256(generation.prompt),
    duration_sec: generation.validation.duration_sec ?? generation.duration,
    license: "generated_internal_test",
    model_license_note: "Generated with ModelsLab sound-generation model through /api/v7/voice/sound-generation; observed billing remains ledger-governed.",
    generated_at: nowIso(),
    status: generation.validation.status === "passed" ? "available" : "needs_regeneration",
    validation: generation.validation,
    llm_enrichment: {
      planner: repairPlanner,
      source_episode: { channel, series, week, episode },
      cue_intent: event.sound_description,
      beat_reason: event.beat_reason,
      recurrence_class: "ambience",
    },
  };
  cue.assets = [...(cue.assets ?? []).filter((existing) => existing.asset_id !== assetId), asset];
  if (asset.status === "available") cue.preferred_asset_id = assetId;
  return asset;
}

function sceneMap(timedScenePlan) {
  const scenes = timedScenePlan?.scenes ?? timedScenePlan?.timed_scenes ?? [];
  return new Map(scenes.map((scene) => [String(scene.scene_id), scene]));
}

function spanForScenes(scenes, ids) {
  const rows = ids.map((id) => scenes.get(id)).filter(Boolean);
  if (!rows.length) return null;
  const start = Math.min(...rows.map((row) => Number(row.start_sec)));
  const end = Math.max(...rows.map((row) => Number(row.end_sec)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

function segmentSpans(qwenReport) {
  const spans = [];
  let cursor = 0;
  for (const segment of qwenReport?.segments ?? []) {
    const duration = Number(segment.duration_sec ?? segment.raw_audio_duration_sec ?? 0);
    spans.push({ id: String(segment.segment_id), start: cursor, end: cursor + duration });
    cursor += duration;
  }
  return spans;
}

function segmentAtTime(spans, seconds) {
  return spans.find((span) => seconds >= span.start && seconds < span.end) ?? spans.at(-1) ?? { id: "voice_seg_01", start: 0 };
}

function manualAmbienceSpecs() {
  return [
    { scene_ids: ["scene_002"], cue_id: "northbridge_stadium_afterglow", gain_db: -33, sound_description: "cool empty stadium night air with distant crowd hush, torn banner cloth flutter, faint arena HVAC", palette_note: "Northbridge aftermath stadium bed", beat_reason: "keeps the post-board-collapse human consequence grounded" },
    { scene_ids: ["scene_003", "scene_004"], cue_id: "wet_curb_black_car_night", gain_db: -32, sound_description: "wet pavement curb tone, soft rain sheen, distant stadium ventilation, quiet idling luxury car engine", palette_note: "curbside black-car recruitment bed", beat_reason: "grounds Montgomery's recruitment in a tense night exterior" },
    { scene_ids: ["scene_007"], cue_id: "capital_arrival_station_city_air", gain_db: -32, sound_description: "large capital train-station air, distant footsteps, clean public address texture without words, soft city electrical hum", palette_note: "arrival into the Royal Capital", beat_reason: "establishes the Capital as a living stage" },
    { scene_ids: ["scene_008"], cue_id: "capital_kiosk_street_bed", gain_db: -31, sound_description: "busy capital sidewalk ambience with soft nonverbal crowd texture, kiosk electronics, distant bid chimes", palette_note: "offering kiosk street bed", beat_reason: "supports the boy at the kiosk without literal Foley under every line" },
    { scene_ids: ["scene_009"], cue_id: "city_screens_watch_back", gain_db: -32, sound_description: "thousand-screen city hum, faint synchronized display buzz, crowd hush wave with no words", palette_note: "the city looks back ambience", beat_reason: "makes the throne's surveillance feel environmental" },
    { scene_ids: ["scene_010"], cue_id: "capital_hotel_room_neon", gain_db: -34, sound_description: "quiet expensive hotel room tone, muted city neon outside glass, soft air conditioning, paper cards on carpet", palette_note: "hotel summons room bed", beat_reason: "leaves room for narration while placing the summons in a real room" },
    { scene_ids: ["scene_011"], cue_id: "aurelia_glass_plaza_crowd_line", gain_db: -31, sound_description: "open glass plaza air with restrained nonverbal crowd line, polished floor footsteps, distant fountain-like city texture", palette_note: "Aurelia public-refusal plaza", beat_reason: "keeps the public refusal surrounded by social pressure" },
    { scene_ids: ["scene_012", "scene_013"], cue_id: "quiet_cafe_table_city_edge", gain_db: -34, sound_description: "quiet cafe terrace room tone, porcelain clinks far away, soft city edge air, no conversation", palette_note: "Mira cafe trap ambience", beat_reason: "supports Mira's subtle trap without music-like ambience" },
    { scene_ids: ["scene_014"], cue_id: "screenless_side_street_night", gain_db: -34, sound_description: "screenless empty side street at night, distant traffic smear, low building air, no voices", palette_note: "black card investigation street", beat_reason: "marks the sudden absence of screens before the gym reveal" },
    { scene_ids: ["scene_015", "scene_016", "scene_017", "scene_018"], cue_id: "screenless_gym_room_tone", gain_db: -32, sound_description: "indoor gym room tone, rubber floor air, distant weight rack clink, heavy training breaths as texture only", palette_note: "Damien screenless gym bed", beat_reason: "places Damien's movement in a physical masculine space without crowd chants overpowering narration" },
    { scene_ids: ["scene_019", "scene_020"], cue_id: "hotel_room_private_night", gain_db: -35, sound_description: "small hotel room night tone, low ventilation, distant city through sealed window, intimate quiet", palette_note: "Lily test and unperformed affection", beat_reason: "lets the quiet ally test and hand connection breathe" },
    { scene_ids: ["scene_021"], cue_id: "citywide_screen_attack_hum", gain_db: -31, sound_description: "citywide propaganda screen hum, cold digital glitch bed, distant crowd unease with no words", palette_note: "frame-theft broadcast attack", beat_reason: "turns the smear campaign into an ambient pressure layer" },
    { scene_ids: ["scene_022", "scene_023", "scene_024"], cue_id: "damaged_hotel_strategy_room", gain_db: -34, sound_description: "damaged hotel room tone with broken window air, faint glass tick, laptop fan, distant city siren smear", palette_note: "truth-strategy and tower invitation", beat_reason: "grounds Caleb's damaged room and the tower strategy" },
    { scene_ids: ["scene_025", "scene_026"], cue_id: "procession_light_path_city", gain_db: -32, sound_description: "wide city night procession air, low electric light shimmer, restrained crowd hush, no speech", palette_note: "path of light to the throne tower", beat_reason: "gives the walk to the tower ceremonial scale" },
    { scene_ids: ["scene_027"], cue_id: "glass_lift_tower_air", gain_db: -34, sound_description: "glass elevator tower air, cable-soft motion, high-altitude building hum, distant city below", palette_note: "glass lift ascent", beat_reason: "keeps the climb quiet and tense before Vivienne" },
    { scene_ids: ["scene_028", "scene_029", "scene_030", "scene_031"], cue_id: "throne_room_screen_wall_air", gain_db: -32, sound_description: "vast throne room made of screens, cold display wall hum, polished stone air, faint electrical pressure", palette_note: "Vivienne gentle offer throne room", beat_reason: "holds the final-boss room under the quiet logical temptation" },
    { scene_ids: ["scene_032", "scene_033", "scene_034", "scene_035"], cue_id: "national_broadcast_silence", gain_db: -33, sound_description: "massive broadcast silence, billion-screen electrical bed, distant crowd held breath, no words", palette_note: "nation decides and third option", beat_reason: "supports the national trap without turning it into score" },
    { scene_ids: ["scene_036", "scene_037", "scene_038"], cue_id: "belief_collapse_screen_flicker", gain_db: -31, sound_description: "screen-wall flicker and belief collapse ambience, soft glitch waves, tired room air, no voices", palette_note: "Sarah confession and Vivienne becomes human", beat_reason: "makes belief failure audible while staying nonmusical" },
    { scene_ids: ["scene_039", "scene_040"], cue_id: "capital_after_throne_street_air", gain_db: -32, sound_description: "capital street after midnight, screens dimming, people murmuring nonverbally at distance, cool city air", palette_note: "city learning to look at itself", beat_reason: "shows the city remains alive after the throne is abandoned" },
    { scene_ids: ["scene_041"], cue_id: "damien_warning_empty_street", gain_db: -34, sound_description: "empty capital street night tone, distant footsteps, cold tower wind, low urban hush", palette_note: "Damien diminished warning", beat_reason: "isolates Damien's warning after the crowd leaves him" },
    { scene_ids: ["scene_042", "scene_043"], cue_id: "hotel_rooftop_stars_city", gain_db: -35, sound_description: "hotel rooftop night air, soft wind, distant quiet city, stars over dim screens", palette_note: "Sarah becomes nobody on the roof", beat_reason: "supports the reflective roof ending before the next hook" },
    { scene_ids: ["scene_044", "scene_045"], cue_id: "federation_cliffhanger_system_air", gain_db: -32, sound_description: "distant futuristic system hum under night sky, far-off tower resonance, cold digital horizon air", palette_note: "Federation and other transmigrator tease", beat_reason: "extends the final cliffhanger into the next arc" },
  ];
}

function buildRepairEvents({ timedScenePlan, qwenReport, wordTiming, sfxPlan }) {
  const scenes = sceneMap(timedScenePlan);
  const spans = segmentSpans(qwenReport);
  const sourceScriptHash = sfxPlan.source_script_hash ?? wordTiming?.source_script_hash ?? null;
  return manualAmbienceSpecs().map((spec, index) => {
    const span = spanForScenes(scenes, spec.scene_ids);
    if (!span) return null;
    const segment = segmentAtTime(spans, span.start);
    const offset = Math.max(0, span.start - segment.start);
    const cueId = slug(spec.cue_id, `ambience_repair_${index + 1}`);
    return {
      event_id: `sfx_ambience_repair_${String(index + 1).padStart(3, "0")}`,
      cue_id: cueId,
      segment_id: segment.id,
      offset_sec: Number(offset.toFixed(3)),
      duration_sec: Number((span.end - span.start).toFixed(3)),
      end_sec: Number(span.end.toFixed(3)),
      asset_duration_sec: 10,
      gain_db: spec.gain_db,
      priority: 4,
      sound_description: spec.sound_description,
      target_phrase: spec.scene_ids.map((id) => scenes.get(id)?.title).filter(Boolean).join(" / "),
      beat_reason: spec.beat_reason,
      recurrence_class: "ambience",
      category: "ambience",
      loop: true,
      palette_note: spec.palette_note,
      source: "modelslab_voice_sfx",
      planner: "llm_audio_enrichment_v1",
      manual_repair: {
        planner: repairPlanner,
        reason: "Original LLM audio enrichment passed asset generation but under-shot AGENTS ambience density target.",
        timing_source: "local_whisper_word_timing",
        scene_ids: spec.scene_ids,
        source_script_hash: sourceScriptHash,
      },
      absolute_start_sec: Number(span.start.toFixed(3)),
      placement_resolution: {
        status: "manual_codex_agent_whisper_timed_scene_span",
        absolute_start_sec: Number(span.start.toFixed(3)),
        absolute_end_sec: Number(span.end.toFixed(3)),
        target_phrase: spec.scene_ids.map((id) => scenes.get(id)?.title).filter(Boolean).join(" / "),
        sanity_envelope_passed: true,
      },
    };
  }).filter(Boolean);
}

function ambienceEvents(events) {
  return events.filter((event) => event.loop === true || event.recurrence_class === "ambience" || event.category === "ambience");
}

function eventStart(event) {
  return Number(event.absolute_start_sec ?? event.timeline_start_sec ?? event.start_sec ?? 0);
}

function refreshQualityGate(events, scoreDropPlan) {
  const openingEvents = events.filter((event) => eventStart(event) < 30);
  const ambience = ambienceEvents(events);
  const issues = [];
  if (ambience.length < ambienceMinCount) issues.push(`ambience_beds_under_target:${ambience.length}<${ambienceMinCount}`);
  return {
    status: issues.length ? "needs_review" : "passed",
    issues,
    opening_30_sec_event_count: openingEvents.length,
    opening_30_sec_events: openingEvents.map((event) => ({
      event_id: event.event_id,
      cue_id: event.cue_id,
      timeline_start_sec: Number(eventStart(event).toFixed(3)),
      target_phrase: event.target_phrase,
      placement_status: event.placement_resolution?.status ?? "manual",
    })),
    ambience_event_count: ambience.length,
    ambience_events: ambience.map((event) => ({
      event_id: event.event_id,
      cue_id: event.cue_id,
      duration_sec: event.duration_sec,
      asset_duration_sec: event.asset_duration_sec,
      gain_db: event.gain_db,
      loop: event.loop === true,
      target_phrase: event.target_phrase,
    })),
    score_drop_count: scoreDropPlan?.drops?.length ?? 0,
  };
}

async function runLimited(items, limit, worker) {
  let cursor = 0;
  const results = [];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
      console.log(`ambience repair ${index + 1}/${items.length}: ${items[index].cue_id}`);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const [sfxPlan, enrichmentReport, qwenReport, wordTiming, timedScenePlan, scoreDropPlan] = await Promise.all([
    readJson(sfxPlanPath, null),
    readJson(enrichmentReportPath, null),
    readJson(qwenReportPath, null),
    readJson(wordTimingPath, null),
    readJson(timedScenePlanPath, null),
    readJson(scoreDropPlanPath, null),
  ]);
  if (!sfxPlan) throw new Error(`Missing SFX plan: ${sfxPlanPath}`);
  if (sfxPlan.timing_source !== "local_whisper_word_timing" || sfxPlan.timing_gate?.status !== "passed") {
    throw new Error("Refusing ambience repair: SFX plan is not stamped with current local Whisper timing.");
  }
  if (!qwenReport?.segments?.length) throw new Error(`Missing Qwen stitch report segments: ${qwenReportPath}`);
  if (!timedScenePlan) throw new Error(`Missing timed scene plan: ${timedScenePlanPath}`);

  const existingEvents = (sfxPlan.events ?? []).filter((event) => event?.manual_repair?.planner !== repairPlanner);
  const existingResolved = (sfxPlan.resolved_events ?? []).filter((event) => event?.manual_repair?.planner !== repairPlanner);
  const repairEvents = buildRepairEvents({ timedScenePlan, qwenReport, wordTiming, sfxPlan });
  const manifest = await loadManifest();
  const generated = await runLimited(repairEvents, concurrency, async (event) => {
    const generation = await generateAmbienceAsset(event);
    const asset = await registerGeneratedAmbience(manifest, event, generation);
    return {
      ...event,
      asset_id: asset.asset_id,
      asset_path: asset.path,
      provider: asset.provider,
      generated_this_run: asset.generated_at?.startsWith(new Date().toISOString().slice(0, 10)) ?? true,
      validation: asset.validation,
      sourcing_decision: {
        decision: (await exists(asset.path)) ? "generated_or_reused_manual_ambience_asset" : "missing_asset",
        reason: "Codex-agent manual ambience repair generated a purpose-made low nonmusical location bed.",
      },
      locked_asset_path: asset.path,
      asset_resolution_mode: "locked_event_asset",
    };
  });
  await saveManifest(manifest);

  const nextEvents = [...existingEvents, ...generated].sort((left, right) => eventStart(left) - eventStart(right));
  const nextResolved = [...existingResolved, ...generated].sort((left, right) => eventStart(left) - eventStart(right));
  const qualityGate = refreshQualityGate(nextResolved, scoreDropPlan);
  const generatedAssetCount = nextResolved.filter((event) => event.generated_this_run || event.manual_repair?.planner === repairPlanner).length;

  const nextSfxPlan = {
    ...sfxPlan,
    status: nextResolved.every((event) => event.asset_path && (event.validation?.status ?? "passed") !== "failed") ? "passed" : "failed",
    events: nextEvents,
    resolved_events: nextResolved,
    resolved_event_count: nextResolved.filter((event) => event.asset_path).length,
    total_resolved_sfx_cue_count: nextResolved.filter((event) => event.asset_path).length,
    generated_asset_count: generatedAssetCount,
    ambience_repair: {
      planner: repairPlanner,
      status: qualityGate.status,
      added_event_count: generated.length,
      ambience_event_count: qualityGate.ambience_event_count,
      repair_report_path: repairReportPath,
      updated_at: nowIso(),
    },
    updated_at: nowIso(),
  };
  await writeJson(sfxPlanPath, nextSfxPlan);

  const nextReport = {
    ...(enrichmentReport ?? {}),
    status: qualityGate.status === "passed" && (enrichmentReport?.score?.quality_gate?.issues ?? []).length === 0 ? "passed" : "needs_review",
    sfx: {
      ...(enrichmentReport?.sfx ?? {}),
      cue_count: nextResolved.length,
      quality_gate: qualityGate,
      generated_asset_count: generatedAssetCount,
      sample_events: nextResolved.slice(0, 12),
    },
    word_timing: {
      ...(enrichmentReport?.word_timing ?? {}),
      resolved_sfx_count: nextResolved.filter((event) => event.asset_path).length,
      fallback_sfx_count: nextResolved.filter((event) => /fallback/i.test(String(event.placement_resolution?.status ?? ""))).length,
    },
    ambience_repair: {
      planner: repairPlanner,
      status: qualityGate.status,
      added_event_count: generated.length,
      ambience_event_count: qualityGate.ambience_event_count,
      repair_report_path: repairReportPath,
    },
    halt: qualityGate.status === "passed"
      ? "Audio enrichment passed after Codex-agent manual ambience repair. Final mix has NOT been produced."
      : "Ambience repair completed but quality gate still needs review. Final mix has NOT been produced.",
    updated_at: nowIso(),
  };
  await writeJson(enrichmentReportPath, nextReport);

  const repairReport = {
    schema: "goldflow_audio_ambience_repair_report_v1",
    status: qualityGate.status,
    channel,
    series_slug: series,
    week,
    episode,
    planner: repairPlanner,
    timing_source: "local_whisper_word_timing",
    source_script_hash: nextSfxPlan.source_script_hash ?? null,
    sfx_plan_path: sfxPlanPath,
    enrichment_report_path: enrichmentReportPath,
    added_event_count: generated.length,
    ambience_event_count: qualityGate.ambience_event_count,
    generated_events: generated.map((event) => ({
      event_id: event.event_id,
      cue_id: event.cue_id,
      absolute_start_sec: event.absolute_start_sec,
      end_sec: event.end_sec,
      duration_sec: event.duration_sec,
      gain_db: event.gain_db,
      asset_path: event.asset_path,
      validation: event.validation,
      scene_ids: event.manual_repair?.scene_ids ?? [],
    })),
    quality_gate: qualityGate,
    dry_run: dryRun,
    updated_at: nowIso(),
  };
  await writeJson(repairReportPath, repairReport);
  console.log(JSON.stringify({ status: qualityGate.status, added_event_count: generated.length, ambience_event_count: qualityGate.ambience_event_count, repair_report_path: repairReportPath }, null, 2));
}

main().catch(async (error) => {
  await writeJson(repairReportPath, { schema: "goldflow_audio_ambience_repair_report_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: nowIso() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
