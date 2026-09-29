#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  redactModelslabErrorTextForStorageForTests,
  redactModelslabPayloadForStorageForTests,
} from "./lib/modelslab-stt-candidate.mjs";
import {
  automatedQaFindingsAsReviewWarnings,
} from "./lib/tts-selection-policy.mjs";
import {
  planAlignmentSafeUnitEdit,
  planNarrationBoundary,
  validateNarrationStitchAccounting,
} from "./lib/narration-boundary-editor.mjs";
import {
  buildNarrationProviderUnitAsrContract,
} from "./lib/narration-provider-unit-asr-reuse.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const DEFAULT_QWEN_NARRATOR_VOICE_ID = "joel_owned_narrator_clone";
const DEFAULT_QWEN_NARRATOR_VOICE_POLICY = "default_joel_owned_narrator_clone";
const args = process.argv.slice(2);
const flags = parseFlags(args);
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeRoot = flags.episodeDir
  ?? flags["episode-dir"]
  ?? path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const runIdentityPath = path.join(episodeRoot, "run_identity.json");
const reviewVoiceDir = flags.voiceDir ?? path.join(episodeRoot, "review_samples/modelslab_voice_design");
const episodeJoelNarratorRequestPath = path.join(episodeRoot, "review_samples/modelslab_joel_narrator/joel_narrator_qwen_tts_request_v2.json");
const joelNarratorRequestPath = flags.joelNarratorRequest
  ?? (await exists(episodeJoelNarratorRequestPath) ? episodeJoelNarratorRequestPath : null);
const outDir = path.join(episodeRoot, "assets/audio", flags.outDir ?? "modelslab_qwen");
const uploadDir = path.join(episodeRoot, "review_samples/modelslab_voice_uploads");
const planPath = flags.plan ?? path.join(episodeRoot, "qwen_generation_plan.json");
const lockPath = flags.lock ?? path.join(episodeRoot, `modelslab_qwen_voice_lock_${episode}.json`);
const overridesPath = flags.overrides ?? path.join(episodeRoot, `qwen_tts_text_overrides_${episode}.json`);
const suffix = flags.suffix ?? "-modelslab-qwen";
const maxDurationSec = Number(flags["max-duration-sec"] ?? 0);
const maxSegments = Number(flags["max-segments"] ?? 0);
const force = /^(1|true|yes)$/i.test(String(flags.force ?? "false"));
const dryRun = /^(1|true|yes)$/i.test(String(flags["dry-run"] ?? "false"));
const reuseUnchanged = /^(1|true|yes)$/i.test(String(flags["reuse-unchanged"] ?? "false"));
const characterVoiceCasting = /^(?:true|1|yes|enabled|on)$/i.test(String(flags["character-voice-casting"] ?? process.env.ANIFACTORY_CHARACTER_VOICE_CASTING ?? "false").trim());
const reportSuffix = dryRun
  ? `${slug(suffix)}-dry-run`
  : suffix !== "-modelslab-qwen"
  ? slug(suffix)
  : "";
