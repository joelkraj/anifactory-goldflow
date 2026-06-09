#!/usr/bin/env node

import { execFile as execFileCb, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getLLMBaseURL, getLLMModel, isLocalLLMRoute, localLLMAuthHeaders, localLLMChatCompletionURL } from "./lib/llm-router.mjs";

const execFile = promisify(execFileCb);
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname, "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const args = process.argv.slice(2);
const flags = parseFlags(args);

const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const audioDir = path.join(episodeDir, "assets", "audio");
const sfxAssetDir = path.join(dataRoot, "sfx_bank", "assets", "llm_enriched");
const scoreAssetDir = path.join(audioDir, "modelslab_score_beds");
const sfxManifestPath = path.join(dataRoot, "sfx_bank", "sfx_manifest.json");
const scriptPath = path.join(episodeDir, "script_clean.md");
const audioPlanPath = path.join(episodeDir, "audio_performance_plan.json");
const dialogueMapPath = path.join(episodeDir, "dialogue_map.json");
const qwenReportPath = path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
const scorePlanPath = path.join(episodeDir, "score_chapter_plan.json");
const sfxPlanPath = path.join(episodeDir, `sfx_event_plan_${episode}.json`);
const sfxReportPath = path.join(episodeDir, "sfx_resolution_report.json");
const enrichmentReportPath = path.join(episodeDir, `audio_enrichment_report_${episode}.json`);
const wordTimingPath = flags.wordTiming ?? flags["word-timing"] ?? path.join(episodeDir, `narration_word_timing_${episode}.json`);

const plannerVersion = 1;
const plannerName = "llm_audio_enrichment_v1";
const sfxTargetCount = clampInt(flags["sfx-target-count"] ?? process.env.ANIFACTORY_AUDIO_ENRICHMENT_SFX_TARGET_COUNT ?? 60, 24, 90);
const scoreTargetChapters = clampInt(flags["score-target-chapters"] ?? process.env.ANIFACTORY_AUDIO_ENRICHMENT_SCORE_TARGET_CHAPTERS ?? 8, 5, 12);
const generateAssets = flags["generate-assets"] !== "false";
const generateScoreAssets = generateAssets && flags["generate-score-assets"] !== "false";
const generateSfxAssets = generateAssets && flags["generate-sfx-assets"] !== "false";
const dryRun = flags["dry-run"] === "true";
const allowNonWhisperTiming = flags["allow-non-whisper-timing"] === "true"
  || flags["diagnostic-allow-non-whisper-timing"] === "true"
  || process.env.ANIFACTORY_ALLOW_NON_WHISPER_SFX_SCORE_TIMING === "true";

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

function clampInt(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(filePath) {
  return fs.readFile(filePath).then((buffer) => sha256(buffer)).catch(() => null);
}

async function readText(filePath, fallback = "") {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
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

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

function slug(value, fallback = "cue") {
  return String(value ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || fallback;
}

function extractJson(text) {
  const raw = String(text ?? "").trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error(`LLM output did not contain a JSON object: ${raw.slice(0, 600)}`);
}

async function apiKey() {
  if (process.env.MODELSLAB_API_KEY || process.env.API_KEY) return process.env.MODELSLAB_API_KEY || process.env.API_KEY;
  const { stdout: listStdout } = await execFile("modelslab", ["keys", "list", "-o", "json", "--no-color"], { cwd: repoRoot, maxBuffer: 1024 * 1024 });
  const keys = JSON.parse(listStdout)?.data?.items ?? [];
  const selected = keys.find((key) => key.is_default === 1 || key.is_default === true) ?? keys[0];
  if (!selected?.id) throw new Error("No ModelsLab API key available.");
  const { stdout: detailStdout } = await execFile("modelslab", ["keys", "get", "--id", String(selected.id), "-o", "json", "--no-color"], { cwd: repoRoot, maxBuffer: 1024 * 1024 });
  const key = JSON.parse(detailStdout)?.data?.key;
  if (!key) throw new Error(`Could not read ModelsLab key ${selected.id}.`);
  return key;
}

async function modelPolicy() {
  return readJson(path.join(repoRoot, "config", "model-policy.json"), {});
}

function llmContent(json) {
  return json?.choices?.[0]?.message?.content
    ?? json?.choices?.[0]?.text
    ?? json?.data?.choices?.[0]?.message?.content
    ?? json?.output
    ?? json?.message
    ?? "";
}

async function callPlannerLlm(prompt, stageName) {
  if (flags["planner-output"]) {
    const outputPath = path.resolve(String(flags["planner-output"]));
    const content = await readText(outputPath);
    return {
      provider: "codex",
      model: "codex_reused_output",
      promptPath: null,
      outputPath,
      contentPath: outputPath,
      content,
      parsed: extractJson(content),
      retry_attempt: 0,
    };
  }
  if (isLocalLLMRoute(stageName)) return callLocalQwenPlanner(prompt, stageName);
  const provider = String(flags["planner-provider"] ?? process.env.ANIFACTORY_AUDIO_ENRICHMENT_PLANNER_PROVIDER ?? "codex").toLowerCase();
  if (provider !== "modelslab") return callCodexPlanner(prompt, stageName);
  return callModelslabPlanner(prompt, stageName);
}

async function callLocalQwenPlanner(prompt, stageName) {
  const model = getLLMModel(stageName);
  const callDir = path.join(weekDir, "_local_qwen_calls");
  await fs.mkdir(callDir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, "-");
  const promptPath = path.join(callDir, `${stamp}-${stageName}-prompt.md`);
  const outputPath = path.join(callDir, `${stamp}-${stageName}-output.json`);
  const contentPath = path.join(callDir, `${stamp}-${stageName}-content.txt`);
  await fs.writeFile(promptPath, prompt, "utf8");
  const response = await fetch(localLLMChatCompletionURL(stageName), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...localLLMAuthHeaders() },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You are an expert longform anime/manhwa recap sound editor. Return only valid JSON. Match sound and music vocabulary to the provided episode world; do not use hardcoded genre templates.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: Number(flags["llm-max-tokens"] ?? process.env.ANIFACTORY_AUDIO_ENRICHMENT_MAX_TOKENS ?? 18000),
      temperature: Number(flags["llm-temperature"] ?? process.env.ANIFACTORY_AUDIO_ENRICHMENT_TEMPERATURE ?? 0.2),
    }),
    signal: AbortSignal.timeout(Number(process.env.ANIFACTORY_AUDIO_ENRICHMENT_LLM_TIMEOUT_MS ?? 1_200_000)),
  });
  const raw = await response.text();
  await fs.writeFile(outputPath, raw, "utf8");
  if (!response.ok) throw new Error(`local-qwen ${stageName} HTTP ${response.status}: ${raw.slice(0, 1000)}`);
  const json = JSON.parse(raw);
  const content = llmContent(json);
  await fs.writeFile(contentPath, content, "utf8");
  return {
    provider: "local-qwen",
    model,
    base_url: getLLMBaseURL(stageName),
    promptPath,
    outputPath,
    contentPath,
    content,
    parsed: extractJson(content),
    retry_attempt: 0,
  };
}

