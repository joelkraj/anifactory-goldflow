import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { validatePanelTimeline, loadPanelTimeline } from '../lib/panel-layout-contract.mjs';
import { panelFrameState, panelImagePlacement, samplePanelKeyframes } from '../lib/panel-layout-runtime.mjs';
import { renderPanelLayoutProof, inspectPanelLayoutProof, assertPanelProofProbe, panelProofSampleFrames } from '../lib/panel-layout-renderer.mjs';
import { createPanelReviewHtml } from '../lib/panel-layout-review.mjs';

const run = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const key = (at_sec, rect, camera = { x: 0.5, y: 0.5, zoom: 1 }, easing = 'linear') => ({ at_sec, rect: { ...rect }, camera: { ...camera }, opacity: 1, easing });
const viewport = { x: 0.05, y: 0.05, width: 0.4, height: 0.9 };
const image = (id, file = `${id}.png`) => ({ id, path: file, sha256: 'a'.repeat(64), origin: 'test_fixture', provenance: 'Locally authored color geometry test raster; no external media.' });

function fixture() {
  return {
    schema: 'goldflow_panel_timeline_v1', id: 'synthetic-panel-layout', intent: 'engine_proof',
    content_profile: 'manhwa_recap_v1', width: 320, height: 180, fps: 30, duration_sec: 2, audio_target: 'silent_fixture',
    assets: [image('page'), image('reaction'), image('spread')],
    panels: [
      { id: 'page', asset_id: 'page', source_rect: { x: 0, y: 0, width: 1, height: 1 } },
      { id: 'reaction', asset_id: 'reaction', source_rect: { x: 0, y: 0, width: 1, height: 1 } },
      { id: 'cropped', asset_id: 'spread', source_rect: { x: 0.5, y: 0, width: 0.5, height: 1 } },
    ],
    scenes: [
      {
        id: 'page-scroll', start_sec: 0, end_sec: 1, background: { panel_id: 'page', blur_px: 8, brightness: 0 },
        layers: [
          { id: 'page-main', panel_id: 'page', start_sec: 0, end_sec: 1, z: 0, fit: 'cover', border_px: 0,
            keyframes: [key(0, viewport, { x: 0.5, y: 0, zoom: 1 }), key(1, viewport, { x: 0.5, y: 1, zoom: 1 })] },
          { id: 'reaction-overlay', panel_id: 'reaction', start_sec: 0.5, end_sec: 1, z: 1, fit: 'contain', border_px: 0,
            keyframes: [key(0.5, { x: 1.1, y: 0.1, width: 0.25, height: 0.4 }), key(0.75, { x: 0.65, y: 0.1, width: 0.25, height: 0.4 }), key(1, { x: 0.65, y: 0.1, width: 0.25, height: 0.4 })] },
        ],
      },
      {
        id: 'cropped-payoff', start_sec: 1, end_sec: 2, background: { panel_id: 'cropped', blur_px: 8, brightness: 0.2 },
        layers: [{ id: 'payoff', panel_id: 'cropped', start_sec: 1, end_sec: 2, z: 0, fit: 'contain', border_px: 0,
          keyframes: [key(1, { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }), key(2, { x: 0.1, y: 0.1, width: 0.8, height: 0.8 })] }],
      },
    ],
  };
}

