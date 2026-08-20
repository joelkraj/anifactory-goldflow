import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { sha256File } from "./file-hash.mjs";

const execFile = promisify(execFileCallback);

export const FINAL_MASTER_INTEGRITY_SCHEMA = "goldflow_final_master_integrity_v1";

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIntervals(stderr, prefix) {
  const source = String(stderr ?? "");
  const pattern = prefix === "black"
    ? /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g
    : prefix === "silence"
      ? /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g
      : /freeze_start:\s*([\d.]+)[\s\S]*?freeze_duration:\s*([\d.]+)[\s\S]*?freeze_end:\s*([\d.]+)/g;
  return [...source.matchAll(pattern)].map((match) => prefix === "freeze"
    ? { start_sec: number(match[1]), end_sec: number(match[3]), duration_sec: number(match[2]) }
    : { start_sec: number(match[1]), end_sec: number(match[2]), duration_sec: number(match[3]) });
}

function unique(values) {
  return [...new Set(values.map(String))];
}

async function existingHash(filePath) {
  return fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false)
    ? sha256File(filePath)
    : null;
}

function expectedGeneratedMotion(renderReport) {
  const motion = renderReport?.render_motion ?? {};
  return {
    planned_count: number(motion.planned_approved_generated_video_count),
    rendered_count: number(motion.generated_video_clip_count),
    rendered_ids: unique(motion.generated_video_clip_ids ?? []),
    source_hashes: motion.generated_video_source_hashes ?? {},
  };
}

export function renderContractFindingsForTests(renderReport, actualDurationSec) {
  const blockers = [];
  const review = [];
  const expectedDuration = number(renderReport?.output_duration_sec, NaN);
  if (!Number.isFinite(expectedDuration) || Math.abs(expectedDuration - actualDurationSec) > Math.max(0.08, expectedDuration * 0.001)) {
    blockers.push({ code: "master_duration_mismatch", expected_sec: expectedDuration, actual_sec: actualDurationSec });
  }
  if (renderReport?.duration_integrity?.status && renderReport.duration_integrity.status !== "passed") {
    blockers.push({ code: "render_duration_integrity_not_passed", value: renderReport.duration_integrity });
  }
  const generated = expectedGeneratedMotion(renderReport);
  if (generated.rendered_count !== generated.planned_count || generated.rendered_ids.length !== generated.planned_count) {
    blockers.push({
      code: "approved_generated_motion_missing_from_master",
      planned_count: generated.planned_count,
      rendered_count: generated.rendered_count,
      rendered_ids: generated.rendered_ids,
    });
  }
  if (number(renderReport?.render_motion?.motion_trace_blocker_count) > 0) {
    blockers.push({ code: "render_motion_trace_has_blockers", count: number(renderReport.render_motion.motion_trace_blocker_count) });
  }
  if (number(renderReport?.subtitle_count) <= 0) blockers.push({ code: "master_subtitles_missing" });
  if (renderReport?.subtitle_timeline_validated !== true) blockers.push({ code: "subtitle_timeline_not_validated" });
  if (renderReport?.run_identity_schema === "goldflow_run_identity_v2" && renderReport?.subtitle_text_source === "whisper_recognized_words_fallback") {
    blockers.push({ code: "subtitle_text_uses_unapproved_whisper_fallback" });
  }
  const plannedTransitions = number(renderReport?.render_motion?.planned_transition_count);
  const appliedTransitions = number(renderReport?.render_motion?.applied_transition_count);
  const suppressedTransitions = number(renderReport?.render_motion?.suppressed_continuous_ltx_transition_count);
  if (plannedTransitions > appliedTransitions + suppressedTransitions) {
    review.push({
      code: "planned_transition_not_present_in_master",
      planned_count: plannedTransitions,
      applied_count: appliedTransitions,
      intentionally_suppressed_count: suppressedTransitions,
    });
  }
  return { blockers, review, generated };
}

