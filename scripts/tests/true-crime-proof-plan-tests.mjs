import assert from "node:assert/strict";
import test from "node:test";
import { TRUE_CRIME_PROOF_PLAN_SCHEMA, validateTrueCrimeProofPlan } from "../lib/true-crime-proof-plan.mjs";

// Synthetic paper edit only: these are not real evidence, assets or approvals.
const fixture = () => ({
  schema: TRUE_CRIME_PROOF_PLAN_SCHEMA,
  status: "editorial_draft",
  production_eligible: false,
  working_channel: "Fixture channel",
  case_name: "Synthetic investigation",
  title: "An account and its supporting record",
  target_duration_sec: 118.5,
  sources: [
    { id: "E01", url: "https://example.invalid/record.pdf", title: "Synthetic record", kind: "court_record", locator: "PDF page 2, paragraph 3", planned_use: "media_candidate", acquisition_status: "research_copy", use_basis_status: "unresolved" },
    { id: "V01", url: "https://example.invalid/watch?v=fixture", title: "Synthetic interview", kind: "video", locator: "00:12–00:21", planned_use: "media_candidate", acquisition_status: "reference_only", use_basis_status: "unresolved" },
  ],
  claims: [
    { id: "C01", text: "The record describes the subject's account.", source_ids: ["E01"] },
    { id: "C02", text: "The subject made a statement in an interview.", source_ids: ["V01"] },
  ],
  scenes: [
    { id: "S01", start_sec: 0, end_sec: 35.5, claim_ids: ["C01"], source_ids: ["E01"], picture: { origin: "original", description: "The selected document excerpt." }, audio: { origin: "narration", text_mode: "paraphrase", text: "The record describes an account that investigators needed to check.", source_ids: ["E01"], exact_words_verified: false } },
    { id: "S02", start_sec: 35.5, end_sec: 80, claim_ids: ["C01"], source_ids: ["E01"], picture: { origin: "recreated", description: "Separate illustrative people in an authored room.", label: "ILLUSTRATIVE RECONSTRUCTION" }, audio: { origin: "narration", text_mode: "document_reading", text: "The subject reported the trip.", source_ids: ["E01"], exact_words_verified: true, label: "DOCUMENT READING — Synthetic record, p. 2" } },
    { id: "S03", start_sec: 80, end_sec: 118.5, claim_ids: ["C02"], source_ids: ["V01"], picture: { origin: "authored", description: "A timeline of the reported events." }, audio: { origin: "narration", text_mode: "paraphrase", text: "The interview contains the subject's account; it does not independently establish that the trip occurred.", source_ids: ["V01"], exact_words_verified: false } },
  ],
  readiness: { voice: "unresolved", execution_route: "unsupported" },
});

function reject(change, expected) {
  const plan = fixture();
  change(plan);
  const result = validateTrueCrimeProofPlan(plan);
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.ok(result.errors.some((error) => error.includes(expected)), JSON.stringify(result.errors));
  assert.equal(result.production_ready, false);
}

test("valid fractional-duration draft reports unresolved work without declaring production readiness", () => {
  const result = validateTrueCrimeProofPlan(fixture());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.production_ready, false);
  const readiness = result.unresolved_readiness.map((row) => row.code);
  for (const code of ["voice_selection", "source_use_basis", "source_acquisition", "research_copy_media_binding", "supported_execution_route", "factual_and_source_context_review", "timing_and_listening_review"]) assert.ok(readiness.includes(code));
  assert.ok(!result.unresolved_readiness.some((row) => row.code === "source_acquisition" && row.path === "source.E01"), "Existing research copy must not be called missing.");
});

test("evidence-only references support narration without becoming required media acquisitions", () => {
  const plan = fixture();
  for (const source of plan.sources) source.planned_use = "evidence_only";
  const result = validateTrueCrimeProofPlan(plan);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.ok(!result.unresolved_readiness.some((row) => ["source_use_basis", "source_acquisition", "research_copy_media_binding"].includes(row.code)));
  assert.ok(result.unresolved_readiness.some((row) => row.code === "factual_and_source_context_review"));
  reject((value) => { delete value.sources[0].planned_use; }, "source.E01.planned_use: invalid_value");
  reject((value) => { value.sources[0].planned_use = "evidence_only"; value.sources[0].locator = ""; }, "nonempty_string_required");
});

