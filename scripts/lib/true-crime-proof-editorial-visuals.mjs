import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

// Supplemental, authored picture revision for one retained private Halderson proof.
// The caller must lock the recipe/code/source hashes before invoking this module.
// This does not implement a production lane, narration generation or approval.
const exec = promisify(execFile);
const W = 1920, H = 1080, FPS = 30, FRAMES = 1932;
const COLORS = { dark: '#14242d', deep: '#0d171d', paper: '#f3ecdb', ink: '#20292d', light: '#fbf4e7', muted: '#aebdc4', gold: '#e3c267', line: '#47545a' };
export const EDITORIAL_VISUAL_SCHEMA = 'goldflow_true_crime_editorial_visual_plan_v1';
export const EDITORIAL_ASSET_IDS = ['portrait_source','e01_initial','e01_cabin','e01_answer','e02_parade','chandler_cutout','detective_cutout'];
export const EDITORIAL_MARKER_KEYS = ['opening_cabin','opening_unwitnessed','repairs','unidentified_friends','record_answer','absence_distinction','reported_july4','amended_complaint','parade_july3','one_day_earlier','return_search'];
const BOUNDARIES = [0,297,625,826,951,1233,1602,1932];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (ok, message) => { if (!ok) throw new Error(`CrimeDungeon editorial visuals: ${message}`); };
const xml = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const frameAt = sec => Math.ceil(sec * FPS - 1e-7);
const ref = async file => ({path:file,sha256:sha(await fs.readFile(file))});
const sameWords = s => s.replace(/\s+/gu,' ').trim();
async function readRef(value) { need(path.isAbsolute(value?.path ?? '') && /^[a-f0-9]{64}$/u.test(value?.sha256 ?? ''),'absolute hashed source required'); const bytes = await fs.readFile(value.path); need(sha(bytes) === value.sha256,`source hash changed: ${value.path}`); return bytes; }
async function saveJson(file,value) { await fs.writeFile(file,`${JSON.stringify(value,null,2)}\n`,{flag:'wx'}); }

/** Pure authored plan. Caption words are supplied by the guarded caller from the retained source. */
export function buildEditorialVisualPlan({assets,captions,markers,scriptText}={}) {
  need(assets && EDITORIAL_ASSET_IDS.every(id=>path.isAbsolute(assets[id]?.path ?? '') && /^[a-f0-9]{64}$/u.test(assets[id]?.sha256 ?? '')),'seven exact existing source assets required');
  need(typeof scriptText === 'string' && scriptText.trim().split(/\s+/u).length === 191,'exact 191-word retained speech required');
  need(Array.isArray(captions) && captions.length > 0 && sameWords(captions.map(c=>c.text).join(' ')) === sameWords(scriptText),'captions must preserve every source word in order');
  let end = 0;
  for (const c of captions) { need(typeof c.text === 'string' && Number.isFinite(c.start_sec) && Number.isFinite(c.end_sec) && c.start_sec >= end - 1e-6 && c.end_sec > c.start_sec && c.end_sec <= 64.4 + 1e-6,'invalid or overlapping retained caption interval'); end = c.end_sec; }
  need(markers && EDITORIAL_MARKER_KEYS.every(key=>Number.isFinite(markers[key])),'explicit phrase marker seconds required');
  const m = Object.fromEntries(EDITORIAL_MARKER_KEYS.map(key=>[key,frameAt(markers[key])]));
  const spans = [
    ['S01','portrait_report',0,m.opening_cabin],['S01','reported_cabin',m.opening_cabin,m.opening_unwitnessed],['S01','unwitnessed_departure',m.opening_unwitnessed,297],
    ['S02','departure_account',297,m.repairs],['S02','repair_purpose',m.repairs,m.unidentified_friends],['S02','unidentified_friends',m.unidentified_friends,625],
    ['S03','illustrative_exchange',625,m.record_answer],['S03','record_answer',m.record_answer,826],
    ['S04','exact_document_reading',826,951],
    ['S05','reported_absence',951,m.absence_distinction],['S05','unobserved_distinction',m.absence_distinction,1233],
    ['S06','reported_message',1233,m.reported_july4],['S06','reported_message_date',m.reported_july4,m.amended_complaint],['S06','later_record_check',m.amended_complaint,m.parade_july3],['S06','parade_date_reveal',m.parade_july3,m.one_day_earlier],['S06','one_day_earlier',m.one_day_earlier,1602],
    ['S07','comparison_limit',1602,m.return_search],['S07','return_to_search',m.return_search,1932]
  ];
  let cursor=0;
  const shots=spans.map(([scene_id,id,start_frame,end_frame],index)=>{
    const scene=Number(scene_id.slice(1))-1;
    need(start_frame === cursor && end_frame > start_frame && start_frame >= BOUNDARIES[scene] && end_frame <= BOUNDARIES[scene+1],`marker order or scene bound invalid at ${id}`);
    cursor=end_frame;
    return {id,scene_id,index,start_frame,end_frame,frame_count:end_frame-start_frame,start_sec:start_frame/FPS,end_sec:end_frame/FPS,source_ids:scene_id==='S07'?['E02','V02']:scene_id==='S06'?['E01','E02']:['E01'],picture_origin:['departure_account','repair_purpose','unidentified_friends','illustrative_exchange'].includes(id)?'illustrative_composition':'source_document_graphic'};
  });
  need(cursor===FRAMES,'complete 1932-frame coverage required');
  return {schema:EDITORIAL_VISUAL_SCHEMA,scope:'private_editorial_v3_same_text_and_media',production_eligible:false,publish_allowed:false,width:W,height:H,fps:FPS,duration_frames:FRAMES,duration_sec:64.4,script_sha256:sha(scriptText),assets,markers,marker_frames:m,captions:structuredClone(captions),shots,caption_timing_basis:'Retained phrase intervals remapped to pacing-v2; evidence markers use retained ASR word estimates, rounded upward to a video frame.',source_disclosure_policy:'Short, persistent source locator; dated reported-account, illustrative-person and document-reading labels remain visible.',new_case_facts:false,new_faces:false};
}

