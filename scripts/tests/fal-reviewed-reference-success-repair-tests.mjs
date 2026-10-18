import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateFalReviewedReferenceSuccessRepair } from "../lib/fal-reviewed-reference-success-repair.mjs";
import { falBlockedStageRecoveryAdmission, falProductionStageStates } from "../lib/fal-production-state.mjs";
import { commandStageFor } from "../lib/pipeline-stage-registry.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const put = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };
const json = async (file, value) => put(file, `${JSON.stringify(value)}\n`);

test("successful reviewed references require exact source-bound v3 admission and preserve other targets", async () => {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-ref-success-v3-"));
  try {
    const referenceRoot = path.join(episodeDir, "fal", "reference");
    const sourceId = "yard_base_ref";
    const repairIds = ["yard_gate_ref", "yard_damaged_gate_ref"];
    const allIds = [sourceId, ...repairIds];
    const identity = { episode: "ep_01", image_provider: "fal_ai", visual_restart: { fork_at: "visual_reference_plan" } };
    await json(path.join(episodeDir, "run_identity.json"), identity);
    await put(path.join(episodeDir, "script_clean.md"), "The gatepost didn't hold. The broken gate hung inward.\n");
    const assignments = [];
    const targets = [];
    for (const id of allIds) {
      const output = path.join(episodeDir, "assets", "images", "references", `${id}.png`);
      await put(output, `original-${id}`);
      const result = path.join(referenceRoot, "result-receipts", `${id}.json`);
      await json(result, { output_path: output, output_sha256: sha(`original-${id}`) });
      assignments.push({ image_id: id, ref_id: id, output_path: output, result_receipt_path: result,
        assignment_sha256: `original-${id}` });
      targets.push({ ref_id: id, kind: "location", reference_image_path: output, conditioning_image_path: output });
    }
    const v2 = new Map();
    for (const id of repairIds) {
      const output = path.join(episodeDir, "assets", "images", "reference-repairs", `${id}-v2.png`);
      await put(output, `v2-${id}`);
      const assignment = { image_id: id, assignment_sha256: `v2-${id}`,
        previous_assignment_sha256: `original-${id}`, output_path: output,
        prompt_sha256: sha(`old prompt ${id}`) };
      const result = { output_path: output, output_sha256: sha(`v2-${id}`) };
      await json(path.join(referenceRoot, "review-repair-assignments", `${id}.json`), assignment);
      await json(path.join(referenceRoot, "review-repair-result-receipts", `${id}.json`), result);
      targets.find(target => target.ref_id === id).reference_image_path = output;
      targets.find(target => target.ref_id === id).conditioning_image_path = output;
      v2.set(id, { assignment, result });
    }
    const baseOutput = path.join(episodeDir, "assets", "images", "references", `${sourceId}.png`);
    const planPath = path.join(episodeDir, "visual_reference_plan.json");
    const referencePlanPath = path.join(episodeDir, "fal", "reference-plan.json");
    const firstReviewPath = path.join(referenceRoot, "review-rejections.json");
    await json(planPath, { status: "passed", reference_targets: targets });
    await json(referencePlanPath, { assignments });
    await json(firstReviewPath, { schema: "goldflow_fal_reference_visual_review_v1",
      rejections: repairIds.map(image_id => ({ image_id })) });
    const directivePath = path.join(referenceRoot, "review-success-v3.json");
    const directive = { schema: "goldflow_fal_reviewed_reference_success_repair_v1", status: "approved",
      reviewer: "test reviewer", note: "The accepted base yard remains the source of gate geometry.",
      visual_reference_plan_sha256: sha(await readFile(planPath)),
      reference_plan_sha256: sha(await readFile(referencePlanPath)),
      first_review_sha256: sha(await readFile(firstReviewPath)),
      repairs: repairIds.map((image_id, i) => ({ image_id,
        v2_assignment_sha256: v2.get(image_id).assignment.assignment_sha256,
        v2_result_sha256: v2.get(image_id).result.output_sha256,
        reference_image_id: sourceId, reference_sha256: sha(`original-${sourceId}`),
        finding: "The v2 gate no longer has the original yard's wooden V-braced leaves.",
        source_quote: i ? "The broken gate hung inward." : "The gatepost didn't hold.",
        replacement_prompt: `Use the supplied accepted yard base and preserve its exact dark wooden V-braced double gate, iron frame, and scale; depict only the ${image_id} state in one clean frame.` })) };
    await json(directivePath, directive);
    const checked = await validateFalReviewedReferenceSuccessRepair({ episodeDir, directivesPath: directivePath });
    assert.deepEqual(checked.ids, repairIds);
    assert.equal(checked.checked[0].source.reference_image_path, baseOutput);
    const states = (await falProductionStageStates({ episodeDir, identity })).stageStates;
    assert.equal(states.reference_generation.done, true);
    assert.equal(states.reference_image_approval.state, "blocked");
    assert.match(states.reference_image_approval.next_command_shape, /--action repair-successful-reviewed-references/);
    const status = { current_stage: "reference_image_approval", current_stage_state: "blocked",
      next_command_shape: states.reference_image_approval.next_command_shape };
    assert.equal(falBlockedStageRecoveryAdmission(status, { action: "repair-successful-reviewed-references",
      directives: directivePath, "confirm-spend": "exact_fal_reviewed_reference_success_v3" }).allowed, true);
    assert.equal(falBlockedStageRecoveryAdmission(status, { action: "repair-successful-reviewed-references",
      directives: "/tmp/other.json", "confirm-spend": "exact_fal_reviewed_reference_success_v3" }).allowed, false);
    assert.equal(commandStageFor("imagegen", "fal", { action: "repair-successful-reviewed-references" }, identity), "reference_image_approval");
    const stale = { ...directive, visual_reference_plan_sha256: "0".repeat(64) };
    await json(path.join(referenceRoot, "stale.json"), stale);
    await assert.rejects(validateFalReviewedReferenceSuccessRepair({ episodeDir,
      directivesPath: path.join(referenceRoot, "stale.json") }), /stale/);
    const broadened = { ...directive, repairs: [{ ...directive.repairs[0], image_id: "not_rejected_ref" }] };
    await json(path.join(referenceRoot, "broadened.json"), broadened);
    await assert.rejects(validateFalReviewedReferenceSuccessRepair({ episodeDir,
      directivesPath: path.join(referenceRoot, "broadened.json") }), /not in the original rejection set/);
    for (const id of repairIds) {
      const assignment = { image_id: id, assignment_sha256: `v3-${id}`,
        submission_receipt_path: path.join(referenceRoot, "review-repair-v3-submission-receipts", `${id}.json`),
        result_receipt_path: path.join(referenceRoot, "review-repair-v3-result-receipts", `${id}.json`) };
      await json(path.join(referenceRoot, "review-repair-v3-assignments", `${id}.json`), assignment);
      await json(assignment.submission_receipt_path, { schema: "goldflow_fal_submission_receipt_v1",
        image_id: id, assignment_sha256: assignment.assignment_sha256, request_id: `request-${id}` });
    }
    const pending = (await falProductionStageStates({ episodeDir, identity })).stageStates;
    assert.equal(pending.reference_generation.done, true);
    assert.match(pending.reference_image_approval.next_command_shape, /--action observe-successful-reviewed-references$/);
    for (const id of repairIds) {
      const output = path.join(episodeDir, "assets", "images", "reference-repairs", `${id}-v3.png`);
      await put(output, `v3-${id}`);
      await json(path.join(referenceRoot, "review-repair-v3-result-receipts", `${id}.json`),
        { output_path: output, output_sha256: sha(`v3-${id}`) });
    }
    const ready = (await falProductionStageStates({ episodeDir, identity })).stageStates;
    assert.equal(ready.reference_generation.done, true);
    assert.match(ready.reference_image_approval.next_command_shape, /--action finalize-reviewed-references$/);
    for (const id of repairIds) {
      const target = targets.find(row => row.ref_id === id);
      target.reference_image_path = path.join(episodeDir, "assets", "images", "reference-repairs", `${id}-v3.png`);
      target.conditioning_image_path = target.reference_image_path;
    }
    await json(planPath, { status: "passed", reference_targets: targets });
    const finalized = (await falProductionStageStates({ episodeDir, identity })).stageStates;
    assert.equal(finalized.reference_generation.done, true);
    assert.equal(finalized.reference_image_approval, undefined);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});
