import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildEditorialProofAudio, EDITORIAL_AUDIO_CUES_V1 } from '../lib/true-crime-proof-editorial-audio.mjs';

const RATE = 24000, COUNT = 1545600;
function fixture({ clipping = false, silent = false } = {}) {
  const bytes = Buffer.alloc(44 + COUNT * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(RATE, 24); bytes.writeUInt32LE(RATE * 2, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(COUNT * 2, 40);
  for (let i = 0; i < COUNT; i++) {
    const within = i % RATE;
    const value = silent ? 0 : clipping ? 32767 : within < RATE * 0.65
      ? Math.round(2600 * Math.sin(2 * Math.PI * 197 * i / RATE) + 700 * Math.sin(2 * Math.PI * 347 * i / RATE)) : 0;
    bytes.writeInt16LE(value, 44 + i * 2);
  }
  return bytes;
}
const source = fixture(), sourceBefore = Buffer.from(source);
const result = buildEditorialProofAudio({ narrationWavBytes: source, cues: { ...EDITORIAL_AUDIO_CUES_V1 } });
assert(source.equals(sourceBefore), 'input buffer remains immutable');
assert.equal(result.mixWav.length, source.length);
const recovered = Buffer.alloc(COUNT * 2);
for (let i = 0; i < COUNT; i++) recovered.writeInt16LE(result.mixWav.readInt16LE(44 + i * 2) - result.bedWav.readInt16LE(44 + i * 2), i * 2);
assert(recovered.equals(source.subarray(44)), 'all source samples are preserved in their original positions at unity gain');
assert.equal(result.receipt.source_pcm_sha256, result.receipt.recovered_narration_pcm_sha256);
assert(result.receipt.measurement.active_narration_to_accompaniment_rms_db >= 18);
assert(result.receipt.measurement.active_narration_to_accompaniment_rms_db <= 22);
assert(result.receipt.measurement.quote_underscore_rms_dbfs < result.receipt.measurement.unducked_underscore_target_rms_dbfs - 7.5);
const accentStart = Math.round(EDITORIAL_AUDIO_CUES_V1.accent_start_sec * RATE);
const accentEnd = Math.ceil((EDITORIAL_AUDIO_CUES_V1.accent_start_sec + EDITORIAL_AUDIO_CUES_V1.accent_duration_sec) * RATE);
assert(result.accentWav.subarray(44, 44 + accentStart * 2).every(v => v === 0), 'no premature date accent');
assert(result.accentWav.subarray(44 + accentEnd * 2).every(v => v === 0));
assert.equal(result.bedWav.readInt16LE(44), 0); assert.equal(result.bedWav.readInt16LE(result.bedWav.length - 2), 0);
assert.equal(result.receipt.human_listening_performed, false); assert.equal(result.receipt.production_eligible, false);
const repeated = buildEditorialProofAudio({ narrationWavBytes: source, cues: { ...EDITORIAL_AUDIO_CUES_V1 } });
assert(result.mixWav.equals(repeated.mixWav), 'same source/recipe is deterministic');
assert.equal(result.receipt.mix_wav_sha256, createHash('sha256').update(result.mixWav).digest('hex'));
assert.throws(() => buildEditorialProofAudio({ narrationWavBytes: source, cues: { ...EDITORIAL_AUDIO_CUES_V1, narration_gain: 1.01 } }), /differs/);
const wrongRate = Buffer.from(source); wrongRate.writeUInt32LE(48000, 24);
assert.throws(() => buildEditorialProofAudio({ narrationWavBytes: wrongRate, cues: EDITORIAL_AUDIO_CUES_V1 }), /24|rate|format/);
assert.throws(() => buildEditorialProofAudio({ narrationWavBytes: source, cues: { ...EDITORIAL_AUDIO_CUES_V1, extra: true } }), /fields/);
assert.throws(() => buildEditorialProofAudio({ narrationWavBytes: fixture({ silent: true }), cues: EDITORIAL_AUDIO_CUES_V1 }), /Silent WAV|less than one second/);
assert.throws(() => buildEditorialProofAudio({ narrationWavBytes: fixture({ clipping: true }), cues: EDITORIAL_AUDIO_CUES_V1 }), /would clip/);
console.log('CrimeDungeon editorial audio: exact sample recovery, scoped timing, dip/level, deterministic composition and refusal tests passed.');
