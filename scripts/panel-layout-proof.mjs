#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPanelLayoutProof, writePanelLayoutReview, renderPanelLayoutProof } from './lib/panel-layout-renderer.mjs';

export function parsePanelProofArgs(args) {
  const [action, ...parts] = args;
  if (!['validate', 'review', 'render'].includes(action)) throw new Error('Usage: node scripts/panel-layout-proof.mjs validate|review|render --manifest <timeline.json> [--output-dir <new-directory>] [--allow-dirty-worktree true --dirty-reason <reason>]');
  const flags = {};
  const allowed = new Set(['manifest', 'output-dir', 'allow-dirty-worktree', 'dirty-reason']);
  for (let i = 0; i < parts.length; i += 2) {
    const key = parts[i]?.startsWith('--') ? parts[i].slice(2) : '';
    if (!allowed.has(key) || flags[key] !== undefined || !parts[i + 1] || parts[i + 1].startsWith('--')) throw new Error(`Invalid, duplicate or missing-value panel proof flag: ${parts[i]}`);
    flags[key] = parts[i + 1];
  }
  if (!flags.manifest) throw new Error('--manifest is required');
  if (action !== 'validate' && !flags['output-dir']) throw new Error('--output-dir is required and must name a new proof directory');
  if (flags['allow-dirty-worktree'] && !['true', 'false'].includes(flags['allow-dirty-worktree'])) throw new Error('--allow-dirty-worktree must be true or false');
  return { action, manifestPath: path.resolve(flags.manifest), outputDir: flags['output-dir'] ? path.resolve(flags['output-dir']) : undefined, allowDirtyWorktree: flags['allow-dirty-worktree'] === 'true', dirtyReason: flags['dirty-reason'] ?? '' };
}

export async function runPanelProofCli(args) {
  const options = parsePanelProofArgs(args);
  let result;
  if (options.action === 'validate') result = await inspectPanelLayoutProof(options);
  else if (options.action === 'review') result = await writePanelLayoutReview(options);
  else result = await renderPanelLayoutProof({ ...options, onProgress: progress => process.stderr.write(`Panel proof: ${progress.frame}/${progress.total_frames} frames (${progress.elapsed_sec.toFixed(1)}s)\n`) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPanelProofCli(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
