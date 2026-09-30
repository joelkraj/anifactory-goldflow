import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTrueCrimeProofNarrationPlan, inspectTrueCrimeProofWav, stitchTrueCrimeProofUnits, createTrueCrimeProofNarrationProducer } from "../lib/true-crime-proof-narration.mjs";
import { QWEN_JOEL_PRIMARY_LOCK as PIN } from "../lib/narration-tts-policy.mjs";
import { buildNarrationPreSynthesisGate, authorizeNarrationPreSynthesisGate } from "../lib/narration-pre-synthesis-gate.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(JSON.stringify(value));
function fixture() {
  const texts = ["A witness described the event.", "The original report retained that statement.", "The time was recorded separately.",
    "This is a document reading.", "The narrator explains the source limitation.", "A later record changed the timeline.", "The investigation continues in the following scene."];
  const editorialPlan = { schema: "goldflow_true_crime_editorial_proof_plan_v1", sources: [{ id: "F01", kind: "synthetic_fixture" }],
    scenes: texts.map((text, index) => ({ id: `S0${index + 1}`, source_ids: ["F01"], claim_ids: [],
      audio: { origin: "narration", text_mode: index === 3 ? "document_reading" : "paraphrase", text } })) };
  const editorialPlanBytes = bytes(editorialPlan), scriptText = texts.join("\n\n") + "\n";
  const identity = { schema: "goldflow_true_crime_proof_identity_v1", production_eligible: false,
    plan: { path: "/fixture/plan.json", sha256: hash(editorialPlanBytes) }, script: { path: "/fixture/script.txt", sha256: hash(scriptText) },
    narration: { provider: PIN.provider, model: PIN.model_id, model_revision: PIN.model_revision, voice_id: PIN.voice_id, voice_sha256: PIN.voice_sha256,
      reference_audio: { path: PIN.reference_audio_path, sha256: PIN.reference_audio_sha256 }, reference_text: { path: "/fixture/reference.txt", sha256: PIN.reference_text_sha256 } } };
  return { editorialPlan, editorialPlanBytes, identity, identityBytes: bytes(identity), scriptText };
}
function gateFor(built) {
  return buildNarrationPreSynthesisGate({ plan: built.plan, planFileSha256: hash(bytes(built.plan)), identityFileSha256: built.identityHash,
    scriptSha256: built.scriptHash, policy: built.policy, planPolicy: built.planPolicy, sourceArtifactHashes: built.sourceArtifactHashes,
    textIr: built.textIr, textIrFileSha256: hash(bytes(built.textIr)), spokenTextAudit: built.spokenTextAudit,
    spokenTextAuditFileSha256: hash(bytes(built.spokenTextAudit)) });
}
function refreeze(value) {
  value.editorialPlanBytes = bytes(value.editorialPlan); value.identity.plan.sha256 = hash(value.editorialPlanBytes);
  value.identity.script.sha256 = hash(value.scriptText); value.identityBytes = bytes(value.identity); return value;
}
function tone(samples, amplitude = 3000) {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(amplitude * Math.sin(i / 13)), i * 2);
  const h = Buffer.alloc(44); h.write("RIFF"); h.writeUInt32LE(data.length + 36, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40); return Buffer.concat([h, data]);
}

const source = fixture(), built = buildTrueCrimeProofNarrationPlan(source), gate = gateFor(built);
assert.equal(gate.status, "passed", JSON.stringify(gate.findings));
assert.equal(gate.model_load_performed, false); assert.equal(gate.synthesis_invoked, false);
assert.equal(authorizeNarrationPreSynthesisGate(gate).phase, "synthesis_authorized_immediately_before_helper_import");
assert.deepEqual(built.plan.units.map((u) => u.spoken_text), source.editorialPlan.scenes.map((s) => s.audio.text));
assert.equal(built.policy.primary.reference_audio_path, PIN.reference_audio_path);
assert.equal(built.policy.primary.reference_variant_id, "joel_ref_02_tense_narration");
assert.equal(built.textIr.transformed_unit_count, 0);
assert.deepEqual(built.batchPlan.cohorts.map((c) => c.effective_batch_size), [4, 3]);
for (const unit of built.plan.units) {
  assert.equal(unit.provider_request.request.text, unit.source_text);
  assert.equal(unit.provider_request.request.instruction, undefined);
  assert.equal(unit.provider_request.request.native_speed, undefined);
  assert.equal(unit.spoken_text_transformations.length, 0);
}

