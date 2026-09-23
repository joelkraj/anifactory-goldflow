import { promises as fs } from "node:fs";
import path from "node:path";

async function exists(file) { return fs.access(file).then(() => true, () => false); }
async function read(file) { return JSON.parse(await fs.readFile(file, "utf8")); }

export function falBlockedStageRecoveryAdmission(status, flags = {}) {
  const action = String(flags.action ?? "");
  const next = String(status?.next_command_shape ?? "");
  const recoveryActions = new Set(["observe-holds", "repair-failures", "observe-repairs"]);
  if (status?.current_stage !== "image_generation" || status?.current_stage_state !== "blocked") {
    return { applicable: false, allowed: false, reason: "Fal blocked-stage recovery is not current." };
  }
  if (!recoveryActions.has(action)) {
    return { applicable: false, allowed: false, reason: "This is not a Fal blocked-stage recovery action." };
  }
  const expected = new RegExp(`\\bimagegen fal\\b[\\s\\S]*--action ${action}\\b`);
  return expected.test(next)
    ? { applicable: true, allowed: true }
    : { applicable: true, allowed: false, reason: "Run status does not authorize this exact Fal recovery action." };
}

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
    const repairResults = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","repair-result-receipts",`${row.image_id}.json`))));
    const effectiveResults = results.map((value,index) => value || repairResults[index]);
    const failures = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","failure-receipts",`${row.image_id}.json`))));
    const holds = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","transport-holds",`${row.image_id}.json`))));
    const unsubmittedCount = submitted.filter(value => !value).length;
    if (effectiveResults.every(Boolean)) bulkState = { done: true, evidence: `All ${bulk.assignments.length} Fal frames have exact request/result receipts, including scoped repair lineage` };
    else if (unsubmittedCount > 0) bulkState = { state: "missing", evidence: `${submitted.filter(Boolean).length}/${bulk.assignments.length} Fal requests queued; provider enforces ${bulk.concurrency} active requests`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-bulk --limit ${Math.min(100,unsubmittedCount)} --confirm-spend exact_fal_bulk_batch` };
    else if (holds.some((value,index)=>value&&!results[index]) && submitted.every(Boolean) && submitted.every((value,index) => !value || results[index] || failures[index] || holds[index])) bulkState = { state: "blocked", evidence: `${holds.filter((value,index)=>value&&!results[index]).length} completed Fal requests await exact result transport`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-holds` };
    else if (failures.some(Boolean) && submitted.every(Boolean) && submitted.every((value,index) => !value || results[index] || failures[index] || holds[index])) {
      const repairSubmitted = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","repair-submission-receipts",`${row.image_id}.json`))));
      bulkState = repairSubmitted.some((value,index)=>value&&!repairResults[index])
        ? { state: "blocked", evidence: `${failures.filter(Boolean).length} exact Fal repair is pending`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-repairs` }
        : { state: "blocked", evidence: `${failures.filter(Boolean).length} exact Fal IDs need scoped repair`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action repair-failures --directives <absolute_repair_directives.json> --confirm-spend exact_fal_repair_batch` };
    }
    else if (submitted.some((value,index) => value && !results[index] && !failures[index] && !holds[index])) {
      const outstanding = submitted.filter((value,index) => value && !results[index] && !failures[index] && !holds[index]).length;
      const unsubmitted = submitted.filter(value => !value).length;
      const concurrency = Number(bulk.concurrency ?? 1);
      bulkState = unsubmitted > 0 && outstanding < concurrency
        ? { state: "missing", evidence: `${results.filter(Boolean).length}/${bulk.assignments.length} Fal frames complete; filling ${concurrency-outstanding} idle provider slots`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-bulk --limit ${concurrency-outstanding} --confirm-spend exact_fal_bulk_batch` }
        : { state: "missing", evidence: `${results.filter(Boolean).length}/${bulk.assignments.length} Fal frames complete`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-bulk --limit 100` };
    }
    else bulkState = { state: "missing", evidence: `${submitted.filter(Boolean).length}/${bulk.assignments.length} Fal requests submitted`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-bulk --limit 100 --confirm-spend exact_fal_bulk_batch` };
  }
  return { stageStates: {
    reference_image_approval: validationPassed
      ? { done: true, evidence: `Fal eight-shot collage validation passed (${review.approved_ids.length}/8 usable)` }
      : { state: "missing", evidence: next ? "Fal collage validation is incomplete" : "Fal validation review did not pass", ...(next ? { next_command_shape: next } : {}) },
    image_generation: bulkState ?? { state: "missing", evidence: "Awaiting Fal validation approval" },
  }};
}
