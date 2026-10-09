import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { prepareOriginalPanelExperiment } from '../lib/panel-original-import.mjs';
import { loadPanelExperimentTimeline } from '../lib/panel-experiment-contract.mjs';
import { validatePanelTimeline } from '../lib/panel-layout-validation.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, value) => { const bytes = `${JSON.stringify(value, null, 2)}\n`; await fs.writeFile(file, bytes); return hash(bytes); };
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-original-import-'));
let count = 0;
async function test(name, run) { await run(); count++; process.stdout.write(`ok - original panel import: ${name}\n`); }

async function fixture(name) {
  const episodeDir = path.join(root, name, 'original'); await fs.mkdir(episodeDir, { recursive: true });
  const p = file => path.join(episodeDir, file);
  const source = 'I paid $2.\n'; await fs.writeFile(p('script_clean.md'), source); const sourceHash = hash(source);
  const identity = { schema: 'goldflow_run_identity_v2', channel: 'fixture', series_slug: 'fixture-series', episode: 'ep_01', content_profile: 'manhwa_recap_v1', media_workflow: 'generated_visuals_v1', tts_provider: 'qwen_local', narration_quality_contract: { contract_sha256: 'c'.repeat(64), subjective_review: { hash_bound_sampling_manifest_required: false } } };
  const identityHash = await write(p('run_identity.json'), identity);
  await write(p('operator_script_approval.json'), { schema: 'goldflow_operator_script_approval_v1', operator_approved: true, script_clean_hash: sourceHash });
  await write(p('script_lock.json'), { schema: 'goldflow_script_lock_v1', script_clean_hash: sourceHash });
  const sampleRate = 24000, samples = 3 * sampleRate, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  await fs.writeFile(p('canonical.wav'), wav); const audioHash = hash(wav);
  await write(p('full_qa.json'), { schema: 'goldflow_narration_full_stream_qa_v2', status: 'passed_with_warnings', source_script_hash: sourceHash, audio_sha256: audioHash, blockers: [] });
  await write(p('narration_final_delivery_qa_ep_01.json'), { schema: 'goldflow_narration_final_delivery_qa_v2', status: 'passed', source_script_hash: sourceHash, narration_audio_hash: audioHash, quality_contract_sha256: identity.narration_quality_contract.contract_sha256, blockers: [] });
  const narration = { schema: 'goldflow_provider_neutral_narration_stitch_v2', status: 'passed', source_script_hash: sourceHash, output_path: p('canonical.wav'), output_sha256: audioHash, full_stream_qa_status: 'passed_with_warnings', full_stream_qa_path: p('full_qa.json'), final_duration_sec: 3 };
  const narrationHash = await write(p('audio_stitch_report_ep_01-narration.json'), narration);
  const words = [{ index: 0, word: 'I', start_sec: 0, end_sec: 0.4 }, { index: 1, word: 'paid', start_sec: 0.5, end_sec: 0.9 }, { index: 2, word: 'two', start_sec: 1, end_sec: 1 }, { index: 3, word: 'dollars.', start_sec: 1.5, end_sec: 2.5 }];
  const timing = { schema: 'goldflow_local_whisper_word_timing_v2', status: 'passed', source_script_hash: sourceHash, narration_audio_path: p('canonical.wav'), narration_audio_hash: audioHash, narration_report_sha256: narrationHash, run_identity_sha256: identityHash, word_count: words.length, words, word_timing_qa: { status: 'passed' }, full_stream_transcript_qa: { status: 'passed' }, source_hashes: { [p('script_clean.md')]: sourceHash, [p('canonical.wav')]: audioHash, [p('audio_stitch_report_ep_01-narration.json')]: narrationHash, [p('run_identity.json')]: identityHash } };
  const timingHash = await write(p('narration_word_timing_ep_01.json'), timing);
  const groupingHash = 'b'.repeat(64);
  const beats = [
    { visual_beat_id: 'beat_w000000_w000001', image_id_hint: 'image_a', source_word_start_index: 0, source_word_end_index: 1, start_sec: 0, end_sec: 1, visual_beat_script_excerpt: 'I paid', visual_job: 'choice', suggested_shot_job: 'close_up' },
    { visual_beat_id: 'beat_w000002_w000003', image_id_hint: 'image_b', source_word_start_index: 2, source_word_end_index: 3, start_sec: 1, end_sec: 3, visual_beat_script_excerpt: '$2.', visual_job: 'payoff', suggested_shot_job: 'object_insert' },
  ];
  const beatPlan = { schema: 'goldflow_visual_beat_plan_v2', status: 'passed', source_script_hash: sourceHash, word_timing_audio_hash: audioHash, beats, editorial_director: { grouping_lock_sha256: groupingHash }, source_hashes: { [p('script_clean.md')]: sourceHash, [p('narration_word_timing_ep_01.json')]: timingHash } };
  const planHash = await write(p('visual_beat_plan.json'), beatPlan);
  await write(p('visual_beat_approval.json'), { schema: 'goldflow_visual_beat_approval_v1', status: 'approved', visual_beat_plan_sha256: planHash, grouping_lock_sha256: groupingHash });
  const imageHashes = {};
  for (const [id, color] of [['image_a', '#ff0000'], ['image_b', '#00ff00']]) { await sharp({ create: { width: 320, height: 180, channels: 3, background: color } }).png().toFile(p(`${id}.png`)); imageHashes[id] = hash(await fs.readFile(p(`${id}.png`))); }
  const imageReport = { schema: 'goldflow_imagegen_report_v1', status: 'passed', results: Object.entries(imageHashes).map(([image_id, sha256]) => ({ image_id, status: 'generated', image_path: p(`${image_id}.png`), generated: { output_sha256: sha256 } })) };
  const imageReportHash = await write(p('imagegen_report_ep_01.json'), imageReport);
  const decisions = { schema: 'goldflow_image_output_review_decisions_v2', status: 'complete', decisions: Object.entries(imageHashes).map(([image_id, image_sha256]) => ({ image_id, image_sha256, decision: 'accepted' })) };
  const decisionsHash = await write(p('image_output_review_decisions_ep_01.json'), decisions);
  await write(p('image_output_qa_ep_01.json'), { schema: 'goldflow_image_output_qa_v2', status: 'passed', unresolved_blocker_count: 0, imagegen_report_sha256: imageReportHash, review_decisions_path: p('image_output_review_decisions_ep_01.json'), review_decisions_sha256: decisionsHash, accepted_image_hashes: imageHashes, critical_rejected_image_ids: [], not_inspected_image_ids: [] });
  const configPath = path.join(root, name, 'config.json');
  const config = { schema: 'goldflow_original_panel_experiment_config_v1', id: `experiment-${name}`, channel: 'fixture', series: 'fixture-series', episode: 'ep_01', title: 'Original story editing comparison', width: 320, height: 180, fps: 30 }; await write(configPath, config);
  return { episodeDir, configPath, startSec: 0.25, endSec: 2.25, outputDir: path.join(root, name, 'import'), p, config, source, sourceHash, audioHash, beatPlan, timing, identity, narration, imageHashes };
}
async function snapshot(directory) { return Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async name => [name, hash(await fs.readFile(path.join(directory, name)))]))); }
async function rejectBeforeOutput(f, pattern) { await assert.rejects(prepareOriginalPanelExperiment(f), pattern); await assert.rejects(fs.access(f.outputDir), { code: 'ENOENT' }); }
async function rewriteBeatPlan(f) { const digest = await write(f.p('visual_beat_plan.json'), f.beatPlan); const approval = await read(f.p('visual_beat_approval.json')); approval.visual_beat_plan_sha256 = digest; await write(f.p('visual_beat_approval.json'), approval); }

