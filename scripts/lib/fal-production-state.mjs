import { promises as fs } from "node:fs";
import path from "node:path";

async function exists(file) { return fs.access(file).then(() => true, () => false); }
async function read(file) { return JSON.parse(await fs.readFile(file, "utf8")); }

export async function falProductionStageStates({ episodeDir } = {}) {
  const root = path.join(episodeDir, "fal");
  const planPath = path.join(root, "validation-plan.json");
  const reviewPath = path.join(root, "validation-review.json");
  const plan = await exists(planPath) ? await read(planPath) : null;
  let next;
  if (!plan) next = `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action prepare-validation`;
  else {
    const submissions = await Promise.all(plan.assignments.map((row) => exists(row.submission_receipt_path)));
    const results = await Promise.all(plan.assignments.map((row) => exists(row.result_receipt_path)));
    if (!submissions[0]) next = `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action billing-submit --confirm-spend exact_fal_validation_probe`;
    else if (!results[0]) next = `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action billing-observe`;
    else if (submissions.some((value) => !value)) next = `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-validation --confirm-spend exact_fal_validation_set`;
    else if (results.some((value) => !value)) next = `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-validation`;
    else if (!await exists(reviewPath)) next = `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action review-validation --reviewer <name> --note "<production-grade visual review>" --approve-ids <ids> --reject-ids <ids>`;
  }
  const review = await exists(reviewPath) ? await read(reviewPath) : null;
  const validationPassed = review?.status === "passed";
  const bulkPath = path.join(root, "bulk-plan.json"); const bulk = await exists(bulkPath) ? await read(bulkPath) : null;
  let bulkState;
  if (validationPassed && !bulk) bulkState = { state: "missing", evidence: "Fal bulk plan is missing", next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action prepare-bulk --image-ids all` };
  else if (bulk) {
    const submitted = await Promise.all(bulk.assignments.map(row => exists(row.submission_receipt_path)));
    const results = await Promise.all(bulk.assignments.map(row => exists(row.result_receipt_path)));
    if (results.every(Boolean)) bulkState = { done: true, evidence: `All ${bulk.assignments.length} Fal frames have exact request/result receipts` };
    else if (submitted.some((value,index) => value && !results[index])) bulkState = { state: "missing", evidence: `${results.filter(Boolean).length}/${bulk.assignments.length} Fal frames complete`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-bulk --limit 100` };
    else bulkState = { state: "missing", evidence: `${submitted.filter(Boolean).length}/${bulk.assignments.length} Fal requests submitted`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-bulk --limit 100 --confirm-spend exact_fal_bulk_batch` };
  }
  return { stageStates: {
    reference_image_approval: validationPassed
      ? { done: true, evidence: `Fal eight-shot collage validation passed (${review.approved_ids.length}/8 usable)` }
      : { state: "missing", evidence: next ? "Fal collage validation is incomplete" : "Fal validation review did not pass", ...(next ? { next_command_shape: next } : {}) },
    image_generation: bulkState ?? { state: "missing", evidence: "Awaiting Fal validation approval" },
  }};
}
