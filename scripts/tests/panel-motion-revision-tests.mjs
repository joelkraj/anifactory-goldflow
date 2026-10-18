import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { panelProductionFixture } from './panel-production-fixture.mjs';
import { preparePanelProductionPlan } from '../lib/panel-production-plan.mjs';
import { sha256File } from '../lib/file-hash.mjs';
import { panelAuthorChunks } from '../lib/panel-production-author.mjs';
import { applyPanelMotionRevision, revisePanelProductionMotion } from '../lib/panel-motion-revision.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-motion-revision-'));
  const f = await panelProductionFixture(path.join(root, 'episode'));
  const prep = await preparePanelProductionPlan(f), packet = JSON.parse(await fs.readFile(prep.packet_path));
  const decisions = packet.baseline.scenes.map(s => ({ scene_id: s.id, panel_id: s.layers[0].panel_id,
    background_panel_id: s.layers[0].panel_id, layout: 'inset',
    source_rect: { x: 0, y: 0, width: 1, height: 1 }, rect: { x: .05, y: .05, width: .9, height: .9 }, fit: 'contain',
    camera_from: { x: .5, y: .5, zoom: 1 }, camera_to: { x: .5, y: .5, zoom: 1 }, entry: null, context: null,
    editorial_reason: 'Retain the complete fixture framing and narration while reviewing movement.',
    region_evidence: 'The accepted source raster remains fully visible inside this aspect-matched panel.' }));
  const recipe = { schema: 'goldflow_panel_composition_recipe_v1', author: 'Fixture',
    source_packet: { path: prep.packet_path, sha256: await sha256File(prep.packet_path) }, decisions };
  const recipePath = f.p('base-recipe.json'); await fs.writeFile(recipePath, JSON.stringify(recipe));
  const request = { schema: 'goldflow_panel_motion_revision_request_v1', source_packet_sha256: recipe.source_packet.sha256,
    recipe: { path: recipePath, sha256: await sha256File(recipePath) }, reviewer: 'Fixture',
    operator_quote: 'Move panels and images within the panel.',
    operator_direction: 'Direct movement from the narration while protecting the existing reviewed crops and all source artwork.', frozen_scene_ids: [] };
  const requestPath = f.p('motion-request.json'); await fs.writeFile(requestPath, JSON.stringify(request));
  const response = ids => ({ revisions: ids.map(scene_id => ({ scene_id,
    motion_patch: { rect_to: { x: .065, y: .05, width: .9, height: .9 } },
    motion_reason: 'Move the panel toward the listener as this exact spoken phrase addresses them.',
    protected_regions: 'Keep the entire source raster at zoom one, including all original source edges.' })) });
  return { ...f, root, packet, decisions, request, requestPath, recipePath, repoRoot: process.cwd(), response };
}

test('motion-only revisions preserve source crops/IDs and reject substitutions, bad endpoints and unjustified holds', async () => {
  const f = await fixture();
  try {
    const chunk = panelAuthorChunks(f.packet)[0], response = f.response(chunk.scenes.map(s => s.id));
    const apply = r => applyPanelMotionRevision({ response: r, chunk, baseline: f.packet.baseline, priorDecisions: f.decisions });
    const result = apply(response); assert.deepEqual(result[0].source_rect, f.decisions[0].source_rect);
    assert.equal(result[0].panel_id, f.decisions[0].panel_id); assert.deepEqual(result[0].rect, f.decisions[0].rect);
    for (const mutate of [r => r.revisions.pop(), r => { r.revisions[1].scene_id = r.revisions[0].scene_id; },
      r => { r.revisions[0].motion_patch.source_rect = { x: .2, y: 0, width: .8, height: 1 }; },
      r => { r.revisions[0].motion_patch.rect_to.x = .5; },
      r => { r.revisions[0].motion_patch.rect_to.height = .6; },
      r => { r.revisions[0].motion_patch = {}; },
      r => { r.revisions[0].motion_patch.entry = { start_sec: 0, direction: 'left', duration_sec: .5 }; }]) {
      const r = structuredClone(response); mutate(r); assert.throws(() => apply(r));
    }
    const hold = structuredClone(response); hold.revisions[0].motion_patch = {};
    hold.revisions[0].hold_reason = 'Keep the full evidence frame steady so the exact short label can be read.';
    assert.equal(apply(hold).length, 2);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('new motion pass retains base recipe and frozen beats, caches calls and fails closed on changed bindings', async () => {
  const f = await fixture(); let calls = 0;
  try {
    f.request.frozen_scene_ids = [f.decisions[0].scene_id]; await fs.writeFile(f.requestPath, JSON.stringify(f.request));
    const before = await fs.readFile(f.recipePath);
    const executor = async ({ prompt, images, outputPath }) => {
      calls++; const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
      assert.equal(input.scenes.length, 1); assert.ok(images.length > 0);
      assert.ok(prompt.includes('OVERFLOW')); assert.ok(input.words.length > 0);
      const r = f.response(input.scenes.map(s => s.id)); await fs.writeFile(outputPath, JSON.stringify(r)); return r;
    };
    const r = await revisePanelProductionMotion({ ...f, executor }); assert.equal(r.status, 'candidate_ready');
    const revised = JSON.parse(await fs.readFile(r.recipe_path)); assert.deepEqual(revised.decisions[0], f.decisions[0]);
    assert.ok(revised.decisions[1].rect_to); assert.deepEqual(await fs.readFile(f.recipePath), before);
    const again = await revisePanelProductionMotion({ ...f, executor }); assert.equal(calls, 1); assert.equal(again.new_planner_calls, 0);
    f.request.operator_direction += ' Changed direction.'; await fs.writeFile(f.requestPath, JSON.stringify(f.request));
    await assert.rejects(revisePanelProductionMotion({ ...f, executor }), /changed request\/code/); assert.equal(calls, 1);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('invalid motion response is retained and never automatically retried', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const executor = async ({ outputPath }) => { calls++; const r = { revisions: [] }; await fs.writeFile(outputPath, JSON.stringify(r)); return r; };
    const r = await revisePanelProductionMotion({ ...f, executor }); assert.equal(r.status, 'needs_exact_repair');
    await assert.rejects(revisePanelProductionMotion({ ...f, executor }), /failed revision retained/);
    assert.equal(calls, 1);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('interrupted admitted revision cannot resubmit even before raw output exists', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const first = await revisePanelProductionMotion({ ...f, executor: async ({ outputPath }) => {
      calls++; const r = f.response(f.decisions.map(d => d.scene_id)); await fs.writeFile(outputPath, JSON.stringify(r)); return r;
    } });
    const dir = path.dirname(first.report_path), rowPath = path.join(dir, 'chunks/chunk_001.json');
    const row = JSON.parse(await fs.readFile(rowPath));
    await fs.rename(rowPath, path.join(dir, 'interrupted-result-retained.json'));
    await fs.rename(row.raw_output_path, path.join(dir, 'interrupted-raw-retained.json'));
    await assert.rejects(revisePanelProductionMotion({ ...f, executor: async () => { calls++; } }), /revision claim retained/);
    assert.equal(calls, 1);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
