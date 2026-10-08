import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { sha256File } from './file-hash.mjs';
import { loadPanelTimeline } from './panel-layout-contract.mjs';
import { createPanelReviewHtml } from './panel-layout-review.mjs';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const ffmpeg = () => process.env.ANIFACTORY_FFMPEG_BIN || 'ffmpeg';
const ffprobe = () => process.env.ANIFACTORY_FFPROBE_BIN || 'ffprobe';
const mediaEnv = () => ({ ...process.env, LANG: 'C' });
// Hashes bind concrete media bytes. Playlist/concat demuxers can otherwise read
// additional, unbound local files even when network protocols are disabled.
const concreteMediaFormats = 'wav,flac,mp3,ogg,mov,aac';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const fail = message => { throw new Error(`Panel proof: ${message}`); };

async function probe(file, countFrames = false) {
  const result = await exec(ffprobe(), ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', concreteMediaFormats, ...(countFrames ? ['-count_frames'] : []), '-show_streams', '-show_format', '-of', 'json', file], { env: mediaEnv(), timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}

async function assertSourcesCurrent(sourceHashes) {
  for (const [file, expected] of Object.entries(sourceHashes)) {
    if (await sha256File(file) !== expected) fail(`source changed: ${file}`);
  }
}

async function codeHashes() {
  const files = ['panel-layout-renderer.mjs', 'panel-layout-contract.mjs', 'panel-layout-validation.mjs', 'panel-layout-review.mjs', 'panel-layout-runtime.mjs'].map(name => fileURLToPath(new URL(name, import.meta.url)));
  files.push(fileURLToPath(new URL('../panel-layout-proof.mjs', import.meta.url)));
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await sha256File(file)])));
}

export async function inspectPanelWorktree({ allowDirtyWorktree = false, dirtyReason = '' } = {}) {
  const options = { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 };
  const [status, commit, diff] = await Promise.all([
    exec('git', ['status', '--porcelain=v1', '-z'], options),
    exec('git', ['rev-parse', 'HEAD'], options),
    exec('git', ['diff', 'HEAD', '--binary'], options),
  ]);
  const dirty = Boolean(status.stdout);
  if (dirty && (allowDirtyWorktree !== true || String(dirtyReason).trim().length < 16)) {
    fail('render requires a clean worktree, or --allow-dirty-worktree true and a meaningful --dirty-reason for this bounded engine proof');
  }
  return { commit: commit.stdout.trim(), dirty, dirty_reason: dirty ? dirtyReason.trim() : null, dirty_status_sha256: hash(status.stdout), dirty_diff_sha256: hash(diff.stdout) };
}

async function validateOutputLocation(outputDir) {
  if (!path.isAbsolute(outputDir ?? '')) fail('output directory must be an absolute new directory');
  const output = path.resolve(outputDir);
  if (output.split(path.sep).includes('episodes')) fail('engine proofs must stay outside episode directories');
  let ancestor = output;
  while (true) {
    if (await fs.stat(path.join(ancestor, 'run_identity.json')).then(() => true, () => false)) fail('engine proofs cannot write inside an existing episode');
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  // Resolve existing ancestors too, so a symlink cannot route proof output into an episode.
  ancestor = path.dirname(output);
  while (!(await fs.stat(ancestor).then(() => true, () => false))) ancestor = path.dirname(ancestor);
  const real = await fs.realpath(ancestor);
  if (real !== ancestor) await validateOutputLocation(path.join(real, path.relative(ancestor, output)));
  if (await fs.lstat(output).then(() => true, () => false)) fail('output directory already exists; retained attempts cannot be overwritten');
  return output;
}

async function makeOutput(output) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output); // Deliberately non-recursive: racing/previous attempts must fail.
}

