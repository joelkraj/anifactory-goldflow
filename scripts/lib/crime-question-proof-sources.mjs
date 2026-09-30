import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createFootageRangeProxy} from './footage-range-reader.mjs';
import {loadCrimeFootageProofAttempt,crimeFootageFileRef} from './crime-footage-proof-workflow.mjs';

// New producer bound to a fresh private-proof attempt. Historical producers and
// identities stay unchanged. CDN URLs never leave this process or its children.
const PYTHON='/Users/joel/AniFactoryData/tooling/crime-footage-acquisition-2026-09-09/bin/python';
const SELF=fileURLToPath(import.meta.url);
const RANGE=fileURLToPath(new URL('./footage-range-reader.mjs',import.meta.url));
const SCHEMA='crime_question_proof_source_acquisition_v1';
const need=(ok,message)=>{if(!ok)throw new Error(`Crime question sources: ${message}`);};
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const write=(p,x)=>fs.writeFile(p,JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600});
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const keyOf=w=>`${w.source_id}/${w.window_id}`;
function keys(x,allowed,label){need(plain(x)&&Object.keys(x).every(k=>allowed.includes(k)),`${label} has unsupported fields`);}
const english=s=>typeof s==='string'&&/^en(?:-|$)/i.test(s);
const finite=n=>typeof n==='number'&&Number.isFinite(n);

export function crimeQuestionPublicSource(value){
  let u;try{u=new URL(value);}catch{need(false,'exact public source URL required');}
  need(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash,'credential-free public HTTPS URL required');
  if(['www.youtube.com','youtube.com'].includes(u.hostname)&&u.pathname==='/watch'&&/^[A-Za-z0-9_-]{11}$/.test(u.searchParams.get('v')??'')&&[...u.searchParams.keys()].every(k=>k==='v'))return {platform:'youtube',id:u.searchParams.get('v'),url:value};
  const match=/^\/@[A-Za-z0-9_.]+\/video\/(\d+)$/.exec(u.pathname);
  need(['www.tiktok.com','tiktok.com'].includes(u.hostname)&&match&&!u.search,'only exact public YouTube watch or TikTok video URL supported');
  return {platform:'tiktok',id:match[1],url:value};
}

export function validateCrimeQuestionSourceRecipe(identity,recipe,proofDir){
  keys(recipe,['schema','scope','to_proof_dir','authorization_instruction','max_download_bytes_per_window','max_elapsed_sec_per_window','cookies_allowed','full_source_download_allowed','max_submissions_per_window','automatic_retry_allowed','selected_windows'],'Recipe');
  need(recipe.schema===SCHEMA&&recipe.scope==='identity_selected_public_windows_only','exact source-acquisition recipe required');
  need(path.isAbsolute(proofDir??'')&&recipe.to_proof_dir===proofDir,'exact guarded destination required');
  need(identity.media_workflow==='crime_footage_private_proof_v1'&&identity.content_profile==='true_crime_proof_v1'&&identity.run_intent==='proof'&&identity.production_eligible===false&&identity.publish_allowed===false,'fresh private footage proof only');
  need(recipe.authorization_instruction===identity.execution_authorization?.instruction&&typeof recipe.authorization_instruction==='string'&&recipe.authorization_instruction.trim(),'retain exact execution instruction; no approval implied');
  need(Number.isSafeInteger(recipe.max_download_bytes_per_window)&&recipe.max_download_bytes_per_window>=1024*1024&&recipe.max_download_bytes_per_window<=128*1024*1024,'per-window transfer cap must be1–128MiB');
  need(Number.isSafeInteger(recipe.max_elapsed_sec_per_window)&&recipe.max_elapsed_sec_per_window>=1&&recipe.max_elapsed_sec_per_window<=180,'per-window time cap must be1–180seconds');
  need(recipe.cookies_allowed===false&&recipe.full_source_download_allowed===false&&recipe.max_submissions_per_window===1&&recipe.automatic_retry_allowed===false,'no cookies, full-source download, repeat submission or automatic retry');
  need(Array.isArray(recipe.selected_windows)&&recipe.selected_windows.length>0&&recipe.selected_windows.length<=16,'bounded exact windows required');
  const seen=new Set();
  for(const row of recipe.selected_windows){
    keys(row,['source_id','window_id','video_format_id','audio_format_id','audio_policy','audio_content','audio_review_note'],'Selected window');
    const key=keyOf(row),source=identity.sources.find(s=>s.id===row.source_id),window=source?.windows.find(w=>w.id===row.window_id);
    need(source?.kind==='video'&&window&&!seen.has(key),'each selected window must occur once in identity');seen.add(key);
    const pub=crimeQuestionPublicSource(source.url);
    need(typeof row.video_format_id==='string'&&/^[A-Za-z0-9_.-]+$/.test(row.video_format_id),'exact native video format ID required');
    need(typeof row.audio_review_note==='string'&&row.audio_review_note.trim().length>=30,'specific audio/source-context review note required');
    need(['original_court_testimony','publisher_edited_court_testimony'].includes(row.audio_content),'separate original testimony from a publisher edit');
    if(pub.platform==='youtube')need(row.audio_policy==='english_original_or_single_language'&&typeof row.audio_format_id==='string'&&/^[A-Za-z0-9_.-]+$/.test(row.audio_format_id),'YouTube needs exact English original/single-language audio format');
    else need(row.audio_policy==='reviewed_muxed_publisher_audio'&&row.audio_format_id===null&&row.audio_content==='publisher_edited_court_testimony','TikTok preserves its reviewed muxed publisher audio; never assert continuous primary source');
  }
  const expected=identity.sources.flatMap(s=>s.windows.map(w=>`${s.id}/${w.id}`));
  need(expected.length===seen.size&&expected.every(k=>seen.has(k)),'recipe must cover every identity-selected media window');
  return true;
}

