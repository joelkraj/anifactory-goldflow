import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadCrimeFootageProof,loadCrimeFootageProofAttempt,crimeFootageProofStatus,crimeFootageFileRef} from './crime-footage-proof-workflow.mjs';

const exec=promisify(execFile),SCHEMA='crime_footage_v2_carry_forward_v1';
const need=(ok,message)=>{if(!ok)throw new Error(`Crime footage carry-forward: ${message}`);};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const write=(p,x)=>fs.writeFile(p,JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600});
const inside=(base,p)=>{const r=path.relative(base,p);return r!==''&&r!=='..'&&!r.startsWith(`..${path.sep}`)&&!path.isAbsolute(r);};
async function checked(r){need(r?.path&&r?.sha256,'exact retained reference required');const actual=await crimeFootageFileRef(r.path);need(actual.sha256===r.sha256,`bound input changed: ${r.path}`);return actual;}

export function validateCrimeFootageCarryForwardIdentity(oldIdentity,newIdentity,recipe) {
  need(recipe?.schema===SCHEMA&&recipe.scope==='same_case_sources_windows_script_voice_no_new_generation','exact technical carry-forward recipe required');
  need(typeof recipe.review_note==='string'&&recipe.review_note.trim().length>=20,'specific retained technical recovery reason required');
  need(recipe.from_proof_dir!==recipe.to_proof_dir&&path.isAbsolute(recipe.from_proof_dir)&&path.isAbsolute(recipe.to_proof_dir),'separate absolute source and destination proof required');
  const suffix=`${path.sep}revisions${path.sep}proof-v1${path.sep}episodes${path.sep}ep_01`;
  need(recipe.from_proof_dir.endsWith(suffix)&&recipe.to_proof_dir===recipe.from_proof_dir.slice(0,-suffix.length)+suffix.replace(`${path.sep}proof-v1${path.sep}`,`${path.sep}proof-v2${path.sep}`),'this repair only carries proof-v1 into its sibling proof-v2');
  for(const key of ['schema','channel','channel_name','series_slug','run_slug','episode','title','content_profile','media_workflow','sources','narration','proof_scope','audio_mastering'])need(equal(oldIdentity[key],newIdentity[key]),`identity ${key} differs`);
  for(const key of ['plan','script'])need(oldIdentity[key]?.sha256===newIdentity[key]?.sha256,`exact ${key} hash must match`);
  need(newIdentity.production_eligible===false&&newIdentity.publish_allowed===false,'private candidate only');
  const repair=recipe.source_audio_repair;
  need(repair?.source_id==='V03'&&repair.window_id==='cvs_exhibit'&&repair.hd_artifact_id==='V03_cvs_exhibit_hd'&&repair.english_audio_artifact_id==='V03_cvs_exhibit_preview144','only the identified V03 alternate-language error may be repaired');
  return true;
}

