import { retainedBaselineSource } from './retained-baseline-source.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256File } from './file-hash.mjs';
import { falRestartBaselineState } from './fal-visual-restart.mjs';
import { assertRestartBaselineIdentity, nonvisualIdentityBinding, objectHash } from './openart-visual-restart.mjs';

const need = (value, message) => { if (!value) throw new Error(`Panel production timing: ${message}`); };

/** Retain approved timing bytes only through the supported, verified early Fal fork. */
export async function verifyPanelProductionTimingIdentity({ episodeDir, identity, currentIdentitySha256, timing, timingPath, timingSha256 }) {
  if (identity.image_provider !== 'fal_ai') {
    need(timing.run_identity_sha256 === currentIdentitySha256, 'official word timing identity is stale');
    return { source_hashes: {} };
  }
  const binding = identity.visual_restart;
  need(binding?.provider === 'fal_ai' && binding.fork_at === 'visual_reference_plan', 'supported early Fal carryforward required');
  const state = await falRestartBaselineState({ episodeDir, identity });
  need(state?.done, `Fal carryforward is stale: ${state?.evidence ?? 'missing'}`);
  const receipt = JSON.parse(await fs.readFile(binding.receipt_path, 'utf8'));
  const baselineIdentityPath = path.join(binding.baseline_episode_dir, 'run_identity.json');
  const retainedIdentity = await retainedBaselineSource(identity, baselineIdentityPath, binding.baseline_identity_sha256);
  const baseline = JSON.parse(await fs.readFile(retainedIdentity, 'utf8'));
  assertRestartBaselineIdentity(baseline);
  need(objectHash(nonvisualIdentityBinding(identity)) === objectHash(nonvisualIdentityBinding(baseline)), 'nonvisual contract changed');
  need(timing.run_identity_sha256 === binding.baseline_identity_sha256, 'timing does not bind the approved baseline identity');
  const snapshotPath = path.join(episodeDir, 'baseline_status_snapshot.json');
  need(await sha256File(snapshotPath) === receipt.baseline_status_sha256, 'baseline status snapshot is stale');
  const relative = `narration_word_timing_${identity.episode}.json`;
  const carried = (receipt.files ?? []).filter(row => row.relative_path === relative);
  need(carried.length === 1 && path.resolve(timingPath) === path.join(episodeDir, relative)
    && carried[0].sha256 === timingSha256 && await sha256File(timingPath) === timingSha256,
  'timing is not the exact approved carryforward');
  return { source_hashes: {
    [binding.receipt_path]: binding.receipt_sha256,
    [baselineIdentityPath]: binding.baseline_identity_sha256,
    [snapshotPath]: receipt.baseline_status_sha256,
    [carried[0].source_path]: carried[0].sha256,
  } };
}
