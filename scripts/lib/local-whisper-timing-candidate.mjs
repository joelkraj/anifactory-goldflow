import { createHash } from "node:crypto";
import {
  localWhisperContractMismatches,
  localWhisperWordTimingQa,
  normalizeLocalWhisperContract,
} from "./local-whisper-policy.mjs";

export const LOCAL_WHISPER_TIMING_CANDIDATE_SCHEMA =
  "goldflow_local_whisper_timing_candidate_v1";

function canonicalize(value, omitted = new Set()) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, omitted));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !omitted.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child, omitted)]),
  );
}

export function localWhisperTimingCandidateSha256(candidate) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(candidate, new Set(["candidate_sha256"]))))
    .digest("hex");
}

export function buildLocalWhisperTimingCandidate({
  transcription,
  contract,
  sourceScriptPath,
  sourceScriptSha256,
  narrationAudioPath,
  narrationAudioSha256,
  narrationReportPath,
  narrationReportSha256,
  runIdentityPath,
  runIdentitySha256,
  narrationQualityContractSha256 = null,
} = {}) {
  const words = Array.isArray(transcription?.words)
    ? structuredClone(transcription.words)
    : [];
  const wordTimingQa = localWhisperWordTimingQa(
    words,
    transcription?.duration_sec,
  );
  const normalizedContract = normalizeLocalWhisperContract(contract);
  const candidate = {
    schema: LOCAL_WHISPER_TIMING_CANDIDATE_SCHEMA,
    status: words.length && wordTimingQa.status === "passed" ? "passed" : "blocked",
    source_script_path: sourceScriptPath,
    source_script_hash: sourceScriptSha256,
    narration_audio_path: narrationAudioPath,
    narration_audio_hash: narrationAudioSha256,
    narration_report_path: narrationReportPath,
    narration_report_sha256: narrationReportSha256,
    run_identity_path: runIdentityPath,
    run_identity_sha256: runIdentitySha256,
    narration_quality_contract_sha256: narrationQualityContractSha256,
    alignment_contract: normalizedContract,
    alignment_contract_version: normalizedContract.contract_version,
    alignment_engine: normalizedContract.engine,
    alignment_model: normalizedContract.model,
    alignment_device: normalizedContract.device,
    alignment_compute_type: normalizedContract.compute_type,
    alignment_omp_num_threads: normalizedContract.omp_num_threads,
    alignment_cpu_threads: normalizedContract.cpu_threads,
    alignment_beam_size: normalizedContract.beam_size,
    alignment_word_timestamps: normalizedContract.word_timestamps,
    alignment_vad_filter: normalizedContract.vad_filter,
    language: transcription?.language ?? normalizedContract.language,
    language_probability: transcription?.language_probability ?? null,
    audio_duration_sec: transcription?.duration_sec ?? null,
    recognized_text: transcription?.text
      ?? words.map((word) => word.word).join(" "),
    word_count: words.length,
    word_timing_qa: wordTimingQa,
    words,
    provenance: {
      producer: "narration_provider_output_finalizer",
      reuse_policy: "promote_only_after_exact_hash_and_contract_validation",
      transcription_reused_without_rerun: true,
    },
  };
  return {
    ...candidate,
    candidate_sha256: localWhisperTimingCandidateSha256(candidate),
  };
}

export function validateLocalWhisperTimingCandidate(candidate, {
  contract,
  sourceScriptSha256,
  narrationAudioSha256,
  narrationReportSha256,
  runIdentitySha256,
  narrationQualityContractSha256 = null,
} = {}) {
  const findings = [];
  const expect = (condition, code, details = {}) => {
    if (!condition) findings.push({ code, ...details });
  };
  expect(
    candidate?.schema === LOCAL_WHISPER_TIMING_CANDIDATE_SCHEMA,
    "local_whisper_timing_candidate_schema_invalid",
  );
  expect(candidate?.status === "passed", "local_whisper_timing_candidate_not_passed");
  expect(
    candidate?.candidate_sha256 === localWhisperTimingCandidateSha256(candidate ?? {}),
    "local_whisper_timing_candidate_hash_invalid",
  );
  for (const [field, actual, expected] of [
    ["source_script_hash", candidate?.source_script_hash, sourceScriptSha256],
    ["narration_audio_hash", candidate?.narration_audio_hash, narrationAudioSha256],
    ["narration_report_sha256", candidate?.narration_report_sha256, narrationReportSha256],
    ["run_identity_sha256", candidate?.run_identity_sha256, runIdentitySha256],
    [
      "narration_quality_contract_sha256",
      candidate?.narration_quality_contract_sha256 ?? null,
      narrationQualityContractSha256 ?? null,
    ],
  ]) {
    expect(actual === expected, "local_whisper_timing_candidate_binding_mismatch", {
      field,
      expected,
      actual,
    });
  }
  const contractMismatches = localWhisperContractMismatches(
    candidate?.alignment_contract ?? {},
    contract ?? {},
  );
  findings.push(...contractMismatches.map((finding) => ({
    code: "local_whisper_timing_candidate_contract_mismatch",
    ...finding,
  })));
  const words = Array.isArray(candidate?.words) ? candidate.words : [];
  const structure = localWhisperWordTimingQa(words, candidate?.audio_duration_sec);
  expect(words.length > 0, "local_whisper_timing_candidate_words_missing");
  expect(
    candidate?.word_count === words.length,
    "local_whisper_timing_candidate_word_count_mismatch",
  );
  expect(
    structure.status === "passed" && candidate?.word_timing_qa?.status === "passed",
    "local_whisper_timing_candidate_word_structure_invalid",
  );
  return {
    status: findings.length ? "blocked" : "passed",
    findings,
    contract: normalizeLocalWhisperContract(candidate?.alignment_contract ?? {}),
    word_timing_qa: structure,
  };
}

