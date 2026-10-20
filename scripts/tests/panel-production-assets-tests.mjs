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
import { fixturePageRaster } from './panel-production-fixture.mjs';
import { panelPageGeometryDir } from '../lib/panel-page-geometry.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = async (file, value) => { const bytes = JSON.stringify(value); await fs.writeFile(file, bytes); return sha(bytes); };
const exec = promisify(execFile);
async function fixture(t, imageProvider = 'codex_imagegen', { pages = false } = {}) {
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
  const candidate = pages ? { ...prepared.candidate, schema: 'goldflow_panel_asset_plan_v2', author: 'Fixture editor', asset_orders: [
    { asset_id: 'page_1', kind: 'page', page_template: 'P2V', owner_beat_id: 'beat_0', beat_ids: ['beat_0', 'beat_1', 'beat_2'], visual_brief: 'Letter and reaction on the left, the doorway on the right.', editorial_reason: 'One moment in one room.',
      zones: [
        { zone_id: 'page_1_z1', slot: 'left', beat_ids: ['beat_0', 'beat_1'], visual_brief: 'Character reads the letter; signature and face both visible.', editorial_reason: 'Detail then reaction crops.' },
        { zone_id: 'page_1_z2', slot: 'right', beat_ids: ['beat_2'], visual_brief: 'Character turns toward the open doorway.', editorial_reason: 'New orientation.' },
      ] },
  ], beat_bindings: [['beat_0', 'page_1_z1'], ['beat_1', 'page_1_z1'], ['beat_2', 'page_1_z2']].map(([beat_id, zone_id]) => ({ beat_id, asset_id: 'page_1', zone_id, editorial_reason: 'Exact zone binding.' })) } : { ...prepared.candidate, author: 'Fixture editor', asset_orders: [
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

test('reviewed Fal artwork repair refreshes only its dependent panels and retains prior media and unrelated QA', async t => {
  const f = await fixture(t, 'fal_ai');
  const makeOwner = async (prompt, folder, color) => {
    await fs.mkdir(f.p(folder), { recursive: true });
    const output = f.p(`${folder}/${prompt.image_id}.png`), receiptPath = `${output}.receipt.json`;
    await sharp({ create: { width: 320, height: 180, channels: 3, background: color } }).png().toFile(output);
    const imageHash = sha(await fs.readFile(output));
    const receipt = { output_path: output, output_sha256: imageHash, request_id: `${folder}-${prompt.image_id}` };
    const receiptHash = await json(receiptPath, receipt);
    return { result: { image_id: prompt.image_id, status: 'generated', image_path: output, generated: { ...receipt, provider: 'fal_ai', result_receipt_path: receiptPath, result_receipt_sha256: receiptHash } }, cut: { image_id: prompt.image_id, image_path: output, image_sha256: imageHash, provider: 'fal_ai' } };
  };
  const owners = await falArtworkOrders({ episodeDir: f.dir, prompts: f.prompts });
  const initial = await Promise.all(owners.map((p, i) => makeOwner(p, 'original', i ? '#aa3344' : '#3366aa')));
  const full = await completeFalPanelArtwork({ episodeDir: f.dir, prompts: f.prompts, results: initial.map(x => x.result), cuts: initial.map(x => x.cut) });
  full.cuts.forEach(row => { row.image_qa_status = 'approved'; });
  const preservedResult = JSON.stringify(full.results[2]), preservedCut = JSON.stringify(full.cuts[2]);
  const preservedMetadata = await fs.readFile(`${full.results[2].image_path}.metadata.json`, 'utf8');
  const oldAlias = structuredClone(full.results[1]);
  const repaired = await makeOwner(owners[0], 'reviewed-repair', '#33aa66');
  full.results[0] = repaired.result; full.cuts[0] = repaired.cut;
  const updated = await completeFalPanelArtwork({ episodeDir: f.dir, prompts: f.prompts, results: full.results, cuts: full.cuts, ownerImageIds: [owners[0].image_id] });
  assert.equal(updated.results[1].image_sha256, repaired.cut.image_sha256);
  assert.notEqual(updated.results[1].image_path, oldAlias.image_path);
  assert.equal(sha(await fs.readFile(oldAlias.image_path)), oldAlias.image_sha256);
  assert.equal(updated.results[1].generated.estimated_cost_usd, 0);
  assert.equal(updated.cuts[0].image_qa_status, 'pending');
  assert.equal(updated.cuts[1].image_qa_status, 'pending');
  assert.equal(JSON.stringify(updated.results[2]), preservedResult);
  assert.equal(JSON.stringify(updated.cuts[2]), preservedCut);
  assert.equal(await fs.readFile(`${updated.results[2].image_path}.metadata.json`, 'utf8'), preservedMetadata);
  await assert.rejects(completeFalPanelArtwork({ episodeDir: f.dir, prompts: f.prompts, results: updated.results, cuts: updated.cuts, ownerImageIds: ['ep_01-cut-002'] }), /owners/);
});

test('v2 page orders bind contiguous beat runs to template zones and reject ambiguous structure', async t => {
  const f = await fixture(t);
  const identity = JSON.parse(await fs.readFile(f.p('run_identity.json'), 'utf8'));
  const context = { beats: f.beats, identity, sourceHashes: f.allocation.plan.source_hashes };
  const page = () => ({
    schema: 'goldflow_panel_asset_plan_v2', episode: 'ep_01', author: 'Fixture editor', source_hashes: f.allocation.plan.source_hashes,
    asset_orders: [{ asset_id: 'page_1', kind: 'page', page_template: 'P2V', owner_beat_id: 'beat_0', beat_ids: ['beat_0', 'beat_1', 'beat_2'], visual_brief: 'Letter and reaction on the left, the doorway on the right.', editorial_reason: 'One moment in one room.',
      zones: [
        { zone_id: 'page_1_z1', slot: 'left', beat_ids: ['beat_0', 'beat_1'], visual_brief: 'Character reads the letter; signature and face both visible.', editorial_reason: 'Detail then reaction crops.' },
        { zone_id: 'page_1_z2', slot: 'right', beat_ids: ['beat_2'], visual_brief: 'Character turns toward the open doorway.', editorial_reason: 'New orientation.' },
      ] }],
    beat_bindings: [['beat_0', 'page_1_z1'], ['beat_1', 'page_1_z1'], ['beat_2', 'page_1_z2']].map(([beat_id, zone_id]) => ({ beat_id, asset_id: 'page_1', zone_id, editorial_reason: 'Exact zone binding.' })),
  });
  assert.equal(validatePanelAssetPlan(page(), context).asset_orders[0].zones.length, 2);
  const reject = (change, pattern) => { const plan = page(); change(plan); assert.throws(() => validatePanelAssetPlan(plan, context), pattern); };
  reject(plan => { plan.schema = 'goldflow_panel_asset_plan_v1'; }, /unsupported kind/);
  reject(plan => { plan.asset_orders[0].page_template = 'P9'; }, /supported page_template/);
  reject(plan => { plan.asset_orders[0].zones.pop(); }, /exactly 2 zones/);
  reject(plan => { plan.asset_orders[0].zones[1].slot = 'left'; }, /missing or repeated P2V slot/);
  reject(plan => { plan.asset_orders[0].zones[1].zone_id = 'page_1_z1'; }, /unique safe zone IDs/);
  reject(plan => { const [a, b] = plan.asset_orders[0].zones; a.beat_ids = ['beat_0', 'beat_2']; b.beat_ids = ['beat_1']; }, /contiguous/);
  reject(plan => { plan.asset_orders[0].zones[1].beat_ids = ['beat_1', 'beat_2']; }, /more than one zone/);
  reject(plan => { plan.asset_orders[0].zones[1].visual_brief = ' '; }, /authored visual brief/);
  reject(plan => { delete plan.beat_bindings[2].zone_id; }, /must name its page zone page_1_z2/);
  reject(plan => { plan.beat_bindings[2].zone_id = 'page_1_z1'; }, /must name its page zone page_1_z2/);
  reject(plan => { plan.asset_orders[0].zones = undefined; plan.asset_orders[0].kind = undefined; }, /declares zones without kind page|must name no zone/);
  const otherScene = page(); const beats = structuredClone(f.beats); beats[2].scene_id = 'scene_2';
  assert.throws(() => validatePanelAssetPlan(otherScene, { ...context, beats }), /one scene/);
  // Prompt planning receives the authored page structure with its zones.
  const projected = panelAssetOwnerRows(f.beats, page())[0].panel_asset_order;
  assert.equal(projected.kind, 'page');
  const { panelAssetOrderForPrompt } = await import('../lib/panel-production-assets.mjs');
  assert.deepEqual(panelAssetOrderForPrompt(projected).zones.map(zone => [zone.slot, zone.beat_ids]), [['left', ['beat_0', 'beat_1']], ['right', ['beat_2']]]);
});

test('Fal page owners carry their template and get a raster-keyed geometry receipt at finalization', async t => {
  const f = await fixture(t, 'fal_ai', { pages: true });
  const owners = await falArtworkOrders({ episodeDir: f.dir, prompts: f.prompts });
  assert.deepEqual(owners.map(row => [row.image_id, row.panel_page_template]), [['ep_01-cut-001', 'P2V']]);
  assert.deepEqual(f.prompts.map(row => row.panel_zone_id), ['page_1_z1', 'page_1_z1', 'page_1_z2']);
  const stale = structuredClone(f.prompts); stale[2].panel_zone_id = 'page_1_z1';
  await assert.rejects(falArtworkOrders({ episodeDir: f.dir, prompts: stale }), /page\/zone allocation mismatch/);
  const owner = async (folder, bytes) => {
    await fs.mkdir(f.p(folder), { recursive: true });
    const output = f.p(`${folder}/ep_01-cut-001.png`), receiptPath = `${output}.receipt.json`;
    await fs.writeFile(output, bytes);
    const hash = sha(bytes), receipt = { output_path: output, output_sha256: hash, request_id: `${folder}-page` };
    const receiptHash = await json(receiptPath, receipt);
    return { results: [{ image_id: 'ep_01-cut-001', status: 'generated', image_path: output, generated: { ...receipt, provider: 'fal_ai', result_receipt_path: receiptPath, result_receipt_sha256: receiptHash } }], cuts: [{ image_id: 'ep_01-cut-001', image_path: output, image_sha256: hash, provider: 'fal_ai' }], hash };
  };
  const good = await owner('page', await fixturePageRaster());
  const completed = await completeFalPanelArtwork({ episodeDir: f.dir, prompts: f.prompts, results: good.results, cuts: good.cuts });
  assert.equal(completed.page_geometry.length, 1);
  const receiptPath = path.join(panelPageGeometryDir(await fs.realpath(f.dir), 'page_1', good.hash), 'page_geometry.json');
  assert.equal(completed.page_geometry[0].path, receiptPath);
  assert.equal(completed.cuts[0].page_geometry.status, 'passed');
  assert.deepEqual(completed.cuts.map(row => row.page_geometry?.sha256), Array(3).fill(completed.page_geometry[0].sha256), 'aliases carry their page evidence');
  const receiptBytes = await fs.readFile(receiptPath);
  const again = await completeFalPanelArtwork({ episodeDir: f.dir, prompts: f.prompts, results: good.results, cuts: good.cuts.map(({ page_geometry, ...row }) => row) });
  assert.equal(again.page_geometry[0].sha256, completed.page_geometry[0].sha256);
  assert.ok(receiptBytes.equals(await fs.readFile(receiptPath)), 'an existing receipt is reused, never rewritten');
  // A page without its gutter is recorded as failed geometry; nothing is retried or guessed.
  const bad = await owner('page-bad', await sharp({ create: { width: 640, height: 360, channels: 3, background: '#335577' } }).png().toBuffer());
  const failed = await completeFalPanelArtwork({ episodeDir: f.dir, prompts: f.prompts, results: bad.results, cuts: bad.cuts });
  assert.equal(failed.cuts[0].page_geometry.status, 'failed');
  assert.equal(failed.cuts[0].page_geometry.findings[0].code, 'zone_count_mismatch');
});
