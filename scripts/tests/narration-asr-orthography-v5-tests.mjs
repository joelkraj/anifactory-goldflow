import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V4_SCHEMA,
  NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V5_SCHEMA,
  applyAsrOrthographyReviewForTests,
  validateAsrOrthographyExtensionV5ForTests,
} from "../lib/narration-asr-orthography-review.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const id = "current-unit";
const code = "narration_confirmed_opening_token_mismatch";
const intended = "Beren lifted his shield. The wardens spread out. The officer raised both hands.";
const primary = "Baron lifted his shield. The warden spread out. The officer raised both hands.";
const confirmation = "Barron lifted his shield. The warden spread out. The officer raised both hands.";
const warning = { severity: "warning",
  code: "narration_confirmed_lexical_or_pronunciation_difference",
  disposition: "advisory_no_retry", review_required: false,
  operations: ["wardens->warden"] };
const expected = {
  sourceScriptSha256: sha("source"), identityFileSha256: sha("identity"),
  planSha256: sha("plan"), planFileSha256: sha("plan file"),
  qualityContractSha256: sha("quality"),
  priorReportFileSha256: sha("report"),
  priorDeliveryFileSha256: sha("delivery"),
  priorManifestFileSha256: sha("manifest"),
};
const predecessor = {
  evidence_path: "/tmp/v4.json", evidence_sha256: sha("v4"),
  provenance: { schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V4_SCHEMA },
  rows_by_id: new Map([
    ["old-beren", { spans: [{ relation: "reviewed_dual_asr_proper_name_spelling",
      expected_phrase: "Beren", primary_observed_phrase: "Baron",
      confirmation_observed_phrase: "Barron" }] }],
  ]),
};
const output = { unit_id: id, status: "accepted", attempt: 1,
  audio_path: "/tmp/ep/current.wav", audio_sha256: sha("audio"),
  synthesis_identity_sha256: sha("synthesis") };
const report = { status: "blocked", source_script_hash: expected.sourceScriptSha256,
  narration_generation_plan_sha256: expected.planSha256,
  narration_generation_plan_file_sha256: expected.planFileSha256,
  provider_output_manifest_sha256: expected.priorManifestFileSha256,
  asr_orthography_review: { evidence_sha256: predecessor.evidence_sha256 },
  results: [output], blockers: [{ unit_id: id, code }] };
const decision = { status: "blocked", blockers: [{ code }], warnings: [warning,
  { severity: "warning", code: "narration_voice_similarity_low_margin",
    review_required: true }] };
const delivery = { status: "blocked", blockers: structuredClone(report.blockers),
  units: [{ unit_id: id, audio_path: output.audio_path,
    audio_sha256: output.audio_sha256,
    intended_text: intended, intended_text_sha256: sha(intended),
    primary_recognized_text: primary,
    confirmation_recognized_text: confirmation,
    edge_alignment: { status: "passed" }, decision }] };
const plan = { plan_sha256: expected.planSha256,
  units: [{ unit_id: id, spoken_text: intended, spoken_text_sha256: sha(intended) }] };
const manifest = { status: "passed", units: [output] };
const evidence = {
  schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V5_SCHEMA,
  status: "reviewed", reviewer_kind: "editorial_text_review",
  human_listening_performed: false,
  authorization_origin: "user_authorized_autonomous_asr_qa",
  reviewer: "Test editor", reviewed_at: "2026-10-01T22:00:00Z",
  note: "Only the opening proper-name spelling is reviewed; the separate lexical plural warning remains advisory and unchanged.",
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
    review_schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V5_SCHEMA,
    review_method: "opening_name_only_retaining_lexical_advisory",
    selected_attempt: 1, audio_path: output.audio_path,
    audio_sha256: output.audio_sha256,
    synthesis_identity_sha256: output.synthesis_identity_sha256,
    intended_text: intended, intended_text_sha256: sha(intended),
    primary_recognized_text: primary,
    confirmation_recognized_text: confirmation,
    reviewed_blocker_codes: [code],
    spans: [{ position: "opening", relation: "reviewed_dual_asr_proper_name_spelling",
      expected_phrase: "Beren", primary_observed_phrase: "Baron",
      confirmation_observed_phrase: "Barron" }],
    retained_advisory: { disposition: "retain_as_nonblocking_warning",
      warning_code: warning.code, warning_sha256: sha(JSON.stringify(warning)),
      expected_phrase: "wardens", observed_phrase: "warden" },
    review_note: "Both ASR passes use previously accepted name spellings; each also reports singular warden. This clears only the opening spelling and retains the plural discrepancy as an advisory.",
  }],
};
const args = { evidence, predecessor, priorReport: report,
  priorDelivery: delivery, priorManifest: manifest,
  currentManifest: manifest, plan, expected,
  actualAudioHashes: { [id]: output.audio_sha256 } };
assert.deepEqual(validateAsrOrthographyExtensionV5ForTests(args).unit_ids, [id]);
const applied = applyAsrOrthographyReviewForTests(decision, evidence.units[0], sha("v5"));
assert.equal(applied.status, "passed_with_warnings");
assert.equal(applied.blockers.length, 0);
assert.deepEqual(applied.warnings[0], warning);
assert.equal(applied.warnings.at(-1).code,
  "narration_reviewed_opening_name_spelling_only");
assert.equal(applied.warnings.at(-1).full_transcript_equivalence_claimed, false);
const changed = (mutate) => {
  const copy = structuredClone(evidence);
  mutate(copy);
  return { ...args, evidence: copy };
};
assert.throws(() => validateAsrOrthographyExtensionV5ForTests(changed((x) => {
  x.units[0].retained_advisory.warning_sha256 = sha("wrong warning");
})));
assert.throws(() => validateAsrOrthographyExtensionV5ForTests(changed((x) => {
  x.units[0].confirmation_recognized_text =
    "Barron lifted his shield. The wardens spread out. The officer raised both hands.";
})));
assert.throws(() => validateAsrOrthographyExtensionV5ForTests(changed((x) => {
  x.units[0].primary_recognized_text =
    "Baron dropped his shield. The warden spread out. The officer raised both hands.";
})));
assert.throws(() => validateAsrOrthographyExtensionV5ForTests(changed((x) => {
  x.units[0].spans[0].primary_observed_phrase = "Darren";
})));
assert.throws(() => validateAsrOrthographyExtensionV5ForTests({ ...args,
  priorDelivery: { ...delivery, units: [{ ...delivery.units[0],
    decision: { ...decision, warnings: [{ ...warning,
      disposition: "needs_retry" }] } }] } }));
assert.throws(() => validateAsrOrthographyExtensionV5ForTests(changed((x) => {
  x.human_listening_performed = true;
})));
console.log("narration ASR orthography v5 tests passed");
