import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { sha256File } from './file-hash.mjs';
import { resolveNarrationReport } from './narration-artifacts.mjs';
import { validatePanelExperimentTimeline } from './panel-experiment-contract.mjs';
import { validateNarrationSubjectiveReviewManifest, validateNarrationSubjectiveReviewDecision } from './narration-subjective-review.mjs';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const requireValue = (condition, message) => { if (!condition) throw new Error(`Original panel import: ${message}`); };
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const passed = value => ['passed', 'passed_with_warnings'].includes(value);
const resolveFile = (file, base) => {
  requireValue(nonempty(file) && !/^[a-z][a-z0-9+.-]*:/i.test(file), 'only explicit local source files are supported');
  return path.resolve(base, file);
};

async function newOutputDirectory(outputDir, episodeDir) {
  requireValue(path.isAbsolute(outputDir ?? ''), 'outputDir must be an absolute new directory');
  const output = path.resolve(outputDir);
  requireValue(!output.split(path.sep).includes('episodes'), 'output must stay outside episode directories');
  requireValue(output !== episodeDir && !output.startsWith(`${episodeDir}${path.sep}`), 'output cannot modify the original episode');
  requireValue(!await fs.lstat(output).then(() => true, () => false), 'output directory already exists; imports cannot overwrite retained attempts');
  let ancestor = path.dirname(output);
  while (!await fs.stat(ancestor).then(() => true, () => false)) ancestor = path.dirname(ancestor);
  const real = await fs.realpath(ancestor);
  const resolved = path.join(real, path.relative(ancestor, output));
  requireValue(!resolved.split(path.sep).includes('episodes') && resolved !== episodeDir && !resolved.startsWith(`${episodeDir}${path.sep}`), 'output resolves inside an episode directory');
  for (let at = real; ; at = path.dirname(at)) {
    requireValue(!await fs.stat(path.join(at, 'run_identity.json')).then(() => true, () => false), 'output is inside a recorded episode');
    if (at === path.dirname(at)) break;
  }
  return output;
}

