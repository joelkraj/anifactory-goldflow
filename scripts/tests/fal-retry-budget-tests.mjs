import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertFalRetryBudget, falRetryBudgetState,
  assertFalSpendProjectionBudget, falSpendProjectionState } from "../lib/fal-retry-budget.mjs";
import { falProductionStageStates } from "../lib/fal-production-state.mjs";

async function fixture(frameCount = 20) {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-retry-cap-"));
  const beats = JSON.stringify({
    status: "passed", visual_beat_count: frameCount, beats: Array.from({ length: frameCount }, (_, i) => ({ visual_beat_id: String(i) })),
  });
  await writeFile(path.join(episodeDir, "visual_beat_plan.json"), beats);
  await writeFile(path.join(episodeDir, "visual_beat_approval.json"), JSON.stringify({
    status: "approved", visual_beat_plan_sha256: createHash("sha256").update(beats).digest("hex"),
  }));
  return episodeDir;
}
async function receipt(file, id) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ schema: "goldflow_fal_submission_receipt_v1", image_id: id,
    assignment_sha256: "a".repeat(64), request_id: `request-${id}` }));
}

test("Fal paid repairs are capped at floor(10% of planned scene frames)", async () => {
  const episodeDir = await fixture();
  try {
    const root = path.join(episodeDir, "fal");
    await receipt(path.join(root, "bulk", "submission-receipts", "first.json"), "first");
    await receipt(path.join(root, "reference", "repair-submission-receipts", "ref.json"), "ref");
    const second = { image_id: "second", previous_assignment_sha256: "b".repeat(64),
      submission_receipt_path: path.join(root, "bulk", "repair-submission-receipts", "second.json") };
    const third = { image_id: "third", rejected_image_sha256: "c".repeat(64),
      submission_receipt_path: path.join(root, "bulk", "review-repair-submission-receipts", "third.json") };
    assert.deepEqual(await falRetryBudgetState(episodeDir), {
      planned_frames: 20, retry_limit: 2, paid_retry_submissions: 1, remaining_retries: 1,
    });
    assert.equal((await assertFalRetryBudget({ episodeDir, assignments: [second] })).requested_paid_retries, 1);
    await assert.rejects(assertFalRetryBudget({ episodeDir, assignments: [second, third] }), /10% of 20 planned frames/);
    await receipt(second.submission_receipt_path, "second");
    await assert.rejects(assertFalRetryBudget({ episodeDir, assignments: [third] }), /retry cap reached/);
    assert.equal((await assertFalRetryBudget({ episodeDir, assignments: [{ image_id: "new",
      submission_receipt_path: path.join(root, "bulk", "submission-receipts", "new.json") }] })).requested_paid_retries, 0);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("Fal revised validation counts only shots already submitted in the original validation", async () => {
  const episodeDir = await fixture(10);
  try {
    const root = path.join(episodeDir, "fal");
    await receipt(path.join(root, "submission-receipts", "probe.json"), "probe");
    await receipt(path.join(root, "validation-v2", "submission-receipts", "new.json"), "new");
    const probe = { image_id: "probe", submission_receipt_path: path.join(root, "validation-v2", "submission-receipts", "probe.json") };
    assert.equal((await falRetryBudgetState(episodeDir)).paid_retry_submissions, 0);
    assert.equal((await assertFalRetryBudget({ episodeDir, assignments: [probe] })).requested_paid_retries, 1);
    await receipt(probe.submission_receipt_path, "probe");
    assert.equal((await falRetryBudgetState(episodeDir)).paid_retry_submissions, 1);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("a rejected validation shot regenerated during bulk is a paid retry", async () => {
  const episodeDir = await fixture(10);
  try {
    const root = path.join(episodeDir, "fal");
    await receipt(path.join(root, "submission-receipts", "bad.json"), "bad");
    await writeFile(path.join(root, "validation-review.json"), JSON.stringify({ status: "passed", rejected_ids: ["bad"] }));
    const repeated = { image_id: "bad",
      submission_receipt_path: path.join(root, "bulk", "submission-receipts", "bad.json") };
    assert.equal((await assertFalRetryBudget({ episodeDir, assignments: [repeated] })).requested_paid_retries, 1);
    await receipt(repeated.submission_receipt_path, "bad");
    assert.equal((await falRetryBudgetState(episodeDir)).paid_retry_submissions, 1);
    await assert.rejects(assertFalRetryBudget({ episodeDir, assignments: [{ image_id: "another",
      previous_assignment_sha256: "x", submission_receipt_path: path.join(root,"bulk","repair-submission-receipts","another.json") }] }), /retry cap reached/);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("Fal retry accounting fails closed on a malformed paid submission receipt", async () => {
  const episodeDir = await fixture();
  try {
    const file = path.join(episodeDir, "fal", "bulk", "transport-recovery-submission-receipts", "x.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{}");
    await assert.rejects(falRetryBudgetState(episodeDir), /Invalid Fal submission receipt/);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("Fal status holds exact paid repair once the 10% cap is consumed", async () => {
  const episodeDir = await fixture(10);
  try {
    const root = path.join(episodeDir, "fal");
    await receipt(path.join(root, "bulk", "review-repair-submission-receipts", "prior.json"), "prior");
    const submission = path.join(root, "bulk", "submission-receipts", "failed.json");
    await receipt(submission, "failed");
    await receipt(path.join(root, "bulk", "failure-receipts", "failed.json"), "failed");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "bulk-plan.json"), JSON.stringify({ assignments: [{ image_id: "failed",
      submission_receipt_path: submission,
      result_receipt_path: path.join(root, "bulk", "result-receipts", "failed.json") }] }));
    await writeFile(path.join(root, "validation-review.json"), JSON.stringify({ status: "passed", approved_ids: [], rejected_ids: [] }));
    const state = await falProductionStageStates({ episodeDir, identity: {} });
    assert.equal(state.stageStates.image_generation.state, "blocked");
    assert.match(state.stageStates.image_generation.evidence, /retry cap reached/);
    assert.equal(state.stageStates.image_generation.next_command_shape, undefined);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("Fal observed-rate projection warns and stops at locked thresholds without claiming actual charges", async () => {
  const episodeDir = await fixture();
  try {
    const root = path.join(episodeDir, "fal");
    await receipt(path.join(root, "bulk", "submission-receipts", "one.json"), "one");
    const initial = await falSpendProjectionState({ episodeDir, warningBudgetUsd: 0.03, hardBudgetUsd: 0.05 });
    assert.equal(initial.projected_spend_usd, 0.022);
    assert.equal(initial.actual_charge_usd, null);
    const next = await assertFalSpendProjectionBudget({ episodeDir,
      assignments: [{ image_id: "two" }], warningBudgetUsd: 0.03, hardBudgetUsd: 0.05 });
    assert.equal(next.warning_after_batch, true);
    await assert.rejects(assertFalSpendProjectionBudget({ episodeDir,
      assignments: [{ image_id: "two" }, { image_id: "three" }],
      warningBudgetUsd: 0.03, hardBudgetUsd: 0.05 }), /estimate only/);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("Fal status blocks pending bulk whose observed-rate projection reaches the hard budget", async () => {
  const episodeDir = await fixture(1600);
  try {
    const root = path.join(episodeDir, "fal");
    await mkdir(root, { recursive: true });
    const assignments = Array.from({ length: 1591 }, (_, i) => ({ image_id: String(i),
      submission_receipt_path: path.join(root, "bulk", "submission-receipts", `${i}.json`),
      result_receipt_path: path.join(root, "bulk", "result-receipts", `${i}.json`) }));
    await writeFile(path.join(root, "bulk-plan.json"), JSON.stringify({ assignments, concurrency: 20 }));
    await writeFile(path.join(root, "validation-review.json"), JSON.stringify({ status: "passed", approved_ids: [], rejected_ids: [] }));
    const state = await falProductionStageStates({ episodeDir,
      identity: { image_provider_options: { fal: { warning_budget_usd: 30, hard_budget_usd: 35 } } } });
    assert.equal(state.stageStates.image_generation.state, "blocked");
    assert.match(state.stageStates.image_generation.evidence, /projected episode spend.*35\.002/);
    assert.equal(state.stageStates.image_generation.next_command_shape, undefined);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});
