import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { sha256File } from './file-hash.mjs';
import { resolveNarrationReport } from './narration-artifacts.mjs';
import { assertPanelProductionIdentity } from './panel-production-policy.mjs';
import { verifyPanelProductionTimingIdentity } from './panel-production-carryforward.mjs';
import { loadPanelAssetPlan, assertPanelPromptAllocation } from './panel-production-assets.mjs';
import { compilePanelComposition } from './panel-composition-authoring.mjs';
import { validatePanelTimeline } from './panel-layout-validation.mjs';
import { loadPanelAudioRevision } from './panel-audio-revision.mjs';

const exec = promisify(execFile);
const fail = message => { throw new Error(`Panel production plan: ${message}`); };
const need = (value, message) => { if (!value) fail(message); };
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const hashValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const full = { x: 0, y: 0, width: 1, height: 1 };
const camera = { x: 0.5, y: 0.5, zoom: 1 };
const passed = value => ['passed', 'passed_with_warnings'].includes(value);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

export function panelProductionPaths(episodeDir, episode) {
  return {
    planPath: path.join(episodeDir, `panel_composition_plan_${episode}.json`),
    timelinePath: path.join(episodeDir, `panel_timeline_${episode}.json`),
    packetPath: path.join(episodeDir, `panel_composition_packet_${episode}.json`),
    recipePath: path.join(episodeDir, `panel_composition_recipe_${episode}.json`),
  };
}

async function currentHashes(hashes) {
  need(hashes && Object.keys(hashes).length > 0, 'source hashes are required');
  for (const [file, expected] of Object.entries(hashes)) {
    need(path.isAbsolute(file) && hashValue(expected), 'source hash entry must use an absolute path and SHA-256');
    need(await sha256File(file) === expected, `stale source ${file}`);
  }
}

