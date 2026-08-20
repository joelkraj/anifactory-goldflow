import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { sha256File } from "./file-hash.mjs";

const execFile = promisify(execFileCb);

export const NARRATION_MASTERING_SCHEMA =
  "goldflow_narration_mastering_report_v2";

export const NARRATION_MASTERING_PASSTHROUGH_SCHEMA =
  "goldflow_narration_mastering_passthrough_v2";

function finite(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nearlyEqual(left, right, tolerance = 0.0001) {
  const leftNumber = finite(left);
  const rightNumber = finite(right);
  return leftNumber != null
    && rightNumber != null
    && Math.abs(leftNumber - rightNumber) <= tolerance;
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

export function narrationMasteringPassthroughDecision({
  narrationPath,
  narrationSha256,
  durationSec,
  narrationVolumeDb = 0,
  narrationReport,
  targetLufs = -16,
  truePeakDbtp = -1.5,
  loudnessRange = 11,
  sampleRateHz = 24000,
  channels = 1,
  durationToleranceSec = 0.01,
} = {}) {
  const mastering = narrationReport?.mastering ?? null;
  const policy = mastering?.policy ?? {};
  const probe = mastering?.output_probe ?? {};
  const findings = [];
  const require = (condition, code) => {
    if (!condition) findings.push({ code });
  };

  require(mastering?.status === "passed", "upstream_mastering_not_passed");
  require(
    mastering?.schema === NARRATION_MASTERING_SCHEMA
      || mastering?.schema === NARRATION_MASTERING_PASSTHROUGH_SCHEMA,
    "upstream_mastering_schema_not_supported",
  );
  require(
    mastering?.output_sha256 === narrationSha256,
    "upstream_mastering_output_hash_mismatch",
  );
  require(
    samePath(mastering?.output_path, narrationPath),
    "upstream_mastering_output_path_mismatch",
  );
  require(Number(narrationVolumeDb) === 0, "narration_gain_change_requested");
  require(policy.tempo_processing === false, "upstream_tempo_processing_not_disabled");
  require(policy.broadband_denoise === false, "upstream_denoise_not_disabled");
  require(policy.per_unit_normalization === false, "upstream_per_unit_normalization_not_disabled");
  require(nearlyEqual(policy.target_lufs, targetLufs), "upstream_loudness_target_mismatch");
  require(nearlyEqual(policy.true_peak_dbtp_max, truePeakDbtp), "upstream_true_peak_target_mismatch");
  require(nearlyEqual(policy.loudness_range_target, loudnessRange), "upstream_loudness_range_mismatch");
  require(Number(probe.sample_rate_hz) === Number(sampleRateHz), "upstream_sample_rate_mismatch");
  require(Number(probe.channels) === Number(channels), "upstream_channel_count_mismatch");

  const upstreamDuration = finite(probe.duration_sec);
  const requestedDuration = finite(durationSec);
  require(
    upstreamDuration != null
      && requestedDuration != null
      && Math.abs(upstreamDuration - requestedDuration) <= durationToleranceSec,
    "upstream_duration_mismatch",
  );
  const measuredLufs = finite(mastering?.measured_integrated_lufs);
  const lufsTolerance = finite(policy.integrated_lufs_tolerance, 1);
  require(
    measuredLufs != null && Math.abs(measuredLufs - Number(targetLufs)) <= lufsTolerance,
    "upstream_measured_loudness_out_of_range",
  );
  const measuredTruePeak = finite(mastering?.measured_true_peak_dbtp);
  require(
    measuredTruePeak != null && measuredTruePeak <= Number(truePeakDbtp) + 0.1,
    "upstream_measured_true_peak_out_of_range",
  );

  return {
    status: findings.length ? "not_eligible" : "eligible",
    eligible: findings.length === 0,
    findings,
    mastering,
  };
}

export function narrationRenderMasterReuseDecision({
  audioPath,
  audioSha256,
  audioBedReport,
  targetLufs,
  truePeakDbtp,
  loudnessRange,
} = {}) {
  const mix = audioBedReport?.mix ?? {};
  const findings = [];
  if (audioBedReport?.narration_only !== true || mix.narration_only !== true) {
    findings.push({ code: "audio_bed_is_not_narration_only" });
  }
  if (audioBedReport?.audio_design_enabled === true || mix.audio_design_enabled === true) {
    findings.push({ code: "audio_design_changes_present" });
  }
  if (mix.transition_sfx_enabled === true || Number(mix.transition_sfx_event_count ?? 0) > 0) {
    findings.push({ code: "transition_sfx_changes_present" });
  }
  const masteringDecision = narrationMasteringPassthroughDecision({
    narrationPath: audioPath,
    narrationSha256: audioSha256,
    durationSec: mix.duration_sec,
    narrationVolumeDb: mix.narration_volume_db,
    narrationReport: { mastering: mix.mastering },
    targetLufs,
    truePeakDbtp,
    loudnessRange,
  });
  findings.push(...masteringDecision.findings);
  return {
    status: findings.length ? "not_eligible" : "eligible",
    eligible: findings.length === 0,
    findings,
    mastering: masteringDecision.mastering,
  };
}

function loudnormJson(stderr) {
  const candidates = String(stderr ?? "").match(/\{[\s\S]*?\}/gu) ?? [];
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (Object.hasOwn(parsed, "input_i") && Object.hasOwn(parsed, "input_tp")) {
        return parsed;
      }
    } catch {
      // FFmpeg can emit unrelated brace-delimited diagnostics around the JSON.
    }
  }
  throw new Error("FFmpeg loudnorm did not emit a parseable measurement block.");
}