async function callCodexPlanner(prompt, stageName) {
  const policy = await modelPolicy();
  const model = flags.model
    ?? flags["llm-model"]
    ?? process.env.ANIFACTORY_AUDIO_ENRICHMENT_CODEX_MODEL
    ?? policy.codex?.default_model
    ?? null;
  const reasoningEffort = flags.reasoning
    ?? flags["reasoning-effort"]
    ?? process.env.ANIFACTORY_AUDIO_ENRICHMENT_REASONING
    ?? "medium";
  const callDir = path.join(weekDir, "_codex_calls");
  await fs.mkdir(callDir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, "-");
  const promptPath = path.join(callDir, `${stamp}-${stageName}-prompt.md`);
  const outputPath = path.join(callDir, `${stamp}-${stageName}-output.txt`);
  await fs.writeFile(promptPath, prompt, "utf8");
  const codexArgs = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    repoRoot,
  ];
  if (model) codexArgs.push("-m", model);
  codexArgs.push(
    "-c",
    `model_reasoning_effort="${reasoningEffort}"`,
    "-c",
    'model_verbosity="medium"',
    "-o",
    outputPath,
  );
  const output = await new Promise((resolve, reject) => {
    const child = spawn("codex", codexArgs, {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      reject(new Error(`Codex audio enrichment stage ${stageName} timed out`));
    }, Number(process.env.ANIFACTORY_AUDIO_ENRICHMENT_CODEX_TIMEOUT_MS ?? 1_200_000));
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Codex audio enrichment stage ${stageName} exited ${code}: ${stderr || stdout}`));
        return;
      }
      const text = await fs.readFile(outputPath, "utf8").catch(() => stdout || stderr);
      resolve(text);
    });
    child.stdin.end(prompt);
  });
  return {
    provider: "codex",
    model: model ?? "codex_cli_default",
    promptPath,
    outputPath,
    contentPath: outputPath,
    content: output,
    parsed: extractJson(output),
    retry_attempt: 0,
  };
}

async function callModelslabPlanner(prompt, stageName) {
  const key = await apiKey();
  const policy = await modelPolicy();
  const model = flags.model
    ?? flags["llm-model"]
    ?? process.env.ANIFACTORY_AUDIO_ENRICHMENT_LLM_MODEL
    ?? policy.modelslab?.default_unlimited_llm
    ?? "qwen-qwen3.5-plus-02-15";
  const callDir = path.join(weekDir, "_modelslab_llm_calls");
  await fs.mkdir(callDir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, "-");
  const promptPath = path.join(callDir, `${stamp}-${stageName}-prompt.md`);
  const outputPath = path.join(callDir, `${stamp}-${stageName}-output.json`);
  const contentPath = path.join(callDir, `${stamp}-${stageName}-content.txt`);
  await fs.writeFile(promptPath, prompt, "utf8");
  const body = {
    key,
    model,
    model_id: model,
    messages: [
      {
        role: "system",
        content: "You are an expert longform anime/manhwa recap sound editor. Return only valid JSON. Match sound and music vocabulary to the provided episode world; do not use hardcoded genre templates.",
      },
      { role: "user", content: prompt },
    ],
    max_tokens: Number(flags["llm-max-tokens"] ?? process.env.ANIFACTORY_AUDIO_ENRICHMENT_MAX_TOKENS ?? 18000),
    temperature: Number(flags["llm-temperature"] ?? process.env.ANIFACTORY_AUDIO_ENRICHMENT_TEMPERATURE ?? 0.45),
  };
  const retries = clampInt(flags["llm-retries"] ?? process.env.ANIFACTORY_AUDIO_ENRICHMENT_LLM_RETRIES ?? 3, 0, 6);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const attemptOutputPath = attempt === 0 ? outputPath : outputPath.replace(/\.json$/, `-retry_${attempt}.json`);
    const attemptContentPath = attempt === 0 ? contentPath : contentPath.replace(/\.txt$/, `-retry_${attempt}.txt`);
    try {
      const response = await fetch("https://modelslab.com/api/v7/llm/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.ANIFACTORY_AUDIO_ENRICHMENT_LLM_TIMEOUT_MS ?? 1_200_000)),
      });
      const raw = await response.text();
      await fs.writeFile(attemptOutputPath, raw, "utf8");
      if (!response.ok) throw new Error(`ModelsLab LLM ${stageName} HTTP ${response.status}: ${raw.slice(0, 1000)}`);
      const json = JSON.parse(raw);
      const content = llmContent(json);
      await fs.writeFile(attemptContentPath, content, "utf8");
      const parsed = extractJson(content);
      if (attempt > 0) {
        await fs.copyFile(attemptOutputPath, outputPath);
        await fs.copyFile(attemptContentPath, contentPath);
      }
      return { provider: "modelslab", model, promptPath, outputPath, contentPath, content, parsed, retry_attempt: attempt };
    } catch (error) {
      lastError = error;
      const message = String(error?.message ?? error);
      const retryable = /server error|try again|HTTP 429|HTTP 5\d\d|timeout|aborted|fetch failed|did not contain a JSON object/i.test(message);
      if (!retryable || attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(20_000, 4_000 * (attempt + 1))));
    }
  }
  throw lastError ?? new Error(`ModelsLab LLM ${stageName} failed.`);
}

function audioLinks(response) {
  return [
    ...(Array.isArray(response.output) ? response.output : []),
    ...(Array.isArray(response.proxy_links) ? response.proxy_links : []),
    ...(Array.isArray(response.future_links) ? response.future_links : []),
  ].filter(Boolean);
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
        } catch (error) {
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

async function validateAudioAsset(filePath, targetDurationSec, kind) {
  const stat = await fs.stat(filePath).catch(() => null);
  const duration = stat ? await mediaDuration(filePath).catch(() => null) : null;
  const minDuration = kind === "score" ? Math.min(20, Math.max(5, Number(targetDurationSec) * 0.25)) : 0.2;
  const maxDuration = kind === "score" ? Math.max(30, Number(targetDurationSec) * 1.5) : Math.max(1.5, Number(targetDurationSec) * 2.5);
  const issues = [];
  if (!stat || stat.size < 2048) issues.push("asset_missing_or_too_small");
  if (!Number.isFinite(duration) || duration <= 0) issues.push("duration_unreadable");
  if (Number.isFinite(duration) && duration < minDuration) issues.push("duration_too_short");
  if (Number.isFinite(duration) && duration > maxDuration) issues.push("duration_too_long");
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
    manifest.cues ??= {};
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

function preferredAsset(cue) {
  return cue?.assets?.find((asset) => asset.asset_id === cue.preferred_asset_id)
    ?? [...(cue?.assets ?? [])].reverse().find((asset) => asset?.path && existsSync(asset.path))
    ?? null;
}

function tokenSet(value) {
  return new Set(String(value ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4));
}

function overlapScore(left, right) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const token of a) if (b.has(token)) hits += 1;
  return hits / Math.max(a.size, b.size);
}

function findTightSfxBankMatch(manifest, event) {
  const desired = `${event.cue_id ?? ""} ${event.sound_description ?? ""}`;
  let best = null;
  for (const cue of Object.values(manifest.cues ?? {})) {
    const asset = preferredAsset(cue);
    if (!asset?.path || !existsSync(asset.path) || asset.status === "rejected") continue;
    const text = [cue.cue_id, cue.generation_prompt, ...(cue.aliases ?? []), ...(cue.queries ?? []), asset.prompt].filter(Boolean).join(" ");
    const score = overlapScore(desired, text);
    if (!best || score > best.score) best = { cue, asset, score };
  }
  return best?.score >= Number(flags["sfx-bank-match-threshold"] ?? 0.62) ? best : null;
}

async function generateSfxAsset(event) {
  const cueId = slug(event.cue_id ?? event.sound_description, "llm_sfx");
  const duration = Math.max(3, Math.min(12, Number(event.duration_sec ?? 3) || 3));
  const prompt = `${event.sound_description}. ${event.palette_note ?? ""} Clean isolated sound effect, no speech, no music.`;
  const outDir = path.join(sfxAssetDir, cueId);
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${cueId}-${sha256(`${prompt}:${duration}`).slice(0, 12)}.wav`);
  if (!dryRun && !(await exists(outPath))) {
    const initial = await postModelslab("/api/v7/voice/sound-generation", {
      model_id: "eleven_sound_effect",
      prompt,
      duration: Math.round(duration),
      track_id: `${episode}-${cueId}-${Date.now()}`,
    }, `${cueId} sfx`, 2);
    const resolved = await resolveAudio(initial, "/api/v7/voice/fetch", `${cueId} sfx`);
    const url = await downloadAudio(audioLinks(resolved), outPath);
    const validation = await validateAudioAsset(outPath, duration, "sfx");
    return { outPath, prompt, duration, request_id: initial.id ?? resolved.id ?? null, url, validation };
  }
  const validation = dryRun
    ? { status: "dry_run", issues: [], target_duration_sec: duration, technical_gate: "dry run; asset not generated" }
    : await validateAudioAsset(outPath, duration, "sfx");
  return { outPath, prompt, duration, request_id: null, url: null, validation };
}

