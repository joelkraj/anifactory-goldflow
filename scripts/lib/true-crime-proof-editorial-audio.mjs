import { createHash } from 'node:crypto';
import { inspectTrueCrimeProofWav } from './true-crime-proof-narration.mjs';

const RATE = 24000;
const SAMPLE_COUNT = 1545600;
const TAU = Math.PI * 2;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (condition, message) => {
  if (!condition) throw new Error(`CrimeDungeon editorial audio: ${message}`);
};
const gain = db => 10 ** (db / 20);
const dbfs = rms => rms > 0 ? 20 * Math.log10(rms) : null;
const smooth = x => Math.sin(Math.max(0, Math.min(1, x)) * Math.PI / 2) ** 2;

// This is an original, explicitly authored score recipe, not a measured or
// extracted reference-channel score. The guarded revision must bind it before
// calling this pure helper. No model, provider, network or file I/O occurs here.
export const EDITORIAL_AUDIO_CUES_V1 = Object.freeze({
  schema: 'goldflow_true_crime_editorial_audio_cues_v1',
  duration_sec: 64.4,
  sample_rate_hz: RATE,
  channels: 1,
  narration_gain: 1,
  narration_tempo: 1,
  composition: 'original_procedural_underscore_v1',
  seed: 1129467187,
  oscillator_frequencies_hz: '110,109.78,220,329.628,440',
  oscillator_amplitudes: '0.62,0.12,0.21,0.05,0.04',
  texture: 'seeded xorshift32 noise; first-order low-pass 650 Hz minus low-pass 95 Hz; amplitude 0.12',
  accent: 'single authored 190-to-145 Hz soft tone glide with second-harmonic amplitude 0.2; no event imitation',
  bed_below_active_narration_rms_db: 20,
  measurement_window_sec: 0.1,
  measurement_gate_dbfs: -42,
  fade_in_sec: 0.35,
  fade_out_sec: 1.6,
  quote_dip_start_sec: 826 / 30,
  quote_dip_end_sec: 951 / 30,
  quote_dip_db: 9,
  quote_ramp_sec: 0.18,
  accent_start_sec: 1565 / 30,
  accent_duration_sec: 0.6,
  accent_peak_below_active_narration_rms_db: 16,
});
export const EDITORIAL_AUDIO_RECIPE = EDITORIAL_AUDIO_CUES_V1;

