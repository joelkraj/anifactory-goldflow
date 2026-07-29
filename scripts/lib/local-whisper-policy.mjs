export const LOCAL_WHISPER_CONTRACT_VERSION =
  "local_whisper_word_timing_v2";

export const PRODUCTION_LOCAL_WHISPER_CONTRACT = Object.freeze({
  contract_version: LOCAL_WHISPER_CONTRACT_VERSION,
  engine: "faster_whisper",
  model: "small.en",
  device: "cpu",
  compute_type: "int8_float32",
  omp_num_threads: 12,
  cpu_threads: 0,
  language: "en",
  beam_size: 5,
  word_timestamps: true,
  vad_filter: false,
});

export const LOCAL_WHISPER_CONTRACT_KEYS = Object.freeze(
  Object.keys(PRODUCTION_LOCAL_WHISPER_CONTRACT),
);

function clone(value) {
  return structuredClone(value);
}

function cleanString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedBoolean(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

export function normalizeLocalWhisperContract(value = {}) {
  return {
    contract_version: cleanString(value.contract_version),
    engine: cleanString(value.engine),
    model: cleanString(value.model),
    device: cleanString(value.device),
    compute_type: cleanString(value.compute_type),
    omp_num_threads: finiteNumber(value.omp_num_threads),
    cpu_threads: finiteNumber(value.cpu_threads),
    language: cleanString(value.language),
    beam_size: finiteNumber(value.beam_size),
    word_timestamps: normalizedBoolean(value.word_timestamps),
    vad_filter: normalizedBoolean(value.vad_filter),
  };
}

export function productionLocalWhisperContract() {
  return clone(PRODUCTION_LOCAL_WHISPER_CONTRACT);
}

export function explicitLocalWhisperContractForIdentity(identity = {}) {
  const value = identity?.provider_locks?.local_whisper_timing;
  return value && typeof value === "object" && !Array.isArray(value)
    ? normalizeLocalWhisperContract(value)
    : null;
}

export function identityRequiresLocalWhisperContract(identity = {}) {
  return identity?.production_gates?.local_whisper_contract_required === true
    || explicitLocalWhisperContractForIdentity(identity) !== null;
}

export function localWhisperContractForIdentity(identity = {}) {
  return explicitLocalWhisperContractForIdentity(identity)
    ?? productionLocalWhisperContract();
}

export function localWhisperContractMismatches(actualValue, expectedValue) {
  const actual = normalizeLocalWhisperContract(actualValue);
  const expected = normalizeLocalWhisperContract(expectedValue);
  return LOCAL_WHISPER_CONTRACT_KEYS
    .filter((key) => actual[key] !== expected[key])
    .map((key) => ({
      field: key,
      expected: expected[key],
      actual: actual[key],
    }));
}

export function validateLocalWhisperIdentityContract(identity = {}) {
  if (!identityRequiresLocalWhisperContract(identity)) {
    return {
      done: true,
      mode: "legacy_adapter",
      contract: null,
      mismatches: [],
      evidence: "legacy identity has no explicit local-Whisper lock",
    };
  }
  const contract = explicitLocalWhisperContractForIdentity(identity);
  if (!contract) {
    return {
      done: false,
      mode: "locked",
      contract: null,
      mismatches: [{ field: "provider_locks.local_whisper_timing" }],
      evidence: "local-Whisper contract gate is set but provider lock is missing",
    };
  }
  const profileContract =
    identity?.production_profile_config?.audio?.local_whisper_timing;
  const mismatches = localWhisperContractMismatches(
    contract,
    PRODUCTION_LOCAL_WHISPER_CONTRACT,
  ).map((finding) => ({
    ...finding,
    field: `provider_locks.local_whisper_timing.${finding.field}`,
  }));
  if (!profileContract) {
    mismatches.push({
      field: "production_profile_config.audio.local_whisper_timing",
      expected: contract,
      actual: null,
    });
  } else {
    mismatches.push(...localWhisperContractMismatches(
      profileContract,
      contract,
    ).map((finding) => ({
      ...finding,
      field: `production_profile_config.audio.local_whisper_timing.${finding.field}`,
    })));
  }
  if (identity?.model_versions?.local_whisper_model !== contract.model) {
    mismatches.push({
      field: "model_versions.local_whisper_model",
      expected: contract.model,
      actual: identity?.model_versions?.local_whisper_model ?? null,
    });
  }
  return {
    done: mismatches.length === 0,
    mode: "locked",
    contract,
    mismatches,
    evidence: mismatches.length
      ? `local-Whisper identity lock mismatch: ${mismatches
        .map((finding) => finding.field)
        .join(", ")}`
      : `local-Whisper ${contract.model}/${contract.device}/`
        + `${contract.compute_type}; OMP=${contract.omp_num_threads}; `
        + `cpu_threads=${contract.cpu_threads}`,
  };
}

export function localWhisperCommandFlags(contractValue) {
  const contract = normalizeLocalWhisperContract(contractValue);
  return [
    "--engine", contract.engine,
    "--model", contract.model,
    "--device", contract.device,
    "--compute-type", contract.compute_type,
    "--omp-num-threads", String(contract.omp_num_threads),
    "--cpu-threads", String(contract.cpu_threads),
    "--language", contract.language,
    "--beam-size", String(contract.beam_size),
    "--word-timestamps", String(contract.word_timestamps),
    "--vad-filter", String(contract.vad_filter),
  ].join(" ");
}

export function localWhisperTopLevelContractFromReport(report = {}) {
  return normalizeLocalWhisperContract({
    contract_version: report.alignment_contract_version,
    engine: report.alignment_engine,
    model: report.alignment_model,
    device: report.alignment_device,
    compute_type: report.alignment_compute_type,
    omp_num_threads: report.alignment_omp_num_threads,
    cpu_threads: report.alignment_cpu_threads,
    language: report.language,
    beam_size: report.alignment_beam_size,
    word_timestamps: report.alignment_word_timestamps,
    vad_filter: report.alignment_vad_filter,
  });
}

export function localWhisperContractFromReport(report = {}) {
  if (report?.alignment_contract
    && typeof report.alignment_contract === "object"
    && !Array.isArray(report.alignment_contract)) {
    return normalizeLocalWhisperContract(report.alignment_contract);
  }
  return localWhisperTopLevelContractFromReport(report);
}

function rounded(value, places = 6) {
  return Number(Number(value).toFixed(places));
}

export function localWhisperWordTimingQa(wordsValue, audioDurationSec) {
  const words = Array.isArray(wordsValue) ? wordsValue : [];
  const duration = Number(audioDurationSec);
  const warnings = [];
  const blockers = [];
  const zeroDuration = [];
  const invalid = [];
  const nonmonotonic = [];
  const outOfBounds = [];
  let previousStart = -Infinity;

  words.forEach((word, index) => {
    const start = Number(word?.start_sec);
    const end = Number(word?.end_sec);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0
      || end < start) {
      invalid.push({ index, word: word?.word ?? null, start_sec: start, end_sec: end });
      return;
    }
    if (start < previousStart) {
      nonmonotonic.push({
        index,
        word: word?.word ?? null,
        start_sec: start,
        previous_start_sec: previousStart,
      });
    }
    previousStart = start;
    if (start === end) {
      zeroDuration.push({
        index,
        word: word?.word ?? null,
        start_sec: start,
        end_sec: end,
      });
    }
    if (Number.isFinite(duration) && (start > duration || end > duration)) {
      outOfBounds.push({
        index,
        word: word?.word ?? null,
        start_sec: start,
        end_sec: end,
        audio_duration_sec: duration,
      });
    }
  });

  if (zeroDuration.length) {
    warnings.push({
      severity: "warning",
      code: "local_whisper_zero_duration_word_timings",
      count: zeroDuration.length,
      rate: words.length ? rounded(zeroDuration.length / words.length) : 0,
      examples: zeroDuration.slice(0, 12),
      disposition:
        "warning_only_preserve_for_spot_review_do_not_block_production",
    });
  }
  for (const [code, rows] of [
    ["local_whisper_invalid_word_timings", invalid],
    ["local_whisper_nonmonotonic_word_timings", nonmonotonic],
    ["local_whisper_out_of_bounds_word_timings", outOfBounds],
  ]) {
    if (!rows.length) continue;
    blockers.push({
      severity: "blocker",
      code,
      count: rows.length,
      examples: rows.slice(0, 12),
    });
  }
  return {
    status: blockers.length ? "blocked" : "passed",
    policy_version: "local_whisper_word_timing_structure_v1",
    word_count: words.length,
    zero_duration_word_count: zeroDuration.length,
    zero_duration_word_rate:
      words.length ? rounded(zeroDuration.length / words.length) : 0,
    warnings,
    blockers,
  };
}

