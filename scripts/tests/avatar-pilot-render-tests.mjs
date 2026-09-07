import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { renderAvatarPilot, validatePilotTimeline } from '../lib/avatar-pilot-render.mjs';

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const FRAMES = 2700;
const BACKGROUND = [32, 64, 96];

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function clone(value) { return structuredClone(value); }

function fixtureAssets(directory = '/tmp/goldflow-avatar-pilot-synthetic') {
  return {
    movie: { path: path.join(directory, 'movie.mp4'), sha256: sha256('movie'), kind: 'movie_clip', duration_sec: 5 },
    host: { path: path.join(directory, 'host.png'), sha256: sha256('host'), kind: 'host_pose' },
    voice: { path: path.join(directory, 'voice.wav'), sha256: sha256('voice'), kind: 'narration', duration_sec: 2.01 },
  };
}

function hostLayer() { return { asset_id: 'host', x: 100, y: 100, width: 200, height: 200, z: 2 }; }
function movieLayer() {
  return {
    asset_id: 'movie', x: 600, y: 200, width: 640, height: 360, z: 1, source_in_sec: 1,
    motion: { from_x: 500, from_y: 200, to_x: 600, to_y: 200, entrance_frames: 30 },
  };
}

function fixtureTimeline() {
  return {
    schema: 'goldflow_avatar_pilot_timeline_v1', width: WIDTH, height: HEIGHT, fps: FPS, duration_frames: FRAMES,
    shots: [
      { id: 'evidence_open', start_frame: 0, end_frame: 120, background_color: '#204060', truth_mode: 'evidence', truth_label: 'Synthetic evidence', layers: [movieLayer(), hostLayer()] },
      { id: 'host_middle', start_frame: 120, end_frame: 1800, background_color: '#204060', truth_mode: 'host', layers: [hostLayer()] },
      { id: 'evidence_reuse', start_frame: 1800, end_frame: 1920, background_color: '#204060', truth_mode: 'evidence', truth_label: 'Synthetic evidence', layers: [movieLayer(), hostLayer()] },
      { id: 'evidence_loop', start_frame: 1920, end_frame: 2160, background_color: '#204060', truth_mode: 'evidence', truth_label: 'Synthetic evidence — deliberate repeat', layers: [{ ...movieLayer(), loop: true, source_duration_sec: 4 }, hostLayer()] },
      { id: 'host_ending', start_frame: 2160, end_frame: FRAMES, background_color: '#204060', truth_mode: 'host', layers: [hostLayer()] },
    ],
    narration: [{ asset_id: 'voice', start_frame: 300, source_in_sec: 0, duration_frames: 61, gain_db: 0 }],
    source_audio: [{ shot_id: 'evidence_open', asset_id: 'movie', start_frame: 0, source_in_sec: 1, duration_frames: 120, gain_db: -6, mode: 'spotlight' }],
    captions: [{ start_frame: 360, end_frame: 420, text: 'Synthetic caption at output 12–14 seconds' }],
  };
}

