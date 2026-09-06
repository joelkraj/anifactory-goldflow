import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFootageRangeProxy, isPublicFootageAddress } from '../lib/footage-range-reader.mjs';
import { extractFootageClip, validateFootageClipProbe } from '../lib/footage-extract.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'goldflow-footage-extract-test-'));
let count = 0;
async function test(name, fn) { await fn(); count += 1; process.stdout.write(`ok - ${name}\n`); }
function tool(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (part) => { stderr += part; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Fixture media tool exited ${code}: ${stderr}`)));
  });
}
function toolOutput(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const parts = [];
    child.stdout.on('data', (part) => parts.push(part));
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(parts)) : reject(new Error(`Fixture inspection exited ${code}.`)));
  });
}
const prefix = Buffer.alloc(4096, 0);
prefix.writeUInt32BE(24, 0);
prefix.write('ftypisom', 4);

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(origin); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
function rangedFile(buffer, requests = []) {
  return (req, res) => {
    assert.match(req.headers.range, /^bytes=\d+-\d+$/);
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
    const start = Number(first), end = Math.min(Number(last), buffer.length - 1);
    requests.push({ start, end });
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${buffer.length}`, 'Content-Length': end - start + 1 });
    res.end(buffer.subarray(start, end + 1));
  };
}
async function errorCode(promise, code, secret = 'fixture-secret') {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.ok(!String(error.stack).includes(secret));
    return true;
  });
}

