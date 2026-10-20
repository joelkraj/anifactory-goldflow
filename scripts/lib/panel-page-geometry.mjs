import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

// Deterministic page geometry for multi-zone panel artwork. The model is asked
// for straight light gutters but never places them exactly, so zone rectangles
// are measured from the actual raster and checked against the declared
// template. No model call, no retry and no repair happens here.
export const PAGE_GEOMETRY_DETECTOR_VERSION = 'guillotine_light_gutter_v2_topology';
export const PAGE_GEOMETRY_POLICY = Object.freeze({
  light_threshold: 200, // 0..255 luminance; gutters are near-white
  min_continuity: 0.98, // fraction of a gutter line's span that must be light
  min_gutter_px: 2,
  max_gutter_fraction: 0.05, // of the dimension being cut; wider light bands are content
  // Topology, not exact placement: the model draws the requested arrangement
  // but rarely centres its gutters (gala proof: 4 of 13 pages split 37-58%).
  min_zone_fraction: 0.25, // each zone side, as a fraction of the page side
  full_span_fraction: 0.9, // a nominally full-height/width zone must span this much
  order_margin: 0.1, // nominal centres this far apart must keep their order
  safe_inset_fraction: 0.01, // of each zone dimension, per side
  max_depth: 3,
});

const g = 0.005; // half of a nominal 1% gutter
// Nominal zones exclude the gutter; slots are listed in reading order.
export const PAGE_TEMPLATES = Object.freeze({
  P2V: [{ slot: 'left', x: 0, y: 0, width: 0.5 - g, height: 1 }, { slot: 'right', x: 0.5 + g, y: 0, width: 0.5 - g, height: 1 }],
  P2H: [{ slot: 'top', x: 0, y: 0, width: 1, height: 0.5 - g }, { slot: 'bottom', x: 0, y: 0.5 + g, width: 1, height: 0.5 - g }],
  P3L: [{ slot: 'left', x: 0, y: 0, width: 0.5 - g, height: 1 }, { slot: 'right_top', x: 0.5 + g, y: 0, width: 0.5 - g, height: 0.5 - g }, { slot: 'right_bottom', x: 0.5 + g, y: 0.5 + g, width: 0.5 - g, height: 0.5 - g }],
  P4G: [{ slot: 'top_left', x: 0, y: 0, width: 0.5 - g, height: 0.5 - g }, { slot: 'top_right', x: 0.5 + g, y: 0, width: 0.5 - g, height: 0.5 - g }, { slot: 'bottom_left', x: 0, y: 0.5 + g, width: 0.5 - g, height: 0.5 - g }, { slot: 'bottom_right', x: 0.5 + g, y: 0.5 + g, width: 0.5 - g, height: 0.5 - g }],
});

