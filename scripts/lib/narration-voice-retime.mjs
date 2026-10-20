import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sha256File } from './file-hash.mjs';
import { loadPanelProductionPlan } from './panel-production-plan.mjs';
import { validatePanelTimeline } from './panel-layout-validation.mjs';

const exec = promisify(execFile);
const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const need = (ok, message) => { if (!ok) throw new Error(`Voice replacement: ${message}`); };

export function mapWordAnchorTime(anchors, time) {
  need(Number.isFinite(time) && time >= 0 && time <= anchors.at(-1)[0] + .001, 'time outside the original master');
  if (time >= anchors.at(-1)[0]) return anchors.at(-1)[1];
  let lo = 0, hi = anchors.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (anchors[mid][0] <= time) lo = mid; else hi = mid; }
  const [a,b] = [anchors[lo], anchors[hi]];
  return Number((a[1] + (time-a[0]) * (b[1]-a[1]) / (b[0]-a[0])).toFixed(6));
}

export function retimePictureByWordAnchors(value, anchors) {
  if (Array.isArray(value)) return value.map(x => retimePictureByWordAnchors(x, anchors));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    ['start_sec','end_sec','at_sec'].includes(key) && typeof child === 'number'
      ? mapWordAnchorTime(anchors, child) : retimePictureByWordAnchors(child, anchors)]));
}

