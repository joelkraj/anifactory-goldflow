import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalQwenBatchSha256 } from "../lib/qwen-liam-batch-contract.mjs";
import {
  NARRATION_ASR_ORTHOGRAPHY_AMENDMENT_SCHEMA,
  NARRATION_ASR_ORTHOGRAPHY_EXTENSION_SCHEMA,
  NARRATION_ASR_ORTHOGRAPHY_SCHEMA,
  applyAsrOrthographyReviewForTests,
  asrOrthographyGuardAdmission,
  loadAsrOrthographyReview,
  validateAsrOrthographyAmendmentForTests,
  validateAsrOrthographyExtensionForTests,
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

function amendmentFixture(rootDir = root) {
  const base = fixture({ rootDir });
  const unitId = "unit-2";
  const intended = "The ironjaw hit it headfirst.";
  const recognized = "The iron jaw hit it head first.";
  const audioPath = `${rootDir}/unit-2.wav`;
  const runnerPath = `${rootDir}/runner.json`;
  const confirmedPath = `${rootDir}/confirmed.json`;
  const audioSha = sha("second-audio");
  const synthesisSha = sha("second-synthesis");
  const blockerCode = "narration_confirmed_final_token_mismatch";
  const recovery = {
    schema: "goldflow_qwen_exact_unit_recovery_provenance_v1",
    evidence_basis: "reviewed_automated_delivery_qa",
    human_listening_performed: false,
    unit_id: unitId,
    origin_audio_sha256: sha("first-audio"),
    origin_synthesis_identity_sha256: sha("first-synthesis"),
    spoken_text_sha256: sha(intended),
    trigger_codes: ["reviewed_automated_delivery_qa_delivery"],
    confirmed_evidence_path: confirmedPath,
    confirmed_evidence_sha256: sha("confirmed"),
  };
  const output = { unit_id: unitId, attempt: 2, status: "accepted",
    audio_path: audioPath, audio_sha256: audioSha,
    synthesis_identity_sha256: synthesisSha,
    runner_report_path: runnerPath, runner_report_sha256: sha("runner"),
    recovery_provenance: recovery };
  const runnerReport = { status: "passed", results: [{ unit_id: unitId,
    status: "generated", attempt: 2, output_path: audioPath,
    output_sha256: audioSha, synthesis_identity_sha256: synthesisSha,
    spoken_text_sha256: sha(intended), token_limit_reached: false,
    recovery_provenance: recovery }] };
  const predecessor = { evidence_path: `${rootDir}/narration_asr_orthography_review_ep_01.json`,
    evidence_sha256: sha("base-receipt") };
  const evidence = { ...base.evidence,
    schema: NARRATION_ASR_ORTHOGRAPHY_AMENDMENT_SCHEMA,
    predecessor_evidence_path: predecessor.evidence_path,
    predecessor_evidence_sha256: predecessor.evidence_sha256,
    units: [{ unit_id: unitId, selected_attempt: 2,
      edge: "final", expected_phrase: "headfirst", observed_phrase: "head first",
      relation: "spacing_join", joins: [
        { position: "interior", expected_phrase: "ironjaw",
          observed_phrase: "iron jaw", relation: "spacing_join" },
        { position: "final", expected_phrase: "headfirst",
          observed_phrase: "head first", relation: "spacing_join" },
      ], audio_path: audioPath, audio_sha256: audioSha,
      synthesis_identity_sha256: synthesisSha,
      intended_text_sha256: sha(intended), intended_text: intended,
      primary_recognized_text: recognized,
      confirmation_recognized_text: recognized,
      reviewed_blocker_codes: [blockerCode],
      selected_recovery_provenance_sha256: canonicalQwenBatchSha256(recovery),
      runner_report_path: runnerPath, runner_report_sha256: sha("runner"),
      review_note: "Both retained ASR passes differ from locked text by exactly two compound spacing joins." }],
  };
  base.priorManifest.units.push(output);
  base.currentManifest.units.push({ ...output });
  base.priorReport.results.push({ ...output });
  base.priorReport.blockers.push({ unit_id: unitId, code: blockerCode });
  base.priorReport.asr_orthography_review = { evidence_sha256: predecessor.evidence_sha256 };
  base.priorDelivery.units.push({ unit_id: unitId, audio_sha256: audioSha,
    intended_text_sha256: sha(intended), intended_text: intended,
    primary_recognized_text: recognized,
    confirmation_recognized_text: recognized,
    decision: { status: "blocked", blockers: [{ code: blockerCode }] } });
  base.plan.units.push({ unit_id: unitId, spoken_text: intended,
    spoken_text_sha256: sha(intended) });
  base.actualAudioHashes[unitId] = audioSha;
  return { ...base, evidence, predecessor, runnerReport, output, confirmedPath };
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

function extensionFixture({ secondTake = false, possessive = false, rootDir = root } = {}) {
  const input = fixture({ rootDir });
  const id = "unit-2";
  const intended = possessive ? "Sera’s people stood beside me." : "Beren stood beside me.";
  const primary = possessive ? "Sarah's people stood beside me."
    : "Barron stood beside me.";
  const confirmation = possessive ? primary : "Baron stood beside me.";
  const audio = sha(secondTake ? "second-audio" : "first-audio");
  const synthesis = sha("name-synthesis");
  const output = { unit_id: id, status: "accepted", attempt: secondTake ? 2 : 1,
    audio_path: `${rootDir}/${id}.wav`, audio_sha256: audio,
    synthesis_identity_sha256: synthesis };
  if (secondTake) output.recovery_provenance = {
    schema: "goldflow_qwen_exact_unit_recovery_provenance_v1",
    evidence_basis: "reviewed_automated_delivery_qa",
    human_listening_performed: false, unit_id: id,
    spoken_text_sha256: sha(intended), origin_audio_sha256: sha("origin"),
  };
  const predecessor = { evidence_path: `${rootDir}/narration_asr_orthography_review_ep_01.json`,
    evidence_sha256: sha("predecessor"), rows_by_id: new Map([["unit-1", {}]]) };
  const code = "narration_confirmed_opening_token_mismatch";
  input.priorReport.asr_orthography_review = { evidence_sha256: predecessor.evidence_sha256 };
  input.priorReport.results.push({ ...output });
  input.priorReport.blockers.push({ unit_id: id, code });
  input.priorDelivery.units.push({ unit_id: id, audio_sha256: audio,
    intended_text: intended, intended_text_sha256: sha(intended),
    primary_recognized_text: primary, confirmation_recognized_text: confirmation,
    edge_alignment: { status: "passed" },
    decision: { status: "blocked", blockers: [{ code }] } });
  input.priorManifest.units.push({ ...output });
  input.currentManifest.units.push({ ...output });
  input.plan.units.push({ unit_id: id, spoken_text: intended,
    spoken_text_sha256: sha(intended) });
  input.actualAudioHashes[id] = audio;
  input.evidence = {
    ...input.evidence,
    schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_SCHEMA,
    predecessor_evidence_path: predecessor.evidence_path,
    predecessor_evidence_sha256: predecessor.evidence_sha256,
    units: [{ unit_id: id, selected_attempt: output.attempt,
      edge: "opening", relation: "reviewed_dual_asr_phonetic_spelling",
      expected_phrase: possessive ? "Sera’s" : "Beren",
      observed_phrase: possessive ? "Sarah's" : "Barron",
      primary_observed_phrase: possessive ? "Sarah's" : "Barron",
      confirmation_observed_phrase: possessive ? "Sarah's" : "Baron",
      audio_path: output.audio_path, audio_sha256: audio,
      synthesis_identity_sha256: synthesis,
      intended_text: intended, intended_text_sha256: sha(intended),
      primary_recognized_text: primary, confirmation_recognized_text: confirmation,
      reviewed_blocker_codes: [code],
      ...(secondTake ? { selected_recovery_provenance_sha256:
        canonicalQwenBatchSha256(output.recovery_provenance) } : {}),
      review_note: "Both retained recognitions differ solely in their phonetic spelling of the opening character name." }],
  };
  return { ...input, predecessor };
}

for (const secondTake of [false, true]) {
  const input = extensionFixture({ secondTake });
  assert.deepEqual(validateAsrOrthographyExtensionForTests(input).unit_ids, ["unit-2"]);
  const applied = applyAsrOrthographyReviewForTests({ status: "blocked",
    blockers: [{ code: "narration_confirmed_opening_token_mismatch" }],
    warnings: [] }, input.evidence.units[0], sha("extension"));
  assert.equal(applied.status, "passed_with_warnings");
  assert.equal(applied.warnings.at(-1).confirmation_observed_phrase, "Baron");
}
assert.deepEqual(validateAsrOrthographyExtensionForTests(
  extensionFixture({ possessive: true })).unit_ids, ["unit-2"]);
for (const mutate of [
  (input) => { input.evidence.predecessor_evidence_sha256 = sha("other"); },
  (input) => { input.evidence.units[0].confirmation_observed_phrase = "Then"; },
  (input) => { input.priorDelivery.units[1].decision.blockers.push(
    { code: "narration_unsettled_raw_audio_edge" }); },
  (input) => { input.priorDelivery.units[1].edge_alignment.status = "missing"; },
  (input) => { input.evidence.units[0].primary_recognized_text += " twice";
    input.priorDelivery.units[1].primary_recognized_text += " twice"; },
  (input) => { input.currentManifest.units[1].audio_sha256 = sha("changed"); },
  (input) => { input.evidence.units[0].unit_id = "unit-1"; },
]) {
  const input = extensionFixture();
  mutate(input);
  assert.throws(() => validateAsrOrthographyExtensionForTests(input));
}

{
  const input = amendmentFixture();
  assert.deepEqual(validateAsrOrthographyAmendmentForTests(input).unit_ids, ["unit-2"]);
  const decision = { status: "blocked", blockers: [
    { code: "narration_confirmed_final_token_mismatch" }], warnings: [] };
  const applied = applyAsrOrthographyReviewForTests(decision,
    input.evidence.units[0], sha("amendment"));
  assert.equal(applied.status, "passed_with_warnings");
  assert.equal(applied.warnings.at(-1).reviewed_spacing_joins.length, 2);
}
for (const mutate of [
  (input) => { input.evidence.units[0].joins.pop(); },
  (input) => { input.evidence.units[0].joins[0].observed_phrase = "iron jaw hit"; },
  (input) => { input.evidence.units[0].primary_recognized_text =
    "The iron jaw hit it head first twice.";
    input.priorDelivery.units[1].primary_recognized_text =
      input.evidence.units[0].primary_recognized_text; },
  (input) => { input.evidence.units[0].selected_attempt = 1; },
  (input) => { input.evidence.units[0].selected_recovery_provenance_sha256 = sha("stale"); },
  (input) => { input.evidence.predecessor_evidence_sha256 = sha("stale"); },
  (input) => { input.priorDelivery.units[1].decision.blockers.push(
    { code: "narration_confirmed_word_omission" }); },
  (input) => { input.currentManifest.units[1].audio_sha256 = sha("changed"); },
  (input) => { input.runnerReport.results[0].output_sha256 = sha("changed"); },
]) {
  const input = amendmentFixture();
  mutate(input);
  assert.throws(() => validateAsrOrthographyAmendmentForTests(input));
}

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

  const amended = amendmentFixture(tempDir);
  amended.predecessor.evidence_sha256 = sha(JSON.stringify(input.evidence));
  amended.evidence.predecessor_evidence_sha256 = amended.predecessor.evidence_sha256;
  amended.priorReport.asr_orthography_review.evidence_sha256 = amended.predecessor.evidence_sha256;
  await fs.writeFile(amended.evidence.units[0].audio_path, "second-audio");
  await fs.writeFile(amended.confirmedPath, "confirmed");
  await fs.writeFile(amended.evidence.units[0].runner_report_path,
    JSON.stringify(amended.runnerReport));
  const runnerSha = sha(JSON.stringify(amended.runnerReport));
  amended.evidence.units[0].runner_report_sha256 = runnerSha;
  amended.priorManifest.units[1].runner_report_sha256 = runnerSha;
  amended.currentManifest.units[1].runner_report_sha256 = runnerSha;
  const amendmentDir = path.join(tempDir, "amendment-snapshots");
  await fs.mkdir(amendmentDir);
  for (const [name, data] of [
    ["provider_manifest", amended.priorManifest],
    ["unit_delivery_qa", amended.priorDelivery],
  ]) {
    const target = path.join(amendmentDir, `${name}.json`);
    await fs.writeFile(target, JSON.stringify(data));
    amended.evidence[`pre_review_${name}_path`] = target;
    amended.evidence[`pre_review_${name}_sha256`] = sha(JSON.stringify(data));
  }
  amended.priorReport.provider_output_manifest_sha256 =
    amended.evidence.pre_review_provider_manifest_sha256;
  const reportSnapshot = path.join(amendmentDir, "narration_report.json");
  await fs.writeFile(reportSnapshot, JSON.stringify(amended.priorReport));
  amended.evidence.pre_review_narration_report_path = reportSnapshot;
  amended.evidence.pre_review_narration_report_sha256 =
    sha(JSON.stringify(amended.priorReport));
  const amendmentPath = path.join(tempDir,
    `narration_asr_orthography_review_${episode}_v2.json`);
  await fs.writeFile(amendmentPath, JSON.stringify(amended.evidence));
  const amendmentRequest = { ...request, currentManifest: amended.currentManifest,
    plan: amended.plan };
  const loadedAmendment = await loadAsrOrthographyReview(amendmentRequest);
  assert.deepEqual(loadedAmendment.unit_ids, ["unit-1", "unit-2"]);
  assert.equal(loadedAmendment.evidence_path, amendmentPath);
  assert.equal(loadedAmendment.provenance.predecessor_evidence_sha256,
    amended.predecessor.evidence_sha256);
  assert.equal(loadedAmendment.rows_by_id.get("unit-2").joins.length, 2);
  await fs.writeFile(amended.evidence.units[0].runner_report_path, "changed-runner");
  await assert.rejects(() => loadAsrOrthographyReview(amendmentRequest), /hash-stale/);
  await fs.writeFile(amended.evidence.units[0].runner_report_path,
    JSON.stringify(amended.runnerReport));

  const canonicalReport = path.join(tempDir, `narration_tts_report_${episode}.json`);
  await fs.writeFile(canonicalReport, JSON.stringify(input.priorReport));
  input.evidence.pre_review_narration_report_path = canonicalReport;
  await fs.writeFile(receiptPath, JSON.stringify(input.evidence));
  await assert.rejects(() => loadAsrOrthographyReview(request), /snapshot/);
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-orthography-extension-"));
try {
  const episode = "ep_01";
  const input = extensionFixture({ rootDir: extensionDir });
  const base = fixture({ rootDir: extensionDir });
  await fs.writeFile(base.evidence.units[0].audio_path, "audio");
  await fs.writeFile(input.evidence.units[0].audio_path, "first-audio");
  const baseSnapshotDir = path.join(extensionDir, "base-snapshots");
  await fs.mkdir(baseSnapshotDir);
  for (const [name, value] of [
    ["provider_manifest", base.priorManifest],
    ["unit_delivery_qa", base.priorDelivery],
  ]) {
    const target = path.join(baseSnapshotDir, `${name}.json`);
    await fs.writeFile(target, JSON.stringify(value));
    base.evidence[`pre_review_${name}_path`] = target;
    base.evidence[`pre_review_${name}_sha256`] = sha(JSON.stringify(value));
  }
  base.priorReport.provider_output_manifest_sha256 =
    base.evidence.pre_review_provider_manifest_sha256;
  const baseReportPath = path.join(baseSnapshotDir, "narration_report.json");
  await fs.writeFile(baseReportPath, JSON.stringify(base.priorReport));
  base.evidence.pre_review_narration_report_path = baseReportPath;
  base.evidence.pre_review_narration_report_sha256 = sha(JSON.stringify(base.priorReport));
  const basePath = path.join(extensionDir,
    `narration_asr_orthography_review_${episode}.json`);
  await fs.writeFile(basePath, JSON.stringify(base.evidence));
  input.evidence.predecessor_evidence_path = basePath;
  input.evidence.predecessor_evidence_sha256 = sha(JSON.stringify(base.evidence));
  input.priorReport.asr_orthography_review.evidence_sha256 =
    input.evidence.predecessor_evidence_sha256;

  const extensionSnapshotDir = path.join(extensionDir, "extension-snapshots");
  await fs.mkdir(extensionSnapshotDir);
  for (const [name, value] of [
    ["provider_manifest", input.priorManifest],
    ["unit_delivery_qa", input.priorDelivery],
  ]) {
    const target = path.join(extensionSnapshotDir, `${name}.json`);
    await fs.writeFile(target, JSON.stringify(value));
    input.evidence[`pre_review_${name}_path`] = target;
    input.evidence[`pre_review_${name}_sha256`] = sha(JSON.stringify(value));
  }
  input.priorReport.provider_output_manifest_sha256 =
    input.evidence.pre_review_provider_manifest_sha256;
  const extensionReportPath = path.join(extensionSnapshotDir, "narration_report.json");
  await fs.writeFile(extensionReportPath, JSON.stringify(input.priorReport));
  input.evidence.pre_review_narration_report_path = extensionReportPath;
  input.evidence.pre_review_narration_report_sha256 = sha(JSON.stringify(input.priorReport));
  const extensionPath = path.join(extensionDir,
    `narration_asr_orthography_extension_${episode}.json`);
  await fs.writeFile(extensionPath, JSON.stringify(input.evidence));
  const request = { episodeDir: extensionDir, episode, plan: input.plan,
    identityFileSha256: identity, sourceScriptSha256: source,
    planFileSha256: planFile, qualityContractSha256: quality,
    currentManifest: input.currentManifest };
  const loaded = await loadAsrOrthographyReview(request);
  assert.deepEqual(loaded.unit_ids, ["unit-1", "unit-2"]);
  assert.equal(loaded.evidence_path, extensionPath);
  assert.equal(loaded.provenance.human_listening_performed, false);
  await fs.writeFile(input.evidence.units[0].audio_path, "changed-audio");
  await assert.rejects(() => loadAsrOrthographyReview(request),
    /stale|non-exact/);
} finally {
  await fs.rm(extensionDir, { recursive: true, force: true });
}

console.log("narration ASR orthography review tests passed");
