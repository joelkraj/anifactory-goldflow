import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planPacingRevision, buildPacingVideoFilter, reviseTrueCrimeProofPacing } from '../true-crime-proof-pacing-revision.mjs';
import { buildProgramPcm } from '../lib/true-crime-proof-program-audio-repair.mjs';
import { inspectTrueCrimeProofWav } from '../lib/true-crime-proof-narration.mjs';

const exec = promisify(execFile), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crime-pacing-test-'));
function sourceWav() {
  const bytes = Buffer.alloc(44 + 20160 * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < 20160; i++) bytes.writeInt16LE(i + 1, 44 + i * 2);
  return bytes;
}
const source = sourceWav(), sourceCopy = Buffer.from(source);
const timeline = { schema: 'goldflow_true_crime_proof_timeline_v1', width: 1920, height: 1080, fps: 30, narration_tempo: 1,
  duration_frames: 168, duration_sec: 5.6, source_duration_sec: .84, authored_duration_sec: 5.6, authored_holds_sec: 4.76, rounding_silence_sec: 0,
  scenes: Array.from({ length: 7 }, (_, i) => ({ id: `S0${i + 1}`, narration_unit_ids: [`U${i}`], source_in_sec: i * .12, source_out_sec: (i + 1) * .12,
    start_sec: i * .8, end_sec: (i + 1) * .8, narration_start_sec: i * .8, duration_sec: .8, hold_before_sec: 0, hold_after_sec: .68 })) };