function runTool(executable, args, { timeoutMs = 600000, maxOutputBytes = 24 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let total = 0;
    let stderr = '';
    let failure = null;
    const timer = setTimeout(() => {
      failure = new Error(`Synthetic fixture command timed out: ${executable}`);
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxOutputBytes) {
        failure = new Error('Synthetic fixture command exceeded bounded output.');
        child.kill('SIGKILL');
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-65536); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Synthetic fixture command exited ${code}: ${stderr}`));
      else resolve({ stdout: Buffer.concat(chunks), stderr });
    });
  });
}

async function createSyntheticAssets(directory) {
  const assets = fixtureAssets(directory);
  const hostMark = await sharp({ create: { width: 40, height: 40, channels: 4, background: '#ffff00' } }).png().toBuffer();
  await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: hostMark, left: 30, top: 30 }]).png().toFile(assets.host.path);
  await runTool('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-filter_threads', '1',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5',
    '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=green:t=fill:enable='lt(t,1)',drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,2)'",
    '-af', "volume=0:enable='lt(t,1)'",
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-threads', '1', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-t', '5', '-movflags', '+faststart', assets.movie.path,
  ]);
  await runTool('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=2.01',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1', assets.voice.path,
  ]);
  for (const asset of Object.values(assets)) asset.sha256 = sha256(await readFile(asset.path));
  return assets;
}

async function sampleFrame(videoPath, seconds) {
  const { stdout } = await runTool('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-ss', String(seconds), '-i', videoPath,
    '-frames:v', '1', '-an', '-f', 'image2pipe', '-c:v', 'png', '-threads', '1', 'pipe:1',
  ]);
  const decoded = await sharp(stdout).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { ...decoded, png: stdout };
}

function pixel(frame, x, y) {
  const offset = (y * frame.info.width + x) * frame.info.channels;
  return [...frame.data.subarray(offset, offset + 3)];
}

function assertColor(actual, expected, message, tolerance = 12) {
  assert.ok(actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance), `${message}: ${actual} != ${expected}`);
}

function audioWindowStats(pcm, fromSec, toSec, sampleRate = 48000) {
  const first = Math.ceil(fromSec * sampleRate);
  const last = Math.min(Math.floor(toSec * sampleRate), pcm.length / 4);
  assert.ok(last > first, 'Requested audio inspection window must exist.');
  let peak = 0;
  let squares = 0;
  for (let index = first; index < last; index += 1) {
    const value = pcm.readFloatLE(index * 4);
    assert.ok(Number.isFinite(value), 'Decoded audio cannot contain NaN or infinity.');
    peak = Math.max(peak, Math.abs(value));
    squares += value * value;
  }
  return { peak, rms: Math.sqrt(squares / (last - first)) };
}

async function assertNoOutput(outputPath) {
  await assert.rejects(access(outputPath), (error) => error.code === 'ENOENT');
}

export async function runAvatarPilotRenderTests() {
  let count = 0;
  async function test(name, fn) { await fn(); count += 1; process.stdout.write(`ok - avatar pilot: ${name}\n`); }
  const valid = (timeline = fixtureTimeline(), assets = fixtureAssets()) => validatePilotTimeline(timeline, { assets });
  const rejects = (change, pattern) => {
    const timeline = fixtureTimeline();
    const assets = fixtureAssets();
    change(timeline, assets);
    assert.throws(() => valid(timeline, assets), pattern);
  };

  await test('valid timeline preserves independent source/output clocks and deliberate asset reuse', () => {
    const timeline = fixtureTimeline();
    const before = clone(timeline);
    assert.deepEqual(valid(timeline), []);
    assert.deepEqual(timeline, before, 'Validation must not rewrite the reviewed edit.');
    assert.equal(timeline.shots[2].start_frame / FPS, 60);
    assert.equal(timeline.shots[2].layers[0].source_in_sec, 1);
  });
  await test('fixed proof geometry, rate, duration and schema cannot drift', () => {
    for (const [field, value] of [['width', 1280], ['height', 720], ['fps', 24], ['duration_frames', 2699], ['schema', 'unregistered_timeline']]) {
      rejects((timeline) => { timeline[field] = value; }, /schema|1920|1080|30|2700|90|geometry|frame|duration|fps/i);
    }
  });
  await test('shot coverage rejects gaps, overlap, fractional frames and incomplete ending', () => {
    rejects((timeline) => { timeline.shots[0].start_frame = 1; }, /start|coverage|contiguous|frame/i);
    rejects((timeline) => { timeline.shots[1].start_frame += 1; }, /gap|coverage|contiguous|frame/i);
    rejects((timeline) => { timeline.shots[1].start_frame -= 1; }, /overlap|coverage|contiguous|frame/i);
    rejects((timeline) => { timeline.shots[1].end_frame = 1800.5; }, /integer|frame/i);
    rejects((timeline) => { timeline.shots.at(-1).end_frame -= 1; }, /coverage|2700|90|end|frame/i);
    rejects((timeline) => { timeline.shots[1].id = timeline.shots[0].id; }, /duplicate|unique|id/i);
  });
  await test('asset metadata rejects missing hashes, remote paths and unknown asset IDs', () => {
    rejects((_timeline, assets) => { delete assets.host.sha256; }, /hash|sha.?256/i);
    rejects((_timeline, assets) => { assets.host.sha256 = 'not-a-hash'; }, /hash|sha.?256/i);
    rejects((_timeline, assets) => { assets.movie.path = 'https://example.invalid/film.mp4'; }, /local|absolute|path|protocol/i);
    rejects((_timeline, assets) => { assets.movie.path = 'relative.mp4'; }, /local|absolute|path/i);
    rejects((timeline) => { timeline.shots[0].layers[0].asset_id = 'missing'; }, /missing|unknown|asset/i);
  });
  await test('layer geometry and motion must be finite, positive and bounded by the shot', () => {
    for (const invalid of [NaN, Infinity, -Infinity]) rejects((timeline) => { timeline.shots[0].layers[0].x = invalid; }, /finite|number|geometry|position|x/i);
    rejects((timeline) => { timeline.shots[0].layers[0].width = 0; }, /positive|width|geometry/i);
    rejects((timeline) => { timeline.shots[0].layers[0].motion.to_y = NaN; }, /finite|number|motion|to_y/i);
    rejects((timeline) => { timeline.shots[0].layers[0].motion.entrance_frames = 121; }, /entrance|motion|duration|frame/i);
    rejects((timeline) => { timeline.shots[0].layers[0].asset_id = 'voice'; }, /kind|narration|visual|layer|role/i);
  });
  await test('movie playback stays within reviewed 3–5 second source scope without padding', () => {
    rejects((timeline) => { timeline.shots[0].end_frame = 89; timeline.shots[1].start_frame = 89; }, /3|5|scope|duration|movie/i);
    rejects((timeline) => { timeline.shots[0].end_frame = 151; timeline.shots[1].start_frame = 151; }, /3|5|scope|duration|movie|source/i);
    rejects((timeline) => { timeline.shots[0].layers[0].source_in_sec = -1; }, /source|negative|non.negative|offset/i);
    rejects((timeline) => { timeline.shots[0].layers[0].source_in_sec = 2; }, /source|duration|window|exceed|short|coverage/i);
    rejects((_timeline, assets) => { assets.movie.duration_sec = 5.5; }, /3|5|scope|duration|movie/i);
  });
  await test('only an explicit bounded movie loop may repeat the reviewed 3–5 second excerpt', () => {
    assert.deepEqual(valid(), []);
    rejects((timeline) => { delete timeline.shots[3].layers[0].loop; }, /3|5|loop|duration|movie/i);
    rejects((timeline) => { timeline.shots[3].layers[0].loop = 'true'; }, /loop|boolean/i);
    rejects((timeline) => { timeline.shots[3].layers[0].source_duration_sec = 2; }, /3|5|source|duration|loop/i);
    rejects((timeline) => { timeline.shots[3].layers[0].source_duration_sec = 5.1; }, /3|5|source|duration|loop/i);
    rejects((timeline) => { timeline.shots[3].end_frame = 2190; timeline.shots[4].start_frame = 2190; }, /loop|twice|repeat|duration|source|2/i);
    rejects((timeline) => { timeline.shots[3].end_frame = 2250; timeline.shots[4].start_frame = 2250; }, /loop|10|duration/i);
    rejects((timeline) => {
      timeline.source_audio.push({ shot_id: 'evidence_loop', asset_id: 'movie', start_frame: 1920, source_in_sec: 1, duration_frames: 120, gain_db: -6, mode: 'spotlight' });
    }, /loop|repeat|audio/i);
  });
  await test('source audio requires an explicit mode and exact visible-asset clock mapping', () => {
    rejects((timeline) => { delete timeline.source_audio[0].mode; }, /mode|audio|spotlight|under_narration/i);
    rejects((timeline) => { timeline.source_audio[0].mode = 'automatic'; }, /mode|audio|spotlight|under_narration/i);
    rejects((timeline) => { timeline.source_audio[0].shot_id = 'host_middle'; }, /shot|visible|source|audio/i);
    rejects((timeline) => { timeline.source_audio[0].asset_id = 'voice'; }, /movie|source|visible|audio|asset|role/i);
    rejects((timeline) => { timeline.source_audio[0].source_in_sec = 1.1; }, /mapping|clock|source|offset|audio/i);
    rejects((timeline) => { timeline.source_audio[0].duration_frames = 121; }, /shot|window|duration|source|audio/i);
    rejects((timeline) => { timeline.source_audio[0].gain_db = NaN; }, /finite|gain|number|audio/i);
  });
  await test('spotlight refuses narration overlap; quiet-under-narration is deliberate', () => {
    rejects((timeline) => { timeline.narration[0].start_frame = 60; }, /spotlight|overlap|narration/i);
    const timeline = fixtureTimeline();
    timeline.source_audio[0].mode = 'under_narration';
    timeline.source_audio[0].gain_db = -24;
    timeline.narration[0].start_frame = 60;
    assert.deepEqual(valid(timeline), []);
  });
  await test('narration and captions stay inside the proof, with visible hypothetical labeling', () => {
    rejects((timeline) => { timeline.narration[0].start_frame = 2690; }, /duration|frame|90|2700|bounds|window|end/i);
    rejects((timeline) => { timeline.narration[0].asset_id = 'movie'; }, /narration|kind|audio|role/i);
    rejects((timeline) => { timeline.captions = [{ start_frame: 2690, end_frame: 2710, text: 'Synthetic caption' }]; }, /caption|frame|bounds|2700|90|end/i);
    rejects((timeline) => { timeline.shots[1].truth_mode = 'hypothesis'; timeline.shots[1].truth_label = ''; }, /label|hypothesis|truth/i);
    const withoutCaptions = fixtureTimeline();
    withoutCaptions.captions = [];
    assert.deepEqual(valid(withoutCaptions), []);
  });

  const directory = await mkdtemp(path.join(os.tmpdir(), 'goldflow-avatar-pilot-render-test-'));
  const keepFixture = process.env.KEEP_AVATAR_PILOT_FIXTURE === '1';
  let previewPath = null;
  let renderReportPath = null;
  try {
    const assets = await createSyntheticAssets(directory);
    const voiceHash = assets.voice.sha256;
    await test('stale accepted asset bytes stop before an output exists', async () => {
      const stale = clone(assets);
      stale.movie.sha256 = '0'.repeat(64);
      const outputPath = path.join(directory, 'stale-must-not-render.mp4');
      await assert.rejects(renderAvatarPilot({ timeline: fixtureTimeline(), assets: stale, outputPath, workDir: path.join(directory, 'stale-work') }), /hash|sha.?256|stale/i);
      await assertNoOutput(outputPath);
    });
    await test('actual probed duration cannot be replaced by manifest metadata', async () => {
      const mismatch = clone(assets);
      mismatch.voice.duration_sec = 3;
      const outputPath = path.join(directory, 'mismatch-must-not-render.mp4');
      await assert.rejects(renderAvatarPilot({ timeline: fixtureTimeline(), assets: mismatch, outputPath, workDir: path.join(directory, 'mismatch-work') }), /duration|probe|metadata|mismatch/i);
      await assertNoOutput(outputPath);
    });
    await test('final narration may round to its ceil frame but cannot reserve another unsounded frame', async () => {
      const timeline = fixtureTimeline();
      timeline.narration[0].duration_frames = 62;
      const outputPath = path.join(directory, 'oversized-narration-tail-must-not-render.mp4');
      const workDir = path.join(directory, 'oversized-narration-tail-work');
      await assert.rejects(renderAvatarPilot({ timeline, assets, outputPath, workDir }), /audio|narration|bounds|frame|source/i);
      await assertNoOutput(outputPath);
      await assertNoOutput(workDir);
    });
    await test('an opaque image cannot masquerade as an approved transparent host pose', async () => {
      const opaque = clone(assets);
      opaque.host.path = path.join(directory, 'opaque-host.png');
      await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffff00' } }).png().toFile(opaque.host.path);
      opaque.host.sha256 = sha256(await readFile(opaque.host.path));
      const outputPath = path.join(directory, 'opaque-must-not-render.mp4');
      await assert.rejects(renderAvatarPilot({ timeline: fixtureTimeline(), assets: opaque, outputPath, workDir: path.join(directory, 'opaque-work') }), /alpha|host|transparent/i);
      await assertNoOutput(outputPath);
    });
    await test('explicit source audio fails before render when the native movie has no audio stream', async () => {
      const silent = clone(assets);
      silent.movie.path = path.join(directory, 'silent-movie.mp4');
      await runTool('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', assets.movie.path,
        '-map', '0:v:0', '-c:v', 'copy', '-an', silent.movie.path,
      ]);
      silent.movie.sha256 = sha256(await readFile(silent.movie.path));
      const outputPath = path.join(directory, 'missing-audio-must-not-render.mp4');
      const workDir = path.join(directory, 'missing-audio-work');
      await assert.rejects(renderAvatarPilot({ timeline: fixtureTimeline(), assets: silent, outputPath, workDir }), /audio.*missing|missing.*audio/i);
      await assertNoOutput(outputPath);
      await assertNoOutput(workDir);
    });
    await test('symlinked assets fail before media work even when their target hash matches', async () => {
      const linked = clone(assets);
      linked.movie.path = path.join(directory, 'linked-movie.mp4');
      await symlink(assets.movie.path, linked.movie.path);
      const outputPath = path.join(directory, 'symlink-must-not-render.mp4');
      const workDir = path.join(directory, 'symlink-work');
      await assert.rejects(renderAvatarPilot({ timeline: fixtureTimeline(), assets: linked, outputPath, workDir }), /regular file|symlink/i);
      await assertNoOutput(outputPath);
      await assertNoOutput(workDir);
    });
    await test('a playlist disguised as an MP4 cannot delegate reads to a nested media file', async () => {
      const playlist = clone(assets);
      playlist.movie.path = path.join(directory, 'playlist-movie.mp4');
      await writeFile(playlist.movie.path, "ffconcat version 1.0\nfile 'movie.mp4'\n", { flag: 'wx' });
      playlist.movie.sha256 = sha256(await readFile(playlist.movie.path));
      const outputPath = path.join(directory, 'playlist-must-not-render.mp4');
      const workDir = path.join(directory, 'playlist-work');
      await assert.rejects(renderAvatarPilot({ timeline: fixtureTimeline(), assets: playlist, outputPath, workDir,
        ffmpegPath: '/nonexistent/goldflow-synthetic-must-not-render' }), /whitelist|format|concat|invalid data/i);
      await assertNoOutput(outputPath);
      await assertNoOutput(workDir);
    });
    let render;
    const outputPath = path.join(directory, 'synthetic-90s.mp4');
    await test('one synthetic 90-second render returns hash-bound video and measured audio evidence', async () => {
      render = await renderAvatarPilot({ timeline: fixtureTimeline(), assets, outputPath, workDir: path.join(directory, 'render-work'), timeoutMs: 600000 });
      assert.equal(render.output_path, outputPath);
      assert.equal(render.sha256, sha256(await readFile(outputPath)));
      assert.equal(render.duration_frames, FRAMES);
      assert.ok(Math.abs(render.duration_sec - 90) <= 1 / FPS);
      assert.ok(render.probe && typeof render.probe === 'object');
      assert.ok(render.audio_stats && typeof render.audio_stats === 'object');
      const audio = render.audio_stats;
      assert.equal(audio.schema, 'goldflow_avatar_pilot_final_audio_measurement_v1');
      assert.equal(audio.measurement, 'ffmpeg_astats_ebur128_final_aac_90_second_window_v1');
      assert.equal(audio.duration_sec, 90);
      assert.equal(audio.sample_rate, 48000);
      assert.equal(audio.measured_samples_per_channel, 4320000);
      assert.equal(audio.measured_samples_per_channel, audio.duration_sec * audio.sample_rate);
      assert.equal(audio.normalization_applied, false, 'Measurement must not silently normalize the approved mix.');
      assert.equal(audio.render_sha256, render.sha256);
      for (const field of ['peak_dbfs', 'rms_dbfs', 'integrated_lufs', 'loudness_range_lu', 'true_peak_dbfs']) {
        assert.ok(Number.isFinite(audio[field]), `Synthetic tone program requires a finite measured ${field}.`);
      }
      assert.ok(audio.true_peak_dbfs < 0, 'True-peak measurement must not report clipping.');
      const reportPayload = { ...audio };
      delete reportPayload.report_sha256;
      assert.equal(audio.report_sha256, sha256(JSON.stringify(reportPayload)), 'Audio measurement must hash-bind its exact report and rendered bytes.');
      assert.equal(render.narration_tail_rounding.length, 1);
      const tail = render.narration_tail_rounding[0];
      assert.equal(tail.asset_id, 'voice');
      assert.equal(tail.start_frame, 300);
      assert.equal(tail.duration_frames, 61);
      assert.equal(tail.source_in_sec, 0);
      assert.ok(Math.abs(tail.actual_source_duration_sec - 2.01) < 0.000001);
      assert.ok(Math.abs(tail.unsounded_frame_tail_sec - (61 / FPS - 2.01)) < 0.000001);
      assert.equal(tail.treatment, 'natural_audio_end_inside_final_ceil_frame_no_padding_or_stretch');
      assert.equal(sha256(await readFile(assets.voice.path)), voiceHash, 'Canonical narration must remain byte-identical.');
      renderReportPath = path.join(directory, 'synthetic-render-report.json');
      await writeFile(renderReportPath, `${JSON.stringify(render, null, 2)}\n`, { flag: 'wx' });
    });
    await test('actual output contains exactly 2,700 full-HD frames and one final AAC stream', async () => {
      const { stdout } = await runTool('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', outputPath]);
      const probe = JSON.parse(stdout.toString());
      const video = probe.streams.filter((stream) => stream.codec_type === 'video');
      const audio = probe.streams.filter((stream) => stream.codec_type === 'audio');
      assert.equal(video.length, 1);
      assert.equal(video[0].width, WIDTH);
      assert.equal(video[0].height, HEIGHT);
      assert.equal(video[0].r_frame_rate, '30/1');
      assert.equal(Number(video[0].nb_read_frames), FRAMES);
      assert.ok(Math.abs(Number(video[0].duration) - 90) <= 1 / FPS);
      assert.ok(Math.abs(Number(probe.format.duration) - 90) <= 1 / FPS);
      assert.equal(audio.length, 1);
      assert.equal(audio[0].codec_name, 'aac');
    });
    await test('alpha host, moving evidence card, source-clock progression and late reuse are visible', async () => {
      for (const seconds of [0.5, 2.5, 4.5, 30, 60.5, 62.5, 64.5, 66.5, 68.5, 70.5, 89.5]) {
        const frame = await sampleFrame(outputPath, seconds);
        if (seconds === 0.5) {
          previewPath = path.join(directory, 'synthetic-preview.png');
          await writeFile(previewPath, frame.png, { flag: 'wx' });
        }
        assert.equal(frame.info.width, WIDTH);
        assert.equal(frame.info.height, HEIGHT);
        assertColor(pixel(frame, 1800, 800), BACKGROUND, `Background at output ${seconds}s`);
        assertColor(pixel(frame, 110, 125), BACKGROUND, `Transparent host corner at output ${seconds}s`);
        assertColor(pixel(frame, 200, 200), [255, 255, 0], `Opaque host center at output ${seconds}s`);
        if ([0.5, 60.5, 64.5, 68.5].includes(seconds)) assertColor(pixel(frame, 900, 400), [255, 0, 0], `Clip-local 1.5s must be red at output ${seconds}s`);
        else if ([2.5, 62.5, 66.5, 70.5].includes(seconds)) assertColor(pixel(frame, 900, 400), [0, 0, 255], `Playing clip-local 3.5s must be blue at output ${seconds}s`);
        else assertColor(pixel(frame, 900, 400), BACKGROUND, `Evidence card must be absent at output ${seconds}s`);
        if ([0.5, 60.5, 64.5].includes(seconds)) assertColor(pixel(frame, 580, 400), [255, 0, 0], `Card entrance is still moving at output ${seconds}s`);
        if ([2.5, 62.5, 66.5].includes(seconds)) assertColor(pixel(frame, 580, 400), BACKGROUND, `Card has settled rightward at output ${seconds}s`);
      }
    });
    await test('caption raster appears only inside its output-clock interval', async () => {
      for (const seconds of [11.5, 12.5, 14.5]) {
        const frame = await sampleFrame(outputPath, seconds);
        const expected = seconds === 12.5 ? [8, 15, 23] : BACKGROUND;
        assertColor(pixel(frame, 100, 990), expected, `Caption box at output ${seconds}s`);
      }
    });
    await test('complete synthetic program has no unexpected black-frame gaps', async () => {
      const { stderr } = await runTool('ffmpeg', [
        '-hide_banner', '-nostdin', '-threads', '1', '-i', outputPath,
        '-vf', 'blackdetect=d=0.001:pix_th=0.02:pic_th=0.95', '-an', '-f', 'null', '-',
      ]);
      assert.doesNotMatch(stderr, /black_start:/);
    });
    await test('source spotlight, narration placement, mute-by-absence and unclipped audio are audible in exact windows', async () => {
      const { stdout: pcm } = await runTool('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-i', outputPath,
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1',
      ]);
      assert.ok(pcm.length / 4 / 48000 >= 90 - 1 / FPS);
      assert.ok(audioWindowStats(pcm, 0.2, 0.8).rms > 0.005, 'Source local offset 1s skips the deliberately silent first source second.');
      assert.ok(audioWindowStats(pcm, 1, 3.75).rms > 0.005, 'Explicit source spotlight is retained.');
      assert.ok(audioWindowStats(pcm, 10.2, 11.8).rms > 0.005, 'Narration is placed at its output-clock interval.');
      assert.ok(audioWindowStats(pcm, 12.002, 12.008).rms > 0.005, 'The fractional final narration frame must retain the natural audio tail.');
      for (const [start, end] of [[4.25, 9.5], [12.25, 13], [60.25, 63.75], [64.25, 71.75], [89, 89.75]]) {
        assert.ok(audioWindowStats(pcm, start, end).rms < 0.0005, `Unassigned audio window ${start}–${end}s must remain silent.`);
      }
      const whole = audioWindowStats(pcm, 0, 90);
      assert.ok(whole.peak < 0.999, `Decoded program must not clip (peak ${whole.peak}).`);
      assert.ok(whole.rms > 0.001, 'Final output must not accidentally be silent.');
    });
  } finally {
    if (keepFixture) process.stdout.write(`Retained owned synthetic avatar fixture: ${directory}\n`);
    else await rm(directory, { recursive: true, force: true });
  }
  process.stdout.write(`Avatar pilot renderer: ${count} test groups passed.\n`);
  return { passed: count, fixture_dir: keepFixture ? directory : null, preview_path: keepFixture ? previewPath : null,
    render_report_path: keepFixture ? renderReportPath : null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runAvatarPilotRenderTests();
}
