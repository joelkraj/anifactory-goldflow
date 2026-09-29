import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordFalFailure } from "../lib/fal-failure-receipt.mjs";
import { falBlockedStageRecoveryAdmission, falProductionStageStates } from "../lib/fal-production-state.mjs";

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