async function registerGeneratedSfx(manifest, event, generation) {
  const cueId = slug(event.cue_id ?? event.sound_description, "llm_sfx");
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
      planner: plannerName,
      source_episode: { channel, series, week, episode },
      cue_intent: event.sound_description,
      beat_reason: event.beat_reason,
      recurrence_class: event.recurrence_class ?? "incidental",
    },
  };
  cue.assets = [...(cue.assets ?? []).filter((existing) => existing.asset_id !== assetId), asset];
  if (asset.status === "available") cue.preferred_asset_id = assetId;
  return asset;
}

async function generateScoreAsset(chapter) {
  const duration = Math.max(30, Math.min(480, Number(chapter.target_duration_sec ?? Math.max(60, Number(chapter.end_sec ?? 0) - Number(chapter.start_sec ?? 0))) || 90));
  const prompt = `${chapter.ace_step_prompt ?? chapter.music_prompt ?? chapter.score_intent}. Instrumental only, no vocals, no lyrics, no speech, no crowd noise. Loopable longform anime recap background score.`;
  await fs.mkdir(scoreAssetDir, { recursive: true });
  const outPath = path.join(scoreAssetDir, `${chapter.chapter_id}-${sha256(prompt).slice(0, 12)}.wav`);
  if (!dryRun && !(await exists(outPath))) {
    const initial = await postModelslab("/api/v6/voice/music_gen", {
      model_id: "ai-music-generator",
      prompt,
      duration: Math.ceil(duration),
      bitrate: "320k",
      output_format: "wav",
      track_id: `${episode}-${chapter.chapter_id}-${Date.now()}`,
    }, `${chapter.chapter_id} score`, 1);
    const resolved = await resolveAudio(initial, "/api/v6/voice/fetch", `${chapter.chapter_id} score`);
    const url = await downloadAudio(audioLinks(resolved), outPath);
    const validation = await validateAudioAsset(outPath, duration, "score");
    return { outPath, prompt, duration, request_id: initial.id ?? resolved.id ?? null, url, validation };
  }
  const validation = dryRun
    ? { status: "dry_run", issues: [], target_duration_sec: duration, technical_gate: "dry run; asset not generated" }
    : await validateAudioAsset(outPath, duration, "score");
  return { outPath, prompt, duration, request_id: null, url: null, validation };
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

function selectSegments(qwenReport, wordTiming = null) {
  const starts = segmentStarts(qwenReport);
  return (qwenReport.segments ?? []).map((segment) => ({
    ...segmentTimingFromWhisper(segment, starts, wordTiming),
    speakers: segment.speakers ?? segment.speaker_context ?? [],
    voice_id: segment.voice_id ?? null,
    text: String(segment.stripped_text ?? segment.text ?? "").slice(0, 700),
  }));
}

function segmentTimingFromWhisper(segment, starts, wordTiming) {
  const segmentId = String(segment.segment_id);
  const qwenStart = Number(starts.get(segmentId) ?? 0);
  const qwenDuration = Number(segment.duration_sec ?? segment.raw_audio_duration_sec ?? 0);
  const words = wordsForSegment(wordTiming, segmentId);
  if (words.length) {
    const start = Math.min(...words.map((word) => Number(word.start_sec)).filter(Number.isFinite));
    const end = Math.max(...words.map((word) => Number(word.end_sec)).filter(Number.isFinite));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return {
        segment_id: segment.segment_id,
        start_sec: Number(start.toFixed(3)),
        duration_sec: Number((end - start).toFixed(3)),
        end_sec: Number(end.toFixed(3)),
        timing_source: "local_whisper_word_timing",
        qwen_start_sec: Number(qwenStart.toFixed(3)),
        qwen_duration_sec: Number(qwenDuration.toFixed(3)),
      };
    }
  }
  return {
    segment_id: segment.segment_id,
    start_sec: Number(qwenStart.toFixed(3)),
    duration_sec: Number(qwenDuration.toFixed(3)),
    end_sec: Number((qwenStart + qwenDuration).toFixed(3)),
    timing_source: "qwen_segment_timing_fallback",
  };
}

