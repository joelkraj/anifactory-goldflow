import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  addCanonicalResult, fileHash, loadBank, PRIMARY_MODEL, PROVIDER_RECEIPT_SCHEMA,
  resolveReferences, reviewCanonicalAssets, sha256, synchronizeLibraryRecord,
  verifyAsset, requiredVisualChecks,
} from '../lib/openart-asset-bank.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'goldflow-openart-bank-test-'));
const bankRoot = path.join(root, 'bank');
const params = { quality: 'low', resolution: '1k', aspect_ratio: '16:9' };
const catalog = { story_universe: 'test-universe', series_scope: 'test-series' };
let sequence = 0;
async function candidate(assetId = 'test.joey', references = [], assetClass = 'character') {
  sequence += 1;
  const output = path.join(root, `candidate-${sequence}.png`);
  await sharp({ create: { width: 1024, height: 576, channels: 3, background: { r: sequence, g: 40, b: 80 } } }).png().toFile(output);
  const prompt = `Authored canonical concept ${assetId}.`;
  const result = {
    assignment_id: `assignment-${sequence}`, model: PRIMARY_MODEL,
    mode: references.length ? 'image2image' : 'text2image',
    output_path: output, sha256: await fileHash(output), width: 1024, height: 576,
    creation_id: `creation-${sequence}`, openart_asset_id: `media-${sequence}`,
    created_at: '2026-09-22T12:00:00.000Z', transport: 'openart_studio_browser', credits_quoted: 5,
  };
  const receipt = {
    schema: PROVIDER_RECEIPT_SCHEMA, assignment_id: result.assignment_id, model: result.model,
    mode: result.mode, creation_id: result.creation_id, openart_asset_id: result.openart_asset_id,
    output_sha256: result.sha256, transport: result.transport, prompt_sha256: sha256(prompt),
    params, references: references.map(({ asset_id, sha256: hash, openart_asset_id }) => ({ asset_id, sha256: hash, openart_asset_id })),
    credits_quoted: 5, created_at: result.created_at,
  };
  result.provider_receipt_path = path.join(root, `receipt-${sequence}.json`);
  await fs.writeFile(result.provider_receipt_path, JSON.stringify(receipt));
  result.provider_receipt_sha256 = await fileHash(result.provider_receipt_path);
  return { item: { asset_id: assetId, asset_class: assetClass, canonical_name: assetId }, catalog, result, references, prompt, params, projectId: 'project-1' };
}
function review(record, checks = Object.fromEntries(requiredVisualChecks(record.asset_class).map((key) => [key, true]))) {
  return {
    attestation: 'each_listed_raster_visually_inspected', reviewer: 'fixture-reviewer',
    decisions: [{ asset_id: record.asset_id, version: record.version, sha256: record.sha256, decision: 'approved', note: 'Synthetic test decision only.', checks }],
  };
}
function sync(record, id = `library-${record.asset_id}-${record.version}`) {
  return {
    attestation: 'native_openart_library_asset_visibly_verified', reviewer: 'fixture-reviewer', evidence: 'Synthetic registration test evidence.',
    asset_id: record.asset_id, version: record.version, sha256: record.sha256,
    openart_media_asset_id: record.openart_asset_id, openart_library_asset_id: id, openart_library_kind: record.openart_library_kind,
  };
}
async function latest(id = 'test.joey') { return (await loadBank(bankRoot)).assets.filter((row) => row.asset_id === id).at(-1); }

