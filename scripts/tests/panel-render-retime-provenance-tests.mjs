import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {sha256File} from '../lib/file-hash.mjs';
import {panelRenderExpectedSourceHashes,finalQaMatchesLatestRender} from '../lib/panel-render-retime-provenance.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'panel-retime-status-'));
try {
 const write=async(name,value)=>{const p=path.join(root,name);await fs.writeFile(p,typeof value==='string'?value:JSON.stringify(value));return {path:p,sha256:await sha256File(p)}};
 const planRef=await write('plan.json',{}),oldTimeline=await write('old-timeline.json',{});
 const word=await write('narration_word_timing_ep_01.json',{}),bed=await write('longform_audio_bed_report_ep_01.json',{}),stitch=await write('audio_stitch_report_ep_01-narration.json',{});
 const master=await write('master.wav','TEST FIXTURE ONLY');const timeline=await write('timeline.json',{duration_sec:1.4,audio:master});const timing=await write('timing.json',{narration_audio_hash:master.sha256});const mastering=await write('mastering.json',{status:'passed',output_sha256:master.sha256});
 const bindings={panel_plan_path:planRef.path,panel_plan_sha256:planRef.sha256,timeline_sha256:oldTimeline.sha256};
 for(const [k,v] of [['word_timing',word],['audio_bed_report',bed],['stitch_report',stitch]]){bindings[k+'_path']=v.path;bindings[k+'_sha256']=v.sha256;}
 const receipt=await write('receipt.json',{schema:'goldflow_narration_retime_receipt_v1',status:'passed',bindings,outputs:{master,timeline,word_timing:timing,mastering_report:mastering}});
 const loadedPlan={identity:{episode:'ep_01'},planPath:planRef.path,plan:{timeline:{sha256:oldTimeline.sha256}},timeline:{fps:30},inputHashes:{[planRef.path]:planRef.sha256}};
 const report={audio_path:master.path,audio_stitch_report_path:stitch.path,output_duration_sec:1.4,narration_retime:{receipt_path:receipt.path,receipt_sha256:receipt.sha256}};
 const sources=await panelRenderExpectedSourceHashes({episodeDir:root,loadedPlan,report});assert.equal(sources[master.path],master.sha256);assert.equal(sources[planRef.path],planRef.sha256);
 await assert.rejects(panelRenderExpectedSourceHashes({episodeDir:root,loadedPlan,report:{...report,audio_path:'/wrong.wav'}}),/verified replacement/);
 await assert.rejects(panelRenderExpectedSourceHashes({episodeDir:root,loadedPlan,report:{...report,output_duration_sec:2}}),/duration/);
 await fs.writeFile(receipt.path,'{}');await assert.rejects(panelRenderExpectedSourceHashes({episodeDir:root,loadedPlan,report}),/receipt changed/);
 const latest={status:'passed',final_video_path:'/new.mp4',final_video_sha256:'new'};
 assert.equal(finalQaMatchesLatestRender({final_video_path:'/old.mp4',final_video_sha256:'old'},latest),false);
 assert.equal(finalQaMatchesLatestRender({final_video_path:'/new.mp4',final_video_sha256:'new'},latest),true);
 console.log('panel-render-retime-provenance-tests passed');
} finally {await fs.rm(root,{recursive:true,force:true});}
