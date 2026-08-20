#!/usr/bin/env node

import { execFile as execFileCb, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildNarrationQualityContract } from "./lib/narration-quality-contract.mjs";
import {
  adjudicateNarrationDeliveryConsensus,
  exactNarrationListenReviewPacket,
  narrationDeliveryNeedsConfirmation,
  strictNarrationDeliveryDecision,
} from "./lib/narration-delivery-quality.mjs";
import { transcriptQaForTests } from "./modelslab-qwen-episode-audio.mjs";

const execFile = promisify(execFileCb);
const DEFAULT_ROOT = "/Users/joel/AniFactoryData/voice_bank/proofs/2026-08-17-narration-v2-extreme-quality-v1";
const SIMILARITY_PYTHON = "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-speaker-similarity/bin/python";
const SIMILARITY_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "tts-speaker-similarity.py");
const SIMILARITY_MODEL = "/Users/joel/AniFactoryData/voice_bank/bakeoff/model-downloads/wespeaker/wespeaker_en_voxceleb_resnet34.onnx";
const REFERENCE_MANIFEST = "/Users/joel/AniFactoryData/voice_bank/qwen/reference_samples/joel_narrator/manifest.json";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[++index]
      : "true";
    flags[key] = value;
  }
  return flags;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function runPython(script, args, { tolerateFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || tolerateFailure) resolve({ code, stdout, stderr });
      else reject(new Error(`Python exited ${code}: ${stderr.slice(-4000)}`));
    });
  });
}

