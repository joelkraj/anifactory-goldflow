import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Local sample-preserving timing path. Gain/dynamics processing changes waveform;
// it never changes words, source origin, source windows or playback tempo.
const exec=promisify(execFile),RATE=48000,CHANNELS=2;
const need=(ok,msg)=>{if(!ok)throw new Error(`Crime footage audio: ${msg}`);};
const sha=b=>createHash('sha256').update(b).digest('hex');
const ref=async p=>({path:p,sha256:sha(await fs.readFile(p))});
const present=async p=>Boolean(await fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;}));
const run=(args)=>exec('ffmpeg',args,{timeout:10*60*1000,maxBuffer:2*1024*1024});
function parsedMeasurement(stderr){
  const block=stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);need(block,'FFmpeg did not return loudness measurements');const data=JSON.parse(block);
  const number=key=>{const n=Number(data[key]);need(Number.isFinite(n),`Cannot normalize unavailable/nonfinite ${key}`);return n;};
  return {integrated_lufs:number('input_i'),true_peak_dbtp:number('input_tp'),loudness_range_lu:number('input_lra'),threshold_lufs:number('input_thresh'),target_offset_db:number('target_offset'),normalization_type:data.normalization_type,reported_output_lufs:Number(data.output_i),reported_output_true_peak_dbtp:Number(data.output_tp)};
}
export async function measureCrimeFootageLoudness({inputPath,targetLufs=-18,truePeakDbtp=-2,loudnessRange=7}){
  need(path.isAbsolute(inputPath??''),'Absolute local audio path required');const stat=await fs.lstat(inputPath);need(stat.isFile()&&!stat.isSymbolicLink(),'Regular local media required');
  need(Number.isFinite(targetLufs)&&targetLufs>=-24&&targetLufs<=-14&&Number.isFinite(truePeakDbtp)&&truePeakDbtp>=-4&&truePeakDbtp<=-1,'Explicit bounded loudness/peak targets required');
  const result=await run(['-nostdin','-hide_banner','-nostats','-i',inputPath,'-map','0:a:0','-vn','-af',`loudnorm=I=${targetLufs}:TP=${truePeakDbtp}:LRA=${loudnessRange}:print_format=json`,'-f','null','-']);
  return parsedMeasurement(result.stderr);
}
export function inspectCrimeFootageFloatWav(bytes){
  need(bytes.length>=44&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE','RIFF WAV required');let format=null,data=null;
  for(let cursor=12;cursor+8<=bytes.length;){const id=bytes.toString('ascii',cursor,cursor+4),size=bytes.readUInt32LE(cursor+4),start=cursor+8;need(start+size<=bytes.length,'Truncated WAV chunk');
    if(id==='fmt '){need(size>=16,'Truncated WAV format');const code=bytes.readUInt16LE(start);format={code,channels:bytes.readUInt16LE(start+2),rate:bytes.readUInt32LE(start+4),bits:bytes.readUInt16LE(start+14),subtype:code===65534&&size>=40?bytes.readUInt16LE(start+24):null};}
    if(id==='data'){need(data===null,'Duplicate WAV payload');data=bytes.subarray(start,start+size);}cursor=start+size+(size%2);
  }
  need(format&&(format.code===3||(format.code===65534&&format.subtype===3))&&format.rate===RATE&&format.channels===CHANNELS&&format.bits===32&&data?.length>0&&data.length%8===0,'Positive48kHz stereo float32 WAV required');
  const samples=new Float32Array(data.length/4);let peak=0;for(let i=0;i<samples.length;i++){samples[i]=data.readFloatLE(i*4);need(Number.isFinite(samples[i]),'Nonfinite PCM sample');peak=Math.max(peak,Math.abs(samples[i]));}
  need(peak>0,'Silent selected audio is not normalizable');return {samples,sample_count_per_channel:samples.length/CHANNELS,duration_sec:samples.length/CHANNELS/RATE,sample_rate_hz:RATE,channels:CHANNELS,peak_linear:peak};
}

/** Called within the guarded private renderer; test fixtures may use it directly.
 * Input/output are retained separately. No tempo, trimming, padding or denoising.
 */
export async function normalizeCrimeFootagePcm({inputPath,outputPath,receiptPath,targetLufs=-18,truePeakDbtp=-2,loudnessRange=7}){
  need([inputPath,outputPath,receiptPath].every(p=>path.isAbsolute(p??'')),'Explicit absolute audio/receipt paths required');need(new Set([inputPath,outputPath,receiptPath]).size===3,'Raw, processed and receipt paths must differ');
  need(!(await present(outputPath))&&!(await present(receiptPath)),'No audio-processing overwrite or automatic retry');
  const beforeRef=await ref(inputPath),raw=inspectCrimeFootageFloatWav(await fs.readFile(inputPath)),before=await measureCrimeFootageLoudness({inputPath,targetLufs,truePeakDbtp,loudnessRange});
  const gainDb=targetLufs-before.integrated_lufs;
  const excessiveCrest=before.true_peak_dbtp+gainDb>truePeakDbtp;
  // Select one technical processing path from the first measurement. Short,
  // high-crest excerpts can defeat loudnorm's dynamic target; fixed measured
  // gain plus a latency-compensated limiter avoids its changing gain envelope.
  const filter=excessiveCrest
    ? `volume=${gainDb}dB,alimiter=limit=${10**((truePeakDbtp-.2)/20)}:attack=5:release=80:level=false:latency=true,aresample=${RATE}`
    : `loudnorm=I=${targetLufs}:TP=${truePeakDbtp}:LRA=${loudnessRange}:measured_I=${before.integrated_lufs}:measured_TP=${before.true_peak_dbtp}:measured_LRA=${before.loudness_range_lu}:measured_thresh=${before.threshold_lufs}:offset=${before.target_offset_db}:linear=true:print_format=json,aresample=${RATE}`;
  const second=await run(['-nostdin','-hide_banner','-nostats','-n','-i',inputPath,'-map','0:a:0','-vn','-af',filter,'-ar',String(RATE),'-ac',String(CHANNELS),'-c:a','pcm_f32le',outputPath]);
  const appliedType=excessiveCrest?'measured_fixed_gain_with_latency_compensated_peak_limiter':parsedMeasurement(second.stderr).normalization_type,processed=inspectCrimeFootageFloatWav(await fs.readFile(outputPath));
  need(processed.sample_count_per_channel===raw.sample_count_per_channel,'Loudness processing changed sample count; retain evidence for scoped triage');
  need((await ref(inputPath)).sha256===beforeRef.sha256,'Raw audio changed during normalization');
  const after=await measureCrimeFootageLoudness({inputPath:outputPath,targetLufs,truePeakDbtp,loudnessRange}),output=await ref(outputPath);
  const loudnessOk=Math.abs(after.integrated_lufs-targetLufs)<=1,peakOk=after.true_peak_dbtp<=truePeakDbtp+.15;
  const receipt={schema:'crime_footage_proof_loudness_receipt_v1',status:loudnessOk&&peakOk?'passed':'needs_review',input:beforeRef,output,target:{integrated_lufs:targetLufs,true_peak_dbtp:truePeakDbtp,loudness_range_lu:loudnessRange},before,after,processing:{method:excessiveCrest?'measured_r128_gain_and_peak_limiter_two_pass':'measured_ffmpeg_loudnorm_two_pass',requested_linear:!excessiveCrest,actual_normalization_type:appliedType,measured_gain_db:gainDb,excessive_crest:excessiveCrest,normalization_input:beforeRef,filter,resample_output_hz:RATE,tempo:1,denoise:false,trim:false,pad:false,raw_waveform_preserved:false,raw_input_file_preserved:true,source_origin_unchanged:true},sample_accounting:{input_samples_per_channel:raw.sample_count_per_channel,output_samples_per_channel:processed.sample_count_per_channel,sample_rate_hz:RATE,channels:CHANNELS,duration_sec:raw.duration_sec,exact_count_preserved:true},review:{loudness_within_one_lu:loudnessOk,true_peak_within_tolerance:peakOk,human_listening_approval:false},production_eligible:false,publish_allowed:false};
  await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return {samples:processed.samples,output,receipt:await ref(receiptPath),measurements:{before,after},sample_count_per_channel:processed.sample_count_per_channel,status:receipt.status};
}
