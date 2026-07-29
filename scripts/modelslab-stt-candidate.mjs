#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  post as postModelslabJson,
  resolveAudioResponse,
  uploadAudioReference,
} from "./modelslab-qwen-episode-audio.mjs";
import { resolveNarrationReportPath } from "./lib/narration-artifacts.mjs";
import {
  MODELSLAB_STT_LIMITS,
  mergeModelslabSttChunksForTests,
  modelslabSttResponseHasFinalTranscriptionForTests,
  modelslabSttProviderProfileForTests,
  normalizeModelslabSttPayloadForTests,
  planModelslabSttChunksForTests,
  redactModelslabErrorTextForStorageForTests,
  redactModelslabPayloadForStorageForTests,
  validateLocalWhisperBaselineContractForTests,
  validateModelslabSttCandidateForTests,
  validateModelslabSttInvocationForTests,
  validateModelslabTranscriptBindingForTests,
  validateModelslabSttUploadSizeForTests,
} from "./lib/modelslab-stt-candidate.mjs";

const execFile = promisify(execFileCb);
const DATA_ROOT = process.env.ANIFACTORY_DATA_ROOT
  || "/Users/joel/AniFactoryData";

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[index + 1]
      : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function nowIso() {
  return new Date().toISOString();
}

function slug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120)
    || "candidate";
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value, { exclusive = false } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", flag: exclusive ? "wx" : "w" },
  );
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileExists(filePath) {
  return Boolean(filePath)
    && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function mediaDuration(filePath) {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath,
  ], { maxBuffer: 8 * 1024 * 1024 });
  const duration = Number(JSON.parse(stdout)?.format?.duration ?? 0);
  if (!(duration > 0)) {
    throw new Error(`Could not measure source audio duration: ${filePath}`);
  }
  return duration;
}

function reportAudioPath(report) {
  return report?.output_path
    ?? report?.final_wav
    ?? report?.final_m4a_path
    ?? report?.final_m4a
    ?? null;
}

function reportAudioHash(report, audioPath) {
  const resolved = path.resolve(audioPath);
  for (const [candidatePath, candidateHash] of [
    [report?.output_path, report?.output_sha256],
    [report?.final_wav, report?.final_wav_sha256],
    [report?.final_m4a_path, report?.final_m4a_sha256],
    [report?.final_m4a, report?.final_m4a_sha256],
  ]) {
    if (candidatePath && candidateHash
      && path.resolve(candidatePath) === resolved) {
      return candidateHash;
    }
  }
  return null;
}

function intendedTranscriptFromReport(report) {
  return (report?.segments ?? [])
    .map((segment) => (
      segment.text
      ?? segment.stripped_text
      ?? segment.tts_spoken_text
      ?? ""
    ))
    .map((text) => String(text).trim())
    .filter(Boolean)
    .join(" ");
}

async function extractChunk(sourceAudioPath, outputPath, chunk) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFile("ffmpeg", [
    "-y",
    "-nostdin",
    "-v", "error",
    "-ss", Number(chunk.start_sec).toFixed(6),
    "-i", sourceAudioPath,
    "-t", Number(chunk.duration_sec).toFixed(6),
    "-vn",
    "-ar", "16000",
    "-ac", "1",
    "-c:a", "libmp3lame",
    "-b:a", "64k",
    outputPath,
  ], { maxBuffer: 16 * 1024 * 1024 });
}

async function writeRawJson(rawDir, name, value) {
  const filePath = path.join(rawDir, name);
  const storedValue = redactModelslabPayloadForStorageForTests(value);
  const bytes = Buffer.from(`${JSON.stringify(storedValue, null, 2)}\n`);
  await fs.writeFile(filePath, bytes);
  return {
    path: filePath,
    sha256: sha256Bytes(bytes),
    byte_count: bytes.byteLength,
    content_type: "application/json",
  };
}

async function writeRawBytes(rawDir, name, bytes, contentType) {
  const filePath = path.join(rawDir, name);
  await fs.writeFile(filePath, bytes);
  return {
    path: filePath,
    sha256: sha256Bytes(bytes),
    byte_count: bytes.byteLength,
    content_type: contentType ?? null,
  };
}

async function appendRequestEvent(eventPath, value) {
  const storedValue = redactModelslabPayloadForStorageForTests(value);
  await fs.appendFile(
    eventPath,
    `${JSON.stringify(storedValue)}\n`,
    "utf8",
  );
}

function candidateOutputValues(response) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value;
    if (value !== null && value !== undefined) return [value];
    return [];
  };
  return [
    ...normalize(response?.output),
    ...normalize(response?.proxy_links),
    ...normalize(response?.future_links),
    ...normalize(response?.links),
    ...normalize(response?.fetch_result),
  ].filter((value) => value !== null && value !== undefined);
}

