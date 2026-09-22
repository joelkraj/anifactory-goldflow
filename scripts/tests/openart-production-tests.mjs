import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { test } from 'node:test';
import { dispatchCliBatch, prepareAssignments, prepareReadyReferenceAssignments, markSubmitted, importResult, runOpenArt } from '../openart-production.mjs';
import { bankPhase, openartProductionStageStates, listAssignments, latestAssignments, validationReviewState, refsApprovalCurrent, referenceWorkerPool } from '../lib/openart-production-state.mjs';
import { addCanonicalResult, fileHash, loadBank, requiredVisualChecks, reviewCanonicalAssets, synchronizeLibraryRecord, sha256 } from '../lib/openart-asset-bank.mjs';
import { buildExactOpenArtImageRequest, submitExactOpenArtImageBatch } from '../lib/openart-cli-provider.mjs';

const params = { quality: 'low', resolution: '1k', aspect_ratio: '16:9' };

test('A reviewed acceptance override selects the retained failed raster without deleting repair history', () => {
  const failed = { assignment_id: 'frame--original', asset_id: 'frame', scope: 'scene', created_at: '2026-01-01T00:00:00Z', receipt: { sha256: 'a'.repeat(64) }, failure: { reason: 'strict review' }, acceptance: { reviewer: 'operator' } };
  const abandonedRepair = { assignment_id: 'frame--repair', previous_assignment_id: 'frame--original', asset_id: 'frame', scope: 'scene', created_at: '2026-01-02T00:00:00Z', failure: { reason: 'superseded before dispatch' } };
  const selected = latestAssignments([failed, abandonedRepair], 'scene').get('frame');
  assert.equal(selected.assignment_id, failed.assignment_id);
  assert.equal(selected.failure, null);
  assert.deepEqual(selected.failure_history, failed.failure);
});
const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(value)}\n`); return file; };
async function fixture(t, { budget = 10, concurrency = 8, coreAssets = [], transport = 'openart_studio_browser' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goldflow-openart-prod-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const episodeDir = path.join(dir, 'episode'); const root = path.join(episodeDir, 'openart'); const bankRoot = path.join(dir, 'bank');
  const contract = { primary: { model_id: 'gpt-image-2-5-sunburst', ...params }, transport, concurrency, max_reference_count: 8, max_credit_cost: 10, total_credit_budget: budget, repair_models: [], reference_bank_path: bankRoot };
  const identity = { episode: 'ep01', image_provider: 'openart_cli', image_provider_options: { openart: contract } };
  await write(path.join(episodeDir, 'run_identity.json'), identity);
  const catalog = {
    schema: 'goldflow_openart_bank_catalog_v1', story_universe: 'fixture', series_scope: 'fixture', style_prompt: 'test style', source_script_sha256: '1'.repeat(64),
    assets: [{ asset_id: 'test.joey', asset_class: 'character', canonical_name: 'Joey', prompt: 'Canonical Joey.', phase: 'joey', reference_asset_ids: [] }, ...coreAssets],
    validation_shots: Array.from({ length: 8 }, (_, i) => ({ image_id: `validation.${i}`, prompt: `Validation ${i}.`, reference_asset_ids: ['test.joey'] })),
  };
  const catalogPath = await write(path.join(root, 'catalog.json'), catalog);
  const plan = { catalog_path: catalogPath, catalog_sha256: await fileHash(catalogPath), identity_sha256: await fileHash(path.join(episodeDir, 'run_identity.json')) };
  const planPath = await write(path.join(root, 'bank-plan.json'), plan);
  await write(path.join(root, 'plan-approval.json'), { approved: true, source_sha256: await fileHash(planPath) });
  const context = { episodeDir, root, bankRoot, catalog, plan, identity, contract };
  return context;
}
async function prepared(context) {
  return (await prepareAssignments(context, { scope: 'canonical', 'asset-ids': 'test.joey' })).assignments[0];
}
async function uiReceipt(context, assignment, extra = {}) {
  return write(path.join(context.root, `ui-${assignment.assignment_id}.json`), {
    attestation: 'exact_prompt_settings_and_ordered_references_visibly_verified', reviewer: 'synthetic-test',
    params, model_id: assignment.model_id, prompt_sha256: assignment.prompt_sha256, references: assignment.reference_bindings.map(({ asset_id, sha256: hash, openart_asset_id }) => ({ asset_id, sha256: hash, openart_asset_id })), image_count: 1,
    credits_quoted: 5, account_credits_available: 100, observed_at: new Date().toISOString(), discount_fraction: 0, ...extra,
  });
}
async function submit(context, assignment, extra) {
  return markSubmitted(context, { assignment: assignment.assignment_path, 'ui-receipt': await uiReceipt(context, assignment, extra) });
}
async function approvedCanonical(context) {
  const image = path.join(context.root, 'canonical-source.png');
  await sharp({ create: { width: 1024, height: 576, channels: 3, background: '#abcdef' } }).png().toFile(image);
  const item = context.catalog.assets[0]; const hash = await fileHash(image);
  const receipt = {
    schema: 'goldflow_openart_provider_receipt_v1', assignment_id: 'canonical-test', model: 'gpt-image-2-5-sunburst', mode: 'text2image', params,
    prompt_sha256: sha256(item.prompt), references: [], creation_id: 'new-canonical', openart_asset_id: 'new-canonical-media', output_sha256: hash,
    transport: 'openart_studio_browser', credits_quoted: 5, created_at: new Date().toISOString(),
  };
  const receiptPath = await write(path.join(context.root, 'canonical-provider.json'), receipt);
  const asset = await addCanonicalResult(context.bankRoot, {
    item, catalog: context.catalog, references: [], prompt: item.prompt, params, projectId: 'test-project',
    result: { ...receipt, output_path: image, sha256: hash, width: 1024, height: 576, provider_receipt_path: receiptPath, provider_receipt_sha256: await fileHash(receiptPath) },
  });
  await reviewCanonicalAssets(context.bankRoot, { attestation: 'each_listed_raster_visually_inspected', reviewer: 'synthetic-test', decisions: [{ asset_id: asset.asset_id, version: asset.version, sha256: asset.sha256, decision: 'approved', note: 'Synthetic test only.', checks: Object.fromEntries(requiredVisualChecks('character').map((key) => [key, true])) }] });
  await synchronizeLibraryRecord(context.bankRoot, { attestation: 'native_openart_library_asset_visibly_verified', reviewer: 'synthetic-test', evidence: 'Fixture only.', asset_id: asset.asset_id, version: asset.version, sha256: asset.sha256, openart_media_asset_id: asset.openart_asset_id, openart_library_asset_id: 'native-test', openart_library_kind: 'character' });
  return asset;
}

test('Low/1K settings, exact prompt/reference evidence, per-request cap and one-submit guard', async (t) => {
  const context = await fixture(t); const assignment = await prepared(context);
  for (const invalid of [{ params: { ...params, quality: 'medium' } }, { prompt_sha256: '0'.repeat(64) }, { references: [{ asset_id: 'unexpected' }] }, { credits_quoted: 11 }, { image_count: 2 }, { discount_fraction: 0.1 }]) {
    await assert.rejects(submit(context, assignment, invalid));
  }
  await submit(context, assignment);
  await assert.rejects(submit(context, assignment), /exist|submission|already/i);
});

test('Malformed and future quote timestamps cannot authorize spend', async (t) => {
  for (const stamp of ['invalid-date', '2099-01-01T00:00:00Z']) {
    const context = await fixture(t); const assignment = await prepared(context);
    await assert.rejects(submit(context, assignment, { observed_at: stamp }), /quote|timestamp|future|time/i);
  }
});

test('Removing plan approval after prepare revokes unspent dispatch', async (t) => {
  const context = await fixture(t); const assignment = await prepared(context);
  await fs.unlink(path.join(context.root, 'plan-approval.json'));
  await assert.rejects(submit(context, assignment), /approval|plan/i);
});

test('Duplicate IDs cannot prepare two initial creative attempts', async (t) => {
  const context = await fixture(t);
  await assert.rejects(prepareAssignments(context, { scope: 'canonical', 'asset-ids': 'test.joey,test.joey' }), /duplicate|one|repeat/i);
});

test('Scene generation remains blocked before canonical validation and approval', async (t) => {
  const context = await fixture(t);
  await assert.rejects(prepareAssignments(context, { scope: 'scene', 'image-ids': 'frame.001' }), /approval|incomplete/i);
});

test('Budget reservation is serialized across concurrent submissions', async (t) => {
  const context = await fixture(t); await approvedCanonical(context);
  context.contract.total_credit_budget = 5;
  const assignments = (await prepareAssignments(context, { scope: 'validation', 'image-ids': 'validation.0,validation.1' })).assignments;
  const outcomes = await Promise.allSettled(assignments.map((assignment) => submit(context, assignment)));
  assert.equal(outcomes.filter((row) => row.status === 'fulfilled').length, 1, 'Two competing 5-credit submissions must not both reserve a 5-credit budget.');
});

test('Reference worker pool prepares only bounded independent next-ready assets', async (t) => {
  const coreAssets = [
    { asset_id: 'test.brother', asset_class: 'character', canonical_name: 'Brother', prompt: 'Canonical brother.', phase: 'core', reference_asset_ids: [] },
    { asset_id: 'test.dad', asset_class: 'character', canonical_name: 'Dad', prompt: 'Canonical dad.', phase: 'core', reference_asset_ids: [] },
    { asset_id: 'test.casino', asset_class: 'location', canonical_name: 'Casino', prompt: 'Canonical casino.', phase: 'core', reference_asset_ids: [] },
    { asset_id: 'test.brother.suit', asset_class: 'wardrobe', canonical_name: 'Brother suit', prompt: 'Brother in suit.', phase: 'core', reference_asset_ids: ['test.brother'] },
  ];
  const context = await fixture(t, { budget: 20, coreAssets });
  await approvedCanonical(context);
  const before = await referenceWorkerPool(context, { maxWorkers: 2 });
  assert.deepEqual(before.ready_ids, ['test.brother', 'test.dad']);
  assert.deepEqual(before.queued_ready_ids, ['test.casino']);
  assert.deepEqual(before.waiting_on_dependencies.map((row) => row.asset_id), ['test.brother.suit']);

  const preparedPool = await prepareReadyReferenceAssignments(context, { 'max-workers': '2' });
  assert.equal(preparedPool.assignments.length, 2);
  assert.deepEqual(preparedPool.assignments.map((row) => row.asset_id), ['test.brother', 'test.dad']);
  assert.ok(preparedPool.assignments.every((row) => row.params.quality === 'low' && row.prompt_sha256 === sha256(row.prompt)));
  assert.equal(preparedPool.worker_pool.active_count, 2);
  assert.ok(preparedPool.worker_pool.workers.every((row) => row.next_command_shape.includes('--action mark-submitted')));

  const noOverfill = await prepareReadyReferenceAssignments(context, { 'max-workers': '2' });
  assert.equal(noOverfill.assignments.length, 0);
  assert.equal((await listAssignments(context.root)).filter((row) => row.scope === 'canonical' && row.catalog_sha256 === context.plan.catalog_sha256).length, 2);
  await assert.rejects(referenceWorkerPool(context, { maxWorkers: 9 }), /1 through 8/);
});

test('Reference worker pool cannot exceed immutable identity concurrency', async (t) => {
  const context = await fixture(t, { concurrency: 1, coreAssets: [
    { asset_id: 'test.brother', asset_class: 'character', canonical_name: 'Brother', prompt: 'Canonical brother.', phase: 'core', reference_asset_ids: [] },
    { asset_id: 'test.dad', asset_class: 'character', canonical_name: 'Dad', prompt: 'Canonical dad.', phase: 'core', reference_asset_ids: [] },
  ] });
  await approvedCanonical(context);
  await assert.rejects(referenceWorkerPool(context, { maxWorkers: 2 }), /identity-locked concurrency 1/);
  await assert.rejects(prepareReadyReferenceAssignments(context, { 'max-workers': '2' }), /identity-locked concurrency 1/);
  const allowed = await prepareReadyReferenceAssignments(context, {});
  assert.equal(allowed.assignments.length, 1);
});

test('CLI reference worker pool permits the identity-locked Pro limit of thirty-two', async (t) => {
  const coreAssets = Array.from({ length: 32 }, (_, index) => ({
    asset_id: `test.cli.${index}`, asset_class: 'location', canonical_name: `CLI ${index}`,
    prompt: `Canonical CLI location ${index}.`, phase: 'core', reference_asset_ids: [],
  }));
  const context = await fixture(t, { budget: 320, concurrency: 32, coreAssets, transport: 'openart_cli_v1' });
  await approvedCanonical(context);
  const pool = await referenceWorkerPool(context, { maxWorkers: 32 });
  assert.equal(pool.ready_ids.length, 32);
  await assert.rejects(referenceWorkerPool(context, { maxWorkers: 33 }), /1 through 32/);
});

test('Guarded CLI bridge dry-runs, reserves once, downloads, and emits an import-ready receipt without exposing URLs', async (t) => {
  const context = await fixture(t, { budget: 20, concurrency: 2, transport: 'openart_cli_v1' });
  const assignment = await prepared(context);
  const quoteBatch = async ({ jobs }) => ({
    observed_at: new Date().toISOString(), plan: 'Pro', account_credits_available: 100,
    quotes: jobs.map((job) => {
      const request = buildExactOpenArtImageRequest(job);
      return { model: request.model, mode: request.mode, credits: 5, config: {}, reference_count: job.references.length, request_sha256: sha256(JSON.stringify(request)) };
    }),
  });
  const dry = await dispatchCliBatch(context, {
    'batch-id': 'bridge-dry-001', assignments: assignment.assignment_path,
    'project-id': 'project1', concurrency: '1', execute: 'false',
  }, { quoteBatch, submitBatch: submitExactOpenArtImageBatch, runCli: async () => { throw new Error('dry run unexpectedly used provider CLI'); } });
  assert.equal(dry.status, 'dry_run_not_submitted');
  assert.equal((await listAssignments(context.root))[0].submitted, null);
  const dryBytes = await fs.readFile(dry.exact.results[0].provider_receipt_path, 'utf8');
  assert(!dryBytes.includes('cdn.openart.ai'));

  const submitBatch = async ({ jobs, execute }) => {
    assert.equal(execute, true);
    const results = [];
    for (const job of jobs) {
      const bytes = `${JSON.stringify({ historyId: `history-${job.assignmentId}` })}\n`;
      await fs.mkdir(path.dirname(job.receiptPath), { recursive: true }); await fs.writeFile(job.receiptPath, bytes, { flag: 'wx' });
      results.push({ assignment_id: job.assignmentId, history_id: `history-${job.assignmentId}`, provider_receipt_path: job.receiptPath, provider_receipt_sha256: sha256(bytes) });
    }
    return { results };
  };
  const runCli = async (args) => {
    if (args[0] === 'account') return { plan: 'Pro', credits: 95 };
    if (args[0] === 'creation' && args[1] === 'wait') return {
      history: { id: args[2], status: 'completed' },
      resources: [{ id: `media-${assignment.assignment_id}`, resourceType: 'image', status: 'completed', createdAt: Date.now(), generation: { historyId: args[2] } }],
    };
    throw new Error(`Unexpected CLI call ${args.join(' ')}`);
  };
  const downloadCreation = async ({ outputPath, receiptPath }) => {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await sharp({ create: { width: 1792, height: 1008, channels: 3, background: '#456789' } }).png().toFile(outputPath);
    const hash = await fileHash(outputPath); await write(receiptPath, { sha256: hash, width: 1792, height: 1008, format: 'png' });
    return { sha256: hash, width: 1792, height: 1008, format: 'png' };
  };
  const executed = await dispatchCliBatch(context, {
    'batch-id': 'bridge-paid-001', assignments: assignment.assignment_path,
    'project-id': 'project1', concurrency: '1', execute: 'true', 'confirm-spend': 'exact_openart_batch',
  }, { quoteBatch, submitBatch, runCli, downloadCreation });
  assert.equal(executed.status, 'completed_import_ready');
  assert.equal(executed.results.length, 1);
  const importReceipt = JSON.parse(await fs.readFile(executed.results[0].import_receipt_path, 'utf8'));
  assert.equal(importReceipt.attestation, 'openart_cli_result_identity_and_download_verified');
  assert(!JSON.stringify(importReceipt).includes('cdn.openart.ai'));
  const imported = await importResult(context, { assignment: assignment.assignment_path, receipt: executed.results[0].import_receipt_path });
  assert.equal(imported.openart_asset_id, `media-${assignment.assignment_id}`);
});

test('Guarded CLI bridge resolves only the approved OpenArt media identity and persists no CDN URL', async (t) => {
  const context = await fixture(t, { budget: 20, concurrency: 2, transport: 'openart_cli_v1' });
  const canonical = await approvedCanonical(context);
  const assignment = (await prepareAssignments(context, { scope: 'validation', 'image-ids': 'validation.0' })).assignments[0];
  let resolved = false;
  const runCli = async (args) => {
    assert.deepEqual(args, ['creation', 'get', canonical.openart_creation_id]); resolved = true;
    return { history: { id: canonical.openart_creation_id, status: 'completed' }, resources: [{
      id: canonical.openart_asset_id, resourceType: 'image', status: 'completed',
      url: 'https://cdn.openart.ai/reference.png?signature=private', generation: { historyId: canonical.openart_creation_id },
    }] };
  };
  const quoteBatch = async ({ jobs }) => {
    assert.equal(jobs[0].references[0].id, canonical.openart_asset_id);
    assert.match(jobs[0].references[0].url, /signature=private/);
    const request = buildExactOpenArtImageRequest(jobs[0]);
    return { observed_at: new Date().toISOString(), account_credits_available: 100, quotes: [{ model: request.model, mode: request.mode, credits: 6, request_sha256: sha256(JSON.stringify(request)) }] };
  };
  const dry = await dispatchCliBatch(context, {
    'batch-id': 'reference-dry-001', assignments: assignment.assignment_path,
    'project-id': 'project1', concurrency: '1', execute: 'false',
  }, { quoteBatch, submitBatch: submitExactOpenArtImageBatch, runCli });
  assert.equal(resolved, true);
  assert(!JSON.stringify(dry).includes('cdn.openart.ai'));
  assert(!await fs.readFile(dry.plan_path, 'utf8').then((bytes) => bytes.includes('cdn.openart.ai')));
  assert(!await fs.readFile(dry.exact.results[0].provider_receipt_path, 'utf8').then((bytes) => bytes.includes('cdn.openart.ai')));
});

test('Concurrent reference workers still serialize credit reservation', async (t) => {
  const coreAssets = ['brother', 'dad', 'casino'].map((name) => ({ asset_id: `test.${name}`, asset_class: name === 'casino' ? 'location' : 'character', canonical_name: name, prompt: `Canonical ${name}.`, phase: 'core', reference_asset_ids: [] }));
  const context = await fixture(t, { budget: 10, coreAssets });
  await approvedCanonical(context);
  const assignments = (await prepareReadyReferenceAssignments(context, { 'max-workers': '3' })).assignments;
  const outcomes = await Promise.allSettled(assignments.map((assignment) => submit(context, assignment)));
  assert.equal(outcomes.filter((row) => row.status === 'fulfilled').length, 2);
  assert.equal(outcomes.filter((row) => row.status === 'rejected').length, 1);
});

test('Reference review revoked after preparation prevents unspent dispatch', async (t) => {
  const context = await fixture(t); const asset = await approvedCanonical(context);
  const assignment = (await prepareAssignments(context, { scope: 'validation', 'image-ids': 'validation.0' })).assignments[0];
  await reviewCanonicalAssets(context.bankRoot, { attestation: 'each_listed_raster_visually_inspected', reviewer: 'synthetic-test', decisions: [{ asset_id: asset.asset_id, version: asset.version, sha256: asset.sha256, decision: 'rejected', note: 'Synthetic late identity rejection.', checks: Object.fromEntries(requiredVisualChecks('character').map((key) => [key, key !== 'identity'])) }] });
  await assert.rejects(submit(context, assignment), /reference|approved|review|phase|triage/i);
});

test('Replacing assigned provider reference ID cannot authorize a different native source', async (t) => {
  const context = await fixture(t); await approvedCanonical(context);
  const assignment = (await prepareAssignments(context, { scope: 'validation', 'image-ids': 'validation.0' })).assignments[0];
  const edited = JSON.parse(await fs.readFile(assignment.assignment_path, 'utf8'));
  edited.reference_bindings[0].openart_asset_id = 'not-the-approved-media';
  await write(assignment.assignment_path, edited);
  await assert.rejects(submit(context, { ...edited, assignment_path: assignment.assignment_path }), /reference|binding|changed|exact/i);
});

test('Repair-only model cannot become the first creative attempt for an exact ID', async (t) => {
  const context = await fixture(t); await approvedCanonical(context);
  context.contract.repair_models = [{ model_id: 'nano-banana-2', exact_id_only: true, repair_only: true }];
  const repair = await write(path.join(context.root, 'invented-repair.json'), { asset_id: 'validation.0', prior_assignment_id: 'nonexistent', reviewer: 'synthetic-test', reason: 'No previous generation actually exists.', primary_failure_unresolved: true, model_id: 'nano-banana-2' });
  await assert.rejects(prepareAssignments(context, { scope: 'validation', 'image-ids': 'validation.0', repair }), /prior|initial|first|repair|failed/i);
});

test('Reviewed exact-ID repair may narrowly correct the failed prompt without changing the catalog', async (t) => {
  const context = await fixture(t);
  const first = await prepared(context);
  await write(path.join(context.root, 'failures', `${first.assignment_id}.json`), {
    assignment_id: first.assignment_id,
    reason: 'Synthetic exact output failed its single-concept visual check.',
    automatic_retry: false,
  });
  const correctedPrompt = 'Exactly one vehicle in one three-quarter view. No inset, second angle, contact sheet, turnaround, or collage.';
  const repairPath = await write(path.join(context.root, 'reviewed-prompt-repair.json'), {
    asset_id: first.asset_id,
    prior_assignment_id: first.assignment_id,
    reviewer: 'synthetic-test',
    reason: 'The failed exact output repeated a multi-view collage and requires a narrower single-view instruction.',
    prompt_override: correctedPrompt,
  });
  const repaired = (await prepareAssignments(context, { scope: 'canonical', 'asset-ids': first.asset_id, repair: repairPath })).assignments[0];
  assert.equal(repaired.prompt, correctedPrompt);
  assert.equal(repaired.prompt_sha256, sha256(correctedPrompt));
  assert.equal(repaired.previous_assignment_id, first.assignment_id);
  assert.equal(repaired.repair_evidence.prompt_override, correctedPrompt);
  assert.equal(context.catalog.assets[0].prompt, 'Canonical Joey.');
  await submit(context, repaired);
});

test('Assignment mutation cannot introduce an undiscovered repair model before spend', async (t) => {
  const context = await fixture(t); await approvedCanonical(context);
  const assignment = (await prepareAssignments(context, { scope: 'validation', 'image-ids': 'validation.0' })).assignments[0];
  const edited = JSON.parse(await fs.readFile(assignment.assignment_path, 'utf8'));
  edited.model_id = 'unapproved-model'; edited.repair_evidence = { primary_failure_unresolved: true };
  await write(assignment.assignment_path, edited);
  await assert.rejects(submit(context, { ...edited, assignment_path: assignment.assignment_path }), /model|repair|fallback|assignment|changed/i);
});

test('A prepared newer exact-ID repair advances ahead of the rejected canonical version', async (t) => {
  const context = await fixture(t); const asset = await approvedCanonical(context);
  await reviewCanonicalAssets(context.bankRoot, { attestation: 'each_listed_raster_visually_inspected', reviewer: 'synthetic-test', decisions: [{ asset_id: asset.asset_id, version: asset.version, sha256: asset.sha256, decision: 'rejected', note: 'Synthetic repair.', checks: Object.fromEntries(requiredVisualChecks('character').map((key) => [key, key !== 'identity'])) }] });
  const newer = { schema: 'goldflow_openart_assignment_v1', assignment_id: 'test.joey--a', asset_id: 'test.joey', scope: 'canonical', previous_assignment_id: 'test.joey--z', repair_evidence: { rejected_output_sha256: asset.sha256 }, created_at: '2026-09-22T12:00:01Z' };
  await write(path.join(context.root, 'assignments', 'test.joey--z.json'), { ...newer, assignment_id: 'test.joey--z', previous_assignment_id: null, repair_evidence: null, created_at: '2026-09-22T12:00:00Z' });
  await write(path.join(context.root, 'assignments', 'test.joey--a.json'), newer);
  const phase = await bankPhase(context);
  assert.equal(phase.action, 'mark-submitted');
  assert.equal(phase.assignment.assignment_id, newer.assignment_id);
});

test('Output predating this assignment cannot be imported as a fresh OpenArt generation', async (t) => {
  const context = await fixture(t); const assignment = await prepared(context); await submit(context, assignment);
  const output = path.join(context.root, 'historical-output.png');
  await sharp({ create: { width: 1024, height: 576, channels: 3, background: '#123456' } }).png().toFile(output);
  const observed = await write(path.join(context.root, 'historical-result.json'), {
    attestation: 'openart_result_identity_and_download_visibly_verified', reviewer: 'synthetic-test', assignment_id: assignment.assignment_id,
    submission_sha256: await fileHash(path.join(context.root, 'submissions', `${assignment.assignment_id}.json`)),
    creation_id: 'historical-creation', openart_asset_id: 'historical-media', output_path: output, sha256: await fileHash(output),
    created_at: '2020-01-01T00:00:00.000Z', project_id: 'test-project',
  });
  await assert.rejects(importResult(context, { assignment: assignment.assignment_path, receipt: observed }), /historical|predat|timestamp|submission|time/i);
});

test('Fresh exact first Joey imports once and remains pending actual visual review', async (t) => {
  const context = await fixture(t); const assignment = await prepared(context); await submit(context, assignment);
  const output = path.join(context.root, 'new-output.png');
  await sharp({ create: { width: 1024, height: 576, channels: 3, background: '#6789ab' } }).png().toFile(output);
  const observed = await write(path.join(context.root, 'new-result.json'), {
    attestation: 'openart_result_identity_and_download_visibly_verified', reviewer: 'synthetic-test', assignment_id: assignment.assignment_id,
    submission_sha256: await fileHash(path.join(context.root, 'submissions', `${assignment.assignment_id}.json`)),
    creation_id: 'fresh-creation', openart_asset_id: 'fresh-media', output_path: output, sha256: await fileHash(output),
    created_at: new Date().toISOString(), project_id: 'test-project', credits_charged: 5,
  });
  const imported = await importResult(context, { assignment: assignment.assignment_path, receipt: observed });
  assert.equal(imported.bank_record.approval_state, 'needs_visual_review');
  assert.equal(imported.bank_record.openart_asset_id, 'fresh-media');
  assert.equal((await bankPhase(context)).action, 'review');
  await assert.rejects(importResult(context, { assignment: assignment.assignment_path, receipt: observed }), /already imported|immutable/i);
});

test('Bank status rejects validation receipts without exact submitted generation provenance', async (t) => {
  const context = await fixture(t); const canonical = await approvedCanonical(context);
  const decisions = [];
  for (const shot of context.catalog.validation_shots) {
    const assignmentId = `${shot.image_id}--fixture`;
    await write(path.join(context.root, 'assignments', `${assignmentId}.json`), { assignment_id: assignmentId, asset_id: shot.image_id, scope: 'validation' });
    await write(path.join(context.root, 'results', `${assignmentId}.json`), { output_path: canonical.local_absolute_path, sha256: canonical.sha256 });
    decisions.push({ image_id: shot.image_id, sha256: canonical.sha256, decision: 'approved', checks: {} });
  }
  await write(path.join(context.root, 'validation-review.json'), { attestation: 'validation_set_visually_inspected_end_to_end', decisions });
  await assert.rejects(bankPhase(context), /exact assignment|submission|receipt/i);
});

async function structuralValidation(context) {
  const assignments = context.catalog.validation_shots.map((shot, index) => ({ assignment_id: `${shot.image_id}--fixture`, asset_id: shot.image_id, scope: 'validation', receipt: { sha256: String(index + 1).repeat(64) } }));
  const review = { attestation: 'validation_set_visually_inspected_end_to_end', reviewer: 'synthetic-test', decisions: assignments.map((row) => ({ image_id: row.asset_id, sha256: row.receipt.sha256, decision: 'approved', note: 'Synthetic structural review only.', checks: Object.fromEntries(['identity_consistency', 'hands', 'prop_fidelity', 'composition', 'roulette_details', 'no_unwanted_text'].map((key) => [key, true])) })) };
  for (const assignment of assignments) {
    await write(path.join(context.root, 'assignments', `${assignment.assignment_id}.json`), { ...assignment, receipt: undefined });
    await write(path.join(context.root, 'results', `${assignment.assignment_id}.json`), assignment.receipt);
  }
  await write(path.join(context.root, 'validation-review.json'), review);
  return { assignments, review };
}

test('Each validation decision needs reviewer, exact unique ID, note and actual critical checks', async (t) => {
  const context = await fixture(t); const { assignments, review } = await structuralValidation(context);
  assert.equal((await validationReviewState(context, assignments)).approved, true);
  const mutations = [
    (row) => { delete row.reviewer; },
    (row) => { row.decisions[0].checks = {}; },
    (row) => { row.decisions[0].note = ' '; },
    (row) => { row.decisions[0].checks.hands = false; },
    (row) => { row.decisions[1] = row.decisions[0]; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(review); mutate(changed);
    await write(path.join(context.root, 'validation-review.json'), changed);
    await assert.rejects(validationReviewState(context, assignments), /review|check|eight|ID|inspect/i);
  }
});

test('Final reference approval binds exact canonical version/native ID and validation review hash', async (t) => {
  const context = await fixture(t); await approvedCanonical(context);
  const { review } = await structuralValidation(context);
  const asset = (await loadBank(context.bankRoot)).assets[0];
  const approval = {
    approved: true, source_sha256: await fileHash(path.join(context.root, 'bank-plan.json')),
    validation_review_sha256: await fileHash(path.join(context.root, 'validation-review.json')),
    references: [{ asset_id: asset.asset_id, version: asset.version, sha256: asset.sha256, openart_asset_id: asset.openart_asset_id, openart_library_asset_id: asset.openart_library_asset_id, review: asset.review }],
  };
  const approvalFile = path.join(context.root, 'refs-approval.json');
  await write(approvalFile, approval);
  assert.equal(await refsApprovalCurrent(context), true);
  const stale = structuredClone(approval); stale.references[0].openart_library_asset_id = 'stale-native-id';
  await write(approvalFile, stale);
  assert.equal(await refsApprovalCurrent(context), false);
  await write(approvalFile, approval);
  review.decisions[0].note = 'Changed after the final bank approval.';
  await write(path.join(context.root, 'validation-review.json'), review);
  assert.equal(await refsApprovalCurrent(context), false);
});

test('Stage status cannot accept a fabricated image report with no new OpenArt assignments/receipts', async (t) => {
  const context = await fixture(t); const canonical = await approvedCanonical(context);
  const shots = { prompts: [{ image_id: 'frame.001' }] };
  const planFile = await write(path.join(context.episodeDir, 'section_image_prompts.json'), shots);
  const hardFile = await write(path.join(context.episodeDir, 'section_image_prompts_hardened.json'), shots);
  await write(path.join(context.root, 'shot-binding.json'), { output_sha256: await fileHash(planFile) });
  await write(path.join(context.root, 'hardened-receipt.json'), { input_sha256: await fileHash(planFile), output_sha256: await fileHash(hardFile) });
  await write(path.join(context.episodeDir, 'imagegen_report_ep01.json'), { prompt_plan_hash: await fileHash(hardFile), results: [{ image_id: 'frame.001', image_path: canonical.local_absolute_path, generated: { output_sha256: canonical.sha256, provider: 'gemini_web' } }] });
  const states = await openartProductionStageStates({ episodeDir: context.episodeDir, identity: context.identity });
  assert.notEqual(states.stageStates.image_generation?.done, true, 'Old or fabricated image reports must not complete new OpenArt generation.');
});

test('Eight fresh validation submissions require their complete visual review before bank approval', async (t) => {
  const context = await fixture(t, { budget: 50 }); await approvedCanonical(context);
  const assignments = (await prepareAssignments(context, { scope: 'validation', 'image-ids': context.catalog.validation_shots.map((row) => row.image_id).join(',') })).assignments;
  const decisions = [];
  for (const [index, assignment] of assignments.entries()) {
    await submit(context, assignment);
    const output = path.join(context.root, `validation-source-${index}.png`);
    await sharp({ create: { width: 1024, height: 576, channels: 3, background: { r: 120 + index, g: 140, b: 200 } } }).png().toFile(output);
    const observed = await write(path.join(context.root, `validation-result-${index}.json`), {
      attestation: 'openart_result_identity_and_download_visibly_verified', reviewer: 'synthetic-test', assignment_id: assignment.assignment_id,
      submission_sha256: await fileHash(path.join(context.root, 'submissions', `${assignment.assignment_id}.json`)),
      creation_id: `validation-creation-${index}`, openart_asset_id: `validation-media-${index}`, output_path: output, sha256: await fileHash(output),
      created_at: new Date().toISOString(), project_id: 'test-project', credits_charged: 5,
    });
    const result = await importResult(context, { assignment: assignment.assignment_path, receipt: observed });
    decisions.push({ image_id: assignment.asset_id, sha256: result.sha256, decision: 'approved', note: 'Synthetic fixture, never production approval.', checks: Object.fromEntries(['identity_consistency', 'hands', 'prop_fidelity', 'composition', 'roulette_details', 'no_unwanted_text'].map((key) => [key, true])) });
  }
  assert.equal((await bankPhase(context)).action, 'review');
  const reviewFile = await write(path.join(context.root, 'review-input.json'), { attestation: 'validation_set_visually_inspected_end_to_end', reviewer: 'synthetic-test', decisions });
  await runOpenArt({ 'episode-dir': context.episodeDir, action: 'review', scope: 'validation', review: reviewFile });
  assert.equal((await bankPhase(context)).phase, 'complete');
  await runOpenArt({ 'episode-dir': context.episodeDir, action: 'approve-refs' });
  assert.equal(await refsApprovalCurrent(context), true);
  const recordedReview = JSON.parse(await fs.readFile(path.join(context.root, 'validation-review.json'), 'utf8'));
  assert.equal(await fileHash(recordedReview.immutable_path), recordedReview.immutable_sha256);
  await fs.appendFile(recordedReview.immutable_path, ' ');
  await assert.rejects(bankPhase(context), /immutable|changed|hash|review/i);
});
