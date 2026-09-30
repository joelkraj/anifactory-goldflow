import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import test from 'node:test';
import sharp from 'sharp';
import {prepareTrueCrimeProofAssets} from '../lib/true-crime-proof-assets.mjs';
import {preflightTrueCrimeProof,beginTrueCrimeProofStage,trueCrimeProofFileRef} from '../lib/true-crime-proof-workflow.mjs';

// Provider-free workflow fixtures. The synthetic PNG and stub PDF command test
// orchestration/provenance only; they do not establish real source or render QA.
const exec=promisify(execFile);
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'true-crime-assets-tests-'));
const originalFetch=globalThis.fetch,originalPath=process.env.PATH;
const png=await sharp({create:{width:200,height:200,channels:3,background:'#36546c'}}).png().toBuffer();
const pngPath=path.join(scratch,'synthetic.png');await fs.writeFile(pngPath,png);
const pdfLog=path.join(scratch,'pdf-command.jsonl');
const binDir=path.join(scratch,'bin');await fs.mkdir(binDir);
await fs.writeFile(path.join(binDir,'pdftoppm'),`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(pdfLog)},JSON.stringify(args)+'\\n');fs.copyFileSync(${JSON.stringify(pngPath)},args.at(-1)+'.png');\n`,{mode:0o755});
process.env.PATH=`${binDir}${path.delimiter}${originalPath}`;
let sequence=0;
test.after(async()=>{globalThis.fetch=originalFetch;process.env.PATH=originalPath;await fs.rm(scratch,{recursive:true,force:true});});
async function file(dir,name,bytes){const target=path.join(dir,name);await fs.writeFile(target,bytes);return trueCrimeProofFileRef(target);}
const readJson=async target=>JSON.parse(await fs.readFile(target,'utf8'));
const emptyRecipe=()=>({schema:'goldflow_true_crime_proof_assets_v1',downloads:[],documents:[],image_operations:[]});
const download=()=>({id:'portrait_source',source_id:'P01',filename:'portrait.png',max_bytes:8000000});

async function fixture(recipe=emptyRecipe(),{bindRecipe=true}={}){
  const dir=path.join(scratch,`case-${++sequence}`);await fs.mkdir(dir);
  const repoDir=path.join(dir,'repo');await fs.mkdir(repoDir);await file(repoDir,'tracked.txt','Synthetic test repository.\n');
  for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']])await exec('git',args,{cwd:repoDir});
  const source=await file(dir,'synthetic-record.pdf','Synthetic PDF placeholder consumed only by the test command stub.\n');
  const spoken='This is a synthetic account used to test the private proof workflow.';
  const plan={schema:'goldflow_true_crime_editorial_proof_plan_v1',status:'editorial_draft',production_eligible:false,title:'Synthetic proof',working_channel:'CrimeDungeon',target_duration_sec:120,
    sources:[{id:'E01',url:'https://example.invalid/record',title:'Synthetic record',kind:'record',locator:'paragraph one',planned_use:'media_candidate',acquisition_status:'research_copy',use_basis_status:'documented',use_basis_note:'Locally authored fixture.'}],
    claims:[{id:'C01',text:'Synthetic statement.',source_ids:['E01']}],
    scenes:[{id:'S01',start_sec:0,end_sec:120,claim_ids:['C01'],source_ids:['E01'],picture:{origin:'authored',description:'Synthetic board.'},audio:{origin:'narration',text_mode:'paraphrase',text:spoken,source_ids:['E01'],exact_words_verified:false}}],
    readiness:{voice:'selected',voice_note:'Synthetic fixture voice, not an audition.',execution_route:'unsupported'}};
  const planRef=await file(dir,'plan.json',JSON.stringify(plan)),script=await file(dir,'script.txt',`${spoken}\n`);
  const identity={schema:'goldflow_true_crime_proof_identity_v1',content_profile:'true_crime_proof_v1',media_workflow:'true_crime_hybrid_proof_v1',channel:'crimedungeon',channel_name:'CrimeDungeon',series_slug:'case-files',run_slug:'synthetic-proof',episode:'ep_01',title:plan.title,run_intent:'proof',production_eligible:false,publish_allowed:false,plan:planRef,script,
    sources:[{id:'E01',acquisition:'research_copy',...source,locator:'paragraph one',use_basis:'Locally authored test input.'},{id:'P01',acquisition:'pending',url:'https://example.invalid/portrait.png',locator:'Synthetic portrait',use_basis:'Mock response only; never fetched from the network.'}],
    narration:{provider:'qwen_local',model:'fixture',model_revision:'fixture-revision',voice_id:'owned-fixture',voice_sha256:'a'.repeat(64),reference_audio:await file(dir,'reference.wav','Synthetic reference bytes, no model.'),reference_text:await file(dir,'reference.txt','Synthetic reference transcript.')},
    providers:{stills:{provider:'openai_builtin_imagegen',model:'tool_managed',operations:['background_extraction','illustrative_detective'],max_submissions:2}},
    audio_target:'narration_with_document_reading',audio_mastering:{sample_rate_hz:24000,channels:1,integrated_lufs:-16,true_peak_dbtp:-1.5},authorization:{operator:'Fixture only',authorized_at:'2026-09-08T12:00:00Z',note:'Synthetic test scope, not a real approval.',plan_sha256:planRef.sha256,script_sha256:script.sha256},proof_scope:{min_duration_sec:90,max_duration_sec:150,fps:30,width:1920,height:1080}};
  const proofDir=path.join(dir,'proof'),recipeRef=await file(dir,'recipe.json',JSON.stringify(recipe));
  await preflightTrueCrimeProof({repoDir,proofDir,identity});
  const context=await beginTrueCrimeProofStage({proofDir,stage:'source_assets',inputs:bindRecipe?[recipeRef]:[]});
  return {dir,proofDir,source,recipeRef,...context};
}
const prepare=(f,token=f.attempt_token)=>prepareTrueCrimeProofAssets({proofDir:f.proofDir,attempt_token:token,recipePath:f.recipeRef.path});
function mockFetch(respond){let calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});assert.equal(url,'https://example.invalid/portrait.png');return respond(url,options);};return calls;}

