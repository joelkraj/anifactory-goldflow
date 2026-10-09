import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { sha256File } from './file-hash.mjs';
import { loadPanelExperimentTimeline } from './panel-experiment-contract.mjs';
import { createPanelReviewHtml } from './panel-layout-review.mjs';
import { panelFrameState } from './panel-layout-runtime.mjs';
import { inspectPanelWorktree, assertPanelProofProbe } from './panel-layout-renderer.mjs';

const exec = promisify(execFile);
const ffmpeg = () => process.env.ANIFACTORY_FFMPEG_BIN || 'ffmpeg';
const ffprobe = () => process.env.ANIFACTORY_FFPROBE_BIN || 'ffprobe';
const formats = 'wav,flac,mp3,ogg,mov,aac';
const cacheCodec = 'libx264rgb/crf0/veryfast/gbrp/full-range/png-input';
const fail = message => { throw new Error(`Panel experiment render: ${message}`); };
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, row) => row && !Array.isArray(row) && typeof row === 'object' ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) : row);
const command = (bin, args, timeout = 120000) => exec(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LANG: 'C' } });
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function currentHashes(sourceHashes) {
  for (const [file, expected] of Object.entries(sourceHashes)) if (await sha256File(file) !== expected) fail(`source changed: ${file}`);
}

async function codeHashes() {
  const names = ['panel-experiment-renderer.mjs', 'panel-experiment-contract.mjs', 'panel-layout-renderer.mjs', 'panel-layout-review.mjs', 'panel-layout-validation.mjs', 'panel-layout-runtime.mjs'];
  return Object.fromEntries(await Promise.all(names.map(async name => { const file = fileURLToPath(new URL(name, import.meta.url)); return [file, await sha256File(file)]; })));
}

async function mediaProbe(file, { countFrames = false, losslessChunk = false } = {}) {
  return JSON.parse((await command(ffprobe(), ['-v', 'error', '-threads', '0', '-protocol_whitelist', 'file', '-format_whitelist', losslessChunk ? 'matroska' : formats, ...(countFrames ? ['-count_frames'] : []), '-show_streams', '-show_format', '-of', 'json', file], countFrames && !losslessChunk ? 30 * 60 * 1000 : 120000)).stdout);
}

async function sourceAudioInfo(loaded) {
  if (!loaded.audio) return null;
  const inspected = await mediaProbe(loaded.audio.path);
  const stream = inspected.streams.find(row => row.codec_type === 'audio');
  const duration = Number(stream?.duration ?? inspected.format?.duration);
  if (!stream || !Number.isFinite(duration) || duration + 1e-6 < loaded.audio.offset_sec + loaded.timeline.duration_sec) fail('narration does not cover the identity-bound source window');
  return { duration_sec: duration, sample_rate: Number(stream.sample_rate), codec: stream.codec_name, offset_sec: loaded.audio.offset_sec };
}

async function safeDirectory(value, mustBeNew = false) {
  if (!path.isAbsolute(value ?? '')) fail('output and cache directories must be absolute');
  const absolute = path.resolve(value);
  let parent = absolute;
  while (true) {
    if (parent.split(path.sep).includes('episodes') || await fs.stat(path.join(parent, 'run_identity.json')).then(() => true, () => false)) fail('experiment output/cache cannot be inside an episode');
    if (parent === path.dirname(parent)) break;
    parent = path.dirname(parent);
  }
  let existing = absolute;
  while (!(await fs.lstat(existing).then(() => true, () => false))) existing = path.dirname(existing);
  const real = await fs.realpath(existing);
  if (real !== existing) await safeDirectory(path.join(real, path.relative(existing, absolute)), mustBeNew);
  if (mustBeNew && await fs.lstat(absolute).then(() => true, () => false)) fail('attempt output already exists; previous attempts are immutable');
  return absolute;
}

function affectingKeys(keys, start, last) {
  let first = keys.findIndex(key => key.at_sec > start);
  first = first < 0 ? keys.length - 1 : Math.max(0, first - 1);
  let final = keys.findIndex(key => key.at_sec >= last);
  final = final < 0 ? keys.length - 1 : Math.max(first, final);
  return keys.slice(first, final + 1);
}

