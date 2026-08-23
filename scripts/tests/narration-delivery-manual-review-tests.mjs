#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
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
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

console.log("narration delivery manual review tests passed");
