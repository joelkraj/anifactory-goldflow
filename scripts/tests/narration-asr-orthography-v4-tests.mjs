import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V3_SCHEMA,
  NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V4_SCHEMA,
  applyAsrOrthographyReviewForTests,
  validateAsrOrthographyExtensionV4ForTests,
} from "../lib/narration-asr-orthography-review.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const ids = ["sera-unit", "beren-unit", "held-unit"];
const texts = [
  "Sera had the bodies searched. The officer carried a ring.",
  "Beren was arguing with a delivery man about where the training posts should go.",
];
const primary = [
  "Sarah had the bodies. Searched, the officer carried a ring.",
  "Barram was arguing with a delivery man about where the training posts. Should go.",
];
const medium = [
  primary[0],
  "Barron was arguing with a delivery man about where the training posts. Should go.",
];
const code = "narration_confirmed_opening_token_mismatch";
const expected = {
  sourceScriptSha256: sha("source"), identityFileSha256: sha("identity"),
  planSha256: sha("plan"), planFileSha256: sha("plan file"),
  qualityContractSha256: sha("quality"),
  priorReportFileSha256: sha("report"),
  priorDeliveryFileSha256: sha("delivery"),
  priorManifestFileSha256: sha("manifest"),
};
const predecessor = {
  evidence_path: "/tmp/v3.json", evidence_sha256: sha("v3"),
  provenance: { schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V3_SCHEMA },
  rows_by_id: new Map([
    ["old-sera", { spans: [{ relation: "reviewed_dual_asr_proper_name_spelling",
      expected_phrase: "Sera", primary_observed_phrase: "Sarah",
      confirmation_observed_phrase: "Sarah" }] }],
    ["old-beren", { spans: [{ relation: "reviewed_dual_asr_proper_name_spelling",
      expected_phrase: "Beren", primary_observed_phrase: "Baron",
      confirmation_observed_phrase: "Barron" }] }],
  ]),
};
const fragment = { text_sha256: sha("Beren was arguing with a delivery man"),
  audio_sha256: sha("fragment audio"), sidecar_sha256: sha("sidecar") };
const outputs = ids.slice(0, 2).map((id, index) => ({
  unit_id: id, status: "accepted", attempt: 1,
  audio_path: `/tmp/ep/${id}.wav`, audio_sha256: sha(`${id} audio`),
  synthesis_identity_sha256: sha(`${id} identity`),
  ...(index === 1 ? { synthesis_identity: { fragments: [fragment] },
    recovery_provenance: { request_path: "/tmp/ep/request.json",
      result_path: "/tmp/ep/result.json" } } : {}),
}));
const report = { status: "blocked", source_script_hash: expected.sourceScriptSha256,
  narration_generation_plan_sha256: expected.planSha256,
  narration_generation_plan_file_sha256: expected.planFileSha256,
  provider_output_manifest_sha256: expected.priorManifestFileSha256,
  asr_orthography_review: { evidence_sha256: predecessor.evidence_sha256 },
  results: outputs, blockers: ids.map((unit_id) => ({ unit_id, code })) };
const delivery = { status: "blocked",
  blockers: structuredClone(report.blockers),
  units: ids.slice(0, 2).map((unit_id, index) => ({
    unit_id, audio_sha256: outputs[index].audio_sha256,
    intended_text: texts[index], intended_text_sha256: sha(texts[index]),
    primary_recognized_text: primary[index],
    confirmation_recognized_text: medium[index],
    edge_alignment: { status: "passed" },
    decision: { status: "blocked", blockers: [{ code }] },
  })) };
const plan = { plan_sha256: expected.planSha256,
  units: ids.slice(0, 2).map((unit_id, index) => ({ unit_id,
    spoken_text: texts[index], spoken_text_sha256: sha(texts[index]) })) };
const manifest = { status: "passed", units: outputs };
const contract = (model) => ({ model, device: "cpu", compute_type: "int8_float32",
  language: "en", beam_size: 5, word_timestamps: true, vad_filter: false });
