#!/usr/bin/env node
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  readJson, writeOnce, atomicJson, jsonBytes, sha256, fileHash, validateCatalog, registerCatalog,
  loadBank, currentAsset, verifyAsset, resolveReferences, addCanonicalResult, reviewCanonicalAssets,
  synchronizeLibraryRecord, PRIMARY_MODEL, safeId,
} from './lib/openart-asset-bank.mjs';
import { bindOpenArtShots, hardenOpenArtShots } from './lib/openart-shot-binding.mjs';
import { openartContext, bankPhase, listAssignments, refsApprovalCurrent, referenceWorkerPool } from './lib/openart-production-state.mjs';

function requireValue(value, message) { if (!value) throw new Error(message); return value; }
function exact(actual, expected, message) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message); }
function refsCore(refs) { return refs.map(({ asset_id, sha256: hash, openart_asset_id }) => ({ asset_id, sha256: hash, openart_asset_id })); }
async function withEpisodeLock(context, fn) {
  await fs.mkdir(context.root, { recursive: true });
  const lock = path.join(context.root, '.dispatch-lock');
  let handle; const deadline = Date.now() + 10_000;
  while (!handle) {
    try { handle = await fs.open(lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Another OpenArt mutation remained active; inspect its result before retrying.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return await fn(); }
  finally { await handle.close(); await fs.unlink(lock); }
}
function pinnedRefs(refs) {
  return refs.map((ref) => ({ asset_id: ref.asset_id, version: ref.version, sha256: ref.sha256, openart_asset_id: ref.openart_asset_id, openart_library_asset_id: ref.openart_library_asset_id }));
}
async function validateDispatch(context, assignment) {
  await requirePlanApproval(context);
  if (assignment.scope === 'scene') await requireRefsApproval(context);
  else {
    const phase = await bankPhase(context);
    const expected = assignment.scope === 'canonical' ? context.catalog.assets.find((row) => row.asset_id === assignment.asset_id)?.phase : 'validation';
    if (phase.phase !== expected) throw new Error('Assignment is outside the current approved production phase.');
  }
  const attempts = (await listAssignments(context.root)).filter((row) => row.scope === assignment.scope && row.asset_id === assignment.asset_id);
  if (attempts.at(-1)?.assignment_id !== assignment.assignment_id || attempts.at(-1)?.failure || attempts.at(-1)?.receipt) throw new Error('Assignment has been superseded, failed or already completed.');
  const fresh = await resolveReferences(context.bankRoot, assignment.reference_bindings.map((row) => row.asset_id), { maxReferences: context.contract.max_reference_count, extraReferenceReason: assignment.extra_reference_reason });
  exact(pinnedRefs(fresh), pinnedRefs(assignment.reference_bindings), 'Assigned reference approval/version/native library identity has changed.');
}
async function event(root, value) {
  await fs.mkdir(root, { recursive: true });
  await fs.appendFile(path.join(root, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);
}
async function requirePlanApproval(context) {
  const approval = await readJson(path.join(context.root, 'plan-approval.json'));
  if (!approval?.approved || approval.source_sha256 !== await fileHash(context.planPath ?? path.join(context.root, 'bank-plan.json'))) throw new Error('Current canonical plan approval is required.');
}
async function requireRefsApproval(context) {
  if (!await refsApprovalCurrent(context)) throw new Error('Current exact canonical bank approval is required.');
  if ((await bankPhase(context)).phase !== 'complete') throw new Error('Reference bank or validation is incomplete.');
}
async function loadAssignment(context, assignmentPath) {
  if (!assignmentPath || path.dirname(path.resolve(assignmentPath)) !== path.join(context.root, 'assignments')) throw new Error('Assignment must belong to this episode.');
  const assignment = await readJson(assignmentPath);
  if (assignment?.schema !== 'goldflow_openart_assignment_v1' || assignment.identity_sha256 !== await fileHash(path.join(context.episodeDir, 'run_identity.json'))) throw new Error('Assignment identity binding is stale.');
  if (assignment.catalog_sha256 !== context.plan.catalog_sha256) throw new Error('Assignment catalog binding is stale.');
  exact(assignment.params, { quality: 'low', resolution: '1k', aspect_ratio: '16:9' }, 'Assignment changed the locked Low/1K/16:9 parameters.');
  if (assignment.transport !== context.contract.transport || sha256(assignment.prompt) !== assignment.prompt_sha256) throw new Error('Assignment prompt or transport binding changed.');
  let item;
  if (assignment.scope === 'canonical') item = context.catalog.assets.find((row) => row.asset_id === assignment.asset_id);
  else if (assignment.scope === 'validation') item = context.catalog.validation_shots.find((row) => row.image_id === assignment.asset_id);
  else if (assignment.scope === 'scene') {
    const planPath = path.join(context.episodeDir, 'section_image_prompts_hardened.json');
    if (assignment.prompt_plan_sha256 !== await fileHash(planPath)) throw new Error('Assignment shot plan is stale.');
    item = (await readJson(planPath)).prompts.find((row) => row.image_id === assignment.asset_id);
  }
  if (!item || assignment.prompt !== (item.provider_prompt ?? item.prompt)) throw new Error('Assignment does not equal the approved authored prompt.');
  exact(assignment.reference_bindings.map((row) => row.asset_id), item.reference_asset_ids ?? [], 'Assignment reference order changed.');
  for (const ref of assignment.reference_bindings) if (await fileHash(ref.path) !== ref.sha256) throw new Error(`Assigned reference changed: ${ref.asset_id}`);
  if (assignment.model_id !== PRIMARY_MODEL) {
    const repair = assignment.repair_evidence;
    const prior = (await listAssignments(context.root)).find((row) => row.assignment_id === assignment.previous_assignment_id);
    if (assignment.scope === 'canonical' || !context.contract.repair_models.some((row) => (typeof row === 'string' ? row : row.model_id) === assignment.model_id) || !repair?.primary_failure_unresolved || !prior || prior.asset_id !== assignment.asset_id || prior.scope !== assignment.scope || repair.prior_assignment_id !== prior.assignment_id || (!prior.failure && (!repair.rejected_output_sha256 || repair.rejected_output_sha256 !== prior.receipt?.sha256))) throw new Error('Unapproved repair fallback model or missing exact prior failure.');
  }
  return assignment;
}
export async function planBank(context, catalogPath) {
  if (context.plan) throw new Error('Canonical plan is immutable; use a named revision for changed creative scope.');
  const catalog = validateCatalog(await readJson(catalogPath));
  if (catalog.source_script_sha256 !== await fileHash(path.join(context.episodeDir, 'script_clean.md'))) throw new Error('Catalog is not bound to the approved episode script.');
  const target = path.join(context.root, 'catalog.json');
  await writeOnce(target, catalog);
  const bankPlan = {
    schema: 'goldflow_openart_bank_plan_v1', catalog_path: target, catalog_sha256: await fileHash(target),
    identity_sha256: await fileHash(path.join(context.episodeDir, 'run_identity.json')),
    source_script_sha256: catalog.source_script_sha256, asset_count: catalog.assets.length,
    validation_count: catalog.validation_shots.length, historical_images_accepted: 0,
    created_at: new Date().toISOString(),
  };
  await writeOnce(path.join(context.root, 'bank-plan.json'), bankPlan);
  await registerCatalog(context.bankRoot, catalog, target);
  await event(context.root, { event: 'bank_planned', catalog_sha256: bankPlan.catalog_sha256 });
  return bankPlan;
}
async function approvePlan(context, flags) {
  requireValue(context.plan, 'Bank plan missing.');
  requireValue(flags.reviewer, 'Reviewer required.'); requireValue(flags.note, 'Concrete creative review note required.');
  const record = {
    schema: 'goldflow_openart_plan_approval_v1', approved: true, reviewer: flags.reviewer, note: flags.note,
    source_sha256: await fileHash(context.planPath ?? path.join(context.root, 'bank-plan.json')), revision: context.plan.revision ?? 1, at: new Date().toISOString(),
  };
  const immutable = path.join(context.root, 'plan-approvals', `${Date.now()}-${randomUUID()}.json`);
  await writeOnce(immutable, record);
  return atomicJson(path.join(context.root, 'plan-approval.json'), { ...record, immutable_path: immutable, immutable_sha256: await fileHash(immutable) });
}

async function revisePlan(context, flags) {
  requireValue(context.plan, 'Existing bank plan required.');
  requireValue(flags.catalog, '--catalog required');
  requireValue(flags.reviewer, '--reviewer required');
  requireValue(flags.note, '--note required');
  if (flags.note.trim().length < 20) throw new Error('Catalog revision needs a concrete reason.');
  const catalogPath = path.resolve(flags.catalog);
  const catalog = validateCatalog(await readJson(catalogPath));
  if (catalog.source_script_sha256 !== context.plan.source_script_sha256) throw new Error('Catalog revision cannot change the approved script binding.');
  const oldJoey = context.catalog.assets.find((row) => row.phase === 'joey');
  const newJoey = catalog.assets.find((row) => row.phase === 'joey');
  for (const key of ['asset_id', 'prompt', 'model_id', 'mode']) if (oldJoey?.[key] !== newJoey?.[key]) throw new Error('An approved universal Joey identity cannot change through a catalog taxonomy revision.');
  const revision = (context.plan.revision ?? 1) + 1;
  const admittedCatalog = path.join(context.root, 'catalog-revisions', `catalog-r${String(revision).padStart(3, '0')}.json`);
  await writeOnce(admittedCatalog, catalog);
  const plan = {
    ...context.plan,
    revision,
    catalog_path: admittedCatalog,
    catalog_sha256: await fileHash(admittedCatalog),
    asset_count: catalog.assets.length,
    validation_count: catalog.validation_shots.length,
    supersedes_plan_path: context.planPath,
    supersedes_plan_sha256: await fileHash(context.planPath),
    revision_reason: flags.note,
    revised_by: flags.reviewer,
    created_at: new Date().toISOString(),
  };
  const planPath = path.join(context.root, 'bank-plan-revisions', `bank-plan-r${String(revision).padStart(3, '0')}.json`);
  await writeOnce(planPath, plan);
  await registerCatalog(context.bankRoot, catalog, admittedCatalog);
  await atomicJson(path.join(context.root, 'bank-plan-current.json'), { schema: 'goldflow_openart_bank_plan_pointer_v1', revision, plan_path: planPath, plan_sha256: await fileHash(planPath), updated_at: new Date().toISOString() });
  await atomicJson(path.join(context.root, 'plan-approval.json'), { schema: 'goldflow_openart_plan_approval_v1', approved: false, revision, source_sha256: await fileHash(planPath), reason: 'revised_plan_requires_review' });
  await event(context.root, { event: 'bank_plan_revised', revision, catalog_sha256: plan.catalog_sha256, supersedes_plan_sha256: plan.supersedes_plan_sha256 });
  return { status: 'revised_requires_approval', revision, plan_path: planPath, catalog_path: admittedCatalog, catalog_sha256: plan.catalog_sha256 };
}
export async function prepareAssignments(context, flags) { return withEpisodeLock(context, () => prepareAssignmentsUnlocked(context, flags)); }
async function prepareAssignmentsUnlocked(context, flags) {
  await requirePlanApproval(context);
  const scope = flags.scope ?? (flags['references-only'] === 'true' ? 'canonical' : 'scene');
  const ids = String(flags['asset-ids'] ?? flags['image-ids'] ?? '').split(',').filter(Boolean);
  if (!ids.length) throw new Error('Explicit asset/image IDs required; unscoped whole-stage generation is forbidden.');
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate IDs cannot prepare multiple attempts.');
  const providerLimit = context.contract.transport === 'openart_cli_v1' ? 32 : 8;
  const assignmentLimit = Math.min(providerLimit, Number(context.contract.concurrency));
  if (ids.length > assignmentLimit) throw new Error(`Prepare at most ${assignmentLimit} exact assignments for this identity-locked transport.`);
  const phase = await bankPhase(context);
  if (scope !== 'scene' && !['joey', 'core', 'validation', 'remaining'].includes(phase.phase)) throw new Error('No pending canonical phase.');
  if (scope === 'validation' && phase.phase !== 'validation') throw new Error('Joey and the core bank must pass review and native library registration before validation.');
  if (scope === 'scene') await requireRefsApproval(context);
  const shots = scope === 'scene' ? await readJson(path.join(context.episodeDir, 'section_image_prompts_hardened.json')) : null;
  const attempts = (await listAssignments(context.root)).filter((row) => row.catalog_sha256 === context.plan.catalog_sha256); const prepared = [];
  const repair = flags.repair ? await readJson(flags.repair) : null;
  for (const id of ids) {
    safeId(id);
    const item = scope === 'canonical' ? context.catalog.assets.find((row) => row.asset_id === id)
      : scope === 'validation' ? context.catalog.validation_shots.find((row) => row.image_id === id)
      : shots?.prompts?.find((row) => row.image_id === id);
    if (!item) throw new Error(`Unknown ${scope} ID ${id}`);
    if (scope === 'canonical' && item.phase !== phase.phase) throw new Error(`Canonical generation must remain in phase ${phase.phase}`);
    const prior = attempts.filter((row) => row.asset_id === id && row.scope === scope).at(-1);
    if (prior) {
      if (!repair || repair.asset_id !== id || repair.prior_assignment_id !== prior.assignment_id || !repair.reason || !repair.reviewer) throw new Error(`Existing attempt requires reviewed exact-ID repair: ${id}`);
      if (!prior.failure && !repair.rejected_output_sha256) throw new Error('Repair requires failed submission or a visually rejected exact output hash.');
      if (repair.rejected_output_sha256 && repair.rejected_output_sha256 !== prior.receipt?.sha256) throw new Error('Repair rejection hash mismatch.');
    }
    if (repair && !prior) throw new Error('Repair requires an existing exact prior assignment and failure evidence.');
    const model = repair?.model_id ?? PRIMARY_MODEL;
    if (model !== PRIMARY_MODEL && (scope === 'canonical' || !context.contract.repair_models.some((row) => (typeof row === 'string' ? row : row.model_id) === model) || !repair.primary_failure_unresolved)) throw new Error('Fallback is allowed only for reviewed exact scene/validation IDs GPT Image 2.5 could not resolve.');
    const referenceIds = item.reference_asset_ids ?? [];
    const refs = await resolveReferences(context.bankRoot, referenceIds, { maxReferences: context.contract.max_reference_count, extraReferenceReason: item.extra_reference_reason });
    if (scope === 'scene') exact(pinnedRefs(refs), pinnedRefs(item.reference_bindings ?? []), 'Current references differ from the hardened shot bindings. Rebind and review the affected plan.');
    const prompt = item.provider_prompt ?? item.prompt;
    requireValue(prompt, 'Authored prompt missing.');
    const assignmentId = `${id}--${randomUUID()}`;
    const assignment = {
      schema: 'goldflow_openart_assignment_v1', assignment_id: assignmentId, asset_id: id, scope,
      identity_sha256: await fileHash(path.join(context.episodeDir, 'run_identity.json')),
      catalog_sha256: context.plan.catalog_sha256, prompt, prompt_sha256: sha256(prompt),
      model_id: model, mode: refs.length ? 'image2image' : 'text2image',
      params: { quality: 'low', resolution: '1k', aspect_ratio: '16:9' },
      reference_bindings: refs, extra_reference_reason: item.extra_reference_reason ?? null,
      prompt_plan_sha256: shots ? await fileHash(path.join(context.episodeDir, 'section_image_prompts_hardened.json')) : null,
      intended_native_library_kind: item.openart_library_kind ?? null,
      transport: context.contract.transport, max_credit_cost: context.contract.max_credit_cost,
      automatic_retry: false, previous_assignment_id: prior?.assignment_id ?? null,
      repair_evidence: repair, created_at: new Date().toISOString(),
    };
    const target = path.join(context.root, 'assignments', `${assignmentId}.json`);
    await writeOnce(target, assignment);
    await event(context.root, { event: 'assignment_prepared', asset_id: id, scope, assignment_path: target, sha256: await fileHash(target) });
    prepared.push({ assignment_path: target, ...assignment });
  }
  return { status: 'prepared_not_submitted', assignments: prepared };
}
export async function prepareReadyReferenceAssignments(context, flags) {
  return withEpisodeLock(context, async () => {
    await requirePlanApproval(context);
    const pool = await referenceWorkerPool(context, { maxWorkers: flags['max-workers'] });
    if (pool.blocked_by) throw new Error(`Reference worker pool is blocked by ${pool.blocked_by}.`);
    if (!pool.ready_ids.length) return { status: pool.workers.length ? 'workers_already_active' : 'no_independent_references_ready', worker_pool: pool, assignments: [] };
    const result = await prepareAssignmentsUnlocked(context, {
      ...flags,
      scope: pool.scope,
      'asset-ids': pool.ready_ids.join(','),
      'image-ids': pool.ready_ids.join(','),
    });
    await event(context.root, { event: 'reference_worker_pool_prepared', phase: pool.phase, max_workers: pool.max_workers, assignment_ids: result.assignments.map((row) => row.assignment_id) });
    return { ...result, status: 'reference_workers_prepared_not_submitted', worker_pool: await referenceWorkerPool(context, { maxWorkers: pool.max_workers }) };
  });
}
export async function markSubmitted(context, flags) { return withEpisodeLock(context, () => markSubmittedUnlocked(context, flags)); }
async function markSubmittedUnlocked(context, flags) {
  const assignment = await loadAssignment(context, flags.assignment);
  await validateDispatch(context, assignment);
  const observed = await readJson(flags['ui-receipt']);
  if (observed?.attestation !== 'exact_prompt_settings_and_ordered_references_visibly_verified' || !observed.reviewer) throw new Error('Browser dispatch needs actual visible pre-submit verification.');
  exact(observed.params, assignment.params, 'Visible generation settings differ from immutable assignment.');
  if (observed.model_id !== assignment.model_id || observed.prompt_sha256 !== assignment.prompt_sha256) throw new Error('Visible model/prompt differs from assignment.');
  exact(observed.references, refsCore(assignment.reference_bindings), 'Visible ordered reference list differs from assignment.');
  if (observed.image_count !== 1) throw new Error('Exactly one creative output per assignment.');
  const quote = observed.credits_quoted;
  if (!Number.isFinite(quote) || quote < 0 || quote > context.contract.max_credit_cost) throw new Error('Current displayed credit quote exceeds request limit or is missing.');
  const observedAt = Date.parse(observed.observed_at);
  if (!Number.isFinite(observedAt) || observedAt > Date.now() + 1000 || Date.now() - observedAt > 15 * 60 * 1000) throw new Error('Live visible quote timestamp is invalid, future or stale.');
  if (!Number.isFinite(observed.account_credits_available) || observed.account_credits_available < quote) throw new Error('Account balance cannot cover the current quote.');
  const assignments = await listAssignments(context.root);
  const committed = assignments.reduce((sum, row) => sum + (row.submitted?.ui.credits_quoted ?? 0), 0);
  if (committed + quote > context.contract.total_credit_budget) throw new Error('Identity-locked episode credit budget exceeded.');
  if (assignment.transport === 'openart_studio_browser' && observed.discount_fraction !== 0) throw new Error('Do not claim a CLI/MCP discount for browser generation.');
  const submission = {
    schema: 'goldflow_openart_submission_v1', assignment_id: assignment.assignment_id,
    assignment_sha256: await fileHash(flags.assignment), ui: observed,
    marked_at: new Date().toISOString(), state: 'reserved_for_one_immediate_submission',
  };
  await writeOnce(path.join(context.root, 'submissions', `${assignment.assignment_id}.json`), submission);
  await event(context.root, { event: 'creative_submission_authorized_once', assignment_id: assignment.assignment_id, credits_quoted: quote });
  return { status: 'ready_for_one_browser_click', assignment_id: assignment.assignment_id, prompt_sha256: assignment.prompt_sha256, credits_quoted: quote };
}
export async function importResult(context, flags) { return withEpisodeLock(context, () => importResultUnlocked(context, flags)); }
async function importResultUnlocked(context, flags) {
  const assignment = await loadAssignment(context, flags.assignment);
  const subPath = path.join(context.root, 'submissions', `${assignment.assignment_id}.json`);
  const submitted = await readJson(subPath);
  if (!submitted || submitted.assignment_sha256 !== await fileHash(flags.assignment)) throw new Error('No exact one-submission authorization.');
  if (await readJson(path.join(context.root, 'results', `${assignment.assignment_id}.json`))) throw new Error('Result already imported; accepted media is immutable.');
  const result = await readJson(flags.receipt);
  if (result?.attestation !== 'openart_result_identity_and_download_visibly_verified' || !result.reviewer) throw new Error('Observed generation/library identity and downloaded raster receipt required.');
  if (result.assignment_id !== assignment.assignment_id || result.submission_sha256 !== await fileHash(subPath)) throw new Error('Result is not bound to the exact submitted assignment.');
  if (assignment.scope === 'canonical') requireValue(result.project_id, 'Canonical OpenArt project ID missing before import.');
  requireValue(result.creation_id, 'OpenArt creation ID missing.'); requireValue(result.openart_asset_id, 'OpenArt media asset ID missing.');
  if (!path.isAbsolute(result.output_path ?? '') || await fileHash(result.output_path) !== result.sha256) throw new Error('Downloaded image path/hash mismatch.');
  const metadata = await sharp(result.output_path, { failOn: 'error' }).metadata();
  if (!metadata.width || metadata.width < 900 || metadata.width <= metadata.height || Math.abs(metadata.width / metadata.height - 16 / 9) > 0.04) throw new Error('Native image is not a valid 1K landscape16:9 output. Do not crop it into acceptance.');
  const createdAt = Date.parse(result.created_at);
  if (!Number.isFinite(createdAt) || createdAt < Date.parse(submitted.marked_at) - 1000 || createdAt > Date.now() + 60000) throw new Error('Provider creation timestamp predates this submission or is invalid/future.');
  const imported = (await listAssignments(context.root)).filter((row) => row.receipt);
  if (imported.some((row) => row.receipt.creation_id === result.creation_id || row.receipt.openart_asset_id === result.openart_asset_id || row.receipt.sha256 === result.sha256)) throw new Error('Provider output already belongs to another assignment; historical or duplicate output reuse is forbidden.');
  if (result.credits_charged != null && (!Number.isFinite(result.credits_charged) || result.credits_charged < 0 || result.credits_charged > submitted.ui.credits_quoted)) throw new Error('Unexpected actual generation charge requires triage.');
  for (const ref of assignment.reference_bindings) if (await fileHash(ref.path) !== ref.sha256) throw new Error(`Reference changed after dispatch: ${ref.asset_id}`);
  const outputPath = path.join(context.root, 'outputs', `${assignment.assignment_id}${path.extname(result.output_path)}`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.copyFile(result.output_path, outputPath, 1);
  const providerReceipt = {
    schema: 'goldflow_openart_provider_receipt_v1', assignment_id: assignment.assignment_id,
    model: assignment.model_id, mode: assignment.mode, params: assignment.params,
    prompt_sha256: assignment.prompt_sha256, references: refsCore(assignment.reference_bindings),
    creation_id: result.creation_id, openart_asset_id: result.openart_asset_id, output_sha256: result.sha256,
    transport: assignment.transport, credits_quoted: submitted.ui.credits_quoted,
    credits_charged: result.credits_charged ?? null, created_at: result.created_at,
    submission_path: subPath, submission_sha256: await fileHash(subPath),
    observed_result_receipt_sha256: await fileHash(flags.receipt),
    elapsed_sec: (Date.now() - Date.parse(submitted.marked_at)) / 1000,
  };
  const providerPath = path.join(context.root, 'provider-receipts', `${assignment.assignment_id}.json`);
  await writeOnce(providerPath, providerReceipt);
  const normalized = {
    ...providerReceipt, output_path: outputPath, sha256: result.sha256, width: metadata.width, height: metadata.height,
    provider_receipt_path: providerPath, provider_receipt_sha256: await fileHash(providerPath),
  };
  if (assignment.scope === 'canonical') {
    const item = context.catalog.assets.find((row) => row.asset_id === assignment.asset_id);
    normalized.bank_record = await addCanonicalResult(context.bankRoot, { item, catalog: context.catalog, result: normalized, references: assignment.reference_bindings, prompt: assignment.prompt, params: assignment.params, projectId: result.project_id ?? null });
  }
  await writeOnce(path.join(context.root, 'results', `${assignment.assignment_id}.json`), normalized);
  if (assignment.scope === 'scene') await refreshSceneReport(context);
  await event(context.root, { event: 'result_imported', assignment_id: assignment.assignment_id, output_sha256: result.sha256, openart_asset_id: result.openart_asset_id });
  return normalized;
}
async function refreshSceneReport(context) {
  const planPath = path.join(context.episodeDir, 'section_image_prompts_hardened.json');
  const plan = await readJson(planPath); const promptHash = await fileHash(planPath);
  const rows = (await listAssignments(context.root)).filter((row) => row.scope === 'scene' && row.receipt && row.prompt_plan_sha256 === promptHash);
  const byId = new Map();
  for (const row of rows) byId.set(row.asset_id, row);
  const results = []; const cuts = []; const hashes = new Set();
  for (const prompt of plan.prompts) {
    const row = byId.get(prompt.image_id); if (!row) continue;
    if (hashes.has(row.receipt.sha256)) throw new Error('Duplicate production rasters are not accepted as different frames.');
    hashes.add(row.receipt.sha256);
    const imagePath = row.receipt.output_path;
    const generated = { output_sha256: row.receipt.sha256, model: row.model_id, provider: 'openart_cli', ...row.receipt };
    results.push({ image_id: row.asset_id, scene_id: prompt.scene_id, image_path: imagePath, status: 'generated', generated, reference_inputs: row.reference_bindings });
    cuts.push({ image_id: row.asset_id, scene_id: prompt.scene_id, visual_beat_id: prompt.visual_beat_id, start_sec: prompt.start_sec, duration_sec: prompt.duration_sec,
      prompt_hash: row.prompt_sha256, reference_ids: row.reference_bindings.map((ref) => ref.asset_id), reference_inputs: row.reference_bindings,
      image_path: imagePath, image_sha256: row.receipt.sha256, provider: 'openart_cli', model: row.model_id, openart_asset_id: row.receipt.openart_asset_id,
      provider_receipt_path: row.receipt.provider_receipt_path, provider_receipt_sha256: row.receipt.provider_receipt_sha256 });
  }
  const report = { schema: 'goldflow_imagegen_report_v1', status: results.length === plan.prompts.length ? 'passed' : 'partial',
    image_provider: 'openart_cli', prompt_plan_path: planPath, prompt_plan_hash: promptHash, expected_image_count: plan.prompts.length,
    image_count: results.length, missing_image_count: plan.prompts.length - results.length, results, updated_at: new Date().toISOString() };
  await writeOnce(path.join(context.root, 'image-reports', `${Date.now()}-${randomUUID()}.json`), report);
  await atomicJson(path.join(context.episodeDir, `imagegen_report_${context.identity.episode}.json`), report);
  await atomicJson(path.join(context.episodeDir, 'cut_execution_ledger.json'), { schema: 'goldflow_cut_execution_ledger_v1', prompt_plan_path: planPath, prompt_plan_hash: promptHash, cuts, updated_at: report.updated_at });
}
async function reviewValidation(context, review) {
  if (review?.attestation !== 'validation_set_visually_inspected_end_to_end' || !review.reviewer || review.decisions?.length !== 8) throw new Error('Review all eight real validation outputs.');
  const assignments = await listAssignments(context.root);
  for (const shot of context.catalog.validation_shots) {
    const result = assignments.filter((row) => row.scope === 'validation' && row.asset_id === shot.image_id).at(-1)?.receipt;
    const decision = review.decisions.find((row) => row.image_id === shot.image_id);
    if (!result || !decision || decision.sha256 !== result.sha256 || !decision.note) throw new Error(`Missing exact visual review: ${shot.image_id}`);
    for (const key of ['identity_consistency', 'hands', 'prop_fidelity', 'composition', 'roulette_details', 'no_unwanted_text']) {
      if (typeof decision.checks?.[key] !== 'boolean') throw new Error(`Validation check missing: ${key}`);
    }
    if (!['approved', 'rejected'].includes(decision.decision) || (decision.decision === 'approved' && Object.values(decision.checks).some((value) => !value))) throw new Error('Validation has a failed critical check.');
  }
  const record = { ...review, recorded_at: new Date().toISOString() };
  const immutablePath = path.join(context.root, 'validation-reviews', `${Date.now()}-${randomUUID()}.json`);
  await writeOnce(immutablePath, record);
  return atomicJson(path.join(context.root, 'validation-review.json'), { ...record, immutable_path: immutablePath, immutable_sha256: await fileHash(immutablePath) });
}
async function approveRefs(context) {
  if ((await bankPhase(context)).phase !== 'complete') throw new Error('Every canonical asset, native library ID, and representative shot must be reviewed first.');
  const bank = await loadBank(context.bankRoot);
  const refs = context.catalog.assets.map((item) => currentAsset(bank, item.asset_id));
  return writeOnce(path.join(context.root, 'refs-approval.json'), {
    schema: 'goldflow_openart_reference_approval_v1', approved: true, source_sha256: await fileHash(context.planPath ?? path.join(context.root, 'bank-plan.json')),
    references: refs.map((row) => ({ asset_id: row.asset_id, version: row.version, sha256: row.sha256, openart_asset_id: row.openart_asset_id, openart_library_asset_id: row.openart_library_asset_id, review: row.review })),
    validation_review_sha256: await fileHash(path.join(context.root, 'validation-review.json')), at: new Date().toISOString(),
  });
}
export async function runOpenArt(flags) {
  if (!flags['episode-dir'] || !path.isAbsolute(flags['episode-dir'])) throw new Error('Explicit absolute --episode-dir required.');
  const context = await openartContext(flags['episode-dir']); const action = flags.action;
  if (action === 'status') return bankPhase(context);
  if (action === 'plan') return planBank(context, requireValue(flags.catalog, '--catalog required'));
  if (action === 'revise-plan') return revisePlan(context, flags);
  if (action === 'approve-plan') return approvePlan(context, flags);
  if (action === 'prepare') return prepareAssignments(context, flags);
  if (action === 'prepare-ready') return prepareReadyReferenceAssignments(context, flags);
  if (action === 'worker-status') return referenceWorkerPool(context, { maxWorkers: flags['max-workers'] });
  if (action === 'mark-submitted') return markSubmitted(context, flags);
  if (action === 'import') return importResult(context, flags);
  if (action === 'review') {
    const review = await readJson(requireValue(flags.review, '--review required'));
    return flags.scope === 'validation' ? reviewValidation(context, review) : reviewCanonicalAssets(context.bankRoot, review);
  }
  if (action === 'sync-library') return synchronizeLibraryRecord(context.bankRoot, await readJson(requireValue(flags.sync, '--sync required')));
  if (action === 'approve-refs') return approveRefs(context);
  if (action === 'bind-shots') { await requireRefsApproval(context); return bindOpenArtShots(context, requireValue(flags['shot-plan'], '--shot-plan required')); }
  if (action === 'harden') { await requireRefsApproval(context); return hardenOpenArtShots(context); }
  if (action === 'fail') {
    const assignment = await loadAssignment(context, flags.assignment);
    requireValue(flags.note, 'Exact failure evidence required.');
    return writeOnce(path.join(context.root, 'failures', `${assignment.assignment_id}.json`), { assignment_id: assignment.assignment_id, reason: flags.note, at: new Date().toISOString(), automatic_retry: false });
  }
  if (action === 'triage') {
    const repair = await readJson(requireValue(flags.repair, '--repair required'));
    if (!repair?.asset_id || !repair.prior_assignment_id || !repair.reviewer || !repair.reason) throw new Error('Exact reviewed repair required.');
    return prepareAssignments(context, { ...flags, 'asset-ids': repair.asset_id, action: 'prepare' });
  }
  throw new Error(`Unsupported OpenArt action ${action}`);
}
function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) { const key = args[i].slice(2); out[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true'; }
  return out;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOpenArt(parseFlags(process.argv.slice(2))).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
