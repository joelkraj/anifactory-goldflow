import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import {
  readJson, writeOnce, fileHash, sha256, addCanonicalResult, reviewCanonicalAssets,
  synchronizeLibraryRecord, loadBank, requiredVisualChecks, PRIMARY_MODEL, PROVIDER_RECEIPT_SCHEMA,
} from '../lib/openart-asset-bank.mjs';
import { bindOpenArtShots, hardenOpenArtShots, validateOpenArtShotMigration } from '../lib/openart-shot-binding.mjs';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'goldflow-openart-binding-test-'));
const baseline = path.join(temporary, 'historical');
const episodeDir = path.join(temporary, 'restart');
const root = path.join(episodeDir, 'openart');
const bankRoot = path.join(temporary, 'bank');
const assetId = 'test.character.protagonist';
const params = { quality: 'low', resolution: '1k', aspect_ratio: '16:9' };
async function write(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }
try {
  await write(path.join(baseline, 'run_identity.json'), { schema: 'test_historical_identity', unchanged: true });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(episodeDir, 'script_clean.md'), 'The adult protagonist listens. Then he answers.');
  const scriptHash = await fileHash(path.join(episodeDir, 'script_clean.md'));
  const catalog = {
    story_universe: 'test', series_scope: ['test-series'], style_prompt: 'Illustrated adult story.', source_script_sha256: scriptHash,
    assets: [{ asset_id: assetId, asset_class: 'character', canonical_name: 'Test protagonist', phase: 'joey',
      scene_prompt_anchor: 'The same adult protagonist.', reference_asset_ids: [], canonical_subject_id: 'protagonist' }],
  };
  const catalogPath = path.join(root, 'catalog.json'); await write(catalogPath, catalog);
  const plan = { catalog_path: catalogPath, catalog_sha256: await fileHash(catalogPath), source_script_sha256: scriptHash };
  await write(path.join(root, 'bank-plan.json'), plan);
  const identity = {
    image_provider: 'openart_cli', channel: 'test', series_slug: 'test', week: 'restart', episode: 'ep_01',
    visual_restart: { baseline_episode_dir: baseline, baseline_identity_sha256: await fileHash(path.join(baseline, 'run_identity.json')) },
  };
  await write(path.join(episodeDir, 'run_identity.json'), identity);
  const context = { episodeDir, root, bankRoot, catalog, plan, identity,
    contract: { primary: { model_id: PRIMARY_MODEL, ...params }, max_reference_count: 8 } };
  const source = { content_profile: { id: 'manhwa_recap_v1' }, prompts: [
    { image_id: 'ep_01-w000000-w000004', scene_id: 'scene_001', visual_beat_id: 'beat_001',
      start_sec: 0, duration_sec: 2, visual_beat_script_excerpt: 'The adult protagonist listens.',
      visual_beat_action: 'The protagonist listens.', provider_prompt: 'One adult protagonist listens.',
      audiovisual_intent: { score_behavior: 'hold', subtitle_emphasis: ['listens'] },
      narrative_overlays: [{ kind: 'reaction', text: 'WAIT' }], ui_text_on_screen: [] },
    { image_id: 'ep_01-w000005-w000008', scene_id: 'scene_001', visual_beat_id: 'beat_002',
      start_sec: 2, duration_sec: 2.5, visual_beat_script_excerpt: 'Then he answers.',
      visual_beat_action: 'The protagonist answers.', provider_prompt: 'The same adult answers.',
      audiovisual_intent: { score_behavior: 'lift' }, narrative_overlays: [], ui_text_on_screen: [] },
  ] };
  const sourcePath = path.join(baseline, 'section_image_prompts_hardened.json'); await write(sourcePath, source);
  const beats = { beats: source.prompts.map((row) => ({ ...row, image_id_hint: row.image_id })) };
  await write(path.join(episodeDir, 'visual_beat_plan.json'), beats);
  const slot = { asset_id: assetId, asset_class: 'character', slot_order: 1, reference_priority: 'decisive_subject', slot_purpose: 'Stable identity.', source_reason: 'Visible adult protagonist.' };
  const proposal = {
    schema: 'goldflow_openart_shot_migration_proposal_v1', source_hardened_plan_path: sourcePath,
    source_hardened_plan_sha256: await fileHash(sourcePath), source_script_sha256: scriptHash,
    bank_catalog_sha256: plan.catalog_sha256, shot_count: 2, source_ids_order_timing_and_script_excerpts_preserved: true,
    historical_images_or_approvals_imported: false, change_ledger: [],
    shots: source.prompts.map(({ provider_prompt, audiovisual_intent, ...row }) => ({
      ...row, prompt: provider_prompt, source_authored_prompt_sha256: sha256(provider_prompt),
      shot_manifest: { primary_character: 'Test protagonist', character_state_ref_ids: [assetId],
        protagonist_state_ref_id: assetId, forbidden_ref_ids: [], reference_slots: [{ ...slot }] },
      reference_asset_ids: [assetId], reference_bindings: [{ ...slot }],
      image_generation_required: true, image_strategy: 'fresh_openart_restart', status: 'proposed_not_generated',
      model_id: PRIMARY_MODEL, settings: { ...params, resolution: '1K' },
      source_timing_unchanged: true, historical_frame_or_reference_reused: false,
    })),
  };
  const proposalPath = path.join(temporary, 'authored.json'); await write(proposalPath, proposal);
  validateOpenArtShotMigration(proposal, source, beats, catalog);
  function invalid(mutator, pattern) {
    const altered = structuredClone(proposal); mutator(altered);
    assert.throws(() => validateOpenArtShotMigration(altered, source, beats, catalog), pattern);
  }
  invalid((p) => { p.shots.pop(); }, /complete approved episode/);
  invalid((p) => { p.shots.reverse(); }, /changed/);
  invalid((p) => { p.shots[0].duration_sec = 9; }, /duration_sec changed/);
  invalid((p) => { p.shots[0].visual_beat_script_excerpt = 'Rewritten narration.'; }, /script_excerpt changed/);
  invalid((p) => { p.shots[0].prompt = 'An unrecorded creative change.'; }, /Unrecorded authored/);
  invalid((p) => { p.shots[0].shot_manifest.forbidden_ref_ids = [assetId]; }, /Forbidden state attached/);
  invalid((p) => { p.shots[0].shot_manifest.identity_ref_id = 'old_provider_ref'; }, /Unresolved canonical/);
  invalid((p) => { p.shots[0].shot_manifest.reference_image_path = '/old/assets/images/accepted.png'; }, /Historical provider/);
  invalid((p) => { p.shots[0].image_strategy = 'reuse_previous_frame'; }, /fresh OpenArt/);
  invalid((p) => { p.shots[0].settings.quality = 'medium'; }, /locked model/);
  invalid((p) => { p.shots[0].reference_bindings[0].slot_order = 2; p.shots[0].shot_manifest.reference_slots[0].slot_order = 2; }, /unordered/);
  const authoredChange = structuredClone(proposal);
  authoredChange.shots[0].prompt = 'One adult protagonist listens, in a tight portrait.';
  authoredChange.change_ledger.push({ image_id: source.prompts[0].image_id, field: 'prompt', before: source.prompts[0].provider_prompt,
    after: authoredChange.shots[0].prompt, reason: 'Reviewed exact composition change.' });
  validateOpenArtShotMigration(authoredChange, source, beats, catalog);

  await assert.rejects(bindOpenArtShots(context, proposalPath), /canonical bank approval/);
  await write(path.join(root, 'refs-approval.json'), { approved: true, source_sha256: await fileHash(path.join(root, 'bank-plan.json')) });
  await assert.rejects(bindOpenArtShots(context, proposalPath), /Approved canonical reference/);
  const image = path.join(temporary, 'synthetic-canonical.png');
  await sharp({ create: { width: 1024, height: 576, channels: 3, background: { r: 80, g: 120, b: 150 } } }).png().toFile(image);
  const prompt = 'Synthetic test canonical only; not production.';
  const result = {
    assignment_id: 'fixture-assignment', model: PRIMARY_MODEL, mode: 'text2image', output_path: image,
    sha256: await fileHash(image), width: 1024, height: 576, creation_id: 'test-creation', openart_asset_id: 'test-media',
    created_at: '2026-09-22T12:00:00.000Z', transport: 'openart_studio_browser', credits_quoted: 5,
  };
  const providerReceipt = { schema: PROVIDER_RECEIPT_SCHEMA, assignment_id: result.assignment_id,
    model: result.model, mode: result.mode, creation_id: result.creation_id, openart_asset_id: result.openart_asset_id,
    output_sha256: result.sha256, transport: result.transport, prompt_sha256: sha256(prompt), params, references: [],
    credits_quoted: 5, created_at: result.created_at };
  result.provider_receipt_path = path.join(temporary, 'provider-receipt.json'); await write(result.provider_receipt_path, providerReceipt);
  result.provider_receipt_sha256 = await fileHash(result.provider_receipt_path);
  const record = await addCanonicalResult(bankRoot, { item: catalog.assets[0], catalog, result, references: [], prompt, params, projectId: 'fixture-project' });
  await assert.rejects(bindOpenArtShots(context, proposalPath), /Approved canonical reference/);
  await reviewCanonicalAssets(bankRoot, { attestation: 'each_listed_raster_visually_inspected', reviewer: 'fixture-only',
    decisions: [{ asset_id: assetId, version: 1, sha256: record.sha256, decision: 'approved', note: 'Synthetic test review, not real approval.',
      checks: Object.fromEntries(requiredVisualChecks('character').map((key) => [key, true])) }] });
  await assert.rejects(bindOpenArtShots(context, proposalPath), /native OpenArt library/);
  await synchronizeLibraryRecord(bankRoot, { attestation: 'native_openart_library_asset_visibly_verified', reviewer: 'fixture-only',
    evidence: 'Synthetic native ID for tests.', asset_id: assetId, version: 1, sha256: record.sha256,
    openart_media_asset_id: record.openart_asset_id, openart_library_asset_id: 'fixture-native-character', openart_library_kind: 'character' });
  const baselineHash = await fileHash(sourcePath);
  const receipt = await bindOpenArtShots(context, proposalPath);
  assert.equal(receipt.shot_count, 2);
  assert.equal(await fileHash(sourcePath), baselineHash);
  const promptsPath = path.join(episodeDir, 'section_image_prompts.json');
  const bound = await readJson(promptsPath);
  assert.deepEqual(bound.prompts.map((row) => row.image_id), source.prompts.map((row) => row.image_id));
  assert.deepEqual(bound.prompts.map((row) => row.audiovisual_intent), source.prompts.map((row) => row.audiovisual_intent));
  assert.deepEqual(bound.prompts[0].narrative_overlays, source.prompts[0].narrative_overlays);
  assert.equal(bound.prompts[0].reference_bindings[0].openart_library_asset_id, 'fixture-native-character');
  assert.equal(bound.prompts[0].reference_slots[0].sha256, record.sha256);
  assert.ok(!JSON.stringify(bound).includes(baseline));
  const states = await readJson(path.join(episodeDir, 'character_state_refs.json'));
  assert.equal(states.approval_authority, 'hash_bound_openart_bank_visual_reviews');
  assert.equal(states.character_state_refs[0].state_ref_id, assetId);
  assert.ok(states.character_state_refs[0].approval_lineage.review.sha256);
  await assert.rejects(bindOpenArtShots(context, proposalPath), /Immutable OpenArt output already exists/);

  const imageBytes = await fs.readFile(record.local_absolute_path);
  await fs.writeFile(record.local_absolute_path, 'not the approved raster');
  await assert.rejects(hardenOpenArtShots(context), /Canonical raster changed/);
  await fs.writeFile(record.local_absolute_path, imageBytes);
  const inputBytes = await fs.readFile(promptsPath);
  bound.prompts[0].provider_prompt = 'Edited after binding.'; await write(promptsPath, bound);
  await assert.rejects(hardenOpenArtShots(context), /prompt plan changed/);
  await fs.writeFile(promptsPath, inputBytes);
  const hard = await hardenOpenArtShots(context);
  const hardened = await readJson(hard.output_path);
  assert.deepEqual(hardened.prompts, (await readJson(promptsPath)).prompts);
  assert.equal(hard.visual_approval_issued, false);
  assert.equal(hard.provider_prompt_mutations, 0);
  assert.equal(hard.reference_order_mutations, 0);
  assert.equal(hard.historical_visuals_accepted, 0);
  await assert.rejects(hardenOpenArtShots(context), /Immutable OpenArt output already exists/);
  assert.equal((await loadBank(bankRoot)).assets.length, 1);
  const events = (await fs.readFile(path.join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((row) => row.event), ['openart_shots_bound', 'openart_shots_hardened']);
  console.log('OpenArt shot binding, provenance, exact timing, native-ID and immutable hardening tests passed.');
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
