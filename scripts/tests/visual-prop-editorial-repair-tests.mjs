import test from 'node:test';import assert from 'node:assert/strict';
import { applyPropRepairDecision } from '../lib/visual-prop-editorial-repair.mjs';
const prose='Joey parries with a sword, holding a permit in his left hand. He faces the enemy. A bubble reads "Ready."';
const row={image_id:'cut_1',visual_beat_id:'beat_1',provider_prompt:prose,image_prompt:prose,start_sec:5,reference_requirements:[{ref_id:'hero'}],shot_manifest:{visible_props:['sword','permit'],equipment_contracts:[{item:'sword',hand_assignment:'right'},{item:'permit',hand_assignment:'left'}],character_staging:[{name:'hero',pose:'Parrying, permit in left hand.'}]}};
const decision={image_id:'cut_1',disposition:'repair',reason:'Old possession is not current hand use.',patches:[{op:'span',path:'provider_prompt',before:', holding a permit in his left hand',to:''},{op:'span',path:'shot_manifest.character_staging[0].pose',before:', permit in left hand',to:''},{op:'remove',path:'shot_manifest.visible_props[1]',before:'permit'},{op:'remove',path:'shot_manifest.equipment_contracts[1]',before:row.shot_manifest.equipment_contracts[1]}]};
test('exact authored prop spans preserve fight, lettering, references, timing and original bytes',()=>{const before=JSON.stringify(row),out=applyPropRepairDecision(row,decision);assert.equal(JSON.stringify(row),before);assert.equal(out.provider_prompt,'Joey parries with a sword. He faces the enemy. A bubble reads "Ready."');assert.equal(out.image_prompt,out.provider_prompt);assert.deepEqual(out.reference_requirements,row.reference_requirements);assert.equal(out.start_sec,5);assert.deepEqual(out.shot_manifest.visible_props,['sword']);assert.deepEqual(out.shot_manifest.equipment_contracts,[row.shot_manifest.equipment_contracts[0]]);});
test('legitimate current document use can be retained without edits',()=>{assert.deepEqual(applyPropRepairDecision(row,{image_id:'cut_1',disposition:'keep',reason:'Current beat reads permit.',patches:[]}),row)});
test('stale, ambiguous, out-of-scope, identity and empty repairs fail closed',()=>{for(const mutate of [d=>d.image_id='other',d=>d.patches[0].before='absent',d=>d.patches[0].path='start_sec',d=>d.patches[2].before='sword',d=>d.patches[3].path='reference_requirements[0]',d=>d.patches=[],d=>d.disposition='keep']){const d=structuredClone(decision);mutate(d);assert.throws(()=>applyPropRepairDecision(row,d),/Editorial prop repair/)}const duplicate=structuredClone(row);duplicate.provider_prompt=duplicate.image_prompt='same same';assert.throws(()=>applyPropRepairDecision(duplicate,{...decision,patches:[{op:'span',path:'provider_prompt',before:'same',to:'one'}]}),/exactly once/)});

test('review acceptance refreshes dependent aliases while preserving untouched prose and per-beat timing',async()=>{
 const {mergeAcceptedPropRepairs}=await import('../lib/visual-prop-editorial-repair.mjs');
 const owner={...row,provider_submission_required:true},alias={...row,image_id:'alias',visual_beat_id:'beat_2',start_sec:9,provider_submission_required:false,panel_asset_owner_image_id:'cut_1',visual_beat_script_excerpt:'Different timed reaction'};
 const other={...row,image_id:'untouched',provider_submission_required:true};const plan={prompts:[owner,alias,other]};
 const result=mergeAcceptedPropRepairs(plan,[{row:owner,decision}],['cut_1']);
 assert.equal(result.plan.prompts[1].provider_prompt,result.plan.prompts[0].provider_prompt);
 assert.equal(result.plan.prompts[1].start_sec,9);assert.equal(result.plan.prompts[1].visual_beat_script_excerpt,alias.visual_beat_script_excerpt);assert.deepEqual(result.plan.prompts[2],other);
 assert.throws(()=>mergeAcceptedPropRepairs(plan,[{row:owner,decision}],['unknown']),/not reviewed/);
 assert.throws(()=>mergeAcceptedPropRepairs(plan,[{row:owner,decision}],['cut_1','cut_1']),/distinct/);
 const stale=structuredClone(owner);stale.provider_prompt+=' Changed';assert.throws(()=>mergeAcceptedPropRepairs(plan,[{row:stale,decision}],['cut_1']),/changed/);
});
