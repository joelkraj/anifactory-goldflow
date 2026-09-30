import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadCrimeFootageProof,crimeFootageFileRef} from './crime-footage-proof-workflow.mjs';
import {loadCrimeFootageProofAttempt} from './crime-footage-editorial-workflow.mjs';

const SCHEMA='crime_footage_editorial_source_reuse_v1';
const need=(ok,message)=>{if(!ok)throw new Error(`Crime footage editorial sources: ${message}`);};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const inside=(base,p)=>{const r=path.relative(base,p);return r!==''&&r!=='..'&&!r.startsWith(`..${path.sep}`)&&!path.isAbsolute(r);};
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const write=(p,x)=>fs.writeFile(p,JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600});
const keyOf=w=>`${w.source_id}/${w.window_id}`;
function keys(value,allowed,label){need(plain(value)&&Object.keys(value).every(k=>allowed.includes(k)),`${label} has unsupported fields`);}
async function checked(ref){const actual=await crimeFootageFileRef(ref?.path);need(actual.sha256===ref?.sha256,`bound file changed: ${ref?.path}`);return actual;}
function requireBound(ctx,ref,label){need(ctx.inputs.some(r=>r.path===ref.path&&r.sha256===ref.sha256),`${label} must be bound before source work`);}

/** This revision can change its argument and runtime; it cannot import new media. */
export function validateCrimeFootageEditorialSourceIdentity(oldIdentity,newIdentity,recipe){
  keys(recipe,['schema','scope','from_proof_dir','to_proof_dir','from_identity','from_source_stage','selected_windows','authorization_instruction','review_note'],'Recipe');
  need(recipe.schema===SCHEMA&&recipe.scope==='same_case_verified_source_windows_new_editorial_proof','exact editorial source-reuse recipe required');
  need(typeof recipe.review_note==='string'&&recipe.review_note.trim().length>=20,'specific editorial revision reason required');
  need(path.isAbsolute(recipe.from_proof_dir??'')&&path.isAbsolute(recipe.to_proof_dir??'')&&recipe.from_proof_dir!==recipe.to_proof_dir,'separate absolute old and new proof directories required');
  need(oldIdentity.media_workflow==='crime_footage_private_proof_v1'&&newIdentity.media_workflow==='crime_footage_editorial_proof_v1','only retained private footage into the new editorial proof route is supported');
  for(const k of ['schema','content_profile','channel','channel_name','series_slug','episode'])need(equal(oldIdentity[k],newIdentity[k]),`identity ${k} differs`);
  for(const i of [oldIdentity,newIdentity])need(i.run_intent==='proof'&&i.production_eligible===false&&i.publish_allowed===false,'private proof only; no production or publishing');
  need(equal(newIdentity.proof_scope,{min_duration_sec:60,max_duration_sec:90,fps:30,width:1920,height:1080}),'new editorial proof must use its explicit 60–90 second scope');
  for(const k of ['provider','model','model_revision','voice_id','voice_sha256'])need(oldIdentity.narration?.[k]===newIdentity.narration?.[k],`pinned narrator ${k} differs`);
  for(const k of ['reference_audio','reference_text'])need(oldIdentity.narration?.[k]?.sha256===newIdentity.narration?.[k]?.sha256,`pinned narrator ${k} differs`);
  need(typeof recipe.authorization_instruction==='string'&&recipe.authorization_instruction===newIdentity.execution_authorization?.instruction,'recipe must retain the exact new editorial execution instruction; this is not approval');
  need(Array.isArray(recipe.selected_windows)&&recipe.selected_windows.length>0&&recipe.selected_windows.length<=16,'explicit bounded source-window selection required');
  const seen=new Set();
  for(const selected of recipe.selected_windows){
    keys(selected,['source_id','window_id'],'Selected window');const key=keyOf(selected);
    need(!seen.has(key),'duplicate selected source window');seen.add(key);
    const before=oldIdentity.sources.find(s=>s.id===selected.source_id),after=newIdentity.sources.find(s=>s.id===selected.source_id);
    const bw=before?.windows.find(w=>w.id===selected.window_id),aw=after?.windows.find(w=>w.id===selected.window_id);
    need(before?.kind==='video'&&after?.kind==='video'&&bw&&aw&&before.url===after.url&&equal(bw,aw),'copied source ID, window ID, public URL and exact bounds must match');
  }
  const expected=newIdentity.sources.flatMap(s=>s.windows.map(w=>`${s.id}/${w.id}`));
  need(expected.length===seen.size&&expected.every(k=>seen.has(k)),'reuse selection must cover every new media window; new acquisition is unavailable');
  return true;
}

