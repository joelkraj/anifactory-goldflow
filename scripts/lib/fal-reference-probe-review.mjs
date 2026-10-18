import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const fileHash = async file => hash(await fs.readFile(file));
const exists = async file => fs.access(file).then(() => true, () => false);
const need = (ok, message) => { if (!ok) throw new Error(`Fal reference probe review: ${message}`); };
const save = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); };
export const SINGLE_IDENTITY_OUTPUT = '\nOUTPUT COMPOSITION: The supplied image is identity evidence only. Do not reproduce its reference-board layout, portraits, panels, borders, captions, labels or typography. Draw exactly ONE figure in ONE neutral pose, centered on one plain background. No inset views, expression examples, turnaround, clothing details, writing or other copies of the person. Follow the requested age and fantasy clothing. Both hands are relaxed and empty.';

function repairAssignment(episodeDir, original, request) {
  const root = path.join(episodeDir, 'fal/reference');
  const core = { ...original, prompt: original.prompt + SINGLE_IDENTITY_OUTPUT,
    previous_assignment_sha256: original.assignment_sha256, rejected_image_sha256: request.rejected_image_sha256,
    repair_reason: request.finding };
  for (const key of ['assignment_sha256', 'assignment_path', 'submission_receipt_path', 'result_receipt_path', 'upload_receipt_path']) delete core[key];
  core.prompt_sha256 = hash(core.prompt);
  core.output_path = path.join(episodeDir, 'assets/images/reference-repairs', `${original.image_id}-v2.png`);
  return { ...core, assignment_sha256: hash(JSON.stringify(core)),
    submission_receipt_path: path.join(root, 'review-repair-submission-receipts', `${original.image_id}.json`),
    result_receipt_path: path.join(root, 'review-repair-result-receipts', `${original.image_id}.json`),
    upload_receipt_path: path.join(root, 'review-repair-upload-receipts', `${original.image_id}.json`) };
}

export async function inspectReferenceProbeReview(episodeDir) {
  const root = path.join(episodeDir, 'fal'), requestPath = path.join(root, 'reference-probe-review.json');
  if (!await exists(requestPath)) return null;
  const request = await read(requestPath), planPath = path.join(root, 'reference-plan.json');
  const paths = { request: requestPath, prepared: path.join(root, 'reference-probe-review-prepared.json'), accepted: path.join(root, 'reference-probe-review-accepted.json') };
  need(request.schema === 'goldflow_fal_reference_probe_review_v1' && request.status === 'rejected'
    && request.reviewer?.trim() && request.finding?.length > 20, 'actual exact visual rejection required');
  need(request.source_script_sha256 === await fileHash(path.join(episodeDir, 'script_clean.md'))
    && request.run_identity_sha256 === await fileHash(path.join(episodeDir, 'run_identity.json'))
    && (await exists(paths.accepted) || request.visual_reference_plan_sha256 === await fileHash(path.join(episodeDir, 'visual_reference_plan.json'))), 'source or identity changed');
  const prepared = await exists(paths.prepared) ? await read(paths.prepared) : null;
  const originalPlanPath = prepared?.original_plan_path ?? planPath;
  need(!prepared || originalPlanPath === path.join(root, 'reference/probe-review-original-plan.json'), 'snapshot path changed');
  need(await fileHash(originalPlanPath) === request.reference_plan_sha256, 'original plan changed');
  const plan = await read(originalPlanPath), native = await read(path.join(episodeDir, 'visual_reference_plan.json'));
  const original = plan.assignments.find(row => row.image_id === request.image_id);
  const target = native.reference_targets.find(row => row.ref_id === request.image_id);
  need(original && target?.kind === 'character_state' && target.identity_usage === 'face_only'
    && target.canonical_subject_id && original.endpoint?.endsWith('/edit')
    && original.assignment_sha256 === request.original_assignment_sha256, 'exact edited face-identity probe required');
  const result = await read(original.result_receipt_path);
  need(result.output_sha256 === request.rejected_image_sha256 && result.output_path === original.output_path
    && await fileHash(result.output_path) === result.output_sha256, 'rejected raster changed');
  need(original.board_path && await fileHash(original.board_path) === original.board_sha256, 'original identity input changed');
  const pending = plan.assignments.filter(row => request.pending_image_ids?.includes(row.image_id));
  need(pending.length > 0 && pending.length === request.pending_image_ids.length
    && new Set(request.pending_image_ids).size === pending.length, 'exact pending identity scope required');
  for (const row of pending) {
    const selected = native.reference_targets.find(item => item.ref_id === row.image_id);
    need(selected?.kind === 'character_state' && selected.canonical_subject_id === target.canonical_subject_id
      && row.image_id !== original.image_id && row.board_sha256 === original.board_sha256
      && row.endpoint === original.endpoint, 'pending scope must share the exact identity input');
    need(!await exists(row.submission_receipt_path) || await exists(paths.accepted), 'pending scope already submitted');
  }
  const repair = prepared?.repair;
  if (prepared) {
    need(prepared.request_sha256 === await fileHash(requestPath), 'prepared review changed');
    need(JSON.stringify(repair) === JSON.stringify(repairAssignment(episodeDir, original, request)), 'prepared assignment changed');
    need(repair.previous_assignment_sha256 === original.assignment_sha256
      && repair.prompt === original.prompt + SINGLE_IDENTITY_OUTPUT
      && repair.prompt_sha256 === hash(repair.prompt) && repair.endpoint === original.endpoint
      && repair.board_path === original.board_path && repair.board_sha256 === original.board_sha256, 'repair payload changed');
  }
  const accepted = await exists(paths.accepted) ? await read(paths.accepted) : null;
  if (accepted) {
    need(accepted.prepared_sha256 === await fileHash(paths.prepared)
      && accepted.reviewer?.trim() && accepted.note?.length > 20
      && accepted.reference_plan_sha256 === await fileHash(planPath), 'accepted binding changed');
    const repaired = await read(repair.result_receipt_path);
    need(accepted.accepted_image_sha256 === repaired.output_sha256
      && await fileHash(repaired.output_path) === repaired.output_sha256, 'accepted raster changed');
    return { state: 'accepted', paths, request, repair, accepted };
  }
  need(await fileHash(planPath) === request.reference_plan_sha256, 'current unsubmitted plan changed');
  if (repair && await exists(path.join(root, 'reference/review-repair-failure-receipts', `${repair.image_id}.json`))) {
    return { state: 'failed', paths, request, repair };
  }
  return { state: !prepared ? 'prepare' : await exists(repair.result_receipt_path) ? 'review'
    : await exists(repair.submission_receipt_path) ? 'observe' : 'dispatch', paths, request, plan, original, pending, repair };
}

