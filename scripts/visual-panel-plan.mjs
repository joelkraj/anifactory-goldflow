#!/usr/bin/env node
import path from 'node:path';
import { episodeDirForFlags } from './lib/execution-provenance.mjs';
import { preparePanelProductionPlan, compilePanelProductionPlan, loadPanelProductionPlan } from './lib/panel-production-plan.mjs';
import { authorPanelProduction } from './lib/panel-production-author.mjs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), flags = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use explicit --flag value arguments.');
  flags[args[i].slice(2)] = args[i + 1];
}
try {
  if (!(flags['episode-dir'] || flags.channel && flags.week && flags.episode)) throw new Error('An explicit episode directory or channel/week/episode tuple is required.');
  const episodeDir = episodeDirForFlags(flags, process.env);
  const action = flags.action ?? 'prepare';
  let result;
  if (action === 'prepare') result = await preparePanelProductionPlan({ episodeDir });
  else if (action === 'author') result = await authorPanelProduction({ episodeDir,
    repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    limit: Number(flags.limit ?? 1000), concurrency: Number(flags.concurrency ?? 8),
    onProgress: value => process.stdout.write(`${JSON.stringify(value)}\n`) });
  else if (action === 'compile') result = await compilePanelProductionPlan({ episodeDir, recipePath: flags.recipe && path.resolve(flags.recipe) });
  else if (action === 'validate') {
    const loaded = await loadPanelProductionPlan({ episodeDir });
    result = { status: 'passed', plan_path: loaded.planPath, duration_sec: loaded.timeline.duration_sec, beat_count: loaded.timeline.scenes.length };
  } else throw new Error('Supported panel-plan actions: prepare, author, compile, validate.');
  const { source_hashes, ...summary } = result;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (action === 'author' && result.status === 'needs_exact_repair') process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