test("duration is an approximate editorial budget rather than exactly 120 seconds", () => {
  for (const seconds of [90, 112.25, 127.5, 150]) {
    const plan = fixture(); plan.target_duration_sec = seconds; plan.scenes[2].end_sec = seconds;
    assert.equal(validateTrueCrimeProofPlan(plan).valid, true);
  }
  for (const seconds of [89.99, 150.01, 240, Infinity, "120"]) reject((plan) => { plan.target_duration_sec = seconds; }, "approximately_two_minutes");
});

test("scene coverage rejects gaps, overlap, reversed order and missing end coverage", () => {
  reject((plan) => { plan.scenes[0].start_sec = 1; }, "scene_coverage_gap");
  reject((plan) => { plan.scenes[1].start_sec = 36; }, "scene_coverage_gap");
  reject((plan) => { plan.scenes[1].start_sec = 35; }, "scene_overlap_or_out_of_order");
  reject((plan) => { plan.scenes.reverse(); }, "scene_coverage_gap");
  reject((plan) => { plan.scenes[2].end_sec = 115; }, "scene_coverage_does_not_reach_target");
  reject((plan) => { plan.scenes[2].end_sec = 120; }, "scene_exceeds_target");
});

test("invalid and zero-width intervals cannot masquerade as complete scenes", () => {
  reject((plan) => { plan.scenes[1].end_sec = plan.scenes[1].start_sec; }, "positive_finite_scene_interval");
  reject((plan) => { plan.scenes[1].start_sec = NaN; }, "positive_finite_scene_interval");
  reject((plan) => { plan.scenes[1].end_sec = "80"; }, "positive_finite_scene_interval");
});

test("unknown and duplicate IDs and references are rejected", () => {
  reject((plan) => { plan.sources.push(structuredClone(plan.sources[0])); }, "duplicate_id");
  reject((plan) => { plan.scenes[1].id = "S01"; }, "duplicate_id");
  reject((plan) => { plan.claims[0].source_ids = ["MISSING"]; }, "unknown_reference");
  reject((plan) => { plan.scenes[0].claim_ids = ["MISSING"]; }, "unknown_reference");
  reject((plan) => { plan.scenes[0].source_ids = ["E01", "E01"]; }, "duplicate_reference");
});

test("scene claims and audio must connect to that scene's selected sources", () => {
  reject((plan) => { plan.scenes[0].source_ids = ["V01"]; }, "claim_without_supporting_scene_source");
  reject((plan) => { plan.scenes[0].audio.source_ids = ["V01"]; }, "audio_source_missing_from_scene");
});

test("recreated pictures need a visible disclosure independently of audio origin", () => {
  reject((plan) => { delete plan.scenes[1].picture.label; }, "recreated_picture_disclosure_required");
  const plan = fixture();
  plan.scenes[1].audio = { origin: "original", text_mode: "quote", text: "Synthetic recorded dialogue.", source_ids: ["V01"], exact_words_verified: true };
  plan.scenes[1].source_ids.push("V01");
  assert.equal(validateTrueCrimeProofPlan(plan).valid, true);
});

test("paraphrase cannot become original or recreated attributed dialogue", () => {
  for (const origin of ["original", "recreated"]) reject((plan) => { plan.scenes[0].audio.origin = origin; }, "paraphrase_must_be_narration");
  reject((plan) => { plan.scenes[0].audio.exact_words_verified = true; }, "paraphrase_is_not_a_verified_verbatim_quote");
});

test("quoted dialogue stays distinct from document reading and unverified words stay unresolved", () => {
  const plan = fixture();
  plan.scenes[2].audio = { origin: "recreated", text_mode: "quote", text: "Synthetic candidate dialogue.", source_ids: ["V01"], exact_words_verified: false, label: "AUDIO RECREATION — Synthetic interview" };
  const result = validateTrueCrimeProofPlan(plan);
  assert.equal(result.valid, true);
  assert.ok(result.unresolved_readiness.some((row) => row.code === "exact_quote_words"));
  assert.equal(result.production_ready, false);
  plan.scenes[2].audio.label = "Dialogue";
  assert.ok(validateTrueCrimeProofPlan(plan).errors.some((error) => error.includes("audio_recreation_disclosure_required")));
  reject((value) => { value.scenes[0].audio.text_mode = "quote"; }, "quoted_dialogue_requires_original_or_recreated_origin");
});

