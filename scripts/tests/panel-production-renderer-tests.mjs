import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { sha256File } from '../lib/file-hash.mjs';
import { buildPanelProductionPicture, assertPanelProductionPictureCurrent } from '../lib/panel-production-renderer.mjs';
import { validatePanelTimeline } from '../lib/panel-layout-validation.mjs';
import { createPanelProductionContract } from '../lib/panel-production-policy.mjs';
import { mediaWorkflowForPreflight } from '../lib/media-workflows.mjs';
import { panelProductionFixture, writeJson } from './panel-production-fixture.mjs';
import { preparePanelProductionPlan, compilePanelProductionPlan } from '../lib/panel-production-plan.mjs';

const exec = promisify(execFile);
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'panel-production-renderer-')));
const write = (file, data) => fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
const full = { x: 0, y: 0, width: 1, height: 1 }, camera = { x: 0.5, y: 0.5, zoom: 1 };
const key = (at_sec, rect = full, easing = 'hold') => ({ at_sec, rect: { ...rect }, camera: { ...camera }, opacity: 1, easing });
let count = 0;
const test = async (name, run) => { await run(); count++; console.log(`ok - production panel picture: ${name}`); };
const pixel = async (video, time) => {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', video, '-vf', 'crop=2:2:958:538,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
  return [...stdout.subarray(0, 3)];
};
const color = (actual, channel) => { assert.ok(actual[channel] > 220, `${actual} missing channel ${channel}`); for (let i = 0; i < 3; i++) if (i !== channel) assert.ok(actual[i] < 35, `${actual} unexpected channel ${i}`); };

