import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

// A local compositor, not an approval or production-workflow entry point.
// All source_in_sec values are offsets INSIDE the supplied local asset. The
// original movie timestamps belong to the controller's exact-source receipts.
const FPS = 30;
const FRAMES = 2700;
const WIDTH = 1920;
const HEIGHT = 1080;
const KINDS = new Set(['movie_clip', 'host_pose', 'background', 'concept_still', 'concept_video', 'narration']);
const VIDEO_KINDS = new Set(['movie_clip', 'concept_video']);
const IMAGE_KINDS = new Set(['host_pose', 'background', 'concept_still']);
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const fail = (message) => { throw new Error(`Avatar pilot: ${message}`); };
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const integer = (value) => Number.isSafeInteger(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const sourceIn = (row) => row.source_in_sec ?? 0;
const overlap = (a, b) => a.start_frame < b.start_frame + b.duration_frames && b.start_frame < a.start_frame + a.duration_frames;

function interval(row, label) {
  if (!integer(row?.start_frame) || !integer(row?.duration_frames) || row.start_frame < 0
    || row.duration_frames <= 0 || row.start_frame + row.duration_frames > FRAMES) fail(`${label} has an invalid frame interval.`);
  if (!finite(sourceIn(row)) || sourceIn(row) < 0) fail(`${label} has an invalid local source offset.`);
}

function assetFor(assets, id, allowed) {
  if (typeof id !== 'string' || !Object.hasOwn(assets, id) || !object(assets[id])) fail('Unknown asset ID.');
  const asset = assets[id];
  if (!KINDS.has(asset.kind) || (allowed && !allowed.has(asset.kind))) fail(`Asset ${id} has an unsupported role.`);
  if (typeof asset.path !== 'string' || !path.isAbsolute(asset.path) || asset.path.includes('\0')
    || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '')) fail(`Asset ${id} requires an absolute local path and SHA-256.`);
  if (asset.duration_sec !== undefined && (!finite(asset.duration_sec) || asset.duration_sec <= 0)) fail(`Asset ${id} has an invalid declared duration.`);
  if (asset.kind === 'movie_clip' && asset.duration_sec !== undefined && (asset.duration_sec < 2.85 || asset.duration_sec > 5.15)) fail('Movie assets must already be bounded 3–5 second excerpts.');
  return asset;
}

