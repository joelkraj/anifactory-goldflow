import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { falProductionStageStates } from "../lib/fal-production-state.mjs";
import { validateFalValidationCorrection, validateFalValidationRecovery } from "../lib/fal-validation-recovery.mjs";

const exec = promisify(execFile);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const fileSha = async file => sha(await readFile(file));
async function writeJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); }

async function fixture() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-validation-recovery-")));
  const root = path.join(dir, "fal"); await mkdir(root);
  const identity = { image_provider: "fal_ai", visual_restart: { fork_at: "visual_reference_plan" },
    episode: "ep_01",
    image_provider_options: { fal: { warning_budget_usd: 30, hard_budget_usd: 35, production_concurrency: 20 } } };
  await writeJson(path.join(dir, "run_identity.json"), identity);
  const assignments = [];
  for (let index = 0; index < 8; index++) {
    const imageId = `frame-${index}`;
    const output = path.join(root, "validation-results", `${imageId}.png`);
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, `image ${index}`);
    const resultPath = path.join(root, "result-receipts", `${imageId}.json`);
    await writeJson(resultPath, { image_id: imageId, output_path: output, output_sha256: await fileSha(output), request_id: `request-${index}` });
    assignments.push({ image_id: imageId, assignment_sha256: sha(`assignment ${index}`),
      prompt: `Original source-bound visual prompt for frame ${index}. ` + "A".repeat(110),
      prompt_sha256: sha(`Original source-bound visual prompt for frame ${index}. ` + "A".repeat(110)),
      reference_mode: "text_only", reference_hashes: [], reference_asset_ids: [], board_sha256: null,
      board_path: null, board_manifest_path: null, endpoint: "fal-ai/gpt-image-1/text-to-image", max_cost_usd: 1,
      result_receipt_path: resultPath, output_path: output,
      submission_receipt_path: path.join(root, "submission-receipts", `${imageId}.json`) });
  }
  const planPath = path.join(root, "validation-plan.json");
  const reviewPath = path.join(root, "validation-review.json");
  await writeJson(planPath, { schema: "goldflow_fal_validation_plan_v1", assignments });
  await writeJson(reviewPath, { schema: "goldflow_fal_validation_review_v1", status: "passed",
    approved_ids: assignments.filter(row => row.image_id !== "frame-6").map(row => row.image_id), rejected_ids: ["frame-6"] });
  const recoveryPrompts = [];
  for (const imageId of ["frame-6", "frame-7"]) {
    const original = assignments.find(row => row.image_id === imageId);
    const prompt = `Replacement source-bound no-lettering single-frame prompt for ${imageId}. ` + "B".repeat(120);
    recoveryPrompts.push({ image_id: imageId, previous_assignment_sha256: original.assignment_sha256,
      previous_result_sha256: await fileSha(original.result_receipt_path),
      previous_output_sha256: (await JSON.parse(await readFile(original.result_receipt_path))).output_sha256,
      replacement_prompt: prompt, replacement_prompt_sha256: sha(prompt),
      reason: "Legible thought-bubble lettering failed in the selected raster; retain the visual action without lettering." });
  }
  const requestPath = path.join(root, "validation-review-correction-request.json");
  await writeJson(requestPath, { schema: "goldflow_fal_validation_review_correction_request_v1",
    validation_plan_sha256: await fileSha(planPath), previous_review_sha256: await fileSha(reviewPath),
    move_to_rejected_id: "frame-7", moved_result_sha256: await fileSha(assignments[7].result_receipt_path),
    moved_output_sha256: (await JSON.parse(await readFile(assignments[7].result_receipt_path))).output_sha256,
    reviewer: "Codex", note: "Second full-resolution visual inspection found duplicate and garbled thought-bubble lettering.",
    recovery_prompts: recoveryPrompts });
  return { dir, root, identity, planPath, reviewPath, requestPath, assignments };
}

