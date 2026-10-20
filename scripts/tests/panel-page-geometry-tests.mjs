import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { measurePageGeometry, writePageGeometry, PAGE_TEMPLATES } from '../lib/panel-page-geometry.mjs';

let count = 0;
async function test(name, run) { await run(); count++; process.stdout.write(`ok - page geometry: ${name}\n`); }
const W = 1920, H = 1080, GUTTER = 18;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'page-geometry-tests-'));

// Deterministic mid/dark noise artwork with explicit white gutter rectangles.
function raster({ gutters = [], paint = [] }) {
  const pixels = Buffer.alloc(W * H * 3);
  let seed = 7;
  for (let i = 0; i < pixels.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; pixels[i] = 20 + (seed % 150); }
  const fill = (rect, value) => {
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) pixels.fill(value, (y * W + x) * 3, (y * W + x) * 3 + 3);
  };
  for (const rect of gutters) fill(rect, 250);
  for (const { rect, value } of paint) fill(rect, value);
  return sharp(pixels, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}
const vertical = (x, y = 0, height = H) => ({ x: x - GUTTER / 2, y, width: GUTTER, height });
const horizontal = (y, x = 0, width = W) => ({ x, y: y - GUTTER / 2, width, height: GUTTER });
const layouts = {
  P2V: [vertical(960)],
  P2H: [horizontal(540)],
  P3L: [vertical(960), horizontal(540, 960 + GUTTER / 2, W - 960 - GUTTER / 2)],
  P4G: [vertical(960), horizontal(540)],
  P3H: [vertical(1280), horizontal(540, 1280 + GUTTER / 2, W - 1280 - GUTTER / 2)],
  P4H: [vertical(1280), horizontal(360, 1280 + GUTTER / 2, W - 1280 - GUTTER / 2), horizontal(720, 1280 + GUTTER / 2, W - 1280 - GUTTER / 2)],
  P5L: [vertical(960), vertical(1440), horizontal(540, 960 + GUTTER / 2, W - 960 - GUTTER / 2)],
  P6G: [vertical(640), vertical(1280), horizontal(540)],
};

await test('every template passes on an exact synthetic page', async () => {
  for (const [template, gutters] of Object.entries(layouts)) {
    const geometry = await measurePageGeometry(await raster({ gutters }), template);
    assert.equal(geometry.status, 'passed', `${template}: ${JSON.stringify(geometry.findings)}`);
    assert.deepEqual(geometry.zones.map(zone => zone.slot), PAGE_TEMPLATES[template].map(zone => zone.slot));
    for (const zone of geometry.zones) {
      const d = zone.detected_px, s = zone.safe_px;
      assert.ok(s.x > d.x && s.y > d.y && s.x + s.width < d.x + d.width && s.y + s.height < d.y + d.height, 'safe rect sits inside the detected zone');
      assert.ok(zone.max_edge_deviation < 0.01);
    }
  }
});

await test('measured zones follow off-center gutters within tolerance', async () => {
  const geometry = await measurePageGeometry(await raster({ gutters: [vertical(1010), horizontal(515, 1010 + GUTTER / 2, W - 1010 - GUTTER / 2)] }), 'P3L');
  assert.equal(geometry.status, 'passed');
  assert.equal(geometry.zones[0].detected_px.width, 1010 - GUTTER / 2);
  assert.ok(geometry.zones[0].max_edge_deviation > 0.02 && geometry.zones[0].max_edge_deviation < 0.04);
});

await test('off-centre splits pass on topology; implausible or rearranged layouts fail', async () => {
  const offCentre = await measurePageGeometry(await raster({ gutters: [vertical(710)] }), 'P2V');
  assert.equal(offCentre.status, 'passed', 'a 37/63 split is still the requested two-panel layout');
  assert.ok(offCentre.zones[0].max_edge_deviation > 0.1, 'deviation is recorded as information');
  const sliver = await measurePageGeometry(await raster({ gutters: [vertical(1700)] }), 'P2V');
  assert.equal(sliver.status, 'failed');
  assert.deepEqual(sliver.findings.map(row => row.code), ['zone_topology_mismatch']);
  assert.equal(sliver.zones.length, 0);
  // P3L mirrored: stacked zones on the left, the full-height zone on the right.
  const mirrored = await measurePageGeometry(await raster({ gutters: [vertical(960), horizontal(540, 0, 960 - GUTTER / 2)] }), 'P3L');
  assert.equal(mirrored.status, 'failed');
  assert.deepEqual(mirrored.findings.map(row => row.code), ['zone_topology_mismatch']);
  // A P2V page measured against P2H has the right count but the wrong arrangement.
  assert.equal((await measurePageGeometry(await raster({ gutters: layouts.P2V }), 'P2H')).status, 'failed');
});

