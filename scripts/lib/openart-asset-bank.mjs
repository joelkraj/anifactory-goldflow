import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const BANK_SCHEMA = 'goldflow_openart_asset_bank_v1';
export const CATALOG_SCHEMA = 'goldflow_openart_bank_catalog_v1';
export const PRIMARY_MODEL = 'gpt-image-2-5-sunburst';
export const PROVIDER_RECEIPT_SCHEMA = 'goldflow_openart_provider_receipt_v1';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
export async function fileHash(file) { return sha256(await fs.readFile(file)); }
export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function writeOnce(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, jsonBytes(value), { flag: 'wx' });
  return { path: file, sha256: await fileHash(file) };
}
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, jsonBytes(value), { flag: 'wx' });
  await fs.rename(temporary, file);
}
export function safeId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_.-]{1,149}$/.test(id)) throw new Error(`Invalid stable asset ID: ${id}`);
  return id;
}
export function validateCatalog(catalog) {
  if (catalog?.schema !== CATALOG_SCHEMA || !Array.isArray(catalog.assets) || !catalog.assets.length) throw new Error('Missing authored OpenArt bank catalog.');
  if (!/^[a-f0-9]{64}$/.test(catalog.source_script_sha256 ?? '')) throw new Error('Catalog requires the approved source hash.');
  if (!catalog.story_universe || !catalog.series_scope || !catalog.style_prompt) throw new Error('Catalog requires universe, series scope and authored style.');
  const ids = new Set(); const aliases = new Map();
  for (const item of catalog.assets) {
    safeId(item.asset_id);
    if (ids.has(item.asset_id)) throw new Error(`Duplicate asset ID ${item.asset_id}`);
    ids.add(item.asset_id);
    if (!['character', 'wardrobe', 'location', 'object', 'style'].includes(item.asset_class)) throw new Error(`Invalid asset class ${item.asset_id}`);
    if (!item.canonical_name || !item.prompt || !['joey', 'core', 'remaining'].includes(item.phase)) throw new Error(`Incomplete asset contract ${item.asset_id}`);
    for (const alias of item.legacy_ref_ids ?? []) {
      if (aliases.has(alias)) throw new Error(`Ambiguous legacy reference ${alias}`);
      aliases.set(alias, item.asset_id);
    }
  }
  const visited = new Set(); const visiting = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Reference dependency cycle ${id}`);
    const item = catalog.assets.find((row) => row.asset_id === id);
    if (!item) throw new Error(`Unknown canonical dependency ${id}`);
    visiting.add(id);
    for (const ref of item.reference_asset_ids ?? []) visit(ref);
    if (item.parent_asset_id && !ids.has(item.parent_asset_id)) throw new Error(`Unknown asset parent ${id}`);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  for (const item of catalog.assets) {
    if (item.asset_class === 'wardrobe' && (!item.state_id || catalog.assets.find((row) => row.asset_id === item.parent_asset_id)?.asset_class !== 'character')) throw new Error(`Wardrobe must be a named state of a canonical character: ${item.asset_id}`);
  }
  if (catalog.assets.filter((row) => row.phase === 'joey').length !== 1) throw new Error('Exactly one universal protagonist must be generated and reviewed first.');
  if (!Array.isArray(catalog.validation_shots) || catalog.validation_shots.length !== 8) throw new Error('Eight authored representative validation shots are required.');
  const shotIds = new Set();
  for (const shot of catalog.validation_shots) {
    safeId(shot.image_id);
    if (shotIds.has(shot.image_id)) throw new Error('Duplicate validation shot ID.');
    shotIds.add(shot.image_id);
    if (!shot.prompt || !shot.reference_asset_ids?.length) throw new Error('Validation shot must have authored prompt and references.');
    for (const ref of shot.reference_asset_ids) if (!ids.has(ref)) throw new Error(`Unknown validation reference ${ref}`);
    if (shot.reference_asset_ids.length > 3 && !shot.extra_reference_reason) throw new Error(`Additional references need composition rationale: ${shot.image_id}`);
  }
  return catalog;
}

export async function withBankLock(root, fn) {
  if (!path.isAbsolute(root)) throw new Error('Reference bank requires an absolute path.');
  await fs.mkdir(root, { recursive: true });
  const lock = path.join(root, '.write-lock');
  let handle;
  try { handle = await fs.open(lock, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Bank is locked by another writer; inspect its owner before recovery.'); throw error; }
  await handle.writeFile(jsonBytes({ pid: process.pid, created_at: new Date().toISOString() }));
  try { return await fn(); }
  finally { await handle.close(); await fs.unlink(lock); }
}
export async function loadBank(root) {
  const bank = await readJson(path.join(root, 'manifest.json'));
  if (bank && bank.schema !== BANK_SCHEMA) throw new Error('Unsupported reference-bank schema.');
  return bank ?? { schema: BANK_SCHEMA, revision: 0, assets: [], catalogs: [], library_projects: [], events_path: path.join(root, 'events.jsonl') };
}
export async function commitBank(root, bank, event) {
  bank.revision += 1;
  bank.updated_at = new Date().toISOString();
  const snapshot = path.join(root, 'history', `manifest-${String(bank.revision).padStart(7, '0')}.json`);
  await writeOnce(snapshot, bank);
  await fs.appendFile(path.join(root, 'events.jsonl'), `${JSON.stringify({ ...event, revision: bank.revision, snapshot_path: snapshot, snapshot_sha256: await fileHash(snapshot), at: bank.updated_at })}\n`);
  await atomicJson(path.join(root, 'manifest.json'), bank);
}
export async function registerCatalog(root, catalog, catalogPath) {
  validateCatalog(catalog);
  if (!path.isAbsolute(catalogPath) || JSON.stringify(await readJson(catalogPath)) !== JSON.stringify(catalog)) throw new Error('Catalog registration must bind the exact authored catalog file.');
  return withBankLock(root, async () => {
    const bank = await loadBank(root); const hash = await fileHash(catalogPath);
    if (!bank.catalogs.some((row) => row.sha256 === hash)) {
      bank.catalogs.push({ path: catalogPath, sha256: hash, story_universe: catalog.story_universe, series_scope: catalog.series_scope });
      await commitBank(root, bank, { event: 'catalog_registered', sha256: hash });
    }
    return bank;
  });
}
export function currentAsset(bank, id, { approved = true } = {}) {
  const records = bank.assets.filter((row) => row.asset_id === id && (!approved || row.approval_state === 'approved'));
  return records.sort((a, b) => b.version - a.version)[0] ?? null;
}
export function requiredVisualChecks(assetClass) {
  const common = ['single_concept', 'style', 'no_unwanted_text'];
  if (['character', 'wardrobe'].includes(assetClass)) return [...common, 'identity', 'hands'];
  return [...common, 'geometry', ...(assetClass === 'object' ? ['prop_fidelity'] : [])];
}
function validateVisualDecision(record, decision) {
  if (!['approved', 'rejected'].includes(decision.decision) || !decision.note?.trim() || !decision.checks || Array.isArray(decision.checks)) throw new Error(`Missing production visual review: ${record.asset_id}`);
  const required = requiredVisualChecks(record.asset_class);
  if (required.some((key) => typeof decision.checks[key] !== 'boolean') || Object.values(decision.checks).some((value) => typeof value !== 'boolean')) throw new Error(`Missing class-specific visual checks: ${record.asset_id}`);
  if (decision.decision === 'approved' && Object.values(decision.checks).some((value) => !value)) throw new Error('Approval cannot contain a failed critical check.');
}
function referenceIdentity(rows) {
  return rows.map((row) => ({ asset_id: row.asset_id, sha256: row.sha256, openart_asset_id: row.openart_asset_id }));
}
async function verifyReceipt(record) {
  if (!record.provider_receipt_path || !path.isAbsolute(record.provider_receipt_path) || await fileHash(record.provider_receipt_path) !== record.provider_receipt_sha256) throw new Error(`Canonical provider receipt changed: ${record.asset_id}`);
  const receipt = await readJson(record.provider_receipt_path);
  if (receipt?.schema !== PROVIDER_RECEIPT_SCHEMA || !receipt.assignment_id || receipt.assignment_id !== record.assignment_id) throw new Error('Canonical provider receipt must bind the exact assignment.');
  for (const [key, expected] of Object.entries({ model: record.model, mode: record.mode, creation_id: record.openart_creation_id, openart_asset_id: record.openart_asset_id, output_sha256: record.sha256, transport: record.creation_source, prompt_sha256: sha256(record.prompt), created_at: record.creation_timestamp })) {
    if (receipt[key] !== expected) throw new Error(`Canonical provider receipt mismatch: ${key}`);
  }
  if (receipt.params?.quality !== record.quality || receipt.params?.resolution !== record.resolution || receipt.params?.aspect_ratio !== record.aspect_ratio) throw new Error('Canonical provider receipt settings mismatch.');
  if (!Array.isArray(receipt.references) || JSON.stringify(referenceIdentity(receipt.references)) !== JSON.stringify(referenceIdentity(record.reference_bindings))) throw new Error('Canonical provider receipt ordered references mismatch.');
  if (receipt.credits_quoted !== record.credits_quoted || (receipt.credits_charged ?? null) !== record.credits_charged) throw new Error('Canonical provider receipt credit evidence mismatch.');
  return receipt;
}
export async function verifyAsset(record, { requireLibrary = false } = {}) {
  if (record?.schema !== 'goldflow_openart_asset_record_v1') throw new Error('Unsupported canonical asset record.');
  safeId(record.asset_id);
  if (!['character', 'wardrobe', 'location', 'object', 'style'].includes(record.asset_class)) throw new Error('Canonical asset class missing.');
  if (!Number.isSafeInteger(record.version) || record.version < 1 || !['needs_visual_review', 'approved', 'rejected'].includes(record.approval_state)) throw new Error('Canonical version/review state invalid.');
  if (!record.canonical_name?.trim() || !record.story_universe || !record.series_scope || !Array.isArray(record.aliases) || !Array.isArray(record.tags)) throw new Error('Canonical naming and scope metadata missing.');
  if (record.asset_class === 'wardrobe' && (!record.parent_asset_id || !record.state_id)) throw new Error('Wardrobe states must name their existing character identity and state.');
  if (!record?.local_absolute_path || !path.isAbsolute(record.local_absolute_path)) throw new Error('Missing local canonical asset.');
  if (await fileHash(record.local_absolute_path) !== record.sha256) throw new Error(`Canonical raster changed: ${record.asset_id}`);
  if (!record.openart_asset_id || !record.openart_creation_id || !record.openart_project_id || record.model !== PRIMARY_MODEL || !['openart_cli', 'openart_cli_v1', 'openart_studio_browser'].includes(record.creation_source)) throw new Error(`Canonical asset has invalid OpenArt origin: ${record.asset_id}`);
  if (record.quality !== 'low' || record.resolution !== '1k' || record.aspect_ratio !== '16:9') throw new Error('Canonical production references require low quality, 1k, and 16:9.');
  if (!record.prompt?.trim() || !['text2image', 'image2image'].includes(record.mode) || typeof record.creation_timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(record.creation_timestamp) || !Number.isFinite(Date.parse(record.creation_timestamp))) throw new Error('Canonical generation metadata missing.');
  if (!Number.isInteger(record.width) || !Number.isInteger(record.height) || record.width <= record.height || Math.abs(record.width / record.height - 16 / 9) > 0.025) throw new Error('Canonical raster geometry must be 16:9 landscape.');
  const raster = await sharp(record.local_absolute_path).metadata();
  if (raster.width !== record.width || raster.height !== record.height) throw new Error('Canonical raster dimensions disagree with generation metadata.');
  if (!Number.isFinite(record.credit_cost) || record.credit_cost < 0 || !Number.isFinite(record.credits_quoted) || record.credits_quoted < 0 || (record.credits_charged !== null && (!Number.isFinite(record.credits_charged) || record.credits_charged < 0))) throw new Error('Canonical credit quote/charge evidence missing.');
  if (!Array.isArray(record.reference_bindings) || !Array.isArray(record.reference_ids) || record.reference_bindings.some((row) => !row.asset_id || !/^[a-f0-9]{64}$/.test(row.sha256 ?? '') || !row.openart_asset_id)) throw new Error('Canonical exact reference bindings missing.');
  if (JSON.stringify(record.reference_ids) !== JSON.stringify(record.reference_bindings.map((row) => row.asset_id)) || new Set(record.reference_ids).size !== record.reference_ids.length) throw new Error('Canonical ordered reference IDs mismatch.');
  if ((record.mode === 'image2image') !== (record.reference_ids.length > 0)) throw new Error('Canonical generation mode does not match its references.');
  await verifyReceipt(record);
  if (record.record_path) {
    if (!record.record_sha256 || await fileHash(record.record_path) !== record.record_sha256) throw new Error('Immutable canonical record changed.');
    const original = await readJson(record.record_path);
    const mutable = new Set(['approval_state', 'review', 'library_sync', 'openart_library_asset_id', 'openart_registration_surface', 'record_sha256']);
    for (const key of Object.keys(original).filter((key) => !mutable.has(key))) {
      if (JSON.stringify(record[key]) !== JSON.stringify(original[key])) throw new Error(`Immutable canonical metadata changed: ${key}`);
    }
  }
  if (record.approval_state === 'approved') {
    if (!record.review?.path || await fileHash(record.review.path) !== record.review.sha256) throw new Error('Canonical visual approval receipt missing or stale.');
    const review = await readJson(record.review.path);
    const decision = review?.decisions?.find((row) => row.asset_id === record.asset_id && row.version === record.version && row.sha256 === record.sha256 && row.decision === 'approved');
    if (review.attestation !== 'each_listed_raster_visually_inspected' || !review.reviewer || !decision) throw new Error('Canonical visual approval is not bound to this raster.');
    validateVisualDecision(record, decision);
  }
  if (requireLibrary || record.openart_library_asset_id) {
    if (!record.openart_library_asset_id || !record.library_sync?.path || await fileHash(record.library_sync.path) !== record.library_sync.sha256) throw new Error('Canonical reference lacks verified native OpenArt library mirroring.');
    const sync = await readJson(record.library_sync.path);
    const mediaRegistration = sync.registration_surface === 'media'
      && sync.attestation === 'openart_media_asset_identity_verified'
      && sync.openart_library_asset_id === sync.openart_media_asset_id;
    const nativeRegistration = (sync.registration_surface == null || sync.registration_surface === 'native_library')
      && sync.attestation === 'native_openart_library_asset_visibly_verified';
    if ((!mediaRegistration && !nativeRegistration) || !sync.reviewer || !sync.evidence || sync.asset_id !== record.asset_id || sync.version !== record.version || sync.sha256 !== record.sha256 || sync.openart_media_asset_id !== record.openart_asset_id || sync.openart_library_asset_id !== record.openart_library_asset_id || sync.openart_library_kind !== record.openart_library_kind || (record.openart_registration_surface ?? (nativeRegistration ? 'native_library' : null)) !== (sync.registration_surface ?? 'native_library')) throw new Error('OpenArt library/media receipt does not match the canonical version.');
  }
  return record;
}
export async function resolveReferences(root, ids, { maxReferences = 8, extraReferenceReason = null, requireLibrary = true } = {}) {
  if (ids.length > maxReferences) throw new Error('Reference count exceeds the identity-locked limit.');
  if (ids.length > 3 && !extraReferenceReason?.trim()) throw new Error('More than three references needs an authored composition reason; dispatch separately verifies its live quote.');
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate reference attachment.');
  const bank = await loadBank(root);
  return Promise.all(ids.map(async (id) => {
    const asset = currentAsset(bank, id);
    if (!asset) throw new Error(`Approved canonical reference unavailable: ${id}`);
    await verifyAsset(asset, { requireLibrary });
    return { asset_id: id, version: asset.version, path: asset.local_absolute_path, sha256: asset.sha256, openart_asset_id: asset.openart_asset_id, asset_class: asset.asset_class, canonical_name: asset.canonical_name,
      openart_library_asset_id: asset.openart_library_asset_id, openart_library_kind: asset.openart_library_kind,
      openart_registration_surface: asset.openart_registration_surface ?? 'native_library', library_sync: asset.library_sync ?? null,
      parent_asset_id: asset.parent_asset_id, state_id: asset.state_id };
  }));
}
export async function addCanonicalResult(root, { item, catalog, result, references, prompt, params, projectId }) {
  return withBankLock(root, async () => {
    safeId(item.asset_id);
    const bank = await loadBank(root);
    const previous = currentAsset(bank, item.asset_id, { approved: false });
    const version = (previous?.version ?? 0) + 1;
    if (result.model !== PRIMARY_MODEL) throw new Error('Canonical references must be newly generated using GPT Image 2.5 Sunburst.');
    if (!path.isAbsolute(result.output_path)) throw new Error('Canonical import requires an absolute output path.');
    if (await fileHash(result.output_path) !== result.sha256) throw new Error('Generated canonical result hash changed.');
    if (bank.assets.some((row) => row.asset_id !== item.asset_id && row.sha256 === result.sha256)) throw new Error('Different canonical concepts cannot share identical image bytes.');
    const local = path.join(root, 'assets', item.asset_id, `v${String(version).padStart(4, '0')}${path.extname(result.output_path)}`);
    for (const binding of references) {
      const reference = bank.assets.find((row) => row.asset_id === binding.asset_id && row.version === binding.version && row.sha256 === binding.sha256 && row.openart_asset_id === binding.openart_asset_id && row.approval_state === 'approved');
      if (!reference) throw new Error(`Canonical generation used an unapproved or unknown reference: ${binding.asset_id}`);
      await verifyAsset(reference, { requireLibrary: true });
    }
    if (item.asset_class === 'wardrobe' && !bank.assets.some((row) => row.asset_id === item.parent_asset_id && row.asset_class === 'character' && row.approval_state === 'approved')) throw new Error('Canonical wardrobe must belong to an approved character identity.');
    const record = {
      schema: 'goldflow_openart_asset_record_v1', asset_id: item.asset_id, openart_asset_id: result.openart_asset_id,
      assignment_id: result.assignment_id,
      openart_creation_id: result.creation_id, openart_project_id: projectId, asset_class: item.asset_class,
      canonical_name: item.canonical_name, aliases: item.aliases ?? [], legacy_ref_ids: item.legacy_ref_ids ?? [],
      story_universe: item.story_universe ?? catalog.story_universe, series_scope: item.series_scope ?? catalog.series_scope,
      version, approval_state: 'needs_visual_review', local_absolute_path: local, sha256: result.sha256,
      model: result.model, mode: result.mode, resolution: params.resolution, quality: params.quality,
      aspect_ratio: params.aspect_ratio, width: result.width, height: result.height, prompt,
      reference_ids: references.map((row) => row.asset_id), reference_bindings: references,
      creation_timestamp: result.created_at, credit_cost: result.credits_charged ?? result.credits_quoted,
      credits_quoted: result.credits_quoted, credits_charged: result.credits_charged ?? null,
      credit_cost_kind: result.credits_charged == null ? 'live_quote_pending_account_reconciliation' : 'provider_charged',
      tags: item.tags ?? [], parent_asset_id: item.parent_asset_id ?? null, state_id: item.state_id ?? null,
      supersedes_version: previous?.version ?? null, supersedes_sha256: previous?.sha256 ?? null,
      replacement_history: previous ? [...(previous.replacement_history ?? []), { version: previous.version, sha256: previous.sha256 }] : [],
      provider_receipt_path: result.provider_receipt_path, provider_receipt_sha256: result.provider_receipt_sha256,
      creation_source: result.transport ?? 'openart_cli', scene_prompt_anchor: item.scene_prompt_anchor ?? '',
      openart_library_kind: item.openart_library_kind ?? ({ character: 'character', wardrobe: 'character', location: 'background', object: 'object', style: 'style' })[item.asset_class],
      openart_library_asset_id: null,
    };
    // Validate the downloaded candidate before claiming an immutable version path.
    await verifyAsset({ ...record, local_absolute_path: result.output_path });
    await fs.mkdir(path.dirname(local), { recursive: true });
    await fs.copyFile(result.output_path, local, 1);
    record.record_path = path.join(root, 'records', item.asset_id, `v${String(version).padStart(4, '0')}.json`);
    const immutableRecord = await writeOnce(record.record_path, record);
    record.record_sha256 = immutableRecord.sha256;
    bank.assets.push(record);
    await commitBank(root, bank, { event: 'canonical_version_created', asset_id: item.asset_id, version, sha256: result.sha256 });
    return record;
  });
}

export async function synchronizeLibraryRecord(root, sync) {
  const mediaRegistration = sync?.registration_surface === 'media'
    && sync.attestation === 'openart_media_asset_identity_verified'
    && sync.openart_library_asset_id === sync.openart_media_asset_id;
  const nativeRegistration = (sync?.registration_surface == null || sync.registration_surface === 'native_library')
    && sync?.attestation === 'native_openart_library_asset_visibly_verified';
  if ((!mediaRegistration && !nativeRegistration) || !sync.openart_library_asset_id || !sync.evidence || !sync.reviewer) throw new Error('OpenArt native-library or persistent-media registration must be exactly verified.');
  return withBankLock(root, async () => {
    const bank = await loadBank(root);
    const asset = bank.assets.find((row) => row.asset_id === sync.asset_id && row.version === sync.version);
    if (!asset || asset.sha256 !== sync.sha256 || asset.openart_asset_id !== sync.openart_media_asset_id) throw new Error('Library sync is not bound to the canonical source image.');
    if (asset.approval_state !== 'approved') throw new Error('Canonical raster must pass visual review before native library registration.');
    await verifyAsset(asset);
    if (asset.openart_library_kind !== sync.openart_library_kind) throw new Error('Native library class mismatch.');
    const priorLibraryId = asset.openart_library_asset_id;
    const correctingLibraryId = priorLibraryId && priorLibraryId !== sync.openart_library_asset_id;
    if (correctingLibraryId && (sync.supersedes_openart_library_asset_id !== priorLibraryId || !sync.correction_reason?.trim())) {
      throw new Error('Use a new canonical version for replacement library IDs, or provide an explicit hash-bound native ID correction.');
    }
    const receipt = await writeOnce(path.join(root, 'library-sync', `${Date.now()}-${randomUUID()}.json`), sync);
    if (correctingLibraryId) {
      asset.library_sync_history = [...(asset.library_sync_history ?? []), {
        openart_library_asset_id: priorLibraryId,
        library_sync: asset.library_sync,
        superseded_by: sync.openart_library_asset_id,
        correction_reason: sync.correction_reason,
      }];
    }
    asset.openart_library_asset_id = sync.openart_library_asset_id;
    asset.openart_registration_surface = sync.registration_surface ?? 'native_library';
    asset.library_sync = receipt;
    await commitBank(root, bank, { event: correctingLibraryId ? 'native_library_id_corrected' : 'native_library_synced', asset_id: sync.asset_id, version: sync.version, prior_openart_library_asset_id: priorLibraryId ?? null, ...receipt });
    return receipt;
  });
}
export async function reviewCanonicalAssets(root, review) {
  if (review?.attestation !== 'each_listed_raster_visually_inspected' || !review.reviewer || !review.decisions?.length) throw new Error('Actual per-raster visual review attestation required.');
  const decisionIds = review.decisions.map((row) => `${row.asset_id}@${row.version}`);
  if (new Set(decisionIds).size !== decisionIds.length) throw new Error('Visual review cannot repeat a canonical version.');
  return withBankLock(root, async () => {
    const bank = await loadBank(root);
    for (const decision of review.decisions) {
      const row = bank.assets.find((asset) => asset.asset_id === decision.asset_id && asset.version === decision.version);
      if (!row || row.sha256 !== decision.sha256) throw new Error(`Review bound to wrong raster: ${decision.asset_id}`);
      await verifyAsset(row);
      validateVisualDecision(row, decision);
    }
    const receipt = await writeOnce(path.join(root, 'reviews', `${Date.now()}-${randomUUID()}.json`), review);
    for (const decision of review.decisions) {
      const row = bank.assets.find((asset) => asset.asset_id === decision.asset_id && asset.version === decision.version);
      row.approval_state = decision.decision; row.review = receipt;
    }
    await commitBank(root, bank, { event: 'visual_review_recorded', ...receipt });
    return receipt;
  });
}
