import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mediaWorkflowForPreflight } from '../lib/media-workflows.mjs';
import { createPanelProductionContract } from '../lib/panel-production-policy.mjs';
import { writePanelAssetPlan } from '../lib/panel-production-assets.mjs';
import { authorDensePageAllocation, denseAllocationChunks, denseAllocationPrompt } from '../lib/panel-page-allocation-author.mjs';
import { beatAllocationConstraints } from '../lib/panel-page-allocation.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = async (file, value) => { const bytes = JSON.stringify(value); await fs.writeFile(file, bytes); return sha(bytes); };
const canvas = { width: 3840, height: 2160 };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dense-author-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'ep_01'); await fs.mkdir(dir);
  const p = file => path.join(dir, file);
  await json(p('run_identity.json'), { ...mediaWorkflowForPreflight({ contentProfile: 'manhwa_recap_v1', mediaWorkflow: 'generated_visuals_v1' }), schema: 'goldflow_run_identity_v2', run_intent: 'production', episode: 'ep_01', channel: 'test', week: 'test', content_profile: 'manhwa_recap_v1', media_workflow: 'generated_visuals_v1', render_profile: 'panel_composition_v1', panel_composition_contract: createPanelProductionContract(), audio_target: 'narrator_only', generated_motion_policy: 'disabled', parallax_policy: 'disabled', image_provider: 'fal_ai' });
  const script = 'One. Two. Three. Four. Five. Six.';
  await fs.writeFile(p('script_clean.md'), script);
  await json(p('operator_script_approval.json'), { operator_approved: true, script_clean_hash: sha(script) });
  await json(p('script_lock.json'), { script_clean_hash: sha(script) });
  const beats = [0, 1, 2, 3, 4, 5].map(i => ({ visual_beat_id: `beat_${i}`, image_id_hint: `ep_01-cut-00${i + 1}`, scene_id: i < 4 ? 'scene_1' : 'scene_2', location_id: i < 4 ? 'hall' : 'street', start_sec: i * 4, end_sec: (i + 1) * 4, duration_sec: 4, visual_beat_script_excerpt: script.split('. ')[i], visible_characters: ['Joey'] }));
  const hash = await json(p('visual_beat_plan.json'), { status: 'passed', source_script_hash: sha(script), beats, editorial_director: { grouping_lock_sha256: 'b'.repeat(64) } });
  await json(p('visual_beat_approval.json'), { status: 'approved', visual_beat_plan_sha256: hash, grouping_lock_sha256: 'b'.repeat(64) });
  await json(p('visual_reference_plan.json'), { status: 'passed', reference_targets: [{ ref_id: 'joey', kind: 'character_state', canonical_subject_id: 'joey', generation_mode: 'standalone_ref', planned_beat_ids: beats.map(b => b.visual_beat_id) }] });
  return { dir, beats };
}

// A well-formed planner answer: one page per scene, every beat bound to its zone.
function answer(prompt) {
  const prefix = prompt.match(/prefix every asset_id and zone_id with "([^"]+)"/)[1];
  const ids = JSON.parse(prompt.slice(prompt.lastIndexOf('{"templates"'))).beats.map(beat => beat.id);
  const scenes = [ids.filter(id => Number(id.split('_')[1]) < 4), ids.filter(id => Number(id.split('_')[1]) >= 4)].filter(list => list.length);
  const asset_orders = scenes.map((list, n) => ({ asset_id: `${prefix}p${n}`, kind: 'page', page_template: 'P2V', canvas, owner_beat_id: list[0], beat_ids: list, visual_brief: 'Shared room.', editorial_reason: 'One scene.',
    zones: [{ zone_id: `${prefix}p${n}_z1`, slot: 'left', beat_ids: list.slice(0, 1), visual_brief: 'Wide.', editorial_reason: 'Establish.' }, { zone_id: `${prefix}p${n}_z2`, slot: 'right', beat_ids: list.slice(1), visual_brief: 'Close.', editorial_reason: 'Follow.' }] }));
  const beat_bindings = asset_orders.flatMap(order => order.zones.flatMap(zone => zone.beat_ids.map(beat_id => ({ beat_id, asset_id: order.asset_id, zone_id: zone.zone_id, editorial_reason: 'Zone.' }))));
  return { asset_orders, beat_bindings };
}

test('chunks keep whole scenes and the prompt carries caps, canvas and constraints', () => {
  const beats = [1, 2, 3, 4, 5].map(i => ({ visual_beat_id: `b${i}`, scene_id: i < 4 ? 's1' : 's2' }));
  assert.deepEqual(denseAllocationChunks(beats, { maxBeats: 4 }).map(c => c.beats.map(b => b.visual_beat_id)), [['b1', 'b2', 'b3'], ['b4', 'b5']]);
  assert.equal(denseAllocationChunks(beats, { maxBeats: 2 })[0].beats.length, 3, 'an oversized scene is never split');
  const constraints = beatAllocationConstraints({ beats, referencePlan: {} });
  const prompt = denseAllocationPrompt({ id: 'alloc_001', beats }, constraints);
  assert.match(prompt, /"width":3840/); assert.match(prompt, /at most 4 distinct named people/); assert.match(prompt, /"P6G"/);
});

test('authors a validated dense candidate the existing import accepts, never importing it itself', async t => {
  const f = await fixture(t);
  const calls = [];
  const report = await authorDensePageAllocation({ episodeDir: f.dir, maxBeats: 4, executor: async ({ prompt }) => { calls.push(prompt); return answer(prompt); } });
  assert.equal(report.status, 'candidate_ready');
  assert.equal(calls.length, 2); assert.equal(report.image_provider_calls, 0);
  assert.deepEqual(report.density, { generations: 2, pages: 2, singles: 0, zones: 4, beats: 6, beats_per_generation: 3, templates: { P2V: 2 } });
  await assert.rejects(fs.access(path.join(f.dir, 'panel_asset_plan.json')), 'no official plan is written');
  const imported = await writePanelAssetPlan({ episodeDir: f.dir, planPath: report.candidate_path });
  assert.equal(imported.plan.status, 'passed');
  const again = await authorDensePageAllocation({ episodeDir: f.dir, maxBeats: 4, executor: async () => { throw new Error('cached chunks must not be re-requested'); } });
  assert.equal(again.provider_calls, 0); assert.equal(again.candidate_path, report.candidate_path);
});

test('a malformed or over-cap chunk fails alone and blocks the candidate', async t => {
  const f = await fixture(t);
  const report = await authorDensePageAllocation({ episodeDir: f.dir, maxBeats: 4, executor: async ({ prompt }) => {
    const out = answer(prompt);
    if (prompt.includes('"beat_4"')) out.asset_orders[0].page_template = 'P6G';
    return out;
  } });
  assert.equal(report.status, 'needs_exact_repair');
  assert.deepEqual(report.failed_chunk_ids, ['alloc_002']);
  assert.equal(report.candidate_path, undefined);
});
