import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PAGE_TEMPLATES, PAGE_GEOMETRY_DETECTOR_VERSION, writePageGeometry } from './panel-page-geometry.mjs';
import { pageFrameText, pagePanelHeadings, pagePromptFindings } from './panel-page-prompts.mjs';
import { buildReferenceBoard, pageReferenceBoardPromptGuidance } from './openart-reference-board.mjs';
import { falPortableAssetId } from './fal-portable-bank.mjs';
import { FAL_ENDPOINTS, FAL_PAGE_CANVAS_SIZES, uploadFalReference, submitFalImage, observeFalImage } from './fal-provider.mjs';

// Private multi-zone page proof. It reads one accepted run read-only, re-draws
// only authored page orders, and never writes to the source episode or
// satisfies a production stage. Paid dispatch needs an exact token and stays
// inside the locked request ceiling; there is no automatic retry or failover.
export const MULTIZONE_PROOF_PLAN_SCHEMA = 'goldflow_multizone_proof_page_plan_v1';
export const MULTIZONE_PROOF_IDENTITY_SCHEMA = 'goldflow_multizone_proof_identity_v1';
export const MULTIZONE_PROOF_SPEND_TOKEN = 'exact_fal_multizone_page_proof';
const MAX_COST_PER_REQUEST_USD = 0.05;
const REPAIR_ALLOWANCE = 3;

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const need = (value, message) => { if (!value) throw new Error(`Multi-zone proof: ${message}`); };
const sha = value => createHash('sha256').update(value).digest('hex');
const fileSha = async file => sha(await fs.readFile(file));
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = file => fs.access(file).then(() => true, () => false);
const text = (value, min = 1) => typeof value === 'string' && value.trim().length >= min;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const writeNew = (file, value) => fs.writeFile(file, json(value), { flag: 'wx' });

async function assertProofLocation(proofDir) {
  need(path.isAbsolute(proofDir ?? ''), 'absolute proof directory required');
  need(!path.resolve(proofDir).split(path.sep).includes('episodes'), 'proofs stay outside episode directories');
  for (let dir = path.resolve(proofDir); ; dir = path.dirname(dir)) {
    need(!await exists(path.join(dir, 'run_identity.json')), 'proofs cannot live inside an episode');
    if (path.dirname(dir) === dir) break;
  }
}

async function cleanCommit({ allowDirtyWorktree = false, dirtyReason = '' } = {}) {
  const options = { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 };
  const [status, commit] = await Promise.all([exec('git', ['status', '--porcelain'], options), exec('git', ['rev-parse', 'HEAD'], options)]);
  const dirty = Boolean(status.stdout.trim());
  need(!dirty || (allowDirtyWorktree === true && text(dirtyReason, 16)), 'proof preparation requires a clean committed worktree');
  return { commit: commit.stdout.trim(), dirty, dirty_reason: dirty ? dirtyReason : null };
}