async function fetchOutputPayload(url, rawDir, chunkId, index) {
  const configuredAttempts = Number(
    process.env.ANIFACTORY_MODELSLAB_STT_OUTPUT_FETCH_ATTEMPTS ?? 12,
  );
  const maxAttempts = Number.isFinite(configuredAttempts)
    ? Math.max(1, Math.min(24, Math.floor(configuredAttempts)))
    : 12;
  const configuredTimeoutMs = Number(
    process.env.ANIFACTORY_MODELSLAB_STT_OUTPUT_TIMEOUT_MS ?? 120000,
  );
  const timeoutMs = Number.isFinite(configuredTimeoutMs)
    ? Math.max(1000, Math.min(300000, configuredTimeoutMs))
    : 120000;
  let response = null;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    response = null;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs,
    );
    try {
      response = await fetch(url, { signal: controller.signal });
      if (response.ok) break;
      lastError = new Error(
        `ModelsLab STT output fetch failed ${response.status}: ${url}`,
      );
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (response
      && ![404, 409, 425, 429].includes(response.status)
      && response.status < 500) {
      throw lastError;
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(5000, 500 * (2 ** (attempt - 1))),
      ));
    }
  }
  if (!response?.ok) {
    throw lastError ?? new Error(
      `ModelsLab STT output fetch failed after ${maxAttempts} attempts: ${url}`,
    );
  }
  const transportBytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  const text = transportBytes.toString("utf8").trim();
  let payload = text;
  if (/json/iu.test(contentType) || /^[{[]/u.test(text)) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  const isTextPayload = /(?:json|text|xml|javascript)/iu.test(contentType)
    || typeof payload === "object"
    || /^[{[]/u.test(text);
  let storedBytes;
  let storedContentType = contentType;
  let bodyOmitted = false;
  if (typeof payload === "object" && payload !== null) {
    const redacted = redactModelslabPayloadForStorageForTests(payload);
    storedBytes = Buffer.from(`${JSON.stringify(redacted, null, 2)}\n`);
    storedContentType = "application/json";
  } else if (isTextPayload) {
    storedBytes = Buffer.from(
      `${redactModelslabErrorTextForStorageForTests(text)}\n`,
    );
  } else {
    bodyOmitted = true;
    storedBytes = Buffer.from(`${JSON.stringify({
      body_omitted_non_text: true,
      transport_content_type: contentType || null,
      transport_byte_count: transportBytes.byteLength,
      transport_sha256: sha256Bytes(transportBytes),
    }, null, 2)}\n`);
    storedContentType = "application/json";
  }
  const rawArtifact = await writeRawBytes(
    rawDir,
    `${chunkId}-output-${String(index + 1).padStart(2, "0")}.raw`,
    storedBytes,
    storedContentType,
  );
  rawArtifact.transport_sha256 = sha256Bytes(transportBytes);
  rawArtifact.transport_byte_count = transportBytes.byteLength;
  rawArtifact.secret_redacted_for_storage = true;
  rawArtifact.body_omitted_non_text = bodyOmitted;
  return { payload, raw_artifact: rawArtifact };
}

async function providerPayloads(response, rawDir, chunkId) {
  const payloads = [response?.meta, response];
  const rawArtifacts = [];
  const fetchErrors = [];
  const seenUrls = new Set();
  const values = candidateOutputValues(response);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value === "string" && /^https?:\/\//iu.test(value.trim())) {
      const url = value.trim();
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      try {
        const fetched = await fetchOutputPayload(
          url,
          rawDir,
          chunkId,
          index,
        );
        payloads.push(fetched.payload);
        rawArtifacts.push(fetched.raw_artifact);
      } catch (error) {
        const finding = {
          url,
          error: redactModelslabErrorTextForStorageForTests(
            error instanceof Error ? error.message : String(error),
          ),
        };
        const errorArtifact = await writeRawJson(
          rawDir,
          `${chunkId}-output-${String(index + 1).padStart(2, "0")}-error.json`,
          finding,
        );
        fetchErrors.push({
          ...finding,
          raw_artifact: errorArtifact,
        });
      }
    } else {
      payloads.push(value);
    }
  }
  return {
    payloads,
    raw_artifacts: rawArtifacts,
    fetch_errors: fetchErrors,
  };
}

function providerGenerationTime(response) {
  const value = Number(
    response?.generationTime
      ?? response?.generation_time
      ?? response?.meta?.generationTime
      ?? response?.meta?.generation_time,
  );
  return Number.isFinite(value) ? value : null;
}

function requestCostEnvelope(profile, requestAttempts) {
  const submitted = requestAttempts.filter(
    (attempt) => attempt.submission_started_at,
  );
  const accepted = submitted.filter(
    (attempt) => attempt.submission_accepted_at,
  );
  const minimumAudioSec = accepted.reduce(
    (sum, attempt) => sum + Number(attempt.submitted_audio_sec ?? 0),
    0,
  );
  const maximumAudioSec = submitted.reduce(
    (sum, attempt) => sum + Number(attempt.submitted_audio_sec ?? 0),
    0,
  );
  const rate = profile.price_usd_per_sec;
  return {
    currency: "USD",
    price_usd_per_sec: rate,
    accepted_request_count: accepted.length,
    submitted_request_count: submitted.length,
    minimum_confirmed_submitted_audio_sec:
      Number(minimumAudioSec.toFixed(6)),
    maximum_possible_submitted_audio_sec:
      Number(maximumAudioSec.toFixed(6)),
    minimum_estimated_cost_usd: rate === null
      ? null
      : Number((minimumAudioSec * rate).toFixed(6)),
    maximum_estimated_cost_usd: rate === null
      ? null
      : Number((maximumAudioSec * rate).toFixed(6)),
    ambiguous_submission_count: submitted.filter(
      (attempt) => attempt.status === "submission_outcome_unknown",
    ).length,
    v6_price_status: profile.id === "v6_standard"
      ? "not_documented_by_this_adapter"
      : null,
  };
}

async function runProviderChunk({
  chunk,
  chunkPath,
  chunkSha256,
  profile,
  rawDir,
  requestAttempts,
  requestEventsPath,
  trackId,
  uploadLabel,
}) {
  const startedMs = Date.now();
  const attempt = {
    chunk_id: chunk.chunk_id,
    source_audio_sha256: chunkSha256,
    submitted_audio_sec: Number(chunk.duration_sec),
    endpoint: profile.endpoint,
    track_id: trackId,
    status: "preparing_upload",
    started_at: nowIso(),
  };
  requestAttempts.push(attempt);
  await appendRequestEvent(requestEventsPath, {
    event: "chunk_started",
    ...attempt,
  });
  const upload = await uploadAudioReference(
    chunkPath,
    uploadLabel,
    {
      returnProvenance: true,
      maxSourceBytes: MODELSLAB_STT_LIMITS.maximum_upload_source_bytes,
      maxBase64Bytes: MODELSLAB_STT_LIMITS.maximum_upload_base64_bytes,
    },
  );
  if (upload.source_audio_sha256 !== chunkSha256) {
    throw new Error(
      `ModelsLab upload hash drift for ${chunk.chunk_id}: `
      + `${upload.source_audio_sha256} != ${chunkSha256}`,
    );
  }
  attempt.status = "upload_completed";
  attempt.uploaded_url = upload.uploaded_url;
  attempt.upload_completed_at = nowIso();
  await appendRequestEvent(requestEventsPath, {
    event: "upload_completed",
    ...attempt,
  });
  const uploadArtifact = await writeRawJson(
    rawDir,
    `${chunk.chunk_id}-upload-response.json`,
    upload.response,
  );
  const requestPayload = {
    model_id: profile.model_id,
    init_audio: upload.uploaded_url,
    track_id: trackId,
    ...(profile.language ? { language: profile.language } : {}),
    ...(profile.timestamp_level
      ? { timestamp_level: profile.timestamp_level }
      : {}),
  };
  const requestArtifact = await writeRawJson(
    rawDir,
    `${chunk.chunk_id}-request-redacted.json`,
    requestPayload,
  );
  const requestStartedMs = Date.now();
  attempt.status = "submission_started";
  attempt.submission_started_at = nowIso();
  attempt.request_artifact = requestArtifact;
  await appendRequestEvent(requestEventsPath, {
    event: "provider_submission_started",
    ...attempt,
    submission_retry_policy: "single_attempt_no_ambiguous_retry",
  });
  let initial;
  try {
    initial = await postModelslabJson(
      profile.endpoint,
      requestPayload,
      { maxAttempts: 1 },
    );
  } catch (error) {
    attempt.status = "submission_outcome_unknown";
    attempt.failed_at = nowIso();
    attempt.error = redactModelslabErrorTextForStorageForTests(
      error instanceof Error ? error.message : String(error),
    );
    await appendRequestEvent(requestEventsPath, {
      event: "provider_submission_outcome_unknown",
      ...attempt,
    });
    throw error;
  }
  attempt.status = "submission_accepted";
  attempt.submission_accepted_at = nowIso();
  attempt.request_id = initial?.id ?? null;
  attempt.provider_status = initial?.status ?? null;
  await appendRequestEvent(requestEventsPath, {
    event: "provider_submission_accepted",
    ...attempt,
  });
  try {
    const initialArtifact = await writeRawJson(
      rawDir,
      `${chunk.chunk_id}-initial-response.json`,
      initial,
    );
    const resolved = modelslabSttResponseHasFinalTranscriptionForTests(initial)
      ? initial
      : await resolveAudioResponse(initial, {
          fetchEndpoint: profile.fetch_endpoint,
          operationLabel: "ModelsLab STT",
          includeFetchResult: true,
          completionPredicate:
            modelslabSttResponseHasFinalTranscriptionForTests,
        });
    const resolvedArtifact = await writeRawJson(
      rawDir,
      `${chunk.chunk_id}-resolved-response.json`,
      resolved,
    );
    const materialized = await providerPayloads(
      resolved,
      rawDir,
      chunk.chunk_id,
    );
    const normalized = normalizeModelslabSttPayloadForTests(
      materialized.payloads,
    );
    if (!normalized.words.length && !normalized.text) {
      throw new Error(
        `ModelsLab STT returned no transcript for ${chunk.chunk_id}; `
        + `${materialized.fetch_errors.length} output link(s) failed.`,
      );
    }
    const finishedMs = Date.now();
    const result = {
      chunk_id: chunk.chunk_id,
      start_sec: chunk.start_sec,
      end_sec: chunk.end_sec,
      duration_sec: chunk.duration_sec,
      source_audio_path: chunkPath,
      source_audio_sha256: chunkSha256,
      uploaded_url: upload.uploaded_url,
      upload_provenance_path: upload.provenance_path,
      request_id: initial?.id ?? resolved?.id ?? null,
      provider_status: resolved?.status ?? initial?.status ?? null,
      provider_generation_time_sec:
        providerGenerationTime(resolved)
        ?? providerGenerationTime(initial),
      request_latency_sec: Number((
        (finishedMs - requestStartedMs) / 1000
      ).toFixed(6)),
      total_upload_and_request_latency_sec: Number((
        (finishedMs - startedMs) / 1000
      ).toFixed(6)),
      initial_response_artifact: initialArtifact,
      resolved_response_artifact: resolvedArtifact,
      request_artifact: requestArtifact,
      upload_response_artifact: uploadArtifact,
      output_raw_artifacts: materialized.raw_artifacts,
      output_fetch_errors: materialized.fetch_errors,
      text: normalized.text,
      words: normalized.words,
      provider_word_count: normalized.words.length,
      normalization_evidence: {
        discovered_text_candidate_count:
          normalized.discovered_text_candidate_count,
        discovered_word_set_count:
          normalized.discovered_word_set_count,
      },
    };
    attempt.status = "completed";
    attempt.completed_at = nowIso();
    attempt.request_id = result.request_id;
    attempt.provider_status = result.provider_status;
    attempt.request_latency_sec = result.request_latency_sec;
    await appendRequestEvent(requestEventsPath, {
      event: "chunk_completed",
      ...attempt,
    });
    return result;
  } catch (error) {
    attempt.status = "failed_after_submission";
    attempt.failed_at = nowIso();
    attempt.error = redactModelslabErrorTextForStorageForTests(
      error instanceof Error ? error.message : String(error),
    );
    await appendRequestEvent(requestEventsPath, {
      event: "chunk_failed_after_submission",
      ...attempt,
    });
    throw error;
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const provider = flags.provider ?? flags["provider-profile"] ?? "v6_standard";
  const invocation = validateModelslabSttInvocationForTests({
    diagnostic: flags.diagnostic,
    confirmSpend: flags["confirm-spend"],
    confirmPremiumCost: flags["confirm-premium-cost"],
    provider,
  });
  const profile = modelslabSttProviderProfileForTests(provider);
  for (const forbiddenFlag of [
    "promote",
    "promote-to-production-timing",
    "replace-production-timing",
    "canonical-output",
    "output-dir",
    "report-output",
  ]) {
    if (Object.hasOwn(flags, forbiddenFlag)) {
      throw new Error(
        "This adapter is diagnostic-only and has no production timing "
        + "promotion or arbitrary-output writer. Canonical local-Whisper "
        + "timing remains untouched.",
      );
    }
  }
  for (const thresholdFlag of [
    "max-wer",
    "baseline-median-delta-sec",
    "baseline-p95-delta-sec",
  ]) {
    if (Object.hasOwn(flags, thresholdFlag)) {
      throw new Error(
        "ModelsLab STT candidate validation thresholds are locked; "
        + `--${thresholdFlag} cannot override promotion evidence.`,
      );
    }
  }

  const requestedChannel = flags.channel ?? "53rebirth";
  const requestedSeries = flags.series ?? "series";
  const requestedWeek = flags.week ?? "current";
  const requestedEpisode = flags.episode ?? "ep_01";
  const episodeDir = path.resolve(
    flags["episode-dir"]
      ?? path.join(
        DATA_ROOT,
        "channels",
        requestedChannel,
        "weekly_runs",
        requestedWeek,
        "episodes",
        requestedEpisode,
      ),
  );
  const runIdentityPath = path.join(episodeDir, "run_identity.json");
  const runIdentity = await readJson(runIdentityPath, null);
  if (!runIdentity) {
    throw new Error(
      `Missing run identity preflight: ${runIdentityPath}. ModelsLab STT `
      + "diagnostics cannot create an episode directory.",
    );
  }
  for (const [flagName, identityKey] of [
    ["channel", "channel"],
    ["series", "series_slug"],
    ["week", "week"],
    ["episode", "episode"],
  ]) {
    if (Object.hasOwn(flags, flagName)
      && flags[flagName] !== runIdentity[identityKey]) {
      throw new Error(
        `Run identity mismatch for ${flagName}: command has `
        + `${flags[flagName]}, run_identity.json has `
        + `${runIdentity[identityKey]}.`,
      );
    }
  }
  const channel = runIdentity.channel;
  const series = runIdentity.series_slug;
  const week = runIdentity.week;
  const episode = runIdentity.episode;
  if (![channel, series, week, episode].every(
    (value) => typeof value === "string" && value.trim(),
  )) {
    throw new Error(
      `Run identity is incomplete for ModelsLab STT diagnostics: `
      + runIdentityPath,
    );
  }
  const runIdentitySha256 = await sha256File(runIdentityPath);
  const narrationReportPath = path.resolve(
    flags["narration-report"]
      ?? resolveNarrationReportPath({ episodeDir, episode, flags }),
  );
  const narrationReport = await readJson(narrationReportPath, null);
  const audioPath = path.resolve(
    flags.audio
      ?? reportAudioPath(narrationReport)
      ?? "",
  );
  if (!audioPath || !(await fileExists(audioPath))) {
    throw new Error(
      "ModelsLab STT candidate requires --audio <path> or a current "
      + `narration report with audio: ${narrationReportPath}`,
    );
  }
  const sourceAudioSha256 = await sha256File(audioPath);
  const expectedReportHash = narrationReport
    ? reportAudioHash(narrationReport, audioPath)
    : null;
  const expectedTranscriptPath = flags["expected-transcript"]
    ? path.resolve(flags["expected-transcript"])
    : null;
  const transcriptBinding = validateModelslabTranscriptBindingForTests({
    sourceAudioSha256,
    narrationReportAudioSha256: expectedReportHash,
    explicitExpectedTranscript: Boolean(expectedTranscriptPath),
  });
  const narrationReportOwnsAudio =
    transcriptBinding.narration_report_owns_audio;
  const boundNarrationReport = narrationReportOwnsAudio
    ? narrationReport
    : null;
  const expectedTranscript = expectedTranscriptPath
    ? (await fs.readFile(expectedTranscriptPath, "utf8")).trim()
    : intendedTranscriptFromReport(boundNarrationReport);
  if (!expectedTranscript) {
    throw new Error(
      "ModelsLab STT validation requires the narration report's intended "
      + "transcript or --expected-transcript <path>.",
    );
  }

  const durationSec = await mediaDuration(audioPath);
  const maxChunkSec = Number(
    flags["max-chunk-sec"] ?? MODELSLAB_STT_LIMITS.default_chunk_sec,
  );
  const overlapSec = Number(flags["chunk-overlap-sec"] ?? 2);
  const chunkPlan = planModelslabSttChunksForTests(durationSec, {
    maxChunkSec,
    overlapSec,
  });
  const runLabel = slug(
    flags.label
      ?? `${profile.id}-${sourceAudioSha256.slice(0, 12)}-${nowIso()}`,
  );
  const outputDir = path.join(
    episodeDir,
    "review_samples",
    "modelslab_stt",
    runLabel,
  );
  const reviewSamplesDir = path.join(episodeDir, "review_samples");
  const diagnosticRoot = path.join(reviewSamplesDir, "modelslab_stt");
  const reportPath = path.join(
    outputDir,
    `modelslab_stt_candidate_${runLabel}.json`,
  );
  const rawDir = path.join(outputDir, "raw");
  const chunksDir = path.join(outputDir, "chunks");
  const requestEventsPath = path.join(
    outputDir,
    "request_events.jsonl",
  );

  const canonicalTimingPath = path.join(
    episodeDir,
    `narration_word_timing_${episode}.json`,
  );
  const canonicalTimingHashBefore = await fileExists(canonicalTimingPath)
    ? await sha256File(canonicalTimingPath)
    : null;
  const baselineTimingPath = path.resolve(
    flags["baseline-timing"]
      ?? canonicalTimingPath,
  );
  const baselineTiming = await readJson(baselineTimingPath, null);
  if (baselineTiming
    && baselineTiming.narration_audio_hash !== sourceAudioSha256) {
    throw new Error(
      "Local-Whisper baseline timing is stale for the selected source audio: "
      + `${baselineTiming.narration_audio_hash ?? "missing"} `
      + `!= ${sourceAudioSha256}`,
    );
  }
  const baselineContract = validateLocalWhisperBaselineContractForTests(
    baselineTiming,
    sourceAudioSha256,
  );

  await fs.mkdir(reviewSamplesDir, { recursive: true });
  if ((await fs.lstat(reviewSamplesDir)).isSymbolicLink()) {
    throw new Error(
      `Refusing symlinked diagnostic review root: ${reviewSamplesDir}`,
    );
  }
  await fs.mkdir(diagnosticRoot, { recursive: true });
  if ((await fs.lstat(diagnosticRoot)).isSymbolicLink()) {
    throw new Error(
      `Refusing symlinked ModelsLab STT root: ${diagnosticRoot}`,
    );
  }
  try {
    await fs.mkdir(outputDir);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        "ModelsLab STT diagnostic label already exists; choose a new "
        + `--label: ${runLabel}`,
      );
    }
    throw error;
  }
  await Promise.all([
    fs.mkdir(rawDir),
    fs.mkdir(chunksDir),
  ]);

  const invocationStartedMs = Date.now();
  const requestSeed = Number.parseInt(sourceAudioSha256.slice(0, 8), 16)
    % 900_000_000;
  const chunkResults = [];
  const requestAttempts = [];
  let merged = null;
  let validation = null;
  let canonicalTimingHashAfter = null;
  try {
    for (let index = 0; index < chunkPlan.length; index += 1) {
      const chunk = chunkPlan[index];
      const chunkPath = path.join(chunksDir, `${chunk.chunk_id}.mp3`);
      await extractChunk(audioPath, chunkPath, chunk);
      const chunkStat = await fs.stat(chunkPath);
      const uploadSize = validateModelslabSttUploadSizeForTests(
        chunkStat.size,
      );
      const measuredChunkDurationSec = await mediaDuration(chunkPath);
      if (measuredChunkDurationSec < 5 - 0.01
        || measuredChunkDurationSec > 3600 + 0.01) {
        throw new Error(
          `${chunk.chunk_id} violates ModelsLab's 5s-1h request limit: `
          + `${measuredChunkDurationSec.toFixed(6)}s`,
        );
      }
      const chunkSha256 = await sha256File(chunkPath);
      const result = await runProviderChunk({
        chunk: {
          ...chunk,
          duration_sec: measuredChunkDurationSec,
          end_sec: chunk.start_sec + measuredChunkDurationSec,
        },
        chunkPath,
        chunkSha256,
        profile,
        rawDir,
        requestAttempts,
        requestEventsPath,
        trackId: requestSeed + index,
        uploadLabel:
          `${runLabel}-${chunk.chunk_id}-${chunkSha256.slice(0, 12)}`,
      });
      result.upload_size_validation = uploadSize;
      chunkResults.push(result);
    }
    merged = mergeModelslabSttChunksForTests(chunkResults);
    validation = validateModelslabSttCandidateForTests({
      words: merged.words,
      recognizedText: merged.text,
      expectedText: expectedTranscript,
      audioDurationSec: durationSec,
      baselineWords: baselineTiming?.words ?? null,
      baselineContract,
      maxWer: 0.05,
      baselineMedianDeltaSec: 0.3,
      baselineP95DeltaSec: 0.75,
    });
    canonicalTimingHashAfter = await fileExists(canonicalTimingPath)
      ? await sha256File(canonicalTimingPath)
      : null;
    if (canonicalTimingHashAfter !== canonicalTimingHashBefore) {
      throw new Error(
        "Canonical local-Whisper timing changed during a diagnostic "
        + "ModelsLab STT run.",
      );
    }
  } catch (error) {
    const failureCanonicalHash = await fileExists(canonicalTimingPath)
      ? await sha256File(canonicalTimingPath)
      : null;
    const eventsSha256 = await fileExists(requestEventsPath)
      ? await sha256File(requestEventsPath)
      : null;
    const failureReport = {
      schema: "goldflow_modelslab_stt_candidate_v1",
      status: "failed",
      diagnostic_only: true,
      canonical_timing_untouched:
        failureCanonicalHash === canonicalTimingHashBefore,
      production_timing_default: "local_whisper_medium",
      production_promotion_writer_available: false,
      provider: "modelslab",
      provider_profile: profile.id,
      endpoint: profile.endpoint,
      fetch_endpoint: profile.fetch_endpoint,
      model_id: profile.model_id,
      channel,
      series_slug: series,
      week,
      episode,
      run_identity_path: runIdentityPath,
      run_identity_sha256: runIdentitySha256,
      source_audio_path: audioPath,
      source_audio_sha256: sourceAudioSha256,
      source_audio_duration_sec: Number(durationSec.toFixed(6)),
      narration_report_path: boundNarrationReport
        ? narrationReportPath
        : null,
      narration_report_sha256: boundNarrationReport
        ? await sha256File(narrationReportPath)
        : null,
      expected_transcript_source: expectedTranscriptPath
        ?? (boundNarrationReport ? narrationReportPath : null),
      expected_transcript_binding: transcriptBinding,
      expected_transcript_sha256: sha256Bytes(
        Buffer.from(expectedTranscript),
      ),
      canonical_timing_path: canonicalTimingPath,
      canonical_timing_sha256_before: canonicalTimingHashBefore,
      canonical_timing_sha256_after: failureCanonicalHash,
      chunk_plan: chunkPlan,
      completed_chunks: chunkResults,
      request_attempts: requestAttempts,
      request_events_path: await fileExists(requestEventsPath)
        ? requestEventsPath
        : null,
      request_events_sha256: eventsSha256,
      raw_payload_directory: rawDir,
      submission_retry_policy:
        "single_attempt_no_automatic_retry_after_ambiguous_outcome",
      cost: requestCostEnvelope(profile, requestAttempts),
      latency: {
        total_wall_time_sec: Number((
          (Date.now() - invocationStartedMs) / 1000
        ).toFixed(6)),
      },
      production_timing_promotion: {
        status: "ineligible",
        promotion_applied: false,
        canonical_timing_untouched:
          failureCanonicalHash === canonicalTimingHashBefore,
        blockers: [{
          code: "modelslab_stt_candidate_execution_failed",
        }],
      },
      error: redactModelslabErrorTextForStorageForTests(
        error instanceof Error ? error.message : String(error),
      ),
      updated_at: nowIso(),
    };
    await writeJson(
      reportPath,
      failureReport,
      { exclusive: true },
    ).catch(() => {});
    throw error;
  }

  const submittedAudioSec = chunkResults.reduce(
    (sum, chunk) => sum + Number(chunk.duration_sec ?? 0),
    0,
  );
  const estimatedCostUsd = profile.price_usd_per_sec === null
    ? null
    : Number((submittedAudioSec * profile.price_usd_per_sec).toFixed(6));
  const requestCost = requestCostEnvelope(profile, requestAttempts);
  const requestEventsSha256 = await sha256File(requestEventsPath);
  const providerGenerationTimes = chunkResults
    .map((chunk) => Number(chunk.provider_generation_time_sec))
    .filter(Number.isFinite);
  const report = {
    schema: "goldflow_modelslab_stt_candidate_v1",
    status: validation.status,
    diagnostic_only: true,
    canonical_timing_untouched: true,
    production_timing_default: "local_whisper_medium",
    production_promotion_writer_available: false,
    provider: "modelslab",
    provider_profile: profile.id,
    endpoint: profile.endpoint,
    fetch_endpoint: profile.fetch_endpoint,
    model_id: profile.model_id,
    channel,
    series_slug: series,
    week,
    episode,
    run_identity_path: runIdentityPath,
    run_identity_sha256: runIdentitySha256,
    language: profile.language,
    timestamp_level: profile.timestamp_level,
    provider_word_timestamp_reliability:
      "documented_as_less_reliable_than_sentence_timestamps",
    invocation_guard: invocation,
    source_audio_path: audioPath,
    source_audio_sha256: sourceAudioSha256,
    source_audio_duration_sec: Number(durationSec.toFixed(6)),
    narration_report_path: boundNarrationReport ? narrationReportPath : null,
    narration_report_sha256: boundNarrationReport
      ? await sha256File(narrationReportPath)
      : null,
    source_script_hash: boundNarrationReport?.source_script_hash ?? null,
    expected_transcript_source: expectedTranscriptPath
      ?? (boundNarrationReport ? narrationReportPath : null),
    expected_transcript_binding: transcriptBinding,
    expected_transcript_sha256: sha256Bytes(
      Buffer.from(expectedTranscript),
    ),
    baseline_local_whisper_timing_path: baselineTiming
      ? baselineTimingPath
      : null,
    baseline_local_whisper_timing_sha256: baselineTiming
      ? await sha256File(baselineTimingPath)
      : null,
    baseline_local_whisper_contract: baselineContract,
    canonical_timing_path: canonicalTimingPath,
    canonical_timing_sha256_before: canonicalTimingHashBefore,
    canonical_timing_sha256_after: canonicalTimingHashAfter,
    chunk_policy: {
      provider_minimum_sec: MODELSLAB_STT_LIMITS.minimum_audio_sec,
      provider_maximum_sec: MODELSLAB_STT_LIMITS.maximum_audio_sec,
      upload_lane_maximum_chunk_sec:
        MODELSLAB_STT_LIMITS.maximum_upload_chunk_sec,
      prepared_audio_format: "mp3_16khz_mono_64kbps",
      maximum_upload_source_bytes:
        MODELSLAB_STT_LIMITS.maximum_upload_source_bytes,
      maximum_upload_base64_bytes:
        MODELSLAB_STT_LIMITS.maximum_upload_base64_bytes,
      requested_max_chunk_sec: maxChunkSec,
      overlap_sec: overlapSec,
      chunk_count: chunkPlan.length,
    },
    chunk_plan: chunkPlan,
    chunks: chunkResults,
    request_attempts: requestAttempts,
    request_events_path: requestEventsPath,
    request_events_sha256: requestEventsSha256,
    submission_retry_policy:
      "single_attempt_no_automatic_retry_after_ambiguous_outcome",
    raw_payload_directory: rawDir,
    transcript: merged.text,
    word_count: merged.words.length,
    words: merged.words,
    merge_provenance: merged.chunks,
    validation,
    production_timing_promotion: validation.production_timing_promotion,
    cost: {
      currency: "USD",
      price_usd_per_sec: profile.price_usd_per_sec,
      submitted_audio_sec: Number(submittedAudioSec.toFixed(6)),
      includes_chunk_overlap: chunkResults.length > 1 && overlapSec > 0,
      estimated_cost_usd: estimatedCostUsd,
      estimate_note:
        "Provider billing and rounding may differ from submitted seconds.",
      request_cost_envelope: requestCost,
      v6_price_status: profile.id === "v6_standard"
        ? "not_documented_by_this_adapter"
        : null,
    },
    latency: {
      total_wall_time_sec: Number((
        (Date.now() - invocationStartedMs) / 1000
      ).toFixed(6)),
      request_latency_sec: Number(chunkResults.reduce(
        (sum, chunk) => sum + Number(chunk.request_latency_sec ?? 0),
        0,
      ).toFixed(6)),
      upload_and_request_latency_sec: Number(chunkResults.reduce(
        (sum, chunk) => (
          sum + Number(chunk.total_upload_and_request_latency_sec ?? 0)
        ),
        0,
      ).toFixed(6)),
      provider_reported_generation_time_sec:
        providerGenerationTimes.length
          ? Number(providerGenerationTimes.reduce(
            (sum, value) => sum + value,
            0,
          ).toFixed(6))
          : null,
    },
    official_documentation: {
      v6_speech_to_text:
        "https://docs.modelslab.com/voice-cloning/speech-to-text",
      base64_to_url:
        "https://docs.modelslab.com/general-api/base64-to-url",
      v7_model_selection:
        "https://docs.modelslab.com/guides/model-selection",
    },
    updated_at: nowIso(),
  };
  await writeJson(reportPath, report, { exclusive: true });
  const canonicalTimingHashAfterReportWrite =
    await fileExists(canonicalTimingPath)
      ? await sha256File(canonicalTimingPath)
      : null;
  if (canonicalTimingHashAfterReportWrite !== canonicalTimingHashBefore) {
    throw new Error(
      "Canonical local-Whisper timing changed while writing the diagnostic "
      + "ModelsLab STT report.",
    );
  }
  console.log(JSON.stringify({
    status: report.status,
    diagnostic_only: true,
    report_path: reportPath,
    provider_profile: profile.id,
    word_count: report.word_count,
    source_audio_sha256: sourceAudioSha256,
    production_timing_promotion:
      report.production_timing_promotion.status,
    canonical_timing_untouched: true,
  }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
