import path from 'node:path';
import { sha256File } from './file-hash.mjs';
import { loadNarrationRetimeForRender } from './narration-retime.mjs';
import { retainedBaselineSource } from './retained-baseline-source.mjs';

// Status verifies the same replacement receipt and resolved original bytes that
// render used; it must neither demand superseded paths nor accept arbitrary audio.
export async function panelRenderExpectedSourceHashes({ episodeDir, loadedPlan, report }) {
  if (!report.narration_retime) return loadedPlan.inputHashes;
  const pointer = report.narration_retime;
  if (await sha256File(pointer.receipt_path) !== pointer.receipt_sha256) throw new Error('Narration retime receipt changed');
  const ep = loadedPlan.identity.episode;
  const retime = await loadNarrationRetimeForRender({receiptPath:pointer.receipt_path,panelPlan:loadedPlan,
    wordTimingPath:path.join(episodeDir,`narration_word_timing_${ep}.json`),
    audioBedReportPath:path.join(episodeDir,`longform_audio_bed_report_${ep}.json`),
    audioStitchReportPath:path.join(episodeDir,`audio_stitch_report_${ep}-narration.json`)});
  if (path.resolve(report.audio_path ?? '') !== path.resolve(retime.audio.path)
    || Math.abs(Number(report.output_duration_sec)-retime.durationSec)>1/loadedPlan.timeline.fps+.001) {
    throw new Error('Render does not use the verified replacement master and duration');
  }
  const expected = {...retime.sourceHashes};
  for (const [file,hash] of Object.entries(loadedPlan.inputHashes)) {
    expected[await retainedBaselineSource(loadedPlan.identity,file,hash)] = hash;
  }
  return expected;
}

export function finalQaMatchesLatestRender(qa, latest) {
  return latest?.status === 'passed' && qa?.final_video_sha256 === latest.final_video_sha256
    && path.resolve(qa?.final_video_path ?? '') === path.resolve(latest.final_video_path ?? latest.output_path ?? '');
}
