import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './file-hash.mjs';
import { narrationRenderMasterReuseDecision } from './narration-mastering.mjs';

const need = (ok, message) => { if (!ok) throw new Error(`Panel audio revision: ${message}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lexical = text => String(text).toLowerCase().replace(/[^a-z0-9]/g, '');

// Read the actual PCM, rather than trusting a preservation claim in a receipt.
export function readRevisionPcm(bytes) {
  need(bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE', 'PCM RIFF/WAVE required');
  let format, data;
  for (let cursor = 12; cursor + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(cursor + 4), end = cursor + 8 + size;
    need(end <= bytes.length, 'truncated WAV chunk');
    const id = bytes.toString('ascii', cursor, cursor + 4);
    if (id === 'fmt ') {
      need(!format && size >= 16, 'one complete WAV format required');
      format = { codec: bytes.readUInt16LE(cursor + 8), channels: bytes.readUInt16LE(cursor + 10), rate: bytes.readUInt32LE(cursor + 12), bits: bytes.readUInt16LE(cursor + 22) };
    }
    if (id === 'data') { need(!data, 'one PCM data chunk required'); data = bytes.subarray(cursor + 8, end); }
    cursor = end + size % 2;
  }
  need(format?.codec === 1 && format.channels === 1 && format.rate === 24000 && format.bits === 16 && data?.length > 0 && data.length % 2 === 0, '24kHz mono signed 16-bit PCM required');
  return data;
}

export function verifyExactUnitPcm({ original, revised, replacement, startSample, sampleCount }) {
  need(Number.isSafeInteger(startSample) && startSample >= 0 && Number.isSafeInteger(sampleCount) && sampleCount > 0, 'exact integer sample scope required');
  const begin = startSample * 2, end = begin + sampleCount * 2;
  need(original.length === revised.length && end <= original.length && replacement.length === sampleCount * 2, 'replacement must preserve exact full-stream and unit duration');
  need(original.subarray(0, begin).equals(revised.subarray(0, begin)) && original.subarray(end).equals(revised.subarray(end)), 'PCM outside the accepted unit changed');
  need(replacement.equals(revised.subarray(begin, end)), 'replacement PCM differs from the listened take');
}

/** A separate, explicit promotion of one listened same-text proof take. Does not
 * rewrite the passed upstream narration, its execution cohort or its approvals.
 * All original production inputs must already have passed their normal loader.
 */
export async function loadPanelAudioRevision({ loaded, requestPath }) {
  const hashes = {}, dir = loaded.episodeDir;
  const bind = async ref => {
    need(ref && path.isAbsolute(ref.path) && /^[a-f0-9]{64}$/.test(ref.sha256), 'absolute hash-bound evidence required');
    const file = await fs.realpath(ref.path);
    need(await sha256File(file) === ref.sha256, `stale evidence ${file}`);
    hashes[file] = ref.sha256;
    return file;
  };
  const artifact = async ref => JSON.parse(await fs.readFile(await bind(ref), 'utf8'));
  const absolute = await fs.realpath(requestPath);
  need(absolute === path.join(dir, `panel_audio_revision_request_${loaded.identity.episode}.json`), 'revision must be registered on this episode');
  const requestRef = { path: absolute, sha256: await sha256File(absolute) };
  const request = await artifact(requestRef);
  need(request.schema === 'goldflow_panel_exact_unit_audio_revision_v1' && request.intent === 'promote_listened_same_text_take' && request.reviewer && request.reason?.length >= 20, 'explicit reviewed exact-unit promotion required');
  need(same(request.run_identity, loaded.timeline.run_identity) && same(request.original_audio, loaded.audio), 'original identity/audio binding changed');
  need(loaded.inputHashes[request.source_timing?.path] === request.source_timing?.sha256, 'timing must be the current accepted production source');
  const originalTiming = await artifact(request.source_timing);
  const stitch = await artifact(request.original_stitch);
  need(stitch.status === 'passed' && stitch.source_script_hash === originalTiming.source_script_hash && stitch.output_sha256 === originalTiming.narration_audio_hash, 'original stitch is not the accepted narration');
  need(request.original_raw.path === stitch.raw_output_path && request.original_raw.sha256 === stitch.raw_output_sha256, 'original raw stream binding differs');
  const matches = stitch.segments.filter(row => row.unit_id === request.unit_id);
  need(matches.length === 1, 'exact original unit required');
  const unit = matches[0], originalIdentity = unit.synthesis_identity;
  const originalUnitPcm = readRevisionPcm(await fs.readFile(await bind({ path: unit.raw_audio_path, sha256: unit.raw_audio_sha256 })));
  const original = readRevisionPcm(await fs.readFile(await bind(request.original_raw)));
  const revised = readRevisionPcm(await fs.readFile(await bind(request.revised_raw)));
  const replacement = readRevisionPcm(await fs.readFile(await bind(request.replacement)));
  verifyExactUnitPcm({ original, revised, replacement, startSample: request.start_sample, sampleCount: request.sample_count });
  // Locate the unit from the real prepared inputs and retained gaps, not an
  // operator-supplied time or a matching waveform elsewhere in the narration.
  let cursor = 0, located = false;
  for (const [index, row] of stitch.segments.entries()) {
    await bind({ path: row.raw_audio_path, sha256: row.raw_audio_sha256 });
    const pcm = readRevisionPcm(await fs.readFile(await bind({ path: row.prepared_audio_path, sha256: row.prepared_audio_sha256 })));
    if (row.unit_id === request.unit_id) {
      need(cursor === request.start_sample && pcm.length === request.sample_count * 2 && pcm.equals(originalUnitPcm) && pcm.equals(original.subarray(cursor * 2, cursor * 2 + pcm.length)), 'unit position/preparation differs from the exact raw replacement scope');
      located = true;
    }
    cursor += pcm.length / 2;
    if (index < stitch.boundaries.length) {
      const gap = stitch.boundaries[index].gap_sample_count;
      need(Number.isSafeInteger(gap) && gap >= 0, 'invalid original stitch gap'); cursor += gap;
    }
  }
  need(located && cursor * 2 === original.length, 'stitch sample accounting changed');
  const execution = await artifact(request.execution), acceptance = await artifact(request.listening);
  need(execution.schema === 'goldflow_private_proof_qwen_narration_run_v1' && execution.status === 'passed' && execution.unit_count === 1 && execution.units?.length === 1, 'one retained successful local Qwen proof execution required');
  const take = execution.units[0];
  need(take.unit_id === unit.unit_id && take.spoken_text === unit.text && take.source_text === unit.text && take.output_path === request.replacement.path && take.output_sha256 === request.replacement.sha256 && take.token_limit_reached === false && take.waveform_metrics?.clipping_sample_count === 0, 'replacement text, scope, waveform or output changed');
  for (const [key, originalKey] of [['model_id', 'model_id'], ['revision', 'model_revision'], ['model_weights_sha256', 'model_weights_sha256'], ['model_config_sha256', 'model_config_sha256']]) need(execution.model?.[key] === originalIdentity?.[originalKey], `replacement ${key} changed`);
  need(execution.reference_audio_sha256 === originalIdentity.reference_audio_sha256 && execution.reference_text_sha256 === originalIdentity.reference_text_sha256 && execution.runtime?.mlx_audio === originalIdentity.mlx_audio_version, 'replacement reference/runtime changed');
  need(acceptance.status === 'accepted' && acceptance.reviewer_kind === 'human' && acceptance.reviewer && acceptance.operator_quote && acceptance.unit_id === unit.unit_id && acceptance.audio_sha256 === request.replacement.sha256 && acceptance.candidate_run_sha256 === request.execution.sha256, 'actual exact-take human listening acceptance required');
  const defect = await artifact(request.defect);
  need(defect.reviewer_kind === 'human' && defect.operator_quote && defect.unit_id === unit.unit_id && defect.source_audio_sha256 === unit.raw_audio_sha256 && defect.intended_unit_text === unit.text, 'retained exact-unit operator defect report required');
  const voice = await artifact(request.voice_qa);
  need(voice.status === 'passed' && !(voice.blockers ?? []).length && voice.voice_sha256 === unit.voice_sha256 && voice.units?.length === 1 && voice.units[0].audio_sha256 === request.replacement.sha256 && voice.units[0].status === 'passed', 'same-voice continuity QA required');
  await bind({ path: voice.report_path, sha256: voice.report_sha256 });
  const asr = await artifact(request.asr);
  const candidateRows = asr.rows?.filter(row => row.source === 'candidate');
  need(candidateRows?.length >= 2 && new Set(candidateRows.map(row => row.model)).size >= 2 && candidateRows.every(row => row.audio_sha256 === request.replacement.sha256 && row.words?.length), 'two-model exact-take ASR evidence required');
  const localAsr = candidateRows.find(row => row.model === request.timing_model);
  const patches = request.word_patches;
  need(localAsr && Array.isArray(patches) && patches.length > 0 && patches.length === localAsr.words.length, 'exact ASR-aligned local word patch required');
  const startSec = request.start_sample / 24000, endSec = (request.start_sample + request.sample_count) / 24000;
  const selectedIndices = originalTiming.words.filter(word => word.start_sec >= startSec && word.end_sec <= endSec).map(word => word.index);
  need(same(patches.map(row => row.index), selectedIndices), 'word patch must cover only and all original words within the unit');
  const words = structuredClone(originalTiming.words);
  for (const [position, patch] of patches.entries()) {
    const old = words[patch.index], recognized = localAsr.words[position];
    need(old && old.word === patch.word && old.start_sec === patch.before.start_sec && old.end_sec === patch.before.end_sec && lexical(old.word) === lexical(recognized.word), 'approved word or original anchor changed');
    need(Math.abs(patch.after.start_sec - (recognized.start_sec + startSec)) < 1e-6 && Math.abs(patch.after.end_sec - (recognized.end_sec + startSec)) < 1e-6, 'new anchors differ from retained local ASR');
    need(patch.after.start_sec >= startSec && patch.after.end_sec <= endSec && patch.after.end_sec >= patch.after.start_sec, 'new word outside exact unit');
    words[patch.index] = { ...old, start_sec: patch.after.start_sec, end_sec: patch.after.end_sec };
  }
  for (let index = 1; index < words.length; index++) need(words[index].start_sec >= words[index - 1].start_sec, 'revised word order changed');
  const timeline = structuredClone(loaded.timeline), beats = structuredClone(loaded.beats);
  const boundaryIds = new Set();
  for (const patch of request.boundary_patches ?? []) {
    const index = timeline.scenes.findIndex(scene => scene.id === patch.following_scene_id);
    need(index > 0 && !boundaryIds.has(index), 'unique internal boundary required'); boundaryIds.add(index);
    const previous = timeline.scenes[index - 1], following = timeline.scenes[index], wordIndex = beats[index].source_word_start_index;
    need(previous.id === patch.previous_scene_id && previous.end_sec === patch.before_sec && following.start_sec === patch.before_sec && selectedIndices.includes(wordIndex) && patch.after_sec === words[wordIndex].start_sec && patch.after_sec > previous.start_sec && patch.after_sec < following.end_sec, 'boundary patch is not the exact local speech cue');
    previous.end_sec = patch.after_sec; previous.layers[0].end_sec = patch.after_sec; previous.layers[0].keyframes.at(-1).at_sec = patch.after_sec;
    following.start_sec = patch.after_sec; following.layers[0].start_sec = patch.after_sec; following.layers[0].keyframes[0].at_sec = patch.after_sec;
    beats[index - 1].end_sec = patch.after_sec; beats[index].start_sec = patch.after_sec;
    timeline.panels[index - 1].metadata.source_end_sec = patch.after_sec; timeline.panels[index].metadata.source_start_sec = patch.after_sec;
  }
  // All scene boundaries must still contain their spoken word spans. No global
  // retiming or arbitrary boundary change is part of this adapter.
  for (const [index, scene] of timeline.scenes.entries()) {
    const beat = beats[index];
    if (boundaryIds.has(index) || boundaryIds.has(index + 1)) need(scene.start_sec <= words[beat.source_word_start_index].start_sec + 1e-6 && scene.end_sec >= words[beat.source_word_end_index].end_sec - 1e-6, `revised scene cuts speech: ${scene.id}`);
  }
  const mastering = await artifact(request.mastering), masterPath = await bind(request.master);
  need(mastering.input_path === request.revised_raw.path && mastering.input_sha256 === request.revised_raw.sha256 && mastering.output_path === masterPath && mastering.output_sha256 === request.master.sha256 && mastering.output_probe?.duration_sec === loaded.timeline.duration_sec && mastering.policy?.passes === 2, 'full-stream mastering lineage or duration changed');
  const masterPcm = readRevisionPcm(await fs.readFile(masterPath));
  need(masterPcm.length === original.length, 'master sample duration changed');
  const audio = { path: masterPath, sha256: request.master.sha256, offset_sec: 0 };
  const audioBedReport = { ...loaded.audioBedReport, narration_sha256: audio.sha256, final_audio_path: audio.path, final_audio_sha256: audio.sha256, exact_unit_revision: requestRef, mix: { ...loaded.audioBedReport.mix, render_input_path: audio.path, render_input_sha256: audio.sha256, wav_path: audio.path, mastering } };
  need(narrationRenderMasterReuseDecision({ audioPath: audio.path, audioSha256: audio.sha256, audioBedReport, targetLufs: -16, truePeakDbtp: -1.5, loudnessRange: 11 }).eligible, 'revised continuous master is not eligible for zero-gain reuse');
  timeline.audio = audio;
  const code = fileURLToPath(import.meta.url); hashes[code] = await sha256File(code);
  return { ...loaded, timeline, beats, words, audio, audioBedReport, wordTiming: { ...originalTiming, words, narration_audio_hash: audio.sha256, exact_unit_revision: requestRef }, audioRevision: requestRef, revisionHashes: hashes };
}