async function transcribe(rows, outputPath, { model = "small.en" } = {}) {
  const inputPath = `${outputPath}.input.json`;
  const inputs = rows.map((row) => ({
    id: `${row.variant_id}::${row.unit_id}`,
    wav: row.output_path,
  }));
  const expectedIds = inputs.map((row) => row.id).sort();
  const cached = await fs.readFile(outputPath, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (Array.isArray(cached)
    && JSON.stringify(cached.map((row) => row.id).sort()) === JSON.stringify(expectedIds)) {
    return cached;
  }
  await fs.writeFile(inputPath, JSON.stringify(inputs), "utf8");
  const python = String.raw`
import json, sys
from faster_whisper import WhisperModel

input_path, output_path = sys.argv[1:3]
with open(input_path, "r", encoding="utf-8") as handle:
    rows = json.load(handle)
model = WhisperModel(sys.argv[3], device="cpu", compute_type="int8_float32", cpu_threads=0)
output = []
for row in rows:
    segments, info = model.transcribe(
        row["wav"], language="en", word_timestamps=True, vad_filter=False,
        beam_size=5, condition_on_previous_text=False,
    )
    segments = list(segments)
    words = []
    for segment in segments:
        for word in (segment.words or []):
            words.append({
                "word": word.word.strip(),
                "start_sec": round(float(word.start), 3),
                "end_sec": round(float(word.end), 3),
                "probability": round(float(getattr(word, "probability", 0.0) or 0.0), 4),
            })
    output.append({
        "id": row["id"],
        "text": " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip(),
        "words": words,
        "language_probability": float(info.language_probability),
    })
with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(output, handle, ensure_ascii=False, indent=2)
`;
  await runPython(python, [inputPath, outputPath, model]);
  return JSON.parse(await fs.readFile(outputPath, "utf8"));
}

async function pcmMetrics(wavPath) {
  const { stdout } = await execFile("ffmpeg", [
    "-nostdin", "-v", "error", "-i", wavPath,
    "-ac", "1", "-ar", "24000", "-f", "s16le", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 1024 * 1024 * 128 });
  const samples = new Int16Array(Math.floor(stdout.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = stdout.readInt16LE(index * 2);
  }
  const frame = 120;
  let firstActive = samples.length;
  let lastActive = -1;
  for (let start = 0; start < samples.length; start += frame) {
    const end = Math.min(samples.length, start + frame);
    let peak = 0;
    let squares = 0;
    for (let index = start; index < end; index += 1) {
      const value = samples[index] / 32768;
      peak = Math.max(peak, Math.abs(value));
      squares += value * value;
    }
    const rms = Math.sqrt(squares / Math.max(1, end - start));
    if (rms >= 0.00316 || peak >= 0.01259) {
      firstActive = Math.min(firstActive, start);
      lastActive = Math.max(lastActive, end - 1);
    }
  }
  return {
    sample_count: samples.length,
    duration_sec: samples.length / 24000,
    leading_detected_silence_ms: Math.round((firstActive / 24000) * 1000),
    trailing_detected_silence_ms: Math.round(((samples.length - 1 - lastActive) / 24000) * 1000),
    first_sample_abs: samples.length ? Math.abs(samples[0] / 32768) : null,
    final_sample_abs: samples.length ? Math.abs(samples.at(-1) / 32768) : null,
  };
}

function rankTuple(row) {
  return [
    row.delivery_blocker_count,
    row.token_limit_count,
    row.opening_or_final_missing_count,
    row.mean_word_error_rate,
    row.voice_below_minimum_count,
    -row.mean_voice_similarity,
    row.mean_pace_deviation_from_190,
    row.real_time_factor,
  ];
}

function compareTuple(left, right) {
  const a = rankTuple(left);
  const b = rankTuple(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return left.variant_id.localeCompare(right.variant_id);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const phase = flags.phase ?? "screen";
  const proofRoot = path.resolve(flags["proof-root"] ?? DEFAULT_ROOT);
  const generationReportPath = path.resolve(
    flags["generation-report"]
      ?? path.join(proofRoot, phase, "generation_report.json"),
  );
  const outputPath = path.resolve(
    flags.output ?? path.join(proofRoot, phase, "evaluation_report.json"),
  );
  const generation = JSON.parse(await fs.readFile(generationReportPath, "utf8"));
  const referenceManifest = JSON.parse(await fs.readFile(REFERENCE_MANIFEST, "utf8"));
  const flatRows = generation.variants.flatMap((variant) => (
    variant.results.map((row) => ({ ...row, variant_id: variant.id }))
  ));
  const transcriptPath = path.join(path.dirname(outputPath), "whisper_small_en.json");
  const transcripts = await transcribe(flatRows, transcriptPath);
  const transcriptById = new Map(transcripts.map((row) => [row.id, row]));
  const similarityPath = path.join(path.dirname(outputPath), "speaker_similarity_centroid.json");
  const similarityArgs = [
    SIMILARITY_SCRIPT,
    "--model", SIMILARITY_MODEL,
    ...(referenceManifest.references
      ?? referenceManifest.reference_variants
      ?? referenceManifest.samples
      ?? []).flatMap((row) => ["--reference", row.wav_path]),
    ...flatRows.flatMap((row) => ["--candidate", row.output_path]),
    "--output", similarityPath,
    "--minimum-similarity", "0.88",
    "--warning-below-similarity", "0.90",
    "--threshold-mode", "reference_leave_one_out",
    "--calibration-hard-margin", "0.05",
    "--calibration-warning-margin", "0",
    "--calibration-aggregate-margin", "0.03",
    "--reference-voice-id", "joel_owned_narrator_clone",
    "--reference-voice-sha256", "48a7ec7ab4aa2170ae368e3ba1e25964138e4958e7120f8e51f411848def5ecf",
  ];
  let similarity = await fs.readFile(similarityPath, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const expectedSimilarityHashes = new Set(flatRows.map((row) => row.output_sha256));
  const cachedSimilarityHashes = new Set(
    (similarity?.candidates ?? []).map((row) => row.audio_sha256),
  );
  if (similarity?.threshold_mode !== "reference_leave_one_out"
    || expectedSimilarityHashes.size !== cachedSimilarityHashes.size
    || [...expectedSimilarityHashes].some((value) => !cachedSimilarityHashes.has(value))) {
    await execFile(SIMILARITY_PYTHON, similarityArgs, {
      maxBuffer: 1024 * 1024 * 16,
    });
    similarity = JSON.parse(await fs.readFile(similarityPath, "utf8"));
  }
  const similarityByHash = new Map(similarity.candidates.map((row) => [row.audio_sha256, row]));
  const contract = buildNarrationQualityContract({ provider: "qwen_local" });
  const unitContract = {
    ...contract,
      delivery_qa: { ...contract.delivery_qa, maximum_word_error_rate: 0.22 },
  };
  const primaryQaById = new Map();
  const confirmationCandidates = [];
  for (const row of flatRows) {
    const id = `${row.variant_id}::${row.unit_id}`;
    const transcript = transcriptById.get(id);
    const transcriptQa = transcriptQaForTests(row.text, transcript?.text ?? "", {
      maxWer: 0.22,
      blockAnySubstitution: false,
      blockIsolatedEdits: false,
    });
    const primaryDecision = strictNarrationDeliveryDecision(transcriptQa, {
      orderQa: { blockers: [] },
      joinQa: { blockers: [], warnings: [] },
      contract: unitContract,
    });
    primaryQaById.set(id, { transcript, transcriptQa, primaryDecision });
    if (narrationDeliveryNeedsConfirmation(transcriptQa, primaryDecision)) {
      confirmationCandidates.push({
        variant_id: row.variant_id,
        unit_id: row.unit_id,
        output_path: row.output_path,
      });
    }
  }
  const confirmationPath = path.join(path.dirname(outputPath), "whisper_medium_suspects.json");
  const confirmations = confirmationCandidates.length
    ? await transcribe(confirmationCandidates, confirmationPath, { model: "medium" })
    : [];
  const confirmationById = new Map(confirmations.map((row) => [row.id, row]));
  const evaluatedRows = [];
  for (const row of flatRows) {
    const id = `${row.variant_id}::${row.unit_id}`;
    const primary = primaryQaById.get(id);
    const transcript = primary?.transcript ?? null;
    const transcriptQa = primary?.transcriptQa ?? null;
    const confirmation = confirmationById.get(id) ?? null;
    const confirmationTranscriptQa = confirmation
      ? transcriptQaForTests(row.text, confirmation.text, {
      maxWer: 0.22,
      blockAnySubstitution: false,
      blockIsolatedEdits: false,
      })
      : null;
    const decision = adjudicateNarrationDeliveryConsensus({
      primaryTranscriptQa: transcriptQa,
      confirmationTranscriptQa: confirmationCandidates.some(
        (candidate) => `${candidate.variant_id}::${candidate.unit_id}` === id,
      ) ? confirmationTranscriptQa : transcriptQa,
      orderQa: { blockers: [] },
      joinQa: { blockers: [], warnings: [] },
      contract: unitContract,
      primaryModel: "small.en",
      confirmationModel: "medium",
    });
    const metrics = await pcmMetrics(row.output_path);
    const voice = similarityByHash.get(row.output_sha256);
    const words = row.text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
    evaluatedRows.push({
      ...row,
      transcript: transcript ?? null,
      transcript_qa: transcriptQa,
      confirmation_transcript: confirmation,
      confirmation_transcript_qa: confirmationTranscriptQa,
      delivery_decision: decision,
      audio_metrics: metrics,
      voice_similarity: voice ?? null,
      spoken_wpm: Number((words.length / Math.max(metrics.duration_sec, 0.001) * 60).toFixed(3)),
    });
  }
  const variants = generation.variants.map((variant) => {
    const rows = evaluatedRows.filter((row) => row.variant_id === variant.id);
    const wers = rows.map((row) => Number(row.transcript_qa.word_error_rate));
    const voices = rows.map((row) => Number(row.voice_similarity?.cosine_similarity)).filter(Number.isFinite);
    const wpms = rows.map((row) => row.spoken_wpm);
    const blockers = rows.flatMap((row) => row.delivery_decision.blockers.map((finding) => ({
      unit_id: row.unit_id,
      ...finding,
    })));
    return {
      variant_id: variant.id,
      mode: variant.mode,
      generation_parameters: variant.generation_parameters,
      reference_ids: [...new Set(rows.map((row) => row.reference_id))],
      unit_count: rows.length,
      delivery_blocker_count: blockers.length,
      blocked_unit_count: new Set(blockers.map((row) => row.unit_id)).size,
      opening_or_final_missing_count: blockers.filter((row) => [
        "narration_opening_word_missing",
        "narration_final_word_missing",
      ].includes(row.code)).length,
      token_limit_count: rows.filter((row) => row.token_limit_reached).length,
      perfect_transcript_unit_count: rows.filter((row) => row.transcript_qa.word_error_rate === 0).length,
      mean_word_error_rate: Number(mean(wers).toFixed(6)),
      median_word_error_rate: Number(median(wers).toFixed(6)),
      maximum_word_error_rate: Number(Math.max(...wers).toFixed(6)),
      mean_voice_similarity: Number(mean(voices).toFixed(6)),
      minimum_voice_similarity: Number(Math.min(...voices).toFixed(6)),
      voice_below_minimum_count: rows.filter((row) => (
        Number(row.voice_similarity?.cosine_similarity)
          < Number(similarity.minimum_cosine_similarity)
      )).length,
      mean_spoken_wpm: Number(mean(wpms).toFixed(3)),
      median_spoken_wpm: Number(median(wpms).toFixed(3)),
      mean_pace_deviation_from_190: Number(mean(wpms.map((value) => Math.abs(value - 190))).toFixed(3)),
      mean_detected_tail_ms: Number(mean(rows.map((row) => row.audio_metrics.trailing_detected_silence_ms)).toFixed(3)),
      real_time_factor: variant.real_time_factor,
      generation_wall_sec: variant.generation_wall_sec,
      blockers,
      listen_review_unit_count: rows.filter((row) => row.delivery_decision.review_required).length,
      units: rows,
    };
  }).sort(compareTuple).map((row, index) => ({ rank: index + 1, ...row }));
  const listenReviewPacket = exactNarrationListenReviewPacket({
    rows: evaluatedRows.map((row) => ({
      unit_id: `${row.variant_id}::${row.unit_id}`,
      audio_path: row.output_path,
      audio_sha256: row.output_sha256,
      intended_text: row.text,
      primary_recognized_text: row.transcript?.text ?? null,
      confirmation_recognized_text: row.confirmation_transcript?.text ?? null,
      decision: row.delivery_decision,
    })),
    generationPlanSha256: generation.generation_plan_sha256 ?? null,
    qualityContractSha256: contract.contract_sha256,
  });
  const listenReviewPath = path.join(path.dirname(outputPath), "exact_listen_review_packet.json");
  await fs.writeFile(listenReviewPath, `${JSON.stringify(listenReviewPacket, null, 2)}\n`, "utf8");
  const report = {
    schema: "goldflow_narration_v2_bakeoff_evaluation_v1",
    status: "passed_requires_listening",
    phase,
    generation_report_path: generationReportPath,
    generation_report_sha256: sha256(await fs.readFile(generationReportPath)),
    transcript_path: transcriptPath,
    confirmation_transcript_path: confirmationCandidates.length ? confirmationPath : null,
    exact_listen_review_packet_path: listenReviewPath,
    speaker_similarity_path: similarityPath,
    voice_similarity_calibration: {
      threshold_mode: similarity.threshold_mode ?? "fixed",
      minimum_cosine_similarity: similarity.minimum_cosine_similarity,
      warning_below_cosine_similarity: similarity.warning_below_cosine_similarity,
      aggregate_minimum_cosine_similarity:
        similarity.aggregate_minimum_cosine_similarity ?? null,
      reference_calibration: similarity.reference_calibration ?? [],
    },
    quality_contract_sha256: contract.contract_sha256,
    ranking_policy: "Lexicographic: delivery blockers, token limits, missing edges, WER, voice outliers, voice mean, pace deviation, real-time factor. Human delivery preference remains a promotion gate.",
    winner: variants[0]?.variant_id ?? null,
    variants,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  const lines = [
    "# Narration V2 Qwen Bakeoff",
    "",
    `Phase: ${phase}`,
    `Objective winner: ${report.winner}`,
    "",
    "| Rank | Variant | Blockers | Edge misses | Mean WER | Voice mean | Voice min | Below calibrated floor | Mean WPM | RTF |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...variants.map((row) => `| ${row.rank} | ${row.variant_id} | ${row.delivery_blocker_count} | ${row.opening_or_final_missing_count} | ${row.mean_word_error_rate} | ${row.mean_voice_similarity} | ${row.minimum_voice_similarity} | ${row.voice_below_minimum_count} | ${row.mean_spoken_wpm} | ${row.real_time_factor} |`),
    "",
    "Human listening is required before the winning profile is promoted.",
  ];
  await fs.writeFile(markdownPath, `${lines.join("\n")}\n`, "utf8");
  console.log(JSON.stringify({
    status: report.status,
    winner: report.winner,
    report_path: outputPath,
    markdown_path: markdownPath,
    ranking: variants.map((row) => ({
      rank: row.rank,
      variant_id: row.variant_id,
      blockers: row.delivery_blocker_count,
      mean_wer: row.mean_word_error_rate,
      mean_voice_similarity: row.mean_voice_similarity,
      mean_wpm: row.mean_spoken_wpm,
    })),
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
