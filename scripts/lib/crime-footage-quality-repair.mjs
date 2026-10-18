import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadCrimeFootageProofAttempt,crimeFootageFileRef} from './crime-footage-proof-workflow.mjs';

// Technical acquisition-quality correction only. No network or media dispatch.
const exec=promisify(execFile),VERSION='2026-09-09.1';
const need=(ok,msg)=>{if(!ok)throw new Error(`Crime footage HD repair: ${msg}`);};
const text=x=>typeof x==='string'&&x.trim().length>0;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const positive=x=>finite(x)&&x>0;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const write=(p,x)=>fs.writeFile(p,JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600});
const exists=async p=>Boolean(await fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;}));
const inside=(parent,p)=>{const r=path.relative(parent,p);return r!==''&&r!=='..'&&!r.startsWith(`..${path.sep}`)&&!path.isAbsolute(r);};
function safe(x){if(Array.isArray(x))return x.every(safe);if(plain(x))return Object.entries(x).every(([k,v])=>!/^(?:api_key|access_token|bearer_token|cookie|cookies|signed_url|session_state)$/i.test(k)&&safe(v));return typeof x!=='string'||!(/\bBearer\s+\S+|https?:\/\/[^\s"<>]+[?&](?:token|access_token|api_key|signature|sig|X-Amz-[^=]+|X-Goog-[^=]+)=/i.test(x));}
async function checked(ref){need(ref?.path&&ref?.sha256,'Exact file reference required');const a=await crimeFootageFileRef(ref.path);need(a.sha256===ref.sha256,`Bound file changed: ${ref.path}`);return a;}
async function probe(p){return JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',p],{timeout:45000,maxBuffer:2*1024*1024})).stdout);}
function videoInfo(p){const v=p.streams?.find(x=>x.codec_type==='video'),a=p.streams?.find(x=>x.codec_type==='audio');return{width:v?.width,height:v?.height,short_side:Math.min(v?.width??0,v?.height??0),duration_sec:Number(v?.duration??p.format?.duration),audio_duration_sec:Number(a?.duration??p.format?.duration),has_audio:Boolean(a)};}
const keys=(x,list,label)=>need(plain(x)&&Object.keys(x).every(k=>list.includes(k)),`${label} has unsupported fields`);

export function validateCrimeFootageHdRepairRecipe(recipe,context,originalRecipe){
  keys(recipe,['schema','scope','review_note','original_acquisition_recipe','max_total_download_bytes','windows','code_files'],'Recipe');
  need(recipe.schema==='goldflow_crime_footage_hd_quality_repair_v1'&&recipe.scope==='same_sources_same_windows_hd_quality_only','Exact same-source quality-repair scope required');
  need(text(recipe.review_note)&&/^user-authorized proof quality repair\b/i.test(recipe.review_note),'Explicit user-authorized proof quality repair note required');
  need(recipe.max_total_download_bytes===536870912,'Repair total transfer cap is512MiB');
  need(Array.isArray(recipe.windows)&&recipe.windows.length>0&&recipe.windows.length<=4,'One to four exact selected windows required');
  need(originalRecipe?.schema==='crimedungeon_bounded_source_acquisition_v1'&&originalRecipe.provider==='vidiq_edit_media'&&Array.isArray(originalRecipe.requests),'Exact original bounded vidIQ recipe required');
  const seen=new Set();let bytes=0;
  const mapped=recipe.windows.map(row=>{
    keys(row,['id','source_id','window_id','low_quality','target_filename','max_download_bytes','max_elapsed_sec'],'Repair window');
    need(/^[A-Za-z][A-Za-z0-9_-]*$/.test(row.id??'')&&!seen.has(row.id),'Unique repair window ID required');seen.add(row.id);
    const source=context.identity.sources.find(s=>s.id===row.source_id),window=source?.windows.find(w=>w.id===row.window_id);
    const original=originalRecipe.requests.find(r=>r.id===row.id&&r.source_id===row.source_id&&r.window_id===row.window_id),q=original?.tool_request;
    need(window&&q?.op==='trim_media'&&q.sourceUrl===source.url&&q.startSeconds===window.start_sec&&q.endSeconds===window.end_sec&&q.outputFormat==='mp4','Original request, source URL and exact selected window must all agree');
    need(/^[A-Za-z][A-Za-z0-9_-]*_hd\.mp4$/.test(row.target_filename??''),'Explicit unique HD MP4 filename required');
    need(Number.isInteger(row.max_download_bytes)&&row.max_download_bytes>0&&row.max_download_bytes<=134217728,'Each selected window has at most128MiB transfer allowance');
    need(Number.isInteger(row.max_elapsed_sec)&&row.max_elapsed_sec>=1&&row.max_elapsed_sec<=300,'Each window needs an explicit time allowance at most300 seconds');bytes+=row.max_download_bytes;
    return {...row,public_url:source.url,source_start_sec:window.start_sec,source_end_sec:window.end_sec};
  });
  need(new Set(mapped.map(w=>w.target_filename)).size===mapped.length,'Output filenames must be unique');need(bytes<=recipe.max_total_download_bytes,'Selected transfer allowances exceed total cap');need(safe(recipe),'Credentials or signed URLs cannot enter repair receipts');return mapped;
}
async function repairContext({proofDir,attemptToken,repairDir}){
  const context=await loadCrimeFootageProofAttempt({proofDir,stage:'source_assets',attemptToken});
  need(repairDir===path.join(context.outputDir,'hd-quality-repair-v1'),'Repair directory must be the isolated current-attempt child');
  const seal=await read(path.join(repairDir,'repair-binding.json'));need(seal.path===path.join(repairDir,'repair-request.json'),'Repair seal points elsewhere');await checked(seal);const retained=await read(seal.path);
  need(retained.identity_sha256===context.identity_sha256&&retained.version===VERSION,'Repair identity or contract changed');
  for(const r of [retained.recipe,retained.original_acquisition_recipe,...retained.code_files,...retained.windows.map(w=>w.low_quality)])await checked(r);
  return {context,retained,repairDir};
}
async function event(dir,x){need(safe(x),'Unsafe repair event');await fs.appendFile(path.join(dir,'events.jsonl'),JSON.stringify({recorded_at:new Date().toISOString(),production_eligible:false,publish_allowed:false,...x})+'\n',{mode:0o600});}

export async function beginCrimeFootageHdQualityRepair({proofDir,attemptToken,recipePath}){
  const context=await loadCrimeFootageProofAttempt({proofDir,stage:'source_assets',attemptToken}),recipeRef=await crimeFootageFileRef(recipePath),recipe=await read(recipePath);
  await checked(recipe.original_acquisition_recipe);
  need(context.inputs.some(r=>r.path===recipe.original_acquisition_recipe.path&&r.sha256===recipe.original_acquisition_recipe.sha256),'Original acquisition recipe must belong to the open stage inputs');
  const original=await read(recipe.original_acquisition_recipe.path),windows=validateCrimeFootageHdRepairRecipe(recipe,context,original),repairDir=path.join(context.outputDir,'hd-quality-repair-v1');
  need(!(await exists(repairDir)),'Quality repair is one-shot; existing attempts cannot be overwritten');
  const outputReal=await fs.realpath(context.outputDir),verified=[];
  for(const w of windows){await checked(w.low_quality);need(inside(outputReal,await fs.realpath(w.low_quality.path)),'The retained144p original must belong to this source-assets attempt');
    const p=videoInfo(await probe(w.low_quality.path)),expected=w.source_end_sec-w.source_start_sec;
    need(p.short_side===144&&p.has_audio&&Math.abs(p.duration_sec-expected)<=.2&&Math.abs(p.audio_duration_sec-expected)<=.2,'Repair requires the exact successful144p source window with original audio');
    verified.push({...w,low_quality_probe:p});
  }
  need(recipe.code_files===undefined||Array.isArray(recipe.code_files),'Additional acquisition code bindings must be an array');for(const ref of recipe.code_files??[])await checked(ref);
  const code=[...new Map([...(await Promise.all([fileURLToPath(import.meta.url),fileURLToPath(new URL('../crime-footage-quality-repair.mjs',import.meta.url))].map(crimeFootageFileRef))),...(recipe.code_files??[])].map(r=>[r.path,r])).values()];
  const request={schema:'goldflow_crime_footage_hd_quality_request_v1',version:VERSION,identity_sha256:context.identity_sha256,recipe:recipeRef,original_acquisition_recipe:recipe.original_acquisition_recipe,review_note:recipe.review_note,scope:recipe.scope,code_files:code,windows:verified,min_short_side:720,max_submissions_per_window:1,automatic_retry_allowed:false,cookies_allowed:false,full_source_download_allowed:false,source_or_window_change_allowed:false,production_eligible:false,publish_allowed:false,created_at:new Date().toISOString()};
  await fs.mkdir(repairDir);await write(path.join(repairDir,'repair-request.json'),request);await write(path.join(repairDir,'repair-binding.json'),await crimeFootageFileRef(path.join(repairDir,'repair-request.json')));await event(repairDir,{event:'repair_started',identity_sha256:context.identity_sha256,recipe:recipeRef});
  return {repairDir,request:await crimeFootageFileRef(path.join(repairDir,'repair-request.json')),windows:verified.map(w=>({id:w.id,public_url:w.public_url,start_sec:w.source_start_sec,end_sec:w.source_end_sec})),dispatch_performed:false};
}
export async function beginCrimeFootageHdWindow(args){
  const {context,retained,repairDir}=await repairContext(args),w=retained.windows.find(w=>w.id===args.windowId);need(w,'Exact selected repair window required');
  const dir=path.join(repairDir,w.id);need(!(await exists(dir)),'This window already has retained request evidence; no retry or replacement is enabled');
  await fs.mkdir(dir);const request={schema:'goldflow_crime_footage_hd_window_request_v1',identity_sha256:context.identity_sha256,repair_request:await crimeFootageFileRef(path.join(repairDir,'repair-request.json')),id:w.id,source_id:w.source_id,window_id:w.window_id,public_url:w.public_url,source_start_sec:w.source_start_sec,source_end_sec:w.source_end_sec,output_path:path.join(dir,w.target_filename),min_short_side:720,max_download_bytes:w.max_download_bytes,max_elapsed_sec:w.max_elapsed_sec,max_submissions:1,cookies_allowed:false,full_source_download_allowed:false,source_window_only:true,automatic_retry_allowed:false,created_at:new Date().toISOString()};
  await write(path.join(dir,'request.json'),request);const requestRef=await crimeFootageFileRef(path.join(dir,'request.json'));await write(path.join(dir,'request-binding.json'),requestRef);await event(repairDir,{event:'window_request_locked',window_id:w.id,request:requestRef});return {...request,request:requestRef,dispatch_performed:false};
}
export async function loadCrimeFootageHdWindow(args){
  const {context,retained,repairDir}=await repairContext(args),window=retained.windows.find(w=>w.id===args.windowId);need(window,'Exact selected repair window required');
  const dir=path.join(repairDir,window.id),requestRef=await read(path.join(dir,'request-binding.json'));need(requestRef.path===path.join(dir,'request.json'),'Window request seal points elsewhere');await checked(requestRef);const request=await read(requestRef.path);
  for(const file of ['receipt.json','failure.json','network-dispatch.json'])need(!(await exists(path.join(dir,file))),'Window has retained dispatch/result/failure evidence; no repeated acquisition allowed');
  need(!(await exists(request.output_path)),'HD output already exists; never replace retained media');
  return {context,retained,repairDir,window,request,requestRef,windowDir:dir};
}
export async function finishCrimeFootageHdWindow(args){
  const {context,retained,repairDir}=await repairContext(args),w=retained.windows.find(w=>w.id===args.windowId);need(w,'Exact selected repair window required');
  const dir=path.join(repairDir,w.id),requestBinding=await read(path.join(dir,'request-binding.json')),result=args.result;
  need(requestBinding.path===path.join(dir,'request.json'),'Window request seal points elsewhere');await checked(requestBinding);const request=await read(requestBinding.path);
  need(!(await exists(path.join(dir,'receipt.json')))&&!(await exists(path.join(dir,'failure.json'))),'Window already finished or failed; no retry enabled');
  keys(result,['path','sha256','downloaded_bytes','elapsed_sec','cookies_used','whole_source_downloaded','source_window_only','acquisition_method','cost_usd','transfer_evidence','quality_origin'],'Window result');
  need(result.path===request.output_path&&result.cookies_used===false&&result.whole_source_downloaded===false&&result.source_window_only===true&&text(result.acquisition_method),'Exact bounded output and no-cookie/no-full-source acquisition evidence required');
  need(result.quality_origin==='native_source_representation','Upscaling or generated detail cannot satisfy HD acquisition quality');
  need(Number.isInteger(result.downloaded_bytes)&&result.downloaded_bytes>0&&result.downloaded_bytes<=w.max_download_bytes&&positive(result.elapsed_sec)&&result.elapsed_sec<=w.max_elapsed_sec,'Actual transfer/time accounting must fit the selected budgets');
  need(finite(result.cost_usd)&&result.cost_usd>=0,'Actual known acquisition dollar cost required');need(safe(result),'No credentials or signed result URLs may be retained');await checked(result);need(inside(await fs.realpath(dir),await fs.realpath(result.path)),'HD output must remain inside its exact window attempt');
  const st=await fs.stat(result.path);need(st.size>0&&st.size<=268435456,'Retained HD output must fit its separate256MiB artifact bound; output size does not establish transferred bytes');
  const transfer=await checked(result.transfer_evidence);need(inside(await fs.realpath(dir),await fs.realpath(transfer.path)),'Sanitized transfer evidence must remain inside the window attempt');
  const evidence=await read(transfer.path);need(evidence.source_url===w.public_url&&evidence.start_sec===w.source_start_sec&&evidence.end_sec===w.source_end_sec&&evidence.cookies_used===false&&evidence.whole_source_downloaded===false&&evidence.source_window_only===true&&evidence.downloaded_bytes===result.downloaded_bytes&&evidence.elapsed_sec===result.elapsed_sec&&evidence.max_submissions===1&&evidence.automatic_retry_allowed===false,'Transfer evidence must independently bind exact scope and accounting');
  need(Number.isInteger(evidence.selected_format_width)&&Number.isInteger(evidence.selected_format_height)&&Math.min(evidence.selected_format_width,evidence.selected_format_height)>=720,'Record the native selected representation dimensions; output upscaling is not HD provenance');need(safe(evidence),'Transfer evidence contains unsafe data');
  const p=videoInfo(await probe(result.path)),expected=w.source_end_sec-w.source_start_sec;
  need(p.short_side>=720&&p.width===evidence.selected_format_width&&p.height===evidence.selected_format_height&&p.has_audio,'Acquired source must be native720p or higher with original audio');
  need(Math.abs(p.duration_sec-expected)<=.2&&Math.abs(p.audio_duration_sec-expected)<=.2,'HD quality correction cannot change source window duration');
  const receipt={schema:'goldflow_crime_footage_hd_window_receipt_v1',identity_sha256:context.identity_sha256,request:await crimeFootageFileRef(path.join(dir,'request.json')),source_id:w.source_id,window_id:w.window_id,public_url:w.public_url,source_start_sec:w.source_start_sec,source_end_sec:w.source_end_sec,low_quality:w.low_quality,output:await crimeFootageFileRef(result.path),transfer_evidence:transfer,probe:p,acquisition_method:result.acquisition_method,quality_origin:result.quality_origin,downloaded_bytes:result.downloaded_bytes,elapsed_sec:result.elapsed_sec,cost_usd:result.cost_usd,approved:false,production_eligible:false,publish_allowed:false,completed_at:new Date().toISOString()};
  await write(path.join(dir,'receipt.json'),receipt);const receiptRef=await crimeFootageFileRef(path.join(dir,'receipt.json'));await write(path.join(dir,'receipt-binding.json'),receiptRef);await event(repairDir,{event:'hd_window_candidate_ready',window_id:w.id,receipt:receiptRef});return receipt;
}
export async function failCrimeFootageHdWindow(args){
  const {retained,repairDir}=await repairContext(args);need(retained.windows.some(w=>w.id===args.windowId)&&text(args.note),'Exact selected window and failure note required');const dir=path.join(repairDir,args.windowId);const requestRef=await read(path.join(dir,'request-binding.json'));need(requestRef.path===path.join(dir,'request.json'),'Window request seal points elsewhere');await checked(requestRef);
  need(!(await exists(path.join(dir,'receipt.json')))&&!(await exists(path.join(dir,'failure.json'))),'Window already closed');need(safe(args.note),'Unsafe failure note');await write(path.join(dir,'failure.json'),{note:args.note,failed_at:new Date().toISOString(),automatic_retry_allowed:false});await event(repairDir,{event:'window_needs_triage',window_id:args.windowId,note:args.note});return {state:'needs_triage',automatic_retry_allowed:false};
}
export async function selectCrimeFootageHdRepair(args){
  const {context,retained,repairDir}=await repairContext(args),artifacts=[],source_windows=[],receipts=[],fallbackDecisions=args.failedWindowSelections??[];let totalBytes=0,totalCost=0;
  need(Array.isArray(fallbackDecisions)&&new Set(fallbackDecisions.map(x=>x.windowId)).size===fallbackDecisions.length,'Explicit unique failed-window selection decisions required');
  for(const d of fallbackDecisions){keys(d,['windowId','selection','reason','reviewer'],'Failed-window selection');need(retained.windows.some(w=>w.id===d.windowId)&&d.selection==='retain_low_quality_original'&&text(d.reason)&&text(d.reviewer),'Failed-window fallback is an explicit same-source low-quality selection, never automatic');}
  need(!(await exists(path.join(repairDir,'selection.json'))),'Retained selection cannot be replaced');
  for(const w of retained.windows){
    const file=path.join(repairDir,w.id,'receipt.json'),fallback=fallbackDecisions.find(d=>d.windowId===w.id);
    if(fallback){
      need(!(await exists(file)),'A completed HD window cannot silently fall back');const failurePath=path.join(repairDir,w.id,'failure.json'),failure=await read(failurePath);need(text(failure.note),'Fallback requires retained failed-attempt evidence');
      const failureRef=await crimeFootageFileRef(failurePath),id=w.id+'_retained144';await checked(w.low_quality);receipts.push(failureRef);
      artifacts.push({id,...w.low_quality,kind:'source_video',source_ids:[w.source_id]},{id:w.id+'_hd_failure',...failureRef,kind:'source_quality_repair_receipt',source_ids:[w.source_id]});
      source_windows.push({source_id:w.source_id,window_id:w.window_id,artifact_id:id,public_url:w.public_url,acquisition_method:'Retained original vidIQ144p preview after explicitly reviewed failed HD acquisition',source_start_sec:w.source_start_sec,source_end_sec:w.source_end_sec,audio_origin:'original',actual_duration_sec:w.low_quality_probe.duration_sec,quality_origin:'retained_original_low_resolution',quality_limitation:'144p original retained; no HD or upscaling claim',quality_failure_receipt:failureRef,selection_decision:fallback});
      continue;
    }
    const seal=await read(path.join(repairDir,w.id,'receipt-binding.json'));need(seal.path===file,'Window receipt seal points elsewhere');await checked(seal);const r=await read(file);need(r.identity_sha256===context.identity_sha256&&r.source_id===w.source_id&&r.window_id===w.window_id,'HD receipt scope changed');
    for(const ref of [r.request,r.output,r.transfer_evidence,r.low_quality])await checked(ref);const receipt=await crimeFootageFileRef(file);receipts.push(receipt);totalBytes+=r.downloaded_bytes;totalCost+=r.cost_usd;
    const id=w.id+'_hd';artifacts.push({id,...r.output,kind:'source_video',source_ids:[w.source_id]},{id:w.id+'_preview144',...w.low_quality,kind:'source_preview_low_quality',source_ids:[w.source_id]},{id:w.id+'_quality_receipt',...receipt,kind:'source_quality_repair_receipt',source_ids:[w.source_id]});
    source_windows.push({source_id:w.source_id,window_id:w.window_id,artifact_id:id,public_url:w.public_url,acquisition_method:r.acquisition_method+'; one same-source/window native-HD quality correction after retained144p output',source_start_sec:w.source_start_sec,source_end_sec:w.source_end_sec,audio_origin:'original',actual_duration_sec:r.probe.duration_sec,quality_origin:r.quality_origin,quality_repair_receipt:receipt});
  }
  need(totalBytes<=536870912,'Total repair transfer budget exceeded');const selection={schema:'goldflow_crime_footage_hd_selection_v1',identity_sha256:context.identity_sha256,repair_request:await crimeFootageFileRef(path.join(repairDir,'repair-request.json')),artifacts,source_windows,window_receipts:receipts,successful_hd_downloaded_bytes:totalBytes,successful_hd_cost_usd:totalCost,failed_acquisition_cost_accounting:'Retained in failed dispatch evidence; this selection does not claim total transfer or cost for failed windows.',failed_window_selections:fallbackDecisions,approved:false,production_eligible:false,publish_allowed:false};
  await write(path.join(repairDir,'selection.json'),selection);await event(repairDir,{event:'hd_selection_ready',selection:await crimeFootageFileRef(path.join(repairDir,'selection.json'))});return {...selection,selection:await crimeFootageFileRef(path.join(repairDir,'selection.json'))};
}
