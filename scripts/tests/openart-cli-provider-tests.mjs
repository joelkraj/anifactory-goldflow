import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildExactOpenArtImageRequest, discoverOpenArtContract, generateOpenArtImage,
  sanitizeOpenArtEvidence, uploadOpenArtAsset, createOpenArtProject,
  downloadOpenArtCreation, quoteExactOpenArtImageBatch, submitExactOpenArtImageBatch,
} from '../lib/openart-cli-provider.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'goldflow-openart-test-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const calls = [];
const properties = {
  prompt: { type: 'string' }, imageCount: { type: 'integer', default: 1 }, aspectRatio: { enum: ['4:3', '16:9'], default: '4:3' },
  resolutionTier: { enum: ['1k', '2k'], default: '2k' }, quality: { enum: ['low', 'medium'], default: 'medium' },
  outputFormat: { enum: ['png'], default: 'png' }, lockAspectRatio: { type: 'boolean', default: true }, autoEnhancePrompt: { type: 'boolean', default: false },
  visualReferences: { maxItems: 16 },
};
const discoveryCli = async (args) => {
  calls.push(args);
  if (args[0] === 'version') return { version: '0.1.1' };
  if (args[1] === 'form') return { jsonSchema: { properties } };
  if (args[1] === 'cost') return { items: [{ model: 'gpt-image-2-5-sunburst', mode: args[5], config: { imageCount: 1, aspectRatio: '4:3', quality: 'medium', resolutionTier: '2k' }, totalCredits: 40 }] };
  throw new Error('Unexpected mutating CLI call');
};
try {
  const contract = await discoverOpenArtContract({ runCli: discoveryCli });
  assert.equal(contract.schema_valid, true);
  assert.equal(contract.dispatch_supported, false);
  assert.equal(contract.configured_credits, null);
  assert.deepEqual(contract.default_mismatches.sort(), ['aspectRatio', 'quality', 'resolutionTier']);
  await assert.rejects(generateOpenArtImage({ references: [], runCli: discoveryCli }), { code: 'openart_cli_settings_unsupported' });
  assert(calls.every((args) => ['version', 'model'].includes(args[0])));

  const redacted = JSON.stringify(sanitizeOpenArtEvidence({ accessToken: 'SECRET', nested: ['https://cdn.openart.ai/image?token=PRIVATE'], stderr: 'Bearer TOKEN joe@example.com' }));
  assert(!/SECRET|PRIVATE|TOKEN|joe@example/.test(redacted));
  const image = path.join(root, 'input.png');
  await fs.writeFile(image, 'approved bytes');
  let uploadCalls = 0;
  const uploadCli = async () => { uploadCalls += 1; return { id: 'asset1', url: 'https://cdn.openart.ai/asset1?signature=secret' }; };
  await assert.rejects(uploadOpenArtAsset({ localPath: image, sha256: 'wrong', projectId: 'p1', receiptPath: path.join(root, 'wrong.json'), runCli: uploadCli }), { code: 'openart_upload_hash_mismatch' });
  assert.equal(uploadCalls, 0);
  const upload = { localPath: image, sha256: sha('approved bytes'), projectId: 'p1', receiptPath: path.join(root, 'upload.json'), runCli: uploadCli };
  await uploadOpenArtAsset(upload);
  await assert.rejects(uploadOpenArtAsset(upload), { code: 'openart_existing_attempt' });
  assert.equal(uploadCalls, 1);
  assert(!(await fs.readFile(upload.receiptPath, 'utf8')).includes('signature=secret'));

  const projectReceipt = path.join(root, 'project.json');
  await assert.rejects(createOpenArtProject({ name: 'one', receiptPath: projectReceipt, runCli: async () => { throw new Error('uncertain transport'); } }));
  let duplicateSubmit = false;
  await assert.rejects(createOpenArtProject({ name: 'one', receiptPath: projectReceipt, runCli: async () => { duplicateSubmit = true; } }), { code: 'EEXIST' });
  assert.equal(duplicateSubmit, false);

  let downloadCalled = false;
  await assert.rejects(downloadOpenArtCreation({ creationId: 'history1', outputPath: path.join(root, 'download.png'), receiptPath: path.join(root, 'download.json'), runCli: async () => ({ history: { id: 'history1', status: 'processing' }, resources: [] }), fetchImpl: async () => { downloadCalled = true; } }), { code: 'openart_creation_not_complete' });
  assert.equal(downloadCalled, false);

  const exactJob = (id, receiptPath = path.join(root, `${id}.json`)) => ({
    assignmentId: id, prompt: `prompt ${id}`, projectId: 'project1', receiptPath,
    creditsQuoted: 5,
    references: [{ id: 'upload1', label: 'Joey', sha256: 'a'.repeat(64), url: 'https://cdn.openart.ai/ref.png?signature=private' }],
  });
  const exactRequest = buildExactOpenArtImageRequest(exactJob('exact-request'));
  assert.equal(exactRequest.model, 'gpt-image-2-5-sunburst');
  assert.equal(exactRequest.mode, 'image2image');
  assert.deepEqual(exactRequest.params, {
    prompt: 'prompt exact-request', imageCount: 1, aspectRatio: '16:9', resolutionTier: '1k', quality: 'low',
    outputFormat: 'png', lockAspectRatio: true, autoEnhancePrompt: false,
    visualReferences: [{ type: 'image', id: 'upload1', url: 'https://cdn.openart.ai/ref.png?signature=private', label: 'Joey' }],
    variant: 'sunburst',
  });

  let dryRunNetwork = false;
  const dryRun = await submitExactOpenArtImageBatch({
    jobs: [exactJob('dry-run')], concurrency: 24, maxCreditCost: 20, totalCreditBudget: 5,
    execute: false,
    runCli: async () => { dryRunNetwork = true; }, fetchImpl: async () => { dryRunNetwork = true; },
  });
  assert.equal(dryRun.dry_run, true);
  assert.equal(dryRunNetwork, false);
  const dryReceipt = await fs.readFile(path.join(root, 'dry-run.json'), 'utf8');
  assert.match(dryReceipt, /"aspectRatio": "16:9"/);
  assert.match(dryReceipt, /"resolutionTier": "1k"/);
  assert.match(dryReceipt, /"quality": "low"/);
  assert(!dryReceipt.includes('signature=private'));

  const credentialPath = path.join(root, 'cli-credentials.json');
  await fs.writeFile(credentialPath, JSON.stringify({
    accessToken: 'ACCESS-SECRET', refreshToken: 'REFRESH-SECRET', origin: 'https://openart.ai', type: 'oauth',
  }), { mode: 0o600 });
  let quoteAccountReads = 0;
  const quote = await quoteExactOpenArtImageBatch({
    jobs: [exactJob('quote')], credentialPath,
    runCli: async (args) => { assert.deepEqual(args, ['account']); quoteAccountReads += 1; return { plan: 'Pro', credits: 123 }; },
    fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://openart.ai/suite/api/cli/v1/model-cost');
      const body = JSON.parse(options.body);
      assert.equal(body.params.quality, 'low'); assert.equal(body.params.resolutionTier, '1k'); assert.equal(body.params.aspectRatio, '16:9');
      return { ok: true, status: 200, text: async () => JSON.stringify({ items: [{ model: body.model, mode: body.mode, config: { imageCount: 1, resolutionTier: '1k', aspectRatio: '16:9', quality: 'low' }, totalCredits: 6 }] }) };
    },
  });
  assert.equal(quoteAccountReads, 1);
  assert.equal(quote.account_credits_available, 123);
  assert.equal(quote.quotes[0].credits, 6);
  assert.equal(quote.quotes[0].reference_count, 1);
  let active = 0; let maximumActive = 0; let requests = 0; let accountRefreshes = 0;
  const executeJobs = Array.from({ length: 5 }, (_, index) => exactJob(`execute-${index}`));
  const executed = await submitExactOpenArtImageBatch({
    jobs: executeJobs, concurrency: 2, maxCreditCost: 20, totalCreditBudget: 25, execute: true,
    credentialPath,
    runCli: async (args) => { assert.deepEqual(args, ['account']); accountRefreshes += 1; return { plan: 'Pro' }; },
    fetchImpl: async (url, options) => {
      requests += 1; active += 1; maximumActive = Math.max(maximumActive, active);
      assert.equal(String(url), 'https://openart.ai/suite/api/cli/v1/generate');
      assert.equal(options.headers.authorization, 'Bearer ACCESS-SECRET');
      const body = JSON.parse(options.body);
      assert.equal(body.params.quality, 'low'); assert.equal(body.params.resolutionTier, '1k'); assert.equal(body.params.aspectRatio, '16:9');
      await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ historyId: `history-${requests}`, status: 'PENDING' }) };
    },
  });
  assert.equal(executed.results.length, 5);
  assert.equal(accountRefreshes, 1);
  assert.equal(requests, 5);
  assert.equal(maximumActive, 2);
  const paidReceipt = await fs.readFile(path.join(root, 'execute-0.json'), 'utf8');
  assert(!/ACCESS-SECRET|REFRESH-SECRET|signature=private/.test(paidReceipt));
  assert.match(paidReceipt, /openart_cli_oauth_api_compat_v1/);

  const failedReceipt = path.join(root, 'failed-http.json');
  await assert.rejects(submitExactOpenArtImageBatch({
    jobs: [exactJob('failed-http', failedReceipt)], concurrency: 1, maxCreditCost: 20,
    totalCreditBudget: 5, execute: true, credentialPath,
    runCli: async () => ({ plan: 'Pro' }),
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => `provider-error-${'x'.repeat(4096)}` }),
  }), (error) => {
    const serialized = JSON.stringify(error.results);
    assert(serialized.length < 2000);
    assert(serialized.includes('truncated'));
    return true;
  });
  await assert.rejects(fs.access(failedReceipt));

  let budgetNetwork = false;
  await assert.rejects(submitExactOpenArtImageBatch({
    jobs: [exactJob('budget')], concurrency: 1, maxCreditCost: 4, totalCreditBudget: 5, execute: true,
    runCli: async () => { budgetNetwork = true; }, fetchImpl: async () => { budgetNetwork = true; },
  }), { code: 'openart_exact_job_budget_exceeded' });
  assert.equal(budgetNetwork, false);
  console.log('OpenArt CLI provider guard tests passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
