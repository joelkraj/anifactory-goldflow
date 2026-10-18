import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import {normalizeCrimeFootagePcm,measureCrimeFootageLoudness} from './crime-footage-proof-audio.mjs';

export const CRIME_FOOTAGE_RENDER_SCHEMA = 'crime_footage_proof_render_manifest_v1';
const W=1920,H=1080,FPS=30,RATE=48000,CHANNELS=2;
const need=(test,message)=>{if(!test)throw new Error(`Crime footage proof: ${message}`);};
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const words=t=>String(t).normalize('NFKC').toLowerCase().replace(/[’]/g,"'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)?.join(' ')??'';
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const json=async(p,o)=>fs.writeFile(p,JSON.stringify(o,null,2)+'\n',{flag:'wx'});
export const crimeFootageFileRef=async p=>({path:path.resolve(p),sha256:sha(await fs.readFile(p))});

function command(bin,args,{binary=false}={}) {
  return new Promise((resolve,reject)=>{
    const proc=spawn(bin,args,{stdio:['ignore','pipe','pipe']});const out=[],err=[];
    proc.stdout.on('data',b=>out.push(b));proc.stderr.on('data',b=>err.push(b));
    proc.once('error',reject);proc.once('close',code=>code===0?resolve(binary?Buffer.concat(out):Buffer.concat(out).toString()):reject(new Error(`${bin} failed (${code}): ${Buffer.concat(err).toString().slice(-5000)}`)));
  });
}
const probe=async p=>JSON.parse(await command('ffprobe',['-v','error','-show_streams','-show_format','-of','json',p]));
const mediaDuration=(p,type)=>Number(p.streams.find(s=>s.codec_type===type)?.duration??p.format.duration);
async function readRef(r) {
  need(r&&path.isAbsolute(r.path)&&/^[a-f0-9]{64}$/.test(r.sha256),'invalid absolute file reference');
  need((await fs.lstat(r.path)).isFile(),'input is not a regular file');const b=await fs.readFile(r.path);
  need(sha(b)===r.sha256,`input hash changed: ${r.path}`);return b;
}

/** Pure constraints, before any write or media command. */
export function validateCrimeFootageManifest(manifest) {
  need(manifest?.schema===CRIME_FOOTAGE_RENDER_SCHEMA,'unsupported manifest schema');
  need(manifest.width===W&&manifest.height===H&&manifest.fps===FPS,'requires 1920×1080 at 30 fps');
  need(manifest.production_eligible===false&&manifest.publish_allowed===false,'private scope required');
  need(manifest.min_duration_sec===90&&manifest.max_duration_sec===150,'bounded 90–150 second scope required');
  need(Array.isArray(manifest.segments)&&manifest.segments.length>=3&&manifest.segments.length<=30,'requires 3–30 authored segments');
  const ids=new Set();let total=0;
  for(const s of manifest.segments) {
    need(/^[a-zA-Z0-9_-]+$/.test(s.id)&&!ids.has(s.id),'invalid/duplicate segment ID');ids.add(s.id);
    need(typeof s.plan_scene_id==='string'&&s.plan_scene_id.length>0,`missing plan scene ID: ${s.id}`);
    need(['footage','footage_card','graphic','audio_transcript'].includes(s.kind),`unsupported scene: ${s.id}`);
    need(Number.isInteger(s.duration_frames)&&s.duration_frames>0,`invalid frame count: ${s.id}`);
    const sec=s.duration_frames/FPS;total+=s.duration_frames;
    need(s.audio&&['original_court_audio','qwen_narration'].includes(s.audio.origin),`invalid audio origin: ${s.id}`);
    for(const [type,r]of[['audio',s.audio],['video',s.video]]) {
      if(!r)continue;
      need(path.isAbsolute(r.path)&&/^[a-f0-9]{64}$/.test(r.sha256),`invalid ${type} reference: ${s.id}`);
      need(finite(r.in_sec)&&finite(r.out_sec)&&r.in_sec>=0&&r.out_sec>r.in_sec,`invalid ${type} window: ${s.id}`);
      const span=r.out_sec-r.in_sec;
      need(span<=sec+0.000001&&sec-span<1/FPS+0.000001,`${type} window must cover segment except subframe padding: ${s.id}`);
    }
    need(s.audio.origin!=='qwen_narration'||(s.audio.in_sec===0&&typeof s.narration_unit_id==='string'),`complete identified narrator unit required: ${s.id}`);
    need(s.audio.origin!=='original_court_audio'||(s.source_id&&s.window_id),`source window provenance required: ${s.id}`);
    need(!['footage','footage_card'].includes(s.kind)||s.video,`moving footage required: ${s.id}`);
    need(!s.video||['footage','footage_card'].includes(s.kind),`video input only applies to footage scenes: ${s.id}`);
    need(s.kind!=='audio_transcript'||s.audio.origin==='original_court_audio',`transcript scene requires original court audio: ${s.id}`);
    need(typeof s.source_label==='string'&&s.source_label.trim(),`missing source label: ${s.id}`);
    need(Array.isArray(s.captions)&&s.captions.length<=40,`invalid captions: ${s.id}`);
    let end=0;
    for(const c of s.captions) {
      need(finite(c.start_sec)&&finite(c.end_sec)&&c.start_sec>=end-0.000001&&c.end_sec>c.start_sec&&c.end_sec<=sec+0.000001,`caption order/window invalid: ${s.id}`);
      need(typeof c.text==='string'&&c.text.trim(),`empty caption: ${s.id}`);end=c.end_sec;
    }
    if(s.transcript_text!==undefined)need(words(s.transcript_text)===words(s.captions.map(c=>c.text).join(' ')),`caption words differ from selected transcript: ${s.id}`);
    need(s.kind!=='audio_transcript'||s.captions.length>0,`transcript scene needs actual phrase captions: ${s.id}`);
    if(s.text_cues){need(['graphic','footage_card'].includes(s.kind)&&Array.isArray(s.text_cues),'text cues apply only to explanatory graphic/card');let previous=-1;for(const cue of s.text_cues){need(finite(cue.start_sec)&&cue.start_sec>=0&&cue.start_sec>previous&&cue.start_sec<sec,'invalid text reveal time');need(typeof cue.title==='string'||typeof cue.body==='string','text cue must reveal title or body');previous=cue.start_sec;}}
  }
  need(total/FPS>=90&&total/FPS<=150,'actual program must fit 90–150 seconds');
  if(manifest.underscore) {
    need(typeof manifest.underscore.enabled==='boolean','underscore enabled must be boolean');
    const a=manifest.underscore.amplitude??0.0015;need(finite(a)&&a>=0&&a<=0.003,'underscore amplitude outside restrained range');
  }
  return {duration_frames:total,duration_sec:total/FPS,width:W,height:H,fps:FPS};
}

export async function inspectCrimeFootageManifest({manifestPath}) {
  const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));const accounting=validateCrimeFootageManifest(manifest);
  const refs=new Map();for(const s of manifest.segments)for(const r of [s.audio,s.video])if(r){need(!refs.has(r.path)||refs.get(r.path).sha256===r.sha256,'conflicting hashes for same source file');refs.set(r.path,{path:r.path,sha256:r.sha256});}
  const probes={};for(const r of refs.values()){await readRef(r);probes[r.path]=await probe(r.path);}
  for(const s of manifest.segments)for(const[type,r]of[['audio',s.audio],['video',s.video]]) {
    if(!r)continue;const p=probes[r.path];need(p.streams.some(v=>v.codec_type===type),`${type} stream missing: ${s.id}`);
    const d=mediaDuration(p,type);need(finite(d)&&r.out_sec<=d+0.04,`${type} selection beyond file: ${s.id}`);
    if(type==='audio'&&r.origin==='qwen_narration')need(Math.abs(r.out_sec-d)<=1/RATE+0.000001,`narration file must be used in full: ${s.id}`);
  }
  return {manifest,accounting,inputs:[...refs.values()],probes,manifest_ref:await crimeFootageFileRef(manifestPath)};
}