const changed = fixture(); changed.editorialPlan.scenes[0].audio.text = "Secretly rewritten words.";
assert.throws(() => buildTrueCrimeProofNarrationPlan(changed), /objects differ/);
const reordered = fixture(); reordered.editorialPlan.scenes.reverse();
assert.throws(() => buildTrueCrimeProofNarrationPlan(refreeze(reordered)), /exactly concatenate/);
const wrongVoice = fixture(); wrongVoice.identity.narration.voice_id = "unapproved_clone";
assert.throws(() => buildTrueCrimeProofNarrationPlan(refreeze(wrongVoice)), /voice lock mismatch/);
const wrongReference = fixture(); wrongReference.identity.narration.reference_audio.sha256 = "a".repeat(64);
assert.throws(() => buildTrueCrimeProofNarrationPlan(refreeze(wrongReference)), /reference lock mismatch/);
const tag = fixture(); tag.editorialPlan.scenes[0].audio.text = "[angry] This must never reach synthesis.";
tag.scriptText = tag.editorialPlan.scenes.map((s) => s.audio.text).join("\n\n");
assert.throws(() => buildTrueCrimeProofNarrationPlan(refreeze(tag)), /performance\/system tags/);
const cast = fixture(); cast.editorialPlan.scenes[0].audio.origin = "recreated";
assert.throws(() => buildTrueCrimeProofNarrationPlan(refreeze(cast)), /narrator speech only/);
const huge = fixture(); huge.editorialPlan.scenes[0].audio.text = `${"word ".repeat(61)}end.`;
huge.scriptText = huge.editorialPlan.scenes.map((s) => s.audio.text).join("\n\n");
assert.throws(() => buildTrueCrimeProofNarrationPlan(refreeze(huge)), /sixty words/);
const forged = structuredClone(built); forged.plan.units[0].provider_request.request.text = "Different speech.";
assert.equal(gateFor(forged).status, "blocked");
assert.throws(() => authorizeNarrationPreSynthesisGate(gateFor(forged)), /passed, hash-valid zero-spend/);

