import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { sha256File } from '../lib/file-hash.mjs';
import { validatePanelTimeline } from '../lib/panel-layout-validation.mjs';
import { loadPanelExperimentTimeline, validatePanelExperimentTimeline } from '../lib/panel-experiment-contract.mjs';
import { planPanelExperimentChunks, panelExperimentChunkKey, renderPanelExperiment } from '../lib/panel-experiment-renderer.mjs';
import { createPanelReviewHtml } from '../lib/panel-layout-review.mjs';

const exec = promisify(execFile);
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'panel-experiment-tests-')));
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const key = (at_sec, y) => ({ at_sec, rect: { x: 0, y: 0, width: 1, height: 1 }, camera: { x: 0.5, y, zoom: 1 }, opacity: 1, easing: 'smooth' });
let checks = 0;
const test = async (name, run) => { await run(); checks++; console.log(`ok - experiment renderer: ${name}`); };
try {
  const artwork = path.join(root, 'page.png');
  await sharp({ create: { width: 240, height: 720, channels: 3, background: '#ff2020' } }).composite([
    { input: await sharp({ create: { width: 240, height: 240, channels: 3, background: '#20ff20' } }).png().toBuffer(), top: 240, left: 0 },
    { input: await sharp({ create: { width: 240, height: 240, channels: 3, background: '#2020ff' } }).png().toBuffer(), top: 480, left: 0 },
  ]).png().toFile(artwork);
  const audio = path.join(root, 'narration.wav');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=320:duration=3:sample_rate=48000', '-c:a', 'pcm_s16le', audio]);
  const source = path.join(root, 'source.txt'); await fs.writeFile(source, 'Synthetic engine fixture. No production episode or provider calls.');
  const identityPath = path.join(root, 'identity.json');
  const identity = { schema: 'goldflow_panel_experiment_identity_v1', id: 'chunk-fixture', channel: 'fixture', series: 'engine-tests', episode: 'sample', title: 'Synthetic absolute-frame cache test', content_profile: 'manhwa_recap_v1', source_mode: 'original_story', visibility: 'private_review', provider_policy: 'local_artifacts_only', scope: { max_duration_sec: 1800, source_start_sec: 0.25, source_end_sec: 2.262 }, source: { path: 'source.txt', sha256: await sha256File(source) } };
  await writeJson(identityPath, identity);
  const timeline = { schema: 'goldflow_panel_experiment_timeline_v1', id: identity.id, intent: 'editing_experiment', content_profile: 'manhwa_recap_v1', experiment_identity: { path: 'identity.json', sha256: await sha256File(identityPath) }, width: 160, height: 90, fps: 30, duration_sec: 2.012, audio_target: 'narrator_only', audio: { path: 'narration.wav', sha256: await sha256File(audio), offset_sec: 0.25 },
    assets: [{ id: 'page', path: 'page.png', sha256: await sha256File(artwork), origin: 'test_fixture', provenance: 'Locally authored color page.' }],
    panels: [{ id: 'page-panel', asset_id: 'page', source_rect: { x: 0, y: 0, width: 1, height: 1 } }],
    scenes: [{ id: 'continuous-page', start_sec: 0, end_sec: 2.012, background: { panel_id: 'page-panel', blur_px: 0, brightness: 0 }, layers: [{ id: 'page-traversal', panel_id: 'page-panel', start_sec: 0, end_sec: 2.012, z: 0, fit: 'cover', border_px: 0, keyframes: [key(0, 0), key(1, 0.5), key(2.012, 1)] }] }] };
  const timelinePath = path.join(root, 'timeline.json'); await writeJson(timelinePath, timeline);
  let loaded;
  await test('separate schema, external identity, exact audio scope and lazy asset loading', async () => {
    assert.throws(() => validatePanelTimeline(timeline), /schema|engine_proof/);
    assert.equal(validatePanelExperimentTimeline(timeline), timeline);
    loaded = await loadPanelExperimentTimeline(timelinePath);
    assert.equal(loaded.assets[0].data_url, undefined);
    assert.equal(loaded.identity.id, timeline.id);
    assert.equal(loaded.audio.path, audio);
    assert.ok(loaded.source_hashes[identityPath]); assert.ok(loaded.source_hashes[source]);
    const wrong = structuredClone(timeline); wrong.audio.offset_sec = 0;
    await writeJson(path.join(root, 'wrong-window.json'), wrong);
    await assert.rejects(loadPanelExperimentTimeline(path.join(root, 'wrong-window.json')), /window/);
    const tooLong = structuredClone(timeline); tooLong.duration_sec = 1801;
    assert.throws(() => validatePanelExperimentTimeline(tooLong), /1800|duration/);
    const old = { ...timeline, schema: 'goldflow_panel_timeline_v1', intent: 'engine_proof', duration_sec: 151 };
    assert.throws(() => validatePanelTimeline(old), /150|duration/);
  });
  const chunks = planPanelExperimentChunks(timeline, { chunkDurationSec: 1 });
  await test('absolute frame partition does not trim or renormalize smooth keys', () => {
    assert.deepEqual(chunks.map(c => [c.start_frame, c.end_frame]), [[0, 30], [30, 60]]);
    assert.deepEqual(chunks[1].scenes[0].layers[0].keyframes, timeline.scenes[0].layers[0].keyframes);
    assert.equal(chunks[1].start_sec, 1);
    const changed = structuredClone(timeline); changed.scenes[0].layers[0].keyframes[2].camera.y = 0.75;
    const changedChunks = planPanelExperimentChunks(changed, { chunkDurationSec: 1 });
    const cacheKey = (t, c) => panelExperimentChunkKey({ timeline: t, chunk: c, assets: loaded.assets, code_hashes: {}, environment: {} });
    assert.equal(cacheKey(timeline, chunks[0]), cacheKey(changed, changedChunks[0]));
    assert.notEqual(cacheKey(timeline, chunks[1]), cacheKey(changed, changedChunks[1]));
  });
  const options = { timelinePath, cacheDir: path.join(root, 'cache'), allowDirtyWorktree: true, dirtyReason: 'Synthetic bounded renderer regression; preserve unrelated workspace edits.', chunkDurationSec: 1 };
  let first;
  await test('real multi-chunk lossless cache renders exact continuous narration and decoded boundary frames', async () => {
    first = await renderPanelExperiment({ ...options, outputDir: path.join(root, 'first') });
    assert.equal(first.status, 'passed'); assert.equal(first.rendered_chunk_count, 2); assert.equal(first.reused_chunk_count, 0);
    assert.equal(first.picture_cache_codec, 'libx264rgb/crf0/veryfast/gbrp/full-range/png-input');
    assert.equal(first.media.frame_count, 60); assert.equal(first.media.pixel_format, 'yuv420p');
    assert.ok(Math.abs(first.media.duration_sec - 2.012) < 0.001);
    const mid = first.frames.find(row => row.frame === 30);
    const { data, info } = await sharp(mid.path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const index = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
    assert.ok(data[index + 1] > 220 && data[index] < 60 && data[index + 2] < 60, 'second chunk starts on the authored green midpoint, without restarting the page pan');
    const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', first.output.path])).stdout);
    assert.ok(Math.abs(Number(probe.streams.find(row => row.codec_type === 'audio').duration) - 2.012) < 0.001);
  });
  await test('identical attempt reuses both verified chunks; cache receipts remain immutable', async () => {
    const legacyDir = path.join(path.dirname(path.dirname(first.chunks[0].path)), 'attempt-ffffffff-ffff-ffff-ffff-ffffffffffff');
    await fs.mkdir(legacyDir);
    await fs.copyFile(first.chunks[0].path, path.join(legacyDir, 'clip.mkv'));
    const legacyReceipt = { ...JSON.parse(await fs.readFile(first.chunks[0].receipt_path, 'utf8')), schema: 'goldflow_panel_chunk_receipt_v1', codec: 'ffv1/bgr0/png-input' };
    const legacyReceiptPath = path.join(legacyDir, 'receipt.json'); await writeJson(legacyReceiptPath, legacyReceipt);
    const legacyHash = await sha256File(legacyReceiptPath);
    const next = await renderPanelExperiment({ ...options, outputDir: path.join(root, 'same') });
    assert.equal(next.reused_chunk_count, 2); assert.equal(next.rendered_chunk_count, 0);
    assert.deepEqual(next.chunks.map(row => row.path), first.chunks.map(row => row.path));
    assert.match(next.chunks[0].rejected_cache_attempts[0].reason, /version, codec/);
    assert.equal(await sha256File(legacyReceiptPath), legacyHash, 'old version receipts are retained without migration or mutation');
    await assert.rejects(renderPanelExperiment({ ...options, outputDir: path.join(root, 'same') }), /already exists|immutable/);
  });
  await test('late camera edit invalidates only its dependent chunk and preserves accepted earlier bytes', async () => {
    const edited = structuredClone(timeline); edited.scenes[0].layers[0].keyframes[2].camera.y = 0.75;
    const file = path.join(root, 'edited.json'); await writeJson(file, edited);
    const result = await renderPanelExperiment({ ...options, timelinePath: file, outputDir: path.join(root, 'edited') });
    assert.equal(result.reused_chunk_count, 1); assert.equal(result.rendered_chunk_count, 1);
    assert.equal(result.chunks[0].path, first.chunks[0].path);
    assert.equal(await sha256File(first.chunks[0].path), first.chunks[0].sha256);
    assert.notEqual(result.chunks[1].cache_key, first.chunks[1].cache_key);
  });
  await test('stationary frames share one capture while movement and an entering overlay recapture exact states', async () => {
    const holds = structuredClone(timeline);
    const main = holds.scenes[0].layers[0];
    main.keyframes = [key(0, 0), key(10 / 30, 0), key(20 / 30, 1), key(2.012, 1)].map(row => ({ ...row, easing: 'linear' }));
    const entry = 25 / 30;
    holds.scenes[0].layers.push({ ...main, id: 'entry-reaction', start_sec: entry, z: 1, keyframes: [entry, 2.012].map(at => ({ ...key(at, 0), rect: { x: 0.6, y: 0.2, width: 0.3, height: 0.5 } })) });
    const file = path.join(root, 'holds.json'); await writeJson(file, holds);
    const result = await renderPanelExperiment({ ...options, timelinePath: file, outputDir: path.join(root, 'holds'), chunkDurationSec: 10 / 30 });
    assert.equal(result.media.frame_count, 60);
    assert.deepEqual(result.chunks.slice(0, 3).map(row => row.capture_count), [1, 10, 2]);
    assert.equal(result.captured_frame_count, 16);
    assert.equal(result.unchanged_frame_reuse_count, 44);
    const before = result.frames.find(row => row.frame === 20), after = result.frames.find(row => row.frame === 25);
    assert.ok(before && after, 'decoded QA includes the hold and overlay-entry frame');
    const pixel = async file => { const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true }); const offset = (Math.floor(info.height * 0.45) * info.width + Math.floor(info.width * 0.75)) * info.channels; return [...data.subarray(offset, offset + 3)]; };
    const held = await pixel(before.path), entered = await pixel(after.path);
    assert.ok(held[2] > 220 && held[0] < 60, 'stationary blue page retained');
    assert.ok(entered[0] > 220 && entered[2] < 60, 'red reaction appears on its authored entry frame');
  });
  await test('lossless RGB cache matches every Canvas and FFV1 pixel through motion, partial opacity and entry', async () => {
    const moving = structuredClone(timeline);
    moving.scenes[0].background = { panel_id: 'page-panel', blur_px: 8, brightness: 0.6 };
    moving.scenes[0].layers[0].keyframes.forEach(row => { row.rect = { x: 0.05, y: 0.08, width: 0.68, height: 0.86 }; });
    moving.scenes[0].layers.push({ id: 'translucent-entry', panel_id: 'page-panel', start_sec: 12 / 30, end_sec: 2.012, z: 1, fit: 'cover', border_px: 3, keyframes: [
      { ...key(12 / 30, 0), rect: { x: 1.02, y: 0.3, width: 0.34, height: 0.58 }, opacity: 0 },
      { ...key(1, 0.5), rect: { x: 0.55, y: 0.15, width: 0.34, height: 0.58 }, opacity: 0.55 },
      { ...key(2.012, 1), rect: { x: 0.6, y: 0.22, width: 0.34, height: 0.58 }, opacity: 1 },
    ] });
    const file = path.join(root, 'exact-pixels.json'); await writeJson(file, moving);
    const result = await renderPanelExperiment({ ...options, timelinePath: file, outputDir: path.join(root, 'exact-pixels') });
    const assets = [{ ...loaded.assets[0], data_url: `data:image/png;base64,${(await sharp(artwork).rotate().png().toBuffer()).toString('base64')}` }];
    const expected = [], pngDir = path.join(root, 'canvas-frames'); await fs.mkdir(pngDir);
    const browser = await chromium.launch({ executablePath: process.env.ANIFACTORY_CHROMIUM_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: moving.width, height: moving.height }, deviceScaleFactor: 1 });
      await page.setContent(createPanelReviewHtml({ timeline: moving, assets, audioUrl: null }));
      await page.evaluate(async () => { await window.panelProofReady; });
      for (let frame = 0; frame < 60; frame++) {
        const png = Buffer.from(await page.evaluate(time => { window.renderPanelFrame(time); return document.getElementById('panel-canvas').toDataURL('image/png').split(',')[1]; }, frame / moving.fps), 'base64');
        expected.push(await sharp(png).removeAlpha().raw().toBuffer());
        await fs.writeFile(path.join(pngDir, `frame-${String(frame).padStart(3, '0')}.png`), png);
      }
    } finally { await browser.close(); }
    const rgb = async file => (await exec('ffmpeg', ['-v', 'error', '-threads', '0', '-i', file, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { encoding: null, maxBuffer: 16 * 1024 * 1024 })).stdout;
    const actual = Buffer.concat(await Promise.all(result.chunks.map(row => rgb(row.path))));
    const baseline = path.join(root, 'ffv1-baseline.mkv');
    await exec('ffmpeg', ['-v', 'error', '-n', '-framerate', '30', '-i', path.join(pngDir, 'frame-%03d.png'), '-an', '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'bgr0', '-color_range', 'pc', baseline]);
    const former = await rgb(baseline), canvas = Buffer.concat(expected), digest = bytes => createHash('sha256').update(bytes).digest('hex');
    assert.equal(actual.length, canvas.length); assert.equal(digest(actual), digest(canvas), 'every decoded RGB H.264 pixel equals its authored absolute-time Canvas frame');
    assert.equal(digest(actual), digest(former), 'new temporal cache has identical decoded pixels to the previous FFV1 codec');
    const receipt = JSON.parse(await fs.readFile(result.chunks[0].receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'goldflow_panel_chunk_receipt_v2');
    assert.equal(receipt.codec, result.picture_cache_codec);
  });
  await test('corrupt cache bytes are rejected without overwriting receipts or rebuilding healthy chunks', async () => {
    const originalReceipt = await fs.readFile(first.chunks[1].receipt_path, 'utf8');
    await fs.appendFile(first.chunks[1].path, 'external fixture corruption');
    const result = await renderPanelExperiment({ ...options, outputDir: path.join(root, 'repaired-cache') });
    assert.equal(result.reused_chunk_count, 1); assert.equal(result.rendered_chunk_count, 1);
    assert.equal(result.chunks[0].path, first.chunks[0].path);
    assert.notEqual(result.chunks[1].path, first.chunks[1].path);
    assert.equal(await fs.readFile(first.chunks[1].receipt_path, 'utf8'), originalReceipt);
    assert.equal(result.chunks[1].rejected_cache_attempts.length, 1);
  });
  await test('original story packets cannot conceal changed nested approvals', async () => {
    const approvalPath = path.join(root, 'approval.json'); await writeJson(approvalPath, { decision: 'accepted', script_hash: 'a'.repeat(64) });
    const packetPath = path.join(root, 'source-packet.json'); await writeJson(packetPath, { schema: 'goldflow_original_panel_source_packet_v1', source_hashes: { [approvalPath]: await sha256File(approvalPath) } });
    const nestedIdentity = { ...identity, source: { path: 'source-packet.json', sha256: await sha256File(packetPath) } };
    const nestedIdentityPath = path.join(root, 'nested-identity.json'); await writeJson(nestedIdentityPath, nestedIdentity);
    const nested = { ...timeline, experiment_identity: { path: 'nested-identity.json', sha256: await sha256File(nestedIdentityPath) } };
    const nestedTimelinePath = path.join(root, 'nested-timeline.json'); await writeJson(nestedTimelinePath, nested);
    const checked = await loadPanelExperimentTimeline(nestedTimelinePath); assert.equal(checked.source_hashes[approvalPath], await sha256File(approvalPath));
    await writeJson(approvalPath, { decision: 'declined' });
    const outputDir = path.join(root, 'stale-approval');
    await assert.rejects(renderPanelExperiment({ ...options, timelinePath: nestedTimelinePath, outputDir }), /stale.*hash/);
    await assert.rejects(fs.stat(outputDir), { code: 'ENOENT' });
  });
  await test('nested audio and stale identity source block before output creation', async () => {
    const playlist = path.join(root, 'audio.ffconcat'); await fs.writeFile(playlist, "ffconcat version 1.0\nfile 'narration.wav'\n");
    const nested = structuredClone(timeline); nested.audio.path = 'audio.ffconcat'; nested.audio.sha256 = await sha256File(playlist);
    const nestedPath = path.join(root, 'nested.json'); await writeJson(nestedPath, nested);
    const outputDir = path.join(root, 'nested');
    await assert.rejects(renderPanelExperiment({ ...options, timelinePath: nestedPath, outputDir }), /format|concat|whitelist/i);
    await assert.rejects(fs.stat(outputDir), { code: 'ENOENT' });
    await fs.appendFile(source, '\nchanged');
    await assert.rejects(loadPanelExperimentTimeline(timelinePath), /stale/);
  });
  console.log(`panel experiment renderer tests passed: ${checks}`);
} finally {
  if (process.env.PANEL_EXPERIMENT_KEEP_FIXTURE === 'true') console.log(`retained fixture: ${root}`);
  else await fs.rm(root, { recursive: true, force: true });
}