async function inspect({proofDir,attemptToken,recipePath,stage}) {
  const ctx=await loadCrimeFootageProofAttempt({proofDir,stage,attemptToken}),recipeRef=await crimeFootageFileRef(recipePath),recipe=await read(recipePath);
  need(ctx.inputs.some(r=>r.path===recipeRef.path&&r.sha256===recipeRef.sha256),'recipe must be bound before stage work');
  need(recipe.to_proof_dir===proofDir,'recipe destination differs from guarded proof');
  const old=await loadCrimeFootageProof({proofDir:recipe.from_proof_dir});validateCrimeFootageCarryForwardIdentity(old.identity,ctx.identity,recipe);
  need(recipe.from_identity.path===path.join(old.proofDir,'run_identity.json')&&recipe.from_identity.sha256===old.identity_sha256,'exact original immutable identity required');
  await checked(recipe.from_identity);await crimeFootageProofStatus({proofDir:old.proofDir});
  const stages={};
  for(const[name,r]of[['source_assets',recipe.from_source_stage],['narration',recipe.from_narration_stage]]) {
    need(r?.path===path.join(old.proofDir,`${name}.json`),`only the original ${name} stage may supply artifacts`);await checked(r);const receipt=await read(r.path);
    need(receipt.stage===name&&receipt.identity_sha256===old.identity_sha256,'original stage identity mismatch');
    for(const a of receipt.artifacts){need(inside(path.join(old.proofDir,'attempts',name,'output'),await fs.realpath(a.path)),'original artifact path escaped its stage');await checked(a);}
    await checked(receipt.result);stages[name]=receipt;
  }
  await checked(recipe.language_audit);await checked(recipe.picture_alignment);
  const audit=await read(recipe.language_audit.path),alignment=await read(recipe.picture_alignment.path),repair=recipe.source_audio_repair;
  const sourceMap=new Map(stages.source_assets.artifacts.map(a=>[a.id,a])),hd=sourceMap.get(repair.hd_artifact_id),english=sourceMap.get(repair.english_audio_artifact_id);
  need(hd?.kind==='source_video'&&english?.kind==='source_preview_low_quality'&&hd.source_ids.includes('V03')&&english.source_ids.includes('V03'),'repair streams must come from retained selected V03 artifacts');
  need(audit.source_url===old.identity.sources.find(s=>s.id==='V03').url&&audit.selected_audio?.language==='ar'&&audit.original_audio?.language==='en-US','retained alternate-language failure audit required');
  need(alignment.status==='passed'&&alignment.picture_alignment_passed===true&&alignment.no_retiming_required===true&&alignment.applied_offset_sec===0,'reviewed same-window picture correspondence without applied retiming required');
  need(Number.isFinite(alignment.offset_sec)&&Number.isFinite(alignment.alignment_tolerance_sec)&&alignment.alignment_tolerance_sec>0&&alignment.alignment_tolerance_sec<=1/15+.000001&&Math.abs(alignment.offset_sec)<=alignment.alignment_tolerance_sec+.000001,'measured correspondence must remain within one declared15fps source frame');
  need(alignment.hd_source?.path===hd.path&&alignment.hd_source.sha256===hd.sha256&&alignment.sd_source?.path===english.path&&alignment.sd_source.sha256===english.sha256,'alignment must bind both actual selected stream files');
  const helper=await crimeFootageFileRef(fileURLToPath(import.meta.url));need(ctx.inputs.some(r=>r.path===helper.path&&r.sha256===helper.sha256),'carry-forward helper must be bound to the exact stage inputs');
  need((await fs.readdir(ctx.outputDir)).length===0,'stage output must be empty; no rerun or overwrite');
  return {ctx,old,recipe,recipeRef,stages,hd,english,helper};
}

async function copyArtifact(a,dir){const output=path.join(dir,a.id+path.extname(a.path));await fs.copyFile(a.path,output,constants.COPYFILE_EXCL);const out=await crimeFootageFileRef(output);need(out.sha256===a.sha256,'exact copy hash mismatch');return {...a,...out};}
async function streamHash(file,type){const r=await exec('ffmpeg',['-nostdin','-v','error','-i',file,'-map',`0:${type}:0`,'-c','copy','-f','hash','-hash','sha256','pipe:1'],{maxBuffer:1024*1024,timeout:60000});need(/^SHA256=[a-f0-9]{64}\s*$/.test(r.stdout),'stream payload hash missing');return r.stdout.trim().slice(7);}
async function decodedAudioHash(file){const r=await exec('ffmpeg',['-nostdin','-v','error','-i',file,'-map','0:a:0','-c:a','pcm_s16le','-f','hash','-hash','sha256','pipe:1'],{maxBuffer:1024*1024,timeout:60000});need(/^SHA256=[a-f0-9]{64}\s*$/.test(r.stdout),'decoded audio hash missing');return r.stdout.trim().slice(7);}
async function mediaProbe(file){return JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{maxBuffer:1024*1024,timeout:30000})).stdout);}
const seconds=(p,type)=>Number(p.streams.find(s=>s.codec_type===type)?.duration??p.format.duration);
async function muxOriginalAudio({hd,english,output,expectedDuration}) {
  const hp=await mediaProbe(hd),ep=await mediaProbe(english);need(Math.abs(seconds(hp,'video')-expectedDuration)<=.2&&Math.abs(seconds(ep,'audio')-expectedDuration)<=.2,'source streams do not preserve selected window length');
  await exec('ffmpeg',['-nostdin','-v','error','-n','-i',hd,'-i',english,'-map','0:v:0','-map','1:a:0','-map_metadata','-1','-c:v','copy','-c:a','copy','-movflags','+faststart',output],{maxBuffer:1024*1024,timeout:60000});
  const [hv,ov,ea,oa]=await Promise.all([streamHash(hd,'v'),streamHash(output,'v'),streamHash(english,'a'),streamHash(output,'a')]);
  need(hv===ov&&ea===oa,'mux changed compressed video or original audio packet payload');
  const [decodedBefore,decodedAfter]=await Promise.all([decodedAudioHash(english),decodedAudioHash(output)]);need(decodedBefore===decodedAfter,'mux changed complete decoded original audio samples');
  const p=await mediaProbe(output);need(Math.abs(seconds(p,'video')-expectedDuration)<=.2&&Math.abs(seconds(p,'audio')-expectedDuration)<=.2,'mux changed source window duration');
  return {video_packet_payload_sha256:ov,audio_packet_payload_sha256:oa,compressed_stream_payloads_preserved:true,decoded_original_audio_pcm_sha256:decodedAfter,complete_decoded_audio_preserved:true,input_audio_start_time_sec:Number(ep.streams.find(s=>s.codec_type==='audio').start_time??0),output_audio_start_time_sec:Number(p.streams.find(s=>s.codec_type==='audio').start_time??0),timeline_origin_note:'FFmpeg normalizes each input container start; caption cues remain relative to the first decoded audio sample. No additional offset, trim, tempo or sample change is applied.',video_duration_sec:seconds(p,'video'),audio_duration_sec:seconds(p,'audio'),video_codec_copy:true,audio_codec_copy:true,trim_performed:false,retiming_performed:false,probe:p};
}
async function recheck(x){for(const r of [x.recipeRef,x.recipe.from_identity,x.recipe.from_source_stage,x.recipe.from_narration_stage,x.recipe.language_audit,x.recipe.picture_alignment,x.helper])await checked(r);await crimeFootageProofStatus({proofDir:x.old.proofDir});await loadCrimeFootageProofAttempt({proofDir:x.ctx.proofDir,stage:x.ctx.stage,attemptToken:x.ctx.attempt_token});}

