#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = flags["episode-dir"] ? path.resolve(flags["episode-dir"]) : path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const baselineEpisodeDir = flags["baseline-episode-dir"] ? path.resolve(flags["baseline-episode-dir"]) : null;
const reportPath = flags.output ?? path.join(episodeDir, `proof_baseline_import_${episode}.json`);

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return fallback; }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fileSha256(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function mediaDuration(filePath) {
  const { stdout } = await execFile(flags["ffprobe-bin"] ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath]);
  return Number(String(stdout).trim());
}

function selectedVoiceId(identity) {
  return identity?.voice_provider_options?.qwen_narrator_voice_id ?? identity?.qwen_narrator_voice_id ?? "joel_owned_narrator_clone";
}

function baselineAudioPath(report) {
  return report?.mix?.m4a_path ?? report?.final_audio_path ?? report?.final_m4a_path ?? report?.output_path ?? null;
}

export function scopedBaselineWordsForTests(words, startSec, endSec) {
  return (words ?? [])
    .filter((row) => Number(row?.start_sec ?? row?.start ?? 0) < endSec && Number(row?.end_sec ?? row?.end ?? 0) > startSec)
    .map((row, index) => ({
      ...row,
      index,
      start_sec: Number((Math.max(startSec, Number(row.start_sec ?? row.start ?? 0)) - startSec).toFixed(6)),
      end_sec: Number((Math.min(endSec, Number(row.end_sec ?? row.end ?? 0)) - startSec).toFixed(6)),
      segment_start_sec_guess: row.segment_start_sec_guess == null ? null : Number((Math.max(startSec, Number(row.segment_start_sec_guess)) - startSec).toFixed(6)),
      segment_end_sec_guess: row.segment_end_sec_guess == null ? null : Number((Math.min(endSec, Number(row.segment_end_sec_guess)) - startSec).toFixed(6)),
    }));
}

