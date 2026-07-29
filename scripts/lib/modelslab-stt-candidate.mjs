import {
  PRODUCTION_LOCAL_WHISPER_CONTRACT,
  identityRequiresLocalWhisperContract,
  localWhisperContractForIdentity,
  localWhisperContractFromReport,
  localWhisperContractMismatches,
  normalizeLocalWhisperContract,
  validateLocalWhisperIdentityContract,
} from "./local-whisper-policy.mjs";

const MIN_PROVIDER_AUDIO_SEC = 5;
const MAX_PROVIDER_AUDIO_SEC = 3600;
const MAX_UPLOAD_CHUNK_SEC = 420;
const DEFAULT_CHUNK_SEC = 400;
const DEFAULT_OVERLAP_SEC = 2;
const MAX_UPLOAD_SOURCE_BYTES = 3_500_000;
const MAX_UPLOAD_BASE64_BYTES = 4_700_000;
const V7_SCRIBE_RATE_USD_PER_SEC = 0.001;
const LEGACY_LOCAL_WHISPER_MODELS = new Set([
  "medium",
  "small",
  "small.en",
]);

const PROVIDER_PROFILES = Object.freeze({
  v6_standard: Object.freeze({
    id: "v6_standard",
    endpoint: "/api/v6/voice/speech_to_text",
    fetch_endpoint: "/api/v6/voice/fetch",
    model_id: "speech-to-text",
    language: "en",
    timestamp_level: "word",
    premium: false,
    price_usd_per_sec: null,
  }),
  v7_scribe: Object.freeze({
    id: "v7_scribe",
    endpoint: "/api/v7/voice/speech-to-text",
    fetch_endpoint: "/api/v7/voice/fetch",
    model_id: "scribe_v1",
    language: null,
    timestamp_level: null,
    premium: true,
    price_usd_per_sec: V7_SCRIBE_RATE_USD_PER_SEC,
  }),
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeToken(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function transcriptTokens(value) {
  return String(value ?? "")
    .split(/\s+/u)
    .map(normalizeToken)
    .filter(Boolean);
}

function boolValue(value) {
  return /^(?:1|true|yes|on)$/iu.test(String(value ?? ""));
}

export function redactModelslabPayloadForStorageForTests(value) {
  if (Array.isArray(value)) {
    return value.map(redactModelslabPayloadForStorageForTests);
  }
  if (typeof value === "string" && /^https?:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()]) {
        const normalizedKey = key.toLowerCase().replace(/[-\s]/gu, "_");
        if (/^(?:key|api_key|apikey|authorization|auth|access_token|accesstoken|bearer_token|token|secret)$/u
          .test(normalizedKey)) {
          url.searchParams.set(key, "[REDACTED]");
        }
      }
      return url.toString();
    } catch {
      return value;
    }
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const normalizedKey = key.toLowerCase().replace(/[-\s]/gu, "_");
    if (/^(?:key|api_key|apikey|authorization|auth|access_token|accesstoken|bearer|bearer_token|token|secret)$/u
      .test(normalizedKey)) {
      return [key, "[REDACTED]"];
    }
    return [key, redactModelslabPayloadForStorageForTests(child)];
  }));
}

