import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { sha256File } from './file-hash.mjs';

import { validatePanelTimeline } from './panel-layout-validation.mjs';
export { validatePanelTimeline } from './panel-layout-validation.mjs';

const ensure = (condition, message) => { if (!condition) throw new Error(`Panel timeline: ${message}`); };

export async function loadPanelTimeline(manifestPath) {
  const absoluteManifest = path.resolve(manifestPath);
  const timeline = validatePanelTimeline(JSON.parse(await fs.readFile(absoluteManifest, 'utf8')));
  const source_hashes = { [absoluteManifest]: await sha256File(absoluteManifest) };
  const resolveSource = async (row) => {
    ensure(!/^[a-z]+:\/\//i.test(row.path), 'only local asset paths supported');
    const file = await fs.realpath(path.resolve(path.dirname(absoluteManifest), row.path));
    ensure((await fs.stat(file)).isFile(), `not a file: ${file}`);
    const actual = await sha256File(file);
    ensure(actual === row.sha256, `stale source hash: ${row.id ?? 'audio'}`);
    source_hashes[file] = actual;
    return file;
  };
  const assets = [];
  for (const asset of timeline.assets) {
    const file = await resolveSource(asset);
    const metadata = await sharp(file, { limitInputPixels: 100_000_000 }).metadata();
    ensure(['png', 'jpeg', 'webp'].includes(metadata.format), `unsupported raster ${asset.id}`);
    ensure(!metadata.pages || metadata.pages === 1, `animated/multipage input ${asset.id} not supported`);
    // Rotation/format normalization only; original dimensions and crop fractions survive.
    const raster = await sharp(file, { limitInputPixels: 100_000_000 }).rotate().png().toBuffer();
    assets.push({ ...asset, path: file, data_url: `data:image/png;base64,${raster.toString('base64')}` });
  }
  const audio = timeline.audio ? { ...timeline.audio, path: await resolveSource(timeline.audio) } : null;
  return { timeline, assets, audio, source_hashes };
}
