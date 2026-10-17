#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { sha256File } from './lib/file-hash.mjs';
import { QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK as LOCK } from './lib/narration-tts-policy.mjs';
import { buildNarrationTextIr, validateNarrationTextIr } from './lib/narration-text-ir.mjs';
import { hasTtsTerminalPunctuation } from './lib/tts-text-boundaries.mjs';
import { buildQwenLiamBatchPlan } from './lib/qwen-liam-batch-contract.mjs';

const exec = promisify(execFile), repo = fileURLToPath(new URL('../', import.meta.url));
const python = '/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-kokoro-mlx-audio-0.4.6/bin/python';
const runner = fileURLToPath(new URL('./tts-submission-diagnostic-runner.py', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const need = (ok, message) => { if (!ok) throw new Error(`Submission diagnostic: ${message}`); };
const wordCount = text => String(text).trim().split(/\s+/u).filter(Boolean).length;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(id);
const lockFields = ['model_id', 'model_revision', 'model_weights_sha256', 'model_config_sha256', 'generation_config_sha256', 'speech_tokenizer_weights_sha256', 'speech_tokenizer_config_sha256', 'voice_sha256', 'reference_audio_sha256', 'reference_text', 'reference_text_sha256', 'voice_continuity_contract', 'temperature', 'top_p', 'top_k', 'repetition_penalty', 'max_tokens'];

export function validateSubmissionDiagnosticRecipe(recipe, sources) {
  need(recipe?.schema === 'goldflow_qwen_submission_diagnostic_recipe_v1' && recipe.scope === 'diagnostic_only' && String(recipe.author ?? '').trim().length >= 3, 'authored diagnostic recipe required');
  need(recipe.samples?.length >= 1 && recipe.samples.length <= 3 && sources.length === recipe.samples.length, 'one to three explicit excerpts required');
  const variants = [{ id: 'original', units: [] }, { id: 'grouped', units: [] }], ids = new Set();
  recipe.samples.forEach((sample, sampleIndex) => {
    need(safeId(sample.id) && !ids.has(sample.id), 'unique safe excerpt IDs required'); ids.add(sample.id);
    const { plan, report } = sources[sampleIndex];
    need(plan.status === 'passed' && ['passed', 'passed_with_warnings', 'completed'].includes(report.status), 'passed source plan and selected narration report required');
    const units = plan.generation_units ?? plan.units ?? [], selected = report.results ?? [];
    const indexes = sample.source_unit_ids.map(id => units.findIndex(unit => unit.unit_id === id));
    need(indexes.length && indexes.every((value, index) => value >= 0 && (!index || value === indexes[index - 1] + 1)), 'excerpt must use exact contiguous source units in order');
    const original = indexes.map(index => units[index]);
    need(same(sample.groups?.flatMap(group => group.source_unit_ids), sample.source_unit_ids), 'candidate groups must cover excerpt exactly once and in order');
    original.forEach((unit, index) => {
      const matches = selected.filter(row => row.unit_id === unit.unit_id);
      need(matches.length === 1, 'exactly one selected synthesis result required');
      const result = matches[0], identity = result?.synthesis_identity;
      need(identity && result.token_limit_reached !== true, 'current selected synthesis identity required');
      for (const field of lockFields) need(identity[field] === LOCK[field], `selected ${field} differs from actual dry Joel lock`);
      need(identity.voice === LOCK.voice_id && identity.mlx_audio_version === LOCK.runtime_version && identity.provider === 'qwen_local', 'selected voice/provider/runtime differs');
      const batchSelection = identity.synthesis_mode === 'fixed_batch4_length_matched_v1' && identity.synthesis_api === 'Model.batch_generate' && identity.nominal_batch_size === 4;
      const retainedResume = identity.synthesis_mode === 'serial_incomplete_unit_resume_v1' && identity.synthesis_api === 'Model.generate' && identity.interrupted_incomplete_resume === true && identity.recovery_provenance?.unit_id === unit.unit_id && identity.recovery_provenance?.spoken_text_sha256 === hash(unit.spoken_text) && identity.origin_cohort_members?.some(member => member.unit_id === unit.unit_id && member.spoken_text_sha256 === hash(unit.spoken_text));
      need((batchSelection || retainedResume) && identity.synthesis_contract_id === 'qwen_liam_fixed_batch4_length_matched_v1' && identity.model_instance_count === 1 && identity.model_concurrency === 1 && identity.continuous_batching === false && identity.post_tts_tempo_processing === false, 'selected execution lock differs');
      need(identity.spoken_text === unit.spoken_text && identity.spoken_text_sha256 === hash(unit.spoken_text) && result.spoken_text_sha256 === identity.spoken_text_sha256, 'selected payload differs from approved source plan');
      variants[0].units.push({ id: `${sample.id}_old_${index + 1}`, excerpt_id: sample.id, text: unit.spoken_text, source_unit_ids: [unit.unit_id], historical_selection: { mode: identity.synthesis_mode, api: identity.synthesis_api, seed: identity.seed, cohort_id: identity.cohort_id ?? null, synthesis_identity_sha256: hash(JSON.stringify(identity)) } });
    });
    let offset = 0;
    sample.groups.forEach((group, index) => {
      const rows = original.slice(offset, offset + group.source_unit_ids.length); offset += rows.length;
      need(group.spoken_text === rows.map(row => row.spoken_text).join(' '), 'candidate must preserve exact joined original payloads, including punctuation');
      need(String(group.editorial_reason ?? '').trim().length >= 20, 'each grouping needs an explicit editorial reason');
      need(same(group.source_unit_refs, rows.flatMap(row => row.source_unit_refs)), 'source-component lineage differs');
      need(same(group.spoken_text_lineage?.components, rows.flatMap(row => row.spoken_text_lineage.components)), 'compiled component lineage differs');
      const unit = { unit_id: `${sample.id}_new_${index + 1}`, source_text: rows.map(row => row.source_text).join(' '), caption_text: rows.map(row => row.caption_text).join(' '), spoken_text: group.spoken_text, source_unit_refs: group.source_unit_refs, spoken_text_lineage: group.spoken_text_lineage, spoken_text_transformations: [...group.spoken_text_lineage.components.flatMap(component => component.transformation_receipts), ...group.spoken_text_lineage.final_transformations] };
      const ir = buildNarrationTextIr({ sourceScriptSha256: plan.source_script_hash, generationPlanSha256: plan.plan_sha256, units: [unit] });
      need(validateNarrationTextIr(ir, [unit]).status === 'passed', 'candidate exact source-to-spoken lineage does not close');
      need(group.provider_request?.request?.text === group.spoken_text, 'candidate provider payload differs');
      variants[1].units.push({ id: unit.unit_id, excerpt_id: sample.id, text: group.spoken_text, source_unit_ids: group.source_unit_ids, editorial_reason: group.editorial_reason });
    });
  });
  for (const variant of variants) {
    need(variant.units.reduce((sum, unit) => sum + wordCount(unit.text), 0) <= 180, 'arm exceeds 180 spoken words');
    for (const unit of variant.units) {
      need(wordCount(unit.text) >= 1 && wordCount(unit.text) <= 60 && hasTtsTerminalPunctuation(unit.text), 'every request must be sentence-complete and at most 60 words');
      need(!/\[(?:pause|calm|angry|whisper|emotion|speaker|narrator)[^\]]*\]|<\/?(?:speak|break|prosody|voice)\b|^(?:narrator|speaker|instruction)\s*:/im.test(unit.text), 'unsupported spoken instructions');
    }
    variant.batch_plan = buildQwenLiamBatchPlan(variant.units.map((unit, index) => ({ unit_id: unit.id, order_index: index, spoken_text: unit.text })));
  }
  return variants;
}

async function assertHashes(bindings) { for (const [file, expected] of Object.entries(bindings)) need(await sha256File(file) === expected, `stale bound file: ${file}`); }
async function codeIdentity() {
  const files = [fileURLToPath(import.meta.url), runner, ...['file-hash.mjs', 'narration-tts-policy.mjs', 'narration-text-ir.mjs', 'narration-spoken-text.mjs', 'tts-text-boundaries.mjs', 'qwen-liam-batch-contract.mjs'].map(name => fileURLToPath(new URL(`./lib/${name}`, import.meta.url)))];
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await sha256File(file)])));
}