export function redactModelslabErrorTextForStorageForTests(value) {
  return String(value ?? "")
    .replace(
      /((?:"|')?(?:key|api[_-]?key|apikey|authorization|auth|access[_-]?token|bearer[_-]?token|token|secret)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
      "Bearer [REDACTED]",
    );
}

export function modelslabSttProviderProfileForTests(provider = "v6_standard") {
  const normalized = String(provider ?? "v6_standard").trim().toLowerCase();
  const profile = PROVIDER_PROFILES[normalized];
  if (!profile) {
    throw new Error(
      `Unsupported ModelsLab STT provider '${provider}'. `
      + `Expected one of: ${Object.keys(PROVIDER_PROFILES).join(", ")}.`,
    );
  }
  return { ...profile };
}

export function validateModelslabSttInvocationForTests({
  diagnostic,
  confirmSpend,
  confirmPremiumCost,
  provider = "v6_standard",
} = {}) {
  const profile = modelslabSttProviderProfileForTests(provider);
  if (!boolValue(diagnostic)) {
    throw new Error(
      "ModelsLab STT is candidate-only and requires --diagnostic true.",
    );
  }
  if (!boolValue(confirmSpend)) {
    throw new Error(
      "ModelsLab STT makes billable provider requests and requires "
      + "--confirm-spend true.",
    );
  }
  if (profile.premium && !boolValue(confirmPremiumCost)) {
    throw new Error(
      "The v7 Scribe candidate costs $0.001/sec and requires "
      + "--confirm-premium-cost true.",
    );
  }
  return {
    status: "passed",
    diagnostic_only: true,
    provider_profile: profile,
  };
}

export function validateLocalWhisperBaselineContractForTests(
  baselineTiming,
  sourceAudioSha256,
  {
    runIdentity = null,
    expectedContract = null,
  } = {},
) {
  const contractRequired = Boolean(
    expectedContract
    || identityRequiresLocalWhisperContract(runIdentity ?? {}),
  );
  const resolvedExpectedContract = contractRequired
    ? expectedContract
      ? normalizeLocalWhisperContract(expectedContract)
      : localWhisperContractForIdentity(runIdentity ?? {})
    : null;
  const identityContractValidation = runIdentity && contractRequired
    ? validateLocalWhisperIdentityContract(runIdentity)
    : null;
  if (!baselineTiming) {
    return {
      status: "not_run",
      contract_mode: contractRequired
        ? "identity_locked"
        : "historical_identity_adapter",
      expected_contract: resolvedExpectedContract,
      blockers: [],
    };
  }
  const blockers = [];
  if (baselineTiming.narration_audio_hash !== sourceAudioSha256) {
    blockers.push({
      code: "modelslab_stt_baseline_audio_hash_mismatch",
      expected: sourceAudioSha256,
      actual: baselineTiming.narration_audio_hash ?? null,
    });
  }
  if (baselineTiming.status !== "passed") {
    blockers.push({
      code: "modelslab_stt_baseline_status_not_passed",
      actual: baselineTiming.status ?? null,
    });
  }
  if (baselineTiming.full_stream_transcript_qa?.status !== "passed") {
    blockers.push({
      code: "modelslab_stt_baseline_full_stream_qa_not_passed",
      actual: baselineTiming.full_stream_transcript_qa?.status ?? null,
    });
  }
  if (!Array.isArray(baselineTiming.words)
    || !baselineTiming.words.length) {
    blockers.push({
      code: "modelslab_stt_baseline_words_missing",
    });
  }

  const actualContract = localWhisperContractFromReport(baselineTiming);

  if (contractRequired) {
    if (identityContractValidation && !identityContractValidation.done) {
      for (const mismatch of identityContractValidation.mismatches ?? []) {
        blockers.push({
          code:
            "modelslab_stt_identity_local_whisper_contract_field_mismatch",
          ...mismatch,
        });
      }
    }
    for (const mismatch of localWhisperContractMismatches(
      resolvedExpectedContract,
      PRODUCTION_LOCAL_WHISPER_CONTRACT,
    )) {
      blockers.push({
        code:
          "modelslab_stt_identity_local_whisper_contract_field_mismatch",
        ...mismatch,
      });
    }
    for (const mismatch of localWhisperContractMismatches(
      actualContract,
      resolvedExpectedContract,
    )) {
      blockers.push({
        code: "modelslab_stt_baseline_contract_field_mismatch",
        ...mismatch,
      });
    }
  } else {
    if (actualContract.engine !== "faster_whisper") {
      blockers.push({
        code: "modelslab_stt_baseline_engine_not_local_whisper",
        actual: actualContract.engine,
      });
    }
    if (!LEGACY_LOCAL_WHISPER_MODELS.has(actualContract.model)) {
      blockers.push({
        code:
          "modelslab_stt_baseline_model_not_historical_local_whisper",
        accepted: [...LEGACY_LOCAL_WHISPER_MODELS],
        actual: actualContract.model,
      });
    }
  }
  return {
    status: blockers.length ? "blocked" : "passed",
    contract_mode: contractRequired
      ? "identity_locked"
      : "historical_identity_adapter",
    expected_contract: resolvedExpectedContract,
    actual_contract: actualContract,
    alignment_engine: actualContract.engine,
    alignment_model: actualContract.model,
    blockers,
  };
}

export function validateModelslabTranscriptBindingForTests({
  sourceAudioSha256,
  narrationReportAudioSha256 = null,
  explicitExpectedTranscript = false,
} = {}) {
  if (narrationReportAudioSha256
    && narrationReportAudioSha256 !== sourceAudioSha256) {
    throw new Error(
      "ModelsLab STT source audio hash does not match the narration report: "
      + `${sourceAudioSha256} != ${narrationReportAudioSha256}`,
    );
  }
  const narrationReportOwnsAudio =
    narrationReportAudioSha256 === sourceAudioSha256;
  if (!explicitExpectedTranscript && !narrationReportOwnsAudio) {
    throw new Error(
      "The selected audio is not hash-owned by the narration report. "
      + "Supply --expected-transcript <path> for an explicit diagnostic "
      + "audio override.",
    );
  }
  return {
    status: "passed",
    narration_report_owns_audio: narrationReportOwnsAudio,
    transcript_source: explicitExpectedTranscript
      ? "explicit_expected_transcript"
      : "hash_bound_narration_report",
  };
}

export function validateModelslabSttUploadSizeForTests(sourceByteCount) {
  const sourceBytes = finiteNumber(sourceByteCount);
  const base64Bytes = sourceBytes === null
    ? null
    : 4 * Math.ceil(sourceBytes / 3);
  if (!(sourceBytes > 0)
    || sourceBytes > MAX_UPLOAD_SOURCE_BYTES
    || base64Bytes > MAX_UPLOAD_BASE64_BYTES) {
    throw new Error(
      "Prepared ModelsLab STT upload exceeds the conservative base64 "
      + `gateway limit: source=${sourceBytes ?? "invalid"} bytes, `
      + `base64=${base64Bytes ?? "invalid"} bytes, `
      + `maximum_source=${MAX_UPLOAD_SOURCE_BYTES}, `
      + `maximum_base64=${MAX_UPLOAD_BASE64_BYTES}.`,
    );
  }
  return {
    status: "passed",
    source_byte_count: sourceBytes,
    base64_byte_count: base64Bytes,
    maximum_source_byte_count: MAX_UPLOAD_SOURCE_BYTES,
    maximum_base64_byte_count: MAX_UPLOAD_BASE64_BYTES,
  };
}

export function planModelslabSttChunksForTests(durationSec, {
  maxChunkSec = DEFAULT_CHUNK_SEC,
  overlapSec = DEFAULT_OVERLAP_SEC,
} = {}) {
  const duration = finiteNumber(durationSec);
  const maximum = finiteNumber(maxChunkSec);
  const overlap = finiteNumber(overlapSec);
  if (!(duration >= MIN_PROVIDER_AUDIO_SEC)) {
    throw new Error(
      `ModelsLab STT input must be at least ${MIN_PROVIDER_AUDIO_SEC} seconds.`,
    );
  }
  if (!(maximum >= MIN_PROVIDER_AUDIO_SEC)
    || maximum > MAX_UPLOAD_CHUNK_SEC) {
    throw new Error(
      `ModelsLab STT chunks must be between ${MIN_PROVIDER_AUDIO_SEC} `
      + `and ${MAX_UPLOAD_CHUNK_SEC} seconds for the base64 upload lane.`,
    );
  }
  if (!(overlap >= 0) || overlap >= maximum - MIN_PROVIDER_AUDIO_SEC) {
    throw new Error(
      "ModelsLab STT chunk overlap must be nonnegative and leave at "
      + `least ${MIN_PROVIDER_AUDIO_SEC} seconds of forward progress.`,
    );
  }
  if (duration <= maximum) {
    return [{
      chunk_id: "chunk_0001",
      index: 0,
      start_sec: 0,
      end_sec: Number(duration.toFixed(6)),
      duration_sec: Number(duration.toFixed(6)),
      overlap_with_previous_sec: 0,
    }];
  }

  const chunks = [];
  let start = 0;
  while (start < duration - 1e-6) {
    let end = Math.min(duration, start + maximum);
    if (duration - end > 0 && duration - end < MIN_PROVIDER_AUDIO_SEC) {
      end = Math.max(start + MIN_PROVIDER_AUDIO_SEC, duration - MIN_PROVIDER_AUDIO_SEC);
    }
    const chunkDuration = end - start;
    if (chunkDuration < MIN_PROVIDER_AUDIO_SEC - 1e-6
      || chunkDuration > MAX_PROVIDER_AUDIO_SEC + 1e-6) {
      throw new Error(
        `Invalid ModelsLab STT chunk duration ${chunkDuration.toFixed(6)}s.`,
      );
    }
    chunks.push({
      chunk_id: `chunk_${String(chunks.length + 1).padStart(4, "0")}`,
      index: chunks.length,
      start_sec: Number(start.toFixed(6)),
      end_sec: Number(end.toFixed(6)),
      duration_sec: Number(chunkDuration.toFixed(6)),
      overlap_with_previous_sec: chunks.length
        ? Number(Math.max(0, chunks.at(-1).end_sec - start).toFixed(6))
        : 0,
    });
    if (end >= duration - 1e-6) break;
    let nextStart = end - overlap;
    if (duration - nextStart < MIN_PROVIDER_AUDIO_SEC) {
      nextStart = duration - MIN_PROVIDER_AUDIO_SEC;
    }
    if (!(nextStart > start + 1e-6)) {
      throw new Error("ModelsLab STT chunk planner made no forward progress.");
    }
    start = nextStart;
  }
  return chunks;
}

function wordRowFromValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rowType = String(value.type ?? "").trim().toLowerCase();
  if (rowType && !["word", "token"].includes(rowType)) return null;
  const word = String(
    value.word
      ?? value.text
      ?? value.token
      ?? value.value
      ?? "",
  ).trim();
  if (transcriptTokens(word).length !== 1) return null;
  const timestamp = Array.isArray(value.timestamp)
    ? value.timestamp
    : Array.isArray(value.timestamps)
      ? value.timestamps
      : null;
  const startSec = finiteNumber(
    value.start_sec
      ?? value.start
      ?? value.start_time
      ?? value.begin
      ?? timestamp?.[0],
  );
  const endSec = finiteNumber(
    value.end_sec
      ?? value.end
      ?? value.end_time
      ?? value.stop
      ?? timestamp?.[1],
  );
  if (!word || startSec === null || endSec === null) return null;
  const confidence = finiteNumber(
    value.probability
      ?? value.confidence
      ?? value.score,
  );
  return {
    word,
    start_sec: startSec,
    end_sec: endSec,
    ...(confidence === null ? {} : { probability: confidence }),
  };
}

function parseJsonString(value) {
  const text = String(value ?? "").trim();
  if (!text || !/^[{[]/u.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectTranscriptionPayload(value, state, keyHint = "", depth = 0) {
  if (value === null || value === undefined || depth > 10) return;
  if (typeof value === "string") {
    const parsed = parseJsonString(value);
    if (parsed !== null) {
      collectTranscriptionPayload(parsed, state, keyHint, depth + 1);
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || /^https?:\/\//iu.test(trimmed)) return;
    if (/^(?:text|transcript|transcription|result|output)$/iu.test(keyHint)) {
      state.texts.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    const normalizedRows = value
      .map(wordRowFromValue)
      .filter(Boolean);
    const nonSpacingRows = value.filter((row) => (
      String(row?.type ?? "").trim().toLowerCase() !== "spacing"
    ));
    const everyTypedRowIsWord = nonSpacingRows.length > 0
      && nonSpacingRows.every((row) => (
        ["word", "token"].includes(
          String(row?.type ?? "").trim().toLowerCase(),
        )
      ));
    if (normalizedRows.length
      && (
        /^(?:words?|word_timestamps?|word_timing|word_segments?)$/iu
          .test(keyHint)
        || everyTypedRowIsWord
      )) {
      state.word_sets.push(normalizedRows);
      return;
    }
    for (const item of value) {
      collectTranscriptionPayload(item, state, keyHint, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") return;

  for (const key of ["text", "transcript", "transcription"]) {
    if (typeof value[key] === "string") {
      collectTranscriptionPayload(value[key], state, key, depth + 1);
    }
  }
  for (const key of [
    "words",
    "word_timestamps",
    "word_timing",
    "word_segments",
    "segments",
    "timestamps",
    "chunks",
  ]) {
    if (Array.isArray(value[key])) {
      collectTranscriptionPayload(value[key], state, key, depth + 1);
    }
  }
  for (const key of [
    "output",
    "data",
    "result",
    "results",
    "meta",
    "response",
    "transcription",
  ]) {
    if (value[key] !== undefined) {
      collectTranscriptionPayload(value[key], state, key, depth + 1);
    }
  }
}

export function normalizeModelslabSttPayloadForTests(payloads) {
  const state = { texts: [], word_sets: [] };
  for (const payload of Array.isArray(payloads) ? payloads : [payloads]) {
    collectTranscriptionPayload(payload, state, "output");
  }
  const words = state.word_sets
    .sort((left, right) => right.length - left.length)[0]
    ?? [];
  const textCandidates = state.texts
    .map((text) => text.trim())
    .filter(Boolean)
    .sort((left, right) => transcriptTokens(right).length - transcriptTokens(left).length);
  const text = textCandidates[0]
    ?? words.map((row) => row.word).join(" ").trim();
  return {
    text,
    words,
    discovered_text_candidate_count: textCandidates.length,
    discovered_word_set_count: state.word_sets.length,
  };
}

export function modelslabSttResponseHasFinalTranscriptionForTests(response) {
  const status = String(response?.status ?? "").trim().toLowerCase();
  if (status && status !== "success") return false;
  const normalized = normalizeModelslabSttPayloadForTests([
    response?.meta,
    response,
  ]);
  return Boolean(normalized.words.length || normalized.text);
}

export function mergeModelslabSttChunksForTests(chunkResults) {
  const sorted = [...(chunkResults ?? [])]
    .sort((left, right) => Number(left.start_sec) - Number(right.start_sec));
  const words = [];
  const chunks = [];
  let previousEndSec = null;
  for (const chunk of sorted) {
    const offset = Number(chunk.start_sec ?? 0);
    const endSec = Number(chunk.end_sec ?? (
      offset + Number(chunk.duration_sec ?? 0)
    ));
    let overlapDiscarded = 0;
    for (const row of chunk.words ?? []) {
      const absolute = {
        word: String(row.word ?? "").trim(),
        start_sec: Number((offset + Number(row.start_sec)).toFixed(6)),
        end_sec: Number((offset + Number(row.end_sec)).toFixed(6)),
        provider_start_sec: Number(row.start_sec),
        provider_end_sec: Number(row.end_sec),
        source_chunk_id: chunk.chunk_id,
        ...(Number.isFinite(Number(row.probability))
          ? { probability: Number(row.probability) }
          : {}),
      };
      const midpoint = (absolute.start_sec + absolute.end_sec) / 2;
      if (previousEndSec !== null && midpoint <= previousEndSec + 1e-6) {
        overlapDiscarded += 1;
        continue;
      }
      words.push(absolute);
    }
    chunks.push({
      chunk_id: chunk.chunk_id,
      start_sec: offset,
      end_sec: endSec,
      provider_word_count: (chunk.words ?? []).length,
      overlap_word_count_discarded: overlapDiscarded,
    });
    previousEndSec = previousEndSec === null
      ? endSec
      : Math.max(previousEndSec, endSec);
  }
  return {
    text: words.map((row) => row.word).join(" ").trim(),
    words: words.map((row, index) => ({ index, ...row })),
    chunks,
  };
}

function bandedLevenshteinAlignment(expected, actual, {
  usefulDistanceRatio = 0.06,
  maximumBand = 2048,
} = {}) {
  const expectedLength = expected.length;
  const actualLength = actual.length;
  const lengthDelta = Math.abs(expectedLength - actualLength);
  const usefulDistance = Math.ceil(
    Math.max(expectedLength, actualLength) * usefulDistanceRatio,
  ) + 16;
  if (lengthDelta > usefulDistance) {
    return {
      edit_distance: lengthDelta,
      matches: [],
      alignment_truncated: true,
      band_width: 0,
    };
  }
  const band = Math.min(
    maximumBand,
    Math.max(lengthDelta + 8, usefulDistance),
  );
  const unreachable = expectedLength + actualLength + 1;
  const directions = [];

  let previousLow = 0;
  let previousHigh = Math.min(actualLength, band);
  let previousCosts = new Int32Array(previousHigh - previousLow + 1);
  const firstDirections = new Uint8Array(previousCosts.length);
  firstDirections.fill(2);
  firstDirections[0] = 255;
  for (let column = previousLow; column <= previousHigh; column += 1) {
    previousCosts[column - previousLow] = column;
  }
  directions.push({
    low: previousLow,
    directions: firstDirections,
  });

  const previousCost = (column) => (
    column < previousLow || column > previousHigh
      ? unreachable
      : previousCosts[column - previousLow]
  );
  for (let row = 1; row <= expectedLength; row += 1) {
    const low = Math.max(0, row - band);
    const high = Math.min(actualLength, row + band);
    const costs = new Int32Array(high - low + 1);
    const rowDirections = new Uint8Array(costs.length);
    rowDirections.fill(255);
    for (let column = low; column <= high; column += 1) {
      const index = column - low;
      if (column === 0) {
        costs[index] = row;
        rowDirections[index] = 1;
        continue;
      }
      const substitution = previousCost(column - 1)
        + (expected[row - 1] === actual[column - 1] ? 0 : 1);
      const deletion = previousCost(column) + 1;
      const insertion = index > 0 ? costs[index - 1] + 1 : unreachable;
      let best = substitution;
      let direction = 0;
      if (deletion < best) {
        best = deletion;
        direction = 1;
      }
      if (insertion < best) {
        best = insertion;
        direction = 2;
      }
      costs[index] = best;
      rowDirections[index] = direction;
    }
    directions.push({ low, directions: rowDirections });
    previousLow = low;
    previousHigh = high;
    previousCosts = costs;
  }

  const finalIndex = actualLength - previousLow;
  if (finalIndex < 0 || finalIndex >= previousCosts.length) {
    return {
      edit_distance: usefulDistance + 1,
      matches: [],
      alignment_truncated: true,
      band_width: band,
    };
  }
  const matches = [];
  let row = expectedLength;
  let column = actualLength;
  while (row > 0 || column > 0) {
    const directionRow = directions[row];
    const directionIndex = column - directionRow.low;
    const direction = directionIndex >= 0
      && directionIndex < directionRow.directions.length
      ? directionRow.directions[directionIndex]
      : 255;
    if (direction === 0 && row > 0 && column > 0) {
      if (expected[row - 1] === actual[column - 1]) {
        matches.push({
          expected_index: row - 1,
          actual_index: column - 1,
        });
      }
      row -= 1;
      column -= 1;
    } else if (direction === 1 && row > 0) {
      row -= 1;
    } else if (direction === 2 && column > 0) {
      column -= 1;
    } else {
      return {
        edit_distance: previousCosts[finalIndex],
        matches: [],
        alignment_truncated: true,
        band_width: band,
      };
    }
  }
  matches.reverse();
  return {
    edit_distance: previousCosts[finalIndex],
    matches,
    alignment_truncated: false,
    band_width: band,
  };
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

export function validateModelslabSttCandidateForTests({
  words = [],
  recognizedText = "",
  expectedText = "",
  audioDurationSec,
  baselineWords = null,
  baselineContract = null,
  maxWer = 0.05,
  baselineMedianDeltaSec = 0.3,
  baselineP95DeltaSec = 0.75,
} = {}) {
  const duration = finiteNumber(audioDurationSec);
  const timingFindings = [];
  let previousStart = -Infinity;
  for (let index = 0; index < words.length; index += 1) {
    const row = words[index];
    const start = finiteNumber(row.start_sec);
    const end = finiteNumber(row.end_sec);
    if (!normalizeToken(row.word)) {
      timingFindings.push({
        code: "modelslab_stt_word_empty",
        word_index: index,
      });
    }
    if (start === null || end === null) {
      timingFindings.push({
        code: "modelslab_stt_timestamp_non_finite",
        word_index: index,
      });
      continue;
    }
    if (start < -0.001 || end <= start) {
      timingFindings.push({
        code: "modelslab_stt_timestamp_invalid_range",
        word_index: index,
        start_sec: start,
        end_sec: end,
      });
    }
    if (start + 0.001 < previousStart) {
      timingFindings.push({
        code: "modelslab_stt_timestamp_not_monotonic",
        word_index: index,
        previous_start_sec: previousStart,
        start_sec: start,
      });
    }
    if (duration !== null && end > duration + 0.5) {
      timingFindings.push({
        code: "modelslab_stt_timestamp_exceeds_audio",
        word_index: index,
        end_sec: end,
        audio_duration_sec: duration,
      });
    }
    previousStart = Math.max(previousStart, start);
  }
  if (!words.length) {
    timingFindings.push({ code: "modelslab_stt_word_timestamps_missing" });
  }

  const expectedTokens = transcriptTokens(expectedText);
  const actualTokens = transcriptTokens(
    recognizedText || words.map((row) => row.word).join(" "),
  );
  const alignment = bandedLevenshteinAlignment(
    expectedTokens,
    actualTokens,
  );
  const wer = expectedTokens.length
    ? alignment.edit_distance / expectedTokens.length
    : null;
  const transcriptFindings = [];
  if (!expectedTokens.length) {
    transcriptFindings.push({
      code: "modelslab_stt_expected_transcript_missing",
    });
  }
  if (!actualTokens.length) {
    transcriptFindings.push({
      code: "modelslab_stt_recognized_transcript_missing",
    });
  }
  if (wer !== null && wer > maxWer) {
    transcriptFindings.push({
      code: "modelslab_stt_transcript_wer_exceeds_limit",
      word_error_rate: Number(wer.toFixed(6)),
      maximum_word_error_rate: maxWer,
    });
  }
  if (expectedTokens.length && (
    actualTokens.length < expectedTokens.length * 0.95
    || actualTokens.length > expectedTokens.length * 1.05
  )) {
    transcriptFindings.push({
      code: "modelslab_stt_transcript_word_count_drift",
      expected_word_count: expectedTokens.length,
      actual_word_count: actualTokens.length,
    });
  }

  let baselineComparison = {
    status: "not_run",
    reason: "same_audio_local_whisper_baseline_not_supplied",
    matched_word_count: 0,
    match_ratio: null,
    median_midpoint_delta_sec: null,
    p95_midpoint_delta_sec: null,
    blockers: [{
      code: "modelslab_stt_local_whisper_timing_comparison_missing",
    }],
  };
  if (Array.isArray(baselineWords) && baselineWords.length) {
    const baselineTokens = baselineWords.map((row) => normalizeToken(row.word));
    const candidateTokens = words.map((row) => normalizeToken(row.word));
    const baselineAlignment = bandedLevenshteinAlignment(
      baselineTokens,
      candidateTokens,
    );
    const deltas = baselineAlignment.matches.map((match) => {
      const baseline = baselineWords[match.expected_index];
      const candidate = words[match.actual_index];
      const baselineMidpoint = (
        Number(baseline.start_sec) + Number(baseline.end_sec)
      ) / 2;
      const candidateMidpoint = (
        Number(candidate.start_sec) + Number(candidate.end_sec)
      ) / 2;
      return Math.abs(candidateMidpoint - baselineMidpoint);
    }).filter(Number.isFinite);
    const denominator = Math.max(1, Math.min(
      baselineWords.length,
      words.length,
    ));
    const matchRatio = baselineAlignment.matches.length / denominator;
    const median = percentile(deltas, 0.5);
    const p95 = percentile(deltas, 0.95);
    const blockers = [];
    if (matchRatio < 0.95) {
      blockers.push({
        code: "modelslab_stt_baseline_token_match_too_low",
        match_ratio: Number(matchRatio.toFixed(6)),
        required_ratio: 0.95,
      });
    }
    if (median === null || median > baselineMedianDeltaSec) {
      blockers.push({
        code: "modelslab_stt_baseline_median_timing_delta_too_high",
        median_midpoint_delta_sec: median,
        maximum_sec: baselineMedianDeltaSec,
      });
    }
    if (p95 === null || p95 > baselineP95DeltaSec) {
      blockers.push({
        code: "modelslab_stt_baseline_p95_timing_delta_too_high",
        p95_midpoint_delta_sec: p95,
        maximum_sec: baselineP95DeltaSec,
      });
    }
    baselineComparison = {
      status: blockers.length ? "blocked" : "passed",
      matched_word_count: baselineAlignment.matches.length,
      match_ratio: Number(matchRatio.toFixed(6)),
      alignment_algorithm: "banded_levenshtein_v1",
      alignment_truncated: baselineAlignment.alignment_truncated,
      alignment_band_width: baselineAlignment.band_width,
      median_midpoint_delta_sec: median === null
        ? null
        : Number(median.toFixed(6)),
      p95_midpoint_delta_sec: p95 === null
        ? null
        : Number(p95.toFixed(6)),
      blockers,
    };
  }

  const candidateBlockers = [
    ...timingFindings,
    ...transcriptFindings,
  ];
  const promotionBlockers = [
    ...candidateBlockers,
    ...(baselineComparison.blockers ?? []),
    ...(baselineContract?.blockers ?? []),
  ];
  return {
    status: candidateBlockers.length ? "blocked" : "passed",
    timing_validation: {
      status: timingFindings.length ? "blocked" : "passed",
      word_count: words.length,
      blockers: timingFindings,
    },
    transcript_validation: {
      status: transcriptFindings.length ? "blocked" : "passed",
      expected_word_count: expectedTokens.length,
      recognized_word_count: actualTokens.length,
      edit_distance: alignment.edit_distance,
      matched_word_count: alignment.matches.length,
      alignment_algorithm: "banded_levenshtein_v1",
      alignment_truncated: alignment.alignment_truncated,
      alignment_band_width: alignment.band_width,
      word_error_rate: wer === null ? null : Number(wer.toFixed(6)),
      maximum_word_error_rate: maxWer,
      blockers: transcriptFindings,
    },
    local_whisper_timing_comparison: baselineComparison,
    local_whisper_baseline_contract: baselineContract ?? {
      status: "not_run",
      blockers: [],
    },
    blockers: candidateBlockers,
    production_timing_promotion: {
      status: promotionBlockers.length ? "ineligible" : "eligible",
      promotion_applied: false,
      canonical_timing_untouched: true,
      requires_explicit_future_operator_approved_promotion_path: true,
      blockers: promotionBlockers,
    },
  };
}

export const MODELSLAB_STT_LIMITS = Object.freeze({
  minimum_audio_sec: MIN_PROVIDER_AUDIO_SEC,
  maximum_audio_sec: MAX_PROVIDER_AUDIO_SEC,
  maximum_upload_chunk_sec: MAX_UPLOAD_CHUNK_SEC,
  default_chunk_sec: DEFAULT_CHUNK_SEC,
  default_overlap_sec: DEFAULT_OVERLAP_SEC,
  maximum_upload_source_bytes: MAX_UPLOAD_SOURCE_BYTES,
  maximum_upload_base64_bytes: MAX_UPLOAD_BASE64_BYTES,
  v7_scribe_price_usd_per_sec: V7_SCRIBE_RATE_USD_PER_SEC,
});
