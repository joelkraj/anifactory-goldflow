import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { mediaWorkflowForPreflight } from '../lib/media-workflows.mjs';
import { createPanelProductionContract } from '../lib/panel-production-policy.mjs';
import { preparePanelAssetPlan, writePanelAssetPlan, loadPanelAssetPlan, validatePanelAssetPlan, panelAssetOwnerRows, expandPanelAssetPrompts, assertPanelPromptAllocation, materializePanelAssetAliases, reconcilePanelAssetReport } from '../lib/panel-production-assets.mjs';
import { falArtworkOrders, completeFalPanelArtwork } from '../lib/fal-panel-artwork.mjs';
import { imageReportComplete } from '../run-status.mjs';
import { plannerRecoveryPlaceholderForTests } from '../visual-plan.mjs';
import { mergeScopedPromptReplacements } from '../lib/visual-resolution-utils.mjs';
import { createCodexWorkManifest } from '../lib/codex-image-work-contract.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = async (file, value) => { const bytes = JSON.stringify(value); await fs.writeFile(file, bytes); return sha(bytes); };
const exec = promisify(execFile);
async function fixture(t, imageProvider = 'codex_imagegen') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-allocation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'channels', 'test', 'weekly_runs', 'test', 'episodes', 'ep_01');
  await fs.mkdir(dir, { recursive: true });
  const p = file => path.join(dir, file);
  const identity = { ...mediaWorkflowForPreflight({ contentProfile: 'manhwa_recap_v1', mediaWorkflow: 'generated_visuals_v1' }), schema: 'goldflow_run_identity_v2', run_intent: 'production', episode: 'ep_01', channel: 'test', week: 'test', content_profile: 'manhwa_recap_v1', media_workflow: 'generated_visuals_v1', render_profile: 'panel_composition_v1', panel_composition_contract: createPanelProductionContract(), audio_target: 'narrator_only', generated_motion_policy: 'disabled', parallax_policy: 'disabled', image_provider: imageProvider };
  await json(p('run_identity.json'), identity);
  const script = 'He opens the letter. His eyes linger on the signature. He faces the doorway.';
  await fs.writeFile(p('script_clean.md'), script);
  await json(p('operator_script_approval.json'), { operator_approved: true, script_clean_hash: sha(script) });
  await json(p('script_lock.json'), { script_clean_hash: sha(script) });
  const beats = [0, 1, 2].map(i => ({ visual_beat_id: `beat_${i}`, image_id_hint: `ep_01-cut-00${i + 1}`, scene_id: 'scene_1', start_sec: i * 4, end_sec: (i + 1) * 4, duration_sec: 4, visual_beat_script_excerpt: script.split('. ')[i], source_word_start_index: i * 4, source_word_end_index: i * 4 + 3 }));
  beats[1].quality_budget = { tier: 'priority', identity_critical: true };
  beats[1].visual_job = 'reaction_reveal';
  const hash = await json(p('visual_beat_plan.json'), { status: 'passed', source_script_hash: sha(script), beats, editorial_director: { grouping_lock_sha256: 'b'.repeat(64) } });
  await json(p('visual_beat_approval.json'), { status: 'approved', visual_beat_plan_sha256: hash, grouping_lock_sha256: 'b'.repeat(64) });
  const prepared = await preparePanelAssetPlan({ episodeDir: dir });
  const candidate = { ...prepared.candidate, author: 'Fixture editor', asset_orders: [
    { asset_id: 'letter_reaction', owner_beat_id: 'beat_0', beat_ids: ['beat_0', 'beat_1'], visual_brief: 'Character holds an open letter with the signature and attentive face both visible, allowing separate detail and reaction crops.', editorial_reason: 'These two beats observe the same held letter and facial reaction.' },
    { asset_id: 'doorway', owner_beat_id: 'beat_2', beat_ids: ['beat_2'], visual_brief: 'Character faces an open doorway.', editorial_reason: 'The changed orientation requires a new illustration.' },
  ], beat_bindings: beats.map((beat, i) => ({ beat_id: beat.visual_beat_id, asset_id: i < 2 ? 'letter_reaction' : 'doorway', editorial_reason: i < 2 ? 'Show the letter then the face from one coherent image.' : 'Show the changed orientation.' })) };
  await json(prepared.candidatePath, candidate);
  const allocation = await writePanelAssetPlan({ episodeDir: dir, planPath: prepared.candidatePath });
  const owners = panelAssetOwnerRows(beats, candidate).map(row => ({ ...row, image_id: row.image_id_hint, image_prompt: row.panel_asset_order.visual_brief, provider_prompt: row.panel_asset_order.visual_brief, codex_image_prompt: row.panel_asset_order.visual_brief, prompt_hash: sha(row.panel_asset_order.visual_brief), image_provider_route: 'codex_imagegen', shot_manifest: {}, reference_requirements: [], reference_slots: [] }));
  const prompts = expandPanelAssetPrompts(owners, allocation);
  const promptPath = p('section_image_prompts_hardened.json');
  await json(promptPath, { status: 'passed', prompts, image_provider: 'codex_imagegen' });
  return { root, dir, p, beats, prepared, candidate, allocation, owners, prompts, promptPath };
}

