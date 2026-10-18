import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {QWEN_JOEL_PRIMARY_LOCK as PIN} from './narration-tts-policy.mjs';

// A separate private route. Never reinterpret or mutate a retained v1 identity.
export const CRIME_FOOTAGE_PROOF_VERSION = '2026-09-09.1';
export const CRIME_FOOTAGE_PROOF_WORKFLOW = 'crime_footage_private_proof_v1';
export const CRIME_FOOTAGE_PROOF_STAGES = Object.freeze(['source_assets', 'narration', 'program_review']);
const exec = promisify(execFile);
const sha = data => createHash('sha256').update(data).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const need = (ok, message) => { if (!ok) throw new Error(`Crime footage proof: ${message}`); };
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && x.trim().length > 0;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const positive = x => finite(x) && x > 0;
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = (file, value) => fs.writeFile(file, JSON.stringify(value,null,2)+'\n', {flag:'wx',mode:0o600});
const exists = async file => Boolean(await fs.lstat(file).catch(e => {if(e.code==='ENOENT')return null; throw e;}));
const inside = (parent, child) => {const r=path.relative(parent,child); return r!==''&&!r.startsWith(`..${path.sep}`)&&r!=='..'&&!path.isAbsolute(r);};
function keys(value, allowed, label) {
  need(plain(value), `${label} must be an object`);
  need(Object.keys(value).every(k=>allowed.includes(k)), `${label} has unsupported fields`);
}
function safe(value) {
  if(Array.isArray(value))return value.every(safe);
  if(plain(value))return Object.entries(value).every(([k,v])=>!/^(?:api_key|access_token|bearer_token|cookie|cookies|signed_url|session_state)$/i.test(k)&&safe(v));
  return typeof value!=='string'||!(/\bBearer\s+\S+|https?:\/\/[^\s"<>]+[?&](?:token|access_token|api_key|signature|sig|X-Amz-[^=]+|X-Goog-[^=]+)=/i.test(value));
}
function publicUrl(value) {
  let u;try{u=new URL(value);}catch{need(false,'Public source URL required');}
  need(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&safe(value),'Only public unsigned source URLs may be recorded');
}
export async function crimeFootageFileRef(file) {
  need(path.isAbsolute(file??''),'Absolute file path required');
  const st=await fs.lstat(file);need(st.isFile()&&!st.isSymbolicLink(),'File binding must be a regular file');
  return {path:file,sha256:sha(await fs.readFile(file))};
}
async function checked(ref) {
  need(plain(ref)&&HASH.test(ref.sha256??''),'Exact file hash required');
  const actual=await crimeFootageFileRef(ref.path);need(actual.sha256===ref.sha256,`Changed bound file: ${ref.path}`);return actual;
}
export function crimeFootageWorkflowContract() {
  const c={schema:'goldflow_media_workflow_v1',id:CRIME_FOOTAGE_PROOF_WORKFLOW,version:CRIME_FOOTAGE_PROOF_VERSION,stage_registry_version:CRIME_FOOTAGE_PROOF_VERSION};
  return {...c,sha256:sha(JSON.stringify(c))};
}
function voiceLock(n) {
  keys(n,['provider','model','model_revision','voice_id','voice_sha256','reference_audio','reference_text'],'Narration');
  const expected={provider:PIN.provider,model:PIN.model_id,model_revision:PIN.model_revision,voice_id:PIN.voice_id,voice_sha256:PIN.voice_sha256};
  need(Object.entries(expected).every(([k,v])=>n[k]===v),'Only the existing owned Joel local Qwen narrator is enabled');
  need(n.reference_audio?.path===PIN.reference_audio_path&&n.reference_audio?.sha256===PIN.reference_audio_sha256&&n.reference_text?.sha256===PIN.reference_text_sha256,'Narrator reference lock differs');
}
function validateIdentity(i,stored=false) {
  keys(i,['schema','content_profile','media_workflow','channel','channel_name','series_slug','run_slug','episode','title','run_intent','production_eligible','publish_allowed','plan','script','sources','narration','proof_scope','audio_mastering','execution_authorization','code_files',...(stored?['workflow_contract','git','created_at','review_state']:[])],'Identity');
  need(i.schema==='goldflow_crime_footage_proof_identity_v1'&&i.content_profile==='true_crime_proof_v1'&&i.media_workflow===CRIME_FOOTAGE_PROOF_WORKFLOW,'Exact new private footage identity required');
  need(i.channel==='crimedungeon'&&i.channel_name==='CrimeDungeon'&&SLUG.test(i.series_slug??'')&&SLUG.test(i.run_slug??'')&&/^ep_\d+$/.test(i.episode??'')&&text(i.title),'Exact CrimeDungeon identity fields required');
  need(!/(?:^|-)ep-?\d+(?:-|$)/.test(i.run_slug),'Episode number belongs in episode');
  need(i.run_intent==='proof'&&i.production_eligible===false&&i.publish_allowed===false,'Production and publishing must remain disabled');
  need(equal(i.proof_scope,{min_duration_sec:90,max_duration_sec:150,fps:30,width:1920,height:1080}),'Only a private 90–150 second 1080p30 proof is enabled');
  if(i.audio_mastering!==undefined)need(equal(i.audio_mastering,{sample_rate_hz:24000,channels:1,integrated_lufs:-16,true_peak_dbtp:-1.5}),'Narrator mastering targets must remain explicit');
  voiceLock(i.narration);
  keys(i.execution_authorization,['operator','authorized_at','instruction','note'],'Execution authorization');
  const a=i.execution_authorization;need(text(a.operator)&&text(a.instruction)&&text(a.note)&&!Number.isNaN(Date.parse(a.authorized_at)),'Retain actual operator execution instruction and scope; this is not script approval');
  need(Array.isArray(i.sources)&&i.sources.length>0&&i.sources.length<=12,'Bounded selected source inventory required');
  const ids=new Set();let windows=0,total=0;
  for(const s of i.sources){
    keys(s,['id','url','kind','locator','use_basis','windows'],'Source');
    need(ID.test(s.id??'')&&!ids.has(s.id)&&text(s.locator)&&text(s.use_basis),'Unique source ID, locator and scoped use basis required');ids.add(s.id);publicUrl(s.url);
    need(['video','evidence'].includes(s.kind)&&Array.isArray(s.windows),'Source kind and explicit windows required');
    need(s.kind==='video'?s.windows.length>0:s.windows.length===0,'Only selected video sources have media windows');
    const ws=new Set();for(const w of s.windows){
      keys(w,['id','start_sec','end_sec'],'Source window');
      need(ID.test(w.id??'')&&!ws.has(w.id)&&finite(w.start_sec)&&w.start_sec>=0&&positive(w.end_sec-w.start_sec)&&w.end_sec-w.start_sec<=150,'Exact positive source windows, at most150 seconds each, required');
      ws.add(w.id);windows++;total+=w.end_sec-w.start_sec;
    }
  }
  need(windows>0&&windows<=16&&total<=300,'Private source selection is bounded to16 windows and300 seconds');
  need(i.code_files===undefined||Array.isArray(i.code_files),'Code bindings must be an array');
  need(safe(i),'Private credentials cannot enter identities');
  if(stored){
    need(equal(i.workflow_contract,crimeFootageWorkflowContract()),'Changed workflow contract; identities cannot migrate');
    need(plain(i.git)&&HASH.test(i.git.dirty_diff_sha256??'')&&text(i.git.commit),'Git provenance required');
    need(equal(i.review_state,{script_approved:false,narration_approved:false,program_approved:false}),'Execution authorization cannot be promoted to review approval');
  }
}
export function validateCrimeFootagePlan(plan,identity,scriptText) {
  keys(plan,['schema','title','case_name','target_duration_sec','narration_units','scenes','claims'],'Plan');
  need(plan.schema==='goldflow_crime_footage_proof_plan_v1'&&plan.case_name==='Lindsay Clancy'&&plan.title===identity.title,'Exact selected Clancy plan required');
  need(finite(plan.target_duration_sec)&&plan.target_duration_sec>=90&&plan.target_duration_sec<=150,'Plan budget must be90–150 seconds');
  const sourceIds=new Set(identity.sources.map(s=>s.id));
  const refs=(ids,label)=>need(Array.isArray(ids)&&ids.length>0&&new Set(ids).size===ids.length&&ids.every(id=>sourceIds.has(id)),`${label} needs selected source references`);
  need(Array.isArray(plan.narration_units)&&plan.narration_units.length>0&&plan.narration_units.length<=8,'One to eight short narrator units required');
  const units=new Map();let words=0;
  for(const u of plan.narration_units){
    keys(u,['id','text','source_ids'],'Narrator unit');
    const count=u.text?.trim().split(/\s+/u).length??0;
    need(ID.test(u.id??'')&&!units.has(u.id)&&text(u.text)&&u.text===u.text.trim()&&count<=60&&/[.!?]["'”’)]?$/u.test(u.text),'Unique complete narrator units of at most60 words required');
    need(!/[\p{N}\u0000-\u0008\u000b\u000c\u000e-\u001f]|\[[^\]\n]+\]|<\|speaker:|```/u.test(u.text),'Narrator spoken text cannot contain unresolved digits or performance tags');
    refs(u.source_ids,'Narrator unit');units.set(u.id,u);words+=count;
  }
  need(words<=240,'Private narration is bounded to240 words');
  const joined=plan.narration_units.map(u=>u.text).join('\n\n');need(scriptText===joined||scriptText===joined+'\n','Script must exactly concatenate only the selected narrator words');
  need(Array.isArray(plan.claims)&&plan.claims.length>0,'Explicit source-backed claims required');
  const claimIds=new Set();for(const c of plan.claims){keys(c,['id','text','source_ids'],'Claim');need(ID.test(c.id??'')&&!claimIds.has(c.id)&&text(c.text),'Unique claims required');claimIds.add(c.id);refs(c.source_ids,'Claim');}
  need(Array.isArray(plan.scenes)&&plan.scenes.length>0&&plan.scenes.length<=20,'Bounded scenes required');
  const ids=new Set(),consumed=[];
  for(const s of plan.scenes){
    keys(s,['id','type','source_ids','source_window_refs','narration_unit_ids','picture_origin','audio_origin','transcript'],'Scene');
    need(ID.test(s.id??'')&&!ids.has(s.id),'Unique scene IDs required');ids.add(s.id);
    need(['video','audio_transcript','narration_bridge','title','document'].includes(s.type),'Unsupported scene type');
    refs(s.source_ids,'Scene');need(Array.isArray(s.source_window_refs)&&Array.isArray(s.narration_unit_ids),'Explicit source-window and narrator-unit assignments required');
    need(['original','authored','illustrative'].includes(s.picture_origin)&&['original','narration','none'].includes(s.audio_origin),'Original picture/audio origins must remain separate; recreated dialogue is unavailable');
    for(const r of s.source_window_refs){
      keys(r,['source_id','window_id'],'Scene source reference');
      need(s.source_ids.includes(r.source_id)&&identity.sources.find(x=>x.id===r.source_id)?.windows.some(w=>w.id===r.window_id),'Scene refers to unselected source window');
    }
    need(s.narration_unit_ids.every(id=>units.has(id)&&units.get(id).source_ids.every(x=>s.source_ids.includes(x))),'Scene narrator assignments need source coverage');
    consumed.push(...s.narration_unit_ids);
    if(s.audio_origin==='narration')need(s.narration_unit_ids.length>0,'Narrator scene requires units');else need(s.narration_unit_ids.length===0,'Original audio cannot be mislabeled narrator speech');
    if(s.audio_origin==='original'||s.type==='video')need(s.source_window_refs.length>0,'Original footage/audio requires selected source windows');
    if(s.type==='audio_transcript')need(s.audio_origin==='original','Transcript cards in this proof use original court audio only');
    if(s.transcript){
      keys(s.transcript,['text','speaker','source_id','window_id','verified'],'Transcript');const t=s.transcript;
      need(text(t.text)&&text(t.speaker)&&t.verified===true&&s.source_window_refs.some(r=>r.source_id===t.source_id&&r.window_id===t.window_id),'Transcript must bind checked exact words to its original recording');
    }
  }
  need(equal(consumed,[...units.keys()]),'Every narrator unit must appear exactly once in source order');
  need(plan.scenes.some(s=>s.audio_origin==='original'),'This route requires actual original recorded audio');
  return plan;
}
async function inputs(identity) {
  for(const r of [identity.plan,identity.script,identity.narration.reference_audio,identity.narration.reference_text,...(identity.code_files??[])])await checked(r);
  const plan=await read(identity.plan.path),scriptText=await fs.readFile(identity.script.path,'utf8');
  validateCrimeFootagePlan(plan,identity,scriptText);return {plan,scriptText};
}
async function gitState(repoDir,allowDirtyWorktree,dirtyReason) {
  need(path.isAbsolute(repoDir??''),'Absolute repository path required');
  const git=async(...args)=>(await exec('git',args,{cwd:repoDir,maxBuffer:64*1024*1024})).stdout;
  const status=await git('status','--porcelain=v1','--untracked-files=all');
  need(!status.trim()||(allowDirtyWorktree===true&&text(dirtyReason)&&dirtyReason.trim().length>=12),'Dirty proof requires explicit allow-dirty-worktree true and meaningful dirty-reason');
  const untracked=[];for(const f of (await git('ls-files','--others','--exclude-standard','-z')).split('\0').filter(Boolean)){
    const p=path.join(repoDir,f),st=await fs.lstat(p);untracked.push({path:f,sha256:sha(st.isSymbolicLink()?await fs.readlink(p):await fs.readFile(p))});
  }
  return {commit:(await git('rev-parse','HEAD')).trim(),branch:(await git('branch','--show-current')).trim(),dirty:Boolean(status.trim()),dirty_reason:status.trim()?dirtyReason:null,dirty_diff_sha256:sha(status+'\n'+await git('diff','HEAD','--binary')+'\n'+JSON.stringify(untracked))};
}
async function event(proofDir,data) {
  need(safe(data),'Unsafe execution data');const row={schema:'goldflow_crime_footage_proof_execution_v1',id:randomUUID(),recorded_at:new Date().toISOString(),production_eligible:false,publish_allowed:false,...data};
  await fs.mkdir(path.join(proofDir,'reports'),{recursive:true});const p=path.join(proofDir,'reports',row.id+'.json');await write(p,row);
  await fs.appendFile(path.join(proofDir,'execution_events.jsonl'),JSON.stringify({...row,report:await crimeFootageFileRef(p)})+'\n',{mode:0o600});
}
export async function preflightCrimeFootageProof({proofDir,repoDir,identity:requested,allowDirtyWorktree=false,dirtyReason=''}) {
  need(path.isAbsolute(proofDir??'')&&!(await exists(proofDir)),'Preflight requires a new absolute proof directory');
  const identity=structuredClone(requested);validateIdentity(identity);
  const automatic=[fileURLToPath(import.meta.url),fileURLToPath(new URL('../crime-footage-proof.mjs',import.meta.url))];
  identity.code_files=[...new Map([...(await Promise.all(automatic.map(crimeFootageFileRef))),...(identity.code_files??[])].map(r=>[r.path,r])).values()];
  await inputs(identity);identity.git=await gitState(repoDir,allowDirtyWorktree,dirtyReason);identity.workflow_contract=crimeFootageWorkflowContract();identity.created_at=new Date().toISOString();
  identity.review_state={script_approved:false,narration_approved:false,program_approved:false};validateIdentity(identity,true);
  await fs.mkdir(path.dirname(proofDir),{recursive:true});await fs.mkdir(proofDir);await write(path.join(proofDir,'run_identity.json'),identity);
  const seal=await crimeFootageFileRef(path.join(proofDir,'run_identity.json'));await write(path.join(proofDir,'identity_binding.json'),seal);
  await event(proofDir,{stage:'preflight',status:'locked',identity_sha256:seal.sha256,cost_usd:0,execution_authorization_is_review_approval:false});
  return crimeFootageProofStatus({proofDir});
}
export async function loadCrimeFootageProof({proofDir}) {
  need(path.isAbsolute(proofDir??''),'Absolute proof directory required');
  const seal=await read(path.join(proofDir,'identity_binding.json'));need(seal.path===path.join(proofDir,'run_identity.json'),'Identity seal points outside proof');await checked(seal);
  const identity=await read(seal.path);validateIdentity(identity,true);return {identity,identity_sha256:seal.sha256,...await inputs(identity),proofDir};
}
async function readStage(proofDir,stage,identityHash) {
  const file=path.join(proofDir,stage+'.json');if(!(await exists(file)))return null;
  const r=await read(file);need(r.schema==='goldflow_crime_footage_proof_stage_v1'&&r.stage===stage&&r.identity_sha256===identityHash&&r.approved===false&&r.production_eligible===false&&r.publish_allowed===false,'Stage receipt identity or review state changed');
  for(const ref of [...r.inputs,...r.artifacts,r.result])await checked(ref);
  const result=await read(r.result.path);need(equal(result.artifacts,r.artifacts)&&equal(result.metadata,r.metadata),'Retained result differs from stage receipt');return r;
}
export async function crimeFootageProofStatus({proofDir}) {
  const loaded=await loadCrimeFootageProof({proofDir}),stages=[];let next=null,blocked=false;
  const lock=await exists(path.join(proofDir,'operation.lock'))?await read(path.join(proofDir,'operation.lock')):null;
  for(const stage of CRIME_FOOTAGE_PROOF_STAGES){const r=await readStage(proofDir,stage,loaded.identity_sha256),started=await exists(path.join(proofDir,'attempts',stage,'start.json'));
    const state=r?(stage==='source_assets'?'candidate_ready':'awaiting_review'):started?(lock?.stage===stage?'running':'needs_triage'):'pending';stages.push({stage,state,receipt:r?path.join(proofDir,stage+'.json'):null});
    if(!r&&!next&&!blocked){if(started)blocked=true;else next=stage;}
  }
  if(blocked)next=null;
  return {schema:'goldflow_crime_footage_proof_status_v1',proof_dir:proofDir,identity_sha256:loaded.identity_sha256,stages,next_stage:next,state:blocked?(lock?'running':'needs_triage'):next?'in_progress':'awaiting_program_review',next_command_shape:next?`node scripts/crime-footage-proof.mjs begin --episode-dir ${JSON.stringify(proofDir)} --stage ${next} --inputs <bound-inputs.json>`:lock?`node scripts/crime-footage-proof.mjs finish --episode-dir ${JSON.stringify(proofDir)} --stage ${lock.stage} --attempt-token <exact-token> --result <result.json>`:null,production_eligible:false,publish_allowed:false,approval_recorded:false};
}
export async function beginCrimeFootageProofStage({proofDir,stage,inputs:extra=[]}) {
  need(CRIME_FOOTAGE_PROOF_STAGES.includes(stage)&&Array.isArray(extra),'Exact supported stage and input bindings required');
  const loaded=await loadCrimeFootageProof({proofDir}),status=await crimeFootageProofStatus({proofDir});need(status.next_stage===stage,`Next valid stage is ${status.next_stage??status.state}; no overwrite or automatic retry`);
  for(const r of extra)await checked(r);const upstream={},bound=[...extra,loaded.identity.plan,loaded.identity.script];
  for(const prior of CRIME_FOOTAGE_PROOF_STAGES.slice(0,CRIME_FOOTAGE_PROOF_STAGES.indexOf(stage))){upstream[prior]=await readStage(proofDir,prior,loaded.identity_sha256);bound.push(await crimeFootageFileRef(path.join(proofDir,prior+'.json')));}
  const lockPath=path.join(proofDir,'operation.lock'),handle=await fs.open(lockPath,'wx',0o600),attemptToken=randomUUID(),attemptDir=path.join(proofDir,'attempts',stage),outputDir=path.join(attemptDir,'output');
  try{need(!(await exists(attemptDir)),'Attempt exists; retained evidence cannot be replaced');await fs.mkdir(attemptDir,{recursive:true});await fs.mkdir(outputDir);
    await handle.writeFile(JSON.stringify({stage,attempt_token_sha256:sha(attemptToken)}));await write(path.join(attemptDir,'start.json'),{schema:'goldflow_crime_footage_proof_attempt_v1',stage,identity_sha256:loaded.identity_sha256,inputs:bound,producer_inputs:extra,output_dir:outputDir,attempt_token_sha256:sha(attemptToken),started_at:new Date().toISOString(),automatic_retry_allowed:false});
    await event(proofDir,{stage,status:'started',identity_sha256:loaded.identity_sha256,inputs:bound,cost_usd:null});
    return {...loaded,stage,outputDir,inputs:extra,upstream,attempt_token:attemptToken};
  }catch(e){await fs.unlink(lockPath).catch(()=>{});throw e;}finally{await handle.close();}
}
export async function loadCrimeFootageProofAttempt({proofDir,stage,attemptToken}) {
  need(CRIME_FOOTAGE_PROOF_STAGES.includes(stage)&&text(attemptToken),'Exact stage and attempt token required');const loaded=await loadCrimeFootageProof({proofDir});
  const lock=await read(path.join(proofDir,'operation.lock')),start=await read(path.join(proofDir,'attempts',stage,'start.json'));
  need(lock.stage===stage&&lock.attempt_token_sha256===sha(attemptToken)&&start.attempt_token_sha256===lock.attempt_token_sha256&&start.identity_sha256===loaded.identity_sha256,'Current exact guarded attempt required');
  need(!(await exists(path.join(proofDir,stage+'.json'))),'Stage already completed');for(const r of start.inputs)await checked(r);
  const upstream={};for(const prior of CRIME_FOOTAGE_PROOF_STAGES.slice(0,CRIME_FOOTAGE_PROOF_STAGES.indexOf(stage)))upstream[prior]=await readStage(proofDir,prior,loaded.identity_sha256);
  return {...loaded,stage,outputDir:start.output_dir,inputs:start.producer_inputs,upstream,start,attempt_token:attemptToken};
}
async function probe(file) {
  return JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{timeout:60000,maxBuffer:2*1024*1024})).stdout);
}
function duration(p,type) {const s=p.streams.find(s=>s.codec_type===type);return Number(s?.duration??p.format?.duration);}
async function validateResult(result,ctx) {
  keys(result,['artifacts','metadata','cost_usd'],'Producer result');need(Array.isArray(result.artifacts)&&result.artifacts.length>0&&plain(result.metadata)&&safe(result),'Actual safe artifacts and metadata required');
  need((finite(result.cost_usd)&&result.cost_usd>=0)||(ctx.stage==='source_assets'&&result.cost_usd===null&&result.metadata.cost_status==='provider_cost_not_reported'),'Known actual nonnegative cost or explicitly unreported source-tool cost required');
  need(result.metadata.approved!==true&&result.metadata.production_eligible!==true&&result.metadata.publish_allowed!==true,'Producers cannot approve or publish');
  const artifacts=new Map(),real=await fs.realpath(ctx.outputDir),sourceIds=new Set(ctx.identity.sources.map(s=>s.id));
  for(const a of result.artifacts){
    keys(a,['id','path','sha256','kind','source_ids'],'Artifact');need(ID.test(a.id??'')&&!artifacts.has(a.id)&&text(a.kind),'Unique typed artifacts required');await checked(a);
    need(inside(real,await fs.realpath(a.path)),'All produced artifacts must remain inside this guarded attempt');
    need(Array.isArray(a.source_ids)&&a.source_ids.every(id=>sourceIds.has(id)),'Artifacts require selected source IDs');artifacts.set(a.id,a);
  }
  const m=result.metadata;
  if(ctx.stage==='source_assets'){
    need(Array.isArray(m.source_windows),'Acquired source-window provenance required');const seen=new Set();
    for(const row of m.source_windows){
      const s=ctx.identity.sources.find(s=>s.id===row.source_id),w=s?.windows.find(w=>w.id===row.window_id),a=artifacts.get(row.artifact_id),key=row.source_id+'/'+row.window_id;
      need(w&&!seen.has(key)&&a?.kind==='source_video'&&a.source_ids.includes(s.id)&&row.public_url===s.url&&text(row.acquisition_method),'Each acquired window must bind its selected public URL, method and video artifact');seen.add(key);
      need(row.source_start_sec===w.start_sec&&row.source_end_sec===w.end_sec&&row.audio_origin==='original','Acquisition must preserve the selected window and original audio origin');
      const p=await probe(a.path);need(p.streams.some(s=>s.codec_type==='video')&&p.streams.some(s=>s.codec_type==='audio'),'Selected source window must contain real video and audio');
      const wanted=w.end_sec-w.start_sec,vd=duration(p,'video'),ad=duration(p,'audio');
      const exact=Math.abs(vd-wanted)<=.2&&Math.abs(ad-wanted)<=.2;
      const eof=row.end_of_source_truncated===true&&positive(row.actual_duration_sec)&&Math.abs(row.actual_duration_sec-vd)<=.08&&wanted-vd>0&&wanted-vd<=1&&Math.abs(vd-ad)<=.2;
      need(exact||eof,'Acquired window duration differs from selected bounds; an explicitly measured EOF truncation may remove at most one second');
      if(row.actual_duration_sec!==undefined)need(positive(row.actual_duration_sec)&&Math.abs(row.actual_duration_sec-vd)<=.08,'Reported acquired duration disagrees with actual video');
    }
    need(ctx.identity.sources.flatMap(s=>s.windows.map(w=>s.id+'/'+w.id)).every(k=>seen.has(k)),'Every selected media window must have exact acquired bytes');
  }else if(ctx.stage==='narration'){
    need(m.source_text_sha256===ctx.identity.script.sha256&&m.tempo===1&&['passed','needs_review'].includes(m.technical_qa),'Exact narrator text, tempo and technical QA required');
    const expected={provider:ctx.identity.narration.provider,model:ctx.identity.narration.model,model_revision:ctx.identity.narration.model_revision,voice_id:ctx.identity.narration.voice_id,voice_sha256:ctx.identity.narration.voice_sha256};
    need(equal(m.voice,expected),'Narrator voice/model drift');need(Array.isArray(m.units)&&equal(m.units.map(u=>u.id),ctx.plan.narration_units.map(u=>u.id)),'Complete narrator unit coverage in exact order required');
    let total=0;for(const [n,u] of m.units.entries()){
      const a=artifacts.get(u.artifact_id),planned=ctx.plan.narration_units[n];need(a?.kind==='narration_unit'&&u.text===planned.text&&u.text_sha256===sha(planned.text),'Unit must retain exact selected narrator text');
      const p=await probe(a.path),audio=p.streams.find(s=>s.codec_type==='audio');need(p.format?.format_name==='wav'&&audio?.codec_name==='pcm_s16le'&&audio.sample_rate==='24000'&&audio.channels===1,'Narrator candidate requires24kHz mono PCM16 WAV');
      const seconds=duration(p,'audio');need(positive(seconds)&&Math.abs(seconds-u.measured_duration_sec)<=1/24000+.000001,'Narrator duration must be measured');total+=seconds;
    }
    need(total<=150&&artifacts.size>=m.units.length+1&&[...artifacts.values()].some(a=>a.kind==='provider_receipt'),'Retained Qwen provider receipt and bounded candidate required');
  }else{
    need(m.source_text_sha256===ctx.identity.script.sha256&&m.tempo===1&&m.whole_narration_preserved===true&&m.original_audio_preserved===true&&['passed','needs_review'].includes(m.technical_qa),'Program must separately preserve complete narrator units and selected original audio');
    const video=[...artifacts.values()].find(a=>a.kind==='program_video');need(video&&[...artifacts.values()].some(a=>a.kind==='program_qa'),'Program video and QA report required');
    const p=await probe(video.path),v=p.streams.find(s=>s.codec_type==='video'),a=p.streams.find(s=>s.codec_type==='audio'),seconds=duration(p,'video');
    need(v?.width===1920&&v.height===1080&&v.avg_frame_rate==='30/1'&&a&&seconds>=90&&seconds<=150&&Math.abs(seconds-duration(p,'audio'))<=.08&&Math.abs(seconds-m.measured_duration_sec)<=.08,'Actual program must be1080p30 with90–150 seconds of aligned picture/audio');
    need(plain(m.render_manifest)&&ctx.inputs.some(r=>r.path===m.render_manifest.path&&r.sha256===m.render_manifest.sha256),'Render manifest must be bound before program work');await checked(m.render_manifest);
    let transcriptReviews=[];
    if(m.transcript_review){need(ctx.inputs.some(r=>r.path===m.transcript_review.path&&r.sha256===m.transcript_review.sha256),'Transcript review must be bound before render');await checked(m.transcript_review);transcriptReviews=await read(m.transcript_review.path);need(Array.isArray(transcriptReviews),'Transcript review must list exact reviewed passages');}
    await validateProgramBindings(await read(m.render_manifest.path),ctx,transcriptReviews);
  }
}
async function validateProgramBindings(manifest,ctx,transcriptReviews=[]) {
  need(manifest.schema==='crime_footage_proof_render_manifest_v1'&&manifest.production_eligible===false&&manifest.publish_allowed===false,'Exact isolated renderer manifest required');
  need(Array.isArray(manifest.segments)&&manifest.segments.length===ctx.plan.scenes.length,'Program must retain every selected scene in order');
  const sourceAssets=new Map(ctx.upstream.source_assets.artifacts.map(a=>[a.id,a])),narrationAssets=new Map(ctx.upstream.narration.artifacts.map(a=>[a.id,a]));let narratorIds=[];
  for(const [i,s] of manifest.segments.entries()){
    const scene=ctx.plan.scenes[i];need((s.plan_scene_id??s.id)===scene.id,'Program scene order differs from plan');
    if(s.audio.origin==='qwen_narration'){
      need(scene.audio_origin==='narration'&&scene.narration_unit_ids.length===1&&s.narration_unit_id===scene.narration_unit_ids[0],'Narration segment must bind one complete planned narrator unit');
      const u=ctx.upstream.narration.metadata.units.find(u=>u.id===s.narration_unit_id),a=narrationAssets.get(u?.artifact_id);need(a&&s.audio.path===a.path&&s.audio.sha256===a.sha256&&s.audio.in_sec===0&&Math.abs(s.audio.out_sec-u.measured_duration_sec)<1/24000+.000001,'Program must preserve complete retained narrator WAV');narratorIds.push(u.id);
    }else{
      need(s.audio.origin==='original_court_audio'&&scene.audio_origin==='original'&&scene.source_window_refs.some(r=>r.source_id===s.source_id&&r.window_id===s.window_id),'Recorded audio must bind the selected original source window');
      const w=ctx.upstream.source_assets.metadata.source_windows.find(w=>w.source_id===s.source_id&&w.window_id===s.window_id),a=sourceAssets.get(w?.artifact_id);need(a&&s.audio.path===a.path&&s.audio.sha256===a.sha256&&s.audio.in_sec>=0&&s.audio.out_sec<=w.source_end_sec-w.source_start_sec+.2,'Original audio path/time must belong to acquired source window');
    }
    if(s.video){
      const window=ctx.upstream.source_assets.metadata.source_windows.find(w=>w.source_id===s.source_id&&w.window_id===s.window_id),a=sourceAssets.get(window?.artifact_id);need(a&&s.video.path===a.path&&s.video.sha256===a.sha256&&s.video.in_sec>=0&&s.video.out_sec<=window.source_end_sec-window.source_start_sec+.2,'Picture must use a selected acquired video window');
    }
    if(scene.type==='audio_transcript'){
      const review=scene.transcript??transcriptReviews.find(r=>r.scene_id===scene.id);
      need(review?.verified===true&&text(review.text)&&text(review.speaker)&&review.source_id===s.source_id&&review.window_id===s.window_id&&s.kind==='audio_transcript'&&s.transcript_text===review.text,'Transcript card must preserve exact words checked against its source before render');
      if(!scene.transcript)need(text(review.reviewer)&&text(review.method),'Later transcript verification needs reviewer and method; it is not whole-program approval');
    }
  }
  need(equal(narratorIds,ctx.plan.narration_units.map(u=>u.id)),'Program omits, duplicates or reorders narrator speech');
}
export async function finishCrimeFootageProofStage({proofDir,stage,attemptToken,result}) {
  const ctx=await loadCrimeFootageProofAttempt({proofDir,stage,attemptToken});
  // Refusals preserve the active token and artifacts; an operator can inspect and close failure.
  await validateResult(result,ctx);for(const ref of ctx.start.inputs)await checked(ref);await loadCrimeFootageProof({proofDir});
  const resultPath=path.join(proofDir,'attempts',stage,'producer-result.json');await write(resultPath,result);const resultRef=await crimeFootageFileRef(resultPath);
  const receipt={schema:'goldflow_crime_footage_proof_stage_v1',stage,identity_sha256:ctx.identity_sha256,approved:false,production_eligible:false,publish_allowed:false,inputs:ctx.start.inputs,artifacts:result.artifacts,metadata:result.metadata,result:resultRef,cost_usd:result.cost_usd,completed_at:new Date().toISOString()};
  await write(path.join(proofDir,stage+'.json'),receipt);await event(proofDir,{stage,status:'candidate_ready_needs_review',identity_sha256:ctx.identity_sha256,result:resultRef,cost_usd:result.cost_usd});await fs.unlink(path.join(proofDir,'operation.lock'));return crimeFootageProofStatus({proofDir});
}
export async function failCrimeFootageProofStage({proofDir,stage,attemptToken,note}) {
  need(text(note),'Exact failure/triage note required');const ctx=await loadCrimeFootageProofAttempt({proofDir,stage,attemptToken});
  await write(path.join(proofDir,'attempts',stage,'failure.json'),{note,identity_sha256:ctx.identity_sha256,failed_at:new Date().toISOString(),automatic_retry_allowed:false});
  await event(proofDir,{stage,status:'needs_triage',identity_sha256:ctx.identity_sha256,note,cost_usd:null});await fs.unlink(path.join(proofDir,'operation.lock'));return crimeFootageProofStatus({proofDir});
}
