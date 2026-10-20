import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { panelProductionFixture, writeJson, digest } from './panel-production-fixture.mjs';
import { resolveZoneReviewImages, reviewViewReport } from '../lib/panel-zone-review.mjs';
import { prepareZoneRepair, applyZoneRepair, validateZoneRepairRequest } from '../lib/panel-zone-repair.mjs';
import { readPanelProductionInputs } from '../lib/panel-production-plan.mjs';
import { reconcilePanelAssetReport } from '../lib/panel-production-assets.mjs';
import { structuralAuditForTests } from '../image-output-qa.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-zone-qa-'));
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
let count = 0;
async function test(name, body) { await body(); count++; console.log(`ok - zone QA/repair: ${name}`); }
const zoneInputs = async f => ({ episodeDir: f.episodeDir, prompts: (await read(f.p('section_image_prompts_hardened.json'))).prompts, results: (await read(f.p('imagegen_report_ep_01.json'))).results });
const request = (f, overrides = {}) => ({ schema: 'goldflow_panel_zone_repair_request_v1', episode: 'ep_01', actual_review: true, reviewer: 'Fixture reviewer', note: 'The right zone shows the wrong price on the tag; the left zone is correct.', reason: 'Zone content contradicts the narrated price; re-draw only this zone.', evidence: 'review_rejected', page_asset_id: 'page_0', zone_id: 'page_0_z2', rejected_page_sha256: f.accepted.image_b, replacement_prompt: 'A single landscape manhwa frame: a close-up of a price tag reading nothing, held by a hand at a market stall.', ...overrides });
const reject = async (f, imageId) => {
  const decisions = await read(f.p('image_output_review_decisions_ep_01.json'));
  decisions.decisions.find(row => row.image_id === imageId).decision = 'rejected';
  await writeJson(f.p('image_output_review_decisions_ep_01.json'), decisions);
};

