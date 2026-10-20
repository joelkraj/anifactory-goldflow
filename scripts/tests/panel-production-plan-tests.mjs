import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { panelProductionFixture, writeJson } from './panel-production-fixture.mjs';
import { readPanelProductionInputs, preparePanelProductionPlan, compilePanelProductionPlan, loadPanelProductionPlan } from '../lib/panel-production-plan.mjs';
import { validatePanelTimeline } from '../lib/panel-layout-validation.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-production-plan-'));
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
let count = 0;
async function test(name, body) { await body(); count++; console.log(`ok - panel production plan: ${name}`); }
async function authored(f) {
  const result = await preparePanelProductionPlan(f), recipe = await read(result.recipe_path);
  recipe.author = 'Fixture editor';
  recipe.decisions.forEach(row => { row.layout = 'inset'; row.editorial_reason = 'Hold the accepted artwork while the narrator describes it.'; });
  await writeJson(result.recipe_path, recipe);
  return { result, recipe, recipePath: result.recipe_path };
}
try {
  await test('official inputs produce a full-duration editable packet without authoring layouts', async () => {
    const f = await panelProductionFixture(path.join(root, 'prepare'));
    const review = await read(f.p('image_output_review_decisions_ep_01.json'));
    review.decisions[0].note = 'Keep the right-side outcome hidden until the spoken cue.';
    const reviewHash = await writeJson(f.p('image_output_review_decisions_ep_01.json'), review);
    const qa = await read(f.p('image_output_qa_ep_01.json'));
    qa.review_decisions_sha256 = reviewHash; await writeJson(f.p('image_output_qa_ep_01.json'), qa);
    const result = await preparePanelProductionPlan(f), recipe = await read(result.recipe_path), packet = await read(result.packet_path);
    assert.equal(result.status, 'needs_authoring'); assert.equal(recipe.author, null); assert.equal(recipe.decisions.every(row => row.layout === null), true);
    assert.deepEqual(packet.words.map(row => row.word), ['I', 'paid', 'two', 'dollars.']);
    assert.deepEqual(packet.beats.map(row => row.visual_beat_script_excerpt), ['I paid', '$2.']);
    assert.equal(packet.baseline.fps, 30); assert.equal(packet.baseline.width, 1920);
    assert.deepEqual(packet.image_review_decisions, review.decisions);
    assert.equal(packet.source_hashes[await fs.realpath(f.p('image_output_review_decisions_ep_01.json'))], reviewHash);
    await assert.rejects(compilePanelProductionPlan(f), /author/);
    await assert.rejects(preparePanelProductionPlan(f), /existing artifact retained/);
  });
  await test('compile preserves current audio, full beat coverage and accepted image hashes', async () => {
    const f = await panelProductionFixture(path.join(root, 'compile')), a = await authored(f);
    a.recipe.decisions[1].layout = 'reveal'; a.recipe.decisions[1].entry = { direction: 'right', start_sec: 1, duration_sec: .3 }; a.recipe.decisions[1].context = { panel_id: a.recipe.decisions[0].panel_id, rect: { x: .05, y: .05, width: .9, height: .9 }, fit: 'contain', end_sec: 1.5 };
    await writeJson(a.recipePath, a.recipe);
    const report = await compilePanelProductionPlan(f), loaded = await loadPanelProductionPlan(f);
    assert.equal(report.status, 'passed'); assert.equal(loaded.timeline.audio.sha256, f.audioHash);
    assert.deepEqual(loaded.timeline.scenes.map(row => [row.start_sec, row.end_sec]), [[0, 1], [1, 3]]);
    assert.equal(loaded.timeline.scenes[1].layers[1].keyframes[1].at_sec, 1.3);
    assert.ok(loaded.inputHashes[loaded.paths.timelinePath]); assert.ok(loaded.inputHashes[loaded.planPath]);
    assert.throws(() => validatePanelTimeline(loaded.timeline, 'editing_experiment'), /schema/);
    await fs.appendFile(f.p('image_a.png'), 'changed'); await assert.rejects(loadPanelProductionPlan(f), /stale/);
  });
  await test('narration preroll holds the first panel without shifting internal beats or word spans', async () => {
    const f = await panelProductionFixture(path.join(root, 'preroll'), { prerollSec: .12 });
    const loaded = await readPanelProductionInputs(f);
    assert.equal(loaded.timeline.narration_preroll_sec, .12);
    assert.equal(loaded.timeline.scenes[0].start_sec, 0);
    assert.equal(loaded.timeline.panels[0].metadata.source_start_sec, .12);
    assert.equal(loaded.beats[0].start_sec, .12);
    assert.equal(loaded.words[0].start_sec, .12);
    assert.equal(loaded.timeline.scenes[1].start_sec, 1);
  });
  await test('private or incomplete identities and stale audio cannot pass production loader', async () => {
    const f = await panelProductionFixture(path.join(root, 'identity'));
    const identity = await read(f.p('run_identity.json')); identity.render_profile = 'smooth_subpixel_ken_burns'; await writeJson(f.p('run_identity.json'), identity);
    await assert.rejects(readPanelProductionInputs(f), /new identity locked/);
    const audio = await panelProductionFixture(path.join(root, 'audio')); await fs.appendFile(audio.p('canonical.wav'), 'changed');
    await assert.rejects(readPanelProductionInputs(audio), /stale/);
  });
  await test('future context and substituted main panels fail without a renderable plan', async () => {
    const f = await panelProductionFixture(path.join(root, 'future')), a = await authored(f);
    a.recipe.decisions[0].background_panel_id = a.recipe.decisions[1].panel_id; await writeJson(a.recipePath, a.recipe);
    await assert.rejects(compilePanelProductionPlan(f), /future/);
    a.recipe.decisions[0].background_panel_id = a.recipe.decisions[0].panel_id;
    a.recipe.decisions[0].panel_id = a.recipe.decisions[1].panel_id; await writeJson(a.recipePath, a.recipe);
    await assert.rejects(compilePanelProductionPlan(f), /main panel/);
    await assert.rejects(fs.access(f.p('panel_composition_plan_ep_01.json')), { code: 'ENOENT' });
  });
  await test('recipe edits invalidate the official plan and retain previous compiled snapshots', async () => {
    const f = await panelProductionFixture(path.join(root, 'revision')), a = await authored(f);
    const before = await compilePanelProductionPlan(f);
    a.recipe.decisions[1].rect = { x: .15, y: .1, width: .7, height: .8 }; await writeJson(a.recipePath, a.recipe);
    await assert.rejects(loadPanelProductionPlan(f), /stale source/);
    const after = await compilePanelProductionPlan(f); assert.notEqual(after.timeline.sha256, before.timeline.sha256);
    assert.notEqual(after.retained_timeline.path, before.retained_timeline.path);
    await fs.access(before.retained_timeline.path); await loadPanelProductionPlan(f);
  });
  await test('missing risk review and unaccepted ledger rows block composition preparation', async () => {
    const f = await panelProductionFixture(path.join(root, 'qa'));
    const qa = await read(f.p('image_output_qa_ep_01.json')); qa.not_inspected_image_ids = ['image_b']; await writeJson(f.p('image_output_qa_ep_01.json'), qa);
    await assert.rejects(preparePanelProductionPlan(f), /unresolved image review/);
    const g = await panelProductionFixture(path.join(root, 'ledger')); const ledger = await read(g.p('cut_execution_ledger.json')); ledger.cuts[1].image_qa_status = 'pending'; await writeJson(g.p('cut_execution_ledger.json'), ledger);
    await assert.rejects(preparePanelProductionPlan(g), /cut ledger/);
  });
  await test('stripped QA links and contradictory audio paths cannot become current acceptance', async () => {
    const f = await panelProductionFixture(path.join(root, 'qa-link'));
    const qa = await read(f.p('image_output_qa_ep_01.json')); delete qa.prompt_plan_sha256; await writeJson(f.p('image_output_qa_ep_01.json'), qa);
    await assert.rejects(readPanelProductionInputs(f), /prompt binding/);
    const g = await panelProductionFixture(path.join(root, 'bed-link'));
    await fs.copyFile(g.p('canonical.wav'), g.p('different-master.wav'));
    const bed = await read(g.p('longform_audio_bed_report_ep_01.json')); bed.mix.render_input_path = g.p('different-master.wav'); await writeJson(g.p('longform_audio_bed_report_ep_01.json'), bed);
    await assert.rejects(readPanelProductionInputs(g), /final master and render input disagree/);
  });
  await test('page zones become panels cropped to their measured safe rectangles', async () => {
    const f = await panelProductionFixture(path.join(root, 'pages'), { pages: true });
    assert.equal(f.geometry.status, 'passed');
    const loaded = await readPanelProductionInputs(f);
    const [left, right] = f.geometry.zones;
    assert.deepEqual(loaded.timeline.panels.map(panel => panel.source_rect), [left.safe_rect, right.safe_rect]);
    assert.ok(left.safe_rect.x + left.safe_rect.width < right.safe_rect.x, 'zones never overlap the gutter or each other');
    assert.deepEqual(loaded.timeline.panels.map(panel => [panel.metadata.page_asset_id, panel.metadata.zone_id, panel.metadata.zone_slot]), [['page_0', 'page_0_z1', 'left'], ['page_0', 'page_0_z2', 'right']]);
    const receipt = await fs.realpath(f.geometry.receipt_path);
    assert.equal(loaded.inputHashes[receipt], loaded.timeline.panels[0].metadata.page_geometry_sha256);
    const a = await authored(f), compiled = await compilePanelProductionPlan({ ...f, recipePath: a.recipePath });
    const timeline = await read(compiled.timeline.path);
    for (const scene of timeline.scenes) {
      const crop = timeline.panels.find(panel => panel.id === scene.layers[0].panel_id).source_rect;
      const zone = loaded.timeline.panels.find(panel => panel.metadata.source_beat_id === scene.id).source_rect;
      assert.ok(crop.x >= zone.x - 1e-9 && crop.x + crop.width <= zone.x + zone.width + 1e-9, 'authored crops stay inside their zone');
    }
    assert.equal(compiled.source_hashes[receipt], loaded.inputHashes[receipt]);
  });
  await test('page zones fail closed without a current passed geometry for the accepted raster', async () => {
    const f = await panelProductionFixture(path.join(root, 'pages-missing'), { pages: true });
    await fs.rename(f.geometry.receipt_path, `${f.geometry.receipt_path}.moved`);
    await assert.rejects(readPanelProductionInputs(f), /ENOENT/);
    const tamper = async (name, change, pattern) => {
      const g = await panelProductionFixture(path.join(root, name), { pages: true });
      const geometry = await read(g.geometry.receipt_path); change(geometry); await writeJson(g.geometry.receipt_path, geometry);
      await assert.rejects(readPanelProductionInputs(g), pattern);
    };
    await tamper('pages-failed', row => { row.status = 'failed'; }, /passed P2V page geometry required/);
    await tamper('pages-template', row => { row.template = 'P2H'; }, /passed P2V page geometry required/);
    await tamper('pages-raster', row => { row.raster_sha256 = 'f'.repeat(64); }, /does not measure the accepted raster/);
    await tamper('pages-slot', row => { row.zones = row.zones.filter(zone => zone.slot !== 'right'); }, /measured right zone missing/);
  });
  console.log(`Panel production plan: ${count} test groups passed.`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