/** Pango shapes and measures real glyphs, with a strict minimum readable size. */
export async function measuredCrimeText({text,width,height,fontSize=56,minFontSize=44,color='#F5F2E9',align='left',bold=true}) {
  need(typeof text==='string'&&text.trim()&&width>0&&height>0,'invalid text box');
  for(let size=fontSize;size>=minFontSize;size-=2) {
    const input={text:{text:`<span foreground="${color}">${esc(text)}</span>`,font:`Arial ${bold?'Bold ':''}${size}`,width,rgba:true,align,wrap:'word',spacing:Math.round(size*.16)}};
    const {data,info}=await sharp(input).png().toBuffer({resolveWithObject:true});
    if(info.height<=height&&info.width<=width)return {bytes:data,measurement:{text,width,height,font_size:size,actual_width:info.width,actual_height:info.height,align}};
  }
  throw new Error(`Crime footage proof: text cannot fit readable box: ${text}`);
}

const svg=(content,width=W,height=H)=>Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${content}</svg>`);
const surface=()=>sharp({create:{width:W,height:H,channels:4,background:{r:0,g:0,b:0,alpha:0}}});

/** Author a real board/overlay; optional waveform is measured from selected PCM. */
export async function prepareCrimeSceneGraphics({segment,outputDir,waveform=[]}) {
  const measurements=[],layers=[],s=segment;
  const add=async(id,text,x,y,width,height,fontSize,minFontSize=fontSize,color='#F5F2E9',align='left',bold=true)=>{
    if(!text)return;const r=await measuredCrimeText({text,width,height,fontSize,minFontSize,color,align,bold});layers.push({input:r.bytes,left:x,top:y});measurements.push({id,x,y,...r.measurement});
  };
  const bg=s.kind==='footage'?'<rect x="48" y="34" width="780" height="102" rx="8" fill="#080D15" opacity=".55"/>':
    '<defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#182431"/><stop offset=".65" stop-color="#080E17"/><stop offset="1" stop-color="#16161D"/></linearGradient></defs><rect width="1920" height="1080" fill="url(#bg)"/>'+
    '<path d="M70 217H1850M70 970H1850" stroke="#516477" stroke-opacity=".45"/><rect x="70" y="211" width="86" height="7" fill="#D1B071"/>';
  layers.push({input:svg(bg),left:0,top:0});
  if(s.kind==='footage') {
    await add('speaker',s.speaker??s.title??'COURT RECORD',72,48,734,48,33,31);
    await add('context',s.kicker,74,96,734,32,23,23,'#CBD2D8',undefined,false);
  } else {
    await add('kicker',s.kicker??'CRIMEDUNGEON / THE RECORD',74,62,1740,50,27,25,'#D1B071');
    await add('title',s.title??s.speaker??'THE EVIDENCE',70,116,1770,99,62,50);
    if(s.kind==='footage_card') {
      layers.push({input:svg('<rect x="806" y="236" width="1046" height="588" rx="8" fill="#000"/><rect x="805" y="235" width="1048" height="590" rx="9" fill="none" stroke="#647684" stroke-opacity=".6"/>'),left:0,top:0});
      await add('body',s.body,75,305,650,450,58,48);
      await add('speaker',s.speaker,830,842,1000,76,30,28,'#D1B071');
    } else if(s.kind==='graphic') {
      await add('body',s.body,120,330,1640,470,88,62);
    } else {
      await add('speaker',s.speaker??'COURT TESTIMONY',145,275,1620,58,32,30,'#D1B071');
      let bars='';const count=waveform.length||96;for(let i=0;i<count;i++){const v=waveform[i]??0;const h=5+Math.min(1,v)*90;bars+=`<rect x="${150+i*1620/count}" y="${763-h/2}" width="${Math.max(2,1620/count-5)}" height="${h}" rx="2" fill="#74B8C8" opacity=".8"/>`;}
      layers.push({input:svg(bars),left:0,top:0});
      await add('audio-origin','ORIGINAL COURT AUDIO',145,839,1620,50,27,27,'#74B8C8');
      await add('body',s.body,145,905,1620,52,26,24,'#C4CCD4',undefined,false);
    }
  }
  // Source attribution stays out of the spoken caption region.
  const sourceY=s.kind==='footage'?1030:1010;
  await add('source',s.source_label,75,sourceY,1760,38,22,22,'#CBD2D8',undefined,false);
  const base=path.join(outputDir,`${s.id}-overlay.png`);await surface().composite(layers).png().toFile(base);
  const captions=[];
  for(let i=0;i<s.captions.length;i++) {
    const c=s.captions[i],transcript=s.kind==='audio_transcript';
    const width=transcript?1580:1660,height=transcript?230:144;
    const r=await measuredCrimeText({text:c.text,width,height,fontSize:transcript?68:53,minFontSize:transcript?56:45,align:'center'});
    const boxW=r.measurement.actual_width+64,boxH=r.measurement.actual_height+34;
    const x=Math.floor((W-boxW)/2),y=transcript?390:Math.min(947-boxH,880);
    const capLayers=[];
    if(!transcript)capLayers.push({input:svg(`<rect width="${boxW}" height="${boxH}" rx="9" fill="#070B11" opacity=".88"/>`,boxW,boxH),left:x,top:y});
    capLayers.push({input:r.bytes,left:x+32,top:y+17});
    const p=path.join(outputDir,`${s.id}-caption-${String(i+1).padStart(2,'0')}.png`);await surface().composite(capLayers).png().toFile(p);
    captions.push({...c,...await crimeFootageFileRef(p)});measurements.push({id:`caption-${i+1}`,x,y,...r.measurement});
  }
  const variants=[];let title=s.title,body=s.body;
  for(let i=0;i<(s.text_cues??[]).length;i++){const cue=s.text_cues[i];title=cue.title??title;body=cue.body??body;const variant=await prepareCrimeSceneGraphics({segment:{...s,id:`${s.id}-cue-${i+1}`,title,body,text_cues:undefined,captions:[]},outputDir,waveform});variants.push({start_sec:cue.start_sec,overlay:variant.overlay});measurements.push(...variant.measurements.map(m=>({...m,cue_start_sec:cue.start_sec})));}
  return {overlay:await crimeFootageFileRef(base),variants,captions,measurements};
}

function wavFloat(samples) {
  const bytes=Buffer.alloc(44+samples.length*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(3,20);bytes.writeUInt16LE(CHANNELS,22);bytes.writeUInt32LE(RATE,24);bytes.writeUInt32LE(RATE*CHANNELS*4,28);bytes.writeUInt16LE(CHANNELS*4,32);bytes.writeUInt16LE(32,34);bytes.write('data',36);bytes.writeUInt32LE(samples.length*4,40);for(let i=0;i<samples.length;i++)bytes.writeFloatLE(samples[i],44+i*4);return bytes;
}
function waveformFor(samples,buckets=96) {
  const rows=[];for(let b=0;b<buckets;b++){let sum=0,n=0;for(let i=Math.floor(b*samples.length/buckets);i<Math.floor((b+1)*samples.length/buckets);i++){sum+=samples[i]*samples[i];n++;}rows.push(Math.sqrt(sum/Math.max(1,n)));}const max=Math.max(.00001,...rows);return rows.map(v=>Math.sqrt(v/max));
}
async function extractAudio(s,file) {
  const a=s.audio,span=a.out_sec-a.in_sec;
  const b=await command('ffmpeg',['-nostdin','-v','error','-ss',String(a.in_sec),'-i',a.path,'-t',String(span),'-vn','-ar',String(RATE),'-ac',String(CHANNELS),'-c:a','pcm_f32le','-f','f32le','pipe:1'],{binary:true});
  need(b.length%8===0,`invalid decoded audio: ${s.id}`);const samples=new Float32Array(b.length/4);for(let i=0;i<samples.length;i++)samples[i]=b.readFloatLE(i*4);
  const expected=Math.round(span*RATE);need(Math.abs(samples.length/2-expected)<=2,`decoded audio length mismatch: ${s.id}`);
  await fs.writeFile(file,wavFloat(samples),{flag:'wx'});return {samples,ref:await crimeFootageFileRef(file),waveform:waveformFor(samples)};
}

async function encodePicture(s,graphics,file) {
  const args=['-nostdin','-v','error'];let videoInput=false;
  if(s.video){args.push('-ss',String(s.video.in_sec),'-i',s.video.path);videoInput=true;}
  else args.push('-f','lavfi','-i',`color=c=0x080E17:s=${W}x${H}:r=${FPS}`);
  const overlays=[graphics.overlay,...graphics.captions,...graphics.variants.map(v=>v.overlay)];for(const r of overlays)args.push('-framerate',String(FPS),'-loop','1','-i',r.path);
  const filter=['[1:v]format=rgba[board0]'];
  graphics.variants.forEach((variant,i)=>filter.push(`[board${i}][${graphics.captions.length+2+i}:v]overlay=0:0:enable='gte(t,${variant.start_sec})':eof_action=pass:shortest=0[board${i+1}]`));
  const board=`board${graphics.variants.length}`;
  if(videoInput) {
    const videoProbe=await probe(s.video.path),track=videoProbe.streams.find(v=>v.codec_type==='video');
    const targetW=s.kind==='footage_card'?1046:1920,targetH=s.kind==='footage_card'?588:1080;
    const start=`[0:v]trim=duration=${s.video.out_sec-s.video.in_sec},setpts=PTS-STARTPTS,fps=${FPS},setsar=1,tpad=stop_mode=clone:stop_duration=${1/FPS}`;
    if(track.width/track.height<1.4) {
      filter.push(`${start},split[backgroundsrc][foregroundsrc]`);
      filter.push(`[backgroundsrc]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},boxblur=24:2,eq=brightness=-0.18:saturation=0.5[softbackground]`);
      filter.push(`[foregroundsrc]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease[contained]`);
      filter.push('[softbackground][contained]overlay=(W-w)/2:(H-h)/2:eof_action=pass:shortest=0[source]');
    } else filter.push(`${start},scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2[source]`);
  }
  if(s.kind==='footage_card')filter.push(`[${board}][source]overlay=806:236:eof_action=pass:shortest=0[b0]`);
  else if(s.kind==='footage')filter.push(`[source][${board}]overlay=0:0:eof_action=pass:shortest=0[b0]`);
  else filter.push(`[${board}]format=rgba[b0]`);
  if(s.kind==='audio_transcript') {
    // One thin cursor follows actual selected-recording time across its measured envelope.
    filter[filter.length-1]=`[${board}]drawbox=x=150:y=705:w=1620:h=116:color=0x74B8C8@0.08:t=fill[wavebase]`;
    filter.push(`color=c=0xD6F3F4@0.9:s=4x116:r=${FPS},format=rgba[cursor];[wavebase][cursor]overlay=x='150+min(t/${s.duration_frames/FPS},1)*1616':y=705:eof_action=pass:shortest=0[b0]`);
  }
  graphics.captions.forEach((c,i)=>filter.push(`[b${i}][${i+2}:v]overlay=0:0:enable='gte(t,${c.start_sec})*lt(t,${c.end_sec})':eof_action=pass:shortest=0[b${i+1}]`));
  args.push('-filter_complex',filter.join(';'),'-map',`[b${graphics.captions.length}]`,'-an','-frames:v',String(s.duration_frames),'-r',String(FPS),'-c:v','libx264','-preset','veryfast','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart',file);
  await command('ffmpeg',args);return crimeFootageFileRef(file);
}

/** Provider-free integration fixture: fixed synthetic inputs, never case media. */
export async function exerciseCrimeFootageRendererWithSyntheticInputs({outputDir}) {
  await fs.mkdir(outputDir);const source=path.join(outputDir,'synthetic-test-pattern.mp4');
  await command('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=1280x720:rate=30','-f','lavfi','-i','sine=frequency=320:sample_rate=48000','-t','2','-c:v','libx264','-preset','ultrafast','-c:a','aac',source]);
  const portrait=path.join(outputDir,'synthetic-portrait.mp4');await command('ffmpeg',['-nostdin','-v','error','-i',source,'-vf','scale=360:640','-c:v','libx264','-preset','ultrafast','-c:a','copy',portrait]);
  const r=await crimeFootageFileRef(source),portraitRef=await crimeFootageFileRef(portrait),results=[];
  for(const fixtureKind of ['footage','footage_card','graphic','audio_transcript','portrait_footage']) {
    const kind=fixtureKind==='portrait_footage'?'footage':fixtureKind;const videoRef=fixtureKind==='portrait_footage'?portraitRef:r;
    const s={id:fixtureKind,plan_scene_id:fixtureKind,kind,duration_frames:60,video:['footage','footage_card'].includes(kind)?{...videoRef,in_sec:0,out_sec:2}:undefined,audio:{...r,in_sec:0,out_sec:2,origin:'original_court_audio'},source_id:'synthetic',window_id:'fixed',source_label:'SYNTHETIC TEST FIXTURE — not case evidence',speaker:'TEST SPEAKER',kicker:'TEST / ORIGINAL RECORDING',title:'A RECORDED MOMENT',body:'ONE CLEAR RELATIONSHIP',captions:[{start_sec:.2,end_sec:.8,text:'The first complete phrase.'},{start_sec:1.1,end_sec:1.8,text:'The next complete phrase.'}],text_cues:['graphic','footage_card'].includes(kind)?[{start_sec:1,title:'A NEW DEVELOPMENT',body:'THE SECOND POSITION'}]:undefined};
    const a=await extractAudio(s,path.join(outputDir,`${fixtureKind}-audio.wav`));const g=await prepareCrimeSceneGraphics({segment:s,outputDir,waveform:a.waveform});const video=await encodePicture(s,g,path.join(outputDir,`${fixtureKind}.mp4`));
    results.push({kind:fixtureKind,video,probe:await probe(video.path),graphics:g,audio_samples_per_channel:a.samples.length/2});
  }
  return {synthetic_fixture:true,production_eligible:false,results};
}

/** Only this guarded entry assembles a real program. No standalone render CLI. */
export async function renderCrimeFootageProof({manifestPath,outputDir,proofDir,attemptToken}) {
  need(typeof outputDir==='string'&&path.isAbsolute(outputDir)&&typeof proofDir==='string'&&path.isAbsolute(proofDir)&&typeof attemptToken==='string','guarded explicit proof attempt required');
  const {loadCrimeFootageProofAttempt}=await import('./crime-footage-proof-workflow.mjs');
  const context=await loadCrimeFootageProofAttempt({proofDir,stage:'program_review',attemptToken});
  need(path.resolve(outputDir)===path.join(path.resolve(context.outputDir),'program'),'renderer output must be new program child of guarded attempt');
  const inspected=await inspectCrimeFootageManifest({manifestPath});
  need(context.inputs.some(r=>r.path===inspected.manifest_ref.path&&r.sha256===inspected.manifest_ref.sha256),'manifest must be bound to guarded attempt inputs');
  await fs.mkdir(outputDir);const started=Date.now();
  const graphicDir=path.join(outputDir,'graphics'),clipDir=path.join(outputDir,'clips'),audioDir=path.join(outputDir,'audio'),qaDir=path.join(outputDir,'qa');
  for(const dir of [graphicDir,clipDir,audioDir,qaDir])await fs.mkdir(dir);
  await json(path.join(outputDir,'render-manifest.json'),inspected.manifest);
  const plan=inspected.manifest,segments=[],measurements=[];
  const speech=new Float32Array(inspected.accounting.duration_frames*RATE/FPS*CHANNELS),rawSpeech=new Float32Array(speech.length),bed=new Float32Array(speech.length);let sampleOffset=0,frameOffset=0;
  for(const s of plan.segments) {
    const audio=await extractAudio(s,path.join(audioDir,`${s.id}-selected-source.wav`));
    const leveled=await normalizeCrimeFootagePcm({inputPath:audio.ref.path,outputPath:path.join(audioDir,`${s.id}-leveled.wav`),receiptPath:path.join(audioDir,`${s.id}-loudness.json`),targetLufs:-18,truePeakDbtp:-2});
    need(leveled.samples.length===audio.samples.length,`normalization changed selected sample count: ${s.id}`);
    const graphics=await prepareCrimeSceneGraphics({segment:s,outputDir:graphicDir,waveform:waveformFor(leveled.samples)});
    const video=await encodePicture(s,graphics,path.join(clipDir,`${s.id}.mp4`));
    const count=s.duration_frames*RATE/FPS*CHANNELS;need(audio.samples.length<=count,`audio exceeds frame budget: ${s.id}`);rawSpeech.set(audio.samples,sampleOffset);speech.set(leveled.samples,sampleOffset);
    if(plan.underscore?.enabled&&s.audio.origin==='qwen_narration') {
      const amplitude=plan.underscore.amplitude??0.0015;const duration=count/CHANNELS/RATE;
      for(let i=0;i<count/2;i++){const t=i/RATE,fade=Math.min(1,t/.4,(duration-t)/.7);const v=amplitude*Math.max(0,fade)*(.65*Math.sin(2*Math.PI*110*t)+.22*Math.sin(2*Math.PI*164.81*t)+.13*Math.sin(2*Math.PI*220.17*t));bed[sampleOffset+i*2]=v;bed[sampleOffset+i*2+1]=v;}
    }
    segments.push({id:s.id,plan_scene_id:s.plan_scene_id,source_id:s.source_id??null,window_id:s.window_id??null,narration_unit_id:s.narration_unit_id??null,kind:s.kind,program_start_frame:frameOffset,duration_frames:s.duration_frames,duration_sec:s.duration_frames/FPS,audio_origin:s.audio.origin,source_audio_window:{in_sec:s.audio.in_sec,out_sec:s.audio.out_sec},source_video_window:s.video?{in_sec:s.video.in_sec,out_sec:s.video.out_sec}:null,selected_audio:audio.ref,leveled_audio:leveled.output,loudness_receipt:leveled.receipt,loudness_qa:leveled.status,decoded_audio_samples_per_channel:audio.samples.length/2,processed_audio_samples_per_channel:leveled.samples.length/2,tail_padding_samples_per_channel:(count-audio.samples.length)/2,tempo:1,raw_waveform_preserved:false,gain_policy:'measured_r128_two_pass_leveling_with_declared_peak_control',picture:video,graphics});
    measurements.push(...graphics.measurements.map(m=>({segment_id:s.id,...m})));sampleOffset+=count;frameOffset+=s.duration_frames;
  }
  const mix=new Float32Array(speech.length);let peak=0;for(let i=0;i<mix.length;i++){mix[i]=speech[i]+bed[i];peak=Math.max(peak,Math.abs(mix[i]));}need(peak<=1,'unmastered program exceeds full scale; retain stems for scoped review');
  const rawSpeechPath=path.join(audioDir,'raw-speech-track.wav'),speechPath=path.join(audioDir,'leveled-speech-track.wav'),bedPath=path.join(audioDir,'authored-underscore.wav'),unmasteredMixPath=path.join(audioDir,'unmastered-review-mix.wav'),mixPath=path.join(audioDir,'review-mix.wav');
  for(const[p,b]of[[rawSpeechPath,wavFloat(rawSpeech)],[speechPath,wavFloat(speech)],[bedPath,wavFloat(bed)],[unmasteredMixPath,wavFloat(mix)]])await fs.writeFile(p,b,{flag:'wx'});
  // Two tenths of a decibel of encoding headroom below the identity's -1.5dBTP ceiling.
  const master=await normalizeCrimeFootagePcm({inputPath:unmasteredMixPath,outputPath:mixPath,receiptPath:path.join(audioDir,'program-mastering.json'),targetLufs:-16,truePeakDbtp:-1.7});
  const concat=path.join(outputDir,'picture-concat.txt');await fs.writeFile(concat,segments.map(s=>`file '${s.picture.path.replaceAll("'","'\\''")}'`).join('\n')+'\n',{flag:'wx'});
  const picture=path.join(outputDir,'picture-only.mp4');await command('ffmpeg',['-nostdin','-v','error','-f','concat','-safe','0','-i',concat,'-c','copy',picture]);
  const video=path.join(outputDir,'private-proof.mp4');await command('ffmpeg',['-nostdin','-v','error','-i',picture,'-i',mixPath,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-ar',String(RATE),'-movflags','+faststart',video]);
  const finalProbe=await probe(video),v=finalProbe.streams.find(s=>s.codec_type==='video'),a=finalProbe.streams.find(s=>s.codec_type==='audio');
  need(v.width===W&&v.height===H&&v.r_frame_rate==='30/1'&&Number(v.nb_frames)===frameOffset,'encoded picture accounting mismatch');
  need(Math.abs(Number(v.duration)-inspected.accounting.duration_sec)<=.001&&Math.abs(Number(a.duration)-inspected.accounting.duration_sec)<=.04,'encoded duration mismatch');
  const encodedLoudness=await measureCrimeFootageLoudness({inputPath:video,targetLufs:-16,truePeakDbtp:-1.5});
  const audioQa=segments.every(s=>s.loudness_qa==='passed')&&master.status==='passed'&&Math.abs(encodedLoudness.integrated_lufs+16)<=1&&encodedLoudness.true_peak_dbtp<=-1.5;
  const frames=[];for(const s of segments){const frame=s.program_start_frame+Math.floor(s.duration_frames/2);const p=path.join(qaDir,`${s.id}-mid.png`);await command('ffmpeg',['-nostdin','-v','error','-ss',String(frame/FPS),'-i',video,'-frames:v','1',p]);frames.push({segment_id:s.id,frame,...await crimeFootageFileRef(p)});}
  for(const r of inspected.inputs)await readRef(r);await readRef(inspected.manifest_ref);
  await json(path.join(outputDir,'text-measurements.json'),measurements);
  const report={schema:'crime_footage_proof_render_report_v1',status:'candidate_ready_needs_review',production_eligible:false,publish_allowed:false,subjective_viewing_approval:false,human_listening_approval:false,audio_mastering:'measured_excerpt_leveling_and_program_master',audio_technical_qa:audioQa?'passed':'needs_review',...inspected.accounting,manifest:inspected.manifest_ref,source_inputs:inspected.inputs,video:await crimeFootageFileRef(video),picture:await crimeFootageFileRef(picture),raw_speech_track:await crimeFootageFileRef(rawSpeechPath),speech_track:await crimeFootageFileRef(speechPath),underscore:await crimeFootageFileRef(bedPath),unmastered_review_mix:await crimeFootageFileRef(unmasteredMixPath),review_mix:await crimeFootageFileRef(mixPath),program_mastering_receipt:master.receipt,encoded_loudness:encodedLoudness,segments,qa_frames:frames,text_measurements:await crimeFootageFileRef(path.join(outputDir,'text-measurements.json')),audio_accounting:{sample_rate_hz:RATE,channels:CHANNELS,samples_per_channel:speech.length/CHANNELS,tempo:1,raw_waveform_preserved:false,raw_stems_preserved:true,gain_policy:'measured_r128_two_pass_excerpt_leveling_then_program_master',unmastered_peak_linear:peak,program_master_samples_per_channel:master.sample_count_per_channel,source_windows_preserved:true,narrator_files_complete:true,identity_target_integrated_lufs:-16,identity_max_true_peak_dbtp:-1.5,master_peak_headroom_target_dbtp:-1.7,underscore_origin:'original authored local sine composition; no borrowed recording',underscore_only_under_narration:true},probe:finalProbe,elapsed_sec:(Date.now()-started)/1000};
  const reportPath=path.join(outputDir,'render-report.json');await json(reportPath,report);
  return {...report,report:await crimeFootageFileRef(reportPath)};
}
