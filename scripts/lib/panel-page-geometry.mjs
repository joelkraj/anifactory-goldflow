import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

// Deterministic page geometry for multi-zone panel artwork. The model is asked
// for straight light gutters but never places them exactly, so zone rectangles
// are measured from the actual raster and checked against the declared
// template. No model call, no retry and no repair happens here.
export const PAGE_GEOMETRY_DETECTOR_VERSION = 'guillotine_light_gutter_v1';
export const PAGE_GEOMETRY_POLICY = Object.freeze({
  light_threshold: 200, // 0..255 luminance; gutters are near-white
  min_continuity: 0.98, // fraction of a gutter line's span that must be light
  min_gutter_px: 2,
  max_gutter_fraction: 0.05, // of the dimension being cut; wider light bands are content
  edge_tolerance: 0.04, // max nominal edge deviation, normalized to the page
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
  const used = new Set(), zones = [];
  for (const zone of nominal) {
    let best = null, bestDeviation = Infinity;
    for (const [index, leaf] of leaves.entries()) {
      if (used.has(index)) continue;
      const n = leaf.normalized;
      const deviation = Math.max(Math.abs(n.x - zone.x), Math.abs(n.y - zone.y), Math.abs(n.x + n.width - zone.x - zone.width), Math.abs(n.y + n.height - zone.y - zone.height));
      if (deviation < bestDeviation) { best = index; bestDeviation = deviation; }
    }
    if (best === null || bestDeviation > policy.edge_tolerance) {
      findings.push({ code: 'zone_out_of_tolerance', slot: zone.slot, max_edge_deviation: best === null ? null : round(bestDeviation) });
      continue;
    }
    used.add(best);
    const leaf = leaves[best], inset = { x: Math.ceil(leaf.width * policy.safe_inset_fraction), y: Math.ceil(leaf.height * policy.safe_inset_fraction) };
    const safe = { x: leaf.x + inset.x, y: leaf.y + inset.y, width: leaf.width - 2 * inset.x, height: leaf.height - 2 * inset.y };
    zones.push({
      slot: zone.slot,
      nominal: { x: zone.x, y: zone.y, width: zone.width, height: zone.height },
      detected_px: { x: leaf.x, y: leaf.y, width: leaf.width, height: leaf.height },
      safe_px: safe,
      safe_rect: { x: round(safe.x / width), y: round(safe.y / height), width: round(safe.width / width), height: round(safe.height / height) },
      max_edge_deviation: round(bestDeviation),
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
