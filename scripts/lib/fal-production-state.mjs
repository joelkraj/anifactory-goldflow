import { promises as fs } from "node:fs";
import path from "node:path";

async function exists(file) { return fs.access(file).then(() => true, () => false); }
async function read(file) { return JSON.parse(await fs.readFile(file, "utf8")); }

export function falBlockedStageRecoveryAdmission(status, flags = {}) {
  const action = String(flags.action ?? "");
  const next = String(status?.next_command_shape ?? "");
  const referenceRecovery = status?.current_stage === "reference_generation";
  const recoveryActions = new Set(referenceRecovery
    ? ["repair-reference-failures", "observe-reference-repairs"]
    : ["observe-holds", "recover-holds", "observe-transport-recovery", "repair-failures", "observe-repairs"]);
  if ((!referenceRecovery && status?.current_stage !== "image_generation") || status?.current_stage_state !== "blocked") {
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

export async function falProductionStageStates({ episodeDir, identity } = {}) {
  const root = path.join(episodeDir, "fal");
  const earlyReferenceFork = identity?.visual_restart?.fork_at === "visual_reference_plan";
  let referenceState = null;
  if (earlyReferenceFork) {
    const referencePlanPath = path.join(root, "reference-plan.json");
    const referencePlan = await exists(referencePlanPath) ? await read(referencePlanPath) : null;
    if (!referencePlan) referenceState = { state: "missing", evidence: "Fal canonical reference assignments are missing", next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action prepare-references` };
    else {
      const submitted = await Promise.all(referencePlan.assignments.map(row => exists(row.submission_receipt_path)));
      const originalResults = await Promise.all(referencePlan.assignments.map(row => exists(row.result_receipt_path)));
      const repairResults = await Promise.all(referencePlan.assignments.map(row => exists(path.join(root, "reference", "repair-result-receipts", `${row.image_id}.json`))));
      const repairSubmitted = await Promise.all(referencePlan.assignments.map(row => exists(path.join(root, "reference", "repair-submission-receipts", `${row.image_id}.json`))));
      const completed = await Promise.all(referencePlan.assignments.map((row, index) =>
        (originalResults[index] || repairResults[index]) && exists(row.output_path)));
      const failures = await Promise.all(referencePlan.assignments.map(row => exists(path.join(root, "reference", "failure-receipts", `${row.image_id}.json`))));
      const holds = await Promise.all(referencePlan.assignments.map(row => exists(path.join(root, "reference", "transport-holds", `${row.image_id}.json`))));
      const unresolved = completed.map((value, index) => !value && (failures[index] || holds[index]));
      const pendingOriginal = submitted.some((value,index) => value && !completed[index] && !failures[index] && !holds[index]);
      const pendingRepair = repairSubmitted.some((value,index) => value && !repairResults[index]);
      const probes = [
        referencePlan.assignments.findIndex(row => row.endpoint?.endsWith("/edit")),
        referencePlan.assignments.findIndex(row => row.endpoint?.endsWith("/text-to-image")),
      ].filter((index, position, all) => index >= 0 && all.indexOf(index) === position);
      const pendingProbe = probes.find(index => !completed[index] && !failures[index] && !holds[index]);
      const visualPlan = completed.every(Boolean) ? await read(path.join(episodeDir, "visual_reference_plan.json")) : null;
      const materialized = visualPlan?.reference_targets?.length === referencePlan.assignments.length
        && referencePlan.assignments.every(row => visualPlan.reference_targets.some(target =>
          target.ref_id === row.ref_id && target.reference_image_path === row.output_path
          && target.conditioning_image_path === row.output_path));
      referenceState = completed.every(Boolean)
        ? materialized
          ? { done: true, evidence: `Fal canonical references=${completed.length}/${completed.length}, all hash-bound result receipts and local plan paths present` }
          : { state: "missing", evidence: `Fal canonical references=${completed.length}/${completed.length}; approved plan paths need materialization`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action finalize-references` }
        : pendingProbe != null
            ? { state: "missing", evidence: `Fal low-quality endpoint probes passed=${probes.filter(index => completed[index]).length}/${probes.length}`, next_command_shape: submitted[pendingProbe]
              ? `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action billing-observe-reference --image-id ${referencePlan.assignments[pendingProbe].image_id}`
              : `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action billing-submit-reference --image-id ${referencePlan.assignments[pendingProbe].image_id} --confirm-spend exact_fal_reference_probe` }
          : pendingOriginal
            ? { state: "missing", evidence: `Fal canonical references=${completed.filter(Boolean).length}/${completed.length}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-references` }
          : pendingRepair
            ? { state: "blocked", evidence: "Exact Fal reference repair is pending", next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-reference-repairs` }
          : unresolved.some(Boolean)
            ? { state: "blocked", evidence: `Fal exact-reference failures or transport holds=${unresolved.filter(Boolean).length}; inspect exact receipts before scoped repair`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action repair-reference-failures --directives <absolute_reference_repair_directives.json> --confirm-spend exact_fal_reference_repair` }
            : { state: "missing", evidence: `Fal canonical references submitted=${submitted.filter(Boolean).length}/${submitted.length}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-references --confirm-spend exact_fal_reference_batch` };
    }
  }
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
    const transportRecoveryResults = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","transport-recovery-result-receipts",`${row.image_id}.json`))));
    const effectiveResults = results.map((value,index) => value || repairResults[index] || transportRecoveryResults[index]);
    const failures = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","failure-receipts",`${row.image_id}.json`))));
    const holds = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","transport-holds",`${row.image_id}.json`))));
    const unsubmittedCount = submitted.filter(value => !value).length;
    if (effectiveResults.every(Boolean)) {
      const reportReady = await exists(path.join(episodeDir, `imagegen_report_${path.basename(episodeDir)}.json`));
      const ledgerReady = await exists(path.join(episodeDir, "cut_execution_ledger.json"));
      bulkState = reportReady && ledgerReady
        ? { done: true, evidence: `All ${bulk.assignments.length} Fal frames have exact request/result receipts, including scoped repair lineage` }
        : { state: "missing", evidence: `All ${bulk.assignments.length} Fal frames are complete; native image report and cut ledger need finalization`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action finalize-bulk` };
    }
    else if (unsubmittedCount > 0) bulkState = { state: "missing", evidence: `${submitted.filter(Boolean).length}/${bulk.assignments.length} Fal requests queued; provider enforces ${bulk.concurrency} active requests`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-bulk --limit ${Math.min(100,unsubmittedCount)} --confirm-spend exact_fal_bulk_batch` };
    else if (holds.some((value,index)=>value&&!effectiveResults[index]) && submitted.every(Boolean) && submitted.every((value,index) => !value || results[index] || failures[index] || holds[index])) {
      const recoverySubmitted = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","transport-recovery-submission-receipts",`${row.image_id}.json`))));
      bulkState = recoverySubmitted.some((value,index)=>value&&!transportRecoveryResults[index])
        ? { state: "blocked", evidence: `${holds.filter((value,index)=>value&&!effectiveResults[index]).length} exact Fal transport recoveries are pending`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-transport-recovery` }
        : { state: "blocked", evidence: `${holds.filter((value,index)=>value&&!effectiveResults[index]).length} completed Fal requests have persistently unavailable result transport`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action recover-holds --directives <absolute_transport_recovery_directives.json> --confirm-spend exact_fal_transport_recovery` };
    }
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
  if (earlyReferenceFork) return { stageStates: {
    reference_generation: referenceState,
    image_generation: validationPassed
      ? bulkState ?? { state: "missing", evidence: "Awaiting Fal bulk preparation" }
      : { state: "missing", evidence: next ? "Fal collage validation is incomplete" : "Fal validation review did not pass", ...(next ? { next_command_shape: next } : {}) },
  }};
  return { stageStates: {
    reference_image_approval: validationPassed
      ? { done: true, evidence: `Fal eight-shot collage validation passed (${review.approved_ids.length}/8 usable)` }
      : { state: "missing", evidence: next ? "Fal collage validation is incomplete" : "Fal validation review did not pass", ...(next ? { next_command_shape: next } : {}) },
    image_generation: bulkState ?? { state: "missing", evidence: "Awaiting Fal validation approval" },
  }};
}
