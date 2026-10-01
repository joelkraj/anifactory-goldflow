import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NARRATION_ASR_ORTHOGRAPHY_SCHEMA,
  applyAsrOrthographyReviewForTests,
  asrOrthographyGuardAdmission,
  loadAsrOrthographyReview,
  validateAsrOrthographyReviewForTests,
} from "../lib/narration-asr-orthography-review.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const root = "/tmp/orthography-test";
const source = sha("source");
const identity = sha("identity");
const planFile = sha("plan-file");
const quality = sha("quality");
const reportFile = sha("report-file");
const deliveryFile = sha("delivery-file");
const manifestFile = sha("manifest-file");
const planSha = sha("plan");

function fixture({ intended = "Ironwake. A proper guild.",
  recognized = "Iron Wake, a proper guild.", edge = "opening",
  expectedPhrase = "Ironwake", observedPhrase = "Iron Wake",
  relation = "spacing_join", rootDir = root } = {}) {
  const id = "unit-1";
  const audioPath = `${rootDir}/unit-1.wav`;
  const audio = sha("audio");
  const synthesis = sha("synthesis");
  const text = sha(intended);
  const code = edge === "opening" ? "narration_confirmed_opening_token_mismatch"
    : "narration_confirmed_final_token_mismatch";
  const output = { unit_id: id, attempt: 1, audio_path: audioPath,
    audio_sha256: audio, synthesis_identity_sha256: synthesis };
  const evidence = {
    schema: NARRATION_ASR_ORTHOGRAPHY_SCHEMA,
    status: "reviewed", reviewer_kind: "editorial_text_review",
    human_listening_performed: false,
    authorization_origin: "user_authorized_autonomous_asr_qa",
    reviewer: "Test editor", reviewed_at: "2026-10-01T12:00:00.000Z",
    note: "Exact word-level orthography review based on two retained ASR transcripts, without claiming a listening review.",
    source_script_sha256: source, run_identity_file_sha256: identity,
    narration_generation_plan_sha256: planSha,
    narration_generation_plan_file_sha256: planFile,
    narration_quality_contract_sha256: quality,
    pre_review_narration_report_sha256: reportFile,
    pre_review_unit_delivery_qa_sha256: deliveryFile,
    pre_review_provider_manifest_sha256: manifestFile,
    unit_count: 1,
    units: [{ unit_id: id, edge, expected_phrase: expectedPhrase,
      observed_phrase: observedPhrase, relation,
      audio_path: audioPath, audio_sha256: audio,
      synthesis_identity_sha256: synthesis,
      intended_text_sha256: text, intended_text: intended,
      primary_recognized_text: recognized,
      confirmation_recognized_text: recognized,
      reviewed_blocker_codes: [code],
      review_note: "Both independent ASR passes render one exact spelling alternative; all other words remain aligned." }],
  };
  return {
    evidence,
    priorReport: { schema: "goldflow_narration_tts_report_v1", status: "blocked",
      source_script_hash: source, narration_generation_plan_sha256: planSha,
      narration_generation_plan_file_sha256: planFile,
      provider_output_manifest_sha256: manifestFile,
      results: [{ ...output }], blockers: [{ unit_id: id, code }] },
    priorDelivery: { schema: "goldflow_narration_unit_delivery_qa_v2", status: "blocked",
      source_script_hash: source, narration_generation_plan_sha256: planSha,
      narration_generation_plan_file_sha256: planFile,
      quality_contract_sha256: quality,
      units: [{ unit_id: id, audio_sha256: audio, intended_text_sha256: text,
        intended_text: intended, primary_recognized_text: recognized,
        confirmation_recognized_text: recognized,
        decision: { status: "blocked", blockers: [{ code }] } }] },
    priorManifest: { status: "passed", units: [{ ...output }] },
    currentManifest: { status: "passed", units: [{ ...output }] },
    plan: { plan_sha256: planSha,
      units: [{ unit_id: id, spoken_text: intended, spoken_text_sha256: text }] },
    expected: { sourceScriptSha256: source, identityFileSha256: identity,
      planSha256: planSha, planFileSha256: planFile, qualityContractSha256: quality,
      priorReportFileSha256: reportFile, priorDeliveryFileSha256: deliveryFile,
      priorManifestFileSha256: manifestFile },
    actualAudioHashes: { [id]: audio },
  };
}

for (const options of [
  {},
  { intended: "He went into the hall.", recognized: "He went into the haul.",
    edge: "final", expectedPhrase: "hall", observedPhrase: "haul",
    relation: "reviewed_homophone_spelling" },
  { intended: "Vale sent me.", recognized: "Vail sent me.",
    expectedPhrase: "Vale", observedPhrase: "Vail",
    relation: "reviewed_homophone_spelling" },
  { intended: "An enforcement broker named Harlowe.",
    recognized: "An enforcement broker named Harlow.", edge: "final",
    expectedPhrase: "Harlowe", observedPhrase: "Harlow",
    relation: "reviewed_homophone_spelling" },
]) {
  const input = fixture(options);
  assert.deepEqual(validateAsrOrthographyReviewForTests(input).unit_ids, ["unit-1"]);
  const decision = { status: "blocked", blockers: [{ code: input.evidence.units[0].reviewed_blocker_codes[0] }], warnings: [] };
  const applied = applyAsrOrthographyReviewForTests(decision, input.evidence.units[0], sha("receipt"));
  assert.equal(applied.status, "passed_with_warnings");
  assert.deepEqual(applied.blockers, []);
  assert.deepEqual(decision.blockers.length, 1);
  assert.equal(applied.warnings.at(-1).human_listening_performed, false);
}

