import assert from 'node:assert/strict';
import { parseMultizoneProofArgs } from '../panel-multizone-proof.mjs';
import { buildFalImageInput, FAL_PRIMARY_PARAMS } from '../lib/fal-provider.mjs';
import { dispatchMultizoneProof, prepareMultizoneProof, resolveMultizoneProofPlan, MULTIZONE_PROOF_SPEND_TOKEN } from '../lib/panel-multizone-proof.mjs';

let count = 0;
async function test(name, run) { await run(); count++; console.log(`ok - multizone proof: ${name}`); }
await test('CLI flags are explicit and closed', async () => {
  assert.equal(parseMultizoneProofArgs(['observe', '--proof-dir', '/tmp/p']).proofDir, '/tmp/p');
  assert.deepEqual(parseMultizoneProofArgs(['dispatch', '--proof-dir', '/tmp/p', '--confirm-spend', 'x', '--page-ids', 'a,b']).pageIds, ['a', 'b']);
  assert.throws(() => parseMultizoneProofArgs(['render', '--proof-dir', '/tmp/p']), /Usage/);
  assert.throws(() => parseMultizoneProofArgs(['prepare', '--plan', '/a', '--bogus', 'x', '--proof-dir', '/p']), /Invalid/);
});
await test('paid dispatch refuses before any file or provider access without the exact token', async () => {
  await assert.rejects(dispatchMultizoneProof({ proofDir: '/nonexistent/proof', confirmSpend: 'yes' }), new RegExp(MULTIZONE_PROOF_SPEND_TOKEN));
});
await test('proofs never live in an episode and plans are validated', async () => {
  await assert.rejects(prepareMultizoneProof({ planPath: '/x.json', proofDir: '/data/channels/c/weekly_runs/w/episodes/ep_01/proof' }), /outside episode/);
  await assert.rejects(prepareMultizoneProof({ planPath: '/x.json', proofDir: 'relative/proof' }), /absolute proof directory/);
  await assert.rejects(resolveMultizoneProofPlan({ schema: 'other' }), /unsupported plan schema/);
  await assert.rejects(resolveMultizoneProofPlan({ schema: 'goldflow_multizone_proof_page_plan_v1', proof_id: 'p', author: 'a', editorial_note: 'short', source_episode_dir: '/x' }), /editorial note/);
});
await test('larger page canvases are explicit and allowlisted; quality stays locked', async () => {
  const urls = ['https://v3b.fal.media/files/x.png'];
  assert.deepEqual(buildFalImageInput({ prompt: 'p', referenceUrls: urls }).input.image_size, FAL_PRIMARY_PARAMS.image_size);
  const large = buildFalImageInput({ prompt: 'p', referenceUrls: urls, imageSize: { width: 3840, height: 2160 } }).input;
  assert.deepEqual([large.image_size, large.quality], [{ width: 3840, height: 2160 }, 'low']);
  assert.throws(() => buildFalImageInput({ prompt: 'p', imageSize: { width: 1000, height: 1000 } }), /Unsupported Fal canvas/);
});
console.log(`Panel multizone proof: ${count} test groups passed.`);
