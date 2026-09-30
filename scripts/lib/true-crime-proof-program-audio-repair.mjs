import {createHash} from 'node:crypto';
import {inspectTrueCrimeProofWav} from './true-crime-proof-narration.mjs';

const RATE=24000;
const need=(value,message)=>{if(!value)throw new Error(`Proof program PCM: ${message}`);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function samples(seconds,label){
  need(typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0&&seconds<=150,`invalid ${label}`);
  const exact=seconds*RATE,rounded=Math.round(exact);
  need(Math.abs(exact-rounded)<1e-5,`${label} must fall on an exact 24 kHz sample`);return rounded;
}
function wav(data){
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(data.length+36,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);
  h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(RATE,24);h.writeUInt32LE(RATE*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(data.length,40);return Buffer.concat([h,data]);
}

/** Pure sample-exact placement of the complete source PCM and already authored
 * holds. No resampling, tempo/gain change, model execution, file I/O or approval. */
export function buildProgramPcm({sourceWavBytes,timeline}){
  need(Buffer.isBuffer(sourceWavBytes),'source WAV bytes required');
  const source=inspectTrueCrimeProofWav(sourceWavBytes);
  need(timeline?.schema==='goldflow_true_crime_proof_timeline_v1'&&timeline.fps===30&&timeline.narration_tempo===1,'exact proof timeline and unchanged tempo required');
  need(Number.isSafeInteger(timeline.duration_frames)&&timeline.duration_frames>0&&timeline.duration_frames<=4500,'bounded program frames required');
  const total=timeline.duration_frames*(RATE/timeline.fps);
  need(samples(timeline.duration_sec,'program duration')===total,'program duration differs from frame count');
  need(samples(timeline.source_duration_sec,'source duration')===source.sample_count,'timeline source duration differs from actual WAV');
  need(Array.isArray(timeline.scenes)&&timeline.scenes.length>0&&timeline.scenes.length<=50,'bounded ordered scenes required');
  const data=Buffer.alloc(total*2),scenes=[],copied=[],sceneIds=new Set(),unitIds=new Set();
  let sourceCursor=0,programCursor=0,holds=0;
  for(const scene of timeline.scenes){
    need(typeof scene.id==='string'&&scene.id.length>0&&!sceneIds.has(scene.id),'unique scene IDs required');sceneIds.add(scene.id);
    need(Array.isArray(scene.narration_unit_ids)&&scene.narration_unit_ids.length>0,'scene must name its narration units');
    for(const id of scene.narration_unit_ids){need(typeof id==='string'&&id.length>0&&!unitIds.has(id),'narration unit assigned more than once');unitIds.add(id);}
    const start=samples(scene.source_in_sec,'source in'),end=samples(scene.source_out_sec,'source out');
    const before=samples(scene.hold_before_sec,'hold before'),after=samples(scene.hold_after_sec,'hold after');
    need(before<=6*RATE&&after<=6*RATE,'individual authored hold exceeds six seconds');
    const sceneStart=samples(scene.start_sec,'scene start'),sceneEnd=samples(scene.end_sec,'scene end'),at=samples(scene.narration_start_sec,'narration start');
    need(start===sourceCursor&&end>start&&end<=source.sample_count,'source coverage must be contiguous, complete and in order');
    need(sceneStart===programCursor&&at===sceneStart+before&&sceneEnd===at+end-start+after,'scene offsets disagree with its source slice or authored holds');
    need(samples(scene.duration_sec,'scene duration')===sceneEnd-sceneStart&&sceneEnd<=total,'invalid scene duration or program overrun');
    const slice=source.data.subarray(start*2,end*2);slice.copy(data,at*2);copied.push(data.subarray(at*2,(at+end-start)*2));
    need(copied.at(-1).equals(slice),'source bytes changed during placement');
    scenes.push({scene_id:scene.id,narration_unit_ids:[...scene.narration_unit_ids],source_start_sample:start,source_end_sample:end,program_start_sample:at,program_end_sample:at+end-start,hold_before_samples:before,hold_after_samples:after});
    sourceCursor=end;programCursor=sceneEnd;holds+=before+after;
  }
  const authored=samples(timeline.authored_duration_sec,'authored duration'),padding=samples(timeline.rounding_silence_sec,'frame padding');
  need(sourceCursor===source.sample_count,'final source samples were omitted');
  need(programCursor===authored&&holds===samples(timeline.authored_holds_sec,'authored holds')&&holds<=35*RATE,'authored duration or hold accounting differs');
  need(total-programCursor===padding&&padding<RATE/timeline.fps&&total===sourceCursor+holds+padding,'sample accounting or final frame padding differs');
  const recovered=Buffer.concat(copied);need(recovered.equals(source.data),'whole ordered source PCM was not preserved exactly');
  const bytes=wav(data);need(inspectTrueCrimeProofWav(bytes).sample_count===total,'final WAV sample count differs');
  return {bytes,report:{schema:'goldflow_true_crime_program_pcm_repair_v1',status:'passed',sample_rate_hz:RATE,channels:1,pcm_bits:16,
    source_sample_count:source.sample_count,program_sample_count:total,duration_sec:total/RATE,authored_hold_samples:holds,rounding_silence_samples:padding,
    source_wav_sha256:hash(sourceWavBytes),source_pcm_sha256:hash(source.data),reconstructed_source_pcm_sha256:hash(recovered),output_wav_sha256:hash(bytes),
    scenes,whole_narration_preserved:true,each_source_sample_copied_once:true,tempo:1,resampling:false,gain_processing:false,human_listening_performed:false,approval:null}};
}
