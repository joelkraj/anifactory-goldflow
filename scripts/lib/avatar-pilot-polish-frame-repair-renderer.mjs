import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { cameraAt } from './avatar-pilot-polish-renderer.mjs';
import { place } from './avatar-pilot-style-preview-renderer.mjs';
import { parseLoudnormReport } from './avatar-pilot-program-renderer.mjs';

const exec=promisify(execFile);
const env={PATH:process.env.PATH,LANG:'C'};
const ref=async file=>({path:file,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')});
const probe=async file=>JSON.parse((await exec('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',file],{env,timeout:90000})).stdout);

/** Fixed native-graphic defect only; never regenerate accepted visual or audio inputs. */
export async function renderPolishFrameRepair({outputDir,manifest}) {
  const repair=manifest.polish_frame_repair;
  if(repair?.interval?.start_frame!==2079 || repair.interval.end_frame!==2145) throw new Error('Unsupported frame repair interval.');
  const shot=manifest.recipe.timeline.shots.find(s=>s.start_frame===2079&&s.end_frame===2145);
  if(shot?.variant!=='time_won') throw new Error('Exact route shot required.');
  const overlays=path.join(outputDir,'route-overlays');await fs.mkdir(overlays);
  const route=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="540" height="72"><rect width="540" height="72" rx="36" fill="#f2e9d8"/><text x="31" y="46" font-family="Arial, sans-serif" font-size="25" font-weight="800" fill="#56372f">AVENGERS + DEVICE</text><path d="M382 36H499m-20-16 20 16-20 16" fill="none" stroke="#56372f" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>')).png().toBuffer();
  const overlayRefs=[];
  for(let frame=2079;frame<2145;frame++) {
    const p=(frame-2079)/66,cam=cameraAt(shot,frame);
    // Transform the whole route before output clipping. The first candidate
    // clipped at scene x=1920 and only then reframed, exposing a sheared cap.
    const layer=await place(route,cam.x+(1320+110*p)*cam.scale,cam.y+853*cam.scale,cam.scale);
    const file=path.join(overlays,`${String(frame-2079+1).padStart(4,'0')}.png`);
    await sharp({create:{width:1920,height:1080,channels:4,background:'#00000000'}}).composite(layer?[layer]:[]).png().toFile(file);
    overlayRefs.push({frame,...await ref(file)});
  }
  const exact=path.join(outputDir,'sentry-90s-repaired-lossless.mp4');
  const filters="[1:v]setpts=PTS+69.3/TB[patch];[0:v][patch]overlay=eof_action=pass:repeatlast=0:format=yuv420:enable='gte(t,69.3)*lt(t,71.5)'[v]";
  await exec('ffmpeg',['-v','error','-protocol_whitelist','file','-i',repair.prior_video.path,'-framerate','30','-i',path.join(overlays,'%04d.png'),'-filter_complex',filters,'-map','[v]','-map','0:a:0','-c:v','libx264','-preset','fast','-crf','0','-pix_fmt','yuv420p','-frames:v','2700','-c:a','copy','-movflags','+faststart',exact],{env,timeout:240000,maxBuffer:2*1024*1024});
  const exactProbe=await probe(exact);
  const v=exactProbe.streams.find(s=>s.codec_type==='video');
  if(Number(v?.nb_read_frames)!==2700 || Math.abs(Number(exactProbe.format.duration)-90)>.001) throw new Error('Exact repair duration failed.');
  // A standard-profile viewing derivative. The lossless master above is what
  // the guard independently tests for all 2,634 unchanged decoded frames.
  const playback=path.join(outputDir,'sentry-90s-private-proof.mp4');
  await exec('ffmpeg',['-v','error','-protocol_whitelist','file','-i',exact,'-map','0:v:0','-map','0:a:0','-c:v','libx264','-preset','fast','-crf','14','-profile:v','high','-pix_fmt','yuv420p','-frames:v','2700','-c:a','copy','-movflags','+faststart',playback],{env,timeout:240000,maxBuffer:2*1024*1024});
  const playbackProbe=await probe(playback);
  const measured=await exec('ffmpeg',['-hide_banner','-i',playback,'-vn','-af','loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json','-f','null','-'],{env,timeout:90000});
  const loudness=parseLoudnormReport(measured.stderr);
  if(Math.abs(Number(loudness.input_i)+16)>1 || Number(loudness.input_tp)>-1.5) throw new Error('Copied audio loudness failed.');
  const frames=[];
  for(const [frame,name] of [[2079,'repair-start.png'],[2123,'24_objective_approaches_exit.png'],[2144,'repair-end.png'],[1395,'void-reveal-settled.png']]) {
    const file=path.join(outputDir,name);
    await exec('ffmpeg',['-v','error','-i',playback,'-vf',`select=eq(n\\,${frame})`,'-frames:v','1',file],{env,timeout:90000});
    frames.push({frame,...await ref(file)});
  }
  const priorQA=JSON.parse(await fs.readFile(repair.prior_qa.path,'utf8'));
  const reviewPlayback=await ref(playback);
  const report=path.join(outputDir,'render-qa.json');
  await fs.writeFile(report,JSON.stringify({schema:'goldflow_avatar_program_polish_frame_repair_render_qa_v1',width:1920,height:1080,fps:30,duration_frames:2700,captions:[],audio:priorQA.audio,loudness,probe:exactProbe,review_playback:reviewPlayback,review_playback_probe:playbackProbe,frame_repair:repair,overlays:overlayRefs,frames,scope:'66 native route-card overlays only; no other creative rendering, no audio processing',decoded_frame_integrity:'independently verified by guarded producer after this report',playback_derivative:'standard H.264 High profile CRF14; copied AAC; visually same edit, not pixel-identical lossless master',exact_program_approval_recorded:false,review_only:true},null,2),{flag:'wx'});
  return {output:await ref(exact),review_playback:reviewPlayback,technical_report:await ref(report),width:1920,height:1080,fps:30,duration_frames:2700,frames};
}
