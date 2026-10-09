import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { loadPanelExperimentTimeline } from './panel-experiment-contract.mjs';
import { createPanelReviewHtml } from './panel-layout-review.mjs';
import { sha256File } from './file-hash.mjs';

const exec = promisify(execFile);
const fail = message => { throw new Error(`Panel experiment review: ${message}`); };
const json = value => `${JSON.stringify(value, null, 2)}\n`;
async function audioInfo(file) {
  const result = await exec(process.env.ANIFACTORY_FFPROBE_BIN || 'ffprobe', ['-v','error','-protocol_whitelist','file','-format_whitelist','wav,flac,mp3,ogg,mov,aac','-show_streams','-show_format','-of','json',file], { timeout:120000,maxBuffer:1024*1024 });
  const probe=JSON.parse(result.stdout), stream=probe.streams.find(row=>row.codec_type==='audio');
  if(!stream)fail('narration has no audio stream');
  const duration=Number(stream.duration ?? probe.format?.duration), rate=Number(stream.sample_rate);
  if(!Number.isFinite(duration)||!Number.isFinite(rate)||rate<=0)fail('narration duration/sample rate unavailable');
  return {duration,rate};
}

async function freshOutput(value) {
  if (!path.isAbsolute(value ?? '')) fail('absolute output directory required');
  const target = path.resolve(value);
  let existing = target;
  while (!(await fs.lstat(existing).then(() => true, () => false))) existing = path.dirname(existing);
  const resolved = path.join(await fs.realpath(existing), path.relative(existing, target));
  for (let current = resolved; ; current = path.dirname(current)) {
    if (current.split(path.sep).includes('episodes') || await fs.stat(path.join(current, 'run_identity.json')).then(() => true, () => false)) fail('review output cannot be inside an episode');
    if (current === path.dirname(current)) break;
  }
  if (await fs.lstat(target).then(() => true, () => false)) fail('review output already exists');
  return target;
}

/** Preview a bounded window while exporting the complete, identity-bound timeline. */
export async function writePanelExperimentReview({ timelinePath, outputDir, startSec = 0, endSec } = {}) {
  const loaded = await loadPanelExperimentTimeline(timelinePath);
  endSec ??= Math.min(loaded.timeline.duration_sec, startSec + 120);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec || endSec > loaded.timeline.duration_sec || endSec - startSec > 150) fail('review window must be inside the timeline and at most 150 seconds');
  if(loaded.audio){const info=await audioInfo(loaded.audio.path);if(info.duration+1/info.rate<loaded.audio.offset_sec+endSec)fail('narration does not cover the review window');}
  const output = await freshOutput(outputDir);
  const scenes = loaded.timeline.scenes.filter(scene => scene.end_sec > startSec && scene.start_sec < endSec);
  const panelIds = new Set(scenes.flatMap(scene => [scene.background.panel_id, ...scene.layers.map(layer => layer.panel_id)]));
  const assetIds = new Set(loaded.timeline.panels.filter(panel => panelIds.has(panel.id)).map(panel => panel.asset_id));
  const selected = loaded.assets.filter(asset => assetIds.has(asset.id));
  if (selected.reduce((sum, asset) => sum + asset.width * asset.height, 0) > 128_000_000) fail('review exceeds 128 megapixels of active artwork; choose a shorter window');
  const assets = await Promise.all(selected.map(async asset => ({ ...asset, data_url: `data:image/png;base64,${(await sharp(asset.path).rotate().png().toBuffer()).toString('base64')}` })));
  const timeline = { ...loaded.timeline, experiment_identity: { ...loaded.timeline.experiment_identity, path: loaded.identity_path }, assets: loaded.assets.map(({ width, height, ...asset }) => asset), audio: loaded.audio };
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(output);
  const report = { schema: 'goldflow_panel_experiment_review_v1', status: 'started', timeline_path: loaded.timeline_path, source_hashes: loaded.source_hashes, preview_start_sec: startSec, preview_end_sec: endSec, loaded_asset_count: assets.length, production_eligible: false };
  try {
    let audioUrl = null;
    if (loaded.audio) {
      const file = path.join(output, 'review-audio.wav');
      await exec(process.env.ANIFACTORY_FFMPEG_BIN || 'ffmpeg', ['-v','error','-n','-protocol_whitelist','file','-format_whitelist','wav,flac,mp3,ogg,mov,aac','-ss',String(loaded.audio.offset_sec + startSec),'-i',loaded.audio.path,'-t',String(endSec-startSec),'-map','0:a:0','-vn','-c:a','pcm_s24le','-map_metadata','-1',file], { timeout:120000, maxBuffer:1024*1024 });
      const info=await audioInfo(file);if(Math.abs(info.duration-(endSec-startSec))>1/info.rate+1e-7)fail('extracted narration duration differs from review window');
      audioUrl = './review-audio.wav'; report.audio_sha256 = await sha256File(file);
    }
    for (const [file, expected] of Object.entries(loaded.source_hashes)) if (await sha256File(file) !== expected) fail(`source changed while preparing review: ${file}`);
    await fs.writeFile(path.join(output, 'timeline.json'), json(timeline), { flag:'wx' });
    await fs.writeFile(path.join(output, 'review.html'), createPanelReviewHtml({ timeline, assets, audioUrl, initialTimeSec:startSec, previewStartSec:startSec, previewEndSec:endSec, audioTimeOffsetSec:startSec }), { flag:'wx' });
    report.status = 'prepared'; report.review_path = path.join(output, 'review.html'); report.review_sha256 = await sha256File(report.review_path);
    return report;
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { await fs.writeFile(path.join(output, 'review_report.json'), json(report), { flag:'wx' }); }
}
