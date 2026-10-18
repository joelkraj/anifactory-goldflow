import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectReferenceProbeReview, prepareReferenceProbeReview, acceptReferenceProbeReview, referenceProbeReviewStage, SINGLE_IDENTITY_OUTPUT } from '../lib/fal-reference-probe-review.mjs';
import { falBlockedStageRecoveryAdmission } from '../lib/fal-production-state.mjs';
import { commandStageFor } from '../lib/pipeline-stage-registry.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const put=async(f,x)=>{await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,x);};
const json=async(f,x)=>put(f,JSON.stringify(x,null,2)+'\n');
const fileHash=async f=>hash(await fs.readFile(f));
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fal-probe-review-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const p=n=>path.join(dir,n),identity={episode:'ep_01',image_provider:'fal_ai',visual_restart:{fork_at:'visual_reference_plan'}};
 await json(p('run_identity.json'),identity);await put(p('script_clean.md'),'Locked original story.');await put(p('bank.png'),'multi-view bank');
 const rows=['face','wardrobe','other'].map(id=>({image_id:id,ref_id:id,endpoint:'openai/gpt-image-2.5/sunburst/edit',prompt:'One neutral person on a plain background with relaxed empty hands.',prompt_sha256:hash('prompt'),board_path:p('bank.png'),board_sha256:hash('multi-view bank'),reference_asset_ids:['bank'],reference_hashes:[hash('multi-view bank')],assignment_sha256:'original-'+id,output_path:p('assets/images/references/'+id+'.png'),assignment_path:p('fal/reference/assignments/'+id+'.json'),submission_receipt_path:p('fal/reference/submission-receipts/'+id+'.json'),result_receipt_path:p('fal/reference/result-receipts/'+id+'.json'),upload_receipt_path:p('fal/reference/uploads/'+id+'.json')}));
 for(const row of rows)await json(row.assignment_path,row);
 await json(p('fal/reference-plan.json'),{assignments:rows});await put(rows[0].output_path,'rejected board');await json(rows[0].result_receipt_path,{output_path:rows[0].output_path,output_sha256:hash('rejected board')});
 await json(p('visual_reference_plan.json'),{reference_targets:rows.map((r,i)=>({ref_id:r.ref_id,kind:'character_state',canonical_subject_id:i===2?'other':'hero',identity_usage:i===0?'face_only':'full_identity'}))});
 const request={schema:'goldflow_fal_reference_probe_review_v1',status:'rejected',reviewer:'actual_visual_reviewer',finding:'The result copied the input board layout and labels instead of one figure.',source_script_sha256:await fileHash(p('script_clean.md')),run_identity_sha256:await fileHash(p('run_identity.json')),visual_reference_plan_sha256:await fileHash(p('visual_reference_plan.json')),reference_plan_sha256:await fileHash(p('fal/reference-plan.json')),image_id:'face',original_assignment_sha256:rows[0].assignment_sha256,rejected_image_sha256:hash('rejected board'),pending_image_ids:['wardrobe']};
 await json(p('fal/reference-probe-review.json'),request);return {dir,p,rows,identity,request};
}
test('exact rejected probe stops bulk, repairs once and rebinds only unsubmitted same-identity variants',async t=>{
 const f=await fixture(t);let s=await inspectReferenceProbeReview(f.dir);assert.equal(s.state,'prepare');
 const stage=referenceProbeReviewStage(f.dir,s),status={...stage,episode_dir:f.dir,current_stage:'reference_generation',current_stage_state:'blocked'};
 const flags={'episode-dir':f.dir,action:'prepare-reference-probe-repair'};
 assert.equal(falBlockedStageRecoveryAdmission(status,flags).allowed,true);
 assert.equal(falBlockedStageRecoveryAdmission(status,{...flags,force:'true'}).allowed,false);
 assert.equal(falBlockedStageRecoveryAdmission({...status,current_stage:'image_generation'},flags).allowed,false);
 assert.equal(commandStageFor('imagegen','fal',flags,f.identity),'reference_generation');
 const originalPlan=await fs.readFile(f.p('fal/reference-plan.json'));const unrelated=await fs.readFile(f.rows[2].assignment_path);
 const repair=await prepareReferenceProbeReview(f.dir,s);assert.equal(repair.prompt,f.rows[0].prompt+SINGLE_IDENTITY_OUTPUT);assert.equal(repair.board_path,f.rows[0].board_path);
 s=await inspectReferenceProbeReview(f.dir);assert.equal(s.state,'dispatch');await json(repair.submission_receipt_path,{request_id:'one-paid-repair'});
 assert.equal((await inspectReferenceProbeReview(f.dir)).state,'observe');await put(repair.output_path,'clean single figure');await json(repair.result_receipt_path,{output_path:repair.output_path,output_sha256:hash('clean single figure')});
 s=await inspectReferenceProbeReview(f.dir);assert.equal(s.state,'review');await assert.rejects(acceptReferenceProbeReview(f.dir,s,{reviewer:'',note:'not actual review'}));
 await acceptReferenceProbeReview(f.dir,s,{reviewer:'actual_visual_reviewer',note:'Inspected the actual repaired raster: one figure, two empty hands and no lettering or inset panels.'});
 assert.equal((await inspectReferenceProbeReview(f.dir)).state,'accepted');assert.equal(referenceProbeReviewStage(f.dir,await inspectReferenceProbeReview(f.dir)),null);
 assert.deepEqual(await fs.readFile(f.rows[2].assignment_path),unrelated);assert.deepEqual(await fs.readFile(f.p('fal/reference/probe-review-original-plan.json')),originalPlan);
 const current=JSON.parse(await fs.readFile(f.p('fal/reference-plan.json')));assert.equal(current.assignments[1].board_sha256,hash('clean single figure'));assert.equal(current.assignments[0].assignment_sha256,f.rows[0].assignment_sha256);
 await assert.rejects(prepareReferenceProbeReview(f.dir,await inspectReferenceProbeReview(f.dir)),/already prepared/);
 await put(repair.output_path,'changed');await assert.rejects(inspectReferenceProbeReview(f.dir),/accepted raster changed/);
});
test('changed source, wrong identity, changed rejected raster or submitted variant cannot enter recovery',async t=>{
 for(const mode of ['source','identity','raster','submitted']){
  const f=await fixture(t);
  if(mode==='source')await put(f.p('script_clean.md'),'Changed story');
  if(mode==='identity'){f.request.pending_image_ids=['other'];await json(f.p('fal/reference-probe-review.json'),f.request);}
  if(mode==='raster')await put(f.rows[0].output_path,'changed');
  if(mode==='submitted')await json(f.rows[1].submission_receipt_path,{request_id:'already-submitted'});
  await assert.rejects(inspectReferenceProbeReview(f.dir));
 }
});
test('a failed correction stops and a modified prepared payload cannot be submitted',async t=>{
 const f=await fixture(t);const repair=await prepareReferenceProbeReview(f.dir,await inspectReferenceProbeReview(f.dir));
 const preparedPath=f.p('fal/reference-probe-review-prepared.json'),original=JSON.parse(await fs.readFile(preparedPath));
 const changed=structuredClone(original);changed.repair.endpoint='different-provider';await json(preparedPath,changed);
 await assert.rejects(inspectReferenceProbeReview(f.dir),/prepared assignment changed/);await json(preparedPath,original);
 await json(f.p('fal/reference/review-repair-failure-receipts/face.json'),{image_id:'face',error_status:422});
 const state=await inspectReferenceProbeReview(f.dir);assert.equal(state.state,'failed');assert.equal(referenceProbeReviewStage(f.dir,state).next_command_shape,undefined);
 assert.equal(repair.previous_assignment_sha256,'original-face');
});
