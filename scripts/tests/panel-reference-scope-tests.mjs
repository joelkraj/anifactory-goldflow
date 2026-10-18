import test from 'node:test';import assert from 'node:assert/strict';
import {targetScopedToPrompt} from '../visual-prompt-harden.mjs';
test('one authored artwork may use approved identity scope from its later covered beat, without global scope expansion',()=>{
 const target={scene_ids:['scene_2'],planned_beat_ids:['beat_2']},owner={scene_id:'scene_1',visual_beat_id:'beat_1'},covered=[owner,{scene_id:'scene_2',visual_beat_id:'beat_2'}];
 const before=JSON.stringify(target);assert.equal(targetScopedToPrompt(target,owner),false);assert.equal(targetScopedToPrompt(target,owner,covered),true);assert.equal(targetScopedToPrompt(target,owner,[owner,{scene_id:'scene_3',visual_beat_id:'beat_3'}]),false);assert.equal(JSON.stringify(target),before);
 assert.equal(targetScopedToPrompt({scene_ids:['scene_4'],planned_beat_ids:['beat_4']},owner,covered),false);
});

test('adult identity plates are not required for explicitly authored faceless memory silhouettes',async()=>{
 const {authoredNonidentifyingMemorySilhouette:check}=await import('../visual-prompt-harden.mjs');
 const prompt={depiction_mode:'memory_or_flashback',provider_prompt:'Two faceless youthful silhouettes practice together.'},staging={ref_id:null,pose:'Non-identifying youthful silhouette in remembered practice.'};
 assert.equal(check(prompt,staging),true);assert.equal(check({...prompt,depiction_mode:'current_reality'},staging),false);assert.equal(check(prompt,{...staging,ref_id:'adult_state'}),false);assert.equal(check({...prompt,provider_prompt:'Two recognizable faces practice together.'},staging),false);assert.equal(check(prompt,{...staging,pose:'Clearly visible face'}),false);
});