export function parseFinalMasterDiagnosticsForTests({ videoStderr = "", audioStderr = "", durationSec = 0 } = {}) {
  const black_intervals = parseIntervals(videoStderr, "black");
  const freeze_intervals = parseIntervals(videoStderr, "freeze");
  const silence_intervals = parseIntervals(audioStderr, "silence");
  const interior = (row) => row.start_sec > 0.35 && row.end_sec < durationSec - 0.35;
  const review_findings = [
    ...black_intervals.filter((row) => interior(row) && row.duration_sec >= 0.5).map((row) => ({ code: "interior_black_span_detected", ...row })),
    ...freeze_intervals.filter((row) => row.duration_sec >= 2).map((row) => ({ code: "long_frozen_span_detected", ...row })),
    ...silence_intervals.filter((row) => interior(row) && row.duration_sec >= 1.25).map((row) => ({ code: "interior_audio_silence_detected", ...row })),
  ];
  return { black_intervals, freeze_intervals, silence_intervals, review_findings };
}

async function defaultScanner({ ffmpeg, videoPath }) {
  const video = await execFile(ffmpeg, [
    "-hide_banner", "-nostats", "-v", "info", "-xerror",
    "-i", videoPath,
    "-map", "0:v:0",
    "-vf", "blackdetect=d=0.5:pix_th=0.02,freezedetect=n=-50dB:d=2",
    "-an", "-f", "null", "-",
  ], { maxBuffer: 64 * 1024 * 1024 });
  const audio = await execFile(ffmpeg, [
    "-hide_banner", "-nostats", "-v", "info", "-xerror",
    "-i", videoPath,
    "-map", "0:a:0",
    "-af", "silencedetect=noise=-50dB:d=1.25",
    "-vn", "-f", "null", "-",
  ], { maxBuffer: 64 * 1024 * 1024 });
  return { video_stderr: video.stderr, audio_stderr: audio.stderr };
}

export async function buildFinalMasterIntegrity({
  videoPath,
  finalVideoSha256,
  durationSec,
  renderReport,
  renderReportPath,
  outputPath,
  ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg",
  scanner = defaultScanner,
  generatedAt = new Date(),
} = {}) {
  const contract = renderContractFindingsForTests(renderReport, durationSec);
  const blockers = [...contract.blockers];
  const reviewFindings = [...contract.review];
  const generatedSourceChecks = [];
  for (const [sourcePath, expectedSha256] of Object.entries(contract.generated.source_hashes)) {
    const actualSha256 = await existingHash(sourcePath);
    generatedSourceChecks.push({ path: sourcePath, expected_sha256: expectedSha256, actual_sha256: actualSha256 });
    if (!actualSha256 || actualSha256 !== expectedSha256) blockers.push({ code: "generated_motion_source_stale_or_missing", path: sourcePath });
  }
  let scan = null;
  try {
    scan = await scanner({ ffmpeg, videoPath, durationSec });
  } catch (error) {
    blockers.push({ code: "final_master_decode_scan_failed", error: error instanceof Error ? error.message : String(error) });
  }
  const diagnostics = parseFinalMasterDiagnosticsForTests({
    videoStderr: scan?.video_stderr,
    audioStderr: scan?.audio_stderr,
    durationSec,
  });
  reviewFindings.push(...diagnostics.review_findings);
  const artifact = {
    schema: FINAL_MASTER_INTEGRITY_SCHEMA,
    status: blockers.length ? "blocked" : "passed",
    final_video_path: path.resolve(videoPath),
    final_video_sha256: finalVideoSha256,
    render_report_path: renderReportPath ? path.resolve(renderReportPath) : null,
    render_report_sha256: renderReportPath ? await sha256File(renderReportPath) : null,
    duration_sec: durationSec,
    scan_policy: "full_decode_black_freeze_and_silence_scan_v1",
    generated_motion_delivery: {
      ...contract.generated,
      source_hash_checks: generatedSourceChecks,
    },
    diagnostics: {
      black_intervals: diagnostics.black_intervals,
      freeze_intervals: diagnostics.freeze_intervals,
      silence_intervals: diagnostics.silence_intervals,
    },
    blockers,
    review_findings: reviewFindings,
    generated_at: generatedAt.toISOString(),
  };
  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  }
  return artifact;
}
