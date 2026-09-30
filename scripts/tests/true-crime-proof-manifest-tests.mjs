import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildTrueCrimeProofManifest, HALDERSON_PROOF_PLAN_V3_SHA256 } from '../lib/true-crime-proof-manifest.mjs';
import { planTrueCrimeProof } from '../lib/true-crime-proof-renderer.mjs';

const sourcePlan = fileURLToPath(new URL('../../research/chandler-halderson-development/proof-plan-v3.json', import.meta.url));
try {
  await fs.access(sourcePlan);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  console.log('SKIP: exact Halderson plan fixture is outside this code-only checkout.');
  process.exit(0);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'true-crime-manifest-fixture-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ref = async (file) => ({ path: file, sha256: sha(await fs.readFile(file)) });
async function write(name, bytes) { const file = path.join(root, name); await fs.writeFile(file, bytes); return ref(file); }
async function json(name, value) { return write(name, JSON.stringify(value, null, 2)); }
function wav(seconds) {
  const size = Math.round(seconds * 24000) * 2, bytes = Buffer.alloc(44 + size);
  bytes.write('RIFF'); bytes.writeUInt32LE(size + 36, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(size, 40); bytes.writeInt16LE(1000, 44);
  return bytes;
}
try {
  const bytes = await fs.readFile(sourcePlan), plan = JSON.parse(bytes);
  assert.equal(sha(bytes), HALDERSON_PROOF_PLAN_V3_SHA256);
  const identity = { schema: 'goldflow_true_crime_proof_identity_v1', production_eligible: false, publish_allowed: false,
    channel_name: 'CrimeDungeon', series_slug: 'fixture', run_slug: 'manifest-test', episode: 'ep_01', title: plan.title,
    plan: await write('editorial-plan.json', bytes), script: await write('script.txt', plan.scenes.map((s) => s.audio.text).join('\n\n')) };
  const timeline = []; let cursor = 0;
  for (const scene of plan.scenes) {
    timeline.push({ scene_id: scene.id, unit_id: `${scene.id}-fixture`, text: scene.audio.text, source_text_sha256: sha(scene.audio.text), start_sec: cursor, end_sec: cursor + 8.8, duration_sec: 8.8 });
    cursor += 8.8 + (scene.id === 'S07' ? 0 : .43);
  }
  const audio = await write('fixture.wav', wav(cursor));
  const report = { schema: 'goldflow_true_crime_proof_narration_result_v1', source_text_sha256: identity.script.sha256, editorial_plan_sha256: identity.plan.sha256, audio, timeline, measured_duration_sec: cursor, technical_qa: 'needs_review' };
  const receiptRef = await json('narration-result.json', report);
  const narration = { artifacts: [{ id: 'audio', ...audio, kind: 'narration_audio' }, { id: 'receipt', ...receiptRef, kind: 'narration_receipt' }] };
  const assets = { artifacts: [] };
  for (const id of ['portrait_source', 'e01_initial', 'e01_cabin', 'e01_answer', 'e02_parade', 'chandler_cutout', 'detective_cutout']) assets.artifacts.push({ id, ...await write(`${id}.png`, `BOUND SYNTHETIC ASSET ${id}`), source_ids: [] });
  const manifest = await buildTrueCrimeProofManifest({ identity, narration, assets });
  const renderedPlan = planTrueCrimeProof(manifest);
  assert.equal(manifest.scenes.length, 7);
  assert.equal(renderedPlan.authored_holds_sec, 30);
  assert.ok(Math.abs(renderedPlan.authored_duration_sec - (cursor + 30)) < 1e-6);
  assert.notEqual(renderedPlan.duration_sec, 120);
  assert.equal(manifest.narration.units[0].start_sec, 0);
  assert.equal(manifest.narration.units.at(-1).end_sec, Math.round(cursor * 24000) / 24000);
  for (let i = 0; i < 6; i++) {
    assert.equal(manifest.narration.units[i].end_sec, manifest.narration.units[i + 1].start_sec);
    assert.ok(Math.abs(manifest.narration.units[i].retained_paragraph_gap_sec - .43) < 1e-7);
  }
  assert.equal(manifest.narration.units.map((u) => u.text).join('\n\n'), await fs.readFile(identity.script.path, 'utf8'));
  assert.equal(manifest.provenance.narration_technical_qa, 'needs_review', 'builder must not manufacture narration approval');
  assert.equal(manifest.provenance.draft_scene_budgets_used_for_render, false);
  for (const scene of manifest.scenes.slice(0, 3)) assert.match(scene.source_label, /undated agency photograph via ABC News/);
  assert.match(manifest.scenes[2].layers.find((l) => l.id === 'detective_label').text, /ILLUSTRATION/);
  assert.match(manifest.scenes[3].disclosure, /TYPESET EXCERPT.*DOCUMENT READING/);
  assert.equal(manifest.scenes[3].layers.find((l) => l.id === 'exact_document_sentence').text, plan.scenes[3].audio.text);
  assert.match(manifest.scenes[5].disclosure, /LATER RECORD REVIEW/);
  assert.match(manifest.scenes[6].layers.find((l) => l.id === 'return_to_search').text, /BACK TO JULY 8/);
  assert.equal(manifest.scenes.some((s) => s.layers.some((l) => l.type === 'video')), false);
  const preparation = { preparation: await json('asset-preparation.json', assets) };
  assert.deepEqual(await buildTrueCrimeProofManifest({ identity, narration, assets: preparation }), manifest);
  await assert.rejects(buildTrueCrimeProofManifest({ identity, narration, assets: { artifacts: assets.artifacts.slice(0, 5) } }), /missing prepared asset chandler_cutout/);
  const badIdentity = structuredClone(identity); badIdentity.plan.sha256 = '0'.repeat(64);
  await assert.rejects(buildTrueCrimeProofManifest({ identity: badIdentity, narration, assets }), /exact selected Halderson/);
  const changedReport = structuredClone(report); changedReport.timeline[3].text = 'A newly invented sentence.';
  const changedRef = await json('changed-narration.json', changedReport);
  await assert.rejects(buildTrueCrimeProofManifest({ identity, narration: { artifacts: [narration.artifacts[0], { kind: 'narration_receipt', ...changedRef }] }, assets }), /narration text changed/);
  const tooShortReport = structuredClone(report), shortAudio = await write('short.wav', wav(50));
  tooShortReport.audio = shortAudio; tooShortReport.measured_duration_sec = 50;
  for (let i = 0; i < 7; i++) { tooShortReport.timeline[i].start_sec = i * 50 / 7; tooShortReport.timeline[i].end_sec = (i + 1) * 50 / 7; tooShortReport.timeline[i].duration_sec = 50 / 7; }
  const shortReceipt = await json('short-receipt.json', tooShortReport);
  await assert.rejects(buildTrueCrimeProofManifest({ identity, narration: { artifacts: [{ kind: 'narration_audio', ...shortAudio }, { kind: 'narration_receipt', ...shortReceipt }] }, assets }), /90–150/);
  assert.equal((await ref(audio.path)).sha256, audio.sha256);
  console.log('Seven-scene manifest tests passed: exact plan/text, existing paragraph-gap preservation, fixed reading holds, undated portrait/illustration labels, chronology return, missing/stale input refusal. No render or provider calls.');
} finally { await fs.rm(root, { recursive: true, force: true }); }