async function validateLoaded(loaded) {
  const { timeline, audio } = loaded;
  if (!(timeline.duration_sec > 0 && timeline.duration_sec <= 150)) fail('only bounded engine proofs up to 150 seconds are supported');
  await assertSourcesCurrent(loaded.source_hashes);
  let sourceAudio = null;
  if (audio) {
    const inspected = await probe(audio.path);
    const stream = inspected.streams.find(row => row.codec_type === 'audio');
    const duration = Number(stream?.duration ?? inspected.format?.duration);
    if (!stream || !Number.isFinite(duration) || duration + 0.000001 < audio.offset_sec + timeline.duration_sec) fail('audio source is shorter than the exact requested narration window');
    sourceAudio = { duration_sec: duration, sample_rate: Number(stream.sample_rate), codec: stream.codec_name, source_offset_sec: audio.offset_sec };
  } else if (timeline.audio_target !== 'silent_fixture') fail('narrator_only requires an audio source');
  return { ...loaded, sourceAudio };
}

function portableTimeline(loaded) {
  const paths = new Map(loaded.assets.map(asset => [asset.id, asset.path]));
  return { ...loaded.timeline, assets: loaded.timeline.assets.map(asset => ({ ...asset, path: paths.get(asset.id) })), audio: loaded.audio ? { ...loaded.audio } : null };
}

export async function inspectPanelLayoutProof({ manifestPath }) {
  const loaded = await validateLoaded(await loadPanelTimeline(path.resolve(manifestPath)));
  return {
    status: 'passed', id: loaded.timeline.id, intent: 'engine_proof', production_eligible: false,
    duration_sec: loaded.timeline.duration_sec, frame_count: Math.round(loaded.timeline.duration_sec * loaded.timeline.fps),
    asset_count: loaded.assets.length, source_hashes: loaded.source_hashes, source_audio: loaded.sourceAudio,
  };
}

function reviewAudioArgs(audio, duration, file) {
  return ['-v', 'error', '-n', '-protocol_whitelist', 'file', '-format_whitelist', concreteMediaFormats, '-ss', String(audio.offset_sec), '-i', audio.path, '-t', String(duration), '-map', '0:a:0', '-vn', '-c:a', 'pcm_s24le', '-map_metadata', '-1', file];
}

