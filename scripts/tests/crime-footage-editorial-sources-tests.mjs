import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {QWEN_JOEL_PRIMARY_LOCK as PIN} from '../lib/narration-tts-policy.mjs';
import * as oldWorkflow from '../lib/crime-footage-proof-workflow.mjs';
import * as editorialWorkflow from '../lib/crime-footage-editorial-workflow.mjs';
import {produceCrimeFootageEditorialSources,validateCrimeFootageEditorialSourceIdentity} from '../lib/crime-footage-editorial-sources.mjs';

// Isolated structural fixtures. No case recording, Qwen call, approval or network.
const exec=promisify(execFile),root=await fs.mkdtemp(path.join(os.tmpdir(),'crime-editorial-source-tests-'));
const ref=oldWorkflow.crimeFootageFileRef;
const write=async(p,value)=>{await fs.writeFile(p,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');return ref(p);};
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
try{
  const repo=path.join(root,'repo');await fs.mkdir(repo);
  await exec('git',['init','--quiet'],{cwd:repo});await exec('git',['config','user.name','Synthetic fixture'],{cwd:repo});await exec('git',['config','user.email','fixture@example.invalid'],{cwd:repo});
  await fs.writeFile(path.join(repo,'README'),'Provider-free fixture.\n');await exec('git',['add','README'],{cwd:repo});await exec('git',['commit','--quiet','-m','fixture'],{cwd:repo});
  const planFor=(title,text,target)=>({schema:'goldflow_crime_footage_proof_plan_v1',title,case_name:'Lindsay Clancy',target_duration_sec:target,narration_units:[{id:'N01',text,source_ids:['V01']}],claims:[{id:'C01',text:'Synthetic structural fixture, not a case claim.',source_ids:['V01']}],scenes:[{id:'S01',type:'video',source_ids:['V01'],source_window_refs:[{source_id:'V01',window_id:'W02'}],narration_unit_ids:[],picture_origin:'original',audio_origin:'original'},{id:'S02',type:'narration_bridge',source_ids:['V01'],source_window_refs:[],narration_unit_ids:['N01'],picture_origin:'authored',audio_origin:'narration'}]});
  const oldText='This is the original synthetic bridge.',newText='This revised synthetic bridge changes the argument.';
  const originalPlan=planFor('Original synthetic proof',oldText,91),revisionPlan=planFor('Revised synthetic proof',newText,62);
  const identity={schema:'goldflow_crime_footage_proof_identity_v1',content_profile:'true_crime_proof_v1',media_workflow:'crime_footage_private_proof_v1',channel:'crimedungeon',channel_name:'CrimeDungeon',series_slug:'case-files',run_slug:'synthetic-editorial-proof',episode:'ep_01',title:originalPlan.title,run_intent:'proof',production_eligible:false,publish_allowed:false,plan:await write(path.join(root,'original-plan.json'),originalPlan),script:await write(path.join(root,'original-script.txt'),oldText+'\n'),sources:[{id:'V01',url:'https://example.org/synthetic-fixture',kind:'video',locator:'Synthetic local media; no remote source claim.',use_basis:'Locally generated structural fixture.',windows:[{id:'W01',start_sec:0,end_sec:2},{id:'W02',start_sec:10,end_sec:12}]}],narration:{provider:PIN.provider,model:PIN.model_id,model_revision:PIN.model_revision,voice_id:PIN.voice_id,voice_sha256:PIN.voice_sha256,reference_audio:{path:PIN.reference_audio_path,sha256:PIN.reference_audio_sha256},reference_text:await write(path.join(root,'reference.txt'),PIN.reference_text)},proof_scope:{min_duration_sec:90,max_duration_sec:150,fps:30,width:1920,height:1080},execution_authorization:{operator:'Synthetic fixture',authorized_at:'2026-09-09T00:00:00Z',instruction:'Exercise the provider-free original source fixture.',note:'No real media, listening approval or production claim.'}};
  const oldDir=path.join(root,'old-proof');await oldWorkflow.preflightCrimeFootageProof({proofDir:oldDir,repoDir:repo,identity});
  const oldAttempt=await oldWorkflow.beginCrimeFootageProofStage({proofDir:oldDir,stage:'source_assets',inputs:[]});
  const source=path.join(oldAttempt.outputDir,'synthetic-one.mp4');
  await exec('ffmpeg',['-nostdin','-v','error','-n','-f','lavfi','-i','color=c=navy:s=320x180:r=30:d=2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',source],{timeout:15000,maxBuffer:100000});
  const second=path.join(oldAttempt.outputDir,'synthetic-two.mp4');await fs.copyFile(source,second);
  const audit=await write(path.join(oldAttempt.outputDir,'synthetic-lineage.json'),{synthetic_fixture:true,real_case_audio_verification:false});
  const assets=[{id:'source-W01',...await ref(source),kind:'source_video',source_ids:['V01']},{id:'source-W02',...await ref(second),kind:'source_video',source_ids:['V01']},{id:'synthetic-lineage',...audit,kind:'source_review',source_ids:['V01']}];
  const rows=identity.sources[0].windows.map((w,i)=>({source_id:'V01',window_id:w.id,artifact_id:assets[i].id,public_url:identity.sources[0].url,acquisition_method:'Synthetic local lavfi fixture; no actual acquisition.',source_start_sec:w.start_sec,source_end_sec:w.end_sec,audio_origin:'original',actual_duration_sec:2,...(i===1?{audio_repair_lineage:{synthetic_audit:audit}}:{})}));
  await oldWorkflow.finishCrimeFootageProofStage({proofDir:oldDir,stage:'source_assets',attemptToken:oldAttempt.attempt_token,result:{artifacts:assets,metadata:{source_windows:rows},cost_usd:0}});
  const revised=structuredClone(identity);revised.media_workflow='crime_footage_editorial_proof_v1';revised.title=revisionPlan.title;revised.plan=await write(path.join(root,'revision-plan.json'),revisionPlan);revised.script=await write(path.join(root,'revision-script.txt'),newText+'\n');revised.sources[0].windows=[revised.sources[0].windows[1]];revised.proof_scope={min_duration_sec:60,max_duration_sec:90,fps:30,width:1920,height:1080};revised.execution_authorization.instruction='Exercise the new provider-free editorial revision.';
  const newDir=path.join(root,'new-proof'),recipe={schema:'crime_footage_editorial_source_reuse_v1',scope:'same_case_verified_source_windows_new_editorial_proof',from_proof_dir:oldDir,to_proof_dir:newDir,from_identity:await ref(path.join(oldDir,'run_identity.json')),from_source_stage:await ref(path.join(oldDir,'source_assets.json')),selected_windows:[{source_id:'V01',window_id:'W02'}],authorization_instruction:revised.execution_authorization.instruction,review_note:'Synthetic editorial revision uses the exact subset without new acquisition.'};
  assert.equal(validateCrimeFootageEditorialSourceIdentity(identity,revised,recipe),true);
  for(const [mutation,message]of[
    [i=>i.sources[0].url='https://example.org/different',/exact bounds must match/],
    [i=>i.sources[0].windows[0].start_sec=10.1,/exact bounds must match/],
    [i=>i.narration.voice_id='another_voice',/pinned narrator/],
    [i=>i.series_slug='another-series',/series_slug differs/],
    [i=>i.production_eligible=true,/private proof/],
    [i=>i.proof_scope.min_duration_sec=90,/60–90/],
    [i=>i.sources[0].windows.push({id:'W03',start_sec:20,end_sec:22}),/every new media window/]
  ]){const bad=structuredClone(revised);mutation(bad);assert.throws(()=>validateCrimeFootageEditorialSourceIdentity(identity,bad,recipe),message);}
  assert.throws(()=>validateCrimeFootageEditorialSourceIdentity(identity,revised,{...recipe,authorization_instruction:'Not the new instruction'}),/exact new editorial/);
  const crossOld=path.join(root,'wrong-old-route'),crossNew=path.join(root,'wrong-editorial-route');
  await assert.rejects(oldWorkflow.preflightCrimeFootageProof({proofDir:crossOld,repoDir:repo,identity:revised}),/Exact new private footage identity/);
  await assert.rejects(editorialWorkflow.preflightCrimeFootageProof({proofDir:crossNew,repoDir:repo,identity}),/Exact new private footage identity/);
  for(const dir of [crossOld,crossNew])assert.equal(await fs.stat(dir).catch(()=>null),null);
  for(const seconds of [59.99,90.01])assert.throws(()=>editorialWorkflow.validateCrimeFootagePlan({...revisionPlan,target_duration_sec:seconds},revised,newText+'\n'),/60–90 seconds/);
  for(const seconds of [60,90])assert.equal(editorialWorkflow.validateCrimeFootagePlan({...revisionPlan,target_duration_sec:seconds},revised,newText+'\n').target_duration_sec,seconds);
  await editorialWorkflow.preflightCrimeFootageProof({proofDir:newDir,repoDir:repo,identity:revised});
  const producer=await ref(fileURLToPath(new URL('../lib/crime-footage-editorial-sources.mjs',import.meta.url)));
  const recipeRef=await write(path.join(root,'recipe.json'),recipe);
  const attempt=await editorialWorkflow.beginCrimeFootageProofStage({proofDir:newDir,stage:'source_assets',inputs:[recipeRef,producer,recipe.from_identity,recipe.from_source_stage]});
  await assert.rejects(produceCrimeFootageEditorialSources({proofDir:newDir,attemptToken:'wrong',recipePath:recipeRef.path}),/exact guarded attempt/);
  assert.deepEqual(await fs.readdir(attempt.outputDir),[]);
  const saved=await fs.readFile(second);await fs.appendFile(second,'changed fixture');
  await assert.rejects(produceCrimeFootageEditorialSources({proofDir:newDir,attemptToken:attempt.attempt_token,recipePath:recipeRef.path}),/bound file changed/);
  assert.deepEqual(await fs.readdir(attempt.outputDir),[]);await fs.writeFile(second,saved);
  const output=await produceCrimeFootageEditorialSources({proofDir:newDir,attemptToken:attempt.attempt_token,recipePath:recipeRef.path});
  const copied=output.artifacts.filter(a=>a.kind==='source_video');assert.equal(copied.length,1);assert.equal(copied[0].id,'source-W02');assert.equal(copied[0].sha256,assets[1].sha256);assert.notEqual(copied[0].path,assets[1].path);
  assert.equal(output.cost_usd,0);assert.equal(output.metadata.new_narration,false);assert.equal(output.metadata.network_bytes,0);assert.equal(output.artifacts.some(a=>a.kind==='narration_unit'),false);
  assert.deepEqual(output.metadata.source_windows[0].audio_repair_lineage,{synthetic_audit:audit});
  await assert.rejects(produceCrimeFootageEditorialSources({proofDir:newDir,attemptToken:attempt.attempt_token,recipePath:recipeRef.path}),/no overwrite or retry/);
  const status=await editorialWorkflow.finishCrimeFootageProofStage({proofDir:newDir,stage:'source_assets',attemptToken:attempt.attempt_token,result:output});
  assert.equal(status.next_stage,'narration');assert.equal(status.approval_recorded,false);
  const locked=await read(path.join(newDir,'run_identity.json'));assert.equal(locked.script.sha256,revised.script.sha256);assert.notEqual(locked.script.sha256,identity.script.sha256);
  assert.equal((await ref(second)).sha256,assets[1].sha256);
  console.log('PASS: synthetic guarded exact-subset source copy into a shorter editorial proof, changed script/title, retained lineage, no narration carry, identity/window/token/tamper refusals and immutable output. No actual case-media or listening claim.');
}finally{await fs.rm(root,{recursive:true,force:true});}
