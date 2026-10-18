import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V2_SCHEMA,
  NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V3_SCHEMA,
  applyAsrOrthographyReviewForTests,
  validateAsrOrthographyExtensionV3ForTests,
} from "../lib/narration-asr-orthography-review.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const source = "Beren had been honest. I was not going to outfight my brother with three weeks of practice.";
const small = "Barron had been honest. I was not going to outfight my brother with three weeks of practice.";
const medium = "Baron had been honest, I was not going to out-fight my brother with 3 weeks of practice.";
const id = "name-and-compound", audio = sha("audio"), synthesis = sha("synthesis");
const expected = {
  sourceScriptSha256: sha("source"), identityFileSha256: sha("identity"),
  planSha256: sha("plan"), planFileSha256: sha("plan file"),
  qualityContractSha256: sha("quality"),
  priorReportFileSha256: sha("report"),
  priorDeliveryFileSha256: sha("delivery"),
  priorManifestFileSha256: sha("manifest"),
};
const predecessor = {
  evidence_path: "/tmp/v2.json", evidence_sha256: sha("v2"),
  provenance: { schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V2_SCHEMA },
  rows_by_id: new Map(),
};
const output = { unit_id: id, attempt: 1, status: "accepted",
  audio_path: "/tmp/ep/audio.wav", audio_sha256: audio,
  synthesis_identity_sha256: synthesis };
const code = "narration_confirmed_opening_token_mismatch";
const report = { status: "blocked", source_script_hash: expected.sourceScriptSha256,
  narration_generation_plan_sha256: expected.planSha256,
  narration_generation_plan_file_sha256: expected.planFileSha256,
  provider_output_manifest_sha256: expected.priorManifestFileSha256,
  asr_orthography_review: { evidence_sha256: predecessor.evidence_sha256 },
  results: [{ ...output }], blockers: [{ unit_id: id, code }] };
const delivery = { status: "blocked", units: [{ unit_id: id,
  audio_sha256: audio, intended_text: source,
  intended_text_sha256: sha(source),
  primary_recognized_text: small, confirmation_recognized_text: medium,
  edge_alignment: { status: "passed" },
  decision: { status: "blocked", blockers: [{ code }] } }] };
const plan = { plan_sha256: expected.planSha256,
  units: [{ unit_id: id, spoken_text: source,
    spoken_text_sha256: sha(source) }] };
const manifest = { status: "passed", units: [output] };
const evidence = {
  schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V3_SCHEMA,
  status: "reviewed", reviewer_kind: "editorial_text_review",
  human_listening_performed: false,
  authorization_origin: "user_authorized_autonomous_asr_qa",
  reviewer: "Test editor", reviewed_at: "2026-10-01T22:00:00Z",
  note: "Exact dual-ASR name spelling and hyphenation review with no claim of human listening.",
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
  unit_count: 1,
  units: [{ unit_id: id,
    review_schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V3_SCHEMA,
    selected_attempt: 1, audio_path: output.audio_path,
    audio_sha256: audio, synthesis_identity_sha256: synthesis,
    intended_text: source, intended_text_sha256: sha(source),
    primary_recognized_text: small,
    confirmation_recognized_text: medium,
    reviewed_blocker_codes: [code],
    spans: [{ position: "opening",
      relation: "reviewed_dual_asr_proper_name_spelling",
      expected_phrase: "Beren", primary_observed_phrase: "Barron",
      confirmation_observed_phrase: "Baron" },
    { position: "interior", relation: "closed_compound_hyphenation",
      expected_phrase: "outfight", primary_observed_phrase: "outfight",
      confirmation_observed_phrase: "out-fight" }],
    review_note: "Both automated passes differ only at the established name spelling and one closed-compound hyphen; all other source words align." }],
};
const args = { evidence, predecessor, priorReport: report,
  priorDelivery: delivery, priorManifest: manifest,
  currentManifest: manifest, plan, expected,
  actualAudioHashes: { [id]: audio } };
assert.deepEqual(validateAsrOrthographyExtensionV3ForTests(args).unit_ids, [id]);
const reviewed = applyAsrOrthographyReviewForTests(delivery.units[0].decision,
  evidence.units[0], sha("v3"));
assert.equal(reviewed.status, "passed_with_warnings");
assert.equal(reviewed.warnings.at(-1).relation,
  NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V3_SCHEMA);
assert.throws(() => validateAsrOrthographyExtensionV3ForTests({ ...args,
  evidence: { ...evidence, human_listening_performed: true } }));
assert.throws(() => validateAsrOrthographyExtensionV3ForTests({ ...args,
  evidence: { ...evidence, units: [{ ...evidence.units[0],
    spans: [evidence.units[0].spans[0], { ...evidence.units[0].spans[1],
      confirmation_observed_phrase: "out-shoot" }] }] } }));
assert.throws(() => validateAsrOrthographyExtensionV3ForTests({ ...args,
  evidence: { ...evidence, units: [{ ...evidence.units[0],
    confirmation_recognized_text: medium.replace("with 3 weeks", "with 4 weeks") }] } }));
assert.throws(() => validateAsrOrthographyExtensionV3ForTests({ ...args,
  actualAudioHashes: { [id]: sha("different audio") } }));
assert.throws(() => validateAsrOrthographyExtensionV3ForTests({ ...args,
  priorReport: { ...report, blockers: [{ unit_id: id,
    code: "narration_confirmed_word_omission" }] } }));
console.log("narration ASR orthography v3 tests passed");
