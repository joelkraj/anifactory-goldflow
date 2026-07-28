#!/usr/bin/env node

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const flags = parseFlags(process.argv.slice(2));
const manifestPath = path.resolve(requiredFlag("manifest"));
const outputDir = path.resolve(requiredFlag("output-dir"));
const referenceAudioPath = path.resolve(requiredFlag("ref-audio"));
const modelId = flags["model-id"] ?? "modelslab_qwen";
const nativeSpeed = Math.max(0.75, Math.min(1.5, Number(flags["native-speed"] ?? 1)));
const concurrency = Math.max(1, Math.min(6, Number(flags.concurrency ?? 4)));
let cachedApiKey = null;

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

function requiredFlag(name) {
  const value = flags[name];
  if (!value || value === "true") throw new Error(`Missing --${name}`);
  return value;
}

function apiKey() {
  if (cachedApiKey) return cachedApiKey;
  if (process.env.MODELSLAB_API_KEY) {
    cachedApiKey = process.env.MODELSLAB_API_KEY;
    return cachedApiKey;
  }
  const options = { maxBuffer: 8 * 1024 * 1024 };
  const list = JSON.parse(execFileSync("modelslab", ["keys", "list", "-o", "json", "--no-color", "--no-update-check"], options));
  const items = list?.data?.items ?? [];
  const selected = items.find((row) => row.is_default === 1 || row.is_default === true) ?? items[0];
  if (!selected?.id) throw new Error("No ModelsLab API key is configured.");
  const detail = JSON.parse(execFileSync("modelslab", ["keys", "get", "--id", String(selected.id), "-o", "json", "--no-color", "--no-update-check"], options));
  cachedApiKey = detail?.data?.key;
  if (!cachedApiKey) throw new Error(`ModelsLab key ${selected.id} was not readable.`);
  return cachedApiKey;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function audioLinks(value) {
  const rows = [];
  for (const candidate of [value?.output, value?.proxy_links, value?.future_links]) {
    if (Array.isArray(candidate)) rows.push(...candidate);
    else if (typeof candidate === "string" && candidate.trim()) rows.push(candidate.trim());
  }
  return rows.filter(Boolean);
}

async function apiPost(endpoint, body, attempts = 6) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(`https://modelslab.com${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: apiKey(), ...body }),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (attempt < attempts && (response.status === 429 || response.status >= 500)) {
        await sleep(2500 * attempt);
        continue;
      }
      throw new Error(`${endpoint} returned non-JSON ${response.status}: ${text.slice(0, 500)}`);
    }
    const failed = !response.ok || ["failed", "error"].includes(String(json?.status ?? "").toLowerCase());
    if (!failed) return json;
    const message = `${json?.message ?? ""} ${json?.tips ?? ""}`;
    if (attempt < attempts && (response.status === 429 || response.status >= 500 || /rate limit|queue|try again/i.test(message))) {
      await sleep(2500 * attempt);
      continue;
    }
    throw new Error(`${endpoint} failed ${response.status}: ${JSON.stringify(json).slice(0, 1200)}`);
  }
  throw new Error(`${endpoint} exhausted retry attempts`);
}

async function resolveRequest(initial) {
  let current = initial;
  const requestId = initial?.id;
  for (let attempt = 0; attempt < 96; attempt += 1) {
    const links = audioLinks(current);
    if (String(current?.status ?? "").toLowerCase() === "success" && links.length) return current;
    if (["failed", "error"].includes(String(current?.status ?? "").toLowerCase()) && !/try again/i.test(String(current?.message ?? ""))) {
      throw new Error(`ModelsLab request ${requestId ?? "unknown"} failed: ${JSON.stringify(current).slice(0, 1200)}`);
    }
    if (!requestId) {
      if (links.length) return current;
      throw new Error(`ModelsLab request returned no id or URL: ${JSON.stringify(current).slice(0, 1200)}`);
    }
    await sleep(5000);
    current = await apiPost(`/api/v6/voice/fetch/${requestId}`, {}, 4);
  }
  throw new Error(`Timed out polling ModelsLab request ${requestId}`);
}

async function uploadReference(filePath) {
  const bytes = await fs.readFile(filePath);
  const response = await apiPost("/api/v6/base64_to_url", {
    base64_string: `data:audio/wav;base64,${bytes.toString("base64")}`,
  });
  const url = audioLinks(response)[0];
  if (!url) throw new Error("ModelsLab reference upload returned no URL.");
  await fs.writeFile(path.join(outputDir, "reference_upload.json"), `${JSON.stringify({
    source_audio_path: filePath,
    source_audio_sha256: createHash("sha256").update(bytes).digest("hex"),
    uploaded_url: url,
    response,
  }, null, 2)}\n`);
  return url;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function generatePassage(passage, index, initAudioUrl) {
  const started = Date.now();
  const initial = await apiPost("/api/v6/voice/text_to_audio", {
    model_id: "qwen-tts",
    init_audio: initAudioUrl,
    prompt: passage.text,
    language: "english",
    speed: nativeSpeed,
    track_id: 26000 + index,
  });
  const resolved = await resolveRequest(initial);
  const url = audioLinks(resolved)[0];
  if (!url) throw new Error(`No output URL for ${passage.id}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed ${response.status} for ${passage.id}`);
  const providerPath = path.join(outputDir, `${passage.id}.provider`);
  await fs.writeFile(providerPath, Buffer.from(await response.arrayBuffer()));
  const outputPath = path.join(outputDir, `${passage.id}.wav`);
  await execFileAsync("ffmpeg", [
    "-y",
    "-v", "error",
    "-i", providerPath,
    "-ar", "24000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    outputPath,
  ]);
  const probe = JSON.parse((await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    outputPath,
  ])).stdout);
  const durationSec = Number(probe?.format?.duration ?? 0);
  const generationTimeSec = (Date.now() - started) / 1000;
  await fs.writeFile(path.join(outputDir, `${passage.id}.meta.json`), `${JSON.stringify({
    passage,
    initial,
    resolved,
    output_url: url,
    output_path: outputPath,
    native_speed: nativeSpeed,
  }, null, 2)}\n`);
  await fs.rm(providerPath, { force: true });
  return {
    passage_id: passage.id,
    text: passage.text,
    output_path: outputPath,
    output_sha256: await sha256File(outputPath),
    sample_rate_hz: 24000,
    duration_sec: Number(durationSec.toFixed(6)),
    generation_time_sec: Number(generationTimeSec.toFixed(6)),
    generation_rtf: durationSec > 0 ? Number((generationTimeSec / durationSec).toFixed(6)) : null,
    request_id: initial?.id ?? resolved?.id ?? null,
    seed: null,
  };
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const passages = manifest?.passages ?? [];
  if (!passages.length) throw new Error(`No passages in ${manifestPath}`);
  const initAudioUrl = await uploadReference(referenceAudioPath);
  const results = new Array(passages.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= passages.length) return;
      results[index] = await generatePassage(passages[index], index, initAudioUrl);
      console.error(`[${index + 1}/${passages.length}] ${passages[index].id}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, passages.length) }, () => worker()));
  const report = {
    schema: "goldflow_modelslab_tts_bakeoff_run_v1",
    status: "passed",
    model_id: modelId,
    model_kind: "modelslab_qwen",
    model_path: "/api/v6/voice/text_to_audio",
    manifest_path: manifestPath,
    manifest_sha256: await sha256File(manifestPath),
    reference_audio_path: referenceAudioPath,
    reference_audio_sha256: await sha256File(referenceAudioPath),
    provider_requested_model_id: "qwen-tts",
    provider_resolved_model_id: null,
    native_speed: nativeSpeed,
    passage_count: results.length,
    total_audio_duration_sec: Number(results.reduce((sum, row) => sum + row.duration_sec, 0).toFixed(6)),
    total_generation_time_sec: Number(results.reduce((sum, row) => sum + row.generation_time_sec, 0).toFixed(6)),
    results,
  };
  await fs.writeFile(path.join(outputDir, "run.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