const expectedReference = () => ({ path: LOCK.reference_audio_path, sha256: LOCK.reference_audio_sha256, text: LOCK.reference_text, text_sha256: LOCK.reference_text_sha256, voice_id: LOCK.voice_id, voice_sha256: LOCK.voice_sha256 });
const expectedExecution = () => ({ mode: 'fixed_batch4_length_matched_v1', scheduler_version: 'stable_length_word_byte_source_id_v1', model_instance_count: 1, model_concurrency: 1, nominal_batch_size: 4, temperature: LOCK.temperature, top_p: LOCK.top_p, top_k: LOCK.top_k, repetition_penalty: LOCK.repetition_penalty, max_tokens: LOCK.max_tokens, max_audio_sec_per_arm: 120 });

// Public pure check used by the runner preflight and adversarial regression tests.
export function validateSubmissionDiagnosticManifest(manifest, expected) {
  need(manifest?.schema === 'goldflow_qwen_submission_diagnostic_v1' && manifest.diagnostic_only === true && manifest.output_dir === expected.output, 'manifest/output identity mismatch');
  need(same(manifest.recipe, expected.recipe) && same(manifest.source_hashes, expected.sourceHashes), 'manifest source binding set differs');
  need(same(manifest.code_hashes, expected.codeHashes), 'manifest code binding set differs');
  need(same(manifest.environment, expected.environment), 'manifest environment binding set differs');
  need(same(manifest.variants, expected.variants), 'manifest payload/order differs from reviewed recipe');
  need(same(manifest.model, { id: LOCK.model_id, revision: LOCK.model_revision }) && same(manifest.reference, expectedReference()), 'manifest synthesis lock differs');
  need(same(manifest.execution, expectedExecution()), 'manifest execution settings differ');
}

