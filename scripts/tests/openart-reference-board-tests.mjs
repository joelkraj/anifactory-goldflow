import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { buildReferenceBoard, referenceBoardLayout, referenceBoardPromptGuidance } from '../lib/openart-reference-board.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'goldflow-reference-board-'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
try {
  const make = async (name, color, assetClass) => {
    const file = path.join(root, `${name}.png`);
    const bytes = await sharp({ create: { width: 1280, height: 720, channels: 3, background: color } }).png().toBuffer();
    await fs.writeFile(file, bytes);
    return { asset_id: `test.${name}`, asset_class: assetClass, path: file, sha256: digest(bytes) };
  };
  const refs = [
    await make('joey', '#8f1720', 'character'),
    await make('casino', '#1f3145', 'location'),
    await make('brother', '#153c20', 'character'),
    await make('watch', '#a47b19', 'object'),
  ];
  assert.equal(referenceBoardLayout(refs.slice(0, 3)).layout_id, 'two_character_primary_left_secondary_center_environment_right');
  assert.equal(referenceBoardLayout([refs[0], refs[1], refs[3]]).layout_id, 'prop_critical_primary_left_prop_upper_right_environment_lower_right');
  const first = await buildReferenceBoard({ root, imageId: 'frame.001', references: refs });
  const second = await buildReferenceBoard({ root, imageId: 'frame.001', references: refs });
  assert.equal(first.output_sha256, second.output_sha256);
  assert.equal(first.cache_key, second.cache_key);
  assert.deepEqual(first.source_reference_order, refs.map((ref) => ({ asset_id: ref.asset_id, sha256: ref.sha256 })));
  const meta = await sharp(first.output_path).metadata();
  assert.equal(meta.width, 1920); assert.equal(meta.height, 1080); assert.equal(meta.format, 'png');
  const guidance = referenceBoardPromptGuidance(first);
  assert.match(guidance, /left panel/); assert.match(guidance, /upper-right panel/); assert.match(guidance, /lower-right panel/);
  assert(!guidance.includes('Joey'));
  console.log('OpenArt deterministic reference board tests passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
