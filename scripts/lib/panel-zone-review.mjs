import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { panelPageGeometryDir } from './panel-page-geometry.mjs';
import { zoneRequestedLettering } from './panel-page-prompts.mjs';
import { tesseractWords, letteringFindings, LETTERING_OCR } from './panel-zone-lettering.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

/**
 * Image QA for page zones: each zone-bound beat is reviewed on its own
 * pixel-exact crop, while acceptance stays bound to the actual page raster.
 * Missing, failed, mismatched or tampered geometry blocks exactly the beats
 * of that zone. Nothing is regenerated or re-measured here.
 */
export async function resolveZoneReviewImages({ episodeDir, prompts, results, ocrWords = tesseractWords }) {
  const views = new Map(), findings = [], ocrByCrop = new Map();
  // OCR runs once per crop and only when its zone requests lettering; an
  // unavailable OCR engine leaves the ordinary review path unchanged.
  const lettering = async (prompt, crop) => {
    const requested = zoneRequestedLettering(prompt.provider_prompt ?? prompt.image_prompt, prompt.panel_zone_slot);
    if (!requested?.length) return { status: 'none_requested' };
    if (!ocrByCrop.has(crop.sha256)) ocrByCrop.set(crop.sha256, ocrWords(crop.path).then(words => ({ words }), error => ({ error: error.message })));
    const ocr = await ocrByCrop.get(crop.sha256);
    if (ocr.error) return { status: 'unavailable', requested, error: ocr.error };
    return { status: 'checked', engine: LETTERING_OCR, requested, findings: letteringFindings({ requested, words: ocr.words }) };
  };
  const resultById = new Map((results ?? []).map(row => [String(row.image_id ?? ''), row]));
  const realEpisodeDir = await fs.realpath(episodeDir);
  for (const prompt of prompts ?? []) {
    if (!prompt.panel_zone_id) continue;
    const imageId = String(prompt.image_id), block = (code, message) => findings.push({ image_id: imageId, severity: 'blocker', code, message });
    const result = resultById.get(imageId);
    if (result?.zone_repair) continue; // A repaired zone is an ordinary full replacement image.
    const bytes = result?.image_path ? await fs.readFile(result.image_path).catch(() => null) : null;
    if (!bytes) continue; // The ordinary missing-image finding covers this beat.
    const rasterSha256 = sha(bytes);
    const receiptPath = path.join(panelPageGeometryDir(realEpisodeDir, prompt.panel_asset_id, rasterSha256), 'page_geometry.json');
    const geometry = await readJson(receiptPath);
    if (!geometry) { block('page_geometry_missing', `${imageId} is zone ${prompt.panel_zone_id} of page ${prompt.panel_asset_id}, but that page raster has no geometry receipt.`); continue; }
    if (geometry.raster_sha256 !== rasterSha256 || geometry.template !== prompt.panel_page_template) { block('page_geometry_mismatch', `Geometry receipt for ${prompt.panel_asset_id} does not measure this ${prompt.panel_page_template} raster.`); continue; }
    if (geometry.status !== 'passed') { block('page_geometry_failed', `Page ${prompt.panel_asset_id} failed geometry (${(geometry.findings ?? []).map(row => row.code).join(', ')}); its zones cannot be cropped.`); continue; }
    const crop = (geometry.review_crops ?? []).find(row => row.slot === prompt.panel_zone_slot);
    const cropBytes = crop ? await fs.readFile(crop.path).catch(() => null) : null;
    if (!cropBytes || sha(cropBytes) !== crop.sha256) { block('zone_review_crop_invalid', `Review crop for ${prompt.panel_zone_id} (${prompt.panel_zone_slot}) is missing or changed.`); continue; }
    views.set(imageId, { lettering: await lettering(prompt, crop), review_image_path: crop.path, review_image_sha256: crop.sha256, page_asset_id: prompt.panel_asset_id, zone_id: prompt.panel_zone_id, zone_slot: prompt.panel_zone_slot, page_geometry_path: receiptPath, page_geometry_sha256: sha(await fs.readFile(receiptPath)) });
  }
  return { views, findings };
}

/** The report a model-based reviewer should see: zone beats point at their crops. */
export function reviewViewReport(imagegenReport, views) {
  return { ...imagegenReport, results: (imagegenReport?.results ?? []).map(row => views.has(String(row.image_id)) ? { ...row, image_path: views.get(String(row.image_id)).review_image_path } : row) };
}
