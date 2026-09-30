import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateCrimeFootageCarryForwardIdentity,exerciseCrimeFootageCarryForwardFixture,carryForwardCrimeFootageSources} from '../lib/crime-footage-proof-carry-forward.mjs';

const identity={schema:'goldflow_crime_footage_proof_identity_v1',channel:'crimedungeon',channel_name:'CrimeDungeon',series_slug:'test',run_slug:'test',episode:'ep_01',title:'Test',content_profile:'true_crime_proof_v1',media_workflow:'crime_footage_private_proof_v1',sources:[{id:'V03',windows:[{id:'cvs_exhibit',start_sec:155,end_sec:215}]}],narration:{voice_id:'same-owned-narrator'},proof_scope:{min_duration_sec:90,max_duration_sec:150},plan:{sha256:'1'.repeat(64)},script:{sha256:'2'.repeat(64)},production_eligible:false,publish_allowed:false};
const recipe={schema:'crime_footage_v2_carry_forward_v1',scope:'same_case_sources_windows_script_voice_no_new_generation',review_note:'Repair wrong alternate-language track using the retained original recording.',from_proof_dir:'/synthetic/revisions/proof-v1/episodes/ep_01',to_proof_dir:'/synthetic/revisions/proof-v2/episodes/ep_01',source_audio_repair:{source_id:'V03',window_id:'cvs_exhibit',hd_artifact_id:'V03_cvs_exhibit_hd',english_audio_artifact_id:'V03_cvs_exhibit_preview144'}};
assert.equal(validateCrimeFootageCarryForwardIdentity(identity,structuredClone(identity),recipe),true);
for(const mutate of [i=>i.script.sha256='3'.repeat(64),i=>i.plan.sha256='4'.repeat(64),i=>i.narration.voice_id='another-voice',i=>i.sources[0].windows[0].start_sec=154,i=>i.publish_allowed=true]){const changed=structuredClone(identity);mutate(changed);assert.throws(()=>validateCrimeFootageCarryForwardIdentity(identity,changed,recipe));}
assert.throws(()=>validateCrimeFootageCarryForwardIdentity(identity,identity,{...recipe,to_proof_dir:'/arbitrary-import'}));
assert.throws(()=>validateCrimeFootageCarryForwardIdentity(identity,identity,{...recipe,source_audio_repair:{...recipe.source_audio_repair,english_audio_artifact_id:'arbitrary-file'}}));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'crime-carry-forward-fixture-'));
await assert.rejects(()=>carryForwardCrimeFootageSources({proofDir:path.join(temp,'no-proof'),attemptToken:'not-an-attempt',recipePath:'/not-selected'}));assert.deepEqual(await fs.readdir(temp),[]);
const outputDir=path.join(temp,'media');const result=await exerciseCrimeFootageCarryForwardFixture({outputDir});assert.equal(result.synthetic_fixture,true);assert.equal(result.compressed_stream_payloads_preserved,true);assert.equal(result.replaced_audio_differs,true);assert.equal(result.trim_performed,false);assert.equal(result.retiming_performed,false);assert(Math.abs(result.video_duration_sec-2)<.1&&Math.abs(result.audio_duration_sec-2)<.1);assert.equal(result.probe.streams.find(s=>s.codec_type==='video').width,1280);
await assert.rejects(()=>exerciseCrimeFootageCarryForwardFixture({outputDir}),/EEXIST/);
console.log(JSON.stringify({passed:true,synthetic_fixture:temp,checks:['changed text/plan/voice/window refused','arbitrary proof or audio import refused','unguarded call writes nothing','HD compressed video payload preserved exactly','replacement original audio compressed payload preserved exactly','wrong tone excluded','no trimming or retiming','existing output refused']}));
