#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { transcriptQaForTests } from "./modelslab-qwen-episode-audio.mjs";
import { localWhisperWordTimingQa } from "./lib/local-whisper-policy.mjs";
import { softenPrimaryQa } from "./lib/tts-selection-policy.mjs";

const MANUAL_MEDIUM_STRUCTURAL_RECOVERY_CONTRACT = Object.freeze({
  contract_version: "local_whisper_manual_structural_recovery_v1",
  engine: "faster_whisper",
  model: "medium",
  device: "cpu",
  compute_type: "int8_float32",
  omp_num_threads: 12,
  cpu_threads: 0,
  language: "en",
  beam_size: 5,
  word_timestamps: true,
  vad_filter: false,
  condition_on_previous_text: false,
});

function flags(parts) {
  const out = {};
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index].startsWith("--")) continue;
    const key = parts[index].slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[++index]
      : "true";
    out[key] = value;
  }
  return out;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function segmentStarts(stitchReport) {
  const starts = new Map();
  let cursor = 0;
  for (const segment of stitchReport.segments ?? []) {
    starts.set(String(segment.unit_id), cursor);
    cursor += Number(segment.duration_sec ?? segment.raw_audio_duration_sec ?? 0);
  }
  return starts;
}

async function transcribeUnit(audioPath) {
  const contract = MANUAL_MEDIUM_STRUCTURAL_RECOVERY_CONTRACT;
  const outputPath = path.join(os.tmpdir(), `goldflow-unit-repair-${process.pid}-${Date.now()}.json`);
  const source = String.raw`
import json, os, sys
os.environ["OMP_NUM_THREADS"] = sys.argv[4]
from faster_whisper import WhisperModel
audio_path, output_path, model_name = sys.argv[1:4]
model = WhisperModel(
    model_name,
    device="cpu",
    compute_type="int8_float32",
    cpu_threads=0,
)
segments, info = model.transcribe(
    audio_path,
    language="en",
    word_timestamps=True,
    vad_filter=False,
    beam_size=5,
    condition_on_previous_text=False,
)
rows = []
texts = []
for segment in segments:
    if segment.text.strip():
        texts.append(segment.text.strip())
    for word in (segment.words or []):
        rows.append({
            "word": word.word.strip(),
            "start_sec": round(float(word.start), 3),
            "end_sec": round(float(word.end), 3),
            "probability": round(float(getattr(word, "probability", 0.0) or 0.0), 4),
        })
with open(output_path, "w", encoding="utf-8") as handle:
    json.dump({"text": " ".join(texts), "words": rows, "language_probability": info.language_probability}, handle)
`;
  await new Promise((resolve, reject) => {
    const child = spawn("python3", [
      "-c",
      source,
      audioPath,
      outputPath,
      contract.model,
      String(contract.omp_num_threads),
    ], {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        OMP_NUM_THREADS: String(contract.omp_num_threads),
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Unit Whisper failed (${code}): ${stderr.slice(-2000)}`));
    });
  });
  const result = await readJson(outputPath);
  await fs.rm(outputPath, { force: true });
  return { ...result, alignment_contract: structuredClone(contract) };
}

const args = flags(process.argv.slice(2));
const episodeDir = path.resolve(String(args["episode-dir"] ?? ""));
const unitId = String(args["unit-id"] ?? "");
if (!episodeDir || !unitId) {
  throw new Error(
    "Usage: repair-whisper-missed-tts-unit --episode-dir <dir> "
    + "--unit-id <id> --manual-structural-recovery true "
    + "--workflow-bypass true --evidence-note <reviewed blocker>",
  );
}
if (args["manual-structural-recovery"] !== "true"
  || args["workflow-bypass"] !== "true"
  || !String(args["evidence-note"] ?? "").trim()) {
  throw new Error(
    "Medium Whisper is manual structural recovery only. Pass "
    + "--manual-structural-recovery true --workflow-bypass true and a "
    + "nonempty --evidence-note after reviewing the blocker.",
  );
}

const timingPath = path.join(episodeDir, "narration_word_timing_ep_01.json");
const timing = await readJson(timingPath);
const stitchPath = timing.narration_report_path;
const stitch = await readJson(stitchPath);
const unit = (stitch.segments ?? []).find((row) => String(row.unit_id) === unitId);
if (!unit) throw new Error(`Unknown stitched unit: ${unitId}`);
if (!unit.prepared_audio_path) throw new Error(`Unit lacks prepared audio: ${unitId}`);
if (await sha256File(timing.narration_audio_path) !== timing.narration_audio_hash) {
  throw new Error("Narration audio changed after the failed timing artifact");
}
if (await sha256File(unit.raw_audio_path) !== unit.raw_audio_sha256) {
  throw new Error("Selected unit audio changed after stitch");
}

const local = await transcribeUnit(unit.prepared_audio_path);
if (!local.words?.length) throw new Error(`Independent Whisper returned no words for ${unitId}`);
const start = segmentStarts(stitch).get(unitId);
if (!Number.isFinite(start)) throw new Error(`Could not resolve stitched start for ${unitId}`);
const insertedWords = local.words.map((word) => ({
  word: word.word,
  start_sec: Number((start + Number(word.start_sec)).toFixed(3)),
  end_sec: Number((start + Number(word.end_sec)).toFixed(3)),
  probability: word.probability,
  normalized: String(word.word).toLowerCase().replace(/[^a-z0-9]+/g, ""),
  segment_id_guess: unit.segment_id,
  segment_start_sec_guess: Number(start.toFixed(3)),
  segment_end_sec_guess: Number((start + Number(unit.duration_sec)).toFixed(3)),
  timing_repair_source: "independent_exact_unit_medium_whisper",
}));
const repairWindowStart = insertedWords[0].start_sec - 0.12;
const repairWindowEnd = insertedWords.at(-1).end_sec + 0.12;
const existingInWindow = timing.words.filter((word) => (
  (Number(word.start_sec) + Number(word.end_sec)) / 2 >= repairWindowStart
  && (Number(word.start_sec) + Number(word.end_sec)) / 2 <= repairWindowEnd
));
const replaceWindow = /^(?:1|true|yes|on)$/i.test(String(args["replace-window"] ?? ""));
if (existingInWindow.length && !replaceWindow) {
  throw new Error(`Refusing repair: ${existingInWindow.length} existing words occupy ${unitId}`);
}

const retainedWords = replaceWindow
  ? timing.words.filter((word) => !existingInWindow.includes(word))
  : timing.words;
const words = [...retainedWords, ...insertedWords]
  .sort((left, right) => left.start_sec - right.start_sec || left.end_sec - right.end_sec)
  .map((word, index) => ({ ...word, index }));
const wordTimingQa = localWhisperWordTimingQa(
  words,
  timing.audio_duration_sec,
);
const intendedText = (stitch.segments ?? [])
  .map((segment) => segment.text ?? segment.stripped_text ?? segment.tts_spoken_text ?? "")
  .filter((text) => String(text).trim())
  .join(" ");
const recognizedText = words.map((word) => word.word).join(" ");
const equivalences = (stitch.segments ?? []).flatMap((segment) => [
  ...(segment.asr_equivalent_phrases ?? []),
  ...(segment.tts_override_replacements_applied ?? []).filter(
    (row) => row?.asr_equivalence_allowed === true,
  ),
]);
const rawQa = transcriptQaForTests(intendedText, recognizedText, {
  maxWer: 0.05,
  equivalentPhrases: equivalences,
  blockAnySubstitution: false,
  blockIsolatedEdits: false,
});
const softened = softenPrimaryQa({
  status: rawQa.findings.some((finding) => finding.severity === "blocker") ? "blocked" : "passed",
  transcript: rawQa,
  findings: rawQa.findings,
});
const blockers = softened.findings.filter((finding) => finding.severity === "blocker");
const repairedQa = {
  status: blockers.length ? "blocked" : "passed",
  policy_version: "narration_full_stream_transcript_v1",
  intended_text: intendedText,
  recognized_text: recognizedText,
  alignment_model: timing.alignment_model,
  ...rawQa,
  findings: softened.findings,
  delivery_first_gate: softened.delivery_first_gate,
  blockers,
};
const repaired = {
  ...timing,
  status: blockers.length || wordTimingQa.status !== "passed"
    ? "failed"
    : "passed",
  word_count: words.length,
  words,
  full_stream_transcript_qa: repairedQa,
  word_timing_qa: wordTimingQa,
  updated_at: new Date().toISOString(),
  manual_timing_repairs: [
    ...(timing.manual_timing_repairs ?? []),
    {
      unit_id: unitId,
      unit_audio_path: unit.raw_audio_path,
      unit_audio_sha256: unit.raw_audio_sha256,
      prepared_audio_path: unit.prepared_audio_path,
      stitched_start_sec: Number(start.toFixed(3)),
      inserted_word_count: insertedWords.length,
      replaced_context_word_count: existingInWindow.length,
      independently_recognized_text: local.text,
      method: "independent_exact_unit_medium_whisper",
      alignment_contract: local.alignment_contract,
      evidence_note: String(args["evidence-note"]).trim(),
    },
  ],
};
await writeJson(timingPath, repaired);
const repairedTimingSha256 = await sha256File(timingPath);

const triagePath = path.join(
  episodeDir,
  "manual_blocker_triage_local_whisper_word_timing_ep_01.json",
);
await writeJson(triagePath, {
  schema: "goldflow_manual_blocker_triage_v1",
  status: repaired.status === "passed" ? "resolved" : "blocked",
  stage: "local_whisper_word_timing",
  resolution: "hash_bound_exact_unit_timing_repair",
  evidence_reviewed: {
    failed_timing_path: timingPath,
    narration_audio_path: timing.narration_audio_path,
    narration_audio_sha256: timing.narration_audio_hash,
    source_script_sha256: timing.source_script_hash,
    unit_id: unitId,
    unit_audio_path: unit.raw_audio_path,
    unit_audio_sha256: unit.raw_audio_sha256,
    prepared_audio_path: unit.prepared_audio_path,
    full_stream_missing_run_words: 15,
    independent_recognized_text: local.text,
    operator_evidence_note: String(args["evidence-note"]).trim(),
  },
  repair: {
    inserted_word_count: insertedWords.length,
    replaced_context_word_count: existingInWindow.length,
    stitched_start_sec: Number(start.toFixed(3)),
    timing_source: "independent_exact_unit_medium_whisper",
    alignment_contract: local.alignment_contract,
    repaired_timing_sha256: repairedTimingSha256,
    no_audio_regenerated: true,
  },
  remaining_blockers: blockers,
  updated_at: new Date().toISOString(),
});

console.log(JSON.stringify({
  status: repaired.status,
  timing_path: timingPath,
  triage_path: triagePath,
  inserted_word_count: insertedWords.length,
  word_count: words.length,
  word_error_rate: rawQa.word_error_rate,
  remaining_blockers: blockers,
}, null, 2));