test("document reading requires exact checked words, narrator origin and source-specific label", () => {
  reject((plan) => { plan.scenes[1].audio.exact_words_verified = false; }, "document_reading_requires_narration_and_verified_exact_words");
  reject((plan) => { plan.scenes[1].audio.origin = "original"; }, "document_reading_requires_narration_and_verified_exact_words");
  reject((plan) => { plan.scenes[1].audio.label = "DOCUMENT READING"; }, "document_reading_source_label_required");
  reject((plan) => { plan.sources[0].locator = ""; }, "nonempty_string_required");
});

test("original labels cannot silently claim recreation", () => {
  reject((plan) => { plan.scenes[0].picture.label = "RECONSTRUCTION"; }, "original_picture_label_conflict");
  reject((plan) => { plan.scenes[2].audio = { ...plan.scenes[2].audio, origin: "original", text_mode: "quote", exact_words_verified: true, label: "AUDIO RECREATION" }; }, "original_audio_label_conflict");
});

test("use notes and selected voice notes never turn the draft into a production approval", () => {
  const plan = fixture();
  for (const source of plan.sources) { source.use_basis_status = "documented"; source.use_basis_note = "Synthetic fixture authored for tests."; }
  plan.readiness.voice = "selected"; plan.readiness.voice_note = "Proposed owned test narrator; no audition or approval recorded.";
  const result = validateTrueCrimeProofPlan(plan);
  assert.equal(result.valid, true);
  assert.ok(!result.unresolved_readiness.some((row) => ["source_use_basis", "voice_selection"].includes(row.code)));
  assert.equal(result.production_ready, false);
  reject((value) => { value.sources[0].use_basis_status = "documented"; }, "nonempty_string_required");
  reject((value) => { value.readiness.voice = "selected"; }, "nonempty_string_required");
});

test("approval, workflow, provider and media-path fields are rejected at every supported level", () => {
  const changes = [
    (plan) => { plan.approved = true; },
    (plan) => { plan.media_workflow = "source_footage_v1"; },
    (plan) => { plan.sources[0].file_path = "/tmp/fixture.pdf"; },
    (plan) => { plan.claims[0].approved = true; },
    (plan) => { plan.scenes[0].media = { approved: true }; },
    (plan) => { plan.scenes[0].picture.path = "/tmp/fixture.png"; },
    (plan) => { plan.scenes[0].audio.provider = "fake-approved-provider"; },
    (plan) => { plan.readiness.voice_approved = true; },
  ];
  for (const change of changes) reject(change, "unsupported_field_in_editorial_plan");
  reject((plan) => { plan.status = "approved"; }, "invalid_value");
  reject((plan) => { plan.production_eligible = true; }, "invalid_value");
  reject((plan) => { plan.readiness.execution_route = "supported"; }, "invalid_value");
});

test("source URLs reject local media and credential-bearing or signed references", () => {
  for (const url of ["file:///tmp/fixture.mp4", "/tmp/fixture.wav", "https://user:password@example.invalid/file", "https://example.invalid/file?token=test", "https://example.invalid/file?X-Amz-Signature=test"]) {
    reject((plan) => { plan.sources[0].url = url; }, "public_http_reference_required");
  }
});

test("malformed containers produce findings rather than throwing", () => {
  for (const plan of [null, undefined, [], "draft", {}, { ...fixture(), sources: null }, { ...fixture(), claims: [null] }, { ...fixture(), scenes: [null] }, { ...fixture(), readiness: null }]) {
    const result = validateTrueCrimeProofPlan(plan);
    assert.equal(result.valid, false);
    assert.equal(result.production_ready, false);
  }
});

test("validation is deterministic and never mutates or executes the supplied plan", () => {
  const plan = fixture();
  const before = structuredClone(plan);
  const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(plan);
  const first = validateTrueCrimeProofPlan(plan);
  assert.deepEqual(validateTrueCrimeProofPlan(plan), first);
  assert.deepEqual(plan, before);
});