const wavs = built.plan.units.map((_, i) => tone(2400 + 31 * i));
const stitch = stitchTrueCrimeProofUnits({ units: built.plan.units, wavs, qualityContract: built.policy.narration_quality_contract });
assert.equal(stitch.accounting.status, "passed"); assert.equal(stitch.timeline.length, 7);
assert.equal(stitch.boundaries.length, 6); assert.equal(stitch.policy.edge_trimming, false);
assert.equal(stitch.policy.minimum_duration_padding, false);
assert.equal(inspectTrueCrimeProofWav(stitch.bytes).sample_count, wavs.reduce((sum, wav) => sum + inspectTrueCrimeProofWav(wav).sample_count, 0) + 6 * 10320);
for (let i = 0; i < wavs.length; i++) {
  const start = 44 + stitch.timeline[i].start_sample * 2, data = inspectTrueCrimeProofWav(wavs[i]).data;
  assert(stitch.bytes.subarray(start, start + data.length).equals(data), "Raw PCM must survive the candidate stitch exactly.");
}
assert.throws(() => inspectTrueCrimeProofWav(tone(2400, 0)), /Silent/);
assert.throws(() => inspectTrueCrimeProofWav(wavs[0].subarray(0, 100)), /Truncated/);
const badRate = Buffer.from(wavs[0]); badRate.writeUInt32LE(48000, 24);
assert.throws(() => inspectTrueCrimeProofWav(badRate), /24 kHz/);
// Exercise the actual producer, source hashes, shared gate and no-resubmission
// marker with explicit synthetic audio. Model/ASR/voice/mastering boundaries are
// mocked; this must never be cited as generated speech or listening evidence.
const proofDir = await fs.mkdtemp(path.join(os.tmpdir(), "true-crime-narration-fixture-"));
try {
  const f = fixture(), outputDir = path.join(proofDir, "attempts/narration/output");
  f.identity.plan.path = path.join(proofDir, "plan.json"); f.identity.script.path = path.join(proofDir, "script.txt");
  f.identityBytes = bytes(f.identity);
  await fs.writeFile(f.identity.plan.path, f.editorialPlanBytes); await fs.writeFile(f.identity.script.path, f.scriptText);
  await fs.writeFile(path.join(proofDir, "run_identity.json"), f.identityBytes);
  await fs.mkdir(outputDir, { recursive: true });
  let calls = 0;
  const producer = createTrueCrimeProofNarrationProducer({
    loadIdentity: async () => ({ identity: f.identity, plan: f.editorialPlan, scriptText: f.scriptText, identity_sha256: hash(f.identityBytes) }),
    readReference: async (ref) => ref === f.identity.narration.reference_text ? Buffer.from(PIN.reference_text) : tone(2400),
    inspectReferences: async () => ({}),
    synthesize: async (args) => {
      calls++; assert.equal(args.attempt, 1); assert.equal(args.preSynthesisGate.status, "passed");
      assert.equal(args.preSynthesisGate.phase, "synthesis_authorized_immediately_before_helper_import");
      assert.deepEqual(args.units.map((u) => u.spoken_text), f.editorialPlan.scenes.map((s) => s.audio.text));
      await fs.mkdir(args.outputDir);
      const results = [];
      for (const unit of args.units) {
        const audio = tone(2400), file = path.join(args.outputDir, `${unit.unit_id}.wav`); await fs.writeFile(file, audio);
        results.push({ unit_id: unit.unit_id, output_path: file, output_sha256: hash(audio), spoken_text_sha256: unit.spoken_text_sha256,
          token_limit_reached: false, synthesis_identity_sha256: hash(`synthetic:${unit.unit_id}`) });
      }
      const report = { status: "passed", fixture_only: true }, reportPath = path.join(args.outputDir, "report.json"), cohortEventsPath = path.join(args.outputDir, "cohorts.jsonl");
      await fs.writeFile(reportPath, bytes(report)); await fs.writeFile(cohortEventsPath, "");
      return { report, results, reportPath, reportSha256: hash(bytes(report)), cohortEventsPath, cohortEventsSha256: hash("") };
    },
    checkDelivery: async () => ({ status: "passed", fixture_only: true, human_listening_performed: false }),
    checkVoice: async () => ({ status: "passed", fixture_only: true }),
    master: async ({ inputPath, outputPath }) => { await fs.copyFile(inputPath, outputPath); return { status: "passed", fixture_only: true, output_path: outputPath }; },
  });
  await assert.rejects(() => producer({ proofDir, outputDir }), /ENOENT/); assert.equal(calls, 0);
  await fs.writeFile(path.join(proofDir, "attempts/narration/start.json"), bytes({ stage: "narration", identity_sha256: hash(f.identityBytes), automatic_retry_allowed: false }));
  const result = await producer({ proofDir, outputDir });
  assert.equal(calls, 1); assert.equal(result.metadata.tempo, 1); assert.equal(result.metadata.human_listening_performed, false);
  assert.equal(result.artifacts.filter((a) => a.kind === "raw_narration_unit").length, 7);
  for (const artifact of result.artifacts) assert.equal(hash(await fs.readFile(artifact.path)), artifact.sha256);
  const receipt = JSON.parse(await fs.readFile(result.artifacts.find((a) => a.kind === "narration_receipt").path));
  assert.equal(receipt.production_eligible, false); assert.equal(receipt.subjective_approval, null);
  await assert.rejects(() => producer({ proofDir, outputDir }), /EEXIST/); assert.equal(calls, 1);
} finally { await fs.rm(proofDir, { recursive: true, force: true }); }
console.log("true-crime proof narration: compiler, gate, voice locks, cohorts, lossless stitch, guarded invocation and no-resubmission tests passed (synthetic fixtures only)");
