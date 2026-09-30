import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hashFile } from "../lib/ltx-video-contract.mjs";
import { atomicWriteJsonPair } from "../ltx-video-generate.mjs";
import {
  isTransientLtxOmission,
  ltxCandidateId,
  mergeLtxApprovalDecisions,
  mergeLtxPlanForRepair,
  mergeLtxReportRowsForRepair,
  providerRetryDeadlineMs,
  providerRetryDelayMs,
} from "../lib/ltx-video-repair.mjs";

const execFile = promisify(execFileCb);

function planClip(imageId, sourceHash, startSec = 0) {
  return {
    image_id: imageId,
    scene_id: `scene_${imageId}`,
    visual_beat_id: `beat_${imageId}`,
    start_sec: startSec,
    cut_duration_sec: 5,
    duration_sec: 5,
    animation_sequence_id: `sequence_${imageId}`,
    sequence_mode: "standalone_shot",
    sequence_timeline_duration_sec: 5,
    coverage: [{
      image_id: imageId,
      image_sha256: sourceHash,
      source_offset_sec: 0,
      source_end_offset_sec: 5,
    }],
    start_frame_contract: { state: `${imageId} starts` },
    end_frame_contract: { state: `${imageId} ends` },
    provider_image_inputs: ["init_image"],
    source_image_path: `/fixtures/${imageId}-${sourceHash}.png`,
    source_image_sha256: sourceHash,
    source_prompt_sha256: `prompt_${sourceHash}`,
    motion_prompt: `Animate ${imageId}`,
    motion_prompt_sha256: `motion_${sourceHash}`,
    negative_prompt: "drift",
    candidate_count: 1,
  };
}

function reportRow(clip, status = "generated") {
  return {
    image_id: clip.image_id,
    candidate_id: ltxCandidateId(clip.image_id),
    candidate_index: 1,
    creative_generation_attempt: 1,
    automatic_generation_retry_allowed: false,
    scene_id: clip.scene_id,
    visual_beat_id: clip.visual_beat_id,
    start_sec: clip.start_sec,
    cut_duration_sec: clip.cut_duration_sec,
    requested_duration_sec: clip.duration_sec,
    animation_sequence_id: clip.animation_sequence_id,
    sequence_mode: clip.sequence_mode,
    sequence_timeline_duration_sec: clip.sequence_timeline_duration_sec,
    coverage: clip.coverage,
    start_frame_contract: clip.start_frame_contract,
    end_frame_contract: clip.end_frame_contract,
    source_image_path: clip.source_image_path,
    source_image_sha256: clip.source_image_sha256,
    source_prompt_sha256: clip.source_prompt_sha256,
    motion_prompt_sha256: clip.motion_prompt_sha256,
    request_id: status === "generated" ? `request_${clip.image_id}` : null,
    normalized_video_path: status === "generated" ? `/fixtures/${clip.image_id}.mp4` : null,
    normalized_video_sha256: status === "generated" ? `video_${clip.image_id}` : null,
    status,
    disposition: status === "generated" ? null : "accepted_still_fallback",
    omission_stage: status === "generated" ? null : "creative_generation_submission",
    error: status === "generated" ? null : "ModelsLab 429: try again in 30 minutes",
  };
}

const priorA = planClip("cut_a", "hash_a", 0);
const priorB = planClip("cut_b", "hash_b_old", 5);
const freshA = structuredClone(priorA);
const freshB = planClip("cut_b", "hash_b_new", 5);
const freshC = planClip("cut_c", "hash_c", 10);
const priorPlan = { clips: [priorA, priorB], clip_count: 2 };
const freshPlan = { clips: [freshA, freshB, freshC], clip_count: 3 };
const scope = new Set(["cut_b"]);

const mergedPlan = mergeLtxPlanForRepair({ freshPlan, priorPlan, scopeIds: scope });
assert.equal(mergedPlan.clip_count, 3);
assert.strictEqual(mergedPlan.clips[0], priorA, "untouched plan rows must remain object-exact");
assert.strictEqual(mergedPlan.clips[1], freshB, "scoped plan rows must use current source truth");
assert.strictEqual(mergedPlan.clips[2], freshC, "new full-plan rows must not be pruned");

