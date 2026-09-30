import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadTrueCrimeProofIdentity, trueCrimeProofStatus, trueCrimeProofFileRef} from './lib/true-crime-proof-workflow.mjs';

const execute=promisify(execFile);
const need=(ok,message)=>{if(!ok)throw new Error(`CrimeDungeon editorial revision: ${message}`);};
const same=(a,b)=>a?.path===b?.path&&a?.sha256===b?.sha256;
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const writeJson=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const CODE_PATHS=[fileURLToPath(import.meta.url),fileURLToPath(new URL('./lib/true-crime-proof-editorial-visuals.mjs',import.meta.url)),fileURLToPath(new URL('./lib/true-crime-proof-editorial-audio.mjs',import.meta.url))];
const ASSET_IDS=['portrait_source','e01_initial','e01_cabin','e01_answer','e02_parade','chandler_cutout','detective_cutout'];
async function checked(ref){
  need(path.isAbsolute(ref?.path??'')&&/^[a-f0-9]{64}$/.test(ref?.sha256??''),'absolute source/hash binding required');
  need(same(await trueCrimeProofFileRef(ref.path),ref),`changed bound file: ${ref.path}`);
  return fs.readFile(ref.path);
}
async function probe(file){return JSON.parse((await execute('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',file],{maxBuffer:2*1024*1024})).stdout);}
const event=(dir,row)=>fs.appendFile(path.join(dir,'events.jsonl'),JSON.stringify({recorded_at:new Date().toISOString(),...row})+'\n');