/** Pango measurement for every actual text line; no character-width approximation. */
export async function renderMeasuredEditorialText({text,width,height,fontSize=56,font='Arial Bold',color=COLORS.light,align='left',lineGap=14,minFontSize=fontSize}) {
  need(typeof text==='string' && width>0 && height>0 && ['left','center','right'].includes(align),'invalid measured text box');
  const actualLines=text.split('\n');
  let output;
  for(let size=fontSize;size>=minFontSize;size--) {
    const rows=[];let totalHeight=0;
    for(const line of actualLines) {
      need(line.length>0,'empty authored text line');
      const {data,info}=await sharp({text:{text:`<span foreground="${color}">${xml(line)}</span>`,font:`${font} ${size}`,rgba:true,dpi:72}}).png().toBuffer({resolveWithObject:true});
      rows.push({data,width:info.width,height:info.height});totalHeight+=info.height;
    }
    totalHeight += (rows.length-1)*lineGap;
    if(rows.every(row=>row.width<=width) && totalHeight<=height) { output={rows,totalHeight,size};break; }
  }
  need(output,`text does not fit measured box: ${text}`);
  let y=0;
  const composites=output.rows.map(row=>{const item={input:row.data,left:align==='center'?Math.floor((width-row.width)/2):align==='right'?width-row.width:0,top:y};y+=row.height+lineGap;return item;});
  const bytes=await sharp({create:{width,height,channels:4,background:'#00000000'}}).composite(composites).png().toBuffer();
  return {bytes,measurement:{text,width,height,font,font_size:output.size,align,line_gap:lineGap,actual_width:Math.max(...output.rows.map(r=>r.width)),actual_height:output.totalHeight,lines:output.rows.map(r=>({width:r.width,height:r.height}))}};
}

const rectangle=(width,height,fill,rx=0,stroke=null)=>Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="1" y="1" width="${width-2}" height="${height-2}" rx="${rx}" fill="${fill}"${stroke?` stroke="${stroke}" stroke-width="2"`:''}/></svg>`);
function paperBoard() { return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs><linearGradient id="b" x2="1" y2="1"><stop stop-color="#20343e"/><stop offset="1" stop-color="#0d171d"/></linearGradient><linearGradient id="f" x2="0" y2="1"><stop stop-color="#0d171d" stop-opacity="0"/><stop offset="1" stop-color="#0d171d"/></linearGradient></defs><rect width="1920" height="1080" fill="url(#b)"/><path d="M70 116H1850" stroke="#44565e" stroke-width="1"/><rect y="884" width="1920" height="196" fill="url(#f)"/></svg>`); }

