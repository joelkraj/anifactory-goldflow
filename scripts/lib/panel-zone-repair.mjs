import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { panelPageGeometryDir } from './panel-page-geometry.mjs';

// Zone-scoped repair. Diffusion edits cannot guarantee untouched pixels, so a
// rejected zone is never repaired by re-editing its page. One reviewed request
// prepares a single replacement artwork for exactly that zone's beats; after
// the replacement exists, apply swaps only those beats to it. Accepted sibling
// zones, the page raster and its geometry stay immutable. This module never
// calls a provider.
export const ZONE_REPAIR_REQUEST_SCHEMA = 'goldflow_panel_zone_repair_request_v1';
export const ZONE_REPAIR_RECEIPT_SCHEMA = 'goldflow_panel_zone_repair_receipt_v1';

const need = (value, message) => { if (!value) throw new Error(`Zone repair: ${message}`); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const readOptional = file => read(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const text = (value, min = 1) => typeof value === 'string' && value.trim().length >= min;
const writeNew = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const writeAtomic = async (file, value) => { const tmp = `${file}.${randomUUID()}.tmp`; await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`); await fs.rename(tmp, file); };

function paths(episodeDir, episode) {
  return {
    prompts: path.join(episodeDir, 'section_image_prompts_hardened.json'),
    report: path.join(episodeDir, `imagegen_report_${episode}.json`),
    ledger: path.join(episodeDir, 'cut_execution_ledger.json'),
    decisions: path.join(episodeDir, `image_output_review_decisions_${episode}.json`),
  };
}

/** Validates a reviewed request against the current zone, page raster and evidence. */
export async function validateZoneRepairRequest({ episodeDir, episode, request }) {
  need(request?.schema === ZONE_REPAIR_REQUEST_SCHEMA && request.episode === episode, 'unsupported request schema or episode');
  need(request.actual_review === true && text(request.reviewer) && text(request.note, 20) && text(request.reason, 20), 'actual review, reviewer, substantive note and reason required');
  need(text(request.replacement_prompt, 40), 'an authored single-artwork replacement prompt is required');
  need(['review_rejected', 'geometry_failed'].includes(request.evidence), 'evidence must be review_rejected or geometry_failed');
  const p = paths(episodeDir, episode);
  const promptPlan = await read(p.prompts), ledger = await read(p.ledger);
  const zoneRows = promptPlan.prompts.filter(row => row.panel_zone_id === request.zone_id && row.panel_asset_id === request.page_asset_id);
  need(zoneRows.length > 0, `unknown zone ${request.zone_id} of page ${request.page_asset_id}`);
  const cuts = new Map(ledger.cuts.map(row => [row.image_id, row]));
  for (const row of zoneRows) {
    const cut = cuts.get(row.image_id);
    need(cut && !cut.zone_repair && cut.image_sha256 === request.rejected_page_sha256, `zone beat ${row.image_id} is not the current page raster (or was already repaired)`);
  }
  if (request.evidence === 'geometry_failed') {
    const geometry = await readOptional(path.join(panelPageGeometryDir(await fs.realpath(episodeDir), request.page_asset_id, request.rejected_page_sha256), 'page_geometry.json'));
    need(geometry?.status === 'failed' && geometry.raster_sha256 === request.rejected_page_sha256, 'geometry_failed evidence needs the failed receipt for this raster');
  } else {
    const decisions = await read(p.decisions);
    const rejected = (decisions.decisions ?? []).filter(row => zoneRows.some(zone => zone.image_id === row.image_id) && row.image_sha256 === request.rejected_page_sha256 && ['rejected', 'critical_rejected'].includes(row.decision));
    need(rejected.length > 0, 'review_rejected evidence needs a hash-bound rejection of a beat in this zone');
  }
  // The page owner's references (identity, location) carry over unchanged.
  const owner = promptPlan.prompts.find(row => row.panel_asset_id === request.page_asset_id && row.provider_submission_required !== false);
  need(owner, `page owner prompt missing for ${request.page_asset_id}`);
  return { zoneRows, owner, paths: p };
}

/** Writes an immutable, not-dispatched replacement spec for one zone. */
export async function prepareZoneRepair({ episodeDir, episode, request }) {
  const { zoneRows, owner } = await validateZoneRepairRequest({ episodeDir, episode, request });
  const requestSha256 = sha(JSON.stringify(request));
  const dir = path.join(episodeDir, 'fal', 'zone-repair', request.zone_id, requestSha256.slice(0, 16));
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await fs.mkdir(dir);
  const spec = {
    schema: 'goldflow_panel_zone_repair_spec_v1', status: 'prepared_not_dispatched', episode,
    request, request_sha256: requestSha256,
    image_ids: zoneRows.map(row => row.image_id), zone_owner_image_id: zoneRows[0].image_id,
    prompt: request.replacement_prompt, page_template: null,
    reference_requirements: owner.reference_requirements ?? [], reference_slots: owner.reference_slots ?? [],
    output: { width: 1920, height: 1080, quality: 'low' }, max_cost_usd: 0.05,
    provider_calls: 0, created_at: new Date().toISOString(),
  };
  const specPath = path.join(dir, 'spec.json');
  await writeNew(specPath, spec);
  return { ...spec, spec_path: specPath, spec_sha256: sha(await fs.readFile(specPath)) };
}

/**
 * Applies a produced replacement to exactly the zone's beats. The first zone
 * beat owns the new raster; later zone beats are byte-identical approved reuse
 * of it. Report and ledger rows for every other beat are left byte-for-byte.
 */
export async function applyZoneRepair({ episodeDir, episode, specPath, specSha256, replacementPath, resultReceiptPath, resultReceiptSha256 }) {
  const specBytes = await fs.readFile(specPath);
  need(sha(specBytes) === specSha256, 'prepared spec changed');
  const spec = JSON.parse(specBytes);
  const { zoneRows, paths: p } = await validateZoneRepairRequest({ episodeDir, episode, request: spec.request });
  need(JSON.stringify(zoneRows.map(row => row.image_id)) === JSON.stringify(spec.image_ids), 'zone beats changed since preparation');
  const receiptBytes = await fs.readFile(resultReceiptPath);
  need(sha(receiptBytes) === resultReceiptSha256, 'result receipt changed');
  const bytes = await fs.readFile(replacementPath), replacementSha256 = sha(bytes);
  need(JSON.parse(receiptBytes).output_sha256 === replacementSha256, 'result receipt does not bind the replacement raster');
  const meta = await sharp(bytes).metadata();
  need(meta.format === 'png' && meta.width > meta.height && Math.abs(meta.width / meta.height - 16 / 9) <= 0.08, 'replacement must be a 16:9 landscape PNG');
  need(replacementSha256 !== spec.request.rejected_page_sha256, 'replacement is the rejected page');
  const reportBytes = await fs.readFile(p.report), ledgerBytes = await fs.readFile(p.ledger);
  const report = JSON.parse(reportBytes), ledger = JSON.parse(ledgerBytes);
  const results = new Map(report.results.map(row => [row.image_id, row])), cuts = new Map(ledger.cuts.map(row => [row.image_id, row]));
  const appliedAt = new Date().toISOString(), owner = spec.zone_owner_image_id;
  const provenance = { request_sha256: spec.request_sha256, spec_path: specPath, spec_sha256: specSha256, rejected_page_sha256: spec.request.rejected_page_sha256, replacement_sha256: replacementSha256, result_receipt_path: resultReceiptPath, result_receipt_sha256: resultReceiptSha256, page_asset_id: spec.request.page_asset_id, zone_id: spec.request.zone_id, reviewer: spec.request.reviewer, applied_at: appliedAt };
  for (const imageId of spec.image_ids) {
    const prior = results.get(imageId), cut = cuts.get(imageId);
    const target = path.join(path.dirname(prior.image_path), `${imageId}.zone-repair-${replacementSha256.slice(0, 8)}.png`);
    const existing = await fs.readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) need(sha(existing) === replacementSha256, `existing repaired raster differs: ${imageId}`);
    else await fs.writeFile(target, bytes, { flag: 'wx' });
    const reuse = imageId !== owner;
    await fs.writeFile(`${target}.metadata.json`, `${JSON.stringify({ image_id: imageId, image_provider: 'zone_repair', zone_repair: provenance, ...(reuse ? { editorial_reuse_approved: true, reuse_source_image_id: owner } : {}) }, null, 2)}\n`);
    results.set(imageId, { ...prior, status: 'zone_repair', image_path: target, image_sha256: replacementSha256, zone_repair: provenance, updated_at: appliedAt });
    cuts.set(imageId, { ...cut, image_path: target, image_sha256: replacementSha256, generation_status: 'zone_repair', zone_repair: provenance, image_qa_status: 'pending', image_qa_note: null, page_geometry: undefined });
  }
  const newReport = { ...report, results: report.results.map(row => results.get(row.image_id)), zone_repairs: [...(report.zone_repairs ?? []), provenance], updated_at: appliedAt };
  const newLedger = { ...ledger, cuts: ledger.cuts.map(row => cuts.get(row.image_id)), updated_at: appliedAt };
  const receiptDir = path.join(path.dirname(specPath), 'applied');
  await fs.mkdir(receiptDir);
  const receipt = { schema: ZONE_REPAIR_RECEIPT_SCHEMA, status: 'applied', provenance, previous_report_sha256: sha(reportBytes), previous_ledger_sha256: sha(ledgerBytes), previous_report: report, previous_ledger: ledger, image_ids: spec.image_ids, provider_calls: 0, cost_usd: 0 };
  await writeNew(path.join(receiptDir, 'receipt.json'), receipt);
  await writeAtomic(p.ledger, newLedger);
  await writeAtomic(p.report, newReport);
  return { status: 'applied', image_ids: spec.image_ids, replacement_sha256: replacementSha256, receipt_path: path.join(receiptDir, 'receipt.json') };
}
