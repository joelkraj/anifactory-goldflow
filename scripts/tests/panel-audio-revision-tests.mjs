import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadPanelAudioRevision, readRevisionPcm, verifyExactUnitPcm } from '../lib/panel-audio-revision.mjs';
import { sha256File } from '../lib/file-hash.mjs';

function wav(pcm) {
  const bytes = Buffer.alloc(44 + pcm.length);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(pcm.length, 40); pcm.copy(bytes, 44); return bytes;
}
test('one changed sample outside the accepted take, wrong duration and different take are rejected', () => {
  const original = Buffer.alloc(20), replacement = Buffer.from([1, 0, 2, 0]), revised = Buffer.from(original); replacement.copy(revised, 4);
  const scope = { original, revised, replacement, startSample: 2, sampleCount: 2 };
  verifyExactUnitPcm(scope);
  const outside = Buffer.from(revised); outside[18] = 1;
  assert.throws(() => verifyExactUnitPcm({ ...scope, revised: outside }), /outside/);
  assert.throws(() => verifyExactUnitPcm({ ...scope, revised: revised.subarray(2) }), /duration/);
  assert.throws(() => verifyExactUnitPcm({ ...scope, replacement: Buffer.alloc(4) }), /listened take/);
  assert.deepEqual(readRevisionPcm(wav(revised)), revised);
  assert.throws(() => readRevisionPcm(wav(revised).subarray(0, 47)), /truncated/);
});

