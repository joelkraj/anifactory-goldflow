import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {QWEN_JOEL_PRIMARY_LOCK as PIN} from '../lib/narration-tts-policy.mjs';
import * as workflow from '../lib/crime-footage-proof-workflow.mjs';
import {crimeQuestionPublicSource,validateCrimeQuestionSourceRecipe,selectCrimeQuestionFormats,produceCrimeQuestionProofSources} from '../lib/crime-question-proof-sources.mjs';

// Structural selection and real guarded-attempt refusals. No network or media.
const exec=promisify(execFile),root=await fs.mkdtemp(path.join(os.tmpdir(),'crime-question-source-tests-'));
const ref=workflow.crimeFootageFileRef,yt='https://www.youtube.com/watch?v=abcdefghijk',tt='https://www.tiktok.com/@fixture/video/1234567890123456789';
const write=async(p,x)=>{await fs.writeFile(p,typeof x==='string'?x:JSON.stringify(x,null,2)+'\n');return ref(p);};
const format=(id,extra)=>({format_id:id,ext:'mp4',protocol:'https',width:1280,height:720,vcodec:'avc1.4d401f',acodec:'none',filesize:10000000,url:'https://media.example.invalid/native.mp4?transient=fixture',language:null,language_preference:-1,format_note:'720p',...extra});
const aFormat=(id,language,note,extra={})=>format(id,{ext:'m4a',width:null,height:null,vcodec:'none',acodec:'mp4a.40.2',abr:129,language,format_note:note,...extra});
const originalSelection={source_id:'V01',window_id:'W01',video_format_id:'136',audio_format_id:'140-en',audio_policy:'english_original_or_single_language',audio_content:'original_court_testimony',audio_review_note:'Synthetic fixture checks language selection; no real source audio reviewed.'};
const englishOriginal={ok:true,id:'abcdefghijk',duration:100,language:'en-US',formats:[format('136'),aFormat('140-ar','ar','Arabic, medium',{abr:129.5}),aFormat('140-en','en-US','English (US) original (default), medium',{language_preference:10,abr:129.1})]};
try{
  assert.equal(crimeQuestionPublicSource(yt).platform,'youtube');assert.equal(crimeQuestionPublicSource(tt).platform,'tiktok');
  for(const url of ['https://www.youtube.com/watch?v=abcdefghijk&sig=secret','https://www.youtube.com/shorts/abcdefghijk','https://www.tiktok.com/@fixture/video/1234567890123456789?s=46','https://user:secret@www.youtube.com/watch?v=abcdefghijk','http://www.youtube.com/watch?v=abcdefghijk','https://example.invalid/video'])assert.throws(()=>crimeQuestionPublicSource(url));
  const selected=selectCrimeQuestionFormats(englishOriginal,originalSelection,yt);assert.equal(selected.audio.format_id,'140-en');assert.equal(selected.muxed,false);assert.match(selected.audio_language_basis,/explicitly/);
  const single={ok:true,id:'abcdefghijk',duration:100,language:'en',formats:[format('136'),aFormat('140','en','medium'),aFormat('140-drc','en','medium, DRC')]};
  const singleSelection={...originalSelection,audio_format_id:'140'};
  assert.match(selectCrimeQuestionFormats(single,singleSelection,yt).audio_language_basis,/all_exposed/);
  for(const [meta,selection,reason]of[
    [englishOriginal,{...originalSelection,audio_format_id:'140-ar'},/English M4A/],
    [englishOriginal,{...originalSelection,audio_format_id:'140-missing'},/unavailable/],
    [{...englishOriginal,id:'differentid'},originalSelection,/metadata ID/],
    [{...englishOriginal,formats:englishOriginal.formats.map(f=>f.format_id==='136'?{...f,height:360}:f)},originalSelection,/720/],
    [{...englishOriginal,formats:englishOriginal.formats.map(f=>f.format_id==='140-en'?{...f,format_note:'English, medium'}:f)},originalSelection,/not established/],
    [single,{...singleSelection,audio_format_id:'140-drc'},/DRC/],
    [{...single,language:null},singleSelection,/not established/],
    [{...single,formats:[...single.formats,aFormat('140-x',null,'medium')]},singleSelection,/not established/],
    [{...single,formats:single.formats.map(f=>f.format_id==='140'?{...f,url:'http://media.example.invalid/raw'}:f)},singleSelection,/HTTPS/]
  ])assert.throws(()=>selectCrimeQuestionFormats(meta,selection,yt),reason);
  const muxSelection={...originalSelection,source_id:'V02',video_format_id:'h264_720p_555770-0',audio_format_id:null,audio_policy:'reviewed_muxed_publisher_audio',audio_content:'publisher_edited_court_testimony'};
  const mux={ok:true,id:'1234567890123456789',duration:242,language:null,formats:[format(muxSelection.video_format_id,{vcodec:'h264',acodec:'aac'})]};
  assert.equal(selectCrimeQuestionFormats(mux,muxSelection,tt).muxed,true);
  assert.throws(()=>selectCrimeQuestionFormats({...mux,formats:[format(muxSelection.video_format_id)]},muxSelection,tt),/muxed audio/);

  const proofDir=path.join(root,'proof'),identity={media_workflow:'crime_footage_private_proof_v1',content_profile:'true_crime_proof_v1',run_intent:'proof',production_eligible:false,publish_allowed:false,execution_authorization:{instruction:'Build the synthetic guarded source test.'},sources:[{id:'V01',url:yt,kind:'video',windows:[{id:'W01',start_sec:10,end_sec:20}]}]};
  const recipe={schema:'crime_question_proof_source_acquisition_v1',scope:'identity_selected_public_windows_only',to_proof_dir:proofDir,authorization_instruction:identity.execution_authorization.instruction,max_download_bytes_per_window:128*1024*1024,max_elapsed_sec_per_window:180,cookies_allowed:false,full_source_download_allowed:false,max_submissions_per_window:1,automatic_retry_allowed:false,selected_windows:[originalSelection]};
  assert.equal(validateCrimeQuestionSourceRecipe(identity,recipe,proofDir),true);
  for(const mutate of [r=>r.cookies_allowed=true,r=>r.full_source_download_allowed=true,r=>r.max_submissions_per_window=2,r=>r.automatic_retry_allowed=true,r=>r.to_proof_dir=root,r=>r.authorization_instruction='another instruction',r=>r.max_download_bytes_per_window=129*1024*1024,r=>r.max_elapsed_sec_per_window=181,r=>r.selected_windows.push({...originalSelection}),r=>r.selected_windows[0].window_id='Other',r=>r.selected_windows[0].audio_policy='bitrate',r=>r.selected_windows[0].audio_review_note='unreviewed',r=>r.unrecognized=true]){const bad=structuredClone(recipe);mutate(bad);assert.throws(()=>validateCrimeQuestionSourceRecipe(identity,bad,proofDir));}
  assert.throws(()=>validateCrimeQuestionSourceRecipe({...identity,media_workflow:'crime_footage_editorial_proof_v1'},recipe,proofDir),/fresh private/);
  const uncovered=structuredClone(identity);uncovered.sources[0].windows.push({id:'W02',start_sec:30,end_sec:40});assert.throws(()=>validateCrimeQuestionSourceRecipe(uncovered,recipe,proofDir),/every identity/);

  const repo=path.join(root,'repo');await fs.mkdir(repo);await exec('git',['init','--quiet'],{cwd:repo});await exec('git',['config','user.name','Synthetic fixture'],{cwd:repo});await exec('git',['config','user.email','fixture@example.invalid'],{cwd:repo});await fs.writeFile(path.join(repo,'README'),'Provider-free source guard fixture.\n');await exec('git',['add','README'],{cwd:repo});await exec('git',['commit','--quiet','-m','fixture'],{cwd:repo});
  const text='This is a synthetic source guard fixture.',plan={schema:'goldflow_crime_footage_proof_plan_v1',title:'Synthetic question proof',case_name:'Lindsay Clancy',target_duration_sec:90,narration_units:[{id:'N01',text,source_ids:['V01']}],claims:[{id:'C01',text:'Synthetic fixture only.',source_ids:['V01']}],scenes:[{id:'S01',type:'video',source_ids:['V01'],source_window_refs:[{source_id:'V01',window_id:'W01'}],narration_unit_ids:[],picture_origin:'original',audio_origin:'original'},{id:'S02',type:'narration_bridge',source_ids:['V01'],source_window_refs:[],narration_unit_ids:['N01'],picture_origin:'authored',audio_origin:'narration'}]};
  Object.assign(identity,{schema:'goldflow_crime_footage_proof_identity_v1',channel:'crimedungeon',channel_name:'CrimeDungeon',series_slug:'case-files',run_slug:'synthetic-question-proof',episode:'ep_01',title:plan.title,plan:await write(path.join(root,'plan.json'),plan),script:await write(path.join(root,'script.txt'),text+'\n'),narration:{provider:PIN.provider,model:PIN.model_id,model_revision:PIN.model_revision,voice_id:PIN.voice_id,voice_sha256:PIN.voice_sha256,reference_audio:{path:PIN.reference_audio_path,sha256:PIN.reference_audio_sha256},reference_text:await write(path.join(root,'reference.txt'),PIN.reference_text)},proof_scope:{min_duration_sec:90,max_duration_sec:150,fps:30,width:1920,height:1080},execution_authorization:{...identity.execution_authorization,operator:'Synthetic fixture',authorized_at:'2026-09-09T00:00:00Z',note:'No real source acquisition, model call or listening claim.'}});
  Object.assign(identity.sources[0],{locator:'Synthetic source without real acquisition.',use_basis:'Synthetic guard testing.'});
  await workflow.preflightCrimeFootageProof({proofDir,repoDir:repo,identity});
  const recipeRef=await write(path.join(root,'recipe.json'),recipe),producer=await ref(fileURLToPath(new URL('../lib/crime-question-proof-sources.mjs',import.meta.url))),range=await ref(fileURLToPath(new URL('../lib/footage-range-reader.mjs',import.meta.url)));
  const attempt=await workflow.beginCrimeFootageProofStage({proofDir,stage:'source_assets',inputs:[recipeRef,producer,range]});
  await assert.rejects(produceCrimeQuestionProofSources({proofDir,attemptToken:'wrong',recipePath:recipeRef.path}),/exact guarded attempt/);assert.deepEqual(await fs.readdir(attempt.outputDir),[]);
  const originalRecipe=await fs.readFile(recipeRef.path);await fs.appendFile(recipeRef.path,'changed');await assert.rejects(produceCrimeQuestionProofSources({proofDir,attemptToken:attempt.attempt_token,recipePath:recipeRef.path}),/Changed bound file/);await fs.writeFile(recipeRef.path,originalRecipe);assert.deepEqual(await fs.readdir(attempt.outputDir),[]);
  await fs.writeFile(path.join(attempt.outputDir,'retained-partial.txt'),'Do not overwrite.');await assert.rejects(produceCrimeQuestionProofSources({proofDir,attemptToken:attempt.attempt_token,recipePath:recipeRef.path}),/no overwrite or retry/);
  console.log('PASS: original-English vs alternate-language selection, explicit format IDs, single-language/DRC/unknown-language refusals, muxed publisher distinction, exact recipe scope, token/input/partial-attempt guards. No real media, network or listening claim.');
}finally{await fs.rm(root,{recursive:true,force:true});}