export async function prepareReferenceProbeReview(episodeDir, state) {
  need(state.state === 'prepare', 'repair is already prepared');
  const { original, paths } = state, root = path.join(episodeDir, 'fal/reference');
  const repair = repairAssignment(episodeDir, original, state.request);
  const originalPlanPath = path.join(root, 'probe-review-original-plan.json');
  await save(originalPlanPath, state.plan);
  need(await fileHash(originalPlanPath) === state.request.reference_plan_sha256, 'snapshot differs');
  await save(path.join(root, 'review-repair-assignments', `${original.image_id}.json`), repair);
  await save(paths.prepared, { schema: 'goldflow_fal_reference_probe_prepared_v1', request_sha256: await fileHash(paths.request), original_plan_path: originalPlanPath, repair });
  return repair;
}

export async function acceptReferenceProbeReview(episodeDir, state, { reviewer, note }) {
  need(state.state === 'review' && reviewer?.trim() && note?.length > 20, 'actual repaired-raster visual review required');
  const receipt = await read(state.repair.result_receipt_path);
  need(receipt.output_path === state.repair.output_path && await fileHash(receipt.output_path) === receipt.output_sha256, 'repair raster changed');
  const plan = structuredClone(state.plan), pendingIds = new Set(state.request.pending_image_ids);
  for (const row of plan.assignments) if (pendingIds.has(row.image_id)) {
    const core = { ...row, prompt: row.prompt + SINGLE_IDENTITY_OUTPUT, board_path: receipt.output_path,
      board_sha256: receipt.output_sha256, reference_hashes: [receipt.output_sha256],
      reference_asset_ids: [state.original.ref_id], previous_assignment_sha256: row.assignment_sha256,
      identity_probe_review_sha256: await fileHash(state.paths.prepared) };
    for (const key of ['assignment_sha256', 'assignment_path', 'submission_receipt_path', 'result_receipt_path', 'upload_receipt_path']) delete core[key];
    core.prompt_sha256 = hash(core.prompt);
    Object.assign(row, core, { assignment_sha256: hash(JSON.stringify(core)) });
    const old = row.assignment_path + '.before-probe-review.json';
    await fs.copyFile(row.assignment_path, old, 1);
    await fs.writeFile(row.assignment_path, JSON.stringify(row, null, 2) + '\n');
  }
  const planPath = path.join(episodeDir, 'fal/reference-plan.json');
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2) + '\n');
  await save(state.paths.accepted, { schema: 'goldflow_fal_reference_probe_acceptance_v1', reviewer, note,
    prepared_sha256: await fileHash(state.paths.prepared), accepted_image_sha256: receipt.output_sha256,
    reference_plan_sha256: await fileHash(planPath), updated_unsubmitted_ids: [...pendingIds] });
  return { status: 'accepted', updated_unsubmitted_count: pendingIds.size };
}

export function referenceProbeReviewStage(episodeDir, state) {
  if (!state || state.state === 'accepted') return null;
  if (state.state === 'failed') return { state: 'blocked', evidence: 'Exact reference probe repair failed; inspect its retained provider failure before any further paid submission.' };
  const action = { prepare: 'prepare-reference-probe-repair', dispatch: 'dispatch-reference-probe-repair', observe: 'observe-reference-probe-repair', review: 'review-reference-probe-repair' }[state.state];
  const extra = state.state === 'dispatch' ? ' --confirm-spend exact_fal_reference_probe_repair'
    : state.state === 'review' ? ' --reviewer <reviewer> --note "<actual visual review>"' : '';
  return { state: 'blocked', evidence: `Rejected exact face reference probe: ${state.request.finding}; hold remaining reference dispatch`,
    next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action ${action}${extra}` };
}
