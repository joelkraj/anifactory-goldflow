import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failedRenderResumeDecision } from '../lib/failed-render-resume.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goldflow-render-resume-'));
try {
  const episodeDir = path.join(root, 'ep_01');
  fs.mkdirSync(episodeDir);
  fs.mkdirSync(path.join(root, 'scripts'));
  const digest = value => createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(path.join(root, 'scripts/render.mjs'), 'tested renderer');
  const sources = ['run_identity.json', 'script_clean.md', 'visual_beat_plan.json', 'section_image_prompts_hardened.json', 'character_state_refs.json', 'imagegen_report_ep_01.json', 'image_output_qa_ep_01.json', 'narration_word_timing_ep_01.json', 'longform_audio_bed_report_ep_01.json', 'transition_edit_plan_ep_01.json', 'motion_edit_plan_ep_01.json'];
  for (const file of sources) fs.writeFileSync(path.join(episodeDir, file), '{}');
  const report = JSON.stringify({ status: 'failed', error: 'caption validation' });
  fs.writeFileSync(path.join(episodeDir, 'render_report_ep_01.json'), report);
  const triagePath = path.join(episodeDir, 'resume.json');
  const triage = { schema: 'goldflow_failed_render_resume_v1', status: 'reviewed', reviewer: 'agent', reason: 'Tested exact caption repair.', approved_creative_content_changed: false, failed_report_sha256: digest(report), renderer_sha256: digest('tested renderer'), source_hashes: Object.fromEntries(sources.map(file => [file, digest('{}')])) };
  fs.writeFileSync(triagePath, JSON.stringify(triage));
  const args = { command: 'render', subcommand: 'start', flags: { episode: 'ep_01', 'render-recovery-triage': triagePath }, status: { current_stage: 'premium_render', current_stage_state: 'blocked', episode_dir: episodeDir }, repoRoot: root };
  assert.equal(failedRenderResumeDecision(args).allowed, true);
  assert.equal(failedRenderResumeDecision({ ...args, flags: {} }).allowed, false);
  assert.equal(failedRenderResumeDecision({ ...args, command: 'tts' }).allowed, false);
  assert.equal(failedRenderResumeDecision({ ...args, status: { ...args.status, current_stage: 'image_output_qa' } }).allowed, false);
  fs.writeFileSync(path.join(episodeDir, 'script_clean.md'), 'changed script');
  assert.equal(failedRenderResumeDecision(args).allowed, false);
  fs.writeFileSync(path.join(episodeDir, 'script_clean.md'), '{}');
  fs.writeFileSync(path.join(episodeDir, 'render_report_ep_01.json'), JSON.stringify({ status: 'passed' }));
  assert.equal(failedRenderResumeDecision(args).allowed, false);
  fs.writeFileSync(path.join(episodeDir, 'render_report_ep_01.json'), report);
  fs.writeFileSync(path.join(root, 'scripts/render.mjs'), 'different renderer');
  assert.equal(failedRenderResumeDecision(args).allowed, false);
  console.log('Failed-render resume guard tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
