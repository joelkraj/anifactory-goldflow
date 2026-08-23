#!/usr/bin/env node

import { execFile as execFileCb, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  identityUsesCanonicalNarrationContract,
  resolveNarrationReportPath,
} from "./lib/narration-artifacts.mjs";
import {
  identityRequiresLocalWhisperContract,
  localWhisperContractFromReport,
  localWhisperContractMismatches,
  localWhisperTopLevelContractFromReport,
  localWhisperWordTimingQa,
  normalizeLocalWhisperContract,
  productionLocalWhisperContract,
  validateLocalWhisperIdentityContract,
} from "./lib/local-whisper-policy.mjs";
import { transcriptQaForTests } from "./modelslab-qwen-episode-audio.mjs";
import { softenPrimaryQa } from "./lib/tts-selection-policy.mjs";
import {
  narrationQualityContractForIdentity,
} from "./lib/narration-quality-contract.mjs";
import {
  exactNarrationRepairPacket,
  strictNarrationDeliveryDecision,
} from "./lib/narration-delivery-quality.mjs";
import {
  validateLocalWhisperTimingCandidate,
} from "./lib/local-whisper-timing-candidate.mjs";

const execFile = promisify(execFileCb);
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const args = process.argv.slice(2);
const flags = parseFlags(args);

const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = flags["episode-dir"]
  ? path.resolve(flags["episode-dir"])
  : path.join(weekDir, "episodes", episode);
const scriptPath = flags.script ?? path.join(episodeDir, "script_clean.md");
const narrationReportPath = resolveNarrationReportPath({ episodeDir, episode, flags });
const qwenReportPath = narrationReportPath;
const outputPath = flags.output ?? path.join(episodeDir, `narration_word_timing_${episode}.json`);
const runIdentityPath = path.join(episodeDir, "run_identity.json");

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

