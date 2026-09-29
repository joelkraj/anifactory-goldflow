import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { falAdjudicationPath, validateFalNoJobAdjudication } from "../lib/fal-ambiguous-adjudication.mjs";
import { falAmbiguousSubmissionAttempts, falRetryBudgetState, assertFalRetryBudget } from "../lib/fal-retry-budget.mjs";
import { falProductionStageStates, falBlockedStageRecoveryAdmission } from "../lib/fal-production-state.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-no-job-"));
  const bulk = path.join(dir, "fal", "bulk");
  const id = "shot-missing";
  const assignment = { image_id:id, assignment_sha256:"a".repeat(64),
    run_identity_sha256:"b".repeat(64), prompt_sha256:"c".repeat(64),
    endpoint:"openai/gpt-image-2.5/sunburst/edit",
    submission_receipt_path:path.join(bulk,"submission-receipts",`${id}.json`),
    result_receipt_path:path.join(bulk,"result-receipts",`${id}.json`) };
  const attemptPath=path.join(bulk,"submission-receipts-attempts",`${id}.json`);
  await mkdir(path.dirname(attemptPath),{recursive:true});
  const at="2026-09-29T09:06:00.507Z";
  await writeFile(attemptPath,JSON.stringify({schema:"goldflow_fal_submission_attempt_v1",created_at:at,
    image_id:id,assignment_sha256:assignment.assignment_sha256,
    run_identity_sha256:assignment.run_identity_sha256,endpoint:assignment.endpoint,
    submission_receipt_path:assignment.submission_receipt_path,possible_paid_request:true}));
  await mkdir(path.dirname(assignment.submission_receipt_path),{recursive:true});
  const neighborIds=[];
  for(let i=0;i<19;i++){
    const requestId=`request-${i}`;neighborIds.push(requestId);
    await writeFile(path.join(path.dirname(assignment.submission_receipt_path),`neighbor-${i}.json`),
      JSON.stringify({schema:"goldflow_fal_submission_receipt_v1",image_id:`neighbor-${i}`,
        assignment_sha256:"d".repeat(64),request_id:requestId,endpoint:assignment.endpoint,
        submitted_at:i?"2026-09-29T09:06:02.000Z":"2026-09-29T09:05:59.000Z"}));
  }
  const evidence=path.join(dir,"reviewed-fal-history.txt");
  await writeFile(evidence,JSON.stringify({schema:"goldflow_fal_authenticated_history_evidence_v1",
    observed_at_utc:"2026-09-29T09:15:00Z",missing_assignment_image_id:id,missing_prompt_visible:false,
    all_visible_ids_match_local_submission_receipts:true,
    request_time_window_start_utc:"2026-09-29T09:05:58.000Z",request_time_window_end_utc:"2026-09-29T09:06:03.000Z",
    visible_request_ids_in_window:neighborIds}));
  const spec={schema:"goldflow_fal_no_job_adjudication_v1",image_id:id,
    assignment_sha256:assignment.assignment_sha256,prompt_sha256:assignment.prompt_sha256,
    endpoint:assignment.endpoint,attempt_sha256:sha(await readFile(attemptPath)),attempt_created_at:at,
    reviewer:"Test reviewer",note:"Checked the authenticated Recent History and exact neighboring request IDs.",
    ui_evidence_path:evidence,ui_evidence_sha256:sha(await readFile(evidence)),
    ui_evidence_summary:"All adjacent requests are present in Fal history and locally receipted; the exact missing prompt is absent.",
    observation_window_start:"2026-09-29T09:05:58.000Z",observation_window_end:"2026-09-29T09:06:03.000Z",
    adjacent_request_ids:neighborIds};
  const beatBytes=JSON.stringify({status:"passed",visual_beat_count:20,beats:Array.from({length:20},(_,i)=>({visual_beat_id:String(i)}))});
  await writeFile(path.join(dir,"visual_beat_plan.json"),beatBytes);
  await writeFile(path.join(dir,"visual_beat_approval.json"),JSON.stringify({status:"approved",visual_beat_plan_sha256:sha(beatBytes)}));
  await writeFile(path.join(dir,"fal","bulk-plan.json"),JSON.stringify({concurrency:1,assignments:[assignment]}));
  await writeFile(path.join(dir,"fal","validation-review.json"),JSON.stringify({status:"passed",approved_ids:[],rejected_ids:[]}));
  return {dir,assignment,attemptPath,spec};
}