test('selected source acquisition, exact crop coordinates and source-bound image requests retain current hashes',async()=>{
  const recipe=emptyRecipe();recipe.downloads=[download()];
  recipe.documents=[{id:'record_crop',source_id:'E01',filename:'record-crop.png',page:3,dpi:216,rect_points:[48,309,516,50]}];
  recipe.image_operations=[{id:'person_cutout',operation:'background_extraction',input_asset_id:'portrait_source',prompt:'Synthetic background extraction request. No model called.'},{id:'detective_cutout',operation:'illustrative_detective',prompt:'Synthetic anonymous illustration request. No model called.'}];
  const f=await fixture(recipe),calls=mockFetch(()=>new Response(png,{headers:{'content-type':'image/png'}}));
  const result=await prepare(f),saved=await readJson(result.preparation.path);
  assert.equal(calls.length,1);assert.equal(calls[0].options.redirect,'error');assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(result.asset_count,2);assert.equal(result.image_requests.length,2);assert.deepEqual(result.preparation,await trueCrimeProofFileRef(result.preparation.path));
  assert.equal(saved.acquired_sources[0].url,'https://example.invalid/portrait.png');assert.equal(saved.acquired_sources[0].id,'P01');
  for(const artifact of saved.artifacts)assert.deepEqual({path:artifact.path,sha256:artifact.sha256},await trueCrimeProofFileRef(artifact.path));
  assert.deepEqual(saved.artifacts.map(a=>a.source_ids),[['P01'],['E01']]);
  const cropArgs=JSON.parse((await fs.readFile(pdfLog,'utf8')).trim().split('\n').at(-1));
  assert.deepEqual(cropArgs.slice(0,-2),['-f','3','-l','3','-r','216','-x','144','-y','927','-W','1548','-H','150','-singlefile','-png']);
  assert.equal(cropArgs.at(-2),f.source.path);assert.equal(cropArgs.at(-1),path.join(f.outputDir,'record-crop'));
  const edit=result.image_requests[0];assert.deepEqual(edit.input,{path:saved.artifacts[0].path,sha256:saved.artifacts[0].sha256});
  assert.equal(edit.provider,'openai_builtin_imagegen');assert.equal(edit.model,'tool_managed');assert.equal(edit.attempt,1);assert.equal(edit.automatic_retry,false);assert.equal(result.image_requests[1].input,null);
  assert.deepEqual(edit.request,await trueCrimeProofFileRef(edit.request.path));
  await assert.rejects(prepare(f),/EEXIST/);assert.equal(calls.length,1,'an existing attempt must never issue a second download');
});

