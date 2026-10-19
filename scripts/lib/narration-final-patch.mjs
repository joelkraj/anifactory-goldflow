// Exact post-render narration patch: replaces reviewed retakes inside each unit's original
// raw-stream window (unit samples + following pause) so every other sample and the picture
// timeline stay fixed. No tempo processing and no amplitude trimming: a retake must fit at full
// length while leaving the minimum pause before the next unit.

export const NARRATION_FINAL_PATCH_SPEC_SCHEMA = "goldflow_narration_final_patch_spec_v1";
export const NARRATION_FINAL_PATCH_RECEIPT_SCHEMA = "goldflow_narration_final_patch_receipt_v1";
export const MIN_PATCH_PAUSE_SAMPLES = 1200; // 50 ms at 24 kHz

export function narrationFinalPatchAdmission(status = {}, flags = {}) {
  const deny = (reason) => ({ allowed: false, reason });
  const keys = Object.keys(flags ?? {});
  if (keys.length !== 2 || !keys.includes("episode-dir") || !keys.includes("spec")) return deny("exact_episode_dir_and_spec_required");
  if (status.identity?.schema !== "goldflow_run_identity_v2" || status.media_workflow?.id !== "generated_visuals_v1") return deny("unsupported_identity_or_workflow");
  if (status.stage_ledger?.find((row) => row.stage === "final_qa")?.state !== "passed") return deny("final_qa_must_be_passed");
  return { allowed: true, reason: "exact_reviewed_post_render_narration_patch" };
}

export function parsePcm16Wav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Narration patch requires a RIFF/WAVE file.");
  }
  let format = null; let data = null;
  for (let at = 12; at + 8 <= buffer.length;) {
    const tag = buffer.toString("ascii", at, at + 4); const size = buffer.readUInt32LE(at + 4);
    if (tag === "fmt ") {
      format = { codec: buffer.readUInt16LE(at + 8), channels: buffer.readUInt16LE(at + 10),
        sampleRate: buffer.readUInt32LE(at + 12), bits: buffer.readUInt16LE(at + 22) };
    }
    if (tag === "data") { data = { offset: at + 8, bytes: Math.min(size, buffer.length - at - 8) }; break; }
    at += 8 + size + (size % 2);
  }
  if (format?.codec !== 1 || format.channels !== 1 || format.bits !== 16 || format.sampleRate !== 24000 || !data) {
    throw new Error("Narration patch requires 24 kHz mono 16-bit PCM.");
  }
  return { ...format, dataOffset: data.offset, dataBytes: data.bytes, samples: data.bytes / 2 };
}

// Cumulative raw-stream sample offsets from the stitch report's unit and pause sample counts.
export function unitWindows(unitSampleCounts, gapSampleCounts) {
  let offset = 0;
  return unitSampleCounts.map((samples, index) => {
    const gap = index < gapSampleCounts.length ? gapSampleCounts[index] : 0;
    const row = { index, offset, unitSamples: samples, gapSamples: gap, windowSamples: samples + gap };
    offset += samples + gap;
    return row;
  });
}

export function validatePlacement(window, retakeSamples, minPause = MIN_PATCH_PAUSE_SAMPLES) {
  if (!Number.isInteger(retakeSamples) || retakeSamples <= 0) throw new Error(`Retake for unit ${window.index} is empty.`);
  if (retakeSamples + minPause > window.windowSamples) {
    throw new Error(`Retake for unit ${window.index} needs ${retakeSamples + minPause} samples; window has ${window.windowSamples}.`);
  }
}

// Returns a new PCM buffer: each placement writes the retake at the unit offset and silence for the
// rest of that unit's window; samples outside the patched windows are byte-identical.
export function spliceRetakes(rawData, placements) {
  const out = Buffer.from(rawData);
  const sorted = [...placements].sort((a, b) => a.window.offset - b.window.offset);
  sorted.forEach((row, i) => {
    validatePlacement(row.window, row.pcm.length / 2);
    const next = sorted[i + 1];
    if (next && row.window.offset + row.window.windowSamples > next.window.offset) throw new Error("Patch windows overlap.");
    const start = row.window.offset * 2; const end = start + row.window.windowSamples * 2;
    if (end > out.length) throw new Error(`Unit ${row.window.index} window exceeds the raw stream.`);
    out.fill(0, start, end);
    row.pcm.copy(out, start);
  });
  return out;
}