// Synthetic provenance fixture only; it does not certify any real voice/media.
async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'panel-audio-revision-')));
  const save = async (name, value) => {
    const file = path.join(dir, name); await fs.writeFile(file, Buffer.isBuffer(value) ? value : JSON.stringify(value));
    return { path: file, sha256: await sha256File(file) };
  };
  const rawPcm = Buffer.alloc(48000), replacementPcm = Buffer.alloc(24000, 1), revisedPcm = Buffer.from(rawPcm); replacementPcm.copy(revisedPcm, 24000);
  const raw = await save('raw.wav', wav(rawPcm)), first = await save('first.wav', wav(rawPcm.subarray(0, 24000))), originalUnit = await save('unit.wav', wav(rawPcm.subarray(24000))), replacement = await save('replacement.wav', wav(replacementPcm)), revised = await save('revised.wav', wav(revisedPcm)), master = await save('master.wav', wav(revisedPcm));
  const runIdentity = await save('run_identity.json', { fixture: true }), originalAudio = { ...raw, offset_sec: 0 };
  const words = [{ index: 0, word: 'Hello.', start_sec: .1, end_sec: .4 }, { index: 1, word: 'World.', start_sec: .6, end_sec: .9 }];
  const timing = await save('timing.json', { source_script_hash: 'fixture', narration_audio_hash: raw.sha256, words });
  const si = { model_id: 'fixture-qwen', model_revision: 'fixture-rev', model_weights_sha256: 'fixture-weights', model_config_sha256: 'fixture-config', reference_audio_sha256: 'fixture-ref', reference_text_sha256: 'fixture-text', mlx_audio_version: 'fixture-runtime' };
  const unit = { unit_id: 'unit2', text: 'World.', raw_audio_path: originalUnit.path, raw_audio_sha256: originalUnit.sha256, prepared_audio_path: originalUnit.path, prepared_audio_sha256: originalUnit.sha256, synthesis_identity: si, voice_sha256: 'fixture-voice' };
  const stitch = await save('stitch.json', { status: 'passed', source_script_hash: 'fixture', output_sha256: raw.sha256, raw_output_path: raw.path, raw_output_sha256: raw.sha256, segments: [{ unit_id: 'unit1', raw_audio_path: first.path, raw_audio_sha256: first.sha256, prepared_audio_path: first.path, prepared_audio_sha256: first.sha256 }, unit], boundaries: [{ gap_sample_count: 0 }] });
  const executionValue = { schema: 'goldflow_private_proof_qwen_narration_run_v1', status: 'passed', unit_count: 1, model: { model_id: si.model_id, revision: si.model_revision, model_weights_sha256: si.model_weights_sha256, model_config_sha256: si.model_config_sha256 }, reference_audio_sha256: si.reference_audio_sha256, reference_text_sha256: si.reference_text_sha256, runtime: { mlx_audio: si.mlx_audio_version }, units: [{ unit_id: 'unit2', source_text: 'World.', spoken_text: 'World.', output_path: replacement.path, output_sha256: replacement.sha256, token_limit_reached: false, waveform_metrics: { clipping_sample_count: 0 } }] };
  const execution = await save('execution.json', executionValue);
  const listeningValue = { status: 'accepted', reviewer_kind: 'human', reviewer: 'Fixture', operator_quote: 'Fixture acceptance', unit_id: 'unit2', audio_sha256: replacement.sha256, candidate_run_sha256: execution.sha256 };
  const listening = await save('listening.json', listeningValue);
  const defect = await save('defect.json', { reviewer_kind: 'human', operator_quote: 'Fixture missing ending', unit_id: 'unit2', source_audio_sha256: originalUnit.sha256, intended_unit_text: 'World.' });
  const speakerReport = await save('speaker.json', { status: 'passed' });
  const voice = await save('voice.json', { status: 'passed', voice_sha256: unit.voice_sha256, units: [{ status: 'passed', audio_sha256: replacement.sha256 }], report_path: speakerReport.path, report_sha256: speakerReport.sha256 });
  const asrWords = [{ word: 'World.', start_sec: .05, end_sec: .4 }];
  const asr = await save('asr.json', { rows: ['small.en', 'medium'].map(model => ({ model, source: 'candidate', audio_sha256: replacement.sha256, words: asrWords })) });
  const mastering = await save('mastering.json', { schema: 'goldflow_narration_mastering_report_v2', status: 'passed', input_path: revised.path, input_sha256: revised.sha256, output_path: master.path, output_sha256: master.sha256, output_probe: { duration_sec: 1, channels: 1, sample_rate_hz: 24000 }, policy: { passes: 2, tempo_processing: false, broadband_denoise: false, per_unit_normalization: false, target_lufs: -16, true_peak_dbtp_max: -1.5, loudness_range_target: 11 }, measured_integrated_lufs: -16, measured_true_peak_dbtp: -1.5 });
  const scene = (id, start, end) => ({ id, start_sec: start, end_sec: end, layers: [{ start_sec: start, end_sec: end, keyframes: [{ at_sec: start }, { at_sec: end }] }] });
  const loaded = { episodeDir: dir, identity: { episode: 'ep_01' }, inputHashes: { [timing.path]: timing.sha256 }, audio: originalAudio, audioBedReport: { narration_only: true, mix: { narration_only: true, duration_sec: 1, narration_volume_db: 0 } }, beats: [{ source_word_start_index: 0, source_word_end_index: 0, start_sec: 0, end_sec: .6 }, { source_word_start_index: 1, source_word_end_index: 1, start_sec: .6, end_sec: 1 }], timeline: { run_identity: runIdentity, duration_sec: 1, audio: originalAudio, scenes: [scene('a', 0, .6), scene('b', .6, 1)], panels: [{ metadata: {} }, { metadata: {} }] } };
  const request = { schema: 'goldflow_panel_exact_unit_audio_revision_v1', intent: 'promote_listened_same_text_take', reviewer: 'Fixture editor', reason: 'Promote one human-listened exact same-text ending repair.', run_identity: runIdentity, original_audio: originalAudio, source_timing: timing, original_stitch: stitch, original_raw: raw, revised_raw: revised, replacement, execution, listening, defect, voice_qa: voice, asr, mastering, master, unit_id: 'unit2', start_sample: 12000, sample_count: 12000, timing_model: 'small.en', word_patches: [{ index: 1, word: 'World.', before: { start_sec: .6, end_sec: .9 }, after: { start_sec: .55, end_sec: .9 } }], boundary_patches: [{ previous_scene_id: 'a', following_scene_id: 'b', before_sec: .6, after_sec: .55 }] };
  const requestPath = path.join(dir, 'panel_audio_revision_request_ep_01.json');
  const persist = () => fs.writeFile(requestPath, JSON.stringify(request));
  await persist();
  return { dir, loaded, request, requestPath, save, persist, listeningValue, executionValue };
}
test('promotion keeps original inputs immutable, selects accepted master and locally retimes captions/panels', async () => {
  const f = await fixture();
  try {
    const result = await loadPanelAudioRevision(f);
    assert.equal(result.audio.sha256, f.request.master.sha256);
    assert.deepEqual(result.words.map(row => row.word), ['Hello.', 'World.']);
    assert.deepEqual(result.words[0], { index: 0, word: 'Hello.', start_sec: .1, end_sec: .4 });
    assert.equal(result.words[1].start_sec, .55);
    assert.deepEqual(result.timeline.scenes.map(row => [row.start_sec, row.end_sec]), [[0, .55], [.55, 1]]);
    assert.equal(f.loaded.timeline.scenes[1].start_sec, .6);
    assert.equal(result.revisionHashes[f.request.listening.path], f.request.listening.sha256);
    const original = await fs.readFile(f.request.original_raw.path); assert.equal(await sha256File(f.request.original_raw.path), f.request.original_raw.sha256);
    assert.ok(original.length > 0);
    f.request.word_patches[0].word = 'Changed.'; await f.persist(); await assert.rejects(loadPanelAudioRevision(f), /approved word/);
  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
});
test('stale or absent human acceptance, wrong voice/model, expanded scope and altered boundary are blocked', async () => {
  const f = await fixture();
  try {
    const pristine = structuredClone(f.request);
    f.request.listening.sha256 = 'a'.repeat(64); await f.persist(); await assert.rejects(loadPanelAudioRevision(f), /stale evidence/);
    Object.assign(f.request, structuredClone(pristine));
    f.request.listening = await f.save('no-human.json', { ...f.listeningValue, reviewer_kind: 'machine' }); await f.persist(); await assert.rejects(loadPanelAudioRevision(f), /human listening/);
    Object.assign(f.request, structuredClone(pristine));
    f.request.execution = await f.save('wrong-model.json', { ...f.executionValue, model: { ...f.executionValue.model, model_id: 'other' } }); await f.persist(); await assert.rejects(loadPanelAudioRevision(f), /model_id changed/);
    Object.assign(f.request, structuredClone(pristine));
    f.request.sample_count += 1; await f.persist(); await assert.rejects(loadPanelAudioRevision(f), /duration/);
    Object.assign(f.request, structuredClone(pristine));
    f.request.boundary_patches[0].after_sec = .2; await f.persist(); await assert.rejects(loadPanelAudioRevision(f), /exact local speech cue/);
  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
});