function safeFormat(f){return {id:String(f.format_id),container:f.ext,width:f.width??null,height:f.height??null,video_codec:f.vcodec,audio_codec:f.acodec,source_bytes:Number.isSafeInteger(f.filesize)?f.filesize:null,language:f.language??null,language_preference:f.language_preference??null,format_note:f.format_note??null};}

// Metadata IDs and language are locked together. Bitrate never chooses language.
export function selectCrimeQuestionFormats(metadata,selection,publicUrl){
  const pub=crimeQuestionPublicSource(publicUrl);
  need(metadata?.ok&&String(metadata.id)===pub.id,metadata?.code??'public metadata ID differs');
  need(finite(metadata.duration)&&metadata.duration>0&&Array.isArray(metadata.formats),'usable source duration/formats required');
  const named=id=>{const rows=metadata.formats.filter(f=>String(f.format_id)===id);need(rows.length===1,'exact selected format unavailable or ambiguous');return rows[0];};
  const video=named(selection.video_format_id);
  need(video.ext==='mp4'&&video.protocol==='https'&&video.vcodec&&video.vcodec!=='none'&&Math.min(video.width??0,video.height??0)>=720,'native HTTPS MP4 at720shortside required');
  let audio=video,audio_language_basis;
  if(pub.platform==='youtube'){
    need(selection.audio_policy==='english_original_or_single_language'&&video.acodec==='none','explicit separate YouTube video/audio required');
    audio=named(selection.audio_format_id);
    need(audio.ext==='m4a'&&audio.protocol==='https'&&audio.vcodec==='none'&&audio.acodec?.startsWith('mp4a')&&english(audio.language),'selected audio must be English M4A');
    need(!/\bDRC\b|dubbed|descriptive|description/i.test(audio.format_note??'')&&!/-drc$/.test(audio.format_id),'alternate descriptive/dubbed/DRC audio refused');
    const original=/\boriginal\b/i.test(audio.format_note??'')&&audio.language_preference>=0;
    const allAudio=metadata.formats.filter(f=>f.acodec&&f.acodec!=='none');
    const singleLanguage=allAudio.length>0&&allAudio.every(f=>english(f.language))&&english(metadata.language);
    need(original||singleLanguage,'English is not established as the original or sole language; no bitrate fallback');
    audio_language_basis=original?'format_explicitly_labels_English_original':'all_exposed_audio_formats_and_source_language_are_English';
  }else{
    need(selection.audio_policy==='reviewed_muxed_publisher_audio'&&selection.audio_format_id===null&&video.acodec&&video.acodec!=='none','selected TikTok format must contain its original muxed audio');
    audio_language_basis='publisher_muxed_track_language_requires_content_review';
  }
  for(const f of new Set([video,audio])){let u;try{u=new URL(f.url);}catch{need(false,'transient media endpoint unavailable');}need(u.protocol==='https:'&&!u.username&&!u.password,'credential-free HTTPS media endpoint required');}
  return {video,audio,muxed:video===audio,duration_sec:metadata.duration,audio_language_basis};
}

