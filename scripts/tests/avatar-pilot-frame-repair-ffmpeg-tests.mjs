import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// A two-second synthetic fixture, not an episode render or media approval.
const exec = promisify(execFile);
const env = { PATH: process.env.PATH, LANG: 'C' };
const run = (args) => exec('ffmpeg', args, { env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'goldflow-frame-patch-fixture-')));
try {
  const base = path.join(dir, 'base.mp4'), patched = path.join(dir, 'patched.mp4');
  await run(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=900:sample_rate=48000:duration=2',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', base]);
  await run(['-v', 'error', '-i', base, '-f', 'lavfi', '-i', 'color=c=red:s=96x64:r=30:d=0.4,format=rgba',
    '-filter_complex', "[1:v]setpts=PTS+0.7/TB[patch];[0:v][patch]overlay=eof_action=pass:repeatlast=0:format=yuv420:enable='gte(t,0.7)*lt(t,1.1)'[v]",
    '-map', '[v]', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '0', '-pix_fmt', 'yuv420p', '-frames:v', '60', '-c:a', 'copy', patched]);
  const frameHashes = async (file) => (await run(['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'])).stdout
    .split('\n').filter((line) => /^\s*0,/.test(line)).map((line) => line.trim().split(/,\s*/).at(-1));
  const before = await frameHashes(base), after = await frameHashes(patched);
  assert.equal(before.length, 60);
  assert.equal(after.length, 60);
  const changed = before.flatMap((hash, frame) => hash === after[frame] ? [] : [frame]);
  assert.deepEqual(changed, Array.from({ length: 12 }, (_, i) => i + 21), 'only enabled frames 21–32 change; no delayed start or repeated patch tail');
  const audioPackets = async (file) => {
    const result = await exec('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'sha256',
      '-show_entries', 'packet=pts,dts,duration,size,data_hash', '-of', 'json', file], { env, timeout: 30000 });
    return JSON.parse(result.stdout).packets;
  };
  const originalPackets = await audioPackets(base), copiedPackets = await audioPackets(patched);
  assert.ok(originalPackets.length > 90);
  assert.deepEqual(copiedPackets, originalPackets, 'AAC packet bytes and timing are copied unchanged');
  const timestampProbe = await run(['-hide_banner', '-f', 'lavfi', '-i', 'color=c=red:s=96x64:r=30:d=0.1',
    '-vf', 'setpts=PTS+69.3/TB,showinfo', '-fps_mode', 'passthrough', '-f', 'null', '-']);
  const pts = [...timestampProbe.stderr.matchAll(/n:\s*\d+ pts:\s*(\d+) pts_time:/g)].map((match) => Number(match[1]));
  assert.deepEqual(pts, [2079, 2080, 2081], 'the actual 69.3-second image-sequence offset lands on integer frame 2079');
  console.log(JSON.stringify({ passed: true, fixture_seconds: 2, frames: 60, patched_interval: [21, 33], unchanged_decoded_frames: 48,
    copied_aac_packets: originalPackets.length, exact_real_offset_pts: pts }, null, 2));
} finally {
  await fs.rm(dir, { recursive: true }); // Exact isolated synthetic mkdtemp namespace only.
}
