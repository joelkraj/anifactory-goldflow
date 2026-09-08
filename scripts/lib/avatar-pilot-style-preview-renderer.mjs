import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import sharp from 'sharp';

const exec = promisify(execFile);
const W = 1920, H = 1080, FPS = 30;
const mediaEnv = { PATH: process.env.PATH, LANG: 'C' };
const sha = async (p) => createHash('sha256').update(await fs.readFile(p)).digest('hex');
const clamp = (v) => Math.max(0, Math.min(1, v));
const ease = (v) => 1 - (1 - clamp(v)) ** 3;
const mix = (a, b, t) => a + (b - a) * t;
const svg = (body, width = W, height = H) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`);
const type = (text, x, y, size, fill = '#fff', weight = 800) => `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${text}</text>`;
const raster = async (body, width = W, height = H) => sharp(svg(body, width, height)).png().toBuffer();

async function sized(file, height) {
  return sharp(file).trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } }).resize({ height }).png().toBuffer();
}

async function sticker(file, height) {
  const body = await sized(file, height);
  const { width, height: bh } = await sharp(body).metadata();
  const alpha = await sharp(body).extractChannel('alpha').png().toBuffer();
  const white = await sharp({ create: { width, height: bh, channels: 3, background: '#fffdf8' } }).joinChannel(alpha).png().toBuffer();
  const pad = 38, offsets = Array.from({ length: 24 }, (_, i) => [Math.round(Math.cos(i * Math.PI / 12) * 7), Math.round(Math.sin(i * Math.PI / 12) * 7)]);
  const bordered = await sharp({ create: { width: width + pad * 2, height: bh + pad * 2, channels: 4, background: '#00000000' } })
    .composite([...offsets.map(([dx, dy]) => ({ input: white, left: pad + dx, top: pad + dy })), { input: body, left: pad, top: pad }]).png().toBuffer();
  const borderAlpha = await sharp(bordered).extractChannel('alpha').linear(0.28).blur(12).png().toBuffer();
  const shadow = await sharp({ create: { width: width + pad * 2, height: bh + pad * 2, channels: 3, background: '#08131e' } }).joinChannel(borderAlpha).png().toBuffer();
  return sharp(shadow).composite([{ input: bordered, top: 0, left: 0 }]).png().toBuffer();
}

async function place(input, x, y, scale = 1) {
  let data = input;
  if (Math.abs(scale - 1) > 0.0001) {
    const m = await sharp(data).metadata();
    data = await sharp(data).resize({ width: Math.round(m.width * scale) }).png().toBuffer();
  }
  const m = await sharp(data).metadata();
  const left = Math.round(x), top = Math.round(y);
  const sx = Math.max(0, -left), sy = Math.max(0, -top);
  const width = Math.min(m.width - sx, W - Math.max(0, left));
  const height = Math.min(m.height - sy, H - Math.max(0, top));
  if (width <= 0 || height <= 0) return null;
  if (sx || sy || width !== m.width || height !== m.height) data = await sharp(data).extract({ left: sx, top: sy, width, height }).png().toBuffer();
  return { input: data, left: Math.max(0, left), top: Math.max(0, top) };
}

/** Called only by the guarded preview-style action; never approves or completes a stage. */
export async function renderStylePreview({ outputDir, manifest, assets }) {
  if (manifest.recipe?.id !== 'sentry_style_repair_v2' || manifest.duration_frames !== 360) throw new Error('Unsupported authored style preview recipe.');
  const required = ['narration_joel', 'film_sentry_window', 'host_room', 'host_open_palm', 'host_presenting', 'sentry_illustration', 'doom_illustration'];
  for (const id of required) if (!assets[id]) throw new Error(`Preview recipe requires ${id}.`);
  const clipDir = path.join(outputDir, 'clip_frames'); await fs.mkdir(clipDir);
  await exec('ffmpeg', ['-v', 'error', '-protocol_whitelist', 'file', '-i', assets.film_sentry_window.path, '-map', '0:v:0', '-vf', 'fps=30,scale=1200:676:force_original_aspect_ratio=decrease,pad=1200:676:(ow-iw)/2:(oh-ih)/2', '-frames:v', '150', path.join(clipDir, '%04d.png')], { timeout: 60000, env: mediaEnv });
  const room = await sharp(assets.host_room.path).resize(W, H, { fit: 'cover' }).png().toBuffer();
  const openHost = await sized(assets.host_open_palm.path, 1700);
  const presentHost = await sized(assets.host_presenting.path, 1570);
  const sentry = await sticker(assets.sentry_illustration.path, 775);
  const doom = await sticker(assets.doom_illustration.path, 780);
  const cream = await raster(`<defs><pattern id="p" width="9" height="9" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".65" fill="#c2bbae" opacity=".4"/></pattern></defs><rect width="1920" height="1080" fill="#e8e4db"/><rect width="1920" height="1080" fill="url(#p)"/><path d="M0 1025 1920 878V1080H0Z" fill="#d8d1c6"/>`);
  const red = await raster(`<defs><pattern id="p" width="9" height="9" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".7" fill="#e4b8b0" opacity=".15"/></pattern></defs><rect width="1920" height="1080" fill="#91483f"/><rect width="1920" height="1080" fill="url(#p)"/><path d="M0 870 1920 765V1080H0Z" fill="#773c37"/><path d="M1200 0 1610 0 1260 1080 850 1080Z" fill="#b56553" opacity=".22"/>`);
  const roomLabel = await raster(`<rect x="78" y="62" width="301" height="49" rx="8" fill="#101a24" fill-opacity=".84"/>${type('MCU SENTRY', 97, 96, 27)}`);
  const evidenceLabels = await raster(`<rect x="690" y="107" width="336" height="46" rx="8" fill="#263440"/>${type('THUNDERBOLTS*', 709, 138, 26)}${type('FILM EVIDENCE', 1045, 139, 24, '#52616a', 700)}${type('PUSH. HOLD. RETURN.', 690, 966, 44, '#263440')}`);
  const cardFrame = await raster(`<defs><filter id="s" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="16" stdDeviation="12" flood-color="#16242c" flood-opacity=".22"/></filter></defs><rect x="30" y="20" width="1224" height="700" rx="26" fill="#fffdf8" filter="url(#s)"/>`, 1284, 780);
  const clipMask = await raster('<rect width="1200" height="676" rx="16" fill="white"/>', 1200, 676);
  const hypothesisLabels = await raster(`<rect x="74" y="54" width="233" height="46" rx="8" fill="#f2e9d8"/>${type('OUR WHAT-IF', 92, 86, 26, '#623e37')}${type('KEEP DOOM AWAY', 74, 167, 52)}${type('SENTRY · MCU', 105, 970, 26)}${type('DOOM · ILLUSTRATION', 1338, 970, 24)}${type('Sentry: ILM production plate  /  Doom: Alex Ross artwork', 74, 1037, 19, '#e6c9c0', 400)}`);
  const route = await raster(`<rect x="0" y="0" width="540" height="72" rx="36" fill="#f2e9d8"/>${type('AVENGERS + DEVICE', 31, 46, 25, '#56372f')}<path d="M382 36H499m-20-16 20 16-20 16" fill="none" stroke="#56372f" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`, 540, 72);
  const provenance = await raster(`${type('VISUAL REVIEW', 1710, 1040, 18, '#b4afa7', 600)}`);

  const videoPath = path.join(outputDir, 'style-preview.mp4');
  const n = manifest.narration;
  const audioFilter = `[1:a]atrim=start=${n.source_in_sec}:end=${n.source_out_sec},asetpts=PTS-STARTPTS,adelay=${Math.round(n.output_in_sec * 1000)}:all=1,apad,atrim=duration=12[a]`;
  const child = spawn('ffmpeg', ['-v', 'error', '-f', 'image2pipe', '-framerate', '30', '-vcodec', 'png', '-i', 'pipe:0', '-protocol_whitelist', 'file', '-i', assets[n.asset_id].path, '-filter_complex', audioFilter, '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-frames:v', '360', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', videoPath], { stdio: ['pipe', 'ignore', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C' } });
  let stderr = '', pipeError;
  child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-8000); });
  child.stdin.on('error', (error) => { pipeError = error; child.kill('SIGKILL'); });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 240000);
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Style preview encode failed: ${stderr}`))); });
  done.then(() => clearTimeout(deadline), () => clearTimeout(deadline));
  // Avoid an unhandled rejection if an encoder error happens while preparing a frame.
  done.catch(() => {});
  const stillFrames = new Map([[21, '01-host-room.png'], [99, '02-film-card.png'], [235, '03-character-stickers.png'], [315, '04-tactical-payoff.png']]);
  const frames = [];
  try {
    for (let frame = 0; frame < 360; frame++) {
      const t = frame / FPS; const layers = []; let background;
      if (frame < 36) {
        background = room;
        layers.push(await place(openHost, mix(70, 145, ease(t / .6)), 95 - t * 4));
        layers.push({ input: roomLabel, top: 0, left: 0 });
      } else if (frame < 186) {
        background = cream;
        const ct = t - 1.2, enter = ease(ct / .47), exit = ease((ct - 4.72) / .28);
        layers.push(await place(presentHost, -255 + 35 * enter - exit * 430, 162));
        const x = mix(1990, 635, enter) - exit * 1900, y = 184 - 9 * clamp(ct / 5);
        layers.push(await place(cardFrame, x - 30, y - 20));
        const clip = await sharp(path.join(clipDir, `${String(frame - 35).padStart(4, '0')}.png`)).ensureAlpha().composite([{ input: clipMask, blend: 'dest-in' }]).png().toBuffer();
        layers.push(await place(clip, x + 12, y + 12));
        layers.push({ input: evidenceLabels, top: 0, left: 0 });
      } else {
        background = red;
        const st = t - 6.2, enter = ease(st / .48), shove = ease((t - 8.43) / .42);
        const sentryX = mix(-910, 65, enter) + 68 * shove;
        const doomX = mix(1990, 1190, enter) + 205 * shove;
        layers.push(await place(doom, doomX, 177 + 10 * shove, 1 - .065 * shove));
        layers.push(await place(sentry, sentryX, 173, 1 + .018 * shove));
        if (t >= 9.25) layers.push(await place(route, mix(150, 680, ease((t - 9.25) / 1.2)), 866));
        layers.push({ input: hypothesisLabels, top: 0, left: 0 });
      }
      layers.push({ input: provenance, top: 0, left: 0 });
      const png = await sharp(background).composite(layers.filter(Boolean)).png({ compressionLevel: 1 }).toBuffer();
      if (stillFrames.has(frame)) { const p = path.join(outputDir, stillFrames.get(frame)); await fs.writeFile(p, png, { flag: 'wx' }); frames.push({ frame, path: p, sha256: await sha(p) }); }
      if (pipeError) throw pipeError;
      if (!child.stdin.write(png)) await Promise.race([once(child.stdin, 'drain'), done.then(() => { throw new Error('Encoder ended before all frames were written.'); })]);
    }
    child.stdin.end(); await done;
  } catch (error) { child.kill('SIGKILL'); await done.catch(() => {}); throw error; }
  const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', videoPath], { timeout: 30000, env: mediaEnv })).stdout);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  if (Number(video?.nb_read_frames) !== 360 || video.width !== W || video.height !== H) throw new Error('Style preview output dimensions/frame count failed.');
  const qa = { width: W, height: H, fps: FPS, duration_frames: 360, source_audio: 'muted', narration_tempo: 'unchanged', independent_layers: true, review_only: true, probe };
  await fs.writeFile(path.join(outputDir, 'render-qa.json'), JSON.stringify(qa, null, 2), { flag: 'wx' });
  return { output: { path: videoPath, sha256: await sha(videoPath) }, width: W, height: H, fps: FPS, duration_frames: 360, frames };
}