/** Read-only import of a reviewed original episode into a separate editing experiment. */
export async function prepareOriginalPanelExperiment({ episodeDir, startSec, endSec, configPath, outputDir } = {}) {
  requireValue(nonempty(episodeDir) && nonempty(configPath), 'episodeDir and configPath must be explicit');
  requireValue(Number.isFinite(startSec) && startSec >= 0 && Number.isFinite(endSec) && endSec > startSec && endSec - startSec <= 1800, 'an explicit positive source window of at most 1800 seconds is required');
  const sourceDir = await fs.realpath(path.resolve(episodeDir));
  const output = await newOutputDirectory(outputDir, sourceDir);
  const sourceHashes = {};
  const bind = async (file, expected = null, base = sourceDir) => {
    const absolute = await fs.realpath(resolveFile(file, base));
    requireValue((await fs.stat(absolute)).isFile(), `source is not a file: ${absolute}`);
    const sha256 = await sha256File(absolute);
    if (expected !== null) requireValue(isHash(expected) && expected === sha256, `stale source hash: ${path.basename(absolute)}`);
    sourceHashes[absolute] = sha256;
    return { path: absolute, sha256 };
  };
  const read = async (file, expected = null, base = sourceDir) => {
    const ref = await bind(file, expected, base);
    return { ref, value: JSON.parse(await fs.readFile(ref.path, 'utf8')) };
  };
  const declaredSources = async artifact => {
    for (const [file, expected] of Object.entries(artifact.source_hashes ?? {})) await bind(file, expected);
  };
  const configArtifact = await read(path.resolve(configPath));
  const config = configArtifact.value;
  requireValue(config.schema === 'goldflow_original_panel_experiment_config_v1', 'unsupported original experiment config');
  for (const field of ['id', 'channel', 'series', 'episode', 'title']) requireValue(nonempty(config[field]), `config.${field} is required`);
  const run = await read('run_identity.json');
  requireValue(run.value.content_profile === 'manhwa_recap_v1', 'original source identity must explicitly select manhwa_recap_v1');
  requireValue(run.value.media_workflow === undefined || run.value.media_workflow === 'generated_visuals_v1', 'source is not a generated-visuals original episode');
  requireValue(config.channel === run.value.channel && config.episode === run.value.episode && config.series === (run.value.series_slug ?? run.value.series), 'config channel, series and episode must match the original identity');
  const script = await bind('script_clean.md');
  const approval = await read('operator_script_approval.json');
  const lock = await read('script_lock.json');
  requireValue(approval.value.operator_approved === true && (approval.value.script_clean_hash ?? approval.value.script_hash) === script.sha256, 'exact original script approval is missing or stale');
  requireValue((lock.value.script_clean_hash ?? lock.value.script_hash) === script.sha256, 'original script lock is stale');

  const narrationPath = resolveNarrationReport({ episodeDir: sourceDir, episode: config.episode, identity: run.value }).report_path;
  const narration = await read(narrationPath);
  requireValue(passed(narration.value.status) && narration.value.source_script_hash === script.sha256, 'canonical narration is not passed for the approved script');
  const audioValue = narration.value.output_path ?? narration.value.final_wav_path;
  const audioHash = narration.value.output_sha256 ?? narration.value.final_wav_sha256 ?? narration.value.output_hash;
  requireValue(isHash(audioHash), 'canonical narration must record its exact output hash');
  const audio = await bind(audioValue, audioHash);
  let narrationAcceptance = { mode: 'recorded_automated_acceptance', new_approval_created: false };
  if (run.value.narration_quality_contract?.subjective_review?.hash_bound_sampling_manifest_required === true) {
    const plan = await read(narration.value.narration_generation_plan_path, narration.value.narration_generation_plan_file_sha256);
    const planHash = plan.value.plan_sha256 ?? plan.ref.sha256;
    requireValue(narration.value.narration_generation_plan_sha256 === planHash, 'narration generation plan binding is stale');
    const waiver = narration.value.subjective_review_waiver;
    if (waiver) {
      requireValue(waiver.schema === 'goldflow_operator_narration_qa_waiver_v1' && waiver.status === 'skipped_with_waiver' && waiver.skip_subjective_review === true && waiver.human_listening_performed === false && nonempty(waiver.reason) && waiver.narration_generation_plan_sha256 === planHash && waiver.narration_generation_plan_file_sha256 === plan.ref.sha256 && waiver.narration_quality_contract_sha256 === run.value.narration_quality_contract.contract_sha256 && waiver.narration_audio_sha256 === audio.sha256, 'recorded narration listening waiver is stale or invalid');
      narrationAcceptance = { mode: 'original_hash_bound_waiver_retained', original_waiver: waiver, new_approval_created: false, listening_performed_by_importer: false };
    } else {
      const listening = await read(`narration_subjective_review_manifest_${config.episode}.json`);
      const decision = await read(`narration_subjective_review_decision_${config.episode}.json`);
      requireValue(validateNarrationSubjectiveReviewManifest(listening.value).status === 'passed' && listening.value.audio_sha256 === audio.sha256 && listening.value.narration_generation_plan_sha256 === planHash && listening.value.narration_generation_plan_file_sha256 === plan.ref.sha256 && listening.value.narration_quality_contract_sha256 === run.value.narration_quality_contract.contract_sha256, 'recorded narration listening manifest is stale or invalid');
      requireValue(validateNarrationSubjectiveReviewDecision(listening.value, decision.value).status === 'approved', 'recorded narration listening decision is not approved');
      narrationAcceptance = { mode: 'original_hash_bound_listening_decision_retained', manifest: listening.ref, decision: decision.ref, new_approval_created: false, listening_performed_by_importer: false };
    }
  }
  const timing = await read(`narration_word_timing_${config.episode}.json`);
  requireValue(timing.value.status === 'passed' && timing.value.source_script_hash === script.sha256 && timing.value.narration_audio_hash === audio.sha256, 'official word timing is missing, failed, or bound to another script/audio');
  requireValue(timing.value.narration_report_sha256 === narration.ref.sha256 && timing.value.run_identity_sha256 === run.ref.sha256, 'word timing narration report or identity binding is stale');
  requireValue(timing.value.word_timing_qa?.status === 'passed' && timing.value.full_stream_transcript_qa?.status === 'passed', 'official word timing QA is not passed');
  await bind(timing.value.narration_audio_path, audio.sha256);
  await declaredSources(timing.value);
  if (narration.value.full_stream_qa_path) {
    const fullQa = await read(narration.value.full_stream_qa_path);
    requireValue(passed(fullQa.value.status) && fullQa.value.source_script_hash === script.sha256 && !(fullQa.value.blockers ?? []).length, 'narration full-stream QA is blocked or stale');
    requireValue(fullQa.value.audio_sha256 === audio.sha256, 'narration full-stream QA audio hash is stale');
  }
  if (run.value.narration_quality_contract) {
    const finalQa = await read(`narration_final_delivery_qa_${config.episode}.json`);
    requireValue(finalQa.value.status === 'passed' && finalQa.value.source_script_hash === script.sha256 && finalQa.value.narration_audio_hash === audio.sha256 && !(finalQa.value.blockers ?? []).length, 'final narration delivery QA is missing, blocked or stale');
    requireValue(finalQa.value.quality_contract_sha256 === run.value.narration_quality_contract.contract_sha256, 'final narration QA contract differs from the original identity');
  }
  const probe = JSON.parse((await exec(process.env.ANIFACTORY_FFPROBE_BIN || 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'wav,flac,mp3,ogg,mov,aac', '-show_streams', '-show_format', '-of', 'json', audio.path], { maxBuffer: 2 * 1024 * 1024, timeout: 30000 })).stdout);
  const audioStream = probe.streams?.find(row => row.codec_type === 'audio');
  const sourceDuration = Number(audioStream?.duration ?? probe.format?.duration);
  requireValue(audioStream && Number.isFinite(sourceDuration) && endSec <= sourceDuration + 1e-7, 'requested source window exceeds actual canonical narration');

  const beatPlan = await read('visual_beat_plan.json');
  const beatApproval = await read('visual_beat_approval.json');
  requireValue(beatPlan.value.status === 'passed' && beatPlan.value.source_script_hash === script.sha256 && beatPlan.value.word_timing_audio_hash === audio.sha256, 'beat plan is not passed for the current script and audio');
  requireValue(beatApproval.value.status === 'approved' && beatApproval.value.visual_beat_plan_sha256 === beatPlan.ref.sha256, 'approved beat grouping is stale or absent');
  requireValue(nonempty(beatPlan.value.editorial_director?.grouping_lock_sha256) && beatApproval.value.grouping_lock_sha256 === beatPlan.value.editorial_director.grouping_lock_sha256, 'beat grouping lock differs from its approval');
  await declaredSources(beatPlan.value);
  const words = timing.value.words;
  requireValue(Array.isArray(words) && words.length > 0 && timing.value.word_count === words.length, 'official word timing must contain its declared words');
  let priorStart = -Infinity;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    requireValue(word.index === index && nonempty(word.word) && Number.isFinite(word.start_sec) && Number.isFinite(word.end_sec) && word.start_sec >= priorStart && word.end_sec >= word.start_sec && word.start_sec >= 0 && word.end_sec <= sourceDuration + 0.1, 'word rows must retain ordered original indices and valid timing');
    priorStart = word.start_sec;
  }
  const allBeats = beatPlan.value.beats;
  requireValue(Array.isArray(allBeats) && allBeats.length > 0, 'approved beat plan is empty');
  let previousEnd = 0, nextWord = 0;
  const beatIds = new Set();
  for (const beat of allBeats) {
    requireValue(nonempty(beat.visual_beat_id) && !beatIds.has(beat.visual_beat_id), 'beat IDs must be unique'); beatIds.add(beat.visual_beat_id);
    requireValue(Number.isFinite(beat.start_sec) && Number.isFinite(beat.end_sec) && beat.end_sec > beat.start_sec && Math.abs(beat.start_sec - previousEnd) < 1e-5, 'approved visual beats must retain contiguous timeline coverage');
    requireValue(beat.source_word_start_index === nextWord && Number.isInteger(beat.source_word_end_index) && beat.source_word_end_index >= nextWord && beat.source_word_end_index < words.length, 'approved beat word spans have a gap, overlap or invalid range');
    previousEnd = beat.end_sec; nextWord = beat.source_word_end_index + 1;
  }
  requireValue(nextWord === words.length && previousEnd >= endSec - 1e-7, 'approved beats do not cover the complete source words or requested window');
  const selectedBeats = allBeats.filter(beat => beat.start_sec < endSec && beat.end_sec > startSec);
  const scopedWords = words.filter(word => word.start_sec === word.end_sec ? word.start_sec >= startSec && word.start_sec < endSec : word.start_sec < endSec && word.end_sec > startSec).map(word => ({ ...word, source_index: word.index, source_start_sec: word.start_sec, source_end_sec: word.end_sec, start_sec: Math.max(startSec, word.start_sec) - startSec, end_sec: Math.min(endSec, word.end_sec) - startSec }));
  requireValue(scopedWords.length > 0, 'source window contains no timed narration words');
  for (const word of scopedWords) requireValue(selectedBeats.some(beat => word.source_index >= beat.source_word_start_index && word.source_index <= beat.source_word_end_index), 'selected beat grouping does not cover the requested narration');

  const images = await read(`imagegen_report_${config.episode}.json`);
  const qa = await read(`image_output_qa_${config.episode}.json`);
  requireValue(qa.value.status === 'passed' && !(qa.value.unresolved_blocker_count > 0), 'source image QA is not passed');
  requireValue(qa.value.imagegen_report_sha256 === images.ref.sha256, 'image QA is stale for current generated assets');
  const decisions = await read(qa.value.review_decisions_path ?? `image_output_review_decisions_${config.episode}.json`, qa.value.review_decisions_sha256);
  requireValue(decisions.value.status === 'complete', 'image review decisions are incomplete');
  if (qa.value.prompt_plan_path) await bind(qa.value.prompt_plan_path, qa.value.prompt_plan_sha256);
  await declaredSources(qa.value);
  const imageRows = new Map();
  for (const row of images.value.results ?? []) { requireValue(!imageRows.has(row.image_id), 'generated image IDs are duplicated'); imageRows.set(row.image_id, row); }
  const assets = [], panels = [], scenes = [], importedBeats = [];
  const duration = endSec - startSec;
  for (const beat of selectedBeats) {
    const imageId = beat.image_id_hint;
    const row = imageRows.get(imageId);
    requireValue(row && row.status !== 'failed' && nonempty(row.image_path), `generated image missing for ${beat.visual_beat_id}`);
    const acceptedHash = qa.value.accepted_image_hashes?.[imageId];
    requireValue(isHash(acceptedHash), `no accepted image hash for ${imageId}`);
    requireValue(!(qa.value.critical_rejected_image_ids ?? []).includes(imageId) && !(qa.value.not_inspected_image_ids ?? []).includes(imageId), `image ${imageId} has unresolved review`);
    const decision = (decisions.value.decisions ?? []).find(item => item.image_id === imageId);
    if (decision) requireValue(decision.image_sha256 === acceptedHash && !['not_inspected', 'critical_rejected'].includes(decision.decision), `image ${imageId} review is stale or unresolved`);
    const raster = await bind(row.image_path, acceptedHash);
    const reportedHash = row.generated?.output_sha256 ?? row.generated?.manual_source_sha256;
    if (reportedHash) requireValue(reportedHash === acceptedHash, `generation and QA disagree for ${imageId}`);
    const metadata = await sharp(raster.path, { limitInputPixels: 100_000_000 }).metadata();
    requireValue(['png', 'jpeg', 'webp'].includes(metadata.format) && (!metadata.pages || metadata.pages === 1), `image ${imageId} is not one static raster`);
    const panelId = `panel_${beat.visual_beat_id}`;
    const start = Math.max(startSec, beat.start_sec) - startSec, end = Math.min(endSec, beat.end_sec) - startSec;
    const imported = { ...beat, source_start_sec: beat.start_sec, source_end_sec: beat.end_sec, start_sec: start, end_sec: end, duration_sec: end - start, source_image_id: imageId, source_raster: raster, source_window_clipped: startSec > beat.start_sec || endSec < beat.end_sec };
    importedBeats.push(imported);
    assets.push({ id: imageId, ...raster, origin: 'original_generated', provenance: `Original generated image ${imageId}, accepted by ${qa.ref.path}; source hash ${qa.ref.sha256}.` });
    panels.push({ id: panelId, asset_id: imageId, source_rect: { x: 0, y: 0, width: 1, height: 1 }, metadata: { source_beat_id: beat.visual_beat_id, source_word_start_index: beat.source_word_start_index, source_word_end_index: beat.source_word_end_index, narration_excerpt: beat.visual_beat_script_excerpt ?? '', source_script: script, source_image_id: imageId, format: 'existing_original_scene_artwork', control: 'full_source_static' } });
    const state = { rect: { x: 0, y: 0, width: 1, height: 1 }, camera: { x: 0.5, y: 0.5, zoom: 1 }, opacity: 1, easing: 'hold' };
    scenes.push({ id: beat.visual_beat_id, start_sec: start, end_sec: end, background: { panel_id: panelId, blur_px: 0, brightness: 0 }, layers: [{ id: `control_${beat.visual_beat_id}`, panel_id: panelId, start_sec: start, end_sec: end, z: 0, fit: 'contain', border_px: 0, keyframes: [{ at_sec: start, ...state }, { at_sec: end, ...state }] }] });
  }
  const timestamp = new Date().toISOString();
  const packetPath = path.join(output, 'original_source_packet.json');
  const identityPath = path.join(output, 'experiment_identity.json');
  const baselinePath = path.join(output, 'baseline.json');
  const compositionPath = path.join(output, 'composition_packet.json');
  const packet = { schema: 'goldflow_original_panel_source_packet_v1', status: 'prepared', source_mode: 'original_story', source_episode_dir: sourceDir, source_identity: run.ref, source_script: script, script_approval: approval.ref, script_lock: lock.ref, narration_report: narration.ref, narration: audio, narration_acceptance: narrationAcceptance, word_timing: timing.ref, beat_plan: beatPlan.ref, beat_approval: beatApproval.ref, image_report: images.ref, image_qa: qa.ref, image_review_decisions: decisions.ref, source_window: { start_sec: startSec, end_sec: endSec }, source_duration_sec: sourceDuration, source_hashes: sourceHashes, words: scopedWords, beats: importedBeats, approved_script_text_reconstructed: false, source_episode_modified: false, provider_calls: 0, created_at: timestamp };
  const packetBytes = json(packet);
  const identity = { schema: 'goldflow_panel_experiment_identity_v1', id: config.id, channel: config.channel, series: config.series, episode: config.episode, title: config.title, content_profile: 'manhwa_recap_v1', source_mode: 'original_story', visibility: 'private_review', provider_policy: 'local_artifacts_only', scope: { max_duration_sec: 1800, source_start_sec: startSec, source_end_sec: endSec }, source: { path: packetPath, sha256: hash(packetBytes) }, created_at: timestamp };
  const identityBytes = json(identity);
  const baseline = { schema: 'goldflow_panel_experiment_timeline_v1', id: config.id, intent: 'editing_experiment', content_profile: 'manhwa_recap_v1', experiment_identity: { path: identityPath, sha256: hash(identityBytes) }, width: config.width, height: config.height, fps: config.fps, duration_sec: duration, audio_target: 'narrator_only', audio: { ...audio, offset_sec: startSec }, assets, panels, scenes, provenance: { label: 'Static full-source control edit; no authored panel treatments added', source_packet: { path: packetPath, sha256: hash(packetBytes) }, source_episode_modified: false, composition_role: 'control' } };
  validatePanelExperimentTimeline(baseline);
  const composition = { schema: 'goldflow_panel_composition_packet_v1', status: 'needs_authored_composition', experiment_identity: baseline.experiment_identity, source_packet: identity.source, baseline_path: baselinePath, narration: baseline.audio, duration_sec: duration, canvas: { width: config.width, height: config.height, fps: config.fps }, panels, beats: importedBeats, words: scopedWords, authoring_boundary: 'An editor must author beat-to-panel bindings, crops, positions, reveal times and camera keys. Supplied intent is evidence, not an automatic transition recipe. Keep source/caption text and audio unchanged.', provider_calls: 0 };
  // All source validation completes before any output mutation. Recheck immediately
  // before publishing the new packet so an in-flight production update cannot mix hashes.
  for (const [file, expected] of Object.entries(sourceHashes)) requireValue(await sha256File(file) === expected, `source changed while preparing import: ${path.basename(file)}`);
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(output);
  for (const [file, bytes] of [[packetPath, packetBytes], [identityPath, identityBytes], [baselinePath, json(baseline)], [compositionPath, json(composition)]]) await fs.writeFile(file, bytes, { flag: 'wx' });
  const manifest = { schema: 'goldflow_original_panel_import_report_v1', status: 'prepared', id: config.id, output_dir: output, identity_path: identityPath, source_packet_path: packetPath, baseline_path: baselinePath, composition_packet_path: compositionPath, duration_sec: duration, beat_count: importedBeats.length, word_count: scopedWords.length, source_hashes: sourceHashes, output_hashes: { [packetPath]: hash(packetBytes), [identityPath]: hash(identityBytes), [baselinePath]: hash(json(baseline)), [compositionPath]: hash(json(composition)) }, implementation_sha256: await sha256File(new URL(import.meta.url)), production_eligible: false, publishing_allowed: false, provider_calls: 0, cost_usd: 0, created_at: timestamp };
  await fs.writeFile(path.join(output, 'import_report.json'), json(manifest), { flag: 'wx' });
  await fs.writeFile(path.join(output, 'execution_events.jsonl'), `${JSON.stringify({ event: 'original_source_import_prepared', at: timestamp, source_hashes: sourceHashes, output_hashes: manifest.output_hashes, provider_calls: 0 })}\n`, { flag: 'wx' });
  return manifest;
}