async function failedReviewFixture() {
  const f = await fixture();
  const rejected = ["frame-6", "frame-7"];
  await writeJson(f.reviewPath, { schema: "goldflow_fal_validation_review_v1", status: "failed",
    approved_ids: f.assignments.map(row => row.image_id).filter(id => !rejected.includes(id)), rejected_ids: rejected });
  const reviewedResultHashes = {}, reviewedOutputHashes = {};
  for (const row of f.assignments) {
    reviewedResultHashes[row.image_id] = await fileSha(row.result_receipt_path);
    reviewedOutputHashes[row.image_id] = (await JSON.parse(await readFile(row.result_receipt_path))).output_sha256;
  }
  const recoveryPrompts = [];
  for (const imageId of rejected) {
    const original = f.assignments.find(row => row.image_id === imageId);
    const prompt = `Source-exact replacement for the visually rejected ${imageId}. ` + "C".repeat(120);
    recoveryPrompts.push({ image_id: imageId, previous_assignment_sha256: original.assignment_sha256,
      previous_result_sha256: reviewedResultHashes[imageId], previous_output_sha256: reviewedOutputHashes[imageId],
      replacement_prompt: prompt, replacement_prompt_sha256: sha(prompt),
      reason: "The original full-resolution raster visibly changed a required source action and must be replaced." });
  }
  await writeJson(f.requestPath, { schema: "goldflow_fal_failed_validation_recovery_request_v1",
    validation_plan_sha256: await fileSha(f.planPath), previous_review_sha256: await fileSha(f.reviewPath),
    reviewed_result_sha256_by_id: reviewedResultHashes, reviewed_output_sha256_by_id: reviewedOutputHashes,
    reviewer: "Codex", note: "The six accepted images were reviewed and the two rejected images changed essential source details.",
    recovery_prompts: recoveryPrompts });
  return f;
}

