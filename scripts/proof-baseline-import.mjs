#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  isLegacyQwenIdentity,
  narrationTtsPolicyForIdentity,
} from "./lib/narration-tts-policy.mjs";

const execFile = promisify(execFileCb);
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = flags["episode-dir"] ? path.resolve(flags["episode-dir"]) : path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const baselineEpisodeDir = flags["baseline-episode-dir"] ? path.resolve(flags["baseline-episode-dir"]) : null;
const reportPath = flags.output
  ? path.resolve(flags.output)
  : path.join(episodeDir, `proof_baseline_import_${episode}.json`);

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

function scopedTranscript(words) {
  return (words ?? [])
    .map((row) => String(row?.word ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function scopedApprovedScriptText(scriptText, timingWords, startSec, endSec) {
  const sourceWords = String(scriptText ?? "").match(/\S+/g) ?? [];
  const indexedTimingWords = (timingWords ?? []).map((row, index) => ({
    row,
    index,
  }));
  const inScope = indexedTimingWords.filter(({ row }) => (
    Number(row?.start_sec ?? row?.start ?? 0) < endSec
    && Number(row?.end_sec ?? row?.end ?? 0) > startSec
  ));
  if (!inScope.length) return {
    text: "",
    baseline_word_start_index: null,
    baseline_word_end_index_exclusive: null,
  };
  const startIndex = inScope[0].index;
  const endIndexExclusive = inScope.at(-1).index + 1;
  return {
    text: sourceWords.slice(startIndex, endIndexExclusive).join(" ").trim(),
    baseline_word_start_index: startIndex,
    baseline_word_end_index_exclusive: endIndexExclusive,
  };
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

export function proofBaselineArtifactContractForTests(identity) {
  return isLegacyQwenIdentity(identity) ? "legacy_qwen" : "canonical_narration";
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
  const scriptText = await fs.readFile(scriptPath, "utf8");
  const baselineScriptHash = await fileSha256(baselineScriptPath);
  if (scriptHash !== baselineScriptHash || baselineTiming?.source_script_hash !== scriptHash) throw new Error("Proof script, baseline script, and baseline Whisper timing hashes do not match.");
  const sourceAudioValue = flags["baseline-audio"] ?? baselineAudioPath(baselineAudioReport);
  if (!sourceAudioValue) throw new Error(`Baseline audio report has no usable narration path: ${baselineAudioReportPath}`);
  const sourceAudioPath = path.resolve(sourceAudioValue);
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
  const approvedCaptionScope = scopedApprovedScriptText(
    scriptText,
    baselineTiming.words,
    startSec,
    endSec,
  );
  if (!approvedCaptionScope.text) throw new Error("Locked proof script contains no caption text inside the imported baseline scope.");
  const legacyQwenIdentity = isLegacyQwenIdentity(identity);
  const artifactContract = proofBaselineArtifactContractForTests(identity);
  const narrationPolicy = legacyQwenIdentity ? null : narrationTtsPolicyForIdentity(identity);
  const voiceId = legacyQwenIdentity ? selectedVoiceId(identity) : narrationPolicy.primary.voice_id;
  const nativeSpeed = Number(
    legacyQwenIdentity
      ? identity.qwen_native_speed ?? identity.voice_provider_options?.qwen_native_speed ?? 1.25
      : narrationPolicy.primary.native_speed,
  );
  const overrides = await readJson(path.join(episodeDir, "tts_spoken_overrides.json"), { replacements: [] });
  const importedAt = new Date().toISOString();
  const [
    identityHash,
    baselineTimingHash,
    baselineAudioReportHash,
    baselineAudioHash,
  ] = await Promise.all([
    fileSha256(identityPath),
    fileSha256(baselineTimingPath),
    fileSha256(baselineAudioReportPath),
    fileSha256(sourceAudioPath),
  ]);
  const proofProvenance = {
    mode: "audited_baseline_scope_import",
    artifact_contract: artifactContract,
    target_episode_dir: episodeDir,
    target_identity_path: identityPath,
    target_identity_sha256: identityHash,
    target_script_path: scriptPath,
    target_script_sha256: scriptHash,
    baseline_episode_dir: baselineEpisodeDir,
    baseline_script_path: baselineScriptPath,
    baseline_script_sha256: baselineScriptHash,
    baseline_word_timing_path: baselineTimingPath,
    baseline_word_timing_sha256: baselineTimingHash,
    baseline_audio_report_path: baselineAudioReportPath,
    baseline_audio_report_sha256: baselineAudioReportHash,
    baseline_audio_path: sourceAudioPath,
    baseline_audio_sha256: baselineAudioHash,
    imported_audio_path: outputAudioPath,
    imported_audio_sha256: audioHash,
    imported_audio_duration_sec: audioDuration,
    scope: { start_sec: startSec, end_sec: endSec },
    baseline_word_index_scope: {
      start_index: approvedCaptionScope.baseline_word_start_index,
      end_index_exclusive: approvedCaptionScope.baseline_word_end_index_exclusive,
    },
    provider_calls: 0,
    synthesis_performed: false,
    stitch_performed: false,
    trim_transcode_performed: true,
  };
  const proofProvenanceSha256 = sha256(JSON.stringify(proofProvenance));
  const provenanceFields = {
    proof_baseline_provenance: proofProvenance,
    proof_baseline_provenance_sha256: proofProvenanceSha256,
    proof_baseline_import_report_path: reportPath,
    updated_at: importedAt,
  };
  const transcript = scopedTranscript(words);
  if (!transcript) throw new Error("Baseline Whisper timing contains no speakable word text inside proof scope.");
  const approvedCaptionText = approvedCaptionScope.text;
  const unitId = `proof_import_${sha256(`${scriptHash}\u001f${startSec}\u001f${endSec}`).slice(0, 16)}`;
  const spokenTextHash = sha256(transcript);
  const captionTextHash = sha256(approvedCaptionText);
  const artifactPayloads = new Map();
  const addArtifact = (name, value) => artifactPayloads.set(path.join(episodeDir, name), value);
  const commonVoiceArtifacts = {
    audioPerformance: {
      schema: "goldflow_audio_performance_plan_proof_import_v2",
      status: "passed",
      source_script_hash: scriptHash,
      narrator_only: true,
      artifact_mode: "audited_baseline_import",
      synthesis_performed: false,
      ...provenanceFields,
    },
    voiceStrategy: {
      schema: "goldflow_voice_direction_strategy_proof_import_v2",
      status: "passed",
      source_script_hash: scriptHash,
      artifact_mode: "audited_baseline_import",
      configured_narrator_voice_id: voiceId,
      imported_audio_voice_preserved: true,
      synthesis_performed: false,
      ...provenanceFields,
    },
    referenceCompleteness: {
      schema: "goldflow_voice_reference_completeness_proof_import_v2",
      status: "passed",
      source_script_hash: scriptHash,
      artifact_mode: "audited_baseline_import",
      configured_narrator_voice_id: voiceId,
      reference_requirement: "not_applicable_imported_audited_audio",
      synthesis_performed: false,
      ...provenanceFields,
    },
  };
  addArtifact("audio_performance_plan.json", commonVoiceArtifacts.audioPerformance);
  addArtifact(`voice_direction_strategy_${episode}.json`, commonVoiceArtifacts.voiceStrategy);
  addArtifact("voice_reference_completeness_report.json", commonVoiceArtifacts.referenceCompleteness);

  let narrationReportPath;
  if (legacyQwenIdentity) {
    narrationReportPath = path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
    addArtifact("qwen_generation_plan.json", {
      schema: "goldflow_qwen_generation_plan_proof_import_v1",
      status: "passed",
      source_script_hash: scriptHash,
      source_script_path: scriptPath,
      narrator_only: true,
      segments: [{
        segment_id: "voice_seg_proof_01",
        duration_sec: audioDuration,
        qwen_generation_units: [{
          speaker: "NARRATOR",
          role: "narrator",
          reference_id: voiceId,
          voice_id: voiceId,
        }],
      }],
      tts_override_application_audit: {
        loaded_count: overrides.replacements?.length ?? 0,
        applied_rule_count: 0,
        unmatched_rule_count: 0,
        not_applicable_imported_audio_count: overrides.replacements?.length ?? 0,
      },
      ...provenanceFields,
    });
    addArtifact(`modelslab_qwen_tts_report_${episode}.json`, {
      schema: "goldflow_modelslab_qwen_tts_proof_import_v1",
      status: "passed",
      source_script_hash: scriptHash,
      native_speed: nativeSpeed,
      post_tempo_normalized: false,
      synthesis_performed: false,
      provider_calls: 0,
      results: [{
        segment_id: "voice_seg_proof_01",
        voice_id: voiceId,
        status: "reused_audited_baseline",
        audio_path: outputAudioPath,
        audio_sha256: audioHash,
      }],
      estimated_cost_usd: 0,
      ...provenanceFields,
    });
    addArtifact(`audio_stitch_report_${episode}-modelslab-qwen.json`, {
      schema: "goldflow_audio_stitch_proof_import_v1",
      status: "passed",
      source_script_hash: scriptHash,
      output_path: outputAudioPath,
      output_sha256: audioHash,
      final_audio_path: outputAudioPath,
      final_m4a_path: outputAudioPath,
      final_m4a_sha256: audioHash,
      final_duration_sec: audioDuration,
      duration_sec: audioDuration,
      native_speed: nativeSpeed,
      tempo_normalized: false,
      post_tempo_normalized: false,
      synthesis_performed: false,
      stitch_performed: false,
      segments: [{
        segment_id: "voice_seg_proof_01",
        voice_id: voiceId,
        duration_sec: audioDuration,
        audio_path: outputAudioPath,
      }],
      ...provenanceFields,
    });
  } else {
    narrationReportPath = path.join(episodeDir, `audio_stitch_report_${episode}-narration.json`);
    addArtifact("narration_generation_plan.json", {
      schema: "goldflow_tts_generation_plan_proof_import_v2",
      status: "passed",
      source_script_hash: scriptHash,
      source_script_path: scriptPath,
      narrator_only: true,
      artifact_mode: "audited_baseline_import",
      configured_provider_contract: {
        primary_provider: narrationPolicy.primary.provider,
        fallback_provider: narrationPolicy.fallback?.provider ?? null,
        narrator_voice_id: narrationPolicy.primary.voice_id,
        native_speed: narrationPolicy.primary.native_speed,
      },
      audio_origin: "audited_baseline_episode_artifact",
      synthesis_performed: false,
      provider_calls: 0,
      segments: [{
        segment_id: "voice_seg_proof_01",
        duration_sec: audioDuration,
        narration_units: [{
          unit_id: unitId,
          order_index: 0,
          speaker: "NARRATOR",
          role: "narrator",
          source_unit_refs: [{
            source: "baseline_whisper_scope",
            baseline_word_start_index: approvedCaptionScope.baseline_word_start_index,
            baseline_word_end_index_exclusive: approvedCaptionScope.baseline_word_end_index_exclusive,
          }],
          spoken_text: transcript,
          tts_spoken_text: transcript,
          source_text: approvedCaptionText,
          caption_text: approvedCaptionText,
          spoken_text_sha256: spokenTextHash,
          caption_text_sha256: captionTextHash,
          caption_text_source: "locked_script_projected_by_baseline_word_indices",
          synthesis_route: "imported_audited_baseline",
        }],
      }],
      text_integrity_coverage: {
        status: "passed",
        coverage_mode: "bounded_audited_baseline_import",
        full_script_coverage_claimed: false,
        source_script_hash: scriptHash,
        imported_word_count: words.length,
      },
      system_ui_speech_coverage: {
        status: "passed",
        coverage_mode: "bounded_audited_baseline_import",
        full_script_coverage_claimed: false,
      },
      tts_override_application_audit: {
        loaded_count: overrides.replacements?.length ?? 0,
        applied_rule_count: 0,
        unmatched_rule_count: 0,
        not_applicable_imported_audio_count: overrides.replacements?.length ?? 0,
      },
      ...provenanceFields,
    });
    addArtifact(`narration_tts_unit_qa_${episode}.json`, {
      schema: "goldflow_narration_tts_unit_qa_proof_import_v1",
      status: "passed",
      source_script_hash: scriptHash,
      artifact_mode: "audited_baseline_import",
      qa_mode: "baseline_audio_and_whisper_provenance",
      synthesis_performed: false,
      provider_calls: 0,
      selected_unit_count: 1,
      units: [{
        unit_id: unitId,
        selected_provider: "imported_audited_baseline",
        spoken_text_sha256: spokenTextHash,
        audio_path: outputAudioPath,
        audio_sha256: audioHash,
        status: "passed_imported_baseline",
      }],
      ...provenanceFields,
    });
    addArtifact(`narration_full_stream_qa_${episode}.json`, {
      schema: "goldflow_narration_full_stream_qa_proof_import_v1",
      status: "passed",
      source_script_hash: scriptHash,
      artifact_mode: "audited_baseline_import",
      qa_mode: "baseline_whisper_scope_import",
      synthesis_performed: false,
      provider_calls: 0,
      transcript_source: "baseline_local_whisper_word_timing",
      imported_word_count: words.length,
      audio_path: outputAudioPath,
      audio_sha256: audioHash,
      ...provenanceFields,
    });
    addArtifact(`narration_tts_report_${episode}.json`, {
      schema: "goldflow_narration_tts_report_proof_import_v1",
      status: "passed",
      source_script_hash: scriptHash,
      artifact_mode: "audited_baseline_import",
      audio_origin: "audited_baseline_episode_artifact",
      configured_primary_provider: narrationPolicy.primary.provider,
      configured_fallback_provider: narrationPolicy.fallback?.provider ?? null,
      configured_narrator_voice_id: narrationPolicy.primary.voice_id,
      configured_native_speed: narrationPolicy.primary.native_speed,
      synthesis_performed: false,
      provider_calls: 0,
      estimated_cost_usd: 0,
      unit_qa_status: "passed",
      full_stream_qa_status: "passed",
      expected_unit_count: 1,
      selected_unit_count: 1,
      fallback_unit_ids: [],
      results: [{
        unit_id: unitId,
        selected_provider: "imported_audited_baseline",
        spoken_text_sha256: spokenTextHash,
        selected_spoken_text_sha256: spokenTextHash,
        audio_path: outputAudioPath,
        audio_sha256: audioHash,
        selected_qa: {
          status: "passed",
          mode: "audited_baseline_import",
        },
      }],
      final_m4a: outputAudioPath,
      final_m4a_sha256: audioHash,
      post_tempo_normalized: false,
      ...provenanceFields,
    });
    addArtifact(`audio_stitch_report_${episode}-narration.json`, {
      schema: "goldflow_narration_stitch_report_proof_import_v1",
      status: "passed",
      source_script_hash: scriptHash,
      artifact_mode: "audited_baseline_import",
      audio_origin: "audited_baseline_episode_artifact",
      synthesis_performed: false,
      provider_calls: 0,
      stitch_performed: false,
      trim_transcode_performed: true,
      output_path: outputAudioPath,
      output_sha256: audioHash,
      final_audio_path: outputAudioPath,
      final_m4a_path: outputAudioPath,
      final_m4a_sha256: audioHash,
      final_duration_sec: audioDuration,
      duration_sec: audioDuration,
      stitch_qa_status: "passed",
      full_stream_qa_status: "passed",
      tempo_normalized: false,
      post_tempo_normalized: false,
      segments: [{
        segment_id: "voice_seg_proof_01",
        unit_id: unitId,
        selected_provider: "imported_audited_baseline",
        duration_sec: audioDuration,
        audio_path: outputAudioPath,
        audio_sha256: audioHash,
      }],
      ...provenanceFields,
    });
  }
  addArtifact(`narration_word_timing_${episode}.json`, {
    ...baselineTiming,
    schema: "goldflow_narration_word_timing_proof_import_v2",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    narration_audio_path: outputAudioPath,
    narration_audio_hash: audioHash,
    narration_report_path: narrationReportPath,
    qwen_report_path: narrationReportPath,
    audio_duration_sec: audioDuration,
    word_count: words.length,
    words,
    timing_source: "imported_local_whisper_word_timing",
    synthesis_performed: false,
    provider_calls: 0,
    full_stream_transcript_qa: {
      status: "passed",
      mode: "audited_baseline_scope_import",
      transcript_source: "baseline_local_whisper_word_timing",
      imported_word_count: words.length,
    },
    ...provenanceFields,
  });

  for (const [artifactPath, payload] of artifactPayloads) {
    await writeJson(artifactPath, payload);
  }
  const artifactSha256 = {};
  for (const artifactPath of artifactPayloads.keys()) {
    artifactSha256[path.basename(artifactPath)] = await fileSha256(artifactPath);
  }
  const report = {
    schema: "goldflow_proof_baseline_import_v2",
    status: "passed",
    episode,
    source_script_hash: scriptHash,
    proof_scope: identity.proof_scope,
    artifact_contract: artifactContract,
    synthesis_performed: false,
    provider_calls: 0,
    output_audio_path: outputAudioPath,
    output_audio_sha256: audioHash,
    output_audio_duration_sec: audioDuration,
    imported_word_count: words.length,
    proof_baseline_provenance: proofProvenance,
    proof_baseline_provenance_sha256: proofProvenanceSha256,
    artifacts_written: [...artifactPayloads.keys()].map((artifactPath) => path.basename(artifactPath)),
    artifact_sha256: artifactSha256,
    updated_at: importedAt,
  };
  await writeJson(reportPath, report);
  console.log(JSON.stringify({ status: "passed", report_path: reportPath, output_audio_path: outputAudioPath, duration_sec: audioDuration, word_count: words.length }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeJson(reportPath, { schema: "goldflow_proof_baseline_import_v2", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
