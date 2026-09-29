import { promises as fs } from "node:fs";
import path from "node:path";
import { falAdjudicationPath } from "./fal-ambiguous-adjudication.mjs";
import { falAmbiguousSubmissionAttempts, falRetryBudgetState, falSpendProjectionState, falProjectedSpendUsd } from "./fal-retry-budget.mjs";

async function exists(file) { return fs.access(file).then(() => true, () => false); }
async function read(file) { return JSON.parse(await fs.readFile(file, "utf8")); }

export function falBlockedStageRecoveryAdmission(status, flags = {}) {
  const action = String(flags.action ?? "");
  if (status?.current_stage === "image_generation" && status?.current_stage_state === "blocked"
    && action === "adjudicate-no-job")
    return { applicable: true, allowed: /--action adjudicate-no-job\b/.test(status.next_command_shape??""),
      reason: "No ambiguous Fal submission is current." };
  if (status?.current_stage === "image_generation" && status?.current_stage_state === "blocked"
    && action === "observe-bulk" && /submission attempt\(s\) lack request receipts/.test(status.stage_ledger?.find(row=>row.stage==="image_generation")?.evidence??""))
    return { applicable: true, allowed: true };
  const next = String(status?.next_command_shape ?? "");
  const referenceRecovery = status?.current_stage === "reference_generation";
  const reviewRecovery = status?.current_stage === "reference_image_approval";
  const bulkReviewRecovery = status?.current_stage === "image_output_qa";
  const recoveryActions = new Set(referenceRecovery
    ? ["repair-reference-failures", "observe-reference-repairs"]
    : reviewRecovery ? ["repair-reviewed-references", "observe-reviewed-references", "finalize-reviewed-references"]
    : bulkReviewRecovery ? ["repair-reviewed-bulk", "observe-reviewed-bulk", "finalize-reviewed-bulk"]
    : ["observe-bulk", "observe-holds", "recover-holds", "observe-transport-recovery", "repair-failures", "observe-repairs"]);
  if ((!referenceRecovery && !reviewRecovery && !bulkReviewRecovery && status?.current_stage !== "image_generation") || status?.current_stage_state !== "blocked") {
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
  const retryBudget = await exists(path.join(episodeDir, "visual_beat_plan.json"))
    ? await falRetryBudgetState(episodeDir) : null;
  const retryCapEvidence = retryBudget?.remaining_retries === 0
    ? `Fal paid retry cap reached (${retryBudget.paid_retry_submissions}/${retryBudget.retry_limit}, 10% of ${retryBudget.planned_frames} planned frames); hold additional paid repairs`
    : null;
  const contract = identity?.image_provider_options?.fal;
  const spend = contract ? await falSpendProjectionState({ episodeDir,
    warningBudgetUsd: contract.warning_budget_usd, hardBudgetUsd: contract.hard_budget_usd }) : null;
  const ambiguousAttempts = await falAmbiguousSubmissionAttempts(episodeDir);
  let projectedWithPendingBulkUsd = null;
  const withSpendState = stageStates => {
    if (!retryBudget && !spend && !ambiguousAttempts.length) return { stageStates };
    const annotated = Object.fromEntries(Object.entries(stageStates).map(([stage, state]) => {
      if (!state) return [stage, state];
      const retryNote = retryBudget
        ? `paid retries ${retryBudget.paid_retry_submissions}/${retryBudget.retry_limit}` : "";
      const spendNote = spend
        ? `projected submitted spend $${spend.projected_spend_usd}/$${spend.hard_budget_usd} (estimate only; actual billing unavailable)` : "";
      const forecastNote = projectedWithPendingBulkUsd !== null
        ? `projected episode spend including unsubmitted bulk $${projectedWithPendingBulkUsd}/$${contract.hard_budget_usd} (estimate only)` : "";
      const ambiguousNote = ambiguousAttempts.length
        ? `${ambiguousAttempts.length} Fal submission attempt(s) lack request receipts; reconcile before further paid dispatch` : "";
      const next = { ...state, evidence: [state.evidence, retryNote, spendNote, forecastNote, ambiguousNote].filter(Boolean).join("; ") };
      if (ambiguousAttempts.length && stage === "image_generation" && /--confirm-spend\b/.test(next.next_command_shape ?? "")) {
        next.state = "blocked";
        next.evidence += "; hold further paid submission";
        next.next_command_shape = ambiguousAttempts[0].submission_receipt_path.includes(`${path.sep}bulk${path.sep}submission-receipts${path.sep}`)
          ? `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action adjudicate-no-job --image-id ${ambiguousAttempts[0].image_id} --review-spec <absolute_reviewed_json>`
          : null;
      } else if ((spend?.hard_reached || projectedWithPendingBulkUsd >= contract?.hard_budget_usd || ambiguousAttempts.length)
        && /\bimagegen fal\b.*--confirm-spend\b/.test(next.next_command_shape ?? "")) {
        next.state = "blocked";
        next.evidence += "; hold further paid submission";
        delete next.next_command_shape;
      }
      return [stage, next];
    }));
    return { stageStates: annotated };
  };
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
      const effectivePath = await Promise.all(referencePlan.assignments.map(async row => {
        const reviewed = path.join(root, "reference", "review-repair-result-receipts", `${row.image_id}.json`);
        if (await exists(reviewed)) return (await read(reviewed)).output_path;
        return row.output_path;
      }));
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
        && referencePlan.assignments.every((row, index) => visualPlan.reference_targets.some(target =>
          target.ref_id === row.ref_id
          && [row.output_path, effectivePath[index]].includes(target.reference_image_path)
          && target.conditioning_image_path === target.reference_image_path));
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
            ? retryCapEvidence
              ? { state: "blocked", evidence: retryCapEvidence }
              : { state: "blocked", evidence: `Fal exact-reference failures or transport holds=${unresolved.filter(Boolean).length}; inspect exact receipts before scoped repair`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action repair-reference-failures --directives <absolute_reference_repair_directives.json> --confirm-spend exact_fal_reference_repair` }
            : { state: "missing", evidence: `Fal canonical references submitted=${submitted.filter(Boolean).length}/${submitted.length}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-references --confirm-spend exact_fal_reference_batch` };
    }
  }
  let reviewRepairState = null;
  if (earlyReferenceFork) {
    const reviewPath = path.join(root, "reference", "review-rejections.json");
    if (await exists(reviewPath)) {
      const review = await read(reviewPath);
      if (review?.schema !== "goldflow_fal_reference_visual_review_v1" || !Array.isArray(review.rejections) || !review.rejections.length) throw new Error("Invalid Fal reference visual review receipt.");
      const ids = review.rejections.map(row => row.image_id);
      const assignments = await Promise.all(ids.map(id => exists(path.join(root, "reference", "review-repair-assignments", `${id}.json`))));
      const results = await Promise.all(ids.map(id => exists(path.join(root, "reference", "review-repair-result-receipts", `${id}.json`))));
      const nativePlan = await read(path.join(episodeDir, "visual_reference_plan.json"));
      const materialized = results.every(Boolean) && review.rejections.every(row => {
        const expected = path.join(episodeDir, "assets", "images", "reference-repairs", `${row.image_id}-v2.png`);
        return nativePlan.reference_targets?.some(target => target.ref_id === row.image_id && target.reference_image_path === expected && target.conditioning_image_path === expected);
      });
      if (!materialized) reviewRepairState = !assignments.every(Boolean)
        ? retryCapEvidence
          ? { state: "blocked", evidence: retryCapEvidence }
          : { state: "blocked", evidence: `Exact visual reference repairs required=${ids.length}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action repair-reviewed-references --confirm-spend exact_fal_reviewed_reference_repair` }
        : !results.every(Boolean)
          ? { state: "blocked", evidence: `Exact visual reference repairs complete=${results.filter(Boolean).length}/${ids.length}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-reviewed-references` }
          : { state: "blocked", evidence: `Exact visual reference repairs complete=${ids.length}/${ids.length}; materialization pending`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action finalize-reviewed-references` };
    }
  }
  const revisionRequestPath = path.join(root, "validation-revision-request.json");
  const revisedPlanPath = path.join(root, "validation-plan-v2.json");
  const revisionRequested = await exists(revisionRequestPath);
  const revisionPrepared = await exists(revisedPlanPath);
  const planPath = revisionPrepared ? revisedPlanPath : path.join(root, "validation-plan.json");
  const reviewPath = path.join(root, revisionPrepared ? "validation-review-v2.json" : "validation-review.json");
  const plan = await exists(planPath) ? await read(planPath) : null;
  let next;
  if (revisionRequested && !revisionPrepared) next = `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action prepare-validation-revision`;
  else if (!plan) next = `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action prepare-validation`;
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
    if (spend) projectedWithPendingBulkUsd = falProjectedSpendUsd(spend.paid_submissions + submitted.filter(value => !value).length);
    const results = await Promise.all(bulk.assignments.map(row => exists(row.result_receipt_path)));
    const repairResults = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","repair-result-receipts",`${row.image_id}.json`))));
    const transportRecoveryResults = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","transport-recovery-result-receipts",`${row.image_id}.json`))));
    const adjudicatedResults = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","ambiguous-retry-result-receipts",`${row.image_id}.json`))));
    const effectiveResults = results.map((value,index) => value || repairResults[index] || transportRecoveryResults[index] || adjudicatedResults[index]);
    const failures = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","failure-receipts",`${row.image_id}.json`))));
    const holds = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","transport-holds",`${row.image_id}.json`))));
    const unsubmittedCount = submitted.filter(value => !value).length;
    const outstanding = submitted.filter((value,index) => value && !effectiveResults[index] && !failures[index] && !holds[index]).length;
    const failedUnresolved = failures.map((value,index) => value && !effectiveResults[index]);
    const heldUnresolved = holds.map((value,index) => value && !effectiveResults[index]);
    const concurrency = Number(bulk.concurrency ?? 1);
    const queueTarget = Math.min(100, concurrency * 10);
    if (effectiveResults.every(Boolean)) {
      const reportReady = await exists(path.join(episodeDir, `imagegen_report_${path.basename(episodeDir)}.json`));
      const ledgerReady = await exists(path.join(episodeDir, "cut_execution_ledger.json"));
      bulkState = reportReady && ledgerReady
        ? { done: true, evidence: `All ${bulk.assignments.length} Fal frames have exact request/result receipts, including scoped repair lineage` }
        : { state: "missing", evidence: `All ${bulk.assignments.length} Fal frames are complete; native image report and cut ledger need finalization`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action finalize-bulk` };
    }
    else if (heldUnresolved.some(Boolean)) {
      const recoverySubmitted = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","transport-recovery-submission-receipts",`${row.image_id}.json`))));
      const holdRechecked = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","hold-observation-receipts",`${row.image_id}.json`))));
      bulkState = recoverySubmitted.some((value,index)=>value&&heldUnresolved[index]&&!transportRecoveryResults[index])
        ? { state: "blocked", evidence: `${heldUnresolved.filter(Boolean).length} exact Fal transport recoveries are pending`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-transport-recovery` }
        : heldUnresolved.some((value,index)=>value&&!holdRechecked[index])
          ? { state: "blocked", evidence: `${heldUnresolved.filter(Boolean).length} exact Fal transport holds need a no-spend original-request recheck`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-holds` }
        : retryCapEvidence
          ? { state: "blocked", evidence: retryCapEvidence }
          : { state: "blocked", evidence: `${heldUnresolved.filter(Boolean).length} completed Fal requests have persistently unavailable result transport`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action recover-holds --directives <absolute_transport_recovery_directives.json> --confirm-spend exact_fal_transport_recovery` };
    }
    else if (failedUnresolved.some(Boolean)) {
      const repairSubmitted = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","repair-submission-receipts",`${row.image_id}.json`))));
      bulkState = repairSubmitted.some((value,index)=>value&&failedUnresolved[index]&&!repairResults[index])
        ? { state: "blocked", evidence: `${failedUnresolved.filter(Boolean).length} exact Fal repair is pending`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-repairs` }
        : retryCapEvidence
          ? { state: "blocked", evidence: retryCapEvidence }
          : { state: "blocked", evidence: `${failedUnresolved.filter(Boolean).length} exact Fal IDs need scoped repair`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action repair-failures --directives <absolute_repair_directives.json> --confirm-spend exact_fal_repair_batch` };
    }
    else if (unsubmittedCount > 0 && outstanding < queueTarget) bulkState = { state: "missing", evidence: `${submitted.filter(Boolean).length}/${bulk.assignments.length} Fal requests queued; filling ${queueTarget-outstanding} queue positions while provider enforces ${concurrency} active generations`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-bulk --limit ${Math.min(20,unsubmittedCount,queueTarget-outstanding)} --confirm-spend exact_fal_bulk_batch` };
    else if (outstanding > 0) bulkState = { state: "missing", evidence: `${effectiveResults.filter(Boolean).length}/${bulk.assignments.length} Fal frames complete; ${outstanding} submitted requests pending`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-bulk --limit 100` };
    else bulkState = { state: "missing", evidence: `${submitted.filter(Boolean).length}/${bulk.assignments.length} Fal requests submitted`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-bulk --limit 100 --confirm-spend exact_fal_bulk_batch` };
    const adjudicated = await Promise.all(bulk.assignments.map(row => exists(falAdjudicationPath(episodeDir,row.image_id))));
    const retrySubmitted = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","ambiguous-retry-submission-receipts",`${row.image_id}.json`))));
    const retryResults = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","ambiguous-retry-result-receipts",`${row.image_id}.json`))));
    const retryPending = adjudicated.findIndex((value,index)=>value&&!retrySubmitted[index]);
    if (retryPending >= 0) bulkState = { state: "missing", evidence: `Reviewed no-job adjudication awaits one conservative paid retry: ${bulk.assignments[retryPending].image_id}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-adjudicated --image-id ${bulk.assignments[retryPending].image_id} --confirm-spend exact_fal_ambiguous_retry` };
    else if (retrySubmitted.some((value,index)=>value&&!retryResults[index])) bulkState = { state: "missing", evidence: "Exact adjudicated retry is pending observation", next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-adjudicated` };
  }
  if (earlyReferenceFork) return withSpendState({
    reference_generation: referenceState,
    ...(reviewRepairState ? { reference_image_approval: reviewRepairState } : {}),
    image_generation: validationPassed
      ? bulkState ?? { state: "missing", evidence: "Awaiting Fal bulk preparation" }
      : { state: "missing", evidence: next ? "Fal collage validation is incomplete" : "Fal validation review did not pass", ...(next ? { next_command_shape: next } : {}) },
  });
  return withSpendState({
    reference_image_approval: validationPassed
      ? { done: true, evidence: `Fal eight-shot collage validation passed (${review.approved_ids.length}/8 usable)` }
      : { state: "missing", evidence: next ? "Fal collage validation is incomplete" : "Fal validation review did not pass", ...(next ? { next_command_shape: next } : {}) },
    image_generation: bulkState ?? { state: "missing", evidence: "Awaiting Fal validation approval" },
  });
}
