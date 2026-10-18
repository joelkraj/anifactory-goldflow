import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {QWEN_JOEL_PRIMARY_LOCK as PIN} from '../lib/narration-tts-policy.mjs';
import {preflightCrimeFootageProof,crimeFootageProofStatus,beginCrimeFootageProofStage,loadCrimeFootageProofAttempt,finishCrimeFootageProofStage,failCrimeFootageProofStage,crimeFootageFileRef,validateCrimeFootagePlan} from '../lib/crime-footage-proof-workflow.mjs';
import {executeCrimeFootageProofCli} from '../crime-footage-proof.mjs';
const exec=promisify(execFile),sha=x=>createHash('sha256').update(x).digest('hex');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'crime-footage-proof-tests-'));
const write=async(file,data)=>{await fs.writeFile(file,typeof data==='string'?data:JSON.stringify(data,null,2)+'\n');return crimeFootageFileRef(file);};
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
// Synthetic local media exercise orchestration only. No Qwen model, acquisition,
// real-case source verification, narrator listening or upload is performed.
try{
  const repo=path.join(root,'repo');await fs.mkdir(repo);
  await exec('git',['init','--quiet'],{cwd:repo});await exec('git',['config','user.name','Synthetic test'],{cwd:repo});await exec('git',['config','user.email','fixture@example.invalid'],{cwd:repo});
  await fs.writeFile(path.join(repo,'README'),'synthetic fixture\n');await exec('git',['add','README'],{cwd:repo});await exec('git',['commit','--quiet','-m','fixture'],{cwd:repo});
  const script='This is a synthetic narrator fixture.';
  const plan={schema:'goldflow_crime_footage_proof_plan_v1',title:'Synthetic private fixture',case_name:'Lindsay Clancy',target_duration_sec:91,
    narration_units:[{id:'N01',text:script,source_ids:['V01']}],claims:[{id:'C01',text:'Synthetic claim for structural testing only.',source_ids:['V01']}],
    scenes:[{id:'S01',type:'video',source_ids:['V01'],source_window_refs:[{source_id:'V01',window_id:'W01'}],narration_unit_ids:[],picture_origin:'original',audio_origin:'original'},
      {id:'S02',type:'narration_bridge',source_ids:['V01'],source_window_refs:[],narration_unit_ids:['N01'],picture_origin:'authored',audio_origin:'narration'}]};
  const voice={provider:PIN.provider,model:PIN.model_id,model_revision:PIN.model_revision,voice_id:PIN.voice_id,voice_sha256:PIN.voice_sha256};
  const referenceText=await write(path.join(root,'owned-reference.txt'),PIN.reference_text);
  const identity={schema:'goldflow_crime_footage_proof_identity_v1',content_profile:'true_crime_proof_v1',media_workflow:'crime_footage_private_proof_v1',channel:'crimedungeon',channel_name:'CrimeDungeon',series_slug:'case-files',run_slug:'synthetic-footage-proof',episode:'ep_01',title:plan.title,run_intent:'proof',production_eligible:false,publish_allowed:false,
    plan:await write(path.join(root,'plan.json'),plan),script:await write(path.join(root,'script.txt'),script+'\n'),
    sources:[{id:'V01',url:'https://example.org/synthetic-source',kind:'video',locator:'Synthetic test source; no real footage claim.',use_basis:'Locally generated synthetic test fixture only.',windows:[{id:'W01',start_sec:0,end_sec:90}]}],
    narration:{...voice,reference_audio:{path:PIN.reference_audio_path,sha256:PIN.reference_audio_sha256},reference_text:referenceText},proof_scope:{min_duration_sec:90,max_duration_sec:150,fps:30,width:1920,height:1080},execution_authorization:{operator:'Synthetic test',authorized_at:'2026-09-09T00:00:00Z',instruction:'Exercise provider-free synthetic test.',note:'This fixture does not represent user approval or actual Qwen output.'}};
  validateCrimeFootagePlan(plan,identity,script+'\n');
  const badPlan=structuredClone(plan);badPlan.scenes[0].audio_origin='recreated';assert.throws(()=>validateCrimeFootagePlan(badPlan,identity,script+'\n'),/recreated dialogue/);
  assert.throws(()=>validateCrimeFootagePlan(plan,identity,script+' changed'),/exactly concatenate/);
  const noWrite=path.join(root,'invalid');const bad=structuredClone(identity);bad.sources[0].url+='?token=private';await assert.rejects(preflightCrimeFootageProof({proofDir:noWrite,repoDir:repo,identity:bad}),/unsigned/);assert.equal(await fs.stat(noWrite).catch(()=>null),null);
  await fs.writeFile(path.join(repo,'dirty'),'untracked fixture');await assert.rejects(preflightCrimeFootageProof({proofDir:noWrite,repoDir:repo,identity}),/Dirty proof/);assert.equal(await fs.stat(noWrite).catch(()=>null),null);
  const proofDir=path.join(root,'proof');let status=await preflightCrimeFootageProof({proofDir,repoDir:repo,identity,allowDirtyWorktree:true,dirtyReason:'Explicit isolated synthetic diagnostic fixture.'});assert.equal(status.next_stage,'source_assets');
  const locked=await json(path.join(proofDir,'run_identity.json'));assert.deepEqual(locked.review_state,{script_approved:false,narration_approved:false,program_approved:false});
  await assert.rejects(preflightCrimeFootageProof({proofDir,repoDir:repo,identity}),/new absolute/);
  await assert.rejects(beginCrimeFootageProofStage({proofDir,stage:'narration',inputs:[]}),/Next valid stage/);
  const source=await beginCrimeFootageProofStage({proofDir,stage:'source_assets',inputs:[]});
  await assert.rejects(beginCrimeFootageProofStage({proofDir,stage:'source_assets',inputs:[]}),/no overwrite/);
  await assert.rejects(loadCrimeFootageProofAttempt({proofDir,stage:'source_assets',attemptToken:'wrong'}),/exact guarded attempt/);
  const clip=path.join(source.outputDir,'synthetic-source.mp4');
  await exec('ffmpeg',['-v','error','-n','-f','lavfi','-i','color=c=navy:s=320x180:r=30:d=90','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=90','-c:v','libx264','-preset','ultrafast','-crf','35','-pix_fmt','yuv420p','-c:a','aac','-b:a','32k','-shortest',clip],{timeout:60000,maxBuffer:100000});
  const asset={id:'source-W01',...await crimeFootageFileRef(clip),kind:'source_video',source_ids:['V01']};
  const sourceResult={artifacts:[asset],metadata:{cost_status:'provider_cost_not_reported',source_windows:[{source_id:'V01',window_id:'W01',artifact_id:asset.id,public_url:identity.sources[0].url,acquisition_method:'Synthetic lavfi fixture; no actual source acquisition',source_start_sec:0,source_end_sec:90,audio_origin:'original',actual_duration_sec:90}]},cost_usd:null};
  const wrong=structuredClone(sourceResult);wrong.metadata.source_windows[0].source_end_sec=91;await assert.rejects(finishCrimeFootageProofStage({proofDir,stage:'source_assets',attemptToken:source.attempt_token,result:wrong}),/selected window/);
  status=await finishCrimeFootageProofStage({proofDir,stage:'source_assets',attemptToken:source.attempt_token,result:sourceResult});assert.equal(status.next_stage,'narration');
  await assert.rejects(beginCrimeFootageProofStage({proofDir,stage:'source_assets',inputs:[]}),/Next valid stage/);
  console.log('Source-assets lifecycle: passed (synthetic video+audio, exact windows, refusal/no-write, token and immutable-stage checks).');
  if(process.argv.includes('--source-only'))process.exitCode=0;
  else{
    const narration=await beginCrimeFootageProofStage({proofDir,stage:'narration',inputs:[]});const wav=path.join(narration.outputDir,'synthetic-unit.wav');
    await exec('ffmpeg',['-v','error','-n','-f','lavfi','-i','sine=frequency=660:sample_rate=24000:duration=0.7','-ac','1','-c:a','pcm_s16le',wav],{timeout:10000});
    const n={id:'narration-N01',...await crimeFootageFileRef(wav),kind:'narration_unit',source_ids:['V01']};const provider=await write(path.join(narration.outputDir,'synthetic-provider.json'),{synthetic_fixture:true,real_provider_invoked:false});
    const nr={artifacts:[n,{id:'synthetic-provider',...provider,kind:'provider_receipt',source_ids:[]}],metadata:{source_text_sha256:identity.script.sha256,tempo:1,technical_qa:'needs_review',voice,units:[{id:'N01',artifact_id:n.id,text:script,text_sha256:sha(script),measured_duration_sec:.7}]},cost_usd:0};
    status=await finishCrimeFootageProofStage({proofDir,stage:'narration',attemptToken:narration.attempt_token,result:nr});assert.equal(status.next_stage,'program_review');
    const manifest={schema:'crime_footage_proof_render_manifest_v1',width:1920,height:1080,fps:30,min_duration_sec:90,max_duration_sec:150,production_eligible:false,publish_allowed:false,
      segments:[{id:'S01',plan_scene_id:'S01',kind:'footage',duration_frames:2700,source_id:'V01',window_id:'W01',video:{path:clip,sha256:asset.sha256,in_sec:0,out_sec:90},audio:{path:clip,sha256:asset.sha256,in_sec:0,out_sec:90,origin:'original_court_audio'},source_label:'Synthetic source fixture',captions:[]},
        {id:'S02',plan_scene_id:'S02',kind:'graphic',duration_frames:21,narration_unit_id:'N01',audio:{path:wav,sha256:n.sha256,in_sec:0,out_sec:.7,origin:'qwen_narration'},source_label:'Synthetic narrator fixture',title:'SYNTHETIC TEST',captions:[]}]};
    const manifestRef=await write(path.join(root,'manifest.json'),manifest);const program=await beginCrimeFootageProofStage({proofDir,stage:'program_review',inputs:[manifestRef]});
    const videoPath=path.join(program.outputDir,'synthetic-program.mp4');
    await exec('ffmpeg',['-v','error','-n','-i',clip,'-f','lavfi','-i','color=c=black:s=320x180:r=30:d=0.7','-i',wav,'-filter_complex','[0:v]scale=1920:1080,setsar=1[v0];[1:v]scale=1920:1080,setsar=1[v1];[2:a]aresample=48000[a1];[v0][0:a][v1][a1]concat=n=2:v=1:a=1[v][a]','-map','[v]','-map','[a]','-c:v','libx264','-preset','ultrafast','-crf','35','-pix_fmt','yuv420p','-r','30','-c:a','aac','-b:a','64k',videoPath],{timeout:90000,maxBuffer:100000});
    const qa=await write(path.join(program.outputDir,'synthetic-qa.json'),{synthetic_fixture:true,actual_clancy_media_review:false});
    const pr={artifacts:[{id:'program-video',...await crimeFootageFileRef(videoPath),kind:'program_video',source_ids:['V01']},{id:'program-qa',...qa,kind:'program_qa',source_ids:[]}],metadata:{source_text_sha256:identity.script.sha256,tempo:1,whole_narration_preserved:true,original_audio_preserved:true,technical_qa:'needs_review',measured_duration_sec:90.7,render_manifest:manifestRef},cost_usd:0};
    status=await finishCrimeFootageProofStage({proofDir,stage:'program_review',attemptToken:program.attempt_token,result:pr});assert.equal(status.state,'awaiting_program_review');assert.equal(status.approval_recorded,false);
    await assert.rejects(beginCrimeFootageProofStage({proofDir,stage:'program_review',inputs:[manifestRef]}),/no overwrite/);
    const output=await executeCrimeFootageProofCli(['status','--episode-dir',proofDir]);assert.equal(output.publish_allowed,false);
    const failDir=path.join(root,'failure-proof');await preflightCrimeFootageProof({proofDir:failDir,repoDir:repo,identity,allowDirtyWorktree:true,dirtyReason:'Explicit failure-state synthetic fixture.'});const attempt=await beginCrimeFootageProofStage({proofDir:failDir,stage:'source_assets',inputs:[]});
    await failCrimeFootageProofStage({proofDir:failDir,stage:'source_assets',attemptToken:attempt.attempt_token,note:'Intentional synthetic failure'});assert.equal((await crimeFootageProofStatus({proofDir:failDir})).state,'needs_triage');await assert.rejects(beginCrimeFootageProofStage({proofDir:failDir,stage:'source_assets',inputs:[]}),/no overwrite/);
    console.log('Complete private source-footage flow: passed; every output remains unapproved. No actual narration, case-content or listening-quality claim.');
  }
}finally{await fs.rm(root,{recursive:true,force:true});}
