import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256File } from './file-hash.mjs';

// A visual fork owns its original source hashes. A later, explicitly archived
// narration migration on the baseline must not silently replace those bytes.
export async function retainedBaselineSource(identity, file, expected) {
  const absolute = path.resolve(file);
  if (await sha256File(absolute).catch(() => null) === expected) return absolute;
  const binding = identity?.visual_restart;
  if (binding?.provider !== 'fal_ai') throw new Error(`stale source ${absolute}`);
  const root = path.resolve(binding.baseline_episode_dir);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error(`stale source outside the retained baseline: ${absolute}`);
  if (await sha256File(binding.receipt_path).catch(() => null) === binding.receipt_sha256) {
    const receipt = JSON.parse(await fs.readFile(binding.receipt_path, 'utf8'));
    if (receipt.baseline_identity_sha256 === binding.baseline_identity_sha256
      && receipt.target_episode_dir === identity.episode_dir) {
      const row = receipt.files?.find(row => row.source_path === absolute && row.sha256 === expected);
      if (row) {
        const copy = path.resolve(identity.episode_dir, row.relative_path);
        if (copy.startsWith(`${path.resolve(identity.episode_dir)}${path.sep}`)
          && await sha256File(copy).catch(() => null) === expected) return copy;
      }
    }
  }
  const current = JSON.parse(await fs.readFile(path.join(root, 'run_identity.json'), 'utf8'));
  const relocks = [...(current.narration_identity_relock_history ?? []), current.narration_identity_relock].filter(Boolean);
  for (const relock of relocks) {
    const dir = path.resolve(relock.archive_dir ?? '');
    if (!dir.startsWith(`${root}/reports/recovery/`)) continue;
    const reportPath = path.join(dir, 'tts_identity_relock_report.json');
    const report = await fs.readFile(reportPath, 'utf8').then(JSON.parse).catch(() => null);
    if (report?.schema !== 'goldflow_tts_identity_relock_report_v1' || report.status !== 'passed'
      || report.episode_dir !== root || report.run_identity_before_sha256 !== relock.previous_run_identity_sha256) continue;
    if (await sha256File(path.join(dir, 'artifacts/run_identity.json')).catch(() => null) !== report.run_identity_before_sha256) continue;
    const rows = [...(report.archived_artifacts ?? []), ...(report.retained_historical_audio_assets ?? [])];
    for (const row of rows) {
      // Identical retained master bytes may satisfy a lossless audio-bed alias.
      const audioAlias = absolute.startsWith(`${root}/assets/audio/`) && row.path?.startsWith(`${root}/assets/audio/`);
      if ((row.path !== absolute && !audioAlias) || row.sha256 !== expected) continue;
      const archived = path.resolve(row.archived_path ?? '');
      if (!archived.startsWith(`${dir}${path.sep}`)) continue;
      if (await sha256File(archived).catch(() => null) === expected) return archived;
    }
  }
  throw new Error(`No hash-verified narration recovery archive for ${absolute}`);
}