/** Read-only guards for this user-requested supplemental picture/sound edit. */
export async function inspectEditorialRevisionRequest(requestPath){
  need(path.isAbsolute(requestPath??''),'absolute request path required');
  const requestRef=await trueCrimeProofFileRef(requestPath),request=JSON.parse(await checked(requestRef));
  need(request.schema==='goldflow_true_crime_editorial_revision_request_v1'&&request.scope==='reference_informed_picture_and_original_underscore'&&request.production_eligible===false&&request.publish_allowed===false,'exact private editorial revision scope required');
  const allowed=['schema','scope','proof_dir','output_dir','production_eligible','publish_allowed','authorization','source_index','source_manifest','source_pacing_report','reference_brief','spoken_cues','audio_recipe'];
  need(Object.keys(request).every(k=>allowed.includes(k)),'unexpected request field');
  need(request.authorization?.operator==='Joel'&&request.authorization.user_instruction==='lets do it'&&request.authorization.picture_and_sound_revision_authorized===true&&request.authorization.preserve_words_voice_and_duration===true,'actual latest user instruction and bounded scope required');
  need(typeof request.authorization.note==='string'&&request.authorization.note.trim()&&Number.isFinite(Date.parse(request.authorization.authorized_at)),'authorization context and date required');
  const p=request.proof_dir;
  need(path.isAbsolute(p??'')&&await fs.realpath(p)===p,'canonical existing proof directory required');
  need(request.output_dir===path.join(p,'program_review_repairs/editorial-v3'),'exact new editorial-v3 directory required');
  const identity=await loadTrueCrimeProofIdentity({proofDir:p}),status=await trueCrimeProofStatus({proofDir:p});
  need(status.state==='needs_triage'&&status.stages.find(s=>s.stage==='program_review')?.state==='needs_triage'&&status.stages.slice(0,2).every(s=>s.artifact),'retained closed original attempt and upstream candidates required');
  need(!(await fs.lstat(path.join(p,'operation.lock')).catch(e=>{if(e.code==='ENOENT')return null;throw e;})),'canonical operation still open');
  need(request.source_index?.path===path.join(p,'pacing-candidate-index-v2.json')&&request.source_pacing_report?.path===path.join(p,'program_review_repairs/pacing-v2/pacing-report.json')&&request.source_manifest?.path===path.join(p,'render-manifest-v1.json'),'exact prior candidate lineage required');
  const refs=[request.source_index,request.source_manifest,request.source_pacing_report,request.reference_brief,request.spoken_cues];
  for(const ref of refs)await checked(ref);
  const [index,manifest,pacing,cues]=await Promise.all([json(request.source_index.path),json(request.source_manifest.path),json(request.source_pacing_report.path),json(request.spoken_cues.path)]);
  need(index.identity_sha256===identity.identity_sha256&&pacing.identity_sha256===identity.identity_sha256&&index.approved===false&&index.production_eligible===false&&pacing.pacing_technical_qa==='passed','prior candidate identity or review state differs');
  need(same(index.pacing_report,request.source_pacing_report)&&same(index.candidate_video,pacing.output)&&same(index.program_pcm,pacing.program_pcm),'candidate/report media mismatch');
  need(pacing.mapping.revised_timeline.duration_frames===1932&&pacing.mapping.revised_timeline.duration_sec===64.4&&pacing.narration_tempo===1,'exact retained 64.4-second timing required');
  const narrationStageRef=await trueCrimeProofFileRef(path.join(p,'narration.json'));
  const narration=JSON.parse(await checked(narrationStageRef));
  need(same(narrationStageRef,pacing.source_narration_stage)&&narration.identity_sha256===identity.identity_sha256,'retained narrator lineage differs');
  need(manifest.provenance.editorial_plan.sha256===identity.identity.plan.sha256&&manifest.provenance.source_script.sha256===identity.identity.script.sha256,'approved editorial text differs');
  const assets=Object.fromEntries(ASSET_IDS.map(id=>{const a=manifest.provenance.source_assets.find(a=>a.id===id);need(a,`missing exact existing asset ${id}`);return[id,a];}));
  const sourceAssets=JSON.parse(await fs.readFile(path.join(p,'source_assets.json'),'utf8'));
  for(const asset of Object.values(assets)){need(sourceAssets.artifacts.some(a=>a.id===asset.id&&same(a,asset)),`asset absent from retained source stage: ${asset.id}`);await checked(asset);}
  const upstream=[pacing.output,pacing.program_pcm,pacing.source_narration,narrationStageRef,index.independent_audio_verification,...Object.values(assets)];
  for(const ref of upstream)await checked(ref);
  const originalTimeline=JSON.parse(await checked(pacing.source_timeline));
  const captions=originalTimeline.captions.map(c=>{
    const s=pacing.mapping.revised_timeline.scenes.find(s=>s.id===c.scene_id);
    return {...c,start_sec:s.narration_start_sec+c.source_start_sec-s.source_in_sec,end_sec:s.narration_start_sec+c.source_end_sec-s.source_in_sec};
  });
  const scriptText=(await checked(identity.identity.script)).toString('utf8');
  need(captions.length===28&&captions.map(c=>c.text).join(' ').replace(/\s+/g,' ').trim()===scriptText.replace(/\s+/g,' ').trim(),'exact approved caption word sequence must be preserved');
  const cueSources={delivery_qa:path.join(p,'attempts/narration/output/delivery-qa.json'),timing_mapping:path.join(p,'program_review_repairs/pacing-v2/timing-mapping.json'),narration_stitch:path.join(p,'attempts/narration/output/narration-stitch.json')};
  need(cues.sources&&Object.keys(cues.sources).length===3&&Object.entries(cueSources).every(([key,expected])=>cues.sources[key]?.path===expected),'all three retained spoken-cue source bindings required');
  for(const ref of Object.values(cues.sources))await checked(ref);
  return {request,requestRef,identity,status,index,manifest,pacing,cues,captions,scriptText,assets,narration,narrationStageRef,refs:[...refs,...upstream,pacing.source_timeline,identity.identity.script,...Object.values(cues.sources)]};
}

