#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { submitExactOpenArtImageBatch } from './lib/openart-cli-provider.mjs';

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    flags[name] = value && !value.startsWith('--') ? argv[++index] : 'true';
  }
  return flags;
}

export async function runExactOpenArtDispatch(flags) {
  if (!path.isAbsolute(flags.manifest || '')) throw new Error('Use an absolute --manifest path.');
  const manifest = JSON.parse(await fs.readFile(flags.manifest, 'utf8'));
  if (manifest.schema !== 'goldflow_openart_exact_cli_batch_manifest_v1') throw new Error('Unsupported exact OpenArt batch manifest.');
  const execute = flags.execute === 'true';
  if (execute && flags['confirm-spend'] !== 'exact_openart_batch') throw new Error('Paid dispatch requires --confirm-spend exact_openart_batch.');
  return submitExactOpenArtImageBatch({
    jobs: manifest.jobs,
    concurrency: Number(flags.concurrency ?? manifest.concurrency ?? 24),
    maxCreditCost: Number(manifest.max_credit_cost),
    totalCreditBudget: Number(manifest.total_credit_budget),
    execute,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runExactOpenArtDispatch(parseFlags(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
      if (error.results) process.stderr.write(`${JSON.stringify(error.results, null, 2)}\n`);
      process.exitCode = 1;
    });
}