async function biblePacket() {
  const files = [
    "series_package.json",
    "series_bible.json",
    "character_bible.json",
    "location_bible.json",
    "visual_style_bible.json",
  ];
  const out = {};
  for (const fileName of files) {
    const value = await readJson(path.join(weekDir, fileName), null);
    out[fileName] = value ?? "(missing)";
  }
  const sceneProductionNotes = await readJson(path.join(episodeDir, "scene_production_notes.json"), null);
  if (sceneProductionNotes) {
    out["scene_production_notes.json"] = sceneProductionNotes;
  }
  return out;
}

function buildPrompt({ script, bibles, segments, durationSec, manifest }) {
  const bankSummary = Object.values(manifest.cues ?? {}).slice(0, 140).map((cue) => ({
    cue_id: cue.cue_id,
    aliases: cue.aliases ?? [],
    generation_prompt: cue.generation_prompt ?? null,
    has_available_asset: Boolean(preferredAsset(cue)?.path),
  }));
  return `Build the PRIMARY SFX and score plan for this AniFactory longform episode.

GUIDING PRINCIPLE:
Effective SFX/score is about placement on the emotional beat, not quantity alone. Read the dopamine structure (insult/pressure -> MC signal -> visceral reversal -> witness reaction). Decide WHAT sound/music and WHERE in the story. Deterministic code will convert segment_id + offset_sec into exact timestamps and render.

GENRE NEUTRALITY:
Derive the sonic and musical palette from THIS story and bible. Do not use hardcoded genre templates. If this is finance/city/system, use that palette. If a future story is dungeon/monster/system, use that story's palette. Do not forbid or force any genre vocabulary globally.

SFX REQUIREMENTS:
- Emit about ${sfxTargetCount} abundant, beat-anchored SFX events across the full runtime, not sparse literal keyword hits.
- Every event needs: event_id, cue_id, segment_id, offset_sec, duration_sec, gain_db, priority, sound_description, beat_reason, recurrence_class ("signature" or "incidental"), palette_note.
- Every event also needs target_phrase: exact spoken script words inside the segment where the sound should hit. Anchor to the emotional beat word/phrase: e.g. "card declined", "cracked against the marble", "money becoming more money", "Over two billion". Deterministic code will resolve target_phrase to a word-level Whisper timestamp and write absolute_start_sec.
- segment_id must come from the provided segment list.
- offset_sec is fallback only if target_phrase cannot be aligned.
- beat_reason must state the emotional/dopamine function.
- Signature sounds may recur identically when appropriate (system ping, transaction chime, card swipe). Do not impose a reuse cap. Repetition is correct when it fits.
- Incidental sounds may be one-off or varied.
- Make deliberate sourcing possible: use cue_id consistently for signature recurring sounds that should share an asset; use more specific cue_id for one-off incidental sounds.
- Descriptive narration remains narration; SFX events should layer under it, not replace spoken text.

SCORE REQUIREMENTS:
- Emit ${scoreTargetChapters} or fewer/more as the story beats require; do not use fixed 3-minute windows.
- Each chapter needs: chapter_id, start_sec, end_sec, target_duration_sec, score_intent, story_function, intensity_score 1-10, gain_db, ace_step_prompt, beat_reason, sourcing_intent.
- start/end must be on the real ${Math.round(durationSec)} second timeline.
- Prompts must be instrumental, no vocals/lyrics/speech, and palette-native to this episode.
- Beat mapping matters: swells should sit on actual reversals, pressure under pressure, cold control under power beats.

BANKED SFX SUMMARY FOR POSSIBLE TIGHT MATCHES ONLY:
${JSON.stringify(bankSummary, null, 2)}

EPISODE BIBLES:
${JSON.stringify(bibles, null, 2).slice(0, 30_000)}

TIMED AUDIO SEGMENTS:
${JSON.stringify(segments, null, 2)}

SCRIPT:
${script}

Return one valid JSON object only:
{
  "palette": {
    "world_sonic_palette": ["..."],
    "music_palette": ["..."],
    "signature_motifs": ["..."],
    "genre_neutrality_note": "..."
  },
  "sfx_events": [
    {
      "event_id": "sfx_001",
      "cue_id": "system_contract_ping",
      "segment_id": "voice_seg_01",
      "offset_sec": 1.2,
      "duration_sec": 1.5,
      "gain_db": -18,
      "priority": 1,
      "sound_description": "short cold digital contract ping",
      "target_phrase": "card declined",
      "beat_reason": "marks the mechanic signal landing before the reversal",
      "recurrence_class": "signature",
      "palette_note": "system/finance/city derived from episode"
    }
  ],
  "score_chapters": [
    {
      "chapter_id": "score_chapter_01",
      "start_sec": 0,
      "end_sec": 180,
      "target_duration_sec": 90,
      "score_intent": "cold_open_pressure",
      "story_function": "humiliation hook",
      "intensity_score": 7,
      "gain_db": -30,
      "ace_step_prompt": "instrumental ...",
      "beat_reason": "..."
    }
  ],
  "warnings": []
}`;
}