/** Structural validation only; renderAvatarPilot independently verifies bytes/media. */
export function validatePilotTimeline(timeline, { assets } = {}) {
  if (!object(timeline) || timeline.schema !== 'goldflow_avatar_pilot_timeline_v1'
    || timeline.width !== WIDTH || timeline.height !== HEIGHT || timeline.fps !== FPS
    || timeline.duration_frames !== FRAMES) fail('Timeline must be exactly 1920x1080, 30 fps, 2700 frames (90 seconds).');
  if (!object(assets)) fail('An explicit asset map is required.');
  if (!Array.isArray(timeline.shots) || !timeline.shots.length || timeline.shots.length > 90) fail('Timeline requires 1–90 contiguous shots.');
  for (const key of ['narration', 'source_audio', 'captions']) {
    if (!Array.isArray(timeline[key]) || timeline[key].length > 300) fail(`${key} must be an explicit bounded array.`);
  }
  const shotIds = new Set();
  let cursor = 0;
  for (const shot of timeline.shots) {
    if (!object(shot) || typeof shot.id !== 'string' || !shot.id.trim() || shotIds.has(shot.id)) fail('Shots require unique IDs.');
    shotIds.add(shot.id);
    if (!integer(shot.start_frame) || !integer(shot.end_frame) || shot.start_frame !== cursor
      || shot.end_frame <= cursor || shot.end_frame > FRAMES) fail('Shots must cover 0–2700 contiguously with exclusive end frames.');
    cursor = shot.end_frame;
    if (!['evidence', 'hypothesis', 'host'].includes(shot.truth_mode)) fail('Each shot requires an explicit truth mode.');
    if (shot.truth_mode === 'hypothesis' && (typeof shot.truth_label !== 'string' || !shot.truth_label.trim())) fail('Hypothesis shots require a visible truth label.');
    if (shot.truth_label !== undefined && (typeof shot.truth_label !== 'string' || shot.truth_label.length > 88 || /[\u0000-\u001f]/.test(shot.truth_label))) fail('Invalid truth label.');
    if (shot.background_color !== undefined && (typeof shot.background_color !== 'string' || !/^#[a-f0-9]{6}$/i.test(shot.background_color))) fail('Background color must be a six-digit hex value.');
    if (shot.background_asset_id !== undefined) assetFor(assets, shot.background_asset_id, new Set(['background']));
    else if (typeof shot.background_color !== 'string' || !/^#[a-f0-9]{6}$/i.test(shot.background_color)) fail('Each shot requires a background asset or six-digit background color.');
    if (!Array.isArray(shot.layers) || shot.layers.length > 12) fail('Shot layers must be an explicit array of at most 12 items.');
    const depths = new Set();
    const duration = (shot.end_frame - shot.start_frame) / FPS;
    for (const layer of shot.layers) {
      if (!object(layer)) fail('Malformed layer.');
      const asset = assetFor(assets, layer.asset_id, new Set(['movie_clip', 'host_pose', 'concept_still', 'concept_video']));
      if (['x', 'y', 'width', 'height', 'z'].some((key) => !finite(layer[key]))) fail('Layer geometry must be finite.');
      if (!integer(layer.width) || !integer(layer.height) || layer.width < 2 || layer.height < 2
        || layer.width > WIDTH * 2 || layer.height > HEIGHT * 2 || !integer(layer.z) || Math.abs(layer.z) > 100
        || Math.abs(layer.x) > WIDTH * 2 || Math.abs(layer.y) > HEIGHT * 2 || depths.has(layer.z)) fail('Invalid or ambiguous layer geometry/depth.');
      depths.add(layer.z);
      if (!finite(sourceIn(layer)) || sourceIn(layer) < 0) fail('Invalid local layer source offset.');
      if (!VIDEO_KINDS.has(asset.kind) && sourceIn(layer) !== 0) fail('Still images do not have playback offsets.');
      if (layer.loop !== undefined && typeof layer.loop !== 'boolean') fail('Layer loop must be an explicit boolean.');
      if (layer.loop && asset.kind !== 'movie_clip') fail('Only bounded movie cards support explicit looping.');
      if (layer.loop) {
        if (!finite(layer.source_duration_sec) || layer.source_duration_sec < 3 || layer.source_duration_sec > 5
          || Math.abs(layer.source_duration_sec * FPS - Math.round(layer.source_duration_sec * FPS)) > 0.000001
          || duration > 10 || duration > layer.source_duration_sec * 2 || duration < layer.source_duration_sec) fail('A looped movie card requires a frame-aligned 3–5 second excerpt and at most two cycles / 10 seconds.');
      } else {
        if (layer.source_duration_sec !== undefined) fail('source_duration_sec is reserved for an explicitly looped movie card.');
        if (asset.kind === 'movie_clip' && (duration < 3 || duration > 5)) fail('Movie layers must play for 3–5 seconds unless a bounded loop is explicit.');
      }
      const playbackDuration = layer.loop ? layer.source_duration_sec : duration;
      if (VIDEO_KINDS.has(asset.kind) && asset.duration_sec !== undefined && sourceIn(layer) + playbackDuration > asset.duration_sec + 0.002) fail('Video layer exceeds its declared local source duration.');
      if (layer.motion !== undefined) {
        const motion = layer.motion;
        if (!object(motion) || ['from_x', 'from_y', 'to_x', 'to_y'].some((key) => !finite(motion[key]))
          || !integer(motion.entrance_frames) || motion.entrance_frames < 1 || motion.entrance_frames > shot.end_frame - shot.start_frame
          || [motion.from_x, motion.to_x].some((n) => Math.abs(n) > WIDTH * 2)
          || [motion.from_y, motion.to_y].some((n) => Math.abs(n) > HEIGHT * 2)) fail('Invalid card motion.');
      }
    }
  }
  if (cursor !== FRAMES) fail('Shots must cover all 2700 frames.');
  for (const row of timeline.narration) {
    interval(row, 'Narration');
    assetFor(assets, row.asset_id, new Set(['narration']));
    if (!finite(row.gain_db) || row.gain_db < -60 || row.gain_db > 12) fail('Narration requires an explicit gain from -60 to 12 dB.');
  }
  for (let i = 0; i < timeline.narration.length; i += 1) {
    if (timeline.narration.slice(i + 1).some((row) => overlap(timeline.narration[i], row))) fail('Narration intervals must not overlap.');
  }
  for (const row of timeline.source_audio) {
    interval(row, 'Source audio');
    assetFor(assets, row.asset_id, new Set(['movie_clip']));
    if (!finite(row.gain_db) || row.gain_db < -60 || row.gain_db > 0) fail('Source audio requires an explicit gain from -60 to 0 dB.');
    if (!['under_narration', 'spotlight'].includes(row.mode)) fail('Source audio requires under_narration or spotlight mode.');
    const shot = timeline.shots.find((candidate) => candidate.id === row.shot_id);
    const layers = shot?.layers.filter((layer) => layer.asset_id === row.asset_id) ?? [];
    if (!shot || layers.length !== 1 || row.start_frame < shot.start_frame || row.start_frame + row.duration_frames > shot.end_frame) fail('Source audio must belong to exactly one visible movie layer and fit its shot.');
    if (layers[0].loop) fail('Looped movie cards must stay muted; source-audio repetition is unsupported.');
    const expectedOffset = sourceIn(layers[0]) + (row.start_frame - shot.start_frame) / FPS;
    if (Math.abs(sourceIn(row) - expectedOffset) > 0.000001) fail('Source audio and picture must preserve the same local source/output clock mapping.');
    if (row.mode === 'spotlight' && timeline.narration.some((narration) => overlap(row, narration))) fail('Source-audio spotlight must not overlap narration.');
  }
  for (let i = 0; i < timeline.source_audio.length; i += 1) {
    if (timeline.source_audio.slice(i + 1).some((row) => overlap(timeline.source_audio[i], row))) fail('Multiple source-audio tracks must not overlap.');
  }
  for (const caption of timeline.captions) {
    if (!integer(caption?.start_frame) || !integer(caption?.end_frame) || caption.start_frame < 0
      || caption.end_frame <= caption.start_frame || caption.end_frame > FRAMES
      || typeof caption.text !== 'string' || !caption.text.trim() || caption.text.length > 240
      || /[\u0000-\u0008\u000b-\u001f]/.test(caption.text)) fail('Invalid caption text/frame interval.');
  }
  const orderedCaptions = [...timeline.captions].sort((a, b) => a.start_frame - b.start_frame);
  if (orderedCaptions.some((row, i) => i && row.start_frame < orderedCaptions[i - 1].end_frame)) fail('Caption intervals must not overlap.');
  return [];
}

async function hashFile(filePath) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

async function mediaTool(executable, args, { timeoutMs, deadline, cwd } = {}) {
  if (deadline !== undefined) timeoutMs = Math.min(timeoutMs, deadline - Date.now());
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('Local media operation exceeded the render deadline.');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Avatar pilot: local media operation timed out.')); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 4 * 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('Avatar pilot: local media response exceeded its bound.')); } });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-32768); });
    child.on('error', () => finish(new Error('Avatar pilot: required local media executable could not start.')));
    child.on('close', (code) => finish(code === 0 ? null : new Error(`Avatar pilot: local media operation failed (${code}). ${stderr.slice(-2400)}`)));
  });
}

async function probeFile(filePath, ffprobePath, options, countFrames = false) {
  const { stdout } = await mediaTool(ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file',
    '-format_whitelist', 'mov,matroska,webm,wav,flac,mp3,aac',
    ...(countFrames ? ['-count_frames'] : []), '-show_streams', '-show_format', '-of', 'json', filePath], options);
  let probe;
  try { probe = JSON.parse(stdout); } catch { fail('Malformed local media probe.'); }
  if (!object(probe) || !Array.isArray(probe.streams) || !object(probe.format)) fail('Malformed local media probe.');
  return probe;
}

