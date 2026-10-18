import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APPEND_ONLY_TAIL_SCHEMA, appendOnlySilentTailForTests,
  appendOnlyTailGuardAdmission, pcm16MonoWavFactsForTests,
  validateAppendOnlyTailScopeForTests, verifyAppendOnlyTailLineage,
  verifyAppendOnlyTailSelection,
} from "../lib/narration-append-only-tail.mjs";
import { narrationProviderOutputManifestSha256,
  narrationSynthesisIdentitySha256 } from "../lib/narration-provider-adapter.mjs";
import { canonicalQwenBatchSha256 } from "../lib/qwen-liam-batch-contract.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ep = "/tmp/goldflow-append-tail-test";
const selectedId = "unit-edge", heldId = "unit-held";
function wav(samples) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0); out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(24000, 24); out.writeUInt32LE(48000, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, index) => out.writeInt16LE(value, 44 + index * 2));
  return out;
}
function fixture() {
  const raw = wav(Array.from({ length: 24000 }, (_, i) =>
    i < 1000 ? 0 : Math.round(100 * Math.sin(i / 15))));
  const facts = pcm16MonoWavFactsForTests(raw);
  const audio = sha(raw), text = "Come outside.", source = sha("source"),
    planSha = sha("plan"), planFile = sha("plan file"),
    identity = sha("identity"), reportSha = sha("report"),
    deliverySha = sha("delivery"), manifestSha = sha("manifest");
  const audioPath = `${ep}/edge.wav`;
  const selected = { unit_id: selectedId, status: "accepted",
    provider: "qwen_local", model_id: "fixture-model", model_revision: "fixture-revision",
    voice_id: "fixture-voice", voice_sha256: sha("fixture voice"),
    voice_continuity_contract: "fixture_owned_clone",
    audio_path: audioPath, audio_sha256: audio,
    synthesis_identity_sha256: sha("source identity"),
    token_limit_reached: false, attempt: 1,
    generated_token_count: 19, spoken_text_sha256: sha(text) };
  const held = { ...selected, unit_id: heldId,
    audio_path: `${ep}/held.wav`, audio_sha256: sha("held") };
  const report = { status: "blocked", source_script_hash: source,
    narration_generation_plan_sha256: planSha,
    provider_output_manifest_sha256: manifestSha,
    full_stream_qa_status: "not_run_due_to_unit_blockers",
    blockers: [{ unit_id: selectedId, code: "narration_unsettled_raw_audio_edge" },
      { unit_id: heldId, code: "narration_confirmed_final_token_mismatch" }] };
  const delivery = { status: "blocked", blockers: structuredClone(report.blockers),
    units: [{ unit_id: selectedId, audio_sha256: audio,
      primary_recognized_text: text,
      edge_alignment: { status: "passed" },
      acoustic_qa: { metrics: { sample_count: facts.sample_count,
        last_sample_dbfs: Number(facts.last_sample_dbfs.toFixed(3)),
        tail_50ms_rms_dbfs: Number(facts.tail_50ms_rms_dbfs.toFixed(3)),
        clipping_sample_count: 0, trailing_silence_sec: 0 }, findings: [] },
      decision: { status: "blocked", blockers: [{
        code: "narration_unsettled_raw_audio_edge",
        source_code: "tts_audio_tail_not_settled" }] } }] };
  const plan = { source_script_hash: source, plan_sha256: planSha,
    units: [{ unit_id: selectedId, spoken_text: text,
      spoken_text_sha256: sha(text) }] };
  const manifest = { status: "passed", provider: "qwen_local",
    units: [selected, held] };
  const hashes = { identity, plan: planFile, report: reportSha,
    delivery: deliverySha, manifest: manifestSha };
  const evidence = {
    schema: APPEND_ONLY_TAIL_SCHEMA, status: "reviewed_automated_evidence",
    human_listening_performed: false, audio_synthesis_authorized: false,
    method: "append_zero_pcm16_samples_only", episode_dir: ep,
    source_script_sha256: source,
    narration_generation_plan_sha256: planSha,
    narration_generation_plan_file_sha256: planFile,
    run_identity_file_sha256: identity,
    prior_report_file_sha256: reportSha,
    prior_delivery_file_sha256: deliverySha,
    prior_manifest_file_sha256: manifestSha,
    blocked_unit_ids: [selectedId, heldId],
    preserved_blocked_unit_ids: [heldId], units: [{
      unit_id: selectedId, spoken_text_sha256: sha(text),
      source_audio_path: audioPath, source_audio_sha256: audio,
      source_synthesis_identity_sha256: selected.synthesis_identity_sha256,
      pad_sample_count: 5760,
      medium_asr: { contract: { engine: "faster_whisper",
        model: "medium", device: "cpu", compute_type: "int8_float32",
        beam_size: 5, vad_filter: false, word_timestamps: true },
      recognized_text: text,
      recognized_words: [{ word: "outside.", start_sec: 0.7,
        end_sec: 0.98, probability: 0.99 }] },
      review_note: "Both ASR models heard the intact final word; only a low-energy unsettled tail remains." }] };
  return { raw, facts, audioPath, selected, held, report, delivery,
    plan, manifest, hashes, evidence };
}