export async function carryForwardCrimeFootageSources(args) {
  const x=await inspect({...args,stage:'source_assets'}),started=Date.now(),artifacts=[],source_windows=[],rows=[];
  await write(path.join(x.ctx.outputDir,'carry-forward-start.json'),{stage:'source_assets',recipe:x.recipeRef,helper:x.helper,from_identity:x.recipe.from_identity,to_identity_sha256:x.ctx.identity_sha256,started_at:new Date().toISOString(),new_acquisition:false,automatic_retry_allowed:false});
  const oldMap=new Map(x.stages.source_assets.artifacts.map(a=>[a.id,a]));
  for(const w of x.stages.source_assets.metadata.source_windows) {
    const a=oldMap.get(w.artifact_id);need(a?.kind==='source_video','selected retained source artifact missing');let copied,operation;
    if(w.source_id==='V03'&&w.window_id==='cvs_exhibit') {
      need(a.id===x.hd.id,'V03 selected HD artifact differs from repair');const output=path.join(x.ctx.outputDir,'V03_cvs_exhibit_original_english.mp4');
      operation=await muxOriginalAudio({hd:a.path,english:x.english.path,output,expectedDuration:w.source_end_sec-w.source_start_sec});copied={id:a.id,...await crimeFootageFileRef(output),kind:'source_video',source_ids:a.source_ids};
      rows.push({artifact_id:a.id,operation:'existing_HD_video_plus_existing_original_English_audio_stream_copy',video_from:a,audio_from:x.english,picture_alignment:x.recipe.picture_alignment,language_failure_audit:x.recipe.language_audit,...operation});
    } else {copied=await copyArtifact(a,x.ctx.outputDir);rows.push({artifact_id:a.id,operation:'exact_file_copy',carried_from:a});}
    const carriedWindow={...w,artifact_id:copied.id,acquisition_method:w.source_id==='V03'?'Local same-window technical repair: retained native-HD video stream plus retained original-English source audio, both stream copied; no new acquisition':'Exact local carry-forward of the retained native-HD source window; no new acquisition',audio_origin:'original',carried_from_stage:x.recipe.from_source_stage,technical_repair:w.source_id==='V03'?'alternate_audio_language_corrected_from_retained_original_recording':null};
    if(w.source_id==='V03'){carriedWindow.historical_quality_receipt=carriedWindow.quality_repair_receipt;delete carriedWindow.quality_repair_receipt;carriedWindow.audio_repair_lineage={video_from:x.hd,audio_from:x.english,picture_alignment:x.recipe.picture_alignment,language_failure_audit:x.recipe.language_audit};}
    artifacts.push(copied);source_windows.push(carriedWindow);
  }
  await recheck(x);
  const report={schema:'crime_footage_source_carry_forward_report_v1',recipe:x.recipeRef,from_identity:x.recipe.from_identity,to_identity_sha256:x.ctx.identity_sha256,from_stage:x.recipe.from_source_stage,rows,source_windows,new_acquisition:false,network_bytes:0,new_provider_spend_usd:0,historical_source_cost_usd:x.stages.source_assets.cost_usd,elapsed_sec:(Date.now()-started)/1000,approved:false,production_eligible:false,publish_allowed:false};
  const reportPath=path.join(x.ctx.outputDir,'source-carry-forward-report.json');await write(reportPath,report);artifacts.push({id:'source-carry-forward-report',...await crimeFootageFileRef(reportPath),kind:'carry_forward_receipt',source_ids:['V01','V02','V03']});
  return {artifacts,metadata:{source_windows,carried_from:{identity:x.recipe.from_identity,stage:x.recipe.from_source_stage},carry_forward_report:await crimeFootageFileRef(reportPath),source_audio_repair:rows.find(r=>r.audio_from),new_acquisition:false,network_bytes:0,human_listening_approval:false,production_eligible:false,publish_allowed:false},cost_usd:0};
}

