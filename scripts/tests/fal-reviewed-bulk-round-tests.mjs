import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviewedBulkRepairRound } from "../lib/fal-reviewed-bulk-round.mjs";
import { falFailureReceiptPath } from "../lib/fal-failure-receipt.mjs";
import { reviewedBulkQaRepairStatusForTests } from "../run-status.mjs";
import { reviewedBulkHoldRecoveryPrompt } from "../lib/fal-reviewed-bulk-hold-recovery.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const put = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };
const json = async (file, value) => put(file, `${JSON.stringify(value)}\n`);

test("a later reviewed Fal cut uses a fresh QA-bound round and keeps the prior repair immutable", async () => {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-reviewed-bulk-round-"));
  try {
    const id = "ep_01-w008815-w008835";
    const root = path.join(episodeDir, "fal");
    const assignmentDir = path.join(root, "bulk", "review-repair-assignments");
    const qaPath = path.join(episodeDir, "image_output_qa_ep_01.json");
    const imagePath = path.join(root, "bulk", "review-repair-outputs", `${id}-v2.png`);
    await put(imagePath, "first reviewed replacement");
    const selectedSha = sha("first reviewed replacement");
    await json(path.join(episodeDir, "cut_execution_ledger.json"), {
      cuts: [{ image_id: id, image_path: imagePath, image_sha256: selectedSha }],
    });
    const firstQaHash = sha("first blocked QA");
    const legacyPath = path.join(assignmentDir, `${id}.json`);
    const legacy = { image_id: id, qa_report_sha256: firstQaHash, rejected_image_sha256: sha("original image"),
      submission_receipt_path: path.join(root, "bulk", "review-repair-submission-receipts", `${id}.json`),
      result_receipt_path: path.join(root, "bulk", "review-repair-result-receipts", `${id}.json`) };
    await json(legacyPath, legacy);
    const originalLegacyBytes = await readFile(legacyPath);
    await json(legacy.result_receipt_path, { output_path: imagePath, output_sha256: selectedSha });
    const qa = { status: "blocked", critical_rejected_image_ids: [id] };
    await json(qaPath, qa);
    const currentQaHash = sha(await readFile(qaPath));
    const initial = await reviewedBulkQaRepairStatusForTests(episodeDir, qa, qaPath);
    assert.deepEqual(initial, { next: "repair-reviewed-bulk", assignedCount: 0, completeCount: 0, totalCount: 1 });
    const round = await reviewedBulkRepairRound({ root, imageId: id,
      qaReportSha256: currentQaHash, rejectedImageSha256: selectedSha });
    assert.equal(round.stem, `${id}--${currentQaHash}`);
    assert.equal(round.assignment, null);
    const second = { image_id: id, qa_report_sha256: currentQaHash, rejected_image_sha256: selectedSha,
      submission_receipt_path: path.join(root, "bulk", "review-repair-submission-receipts", `${round.stem}.json`),
      result_receipt_path: path.join(root, "bulk", "review-repair-result-receipts", `${round.stem}.json`) };
    assert.equal(falFailureReceiptPath(second), path.join(root, "bulk", "review-repair-failure-receipts", `${round.stem}.json`));
    await json(round.assignmentPath, second);
    assert.deepEqual(await reviewedBulkQaRepairStatusForTests(episodeDir, qa, qaPath),
      { next: "observe-reviewed-bulk", assignedCount: 1, completeCount: 0, totalCount: 1 });
    await json(second.result_receipt_path, { output_path: path.join(root, "bulk", "review-repair-outputs", `${round.stem}.png`),
      output_sha256: sha("second reviewed replacement") });
    assert.deepEqual(await reviewedBulkQaRepairStatusForTests(episodeDir, qa, qaPath),
      { next: "finalize-reviewed-bulk", assignedCount: 1, completeCount: 1, totalCount: 1 });
    assert.deepEqual(await readFile(legacyPath), originalLegacyBytes);
    await assert.rejects(reviewedBulkRepairRound({ root, imageId: id,
      qaReportSha256: currentQaHash, rejectedImageSha256: sha("tampered raster") }), /conflicts/);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("the first reviewed Fal cut retains its original per-ID artifact naming", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "goldflow-reviewed-bulk-first-"));
  try {
    const id = "ep_01-w000001-w000010", qaHash = sha("QA"), rasterHash = sha("raster");
    const round = await reviewedBulkRepairRound({ root, imageId: id,
      qaReportSha256: qaHash, rejectedImageSha256: rasterHash });
    assert.equal(round.stem, id);
    assert.equal(round.assignmentPath, path.join(root, "bulk", "review-repair-assignments", `${id}.json`));
    assert.equal(round.assignment, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a terminal reviewed hold admits only one exact QA-bound recovery and preserves the original assignment", async () => {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-reviewed-bulk-held-"));
  try {
    const id="ep_01-w015901-w015923",root=path.join(episodeDir,"fal");
    const qaPath=path.join(episodeDir,"image_output_qa_ep_01.json");
    const imagePath=path.join(root,"bulk","original.png");
    await put(imagePath,"rejected raster");
    await json(qaPath,{status:"blocked",critical_rejected_image_ids:[id]});
    const qaHash=sha(await readFile(qaPath)),rasterHash=sha("rejected raster");
    await json(path.join(episodeDir,"cut_execution_ledger.json"),{cuts:[{image_id:id,image_path:imagePath,image_sha256:rasterHash}]});
    const scriptPath=path.join(episodeDir,"script_clean.md");
    await put(scriptPath,"Then Mara was beside me.\n");
    const round=await reviewedBulkRepairRound({root,imageId:id,qaReportSha256:qaHash,rejectedImageSha256:rasterHash});
    const from="White speech bubble above Mara: “Just one opening.”";
    const prompt=`Enclosed underground control chamber, Mara and Joey brace one shield. ${from}\n\nReference instructions remain unchanged.`;
    const original={image_id:id,qa_report_sha256:qaHash,rejected_image_sha256:rasterHash,
      assignment_sha256:sha("reviewed assignment"),prompt,
      submission_receipt_path:path.join(root,"bulk","review-repair-submission-receipts",`${id}.json`),
      result_receipt_path:path.join(root,"bulk","review-repair-result-receipts",`${id}.json`)};
    const requestId="01a0fc2c-bc72-72a2-93d9-8a6302a01e26";
    original.prompt_sha256=sha(prompt);original.endpoint="openai/gpt-image-2.5/sunburst/edit";
    original.run_identity_sha256=sha("identity");
    await json(round.assignmentPath,original);
    const submission={schema:"goldflow_fal_submission_receipt_v1",image_id:id,
      assignment_sha256:original.assignment_sha256,request_id:requestId,prompt_sha256:original.prompt_sha256,
      endpoint:original.endpoint,run_identity_sha256:original.run_identity_sha256};
    await json(original.submission_receipt_path,submission);
    const holdPath=path.join(root,"bulk","transport-holds",`${id}.json`);
    const hold={image_id:id,assignment_sha256:original.assignment_sha256,request_id:requestId,
      reason:"provider_5xx_during_observation",billable_request_resubmitted:false};
    await json(holdPath,hold);
    const directivePath=path.join(root,"bulk","review-repair-transport-recovery-directives",`${id}.json`);
    const directive={schema:"goldflow_fal_reviewed_bulk_hold_recovery_v1",image_id:id,qa_report_sha256:qaHash,
      round_stem:id,rejected_image_sha256:rasterHash,hold_sha256:sha(await readFile(holdPath)),
      failed_assignment_sha256:original.assignment_sha256,failed_request_id:requestId,
      terminal_provider_evidence:{request_id:requestId,http_status:504,result:"failed",cost_display:"-",
        url:`https://fal.ai/dashboard/recent-history?s_requestId=${requestId}`},
      reviewer:"visual QA",note:"Provider UI shows a terminal failed request with no billed result.",
      source_quote:"Then Mara was beside me.",prompt_patch:{from,to:""}};
    await json(directivePath,directive);
    const lockedScript=await readFile(scriptPath,"utf8"),lockedHoldSha=sha(await readFile(holdPath));
    assert.equal(reviewedBulkHoldRecoveryPrompt({directive,qaReportSha256:qaHash,round,assignment:original,
      submission,hold,holdSha256:lockedHoldSha,scriptText:lockedScript}),
      prompt.replace(from,""));
    assert.throws(()=>reviewedBulkHoldRecoveryPrompt({directive:{...directive,
      terminal_provider_evidence:{...directive.terminal_provider_evidence,cost_display:"$0.05"}},
      qaReportSha256:qaHash,round,assignment:original,submission,hold,
      holdSha256:lockedHoldSha,scriptText:lockedScript}),
      /terminal 504\/no-cost/);
    assert.throws(()=>reviewedBulkHoldRecoveryPrompt({directive:{...directive,prompt_patch:{from,to:"New lettering"}},
      qaReportSha256:qaHash,round,assignment:original,submission,hold,
      holdSha256:lockedHoldSha,scriptText:lockedScript}),
      /deleting exactly one/);
    assert.deepEqual(await reviewedBulkQaRepairStatusForTests(episodeDir,{critical_rejected_image_ids:[id]},qaPath),{
      next:"recover-reviewed-bulk-hold",assignedCount:0,completeCount:0,totalCount:1,
      heldRecovery:{id,directivePath,pendingSubmission:true}});
    const recoveryPath=path.join(root,"bulk","review-repair-transport-recovery-assignments",`${id}.json`);
    const recovery={image_id:id,previous_assignment_sha256:original.assignment_sha256,
      source_hold_sha256:sha(await readFile(holdPath)),reviewed_directive_sha256:sha(await readFile(directivePath)),
      source_script_sha256:sha(await readFile(scriptPath)),assignment_sha256:sha("recovery"),
      submission_receipt_path:path.join(root,"bulk","review-repair-transport-recovery-submission-receipts",`${id}.json`),
      result_receipt_path:path.join(root,"bulk","review-repair-transport-recovery-result-receipts",`${id}.json`),
      output_path:path.join(root,"bulk","review-repair-transport-recovery-outputs",`${id}.png`),previous_request_id:requestId};
    await json(recoveryPath,recovery);
    await json(recovery.submission_receipt_path,{assignment_sha256:recovery.assignment_sha256,request_id:"new-request"});
    assert.equal((await reviewedBulkQaRepairStatusForTests(episodeDir,{critical_rejected_image_ids:[id]},qaPath)).next,
      "observe-reviewed-bulk");
    await put(recovery.output_path,"recovered raster");
    await json(recovery.result_receipt_path,{request_id:"new-request",output_path:recovery.output_path,
      output_sha256:sha("recovered raster")});
    assert.equal((await reviewedBulkQaRepairStatusForTests(episodeDir,{critical_rejected_image_ids:[id]},qaPath)).next,
      "finalize-reviewed-bulk");
    await json(path.join(root,"bulk","review-repair-transport-recovery-failure-receipts",`${id}.json`),{error_status:422});
    await assert.rejects(reviewedBulkQaRepairStatusForTests(episodeDir,{critical_rejected_image_ids:[id]},qaPath),
      /provider failure receipt/);
    assert.equal(falFailureReceiptPath(recovery),path.join(root,"bulk","review-repair-transport-recovery-failure-receipts",`${id}.json`));
  } finally { await rm(episodeDir,{recursive:true,force:true}); }
});
