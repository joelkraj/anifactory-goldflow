import test from 'node:test';
import assert from 'node:assert/strict';
import { panelAssetOrderForPrompt } from '../lib/panel-production-assets.mjs';

test('shared artwork packet preserves all covered source evidence without repeating parent artifact diagnostics', () => {
  const beats = Array.from({length: 8}, (_,i) => ({
    visual_beat_id: `beat_${i}`, source_atom_ids: [`atom_${i}`],
    source_word_start_index: i * 10, source_word_end_index: i * 10 + 9,
    visual_beat_script_excerpt: `Exact untruncated narration ${i}`,
    visual_beat_action: `Exact action ${i}`, visual_beat_action_evidence: `Evidence ${i}`,
    depiction_mode: i ? 'current_reality' : 'memory_or_flashback',
    active_state_constraints: { character_states: [{ character: 'Joey', sleeve: 'split' }] },
    physically_visible_entity_ids: ['joey'], local_ui_elements: [{text:'Rebound'}],
    continuity_notes: ['Exactly three remote marks'],
    start_sec:i, end_sec:i+1,
    parent_timing_diagnostic: 'diagnostic'.repeat(5000),
  }));
  const order = { asset_id:'one_image', owner_beat_id:'beat_0', beat_ids:beats.map(b=>b.visual_beat_id), visual_brief:'One shared image with timed detail crops', editorial_reason:'Same tableau', bound_beats:beats };
  const original = JSON.stringify(order), packet = panelAssetOrderForPrompt(order);
  assert.equal(JSON.stringify(order), original);
  assert.equal(packet.bound_beats.length, 8);
  assert.deepEqual(packet.beat_ids, order.beat_ids);
  for (let i=0;i<8;i++) {
    const {parent_timing_diagnostic, ...evidence} = beats[i];
    assert.deepEqual(packet.bound_beats[i], evidence);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) < 12000);
  assert.equal(panelAssetOrderForPrompt(null), null);
});