function streamDuration(stream, probe) {
  const value = Number(stream?.duration ?? probe.format?.duration);
  if (!Number.isFinite(value) || value <= 0) fail('Media has no measurable positive duration.');
  return value;
}

function usedAssetIds(timeline) {
  return [...new Set([
    ...timeline.shots.flatMap((shot) => [shot.background_asset_id, ...shot.layers.map((layer) => layer.asset_id)]),
    ...timeline.narration.map((row) => row.asset_id), ...timeline.source_audio.map((row) => row.asset_id),
  ].filter(Boolean))];
}

async function verifyAssets(timeline, assets, ffprobePath, options) {
  const verified = new Map(); let totalBytes = 0;
  for (const id of usedAssetIds(timeline)) {
    const asset = assetFor(assets, id);
    const stat = await fs.lstat(asset.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ASSET_BYTES) fail(`Asset ${id} is not a bounded local regular file.`);
    totalBytes += stat.size;
    if (totalBytes > 2 * 1024 * 1024 * 1024) fail('Local input byte budget exceeded.');
    if (await hashFile(asset.path) !== asset.sha256) fail(`Asset ${id} SHA-256 mismatch.`);
    const extension = path.extname(asset.path).toLowerCase();
    if (IMAGE_KINDS.has(asset.kind)) {
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) fail('Still inputs must be native PNG/JPEG/WebP rasters.');
      const metadata = await sharp(asset.path, { limitInputPixels: 40_000_000, animated: false }).metadata();
      if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) !== 1
        || !metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000) fail('Unsupported or animated still asset.');
      if (asset.kind === 'host_pose' && (metadata.format !== 'png' || !metadata.hasAlpha)) fail('Host poses must be PNG with an alpha channel.');
      verified.set(id, { ...asset, metadata, bytes: stat.size });
      continue;
    }
    if (VIDEO_KINDS.has(asset.kind) && !['.mp4', '.mkv'].includes(extension)) fail('Video inputs must be native local MP4/MKV.');
    if (asset.kind === 'narration' && !['.wav', '.flac', '.mp3', '.m4a', '.aac'].includes(extension)) fail('Narration requires a native local audio file.');
    const probe = await probeFile(asset.path, ffprobePath, options);
    const videos = probe.streams.filter((stream) => stream.codec_type === 'video');
    const audios = probe.streams.filter((stream) => stream.codec_type === 'audio');
    if (VIDEO_KINDS.has(asset.kind) && (videos.length !== 1 || !integer(videos[0].width) || !integer(videos[0].height) || videos[0].width < 2 || videos[0].height < 2
      || videos[0].width * videos[0].height > 40_000_000)) fail('Video inputs require exactly one bounded video stream.');
    if (asset.kind === 'narration' && (audios.length !== 1 || videos.length)) fail('Narration input must contain exactly one audio stream and no video.');
    const duration = streamDuration(VIDEO_KINDS.has(asset.kind) ? videos[0] : audios[0], probe);
    if (asset.duration_sec !== undefined && Math.abs(duration - asset.duration_sec) > 0.15) fail(`Asset ${id} declared duration differs from actual media.`);
    if (asset.kind === 'movie_clip' && (duration < 2.85 || duration > 5.15)) fail('Movie assets must already be bounded 3–5 second excerpts.');
    verified.set(id, { ...asset, probe, duration, bytes: stat.size });
  }
  for (const shot of timeline.shots) {
    const duration = (shot.end_frame - shot.start_frame) / FPS;
    for (const layer of shot.layers) {
      const asset = verified.get(layer.asset_id);
      if (VIDEO_KINDS.has(asset.kind) && sourceIn(layer) + (layer.loop ? layer.source_duration_sec : duration) > asset.duration + 0.002) fail('Video source is too short; implicit freeze or stretch is forbidden.');
    }
  }
  const finalNarration = [...timeline.narration].sort((a, b) => a.start_frame - b.start_frame).at(-1);
  const narrationTailRounding = [];
  for (const row of [...timeline.narration, ...timeline.source_audio]) {
    const asset = verified.get(row.asset_id);
    const audio = asset.probe.streams.find((stream) => stream.codec_type === 'audio');
    if (!audio) fail('An explicitly requested audio track is missing.');
    const audioStart = Number(audio.start_time ?? 0);
    const audioEnd = audioStart + streamDuration(audio, asset.probe);
    const rowEnd = sourceIn(row) + row.duration_frames / FPS;
    const finalNarrationTail = asset.kind === 'narration' && row === finalNarration
      && rowEnd > audioEnd && rowEnd - audioEnd <= 1 / FPS + 0.000001
      && row.duration_frames === Math.ceil((audioEnd - sourceIn(row)) * FPS - 0.000001);
    if (!Number.isFinite(audioStart) || sourceIn(row) < audioStart - 0.002
      || sourceIn(row) >= audioEnd || (rowEnd > audioEnd + 0.002 && !finalNarrationTail)) fail('Audio placement exceeds actual source audio bounds.');
    if (finalNarrationTail) narrationTailRounding.push({ asset_id: row.asset_id, start_frame: row.start_frame,
      duration_frames: row.duration_frames, source_in_sec: sourceIn(row), actual_source_duration_sec: audioEnd - sourceIn(row),
      unsounded_frame_tail_sec: rowEnd - audioEnd, treatment: 'natural_audio_end_inside_final_ceil_frame_no_padding_or_stretch' });
  }
  verified.narrationTailRounding = narrationTailRounding;
  return verified;
}