export async function replaceReviewedNarration({ episodeDir, spec, specPath, specSha, bind }) {
  need(spec.mode === 'operator_selected_voice_replacement_v1', 'unsupported replacement mode');
  const replacement = spec.replacement;
  need(replacement?.episode_dir && replacement.episode_dir !== episodeDir, 'separate accepted narration episode required');
  const sourceDir = await fs.realpath(replacement.episode_dir);
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const checked = JSON.parse((await exec(process.execPath,[path.join(root,'bin/goldflow.mjs'),'run','status','--episode-dir',sourceDir,'--format','json'],{cwd:root,maxBuffer:32*1024*1024})).stdout);
  for (const stage of ['source_ingest','script_approval','voice_plan','qwen_tts_stitch','local_whisper_word_timing','audio_pace_check','timing_bind','longform_audio_mix']) {
    need(checked.stage_ledger?.find(row => row.stage === stage)?.state === 'passed', `replacement episode has unresolved ${stage}`);
  }
  const source = {};
  for (const key of ['identity','script','stitch','delivery_qa','word_timing','mastering_report','master','generation_plan']) {
    const row = replacement[key];
    need(row?.path?.startsWith(`${sourceDir}/`) && await sha256File(row.path) === row.sha256, `replacement ${key} missing or changed`);
    source[key] = key === 'script' || key === 'master' ? row.path : await read(row.path);
  }
  const plan = await loadPanelProductionPlan({episodeDir});
  need(source.identity.run_intent === 'production' && source.identity.audio_target === 'narrator_only' && source.identity.tts_provider === 'qwen_local', 'accepted Qwen narrator-only production identity required');
  need(source.identity.narrator_voice_id === replacement.voice_id && source.stitch.narrator_voice_id === replacement.voice_id, 'voice identity mismatch');
  need(await sha256File(path.join(episodeDir,'script_clean.md')) === replacement.script.sha256, 'approved script differs');
  need(source.stitch.status === 'passed' && source.stitch.output_sha256 === replacement.master.sha256
    && source.stitch.source_script_hash === replacement.script.sha256, 'replacement stitch is not accepted');
  need(source.delivery_qa.status === 'passed' && !(source.delivery_qa.blockers ?? []).length
    && source.delivery_qa.narration_audio_hash === replacement.master.sha256
    && source.delivery_qa.source_script_hash === replacement.script.sha256, 'replacement delivery QA is not accepted');
  need(source.word_timing.status === 'passed' && source.word_timing.narration_audio_hash === replacement.master.sha256
    && source.word_timing.narration_report_sha256 === replacement.stitch.sha256, 'replacement word timing is stale');
  need(source.mastering_report.status === 'passed' && source.mastering_report.output_sha256 === replacement.master.sha256, 'replacement mastering not accepted');
  need(source.stitch.narration_generation_plan_file_sha256 === replacement.generation_plan.sha256, 'replacement generation plan changed');
  const originalWords = await read(bind.word_timing_path);
  const {stdout} = await exec('python3', [fileURLToPath(new URL('./narration-voice-retime.py', import.meta.url)), bind.word_timing_path, replacement.word_timing.path], {maxBuffer: 16*1024*1024});
  const mapping = JSON.parse(stdout);
  const id = `${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`;
  const outDir = path.join(episodeDir,'assets/audio/narration_retime',id);
  const receiptDir = path.join(episodeDir,'reports/narration_retime',id);
  await fs.mkdir(outDir,{recursive:true}); await fs.mkdir(receiptDir,{recursive:true});
  const outputs = {};
  for (const key of ['master']) {
    const target = path.join(outDir,key === 'master' ? 'narration-mastered-replacement.wav' : 'mastering_report.json');
    await fs.copyFile(replacement[key].path,target,fs.constants.COPYFILE_EXCL);
    outputs[key] = {path:target,sha256:await sha256File(target)};
    need(outputs[key].sha256 === replacement[key].sha256, `${key} copy changed bytes`);
  }
  const masteringPath = path.join(outDir,'mastering_report.json');
  await fs.writeFile(masteringPath,json({...source.mastering_report,
    output_path:outputs.master.path, input_path:replacement.master.path,
    input_sha256:replacement.master.sha256, passthrough:true,
    reason:'hash_verified_lossless_voice_replacement_copy',
    retained_mastering_report:replacement.mastering_report}),{flag:'wx'});
  outputs.mastering_report={path:masteringPath,sha256:await sha256File(masteringPath)};
  const timeline = structuredClone(plan.timeline);
  timeline.scenes = retimePictureByWordAnchors(timeline.scenes,mapping.anchors);
  timeline.duration_sec = mapping.anchors.at(-1)[1]; timeline.audio = {...timeline.audio,...outputs.master};
  validatePanelTimeline(timeline,'production_panel_composition');
  // Original word indices are the accepted caption/beat domain. Only their
  // positions change; no old recognized spelling becomes caption text.
  const words = originalWords.words.map(w => ({...w,start_sec:mapWordAnchorTime(mapping.anchors,w.start_sec),end_sec:mapWordAnchorTime(mapping.anchors,w.end_sec)}));
  const wordTiming = {...originalWords,words,audio_duration_sec:timeline.duration_sec,narration_audio_path:outputs.master.path,narration_audio_hash:outputs.master.sha256,
    voice_replacement_timing:{source:replacement.word_timing,method:mapping.schema}};
  for (const [key,value,name] of [['timeline',timeline,'panel_timeline_retimed.json'],['word_timing',wordTiming,'narration_word_timing_retimed.json'],['word_anchor_map',mapping,'word_anchor_map.json']]) {
    const target = path.join(outDir,name);await fs.writeFile(target,json(value),{flag:'wx'});outputs[key]={path:target,sha256:await sha256File(target)};
  }
  const receipt = {schema:'goldflow_narration_retime_receipt_v1',status:'passed',mode:spec.mode,retime_id:id,episode_dir:episodeDir,
    spec_path:specPath,spec_sha256:specSha,reviewer:spec.reviewer,operator_quote:spec.operator_quote,note:spec.note,bindings:bind,outputs,
    replacement,previous_duration_sec:plan.timeline.duration_sec,retimed_duration_sec:timeline.duration_sec,
    unchanged_artwork:true,unchanged_creative_recipe:true,audio_samples_modified:false,provider_calls:0,created_at:new Date().toISOString()};
  const receiptPath=path.join(receiptDir,'receipt.json');await fs.writeFile(receiptPath,json(receipt),{flag:'wx'});
  return {status:'passed',receipt:receiptPath,retimed_duration_sec:timeline.duration_sec,voice_id:replacement.voice_id,provider_calls:0};
}
