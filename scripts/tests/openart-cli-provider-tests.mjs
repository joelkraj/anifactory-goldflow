import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { discoverOpenArtContract, generateOpenArtImage, sanitizeOpenArtEvidence, uploadOpenArtAsset, createOpenArtProject, downloadOpenArtCreation } from '../lib/openart-cli-provider.mjs';

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
  console.log('OpenArt CLI provider guard tests passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