async function checkReferences(value,seen=new Set()){
  if(Array.isArray(value)){for(const x of value)await checkReferences(x,seen);return;}
  if(!plain(value))return;
  if(typeof value.path==='string'&&typeof value.sha256==='string'){
    const key=`${value.path}\n${value.sha256}`;if(!seen.has(key)){seen.add(key);await checked(value);}
  }
  for(const child of Object.values(value))await checkReferences(child,seen);
}

async function inspect({proofDir,attemptToken,recipePath},requireEmpty=true){
  const ctx=await loadCrimeFootageProofAttempt({proofDir,stage:'source_assets',attemptToken});
  const recipeRef=await crimeFootageFileRef(recipePath),helper=await crimeFootageFileRef(fileURLToPath(import.meta.url));
  requireBound(ctx,recipeRef,'Recipe');requireBound(ctx,helper,'Source-reuse producer');
  const recipe=await read(recipePath);need(recipe.to_proof_dir===proofDir,'recipe destination differs from guarded proof');
  const old=await loadCrimeFootageProof({proofDir:recipe.from_proof_dir});
  validateCrimeFootageEditorialSourceIdentity(old.identity,ctx.identity,recipe);
  need(old.plan.case_name===ctx.plan.case_name,'editorial revision must retain the same case');
  need(recipe.from_identity?.path===path.join(old.proofDir,'run_identity.json')&&recipe.from_identity.sha256===old.identity_sha256,'exact retained identity required');
  need(recipe.from_source_stage?.path===path.join(old.proofDir,'source_assets.json'),'only the completed old source stage can supply footage');
  for(const[r,label]of[[recipe.from_identity,'Old identity'],[recipe.from_source_stage,'Old source stage']]){await checked(r);requireBound(ctx,r,label);}
  const oldStage=await read(recipe.from_source_stage.path);
  need(oldStage.schema==='goldflow_crime_footage_proof_stage_v1'&&oldStage.stage==='source_assets'&&oldStage.identity_sha256===old.identity_sha256&&oldStage.approved===false&&oldStage.production_eligible===false&&oldStage.publish_allowed===false,'completed retained source receipt with private review state required');
  need(Array.isArray(oldStage.inputs)&&Array.isArray(oldStage.artifacts)&&Array.isArray(oldStage.metadata?.source_windows),'retained stage is incomplete');
  for(const r of [...oldStage.inputs,oldStage.result])await checked(r);
  need(oldStage.result.path===path.join(old.proofDir,'attempts','source_assets','producer-result.json'),'retained result must belong to its original source attempt');
  const result=await read(oldStage.result.path);
  need(equal(result.artifacts,oldStage.artifacts)&&equal(result.metadata,oldStage.metadata)&&equal(result.cost_usd,oldStage.cost_usd),'old result and source receipt disagree');
  const map=new Map(),oldOutput=await fs.realpath(path.join(old.proofDir,'attempts','source_assets','output'));
  for(const a of oldStage.artifacts){
    need(/^[A-Za-z][A-Za-z0-9_-]*$/.test(a.id??'')&&!map.has(a.id),'retained artifact IDs must be unique and safe');
    await checked(a);need(inside(oldOutput,await fs.realpath(a.path)),'retained artifact escaped its original source attempt');map.set(a.id,a);
  }
  const selections=[];
  for(const selected of recipe.selected_windows){
    const rows=oldStage.metadata.source_windows.filter(w=>keyOf(w)===keyOf(selected));need(rows.length===1,'exact completed source-window receipt required');
    const row=rows[0],asset=map.get(row.artifact_id),source=ctx.identity.sources.find(s=>s.id===selected.source_id),window=source.windows.find(w=>w.id===selected.window_id);
    need(asset?.kind==='source_video'&&Array.isArray(asset.source_ids)&&asset.source_ids.includes(source.id),'selection must use the completed original source_video, never a preview or arbitrary import');
    need(row.public_url===source.url&&row.source_start_sec===window.start_sec&&row.source_end_sec===window.end_sec&&row.audio_origin==='original','retained selected media provenance differs from new exact window');
    await checkReferences(row);selections.push({row,asset});
  }
  // Preserve the prior language-correction evidence as part of copied provenance.
  if(oldStage.metadata.source_audio_repair)await checkReferences(oldStage.metadata.source_audio_repair);
  if(requireEmpty)need((await fs.readdir(ctx.outputDir)).length===0,'source output must be empty; no overwrite or retry');
  return {ctx,old,oldStage,recipe,recipeRef,helper,selections};
}