export async function readSubmissionDiagnosticSources(recipePath) {
  const resolved = path.resolve(recipePath), recipeHash = await sha256File(resolved), recipe = await read(resolved), sourceHashes = { [resolved]: recipeHash }, sources = [];
  const bind = (file, expected) => {
    need(typeof file === 'string' && path.isAbsolute(file) && /^[a-f0-9]{64}$/.test(expected ?? ''), 'exact source path and SHA-256 required');
    need(!sourceHashes[file] || sourceHashes[file] === expected, 'conflicting source hash declarations'); sourceHashes[file] = expected;
  };
  for (const sample of recipe.samples ?? []) {
    bind(sample.source_plan_path, sample.source_plan_sha256); bind(sample.selected_narration_report_path, sample.selected_narration_report_sha256);
    await assertHashes(sourceHashes);
    const plan = await read(sample.source_plan_path), report = await read(sample.selected_narration_report_path), sourceDir = path.dirname(plan.source_script_path);
    bind(plan.source_script_path, plan.source_script_hash);
    bind(plan.script_speakability_report_path, plan.source_hashes.script_speakability_report_sha256);
    bind(plan.tts_spoken_overrides_path, plan.source_hashes.tts_spoken_overrides_sha256);
    bind(path.join(sourceDir, 'run_identity.json'), plan.source_hashes.run_identity_sha256);
    for (const [name, schema, status] of [['operator_script_approval.json', 'goldflow_operator_script_approval_v1', 'approved'], ['script_lock.json', 'goldflow_script_lock_v1', 'script_locked']]) {
      const file = path.join(sourceDir, name), approval = await read(file);
      need(approval.schema === schema && approval.status === status && approval.approved === true && approval.operator_approved === true && approval.script_clean_hash === plan.source_script_hash && approval.script_clean_path === plan.source_script_path, 'current exact source-script approval/lock required');
      bind(file, await sha256File(file));
    }
    sources.push({ plan, report });
  }
  await assertHashes(sourceHashes);
  return { recipe, recipeBinding: { path: resolved, sha256: recipeHash }, sourceHashes, sources, variants: validateSubmissionDiagnosticRecipe(recipe, sources) };
}

