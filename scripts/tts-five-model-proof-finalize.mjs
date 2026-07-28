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
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[index + 1]
      : "true";
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

function firstSourceSegment(row) {
  return String(row.source_segment_ids?.[0] ?? row.segment_id ?? row.unit_id);
}

function lastSourceSegment(row) {
  return String(row.source_segment_ids?.at(-1) ?? row.segment_id ?? row.unit_id);
}

async function emitBlockedListeningCopy(rows, proofDir, outputStem, maxSec) {
  const selected = [];
  let estimatedSec = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const next = rows[index + 1];
    const gapSec = next
      ? (lastSourceSegment(row) !== firstSourceSegment(next) ? 0.16 : 0.08)
      : 0;
    const candidateSec = estimatedSec + Number(row.duration_sec ?? 0) + gapSec;
    if (selected.length && candidateSec > maxSec) break;
    selected.push({ row, gapSec });
    estimatedSec = candidateSec;
  }
  if (!selected.length) throw new Error("Cannot emit a blocked listening copy without audio rows.");

  const finalWav = path.join(proofDir, `${outputStem}_BLOCKED.wav`);
  const finalM4a = path.join(proofDir, `${outputStem}_BLOCKED.m4a`);
  const inputArgs = selected.flatMap(({ row }) => ["-i", row.wav]);
  const filters = selected.map(({ row, gapSec }, index) => {
    const durationSec = Number(row.duration_sec ?? 0);
    const fadeSec = Math.min(0.008, durationSec / 4);
    const fadeOutStart = Math.max(0, durationSec - fadeSec);
    const pad = gapSec > 0 ? `,apad=pad_dur=${gapSec.toFixed(6)}` : "";
    return `[${index}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono,`
      + `afade=t=in:st=0:d=${fadeSec.toFixed(6)},`
      + `afade=t=out:st=${fadeOutStart.toFixed(6)}:d=${fadeSec.toFixed(6)}`
      + `${pad}[a${index}]`;
  });
  filters.push(
    `${selected.map((_, index) => `[a${index}]`).join("")}`
      + `concat=n=${selected.length}:v=0:a=1[outa]`,
  );
  await run("ffmpeg", [
    "-y", "-nostdin", "-v", "error",
    ...inputArgs,
    "-filter_complex", filters.join(";"),
    "-map", "[outa]",
    "-ar", "44100",
    "-ac", "1",
    "-acodec", "pcm_s16le",
    finalWav,
  ]);
  await run("ffmpeg", [
    "-y", "-nostdin", "-v", "error",
    "-i", finalWav,
    "-c:a", "aac",
    "-b:a", "160k",
    finalM4a,
  ]);
  return {
    status: "blocked_source_failures_preserved",
    certification: "not_production_approved",
    purpose: "operator_listening_only",
    presentation_processing: "8ms edge fades plus 80/160ms joins; no failed speech regenerated",
    selected_unit_ids: selected.map(({ row }) => row.unit_id),
    selected_unit_count: selected.length,
    intended_word_count: selected.reduce(
      (sum, { row }) => sum + Number(row.word_count ?? 0),
      0,
    ),
    duration_sec: await mediaDuration(finalWav),
    final_wav: finalWav,
    final_wav_sha256: await sha256File(finalWav),
    final_m4a: finalM4a,
    final_m4a_sha256: await sha256File(finalM4a),
  };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const proofDir = path.resolve(String(flags["proof-dir"] ?? flags["episode-dir"] ?? ""));
  const manifestPath = path.resolve(String(flags.manifest ?? ""));
  const runPath = path.resolve(String(flags.run ?? ""));
  const outputStem = String(flags["output-stem"] ?? "local_tts_3min_proof")
    .replace(/[^A-Za-z0-9_.-]/g, "_");
  const allowRepairableEdgeBlockers = String(
    flags["allow-repairable-edge-blockers"] ?? "false",
  ).toLowerCase() === "true";
  const emitBlockedCopy = String(
    flags["emit-blocked-listening-copy"] ?? "false",
  ).toLowerCase() === "true";
  const blockedCopyMaxSec = Number(flags["blocked-listening-max-sec"] ?? 190);
  if (!flags["proof-dir"] && !flags["episode-dir"]) throw new Error("--proof-dir is required");
  if (!flags.manifest) throw new Error("--manifest is required");
  if (!flags.run) throw new Error("--run is required");
  if (proofDir === path.parse(proofDir).root) throw new Error("Refusing root proof directory");

  const [manifest, synthesisRun] = await Promise.all([
    readJson(manifestPath),
    readJson(runPath),
  ]);
  if (manifest?.status !== "passed" || !manifest?.diagnostic_only) {
    throw new Error(`Invalid diagnostic proof manifest: ${manifestPath}`);
  }
  if (synthesisRun?.status !== "passed") {
    throw new Error(`Invalid synthesis run: ${runPath}`);
  }
  if (synthesisRun.manifest_sha256 !== await sha256File(manifestPath)) {
    throw new Error("Synthesis run was generated from a different manifest hash.");
  }

  await fs.mkdir(proofDir, { recursive: true });
  const equivalencePath = path.resolve(String(
    flags["asr-equivalences"]
      ?? path.join(proofDir, "proof_asr_equivalences.json"),
  ));
  const equivalences = await readJson(equivalencePath, {
    status: "not_configured",
    rules: [],
  });
  if (!["passed", "not_configured"].includes(equivalences.status)) {
    throw new Error(`Invalid ASR equivalence artifact: ${equivalencePath}`);
  }
  if (equivalences.source_script_hash
    && equivalences.source_script_hash !== manifest.source_artifacts.script_sha256) {
    throw new Error("ASR equivalences are stale for the locked script.");
  }

  const previousQa = await readJson(path.join(proofDir, "unit_qa.json"), null);
  const previousQaById = new Map(
    (previousQa?.units ?? []).map((row) => [String(row.unit_id), row.qa]),
  );
  const runById = new Map(
    (synthesisRun.results ?? []).map((row) => [String(row.passage_id), row]),
  );
  const rows = [];
  for (const passage of manifest.passages ?? []) {
    const result = runById.get(String(passage.id));
    if (!result) throw new Error(`Missing synthesized passage ${passage.id}`);
    if (String(result.text) !== String(passage.text)) {
      throw new Error(`Synthesized text mismatch for ${passage.id}`);
    }
    if (!result.output_path || result.output_sha256 !== await sha256File(result.output_path)) {
      throw new Error(`Audio integrity mismatch for ${passage.id}`);
    }
    rows.push({
      unit_id: passage.id,
      segment_id: passage.source_segment_ids?.[0] ?? passage.id,
      text: passage.text,
      word_count: passage.word_count,
      wav: result.output_path,
      duration_sec: result.duration_sec,
      sample_rate_hz: result.sample_rate_hz,
      source_segment_ids: passage.source_segment_ids,
      source_unit_refs: passage.source_unit_refs,
      source_speakers: passage.source_speakers,
      context_family: passage.context_family ?? "narration",
      speaker: "NARRATOR",
      voice_id: synthesisRun.preset_voice
        ?? synthesisRun.model_id
        ?? synthesisRun.model_name
        ?? synthesisRun.model_kind,
      tts_override_replacements_applied: passage.tts_override_replacements_applied ?? [],
      asr_equivalent_phrases: (equivalences.rules ?? [])
        .filter((rule) => (!rule.unit_id || rule.unit_id === passage.id)
          && (!rule.match_text || passage.text.includes(rule.match_text)))
        .map((rule) => ({ from: rule.from, to: rule.to, reason: rule.reason })),
      unit_qa: previousQaById.get(String(passage.id)) ?? null,
    });
  }

  const unitQa = await runUnitOutputQaForDiagnostics(rows);
  const edgeRepairs = [];
  if (allowRepairableEdgeBlockers) {
    const repairableCodes = new Set([
      "tts_audio_tail_not_settled",
      "tts_audio_endpoint_discontinuity",
    ]);
    for (const row of rows) {
      const findings = row.unit_qa?.findings ?? [];
      for (const finding of findings) {
        if (finding.severity !== "blocker" || !repairableCodes.has(finding.code)) continue;
        const reportedLevels = [
          Number(finding.tail_10ms_peak_dbfs),
          Number(finding.tail_50ms_rms_dbfs),
          Number(finding.last_sample_dbfs),
        ].filter(Number.isFinite);
        if (reportedLevels.length && Math.max(...reportedLevels) > -18) continue;
        finding.original_severity = "blocker";
        finding.severity = "warning";
        finding.repair_policy = "prepared_stitch_input_8ms_fade_to_zero_plus_60ms_zero_pad";
        edgeRepairs.push({
          unit_id: row.unit_id,
          code: finding.code,
          repair_policy: finding.repair_policy,
          reported_levels_dbfs: reportedLevels,
        });
      }
      const remainingBlockers = findings.filter((finding) => finding.severity === "blocker");
      row.unit_qa.status = remainingBlockers.length
        ? "blocked"
        : findings.length
          ? "passed_with_warnings"
          : "passed";
    }
    unitQa.blockers = rows.flatMap((row) => (row.unit_qa?.findings ?? [])
      .filter((finding) => finding.severity === "blocker")
      .map((finding) => ({ unit_id: row.unit_id, ...finding })));
    unitQa.warnings = rows.flatMap((row) => (row.unit_qa?.findings ?? [])
      .filter((finding) => finding.severity === "warning")
      .map((finding) => ({ unit_id: row.unit_id, ...finding })));
    unitQa.blocker_count = unitQa.blockers.length;
    unitQa.warning_count = unitQa.warnings.length;
    unitQa.blocked_unit_count = rows.filter((row) => row.unit_qa?.status === "blocked").length;
    unitQa.passed_unit_count = rows.length - unitQa.blocked_unit_count;
    unitQa.status = unitQa.blocker_count ? "blocked" : "passed";
  }
  const systemUiBlockers = rows.flatMap((row) => (
    row.context_family === "system_ui"
      && Number(row.unit_qa?.transcript?.deletions ?? 0) > 0
      ? [{
        unit_id: row.unit_id,
        severity: "blocker",
        code: "tts_transcript_system_ui_word_missing",
        deletion_count: row.unit_qa.transcript.deletions,
      }]
      : []
  ));
  if (systemUiBlockers.length) {
    unitQa.status = "blocked";
    unitQa.blockers.push(...systemUiBlockers);
    unitQa.blocker_count = unitQa.blockers.length;
    unitQa.blocked_unit_count = new Set(unitQa.blockers.map((row) => row.unit_id)).size;
    unitQa.passed_unit_count = unitQa.unit_count - unitQa.blocked_unit_count;
  }
  const unitQaPath = path.join(proofDir, "unit_qa.json");
  await writeJson(unitQaPath, {
    ...unitQa,
    schema: "goldflow_five_model_proof_unit_qa_v1",
    manifest_path: manifestPath,
    manifest_sha256: await sha256File(manifestPath),
    synthesis_run_path: runPath,
    synthesis_run_sha256: await sha256File(runPath),
  });
  if (unitQa.status !== "passed") {
    const retryIds = [...new Set(unitQa.blockers.map((row) => row.unit_id))];
    const blockedListeningCopy = emitBlockedCopy
      ? await emitBlockedListeningCopy(rows, proofDir, outputStem, blockedCopyMaxSec)
      : null;
    await writeJson(path.join(proofDir, "proof_build_report.json"), {
      schema: "goldflow_five_model_proof_build_v1",
      status: "blocked",
      stage: "unit_qa",
      model_id: synthesisRun.model_id,
      retry_passage_ids: retryIds,
      blockers: unitQa.blockers,
      blocked_listening_copy: blockedListeningCopy,
    });
    throw new Error(`Unit QA blocked ${retryIds.length} passage(s): ${retryIds.join(", ")}`);
  }

  const finalWav = path.join(proofDir, `${outputStem}.wav`);
  const finalM4a = path.join(proofDir, `${outputStem}.m4a`);
  const stitch = await stitchWavsForDiagnostics(rows, finalWav, {
    repairTailUnitIds: new Set(edgeRepairs.map((row) => String(row.unit_id))),
    repairTailSilenceSec: 0.06,
  });
  if (stitch?.status !== "passed") {
    await writeJson(path.join(proofDir, "proof_build_report.json"), {
      schema: "goldflow_five_model_proof_build_v1",
      status: "blocked",
      stage: "stitch_qa",
      model_id: synthesisRun.model_id,
      stitch,
    });
    throw new Error(`Stitch QA blocked ${synthesisRun.model_id}`);
  }
  await run("ffmpeg", [
    "-y", "-nostdin", "-v", "error",
    "-i", finalWav,
    "-c:a", "aac",
    "-b:a", "160k",
    finalM4a,
  ]);
  const durationSec = await mediaDuration(finalWav);
  const intendedText = rows.map((row) => row.text).join(" ");
  await fs.writeFile(path.join(proofDir, "intended_transcript.txt"), `${intendedText}\n`, "utf8");

  const preparedById = new Map(
    (stitch.prepared_inputs ?? []).map((row) => [String(row.unit_id), row]),
  );
  const boundaryByAfterId = new Map(
    (stitch.boundaries ?? []).map((row) => [String(row.after_unit_id), row]),
  );
  let cursorSec = 0;
  const segments = rows.map((row, index) => {
    const prepared = preparedById.get(String(row.unit_id));
    const boundary = boundaryByAfterId.get(String(row.unit_id));
    const speechDuration = Number(prepared?.prepared_duration_sec ?? row.duration_sec ?? 0);
    const insertedSilence = index < rows.length - 1
      ? Number(boundary?.inserted_silence_sec ?? 0)
      : 0;
    const segment = {
      unit_id: row.unit_id,
      text: row.text,
      start_sec: Number(cursorSec.toFixed(6)),
      speech_duration_sec: speechDuration,
      inserted_silence_sec: insertedSilence,
      duration_sec: Number((speechDuration + insertedSilence).toFixed(6)),
      source_segment_ids: row.source_segment_ids,
      crosses_segment_after: index < rows.length - 1
        ? lastSourceSegment(row) !== firstSourceSegment(rows[index + 1])
        : false,
      raw_audio_path: row.wav,
      prepared_audio_path: prepared?.prepared_wav ?? null,
      unit_qa: row.unit_qa,
    };
    cursorSec += segment.duration_sec;
    return segment;
  });
  const report = {
    schema: "goldflow_five_model_three_minute_proof_v1",
    status: "passed",
    diagnostic_only: true,
    production_artifacts_mutated: false,
    generated_at: new Date().toISOString(),
    source_episode_dir: manifest.source_episode_dir,
    source_title: manifest.source_identity?.title,
    source_script_hash: manifest.source_artifacts.script_sha256,
    manifest_path: manifestPath,
    manifest_sha256: await sha256File(manifestPath),
    synthesis_run_path: runPath,
    synthesis_run_sha256: await sha256File(runPath),
    model: {
      model_id: synthesisRun.model_id,
      model_kind: synthesisRun.model_kind,
      model_name: synthesisRun.model_name ?? synthesisRun.model_id,
      model_source: synthesisRun.model_source ?? synthesisRun.model_path,
      model_path: synthesisRun.model_path ?? null,
      voice_mode: synthesisRun.voice_mode,
      preset_voice: synthesisRun.preset_voice,
      reference_audio_path: synthesisRun.reference_audio_path,
      reference_audio_sha256: synthesisRun.reference_audio_sha256,
      runtime: synthesisRun.runtime ?? null,
      generation_parameters: synthesisRun.model_native_generation_parameters
        ?? synthesisRun.output_conditioning
        ?? null,
    },
    intended_word_count: rows.reduce((sum, row) => sum + Number(row.word_count ?? 0), 0),
    unit_count: rows.length,
    join_count: Math.max(0, rows.length - 1),
    duration_sec: durationSec,
    raw_generation_audio_sec: synthesisRun.total_audio_duration_sec,
    total_generation_time_sec: synthesisRun.total_generation_time_sec,
    generation_rtf: Number(synthesisRun.total_generation_time_sec)
      / Number(synthesisRun.total_audio_duration_sec),
    generation_realtime_multiple: Number(synthesisRun.total_generation_time_sec) > 0
      ? Number(synthesisRun.total_audio_duration_sec)
        / Number(synthesisRun.total_generation_time_sec)
      : null,
    final_wav: finalWav,
    final_wav_sha256: await sha256File(finalWav),
    final_m4a: finalM4a,
    final_m4a_sha256: await sha256File(finalM4a),
    unit_qa_path: unitQaPath,
    unit_qa: unitQa,
    repairable_raw_edge_blockers_allowed: allowRepairableEdgeBlockers,
    raw_edge_repairs: edgeRepairs,
    stitch,
    segments,
  };
  const reportPath = path.join(proofDir, "proof_report.json");
  await writeJson(reportPath, report);
  await writeJson(path.join(proofDir, "proof_build_report.json"), {
    schema: "goldflow_five_model_proof_build_v1",
    status: "passed",
    diagnostic_only: true,
    model_id: synthesisRun.model_id,
    unit_qa_status: unitQa.status,
    stitch_qa_status: stitch.status,
    final_duration_sec: durationSec,
    final_wav: finalWav,
    final_m4a: finalM4a,
    proof_report_path: reportPath,
    next_required_check: "full_stream_medium_whisper_and_bakeoff_aggregation",
  });
  console.log(JSON.stringify({
    status: "passed",
    model_id: synthesisRun.model_id,
    duration_sec: durationSec,
    unit_count: rows.length,
    final_m4a: finalM4a,
    report_path: reportPath,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