try {
  await test('imports exact approved source into an isolated static control and editable composition packet', async () => {
    const f = await fixture('happy'); const before = await snapshot(f.episodeDir);
    const result = await prepareOriginalPanelExperiment(f);
    assert.equal(result.status, 'prepared'); assert.equal(result.production_eligible, false); assert.equal(result.publishing_allowed, false); assert.equal(result.provider_calls, 0);
    assert.equal(result.duration_sec, 2); assert.equal(result.beat_count, 2);
    assert.deepEqual(await snapshot(f.episodeDir), before, 'Import cannot modify any original file.');
    const packet = await read(result.source_packet_path), baseline = await read(result.baseline_path), composition = await read(result.composition_packet_path);
    assert.equal(packet.approved_script_text_reconstructed, false); assert.equal(packet.source_script.sha256, f.sourceHash);
    assert.deepEqual(packet.beats.map(b => b.visual_beat_script_excerpt), ['I paid', '$2.']);
    assert.deepEqual(packet.words.map(w => w.word), ['I', 'paid', 'two', 'dollars.']);
    assert.deepEqual(packet.words.map(w => w.source_index), [0, 1, 2, 3]);
    assert.equal(packet.words[0].source_start_sec, 0); assert.equal(packet.words[0].start_sec, 0);
    assert.equal(packet.words[2].start_sec, 0.75); assert.equal(packet.words[2].end_sec, 0.75, 'Zero-duration Whisper rows remain auditable.');
    assert.equal(packet.words[3].end_sec, 2); assert.equal(packet.words[3].source_end_sec, 2.5);
    assert.deepEqual(baseline.scenes.map(s => [s.start_sec, s.end_sec]), [[0, 0.75], [0.75, 2]]);
    assert.equal(baseline.audio.offset_sec, 0.25); assert.equal(baseline.audio.sha256, f.audioHash);
    for (const scene of baseline.scenes) { assert.equal(scene.layers.length, 1); assert.equal(scene.layers[0].fit, 'contain'); assert.equal(scene.layers[0].keyframes[0].easing, 'hold'); assert.deepEqual(scene.layers[0].keyframes[0].rect, scene.layers[0].keyframes[1].rect); }
    assert.equal(composition.status, 'needs_authored_composition');
    const loaded = await loadPanelExperimentTimeline(result.baseline_path); assert.equal(loaded.identity.source_mode, 'original_story');
    assert.throws(() => validatePanelTimeline(baseline), /schema/);
    await assert.rejects(prepareOriginalPanelExperiment(f), /already exists/);
    assert.deepEqual(await snapshot(f.episodeDir), before);
  });
  await test('source boundaries preserve half-open word and beat selection', async () => {
    const f = await fixture('boundary'); f.startSec = 1; f.endSec = 3;
    const result = await prepareOriginalPanelExperiment(f); const packet = await read(result.source_packet_path);
    assert.equal(result.beat_count, 1); assert.deepEqual(packet.words.map(w => w.source_index), [2, 3]);
    assert.equal(packet.beats[0].source_start_sec, 1); assert.equal(packet.beats[0].start_sec, 0);
    assert.equal(packet.words[0].start_sec, 0);
  });
  await test('scope, episode alignment and actual media duration fail before outputs', async () => {
    const f = await fixture('scope');
    await rejectBeforeOutput({ ...f, endSec: 1801 }, /1800/);
    await rejectBeforeOutput({ ...f, startSec: -1 }, /source window/);
    await rejectBeforeOutput({ ...f, endSec: 3.1 }, /actual canonical narration/);
    f.config.channel = 'different'; await write(f.configPath, f.config); await rejectBeforeOutput(f, /must match/);
  });
  await test('missing exact script approval or stale canonical audio cannot be imported', async () => {
    const approval = await fixture('approval'); const a = await read(approval.p('operator_script_approval.json')); a.operator_approved = false; await write(approval.p('operator_script_approval.json'), a); await rejectBeforeOutput(approval, /script approval/);
    const stale = await fixture('stale-audio'); await fs.appendFile(stale.p('canonical.wav'), 'changed'); await rejectBeforeOutput(stale, /stale source hash/);
    const lock = await fixture('lock'); const l = await read(lock.p('script_lock.json')); l.script_clean_hash = 'f'.repeat(64); await write(lock.p('script_lock.json'), l); await rejectBeforeOutput(lock, /script lock/);
  });
  await test('stale official timing and grouping approval cannot become experiment truth', async () => {
    const t = await fixture('timing'); t.timing.narration_audio_hash = 'f'.repeat(64); await write(t.p('narration_word_timing_ep_01.json'), t.timing); await rejectBeforeOutput(t, /official word timing/);
    const b = await fixture('beat-approval'); const approval = await read(b.p('visual_beat_approval.json')); approval.visual_beat_plan_sha256 = 'f'.repeat(64); await write(b.p('visual_beat_approval.json'), approval); await rejectBeforeOutput(b, /grouping/);
  });
  await test('approved grouping still requires contiguous words and exact timeline coverage', async () => {
    const words = await fixture('word-gap'); words.beatPlan.beats[1].source_word_start_index = 3; await rewriteBeatPlan(words); await rejectBeforeOutput(words, /word spans/);
    const times = await fixture('time-gap'); times.beatPlan.beats[1].start_sec = 1.1; await rewriteBeatPlan(times); await rejectBeforeOutput(times, /contiguous timeline/);
  });
  await test('generated raster and risk-review hashes must be current', async () => {
    const f = await fixture('image-stale'); await fs.appendFile(f.p('image_a.png'), 'changed'); await rejectBeforeOutput(f, /stale source hash/);
    const g = await fixture('qa-rejected'); const qa = await read(g.p('image_output_qa_ep_01.json')); qa.critical_rejected_image_ids = ['image_a']; await write(g.p('image_output_qa_ep_01.json'), qa); await rejectBeforeOutput(g, /unresolved review/);
    const h = await fixture('qa-stale'); await fs.appendFile(h.p('image_output_review_decisions_ep_01.json'), '\n'); await rejectBeforeOutput(h, /stale source hash/);
  });
  await test('legacy missing workflow retains its recorded generated route without migration', async () => {
    const f = await fixture('historical'); delete f.identity.media_workflow;
    const identityHash = await write(f.p('run_identity.json'), f.identity); f.timing.run_identity_sha256 = identityHash; f.timing.source_hashes[f.p('run_identity.json')] = identityHash;
    const timingHash = await write(f.p('narration_word_timing_ep_01.json'), f.timing); f.beatPlan.source_hashes[f.p('narration_word_timing_ep_01.json')] = timingHash; await rewriteBeatPlan(f);
    await prepareOriginalPanelExperiment(f); assert.equal((await read(f.p('run_identity.json'))).media_workflow, undefined);
  });
  await test('historical listening waiver is retained only when all original bindings remain current', async () => {
    const f = await fixture('listening-waiver');
    f.identity.narration_quality_contract.subjective_review.hash_bound_sampling_manifest_required = true;
    const identityHash = await write(f.p('run_identity.json'), f.identity);
    const plan = { plan_sha256: 'a'.repeat(64) };
    const planHash = await write(f.p('narration_generation_plan.json'), plan);
    Object.assign(f.narration, { narration_generation_plan_path: f.p('narration_generation_plan.json'), narration_generation_plan_file_sha256: planHash, narration_generation_plan_sha256: plan.plan_sha256, subjective_review_waiver: { schema: 'goldflow_operator_narration_qa_waiver_v1', status: 'skipped_with_waiver', skip_subjective_review: true, human_listening_performed: false, reason: 'Existing fixture-only operator decision; importer cannot create approvals.', narration_generation_plan_sha256: plan.plan_sha256, narration_generation_plan_file_sha256: planHash, narration_quality_contract_sha256: f.identity.narration_quality_contract.contract_sha256, narration_audio_sha256: f.audioHash } });
    const rebind = async () => {
      const narrationHash = await write(f.p('audio_stitch_report_ep_01-narration.json'), f.narration);
      f.timing.run_identity_sha256 = identityHash; f.timing.source_hashes[f.p('run_identity.json')] = identityHash;
      f.timing.narration_report_sha256 = narrationHash; f.timing.source_hashes[f.p('audio_stitch_report_ep_01-narration.json')] = narrationHash;
      const timingHash = await write(f.p('narration_word_timing_ep_01.json'), f.timing);
      f.beatPlan.source_hashes[f.p('narration_word_timing_ep_01.json')] = timingHash; await rewriteBeatPlan(f);
    };
    await rebind();
    const result = await prepareOriginalPanelExperiment(f), packet = await read(result.source_packet_path);
    assert.equal(packet.narration_acceptance.mode, 'original_hash_bound_waiver_retained');
    assert.equal(packet.narration_acceptance.new_approval_created, false);
    assert.equal(packet.narration_acceptance.listening_performed_by_importer, false);
    assert.deepEqual(packet.narration_acceptance.original_waiver, f.narration.subjective_review_waiver);
    f.narration.subjective_review_waiver.narration_audio_sha256 = 'f'.repeat(64); await rebind();
    await rejectBeforeOutput({ ...f, outputDir: path.join(root, 'stale-listening-waiver-output') }, /listening waiver/);
  });
  await test('episode output paths and symlinked episode destinations are refused', async () => {
    const f = await fixture('output'); await rejectBeforeOutput({ ...f, outputDir: path.join(f.episodeDir, 'candidate') }, /episode/);
    const link = path.join(root, 'linked-original'); await fs.symlink(f.episodeDir, link);
    await rejectBeforeOutput({ ...f, outputDir: path.join(link, 'candidate') }, /episode/);
  });
} finally { await fs.rm(root, { recursive: true, force: true }); }
process.stdout.write(`Original panel importer: ${count} test groups passed.\n`);
