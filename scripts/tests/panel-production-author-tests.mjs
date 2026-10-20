import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sha256File } from '../lib/file-hash.mjs';
import { panelProductionFixture } from './panel-production-fixture.mjs';
import { preparePanelProductionPlan, compilePanelProductionPlan } from '../lib/panel-production-plan.mjs';
import { panelAuthorChunks, validatePanelAuthorResponse, authorPanelProduction, snapPanelAuthorRects } from '../lib/panel-production-author.mjs';

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const box = { x: 0, y: 0, width: 1, height: 1 };
const responseFor = scenes => ({ decisions: scenes.map(scene => ({ scene_id: scene.id, panel_id: scene.panel_id ?? scene.layers[0].panel_id,
  background_panel_id: scene.panel_id ?? scene.layers[0].panel_id, layout: 'inset', source_rect: { ...box }, rect: { x: .05, y: .05, width: .9, height: .9 },
  fit: 'contain', camera_from: { x: .5, y: .5, zoom: 1 }, camera_to: { x: .5, y: .5, zoom: 1 }, entry: null, context: null,
  editorial_reason: 'Hold the inspected fixture artwork while the matching narration completes its thought.',
  region_evidence: 'The fixture raster fills this source crop and its edges remain visible in the inset.' })) });

async function fixture(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `panel-author-${name}-`));
  const f = await panelProductionFixture(path.join(root, 'episode'));
  const prepared = await preparePanelProductionPlan(f), packet = await read(prepared.packet_path);
  return { ...f, root, packet, repoRoot: process.cwd() };
}