let count = 0;
async function test(name, action) { await action(); count += 1; process.stdout.write(`ok - panel layout: ${name}\n`); }
function rejects(mutate, pattern) { const timeline = fixture(); mutate(timeline); assert.throws(() => validatePanelTimeline(timeline), pattern); }
function close(actual, expected, message) { assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`); }

await test('proof validation preserves exact authored order, timing, metadata and source crops', () => {
  const timeline = fixture();
  timeline.panels[0].characters = ['fixture-character'];
  timeline.scenes[0].editorial_reason = 'Hold the page while its authored reaction enters.';
  const before = structuredClone(timeline);
  assert.equal(validatePanelTimeline(timeline), timeline);
  assert.deepEqual(timeline, before);
});

await test('scope, duration, format, identities and audio selection are explicit', () => {
  for (const [field, value] of [['schema', 'other'], ['intent', 'production'], ['content_profile', 'asset_afterlife_v1'], ['duration_sec', 151], ['duration_sec', 0], ['fps', 23], ['width', 321], ['height', 182], ['audio_target', undefined]]) {
    rejects(t => { t[field] = value; });
  }
  rejects(t => { t.assets[1].id = t.assets[0].id; }, /duplicate/);
  rejects(t => { t.panels[1].id = t.panels[0].id; }, /duplicate/);
  rejects(t => { t.scenes[1].layers[0].id = t.scenes[0].layers[0].id; }, /duplicate/);
  rejects(t => { t.assets[0].sha256 = 'wrong'; }, /SHA-256/);
  rejects(t => { t.assets[0].provenance = ''; }, /provenance/);
  rejects(t => { t.audio = { path: 'voice.wav' }; }, /silent_fixture/);
  rejects(t => { t.audio_target = 'narrator_only'; }, /audio/);
  const timeline = fixture();
  timeline.audio_target = 'narrator_only'; timeline.audio = { path: 'voice.wav', sha256: 'a'.repeat(64), offset_sec: 17.25 };
  assert.equal(validatePanelTimeline(timeline).audio.offset_sec, 17.25);
});

await test('invalid crop, camera, lifetime, order and coverage cannot silently clamp', () => {
  rejects(t => { t.panels[0].source_rect.width = 0; }, /crop/);
  rejects(t => { t.panels[0].source_rect.x = 0.1; }, /outside source/);
  rejects(t => { t.panels[0].asset_id = 'missing'; }, /unknown asset/);
  rejects(t => { t.scenes[1].start_sec = 1.01; }, /gap|overlap/);
  rejects(t => { t.scenes[1].start_sec = 0.99; }, /gap|overlap/);
  rejects(t => { t.scenes[1].end_sec = 1.9; t.scenes[1].layers[0].end_sec = 1.9; t.scenes[1].layers[0].keyframes[1].at_sec = 1.9; }, /complete duration/);
  rejects(t => { t.scenes[0].layers[1].start_sec = -0.1; }, /layer.start_sec/);
  rejects(t => { t.scenes[0].layers[0].keyframes[1].at_sec = 0.8; }, /exact lifetime/);
  rejects(t => { t.scenes[0].layers[1].keyframes[1].at_sec = 0.5; }, /increase/);
  rejects(t => { t.scenes[0].layers[1].z = 0; }, /unique integer/);
  for (const value of [NaN, Infinity, -Infinity]) rejects(t => { t.scenes[0].layers[0].keyframes[0].rect.x = value; }, /rect.x/);
  rejects(t => { t.scenes[0].layers[0].keyframes[0].camera.zoom = 0.99; }, /zoom/);
  rejects(t => { t.scenes[0].layers[0].keyframes[0].easing = 'guessed'; }, /easing/);
});

await test('layer onsets and scene endings use exact half-open intervals', () => {
  const timeline = fixture();
  assert.deepEqual(panelFrameState(timeline, -0.001).layers, []);
  assert.deepEqual(panelFrameState(timeline, 0.5 - 1e-9).layers.map(l => l.id), ['page-main']);
  assert.deepEqual(panelFrameState(timeline, 0.5).layers.map(l => l.id), ['page-main', 'reaction-overlay']);
  assert.equal(panelFrameState(timeline, 1 - 1e-9).scene.id, 'page-scroll');
  assert.equal(panelFrameState(timeline, 1).scene.id, 'cropped-payoff');
  assert.deepEqual(panelFrameState(timeline, 2), { scene: null, layers: [] });
  const before = structuredClone(timeline);
  panelFrameState(timeline, 0.75);
  assert.deepEqual(timeline, before, 'Sampling must never reorder or mutate source layers.');
});

await test('reading holds, nonlinear movement and manual keys survive sampling', () => {
  const a = key(0, { x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, zoom: 1 }, 'hold');
  const b = key(2.3, { x: 0.8, y: 0.2, width: 0.5, height: 0.5 }, { x: 1, y: 1, zoom: 2 }, 'smooth');
  const c = key(4, { x: 0.2, y: 0.4, width: 0.8, height: 0.9 }, { x: 0.5, y: 0.5, zoom: 1.5 });
  assert.deepEqual(samplePanelKeyframes([a, b, c], -1), a);
  assert.deepEqual(samplePanelKeyframes([a, b, c], 9), c);
  close(samplePanelKeyframes([a, b, c], 2.3 - 1e-9).rect.x, 0, 'Hold remains before authored boundary');
  close(samplePanelKeyframes([a, b, c], 2.3).rect.x, 0.8, 'Exact key takes effect');
  close(samplePanelKeyframes([a, b, c], 2.3 + 1.7 / 4).rect.x, 0.8 + (0.2 - 0.8) * 0.15625, 'Smooth easing is not linear');
});

await test('proof evaluator never inserts a fixed narrative transition cadence', () => {
  const timeline = fixture();
  timeline.duration_sec = 14;
  timeline.scenes[1].end_sec = 14;
  timeline.scenes[1].layers[0].end_sec = 14;
  timeline.scenes[1].layers[0].keyframes[1].at_sec = 14;
  validatePanelTimeline(timeline);
  for (const time of [1, 3.1, 5, 8, 13.99]) assert.equal(panelFrameState(timeline, time).layers[0].id, 'payoff');
  assert.equal(timeline.scenes.length, 2);
});

await test('portrait overflow traverses top to bottom while containment preserves aspect', () => {
  const rect = { x: 10, y: 20, width: 100, height: 100 };
  assert.deepEqual(panelImagePlacement(100, 400, rect, { x: 0, y: 0, zoom: 1 }, 'cover'), { x: 10, y: 20, width: 100, height: 400 });
  assert.deepEqual(panelImagePlacement(100, 400, rect, { x: 1, y: 1, zoom: 1 }, 'cover'), { x: 10, y: -280, width: 100, height: 400 });
  assert.deepEqual(panelImagePlacement(100, 400, rect, { x: 1, y: 1, zoom: 1 }, 'contain'), { x: 47.5, y: 20, width: 25, height: 100 });
  assert.deepEqual(panelImagePlacement(400, 100, rect, { x: 1, y: 0, zoom: 1 }, 'cover'), { x: -290, y: 20, width: 400, height: 100 });
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-layout-tests-'));
try {
  const timeline = fixture();
  const blue = await sharp({ create: { width: 80, height: 160, channels: 3, background: '#0000ff' } }).png().toBuffer();
  await sharp({ create: { width: 80, height: 320, channels: 3, background: '#ff0000' } }).composite([{ input: blue, left: 0, top: 160 }]).png().toFile(path.join(root, 'page.png'));
  await sharp({ create: { width: 80, height: 80, channels: 3, background: '#00ff00' } }).png().toFile(path.join(root, 'reaction.png'));
  const yellow = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#ffff00' } }).png().toBuffer();
  await sharp({ create: { width: 160, height: 80, channels: 3, background: '#ff00ff' } }).composite([{ input: yellow, left: 80, top: 0 }]).png().toFile(path.join(root, 'spread.png'));
  for (const asset of timeline.assets) asset.sha256 = hash(await fs.readFile(path.join(root, asset.path)));
  const manifestPath = path.join(root, 'timeline.json');
  await fs.writeFile(manifestPath, JSON.stringify(timeline));

  await test('loader binds actual raster and exact manifest hashes without changing originals', async () => {
    const loaded = await loadPanelTimeline(manifestPath);
    assert.deepEqual(loaded.timeline, timeline);
    assert.equal(Object.keys(loaded.source_hashes).length, 4);
    assert.equal(loaded.source_hashes[manifestPath], hash(await fs.readFile(manifestPath)));
    assert.equal(loaded.audio, null);
    for (const asset of loaded.assets) {
      assert.ok(path.isAbsolute(asset.path));
      assert.ok(asset.data_url.startsWith('data:image/png;base64,'));
      assert.equal(hash(await fs.readFile(asset.path)), asset.sha256);
    }
  });
  await test('loader refuses stale, remote and non-raster inputs', async () => {
    const saveBad = async (name, mutate) => {
      const bad = structuredClone(timeline); mutate(bad);
      const file = path.join(root, `${name}.json`); await fs.writeFile(file, JSON.stringify(bad)); return file;
    };
    await assert.rejects(loadPanelTimeline(await saveBad('stale', t => { t.assets[0].sha256 = '0'.repeat(64); })), /stale source hash/);
    await assert.rejects(loadPanelTimeline(await saveBad('remote', t => { t.assets[0].path = 'https://example.invalid/image.png'; })), /only local/);
    const textPath = path.join(root, 'text.png'); await fs.writeFile(textPath, 'not an image');
    await assert.rejects(loadPanelTimeline(await saveBad('non-raster', t => { t.assets[0].path = textPath; t.assets[0].sha256 = hash('not an image'); })), /image|format|raster/i);
  });
  await test('review editor rejects malformed overrides without mutating the last valid export', async () => {
    const loaded = await loadPanelTimeline(manifestPath);
    const browser = await chromium.launch({ executablePath: process.env.ANIFACTORY_CHROMIUM_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(createPanelReviewHtml({ timeline: loaded.timeline, assets: loaded.assets }));
      await page.evaluate(() => window.panelProofReady);
      await page.evaluate(() => {
        const create = URL.createObjectURL.bind(URL);
        URL.createObjectURL = blob => { window.exportedText = blob.text(); return create(blob); };
      });
      const exported = async () => {
        await page.click('#download');
        return JSON.parse(await page.evaluate(() => window.exportedText));
      };
      assert.deepEqual(await exported(), timeline);
      await page.evaluate(() => {
        const editor = document.getElementById('editor'); const scene = JSON.parse(editor.value);
        delete scene.layers[0].keyframes[0].rect.width;
        editor.value = JSON.stringify(scene); document.getElementById('apply').click();
      });
      assert.match(await page.locator('#status').textContent(), /rect.width/);
      assert.deepEqual(await exported(), timeline, 'Invalid edits must not enter a downloaded candidate.');
      await page.evaluate(() => {
        const editor = document.getElementById('editor'); const scene = JSON.parse(editor.value);
        scene.layers[0].keyframes[0].rect.width = 0.3;
        editor.value = JSON.stringify(scene); document.getElementById('apply').click();
      });
      assert.match(await page.locator('#status').textContent(), /Preview updated/);
      const edited = await exported(); validatePanelTimeline(edited);
      const expected = structuredClone(timeline); expected.scenes[0].layers[0].keyframes[0].rect.width = 0.3;
      assert.deepEqual(edited, expected, 'A valid override changes only the authored field.');
    } finally { await browser.close(); }
  });
  await test('fractional opacity composites the complete incoming panel once', async () => {
    const loaded = await loadPanelTimeline(manifestPath);
    const blend = structuredClone(timeline);
    const overlay = blend.scenes[0].layers[1];
    overlay.start_sec = 0; overlay.fit = 'cover';
    overlay.keyframes = [key(0, viewport), key(1, viewport)].map(k => ({ ...k, opacity: 0.5 }));
    validatePanelTimeline(blend);
    const browser = await chromium.launch({ executablePath: process.env.ANIFACTORY_CHROMIUM_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(createPanelReviewHtml({ timeline: blend, assets: loaded.assets }));
      await page.evaluate(() => window.panelProofReady);
      const pixel = await page.evaluate(() => {
        window.renderPanelFrame(0);
        return [...document.getElementById('panel-canvas').getContext('2d').getImageData(60, 90, 1, 1).data];
      });
      assert.ok(pixel.slice(0, 3).every((v, i) => Math.abs(v - [128, 128, 0][i]) <= 1), `A 50% green panel over red must blend once, got ${pixel}`);
      assert.equal(pixel[3], 255);
    } finally { await browser.close(); }
  });

  const options = { manifestPath, allowDirtyWorktree: true, dirtyReason: 'Bounded synthetic panel-engine regression fixture; existing worktree changes remain untouched.' };
  await test('inspection and provenance failures do not create output or change source assets', async () => {
    const before = await fs.readdir(root);
    const inspected = await inspectPanelLayoutProof({ manifestPath });
    assert.equal(inspected.frame_count, 60); assert.equal(inspected.production_eligible, false);
    assert.deepEqual(await fs.readdir(root), before);
    const outputDir = path.join(root, 'must-not-render');
    await assert.rejects(renderPanelLayoutProof({ ...options, manifestPath: path.join(root, 'stale.json'), outputDir }), /stale source hash/);
    await assert.rejects(fs.access(outputDir), { code: 'ENOENT' });
    await assert.rejects(renderPanelLayoutProof({ ...options, outputDir: path.join(root, 'page.png') }), /already exists|overwritten/);
    await assert.rejects(renderPanelLayoutProof({ ...options, outputDir: path.join(root, 'episodes', 'must-not-exist') }), /episode directories/);
    for (const asset of timeline.assets) assert.equal(hash(await fs.readFile(path.join(root, asset.path))), asset.sha256);
  });

  await test('probe verification rejects frame loss, drift and unwanted audio', () => {
    const valid = { streams: [{ codec_type: 'video', width: 320, height: 180, avg_frame_rate: '30/1', codec_name: 'h264', pix_fmt: 'yuv420p', nb_read_frames: '60', duration: '2' }], format: { duration: '2' } };
    assert.equal(assertPanelProofProbe({ probe: valid, timeline, audioExpected: false }).frame_count, 60);
    const fewer = structuredClone(valid); fewer.streams[0].nb_read_frames = '59';
    assert.throws(() => assertPanelProofProbe({ probe: fewer, timeline, audioExpected: false }), /frame count/);
    const longer = structuredClone(valid); longer.format.duration = '2.1';
    assert.throws(() => assertPanelProofProbe({ probe: longer, timeline, audioExpected: false }), /duration/);
    const unwanted = structuredClone(valid); unwanted.streams.push({ codec_type: 'audio', codec_name: 'aac', duration: '2' });
    assert.throws(() => assertPanelProofProbe({ probe: unwanted, timeline, audioExpected: false }), /unexpectedly contains audio/);
    const samples = panelProofSampleFrames(timeline);
    assert.ok(samples.includes(0) && samples.includes(29) && samples.includes(30) && samples.includes(59));
    assert.deepEqual([...new Set(samples)].sort((a, b) => a - b), samples);
  });

  // A small known waveform proves source-offset handling without a TTS provider.
  const rate = 48000, audioFrames = rate * 4, pcm = Buffer.alloc(44 + audioFrames * 2);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(rate, 24); pcm.writeUInt32LE(rate * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36); pcm.writeUInt32LE(audioFrames * 2, 40);
  for (let i = rate; i < audioFrames; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.12 * 32767), 44 + i * 2);
  const audioPath = path.join(root, 'known-wave.wav'); await fs.writeFile(audioPath, pcm);
  timeline.audio_target = 'narrator_only'; timeline.audio = { path: 'known-wave.wav', sha256: hash(pcm), offset_sec: 1 };
  await test('audio playlists cannot hide unhashed nested sources behind a valid audio probe', async () => {
    const playlist = "ffconcat version 1.0\nfile 'known-wave.wav'\nduration 4\n";
    const playlistPath = path.join(root, 'nested-audio.ffconcat');
    await fs.writeFile(playlistPath, playlist);
    const nested = structuredClone(timeline);
    nested.audio.path = 'nested-audio.ffconcat'; nested.audio.sha256 = hash(playlist);
    const nestedManifest = path.join(root, 'nested-audio.json'); await fs.writeFile(nestedManifest, JSON.stringify(nested));
    const outputDir = path.join(root, 'nested-audio-must-not-render');
    await assert.rejects(inspectPanelLayoutProof({ manifestPath: nestedManifest }), /format|concat|whitelist/i);
    await assert.rejects(renderPanelLayoutProof({ ...options, manifestPath: nestedManifest, outputDir }), /format|concat|whitelist/i);
    await assert.rejects(fs.access(outputDir), { code: 'ENOENT' });
    assert.equal(hash(await fs.readFile(audioPath)), hash(pcm));
  });
  // Deliberately not an exact frame boundary: keep the narration and authored
  // intervals intact while representing video duration at the nearest frame.
  timeline.duration_sec = 2.012; timeline.scenes[1].end_sec = 2.012;
  timeline.scenes[1].layers[0].end_sec = 2.012; timeline.scenes[1].layers[0].keyframes[1].at_sec = 2.012;
  await fs.writeFile(manifestPath, JSON.stringify(timeline));
  const outputDir = path.join(root, 'render');
  let rendered;
  await test('real browser/FFmpeg export preserves timings, hashes, source offset and exact frame count', async () => {
    const before = JSON.stringify(timeline);
    const inspection = await inspectPanelLayoutProof({ manifestPath });
    assert.equal(inspection.frame_count, 60);
    assert.equal(inspection.duration_sec, 2.012);
    rendered = await renderPanelLayoutProof({ ...options, outputDir });
    assert.equal(rendered.status, 'passed'); assert.equal(rendered.production_eligible, false);
    assert.equal(rendered.cost_usd, 0); assert.equal(rendered.media.frame_count, 60);
    assert.equal(rendered.frames_written, 60); assert.equal(rendered.media.width, 320); assert.equal(rendered.media.height, 180);
    assert.equal(rendered.media.fps, 30); assert.equal(rendered.media.audio_codec, 'aac');
    assert.equal(rendered.source_audio.source_offset_sec, 1);
    assert.equal(rendered.output.sha256, hash(await fs.readFile(rendered.output.path)));
    assert.equal(hash(await fs.readFile(audioPath)), timeline.audio.sha256);
    const exportedTimeline = JSON.parse(await fs.readFile(path.join(outputDir, 'timeline.json'), 'utf8'));
    const portable = structuredClone(timeline);
    for (const asset of portable.assets) asset.path = await fs.realpath(path.join(root, asset.path));
    portable.audio.path = await fs.realpath(audioPath);
    assert.deepEqual(exportedTimeline, portable, 'Only paths become absolute in the reusable exported timeline.');
    await loadPanelTimeline(path.join(outputDir, 'timeline.json'));
    assert.equal(JSON.stringify(timeline), before);
    const events = (await fs.readFile(path.join(outputDir, 'execution_events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(e => e.event), ['render_started', 'render_passed']);
    for (const frame of rendered.frames) assert.equal(frame.sha256, hash(await fs.readFile(frame.path)));
    for (const frame of rendered.decoded_frames) assert.equal(frame.sha256, hash(await fs.readFile(frame.path)));
  });

  const sample = async frame => {
    const result = await run('ffmpeg', ['-v', 'error', '-i', rendered.output.path, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    return sharp(result.stdout).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  };
  const color = (frame, x, y, expected, label, tolerance = 15) => {
    const offset = (y * frame.info.width + x) * frame.info.channels;
    const actual = [...frame.data.subarray(offset, offset + 3)];
    assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance), `${label}: ${actual} != ${expected}`);
  };
  await test('encoded pixels show page traversal, late reaction overlap and exact scene replacement', async () => {
    const first = await sample(0); color(first, 60, 90, [255, 0, 0], 'Page begins at its red top');
    const before = await sample(14); color(before, 245, 50, [0, 0, 0], 'Reaction is absent before its authored onset');
    const overlap = await sample(27); color(overlap, 60, 90, [0, 0, 255], 'Page traverses to its blue bottom'); color(overlap, 245, 50, [0, 255, 0], 'Reaction overlaps while prior panel remains');
    const boundary = await sample(30); color(boundary, 160, 90, [255, 255, 0], 'At exact scene boundary only cropped yellow source region remains');
    color(boundary, 10, 90, [51, 51, 0], 'Shared background uses the cropped artwork');
    color(boundary, 70, 90, [16, 18, 24], 'Contain fit keeps its aspect-ratio margin');
  });

  await test('decoded audio skips the silent source lead and preserves the canonical source bytes', async () => {
    const result = await run('ffmpeg', ['-v', 'error', '-i', rendered.output.path, '-map', '0:a:0', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 });
    for (const [start, end] of [[0.1, 0.4], [1.6, 1.9]]) {
      let sum = 0, peak = 0;
      for (let i = Math.floor(start * rate); i < Math.floor(end * rate); i++) { const v = result.stdout.readFloatLE(i * 4); assert.ok(Number.isFinite(v)); sum += v * v; peak = Math.max(peak, Math.abs(v)); }
      const rms = Math.sqrt(sum / Math.floor((end - start) * rate));
      assert.ok(rms > 0.07 && rms < 0.1, `Source window ${start}..${end} must contain unchanged-level tone, got ${rms}`);
      assert.ok(peak < 0.2);
    }
    assert.equal(hash(await fs.readFile(audioPath)), hash(pcm));
  });

  await test('a second export cannot overwrite an existing video or its retained report', async () => {
    const reportPath = path.join(outputDir, 'render_report.json');
    const before = hash(await fs.readFile(reportPath));
    await assert.rejects(renderPanelLayoutProof({ ...options, outputDir }), /already exists|overwritten/);
    assert.equal(hash(await fs.readFile(reportPath)), before);
    assert.equal(hash(await fs.readFile(rendered.output.path)), rendered.output.sha256);
  });
} finally {
  if (process.env.GOLDFLOW_KEEP_PANEL_FIXTURE === '1') process.stdout.write(`Retained synthetic panel fixture: ${root}\n`);
  else await fs.rm(root, { recursive: true, force: true });
}
process.stdout.write(`Panel layout: ${count} test groups passed.\n`);