const holds = [0, 0, 0, .35, 0, 0, .5].map((hold_after_sec, i) => ({ scene_id: `S0${i + 1}`, hold_after_sec }));
try {
  const frozen = JSON.stringify(timeline), mapping = planPacingRevision({ timeline, sceneHolds: holds });
  assert.equal(JSON.stringify(timeline), frozen); assert.equal(mapping.revised_timeline.duration_frames, 54); assert.equal(mapping.revised_timeline.duration_sec, 1.8);
  assert.deepEqual(mapping.clips.map((c) => c.frame_count), [4, 4, 4, 15, 4, 4, 19]);
  assert.deepEqual(mapping.clips.map((c) => c.source_start_frame), [0, 24, 48, 72, 96, 120, 144]);
  assert.equal(mapping.requested_holds_sec, .85); assert.equal(mapping.per_scene_frame_rounding_sec, .11); assert.equal(mapping.removed_frames, 114);
  // The actual duration shape exercises fractional scene starts and proves that
  // scene-local rounding does not accumulate source-picture/audio drift.
  let at = 0, spoken = 0;
  const shaped = { ...structuredClone(timeline), duration_frames: 2802, duration_sec: 93.4, source_duration_sec: 63.38, authored_duration_sec: 93.38, authored_holds_sec: 30, rounding_silence_sec: .02,
    scenes: [9.87, 10.91, 6.67, 3.79, 9.39, 12.27, 10.48].map((length, i) => {
      const hold = [3, 4, 3, 5, 4, 6, 5][i], start = at, sourceStart = spoken;
      at = Math.round((at + length + hold) * 100) / 100; spoken = Math.round((spoken + length) * 100) / 100;
      return { id: `S0${i + 1}`, narration_unit_ids: [`U${i}`], source_in_sec: sourceStart, source_out_sec: spoken, start_sec: start, narration_start_sec: start, end_sec: at, duration_sec: length + hold, hold_before_sec: 0, hold_after_sec: hold };
    }) };
  const shapedMapping = planPacingRevision({ timeline: shaped, sceneHolds: holds });
  assert.deepEqual(shapedMapping.clips.map((c) => c.frame_count), [297, 328, 201, 125, 282, 369, 330]);
  assert.equal(shapedMapping.revised_timeline.duration_frames, 1932); assert.equal(shapedMapping.revised_timeline.duration_sec, 64.4);
  assert.equal(shapedMapping.per_scene_frame_rounding_sec, .17);
  assert(shapedMapping.clips.slice(1, 6).every((c) => c.source_picture_phase_offset_sec > 0 && c.source_picture_phase_offset_sec < 1 / 30));
  const result = buildProgramPcm({ sourceWavBytes: source, timeline: mapping.revised_timeline }), pcm = inspectTrueCrimeProofWav(result.bytes).data;
  assert(source.equals(sourceCopy)); assert.equal(result.report.whole_narration_preserved, true); assert.equal(result.report.each_source_sample_copied_once, true);
  assert.equal(result.report.source_pcm_sha256, result.report.reconstructed_source_pcm_sha256);
  for (const clip of mapping.clips) {
    const a = clip.source_start_sample, b = clip.source_end_sample, at = clip.output_start_sample;
    assert(pcm.subarray(at * 2, (at + b - a) * 2).equals(source.subarray(44 + a * 2, 44 + b * 2)), 'every original source sample remains in order');
    assert(pcm.subarray((at + b - a) * 2, clip.output_end_frame_exclusive * 800 * 2).every((value) => value === 0), 'only selected holds and frame rounding are inserted');
  }
  assert.equal(pcm.readInt16LE(0), 1); assert.equal(pcm.readInt16LE((mapping.clips.at(-1).output_start_sample + 2880 - 1) * 2), 20160);
  for (const change of [t => { t.scenes[2].source_in_sec += .01; }, t => { t.scenes[2].hold_before_sec = .1; }, t => { t.scenes[1].start_sec += .001; }, t => { t.scenes[3].hold_after_sec = .1; }, t => { t.scenes[0].source_out_sec += .5 / 24000; }, t => { t.narration_tempo = 2; }]) {
    const altered = structuredClone(timeline); change(altered); assert.throws(() => planPacingRevision({ timeline: altered, sceneHolds: holds }));
  }
  const otherHolds = structuredClone(holds); otherHolds[0].hold_after_sec = .2;
  assert.throws(() => planPacingRevision({ timeline, sceneHolds: otherHolds }), /exact selected/);
  const request = path.join(dir, 'unauthorized.json');
  await fs.writeFile(request, JSON.stringify({ schema: 'goldflow_true_crime_pacing_revision_recipe_v1', scope: 'shorten_post_narration_holds_only', production_eligible: false, creative_generation: false, output_dir: path.join(dir, 'must-not-exist'), authorization: { operator: 'Joel', user_feedback: 'invented consent', duration_change_authorized: true } }));
  await assert.rejects(reviseTrueCrimeProofPacing({ recipePath: request }), /exact latest user feedback/);
  await assert.rejects(fs.stat(path.join(dir, 'must-not-exist')), { code: 'ENOENT' });

  const originalPcm = buildProgramPcm({ sourceWavBytes: source, timeline }).bytes;
  const originalWav = path.join(dir, 'original-program.wav'), revisedWav = path.join(dir, 'revised-program.wav');
  const originalVideo = path.join(dir, 'synthetic-original.mp4'), revisedVideo = path.join(dir, 'synthetic-revised.mp4');
  await fs.writeFile(originalWav, originalPcm); await fs.writeFile(revisedWav, result.bytes);
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=5.6', '-i', originalWav,
    '-frames:v', '168', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-c:a', 'aac', '-ar', '48000', originalVideo], { timeout: 90000 });
  const graph = buildPacingVideoFilter(mapping);
  await exec('ffmpeg', ['-v', 'error', '-i', originalVideo, '-i', revisedWav, '-filter_complex', graph, '-map', '[outv]', '-map', '1:a:0',
    '-frames:v', '54', '-fps_mode', 'cfr', '-r', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-c:a', 'aac', '-ar', '48000', revisedVideo], { timeout: 90000 });
  const measured = JSON.parse((await exec('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', revisedVideo])).stdout);
  assert.equal(measured.streams.find((s) => s.codec_type === 'video').nb_read_frames, '54');
  assert.equal(Number(measured.streams.find((s) => s.codec_type === 'video').duration), 1.8);
  assert.equal(Number(measured.streams.find((s) => s.codec_type === 'audio').duration), 1.8);
  const pairs = mapping.clips.flatMap((c) => [[c.source_start_frame, c.output_start_frame], [c.source_end_frame_exclusive - 1, c.output_end_frame_exclusive - 1]]);
  const stride = 1920 * 1080 * 3;
  const decode = async (file, column) => (await exec('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select='${pairs.map((p) => `eq(n,${p[column]})`).join('+')}'`, '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: (pairs.length + 1) * stride })).stdout;
  const before = await decode(originalVideo, 0), after = await decode(revisedVideo, 1);
  assert.equal(before.length, pairs.length * stride); assert.equal(after.length, before.length);
  for (let i = 0; i < pairs.length; i++) {
    let error = 0; for (let k = i * stride; k < (i + 1) * stride; k++) error += (before[k] - after[k]) ** 2;
    const psnr = 10 * Math.log10(255 ** 2 / (error / stride)); assert(psnr > 38, `first/last frame mapping failed at scene edge ${i}: ${psnr}`);
  }
  console.log('PASS: exact seven scene trim windows, fixed requested holds, complete ordered PCM samples, silence/frame rounding, authorization failure before writes, 54-frame synthetic render, matched source boundary pictures and complete audio.');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