/** Partition output frames, never narration time or authored interpolation keys. */
export function planPanelExperimentChunks(timeline, { chunkDurationSec = 10 } = {}) {
  if (!Number.isFinite(chunkDurationSec) || chunkDurationSec < 0.1 || chunkDurationSec > 30) fail('chunk duration must be within 0.1..30 seconds');
  const chunkFrames = Math.max(1, Math.round(chunkDurationSec * timeline.fps));
  const totalFrames = Math.round(timeline.duration_sec * timeline.fps);
  const chunks = [];
  for (let start = 0; start < totalFrames; start += chunkFrames) {
    const end = Math.min(totalFrames, start + chunkFrames), startSec = start / timeline.fps, lastSec = (end - 1) / timeline.fps;
    const scenes = timeline.scenes.filter(scene => scene.end_sec > startSec && scene.start_sec <= lastSec).map(scene => ({ ...scene, layers: scene.layers.filter(layer => layer.end_sec > startSec && layer.start_sec <= lastSec) }));
    const panelIds = new Set(scenes.flatMap(scene => [scene.background.panel_id, ...scene.layers.map(layer => layer.panel_id)]));
    const panels = timeline.panels.filter(panel => panelIds.has(panel.id));
    const assetIds = new Set(panels.map(panel => panel.asset_id));
    chunks.push({ index: chunks.length, start_frame: start, end_frame: end, frame_count: end - start, start_sec: startSec, last_sec: lastSec, scenes, panels, asset_ids: [...assetIds] });
  }
  return chunks;
}

export function panelExperimentChunkKey({ timeline, chunk, assets, code_hashes, environment }) {
  const scenes = chunk.scenes.map(scene => ({ id: scene.id, start_sec: Math.max(scene.start_sec, chunk.start_sec), end_sec: Math.min(scene.end_sec, (chunk.end_frame / timeline.fps)), background: scene.background,
    layers: scene.layers.map(layer => ({ id: layer.id, panel_id: layer.panel_id, z: layer.z, fit: layer.fit, border_px: layer.border_px, start_sec: Math.max(layer.start_sec, chunk.start_sec), end_sec: Math.min(layer.end_sec, chunk.end_frame / timeline.fps), keyframes: affectingKeys(layer.keyframes, Math.max(chunk.start_sec, layer.start_sec), Math.min(chunk.last_sec, layer.end_sec)) })) }));
  return hash(canonical({ schema: 'goldflow_panel_chunk_cache_v2', identity_sha256: timeline.experiment_identity.sha256, width: timeline.width, height: timeline.height, fps: timeline.fps, start_frame: chunk.start_frame, end_frame: chunk.end_frame, scenes,
    panels: chunk.panels.map(({ id, asset_id, source_rect }) => ({ id, asset_id, source_rect })), assets: assets.filter(asset => chunk.asset_ids.includes(asset.id)).map(({ id, sha256 }) => ({ id, sha256 })), code_hashes, environment, codec: cacheCodec }));
}

function assertChunkProbe(inspected, timeline, chunk) {
  const video = inspected.streams.find(stream => stream.codec_type === 'video');
  const rate = String(video?.avg_frame_rate).split('/').map(Number);
  if (!video || video.codec_name !== 'h264' || video.pix_fmt !== 'gbrp' || video.color_range !== 'pc' || video.width !== timeline.width || video.height !== timeline.height || rate[0] / rate[1] !== timeline.fps || Number(video.nb_read_frames) !== chunk.frame_count || inspected.streams.some(stream => stream.codec_type === 'audio')) fail('lossless chunk geometry/frame count/codec differs from its cache contract');
  if (Math.abs(Number(inspected.format.duration) - chunk.frame_count / timeline.fps) > 1 / timeline.fps + 1e-6) fail('lossless chunk duration differs from its absolute frame range');
}

