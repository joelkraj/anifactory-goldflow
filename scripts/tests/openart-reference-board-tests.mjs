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
  assert.match(guidance, /Each human panel supplies only its own subject's identity/);
  assert.match(guidance, /story-confirmed twins, clones/);
  assert.match(guidance, /current shot's wardrobe state/);
  assert(!guidance.includes('Joey'));
  // Proof-only smaller output: same layout and guidance, separate cache entry, default unchanged.
  const small = await buildReferenceBoard({ root, imageId: 'frame.001', references: refs, outputSize: { width: 1024, height: 576 } });
  const smallMeta = await sharp(small.output_path).metadata();
  assert.deepEqual([smallMeta.width, smallMeta.height, small.width, small.layout_width], [1024, 576, 1024, 1920]);
  assert.notEqual(small.cache_key, first.cache_key); assert.deepEqual(small.panels, first.panels);
  assert.equal(referenceBoardPromptGuidance(small), guidance);
  assert.equal((await buildReferenceBoard({ root, imageId: 'frame.001', references: refs, outputSize: { width: 1920, height: 1080 } })).cache_key, first.cache_key);
  await assert.rejects(buildReferenceBoard({ root, imageId: 'frame.001', references: refs, outputSize: { width: 640, height: 360 } }), /Unsupported reference board output size/);
  const style = await make('probability-style', '#20152e', 'style');
  const locationStyle = await buildReferenceBoard({ root, imageId: 'frame.location-style', references: [refs[1], style] });
  const locationStyleGuidance = referenceBoardPromptGuidance(locationStyle);
  assert.match(locationStyleGuidance, /left panel only for the environment's architecture/);
  assert.match(locationStyleGuidance, /right panel only for the supernatural interface treatment/);
  assert(!locationStyleGuidance.includes("primary character's identity"));
  // Five or six references (multi-zone pages): a 3x2 grid, characters first, every cell named.
  const extra = [await make('marcus', '#334455', 'character'), await make('vanessa', '#225533', 'character')];
  const grid = await buildReferenceBoard({ root, imageId: 'page.six', references: [refs[1], refs[3], ...extra, refs[0], refs[2]] });
  assert.equal(grid.layout_id, 'grid_3x2_6_references');
  const gridGuidance = referenceBoardPromptGuidance(grid);
  assert.match(gridGuidance, /upper-left panel \(marcus\) only for the primary character's identity/);
  assert.match(gridGuidance, /upper-center panel \(vanessa\) only for the secondary character's separate identity/);
  assert.match(gridGuidance, /lower-center panel \(casino\) only for the environment/);
  assert.match(gridGuidance, /lower-right panel \(watch\) only for the crucial prop/);
  assert.equal(referenceBoardLayout([...refs, extra[0]]).layout_id, 'grid_3x2_5_references');
  assert.throws(() => referenceBoardLayout([...refs, ...extra, refs[0]]), /one through six/);
  assert(!referenceBoardPromptGuidance(first).includes('(joey)'), 'boards of up to four keep their exact guidance');
  console.log('OpenArt deterministic reference board tests passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