function runPrivate(bin,args,{timeoutMs=45000,maxOutputBytes=32*1024*1024}={}){
  return new Promise((resolve,reject)=>{
    const p=spawn(bin,args,{stdio:['ignore','pipe','pipe']});let done=false,size=0;const chunks=[];
    const timer=setTimeout(()=>{p.kill('SIGKILL');finish(new Error('Bounded subprocess timed out; private diagnostics withheld'));},timeoutMs);
    function finish(error,value){if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);}
    p.stdout.on('data',b=>{size+=b.length;if(size>maxOutputBytes){p.kill('SIGKILL');finish(new Error('Private subprocess output exceeded cap'));}else chunks.push(b);});
    p.stderr.on('data',()=>{});
    p.once('error',()=>finish(new Error('Required local subprocess could not start')));
    p.once('close',code=>finish(code===0?null:new Error(`Bounded subprocess failed (${code}); private diagnostics withheld`),Buffer.concat(chunks).toString()));
  });
}
const METADATA=String.raw`
import yt_dlp,json,contextlib,io,sys
class Quiet:
 def debug(self,*x): pass
 def info(self,*x): pass
 def warning(self,*x): pass
 def error(self,*x): pass
try:
 with contextlib.redirect_stderr(io.StringIO()):
  with yt_dlp.YoutubeDL({'quiet':True,'no_warnings':True,'skip_download':True,'socket_timeout':15,'retries':0,'fragment_retries':0,'extractor_retries':0,'noplaylist':True,'cachedir':False,'logger':Quiet()}) as y:
   x=y.extract_info(sys.argv[1],download=False)
 fields=['format_id','ext','protocol','width','height','vcodec','acodec','filesize','url','abr','fps','language','language_preference','format_note']
 print(json.dumps({'ok':True,'id':x.get('id'),'duration':x.get('duration'),'language':x.get('language'),'formats':[{k:f.get(k) for k in fields} for f in x.get('formats',[])]}))
except Exception as e:
 t=str(e).lower()
 code='public_metadata_sign_in_required' if 'sign in' in t else ('public_metadata_http_403' if '403' in t else 'public_metadata_unavailable')
 print(json.dumps({'ok':False,'code':code}))
`;
async function metadataFor(publicUrl,timeoutMs=45000){crimeQuestionPublicSource(publicUrl);const text=await runPrivate(PYTHON,['-c',METADATA,publicUrl],{timeoutMs});try{return JSON.parse(text);}catch{throw new Error('Metadata parse failed; private response withheld');}}