const need = (value, message) => { if (!value) throw new Error(`Page geometry: ${message}`); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const round = value => Math.round(value * 1e6) / 1e6;

// Light runs across a full region span. A run touching the region edge is a
// border, not a gutter, and only trims the region.
function lineRuns(gray, width, region, orientation, policy) {
  const vertical = orientation === 'vertical';
  const [from, to] = vertical ? [region.x, region.x + region.width] : [region.y, region.y + region.height];
  const [spanFrom, spanTo] = vertical ? [region.y, region.y + region.height] : [region.x, region.x + region.width];
  const span = spanTo - spanFrom, continuity = [];
  for (let line = from; line < to; line++) {
    let light = 0;
    for (let t = spanFrom; t < spanTo; t++) if (gray[vertical ? t * width + line : line * width + t] >= policy.light_threshold) light++;
    continuity.push(light / span);
  }
  const runs = [];
  for (let i = 0; i < continuity.length;) {
    if (continuity[i] < policy.min_continuity) { i++; continue; }
    let j = i; while (j < continuity.length && continuity[j] >= policy.min_continuity) j++;
    runs.push({ start: from + i, end: from + j, continuity: Math.min(...continuity.slice(i, j)) });
    i = j;
  }
  const extent = to - from, maxWidth = Math.max(policy.min_gutter_px, Math.floor(extent * policy.max_gutter_fraction));
  return {
    lead: runs.find(run => run.start === from)?.end ?? from,
    tail: runs.findLast(run => run.end === to)?.start ?? to,
    gutters: runs.filter(run => run.start > from && run.end < to && run.end - run.start >= policy.min_gutter_px && run.end - run.start <= maxWidth),
  };
}

function split(gray, width, region, depth, policy, gutters) {
  if (depth < policy.max_depth) {
    for (const orientation of ['vertical', 'horizontal']) {
      const found = lineRuns(gray, width, region, orientation, policy);
      if (!found.gutters.length) continue;
      const vertical = orientation === 'vertical', cuts = [];
      let cursor = found.lead;
      for (const run of found.gutters) {
        cuts.push([cursor, run.start]); cursor = run.end;
        gutters.push({ orientation, start_px: run.start, end_px: run.end, span_px: vertical ? [region.y, region.y + region.height] : [region.x, region.x + region.width], continuity: round(run.continuity) });
      }
      cuts.push([cursor, found.tail]);
      return cuts.filter(([a, b]) => b > a).flatMap(([a, b]) => split(gray, width, vertical
        ? { x: a, y: region.y, width: b - a, height: region.height }
        : { x: region.x, y: a, width: region.width, height: b - a }, depth + 1, policy, gutters));
    }
  }
  return [region];
}

const centre = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
function permutations(n) {
  if (n === 0) return [[]];
  return permutations(n - 1).flatMap(p => Array.from({ length: n }, (_, i) => [...p.slice(0, i), n - 1, ...p.slice(i)]));
}
/** Best one-to-one slot assignment that preserves the template's arrangement, or null. */
function matchTopology(nominal, rects, policy) {
  const fits = (zone, r) => r.width >= policy.min_zone_fraction && r.height >= policy.min_zone_fraction
    && (zone.height >= 0.99 ? r.height >= policy.full_span_fraction : r.height < policy.full_span_fraction)
    && (zone.width >= 0.99 ? r.width >= policy.full_span_fraction : r.width < policy.full_span_fraction);
  let best = null, bestCost = Infinity;
  for (const perm of permutations(nominal.length)) {
    if (!nominal.every((zone, i) => fits(zone, rects[perm[i]]))) continue;
    let ordered = true, cost = 0;
    for (let i = 0; i < nominal.length && ordered; i++) {
      const a = centre(nominal[i]), ra = centre(rects[perm[i]]);
      cost += Math.hypot(a.x - ra.x, a.y - ra.y);
      for (let j = 0; j < nominal.length; j++) {
        const b = centre(nominal[j]), rb = centre(rects[perm[j]]);
        if (b.x - a.x > policy.order_margin && !(rb.x > ra.x)) ordered = false;
        if (b.y - a.y > policy.order_margin && !(rb.y > ra.y)) ordered = false;
      }
    }
    if (ordered && cost < bestCost) { best = perm; bestCost = cost; }
  }
  return best;
}

/** Measures gutters and zones on a raster buffer and checks them against one template. */
export async function measurePageGeometry(bytes, template, policy = PAGE_GEOMETRY_POLICY) {
  const nominal = PAGE_TEMPLATES[template];
  need(nominal, `unknown template ${template}`);
  const { data: gray, info } = await sharp(bytes, { limitInputPixels: 100_000_000 }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info, gutters = [];
  const leaves = split(gray, width, { x: 0, y: 0, width, height }, 0, policy, gutters)
    .map(rect => ({ ...rect, normalized: { x: rect.x / width, y: rect.y / height, width: rect.width / width, height: rect.height / height } }));
  const findings = [];
  if (leaves.length !== nominal.length) findings.push({ code: 'zone_count_mismatch', expected: nominal.length, detected: leaves.length });
  const zones = [];
  const assignment = leaves.length === nominal.length ? matchTopology(nominal, leaves.map(leaf => leaf.normalized), policy) : null;
  if (leaves.length === nominal.length && !assignment) findings.push({ code: 'zone_topology_mismatch', template, detected_rects: leaves.map(leaf => leaf.normalized) });
  for (const [i, zone] of nominal.entries()) {
    if (!assignment) break;
    const leaf = leaves[assignment[i]], n = leaf.normalized;
    const deviation = Math.max(Math.abs(n.x - zone.x), Math.abs(n.y - zone.y), Math.abs(n.x + n.width - zone.x - zone.width), Math.abs(n.y + n.height - zone.y - zone.height));
    const inset = { x: Math.ceil(leaf.width * policy.safe_inset_fraction), y: Math.ceil(leaf.height * policy.safe_inset_fraction) };
    const safe = { x: leaf.x + inset.x, y: leaf.y + inset.y, width: leaf.width - 2 * inset.x, height: leaf.height - 2 * inset.y };
    zones.push({
      slot: zone.slot,
      nominal: { x: zone.x, y: zone.y, width: zone.width, height: zone.height },
      detected_px: { x: leaf.x, y: leaf.y, width: leaf.width, height: leaf.height },
      safe_px: safe,
      safe_rect: { x: round(safe.x / width), y: round(safe.y / height), width: round(safe.width / width), height: round(safe.height / height) },
      max_edge_deviation: round(deviation), // informational under topology matching
    });
  }
  return {
    schema: 'goldflow_panel_page_geometry_v1',
    status: findings.length ? 'failed' : 'passed',
    detector_version: PAGE_GEOMETRY_DETECTOR_VERSION, policy: { ...policy },
    template, raster_sha256: sha(bytes), width, height,
    gutters, detected_zone_count: leaves.length,
    detected_rects_px: leaves.map(({ normalized, ...rect }) => rect),
    zones, findings,
  };
}

/** Official location of a page raster's geometry receipt inside an episode. */
// Keyed by the measured raster, so an exact owner repair gets a new receipt
// and earlier receipts stay immutable.
export function panelPageGeometryDir(episodeDir, assetId, rasterSha256) {
  need(path.isAbsolute(episodeDir ?? '') && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(assetId ?? '') && /^[a-f0-9]{64}$/.test(rasterSha256 ?? ''), 'absolute episode dir, safe asset ID and raster SHA-256 required');
  return path.join(episodeDir, 'panel_page_geometry', assetId, rasterSha256.slice(0, 16));
}

/**
 * Writes an immutable geometry receipt plus lossless review crops of each
 * passed zone's safe rectangle. Crops are for image QA review only; the
 * composer reads the page raster through panel.source_rect.
 */
export async function writePageGeometry({ imagePath, template, outputDir }) {
  need(path.isAbsolute(imagePath ?? '') && path.isAbsolute(outputDir ?? ''), 'absolute imagePath and outputDir required');
  const bytes = await fs.readFile(imagePath);
  const geometry = { ...await measurePageGeometry(bytes, template), raster_path: imagePath, created_at: new Date().toISOString() };
  await fs.mkdir(path.dirname(outputDir), { recursive: true });
  await fs.mkdir(outputDir); // Non-recursive: an earlier attempt is never overwritten.
  geometry.review_crops = [];
  if (geometry.status === 'passed') {
    for (const zone of geometry.zones) {
      const file = path.join(outputDir, `${zone.slot}.png`);
      const { x: left, y: top, width, height } = zone.safe_px;
      const crop = await sharp(bytes).extract({ left, top, width, height }).png({ compressionLevel: 9 }).toBuffer();
      await fs.writeFile(file, crop, { flag: 'wx' });
      geometry.review_crops.push({ slot: zone.slot, path: file, sha256: sha(crop), width, height });
    }
  }
  const receipt = path.join(outputDir, 'page_geometry.json');
  await fs.writeFile(receipt, `${JSON.stringify(geometry, null, 2)}\n`, { flag: 'wx' });
  return { ...geometry, receipt_path: receipt };
}
