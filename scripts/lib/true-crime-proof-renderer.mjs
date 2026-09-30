import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import sharp from 'sharp';
// Reuse only the source-agnostic outline/placement mechanics, never host mattes or story recipes.
import { sticker, place } from './avatar-pilot-style-preview-renderer.mjs';

export const TRUE_CRIME_PROOF_SCHEMA = 'goldflow_true_crime_proof_render_v1';
const W = 1920, H = 1080, FPS = 30;
const exec = promisify(execFile);
const env = { PATH: process.env.PATH, LANG: 'C' };
const hash = (data) => createHash('sha256').update(data).digest('hex');
const fileRef = async (file) => ({ path: file, sha256: hash(await fs.readFile(file)) });
const fail = (message) => { throw new Error(`True-crime proof: ${message}`); };
const number = (v, name, min = 0, max = Infinity) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`invalid ${name}`);
  return v;
};
const words = (s) => String(s).trim().split(/\s+/u);
const normalized = (s) => words(s).join(' ');
const textValue = (s, name, max = 4000) => {
  if (typeof s !== 'string' || !s.trim() || s.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(s)) fail(`invalid ${name}`);
};
const xml = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const color = (v, fallback) => {
  const c = v ?? fallback;
  if (!/^#[\da-f]{6}([\da-f]{2})?$/iu.test(c)) fail('colors must be #RRGGBB or #RRGGBBAA');
  return c;
};
const raster = (body, width = W, height = H) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`)).png().toBuffer();
const type = (s, x, y, size, fill = '#fffdf8', weight = 600, anchor = 'start') => `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${xml(s)}</text>`;
function linesFor(text, width, size) {
  const max = Math.floor(width / (size * .57));
  const lines = []; let line = '';
  for (const word of words(text)) {
    if (word.length > max) fail('an unbreakable text token is too wide for its box');
    if (line && line.length + word.length + 1 > max) { lines.push(line); line = ''; }
    line += `${line ? ' ' : ''}${word}`;
  }
  if (line) lines.push(line);
  return lines;
}
function assertRef(ref, label) {
  if (!ref || typeof ref.path !== 'string' || !path.isAbsolute(ref.path) || !/^[\da-f]{64}$/u.test(ref.sha256 ?? '')) fail(`${label} requires absolute local path and sha256`);
}
function transformKeys(layer, duration) {
  const defaults = { x: layer.x ?? 0, y: layer.y ?? 0, scale: layer.scale ?? 1, opacity: layer.opacity ?? 1, rotation: layer.rotation ?? 0 };
  const authored = layer.keyframes ?? [];
  if (!Array.isArray(authored) || authored.length > 100) fail('invalid keyframes');
  const rows = [{ time_sec: 0, ...defaults, easing: 'linear' }];
  let last = -1;
  for (const k of authored) {
    number(k.time_sec, 'keyframe time', 0, duration);
    if (k.time_sec <= last) fail('keyframes must be strictly increasing');
    if (k.easing && !['linear', 'ease_out', 'ease_in_out'].includes(k.easing)) fail('unknown easing');
    const next = { ...rows.at(-1), ...k };
    if (k.time_sec === 0) rows[0] = next; else rows.push(next);
    last = k.time_sec;
  }
  for (const k of rows) {
    number(k.x, 'layer x', -8000, 8000); number(k.y, 'layer y', -8000, 8000);
    number(k.scale, 'layer scale', .05, 4); number(k.opacity, 'layer opacity', 0, 1);
    number(k.rotation, 'layer rotation', -360, 360);
  }
  return rows;
}

/** Scene-local seconds; each layer owns its entrance, settle and subsequent movement. */
export function evaluateProofTransform(keys, time) {
  let a = keys[0], b = a;
  for (const k of keys.slice(1)) { b = k; if (time < k.time_sec) break; a = k; }
  let p = b.time_sec === a.time_sec ? 0 : Math.min(1, Math.max(0, (time - a.time_sec) / (b.time_sec - a.time_sec)));
  if (b.easing === 'ease_out') p = 1 - (1 - p) ** 3;
  if (b.easing === 'ease_in_out') p = p * p * (3 - 2 * p);
  return Object.fromEntries(['x', 'y', 'scale', 'opacity', 'rotation'].map((key) => [key, a[key] + (b[key] - a[key]) * p]));
}

/** Exact text, with honest estimated phrase timing when only measured unit bounds exist. */
export function proofCaptionPhrases(unit) {
  if (unit.phrases) {
    if (!Array.isArray(unit.phrases) || !unit.phrases.length || normalized(unit.phrases.map((p) => p.text).join(' ')) !== normalized(unit.text)) fail(`caption text differs from unit ${unit.id}`);
    let end = unit.start_sec;
    for (const p of unit.phrases) {
      textValue(p.text, 'phrase text'); number(p.start_sec, 'phrase start', unit.start_sec, unit.end_sec);
      number(p.end_sec, 'phrase end', p.start_sec, unit.end_sec);
      if (p.start_sec < end - 1e-6 || p.end_sec <= p.start_sec) fail('phrase timings overlap or have no duration');
      if (linesFor(p.text, 1560, 44).length > 2) fail('caption phrase exceeds two readable lines');
      end = p.end_sec;
    }
    return unit.phrases.map((p) => ({ ...p, timing_basis: 'supplied_phrase_intervals' }));
  }
  const tokens = words(unit.text), chunks = [];
  for (let start = 0; start < tokens.length;) {
    let end = Math.min(tokens.length, start + 8);
    for (let i = start + 3; i < end; i++) if (/[.!?;:]$/u.test(tokens[i])) { end = i + 1; break; }
    const phrase = tokens.slice(start, end).join(' ');
    if (linesFor(phrase, 1560, 44).length > 2) fail('caption phrase exceeds two readable lines');
    chunks.push({ text: phrase, start_sec: unit.start_sec + (unit.end_sec - unit.start_sec) * start / tokens.length, end_sec: unit.start_sec + (unit.end_sec - unit.start_sec) * end / tokens.length, timing_basis: 'estimated_within_measured_unit' });
    start = end;
  }
  return chunks;
}

/** Pure validation/planning: no source acquisition, provider execution, directory creation or approval. */
export function planTrueCrimeProof(manifest) {
  if (manifest?.schema !== TRUE_CRIME_PROOF_SCHEMA || !['private_proof', 'synthetic_fixture'].includes(manifest.scope) || manifest.production_eligible !== false) fail('explicit private proof identity required');
  for (const key of ['channel', 'series', 'run', 'episode', 'title']) textValue(manifest.identity?.[key], `identity.${key}`, 160);
  assertRef(manifest.narration, 'narration');
  const units = manifest.narration.units;
  if (!Array.isArray(units) || !units.length || units.length > 150) fail('narration units required');
  const ids = new Set(); let sourceEnd = 0;
  for (const unit of units) {
    textValue(unit.id, 'unit id', 100); textValue(unit.text, 'unit text');
    if (ids.has(unit.id)) fail('duplicate narration unit'); ids.add(unit.id);
    number(unit.start_sec, 'unit start'); number(unit.end_sec, 'unit end', unit.start_sec, 150);
    if (Math.abs(unit.start_sec - sourceEnd) > 1e-6 || unit.end_sec <= unit.start_sec) fail('measured unit intervals must cover the WAV contiguously from zero');
    sourceEnd = unit.end_sec;
    proofCaptionPhrases(unit);
  }
  if (!Array.isArray(manifest.scenes) || !manifest.scenes.length || manifest.scenes.length > 50) fail('scenes required');
  const scenes = [], captions = []; let cursor = 0, index = 0, totalHolds = 0;
  const sceneIds = new Set();
  for (const scene of manifest.scenes) {
    textValue(scene.id, 'scene id', 100);
    if (sceneIds.has(scene.id)) fail('duplicate scene id'); sceneIds.add(scene.id);
    textValue(scene.source_label, 'source label', 230); textValue(scene.disclosure, 'continuous disclosure', 110);
    if (!Array.isArray(scene.narration_unit_ids) || !scene.narration_unit_ids.length) fail('each scene must bind narration units');
    const assigned = units.slice(index, index + scene.narration_unit_ids.length);
    if (assigned.length !== scene.narration_unit_ids.length || assigned.some((u, i) => u.id !== scene.narration_unit_ids[i])) fail('scenes must consume every narration unit once in source order');
    const before = number(scene.hold_before_sec ?? 0, 'hold before', 0, 6), after = number(scene.hold_after_sec ?? 0, 'hold after', 0, 6);
    if (before || after) textValue(scene.hold_note, 'authored hold note', 500);
    totalHolds += before + after;
    const start = assigned[0].start_sec, end = assigned.at(-1).end_sec;
    const duration = end - start + before + after;
    const bg = scene.background ?? {};
    color(bg.color, '#17222b');
    if (bg.path) assertRef(bg, 'background');
    const backgroundKeys = transformKeys(bg, duration);
    if (!Array.isArray(scene.layers) || scene.layers.length > 20) fail('scene.layers must be an array of at most 20 layers');
    const layerIds = new Set();
    const layers = scene.layers.map((layer) => {
      textValue(layer.id, 'layer id', 100);
      if (layerIds.has(layer.id)) fail('duplicate layer id'); layerIds.add(layer.id);
      if (!['image', 'card', 'text'].includes(layer.type)) fail('only local image/card/text layers are supported');
      number(layer.width, 'layer width', 16, W * 2); number(layer.height, 'layer height', 16, H * 2);
      if (!Number.isInteger(layer.width) || !Number.isInteger(layer.height)) fail('layer dimensions must be integer pixels');
      if (layer.path) assertRef(layer, 'image layer');
      if (layer.type === 'image' && !layer.path) fail('image layer requires local source');
      if (layer.cutout && (layer.type !== 'image' || !layer.path || layer.height <= 96)) fail('cutout requires an image source and height above 96px');
      if (layer.text !== undefined) textValue(layer.text, 'layer text', 1000);
      if (layer.type === 'text' && !layer.text) fail('text layer needs text');
      if (layer.type === 'card' && !layer.path && !layer.text) fail('card needs image or text');
      if (layer.font_size !== undefined) number(layer.font_size, 'font size', 20, 100);
      color(layer.fill, '#ede9df'); color(layer.text_color, '#1c2933');
      return { ...layer, transform_keys: transformKeys(layer, duration) };
    });
    const row = { ...scene, background: { ...bg, transform_keys: backgroundKeys }, layers, start_sec: cursor, end_sec: cursor + duration, duration_sec: duration, source_in_sec: start, source_out_sec: end, narration_start_sec: cursor + before };
    for (const unit of assigned) for (const phrase of proofCaptionPhrases(unit)) captions.push({ ...phrase, unit_id: unit.id, scene_id: scene.id, source_start_sec: phrase.start_sec, source_end_sec: phrase.end_sec, start_sec: cursor + before + phrase.start_sec - start, end_sec: cursor + before + phrase.end_sec - start });
    scenes.push(row); cursor += duration; index += assigned.length;
  }
  if (index !== units.length) fail('scenes omit narration units');
  if (totalHolds > 35) fail('authored holds exceed 35 seconds');
  const minimum = manifest.scope === 'synthetic_fixture' ? .5 : 90;
  if (cursor < minimum || cursor > 150) fail(`duration must be ${minimum}–150 seconds from narration plus authored holds`);
  const frames = Math.ceil(cursor * FPS - 1e-7);
  return { schema: 'goldflow_true_crime_proof_timeline_v1', width: W, height: H, fps: FPS, duration_frames: frames, duration_sec: frames / FPS, authored_duration_sec: cursor, rounding_silence_sec: Math.max(0, frames / FPS - cursor), source_duration_sec: sourceEnd, authored_holds_sec: totalHolds, narration_tempo: 1, scenes, captions };
}

async function boundBytes(ref, label) {
  const data = await fs.readFile(ref.path);
  if (hash(data) !== ref.sha256) fail(`${label} source hash changed`);
  return data;
}
async function prepareLayer(layer) {
  let image;
  if (layer.path) {
    const data = await boundBytes(layer, layer.id);
    const metadata = await sharp(data).metadata();
    if (!['png', 'jpeg', 'webp', 'tiff'].includes(metadata.format)) fail('only local raster source images are supported');
    if (layer.cutout) {
      const stats = await sharp(data).ensureAlpha().stats();
      if (!metadata.hasAlpha || stats.channels.at(-1).min === 255) fail(`${layer.id} cutout requires actual transparency`);
      // The reused primitive keeps a light outline and soft shadow; source bytes stay immutable.
      image = await sticker(data, layer.height - 76);
      image = await sharp(image).resize(layer.width, layer.height, { fit: 'inside', withoutEnlargement: false }).png().toBuffer();
    } else image = await sharp(data).resize(layer.width, layer.height, { fit: layer.fit ?? 'contain', background: '#00000000' }).ensureAlpha().png().toBuffer();
  }
  if (layer.type === 'card' || layer.type === 'text') {
    let body = layer.type === 'card' ? `<rect width="${layer.width}" height="${layer.height}" rx="${Math.min(22, layer.height / 8)}" fill="${color(layer.fill, '#ede9df')}"/>` : '';
    if (layer.text) {
      const font = layer.font_size ?? 42, lines = linesFor(layer.text, layer.width - 64, font);
      if (lines.length * font * 1.25 + 48 > layer.height) fail(`${layer.id} text overflows its box`);
      body += lines.map((line, i) => type(line, 32, 34 + font + i * font * 1.25, font, color(layer.text_color, '#1c2933'))).join('');
    }
    const card = await raster(body, layer.width, layer.height);
    if (image) {
      const inner = await sharp(image).resize(layer.width - 32, layer.height - 32, { fit: 'contain', background: '#00000000' }).png().toBuffer();
      if (layer.text) fail('use separate text and image layers for a card with both');
      image = await sharp(card).composite([{ input: inner, top: 16, left: 16 }]).png().toBuffer();
    } else image = card;
  }
  return image;
}
async function transformed(input, keys, time) {
  const t = evaluateProofTransform(keys, time);
  if (t.opacity < .001) return null;
  let data = input;
  if (t.rotation) data = await sharp(data).rotate(t.rotation, { background: '#00000000' }).png().toBuffer();
  if (t.opacity < .9999) {
    const alpha = await sharp(data).ensureAlpha().extractChannel('alpha').linear(t.opacity).png().toBuffer();
    data = await sharp(data).removeAlpha().joinChannel(alpha).png().toBuffer();
  }
  return place(data, t.x, t.y, t.scale);
}
async function labelsFor(scene) {
  const disclosureLines = linesFor(scene.disclosure, 1740, 27);
  const sourceLines = linesFor(scene.source_label, 1470, 23);
  if (disclosureLines.length > 2 || sourceLines.length > 2) fail('source/disclosure label exceeds safe readable area');
  let body = `<rect x="48" y="26" width="1824" height="${28 + disclosureLines.length * 35}" rx="10" fill="#0b141de8"/>`;
  disclosureLines.forEach((line, i) => { body += type(line, 72, 62 + i * 35, 27); });
  body += '<rect x="0" y="997" width="1920" height="83" fill="#0b141df5"/>';
  sourceLines.forEach((line, i) => { body += type(line, 55, 1027 + i * 29, 23, '#e5e4df', 500); });
  body += type('PRIVATE PROOF', 1862, 1045, 22, '#c1c9cb', 600, 'end');
  return raster(body);
}
async function captionImage(text) {
  const lines = linesFor(text, 1560, 44);
  const y = 966 - lines.length * 57;
  return raster(`<rect x="136" y="${y - 47}" width="1648" height="${lines.length * 57 + 25}" rx="15" fill="#071119e8"/>${lines.map((line, i) => type(line, 960, y + i * 57, 44, '#fffdf8', 700, 'middle')).join('')}`);
}
function audioFilter(plan, sampleRate) {
  const scenes = plan.scenes, chains = [];
  chains.push(`[1:a:0]asplit=${scenes.length}${scenes.map((_, i) => `[n${i}]`).join('')}`);
  scenes.forEach((scene, i) => chains.push(`[n${i}]atrim=start_sample=${Math.round(scene.source_in_sec * sampleRate)}:end_sample=${Math.round(scene.source_out_sec * sampleRate)},asetpts=PTS-STARTPTS,adelay=${Math.round(scene.narration_start_sec * sampleRate)}S:all=1[a${i}]`));
  const samples = Math.ceil(plan.duration_sec * sampleRate - 1e-7);
  // Bound silence in samples; never leave an infinite apad source upstream of a time trim.
  chains.push(`${scenes.map((_, i) => `[a${i}]`).join('')}amix=inputs=${scenes.length}:normalize=0,apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=N/SR/TB[a]`);
  return chains.join(';');
}
async function probe(file, countFrames = false) {
  const args = ['-v', 'error', '-protocol_whitelist', 'file', ...(countFrames ? ['-count_frames'] : []), '-show_streams', '-show_format', '-of', 'json', file];
  return JSON.parse((await exec('ffprobe', args, { env, timeout: 60000, maxBuffer: 2 * 1024 * 1024 })).stdout);
}

/** Local compositor only. Caller supplies the separate applicable identity/review workflow. */
export async function renderTrueCrimeProof({ outputDir, manifest, onProgress } = {}) {
  const plan = planTrueCrimeProof(manifest);
  if (!path.isAbsolute(outputDir ?? '')) fail('outputDir must be absolute');
  await boundBytes(manifest.narration, 'narration');
  const audioProbe = await probe(manifest.narration.path);
  const audio = audioProbe.streams.find((s) => s.codec_type === 'audio');
  const sampleRate = Number(audio?.sample_rate), audioDuration = Number(audio?.duration ?? audioProbe.format?.duration);
  if (audioProbe.format?.format_name !== 'wav' || !audio?.codec_name?.startsWith('pcm_') || !Number.isFinite(sampleRate)) fail('narration must be a measured PCM WAV');
  if (Math.abs(audioDuration - plan.source_duration_sec) > 1 / sampleRate + 1e-6) fail('unit timings do not cover the entire measured narration WAV');
  const prepared = [];
  for (const scene of plan.scenes) {
    const base = await sharp({ create: { width: W, height: H, channels: 3, background: color(scene.background.color, '#17222b') } }).png().toBuffer();
    let background = null;
    if (scene.background.path) {
      const data = await boundBytes(scene.background, 'background');
      if (!['png', 'jpeg', 'webp', 'tiff'].includes((await sharp(data).metadata()).format)) fail('background requires a local raster source');
      background = await sharp(data).resize(W, H, { fit: 'cover' }).ensureAlpha().png().toBuffer();
    }
    const layers = [];
    for (const layer of scene.layers) layers.push({ ...layer, image: await prepareLayer(layer) });
    prepared.push({ scene, base, background, layers, labels: await labelsFor(scene) });
  }
  const captions = [];
  for (const caption of plan.captions) captions.push({ ...caption, image: await captionImage(caption.text) });
  // All validation and source checks happen before creating any output artifact.
  await fs.mkdir(outputDir, { recursive: true });
  if ((await fs.readdir(outputDir)).length) fail('output directory must be empty; retained candidates are never overwritten');
  await fs.writeFile(path.join(outputDir, 'render-input.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  await fs.writeFile(path.join(outputDir, 'timeline.json'), JSON.stringify(plan, null, 2), { flag: 'wx' });
  const videoPath = path.join(outputDir, 'private-proof.mp4');
  const child = spawn('ffmpeg', ['-v', 'error', '-n', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-video_size', `${W}x${H}`, '-framerate', String(FPS), '-i', 'pipe:0', '-protocol_whitelist', 'file', '-i', manifest.narration.path, '-filter_complex', audioFilter(plan, sampleRate), '-map', '0:v:0', '-map', '[a]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-frames:v', String(plan.duration_frames), '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', '-map_metadata', '-1', '-movflags', '+faststart', videoPath], { env, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '', pipeError;
  child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-8000); });
  child.stdin.on('error', (error) => { pipeError = error; child.kill('SIGKILL'); });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`True-crime proof encoder failed: ${stderr}`))); });
  done.catch(() => {});
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30 * 60 * 1000);
  const frames = [], captures = new Set(plan.scenes.flatMap((s) => [Math.ceil(s.start_sec * FPS), Math.min(plan.duration_frames - 1, Math.floor((s.start_sec + s.duration_sec * .67) * FPS))]));
  let sceneIndex = 0, captionIndex = 0;
  const started = Date.now();
  try {
    for (let frame = 0; frame < plan.duration_frames; frame++) {
      const time = frame / FPS;
      while (sceneIndex < prepared.length - 1 && time >= prepared[sceneIndex].scene.end_sec - 1e-8) sceneIndex++;
      while (captionIndex < captions.length && time >= captions[captionIndex].end_sec) captionIndex++;
      const p = prepared[sceneIndex], local = time - p.scene.start_sec, overlays = [];
      if (p.background) overlays.push(await transformed(p.background, p.scene.background.transform_keys, local));
      for (const layer of p.layers) overlays.push(await transformed(layer.image, layer.transform_keys, local));
      const caption = captions[captionIndex];
      if (caption && time >= caption.start_sec && time < caption.end_sec) overlays.push({ input: caption.image, left: 0, top: 0 });
      overlays.push({ input: p.labels, left: 0, top: 0 });
      const composed = sharp(p.base).composite(overlays.filter(Boolean));
      const raw = await composed.removeAlpha().raw().toBuffer();
      if (captures.has(frame)) {
        const file = path.join(outputDir, `frame-${String(frame).padStart(5, '0')}.png`);
        await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
        frames.push({ frame, ...await fileRef(file) });
      }
      if (pipeError) throw pipeError;
      if (!child.stdin.write(raw)) await Promise.race([once(child.stdin, 'drain'), done.then(() => { throw new Error('Encoder ended before all planned frames'); })]);
      if (frame % 150 === 0) onProgress?.({ frame, total_frames: plan.duration_frames, elapsed_sec: (Date.now() - started) / 1000 });
    }
    child.stdin.end(); await done;
  } catch (error) { child.kill('SIGKILL'); await done.catch(() => {}); throw error; }
  finally { clearTimeout(deadline); }
  // Reject a candidate if any caller-owned source changed during the render.
  await boundBytes(manifest.narration, 'narration');
  for (const s of plan.scenes) { if (s.background.path) await boundBytes(s.background, 'background'); for (const l of s.layers) if (l.path) await boundBytes(l, l.id); }
  const measured = await probe(videoPath, true), video = measured.streams.find((s) => s.codec_type === 'video'), encodedAudio = measured.streams.find((s) => s.codec_type === 'audio');
  if (video?.width !== W || video?.height !== H || video?.avg_frame_rate !== '30/1' || Number(video?.nb_read_frames) !== plan.duration_frames || !encodedAudio || !Number.isFinite(Number(encodedAudio.duration)) || Math.abs(Number(encodedAudio.duration) - plan.duration_sec) > .05 || Math.abs(Number(measured.format.duration) - plan.duration_sec) > .08) fail('encoded dimension/frame/audio/duration QA failed');
  const report = { schema: 'goldflow_true_crime_proof_render_qa_v1', identity: manifest.identity, scope: manifest.scope, production_eligible: false, review_only: true, exact_program_approval_recorded: false, width: W, height: H, fps: FPS, duration_frames: plan.duration_frames, duration_sec: plan.duration_sec, authored_holds_sec: plan.authored_holds_sec, narration_tempo: 1, source_audio_sha256: manifest.narration.sha256, captions: plan.captions, caption_timing_limitation: 'Estimated phrase timing is not word alignment; supplied intervals retain their declared basis.', continuous_source_and_disclosure_labels: true, independent_layers: true, frames, probe: measured, elapsed_sec: (Date.now() - started) / 1000, audio_review: 'Source PCM retained in order at original tempo; AAC encoded once. No loudness or subjective listening approval is asserted.' };
  const qaPath = path.join(outputDir, 'render-qa.json');
  await fs.writeFile(qaPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  return { output: await fileRef(videoPath), technical_report: await fileRef(qaPath), timeline: await fileRef(path.join(outputDir, 'timeline.json')), width: W, height: H, fps: FPS, duration_frames: plan.duration_frames, duration_sec: plan.duration_sec, frames, review_only: true };
}