export async function carryForwardCrimeFootageNarration(args) {
  const x=await inspect({...args,stage:'narration'}),started=Date.now();
  await write(path.join(x.ctx.outputDir,'carry-forward-start.json'),{stage:'narration',recipe:x.recipeRef,helper:x.helper,from_identity:x.recipe.from_identity,to_identity_sha256:x.ctx.identity_sha256,started_at:new Date().toISOString(),new_generation:false,automatic_retry_allowed:false});
  const original=x.stages.narration;need(original.metadata.source_text_sha256===x.ctx.identity.script.sha256&&original.metadata.tempo===1,'original narrator text or tempo differs');
  need(equal(original.metadata.units.map(u=>u.id),x.ctx.plan.narration_units.map(u=>u.id)),'original narrator units differ');
  const artifacts=[];for(const a of original.artifacts)artifacts.push(await copyArtifact(a,x.ctx.outputDir));
  need(artifacts.filter(a=>a.kind==='narration_unit').length===3&&artifacts.some(a=>a.kind==='provider_receipt')&&artifacts.some(a=>a.kind==='delivery_qa'),'complete three raw units with actual provider and QA receipts required');
  await recheck(x);
  const report={schema:'crime_footage_narration_carry_forward_report_v1',recipe:x.recipeRef,from_identity:x.recipe.from_identity,to_identity_sha256:x.ctx.identity_sha256,from_stage:x.recipe.from_narration_stage,original_generation_identity:x.recipe.from_identity,copied_artifacts:artifacts.map((a,i)=>({id:a.id,original:original.artifacts[i],copied:a,exact_file_hash_preserved:true})),new_generation:false,provider_calls:0,new_provider_spend_usd:0,all_raw_narrator_samples_preserved:true,inherited_technical_qa:original.metadata.technical_qa,human_listening_performed:false,elapsed_sec:(Date.now()-started)/1000,approved:false,production_eligible:false,publish_allowed:false};
  const reportPath=path.join(x.ctx.outputDir,'narration-carry-forward-report.json');await write(reportPath,report);artifacts.push({id:'narration-carry-forward-report',...await crimeFootageFileRef(reportPath),kind:'carry_forward_receipt',source_ids:[]});
  return {artifacts,metadata:{...original.metadata,carried_from:{identity:x.recipe.from_identity,stage:x.recipe.from_narration_stage,original_generation_identity:x.recipe.from_identity},carry_forward_report:await crimeFootageFileRef(reportPath),new_generation:false,provider_calls:0,human_listening_performed:false},cost_usd:0};
}

/** Fixed synthetic integration fixture: no arbitrary source import or episode. */
export async function exerciseCrimeFootageCarryForwardFixture({outputDir}) {
  await fs.mkdir(outputDir);const hd=path.join(outputDir,'synthetic-hd-wrong-tone.mp4'),sd=path.join(outputDir,'synthetic-sd-original-tone.mp4');
  for(const[p,size,tone]of[[hd,'1280x720','880'],[sd,'256x144','440']])await exec('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i',`testsrc2=size=${size}:rate=30`,'-f','lavfi','-i',`sine=frequency=${tone}:sample_rate=48000`,'-t','2','-c:v','libx264','-preset','ultrafast','-c:a','aac',p],{maxBuffer:1024*1024,timeout:30000});
  const output=path.join(outputDir,'synthetic-corrected.mp4'),result=await muxOriginalAudio({hd,english:sd,output,expectedDuration:2});
  return {synthetic_fixture:true,...result,output:await crimeFootageFileRef(output),replaced_audio_differs:await streamHash(hd,'a')!==await streamHash(output,'a')};
}
