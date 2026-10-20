import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  NARRATION_SPOKEN_FORM_EQUIVALENCES,
  NARRATION_SPOKEN_FORM_EQUIVALENCES_PATH,
  NARRATION_SPOKEN_FORM_EQUIVALENCES_SHA256,
  applyNarrationSpokenFormSpellings,
  isNarrationSameValueContraction,
  narrationSpokenFormCompound,
} from "../lib/narration-spoken-form-equivalences.mjs";
import {
  TRANSCRIPT_QA_COMPARISON_VERSION,
  TRANSCRIPT_QA_SPOKEN_FORM_EQUIVALENCES_SHA256,
  transcriptQaForTests,
} from "../modelslab-qwen-episode-audio.mjs";
import {
  NARRATION_DELIVERY_CONSENSUS_VERSION,
  adjudicateNarrationDeliveryConsensus,
} from "../lib/narration-delivery-quality.mjs";
import {
  buildNarrationQualityContract,
  narrationSpokenFormEquivalencesForContract,
  validateNarrationQualityContract,
  validateNarrationSpokenFormEquivalencesBinding,
} from "../lib/narration-quality-contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(
  path.join(HERE, "fixtures/narration_spoken_form_regression_corpus_v1.json"),
  "utf8",
));

const errors = (intended, recognized) => {
  const qa = transcriptQaForTests(intended, recognized);
  return qa.deletions + qa.insertions + qa.substitutions;
};
const decide = (intended, recognized) => {
  const qa = transcriptQaForTests(intended, recognized, { blockAnySubstitution: false });
  return adjudicateNarrationDeliveryConsensus({
    primaryTranscriptQa: qa,
    confirmationTranscriptQa: qa,
    contract: { delivery_qa: { unconfirmed_primary_asr_requires_exact_listen: false } },
  });
};

test("the comparator is driven by the frozen table and exports its sha", () => {
  const bytes = fs.readFileSync(NARRATION_SPOKEN_FORM_EQUIVALENCES_PATH);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), NARRATION_SPOKEN_FORM_EQUIVALENCES_SHA256);
  assert.equal(TRANSCRIPT_QA_SPOKEN_FORM_EQUIVALENCES_SHA256, NARRATION_SPOKEN_FORM_EQUIVALENCES_SHA256);
  assert.equal(TRANSCRIPT_QA_COMPARISON_VERSION, NARRATION_SPOKEN_FORM_EQUIVALENCES.frozen_from.transcript_comparison_version);
  assert.equal(NARRATION_DELIVERY_CONSENSUS_VERSION, NARRATION_SPOKEN_FORM_EQUIVALENCES.frozen_from.delivery_consensus_version);
  assert.equal(applyNarrationSpokenFormSpellings("Dr. Ward met Mr. Walsh; it was cancelled."), "doctor Ward met mister Walsh; it was canceled.");
  assert.equal(applyNarrationSpokenFormSpellings("Drake Mrs. Doctor"), "Drake Mrs. Doctor", "only the listed written forms change");
  assert.equal(narrationSpokenFormCompound("every", "one"), "everyone");
  assert.equal(narrationSpokenFormCompound("every", "where"), null);
  assert.ok(isNarrationSameValueContraction({ type: "substitution", intended: "one's", recognized: "num:1" }));
  assert.equal(isNarrationSameValueContraction({ type: "substitution", intended: "one's", recognized: "num:2" }), false);
  assert.equal(isNarrationSameValueContraction({ type: "deletion", intended: "one's" }), false);
});

test("the table's own equivalent and distinct examples hold (extracted deepmale commits)", () => {
  for (const [a, b] of NARRATION_SPOKEN_FORM_EQUIVALENCES.grouped_numbers.examples_equivalent) {
    assert.equal(errors(a, b), 0, `${a} / ${b}`);
  }
  for (const [a, b] of NARRATION_SPOKEN_FORM_EQUIVALENCES.grouped_numbers.examples_distinct) {
    assert.ok(errors(a, b) > 0, `${a} / ${b}`);
  }
  // Protected-value equality: a changed digit never passes through the table.
  assert.ok(decide("Room four twelve.", "Room 413.").blockers.length);
  assert.equal(decide("Three. One's stuck. Then he left.", "Three. One stuck. Then he left.").blockers.length, 0);
  assert.ok(decide("Three. One's stuck. Then he left.", "Three. Two stuck. Then he left.").blockers.length);
});

