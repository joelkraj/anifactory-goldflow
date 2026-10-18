import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { panelProductionFixture } from './panel-production-fixture.mjs';
import { preparePanelProductionPlan, compilePanelProductionPlan } from '../lib/panel-production-plan.mjs';
import { panelAuthorChunks, validatePanelAuthorResponse, authorPanelProduction } from '../lib/panel-production-author.mjs';

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
