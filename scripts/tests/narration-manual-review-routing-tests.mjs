import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { narrationManualReviewStatus, narrationManualReviewAdmission } from '../lib/narration-manual-review-routing.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async (file, value) => { const bytes = JSON.stringify(value); await fs.writeFile(file, bytes); return hash(bytes); };

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-listen-route-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const p = name => path.join(dir, name), source = 'b'.repeat(64), planHash = 'c'.repeat(64);
  const planFileHash = await json(p('narration_generation_plan.json'), { plan_sha256: planHash });
  const audio = p('selected.wav'); await fs.writeFile(audio, 'exact selected audio');
  const row = { unit_id: 'one', provider: 'qwen_local', attempt: 2, audio_path: audio, audio_sha256: hash('exact selected audio'), synthesis_identity_sha256: 'd'.repeat(64) };
  const manifestPath = p('manifest.json'); const manifestHash = await json(manifestPath, { status: 'passed', provider: 'qwen_local', units: [row] });
  const blocker = { unit_id: 'one', code: 'narration_confirmed_opening_token_mismatch', severity: 'blocker' };
  const qa = { status: 'blocked', source_script_hash: source, blockers: [blocker], units: [{ unit_id: 'one', decision: { status: 'blocked', blockers: [blocker] } }] };
  const qaHash = await json(p('narration_unit_delivery_qa_ep_01.json'), qa); await json(p('qa-snapshot.json'), qa);
  const report = { status: 'blocked', source_script_hash: source, narration_generation_plan_sha256: planHash, narration_generation_plan_file_sha256: planFileHash, provider_output_manifest_path: manifestPath, provider_output_manifest_sha256: manifestHash };
  const reportHash = await json(p('narration_tts_report_ep_01.json'), report); await json(p('report-snapshot.json'), report);
  const evidence = { schema: 'goldflow_narration_delivery_manual_review_v1', status: 'approved', reviewer: 'actual_operator', reviewed_at: new Date().toISOString(), note: 'Actual listening decision for the exact selected recording.', attestation: 'all_hash_bound_blocked_narration_units_listened_end_to_end', narration_generation_plan_sha256: planHash, provider_output_manifest_sha256: manifestHash, pre_review_unit_delivery_qa_path: p('qa-snapshot.json'), pre_review_unit_delivery_qa_sha256: qaHash, pre_review_narration_report_path: p('report-snapshot.json'), pre_review_narration_report_sha256: reportHash, accepted_unit_count: 1, accepted_units: [{ ...row, decision: 'accept_first_take', reviewed_blocker_codes: [blocker.code], listen_note: 'The reviewer heard and accepted the selected recording.', audible_review: { speech_complete: true, no_skip: true, no_truncation: true, no_stutter: true, voice_identity_acceptable: true, endpoint_acceptable: true } }] };
  const evidencePath = p('narration_delivery_manual_review_ep_01.json'); await json(evidencePath, evidence);
  return { dir, p, report, source, evidence, evidencePath, args: { episodeDir: dir, episode: 'ep_01', report, sourceScriptSha256: source } };
}

test('current exact listening evidence exposes only no-synthesis finalization', async t => {
  const f = await fixture(t), s = await narrationManualReviewStatus(f.args);
  const status = { ...s, episode_dir: f.dir, current_stage: 'qwen_tts_stitch', current_stage_state: 'blocked' };
  const flags = { 'episode-dir': f.dir, manifest: f.report.provider_output_manifest_path, 'manual-review-evidence': f.evidencePath };
  assert.match(s.next_command_shape, /tts finalize-provider/);
  assert.equal(narrationManualReviewAdmission(status, 'tts', 'finalize-provider', flags).allowed, true);
  for (const extra of [{ force: 'true' }, { 'accept-asr-delivery-blockers': 'true' }]) assert.equal(narrationManualReviewAdmission(status, 'tts', 'finalize-provider', { ...flags, ...extra }).allowed, false);
  assert.equal(narrationManualReviewAdmission({ ...status, current_stage: 'voice_plan' }, 'tts', 'finalize-provider', flags).allowed, false);
  assert.equal(narrationManualReviewAdmission(status, 'tts', 'narrate', flags).applicable, false);
  assert.equal(await narrationManualReviewStatus({ ...f.args, report: { ...f.report, manual_review_evidence_sha256: hash(await fs.readFile(f.evidencePath)) } }), null);
});

test('stale source, altered selected WAV, missing decision or wrong current report cannot authorize finalization', async t => {
  for (const mode of ['source', 'wav', 'coverage', 'report', 'snapshot']) {
    const f = await fixture(t);
    if (mode === 'source') f.args.sourceScriptSha256 = 'e'.repeat(64);
    if (mode === 'wav') await fs.appendFile(f.p('selected.wav'), 'changed');
    if (mode === 'coverage') { f.evidence.accepted_units = []; f.evidence.accepted_unit_count = 0; await json(f.evidencePath, f.evidence); }
    if (mode === 'report') await fs.appendFile(f.p('narration_tts_report_ep_01.json'), ' ');
    if (mode === 'snapshot') await fs.appendFile(f.p('qa-snapshot.json'), ' ');
    await assert.rejects(narrationManualReviewStatus(f.args));
  }
});
