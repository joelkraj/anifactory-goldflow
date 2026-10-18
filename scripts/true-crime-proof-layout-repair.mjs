import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { loadTrueCrimeProofIdentity, trueCrimeProofStatus, trueCrimeProofFileRef } from './lib/true-crime-proof-workflow.mjs';
import { planTrueCrimeProof, evaluateProofTransform } from './lib/true-crime-proof-renderer.mjs';

const execute = promisify(execFile);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const need = (ok, message) => { if (!ok) throw new Error(`True-crime layout/audio repair: ${message}`); };
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const sameRef = (a, b) => a?.path === b?.path && a?.sha256 === b?.sha256;
const normalized = (s) => s.trim().replace(/\s+/gu, ' ');
const xml = (s) => s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
const SPECS = [
  { scene: 'S05', id: 'reported_absence', lines: ['REPORTED ABSENCE', 'AROUND 6:15 A.M.'], x: 86, y: 275, width: 825, height: 285, font: 48, oldFont: 57 },
  { scene: 'S05', id: 'not_witnessed', lines: ['DEPARTURE NOT', 'WITNESSED BY HIM'], x: 1005, y: 275, width: 825, height: 285, font: 48, oldFont: 57, entranceX: 1060, entranceSec: .7 },
  { scene: 'S06', id: 'message_date', lines: ['REPORTED MESSAGE', 'SUNDAY · JULY 4'], x: 90, y: 245, width: 825, height: 220, font: 44, oldFont: 52 },
  { scene: 'S06', id: 'parade_date', lines: ['PARADE DATE', 'SATURDAY · JULY 3'], x: 1005, y: 245, width: 825, height: 220, font: 44, oldFont: 52, entranceX: 1045, entranceSec: .65 },
];
async function checked(ref) {
  need(path.isAbsolute(ref?.path ?? '') && /^[a-f0-9]{64}$/u.test(ref?.sha256 ?? ''), 'absolute file/hash binding required');
  need(sameRef(await trueCrimeProofFileRef(ref.path), ref), `bound input changed: ${path.basename(ref.path)}`);
  return fs.readFile(ref.path);
}
const run = (args, maxBuffer = 12 * 1024 * 1024) => execute('ffmpeg', args, { maxBuffer, timeout: 20 * 60 * 1000 });
async function probe(file) {
  const { stdout } = await execute('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file], { maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout);
}

/** Pure, exact four-card repair planning. No additional scenes or text are accepted. */
export function planCardLayoutRepair(manifest, timeline) {
  need(JSON.stringify(planTrueCrimeProof(manifest)) === JSON.stringify(timeline), 'retained timeline differs from the exact render manifest');
  need(timeline.width === 1920 && timeline.height === 1080 && timeline.fps === 30, 'exact 1080p/30 timeline required');
  return SPECS.map((spec) => {
    const scene = timeline.scenes.find((row) => row.id === spec.scene);
    const layer = scene?.layers.find((row) => row.id === spec.id);
    need(scene?.background?.color === '#162630' && layer?.type === 'card' && !layer.path, `${spec.id} is not the retained flat-background text card`);
    need(layer.text === spec.lines.join('\n') && normalized(layer.text) === normalized(spec.lines.join(' ')), `${spec.id} text changed`);
    need(['x', 'y', 'width', 'height'].every((key) => layer[key] === spec[key]) && layer.font_size === spec.oldFont && layer.fill === '#f3ecdb' && layer.text_color === '#1b2933', `${spec.id} geometry/style changed`);
    const keys = layer.transform_keys;
    need(keys.every((key) => key.y === spec.y && key.scale === 1 && key.rotation === 0), `${spec.id} has an unsupported transform`);
    if (spec.entranceX) {
      need(keys.length === 3 && keys[0].time_sec === 0 && keys[0].x === spec.entranceX && keys[0].opacity === 0 && keys[1].x === spec.entranceX && keys[1].opacity === 0 && keys[1].time_sec > 0 && keys[2].x === spec.x && keys[2].opacity === 1 && keys[2].easing === 'ease_out' && Math.abs(keys[2].time_sec - keys[1].time_sec - spec.entranceSec) < 1e-8, `${spec.id} entrance choreography changed`);
    } else need(keys.length === 1 && keys[0].x === spec.x && keys[0].opacity === 1, `${spec.id} static placement changed`);
    return { ...spec, scene_start_sec: scene.start_sec, scene_end_sec: scene.end_sec,
      first_frame: Math.ceil((scene.start_sec - 1e-8) * 30), last_frame: Math.ceil((scene.end_sec - 1e-8) * 30) - 1,
      transform_keys: keys, erase: { x: spec.x, y: spec.y, width: spec.width + ((spec.entranceX ?? spec.x) - spec.x), height: spec.height } };
  });
}

/** Code-native card typesetting, measured with libvips/Pango before any card is emitted. */
export async function renderMeasuredRepairCard(card) {
  need(card.lines.length === 2, 'exact two-line card required');
  const overlays = [], measurements = [];
  for (let i = 0; i < card.lines.length; i++) {
    const { data, info } = await sharp({ text: { text: `<span foreground="#1b2933">${xml(card.lines[i])}</span>`, font: `Arial Bold ${card.font}`, rgba: true, dpi: 72 } }).png().toBuffer({ resolveWithObject: true });
    need(info.width <= card.width - 64 && info.height <= card.font * 1.3, 'measured text exceeds safe card bounds');
    const top = 48 + i * Math.round(card.font * 1.4);
    need(top + info.height <= card.height - 28, 'measured text exceeds vertical card bounds');
    overlays.push({ input: data, left: 32, top }); measurements.push({ text: card.lines[i], x: 32, y: top, width: info.width, height: info.height });
  }
  const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${card.width}" height="${card.height}"><rect width="${card.width}" height="${card.height}" rx="22" fill="#f3ecdb"/></svg>`);
  return { bytes: await sharp(background).composite(overlays).png().toBuffer(), measurements };
}

/** Bounded FFmpeg graph: erase the old card swept areas, then replace four exact cards. */
export function buildCardRepairFilter(cards) {
  const filters = []; let current = '[0:v]';
  cards.forEach((card, i) => {
    const active = `between(t,${(card.first_frame / 30 - 1e-6).toFixed(9)},${((card.last_frame + .5) / 30).toFixed(9)})`;
    const box = card.erase;
    filters.push(`${current}drawbox=x=${box.x}:y=${box.y}:w=${box.width}:h=${box.height}:color=0x162630:t=fill:enable='${active}'[erased${i}]`);
    let x = String(card.x), alpha = 'format=rgba';
    if (card.entranceX) {
      const start = card.scene_start_sec + card.transform_keys[1].time_sec;
      x = `round(${card.entranceX}+(${card.x - card.entranceX})*(1-pow(1-clip((t-${start})/${card.entranceSec},0,1),3)))`;
      const commands = ['0 colorchannelmixer@card' + i + ' aa 0'];
      const first = Math.ceil(start * 30), last = Math.ceil((start + card.entranceSec) * 30);
      for (let frame = first; frame <= last; frame++) {
        const opacity = evaluateProofTransform(card.transform_keys, frame / 30 - card.scene_start_sec).opacity;
        commands.push(`${(frame / 30 - 1e-6).toFixed(9)} colorchannelmixer@card${i} aa ${opacity.toFixed(12)}`);
      }
      alpha += `,sendcmd=c='${commands.join(';')}',colorchannelmixer@card${i}=aa=0`;
    }
    filters.push(`[${i + 2}:v]${alpha}[card${i}]`);
    filters.push(`[erased${i}][card${i}]overlay=x='${x}':y=${card.y}:eval=frame:format=auto:enable='${active}'[patched${i}]`);
    current = `[patched${i}]`;
  });
  filters.push(`${current}format=yuv420p[outv]`);
  return filters.join(';\n');
}

async function audioPacketHash(file) {
  const { stdout } = await execute('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'data', '-'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  return sha(stdout);
}
async function compareFrames(source, output, cards, frames, outputDir) {
  const select = frames.map((frame) => `eq(n,${frame})`).join('+');
  const decode = async (file) => (await execute('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select='${select}'`, '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: (frames.length + 1) * 1920 * 1080 * 3, timeout: 180000 })).stdout;
  const before = await decode(source), after = await decode(output), stride = 1920 * 1080 * 3;
  need(before.length === stride * frames.length && after.length === before.length, 'QA frame extraction count differs');
  const rows = [];
  for (let i = 0; i < frames.length; i++) {
    const masks = cards.filter((c) => frames[i] >= c.first_frame && frames[i] <= c.last_frame).map((c) => c.erase);
    let squared = 0, count = 0, patchedSquared = 0;
    for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) {
      const masked = masks.some((m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
      const offset = i * stride + (y * 1920 + x) * 3;
      for (let c = 0; c < 3; c++) { const difference = after[offset + c] - before[offset + c]; if (masked) patchedSquared += difference * difference; else { squared += difference * difference; count++; } }
    }
    const psnr = squared ? 10 * Math.log10(255 ** 2 / (squared / count)) : Infinity;
    need(psnr >= 38, `outside-card decoded quality below 38 dB at frame ${frames[i]}`);
    const file = path.join(outputDir, `qa-frame-${String(frames[i]).padStart(5, '0')}.png`);
    await sharp(after.subarray(i * stride, (i + 1) * stride), { raw: { width: 1920, height: 1080, channels: 3 } }).png().toFile(file);
    rows.push({ frame: frames[i], outside_card_psnr_db: Number.isFinite(psnr) ? psnr : 'infinity', changed_card_squared_error: patchedSquared, frame_artifact: await trueCrimeProofFileRef(file) });
  }
  return rows;
}

/** Exact closed-attempt recovery. Originals, stage records, identity and narrator source are immutable. */
export async function repairTrueCrimeProofLayout({ recipePath } = {}) {
  need(path.isAbsolute(recipePath ?? ''), 'absolute repair recipe required');
  const recipeRef = await trueCrimeProofFileRef(recipePath), recipe = JSON.parse(await checked(recipeRef));
  const fields = ['schema', 'proof_dir', 'output_dir', 'scope', 'scene_ids', 'production_eligible', 'creative_generation', 'source_attempt', 'source_video', 'source_manifest', 'source_timeline', 'source_narration', 'qa_findings'];
  need(Object.keys(recipe).every((key) => fields.includes(key)), 'unsupported recipe fields');
  need(recipe.schema === 'goldflow_true_crime_layout_repair_recipe_v1' && recipe.scope === 'S05_S06_card_line_layout_and_program_audio_only' && JSON.stringify(recipe.scene_ids) === '["S05","S06"]' && recipe.production_eligible === false && recipe.creative_generation === false, 'exact S05/S06 card-layout and complete-program audio repair scope required');
  need(path.isAbsolute(recipe.proof_dir ?? '') && recipe.proof_dir === await fs.realpath(recipe.proof_dir), 'explicit canonical existing proof directory required');
  need(recipe.output_dir === path.join(recipe.proof_dir, 'program_review_repairs/card-layout-audio-v1'), 'exact new repair output directory required');
  const loaded = await loadTrueCrimeProofIdentity({ proofDir: recipe.proof_dir }), status = await trueCrimeProofStatus({ proofDir: recipe.proof_dir });
  need(status.state === 'needs_triage' && status.stages.find((s) => s.stage === 'program_review')?.state === 'needs_triage' && status.stages.slice(0, 2).every((s) => s.artifact), 'closed failed program attempt with retained upstream candidates required');
  need(!(await fs.lstat(path.join(recipe.proof_dir, 'operation.lock')).catch((e) => { if (e.code === 'ENOENT') return null; throw e; })), 'an operation is still open');
  const sourceDir = path.join(recipe.proof_dir, 'attempts/program_review/output');
  need(recipe.source_attempt?.path === path.join(recipe.proof_dir, 'attempts/program_review/start.json') && recipe.source_video?.path === path.join(sourceDir, 'private-proof.mp4') && recipe.source_timeline?.path === path.join(sourceDir, 'timeline.json'), 'exact retained failed attempt/video/timeline required');
  const bindings = ['source_attempt', 'source_video', 'source_manifest', 'source_timeline', 'source_narration'];
  const bytes = Object.fromEntries(await Promise.all(bindings.map(async (key) => [key, await checked(recipe[key])])));
  const attempt = JSON.parse(bytes.source_attempt), manifest = JSON.parse(bytes.source_manifest), timeline = JSON.parse(bytes.source_timeline);
  need(attempt.stage === 'program_review' && attempt.identity_sha256 === loaded.identity_sha256, 'attempt identity differs');
  const lockedManifest = attempt.inputs.find((ref) => ref.path !== loaded.identity.plan.path && ref.path !== loaded.identity.script.path);
  need(lockedManifest && JSON.stringify(JSON.parse(await checked(lockedManifest))) === JSON.stringify(manifest), 'manifest differs from the attempted render input');
  need(recipe.source_manifest.path === path.join(sourceDir, 'render-input.json') || sameRef(recipe.source_manifest, lockedManifest), 'manifest must be the exact retained input');
  const narrationStageRef = await trueCrimeProofFileRef(path.join(recipe.proof_dir, 'narration.json'));
  const narrationReceipt = JSON.parse(await checked(narrationStageRef));
  need(narrationReceipt.identity_sha256 === loaded.identity_sha256 && narrationReceipt.artifacts.some((row) => row.kind === 'narration_audio' && sameRef(row, recipe.source_narration)) && sameRef(manifest.narration, recipe.source_narration), 'source WAV must be the retained full narration candidate');
  need(manifest.provenance?.editorial_plan?.sha256 === loaded.identity.plan.sha256, 'editorial plan differs from identity');
  need(Array.isArray(recipe.qa_findings) && ['S05', 'S06'].every((id) => recipe.qa_findings.some((q) => q.scene_id === id && typeof q.description === 'string' && q.description.trim())), 'both recorded visual QA findings required');
  for (const finding of recipe.qa_findings) {
    need(['S05', 'S06'].includes(finding.scene_id) && path.dirname(finding.evidence?.path ?? '') === sourceDir && /^frame-\d{5}\.png$/u.test(path.basename(finding.evidence.path)), 'QA evidence must be a retained failed-render frame');
    await checked(finding.evidence);
  }
  const cards = planCardLayoutRepair(manifest, timeline);
  const sourceProbe = await probe(recipe.source_video.path), sourceVideo = sourceProbe.streams.find((s) => s.codec_type === 'video'), sourceAudio = sourceProbe.streams.find((s) => s.codec_type === 'audio');
  need(timeline.duration_frames === 2802 && timeline.duration_sec === 93.4 && Number(sourceVideo?.nb_read_frames) === 2802 && sourceVideo.width === 1920 && sourceVideo.height === 1080 && sourceVideo.r_frame_rate === '30/1' && Math.abs(Number(sourceVideo.duration) - 93.4) < .01, 'exact retained 2802-frame/93.4-second failed candidate required');
  need(sourceAudio?.codec_name === 'aac' && Math.abs(Number(sourceAudio.duration) * 2 - timeline.duration_sec) < .05, 'expected half-duration AAC fault not present');
  const adapter = await trueCrimeProofFileRef(fileURLToPath(import.meta.url));
  const audioHelper = await trueCrimeProofFileRef(fileURLToPath(new URL('./lib/true-crime-proof-program-audio-repair.mjs', import.meta.url)));
  const { buildProgramPcm } = await import('./lib/true-crime-proof-program-audio-repair.mjs');
  const program = buildProgramPcm({ sourceWavBytes: bytes.source_narration, timeline });
  const repairRoot = path.dirname(recipe.output_dir);
  await fs.mkdir(repairRoot, { recursive: true }); need(await fs.realpath(repairRoot) === repairRoot, 'repair parent may not be a symlink');
  await fs.mkdir(recipe.output_dir, { recursive: false });
  const eventPath = path.join(recipe.output_dir, 'events.jsonl');
  const event = (row) => fs.appendFile(eventPath, JSON.stringify({ recorded_at: new Date().toISOString(), ...row }) + '\n');
  await writeJson(path.join(recipe.output_dir, 'request.json'), { ...recipe, recipe_binding: recipeRef, identity_sha256: loaded.identity_sha256, adapter, audio_helper: audioHelper });
  await event({ status: 'started', scope: recipe.scope, identity_sha256: loaded.identity_sha256, provider_calls: 0, cost_usd: 0 });
  try {
    const programPath = path.join(recipe.output_dir, 'complete-program-pcm.wav');
    await fs.writeFile(programPath, program.bytes, { flag: 'wx' });
    await writeJson(path.join(recipe.output_dir, 'program-audio-accounting.json'), program.report);
    const cardArtifacts = [];
    for (const card of cards) {
      const rendered = await renderMeasuredRepairCard(card), file = path.join(recipe.output_dir, `${card.scene}-${card.id}.png`);
      await fs.writeFile(file, rendered.bytes, { flag: 'wx' });
      cardArtifacts.push({ ...card, asset: await trueCrimeProofFileRef(file), measurements: rendered.measurements });
    }
    const graph = buildCardRepairFilter(cards), graphPath = path.join(recipe.output_dir, 'repair-filter.ffgraph');
    await fs.writeFile(graphPath, graph, { flag: 'wx' });
    const videoPath = path.join(recipe.output_dir, 'private-proof-layout-audio-v1.mp4');
    const args = ['-v', 'error', '-n', '-i', recipe.source_video.path, '-i', programPath];
    cardArtifacts.forEach((card) => args.push('-loop', '1', '-framerate', '30', '-i', card.asset.path));
    args.push('-filter_complex_script', graphPath, '-map', '[outv]', '-map', '1:a:0', '-frames:v', String(timeline.duration_frames), '-r', '30', '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', '-map_metadata', '-1', '-movflags', '+faststart', videoPath);
    await writeJson(path.join(recipe.output_dir, 'ffmpeg-command.json'), { executable: 'ffmpeg', args });
    const ffmpegVersion = (await execute('ffmpeg', ['-version'])).stdout.split('\n')[0];
    await run(args);
    const outputProbe = await probe(videoPath), video = outputProbe.streams.find((s) => s.codec_type === 'video'), audio = outputProbe.streams.find((s) => s.codec_type === 'audio');
    need(Number(video?.nb_read_frames) === timeline.duration_frames && video.width === 1920 && video.height === 1080 && video.r_frame_rate === '30/1' && Math.abs(Number(video.duration) - timeline.duration_sec) < 1 / 30, 'repaired video frame/duration check failed');
    need(audio?.codec_name === 'aac' && audio.sample_rate === '48000' && Math.abs(Number(audio.duration) - timeline.duration_sec) < 1 / 30, 'complete program audio duration check failed');
    const scenes = [cards[0], cards[2]], frames = [...new Set([0, scenes[0].first_frame - 1, ...scenes.map((s) => Math.floor((s.first_frame + s.last_frame) / 2)), scenes[1].last_frame + 1, timeline.duration_frames - 1])].sort((a, b) => a - b);
    const frameQa = await compareFrames(recipe.source_video.path, videoPath, cards, frames, recipe.output_dir);
    for (const key of bindings) await checked(recipe[key]);
    await checked(recipeRef); await checked(adapter); await checked(audioHelper); await checked(narrationStageRef);
    need((await loadTrueCrimeProofIdentity({ proofDir: recipe.proof_dir })).identity_sha256 === loaded.identity_sha256, 'identity changed during repair');
    const report = { schema: 'goldflow_true_crime_layout_audio_repair_report_v1', status: 'candidate_ready_needs_review', repair_technical_qa: 'passed', scope: recipe.scope,
      identity_sha256: loaded.identity_sha256, recipe: recipeRef, adapter, audio_helper: audioHelper, source_attempt: recipe.source_attempt, original_video_preserved: recipe.source_video, source_manifest: recipe.source_manifest, source_timeline: recipe.source_timeline, source_narration: recipe.source_narration,
      source_narration_stage: narrationStageRef, narration_technical_qa: narrationReceipt.metadata.technical_qa, narration_metadata: narrationReceipt.metadata,
      mastering: 'pending_delivery_review; retained source level unchanged', human_listening_performed: false,
      source_audio_packet_sha256: await audioPacketHash(recipe.source_video.path), output_audio_packet_sha256: await audioPacketHash(videoPath), audio_stream_copy: false,
      audio_method: 'Encode AAC once from complete reconstructed program PCM; no source speech synthesis, stretching or second mastering.', audio_accounting: program.report,
      output: await trueCrimeProofFileRef(videoPath), program_pcm: await trueCrimeProofFileRef(programPath), source_probe: sourceProbe, output_probe: outputProbe, cards: cardArtifacts, frame_qa: frameQa,
      video_method: 'Four card swept rectangles replaced only during S05/S06. Whole video reencoded once using libx264 CRF16; decoded pixels elsewhere differ only through reencoding/color conversion, measured by sampled masked PSNR.', ffmpeg_version: ffmpegVersion,
      provider_calls: 0, cost_usd: 0, creative_generation: false, production_eligible: false, publish_allowed: false, approval_recorded: false, full_program_listening_required: true };
    const reportPath = path.join(recipe.output_dir, 'repair-report.json'); await writeJson(reportPath, report);
    await event({ status: report.status, output: report.output, report: await trueCrimeProofFileRef(reportPath) });
    return { output: report.output, report: await trueCrimeProofFileRef(reportPath), frames: frameQa.map((q) => q.frame_artifact), review_required: true };
  } catch (error) { await event({ status: 'needs_triage', error: error.message, automatic_retry_allowed: false }); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await repairTrueCrimeProofLayout({ recipePath: process.argv[2] }), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
