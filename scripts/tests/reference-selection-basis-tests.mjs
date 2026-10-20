import assert from 'node:assert/strict';
import { referenceSelectionBasisFindings, referenceSelectionSummary, referenceSelectionFacts, PANEL_REFERENCE_SELECTION_GUIDANCE } from '../lib/reference-selection-basis.mjs';
import { materializeReferenceDirectorSelectionForTests } from '../visual-reference-plan.mjs';

let count = 0;
function test(name, run) { run(); count++; console.log(`ok - reference selection basis: ${name}`); }
const beats = ['s1', 's1', 's1', 's2', 's3'].map((scene, i) => ({ visual_beat_id: `b${i}`, scene_id: scene }));
const target = (ref_id, planned_beat_ids, extra = {}) => ({ ref_id, kind: 'character_state', generation_mode: 'standalone_ref', planned_beat_ids, ...extra });
const codes = targets => referenceSelectionBasisFindings(targets, beats).map(row => [row.ref_id, row.code, row.severity]);

test('facts recompute uses, scenes and identity bases from the beat plan only', () => {
  const facts = referenceSelectionFacts([target('joey', ['b0'], { canonical_subject_id: 'joey' }), target('joey_gown', ['b3'], { canonical_subject_id: 'joey', base_asset_id: 'joey' })], beats);
  assert.deepEqual(facts.get('joey'), { uses: 1, scenes: 1, subject_scenes: 2, identity_base: true });
  assert.equal(facts.get('joey_gown').identity_base, false, 'a state plate is not a base');
});

test('true bases pass; missing or false bases block; exceptions need a reason and stay visible', () => {
  assert.deepEqual(codes([target('room', ['b0', 'b1', 'b2'], { kind: 'location', selection_basis: 'cross_use' })]), []);
  assert.deepEqual(codes([target('room', ['b0', 'b1'], { kind: 'location', selection_basis: 'cross_use' })]), [['room', 'reference_selection_basis_false', 'blocker']]);
  assert.deepEqual(codes([target('room', ['b0'], { kind: 'location' })]), [['room', 'reference_selection_basis_missing', 'blocker']]);
  assert.deepEqual(codes([target('ana', ['b0'], { canonical_subject_id: 'ana', selection_basis: 'identity_base' })]), [['ana', 'reference_selection_basis_false', 'blocker']], 'one scene is not recurring');
  assert.deepEqual(codes([target('ana', ['b0', 'b3'], { canonical_subject_id: 'ana', selection_basis: 'identity_base' })]), []);
  assert.deepEqual(codes([target('medic', ['b4'], { selection_basis: 'director_exception', selection_exception_reason: 'short' })]), [['medic', 'reference_selection_basis_false', 'blocker']]);
  assert.deepEqual(codes([target('medic', ['b4'], { selection_basis: 'director_exception', selection_exception_reason: 'Restrains Joey in a body-contact struggle.' })]), [['medic', 'reference_selection_exception', 'warning']]);
  assert.deepEqual(codes([{ ...target('draft', ['b0']), generation_mode: 'manual_review' }]), [], 'only generated refs need a basis');
});

test('summary counts bases and refs under the minimum', () => {
  const summary = referenceSelectionSummary([target('a', ['b0', 'b1', 'b2'], { selection_basis: 'cross_use' }), target('b', ['b4'], { selection_basis: 'director_exception', selection_exception_reason: 'Shown in the first 30 seconds of the opening.' })], beats);
  assert.deepEqual(summary, { rule: 'panel_reference_selection_v1', standalone_count: 2, cross_use: 1, identity_base: 0, director_exception: 1, under_min_uses: 1 });
  assert.match(PANEL_REFERENCE_SELECTION_GUIDANCE, /overrides the two-beat\/two-scene recurrence guidance/);
});

test('director selection rows carry the basis columns through materialization; five-column rows still parse', () => {
  const catalog = { referenceTargetCatalog: new Map([['rt_0001', { ref_id: 'room_chunk', kind: 'location', subject: 'Room', scene_ids: ['s1'], planned_beat_ids: ['b0'], evidence_asset_ids: ['room'], prompt_anchor: 'Room anchor' }]]), characterStateRefCatalog: new Map() };
  const rows = extra => ({ selection_contract: 'goldflow_reference_director_selection_rows_v2', reference_selection_rows: [['room', ['rt_0001'], 'required', 'standalone_ref', 1, ...extra]], character_state_selection_rows: [], reference_overrides: {}, character_state_overrides: {}, warnings: [] });
  const withBasis = materializeReferenceDirectorSelectionForTests(rows(['director_exception', 'The only on-screen clue to the twist.']), catalog).reference_targets[0];
  assert.deepEqual([withBasis.selection_basis, withBasis.selection_exception_reason], ['director_exception', 'The only on-screen clue to the twist.']);
  const legacy = materializeReferenceDirectorSelectionForTests(rows([]), catalog).reference_targets[0];
  assert.equal('selection_basis' in legacy, false);
});
console.log(`Reference selection basis: ${count} test groups passed.`);