test("regression corpus: every recorded unit reproduces its frozen comparator outcome", () => {
  assert.equal(corpus.units.length, 44);
  const counts = {};
  for (const unit of corpus.units) {
    const decision = decide(unit.intended_text, unit.recognized_text);
    assert.deepEqual(
      decision.blockers.map((row) => row.code).sort(),
      unit.frozen_comparator.blocker_codes,
      `clip ${unit.clip} ${unit.unit_id}`,
    );
    counts[unit.classification] = (counts[unit.classification] ?? 0) + 1;
  }
  assert.deepEqual(counts, corpus.summary);
  // The Oct-19 review: 38 accepted by ear, 6 rejected (clips 3, 4, 6, 17, 23, 37).
  const rejected = corpus.units.filter((unit) => unit.human_decision === "rejected_by_ear").map((unit) => unit.clip);
  assert.deepEqual(rejected, [3, 4, 6, 17, 23, 37]);
  assert.equal(corpus.units.filter((unit) => unit.human_decision === "accepted_by_ear").length, 38);
  // Known acoustic-only gap: rushed delivery with a complete transcript is not
  // visible to the comparator. These are never asserted as comparator blocks.
  assert.deepEqual(
    corpus.units.filter((unit) => unit.classification === "human_rejected_acoustic_only_gap").map((unit) => unit.clip),
    [3, 6],
  );
  assert.deepEqual(
    corpus.units.filter((unit) => unit.classification === "human_rejected_text_blocks").map((unit) => unit.clip),
    [4, 17, 23, 37],
  );
});

test("new automated identities bind the table sha; historical contracts stay unbound and valid", () => {
  const automated = buildNarrationQualityContract({
    provider: "qwen_local",
    modelId: "fixture",
    deliveryQaPolicy: { acceptance_mode: "automated_asr_v1" },
  });
  const binding = narrationSpokenFormEquivalencesForContract(automated);
  assert.equal(binding.config_sha256, NARRATION_SPOKEN_FORM_EQUIVALENCES_SHA256);
  assert.equal(binding.config_path, "config/narration_spoken_form_equivalences_v1.json");
  assert.equal(validateNarrationQualityContract(automated).status, "passed");
  assert.equal(validateNarrationSpokenFormEquivalencesBinding(automated).status, "bound");

  const legacy = buildNarrationQualityContract({ provider: "qwen_local", modelId: "fixture" });
  assert.equal(narrationSpokenFormEquivalencesForContract(legacy), null);
  assert.equal(validateNarrationSpokenFormEquivalencesBinding(legacy).status, "legacy_unbound");
  assert.equal(validateNarrationQualityContract(legacy).status, "passed");

  // A historical automated contract recorded before the table existed keeps validating.
  const historical = buildNarrationQualityContract({
    provider: "qwen_local",
    modelId: "fixture",
    deliveryQaPolicy: { acceptance_mode: "automated_asr_v1" },
    spokenFormEquivalences: null,
  });
  assert.equal(narrationSpokenFormEquivalencesForContract(historical), null);
  assert.equal(validateNarrationQualityContract(historical).status, "passed");

  // A table edited after the lock is a stop, not a silent re-comparison.
  const stale = buildNarrationQualityContract({
    provider: "qwen_local",
    modelId: "fixture",
    deliveryQaPolicy: { acceptance_mode: "automated_asr_v1" },
    spokenFormEquivalences: { ...binding, config_sha256: "0".repeat(64) },
  });
  const validation = validateNarrationQualityContract(stale);
  assert.equal(validation.status, "blocked");
  assert.ok(validation.findings.some((row) => row.code === "narration_quality_spoken_form_equivalences_stale"));
});
