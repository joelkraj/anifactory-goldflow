import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildCrimeFootageNarrationPlan, concatenateCrimeNarrationForQa, produceCrimeFootageProofNarration } from "../lib/crime-footage-proof-narration.mjs";
import { inspectTrueCrimeProofWav } from "../lib/true-crime-proof-narration.mjs";
import { QWEN_JOEL_PRIMARY_LOCK as PIN } from "../lib/narration-tts-policy.mjs";
import { buildNarrationPreSynthesisGate, authorizeNarrationPreSynthesisGate } from "../lib/narration-pre-synthesis-gate.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const bytes = value => Buffer.from(JSON.stringify(value));
function freeze(f) {
  f.editorialPlanBytes = bytes(f.editorialPlan);
  f.identity.plan.sha256 = sha(f.editorialPlanBytes);
  f.identity.script.sha256 = sha(f.scriptText);
  f.identityBytes = bytes(f.identity);
  return f;
}
function fixture(count = 3) {
  const texts = ["The recording preserves a witness account.", "This exhibit establishes part of the timeline.", "The court did not reach a verdict.", "The record remains separate from its interpretation."];
  const editorialPlan = { schema: "goldflow_crime_footage_proof_plan_v1",
    narration_units: texts.slice(0, count).map((text, index) => ({ id: `N0${index + 1}`, text, source_ids: ["E01"] })) };
  const identity = { schema: "goldflow_crime_footage_proof_identity_v1", production_eligible: false, publish_allowed: false,
    plan: { path: "/synthetic-fixture/plan.json" }, script: { path: "/synthetic-fixture/script.txt" }, sources: [{ id: "E01" }],
    narration: { provider: PIN.provider, model: PIN.model_id, model_revision: PIN.model_revision, voice_id: PIN.voice_id,
      voice_sha256: PIN.voice_sha256, reference_audio: { path: PIN.reference_audio_path, sha256: PIN.reference_audio_sha256 },
      reference_text: { path: "/synthetic-fixture/reference.txt", sha256: PIN.reference_text_sha256 } } };
  return freeze({ editorialPlan, identity, scriptText: editorialPlan.narration_units.map(u => u.text).join("\n\n") + "\n" });
}
function gateFor(built) {
  return buildNarrationPreSynthesisGate({ plan: built.plan, planFileSha256: sha(bytes(built.plan)), identityFileSha256: built.identityHash,
    scriptSha256: built.scriptHash, policy: built.policy, planPolicy: built.planPolicy, sourceArtifactHashes: built.sourceArtifactHashes,
    textIr: built.textIr, textIrFileSha256: sha(bytes(built.textIr)), spokenTextAudit: built.spokenTextAudit,
    spokenTextAuditFileSha256: sha(bytes(built.spokenTextAudit)) });
}
function tone(samples) {
  const pcm = Buffer.alloc(samples * 2);
  for (let n = 0; n < samples; n++) pcm.writeInt16LE(Math.round(Math.sin(n / 11) * 1800), n * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

for (const count of [1, 3, 4]) {
  const f = fixture(count), built = buildCrimeFootageNarrationPlan(f), gate = gateFor(built);
  assert.equal(gate.status, "passed", JSON.stringify(gate.findings));
  assert.equal(gate.model_load_performed, false);
  assert.equal(gate.synthesis_invoked, false);
  assert.equal(authorizeNarrationPreSynthesisGate(gate).synthesis_invoked, true);
  assert.deepEqual(built.plan.units.map(u => u.narrator_unit_id), f.editorialPlan.narration_units.map(u => u.id));
  assert.equal(built.textIr.transformed_unit_count, 0);
  assert.deepEqual(built.batchPlan.cohorts.map(c => c.effective_batch_size), [count]);
  for (const unit of built.plan.units) {
    assert.equal(unit.source_text, unit.caption_text);
    assert.equal(unit.provider_request.request.text, unit.source_text);
    assert.equal(unit.provider_request.request.instruction, undefined);
    assert.equal(unit.provider_request.request.native_speed, undefined);
    assert.equal(unit.spoken_text_lineage.components[0].source_text, unit.source_text);
    assert.equal(unit.spoken_text_lineage.final_transformations.length, 0);
  }
}
const source = fixture(), built = buildCrimeFootageNarrationPlan(source);
const forgedRequest = structuredClone(built);
forgedRequest.plan.units[0].provider_request.request.text = "A different sentence.";
assert.equal(gateFor(forgedRequest).status, "blocked");
assert.throws(() => authorizeNarrationPreSynthesisGate(gateFor(forgedRequest)), /passed, hash-valid zero-spend/);

const changed = fixture(); changed.editorialPlan.narration_units[0].text = "Words changed after the binding.";
assert.throws(() => buildCrimeFootageNarrationPlan(changed), /Objects differ/);
const reordered = fixture(); reordered.editorialPlan.narration_units.reverse();
assert.throws(() => buildCrimeFootageNarrationPlan(freeze(reordered)), /exactly concatenate/);
const duplicate = fixture(); duplicate.editorialPlan.narration_units[1].id = "N01";
assert.throws(() => buildCrimeFootageNarrationPlan(freeze(duplicate)), /Duplicate/);
const empty = fixture(0);
assert.throws(() => buildCrimeFootageNarrationPlan(empty), /one to four/);
const fifth = fixture(4); fifth.editorialPlan.narration_units.push({ id: "N05", text: "A fifth source sentence.", source_ids: ["E01"] });
fifth.scriptText = fifth.editorialPlan.narration_units.map(u => u.text).join("\n\n");
assert.throws(() => buildCrimeFootageNarrationPlan(freeze(fifth)), /one to four/);
const wrongVoice = fixture(); wrongVoice.identity.narration.voice_id = "unselected_suspect_clone";
assert.throws(() => buildCrimeFootageNarrationPlan(freeze(wrongVoice)), /voice\/model lock/);
const wrongRef = fixture(); wrongRef.identity.narration.reference_audio.sha256 = "0".repeat(64);
assert.throws(() => buildCrimeFootageNarrationPlan(freeze(wrongRef)), /reference lock/);
const legacy = fixture(); legacy.identity.schema = "goldflow_true_crime_proof_identity_v1";
assert.throws(() => buildCrimeFootageNarrationPlan(freeze(legacy)), /new private footage proof identity/);
const unknown = fixture(); unknown.editorialPlan.narration_units[0].source_ids = ["UNKNOWN"];
assert.throws(() => buildCrimeFootageNarrationPlan(freeze(unknown)), /source coverage/);
for (const badText of ["[whisper] The witness spoke.", "The report listed 911.", `${"word ".repeat(61)}end.`]) {
  const f = fixture(); f.editorialPlan.narration_units[0].text = badText;
  f.scriptText = f.editorialPlan.narration_units.map(u => u.text).join("\n\n");
  assert.throws(() => buildCrimeFootageNarrationPlan(freeze(f)), /tags|sixty words/);
}
const cast = fixture(); cast.editorialPlan.narration_units[0].speaker = "SUSPECT";
assert.throws(() => buildCrimeFootageNarrationPlan(freeze(cast)), /narrator only/);

const wavs = built.plan.units.map((_, index) => tone(2407 + 107 * index));
const joined = concatenateCrimeNarrationForQa(built.plan.units, wavs);
const total = wavs.reduce((n, wav) => n + inspectTrueCrimeProofWav(wav).sample_count, 0);
assert.equal(joined.sample_count, total);
assert.equal(joined.duration_sec, total / 24000);
assert.equal(joined.added_silence_samples, 0);
assert.equal(joined.program_timeline, false);
assert(inspectTrueCrimeProofWav(joined.bytes).data.equals(Buffer.concat(wavs.map(wav => inspectTrueCrimeProofWav(wav).data))));
for (const [index, row] of joined.timeline.entries()) {
  assert.equal(row.duration_sec, inspectTrueCrimeProofWav(wavs[index]).sample_count / 24000);
  assert.equal(row.end_sample - row.start_sample, row.sample_count);
}
assert.throws(() => concatenateCrimeNarrationForQa(built.plan.units, wavs.slice(1)), /Every ordered unit/);
assert.throws(() => concatenateCrimeNarrationForQa(built.plan.units, [wavs[0].subarray(0, 100), ...wavs.slice(1)]), /Truncated/);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "crime-footage-narration-refusal-fixture-"));
try {
  await assert.rejects(() => produceCrimeFootageProofNarration({ proofDir: root, outputDir: path.join(root, "other") }), /guarded attempt/);
  await assert.rejects(() => produceCrimeFootageProofNarration({ proofDir: root, outputDir: path.join(root, "attempts/narration/output") }), /attempt token/);
  assert.deepEqual(await fs.readdir(root), [], "Rejected calls must not write an invocation or load the model.");
} finally { await fs.rm(root, { recursive: true, force: true }); }
console.log("crime footage narration: exact compiler/lineage, gate, owned voice, scope refusal, and no-pad sample accounting passed (provider-free synthetic fixtures)");
