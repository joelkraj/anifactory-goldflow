import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {buildEditorialVisualPlan,renderMeasuredEditorialText,buildEditorialCaptionAss,EDITORIAL_ASSET_IDS,EDITORIAL_MARKER_KEYS,prepareEditorialVisuals,renderPreparedEditorialVisuals} from '../lib/true-crime-proof-editorial-visuals.mjs';
const exec=promisify(execFile);
const dummyRef={path:'/synthetic/source.png',sha256:'a'.repeat(64)};
const assets=Object.fromEntries(EDITORIAL_ASSET_IDS.map(id=>[id,dummyRef]));
const script=Array.from({length:191},(_,i)=>`word${i}`).join(' ');
const captions=script.split(' ').reduce((all,word,index)=>{if(index%8===0)all.push({text:word,start_sec:index*.3,end_sec:(index+1)*.3});else{all.at(-1).text+=` ${word}`;all.at(-1).end_sec=(index+1)*.3;}return all;},[]);
const values=[6.44,7.34,15.56,18.70,24.433333,36.24,43.70,47.56,51.62,52.16,59.50];
const markers=Object.fromEntries(EDITORIAL_MARKER_KEYS.map((k,i)=>[k,values[i]]));
const plan=buildEditorialVisualPlan({assets,captions,markers,scriptText:script});
assert.equal(plan.shots.length,18);assert.equal(plan.shots.reduce((sum,s)=>sum+s.frame_count,0),1932);
assert.equal(plan.shots.find(s=>s.id==='parade_date_reveal').start_frame,1549);
assert.equal(plan.shots.find(s=>s.id==='one_day_earlier').start_frame,1565);
assert.ok(plan.shots.find(s=>s.id==='parade_date_reveal').start_sec>=51.62);
assert.throws(()=>buildEditorialVisualPlan({assets,captions:[...captions,{text:'extra',start_sec:63,end_sec:64}],markers,scriptText:script}),/captions must preserve/);
assert.throws(()=>buildEditorialVisualPlan({assets,captions,markers:{...markers,parade_july3:46},scriptText:script}),/marker order/);
assert.throws(()=>buildEditorialVisualPlan({assets,captions,markers:{...markers,one_day_earlier:undefined},scriptText:script}),/marker seconds/);
const fitting=await renderMeasuredEditorialText({text:'DEPARTURE\nNOT WITNESSED',width:792,height:210,fontSize:72});
assert.ok(fitting.measurement.actual_width<=792);assert.ok(fitting.measurement.actual_height<=210);
await assert.rejects(()=>renderMeasuredEditorialText({text:'WIDE TEXT DOES NOT FIT',width:25,height:50,fontSize:72}),/does not fit/);
const ass=await buildEditorialCaptionAss([{text:"Chandler stated he didn't hear or see anything.",start_sec:27.533333,end_sec:30.353333}]);
assert.match(ass.text,/0:00:27.53/);assert.match(ass.text,/Chandler stated he didn't hear or see anything\./);assert.equal(ass.measurements[0].font_size,48);
await assert.rejects(()=>renderPreparedEditorialVisuals({prepared:{schema:'wrong'},outputDir:'/tmp/no-output'}),/prepared private/);
// Small actual encode verifies the same FFmpeg image-alpha/deliberate-motion/ASS filter
// mechanics using invented pixels only, not a real proof or a listening decision.
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'crime-visuals-test-'));
try{
 const fixtureAssets={};
 for(const id of EDITORIAL_ASSET_IDS){const size=id==='portrait_source'||id==='chandler_cutout'?[3072,1931]:id==='detective_cutout'?[1024,1536]:id==='e01_initial'?[1548,189]:id==='e01_cabin'?[1548,450]:id==='e01_answer'?[1548,150]:[1548,282];const file=path.join(tmp,`${id}.png`);const bytes=await sharp({create:{width:size[0],height:size[1],channels:4,background:'#ffffff'}}).png().toBuffer();await fs.writeFile(file,bytes);fixtureAssets[id]={path:file,sha256:createHash('sha256').update(bytes).digest('hex')};}
 const prepared=await prepareEditorialVisuals({plan:buildEditorialVisualPlan({assets:fixtureAssets,captions,markers,scriptText:script}),outputDir:path.join(tmp,'prepared')});
 assert.equal(prepared.boards.length,18);assert.equal(prepared.caption_images.length,captions.length);assert.equal(prepared.previews.length,18);
 const board=path.join(tmp,'board.png'),layer=path.join(tmp,'layer.png'),cap=path.join(tmp,'caption.png'),out=path.join(tmp,'tiny.mp4');
 await sharp({create:{width:1920,height:1080,channels:3,background:'#14242d'}}).png().toFile(board);
 await sharp({create:{width:80,height:80,channels:4,background:'#ead46cff'}}).png().toFile(layer);
 await fs.writeFile(cap,(await renderMeasuredEditorialText({text:'Synthetic visual fixture',width:1700,height:100,fontSize:48})).bytes);
 await exec('ffmpeg',['-nostdin','-v','error','-loop','1','-framerate','30','-i',board,'-loop','1','-framerate','30','-i',layer,'-loop','1','-framerate','30','-i',cap,'-filter_complex_threads','1','-filter_complex',`[0:v]format=rgba,setpts=PTS-STARTPTS[base];[base][1:v]overlay=x='70+40*min(t/0.3,1)':y=200:shortest=1:format=auto[layered];[layered][2:v]overlay=x=100:y=930:shortest=1:format=auto:enable='gte(t,0)*lt(t,0.3)'[captioned];[captioned]trim=end_frame=9,setpts=PTS-STARTPTS,format=yuv420p[out]`,'-map','[out]','-an','-c:v','libx264','-preset','ultrafast','-crf','18','-r','30','-frames:v','9','-pix_fmt','yuv420p',out],{timeout:60000,maxBuffer:2**20});
 const {stdout}=await exec('ffprobe',['-v','error','-count_frames','-show_entries','stream=codec_type,width,height,nb_read_frames,duration','-of','json',out]);const probe=JSON.parse(stdout).streams;assert.equal(probe.length,1);assert.equal(probe[0].nb_read_frames,'9');assert.equal(probe[0].duration,'0.300000');assert.equal(probe[0].width,1920);
}finally{await fs.rm(tmp,{recursive:true,force:true});}
console.log('Editorial visual tests passed: exact frame/caption coverage, delayed date cues, measured fitting/refusal, and synthetic alpha-motion/caption encoding.');
