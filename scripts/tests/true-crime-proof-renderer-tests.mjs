import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { TRUE_CRIME_PROOF_SCHEMA, planTrueCrimeProof, proofCaptionPhrases, evaluateProofTransform, renderTrueCrimeProof } from '../lib/true-crime-proof-renderer.mjs';

const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'true-crime-render-fixture-'));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const ref = async (file) => ({ path: file, sha256: sha(await fs.readFile(file)) });
const copy = (value) => structuredClone(value);
async function png(name, body, width, height) {
  const file = path.join(root, name);
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`)).png().toFile(file);
  return ref(file);
}
function pcmFixture(seconds = 3.2) {
  const rate = 48000, count = Math.round(rate * seconds), data = Buffer.alloc(44 + count * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const t = i / rate, local = t % 1.6, fade = Math.min(1, local / .01, (1.6 - local) / .01);
    data.writeInt16LE(Math.round(Math.sin(t * Math.PI * 2 * (t < 1.6 ? 220 : 550)) * .22 * fade * 32767), 44 + i * 2);
  }
  return data;
}
try {
  const cutout = await png('cutout.png', '<ellipse cx="100" cy="145" rx="64" ry="125" fill="#d43130"/>', 200, 300);
  const document = await png('document.png', '<rect width="600" height="400" fill="#f3ecd8"/><text x="35" y="80" font-family="Arial" font-size="36">SYNTHETIC RECORD</text><path d="M35 135H560M35 185H470M35 235H540" stroke="#25364a" stroke-width="16"/>', 600, 400);
  const background = await png('background.png', '<rect width="1920" height="1080" fill="#27424e"/><path d="M0 360H1920M0 720H1920M480 0V1080M960 0V1080M1440 0V1080" stroke="#365866" stroke-width="7"/>', 1920, 1080);
  const narrationFile = path.join(root, 'synthetic-tone.wav');
  await fs.writeFile(narrationFile, pcmFixture());
  const narrationRef = await ref(narrationFile);
  const manifest = {
    schema: TRUE_CRIME_PROOF_SCHEMA, scope: 'synthetic_fixture', production_eligible: false,
    identity: { channel: 'fixture', series: 'renderer-test', run: 'isolated-local', episode: 'fixture', title: 'Synthetic compositor verification' },
    narration: { ...narrationRef, units: [
      { id: 'u1', text: 'This fixture preserves every source word exactly.', start_sec: 0, end_sec: 1.6 },
      { id: 'u2', text: 'A separate scene retains the second audio interval.', start_sec: 1.6, end_sec: 3.2 }
    ] },
    scenes: [
      { id: 'cutout-scene', narration_unit_ids: ['u1'], hold_before_sec: .3, hold_after_sec: .2, source_label: 'SOURCE: SYNTHETIC LOCAL FIXTURE A', disclosure: 'SYNTHETIC FIXTURE — ILLUSTRATIVE COMPOSITE', background: { ...background, color: '#152833', keyframes: [{ time_sec: 0, x: -10, y: -10, scale: 1.02 }, { time_sec: 2.1, x: -40, y: -20, scale: 1.04 }] }, layers: [
        { id: 'person', type: 'image', ...cutout, cutout: true, width: 300, height: 600, x: -400, y: 205, keyframes: [{ time_sec: 0, x: -400 }, { time_sec: .5, x: 290, easing: 'ease_out' }, { time_sec: 2.1, x: 340, scale: 1.06 }] },
        { id: 'record', type: 'card', ...document, width: 900, height: 610, x: 850, y: 185, keyframes: [{ time_sec: 0, x: 1050, opacity: .5 }, { time_sec: .4, x: 850, opacity: 1, easing: 'ease_out' }, { time_sec: 2.1, x: 830, scale: 1.02 }] }
      ] },
      { id: 'record-scene', narration_unit_ids: ['u2'], hold_before_sec: .25, hold_after_sec: .15, source_label: 'SOURCE: SYNTHETIC LOCAL FIXTURE B', disclosure: 'SYNTHETIC FIXTURE — DOCUMENT PRESENTATION', background: { color: '#344756' }, layers: [
        { id: 'text', type: 'card', text: 'Two scenes. Complete audio. Explicit pauses.', width: 1100, height: 370, x: 410, y: 300, font_size: 64, keyframes: [{ time_sec: 0, y: 340 }, { time_sec: .45, y: 300, easing: 'ease_out' }] }
      ] }
    ]
  };
  for (const scene of manifest.scenes) scene.hold_note = 'Authored synthetic silent boundary for sample-preservation verification.';
  const plan = planTrueCrimeProof(manifest);
  assert.equal(plan.duration_frames, 123);
  assert.equal(plan.duration_sec, 4.1);
  assert.ok(Math.abs(plan.authored_holds_sec - .9) < 1e-8);
  assert.equal(plan.narration_tempo, 1);
  assert.equal(plan.captions.map((c) => c.text).join(' '), manifest.narration.units.map((u) => u.text).join(' '));
  assert.equal(plan.captions[0].start_sec, .3);
  assert.ok(Math.abs(plan.captions.at(-1).end_sec - 3.95) < 1e-8);
  assert.equal(plan.captions[0].timing_basis, 'estimated_within_measured_unit');
  const moved = evaluateProofTransform(plan.scenes[0].layers[0].transform_keys, .5);
  assert.equal(moved.x, 290);
  assert.equal(evaluateProofTransform(plan.scenes[0].layers[1].transform_keys, .5).x < 850, true);
  const noDisclosure = copy(manifest); delete noDisclosure.scenes[0].disclosure;
  assert.throws(() => planTrueCrimeProof(noDisclosure), /disclosure/);
  const noHoldNote = copy(manifest); delete noHoldNote.scenes[0].hold_note;
  assert.throws(() => planTrueCrimeProof(noHoldNote), /hold note/);
  const publishable = copy(manifest); publishable.production_eligible = true;
  assert.throws(() => planTrueCrimeProof(publishable), /private proof identity/);
  const reordered = copy(manifest); reordered.scenes[0].narration_unit_ids = ['u2'];
  assert.throws(() => planTrueCrimeProof(reordered), /source order/);
  const gap = copy(manifest); gap.narration.units[1].start_sec = 1.7;
  assert.throws(() => planTrueCrimeProof(gap), /contiguously/);
  const wrongText = { ...manifest.narration.units[0], phrases: [{ text: 'Invented different narration.', start_sec: 0, end_sec: 1.6 }] };
  assert.throws(() => proofCaptionPhrases(wrongText), /differs/);
  const exact = { ...manifest.narration.units[0], phrases: [{ text: 'This fixture preserves', start_sec: .1, end_sec: .6 }, { text: 'every source word exactly.', start_sec: .65, end_sec: 1.5 }] };
  assert.equal(proofCaptionPhrases(exact)[0].timing_basis, 'supplied_phrase_intervals');
  const longProof = copy(manifest); longProof.scope = 'private_proof'; longProof.narration.units[0].end_sec = 45; longProof.narration.units[1].start_sec = 45; longProof.narration.units[1].end_sec = 90.5;
  assert.ok(Math.abs(planTrueCrimeProof(longProof).duration_sec - 91.4) < 1e-7);
  const tooShort = copy(manifest); tooShort.scope = 'private_proof';
  assert.throws(() => planTrueCrimeProof(tooShort), /90–150/);
  const tooLong = copy(longProof); tooLong.narration.units[1].end_sec = 150;
  assert.throws(() => planTrueCrimeProof(tooLong), /90–150/);
  const readableHolds = copy(longProof); readableHolds.narration.units[0].end_sec = 35; readableHolds.narration.units[1].start_sec = 35; readableHolds.narration.units[1].end_sec = 70;
  for (const scene of readableHolds.scenes) { scene.hold_before_sec = 6; scene.hold_after_sec = 6; }
  assert.equal(planTrueCrimeProof(readableHolds).duration_sec, 94);
  const changed = copy(manifest); changed.narration.sha256 = '0'.repeat(64);
  const absentDir = path.join(root, 'refused');
  await assert.rejects(renderTrueCrimeProof({ outputDir: absentDir, manifest: changed }), /source hash changed/);
  await assert.rejects(fs.stat(absentDir), { code: 'ENOENT' });
  const truncated = copy(manifest); truncated.narration.units[1].end_sec = 3;
  await assert.rejects(renderTrueCrimeProof({ outputDir: absentDir, manifest: truncated }), /entire measured narration/);
  const opaque = copy(manifest); opaque.scenes[0].layers[0] = { ...opaque.scenes[0].layers[0], ...document };
  await assert.rejects(renderTrueCrimeProof({ outputDir: absentDir, manifest: opaque }), /actual transparency/);
  await assert.rejects(fs.stat(absentDir), { code: 'ENOENT' });

  const outputDir = path.join(root, 'render');
  const result = await renderTrueCrimeProof({ outputDir, manifest, onProgress: ({ frame, total_frames }) => console.log(`Synthetic proof frames: ${frame}/${total_frames}`) });
  const qa = JSON.parse(await fs.readFile(result.technical_report.path, 'utf8'));
  assert.equal(qa.production_eligible, false);
  assert.equal(qa.exact_program_approval_recorded, false);
  assert.equal(qa.duration_frames, 123);
  assert.equal(qa.probe.streams.find((s) => s.codec_type === 'video').nb_read_frames, '123');
  assert.equal(qa.probe.streams.find((s) => s.codec_type === 'video').width, 1920);
  assert.equal(qa.probe.streams.find((s) => s.codec_type === 'video').height, 1080);
  assert.equal((await ref(narrationFile)).sha256, narrationRef.sha256);
  assert.equal(qa.frames.length, 4);
  const first = await sharp(qa.frames[0].path).raw().toBuffer({ resolveWithObject: true });
  const settled = await sharp(qa.frames[1].path).raw().toBuffer({ resolveWithObject: true });
  function redPixels(image) {
    let red = 0;
    for (let y = 200; y < 800; y++) for (let x = 240; x < 650; x++) {
      const i = (y * image.info.width + x) * image.info.channels;
      if (image.data[i] > 130 && image.data[i] > image.data[i + 1] * 1.8) red++;
    }
    return red;
  }
  assert.equal(redPixels(first), 0, 'entrance begins offscreen');
  assert.ok(redPixels(settled) > 20000, 'independent outlined cutout settles visibly');
  const labelA = await sharp(qa.frames[0].path).extract({ left: 0, top: 0, width: 1920, height: 110 }).raw().toBuffer();
  const labelB = await sharp(qa.frames[1].path).extract({ left: 0, top: 0, width: 1920, height: 110 }).raw().toBuffer();
  // Label interior is opaque enough to remain readable while its background moves.
  assert.ok(labelA.some((b) => b > 200) && labelB.some((b) => b > 200));
  const pcm = path.join(root, 'decoded.f32');
  await exec('ffmpeg', ['-v', 'error', '-i', result.output.path, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', pcm]);
  const decoded = await fs.readFile(pcm);
  function rms(start, end) {
    let sum = 0, n = 0;
    for (let i = Math.round(start * 48000); i < Math.round(end * 48000); i++) { const v = decoded.readFloatLE(i * 4); sum += v * v; n++; }
    return Math.sqrt(sum / n);
  }
  assert.ok(rms(.05, .2) < .001, 'authored opening hold is silent');
  assert.ok(rms(.5, .8) > .1, 'first narration interval remains audible');
  assert.ok(rms(1.97, 2.25) < .002, 'explicit inter-scene holds remain silent');
  assert.ok(rms(3.65, 3.9) > .1, 'end of second narration interval is preserved');
  await assert.rejects(renderTrueCrimeProof({ outputDir, manifest }), /never overwritten/);
  console.log(`True-crime compositor synthetic render passed: ${result.output.path}`);
  if (process.env.KEEP_TRUE_CRIME_FIXTURE === '1') console.log(`Retained fixture: ${root}`);
} finally {
  if (process.env.KEEP_TRUE_CRIME_FIXTURE !== '1') await fs.rm(root, { recursive: true, force: true });
}