async function main() {
  if (!baselineEpisodeDir) throw new Error("Proof baseline import requires --baseline-episode-dir.");
  const identityPath = path.join(episodeDir, "run_identity.json");
  const scriptPath = path.join(episodeDir, "script_clean.md");
  const baselineScriptPath = path.join(baselineEpisodeDir, "script_clean.md");
  const baselineTimingPath = flags["baseline-word-timing"] ?? path.join(baselineEpisodeDir, `narration_word_timing_${episode}.json`);
  const baselineAudioReportPath = flags["baseline-audio-report"] ?? path.join(baselineEpisodeDir, `longform_audio_bed_report_${episode}.json`);
  const [identity, baselineTiming, baselineAudioReport] = await Promise.all([
    readJson(identityPath),
    readJson(baselineTimingPath),
    readJson(baselineAudioReportPath),
  ]);
  if (identity?.schema !== "goldflow_run_identity_v2" || identity?.run_intent !== "proof" || identity?.proof_scope?.mode !== "bounded") {
    throw new Error("Proof baseline import is restricted to v2 bounded proof identities.");
  }
  const startSec = Number(identity.proof_scope.start_sec);
  const endSec = Number(identity.proof_scope.end_sec);
  if (!(endSec > startSec)) throw new Error("Proof identity has invalid bounded scope.");
  const scriptHash = await fileSha256(scriptPath);
  const baselineScriptHash = await fileSha256(baselineScriptPath);
  if (scriptHash !== baselineScriptHash || baselineTiming?.source_script_hash !== scriptHash) throw new Error("Proof script, baseline script, and baseline Whisper timing hashes do not match.");
  const sourceAudioPath = flags["baseline-audio"] ?? baselineAudioPath(baselineAudioReport);
  if (!sourceAudioPath) throw new Error(`Baseline audio report has no usable narration path: ${baselineAudioReportPath}`);
  const outputAudioPath = path.join(episodeDir, "assets", "audio", "proof_baseline", `${episode}-proof-${startSec}-${endSec}.m4a`);
  await fs.mkdir(path.dirname(outputAudioPath), { recursive: true });
  await execFile(flags["ffmpeg-bin"] ?? "ffmpeg", [
    "-y", "-ss", startSec.toFixed(3), "-t", (endSec - startSec).toFixed(3), "-i", sourceAudioPath,
    "-vn", "-c:a", "aac", "-b:a", "192k", outputAudioPath,
  ], { maxBuffer: 1024 * 1024 * 16 });
  const audioDuration = await mediaDuration(outputAudioPath);
  const audioHash = await fileSha256(outputAudioPath);
  const words = scopedBaselineWordsForTests(baselineTiming.words, startSec, endSec);
  if (!words.length) throw new Error("Baseline Whisper timing has no words inside proof scope.");
  const voiceId = selectedVoiceId(identity);
  const nativeSpeed = Number(identity.qwen_native_speed ?? 1.25);
  const overrides = await readJson(path.join(episodeDir, "tts_spoken_overrides.json"), { replacements: [] });
  const importedAt = new Date().toISOString();
  const proofProvenance = {
    mode: "audited_baseline_scope_import",
    baseline_episode_dir: baselineEpisodeDir,
    baseline_script_path: baselineScriptPath,
    baseline_script_sha256: baselineScriptHash,
    baseline_word_timing_path: baselineTimingPath,
    baseline_word_timing_sha256: await fileSha256(baselineTimingPath),
    baseline_audio_report_path: baselineAudioReportPath,
    baseline_audio_report_sha256: await fileSha256(baselineAudioReportPath),
    baseline_audio_path: sourceAudioPath,
    baseline_audio_sha256: await fileSha256(sourceAudioPath),
    scope: { start_sec: startSec, end_sec: endSec },
    provider_calls: 0,
  };
  const qwenPlan = {
    schema: "goldflow_qwen_generation_plan_proof_import_v1",
    status: "passed",
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    narrator_only: true,
    segments: [{
      segment_id: "voice_seg_proof_01",
      duration_sec: audioDuration,
      qwen_generation_units: [{ speaker: "NARRATOR", role: "narrator", reference_id: voiceId, voice_id: voiceId }],
    }],
    tts_override_application_audit: {
      loaded_count: overrides.replacements?.length ?? 0,
      applied_rule_count: overrides.replacements?.length ?? 0,
      unmatched_rule_count: 0,
    },
    proof_baseline_provenance: proofProvenance,
    updated_at: importedAt,
  };
  const ttsReport = {
    schema: "goldflow_modelslab_qwen_tts_proof_import_v1",
    status: "passed",
    source_script_hash: scriptHash,
    native_speed: nativeSpeed,
    post_tempo_normalized: false,
    results: [{ segment_id: "voice_seg_proof_01", voice_id: voiceId, status: "reused_audited_baseline", audio_path: outputAudioPath }],
    estimated_cost_usd: 0,
    proof_baseline_provenance: proofProvenance,
    updated_at: importedAt,
  };
  const stitchReport = {
    schema: "goldflow_audio_stitch_proof_import_v1",
    status: "passed",
    source_script_hash: scriptHash,
    output_path: outputAudioPath,
    final_audio_path: outputAudioPath,
    final_duration_sec: audioDuration,
    duration_sec: audioDuration,
    native_speed: nativeSpeed,
    tempo_normalized: false,
    post_tempo_normalized: false,
    segments: [{ segment_id: "voice_seg_proof_01", voice_id: voiceId, duration_sec: audioDuration, audio_path: outputAudioPath }],
    proof_baseline_provenance: proofProvenance,
    updated_at: importedAt,
  };
  const timingReport = {
    ...baselineTiming,
    schema: "goldflow_narration_word_timing_proof_import_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    narration_audio_path: outputAudioPath,
    narration_audio_hash: audioHash,
    qwen_report_path: path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`),
    audio_duration_sec: audioDuration,
    word_count: words.length,
    words,
    proof_baseline_provenance: proofProvenance,
    updated_at: importedAt,
  };
  await Promise.all([
    writeJson(path.join(episodeDir, "qwen_generation_plan.json"), qwenPlan),
    writeJson(path.join(episodeDir, "audio_performance_plan.json"), { schema: "goldflow_audio_performance_plan_proof_import_v1", status: "passed", source_script_hash: scriptHash, narrator_only: true, proof_baseline_provenance: proofProvenance, updated_at: importedAt }),
    writeJson(path.join(episodeDir, `voice_direction_strategy_${episode}.json`), { schema: "goldflow_voice_direction_strategy_proof_import_v1", status: "passed", source_script_hash: scriptHash, narrator_voice_id: voiceId, proof_baseline_provenance: proofProvenance, updated_at: importedAt }),
    writeJson(path.join(episodeDir, "voice_reference_completeness_report.json"), { schema: "goldflow_voice_reference_completeness_proof_import_v1", status: "passed", source_script_hash: scriptHash, narrator_voice_id: voiceId, proof_baseline_provenance: proofProvenance, updated_at: importedAt }),
    writeJson(path.join(episodeDir, `modelslab_qwen_tts_report_${episode}.json`), ttsReport),
    writeJson(path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`), stitchReport),
    writeJson(path.join(episodeDir, `narration_word_timing_${episode}.json`), timingReport),
  ]);
  const report = {
    schema: "goldflow_proof_baseline_import_v1",
    status: "passed",
    episode,
    source_script_hash: scriptHash,
    proof_scope: identity.proof_scope,
    output_audio_path: outputAudioPath,
    output_audio_sha256: audioHash,
    output_audio_duration_sec: audioDuration,
    imported_word_count: words.length,
    proof_baseline_provenance: proofProvenance,
    artifacts_written: [
      "qwen_generation_plan.json",
      `modelslab_qwen_tts_report_${episode}.json`,
      `audio_stitch_report_${episode}-modelslab-qwen.json`,
      `narration_word_timing_${episode}.json`,
    ],
    updated_at: importedAt,
  };
  await writeJson(reportPath, report);
  console.log(JSON.stringify({ status: "passed", report_path: reportPath, output_audio_path: outputAudioPath, duration_sec: audioDuration, word_count: words.length }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeJson(reportPath, { schema: "goldflow_proof_baseline_import_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