const f = fixture();
const extended = appendOnlySilentTailForTests(f.raw, 5760);
assert.deepEqual(extended.subarray(44, f.raw.length), f.raw.subarray(44));
assert.equal(extended.subarray(f.raw.length).every((value) => value === 0), true);
assert.equal(pcm16MonoWavFactsForTests(extended).sample_count,
  f.facts.sample_count + 5760);
assert.throws(() => appendOnlySilentTailForTests(f.raw, 100));
const altered = Buffer.from(f.raw); altered.writeUInt16LE(2, 22);
assert.throws(() => pcm16MonoWavFactsForTests(altered));

const args = { evidence: f.evidence, episodeDir: ep, report: f.report,
  delivery: f.delivery, manifest: f.manifest, plan: f.plan,
  hashes: f.hashes, audioFacts: { [selectedId]: f.facts } };
assert.deepEqual(validateAppendOnlyTailScopeForTests(args).preserved_blocked_unit_ids,
  [heldId]);
assert.throws(() => validateAppendOnlyTailScopeForTests({ ...args,
  evidence: { ...f.evidence, human_listening_performed: true } }));
assert.throws(() => validateAppendOnlyTailScopeForTests({ ...args,
  evidence: { ...f.evidence, preserved_blocked_unit_ids: [] } }));
assert.throws(() => validateAppendOnlyTailScopeForTests({ ...args,
  audioFacts: { [selectedId]: { ...f.facts, last_sample_dbfs: -12 } } }));
assert.throws(() => validateAppendOnlyTailScopeForTests({ ...args,
  evidence: { ...f.evidence, units: [{ ...f.evidence.units[0],
    medium_asr: { ...f.evidence.units[0].medium_asr,
      recognized_text: "Come out." } }] } }));

const admittedStatus = { episode_dir: ep, current_stage: "qwen_tts_stitch",
  current_stage_state: "blocked",
  next_command_shape: `node bin/goldflow.mjs tts complete-tail --episode-dir ${ep} --evidence ${ep}/review.json` };
assert.equal(appendOnlyTailGuardAdmission(admittedStatus, "tts", "complete-tail",
  { "episode-dir": ep, evidence: `${ep}/review.json` }).allowed, true);
assert.equal(appendOnlyTailGuardAdmission(admittedStatus, "tts", "complete-tail",
  { "episode-dir": ep, evidence: `${ep}/other.json` }).allowed, false);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-append-tail-"));