test("additive correction keeps first review immutable and routes exactly two rejected shots", async () => {
  const f = await fixture();
  try {
    const originalReviewHash = await fileSha(f.reviewPath);
    const statusBefore = await falProductionStageStates({ episodeDir: f.dir, identity: f.identity });
    assert.match(statusBefore.stageStates.image_generation.next_command_shape, /--action correct-validation-review$/);
    const script = path.resolve("scripts/fal-production.mjs");
    await exec(process.execPath, [script, "--episode-dir", f.dir, "--action", "correct-validation-review"]);
    assert.equal(await fileSha(f.reviewPath), originalReviewHash);
    const correction = await validateFalValidationCorrection({ root: f.root, validationPlanPath: f.planPath, validationReviewPath: f.reviewPath });
    assert.deepEqual(correction.expected.approved_ids, ["frame-0", "frame-1", "frame-2", "frame-3", "frame-4", "frame-5"]);
    assert.deepEqual(correction.expected.rejected_ids, ["frame-6", "frame-7"]);
    assert.match((await falProductionStageStates({ episodeDir: f.dir, identity: f.identity })).stageStates.image_generation.next_command_shape,
      /--action prepare-validation-recovery$/);
    await exec(process.execPath, [script, "--episode-dir", f.dir, "--action", "prepare-validation-recovery"]);
    const recovery = await validateFalValidationRecovery({ root: f.root, correction });
    assert.equal(recovery.plan.assignments.length, 2);
    assert.deepEqual(recovery.plan.assignments.map(row => row.image_id), ["frame-6", "frame-7"]);
    assert.match((await falProductionStageStates({ episodeDir: f.dir, identity: f.identity })).stageStates.image_generation.next_command_shape,
      /--action dispatch-validation-recovery --confirm-spend exact_fal_validation_recovery$/);
    assert.equal(await fileSha(f.reviewPath), originalReviewHash);
    await writeJson(path.join(f.dir, "section_image_prompts_hardened.json"), { prompts: f.assignments.map((row, index) => ({
      image_id: row.image_id, provider_prompt: row.prompt, image_generation_required: true,
      reference_requirements: [], start_sec: index, duration_sec: 1,
    })) });
    await writeJson(path.join(f.dir, "visual_reference_approval_ep_01.json"), { status: "approved", reference_hash_by_ref_id: {} });
    await writeJson(path.join(f.dir, "visual_reference_plan.json"), { reference_targets: [] });
    await writeJson(path.join(f.root, "reference-plan.json"), { assignments: [] });
    await assert.rejects(exec(process.execPath, [script, "--episode-dir", f.dir, "--action", "prepare-bulk", "--image-ids", "all"]),
      /Corrected Fal validation requires both exact replacement shots visually approved/);
    for (const row of recovery.plan.assignments) {
      await writeJson(row.submission_receipt_path, { schema: "goldflow_fal_submission_receipt_v1", image_id: row.image_id,
        assignment_sha256: row.assignment_sha256, request_id: `recovery-${row.image_id}` });
      await mkdir(path.dirname(row.output_path), { recursive: true });
      await writeFile(row.output_path, `recovered ${row.image_id}`);
      await writeJson(row.result_receipt_path, { schema: "goldflow_fal_result_receipt_v1", request_id: `recovery-${row.image_id}`,
        output_path: row.output_path, output_sha256: await fileSha(row.output_path) });
    }
    assert.match((await falProductionStageStates({ episodeDir: f.dir, identity: f.identity })).stageStates.image_generation.next_command_shape,
      /--action review-validation-recovery/);
    await exec(process.execPath, [script, "--episode-dir", f.dir, "--action", "review-validation-recovery", "--reviewer", "Codex",
      "--note", "Both exact regenerated rasters were visually inspected at full resolution; lettering defects are absent.",
      "--approve-ids", "frame-6,frame-7", "--reject-ids", ""]);
    assert.equal((await validateFalValidationRecovery({ root: f.root, correction })).status, "passed");
    assert.match((await falProductionStageStates({ episodeDir: f.dir, identity: f.identity })).stageStates.image_generation.next_command_shape,
      /--action prepare-bulk --image-ids all$/);
    await exec(process.execPath, [script, "--episode-dir", f.dir, "--action", "prepare-bulk", "--image-ids", "all"]);
    const bulk = JSON.parse(await readFile(path.join(f.root, "bulk-plan.json"), "utf8"));
    assert.equal(bulk.assignments.length, 8);
    assert.equal(bulk.assignments.every(row => row.reused_validation_shot), true);
    assert.equal(bulk.assignments.find(row => row.image_id === "frame-6").result_receipt_path,
      recovery.plan.assignments.find(row => row.image_id === "frame-6").result_receipt_path);
    assert.equal(bulk.assignments.find(row => row.image_id === "frame-7").result_receipt_path,
      recovery.plan.assignments.find(row => row.image_id === "frame-7").result_receipt_path);
    assert.equal(bulk.validation_review_correction_sha256, await fileSha(correction.paths.correction));
    assert.equal(bulk.validation_recovery_review_sha256, await fileSha(correction.paths.review));
    assert.match((await falProductionStageStates({ episodeDir: f.dir, identity: f.identity })).stageStates.image_generation.next_command_shape,
      /--action finalize-bulk$/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("validation correction fails closed on altered review or selected raster", async () => {
  const f = await fixture();
  try {
    await writeJson(f.reviewPath, { schema: "goldflow_fal_validation_review_v1", status: "passed", approved_ids: [], rejected_ids: [] });
    await assert.rejects(validateFalValidationCorrection({ root: f.root, validationPlanPath: f.planPath, validationReviewPath: f.reviewPath }),
      /not bound to the current passed/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
  const g = await fixture();
  try {
    await writeFile(g.assignments[7].output_path, "different image");
    await assert.rejects(validateFalValidationCorrection({ root: g.root, validationPlanPath: g.planPath, validationReviewPath: g.reviewPath }),
      /selected visual result/);
  } finally { await rm(g.dir, { recursive: true, force: true }); }
});

test("failed first validation review admits only its two rejected IDs for exact recovery", async () => {
  const f = await failedReviewFixture();
  try {
    const reviewHash = await fileSha(f.reviewPath);
    assert.match((await falProductionStageStates({ episodeDir: f.dir, identity: f.identity })).stageStates.image_generation.next_command_shape,
      /--action correct-validation-review$/);
    const script = path.resolve("scripts/fal-production.mjs");
    await exec(process.execPath, [script, "--episode-dir", f.dir, "--action", "correct-validation-review"]);
    const correction = await validateFalValidationCorrection({ root: f.root, validationPlanPath: f.planPath, validationReviewPath: f.reviewPath });
    assert.equal(correction.expected.mode, "initial_failed_review");
    assert.deepEqual(correction.expected.approved_ids, ["frame-0", "frame-1", "frame-2", "frame-3", "frame-4", "frame-5"]);
    assert.deepEqual(correction.expected.rejected_ids, ["frame-6", "frame-7"]);
    assert.equal(await fileSha(f.reviewPath), reviewHash);
    await exec(process.execPath, [script, "--episode-dir", f.dir, "--action", "prepare-validation-recovery"]);
    const recovery = await validateFalValidationRecovery({ root: f.root, correction });
    assert.deepEqual(recovery.plan.assignments.map(row => row.image_id), ["frame-6", "frame-7"]);
    assert.match((await falProductionStageStates({ episodeDir: f.dir, identity: f.identity })).stageStates.image_generation.next_command_shape,
      /--action dispatch-validation-recovery --confirm-spend exact_fal_validation_recovery$/);
    for (const row of recovery.plan.assignments) {
      await writeJson(row.submission_receipt_path, { schema: "goldflow_fal_submission_receipt_v1", image_id: row.image_id,
        assignment_sha256: row.assignment_sha256, request_id: `recovery-${row.image_id}` });
      await mkdir(path.dirname(row.output_path), { recursive: true });
      await writeFile(row.output_path, `recovered ${row.image_id}`);
      await writeJson(row.result_receipt_path, { schema: "goldflow_fal_result_receipt_v1", request_id: `recovery-${row.image_id}`,
        output_path: row.output_path, output_sha256: await fileSha(row.output_path) });
    }
    await exec(process.execPath, [script, "--episode-dir", f.dir, "--action", "review-validation-recovery", "--reviewer", "Codex",
      "--note", "Both rejected source facts are now shown faithfully in the two replacement rasters.",
      "--approve-ids", "frame-6,frame-7", "--reject-ids", ""]);
    assert.equal((await validateFalValidationRecovery({ root: f.root, correction })).status, "passed");
    await writeJson(path.join(f.dir, "section_image_prompts_hardened.json"), { prompts: f.assignments.map((row, index) => ({
      image_id: row.image_id, provider_prompt: row.prompt, image_generation_required: true,
      reference_requirements: [], start_sec: index, duration_sec: 1,
    })) });
    await writeJson(path.join(f.dir, "visual_reference_approval_ep_01.json"), { status: "approved", reference_hash_by_ref_id: {} });
    await writeJson(path.join(f.dir, "visual_reference_plan.json"), { reference_targets: [] });
    await writeJson(path.join(f.root, "reference-plan.json"), { assignments: [] });
    assert.match((await falProductionStageStates({ episodeDir: f.dir, identity: f.identity })).stageStates.image_generation.next_command_shape,
      /--action prepare-bulk --image-ids all$/);
    await exec(process.execPath, [script, "--episode-dir", f.dir, "--action", "prepare-bulk", "--image-ids", "all"]);
    const bulk = JSON.parse(await readFile(path.join(f.root, "bulk-plan.json"), "utf8"));
    assert.equal(bulk.assignments.length, 8);
    assert.equal(bulk.assignments.every(row => row.reused_validation_shot), true);
    assert.equal(bulk.validation_review_correction_sha256, await fileSha(correction.paths.correction));
    assert.equal(bulk.validation_recovery_review_sha256, await fileSha(correction.paths.review));
    assert.equal(await fileSha(f.reviewPath), reviewHash);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("failed validation recovery rejects stale, broader, or unproven requests", async () => {
  const cases = [
    ["changed review", async f => await writeJson(f.reviewPath, { schema: "goldflow_fal_validation_review_v1", status: "failed",
      approved_ids: ["frame-0"], rejected_ids: ["frame-1"] })],
    ["changed plan", async f => await writeJson(f.planPath, { schema: "goldflow_fal_validation_plan_v1", assignments: f.assignments.slice(1) })],
    ["accepted raster changed", async f => await writeFile(f.assignments[1].output_path, "tampered")],
    ["rejected raster changed", async f => await writeFile(f.assignments[6].output_path, "tampered")],
    ["unchanged prompt", async f => { const q = JSON.parse(await readFile(f.requestPath)); q.recovery_prompts[0].replacement_prompt = f.assignments[6].prompt;
      q.recovery_prompts[0].replacement_prompt_sha256 = sha(f.assignments[6].prompt); await writeJson(f.requestPath, q); }],
    ["extra ID", async f => { const q = JSON.parse(await readFile(f.requestPath)); q.recovery_prompts.push({ ...q.recovery_prompts[0], image_id: "frame-5" }); await writeJson(f.requestPath, q); }],
    ["missing accepted hash", async f => { const q = JSON.parse(await readFile(f.requestPath)); delete q.reviewed_output_sha256_by_id["frame-4"]; await writeJson(f.requestPath, q); }],
    ["moved shot", async f => { const q = JSON.parse(await readFile(f.requestPath)); q.move_to_rejected_id = "frame-5"; await writeJson(f.requestPath, q); }],
    ["probe rejected", async f => { const review = JSON.parse(await readFile(f.reviewPath)); review.approved_ids = ["frame-1", "frame-2", "frame-3", "frame-4", "frame-5", "frame-6"];
      review.rejected_ids = ["frame-0", "frame-7"]; await writeJson(f.reviewPath, review); const q = JSON.parse(await readFile(f.requestPath)); q.previous_review_sha256 = await fileSha(f.reviewPath); await writeJson(f.requestPath, q); }],
    ["post-bulk", async f => await writeJson(path.join(f.root, "bulk-plan.json"), {})],
  ];
  for (const [name, mutate] of cases) {
    const f = await failedReviewFixture();
    try {
      await mutate(f);
      await assert.rejects(validateFalValidationCorrection({ root: f.root, validationPlanPath: f.planPath, validationReviewPath: f.reviewPath }),
        undefined, name);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  }
});
