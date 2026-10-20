import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { recheckFalReferenceHolds } from "../lib/fal-reference-hold-recheck.mjs";
import { falBlockedStageRecoveryAdmission, falProductionStageStates } from "../lib/fal-production-state.mjs";
import { commandStageFor } from "../lib/pipeline-stage-registry.mjs";

const exists = file => access(file).then(() => true, () => false);
const identity = { visual_restart: { fork_at: "visual_reference_plan" } };
const productionScript = fileURLToPath(new URL("../fal-production.mjs", import.meta.url));

async function fixture() {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-reference-hold-"));
  const root = path.join(episodeDir, "fal");
  const row = {
    image_id: "luis_chef_ref", ref_id: "luis_chef_ref",
    assignment_sha256: "a".repeat(64), endpoint: "openai/gpt-image-2.5/sunburst/text-to-image",
    submission_receipt_path: path.join(root, "reference", "submission-receipts", "luis_chef_ref.json"),
    result_receipt_path: path.join(root, "reference", "result-receipts", "luis_chef_ref.json"),
    output_path: path.join(episodeDir, "assets", "images", "references", "luis_chef_ref.png"),
  };
  const holdPath = path.join(root, "reference", "transport-holds", "luis_chef_ref.json");
  await mkdir(path.dirname(row.submission_receipt_path), { recursive: true });
  await mkdir(path.dirname(holdPath), { recursive: true });
  await writeFile(path.join(root, "reference-plan.json"), JSON.stringify({ assignments: [row] }));
  await writeFile(path.join(episodeDir, "visual_reference_plan.json"), JSON.stringify({ status: "passed",
    reference_targets: [{ ref_id: row.ref_id, generation_mode: "standalone_ref", reference_image_path: "pending",
      conditioning_image_path: "pending" }] }));
  await writeFile(path.join(episodeDir, "character_state_refs.json"), JSON.stringify({
    character_state_refs: [{ source_ref_id: row.ref_id, reference_image_path: null,
      conditioning_image_path: null }],
  }));
  await writeFile(path.join(episodeDir, "run_identity.json"), JSON.stringify({ image_provider: "fal_ai",
    visual_restart: identity.visual_restart, image_provider_options: { fal: {} } }));
  await writeFile(row.submission_receipt_path, JSON.stringify({ schema: "goldflow_fal_submission_receipt_v1",
    image_id: row.image_id, assignment_sha256: row.assignment_sha256,
    endpoint: row.endpoint, request_id: "original-request-id" }));
  await writeFile(holdPath, JSON.stringify({ schema: "goldflow_fal_transport_hold_v1",
    image_id: row.image_id, assignment_sha256: row.assignment_sha256,
    endpoint: row.endpoint, request_id: "original-request-id", provider_queue_status: "unknown_or_completed" }));
  return { episodeDir, root, row, holdPath };
}