const regenerateSpeakers = new Set(String(flags["regenerate-speakers"] ?? "")
  .split(",")
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean));
const regenerateUnitIds = new Set(String(flags["regenerate-unit-ids"] ?? flags["unit-ids"] ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));
const maxChars = Math.max(120, Number(flags["max-chars"] ?? 420));
const minWords = Math.max(1, Number(flags["min-words"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_MIN_WORDS ?? 20));
const maxWords = Math.max(minWords, Number(flags["max-words"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_MAX_WORDS ?? 45));
const concurrency = Math.max(1, Math.min(15, Number(flags.concurrency ?? process.env.ANIFACTORY_MODELSLAB_QWEN_CONCURRENCY ?? 15)));
const unitGapSec = Math.max(0, Math.min(1.5, Number(flags["unit-gap-sec"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_UNIT_GAP_SEC ?? 0.08)));
const segmentGapSec = Math.max(0, Math.min(1.5, Number(flags["segment-gap-sec"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_SEGMENT_GAP_SEC ?? 0.16)));
const stitchSampleRate = Math.max(8000, Math.min(96000, Number(flags["stitch-sample-rate"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_STITCH_SAMPLE_RATE ?? 24000)));
const stitchEdgePadSec = Math.max(0.01, Math.min(0.08, Number(flags["stitch-edge-pad-sec"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_STITCH_EDGE_PAD_SEC ?? 0.025)));
const stitchFadeSec = Math.max(0.003, Math.min(0.02, Number(flags["stitch-fade-sec"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_STITCH_FADE_SEC ?? 0.008)));
const unitTranscriptQa = !/^(?:0|false|no|off)$/i.test(String(flags["unit-transcript-qa"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_UNIT_TRANSCRIPT_QA ?? "false"));
const unitQaWhisperModel = String(flags["unit-qa-whisper-model"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_QA_WHISPER_MODEL ?? "small");
const unitQaWhisperDevice = String(flags["unit-qa-whisper-device"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_QA_WHISPER_DEVICE ?? "auto");
const unitQaWhisperComputeType = String(flags["unit-qa-whisper-compute-type"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_QA_WHISPER_COMPUTE_TYPE ?? "auto");
const unitQaMaxWer = Math.max(0.05, Math.min(1, Number(flags["unit-qa-max-wer"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_QA_MAX_WER ?? 0.18)));
const unitQaMinTrailingSilenceSec = Math.max(0.02, Math.min(0.2, Number(flags["unit-qa-min-trailing-silence-sec"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_QA_MIN_TRAILING_SILENCE_SEC ?? 0.05)));
const requestedQwenInstructionField = String(flags["qwen-instruct-field"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_INSTRUCT_FIELD ?? "").trim();
const allowedQwenInstructionFields = new Set(["instruct", "instruction", "qwen_instruct"]);
const qwenInstructionField = allowedQwenInstructionFields.has(requestedQwenInstructionField) ? requestedQwenInstructionField : null;
const TTS_OUTPUT_QA_POLICY_VERSION = "tts_output_qa_v3_review_warnings";
const retryInvocationId = `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}`;
const qwenFetchTimeoutMs = Math.max(30000, Number(process.env.ANIFACTORY_MODELSLAB_QWEN_FETCH_TIMEOUT_MS ?? 120000));
const refreshVoiceIds = new Set(String(process.env.ANIFACTORY_MODELSLAB_QWEN_REFRESH_VOICES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));

let cachedKey = null;

function isDeliveryFirstLocalNarrator(provider) {
  return ["kokoro_local", "qwen_local"].includes(String(provider ?? ""));
}

function softenUncertainTranscriptFindings(findings, _provider) {
  return automatedQaFindingsAsReviewWarnings(findings);
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

function apiKey() {
  if (cachedKey) return cachedKey;
  if (process.env.MODELSLAB_API_KEY) {
    cachedKey = process.env.MODELSLAB_API_KEY;
    return cachedKey;
  }
  const list = modelslabCliJson(["keys", "list", "-o", "json", "--no-color", "--no-update-check"]);
  const items = list?.data?.items || [];
  const selected = items.find((item) => item.is_default === 1 || item.is_default === true) || items[0];
  if (!selected) throw new Error("No ModelsLab API key is configured.");
  const detail = modelslabCliJson(["keys", "get", "--id", String(selected.id), "-o", "json", "--no-color", "--no-update-check"]);
  cachedKey = detail?.data?.key;
  if (!cachedKey) throw new Error(`Could not read ModelsLab API key ${selected.id}.`);
  return cachedKey;
}

function modelslabCliJson(args) {
  const attempts = Math.max(1, Number(process.env.ANIFACTORY_MODELSLAB_KEY_ATTEMPTS ?? 4));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return JSON.parse(execFileSync("modelslab", args, { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 }));
    } catch (error) {
      lastError = error;
      const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`;
      const retryable = /429|500|503|rate limited|try again|service .*not available|server error/i.test(output);
      if (!retryable || attempt >= attempts) break;
      const delayMs = Math.max(1000, Number(process.env.ANIFACTORY_MODELSLAB_KEY_BACKOFF_MS ?? 5000)) * attempt;
      console.warn(`modelslab ${args.slice(0, 2).join(" ")} failed transiently (attempt ${attempt}/${attempts}); retrying in ${Math.round(delayMs / 1000)}s`);
      syncSleep(delayMs);
    }
  }
  throw lastError ?? new Error(`modelslab ${args.join(" ")} failed`);
}

function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function cleanVoiceId(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function selectedQwenNarratorVoiceId(identity = {}) {
  return cleanVoiceId(flags["qwen-narrator-voice-id"])
    ?? cleanVoiceId(flags["narrator-voice-id"])
    ?? cleanVoiceId(identity?.voice_provider_options?.qwen_narrator_voice_id)
    ?? cleanVoiceId(identity?.qwen_narrator_voice_id)
    ?? cleanVoiceId(identity?.narrator_voice_id)
    ?? DEFAULT_QWEN_NARRATOR_VOICE_ID;
}

const runIdentity = await readJson(runIdentityPath, {});
const qwenNarratorVoiceId = selectedQwenNarratorVoiceId(runIdentity);
const nativeSpeed = Math.max(0.75, Math.min(1.5, Number(
  flags["native-speed"]
    ?? flags["qwen-native-speed"]
    ?? process.env.ANIFACTORY_MODELSLAB_QWEN_NATIVE_SPEED
    ?? runIdentity?.voice_provider_options?.qwen_native_speed
    ?? runIdentity?.qwen_native_speed
    ?? 1.25,
)));

async function readGlobalQwenVoiceLibrary() {
  const voicesDir = path.join(dataRoot, "voice_bank/qwen/voices");
  let entries = [];
  try {
    entries = await fs.readdir(voicesDir, { withFileTypes: true });
  } catch {
    return {};
  }
  const approved = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const voicePath = path.join(voicesDir, entry.name, "voice.json");
    const voice = await readJson(voicePath, null);
    if (!voice?.approved || !voice?.source_wav) continue;
    const voiceId = voice.voice_id ?? entry.name;
    approved[voiceId] = {
      id: voiceId,
      role: voice.descriptive_name ?? voiceId,
      status: "passed",
      prompt: voice.description ?? voice.descriptive_name ?? voiceId,
      description: voice.description ?? voice.descriptive_name ?? `Global Qwen voice ${voiceId}`,
      init_audio: voice.init_audio ?? null,
      source_audio_path: voice.source_wav,
      sample_path: voice.source_wav,
      source_transcript: voice.source_transcript ?? voice.description ?? voice.descriptive_name ?? voiceId,
      provider: voice.provider ?? "modelslab_qwen",
      voice_source_policy: voice.voice_source_policy ?? "global_qwen_voice_library_exact_wav_reuse",
      model_id: voice.model_id ?? "qwen-voice-design",
      global_voice_path: voicePath,
      tags: voice.tags ?? {},
      used_as: voice.used_as ?? [],
      narrator_locked: Boolean(voice.tags?.narrator_locked),
      owned_clone: Boolean(voice.tags?.owned_clone),
    };
  }
  return approved;
}

async function readSeriesCastingMap() {
  const casting = await readJson(path.join(dataRoot, "voice_bank/qwen/casting/series", series, "casting.json"), null);
  return casting?.speaker_casting && typeof casting.speaker_casting === "object" ? casting : null;
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

function audioLinks(response) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return [];
  };
  return [
    ...normalize(response.output),
    ...normalize(response.proxy_links),
    ...normalize(response.future_links),
    ...normalize(response.links),
  ].filter(Boolean);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = qwenFetchTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitResponse(response, json) {
  const message = `${json?.message ?? ""} ${json?.tips ?? ""}`;
  return response?.status === 429
    || response?.status === 503
    || /rate limit|current_queue|queue is full|too many/i.test(message);
}

function isAbortError(error) {
  return error?.name === "AbortError" || /aborted|timeout/i.test(String(error?.message ?? ""));
}

export async function post(endpoint, body, {
  maxAttempts = null,
} = {}) {
  const configuredAttempts = maxAttempts === null
    ? Number(process.env.ANIFACTORY_MODELSLAB_QWEN_POST_ATTEMPTS ?? 6)
    : Number(maxAttempts);
  const attempts = Number.isFinite(configuredAttempts)
    ? Math.max(1, Math.floor(configuredAttempts))
    : (maxAttempts === null ? 6 : 1);
  const baseDelayMs = Math.max(1000, Number(process.env.ANIFACTORY_MODELSLAB_QWEN_RATE_LIMIT_BACKOFF_MS ?? 15000));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(`https://modelslab.com${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: apiKey(), ...body }),
      });
    } catch (error) {
      if (attempt < attempts && isAbortError(error)) {
        const delayMs = baseDelayMs * attempt;
        console.warn(`${endpoint} timed out (attempt ${attempt}/${attempts}); retrying in ${Math.round(delayMs / 1000)}s`);
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (attempt < attempts && isRetryableNonJsonResponse(response, text)) {
        const delayMs = baseDelayMs * attempt;
        console.warn(`${endpoint} returned retryable non-json ${response.status} (attempt ${attempt}/${attempts}); retrying in ${Math.round(delayMs / 1000)}s`);
        await sleep(delayMs);
        continue;
      }
      throw new Error(`${endpoint} returned non-json ${response.status}: ${redactModelslabErrorTextForStorageForTests(text).slice(0, 500)}`);
    }
    if (!response.ok || json.status === "error" || json.status === "failed") {
      if (attempt < attempts && isRateLimitResponse(response, json)) {
        const delayMs = baseDelayMs * attempt;
        console.warn(`${endpoint} rate limited (attempt ${attempt}/${attempts}); retrying in ${Math.round(delayMs / 1000)}s`);
        await sleep(delayMs);
        continue;
      }
      throw new Error(`${endpoint} failed ${response.status}: ${JSON.stringify(redactModelslabPayloadForStorageForTests(json)).slice(0, 1200)}`);
    }
    return json;
  }
  throw new Error(`${endpoint} failed after ${attempts} POST attempts`);
}

function isRetryableNonJsonResponse(response, text) {
  return response?.status === 429
    || response?.status === 503
    || /rate limit|current_queue|queue is full|too many|service .*not available|try again/i.test(String(text ?? ""));
}

async function fetchVoiceRequest(
  id,
  fetchEndpoint = "/api/v6/voice/fetch",
) {
  const normalizedFetchEndpoint = String(fetchEndpoint).replace(/\/+$/u, "");
  const attempts = Math.max(1, Number(process.env.ANIFACTORY_MODELSLAB_QWEN_FETCH_ATTEMPTS ?? 8));
  const baseDelayMs = Math.max(1000, Number(process.env.ANIFACTORY_MODELSLAB_QWEN_FETCH_BACKOFF_MS ?? 5000));
  const requestJitterMs = Math.abs(Number(id) || 0) % 7 * 250;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(`https://modelslab.com${normalizedFetchEndpoint}/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: apiKey() }),
      });
    } catch (error) {
      if (attempt < attempts && isAbortError(error)) {
        const delayMs = baseDelayMs * attempt + requestJitterMs;
        console.warn(`${normalizedFetchEndpoint}/${id} timed out (attempt ${attempt}/${attempts}); retrying in ${Math.round(delayMs / 1000)}s`);
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (attempt < attempts && isRetryableNonJsonResponse(response, text)) {
        const delayMs = baseDelayMs * attempt + requestJitterMs;
        console.warn(`${normalizedFetchEndpoint}/${id} returned retryable non-json ${response.status} (attempt ${attempt}/${attempts}); retrying in ${Math.round(delayMs / 1000)}s`);
        await sleep(delayMs);
        continue;
      }
      throw new Error(`${normalizedFetchEndpoint}/${id} returned non-json ${response.status}: ${redactModelslabErrorTextForStorageForTests(text).slice(0, 500)}`);
    }
    if (!response.ok || json.status === "error" || json.status === "failed") {
      if (attempt < attempts && isRateLimitResponse(response, json)) {
        const delayMs = baseDelayMs * attempt + requestJitterMs;
        console.warn(`${normalizedFetchEndpoint}/${id} rate limited (attempt ${attempt}/${attempts}); retrying in ${Math.round(delayMs / 1000)}s`);
        await sleep(delayMs);
        continue;
      }
      throw new Error(`${normalizedFetchEndpoint}/${id} failed ${response.status}: ${JSON.stringify(redactModelslabPayloadForStorageForTests(json)).slice(0, 1200)}`);
    }
    return json;
  }
  throw new Error(`${normalizedFetchEndpoint}/${id} failed after ${attempts} attempts`);
}

export async function resolveAudioResponse(initial, {
  fetchEndpoint = "/api/v6/voice/fetch",
  operationLabel = "ModelsLab Qwen",
  includeFetchResult = false,
  completionPredicate = null,
  requestFetcher = fetchVoiceRequest,
  pollIntervalMs = 5000,
} = {}) {
  const pollDelayMs = Math.max(0, Number(pollIntervalMs) || 0);
  const responseLinks = (response) => [
    ...audioLinks(response),
    ...(includeFetchResult && typeof response?.fetch_result === "string"
      && response.fetch_result.trim()
      ? [response.fetch_result.trim()]
      : []),
  ];
  let current = initial;
  let requestId = initial?.id ?? null;
  let lastWithLinks = responseLinks(initial).length ? initial : null;
  for (let attempt = 0; attempt < 96; attempt += 1) {
    if (typeof completionPredicate === "function"
      && completionPredicate(current)) {
      return current;
    }
    const links = responseLinks(current);
    if (current?.status === "success" && links.length) return current;
    if (links.length) lastWithLinks = current;
    const message = String(current?.message ?? "");
    if (current?.status === "failed" && /try again/i.test(message) && requestId) {
      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
      current = await requestFetcher(requestId, fetchEndpoint);
      continue;
    }
    if (current?.status === "failed" && /request not found/i.test(message) && lastWithLinks) {
      return lastWithLinks;
    }
    if (current?.status === "failed" || current?.status === "error") {
      throw new Error(`${operationLabel} request failed while polling: ${JSON.stringify(redactModelslabPayloadForStorageForTests(current)).slice(0, 1200)}`);
    }
    if (current?.id) requestId = current.id;
    if (!requestId) {
      if (links.length) return current;
      throw new Error(`${operationLabel} returned no request id or output URL: ${JSON.stringify(redactModelslabPayloadForStorageForTests(current)).slice(0, 1200)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
    current = await requestFetcher(requestId, fetchEndpoint);
  }
  throw new Error(`Timed out polling ${operationLabel} request ${initial?.id ?? "unknown"}`);
}

async function downloadWhenReady(url, filePath) {
  for (let attempt = 0; attempt < 72; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {}, 15000);
      if (response.ok) {
        await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
        return true;
      }
    } catch {
      // Future links can appear before the object is readable.
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return false;
}

async function urlReachable(url) {
  if (!url) return false;
  try {
    const response = await fetchWithTimeout(url, { method: "GET", headers: { Range: "bytes=0-1" } }, 15000);
    return response.ok || response.status === 206;
  } catch {
    return false;
  }
}

function audioMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".mp3") return "audio/mpeg";
  return "audio/wav";
}

export async function uploadAudioReference(filePath, voiceId, {
  returnProvenance = false,
  maxSourceBytes = null,
  maxBase64Bytes = null,
} = {}) {
  if (!filePath || !(await exists(filePath))) throw new Error(`Cannot refresh init_audio for ${voiceId}: missing local source ${filePath}`);
  await fs.mkdir(uploadDir, { recursive: true });
  const sourceBytes = await fs.readFile(filePath);
  if (maxSourceBytes !== null
    && sourceBytes.byteLength > Number(maxSourceBytes)) {
    throw new Error(
      `ModelsLab upload source exceeds ${maxSourceBytes} bytes for `
      + `${voiceId}: ${sourceBytes.byteLength}`,
    );
  }
  const encodedByteCount = 4 * Math.ceil(sourceBytes.byteLength / 3);
  if (maxBase64Bytes !== null
    && encodedByteCount > Number(maxBase64Bytes)) {
    throw new Error(
      `ModelsLab base64 payload exceeds ${maxBase64Bytes} bytes for `
      + `${voiceId}: ${encodedByteCount}`,
    );
  }
  const base64 = sourceBytes.toString("base64");
  const response = await post("/api/v6/base64_to_url", {
    base64_string: `data:${audioMime(filePath)};base64,${base64}`,
  });
  const uploadedUrl = audioLinks(response)[0];
  if (!uploadedUrl) throw new Error(`ModelsLab upload returned no URL for ${voiceId}`);
  const sourceAudioSha256 = await sha256File(filePath);
  const provenancePath = path.join(uploadDir, `${slug(voiceId)}.upload.json`);
  const storedResponse = redactModelslabPayloadForStorageForTests(response);
  await fs.writeFile(provenancePath, JSON.stringify({
    response: storedResponse,
    source_audio_path: filePath,
    source_audio_sha256: sourceAudioSha256,
    uploaded_url: uploadedUrl,
  }, null, 2));
  return returnProvenance
    ? {
        uploaded_url: uploadedUrl,
        response: storedResponse,
        provenance_path: provenancePath,
        source_audio_path: filePath,
        source_audio_sha256: sourceAudioSha256,
      }
    : uploadedUrl;
}

async function reusableUploadedAudioReference(filePath, voiceId) {
  if (!filePath) return null;
  const uploadPath = path.join(uploadDir, `${slug(voiceId)}.upload.json`);
  const previous = await readJson(uploadPath, null);
  if (!previous?.uploaded_url) return null;
  if (previous.source_audio_path && path.resolve(previous.source_audio_path) !== path.resolve(filePath)) return null;
  if (!(await urlReachable(previous.uploaded_url))) return null;
  return previous.uploaded_url;
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function mediaDuration(filePath) {
  const result = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath]);
  return Number(result.stdout.trim());
}

function runBinary(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    let stderr = "";
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} exited ${code}\n${stderr}`));
    });
  });
}

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\[([^\]]+)\]/g, "$1")
    .replace(/^["“]|["”]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function numberWord(value) {
  const words = {
    0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
    6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
    11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen", 15: "fifteen",
    16: "sixteen", 17: "seventeen", 18: "eighteen", 19: "nineteen", 20: "twenty",
  };
  return words[Number(value)] ?? String(value);
}

function normalizeTtsDisfluencies(value) {
  // Repetitions and stutters may be intentional approved prose. Any spoken
  // repair must arrive through the explicit, hash-bound override artifact.
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAllCapsForTts(value) {
  const keep = new Set(["UI", "ID", "SSS", "SS", "S", "A", "B", "C", "D", "E", "F"]);
  return String(value ?? "").replace(/\b[A-Z][A-Z0-9' -]{2,}\b/g, (match) => match
    .split(/(\s+|-)/)
    .map((part) => {
      if (/^\s+$|^-$/u.test(part)) return part;
      if (keep.has(part)) return part;
      if (!/[A-Z]/.test(part)) return part;
      return part.charAt(0) + part.slice(1).toLowerCase();
    })
    .join(""));
}

function applyTextOverrides(units, overrides) {
  const rows = Array.isArray(overrides?.overrides) ? overrides.overrides : [];
  if (!rows.length) return units;
  const segmentSpeakerCounts = new Map();
  for (const unit of units) {
    for (const segmentId of unit.source_segment_ids ?? [unit.source_segment_id ?? unit.segment_id]) {
      const key = `${String(segmentId ?? "")}\u001f${String(unit.speaker ?? "").toUpperCase()}`;
      segmentSpeakerCounts.set(key, Number(segmentSpeakerCounts.get(key) ?? 0) + 1);
    }
  }
  return units.map((unit, index) => {
    const match = rows.find((row) => {
      if (row.unit_id && String(row.unit_id) === String(unit.unit_id)) return true;
      if (Number(row.index ?? 0) === index + 1) return true;
      const sameSegmentSpeaker = (unit.source_segment_ids ?? [unit.source_segment_id ?? unit.segment_id])
        .map(String).includes(String(row.segment_id ?? ""))
        && String(row.speaker ?? "").toUpperCase() === String(unit.speaker ?? "").toUpperCase();
      if (!sameSegmentSpeaker) return false;
      if (row.unit_index != null) {
        return (unit.source_unit_refs ?? []).some((ref) => (
          String(ref.segment_id) === String(row.segment_id)
          && String(ref.unit_index) === String(row.unit_index)
        ));
      }
      const key = `${String(unit.segment_id ?? "")}\u001f${String(unit.speaker ?? "").toUpperCase()}`;
      return segmentSpeakerCounts.get(`${String(row.segment_id ?? "")}\u001f${String(unit.speaker ?? "").toUpperCase()}`) === 1
        || segmentSpeakerCounts.get(key) === 1;
    });
    if (!match?.text) return unit;
    return {
      ...unit,
      text: ttsSafeText(match.text),
      text_override_reason: match.reason ?? "manual_qwen_audio_quality_repair",
      text_override_source: match.unit_id
        ? "explicit_unit_id"
        : match.index != null
        ? "explicit_output_index"
        : match.unit_index != null
        ? "explicit_source_unit_index"
        : "unambiguous_segment_speaker",
    };
  });
}

function ttsSafeText(value) {
  const cleaned = cleanText(value);
  if (!cleaned || /^[-_*]{3,}$/.test(cleaned) || /^\(?\s*end\s+episode\b/i.test(cleaned)) return "";
  const normalized = cleaned
    .replace(/[*_`]+/g, "")
    .replace(/\bchyron\b/gi, "screen caption")
    .replace(/screen caption that reads:\s*/gi, "screen caption says, ")
    .replace(/,\s*arriving late\b/gi, "")
    .replace(/,\s*late arrival\b/gi, "")
    .replace(/\bKneel now\b/g, "Get on your knees now")
    .replace(/\bF-meat\b/gi, "F meat")
    .replace(/\bSSS(?:\s*[- ]\s*rank)?\b/gi, (match) => /rank/i.test(match) ? "S S S rank" : "S S S")
    .replace(/\bSS(?:\s*[- ]\s*rank)?\b/gi, (match) => /rank/i.test(match) ? "S S rank" : "S S")
    .replace(/\bF\s*[- ]\s*rank(?:ed)?\b/gi, "F rank")
    .replace(/\b([A-Z])\s*[- ]\s*rank\b/g, "$1 rank")
    .replace(/\bUI\b/g, "U I")
    .replace(/\bID\b/g, "I D")
    .replace(/\b(\d{1,2})\s*x\b/gi, (_match, multiplier) => `${numberWord(multiplier)} times`)
    .replace(/\bLevel\s*[-:]\s*-\s*(\d{1,2})\b/gi, (_match, level) => `Level negative ${numberWord(level)}`)
    .replace(/\s+/g, " ")
    .trim();
  return normalizeTtsDisfluencies(normalizeAllCapsForTts(normalized));
}

export function ttsSafeTextForTests(value) {
  return ttsSafeText(value);
}

function slug(value) {
  return String(value ?? "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function suffixFileWith(label, base, extension) {
  const clean = String(label ?? "").replace(/[^a-z0-9._-]/gi, "-");
  return `${base}${clean.startsWith("-") ? clean : `-${clean}`}${extension}`;
}

function unitReuseKey(unit) {
  const identityHash = String(unit?.synthesis_identity?.content_sha256 ?? "");
  return identityHash && unit?.unit_id ? `${String(unit.unit_id)}\u001f${identityHash}` : "";
}

function previousResultMap(report) {
  const map = new Map();
  for (const row of report?.results ?? []) {
    const key = unitReuseKey(row);
    if (key) map.set(key, row);
  }
  return map;
}

function previousUnitIdResultMap(report) {
  const map = new Map();
  for (const row of report?.results ?? []) {
    if (row?.unit_id) map.set(String(row.unit_id), row);
  }
  return map;
}

function reusablePreviousUnit(previous, unit) {
  if (!previous?.wav) return false;
  return String(previous.unit_id ?? "") === String(unit.unit_id ?? "")
    && Boolean(unitReuseKey(previous))
    && unitReuseKey(previous) === unitReuseKey(unit);
}

function unitContentReuseKey(unit) {
  return String(unit?.synthesis_identity?.content_sha256 ?? "");
}

function previousContentResultMap(report) {
  const map = new Map();
  for (const row of report?.results ?? []) {
    const key = unitContentReuseKey(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function takePreviousContentResult(map, unit) {
  const rows = map.get(unitContentReuseKey(unit)) ?? [];
  return rows.shift() ?? null;
}

function synthesisIdentity(unit, voice, {
  speed = nativeSpeed,
  instructionField = qwenInstructionField,
} = {}) {
  const request = qwenRequestForUnit(unit, voice, 0, instructionField, speed);
  const payload = {
    schema: "goldflow_qwen_synthesis_identity_v1",
    provider: "modelslab_qwen",
    provider_endpoint: "/api/v6/voice/text_to_audio",
    model_id: request.body.model_id,
    language: request.body.language,
    prompt: request.body.prompt,
    native_speed: request.body.speed,
    voice_id: String(unit.voice_id ?? voice?.id ?? ""),
    reference_audio: String(voice?.init_audio ?? ""),
    reference_audio_sha256: String(
      voice?.reference_audio_sha256
      ?? voice?.source_audio_sha256
      ?? voice?.init_audio_sha256
      ?? "",
    ) || null,
    authored_qwen_instruct: String(unit.qwen_instruct ?? ""),
    authored_qwen_instructions: Array.isArray(unit.authored_qwen_instructions)
      ? unit.authored_qwen_instructions
      : String(unit.qwen_instruct ?? "") ? [String(unit.qwen_instruct)] : [],
    configured_instruction_field: instructionField ?? null,
    instruction_submitted: request.instruction_delivery.submitted,
    submitted_instruction_field: request.instruction_delivery.submitted_field,
    submitted_instruction: request.instruction_delivery.submitted
      ? String(unit.qwen_instruct ?? "")
      : null,
  };
  return {
    ...payload,
    content_sha256: sha256Text(JSON.stringify(payload)),
  };
}

export function synthesisIdentityForTests(unit, voice, options = {}) {
  return synthesisIdentity(unit, voice, options);
}

function assertRegenerateUnitIdsExist(units, requestedIds) {
  const known = new Set(units.map((unit) => String(unit.unit_id)));
  const missing = [...requestedIds].filter((unitId) => !known.has(unitId));
  if (missing.length) {
    throw new Error(`Scoped Qwen regeneration named unknown unit id(s): ${missing.join(", ")}. Read unit_id values from the current materialized TTS report or a dry-run plan.`);
  }
}

export function validateRegenerateUnitIdsForTests(units, requestedIds) {
  assertRegenerateUnitIdsExist(units, new Set(requestedIds));
  return units.filter((unit) => new Set(requestedIds).has(unit.unit_id)).map((unit) => unit.unit_id);
}

function speakerVoiceId(speaker, lock = null) {
  const normalized = String(speaker ?? "NARRATOR").toUpperCase();
  const narratorVoiceId = lock?.narrator_voice_id ?? qwenNarratorVoiceId;
  if (!characterVoiceCasting) return narratorVoiceId;
  if (normalized === "MC_INTERNAL") return narratorVoiceId;
  const lockedVoice = lock?.speaker_casting?.[normalized]?.id ?? lock?.speaker_casting?.[normalized]?.reference_id;
  if (lockedVoice) return lockedVoice;
  if (normalized === "NARRATOR") return narratorVoiceId;
  throw new Error(`Missing ModelsLab Qwen speaker casting for '${normalized}'. Run qwen-tts modelslab-voice-design or voice-casting before episode audio.`);
}

function assertProductionVoiceRoute(unit, lock) {
  const normalized = String(unit.speaker ?? "NARRATOR").toUpperCase();
  const narratorVoiceId = lock?.narrator_voice_id ?? qwenNarratorVoiceId;
  if ((normalized === "NARRATOR" || normalized === "MC_INTERNAL") && unit.voice_id !== narratorVoiceId) {
    throw new Error(`Refusing Qwen TTS: narrator routed to '${unit.voice_id}', expected locked narrator voice '${narratorVoiceId}'.`);
  }
  const voice = lock.voices.find((item) => item.id === unit.voice_id);
  if (!voice?.init_audio) throw new Error(`Missing ModelsLab init_audio for voice ${unit.voice_id}`);
  return voice;
}

function wordCount(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function chunkTextBySentence(text, limit, wordLimit = maxWords) {
  const sentences = String(text ?? "").match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
  const chunks = [];
  for (const sentence of sentences.length ? sentences : [text]) {
    const last = chunks[chunks.length - 1];
    const combined = `${last ?? ""} ${sentence}`.trim();
    if (last && combined.length <= limit && wordCount(combined) <= wordLimit) chunks[chunks.length - 1] = combined;
    else if (sentence.length <= limit && wordCount(sentence) <= wordLimit) chunks.push(sentence);
    else {
      const words = sentence.split(/\s+/);
      let current = "";
      for (const word of words) {
        const candidate = `${current} ${word}`.trim();
        if ((candidate.length > limit || wordCount(candidate) > wordLimit) && current) {
          chunks.push(current);
          current = word;
        } else {
          current = candidate;
        }
      }
      if (current) chunks.push(current);
    }
  }
  return chunks;
}

function inlineSpeakerUnit(rawText, fallbackSpeaker) {
  const text = String(rawText ?? "").trim();
  if (!characterVoiceCasting) return { speaker: fallbackSpeaker ?? "NARRATOR", text };
  const match = text.match(/^([A-Z][A-Z0-9 _.'-]{1,40}?)(?:\s*\([^)]+\))?\s*:\s*(.+)$/);
  if (!match) return { speaker: fallbackSpeaker ?? "NARRATOR", text };
  const speaker = match[1].replace(/\s+/g, " ").trim();
  const spoken = match[2].trim();
  if (!spoken) return { speaker: fallbackSpeaker ?? "NARRATOR", text: "" };
  return { speaker, text: spoken };
}

async function buildVoiceLock() {
  const manifest = await readJson(path.join(reviewVoiceDir, "voice_design_manifest.json"), { voices: [] });
  const joelNarratorRequest = await readJson(joelNarratorRequestPath, null);
  const voices = [];
  for (const voice of manifest.voices ?? []) {
    const initial = await readJson(path.join(reviewVoiceDir, `${voice.id}.initial.json`), {});
    const initAudio = voice.url ?? audioLinks(initial)[0] ?? null;
    voices.push({
      id: voice.id,
      role: voice.role,
      status: voice.status,
      prompt: voice.prompt,
      description: voice.description,
      init_audio: initAudio,
      source_audio_path: voice.wav,
      sample_path: voice.m4a,
      source_transcript: voice.prompt,
      provider: "modelslab_qwen",
      voice_source_policy: "modelslab_qwen_voice_design",
      model_id: "qwen-voice-design",
    });
  }
  const byId = Object.fromEntries(voices.map((voice) => [voice.id, voice]));
  const globalVoices = await readGlobalQwenVoiceLibrary();
  for (const [voiceId, bankVoice] of Object.entries(globalVoices)) {
    byId[voiceId] = bankVoice;
    const existingIndex = voices.findIndex((voice) => voice.id === voiceId);
    if (existingIndex >= 0) voices[existingIndex] = bankVoice;
    else voices.push(bankVoice);
  }
  if (!byId.joel_narrator) {
    const narratorClone = Object.values(globalVoices).find((voice) => voice.narrator_locked && voice.owned_clone)
      ?? Object.values(globalVoices).find((voice) => voice.narrator_locked);
    if (narratorClone) {
      byId.joel_narrator = {
        ...narratorClone,
        id: "joel_narrator",
        bank_voice_id: narratorClone.id,
        role: "primary narrator",
        voice_source_policy: narratorClone.voice_source_policy ?? "joel_owned_narrator_clone_alias",
      };
      voices.push(byId.joel_narrator);
    }
  }
  if (joelNarratorRequest?.initAudio) {
    byId.joel_narrator = {
      id: "joel_narrator",
      role: "primary narrator",
      status: "passed",
      prompt: joelNarratorRequest.prompt,
      description: "Joel-owned narrator clone reference, hosted through ModelsLab Qwen TTS.",
      init_audio: joelNarratorRequest.initAudio,
      source_audio_path: joelNarratorRequest.source_audio_path ?? joelNarratorRequest.source_wav ?? null,
      sample_path: joelNarratorRequest.sample_path ?? null,
      source_transcript: "The register turned blue before the window cracked. Outside, something tall moved between the parked cars, stopped under the dead sign, and waited like it had already learned his name.",
      provider: "modelslab_qwen",
      voice_source_policy: "joel_owned_clone",
      model_id: "qwen-tts",
    };
    voices.push(byId.joel_narrator);
  }
  const narratorVoice = byId[qwenNarratorVoiceId]
    ?? (qwenNarratorVoiceId === "joel_narrator" ? byId.joel_narrator ?? byId.narrator : null);
  if (!narratorVoice) {
    throw new Error(`Locked Qwen narrator voice '${qwenNarratorVoiceId}' was not found in ${reviewVoiceDir} or ${path.join(dataRoot, "voice_bank/qwen/voices")}. Promote the approved voice first or choose a known voice id.`);
  }
  const activeVoices = characterVoiceCasting
    ? voices
    : [narratorVoice].filter(Boolean);
  const manifestCasting = {};
  if (characterVoiceCasting) {
    for (const [speaker, cast] of Object.entries(manifest.speaker_casting ?? {})) {
      const voiceId = cast?.id ?? cast?.reference_id ?? cast;
      if (!voiceId || !byId[voiceId]) continue;
      manifestCasting[String(speaker).toUpperCase()] = byId[voiceId];
    }
    const seriesCasting = await readSeriesCastingMap();
    for (const [speaker, voiceId] of Object.entries(seriesCasting?.speaker_casting ?? {})) {
      if (!voiceId || !byId[voiceId]) continue;
      manifestCasting[String(speaker).toUpperCase()] = {
        ...byId[voiceId],
        speaker,
        cast_from_series_map: true,
        series_casting_map_path: path.join(dataRoot, "voice_bank/qwen/casting/series", series, "casting.json"),
      };
    }
  }
  const lock = {
    status: activeVoices.length && activeVoices.every((voice) => voice.status === "passed" && voice.init_audio) ? "passed" : "warning",
    production_ready: activeVoices.some((voice) => voice.id === narratorVoice.id && voice.status === "passed" && voice.init_audio),
    created_at: new Date().toISOString(),
    tts_provider: "modelslab_qwen",
    tts_model_id: "qwen-tts",
    tts_endpoint: "/api/v6/voice/text_to_audio",
    voice_design_model_id: "qwen-voice-design",
    narrator_voice_id: narratorVoice.id,
    requested_narrator_voice_id: qwenNarratorVoiceId,
    narrator_voice_policy: runIdentity?.qwen_narrator_voice_policy ?? runIdentity?.voice_provider_options?.qwen_narrator_voice_policy ?? DEFAULT_QWEN_NARRATOR_VOICE_POLICY,
    voice_casting_mode: characterVoiceCasting ? "explicit_character_voice_casting" : "narrator_only_default",
    character_voice_casting_enabled: characterVoiceCasting,
    run_identity_path: runIdentityPath,
    source_manifest_path: path.join(reviewVoiceDir, "voice_design_manifest.json"),
    voices: activeVoices,
    speaker_casting: {
      ...manifestCasting,
      NARRATOR: narratorVoice,
    },
  };
  for (const voice of lock.voices) {
    if (!refreshVoiceIds.has(voice.id) && await urlReachable(voice.init_audio)) continue;
    const localSource = voice.source_audio_path ?? voice.sample_path ?? null;
    voice.init_audio_previous = voice.init_audio ?? null;
    const reusableUpload = refreshVoiceIds.has(voice.id) ? null : await reusableUploadedAudioReference(localSource, voice.id);
    voice.init_audio = reusableUpload ?? await uploadAudioReference(localSource, voice.id);
    voice.init_audio_refreshed_at = new Date().toISOString();
    voice.init_audio_refresh_policy = reusableUpload
      ? "reused_existing_episode_voice_upload_because_cached_url_was_reachable"
      : refreshVoiceIds.has(voice.id)
      ? "uploaded_local_approved_voice_source_because_voice_id_was_forced_refresh"
      : "uploaded_local_approved_voice_source_because_cached_url_missing_or_expired";
  }
  for (const voice of lock.voices) {
    const localReference = voice.source_audio_path ?? voice.sample_path ?? null;
    voice.reference_audio_sha256 = localReference && await exists(localReference)
      ? await sha256File(localReference)
      : voice.reference_audio_sha256 ?? null;
  }
  lock.status = lock.voices.every((voice) => voice.status === "passed" && voice.init_audio) ? "passed" : "warning";
  lock.production_ready = lock.voices.some((voice) => voice.id === lock.narrator_voice_id && voice.status === "passed" && voice.init_audio);
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
  await fs.writeFile(path.join(episodeRoot, `voice_casting_lock_${episode}.json`), JSON.stringify(lock, null, 2));
  if (episode === "ep_01") {
    await fs.writeFile(path.join(episodeRoot, "voice_casting_lock_ep_01.json"), JSON.stringify(lock, null, 2));
  }
  return lock;
}

function collectUnits(plan, lock, {
  maxCharsLimit = maxChars,
  minWordsLimit = minWords,
  maxWordsLimit = maxWords,
  narratorOnly = !characterVoiceCasting,
  instructionField = qwenInstructionField,
} = {}) {
  const lexicalTokens = (value) => String(value ?? "").trim().split(/\s+/).filter(Boolean);
  const explicitBarrier = (segment, unit, sourceSpeaker) => {
    const explicit = [
      segment?.tts_merge_barrier,
      segment?.synthesis_barrier,
      segment?.hard_boundary,
      unit?.tts_merge_barrier,
      unit?.synthesis_barrier,
      unit?.hard_boundary,
      unit?.do_not_merge,
    ].some((value) => value === true || /^(?:true|1|yes|hard)$/i.test(String(value ?? "")));
    const sourceLabel = String(sourceSpeaker ?? "NARRATOR").toUpperCase();
    const trueSystemOrTurn = String(unit?.kind ?? "narration").toLowerCase() !== "narration"
      || /^(?:SYSTEM|UI|NOTICE|WARNING)$/.test(sourceLabel);
    const castSpeakerTurn = !narratorOnly && sourceLabel !== "NARRATOR";
    return explicit || trueSystemOrTurn || castSpeakerTurn;
  };
  const rawUnits = [];
  for (const segment of plan.segments ?? []) {
    for (const unit of segment.qwen_generation_units ?? []) {
      const inline = inlineSpeakerUnit(unit.qwen_spoken_text ?? unit.text ?? unit.source_text ?? "", unit.speaker ?? "NARRATOR");
      const text = ttsSafeText(inline.text);
      if (!text) continue;
      const sourceSpeaker = unit.source_speaker ?? unit.speaker ?? "NARRATOR";
      // Captions are an independent, approved-text layer. Never fall back to
      // qwen_spoken_text or post-speakability TTS text here.
      const captionText = String(unit.caption_text ?? unit.source_text ?? "").trim();
      rawUnits.push({
        source_segment_id: segment.segment_id,
        unit_index: unit.unit_index,
        speaker: inline.speaker,
        source_speaker: sourceSpeaker,
        voice_id: speakerVoiceId(inline.speaker, lock),
        text,
        caption_text: captionText,
        qwen_instruct: String(unit.qwen_instruct ?? "").trim() || null,
        authored_qwen_instructions: String(unit.qwen_instruct ?? "").trim()
          ? [String(unit.qwen_instruct).trim()]
          : [],
        kind: unit.kind ?? "narration",
        merge_barrier: explicitBarrier(segment, unit, sourceSpeaker),
        authored_segment_expected_duration_sec: Number(segment.expected_duration_sec ?? 0),
        source_segment_ids: [segment.segment_id],
        source_speakers: [sourceSpeaker],
        source_unit_indices: [unit.unit_index],
        tts_override_replacements_applied: Array.isArray(unit.tts_override_replacements_applied)
          ? unit.tts_override_replacements_applied
          : [],
        source_unit_refs: [{
          segment_id: segment.segment_id,
          unit_index: unit.unit_index,
          source_speaker: sourceSpeaker,
          caption_text: captionText,
        }],
      });
    }
  }

  const sameSynthesisContext = (left, right) => (
    String(left?.speaker ?? "NARRATOR").toUpperCase() === String(right?.speaker ?? "NARRATOR").toUpperCase()
    && (narratorOnly
      || String(left?.source_speaker ?? "NARRATOR").toUpperCase() === String(right?.source_speaker ?? "NARRATOR").toUpperCase())
    && String(left?.voice_id ?? "") === String(right?.voice_id ?? "")
    && (!instructionField || String(left?.qwen_instruct ?? "") === String(right?.qwen_instruct ?? ""))
  );
  const runs = [];
  for (const unit of rawUnits) {
    const lastRun = runs.at(-1);
    const previous = lastRun?.at(-1);
    if (lastRun && previous && !previous.merge_barrier && !unit.merge_barrier && sameSynthesisContext(previous, unit)) {
      lastRun.push(unit);
    } else {
      runs.push([unit]);
    }
  }

  const tokenText = (tokens, start, end) => tokens.slice(start, end).map((row) => row.word).join(" ");
  const choosePartitions = (tokens) => {
    const total = tokens.length;
    if (!total) return [];
    if (total < minWordsLimit && tokenText(tokens, 0, total).length <= maxCharsLimit) return [[0, total]];
    const minimumChunks = Math.max(1, Math.ceil(total / maxWordsLimit));
    const maximumBalancedChunks = Math.max(minimumChunks, Math.floor(total / minWordsLimit));
    const isSentenceEnd = (index) => /[.!?]["'”’)]*$/u.test(tokens[index - 1]?.word ?? "");
    const isClauseEnd = (index) => /[,;:—-]["'”’)]*$/u.test(tokens[index - 1]?.word ?? "");
    const isSourceBoundary = (index) => tokens[index - 1]?.source !== tokens[index]?.source;
    for (let chunkCount = minimumChunks; chunkCount <= maximumBalancedChunks; chunkCount += 1) {
      const ranges = [];
      let start = 0;
      let possible = true;
      for (let chunkIndex = 0; chunkIndex < chunkCount - 1; chunkIndex += 1) {
        const remainingChunks = chunkCount - chunkIndex - 1;
        const low = Math.max(start + minWordsLimit, total - remainingChunks * maxWordsLimit);
        const high = Math.min(start + maxWordsLimit, total - remainingChunks * minWordsLimit);
        const target = Math.round(total * (chunkIndex + 1) / chunkCount);
        const candidates = [];
        for (let end = low; end <= high; end += 1) {
          if (tokenText(tokens, start, end).length > maxCharsLimit) continue;
          candidates.push({
            end,
            boundary_rank: isSentenceEnd(end) ? 0 : isSourceBoundary(end) ? 1 : isClauseEnd(end) ? 2 : 3,
            distance: Math.abs(end - target),
          });
        }
        candidates.sort((left, right) => left.boundary_rank - right.boundary_rank
          || left.distance - right.distance
          || right.end - left.end);
        const selected = candidates[0]?.end;
        if (!selected) {
          possible = false;
          break;
        }
        ranges.push([start, selected]);
        start = selected;
      }
      if (possible
        && total - start <= maxWordsLimit
        && (total - start >= minWordsLimit || chunkCount === 1)
        && tokenText(tokens, start, total).length <= maxCharsLimit) {
        ranges.push([start, total]);
        return ranges;
      }
    }
    // Extremely long individual tokens or pathological character density are
    // the only reason to leave the balanced 20–45-word lane.
    const ranges = [];
    let start = 0;
    while (start < total) {
      let end = Math.min(total, start + maxWordsLimit);
      while (end > start + 1 && tokenText(tokens, start, end).length > maxCharsLimit) end -= 1;
      ranges.push([start, end]);
      start = end;
    }
    return ranges;
  };

  const chunks = [];
  for (const run of runs) {
    const tokens = [];
    for (const source of run) {
      const words = lexicalTokens(source.text);
      words.forEach((word, localIndex) => tokens.push({ word, source, local_index: localIndex, source_word_count: words.length }));
    }
    for (const [start, end] of choosePartitions(tokens)) {
      const selected = tokens.slice(start, end);
      const sourceSlices = [];
      for (const token of selected) {
        const current = sourceSlices.at(-1);
        if (current?.source === token.source && current.local_end === token.local_index) {
          current.local_end += 1;
        } else {
          sourceSlices.push({ source: token.source, local_start: token.local_index, local_end: token.local_index + 1 });
        }
      }
      const captionFragments = sourceSlices.flatMap(({ source, local_start: localStart, local_end: localEnd }) => {
        const captionWords = lexicalTokens(source.caption_text);
        const spokenCount = Math.max(1, lexicalTokens(source.text).length);
        const captionStart = Math.floor(localStart * captionWords.length / spokenCount);
        const captionEnd = localEnd >= spokenCount
          ? captionWords.length
          : Math.floor(localEnd * captionWords.length / spokenCount);
        const text = captionWords.slice(captionStart, captionEnd).join(" ");
        return text ? [{
          segment_id: source.source_segment_id,
          unit_index: source.unit_index,
          source_speaker: source.source_speaker,
          caption_word_start: captionStart,
          caption_word_end_exclusive: captionEnd,
          text,
        }] : [];
      });
      const sources = sourceSlices.map((row) => row.source);
      const first = sources[0];
      const sourceUnitRefs = sources.map((source) => source.source_unit_refs[0])
        .filter((row, index, rows) => rows.findIndex((candidate) => String(candidate.segment_id) === String(row.segment_id)
          && String(candidate.unit_index) === String(row.unit_index)) === index);
      chunks.push({
        ...first,
        text: selected.map((row) => row.word).join(" "),
        caption_text: captionFragments.map((row) => row.text).join(" ").trim(),
        caption_fragments: captionFragments,
        source_segment_ids: [...new Set(sources.map((source) => source.source_segment_id))],
        source_speakers: [...new Set(sources.map((source) => source.source_speaker))],
        source_unit_indices: [...new Set(sources.map((source) => source.unit_index))],
        source_unit_refs: sourceUnitRefs,
        authored_qwen_instructions: [...new Set(sources.flatMap((source) => source.authored_qwen_instructions ?? []))],
        tts_override_replacements_applied: sources.flatMap((source) => source.tts_override_replacements_applied ?? [])
          .filter((row, index, rows) => rows.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(row)) === index),
        merge_barrier: run.some((source) => source.merge_barrier),
        ended_at_sentence_boundary: /[.!?]["'”’)]*$/u.test(selected.at(-1)?.word ?? ""),
      });
    }
  }

  return chunks.map((unit) => {
    const firstRef = unit.source_unit_refs[0] ?? { segment_id: unit.source_segment_id, unit_index: unit.unit_index };
    const identitySeed = {
      sources: unit.caption_fragments.map((row) => [
        row.segment_id,
        row.unit_index,
        row.caption_word_start,
        row.caption_word_end_exclusive,
      ]),
      spoken_text: unit.text,
    };
    const unitId = `tts_${slug(firstRef.segment_id)}_u${String(firstRef.unit_index ?? "x")}_${sha256Text(JSON.stringify(identitySeed)).slice(0, 12)}`;
    const count = wordCount(unit.text);
    const crossedSegment = unit.source_segment_ids.length > 1;
    const belowMin = count < minWordsLimit;
    return {
      ...unit,
      unit_id: unitId,
      segment_id: unitId,
      word_count: count,
      expected_duration_sec: Number((count / 210 * 60).toFixed(3)),
      target_duration_range_sec: {
        min: Number((count / 240 * 60).toFixed(3)),
        max: Number((count / 170 * 60).toFixed(3)),
      },
      chunk_policy: {
        sentence_bounded: unit.ended_at_sentence_boundary,
        sentence_boundary_preferred: true,
        min_words_target: minWordsLimit,
        max_words: maxWordsLimit,
        max_chars: maxCharsLimit,
        below_min_word_target: belowMin,
        short_chunk_reason: belowMin
          ? unit.merge_barrier
            ? "explicit_speaker_system_or_authored_barrier"
            : "end_of_compatible_synthesis_context"
          : null,
        crossed_segment_boundary: crossedSegment,
        crossed_instruction_boundary: !instructionField && unit.authored_qwen_instructions.length > 1,
        instruction_field_configured: instructionField ?? null,
        authored_instruction_count: unit.authored_qwen_instructions.length,
        authored_instruction_submitted: Boolean(instructionField && unit.qwen_instruct),
        narrator_only: narratorOnly,
      },
    };
  });
}

export function collectQwenUnitsForTests(plan, lock, options = {}) {
  return collectUnits(plan, lock, options);
}

function qwenRequestForUnit(unit, voice, index, instructionField = qwenInstructionField, speed = nativeSpeed) {
  const body = {
    model_id: "qwen-tts",
    init_audio: voice.init_audio,
    prompt: unit.text,
    language: "english",
    speed,
    track_id: 12000 + index,
  };
  const hasInstruction = Boolean(String(unit.qwen_instruct ?? "").trim());
  if (hasInstruction && instructionField) body[instructionField] = unit.qwen_instruct;
  return {
    body,
    instruction_delivery: {
      authored_instruction_present: hasInstruction,
      provider_endpoint: "/api/v6/voice/text_to_audio",
      provider_support_status: instructionField
        ? "explicit_operator_configured_provider_field"
        : "unsupported_by_current_modelslab_v6_contract_not_submitted",
      submitted: hasInstruction && Boolean(instructionField),
      submitted_field: hasInstruction ? instructionField : null,
      authored_instruction: hasInstruction ? unit.qwen_instruct : null,
      authored_instructions: Array.isArray(unit.authored_qwen_instructions)
        ? unit.authored_qwen_instructions
        : hasInstruction ? [unit.qwen_instruct] : [],
    },
    provider_model_attestation: "requested_qwen_tts_response_model_identity_not_attested",
  };
}

export function qwenRequestForUnitForTests(unit, voice, index, instructionField = null) {
  return qwenRequestForUnit(unit, voice, index, instructionField);
}

async function synthesizeUnit(
  unit,
  lock,
  index,
  previousResults = new Map(),
  previousContentResults = new Map(),
  previousUnitIds = new Map(),
) {
  const normalizedSpeaker = String(unit.speaker ?? "NARRATOR").toUpperCase();
  const voice = assertProductionVoiceRoute(unit, lock);
  const requestContract = qwenRequestForUnit(unit, voice, index);
  unit = {
    ...unit,
    synthesis_identity: synthesisIdentity(unit, voice),
  };
  const targetedSpeakerRegeneration = regenerateSpeakers.size > 0;
  const targetedUnitRegeneration = regenerateUnitIds.size > 0;
  const targetedRegeneration = targetedSpeakerRegeneration || targetedUnitRegeneration;
  const selectedForRegeneration = targetedUnitRegeneration
    ? regenerateUnitIds.has(String(unit.unit_id))
    : targetedSpeakerRegeneration
    ? regenerateSpeakers.has(normalizedSpeaker)
    : false;
  if (reuseUnchanged && !selectedForRegeneration) {
    const previous = takePreviousContentResult(previousContentResults, unit);
    if (previous?.wav && await exists(previous.wav)) {
      if (previous.voice_id !== unit.voice_id) {
        throw new Error(`Refusing unchanged Qwen TTS reuse for ${unit.segment_id}: previous voice '${previous.voice_id ?? "unknown"}' does not match current voice '${unit.voice_id}'.`);
      }
      return {
        ...unit,
        status: "reused_unchanged_previous_report",
        wav: previous.wav,
        duration_sec: await mediaDuration(previous.wav),
        previous_segment_id: previous.segment_id ?? null,
        previous_unit_index: previous.unit_index ?? null,
        instruction_delivery: requestContract.instruction_delivery,
        provider_model_attestation: requestContract.provider_model_attestation,
        unit_qa: previous.unit_qa ?? null,
      };
    }
  }
  if (targetedRegeneration && !selectedForRegeneration) {
    const previousById = previousUnitIds.get(String(unit.unit_id));
    const previous = reusablePreviousUnit(previousById, unit)
      ? previousById
      : previousResults.get(unitReuseKey(unit))
        ?? takePreviousContentResult(previousContentResults, unit);
    if (previous?.wav && await exists(previous.wav) && String(previous.voice_id) === String(unit.voice_id)) {
      if (previous.voice_id !== unit.voice_id) {
        throw new Error(`Refusing targeted Qwen TTS reuse for ${unit.segment_id}: previous voice '${previous.voice_id ?? "unknown"}' does not match current voice '${unit.voice_id}'.`);
      }
      return {
        ...unit,
        status: "reused_previous_report",
        wav: previous.wav,
        duration_sec: await mediaDuration(previous.wav),
        previous_voice_id: previous.voice_id,
        previous_status: previous.status,
        targeted_regeneration_skipped: true,
        instruction_delivery: requestContract.instruction_delivery,
        provider_model_attestation: requestContract.provider_model_attestation,
        unit_qa: previous.unit_qa ?? null,
      };
    }
    const scope = targetedUnitRegeneration
      ? `unit id(s) ${[...regenerateUnitIds].join(", ")}`
      : `speaker(s) ${[...regenerateSpeakers].join(", ")}`;
    throw new Error(`Targeted regeneration for ${scope} cannot reuse exact prior audio for ${unit.unit_id} ${unit.segment_id} ${unit.speaker}; refusing unintended generation.`);
  }
  const retryTag = selectedForRegeneration || force ? `-retry-${retryInvocationId}` : "";
  const basename = `${String(index + 1).padStart(4, "0")}-${slug(unit.unit_id)}-${slug(unit.speaker)}-${slug(unit.voice_id)}${retryTag}`;
  const wav = path.join(outDir, `${basename}.wav`);
  const meta = path.join(outDir, `${basename}.json`);
  const cachedMeta = await readJson(meta, null);
  const cacheMatchesUnit = cachedMeta?.synthesis_identity?.content_sha256 === unit.synthesis_identity.content_sha256;
  if (!force && !selectedForRegeneration && await exists(wav)) {
    if (cacheMatchesUnit) {
      return {
        ...unit,
        status: "reused",
        wav,
        duration_sec: await mediaDuration(wav),
        meta,
        synthesis_identity: unit.synthesis_identity,
        instruction_delivery: requestContract.instruction_delivery,
        provider_model_attestation: requestContract.provider_model_attestation,
        unit_qa: cachedMeta.unit_qa ?? null,
      };
    }
    await fs.rm(wav, { force: true });
  }
  if (dryRun) {
    return {
      ...unit,
      status: "dry_run",
      wav,
      meta,
      instruction_delivery: requestContract.instruction_delivery,
      provider_model_attestation: requestContract.provider_model_attestation,
    };
  }
  const makeRequest = () => post("/api/v6/voice/text_to_audio", requestContract.body);
  const previous = force || selectedForRegeneration || !cacheMatchesUnit ? null : cachedMeta;
  let initial = previous?.request?.id ? previous.request : await makeRequest();
  let resolved;
  let finalUrl = null;
  let lastError = null;
  const attempts = Number(process.env.ANIFACTORY_MODELSLAB_QWEN_UNIT_ATTEMPTS ?? 4);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await fs.writeFile(meta, JSON.stringify({
      request: initial,
      replaced_request: attempt === 1 ? null : previous?.request ?? null,
      attempt,
      unit,
      voice,
      synthesis_identity: unit.synthesis_identity,
      tts_native_speed: nativeSpeed,
      request_parameters: {
        model_id: "qwen-tts",
        language: "english",
        speed: nativeSpeed,
        qwen_instruct_field: requestContract.instruction_delivery.submitted_field,
      },
      instruction_delivery: requestContract.instruction_delivery,
      provider_model_attestation: requestContract.provider_model_attestation,
    }, null, 2));
    try {
      resolved = await resolveAudioResponse(initial);
      const url = audioLinks(resolved)[0];
      if (!url) throw new Error(`ModelsLab Qwen returned no audio URL for ${unit.segment_id}`);
      await fs.writeFile(meta, JSON.stringify({
        request: initial,
        resolved,
        unit,
        voice,
        synthesis_identity: unit.synthesis_identity,
        tts_native_speed: nativeSpeed,
        request_parameters: {
          model_id: "qwen-tts",
          language: "english",
          speed: nativeSpeed,
          qwen_instruct_field: requestContract.instruction_delivery.submitted_field,
        },
        instruction_delivery: requestContract.instruction_delivery,
        provider_model_attestation: requestContract.provider_model_attestation,
      }, null, 2));
      const ok = await downloadWhenReady(url, wav);
      if (!ok) throw new Error(`Timed out downloading ${url}`);
      finalUrl = url;
      break;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/Try Again|failed|Timed out polling|Timed out downloading|aborted/i.test(message) || attempt === attempts) break;
      initial = await makeRequest();
      await fs.writeFile(meta, JSON.stringify({
        request: initial,
        replaced_request: previous?.request ?? null,
        replacement_reason: message,
        attempt: attempt + 1,
        unit,
        voice,
        synthesis_identity: unit.synthesis_identity,
        tts_native_speed: nativeSpeed,
        request_parameters: {
          model_id: "qwen-tts",
          language: "english",
          speed: nativeSpeed,
          qwen_instruct_field: requestContract.instruction_delivery.submitted_field,
        },
        instruction_delivery: requestContract.instruction_delivery,
        provider_model_attestation: requestContract.provider_model_attestation,
      }, null, 2));
    }
  }
  if (!resolved) throw lastError ?? new Error(`ModelsLab Qwen did not resolve ${unit.segment_id}`);
  if (!finalUrl) throw lastError ?? new Error(`ModelsLab Qwen did not download audio for ${unit.segment_id}`);
  return {
    ...unit,
    status: "generated",
    wav,
    url: finalUrl,
    duration_sec: await mediaDuration(wav),
    meta,
    native_speed: nativeSpeed,
    instruction_delivery: requestContract.instruction_delivery,
    provider_model_attestation: requestContract.provider_model_attestation,
  };
}

function dbfs(amplitude) {
  const value = Math.abs(Number(amplitude ?? 0));
  return value > 0 ? Number((20 * Math.log10(value)).toFixed(3)) : null;
}

function pcmMetricsFromBuffer(buffer, sampleRate) {
  const sampleCount = Math.floor(buffer.length / 2);
  if (!sampleCount) {
    return {
      sample_rate: sampleRate,
      sample_count: 0,
      duration_sec: 0,
      peak_dbfs: null,
      rms_dbfs: null,
      leading_silence_sec: 0,
      trailing_silence_sec: 0,
      leading_silence_sample_count: 0,
      trailing_silence_sample_count: 0,
    };
  }
  let peak = 0;
  let sumSquares = 0;
  let sum = 0;
  let clippingSamples = 0;
  let maximumSampleStep = 0;
  let largeSampleStepCount = 0;
  let maximumIsolatedImpulse = 0;
  let isolatedImpulseCount = 0;
  const samples = new Float64Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = buffer.readInt16LE(index * 2) / 32768;
    samples[index] = sample;
    const absolute = Math.abs(sample);
    peak = Math.max(peak, absolute);
    sumSquares += sample * sample;
    sum += sample;
    if (absolute >= 0.999) clippingSamples += 1;
    if (index > 0) {
      const step = Math.abs(sample - samples[index - 1]);
      maximumSampleStep = Math.max(maximumSampleStep, step);
      if (step >= 0.3) largeSampleStepCount += 1;
    }
  }
  for (let index = 1; index < sampleCount - 1; index += 1) {
    const left = samples[index - 1];
    const center = samples[index];
    const right = samples[index + 1];
    const impulse = Math.abs(center - ((left + right) / 2));
    const neighborDifference = Math.abs(left - right);
    maximumIsolatedImpulse = Math.max(maximumIsolatedImpulse, impulse);
    if (impulse >= 0.45 && neighborDifference <= 0.12) isolatedImpulseCount += 1;
  }
  const frameSamples = Math.max(1, Math.round(sampleRate * 0.005));
  let firstActiveSample = sampleCount;
  let lastActiveSample = -1;
  const activeFrames = [];
  for (let start = 0; start < sampleCount; start += frameSamples) {
    const end = Math.min(sampleCount, start + frameSamples);
    let frameSquares = 0;
    let framePeak = 0;
    for (let index = start; index < end; index += 1) {
      const value = samples[index];
      frameSquares += value * value;
      framePeak = Math.max(framePeak, Math.abs(value));
    }
    const frameRms = Math.sqrt(frameSquares / Math.max(1, end - start));
    if (frameRms >= 0.00316 || framePeak >= 0.01259) {
      firstActiveSample = Math.min(firstActiveSample, start);
      lastActiveSample = Math.max(lastActiveSample, end - 1);
      activeFrames.push({ start_sample: start, end_sample: end });
    }
  }
  const activeIntervals = [];
  for (const frame of activeFrames) {
    const previous = activeIntervals.at(-1);
    if (previous && frame.start_sample - previous.end_sample <= Math.round(sampleRate * 0.02)) {
      previous.end_sample = frame.end_sample;
    } else {
      activeIntervals.push({ ...frame });
    }
  }
  const windowPeak = (seconds) => {
    const count = Math.max(1, Math.round(sampleRate * seconds));
    let value = 0;
    for (let index = Math.max(0, sampleCount - count); index < sampleCount; index += 1) value = Math.max(value, Math.abs(samples[index]));
    return value;
  };
  const windowRms = (seconds) => {
    const count = Math.max(1, Math.round(sampleRate * seconds));
    let squares = 0;
    const start = Math.max(0, sampleCount - count);
    for (let index = start; index < sampleCount; index += 1) squares += samples[index] * samples[index];
    return Math.sqrt(squares / Math.max(1, sampleCount - start));
  };
  const durationSec = sampleCount / sampleRate;
  const leadingSilenceSec = firstActiveSample === sampleCount ? durationSec : firstActiveSample / sampleRate;
  const trailingSilenceSec = lastActiveSample < 0 ? durationSec : Math.max(0, (sampleCount - lastActiveSample - 1) / sampleRate);
  return {
    sample_rate: sampleRate,
    sample_count: sampleCount,
    duration_sec: Number(durationSec.toFixed(6)),
    peak_dbfs: dbfs(peak),
    rms_dbfs: dbfs(Math.sqrt(sumSquares / sampleCount)),
    dc_offset: Number((sum / sampleCount).toFixed(8)),
    dc_offset_dbfs: dbfs(sum / sampleCount),
    clipping_sample_count: clippingSamples,
    clipping_ratio: Number((clippingSamples / sampleCount).toFixed(8)),
    maximum_sample_step_dbfs: dbfs(maximumSampleStep),
    large_sample_step_count: largeSampleStepCount,
    maximum_isolated_impulse_dbfs: dbfs(maximumIsolatedImpulse),
    isolated_impulse_count: isolatedImpulseCount,
    first_sample_dbfs: dbfs(samples[0]),
    last_sample_dbfs: dbfs(samples[sampleCount - 1]),
    leading_silence_sec: Number(leadingSilenceSec.toFixed(6)),
    trailing_silence_sec: Number(trailingSilenceSec.toFixed(6)),
    leading_silence_sample_count: firstActiveSample === sampleCount
      ? sampleCount
      : firstActiveSample,
    trailing_silence_sample_count: lastActiveSample < 0
      ? sampleCount
      : Math.max(0, sampleCount - lastActiveSample - 1),
    active_start_sec: Number((firstActiveSample === sampleCount ? 0 : firstActiveSample / sampleRate).toFixed(6)),
    active_end_sec: Number((lastActiveSample < 0 ? 0 : (lastActiveSample + 1) / sampleRate).toFixed(6)),
    active_intervals_sec: activeIntervals.map((row) => ({
      start_sec: Number((row.start_sample / sampleRate).toFixed(6)),
      end_sec: Number((row.end_sample / sampleRate).toFixed(6)),
    })),
    tail_10ms_peak_dbfs: dbfs(windowPeak(0.01)),
    tail_50ms_rms_dbfs: dbfs(windowRms(0.05)),
  };
}

async function audioPcmMetrics(filePath) {
  const pcm = await runBinary("ffmpeg", [
    "-nostdin",
    "-v", "error",
    "-i", filePath,
    "-map", "0:a:0",
    "-ac", "1",
    "-ar", String(stitchSampleRate),
    "-f", "s16le",
    "pipe:1",
  ]);
  return pcmMetricsFromBuffer(pcm, stitchSampleRate);
}

function audioQaFindings(metrics, unit, {
  minTrailingSilence = unitQaMinTrailingSilenceSec,
} = {}) {
  const findings = [];
  const push = (severity, code, details = {}) => findings.push({ severity, code, ...details });
  if (!metrics?.sample_count || metrics.duration_sec <= 0) {
    push("blocker", "tts_audio_empty");
    return findings;
  }
  if (metrics.duration_sec < 0.18) {
    push("warning", "tts_audio_implausibly_short", {
      duration_sec: metrics.duration_sec,
      review_required: true,
      automatic_retry_allowed: false,
      blocks_stitching: false,
    });
  }
  if (metrics.clipping_ratio >= 0.0005) {
    push("warning", "tts_audio_clipping", {
      clipping_ratio: metrics.clipping_ratio,
      peak_dbfs: metrics.peak_dbfs,
      review_required: true,
      automatic_retry_allowed: false,
      blocks_stitching: false,
    });
  } else if (metrics.clipping_sample_count > 0) {
    push("warning", "tts_audio_peak_touches_full_scale", { clipping_sample_count: metrics.clipping_sample_count });
  }
  if (Number(metrics.isolated_impulse_count ?? 0) > 0
    && Number.isFinite(metrics.maximum_isolated_impulse_dbfs)
    && metrics.maximum_isolated_impulse_dbfs > -3.5) {
    push("warning", "tts_audio_impulsive_discontinuity", {
      maximum_sample_step_dbfs: metrics.maximum_sample_step_dbfs,
      large_sample_step_count: metrics.large_sample_step_count,
      maximum_isolated_impulse_dbfs: metrics.maximum_isolated_impulse_dbfs,
      isolated_impulse_count: metrics.isolated_impulse_count,
      review_required: true,
      automatic_retry_allowed: false,
      blocks_stitching: false,
    });
  } else if (Number(metrics.isolated_impulse_count ?? 0) > 0
    && Number.isFinite(metrics.maximum_isolated_impulse_dbfs)
    && metrics.maximum_isolated_impulse_dbfs > -8) {
    push("warning", "tts_audio_possible_impulsive_click", {
      maximum_sample_step_dbfs: metrics.maximum_sample_step_dbfs,
      large_sample_step_count: metrics.large_sample_step_count,
      maximum_isolated_impulse_dbfs: metrics.maximum_isolated_impulse_dbfs,
      isolated_impulse_count: metrics.isolated_impulse_count,
    });
  }
  if (Number.isFinite(metrics.last_sample_dbfs) && metrics.last_sample_dbfs > -36) {
    push("warning", "tts_audio_endpoint_discontinuity", {
      last_sample_dbfs: metrics.last_sample_dbfs,
      review_required: true,
      automatic_retry_allowed: false,
      blocks_stitching: false,
    });
  }
  const energeticTail = (Number.isFinite(metrics.tail_10ms_peak_dbfs) && metrics.tail_10ms_peak_dbfs > -35)
    || (Number.isFinite(metrics.tail_50ms_rms_dbfs) && metrics.tail_50ms_rms_dbfs > -38);
  if (metrics.trailing_silence_sec < minTrailingSilence && energeticTail) {
    push("warning", "tts_audio_tail_not_settled", {
      trailing_silence_sec: metrics.trailing_silence_sec,
      required_sec: minTrailingSilence,
      tail_10ms_peak_dbfs: metrics.tail_10ms_peak_dbfs,
      tail_50ms_rms_dbfs: metrics.tail_50ms_rms_dbfs,
      review_required: true,
      automatic_retry_allowed: false,
      blocks_stitching: false,
    });
  } else if (metrics.trailing_silence_sec < 0.08) {
    push("warning", "tts_audio_tail_margin_narrow", { trailing_silence_sec: metrics.trailing_silence_sec });
  }
  if (metrics.leading_silence_sec < 0.005) {
    push("warning", "tts_audio_leading_margin_narrow", { leading_silence_sec: metrics.leading_silence_sec });
  }
  if (Number.isFinite(metrics.rms_dbfs) && (metrics.rms_dbfs < -42 || metrics.rms_dbfs > -8)) {
    push("warning", "tts_audio_loudness_outlier", { rms_dbfs: metrics.rms_dbfs });
  }
  const wordTotal = Number(unit?.word_count ?? wordCount(unit?.text));
  const minimumPlausible = wordTotal > 0 ? wordTotal / 330 * 60 : 0;
  const maximumPlausible = wordTotal > 0 ? wordTotal / 90 * 60 : Number.POSITIVE_INFINITY;
  if (wordTotal >= 8 && metrics.duration_sec < minimumPlausible) {
    push("warning", "tts_audio_duration_too_short_for_text", {
      duration_sec: metrics.duration_sec,
      word_count: wordTotal,
      review_required: true,
      automatic_retry_allowed: false,
      blocks_stitching: false,
    });
  }
  if (wordTotal >= 8 && metrics.duration_sec > maximumPlausible) {
    push("warning", "tts_audio_duration_too_long_for_text", {
      duration_sec: metrics.duration_sec,
      word_count: wordTotal,
      review_required: true,
      automatic_retry_allowed: false,
      blocks_stitching: false,
    });
  }
  return findings;
}

export function audioQaFindingsForTests(metrics, unit, options = {}) {
  return audioQaFindings(metrics, unit, options);
}

const TRANSCRIPT_INITIALISMS = new Set([
  "sss", "ss", "xp", "hp", "mp", "dps", "aoe",
  "ceo", "cfo", "coo", "cto", "cio", "cmo", "hr", "pr", "ai", "ui", "ux",
  "api", "fbi", "irs", "sec", "nda", "llc", "ipo", "dna", "gps", "usb",
  "pdf", "url", "vip", "id", "mc",
]);
const NUMBER_UNITS = new Map(Object.entries({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
}));
const NUMBER_TENS = new Map(Object.entries({
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}));
const NUMBER_SCALES = new Map(Object.entries({ thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 }));
const ORDINAL_VALUES = new Map(Object.entries({
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50,
  sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90,
}));
const DECADE_VALUES = new Map(Object.entries({
  twenties: 20, thirties: 30, forties: 40, fifties: 50,
  sixties: 60, seventies: 70, eighties: 80, nineties: 90,
}));

function transcriptInputText(value) {
  return Array.isArray(value)
    ? value.map((row) => String(row?.word ?? row ?? "")).join(" ")
    : String(value ?? "");
}

export const TRANSCRIPT_QA_COMPARISON_VERSION = "unicode_words_exact_im_numeric_article_contraction_phonetic_v8";

const TRANSCRIPT_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "…"]);

function rawTranscriptTokens(value) {
  return (transcriptInputText(value)
    .normalize("NFC")
    .replace(/−/g, "-")
    .replace(/\b(\d{1,3})\s+,(\d{3})\b/g, "$1,$2")
    .replace(/([+-])\s*\$\s*(?=\d)/g, (_match, sign) => `$${sign}`)
    .replace(/\$\s*([+-])\s+(?=\d)/g, (_match, sign) => `$${sign}`)
    // Comparison equivalence only: preserve the source and recognized text.
    // Do not expand ambiguous 's/'d forms or an unpunctuated name such as Im.
    .replace(/(?<![\p{L}\p{M}])I['’]m(?![\p{L}\p{M}])/giu, "I am")
    .replace(/\b(thousand|million|billion)fold\b/gi, "$1 fold")
    .replace(/([\p{L}\p{M}])[-‐‑‒–—]([\p{L}\p{M}])/gu, "$1 $2")
    .match(/[+-]?\d+(?:,\d{3})*(?:\.\d+)?(?:st|nd|rd|th|%|[xXsS])?|\bSt\.|[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)?|[/$%.,;:!?…]/giu) ?? [])
    .map((raw) => {
      const lower = raw.toLowerCase();
      if (lower === "st.") return "saint";
      // Preserve the lexical contraction; stripping its apostrophe creates the
      // unrelated protected initialism ID. Its had/would sense is not inferred.
      if (/^i['’]d$/.test(lower)) return "i'd";
      if (TRANSCRIPT_PUNCTUATION.has(lower)) return lower;
      if (/^[+-]?\d/.test(lower) || ["/", "%", "$"].includes(lower)) return lower.replaceAll(",", "");
      return lower.replace(/[.'’]/g, "").replace(/[^\p{L}\p{M}0-9]+/gu, "");
    })
    .filter(Boolean);
}

function normalizedNumberString(value) {
  if (!Number.isFinite(value)) return null;
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(12)));
}

function parseBelowHundred(tokens, start) {
  const token = tokens[start];
  if (NUMBER_UNITS.has(token)) return { value: NUMBER_UNITS.get(token), end: start + 1 };
  if (!NUMBER_TENS.has(token)) return null;
  const unit = NUMBER_UNITS.get(tokens[start + 1]);
  return unit > 0 && unit < 10
    ? { value: NUMBER_TENS.get(token) + unit, end: start + 2 }
    : { value: NUMBER_TENS.get(token), end: start + 1 };
}

function parseCardinalGroup(tokens, start) {
  let group = tokens[start] === "a" && tokens[start + 1] === "hundred"
    ? { value: 1, end: start + 1 }
    : parseBelowHundred(tokens, start);
  if (tokens[start] === "hundred") group = { value: 100, end: start + 1 };
  else if (group?.value > 0 && tokens[group.end] === "hundred") {
    // Conventional forms include "twelve hundred" and "twenty-five hundred".
    group = { value: group.value * 100, end: group.end + 1 };
  }
  else return group;
  const remainderStart = group.end + (tokens[group.end] === "and" ? 1 : 0);
  const remainder = parseBelowHundred(tokens, remainderStart);
  // "One hundred and two hundred" is two amounts, not 102 * 100.
  if (remainder && tokens[remainder.end] !== "hundred") {
    return { value: group.value + remainder.value, end: remainder.end };
  }
  return group;
}

function parseNumberAt(tokens, start) {
  const token = String(tokens[start] ?? "");
  if (ORDINAL_VALUES.has(token)) {
    return { value: String(ORDINAL_VALUES.get(token)), end: start + 1, suffix: "ordinal" };
  }
  if (DECADE_VALUES.has(token)) {
    return { value: String(DECADE_VALUES.get(token)), end: start + 1, suffix: "decade" };
  }
  const directOrdinal = token.match(/^([+-]?\d+)(?:st|nd|rd|th)$/i);
  if (directOrdinal) {
    return { value: normalizedNumberString(Number(directOrdinal[1])), end: start + 1, suffix: "ordinal" };
  }
  const direct = token.match(/^([+-]?\d+(?:\.\d+)?)([%xs])?$/i);
  if (direct) {
    let value = Number(direct[1]);
    let end = start + 1;
    if (!direct[2] && NUMBER_SCALES.has(tokens[end])) {
      value *= NUMBER_SCALES.get(tokens[end]);
      end += 1;
    }
    return {
      value: normalizedNumberString(value),
      end,
      suffix: direct[2]?.toLowerCase() === "s" ? "decade" : direct[2]?.toLowerCase() ?? null,
    };
  }
  let index = start;
  let negative = false;
  if (tokens[index] === "negative" || tokens[index] === "minus") {
    negative = true;
    index += 1;
  }
  const implicitArticle = tokens[index] === "a"
    && (tokens[index + 1] === "hundred" || NUMBER_SCALES.has(tokens[index + 1]));
  let total = 0;
  let previousScale = Infinity;
  let sawNumber = false;
  while (index < tokens.length) {
    let groupStart = index;
    // A comma/and may connect descending scales, but never independent amounts
    // with repeated/increasing scales. Other punctuation always ends a number.
    if (sawNumber && tokens[groupStart] === ",") groupStart += 1;
    if (sawNumber && tokens[groupStart] === "and") groupStart += 1;
    const group = tokens[groupStart] === "a" && NUMBER_SCALES.has(tokens[groupStart + 1])
      ? { value: 1, end: groupStart + 1 }
      : !sawNumber && NUMBER_SCALES.has(tokens[groupStart])
      ? { value: 1, end: groupStart }
      : parseCardinalGroup(tokens, groupStart);
    if (!group) break;
    let value = group.value;
    let end = group.end;
    if (tokens[end] === "point") {
      let decimalDigits = "";
      let cursor = end + 1;
      while (NUMBER_UNITS.has(tokens[cursor]) && NUMBER_UNITS.get(tokens[cursor]) <= 9) {
        decimalDigits += String(NUMBER_UNITS.get(tokens[cursor]));
        cursor += 1;
      }
      if (decimalDigits) {
        value = Number(`${value}.${decimalDigits}`);
        end = cursor;
      }
    }
    const scale = NUMBER_SCALES.get(tokens[end]) ?? 1;
    if (scale >= previousScale || value * scale >= previousScale) break;
    total += value * scale;
    sawNumber = true;
    index = end + (scale > 1 ? 1 : 0);
    if (scale === 1) break;
    previousScale = scale;
  }
  if (!sawNumber) return null;
  return {
    value: normalizedNumberString(negative ? -total : total),
    end: index,
    suffix: null,
    implicit_article: implicitArticle,
  };
}

function canonicalTranscriptTokensWithoutAliases(value, preserveBoundaries = false) {
  const base = rawTranscriptTokens(value);
  const compounds = [];
  for (let index = 0; index < base.length; index += 1) {
    if (base[index] === "live" && base[index + 1] === "stream") {
      compounds.push("livestream");
      index += 1;
    } else if (base[index] === "live" && base[index + 1] === "streaming") {
      compounds.push("livestreaming");
      index += 1;
    } else if (base[index] === "deed" && base[index + 1] === "holder") {
      compounds.push("deedholder");
      index += 1;
    } else if (base[index] === "for" && base[index + 1] === "closure") {
      compounds.push("foreclosure");
      index += 1;
    } else if (base[index] === "counter" && base[index + 1] === "claim") {
      compounds.push("counterclaim");
      index += 1;
    } else if (base[index] === "after" && base[index + 1] === "life") {
      compounds.push("afterlife");
      index += 1;
    } else if (base[index] === "all" && base[index + 1] === "right") {
      // These spellings are acoustically indistinguishable. Preserve both
      // source and ASR transcripts while comparing one spoken token.
      compounds.push("alright");
      index += 1;
    } else if (base[index] === "door" && base[index + 1] === "frame") {
      compounds.push("doorframe");
      index += 1;
    } else if (base[index] === "bed" && base[index + 1] === "frame") {
      compounds.push("bedframe");
      index += 1;
    } else if (base[index] === "cold" && base[index + 1] === "water") {
      compounds.push("coldwater");
      index += 1;
    } else if (base[index] === "wi" && base[index + 1] === "fi") {
      compounds.push("wifi");
      index += 1;
    } else if (base[index] === "every" && base[index + 1] === "body") {
      compounds.push("everybody");
      index += 1;
    } else {
      compounds.push(base[index]);
    }
  }
  const output = [];
  for (let index = 0; index < compounds.length;) {
    if (TRANSCRIPT_PUNCTUATION.has(compounds[index])) {
      if (preserveBoundaries) output.push("transcript_boundary");
      index += 1;
      continue;
    }
    const dollarSymbol = compounds[index] === "$";
    const parsed = parseNumberAt(compounds, index + (dollarSymbol ? 1 : 0));
    if (parsed?.value != null) {
      if (compounds[index - 1] === "the" && output.at(-1) === "the") {
        output[output.length - 1] = "numeric_article:the";
      }
      const ratioMarker = compounds[parsed.end] === "/" || (
        compounds[parsed.end] === "out" && compounds[parsed.end + 1] === "of"
      );
      const ratioStart = compounds[parsed.end] === "/" ? parsed.end + 1 : parsed.end + 2;
      const right = ratioMarker ? parseNumberAt(compounds, ratioStart) : null;
      if (right?.value != null) {
        output.push(`ratio:${parsed.value}/${right.value}`);
        index = right.end;
        continue;
      }
      const suffix = parsed.suffix
        ?? (compounds[parsed.end] === "%" || compounds[parsed.end] === "percent" ? "percent" : null)
        ?? (compounds[parsed.end] === "times" ? "times" : null);
      const numberToken = suffix === "%" || suffix === "percent"
        ? `pct:${parsed.value}`
        : suffix === "x" || suffix === "times"
        ? `times:${parsed.value}`
        : suffix === "ordinal"
        ? `ord:${parsed.value}`
        : suffix === "decade"
        ? `decade:${parsed.value}`
        : `${dollarSymbol ? "usd" : "num"}:${parsed.value}`;
      output.push(parsed.implicit_article ? `implicit_article:${numberToken}` : numberToken);
      index = parsed.end + (parsed.suffix ? 0 : suffix ? 1 : 0);
      // Retain source adjacency before punctuation is discarded. An unrelated
      // "Dollars" in the following sentence cannot supply this amount's unit.
      if (!suffix && /^dollars?$/.test(compounds[index] ?? "")) {
        output.push(`currency_unit:${compounds[index]}`);
        index += 1;
      }
      continue;
    }
    if (/^[a-z]$/.test(compounds[index])) {
      let end = index;
      let letters = "";
      while (end < compounds.length && /^[a-z]$/.test(compounds[end])) {
        letters += compounds[end];
        end += 1;
        if (compounds[end] === ".") end += 1;
      }
      if (letters.length >= 2) {
        output.push(`abbr:${letters}`);
        index = end;
        continue;
      }
    }
    if (TRANSCRIPT_INITIALISMS.has(compounds[index])) {
      output.push(`abbr:${compounds[index]}`);
    } else if (compounds[index] === "s" && compounds[index + 1] === "rank") {
      output.push("abbr:s");
    } else {
      output.push(compounds[index]);
    }
    index += 1;
  }
  return output;
}

function replaceTokenSequence(tokens, pattern, replacement) {
  if (!pattern.length) return tokens;
  const output = [];
  for (let index = 0; index < tokens.length;) {
    const matches = pattern.every((token, offset) => tokens[index + offset] === token);
    if (matches) {
      output.push(replacement);
      index += pattern.length;
    } else {
      output.push(tokens[index]);
      index += 1;
    }
  }
  return output;
}

function transcriptTokens(value, equivalentPhrases = [], preserveBoundaries = false) {
  let tokens = canonicalTranscriptTokensWithoutAliases(value, preserveBoundaries);
  const aliases = equivalentPhrases.flatMap((row, index) => {
    const from = canonicalTranscriptTokensWithoutAliases(row?.from ?? "");
    const to = canonicalTranscriptTokensWithoutAliases(row?.to ?? "");
    if (!from.length || !to.length) return [];
    const alias = `alias:${sha256Text(JSON.stringify([index, from, to])).slice(0, 12)}`;
    return [{ pattern: from, alias }, { pattern: to, alias }];
  }).sort((left, right) => right.pattern.length - left.pattern.length);
  for (const { pattern, alias } of aliases) tokens = replaceTokenSequence(tokens, pattern, alias);
  return tokens;
}

function alignTranscriptNotation(intendedTokens, recognizedTokens) {
  const stripSymbol = (token) => token.replace(/^implicit_article:/, "")
    .replace(/^usd:/, "num:").replace(/^(?:currency_unit|numeric_article):/, "");
  const intended = intendedTokens.map(stripSymbol);
  const recognized = recognizedTokens.map(stripSymbol);
  if (![...intendedTokens, ...recognizedTokens].some((token) => /^(?:implicit_article:)?usd:|^implicit_article:/.test(token))) {
    return { intended, recognized };
  }
  const intendedUnits = new Map();
  const recognizedUnits = new Map();
  const intendedArticles = new Map();
  const recognizedArticles = new Map();
  const dollarSymbol = (token) => /^(?:implicit_article:)?usd:/.test(token);
  const dollarUnit = (token) => /^currency_unit:dollars?$/.test(token ?? "");
  let left = 0;
  let right = 0;
  // The symbol supplies a spoken currency unit only beside an aligned equal
  // amount. Without a symbol, an omitted "dollar" remains an omitted word.
  for (const operation of transcriptAlignment(intended, recognized)) {
    if (operation.type === "match" && operation.intended.startsWith("num:")) {
      // Restore only an actual consumed "a", opposite an adjacent literal
      // "the". "The thousand" / "a thousand" is an article substitution;
      // plain 1000 cannot invent an article or hide an omitted "the".
      if (intendedTokens[left].startsWith("implicit_article:")
        && recognizedTokens[right - 1] === "numeric_article:the") intendedArticles.set(left, "a");
      if (recognizedTokens[right].startsWith("implicit_article:")
        && intendedTokens[left - 1] === "numeric_article:the") recognizedArticles.set(right, "a");
      if (dollarSymbol(intendedTokens[left])
        && dollarUnit(recognizedTokens[right + 1]) && !dollarUnit(intendedTokens[left + 1])) {
        intendedUnits.set(left, recognized[right + 1]);
      }
      if (dollarSymbol(recognizedTokens[right])
        && dollarUnit(intendedTokens[left + 1]) && !dollarUnit(recognizedTokens[right + 1])) {
        recognizedUnits.set(right, intended[left + 1]);
      }
    }
    if (operation.type !== "insertion") left += 1;
    if (operation.type !== "deletion") right += 1;
  }
  const withNotation = (tokens, articles, units) => tokens.flatMap((token, index) => (
    [...(articles.has(index) ? [articles.get(index)] : []), token, ...(units.has(index) ? [units.get(index)] : [])]
  ));
  return {
    intended: withNotation(intended, intendedArticles, intendedUnits),
    recognized: withNotation(recognized, recognizedArticles, recognizedUnits),
  };
}

function transcriptAlignment(intended, recognized) {
  const rows = intended.length + 1;
  const columns = recognized.length + 1;
  const scores = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let left = 0; left < rows; left += 1) scores[left][0] = left;
  for (let right = 0; right < columns; right += 1) scores[0][right] = right;
  for (let left = 1; left < rows; left += 1) {
    for (let right = 1; right < columns; right += 1) {
      const substitution = scores[left - 1][right - 1] + (intended[left - 1] === recognized[right - 1] ? 0 : 1);
      scores[left][right] = Math.min(substitution, scores[left - 1][right] + 1, scores[left][right - 1] + 1);
    }
  }
  const operations = [];
  let left = intended.length;
  let right = recognized.length;
  while (left > 0 || right > 0) {
    if (left > 0 && right > 0) {
      const cost = intended[left - 1] === recognized[right - 1] ? 0 : 1;
      if (scores[left][right] === scores[left - 1][right - 1] + cost) {
        operations.push({
          type: cost === 0 ? "match" : "substitution",
          intended: intended[left - 1],
          recognized: recognized[right - 1],
        });
        left -= 1;
        right -= 1;
        continue;
      }
    }
    if (left > 0 && scores[left][right] === scores[left - 1][right] + 1) {
      operations.push({ type: "deletion", intended: intended[left - 1], recognized: null });
      left -= 1;
      continue;
    }
    operations.push({ type: "insertion", intended: null, recognized: recognized[right - 1] });
    right -= 1;
  }
  return operations.reverse();
}

function longestRun(operations, type) {
  let longest = 0;
  let current = 0;
  for (const operation of operations) {
    if (operation.type === type) {
      current += 1;
      longest = Math.max(longest, current);
    } else current = 0;
  }
  return longest;
}

function transcriptBoundaryPositions(text, expectedLength, equivalentPhrases) {
  const tokens = transcriptTokens(text, equivalentPhrases, true);
  let wordIndex = 0;
  const positions = new Set();
  for (const token of tokens) {
    if (token === "transcript_boundary") positions.add(wordIndex);
    else wordIndex += 1;
  }
  // Currency/article expansion or an alias spanning punctuation changes the
  // coordinates. Do not guess an alignment in that case.
  return wordIndex === expectedLength ? positions : null;
}

function alignContractionRecognition(operations, intended, recognized, intendedText, recognizedText, equivalentPhrases) {
  if (!operations.some((row) => row.type !== "match" && [row.intended, row.recognized].includes("gonna"))) return [];
  const leftBoundaries = transcriptBoundaryPositions(intendedText, intended.length, equivalentPhrases);
  const rightBoundaries = transcriptBoundaryPositions(recognizedText, recognized.length, equivalentPhrases);
  if (!leftBoundaries || !rightBoundaries) return [];
  const normalized = [];
  const equivalences = [];
  let left = 0;
  let right = 0;
  for (let index = 0; index < operations.length; index += 1) {
    const pair = operations.slice(index, index + 2);
    const source = pair.flatMap((row) => row.intended == null ? [] : [row.intended]);
    const heard = pair.flatMap((row) => row.recognized == null ? [] : [row.recognized]);
    const expanded = source.join(" ") === "going to" && heard.join(" ") === "gonna"
      && !leftBoundaries.has(left + 1);
    const contracted = source.join(" ") === "gonna" && heard.join(" ") === "going to"
      && !rightBoundaries.has(right + 1);
    if (pair.length === 2 && (expanded || contracted)
      && leftBoundaries.has(left) === rightBoundaries.has(right)
      && leftBoundaries.has(left + source.length) === rightBoundaries.has(right + heard.length)) {
      // Rewrite only recognition notation at this aligned span. The intended
      // tokens retain stable source coordinates and omissions retain both words.
      normalized.push(...source.map((token) => ({ type: "match", intended: token, recognized: token })));
      equivalences.push({ intended_index: left, recognized_index: right, intended: source.join(" "), recognized: heard.join(" "), rule: "explicit_going_to_gonna" });
      left += source.length;
      right += heard.length;
      index += 1;
    } else {
      const operation = operations[index];
      normalized.push(operation);
      if (operation.type !== "insertion") left += 1;
      if (operation.type !== "deletion") right += 1;
    }
  }
  operations.splice(0, operations.length, ...normalized);
  recognized.splice(0, recognized.length, ...normalized.flatMap((row) => row.recognized == null ? [] : [row.recognized]));
  return equivalences;
}

function alignTwoRecognitionSpelling(operations, intended, recognized, intendedText, recognizedText, equivalentPhrases) {
  if (!operations.some((row) => row.type === "substitution"
    && ((row.intended === "num:2" && row.recognized === "too")
      || (row.intended === "too" && row.recognized === "num:2")))) return [];
  const leftBoundaries = transcriptBoundaryPositions(intendedText, intended.length, equivalentPhrases);
  const rightBoundaries = transcriptBoundaryPositions(recognizedText, recognized.length, equivalentPhrases);
  if (!leftBoundaries || !rightBoundaries) return [];
  const equivalences = [];
  let left = 0;
  let right = 0;
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const previous = operations[index - 1];
    const next = operations[index + 1];
    if (operation.type === "substitution"
      && ((operation.intended === "num:2" && operation.recognized === "too")
        || (operation.intended === "too" && operation.recognized === "num:2"))
      && (!previous || previous.type === "match") && (!next || next.type === "match")
      && leftBoundaries.has(left) === rightBoundaries.has(right)
      && leftBoundaries.has(left + 1) === rightBoundaries.has(right + 1)
      && (operation.intended !== "too" || leftBoundaries.has(left + 1))) {
      // The approved value supplies meaning; ASR supplies an explicit homophone
      // at that same position. Never invent a missing token or reinterpret "to".
      recognized[right] = operation.intended;
      operations[index] = { type: "match", intended: operation.intended, recognized: operation.intended };
      equivalences.push({ intended_index: left, recognized_index: right, intended: operation.intended, recognized: operation.recognized, rule: "aligned_two_too_spelling" });
    }
    if (operation.type !== "insertion") left += 1;
    if (operation.type !== "deletion") right += 1;
  }
  return equivalences;
}

const ALIGNED_HOMOPHONE_SPELLINGS = new Map([
  ["flour", "flower"], ["flower", "flour"],
  ["queue", "cue"], ["cue", "queue"],
]);

function alignLiteralHomophoneRecognition(operations, intended, recognized, intendedText, recognizedText, equivalentPhrases) {
  if (!operations.some((row) => row.type === "substitution"
    && ALIGNED_HOMOPHONE_SPELLINGS.get(row.intended) === row.recognized)) return [];
  const leftBoundaries = transcriptBoundaryPositions(intendedText, intended.length, equivalentPhrases);
  const rightBoundaries = transcriptBoundaryPositions(recognizedText, recognized.length, equivalentPhrases);
  if (!leftBoundaries || !rightBoundaries) return [];
  const equivalences = [];
  let left = 0;
  let right = 0;
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const previous = operations[index - 1];
    const next = operations[index + 1];
    if (operation.type === "substitution"
      && ALIGNED_HOMOPHONE_SPELLINGS.get(operation.intended) === operation.recognized
      && (!previous || previous.type === "match") && (!next || next.type === "match")
      && (previous?.type === "match" || next?.type === "match")
      && leftBoundaries.has(left) === rightBoundaries.has(right)
      && leftBoundaries.has(left + 1) === rightBoundaries.has(right + 1)) {
      // Only the ASR spelling changes at this already aligned spoken word.
      // Source tokens, missing words, adjacent edits, and sentence boundaries
      // remain available to the delivery gate.
      recognized[right] = operation.intended;
      operations[index] = { type: "match", intended: operation.intended, recognized: operation.intended };
      equivalences.push({
        intended_index: left, recognized_index: right,
        intended: operation.intended, recognized: operation.recognized,
        rule: "aligned_literal_homophone_spelling",
      });
    }
    if (operation.type !== "insertion") left += 1;
    if (operation.type !== "deletion") right += 1;
  }
  return equivalences;
}

function transcriptQa(intendedText, recognizedText, {
  maxWer = unitQaMaxWer,
  equivalentPhrases = [],
  blockAnySubstitution = true,
  blockIsolatedEdits = true,
} = {}) {
  const wordsOnly = (tokens) => tokens.filter((token) => !TRANSCRIPT_PUNCTUATION.has(token) && token !== "$");
  const intendedRaw = wordsOnly(rawTranscriptTokens(intendedText));
  const recognizedRaw = wordsOnly(rawTranscriptTokens(recognizedText));
  const { intended, recognized } = alignTranscriptNotation(
    transcriptTokens(intendedText, equivalentPhrases), transcriptTokens(recognizedText, equivalentPhrases),
  );
  const operations = transcriptAlignment(intended, recognized);
  const phoneticSpellingEquivalences = alignContractionRecognition(
    operations, intended, recognized, intendedText, recognizedText, equivalentPhrases,
  );
  phoneticSpellingEquivalences.push(...alignTwoRecognitionSpelling(
    operations, intended, recognized, intendedText, recognizedText, equivalentPhrases,
  ));
  phoneticSpellingEquivalences.push(...alignLiteralHomophoneRecognition(
    operations, intended, recognized, intendedText, recognizedText, equivalentPhrases,
  ));
  // Preserve edge identity for dual-ASR delivery QA. A clipped syllable can
  // align as a substitution rather than a missing word.
  const firstIntendedOperation = operations.find((row) => row.intended != null);
  const lastIntendedOperation = operations.findLast((row) => row.intended != null);
  const deletions = operations.filter((row) => row.type === "deletion").length;
  const insertions = operations.filter((row) => row.type === "insertion").length;
  const substitutions = operations.filter((row) => row.type === "substitution").length;
  const errors = deletions + insertions + substitutions;
  const wer = intended.length ? errors / intended.length : recognized.length ? 1 : 0;
  const deletionRun = longestRun(operations, "deletion");
  const insertionRun = longestRun(operations, "insertion");
  let leadingDeletionRun = 0;
  for (const operation of operations) {
    if (operation.type === "insertion") continue;
    if (operation.type !== "deletion") break;
    leadingDeletionRun += 1;
  }
  let trailingDeletionRun = 0;
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    if (operations[index].type === "insertion") continue;
    if (operations[index].type !== "deletion") break;
    trailingDeletionRun += 1;
  }
  const findings = [];
  const push = (severity, code, details = {}) => findings.push({ severity, code, ...details });
  const protectedToken = (value) => /^(?:abbr|num|pct|ratio|times|alias):/.test(String(value ?? ""));
  if (!recognized.length) push("blocker", "tts_transcript_empty");
  if (deletionRun >= 2) push("blocker", "tts_transcript_contiguous_words_missing", { longest_deletion_run: deletionRun });
  if (leadingDeletionRun > 0) push("blocker", "tts_transcript_opening_word_missing", { missing_count: leadingDeletionRun });
  if (trailingDeletionRun > 0) push("blocker", "tts_transcript_final_word_missing", { missing_count: trailingDeletionRun });
  if (deletions >= Math.max(3, Math.ceil(intended.length * 0.12))) {
    push("blocker", "tts_transcript_excessive_deletions", { deletions, intended_word_count: intended.length });
  }
  if (insertionRun >= 3) push("blocker", "tts_transcript_unexpected_word_burst", { longest_insertion_run: insertionRun });
  if (wer > maxWer && errors > 1) {
    push("blocker", "tts_transcript_wer_exceeded", { word_error_rate: Number(wer.toFixed(6)), maximum: maxWer });
  }
  const protectedMismatches = operations.filter((operation) => (
    operation.type === "substitution"
    && (protectedToken(operation.intended) || protectedToken(operation.recognized))
  ));
  const protectedDeletions = operations.filter((operation) => operation.type === "deletion" && protectedToken(operation.intended));
  const protectedInsertions = operations.filter((operation) => operation.type === "insertion" && protectedToken(operation.recognized));
  if (protectedMismatches.length) {
    push("blocker", "tts_transcript_protected_value_mismatch", { operations: protectedMismatches });
  }
  if (protectedDeletions.length) {
    push("blocker", "tts_transcript_protected_value_missing", { operations: protectedDeletions });
  }
  if (protectedInsertions.length) {
    push("blocker", "tts_transcript_unexpected_protected_value", { operations: protectedInsertions });
  }
  if (deletions > 0 && !findings.some((row) => row.code.includes("missing") || row.code === "tts_transcript_excessive_deletions")) {
    push(blockIsolatedEdits ? "blocker" : "warning", "tts_transcript_isolated_word_deletion", {
      deletions,
      adjudication_policy: blockIsolatedEdits
        ? "requires_medium_whisper_confirmation"
        : "medium_whisper_difference_without_structural_loss",
    });
  }
  if (insertions > 0 && insertionRun < 3) {
    push(blockIsolatedEdits ? "blocker" : "warning", "tts_transcript_isolated_insertion", {
      insertions,
      adjudication_policy: blockIsolatedEdits
        ? "requires_medium_whisper_confirmation"
        : "medium_whisper_difference_without_repetition_burst",
    });
  }
  if (substitutions > 0 && blockAnySubstitution) {
    push("blocker", errors <= 1 ? "tts_transcript_isolated_substitution" : "tts_transcript_word_substitutions", {
      substitutions,
      adjudication_policy: "requires_medium_whisper_confirmation",
    });
  }
  return {
    comparison_version: TRANSCRIPT_QA_COMPARISON_VERSION,
    phonetic_spelling_equivalences: phoneticSpellingEquivalences,
    intended_word_count: intendedRaw.length,
    recognized_word_count: recognizedRaw.length,
    intended_canonical_token_count: intended.length,
    recognized_canonical_token_count: recognized.length,
    intended_canonical_tokens: intended,
    recognized_canonical_tokens: recognized,
    deletions,
    insertions,
    substitutions,
    word_error_rate: Number(wer.toFixed(6)),
    longest_deletion_run: deletionRun,
    longest_insertion_run: insertionRun,
    leading_deletion_run: leadingDeletionRun,
    trailing_deletion_run: trailingDeletionRun,
    first_token_ok: firstIntendedOperation?.type === "match",
    last_token_ok: lastIntendedOperation?.type === "match",
    operations,
    findings,
  };
}

export function transcriptQaForTests(intendedText, recognizedText, options = {}) {
  return transcriptQa(intendedText, recognizedText, options);
}

function transcriptEquivalentPhrases(unit) {
  return [
    { from: "Manhwa", to: "Manwa" },
    { from: "Kane", to: "Cain" },
    { from: "Kane", to: "cane" },
    { from: "a claim", to: "acclaim" },
    ...(Array.isArray(unit?.tts_override_replacements_applied)
      ? unit.tts_override_replacements_applied.filter((row) => row?.asr_equivalence_allowed === true)
      : []),
    ...(Array.isArray(unit?.asr_equivalent_phrases) ? unit.asr_equivalent_phrases : []),
  ];
}

function untranscribedActiveIntervals(metrics, recognizedWords, paddingSec = 0.12) {
  if (!Array.isArray(metrics?.active_intervals_sec) || !recognizedWords?.length) return [];
  const words = recognizedWords
    .map((word) => ({
      start_sec: Math.max(0, Number(word.start_sec ?? 0) - paddingSec),
      end_sec: Number(word.end_sec ?? 0) + paddingSec,
    }))
    .sort((left, right) => left.start_sec - right.start_sec);
  const windows = [];
  for (const word of words) {
    const previous = windows.at(-1);
    if (previous && word.start_sec <= previous.end_sec) previous.end_sec = Math.max(previous.end_sec, word.end_sec);
    else windows.push({ ...word });
  }
  const speechStart = Number(recognizedWords[0].start_sec ?? 0);
  const speechEnd = Number(recognizedWords.at(-1).end_sec ?? 0);
  const residual = [];
  for (const interval of metrics.active_intervals_sec) {
    let pieces = [{
      start_sec: Math.max(Number(interval.start_sec ?? 0), speechStart),
      end_sec: Math.min(Number(interval.end_sec ?? 0), speechEnd),
    }].filter((piece) => piece.end_sec > piece.start_sec);
    for (const window of windows) {
      pieces = pieces.flatMap((piece) => {
        if (window.end_sec <= piece.start_sec || window.start_sec >= piece.end_sec) return [piece];
        const output = [];
        if (window.start_sec > piece.start_sec) output.push({ start_sec: piece.start_sec, end_sec: window.start_sec });
        if (window.end_sec < piece.end_sec) output.push({ start_sec: window.end_sec, end_sec: piece.end_sec });
        return output;
      });
      if (!pieces.length) break;
    }
    residual.push(...pieces.filter((piece) => piece.end_sec - piece.start_sec >= 0.16));
  }
  return residual.map((piece) => ({
    start_sec: Number(piece.start_sec.toFixed(3)),
    end_sec: Number(piece.end_sec.toFixed(3)),
    duration_sec: Number((piece.end_sec - piece.start_sec).toFixed(3)),
  }));
}

export function untranscribedActiveIntervalsForTests(metrics, recognizedWords, paddingSec) {
  return untranscribedActiveIntervals(metrics, recognizedWords, paddingSec);
}

async function runFasterWhisperUnitBatch(rows, {
  model = unitQaWhisperModel,
  device = unitQaWhisperDevice,
  computeType = unitQaWhisperComputeType,
} = {}) {
  if (!rows.length) return new Map();
  const asrContract = buildNarrationProviderUnitAsrContract({
    model,
    device,
    computeType,
  });
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-tts-unit-qa-"));
  const inputPath = path.join(tmpDir, "input.json");
  const outputPath = path.join(tmpDir, "output.json");
  await fs.writeFile(inputPath, JSON.stringify(rows.map((row) => ({ unit_id: row.unit_id, wav: row.wav }))), "utf8");
  const python = String.raw`
import json, sys
from faster_whisper import WhisperModel

input_path, output_path, model_name, device, compute_type = sys.argv[1:6]
with open(input_path, "r", encoding="utf-8") as handle:
    rows = json.load(handle)
model = WhisperModel(model_name, device=device, compute_type=compute_type)
output = []
for row in rows:
    segments, info = model.transcribe(
        row["wav"],
        language="en",
        word_timestamps=True,
        vad_filter=False,
        beam_size=5,
        condition_on_previous_text=False,
    )
    segment_rows = list(segments)
    words = []
    for segment in segment_rows:
        for word in (segment.words or []):
            words.append({
                "word": word.word.strip(),
                "start_sec": round(float(word.start), 3),
                "end_sec": round(float(word.end), 3),
                "probability": round(float(getattr(word, "probability", 0.0) or 0.0), 4),
            })
    output.append({
        "unit_id": row["unit_id"],
        "text": " ".join(segment.text.strip() for segment in segment_rows if segment.text.strip()).strip(),
        "words": words,
        "language": info.language,
        "language_probability": float(info.language_probability),
    })
with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(output, handle, ensure_ascii=False)
`;
  try {
    const timeoutMs = Number(process.env.ANIFACTORY_MODELSLAB_QWEN_UNIT_QA_TIMEOUT_MS ?? 7_200_000);
    await new Promise((resolve, reject) => {
      const child = spawn("python3", [
        "-c", python,
        inputPath,
        outputPath,
        model,
        device,
        computeType,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Per-unit Whisper QA timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Per-unit Whisper QA failed with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderr.slice(-2000)}`));
      });
    });
    const output = JSON.parse(await fs.readFile(outputPath, "utf8"));
    return new Map(output.map((row) => [String(row.unit_id), {
      ...row,
      asr_contract: asrContract,
      asr_contract_sha256: asrContract.contract_sha256,
    }]));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function mapPool(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => runWorker()));
  return output;
}

function requiredMediumQaReasons(row = {}) {
  const riskFlags = new Set(
    (Array.isArray(row.risk_flags) ? row.risk_flags : [])
      .map((value) => String(value ?? "").toLowerCase()),
  );
  const sourceKind = [
    row.kind,
    row.context_family,
    row.unit_type,
    row.source_kind,
  ].map((value) => String(value ?? "").toLowerCase());
  const speaker = String(row.speaker ?? row.source_speaker ?? "").toUpperCase();
  const reasons = [];
  if (riskFlags.has("system_ui_atomic")
    || sourceKind.some((value) => /system[_ -]?ui|system_ui_atomic/.test(value))
    || /^(?:SYSTEM|NOTICE|WARNING|UI)$/.test(speaker)) {
    reasons.push("system_ui_atomic");
  }
  if (riskFlags.has("protected_term_or_value")
    || (Array.isArray(row.protected_terms) && row.protected_terms.length > 0)
    || (Array.isArray(row.protected_tokens) && row.protected_tokens.length > 0)
    || (Array.isArray(row.protected_values) && row.protected_values.length > 0)) {
    reasons.push("protected_term_or_value");
  }
  return reasons;
}

export function requiredMediumQaReasonsForTests(row = {}) {
  return requiredMediumQaReasons(row);
}

function reusableUnitOutputQa(row, { reuseHashValidQa = false } = {}) {
  const qa = row?.unit_qa;
  if (!reuseHashValidQa
    || row?.audio_hash_verified !== true
    || !String(row?.audio_sha256 ?? "").trim()
    || qa?.policy_version !== TTS_OUTPUT_QA_POLICY_VERSION
    || qa?.audio_sha256 !== row.audio_sha256
    || !Number.isFinite(Number(qa?.metrics?.sample_count))
    || Number(qa.metrics.sample_count) <= 0
    || !Array.isArray(qa?.findings)
    || !["passed", "passed_with_warnings", "blocked"].includes(qa?.status)) {
    return null;
  }
  return structuredClone(qa);
}

export function reusableUnitOutputQaForTests(row, options = {}) {
  return reusableUnitOutputQa(row, options);
}

async function runUnitOutputQa(results, options = {}) {
  const usable = results.filter((row) => row?.wav);
  const measurements = await mapPool(usable, 6, async (row) => {
    const reusedQa = reusableUnitOutputQa(row, options);
    if (reusedQa) {
      return {
        row,
        audio_sha256: row.audio_sha256,
        metrics: reusedQa.metrics,
        reused_qa: reusedQa,
      };
    }
    return {
      row,
      audio_sha256: await sha256File(row.wav),
      metrics: await audioPcmMetrics(row.wav),
      reused_qa: null,
    };
  });
  const reusableTranscripts = new Map();
  const needsTranscript = [];
  for (const measurement of measurements) {
    const previousQa = measurement.row.unit_qa;
    const transcriptQaRequired = unitTranscriptQa
      && String(measurement.row.provider ?? "") !== "kokoro_local";
    if (transcriptQaRequired
      && previousQa?.policy_version === TTS_OUTPUT_QA_POLICY_VERSION
      && previousQa?.audio_sha256 === measurement.audio_sha256
      && previousQa?.transcript?.recognized_text != null) {
      reusableTranscripts.set(String(measurement.row.unit_id), {
        text: previousQa.transcript.recognized_text,
        words: previousQa.transcript.recognized_words ?? [],
        language: previousQa.transcript.language ?? "en",
        language_probability:
          previousQa.transcript.language_probability ?? null,
        asr_contract: previousQa.transcript.asr_contract ?? null,
        asr_contract_sha256:
          previousQa.transcript.asr_contract_sha256 ?? null,
        reused: true,
      });
    } else if (transcriptQaRequired) {
      needsTranscript.push(measurement.row);
    }
  }
  let transcriptEngineError = null;
  let freshTranscripts = new Map();
  if (unitTranscriptQa) {
    try {
      freshTranscripts = await runFasterWhisperUnitBatch(needsTranscript);
    } catch (error) {
      transcriptEngineError = error instanceof Error ? error.message : String(error);
    }
  }
  const rows = measurements.map(({ row, audio_sha256, metrics, reused_qa: reusedQa }) => {
    if (reusedQa) {
      return {
        ...reusedQa,
        reused_exact_hash_waveform_qa: true,
      };
    }
    const recognized = reusableTranscripts.get(String(row.unit_id)) ?? freshTranscripts.get(String(row.unit_id)) ?? null;
    const audioFindings = audioQaFindings(metrics, row);
    const deliveryFirstPrimary = isDeliveryFirstLocalNarrator(row.provider);
    const transcriptQaRequired = unitTranscriptQa && !deliveryFirstPrimary;
    const transcript = recognized ? transcriptQa(row.text, recognized.text, {
      equivalentPhrases: transcriptEquivalentPhrases(row),
      maxWer: deliveryFirstPrimary ? Math.max(unitQaMaxWer, 0.45) : unitQaMaxWer,
      blockAnySubstitution: !deliveryFirstPrimary,
      blockIsolatedEdits: !deliveryFirstPrimary,
    }) : null;
    let findings = [
      ...audioFindings,
      ...softenUncertainTranscriptFindings(
        transcript?.findings ?? [],
        row.provider,
      ),
    ];
    if (transcriptQaRequired && transcriptEngineError && !recognized) {
      findings.push({
        severity: "warning",
        code: "tts_transcript_qa_engine_failed",
        error: transcriptEngineError,
        review_required: true,
        automatic_retry_allowed: false,
        blocks_stitching: false,
      });
    } else if (transcriptQaRequired && !recognized) {
      findings.push({
        severity: "warning",
        code: "tts_transcript_qa_missing_result",
        review_required: true,
        automatic_retry_allowed: false,
        blocks_stitching: false,
      });
    }
    if (!transcriptQaRequired) {
      findings.push({
        severity: "warning",
        code: deliveryFirstPrimary
          ? "tts_primary_transcript_qa_deferred_to_full_stream"
          : "tts_transcript_qa_explicitly_disabled",
        note: deliveryFirstPrimary
          ? "Local narrator transcript QA is diagnostic; uncertain ASR differences require listening and never trigger automatic regeneration."
          : "Acoustic QA ran, but transcript fidelity was not independently checked.",
      });
    }
    if (recognized?.words?.length) {
      const firstWordStart = Number(recognized.words[0].start_sec ?? 0);
      const lastWordEnd = Number(recognized.words.at(-1).end_sec ?? 0);
      const unexplainedLead = firstWordStart - Number(metrics.active_start_sec ?? 0);
      const unexplainedTail = Number(metrics.active_end_sec ?? metrics.duration_sec ?? 0) - lastWordEnd;
      const internalBursts = untranscribedActiveIntervals(metrics, recognized.words);
      const longestInternalBurst = internalBursts.reduce((maximum, interval) => Math.max(maximum, interval.duration_sec), 0);
      if (unexplainedLead > 0.6) {
        findings.push({
          severity: "warning",
          code: "tts_audio_unexplained_active_lead",
          unexplained_active_sec: Number(unexplainedLead.toFixed(3)),
          review_required: true,
          automatic_retry_allowed: false,
          blocks_stitching: false,
        });
      } else if (unexplainedLead > 0.35) {
        findings.push({ severity: "warning", code: "tts_audio_possible_non_speech_lead", unexplained_active_sec: Number(unexplainedLead.toFixed(3)) });
      }
      if (unexplainedTail > 0.6) {
        findings.push({
          severity: "warning",
          code: "tts_audio_unexplained_active_tail",
          unexplained_active_sec: Number(unexplainedTail.toFixed(3)),
          review_required: true,
          automatic_retry_allowed: false,
          blocks_stitching: false,
        });
      } else if (unexplainedTail > 0.35) {
        findings.push({ severity: "warning", code: "tts_audio_possible_non_speech_tail", unexplained_active_sec: Number(unexplainedTail.toFixed(3)) });
      }
      if (longestInternalBurst > 0.45) {
        findings.push({
          severity: "warning",
          code: "tts_audio_untranscribed_internal_burst",
          longest_untranscribed_active_sec: Number(longestInternalBurst.toFixed(3)),
          intervals: internalBursts,
          review_required: true,
          automatic_retry_allowed: false,
          blocks_stitching: false,
        });
      } else if (internalBursts.length) {
        findings.push({
          severity: "warning",
          code: "tts_audio_possible_internal_breath_or_noise",
          longest_untranscribed_active_sec: Number(longestInternalBurst.toFixed(3)),
          intervals: internalBursts,
        });
      }
    }
    const blockers = findings.filter((finding) => finding.severity === "blocker");
    return {
      policy_version: TTS_OUTPUT_QA_POLICY_VERSION,
      status: blockers.length ? "blocked" : findings.length ? "passed_with_warnings" : "passed",
      audio_sha256,
      metrics,
      transcript: recognized ? {
        engine: "faster_whisper",
        model: unitQaWhisperModel,
        device: unitQaWhisperDevice,
        compute_type: unitQaWhisperComputeType,
        language: recognized.language ?? "en",
        language_probability: recognized.language_probability ?? null,
        asr_contract: recognized.asr_contract ?? null,
        asr_contract_sha256: recognized.asr_contract_sha256 ?? null,
        recognized_text: recognized.text,
        recognized_words: recognized.words ?? [],
        reused_exact_hash_qa: Boolean(recognized.reused),
        ...transcript,
      } : {
        status: "not_run",
        reason: unitTranscriptQa ? "no_transcript_returned" : "explicitly_disabled",
      },
      findings,
    };
  });
  const transcriptOnlyBlockedIndexes = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => {
      if (isDeliveryFirstLocalNarrator(measurements[index]?.row?.provider)) {
        return false;
      }
      const blockers = row.findings.filter((finding) => finding.severity === "blocker");
      return blockers.length > 0 && blockers.every((finding) => String(finding.code ?? "").startsWith("tts_transcript_"));
    })
    .map(({ index }) => index);
  const forcedMediumReasonsByIndex = new Map(
    measurements
      .map(({ row }, index) => [
        index,
        isDeliveryFirstLocalNarrator(row.provider) ? [] : requiredMediumQaReasons(row),
      ])
      .filter(([, reasons]) => reasons.length > 0),
  );
  const mediumAdjudicationIndexes = [...new Set([
    ...transcriptOnlyBlockedIndexes,
    ...forcedMediumReasonsByIndex.keys(),
  ])].sort((left, right) => left - right);
  if (mediumAdjudicationIndexes.length && unitQaWhisperModel !== "medium") {
    let mediumMap = new Map();
    let mediumError = null;
    try {
      mediumMap = await runFasterWhisperUnitBatch(
        mediumAdjudicationIndexes.map((index) => measurements[index].row),
        { model: "medium" },
      );
    } catch (error) {
      mediumError = error instanceof Error ? error.message : String(error);
    }
    for (const index of mediumAdjudicationIndexes) {
      const source = measurements[index].row;
      const medium = mediumMap.get(String(source.unit_id)) ?? null;
      const forcedReasons = forcedMediumReasonsByIndex.get(index) ?? [];
      if (!medium) {
        rows[index].transcript_cross_validation = {
          status: "failed",
          model: "medium",
          error: mediumError ?? "missing medium transcript",
          required_reasons: forcedReasons,
        };
        if (forcedReasons.length) {
          rows[index].findings = [
            ...(rows[index].findings ?? []),
            {
              severity: "warning",
              code: "tts_required_medium_qa_missing",
              required_reasons: forcedReasons,
              error: mediumError ?? "missing medium transcript",
              review_required: true,
              automatic_retry_allowed: false,
              blocks_stitching: false,
            },
          ];
          rows[index].status = "passed_with_warnings";
        }
        continue;
      }
      const mediumTranscript = transcriptQa(source.text, medium.text, {
        equivalentPhrases: transcriptEquivalentPhrases(source),
        maxWer: Math.max(unitQaMaxWer, 0.3),
        blockAnySubstitution: false,
        blockIsolatedEdits: false,
      });
      const mediumFindings = [
        ...audioQaFindings(measurements[index].metrics, source),
        ...softenUncertainTranscriptFindings(
          mediumTranscript.findings,
          source.provider,
        ),
      ];
      const mediumBlockers = mediumFindings.filter((finding) => finding.severity === "blocker");
      rows[index].transcript_cross_validation = {
        status: mediumBlockers.length ? "blocked" : "passed",
        model: "medium",
        primary_model: unitQaWhisperModel,
        required_reasons: forcedReasons,
        primary_recognized_text: rows[index].transcript?.recognized_text ?? null,
        recognized_text: medium.text,
        recognized_words: medium.words ?? [],
        ...mediumTranscript,
        findings: mediumFindings,
      };
      if (forcedReasons.length || !mediumBlockers.length) {
        rows[index].status = mediumFindings.length ? "passed_with_warnings" : "passed";
        if (mediumBlockers.length) rows[index].status = "blocked";
        rows[index].transcript = {
          engine: "faster_whisper",
          model: "medium",
          device: unitQaWhisperDevice,
          compute_type: unitQaWhisperComputeType,
          recognized_text: medium.text,
          recognized_words: medium.words ?? [],
          reused_exact_hash_qa: false,
          cross_validated_from_primary_model: unitQaWhisperModel,
          ...mediumTranscript,
        };
        rows[index].findings = mediumFindings;
      }
    }
  }
  const byUnitId = new Map(rows.map((row, index) => [String(measurements[index].row.unit_id), row]));
  for (const result of results) {
    if (result?.unit_id && byUnitId.has(String(result.unit_id))) result.unit_qa = byUnitId.get(String(result.unit_id));
  }
  const blockers = rows.flatMap((row, index) => row.findings
    .filter((finding) => finding.severity === "blocker")
    .map((finding) => ({ unit_id: measurements[index].row.unit_id, ...finding })));
  const warnings = rows.flatMap((row, index) => row.findings
    .filter((finding) => finding.severity === "warning")
    .map((finding) => ({ unit_id: measurements[index].row.unit_id, ...finding })));
  return {
    status: blockers.length ? "blocked" : "passed",
    policy_version: TTS_OUTPUT_QA_POLICY_VERSION,
    transcript_qa_enabled: unitTranscriptQa,
    transcript_qa_deferred_to_local_whisper_word_timing: !unitTranscriptQa,
    transcript_engine: unitTranscriptQa ? "faster_whisper" : null,
    transcript_model: unitTranscriptQa ? unitQaWhisperModel : null,
    transcript_engine_error: transcriptEngineError,
    unit_count: rows.length,
    reused_exact_hash_waveform_qa_unit_count: rows.filter(
      (row) => row.reused_exact_hash_waveform_qa === true,
    ).length,
    decoded_waveform_qa_unit_count: rows.filter(
      (row) => row.reused_exact_hash_waveform_qa !== true,
    ).length,
    passed_unit_count: rows.filter((row) => row.status !== "blocked").length,
    blocked_unit_count: rows.filter((row) => row.status === "blocked").length,
    blocker_count: blockers.length,
    warning_count: warnings.length,
    blockers,
    warnings,
    units: results.map((row) => ({
      unit_id: row.unit_id,
      segment_id: row.segment_id,
      text: row.text,
      wav: row.wav,
      qa: row.unit_qa ?? null,
    })),
  };
}

export async function runUnitOutputQaForDiagnostics(results, options = {}) {
  return runUnitOutputQa(results, options);
}

function concatLine(filePath) {
  return `file '${filePath.replaceAll("'", "'\\''")}'`;
}

function secondsToSampleCount(value, sampleRate = stitchSampleRate) {
  return Math.max(0, Math.round(Number(value ?? 0) * sampleRate));
}

function metricSilenceSampleCount(metrics, sampleField, secondsField, sampleRate) {
  const exact = Number(metrics?.[sampleField]);
  if (Number.isInteger(exact) && exact >= 0) return exact;
  return secondsToSampleCount(metrics?.[secondsField], sampleRate);
}

async function writeSilenceWav(filePath, sampleCount) {
  if (!Number.isInteger(sampleCount) || sampleCount <= 0) return null;
  if (await exists(filePath)) {
    const cachedMetrics = await audioPcmMetrics(filePath).catch(() => null);
    if (Number(cachedMetrics?.sample_count) === sampleCount) return filePath;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await run("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", `anullsrc=r=${stitchSampleRate}:cl=mono`,
    "-af", `atrim=end_sample=${sampleCount}`,
    "-acodec", "pcm_s16le",
    filePath,
  ]);
  return filePath;
}

function balancedRetainedSamples(leftAvailable, rightAvailable, targetSamples) {
  if (leftAvailable + rightAvailable <= targetSamples) {
    return { left: leftAvailable, right: rightAvailable };
  }
  const leftHalf = Math.floor(targetSamples / 2);
  const rightHalf = targetSamples - leftHalf;
  if (leftAvailable < leftHalf) {
    return { left: leftAvailable, right: targetSamples - leftAvailable };
  }
  if (rightAvailable < rightHalf) {
    return { left: targetSamples - rightAvailable, right: rightAvailable };
  }
  return { left: leftHalf, right: rightHalf };
}

function stitchBoundaryPadding(
  leftMetrics,
  rightMetrics,
  targetGapSec,
  edgePadSec = stitchEdgePadSec,
  sampleRate = stitchSampleRate,
) {
  const targetSamples = secondsToSampleCount(targetGapSec, sampleRate);
  const edgePadSamples = secondsToSampleCount(edgePadSec, sampleRate);
  const leftAvailable = Math.min(
    edgePadSamples,
    metricSilenceSampleCount(
      leftMetrics,
      "trailing_silence_sample_count",
      "trailing_silence_sec",
      sampleRate,
    ),
  );
  const rightAvailable = Math.min(
    edgePadSamples,
    metricSilenceSampleCount(
      rightMetrics,
      "leading_silence_sample_count",
      "leading_silence_sec",
      sampleRate,
    ),
  );
  const retained = balancedRetainedSamples(
    leftAvailable,
    rightAvailable,
    targetSamples,
  );
  const insertedSamples = targetSamples - retained.left - retained.right;
  return {
    sample_rate_hz: sampleRate,
    target_gap_sample_count: targetSamples,
    available_left_trailing_silence_sample_count: leftAvailable,
    available_right_leading_silence_sample_count: rightAvailable,
    retained_left_trailing_silence_sample_count: retained.left,
    retained_right_leading_silence_sample_count: retained.right,
    trimmed_left_trailing_silence_sample_count: leftAvailable - retained.left,
    trimmed_right_leading_silence_sample_count: rightAvailable - retained.right,
    inserted_silence_sample_count: insertedSamples,
    effective_gap_sample_count: retained.left + retained.right + insertedSamples,
    target_gap_sec: Number((targetSamples / sampleRate).toFixed(6)),
    retained_left_trailing_silence_sec: Number((retained.left / sampleRate).toFixed(6)),
    retained_right_leading_silence_sec: Number((retained.right / sampleRate).toFixed(6)),
    inserted_silence_sec: Number((insertedSamples / sampleRate).toFixed(6)),
    effective_gap_sec: Number((
      (retained.left + retained.right + insertedSamples) / sampleRate
    ).toFixed(6)),
  };
}

export function stitchBoundaryPaddingForTests(
  leftMetrics,
  rightMetrics,
  targetGapSec,
  edgePadSec,
  sampleRate = 24000,
) {
  return stitchBoundaryPadding(
    leftMetrics,
    rightMetrics,
    targetGapSec,
    edgePadSec,
    sampleRate,
  );
}

function stitchTargetGapSec(options = {}, crossesSegment = false) {
  const explicit = crossesSegment
    ? options.segmentGapSec
    : options.unitGapSec;
  const fallback = crossesSegment ? segmentGapSec : unitGapSec;
  const selected = explicit == null ? fallback : Number(explicit);
  if (!Number.isFinite(selected) || selected < 0 || selected > 1.5) {
    throw new Error(
      `Invalid explicit ${crossesSegment ? "segment" : "unit"} stitch gap: ${explicit}`,
    );
  }
  return selected;
}

export function stitchTargetGapSecForTests(options = {}, crossesSegment = false) {
  return stitchTargetGapSec(options, crossesSegment);
}

function stitchEffectiveBoundaryContract(
  leftMetrics,
  rightMetrics,
  targetGapSec,
  insertedSilenceSampleCount,
  sampleRate = stitchSampleRate,
) {
  const targetSamples = secondsToSampleCount(targetGapSec, sampleRate);
  const retainedLeft = metricSilenceSampleCount(
    leftMetrics,
    "trailing_silence_sample_count",
    "trailing_silence_sec",
    sampleRate,
  );
  const retainedRight = metricSilenceSampleCount(
    rightMetrics,
    "leading_silence_sample_count",
    "leading_silence_sec",
    sampleRate,
  );
  const insertedSamples = Number.isInteger(insertedSilenceSampleCount)
    ? Math.max(0, insertedSilenceSampleCount)
    : Math.max(0, targetSamples - retainedLeft - retainedRight);
  const effectiveSamples = retainedLeft + retainedRight + insertedSamples;
  const exact = effectiveSamples === targetSamples;
  return {
    status: exact ? "passed" : "blocked",
    sample_rate_hz: sampleRate,
    target_gap_sample_count: targetSamples,
    retained_left_trailing_silence_sample_count: retainedLeft,
    retained_right_leading_silence_sample_count: retainedRight,
    inserted_silence_sample_count: insertedSamples,
    effective_gap_sample_count: effectiveSamples,
    target_gap_sec: Number((targetSamples / sampleRate).toFixed(6)),
    retained_left_trailing_silence_sec: Number((retainedLeft / sampleRate).toFixed(6)),
    retained_right_leading_silence_sec: Number((retainedRight / sampleRate).toFixed(6)),
    inserted_silence_sec: Number((insertedSamples / sampleRate).toFixed(6)),
    effective_gap_sec: Number((effectiveSamples / sampleRate).toFixed(6)),
    blocker: exact ? null : {
      code: retainedLeft + retainedRight > targetSamples
        ? "tts_join_retained_edge_silence_exceeds_target"
        : "tts_join_effective_gap_sample_count_mismatch",
      expected_sample_count: targetSamples,
      actual_sample_count: effectiveSamples,
    },
  };
}

export function stitchEffectiveBoundaryContractForTests(
  leftMetrics,
  rightMetrics,
  targetGapSec,
  insertedSilenceSampleCount,
  sampleRate = 24000,
) {
  return stitchEffectiveBoundaryContract(
    leftMetrics,
    rightMetrics,
    targetGapSec,
    insertedSilenceSampleCount,
    sampleRate,
  );
}

function firstSourceSegmentId(row) {
  return String(row?.source_segment_ids?.[0] ?? row?.source_segment_id ?? row?.segment_id ?? "");
}

function lastSourceSegmentId(row) {
  return String(row?.source_segment_ids?.at?.(-1) ?? row?.source_segment_id ?? row?.segment_id ?? "");
}

async function prepareStitchInput(row, index, options = {}) {
  const metrics = row?.unit_qa?.metrics;
  if (!metrics || row.unit_qa?.status === "blocked") {
    throw new Error(`Refusing to prepare stitch input ${row?.unit_id ?? index}: per-unit audio QA is missing or blocked.`);
  }
  if (options.narrationQualityContract) {
    const workDir = options.workDir ?? outDir;
    const qualityContract = options.narrationQualityContract;
    const duration = Math.max(0, Number(metrics.duration_sec ?? row.duration_sec ?? 0));
    const sourceSampleCount = Number.isInteger(Number(metrics.sample_count))
      && Number(metrics.sample_count) > 0
      ? Number(metrics.sample_count)
      : secondsToSampleCount(duration);
    const editPlan = planAlignmentSafeUnitEdit({
      unitId: row.unit_id,
      sampleCount: sourceSampleCount,
      sampleRate: stitchSampleRate,
      alignment: row.unit_qa?.edge_alignment ?? null,
      waveformActivity: metrics,
      contract: qualityContract,
    });
    if (editPlan.status !== "passed" || editPlan.retained_sample_count <= 0) {
      throw new Error(
        `Refusing V2 stitch input ${row.unit_id}: ${JSON.stringify(editPlan.blockers)}`,
      );
    }
    const repairTailSilenceSec = options?.repairTailUnitIds?.has(String(row.unit_id))
      ? Math.max(0.06, Number(options.repairTailSilenceSec ?? 0.06))
      : 0;
    const repairTailSilenceSampleCount = secondsToSampleCount(repairTailSilenceSec);
    const preparedSampleCount = editPlan.retained_sample_count
      + repairTailSilenceSampleCount;
    const leadingDetected = metricSilenceSampleCount(
      metrics,
      "leading_silence_sample_count",
      "leading_silence_sec",
      stitchSampleRate,
    );
    const trailingDetected = metricSilenceSampleCount(
      metrics,
      "trailing_silence_sample_count",
      "trailing_silence_sec",
      stitchSampleRate,
    );
    const retainedLeadingSamples = editPlan.alignment_used
      ? editPlan.retained_head_safety_sample_count
      : Math.min(sourceSampleCount, leadingDetected);
    const retainedTrailingSamples = editPlan.alignment_used
      ? editPlan.retained_tail_safety_sample_count
      : Math.min(sourceSampleCount, trailingDetected);
    const preparationPolicy = {
      mode: editPlan.mode,
      quality_contract_sha256: qualityContract.contract_sha256,
      sample_rate: stitchSampleRate,
      amplitude_only_trimming: false,
      fade_over_speech: false,
      edge_alignment: row.unit_qa?.edge_alignment ?? null,
      edit_plan: editPlan,
      diagnostic_repair_tail_silence_sample_count: repairTailSilenceSampleCount,
    };
    const hashPrefix = String(row.unit_qa.audio_sha256 ?? "unhashed").slice(0, 12);
    const policyHash = sha256Text(JSON.stringify(preparationPolicy)).slice(0, 12);
    const preparedDir = path.join(workDir, "stitch-inputs-v2");
    const preparedPath = path.join(
      preparedDir,
      `${String(index + 1).padStart(4, "0")}-${slug(row.unit_id)}-${hashPrefix}-${policyHash}.wav`,
    );
    await fs.mkdir(preparedDir, { recursive: true });
    if (!(await exists(preparedPath))) {
      const filter = [
        `aresample=${stitchSampleRate}`,
        `atrim=start_sample=${editPlan.trim_start_sample}:end_sample=${editPlan.trim_end_sample}`,
        "asetpts=PTS-STARTPTS",
        ...(repairTailSilenceSampleCount > 0
          ? [`apad=pad_len=${repairTailSilenceSampleCount}`]
          : []),
      ].join(",");
      await run("ffmpeg", [
        "-y",
        "-nostdin",
        "-v", "error",
        "-i", row.wav,
        "-af", filter,
        "-ar", String(stitchSampleRate),
        "-ac", "1",
        "-acodec", "pcm_s16le",
        preparedPath,
      ]);
    }
    return {
      unit_id: row.unit_id,
      source_wav: row.wav,
      prepared_wav: preparedPath,
      source_duration_sec: duration,
      source_sample_count: sourceSampleCount,
      trim_start_sample: editPlan.trim_start_sample,
      trim_end_sample: editPlan.trim_end_sample,
      trim_start_sec: Number((editPlan.trim_start_sample / stitchSampleRate).toFixed(6)),
      trim_end_sec: Number((editPlan.trim_end_sample / stitchSampleRate).toFixed(6)),
      content_sample_count: editPlan.retained_sample_count,
      content_duration_sec: Number((editPlan.retained_sample_count / stitchSampleRate).toFixed(6)),
      prepared_sample_count: preparedSampleCount,
      prepared_duration_sec: Number((preparedSampleCount / stitchSampleRate).toFixed(6)),
      retained_leading_silence_sample_count: retainedLeadingSamples,
      retained_trailing_silence_sample_count:
        retainedTrailingSamples + repairTailSilenceSampleCount,
      retained_leading_silence_sec: Number((retainedLeadingSamples / stitchSampleRate).toFixed(6)),
      retained_trailing_silence_sec: Number(((retainedTrailingSamples + repairTailSilenceSampleCount) / stitchSampleRate).toFixed(6)),
      diagnostic_repair_tail_silence_sample_count: repairTailSilenceSampleCount,
      diagnostic_repair_tail_silence_sec: Number(repairTailSilenceSec.toFixed(6)),
      fade_sec: 0,
      edge_edit_plan: editPlan,
      preparation_policy: preparationPolicy,
      preparation_policy_sha256: policyHash,
      prepared_audio_sha256: await sha256File(preparedPath),
    };
  }
  const duration = Math.max(0, Number(metrics.duration_sec ?? row.duration_sec ?? 0));
  const sourceSampleCount = Number.isInteger(Number(metrics.sample_count))
    && Number(metrics.sample_count) > 0
    ? Number(metrics.sample_count)
    : secondsToSampleCount(duration);
  const leadingSamples = Math.min(
    sourceSampleCount,
    metricSilenceSampleCount(
      metrics,
      "leading_silence_sample_count",
      "leading_silence_sec",
      stitchSampleRate,
    ),
  );
  const trailingSamples = Math.min(
    sourceSampleCount,
    metricSilenceSampleCount(
      metrics,
      "trailing_silence_sample_count",
      "trailing_silence_sec",
      stitchSampleRate,
    ),
  );
  const edgePadSamples = secondsToSampleCount(stitchEdgePadSec);
  const retainedLeadingSamples = Math.min(
    leadingSamples,
    Number.isInteger(options.retainedLeadingSampleCap)
      ? Math.max(0, options.retainedLeadingSampleCap)
      : edgePadSamples,
  );
  const retainedTrailingSamples = Math.min(
    trailingSamples,
    Number.isInteger(options.retainedTrailingSampleCap)
      ? Math.max(0, options.retainedTrailingSampleCap)
      : edgePadSamples,
  );
  const trimStartSamples = Math.max(0, leadingSamples - retainedLeadingSamples);
  const trimEndSamples = Math.min(
    sourceSampleCount,
    sourceSampleCount - Math.max(0, trailingSamples - retainedTrailingSamples),
  );
  const contentSampleCount = trimEndSamples - trimStartSamples;
  const contentDuration = contentSampleCount / stitchSampleRate;
  if (contentSampleCount <= 0) {
    throw new Error(
      `Refusing to stitch ${row.unit_id}: padding-aware trim produced empty audio.`,
    );
  }
  const repairTailSilenceSec = options?.repairTailUnitIds?.has(String(row.unit_id))
    ? Math.max(0.06, Number(options.repairTailSilenceSec ?? 0.06))
    : 0;
  const repairTailSilenceSampleCount = secondsToSampleCount(repairTailSilenceSec);
  const preparedSampleCount = contentSampleCount + repairTailSilenceSampleCount;
  const preparedDuration = preparedSampleCount / stitchSampleRate;
  const hashPrefix = String(row.unit_qa.audio_sha256 ?? "unhashed").slice(0, 12);
  const preparationPolicy = {
    sample_rate: stitchSampleRate,
    edge_pad_sec: stitchEdgePadSec,
    fade_sec: stitchFadeSec,
    retained_leading_sample_cap: options.retainedLeadingSampleCap ?? null,
    retained_trailing_sample_cap: options.retainedTrailingSampleCap ?? null,
    retained_leading_sample_count: retainedLeadingSamples,
    retained_trailing_sample_count:
      retainedTrailingSamples + repairTailSilenceSampleCount,
    diagnostic_repair_tail_silence_sample_count: repairTailSilenceSampleCount,
  };
  const policyHash = sha256Text(JSON.stringify(preparationPolicy)).slice(0, 12);
  const preparedDir = path.join(outDir, "stitch-inputs");
  const preparedPath = path.join(preparedDir, `${String(index + 1).padStart(4, "0")}-${slug(row.unit_id)}-${hashPrefix}-${policyHash}.wav`);
  await fs.mkdir(preparedDir, { recursive: true });
  if (!(await exists(preparedPath))) {
    const fade = Math.min(stitchFadeSec, contentDuration / 4);
    const fadeOutStart = Math.max(0, contentDuration - fade);
    const filter = [
      `aresample=${stitchSampleRate}`,
      `atrim=start_sample=${trimStartSamples}:end_sample=${trimEndSamples}`,
      "asetpts=PTS-STARTPTS",
      `afade=t=in:st=0:d=${fade.toFixed(6)}`,
      `afade=t=out:st=${fadeOutStart.toFixed(6)}:d=${fade.toFixed(6)}`,
      ...(repairTailSilenceSampleCount > 0
        ? [`apad=pad_len=${repairTailSilenceSampleCount}`]
        : []),
    ].join(",");
    await run("ffmpeg", [
      "-y",
      "-nostdin",
      "-v", "error",
      "-i", row.wav,
      "-af", filter,
      "-ar", String(stitchSampleRate),
      "-ac", "1",
      "-acodec", "pcm_s16le",
      preparedPath,
    ]);
  }
  return {
    unit_id: row.unit_id,
    source_wav: row.wav,
    prepared_wav: preparedPath,
    source_duration_sec: duration,
    source_sample_count: sourceSampleCount,
    trim_start_sample: trimStartSamples,
    trim_end_sample: trimEndSamples,
    trim_start_sec: Number((trimStartSamples / stitchSampleRate).toFixed(6)),
    trim_end_sec: Number((trimEndSamples / stitchSampleRate).toFixed(6)),
    content_sample_count: contentSampleCount,
    content_duration_sec: Number(contentDuration.toFixed(6)),
    prepared_sample_count: preparedSampleCount,
    prepared_duration_sec: Number(preparedDuration.toFixed(6)),
    retained_leading_silence_sample_count: retainedLeadingSamples,
    retained_trailing_silence_sample_count:
      retainedTrailingSamples + repairTailSilenceSampleCount,
    retained_leading_silence_sec: Number(
      (retainedLeadingSamples / stitchSampleRate).toFixed(6),
    ),
    retained_trailing_silence_sec: Number((
      (retainedTrailingSamples + repairTailSilenceSampleCount) / stitchSampleRate
    ).toFixed(6)),
    diagnostic_repair_tail_silence_sample_count: repairTailSilenceSampleCount,
    diagnostic_repair_tail_silence_sec: Number(repairTailSilenceSec.toFixed(6)),
    fade_sec: Number(Math.min(stitchFadeSec, contentDuration / 4).toFixed(6)),
    preparation_policy: preparationPolicy,
    preparation_policy_sha256: policyHash,
    prepared_audio_sha256: await sha256File(preparedPath),
  };
}

async function qaRenderedAudioRows(
  sourceRows,
  renderedRows,
  stage,
  { skipTranscriptQa = false } = {},
) {
  let transcriptMap = new Map();
  let transcriptEngineError = null;
  const transcriptRows = skipTranscriptQa || !unitTranscriptQa
    ? []
    : renderedRows.filter((_row, index) => (
        !isDeliveryFirstLocalNarrator(sourceRows[index]?.provider)
      ));
  if (transcriptRows.length) {
    try {
      transcriptMap = await runFasterWhisperUnitBatch(transcriptRows.map((row) => ({
        unit_id: row.unit_id,
        wav: row.wav,
      })));
    } catch (error) {
      transcriptEngineError = error instanceof Error ? error.message : String(error);
    }
  }
  const units = [];
  for (let index = 0; index < renderedRows.length; index += 1) {
    const source = sourceRows[index];
    const rendered = renderedRows[index];
    const [metrics, audioSha256] = await Promise.all([
      audioPcmMetrics(rendered.wav),
      sha256File(rendered.wav),
    ]);
    const recognized = transcriptMap.get(String(rendered.unit_id)) ?? null;
    const deliveryFirstPrimary = isDeliveryFirstLocalNarrator(source.provider);
    const transcript = recognized ? transcriptQa(source.text, recognized.text, {
      equivalentPhrases: transcriptEquivalentPhrases(source),
    }) : null;
    const renderedEdgeMinimum = stage === "prepared_stitch_input"
      ? 0.01
      : stage === "final_stitch_boundary"
        ? Math.max(0.01, stitchEdgePadSec - 0.001)
        : unitQaMinTrailingSilenceSec;
    const findings = [
      ...audioQaFindings(metrics, source, { minTrailingSilence: renderedEdgeMinimum }),
      ...softenUncertainTranscriptFindings(
        transcript?.findings ?? [],
        source.provider,
      ),
    ];
    if (!recognized && !deliveryFirstPrimary) {
      findings.push({
        severity: "warning",
        code: "tts_rendered_transcript_qa_missing",
        stage,
        error: transcriptEngineError,
        review_required: true,
        automatic_retry_allowed: false,
        blocks_stitching: false,
      });
    } else if (!recognized) {
      findings.push({
        severity: "warning",
        code: skipTranscriptQa
          ? "tts_primary_rendered_transcript_qa_deferred_to_local_whisper_timing"
          : "tts_primary_rendered_transcript_qa_deferred_to_full_stream",
        stage,
        explicitly_skipped: skipTranscriptQa,
      });
    }
    const blockers = findings.filter((row) => row.severity === "blocker");
    units.push({
      unit_id: source.unit_id,
      stage,
      status: blockers.length ? "blocked" : findings.length ? "passed_with_warnings" : "passed",
      audio_path: rendered.wav,
      audio_sha256: audioSha256,
      metrics,
      transcript: recognized ? {
        recognized_text: recognized.text,
        recognized_words: recognized.words ?? [],
        ...transcript,
      } : null,
      findings,
    });
  }
  const transcriptOnlyBlocked = units.filter((row) => {
    const source = sourceRows[units.indexOf(row)];
    if (isDeliveryFirstLocalNarrator(source?.provider)) return false;
    const blockers = row.findings.filter((finding) => finding.severity === "blocker");
    return blockers.length > 0 && blockers.every((finding) => String(finding.code ?? "").startsWith("tts_transcript_"));
  });
  if (transcriptOnlyBlocked.length && unitQaWhisperModel !== "medium") {
    let mediumMap = new Map();
    let mediumError = null;
    try {
      mediumMap = await runFasterWhisperUnitBatch(
        transcriptOnlyBlocked.map((row) => ({
          unit_id: row.unit_id,
          wav: row.audio_path,
        })),
        { model: "medium" },
      );
    } catch (error) {
      mediumError = error instanceof Error ? error.message : String(error);
    }
    for (const unit of transcriptOnlyBlocked) {
      const index = units.indexOf(unit);
      const source = sourceRows[index];
      const medium = mediumMap.get(String(unit.unit_id)) ?? null;
      if (!medium) {
        unit.transcript_cross_validation = {
          status: "failed",
          model: "medium",
          error: mediumError ?? "missing medium transcript",
        };
        continue;
      }
      const mediumTranscript = transcriptQa(source.text, medium.text, {
        equivalentPhrases: transcriptEquivalentPhrases(source),
        maxWer: Math.max(unitQaMaxWer, 0.3),
        blockAnySubstitution: false,
        blockIsolatedEdits: false,
      });
      const renderedEdgeMinimum = /^(?:prepared_stitch_input|final_stitch_boundary)$/u.test(stage)
        ? Math.max(0.01, stitchEdgePadSec - 0.001)
        : unitQaMinTrailingSilenceSec;
      const mediumFindings = [
        ...audioQaFindings(unit.metrics, source, { minTrailingSilence: renderedEdgeMinimum }),
        ...softenUncertainTranscriptFindings(
          mediumTranscript.findings,
          source.provider,
        ),
      ];
      const mediumBlockers = mediumFindings.filter((finding) => finding.severity === "blocker");
      unit.transcript_cross_validation = {
        status: mediumBlockers.length ? "blocked" : "passed",
        model: "medium",
        primary_model: unitQaWhisperModel,
        primary_recognized_text: unit.transcript?.recognized_text ?? null,
        recognized_text: medium.text,
        recognized_words: medium.words ?? [],
        ...mediumTranscript,
        findings: mediumFindings,
      };
      if (!mediumBlockers.length) {
        unit.status = mediumFindings.length ? "passed_with_warnings" : "passed";
        unit.transcript = {
          recognized_text: medium.text,
          recognized_words: medium.words ?? [],
          cross_validated_from_primary_model: unitQaWhisperModel,
          cross_validation_model: "medium",
          ...mediumTranscript,
        };
        unit.findings = mediumFindings;
      }
    }
  }
  const blockers = units.flatMap((row) => row.findings
    .filter((finding) => finding.severity === "blocker")
    .map((finding) => ({ unit_id: row.unit_id, ...finding })));
  const warnings = units.flatMap((row) => row.findings
    .filter((finding) => finding.severity === "warning")
    .map((finding) => ({ unit_id: row.unit_id, ...finding })));
  return {
    stage,
    status: blockers.length ? "blocked" : "passed",
    transcript_qa_skipped: skipTranscriptQa,
    transcript_qa_deferred_to_local_whisper_word_timing:
      !unitTranscriptQa || skipTranscriptQa,
    transcript_qa_deferred_to: skipTranscriptQa
      ? "local_whisper_word_timing"
      : null,
    unit_count: units.length,
    blockers,
    warnings,
    warning_count: warnings.length,
    units,
  };
}

async function extractAudioWindow(inputPath, outputPath, { durationSec, tail = false }) {
  const seekArgs = tail
    ? ["-sseof", `-${durationSec.toFixed(6)}`]
    : ["-ss", "0"];
  await run("ffmpeg", [
    "-y",
    "-nostdin",
    "-v", "error",
    ...seekArgs,
    "-i", inputPath,
    "-t", durationSec.toFixed(6),
    "-ar", String(stitchSampleRate),
    "-ac", "1",
    "-acodec", "pcm_s16le",
    outputPath,
  ]);
}

async function finalStitchQa(finalWav, usable, prepared) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-tts-final-stitch-qa-"));
  try {
    const probes = [{
      ...usable[0],
      unit_id: `${usable[0].unit_id}__final_head`,
      source_unit_id: usable[0].unit_id,
      duration_sec: prepared[0].prepared_duration_sec,
      tail: false,
    }];
    if (usable.length > 1) {
      probes.push({
        ...usable.at(-1),
        unit_id: `${usable.at(-1).unit_id}__final_tail`,
        source_unit_id: usable.at(-1).unit_id,
        duration_sec: prepared.at(-1).prepared_duration_sec,
        tail: true,
      });
    }
    const rendered = [];
    for (const [index, probe] of probes.entries()) {
      const wav = path.join(tmpDir, `${index ? "tail" : "head"}.wav`);
      await extractAudioWindow(finalWav, wav, { durationSec: probe.duration_sec, tail: probe.tail });
      rendered.push({ unit_id: probe.unit_id, wav });
    }
    const boundaryQa = await qaRenderedAudioRows(probes, rendered, "final_stitch_boundary");
    const aggregate = {
      text: usable.map((row) => row.text).join(" "),
      word_count: usable.reduce((sum, row) => sum + Number(row.word_count ?? wordCount(row.text)), 0),
    };
    const [metrics, audioSha256] = await Promise.all([
      audioPcmMetrics(finalWav),
      sha256File(finalWav),
    ]);
    const acousticFindings = audioQaFindings(metrics, aggregate);
    const blockers = [
      ...boundaryQa.blockers,
      ...acousticFindings.filter((row) => row.severity === "blocker"),
    ];
    const warnings = [
      ...(boundaryQa.warnings ?? []),
      ...acousticFindings.filter((row) => row.severity === "warning"),
    ];
    return {
      status: blockers.length ? "blocked" : "passed",
      audio_path: finalWav,
      audio_sha256: audioSha256,
      metrics,
      acoustic_findings: acousticFindings,
      boundary_asr_qa: boundaryQa,
      blockers,
      warnings,
      warning_count: warnings.length,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function stitchWavs(results, finalWav, options = {}) {
  if (options.narrationQualityContract) {
    return stitchWavsV2(results, finalWav, options);
  }
  const usable = results.filter((row) => row.wav);
  if (!usable.length) return null;
  const boundaryRetentionPlans = [];
  const retainedLeadingCaps = Array(usable.length).fill(null);
  const retainedTrailingCaps = Array(usable.length).fill(null);
  for (let index = 0; index < usable.length - 1; index += 1) {
    const crossesSegment = lastSourceSegmentId(usable[index])
      !== firstSourceSegmentId(usable[index + 1]);
    const targetGapSec = stitchTargetGapSec(options, crossesSegment);
    const plan = stitchBoundaryPadding(
      usable[index].unit_qa?.metrics,
      usable[index + 1].unit_qa?.metrics,
      targetGapSec,
    );
    boundaryRetentionPlans[index] = {
      after_unit_id: usable[index].unit_id,
      before_unit_id: usable[index + 1].unit_id,
      crosses_segment: crossesSegment,
      ...plan,
    };
    retainedTrailingCaps[index] =
      plan.retained_left_trailing_silence_sample_count;
    retainedLeadingCaps[index + 1] =
      plan.retained_right_leading_silence_sample_count;
  }
  const prepared = await mapPool(
    usable,
    4,
    (row, index) => prepareStitchInput(row, index, {
      ...options,
      retainedLeadingSampleCap: retainedLeadingCaps[index],
      retainedTrailingSampleCap: retainedTrailingCaps[index],
    }),
  );
  const preparedQa = await qaRenderedAudioRows(
    usable,
    prepared.map((row) => ({ unit_id: row.unit_id, wav: row.prepared_wav })),
    "prepared_stitch_input",
    { skipTranscriptQa: options.skipRenderedTranscriptQa === true },
  );
  prepared.forEach((row, index) => {
    row.prepared_qa = preparedQa.units[index] ?? null;
  });
  if (preparedQa.status === "blocked") {
    return {
      status: "blocked",
      prepared_inputs: prepared,
      prepared_qa: preparedQa,
      boundary_qa: null,
      boundaries: [],
      final_qa: null,
      policy: {
        edge_pad_sec: stitchEdgePadSec,
        fade_sec: stitchFadeSec,
        sample_rate: stitchSampleRate,
        padding_aware: true,
        trims_verified_silence_only: true,
      },
    };
  }
  const concatPath = path.join(outDir, `concat-${retryInvocationId}.txt`);
  const lines = [];
  const boundaries = [];
  const boundaryBlockers = [];
  for (let index = 0; index < prepared.length; index += 1) {
    lines.push(concatLine(prepared[index].prepared_wav));
    if (index >= prepared.length - 1) continue;
    const plan = boundaryRetentionPlans[index];
    const targetGapSec = plan.target_gap_sec;
    // Effective join geometry is determined by the exact sample caps used to
    // build the prepared files. Acoustic silence detection can also classify
    // quiet speech or the required edge fade as silence, so it is diagnostic
    // evidence rather than the source of truth for the 80 ms sample contract.
    const leftBoundaryMetrics = {
      trailing_silence_sample_count:
        prepared[index].retained_trailing_silence_sample_count,
    };
    const rightBoundaryMetrics = {
      leading_silence_sample_count:
        prepared[index + 1].retained_leading_silence_sample_count,
    };
    const provisionalContract = stitchEffectiveBoundaryContract(
      leftBoundaryMetrics,
      rightBoundaryMetrics,
      targetGapSec,
      null,
    );
    let gapPath = null;
    if (provisionalContract.inserted_silence_sample_count > 0) {
      gapPath = await writeSilenceWav(
        path.join(
          outDir,
          `padding-gap-${stitchSampleRate}hz-${provisionalContract.inserted_silence_sample_count}samples.wav`,
        ),
        provisionalContract.inserted_silence_sample_count,
      );
    }
    const actualGapSampleCount = gapPath
      ? Number((await audioPcmMetrics(gapPath)).sample_count)
      : 0;
    const contract = stitchEffectiveBoundaryContract(
      leftBoundaryMetrics,
      rightBoundaryMetrics,
      targetGapSec,
      actualGapSampleCount,
    );
    const boundary = {
      after_unit_id: usable[index].unit_id,
      before_unit_id: usable[index + 1].unit_id,
      crosses_segment: plan.crosses_segment,
      gap_wav: gapPath,
      gap_sample_count: actualGapSampleCount,
      retention_plan: plan,
      ...contract,
    };
    boundaries.push(boundary);
    if (contract.blocker) {
      boundaryBlockers.push({
        after_unit_id: boundary.after_unit_id,
        before_unit_id: boundary.before_unit_id,
        ...contract.blocker,
      });
    } else if (gapPath) {
      lines.push(concatLine(gapPath));
    }
  }
  const boundaryQa = {
    status: boundaryBlockers.length ? "blocked" : "passed",
    sample_rate_hz: stitchSampleRate,
    target_gap_policy: "exact_80ms_effective_gap_including_retained_edges",
    exact_effective_gap_sample_count_required: true,
    boundary_count: boundaries.length,
    boundaries,
    blockers: boundaryBlockers,
  };
  if (boundaryBlockers.length) {
    return {
      status: "blocked",
      concat_path: null,
      prepared_inputs: prepared,
      prepared_qa: preparedQa,
      boundary_qa: boundaryQa,
      boundaries,
      final_qa: null,
      policy: {
        edge_pad_sec: stitchEdgePadSec,
        fade_sec: stitchFadeSec,
        sample_rate: stitchSampleRate,
        padding_aware: true,
        exact_effective_gap_sample_count: true,
        trims_verified_silence_only: true,
      },
    };
  }
  await fs.writeFile(concatPath, lines.join("\n"));
  await run("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatPath,
    "-ar", String(stitchSampleRate),
    "-ac", "1",
    "-acodec", "pcm_s16le",
    finalWav,
  ]);
  const finalQa = await finalStitchQa(finalWav, usable, prepared);
  const rmsValues = usable.map((row) => Number(row.unit_qa?.metrics?.rms_dbfs)).filter(Number.isFinite);
  const rmsSpread = rmsValues.length ? Math.max(...rmsValues) - Math.min(...rmsValues) : 0;
  return {
    status: finalQa.status,
    concat_path: concatPath,
    prepared_inputs: prepared,
    prepared_qa: preparedQa,
    boundary_qa: boundaryQa,
    boundaries,
    final_qa: finalQa,
    loudness_check: {
      unit_rms_min_dbfs: rmsValues.length ? Number(Math.min(...rmsValues).toFixed(3)) : null,
      unit_rms_max_dbfs: rmsValues.length ? Number(Math.max(...rmsValues).toFixed(3)) : null,
      unit_rms_spread_db: Number(rmsSpread.toFixed(3)),
      status: rmsSpread > 15 ? "warning_large_inter_unit_loudness_spread" : "passed",
      normalization_applied: false,
      note: "Chunk loudness is measured and reported; destructive per-unit loudness pumping is not applied.",
    },
    policy: {
      edge_pad_sec: stitchEdgePadSec,
      fade_sec: stitchFadeSec,
      sample_rate: stitchSampleRate,
      padding_aware: true,
      exact_effective_gap_sample_count: true,
      trims_verified_silence_only: true,
    },
  };
}

async function stitchWavsV2(results, finalWav, options = {}) {
  const usable = results.filter((row) => row.wav);
  if (!usable.length) return null;
  const qualityContract = options.narrationQualityContract;
  const workDir = options.workDir ?? outDir;
  const prepared = await mapPool(
    usable,
    4,
    (row, index) => prepareStitchInput(row, index, options),
  );
  const preparedQa = await qaRenderedAudioRows(
    usable,
    prepared.map((row) => ({ unit_id: row.unit_id, wav: row.prepared_wav })),
    "prepared_stitch_input_v2",
    { skipTranscriptQa: options.skipRenderedTranscriptQa === true },
  );
  prepared.forEach((row, index) => {
    row.prepared_qa = preparedQa.units[index] ?? null;
    row.sample_count = Number(row.prepared_qa?.metrics?.sample_count ?? 0) || null;
  });
  const basePolicy = {
    version: "narration_alignment_safe_semantic_stitch_v2",
    quality_contract_sha256: qualityContract.contract_sha256,
    sample_rate: stitchSampleRate,
    amplitude_only_trimming: false,
    alignment_required_for_trimming: true,
    missing_alignment_policy: "preserve_entire_unit",
    fade_over_speech: false,
    semantic_boundary_classes: true,
  };
  if (preparedQa.status === "blocked") {
    return {
      status: "blocked",
      prepared_inputs: prepared,
      prepared_qa: preparedQa,
      boundary_qa: null,
      boundaries: [],
      final_qa: null,
      policy: basePolicy,
    };
  }
  const concatPath = path.join(workDir, `concat-v2-${retryInvocationId}.txt`);
  const lines = [];
  const boundaries = [];
  const boundaryBlockers = [];
  const boundaryWarnings = [];
  for (let index = 0; index < prepared.length; index += 1) {
    lines.push(concatLine(prepared[index].prepared_wav));
    if (index >= prepared.length - 1) continue;
    const plan = planNarrationBoundary({
      leftUnit: usable[index],
      rightUnit: usable[index + 1],
      leftPrepared: prepared[index],
      rightPrepared: prepared[index + 1],
      contract: qualityContract,
    });
    let gapPath = null;
    if (plan.inserted_silence_sample_count > 0) {
      gapPath = await writeSilenceWav(
        path.join(
          workDir,
          `semantic-gap-${stitchSampleRate}hz-${plan.inserted_silence_sample_count}samples.wav`,
        ),
        plan.inserted_silence_sample_count,
      );
      lines.push(concatLine(gapPath));
    }
    const actualGapSampleCount = gapPath
      ? Number((await audioPcmMetrics(gapPath)).sample_count)
      : 0;
    const boundary = {
      boundary_id: `${usable[index].unit_id}__${usable[index + 1].unit_id}`,
      after_unit_id: usable[index].unit_id,
      before_unit_id: usable[index + 1].unit_id,
      crosses_segment: lastSourceSegmentId(usable[index])
        !== firstSourceSegmentId(usable[index + 1]),
      gap_wav: gapPath,
      gap_sample_count: actualGapSampleCount,
      ...plan,
    };
    boundaries.push(boundary);
    boundaryBlockers.push(...(plan.blockers ?? []).map((finding) => ({
      ...finding,
      boundary_id: boundary.boundary_id,
      left_unit_id: boundary.after_unit_id,
      right_unit_id: boundary.before_unit_id,
    })));
    boundaryWarnings.push(...(plan.warnings ?? []).map((finding) => ({
      ...finding,
      boundary_id: boundary.boundary_id,
      left_unit_id: boundary.after_unit_id,
      right_unit_id: boundary.before_unit_id,
    })));
  }
  const boundaryQa = {
    status: boundaryBlockers.length ? "blocked" : "passed",
    sample_rate_hz: stitchSampleRate,
    target_gap_policy: "semantic_boundary_class_with_natural_edge_silence",
    boundary_count: boundaries.length,
    boundaries,
    blockers: boundaryBlockers,
    warnings: boundaryWarnings,
  };
  if (boundaryBlockers.length) {
    return {
      status: "blocked",
      concat_path: null,
      prepared_inputs: prepared,
      prepared_qa: preparedQa,
      boundary_qa: boundaryQa,
      boundaries,
      final_qa: null,
      policy: basePolicy,
    };
  }
  await fs.writeFile(concatPath, lines.join("\n"));
  await run("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatPath,
    "-ar", String(stitchSampleRate),
    "-ac", "1",
    "-acodec", "pcm_s16le",
    finalWav,
  ]);
  const finalQa = await finalStitchQa(finalWav, usable, prepared);
  const sampleAccounting = validateNarrationStitchAccounting({
    preparedInputs: prepared,
    boundaries,
    finalSampleCount: finalQa?.metrics?.sample_count,
    sampleRate: stitchSampleRate,
  });
  const finalStatus = finalQa.status === "passed"
    && sampleAccounting.status !== "blocked"
    ? "passed"
    : "blocked";
  const rmsValues = usable
    .map((row) => Number(row.unit_qa?.metrics?.rms_dbfs))
    .filter(Number.isFinite);
  const rmsSpread = rmsValues.length
    ? Math.max(...rmsValues) - Math.min(...rmsValues)
    : 0;
  return {
    status: finalStatus,
    concat_path: concatPath,
    prepared_inputs: prepared,
    prepared_qa: preparedQa,
    boundary_qa: boundaryQa,
    boundaries,
    final_qa: finalQa,
    sample_accounting: sampleAccounting,
    loudness_check: {
      unit_rms_min_dbfs: rmsValues.length ? Number(Math.min(...rmsValues).toFixed(3)) : null,
      unit_rms_max_dbfs: rmsValues.length ? Number(Math.max(...rmsValues).toFixed(3)) : null,
      unit_rms_spread_db: Number(rmsSpread.toFixed(3)),
      status: rmsSpread > 15 ? "warning_large_inter_unit_loudness_spread" : "passed",
      normalization_applied: false,
      note: "Raw dynamics are measured before one final stream-level mastering pass.",
    },
    policy: basePolicy,
  };
}

export async function stitchWavsForDiagnostics(results, finalWav, options = {}) {
  return stitchWavs(results, finalWav, options);
}

export async function runFasterWhisperUnitBatchForDiagnostics(rows, options = {}) {
  return runFasterWhisperUnitBatch(rows, options);
}

function assertStitchVoiceIntegrity(results, lock) {
  const narratorVoiceId = lock?.narrator_voice_id ?? qwenNarratorVoiceId;
  const wrongRows = [];
  for (const row of results) {
    const speaker = String(row?.speaker ?? "NARRATOR").toUpperCase();
    const narratorScoped = !characterVoiceCasting || speaker === "NARRATOR" || speaker === "MC_INTERNAL";
    if (narratorScoped && row?.voice_id !== narratorVoiceId) {
      wrongRows.push(`${row?.segment_id ?? "unknown"}:${row?.voice_id ?? "missing"}`);
    }
  }
  if (wrongRows.length) {
    throw new Error(`Refusing Qwen stitch: ${wrongRows.length} segment(s) do not match locked narrator voice '${narratorVoiceId}': ${wrongRows.slice(0, 8).join(", ")}`);
  }
}

async function main() {
  if (requestedQwenInstructionField && !qwenInstructionField) {
    throw new Error(`Unsupported --qwen-instruct-field '${requestedQwenInstructionField}'. Allowed explicit provider fields: ${[...allowedQwenInstructionFields].join(", ")}.`);
  }
  if (regenerateSpeakers.size > 0 && regenerateUnitIds.size > 0) {
    throw new Error("Choose one scoped Qwen retry mode: --regenerate-speakers or --regenerate-unit-ids, not both.");
  }
  await fs.mkdir(outDir, { recursive: true });
  const lock = await buildVoiceLock();
  if (lock.status !== "passed") throw new Error(`ModelsLab Qwen voice lock is ${lock.status}; inspect ${lockPath}`);
  const plan = await readJson(planPath);
  if (!plan?.segments?.length) throw new Error(`Missing qwen generation plan at ${planPath}`);
  const overrides = await readJson(overridesPath, { overrides: [] });
  let units = applyTextOverrides(collectUnits(plan, lock), overrides);
  if (maxSegments > 0) units = units.filter((unit) => Number(unit.segment_id?.match(/(\d+)/)?.[1] ?? 0) <= maxSegments);
  if (maxDurationSec > 0) {
    let total = 0;
    units = units.filter((unit) => {
      total += Math.max(1.5, unit.text.split(/\s+/).length / 150 * 60);
      return total <= maxDurationSec;
    });
  }
  if (regenerateUnitIds.size > 0) assertRegenerateUnitIdsExist(units, regenerateUnitIds);
  const previousReportPath = flags["previous-report"]
    ?? path.join(episodeRoot, `modelslab_qwen_tts_report_${episode}${reportSuffix ? `-${reportSuffix}` : ""}.json`);
  const targetedRegeneration = regenerateSpeakers.size > 0 || regenerateUnitIds.size > 0;
  const previousReport = targetedRegeneration || reuseUnchanged ? await readJson(previousReportPath, null) : null;
  const previousResults = previousResultMap(previousReport);
  const previousContentResults = previousContentResultMap(previousReport);
  const previousUnitIds = previousUnitIdResultMap(previousReport);
  if (targetedRegeneration && !previousResults.size && !previousUnitIds.size) {
    const scope = regenerateUnitIds.size ? [...regenerateUnitIds].join(", ") : [...regenerateSpeakers].join(", ");
    throw new Error(`Targeted regeneration requested for ${scope} but no previous TTS report was readable at ${previousReportPath}`);
  }
  if (reuseUnchanged && !previousContentResults.size) {
    throw new Error(`Unchanged-unit Qwen TTS reuse requested but no previous TTS report was readable at ${previousReportPath}`);
  }

  const results = new Array(units.length);
  let cursor = 0;
  let completed = 0;
  async function worker(workerIndex) {
    while (cursor < units.length) {
      const index = cursor;
      cursor += 1;
      console.log(`modelslab qwen ${index + 1}/${units.length} w${workerIndex} ${units[index].speaker}: ${units[index].text.slice(0, 70)}`);
      results[index] = await synthesizeUnit(units[index], lock, index, previousResults, previousContentResults, previousUnitIds);
      completed += 1;
      if (completed % 25 === 0 || completed === units.length) {
        console.log(`modelslab qwen progress ${completed}/${units.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, units.length) }, (_item, index) => worker(index + 1)));

  const finalWav = path.join(path.dirname(outDir), `${episode}-${channel}-pilot-qwen-modelslab${suffix}.wav`);
  const finalM4a = finalWav.replace(/\.wav$/, ".m4a");
  const unitQaReportPath = path.join(episodeRoot, `qwen_tts_unit_qa_${episode}${reportSuffix ? `-${reportSuffix}` : ""}.json`);
  const unitQaReport = dryRun ? {
    status: "not_run_dry_run",
    policy_version: TTS_OUTPUT_QA_POLICY_VERSION,
    unit_count: results.length,
    units: results.map((row) => ({ unit_id: row.unit_id, segment_id: row.segment_id, text: row.text })),
  } : await runUnitOutputQa(results);
  await fs.writeFile(unitQaReportPath, JSON.stringify(unitQaReport, null, 2));
  let stitch = null;
  if (!dryRun && unitQaReport.status === "passed" && results.some((row) => row.wav)) {
    assertStitchVoiceIntegrity(results, lock);
    stitch = await stitchWavs(results, finalWav);
    if (stitch?.status === "passed") {
      await run("ffmpeg", ["-y", "-i", finalWav, "-acodec", "aac", "-b:a", "160k", finalM4a]);
      await fs.writeFile(finalWav.replace(/\.wav$/, ".intended-transcript.txt"), results.map((row) => row.text).join("\n"), "utf8");
      await fs.writeFile(finalM4a.replace(/\.m4a$/, ".intended-transcript.txt"), results.map((row) => row.text).join("\n"), "utf8");
    }
  }
  const reportStatus = unitQaReport.status === "blocked" || stitch?.status === "blocked"
    ? "blocked"
    : results.every((row) => row.status !== "failed")
    ? "passed"
    : "warning";
  const preparedByUnitId = new Map((stitch?.prepared_inputs ?? []).map((row) => [String(row.unit_id), row]));
  const boundaryByUnitId = new Map((stitch?.boundaries ?? []).map((row) => [String(row.after_unit_id), row]));
  const report = {
    status: reportStatus,
    provider: "modelslab_qwen",
    model_id: "qwen-tts",
    provider_model_attestation: "requested_qwen_tts_response_model_identity_not_attested",
    created_at: new Date().toISOString(),
    source_script_hash: plan.source_script_hash ?? null,
    source_script_path: plan.source_script_path ?? path.join(episodeRoot, "script_clean.md"),
    episode_root: episodeRoot,
    lock_path: lockPath,
    plan_path: planPath,
    out_dir: outDir,
    regenerate_speakers: [...regenerateSpeakers],
    regenerate_unit_ids: [...regenerateUnitIds],
    regeneration_scope: regenerateUnitIds.size
      ? "exact_unit_ids"
      : regenerateSpeakers.size
      ? "exact_speakers"
      : force
      ? "explicit_full_force"
      : "full_or_cache_reuse",
    retry_invocation_id: targetedRegeneration || force ? retryInvocationId : null,
    reuse_unchanged: reuseUnchanged,
    previous_report_path: previousReportPath,
    final_wav: stitch?.status === "passed" ? finalWav : null,
    final_wav_sha256: stitch?.status === "passed" ? stitch.final_qa?.audio_sha256 ?? await sha256File(finalWav) : null,
    final_m4a: stitch?.status === "passed" ? finalM4a : null,
    final_m4a_sha256: stitch?.status === "passed" ? await sha256File(finalM4a) : null,
    concat_path: stitch?.concat_path ?? null,
    stitch,
    segment_gap_sec: segmentGapSec,
    unit_gap_sec: unitGapSec,
    stitch_edge_pad_sec: stitchEdgePadSec,
    stitch_fade_sec: stitchFadeSec,
    native_speed: nativeSpeed,
    pace_strategy: "provider_native_speed_no_post_tempo",
    post_tempo_normalized: false,
    stitch_sample_rate: stitchSampleRate,
    chunk_policy: {
      sentence_bounded: true,
      min_words_target: minWords,
      max_words: maxWords,
      max_chars: maxChars,
      below_min_word_target_count: results.filter((row) => Number(row.word_count ?? 0) < minWords).length,
      crosses_segment_boundaries: results.some((row) => (row.source_segment_ids ?? []).length > 1),
      crosses_qwen_instruct_boundaries: false,
    },
    qwen_instruction_delivery: {
      provider_endpoint: "/api/v6/voice/text_to_audio",
      configured_field: qwenInstructionField,
      status: qwenInstructionField
        ? "explicit_operator_configured_provider_field"
        : "unsupported_by_current_modelslab_v6_contract_not_submitted",
      authored_instruction_count: results.filter((row) => row.qwen_instruct).length,
      submitted_instruction_count: results.filter((row) => row.instruction_delivery?.submitted).length,
    },
    unit_qa_report_path: unitQaReportPath,
    unit_qa_status: unitQaReport.status,
    unit_qa_policy_version: TTS_OUTPUT_QA_POLICY_VERSION,
    unit_count: results.length,
    duration_sec: stitch?.status === "passed" ? await mediaDuration(finalWav).catch(() => results.reduce((sum, row) => {
      const prepared = preparedByUnitId.get(String(row.unit_id));
      const boundary = boundaryByUnitId.get(String(row.unit_id));
      return sum + Number(prepared?.prepared_duration_sec ?? row.duration_sec ?? 0) + Number(boundary?.inserted_silence_sec ?? 0);
    }, 0)) : null,
    results,
  };
  const reportPath = path.join(episodeRoot, `modelslab_qwen_tts_report_${episode}${reportSuffix ? `-${reportSuffix}` : ""}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  const stitchReportSuffix = dryRun ? `-${reportSuffix}` : suffix;
  const stitchReportPath = path.join(episodeRoot, suffixFileWith(stitchReportSuffix, `audio_stitch_report_${episode}`, ".json"));
  await fs.writeFile(stitchReportPath, JSON.stringify({
    status: report.status,
    provider: "modelslab_qwen",
    model_id: "qwen-tts",
    created_at: report.created_at,
    source_script_hash: report.source_script_hash,
    source_script_path: report.source_script_path,
    output_path: report.final_wav,
    output_sha256: report.final_wav_sha256,
    final_wav_sha256: report.final_wav_sha256,
    final_m4a_path: report.final_m4a,
    final_m4a_sha256: report.final_m4a_sha256,
    sound_design_mix_path: null,
    final_duration_sec: report.duration_sec,
    native_speed: nativeSpeed,
    pace_strategy: "provider_native_speed_no_post_tempo",
    post_tempo_normalized: false,
    unit_qa_report_path: unitQaReportPath,
    unit_qa_status: unitQaReport.status,
    unit_qa_policy_version: TTS_OUTPUT_QA_POLICY_VERSION,
    provider_model_attestation: report.provider_model_attestation,
    qwen_instruction_delivery: report.qwen_instruction_delivery,
    stitch_policy: stitch?.policy ?? null,
    stitch_loudness_check: stitch?.loudness_check ?? null,
    stitch_boundaries: stitch?.boundaries ?? [],
    segments: results.map((row, index) => ({
      unit_id: row.unit_id,
      segment_id: row.segment_id,
      text: row.text,
      stripped_text: row.text,
      caption_text: row.caption_text ?? row.text,
      speakers: [row.speaker],
      speaker_context: [row.speaker],
      delivery_mode: "modelslab_qwen_tts",
      raw_audio_duration_sec: row.duration_sec,
      prepared_audio_duration_sec: preparedByUnitId.get(String(row.unit_id))?.prepared_duration_sec ?? null,
      segment_gap_sec: index < results.length - 1 && boundaryByUnitId.get(String(row.unit_id))?.crosses_segment
        ? Number(boundaryByUnitId.get(String(row.unit_id))?.effective_gap_sec ?? segmentGapSec)
        : 0,
      unit_gap_sec: index < results.length - 1 && !boundaryByUnitId.get(String(row.unit_id))?.crosses_segment
        ? Number(boundaryByUnitId.get(String(row.unit_id))?.effective_gap_sec ?? unitGapSec)
        : 0,
      inserted_silence_sec: Number(boundaryByUnitId.get(String(row.unit_id))?.inserted_silence_sec ?? 0),
      duration_sec: Number((Number(preparedByUnitId.get(String(row.unit_id))?.prepared_duration_sec ?? row.duration_sec ?? 0)
        + Number(boundaryByUnitId.get(String(row.unit_id))?.inserted_silence_sec ?? 0)).toFixed(6)),
      audio_path: row.wav,
      prepared_audio_path: preparedByUnitId.get(String(row.unit_id))?.prepared_wav ?? null,
      tts_provider: "modelslab_qwen",
      voice_id: row.voice_id,
      native_speed: nativeSpeed,
      qwen_instruct: row.qwen_instruct ?? null,
      authored_qwen_instructions: row.authored_qwen_instructions ?? [],
      instruction_delivery: row.instruction_delivery ?? null,
      source_segment_ids: row.source_segment_ids ?? [],
      source_unit_refs: row.source_unit_refs ?? [],
      caption_fragments: row.caption_fragments ?? [],
      unit_qa: row.unit_qa ?? null,
    })),
    modelslab_qwen_tts_report_path: reportPath,
    modelslab_qwen_voice_lock_path: lockPath,
  }, null, 2));
  console.log(JSON.stringify({ status: report.status, unit_count: report.unit_count, duration_sec: report.duration_sec, final_m4a: report.final_m4a, report_path: reportPath }, null, 2));
  if (report.status === "blocked") process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
