#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyNarrationDeliveryManualReviewForTests,
  applyNarrationFullStreamManualReviewForTests,
  validateNarrationDeliveryManualReviewEvidenceForTests,
} from "../narration-provider-output-finalize.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-delivery-review-"));
try {
  const audioPath = path.join(tempDir, "unit.wav");
  const priorQaPath = path.join(tempDir, "prior-unit-delivery.json");
  const reviewReelPath = path.join(tempDir, "review.wav");
  await fs.writeFile(audioPath, Buffer.from("immutable-audio"));
  await fs.writeFile(priorQaPath, "{}\n", "utf8");
  await fs.writeFile(reviewReelPath, Buffer.from("review-reel"));
  const audioSha256 = sha256(await fs.readFile(audioPath));
  const priorQaSha256 = sha256(await fs.readFile(priorQaPath));
  const reviewReelSha256 = sha256(await fs.readFile(reviewReelPath));
  const blocker = {
    unit_id: "unit_001",
    severity: "blocker",
    code: "narration_confirmed_word_omission",
  };
  const rows = [{
    unit_id: "unit_001",
    provider: "qwen_local",
    attempt: 1,
    wav: audioPath,
    audio_sha256: audioSha256,
    synthesis_identity_sha256: "a".repeat(64),
  }];
  const deliveryRows = [{
    unit_id: "unit_001",
    decision: { status: "blocked", blockers: [blocker], warnings: [] },
  }];
  const evidence = {
    schema: "goldflow_narration_delivery_manual_review_v1",
    status: "approved",
    reviewer: "operator",
    reviewed_at: "2026-08-23T00:00:00.000Z",
    note: "The exact hash-bound unit was heard and accepted.",
    attestation: "all_hash_bound_blocked_narration_units_listened_end_to_end",
    narration_generation_plan_sha256: "b".repeat(64),
    provider_output_manifest_sha256: "c".repeat(64),
    pre_review_unit_delivery_qa_path: priorQaPath,
    pre_review_unit_delivery_qa_sha256: priorQaSha256,
    review_reel_path: reviewReelPath,
    review_reel_sha256: reviewReelSha256,
    accepted_unit_count: 1,
    accepted_units: [{
      unit_id: "unit_001",
      decision: "accept_first_take",
      provider: "qwen_local",
      attempt: 1,
      audio_path: audioPath,
      audio_sha256: audioSha256,
      synthesis_identity_sha256: "a".repeat(64),
      reviewed_blocker_codes: ["narration_confirmed_word_omission"],
      listen_note: "Complete, smooth, correct voice, and clean endpoint.",
      audible_review: {
        speech_complete: true,
        no_skip: true,
        no_truncation: true,
        no_stutter: true,
        voice_identity_acceptable: true,
        endpoint_acceptable: true,
      },
    }],
  };
  const valid = await validateNarrationDeliveryManualReviewEvidenceForTests({
    evidence,
    evidencePath: path.join(tempDir, "evidence.json"),
    canonicalPlanSha256: "b".repeat(64),
    manifestFileSha256: "c".repeat(64),
    priorUnitDeliveryPath: priorQaPath,
    priorUnitDeliverySha256: priorQaSha256,
    rows,
    deliveryRows,
    blockers: [blocker],
  });
  assert.equal(valid.status, "approved");
  assert.deepEqual(valid.accepted_unit_ids, ["unit_001"]);
  assert.deepEqual(valid.accepted_blocker_codes_by_unit, {
    unit_001: ["narration_confirmed_word_omission"],
  });

  const reviewedFullStream = applyNarrationFullStreamManualReviewForTests({
    fullStream: {
      confirmation_windows: [{
        unit_ids: ["unit_001", "unit_002"],
        decision: {
          status: "blocked",
          blockers: [blocker],
          warnings: [],
        },
      }],
      decision: {
        status: "blocked",
        blockers: [{ ...blocker, unit_ids: ["unit_001", "unit_002"] }],
        warnings: [],
      },
    },
    review: valid,
    evidenceSha256: "d".repeat(64),
  });
  assert.equal(reviewedFullStream.decision.status, "passed_with_warnings");
  assert.equal(reviewedFullStream.decision.blockers.length, 0);
  assert.equal(reviewedFullStream.decision.warnings.length, 1);
  assert.deepEqual(
    reviewedFullStream.decision.warnings[0].manual_review_matched_unit_ids,
    ["unit_001"],
  );
  assert.equal(
    reviewedFullStream.confirmation_windows[0].decision.status,
    "passed_with_warnings",
  );

  const unrelatedFullStream = applyNarrationFullStreamManualReviewForTests({
    fullStream: {
      confirmation_windows: [],
      decision: {
        status: "blocked",
        blockers: [{
          unit_id: "unit_002",
          code: "narration_confirmed_word_omission",
          severity: "blocker",
        }],
        warnings: [],
      },
    },
    review: valid,
    evidenceSha256: "d".repeat(64),
  });
  assert.equal(unrelatedFullStream.decision.status, "blocked");
  assert.equal(unrelatedFullStream.decision.blockers.length, 1);

  await assert.rejects(
    validateNarrationDeliveryManualReviewEvidenceForTests({
      evidence: {
        ...evidence,
        accepted_units: [{
          ...evidence.accepted_units[0],
          reviewed_blocker_codes: ["wrong_code"],
        }],
      },
      evidencePath: path.join(tempDir, "evidence.json"),
      canonicalPlanSha256: "b".repeat(64),
      manifestFileSha256: "c".repeat(64),
      priorUnitDeliveryPath: priorQaPath,
      priorUnitDeliverySha256: priorQaSha256,
      rows,
      deliveryRows,
      blockers: [blocker],
    }),
    /exact blocker codes/i,
  );

  await assert.rejects(
    validateNarrationDeliveryManualReviewEvidenceForTests({
      evidence: {
        ...evidence,
        pre_review_unit_delivery_qa_path: path.join(tempDir, "other.json"),
      },
      evidencePath: path.join(tempDir, "evidence.json"),
      canonicalPlanSha256: "b".repeat(64),
      manifestFileSha256: "c".repeat(64),
      priorUnitDeliveryPath: priorQaPath,
      priorUnitDeliverySha256: priorQaSha256,
      rows,
      deliveryRows,
      blockers: [blocker],
    }),
    /exact blocked QA artifact path/i,
  );

  // A corrected operator decision may retain six accepted takes while rejecting
  // one. Recording the mixed review must never accept the rejected candidate.
  const rejectedAudioPath = path.join(tempDir, "rejected.wav");
  await fs.writeFile(rejectedAudioPath, Buffer.from("heard-pronunciation-defect"));
  const rejectedAudioSha256 = sha256(await fs.readFile(rejectedAudioPath));
  const acceptedIds = Array.from({ length: 6 }, (_, index) => `unit_00${index + 1}`);
  const rejectedId = "unit_007";
  const mixedBlockers = [...acceptedIds, rejectedId].map((unit_id) => ({
    ...blocker, unit_id,
  }));
  const mixedRows = [...acceptedIds, rejectedId].map((unit_id) => ({
    ...rows[0], unit_id,
    ...(unit_id === rejectedId ? {
      wav: rejectedAudioPath,
      audio_sha256: rejectedAudioSha256,
      synthesis_identity_sha256: "e".repeat(64),
    } : {}),
  }));
  const mixedDeliveryRows = mixedBlockers.map((finding) => ({
    unit_id: finding.unit_id,
    decision: { status: "blocked", blockers: [finding], warnings: [] },
  }));
  const mixedEvidence = {
    ...evidence,
    attestation: "all_hash_bound_blocked_narration_units_listened_and_individually_decided",
    accepted_unit_count: 6,
    accepted_units: acceptedIds.map((unit_id) => ({
      ...evidence.accepted_units[0], unit_id,
    })),
    rejected_unit_count: 1,
    rejected_units: [{
      unit_id: rejectedId,
      decision: "repair_required",
      provider: "qwen_local",
      attempt: 1,
      audio_path: rejectedAudioPath,
      audio_sha256: rejectedAudioSha256,
      synthesis_identity_sha256: "e".repeat(64),
      reviewed_blocker_codes: [blocker.code],
      listen_note: "The spoken word was heard as initials and needs exact repair.",
      operator_quote: "Clip one said A-I and not eye.",
    }],
  };
  const validateMixed = (candidate = mixedEvidence) => (
    validateNarrationDeliveryManualReviewEvidenceForTests({
      evidence: candidate,
      evidencePath: path.join(tempDir, "mixed-evidence.json"),
      canonicalPlanSha256: "b".repeat(64),
      manifestFileSha256: "c".repeat(64),
      priorUnitDeliveryPath: priorQaPath,
      priorUnitDeliverySha256: priorQaSha256,
      rows: mixedRows,
      deliveryRows: mixedDeliveryRows,
      blockers: mixedBlockers,
    })
  );
  const mixedReview = await validateMixed();
  assert.deepEqual(mixedReview.accepted_unit_ids, acceptedIds);
  assert.deepEqual(mixedReview.rejected_unit_ids, [rejectedId]);
  assert.equal(mixedReview.accepted_unit_count, 6);
  assert.equal(mixedReview.rejected_unit_count, 1);
  assert.equal(mixedReview.accepted_blocker_codes_by_unit[rejectedId], undefined);
  const appliedRows = structuredClone(mixedDeliveryRows);
  const rejectedBefore = structuredClone(appliedRows.at(-1));
  const remainingBlockers = applyNarrationDeliveryManualReviewForTests({
    deliveryRows: appliedRows,
    blockers: mixedBlockers,
    review: mixedReview,
    evidenceSha256: "f".repeat(64),
  });
  assert.deepEqual(remainingBlockers, [mixedBlockers.at(-1)]);
  assert.deepEqual(appliedRows.at(-1), rejectedBefore);
  assert.equal(appliedRows.filter((row) => row.decision.status === "passed_with_warnings").length, 6);
  assert.deepEqual(sha256(await fs.readFile(rejectedAudioPath)), rejectedAudioSha256);
  const rejectedFullStream = applyNarrationFullStreamManualReviewForTests({
    fullStream: {
      confirmation_windows: [],
      decision: { status: "blocked", blockers: [mixedBlockers.at(-1)], warnings: [] },
    },
    review: mixedReview,
    evidenceSha256: "f".repeat(64),
  });
  assert.deepEqual(rejectedFullStream.decision.blockers, [mixedBlockers.at(-1)]);
  for (const [label, mutate] of [
    ["old all-accepted attestation", (value) => { value.attestation = evidence.attestation; }],
    ["omitted rejection", (value) => { value.rejected_units = []; value.rejected_unit_count = 0; }],
    ["wrong accepted count", (value) => { value.accepted_unit_count = 7; }],
    ["wrong rejected count", (value) => { value.rejected_unit_count = 2; }],
    ["duplicate acceptance", (value) => { value.accepted_units[1] = value.accepted_units[0]; }],
    ["duplicate rejection", (value) => { value.rejected_units.push(value.rejected_units[0]); value.rejected_unit_count = 2; }],
    ["overlapping decisions", (value) => { value.rejected_units[0].unit_id = acceptedIds[0]; }],
    ["unknown rejection", (value) => { value.rejected_units[0].unit_id = "unknown"; }],
    ["wrong rejection decision", (value) => { value.rejected_units[0].decision = "accept_first_take"; }],
    ["stale rejected provider", (value) => { value.rejected_units[0].provider = "other"; }],
    ["stale rejected attempt", (value) => { value.rejected_units[0].attempt = 2; }],
    ["stale rejected path", (value) => { value.rejected_units[0].audio_path = audioPath; }],
    ["stale rejected audio hash", (value) => { value.rejected_units[0].audio_sha256 = "0".repeat(64); }],
    ["stale rejected synthesis", (value) => { value.rejected_units[0].synthesis_identity_sha256 = "0".repeat(64); }],
    ["missing rejection note", (value) => { value.rejected_units[0].listen_note = ""; }],
    ["missing operator quote", (value) => { value.rejected_units[0].operator_quote = ""; }],
    ["wrong rejected blockers", (value) => { value.rejected_units[0].reviewed_blocker_codes = ["wrong"]; }],
    ["stale plan", (value) => { value.narration_generation_plan_sha256 = "0".repeat(64); }],
    ["stale manifest", (value) => { value.provider_output_manifest_sha256 = "0".repeat(64); }],
  ]) {
    const candidate = structuredClone(mixedEvidence);
    mutate(candidate);
    await assert.rejects(validateMixed(candidate), undefined, label);
  }
  await fs.writeFile(rejectedAudioPath, Buffer.from("changed-audio"));
  await assert.rejects(validateMixed(), /rejection audio is stale/i);
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

console.log("narration delivery manual review tests passed");