await test('a figure crossing a gutter breaks it; a small speck does not', async () => {
  const limb = await measurePageGeometry(await raster({ gutters: layouts.P2V, paint: [{ rect: { x: 930, y: 400, width: 60, height: 40 }, value: 30 }] }), 'P2V');
  assert.equal(limb.status, 'failed');
  assert.deepEqual(limb.findings[0], { code: 'zone_count_mismatch', expected: 2, detected: 1 });
  const speck = await measurePageGeometry(await raster({ gutters: layouts.P2V, paint: [{ rect: { x: 955, y: 400, width: 10, height: 10 }, value: 30 }] }), 'P2V');
  assert.equal(speck.status, 'passed');
  assert.ok(speck.gutters[0].continuity < 1);
});

await test('light content is never silently accepted as a different layout', async () => {
  // A thin full-height light streak inside the left panel looks like an extra gutter.
  const streak = await measurePageGeometry(await raster({ gutters: layouts.P2V, paint: [{ rect: { x: 300, y: 0, width: 4, height: H }, value: 240 }] }), 'P2V');
  assert.equal(streak.status, 'failed');
  assert.equal(streak.detected_zone_count, 3);
  // A wide light area is content, not a gutter.
  const wall = await measurePageGeometry(await raster({ gutters: layouts.P2V, paint: [{ rect: { x: 200, y: 0, width: 160, height: H }, value: 240 }] }), 'P2V');
  assert.equal(wall.status, 'passed');
});

await test('an outer light border is trimmed rather than treated as a gutter', async () => {
  const border = [{ x: 0, y: 0, width: W, height: 12 }, { x: 0, y: H - 12, width: W, height: 12 }, { x: 0, y: 0, width: 12, height: H }, { x: W - 12, y: 0, width: 12, height: H }];
  const geometry = await measurePageGeometry(await raster({ gutters: [...border, ...layouts.P4G] }), 'P4G');
  assert.equal(geometry.status, 'passed');
  assert.deepEqual(geometry.zones[0].detected_px, { x: 12, y: 12, width: 960 - GUTTER / 2 - 12, height: 540 - GUTTER / 2 - 12 });
});

await test('a half page plus a nested 2x2 grid is measured, then rejected as off-template', async () => {
  // Shape of the accepted coma-healer montage precedent: five regions.
  const gutters = [vertical(1068, 0, H), vertical(1461, 0, H), horizontal(510, 1068 + GUTTER / 2, W - 1068 - GUTTER / 2)];
  const geometry = await measurePageGeometry(await raster({ gutters }), 'P3L');
  assert.equal(geometry.detected_zone_count, 5);
  assert.equal(geometry.status, 'failed');
  assert.deepEqual(geometry.findings[0], { code: 'zone_count_mismatch', expected: 3, detected: 5 });
  await assert.rejects(measurePageGeometry(await raster({ gutters }), 'P9X'), /unknown template/);
});

await test('writes an immutable receipt and lossless review crops bound to the raster', async () => {
  const bytes = await raster({ gutters: layouts.P3L });
  const imagePath = path.join(root, 'page.png'); await fs.writeFile(imagePath, bytes);
  const outputDir = path.join(root, 'geometry', 'page_0001');
  const result = await writePageGeometry({ imagePath, template: 'P3L', outputDir });
  assert.equal(result.status, 'passed');
  assert.equal(result.raster_sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.review_crops.length, 3);
  for (const crop of result.review_crops) {
    const zone = result.zones.find(row => row.slot === crop.slot), cropBytes = await fs.readFile(crop.path);
    assert.equal(createHash('sha256').update(cropBytes).digest('hex'), crop.sha256);
    const expected = await sharp(bytes).extract({ left: zone.safe_px.x, top: zone.safe_px.y, width: zone.safe_px.width, height: zone.safe_px.height }).raw().toBuffer();
    assert.ok(expected.equals(await sharp(cropBytes).raw().toBuffer()), 'review crop is pixel-exact');
  }
  assert.deepEqual(JSON.parse(await fs.readFile(result.receipt_path, 'utf8')).zones, result.zones);
  await assert.rejects(writePageGeometry({ imagePath, template: 'P3L', outputDir }), /EEXIST/);
  await assert.rejects(writePageGeometry({ imagePath: 'page.png', template: 'P3L', outputDir: path.join(root, 'x') }), /absolute/);
});

await test('a failed page writes its receipt but no review crops', async () => {
  const imagePath = path.join(root, 'bad.png'); await fs.writeFile(imagePath, await raster({ gutters: layouts.P2V }));
  const result = await writePageGeometry({ imagePath, template: 'P4G', outputDir: path.join(root, 'geometry', 'bad') });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.review_crops, []);
  assert.deepEqual((await fs.readdir(path.join(root, 'geometry', 'bad'))).sort(), ['page_geometry.json']);
});

await fs.rm(root, { recursive: true, force: true });
process.stdout.write(`Panel page geometry: ${count} test groups passed.\n`);
