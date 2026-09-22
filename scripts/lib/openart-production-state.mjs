import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readJson, fileHash, sha256, loadBank, currentAsset, verifyAsset, validateCatalog, resolveReferences } from './openart-asset-bank.mjs';

export const openartRoot = (episodeDir) => path.join(episodeDir, 'openart');
export async function openartContext(episodeDir, suppliedIdentity = null) {
  const identity = suppliedIdentity ?? await readJson(path.join(episodeDir, 'run_identity.json'));
  if (identity?.image_provider !== 'openart_cli') throw new Error('This command requires an immutable OpenArt production identity.');
  const contract = identity.image_provider_options?.openart ?? identity.openart_contract;
  if (!contract || contract.primary?.quality !== 'low' || contract.primary?.resolution !== '1k' || contract.primary?.aspect_ratio !== '16:9') throw new Error('OpenArt requires the locked Low/1K/16:9 contract.');
  const root = openartRoot(episodeDir);
  const currentPointer = await readJson(path.join(root, 'bank-plan-current.json'));
  const planPath = currentPointer?.plan_path ?? path.join(root, 'bank-plan.json');
  const plan = await readJson(planPath);
  if (currentPointer && (currentPointer.plan_sha256 !== await fileHash(planPath) || currentPointer.revision !== plan?.revision)) throw new Error('Current OpenArt bank-plan pointer is stale.');
  const catalog = plan ? await readJson(plan.catalog_path) : null;
  if (plan) {
    if (plan.identity_sha256 !== await fileHash(path.join(episodeDir, 'run_identity.json'))) throw new Error('Bank plan identity binding changed.');
    const initialCatalog = path.join(root, 'catalog.json');
    const revisionDir = path.join(root, 'catalog-revisions');
    if (plan.catalog_path !== initialCatalog && path.dirname(plan.catalog_path) !== revisionDir) throw new Error('Bank catalog must be an immutable episode-admitted copy.');
    if (await fileHash(plan.catalog_path) !== plan.catalog_sha256) throw new Error('Bank catalog changed after admission.');
    validateCatalog(catalog);
  }
  return { episodeDir, identity, contract, root, plan, planPath, catalog, bankRoot: contract.reference_bank_path };
}
export async function listAssignments(root) {
  const files = await fs.readdir(path.join(root, 'assignments')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  const assignments = [];
  for (const name of files.filter((value) => value.endsWith('.json'))) {
    const file = path.join(root, 'assignments', name);
    const assignment = await readJson(file);
    const receipt = await readJson(path.join(root, 'results', `${assignment.assignment_id}.json`));
    const submitted = await readJson(path.join(root, 'submissions', `${assignment.assignment_id}.json`));
    const failure = await readJson(path.join(root, 'failures', `${assignment.assignment_id}.json`));
    assignments.push({ ...assignment, assignment_path: file, receipt, submitted, failure });
  }
  const byId = new Map(assignments.map((row) => [row.assignment_id, row]));
  const depth = (row, seen = new Set()) => {
    if (seen.has(row.assignment_id)) throw new Error('Cyclic OpenArt repair ancestry.');
    seen.add(row.assignment_id);
    const parent = byId.get(row.previous_assignment_id);
    return parent ? depth(parent, seen) + 1 : 0;
  };
  return assignments.sort((a, b) => depth(a) - depth(b) || Date.parse(a.created_at) - Date.parse(b.created_at) || a.assignment_id.localeCompare(b.assignment_id));
}
export function latestAssignments(assignments, scope) {
  const groups = new Map();
  for (const row of assignments.filter((item) => item.scope === scope)) {
    if (!groups.has(row.asset_id)) groups.set(row.asset_id, []);
    groups.get(row.asset_id).push(row);
  }
  const latest = new Map();
  for (const [id, rows] of groups) {
    const replaced = new Set(rows.map((row) => row.previous_assignment_id).filter(Boolean));
    const leaves = rows.filter((row) => !replaced.has(row.assignment_id));
    if (leaves.length !== 1) throw new Error(`Ambiguous parallel or cyclic OpenArt attempts: ${id}`);
    latest.set(id, leaves[0]);
  }
  return latest;
}
const coreReferences = (rows) => (rows ?? []).map(({ asset_id, sha256: hash, openart_asset_id }) => ({ asset_id, sha256: hash, openart_asset_id }));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validTimestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
function requireState(value, message) { if (!value) throw new Error(message); }

export async function verifyCompletedAssignment(context, attempt, { prompt = null } = {}) {
  requireState(attempt?.receipt && attempt.submitted && !attempt.failure, 'OpenArt output requires its successful exact assignment and submission.');
  const assignmentPath = path.join(context.root, 'assignments', `${attempt.assignment_id}.json`);
  requireState(attempt.assignment_path === assignmentPath, 'OpenArt assignment path mismatch.');
  const assignment = await readJson(assignmentPath);
  requireState(assignment && assignment.identity_sha256 === await fileHash(path.join(context.episodeDir, 'run_identity.json')) && assignment.catalog_sha256 === context.plan.catalog_sha256, 'OpenArt assignment identity/catalog binding is stale.');
  requireState(assignment.prompt_sha256 === sha256(assignment.prompt) && same(assignment.params, { quality: 'low', resolution: '1k', aspect_ratio: '16:9' }), 'OpenArt assignment prompt/settings invalid.');
  requireState(['canonical', 'validation', 'scene'].includes(assignment.scope) && assignment.transport === context.contract.transport, 'OpenArt assignment scope/transport invalid.');
  requireState(assignment.model_id === context.contract.primary.model_id || (assignment.scope !== 'canonical' && assignment.repair_evidence?.primary_failure_unresolved === true && context.contract.repair_models.some((row) => row.model_id === assignment.model_id)), 'Unapproved OpenArt model substitution.');
  requireState(Array.isArray(assignment.reference_bindings) && assignment.mode === (assignment.reference_bindings.length ? 'image2image' : 'text2image'), 'OpenArt reference mode mismatch.');
  if (prompt) {
    requireState(assignment.asset_id === prompt.image_id && assignment.scope === 'scene' && assignment.prompt === (prompt.provider_prompt ?? prompt.prompt), 'Scene assignment does not match its exact prompt.');
    requireState(assignment.prompt_plan_sha256 === await fileHash(path.join(context.episodeDir, 'section_image_prompts_hardened.json')), 'Scene assignment prompt-plan binding is stale.');
    requireState(same(assignment.reference_bindings.map((row) => row.asset_id), prompt.reference_asset_ids), 'Scene assignment reference IDs differ from the bound shot.');
  }
  const submissionPath = path.join(context.root, 'submissions', `${assignment.assignment_id}.json`);
  const submitted = await readJson(submissionPath);
  requireState(submitted?.assignment_id === assignment.assignment_id && submitted.assignment_sha256 === await fileHash(assignmentPath), 'OpenArt submission assignment binding is stale.');
  const ui = submitted.ui;
  requireState(ui?.attestation === 'exact_prompt_settings_and_ordered_references_visibly_verified' && ui.reviewer?.trim() && ui.model_id === assignment.model_id && ui.prompt_sha256 === assignment.prompt_sha256 && same(ui.params, assignment.params) && same(ui.references, coreReferences(assignment.reference_bindings)) && ui.image_count === 1, 'OpenArt visible submission verification is incomplete.');
  requireState(validTimestamp(ui.observed_at) && validTimestamp(submitted.marked_at) && Number.isFinite(ui.credits_quoted) && ui.credits_quoted >= 0 && ui.credits_quoted <= context.contract.max_credit_cost, 'OpenArt quote/time evidence invalid.');
  requireState(assignment.transport !== 'openart_studio_browser' || ui.discount_fraction === 0, 'Browser generation cannot claim CLI credit discount.');
  const receipt = attempt.receipt;
  const providerPath = path.join(context.root, 'provider-receipts', `${assignment.assignment_id}.json`);
  requireState(receipt.provider_receipt_path === providerPath && receipt.provider_receipt_sha256 === await fileHash(providerPath), 'OpenArt provider receipt missing or changed.');
  const provider = await readJson(providerPath);
  requireState(provider?.schema === 'goldflow_openart_provider_receipt_v1' && provider.assignment_id === assignment.assignment_id && provider.model === assignment.model_id && provider.mode === assignment.mode && provider.transport === assignment.transport && provider.prompt_sha256 === assignment.prompt_sha256 && same(provider.params, assignment.params) && same(provider.references, coreReferences(assignment.reference_bindings)), 'OpenArt provider receipt disagrees with its submitted assignment.');
  requireState(provider.submission_path === submissionPath && provider.submission_sha256 === await fileHash(submissionPath), 'OpenArt provider receipt lacks its exact submitted request.');
  requireState(typeof provider.creation_id === 'string' && provider.creation_id && typeof provider.openart_asset_id === 'string' && provider.openart_asset_id && validTimestamp(provider.created_at), 'OpenArt result has no valid provider identity/time.');
  requireState(provider.credits_quoted === ui.credits_quoted && (provider.credits_charged == null || (Number.isFinite(provider.credits_charged) && provider.credits_charged >= 0 && provider.credits_charged <= ui.credits_quoted)), 'OpenArt result credit evidence invalid.');
  for (const [key, value] of Object.entries(provider)) requireState(same(receipt[key], value), `OpenArt normalized provider receipt changed: ${key}`);
  requireState(path.dirname(receipt.output_path ?? '') === path.join(context.root, 'outputs') && receipt.sha256 === provider.output_sha256 && await fileHash(receipt.output_path) === receipt.sha256, 'OpenArt output path/hash mismatch.');
  const bank = await loadBank(context.bankRoot);
  for (const ref of assignment.reference_bindings) {
    const record = bank.assets.find((row) => row.asset_id === ref.asset_id && row.version === ref.version && row.sha256 === ref.sha256 && row.openart_asset_id === ref.openart_asset_id && row.approval_state === 'approved');
    requireState(record, `Unknown approved OpenArt reference: ${ref.asset_id}`);
    await verifyAsset(record, { requireLibrary: true });
    requireState(ref.path === record.local_absolute_path && await fileHash(ref.path) === ref.sha256, 'OpenArt reference bytes/path changed.');
  }
  return receipt;
}

export async function validationReviewState(context, assignments) {
  const reviewPath = path.join(context.root, 'validation-review.json');
  const review = await readJson(reviewPath);
  const shots = context.catalog.validation_shots;
  const current = latestAssignments(assignments, 'validation');
  if (!review) return { approved: false, rejectedIds: [], reviewPath };
  if (review.immutable_path || review.immutable_sha256) {
    requireState(path.dirname(review.immutable_path ?? '') === path.join(context.root, 'validation-reviews') && await fileHash(review.immutable_path) === review.immutable_sha256, 'Immutable validation review changed.');
    const { immutable_path, immutable_sha256, ...currentReview } = review;
    requireState(same(currentReview, await readJson(immutable_path)), 'Validation current review differs from its immutable receipt.');
  }
  requireState(review.attestation === 'validation_set_visually_inspected_end_to_end' && review.reviewer?.trim(), 'Validation review needs a reviewer and actual visual-inspection attestation.');
  requireState(Array.isArray(review.decisions) && review.decisions.length === shots.length && new Set(review.decisions.map((row) => row.image_id)).size === shots.length, 'Validation review requires each of the eight exact IDs once.');
  const checks = ['identity_consistency', 'hands', 'prop_fidelity', 'composition', 'roulette_details', 'no_unwanted_text'];
  const rejectedIds = []; let currentHashes = true;
  for (const shot of shots) {
    const decision = review.decisions.find((row) => row.image_id === shot.image_id);
    requireState(decision && ['approved', 'rejected'].includes(decision.decision) && decision.note?.trim() && checks.every((key) => typeof decision.checks?.[key] === 'boolean') && Object.values(decision.checks).every((value) => typeof value === 'boolean'), `Incomplete production visual review: ${shot.image_id}`);
    requireState(decision.decision !== 'approved' || Object.values(decision.checks).every(Boolean), `Failed critical visual check was approved: ${shot.image_id}`);
    const attempt = current.get(shot.image_id);
    if (!attempt?.receipt || decision.sha256 !== attempt.receipt.sha256) currentHashes = false;
    else if (decision.decision === 'rejected') rejectedIds.push(shot.image_id);
  }
  return { approved: currentHashes && !rejectedIds.length, rejectedIds, currentHashes, reviewPath, sha256: await fileHash(reviewPath) };
}

export async function refsApprovalCurrent(context) {
  if (!await validApproval(context.root, 'refs-approval.json', context.planPath ?? path.join(context.root, 'bank-plan.json'))) return false;
  const approval = await readJson(path.join(context.root, 'refs-approval.json'));
  const validation = await validationReviewState(context, await listAssignments(context.root));
  if (!validation.approved || approval.validation_review_sha256 !== validation.sha256 || !Array.isArray(approval.references) || approval.references.length !== context.catalog.assets.length || new Set(approval.references.map((row) => row.asset_id)).size !== context.catalog.assets.length) return false;
  const bank = await loadBank(context.bankRoot);
  for (const item of context.catalog.assets) {
    const current = currentAsset(bank, item.asset_id, { approved: false });
    const recorded = approval.references.find((row) => row.asset_id === item.asset_id);
    if (!current || current.approval_state !== 'approved' || !recorded || !['version', 'sha256', 'openart_asset_id', 'openart_library_asset_id'].every((key) => current[key] === recorded[key]) || !same(current.review, recorded.review)) return false;
    await verifyAsset(current, { requireLibrary: true });
  }
  return true;
}

async function validApproval(root, name, sourceFile) {
  const file = path.join(root, name); const doc = await readJson(file);
  return doc?.approved === true && doc.source_sha256 === await fileHash(sourceFile).catch(() => null);
}
export async function bankPhase(context) {
  const { root, bankRoot, catalog } = context;
  if (!catalog) return { phase: 'plan' };
  const bank = await loadBank(bankRoot); const assignments = (await listAssignments(root)).filter((row) => !row.catalog_sha256 || row.catalog_sha256 === context.plan.catalog_sha256);
  const canonicalAttempts = latestAssignments(assignments, 'canonical');
  const validationAttempts = latestAssignments(assignments, 'validation');
  const pending = (phase, id, attempt) => ({ phase, action: attempt?.failure ? 'triage' : attempt ? (attempt.submitted ? 'import' : 'mark-submitted') : 'prepare', ids: [id], assignment: attempt, evidence: attempt?.failure });
  for (const phase of ['joey', 'core', 'validation', 'remaining']) {
    if (phase === 'validation') {
      for (const shot of catalog.validation_shots) {
        const attempt = validationAttempts.get(shot.image_id);
        if (attempt?.failure || !attempt?.receipt) return pending(phase, shot.image_id, attempt);
        await verifyCompletedAssignment(context, attempt);
      }
      const review = await validationReviewState(context, assignments);
      if (review.rejectedIds.length) return { phase, action: 'triage', ids: [review.rejectedIds[0]], evidence: { review_path: review.reviewPath, review_sha256: review.sha256 } };
      if (!review.approved) return { phase, action: 'review', ids: catalog.validation_shots.map((shot) => shot.image_id) };
      continue;
    }
    for (const item of catalog.assets.filter((row) => row.phase === phase)) {
      const candidate = currentAsset(bank, item.asset_id, { approved: false });
      const attempt = canonicalAttempts.get(item.asset_id);
      // A newly admitted exact-ID repair takes precedence over its rejected
      // predecessor. Its old approved/rejected raster remains immutable.
      if (attempt && attempt.assignment_id !== candidate?.assignment_id) {
        if (attempt.failure || !attempt.receipt) return pending(phase, item.asset_id, attempt);
        throw new Error(`Canonical result is not registered as its current bank version: ${item.asset_id}`);
      }
      if (candidate) {
        await verifyAsset(candidate);
        if (attempt?.failure) return pending(phase, item.asset_id, attempt);
        if (attempt) await verifyCompletedAssignment(context, attempt);
        if (candidate.approval_state === 'rejected') return { phase, action: 'triage', ids: [item.asset_id], evidence: candidate.review };
        if (candidate.approval_state !== 'approved') return { phase, action: 'review', ids: [item.asset_id] };
        if (!candidate.openart_library_asset_id) return { phase, action: 'sync-library', ids: [item.asset_id] };
        continue;
      }
      return pending(phase, item.asset_id, attempt);
    }
  }
  return { phase: 'complete', action: 'approve-refs' };
}

function boundedWorkerCount(context, value) {
  const locked = Number(context.contract.concurrency);
  if (!Number.isInteger(locked) || locked < 1) throw new Error('OpenArt identity has no valid locked concurrency.');
  const count = Number(value ?? Math.min(4, locked));
  const providerLimit = context.contract.transport === 'openart_cli_v1' ? 32 : 8;
  if (!Number.isInteger(count) || count < 1 || count > providerLimit) throw new Error(`OpenArt reference workers must be an integer from 1 through ${providerLimit}.`);
  if (count > locked) throw new Error(`Requested ${count} OpenArt reference workers exceeds the identity-locked concurrency ${locked}.`);
  return count;
}

/**
 * Describe a bounded pool of independent reference assignments without
 * advancing any creative request.  Dependencies are resolved from approved,
 * hash-valid native-library records, so a pool can never race ahead of the
 * canonical bank graph.
 */
export async function referenceWorkerPool(context, { maxWorkers } = {}) {
  const limit = boundedWorkerCount(context, maxWorkers);
  const phaseState = await bankPhase(context);
  if (!['core', 'validation', 'remaining'].includes(phaseState.phase)) {
    return { schema: 'goldflow_openart_reference_worker_pool_v1', phase: phaseState.phase, max_workers: limit, active_count: 0, available_slots: 0, ready_ids: [], waiting_on_dependencies: [], workers: [], blocked_by: phaseState.action ?? null };
  }
  const scope = phaseState.phase === 'validation' ? 'validation' : 'canonical';
  const all = (await listAssignments(context.root)).filter((row) => row.catalog_sha256 === context.plan.catalog_sha256);
  const latest = latestAssignments(all, scope);
  const items = phaseState.phase === 'validation'
    ? context.catalog.validation_shots.map((row) => ({ id: row.image_id, item: row }))
    : context.catalog.assets.filter((row) => row.phase === phaseState.phase).map((row) => ({ id: row.asset_id, item: row }));
  const failed = items.map(({ id }) => latest.get(id)).find((row) => row?.failure);
  if (failed) {
    return { schema: 'goldflow_openart_reference_worker_pool_v1', phase: phaseState.phase, scope, max_workers: limit, active_count: 0, available_slots: 0, ready_ids: [], waiting_on_dependencies: [], workers: [], blocked_by: 'triage', failed_assignment: failed };
  }
  const bank = await loadBank(context.bankRoot);
  const workers = items.map(({ id }) => latest.get(id)).filter((row) => row && !row.receipt).map((row) => ({
    assignment_id: row.assignment_id,
    assignment_path: row.assignment_path,
    asset_id: row.asset_id,
    state: row.submitted ? 'submitted_awaiting_import' : 'prepared_awaiting_visible_verification',
    next_action: row.submitted ? 'import' : 'mark-submitted',
    next_command_shape: row.submitted
      ? `node bin/goldflow.mjs imagegen openart --references-only true --scope ${scope} --action import --assignment ${row.assignment_path} --receipt <observed-result.json> --episode-dir ${context.episodeDir}`
      : `node bin/goldflow.mjs imagegen openart --references-only true --scope ${scope} --action mark-submitted --assignment ${row.assignment_path} --ui-receipt <observed-ui.json> --episode-dir ${context.episodeDir}`,
  }));
  const slots = Math.max(0, limit - workers.length);
  const ready = []; const waiting = [];
  for (const { id, item } of items) {
    if (latest.has(id) || currentAsset(bank, id, { approved: false })) continue;
    try {
      await resolveReferences(context.bankRoot, item.reference_asset_ids ?? [], { maxReferences: context.contract.max_reference_count, extraReferenceReason: item.extra_reference_reason });
      ready.push(id);
    } catch (error) {
      waiting.push({ asset_id: id, reference_asset_ids: item.reference_asset_ids ?? [], reason: error.message });
    }
  }
  return {
    schema: 'goldflow_openart_reference_worker_pool_v1', phase: phaseState.phase, scope, max_workers: limit,
    active_count: workers.length, available_slots: slots, ready_ids: ready.slice(0, slots),
    queued_ready_ids: ready.slice(slots), waiting_on_dependencies: waiting, workers,
    blocked_by: null,
  };
}
export async function openartProductionStageStates({ episodeDir, identity }) {
  if (identity?.image_provider !== 'openart_cli') return { applicable: false, stageStates: {} };
  const command = (tail) => `node bin/goldflow.mjs ${tail} --episode-dir ${episodeDir}`;
  const incomplete = (evidence, tail, state = 'missing') => ({ done: false, state, evidence, next_command_shape: command(tail) });
  const passed = (evidence) => ({ done: true, evidence });
  let stageStates = {}; let failureStage = 'visual_reference_plan';
  try {
    const context = await openartContext(episodeDir, identity);
    const { root, plan, catalog } = context;
    const planned = Boolean(plan);
    const planApproved = planned && await validApproval(root, 'plan-approval.json', context.planPath ?? path.join(root, 'bank-plan.json'));
    stageStates = {
      visual_reference_plan: planned ? passed(`Authored global bank catalog; ${catalog.assets.length} canonical assets`) : incomplete('OpenArt global bank plan missing', 'visual openart-bank --action plan --catalog <authored-catalog.json>'),
      reference_plan_approval: planApproved ? passed('Hash-bound authored bank plan approved') : incomplete('Canonical creative plan needs review', 'visual openart-bank --action approve-plan --reviewer Codex --note <review-evidence>'),
    };
    failureStage = 'reference_generation';
    const phase = planApproved ? await bankPhase(context) : { phase: 'awaiting_plan', action: 'prepare', ids: [] };
    const statusWorkerLimit = Math.min(4, context.contract.concurrency);
    const pool = planApproved && ['core', 'validation', 'remaining'].includes(phase.phase) ? await referenceWorkerPool(context, { maxWorkers: statusWorkerLimit }) : null;
    let refCommand = `imagegen openart --references-only true --scope ${phase.phase === 'validation' ? 'validation' : 'canonical'} --action ${phase.action} --asset-ids ${(phase.ids ?? []).join(',') || '<exact-ids>'}`;
    if (phase.action === 'mark-submitted') refCommand += ` --assignment ${phase.assignment.assignment_path} --ui-receipt <observed-ui.json>`;
    if (phase.action === 'import') refCommand += ` --assignment ${phase.assignment.assignment_path} --receipt <observed-result.json>`;
    if (phase.action === 'review') refCommand += ' --review <hash-bound-visual-review.json>';
    if (phase.action === 'sync-library') refCommand += ' --sync <native-library-receipt.json>';
    if (phase.action === 'triage') refCommand = `imagegen openart --references-only true --scope ${phase.phase === 'validation' ? 'validation' : 'canonical'} --action triage --repair <exact-id-repair.json>`;
    if (pool?.ready_ids.length) refCommand = `imagegen openart --references-only true --action prepare-ready --max-workers ${pool.max_workers}`;
    else if (pool?.workers.length) refCommand = `imagegen openart --references-only true --action worker-status --max-workers ${pool.max_workers}`;
    const refsDone = phase.phase === 'complete';
    const poolEvidence = pool ? `; ${pool.active_count}/${pool.max_workers} workers active, ${pool.ready_ids.length} independently ready` : '';
    stageStates.reference_generation = refsDone ? passed('Canonical bank, eight-shot validation, and native Studio mirroring complete') : incomplete(`OpenArt phase ${phase.phase}: ${phase.action}${poolEvidence}`, refCommand, phase.action === 'triage' ? 'blocked' : 'missing');
    failureStage = 'reference_image_approval';
    const refsApproved = refsDone && await refsApprovalCurrent(context);
    const shotPlan = await readJson(path.join(root, 'shot-binding.json'));
    const hardened = await readJson(path.join(root, 'hardened-receipt.json'));
    const planCurrent = shotPlan && await fileHash(path.join(episodeDir, 'section_image_prompts.json')).catch(() => null) === shotPlan.output_sha256;
    const hardCurrent = hardened && await fileHash(path.join(episodeDir, 'section_image_prompts_hardened.json')).catch(() => null) === hardened.output_sha256
      && planCurrent && hardened.input_sha256 === shotPlan.output_sha256;
    stageStates = {
      visual_reference_plan: planned ? passed(`Authored global bank catalog; ${catalog.assets.length} canonical assets`) : incomplete('OpenArt global bank plan missing', 'visual openart-bank --action plan --catalog <authored-catalog.json>'),
      reference_plan_approval: planApproved ? passed('Hash-bound authored bank plan approved') : incomplete('Canonical creative plan needs review', 'visual openart-bank --action approve-plan --reviewer Codex --note <review-evidence>'),
      reference_generation: refsDone ? passed('Canonical bank, eight-shot validation, and native Studio mirroring complete') : incomplete(`OpenArt phase ${phase.phase}: ${phase.action}${poolEvidence}`, refCommand, phase.action === 'triage' ? 'blocked' : 'missing'),
      reference_image_approval: refsApproved ? passed('Every canonical raster visually reviewed and library IDs verified') : incomplete('Final bank approval missing', 'visual openart-bank --action approve-refs'),
      visual_prompt_plan: planCurrent ? passed('New shot plan bound exclusively to approved OpenArt canonical assets') : incomplete('Authored shot migration and canonical binding required', 'visual openart-bank --action bind-shots --shot-plan <authored-shot-plan.json>'),
      visual_prompt_harden: hardCurrent ? passed('OpenArt prompt/reference hashes and complete beat coverage validated') : incomplete('New OpenArt prompt hardening required', 'visual openart-bank --action harden'),
      visual_prompt_blocker_repair: hardCurrent ? { state: 'skipped_with_waiver', evidence: 'OpenArt structural prompt sanitation passed' } : incomplete('Awaiting new shot-plan sanitation', 'visual openart-bank --action harden'),
    };
    failureStage = 'image_generation';
    const report = await readJson(path.join(episodeDir, `imagegen_report_${identity.episode}.json`));
    const promptDoc = hardCurrent ? await readJson(path.join(episodeDir, 'section_image_prompts_hardened.json')) : null;
    const expected = promptDoc?.prompts ?? [];
    const sceneAttempts = latestAssignments(await listAssignments(root), 'scene');
    const results = new Map(); const rasterHashes = new Set(); const creationIds = new Set();
    if (report && expected.length) {
      requireState(report.schema === 'goldflow_imagegen_report_v1' && report.image_provider === 'openart_cli' && report.prompt_plan_path === path.join(episodeDir, 'section_image_prompts_hardened.json') && report.prompt_plan_hash === hardened.output_sha256, 'OpenArt production report identity/prompt binding is invalid.');
      requireState(Array.isArray(report.results) && report.expected_image_count === expected.length && report.image_count === report.results.length && report.missing_image_count === expected.length - report.results.length, 'OpenArt image report coverage metadata is inconsistent.');
      for (const row of report.results) {
        requireState(!results.has(row.image_id), 'Duplicate frame IDs in OpenArt production report.');
        const prompt = expected.find((item) => item.image_id === row.image_id);
        requireState(prompt, `Unexpected frame in OpenArt production report: ${row.image_id}`);
        const attempt = sceneAttempts.get(row.image_id);
        const receipt = await verifyCompletedAssignment(context, attempt, { prompt });
        requireState(row.status === 'generated' && row.image_path === receipt.output_path && row.generated?.provider === 'openart_cli' && row.generated.assignment_id === attempt.assignment_id && row.generated.output_sha256 === receipt.sha256 && row.generated.provider_receipt_sha256 === receipt.provider_receipt_sha256 && row.generated.openart_asset_id === receipt.openart_asset_id && same(row.reference_inputs, attempt.reference_bindings), 'OpenArt production report lacks its exact new generated result.');
        requireState(!rasterHashes.has(receipt.sha256) && !creationIds.has(receipt.creation_id), 'Different production frames cannot reuse a raster or OpenArt creation.');
        rasterHashes.add(receipt.sha256); creationIds.add(receipt.creation_id); results.set(row.image_id, row);
      }
    }
    const missing = expected.filter((row) => !results.has(row.image_id)).map((row) => row.image_id);
    const pending = expected.map((row) => sceneAttempts.get(row.image_id)).find((row) => row && (!row.receipt || row.failure));
    const next = pending?.failure
      ? 'imagegen openart --scope scene --action triage --repair <exact-id-repair.json>'
      : pending
        ? `imagegen openart --action ${pending.submitted ? 'import' : 'mark-submitted'} --assignment ${pending.assignment_path} --${pending.submitted ? 'receipt' : 'ui-receipt'} <exact-receipt.json>`
        : `imagegen openart --action prepare --image-ids ${missing.slice(0, 4).join(',') || '<first-frame-ids>'}`;
    stageStates.image_generation = expected.length && !missing.length && !pending ? passed(`All ${expected.length} new OpenArt frames and exact provider receipts verified`) : incomplete(`OpenArt frames ${results.size}/${expected.length || 'unbound'}`, next, pending?.failure ? 'blocked' : 'missing');
    return { applicable: true, stageStates, phase };
  } catch (error) {
    return { applicable: true, stageStates: { ...stageStates, [failureStage]: incomplete(error.message, 'visual openart-bank --action status', 'blocked') } };
  }
}