/** Reads official production inputs; no private-proof receipt can replace them. */
export async function readPanelProductionInputs({ episodeDir }) {
  need(typeof episodeDir === 'string' && episodeDir.length > 0, 'explicit episodeDir required');
  const dir = await fs.realpath(episodeDir), inputHashes = {};
  const bind = async (file, expected) => {
    need(typeof file === 'string' && file.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(file), 'local source path required');
    const absolute = await fs.realpath(path.resolve(dir, file));
    const sha256 = await sha256File(absolute);
    if (expected !== undefined) need(hashValue(expected) && expected === sha256, `stale source ${absolute}`);
    inputHashes[absolute] = sha256;
    return { path: absolute, sha256 };
  };
  const artifact = async (file, expected) => { const ref = await bind(file, expected); return { ref, value: await read(ref.path) }; };
  const sources = async value => { for (const [file, expected] of Object.entries(value.source_hashes ?? {})) await bind(file, expected); };
  const run = await artifact('run_identity.json');
  assertPanelProductionIdentity(run.value);
  const identity = run.value, episode = identity.episode, paths = panelProductionPaths(dir, episode);
  const allocation = await loadPanelAssetPlan({ episodeDir: dir });
  // The allocation loader verifies its complete pre-generation dependency chain.
  await bind(`panel_asset_plan_${episode}.json`);
  const allocationPlan = allocation.plan ?? allocation;
  await sources(allocationPlan);
  const script = await bind('script_clean.md');
  const approval = await artifact('operator_script_approval.json'), lock = await artifact('script_lock.json');
  need(approval.value.operator_approved === true && (approval.value.script_clean_hash ?? approval.value.script_hash) === script.sha256, 'approved script hash missing or stale');
  need((lock.value.script_clean_hash ?? lock.value.script_hash) === script.sha256, 'script lock is stale');
  const narration = await artifact(resolveNarrationReport({ episodeDir: dir, episode, identity }).report_path);
  need(passed(narration.value.status) && narration.value.source_script_hash === script.sha256, 'canonical narration is not passed for this script');
  const canonicalAudio = await bind(narration.value.output_path ?? narration.value.final_wav_path, narration.value.output_sha256 ?? narration.value.final_wav_sha256 ?? narration.value.output_hash);
  const delivery = await artifact(`narration_final_delivery_qa_${episode}.json`);
  need(delivery.value.schema === 'goldflow_narration_final_delivery_qa_v2' && delivery.value.status === 'passed' && delivery.value.source_script_hash === script.sha256 && delivery.value.narration_audio_hash === canonicalAudio.sha256 && !(delivery.value.blockers ?? []).length, 'canonical narration delivery QA is missing or stale');
  need(delivery.value.quality_contract_sha256 === identity.narration_quality_contract?.contract_sha256, 'narration quality contract changed');
  const timing = await artifact(`narration_word_timing_${episode}.json`);
  const timingIdentity = await verifyPanelProductionTimingIdentity({ episodeDir: dir, identity, currentIdentitySha256: run.ref.sha256, timing: timing.value, timingPath: timing.ref.path, timingSha256: timing.ref.sha256 });
  for (const [file, expected] of Object.entries(timingIdentity.source_hashes)) await bind(file, expected);
  need(timing.value.status === 'passed' && timing.value.source_script_hash === script.sha256 && timing.value.narration_audio_hash === canonicalAudio.sha256 && timing.value.narration_report_sha256 === narration.ref.sha256, 'official word timing is stale');
  need(timing.value.word_timing_qa?.status === 'passed' && timing.value.full_stream_transcript_qa?.status === 'passed', 'word timing QA must pass');
  await sources(timing.value);
  const bed = await artifact(`longform_audio_bed_report_${episode}.json`);
  need(bed.value.status === 'completed' && bed.value.narration_only === true && bed.value.source_script_hash === script.sha256, 'complete narrator-only audio bed required');
  need((bed.value.narration_report_sha256 ?? bed.value.qwen_report_sha256) === narration.ref.sha256 && bed.value.narration_sha256 === canonicalAudio.sha256, 'audio bed narration binding is stale');
  await sources(bed.value);
  const audio = { ...await bind(bed.value.mix?.render_input_path ?? bed.value.mix?.wav_path ?? bed.value.render_input_path ?? bed.value.final_audio_path, bed.value.mix?.render_input_sha256 ?? bed.value.render_input_sha256 ?? bed.value.final_audio_sha256), offset_sec: 0 };
  const finalAudio = await bind(bed.value.final_audio_path, bed.value.final_audio_sha256);
  need(finalAudio.path === audio.path && finalAudio.sha256 === audio.sha256, 'audio bed final master and render input disagree');
  const probe = JSON.parse((await exec(process.env.ANIFACTORY_FFPROBE_BIN || 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'wav,flac,mp3,ogg,mov,aac', '-show_streams', '-show_format', '-of', 'json', audio.path], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout);
  const audioStream = probe.streams?.find(stream => stream.codec_type === 'audio');
  const duration = Number(audioStream?.duration ?? probe.format?.duration);
  const canvas = identity.panel_composition_contract.canvas;
  need(audioStream && Number.isFinite(duration) && duration > 0, 'final audio must have a real positive duration');
  need(Math.abs(Number(bed.value.mixed_duration_sec ?? bed.value.mix?.duration_sec) - duration) <= 1 / canvas.fps, 'audio bed reported duration differs from media');
  const beats = await artifact('visual_beat_plan.json'), grouping = await artifact('visual_beat_approval.json');
  need(beats.value.status === 'passed' && beats.value.source_script_hash === script.sha256 && beats.value.word_timing_audio_hash === canonicalAudio.sha256, 'visual beats are stale');
  need(grouping.value.status === 'approved' && grouping.value.visual_beat_plan_sha256 === beats.ref.sha256 && grouping.value.grouping_lock_sha256 === beats.value.editorial_director?.grouping_lock_sha256, 'approved beat grouping is missing or stale');
  await sources(beats.value);
  const prompts = await artifact('section_image_prompts_hardened.json');
  need(prompts.value.status === 'passed' && Array.isArray(prompts.value.prompts), 'passed hardened prompts required');
  await assertPanelPromptAllocation({ episodeDir: dir, prompts: prompts.value.prompts });
  await sources(prompts.value);
  const images = await artifact(`imagegen_report_${episode}.json`), qa = await artifact(`image_output_qa_${episode}.json`);
  need(images.value.status === 'passed' && qa.value.status === 'passed' && !(qa.value.unresolved_blocker_count > 0), 'complete image generation and QA required');
  need(qa.value.imagegen_report_sha256 === images.ref.sha256, 'image QA report binding is stale');
  need(qa.value.prompt_plan_sha256 === prompts.ref.sha256, 'image QA prompt binding is missing or stale');
  need(hashValue(qa.value.review_decisions_sha256), 'image QA review decision binding is missing');
  const decisions = await artifact(qa.value.review_decisions_path ?? `image_output_review_decisions_${episode}.json`, qa.value.review_decisions_sha256);
  need(decisions.value.status === 'complete', 'image review decisions are incomplete');
  await sources(qa.value);
  const focal = await artifact(`image_focal_analysis_${episode}.json`);
  need(focal.value.status === 'passed' && qa.value.focal_analysis_sha256 === focal.ref.sha256, 'image focal analysis is stale');
  need(focal.value.prompt_plan_sha256 === prompts.ref.sha256 && focal.value.imagegen_report_sha256 === images.ref.sha256, 'focal analysis source bindings are missing or stale');
  const ledger = await artifact('cut_execution_ledger.json');
  const byId = (rows, label) => {
    need(Array.isArray(rows), `${label} rows required`);
    const map = new Map(rows.map(row => [row.image_id, row]));
    need(map.size === rows.length, `${label} contains duplicate IDs`); return map;
  };
  const imageRows = byId(images.value.results, 'image report'), cuts = byId(ledger.value.cuts, 'cut ledger'), promptRows = byId(prompts.value.prompts, 'prompt plan');
  const words = timing.value.words;
  need(Array.isArray(words) && words.length > 0 && words.length === timing.value.word_count, 'word count is invalid');
  let priorStart = -Infinity;
  for (const [index, word] of words.entries()) {
    need(word.index === index && typeof word.word === 'string' && Number.isFinite(word.start_sec) && Number.isFinite(word.end_sec) && word.start_sec >= priorStart && word.end_sec >= word.start_sec && word.end_sec <= duration + 0.1, 'word timing order or coverage is invalid');
    priorStart = word.start_sec;
  }
  const assets = [], panels = [], scenes = [], beatRows = beats.value.beats;
  need(Array.isArray(beatRows) && beatRows.length > 0, 'visual beat list is empty');
  let priorEnd = beatRows[0].start_sec, nextWord = 0;
  need(Number.isFinite(priorEnd) && priorEnd >= 0 && priorEnd <= words[0].start_sec + 1e-5, 'invalid opening narration preroll');
  const ids = new Set();
  for (const [index, beat] of beatRows.entries()) {
    need(!ids.has(beat.visual_beat_id), 'duplicate visual beat ID'); ids.add(beat.visual_beat_id);
    need(Math.abs(beat.start_sec - priorEnd) < 1e-5 && beat.end_sec > beat.start_sec && beat.source_word_start_index === nextWord && Number.isInteger(beat.source_word_end_index) && beat.source_word_end_index >= nextWord, 'beats must preserve contiguous time and word spans');
    priorEnd = beat.end_sec; nextWord = beat.source_word_end_index + 1;
    const imageId = beat.image_id_hint, row = imageRows.get(imageId), cut = cuts.get(imageId), prompt = promptRows.get(imageId);
    const acceptedHash = qa.value.accepted_image_hashes?.[imageId];
    need(row && row.status !== 'failed' && prompt?.visual_beat_id === beat.visual_beat_id && hashValue(acceptedHash), `accepted beat image missing for ${imageId}`);
    need(cut?.image_sha256 === acceptedHash && String(cut.image_qa_status).startsWith('passed'), `cut ledger is stale for ${imageId}`);
    const authoredHash = createHash('sha256').update(JSON.stringify({ image_prompt: prompt.image_prompt ?? null, modelslab_image_prompt: prompt.modelslab_image_prompt ?? null, codex_image_prompt: prompt.codex_image_prompt ?? null, shot_manifest: prompt.shot_manifest ?? null, reference_requirements: prompt.reference_requirements ?? [] })).digest('hex');
    need(cut.authored_prompt_hash === authoredHash, `cut creative contract is stale for ${imageId}`);
    for (const reference of cut.references ?? []) await bind(reference.path, reference.sha256);
    need(!(qa.value.critical_rejected_image_ids ?? []).includes(imageId) && !(qa.value.not_inspected_image_ids ?? []).includes(imageId), `unresolved image review for ${imageId}`);
    const decision = decisions.value.decisions.find(value => value.image_id === imageId);
    if (decision) need(decision.image_sha256 === acceptedHash && !['not_inspected', 'critical_rejected'].includes(decision.decision), `stale image decision for ${imageId}`);
    const raster = await bind(row.image_path, acceptedHash);
    need(await sha256File(path.resolve(dir, cut.image_path)) === acceptedHash, `cut ledger raster changed for ${imageId}`);
    const metadata = await sharp(raster.path, { limitInputPixels: 100_000_000 }).metadata();
    need(['png', 'jpeg', 'webp'].includes(metadata.format) && (!metadata.pages || metadata.pages === 1), `static raster required for ${imageId}`);
    assets.push({ id: imageId, ...raster, width: metadata.width, height: metadata.height, origin: 'original_generated', provenance: `Accepted production cut ${imageId}; QA ${qa.ref.sha256}` });
    const panelId = `panel_${beat.visual_beat_id}`;
    panels.push({ id: panelId, asset_id: imageId, source_rect: { ...full }, metadata: { source_beat_id: beat.visual_beat_id, source_start_sec: beat.start_sec, source_end_sec: beat.end_sec, source_word_start_index: beat.source_word_start_index, source_word_end_index: beat.source_word_end_index, narration_excerpt: beat.visual_beat_script_excerpt ?? '', source_image_id: imageId } });
    // Only the final authored hold may extend over final master padding. All
    // internal beat boundaries remain absolute and unchanged.
    const end = index === beatRows.length - 1 ? duration : beat.end_sec;
    const start = index === 0 ? 0 : beat.start_sec;
    const state = { rect: { ...full }, camera: { ...camera }, opacity: 1, easing: 'hold' };
    scenes.push({ id: beat.visual_beat_id, start_sec: start, end_sec: end, background: { panel_id: panelId, blur_px: 0, brightness: 0 }, layers: [{ id: `${beat.visual_beat_id}__baseline`, panel_id: panelId, start_sec: start, end_sec: end, z: 0, fit: 'contain', border_px: 0, keyframes: [{ at_sec: start, ...state }, { at_sec: end, ...state }] }] });
  }
  need(nextWord === words.length && Math.abs(priorEnd - duration) <= 1 / canvas.fps + 0.001, 'visual beats do not cover the whole approved audio');
  const timeline = { schema: 'goldflow_panel_production_timeline_v1', intent: 'production_panel_composition', id: `${identity.channel}-${identity.week ?? identity.run_slug ?? 'run'}-${episode}`, content_profile: 'manhwa_recap_v1', run_identity: run.ref, ...canvas, duration_sec: duration, audio_target: 'narrator_only', audio, narration_preroll_sec: beatRows[0].start_sec, assets, panels, scenes };
  validatePanelTimeline(timeline, timeline.intent);
  await currentHashes(inputHashes);
  return { episodeDir: dir, identity, paths, timeline, assets, audio, inputHashes, beats: beatRows, words, wordTiming: timing.value, audioBedReport: bed.value, allocation: allocationPlan, imageReviewDecisions: decisions.value.decisions };
}

export async function preparePanelProductionPlan({ episodeDir }) {
  const loaded = await readPanelProductionInputs({ episodeDir });
  const { paths, timeline, inputHashes } = loaded;
  for (const file of [paths.packetPath, paths.recipePath, paths.planPath]) need(!await fs.stat(file).then(() => true, () => false), `existing artifact retained: ${file}`);
  const packet = { schema: 'goldflow_panel_production_packet_v1', status: 'needs_authored_composition', run_identity: timeline.run_identity, source_hashes: inputHashes, baseline: timeline, beats: loaded.beats, words: loaded.words, image_review_decisions: loaded.imageReviewDecisions, instructions: [
    'Inspect accepted artwork and author every layout, crop, camera move and reveal against the exact narration. No fixed transition cycle or target reuse quota.',
    'Each main panel must stay bound to its current approved beat. Context/background may hold current or earlier panels; never disclose a later beat early.',
    'Choose full_frame, inset, reveal, reaction_pair or page_pan. Relative source_rect selects artwork; rect places it on the 16:9 output. Preserve faces and readable content.',
    'Read the hash-bound image_review_decisions, including crop and disclosure notes, before choosing regions. Image acceptance does not approve full-frame disclosure or final composition; inspect foreground, context and blurred background together.',
    'Keep exact scene boundaries and original word indices. Source/caption/spoken text remain separate and immutable.',
    'Review the composed opening and samples from later sections before final QA. This authored edit is not a final-QA or publishing approval.',
  ] };
  await fs.writeFile(paths.packetPath, json(packet), { flag: 'wx' });
  const recipe = { schema: 'goldflow_panel_composition_recipe_v1', author: null, source_packet: { path: paths.packetPath, sha256: await sha256File(paths.packetPath) }, decisions: timeline.scenes.map(scene => ({ scene_id: scene.id, layout: null, panel_id: scene.layers[0].panel_id, background_panel_id: scene.background.panel_id, editorial_reason: null, source_rect: null, rect: null, fit: 'contain', camera_from: { ...camera }, camera_to: { ...camera }, entry: null, context: null })) };
  await fs.writeFile(paths.recipePath, json(recipe), { flag: 'wx' });
  return { status: 'needs_authoring', packet_path: paths.packetPath, recipe_path: paths.recipePath, beat_count: timeline.scenes.length, provider_calls: 0 };
}

export function validateEditorialBindings(baseline, recipe) {
  const sceneById = new Map(baseline.scenes.map(scene => [scene.id, scene]));
  const firstUse = new Map(baseline.scenes.map(scene => [scene.layers[0].panel_id, scene.start_sec]));
  for (const decision of recipe.decisions ?? []) {
    const scene = sceneById.get(decision.scene_id);
    need(scene && decision.panel_id === scene.layers[0].panel_id, `main panel must match the approved beat: ${decision.scene_id}`);
    for (const id of [decision.background_panel_id, decision.context?.panel_id].filter(Boolean)) need(firstUse.has(id) && firstUse.get(id) <= scene.start_sec, `future or unknown context panel ${id}`);
  }
}

export async function compilePanelProductionPlan({ episodeDir, recipePath }) {
  let loaded = await readPanelProductionInputs({ episodeDir });
  const absoluteRecipe = await fs.realpath(recipePath ?? loaded.paths.recipePath), recipeHash = await sha256File(absoluteRecipe), recipe = await read(absoluteRecipe);
  need(recipe.source_packet?.path === loaded.paths.packetPath && recipe.source_packet.sha256 === await sha256File(loaded.paths.packetPath), 'recipe packet binding is missing or stale');
  const packet = await read(loaded.paths.packetPath);
  need(packet.schema === 'goldflow_panel_production_packet_v1' && JSON.stringify(packet.source_hashes) === JSON.stringify(loaded.inputHashes), 'authoring inputs changed; prepare a current packet through scoped recovery');
  const revisionPath = path.join(loaded.episodeDir, `panel_audio_revision_request_${loaded.identity.episode}.json`);
  if (await fs.stat(revisionPath).then(() => true, () => false)) loaded = await loadPanelAudioRevision({ loaded, requestPath: revisionPath });
  validateEditorialBindings(loaded.timeline, recipe);
  const timeline = compilePanelComposition(loaded.timeline, recipe, { mode: 'production_panel_composition' });
  timeline.provenance.source_order_review = 'no_future_context_panels';
  const sources = { ...loaded.inputHashes, ...loaded.revisionHashes, [absoluteRecipe]: recipeHash, [loaded.paths.packetPath]: recipe.source_packet.sha256 };
  await currentHashes(sources);
  // Retain every compile receipt and snapshot; official pointers are promoted
  // only after their complete candidate has been validated.
  const attempt = path.join(loaded.episodeDir, 'reports', 'panel-composition', randomUUID());
  await fs.mkdir(attempt, { recursive: true });
  const snapshot = path.join(attempt, 'timeline.json'); await fs.writeFile(snapshot, json(timeline), { flag: 'wx' });
  const revisionArtifacts = {};
  if (loaded.audioRevision) {
    for (const [key, value] of [['revised_word_timing', loaded.wordTiming], ['revised_audio_bed', loaded.audioBedReport]]) {
      const file = path.join(attempt, `${key}.json`); await fs.writeFile(file, json(value), { flag: 'wx' });
      const hash = await sha256File(file); sources[file] = hash; revisionArtifacts[key] = { path: file, sha256: hash };
    }
  }
  const timelineHash = await sha256File(snapshot);
  const report = { schema: 'goldflow_panel_production_plan_v1', status: 'passed', episode: loaded.identity.episode, author: recipe.author, run_identity: timeline.run_identity, timeline: { path: loaded.paths.timelinePath, sha256: timelineHash }, retained_timeline: { path: snapshot, sha256: timelineHash }, source_hashes: sources, recipe: { path: absoluteRecipe, sha256: recipeHash }, ...(loaded.audioRevision ? { audio_revision: loaded.audioRevision, ...revisionArtifacts } : {}), beat_count: timeline.scenes.length, duration_sec: timeline.duration_sec, layouts: Object.fromEntries([...new Set(recipe.decisions.map(row => row.layout))].map(layout => [layout, recipe.decisions.filter(row => row.layout === layout).length])), provider_calls: 0, cost_usd: 0, created_at: new Date().toISOString() };
  await fs.writeFile(path.join(attempt, 'report.json'), json(report), { flag: 'wx' });
  await fs.writeFile(`${loaded.paths.timelinePath}.tmp`, json(timeline)); await fs.rename(`${loaded.paths.timelinePath}.tmp`, loaded.paths.timelinePath);
  await fs.writeFile(`${loaded.paths.planPath}.tmp`, json(report)); await fs.rename(`${loaded.paths.planPath}.tmp`, loaded.paths.planPath);
  return report;
}

export async function loadPanelProductionPlan({ episodeDir }) {
  let loaded = await readPanelProductionInputs({ episodeDir });
  const plan = await read(loaded.paths.planPath);
  need(plan.schema === 'goldflow_panel_production_plan_v1' && plan.status === 'passed', 'passed production composition report required');
  await currentHashes(plan.source_hashes);
  for (const [file, hash] of Object.entries(loaded.inputHashes)) need(plan.source_hashes[file] === hash, `composition report does not bind ${file}`);
  const revisionPath = path.join(loaded.episodeDir, `panel_audio_revision_request_${loaded.identity.episode}.json`);
  const revisionExists = await fs.stat(revisionPath).then(() => true, () => false);
  need(revisionExists === Boolean(plan.audio_revision), 'registered audio revision differs from compiled plan');
  if (plan.audio_revision) {
    need(plan.audio_revision.path === revisionPath && plan.source_hashes[revisionPath] === plan.audio_revision.sha256, 'compiled revision binding differs');
    loaded = await loadPanelAudioRevision({ loaded, requestPath: revisionPath });
    for (const [file, hash] of Object.entries(loaded.revisionHashes)) need(plan.source_hashes[file] === hash, `composition report does not bind audio revision source ${file}`);
    for (const [key, value] of [['revised_word_timing', loaded.wordTiming], ['revised_audio_bed', loaded.audioBedReport]]) {
      const ref = plan[key];
      need(ref && plan.source_hashes[ref.path] === ref.sha256 && JSON.stringify(await read(ref.path)) === JSON.stringify(value), `retained ${key} differs from accepted revision`);
      loaded.revisionHashes[ref.path] = ref.sha256;
    }
  }
  need(plan.timeline?.path === loaded.paths.timelinePath && await sha256File(plan.timeline.path) === plan.timeline.sha256, 'composition timeline is stale');
  const timeline = await read(plan.timeline.path);
  validatePanelTimeline(timeline, 'production_panel_composition');
  need(JSON.stringify(timeline.run_identity) === JSON.stringify(loaded.timeline.run_identity) && JSON.stringify(timeline.audio) === JSON.stringify(loaded.audio), 'timeline identity or audio differs from accepted production');
  need(timeline.width === loaded.timeline.width && timeline.height === loaded.timeline.height && timeline.fps === loaded.timeline.fps && timeline.duration_sec === loaded.timeline.duration_sec, 'timeline canvas or duration differs from the production lock');
  need(JSON.stringify(timeline.assets) === JSON.stringify(loaded.assets), 'timeline assets differ from accepted production');
  const recipeEntries = Object.keys(plan.source_hashes).filter(file => file !== loaded.paths.packetPath && !Object.hasOwn(loaded.inputHashes, file) && !Object.hasOwn(loaded.revisionHashes ?? {}, file));
  need(recipeEntries.length === 1, 'exact authored recipe binding required');
  const recipe = await read(recipeEntries[0]);
  validateEditorialBindings(loaded.timeline, recipe);
  const compiled = compilePanelComposition(loaded.timeline, recipe, { mode: 'production_panel_composition' });
  compiled.provenance.source_order_review = 'no_future_context_panels';
  need(JSON.stringify(compiled) === JSON.stringify(timeline), 'timeline differs from its authored recipe; compile the current recipe');
  return { ...loaded, timeline, plan, planPath: loaded.paths.planPath, inputHashes: { ...plan.source_hashes, [loaded.paths.timelinePath]: plan.timeline.sha256, [loaded.paths.planPath]: await sha256File(loaded.paths.planPath) } };
}