/** Validates the authored plan against the source run; returns resolved pages. */
export async function resolveMultizoneProofPlan(plan) {
  need(plan?.schema === MULTIZONE_PROOF_PLAN_SCHEMA && /^[a-z0-9][a-z0-9-]*$/.test(plan.proof_id ?? ''), 'unsupported plan schema or proof id');
  need(text(plan.author) && text(plan.editorial_note, 40) && path.isAbsolute(plan.source_episode_dir ?? ''), 'author, editorial note and absolute source episode required');
  const source = plan.source_episode_dir;
  const identity = await read(path.join(source, 'run_identity.json'));
  need(identity.image_provider === 'fal_ai' && identity.render_profile === 'panel_composition_v1', 'source must be a Fal panel-composition run');
  const prompts = (await read(path.join(source, 'section_image_prompts_hardened.json'))).prompts;
  const approval = await read(path.join(source, `visual_reference_approval_${identity.episode}.json`));
  need(approval.status === 'approved', 'source references must be approved');
  // An explicit page subset (e.g. a canvas-size comparison) re-draws only the
  // named pages; full coverage of every owner is then not claimed.
  const subset = plan.page_ids ? new Set(plan.page_ids) : null;
  if (plan.canvas) need(FAL_PAGE_CANVAS_SIZES.some(row => row.width === plan.canvas.width && row.height === plan.canvas.height), 'unsupported canvas');
  const scenes = new Set(plan.scene_ids ?? []);
  const owners = new Map(prompts.filter(row => scenes.has(row.scene_id) && row.provider_submission_required !== false).map(row => [row.image_id, row]));
  need(owners.size > 0, 'no source owners in the proof scenes');
  const covered = new Set();
  const claim = id => { need(owners.has(id) && !covered.has(id), `owner ${id} is unknown, outside the scenes, or used twice`); covered.add(id); };
  for (const single of subset ? [] : plan.reused_singles ?? []) { claim(single.source_image_id); need(text(single.reason, 10), `reuse reason required for ${single.source_image_id}`); }
  const pageIds = new Set(), pages = [];
  for (const page of (plan.pages ?? []).filter(row => !subset || subset.has(row.page_id))) {
    need(/^[a-z0-9][a-z0-9_]*$/.test(page.page_id ?? '') && !pageIds.has(page.page_id), 'unique safe page ids required'); pageIds.add(page.page_id);
    const template = PAGE_TEMPLATES[page.template];
    need(template && Array.isArray(page.zones) && page.zones.length === template.length, `${page.page_id} needs exactly the ${page.template} zones`);
    need(text(page.shared_context, 40) && Array.isArray(page.visible_people) && Array.isArray(page.ref_ids), `${page.page_id} needs shared context, visible people and refs`);
    const zones = template.map(({ slot }) => {
      const zone = page.zones.find(row => row.slot === slot);
      need(zone && text(zone.section, 40), `${page.page_id} needs an authored ${slot} section`);
      claim(zone.source_image_id);
      const owner = owners.get(zone.source_image_id);
      need(owner.scene_id === page.scene_id, `${zone.source_image_id} is not in ${page.scene_id}`);
      const beats = prompts.filter(row => row.panel_asset_id === owner.panel_asset_id).map(row => row.image_id);
      return { zone_id: `${page.page_id}_${slot}`, slot, source_image_id: owner.image_id, source_panel_asset_id: owner.panel_asset_id, beat_image_ids: beats, section: zone.section.trim() };
    });
    // Page references must be approved references already used by its zones' owners.
    const available = new Map(page.zones.flatMap(zone => (owners.get(zone.source_image_id).reference_requirements ?? []).map(ref => [ref.ref_id, ref])));
    const refs = [];
    for (const refId of page.ref_ids) {
      const ref = available.get(refId);
      need(ref, `${page.page_id} reference ${refId} is not used by any of its zone owners`);
      const localPath = ref.reference_image_path ?? ref.conditioning_image_path, approved = approval.reference_hash_by_ref_id?.[refId];
      need(path.isAbsolute(localPath ?? '') && /^[a-f0-9]{64}$/.test(approved ?? '') && await fileSha(localPath) === approved, `${page.page_id} reference ${refId} is not hash-approved`);
      refs.push({ ref_id: refId, kind: ref.kind ?? 'asset', asset_id: falPortableAssetId(identity.series_slug, { ref_id: refId, kind: ref.kind ?? 'asset' }), asset_class: ref.kind ?? 'asset', path: localPath, sha256: approved });
    }
    const headings = pagePanelHeadings({ page_template: page.template });
    const providerPrompt = [pageFrameText(page.template), page.shared_context.trim(), zones.map((zone, i) => `${headings[i]} ${zone.section}`).join('\n')].join('\n\n');
    const findings = pagePromptFindings({ image_id: page.page_id, provider_prompt: providerPrompt, reference_requirements: refs, shot_manifest: { visible_characters: page.visible_people } }, { asset_id: page.page_id, kind: 'page', page_template: page.template });
    need(!findings.length, `${page.page_id} page prompt fails: ${findings.map(row => row.code).join(', ')}`);
    pages.push({ page_id: page.page_id, scene_id: page.scene_id, template: page.template, refs, visible_people: page.visible_people, provider_prompt: providerPrompt, zones });
  }
  if (subset) need(pages.length === subset.size, 'every named page id must exist');
  const missing = subset ? [] : [...owners.keys()].filter(id => !covered.has(id));
  need(!missing.length, `every source owner must be paged or reused: ${missing.join(', ')}`);
  return { identity, pages, reused: subset ? [] : plan.reused_singles, owners: owners.size, subset: subset ? [...subset] : null, canvas: plan.canvas ?? null };
}

export function proofPaths(proofDir, pageId) {
  return {
    assignment_path: path.join(proofDir, 'assignments', `${pageId}.json`),
    submission_receipt_path: path.join(proofDir, 'submission-receipts', `${pageId}.json`),
    result_receipt_path: path.join(proofDir, 'result-receipts', `${pageId}.json`),
    output_path: path.join(proofDir, 'outputs', `${pageId}.png`),
    upload_receipt_path: path.join(proofDir, 'upload-receipts', `${pageId}.json`),
    geometry_dir: path.join(proofDir, 'geometry', pageId),
  };
}