const diagnostic = {
  schema: "goldflow_narration_fragment_name_context_asr_diagnostic_v1",
  status: "observed", human_listening_performed: false,
  diagnostic_origin: "read_only_local_faster_whisper_dual_asr",
  unit_id: ids[1], fragment_index: 0,
  source_script_sha256: expected.sourceScriptSha256,
  narration_generation_plan_sha256: expected.planSha256,
  composite_manifest_sha256: expected.priorManifestFileSha256,
  source_text: "Beren was arguing with a delivery man",
  source_text_sha256: fragment.text_sha256,
  fragment_audio_sha256: fragment.audio_sha256,
  fragment_sidecar_sha256: fragment.sidecar_sha256,
  repair_request_path: outputs[1].recovery_provenance.request_path,
  repair_result_path: outputs[1].recovery_provenance.result_path,
  small: { contract: contract("small.en"),
    recognized_text: "Baron was arguing with a delivery man",
    duration_sec: 3.2 },
  medium: { contract: contract("medium"),
    recognized_text: "Barron was arguing with a delivery man",
    duration_sec: 3.2 },
};
const diagnosticPath = "/tmp/ep/fragment-diagnostic.json";
const evidence = {
  schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V4_SCHEMA,
  status: "reviewed", reviewer_kind: "editorial_text_review",
  human_listening_performed: false,
  authorization_origin: "user_authorized_autonomous_asr_qa",
  reviewer: "Test editor", reviewed_at: "2026-10-01T22:00:00Z",
  note: "Exact proper-name text review with one independently retained opening-fragment dual-ASR diagnostic and no listening claim.",
  predecessor_evidence_path: predecessor.evidence_path,
  predecessor_evidence_sha256: predecessor.evidence_sha256,
  source_script_sha256: expected.sourceScriptSha256,
  run_identity_file_sha256: expected.identityFileSha256,
  narration_generation_plan_sha256: expected.planSha256,
  narration_generation_plan_file_sha256: expected.planFileSha256,
  narration_quality_contract_sha256: expected.qualityContractSha256,
  pre_review_narration_report_sha256: expected.priorReportFileSha256,
  pre_review_unit_delivery_qa_sha256: expected.priorDeliveryFileSha256,
  pre_review_provider_manifest_sha256: expected.priorManifestFileSha256,
  unit_count: 2, preserved_blocked_unit_ids: [ids[2]],
  units: ids.slice(0, 2).map((unit_id, index) => ({
    unit_id, review_schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V4_SCHEMA,
    review_method: index === 0 ? "dual_full_unit_name_spelling"
      : "fragment_context_name_spelling",
    selected_attempt: 1, audio_path: outputs[index].audio_path,
    audio_sha256: outputs[index].audio_sha256,
    synthesis_identity_sha256: outputs[index].synthesis_identity_sha256,
    intended_text: texts[index], intended_text_sha256: sha(texts[index]),
    primary_recognized_text: primary[index],
    confirmation_recognized_text: medium[index],
    reviewed_blocker_codes: [code],
    spans: [{ position: "opening", relation: "reviewed_dual_asr_proper_name_spelling",
      expected_phrase: index === 0 ? "Sera" : "Beren",
      primary_observed_phrase: index === 0 ? "Sarah" : "Barram",
      confirmation_observed_phrase: index === 0 ? "Sarah" : "Barron" }],
    ...(index === 1 ? { fragment_context_evidence_path: diagnosticPath,
      fragment_context_evidence_sha256: sha("diagnostic") } : {}),
    review_note: "All other lexical source words align in both models; selected audio stays unchanged and no human listening is claimed.",
  })),
};
const fragmentDiagnostics = { [ids[1]]: { path: diagnosticPath,
  sha256: sha("diagnostic"), diagnostic,
  audioHash: fragment.audio_sha256, sidecarHash: fragment.sidecar_sha256,
  sidecar: { text: diagnostic.source_text, sample_count: 76800 } } };
const args = { evidence, predecessor, priorReport: report,
  priorDelivery: delivery, priorManifest: manifest,
  currentManifest: manifest, plan, expected,
  actualAudioHashes: Object.fromEntries(outputs.map((row) =>
    [row.unit_id, row.audio_sha256])), fragmentDiagnostics };
assert.deepEqual(validateAsrOrthographyExtensionV4ForTests(args).unit_ids,
  ids.slice(0, 2));
assert.equal(applyAsrOrthographyReviewForTests(delivery.units[1].decision,
  evidence.units[1], sha("v4")).status, "passed_with_warnings");
const changed = (mutate) => {
  const copy = structuredClone(evidence);
  mutate(copy);
  return { ...args, evidence: copy };
};
assert.throws(() => validateAsrOrthographyExtensionV4ForTests(changed((x) => {
  x.preserved_blocked_unit_ids = [];
})));
assert.throws(() => validateAsrOrthographyExtensionV4ForTests(changed((x) => {
  x.units[0].confirmation_recognized_text = "Sarah had the body searched.";
})));
assert.throws(() => validateAsrOrthographyExtensionV4ForTests(changed((x) => {
  x.units[1].spans[0].primary_observed_phrase = "Darren";
})));
assert.throws(() => validateAsrOrthographyExtensionV4ForTests({ ...args,
  fragmentDiagnostics: { [ids[1]]: { ...fragmentDiagnostics[ids[1]],
    audioHash: sha("changed fragment") } } }));
assert.throws(() => validateAsrOrthographyExtensionV4ForTests({ ...args,
  fragmentDiagnostics: { [ids[1]]: { ...fragmentDiagnostics[ids[1]],
    diagnostic: { ...diagnostic, small: { ...diagnostic.small,
      recognized_text: "Baron was shouting with a delivery man" } } } } }));
assert.throws(() => validateAsrOrthographyExtensionV4ForTests(changed((x) => {
  x.human_listening_performed = true;
})));
console.log("narration ASR orthography v4 tests passed");
