import assert from 'node:assert/strict';
import { beatAllocationConstraints, denseAllocationFindings, allocationDensity } from '../lib/panel-page-allocation.mjs';

let count = 0;
function test(name, run) { run(); count++; console.log(`ok - page allocation: ${name}`); }
const beats = ['b1', 'b2', 'b3', 'b4'].map((id, i) => ({ visual_beat_id: id, scene_id: 's1', location_id: i === 3 ? 'memory_room' : 'ballroom', duration_sec: 4, visible_characters: [['Joey', 'Anonymous guests'], ['Vanessa'], ['Marcus', 'Richard'], ['Elena', { name: 'Henry' }]][i] }));
const referencePlan = { reference_targets: [
  { ref_id: 'joey', generation_mode: 'standalone_ref', planned_beat_ids: ['b1', 'b2'] },
  { ref_id: 'vanessa', generation_mode: 'standalone_ref', planned_beat_ids: ['b2'] },
  { ref_id: 'marcus', generation_mode: 'standalone_ref', planned_beat_ids: ['b3'] },
  { ref_id: 'richard', generation_mode: 'standalone_ref', planned_beat_ids: ['b3'] },
  { ref_id: 'ballroom', generation_mode: 'standalone_ref', planned_beat_ids: ['b1', 'b2', 'b3'] },
  { ref_id: 'elena', generation_mode: 'standalone_ref', planned_beat_ids: ['b4'] },
  { ref_id: 'henry', generation_mode: 'standalone_ref', planned_beat_ids: ['b4'] },
  { ref_id: 'draft', generation_mode: 'manual_review', planned_beat_ids: ['b1'] },
] };
const constraints = beatAllocationConstraints({ beats, referencePlan });
const page = (beatIds, template = 'P4G', canvas = { width: 3840, height: 2160 }) => ({ asset_id: 'p1', kind: 'page', page_template: template, canvas, beat_ids: beatIds, zones: beatIds.map(id => ({ beat_ids: [id] })) });

test('constraints use generated refs only and ignore anonymous people', () => {
  assert.deepEqual(constraints.get('b1'), { beat_id: 'b1', scene_id: 's1', location_id: 'ballroom', refs: ['ballroom', 'joey'], required_ref_groups: [], people: ['Joey'], duration_sec: 4 });
  assert.deepEqual(constraints.get('b4').people, ['Elena', 'Henry']);
});

test('caps flag reference and people overflow, mixed locations and small canvases', () => {
  const codes = plan => denseAllocationFindings({ asset_orders: [plan] }, constraints).map(row => [row.code, row.severity]);
  assert.deepEqual(codes(page(['b1', 'b2', 'b3'])), []);
  assert.deepEqual(codes(page(['b1', 'b2', 'b3', 'b4'])), [['page_reference_selection_needed', 'warning'], ['page_people_over_cap', 'blocker'], ['page_mixed_locations', 'warning']]);
  assert.deepEqual(codes(page(['b1', 'b2'], 'P6G', { width: 1920, height: 1080 })), [['page_canvas_too_small', 'blocker']]);
  assert.deepEqual(denseAllocationFindings({ asset_orders: [{ asset_id: 's', beat_ids: ['b1'] }] }, constraints), [], 'singles are not page-capped');
});

test('density reports beats per generation against the target', () => {
  const plan = { asset_orders: [page(['b1', 'b2', 'b3']), { asset_id: 's1', beat_ids: ['b4'] }] };
  assert.deepEqual(allocationDensity(plan, 4), { generations: 2, pages: 1, singles: 1, zones: 3, beats: 4, beats_per_generation: 2, templates: { P4G: 1 } });
});
test('only required person and location references can block a page', () => {
  const typed = { reference_targets: [
    ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => ({ ref_id: `char_${id}`, kind: 'character_state', canonical_subject_id: id, generation_mode: 'standalone_ref', planned_beat_ids: ['b1'] })),
    { ref_id: 'a_alt_outfit', kind: 'character_state', canonical_subject_id: 'a', generation_mode: 'standalone_ref', planned_beat_ids: ['b2'] },
    { ref_id: 'room', kind: 'location', generation_mode: 'standalone_ref', planned_beat_ids: ['b2'] },
    { ref_id: 'prop', kind: 'prop', generation_mode: 'standalone_ref', planned_beat_ids: ['b2'] },
  ] };
  const c = beatAllocationConstraints({ beats, referencePlan: typed });
  assert.deepEqual(denseAllocationFindings({ asset_orders: [page(['b1'])] }, c).map(row => row.code), ['page_required_references_over_cap'], 'seven distinct people need seven references');
  assert.deepEqual(c.get('b2').required_ref_groups, ['location:room', 'person:a'], 'alternate outfits and props are optional');
});
console.log(`Panel page allocation: ${count} test groups passed.`);
