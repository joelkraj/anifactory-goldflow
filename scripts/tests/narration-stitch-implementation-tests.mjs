import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planAlignmentSafeUnitEdit } from '../lib/narration-boundary-editor.mjs';
import { buildNarrationQualityContract } from '../lib/narration-quality-contract.mjs';
import { sha256File } from '../lib/file-hash.mjs';
import { stitchWavsForDiagnostics } from '../modelslab-qwen-episode-audio.mjs';
import { emptyNarrationFinalizationCheckpoint, narrationFinalizationStageKey, narrationFinalizationUnitKey, narrationStitchImplementationIdentity, reusableNarrationFinalizationStage, reusableNarrationFinalizationUnit } from '../lib/narration-finalization-checkpoint.mjs';

const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'narration-stitch-implementation-'));
const contract = buildNarrationQualityContract();
const base = { unitId: 'fixture', sampleCount: 24000, sampleRate: 24000, alignment: { status: 'passed', first_speech_sample: 4800, last_speech_sample_exclusive: 14400 }, contract };
let count = 0;
async function test(name, body) { await body(); count++; console.log(`ok - narration stitch: ${name}`); }
try {
  await test('activity only vetoes disagreement; it never selects an amplitude trim point', () => {
    const aligned = planAlignmentSafeUnitEdit(base);
    assert.equal(aligned.trim_start_sample, 2880); assert.equal(aligned.trim_end_sample, 17760);
    for (const waveformActivity of [{ active_start_sec: .09 }, { active_end_sec: .9 }, { active_start_sec: .09, active_end_sec: .9 }]) {
      const preserved = planAlignmentSafeUnitEdit({ ...base, waveformActivity });
      assert.equal(preserved.mode, 'preserve_entire_unit_alignment_activity_conflict');
      assert.equal(preserved.trim_start_sample, 0); assert.equal(preserved.trim_end_sample, 24000);
      assert.equal(preserved.fade_in_samples, 0); assert.equal(preserved.fade_out_samples, 0); assert.equal(preserved.alignment_used, false);
    }
    const inSafety = planAlignmentSafeUnitEdit({ ...base, waveformActivity: { active_start_sec: .2, active_end_sec: .65 } });
    assert.deepEqual(inSafety, aligned);
    for (const waveformActivity of [null, {}, { active_start_sec: null, active_end_sec: null }, { active_end_sec: 'not-a-number' }]) assert.deepEqual(planAlignmentSafeUnitEdit({ ...base, waveformActivity }), aligned);
    assert.equal(planAlignmentSafeUnitEdit({ ...base, alignment: null, waveformActivity: { active_start_sec: .2, active_end_sec: .5 } }).retained_sample_count, 24000);
  });
  await test('the 20ms disagreement threshold uses exact sample rounding', () => {
    const aligned = planAlignmentSafeUnitEdit(base);
    const exact = planAlignmentSafeUnitEdit({ ...base, waveformActivity: { active_end_sec: (aligned.trim_end_sample + 480) / 24000 } });
    const beyond = planAlignmentSafeUnitEdit({ ...base, waveformActivity: { active_end_sec: (aligned.trim_end_sample + 481) / 24000 } });
    assert.equal(exact.mode, 'alignment_safe_trim'); assert.equal(beyond.mode, 'preserve_entire_unit_alignment_activity_conflict');
    assert.equal(planAlignmentSafeUnitEdit({ ...base, waveformActivity: { active_start_sec: (aligned.trim_start_sample - 480) / 24000 } }).mode, 'alignment_safe_trim');
    assert.equal(planAlignmentSafeUnitEdit({ ...base, waveformActivity: { active_start_sec: (aligned.trim_start_sample - 481) / 24000 } }).mode, 'preserve_entire_unit_alignment_activity_conflict');
  });
  await test('real stitch helper preserves all raw samples when activity extends past alignment', async () => {
    const sampleCount = 24000, pcm = Buffer.alloc(sampleCount * 2), wav = Buffer.alloc(44 + pcm.length);
    for (let i = 2400; i < 21600; i++) {
      const envelope = Math.min(1, (i - 2400) / 240, (21600 - i) / 240);
      pcm.writeInt16LE(Math.round(4000 * envelope * Math.sin(2 * Math.PI * 440 * i / 24000)), i * 2);
    }
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
    const rawPath = path.join(root, 'raw.wav'), outputPath = path.join(root, 'stitched.wav'); await fs.writeFile(rawPath, wav);
    const rawHash = await sha256File(rawPath);
    const row = { unit_id: 'fixture', provider: 'qwen_local', text: 'Keep this entire final syllable.', spoken_text: 'Keep this entire final syllable.', word_count: 5, wav: rawPath, duration_sec: 1, unit_qa: { status: 'passed', audio_sha256: rawHash, edge_alignment: base.alignment, metrics: { sample_count: sampleCount, duration_sec: 1, active_start_sec: .1, active_end_sec: .9, leading_silence_sample_count: 2400, trailing_silence_sample_count: 2400, rms_dbfs: -22 } } };
    const stitch = await stitchWavsForDiagnostics([row], outputPath, { narrationQualityContract: contract, workDir: root, skipRenderedTranscriptQa: true });
    assert.equal(stitch.status, 'passed'); assert.equal(stitch.prepared_inputs[0].sample_count, sampleCount); assert.equal(stitch.sample_accounting.exact_sample_accounting, true);
    assert.equal(stitch.prepared_inputs[0].preparation_policy.edit_plan.mode, 'preserve_entire_unit_alignment_activity_conflict');
    const decoded = (await exec('ffmpeg', ['-v', 'error', '-i', outputPath, '-f', 's16le', 'pipe:1'], { encoding: 'buffer' })).stdout;
    assert.deepEqual(decoded, pcm); assert.equal(await sha256File(rawPath), rawHash);
  });
  await test('changed editor or helper invalidates only derived stitch, preserving raw/ASR checkpoints', async () => {
    const boundaryEditorPath = path.join(root, 'editor.mjs'), stitchHelperPath = path.join(root, 'helper.mjs');
    await fs.writeFile(boundaryEditorPath, 'export const editor = 1;\n'); await fs.writeFile(stitchHelperPath, 'export const helper = 1;\n');
    const unit = { unit_id: 'fixture', spoken_text_sha256: '1'.repeat(64), audio_sha256: '2'.repeat(64), synthesis_identity_sha256: '3'.repeat(64) };
    const unitKey = narrationFinalizationUnitKey({ unit, qualityContractSha256: contract.contract_sha256 });
    const inputs = { narration_generation_plan_sha256: 'a'.repeat(64), ordered_unit_keys: [unitKey], quality_contract_sha256: contract.contract_sha256, stitch_sample_rate_hz: 24000, alignment_policy: 'narration_alignment_safe_semantic_stitch_v2' };
    const first = await narrationStitchImplementationIdentity({ boundaryEditorPath, stitchHelperPath });
    const key = narrationFinalizationStageKey('semantic_stitch', { ...inputs, stitch_implementation: first });
    const checkpoint = emptyNarrationFinalizationCheckpoint(); checkpoint.units.fixture = { unit_key: unitKey, primary: { text: 'Retained ASR result.' } }; checkpoint.stages.semantic_stitch = { input_key: key, status: 'passed', payload: { raw_wav_sha256: '4'.repeat(64) } };
    assert.ok(reusableNarrationFinalizationStage(checkpoint, 'semantic_stitch', key));
    assert.equal(reusableNarrationFinalizationStage(checkpoint, 'semantic_stitch', narrationFinalizationStageKey('semantic_stitch', { ...inputs, narration_generation_plan_sha256: 'b'.repeat(64), stitch_implementation: first })), null, 'changed authored boundary plan must invalidate derived stitch');
    assert.equal(reusableNarrationFinalizationStage(checkpoint, 'semantic_stitch', narrationFinalizationStageKey('semantic_stitch', inputs)), null, 'historical unhashed stitch must be invalidated');
    for (const file of [boundaryEditorPath, stitchHelperPath]) {
      await fs.appendFile(file, '// changed implementation\n');
      const changed = await narrationStitchImplementationIdentity({ boundaryEditorPath, stitchHelperPath });
      assert.notDeepEqual(changed, first);
      assert.equal(reusableNarrationFinalizationStage(checkpoint, 'semantic_stitch', narrationFinalizationStageKey('semantic_stitch', { ...inputs, stitch_implementation: changed })), null);
      assert.equal(reusableNarrationFinalizationUnit(checkpoint, unit.unit_id, unitKey).primary.text, 'Retained ASR result.');
    }
    await assert.rejects(narrationStitchImplementationIdentity({ boundaryEditorPath: path.join(root, 'missing'), stitchHelperPath }), { code: 'ENOENT' });
  });
  console.log(`Narration stitch implementation: ${count} test groups passed.`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