export function validateLockedLocalWhisperReport(report = {}, identity = {}) {
  const identityValidation = validateLocalWhisperIdentityContract(identity);
  if (!identityValidation.done || identityValidation.mode === "legacy_adapter") {
    return {
      done: identityValidation.done,
      mode: identityValidation.mode,
      contract: identityValidation.contract,
      mismatches: identityValidation.mismatches,
      evidence: identityValidation.evidence,
    };
  }
  const actual = localWhisperContractFromReport(report);
  const mismatches = localWhisperContractMismatches(
    actual,
    identityValidation.contract,
  );
  const topLevel = localWhisperTopLevelContractFromReport(report);
  mismatches.push(...localWhisperContractMismatches(
    topLevel,
    identityValidation.contract,
  ).map((finding) => ({
    ...finding,
    field: `top_level.${finding.field}`,
  })));
  const structureStatus = report?.word_timing_qa?.status ?? null;
  if (structureStatus !== "passed") {
    mismatches.push({
      field: "word_timing_qa.status",
      expected: "passed",
      actual: structureStatus,
    });
  }
  return {
    done: mismatches.length === 0,
    mode: "locked",
    contract: identityValidation.contract,
    actual,
    top_level: topLevel,
    mismatches,
    evidence: mismatches.length
      ? `local-Whisper report contract mismatch: ${mismatches
        .map((finding) => finding.field)
        .join(", ")}`
      : `report matches ${actual.model}/${actual.device}/`
        + `${actual.compute_type}; OMP=${actual.omp_num_threads}; `
        + `cpu_threads=${actual.cpu_threads}`,
  };
}