try {
  const invalid = await candidate();
  invalid.result.credits_quoted = undefined;
  await assert.rejects(addCanonicalResult(bankRoot, invalid), /credit quote/);
  assert.equal((await loadBank(bankRoot)).assets.length, 0);
  await assert.rejects(fs.stat(path.join(bankRoot, 'assets', 'test.joey', 'v0001.png')), { code: 'ENOENT' });

  const firstCandidate = await candidate();
  const first = await addCanonicalResult(bankRoot, firstCandidate);
  assert.equal(first.version, 1);
  await verifyAsset(first);
  await assert.rejects(resolveReferences(bankRoot, ['test.joey']), /Approved canonical/);
  await assert.rejects(synchronizeLibraryRecord(bankRoot, sync(first)), /pass visual review/);
  await assert.rejects(reviewCanonicalAssets(bankRoot, review(first, {})), /class-specific/);
  const failedCheck = review(first); failedCheck.decisions[0].checks.hands = false;
  await assert.rejects(reviewCanonicalAssets(bankRoot, failedCheck), /failed critical/);
  const duplicateReview = review(first); duplicateReview.decisions.push({ ...duplicateReview.decisions[0] });
  await assert.rejects(reviewCanonicalAssets(bankRoot, duplicateReview), /repeat/);
  await reviewCanonicalAssets(bankRoot, review(first));
  await assert.rejects(resolveReferences(bankRoot, ['test.joey']), /native OpenArt library/);
  const noLibrary = await resolveReferences(bankRoot, ['test.joey'], { requireLibrary: false });
  assert.equal(noLibrary[0].sha256, first.sha256);
  await synchronizeLibraryRecord(bankRoot, sync(first));
  const references = await resolveReferences(bankRoot, ['test.joey']);
  assert.equal(references[0].openart_asset_id, first.openart_asset_id);
  assert.equal(references[0].openart_library_asset_id, 'library-test.joey-1');
  assert.equal(references[0].openart_library_kind, 'character');
  assert.equal(await fileHash(references[0].library_sync.path), references[0].library_sync.sha256);
  await assert.rejects(resolveReferences(bankRoot, ['test.joey', 'test.joey']), /Duplicate/);
  await assert.rejects(resolveReferences(bankRoot, ['a', 'b', 'c', 'd']), /composition reason/);
  await assert.rejects(synchronizeLibraryRecord(bankRoot, sync(first, 'different-native-id')), /new canonical version/);

  const original = await latest();
  await assert.rejects(verifyAsset({ ...original, canonical_name: 'changed without a new version' }), /Immutable canonical metadata/);
  await assert.rejects(verifyAsset({ ...original, quality: 'medium' }), /low quality/);
  await assert.rejects(verifyAsset({ ...original, width: 2048, height: 1152 }), /dimensions disagree/);
  const receiptBytes = await fs.readFile(original.provider_receipt_path);
  await fs.writeFile(original.provider_receipt_path, '{}');
  await assert.rejects(verifyAsset(original), /provider receipt changed/);
  await fs.writeFile(original.provider_receipt_path, receiptBytes);

  const wrongPrompt = await candidate('test.adrian', references);
  wrongPrompt.prompt = 'This was not the submitted prompt.';
  await assert.rejects(addCanonicalResult(bankRoot, wrongPrompt), /prompt_sha256/);
  const wrongRef = await candidate('test.adrian', [{ ...references[0], sha256: '1'.repeat(64) }]);
  await assert.rejects(addCanonicalResult(bankRoot, wrongRef), /unapproved or unknown reference/);
  const second = await addCanonicalResult(bankRoot, await candidate('test.adrian', references));
  assert.equal(second.mode, 'image2image');
  assert.deepEqual(second.reference_ids, ['test.joey']);

  const secondJoey = await addCanonicalResult(bankRoot, await candidate());
  assert.equal(secondJoey.version, 2);
  assert.equal(secondJoey.supersedes_sha256, first.sha256);
  assert.deepEqual(secondJoey.replacement_history, [{ version: 1, sha256: first.sha256 }]);
  assert.equal((await resolveReferences(bankRoot, ['test.joey']))[0].version, 1);
  await reviewCanonicalAssets(bankRoot, review(secondJoey));
  await synchronizeLibraryRecord(bankRoot, sync(secondJoey));
  assert.equal((await resolveReferences(bankRoot, ['test.joey']))[0].version, 2);
  assert.equal(await fileHash(first.local_absolute_path), first.sha256);
  assert.equal(await fileHash(first.record_path), first.record_sha256);
  const bank = await loadBank(bankRoot);
  const history = (await fs.readdir(path.join(bankRoot, 'history'))).filter((name) => name.endsWith('.json'));
  const events = (await fs.readFile(path.join(bankRoot, 'events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(history.length, bank.revision);
  assert.equal(events.length, bank.revision);
  for (const event of events.map(JSON.parse)) assert.equal(await fileHash(event.snapshot_path), event.snapshot_sha256);
  console.log('OpenArt asset bank invariant tests passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