async function boardFor(shot,assetBytes,measurements) {
  const layers=[],moving=[];
  const text=async(id,value,x,y,width,height,fontSize=56,color=COLORS.light,extra={})=>{const r=await renderMeasuredEditorialText({text:value,width,height,fontSize,color,...extra});layers.push({input:r.bytes,left:x,top:y});measurements.push({shot_id:shot.id,id,x,y,...r.measurement});};
  const box=(x,y,w,h,fill=COLORS.paper,rx=0,stroke=null)=>layers.push({input:rectangle(w,h,fill,rx,stroke),left:x,top:y});
  const line=(x,y,w,color=COLORS.gold,h=4)=>box(x,y,w,h,color);
  const image=async(id,x,y,w,h,{extract,fit='contain',background='#00000000',opacity=1}={})=>{let pipe=sharp(assetBytes[id]);if(extract)pipe=pipe.extract(extract);let bytes=await pipe.resize(w,h,{fit,background}).ensureAlpha().png().toBuffer();if(opacity!==1){const alpha=await sharp(bytes).extractChannel('alpha').linear(opacity).png().toBuffer();bytes=await sharp(bytes).removeAlpha().joinChannel(alpha).png().toBuffer();}layers.push({input:bytes,left:x,top:y});};
  const person=async(id,x,y,w,h,drift=0)=>{const bytes=await sharp(assetBytes[id]).resize(w,h,{fit:'contain',background:'#00000000'}).png().toBuffer();moving.push({id,bytes,x,y,width:w,height:h,drift_x:drift,drift_y:0});};
  const excerpt=async({id,x,y,w,h,extract,highlights=[],label})=>{
    box(x-20,y-20,w+40,h+40,COLORS.paper);
    let pipe=sharp(assetBytes[id]);if(extract)pipe=pipe.extract(extract);
    const original=await pipe.metadata();
    const extW=extract?.width??original.width,extH=extract?.height??original.height;
    const scale=Math.min(w/extW,h/extH),drawW=Math.round(extW*scale),drawH=Math.round(extH*scale);
    const bytes=await pipe.resize(drawW,drawH).png().toBuffer();
    // Marker ink is a transparent editorial overlay; source raster words remain unchanged below it.
    layers.push({input:bytes,left:x,top:y});
    for(const r of highlights){layers.push({input:rectangle(Math.round(r.width*scale),Math.round(r.height*scale),'#ead46c88'),left:x+Math.round(r.left*scale),top:y+Math.round(r.top*scale),blend:'multiply'});}
    if(label)await text(`${id}_label`,label,x,y+h+36,w,44,32,COLORS.muted);
  };
  const source = shot.scene_id==='S07' && shot.id==='return_to_search' ? 'JULY 8 SEARCH · TRIAL TESTIMONY CONTEXT (V02)' : shot.scene_id==='S06'||shot.scene_id==='S07' ? 'LATER RECORD REVIEW · E01 p3 / E02 p17' : `CRIMINAL COMPLAINT · ${['S01','S02'].includes(shot.scene_id)?'pp2–3':'p3'}`;
  await text('source',source,72,49,1660,49,34,COLORS.muted);
  // Distinct compositions follow the evidence. No source video, room or phone UI is fabricated.
  if(shot.id==='portrait_report'){
    await image('portrait_source',0,128,935,760,{fit:'cover'});
    box(0,818,935,70,COLORS.deep);
    await text('photo_credit','UNDATED AGENCY PHOTO · VIA ABC NEWS',70,839,810,40,29,COLORS.muted);
    await text('report_date','JULY 7, 2021',1005,186,825,80,60,COLORS.gold);
    await text('name','CHANDLER\nHALDERSON',1005,301,825,186,78);
    line(1005,513,118);
    await text('reported','Reported his\nparents missing',1005,553,825,177,64,COLORS.light,{font:'Arial'});
    await text('report_type','MISSING-PERSON REPORT',1005,788,825,54,36,COLORS.muted);
  } else if(['reported_cabin','unwitnessed_departure'].includes(shot.id)){
    await image('portrait_source',72,164,548,662,{fit:'cover'});
    await text('photo_credit','UNDATED AGENCY PHOTO',73,846,680,46,30,COLORS.muted);
    const isCabin=shot.id==='reported_cabin';
    await text('attribution','HIS REPORTED ACCOUNT',718,173,1100,58,36,COLORS.gold);
    await text('focus',isCabin?'A trip to the\nfamily cabin':'He had not witnessed\ntheir departure',718,275,1120,214,70,COLORS.light,{font:'Arial Bold'});
    line(718,523,165);
    await excerpt({id:isCabin?'e01_cabin':'e01_answer',x:730,y:601,w:1080,h:160,extract:isCabin?{left:0,top:0,width:1548,height:94}:{left:0,top:18,width:1548,height:87},highlights:isCabin?[{left:565,top:8,width:964,height:42}]:[{left:356,top:46,width:785,height:39}]});
  } else if(['departure_account','repair_purpose','unidentified_friends'].includes(shot.id)){
    await text('disclosure','ILLUSTRATIVE COMPOSITION · HIS REPORTED ACCOUNT',72,144,1760,52,32,COLORS.muted);
    await person('chandler_cutout',-63,225,774,642,shot.id==='departure_account'?11:shot.id==='repair_purpose'?6:3);
    await text('portrait_caption','CHANDLER · UNDATED PORTRAIT',72,842,660,44,30,COLORS.muted);
    const departure=shot.id==='departure_account', repairs=shot.id==='repair_purpose';
    await text('account_kicker',departure?'REPORTED DEPARTURE':repairs?'REPORTED PURPOSE':'THE FRIENDS',710,239,1120,65,40,COLORS.gold);
    await text('account_focus',departure?'FRIDAY\nJULY 2':repairs?'WATER PUMP\n+ FIRE PIT':'He could not\nidentify them',710,341,1120,205,76);
    const ext=departure?{left:0,top:0,width:1548,height:94}:repairs?{left:0,top:341,width:1548,height:94}:{left:0,top:268,width:1548,height:80};
    const hi=departure?[{left:3,top:52,width:395,height:40}]:repairs?[{left:943,top:1,width:467,height:45}]:[{left:5,top:39,width:1185,height:38}];
    await excerpt({id:'e01_cabin',x:728,y:644,w:1100,h:140,extract:ext,highlights:hi});
  } else if(shot.id==='illustrative_exchange'){
    await text('disclosure','ILLUSTRATIVE RECONSTRUCTION · JULY 7 EVENING',72,145,1760,51,34,COLORS.gold);
    await text('location','AT THE FAMILY HOME',72,211,1760,49,36,COLORS.muted);
    // The same portraits move as layout layers, not enacted reactions or an invented scene recording.
    await person('detective_cutout',79,304,446,535,9);
    await person('chandler_cutout',1227,301,636,535,-9);
    await text('question_label','DETECTIVES ASKED WHETHER',597,341,690,62,36,COLORS.muted,{align:'center'});
    await text('question','He had seen\nor heard\nthem leave',595,450,692,292,66,COLORS.light,{align:'center'});
    await text('detective_label','DETECTIVE · ILLUSTRATION',75,845,740,46,29,COLORS.muted);
    await text('chandler_label','CHANDLER · UNDATED PORTRAIT',1201,845,650,46,29,COLORS.muted);
  } else if(shot.id==='record_answer'){
    await text('reading_kicker','THE RECORDED ANSWER',92,176,1680,67,41,COLORS.gold);
    await text('focus','One sentence.',91,282,1680,136,112);
    await excerpt({id:'e01_answer',x:112,y:543,w:1664,h:172,extract:{left:0,top:18,width:1548,height:87},highlights:[{left:357,top:45,width:785,height:39}],label:'ACTUAL COMPLAINT EXCERPT · PAGE 3'});
  } else if(shot.id==='exact_document_reading'){
    await text('reading_label','DOCUMENT READING · EXACT WORDS',92,163,1690,60,40,COLORS.gold);
    box(72,269,1776,304,COLORS.paper);
    line(94,299,8,COLORS.gold,236);
    await text('exact_quote',"Chandler stated he didn't\nhear or see anything.",138,331,1630,213,80,COLORS.ink,{font:'Arial'});
    await excerpt({id:'e01_answer',x:398,y:671,w:1124,h:74,extract:{left:367,top:61,width:780,height:43},highlights:[{left:0,top:1,width:778,height:41}],label:'TYPESET READING ABOVE · ORIGINAL LINE BELOW'});
  } else if(shot.id==='reported_absence'){
    await text('account_date','HIS REPORTED ACCOUNT · FRIDAY, JULY 2',91,163,1720,60,37,COLORS.gold);
    await text('time','6:15',85,260,1080,238,210);
    await text('time_suffix','A.M.',769,383,345,105,72,COLORS.muted);
    await text('found_gone','He said he found\nhis parents gone.',1131,304,690,190,60,COLORS.light,{font:'Arial'});
    await excerpt({id:'e01_answer',x:112,y:623,w:1688,h:137,extract:{left:0,top:101,width:1548,height:48},highlights:[{left:16,top:3,width:1173,height:41}],label:'ACTUAL COMPLAINT EXCERPT · PAGE 3'});
  } else if(shot.id==='unobserved_distinction'){
    await text('attribution','WHAT HIS ACCOUNT ESTABLISHED',91,163,1730,58,37,COLORS.gold);
    await text('absence','REPORTED\nABSENCE',92,281,800,210,82,COLORS.light);
    await text('time_small','AROUND 6:15 A.M.',94,532,800,77,51,COLORS.muted);
    box(929,286,3,417,COLORS.line);
    await text('without','DEPARTURE\nNOT WITNESSED',1040,286,792,210,72,COLORS.light);
    await text('limit','BY HIM',1043,535,740,70,51,COLORS.gold);
    await excerpt({id:'e01_answer',x:402,y:733,w:1120,h:73,extract:{left:367,top:61,width:780,height:43},highlights:[{left:0,top:1,width:778,height:41}]});
  } else if(['reported_message','reported_message_date','later_record_check','parade_date_reveal','one_day_earlier'].includes(shot.id)){
    const hasMessageDate=shot.id!=='reported_message';
    const hasParadeDate=['parade_date_reveal','one_day_earlier'].includes(shot.id);
    const difference=shot.id==='one_day_earlier';
    await text('message_label','REPORTED MESSAGE',93,166,1640,62,39,COLORS.gold);
    if(!hasMessageDate){
      await text('message_intro','A message from\nhis mother',93,294,1680,219,91);
      await excerpt({id:'e02_parade',x:113,y:612,w:1686,h:162,extract:{left:0,top:54,width:1548,height:123},highlights:[{left:1054,top:46,width:473,height:44}],label:'MESSAGE WORDING REPRODUCED IN THE AMENDED COMPLAINT'});
    } else if(!hasParadeDate){
      await text('message_date','JULY 4',89,272,1110,192,157);
      await text('message_day','SUNDAY',95,485,800,74,47,COLORS.muted);
      await text('reported_parade','Going to White Lake\nfor the parade that day',975,297,865,182,60,COLORS.light,{font:'Arial'});
      await excerpt({id:'e02_parade',x:113,y:646,w:1686,h:144,extract:{left:0,top:98,width:1548,height:82},highlights:[{left:1053,top:0,width:469,height:43},{left:6,top:40,width:231,height:40}]});
      if(shot.id==='later_record_check'){
        // Only a neutral record-check cue appears here. The July 3 source line remains hidden.
        box(1071,525,738,75,COLORS.paper);
        await text('record_check','LATER COMPLAINT CHECK',1103,545,679,48,35,COLORS.ink);
      }
    } else {
      await text('message_date','JULY 4',92,264,766,157,135);
      await text('message_day','SUNDAY · REPORTED MESSAGE',96,446,800,70,38,COLORS.muted);
      box(928,264,3,344,COLORS.line);
      await text('parade_date','JULY 3',1044,264,790,157,135,COLORS.gold);
      await text('parade_day','SATURDAY · PARADE DATE',1049,446,774,70,38,COLORS.muted);
      await excerpt({id:'e02_parade',x:381,y:596,w:1158,h:89,extract:{left:0,top:221,width:1548,height:60},highlights:[{left:213,top:0,width:400,height:43}]});
      if(difference){line(583,775,752,COLORS.gold,3);await text('difference','ONE DAY EARLIER',355,724,1210,72,57,COLORS.gold,{align:'center'});}
    }
  } else if(shot.id==='comparison_limit'){
    await text('small_message','JULY 4 · REPORTED MESSAGE',91,170,1640,65,41,COLORS.muted);
    await text('small_parade','JULY 3 · PARADE DATE',91,247,1640,65,41,COLORS.muted);
    line(93,352,198,COLORS.gold,4);
    await text('qualification','A specific detail\nto check.',91,406,1710,221,94);
    await text('location_limit','It did not establish their location.',94,742,1710,90,56,COLORS.muted,{font:'Arial'});
  } else if(shot.id==='return_to_search'){
    // Graphic date reset only: no invented cabin, search route or inferred causal link.
    await text('back','BACK TO',93,192,1700,100,60,COLORS.gold);
    await text('july_eight','JULY 8',83,316,1730,244,204);
    line(95,598,148,COLORS.gold,6);
    await text('cabin_search','THE CABIN SEARCH',92,662,1710,122,91);
    await text('chronology','RETURN TO THE EARLIER SEARCH',96,822,1710,54,35,COLORS.muted);
  } else need(false,`unknown shot ${shot.id}`);
  const board=await sharp(paperBoard()).composite(layers).png().toBuffer();
  return {board,moving};
}