test('wrong token, unbound recipe and changed recipe fail before acquisition or preparation writes',async()=>{
  for(const kind of ['token','unbound','changed']){
    const recipe=emptyRecipe();recipe.downloads=[download()];const f=await fixture(recipe,{bindRecipe:kind!=='unbound'});
    if(kind==='changed')await fs.appendFile(f.recipeRef.path,' ');
    const calls=mockFetch(()=>{throw new Error('Unexpected network request');});
    await assert.rejects(prepare(f,kind==='token'?'incorrect-token':f.attempt_token),kind==='token'?/exact open source-assets attempt/:/recipe must be bound/);
    assert.equal(calls.length,0);assert.deepEqual(await fs.readdir(f.outputDir),[]);
  }
});

test('changed research sources are detected before any selected download',async()=>{
  const recipe=emptyRecipe();recipe.downloads=[download()];const f=await fixture(recipe);await fs.appendFile(f.source.path,'Changed.');
  const calls=mockFetch(()=>{throw new Error('Unexpected network request');});
  await assert.rejects(prepare(f),/Stale or changed file binding/);assert.equal(calls.length,0);assert.deepEqual(await fs.readdir(f.outputDir),[]);
});

test('unsafe filenames, duplicate IDs, repeated operations and excessive lists are refused before acquisition',async()=>{
  const variants=[];
  let recipe=emptyRecipe();recipe.downloads=[{...download(),filename:'../outside.png'}];variants.push(recipe);
  recipe=emptyRecipe();recipe.downloads=[download(),{...download(),filename:'another.png'}];variants.push(recipe);
  recipe=emptyRecipe();recipe.downloads=[download(),{...download(),id:'second'},{...download(),id:'third'}];variants.push(recipe);
  recipe=emptyRecipe();recipe.image_operations=[{id:'one',operation:'illustrative_detective',prompt:'Fixture'},{id:'two',operation:'illustrative_detective',prompt:'Fixture'}];variants.push(recipe);
  for(const variant of variants){const f=await fixture(variant),calls=mockFetch(()=>{throw new Error('Unexpected network request');});await assert.rejects(prepare(f));assert.equal(calls.length,0);assert.deepEqual(await fs.readdir(f.outputDir),[]);}
});

test('bad MIME, undersized image and byte overflow retain one attempted request without retry',async()=>{
  const tiny=await sharp({create:{width:20,height:20,channels:3,background:'#223344'}}).png().toBuffer();
  for(const kind of ['mime','tiny','overflow']){
    const recipe=emptyRecipe();recipe.downloads=[{...download(),max_bytes:kind==='overflow'?10:8000000}];const f=await fixture(recipe);
    const calls=mockFetch(()=>new Response(kind==='tiny'?tiny:png,{headers:{'content-type':kind==='mime'?'text/html':'image/png'}}));
    await assert.rejects(prepare(f),kind==='overflow'?/exceeds the locked byte limit/:kind==='mime'?/did not return an image/:/unusably small/);
    assert.equal(calls.length,1);assert.equal((await readJson(path.join(f.outputDir,'portrait.png.request.json'))).automatic_retry,false);
    await assert.rejects(fs.stat(path.join(f.outputDir,'portrait.png')),/ENOENT/);
    await assert.rejects(prepare(f),/EEXIST/);assert.equal(calls.length,1);
  }
});

test('an unselected source and an image edit without an acquired input cannot create a usable request',async()=>{
  let recipe=emptyRecipe();recipe.downloads=[{...download(),source_id:'UNKNOWN'}];let f=await fixture(recipe);let calls=mockFetch(()=>{throw new Error('Unexpected network request');});
  await assert.rejects(prepare(f),/selected pending HTTPS source/);assert.equal(calls.length,0);
  recipe=emptyRecipe();recipe.image_operations=[{id:'cutout',operation:'background_extraction',input_asset_id:'missing',prompt:'Synthetic edit request.'}];f=await fixture(recipe);calls=mockFetch(()=>{throw new Error('Unexpected network request');});
  await assert.rejects(prepare(f),/edit input must be an acquired asset/);assert.equal(calls.length,0);await assert.rejects(fs.stat(path.join(f.outputDir,'cutout.request.json')),/ENOENT/);
});
