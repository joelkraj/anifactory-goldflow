import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REQUIRED_SOURCES = [
  'run_identity.json', 'script_clean.md', 'visual_beat_plan.json',
  'section_image_prompts_hardened.json', 'character_state_refs.json',
  'imagegen_report_{episode}.json', 'image_output_qa_{episode}.json',
  'narration_word_timing_{episode}.json', 'longform_audio_bed_report_{episode}.json',
  'transition_edit_plan_{episode}.json', 'motion_edit_plan_{episode}.json',
];

function hash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function failedRenderResumeDecision({ command, subcommand, flags, status, repoRoot }) {
  if (command !== 'render' || subcommand !== 'start' || !flags['render-recovery-triage']) return { allowed: false };
  if (status.current_stage !== 'premium_render' || !['blocked', 'failed'].includes(status.current_stage_state)) return { allowed: false, reason: 'not_current_failed_render' };
  try {
    const episodeDir = path.resolve(status.episode_dir);
    const episode = String(flags.episode || path.basename(episodeDir));
    const triagePath = path.resolve(flags['render-recovery-triage']);
    if (path.dirname(triagePath) !== episodeDir) throw new Error('Recovery receipt must be episode-local.');
    const triage = JSON.parse(readFileSync(triagePath, 'utf8'));
    if (triage.schema !== 'goldflow_failed_render_resume_v1' || triage.status !== 'reviewed' || !triage.reviewer || !triage.reason || triage.approved_creative_content_changed !== false) throw new Error('Missing explicit reviewed noncreative recovery.');
    const reportPath = path.join(episodeDir, `render_report_${episode}.json`);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (report.status !== 'failed' || !report.error || hash(reportPath) !== triage.failed_report_sha256) throw new Error('Failed report no longer matches recovery receipt.');
    if (hash(path.join(repoRoot, 'scripts/render.mjs')) !== triage.renderer_sha256) throw new Error('Renderer changed after recovery review.');
    for (const pattern of REQUIRED_SOURCES) {
      const relativePath = pattern.replace('{episode}', episode);
      if (hash(path.join(episodeDir, relativePath)) !== triage.source_hashes?.[relativePath]) throw new Error(`Recovery source changed: ${relativePath}`);
    }
    return { allowed: true, reason: 'reviewed_failed_render_resume', reviewer: triage.reviewer, triage_path: triagePath };
  } catch (error) {
    return { allowed: false, reason: error.message };
  }
}
