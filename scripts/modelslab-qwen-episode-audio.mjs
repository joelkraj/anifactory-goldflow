#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const args = process.argv.slice(2);
const flags = parseFlags(args);
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeRoot = flags.episodeDir ?? path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
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
const characterVoiceCasting = /^(?:true|1|yes|enabled|on)$/i.test(String(flags["character-voice-casting"] ?? process.env.ANIFACTORY_CHARACTER_VOICE_CASTING ?? "false").trim());
const reportSuffix = dryRun || suffix !== "-modelslab-qwen" ? slug(suffix) : "";
const regenerateSpeakers = new Set(String(flags["regenerate-speakers"] ?? "")
  .split(",")
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean));
const maxChars = Number(flags["max-chars"] ?? 850);
const concurrency = Math.max(1, Math.min(15, Number(flags.concurrency ?? process.env.ANIFACTORY_MODELSLAB_QWEN_CONCURRENCY ?? 8)));
const segmentGapSec = Math.max(0, Math.min(1.5, Number(flags["segment-gap-sec"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_SEGMENT_GAP_SEC ?? 0.22)));
const stitchSampleRate = Math.max(8000, Math.min(96000, Number(flags["stitch-sample-rate"] ?? process.env.ANIFACTORY_MODELSLAB_QWEN_STITCH_SAMPLE_RATE ?? 24000)));
const qwenFetchTimeoutMs = Math.max(30000, Number(process.env.ANIFACTORY_MODELSLAB_QWEN_FETCH_TIMEOUT_MS ?? 120000));
const refreshVoiceIds = new Set(String(process.env.ANIFACTORY_MODELSLAB_QWEN_REFRESH_VOICES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));

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

async function post(endpoint, body) {
  const attempts = Math.max(1, Number(process.env.ANIFACTORY_MODELSLAB_QWEN_POST_ATTEMPTS ?? 6));
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
      throw new Error(`${endpoint} returned non-json ${response.status}: ${text.slice(0, 500)}`);
    }
    if (!response.ok || json.status === "error" || json.status === "failed") {
      if (attempt < attempts && isRateLimitResponse(response, json)) {
        const delayMs = baseDelayMs * attempt;
        console.warn(`${endpoint} rate limited (attempt ${attempt}/${attempts}); retrying in ${Math.round(delayMs / 1000)}s`);
        await sleep(delayMs);
        continue;
      }
      throw new Error(`${endpoint} failed ${response.status}: ${JSON.stringify(json).slice(0, 1200)}`);
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

async function fetchVoiceRequest(id) {
  const attempts = Math.max(1, Number(process.env.ANIFACTORY_MODELSLAB_QWEN_FETCH_ATTEMPTS ?? 4));
  const baseDelayMs = Math.max(1000, Number(process.env.ANIFACTORY_MODELSLAB_QWEN_FETCH_BACKOFF_MS ?? 5000));
  let response;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await fetchWithTimeout(`https://modelslab.com/api/v6/voice/fetch/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: apiKey() }),
      });
      break;
    } catch (error) {
      if (attempt < attempts && isAbortError(error)) {
        const delayMs = baseDelayMs * attempt;
        console.warn(`/api/v6/voice/fetch/${id} timed out (attempt ${attempt}/${attempts}); retrying in ${Math.round(delayMs / 1000)}s`);
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`/api/v6/voice/fetch/${id} returned non-json ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok || json.status === "error") {
    throw new Error(`/api/v6/voice/fetch/${id} failed ${response.status}: ${JSON.stringify(json).slice(0, 1200)}`);
  }
  return json;
}

async function resolveAudioResponse(initial) {
  let current = initial;
  let requestId = initial?.id ?? null;
  let lastWithLinks = audioLinks(initial).length ? initial : null;
  for (let attempt = 0; attempt < 96; attempt += 1) {
    const links = audioLinks(current);
    if (current?.status === "success" && links.length) return current;
    if (links.length) lastWithLinks = current;
    const message = String(current?.message ?? "");
    if (current?.status === "failed" && /try again/i.test(message) && requestId) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      current = await fetchVoiceRequest(requestId);
      continue;
    }
    if (current?.status === "failed" && /request not found/i.test(message) && lastWithLinks) {
      return lastWithLinks;
    }
    if (current?.status === "failed" || current?.status === "error") {
      throw new Error(`ModelsLab Qwen request failed while polling: ${JSON.stringify(current).slice(0, 1200)}`);
    }
    if (current?.id) requestId = current.id;
    if (!requestId) {
      if (links.length) return current;
      throw new Error(`ModelsLab Qwen returned no request id or audio URL: ${JSON.stringify(current).slice(0, 1200)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
    current = await fetchVoiceRequest(requestId);
  }
  throw new Error(`Timed out polling ModelsLab Qwen request ${initial?.id ?? "unknown"}`);
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

async function uploadAudioReference(filePath, voiceId) {
  if (!filePath || !(await exists(filePath))) throw new Error(`Cannot refresh init_audio for ${voiceId}: missing local source ${filePath}`);
  await fs.mkdir(uploadDir, { recursive: true });
  const base64 = (await fs.readFile(filePath)).toString("base64");
  const response = await post("/api/v6/base64_to_url", {
    base64_string: `data:${audioMime(filePath)};base64,${base64}`,
  });
  const uploadedUrl = audioLinks(response)[0];
  if (!uploadedUrl) throw new Error(`ModelsLab upload returned no URL for ${voiceId}`);
  await fs.writeFile(path.join(uploadDir, `${slug(voiceId)}.upload.json`), JSON.stringify({ response, source_audio_path: filePath, uploaded_url: uploadedUrl }, null, 2));
  return uploadedUrl;
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

function cleanText(value) {
  return String(value ?? "")
    .replace(/\[[^\]]+\]\s*/g, "")
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
  let text = String(value ?? "");
  for (let pass = 0; pass < 3; pass += 1) {
    text = text.replace(/\b([A-Za-z]+),\s+\1\b/gi, "$1");
  }
  const clauses = text
    .split(/\s*[,.!?;:—-]+\s*/g)
    .map((part) => part.trim())
    .filter(Boolean);
  if (clauses.length >= 3) {
    const normalizedClauses = clauses.map((part) => part.toLowerCase());
    const uniqueClauses = [...new Set(normalizedClauses)];
    if (uniqueClauses.length === 1) text = clauses[0];
  }
  return text
    .replace(/\b([a-z])-\1([A-Za-z]{2,})\b/g, (_match, lead, rest) => `${lead}${rest}`)
    .replace(/\b([a-z])-\s*([A-Za-z]{2,})\b/g, (_match, _lead, rest) => rest)
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
  return units.map((unit, index) => {
    const match = rows.find((row) => {
      if (Number(row.index ?? 0) === index + 1) return true;
      return String(row.segment_id ?? "") === String(unit.segment_id ?? "")
        && String(row.speaker ?? "").toUpperCase() === String(unit.speaker ?? "").toUpperCase();
    });
    if (!match?.text) return unit;
    return {
      ...unit,
      text: ttsSafeText(match.text),
      text_override_reason: match.reason ?? "manual_qwen_audio_quality_repair",
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
    .replace(/\bLevel\s*[-:]\s*-\s*(\d{1,2})\b/gi, (_match, level) => `Level negative ${numberWord(level)}`)
    .replace(/\s+/g, " ")
    .trim();
  return normalizeTtsDisfluencies(normalizeAllCapsForTts(normalized));
}

function slug(value) {
  return String(value ?? "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function suffixFileWith(label, base, extension) {
  const clean = String(label ?? "").replace(/[^a-z0-9._-]/gi, "-");
  return `${base}${clean.startsWith("-") ? clean : `-${clean}`}${extension}`;
}

function unitReuseKey(unit) {
  return [
    String(unit.segment_id ?? ""),
    String(unit.unit_index ?? ""),
    String(unit.speaker ?? "").toUpperCase(),
    String(unit.text ?? "").replace(/\s+/g, " ").trim(),
  ].join("\u001f");
}

function previousResultMap(report) {
  const map = new Map();
  for (const row of report?.results ?? []) {
    map.set(unitReuseKey(row), row);
  }
  return map;
}

function speakerVoiceId(speaker, lock = null) {
  const normalized = String(speaker ?? "NARRATOR").toUpperCase();
  if (!characterVoiceCasting) return "joel_narrator";
  if (normalized === "MC_INTERNAL") return "joel_narrator";
  const lockedVoice = lock?.speaker_casting?.[normalized]?.id ?? lock?.speaker_casting?.[normalized]?.reference_id;
  if (lockedVoice) return lockedVoice;
  if (normalized === "NARRATOR") return "joel_narrator";
  throw new Error(`Missing ModelsLab Qwen speaker casting for '${normalized}'. Run qwen-tts modelslab-voice-design or voice-casting before episode audio.`);
}

function assertProductionVoiceRoute(unit, lock) {
  const normalized = String(unit.speaker ?? "NARRATOR").toUpperCase();
  if (normalized === "NARRATOR" && unit.voice_id !== "joel_narrator") {
    throw new Error(`Refusing Qwen TTS: narrator routed to '${unit.voice_id}', expected Joel clone 'joel_narrator'.`);
  }
  const voice = lock.voices.find((item) => item.id === unit.voice_id);
  if (!voice?.init_audio) throw new Error(`Missing ModelsLab init_audio for voice ${unit.voice_id}`);
  return voice;
}

function chunkTextBySentence(text, limit) {
  const sentences = String(text ?? "").match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
  const chunks = [];
  for (const sentence of sentences.length ? sentences : [text]) {
    const last = chunks[chunks.length - 1];
    if (last && `${last} ${sentence}`.length <= limit) chunks[chunks.length - 1] = `${last} ${sentence}`;
    else if (sentence.length <= limit) chunks.push(sentence);
    else {
      const words = sentence.split(/\s+/);
      let current = "";
      for (const word of words) {
        if (`${current} ${word}`.trim().length > limit && current) {
          chunks.push(current);
          current = word;
        } else {
          current = `${current} ${word}`.trim();
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
  const activeVoices = characterVoiceCasting
    ? voices
    : [byId.joel_narrator ?? byId.narrator].filter(Boolean);
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
    production_ready: activeVoices.some((voice) => voice.id === "joel_narrator" && voice.status === "passed" && voice.init_audio),
    created_at: new Date().toISOString(),
    tts_provider: "modelslab_qwen",
    tts_model_id: "qwen-tts",
    tts_endpoint: "/api/v6/voice/text_to_audio",
    voice_design_model_id: "qwen-voice-design",
    voice_casting_mode: characterVoiceCasting ? "explicit_character_voice_casting" : "narrator_only_default",
    character_voice_casting_enabled: characterVoiceCasting,
    source_manifest_path: path.join(reviewVoiceDir, "voice_design_manifest.json"),
    voices: activeVoices,
    speaker_casting: {
      ...manifestCasting,
      NARRATOR: byId.joel_narrator ?? byId.narrator,
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
  lock.status = lock.voices.every((voice) => voice.status === "passed" && voice.init_audio) ? "passed" : "warning";
  lock.production_ready = lock.voices.some((voice) => voice.id === "joel_narrator" && voice.status === "passed" && voice.init_audio);
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
  await fs.writeFile(path.join(episodeRoot, `voice_casting_lock_${episode}.json`), JSON.stringify(lock, null, 2));
  if (episode === "ep_01") {
    await fs.writeFile(path.join(episodeRoot, "voice_casting_lock_ep_01.json"), JSON.stringify(lock, null, 2));
  }
  return lock;
}

function collectUnits(plan, lock) {
  const rawUnits = [];
  for (const segment of plan.segments ?? []) {
    for (const unit of segment.qwen_generation_units ?? []) {
      const inline = inlineSpeakerUnit(unit.qwen_spoken_text ?? unit.text ?? unit.source_text ?? "", unit.speaker ?? "NARRATOR");
      const text = ttsSafeText(inline.text);
      if (!text) continue;
      rawUnits.push({
        segment_id: segment.segment_id,
        unit_index: unit.unit_index,
        speaker: inline.speaker,
        voice_id: speakerVoiceId(inline.speaker, lock),
        text,
        expected_duration_sec: Number(segment.expected_duration_sec ?? 0),
      });
    }
  }

  const merged = [];
  for (const unit of rawUnits) {
    const normalized = String(unit.speaker ?? "NARRATOR").toUpperCase();
    const last = merged[merged.length - 1];
    const canMergeNarrator = normalized === "NARRATOR"
      && last
      && String(last.speaker ?? "").toUpperCase() === "NARRATOR"
      && last.segment_id === unit.segment_id
      && `${last.text} ${unit.text}`.length <= maxChars;
    if (canMergeNarrator) {
      last.text = `${last.text} ${unit.text}`.replace(/\s+/g, " ").trim();
    } else {
      merged.push({ ...unit });
    }
  }

  const units = [];
  for (const unit of merged) {
    for (const chunk of chunkTextBySentence(unit.text, maxChars)) {
      units.push({
        ...unit,
        text: chunk,
      });
      }
  }
  return units;
}

async function synthesizeUnit(unit, lock, index, previousResults = new Map()) {
  const normalizedSpeaker = String(unit.speaker ?? "NARRATOR").toUpperCase();
  const targetedRegeneration = regenerateSpeakers.size > 0;
  const shouldRegenerateThisSpeaker = !targetedRegeneration || regenerateSpeakers.has(normalizedSpeaker);
  if (targetedRegeneration && !shouldRegenerateThisSpeaker) {
    const previous = previousResults.get(unitReuseKey(unit));
    if (previous?.wav && await exists(previous.wav)) {
      return {
        ...unit,
        status: "reused_previous_report",
        wav: previous.wav,
        duration_sec: await mediaDuration(previous.wav),
        previous_voice_id: previous.voice_id,
        previous_status: previous.status,
        targeted_regeneration_skipped: true,
      };
    }
    throw new Error(`Targeted regeneration for ${[...regenerateSpeakers].join(", ")} cannot reuse prior audio for ${unit.segment_id} ${unit.speaker}; refusing unintended generation.`);
  }
  const voice = assertProductionVoiceRoute(unit, lock);
  const basename = `${String(index + 1).padStart(4, "0")}-${slug(unit.segment_id)}-${slug(unit.speaker)}-${slug(unit.voice_id)}`;
  const wav = path.join(outDir, `${basename}.wav`);
  const meta = path.join(outDir, `${basename}.json`);
  const cachedMeta = await readJson(meta, null);
  const cacheMatchesUnit = cachedMeta
    && cachedMeta.unit?.text === unit.text
    && String(cachedMeta.unit?.speaker ?? "").toUpperCase() === normalizedSpeaker
    && cachedMeta.unit?.voice_id === unit.voice_id
    && cachedMeta.voice?.init_audio === voice.init_audio;
  if (!force && !targetedRegeneration && await exists(wav)) {
    if (cacheMatchesUnit) {
      return { ...unit, status: "reused", wav, duration_sec: await mediaDuration(wav), meta };
    }
    await fs.rm(wav, { force: true });
  }
  if (dryRun) {
    return { ...unit, status: "dry_run", wav, meta };
  }
  const makeRequest = () => post("/api/v6/voice/text_to_audio", {
      model_id: "qwen-tts",
      init_audio: voice.init_audio,
      prompt: unit.text,
      language: "english",
      track_id: 12000 + index,
    });
  const previous = force || !cacheMatchesUnit ? null : cachedMeta;
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
    }, null, 2));
    try {
      resolved = await resolveAudioResponse(initial);
      const url = audioLinks(resolved)[0];
      if (!url) throw new Error(`ModelsLab Qwen returned no audio URL for ${unit.segment_id}`);
      await fs.writeFile(meta, JSON.stringify({ request: initial, resolved, unit, voice }, null, 2));
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
      }, null, 2));
    }
  }
  if (!resolved) throw lastError ?? new Error(`ModelsLab Qwen did not resolve ${unit.segment_id}`);
  if (!finalUrl) throw lastError ?? new Error(`ModelsLab Qwen did not download audio for ${unit.segment_id}`);
  return { ...unit, status: "generated", wav, url: finalUrl, duration_sec: await mediaDuration(wav), meta };
}

function concatLine(filePath) {
  return `file '${filePath.replaceAll("'", "'\\''")}'`;
}

async function writeSilenceWav(filePath, durationSec) {
  if (durationSec <= 0) return null;
  if (await exists(filePath)) return filePath;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await run("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", `anullsrc=r=${stitchSampleRate}:cl=mono`,
    "-t", durationSec.toFixed(3),
    "-acodec", "pcm_s16le",
    filePath,
  ]);
  return filePath;
}

async function stitchWavs(results, finalWav) {
  const usable = results.filter((row) => row.wav);
  if (!usable.length) return null;
  const concatPath = path.join(outDir, "concat.txt");
  const gapPath = segmentGapSec > 0 ? await writeSilenceWav(path.join(outDir, `segment-gap-${Math.round(segmentGapSec * 1000)}ms.wav`), segmentGapSec) : null;
  const lines = [];
  for (let index = 0; index < usable.length; index += 1) {
    lines.push(concatLine(usable[index].wav));
    if (gapPath && index < usable.length - 1) lines.push(concatLine(gapPath));
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
  return concatPath;
}

async function main() {
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
  const previousReportPath = flags["previous-report"]
    ?? path.join(episodeRoot, `modelslab_qwen_tts_report_${episode}${reportSuffix ? `-${reportSuffix}` : ""}.json`);
  const previousReport = regenerateSpeakers.size > 0 ? await readJson(previousReportPath, null) : null;
  const previousResults = previousResultMap(previousReport);
  if (regenerateSpeakers.size > 0 && !previousResults.size) {
    throw new Error(`Targeted regeneration requested for ${[...regenerateSpeakers].join(", ")} but no previous TTS report was readable at ${previousReportPath}`);
  }

  const results = new Array(units.length);
  let cursor = 0;
  let completed = 0;
  async function worker(workerIndex) {
    while (cursor < units.length) {
      const index = cursor;
      cursor += 1;
      console.log(`modelslab qwen ${index + 1}/${units.length} w${workerIndex} ${units[index].speaker}: ${units[index].text.slice(0, 70)}`);
      results[index] = await synthesizeUnit(units[index], lock, index, previousResults);
      completed += 1;
      if (completed % 25 === 0 || completed === units.length) {
        console.log(`modelslab qwen progress ${completed}/${units.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, units.length) }, (_item, index) => worker(index + 1)));

  const finalWav = path.join(path.dirname(outDir), `${episode}-${channel}-pilot-qwen-modelslab${suffix}.wav`);
  const finalM4a = finalWav.replace(/\.wav$/, ".m4a");
  let concatPath = null;
  if (!dryRun && results.some((row) => row.wav)) {
    concatPath = await stitchWavs(results, finalWav);
    await run("ffmpeg", ["-y", "-i", finalWav, "-acodec", "aac", "-b:a", "160k", finalM4a]);
    await fs.writeFile(finalWav.replace(/\.wav$/, ".intended-transcript.txt"), results.map((row) => row.text).join("\n"), "utf8");
    await fs.writeFile(finalM4a.replace(/\.m4a$/, ".intended-transcript.txt"), results.map((row) => row.text).join("\n"), "utf8");
  }
  const report = {
    status: results.every((row) => row.status !== "failed") ? "passed" : "warning",
    provider: "modelslab_qwen",
    model_id: "qwen-tts",
    created_at: new Date().toISOString(),
    source_script_hash: plan.source_script_hash ?? null,
    source_script_path: plan.source_script_path ?? path.join(episodeRoot, "script_clean.md"),
    episode_root: episodeRoot,
    lock_path: lockPath,
    plan_path: planPath,
    out_dir: outDir,
    regenerate_speakers: [...regenerateSpeakers],
    previous_report_path: previousReportPath,
    final_wav: dryRun ? null : finalWav,
    final_m4a: dryRun ? null : finalM4a,
    concat_path: concatPath,
    segment_gap_sec: segmentGapSec,
    stitch_sample_rate: stitchSampleRate,
    unit_count: results.length,
    duration_sec: dryRun ? null : await mediaDuration(finalWav).catch(() => results.reduce((sum, row) => sum + Number(row.duration_sec ?? 0), 0) + Math.max(0, results.length - 1) * segmentGapSec),
    results,
  };
  const reportPath = path.join(episodeRoot, `modelslab_qwen_tts_report_${episode}${reportSuffix ? `-${reportSuffix}` : ""}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  const stitchReportPath = path.join(episodeRoot, suffixFileWith(suffix, `audio_stitch_report_${episode}`, ".json"));
  await fs.writeFile(stitchReportPath, JSON.stringify({
    status: report.status,
    provider: "modelslab_qwen",
    model_id: "qwen-tts",
    created_at: report.created_at,
    source_script_hash: report.source_script_hash,
    source_script_path: report.source_script_path,
    output_path: report.final_wav,
    sound_design_mix_path: null,
    final_duration_sec: report.duration_sec,
    segments: results.map((row, index) => ({
      segment_id: row.segment_id,
      text: row.text,
      stripped_text: row.text,
      caption_text: row.text,
      speakers: [row.speaker],
      speaker_context: [row.speaker],
      delivery_mode: "modelslab_qwen_tts",
      raw_audio_duration_sec: row.duration_sec,
      segment_gap_sec: index < results.length - 1 ? segmentGapSec : 0,
      duration_sec: Number((Number(row.duration_sec ?? 0) + (index < results.length - 1 ? segmentGapSec : 0)).toFixed(6)),
      audio_path: row.wav,
      tts_provider: "modelslab_qwen",
      voice_id: row.voice_id,
    })),
    modelslab_qwen_tts_report_path: reportPath,
    modelslab_qwen_voice_lock_path: lockPath,
  }, null, 2));
  console.log(JSON.stringify({ status: report.status, unit_count: report.unit_count, duration_sec: report.duration_sec, final_m4a: report.final_m4a, report_path: reportPath }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