/** Read-only format discovery. Never returns a transient URL or downloads media. */
export async function inspectCrimeQuestionSourceMetadata({publicUrl}){
  const m=await metadataFor(publicUrl);need(m.ok,m.code??'public metadata unavailable');
  return {source_url:publicUrl,id:m.id,duration_sec:m.duration,source_language:m.language,formats:m.formats.filter(f=>f.protocol==='https'&&['mp4','m4a'].includes(f.ext)).map(safeFormat),download_performed:false,cookies_used:false};
}
async function inspect(args,requireEmpty=true){
  const ctx=await loadCrimeFootageProofAttempt({proofDir:args.proofDir,stage:'source_assets',attemptToken:args.attemptToken});
  const recipeRef=await crimeFootageFileRef(args.recipePath),producer=await crimeFootageFileRef(SELF),range=await crimeFootageFileRef(RANGE);
  for(const r of [recipeRef,producer,range])need(ctx.inputs.some(i=>i.path===r.path&&i.sha256===r.sha256),'recipe,producer and range reader must all be bound before acquisition');
  const recipe=await read(args.recipePath);validateCrimeQuestionSourceRecipe(ctx.identity,recipe,args.proofDir);
  if(requireEmpty)need((await fs.readdir(ctx.outputDir)).length===0,'source output must be empty; no overwrite or retry');
  return {ctx,recipe,recipeRef,producer,range};
}
async function acquireWindow(x,selection,outputDir){
  const source=x.ctx.identity.sources.find(s=>s.id===selection.source_id),window=source.windows.find(w=>w.id===selection.window_id);
  const folder=path.join(outputDir,`${source.id}-${window.id}`);await fs.mkdir(folder);
  const started=Date.now(),maximumMs=x.recipe.max_elapsed_sec_per_window*1000,maximumBytes=x.recipe.max_download_bytes_per_window;
  const remaining=()=>{const ms=maximumMs-(Date.now()-started);need(ms>0,'window time budget exhausted');return ms;};
  const dispatchPath=path.join(folder,'dispatch.json');
  await write(dispatchPath,{schema:'crime_question_source_dispatch_v1',source_id:source.id,window_id:window.id,public_url:source.url,source_start_sec:window.start_sec,source_end_sec:window.end_sec,selection,recipe:x.recipeRef,producer:x.producer,range_reader:x.range,started_at:new Date(started).toISOString(),cookies_used:false,max_submissions:1,automatic_retry_allowed:false});
  const proxies=[];
  try{
    const selected=selectCrimeQuestionFormats(await metadataFor(source.url,Math.min(45000,remaining())),selection,source.url);
    need(window.start_sec>=0&&window.end_sec<=selected.duration_sec+.1&&window.end_sec>window.start_sec,'locked window exceeds source duration');
    need(window.start_sec>0||window.end_sec<selected.duration_sec,'whole source selection is not supported');
    const streams=selected.muxed?[[selected.video,maximumBytes]]:[[selected.video,Math.floor(maximumBytes*7/8)],[selected.audio,maximumBytes-Math.floor(maximumBytes*7/8)]];
    for(const[f,budget]of streams)proxies.push(await createFootageRangeProxy({url:f.url,bytes:Number.isSafeInteger(f.filesize)&&f.filesize>0?f.filesize:undefined,maxBytes:budget,timeoutMs:remaining(),chunkBytes:64*1024,maxRequests:2048}));
    const outputPath=path.join(folder,'source-window.mp4'),duration=window.end_sec-window.start_sec;
    const inputs=selected.muxed?['-ss',String(window.start_sec),'-i',proxies[0].url]:['-ss',String(window.start_sec),'-i',proxies[0].url,'-ss',String(window.start_sec),'-i',proxies[1].url];
    await runPrivate('ffmpeg',['-nostdin','-v','error','-n',...inputs,'-t',String(duration),'-map','0:v:0','-map',selected.muxed?'0:a:0':'1:a:0','-c:v','libx264','-preset','veryfast','-crf','19','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-movflags','+faststart',outputPath],{timeoutMs:remaining(),maxOutputBytes:1024});
    for(const p of proxies)p.assertHealthy();const stats=proxies.map(p=>({...p.stats}));await Promise.all(proxies.map(p=>p.close()));
    const transferred=stats.reduce((sum,s)=>sum+s.transferred_bytes,0);
    need(transferred>0&&transferred<=maximumBytes&&stats.every(s=>Number.isSafeInteger(s.source_bytes)&&s.transferred_bytes<s.source_bytes),'whole-source exclusion or transfer cap failed; partial output retained');
    const probe=JSON.parse(await runPrivate('ffprobe',['-v','error','-show_streams','-show_format','-of','json',outputPath],{timeoutMs:remaining(),maxOutputBytes:2*1024*1024}));
    const video=probe.streams.find(s=>s.codec_type==='video'),audio=probe.streams.find(s=>s.codec_type==='audio'),vd=Number(video?.duration??probe.format?.duration),ad=Number(audio?.duration??probe.format?.duration);
    need(video&&audio&&finite(vd)&&finite(ad)&&Math.abs(vd-duration)<=.2&&Math.abs(ad-duration)<=.2,'extracted picture/audio duration differs from exact selected window');
    const evidence={schema:'crime_question_source_transfer_v1',source_id:source.id,window_id:window.id,public_url:source.url,source_start_sec:window.start_sec,source_end_sec:window.end_sec,source_duration_sec:selected.duration_sec,actual_duration_sec:vd,selected_video:safeFormat(selected.video),selected_audio:safeFormat(selected.audio),muxed_source:selected.muxed,audio_language_basis:selected.audio_language_basis,audio_content:selection.audio_content,audio_review_note:selection.audio_review_note,streams:stats,downloaded_bytes:transferred,elapsed_sec:(Date.now()-started)/1000,cookies_used:false,whole_source_downloaded:false,source_window_only:true,automatic_retry_allowed:false,max_submissions:1,source_completeness_evidence:'Total transferred payload for each representation was strictly smaller than its full source size.',human_listening_performed:false,metadata_language_is_not_listening_approval:true};
    const evidencePath=path.join(folder,'transfer-evidence.json');await write(evidencePath,evidence);
    const artifact={id:`source-${source.id}-${window.id}`,...await crimeFootageFileRef(outputPath),kind:'source_video',source_ids:[source.id]};
    return {artifact,evidence,receipt:{id:`transfer-${source.id}-${window.id}`,...await crimeFootageFileRef(evidencePath),kind:'source_acquisition_receipt',source_ids:[source.id]},dispatch:{id:`dispatch-${source.id}-${window.id}`,...await crimeFootageFileRef(dispatchPath),kind:'execution_receipt',source_ids:[source.id]}};
  }catch(error){
    const failure=proxies.find(p=>p.failure)?.failure;await Promise.allSettled(proxies.map(p=>p.close()));
    const code=String(failure?.code??'QUESTION_SOURCE_ACQUISITION_FAILED'),note=String(failure?.message??error?.message??'Acquisition failed').replace(/https?:\/\/\S+/g,'[transient URL withheld]').slice(0,500);
    await write(path.join(folder,'failure.json'),{code,note,elapsed_sec:(Date.now()-started)/1000,streams:proxies.map(p=>({...p.stats})),partial_output_retained:true,automatic_retry_allowed:false});
    throw new Error(`${code}: ${note}`);
  }
}

