import assert from 'node:assert/strict';
import { parseMultizoneProofArgs } from '../panel-multizone-proof.mjs';
import { buildFalImageInput, FAL_PRIMARY_PARAMS, falBillingForRequests } from '../lib/fal-provider.mjs';
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
await test('billing lookup returns exact request costs, pages through results and never echoes the key', async () => {
  process.env.FAL_BILLING_KEY = 'test-key:secret';
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    const cursor = new URL(url).searchParams.get('cursor');
    return { ok: true, json: async () => cursor ? { billing_events: [{ request_id: 'b', cost_total: 0.0262 }], has_more: false } : { billing_events: [{ request_id: 'a', cost_total: 0.0187 }, { request_id: 'x', cost_total: 9 }], has_more: true, next_cursor: 'c2' } };
  };
  const result = await falBillingForRequests({ requestIds: ['a', 'b', 'z'], start: '2026-10-20T00:00:00Z', end: '2026-10-21T00:00:00Z', fetchImpl });
  assert.deepEqual(result.events.map(row => [row.request_id, row.cost_usd]), [['a', 0.0187], ['b', 0.0262]]);
  assert.deepEqual(result.missing_request_ids, ['z']);
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(result).includes('secret'));
  await assert.rejects(falBillingForRequests({ requestIds: ['a'], start: 's', end: 'e', fetchImpl: async () => ({ ok: false, status: 403 }) }), /lacks billing permission/);
  delete process.env.FAL_BILLING_KEY;
});
console.log(`Panel multizone proof: ${count} test groups passed.`);
