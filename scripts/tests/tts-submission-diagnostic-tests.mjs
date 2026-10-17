import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK as LOCK } from '../lib/narration-tts-policy.mjs';
import { sha256File } from '../lib/file-hash.mjs';
import { validateSubmissionDiagnosticRecipe, readSubmissionDiagnosticSources, validateSubmissionDiagnosticManifest, validateSubmissionDiagnosticRawReport } from '../tts-submission-diagnostic.mjs';

const exec = promisify(execFile), digest = value => createHash('sha256').update(value).digest('hex');
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tts-submission-diagnostic-')));
const write = async (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const clone = structuredClone;
let count = 0;
async function test(name, body) { await body(); count++; console.log(`ok - bounded submission: ${name}`); }
function lineage(units) {
  const text = units.map(unit => unit.spoken_text).join(' ');
  const value = { schema: 'goldflow_spoken_text_lineage_v1', components: units.map(unit => ({ source_unit_id: unit.unit_id, source_text: unit.source_text, source_text_sha256: digest(unit.source_text), compiled_spoken_text: unit.spoken_text, compiled_spoken_text_sha256: digest(unit.spoken_text), transformation_receipts: [] })), pre_direction_spoken_text: text, pre_direction_spoken_text_sha256: digest(text), final_transformations: [], final_spoken_text: text, final_spoken_text_sha256: digest(text) };
  return { ...value, lineage_sha256: digest(JSON.stringify(value)) };
}
function fixture(texts = ['I held the door.', 'She carried the final crate.']) {
  const units = texts.map((text, index) => {
    const unit = { unit_id: `u${index + 1}`, source_text: text, caption_text: text, spoken_text: text, source_unit_refs: [{ source_unit_id: `u${index + 1}`, source_text: text, caption_text: text }] };
    unit.spoken_text_lineage = lineage([unit]); return unit;
  });
  const group = { source_unit_ids: units.map(unit => unit.unit_id), spoken_text: units.map(unit => unit.spoken_text).join(' '), source_unit_refs: clone(units.flatMap(unit => unit.source_unit_refs)), spoken_text_lineage: lineage(units), editorial_reason: 'The door action and her immediate reaction form one continuous thought.' };
  group.provider_request = { request: { text: group.spoken_text } };
  const recipe = { schema: 'goldflow_qwen_submission_diagnostic_recipe_v1', scope: 'diagnostic_only', author: 'Fixture editor', samples: [{ id: 'door-action', source_unit_ids: units.map(unit => unit.unit_id), groups: [group] }] };
  const plan = { status: 'passed', units, source_script_hash: digest(texts.join(' ')), plan_sha256: digest('fixture plan') };
  const report = { status: 'passed_with_warnings', results: units.map(unit => ({ unit_id: unit.unit_id, spoken_text_sha256: digest(unit.spoken_text), synthesis_identity: { ...LOCK, provider: 'qwen_local', voice: LOCK.voice_id, mlx_audio_version: LOCK.runtime_version, spoken_text: unit.spoken_text, spoken_text_sha256: digest(unit.spoken_text), seed: 41, synthesis_contract_id: 'qwen_liam_fixed_batch4_length_matched_v1', synthesis_mode: 'fixed_batch4_length_matched_v1', synthesis_api: 'Model.batch_generate', nominal_batch_size: 4, model_instance_count: 1, model_concurrency: 1, continuous_batching: false, post_tts_tempo_processing: false } })) };
  return { recipe, sources: [{ plan, report }] };
}
function manifestFixture(variants) {
  const expected = { output: root, recipe: { path: path.join(root, 'recipe.json'), sha256: digest('recipe') }, sourceHashes: { '/source/plan.json': digest('source') }, codeHashes: { '/code/runner.py': digest('code') }, environment: { runtime: { mlx_audio: LOCK.runtime_version, machine: 'arm64' }, bindings: { '/reference/dry.wav': LOCK.reference_audio_sha256 } }, variants };
  const manifest = { schema: 'goldflow_qwen_submission_diagnostic_v1', diagnostic_only: true, output_dir: root, recipe: clone(expected.recipe), source_hashes: clone(expected.sourceHashes), code_hashes: clone(expected.codeHashes), environment: clone(expected.environment), variants: clone(variants), model: { id: LOCK.model_id, revision: LOCK.model_revision }, reference: { path: LOCK.reference_audio_path, sha256: LOCK.reference_audio_sha256, text: LOCK.reference_text, text_sha256: LOCK.reference_text_sha256, voice_id: LOCK.voice_id, voice_sha256: LOCK.voice_sha256 }, execution: { mode: 'fixed_batch4_length_matched_v1', scheduler_version: 'stable_length_word_byte_source_id_v1', model_instance_count: 1, model_concurrency: 1, nominal_batch_size: 4, temperature: LOCK.temperature, top_p: LOCK.top_p, top_k: LOCK.top_k, repetition_penalty: LOCK.repetition_penalty, max_tokens: LOCK.max_tokens, max_audio_sec_per_arm: 120 } };
  return { manifest, expected };
}
try {
  await test('exact contiguous source requests become one authored payload with production batch-four cohorts', () => {
    const f = fixture(), before = clone(f), variants = validateSubmissionDiagnosticRecipe(f.recipe, f.sources);
    assert.deepEqual(f, before); assert.equal(variants[0].units.length, 2); assert.equal(variants[1].units.length, 1);
    assert.equal(variants[1].units[0].text, f.recipe.samples[0].groups[0].spoken_text);
    assert.equal(variants[0].batch_plan.cohorts[0].nominal_batch_size, 4);
    assert.equal(variants[0].batch_plan.cohorts[0].scheduler_version, 'stable_length_word_byte_source_id_v1');
    assert.equal(variants[0].batch_plan.cohorts[0].batch_seed, Number.parseInt(variants[0].batch_plan.cohorts[0].cohort_sha256.slice(0, 8), 16));
  });
  await test('drops, duplicates, reorders, payload edits and forged source lineage stop before synthesis', () => {
    const cases = [
      f => f.recipe.samples[0].groups[0].source_unit_ids.pop(),
      f => f.recipe.samples[0].source_unit_ids.reverse(),
      f => f.recipe.samples[0].source_unit_ids.push('u2'),
      f => f.recipe.samples[0].groups[0].spoken_text += ' Secret.',
      f => f.recipe.samples[0].groups[0].provider_request.request.text += ' Secret.',
      f => f.recipe.samples[0].groups[0].source_unit_refs[0].source_text = 'An invented fact.',
      f => f.recipe.samples[0].groups[0].spoken_text_lineage.final_spoken_text += ' Extra.',
      f => f.sources[0].report.results.push(clone(f.sources[0].report.results[0])),
      f => { f.recipe.samples[0].groups[0].editorial_reason = ''; },
    ];
    for (const [index, mutate] of cases.entries()) { const f = fixture(); mutate(f); assert.throws(() => validateSubmissionDiagnosticRecipe(f.recipe, f.sources), /Submission diagnostic:/, `mutation ${index}`); }
  });
  await test('actual dry model, reference, sampling, runtime and historical execution remain bound', () => {
    for (const [key, value] of [['reference_audio_sha256', digest('different')], ['model_revision', 'other'], ['temperature', .9], ['mlx_audio_version', '0.0'], ['voice', 'other'], ['nominal_batch_size', 1], ['post_tts_tempo_processing', true]]) {
      const f = fixture(); f.sources[0].report.results[0].synthesis_identity[key] = value;
      assert.throws(() => validateSubmissionDiagnosticRecipe(f.recipe, f.sources), /differs/);
    }
    const f = fixture(), identity = f.sources[0].report.results[0].synthesis_identity;
    Object.assign(identity, { synthesis_mode: 'serial_incomplete_unit_resume_v1', synthesis_api: 'Model.generate', nominal_batch_size: undefined, interrupted_incomplete_resume: true, recovery_provenance: { unit_id: 'u1', spoken_text_sha256: digest(f.sources[0].plan.units[0].spoken_text) }, origin_cohort_members: [{ unit_id: 'u1', spoken_text_sha256: digest(f.sources[0].plan.units[0].spoken_text) }] });
    const variants = validateSubmissionDiagnosticRecipe(f.recipe, f.sources);
    assert.equal(variants[0].units[0].historical_selection.mode, 'serial_incomplete_unit_resume_v1');
    assert.equal(variants[0].batch_plan.cohorts[0].synthesis_mode, 'fixed_batch4_length_matched_v1');
    delete identity.recovery_provenance; assert.throws(() => validateSubmissionDiagnosticRecipe(f.recipe, f.sources), /execution lock/);
  });
  await test('request/arm bounds, sentence completion and instruction-channel restrictions are enforced', () => {
    for (const texts of [['This has no terminal punctuation'], ['[pause] I held the door.'], [Array(61).fill('word').join(' ') + '.']]) {
      const f = fixture(texts); assert.throws(() => validateSubmissionDiagnosticRecipe(f.recipe, f.sources), /sentence-complete|instructions/);
    }
    const f = fixture(Array.from({ length: 4 }, () => `${Array(46).fill('word').join(' ')}.`));
    // Separate authored groups keep each request below 60; the aggregate exceeds 180.
    f.recipe.samples[0].groups = f.sources[0].plan.units.map(unit => ({ source_unit_ids: [unit.unit_id], spoken_text: unit.spoken_text, source_unit_refs: unit.source_unit_refs, spoken_text_lineage: unit.spoken_text_lineage, editorial_reason: 'A deliberate complete thought retained as its own bounded request.', provider_request: { request: { text: unit.spoken_text } } }));
    assert.throws(() => validateSubmissionDiagnosticRecipe(f.recipe, f.sources), /180 spoken words/);
  });
  await test('manifest edits cannot substitute a reference, drop provenance, alter recipe or expand execution', () => {
    const f = fixture(), { manifest, expected } = manifestFixture(validateSubmissionDiagnosticRecipe(f.recipe, f.sources));
    validateSubmissionDiagnosticManifest(manifest, expected);
    for (const mutate of [m => { m.reference.path = '/different.wav'; }, m => { m.reference.text_sha256 = digest('other'); }, m => { m.source_hashes = {}; }, m => { m.code_hashes = {}; }, m => { m.environment.bindings = {}; }, m => { m.recipe.sha256 = digest('other'); }, m => { m.execution.max_audio_sec_per_arm = 121; }, m => { m.variants.reverse(); }, m => { m.variants[0].batch_plan.cohorts[0].batch_seed++; }]) {
      const changed = clone(manifest); mutate(changed); assert.throws(() => validateSubmissionDiagnosticManifest(changed, expected), /Submission diagnostic:/);
    }
  });
  await test('source loader binds exact canonical script approval, lock and every dependency without mutation', async () => {
    const dir = path.join(root, 'source'); await fs.mkdir(dir); const f = fixture(), plan = f.sources[0].plan;
    plan.source_script_path = path.join(dir, 'script_clean.md'); await fs.writeFile(plan.source_script_path, plan.units.map(unit => unit.source_text).join(' '));
    plan.script_speakability_report_path = path.join(dir, 'speakability.json'); plan.tts_spoken_overrides_path = path.join(dir, 'overrides.json');
    await write(plan.script_speakability_report_path, { status: 'passed' }); await write(plan.tts_spoken_overrides_path, { approved: true }); await write(path.join(dir, 'run_identity.json'), { id: 'fixture identity' });
    plan.source_hashes = { script_speakability_report_sha256: await sha256File(plan.script_speakability_report_path), tts_spoken_overrides_sha256: await sha256File(plan.tts_spoken_overrides_path), run_identity_sha256: await sha256File(path.join(dir, 'run_identity.json')) };
    for (const [name, schema, status] of [['operator_script_approval.json', 'goldflow_operator_script_approval_v1', 'approved'], ['script_lock.json', 'goldflow_script_lock_v1', 'script_locked']]) await write(path.join(dir, name), { schema, status, approved: true, operator_approved: true, script_clean_path: plan.source_script_path, script_clean_hash: plan.source_script_hash });
    const sample = f.recipe.samples[0]; sample.source_plan_path = path.join(dir, 'plan.json'); sample.selected_narration_report_path = path.join(dir, 'report.json');
    await write(sample.source_plan_path, plan); await write(sample.selected_narration_report_path, f.sources[0].report);
    sample.source_plan_sha256 = await sha256File(sample.source_plan_path); sample.selected_narration_report_sha256 = await sha256File(sample.selected_narration_report_path);
    const recipePath = path.join(dir, 'recipe.json'); await write(recipePath, f.recipe);
    const loaded = await readSubmissionDiagnosticSources(recipePath); assert.equal(Object.keys(loaded.sourceHashes).length, 9);
    for (const [file, expected] of Object.entries(loaded.sourceHashes)) assert.equal(await sha256File(file), expected);
    await fs.appendFile(plan.tts_spoken_overrides_path, ' '); await assert.rejects(readSubmissionDiagnosticSources(recipePath), /stale bound file/);
    await fs.writeFile(plan.tts_spoken_overrides_path, `${JSON.stringify({ approved: true }, null, 2)}\n`);
    const approvalPath = path.join(dir, 'operator_script_approval.json'), approval = JSON.parse(await fs.readFile(approvalPath)); approval.operator_approved = false; await write(approvalPath, approval);
    await assert.rejects(readSubmissionDiagnosticSources(recipePath), /approval\/lock required/);
  });
  await test('Python runner rejects missing marker and retained prior output before importing MLX', async () => {
    const dir = path.join(root, 'attempt'); await fs.mkdir(dir); const manifestPath = path.join(dir, 'manifest.json');
    await write(manifestPath, { schema: 'goldflow_qwen_submission_diagnostic_v1', output_dir: dir });
    const runner = fileURLToPath(new URL('../tts-submission-diagnostic-runner.py', import.meta.url));
    await assert.rejects(exec('python3', [runner, '--manifest', manifestPath]), error => /attempt_started.json/.test(error.stderr) && !/No module named/.test(error.stderr));
    await write(path.join(dir, 'attempt_started.json'), { manifest_sha256: await sha256File(manifestPath), attempts_authorized: 1 });
    const retained = path.join(dir, 'retained.wav'); await fs.writeFile(retained, 'immutable failed attempt');
    await assert.rejects(exec('python3', [runner, '--manifest', manifestPath]), error => /no overwrite or resume/.test(error.stderr) && !/No module named/.test(error.stderr));
    assert.equal(await fs.readFile(retained, 'utf8'), 'immutable failed attempt'); assert.equal((await fs.readdir(dir)).length, 3);
  });
  await test('parent accepts exact raw receipt only, rejects changed wave bytes, false listening and incomplete arms', async () => {
    const f = fixture(), { manifest } = manifestFixture(validateSubmissionDiagnosticRecipe(f.recipe, f.sources));
    const report = { schema: 'goldflow_qwen_submission_diagnostic_raw_report_v1', status: 'passed', manifest_sha256: digest('manifest'), listening_performed: false, model_load_count: 1, variants: [] };
    for (const variant of manifest.variants) {
      const dir = path.join(root, variant.id); await fs.mkdir(dir); const arm = { id: variant.id, cohorts: variant.batch_plan.cohorts, results: [], audio_duration_sec: variant.units.length / 10 };
      for (const [index, unit] of variant.units.entries()) {
        const outputPath = path.join(dir, `${String(index + 1).padStart(3, '0')}_${unit.id}.wav`); await fs.writeFile(outputPath, Buffer.alloc(4800));
        const row = { ...unit, source_order_index: index, spoken_text_sha256: digest(unit.text), output_path: outputPath, output_sha256: await sha256File(outputPath), sample_rate_hz: 24000, sample_count: 2400, duration_sec: .1, token_count: 1, token_limit_reached: false };
        await write(outputPath.replace(/\.wav$/, '.json'), row); arm.results.push(row);
      }
      report.variants.push(arm);
    }
    const check = value => validateSubmissionDiagnosticRawReport({ manifest, manifestSha256: digest('manifest'), report: value }); await check(report);
    for (const mutate of [r => { r.listening_performed = true; }, r => { r.variants.pop(); }, r => { r.variants[0].results.reverse(); }, r => { r.variants[0].results[0].sample_rate_hz = 48000; }, r => { r.variants[0].results[0].sample_count = 0; }, r => { r.variants[0].results[0].token_limit_reached = true; }]) { const changed = clone(report); mutate(changed); await assert.rejects(check(changed), /Submission diagnostic:/); }
    await fs.appendFile(report.variants[0].results[0].output_path, 'altered'); await assert.rejects(check(report), /path\/hash mismatch/);
  });
  console.log(`Bounded submission diagnostic: ${count} test groups passed; no model loaded.`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
