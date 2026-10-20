#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMultizoneProof, dispatchMultizoneProof, observeMultizoneProof, prepareMultizoneZoneRepair } from './lib/panel-multizone-proof.mjs';

// Private multi-zone page proof (design docs/designs/panel_multizone_pages_v1.md).
// prepare makes no provider call; dispatch is paid and needs the exact token.
export function parseMultizoneProofArgs(args) {
  const [action, ...parts] = args, flags = {};
  if (!['prepare', 'dispatch', 'observe', 'prepare-zone-repair'].includes(action)) throw new Error('Usage: node scripts/panel-multizone-proof.mjs prepare --plan <abs> --proof-dir <abs> | dispatch --proof-dir <abs> --confirm-spend <token> [--page-ids a,b] | observe --proof-dir <abs>');
  const allowed = new Set(['plan', 'proof-dir', 'confirm-spend', 'page-ids', 'allow-dirty-worktree', 'dirty-reason', 'page-id', 'slot', 'section', 'reason', 'reviewer']);
  for (let i = 0; i < parts.length; i += 2) {
    const key = parts[i]?.startsWith('--') ? parts[i].slice(2) : '';
    if (!allowed.has(key) || flags[key] !== undefined || !parts[i + 1]) throw new Error(`Invalid or duplicate flag: ${parts[i]}`);
    flags[key] = parts[i + 1];
  }
  if (!flags['proof-dir']) throw new Error('--proof-dir is required');
  return { action, planPath: flags.plan ? path.resolve(flags.plan) : undefined, proofDir: path.resolve(flags['proof-dir']), confirmSpend: flags['confirm-spend'], pageIds: flags['page-ids']?.split(',').filter(Boolean) ?? null, allowDirtyWorktree: flags['allow-dirty-worktree'] === 'true', dirtyReason: flags['dirty-reason'] ?? '', pageId: flags['page-id'], slot: flags.slot, section: flags.section, reason: flags.reason, reviewer: flags.reviewer };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseMultizoneProofArgs(process.argv.slice(2));
  const run = { prepare: prepareMultizoneProof, dispatch: dispatchMultizoneProof, observe: observeMultizoneProof, 'prepare-zone-repair': prepareMultizoneZoneRepair }[options.action];
  run(options).then(result => {
    const { assignments, identity, ...summary } = result;
    process.stdout.write(`${JSON.stringify(identity ? { ...summary, cost_ceiling_usd: identity.cost_ceiling_usd, max_requests: identity.max_requests } : summary, null, 2)}\n`);
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