async function mediaProbe(filePath) {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=sample_rate,channels,codec_name",
    "-of", "json",
    filePath,
  ], { maxBuffer: 1024 * 1024 * 4 });
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0] ?? {};
  return {
    duration_sec: finite(parsed.format?.duration),
    sample_rate_hz: finite(stream.sample_rate),
    channels: finite(stream.channels),
    codec_name: stream.codec_name ?? null,
  };
}

export async function measureNarrationLoudness(inputPath, {
  targetLufs = -16,
  truePeakDbtp = -1.5,
  loudnessRange = 11,
  preFilter = null,
} = {}) {
  const loudnorm = [
    `loudnorm=I=${targetLufs}`,
    `TP=${truePeakDbtp}`,
    `LRA=${loudnessRange}`,
    "print_format=json",
  ].join(":");
  const filter = preFilter ? `${preFilter},${loudnorm}` : loudnorm;
  const { stderr } = await execFile("ffmpeg", [
    "-nostdin", "-hide_banner", "-v", "info",
    "-i", inputPath,
    "-af", filter,
    "-f", "null", "-",
  ], { maxBuffer: 1024 * 1024 * 16 });
  return loudnormJson(stderr);
}

function secondPassFilter(measurement, {
  targetLufs,
  truePeakDbtp,
  loudnessRange,
  preFilter,
}) {
  const loudnorm = [
    `loudnorm=I=${targetLufs}`,
    `TP=${truePeakDbtp}`,
    `LRA=${loudnessRange}`,
    `measured_I=${measurement.input_i}`,
    `measured_LRA=${measurement.input_lra}`,
    `measured_TP=${measurement.input_tp}`,
    `measured_thresh=${measurement.input_thresh}`,
    `offset=${measurement.target_offset}`,
    "linear=true",
    "print_format=json",
  ].join(":");
  return preFilter ? `${preFilter},${loudnorm}` : loudnorm;
}