try {
  await test('zone beats are reviewed on their own crops while acceptance stays on the page raster', async () => {
    const f = await panelProductionFixture(path.join(root, 'review'), { pages: true });
    const inputs = await zoneInputs(f), review = await resolveZoneReviewImages(inputs);
    assert.deepEqual(review.findings, []);
    assert.deepEqual([...review.views.values()].map(view => [view.zone_slot, path.basename(view.review_image_path)]), [['left', 'left.png'], ['right', 'right.png']]);
    const audit = await structuralAuditForTests({ prompts: inputs.prompts }, { results: inputs.results }, null, null, review);
    for (const row of audit.rows) {
      assert.equal(row.image_sha256, f.accepted[row.image_id], 'acceptance binds the page raster');
      assert.equal(row.review_image_path, review.views.get(row.image_id).review_image_path);
    }
    assert.deepEqual(reviewViewReport({ results: inputs.results }, review.views).results.map(row => path.basename(row.image_path)), ['left.png', 'right.png']);
  });

  await test('missing, failed, mismatched or tampered geometry blocks exactly the zone beats', async () => {
    const codes = async (name, change) => {
      const f = await panelProductionFixture(path.join(root, name), { pages: true });
      await change(f);
      return (await resolveZoneReviewImages(await zoneInputs(f))).findings.map(row => [row.image_id, row.code]);
    };
    assert.deepEqual(await codes('missing', f => fs.rm(f.geometry.receipt_path)), [['image_a', 'page_geometry_missing'], ['image_b', 'page_geometry_missing']]);
    assert.deepEqual(await codes('failed', async f => { const g = await read(f.geometry.receipt_path); g.status = 'failed'; await writeJson(f.geometry.receipt_path, g); }), [['image_a', 'page_geometry_failed'], ['image_b', 'page_geometry_failed']]);
    assert.deepEqual(await codes('template', async f => { const g = await read(f.geometry.receipt_path); g.template = 'P2H'; await writeJson(f.geometry.receipt_path, g); }), [['image_a', 'page_geometry_mismatch'], ['image_b', 'page_geometry_mismatch']]);
    assert.deepEqual(await codes('crop', f => fs.appendFile(f.geometry.review_crops[1].path, 'x')), [['image_b', 'zone_review_crop_invalid']]);
  });

  await test('a reviewed zone repair is prepared without dispatch and evidence must be current', async () => {
    const f = await panelProductionFixture(path.join(root, 'prepare'), { pages: true });
    await assert.rejects(prepareZoneRepair({ episodeDir: f.episodeDir, episode: 'ep_01', request: request(f) }), /hash-bound rejection/);
    await reject(f, 'image_b');
    await assert.rejects(validateZoneRepairRequest({ episodeDir: f.episodeDir, episode: 'ep_01', request: request(f, { actual_review: false }) }), /actual review/);
    await assert.rejects(validateZoneRepairRequest({ episodeDir: f.episodeDir, episode: 'ep_01', request: request(f, { evidence: 'geometry_failed' }) }), /failed receipt/);
    await assert.rejects(validateZoneRepairRequest({ episodeDir: f.episodeDir, episode: 'ep_01', request: request(f, { rejected_page_sha256: 'f'.repeat(64) }) }), /not the current page raster/);
    await assert.rejects(validateZoneRepairRequest({ episodeDir: f.episodeDir, episode: 'ep_01', request: request(f, { zone_id: 'page_0_z9' }) }), /unknown zone/);
    const spec = await prepareZoneRepair({ episodeDir: f.episodeDir, episode: 'ep_01', request: request(f) });
    assert.equal(spec.status, 'prepared_not_dispatched'); assert.equal(spec.provider_calls, 0);
    assert.deepEqual(spec.image_ids, ['image_b']);
    await assert.rejects(prepareZoneRepair({ episodeDir: f.episodeDir, episode: 'ep_01', request: request(f) }), /EEXIST/);
  });

  await test('applying a repair swaps only the zone beats and composition uses the replacement whole', async () => {
    const f = await panelProductionFixture(path.join(root, 'apply'), { pages: true });
    await reject(f, 'image_b');
    const spec = await prepareZoneRepair({ episodeDir: f.episodeDir, episode: 'ep_01', request: request(f) });
    const replacement = f.p('zone-replacement.png'); await sharp({ create: { width: 320, height: 180, channels: 3, background: '#20a060' } }).png().toFile(replacement);
    const replacementSha = digest(await fs.readFile(replacement));
    const receipt = f.p('zone-replacement.receipt.json'), receiptSha = await writeJson(receipt, { output_path: replacement, output_sha256: replacementSha, request_id: 'zone-fixture' });
    const before = { report: await read(f.p('imagegen_report_ep_01.json')), ledger: await read(f.p('cut_execution_ledger.json')) };
    const bad = f.p('portrait.png'); await sharp({ create: { width: 180, height: 320, channels: 3, background: '#20a060' } }).png().toFile(bad);
    const badReceipt = f.p('portrait.receipt.json'), badSha = await writeJson(badReceipt, { output_sha256: digest(await fs.readFile(bad)) });
    await assert.rejects(applyZoneRepair({ episodeDir: f.episodeDir, episode: 'ep_01', specPath: spec.spec_path, specSha256: spec.spec_sha256, replacementPath: bad, resultReceiptPath: badReceipt, resultReceiptSha256: badSha }), /16:9 landscape/);
    const applied = await applyZoneRepair({ episodeDir: f.episodeDir, episode: 'ep_01', specPath: spec.spec_path, specSha256: spec.spec_sha256, replacementPath: replacement, resultReceiptPath: receipt, resultReceiptSha256: receiptSha });
    assert.deepEqual(applied.image_ids, ['image_b']);
    const report = await read(f.p('imagegen_report_ep_01.json')), ledger = await read(f.p('cut_execution_ledger.json'));
    assert.deepEqual(report.results[0], before.report.results[0], 'the accepted sibling zone is untouched');
    assert.deepEqual(ledger.cuts[0], before.ledger.cuts[0]);
    assert.equal(report.results[1].image_sha256, replacementSha); assert.equal(ledger.cuts[1].image_qa_status, 'pending');
    assert.equal(digest(await fs.readFile(report.results[1].image_path)), replacementSha);
    assert.equal(digest(await fs.readFile(before.report.results[1].image_path)), f.accepted.image_b, 'the page raster stays immutable');
    assert.deepEqual((await read(applied.receipt_path)).previous_report.results[1], before.report.results[1], 'the receipt retains the replaced row');
    await assert.rejects(validateZoneRepairRequest({ episodeDir: f.episodeDir, episode: 'ep_01', request: request(f) }), /already repaired/);
    assert.equal((await resolveZoneReviewImages(await zoneInputs(f))).views.has('image_b'), false, 'a repaired zone is reviewed as an ordinary image');
    await assert.rejects(reconcilePanelAssetReport({ episodeDir: f.episodeDir, promptsPath: f.p('section_image_prompts_hardened.json'), imagegenReportPath: f.p('imagegen_report_ep_01.json'), cutExecutionLedgerPath: f.p('cut_execution_ledger.json') }), /zone repairs are applied/);
    // Simulate the re-run of image QA accepting the replacement, then load composition inputs.
    ledger.cuts[1].image_qa_status = 'passed'; await writeJson(f.p('cut_execution_ledger.json'), ledger);
    const reportSha = digest(await fs.readFile(f.p('imagegen_report_ep_01.json')));
    const decisions = await read(f.p('image_output_review_decisions_ep_01.json')); decisions.decisions = decisions.decisions.filter(row => row.image_id !== 'image_b');
    const decisionsSha = await writeJson(f.p('image_output_review_decisions_ep_01.json'), decisions);
    const focal = await read(f.p('image_focal_analysis_ep_01.json')); focal.imagegen_report_sha256 = reportSha;
    const focalSha = await writeJson(f.p('image_focal_analysis_ep_01.json'), focal);
    const qa = await read(f.p('image_output_qa_ep_01.json'));
    Object.assign(qa, { imagegen_report_sha256: reportSha, review_decisions_sha256: decisionsSha, focal_analysis_sha256: focalSha, accepted_image_hashes: { ...qa.accepted_image_hashes, image_b: replacementSha } });
    await writeJson(f.p('image_output_qa_ep_01.json'), qa);
    const loaded = await readPanelProductionInputs(f);
    assert.deepEqual(loaded.timeline.panels[1].source_rect, { x: 0, y: 0, width: 1, height: 1 });
    assert.equal(loaded.timeline.panels[1].metadata.zone_repair_request_sha256, spec.request_sha256);
    assert.deepEqual(loaded.timeline.panels[0].source_rect, f.geometry.zones[0].safe_rect, 'the sibling still crops its page zone');
  });
  console.log(`Panel zone QA and repair: ${count} test groups passed.`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