function normalizeEvent(event, index, validSegments) {
  const segmentId = String(event.segment_id ?? "");
  const segment = validSegments.get(segmentId) ?? [...validSegments.values()][Math.min(index, validSegments.size - 1)] ?? {};
  const duration = Math.max(0.35, Math.min(12, Number(event.duration_sec ?? 2) || 2));
  const offset = Math.max(0, Math.min(Math.max(0, Number(segment.duration_sec ?? 0) - 0.1), Number(event.offset_sec ?? 0) || 0));
  const cueId = slug(event.cue_id ?? event.sound_description ?? `llm_sfx_${index + 1}`, `llm_sfx_${index + 1}`);
  return {
    event_id: event.event_id ?? `llm_sfx_${String(index + 1).padStart(3, "0")}`,
    cue_id: cueId,
    segment_id: segment.segment_id ?? segmentId,
    offset_sec: Number(offset.toFixed(3)),
    duration_sec: Number(duration.toFixed(3)),
    gain_db: Number.isFinite(Number(event.gain_db)) ? Number(event.gain_db) : -18,
    priority: Number.isFinite(Number(event.priority)) ? Number(event.priority) : 2,
    sound_description: String(event.sound_description ?? cueId.replace(/_/g, " ")),
    target_phrase: String(event.target_phrase ?? event.anchor_phrase ?? event.anchor_text ?? "").trim(),
    beat_reason: String(event.beat_reason ?? "LLM-selected beat punctuation"),
    recurrence_class: /signature/i.test(String(event.recurrence_class ?? "")) ? "signature" : "incidental",
    palette_note: String(event.palette_note ?? ""),
    source: "llm_audio_enrichment",
    planner: plannerName,
  };
}

