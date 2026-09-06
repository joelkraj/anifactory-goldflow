import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, lstat, mkdir, mkdtemp, link, unlink, rmdir, open } from 'node:fs/promises';
import path from 'node:path';
import { createFootageRangeProxy, detectFootageContainer, footageError } from './footage-range-reader.mjs';

function runMediaTool(executable, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      // Media tooling does not need provider credentials or proxy configuration.
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', HOME: process.env.HOME } });
    let stdout = '';
    let outputLimit = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (part) => {
      if (stdout.length + part.length > 1024 * 1024) { outputLimit = true; child.kill('SIGKILL'); }
      else stdout += part.toString('utf8');
    });
    // Never surface stderr: demuxers may repeat untrusted metadata or source URLs.
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(footageError('FOOTAGE_TOOL', 'The required FFmpeg/ffprobe executable could not start.')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(footageError('FOOTAGE_TIMEOUT', 'The bounded clip extraction timed out.'));
      else if (outputLimit || code !== 0) reject(footageError('FOOTAGE_TOOL', 'The media tool failed; source details were withheld.'));
      else resolve(stdout);
    });
  });
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
}

/** Extract a single silent, independently decodable 3–5 second review clip. */
export async function extractFootageClip({ source, outputPath, startSec, durationSec = 4,
  maxBytes = 128 * 1024 * 1024, timeoutMs = 120000,
  ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', _testAllowedOrigin, _testChunkBytes } = {}) {
  if (!Number.isFinite(startSec) || startSec < 0 || !Number.isFinite(durationSec) || durationSec < 3 || durationSec > 5) {
    throw footageError('FOOTAGE_TIMING', 'Clip start must be nonnegative and duration must be 3–5 seconds.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw footageError('FOOTAGE_LIMIT', 'Byte and time limits must be positive safe integers.');
  }
  if (!source || Boolean(source.local_path) === Boolean(source.url)) throw footageError('FOOTAGE_SOURCE', 'Choose exactly one local path or resolved media URL.');
  if (typeof outputPath !== 'string' || path.extname(outputPath).toLowerCase() !== '.mp4') throw footageError('FOOTAGE_OUTPUT', 'The clip output must be an MP4 path.');
  const destination = path.resolve(outputPath);
  try { await lstat(destination); throw footageError('FOOTAGE_EXISTS', 'The clip output already exists; choose a new output path.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const started = Date.now();
  const remaining = () => {
    const ms = timeoutMs - (Date.now() - started);
    if (ms <= 0) throw footageError('FOOTAGE_TIMEOUT', 'The bounded clip extraction timed out.');
    return ms;
  };
  let proxy;
  let input;
  let container;
  let sourceStats = { transferred_bytes: 0, request_count: 0, range_supported: null };
  let temporaryDirectory;
  let temporaryFile;
  try {
    if (source.local_path) {
      input = path.resolve(source.local_path);
      const info = await stat(input);
      if (!info.isFile()) throw footageError('FOOTAGE_SOURCE', 'The local source must be a regular file.');
      const handle = await open(input, 'r');
      const prefix = Buffer.alloc(Math.min(info.size, 4096));
      try { await handle.read(prefix, 0, prefix.length, 0); } finally { await handle.close(); }
      container = detectFootageContainer(prefix);
      sourceStats = { ...sourceStats, source_bytes: info.size, source_probe_sha256: createHash('sha256').update(prefix).digest('hex') };
    } else {
      proxy = await createFootageRangeProxy({ url: source.url, bytes: source.bytes, maxBytes,
        timeoutMs: remaining(), _testAllowedOrigin, ...(_testChunkBytes ? { chunkBytes: _testChunkBytes } : {}) });
      input = proxy.url;
      container = proxy.container;
      sourceStats = proxy.stats;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    temporaryDirectory = await mkdtemp(path.join(path.dirname(destination), '.footage-extract-'));
    temporaryFile = path.join(temporaryDirectory, 'clip.mp4');
    const inputSafety = ['-protocol_whitelist', proxy ? 'http,tcp' : 'file', '-format_whitelist', container,
      ...(container === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : [])];
    await runMediaTool(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-threads', '2',
      ...inputSafety, ...(proxy ? ['-rw_timeout', String(Math.min(remaining(), 30000) * 1000)] : []),
      '-ss', String(startSec), '-i', input, '-t', String(durationSec), '-map', '0:v:0',
      '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '18', '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4', temporaryFile], remaining());
    proxy?.assertHealthy();
    // Stop all upstream traffic before local QA and hashing; a successful FFmpeg
    // exit cannot hide a concurrent range-budget or transport failure.
    if (proxy) { await proxy.close(); if (proxy.failure) throw proxy.failure; }
    const probeText = await runMediaTool(ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file',
      '-format_whitelist', 'mov', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate',
      '-of', 'json', temporaryFile], remaining());
    let probe;
    try { probe = JSON.parse(probeText); } catch { throw footageError('FOOTAGE_PROBE', 'Clip verification returned malformed metadata.'); }
    const duration = Number(probe.format?.duration);
    const video = probe.streams?.find((stream) => stream.codec_type === 'video');
    if (!Number.isFinite(duration) || Math.abs(duration - durationSec) > 0.15 || duration < 2.85 || duration > 5.15
      || video?.codec_name !== 'h264' || video?.pix_fmt !== 'yuv420p' || !(video.width > 0) || !(video.height > 0)
      || probe.streams.some((stream) => stream.codec_type !== 'video') || !String(probe.format?.format_name).includes('mp4')) {
      throw footageError('FOOTAGE_PROBE', 'The extracted clip failed duration, video, or silent-MP4 verification.');
    }
    const clipHash = await hashFile(temporaryFile);
    const clipBytes = (await stat(temporaryFile)).size;
    remaining();
    // A hard link publishes atomically without ever replacing an existing file.
    await link(temporaryFile, destination);
    return { output_path: destination, clip_sha256: clipHash, clip_bytes: clipBytes,
      start_sec: startSec, requested_duration_sec: durationSec, actual_duration_sec: duration,
      width: video.width, height: video.height, codec: video.codec_name, pixel_format: video.pix_fmt,
      frame_rate: video.r_frame_rate, audio_policy: 'removed', ...sourceStats,
      elapsed_ms: Date.now() - started, max_bytes: maxBytes, timeout_ms: timeoutMs };
  } catch (error) {
    if (proxy?.failure) throw proxy.failure;
    if (String(error.code ?? '').startsWith('FOOTAGE_')) throw error;
    if (error.code === 'EEXIST') throw footageError('FOOTAGE_EXISTS', 'The clip output already exists; choose a new output path.');
    throw footageError('FOOTAGE_EXTRACT', 'Clip extraction failed; source details were withheld.');
  } finally {
    await proxy?.close();
    if (temporaryFile) await unlink(temporaryFile).catch(() => {});
    if (temporaryDirectory) await rmdir(temporaryDirectory).catch(() => {});
  }
}