test('authored opening reuse creates two orders for three exact timed beats, with no quota or automatic regrouping', async t => {
  const f = await fixture(t);
  assert.equal(f.prepared.candidate.status, 'needs_authored_allocation');
  assert.equal(f.prepared.candidate.asset_orders.length, 0);
  assert.equal(f.allocation.plan.status, 'passed');
  assert.equal(f.allocation.plan.unique_asset_count, 2);
  assert.equal(f.prompts.length, 3);
  assert.equal(f.prompts[1].start_sec, 4);
  assert.equal(f.prompts[1].image_prompt, f.prompts[0].image_prompt);
  assert.equal(f.prompts[1].provider_submission_required, false);
  assert.equal(f.prompts[1].quality_budget.tier, 'priority');
  assert.equal(f.prompts[1].visual_job, 'reaction_reveal');
  assert.equal(f.prompts[1].reuse_source_image_id, 'ep_01-cut-001');
  assert.equal((await loadPanelAssetPlan({ episodeDir: f.dir })).planSha256, f.allocation.planSha256);
  await assert.rejects(writePanelAssetPlan({ episodeDir: f.dir, planPath: f.prepared.candidatePath }), /EEXIST/);
});

test('missing, duplicate, unknown or future-owner bindings fail without silent repair', async t => {
  const f = await fixture(t);
  for (const mutate of [
    p => p.beat_bindings.pop(),
    p => p.beat_bindings[1].beat_id = p.beat_bindings[0].beat_id,
    p => p.beat_bindings[1].asset_id = 'missing',
    p => p.asset_orders[0].owner_beat_id = 'beat_1',
    p => p.asset_orders[0].visual_brief = '',
    p => p.author = '',
  ]) { const plan = structuredClone(f.candidate); mutate(plan); assert.throws(() => validatePanelAssetPlan(plan, f.allocation), /Panel asset plan/); }
});

test('stale script, grouping or prompt allocation cannot dispatch', async t => {
  const f = await fixture(t);
  const altered = structuredClone(f.prompts); altered[1].provider_submission_required = true;
  await assert.rejects(assertPanelPromptAllocation({ episodeDir: f.dir, prompts: altered }), /provider allocation/);
  const stale = structuredClone(f.prompts); stale[0].panel_asset_plan_sha256 = '0'.repeat(64);
  await assert.rejects(assertPanelPromptAllocation({ episodeDir: f.dir, prompts: stale }), /stale prompt/);
  await fs.appendFile(f.p('script_clean.md'), ' Changed.');
  await assert.rejects(loadPanelAssetPlan({ episodeDir: f.dir }), /approved script/);
});