assert.throws(
  () => mergeLtxPlanForRepair({
    freshPlan: { clips: [planClip("cut_a", "changed_outside_scope"), freshB] },
    priorPlan,
    scopeIds: scope,
  }),
  /changed outside repair scope/u,
);
const sourceStableCreativeDrift = structuredClone(priorA);
sourceStableCreativeDrift.animation_sequence_id = "renumbered_but_source_stable";
sourceStableCreativeDrift.source_prompt_sha256 = "planner_serialization_drift";
const preservedSourceStable = mergeLtxPlanForRepair({
  freshPlan: { clips: [sourceStableCreativeDrift, freshB] },
  priorPlan,
  scopeIds: scope,
  preserveUntouchedSourceStable: true,
});
assert.strictEqual(preservedSourceStable.clips[0], priorA);
assert.deepEqual(preservedSourceStable.preserved_untouched_source_stable_contract_image_ids, ["cut_a"]);
assert.equal(preservedSourceStable.preserved_untouched_source_stable_contract_count, 1);
assert.throws(
  () => mergeLtxPlanForRepair({
    freshPlan: { clips: [planClip("cut_a", "changed_outside_scope"), freshB] },
    priorPlan,
    scopeIds: scope,
    preserveUntouchedSourceStable: true,
  }),
  /changed outside repair scope/u,
);
assert.throws(
  () => mergeLtxPlanForRepair({
    freshPlan: { clips: [freshA, freshB] },
    priorPlan: { clips: [priorA, priorB, freshC] },
    scopeIds: scope,
  }),
  /cannot silently remove prior canonical clips/u,
);

const priorReportA = reportRow(priorA, "generated");
const priorReportB = reportRow(priorB, "omitted");
const repairedReportB = reportRow(freshB, "generated");
repairedReportB.creative_generation_attempt = 1;
const mergedRows = mergeLtxReportRowsForRepair({
  mergedPlan,
  priorReport: { clips: [priorReportA], omitted_clips: [priorReportB] },
  scopeIds: scope,
  scopedRows: [repairedReportB],
});
assert.equal(mergedRows.rows.length, 3);
assert.strictEqual(mergedRows.rows[0], priorReportA, "untouched report rows must remain object-exact");
assert.strictEqual(mergedRows.rows[1], repairedReportB);
assert.equal(mergedRows.rows[2].status, "omitted");
assert.equal(mergedRows.rows[2].disposition, "accepted_still_fallback");
assert.equal(mergedRows.generated.length, 2);
assert.equal(mergedRows.omitted.length, 1);

assert.equal(providerRetryDelayMs("Try again in 30 minutes."), 1_805_000);
assert.equal(providerRetryDelayMs("Try again in 45 seconds."), 50_000);
assert.equal(providerRetryDelayMs("hard failure"), null);
assert.equal(
  providerRetryDeadlineMs(null, null, Date.parse("2026-08-03T11:35:00.000Z")),
  null,
  "a newly eligible cut with no prior canonical row must have no inherited cooldown",
);
assert.equal(
  providerRetryDeadlineMs(
    { error: "Try again in 30 minutes." },
    "2026-08-03T11:30:00.000Z",
    Date.parse("2026-08-03T11:35:00.000Z"),
  ),
  Date.parse("2026-08-03T12:00:05.000Z"),
);
assert.equal(
  providerRetryDeadlineMs(
    { error: "Try again in 45 seconds." },
    null,
    Date.parse("2026-08-03T11:35:00.000Z"),
  ),
  Date.parse("2026-08-03T11:35:50.000Z"),
);
assert.equal(isTransientLtxOmission(priorReportB), true);
assert.equal(isTransientLtxOmission(null), false);
assert.equal(isTransientLtxOmission({ status: "omitted", error: "LTX request timed out after 900 seconds" }), true);
assert.equal(isTransientLtxOmission({ status: "omitted", error: "Non-JSON 524: upstream timeout" }), true);
assert.equal(isTransientLtxOmission({ status: "omitted", error: "operator disliked the motion" }), false);
assert.equal(isTransientLtxOmission({ status: "omitted", error: "provider failed policy validation" }), false);
assert.equal(isTransientLtxOmission({ status: "generated", error: "ModelsLab 429" }), false);