export async function prepareEditorialRevision({requestPath}={}){
  const context=await inspectEditorialRevisionRequest(requestPath),{request,identity}=context;
  const visual=await import('./lib/true-crime-proof-editorial-visuals.mjs');
  const audio=await import('./lib/true-crime-proof-editorial-audio.mjs');
  need(JSON.stringify(request.audio_recipe)===JSON.stringify(audio.EDITORIAL_AUDIO_RECIPE),'selected original underscore recipe differs from implementation');
  const plan=visual.buildEditorialVisualPlan({assets:context.assets,captions:context.captions,markers:context.cues.markers,scriptText:context.scriptText});
  const narrationBytes=await checked(context.pacing.program_pcm);
  const sound=audio.buildEditorialProofAudio({narrationWavBytes:narrationBytes,cues:request.audio_recipe});
  const code=await Promise.all(CODE_PATHS.map(p=>trueCrimeProofFileRef(p)));
  const parent=path.dirname(request.output_dir);need(await fs.realpath(parent)===parent,'revision parent cannot be a symlink');
  await fs.mkdir(request.output_dir,{recursive:false});
  await writeJson(path.join(request.output_dir,'request.json'),{...request,original_request:context.requestRef,identity_sha256:identity.identity_sha256,code,base_state:context.status.state,full_program_approval:false});
  await event(request.output_dir,{status:'preparing',provider_calls:0,cost_usd:0});
  try{
    await writeJson(path.join(request.output_dir,'visual-plan.json'),plan);
    const visualDir=path.join(request.output_dir,'visuals');await fs.mkdir(visualDir);
    const prepared=await visual.prepareEditorialVisuals({plan,outputDir:visualDir});
    const audioDir=path.join(request.output_dir,'audio');await fs.mkdir(audioDir);
    await fs.writeFile(path.join(audioDir,'accompaniment.wav'),sound.bedWav,{flag:'wx'});
    await fs.writeFile(path.join(audioDir,'original-underscore.wav'),sound.underscoreWav,{flag:'wx'});
    await fs.writeFile(path.join(audioDir,'reveal-accent.wav'),sound.accentWav,{flag:'wx'});
    await fs.writeFile(path.join(audioDir,'review-mix.wav'),sound.mixWav,{flag:'wx'});
    await writeJson(path.join(audioDir,'audio-recipe-report.json'),sound.receipt);
    for(const ref of [...context.refs,context.requestRef,...code])await checked(ref);
    const report={schema:'goldflow_true_crime_editorial_preparation_v1',status:'awaiting_sampled_visual_review',identity_sha256:identity.identity_sha256,original_request:context.requestRef,code,visual_plan:await trueCrimeProofFileRef(path.join(request.output_dir,'visual-plan.json')),visual_prepared:prepared,bed:await trueCrimeProofFileRef(path.join(audioDir,'accompaniment.wav')),underscore:await trueCrimeProofFileRef(path.join(audioDir,'original-underscore.wav')),accent:await trueCrimeProofFileRef(path.join(audioDir,'reveal-accent.wav')),mix:await trueCrimeProofFileRef(path.join(audioDir,'review-mix.wav')),audio_report:await trueCrimeProofFileRef(path.join(audioDir,'audio-recipe-report.json')),source_narration:context.pacing.program_pcm,narration_technical_qa:context.narration.metadata.technical_qa,narration_source_gain:1,mastering:'pending_delivery_review; source narrator level unchanged',human_listening_performed:false,production_eligible:false,publish_allowed:false};
    await writeJson(path.join(request.output_dir,'preparation-report.json'),report);
    await event(request.output_dir,{status:report.status,report:await trueCrimeProofFileRef(path.join(request.output_dir,'preparation-report.json'))});
    return report;
  }catch(error){await event(request.output_dir,{status:'needs_triage',error:error.message,automatic_retry:false});throw error;}
}