test('request grouping preserves parent scenes and shared-raster beat order without choosing layouts', async () => {
  const f = await fixture('groups');
  try {
    const chunks = panelAuthorChunks(f.packet, { maxImages: 1 });
    assert.equal(chunks.length, 2); assert.deepEqual(chunks.flatMap(c => c.scenes.map(s => s.id)), f.packet.baseline.scenes.map(s => s.id));
    f.packet.baseline.assets[1].sha256 = f.packet.baseline.assets[0].sha256;
    assert.equal(panelAuthorChunks(f.packet, { maxImages: 1 }).length, 1);
    f.packet.beats[1].parent_scene_id = 'different_parent';
    assert.equal(panelAuthorChunks(f.packet).length, 2);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('response validation rejects missing beats, invented images, future context, blank evidence and invalid crops', async () => {
  const f = await fixture('validation');
  try {
    const chunk = panelAuthorChunks(f.packet)[0], baseline = f.packet.baseline;
    assert.equal(validatePanelAuthorResponse(responseFor(chunk.scenes), chunk, baseline).length, 2);
    for (const mutate of [r => r.decisions.pop(), r => { r.decisions[0].panel_id = 'invented'; },
      r => { r.decisions[0].background_panel_id = r.decisions[1].panel_id; },
      r => { r.decisions[0].region_evidence = ''; }, r => { r.decisions[0].source_rect.width = 1.1; },
      r => { r.decisions[0].camera_to.zoom = 0.5; }, r => { r.decisions[1].scene_id = r.decisions[0].scene_id; }]) {
      const response = responseFor(chunk.scenes); mutate(response);
      assert.throws(() => validatePanelAuthorResponse(response, chunk, baseline));
    }
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('native author receives actual raster paths, narration, times and review notes; cached output does not redispatch', async () => {
  const f = await fixture('author'); let calls = 0;
  try {
    const executor = async ({ prompt, images, outputPath }) => {
      calls++; const envelope = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
      assert.equal(images.length, 2); for (const file of images) assert.ok((await fs.stat(file)).isFile());
      assert.deepEqual(envelope.beats.map(b => b.narration), ['I paid', '$2.']);
      assert.equal(envelope.words.length, 4); assert.equal(envelope.image_review_decisions.length, 2);
      const response = responseFor(envelope.scenes); await fs.writeFile(outputPath, JSON.stringify(response)); return response;
    };
    const before = await fs.readFile(f.p('panel_composition_recipe_ep_01.json'));
    const result = await authorPanelProduction({ ...f, executor });
    assert.equal(result.status, 'candidate_ready'); assert.equal(result.new_planner_calls, 1); assert.equal(result.media_provider_calls, 0);
    assert.deepEqual(await fs.readFile(f.p('panel_composition_recipe_ep_01.json')), before);
    assert.equal(await fs.stat(f.p('panel_composition_plan_ep_01.json')).then(() => true, () => false), false);
    const resumed = await authorPanelProduction({ ...f, executor }); assert.equal(calls, 1); assert.equal(resumed.cached_chunks, 1);
    assert.equal(resumed.recipe_sha256, result.recipe_sha256); assert.notEqual(resumed.report_path, result.report_path);
    const chunkDir = path.join(path.dirname(result.report_path), 'chunks');
    const [chunkName] = await fs.readdir(chunkDir), retained = path.join(chunkDir, chunkName), changed = path.join(chunkDir, 'chunk_001-old-contract.json');
    await fs.rename(retained, changed);
    await assert.rejects(authorPanelProduction({ ...f, executor }), /changed author contract requires reviewed reconciliation/);
    assert.equal(calls, 1); await fs.rename(changed, retained);
    const compiled = await compilePanelProductionPlan({ episodeDir: f.episodeDir, recipePath: result.recipe_path });
    assert.equal(compiled.status, 'passed'); assert.equal(compiled.beat_count, 2);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('failed author scope is retained and cannot trigger an automatic creative retry', async () => {
  const f = await fixture('failure'); let calls = 0;
  try {
    const executor = async ({ outputPath }) => { calls++; await fs.writeFile(outputPath, '{"decisions":[]}'); return { decisions: [] }; };
    const result = await authorPanelProduction({ ...f, executor });
    assert.equal(result.status, 'needs_exact_repair'); assert.deepEqual(result.failed_chunk_ids, ['chunk_001']);
    assert.equal(result.recipe_path, undefined); assert.ok((await fs.stat(result.report_path)).isFile());
    await assert.rejects(authorPanelProduction({ ...f, executor }), /failed chunk retained/); assert.equal(calls, 1);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('stale source raster blocks authoring before any planner call', async () => {
  const f = await fixture('stale'); let calls = 0;
  try {
    await fs.appendFile(f.p('image_a.png'), 'changed');
    await assert.rejects(authorPanelProduction({ ...f, executor: async () => { calls++; } }));
    assert.equal(calls, 0);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});


test('contain rejects internal letterboxing while aspect-matched panels and safe cover fill', async () => {
  const f = await fixture('fill');
  try {
    const chunk = panelAuthorChunks(f.packet)[0], r = responseFor(chunk.scenes);
    r.decisions[0].source_rect = { x: .2, y: .4, width: .6, height: .2 };
    assert.throws(() => validatePanelAuthorResponse(r, chunk, f.packet.baseline), /unfilled panel viewport/);
    r.decisions[0].rect.height = .3;
    assert.equal(validatePanelAuthorResponse(r, chunk, f.packet.baseline).length, 2);
    r.decisions[0].rect.height = .9; r.decisions[0].fit = 'cover';
    assert.equal(validatePanelAuthorResponse(r, chunk, f.packet.baseline).length, 2);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('rect snap repairs only contain aspect mismatches and records each change', async () => {
  const f = await fixture('snap');
  try {
    const chunk = panelAuthorChunks(f.packet)[0], r = responseFor(chunk.scenes);
    r.decisions[0].source_rect = { x: .2, y: .4, width: .6, height: .2 };
    const before = structuredClone(r.decisions[0]);
    const snaps = snapPanelAuthorRects(r, f.packet.baseline);
    assert.equal(snaps.length, 1); assert.equal(snaps[0].field, 'rect');
    assert.equal(validatePanelAuthorResponse(r, chunk, f.packet.baseline).length, 2, 'snapped rect now fills its viewport');
    const after = r.decisions[0];
    assert.deepEqual([after.source_rect, after.layout, after.camera_from, after.fit], [before.source_rect, before.layout, before.camera_from, before.fit], 'only the rect changes');
    assert.ok(Math.abs((after.rect.y + after.rect.height / 2) - (before.rect.y + before.rect.height / 2)) < 1e-6, 'centre kept');
    assert.deepEqual(snapPanelAuthorRects(r, f.packet.baseline), [], 'idempotent');
    r.decisions[0].rect.height = .9; r.decisions[0].fit = 'cover';
    assert.deepEqual(snapPanelAuthorRects(r, f.packet.baseline), [], 'cover crops are never resized');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('reviewed exact manual reconciliation preserves original bytes and dispatches no replacement request', async () => {
  const f = await fixture('reconcile'); let calls = 0;
  try {
    const executor = async ({ outputPath }) => {
      calls++; const response = responseFor(panelAuthorChunks(f.packet)[0].scenes);
      await fs.writeFile(outputPath, JSON.stringify(response)); return response;
    };
    const first = await authorPanelProduction({ ...f, executor });
    const chunkDir = path.join(path.dirname(first.report_path), 'chunks');
    const [name] = await fs.readdir(chunkDir), original = path.join(chunkDir, name), old = path.join(chunkDir, 'chunk_001-old-contract.json');
    await fs.rename(original, old);
    const before = await fs.readFile(old), prior = JSON.parse(before), rawBefore = await fs.readFile(prior.raw_output_path);
    const response = structuredClone(prior.response);
    response.decisions[0].editorial_reason = 'Reviewed manual framing correction preserves the entire source rectangle and all fixture artwork.';
    const review = f.p('actual-frame-review.json');
    await fs.writeFile(review, JSON.stringify({ actual_composed_frames_reviewed: true, note: 'Fixture review evidence only.' }));
    const spec = { schema: 'goldflow_panel_author_reviewed_overrides_v1', source_packet_sha256: first.source_packet.sha256,
      reviewer: 'Fixture reviewer', actual_composed_frames_reviewed: true, note: 'Manually reviewed the exact existing frame candidate and corrected its framing.',
      frame_review: { path: review, sha256: await sha256File(review) },
      overrides: [{ chunk_id: 'chunk_001', previous_chunk_path: old, previous_chunk_sha256: await sha256File(old),
        reason: 'Exact fixture scope reviewed; retain original native output and apply only this explicit decision.', response }] };
    const specPath = f.p('reviewed-overrides.json');
    const write = () => fs.writeFile(specPath, JSON.stringify(spec));
    await write();
    const saved = spec.overrides[0].previous_chunk_sha256;
    spec.overrides[0].previous_chunk_sha256 = '0'.repeat(64); await write();
    await assert.rejects(authorPanelProduction({ ...f, executor, reviewedOverridesPath: specPath }), /previous chunk binding changed/);
    spec.overrides[0].previous_chunk_sha256 = saved;
    spec.overrides.push(structuredClone(spec.overrides[0])); await write();
    await assert.rejects(authorPanelProduction({ ...f, executor, reviewedOverridesPath: specPath }), /unknown or duplicate override/);
    spec.overrides.pop(); await write();
    const repaired = await authorPanelProduction({ ...f, executor, reviewedOverridesPath: specPath });
    assert.equal(repaired.status, 'candidate_ready'); assert.equal(repaired.new_planner_calls, 0);
    assert.deepEqual(repaired.reviewed_reconciliations, ['chunk_001']); assert.equal(calls, 1);
    assert.deepEqual(await fs.readFile(old), before); assert.deepEqual(await fs.readFile(prior.raw_output_path), rawBefore);
    const resumed = await authorPanelProduction({ ...f, executor });
    assert.equal(resumed.recipe_sha256, repaired.recipe_sha256); assert.equal(calls, 1);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('authored cuts play several crops of one artwork within a beat, each validated, snapped and readable', async () => {
  const { compilePanelComposition } = await import('../lib/panel-composition-authoring.mjs');
  const f = await fixture('cuts');
  try {
    const chunk = panelAuthorChunks(f.packet)[0], baseline = structuredClone(f.packet.baseline);
    // Stretch the fixture's 1s/2s beats so a beat can hold two readable shots.
    baseline.scenes[0].end_sec = baseline.scenes[1].start_sec = 3; baseline.scenes[1].end_sec = baseline.duration_sec = 6;
    for (const scene of baseline.scenes) for (const layer of scene.layers) { layer.start_sec = scene.start_sec; layer.end_sec = scene.end_sec; }
    const scene = baseline.scenes[0];
    const mid = scene.start_sec + (scene.end_sec - scene.start_sec) / 2;
    const r = responseFor(chunk.scenes);
    r.decisions[0].cuts = [{ start_sec: mid, source_rect: { x: .2, y: .4, width: .6, height: .2 }, camera_from: { x: .5, y: .5, zoom: 1 }, camera_to: { x: .5, y: .5, zoom: 1.1 }, region_evidence: 'The lower band holds the fixture detail the narration names next.' }];
    assert.throws(() => validatePanelAuthorResponse(structuredClone(r), chunk, baseline), /unfilled panel viewport .* cut/);
    const snaps = snapPanelAuthorRects(r, baseline);
    assert.deepEqual(snaps.map(row => row.field), ['cuts[0].rect']);
    assert.equal(validatePanelAuthorResponse(r, chunk, baseline).length, 2);
    const recipe = { schema: 'goldflow_panel_composition_recipe_v1', author: 'Fixture editor', decisions: r.decisions };
    const compiled = compilePanelComposition(baseline, recipe, { mode: 'production_panel_composition' });
    const layers = compiled.scenes[0].layers;
    assert.deepEqual(layers.map(layer => [layer.start_sec, layer.end_sec]), [[scene.start_sec, mid], [mid, scene.end_sec]]);
    assert.equal(compiled.panels.find(panel => panel.id === layers[1].panel_id).metadata.derived_from_panel_id, r.decisions[0].panel_id);
    r.decisions[0].cuts[0].start_sec = scene.end_sec - 0.5;
    assert.throws(() => compilePanelComposition(baseline, recipe, { mode: 'production_panel_composition' }), /at least 1.2s/);
    r.decisions[0].cuts[0].start_sec = mid; r.decisions[0].layout = 'reveal';
    assert.throws(() => compilePanelComposition(baseline, recipe, { mode: 'production_panel_composition' }), /entry and context required|cuts are only supported/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('sibling zones of a shown page are offered as context, never later ones', async () => {
  const { authorPromptPanels } = await import('../lib/panel-production-author.mjs');
  const f = await fixture('siblings');
  try {
    const baseline = structuredClone(f.packet.baseline), [a, b] = baseline.scenes;
    const panel = id => baseline.panels.find(row => row.id === id);
    for (const scene of [a, b]) panel(scene.layers[0].panel_id).metadata = { ...panel(scene.layers[0].panel_id).metadata, page_asset_id: 'page_1' };
    const ids = rows => rows.map(row => row.id);
    assert.deepEqual(ids(authorPromptPanels(baseline, { scenes: [b] }, null)), [a.layers[0].panel_id, b.layers[0].panel_id], 'earlier sibling offered');
    assert.deepEqual(ids(authorPromptPanels(baseline, { scenes: [a] }, null)), [a.layers[0].panel_id], 'later sibling withheld');
    delete panel(a.layers[0].panel_id).metadata.page_asset_id;
    assert.deepEqual(ids(authorPromptPanels(baseline, { scenes: [b] }, null)), [b.layers[0].panel_id], 'non-siblings stay out');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('impact adds a decaying shake on a held shot and unlocks a short cut burst, never a short last shot', async () => {
  const { compilePanelComposition } = await import('../lib/panel-composition-authoring.mjs');
  const f = await fixture('impact');
  try {
    const chunk = panelAuthorChunks(f.packet)[0], baseline = structuredClone(f.packet.baseline);
    baseline.scenes[0].end_sec = baseline.scenes[1].start_sec = 3; baseline.scenes[1].end_sec = baseline.duration_sec = 6;
    for (const scene of baseline.scenes) for (const layer of scene.layers) { layer.start_sec = scene.start_sec; layer.end_sec = scene.end_sec; }
    const r = responseFor(chunk.scenes), crop = { x: 0, y: 0, width: 1, height: 1 }, still = { x: .5, y: .5, zoom: 1 };
    const shot = start_sec => ({ start_sec, source_rect: crop, camera_from: still, camera_to: still, region_evidence: 'The fixture raster fills this crop; its edges remain visible.' });
    r.decisions[0].impact = { at_sec: 1, duration_sec: 0.3 };
    r.decisions[0].cuts = [shot(1.4), shot(1.8)];
    const recipe = { schema: 'goldflow_panel_composition_recipe_v1', author: 'Fixture editor', decisions: r.decisions };
    const compile = () => compilePanelComposition(baseline, recipe, { mode: 'production_panel_composition' });
    const [main, burst, last] = compile().scenes[0].layers;
    assert.deepEqual([main.end_sec, burst.end_sec - burst.start_sec, last.end_sec - last.start_sec].map(v => Math.round(v * 100) / 100), [1.4, 0.4, 1.2]);
    const base = main.keyframes[0].rect, shaken = main.keyframes.filter(k => k.at_sec > 1 && k.at_sec < 1.3);
    assert.ok(shaken.length >= 5 && shaken.some(k => Math.abs(k.rect.x - base.x) > 0.005), 'shake moves the panel');
    assert.deepEqual(main.keyframes.find(k => Math.abs(k.at_sec - 1.3) < 1e-9).rect, base, 'shake settles back exactly');
    assert.ok(Math.abs(shaken[0].rect.x - base.x) > Math.abs(shaken.at(-1).rect.x - base.x), 'shake decays');
    r.decisions[0].cuts = [shot(1.4), shot(2.6)];
    assert.throws(compile, /never the last/, 'a burst may not end the beat on a flash');
    r.decisions[0].cuts = [shot(1.4), shot(1.8)]; r.decisions[0].camera_to = { x: .5, y: .5, zoom: 1.2 };
    assert.throws(compile, /held panel/);
    r.decisions[0].camera_to = still; r.decisions[0].impact.amplitude = 0.2;
    assert.throws(compile, /invalid impact/);
    delete r.decisions[0].cuts; r.decisions[0].impact = { at_sec: 2.9, duration_sec: 0.3 };
    assert.throws(() => validatePanelAuthorResponse(r, { ...chunk, scenes: chunk.scenes.map((s, i) => ({ ...s, ...baseline.scenes[i] })) }, baseline), /impact needs/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