try {
  const dir = path.join(tmp, "episode"); await fs.mkdir(dir);
  const oldPath = path.join(dir, "edge.wav");
  const newPath = path.join(dir, "edge-padded.wav");
  const heldPath = path.join(dir, "held.wav");
  await fs.writeFile(oldPath, f.raw);
  await fs.writeFile(newPath, extended);
  await fs.writeFile(heldPath, wav([0, 1]));
  const prior = { units: [{ ...f.selected, audio_path: oldPath },
    { ...f.held, audio_path: heldPath, audio_sha256: sha(await fs.readFile(heldPath)) }] };
  const parent = path.join(dir, "completion");await fs.mkdir(parent);
  const toJson = async (name, value) => {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    await fs.writeFile(path.join(parent, name), bytes);
    return sha(bytes);
  };
  const priorSha = await toJson("prior_manifest.json", prior);
  const priorReportSha = await toJson("prior_report.json", f.report);
  const priorDeliverySha = await toJson("prior_delivery.json", f.delivery);
  const savedEvidence = { ...f.evidence,
    prior_manifest_file_sha256: priorSha,
    prior_report_file_sha256: priorReportSha,
    prior_delivery_file_sha256: priorDeliverySha };
  const evidenceSha = await toJson("evidence.json", savedEvidence);
  const request = { schema: "goldflow_narration_append_only_tail_request_v1",
    episode_dir: dir, evidence_path: path.join(parent, "evidence.json"),
    evidence_file_sha256: evidenceSha, unit_ids: [selectedId],
    preserved_blocked_unit_ids: [heldId], plan_sha256: f.plan.plan_sha256,
    source_script_sha256: f.report.source_script_hash,
    prior_manifest_file_sha256: priorSha,
    prior_report_file_sha256: priorReportSha,
    prior_delivery_file_sha256: priorDeliverySha };
  const requestSha = await toJson("request.json", request);
  const result = { schema: "goldflow_narration_append_only_tail_result_v1",
    status: "passed", request_path: path.join(parent, "request.json"),
    request_file_sha256: requestSha, preserved_blocked_unit_ids: [heldId],
    preserved_unit_count: 1,
    units: [{ unit_id: selectedId, source_audio_path: oldPath,
      source_audio_sha256: f.selected.audio_sha256,
      output_audio_path: newPath, output_audio_sha256: sha(extended),
      source_sample_count: f.facts.sample_count,
      output_sample_count: f.facts.sample_count + 5760,
      pad_sample_count: 5760 }] };
  const resultSha = await toJson("result.json", result);
  const identity = { schema: "goldflow_narration_append_only_tail_identity_v1",
    provider: prior.units[0].provider, model_id: prior.units[0].model_id,
    model_revision: prior.units[0].model_revision,
    voice_id: prior.units[0].voice_id,
    voice_sha256: prior.units[0].voice_sha256,
    voice_continuity_contract: prior.units[0].voice_continuity_contract,
    unit_id: selectedId, spoken_text_sha256: prior.units[0].spoken_text_sha256,
    source_synthesis_identity_sha256: f.selected.synthesis_identity_sha256,
    source_audio_sha256: f.selected.audio_sha256,
    output_audio_sha256: sha(extended), pad_sample_count: 5760,
    request_file_sha256: requestSha };
  const candidate = { units: [{ ...prior.units[0], audio_path: newPath,
    audio_sha256: sha(extended), duration_sec: (f.facts.sample_count + 5760) / 24000,
    synthesis_mode: "exact_append_only_silence_tail_v1",
    synthesis_identity: identity,
    synthesis_identity_sha256: narrationSynthesisIdentitySha256(identity),
    recovery_provenance: {
      schema: "goldflow_narration_append_only_tail_provenance_v1",
      request_path: path.join(parent, "request.json"),
      request_file_sha256: requestSha,
      result_path: path.join(parent, "result.json"),
      result_file_sha256: resultSha,
      source_audio_sha256: f.selected.audio_sha256,
      source_synthesis_identity_sha256: f.selected.synthesis_identity_sha256,
      pad_sample_count: 5760, human_listening_performed: false,
      audio_synthesis_performed: false },
    runner_report_path: path.join(parent, "result.json"),
    runner_report_sha256: resultSha,
    provider_receipt: null,
    provider_unit_qa: null, provider_unit_qa_sha256: null }, prior.units[1]],
    repair_history: [{ mode: "exact_append_only_silence_tail_v1",
      request_path: path.join(parent, "request.json"), request_file_sha256: requestSha,
      result_path: path.join(parent, "result.json"), result_file_sha256: resultSha,
      evidence_path: path.join(parent, "evidence.json"), evidence_file_sha256: evidenceSha,
      prior_manifest_file_sha256: priorSha,
      output_manifest_path: path.join(parent, "provider-output-manifest.json") }] };
  await verifyAppendOnlyTailSelection({ episodeDir: dir, report: f.report,
    manifest: candidate, plan: f.plan,
    expectedManifestPath: path.join(parent, "provider-output-manifest.json") });
  const tailManifest = { ...candidate, status: "passed" };
  tailManifest.manifest_sha256 = narrationProviderOutputManifestSha256(tailManifest);
  const tailPath = path.join(parent, "provider-output-manifest.json");
  const tailBytes = Buffer.from(`${JSON.stringify(tailManifest, null, 2)}\n`);
  await fs.writeFile(tailPath, tailBytes);
  const requestPayload = { prior_manifest_path: tailPath,
    prior_manifest_sha256: tailManifest.manifest_sha256,
    prior_manifest_file_sha256: sha(tailBytes),
    units: [{ unit_id: heldId }] };
  const boundaryHash = canonicalQwenBatchSha256(requestPayload);
  const boundaryDir = path.join(dir, "assets/audio/narration_tts/exact_boundary_repairs",
    boundaryHash);
  await fs.mkdir(boundaryDir, { recursive: true });
  await fs.writeFile(path.join(boundaryDir, "request.json"),
    `${JSON.stringify({ ...requestPayload, request_sha256: boundaryHash }, null, 2)}\n`);
  const boundaryRecord = { mode: "exact_sentence_boundary_composite_v1",
    prior_manifest_sha256: tailManifest.manifest_sha256,
    request_sha256: boundaryHash };
  const descendant = { ...tailManifest,
    units: [tailManifest.units[0], { ...tailManifest.units[1],
      audio_sha256: sha("new held audio") }],
    repair_history: [...tailManifest.repair_history, boundaryRecord] };
  descendant.manifest_sha256 = narrationProviderOutputManifestSha256(descendant);
  const descendantPath = path.join(boundaryDir, "provider-output-manifest.json");
  let descendantBytes = Buffer.from(`${JSON.stringify(descendant, null, 2)}\n`);
  await fs.writeFile(descendantPath, descendantBytes);
  const descendantReport = { ...f.report,
    provider_output_manifest_sha256: sha(descendantBytes) };
  assert.deepEqual((await verifyAppendOnlyTailLineage({ episodeDir: dir,
    report: descendantReport, manifest: descendant, plan: f.plan,
    expectedManifestPath: descendantPath })).repaired_unit_ids, [selectedId]);
  const corrupted = structuredClone(descendant);
  corrupted.units[0].audio_sha256 = sha("changed tail audio");
  corrupted.manifest_sha256 = narrationProviderOutputManifestSha256(corrupted);
  descendantBytes = Buffer.from(`${JSON.stringify(corrupted, null, 2)}\n`);
  await fs.writeFile(descendantPath, descendantBytes);
  await assert.rejects(verifyAppendOnlyTailLineage({ episodeDir: dir,
    report: { ...descendantReport,
      provider_output_manifest_sha256: sha(descendantBytes) },
    manifest: corrupted, plan: f.plan, expectedManifestPath: descendantPath }),
  /changed unrequested/);
  candidate.units[1].audio_sha256 = sha("tampered");
  await assert.rejects(verifyAppendOnlyTailSelection({ episodeDir: dir,
    report: f.report, manifest: candidate, plan: f.plan }));
} finally { await fs.rm(tmp, { recursive: true, force: true }); }

console.log("narration append-only tail tests passed");
