import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import sharp from 'sharp';
import { hostMatte, sticker, place } from './avatar-pilot-style-preview-renderer.mjs';

const exec = promisify(execFile);
const W = 1920, H = 1080, FPS = 30;
const env = { PATH: process.env.PATH, LANG: 'C' };
const hash = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const ref = async (file) => ({ path: file, sha256: await hash(file) });
const clamp = (v) => Math.min(1, Math.max(0, v));
const ease = (v) => 1 - (1 - clamp(v)) ** 3;
const mix = (a, b, t) => a + (b - a) * t;
const xml = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const type = (s, x, y, size, fill = '#fffdf8', weight = 800) => `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${xml(s)}</text>`;
const raster = (body, width = W, height = H) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`)).png().toBuffer();
const cueProgress = (shot, frame, action, duration = 18) => {
  const cue = shot.cues?.find((row) => row.action === action);
  return cue ? ease((frame - cue.frame) / duration) : 0;
};

async function backdrop(color, floor, stripe) {
  return raster(`<defs><pattern id="p" width="9" height="9" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".7" fill="#fff3df" opacity=".13"/></pattern></defs><rect width="1920" height="1080" fill="${color}"/><rect width="1920" height="1080" fill="url(#p)"/><path d="M0 900 1920 780V1080H0Z" fill="${floor}"/><path d="M1220 0H1610L1260 1080H850Z" fill="${stripe}" opacity=".19"/>`);
}

/** No synthesis or accepted-master mutation: split in sentence silence, at original tempo. */
async function programAudio(outputDir, manifest, assets) {
  const timeline = manifest.recipe.timeline;
  const audioRows = timeline.source_audio;
  const inputs = ['-protocol_whitelist', 'file', '-i', assets[manifest.narration.asset_id].path];
  for (const row of audioRows) inputs.push('-protocol_whitelist', 'file', '-i', assets[row.asset_id].path);
  const rows = manifest.narration_placements;
  const chains = [`[0:a]asplit=${rows.length}${rows.map((_, i) => `[n${i}]`).join('')}`];
  for (const [i, row] of rows.entries()) chains.push(`[n${i}]atrim=start=${row.source_in_sec}:end=${row.source_out_sec},asetpts=PTS-STARTPTS,aresample=48000,adelay=${Math.round(row.output_in_sec * 48000)}S:all=1[s${i}]`);
  for (const [i, row] of audioRows.entries()) chains.push(`[${i + 1}:a]atrim=start=${row.source_in_sec}:end=${row.source_out_sec},asetpts=PTS-STARTPTS,aresample=48000,volume=${row.gain_db}dB,afade=t=in:d=0.015,afade=t=out:st=4.985:d=0.015,adelay=${row.start_frame * 1600}S:all=1[c${i}]`);
  chains.push(`${rows.map((_, i) => `[s${i}]`).join('')}${audioRows.map((_, i) => `[c${i}]`).join('')}amix=inputs=${rows.length + audioRows.length}:normalize=0,apad,atrim=duration=90[a]`);
  const raw = path.join(outputDir, 'program-mix-unmastered.wav');
  await exec('ffmpeg', ['-v', 'error', ...inputs, '-filter_complex', chains.join(';'), '-map', '[a]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', raw], { env, timeout: 90000 });
  const first = await exec('ffmpeg', ['-hide_banner', '-i', raw, '-af', 'loudnorm=I=-16:TP=-1.8:LRA=11:print_format=json', '-f', 'null', '-'], { env, timeout: 90000 });
  const measurement = JSON.parse(first.stderr.slice(first.stderr.lastIndexOf('{')));
  for (const key of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) if (!Number.isFinite(Number(measurement[key]))) throw new Error(`Invalid mix measurement ${key}`);
  const mastered = path.join(outputDir, 'program-mix-mastered.wav');
  const filter = `loudnorm=I=-16:TP=-1.8:LRA=11:measured_I=${measurement.input_i}:measured_TP=${measurement.input_tp}:measured_LRA=${measurement.input_lra}:measured_thresh=${measurement.input_thresh}:offset=${measurement.target_offset}:linear=true:print_format=json`;
  const second = await exec('ffmpeg', ['-hide_banner', '-i', raw, '-af', filter, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', mastered], { env, timeout: 90000 });
  const mastering = JSON.parse(second.stderr.slice(second.stderr.lastIndexOf('{')));
  return { path: mastered, source: await ref(assets[manifest.narration.asset_id].path), raw: await ref(raw), master: await ref(mastered), measurement, mastering, narration_tempo: 1, accepted_master_unchanged: true, placements: rows, source_audio: audioRows };
}

/** Authored 90-second local review renderer; entry only through guarded preview-program. */
export async function renderProgramReview({ outputDir, manifest, assets }) {
  const tl = manifest.recipe.timeline;
  if (manifest.duration_frames !== 2700 || tl?.schema !== 'goldflow_sentry_program_editorial_review_v1') throw new Error('Unsupported program recipe.');
  const required = ['host_room', 'host_open_palm', 'host_presenting', 'host_thinking', 'host_skeptical', 'host_confident', 'sentry_illustration', 'doom_illustration', 'void_illustration', 'film_sentry_window', 'film_void_shadow', 'narration_joel'];
  for (const id of required) if (!assets[id]) throw new Error(`Missing bound ${id}`);
  const audio = await programAudio(outputDir, manifest, assets);
  const room = await sharp(assets.host_room.path).resize(W, H, { fit: 'cover' }).png().toBuffer();
  const backgrounds = {
    cream: await backdrop('#e8e4db', '#d8d1c6', '#ffffff'),
    red: await backdrop('#91483f', '#773c37', '#dd9d79'),
    blue: await backdrop('#344e62', '#273e50', '#a3b7bc'),
  };
  const hosts = {};
  for (const id of required.filter((id) => id.startsWith('host_') && id !== 'host_room')) hosts[id] = await hostMatte(assets[id].path, id === 'host_presenting' ? 1570 : 1700);
  const stickers = {}, small = {};
  for (const [id, h] of [['sentry_illustration', 775], ['doom_illustration', 780], ['void_illustration', 720]]) {
    stickers[id] = await sticker(assets[id].path, h);
    small[id] = await sharp(stickers[id]).resize({ height: 595 }).png().toBuffer();
  }
  const card = await raster('<defs><filter id="s" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="16" stdDeviation="12" flood-color="#16242c" flood-opacity=".22"/></filter></defs><rect x="30" y="20" width="1224" height="700" rx="26" fill="#fffdf8" filter="url(#s)"/>', 1284, 780);
  const mask = await raster('<rect width="1200" height="676" rx="16" fill="white"/>', 1200, 676);
  const clipDirs = {};
  for (const id of ['film_sentry_window', 'film_void_shadow']) {
    const dir = path.join(outputDir, id); await fs.mkdir(dir); clipDirs[id] = dir;
    await exec('ffmpeg', ['-v', 'error', '-protocol_whitelist', 'file', '-i', assets[id].path, '-map', '0:v:0', '-vf', 'fps=30,scale=1200:676:force_original_aspect_ratio=decrease,pad=1200:676:(ow-iw)/2:(oh-ih)/2', '-frames:v', '150', path.join(dir, '%04d.png')], { env, timeout: 60000 });
  }
  const route = await raster(`<rect width="540" height="72" rx="36" fill="#f2e9d8"/>${type('AVENGERS + DEVICE', 31, 46, 25, '#56372f')}<path d="M382 36H499m-20-16 20 16-20 16" fill="none" stroke="#56372f" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`, 540, 72);
  const device = await raster(`<rect width="300" height="66" rx="12" fill="#f2e9d8"/>${type('THE DEVICE', 26, 44, 29, '#56372f')}`, 300, 66);
  const doorway = await raster('<path d="M725 925V255H1195V925" fill="#112333" fill-opacity=".28" stroke="#c8d5d4" stroke-opacity=".58" stroke-width="12"/><path d="M663 954H1255" stroke="#afc1c4" stroke-width="8"/>');
  const detour = await raster('<path d="M520 825V330Q520 265 600 265H1350Q1450 265 1450 350V760m-17-20 17 20 17-20" fill="none" stroke="#dac6a5" stroke-opacity=".7" stroke-width="7" stroke-dasharray="16 14"/>');
  const platform = await raster('<path d="M0 10H640L590 65H0Z" fill="#c6d5d7"/><path d="M0 65H590V91H0Z" fill="#a4b7bb"/>', 640, 96);
  const labels = new Map();
  for (const shot of tl.shots) {
    const light = shot.type === 'comparison' || (shot.type === 'evidence' && shot.variant === 'sentry');
    const textColor = light ? '#263440' : '#fffdf8';
    const roomShot = shot.type === 'room';
    const tagWidth = Math.max(235, shot.label.length * 18 + 38);
    let body = `<rect x="74" y="54" width="${tagWidth}" height="48" rx="8" fill="${roomShot ? '#101a24' : '#f2e9d8'}" fill-opacity=".94"/>${type(shot.label, 92, 88, 26, roomShot ? '#fffdf8' : '#563e37')}`;
    if (shot.heading && !roomShot && shot.type !== 'evidence') body += type(shot.heading, 74, 171, shot.heading.length > 25 ? 44 : 52, textColor);
    if (shot.type === 'evidence') body += type('THUNDERBOLTS*', 690, 144, 37, textColor) + type('ORIGINAL FILM AUDIO', 690, 963, 27, textColor, 700);
    if (roomShot && shot.heading) {
      const words = shot.heading.split(' '), lines = []; let line = '';
      for (const word of words) { if ((line + word).length > 22 && line) { lines.push(line.trim()); line = ''; } line += `${word} `; } if (line) lines.push(line.trim());
      body += `<rect x="1050" y="735" width="795" height="${54 + lines.length * 53}" rx="15" fill="#101a24" fill-opacity=".88"/>`;
      lines.forEach((l, i) => { body += type(l, 1080, 791 + i * 53, 38); });
    }
    if (shot.type !== 'room' && shot.type !== 'evidence') body += type('Sentry: ILM production plate  /  Doom: Alex Ross artwork  /  Void: Thunderbolts* frame', 74, 1037, 18, light ? '#62696a' : '#dccbc3', 400);
    body += type('PRIVATE PROOF', 1695, 1037, 17, light ? '#7c817f' : '#bbc0bf', 600);
    labels.set(shot.id, await raster(body));
  }
  const mastery = await raster(`<rect width="440" height="58" rx="12" fill="#f2e9d8"/>${type('DELIBERATE CONTROL', 22, 39, 29, '#56372f')}`, 440, 58);
  const movieOnly = await raster(`<rect width="455" height="58" rx="12" fill="#263440"/>${type('MOVIE ABILITIES ONLY', 22, 39, 28)}`, 455, 58);
  const qaFrames = new Map(tl.shots.map((s) => [Math.round(s.start_frame + (s.end_frame - s.start_frame) * .67), `${s.id}.png`]));
  const frames = [];
  const videoPath = path.join(outputDir, 'sentry-90s-private-proof.mp4');
  const child = spawn('ffmpeg', ['-v', 'error', '-f', 'image2pipe', '-framerate', '30', '-vcodec', 'png', '-i', 'pipe:0', '-protocol_whitelist', 'file', '-i', audio.path, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-frames:v', '2700', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', videoPath], { env, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '', pipeError;
  child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-8000); });
  child.stdin.on('error', (error) => { pipeError = error; child.kill('SIGKILL'); });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 1200000);
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Program encode failed: ${stderr}`))); });
  done.then(() => clearTimeout(deadline), () => clearTimeout(deadline)); done.catch(() => {});
  let shotIndex = 0;
  try {
    for (let frame = 0; frame < 2700; frame++) {
      while (frame >= tl.shots[shotIndex].end_frame) shotIndex++;
      const shot = tl.shots[shotIndex], local = frame - shot.start_frame;
      const p = local / (shot.end_frame - shot.start_frame), enter = ease(local / 14);
      const layers = [], add = async (input, x, y, scale) => { const placed = await place(input, x, y, scale); if (placed) layers.push(placed); };
      let bg = backgrounds.red;
      if (shot.type === 'room') {
        bg = room;
        await add(hosts[shot.host_pose], mix(70, 125, enter) + p * 18, shot.host_pose === 'host_presenting' ? 155 - p * 8 : 90 - p * 8);
        if (shot.variant === 'scope') { await add(small.sentry_illustration, mix(1990, 1200, enter), 290); if (frame >= 311) await add(mastery, 1210, 655); }
        if (shot.variant === 'uncertain_limit') await add(small.doom_illustration, mix(1990, 1235, enter), 245);
      } else if (shot.type === 'evidence') {
        bg = backgrounds[shot.variant === 'sentry' ? 'cream' : 'blue'];
        await add(hosts[shot.host_pose], -15 + 35 * enter, shot.host_pose === 'host_presenting' ? 162 : 120);
        // Card is readable from frame one; small lateral settle never hides the evidence.
        const x = mix(715, 635, enter), y = 184 - 9 * p;
        await add(card, x - 30, y - 20);
        const file = path.join(clipDirs[shot.film.asset_id], `${String(local + 1).padStart(4, '0')}.png`);
        const clip = await sharp(file).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
        await add(clip, x + 12, y + 12);
      } else if (shot.type === 'intercept') {
        const opening = shot.variant === 'opening_intercept';
        const shove = cueProgress(shot, frame, opening ? 'doom_recoils' : 'sentry_blocks');
        await add(stickers.doom_illustration, mix(1500, 1190, enter) + 205 * shove, 177 + 10 * shove);
        await add(stickers.sentry_illustration, mix(-850, 65, opening ? ease((local - 47) / 17) : enter) + 68 * shove, 173);
        if (opening) await add(device, 925 - 55 * cueProgress(shot, frame, 'doom_reaches', 28), 880);
        else if (frame >= 923) await add(route, mix(150, 820, cueProgress(shot, frame, 'escape_route_moves', 45)), 870);
      } else if (shot.type === 'comparison') {
        bg = backgrounds.cream;
        if (shot.left_asset_id) await add(small[shot.left_asset_id], mix(-660, 60, enter), 320);
        if (shot.right_asset_id) await add(small[shot.right_asset_id], mix(1970, 1270, enter), 315);
        await add(hosts[shot.host_pose], shot.variant === 'void_effect' ? 775 : 450, 215 - p * 7, .71);
        if (shot.secondary_label) await add(movieOnly, 730, 906);
        if (shot.variant === 'team_survives') await add(route, 1230 + 55 * p, 911);
      } else if (shot.type === 'rescue') {
        bg = backgrounds.blue;
        const saving = shot.variant === 'sentry_rescue';
        const drop = saving ? 1 - cueProgress(shot, frame, 'escape_route_recovers', 40) : cueProgress(shot, frame, 'escape_route_drops', 22);
        await add(platform, 1125, 728);
        await add(platform, 525, 800 + 168 * drop);
        await add(route, 600 + (saving ? 560 * (1 - drop) : 0), 710 + 168 * drop);
        await add(small.doom_illustration, saving ? 90 : 1150, saving ? 370 : 290);
        await add(stickers.sentry_illustration, saving ? 290 + 430 * cueProgress(shot, frame, 'sentry_breaks_off', 42) : 75 - 75 * cueProgress(shot, frame, 'doom_counterplay', 25), 186);
      } else if (shot.type === 'void' || shot.type === 'hold' || shot.type === 'payoff') {
        bg = backgrounds.blue;
        layers.push({ input: doorway, left: 0, top: 0 });
        const reveal = shot.variant !== 'doorway' || frame >= 1384;
        const detouring = ['long_route', 'hold_position', 'protect_route', 'time_won', 'objective_clear'].includes(shot.variant);
        if (detouring) layers.push({ input: detour, left: 0, top: 0 });
        let doomX = 70, doomY = 335;
        if (shot.variant === 'doorway') doomX += 195 * cueProgress(shot, frame, 'doom_follows', 32);
        if (shot.variant === 'long_route') { const d = cueProgress(shot, frame, 'doom_detours', 47); doomX = 160 - 300 * d; doomY -= 100 * d; }
        if (shot.type === 'hold' || shot.type === 'payoff') { doomX = -70 - 260 * p; doomY = 255; }
        if (shot.variant === 'objective_clear') doomX = mix(1970, 1390, cueProgress(shot, frame, 'doom_arrives_late', 25));
        if (shot.variant === 'decisive_sequence') doomX = 1310 + 190 * cueProgress(shot, frame, 'objective_lost', 24);
        await add(small.doom_illustration, doomX, doomY);
        let routeX = 1080, routeY = 853;
        if (shot.variant === 'protect_route') routeX = 1080 + 250 * p;
        if (shot.variant === 'time_won') routeX = 1320 + 110 * p;
        if (shot.variant === 'objective_clear') routeX = 1430 + 660 * cueProgress(shot, frame, 'objective_exits', 25);
        if (shot.variant === 'decisive_sequence') { routeY = 940 - 105 * cueProgress(shot, frame, 'rescue_reprise', 23); routeX = 1130 + 810 * cueProgress(shot, frame, 'objective_lost', 42); }
        if (shot.type !== 'void') await add(route, routeX, routeY);
        const isSentry = !reveal || shot.variant === 'decisive_sequence';
        const hero = isSentry ? stickers.sentry_illustration : stickers.void_illustration;
        const heroX = isSentry ? (shot.variant === 'decisive_sequence' ? mix(185, 620, cueProgress(shot, frame, 'sentry_returns', 24)) : mix(1100, 650, cueProgress(shot, frame, 'sentry_turns_back', 30))) : 575;
        await add(hero, heroX, isSentry ? 200 : 240 - p * 7);
        if (shot.variant === 'protect_route') await add(hosts.host_presenting, -5, 420, .57);
      }
      layers.push({ input: labels.get(shot.id), top: 0, left: 0 });
      const png = await sharp(bg).composite(layers).png({ compressionLevel: 1 }).toBuffer();
      if (qaFrames.has(frame)) { const file = path.join(outputDir, qaFrames.get(frame)); await fs.writeFile(file, png, { flag: 'wx' }); frames.push({ frame, ...await ref(file) }); }
      if (pipeError) throw pipeError;
      if (!child.stdin.write(png)) await Promise.race([once(child.stdin, 'drain'), done.then(() => { throw new Error('Encoder ended before frame coverage completed.'); })]);
      if (frame % 300 === 0) process.stderr.write(`Program review: ${frame}/2700 frames\n`);
    }
    child.stdin.end(); await done;
  } catch (error) { child.kill('SIGKILL'); await done.catch(() => {}); throw error; }
  const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', videoPath], { env, timeout: 60000 })).stdout);
  const measured = await exec('ffmpeg', ['-hide_banner', '-i', videoPath, '-vn', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { env, timeout: 90000 });
  const loudness = JSON.parse(measured.stderr.slice(measured.stderr.lastIndexOf('{')));
  const v = probe.streams.find((s) => s.codec_type === 'video');
  if (Number(v.nb_read_frames) !== 2700 || v.width !== W || v.height !== H || Math.abs(Number(probe.format.duration) - 90) > .08) throw new Error('Program dimensions/duration failed.');
  if (Math.abs(Number(loudness.input_i) + 16) > 1 || Number(loudness.input_tp) > -1.5) throw new Error(`Final encoded mix failed target: ${loudness.input_i} LUFS / ${loudness.input_tp} dBTP`);
  const reportPath = path.join(outputDir, 'render-qa.json');
  await fs.writeFile(reportPath, JSON.stringify({ schema: 'goldflow_avatar_program_render_qa_v1', width: W, height: H, fps: FPS, duration_frames: 2700, captions: [], audio, loudness, probe, frames, independent_layers: true, exact_program_approval_recorded: false, review_only: true }, null, 2), { flag: 'wx' });
  return { output: await ref(videoPath), technical_report: await ref(reportPath), width: W, height: H, fps: FPS, duration_frames: 2700, frames };
}
