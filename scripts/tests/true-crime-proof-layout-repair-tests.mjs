import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { planCardLayoutRepair, renderMeasuredRepairCard, buildCardRepairFilter, repairTrueCrimeProofLayout } from '../true-crime-proof-layout-repair.mjs';
import { planTrueCrimeProof } from '../lib/true-crime-proof-renderer.mjs';

const exec = promisify(execFile), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'crime-layout-repair-test-'));
const ref = { path: path.join(temp, 'not-read.wav'), sha256: 'a'.repeat(64) };
const card = (id, text, x, y, height, font_size, entranceX) => ({ type: 'card', id, text, x, y, width: 825, height, font_size, fill: '#f3ecdb', text_color: '#1b2933', ...(entranceX ? { keyframes: [{ time_sec: 0, x: entranceX, y, opacity: 0 }, { time_sec: .1, x: entranceX, y, opacity: 0 }, { time_sec: id === 'not_witnessed' ? .8 : .75, x, y, opacity: 1, easing: 'ease_out' }] } : {}) });
const manifest = { schema: 'goldflow_true_crime_proof_render_v1', scope: 'private_proof', production_eligible: false,
  identity: { channel: 'Fixture', series: 'fixture', run: 'fixture', episode: 'ep_01', title: 'Synthetic layout test' },
  narration: { ...ref, units: Array.from({ length: 7 }, (_, i) => ({ id: `U${i}`, text: `Synthetic unit ${i}.`, start_sec: i * 10, end_sec: (i + 1) * 10 })) },
  scenes: Array.from({ length: 7 }, (_, i) => ({ id: `S0${i + 1}`, narration_unit_ids: [`U${i}`], hold_after_sec: 3, hold_note: 'Synthetic reading hold.', disclosure: 'SYNTHETIC FIXTURE', source_label: 'Synthetic fixture only', background: { color: '#162630' }, layers: [] })) };
manifest.scenes[4].layers = [card('reported_absence', 'REPORTED ABSENCE\nAROUND 6:15 A.M.', 86, 275, 285, 57), card('not_witnessed', 'DEPARTURE NOT\nWITNESSED BY HIM', 1005, 275, 285, 57, 1060)];
manifest.scenes[5].layers = [card('message_date', 'REPORTED MESSAGE\nSUNDAY · JULY 4', 90, 245, 220, 52), card('parade_date', 'PARADE DATE\nSATURDAY · JULY 3', 1005, 245, 220, 52, 1045)];
try {
  const timeline = planTrueCrimeProof(manifest), planned = planCardLayoutRepair(manifest, timeline);
  assert.equal(planned.length, 4); assert.deepEqual([...new Set(planned.map((c) => c.scene))], ['S05', 'S06']);
  assert.equal(planned[1].erase.width, 880); assert.equal(planned[3].erase.width, 865);
  const stale = structuredClone(manifest); stale.scenes[4].layers[0].text = 'ALTERED WORDS';
  assert.throws(() => planCardLayoutRepair(stale, planTrueCrimeProof(stale)), /text changed/);
  const moved = structuredClone(manifest); moved.scenes[5].layers[1].keyframes[2].x = 1004;
  assert.throws(() => planCardLayoutRepair(moved, planTrueCrimeProof(moved)), /choreography changed/);
  await assert.rejects(renderMeasuredRepairCard({ ...planned[0], lines: ['W'.repeat(80), 'TEXT'] }), /measured text exceeds/);
  const wrongRecipe = path.join(temp, 'invalid-recipe.json');
  await fs.writeFile(wrongRecipe, JSON.stringify({ schema: 'goldflow_true_crime_layout_repair_recipe_v1', scope: 'replace_entire_movie', output_dir: path.join(temp, 'must-not-exist') }));
  await assert.rejects(repairTrueCrimeProofLayout({ recipePath: wrongRecipe }), /exact S05\/S06/);
  await assert.rejects(fs.stat(path.join(temp, 'must-not-exist')), { code: 'ENOENT' });

  const cards = planned.map((c, i) => ({ ...c, scene_start_sec: i < 2 ? 0 : 1, scene_end_sec: i < 2 ? 1 : 2, first_frame: i < 2 ? 0 : 30, last_frame: i < 2 ? 29 : 59 }));
  for (const c of cards) {
    const rendered = await renderMeasuredRepairCard(c);
    assert(rendered.measurements.every((m) => m.x + m.width <= c.width - 32));
    assert.deepEqual(rendered.measurements.map((m) => m.text), c.lines);
    c.file = path.join(temp, `${c.scene}-${c.id}.png`); await fs.writeFile(c.file, rendered.bytes);
  }
  const source = path.join(temp, 'synthetic-source.mp4'), pcm = path.join(temp, 'synthetic-program.wav'), output = path.join(temp, 'synthetic-repaired.mp4');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x162630:s=1920x1080:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=24000:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-c:a', 'aac', '-ar', '48000', source]);
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=24000:duration=3', '-c:a', 'pcm_s16le', pcm]);
  const graph = buildCardRepairFilter(cards); assert.match(graph, /colorchannelmixer@card1/); assert.match(graph, /between\(t,/);
  const graphPath = path.join(temp, 'repair.ffgraph'); await fs.writeFile(graphPath, graph);
  const args = ['-v', 'error', '-i', source, '-i', pcm];
  cards.forEach((c) => args.push('-loop', '1', '-framerate', '30', '-i', c.file));
  args.push('-filter_complex_script', graphPath, '-map', '[outv]', '-map', '1:a:0', '-frames:v', '90', '-r', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', output);
  await exec('ffmpeg', args, { timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
  const measured = JSON.parse((await exec('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', output])).stdout);
  assert.equal(measured.streams.find((s) => s.codec_type === 'video').nb_read_frames, '90');
  assert.equal(Number(measured.streams.find((s) => s.codec_type === 'audio').duration), 3);
  const get = async (file, frame) => (await exec('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 7 * 1024 * 1024 })).stdout;
  const pixel = (buffer, x, y) => [...buffer.subarray((y * 1920 + x) * 3, (y * 1920 + x) * 3 + 3)];
  const first = await get(output, 0), moving = await get(output, 15), settled = await get(output, 27), after = await get(output, 75), before = await get(source, 75);
  assert(pixel(first, 150, 500)[0] > 200, 'static card appears');
  assert(pixel(first, 1700, 500)[0] < 50, 'right card initially transparent');
  assert(pixel(moving, 1700, 500)[0] > 150, 'right card eases in');
  assert(pixel(settled, 1700, 500)[0] > 220, 'right card settles opaque');
  assert(pixel(after, 1700, 500).every((value, i) => Math.abs(value - pixel(before, 1700, 500)[i]) <= 3), 'no patch outside S05/S06 frame windows');
  assert(pixel(settled, 100, 900).every((value, i) => Math.abs(value - pixel(before, 100, 900)[i]) <= 3), 'pixels outside card rectangles preserved within codec rounding');
  console.log('PASS: strict scope/text/motion guards, measured two-line typesetting, 90-frame synthetic FFmpeg repair, cubic fade, unchanged outside-card areas, complete audio duration.');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
