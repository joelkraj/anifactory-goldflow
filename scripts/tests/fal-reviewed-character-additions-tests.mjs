import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {falFileSha256} from '../lib/fal-provider.mjs';
import {reviewedFalCharacterAdditions} from '../lib/fal-reviewed-character-additions.mjs';

async function fixture() {
  const dir=await mkdtemp(path.join(os.tmpdir(),'fal-reviewed-character-'));
  const put=async(name,value)=>{const file=path.join(dir,name);await mkdir(path.dirname(file),{recursive:true});
    await writeFile(file,typeof value==='string'?value:JSON.stringify(value));return file;};
  const quote='Marshal Mira inspected the equipment and nodded.';
  const target={ref_id:'mira_blue_state',kind:'character_state',generation_mode:'standalone_ref',
    scene_ids:['scene_044'],prompt_anchor:'Marshal Mira wearing her blue coat',
    conditioning_image_path:await put('approved.png','approved identity raster')};
  const plan={reference_targets:[target]};
  const beats={beats:[{visual_beat_id:'owner',visual_beat_script_excerpt:'I put on the new equipment.'},
    {visual_beat_id:'later',visual_beat_script_excerpt:quote}]};
  const allocation={beat_bindings:[{beat_id:'owner',asset_id:'art_1'},{beat_id:'later',asset_id:'art_1'}]};
  const approval={reference_hash_by_ref_id:{mira_blue_state:await falFileSha256(target.conditioning_image_path)}};
  const files={run_identity_sha256:['run_identity.json',{episode:'ep_01'}],source_script_sha256:['script_clean.md',quote],
    beat_plan_sha256:['visual_beat_plan.json',beats],panel_asset_plan_sha256:['panel_asset_plan_ep_01.json',allocation],
    reference_plan_sha256:['visual_reference_plan.json',plan],reference_approval_sha256:['visual_reference_approval_ep_01.json',approval]};
  const directive={actual_reference_review:true,reviewer:'Reviewer',reference_review_note:'Actual source and approved plate inspected for this missing character.',
    character_reference_additions:[{ref_id:'mira_blue_state',visible_character:'Mira',source_quote:quote,
      reason:'The shared artwork covers her source-bound inspection in the later beat.'}]};
  for(const [key,[name,value]] of Object.entries(files))directive[key]=await falFileSha256(await put(name,value));
  await put('fal/reference-plan.json',{assignments:[{ref_id:'mira_blue_state',reference_mode:'approved_local_asset',reference_asset_ids:['approved.mira']}]});
  const args={episodeDir:dir,identity:{episode:'ep_01',series_slug:'test-series'},
    promptRow:{visual_beat_id:'owner',scene_id:'scene_044',shot_manifest:{visible_characters:['Mira'],forbidden_ref_ids:[]}},
    directive,refs:[1,2,3].map(i=>({asset_id:`old.${i}`,sha256:`hash${i}`,path:`/old/${i}`})),approval};
  const refresh=async(key)=>{const [name,value]=files[key];directive[key]=await falFileSha256(await put(name,value));};
  return {dir,args,target,beats,allocation,refresh,put};
}

test('reviewed attachment preserves existing inputs and adds one approved plate for a covered later beat',async()=>{
  const f=await fixture();try{const before=structuredClone(f.args.refs);
    const result=await reviewedFalCharacterAdditions(f.args);
    assert.deepEqual(result.slice(0,3),before);assert.deepEqual(f.args.refs,before);
    assert.equal(result[3].asset_id,'approved.mira');assert.equal(result[3].sha256,f.args.approval.reference_hash_by_ref_id.mira_blue_state);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

const invalid={
  'unreviewed':f=>{f.args.directive.actual_reference_review=false;},
  'stale source hash':f=>{f.args.directive.source_script_sha256='stale';},
  'stale approval hash':f=>{f.args.directive.reference_approval_sha256='stale';},
  'full reference slots':f=>{f.args.refs.push({asset_id:'old.4'});},
  'not visibly authored':f=>{f.args.promptRow.shot_manifest.visible_characters=[];},
  'forbidden reference':f=>{f.args.promptRow.shot_manifest.forbidden_ref_ids=['mira_blue_state'];},
  'wrong scene':f=>{f.args.promptRow.scene_id='scene_099';},
  'noncharacter target':async f=>{f.target.kind='prop';await f.refresh('reference_plan_sha256');},
  'unrelated identity':async f=>{f.target.prompt_anchor='Someone else in blue';await f.refresh('reference_plan_sha256');},
  'quote outside shared artwork':async f=>{f.allocation.beat_bindings[1].asset_id='art_2';await f.refresh('panel_asset_plan_sha256');},
  'missing owner binding':async f=>{f.allocation.beat_bindings.shift();await f.refresh('panel_asset_plan_sha256');},
  'invented source quote':f=>{f.args.directive.character_reference_additions[0].source_quote='Invented narration that does not occur in the source.';},
  'changed reference raster':async f=>{await f.put('approved.png','changed raster');},
  'duplicate existing asset':f=>{f.args.refs[0].asset_id='approved.mira';}
};
for(const [name,mutate] of Object.entries(invalid))test(`reviewed attachment rejects ${name}`,async()=>{
  const f=await fixture();try{await mutate(f);await assert.rejects(reviewedFalCharacterAdditions(f.args));}
  finally{await rm(f.dir,{recursive:true,force:true});}
});
test('ordinary repair without character additions keeps the original reference array',async()=>{
  const refs=[{asset_id:'old'}];assert.equal(await reviewedFalCharacterAdditions({directive:{},refs}),refs);
});