/** No provider call: validates, builds boards and exact assignments, locks the ceiling. */
export async function prepareMultizoneProof({ planPath, proofDir, allowDirtyWorktree = false, dirtyReason = '' }) {
  await assertProofLocation(proofDir);
  need(path.isAbsolute(planPath ?? ''), 'absolute plan path required');
  need(!await exists(path.join(proofDir, 'proof_identity.json')), 'proof already prepared; prepared proofs are immutable');
  const plan = await read(planPath), resolved = await resolveMultizoneProofPlan(plan);
  const code = await cleanCommit({ allowDirtyWorktree, dirtyReason });
  const source = plan.source_episode_dir;
  const sourceHashes = {};
  for (const name of ['run_identity.json', 'section_image_prompts_hardened.json', `visual_reference_approval_${resolved.identity.episode}.json`]) sourceHashes[path.join(source, name)] = await fileSha(path.join(source, name));
  sourceHashes[planPath] = await fileSha(planPath);
  const identity = {
    schema: MULTIZONE_PROOF_IDENTITY_SCHEMA, proof_id: plan.proof_id, intent: 'private_proof', production_eligible: false,
    source_episode_dir: source, source_hashes: sourceHashes, code,
    provider: { endpoint_with_refs: FAL_ENDPOINTS.primary_edit, endpoint_text: FAL_ENDPOINTS.primary_text, quality: 'low', width: resolved.canvas?.width ?? 1920, height: resolved.canvas?.height ?? 1080, automatic_creative_retry: false, automatic_failover: false },
    page_subset: resolved.subset,
    page_count: resolved.pages.length, zone_count: resolved.pages.reduce((n, page) => n + page.zones.length, 0),
    source_owner_count: resolved.owners, reused_single_count: resolved.reused.length,
    max_requests: resolved.pages.length + REPAIR_ALLOWANCE, max_cost_per_request_usd: MAX_COST_PER_REQUEST_USD,
    cost_ceiling_usd: Math.round((resolved.pages.length + REPAIR_ALLOWANCE) * MAX_COST_PER_REQUEST_USD * 100) / 100,
    spend_token: MULTIZONE_PROOF_SPEND_TOKEN, created_at: new Date().toISOString(),
  };
  await fs.mkdir(proofDir, { recursive: true });
  await writeNew(path.join(proofDir, 'proof_identity.json'), identity);
  const identitySha256 = await fileSha(path.join(proofDir, 'proof_identity.json'));
  const assignments = [];
  for (const page of resolved.pages) {
    const board = page.refs.length ? await buildReferenceBoard({ root: proofDir, imageId: page.page_id, references: page.refs }) : null;
    const prompt = board ? `${page.provider_prompt}\n\n${pageReferenceBoardPromptGuidance(board)}` : page.provider_prompt;
    const core = {
      proof_id: plan.proof_id, image_id: page.page_id, panel_page_template: page.template, scene_id: page.scene_id,
      endpoint: board ? FAL_ENDPOINTS.primary_edit : FAL_ENDPOINTS.primary_text, prompt, prompt_sha256: sha(prompt), run_identity_sha256: identitySha256,
      reference_mode: board ? 'one_positional_collage' : 'text_only', reference_asset_ids: page.refs.map(ref => ref.asset_id), reference_hashes: page.refs.map(ref => ref.sha256),
      board_path: board?.output_path ?? null, board_sha256: board?.output_sha256 ?? null, board_manifest_path: board?.manifest_path ?? null,
      max_cost_usd: MAX_COST_PER_REQUEST_USD, visible_people: page.visible_people, zones: page.zones,
      ...(resolved.canvas ? { image_size: { width: resolved.canvas.width, height: resolved.canvas.height } } : {}),
    };
    const assignment = { ...core, assignment_sha256: sha(JSON.stringify(core)), ...proofPaths(proofDir, page.page_id) };
    await fs.mkdir(path.dirname(assignment.assignment_path), { recursive: true });
    await writeNew(assignment.assignment_path, assignment);
    assignments.push(assignment);
  }
  const report = { schema: 'goldflow_multizone_proof_preparation_v1', status: 'prepared_not_dispatched', proof_id: plan.proof_id, proof_identity_sha256: identitySha256, pages: assignments.map(row => ({ page_id: row.image_id, template: row.panel_page_template, zones: row.zones.length, references: row.reference_asset_ids.length, assignment_sha256: row.assignment_sha256, prompt_chars: row.prompt.length })), provider_calls: 0, cost_usd: 0, created_at: new Date().toISOString() };
  await writeNew(path.join(proofDir, 'preparation_report.json'), report);
  return { ...report, identity, assignments };
}