export async function produceCrimeQuestionProofSources(args){
  const x=await inspect(args),outputDir=path.join(x.ctx.outputDir,'question-source-acquisition');await fs.mkdir(outputDir);
  await write(path.join(outputDir,'start.json'),{schema:'crime_question_source_start_v1',identity_sha256:x.ctx.identity_sha256,recipe:x.recipeRef,producer:x.producer,range_reader:x.range,started_at:new Date().toISOString(),automatic_retry_allowed:false,approval_granted:false});
  const artifacts=[],source_windows=[];
  for(const selection of x.recipe.selected_windows){
    const acquired=await acquireWindow(x,selection,outputDir);artifacts.push(acquired.artifact,acquired.receipt,acquired.dispatch);
    const e=acquired.evidence;source_windows.push({source_id:e.source_id,window_id:e.window_id,artifact_id:acquired.artifact.id,public_url:e.public_url,acquisition_method:'One no-cookie public metadata resolution and bounded native-media range extraction; exact locked format IDs and audio-language policy; no retry or fallback',source_start_sec:e.source_start_sec,source_end_sec:e.source_end_sec,audio_origin:'original',actual_duration_sec:e.actual_duration_sec,audio_content:e.audio_content,audio_language_basis:e.audio_language_basis,selected_video:e.selected_video,selected_audio:e.selected_audio,transfer_evidence:{path:acquired.receipt.path,sha256:acquired.receipt.sha256}});
  }
  await inspect(args,false);
  for(const a of artifacts)need((await crimeFootageFileRef(a.path)).sha256===a.sha256,'acquired file changed before result');
  return {artifacts,metadata:{source_windows,source_audio_language_policy:'explicit_original_English_or_reviewed_publisher_mux',cookies_used:false,whole_source_downloaded:false,new_narration:false,human_listening_performed:false,approved:false,production_eligible:false,publish_allowed:false},cost_usd:0};
}