try {
  const episodeDir = path.join(root, 'fixture-episode'); await fs.mkdir(episodeDir);
  const identityPath = path.join(episodeDir, 'run_identity.json');
  const identity = { schema: 'goldflow_run_identity_v2', run_intent: 'production', content_profile: 'manhwa_recap_v1', ...mediaWorkflowForPreflight({ contentProfile: 'manhwa_recap_v1', mediaWorkflow: 'generated_visuals_v1' }), audio_target: 'narrator_only', render_profile: 'panel_composition_v1', generated_motion_policy: 'disabled', parallax_policy: 'disabled', episode: 'ep_01', panel_composition_contract: createPanelProductionContract() };
  await write(identityPath, identity);
  const artwork = path.join(episodeDir, 'page.png');
  await sharp({ create: { width: 160, height: 270, channels: 3, background: '#ff0000' } }).composite([
    { input: await sharp({ create: { width: 160, height: 90, channels: 3, background: '#00ff00' } }).png().toBuffer(), left: 0, top: 90 },
    { input: await sharp({ create: { width: 160, height: 90, channels: 3, background: '#0000ff' } }).png().toBuffer(), left: 0, top: 180 },
  ]).png().toFile(artwork);
  const audioPath = path.join(episodeDir, 'narration.wav');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=320:duration=2.012:sample_rate=48000', '-c:a', 'pcm_s16le', audioPath]);
  const asset = { id: 'page', path: artwork, sha256: await sha256File(artwork), origin: 'test_fixture', provenance: 'Locally authored colored raster fixture.' };
  const timeline = { schema: 'goldflow_panel_production_timeline_v1', intent: 'production_panel_composition', content_profile: 'manhwa_recap_v1', id: 'production-fixture', run_identity: { path: identityPath, sha256: await sha256File(identityPath) }, audio_target: 'narrator_only', audio: { path: audioPath, sha256: await sha256File(audioPath), offset_sec: 0 }, width: 1920, height: 1080, fps: 30, duration_sec: 2.012, assets: [asset], panels: [
    { id: 'red', asset_id: 'page', source_rect: { x: 0, y: 0, width: 1, height: 1 / 3 } },
    { id: 'incoming', asset_id: 'page', source_rect: { x: 0, y: 2 / 3, width: 1, height: 1 / 3 } },
  ], scenes: [
    { id: 'hold', start_sec: 0, end_sec: 1, background: { panel_id: 'red', blur_px: 0, brightness: 0 }, layers: [{ id: 'held', panel_id: 'red', start_sec: 0, end_sec: 1, z: 0, fit: 'contain', border_px: 0, keyframes: [key(0), key(1)] }] },
    { id: 'reveal', start_sec: 1, end_sec: 2.012, background: { panel_id: 'red', blur_px: 0, brightness: 0 }, layers: [
      { id: 'context', panel_id: 'red', start_sec: 1, end_sec: 1.6, z: 0, fit: 'contain', border_px: 0, keyframes: [key(1), key(1.6)] },
      { id: 'enter', panel_id: 'incoming', start_sec: 1.2, end_sec: 2.012, z: 1, fit: 'contain', border_px: 0, keyframes: [key(1.2, { ...full, x: 1.03 }, 'smooth'), key(1.4), key(2.012)] },
    ] },
  ] };
  const planPath = path.join(episodeDir, 'panel_timeline_ep_01.json'); await write(planPath, timeline);
  const inputHashes = { [identityPath]: timeline.run_identity.sha256, [artwork]: asset.sha256, [audioPath]: timeline.audio.sha256, [planPath]: await sha256File(planPath) };
  const loadedPlan = { timeline, assets: [{ ...asset, width: 160, height: 270 }], audio: timeline.audio, inputHashes, planPath };
  const options = { episodeDir, loadedPlan, workDir: path.join(episodeDir, 'assets', 'render-work'), width: 1920, height: 1080, fps: 30, chunkDurationSec: 1 };
  const originals = { ...inputHashes };
  let first;
  await test('real cached picture preserves authored crops and reveal onset, with no audio', async () => {
    first = await buildPanelProductionPicture(options);
    assert.equal(first.status, 'passed'); assert.equal(first.media.audio_stream_count, 0); assert.equal(first.media.frame_count, 60);
    assert.equal(first.cache_stats.rendered_chunk_count, 2); assert.ok(first.cache_stats.unchanged_frame_reuse_count > 30);
    color(await pixel(first.videoPath, 0.8), 0); color(await pixel(first.videoPath, 1.1), 0); color(await pixel(first.videoPath, 1.5), 2);
    for (const [file, hash] of Object.entries(originals)) assert.equal(await sha256File(file), hash);
  });
  await test('unchanged picture reuses every verified chunk and keeps prior attempt immutable', async () => {
    const second = await buildPanelProductionPicture(options);
    assert.notEqual(first.videoPath, second.videoPath); assert.equal(second.cache_stats.reused_chunk_count, 2); assert.equal(second.cache_stats.rendered_chunk_count, 0);
    assert.deepEqual(second.chunks.map(row => row.sha256), first.chunks.map(row => row.sha256)); await assertPanelProductionPictureCurrent(first);
  });
  await test('one authored crop change invalidates only its picture range', async () => {
    loadedPlan.timeline = structuredClone(timeline); loadedPlan.timeline.panels[1].source_rect.y = 1 / 3;
    await write(planPath, loadedPlan.timeline); loadedPlan.inputHashes = { ...inputHashes, [planPath]: await sha256File(planPath) };
    const changed = await buildPanelProductionPicture(options);
    assert.equal(changed.cache_stats.reused_chunk_count, 1); assert.equal(changed.cache_stats.rendered_chunk_count, 1);
    assert.equal(changed.chunks[0].sha256, first.chunks[0].sha256); assert.notEqual(changed.chunks[1].sha256, first.chunks[1].sha256);
    color(await pixel(changed.videoPath, 1.5), 1);
  });
  await test('stale provenance and wrong canvas fail before picture output mutation', async () => {
    const rejected = path.join(episodeDir, 'rejected');
    await assert.rejects(buildPanelProductionPicture({ ...options, workDir: rejected, width: 320 }), /canvas/);
    await assert.rejects(fs.access(rejected), { code: 'ENOENT' });
    const forged = { ...identity }; delete forged.panel_composition_contract; await write(identityPath, forged);
    await assert.rejects(buildPanelProductionPicture({ ...options, workDir: rejected }), /contract is missing/);
    await assert.rejects(fs.access(rejected), { code: 'ENOENT' });
    await write(identityPath, identity);
    await fs.appendFile(artwork, 'changed');
    await assert.rejects(buildPanelProductionPicture({ ...options, workDir: rejected }), /stale source/);
    await assert.rejects(fs.access(rejected), { code: 'ENOENT' });
  });
  await test('production schema keeps a complete long audio timeline and private schemas remain bounded', () => {
    const long = structuredClone(timeline); long.duration_sec = 3600; long.scenes.at(-1).end_sec = 3600; long.scenes.at(-1).layers.at(-1).end_sec = 3600; long.scenes.at(-1).layers.at(-1).keyframes.at(-1).at_sec = 3600;
    validatePanelTimeline(long, 'production_panel_composition');
    assert.throws(() => validatePanelTimeline({ ...long, schema: 'goldflow_panel_experiment_timeline_v1', intent: 'editing_experiment', experiment_identity: timeline.run_identity }, 'editing_experiment'), /duration_sec/);
  });
  await test('the official caption function preserves approved prose rather than ASR text', async () => {
    const { buildSubtitleEventsForTests } = await import('../render.mjs');
    const words = [{ index: 0, word: 'I', start_sec: 0, end_sec: 0.3 }, { index: 1, word: 'paid', start_sec: 0.3, end_sec: 0.6 }, { index: 2, word: 'two', start_sec: 0.6, end_sec: 0.9 }, { index: 3, word: 'dollars.', start_sec: 0.9, end_sec: 1.5 }];
    const before = JSON.stringify(words);
    const result = buildSubtitleEventsForTests({ words }, null, { status: 'passed', beats: [{ source_word_start_index: 0, source_word_end_index: 3, visual_beat_script_excerpt: 'I paid $2.' }] });
    assert.equal(result.source, 'approved_visual_beat_script_text_timed_by_whisper'); assert.equal(result.events.map(row => row.text).join(' '), 'I paid $2.'); assert.equal(JSON.stringify(words), before);
  });
  await test('official render muxes authored panel picture, approved captions and continuous canonical audio', async () => {
    const dataRoot = path.join(root, 'official-data');
    const f = await panelProductionFixture(path.join(dataRoot, 'channels', 'fixture', 'weekly_runs', 'fixture', 'episodes', 'ep_01'));
    const prepared = await preparePanelProductionPlan(f);
    const recipe = JSON.parse(await fs.readFile(prepared.recipe_path, 'utf8'));
    recipe.author = 'Fixture editor';
    recipe.decisions.forEach(row => { row.layout = 'inset'; row.editorial_reason = 'Keep approved fixture illustration readable during the exact narration beat.'; });
    recipe.decisions[1].layout = 'reveal';
    recipe.decisions[1].entry = { direction: 'right', start_sec: 1, duration_sec: .3 };
    recipe.decisions[1].context = { panel_id: recipe.decisions[0].panel_id, rect: { x: .05, y: .05, width: .9, height: .9 }, fit: 'contain', end_sec: 1.5 };
    await writeJson(prepared.recipe_path, recipe); await compilePanelProductionPlan(f);
    const protectedFiles = ['canonical.wav', 'script_clean.md', 'run_identity.json', 'visual_beat_plan.json', 'narration_word_timing_ep_01.json', 'image_a.png', 'image_b.png'];
    const protectedHashes = Object.fromEntries(await Promise.all(protectedFiles.map(async name => [f.p(name), await sha256File(f.p(name))])));
    const renderArgs = [fileURLToPath(new URL('../render.mjs', import.meta.url)), '--channel', 'fixture', '--series', 'panel-fixture', '--week', 'fixture', '--episode', 'ep_01', '--motion', 'panel_composition_v1', '--final-preset', 'ultrafast'];
    const renderOptions = { env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot }, timeout: 180000, maxBuffer: 4 * 1024 * 1024 };
    await assert.rejects(exec(process.execPath, [...renderArgs, '--final-audio-target-lufs', '-13'], renderOptions), /current canonical narration master/);
    await assert.rejects(fs.access(f.p('assets/render-work')), { code: 'ENOENT' });
    await writeJson(f.p('engagement_overlay_plan_ep_01.json'), { status: 'passed', engagement_overlays: [{ start_sec: 1, end_sec: 2, text: 'Unexpected overlay' }] });
    await assert.rejects(exec(process.execPath, renderArgs, renderOptions), /separate engagement overlays/);
    await fs.unlink(f.p('engagement_overlay_plan_ep_01.json'));
    const unrelatedTiming = f.p('unbound-timing.json'); await fs.copyFile(f.p('narration_word_timing_ep_01.json'), unrelatedTiming);
    await assert.rejects(exec(process.execPath, [...renderArgs, '--word-timing', unrelatedTiming], renderOptions), /not bound by its current production plan/);
    await assert.rejects(fs.access(f.p('assets/render-work')), { code: 'ENOENT' });
    await exec(process.execPath, renderArgs, renderOptions);
    const report = JSON.parse(await fs.readFile(f.p('render_report_ep_01.json'), 'utf8'));
    assert.equal(report.status, 'passed'); assert.equal(report.schema, 'goldflow_render_report_v2');
    assert.equal(report.render_profile, 'panel_composition_v1'); assert.equal(report.render_motion.mode, 'panel_composition_v1');
    assert.equal(report.render_motion.fps, 30); assert.equal(report.transition_sfx_event_count, 0);
    assert.equal(report.audio_path, f.p('canonical.wav')); assert.equal(report.render_audio_path, f.p('canonical.wav'));
    assert.equal(report.final_mux_audio_path, f.p('canonical.wav')); assert.equal(report.final_audio_loudnorm.applied, false); assert.equal(report.final_audio_loudnorm.reuse_decision.eligible, true);
    assert.equal(report.subtitle_text_source, 'audio_stitch_caption_text_word_aligned_to_whisper');
    const ass = await fs.readFile(f.p('assets/render-work/subtitles.ass'), 'utf8');
    assert.match(ass, /I paid \$2\./); assert.doesNotMatch(ass, /two dollars/);
    const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', report.output_path])).stdout);
    const video = probe.streams.find(row => row.codec_type === 'video'), audio = probe.streams.find(row => row.codec_type === 'audio');
    assert.equal(video.width, 1920); assert.equal(video.height, 1080); assert.equal(Number(video.nb_read_frames), 90); assert.equal(audio.codec_name, 'aac');
    assert.ok(Math.abs(Number(audio.duration) - 3) < .05);
    const picture = JSON.parse(await fs.readFile(report.panel_composition.picture_report_path, 'utf8'));
    const crop = async file => (await exec('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', file, '-vf', 'crop=1400:240:260:800,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 })).stdout;
    const [captioned, silent] = await Promise.all([crop(report.output_path), crop(picture.output.path)]);
    let changed = 0; for (let i = 0; i < captioned.length; i += 3) if (Math.abs(captioned[i] - silent[i]) + Math.abs(captioned[i + 1] - silent[i + 1]) + Math.abs(captioned[i + 2] - silent[i + 2]) > 100) changed++;
    assert.ok(changed > 1000, 'approved caption must visibly appear in the final video');
    const pcm = async file => (await exec('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ar', '24000', '-ac', '1', '-t', '3', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 })).stdout;
    const [sourcePcm, muxPcm] = await Promise.all([pcm(f.p('canonical.wav')), pcm(report.output_path)]);
    let dot = 0, sourcePower = 0, muxPower = 0;
    const sampleCount = Math.min(sourcePcm.length, muxPcm.length) / 4; assert.ok(sampleCount >= 24000 * 2.99);
    for (let i = 0; i < sampleCount; i++) { const a = sourcePcm.readFloatLE(i * 4), b = muxPcm.readFloatLE(i * 4); dot += a * b; sourcePower += a * a; muxPower += b * b; }
    assert.ok(dot / Math.sqrt(sourcePower * muxPower) > .98, 'continuous mux audio must retain the canonical waveform through scene boundaries');
    for (const [file, hash] of Object.entries(protectedHashes)) assert.equal(await sha256File(file), hash);
    assert.equal(report.source_hashes[f.p('canonical.wav')], f.audioHash);
    await assertPanelProductionPictureCurrent(picture);
  });
} finally { await fs.rm(root, { recursive: true, force: true }); }
console.log(`Production panel picture: ${count} test groups passed.`);