const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
function captionLines(text) {
  const lines = []; let line = '';
  for (const word of text.trim().split(/\s+/)) {
    if (line && line.length + word.length + 1 > 64) { lines.push(line); line = word; } else line += `${line ? ' ' : ''}${word}`;
  }
  if (line) lines.push(line);
  if (lines.length > 4 || lines.some((row) => row.length > 72)) fail('Caption cannot fit the readable four-line display area.');
  return lines;
}

async function textRaster(text, filePath, label = false) {
  const lines = label ? [text] : captionLines(text);
  const fontSize = label ? 32 : 44;
  const y = label ? 36 : HEIGHT - 62 - lines.length * 55;
  const boxWidth = label ? Math.min(1800, Math.max(360, text.length * 20 + 44)) : 1760;
  if (label && text.length > 88) fail('Truth label is too long to render readably.');
  const left = label ? 36 : 80;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><rect x="${left}" y="${y}" width="${boxWidth}" height="${lines.length * 55 + 20}" rx="12" fill="#000" fill-opacity="0.76"/>${lines.map((line, i) => `<text x="${label ? left + 22 : WIDTH / 2}" y="${y + 49 + i * 55}" font-family="sans-serif" font-size="${fontSize}" font-weight="600" text-anchor="${label ? 'start' : 'middle'}" fill="white">${xml(line)}</text>`).join('')}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

/** Renders approved local inputs only; never grants identity/rights/creative approval. */
export async function renderAvatarPilot({ timeline, assets, outputPath, workDir, ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe', timeoutMs = 600000 } = {}) {
  timeline = structuredClone(timeline);
  assets = structuredClone(assets);
  validatePilotTimeline(timeline, { assets });
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.mp4'
    || typeof workDir !== 'string' || !path.isAbsolute(workDir)) fail('Output MP4 and work directory must be absolute local paths.');
  if (!integer(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1200000) fail('Render timeout must be 1–1200 seconds.');
  try { await fs.lstat(outputPath); fail('Output already exists; overwriting is forbidden.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const deadline = Date.now() + timeoutMs;
  const options = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('Render timed out.');
    return { timeoutMs: remaining, deadline };
  };
  const verified = await verifyAssets(timeline, assets, ffprobePath, options());
  // Snapshot verified inputs before rendering, and hash the copied bytes. Later
  // changes at the caller's paths cannot alter the image/audio being composed.
  await fs.mkdir(workDir, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(workDir, 'avatar-pilot-'));
  try {
    let assetIndex = 0;
    for (const asset of verified.values()) {
      const copied = path.join(scratch, `asset_${assetIndex++}${path.extname(asset.path).toLowerCase()}`);
      await fs.copyFile(asset.path, copied, fs.constants.COPYFILE_EXCL);
      if (await hashFile(copied) !== asset.sha256) fail('Input changed while binding the local render snapshot.');
      asset.renderPath = copied;
    }
    const snapshots = Object.fromEntries([...verified].map(([id, asset]) => [id, { ...asset, path: asset.renderPath }]));
    const snapshotMedia = await verifyAssets(timeline, snapshots, ffprobePath, options());
    for (const [id, asset] of snapshotMedia) verified.set(id, { ...asset, renderPath: asset.path });
    verified.narrationTailRounding = snapshotMedia.narrationTailRounding;
    const shotFiles = [];
    for (const [index, shot] of timeline.shots.entries()) {
      options();
      const frameCount = shot.end_frame - shot.start_frame;
      const duration = frameCount / FPS;
      const args = ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-xerror', '-filter_complex_threads', '1',
        '-f', 'lavfi', '-i', `color=c=${shot.background_color ?? '#101018'}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${duration}`];
      const filters = ['[0:v]format=rgba[base0]'];
      let inputIndex = 1; let layerIndex = 0; let previous = 'base0';
      const addVisual = (filePath, { width = WIDTH, height = HEIGHT, x = 0, y = 0, video = false, offset = 0, motion, enable, loop = false, source_duration_sec } = {}) => {
        args.push('-protocol_whitelist', 'file');
        if (!video) args.push('-f', 'image2', '-loop', '1', '-framerate', String(FPS));
        else args.push('-format_whitelist', 'mov,matroska,webm');
        args.push('-i', filePath);
        const stream = `visual${layerIndex}`;
        filters.push(`[${inputIndex}:v:0]${video ? `trim=start=${offset}:duration=${loop ? source_duration_sec : duration},` : ''}setpts=PTS-STARTPTS,fps=${FPS},${loop ? `loop=loop=1:size=${Math.round(source_duration_sec * FPS)}:start=0,trim=duration=${duration},setpts=PTS-STARTPTS,` : ''}scale=${width}:${height}:force_original_aspect_ratio=decrease,format=rgba,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1[${stream}]`);
        const axis = (key, fixed) => motion ? `${motion[`from_${key}`]}+(${motion[`to_${key}`]}-(${motion[`from_${key}`]}))*min(t*${FPS}/${motion.entrance_frames},1)` : String(fixed);
        const next = `base${layerIndex + 1}`;
        filters.push(`[${previous}][${stream}]overlay=x='${axis('x', x)}':y='${axis('y', y)}':eval=frame:eof_action=endall:repeatlast=0:shortest=1${enable ? `:enable='${enable}'` : ''}[${next}]`);
        previous = next; inputIndex += 1; layerIndex += 1;
      };
      if (shot.background_asset_id) addVisual(verified.get(shot.background_asset_id).renderPath);
      for (const layer of [...shot.layers].sort((a, b) => a.z - b.z)) {
        const asset = verified.get(layer.asset_id);
        addVisual(asset.renderPath, { ...layer, offset: sourceIn(layer), video: VIDEO_KINDS.has(asset.kind) });
      }
      if (shot.truth_label?.trim()) {
        const labelPath = path.join(scratch, `label_${index}.png`);
        await textRaster(shot.truth_label.trim(), labelPath, true);
        addVisual(labelPath);
      }
      for (const [captionIndex, caption] of timeline.captions.entries()) {
        if (caption.start_frame >= shot.end_frame || caption.end_frame <= shot.start_frame) continue;
        const captionPath = path.join(scratch, `caption_${index}_${captionIndex}.png`);
        await textRaster(caption.text, captionPath);
        addVisual(captionPath, { enable: `gte(n,${Math.max(0, caption.start_frame - shot.start_frame)})*lt(n,${Math.min(frameCount, caption.end_frame - shot.start_frame)})` });
      }
      filters.push(`[${previous}]format=yuv420p[outv]`);
      const shotFile = path.join(scratch, `shot_${String(index).padStart(3, '0')}.mp4`);
      args.push('-filter_complex', filters.join(';'), '-map', '[outv]', '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
        '-frames:v', String(frameCount), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-threads', '2',
        '-pix_fmt', 'yuv420p', '-r', String(FPS), '-fps_mode', 'cfr', '-video_track_timescale', '15360', shotFile);
      await mediaTool(ffmpegPath, args, options());
      const probe = await probeFile(shotFile, ffprobePath, options(), true);
      if (Number(probe.streams.find((stream) => stream.codec_type === 'video')?.nb_read_frames) !== frameCount) fail('A shot ended before its exact frame bound; no silent hold is permitted.');
      shotFiles.push(shotFile);
    }
    const concatPath = path.join(scratch, 'shots.txt');
    await fs.writeFile(concatPath, shotFiles.map((filePath) => `file '${path.basename(filePath)}'\n`).join(''), { flag: 'wx' });
    const outputTemp = path.join(scratch, 'completed.mp4');
    const args = ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-xerror', '-filter_complex_threads', '1', '-protocol_whitelist', 'file',
      '-f', 'concat', '-safe', '1', '-i', concatPath, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=90'];
    const filters = ['[1:a]atrim=end_sample=4320000,asetpts=PTS-STARTPTS[bed]'];
    const mixLabels = ['[bed]'];
    for (const [index, row] of [...timeline.narration, ...timeline.source_audio].entries()) {
      const asset = verified.get(row.asset_id);
      args.push('-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,wav,flac,mp3,aac', '-i', asset.renderPath);
      const sampleCount = row.duration_frames * 1600;
      const delaySamples = row.start_frame * 1600;
      filters.push(`[${index + 2}:a:0]atrim=start=${sourceIn(row)}:duration=${row.duration_frames / FPS},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end_sample=${sampleCount},volume=${row.gain_db}dB,adelay=${delaySamples}S:all=1[audio${index}]`);
      mixLabels.push(`[audio${index}]`);
    }
    filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=4320000[outa]`);
    args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[outa]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-ar', '48000', '-ac', '2', '-map_metadata', '-1', '-map_chapters', '-1', '-t', '90', '-movflags', '+faststart', outputTemp);
    await mediaTool(ffmpegPath, args, options());
    const probe = await probeFile(outputTemp, ffprobePath, options(), true);
    const [video] = probe.streams.filter((stream) => stream.codec_type === 'video');
    const [audio] = probe.streams.filter((stream) => stream.codec_type === 'audio');
    if (probe.streams.length !== 2 || video?.codec_name !== 'h264' || video.pix_fmt !== 'yuv420p'
      || video.width !== WIDTH || video.height !== HEIGHT || video.avg_frame_rate !== '30/1'
      || Number(video.nb_read_frames) !== FRAMES || Math.abs(Number(video.duration) - 90) > 0.0001
      || audio?.codec_name !== 'aac' || Number(audio.sample_rate) !== 48000 || audio.channels !== 2
      || [video.duration, audio?.duration, audio?.start_time, probe.format.duration].some((value) => !Number.isFinite(Number(value)))
      || Math.abs(Number(audio.duration) - 90) > 0.025 || Math.abs(Number(audio.start_time ?? 0)) > 0.025
      || Math.abs(Number(probe.format.duration) - 90) > 0.025) fail('Final codec, stream, frame-count, or duration verification failed.');
    const stats = await mediaTool(ffmpegPath, ['-hide_banner', '-v', 'info', '-nostdin', '-xerror', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-i', outputTemp,
      '-map', '0:a:0', '-af', 'atrim=end_sample=4320000,astats=metadata=0:reset=0,ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], options());
    const readStat = (name) => {
      const values = [...stats.stderr.matchAll(new RegExp(`${name}: (-?inf|[-+0-9.]+)`, 'g'))];
      if (!values.length) fail('Final audio measurement is unavailable.');
      return values.at(-1)[1] === '-inf' ? null : Number(values.at(-1)[1]);
    };
    if (readStat('Number of samples') !== 4320000 || readStat('Number of NaNs') !== 0 || readStat('Number of Infs') !== 0) fail('Final audio sample accounting or finite-signal verification failed.');
    const loudnessValue = (pattern) => {
      const match = stats.stderr.match(pattern);
      if (!match) fail('Final loudness measurement is unavailable.');
      if (match[1] === '-inf') return null;
      const value = Number(match[1]);
      if (!Number.isFinite(value)) fail('Final loudness measurement is malformed.');
      return value;
    };
    const audioStats = {
      schema: 'goldflow_avatar_pilot_final_audio_measurement_v1',
      measurement: 'ffmpeg_astats_ebur128_final_aac_90_second_window_v1',
      duration_sec: 90, sample_rate: 48000, measured_samples_per_channel: 4320000,
      normalization_applied: false,
      peak_dbfs: readStat('Peak level dB'), rms_dbfs: readStat('RMS level dB'),
      integrated_lufs: loudnessValue(/Integrated loudness:\s+I:\s+(-?inf|[-+0-9.]+) LUFS/),
      loudness_range_lu: loudnessValue(/Loudness range:\s+LRA:\s+(-?inf|[-+0-9.]+) LU/),
      true_peak_dbfs: loudnessValue(/True peak:\s+Peak:\s+(-?inf|[-+0-9.]+) dBFS/),
    };
    if (audioStats.peak_dbfs !== null && (!Number.isFinite(audioStats.peak_dbfs) || audioStats.peak_dbfs >= 0)) fail('Final mixed audio clips; revise the approved gains instead of normalizing silently.');
    if (audioStats.true_peak_dbfs !== null && audioStats.true_peak_dbfs >= 0) fail('Final mixed audio has a clipping true peak; revise the approved mix explicitly.');
    const sha256 = await hashFile(outputTemp);
    audioStats.render_sha256 = sha256;
    audioStats.report_sha256 = createHash('sha256').update(JSON.stringify(audioStats)).digest('hex');
    // Hard-link publication is atomic and fails if ANY output already exists.
    // Cross-device destinations are deliberately unsupported rather than copied
    // into a partially visible output. Put workDir on the output filesystem.
    options();
    await fs.link(outputTemp, outputPath);
    return { output_path: outputPath, sha256, duration_frames: FRAMES, duration_sec: 90, width: WIDTH, height: HEIGHT, fps: FPS,
      probe, audio_stats: audioStats, narration_tail_rounding: verified.narrationTailRounding,
      input_sha256: Object.fromEntries([...verified].map(([id, asset]) => [id, asset.sha256])) };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
