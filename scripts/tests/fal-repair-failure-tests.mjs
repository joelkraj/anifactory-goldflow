import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { falFailureReceiptPath, recordFalFailure } from "../lib/fal-failure-receipt.mjs";
import { falBlockedStageRecoveryAdmission, falProductionStageStates } from "../lib/fal-production-state.mjs";
import "./fal-reviewed-reference-success-repair-tests.mjs";

test("failed Fal repair keeps the original receipt and blocks on exact-ID triage", async () => {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-repair-failure-"));
  try {
    const root = path.join(episodeDir, "fal", "bulk");
    const id = "ep_01-w005714-w005730";
    const originalFailure = path.join(root, "failure-receipts", `${id}.json`);
    const original = '{"request_id":"original-request","assignment_sha256":"original-assignment"}\n';
    await mkdir(path.dirname(originalFailure), { recursive: true });
    await writeFile(originalFailure, original);
    const row = { image_id: id, assignment_sha256: "repair-assignment",
      submission_receipt_path: path.join(root, "repair-submission-receipts", `${id}.json`),
      result_receipt_path: path.join(root, "repair-result-receipts", `${id}.json`) };
    const receipt = { schema: "goldflow_fal_submission_receipt_v1", image_id: id,
      assignment_sha256: row.assignment_sha256, request_id: "repair-request", endpoint: "openai/gpt-image-2.5/sunburst/edit" };
    const error = Object.assign(new Error("content rejected"), { status: 422, body: { detail: [{ type: "content_policy", msg: "content rejected" }] } });
    await mkdir(path.dirname(row.submission_receipt_path), { recursive: true });
    await writeFile(row.submission_receipt_path, JSON.stringify(receipt));
    const failurePath = await recordFalFailure(row, receipt, error);
    assert.equal(failurePath, path.join(root, "repair-failure-receipts", `${id}.json`));
    assert.equal(await readFile(originalFailure, "utf8"), original);
    const repairBytes = await readFile(failurePath, "utf8");
    assert.equal(JSON.parse(repairBytes).assignment_sha256, row.assignment_sha256);
    assert.equal(await recordFalFailure(row, receipt, error), failurePath);
    assert.equal(await readFile(failurePath, "utf8"), repairBytes);
    await assert.rejects(recordFalFailure(row, { ...receipt, request_id: "other" }, error), /differs/);

    await mkdir(path.join(root, "repair-assignments"), { recursive: true });
    await writeFile(path.join(root, "repair-assignments", `${id}.json`), JSON.stringify(row));
    await writeFile(path.join(episodeDir, "fal", "bulk-plan.json"), JSON.stringify({ assignments: [{ image_id: id,
      submission_receipt_path: path.join(root, "submission-receipts", `${id}.json`),
      result_receipt_path: path.join(root, "result-receipts", `${id}.json`) }], concurrency: 1 }));
    await writeFile(path.join(episodeDir, "fal", "validation-review.json"), JSON.stringify({ status: "passed", approved_ids: [] }));
    const state = (await falProductionStageStates({ episodeDir, identity: {} })).stageStates.image_generation;
    assert.equal(state.state, "blocked");
    assert.match(state.next_command_shape, new RegExp(`--action inspect-repair-failure --image-id ${id}$`));
    const status = { current_stage: "image_generation", current_stage_state: "blocked", next_command_shape: state.next_command_shape };
    assert.equal(falBlockedStageRecoveryAdmission(status, { action: "inspect-repair-failure", "image-id": id }).allowed, true);
    assert.equal(falBlockedStageRecoveryAdmission(status, { action: "inspect-repair-failure", "image-id": "other" }).allowed, false);
    assert.equal(falBlockedStageRecoveryAdmission(status, { action: "observe-repairs" }).allowed, false);
    assert.equal(falBlockedStageRecoveryAdmission(status, { action: "repair-failures" }).allowed, false);
    assert.equal(falBlockedStageRecoveryAdmission(status, { action: "repair-failed-repair", "image-id": id }).allowed, false);
    assert.equal(falBlockedStageRecoveryAdmission(status, { action: "repair-failed-repair", "image-id": "other" }).allowed, false);

    const directivePath = path.join(root, "repair-v2-directives", `${id}.json`);
    await mkdir(path.dirname(directivePath), { recursive: true });
    await writeFile(directivePath, JSON.stringify({ schema: "goldflow_fal_failed_repair_directive_v1", image_id: id,
      failed_repair_assignment_sha256: row.assignment_sha256, failed_repair_request_id: receipt.request_id,
      replacement_prompt: "A fully clothed character stands in a quiet washroom after an off-screen event.",
      repair_reason: "Reviewed exact frame replacement", reviewer: "test-reviewer", note: "Reviewed the bound failure and scene." }));
    const ready = (await falProductionStageStates({ episodeDir, identity: {} })).stageStates.image_generation;
    assert.equal(ready.state, "blocked");
    assert.equal(ready.next_command_shape, `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action repair-failed-repair --image-id ${id} --directives ${directivePath} --confirm-spend exact_fal_repair_v2`);
    const readyStatus = { ...status, next_command_shape: ready.next_command_shape };
    assert.equal(falBlockedStageRecoveryAdmission(readyStatus, { action: "repair-failed-repair", "image-id": id,
      directives: directivePath, "confirm-spend": "exact_fal_repair_v2" }).allowed, true);
    assert.equal(falBlockedStageRecoveryAdmission(readyStatus, { action: "repair-failed-repair", "image-id": "other",
      directives: directivePath, "confirm-spend": "exact_fal_repair_v2" }).allowed, false);
    assert.equal(falBlockedStageRecoveryAdmission(readyStatus, { action: "repair-failed-repair", "image-id": id,
      directives: "/tmp/other.json", "confirm-spend": "exact_fal_repair_v2" }).allowed, false);

    const v2 = { ...row, assignment_sha256: "second-repair-assignment",
      submission_receipt_path: path.join(root, "repair-v2-submission-receipts", `${id}.json`),
      result_receipt_path: path.join(root, "repair-v2-result-receipts", `${id}.json`) };
    await mkdir(path.join(root, "repair-v2-assignments"), { recursive: true });
    await writeFile(path.join(root, "repair-v2-assignments", `${id}.json`), JSON.stringify(v2));
    await mkdir(path.dirname(v2.submission_receipt_path), { recursive: true });
    await writeFile(v2.submission_receipt_path, JSON.stringify({ ...receipt,
      request_id: "second-repair-request", assignment_sha256: v2.assignment_sha256 }));
    const pending = (await falProductionStageStates({ episodeDir, identity: {} })).stageStates.image_generation;
    assert.equal(pending.state, "blocked");
    assert.match(pending.next_command_shape, new RegExp(`--action observe-repair-v2 --image-id ${id}$`));
    const v2Failure = await recordFalFailure(v2, { ...receipt, request_id: "second-repair-request" }, error);
    assert.equal(v2Failure, path.join(root, "repair-v2-failure-receipts", `${id}.json`));
    const held = (await falProductionStageStates({ episodeDir, identity: {} })).stageStates.image_generation;
    assert.equal(held.state, "blocked");
    assert.equal(held.next_command_shape, undefined);
    assert.equal(await readFile(originalFailure, "utf8"), original);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("reviewed reference provider failure gets its own receipt and an exact second-repair route", async () => {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-reviewed-reference-failure-"));
  try {
    const root = path.join(episodeDir, "fal", "reference");
    const id = "escort_identity_ref";
    const originalOutput = path.join(episodeDir, "assets", "images", "references", `${id}.png`);
    const originalResult = path.join(root, "result-receipts", `${id}.json`);
    await mkdir(path.dirname(originalOutput), { recursive: true });
    await writeFile(originalOutput, "original image");
    await mkdir(path.dirname(originalResult), { recursive: true });
    await writeFile(originalResult, JSON.stringify({ output_path: originalOutput }));
    await writeFile(path.join(episodeDir, "fal", "reference-plan.json"), JSON.stringify({ assignments: [{
      image_id: id, ref_id: id, endpoint: "openai/gpt-image-2.5/sunburst/text-to-image",
      output_path: originalOutput, result_receipt_path: originalResult,
    }] }));
    await writeFile(path.join(episodeDir, "visual_reference_plan.json"), JSON.stringify({ reference_targets: [{
      ref_id: id, reference_image_path: originalOutput, conditioning_image_path: originalOutput,
    }] }));
    await writeFile(path.join(root, "review-rejections.json"), JSON.stringify({
      schema: "goldflow_fal_reference_visual_review_v1", rejections: [{ image_id: id }],
    }));
    const v2 = { image_id: id, assignment_sha256: "v2-assignment",
      result_receipt_path: path.join(root, "review-repair-result-receipts", `${id}.json`),
      submission_receipt_path: path.join(root, "review-repair-submission-receipts", `${id}.json`) };
    await mkdir(path.join(root, "review-repair-assignments"), { recursive: true });
    await writeFile(path.join(root, "review-repair-assignments", `${id}.json`), JSON.stringify(v2));
    const v2Failure = falFailureReceiptPath(v2);
    assert.equal(v2Failure, path.join(root, "review-repair-failure-receipts", `${id}.json`));
    await mkdir(path.dirname(v2Failure), { recursive: true });
    await writeFile(v2Failure, JSON.stringify({ schema: "goldflow_fal_exact_failure_v1", image_id: id,
      assignment_sha256: v2.assignment_sha256, request_id: "v2-request", error_status: 422 }));
    const identity = { visual_restart: { fork_at: "visual_reference_plan" } };
    const blocked = (await falProductionStageStates({ episodeDir, identity })).stageStates.reference_image_approval;
    assert.equal(blocked.state, "blocked");
    assert.match(blocked.next_command_shape, new RegExp(`--action repair-failed-reviewed-reference --image-id ${id} `));
    const directive = path.join(root, "review-repair-v3-directives", `${id}.json`);
    const allowed = falBlockedStageRecoveryAdmission({ current_stage: "reference_image_approval",
      current_stage_state: "blocked", next_command_shape: blocked.next_command_shape }, {
      action: "repair-failed-reviewed-reference", "image-id": id, directives: directive,
      "confirm-spend": "exact_fal_reviewed_reference_v3",
    });
    assert.equal(allowed.allowed, true);
    assert.equal(falBlockedStageRecoveryAdmission({ current_stage: "reference_image_approval",
      current_stage_state: "blocked", next_command_shape: blocked.next_command_shape }, {
      action: "repair-failed-reviewed-reference", "image-id": "different", directives: directive,
      "confirm-spend": "exact_fal_reviewed_reference_v3",
    }).allowed, false);
    const v3 = { image_id: id, assignment_sha256: "v3-assignment",
      result_receipt_path: path.join(root, "review-repair-v3-result-receipts", `${id}.json`),
      submission_receipt_path: path.join(root, "review-repair-v3-submission-receipts", `${id}.json`) };
    await mkdir(path.join(root, "review-repair-v3-assignments"), { recursive: true });
    await writeFile(path.join(root, "review-repair-v3-assignments", `${id}.json`), JSON.stringify(v3));
    await mkdir(path.dirname(v3.submission_receipt_path), { recursive: true });
    await writeFile(v3.submission_receipt_path, JSON.stringify({ schema: "goldflow_fal_submission_receipt_v1",
      image_id: id, assignment_sha256: v3.assignment_sha256, request_id: "v3-request" }));
    const pending = (await falProductionStageStates({ episodeDir, identity })).stageStates.reference_image_approval;
    assert.match(pending.next_command_shape, new RegExp(`--action observe-failed-reviewed-reference --image-id ${id}$`));
    assert.equal(falFailureReceiptPath(v3), path.join(root, "review-repair-v3-failure-receipts", `${id}.json`));
    await mkdir(path.dirname(v3.result_receipt_path), { recursive: true });
    const v3Output = path.join(episodeDir, "assets", "images", "reference-repairs", `${id}-v3.png`);
    await writeFile(v3.result_receipt_path, JSON.stringify({ output_path: v3Output }));
    const ready = (await falProductionStageStates({ episodeDir, identity })).stageStates.reference_image_approval;
    assert.match(ready.next_command_shape, /--action finalize-reviewed-references$/);
    await writeFile(path.join(episodeDir, "visual_reference_plan.json"), JSON.stringify({ reference_targets: [{
      ref_id: id, reference_image_path: v3Output, conditioning_image_path: v3Output,
    }] }));
    const finalized = (await falProductionStageStates({ episodeDir, identity })).stageStates;
    assert.equal(finalized.reference_generation.done, true);
    assert.equal(finalized.reference_image_approval, undefined);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});
