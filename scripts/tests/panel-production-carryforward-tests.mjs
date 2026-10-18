import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyPanelProductionTimingIdentity } from '../lib/panel-production-carryforward.mjs';
import { createFalRestartIdentity } from '../lib/fal-visual-restart.mjs';
import { BASELINE_STAGES, requiredBaselineFiles } from '../lib/openart-visual-restart.mjs';
import { FAL_ENDPOINTS, FAL_PRIMARY_PARAMS } from '../lib/fal-provider.mjs';
import { mediaWorkflowForPreflight } from '../lib/media-workflows.mjs';
import { createPanelProductionContract } from '../lib/panel-production-policy.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-fal-carryforward-'));
const sha = value => createHash('sha256').update(value).digest('hex');
const write = async (file, value) => { const bytes = `${JSON.stringify(value, null, 2)}\n`; await fs.writeFile(file, bytes); return sha(bytes); };
try {
  const baselineDir = path.join(root, 'baseline'), targetDir = path.join(root, 'fal');
  await fs.mkdir(baselineDir); await fs.mkdir(targetDir);
  const baseline = { schema: 'goldflow_run_identity_v2', episode: 'ep_01', episode_dir: baselineDir,
    week: 'baseline', run_intent: 'production', content_profile: 'manhwa_recap_v1',
    ...mediaWorkflowForPreflight({ contentProfile: 'manhwa_recap_v1', mediaWorkflow: 'generated_visuals_v1' }),
    audio_target: 'narrator_only', proof_scope: { mode: 'full_episode' }, image_provider: 'codex_imagegen',
    render_profile: 'panel_composition_v1', panel_composition_contract: createPanelProductionContract(),
    generated_motion_policy: 'disabled', parallax_policy: 'disabled', narrator_voice_id: 'fixture-owned-voice' };
  const baselineHash = await write(path.join(baselineDir, 'run_identity.json'), baseline);
  const timing = { run_identity_sha256: baselineHash };
  const files = [];
  for (const name of requiredBaselineFiles('ep_01')) {
    const source = path.join(baselineDir, name), destination = path.join(targetDir, name);
    const hash = await write(source, name.startsWith('narration_word_timing_') ? timing : { fixture_only: true });
    await fs.copyFile(source, destination);
    files.push({ relative_path: name, source_path: source, sha256: hash });
  }
  const snapshotPath = path.join(targetDir, 'baseline_status_snapshot.json');
  const snapshotHash = await write(snapshotPath, { stage_ledger: ['run_identity', ...BASELINE_STAGES].map(stage => ({ stage, state: 'passed' })) });
  const bank = path.join(root, 'bank.json'), discovery = path.join(root, 'discovery.json');
  const bankHash = await write(bank, { fixture_only: true }), discoveryHash = await write(discovery, { fixture_only: true });
  const contract = { schema: 'goldflow_fal_image_contract_v1', endpoints: FAL_ENDPOINTS, primary_params: FAL_PRIMARY_PARAMS,
    normal_reference_mode: 'one_positional_collage', maximum_references: 16, automatic_creative_retry: false,
    automatic_failover: false, validation_concurrency: 8, production_concurrency: 20,
    warning_budget_usd: 30, hard_budget_usd: 35, reference_bank_manifest: bank, reference_bank_manifest_sha256: bankHash,
    discovery_receipt: discovery, discovery_receipt_sha256: discoveryHash };
  const receiptPath = path.join(targetDir, 'visual_restart_receipt.json');
  const receiptHash = await write(receiptPath, { target_episode_dir: targetDir, files, baseline_status_sha256: snapshotHash });
  const identity = createFalRestartIdentity({ baseline, targetDir, week: 'fal', contract, git: { dirty: false },
    receiptSha256: receiptHash, baselineIdentitySha256: baselineHash, createdAt: '2026-10-18T00:00:00Z', forkAt: 'visual_reference_plan' });
  const identityHash = await write(path.join(targetDir, 'run_identity.json'), identity);
  const timingPath = path.join(targetDir, 'narration_word_timing_ep_01.json');
  const timingBytes = await fs.readFile(timingPath), timingHash = sha(timingBytes);
  const args = { episodeDir: targetDir, identity, currentIdentitySha256: identityHash, timing, timingPath, timingSha256: timingHash };
  const result = await verifyPanelProductionTimingIdentity(args);
  assert.equal(result.source_hashes[receiptPath], receiptHash);
  assert.equal(result.source_hashes[snapshotPath], snapshotHash);
  assert.equal(sha(await fs.readFile(timingPath)), timingHash, 'accepted timing stays byte-identical');
  await assert.rejects(verifyPanelProductionTimingIdentity({ ...args, timing: { run_identity_sha256: 'f'.repeat(64) } }), /approved baseline identity/);
  await assert.rejects(verifyPanelProductionTimingIdentity({ ...args, identity: { ...identity, narrator_voice_id: 'different' } }), /nonvisual contract/);
  await assert.rejects(verifyPanelProductionTimingIdentity({ ...args, timingPath: path.join(baselineDir, path.basename(timingPath)) }), /exact approved carryforward/);
  const snapshotBytes = await fs.readFile(snapshotPath); await fs.appendFile(snapshotPath, '\n');
  await assert.rejects(verifyPanelProductionTimingIdentity(args), /snapshot is stale/);
  await fs.writeFile(snapshotPath, snapshotBytes);
  await fs.appendFile(timingPath, '\n'); await assert.rejects(verifyPanelProductionTimingIdentity(args), /carryforward is stale/);
  await fs.writeFile(timingPath, timingBytes);
  const receiptBytes = await fs.readFile(receiptPath); await fs.appendFile(receiptPath, '\n');
  await assert.rejects(verifyPanelProductionTimingIdentity(args), /receipt changed/);
  await fs.writeFile(receiptPath, receiptBytes);
  const sourceTimingPath = path.join(baselineDir, path.basename(timingPath));
  const sourceTimingBytes = await fs.readFile(sourceTimingPath); await fs.appendFile(sourceTimingPath, '\n');
  await assert.rejects(verifyPanelProductionTimingIdentity(args), /carryforward source changed/);
  await fs.writeFile(sourceTimingPath, sourceTimingBytes);
  const baselineIdentityPath = path.join(baselineDir, 'run_identity.json'); await fs.appendFile(baselineIdentityPath, '\n');
  await assert.rejects(verifyPanelProductionTimingIdentity(args), /baseline identity changed/);
  await verifyPanelProductionTimingIdentity({ ...args, identity: { image_provider: 'codex_imagegen' }, timing: { run_identity_sha256: identityHash } });
  await assert.rejects(verifyPanelProductionTimingIdentity({ ...args, identity: { image_provider: 'codex_imagegen' } }), /identity is stale/);
  console.log('Panel Fal carryforward: exact timing preserved; unrelated identity, changed nonvisual contract, receipt, snapshot, source and target drift rejected. No provider calls.');
} finally { await fs.rm(root, { recursive: true, force: true }); }
