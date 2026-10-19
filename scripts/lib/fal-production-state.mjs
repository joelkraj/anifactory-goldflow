import { promises as fs } from "node:fs";
import path from "node:path";
import { falAdjudicationPath } from "./fal-ambiguous-adjudication.mjs";
import { falAmbiguousSubmissionAttempts, falRetryBudgetState, falSpendProjectionState, falProjectedSpendUsd } from "./fal-retry-budget.mjs";
import { validateFalValidationCorrection, validateFalValidationRecovery } from "./fal-validation-recovery.mjs";
import { validateFalPrebulkPromptCorrection } from "./fal-prebulk-prompt-correction.mjs";
import { inspectFalPostplanPromptCorrection } from "./fal-postplan-prompt-correction.mjs";
import { validateFalReviewedReferenceSuccessRepair } from "./fal-reviewed-reference-success-repair.mjs";
import { inspectReferenceProbeReview, referenceProbeReviewStage } from "./fal-reference-probe-review.mjs";

async function exists(file) { return fs.access(file).then(() => true, () => false); }
async function read(file) { return JSON.parse(await fs.readFile(file, "utf8")); }

async function reviewedSecondRepair(root, imageId) {
  const directivePath = path.join(root, "bulk", "repair-v2-directives", `${imageId}.json`);
  if (!await exists(directivePath)) return null;
  try {
    const [directive, assignment, failure] = await Promise.all([
      read(directivePath), read(path.join(root, "bulk", "repair-assignments", `${imageId}.json`)),
      read(path.join(root, "bulk", "repair-failure-receipts", `${imageId}.json`)),
    ]);
    return directive.schema === "goldflow_fal_failed_repair_directive_v1" && directive.image_id === imageId
      && assignment.image_id === imageId && failure.image_id === imageId
      && directive.failed_repair_assignment_sha256 === assignment.assignment_sha256
      && directive.failed_repair_assignment_sha256 === failure.assignment_sha256
      && directive.failed_repair_request_id === failure.request_id
      && typeof directive.replacement_prompt === "string" && directive.replacement_prompt.length > 40
      && typeof directive.repair_reason === "string" && directive.repair_reason.trim()
      && typeof directive.reviewer === "string" && directive.reviewer.trim()
      && typeof directive.note === "string" && directive.note.trim() ? directivePath : null;
  } catch { return null; }
}