export function reusableCanonicalFullStreamQaForTiming({
  artifact,
  sourceScriptHash,
  narrationAudioSha256,
  narrationQualityContractSha256,
  runtimeContract,
  alignmentModel,
  recognizedText,
  recognizedWords,
} = {}) {
  const findings = [];
  if (artifact?.schema !== "goldflow_narration_full_stream_qa_v2") {
    findings.push("schema");
  }
  if (!String(artifact?.status ?? "").startsWith("passed")) {
    findings.push("status");
  }
  if ((artifact?.blockers ?? []).length !== 0
    || (artifact?.decision?.blockers ?? []).length !== 0) {
    findings.push("blockers");
  }
  if (artifact?.source_script_hash !== sourceScriptHash) {
    findings.push("source_script_hash");
  }
  if (artifact?.audio_sha256 !== narrationAudioSha256) {
    findings.push("narration_audio_sha256");
  }
  if (artifact?.narration_quality_contract_sha256
    !== narrationQualityContractSha256) {
    findings.push("narration_quality_contract_sha256");
  }
  if (artifact?.primary_model !== alignmentModel) {
    findings.push("alignment_model");
  }
  if (JSON.stringify(artifact?.primary_alignment_contract ?? null)
    !== JSON.stringify(runtimeContract ?? null)) {
    findings.push("alignment_contract");
  }
  if (artifact?.primary_recognized_text !== recognizedText) {
    findings.push("recognized_text");
  }
  if (JSON.stringify(artifact?.primary_recognized_words ?? null)
    !== JSON.stringify(recognizedWords ?? null)) {
    findings.push("recognized_words");
  }
  return {
    status: findings.length ? "not_reusable" : "reusable",
    findings,
  };
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

async function hashFile(filePath) {
  try {
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch {
    return null;
  }
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

function narrationAudioPath(qwenReport) {
  const explicit = flags.audio ?? flags.narrationAudio;
  if (explicit) return explicit;
  if (qwenReport.output_path) return qwenReport.output_path;
  throw new Error("No clean stitched narration audio path found. Pass --audio <path>.");
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function contractOverridesFromFlags(inputFlags = {}) {
  const values = {
    engine: inputFlags.engine,
    model: inputFlags.model,
    device: inputFlags.device,
    compute_type: firstDefined(
      inputFlags.computeType,
      inputFlags["compute-type"],
    ),
    omp_num_threads: inputFlags["omp-num-threads"],
    cpu_threads: inputFlags["cpu-threads"],
    language: inputFlags.language,
    beam_size: inputFlags["beam-size"],
    word_timestamps: inputFlags["word-timestamps"],
    vad_filter: inputFlags["vad-filter"],
  };
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

function contractOverridesFromEnv(env = {}) {
  const values = {
    engine: env.ANIFACTORY_WHISPER_ENGINE,
    model: env.ANIFACTORY_WHISPER_MODEL,
    device: env.ANIFACTORY_WHISPER_DEVICE,
    compute_type: env.ANIFACTORY_WHISPER_COMPUTE_TYPE,
    omp_num_threads:
      env.ANIFACTORY_WHISPER_OMP_NUM_THREADS ?? env.OMP_NUM_THREADS,
    cpu_threads: env.ANIFACTORY_WHISPER_CPU_THREADS,
    language: env.ANIFACTORY_WHISPER_LANGUAGE,
    beam_size: env.ANIFACTORY_WHISPER_BEAM_SIZE,
    word_timestamps: env.ANIFACTORY_WHISPER_WORD_TIMESTAMPS,
    vad_filter: env.ANIFACTORY_WHISPER_VAD_FILTER,
  };
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

function validateRuntimeContract(contract) {
  if (contract.engine !== "faster_whisper") {
    throw new Error(
      `Unsupported local-Whisper engine ${contract.engine ?? "missing"}; `
      + "production requires faster_whisper.",
    );
  }
  for (const field of ["model", "device", "compute_type", "language"]) {
    if (!contract[field]) {
      throw new Error(`Missing local-Whisper runtime field: ${field}.`);
    }
  }
  if (!Number.isInteger(contract.omp_num_threads)
    || contract.omp_num_threads < 1) {
    throw new Error("Local Whisper requires omp_num_threads >= 1.");
  }
  if (!Number.isInteger(contract.cpu_threads) || contract.cpu_threads < 0) {
    throw new Error("Local Whisper requires cpu_threads >= 0.");
  }
  if (!Number.isInteger(contract.beam_size) || contract.beam_size < 1) {
    throw new Error("Local Whisper requires beam_size >= 1.");
  }
  if (contract.word_timestamps !== true) {
    throw new Error("Local Whisper production timing requires word_timestamps=true.");
  }
  if (contract.vad_filter !== false) {
    throw new Error("Local Whisper production timing requires vad_filter=false.");
  }
  return contract;
}

export function resolveLocalWhisperRuntimeContractForTests({
  identity = {},
  inputFlags = {},
  env = {},
  revalidateExisting = false,
  existingTiming = null,
} = {}) {
  const identityValidation = validateLocalWhisperIdentityContract(identity);
  if (!identityValidation.done) {
    throw new Error(identityValidation.evidence);
  }
  const locked = identityRequiresLocalWhisperContract(identity);
  if (revalidateExisting) {
    const existingContract = localWhisperContractFromReport(
      existingTiming ?? {},
    );
    if (locked) {
      const nestedMismatches = localWhisperContractMismatches(
        existingContract,
        identityValidation.contract,
      );
      const topLevelMismatches = localWhisperContractMismatches(
        localWhisperTopLevelContractFromReport(existingTiming ?? {}),
        identityValidation.contract,
      ).map((row) => ({
        ...row,
        field: `top_level.${row.field}`,
      }));
      const mismatches = [...nestedMismatches, ...topLevelMismatches];
      if (mismatches.length) {
        throw new Error(
          "Existing Whisper timing contract does not match the locked run "
          + `identity: ${mismatches.map((row) => row.field).join(", ")}.`,
        );
      }
    }
    return existingContract;
  }

  const base = locked
    ? identityValidation.contract
    : productionLocalWhisperContract();
  const flagOverrides = contractOverridesFromFlags(inputFlags);
  if (locked) {
    const requested = normalizeLocalWhisperContract({
      ...base,
      ...flagOverrides,
    });
    const mismatches = localWhisperContractMismatches(requested, base);
    if (mismatches.length) {
      throw new Error(
        "Command flags conflict with the locked local-Whisper contract: "
        + `${mismatches.map((row) => row.field).join(", ")}.`,
      );
    }
    return validateRuntimeContract(normalizeLocalWhisperContract(base));
  }

  const contract = validateRuntimeContract(normalizeLocalWhisperContract({
    ...base,
    ...contractOverridesFromEnv(env),
    ...flagOverrides,
  }));
  if (contract.model === "medium") {
    throw new Error(
      "Whisper medium is not an automatic production fallback. Use the "
      + "manual structural-recovery path with recorded blocker evidence.",
    );
  }
  return contract;
}

export async function runFasterWhisperForDiagnostics(audioPath, contract) {
  const {
    model,
    device,
    compute_type: computeType,
    language,
    omp_num_threads: ompNumThreads,
    cpu_threads: cpuThreads,
    beam_size: beamSize,
    word_timestamps: wordTimestamps,
    vad_filter: vadFilter,
  } = contract;
  const tmpPath = path.join(os.tmpdir(), `goldflow-whisper-${process.pid}-${Date.now()}.json`);
  const py = String.raw`
import json, os, sys
os.environ["OMP_NUM_THREADS"] = sys.argv[6]
from faster_whisper import WhisperModel

audio_path = sys.argv[1]
model_name = sys.argv[2]
device = sys.argv[3]
compute_type = sys.argv[4]
language = sys.argv[5]
omp_num_threads = int(sys.argv[6])
cpu_threads = int(sys.argv[7])
beam_size = int(sys.argv[8])
word_timestamps = sys.argv[9].lower() == "true"
vad_filter = sys.argv[10].lower() == "true"
output_path = sys.argv[11]

model = WhisperModel(
    model_name,
    device=device,
    compute_type=compute_type,
    cpu_threads=cpu_threads,
)
segments, info = model.transcribe(
    audio_path,
    language=language,
    word_timestamps=word_timestamps,
    vad_filter=vad_filter,
    beam_size=beam_size,
)

segment_rows = list(segments)
rows = []
for seg in segment_rows:
    seg_words = []
    for word in (seg.words or []):
        item = {
            "word": word.word.strip(),
            "start_sec": round(float(word.start), 3),
            "end_sec": round(float(word.end), 3),
            "probability": round(float(getattr(word, "probability", 0.0) or 0.0), 4),
        }
        rows.append(item)
        seg_words.append(item)

with open(output_path, "w", encoding="utf-8") as handle:
    json.dump({
    "language": info.language,
    "language_probability": info.language_probability,
    "duration_sec": info.duration,
    "text": " ".join(seg.text.strip() for seg in segment_rows if seg.text.strip()).strip(),
    "words": rows,
    }, handle, ensure_ascii=False)

print(json.dumps({"status": "ok", "word_count": len(rows)}, ensure_ascii=False))
`;
  await new Promise((resolve, reject) => {
    const timeoutMs = Number(process.env.ANIFACTORY_WHISPER_TIMEOUT_MS ?? 7_200_000);
    const child = spawn("python3", [
      "-c",
      py,
      audioPath,
      model,
      device,
      computeType,
      language,
      String(ompNumThreads),
      String(cpuThreads),
      String(beamSize),
      String(wordTimestamps),
      String(vadFilter),
      tmpPath,
    ], {
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        OMP_NUM_THREADS: String(ompNumThreads),
      },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Whisper transcription timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Whisper transcription failed with code ${code ?? "null"} signal ${signal ?? "null"}`));
    });
  });
  const result = JSON.parse(await fs.readFile(tmpPath, "utf8"));
  await fs.rm(tmpPath, { force: true });
  return {
    contract,
    model,
    device,
    compute_type: computeType,
    omp_num_threads: ompNumThreads,
    cpu_threads: cpuThreads,
    language,
    beam_size: beamSize,
    word_timestamps: wordTimestamps,
    vad_filter: vadFilter,
    ...result,
  };
}

function normalizeWord(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function attachSegments(words, qwenReport) {
  const starts = segmentStarts(qwenReport);
  const rows = (qwenReport.segments ?? []).map((segment) => {
    const start = starts.get(String(segment.segment_id)) ?? 0;
    const duration = Number(segment.duration_sec ?? segment.raw_audio_duration_sec ?? 0);
    return {
      segment_id: segment.segment_id,
      start_sec: Number(start.toFixed(3)),
      end_sec: Number((start + duration).toFixed(3)),
      text: segment.stripped_text ?? segment.text ?? "",
    };
  });
  let segmentIndex = 0;
  return words.map((word, index) => {
    while (segmentIndex < rows.length - 1 && word.start_sec > rows[segmentIndex].end_sec + 0.35) segmentIndex += 1;
    const segment = rows[segmentIndex] ?? null;
    return {
      index,
      ...word,
      normalized: normalizeWord(word.word),
      segment_id_guess: segment?.segment_id ?? null,
      segment_start_sec_guess: segment?.start_sec ?? null,
      segment_end_sec_guess: segment?.end_sec ?? null,
    };
  });
}

export function deliveryFirstFullStreamFindingsForTests(transcriptQa) {
  const lowWer = Number(transcriptQa?.word_error_rate ?? 1) <= 0.025;
  return (transcriptQa?.findings ?? []).map((finding) => {
    if (
      lowWer
      && finding?.severity === "blocker"
      && finding.code === "tts_transcript_contiguous_words_missing"
      && Number(finding.longest_deletion_run ?? transcriptQa?.longest_deletion_run ?? 0) <= 5
    ) {
      return {
        ...finding,
        severity: "warning",
        original_severity: "blocker",
        disposition_policy: "delivery_first_low_wer_short_contextual_asr_gap",
      };
    }
    return finding;
  });
}

async function main() {
  const [qwenReport, runIdentity] = await Promise.all([
    readJson(qwenReportPath, null),
    readJson(runIdentityPath, {}),
  ]);
  if (!qwenReport?.segments?.length) throw new Error(`Missing narration stitch report: ${qwenReportPath}`);
  const canonicalContract = identityUsesCanonicalNarrationContract(runIdentity);
  const narrationQualityContract = narrationQualityContractForIdentity(runIdentity);
  const audioPath = narrationAudioPath(qwenReport);
  const [
    scriptHash,
    audioHash,
    narrationReportSha256,
    runIdentitySha256,
  ] = await Promise.all([
    hashFile(scriptPath),
    hashFile(audioPath),
    hashFile(narrationReportPath),
    hashFile(runIdentityPath),
  ]);
  const revalidateExisting = flags["revalidate-existing"] === "true";
  const existingTiming = revalidateExisting ? await readJson(outputPath, null) : null;
  if (revalidateExisting && (
    !Array.isArray(existingTiming?.words)
    || !existingTiming.words.length
    || existingTiming.narration_audio_hash !== audioHash
    || existingTiming.source_script_hash !== scriptHash
  )) {
    throw new Error(
      "Existing Whisper timing cannot be revalidated because its words, "
      + `script hash, or narration hash do not match: ${outputPath}`,
    );
  }
  const runtimeContract = resolveLocalWhisperRuntimeContractForTests({
    identity: runIdentity,
    inputFlags: flags,
    env: process.env,
    revalidateExisting,
    existingTiming,
  });
  const timingCandidatePath = path.resolve(
    flags["timing-candidate"]
      ?? path.join(episodeDir, `narration_word_timing_candidate_${episode}.json`),
  );
  const timingCandidate = revalidateExisting
    ? null
    : await readJson(timingCandidatePath, null);
  const timingCandidateValidation = timingCandidate
    ? validateLocalWhisperTimingCandidate(timingCandidate, {
        contract: runtimeContract,
        sourceScriptSha256: scriptHash,
        narrationAudioSha256: audioHash,
        narrationReportSha256,
        runIdentitySha256,
        narrationQualityContractSha256:
          narrationQualityContract?.contract_sha256 ?? null,
      })
    : null;
  const promotedTimingCandidate = timingCandidateValidation?.status === "passed";
  const transcription = revalidateExisting
    ? {
        contract: runtimeContract,
        model: existingTiming.alignment_model,
        device: existingTiming.alignment_device,
        compute_type: existingTiming.alignment_compute_type,
        omp_num_threads:
          existingTiming.alignment_contract?.omp_num_threads
          ?? existingTiming.alignment_omp_num_threads
          ?? null,
        cpu_threads:
          existingTiming.alignment_contract?.cpu_threads
          ?? existingTiming.alignment_cpu_threads
          ?? null,
        language: existingTiming.language,
        beam_size:
          existingTiming.alignment_contract?.beam_size
          ?? existingTiming.alignment_beam_size
          ?? null,
        word_timestamps:
          existingTiming.alignment_contract?.word_timestamps
          ?? existingTiming.alignment_word_timestamps
          ?? null,
        vad_filter:
          existingTiming.alignment_contract?.vad_filter
          ?? existingTiming.alignment_vad_filter
          ?? null,
        language_probability: existingTiming.language_probability,
        duration_sec: existingTiming.audio_duration_sec,
        words: existingTiming.words.map((word) => ({
          word: word.word,
          start_sec: word.start_sec,
          end_sec: word.end_sec,
          probability: word.probability,
        })),
      }
    : promotedTimingCandidate
      ? {
          contract: runtimeContract,
          model: timingCandidate.alignment_model,
          device: timingCandidate.alignment_device,
          compute_type: timingCandidate.alignment_compute_type,
          omp_num_threads: timingCandidate.alignment_omp_num_threads,
          cpu_threads: timingCandidate.alignment_cpu_threads,
          language: timingCandidate.language,
          beam_size: timingCandidate.alignment_beam_size,
          word_timestamps: timingCandidate.alignment_word_timestamps,
          vad_filter: timingCandidate.alignment_vad_filter,
          language_probability: timingCandidate.language_probability,
          duration_sec: timingCandidate.audio_duration_sec,
          text: timingCandidate.recognized_text,
          words: timingCandidate.words,
        }
      : await runFasterWhisperForDiagnostics(audioPath, runtimeContract);
  const words = attachSegments(transcription.words ?? [], qwenReport);
  const wordTimingQa = localWhisperWordTimingQa(
    words,
    transcription.duration_sec,
  );
  const intendedSpokenText = (qwenReport.segments ?? [])
    .map((segment) => segment.text ?? segment.stripped_text ?? segment.tts_spoken_text ?? "")
    .filter((text) => String(text).trim())
    .join(" ");
  const recognizedText = words.map((word) => word.word).join(" ");
  const canonicalFullStreamQaPath = path.join(
    episodeDir,
    `narration_full_stream_qa_${episode}.json`,
  );
  const canonicalFullStreamQa = narrationQualityContract
    ? await readJson(canonicalFullStreamQaPath, null)
    : null;
  const canonicalFullStreamQaReuse = narrationQualityContract
    ? reusableCanonicalFullStreamQaForTiming({
        artifact: canonicalFullStreamQa,
        sourceScriptHash: scriptHash,
        narrationAudioSha256: audioHash,
        narrationQualityContractSha256:
          narrationQualityContract.contract_sha256,
        runtimeContract,
        alignmentModel: transcription.model,
        recognizedText: transcription.text ?? recognizedText,
        recognizedWords: transcription.words,
      })
    : { status: "not_applicable", findings: [] };
  const asrEquivalentPhrases = (qwenReport.segments ?? []).flatMap((segment) => [
    ...(Array.isArray(segment.asr_equivalent_phrases) ? segment.asr_equivalent_phrases : []),
    ...(Array.isArray(segment.tts_override_replacements_applied)
      ? segment.tts_override_replacements_applied.filter((row) => row?.asr_equivalence_allowed === true)
      : []),
  ]);
  const rawTranscriptIntegrity = transcriptQaForTests(intendedSpokenText, recognizedText, {
    maxWer: 0.05,
    equivalentPhrases: asrEquivalentPhrases,
    blockAnySubstitution: false,
    blockIsolatedEdits: false,
  });
  let strictDeliveryDecision = null;
  let transcriptIntegrity;
  if (narrationQualityContract) {
    strictDeliveryDecision = canonicalFullStreamQaReuse.status === "reusable"
      ? canonicalFullStreamQa.decision
      : strictNarrationDeliveryDecision(rawTranscriptIntegrity, {
          orderQa: { blockers: [] },
          joinQa: qwenReport.join_qa
            ?? qwenReport.boundary_qa
            ?? { blockers: [], warnings: [] },
          contract: narrationQualityContract,
        });
    transcriptIntegrity = {
      ...rawTranscriptIntegrity,
      findings: [
        ...strictDeliveryDecision.blockers,
        ...strictDeliveryDecision.warnings,
      ],
      delivery_first_gate: {
        status: strictDeliveryDecision.status,
        policy: canonicalFullStreamQaReuse.status === "reusable"
          ? "narration_quality_v2_hash_identical_finalizer_consensus"
          : "narration_quality_v2_strict_delivery",
        softened: false,
      },
    };
  } else {
    rawTranscriptIntegrity.findings = deliveryFirstFullStreamFindingsForTests(rawTranscriptIntegrity);
    const softenedTranscriptQa = softenPrimaryQa({
      status: rawTranscriptIntegrity.findings.some((finding) => finding.severity === "blocker")
        ? "blocked"
        : "passed",
      transcript: rawTranscriptIntegrity,
      findings: rawTranscriptIntegrity.findings,
    });
    transcriptIntegrity = {
      ...rawTranscriptIntegrity,
      findings: softenedTranscriptQa.findings,
      delivery_first_gate: softenedTranscriptQa.delivery_first_gate,
    };
  }
  const fullStreamBlockers = narrationQualityContract
    ? strictDeliveryDecision.blockers
    : transcriptIntegrity.findings.filter((finding) => finding.severity === "blocker");
  const fullStreamTranscriptQa = {
    status: words.length && fullStreamBlockers.length === 0 ? "passed" : "blocked",
    policy_version: narrationQualityContract
      ? "narration_full_stream_transcript_v2_strict"
      : "narration_full_stream_transcript_v1",
    intended_text: intendedSpokenText,
    recognized_text: recognizedText,
    alignment_model: transcription.model,
    ...transcriptIntegrity,
    blockers: fullStreamBlockers,
    strict_delivery_decision: strictDeliveryDecision,
    canonical_full_stream_qa_reuse: {
      ...canonicalFullStreamQaReuse,
      path: canonicalFullStreamQaReuse.status === "reusable"
        ? canonicalFullStreamQaPath
        : null,
      sha256: canonicalFullStreamQaReuse.status === "reusable"
        ? await hashFile(canonicalFullStreamQaPath)
        : null,
    },
  };
  const report = {
    ...(!revalidateExisting || existingTiming?.schema
      ? {
          schema: existingTiming?.schema
            ?? "goldflow_local_whisper_word_timing_v2",
        }
      : {}),
    status: words.length
      && wordTimingQa.status === "passed"
      && (!canonicalContract || fullStreamTranscriptQa.status === "passed")
      ? "passed"
      : "failed",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    narration_audio_path: audioPath,
    narration_audio_hash: audioHash,
    narration_report_path: narrationReportPath,
    narration_report_sha256: narrationReportSha256,
    qwen_report_path: qwenReportPath,
    run_identity_path: runIdentityPath,
    run_identity_sha256: runIdentitySha256,
    narration_quality_contract_sha256:
      narrationQualityContract?.contract_sha256 ?? null,
    alignment_contract_version: transcription.contract?.contract_version
      ?? null,
    alignment_engine: "faster_whisper",
    alignment_model: transcription.model,
    alignment_device: transcription.device,
    alignment_compute_type: transcription.compute_type,
    alignment_omp_num_threads: transcription.omp_num_threads,
    alignment_cpu_threads: transcription.cpu_threads,
    alignment_beam_size: transcription.beam_size,
    alignment_word_timestamps: transcription.word_timestamps,
    alignment_vad_filter: transcription.vad_filter,
    ...(!revalidateExisting
      || existingTiming?.alignment_contract
      || identityRequiresLocalWhisperContract(runIdentity)
      ? { alignment_contract: transcription.contract }
      : {}),
    alignment_revalidated_without_transcription: revalidateExisting,
    alignment_promoted_from_finalizer_candidate: promotedTimingCandidate,
    timing_candidate_path: timingCandidate ? timingCandidatePath : null,
    timing_candidate_sha256: promotedTimingCandidate
      ? timingCandidate.candidate_sha256
      : null,
    timing_candidate_validation: timingCandidateValidation,
    language: transcription.language,
    language_probability: transcription.language_probability,
    audio_duration_sec: transcription.duration_sec,
    word_count: words.length,
    source_hashes: Object.fromEntries([
      [scriptPath, scriptHash],
      [audioPath, audioHash],
      [narrationReportPath, narrationReportSha256],
      [runIdentityPath, runIdentitySha256],
    ].filter(([, value]) => Boolean(value))),
    full_stream_transcript_qa: fullStreamTranscriptQa,
    word_timing_qa: wordTimingQa,
    words,
    updated_at: nowIso(),
  };
  await writeJson(outputPath, report);
  if (narrationQualityContract) {
    const firstUnitId = qwenReport.segments?.[0]?.unit_id ?? null;
    const finalUnitId = qwenReport.segments?.at(-1)?.unit_id ?? null;
    const repairBlockers = fullStreamBlockers.map((finding) => ({
      ...finding,
      unit_id: finding.unit_id
        ?? (finding.code === "narration_opening_word_missing" ? firstUnitId : null)
        ?? (finding.code === "narration_final_word_missing" ? finalUnitId : null),
    }));
    const finalDeliveryPath = path.join(
      episodeDir,
      `narration_final_delivery_qa_${episode}.json`,
    );
    await writeJson(finalDeliveryPath, {
      schema: "goldflow_narration_final_delivery_qa_v2",
      status: fullStreamTranscriptQa.status,
      quality_contract_sha256: narrationQualityContract.contract_sha256,
      narration_audio_path: audioPath,
      narration_audio_hash: audioHash,
      source_script_hash: scriptHash,
      transcript_qa: fullStreamTranscriptQa,
      blockers: repairBlockers,
      warnings: strictDeliveryDecision?.warnings ?? [],
      canonical_full_stream_qa_reuse:
        fullStreamTranscriptQa.canonical_full_stream_qa_reuse,
    });
    await writeJson(
      path.join(episodeDir, `narration_final_exact_repair_packet_${episode}.json`),
      exactNarrationRepairPacket({
        decision: {
          status: fullStreamTranscriptQa.status,
          blockers: repairBlockers,
        },
        units: qwenReport.segments ?? [],
        boundaries: qwenReport.boundaries ?? [],
      }),
    );
  }
  console.log(JSON.stringify({
    status: report.status,
    output_path: outputPath,
    word_count: report.word_count,
    source_script_hash: report.source_script_hash,
    narration_audio_hash: report.narration_audio_hash,
    alignment_model: report.alignment_model,
    alignment_device: report.alignment_device,
    alignment_compute_type: report.alignment_compute_type,
    alignment_omp_num_threads: report.alignment_omp_num_threads,
    alignment_cpu_threads: report.alignment_cpu_threads,
    zero_duration_word_count:
      report.word_timing_qa.zero_duration_word_count,
  }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const failurePath = path.join(
      episodeDir,
      `local_whisper_word_timing_failure_${episode}_`
        + `${nowIso().replace(/[^0-9A-Za-z]+/g, "-")}.json`,
    );
    await writeJson(failurePath, {
      schema: "goldflow_local_whisper_word_timing_failure_v1",
      status: "failed",
      intended_output_path: outputPath,
      narration_report_path: narrationReportPath,
      qwen_report_path: qwenReportPath,
      error: error instanceof Error ? error.message : String(error),
      updated_at: nowIso(),
    }).catch(() => {});
    console.error(`Whisper failure report: ${failurePath}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