async function cachedChunk(keyDir, cacheKey, timeline, chunk) {
  const attempts = await fs.readdir(keyDir).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const rejected = [];
  for (const attempt of attempts.sort().reverse()) {
    if (!/^attempt-[a-f0-9-]+$/.test(attempt)) continue;
    const dir = path.join(keyDir, attempt), clip = path.join(dir, 'clip.mkv');
    try {
      const receipt = await readJson(path.join(dir, 'receipt.json'));
      if (receipt.schema !== 'goldflow_panel_chunk_receipt_v2' || receipt.codec !== cacheCodec || receipt.status !== 'passed' || receipt.cache_key !== cacheKey || receipt.frame_count !== chunk.frame_count || await sha256File(clip) !== receipt.sha256) throw new Error('cache version, codec, hash or receipt mismatch');
      assertChunkProbe(await mediaProbe(clip, { countFrames: true, losslessChunk: true }), timeline, chunk);
      return { path: clip, sha256: receipt.sha256, bytes: (await fs.stat(clip)).size, receipt_path: path.join(dir, 'receipt.json'), capture_count: receipt.capture_count, unchanged_frame_reuse_count: receipt.unchanged_frame_reuse_count, reused: true, rejected };
    } catch (error) { rejected.push({ attempt, reason: error.message }); }
  }
  return { reused: false, rejected };
}