test('Codex and default browser-pool manifests lease owners only; explicit alias scopes are rejected', async t => {
  const f = await fixture(t);
  for (const options of [{}, { workProvider: 'hybrid_browser_pool', allowedBrowserProviders: ['chatgpt_web', 'google_flow'], browserProviderReceiptRequired: true }]) {
    const result = await createCodexWorkManifest({ mode: 'scene', episodeDir: f.dir, promptsPath: f.promptPath, stagingRoot: path.join(f.root, options.workProvider || 'codex'), ...options });
    assert.equal(result.manifest.item_count, 2);
    assert.deepEqual(new Set(result.manifest.items.map(row => row.asset_id)), new Set(['ep_01-cut-001', 'ep_01-cut-003']));
  }
  await assert.rejects(createCodexWorkManifest({ mode: 'scene', episodeDir: f.dir, promptsPath: f.promptPath, assetIds: ['ep_01-cut-002'] }), /scope|Unknown|missing/i);
});

test('shared alias materialization requires current owner provenance and does not claim missing artwork', async t => {
  const f = await fixture(t), source = f.p('ep_01-cut-001.png');
  await sharp({ create: { width: 320, height: 180, channels: 3, background: '#556677' } }).png().toFile(source);
  const donor = { image_id: 'ep_01-cut-001', status: 'generated', image_path: source, image_sha256: sha(await fs.readFile(source)) };
  await json(`${source}.metadata.json`, { panel_asset_id: 'letter_reaction', panel_asset_plan_sha256: '0'.repeat(64) });
  await assert.rejects(materializePanelAssetAliases({ episodeDir: f.dir, prompts: f.prompts, results: [donor] }), /donor provenance/);
  await json(`${source}.metadata.json`, { panel_asset_id: 'letter_reaction', panel_asset_plan_sha256: f.allocation.planSha256 });
  const results = await materializePanelAssetAliases({ episodeDir: f.dir, prompts: f.prompts, results: [donor] });
  assert.equal(results.length, 2);
  const alias = results[1]; assert.equal(alias.status, 'editorial_reuse');
  assert.equal(alias.image_sha256, donor.image_sha256);
  const sidecar = JSON.parse(await fs.readFile(`${alias.image_path}.metadata.json`, 'utf8'));
  assert.equal(sidecar.panel_asset_plan_sha256, f.allocation.planSha256);
  assert.equal(sidecar.reuse_source_image_id, donor.image_id);
  await fs.writeFile(alias.image_path, 'changed');
  await assert.rejects(materializePanelAssetAliases({ episodeDir: f.dir, prompts: f.prompts, results: [donor] }), /scoped recovery/);
});

