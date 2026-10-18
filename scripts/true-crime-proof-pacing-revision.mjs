import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { loadTrueCrimeProofIdentity, trueCrimeProofStatus, trueCrimeProofFileRef } from './lib/true-crime-proof-workflow.mjs';
import { buildProgramPcm } from './lib/true-crime-proof-program-audio-repair.mjs';

const execute = promisify(execFile), RATE = 24000, FPS = 30, SAMPLES_PER_FRAME = RATE / FPS;
const HOLDS = [0, 0, 0, .35, 0, 0, .50];
const FEEDBACK = 'why is it o slow between narrations. too much silence. we need to cut those down.';
const need = (ok, message) => { if (!ok) throw new Error(`True-crime pacing revision: ${message}`); };
const sameRef = (a, b) => a?.path === b?.path && a?.sha256 === b?.sha256;
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const exactSamples = (seconds) => {
  need(Number.isFinite(seconds) && seconds >= 0 && Math.abs(seconds * RATE - Math.round(seconds * RATE)) < 1e-5, 'timeline time must be a nonnegative exact 24 kHz sample');
  return Math.round(seconds * RATE);
};
async function checked(ref) {
  need(path.isAbsolute(ref?.path ?? '') && /^[a-f0-9]{64}$/u.test(ref?.sha256 ?? ''), 'absolute file/hash binding required');
  need(sameRef(await trueCrimeProofFileRef(ref.path), ref), `bound input changed: ${path.basename(ref.path)}`);
  return fs.readFile(ref.path);
}
async function probe(file) {
  return JSON.parse((await execute('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file], { maxBuffer: 2 * 1024 * 1024 })).stdout);
}

/** Pure seven-scene mapping. Retain each scene's leading frames and cut only its
 * post-narration hold. Complete source PCM intervals include existing paragraph gaps. */
export function planPacingRevision({ timeline, sceneHolds } = {}) {
  need(timeline?.schema === 'goldflow_true_crime_proof_timeline_v1' && timeline.width === 1920 && timeline.height === 1080 && timeline.fps === FPS && timeline.narration_tempo === 1, 'retained 1080p/30 timeline and unchanged tempo required');
  need(timeline.scenes?.length === 7 && sceneHolds?.length === 7, 'exactly seven ordered scenes required');
  need(Number.isSafeInteger(timeline.duration_frames) && timeline.duration_frames > 0 && timeline.duration_frames <= 4500 && Math.abs(timeline.duration_sec * FPS - timeline.duration_frames) < 1e-7, 'retained frame count/duration differs');
  const clips = [], scenes = []; let outputFrame = 0, sourceSample = 0, inputFrame = 0, requestedSamples = 0, roundingSamples = 0;
  for (let i = 0; i < 7; i++) {
    const scene = timeline.scenes[i], hold = sceneHolds[i], id = `S0${i + 1}`;
    need(scene.id === id && hold?.scene_id === id && Object.keys(hold).every((k) => ['scene_id', 'hold_after_sec'].includes(k)) && hold.hold_after_sec === HOLDS[i], 'only the exact selected S01–S07 holds [0,0,0,0.35,0,0,0.50] are allowed');
    need((scene.hold_before_sec ?? 0) === 0 && scene.narration_start_sec === scene.start_sec && scene.hold_after_sec >= hold.hold_after_sec, 'cannot trim before speech or add a longer hold');
    const sourceStart = exactSamples(scene.source_in_sec), sourceEnd = exactSamples(scene.source_out_sec);
    need(sourceStart === sourceSample && sourceEnd > sourceStart, 'source narration slices must be contiguous and nonempty');
    const length = sourceEnd - sourceStart, requested = exactSamples(hold.hold_after_sec);
    const sourceFirst = Math.max(0, Math.ceil((scene.start_sec - 1e-8) * FPS));
    const sourceLimit = i === 6 ? timeline.duration_frames : Math.ceil((scene.end_sec - 1e-8) * FPS);
    need(sourceFirst === inputFrame && sourceLimit > sourceFirst, 'original scene frame windows must cover the video in order');
    need(exactSamples(scene.end_sec) - exactSamples(scene.start_sec) === length + exactSamples(scene.hold_after_sec), 'original scene source and hold durations disagree');
    const frames = Math.ceil((length + requested) / SAMPLES_PER_FRAME), added = frames * SAMPLES_PER_FRAME - length;
    need(frames > 0 && sourceFirst + frames <= sourceLimit, 'requested trim extends beyond the retained scene');
    // Ceil rounding retains the complete source interval; no frame representing
    // its narration can be removed. New audio starts at this retained clip boundary.
    const duration = frames / FPS, at = outputFrame / FPS;
    clips.push({ scene_id: id, source_start_frame: sourceFirst, source_end_frame_exclusive: sourceFirst + frames,
      source_scene_end_frame_exclusive: sourceLimit, removed_start_frame: sourceFirst + frames, removed_end_frame_exclusive: sourceLimit,
      output_start_frame: outputFrame, output_end_frame_exclusive: outputFrame + frames, frame_count: frames,
      source_start_sample: sourceStart, source_end_sample: sourceEnd, output_start_sample: outputFrame * SAMPLES_PER_FRAME,
      source_picture_phase_offset_sec: sourceFirst / FPS - scene.start_sec,
      requested_hold_after_sec: hold.hold_after_sec, actual_hold_after_sec: added / RATE,
      per_scene_frame_rounding_sec: (added - requested) / RATE });
    scenes.push({ id, narration_unit_ids: [...scene.narration_unit_ids], source_in_sec: scene.source_in_sec, source_out_sec: scene.source_out_sec,
      start_sec: at, end_sec: (outputFrame + frames) / FPS, narration_start_sec: at, duration_sec: duration,
      hold_before_sec: 0, hold_after_sec: added / RATE });
    outputFrame += frames; sourceSample = sourceEnd; inputFrame = sourceLimit; requestedSamples += requested; roundingSamples += added - requested;
  }
  need(sourceSample === exactSamples(timeline.source_duration_sec) && inputFrame === timeline.duration_frames, 'complete source/video scene coverage required');
  need(outputFrame < timeline.duration_frames && clips.every((c) => c.source_picture_phase_offset_sec >= -1e-8 && c.source_picture_phase_offset_sec < 1 / FPS + 1e-8), 'revision must shorten holds with at most one frame of source picture phase offset');
  const revised = { schema: 'goldflow_true_crime_proof_timeline_v1', width: 1920, height: 1080, fps: FPS, narration_tempo: 1,
    duration_frames: outputFrame, duration_sec: outputFrame / FPS, source_duration_sec: timeline.source_duration_sec,
    authored_duration_sec: outputFrame / FPS, authored_holds_sec: (outputFrame * SAMPLES_PER_FRAME - sourceSample) / RATE,
    rounding_silence_sec: 0, scenes };
  return { schema: 'goldflow_true_crime_pacing_mapping_v1', clips, revised_timeline: revised,
    removed_frames: timeline.duration_frames - outputFrame, removed_sec: (timeline.duration_frames - outputFrame) / FPS,
    requested_holds_sec: requestedSamples / RATE, per_scene_frame_rounding_sec: roundingSamples / RATE,
    existing_source_silence_preserved: true, source_picture_phase_offset_bound_sec: 1 / FPS };
}

export function buildPacingVideoFilter(mapping) {
  const ranges = mapping.clips.map((clip) => `between(n,${clip.source_start_frame},${clip.source_end_frame_exclusive - 1})`).join('+');
  return `[0:v]select='${ranges}',setpts=N/(${FPS}*TB)[outv]`;
}

async function compareRetainedFrames(source, output, mapping, outputDir) {
  const pairs = mapping.clips.flatMap((c) => [{ source_frame: c.source_start_frame, output_frame: c.output_start_frame },
    { source_frame: c.source_end_frame_exclusive - 1, output_frame: c.output_end_frame_exclusive - 1 }]);
  const stride = 1920 * 1080 * 3;
  const decode = async (file, frames) => (await execute('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select='${frames.map((f) => `eq(n,${f})`).join('+')}'`, '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: (frames.length + 1) * stride, timeout: 180000 })).stdout;
  const before = await decode(source, pairs.map((p) => p.source_frame)), after = await decode(output, pairs.map((p) => p.output_frame));
  need(before.length === stride * pairs.length && after.length === before.length, 'mapped QA frame count differs');
  const rows = [];
  for (let i = 0; i < pairs.length; i++) {
    let squared = 0;
    for (let k = i * stride; k < (i + 1) * stride; k++) { const difference = after[k] - before[k]; squared += difference * difference; }
    const psnr = squared ? 10 * Math.log10(255 ** 2 / (squared / stride)) : Infinity;
    need(psnr >= 38, `retained picture differs beyond reencoding tolerance at output frame ${pairs[i].output_frame}`);
    const file = path.join(outputDir, `qa-frame-${String(pairs[i].output_frame).padStart(5, '0')}.png`);
    await sharp(after.subarray(i * stride, (i + 1) * stride), { raw: { width: 1920, height: 1080, channels: 3 } }).png().toFile(file);
    rows.push({ ...pairs[i], psnr_db: Number.isFinite(psnr) ? psnr : 'infinity', artifact: await trueCrimeProofFileRef(file) });
  }
  return rows;
}

/** One append-only supplemental revision under the user's latest pacing instruction.
 * This does not alter the frozen 90–150-second identity or complete its failed stage. */
export async function reviseTrueCrimeProofPacing({ recipePath } = {}) {
  need(path.isAbsolute(recipePath ?? ''), 'absolute request path required');
  const recipeRef = await trueCrimeProofFileRef(recipePath), recipe = JSON.parse(await checked(recipeRef));
  const fields = ['schema', 'proof_dir', 'output_dir', 'scope', 'production_eligible', 'creative_generation', 'source_video', 'source_narration', 'source_timeline', 'source_repair_report', 'source_repair_index', 'scene_holds', 'authorization'];
  need(Object.keys(recipe).every((key) => fields.includes(key)) && recipe.schema === 'goldflow_true_crime_pacing_revision_recipe_v1' && recipe.scope === 'shorten_post_narration_holds_only' && recipe.production_eligible === false && recipe.creative_generation === false, 'exact private hold-trimming scope required');
  const auth = recipe.authorization;
  need(auth?.operator === 'Joel' && auth.user_feedback === FEEDBACK && auth.duration_change_authorized === true && Number.isFinite(Date.parse(auth.authorized_at)) && typeof auth.note === 'string' && auth.note.trim(), 'exact latest user feedback and duration-change authorization required');
  need(Object.keys(auth).every((k) => ['operator', 'user_feedback', 'duration_change_authorized', 'authorized_at', 'note'].includes(k)), 'unsupported authorization fields');
  need(path.isAbsolute(recipe.proof_dir ?? '') && await fs.realpath(recipe.proof_dir) === recipe.proof_dir, 'canonical existing proof directory required');
  need(recipe.output_dir === path.join(recipe.proof_dir, 'program_review_repairs/pacing-v2'), 'exact new pacing-v2 output directory required');
  const loaded = await loadTrueCrimeProofIdentity({ proofDir: recipe.proof_dir }), status = await trueCrimeProofStatus({ proofDir: recipe.proof_dir });
  need(status.state === 'needs_triage' && status.stages.find((s) => s.stage === 'program_review')?.state === 'needs_triage' && status.stages.slice(0, 2).every((s) => s.artifact), 'canonical closed failed stage and retained upstream candidates required');
  need(!(await fs.lstat(path.join(recipe.proof_dir, 'operation.lock')).catch((e) => { if (e.code === 'ENOENT') return null; throw e; })), 'a canonical operation is still open');
  const repairDir = path.join(recipe.proof_dir, 'program_review_repairs/card-layout-audio-v1');
  need(recipe.source_video?.path === path.join(repairDir, 'private-proof-layout-audio-v1.mp4') && recipe.source_repair_report?.path === path.join(repairDir, 'repair-report.json') && recipe.source_repair_index?.path === path.join(recipe.proof_dir, 'recovered-candidate-index-v1.json'), 'exact previously corrected candidate/report/index required');
  const keys = ['source_video', 'source_narration', 'source_timeline', 'source_repair_report', 'source_repair_index'];
  const bytes = Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await checked(recipe[key])])));
  const timeline = JSON.parse(bytes.source_timeline), repair = JSON.parse(bytes.source_repair_report), index = JSON.parse(bytes.source_repair_index);
  need(repair.schema === 'goldflow_true_crime_layout_audio_repair_report_v1' && repair.repair_technical_qa === 'passed' && repair.identity_sha256 === loaded.identity_sha256 && repair.production_eligible === false && sameRef(repair.output, recipe.source_video) && sameRef(repair.source_narration, recipe.source_narration) && sameRef(repair.source_timeline, recipe.source_timeline), 'corrected candidate lineage differs');
  need(index.schema === 'goldflow_true_crime_recovered_candidate_index_v1' && index.identity_sha256 === loaded.identity_sha256 && index.proof_dir === recipe.proof_dir && index.base_workflow_state === 'needs_triage' && index.production_eligible === false && index.approved === false && sameRef(index.candidate_video, recipe.source_video) && sameRef(index.repair_report, recipe.source_repair_report), 'retained supplemental index differs');
  for (const ref of [index.failed_attempt, index.triage, index.candidate_program_pcm, index.visual_review, index.independent_audio_verification, index.narration_stage]) await checked(ref);
  const narrationRef = await trueCrimeProofFileRef(path.join(recipe.proof_dir, 'narration.json'));
  const narration = JSON.parse(await checked(narrationRef));
  need(sameRef(narrationRef, repair.source_narration_stage) && sameRef(narrationRef, index.narration_stage) && narration.artifacts.some((a) => a.kind === 'narration_audio' && sameRef(a, recipe.source_narration)), 'whole original narrator source is not the retained candidate');
  const mapping = planPacingRevision({ timeline, sceneHolds: recipe.scene_holds }), revised = mapping.revised_timeline;
  need(timeline.duration_frames === 2802 && timeline.duration_sec === 93.4 && revised.duration_frames === 1932 && revised.duration_sec === 64.4, 'exact 93.4s→64.4s pacing revision required');
  const sourceProbe = await probe(recipe.source_video.path), sourceVideo = sourceProbe.streams.find((s) => s.codec_type === 'video'), sourceAudio = sourceProbe.streams.find((s) => s.codec_type === 'audio');
  need(Number(sourceVideo?.nb_read_frames) === 2802 && sourceVideo.width === 1920 && sourceVideo.height === 1080 && sourceVideo.r_frame_rate === '30/1' && Math.abs(Number(sourceVideo.duration) - 93.4) < .01 && Math.abs(Number(sourceAudio?.duration) - 93.4) < 1 / FPS, 'complete corrected source video/audio required');
  const program = buildProgramPcm({ sourceWavBytes: bytes.source_narration, timeline: revised });
  const code = await Promise.all([fileURLToPath(import.meta.url), fileURLToPath(new URL('./lib/true-crime-proof-program-audio-repair.mjs', import.meta.url))].map(trueCrimeProofFileRef));
  const parent = path.dirname(recipe.output_dir); need(await fs.realpath(parent) === parent, 'repair parent may not be a symlink');
  await fs.mkdir(recipe.output_dir, { recursive: false });
  const eventPath = path.join(recipe.output_dir, 'events.jsonl'), event = (row) => fs.appendFile(eventPath, `${JSON.stringify({ recorded_at: new Date().toISOString(), ...row })}\n`);
  const scopeException = { frozen_identity_min_duration_sec: loaded.identity.proof_scope.min_duration_sec, revised_duration_sec: revised.duration_sec,
    applies_to: 'this supplemental private pacing revision only', basis: 'latest explicit user instruction supersedes the earlier proof duration target', authorization: auth, frozen_identity_changed: false };
  await writeJson(path.join(recipe.output_dir, 'request.json'), { ...recipe, original_request: recipeRef, identity_sha256: loaded.identity_sha256, code, duration_scope_exception: scopeException });
  await event({ status: 'started', scope: recipe.scope, identity_sha256: loaded.identity_sha256, provider_calls: 0, cost_usd: 0 });
  try {
    const wavPath = path.join(recipe.output_dir, 'program-pcm.wav'); await fs.writeFile(wavPath, program.bytes, { flag: 'wx' });
    await writeJson(path.join(recipe.output_dir, 'timing-mapping.json'), mapping);
    await writeJson(path.join(recipe.output_dir, 'program-audio-accounting.json'), program.report);
    const graphPath = path.join(recipe.output_dir, 'pacing-filter.ffgraph'); await fs.writeFile(graphPath, buildPacingVideoFilter(mapping), { flag: 'wx' });
    const outputPath = path.join(recipe.output_dir, 'private-proof-pacing-v2.mp4');
    const args = ['-v', 'error', '-n', '-i', recipe.source_video.path, '-i', wavPath, '-filter_complex_script', graphPath,
      '-map', '[outv]', '-map', '1:a:0', '-frames:v', String(revised.duration_frames), '-fps_mode', 'cfr', '-r', '30',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', '-map_metadata', '-1', '-movflags', '+faststart', outputPath];
    await writeJson(path.join(recipe.output_dir, 'ffmpeg-command.json'), { executable: 'ffmpeg', args });
    await execute('ffmpeg', args, { maxBuffer: 3 * 1024 * 1024, timeout: 15 * 60 * 1000 });
    const outputProbe = await probe(outputPath), video = outputProbe.streams.find((s) => s.codec_type === 'video'), audio = outputProbe.streams.find((s) => s.codec_type === 'audio');
    need(Number(video?.nb_read_frames) === revised.duration_frames && video.width === 1920 && video.height === 1080 && video.r_frame_rate === '30/1' && Math.abs(Number(video.duration) - revised.duration_sec) < .01, 'revised video frame/duration mismatch');
    need(audio?.codec_name === 'aac' && audio.sample_rate === '48000' && Math.abs(Number(audio.duration) - revised.duration_sec) < 1 / FPS, 'revised audio duration mismatch');
    const frameQa = await compareRetainedFrames(recipe.source_video.path, outputPath, mapping, recipe.output_dir);
    for (const key of keys) await checked(recipe[key]);
    for (const ref of [...code, recipeRef, narrationRef]) await checked(ref);
    need((await loadTrueCrimeProofIdentity({ proofDir: recipe.proof_dir })).identity_sha256 === loaded.identity_sha256 && (await trueCrimeProofStatus({ proofDir: recipe.proof_dir })).state === status.state, 'canonical identity/state changed during pacing revision');
    const report = { schema: 'goldflow_true_crime_pacing_revision_report_v1', status: 'candidate_ready_needs_review', pacing_technical_qa: 'passed',
      identity_sha256: loaded.identity_sha256, canonical_workflow_state: status.state, duration_scope_exception: scopeException, request: recipeRef, code,
      source_video: recipe.source_video, source_timeline: recipe.source_timeline, source_narration: recipe.source_narration,
      source_repair_report: recipe.source_repair_report, source_repair_index: recipe.source_repair_index, source_narration_stage: narrationRef,
      narration_technical_qa: narration.metadata.technical_qa, narration_metadata: narration.metadata, mastering: 'pending_delivery_review; retained source level unchanged',
      audio_method: 'Every original source PCM sample copied once in order into integer-frame clip placements; only additional post-unit holds shortened. AAC encoded once from this PCM.',
      video_method: 'Seven retained leading scene frame ranges concatenated without speed change. All retained picture content preserved; video reencoded once at CRF16 and mapped scene boundary frames compared by PSNR.',
      mapping, audio_accounting: program.report, frame_qa: frameQa, source_probe: sourceProbe, output_probe: outputProbe,
      output: await trueCrimeProofFileRef(outputPath), program_pcm: await trueCrimeProofFileRef(wavPath),
      original_candidates_preserved: true, source_assets_changed: false, script_changed: false, voice_changed: false, narration_tempo: 1,
      provider_calls: 0, cost_usd: 0, creative_generation: false, production_eligible: false, publish_allowed: false, human_listening_performed: false, full_program_viewing_approved: false, approved: false };
    const reportPath = path.join(recipe.output_dir, 'pacing-report.json'); await writeJson(reportPath, report);
    await event({ status: report.status, output: report.output, report: await trueCrimeProofFileRef(reportPath) });
    return { output: report.output, report: await trueCrimeProofFileRef(reportPath), duration_sec: revised.duration_sec, frames: frameQa.map((q) => q.artifact), review_required: true };
  } catch (error) { await event({ status: 'needs_triage', error: error.message, automatic_retry_allowed: false }); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await reviseTrueCrimeProofPacing({ recipePath: process.argv[2] }), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