const priorDecisionA = {
  image_id: "cut_a",
  candidate_id: ltxCandidateId("cut_a"),
  decision: "accepted",
  source_image_sha256: priorReportA.source_image_sha256,
  video_sha256: priorReportA.normalized_video_sha256,
  reviewer: "original-reviewer",
  note: "Original decision",
};
const approvalReport = { clips: [priorReportA, repairedReportB] };
const repairedDecisions = mergeLtxApprovalDecisions({
  report: approvalReport,
  priorApproval: { decisions: [priorDecisionA] },
  approveIds: new Set([ltxCandidateId("cut_b")]),
  rejectIds: new Set(),
  reviewer: "repair-reviewer",
  note: "Inspected repaired cut",
  repairExisting: true,
});
assert.strictEqual(repairedDecisions[0], priorDecisionA, "untouched approval decisions must remain object-exact");
assert.equal(repairedDecisions[1].decision, "accepted");
assert.equal(repairedDecisions[1].reviewer, "repair-reviewer");
assert.throws(() => mergeLtxApprovalDecisions({
  report: approvalReport,
  priorApproval: { decisions: [priorDecisionA] },
  approveIds: new Set(),
  rejectIds: new Set(),
  reviewer: "",
  note: "",
  repairExisting: true,
}), /requires a current decision/u);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-ltx-repair-test-"));
const sourceAPath = path.join(tempDir, "source-a.png");
const sourceBPath = path.join(tempDir, "source-b.png");
const videoAPath = path.join(tempDir, "video-a.mp4");
const videoBPath = path.join(tempDir, "video-b.mp4");
await Promise.all([
  fs.writeFile(sourceAPath, "source-a"),
  fs.writeFile(sourceBPath, "source-b"),
  fs.writeFile(videoAPath, "video-a"),
  fs.writeFile(videoBPath, "video-b"),
]);
const cliClipA = {
  image_id: "cut_a",
  candidate_id: ltxCandidateId("cut_a"),
  source_image_path: sourceAPath,
  source_image_sha256: await hashFile(sourceAPath),
  normalized_video_path: videoAPath,
  normalized_video_sha256: await hashFile(videoAPath),
};
const cliClipB = {
  image_id: "cut_b",
  candidate_id: ltxCandidateId("cut_b"),
  source_image_path: sourceBPath,
  source_image_sha256: await hashFile(sourceBPath),
  normalized_video_path: videoBPath,
  normalized_video_sha256: await hashFile(videoBPath),
};
const preRepairReportHash = "pre-repair-report-hash";
const cliReportPath = path.join(tempDir, "ltx-report.json");
const cliApprovalPath = path.join(tempDir, "ltx-approval.json");
const cliPriorDecisionA = {
  image_id: cliClipA.image_id,
  candidate_id: cliClipA.candidate_id,
  decision: "accepted",
  source_image_sha256: cliClipA.source_image_sha256,
  video_sha256: cliClipA.normalized_video_sha256,
  reviewer: "original-reviewer",
  note: "Original inspected clip",
};
await fs.writeFile(cliReportPath, `${JSON.stringify({
  schema: "goldflow_ltx23_video_report_v1",
  status: "passed",
  proof: false,
  clips: [cliClipA, cliClipB],
  repair_history: [
    { prior_report_sha256: preRepairReportHash },
    { prior_report_sha256: "intermediate-repair-report-hash" },
  ],
})}\n`);
const cliPriorApproval = {
  schema: "goldflow_ltx23_video_approval_v1",
  status: "passed",
  report_sha256: preRepairReportHash,
  decisions: [cliPriorDecisionA, {
    image_id: "cut_removed",
    candidate_id: ltxCandidateId("cut_removed"),
    decision: "rejected",
    source_image_sha256: "removed-source",
    video_sha256: "removed-video",
    reviewer: "original-reviewer",
    note: "Prior clip later omitted by repair",
  }],
  reviewer: "original-reviewer",
  note: "Original review",
};
await fs.writeFile(cliApprovalPath, `${JSON.stringify(cliPriorApproval)}\n`);
await execFile(process.execPath, [
  path.resolve("scripts/ltx-video-approve.mjs"),
  "--episode-dir", tempDir,
  "--report", cliReportPath,
  "--output", cliApprovalPath,
  "--repair-existing", "true",
  "--approve-ids", cliClipB.candidate_id,
  "--reviewer", "repair-reviewer",
  "--note", "Inspected repaired clip B",
]);
const repairedApproval = JSON.parse(await fs.readFile(cliApprovalPath, "utf8"));
assert.deepEqual(repairedApproval.decisions[0], cliPriorDecisionA);
assert.equal(repairedApproval.decisions[1].decision, "accepted");
assert.equal(repairedApproval.report_sha256, await hashFile(cliReportPath));
assert.deepEqual(repairedApproval.decision_repair_history.at(-1).exact_candidate_ids, [cliClipB.candidate_id]);
assert.deepEqual(repairedApproval.decision_repair_history.at(-1).removed_candidate_ids, [ltxCandidateId("cut_removed")]);

