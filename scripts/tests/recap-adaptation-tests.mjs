import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { sha256File } from '../lib/file-hash.mjs';
import { createRecapSourcePackage, loadRecapSourcePackage } from '../lib/recap-source-package.mjs';
import { prepareRecapAdaptation, checkRecapAdaptation, importRecapAdaptation, loadRecapAdaptation, recordRecapAdaptationReview, validateRecapAdaptationDraft } from '../lib/recap-adaptation.mjs';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'recap-adaptation-tests-')));
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
let tests = 0;
const test = async (name, run) => { await run(); tests++; console.log(`ok - recap adaptation: ${name}`); };

try {
  const sourcePath = path.join(root, 'chapter.txt');
  await fs.writeFile(sourcePath, 'Joey saw the locked gate. 😮\r\n\r\nThe caretaker handed him a brass key.\r\n');
  const configPath = path.join(root, 'prose-config.json');
  await writeJson(configPath, { schema: 'goldflow_recap_source_config_v1', id: 'prose-fixture', title: 'The locked gate', source_kind: 'prose', files: [{ id: 'chapter1', path: sourcePath }] });
  const prepared = await createRecapSourcePackage({ configPath, outputDir: path.join(root, 'prose-package') });
  const sourcePackage = await loadRecapSourcePackage(prepared.package_path);
  const packageHash = await sha256File(prepared.package_path);
  const draft = { schema: 'goldflow_recap_adaptation_draft_v1', source_package_sha256: packageHash, target_wpm: 185, draft_units: [
    { id: 'gate', narration_text: '  Joey found a locked gate. 😮', source_refs: [{ kind: 'text', id: 'chapter1-p000001', quote: 'Joey saw the locked gate.' }], visual_intent: { panel_ids: [], needs_artwork: true, brief: 'Joey in front of the locked gate described by the source.' } },
    { id: 'key', narration_text: 'The caretaker gave him a brass key.  ', source_refs: [{ kind: 'text', id: 'chapter1-p000002', quote: 'The caretaker handed him a brass key.' }], visual_intent: { panel_ids: [], needs_artwork: true, brief: 'A caretaker hands Joey one brass key.' } },
  ] };
  const draftPath = path.join(root, 'draft.json'); await writeJson(draftPath, draft);
  await test('prepare gives an empty authoring template and exact source packet, never fabricated narration', async () => {
    const result = await prepareRecapAdaptation({ packagePath: prepared.package_path, outputDir: path.join(root, 'authoring') });
    const template = JSON.parse(await fs.readFile(result.draft_template_path, 'utf8'));
    assert.deepEqual(template.draft_units, []); assert.equal(template.source_package_sha256, packageHash);
    assert.equal(result.production_eligible, false);
  });
  let imported;
  const adaptationDir = path.join(root, 'candidate');
  await test('import preserves exact Unicode/whitespace bytes and inserts only declared separators', async () => {
    const checked = await checkRecapAdaptation({ packagePath: prepared.package_path, draftPath });
    assert.equal(checked.status, 'passed_structural_checks'); assert.equal(checked.missing_visual_unit_count, 2); assert.equal(checked.approval_status, 'source_and_adaptation_review_required');
    imported = await importRecapAdaptation({ packagePath: prepared.package_path, draftPath, outputDir: adaptationDir });
    const exact = draft.draft_units.map(row => row.narration_text).join('\n\n');
    assert.equal(await fs.readFile(imported.script.path, 'utf8'), exact);
    assert.equal(imported.script.sha256, await sha256File(imported.script.path));
    assert.deepEqual(await fs.readFile(imported.draft.path), await fs.readFile(draftPath));
    const loaded = await loadRecapAdaptation(adaptationDir);
    assert.equal(loaded.coverage.units[1].source_script_start_char, draft.draft_units[0].narration_text.length + 2);
    assert.equal(loaded.coverage.units[1].source_script_start_byte, Buffer.byteLength(draft.draft_units[0].narration_text) + 2);
    assert.equal(imported.production_eligible, false); assert.equal(imported.automatic_authoring, false);
    await assert.rejects(importRecapAdaptation({ packagePath: prepared.package_path, draftPath, outputDir: adaptationDir }), /immutable|already exists/);
  });
  await test('unknown, stale, invented, reordered and unbound visual references fail structural validation', () => {
    const rejects = (change, pattern) => { const value = structuredClone(draft); change(value); assert.throws(() => validateRecapAdaptationDraft({ draft: value, sourcePackage, sourcePackageSha256: packageHash }), pattern); };
    rejects(value => { value.source_package_sha256 = 'a'.repeat(64); }, /package hash/);
    rejects(value => { value.draft_units[0].source_refs[0].id = 'invented'; }, /unknown/);
    rejects(value => { value.draft_units[0].source_refs[0].quote = 'Joey became king.'; }, /exact source/);
    rejects(value => { delete value.draft_units[0].source_refs[0].quote; }, /exact source/);
    rejects(value => { value.draft_units.reverse(); }, /source order/);
    rejects(value => { value.draft_units[1].id = value.draft_units[0].id; }, /unique/);
    rejects(value => { value.draft_units[0].visual_intent.needs_artwork = false; }, /neither/);
    rejects(value => { value.draft_units[0].visual_intent.brief = ''; }, /authored brief/);
    rejects(value => { value.draft_units[0].visual_intent.panel_ids = ['invented']; }, /not a cited/);
  });
  await test('review binds exact hashes and creates a provider-free guarded narration handoff without production approval', async () => {
    await assert.rejects(recordRecapAdaptationReview({ adaptationDir, reviewer: 'Fixture reviewer', note: 'Read source and draft.', attestation: 'looks_fine' }), /attestation/);
    const reviewed = await recordRecapAdaptationReview({ adaptationDir, reviewer: 'Fixture reviewer', note: 'Read both exact source paragraphs, matched ordered narration and missing-art briefs.', attestation: 'source_and_adaptation_reviewed' });
    const handoff = JSON.parse(await fs.readFile(reviewed.narration_handoff_path, 'utf8'));
    assert.equal(reviewed.script_sha256, imported.script.sha256);
    assert.equal(reviewed.production_eligible, false);
    assert.equal(handoff.source_mode, 'prose_adaptation');
    assert.equal(handoff.providers_invoked, false); assert.equal(handoff.source_manufacturer_invoked, false);
    assert.ok(handoff.required_next_steps.includes('guarded_exact_script_approval'));
    assert.ok(handoff.required_next_steps.includes('authored_unit_to_word_span_binding'));
    const originalReview = await fs.readFile(reviewed.review_path);
    const second = await recordRecapAdaptationReview({ adaptationDir, reviewer: 'Another fixture reviewer', note: 'Second independent source and visual requirement review.', attestation: 'source_and_adaptation_reviewed' });
    assert.notEqual(second.review_path, reviewed.review_path); assert.deepEqual(await fs.readFile(reviewed.review_path), originalReview);
  });
  await test('comic panel references yield reusable source visual requirements without invented dialogue', async () => {
    const pagePath = path.join(root, 'page.png'); await sharp({ create: { width: 120, height: 240, channels: 3, background: '#3473a0' } }).png().toFile(pagePath);
    const comicConfig = path.join(root, 'comic-config.json');
    await writeJson(comicConfig, { schema: 'goldflow_recap_source_config_v1', id: 'comic-fixture', title: 'Panel fixture', source_kind: 'comic', files: [{ id: 'page1', path: pagePath }], panels: [{ id: 'gate-panel', file_id: 'page1', source_rect: { x: 0, y: 0, width: 1, height: 1 } }] });
    const comic = await createRecapSourcePackage({ configPath: comicConfig, outputDir: path.join(root, 'comic-package') });
    const comicDraft = { schema: 'goldflow_recap_adaptation_draft_v1', source_package_sha256: await sha256File(comic.package_path), target_wpm: 185, draft_units: [{ id: 'first-panel', narration_text: 'A source-grounded description still requires visual editorial review.', source_refs: [{ kind: 'panel', id: 'gate-panel' }], visual_intent: { panel_ids: ['gate-panel'], needs_artwork: false } }] };
    const file = path.join(root, 'comic-draft.json'); await writeJson(file, comicDraft);
    const result = await importRecapAdaptation({ packagePath: comic.package_path, draftPath: file, outputDir: path.join(root, 'comic-candidate') });
    assert.equal(result.missing_visual_unit_count, 0); assert.equal(result.semantic_review_required, true);
    comicDraft.draft_units[0].source_refs[0].quote = 'Invented OCR quote'; await writeJson(file, comicDraft);
    await assert.rejects(checkRecapAdaptation({ packagePath: comic.package_path, draftPath: file }), /invented quote/);
  });
  await test('mutated candidate or original source cannot retain review eligibility', async () => {
    await fs.appendFile(imported.script.path, '\nUnauthorized edit');
    await assert.rejects(loadRecapAdaptation(adaptationDir), /stale/);
    await fs.appendFile(sourcePath, '\nNew source paragraph.');
    await assert.rejects(checkRecapAdaptation({ packagePath: prepared.package_path, draftPath }), /stale/);
    const outputDir = path.join(root, 'stale-output');
    await assert.rejects(importRecapAdaptation({ packagePath: prepared.package_path, draftPath, outputDir }), /stale/);
    await assert.rejects(fs.stat(outputDir), { code: 'ENOENT' });
  });
  console.log(`recap adaptation tests passed: ${tests}`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
