import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildPilotNarrationValidationFixture } from "./avatar-pilot-narration-validation-tests.mjs";
import { buildNarrationSubjectiveReviewDecision, NARRATION_SUBJECTIVE_REVIEW_ATTESTATION } from "../lib/narration-subjective-review.mjs";
import { buildPilotNarrationTiming, validatePilotNarrationAcceptance,
  PILOT_NARRATION_LISTEN_ATTESTATION, PILOT_NARRATION_ACCEPTANCE_SCHEMA } from "../lib/avatar-pilot-narration-acceptance.mjs";

const fixture = await buildPilotNarrationValidationFixture();
const { root: episodeDir, identity, result } = fixture;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const write = async (file, value) => { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); await fs.writeFile(file, bytes); return { path: file, sha256: hash(bytes) }; };
const read = async (ref) => JSON.parse(await fs.readFile(ref.path, "utf8"));
try {
  const refs = result.finalization_artifacts;
  const manifest = await read(refs.subjective_manifest), candidate = await read(refs.timing_candidate), delivery = await read(refs.full_stream_qa);
  const narrationRef = await write(path.join(episodeDir, "pilot_narration_work", "narration_producer_result.json"), result);
  const timing = buildPilotNarrationTiming({ result, candidate, delivery, identity });
  assert.equal(timing.schema, "goldflow_avatar_pilot_word_timing_v1");
  assert.equal(timing.words.length, candidate.words.length);
  timing.words.forEach((word, index) => {
    assert.equal(word.word, candidate.words[index].word);
    assert.equal(word.start, candidate.words[index].start_sec);
    assert.equal(word.end, candidate.words[index].end_sec);
  });
  const reviewer = "synthetic fixture reviewer", note = "Synthetic complete-listening decision for code tests, never real audio approval.";
  const decision = buildNarrationSubjectiveReviewDecision({ manifest, reviewer, attestation: NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
    decisions: manifest.samples.map((sample) => ({ sample_id: sample.sample_id, decision: "accept", note })) });
  const namespace = path.join(episodeDir, "pilot_narration_work", "full_finalization");
  const payload = { schema: PILOT_NARRATION_ACCEPTANCE_SCHEMA, narration_result: narrationRef, audio: refs.audio,
    subjective_decision: await write(path.join(namespace, `narration_subjective_review_decision_${identity.episode}.json`), decision),
    whisper_timing: await write(path.join(namespace, "pilot_word_timing.json"), timing), production_eligible: false, publish_allowed: false,
    review: { approved: true, reviewer, note, attestation: PILOT_NARRATION_LISTEN_ATTESTATION },
    listening_attestation_mapping: { operator_attestation: PILOT_NARRATION_LISTEN_ATTESTATION,
      canonical_attestation: NARRATION_SUBJECTIVE_REVIEW_ATTESTATION, audio_sha256: refs.audio.sha256,
      manifest_sha256: refs.subjective_manifest.sha256, all_samples_contained_in_full_narration: true,
      sample_ids: manifest.samples.map((sample) => sample.sample_id) } };
  const validate = (value) => validatePilotNarrationAcceptance(value, { episodeDir, identity });
  const good = await validate(payload); assert.equal(good.status, "passed", JSON.stringify(good.findings));
  for (const mutate of [
    (row) => { row.review.attestation = "complete_opening_listened_end_to_end"; },
    (row) => { row.review.approved = false; },
    (row) => { row.review.reviewer = "another reviewer"; },
    (row) => { row.audio.sha256 = "0".repeat(64); },
    (row) => { row.narration_result.sha256 = "0".repeat(64); },
    (row) => { row.subjective_decision.sha256 = "0".repeat(64); },
    (row) => { row.subjective_decision.path = path.join(namespace, "copied_decision.json"); },
    (row) => { row.listening_attestation_mapping.canonical_attestation = "opening_only"; },
    (row) => { row.listening_attestation_mapping.sample_ids = []; },
    (row) => { row.whisper_timing.path = path.join(namespace, "unrelated.json"); },
    (row) => { row.publish_allowed = true; },
  ]) { const changed = structuredClone(payload); mutate(changed); assert.equal((await validate(changed)).status, "blocked"); }
  const alteredTiming = structuredClone(timing); alteredTiming.words[0].start += 1;
  const changed = structuredClone(payload); changed.whisper_timing = await write(payload.whisper_timing.path, alteredTiming);
  assert.equal((await validate(changed)).status, "blocked"); await write(payload.whisper_timing.path, timing);
  const openingCandidate = structuredClone(candidate); openingCandidate.finalization_scope.phase = "opening";
  assert.throws(() => buildPilotNarrationTiming({ result, candidate: openingCandidate, delivery, identity }));
  assert.equal((await validate(payload)).status, "passed");
  console.log("Pilot full narration acceptance/timing tests passed (13 rejection cases; synthetic review only, no models).");
} finally { await fixture.cleanup(); }