for (const mutate of [
  (input) => { input.evidence.human_listening_performed = true; },
  (input) => { input.evidence.units[0].audio_sha256 = sha("other-audio"); },
  (input) => { input.currentManifest.units[0].audio_sha256 = sha("changed-wav"); },
  (input) => { input.evidence.units[0].primary_recognized_text = "Iron Wake. A proper guild."; },
  (input) => { input.evidence.units[0].observed_phrase = "Iron"; },
  (input) => { input.evidence.units[0].expected_phrase = "wake"; },
  (input) => { input.evidence.units[0].reviewed_blocker_codes.push("narration_confirmed_word_omission"); },
  (input) => { input.priorDelivery.units[0].decision.blockers.push({ code: "narration_unsettled_raw_audio_edge" }); },
  (input) => { input.evidence.units[0].primary_recognized_text = "Iron Wake, a proper witch.";
    input.priorDelivery.units[0].primary_recognized_text = "Iron Wake, a proper witch."; },
  (input) => { input.evidence.units[0].confirmation_recognized_text = "Iron Wake, a guild.";
    input.priorDelivery.units[0].confirmation_recognized_text = "Iron Wake, a guild."; },
]) {
  const input = fixture();
  mutate(input);
  assert.throws(() => validateAsrOrthographyReviewForTests(input));
}
assert.throws(() => validateAsrOrthographyReviewForTests(fixture({
  intended: "Venn left.", recognized: "Then left.", expectedPhrase: "Venn",
  observedPhrase: "Then", relation: "reviewed_homophone_spelling",
})));

const evidencePath = `${root}/narration_asr_orthography_review_ep_01.json`;
const command = `node bin/goldflow.mjs tts finalize-provider --episode-dir ${root} --asr-orthography-evidence ${evidencePath}`;
const status = { episode_dir: root, current_stage: "qwen_tts_stitch",
  current_stage_state: "blocked", next_command_shape: command };
const flags = { "episode-dir": root, "asr-orthography-evidence": evidencePath };
assert.equal(asrOrthographyGuardAdmission(status, "tts", "finalize-provider", flags).allowed, true);
assert.equal(asrOrthographyGuardAdmission({ ...status, current_stage: "voice_plan" }, "tts", "finalize-provider", flags).allowed, false);
assert.equal(asrOrthographyGuardAdmission({ ...status, next_command_shape: "tts narrate" }, "tts", "finalize-provider", flags).allowed, false);
assert.equal(asrOrthographyGuardAdmission(status, "tts", "finalize-provider", { ...flags, force: "true" }).allowed, false);
assert.equal(asrOrthographyGuardAdmission(status, "tts", "narrate", flags).applicable, false);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-orthography-"));
try {
  const input = fixture({ rootDir: tempDir });
  const episode = "ep_01";
  const snapshotDir = path.join(tempDir, "snapshots");
  await fs.mkdir(snapshotDir);
  await fs.writeFile(input.evidence.units[0].audio_path, "audio");
  const snapshots = [
    ["provider_manifest", input.priorManifest],
    ["narration_report", input.priorReport],
    ["unit_delivery_qa", input.priorDelivery],
  ];
  for (const [name, data] of snapshots) {
    const target = path.join(snapshotDir, `${name}.json`);
    await fs.writeFile(target, JSON.stringify(data));
    input.evidence[`pre_review_${name}_path`] = target;
    input.evidence[`pre_review_${name}_sha256`] = sha(JSON.stringify(data));
    if (name === "provider_manifest") {
      input.priorReport.provider_output_manifest_sha256 = input.evidence.pre_review_provider_manifest_sha256;
    }
  }
  // The report changed when its manifest binding was updated; persist its final bytes.
  await fs.writeFile(input.evidence.pre_review_narration_report_path,
    JSON.stringify(input.priorReport));
  input.evidence.pre_review_narration_report_sha256 = sha(JSON.stringify(input.priorReport));
  const receiptPath = path.join(tempDir, `narration_asr_orthography_review_${episode}.json`);
  await fs.writeFile(receiptPath, JSON.stringify(input.evidence));
  const request = { episodeDir: tempDir, episode, plan: input.plan,
    identityFileSha256: identity, sourceScriptSha256: source,
    planFileSha256: planFile, qualityContractSha256: quality,
    currentManifest: input.currentManifest };
  const loaded = await loadAsrOrthographyReview(request);
  assert.deepEqual(loaded.unit_ids, ["unit-1"]);
  assert.equal(loaded.provenance.human_listening_performed, false);

  const canonicalReport = path.join(tempDir, `narration_tts_report_${episode}.json`);
  await fs.writeFile(canonicalReport, JSON.stringify(input.priorReport));
  input.evidence.pre_review_narration_report_path = canonicalReport;
  await fs.writeFile(receiptPath, JSON.stringify(input.evidence));
  await assert.rejects(() => loadAsrOrthographyReview(request), /snapshot/);
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

console.log("narration ASR orthography review tests passed");