function normalizeToken(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function phraseTokens(value) {
  return String(value ?? "").split(/\s+/).map(normalizeToken).filter(Boolean);
}

function wordsForSegment(wordTiming, segmentId) {
  return (wordTiming?.words ?? []).filter((word) => String(word.segment_id_guess ?? "") === String(segmentId));
}

function findPhraseInWords(words, phrase) {
  const tokens = phraseTokens(phrase);
  if (!tokens.length || !words.length) return null;
  const wordTokens = words.map((word) => normalizeToken(word.word));
  for (let index = 0; index <= wordTokens.length - tokens.length; index += 1) {
    let ok = true;
    for (let offset = 0; offset < tokens.length; offset += 1) {
      if (wordTokens[index + offset] !== tokens[offset]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const start = words[index];
      const end = words[index + tokens.length - 1] ?? start;
      return {
        status: "resolved_whisper_word_timing",
        absolute_start_sec: Number(start.start_sec.toFixed(3)),
        absolute_end_sec: Number(end.end_sec.toFixed(3)),
        matched_words: words.slice(index, index + tokens.length).map((word) => word.word).join(" "),
      };
    }
  }
  return null;
}

function resolveWordTiming(event, validSegments, wordTiming) {
  const segment = validSegments.get(String(event.segment_id)) ?? null;
  if (!wordTiming?.words?.length || !segment) {
    return {
      event,
      placement_resolution: {
        status: "fallback_segment_relative",
        reason: "missing_word_timing_or_segment",
      },
    };
  }
  const candidates = [
    event.target_phrase,
    event.anchor_phrase,
  ].filter(Boolean);
  const words = wordsForSegment(wordTiming, event.segment_id);
  for (const candidate of candidates) {
    const match = findPhraseInWords(words, candidate);
    if (!match) continue;
    const segmentStart = Number(segment.start_sec ?? 0);
    const segmentEnd = segmentStart + Number(segment.duration_sec ?? 0);
    const inEnvelope = match.absolute_start_sec >= segmentStart - 0.75 && match.absolute_start_sec <= segmentEnd + 0.75;
    if (!inEnvelope) {
      return {
        event,
        placement_resolution: {
          ...match,
          status: "fallback_segment_relative",
          reason: "whisper_match_outside_segment_sanity_envelope",
          target_phrase: candidate,
          segment_start_sec: segmentStart,
          segment_end_sec: segmentEnd,
        },
      };
    }
    return {
      event: {
        ...event,
        absolute_start_sec: match.absolute_start_sec,
      },
      placement_resolution: {
        ...match,
        target_phrase: candidate,
        segment_start_sec: Number(segmentStart.toFixed(3)),
        segment_end_sec: Number(segmentEnd.toFixed(3)),
        sanity_envelope_passed: true,
      },
    };
  }
  return {
    event,
    placement_resolution: {
      status: "fallback_segment_relative",
      reason: "target_phrase_not_found_in_whisper_segment_words",
      target_phrase: event.target_phrase || null,
      segment_id: event.segment_id,
    },
  };
}

function normalizeChapter(chapter, index, durationSec) {
  const start = Math.max(0, Math.min(durationSec, Number(chapter.start_sec ?? 0) || 0));
  const fallbackEnd = index === 0 ? Math.min(durationSec, 180) : Math.min(durationSec, start + 240);
  const end = Math.max(start + 30, Math.min(durationSec, Number(chapter.end_sec ?? fallbackEnd) || fallbackEnd));
  const chapterId = slug(chapter.chapter_id ?? `score_chapter_${String(index + 1).padStart(2, "0")}`, `score_chapter_${String(index + 1).padStart(2, "0")}`);
  return {
    chapter_id: chapterId,
    start_sec: Math.round(start),
    end_sec: Math.round(end),
    target_duration_sec: Math.max(30, Math.min(480, Math.round(Number(chapter.target_duration_sec ?? Math.min(120, end - start)) || Math.min(120, end - start)))),
    score_intent: String(chapter.score_intent ?? "beat_aligned_score"),
    story_function: String(chapter.story_function ?? "story beat support"),
    intensity_score: Math.max(1, Math.min(10, Number(chapter.intensity_score ?? 5) || 5)),
    gain_db: Number.isFinite(Number(chapter.gain_db)) ? Number(chapter.gain_db) : -30,
    ace_step_prompt: String(chapter.ace_step_prompt ?? chapter.music_prompt ?? "instrumental anime manhwa recap score bed, no vocals, no lyrics, no speech"),
    beat_reason: String(chapter.beat_reason ?? "LLM-selected emotional score chapter"),
    sourcing_intent: String(chapter.sourcing_intent ?? "generate_or_reuse_tight_match"),
    planner: plannerName,
  };
}

async function validateWhisperTimingForProduction(wordTiming, qwenReport, sourceScriptHash) {
  const issues = [];
  if (wordTiming?.status !== "passed") issues.push("word_timing_status_not_passed");
  if (!Array.isArray(wordTiming?.words) || !wordTiming.words.length) issues.push("word_timing_words_missing");
  if (wordTiming?.source_script_hash && wordTiming.source_script_hash !== sourceScriptHash) issues.push("word_timing_script_hash_stale");
  const narrationPath = qwenReport?.output_path ?? null;
  const narrationAudioHash = narrationPath ? await hashFile(narrationPath) : null;
  if (!narrationPath) issues.push("qwen_report_missing_output_path");
  if (wordTiming?.narration_audio_hash && narrationAudioHash && wordTiming.narration_audio_hash !== narrationAudioHash) {
    issues.push("word_timing_audio_hash_stale");
  }
  if (!Number.isFinite(Number(wordTiming?.audio_duration_sec)) || Number(wordTiming.audio_duration_sec) <= 0) {
    issues.push("word_timing_audio_duration_missing");
  }
  if (issues.length && !allowNonWhisperTiming) {
    throw new Error([
      "Refusing SFX/score enrichment: production SFX and score must be based on current local Whisper timing.",
      `Whisper timing path: ${wordTimingPath}`,
      `Issues: ${issues.join(", ")}`,
      "Run `node bin/goldflow.mjs audio whisper-timing ...` after final stitched narration, or pass --diagnostic-allow-non-whisper-timing true only for non-production inspection.",
    ].join("\n"));
  }
  return {
    status: issues.length ? "diagnostic_non_whisper_fallback_allowed" : "passed",
    issues,
    path: wordTimingPath,
    source_script_hash: wordTiming?.source_script_hash ?? null,
    narration_audio_hash: wordTiming?.narration_audio_hash ?? null,
    current_narration_audio_hash: narrationAudioHash,
    audio_duration_sec: Number.isFinite(Number(wordTiming?.audio_duration_sec)) ? Number(wordTiming.audio_duration_sec) : null,
    word_count: wordTiming?.word_count ?? wordTiming?.words?.length ?? 0,
  };
}

async function appendManualLog(lines) {
  const logPath = path.join(episodeDir, "manual_change_log.md");
  const entry = `\n## ${nowIso()} - LLM SFX/score enrichment\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`;
  await fs.appendFile(logPath, entry, "utf8");
}

async function main() {
  const [script, audioPlan, dialogueMap, qwenReport, bibles, wordTiming] = await Promise.all([
    readText(scriptPath),
    readJson(audioPlanPath, {}),
    readJson(dialogueMapPath, {}),
    readJson(qwenReportPath, {}),
    biblePacket(),
    readJson(wordTimingPath, null),
  ]);
  if (!script.trim()) throw new Error(`Missing script: ${scriptPath}`);
  if (!Array.isArray(qwenReport.segments) || !qwenReport.segments.length) throw new Error(`Missing timed Qwen stitch segments: ${qwenReportPath}`);
  const sourceScriptHash = sha256(script);
  const whisperTimingGate = await validateWhisperTimingForProduction(wordTiming, qwenReport, sourceScriptHash);
  const segments = selectSegments(qwenReport, wordTiming);
  const durationSec = Number(wordTiming?.audio_duration_sec ?? qwenReport.final_duration_sec ?? segments.at(-1)?.end_sec ?? 0)
    || segments.reduce((sum, segment) => sum + Number(segment.duration_sec ?? 0), 0);
  const manifest = await loadManifest();

  const prompt = buildPrompt({ script, bibles, segments, durationSec, manifest });
  const llm = await callPlannerLlm(prompt, `${episode}_audio_sfx_score_enrichment`);
  const validSegments = new Map(segments.map((segment) => [String(segment.segment_id), segment]));
  const rawEvents = Array.isArray(llm.parsed.sfx_events) ? llm.parsed.sfx_events : [];
  const rawChapters = Array.isArray(llm.parsed.score_chapters) ? llm.parsed.score_chapters : [];
  const normalizedEvents = rawEvents
    .map((event, index) => normalizeEvent(event, index, validSegments))
    .filter((event) => event.segment_id)
    .map((event) => resolveWordTiming(event, validSegments, wordTiming));
  const normalizedChapters = rawChapters.map((chapter, index) => normalizeChapter(chapter, index, durationSec))
    .sort((left, right) => left.start_sec - right.start_sec);

  const eventResolutions = [];
  const generatedSfxAssets = [];
  const reusedSfxAssets = [];
  const assetByCueId = new Map();
  for (const resolved of normalizedEvents) {
    const event = resolved.event;
    const alreadyResolved = assetByCueId.get(event.cue_id);
    if (alreadyResolved) {
      eventResolutions.push({
        ...event,
        cue_id: alreadyResolved.cue_id,
        asset_id: alreadyResolved.asset_id,
        asset_path: alreadyResolved.asset_path,
        source: alreadyResolved.source,
        provider: alreadyResolved.provider,
        generated_this_run: false,
        validation: alreadyResolved.validation ?? null,
        sourcing_decision: {
          decision: "reused_same_run_signature_asset",
          reason: "Same cue_id already resolved in this run; repetition is intentional when the cue fits, and placement remains per-event.",
          first_event_id: alreadyResolved.first_event_id,
        },
        placement_resolution: resolved.placement_resolution,
      });
      continue;
    }
    const match = findTightSfxBankMatch(manifest, event);
    if (match) {
      reusedSfxAssets.push({ cue_id: event.cue_id, matched_cue_id: match.cue.cue_id, asset_id: match.asset.asset_id, score: Number(match.score.toFixed(3)) });
      const row = {
        ...event,
        cue_id: match.cue.cue_id,
        asset_id: match.asset.asset_id,
        asset_path: match.asset.path,
        source: match.asset.source,
        provider: match.asset.provider ?? null,
        sourcing_decision: {
          decision: "matched_bank_asset",
          reason: "Tight lexical/intent match to an approved banked cue; no forced reuse cap applied.",
          match_score: Number(match.score.toFixed(3)),
          matched_cue_id: match.cue.cue_id,
        },
        placement_resolution: resolved.placement_resolution,
      };
      eventResolutions.push(row);
      assetByCueId.set(event.cue_id, { ...row, first_event_id: event.event_id });
      continue;
    }
    if (!generateSfxAssets) {
      eventResolutions.push({
        ...event,
        asset_id: null,
        asset_path: null,
        sourcing_decision: { decision: "would_generate_new_asset", reason: "No tight bank match; generation disabled for this run." },
        placement_resolution: resolved.placement_resolution,
      });
      continue;
    }
    const generation = await generateSfxAsset(event);
    const asset = await registerGeneratedSfx(manifest, event, generation);
    generatedSfxAssets.push({ cue_id: event.cue_id, asset_id: asset.asset_id, path: asset.path, validation: asset.validation, prompt: asset.prompt });
    const row = {
      ...event,
      asset_id: asset.asset_id,
      asset_path: asset.path,
      source: asset.source,
      provider: asset.provider,
      generated_this_run: asset.status === "available",
      validation: asset.validation,
      sourcing_decision: {
        decision: "generated_new_asset",
        reason: "No tight bank match; generated purpose-made sound for this beat.",
      },
      placement_resolution: resolved.placement_resolution,
    };
    eventResolutions.push(row);
    if (asset.status === "available") assetByCueId.set(event.cue_id, { ...row, first_event_id: event.event_id });
  }
  await saveManifest(manifest);

  const scoreRows = [];
  const scoreChapters = [];
  for (const chapter of normalizedChapters) {
    if (generateScoreAssets) {
      const generation = await generateScoreAsset(chapter);
      scoreRows.push({ chapter_id: chapter.chapter_id, path: generation.outPath, validation: generation.validation, prompt: generation.prompt });
      scoreChapters.push({
        ...chapter,
        asset_path: generation.outPath,
        asset_provider: "modelslab",
        asset_model_id: "ai-music-generator",
        asset_endpoint: "/api/v6/voice/music_gen",
        asset_validation: generation.validation,
        sourcing_decision: {
          decision: "generated_new_bed",
          reason: "LLM beat-mapped chapter generated as a vetted bed before final mix.",
        },
      });
    } else {
      scoreChapters.push({
        ...chapter,
        asset_path: null,
        sourcing_decision: { decision: "would_generate_new_bed", reason: "Score asset generation disabled for this run." },
      });
    }
  }

  const sfxPlan = {
    status: eventResolutions.every((event) => event.asset_path && (event.validation?.status ?? "passed") !== "failed") ? "passed" : "failed",
    planner: plannerName,
    planner_version: plannerVersion,
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: sourceScriptHash,
    source_script_path: scriptPath,
    source_artifact_paths: [scriptPath, audioPlanPath, dialogueMapPath, qwenReportPath],
    source_hashes: Object.fromEntries((await Promise.all([scriptPath, audioPlanPath, dialogueMapPath, qwenReportPath, wordTimingPath].map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
    timing_source: "local_whisper_word_timing",
    timing_gate: whisperTimingGate,
    policy: "LLM SFX enrichment is the primary cue source; deterministic regex SFX is fallback only. LLM decides sound intent and target phrase; deterministic code resolves target_phrase through local Whisper word timing and uses segment-relative placement only when a phrase miss passes the sanity envelope.",
    palette: llm.parsed.palette ?? {},
    mix_rules: {
      narration_priority: "dominant",
      ambience_gain_db_range: "-34 to -28",
      event_gain_db_range: "-24 to -12",
      loop_episode_beds: true,
      duck_under_narration: true,
    },
    explicit_sound_design_segment_count: (audioPlan.segments ?? []).filter((segment) => segment.delivery_mode === "sound_design" || segment.fish_generation_required === false).length,
    inferred_event_count: 0,
    llm_event_count: normalizedEvents.length,
    resolved_event_count: eventResolutions.filter((event) => event.asset_path).length,
    total_resolved_sfx_cue_count: eventResolutions.filter((event) => event.asset_path).length,
    generated_asset_count: generatedSfxAssets.length,
    reused_asset_count: reusedSfxAssets.length,
    explicit_sound_design_resolutions: [],
    events: normalizedEvents.map((row) => ({ ...row.event, placement_resolution: row.placement_resolution })),
    resolved_events: eventResolutions,
    unresolved: eventResolutions.filter((event) => !event.asset_path || event.validation?.status === "failed").map((event) => ({
      event_id: event.event_id,
      cue_id: event.cue_id,
      reason: !event.asset_path ? "missing_asset" : "asset_validation_failed",
      validation: event.validation ?? null,
    })),
    fish_policy: "sound_design and bracketed cues stay out of Fish/Qwen spoken text; descriptive-sound narration remains spoken and SFX layers under it.",
    updated_at: nowIso(),
  };

  const scorePlan = {
    status: scoreChapters.every((chapter) => chapter.asset_path && (chapter.asset_validation?.status ?? "passed") !== "failed") ? "passed" : "failed",
    ok: scoreChapters.every((chapter) => chapter.asset_path && (chapter.asset_validation?.status ?? "passed") !== "failed"),
    planner: plannerName,
    planner_version: plannerVersion,
    purpose: "LLM beat-mapped score plan for ModelsLab music_gen; chapters follow story beats, not fixed clock windows.",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: sourceScriptHash,
    source_script_path: scriptPath,
    source_artifact_paths: [scriptPath, qwenReportPath, dialogueMapPath],
    source_hashes: Object.fromEntries((await Promise.all([scriptPath, qwenReportPath, dialogueMapPath, wordTimingPath].map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
    timing_source: "local_whisper_word_timing",
    timing_gate: whisperTimingGate,
    target_runtime_minutes: Number((durationSec / 60).toFixed(2)),
    estimated_audio_duration_sec: Number(durationSec.toFixed(3)),
    score_density_policy: {
      target: "Beat-aligned chapters mapped to emotional/dopamine structure; no mechanical 3-minute windows.",
      chapter_count: scoreChapters.length,
      publish_requirement: "Generated beds are vetted before final mix; final mix remains separate.",
    },
    engine_hint: "ModelsLab /api/v6/voice/music_gen model_id ai-music-generator",
    global_rules: [
      "Palette derives from this episode's world and bible.",
      "Instrumental only: no vocals, lyrics, speech, or crowd noise.",
      "Narration remains dominant; chapter gain should not bury speech.",
      "Reuse only genuinely fitting beds; do not force one bed across unrelated beats.",
    ],
    palette: llm.parsed.palette ?? {},
    chapters: scoreChapters,
    warnings: llm.parsed.warnings ?? [],
    updated_at: nowIso(),
  };

  const report = {
    status: sfxPlan.status === "passed" && scorePlan.status === "passed" ? "passed" : "needs_review",
    planner: plannerName,
    planner_version: plannerVersion,
    guiding_principle: "Effective SFX/score is about placement on the emotional beat. LLM decides what sound/music and where in the story; deterministic code decides exact timestamp and render.",
    genre_neutrality_confirmation: "The prompt derives palette from script/bible and contains no hardcoded episode-only, genre-forbidden, or series-specific rules.",
    layer_0_root_cause: {
      score_contamination_root_cause: "Legacy deterministic score templates were removed from the clean production flow; SFX/score must come from locked script, bibles, and Whisper timing.",
      persistence_fix: "Current llm_audio_enrichment_v1 score and SFX plans are preserved by prepro/sfx-resolution guards unless explicitly forced back to fallback.",
    },
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: sourceScriptHash,
    llm: {
      provider: llm.provider,
      model: llm.model,
      prompt_path: llm.promptPath,
      output_path: llm.outputPath,
      content_path: llm.contentPath,
      retry_attempt: llm.retry_attempt ?? 0,
    },
    sfx: {
      plan_path: sfxPlanPath,
      cue_count: sfxPlan.resolved_event_count,
      generated_asset_count: generatedSfxAssets.length,
      reused_asset_count: reusedSfxAssets.length,
      sample_events: eventResolutions.slice(0, 15).map((event) => ({
        event_id: event.event_id,
        cue_id: event.cue_id,
        segment_id: event.segment_id,
        offset_sec: event.offset_sec,
        duration_sec: event.duration_sec,
        absolute_start_sec: event.absolute_start_sec ?? null,
        sound_description: event.sound_description,
        target_phrase: event.target_phrase,
        beat_reason: event.beat_reason,
        placement_resolution: event.placement_resolution,
        sourcing_decision: event.sourcing_decision,
        asset_path: event.asset_path,
      })),
      generated_sound_spot_listen: generatedSfxAssets.slice(0, 12).map((asset) => ({
        cue_id: asset.cue_id,
        asset_id: asset.asset_id,
        path: asset.path,
        validation: asset.validation,
        prompt: asset.prompt,
      })),
    },
    score: {
      plan_path: scorePlanPath,
      chapter_count: scoreChapters.length,
      chapters: scoreChapters.map((chapter) => ({
        chapter_id: chapter.chapter_id,
        start_sec: chapter.start_sec,
        end_sec: chapter.end_sec,
        score_intent: chapter.score_intent,
        story_function: chapter.story_function,
        intensity_score: chapter.intensity_score,
        gain_db: chapter.gain_db,
        beat_reason: chapter.beat_reason,
        prompt: chapter.ace_step_prompt,
        asset_path: chapter.asset_path,
        validation: chapter.asset_validation,
      })),
    },
    word_timing: {
      path: wordTimingPath,
      status: whisperTimingGate.status,
      issues: whisperTimingGate.issues,
      word_count: wordTiming?.word_count ?? 0,
      source_script_hash: wordTiming?.source_script_hash ?? null,
      narration_audio_hash: wordTiming?.narration_audio_hash ?? null,
      resolved_sfx_count: eventResolutions.filter((event) => event.placement_resolution?.status === "resolved_whisper_word_timing").length,
      fallback_sfx_count: eventResolutions.filter((event) => event.placement_resolution?.status !== "resolved_whisper_word_timing").length,
    },
    halt: "Plans and individual vetted assets are ready for operator review. Final mix has NOT been produced.",
    updated_at: nowIso(),
  };

  await writeJson(sfxPlanPath, sfxPlan);
  await writeJson(sfxReportPath, {
    status: sfxPlan.status,
    channel,
    series_slug: series,
    week,
    episode,
    planner: plannerName,
    mode: "llm_enriched_primary",
    source_script_hash: sourceScriptHash,
    sfx_event_plan_path: sfxPlanPath,
    resolved_event_count: sfxPlan.resolved_event_count,
    total_resolved_sfx_cue_count: sfxPlan.total_resolved_sfx_cue_count,
    unresolved_count: sfxPlan.unresolved.length,
    generated_asset_count: generatedSfxAssets.length,
    reused_asset_count: reusedSfxAssets.length,
    event_resolutions: eventResolutions,
    unresolved: sfxPlan.unresolved,
    updated_at: nowIso(),
  });
  await writeJson(scorePlanPath, scorePlan);
  await writeJson(enrichmentReportPath, report);
  await appendManualLog([
    `Generated LLM-enriched SFX plan: ${sfxPlan.resolved_event_count} resolved cues, ${generatedSfxAssets.length} generated assets, ${reusedSfxAssets.length} reused assets.`,
    `Generated LLM beat-mapped score plan: ${scoreChapters.length} chapters, final mix not produced.`,
    `Source script hash: ${sourceScriptHash}.`,
  ]);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  await writeJson(enrichmentReportPath, {
    status: "failed",
    planner: plannerName,
    error: message,
    updated_at: nowIso(),
  }).catch(() => {});
  console.error(message);
  process.exitCode = 1;
});
