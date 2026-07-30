export function assertMuxDurationIntegrity({
  outputDurationSec,
  videoDurationSec,
  audioDurationSec,
  toleranceSec = null,
}) {
  for (const [label, value] of Object.entries({
    output_duration_sec: outputDurationSec,
    video_duration_sec: videoDurationSec,
    audio_duration_sec: audioDurationSec,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Final mux duration integrity requires a positive finite ${label}; received ${value}.`);
    }
  }

  const expectedDurationSec = Math.min(videoDurationSec, audioDurationSec);
  const effectiveToleranceSec = Number.isFinite(toleranceSec)
    ? Math.max(0, toleranceSec)
    : Math.max(1, Math.min(5, expectedDurationSec * 0.001));
  const deltaSec = Math.abs(outputDurationSec - expectedDurationSec);
  if (deltaSec > effectiveToleranceSec) {
    throw new Error(
      `Final mux duration mismatch: output=${outputDurationSec.toFixed(3)}s, `
      + `expected=${expectedDurationSec.toFixed(3)}s from the shorter video/audio input, `
      + `delta=${deltaSec.toFixed(3)}s exceeds tolerance=${effectiveToleranceSec.toFixed(3)}s.`,
    );
  }

  return {
    status: "passed",
    output_duration_sec: outputDurationSec,
    video_duration_sec: videoDurationSec,
    audio_duration_sec: audioDurationSec,
    expected_duration_sec: expectedDurationSec,
    delta_sec: deltaSec,
    tolerance_sec: effectiveToleranceSec,
  };
}
