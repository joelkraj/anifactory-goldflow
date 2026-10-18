import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {validateCrimeFootageManifest,measuredCrimeText,exerciseCrimeFootageRendererWithSyntheticInputs,renderCrimeFootageProof,inspectCrimeFootageManifest,crimeFootageFileRef} from '../lib/crime-question-proof-renderer.mjs';

const source={path:'/synthetic/source.wav',sha256:'1'.repeat(64),in_sec:0,out_sec:30,origin:'original_court_audio'};
const scene=id=>({id,plan_scene_id:id,kind:'graphic',duration_frames:900,audio:{...source},source_id:'test',window_id:'window',source_label:'SYNTHETIC FIXTURE',title:'THE RECORD',captions:[{start_sec:0,end_sec:1,text:'A complete phrase.'}],transcript_text:'A complete phrase.'});
const manifest={schema:'crime_footage_proof_render_manifest_v1',width:1920,height:1080,fps:30,min_duration_sec:90,max_duration_sec:150,production_eligible:false,publish_allowed:false,segments:['a','b','c'].map(scene)};
assert.equal(validateCrimeFootageManifest(manifest).duration_frames,2700);
const mutation=fn=>{const m=structuredClone(manifest);fn(m);assert.throws(()=>validateCrimeFootageManifest(m));};
mutation(m=>m.publish_allowed=true);
mutation(m=>{m.min_duration_sec=60;m.max_duration_sec=90;});
mutation(m=>m.segments.push(scene('d'),scene('e'),scene('f')));
mutation(m=>{for(const s of m.segments){s.duration_frames=300;s.audio.out_sec=10;}});
assert.equal(validateCrimeFootageManifest({...manifest,segments:[...manifest.segments,scene('d'),scene('e')]}).duration_sec,150);
mutation(m=>m.segments[0].audio.out_sec=29);
mutation(m=>m.segments[0].audio.in_sec=1);
mutation(m=>m.segments[0].captions[0].text='Different words');
mutation(m=>m.segments[0].captions.push({start_sec:.5,end_sec:2,text:'Overlap'}));
mutation(m=>m.segments[0].kind='footage');
mutation(m=>{m.segments[0].kind='audio_transcript';m.segments[0].audio.origin='qwen_narration';m.segments[0].narration_unit_id='voice';});
mutation(m=>m.segments[0].text_cues=[{start_sec:31,title:'Late'}]);
mutation(m=>m.underscore={enabled:true,amplitude:.5});
mutation(m=>m.segments[0].reframe={scale:1.5,x:.5,y:.5,reason:'Too much crop'});
mutation(m=>m.segments[0].speaker_id_duration_sec=20);
mutation(m=>m.segments[0].source_position='on-native-logo');
mutation(m=>m.segments[0].caption_bottom_px=1100);
mutation(m=>m.segments[0].context_cues=[{start_sec:1,end_sec:20,title:'Long presentation interruption'}]);
mutation(m=>{m.segments[0].layout='social';});
mutation(m=>{m.segments[0].layout='comparison';m.segments[0].left_title='EARLIER';});
mutation(m=>{m.segments[0].text_cues=[{start_sec:1,right_body:'Wrong layout'}];});
const comparisonManifest=structuredClone(manifest);Object.assign(comparisonManifest.segments[0],{layout:'comparison',left_title:'EARLIER',left_body:'First account.',right_title:'LATER',right_body:'Second account.',text_cues:[{start_sec:1,right_body:'A useful clarification.'}]});assert.equal(validateCrimeFootageManifest(comparisonManifest).duration_sec,90);
const measured=await measuredCrimeText({text:'A short complete phrase.',width:1500,height:160,fontSize:54,minFontSize:48});
assert(measured.measurement.actual_width<=1500&&measured.measurement.actual_height<=160);
await assert.rejects(()=>measuredCrimeText({text:'This is too much text for a tiny box.',width:20,height:20,fontSize:54,minFontSize:48}));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'crime-question-proof-fixtures-'));
await assert.rejects(()=>renderCrimeFootageProof({manifestPath:'/not-selected',outputDir:path.join(root,'no-guard')}),/guarded explicit/);
assert.deepEqual(await fs.readdir(root),[]);
const outputDir=path.join(root,'synthetic');const fixture=await exerciseCrimeFootageRendererWithSyntheticInputs({outputDir});
assert.equal(fixture.synthetic_fixture,true);assert.equal(fixture.results.length,7);
for(const row of fixture.results){const v=row.probe.streams.find(s=>s.codec_type==='video');assert.equal(v.width,1920);assert.equal(v.height,1080);assert.equal(Number(v.nb_frames),60);assert.equal(Number(v.duration),2);assert.equal(row.audio_samples_per_channel,96000);assert.equal(row.graphics.captions.length,2);for(const c of row.graphics.captions){const m=await sharp(c.path).metadata();assert.equal(m.width,1920);assert.equal(m.height,1080);}}
const full=fixture.results.find(r=>r.kind==='footage');assert.equal(full.graphics.timed_overlays.length,2);assert.equal(full.graphics.timed_overlays[0].end_sec,.6);assert.equal(full.graphics.timed_overlays[1].start_sec,1);
const social=fixture.results.find(r=>r.kind==='social_card');assert(social.graphics.measurements.some(m=>m.id==='social-label'&&m.font_size>=32));assert(social.graphics.measurements.some(m=>m.id==='source'&&m.font_size>=32));
const comparison=fixture.results.find(r=>r.kind==='comparison_graphic');assert.equal(comparison.graphics.variants.length,1);assert(comparison.graphics.measurements.some(m=>m.id==='left-title'));assert(comparison.graphics.measurements.some(m=>m.id==='right-body'&&m.cue_start_sec===1));
// Inspect the actual encoded fade, not a filter-string declaration. At the cue
// the old board remains; midway both states contribute; six frames later the
// new board is complete. This test crops only the changing authored text panel.
const exec=promisify(execFile);
const frameRgb=async(file,frame,filter)=>Buffer.from((await exec('ffmpeg',['-nostdin','-v','error','-i',file,'-vf',`select=eq(n\\,${frame}),${filter}`,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{encoding:'buffer',maxBuffer:8*1024*1024})).stdout);
const panel='crop=752:380:1036:462';
const [beforeReveal,revealStart,revealMid,revealEnd,revealSettled]=await Promise.all([29,30,33,36,45].map(n=>frameRgb(comparison.video.path,n,panel)));
const meanDifference=(a,b)=>{assert.equal(a.length,b.length);let sum=0;for(let i=0;i<a.length;i++)sum+=Math.abs(a[i]-b[i]);return sum/a.length;};
assert(meanDifference(beforeReveal,revealStart)<.8,'authored cue must begin at its prior state');
assert(meanDifference(revealEnd,revealSettled)<.8,'authored cue must finish after six frames');
const fullDifference=meanDifference(beforeReveal,revealEnd);assert(fullDifference>1,'fixture must contain a real graphic change');
assert(meanDifference(beforeReveal,revealMid)>fullDifference*.25&&meanDifference(beforeReveal,revealMid)<fullDifference*.75,'middle encoded frame must show a partial authored reveal');
assert(meanDifference(revealMid,revealEnd)>fullDifference*.25,'middle frame must not cut directly to the new state');
// A source-picture crop at the halfway reveal is still the complete source
// frame, without crossfade/dimming. The authored board is behind this footage.
const card=fixture.results.find(r=>r.kind==='footage_card');
const cardPixels=await frameRgb(card.video.path,33,'crop=500:200:906:336');
const sourcePixels=await frameRgb(path.join(outputDir,'synthetic-test-pattern.mp4'),33,'scale=1046:588,crop=500:200:100:100');
assert(meanDifference(cardPixels,sourcePixels)<3,'board reveal must not fade the source video');
const oldRenderer=await fs.readFile(new URL('../lib/crime-footage-proof-renderer.mjs',import.meta.url),'utf8'),newRenderer=await fs.readFile(new URL('../lib/crime-question-proof-renderer.mjs',import.meta.url),'utf8');
assert.equal(newRenderer.slice(newRenderer.indexOf('export async function renderCrimeFootageProof(')),oldRenderer.slice(oldRenderer.indexOf('export async function renderCrimeFootageProof(')),'Guarded assembly, source coverage and audio/mastering logic must remain unchanged');
// Exact whole-narrator verification uses synthetic silence, never a provider.
const wav=Buffer.alloc(44+30*24000*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
const voicePath=path.join(root,'synthetic-complete-unit.wav');await fs.writeFile(voicePath,wav);const voiceRef=await crimeFootageFileRef(voicePath);
const whole=structuredClone(manifest);for(const s of whole.segments)s.audio={...voiceRef,in_sec:0,out_sec:30,origin:'original_court_audio'};whole.segments[0].audio.origin='qwen_narration';whole.segments[0].narration_unit_id='synthetic-unit';const wholePath=path.join(root,'whole-unit.json');await fs.writeFile(wholePath,JSON.stringify(whole));await inspectCrimeFootageManifest({manifestPath:wholePath});
whole.segments[0].audio.out_sec=29.99;await fs.writeFile(wholePath,JSON.stringify(whole));await assert.rejects(()=>inspectCrimeFootageManifest({manifestPath:wholePath}),/narration file must be used in full/);
await assert.rejects(()=>exerciseCrimeFootageRendererWithSyntheticInputs({outputDir}),/EEXIST/);
console.log(JSON.stringify({passed:true,provider_free:true,fixture_root:root,checks:['90–150 private scope and exact windows','caption text/order and explicit roles','no-write missing guard refusal','actual measured text fit','real FFmpeg encoding with temporary IDs and factual overlays over continuing footage','modest static framing and readable backed source credits','portrait containment over same-source backdrop','unchanged guarded audio/mastering/assembly implementation','exact fixture frame/audio counts','existing output refusal','full narrator file preserved; subframe truncation rejected','large social card attribution','comparison panels with timed evidence change','encoded six-frame authored reveal without source-picture dimming']}));
