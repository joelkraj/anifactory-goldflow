import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  readJson, writeOnce, fileHash, sha256, loadBank, currentAsset, verifyAsset, PRIMARY_MODEL,
} from './openart-asset-bank.mjs';

const MIGRATION_SCHEMA = 'goldflow_openart_shot_migration_proposal_v1';
const BINDING_SCHEMA = 'goldflow_openart_shot_binding_v1';
const HARDENED_SCHEMA = 'goldflow_openart_hardened_receipt_v1';
const PRESERVED_FIELDS = [
  'image_id', 'scene_id', 'visual_beat_id', 'visual_beat_action', 'visual_beat_script_excerpt',
  'visual_job', 'editorial_cues', 'suggested_shot_job', 'visual_novelty_directive',
  'visual_information_delta', 'sequence_grammar', 'spatial_continuity', 'beat_value',
  'retention_reset', 'audiovisual_intent', 'quality_budget', 'location_timeline_label',
  'depiction_mode', 'physically_visible_entity_ids', 'screen_visible_entity_ids',
  'preview_visible_entity_ids', 'mentioned_only_entity_ids', 'active_state_constraints',
  'start_sec', 'duration_sec', 'location', 'narrative_overlays', 'ui_text_on_screen',
  'visible_subjects', 'primary_subject',
];
const AUTHOR_FIELDS = new Set([
  ...PRESERVED_FIELDS, 'prompt', 'source_authored_prompt_sha256', 'shot_manifest',
  'reference_asset_ids', 'reference_bindings', 'extra_reference_reason',
  'image_generation_required', 'image_strategy', 'status', 'model_id', 'settings',
  'source_timing_unchanged', 'historical_frame_or_reference_reused',
]);
const FORBIDDEN_METADATA = /^(?:.*(?:image|raster|receipt)_path|(?:conditioning|reference)_image_path|(?:.*_)?(?:image|raster)_sha256|(?:image_)?provider(?:_route)?|image_model_route|generated|approval_state|approval|source_image_id)$/;
const SHOT_REFERENCE_KEYS = new Set(['ref_id', 'identity_ref_id', 'location_ref_id', 'protagonist_state_ref_id', 'character_state_ref_ids', 'forbidden_ref_ids']);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function requireTrue(value, message) { if (!value) throw new Error(message); }
const bindingCore = (row) => ({
  asset_id: row.asset_id, version: row.version, sha256: row.sha256,
  openart_asset_id: row.openart_asset_id, openart_library_asset_id: row.openart_library_asset_id,
  openart_library_kind: row.openart_library_kind,
});
function kindFor(asset) {
  return ({ character: 'character_state', wardrobe: 'character_state', location: 'location', object: 'prop', style: 'style' })[asset.asset_class];
}
function roleFor(asset) {
  return ({ character: 'identity_state', wardrobe: 'identity_state', location: 'environment', object: 'prop', style: 'style_language' })[asset.asset_class];
}
async function appendEvent(root, event) {
  await fs.appendFile(path.join(root, 'events.jsonl'), `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`);
}
async function requireUnused(paths) {
  for (const target of paths) {
    try { await fs.lstat(target); throw new Error(`Immutable OpenArt output already exists: ${target}. Use exact-scope recovery, not a whole-stage rerun.`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function prerequisites(context) {
  const { episodeDir, identity, root, catalog, plan, contract } = context;
  requireTrue(identity?.image_provider === 'openart_cli' && identity.visual_restart?.baseline_episode_dir,
    'Shot binding requires the immutable OpenArt visual-restart identity.');
  requireTrue(root === path.join(episodeDir, 'openart') && path.isAbsolute(episodeDir), 'Invalid OpenArt episode root.');
  requireTrue(plan && catalog && contract.primary?.model_id === PRIMARY_MODEL
    && contract.primary.quality === 'low' && contract.primary.resolution === '1k'
    && contract.primary.aspect_ratio === '16:9', 'Shot binding requires the admitted Low/1K/16:9 catalog.');
  const identityPath = path.join(episodeDir, 'run_identity.json');
  requireTrue(equal(await readJson(identityPath), identity), 'Context identity differs from its immutable file.');
  requireTrue(await fileHash(plan.catalog_path) === plan.catalog_sha256, 'Admitted canonical catalog changed.');
  requireTrue(equal(await readJson(plan.catalog_path), catalog), 'Context catalog differs from admitted catalog.');
  const planPath = path.join(root, 'bank-plan.json');
  requireTrue(equal(await readJson(planPath), plan), 'Context bank plan differs from its immutable file.');
  const approvalPath = path.join(root, 'refs-approval.json');
  const approval = await readJson(approvalPath);
  requireTrue(approval?.approved === true && approval.source_sha256 === await fileHash(planPath),
    'Current canonical bank approval is required before binding or hardening shots.');
  const scriptPath = path.join(episodeDir, 'script_clean.md');
  const scriptHash = await fileHash(scriptPath);
  requireTrue(scriptHash === catalog.source_script_sha256 && scriptHash === plan.source_script_sha256,
    'Shot binding script differs from the approved canonical source.');
  const baselineDir = path.resolve(identity.visual_restart.baseline_episode_dir);
  requireTrue(baselineDir !== path.resolve(episodeDir), 'Historical and new attempts must be separate.');
  requireTrue(await fileHash(path.join(baselineDir, 'run_identity.json')) === identity.visual_restart.baseline_identity_sha256,
    'Historical identity changed after restart.');
  return { identityPath, approvalPath, scriptPath, scriptHash, baselineDir };
}
function assertAuthoredMetadata(value, catalogIds, field = 'shot') {
  if (Array.isArray(value)) { value.forEach((row, i) => assertAuthoredMetadata(row, catalogIds, `${field}/${i}`)); return; }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && (/\/(?:assets\/images|codex_worker_staging)\//.test(value) || /^(?:https?:|file:)\/\//.test(value))) {
      throw new Error(`Historical/remote image transport is forbidden in authored shots: ${field}`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    requireTrue(!FORBIDDEN_METADATA.test(key), `Historical provider/image/approval metadata is forbidden: ${field}/${key}`);
    if (SHOT_REFERENCE_KEYS.has(key)) {
      for (const id of Array.isArray(item) ? item : [item]) {
        if (id != null) requireTrue(catalogIds.has(id), `Unresolved canonical reference ${id} in ${field}/${key}`);
      }
    }
    assertAuthoredMetadata(item, catalogIds, `${field}/${key}`);
  }
}
function checkPromptDelta(source, shot, ledger) {
  const original = source.provider_prompt ?? source.image_prompt;
  requireTrue(typeof original === 'string' && sha256(original) === shot.source_authored_prompt_sha256,
    `Historical authored-prompt hash mismatch: ${shot.image_id}`);
  let current = original;
  for (const delta of ledger.filter((row) => row.image_id === shot.image_id && row.field === 'prompt')) {
    requireTrue(delta.before === current && typeof delta.after === 'string' && delta.reason?.trim(),
      `Prompt mutation lacks sequential exact editorial evidence: ${shot.image_id}`);
    current = delta.after;
  }
  requireTrue(current === shot.prompt, `Unrecorded authored prompt change: ${shot.image_id}`);
}
export function validateOpenArtShotMigration(proposal, source, beats, catalog, maxReferences = 8) {
  requireTrue(proposal?.schema === MIGRATION_SCHEMA && Array.isArray(proposal.shots)
    && Array.isArray(proposal.change_ledger), 'An authored OpenArt shot migration with change ledger is required.');
  requireTrue(proposal.historical_images_or_approvals_imported === false
    && proposal.source_ids_order_timing_and_script_excerpts_preserved === true,
  'Shot migration must explicitly exclude historical images and preserve approved timing.');
  requireTrue(proposal.shot_count === proposal.shots.length && proposal.shots.length === source.prompts?.length
    && proposal.shots.length === beats.beats?.length, 'Shot migration must cover the complete approved episode exactly once.');
  const catalogMap = new Map(catalog.assets.map((row) => [row.asset_id, row]));
  const catalogIds = new Set(catalogMap.keys()); const seen = new Set();
  for (const [index, shot] of proposal.shots.entries()) {
    const prior = source.prompts[index]; const beat = beats.beats[index];
    requireTrue(!seen.has(shot.image_id), `Duplicate production image ID ${shot.image_id}`); seen.add(shot.image_id);
    requireTrue(Object.keys(shot).every((key) => AUTHOR_FIELDS.has(key)), `Unsupported authored shot metadata: ${shot.image_id}`);
    for (const field of PRESERVED_FIELDS) {
      // Missing optional legacy editorial metadata is copied unchanged from the approved source.
      if (Object.hasOwn(shot, field)) requireTrue(equal(shot[field], prior[field]), `Approved ${field} changed: ${shot.image_id}`);
    }
    for (const field of ['image_id', 'scene_id', 'visual_beat_id', 'start_sec', 'duration_sec', 'visual_beat_script_excerpt']) {
      requireTrue(Object.hasOwn(shot, field) && equal(shot[field], prior[field]), `Required approved ${field} changed: ${shot.image_id}`);
    }
    requireTrue(shot.image_id === beat.image_id_hint && shot.visual_beat_id === beat.visual_beat_id
      && shot.scene_id === beat.scene_id && shot.start_sec === beat.start_sec && shot.duration_sec === beat.duration_sec
      && shot.visual_beat_script_excerpt === beat.visual_beat_script_excerpt,
    `Shot does not match the approved beat order/timing/text: ${shot.image_id}`);
    requireTrue(Number.isFinite(shot.start_sec) && shot.start_sec >= 0 && Number.isFinite(shot.duration_sec)
      && shot.duration_sec > 0 && shot.prompt?.trim(), `Invalid timed shot: ${shot.image_id}`);
    requireTrue(shot.image_generation_required === true && shot.historical_frame_or_reference_reused === false
      && shot.source_timing_unchanged === true && shot.image_strategy === 'fresh_openart_restart',
    `Every shot requires fresh OpenArt generation: ${shot.image_id}`);
    requireTrue(shot.model_id === PRIMARY_MODEL && shot.settings?.quality === 'low'
      && String(shot.settings?.resolution).toLowerCase() === '1k' && shot.settings?.aspect_ratio === '16:9',
    `Authored shot changed the locked model/settings: ${shot.image_id}`);
    const ids = shot.reference_asset_ids;
    requireTrue(Array.isArray(ids) && ids.length <= maxReferences && new Set(ids).size === ids.length,
      `Invalid ordered canonical references: ${shot.image_id}`);
    requireTrue(ids.length <= 3 || shot.extra_reference_reason?.trim(), `Additional references need an authored composition reason: ${shot.image_id}`);
    requireTrue(equal(ids, shot.reference_bindings?.map((row) => row.asset_id))
      && equal(shot.reference_bindings, shot.shot_manifest?.reference_slots), `Reference order differs across shot fields: ${shot.image_id}`);
    for (const [slot, row] of shot.reference_bindings.entries()) {
      const asset = catalogMap.get(row.asset_id);
      requireTrue(asset && row.slot_order === slot + 1 && row.asset_class === asset.asset_class,
        `Unknown, mistyped, or unordered canonical binding: ${shot.image_id}`);
    }
    const forbidden = new Set(shot.shot_manifest?.forbidden_ref_ids ?? []);
    requireTrue(ids.every((id) => !forbidden.has(id)), `Forbidden state attached to shot ${shot.image_id}`);
    assertAuthoredMetadata(shot, catalogIds);
    checkPromptDelta(prior, shot, proposal.change_ledger);
  }
  return proposal;
}
async function approvedAssets(context, ids, pinned = null) {
  const bank = await loadBank(context.bankRoot); const result = new Map();
  for (const id of ids) {
    const pin = pinned?.get(id);
    const record = pin
      ? bank.assets.find((row) => row.asset_id === id && row.version === pin.version && row.sha256 === pin.sha256)
      : currentAsset(bank, id);
    requireTrue(record?.approval_state === 'approved', `Approved canonical reference unavailable: ${id}`);
    await verifyAsset(record, { requireLibrary: true });
    if (pin) requireTrue(equal(bindingCore(pin), bindingCore(record)), `Pinned OpenArt reference changed: ${id}`);
    result.set(id, record);
  }
  return { bank, records: result };
}
function bindReference(record, slot = {}) {
  return {
    ...bindingCore(record), ref_id: record.asset_id, path: record.local_absolute_path,
    reference_image_path: record.local_absolute_path, conditioning_image_path: record.local_absolute_path,
    asset_class: record.asset_class, canonical_name: record.canonical_name, kind: kindFor(record),
    conditioning_asset_role: roleFor(record), slot_order: slot.slot_order,
    reference_priority: slot.reference_priority, slot_purpose: slot.slot_purpose,
    reason: slot.source_reason, parent_asset_id: record.parent_asset_id, state_id: record.state_id,
    approval_lineage: { review: record.review, library_sync: record.library_sync,
      canonical_record_path: record.record_path, canonical_record_sha256: record.record_sha256 },
    source_provider: 'openart_cli', model_id: record.model,
    semantic_role: record.semantic_role,
    portable_file: record.portable_file,
    intended_function: slot.slot_purpose ?? roleFor(record),
    providers: record.providers,
  };
}
function promptRow(shot, source, records) {
  const editorial = Object.fromEntries(PRESERVED_FIELDS.filter((key) => Object.hasOwn(source, key)).map((key) => [key, structuredClone(source[key])]));
  const bindings = shot.reference_bindings.map((slot) => bindReference(records.get(slot.asset_id), slot));
  const requirements = bindings.map(({ ref_id, kind, conditioning_asset_role, slot_order, slot_purpose, reference_priority, reason }) =>
    ({ ref_id, kind, conditioning_asset_role, slot_order, slot_purpose, reference_priority, reason }));
  return {
    ...editorial, canonical_prompt: shot.prompt, provider_prompt: shot.prompt, image_prompt: shot.prompt, prompt_hash: sha256(shot.prompt),
    provider_requests: { openart: { prompt: shot.prompt, model_id: PRIMARY_MODEL, settings: { quality: 'low', resolution: '1k', aspect_ratio: '16:9' } } },
    image_provider_route: 'openart_cli', image_model_route: PRIMARY_MODEL,
    image_generation_required: true, image_strategy: 'fresh_openart_restart',
    reuse_source_image_id: null, editorial_reuse_approved: false,
    model_id: PRIMARY_MODEL, settings: { quality: 'low', resolution: '1k', aspect_ratio: '16:9' },
    reference_asset_ids: [...shot.reference_asset_ids], reference_bindings: bindings,
    reference_slots: bindings, reference_requirements: requirements,
    portable_reference_order: bindings.map((row) => ({ asset_id: row.asset_id, sha256: row.sha256, slot_order: row.slot_order, intended_function: row.intended_function, local_path: row.path })),
    required_reference_paths: bindings.map((row) => row.path),
    shot_manifest: { ...structuredClone(shot.shot_manifest), reference_slots: requirements },
    character_state_refs_used: shot.shot_manifest.character_state_ref_ids ?? [],
    extra_reference_reason: shot.extra_reference_reason ?? null,
    reference_credit_check_required: bindings.length > 3,
    canonical_source_only: true, historical_frame_or_reference_reused: false,
  };
}
function materializedReferences(context, records, sources) {
  const targets = [...records.values()].map((record) => {
    const item = context.catalog.assets.find((row) => row.asset_id === record.asset_id);
    return {
      ...bindReference(record), subject: record.canonical_name, canonical_subject_id: item.canonical_subject_id ?? record.asset_id,
      base_asset_id: record.parent_asset_id, prompt_anchor: record.prompt, scene_prompt_anchor: record.scene_prompt_anchor,
      generation_mode: 'standalone_ref', required_before_imagegen: true, reference_cleanliness_contract_version: 'empty_hands_no_detachable_props_v1',
      image_provider: 'openart_cli', openart_approval_state: record.approval_state,
      scene_ids: item.episode_scope_evidence?.scene_ids ?? [],
      reference_metadata_origin: 'verified_global_openart_bank',
    };
  });
  const states = targets.filter((row) => row.kind === 'character_state').map((row) => ({
    ...row, state_ref_id: row.ref_id, source_ref_id: row.ref_id, character: row.subject,
    base_identity_ref_id: row.parent_asset_id, identity_usage: 'full_identity', identity_subtype: 'human', definitive: true,
  }));
  const common = {
    status: 'approved', approval_authority: 'hash_bound_openart_bank_visual_reviews',
    channel: context.identity.channel, series_slug: context.identity.series_slug, week: context.identity.week,
    episode: context.identity.episode, source_script_hash: context.catalog.source_script_sha256,
    source_hashes: sources, historical_visual_approval_inherited: false,
    note: 'Materialized from individually inspected OpenArt bank versions and visibly verified native Studio registrations; this does not issue a new visual approval.',
  };
  return {
    plan: { schema: 'goldflow_visual_reference_plan_v1', ...common, reference_targets: targets, character_state_refs: states },
    states: { schema: 'goldflow_character_state_refs_v1', ...common, character_state_refs: states },
  };
}
export async function bindOpenArtShots(context, proposalPath) {
  const gate = await prerequisites(context);
  requireTrue(path.isAbsolute(proposalPath ?? ''), 'Authored shot proposal requires an absolute path.');
  const proposal = await readJson(proposalPath);
  const sourcePath = path.join(gate.baselineDir, 'section_image_prompts_hardened.json');
  requireTrue(proposal?.source_hardened_plan_path === sourcePath
    && proposal.source_hardened_plan_sha256 === await fileHash(sourcePath), 'Historical authored shot plan is not bound to this restart.');
  requireTrue(proposal.source_script_sha256 === gate.scriptHash && proposal.bank_catalog_sha256 === context.plan.catalog_sha256,
    'Shot migration is bound to a different script or canonical catalog.');
  const beatsPath = path.join(context.episodeDir, 'visual_beat_plan.json');
  const source = await readJson(sourcePath); const beats = await readJson(beatsPath);
  validateOpenArtShotMigration(proposal, source, beats, context.catalog, context.contract.max_reference_count);
  const allIds = context.catalog.assets.map((row) => row.asset_id);
  const { records, bank } = await approvedAssets(context, allIds);
  const outputPath = path.join(context.episodeDir, 'section_image_prompts.json');
  const recordPath = path.join(context.root, 'shot-binding.json');
  const referencePath = path.join(context.episodeDir, 'visual_reference_plan.json');
  const statePath = path.join(context.episodeDir, 'character_state_refs.json');
  const archivedProposalPath = path.join(context.root, 'authored-shot-migration.json');
  await requireUnused([outputPath, recordPath, referencePath, statePath, archivedProposalPath]);
  const sourceHashes = {
    [gate.identityPath]: await fileHash(gate.identityPath), [gate.scriptPath]: gate.scriptHash,
    [context.plan.catalog_path]: context.plan.catalog_sha256, [gate.approvalPath]: await fileHash(gate.approvalPath),
    [beatsPath]: await fileHash(beatsPath),
  };
  const refs = materializedReferences(context, records, sourceHashes);
  await writeOnce(referencePath, refs.plan);
  await writeOnce(statePath, { ...refs.states, source_visual_reference_plan_path: referencePath,
    source_hashes: { ...sourceHashes, [referencePath]: await fileHash(referencePath) } });
  const archive = await writeOnce(archivedProposalPath, proposal);
  const doc = {
    schema: 'goldflow_section_image_prompts_v1', status: 'passed', image_provider: 'openart_cli',
    channel: context.identity.channel, series_slug: context.identity.series_slug, week: context.identity.week,
    episode: context.identity.episode, content_profile: source.content_profile,
    source_script_hash: gate.scriptHash, run_identity_path: gate.identityPath,
    source_artifact_paths: [...Object.keys(sourceHashes), referencePath, statePath, archivedProposalPath],
    source_hashes: { ...sourceHashes, [referencePath]: await fileHash(referencePath), [statePath]: await fileHash(statePath), [archivedProposalPath]: archive.sha256 },
    style_summary: context.catalog.style_prompt, editorial_reuse_policy: 'Every production shot is regenerated from frame one.',
    prompts: proposal.shots.map((shot, i) => promptRow(shot, source.prompts[i], records)),
    reference_source: 'approved_global_openart_bank', historical_visuals_accepted: 0,
    visual_plan_scope: { mode: 'full_episode', selected_visual_beat_count: proposal.shots.length, total_visual_beat_count: proposal.shots.length },
  };
  const output = await writeOnce(outputPath, doc);
  const receipt = {
    schema: BINDING_SCHEMA, identity_sha256: sourceHashes[gate.identityPath], catalog_sha256: context.plan.catalog_sha256,
    source_script_sha256: gate.scriptHash, source_hardened_plan_path: sourcePath,
    source_hardened_plan_sha256: proposal.source_hardened_plan_sha256,
    authored_proposal: archive, authored_input_sha256: await fileHash(proposalPath),
    output_path: output.path, output_sha256: output.sha256,
    reference_plan: { path: referencePath, sha256: await fileHash(referencePath) },
    character_state_refs: { path: statePath, sha256: await fileHash(statePath) },
    bank_revision: bank.revision, reference_versions: [...records.values()].map(bindingCore),
    source_hashes: sourceHashes, shot_count: doc.prompts.length,
    ordered_image_ids_sha256: sha256(JSON.stringify(doc.prompts.map((row) => row.image_id))),
    historical_visuals_accepted: 0, created_at: new Date().toISOString(),
  };
  const saved = await writeOnce(recordPath, receipt);
  await appendEvent(context.root, { event: 'openart_shots_bound', receipt: saved, shot_count: receipt.shot_count });
  return receipt;
}
export async function hardenOpenArtShots(context) {
  await prerequisites(context);
  const bindingPath = path.join(context.root, 'shot-binding.json');
  const receipt = await readJson(bindingPath);
  requireTrue(receipt?.schema === BINDING_SCHEMA && receipt.catalog_sha256 === context.plan.catalog_sha256,
    'Current OpenArt shot-binding receipt is required.');
  const inputPath = path.join(context.episodeDir, 'section_image_prompts.json');
  requireTrue(receipt.output_path === inputPath && receipt.output_sha256 === await fileHash(inputPath), 'Bound OpenArt prompt plan changed.');
  requireTrue(receipt.identity_sha256 === await fileHash(path.join(context.episodeDir, 'run_identity.json')), 'Shot binding identity changed.');
  for (const [file, hash] of Object.entries(receipt.source_hashes ?? {})) requireTrue(await fileHash(file) === hash, `Shot binding source changed: ${file}`);
  for (const file of [receipt.authored_proposal, receipt.reference_plan, receipt.character_state_refs]) {
    requireTrue(file?.path && await fileHash(file.path) === file.sha256, 'Shot binding companion artifact changed.');
  }
  requireTrue(await fileHash(receipt.source_hardened_plan_path) === receipt.source_hardened_plan_sha256,
    'Historical authored shot plan changed.');
  const proposal = await readJson(receipt.authored_proposal.path);
  const source = await readJson(receipt.source_hardened_plan_path);
  const beats = await readJson(path.join(context.episodeDir, 'visual_beat_plan.json'));
  validateOpenArtShotMigration(proposal, source, beats, context.catalog, context.contract.max_reference_count);
  const pins = new Map(receipt.reference_versions.map((row) => [row.asset_id, row]));
  const { records } = await approvedAssets(context, [...pins.keys()], pins);
  const doc = await readJson(inputPath);
  const expected = proposal.shots.map((shot, i) => promptRow(shot, source.prompts[i], records));
  requireTrue(equal(doc.prompts, expected) && doc.prompts.length === receipt.shot_count
    && sha256(JSON.stringify(doc.prompts.map((row) => row.image_id))) === receipt.ordered_image_ids_sha256,
  'Bound prompt text, order, metadata or canonical reference lineage changed.');
  const outputPath = path.join(context.episodeDir, 'section_image_prompts_hardened.json');
  const hardenedPath = path.join(context.root, 'hardened-receipt.json');
  await requireUnused([outputPath, hardenedPath]);
  // Hardening validates and pins transport metadata; it never rewrites creative text.
  const output = await writeOnce(outputPath, { ...doc, source_artifact_paths: [...doc.source_artifact_paths, inputPath, bindingPath],
    source_hashes: { ...doc.source_hashes, [inputPath]: receipt.output_sha256, [bindingPath]: await fileHash(bindingPath) },
    openart_hardening: { mode: 'structural_validation_only', provider_prompt_mutations: 0, reference_order_mutations: 0 } });
  const hardened = {
    schema: HARDENED_SCHEMA, identity_sha256: receipt.identity_sha256, catalog_sha256: receipt.catalog_sha256,
    input_path: inputPath, input_sha256: receipt.output_sha256, output_path: output.path, output_sha256: output.sha256,
    binding_receipt_sha256: await fileHash(bindingPath), shot_count: receipt.shot_count,
    ordered_image_ids_sha256: receipt.ordered_image_ids_sha256, source_script_sha256: receipt.source_script_sha256,
    provider_prompt_mutations: 0, reference_order_mutations: 0, historical_visuals_accepted: 0,
    visual_approval_issued: false, live_extra_reference_quote_required_at_dispatch: true, created_at: new Date().toISOString(),
  };
  const saved = await writeOnce(hardenedPath, hardened);
  await appendEvent(context.root, { event: 'openart_shots_hardened', receipt: saved, shot_count: hardened.shot_count });
  return hardened;
}
