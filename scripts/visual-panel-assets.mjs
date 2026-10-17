#!/usr/bin/env node
import path from 'node:path';
import { episodeDirForFlags } from './lib/execution-provenance.mjs';
import { preparePanelAssetPlan, writePanelAssetPlan, loadPanelAssetPlan, reconcilePanelAssetAliases } from './lib/panel-production-assets.mjs';

const args = process.argv.slice(2), flags = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use explicit --flag value arguments.');
  flags[args[i].slice(2)] = args[i + 1];
}
try {
  if (!(flags['episode-dir'] || flags.channel && flags.week && flags.episode)) throw new Error('An explicit episode directory or channel/week/episode tuple is required.');
  const episodeDir = episodeDirForFlags(flags, process.env);
  let result;
  if (flags.action === 'reconcile') result = await reconcilePanelAssetAliases({ episodeDir });
  else if (flags.action === 'validate') { const loaded = await loadPanelAssetPlan({ episodeDir }); result = { status: 'passed', plan_path: loaded.planPath }; }
  else if (flags.plan) result = await writePanelAssetPlan({ episodeDir, planPath: path.resolve(flags.plan) });
  else result = await preparePanelAssetPlan({ episodeDir });
  const summary = { status: result.status ?? result.plan?.status, plan_path: result.planPath ?? result.plan_path, packet_path: result.packetPath, candidate_path: result.candidatePath, unique_asset_count: result.plan?.unique_asset_count, beat_count: result.beats?.length, reused_beat_count: result.plan?.reused_beat_count, materialized_alias_count: result.materialized_alias_count, missing_owner_image_ids: result.missing_owner_image_ids, provider_calls: 0 };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