async function loadPrepared(proofDir) {
  const identityPath = path.join(proofDir, 'proof_identity.json'), identity = await read(identityPath);
  need(identity.schema === MULTIZONE_PROOF_IDENTITY_SCHEMA && identity.production_eligible === false, 'prepared private proof identity required');
  for (const [file, hash] of Object.entries(identity.source_hashes)) need(await fileSha(file) === hash, `proof source changed: ${file}`);
  const identitySha256 = await fileSha(identityPath);
  const assignments = [];
  for (const name of (await fs.readdir(path.join(proofDir, 'assignments'))).filter(row => row.endsWith('.json')).sort()) {
    const row = await read(path.join(proofDir, 'assignments', name));
    const { assignment_sha256, assignment_path, submission_receipt_path, result_receipt_path, output_path, upload_receipt_path, geometry_dir, ...core } = row;
    need(row.run_identity_sha256 === identitySha256 && sha(JSON.stringify(core)) === assignment_sha256, `assignment changed: ${name}`);
    if (row.board_path) need(await fileSha(row.board_path) === row.board_sha256, `reference board changed: ${name}`);
    assignments.push(row);
  }
  return { identity, identitySha256, assignments };
}

/** Paid: submits not-yet-submitted pages, one attempt each, within the ceiling. */
export async function dispatchMultizoneProof({ proofDir, confirmSpend, pageIds = null }) {
  need(confirmSpend === MULTIZONE_PROOF_SPEND_TOKEN, `paid proof dispatch requires --confirm-spend ${MULTIZONE_PROOF_SPEND_TOKEN}`);
  const { identity, assignments } = await loadPrepared(proofDir);
  const lock = path.join(proofDir, 'paid-dispatch.lock');
  await fs.mkdir(lock).catch(error => { throw error.code === 'EEXIST' ? new Error('Multi-zone proof: dispatch already active or interrupted; inspect attempts first') : error; });
  try {
    const attempted = async row => await exists(row.submission_receipt_path) || await exists(path.join(proofDir, 'submission-receipts-attempts', path.basename(row.submission_receipt_path)));
    let used = 0; for (const row of assignments) if (await attempted(row)) used++;
    const pending = [];
    for (const row of assignments.filter(item => !pageIds || pageIds.includes(item.image_id))) if (!await attempted(row)) pending.push(row);
    need(used + pending.length <= identity.max_requests, `request ceiling ${identity.max_requests} would be exceeded`);
    const submitted = [];
    for (const row of pending) {
      const upload = row.board_path ? await uploadFalReference({ localPath: row.board_path, expectedSha256: row.board_sha256, receiptPath: row.upload_receipt_path }) : null;
      try { submitted.push((await submitFalImage({ assignment: row, referenceUrls: upload ? [upload.remoteUrl] : [], receiptPath: row.submission_receipt_path })).requestId); }
      finally { if (upload) upload.remoteUrl = null; }
    }
    return { status: 'submitted', submitted: submitted.length, requests_used: used + pending.length, max_requests: identity.max_requests };
  } finally { await fs.rmdir(lock); }
}

/** Observes submitted pages and measures each completed page's geometry. */
export async function observeMultizoneProof({ proofDir }) {
  const { assignments } = await loadPrepared(proofDir), rows = [];
  for (const row of assignments) {
    if (!await exists(row.submission_receipt_path)) { rows.push({ page_id: row.image_id, state: 'not_submitted' }); continue; }
    if (!await exists(row.result_receipt_path)) {
      const receipt = await read(row.submission_receipt_path);
      const result = await observeFalImage({ endpoint: receipt.endpoint, requestId: receipt.request_id, outputPath: row.output_path, receiptPath: row.result_receipt_path, expectedSize: row.image_size });
      if (!result.complete) { rows.push({ page_id: row.image_id, state: 'pending' }); continue; }
    }
    // Receipts are per detector version, so a policy change re-measures without overwriting evidence.
    const geometryDir = path.join(proofDir, 'geometry', PAGE_GEOMETRY_DETECTOR_VERSION, row.image_id), geometryPath = path.join(geometryDir, 'page_geometry.json');
    const geometry = await exists(geometryPath) ? await read(geometryPath) : await writePageGeometry({ imagePath: row.output_path, template: row.panel_page_template, outputDir: geometryDir });
    rows.push({ page_id: row.image_id, state: 'complete', geometry_status: geometry.status, findings: geometry.findings });
  }
  return { status: rows.every(row => row.state === 'complete') ? 'complete' : 'pending', pages: rows };
}
