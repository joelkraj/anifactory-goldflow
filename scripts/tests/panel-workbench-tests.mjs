import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { sha256File } from '../lib/file-hash.mjs';
import { parsePanelWorkbenchArgs, runPanelWorkbenchCli } from '../panel-workbench.mjs';
import { writePanelExperimentReview } from '../lib/panel-experiment-review.mjs';
import { createPanelReviewHtml } from '../lib/panel-layout-review.mjs';
import { validatePanelTimeline } from '../lib/panel-layout-validation.mjs';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'panel-workbench-tests-')));
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
let count = 0, browser;
const test = async (name, run) => { await run(); count++; console.log(`ok - panel workbench: ${name}`); };
function wav(samples, rate = 48000) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => out.writeInt16LE(sample, 44 + index * 2)); return out;
}
function pcmChunk(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  for (let i = 12; i + 8 <= bytes.length;) { const size = bytes.readUInt32LE(i + 4); if (bytes.toString('ascii', i, i + 4) === 'data') return bytes.subarray(i + 8, i + 8 + size); i += 8 + size + size % 2; }
  throw new Error('Missing PCM data');
}

try {
  await test('CLI routes explicit options and rejects unknown, duplicate and invalid values', () => {
    assert.throws(() => parsePanelWorkbenchArgs([]), /Usage/);
    assert.throws(() => parsePanelWorkbenchArgs(['validate']), /timeline.*required/);
    assert.throws(() => parsePanelWorkbenchArgs(['validate', '--timeline', 'a.json', '--timeline', 'b.json']), /duplicate/);
    assert.throws(() => parsePanelWorkbenchArgs(['validate', '--timeline', 'a.json', '--publish', 'true']), /Invalid/);
    assert.throws(() => parsePanelWorkbenchArgs(['review', '--timeline', 'a.json', '--output-dir', 'out', '--start-sec', 'NaN']), /finite/);
    assert.throws(() => parsePanelWorkbenchArgs(['review', '--timeline', 'a.json', '--output-dir', 'out', '--end-sec', 'Infinity']), /finite/);
    assert.throws(() => parsePanelWorkbenchArgs(['render', '--timeline', 'a', '--output-dir', 'b', '--cache-dir', 'c', '--allow-dirty-worktree', 'yes']), /true or false/);
    assert.throws(() => parsePanelWorkbenchArgs(['render', '--timeline', 'a', '--output-dir', 'b', '--cache-dir', 'c', '--allow-dirty-worktree', 'true']), /dirty-reason/);
    const parsed = parsePanelWorkbenchArgs(['review', '--timeline', 'sample.json', '--output-dir', 'review', '--start-sec', '2.25', '--end-sec', '3.75']);
    assert.equal(parsed.startSec, 2.25); assert.equal(parsed.endSec, 3.75); assert.ok(path.isAbsolute(parsed.timelinePath));
    const adapt = parsePanelWorkbenchArgs(['review-adaptation', '--adaptation-dir', 'candidate', '--reviewer', 'Reviewer', '--note', 'Exact source reviewed', '--attestation', 'source_and_adaptation_reviewed']);
    assert.equal(adapt.attestation, 'source_and_adaptation_reviewed'); assert.equal(adapt.reviewer, 'Reviewer');
  });
  const sourcePath = path.join(root, 'source.txt'); await fs.writeFile(sourcePath, 'Synthetic red / green / blue scoped player fixture.');
  const identityPath = path.join(root, 'identity.json');
  await writeJson(identityPath, { schema: 'goldflow_panel_experiment_identity_v1', id: 'scoped-player', channel: 'fixture', series: 'tests', episode: 'sample', title: 'Scoped review fixture', content_profile: 'manhwa_recap_v1', source_mode: 'original_story', visibility: 'private_review', provider_policy: 'local_artifacts_only', scope: { max_duration_sec: 1800, source_start_sec: 0.5, source_end_sec: 6.5 }, source: { path: sourcePath, sha256: await sha256File(sourcePath) } });
  const samples = Int16Array.from({ length: 7 * 48000 }, (_, i) => Math.round(8000 * Math.sin(2 * Math.PI * (200 + 100 * Math.floor(i / 48000)) * i / 48000)));
  const audioPath = path.join(root, 'narration.wav'); await fs.writeFile(audioPath, wav(samples));
  const assets = [];
  for (const [id, color] of [['red', '#ff2020'], ['green', '#20ff20'], ['blue', '#2020ff']]) {
    const file = path.join(root, `${id}.png`); await sharp({ create: { width: 160, height: 90, channels: 3, background: color } }).png().toFile(file);
    assets.push({ id, path: file, sha256: await sha256File(file), origin: 'test_fixture', provenance: 'Synthetic browser review color fixture.' });
  }
  const frame = at_sec => ({ at_sec, rect: { x: 0, y: 0, width: 1, height: 1 }, camera: { x: 0.5, y: 0.5, zoom: 1 }, opacity: 1, easing: 'linear' });
  const timeline = { schema: 'goldflow_panel_experiment_timeline_v1', id: 'scoped-player', intent: 'editing_experiment', content_profile: 'manhwa_recap_v1', experiment_identity: { path: identityPath, sha256: await sha256File(identityPath) }, width: 160, height: 90, fps: 30, duration_sec: 6, audio_target: 'narrator_only', audio: { path: audioPath, sha256: await sha256File(audioPath), offset_sec: 0.5 }, assets,
    panels: assets.map(asset => ({ id: asset.id, asset_id: asset.id, source_rect: { x: 0, y: 0, width: 1, height: 1 } })),
    scenes: assets.map((asset, i) => ({ id: asset.id, start_sec: i * 2, end_sec: i * 2 + 2, background: { panel_id: asset.id, blur_px: 0, brightness: 0 }, layers: [{ id: `${asset.id}-layer`, panel_id: asset.id, start_sec: i * 2, end_sec: i * 2 + 2, z: 0, fit: 'contain', border_px: 0, keyframes: [frame(i * 2), frame(i * 2 + 2)] }] })) };
  const timelinePath = path.join(root, 'timeline.json'); await writeJson(timelinePath, timeline);
  let reviewed;
  await test('CLI validates and prepares only a midtimeline artwork/audio window', async () => {
    const valid = await runPanelWorkbenchCli(['validate', '--timeline', timelinePath], { writeResult: false });
    assert.equal(valid.status, 'valid_private_experiment'); assert.equal(valid.scene_count, 3); assert.equal(valid.production_eligible, false);
    reviewed = await runPanelWorkbenchCli(['review', '--timeline', timelinePath, '--output-dir', path.join(root, 'review'), '--start-sec', '2.25', '--end-sec', '3.75'], { writeResult: false });
    assert.equal(reviewed.status, 'prepared'); assert.equal(reviewed.loaded_asset_count, 1);
    const pcm = pcmChunk(await fs.readFile(path.join(root, 'review', 'review-audio.wav')));
    assert.equal(pcm.length, 1.5 * 48000 * 3);
    for (let i = 0; i < 400; i++) assert.equal(pcm.readIntLE(i * 3, 3), samples[2.75 * 48000 + i] * 256, 'audio slice uses source offset + preview start without gain or retiming');
    const snapshot = JSON.parse(await fs.readFile(path.join(root, 'review', 'timeline.json'), 'utf8'));
    assert.equal(snapshot.scenes.length, 3); assert.equal(snapshot.duration_sec, 6); assert.equal(snapshot.audio.offset_sec, 0.5);
    await assert.rejects(writePanelExperimentReview({ timelinePath, outputDir: path.join(root, 'review'), startSec: 2.25, endSec: 3.75 }), /already exists/);
  });
  browser = await chromium.launch({ executablePath: process.env.ANIFACTORY_CHROMIUM_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ acceptDownloads: true });
  await page.goto(pathToFileURL(reviewed.review_path).href);
  await page.evaluate(async () => { await window.panelProofReady; });
  await page.waitForFunction(() => audio.readyState >= 1);
  await test('real browser starts on the correct scene and maps scrub time to excerpt audio', async () => {
    const state = await page.evaluate(() => ({ min: Number(scrub.min), max: Number(scrub.max), time, selector: [...select.options].map(option => ({ value: option.value, text: option.textContent })), pixel: [...ctx.getImageData(80, 45, 1, 1).data] }));
    assert.equal(state.min, 2.25); assert.equal(state.max, 3.75); assert.equal(state.time, 2.25);
    assert.deepEqual(state.selector.map(option => option.value), ['1']); assert.match(state.selector[0].text, /green/);
    assert.ok(state.pixel[1] > 240 && state.pixel[0] < 40 && state.pixel[2] < 40);
    await page.locator('#scrub').evaluate(element => { element.value = '3'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => time === 3 && Math.abs(audio.currentTime - 0.75) < 0.001);
    await page.locator('#play').click(); await page.waitForFunction(() => time > 3.03);
    await page.locator('#play').click();
    assert.ok((await page.evaluate(() => time)) <= 3.75);
  });
  await test('unloaded artwork edits are rejected atomically and full timeline export preserves other scenes', async () => {
    const before = await page.evaluate(() => JSON.stringify(timeline));
    const scene = structuredClone(timeline.scenes[1]); scene.background.panel_id = 'blue';
    await page.locator('details summary').click(); await page.locator('#editor').fill(JSON.stringify(scene)); await page.locator('#apply').click();
    assert.match(await page.locator('#status').textContent(), /outside this review window/);
    assert.equal(await page.evaluate(() => JSON.stringify(timeline)), before);
    const good = structuredClone(timeline.scenes[1]); good.layers[0].keyframes[0].camera.zoom = 1.1;
    await page.locator('#editor').fill(JSON.stringify(good)); await page.locator('#apply').click();
    assert.match(await page.locator('#status').textContent(), /Preview updated/);
    const download = page.waitForEvent('download'); await page.locator('#download').click();
    const saved = path.join(root, 'exported.json'); await (await download).saveAs(saved);
    const exported = JSON.parse(await fs.readFile(saved, 'utf8'));
    assert.equal(exported.scenes.length, 3); assert.equal(exported.assets.length, 3); assert.equal(exported.duration_sec, 6);
    assert.deepEqual(exported.scenes[0], timeline.scenes[0]); assert.deepEqual(exported.scenes[2], timeline.scenes[2]);
    assert.equal(exported.scenes[1].layers[0].keyframes[0].camera.zoom, 1.1);
    assert.equal(exported.experiment_identity.sha256, timeline.experiment_identity.sha256);
    assert.equal(exported.audio.offset_sec, 0.5);
  });
  await test('default proof player still starts at zero, shows all scenes, and retains the150-second cap', async () => {
    const proof = { ...timeline, schema: 'goldflow_panel_timeline_v1', intent: 'engine_proof', audio_target: 'silent_fixture', audio: null };
    validatePanelTimeline(proof);
    assert.throws(() => validatePanelTimeline({ ...proof, duration_sec: 151 }), /150|duration/);
    const loadedAssets = await Promise.all(assets.map(async asset => ({ ...asset, data_url: `data:image/png;base64,${(await fs.readFile(asset.path)).toString('base64')}` })));
    await page.goto('about:blank');
    await page.setContent(createPanelReviewHtml({ timeline: proof, assets: loadedAssets })); await page.evaluate(async () => { await window.panelProofReady; });
    const state = await page.evaluate(() => ({ min: Number(scrub.min), max: Number(scrub.max), time, sceneCount: select.options.length, pixel: [...ctx.getImageData(80, 45, 1, 1).data] }));
    assert.deepEqual({ min: state.min, max: state.max, time: state.time, sceneCount: state.sceneCount }, { min: 0, max: 6, time: 0, sceneCount: 3 });
    assert.ok(state.pixel[0] > 240 && state.pixel[1] < 40);
  });
  await test('preview endpoint keeps the scene label synchronized with the final visible frame', async () => {
    const green = assets.find(asset => asset.id === 'green');
    const loaded = [{ ...green, data_url: `data:image/png;base64,${(await fs.readFile(green.path)).toString('base64')}` }];
    await page.goto('about:blank');
    await page.setContent(createPanelReviewHtml({ timeline, assets: loaded, initialTimeSec: 2, previewStartSec: 2, previewEndSec: 4 })); await page.evaluate(async () => { await window.panelProofReady; });
    await page.locator('#scrub').evaluate(element => { element.value = '4'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => time === 4);
    assert.equal(await page.locator('#scene-label').textContent(), 'green');
    const pixel = await page.evaluate(() => [...ctx.getImageData(80, 45, 1, 1).data]); assert.ok(pixel[1] > 240 && pixel[2] < 40);
  });
  await test('short narration cannot produce a falsely ready scoped review', async () => {
    const shortAudio = path.join(root, 'too-short.wav'); await fs.writeFile(shortAudio, wav(samples.slice(0, 3 * 48000)));
    const shortTimeline = { ...timeline, audio: { ...timeline.audio, path: shortAudio, sha256: await sha256File(shortAudio) } };
    const shortPath = path.join(root, 'short-timeline.json'); await writeJson(shortPath, shortTimeline);
    const outputDir = path.join(root, 'short-review');
    await assert.rejects(writePanelExperimentReview({ timelinePath: shortPath, outputDir, startSec: 2.25, endSec: 3.75 }), /audio|narration|duration|window/i);
    await assert.rejects(fs.stat(outputDir), { code: 'ENOENT' });
  });
  console.log(`panel workbench tests passed: ${count}`);
} finally { await browser?.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); }