try {
  await test('public IPv4 policy rejects private, reserved, IPv6 and ambiguous addresses', async () => {
    assert.equal(isPublicFootageAddress('8.8.8.8'), true);
    for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.0.1', '192.168.0.1', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', '0177.0.0.1']) assert.equal(isPublicFootageAddress(address), false, address);
  });
  await test('rejects unsafe URL schemes, userinfo and private hosts without a request', async () => {
    for (const url of ['http://8.8.8.8/fixture-secret.mp4', 'file:///fixture-secret.mp4', 'https://fixture-secret@8.8.8.8/a.mp4']) {
      await errorCode(createFootageRangeProxy({ url }), 'FOOTAGE_URL');
    }
    await errorCode(createFootageRangeProxy({ url: 'https://127.0.0.1/fixture-secret.mp4' }), 'FOOTAGE_PRIVATE_HOST');
  });
  await test('rejects playlists before fetching', async () => {
    await errorCode(createFootageRangeProxy({ url: 'https://8.8.8.8/fixture-secret.m3u8' }), 'FOOTAGE_FORMAT');
  });
  await test('range-ignoring response stops at headers without fallback', async () => {
    await withServer((_req, res) => { res.writeHead(200); res.end(prefix); }, async (origin) => {
      await errorCode(createFootageRangeProxy({ url: `${origin}/fixture-secret`, _testAllowedOrigin: origin }), 'FOOTAGE_RANGE_REQUIRED');
    });
  });
  await test('invalid Content-Range and changing provider file size fail closed', async () => {
    await withServer((_req, res) => { res.writeHead(206, { 'Content-Range': 'bytes 1-4096/10000' }); res.end(prefix); }, async (origin) => {
      await errorCode(createFootageRangeProxy({ url: `${origin}/fixture-secret`, _testAllowedOrigin: origin }), 'FOOTAGE_CONTENT_RANGE');
    });
    await withServer(rangedFile(prefix), async (origin) => {
      await errorCode(createFootageRangeProxy({ url: `${origin}/fixture-secret`, bytes: 9000, _testAllowedOrigin: origin }), 'FOOTAGE_CONTENT_RANGE');
    });
  });
  await test('truncated ranges are not accepted', async () => {
    await withServer((_req, res) => {
      res.writeHead(206, { 'Content-Range': 'bytes 0-4095/10000', 'Content-Length': 4096 });
      res.write(prefix.subarray(0, 100));
      res.end();
    }, async (origin) => {
      await errorCode(createFootageRangeProxy({ url: `${origin}/fixture-secret`, _testAllowedOrigin: origin, timeoutMs: 500 }), 'FOOTAGE_TRUNCATED');
    });
  });
  await test('oversized payloads and false content lengths are rejected', async () => {
    await withServer((_req, res) => {
      res.writeHead(206, { 'Content-Range': 'bytes 0-4095/10000' });
      res.end(Buffer.concat([prefix, prefix]));
    }, async (origin) => {
      await errorCode(createFootageRangeProxy({ url: `${origin}/fixture-secret`, _testAllowedOrigin: origin }), 'FOOTAGE_BYTE_LIMIT');
    });
    await withServer((_req, res) => {
      res.writeHead(206, { 'Content-Range': 'bytes 0-4095/10000', 'Content-Length': '9999' });
      res.end(prefix);
    }, async (origin) => {
      await errorCode(createFootageRangeProxy({ url: `${origin}/fixture-secret`, _testAllowedOrigin: origin }), 'FOOTAGE_CONTENT_LENGTH');
    });
  });
  await test('private redirect target is blocked even with the local fixture opt-in', async () => {
    await withServer((_req, res) => { res.writeHead(302, { Location: 'https://169.254.169.254/fixture-secret' }); res.end(); }, async (origin) => {
      await errorCode(createFootageRangeProxy({ url: `${origin}/fixture-secret`, _testAllowedOrigin: origin }), 'FOOTAGE_PRIVATE_HOST');
    });
  });
  await test('redirect loops have a bounded request count', async () => {
    let requests = 0;
    await withServer((_req, res) => { requests += 1; res.writeHead(302, { Location: '/fixture-secret' }); res.end(); }, async (origin) => {
      await errorCode(createFootageRangeProxy({ url: `${origin}/fixture-secret`, _testAllowedOrigin: origin }), 'FOOTAGE_REDIRECT');
    });
    assert.equal(requests, 4);
  });
  await test('silent upstream times out and closes', async () => {
    await withServer(() => {}, async (origin) => {
      const start = Date.now();
      await errorCode(createFootageRangeProxy({ url: `${origin}/fixture-secret`, _testAllowedOrigin: origin, timeoutMs: 60 }), 'FOOTAGE_TIMEOUT');
      assert.ok(Date.now() - start < 1000);
    });
  });
  await test('proxy refuses other token paths and stops concurrent readers at the shared cap', async () => {
    const buffer = Buffer.concat([prefix, prefix, prefix]);
    const requests = [];
    await withServer(rangedFile(buffer, requests), async (origin) => {
      const proxy = await createFootageRangeProxy({ url: `${origin}/fixture-secret`, _testAllowedOrigin: origin,
        maxBytes: 8192, chunkBytes: 4096 });
      try {
        assert.equal((await fetch(new URL('/not-the-token', proxy.url))).status, 404);
        const jobs = [4096, 8192].map(async (start) => {
          try { const response = await fetch(proxy.url, { headers: { Range: `bytes=${start}-${start + 4095}` } }); await response.arrayBuffer(); } catch {}
        });
        await Promise.all(jobs);
        assert.equal(proxy.failure?.code, 'FOOTAGE_BYTE_LIMIT');
        assert.ok(proxy.stats.transferred_bytes <= 8192);
        assert.equal(requests.length, 2);
      } finally { await proxy.close(); }
    });
  });
  await test('request count is capped independently of byte budget', async () => {
    await withServer(rangedFile(Buffer.concat([prefix, prefix])), async (origin) => {
      const proxy = await createFootageRangeProxy({ url: `${origin}/fixture-secret`, _testAllowedOrigin: origin,
        maxRequests: 1, chunkBytes: 4096 });
      try {
        try { const response = await fetch(proxy.url, { headers: { Range: 'bytes=4096-8191' } }); await response.arrayBuffer(); } catch {}
        assert.equal(proxy.failure?.code, 'FOOTAGE_REQUEST_LIMIT');
        assert.equal(proxy.stats.request_count, 1);
      } finally { await proxy.close(); }
    });
  });
  await test('stable strong ETags bind each subsequent range without entering receipts', async () => {
    const buffer = Buffer.concat([prefix, prefix]);
    let requests = 0;
    await withServer((req, res) => {
      assert.equal(req.headers['if-match'], requests === 0 ? undefined : '"fixture-secret-v1"');
      requests += 1;
      res.setHeader('ETag', '"fixture-secret-v1"');
      rangedFile(buffer)(req, res);
    }, async (origin) => {
      const proxy = await createFootageRangeProxy({ url: `${origin}/fixture-secret`, _testAllowedOrigin: origin, chunkBytes: 4096 });
      try {
        const response = await fetch(proxy.url, { headers: { Range: 'bytes=4096-8191' } });
        assert.equal((await response.arrayBuffer()).byteLength, 4096);
        assert.equal(proxy.failure, null);
        assert.equal(proxy.stats.source_version_validation, 'strong_etag');
        assert.match(proxy.stats.source_validator_sha256, /^[a-f0-9]{64}$/);
        assert.ok(!JSON.stringify(proxy.stats).includes('fixture-secret'));
      } finally { await proxy.close(); }
    });
    assert.equal(requests, 2);
  });
  await test('changed, missing and rejected ETags stop same-sized range responses', async () => {
    for (const replacement of ['"fixture-secret-v2"', null, 'precondition_failed']) {
      let requests = 0;
      await withServer((req, res) => {
        requests += 1;
        if (requests === 1) res.setHeader('ETag', '"fixture-secret-v1"');
        else {
          assert.equal(req.headers['if-match'], '"fixture-secret-v1"');
          if (replacement === 'precondition_failed') { res.writeHead(412); res.end(); return; }
          if (replacement) res.setHeader('ETag', replacement);
        }
        rangedFile(Buffer.concat([prefix, prefix]))(req, res);
      }, async (origin) => {
        const proxy = await createFootageRangeProxy({ url: `${origin}/fixture-secret`, _testAllowedOrigin: origin, chunkBytes: 4096 });
        try {
          try { const response = await fetch(proxy.url, { headers: { Range: 'bytes=4096-8191' } }); await response.arrayBuffer(); } catch {}
          assert.equal(proxy.failure?.code, 'FOOTAGE_SOURCE_CHANGED');
          assert.equal(proxy.stats.transferred_bytes, 4096, 'Changed response must stop before consuming its body.');
          assert.ok(!String(proxy.failure?.stack).includes('fixture-secret'));
        } finally { await proxy.close(); }
      });
    }
  });
  await test('Last-Modified fallback is conditional and fails on a changed or missing timestamp', async () => {
    const initial = 'Fri, 04 Sep 2026 10:00:00 GMT';
    for (const replacement of [initial, 'Sat, 05 Sep 2026 10:00:00 GMT', null]) {
      let requests = 0;
      await withServer((req, res) => {
        assert.equal(req.headers['if-unmodified-since'], requests === 0 ? undefined : initial);
        assert.equal(req.headers['if-match'], undefined, 'Weak ETags must not enter If-Match.');
        const modified = requests === 0 ? initial : replacement;
        requests += 1;
        res.setHeader('ETag', 'W/"fixture-secret-weak"');
        if (modified) res.setHeader('Last-Modified', modified);
        rangedFile(Buffer.concat([prefix, prefix]))(req, res);
      }, async (origin) => {
        const proxy = await createFootageRangeProxy({ url: `${origin}/fixture-secret`, _testAllowedOrigin: origin, chunkBytes: 4096 });
        try {
          try { const response = await fetch(proxy.url, { headers: { Range: 'bytes=4096-8191' } }); await response.arrayBuffer(); } catch {}
          assert.equal(proxy.stats.source_version_validation, 'last_modified');
          assert.equal(proxy.failure?.code ?? null, replacement === initial ? null : 'FOOTAGE_SOURCE_CHANGED');
        } finally { await proxy.close(); }
      });
    }
  });
  await test('a source without usable validators explicitly reports unavailable version binding', async () => {
    await withServer((req, res) => {
      res.setHeader('ETag', 'W/"fixture-secret-weak"');
      res.setHeader('Last-Modified', 'not-a-date');
      rangedFile(Buffer.concat([prefix, prefix]))(req, res);
    }, async (origin) => {
      const proxy = await createFootageRangeProxy({ url: `${origin}/fixture-secret`, _testAllowedOrigin: origin });
      try {
        assert.equal(proxy.stats.source_version_validation, 'unavailable');
        assert.equal(proxy.stats.source_validator_sha256, null);
      } finally { await proxy.close(); }
    });
  });
  await test('bad duration and existing outputs are rejected before media access', async () => {
    for (const durationSec of [2.9, 5.1, NaN, Infinity]) await errorCode(extractFootageClip({ source: { local_path: 'missing' }, outputPath: path.join(temporary, 'bad.mp4'), startSec: 0, durationSec }), 'FOOTAGE_TIMING');
  });
  await test('original audio must be selected with a strict boolean before source access', async () => {
    for (const keepAudio of ['true', 'false', 0, 1, null, [], {}]) {
      await errorCode(extractFootageClip({ source: { local_path: 'missing' }, outputPath: path.join(temporary, 'bad-audio-policy.mp4'),
        startSec: 0, keepAudio }), 'FOOTAGE_AUDIO_POLICY');
    }
  });
  await test('probe verification refuses missing, extra, malformed or desynchronized retained audio', async () => {
    const video = { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 320, height: 180,
      duration: '4.000', start_time: '0.000', r_frame_rate: '24/1' };
    const audio = { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', duration: '4.000', start_time: '0.000' };
    const probe = { format: { duration: '4.000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }, streams: [video, audio] };
    assert.equal(validateFootageClipProbe(probe, { durationSec: 4, keepAudio: true }).audio.codec_name, 'aac');
    for (const streams of [undefined, null, {}, [], [video], [video, audio, audio], [video, video, audio], [video, audio, { codec_type: 'subtitle' }]]) {
      assert.throws(() => validateFootageClipProbe({ ...probe, streams }, { durationSec: 4, keepAudio: true }), { code: 'FOOTAGE_PROBE' });
    }
    for (const patch of [{ codec_name: 'mp3' }, { channels: 1 }, { sample_rate: '44100' }, { duration: null },
      { duration: 'N/A' }, { duration: 2 }, { duration: 4.2 }, { start_time: undefined }, { start_time: null }, { start_time: '' },
      { start_time: 0.2 }, { start_time: -0.2 }]) {
      assert.throws(() => validateFootageClipProbe({ ...probe, streams: [video, { ...audio, ...patch }] },
        { durationSec: 4, keepAudio: true }), { code: 'FOOTAGE_AUDIO_PROBE' });
    }
    assert.throws(() => validateFootageClipProbe({ ...probe, streams: [{ ...video, start_time: 0.3 }, audio] },
      { durationSec: 4, keepAudio: true }), { code: 'FOOTAGE_AUDIO_PROBE' });
    assert.throws(() => validateFootageClipProbe(probe, { durationSec: 4 }), { code: 'FOOTAGE_PROBE' }, 'Silent mode rejects an unexpected audio track.');
  });

  const movie = path.join(temporary, 'synthetic-source.mp4');
  await tool('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100',
    '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-crf', '10', '-g', '24', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', movie]);
  const movieBuffer = await readFile(movie);
  await test('local late-scene extraction is H264, silent, four seconds, hash-bound and non-overwriting', async () => {
    const outputPath = path.join(temporary, 'local-clip.mp4');
    const result = await extractFootageClip({ source: { local_path: movie }, outputPath, startSec: 70 });
    assert.equal(result.actual_duration_sec, 4);
    assert.equal(result.audio_policy, 'removed');
    assert.equal(result.width, 320);
    assert.equal(result.codec, 'h264');
    assert.match(result.clip_sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.transferred_bytes, 0);
    await errorCode(extractFootageClip({ source: { local_path: movie }, outputPath, startSec: 70 }), 'FOOTAGE_EXISTS');
  });
  await test('7fps fractional-duration clips stay inside the shared 0.15 second receipt tolerance', async () => {
    const lowFps = path.join(temporary, 'synthetic-7fps.mp4');
    await tool('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=7',
      '-t', '7', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', lowFps]);
    const result = await extractFootageClip({ source: { local_path: lowFps },
      outputPath: path.join(temporary, '7fps-clip.mp4'), startSec: 1, durationSec: 3.01 });
    const rounding = Math.abs(result.actual_duration_sec - result.requested_duration_sec);
    assert.ok(rounding > 0.12 && rounding <= 0.15, `Expected regression boundary, got ${rounding}.`);
    assert.equal(result.frame_rate, '7/1');
  });
  await test('retained audio selects only the first source track and converts it to AAC stereo 48kHz', async () => {
    const result = await extractFootageClip({ source: { local_path: movie }, outputPath: path.join(temporary, 'local-audio-clip.mp4'),
      startSec: 70, durationSec: 4, keepAudio: true });
    assert.equal(result.actual_duration_sec, 4);
    assert.equal(result.audio_policy, 'retained_aac_stereo');
    assert.equal(result.audio_codec, 'aac');
    assert.equal(result.audio_channels, 2);
    assert.equal(result.audio_sample_rate, 48000);
    assert.equal(result.source_audio_stream_index, 0);
    assert.ok(Math.abs(result.audio_start_sec) <= 0.15);
    assert.ok(Math.abs(result.audio_duration_sec - 4) <= 0.15);
    // First source audio is 440 Hz; the unselected second track is 880 Hz.
    const pcm = await toolOutput('ffmpeg', ['-v', 'error', '-nostdin', '-i', result.output_path,
      '-ss', '1', '-t', '1', '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '48000', '-']);
    let upwardCrossings = 0;
    let peak = 0;
    for (let offset = 2; offset < pcm.length; offset += 2) {
      const previous = pcm.readInt16LE(offset - 2), sample = pcm.readInt16LE(offset);
      if (previous <= 0 && sample > 0) upwardCrossings += 1;
      peak = Math.max(peak, Math.abs(sample));
    }
    assert.ok(peak > 100, 'The retained track must contain actual non-silent samples.');
    assert.ok(Math.abs(upwardCrossings - 440) < 5, `Expected first-track 440 Hz, got ${upwardCrossings}.`);
  });
  await test('requesting original audio from a silent source fails without publishing an output', async () => {
    const outputPath = path.join(temporary, 'missing-audio.mp4');
    await errorCode(extractFootageClip({ source: { local_path: path.join(temporary, 'synthetic-7fps.mp4') }, outputPath,
      startSec: 1, keepAudio: true }), 'FOOTAGE_TOOL');
    await assert.rejects(stat(outputPath), { code: 'ENOENT' });
    assert.ok(!(await readdir(temporary)).some((name) => name.startsWith('.footage-extract-')));
  });
  await test('retained audio preserves a real source offset instead of independently resetting its timestamps', async () => {
    const delayed = path.join(temporary, 'delayed-audio-source.mp4');
    await tool('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-i', movie, '-itsoffset', '0.1', '-i', movie,
      '-map', '0:v:0', '-map', '1:a:0', '-t', '7', '-c', 'copy', '-movflags', '+faststart', delayed]);
    const result = await extractFootageClip({ source: { local_path: delayed }, outputPath: path.join(temporary, 'delayed-audio-clip.mp4'),
      startSec: 0, durationSec: 4, keepAudio: true });
    assert.ok(result.audio_start_sec > 0.03 && result.audio_start_sec <= 0.15,
      `A preserved source audio offset must remain visible; got ${result.audio_start_sec}.`);
    assert.ok(Math.abs(result.audio_start_sec + result.audio_duration_sec - result.actual_duration_sec) <= 0.15);
  });
  await test('native MKV input is supported with no audio or attachment extraction', async () => {
    const mkv = path.join(temporary, 'synthetic-source.mkv');
    await tool('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-i', movie, '-c', 'copy', mkv]);
    const result = await extractFootageClip({ source: { local_path: mkv }, outputPath: path.join(temporary, 'mkv-clip.mp4'), startSec: 70 });
    assert.ok(Math.abs(result.actual_duration_sec - 4) <= 1 / 24 + 0.001);
    assert.equal(result.audio_policy, 'removed');
    const bytes = await readFile(mkv);
    await withServer(rangedFile(bytes), async (origin) => {
      const remote = await extractFootageClip({ source: { url: `${origin}/fixture-secret.mkv` },
        outputPath: path.join(temporary, 'remote-mkv-clip.mp4'), startSec: 70, _testAllowedOrigin: origin, _testChunkBytes: 128 * 1024 });
      assert.ok(Math.abs(remote.actual_duration_sec - 4) <= 1 / 24 + 0.001);
      assert.ok(remote.transferred_bytes < bytes.length);
    });
  });
  await test('late remote clip transfers bounded closed ranges and less than the full movie', async () => {
    const requests = [];
    await withServer(rangedFile(movieBuffer, requests), async (origin) => {
      const result = await extractFootageClip({ source: { url: `${origin}/fixture-secret.mp4`, bytes: movieBuffer.length },
        outputPath: path.join(temporary, 'remote-clip.mp4'), startSec: 70, durationSec: 4,
        _testAllowedOrigin: origin, _testChunkBytes: 128 * 1024, maxBytes: movieBuffer.length - 1 });
      assert.equal(result.actual_duration_sec, 4);
      assert.equal(result.range_supported, true);
      assert.ok(result.transferred_bytes < movieBuffer.length / 2, `${result.transferred_bytes} versus full ${movieBuffer.length}`);
      assert.equal(result.transferred_bytes, requests.reduce((sum, range) => sum + range.end - range.start + 1, 0));
      assert.ok(requests.some(({ start }) => start > movieBuffer.length / 2));
      assert.ok(requests.every(({ start, end }) => end - start + 1 <= 128 * 1024));
      assert.ok(!JSON.stringify(result).includes('fixture-secret'));
      assert.deepEqual(await readFile(result.output_path), await readFile(path.join(temporary, 'local-clip.mp4')),
        'Remote seeking must extract the exact same scene frames as local seeking.');
      process.stdout.write(`  partial-transfer proof: ${result.transferred_bytes}/${movieBuffer.length} bytes, ${result.request_count} requests\n`);
    });
  });
  await test('bounded remote seeking retains the exact same audio/video clip as local extraction', async () => {
    const requests = [];
    await withServer(rangedFile(movieBuffer, requests), async (origin) => {
      const result = await extractFootageClip({ source: { url: `${origin}/fixture-secret.mp4`, bytes: movieBuffer.length },
        outputPath: path.join(temporary, 'remote-audio-clip.mp4'), startSec: 70, durationSec: 4, keepAudio: true,
        _testAllowedOrigin: origin, _testChunkBytes: 128 * 1024, maxBytes: movieBuffer.length - 1 });
      assert.equal(result.audio_policy, 'retained_aac_stereo');
      assert.equal(result.audio_sample_rate, 48000);
      assert.equal(result.audio_channels, 2);
      assert.ok(result.transferred_bytes < movieBuffer.length / 2);
      assert.ok(requests.some(({ start }) => start > movieBuffer.length / 2));
      assert.equal(result.transferred_bytes, requests.reduce((sum, range) => sum + range.end - range.start + 1, 0));
      assert.deepEqual(await readFile(result.output_path), await readFile(path.join(temporary, 'local-audio-clip.mp4')));
      assert.ok(!JSON.stringify(result).includes('fixture-secret'));
    });
  });
  await test('a small byte cap fails without publishing a partial output', async () => {
    const outputPath = path.join(temporary, 'capped-clip.mp4');
    const requests = [];
    await withServer(rangedFile(movieBuffer, requests), async (origin) => {
      await errorCode(extractFootageClip({ source: { url: `${origin}/fixture-secret.mp4` }, outputPath, startSec: 70,
        _testAllowedOrigin: origin, _testChunkBytes: 65536, maxBytes: 4096 }), 'FOOTAGE_BYTE_LIMIT');
    });
    assert.equal(requests.length, 1);
    await assert.rejects(stat(outputPath), { code: 'ENOENT' });
  });
  await test('clips extending beyond the source fail verification and clean up their owned temporary files', async () => {
    const outputPath = path.join(temporary, 'short-clip.mp4');
    await errorCode(extractFootageClip({ source: { local_path: movie }, outputPath, startSec: 89 }), 'FOOTAGE_PROBE');
    await assert.rejects(stat(outputPath), { code: 'ENOENT' });
    assert.ok(!(await readdir(temporary)).some((name) => name.startsWith('.footage-extract-')));
  });
  process.stdout.write(`footage extraction suite passed (${count} tests)\n`);
} finally {
  // Only this test-created, uniquely named scratch directory is removed.
  await rm(temporary, { recursive: true, force: true });
}