export async function masterNarrationTwoPass({
  inputPath,
  outputPath,
  reportPath = null,
  targetLufs = -16,
  truePeakDbtp = -1.5,
  loudnessRange = 11,
  sampleRateHz = 24000,
  channels = 1,
  preFilter = null,
  maxDurationSec = null,
  integratedTolerance = 1,
  durationDeltaMsMax = 10,
} = {}) {
  if (!inputPath || !outputPath) {
    throw new Error("Two-pass narration mastering requires inputPath and outputPath.");
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const [inputProbe, inputSha256] = await Promise.all([
    mediaProbe(inputPath),
    sha256File(inputPath),
  ]);
  const boundedDurationSec = Number.isFinite(Number(maxDurationSec))
    && Number(maxDurationSec) > 0
    ? Math.min(Number(maxDurationSec), Number(inputProbe.duration_sec ?? Infinity))
    : null;
  const durationFilter = boundedDurationSec
    ? `atrim=0:${boundedDurationSec.toFixed(6)},asetpts=PTS-STARTPTS`
    : null;
  const outputFormatFilter = channels === 1
    ? `aresample=${sampleRateHz},aformat=channel_layouts=mono`
    : `aresample=${sampleRateHz}`;
  // Measure and normalize the exact channel/sample-rate layout that will be
  // delivered. Measuring stereo and downmixing afterward can shift LUFS by 3 dB.
  const effectivePreFilter = [
    durationFilter,
    outputFormatFilter,
    preFilter,
  ].filter(Boolean).join(",") || null;
  const measurement = await measureNarrationLoudness(inputPath, {
      targetLufs,
      truePeakDbtp,
      loudnessRange,
      preFilter: effectivePreFilter,
    });
  const requiredMeasurementFields = [
    "input_i",
    "input_lra",
    "input_tp",
    "input_thresh",
    "target_offset",
  ];
  const invalidMeasurementFields = requiredMeasurementFields.filter(
    (field) => finite(measurement[field]) == null,
  );
  if (invalidMeasurementFields.length) {
    const expectedDurationSec = boundedDurationSec
      ?? Number(inputProbe.duration_sec ?? 0);
    const report = {
      schema: NARRATION_MASTERING_SCHEMA,
      status: "blocked",
      policy: {
        passes: 2,
        target_lufs: targetLufs,
        integrated_lufs_tolerance: integratedTolerance,
        true_peak_dbtp_max: truePeakDbtp,
        loudness_range_target: loudnessRange,
        sample_rate_hz: sampleRateHz,
        channels,
        tempo_processing: false,
        broadband_denoise: false,
        per_unit_normalization: false,
        max_duration_sec: boundedDurationSec,
      },
      input_path: inputPath,
      input_sha256: inputSha256,
      output_path: outputPath,
      output_sha256: null,
      input_probe: inputProbe,
      output_probe: null,
      expected_output_duration_sec: expectedDurationSec,
      first_pass_measurement: measurement,
      verification_measurement: null,
      measured_integrated_lufs: finite(measurement.input_i),
      measured_true_peak_dbtp: finite(measurement.input_tp),
      duration_delta_ms: null,
      blockers: [{
        code: "narration_master_input_loudness_not_measurable",
        invalid_measurement_fields: invalidMeasurementFields,
        message: "Narration is silent or otherwise lacks a finite loudness measurement; no destructive fallback was applied.",
      }],
    };
    if (reportPath) {
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    return report;
  }
  const filter = secondPassFilter(measurement, {
    targetLufs,
    truePeakDbtp,
    loudnessRange,
    preFilter: effectivePreFilter,
  });
  await execFile("ffmpeg", [
    "-y", "-nostdin", "-hide_banner", "-v", "error",
    "-i", inputPath,
    "-af", filter,
    "-ar", String(sampleRateHz),
    "-ac", String(channels),
    "-acodec", "pcm_s16le",
    outputPath,
  ], { maxBuffer: 1024 * 1024 * 16 });
  const [outputProbe, outputSha256, verification] = await Promise.all([
    mediaProbe(outputPath),
    sha256File(outputPath),
    measureNarrationLoudness(outputPath, {
      targetLufs,
      truePeakDbtp,
      loudnessRange,
    }),
  ]);
  const measuredLufs = finite(verification.input_i);
  const measuredTruePeak = finite(verification.input_tp);
  const expectedDurationSec = boundedDurationSec
    ?? Number(inputProbe.duration_sec ?? 0);
  const durationDeltaMs = Math.abs(
    Number(outputProbe.duration_sec ?? 0) - expectedDurationSec,
  ) * 1000;
  const blockers = [];
  if (measuredLufs == null || Math.abs(measuredLufs - targetLufs) > integratedTolerance) {
    blockers.push({
      code: "narration_master_integrated_loudness_out_of_range",
      measured_lufs: measuredLufs,
      target_lufs: targetLufs,
      tolerance_lu: integratedTolerance,
    });
  }
  if (measuredTruePeak == null || measuredTruePeak > truePeakDbtp + 0.1) {
    blockers.push({
      code: "narration_master_true_peak_exceeded",
      measured_true_peak_dbtp: measuredTruePeak,
      maximum_true_peak_dbtp: truePeakDbtp,
    });
  }
  if (durationDeltaMs > durationDeltaMsMax) {
    blockers.push({
      code: "narration_master_duration_changed",
      duration_delta_ms: Number(durationDeltaMs.toFixed(3)),
      maximum_ms: durationDeltaMsMax,
    });
  }
  if (outputProbe.sample_rate_hz !== sampleRateHz || outputProbe.channels !== channels) {
    blockers.push({
      code: "narration_master_format_mismatch",
      sample_rate_hz: outputProbe.sample_rate_hz,
      required_sample_rate_hz: sampleRateHz,
      channels: outputProbe.channels,
      required_channels: channels,
    });
  }
  const report = {
    schema: NARRATION_MASTERING_SCHEMA,
    status: blockers.length ? "blocked" : "passed",
    policy: {
      passes: 2,
      target_lufs: targetLufs,
      integrated_lufs_tolerance: integratedTolerance,
      true_peak_dbtp_max: truePeakDbtp,
      loudness_range_target: loudnessRange,
      sample_rate_hz: sampleRateHz,
      channels,
      tempo_processing: false,
      broadband_denoise: false,
      per_unit_normalization: false,
      max_duration_sec: boundedDurationSec,
    },
    input_path: inputPath,
    input_sha256: inputSha256,
    output_path: outputPath,
    output_sha256: outputSha256,
    input_probe: inputProbe,
    output_probe: outputProbe,
    expected_output_duration_sec: expectedDurationSec,
    first_pass_measurement: measurement,
    verification_measurement: verification,
    measured_integrated_lufs: measuredLufs,
    measured_true_peak_dbtp: measuredTruePeak,
    duration_delta_ms: Number(durationDeltaMs.toFixed(3)),
    blockers,
  };
  if (reportPath) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}