test("reference transport hold routes through no-spend original request recheck", async () => {
  const { episodeDir, root, row } = await fixture();
  try {
    let state = await falProductionStageStates({ episodeDir, identity });
    assert.equal(state.stageStates.reference_generation.state, "blocked");
    assert.match(state.stageStates.reference_generation.next_command_shape, /--action observe-reference-holds$/);
    assert.equal(commandStageFor("imagegen", "fal", { action: "observe-reference-holds" }, identity), "reference_generation");
    const status = { current_stage: "reference_generation", current_stage_state: "blocked",
      next_command_shape: state.stageStates.reference_generation.next_command_shape };
    assert.equal(falBlockedStageRecoveryAdmission(status, { action: "observe-reference-holds" }).allowed, true);
    assert.equal(falBlockedStageRecoveryAdmission(status, { action: "repair-reference-failures" }).allowed, false);

    const result = await recheckFalReferenceHolds({ root, assignments: [row], observe: async rows => {
      assert.deepEqual(rows.map(item => item.image_id), [row.image_id]);
      await mkdir(path.dirname(row.result_receipt_path), { recursive: true });
      await mkdir(path.dirname(row.output_path), { recursive: true });
      await writeFile(row.output_path, "completed original image");
      await writeFile(row.result_receipt_path, JSON.stringify({ output_path: row.output_path,
        output_sha256: "b".repeat(64) }));
      return [{ complete: true }];
    } });
    assert.equal(result.complete, 1);
    const observation = JSON.parse(await readFile(result.observations[0].receipt_path, "utf8"));
    assert.equal(observation.original_request_id, "original-request-id");
    assert.equal(observation.billable_request_resubmitted, false);
    assert.equal(observation.outcome, "complete");
    assert.equal(await exists(path.join(root, "reference", "transport-recovery-submission-receipts", `${row.image_id}.json`)), false);
    state = await falProductionStageStates({ episodeDir, identity });
    assert.match(state.stageStates.reference_generation.next_command_shape, /--action finalize-references$/);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("verified failed original request offers distinct reviewed transport recovery", async () => {
  const { episodeDir, root, row } = await fixture();
  try {
    const result = await recheckFalReferenceHolds({ root, assignments: [row],
      observe: async () => [{ complete: false, status: { status: "FAILED" } }] });
    assert.equal(result.held, 1);
    const observation = JSON.parse(await readFile(result.observations[0].receipt_path, "utf8"));
    assert.equal(observation.outcome, "provider_failed");
    const state = await falProductionStageStates({ episodeDir, identity });
    assert.match(state.stageStates.reference_generation.next_command_shape, /--action recover-reference-holds/);
    assert.doesNotMatch(state.stageStates.reference_generation.next_command_shape, /repair-reference-failures/);
    const status = { current_stage: "reference_generation", current_stage_state: "blocked",
      next_command_shape: state.stageStates.reference_generation.next_command_shape };
    assert.equal(falBlockedStageRecoveryAdmission(status, { action: "recover-reference-holds",
      directives: "/tmp/reviewed.json", "confirm-spend": "exact_fal_reference_transport_recovery" }).allowed, true);
    assert.equal(falBlockedStageRecoveryAdmission(status, { action: "recover-reference-holds",
      directives: "/tmp/reviewed.json", "confirm-spend": "wrong" }).allowed, false);
    assert.equal(commandStageFor("imagegen", "fal", { action: "recover-reference-holds" }, identity), "reference_generation");
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("paid transport recovery is observed and its distinct raster can finalize references", async () => {
  const { episodeDir, root, row } = await fixture();
  try {
    await recheckFalReferenceHolds({ root, assignments: [row],
      observe: async () => [{ complete: false, transport_pending: true }] });
    const recoveryOutput = path.join(episodeDir, "assets", "images", "reference-repairs", `${row.image_id}-transport.png`);
    const recoveryReceipt = path.join(root, "reference", "transport-recovery-result-receipts", `${row.image_id}.json`);
    const recoveryAssignment = path.join(root, "reference", "transport-recovery-assignments", `${row.image_id}.json`);
    const recoverySubmission = path.join(root, "reference", "transport-recovery-submission-receipts", `${row.image_id}.json`);
    await mkdir(path.dirname(recoverySubmission), { recursive: true });
    await mkdir(path.dirname(recoveryAssignment), { recursive: true });
    await writeFile(recoveryAssignment, JSON.stringify({ image_id: row.image_id, output_path: recoveryOutput }));
    await writeFile(recoverySubmission, JSON.stringify({ schema: "goldflow_fal_submission_receipt_v1",
      image_id: row.image_id, assignment_sha256: "d".repeat(64),
      request_id: "replacement-request-id" }));
    let state = await falProductionStageStates({ episodeDir, identity });
    assert.match(state.stageStates.reference_generation.next_command_shape,
      /--action observe-reference-transport-recovery$/);
    assert.equal(commandStageFor("imagegen", "fal", { action: "observe-reference-transport-recovery" }, identity), "reference_generation");
    await mkdir(path.dirname(recoveryOutput), { recursive: true });
    await mkdir(path.dirname(recoveryReceipt), { recursive: true });
    const raster = "replacement raster";
    await writeFile(recoveryOutput, raster);
    await writeFile(recoveryReceipt, JSON.stringify({ output_path: recoveryOutput,
      output_sha256: createHash("sha256").update(raster).digest("hex") }));
    state = await falProductionStageStates({ episodeDir, identity });
    assert.match(state.stageStates.reference_generation.next_command_shape, /--action finalize-references$/);
    const finalized = spawnSync(process.execPath, [productionScript, "--episode-dir", episodeDir,
      "--action", "finalize-references"], { encoding: "utf8" });
    assert.equal(finalized.status, 0, finalized.stderr);
    const plan = JSON.parse(await readFile(path.join(episodeDir, "visual_reference_plan.json"), "utf8"));
    assert.equal(plan.reference_targets[0].reference_image_path, recoveryOutput);
    const characterRefs = JSON.parse(await readFile(path.join(episodeDir, "character_state_refs.json"), "utf8"));
    assert.equal(characterRefs.character_state_refs[0].conditioning_image_path, recoveryOutput);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("422 on original recheck uses content failure repair, while queued work stays no-spend", async () => {
  const { episodeDir, root, row } = await fixture();
  try {
    let result = await recheckFalReferenceHolds({ root, assignments: [row],
      observe: async () => [{ complete: false, status: { status: "IN_QUEUE" } }] });
    assert.equal(result.pending, 1);
    assert.equal(await exists(path.join(root, "reference", "hold-observation-receipts", `${row.image_id}.json`)), false);
    let state = await falProductionStageStates({ episodeDir, identity });
    assert.match(state.stageStates.reference_generation.next_command_shape, /--action observe-reference-holds$/);
    result = await recheckFalReferenceHolds({ root, assignments: [row], observe: async () => {
      const failurePath = path.join(root, "reference", "failure-receipts", `${row.image_id}.json`);
      await mkdir(path.dirname(failurePath), { recursive: true });
      await writeFile(failurePath, JSON.stringify({ image_id: row.image_id, request_id: "original-request-id" }));
      return [{ complete: false, failed: true }];
    } });
    assert.equal(result.failed, 1);
    state = await falProductionStageStates({ episodeDir, identity });
    assert.match(state.stageStates.reference_generation.next_command_shape, /--action repair-reference-failures/);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("reference hold recheck refuses a changed original request binding", async () => {
  const { episodeDir, root, row, holdPath } = await fixture();
  try {
    const hold = JSON.parse(await readFile(holdPath, "utf8"));
    hold.request_id = "different-request";
    await writeFile(holdPath, JSON.stringify(hold));
    let observed = false;
    await assert.rejects(recheckFalReferenceHolds({ root, assignments: [row],
      observe: async () => { observed = true; return []; } }), /not bound to its original request/);
    assert.equal(observed, false);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("materialized references pass status while draft manual_review placeholders stay imageless", async () => {
  const { episodeDir, row } = await fixture();
  try {
    const planPath = path.join(episodeDir, "visual_reference_plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.reference_targets.push({ ref_id: "draft_area_review", generation_mode: "manual_review",
      required_before_imagegen: false });
    await writeFile(planPath, JSON.stringify(plan));
    await mkdir(path.dirname(row.result_receipt_path), { recursive: true });
    await mkdir(path.dirname(row.output_path), { recursive: true });
    const raster = "generated reference raster";
    await writeFile(row.output_path, raster);
    await writeFile(row.result_receipt_path, JSON.stringify({ output_path: row.output_path,
      output_sha256: createHash("sha256").update(raster).digest("hex") }));
    let state = await falProductionStageStates({ episodeDir, identity });
    assert.match(state.stageStates.reference_generation.next_command_shape, /--action finalize-references$/);
    const finalized = spawnSync(process.execPath, [productionScript, "--episode-dir", episodeDir,
      "--action", "finalize-references"], { encoding: "utf8" });
    assert.equal(finalized.status, 0, finalized.stderr);
    state = await falProductionStageStates({ episodeDir, identity });
    assert.equal(state.stageStates.reference_generation.done, true);
    const updated = JSON.parse(await readFile(planPath, "utf8"));
    assert.equal(updated.reference_targets[1].reference_image_path, undefined);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});