const protectedApprovalPath = path.join(tempDir, "protected-approval.json");
await fs.writeFile(protectedApprovalPath, `${JSON.stringify(cliPriorApproval)}\n`);
const protectedBefore = await hashFile(protectedApprovalPath);
await assert.rejects(execFile(process.execPath, [
  path.resolve("scripts/ltx-video-approve.mjs"),
  "--episode-dir", tempDir,
  "--report", cliReportPath,
  "--output", protectedApprovalPath,
  "--repair-existing", "true",
  "--approve-ids", "unknown-candidate",
  "--reviewer", "repair-reviewer",
  "--note", "This must fail",
]), /Unknown LTX clip id/u);
assert.equal(await hashFile(protectedApprovalPath), protectedBefore, "failed scoped approval must not overwrite canonical approval");

const partialApprovalPath = path.join(tempDir, "partial-approval-protected.json");
await fs.writeFile(partialApprovalPath, `${JSON.stringify(cliPriorApproval)}\n`);
const partialApprovalBefore = await hashFile(partialApprovalPath);
await assert.rejects(execFile(process.execPath, [
  path.resolve("scripts/ltx-video-approve.mjs"),
  "--episode-dir", tempDir,
  "--report", cliReportPath,
  "--output", partialApprovalPath,
  "--approve-ids", cliClipA.candidate_id,
  "--reviewer", "partial-reviewer",
  "--note", "Incomplete on purpose",
]), /requires a current decision/u);
assert.equal(await hashFile(partialApprovalPath), partialApprovalBefore, "failed partial full review must preserve a passed approval");

const protectedReportPath = path.join(tempDir, "protected-report.json");
await fs.writeFile(protectedReportPath, `${JSON.stringify({
  schema: "goldflow_ltx23_video_report_v1",
  status: "passed",
  sentinel: "preserve-me",
})}\n`);
const protectedReportBefore = await hashFile(protectedReportPath);
await assert.rejects(execFile(process.execPath, [
  path.resolve("scripts/ltx-video-generate.mjs"),
  "--episode-dir", tempDir,
  "--output", protectedReportPath,
  "--cut-ids", "cut_a",
]), /scoped repair operation/u);
assert.equal(await hashFile(protectedReportPath), protectedReportBefore, "failed production scope must not overwrite a passed canonical report");

const transactionalPlanPath = path.join(tempDir, "transactional-plan.json");
const invalidReportTarget = path.join(tempDir, "report-target-directory");
await fs.writeFile(transactionalPlanPath, `${JSON.stringify({ sentinel: "old-plan" })}\n`);
await fs.mkdir(invalidReportTarget);
const transactionalPlanBefore = await hashFile(transactionalPlanPath);
await assert.rejects(
  atomicWriteJsonPair(
    transactionalPlanPath,
    { sentinel: "new-plan" },
    invalidReportTarget,
    { sentinel: "new-report" },
  ),
);
assert.equal(
  await hashFile(transactionalPlanPath),
  transactionalPlanBefore,
  "a failed report commit must roll the canonical plan back to its exact prior bytes",
);

console.log("ltx video repair tests passed");