function wav(data) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(data.length + 36, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function pcmRms(data, start = 0, end = data.length / 2) {
  let power = 0;
  for (let i = start; i < end; i++) power += (data.readInt16LE(i * 2) / 32768) ** 2;
  return Math.sqrt(power / (end - start));
}

function activeMeasurement(data, cues) {
  const window = Math.round(cues.measurement_window_sec * RATE);
  const threshold = gain(cues.measurement_gate_dbfs);
  const windows = [];
  let sum = 0, count = 0;
  for (let start = 0; start < SAMPLE_COUNT; start += window) {
    const end = Math.min(SAMPLE_COUNT, start + window);
    const rms = pcmRms(data, start, end);
    if (rms <= threshold) continue;
    windows.push([start, end]); sum += rms * rms * (end - start); count += end - start;
  }
  need(count >= RATE, 'source has less than one second above the measurement-only gate');
  return { windows, sampleCount: count, rms: Math.sqrt(sum / count) };
}

function recipeCheck(cues) {
  need(cues && typeof cues === 'object' && !Array.isArray(cues), 'the frozen cue recipe is required');
  const keys = Object.keys(EDITORIAL_AUDIO_CUES_V1).sort();
  need(JSON.stringify(Object.keys(cues).sort()) === JSON.stringify(keys), 'cue recipe fields changed');
  for (const key of keys) need(cues[key] === EDITORIAL_AUDIO_CUES_V1[key], `cue ${key} differs from the scoped recipe`);
}

/** Add one authored continuous underscore and one editorial accent to the
 * existing pacing PCM. Integer addition deliberately permits exact recovery of
 * every source sample by subtracting the retained accompaniment stem. No voice
 * gain, trimming, resampling, dynamics or tempo processing is performed. */
export function buildEditorialProofAudio({ narrationWavBytes, cues }) {
  recipeCheck(cues);
  need(Buffer.isBuffer(narrationWavBytes), 'narration WAV buffer is required');
  const source = inspectTrueCrimeProofWav(narrationWavBytes);
  need(source.sample_count === SAMPLE_COUNT, 'only the retained 64.4-second pacing PCM is supported');
  const original = source.data;
  const active = activeMeasurement(original, cues);
  const raw = new Float64Array(SAMPLE_COUNT);
  const lowPassAlpha = 1 - Math.exp(-TAU * 650 / RATE);
  const lowRejectAlpha = 1 - Math.exp(-TAU * 95 / RATE);
  let state = cues.seed >>> 0, lowPass = 0, lowReject = 0, rawPower = 0;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const t = i / RATE;
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const white = ((state >>> 0) / 4294967296) * 2 - 1;
    lowPass += lowPassAlpha * (white - lowPass);
    lowReject += lowRejectAlpha * (lowPass - lowReject);
    const modulation = 0.9 + 0.07 * Math.sin(TAU * 0.071 * t) + 0.03 * Math.sin(TAU * 0.037 * t);
    const phase = 0.12 * Math.sin(TAU * 0.031 * t);
    // Gentle 110–440 Hz harmonics retain some audibility on small speakers.
    // There is no metrical beat, melody, sampled ambience or event imitation.
    raw[i] = modulation * (0.62 * Math.sin(TAU * 110 * t + phase)
      + 0.12 * Math.sin(TAU * 109.78 * t + 0.47)
      + 0.21 * Math.sin(TAU * 220 * t + 0.31)
      + 0.05 * Math.sin(TAU * 329.628 * t + 0.7)
      + 0.04 * Math.sin(TAU * 440 * t + 0.21)
      + 0.12 * (lowPass - lowReject));
    rawPower += raw[i] * raw[i];
  }
  const rawRms = Math.sqrt(rawPower / SAMPLE_COUNT);
  const targetBedRms = active.rms * gain(-cues.bed_below_active_narration_rms_db);
  const bedScale = targetBedRms / rawRms;
  const accentPeak = active.rms * gain(-cues.accent_peak_below_active_narration_rms_db);
  const underscorePcm = Buffer.alloc(SAMPLE_COUNT * 2);
  const accentPcm = Buffer.alloc(SAMPLE_COUNT * 2);
  const bedPcm = Buffer.alloc(SAMPLE_COUNT * 2);
  const mixPcm = Buffer.alloc(SAMPLE_COUNT * 2);
  const recoveredPcm = Buffer.alloc(SAMPLE_COUNT * 2);
  let peak = 0, bedPeak = 0;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const t = i / RATE;
    const fade = smooth(t / cues.fade_in_sec)
      * smooth((cues.duration_sec - 1 / RATE - t) / cues.fade_out_sec);
    let dipAmount = 0;
    if (t >= cues.quote_dip_start_sec - cues.quote_ramp_sec && t < cues.quote_dip_start_sec) {
      dipAmount = smooth((t - cues.quote_dip_start_sec + cues.quote_ramp_sec) / cues.quote_ramp_sec);
    } else if (t >= cues.quote_dip_start_sec && t <= cues.quote_dip_end_sec) dipAmount = 1;
    else if (t > cues.quote_dip_end_sec && t < cues.quote_dip_end_sec + cues.quote_ramp_sec) {
      dipAmount = 1 - smooth((t - cues.quote_dip_end_sec) / cues.quote_ramp_sec);
    }
    const underscore = Math.round(raw[i] * bedScale * fade * gain(-cues.quote_dip_db * dipAmount) * 32768);
    const accentT = t - cues.accent_start_sec;
    let accent = 0;
    if (accentT > 0 && accentT < cues.accent_duration_sec) {
      const phase = TAU * (190 * accentT - 45 * accentT * accentT / (2 * cues.accent_duration_sec));
      const envelope = smooth(accentT / 0.035) * Math.exp(-4.2 * accentT / cues.accent_duration_sec)
        * smooth((cues.accent_duration_sec - accentT) / 0.12);
      accent = Math.round(accentPeak * envelope * (Math.sin(phase) + 0.2 * Math.sin(phase * 2)) / 1.2 * 32768);
    }
    const accompaniment = underscore + accent;
    const voice = original.readInt16LE(i * 2);
    const mixed = voice + accompaniment;
    need(Math.abs(underscore) < 32767 && Math.abs(accent) < 32767 && Math.abs(accompaniment) < 32767, 'accompaniment exceeds PCM range');
    need(mixed >= -32768 && mixed <= 32767, `additive mix would clip at sample ${i}; no limiting or voice-gain repair is allowed`);
    underscorePcm.writeInt16LE(underscore, i * 2);
    accentPcm.writeInt16LE(accent, i * 2);
    bedPcm.writeInt16LE(accompaniment, i * 2);
    mixPcm.writeInt16LE(mixed, i * 2);
    recoveredPcm.writeInt16LE(mixed - accompaniment, i * 2);
    peak = Math.max(peak, Math.abs(mixed)); bedPeak = Math.max(bedPeak, Math.abs(accompaniment));
  }
  need(recoveredPcm.equals(original), 'mix minus retained accompaniment must recover every original sample exactly');
  const bedWav = wav(bedPcm), mixWav = wav(mixPcm);
  const underscoreWav = wav(underscorePcm), accentWav = wav(accentPcm);
  let activeBedPower = 0;
  for (const [start, end] of active.windows) {
    const rms = pcmRms(bedPcm, start, end); activeBedPower += rms * rms * (end - start);
  }
  const activeBedRms = Math.sqrt(activeBedPower / active.sampleCount);
  const receipt = {
    schema: 'goldflow_true_crime_editorial_audio_receipt_v1',
    status: 'technical_candidate_awaiting_listening',
    method: 'additive_integer_pcm16_with_recoverable_original_narration',
    cues: { ...cues }, cues_sha256: hash(Buffer.from(JSON.stringify(cues))),
    provenance: {
      origin: 'original_locally_authored_procedural_composition',
      ingredients: 'authored oscillators, deterministic filtered noise, and one soft editorial tone accent',
      external_audio_used: false, reference_audio_extracted: false, model_generation: false,
      reference_channel_mix_measurements_used: false,
      intended_function: 'non-diegetic editorial underscore; not an authentic recording or recreated crime-event sound',
    },
    sample_rate_hz: RATE, channels: 1, pcm_bits: 16,
    duration_sec: SAMPLE_COUNT / RATE, sample_count: SAMPLE_COUNT,
    source_wav_sha256: hash(narrationWavBytes), source_pcm_sha256: hash(original),
    accompaniment_wav_sha256: hash(bedWav), mix_wav_sha256: hash(mixWav),
    underscore_wav_sha256: hash(underscoreWav), accent_wav_sha256: hash(accentWav),
    recovered_narration_pcm_sha256: hash(recoveredPcm),
    exact_original_narration_recovery: true, narration_gain: 1, narration_tempo: 1,
    narration_samples_changed: false, resampling: false, dynamic_processing: false,
    measurement: {
      method: 'RMS in source windows above the declared measurement-only gate; not LUFS or a speech edit',
      active_narration_samples: active.sampleCount,
      active_narration_rms_dbfs: dbfs(active.rms),
      unducked_underscore_target_rms_dbfs: dbfs(targetBedRms),
      accompaniment_active_window_rms_dbfs: dbfs(activeBedRms),
      active_narration_to_accompaniment_rms_db: 20 * Math.log10(active.rms / activeBedRms),
      complete_accompaniment_rms_dbfs: dbfs(pcmRms(bedPcm)),
      mix_sample_peak_dbfs: dbfs(peak / 32768), accompaniment_sample_peak_dbfs: dbfs(bedPeak / 32768),
      quote_underscore_rms_dbfs: dbfs(pcmRms(underscorePcm, Math.round(cues.quote_dip_start_sec * RATE), Math.round(cues.quote_dip_end_sec * RATE))),
      clipping_samples: 0,
    },
    source_narration_mastered: false, final_mix_mastered: false,
    provider_calls: 0, cost_usd: 0, production_eligible: false, publish_allowed: false,
    human_listening_performed: false, approval: null,
  };
  return { bedWav, mixWav, underscoreWav, accentWav, receipt };
}