test('actual provider import creates alias and ledger entries; complete stage waits for every unique owner', async t => {
  const f = await fixture(t);
  const script = path.resolve('scripts/codex-image-manual-import.mjs');
  for (const [index, imageId] of ['ep_01-cut-001', 'ep_01-cut-003'].entries()) {
    const source = path.join(f.root, `source-${index}.png`);
    await sharp({ create: { width: 320, height: 180, channels: 3, background: index ? '#aa3344' : '#3366aa' } }).png().toFile(source);
    await exec(process.execPath, [script, '--channel', 'test', '--week', 'test', '--episode', 'ep_01', '--image-id', imageId, '--source', source], { env: { ...process.env, ANIFACTORY_DATA_ROOT: f.root } });
    const report = JSON.parse(await fs.readFile(f.p('imagegen_report_ep_01.json'), 'utf8'));
    assert.equal(report.status, index ? 'passed' : 'partial');
    assert.equal(report.image_count, index ? 3 : 2);
  }
  const ledger = JSON.parse(await fs.readFile(f.p('cut_execution_ledger.json'), 'utf8'));
  assert.equal(ledger.status, 'passed');
  assert.equal(ledger.completed_image_count, 3);
  const alias = ledger.cuts.find(row => row.image_id === 'ep_01-cut-002');
  assert.equal(alias.generation_status, 'editorial_reuse');
  assert.equal(alias.panel_asset_plan_sha256, f.allocation.planSha256);
  assert.equal(alias.reuse_source_image_id, 'ep_01-cut-001');
  assert.equal((await imageReportComplete(f.dir, 'ep_01', f.allocation.identity)).done, true);
  await fs.unlink(alias.image_path);
  const reconciled = await reconcilePanelAssetReport({ episodeDir: f.dir, promptsPath: f.promptPath, imagegenReportPath: f.p('imagegen_report_ep_01.json'), cutExecutionLedgerPath: f.p('cut_execution_ledger.json') });
  assert.equal(reconciled.status, 'passed');
  assert.equal(reconciled.materialized_alias_count, 1);
  assert.equal((await imageReportComplete(f.dir, 'ep_01', f.allocation.identity)).done, true);
  const repairedLedger = JSON.parse(await fs.readFile(f.p('cut_execution_ledger.json'), 'utf8'));
  assert.equal(repairedLedger.completed_image_count, 3);
});

 test('scoped owner prompt repair updates all aliases and preserves unrelated owner prompts', async t => {
  const f = await fixture(t);
  const replacement = { ...f.prompts[0], image_prompt: 'Authored corrected letter composition', prompt_hash: sha('Authored corrected letter composition') };
  const merged = mergeScopedPromptReplacements(f.prompts, [replacement], { image_ids: [replacement.image_id] });
  const expanded = expandPanelAssetPrompts(merged, f.allocation);
  assert.equal(expanded[1].image_prompt, replacement.image_prompt);
  assert.equal(expanded[1].prompt_hash, replacement.prompt_hash);
  assert.equal(expanded[2].image_prompt, f.prompts[2].image_prompt);
  assert.equal(expanded[1].provider_submission_required, false);
 });

 test('mutated accepted owner bytes fail even when only generated output hash is present', async t => {
  const f = await fixture(t), source = f.p('ep_01-cut-001.png');
  await sharp({ create: { width: 320, height: 180, channels: 3, background: '#445566' } }).png().toFile(source);
  const accepted = sha(await fs.readFile(source));
  await json(`${source}.metadata.json`, { panel_asset_id: 'letter_reaction', panel_asset_plan_sha256: f.allocation.planSha256, generated: { output_sha256: accepted } });
  await fs.appendFile(source, 'mutated');
  await assert.rejects(materializePanelAssetAliases({ episodeDir: f.dir, prompts: f.prompts, results: [{ image_id: 'ep_01-cut-001', image_path: source, status: 'manual_imported', generated: { output_sha256: accepted } }] }), /donor image changed/);
 });

 test('historical manifests without a run identity remain usable while unbound panel markers reject', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-panel-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const promptPath = path.join(root, 'prompts.json');
  const prompt = { image_id: 'legacy_1', image_provider_route: 'codex_imagegen', image_prompt: 'An authored landscape', codex_image_prompt: 'An authored landscape', reference_requirements: [] };
  await json(promptPath, { status: 'passed', prompts: [prompt] });
  const result = await createCodexWorkManifest({ promptsPath: promptPath, episodeDir: root, stagingRoot: path.join(root, 'work') });
  assert.equal(result.manifest.item_count, 1);
  await assert.rejects(assertPanelPromptAllocation({ episodeDir: root, prompts: [{ ...prompt, provider_submission_required: false }] }), /explicitly locked/);
 });

 test('failed owner placeholders retain complete per-beat coverage and exact-owner repair clears dependent aliases', async t => {
  const f = await fixture(t);
  const ownerRows = panelAssetOwnerRows(f.beats, f.candidate);
  const placeholder = plannerRecoveryPlaceholderForTests({ ...ownerRows[0], panel_asset_plan_sha256: f.allocation.planSha256 });
  const partial = expandPanelAssetPrompts([placeholder, f.owners[1]], f.allocation);
  assert.equal(partial.length, 3);
  assert.equal(partial[0].planner_recovery_required, true);
  assert.equal(partial[1].planner_recovery_required, true);
  const merged = mergeScopedPromptReplacements(partial, [f.prompts[0]], { image_ids: [f.prompts[0].image_id] });
  const repaired = expandPanelAssetPrompts(merged, f.allocation);
  assert.equal(repaired.some(row => row.planner_recovery_required), false);
  await assertPanelPromptAllocation({ episodeDir: f.dir, prompts: repaired });
 });


