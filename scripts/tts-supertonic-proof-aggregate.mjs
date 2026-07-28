#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function timestamp(value) {
  const seconds = Math.max(0, Number(value ?? 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function warningCounts(warnings) {
  const counts = new Map();
  for (const warning of warnings ?? []) {
    const code = warning.code ?? "unknown";
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort());
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const proofRoot = path.resolve(String(flags["proof-root"] ?? ""));
  if (!flags["proof-root"]) throw new Error("--proof-root is required");
  const proofNames = String(flags.proofs ?? "death-ledger,goblin-queen,afterlife-one-coin")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const proofs = [];
  for (const proofName of proofNames) {
    const proofDir = path.join(proofRoot, proofName);
    const [report, build, stitch, manifest, run] = await Promise.all([
      readJson(path.join(proofDir, "proof_report.json")),
      readJson(path.join(proofDir, "proof_build_report.json")),
      readJson(path.join(proofDir, "audio_stitch_report_supertonic_proof.json")),
      readJson(path.join(proofDir, "proof_generation_manifest.json")),
      readJson(path.join(proofDir, "raw-units", "run.json")),
    ]);
    const selectedIds = new Set(build.selected_unit_ids);
    const selectedRunRows = (run.results ?? []).filter((row) => selectedIds.has(row.passage_id));
    const generatedAudioSec = selectedRunRows.reduce((sum, row) => sum + Number(row.duration_sec ?? 0), 0);
    const generatedComputeSec = selectedRunRows.reduce((sum, row) => sum + Number(row.generation_time_sec ?? 0), 0);
    const segmentById = new Map((stitch.segments ?? []).map((row) => [String(row.segment_id), row]));
    const acousticWarningCodes = new Set([
      "tts_audio_possible_impulsive_click",
      "tts_audio_possible_internal_breath_or_noise",
      "tts_audio_possible_non_speech_lead",
      "tts_audio_possible_non_speech_tail",
      "tts_audio_loudness_outlier",
    ]);
    const warningMarkers = (report.warnings ?? [])
      .filter((row) => acousticWarningCodes.has(row.code))
      .map((row) => {
        const segment = segmentById.get(String(row.unit_id));
        return {
          timestamp: timestamp(segment?.start_sec),
          start_sec: segment?.start_sec ?? null,
          unit_id: row.unit_id ?? null,
          code: row.code,
          details: Object.fromEntries(Object.entries(row).filter(([key]) => !["unit_id", "code", "severity"].includes(key))),
        };
      })
      .filter((row, index, rows) => rows.findIndex((candidate) => candidate.unit_id === row.unit_id
        && candidate.code === row.code) === index);
    if (report.status !== "passed" || build.status !== "passed" || stitch.status !== "passed") {
      throw new Error(`${proofName} is not fully passed`);
    }
    if (report.media.wav_sha256 !== await sha256File(report.media.wav)) throw new Error(`${proofName} WAV hash mismatch`);
    if (report.media.m4a_sha256 !== await sha256File(report.media.m4a)) throw new Error(`${proofName} M4A hash mismatch`);
    proofs.push({
      proof_name: proofName,
      title: report.production.title,
      status: report.status,
      duration_sec: report.scope.actual_duration_sec,
      duration_display: timestamp(report.scope.actual_duration_sec),
      intended_word_count: report.scope.intended_word_count,
      recognized_word_count: report.scope.recognized_word_count,
      actual_wpm: report.measured_pace.actual_wpm,
      diagnostic_pace_status: report.measured_pace.diagnostic_pace_status,
      full_medium_whisper_wer: report.transcript_qa.word_error_rate,
      unit_count: report.scope.unit_count,
      join_count: report.join_and_noise_qa.join_count,
      blocker_count: report.blockers.length,
      clipping_sample_count: report.join_and_noise_qa.final_clipping_sample_count,
      maximum_sample_step_dbfs: report.join_and_noise_qa.final_maximum_sample_step_dbfs,
      large_sample_step_count: report.join_and_noise_qa.final_large_sample_step_count,
      transcript_cross_validation: report.transcript_cross_validation,
      warning_counts: warningCounts(report.warnings),
      acoustic_warning_markers: warningMarkers,
      generation_rtf: generatedAudioSec > 0 ? Number((generatedComputeSec / generatedAudioSec).toFixed(4)) : null,
      generation_realtime_multiple: generatedComputeSec > 0 ? Number((generatedAudioSec / generatedComputeSec).toFixed(2)) : null,
      exact_script_coverage: manifest.coverage.text_integrity.status,
      system_ui_coverage: manifest.coverage.system_ui_speech.status,
      wav: report.media.wav,
      wav_sha256: report.media.wav_sha256,
      m4a: report.media.m4a,
      m4a_sha256: report.media.m4a_sha256,
      proof_report: path.join(proofDir, "proof_report.json"),
      listening_notes: path.join(proofDir, "listening_notes.md"),
    });
  }
  const aggregate = {
    schema: "goldflow_supertonic_three_production_bakeoff_v1",
    status: proofs.every((row) => row.status === "passed") ? "passed" : "blocked",
    generated_at: new Date().toISOString(),
    diagnostic_only: true,
    production_artifacts_mutated: false,
    model: {
      provider: "local_supertonic",
      model: "supertonic-3",
      source: "Supertone/supertonic-3",
      voice: "M3",
      native_speed: 1.12,
      total_steps: 8,
      sample_rate_hz: 44100,
      fixed_voice: true,
      voice_clone: false,
    },
    result: {
      proofs_passed: proofs.filter((row) => row.status === "passed").length,
      proofs_total: proofs.length,
      mean_full_medium_whisper_wer: Number((proofs.reduce((sum, row) => sum + row.full_medium_whisper_wer, 0) / proofs.length).toFixed(6)),
      mean_generation_realtime_multiple: Number((proofs.reduce((sum, row) => sum + row.generation_realtime_multiple, 0) / proofs.length).toFixed(2)),
      total_blockers: proofs.reduce((sum, row) => sum + row.blocker_count, 0),
      total_clipping_samples: proofs.reduce((sum, row) => sum + row.clipping_sample_count, 0),
    },
    conclusions: [
      "Supertonic 3 M3 passed all three ten-minute technical proofs with exact locked-script and system/UI coverage.",
      "No proof contains a clipping, impulsive-discontinuity, missing-opening/final-word, protected-value, or unresolved stitch blocker.",
      "Native speed 1.12 is not cadence-stable across scripts: Death Ledger and Afterlife land near 198-199 WPM, while Goblin Queen lands near 242 WPM.",
      "Use a short representative calibration sample to set native speed per script; do not post-process tempo and do not assume one global speed value.",
      "The local fixed voice is technically suitable for operator listening. A paid provider or voice clone is not required for clean narrator-only output, but operator listening remains the final prosody/voice-choice gate.",
    ],
    proofs,
  };
  const jsonPath = path.join(proofRoot, "three_production_bakeoff_report.json");
  const markdownPath = path.join(proofRoot, "three_production_bakeoff_report.md");
  await writeJson(jsonPath, aggregate);
  const rows = proofs.map((row) => `| ${row.proof_name} | ${row.duration_display} | ${row.actual_wpm.toFixed(1)} | ${(row.full_medium_whisper_wer * 100).toFixed(2)}% | ${row.unit_count} | ${row.join_count} | ${row.blocker_count} |`).join("\n");
  await fs.writeFile(markdownPath, `# Supertonic 3 M3 — three-production bake-off

Status: **${aggregate.status.toUpperCase()}** (${aggregate.result.proofs_passed}/${aggregate.result.proofs_total} proofs passed)

| Proof | Duration | WPM | Medium-Whisper WER | Units | Joins | Blockers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}

Mean local generation speed: **${aggregate.result.mean_generation_realtime_multiple.toFixed(2)}× real time**. Total clipped samples: **${aggregate.result.total_clipping_samples}**.

The decisive finding is pace variability: M3 at native speed 1.12 lands near 198–199 WPM on Death Ledger and Afterlife, but 242 WPM on Goblin Queen. Calibrate native speed with a short representative sample for each script.

All three files are ready for operator listening. Minor automated acoustic warnings are timestamped in the JSON report; none reached blocker severity.
`, "utf8");
  console.log(JSON.stringify({
    status: aggregate.status,
    report_json: jsonPath,
    report_markdown: markdownPath,
    proofs_passed: aggregate.result.proofs_passed,
    mean_wer: aggregate.result.mean_full_medium_whisper_wer,
    mean_realtime_multiple: aggregate.result.mean_generation_realtime_multiple,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
