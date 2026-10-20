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

// ---- Fal dispatch support (receipts live in one flat directory so the
// shared retry, spend and ambiguous-attempt accounting sees every request).
export const ZONE_REPAIR_RECEIPT_DIR = 'zone-repair/submission-receipts';

export function zoneRepairStem(spec) {
  need(/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(spec?.request?.zone_id ?? '') && /^[a-f0-9]{64}$/.test(spec.request_sha256 ?? ''), 'spec zone and request hash required');
  return `${spec.request.zone_id}--${spec.request_sha256.slice(0, 16)}`;
}

export function zoneRepairAssignmentPaths(falRoot, stem) {
  const dir = path.join(falRoot, 'zone-repair');
  return {
    assignment_path: path.join(dir, 'assignments', `${stem}.json`),
    submission_receipt_path: path.join(dir, 'submission-receipts', `${stem}.json`),
    result_receipt_path: path.join(dir, 'result-receipts', `${stem}.json`),
    output_path: path.join(dir, 'outputs', `${stem}.png`),
    upload_receipt_path: path.join(dir, 'upload-receipts', `${stem}.json`),
    failure_receipt_path: path.join(dir, 'failure-receipts', `${stem}.json`),
  };
}

/**
 * Builds the exact single-artwork Fal assignment for a prepared spec. It reuses
 * the page owner's accepted reference board unchanged and the single-frame
 * board guidance (a repaired zone is one picture, not a page).
 */
export function buildZoneRepairAssignment({ falRoot, spec, specSha256, original, boardGuidance, identityHash, objectSha256 }) {
  need(spec?.status === 'prepared_not_dispatched' && /^[a-f0-9]{64}$/.test(specSha256 ?? ''), 'prepared zone-repair spec required');
  need(original?.image_id && original.assignment_sha256, 'the page owner\'s accepted Fal assignment is required');
  const stem = zoneRepairStem(spec), p = zoneRepairAssignmentPaths(falRoot, stem);
  const board = Boolean(original.board_path);
  const prompt = board ? `${spec.prompt}\n\n${boardGuidance}` : spec.prompt;
  const core = {
    image_id: spec.zone_owner_image_id, endpoint: original.endpoint, prompt, prompt_sha256: sha(prompt), run_identity_sha256: identityHash,
    reference_mode: original.reference_mode, reference_asset_ids: original.reference_asset_ids ?? [], reference_hashes: original.reference_hashes ?? [],
    board_path: original.board_path ?? null, board_sha256: original.board_sha256 ?? null, board_manifest_path: original.board_manifest_path ?? null,
    max_cost_usd: spec.max_cost_usd, zone_repair_spec_sha256: specSha256, zone_repair_image_ids: spec.image_ids,
    previous_assignment_sha256: original.assignment_sha256, repair_reason: spec.request.reason,
  };
  return { ...core, assignment_sha256: objectSha256(JSON.stringify(core)), ...p, stem };
}

/** Next exact step for every prepared zone repair; no provider is contacted. */
export async function panelZoneRepairState({ episodeDir }) {
  const falRoot = path.join(episodeDir, 'fal'), zonesDir = path.join(falRoot, 'zone-repair'), rows = [];
  const zones = await fs.readdir(zonesDir, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const reserved = new Set(['assignments', 'submission-receipts', 'submission-receipts-attempts', 'result-receipts', 'outputs', 'upload-receipts', 'failure-receipts', 'transport-holds']);
  for (const zone of zones.filter(entry => entry.isDirectory() && !reserved.has(entry.name))) {
    for (const attempt of await fs.readdir(path.join(zonesDir, zone.name), { withFileTypes: true })) {
      const specPath = path.join(zonesDir, zone.name, attempt.name, 'spec.json');
      const spec = attempt.isDirectory() ? await readOptional(specPath) : null;
      if (!spec) continue;
      const stem = zoneRepairStem(spec), p = zoneRepairAssignmentPaths(falRoot, stem);
      const has = file => fs.access(file).then(() => true, () => false);
      const state = await has(path.join(path.dirname(specPath), 'applied', 'receipt.json')) ? 'applied'
        : await has(p.failure_receipt_path) ? 'failed'
          : await has(p.result_receipt_path) ? 'complete'
            : await has(p.submission_receipt_path) ? 'submitted'
              // An attempt without a request receipt may have been billed: hold for triage, never resubmit.
              : await has(path.join(`${path.dirname(p.submission_receipt_path)}-attempts`, path.basename(p.submission_receipt_path))) ? 'ambiguous_submission' : 'prepared';
      const next = { prepared: 'dispatch-zone-repair', submitted: 'observe-zone-repair', complete: 'apply-zone-repair', failed: null, applied: null, ambiguous_submission: null }[state];
      rows.push({ zone_id: spec.request.zone_id, image_ids: spec.image_ids, spec_path: specPath, stem, state, next_action: next });
    }
  }
  return rows;
}