export function falBlockedStageRecoveryAdmission(status, flags = {}) {
  const action = String(flags.action ?? "");
  if(["dispatch-validation-second","observe-validation-second","review-validation-second"].includes(action)) {
    const extra=action==="dispatch-validation-second"?["confirm-spend"]:action==="review-validation-second"?["reviewer","note","approve-ids","reject-ids"]:[];
    return {applicable:true,allowed:status.current_stage==="image_generation"&&["missing","blocked"].includes(status.current_stage_state)
      &&flags["episode-dir"]===status.episode_dir&&String(status.next_command_shape??"").includes(`--action ${action}`)
      &&Object.keys(flags).sort().join(',')===["episode-dir","action",...extra].sort().join(',')
      &&(action!=="dispatch-validation-second"||flags["confirm-spend"]==="exact_fal_validation_second"),
      reason:"Only the exact status-directed reviewed second validation repair is allowed."};
  }
  if (["prepare-reference-probe-repair", "dispatch-reference-probe-repair", "observe-reference-probe-repair", "review-reference-probe-repair"].includes(action)) {
    const extra=action==="dispatch-reference-probe-repair"?["confirm-spend"]:action==="review-reference-probe-repair"?["reviewer","note"]:[];
    return {applicable:true,allowed:status.current_stage==="reference_generation"&&status.current_stage_state==="blocked"
      &&flags["episode-dir"]===status.episode_dir
      &&String(status.next_command_shape??"").includes(`--action ${action}`)
      &&Object.keys(flags).sort().join(',')===["episode-dir","action",...extra].sort().join(',')
      &&(action!=="dispatch-reference-probe-repair"||flags["confirm-spend"]==="exact_fal_reference_probe_repair"),
      reason:"Only the exact status-directed reference-probe correction is allowed."};
  }
  if (status?.current_stage === "reference_image_approval" && status?.current_stage_state === "blocked"
    && action === "repair-failed-reviewed-reference") {
    const id = String(flags["image-id"] ?? "");
    const directives = String(flags.directives ?? "");
    return { applicable: true, allowed: /^[a-z0-9][a-z0-9_-]{1,100}$/.test(id)
      && String(status.next_command_shape ?? "").endsWith(`--action repair-failed-reviewed-reference --image-id ${id} --directives ${directives} --confirm-spend exact_fal_reviewed_reference_v3`)
      && flags["confirm-spend"] === "exact_fal_reviewed_reference_v3" && path.isAbsolute(directives),
      reason: "Current status does not authorize this exact reviewed-reference second repair." };
  }
  if (status?.current_stage === "reference_image_approval" && status?.current_stage_state === "blocked"
    && action === "repair-successful-reviewed-references") {
    const directives = String(flags.directives ?? "");
    return { applicable: true, allowed: path.isAbsolute(directives)
      && String(status.next_command_shape ?? "").endsWith(`--action repair-successful-reviewed-references --directives ${directives} --confirm-spend exact_fal_reviewed_reference_success_v3`)
      && flags["confirm-spend"] === "exact_fal_reviewed_reference_success_v3",
      reason: "Current status does not authorize this exact successful-reference second repair." };
  }
  if (status?.current_stage === "image_generation" && status?.current_stage_state === "blocked"
    && action === "repair-failed-repair") {
    const id = String(flags["image-id"] ?? "");
    const directives = String(flags.directives ?? "");
    return { applicable: true, allowed: /^[a-z0-9][a-z0-9_-]{1,100}$/.test(id)
      && String(status.next_command_shape ?? "").endsWith(`--action repair-failed-repair --image-id ${id} --directives ${directives} --confirm-spend exact_fal_repair_v2`)
      && flags["confirm-spend"] === "exact_fal_repair_v2" && path.isAbsolute(directives),
      reason: "Current status does not authorize this reviewed exact Fal second repair." };
  }
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
    ? ["observe-reference-holds", "recover-reference-holds", "observe-reference-transport-recovery", "repair-reference-failures", "observe-reference-repairs"]
    : reviewRecovery ? ["repair-reviewed-references", "observe-reviewed-references", "observe-failed-reviewed-reference", "observe-successful-reviewed-references", "finalize-reviewed-references"]
    : bulkReviewRecovery ? ["repair-reviewed-bulk", "recover-reviewed-bulk-hold", "observe-reviewed-bulk", "finalize-reviewed-bulk"]
    : ["observe-bulk", "observe-holds", "recover-holds", "observe-transport-recovery", "repair-failures", "observe-repairs", "inspect-repair-failure", "observe-repair-v2"]);
  if ((!referenceRecovery && !reviewRecovery && !bulkReviewRecovery && status?.current_stage !== "image_generation") || status?.current_stage_state !== "blocked") {
    return { applicable: false, allowed: false, reason: "Fal blocked-stage recovery is not current." };
  }
  if (!recoveryActions.has(action)) {
    return { applicable: false, allowed: false, reason: "This is not a Fal blocked-stage recovery action." };
  }
  const expected = new RegExp(`\\bimagegen fal\\b[\\s\\S]*--action ${action}\\b`);
  if (action === "inspect-repair-failure" || action === "observe-repair-v2" || action === "observe-failed-reviewed-reference") {
    const imageId = String(flags["image-id"] ?? "");
    return { applicable: true, allowed: /^[a-z0-9][a-z0-9_-]{1,100}$/.test(imageId)
      && next.includes(`--action ${action} --image-id ${imageId}`),
      reason: "Run status does not authorize inspection of this exact Fal repair failure." };
  }
  if (action === "recover-reviewed-bulk-hold") {
    const imageId = String(flags["image-id"] ?? "");
    const directive = String(flags.directives ?? "");
    return { applicable: true, allowed: /^[a-z0-9][a-z0-9_-]{1,100}$/.test(imageId)
      && path.isAbsolute(directive)
      && flags["confirm-spend"] === "exact_fal_reviewed_bulk_hold_recovery"
      && next.includes(`--action ${action} --image-id ${imageId} --directives ${directive} --confirm-spend exact_fal_reviewed_bulk_hold_recovery`),
      reason: "Run status does not authorize this exact reviewed Fal transport hold recovery." };
  }
  if (action === "recover-reference-holds") {
    const directives = String(flags.directives ?? "");
    return { applicable: true, allowed: path.isAbsolute(directives)
      && flags["confirm-spend"] === "exact_fal_reference_transport_recovery"
      && next.includes("--action recover-reference-holds --directives <absolute_reference_transport_recovery_directives.json> --confirm-spend exact_fal_reference_transport_recovery"),
      reason: "Run status does not authorize reviewed Fal reference transport recovery." };
  }
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
      const transportResults = await Promise.all(referencePlan.assignments.map(row => exists(path.join(root, "reference", "transport-recovery-result-receipts", `${row.image_id}.json`))));
      const transportSubmitted = await Promise.all(referencePlan.assignments.map(row => exists(path.join(root, "reference", "transport-recovery-submission-receipts", `${row.image_id}.json`))));
      const transportFailures = await Promise.all(referencePlan.assignments.map(row => exists(path.join(root, "reference", "transport-recovery-failure-receipts", `${row.image_id}.json`))));
      const transportHolds = await Promise.all(referencePlan.assignments.map(row => exists(path.join(root, "reference", "transport-holds", `${row.image_id}-recovery.json`))));
      const repairSubmitted = await Promise.all(referencePlan.assignments.map(row => exists(path.join(root, "reference", "repair-submission-receipts", `${row.image_id}.json`))));
      const repairFailures = await Promise.all(referencePlan.assignments.map(row => exists(path.join(root, "reference", "repair-failure-receipts", `${row.image_id}.json`))));
      const effectivePath = await Promise.all(referencePlan.assignments.map(async row => {
        const reviewedV3 = path.join(root, "reference", "review-repair-v3-result-receipts", `${row.image_id}.json`);
        if (await exists(reviewedV3)) return (await read(reviewedV3)).output_path;
        const reviewed = path.join(root, "reference", "review-repair-result-receipts", `${row.image_id}.json`);
        if (await exists(reviewed)) return (await read(reviewed)).output_path;
        const transport = path.join(root, "reference", "transport-recovery-result-receipts", `${row.image_id}.json`);
        if (await exists(transport)) return (await read(transport)).output_path;
        return row.output_path;
      }));
      const reviewedV2Path = await Promise.all(referencePlan.assignments.map(async row => {
        const receiptPath = path.join(root, "reference", "review-repair-result-receipts", `${row.image_id}.json`);
        return await exists(receiptPath) ? (await read(receiptPath)).output_path : null;
      }));
      const completed = await Promise.all(referencePlan.assignments.map((row, index) =>
        (originalResults[index] || repairResults[index] || transportResults[index]) && exists(effectivePath[index])));
      const failures = await Promise.all(referencePlan.assignments.map(row => exists(path.join(root, "reference", "failure-receipts", `${row.image_id}.json`))));
      const holds = await Promise.all(referencePlan.assignments.map(row => exists(path.join(root, "reference", "transport-holds", `${row.image_id}.json`))));
      const heldUnresolved = completed.map((value, index) => !value && holds[index] && !failures[index]);
      const failedUnresolved = completed.map((value, index) => !value && failures[index]);
      const recheckedHolds = await Promise.all(referencePlan.assignments.map(row => exists(path.join(root, "reference", "hold-observation-receipts", `${row.image_id}.json`))));
      const pendingOriginal = submitted.some((value,index) => value && !completed[index] && !failures[index] && !holds[index]);
      const pendingRepair = repairSubmitted.some((value,index) => value && !repairResults[index]);
      const probes = [
        referencePlan.assignments.findIndex(row => row.endpoint?.endsWith("/edit")),
        referencePlan.assignments.findIndex(row => row.endpoint?.endsWith("/text-to-image")),
      ].filter((index, position, all) => index >= 0 && all.indexOf(index) === position);
      const pendingProbe = probes.find(index => !completed[index] && !failures[index] && !holds[index]);
      const visualPlan = completed.every(Boolean) ? await read(path.join(episodeDir, "visual_reference_plan.json")) : null;
      // Non-required manual_review targets are draft placeholders that prepare never assigns.
      const generatedTargets = (visualPlan?.reference_targets ?? []).filter(target =>
        target.required_before_imagegen === true || target.generation_mode === "standalone_ref");
      const materialized = generatedTargets.length === referencePlan.assignments.length
        && referencePlan.assignments.every((row, index) => visualPlan.reference_targets.some(target =>
          target.ref_id === row.ref_id
          && [row.output_path, reviewedV2Path[index], effectivePath[index]].filter(Boolean).includes(target.reference_image_path)
          && target.conditioning_image_path === target.reference_image_path));
      if (completed.every(Boolean)) referenceState = materialized
        ? { done: true, evidence: `Fal canonical references=${completed.length}/${completed.length}, all hash-bound result receipts and local plan paths present` }
        : { state: "missing", evidence: `Fal canonical references=${completed.length}/${completed.length}; approved plan paths need materialization`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action finalize-references` };
      else if (transportFailures.some((value,index)=>value&&!completed[index])
        || transportHolds.some((value,index)=>value&&!completed[index]))
        referenceState = { state: "blocked", evidence: "A paid Fal reference transport recovery failed or its result transport is held; inspect its exact immutable receipt before further spend" };
      else if (transportSubmitted.some((value,index)=>value&&!completed[index]&&!transportResults[index]))
        referenceState = { state: "blocked", evidence: "Exact Fal reference transport recovery is pending", next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-reference-transport-recovery` };
      else if (heldUnresolved.some((value,index)=>value&&!recheckedHolds[index]))
        referenceState = { state: "blocked", evidence: `${heldUnresolved.filter(Boolean).length} exact Fal reference transport hold(s) need a no-spend recheck of their original request IDs`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-reference-holds` };
      else if (heldUnresolved.some(Boolean)) referenceState = retryCapEvidence
        ? { state: "blocked", evidence: retryCapEvidence }
        : { state: "blocked", evidence: `${heldUnresolved.filter(Boolean).length} original Fal reference request(s) remained failed or transport-held after exact no-spend recheck; reviewed paid transport recovery may use the unchanged prompt`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action recover-reference-holds --directives <absolute_reference_transport_recovery_directives.json> --confirm-spend exact_fal_reference_transport_recovery` };
      else if (pendingProbe != null) referenceState = {
        state: "missing", evidence: `Fal low-quality endpoint probes passed=${probes.filter(index => completed[index]).length}/${probes.length}`,
        next_command_shape: submitted[pendingProbe]
          ? `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action billing-observe-reference --image-id ${referencePlan.assignments[pendingProbe].image_id}`
          : `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action billing-submit-reference --image-id ${referencePlan.assignments[pendingProbe].image_id} --confirm-spend exact_fal_reference_probe`,
      };
      else if (pendingOriginal) referenceState = { state: "missing", evidence: `Fal canonical references=${completed.filter(Boolean).length}/${completed.length}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-references` };
      else if (repairFailures.some((value,index)=>value&&!completed[index]))
        referenceState = { state: "blocked", evidence: `Fal reference repair failed for exact ID ${referencePlan.assignments[repairFailures.findIndex((value,index)=>value&&!completed[index])].image_id}; inspect immutable repair failure receipt before any new recovery decision` };
      else if (pendingRepair) referenceState = { state: "blocked", evidence: "Exact Fal reference repair is pending", next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-reference-repairs` };
      else if (failedUnresolved.some(Boolean)) referenceState = retryCapEvidence
        ? { state: "blocked", evidence: retryCapEvidence }
        : { state: "blocked", evidence: `Fal exact-reference failures=${failedUnresolved.filter(Boolean).length}; inspect exact receipts before scoped repair`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action repair-reference-failures --directives <absolute_reference_repair_directives.json> --confirm-spend exact_fal_reference_repair` };
      else referenceState = { state: "missing", evidence: `Fal canonical references submitted=${submitted.filter(Boolean).length}/${submitted.length}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-references --confirm-spend exact_fal_reference_batch` };
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
      const v3Assignments = await Promise.all(ids.map(id => exists(path.join(root, "reference", "review-repair-v3-assignments", `${id}.json`))));
      const v3Submissions = await Promise.all(ids.map(id => exists(path.join(root, "reference", "review-repair-v3-submission-receipts", `${id}.json`))));
      const v3Results = await Promise.all(ids.map(id => exists(path.join(root, "reference", "review-repair-v3-result-receipts", `${id}.json`))));
      const v2Failures = await Promise.all(ids.map(id => exists(path.join(root, "reference", "review-repair-failure-receipts", `${id}.json`))));
      const v3Failures = await Promise.all(ids.map(id => exists(path.join(root, "reference", "review-repair-v3-failure-receipts", `${id}.json`))));
      const effectiveResults = ids.map((_, index) => results[index] || v3Results[index]);
      const nativePlan = await read(path.join(episodeDir, "visual_reference_plan.json"));
      const materialized = effectiveResults.every(Boolean) && review.rejections.every((row, index) => {
        const expected = path.join(episodeDir, "assets", "images", "reference-repairs", `${row.image_id}-${v3Results[index] ? "v3" : "v2"}.png`);
        return nativePlan.reference_targets?.some(target => target.ref_id === row.image_id && target.reference_image_path === expected && target.conditioning_image_path === expected);
      });
      const v3FailedIndex = ids.findIndex((_, index) => v3Failures[index] && !effectiveResults[index]);
      const v2FailedIndex = ids.findIndex((_, index) => v2Failures[index] && !effectiveResults[index]);
      const secondRepairDirective = v2FailedIndex < 0 ? null
        : path.join(root, "reference", "review-repair-v3-directives", `${ids[v2FailedIndex]}.json`);
      const successDirectivePath = path.join(root, "reference", "review-success-v3.json");
      const hasSuccessDirective = await exists(successDirectivePath);
      const successIds = hasSuccessDirective ? (await read(successDirectivePath)).repairs?.map(row => row.image_id) ?? [] : [];
      const successMaterialized = hasSuccessDirective && successIds.length > 0 && successIds.every(id =>
        nativePlan.reference_targets?.some(target => target.ref_id === id
          && target.reference_image_path === path.join(episodeDir, "assets", "images", "reference-repairs", `${id}-v3.png`)
          && target.conditioning_image_path === target.reference_image_path));
      let successState = null;
      if (hasSuccessDirective && !successMaterialized) {
        const success = await validateFalReviewedReferenceSuccessRepair({
          episodeDir, directivesPath: successDirectivePath, allowExistingAttempts: true });
        const successAssignments = await Promise.all(success.ids.map(id => exists(path.join(root, "reference", "review-repair-v3-assignments", `${id}.json`))));
        const successSubmissions = await Promise.all(success.ids.map(id => exists(path.join(root, "reference", "review-repair-v3-submission-receipts", `${id}.json`))));
        const successResults = await Promise.all(success.ids.map(id => exists(path.join(root, "reference", "review-repair-v3-result-receipts", `${id}.json`))));
        const successFailures = await Promise.all(success.ids.map(id => exists(path.join(root, "reference", "review-repair-v3-failure-receipts", `${id}.json`))));
        successState = !successAssignments.every(Boolean)
          ? retryCapEvidence
            ? { state: "blocked", evidence: retryCapEvidence }
            : { state: "blocked", evidence: `Exact successful-reference visual redo required=${success.ids.join(",")}`,
              next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action repair-successful-reviewed-references --directives ${successDirectivePath} --confirm-spend exact_fal_reviewed_reference_success_v3` }
          : successFailures.some(Boolean)
            ? { state: "blocked", evidence: `Successful-reference visual redo failed for exact ID ${success.ids[successFailures.indexOf(true)]}; inspect immutable failure receipt` }
            : !successSubmissions.every(Boolean) || !successResults.every(Boolean)
              ? { state: "blocked", evidence: `Successful-reference visual redo complete=${successResults.filter(Boolean).length}/${success.ids.length}`,
                next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-successful-reviewed-references` }
              : { state: "blocked", evidence: `Successful-reference visual redo complete=${success.ids.length}/${success.ids.length}; materialization pending`,
                next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action finalize-reviewed-references` };
      }
      if (successState) reviewRepairState = successState;
      else if (!materialized) reviewRepairState = !assignments.every(Boolean)
        ? retryCapEvidence
          ? { state: "blocked", evidence: retryCapEvidence }
          : { state: "blocked", evidence: `Exact visual reference repairs required=${ids.length}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action repair-reviewed-references --confirm-spend exact_fal_reviewed_reference_repair` }
        : v3FailedIndex >= 0
          ? { state: "blocked", evidence: `Second reviewed-reference repair failed for exact ID ${ids[v3FailedIndex]}; inspect immutable provider failure receipt before another recovery decision` }
        : v2FailedIndex >= 0
          ? v3Assignments[v2FailedIndex] && v3Submissions[v2FailedIndex]
            ? { state: "blocked", evidence: `Second reviewed-reference repair submitted for exact ID ${ids[v2FailedIndex]}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-failed-reviewed-reference --image-id ${ids[v2FailedIndex]}` }
            : retryCapEvidence
              ? { state: "blocked", evidence: retryCapEvidence }
              : { state: "blocked", evidence: `Provider rejected reviewed reference ${ids[v2FailedIndex]}; record a changed, hash-bound exact prompt in ${secondRepairDirective}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action repair-failed-reviewed-reference --image-id ${ids[v2FailedIndex]} --directives ${secondRepairDirective} --confirm-spend exact_fal_reviewed_reference_v3` }
        : !effectiveResults.every(Boolean)
          ? { state: "blocked", evidence: `Exact visual reference repairs complete=${effectiveResults.filter(Boolean).length}/${ids.length}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-reviewed-references` }
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
  const correction = review ? await validateFalValidationCorrection({ root, validationPlanPath: planPath, validationReviewPath: reviewPath }) : null;
  const recovery = correction ? await validateFalValidationRecovery({ root, correction }) : null;
  let validationEvidence = "Fal validation review did not pass";
  if (correction) {
    if (!correction.recorded) next = `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action correct-validation-review`;
    else if (recovery.status === "plan_missing") next = `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action prepare-validation-recovery`;
    else if (recovery.status === "pending") {
      if (recovery.failures.some(Boolean) || recovery.holds.some(Boolean)) {
        next = null;
        validationEvidence = "Exact validation recovery has a failed or held provider result; inspect exact receipts before further spend";
      } else if (recovery.submissions.some(Boolean) && !recovery.submissions.every(Boolean)) {
        next = null;
        validationEvidence = "Exact validation recovery has a partial submission; inspect attempts before further spend";
      } else if (!recovery.submissions.some(Boolean)) {
        next = retryCapEvidence ? null : `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-validation-recovery --confirm-spend exact_fal_validation_recovery`;
        if (retryCapEvidence) validationEvidence = retryCapEvidence;
      } else if (!recovery.results.every(Boolean)) next = `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-validation-recovery`;
      else next = `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action review-validation-recovery --reviewer <name> --note "<exact visual review>" --approve-ids <ids> --reject-ids <ids>`;
    } else if(recovery.status === "second_pending") {
      const state=recovery.second.state;
      next=state==="submit"&&!retryCapEvidence?`node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-validation-second --confirm-spend exact_fal_validation_second`
        :state==="observe"?`node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-validation-second`
        :state==="review"?`node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action review-validation-second --reviewer <name> --note "<exact visual review>" --approve-ids <ids> --reject-ids <ids>`:null;
      validationEvidence=retryCapEvidence??"Explicit reviewed second validation repair; accepted shots remain immutable";
    } else if (recovery.status === "failed" || recovery.status === "second_failed") {
      next = null;
      validationEvidence = "Reviewed exact validation recovery still has rejected rasters; inspect immutable result/review before a further scoped decision";
    } else next = null;
  }
  const validationPassed = correction ? recovery?.status === "passed" : review?.status === "passed";
  if (validationPassed) await validateFalPrebulkPromptCorrection({ episodeDir,
    validationPlanPath: planPath, validationReviewPath: reviewPath });
  const bulkPath = path.join(root, "bulk-plan.json");
  const lockedBulk = await exists(bulkPath) ? await read(bulkPath) : null;
  let postplanCorrection = null, postplanError = null;
  if (lockedBulk) {
    try { postplanCorrection = await inspectFalPostplanPromptCorrection({ episodeDir, bulkPlan: lockedBulk }); }
    catch (error) { postplanError = error; }
  }
  const bulk = lockedBulk && postplanCorrection?.state === "applied"
    ? { ...lockedBulk, assignments: postplanCorrection.assignments } : lockedBulk;
  let bulkState;
  if (validationPassed && !bulk) bulkState = { state: "missing", evidence: "Fal bulk plan is missing", next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action prepare-bulk --image-ids all` };
  else if (bulk) {
    const submitted = await Promise.all(bulk.assignments.map(row => exists(row.submission_receipt_path)));
    const adjudicated = await Promise.all(bulk.assignments.map(row => exists(falAdjudicationPath(episodeDir,row.image_id))));
    const retrySubmitted = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","ambiguous-retry-submission-receipts",`${row.image_id}.json`))));
    const retryResults = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","ambiguous-retry-result-receipts",`${row.image_id}.json`))));
    const queued = submitted.map((value,index) => value || (adjudicated[index] && retrySubmitted[index]));
    const regularUnsubmittedCount = submitted.filter((value,index) => !value && !adjudicated[index]).length;
    const adjudicatedRetryPendingCount = adjudicated.filter((value,index) => value && !retrySubmitted[index]).length;
    if (spend) projectedWithPendingBulkUsd = falProjectedSpendUsd(spend.paid_submissions + regularUnsubmittedCount + adjudicatedRetryPendingCount);
    const results = await Promise.all(bulk.assignments.map(row => exists(row.result_receipt_path)));
    const repairResults = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","repair-result-receipts",`${row.image_id}.json`))));
    const repairFailures = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","repair-failure-receipts",`${row.image_id}.json`))));
    const repairV2Results = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","repair-v2-result-receipts",`${row.image_id}.json`))));
    const repairV2Failures = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","repair-v2-failure-receipts",`${row.image_id}.json`))));
    const repairV2Submitted = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","repair-v2-submission-receipts",`${row.image_id}.json`))));
    const repairV2Assigned = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","repair-v2-assignments",`${row.image_id}.json`))));
    const transportRecoveryResults = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","transport-recovery-result-receipts",`${row.image_id}.json`))));
    const adjudicatedResults = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","ambiguous-retry-result-receipts",`${row.image_id}.json`))));
    const effectiveResults = results.map((value,index) => value || repairResults[index] || repairV2Results[index] || transportRecoveryResults[index] || adjudicatedResults[index]);
    const failures = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","failure-receipts",`${row.image_id}.json`))));
    const holds = await Promise.all(bulk.assignments.map(row => exists(path.join(root,"bulk","transport-holds",`${row.image_id}.json`))));
    const unsubmittedCount = regularUnsubmittedCount;
    const outstanding = queued.filter((value,index) => value && !effectiveResults[index] && !failures[index] && !holds[index]).length;
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
      const failedRepairIndex = repairFailures.findIndex((value,index)=>value&&failedUnresolved[index]);
      const failedV2Index = repairV2Failures.findIndex((value,index)=>value&&failedUnresolved[index]);
      const pendingV2Index = repairV2Submitted.findIndex((value,index)=>value&&failedUnresolved[index]&&!repairV2Results[index]&&!repairV2Failures[index]);
      const unsubmittedV2Index = repairV2Assigned.findIndex((value,index)=>value&&failedUnresolved[index]&&!repairV2Submitted[index]);
      const failedRepairId = failedRepairIndex >= 0 ? bulk.assignments[failedRepairIndex].image_id : null;
      const reviewedV2Directive = failedRepairId ? await reviewedSecondRepair(root, failedRepairId) : null;
      bulkState = failedV2Index >= 0
        ? { state: "blocked", evidence: `Second Fal repair failed for exact ID ${bulk.assignments[failedV2Index].image_id}; inspect its immutable receipt and hold further paid retries` }
        : pendingV2Index >= 0
        ? { state: "blocked", evidence: `Second Fal repair is pending for exact ID ${bulk.assignments[pendingV2Index].image_id}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-repair-v2 --image-id ${bulk.assignments[pendingV2Index].image_id}` }
        : unsubmittedV2Index >= 0
        ? { state: "blocked", evidence: `Second Fal repair assignment exists without a submission receipt for exact ID ${bulk.assignments[unsubmittedV2Index].image_id}; reconcile the submission attempt before any paid action` }
        : reviewedV2Directive && !retryCapEvidence
        ? { state: "blocked", evidence: `Reviewed second Fal repair is ready for exact ID ${failedRepairId}; inspect the original and repair failure receipts before paid dispatch`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action repair-failed-repair --image-id ${failedRepairId} --directives ${reviewedV2Directive} --confirm-spend exact_fal_repair_v2` }
        : failedRepairIndex >= 0
        ? { state: "blocked", evidence: `Fal repair failed for exact ID ${failedRepairId}; inspect original and repair receipts before any new recovery decision${retryCapEvidence ? `; ${retryCapEvidence}` : ""}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action inspect-repair-failure --image-id ${failedRepairId}` }
        : repairSubmitted.some((value,index)=>value&&failedUnresolved[index]&&!repairResults[index])
        ? { state: "blocked", evidence: `${failedUnresolved.filter(Boolean).length} exact Fal repair is pending`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-repairs` }
        : retryCapEvidence
          ? { state: "blocked", evidence: retryCapEvidence }
          : { state: "blocked", evidence: `${failedUnresolved.filter(Boolean).length} exact Fal IDs need scoped repair`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action repair-failures --directives <absolute_repair_directives.json> --confirm-spend exact_fal_repair_batch` };
    }
    else if (unsubmittedCount > 0 && outstanding < queueTarget) bulkState = { state: "missing", evidence: `${queued.filter(Boolean).length}/${bulk.assignments.length} Fal requests queued; filling ${queueTarget-outstanding} queue positions while provider enforces ${concurrency} active generations`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-bulk --limit ${Math.min(20,unsubmittedCount,queueTarget-outstanding)} --confirm-spend exact_fal_bulk_batch` };
    else if (outstanding > 0) bulkState = { state: "missing", evidence: `${effectiveResults.filter(Boolean).length}/${bulk.assignments.length} Fal frames complete; ${outstanding} submitted requests pending`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-bulk --limit 100` };
    else bulkState = { state: "missing", evidence: `${queued.filter(Boolean).length}/${bulk.assignments.length} Fal requests submitted`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-bulk --limit 100 --confirm-spend exact_fal_bulk_batch` };
    const retryPending = adjudicated.findIndex((value,index)=>value&&!retrySubmitted[index]);
    if (retryPending >= 0) bulkState = { state: "missing", evidence: `Reviewed no-job adjudication awaits one conservative paid retry: ${bulk.assignments[retryPending].image_id}`, next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action dispatch-adjudicated --image-id ${bulk.assignments[retryPending].image_id} --confirm-spend exact_fal_ambiguous_retry` };
    else if (retrySubmitted.some((value,index)=>value&&!retryResults[index])) bulkState = { state: "missing", evidence: "Exact adjudicated retry is pending observation", next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action observe-adjudicated` };
  }
  if (postplanError) bulkState = { state: "blocked",
    evidence: `Fal post-plan prompt correction is invalid: ${postplanError.message}` };
  else if (postplanCorrection?.state === "pending") bulkState = { state: "missing",
    evidence: `Reviewed post-plan prompt correction for ${postplanCorrection.changed.size} unsubmitted cuts requires an append-only receipt before more paid dispatch`,
    next_command_shape: `node bin/goldflow.mjs imagegen fal --episode-dir ${episodeDir} --action apply-postplan-prompt-correction --request ${postplanCorrection.paths.request}` };
  if (earlyReferenceFork) {
    const probeReview=referenceProbeReviewStage(episodeDir,await inspectReferenceProbeReview(episodeDir));
    if(probeReview)referenceState=probeReview;
    return withSpendState({
    reference_generation: referenceState,
    ...(reviewRepairState ? { reference_image_approval: reviewRepairState } : {}),
    image_generation: validationPassed
      ? bulkState ?? { state: "missing", evidence: "Awaiting Fal bulk preparation" }
      : { state: next ? "missing" : "blocked", evidence: next ? "Fal collage validation is incomplete" : validationEvidence, ...(next ? { next_command_shape: next } : {}) },
    });
  }
  return withSpendState({
    reference_image_approval: validationPassed
      ? { done: true, evidence: `Fal eight-shot collage validation passed (${correction ? correction.expected.approved_ids.length + recovery.review.approved_ids.length : review.approved_ids.length}/8 usable)` }
      : { state: next ? "missing" : "blocked", evidence: next ? "Fal collage validation is incomplete" : validationEvidence, ...(next ? { next_command_shape: next } : {}) },
    image_generation: bulkState ?? { state: "missing", evidence: "Awaiting Fal validation approval" },
  });
}
