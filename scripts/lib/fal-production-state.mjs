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
  return { stageStates: {
    reference_image_approval: validationPassed
      ? { done: true, evidence: `Fal eight-shot collage validation passed (${review.approved_ids.length}/8 usable)` }
      : { state: "missing", evidence: next ? "Fal collage validation is incomplete" : "Fal validation review did not pass", ...(next ? { next_command_shape: next } : {}) },
    image_generation: { state: "missing", evidence: validationPassed ? "Fal bulk generation has not started" : "Awaiting Fal validation approval", ...(validationPassed ? { next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action prepare-bulk --image-ids <next_exact_image_ids>` } : {}) },
  }};
}