test('Fal validation and paid bulk scope include only authored artwork owners', async t => {
  const f = await fixture(t, 'fal_ai');
  const owners = await falArtworkOrders({ episodeDir: f.dir, prompts: f.prompts });
  assert.deepEqual(owners.map(row => row.image_id), ['ep_01-cut-001', 'ep_01-cut-003']);
  await assert.rejects(falArtworkOrders({ episodeDir: f.dir, prompts: f.prompts, imageIds: ['ep_01-cut-002'] }), /owners/);
  const changed = structuredClone(f.prompts); changed[1].provider_submission_required = true;
  await assert.rejects(falArtworkOrders({ episodeDir: f.dir, prompts: changed }), /allocation/);
});

test('Fal accepted owners produce all panel aliases with zero additional requests and current ledger provenance', async t => {
  const f = await fixture(t, 'fal_ai');
  const results = [], cuts = [], protectedFiles = {};
  for (const [i, prompt] of (await falArtworkOrders({ episodeDir: f.dir, prompts: f.prompts })).entries()) {
    const output = f.p(`${prompt.image_id}.png`), receiptPath = f.p(`${prompt.image_id}-result.json`);
    await sharp({ create: { width: 320, height: 180, channels: 3, background: i ? '#aa3344' : '#3366aa' } }).png().toFile(output);
    const hash = sha(await fs.readFile(output));
    const receipt = { schema: 'goldflow_fal_result_receipt_v1', output_path: output, output_sha256: hash, request_id: `request-${i}` };
    const receiptHash = await json(receiptPath, receipt);
    protectedFiles[output] = hash; protectedFiles[receiptPath] = receiptHash;
    results.push({ image_id: prompt.image_id, status: 'generated', image_path: output, generated: { ...receipt, provider: 'fal_ai', result_receipt_path: receiptPath, result_receipt_sha256: receiptHash } });
    cuts.push({ image_id: prompt.image_id, image_path: output, image_sha256: hash, provider: 'fal_ai' });
  }
  const completed = await completeFalPanelArtwork({ episodeDir: f.dir, prompts: f.prompts, results, cuts });
  assert.equal(completed.results.length, 3); assert.equal(completed.cuts.length, 3);
  const alias = completed.results.find(row => row.image_id === 'ep_01-cut-002');
  assert.equal(alias.status, 'editorial_reuse'); assert.equal(alias.generated.estimated_cost_usd, 0);
  assert.equal(completed.cuts[1].reuse_source_image_id, 'ep_01-cut-001');
  assert.equal(completed.cuts[1].start_sec, 4); assert.equal(completed.cuts[1].panel_asset_plan_sha256, f.allocation.planSha256);
  for (const [file, hash] of Object.entries(protectedFiles)) assert.equal(sha(await fs.readFile(file)), hash);
  await json(f.p('imagegen_report_ep_01.json'), { status: 'passed', prompt_plan_hash: sha(await fs.readFile(f.promptPath)), expected_image_count: 3, image_count: 3, missing_image_count: 0, results: completed.results });
  await json(f.p('cut_execution_ledger.json'), { cuts: completed.cuts });
  assert.equal((await imageReportComplete(f.dir, 'ep_01', f.allocation.identity)).done, true);
  await fs.unlink(alias.image_path);
  assert.equal((await imageReportComplete(f.dir, 'ep_01', f.allocation.identity)).done, false);
  const reconciled = await reconcilePanelAssetReport({ episodeDir: f.dir, promptsPath: f.promptPath, imagegenReportPath: f.p('imagegen_report_ep_01.json'), cutExecutionLedgerPath: f.p('cut_execution_ledger.json') });
  assert.equal(reconciled.materialized_alias_count, 1);
  assert.equal((await imageReportComplete(f.dir, 'ep_01', f.allocation.identity)).done, true);
  await fs.appendFile(results[0].generated.result_receipt_path, ' ');
  await assert.rejects(completeFalPanelArtwork({ episodeDir: f.dir, prompts: f.prompts, results, cuts }), /receipt changed/);
});