/** Local byte copies only. No network, decode, synthesis, trimming or retiming. */
export async function produceCrimeFootageEditorialSources(args){
  const x=await inspect(args),started=Date.now(),outputDir=path.join(x.ctx.outputDir,'editorial-source-reuse');
  await fs.mkdir(outputDir); // Exclusive operation marker; partial work cannot dispatch again.
  const startPath=path.join(outputDir,'reuse-start.json');
  await write(startPath,{schema:'crime_footage_editorial_source_reuse_start_v1',recipe:x.recipeRef,producer:x.helper,from_identity:x.recipe.from_identity,to_identity_sha256:x.ctx.identity_sha256,started_at:new Date().toISOString(),automatic_retry_allowed:false,new_acquisition:false,new_narration:false,execution_authorization_is_review_approval:false});
  const artifacts=[],source_windows=[],copies=[],copiedById=new Map();
  for(const {row,asset} of x.selections){
    let copied=copiedById.get(asset.id);
    if(!copied){
      const dest=path.join(outputDir,asset.id+path.extname(asset.path));
      await fs.copyFile(asset.path,dest,constants.COPYFILE_EXCL);
      const ref=await crimeFootageFileRef(dest);need(ref.sha256===asset.sha256,'copied footage hash differs; retain partial attempt for triage');
      copied={id:asset.id,...ref,kind:'source_video',source_ids:[...new Set(x.selections.filter(s=>s.asset.id===asset.id).map(s=>s.row.source_id))]};
      copiedById.set(asset.id,copied);artifacts.push(copied);copies.push({original:asset,copied,exact_file_bytes_preserved:true});
    }
    source_windows.push({...row,artifact_id:copied.id,acquisition_method:'Exact local byte copy of the completed prior editorial source window; no new acquisition',editorial_reused_from_stage:x.recipe.from_source_stage,previous_acquisition_method:row.acquisition_method});
  }
  await inspect(args,false);for(const a of artifacts)await checked(a);
  const report={schema:'crime_footage_editorial_source_reuse_report_v1',recipe:x.recipeRef,producer:x.helper,from_identity:x.recipe.from_identity,to_identity_sha256:x.ctx.identity_sha256,from_stage:x.recipe.from_source_stage,copies,source_windows,retained_source_audio_repair:x.oldStage.metadata.source_audio_repair??null,source_stage_historical_cost_usd:x.oldStage.cost_usd,new_provider_spend_usd:0,network_bytes:0,new_acquisition:false,new_narration:false,trim_performed:false,retiming_performed:false,elapsed_sec:(Date.now()-started)/1000,execution_authorization_is_review_approval:false,human_listening_performed:false,approved:false,production_eligible:false,publish_allowed:false};
  const reportPath=path.join(outputDir,'reuse-report.json');await write(reportPath,report);
  const reportRef=await crimeFootageFileRef(reportPath),sourceIds=[...new Set(source_windows.map(w=>w.source_id))];
  artifacts.push({id:'editorial-reuse-start',...await crimeFootageFileRef(startPath),kind:'execution_receipt',source_ids:sourceIds},{id:'editorial-reuse-report',...reportRef,kind:'source_reuse_receipt',source_ids:sourceIds});
  return {artifacts,metadata:{source_windows,editorial_source_reuse_report:reportRef,reused_from:{identity:x.recipe.from_identity,stage:x.recipe.from_source_stage},new_acquisition:false,network_bytes:0,new_narration:false,human_listening_performed:false,approved:false,production_eligible:false,publish_allowed:false},cost_usd:0};
}
