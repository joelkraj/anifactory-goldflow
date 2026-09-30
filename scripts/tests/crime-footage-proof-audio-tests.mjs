import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {normalizeCrimeFootagePcm,inspectCrimeFootageFloatWav,measureCrimeFootageLoudness} from '../lib/crime-footage-proof-audio.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'crime-audio-levels-')),RATE=48000,exec=promisify(execFile);
const sha=x=>createHash('sha256').update(x).digest('hex');
function wav(samples){const b=Buffer.alloc(44+samples.length*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(3,20);b.writeUInt16LE(2,22);b.writeUInt32LE(RATE,24);b.writeUInt32LE(RATE*8,28);b.writeUInt16LE(8,32);b.writeUInt16LE(32,34);b.write('data',36);b.writeUInt32LE(samples.length*4,40);for(let i=0;i<samples.length;i++)b.writeFloatLE(samples[i],44+i*4);return b;}
function fixture(level,highCrest=false){const x=new Float32Array(8*RATE*2);for(let i=0;i<x.length/2;i++){const t=i/RATE,edge=Math.min(1,t/.05,(8-t)/.05),rhythm=.22+.78*Math.pow(Math.sin(2*Math.PI*2.3*t),2),harmonic=.6*Math.sin(2*Math.PI*173*t)+.25*Math.sin(2*Math.PI*346*t)+.15*Math.sin(2*Math.PI*692*t);let y=level*rhythm*harmonic*edge;if(highCrest&&t%1.9<.018)y+=.68*Math.sin(2*Math.PI*900*t)*Math.sin(Math.PI*(t%1.9)/.018);x[i*2]=y;x[i*2+1]=y;}return x;}
try{
  const cases=[['quiet',fixture(.008)],['louder',fixture(.18)],['high_crest',fixture(.024,true)]],results=[];
  for(const [name,samples]of cases){const input=path.join(dir,name+'-raw.wav'),output=path.join(dir,name+'-leveled.wav'),receipt=path.join(dir,name+'-receipt.json'),raw=wav(samples);await fs.writeFile(input,raw);const hash=sha(raw);
    const normalized=await normalizeCrimeFootagePcm({inputPath:input,outputPath:output,receiptPath:receipt,targetLufs:-18,truePeakDbtp:-2});
    assert.equal(normalized.sample_count_per_channel,samples.length/2);assert.equal(sha(await fs.readFile(input)),hash);assert.notEqual(sha(await fs.readFile(output)),hash);
    const record=JSON.parse(await fs.readFile(receipt,'utf8'));assert.equal(record.processing.tempo,1);assert.equal(record.processing.raw_waveform_preserved,false);assert.equal(record.processing.trim,false);assert.equal(record.processing.pad,false);assert.equal(record.sample_accounting.exact_count_preserved,true);assert.equal(record.review.human_listening_approval,false);
    assert.equal(normalized.status,'passed',JSON.stringify(normalized.measurements));assert.ok(Math.abs(normalized.measurements.after.integrated_lufs+18)<=1);assert.ok(normalized.measurements.after.true_peak_dbtp<=-1.85);results.push(normalized);
    await assert.rejects(normalizeCrimeFootagePcm({inputPath:input,outputPath:output,receiptPath:receipt}),/overwrite/);
  }
  assert.ok(Math.abs(results[0].measurements.before.integrated_lufs-results[1].measurements.before.integrated_lufs)>20,'Fixture needs material source-level differences');
  const after=results.map(r=>r.measurements.after.integrated_lufs);assert.ok(Math.max(...after)-Math.min(...after)<=1.1,'Measured excerpt levels should converge');
  const combined=new Float32Array(results.reduce((n,r)=>n+r.samples.length,0));let cursor=0;for(const r of results){combined.set(r.samples,cursor);cursor+=r.samples.length;}
  const mix=path.join(dir,'combined.wav');await fs.writeFile(mix,wav(combined));const master=await normalizeCrimeFootagePcm({inputPath:mix,outputPath:path.join(dir,'master.wav'),receiptPath:path.join(dir,'master.json'),targetLufs:-16,truePeakDbtp:-1.7});
  assert.equal(master.sample_count_per_channel,combined.length/2);assert.equal(master.status,'passed');const measured=await measureCrimeFootageLoudness({inputPath:master.output.path,targetLufs:-16,truePeakDbtp:-1.5});assert.ok(Math.abs(measured.integrated_lufs+16)<=1);assert.ok(measured.true_peak_dbtp<=-1.5);
  const aac=path.join(dir,'master-preview.m4a');await exec('ffmpeg',['-nostdin','-v','error','-n','-i',master.output.path,'-c:a','aac','-b:a','192k',aac],{timeout:30000});const encoded=await measureCrimeFootageLoudness({inputPath:aac,targetLufs:-16,truePeakDbtp:-1.5});assert.ok(Math.abs(encoded.integrated_lufs+16)<=1);assert.ok(encoded.true_peak_dbtp<=-1.5);
  const corrupted=wav(fixture(.1));corrupted.writeFloatLE(NaN,44);assert.throws(()=>inspectCrimeFootageFloatWav(corrupted),/Nonfinite/);
  console.log(JSON.stringify({test:'Synthetic level/crest fixtures; no case or narrator-performance claim',before_lufs:results.map(r=>r.measurements.before.integrated_lufs),after_lufs:after,master_lufs:measured.integrated_lufs,master_true_peak_dbtp:measured.true_peak_dbtp,aac_lufs:encoded.integrated_lufs,aac_true_peak_dbtp:encoded.true_peak_dbtp,exact_sample_counts_preserved:true,raw_files_unchanged:true}));
}finally{await fs.rm(dir,{recursive:true,force:true});}