export async function renderEditorialRevision({requestPath,previewReviewPath}={}){
  const context=await inspectEditorialRevisionRequest(requestPath),dir=context.request.output_dir;
  for(const name of ['editorial-report.json','render-completed.json','render.lock'])need(!(await fs.lstat(path.join(dir,name)).catch(e=>{if(e.code==='ENOENT')return null;throw e;})),`render already dispatched or complete: ${name}`);
  const prepRef=await trueCrimeProofFileRef(path.join(dir,'preparation-report.json')),prep=JSON.parse(await checked(prepRef));
  need(prep.identity_sha256===context.identity.identity_sha256&&same(prep.original_request,context.requestRef),'preparation lineage differs');
  for(const ref of [...prep.code,prep.visual_plan,prep.bed,prep.underscore,prep.accent,prep.mix,prep.audio_report])await checked(ref);
  const reviewRef=await trueCrimeProofFileRef(previewReviewPath),review=JSON.parse(await checked(reviewRef));
  need(path.dirname(previewReviewPath)===dir&&review.schema==='goldflow_true_crime_editorial_preview_review_v1'&&same(review.preparation_report,prepRef)&&review.reviewer==='Codex'&&review.visual_checks_passed===true&&review.human_listening_performed===false&&review.full_program_approval===false,'exact technical preview review required; no human approval inferred');
  need(Array.isArray(review.inspected_frames)&&review.inspected_frames.length>=3,'at least opening, quote and date-reveal previews must be inspected');
  for(const ref of review.inspected_frames){need(prep.visual_prepared.previews.some(p=>same(p,ref)),'reviewed frame absent from prepared previews');await checked(ref);}
  await writeJson(path.join(dir,'render.lock'),{dispatched_at:new Date().toISOString(),preparation_report:prepRef,visual_review:reviewRef});
  await event(dir,{status:'rendering',preparation:prepRef,visual_review:reviewRef});
  try{
    const visual=await import('./lib/true-crime-proof-editorial-visuals.mjs');
    const result=await visual.renderPreparedEditorialVisuals({prepared:prep.visual_prepared,outputDir:path.join(dir,'picture-render')});
    const silentVideo=result.video??result.output;
    need(silentVideo?.path,'visual renderer must return its actual video reference');await checked(silentVideo);
    const outputPath=path.join(dir,'private-proof-editorial-v3.mp4');
    const args=['-v','error','-n','-i',silentVideo.path,'-i',prep.mix.path,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-ar','48000','-b:a','192k','-map_metadata','-1','-movflags','+faststart',outputPath];
    await writeJson(path.join(dir,'mux-command.json'),{executable:'ffmpeg',args});
    await execute('ffmpeg',args,{maxBuffer:3*1024*1024,timeout:180000});
    const measured=await probe(outputPath),v=measured.streams.find(s=>s.codec_type==='video'),a=measured.streams.find(s=>s.codec_type==='audio');
    need(v?.width===1920&&v.height===1080&&v.r_frame_rate==='30/1'&&Number(v.nb_read_frames)===1932&&Math.abs(Number(v.duration)-64.4)<.01,'final picture shape/duration differs');
    need(a?.codec_name==='aac'&&a.sample_rate==='48000'&&Math.abs(Number(a.duration)-64.4)<1/30,'final audio shape/duration differs');
    for(const ref of [...context.refs,context.requestRef,...prep.code,prepRef,reviewRef,prep.visual_plan,prep.bed,prep.underscore,prep.accent,prep.mix,prep.audio_report])await checked(ref);
    const finalState=await trueCrimeProofStatus({proofDir:context.request.proof_dir});need(finalState.state===context.status.state,'canonical stage state changed');
    const report={schema:'goldflow_true_crime_editorial_revision_report_v1',status:'candidate_ready_needs_review',technical_qa:'passed',identity_sha256:context.identity.identity_sha256,base_workflow_state:finalState.state,request:context.requestRef,preparation_report:prepRef,visual_review:reviewRef,visual_result:result,output:await trueCrimeProofFileRef(outputPath),bed:prep.bed,mix:prep.mix,audio_report:prep.audio_report,measured,code:prep.code,source_candidate:context.index.candidate_video,source_narration:context.pacing.program_pcm,narration_technical_qa:context.narration.metadata.technical_qa,narration_gain:1,narration_tempo:1,whole_source_narration_retained:true,source_caption_text_retained:true,mastering:prep.mastering,original_audio_composition:true,provider_calls:0,cost_usd:0,original_candidates_preserved:true,production_eligible:false,publish_allowed:false,human_listening_performed:false,full_program_viewing_approved:false,approved:false};
    await writeJson(path.join(dir,'editorial-report.json'),report);
    await event(dir,{status:report.status,output:report.output,report:await trueCrimeProofFileRef(path.join(dir,'editorial-report.json'))});
    await fs.rename(path.join(dir,'render.lock'),path.join(dir,'render-completed.json'));
    return {output:report.output,report:await trueCrimeProofFileRef(path.join(dir,'editorial-report.json')),duration_sec:64.4,status:report.status};
  }catch(error){await event(dir,{status:'needs_triage',error:error.message,automatic_retry:false});throw error;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const action=process.argv[2];need(['prepare','render'].includes(action),'use prepare <request> or render <request> <preview-review>');const result=action==='prepare'?await prepareEditorialRevision({requestPath:process.argv[3]}):await renderEditorialRevision({requestPath:process.argv[3],previewReviewPath:process.argv[4]});process.stdout.write(JSON.stringify(result,null,2)+'\n');}
  catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