function assertExternalOutput(output) {
  need(!output.split(path.sep).includes('episodes') && !output.startsWith(repo), 'diagnostic output must be outside episode and repository folders');
}
async function gitIdentity() {
  const options = { cwd: repo, maxBuffer: 1024 * 1024 };
  const commit = (await exec('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
  const dirty = (await exec('git', ['status', '--porcelain'], options)).stdout.trim();
  need(!dirty, 'clean committed diagnostic code required before prepare/run'); return commit;
}
async function environmentBindings() {
  const runtime = JSON.parse((await exec(python, ['-c', 'import importlib.metadata as m,platform,json;print(json.dumps({"mlx_audio":m.version("mlx-audio"),"mlx":m.version("mlx"),"python":platform.python_version(),"machine":platform.machine()}))'])).stdout);
  need(runtime.mlx_audio === LOCK.runtime_version && runtime.machine === 'arm64', 'pinned local runtime unavailable');
  const snapshot = path.join(os.homedir(), '.cache/huggingface/hub', `models--${LOCK.model_id.replaceAll('/', '--')}`, 'snapshots', LOCK.model_revision);
  const bindings = { [LOCK.reference_audio_path]: LOCK.reference_audio_sha256, [LOCK.reference_metadata_path]: LOCK.reference_metadata_sha256, [LOCK.reference_manifest_path]: LOCK.reference_manifest_sha256 };
  for (const [name, field] of [['model.safetensors', 'model_weights_sha256'], ['config.json', 'model_config_sha256'], ['generation_config.json', 'generation_config_sha256'], ['speech_tokenizer/model.safetensors', 'speech_tokenizer_weights_sha256'], ['speech_tokenizer/config.json', 'speech_tokenizer_config_sha256']]) bindings[path.join(snapshot, name)] = LOCK[field];
  await assertHashes(bindings); return { runtime, bindings };
}

export async function prepareSubmissionDiagnostic({ recipePath, outputDir }) {
  const commit = await gitIdentity(), inputs = await readSubmissionDiagnosticSources(recipePath), environment = await environmentBindings();
  const parent = await fs.realpath(path.dirname(path.resolve(outputDir))), output = path.join(parent, path.basename(outputDir));
  assertExternalOutput(output);
  const manifest = { schema: 'goldflow_qwen_submission_diagnostic_v1', diagnostic_only: true, created_at: new Date().toISOString(), output_dir: output, recipe: inputs.recipeBinding, code_commit: commit, code_hashes: await codeIdentity(), source_hashes: inputs.sourceHashes, environment, model: { id: LOCK.model_id, revision: LOCK.model_revision }, reference: expectedReference(), execution: expectedExecution(), variants: inputs.variants, comparison_limitations: ['Fresh regrouping comparison: historical waveform/cohort results are not replayed.', 'Regrouping changes cohort composition, hash-derived batch seed and random-number consumption under the same production batch-four scheduler.', 'Raw outputs retain model-native silence. No trimming, pause insertion, mastering, production replacement or promotion.', 'No listening or naturalness acceptance is implied by generation or ASR.'] };
  await assertHashes(inputs.sourceHashes); await fs.mkdir(output);
  await fs.writeFile(path.join(output, 'manifest.json'), json(manifest), { flag: 'wx' });
  return { status: 'prepared', manifest_path: path.join(output, 'manifest.json'), manifest_sha256: await sha256File(path.join(output, 'manifest.json')), request_counts: inputs.variants.map(variant => ({ arm: variant.id, requests: variant.units.length, words: variant.units.reduce((sum, unit) => sum + wordCount(unit.text), 0) })) };
}

export async function validateSubmissionDiagnosticRawReport({ manifest, manifestSha256, report }) {
  need(report?.schema === 'goldflow_qwen_submission_diagnostic_raw_report_v1' && report.status === 'passed' && report.manifest_sha256 === manifestSha256 && report.listening_performed === false && report.model_load_count === 1, 'raw report lacks exact successful one-model identity');
  need(report.variants?.length === manifest.variants.length, 'raw report arm count mismatch');
  for (const [index, expected] of manifest.variants.entries()) {
    const arm = report.variants[index];
    need(arm.id === expected.id && arm.results?.length === expected.units.length, 'raw report request count mismatch');
    need(same(arm.cohorts, expected.batch_plan.cohorts), 'raw report cohort/seed plan differs');
    let duration = 0;
    for (const [unitIndex, unit] of expected.units.entries()) {
      const row = arm.results[unitIndex], outputPath = path.join(manifest.output_dir, expected.id, `${String(unitIndex + 1).padStart(3, '0')}_${unit.id}.wav`);
      need(row.id === unit.id && row.text === unit.text && same(row.source_unit_ids, unit.source_unit_ids) && row.source_order_index === unitIndex && row.spoken_text_sha256 === hash(unit.text), 'raw report exact payload/order mismatch');
      need(row.sample_rate_hz === 24000 && Number.isSafeInteger(row.sample_count) && row.sample_count > 0 && row.duration_sec === row.sample_count / 24000 && Number.isInteger(row.token_count) && row.token_count >= 0 && row.token_count < manifest.execution.max_tokens && row.token_limit_reached === false, 'raw report native sample/token limits failed');
      need(row.output_path === outputPath && await fs.realpath(outputPath) === outputPath && await sha256File(outputPath) === row.output_sha256, 'raw output path/hash mismatch');
      need(same(await read(outputPath.replace(/\.wav$/, '.json')), row), 'raw output sidecar mismatch');
      duration += row.duration_sec;
    }
    need(duration <= manifest.execution.max_audio_sec_per_arm && Math.abs(duration - arm.audio_duration_sec) < 1e-8, 'raw report exceeds duration scope or accounting differs');
  }
}

export async function runSubmissionDiagnostic({ manifestPath }) {
  const resolvedManifest = path.resolve(manifestPath), manifest = await read(resolvedManifest), output = await fs.realpath(path.dirname(resolvedManifest));
  assertExternalOutput(output);
  need(path.basename(resolvedManifest) === 'manifest.json', 'canonical manifest filename required');
  need(await gitIdentity() === manifest.code_commit, 'diagnostic commit changed; prepare a new immutable diagnostic');
  need(await sha256File(manifest.recipe.path) === manifest.recipe.sha256, 'recipe changed after preparation');
  const inputs = await readSubmissionDiagnosticSources(manifest.recipe.path), environment = await environmentBindings();
  validateSubmissionDiagnosticManifest(manifest, { output, recipe: inputs.recipeBinding, sourceHashes: inputs.sourceHashes, codeHashes: await codeIdentity(), environment, variants: inputs.variants });
  need(same((await fs.readdir(output)).sort(), ['manifest.json']), 'existing attempt/output retained; reruns are forbidden');
  const marker = { schema: 'goldflow_qwen_submission_diagnostic_attempt_v1', manifest_sha256: await sha256File(resolvedManifest), started_at: new Date().toISOString(), attempts_authorized: 1, model_load_authorized: true, listening_performed: false };
  await fs.writeFile(path.join(output, 'attempt_started.json'), json(marker), { flag: 'wx' });
  const startedAt = Date.now();
  const completion = { status: 'failed', listening_performed: false, provider_cost_usd: 0, cost_basis: 'local MLX compute; hardware/electricity not estimated' };
  try {
    const result = await exec(python, [runner, '--manifest', resolvedManifest], { timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
    await fs.writeFile(path.join(output, 'runner.log'), `${result.stdout}\n${result.stderr}`, { flag: 'wx' });
    await assertHashes(manifest.source_hashes); await assertHashes(manifest.code_hashes); await assertHashes(manifest.environment.bindings);
    need(await sha256File(resolvedManifest) === marker.manifest_sha256, 'manifest changed during synthesis');
    completion.report_path = path.join(output, 'raw_generation_report.json');
    await validateSubmissionDiagnosticRawReport({ manifest, manifestSha256: marker.manifest_sha256, report: await read(completion.report_path) });
    completion.status = 'passed'; completion.report_sha256 = await sha256File(completion.report_path);
  } catch (error) { completion.error = error.message; await fs.writeFile(path.join(output, 'runner_failure.log'), String(error.stderr ?? error.message), { flag: 'wx' }); throw error; }
  finally { completion.elapsed_sec = (Date.now() - startedAt) / 1000; completion.completed_at = new Date().toISOString(); await fs.writeFile(path.join(output, 'attempt_completed.json'), json(completion), { flag: 'wx' }); }
  return completion;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const flags = Object.fromEntries(process.argv.slice(2).reduce((rows, value, index, all) => value.startsWith('--') ? [...rows, [value.slice(2), all[index + 1]]] : rows, []));
  const action = flags.action === 'prepare' ? prepareSubmissionDiagnostic({ recipePath: flags.recipe, outputDir: flags['output-dir'] }) : flags.action === 'run' ? runSubmissionDiagnostic({ manifestPath: flags.manifest }) : Promise.reject(new Error('Use --action prepare --recipe <file> --output-dir <fresh-dir> or --action run --manifest <file>.'));
  action.then(result => console.log(json(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
