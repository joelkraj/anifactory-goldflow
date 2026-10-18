import assert from 'node:assert/strict';
import {buildProgramPcm} from '../lib/true-crime-proof-program-audio-repair.mjs';
import {inspectTrueCrimeProofWav} from '../lib/true-crime-proof-narration.mjs';

// Nonzero, distinguishable source samples prove the first/final bytes and all
// intermediate source samples survive; this is synthetic media, not speech QA.
function fixture(){
  const data=Buffer.alloc(2400*2);for(let i=0;i<2400;i++)data.writeInt16LE(i+1,i*2);
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(data.length+36,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(24000,24);h.writeUInt32LE(48000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(data.length,40);
  return {sourceWavBytes:Buffer.concat([h,data]),timeline:{schema:'goldflow_true_crime_proof_timeline_v1',fps:30,narration_tempo:1,duration_frames:6,duration_sec:.2,source_duration_sec:.1,authored_duration_sec:.18,authored_holds_sec:.08,rounding_silence_sec:.02,
    scenes:[{id:'A',narration_unit_ids:['U1'],source_in_sec:0,source_out_sec:.04,start_sec:0,narration_start_sec:.01,end_sec:.07,duration_sec:.07,hold_before_sec:.01,hold_after_sec:.02},
      {id:'B',narration_unit_ids:['U2'],source_in_sec:.04,source_out_sec:.1,start_sec:.07,narration_start_sec:.10,end_sec:.18,duration_sec:.11,hold_before_sec:.03,hold_after_sec:.02}]}};
}
const f=fixture(),original=Buffer.from(f.sourceWavBytes),timelineOriginal=JSON.stringify(f.timeline),result=buildProgramPcm(f),pcm=inspectTrueCrimeProofWav(result.bytes).data;
assert(f.sourceWavBytes.equals(original));assert.equal(JSON.stringify(f.timeline),timelineOriginal);
assert.equal(result.report.program_sample_count,4800);assert.equal(result.report.authored_hold_samples,1920);assert.equal(result.report.rounding_silence_samples,480);
assert.equal(result.report.source_pcm_sha256,result.report.reconstructed_source_pcm_sha256);
assert.equal(result.report.whole_narration_preserved,true);assert.equal(result.report.each_source_sample_copied_once,true);
const raw=inspectTrueCrimeProofWav(f.sourceWavBytes).data;
assert(pcm.subarray(240*2,1200*2).equals(raw.subarray(0,960*2)));
assert(pcm.subarray(2400*2,3840*2).equals(raw.subarray(960*2)));
for(const [start,end]of[[0,240],[1200,2400],[3840,4800]])assert(pcm.subarray(start*2,end*2).equals(Buffer.alloc((end-start)*2)),'only exact authored silence or frame padding may occupy each gap');
assert.equal(pcm.readInt16LE(240*2),1);assert.equal(pcm.readInt16LE((3840-1)*2),2400);
for(const rate of [12000,44100,48000]){const wrong=fixture();wrong.sourceWavBytes.writeUInt32LE(rate,24);assert.throws(()=>buildProgramPcm(wrong),/24 kHz/);}
for(const mutate of [
  t=>{t.scenes[1].source_in_sec=.03;},t=>{t.scenes[1].source_in_sec=.05;},t=>{t.scenes[1].source_out_sec=.09;},
  t=>{t.scenes[1].narration_start_sec=.09;},t=>{t.scenes[1].hold_before_sec=.04;},t=>{t.scenes[0].source_out_sec+=.5/24000;},
  t=>{t.rounding_silence_sec=0;},t=>{t.duration_sec=.1;},t=>{t.narration_tempo=2;},t=>{t.scenes[1].narration_unit_ids=['U1'];},
]){const wrong=fixture();mutate(wrong.timeline);assert.throws(()=>buildProgramPcm(wrong));}
console.log('Program PCM repair: exact ordered source coverage, all silence positions, final frame padding, sample-rate rejection and invalid timelines pass (synthetic fixtures only).');
