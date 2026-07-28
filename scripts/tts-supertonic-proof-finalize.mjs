#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runUnitOutputQaForDiagnostics,
  stitchWavsForDiagnostics,
} from "./modelslab-qwen-episode-audio.mjs";

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

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function mediaDuration(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return Number(stdout.trim());
}

function preparedDuration(row, edgePadSec) {
  const metrics = row.unit_qa?.metrics ?? {};
  const duration = Number(metrics.duration_sec ?? row.duration_sec ?? 0);
  const leadingTrim = Math.max(0, Number(metrics.leading_silence_sec ?? 0) - edgePadSec);
  const trailingTrim = Math.max(0, Number(metrics.trailing_silence_sec ?? 0) - edgePadSec);
  return Math.max(0, duration - leadingTrim - trailingTrim);
}

function crossesSegment(left, right) {
  const last = String(left.source_segment_ids?.at(-1) ?? left.segment_id ?? "");
  const first = String(right.source_segment_ids?.[0] ?? right.segment_id ?? "");
  return last !== first;
}

function selectThroughTarget(rows, targetSec, { edgePadSec, unitGapSec, segmentGapSec }) {
  let durationSec = 0;
  for (let index = 0; index < rows.length; index += 1) {
    durationSec += preparedDuration(rows[index], edgePadSec);
    if (index < rows.length - 1) {
      durationSec += crossesSegment(rows[index], rows[index + 1]) ? segmentGapSec : unitGapSec;
    }
    if (durationSec >= targetSec) {
      return {
        rows: rows.slice(0, index + 1),
        estimated_duration_sec: Number(durationSec.toFixed(6)),
      };
    }
  }
  throw new Error(`Synthesized lookahead reaches only ${durationSec.toFixed(3)}s; target is ${targetSec}s.`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const proofDir = path.resolve(String(flags["proof-dir"] ?? flags["episode-dir"] ?? ""));
  const manifestPath = path.resolve(String(flags.manifest ?? path.join(proofDir, "proof_generation_manifest.json")));
  const runPath = path.resolve(String(flags.run ?? path.join(proofDir, "raw-units", "run.json")));
  if (!proofDir || proofDir === path.parse(proofDir).root) throw new Error("--proof-dir is required");
  const targetSec = Number(flags["target-sec"] ?? 600);
  const edgePadSec = Number(flags["stitch-edge-pad-sec"] ?? 0.025);
  const unitGapSec = Number(flags["unit-gap-sec"] ?? 0.08);
  const segmentGapSec = Number(flags["segment-gap-sec"] ?? 0.16);
  const manifest = await readJson(manifestPath);
  const synthesisRun = await readJson(runPath);
  if (manifest?.status !== "passed" || !manifest?.diagnostic_only) throw new Error(`Invalid proof manifest: ${manifestPath}`);
  if (synthesisRun?.status !== "passed") throw new Error(`Invalid Supertonic run: ${runPath}`);
  if (synthesisRun.manifest_sha256 !== await sha256File(manifestPath)) {
    throw new Error("Supertonic run was generated from a different proof manifest.");
  }
  const runById = new Map((synthesisRun.results ?? []).map((row) => [String(row.passage_id), row]));
  const asrEquivalencesPath = path.join(proofDir, "proof_asr_equivalences.json");
  const asrEquivalences = await readJson(asrEquivalencesPath, {
    status: "not_configured",
    rules: [],
  });
  if (!["passed", "not_configured"].includes(asrEquivalences.status)) {
    throw new Error(`Proof ASR equivalences are not approved: ${asrEquivalences.status ?? "missing"}`);
  }
  if (asrEquivalences.source_script_hash
    && asrEquivalences.source_script_hash !== manifest.source_artifacts.script_sha256) {
    throw new Error("Proof ASR equivalences are stale for the current locked script.");
  }
  const previousQa = await readJson(path.join(proofDir, "lookahead_unit_qa.json"), null);
  const previousQaById = new Map((previousQa?.units ?? []).map((row) => [String(row.unit_id), row.qa]));
  const rows = [];
  for (const passage of manifest.passages ?? []) {
    const result = runById.get(String(passage.id));
    if (!result) throw new Error(`Missing synthesized passage ${passage.id}`);
    if (result.text !== passage.text) throw new Error(`Synthesized text mismatch for ${passage.id}`);
    if (Number(result.result_chunk_count) !== 1) {
      throw new Error(`Supertonic internally split ${passage.id}; expected exactly one SDK chunk, found ${result.result_chunk_count}`);
    }
    if (Number(result.sample_rate_hz) !== 44100) throw new Error(`Unexpected sample rate for ${passage.id}: ${result.sample_rate_hz}`);
    if (result.output_sha256 !== await sha256File(result.output_path)) throw new Error(`Audio hash mismatch for ${passage.id}`);
    rows.push({
      unit_id: passage.id,
      segment_id: passage.source_segment_ids?.[0] ?? passage.id,
      text: passage.text,
      word_count: passage.word_count,
      wav: result.output_path,
      duration_sec: result.duration_sec,
      source_segment_ids: passage.source_segment_ids,
      source_unit_refs: passage.source_unit_refs,
      source_speakers: passage.source_speakers,
      context_family: passage.context_family ?? "narration",
      speaker: "NARRATOR",
      voice_id: "supertonic3_M3",
      tts_override_replacements_applied: passage.tts_override_replacements_applied ?? [],
      asr_equivalent_phrases: (asrEquivalences.rules ?? [])
        .filter((rule) => (!rule.unit_id || rule.unit_id === passage.id)
          && (!rule.match_text || passage.text.includes(rule.match_text)))
        .map((rule) => ({ from: rule.from, to: rule.to, reason: rule.reason })),
      unit_qa: previousQaById.get(String(passage.id)) ?? null,
    });
  }

  const unitQa = await runUnitOutputQaForDiagnostics(rows);
  const protectedUiOmissions = rows.flatMap((row) => (
    row.context_family === "system_ui" && Number(row.unit_qa?.transcript?.deletions ?? 0) > 0
      ? [{
        unit_id: row.unit_id,
        severity: "blocker",
        code: "tts_transcript_system_ui_word_missing",
        deletion_count: row.unit_qa.transcript.deletions,
        operations: row.unit_qa.transcript.operations.filter((operation) => operation.type === "deletion"),
      }]
      : []
  ));
  if (protectedUiOmissions.length) {
    unitQa.status = "blocked";
    unitQa.blockers.push(...protectedUiOmissions);
    unitQa.blocker_count = unitQa.blockers.length;
    unitQa.blocked_unit_count = new Set(unitQa.blockers.map((row) => row.unit_id)).size;
    unitQa.passed_unit_count = unitQa.unit_count - unitQa.blocked_unit_count;
  }
  await writeJson(path.join(proofDir, "lookahead_unit_qa.json"), {
    ...unitQa,
    schema: "goldflow_supertonic_proof_unit_qa_v1",
    manifest_path: manifestPath,
    manifest_sha256: await sha256File(manifestPath),
    synthesis_run_path: runPath,
    synthesis_run_sha256: await sha256File(runPath),
  });
  if (unitQa.status !== "passed") {
    await writeJson(path.join(proofDir, "proof_build_report.json"), {
      schema: "goldflow_supertonic_proof_build_v1",
      status: "blocked",
      stage: "lookahead_unit_qa",
      blockers: unitQa.blockers,
      retry_passage_ids: [...new Set(unitQa.blockers.map((row) => row.unit_id))],
    });
    throw new Error(`Lookahead unit QA blocked ${unitQa.blocked_unit_count} unit(s): ${[...new Set(unitQa.blockers.map((row) => row.unit_id))].join(", ")}`);
  }

  const selection = selectThroughTarget(rows, targetSec, {
    edgePadSec,
    unitGapSec,
    segmentGapSec,
  });
  const selectedRows = selection.rows;
  const finalWav = path.join(proofDir, "supertonic3_M3_10min_proof.wav");
  const finalM4a = path.join(proofDir, "supertonic3_M3_10min_proof.m4a");
  const stitch = await stitchWavsForDiagnostics(selectedRows, finalWav);
  if (stitch?.status !== "passed") {
    await writeJson(path.join(proofDir, "proof_build_report.json"), {
      schema: "goldflow_supertonic_proof_build_v1",
      status: "blocked",
      stage: "stitch_qa",
      selected_unit_count: selectedRows.length,
      selected_unit_ids: selectedRows.map((row) => row.unit_id),
      stitch,
    });
    throw new Error(`Stitch QA blocked: ${JSON.stringify(stitch?.prepared_qa?.blockers ?? stitch?.final_qa?.blockers ?? [])}`);
  }
  await run("ffmpeg", [
    "-y", "-nostdin", "-v", "error",
    "-i", finalWav,
    "-c:a", "aac",
    "-b:a", "160k",
    finalM4a,
  ]);
  const durationSec = await mediaDuration(finalWav);
  if (durationSec < targetSec) throw new Error(`Final proof is short: ${durationSec.toFixed(3)}s < ${targetSec}s`);
  const intendedText = selectedRows.map((row) => row.text).join(" ");
  await fs.writeFile(path.join(proofDir, "intended_transcript.txt"), `${intendedText}\n`, "utf8");

  const preparedById = new Map(stitch.prepared_inputs.map((row) => [String(row.unit_id), row]));
  const boundaryByAfterId = new Map(stitch.boundaries.map((row) => [String(row.after_unit_id), row]));
  let cursorSec = 0;
  const segments = selectedRows.map((row, index) => {
    const prepared = preparedById.get(String(row.unit_id));
    const boundary = boundaryByAfterId.get(String(row.unit_id));
    const audioDuration = Number(prepared?.prepared_duration_sec ?? row.duration_sec ?? 0);
    const gapDuration = index < selectedRows.length - 1 ? Number(boundary?.inserted_silence_sec ?? 0) : 0;
    const segment = {
      segment_id: row.unit_id,
      text: row.text,
      stripped_text: row.text,
      word_count: row.word_count,
      start_sec: Number(cursorSec.toFixed(6)),
      speech_duration_sec: audioDuration,
      inserted_silence_sec: gapDuration,
      duration_sec: Number((audioDuration + gapDuration).toFixed(6)),
      source_segment_ids: row.source_segment_ids,
      source_unit_refs: row.source_unit_refs,
      audio_path: row.wav,
      prepared_audio_path: prepared?.prepared_wav ?? null,
      unit_qa: row.unit_qa,
    };
    cursorSec += segment.duration_sec;
    return segment;
  });
  const stitchReportPath = path.join(proofDir, "audio_stitch_report_supertonic_proof.json");
  await writeJson(stitchReportPath, {
    schema: "goldflow_supertonic_proof_stitch_report_v1",
    status: "passed",
    diagnostic_only: true,
    provider: "local_supertonic",
    model: "supertonic-3",
    voice: "M3",
    native_speed: 1.12,
    source_script_hash: manifest.source_artifacts.script_sha256,
    output_path: finalWav,
    output_sha256: await sha256File(finalWav),
    output_m4a: finalM4a,
    output_m4a_sha256: await sha256File(finalM4a),
    duration_sec: durationSec,
    target_duration_sec: targetSec,
    unit_count: selectedRows.length,
    word_count: selectedRows.reduce((sum, row) => sum + row.word_count, 0),
    segments,
    stitch,
  });
  await writeJson(path.join(proofDir, "proof_build_report.json"), {
    schema: "goldflow_supertonic_proof_build_v1",
    status: "passed",
    diagnostic_only: true,
    source_episode_dir: manifest.source_episode_dir,
    source_title: manifest.source_identity.title,
    manifest_path: manifestPath,
    synthesis_run_path: runPath,
    selected_unit_count: selectedRows.length,
    selected_unit_ids: selectedRows.map((row) => row.unit_id),
    selected_word_count: selectedRows.reduce((sum, row) => sum + row.word_count, 0),
    estimated_prepared_duration_sec: selection.estimated_duration_sec,
    final_duration_sec: durationSec,
    final_wav: finalWav,
    final_wav_sha256: await sha256File(finalWav),
    final_m4a: finalM4a,
    final_m4a_sha256: await sha256File(finalM4a),
    unit_qa_status: unitQa.status,
    stitch_qa_status: stitch.status,
    stitch_report_path: stitchReportPath,
    proof_asr_equivalences_path: asrEquivalences.status === "passed" ? asrEquivalencesPath : null,
    next_required_check: "full_local_whisper_transcript_and_pace_qa",
  });
  console.log(JSON.stringify({
    status: "passed",
    proof_dir: proofDir,
    duration_sec: durationSec,
    selected_unit_count: selectedRows.length,
    selected_word_count: selectedRows.reduce((sum, row) => sum + row.word_count, 0),
    final_wav: finalWav,
    final_m4a: finalM4a,
    stitch_report_path: stitchReportPath,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
