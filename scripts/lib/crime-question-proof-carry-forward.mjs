import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadCrimeFootageProof,loadCrimeFootageProofAttempt,crimeFootageProofStatus,crimeFootageFileRef} from './crime-footage-proof-workflow.mjs';

const need=(ok,m)=>{if(!ok)throw new Error(`Crime question exact carry-forward: ${m}`);};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const write=(p,x)=>fs.writeFile(p,JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600});
const inside=(base,p)=>{const r=path.relative(base,p);return r!==''&&r!=='..'&&!r.startsWith(`..${path.sep}`)&&!path.isAbsolute(r);};
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
async function checked(r){const actual=await crimeFootageFileRef(r?.path);need(actual.sha256===r?.sha256,`retained binding changed: ${r?.path}`);return actual;}

export function validateCrimeQuestionCarryForwardIdentity(before,after,recipe){
  const fields=['schema','scope','from_proof_dir','to_proof_dir','from_identity','from_source_stage','from_narration_stage','reason'];
  need(plain(recipe)&&Object.keys(recipe).every(k=>fields.includes(k)),'unsupported recipe fields');
  need(recipe.schema==='crime_question_proof_exact_carry_forward_v1'&&recipe.scope==='same_identity_editorial_media_no_new_acquisition_or_generation','exact technical carry-forward recipe required');
  need(typeof recipe.reason==='string'&&recipe.reason.trim().length>=30,'specific retained-attempt technical reason required');
  need(path.isAbsolute(recipe.from_proof_dir??'')&&path.isAbsolute(recipe.to_proof_dir??'')&&recipe.from_proof_dir!==recipe.to_proof_dir,'distinct absolute proof directories required');
  const suffix=path.join('revisions','proof-v5','episodes','ep_01');
  need(recipe.from_proof_dir.endsWith(path.sep+suffix)&&recipe.to_proof_dir===recipe.from_proof_dir.slice(0,-suffix.length)+suffix.replace('proof-v5','proof-v6'),'only retained V5 into fresh sibling V6 supported');
  for(const k of ['schema','content_profile','media_workflow','channel','channel_name','series_slug','run_slug','episode','title','run_intent','production_eligible','publish_allowed','plan','script','sources','narration','proof_scope','audio_mastering'])need(equal(before[k],after[k]),`identity ${k} differs; no creative or source changes allowed`);
  for(const i of [before,after])need(i.media_workflow==='crime_footage_private_proof_v1'&&i.content_profile==='true_crime_proof_v1'&&i.run_intent==='proof'&&i.production_eligible===false&&i.publish_allowed===false,'private footage identity only');
  return true;
}

async function inspect(args,requireEmpty=true){
  need(['source_assets','narration'].includes(args.stage),'only completed source/narration media may be carried');
  const ctx=await loadCrimeFootageProofAttempt({proofDir:args.proofDir,stage:args.stage,attemptToken:args.attemptToken});
  const recipeRef=await crimeFootageFileRef(args.recipePath),helper=await crimeFootageFileRef(fileURLToPath(import.meta.url)),recipe=await read(args.recipePath);
  need(recipe.to_proof_dir===args.proofDir,'recipe destination differs from guarded attempt');
  const old=await loadCrimeFootageProof({proofDir:recipe.from_proof_dir});validateCrimeQuestionCarryForwardIdentity(old.identity,ctx.identity,recipe);
  need(recipe.from_identity?.path===path.join(old.proofDir,'run_identity.json')&&recipe.from_identity.sha256===old.identity_sha256,'exact retained V5 identity required');
  for(const r of [recipeRef,helper,recipe.from_identity,recipe.from_source_stage,recipe.from_narration_stage]){await checked(r);need(ctx.inputs.some(i=>i.path===r.path&&i.sha256===r.sha256),'recipe,helper,old identity and completed stages must be bound before copying');}
  const status=await crimeFootageProofStatus({proofDir:old.proofDir});
  need(status.stages.find(s=>s.stage==='source_assets')?.state==='candidate_ready'&&status.stages.find(s=>s.stage==='narration')?.state==='awaiting_review','completed, unapproved retained source/narration stages required');
  need(status.stages.find(s=>s.stage==='program_review')?.state==='running','retain the V5 uncompleted program attempt unchanged');
  const stages={};
  for(const [stage,r]of[['source_assets',recipe.from_source_stage],['narration',recipe.from_narration_stage]]){
    need(r.path===path.join(old.proofDir,stage+'.json'),'only completed retained stage receipts may supply media');
    const receipt=await read(r.path);
    need(receipt.schema==='goldflow_crime_footage_proof_stage_v1'&&receipt.stage===stage&&receipt.identity_sha256===old.identity_sha256&&receipt.approved===false&&receipt.production_eligible===false&&receipt.publish_allowed===false,'retained stage identity/review state differs');
    await checked(receipt.result);const result=await read(receipt.result.path);
    need(equal(receipt.artifacts,result.artifacts)&&equal(receipt.metadata,result.metadata)&&equal(receipt.cost_usd,result.cost_usd),'retained result and stage differ');
    const ids=new Set(),oldOutput=await fs.realpath(path.join(old.proofDir,'attempts',stage,'output'));
    for(const a of receipt.artifacts){need(/^[A-Za-z][A-Za-z0-9_-]*$/.test(a.id)&&!ids.has(a.id),'safe unique retained artifact IDs required');ids.add(a.id);await checked(a);need(inside(oldOutput,await fs.realpath(a.path)),'retained artifact escaped its accepted stage');}
    stages[stage]=receipt;
  }
  const narration=stages.narration.metadata;
  need(narration.source_text_sha256===ctx.identity.script.sha256&&narration.tempo===1&&equal(narration.units.map(u=>u.id),ctx.plan.narration_units.map(u=>u.id)),'retained complete narrator text/order must match');
  if(requireEmpty)need((await fs.readdir(ctx.outputDir)).length===0,'destination output must be empty; no overwrite or retry');
  return {ctx,old,recipe,recipeRef,helper,stages};
}

