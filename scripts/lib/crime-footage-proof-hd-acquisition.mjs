import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createFootageRangeProxy} from './footage-range-reader.mjs';

// One public, native-HD, byte-bounded correction of an already selected window.
// Resolved CDN URLs exist only in this process and are never printed or retained.
const PYTHON='/Users/joel/AniFactoryData/tooling/crime-footage-acquisition-2026-09-09/bin/python';
const need=(ok,message)=>{if(!ok)throw new Error(`Crime footage HD acquisition: ${message}`);};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const ref=async p=>({path:p,sha256:hash(await fs.readFile(p))});
const write=(p,x)=>fs.writeFile(p,JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600});
function publicYoutube(value){let u;try{u=new URL(value);}catch{throw new Error('Invalid public source URL');}need(u.protocol==='https:'&&!u.username&&!u.password&&['www.youtube.com','youtube.com'].includes(u.hostname)&&u.pathname==='/watch'&&/^[A-Za-z0-9_-]{11}$/.test(u.searchParams.get('v')??''),'exact public YouTube watch URL required');return `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;}

function runPrivate(bin,args,{timeoutMs=45000,maxOutputBytes=32*1024*1024}={}) {
  return new Promise((resolve,reject)=>{
    const p=spawn(bin,args,{stdio:['ignore','pipe','pipe']});let size=0,done=false;const chunks=[];
    const timer=setTimeout(()=>{p.kill('SIGKILL');finish(new Error('Bounded subprocess timed out; private diagnostics withheld'));},timeoutMs);
    function finish(error,value){if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);}
    p.stdout.on('data',b=>{size+=b.length;if(size>maxOutputBytes){p.kill('SIGKILL');finish(new Error('Private metadata exceeded the bounded output size'));}else chunks.push(b);});
    p.stderr.on('data',()=>{}); // Never expose transient CDN URLs or player state.
    p.once('error',()=>finish(new Error('Required local subprocess could not start')));
    p.once('close',code=>finish(code===0?null:new Error(`Local subprocess failed (${code}); private diagnostics withheld`),Buffer.concat(chunks).toString()));
  });
}

const METADATA_SCRIPT=String.raw`
import yt_dlp, json, contextlib, io, sys
class Quiet:
 def debug(self,*x): pass
 def info(self,*x): pass
 def warning(self,*x): pass
 def error(self,*x): pass
try:
 with contextlib.redirect_stderr(io.StringIO()):
  with yt_dlp.YoutubeDL({'quiet':True,'no_warnings':True,'skip_download':True,'socket_timeout':15,'retries':0,'fragment_retries':0,'extractor_retries':0,'noplaylist':True,'cachedir':False,'logger':Quiet()}) as y:
   x=y.extract_info(sys.argv[1],download=False)
 fields=['format_id','ext','protocol','width','height','vcodec','acodec','filesize','url','abr','fps']
 print(json.dumps({'ok':True,'duration':x.get('duration'),'formats':[{k:f.get(k) for k in fields} for f in x.get('formats',[]) if f.get('protocol')=='https' and f.get('ext') in ['mp4','m4a']]}))
except Exception as e:
 t=str(e).lower()
 code='public_metadata_sign_in_required' if 'sign in' in t else ('public_metadata_http_403' if '403' in t else 'public_metadata_unavailable')
 print(json.dumps({'ok':False,'code':code}))
`;
function pickFormats(metadata) {
  need(metadata?.ok,metadata?.code??'public metadata unavailable');
  const videos=metadata.formats.filter(f=>f.ext==='mp4'&&f.protocol==='https'&&f.vcodec&&f.vcodec!=='none'&&f.acodec==='none'&&Math.min(f.width??0,f.height??0)>=720);
  // Native AVC at the smallest HD size keeps range/decoding work bounded.
  videos.sort((a,b)=>Number(!a.vcodec.startsWith('avc1'))-Number(!b.vcodec.startsWith('avc1'))||Math.min(a.width,a.height)-Math.min(b.width,b.height)||(a.filesize??Infinity)-(b.filesize??Infinity));
  const audios=metadata.formats.filter(f=>f.ext==='m4a'&&f.protocol==='https'&&f.vcodec==='none'&&f.acodec?.startsWith('mp4a'));
  audios.sort((a,b)=>Math.abs((a.abr??128)-128)-Math.abs((b.abr??128)-128));
  need(videos.length>0&&audios.length>0,'no native public HTTPS MP4 at720shortside plus M4A representation; no fallback attempted');
  const video=videos[0],audio=audios[0];for(const f of [video,audio]){let u;try{u=new URL(f.url);}catch{throw new Error('Invalid transient media endpoint');}need(u.protocol==='https:'&&!u.username&&!u.password,'credential-free public HTTPS media required');}
  return {video,audio,duration_sec:metadata.duration};
}
const safeFormat=f=>({id:String(f.format_id).slice(0,80),container:f.ext,width:f.width??null,height:f.height??null,video_codec:f.vcodec,audio_codec:f.acodec,source_bytes:Number.isSafeInteger(f.filesize)?f.filesize:null});
async function metadataFor(publicUrl,timeoutMs=45000){const text=await runPrivate(PYTHON,['-c',METADATA_SCRIPT,publicYoutube(publicUrl)],{timeoutMs});let m;try{m=JSON.parse(text);}catch{throw new Error('Public metadata response could not be parsed; private output withheld');}return pickFormats(m);}

/** Read-only discovery; its return value deliberately contains no media URL. */
export async function inspectCrimeFootageHdMetadata({publicUrl}) {
  const selected=await metadataFor(publicUrl);return {source_url:publicYoutube(publicUrl),duration_sec:selected.duration_sec,selected_video:safeFormat(selected.video),selected_audio:safeFormat(selected.audio),download_performed:false,cookies_used:false};
}

export async function acquireCrimeFootageHdWindow({proofDir,attemptToken,repairDir,windowId}) {
  const {loadCrimeFootageHdWindow}=await import('./crime-footage-quality-repair.mjs');
  const loaded=await loadCrimeFootageHdWindow({proofDir,attemptToken,repairDir,windowId});
  const q=loaded.request;need(q.cookies_allowed===false&&q.full_source_download_allowed===false&&q.max_submissions===1&&q.source_window_only===true,'bounded no-cookie one-shot request required');
  const maximumBytes=Math.min(q.max_download_bytes,128*1024*1024),maximumMs=Math.min(q.max_elapsed_sec,180)*1000,started=Date.now();
  const runner=await ref(fileURLToPath(import.meta.url));
  await write(path.join(loaded.windowDir,'network-dispatch.json'),{schema:'crime_footage_hd_network_dispatch_v1',request:loaded.requestRef,runner,source_url:publicYoutube(q.public_url),started_at:new Date(started).toISOString(),max_download_bytes:maximumBytes,max_elapsed_sec:maximumMs/1000,cookies_used:false,max_submissions:1,automatic_retry_allowed:false});
  const proxies=[];let ffmpegElapsed=0,selected;
  const remaining=()=>{const ms=maximumMs-(Date.now()-started);need(ms>0,'window time budget reached');return ms;};
  try {
    selected=await metadataFor(q.public_url,Math.min(45000,remaining()));
    need(q.source_start_sec>=0&&q.source_end_sec>q.source_start_sec&&q.source_end_sec<=selected.duration_sec+.1,'selected public source does not contain the locked window');
    const videoBudget=Math.floor(maximumBytes*7/8),audioBudget=maximumBytes-videoBudget;
    for(const[f,budget]of[[selected.video,videoBudget],[selected.audio,audioBudget]]){
      const p=await createFootageRangeProxy({url:f.url,bytes:Number.isSafeInteger(f.filesize)&&f.filesize>0?f.filesize:undefined,maxBytes:budget,timeoutMs:remaining(),chunkBytes:64*1024,maxRequests:2048});proxies.push(p);
    }
    const ffmpegStart=Date.now(),duration=q.source_end_sec-q.source_start_sec;
    await runPrivate('ffmpeg',['-nostdin','-v','error','-ss',String(q.source_start_sec),'-i',proxies[0].url,'-ss',String(q.source_start_sec),'-i',proxies[1].url,'-t',String(duration),'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','veryfast','-crf','19','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-movflags','+faststart',q.output_path],{timeoutMs:remaining(),maxOutputBytes:1024});
    ffmpegElapsed=(Date.now()-ffmpegStart)/1000;
    for(const p of proxies)p.assertHealthy();
    const stats=proxies.map(p=>({...p.stats}));
    await Promise.all(proxies.map(p=>p.close()));
    const downloadedBytes=stats.reduce((n,s)=>n+s.transferred_bytes,0);
    need(downloadedBytes>0&&downloadedBytes<=maximumBytes,'actual upstream transfer exceeded the combined window cap');
    // Total payload smaller than source size proves the full representation was
    // not downloaded, even if some ranged payload was transferred repeatedly.
    need(stats.every(s=>Number.isSafeInteger(s.source_bytes)&&s.transferred_bytes<s.source_bytes),'complete-source exclusion cannot be proven from range statistics; output retained for triage');
    const elapsed=(Date.now()-started)/1000;need(elapsed<=maximumMs/1000,'completed extraction exceeded the window time budget');
    need((await ref(fileURLToPath(import.meta.url))).sha256===runner.sha256,'runner changed during acquisition');
    const evidence={schema:'crime_footage_hd_range_transfer_v1',source_url:publicYoutube(q.public_url),start_sec:q.source_start_sec,end_sec:q.source_end_sec,cookies_used:false,whole_source_downloaded:false,source_window_only:true,downloaded_bytes:downloadedBytes,elapsed_sec:elapsed,max_submissions:1,automatic_retry_allowed:false,selected_format_width:selected.video.width,selected_format_height:selected.video.height,selected_video:safeFormat(selected.video),selected_audio:safeFormat(selected.audio),streams:stats,max_download_bytes:maximumBytes,max_elapsed_sec:maximumMs/1000,range_reader:await ref(fileURLToPath(new URL('./footage-range-reader.mjs',import.meta.url))),runner,ffmpeg_elapsed_sec:ffmpegElapsed,source_completeness_evidence:'For each representation, total upstream media payload was strictly smaller than the full source size.',accounting_note:'downloaded_bytes counts actual upstream ranged media payload, including repeated reads; metadata/control-response traffic is excluded. File output size is not used as transfer evidence.'};
    const evidencePath=path.join(loaded.windowDir,'transfer-evidence.json');await write(evidencePath,evidence);
    return {...await ref(q.output_path),downloaded_bytes:downloadedBytes,elapsed_sec:elapsed,cookies_used:false,whole_source_downloaded:false,source_window_only:true,acquisition_method:'One public yt-dlp metadata resolution plus native HTTPS MP4/M4A range extraction through validated loopback proxies; original audio, no retries or full-source fallback',cost_usd:0,transfer_evidence:await ref(evidencePath),quality_origin:'native_source_representation'};
  } catch(error) {
    const failure=proxies.find(p=>p.failure)?.failure;
    await Promise.allSettled(proxies.map(p=>p.close()));
    const code=String(failure?.code??'HD_BOUNDED_ACQUISITION_FAILED');
    const safeMessage=String(failure?.message??error?.message??'Bounded acquisition failed').replace(/https?:\/\/\S+/g,'[transient URL withheld]').slice(0,500);
    await write(path.join(loaded.windowDir,'network-failure.json'),{code,note:safeMessage,elapsed_sec:(Date.now()-started)/1000,streams:proxies.map(p=>({...p.stats})),source_url:publicYoutube(q.public_url),automatic_retry_allowed:false,max_submissions:1,partial_output_retained:true});
    throw new Error(`${code}: ${safeMessage}`);
  }
}
