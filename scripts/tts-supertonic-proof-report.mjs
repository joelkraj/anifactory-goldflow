#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transcriptQaForTests } from "./modelslab-qwen-episode-audio.mjs";

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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function mediaProbe(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size,bit_rate:stream=codec_name,sample_rate,channels",
    "-of", "json",
    filePath,
  ]);
  return JSON.parse(stdout);
}

function findingCodes(rows) {
  return [...new Set((rows ?? []).map((row) => row.code).filter(Boolean))];
}

function normalizedWords(value) {
  return (String(value ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []).join(" ");
}

function contiguousDeletionRuns(operations) {
  const runs = [];
  let current = [];
  for (const operation of operations ?? []) {
    if (operation.type === "deletion") current.push(operation.intended);
    else if (current.length) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const proofDir = path.resolve(String(flags["proof-dir"] ?? flags["episode-dir"] ?? ""));
  if (!proofDir || proofDir === path.parse(proofDir).root) throw new Error("--proof-dir is required");
  const manifest = await readJson(path.join(proofDir, "proof_generation_manifest.json"));
  const build = await readJson(path.join(proofDir, "proof_build_report.json"));
  const stitchReport = await readJson(path.join(proofDir, "audio_stitch_report_supertonic_proof.json"));
  const timingPath = path.resolve(String(flags.timing ?? path.join(proofDir, "narration_word_timing_supertonic_proof.json")));
  const pacePath = path.resolve(String(flags.pace ?? path.join(proofDir, "narration_pace_report_supertonic_proof.json")));
  const timing = await readJson(timingPath);
  const pace = await readJson(pacePath);
  const intendedText = (await fs.readFile(path.join(proofDir, "intended_transcript.txt"), "utf8")).trim();
  const recognizedText = (timing.words ?? []).map((row) => row.word).join(" ").replace(/\s+/g, " ").trim();
  await fs.writeFile(path.join(proofDir, "recognized_transcript.txt"), `${recognizedText}\n`, "utf8");
  const transcriptQa = transcriptQaForTests(intendedText, recognizedText);
  const transcriptBlockers = transcriptQa.findings.filter((row) => row.severity === "blocker");
  const preparedQaById = new Map((stitchReport.stitch?.prepared_qa?.units ?? [])
    .map((row) => [String(row.unit_id), row]));
  const deletionEvidence = contiguousDeletionRuns(transcriptQa.operations)
    .filter((tokens) => tokens.length >= 2)
    .map((tokens) => {
      const phrase = tokens.join(" ");
      const segment = (stitchReport.segments ?? []).find((row) => normalizedWords(row.text).includes(phrase));
      const rawRecognized = segment?.unit_qa?.transcript?.recognized_text ?? "";
      const preparedRecognized = preparedQaById.get(String(segment?.segment_id))?.transcript?.recognized_text ?? "";
      return {
        phrase,
        deletion_word_count: tokens.length,
        source_unit_id: segment?.segment_id ?? null,
        raw_unit_asr_recognized_text: rawRecognized || null,
        prepared_unit_asr_recognized_text: preparedRecognized || null,
        confirmed_in_raw_unit_asr: normalizedWords(rawRecognized).includes(phrase),
        confirmed_in_prepared_unit_asr: normalizedWords(preparedRecognized).includes(phrase),
      };
    });
  const contiguousTranscriptBlockers = transcriptBlockers
    .filter((row) => row.code === "tts_transcript_contiguous_words_missing");
  const fullStreamAsrCrossValidated = contiguousTranscriptBlockers.length > 0
    && transcriptQa.word_error_rate <= 0.03
    && deletionEvidence.length > 0
    && deletionEvidence.every((row) => row.confirmed_in_raw_unit_asr && row.confirmed_in_prepared_unit_asr)
    && stitchReport.stitch?.prepared_qa?.status === "passed";
  const effectiveTranscriptBlockers = transcriptBlockers
    .filter((row) => !(fullStreamAsrCrossValidated && row.code === "tts_transcript_contiguous_words_missing"));
  const durationSec = Number(stitchReport.duration_sec ?? timing.audio_duration_sec ?? 0);
  const durationPassed = durationSec >= 600 && durationSec <= 620;
  const unitQa = await readJson(path.join(proofDir, "lookahead_unit_qa.json"));
  const warnings = [
    ...(unitQa.warnings ?? []),
    ...(stitchReport.stitch?.prepared_qa?.units ?? []).flatMap((row) => row.findings ?? [])
      .filter((row) => row.severity === "warning"),
    ...(stitchReport.stitch?.final_qa?.acoustic_findings ?? []).filter((row) => row.severity === "warning"),
    ...transcriptQa.findings.filter((row) => row.severity === "warning"),
  ];
  const blockers = [
    ...(unitQa.blockers ?? []),
    ...(stitchReport.stitch?.prepared_qa?.blockers ?? []),
    ...(stitchReport.stitch?.final_qa?.blockers ?? []),
    ...effectiveTranscriptBlockers,
  ];
  if (!durationPassed) blockers.push({
    severity: "blocker",
    code: "proof_duration_outside_10_minute_boundary_window",
    duration_sec: durationSec,
    allowed_min_sec: 600,
    allowed_max_sec: 620,
  });
  if (build.status !== "passed") blockers.push({ severity: "blocker", code: "proof_build_not_passed" });
  if (timing.status !== "passed") blockers.push({ severity: "blocker", code: "full_whisper_timing_not_passed" });
  if (pace.status !== "passed") blockers.push({ severity: "blocker", code: "pace_report_not_passed" });
  const [wavProbe, m4aProbe] = await Promise.all([
    mediaProbe(build.final_wav),
    mediaProbe(build.final_m4a),
  ]);
  const status = blockers.length ? "blocked" : "passed";
  const report = {
    schema: "goldflow_supertonic_ten_minute_proof_report_v1",
    status,
    diagnostic_only: true,
    generated_at: new Date().toISOString(),
    production_artifacts_mutated: false,
    production: manifest.source_identity,
    model: {
      provider: "local_supertonic",
      model: "supertonic-3",
      source: "Supertone/supertonic-3",
      voice: "M3",
      native_speed: 1.12,
      total_steps: 8,
      voice_clone: false,
    },
    scope: {
      target_duration_sec: 600,
      actual_duration_sec: durationSec,
      unit_count: build.selected_unit_count,
      intended_word_count: build.selected_word_count,
      recognized_word_count: timing.word_count,
    },
    coverage: manifest.coverage,
    transcript_qa: transcriptQa,
    transcript_cross_validation: {
      status: fullStreamAsrCrossValidated ? "passed_full_stream_asr_false_negative" : "not_needed_or_not_confirmed",
      full_stream_blockers_cross_validated: fullStreamAsrCrossValidated,
      evidence: deletionEvidence,
      policy: "A full-stream contiguous-deletion finding is treated as an ASR alignment false negative only when both raw-unit and post-trim prepared-unit ASR independently contain the exact missing phrase, every prepared unit passes, and full-stream WER is at most three percent.",
    },
    measured_pace: {
      actual_wpm: pace.actual_wpm,
      target_wpm_min: pace.target_wpm_min,
      target_wpm_max: pace.target_wpm_max,
      diagnostic_pace_status: pace.diagnostic_pace_status,
    },
    join_and_noise_qa: {
      unit_qa_status: unitQa.status,
      unit_blocker_count: unitQa.blocker_count,
      stitch_status: stitchReport.stitch.status,
      prepared_stitch_status: stitchReport.stitch.prepared_qa?.status,
      final_stitch_status: stitchReport.stitch.final_qa?.status,
      join_count: stitchReport.stitch.boundaries?.length ?? 0,
      final_clipping_sample_count: stitchReport.stitch.final_qa?.metrics?.clipping_sample_count ?? null,
      final_maximum_sample_step_dbfs: stitchReport.stitch.final_qa?.metrics?.maximum_sample_step_dbfs ?? null,
      final_large_sample_step_count: stitchReport.stitch.final_qa?.metrics?.large_sample_step_count ?? null,
      warning_codes: findingCodes(warnings),
    },
    whisper: {
      engine: timing.alignment_engine,
      model: timing.alignment_model,
      language: timing.language,
      language_probability: timing.language_probability,
      timing_path: timingPath,
    },
    media: {
      wav: build.final_wav,
      wav_sha256: build.final_wav_sha256,
      wav_probe: wavProbe,
      m4a: build.final_m4a,
      m4a_sha256: build.final_m4a_sha256,
      m4a_probe: m4aProbe,
      intended_transcript: path.join(proofDir, "intended_transcript.txt"),
      recognized_transcript: path.join(proofDir, "recognized_transcript.txt"),
    },
    warnings,
    blockers,
    interpretation: {
      clean_audio_and_join_gate: blockers.length ? "not_passed" : "passed",
      coherence_evidence: "Exact locked-script coverage plus full-proof Whisper transcript fidelity; subjective prosody remains for operator listening.",
      production_recommendation: status === "passed"
        ? "Suitable for operator listening and direct comparison with the current production narrator. Do not replace production audio until the operator accepts the fixed voice."
        : "Do not promote; inspect and repair the named blockers first.",
    },
  };
  await writeJson(path.join(proofDir, "proof_report.json"), report);
  const markdown = `# ${manifest.source_identity.title}

Status: **${status.toUpperCase()}**

- Audio: \`${build.final_m4a}\`
- Duration: ${durationSec.toFixed(3)} seconds
- Intended / recognized words: ${build.selected_word_count} / ${timing.word_count}
- Full-proof Whisper WER: ${(transcriptQa.word_error_rate * 100).toFixed(2)}%
- Measured pace: ${Number(pace.actual_wpm).toFixed(1)} WPM
- Units / joins: ${build.selected_unit_count} / ${stitchReport.stitch.boundaries?.length ?? 0}
- Unit, prepared-stitch, final-stitch blockers: ${unitQa.blocker_count} / ${stitchReport.stitch.prepared_qa?.blockers?.length ?? 0} / ${stitchReport.stitch.final_qa?.blockers?.length ?? 0}
- Clipped samples: ${stitchReport.stitch.final_qa?.metrics?.clipping_sample_count ?? "n/a"}
- Warning codes: ${findingCodes(warnings).join(", ") || "none"}

This is an isolated diagnostic proof generated from a fresh exact-coverage plan. The production episode was not changed.
`;
  await fs.writeFile(path.join(proofDir, "listening_notes.md"), markdown, "utf8");
  console.log(JSON.stringify({
    status,
    proof_report: path.join(proofDir, "proof_report.json"),
    listening_notes: path.join(proofDir, "listening_notes.md"),
    duration_sec: durationSec,
    actual_wpm: pace.actual_wpm,
    word_error_rate: transcriptQa.word_error_rate,
    blocker_count: blockers.length,
    warning_codes: findingCodes(warnings),
  }, null, 2));
  if (status !== "passed") process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