test("reviewed no-job adjudication preserves the original attempt and counts a retry",async()=>{
  const f=await fixture();try{
    assert.equal((await falAmbiguousSubmissionAttempts(f.dir)).length,1);
    const row=await validateFalNoJobAdjudication({episodeDir:f.dir,assignment:f.assignment,spec:f.spec});
    const file=falAdjudicationPath(f.dir,f.assignment.image_id);
    await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(row));
    assert.equal((await falAmbiguousSubmissionAttempts(f.dir)).length,0);
    assert.equal(JSON.parse(await readFile(f.attemptPath,"utf8")).possible_paid_request,true);
    const retry={image_id:f.assignment.image_id,previous_assignment_sha256:f.assignment.assignment_sha256,
      submission_receipt_path:path.join(f.dir,"fal","bulk","ambiguous-retry-submission-receipts",`${f.assignment.image_id}.json`)};
    assert.equal((await assertFalRetryBudget({episodeDir:f.dir,assignments:[retry]})).requested_paid_retries,1);
    assert.equal((await falRetryBudgetState(f.dir)).paid_retry_submissions,0);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test("no-job adjudication rejects changed evidence, receipt, and missing neighbor",async()=>{
  const f=await fixture();try{
    await assert.rejects(validateFalNoJobAdjudication({episodeDir:f.dir,assignment:f.assignment,spec:{...f.spec,ui_evidence_sha256:"0".repeat(64)}}),/hash-matched UI evidence/);
    await assert.rejects(validateFalNoJobAdjudication({episodeDir:f.dir,assignment:f.assignment,spec:{...f.spec,adjacent_request_ids:["unknown",...f.spec.adjacent_request_ids.slice(1)]}}),/does not bind/);
    await writeFile(f.assignment.submission_receipt_path,"{}");
    await assert.rejects(validateFalNoJobAdjudication({episodeDir:f.dir,assignment:f.assignment,spec:f.spec}),/unresolved original attempt/);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test("blocked Fal status offers exact adjudication and guarded no-spend observation",async()=>{
  const f=await fixture();try{
    const state=await falProductionStageStates({episodeDir:f.dir,identity:{image_provider_options:{fal:{warning_budget_usd:30,hard_budget_usd:35}}}});
    assert.equal(state.stageStates.image_generation.state,"blocked");
    assert.match(state.stageStates.image_generation.next_command_shape,/--action adjudicate-no-job/);
    const status={current_stage:"image_generation",current_stage_state:"blocked",
      next_command_shape:state.stageStates.image_generation.next_command_shape,
      stage_ledger:[{stage:"image_generation",evidence:state.stageStates.image_generation.evidence}]};
    assert.equal(falBlockedStageRecoveryAdmission(status,{action:"observe-bulk"}).allowed,true);
    assert.equal(falBlockedStageRecoveryAdmission(status,{action:"adjudicate-no-job"}).allowed,true);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test("adjudicated bulk ID routes to one separate retry before ordinary bulk",async()=>{
  const f=await fixture();try{
    const receipt=await validateFalNoJobAdjudication({episodeDir:f.dir,assignment:f.assignment,spec:f.spec});
    const file=falAdjudicationPath(f.dir,f.assignment.image_id);
    await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(receipt));
    const identity={image_provider_options:{fal:{warning_budget_usd:30,hard_budget_usd:35}}};
    let state=await falProductionStageStates({episodeDir:f.dir,identity});
    assert.match(state.stageStates.image_generation.next_command_shape,/--action dispatch-adjudicated --image-id shot-missing/);
    const retryPath=path.join(f.dir,"fal","bulk","ambiguous-retry-submission-receipts",`${f.assignment.image_id}.json`);
    await mkdir(path.dirname(retryPath),{recursive:true});
    await writeFile(retryPath,JSON.stringify({schema:"goldflow_fal_submission_receipt_v1",
      image_id:f.assignment.image_id,assignment_sha256:"e".repeat(64),request_id:"retry-request"}));
    state=await falProductionStageStates({episodeDir:f.dir,identity});
    assert.match(state.stageStates.image_generation.next_command_shape,/--action observe-adjudicated/);
    assert.equal((await falRetryBudgetState(f.dir)).paid_retry_submissions,1);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test("an ambiguous adjudicated retry stays held without a second adjudication",async()=>{
  const f=await fixture();try{
    const receipt=await validateFalNoJobAdjudication({episodeDir:f.dir,assignment:f.assignment,spec:f.spec});
    const file=falAdjudicationPath(f.dir,f.assignment.image_id);
    await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(receipt));
    const retryPath=path.join(f.dir,"fal","bulk","ambiguous-retry-submission-receipts",`${f.assignment.image_id}.json`);
    const retryAttempt=path.join(f.dir,"fal","bulk","ambiguous-retry-submission-receipts-attempts",`${f.assignment.image_id}.json`);
    await mkdir(path.dirname(retryAttempt),{recursive:true});
    await writeFile(retryAttempt,JSON.stringify({schema:"goldflow_fal_submission_attempt_v1",
      image_id:f.assignment.image_id,assignment_sha256:"e".repeat(64),submission_receipt_path:retryPath}));
    const state=await falProductionStageStates({episodeDir:f.dir,
      identity:{image_provider_options:{fal:{warning_budget_usd:30,hard_budget_usd:35}}}});
    assert.equal(state.stageStates.image_generation.state,"blocked");
    assert.equal(state.stageStates.image_generation.next_command_shape,null);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test("queue drain observes receipted work after the adjudicated retry is submitted",async()=>{
  const f=await fixture();try{
    const receipt=await validateFalNoJobAdjudication({episodeDir:f.dir,assignment:f.assignment,spec:f.spec});
    const file=falAdjudicationPath(f.dir,f.assignment.image_id);
    await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(receipt));
    const bulk=path.join(f.dir,"fal","bulk");
    const retrySubmission=path.join(bulk,"ambiguous-retry-submission-receipts",`${f.assignment.image_id}.json`);
    const retryResult=path.join(bulk,"ambiguous-retry-result-receipts",`${f.assignment.image_id}.json`);
    await mkdir(path.dirname(retrySubmission),{recursive:true});
    await mkdir(path.dirname(retryResult),{recursive:true});
    await writeFile(retrySubmission,JSON.stringify({schema:"goldflow_fal_submission_receipt_v1",
      image_id:f.assignment.image_id,assignment_sha256:"e".repeat(64),request_id:"retry-request"}));
    await writeFile(retryResult,JSON.stringify({schema:"goldflow_fal_result_receipt_v1",request_id:"retry-request"}));
    const other={image_id:"other",submission_receipt_path:path.join(bulk,"submission-receipts","other.json"),
      result_receipt_path:path.join(bulk,"result-receipts","other.json")};
    await writeFile(other.submission_receipt_path,JSON.stringify({schema:"goldflow_fal_submission_receipt_v1",
      image_id:"other",assignment_sha256:"f".repeat(64),request_id:"other-request"}));
    await writeFile(path.join(f.dir,"fal","bulk-plan.json"),JSON.stringify({concurrency:1,assignments:[f.assignment,other]}));
    const state=await falProductionStageStates({episodeDir:f.dir,
      identity:{image_provider_options:{fal:{warning_budget_usd:30,hard_budget_usd:35}}}});
    assert.match(state.stageStates.image_generation.next_command_shape,/--action observe-bulk/);
    assert.match(state.stageStates.image_generation.evidence,/1 submitted requests pending/);
    assert.doesNotMatch(state.stageStates.image_generation.next_command_shape,/dispatch-bulk/);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