function assTime(sec) { const cs=Math.round(sec*100),h=Math.floor(cs/360000),m=Math.floor(cs/6000)%60,s=Math.floor(cs/100)%60;return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs%100).padStart(2,'0')}`; }
function assSafe(s){return s.replaceAll('\\','\\\\').replaceAll('{','\\{').replaceAll('}','\\}');}
export async function buildEditorialCaptionAss(captions) {
  const measurements=[],events=[];
  for(const [i,c] of captions.entries()){
    let lines=[c.text];
    let r;
    try{r=await renderMeasuredEditorialText({text:c.text,width:1700,height:120,fontSize:48});}catch{
      const words=c.text.split(/\s+/u); let split=Math.ceil(words.length/2),best=null;
      for(let j=1;j<words.length;j++){
        const candidate=[words.slice(0,j).join(' '),words.slice(j).join(' ')];
        try{const measured=await renderMeasuredEditorialText({text:candidate.join('\n'),width:1700,height:126,fontSize:48,lineGap:9});const score=measured.measurement.actual_width;if(!best||score<best.score)best={candidate,measured,score};}catch{}
      }
      need(best,`caption cannot fit without shrinking: ${i}`);lines=best.candidate;r=best.measured;
    }
    need(sameWords(lines.join(' '))===sameWords(c.text),'caption wrapping changed words');
    measurements.push({...r.measurement,index:i,text:c.text,text_lines:lines});
    events.push(`Dialogue: 0,${assTime(c.start_sec)},${assTime(c.end_sec)},Default,,0,0,0,,${lines.map(assSafe).join('\\N')}`);
  }
  const text=`[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Arial,48,&H00FFFFFF,&H000000FF,&H0010191F,&H9010191F,-1,0,0,0,100,100,0,0,1,3,1,2,100,100,57,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${events.join('\n')}\n`;
  return {text,measurements};
}
async function prepareCaptionImages(captions,measurements,outputDir) {
  const dir=path.join(outputDir,'caption-images');await fs.mkdir(dir);
  const images=[];
  for(let i=0;i<captions.length;i++){
    const c=captions[i],m=measurements[i];
    const r=await renderMeasuredEditorialText({text:m.text_lines.join('\n'),width:1800,height:132,fontSize:48,lineGap:9,align:'center'});
    const boxWidth=Math.min(1800,r.measurement.actual_width+60),boxHeight=r.measurement.actual_height+28;
    const top=160-boxHeight-10;
    const textBytes=await sharp(r.bytes).extract({left:0,top:0,width:1800,height:r.measurement.actual_height}).png().toBuffer();
    const bytes=await sharp({create:{width:1800,height:160,channels:4,background:'#00000000'}}).composite([{input:rectangle(boxWidth,boxHeight,'#0d171dde',12),left:Math.floor((1800-boxWidth)/2),top},{input:textBytes,left:0,top:top+14}]).png().toBuffer();
    const file=path.join(dir,`caption-${String(i).padStart(2,'0')}.png`);await fs.writeFile(file,bytes,{flag:'wx'});images.push({...c,image:await ref(file),x:60,y:890});
  }
  return images;
}
const filterPath=p=>p.replaceAll('\\','\\\\').replaceAll(':','\\:').replaceAll("'","'\\''");
async function executeFfmpeg(args,logFile){
  try{const result=await exec('ffmpeg',['-nostdin','-hide_banner','-loglevel','warning',...args],{timeout:300000,maxBuffer:8*1024*1024});await fs.writeFile(logFile,result.stderr??'',{flag:'wx'});}catch(error){await fs.writeFile(logFile,String(error.stderr??error.message),{flag:'wx'});throw error;}
}
async function checkVideo(file,frames){
  const {stdout}=await exec('ffprobe',['-v','error','-count_frames','-show_entries','stream=codec_type,width,height,avg_frame_rate,nb_read_frames,duration','-of','json',file],{maxBuffer:1024*1024});
  const probe=JSON.parse(stdout),v=probe.streams.find(s=>s.codec_type==='video');
  need(v && v.width===W && v.height===H && v.avg_frame_rate==='30/1' && Number(v.nb_read_frames)===frames && Math.abs(Number(v.duration)-frames/FPS)<0.0001,'encoded video dimensions/frame/duration QA failed');
  need(!probe.streams.some(s=>s.codec_type==='audio'),'visual module unexpectedly produced audio');return probe;
}

/** Local assets/compositor only. Root caller supplies an empty, separately scoped output directory. */
export async function renderEditorialVisuals({plan,outputDir,previewOnly=false}={}) {
  need(plan?.schema===EDITORIAL_VISUAL_SCHEMA && plan.production_eligible===false && plan.publish_allowed===false && plan.duration_frames===FRAMES && plan.shots.at(-1)?.end_frame===FRAMES,'exact private plan required');
  need(path.isAbsolute(outputDir),'absolute output directory required');
  let contents;try{contents=await fs.readdir(outputDir);}catch(error){if(error.code!=='ENOENT')throw error;await fs.mkdir(outputDir,{recursive:true});contents=[];}need(contents.length===0,'refusing to overwrite nonempty visual output');
  const start=Date.now(),assetBytes={};for(const id of EDITORIAL_ASSET_IDS)assetBytes[id]=await readRef(plan.assets[id]);
  await saveJson(path.join(outputDir,'visual-plan.json'),plan);
  const measurements=[],boards=[],previews=[];
  const imageDir=path.join(outputDir,'boards');await fs.mkdir(imageDir);
  for(const shot of plan.shots){
    const rendered=await boardFor(shot,assetBytes,measurements),file=path.join(imageDir,`${String(shot.index).padStart(2,'0')}-${shot.id}.png`);
    await fs.writeFile(file,rendered.board,{flag:'wx'});
    const row={...shot,board:await ref(file),moving:[]};
    for(const [i,m] of rendered.moving.entries()) {const layerPath=path.join(imageDir,`${String(shot.index).padStart(2,'0')}-${shot.id}-layer-${i}.png`);await fs.writeFile(layerPath,m.bytes,{flag:'wx'});const {bytes,...layout}=m;row.moving.push({...layout,asset:await ref(layerPath)});}
    boards.push(row);
    let composed=sharp(rendered.board);
    if(rendered.moving.length)composed=composed.composite(rendered.moving.map(m=>({input:m.bytes,left:Math.round(m.x+m.drift_x/2),top:m.y})).filter(m=>m.left>=0));
    // QA previews contain the complete people, including the one intentional offscreen left crop.
    if(rendered.moving.some(m=>m.x<0)) {
      const overlays=[];for(const m of rendered.moving){const px=Math.round(m.x+m.drift_x/2),cropLeft=Math.max(0,-px);const input=cropLeft?await sharp(m.bytes).extract({left:cropLeft,top:0,width:m.width-cropLeft,height:m.height}).png().toBuffer():m.bytes;overlays.push({input,left:Math.max(0,px),top:m.y});}composed=sharp(rendered.board).composite(overlays);
    }
    const previewFile=path.join(outputDir,`preview-${String(shot.index).padStart(2,'0')}-${shot.id}.png`);await composed.png().toFile(previewFile);previews.push({shot_id:shot.id,frame:Math.floor((shot.start_frame+shot.end_frame-1)/2),...await ref(previewFile)});
  }
  const caption=await buildEditorialCaptionAss(plan.captions),assFile=path.join(outputDir,'captions.ass');await fs.writeFile(assFile,caption.text,{flag:'wx'});
  const captionImages=await prepareCaptionImages(plan.captions,caption.measurements,outputDir);
  await saveJson(path.join(outputDir,'text-measurements.json'),{headings:measurements,captions:caption.measurements});
  if(previewOnly){const result={schema:'goldflow_true_crime_editorial_visual_previews_v1',preview_only:true,production_eligible:false,plan:await ref(path.join(outputDir,'visual-plan.json')),boards,previews,caption_images:captionImages,text_measurements:await ref(path.join(outputDir,'text-measurements.json')),captions:await ref(assFile),elapsed_sec:(Date.now()-start)/1000};await saveJson(path.join(outputDir,'preview-report.json'),result);return result;}
  return renderPreparedBoards({plan,outputDir,boards,previews,captionImages,assFile,start,planRef:await ref(path.join(outputDir,'visual-plan.json')),measurementRef:await ref(path.join(outputDir,'text-measurements.json'))});
}

export async function prepareEditorialVisuals(options={}) { return renderEditorialVisuals({...options,previewOnly:true}); }

export async function renderPreparedEditorialVisuals({prepared,outputDir}={}) {
  need(prepared?.schema==='goldflow_true_crime_editorial_visual_previews_v1' && prepared.preview_only===true && prepared.production_eligible===false,'prepared private preview report required');
  const plan=JSON.parse(await readRef(prepared.plan));
  need(plan.schema===EDITORIAL_VISUAL_SCHEMA && plan.duration_frames===FRAMES && plan.shots.length===18,'prepared plan scope changed');
  need(path.isAbsolute(outputDir),'absolute new render directory required');
  let contents;try{contents=await fs.readdir(outputDir);}catch(error){if(error.code!=='ENOENT')throw error;await fs.mkdir(outputDir,{recursive:true});contents=[];}need(contents.length===0,'refusing to overwrite nonempty render output');
  need(prepared.boards?.length===plan.shots.length,'prepared shot count changed');
  for(let i=0;i<prepared.boards.length;i++){const b=prepared.boards[i],s=plan.shots[i];need(b.id===s.id && b.start_frame===s.start_frame && b.end_frame===s.end_frame && b.frame_count===s.frame_count,'prepared shot timeline changed');await readRef(b.board);for(const m of b.moving??[])await readRef(m.asset);}
  for(const id of EDITORIAL_ASSET_IDS)await readRef(plan.assets[id]);
  await readRef(prepared.text_measurements);await readRef(prepared.captions);
  need(prepared.caption_images?.length===plan.captions.length,'prepared caption count changed');
  for(let i=0;i<prepared.caption_images.length;i++){const c=prepared.caption_images[i],p=plan.captions[i];need(c.text===p.text && c.start_sec===p.start_sec && c.end_sec===p.end_sec,'prepared caption text or timing changed');await readRef(c.image);}
  await saveJson(path.join(outputDir,'prepared-input.json'),prepared);
  return renderPreparedBoards({plan,outputDir,boards:prepared.boards,previews:prepared.previews,captionImages:prepared.caption_images,assFile:prepared.captions.path,start:Date.now(),planRef:prepared.plan,measurementRef:prepared.text_measurements});
}

async function renderPreparedBoards({plan,outputDir,boards,previews,captionImages,assFile,start,planRef,measurementRef}) {
  const shotsDir=path.join(outputDir,'shot-videos');await fs.mkdir(shotsDir);const shotVideos=[];
  for(const shot of boards){
    const file=path.join(shotsDir,`${String(shot.index).padStart(2,'0')}-${shot.id}.mp4`),args=['-loop','1','-framerate','30','-i',shot.board.path];
    for(const m of shot.moving)args.push('-loop','1','-framerate','30','-i',m.asset.path);
    const shotCaptions=captionImages.filter(c=>c.start_sec<shot.end_sec && c.end_sec>shot.start_sec);
    for(const c of shotCaptions)args.push('-loop','1','-framerate','30','-i',c.image.path);
    const graphs=[];let current='base';
    // Purposeful independent cutout drift; document/quote raster stays stable and legible.
    graphs.push(`[0:v]format=rgba,setpts=PTS-STARTPTS[${current}]`);
    for(const [i,m]of shot.moving.entries()){const next=`layered${i}`;graphs.push(`[${current}][${i+1}:v]overlay=x='${m.x}+${m.drift_x}*min(t/${(shot.frame_count/FPS).toFixed(6)},1)':y=${m.y}:shortest=1:format=auto[${next}]`);current=next;}
    for(const [i,c]of shotCaptions.entries()){const next=`captioned${i}`,startSec=Math.max(0,c.start_sec-shot.start_sec),endSec=Math.min(shot.frame_count/FPS,c.end_sec-shot.start_sec);graphs.push(`[${current}][${1+shot.moving.length+i}:v]overlay=x=${c.x}:y=${c.y}:shortest=1:format=auto:enable='gte(t,${startSec.toFixed(9)})*lt(t,${endSec.toFixed(9)})'[${next}]`);current=next;}
    graphs.push(`[${current}]trim=end_frame=${shot.frame_count},setpts=PTS-STARTPTS,format=yuv420p[out]`);
    args.push('-filter_complex_threads','1','-filter_complex',graphs.join(';'),'-map','[out]','-an','-c:v','libx264','-preset','veryfast','-crf','16','-r','30','-frames:v',String(shot.frame_count),'-pix_fmt','yuv420p','-movflags','+faststart',file);
    await executeFfmpeg(args,path.join(shotsDir,`${String(shot.index).padStart(2,'0')}.ffmpeg.log`));
    shotVideos.push({...shot,video:await ref(file),probe:await checkVideo(file,shot.frame_count)});
  }
  const listFile=path.join(outputDir,'shots.ffconcat');await fs.writeFile(listFile,`ffconcat version 1.0\n${shotVideos.map(s=>`file '${s.video.path.replaceAll("'","'\\''")}'`).join('\n')}\n`,{flag:'wx'});
  const videoFile=path.join(outputDir,'editorial-v3-picture.mp4');
  await executeFfmpeg(['-f','concat','-safe','0','-i',listFile,'-an','-c:v','copy','-movflags','+faststart',videoFile],path.join(outputDir,'assemble.ffmpeg.log'));
  const probe=await checkVideo(videoFile,FRAMES);
  for(const id of EDITORIAL_ASSET_IDS)await readRef(plan.assets[id]);
  const qaFrames=[];
  for(const p of previews){const file=path.join(outputDir,`qa-frame-${String(p.frame).padStart(5,'0')}.png`);await exec('ffmpeg',['-nostdin','-v','error','-i',videoFile,'-vf',`select=eq(n\\,${p.frame})`,'-vsync','0','-frames:v','1',file],{timeout:60000,maxBuffer:1024*1024});qaFrames.push({frame:p.frame,shot_id:p.shot_id,...await ref(file)});}
  const result={schema:'goldflow_true_crime_editorial_visual_report_v1',status:'picture_candidate_ready_needs_review',production_eligible:false,publish_allowed:false,visual_technical_qa:'passed',subjective_viewing_approval:false,width:W,height:H,fps:FPS,duration_frames:FRAMES,duration_sec:64.4,output:await ref(videoFile),plan:planRef,captions:await ref(assFile),caption_render_method:'Measured PNG alpha overlays; ASS retained only as a readable timing/text sidecar.',caption_images:captionImages,text_measurements:measurementRef,source_assets:plan.assets,shots:shotVideos,frames:qaFrames,independent_cutout_motion:true,source_document_words_preserved:true,caption_words_preserved:true,new_case_facts:false,new_faces:false,probe,elapsed_sec:(Date.now()-start)/1000};
  await saveJson(path.join(outputDir,'visual-report.json'),result);return result;
}
