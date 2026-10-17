import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { sha256File } from './file-hash.mjs';
import { validatePanelTimeline } from './panel-layout-validation.mjs';
import { assertPanelProductionIdentity } from './panel-production-policy.mjs';
import { planPanelExperimentChunks, panelExperimentChunkKey, cachedPanelPictureChunk, renderPanelPictureChunk } from './panel-experiment-renderer.mjs';

const exec = promisify(execFile);
const fail = message => { throw new Error(`Panel production picture: ${message}`); };
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const ffmpeg = () => process.env.ANIFACTORY_FFMPEG_BIN || 'ffmpeg';
const ffprobe = () => process.env.ANIFACTORY_FFPROBE_BIN || 'ffprobe';
const command = (bin, args, timeout = 120000) => exec(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
const quoteConcat = file => `'${file.replaceAll("'", "'\\''")}'`;

async function assertHashes(hashes) {
  if (!hashes || !Object.keys(hashes).length) fail('current input hashes required');
  for (const [file, expected] of Object.entries(hashes)) {
    if (!path.isAbsolute(file) || !/^[a-f0-9]{64}$/.test(expected) || await sha256File(file) !== expected) fail(`stale source: ${file}`);
  }
}

async function codeHashes() {
  const names = ['../render.mjs', 'panel-production-renderer.mjs', 'panel-production-policy.mjs', 'panel-production-plan.mjs', 'panel-production-assets.mjs', 'panel-composition-authoring.mjs', 'panel-experiment-renderer.mjs', 'panel-layout-review.mjs', 'panel-layout-validation.mjs', 'panel-layout-runtime.mjs'];
  return Object.fromEntries(await Promise.all(names.map(async name => { const file = fileURLToPath(new URL(name, import.meta.url)); return [file, await sha256File(file)]; })));
}

async function resolvedDestination(value) {
  const absolute = path.resolve(value);
  let ancestor = absolute;
  while (!await fs.lstat(ancestor).then(() => true, () => false)) ancestor = path.dirname(ancestor);
  return path.join(await fs.realpath(ancestor), path.relative(ancestor, absolute));
}

export async function assertPanelProductionPictureCurrent(picture) {
  await assertHashes(picture.source_hashes);
  await assertHashes(picture.code_hashes);
  for (const chunk of picture.chunks) if (await sha256File(chunk.path) !== chunk.sha256) fail('cached chunk changed after picture preparation');
  if (picture.output && await sha256File(picture.output.path) !== picture.output.sha256) fail('silent picture changed after preparation');
}

/** Picture only. Official render owns captions, canonical continuous audio and final QA. */
export async function buildPanelProductionPicture({ episodeDir, loadedPlan, workDir, width, height, fps, onProgress, chunkDurationSec = 10 } = {}) {
  if (!episodeDir || !loadedPlan || !workDir) fail('explicit episode, loaded production plan and work directory required');
  const root = await fs.realpath(path.resolve(episodeDir));
  const identityPath = path.join(root, 'run_identity.json');
  const identity = JSON.parse(await fs.readFile(identityPath, 'utf8'));
  const contract = assertPanelProductionIdentity(identity);
  const timeline = validatePanelTimeline(loadedPlan.timeline, 'production_panel_composition');
  if (timeline.schema !== 'goldflow_panel_production_timeline_v1' || timeline.intent !== 'production_panel_composition') fail('private proof/experiment timelines cannot become production picture');
  if (timeline.width !== width || timeline.height !== height || timeline.fps !== fps) fail('timeline canvas differs from official render settings');
  const expectedCanvas = contract.canvas;
  if (width !== expectedCanvas.width || height !== expectedCanvas.height || fps !== expectedCanvas.fps) fail('timeline canvas differs from locked panel contract');
  const sources = { ...loadedPlan.inputHashes };
  const identityHash = await sha256File(identityPath);
  if (sources[identityPath] !== identityHash) fail('loaded plan does not bind the current run identity');
  if (timeline.run_identity.sha256 !== identityHash || await fs.realpath(timeline.run_identity.path) !== identityPath) fail('timeline run identity differs from its loaded production identity');
  const timelineAssets = new Map(timeline.assets.map(asset => [asset.id, asset]));
  if (loadedPlan.assets?.length !== timelineAssets.size) fail('loaded artwork differs from timeline inventory');
  for (const asset of loadedPlan.assets ?? []) {
    const file = await fs.realpath(asset.path);
    if (sources[file] !== asset.sha256 || timelineAssets.get(asset.id)?.sha256 !== asset.sha256) fail(`loaded plan does not bind asset ${asset.id}`);
  }
  await assertHashes(sources);
  const work = await resolvedDestination(workDir);
  if (!work.startsWith(`${root}${path.sep}`)) fail('production picture work must remain in its episode');
  const codes = await codeHashes(), chunks = planPanelExperimentChunks(timeline, { chunkDurationSec });
  const cache = path.join(work, 'panel-picture-cache'), output = path.join(work, 'panel-picture-attempts', randomUUID());
  const report = { schema: 'goldflow_panel_production_picture_report_v1', status: 'started', episode: identity.episode, render_profile: identity.render_profile, source_hashes: sources, code_hashes: codes, plan_path: loadedPlan.planPath ?? null, timeline_duration_sec: timeline.duration_sec, width, height, fps, chunks: [], cache_stats: { reused_chunk_count: 0, rendered_chunk_count: 0, captured_frame_count: 0, unchanged_frame_reuse_count: 0 }, started_at: new Date().toISOString() };
  const reportPath = path.join(output, 'picture_report.json');
  await fs.mkdir(output, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.ANIFACTORY_CHROMIUM_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
    report.environment = { browser: browser.version(), ffmpeg: (await command(ffmpeg(), ['-version'])).stdout.split('\n')[0], node: process.version, platform: process.platform, architecture: process.arch };
    for (const chunk of chunks) {
      const cacheKey = panelExperimentChunkKey({ timeline, chunk, assets: loadedPlan.assets, code_hashes: codes, environment: report.environment, identitySha256: identityHash, cacheSchema: 'goldflow_panel_production_picture_cache_v1' });
      const keyDir = path.join(cache, cacheKey);
      const previous = await cachedPanelPictureChunk(keyDir, cacheKey, timeline, chunk);
      const result = previous.reused ? previous : await renderPanelPictureChunk({ browser, loaded: loadedPlan, chunk, cacheKey, keyDir, onProgress });
      const row = { index: chunk.index, start_frame: chunk.start_frame, end_frame: chunk.end_frame, frame_count: chunk.frame_count, cache_key: cacheKey, ...result, rejected_cache_attempts: previous.rejected };
      report.chunks.push(row); report.cache_stats[result.reused ? 'reused_chunk_count' : 'rendered_chunk_count']++;
      if (!result.reused) { report.cache_stats.captured_frame_count += result.capture_count; report.cache_stats.unchanged_frame_reuse_count += result.unchanged_frame_reuse_count; }
      onProgress?.({ phase: 'panel_chunk_completed', chunk: chunk.index, chunks: chunks.length, reused: result.reused });
    }
    await browser.close(); browser = null;
    await assertPanelProductionPictureCurrent(report);
    const listPath = path.join(output, 'picture-concat.txt');
    await fs.writeFile(listPath, report.chunks.map(chunk => `file ${quoteConcat(chunk.path)}\nduration ${(chunk.frame_count / fps).toFixed(12)}\n`).join(''), { flag: 'wx' });
    const videoPath = path.join(output, 'silent-panel-picture.mp4');
    await command(ffmpeg(), ['-v', 'error', '-n', '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file', '-format_whitelist', 'concat,matroska', '-i', listPath, '-an', '-vf', `setpts=N/(${fps}*TB),scale=in_range=pc:out_range=tv,format=yuv420p`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', String(fps), '-t', String(timeline.duration_sec), '-map_metadata', '-1', '-movflags', '+faststart', videoPath], 2 * 60 * 60 * 1000);
    const probe = JSON.parse((await command(ffprobe(), ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-count_frames', '-show_streams', '-show_format', '-of', 'json', videoPath], 30 * 60 * 1000)).stdout);
    const video = probe.streams.find(row => row.codec_type === 'video');
    const rate = String(video?.avg_frame_rate).split('/').map(Number);
    if (probe.streams.some(row => row.codec_type === 'audio') || video?.codec_name !== 'h264' || video?.pix_fmt !== 'yuv420p' || video?.width !== width || video?.height !== height || rate[0] / rate[1] !== fps || Number(video?.nb_read_frames) !== Math.round(timeline.duration_sec * fps)) fail('silent picture codec, geometry or frame count mismatch');
    if (Math.abs(Number(video.duration) - timeline.duration_sec) > 1 / fps + 1e-6) fail('silent picture duration differs from authored timeline');
    report.media = { codec: video.codec_name, pix_fmt: video.pix_fmt, frame_count: Number(video.nb_read_frames), duration_sec: Number(video.duration), width, height, fps, audio_stream_count: 0 };
    report.output = { path: videoPath, sha256: await sha256File(videoPath), bytes: (await fs.stat(videoPath)).size };
    await assertPanelProductionPictureCurrent(report);
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { await browser?.close().catch(() => {}); report.completed_at = new Date().toISOString(); await fs.writeFile(reportPath, json(report), { flag: 'wx' }); }
  return { ...report, videoPath: report.output.path, report_path: reportPath, report_sha256: await sha256File(reportPath) };
}