function encoderProcess(args) {
  const process = spawn(ffmpeg(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  process.stderr.on('data', data => { stderr = (stderr + data).slice(-12000); });
  process.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => { process.once('error', reject); process.once('close', code => code === 0 ? resolve() : reject(new Error(`Panel encoder failed (${code}): ${stderr}`))); });
  done.catch(() => {});
  return { process, done };
}

async function pipeFrame(encoder, bytes) {
  const write = new Promise((resolve, reject) => {
    encoder.process.stdin.write(bytes, error => error ? reject(error) : resolve());
  });
  await Promise.race([write, encoder.done.then(() => { throw new Error('Encoder closed before all frames'); })]);
}

// Compare only the picture painted by the shared evaluator. Authored timestamps,
// easing names and editorial metadata do not change a stationary picture.
// The ordered visible layers retain their exact sampled values; no rounding or
// time quantization may suppress small motion, reveals or an opacity change.
function framePictureSignature(timeline, time) {
  const frame = panelFrameState(timeline, time);
  const background = frame.scene?.background;
  return JSON.stringify({
    background: background ? { panel_id: background.panel_id, blur_px: background.blur_px, brightness: background.brightness } : null,
    layers: frame.layers.filter(layer => layer.state.opacity > 0).map(layer => ({
      panel_id: layer.panel_id, fit: layer.fit, border_px: layer.border_px,
      rect: layer.state.rect, camera: layer.state.camera, opacity: layer.state.opacity,
    })),
  });
}

async function renderChunk({ browser, loaded, chunk, cacheKey, keyDir, onProgress }) {
  const attemptDir = path.join(keyDir, `attempt-${randomUUID()}`);
  const assets = loaded.assets.filter(asset => chunk.asset_ids.includes(asset.id));
  if (assets.reduce((total, asset) => total + asset.width * asset.height, 0) > 64_000_000) fail(`chunk ${chunk.index} exceeds the 64-megapixel active raster memory budget; narrow scene/chunk scope`);
  const materialized = [];
  for (const asset of assets) {
    if (await sha256File(asset.path) !== asset.sha256) fail(`asset changed before chunk ${chunk.index}`);
    const raster = await sharp(asset.path, { limitInputPixels: 100_000_000 }).rotate().png().toBuffer();
    materialized.push({ ...asset, data_url: `data:image/png;base64,${raster.toString('base64')}` });
  }
  await fs.mkdir(attemptDir, { recursive: true });
  const clip = path.join(attemptDir, 'clip.mkv');
  const receipt = { schema: 'goldflow_panel_chunk_receipt_v2', codec: cacheCodec, cache_key: cacheKey, start_frame: chunk.start_frame, end_frame: chunk.end_frame, frame_count: chunk.frame_count, capture_count: 0, unchanged_frame_reuse_count: 0, started_at: new Date().toISOString(), source_hashes: Object.fromEntries(assets.map(asset => [asset.path, asset.sha256])) };
  let page, encoder, deadline;
  try {
    page = await browser.newPage({ viewport: { width: loaded.timeline.width, height: loaded.timeline.height }, deviceScaleFactor: 1, offline: true, serviceWorkers: 'block' });
    await page.route('**/*', route => route.abort());
    const subset = { ...loaded.timeline, scenes: chunk.scenes, panels: chunk.panels, assets };
    await page.setContent(createPanelReviewHtml({ timeline: subset, assets: materialized, audioUrl: null, initialTimeSec: chunk.start_sec }), { waitUntil: 'load' });
    await page.evaluate(async () => { await window.panelProofReady; });
    // RGB lossless temporal compression preserves every Canvas pixel while
    // avoiding a full independent raster for each frame of a reading hold.
    const args = ['-v', 'error', '-n', '-f', 'image2pipe', '-framerate', String(loaded.timeline.fps), '-vcodec', 'png', '-i', 'pipe:0', '-an', '-c:v', 'libx264rgb', '-crf', '0', '-preset', 'veryfast', '-pix_fmt', 'rgb24', '-color_range', 'pc', '-r', String(loaded.timeline.fps), '-map_metadata', '-1', clip];
    encoder = encoderProcess(args);
    deadline = setTimeout(() => encoder.process.kill('SIGKILL'), 30 * 60 * 1000);
    let previousSignature, previousPng;
    for (let frame = chunk.start_frame; frame < chunk.end_frame; frame++) {
      const time = frame / loaded.timeline.fps, signature = framePictureSignature(subset, time);
      if (signature !== previousSignature) {
        const encoded = await page.evaluate(time => { window.renderPanelFrame(time); return document.getElementById('panel-canvas').toDataURL('image/png').split(',')[1]; }, time);
        previousPng = Buffer.from(encoded, 'base64'); previousSignature = signature; receipt.capture_count++;
      } else receipt.unchanged_frame_reuse_count++;
      await pipeFrame(encoder, previousPng);
      if ((frame - chunk.start_frame) % 150 === 0) onProgress?.({ phase: 'chunk_frames', chunk: chunk.index, frame, total_frames: Math.round(loaded.timeline.duration_sec * loaded.timeline.fps) });
    }
    encoder.process.stdin.end(); await encoder.done;
    assertChunkProbe(await mediaProbe(clip, { countFrames: true, losslessChunk: true }), loaded.timeline, chunk);
    await currentHashes(receipt.source_hashes);
    receipt.sha256 = await sha256File(clip); receipt.bytes = (await fs.stat(clip)).size; receipt.status = 'passed';
  } catch (error) { receipt.status = 'failed'; receipt.error = error.message; encoder?.process.kill('SIGKILL'); await encoder?.done.catch(() => {}); throw error; }
  finally { clearTimeout(deadline); await page?.close().catch(() => {}); receipt.completed_at = new Date().toISOString(); await fs.writeFile(path.join(attemptDir, 'receipt.json'), json(receipt), { flag: 'wx' }); }
  return { path: clip, sha256: receipt.sha256, bytes: receipt.bytes, receipt_path: path.join(attemptDir, 'receipt.json'), capture_count: receipt.capture_count, unchanged_frame_reuse_count: receipt.unchanged_frame_reuse_count, reused: false };
}

function concatPath(file) { return `'${file.replaceAll("'", "'\\''")}'`; }

async function decodeQa(output, video, timeline, chunks) {
  const count = Math.round(timeline.duration_sec * timeline.fps);
  const frames = new Set([0, count - 1]);
  for (let i = 1; i < 12; i++) frames.add(Math.round(i * (count - 1) / 12));
  for (const chunk of chunks.slice(0, 6)) for (const frame of [chunk.start_frame - 1, chunk.start_frame, chunk.start_frame + 1]) if (frame >= 0 && frame < count) frames.add(frame);
  const selected = [...frames].sort((a, b) => a - b), dir = path.join(output, 'decoded-frames');
  await fs.mkdir(dir);
  await command(ffmpeg(), ['-v', 'error', '-n', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-i', video, '-vf', `select=${selected.map(frame => `eq(n\\,${frame})`).join('+')}`, '-fps_mode', 'vfr', '-frames:v', String(selected.length), path.join(dir, 'frame-%03d.png')], 30 * 60 * 1000);
  const files = (await fs.readdir(dir)).filter(file => /^frame-\d+\.png$/.test(file)).sort();
  if (files.length !== selected.length) fail('decoded QA frame count mismatch');
  const samples = await Promise.all(selected.map(async (frame, index) => ({ frame, time_sec: frame / timeline.fps, path: path.join(dir, files[index]), sha256: await sha256File(path.join(dir, files[index])) })));
  const chosen = samples.length <= 24 ? samples : Array.from({ length: 24 }, (_, i) => samples[Math.round(i * (samples.length - 1) / 23)]);
  const overlays = [];
  for (let i = 0; i < chosen.length; i++) {
    const left = i % 4 * 480, top = Math.floor(i / 4) * 298;
    overlays.push({ input: await sharp(chosen[i].path).resize(480, 270).png().toBuffer(), left, top });
    overlays.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="28"><text x="10" y="20" fill="white" font-family="Arial" font-size="16">${chosen[i].time_sec.toFixed(3)}s / frame ${chosen[i].frame}</text></svg>`), left, top: top + 270 });
  }
  const sheet = path.join(output, 'contact-sheet.jpg');
  await sharp({ create: { width: 1920, height: Math.ceil(chosen.length / 4) * 298, channels: 3, background: '#111820' } }).composite(overlays).jpeg({ quality: 92 }).toFile(sheet);
  return { frames: samples, contact_sheet: { path: sheet, sha256: await sha256File(sheet) } };
}

/** Private longform experiment only; accepted chunks survive isolated visual edits. */
export async function renderPanelExperiment({ timelinePath, outputDir, cacheDir, allowDirtyWorktree = false, dirtyReason = '', onProgress, chunkDurationSec = 10 } = {}) {
  const started = Date.now();
  const loaded = await loadPanelExperimentTimeline(timelinePath);
  const sourceAudio = await sourceAudioInfo(loaded);
  const worktree = await inspectPanelWorktree({ allowDirtyWorktree, dirtyReason });
  const output = await safeDirectory(outputDir, true), cache = await safeDirectory(cacheDir);
  if (output === cache || cache.startsWith(`${output}${path.sep}`) || output.startsWith(`${cache}${path.sep}`)) fail('attempt output and reusable cache must be separate directories');
  const codes = await codeHashes(), chunks = planPanelExperimentChunks(loaded.timeline, { chunkDurationSec });
  const report = { schema: 'goldflow_panel_experiment_render_report_v1', id: loaded.identity.id, intent: 'editing_experiment', production_eligible: false, status: 'started', started_at: new Date(started).toISOString(), identity: loaded.identity, source_hashes: loaded.source_hashes, code_hashes: codes, source_audio: sourceAudio, worktree, cost_usd: 0, chunks: [], reused_chunk_count: 0, rendered_chunk_count: 0, captured_frame_count: 0, unchanged_frame_reuse_count: 0, picture_cache_codec: cacheCodec, cache_dir: cache };
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(output);
  const events = path.join(output, 'execution_events.jsonl');
  const event = async row => fs.appendFile(events, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
  await event({ event: 'experiment_render_started', source_hashes: loaded.source_hashes });
  let browser;
  try {
    const portable = { ...loaded.timeline, experiment_identity: { ...loaded.timeline.experiment_identity, path: loaded.identity_path }, assets: loaded.assets.map(({ width, height, ...asset }) => asset), audio: loaded.audio };
    await fs.writeFile(path.join(output, 'timeline.json'), json(portable), { flag: 'wx' });
    browser = await chromium.launch({ executablePath: process.env.ANIFACTORY_CHROMIUM_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
    report.environment = { browser: browser.version(), ffmpeg: (await command(ffmpeg(), ['-version'])).stdout.split('\n')[0], node: process.version, platform: process.platform, architecture: process.arch };
    for (const chunk of chunks) {
      const key = panelExperimentChunkKey({ timeline: loaded.timeline, chunk, assets: loaded.assets, code_hashes: codes, environment: report.environment });
      const keyDir = path.join(cache, 'chunks', key);
      const previous = await cachedChunk(keyDir, key, loaded.timeline, chunk);
      const result = previous.reused ? previous : await renderChunk({ browser, loaded, chunk, cacheKey: key, keyDir, onProgress });
      const row = { index: chunk.index, cache_key: key, start_frame: chunk.start_frame, end_frame: chunk.end_frame, frame_count: chunk.frame_count, ...result, rejected_cache_attempts: previous.rejected };
      report.chunks.push(row); report[result.reused ? 'reused_chunk_count' : 'rendered_chunk_count']++;
      if (!result.reused) { report.captured_frame_count += result.capture_count; report.unchanged_frame_reuse_count += result.unchanged_frame_reuse_count; }
      await event({ event: result.reused ? 'chunk_reused' : 'chunk_rendered', ...row });
      onProgress?.({ phase: 'chunk_completed', chunk: chunk.index, chunks: chunks.length, reused: result.reused, elapsed_sec: (Date.now() - started) / 1000 });
    }
    await browser.close(); browser = null;
    // Only this generated concat list may use the concat demuxer; source audio
    // remains restricted to one hash-bound concrete media file.
    const list = path.join(output, 'picture-concat.txt');
    await fs.writeFile(list, report.chunks.map(chunk => `file ${concatPath(chunk.path)}\nduration ${(chunk.frame_count / loaded.timeline.fps).toFixed(12)}\n`).join(''), { flag: 'wx' });
    for (const chunk of report.chunks) if (await sha256File(chunk.path) !== chunk.sha256) fail('cached picture changed before final mux');
    const video = path.join(output, 'panel-experiment.mp4');
    const args = ['-v', 'error', '-n', '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file', '-format_whitelist', 'concat,matroska', '-i', list];
    if (loaded.audio) args.push('-protocol_whitelist', 'file', '-format_whitelist', formats, '-ss', String(loaded.audio.offset_sec), '-i', loaded.audio.path);
    args.push('-map', '0:v:0', ...(loaded.audio ? ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k'] : ['-an']), '-vf', `setpts=N/(${loaded.timeline.fps}*TB),scale=in_range=pc:out_range=tv,format=yuv420p`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', String(loaded.timeline.fps), '-t', String(loaded.timeline.duration_sec), '-map_metadata', '-1', '-movflags', '+faststart', video);
    onProgress?.({ phase: 'final_mux', duration_sec: loaded.timeline.duration_sec, chunks: chunks.length, elapsed_sec: (Date.now() - started) / 1000 });
    await command(ffmpeg(), args, 2 * 60 * 60 * 1000);
    onProgress?.({ phase: 'final_qa', duration_sec: loaded.timeline.duration_sec, elapsed_sec: (Date.now() - started) / 1000 });
    report.media = assertPanelProofProbe({ probe: await mediaProbe(video, { countFrames: true }), timeline: loaded.timeline, audioExpected: Boolean(loaded.audio) });
    report.output = { path: video, sha256: await sha256File(video), bytes: (await fs.stat(video)).size };
    Object.assign(report, await decodeQa(output, video, loaded.timeline, chunks));
    for (const chunk of report.chunks) if (await sha256File(chunk.path) !== chunk.sha256) fail('cached picture changed during final mux or QA');
    report.picture_cache_bytes = report.chunks.reduce((total, chunk) => total + chunk.bytes, 0);
    await currentHashes(loaded.source_hashes); await currentHashes(codes);
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { await browser?.close().catch(() => {}); report.elapsed_sec = (Date.now() - started) / 1000; report.completed_at = new Date().toISOString(); await fs.writeFile(path.join(output, 'render_report.json'), json(report), { flag: 'wx' }); await event({ event: `experiment_render_${report.status}`, elapsed_sec: report.elapsed_sec, reused_chunk_count: report.reused_chunk_count, rendered_chunk_count: report.rendered_chunk_count, cost_usd: 0 }); }
  return report;
}