/** Exact local byte copies only: no network, generation, trimming or encoding. */
export async function carryForwardCrimeQuestionStage(args){
  const x=await inspect(args),stage=args.stage,original=x.stages[stage];
  const startPath=path.join(x.ctx.outputDir,'exact-carry-start.json');
  await write(startPath,{schema:'crime_question_exact_carry_start_v1',stage,from_identity:x.recipe.from_identity,to_identity_sha256:x.ctx.identity_sha256,recipe:x.recipeRef,helper:x.helper,started_at:new Date().toISOString(),new_acquisition:false,new_generation:false,automatic_retry_allowed:false});
  const copiedDir=path.join(x.ctx.outputDir,'retained-artifacts');await fs.mkdir(copiedDir);
  const artifacts=[],mapping=[];
  for(const a of original.artifacts){
    const target=path.join(copiedDir,a.id+path.extname(a.path));await fs.copyFile(a.path,target,constants.COPYFILE_EXCL);
    const copied={...a,...await crimeFootageFileRef(target)};need(copied.sha256===a.sha256,'copy changed retained artifact bytes');artifacts.push(copied);mapping.push({id:a.id,original:{path:a.path,sha256:a.sha256},copied:{path:copied.path,sha256:copied.sha256},exact_file_bytes_preserved:true});
  }
  await inspect(args,false);for(const a of artifacts)await checked(a);
  const receiptPath=path.join(x.ctx.outputDir,'exact-carry-verification.json');
  await write(receiptPath,{schema:'crime_question_exact_carry_verification_v1',stage,recipe:x.recipeRef,helper:x.helper,from_identity:x.recipe.from_identity,to_identity_sha256:x.ctx.identity_sha256,from_stage:stage==='source_assets'?x.recipe.from_source_stage:x.recipe.from_narration_stage,mapping,metadata_preserved:true,embedded_receipt_paths:'Original acquisition/generation paths deliberately remain historical provenance; exact copies and current accepted artifact paths are recorded in mapping.',historical_cost_usd:original.cost_usd,new_provider_cost_usd:0,network_calls:0,provider_calls:0,no_media_reencoding:true,all_media_bytes_preserved:true,previous_program_attempt:'V5 remains uncompleted and immutable; no attempt token reconstructed or replaced.',human_listening_performed:false,approved:false,production_eligible:false,publish_allowed:false});
  artifacts.push({id:`exact-carry-${stage}-start`,...await crimeFootageFileRef(startPath),kind:'execution_receipt',source_ids:[]},{id:`exact-carry-${stage}-verification`,...await crimeFootageFileRef(receiptPath),kind:'carry_forward_receipt',source_ids:[]});
  return {artifacts,metadata:{...original.metadata,carried_from:{identity:x.recipe.from_identity,stage:stage==='source_assets'?x.recipe.from_source_stage:x.recipe.from_narration_stage},exact_carry_verification:await crimeFootageFileRef(receiptPath),new_acquisition:false,new_generation:false,network_calls:0,provider_calls:0,human_listening_performed:false,approved:false,production_eligible:false,publish_allowed:false},cost_usd:0};
}
export const carryForwardCrimeQuestionSources=args=>carryForwardCrimeQuestionStage({...args,stage:'source_assets'});
export const carryForwardCrimeQuestionNarration=args=>carryForwardCrimeQuestionStage({...args,stage:'narration'});
