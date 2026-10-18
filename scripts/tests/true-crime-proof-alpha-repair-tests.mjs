import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attachExactRgbAlpha, repairTrueCrimeProofAlpha } from '../lib/true-crime-proof-alpha-repair.mjs';

// Synthetic bytes only; no source image read, native segmentation, image encode or edit.
const rgb = Buffer.from([2, 67, 194, 250, 81, 1, 99, 70, 12, 190, 2, 10]);
const mask = Buffer.from([0, 89, 255, 254]);
const before = Buffer.from(rgb), alphaBefore = Buffer.from(mask);
assert.deepEqual(attachExactRgbAlpha(rgb, mask, 2, 2), Buffer.from([2, 67, 194, 0, 250, 81, 1, 89, 99, 70, 12, 255, 190, 2, 10, 254]));
assert.deepEqual(rgb, before); assert.deepEqual(mask, alphaBefore);
assert.throws(() => attachExactRgbAlpha(rgb, mask, 3, 2), /dimensions/);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alpha-authorization-fixture-'));
try {
  const file = path.join(dir, 'recipe.json');
  await fs.writeFile(file, JSON.stringify({ schema: 'goldflow_true_crime_alpha_repair_recipe_v1', asset_id: 'chandler_cutout', production_eligible: false, creative_generation: false, authorization: { authorized: false } }));
  await assert.rejects(repairTrueCrimeProofAlpha({ recipePath: file }), /explicit received user authorization/);
  await fs.writeFile(file, JSON.stringify({ schema: 'goldflow_true_crime_alpha_repair_recipe_v1', asset_id: 'chandler_cutout', production_eligible: false, creative_generation: false,
    authorization: { authorized: true, operator: 'Joel', note: 'A fixture is not actual consent.', received_at: '2026-09-08T00:00:00Z' } }));
  await assert.rejects(repairTrueCrimeProofAlpha({ recipePath: file }), /actual user quote/);
  assert.deepEqual(await fs.readdir(dir), ['recipe.json']);
} finally { await fs.rm(dir, { recursive: true, force: true }); }
console.log('Exact RGB/alpha byte attachment and missing-authorization refusal passed. No real image editing or Vision invocation.');