export async function writePanelLayoutReview({ manifestPath, outputDir }) {
  const started = Date.now();
  const loaded = await validateLoaded(await loadPanelTimeline(path.resolve(manifestPath)));
  const output = await validateOutputLocation(outputDir);
  const codes = await codeHashes();
  await makeOutput(output);
  const report = { schema: 'goldflow_panel_review_report_v1', id: loaded.timeline.id, intent: 'engine_proof', production_eligible: false, started_at: new Date(started).toISOString(), source_hashes: loaded.source_hashes, code_hashes: codes, cost_usd: 0 };
  try {
    if (loaded.audio) await exec(ffmpeg(), reviewAudioArgs(loaded.audio, loaded.timeline.duration_sec, path.join(output, 'review-audio.wav')), { env: mediaEnv(), timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    const timeline = portableTimeline(loaded);
    await fs.writeFile(path.join(output, 'review.html'), createPanelReviewHtml({ timeline, assets: loaded.assets, audioUrl: loaded.audio ? './review-audio.wav' : null }), { flag: 'wx' });
    await fs.writeFile(path.join(output, 'timeline.json'), json(timeline), { flag: 'wx' });
    await assertSourcesCurrent(loaded.source_hashes);
    report.status = 'passed';
    report.review_path = path.join(output, 'review.html');
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { report.elapsed_sec = (Date.now() - started) / 1000; await fs.writeFile(path.join(output, 'review_report.json'), json(report), { flag: 'wx' }); }
  return report;
}

export function panelProofSampleFrames(timeline) {
  const count = Math.round(timeline.duration_sec * timeline.fps);
  const samples = new Set([0, count - 1]);
  const add = seconds => samples.add(Math.max(0, Math.min(count - 1, Math.round(seconds * timeline.fps))));
  for (let i = 1; i < 10; i++) add(timeline.duration_sec * i / 10);
  for (const scene of timeline.scenes) {
    add(scene.start_sec); add(scene.end_sec - 1 / timeline.fps);
    for (const layer of scene.layers) {
      add(layer.start_sec + 0.15);
      for (const key of layer.keyframes) add(key.at_sec);
    }
  }
  return [...samples].sort((a, b) => a - b);
}

export function assertPanelProofProbe({ probe: inspected, timeline, audioExpected }) {
  const video = inspected.streams.find(row => row.codec_type === 'video');
  const audio = inspected.streams.find(row => row.codec_type === 'audio');
  const ratio = String(video?.avg_frame_rate ?? '').split('/').map(Number);
  const rate = ratio[0] / ratio[1];
  const frameCount = Math.round(timeline.duration_sec * timeline.fps);
  const tolerance = 1 / timeline.fps + 0.000001;
  if (!video || video.width !== timeline.width || video.height !== timeline.height || rate !== timeline.fps || video.codec_name !== 'h264' || video.pix_fmt !== 'yuv420p') fail('encoded video geometry, frame rate or codec is invalid');
  if (Number(video.nb_read_frames ?? video.nb_frames) !== frameCount) fail('encoded frame count differs from the authored timeline');
  for (const value of [video.duration, inspected.format?.duration, ...(audioExpected ? [audio?.duration] : [])]) {
    if (!Number.isFinite(Number(value)) || Math.abs(Number(value) - timeline.duration_sec) > tolerance) fail('encoded duration differs from the authored timeline by more than one frame');
  }
  if (audioExpected && audio?.codec_name !== 'aac') fail('encoded narration must be AAC');
  if (!audioExpected && audio) fail('silent fixture unexpectedly contains audio');
  return { width: video.width, height: video.height, fps: rate, frame_count: frameCount, duration_sec: Number(inspected.format.duration), video_codec: video.codec_name, pixel_format: video.pix_fmt, audio_codec: audio?.codec_name ?? null, tolerance_sec: tolerance };
}

function boundedSamples(samples) {
  return samples.length <= 24 ? samples : Array.from({ length: 24 }, (_, i) => samples[Math.round(i * (samples.length - 1) / 23)]);
}

async function decodeSamples(videoPath, output, samples, timeline) {
  const selected = boundedSamples(samples);
  const dir = path.join(output, 'decoded-frames');
  await fs.mkdir(dir);
  const select = `select=${selected.map(sample => `eq(n\\,${sample.frame})`).join('+')}`;
  await exec(ffmpeg(), ['-v', 'error', '-n', '-protocol_whitelist', 'file', '-format_whitelist', concreteMediaFormats, '-i', videoPath, '-vf', select, '-fps_mode', 'vfr', '-frames:v', String(selected.length), '-q:v', '2', path.join(dir, 'frame-%03d.jpg')], { env: mediaEnv(), timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  const files = (await fs.readdir(dir)).filter(name => /^frame-\d+\.jpg$/.test(name)).sort();
  if (files.length !== selected.length) fail('decoded QA frame count differs from the selected encoded frame indices');
  return Promise.all(selected.map(async (sample, i) => {
    const file = path.join(dir, files[i]);
    return { frame: sample.frame, time_sec: sample.frame / timeline.fps, path: file, sha256: await sha256File(file) };
  }));
}

async function contactSheet(output, samples, timeline) {
  const selected = boundedSamples(samples);
  const width = 480, imageHeight = 270, rowHeight = 300, cols = 4, rows = Math.ceil(selected.length / cols);
  const overlays = [];
  for (let i = 0; i < selected.length; i++) {
    const left = (i % cols) * width, top = Math.floor(i / cols) * rowHeight;
    overlays.push({ input: await sharp(selected[i].path).resize(width, imageHeight).toBuffer(), left, top });
    const text = `${(selected[i].frame / timeline.fps).toFixed(2)}s · frame ${selected[i].frame}`;
    overlays.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="30"><rect width="480" height="30" fill="#151b26"/><text x="12" y="21" font-family="Arial" font-size="16" fill="white">${text}</text></svg>`), left, top: top + imageHeight });
  }
  const file = path.join(output, 'contact-sheet.jpg');
  await sharp({ create: { width: cols * width, height: rows * rowHeight, channels: 3, background: '#151b26' } }).composite(overlays).jpeg({ quality: 92 }).toFile(file);
  return { path: file, sha256: await sha256File(file) };
}

function writePipe(stream, data) {
  if (stream.destroyed) return Promise.reject(new Error('Encoder input closed before all frames were written'));
  return new Promise((resolve, reject) => {
    const clean = () => { stream.off('error', error); stream.off('close', closed); stream.off('drain', drained); };
    const error = value => { clean(); reject(value); };
    const closed = () => error(new Error('Encoder input closed while waiting for frame backpressure'));
    const drained = () => { clean(); resolve(); };
    stream.once('error', error); stream.once('close', closed);
    if (stream.write(data)) drained(); else stream.once('drain', drained);
  });
}

/** Independent local engine proof; does not consume or complete an episode stage. */
export async function renderPanelLayoutProof({ manifestPath, outputDir, allowDirtyWorktree = false, dirtyReason = '', onProgress } = {}) {
  const started = Date.now();
  const loaded = await validateLoaded(await loadPanelTimeline(path.resolve(manifestPath)));
  const worktree = await inspectPanelWorktree({ allowDirtyWorktree, dirtyReason });
  const output = await validateOutputLocation(outputDir);
  const codes = await codeHashes();
  const timeline = portableTimeline(loaded);
  const { assets, audio } = loaded;
  const html = createPanelReviewHtml({ timeline, assets, audioUrl: null });
  const frameCount = Math.round(timeline.duration_sec * timeline.fps);
  const videoPath = path.join(output, 'panel-proof.mp4');
  const report = { schema: 'goldflow_panel_render_report_v1', id: timeline.id, intent: 'engine_proof', production_eligible: false, started_at: new Date(started).toISOString(), source_hashes: loaded.source_hashes, code_hashes: codes, worktree, source_audio: loaded.sourceAudio, cost_usd: 0, audio_processing: audio ? 'source-time slice; AAC encode only; no gain, tempo or effects' : 'silent fixture', frames_written: 0 };
  await makeOutput(output);
  await fs.writeFile(path.join(output, 'timeline.json'), json(timeline), { flag: 'wx' });
  await fs.writeFile(path.join(output, 'execution_events.jsonl'), `${JSON.stringify({ event: 'render_started', at: report.started_at, id: timeline.id, source_hashes: loaded.source_hashes })}\n`, { flag: 'wx' });
  let browser, encoder, encoderDone, deadline;
  let stderr = '';
  try {
    const toolVersion = await exec(ffmpeg(), ['-version'], { env: mediaEnv(), timeout: 15000, maxBuffer: 1024 * 1024 });
    report.environment = { node: process.version, platform: process.platform, architecture: process.arch, ffmpeg: toolVersion.stdout.split('\n')[0], browser: null };
    browser = await chromium.launch({ executablePath: process.env.ANIFACTORY_CHROMIUM_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, timeout: 60000, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
    report.environment.browser = browser.version();
    const context = await browser.newContext({ viewport: { width: timeline.width, height: timeline.height }, deviceScaleFactor: 1, offline: true, serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(async () => { await window.panelProofReady; });
    const geometry = await page.evaluate(() => { const c = document.getElementById('panel-canvas'); return { width: c.width, height: c.height }; });
    if (geometry.width !== timeline.width || geometry.height !== timeline.height) fail('review compositor canvas differs from locked output geometry');
    const args = ['-v', 'error', '-n', '-f', 'image2pipe', '-framerate', String(timeline.fps), '-vcodec', 'mjpeg', '-i', 'pipe:0'];
    if (audio) args.push('-protocol_whitelist', 'file', '-format_whitelist', concreteMediaFormats, '-ss', String(audio.offset_sec), '-i', audio.path);
    // JPEG frames arrive in full range. Explicitly convert range before encoding;
    // pixel-format selection alone can leave an H.264 stream tagged yuvj420p.
    // The pipe supplies exactly frameCount frames; a -frames:v output stop can
    // otherwise cut off the final AAC packet before the authored audio endpoint.
    args.push('-map', '0:v:0', ...(audio ? ['-map', '1:a:0'] : ['-an']), '-vf', 'scale=in_range=pc:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', String(timeline.fps), '-t', String(timeline.duration_sec));
    if (audio) args.push('-c:a', 'aac', '-b:a', '192k');
    args.push('-map_metadata', '-1', '-movflags', '+faststart', videoPath);
    encoder = spawn(ffmpeg(), args, { env: mediaEnv(), stdio: ['pipe', 'ignore', 'pipe'] });
    encoder.stderr.on('data', data => { stderr = (stderr + data).slice(-12000); });
    encoder.stdin.on('error', () => {});
    encoderDone = new Promise((resolve, reject) => {
      encoder.once('error', reject);
      encoder.once('close', code => code === 0 ? resolve() : reject(new Error(`Panel encoder failed (${code}): ${stderr}`)));
    });
    encoderDone.catch(() => {});
    deadline = setTimeout(() => encoder.kill('SIGKILL'), 30 * 60 * 1000);
    const selectedFrames = new Set(panelProofSampleFrames(timeline));
    const samples = [];
    await fs.mkdir(path.join(output, 'frames'));
    for (let frame = 0; frame < frameCount; frame++) {
      const data = await page.evaluate(time => { window.renderPanelFrame(time); return document.getElementById('panel-canvas').toDataURL('image/jpeg', 0.96).split(',')[1]; }, frame / timeline.fps);
      const bytes = Buffer.from(data, 'base64');
      if (selectedFrames.has(frame)) {
        const file = path.join(output, 'frames', `frame-${String(frame).padStart(5, '0')}.jpg`);
        await fs.writeFile(file, bytes, { flag: 'wx' });
        samples.push({ frame, time_sec: frame / timeline.fps, path: file, sha256: hash(bytes) });
      }
      await Promise.race([writePipe(encoder.stdin, bytes), encoderDone.then(() => { throw new Error('Encoder ended before all authored frames'); })]);
      report.frames_written = frame + 1;
      if (frame % 150 === 0) onProgress?.({ frame: frame + 1, total_frames: frameCount, elapsed_sec: (Date.now() - started) / 1000 });
    }
    encoder.stdin.end();
    await encoderDone;
    clearTimeout(deadline);
    await browser.close(); browser = null;
    const inspected = await probe(videoPath, true);
    report.media = assertPanelProofProbe({ probe: inspected, timeline, audioExpected: Boolean(audio) });
    await assertSourcesCurrent(loaded.source_hashes);
    await assertSourcesCurrent(codes);
    report.output = { path: videoPath, sha256: await sha256File(videoPath), bytes: (await fs.stat(videoPath)).size };
    report.frames = samples;
    report.decoded_frames = await decodeSamples(videoPath, output, samples, timeline);
    report.contact_sheet = await contactSheet(output, report.decoded_frames, timeline);
    report.status = 'passed';
  } catch (error) {
    encoder?.kill('SIGKILL');
    await encoderDone?.catch(() => {});
    report.status = 'failed'; report.error = error.message; report.encoder_stderr = stderr;
    throw error;
  } finally {
    clearTimeout(deadline);
    await browser?.close().catch(() => {});
    report.elapsed_sec = (Date.now() - started) / 1000;
    report.completed_at = new Date().toISOString();
    await fs.writeFile(path.join(output, 'render_report.json'), json(report), { flag: 'wx' });
    await fs.appendFile(path.join(output, 'execution_events.jsonl'), `${JSON.stringify({ event: `render_${report.status}`, at: report.completed_at, frames_written: report.frames_written, elapsed_sec: report.elapsed_sec, cost_usd: 0 })}\n`);
  }
  return report;
}
