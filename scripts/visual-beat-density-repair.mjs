#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { groupingLockHash } from "./lib/editorial-beat-director.mjs";
import { visualBeatDensityRepairAdmission, validateDensityRepairSpec } from "./lib/visual-beat-density-repair.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const flags = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  if (!args[index]?.startsWith("--") || !args[index + 1]) throw new Error("Density repair flags require explicit values.");
  flags[args[index].slice(2)] = args[index + 1];
}
const episodeDir = flags["episode-dir"] && path.resolve(flags["episode-dir"]);
if (!episodeDir) throw new Error("--episode-dir is required.");
flags["episode-dir"] = episodeDir;
const statusCall = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "run-status.mjs"),
  "--episode-dir", episodeDir], { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (statusCall.status !== 0) throw new Error(`Cannot read guarded run status: ${statusCall.stderr || statusCall.stdout}`);
const status = JSON.parse(statusCall.stdout);
const admission = visualBeatDensityRepairAdmission(status, flags);
if (!admission.allowed) throw new Error(`Workflow guard blocked density repair: ${admission.reason}.`);

const read = (name) => fs.readFile(path.join(episodeDir, name));
const [specBytes, identityBytes, scriptBytes, timedBytes, wordBytes, factsBytes, failedBytes, ledgerBytes,
  eventsBytes] = await Promise.all([
    fs.readFile(flags["repair-spec"]), read("run_identity.json"), read("script_clean.md"),
    read("timed_scene_plan.json"), read(`narration_word_timing_${status.identity.episode}.json`),
    read("story_fact_ledger.json"), read("visual_beat_plan.json"), read("planner_chunk_ledger.json"),
    read("execution_events.jsonl"),
  ]);
const spec = JSON.parse(specBytes);
validateDensityRepairSpec(spec, flags["beat-ids"]);
const failedPlan = JSON.parse(failedBytes);
if (spec.episode_dir !== episodeDir || spec.run_identity_sha256 !== sha256(identityBytes)
  || spec.source_script_sha256 !== sha256(scriptBytes)
  || spec.timed_scene_plan_sha256 !== sha256(timedBytes)
  || spec.word_timing_sha256 !== sha256(wordBytes)
  || spec.story_fact_ledger_sha256 !== sha256(factsBytes)
  || spec.failed_visual_beat_plan_sha256 !== sha256(failedBytes)
  || spec.planner_chunk_ledger_sha256 !== sha256(ledgerBytes)
  || failedPlan.schema !== "goldflow_visual_beat_plan_v1" || failedPlan.status !== "failed"
  || !String(failedPlan.error ?? "").startsWith("Closed visual beat timeline violates the hard density contract:")
  || !String(failedPlan.error).includes(`${spec.visual_beat_id}:`)) {
  throw new Error("Density repair spec is stale against the exact failed plan, source artifacts, or reviewed chunk ledger.");
}
if (await fs.stat(path.join(episodeDir, "visual_beat_approval.json")).catch(() => null)
  || await fs.stat(path.join(episodeDir, "visual_reference_plan.json")).catch(() => null)) {
  throw new Error("Density repair cannot replace an approved beat plan or a started reference plan.");
}
const events = eventsBytes.toString("utf8").split("\n").filter(Boolean).map(JSON.parse);
if (events.some((event) => event.event_type === "stage_started" && event.stage === "visual_reference_plan")) {
  throw new Error("Reference planning has already started.");
}
const failedExecution = [...events].reverse().find((event) => event.event_type === "stage_completed"
  && event.command === "visual beats" && event.status === "failed"
  && String(event.error ?? "").includes("Closed visual beat timeline violates the hard density contract:"));
if (failedExecution?.output_hashes?.["visual_beat_plan.json"] !== sha256(failedBytes)
  || failedExecution?.output_hashes?.["planner_chunk_ledger.json"] !== sha256(ledgerBytes)) {
  throw new Error("Failed guarded beat execution does not bind the current failed plan and reviewed chunk ledger.");
}
const original = events.find((event) => event.event_type === "stage_started"
  && event.execution_id === failedExecution?.execution_id && event.command === "visual beats");
if (!original || !Array.isArray(original.args)) throw new Error("Failed guarded visual beats invocation is missing.");
const allowedOriginal = new Set([
  "channel", "series", "week", "episode", "editorial-concurrency", "editorial-attempts",
  "editorial-chunk-atoms", "editorial-chunk-hard-max-atoms", "beat-timing-enforcement",
  "target-beat-sec", "max-beat-sec", "min-beat-sec", "hook-duration-sec",
  "hook-target-beat-sec", "hook-max-beat-sec", "hook-min-beat-sec",
  "retention-ramp-sec", "ramp-target-beat-sec", "ramp-max-beat-sec", "ramp-min-beat-sec",
  "model", "llm-model", "reasoning-effort", "editorial-provider", "retention-reset-evidence",
  "audiovisual-emphasis-spine", "resume-incomplete-chunks",
]);
const priorFlags = {};
for (let index = 0; index < original.args.length; index += 2) {
  const name = original.args[index]?.slice(2), value = original.args[index + 1];
  if (!original.args[index]?.startsWith("--") || !value || !allowedOriginal.has(name)) {
    throw new Error(`Prior beat invocation contains an unsupported flag: ${original.args[index]}.`);
  }
  priorFlags[name] = value;
}
const identity = JSON.parse(identityBytes);
if (["channel", "week", "episode"].some((key) => priorFlags[key] !== identity[key])
  || priorFlags.series !== (identity.series_slug ?? identity.series)
  || priorFlags["resume-incomplete-chunks"] !== "true"
  || priorFlags["beat-timing-enforcement"] !== "hard_max") {
  throw new Error("Prior beat invocation is not the exact locked failed recovery.");
}
const originalArgs = original.args.filter((value, index) => value !== "--resume-incomplete-chunks"
  && original.args[index - 1] !== "--resume-incomplete-chunks");

const lockPath = path.join(episodeDir, ".visual_beat_density_repair.lock");
const lock = await fs.open(lockPath, "wx").catch((error) => {
  if (error.code === "EEXIST") throw new Error("Another beat density repair is active or needs triage.");
  throw error;
});
let historyDir = null;
let attemptedPlanHash = null;
let attemptedApprovalHash = null;
try {
  const repairId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const historyRoot = path.join(episodeDir, "reports", "stages", "visual_beat_plan", "density_repairs");
  historyDir = path.join(historyRoot, repairId);
  await fs.mkdir(historyRoot, { recursive: true });
  await fs.mkdir(historyDir);
  await Promise.all([
    fs.writeFile(path.join(historyDir, "before_failed_plan.json"), failedBytes, { flag: "wx" }),
    fs.writeFile(path.join(historyDir, "reviewed_chunk_ledger.json"), ledgerBytes, { flag: "wx" }),
    fs.writeFile(path.join(historyDir, "repair_spec.json"), specBytes, { flag: "wx" }),
    fs.writeFile(path.join(historyDir, "prior_guarded_command.json"), jsonBytes({ args: original.args,
      execution_id: original.execution_id, completed_execution_id: failedExecution.execution_id }), { flag: "wx" }),
  ]);
  if (sha256(await read("visual_beat_plan.json")) !== sha256(failedBytes)
    || sha256(await read("planner_chunk_ledger.json")) !== sha256(ledgerBytes)) {
    throw new Error("Failed plan or chunk ledger changed during density repair preflight.");
  }
  const candidatePlanPath = path.join(historyDir, "candidate_plan.json");
  const candidateApprovalPath = path.join(historyDir, "candidate_approval.json");
  const repairArgs = [...originalArgs, "--reviewed-chunk-assembly", path.resolve(flags["repair-spec"]),
    "--density-beat-id", spec.visual_beat_id, "--cache-only", "true",
    "--output", candidatePlanPath, "--approval-output", candidateApprovalPath,
    "--density-failure-report", path.join(historyDir, "failure.json"),
    "--approved-by", spec.approved_by, "--note", spec.review_note];
  const child = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "visual-beat-plan.mjs"), ...repairArgs],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (child.status !== 0) {
    if (sha256(await read("visual_beat_plan.json")) !== sha256(failedBytes)) {
      throw new Error("Cache-only assembly failed and the active failed plan unexpectedly changed.");
    }
    throw new Error(`Cache-only reviewed beat assembly failed: ${child.stderr || child.stdout}`);
  }
  const [planBytes, candidateApprovalBytes] = await Promise.all([
    fs.readFile(candidatePlanPath), fs.readFile(candidateApprovalPath),
  ]);
  const plan = JSON.parse(planBytes), candidateApproval = JSON.parse(candidateApprovalBytes);
  if (plan.schema !== "goldflow_visual_beat_plan_v2" || plan.status !== "passed"
    || candidateApproval.status !== "approved"
    || candidateApproval.visual_beat_plan_path !== candidatePlanPath
    || candidateApproval.visual_beat_plan_sha256 !== sha256(planBytes)
    || candidateApproval.grouping_lock_sha256 !== groupingLockHash(plan.beats)
    || candidateApproval.approved_by !== spec.approved_by
    || candidateApproval.approval_note !== spec.review_note
    || plan.editorial_director?.reviewed_chunk_assembly?.provider_calls !== 0
    || plan.editorial_director?.reviewed_chunk_assembly?.split?.prior_visual_beat_id !== spec.visual_beat_id) {
    throw new Error("Cache-only density repair did not produce a current approved exact split.");
  }
  const receipt = { schema: "goldflow_visual_beat_density_repair_receipt_v1", status: "passed",
    repair_id: repairId, episode_dir: episodeDir,
    run_identity_sha256: sha256(identityBytes), source_script_sha256: sha256(scriptBytes),
    repair_spec_sha256: sha256(specBytes), previous_failed_visual_beat_plan_sha256: sha256(failedBytes),
    reviewed_chunk_ledger_sha256: sha256(ledgerBytes),
    approved_visual_beat_plan_sha256: sha256(planBytes),
    candidate_visual_beat_approval_sha256: sha256(candidateApprovalBytes),
    prior_visual_beat_id: spec.visual_beat_id,
    new_visual_beat_ids: plan.editorial_director.reviewed_chunk_assembly.split.new_visual_beat_ids,
    hold_seconds: plan.editorial_director.reviewed_chunk_assembly.split.hold_seconds,
    reused_reviewed_chunk_count: plan.editorial_director.reviewed_chunk_assembly.reviewed_outputs.length,
    provider_calls: 0, provider_cost_usd: 0, approved_by: spec.approved_by, review_note: spec.review_note,
    created_at: new Date().toISOString() };
  const receiptPath = path.join(historyDir, "receipt.json");
  const receiptBytes = jsonBytes(receipt);
  const activePlanPath = path.join(episodeDir, "visual_beat_plan.json");
  const activeApprovalPath = path.join(episodeDir, "visual_beat_approval.json");
  const approval = { ...candidateApproval,
    visual_beat_plan_path: activePlanPath,
    density_repair_receipt_path: receiptPath,
    density_repair_receipt_sha256: sha256(receiptBytes),
    previous_failed_visual_beat_plan_sha256: sha256(failedBytes),
  };
  const approvalBytes = jsonBytes(approval);
  await Promise.all([
    fs.writeFile(path.join(historyDir, "after_plan.json"), planBytes, { flag: "wx" }),
    fs.writeFile(path.join(historyDir, "after_approval.json"), approvalBytes, { flag: "wx" }),
  ]);
  if (sha256(await read("visual_beat_plan.json")) !== sha256(failedBytes)
    || await fs.stat(activeApprovalPath).catch(() => null)) {
    throw new Error("Active beat plan or approval changed before density repair promotion.");
  }
  const planTemp = `${activePlanPath}.${repairId}.tmp`;
  const approvalTemp = `${activeApprovalPath}.${repairId}.tmp`;
  await fs.writeFile(planTemp, planBytes, { flag: "wx" });
  await fs.writeFile(approvalTemp, approvalBytes, { flag: "wx" });
  attemptedPlanHash = sha256(planBytes);
  attemptedApprovalHash = sha256(approvalBytes);
  await fs.rename(planTemp, activePlanPath);
  await fs.rename(approvalTemp, activeApprovalPath);
  if (sha256(await read("visual_beat_plan.json")) !== attemptedPlanHash
    || sha256(await read("visual_beat_approval.json")) !== attemptedApprovalHash) {
    throw new Error("Promoted density plan or approval hash changed during verification.");
  }
  await fs.writeFile(receiptPath, receiptBytes, { flag: "wx" });
  console.log(JSON.stringify({ status: "passed", receipt_path: receiptPath,
    prior_visual_beat_id: spec.visual_beat_id, new_visual_beat_ids: receipt.new_visual_beat_ids,
    hold_seconds: receipt.hold_seconds, reused_reviewed_chunk_count: receipt.reused_reviewed_chunk_count,
    provider_calls: 0, provider_cost_usd: 0 }, null, 2));
} catch (error) {
  if (historyDir) {
    const activePlanPath = path.join(episodeDir, "visual_beat_plan.json");
    const activeApprovalPath = path.join(episodeDir, "visual_beat_approval.json");
    const activePlanHash = await fs.readFile(activePlanPath).then(sha256).catch(() => null);
    const activeApprovalHash = await fs.readFile(activeApprovalPath).then(sha256).catch(() => null);
    if (attemptedPlanHash && activePlanHash === attemptedPlanHash) {
      const rollbackPath = path.join(historyDir, "rollback_failed_plan.tmp");
      await fs.writeFile(rollbackPath, failedBytes, { flag: "wx" });
      await fs.rename(rollbackPath, activePlanPath);
    }
    if (attemptedApprovalHash && activeApprovalHash === attemptedApprovalHash) {
      await fs.rm(activeApprovalPath);
    }
    const finalPlanHash = await fs.readFile(activePlanPath).then(sha256).catch(() => null);
    const finalApprovalExists = Boolean(await fs.stat(activeApprovalPath).catch(() => null));
    const failure = { schema: "goldflow_visual_beat_density_repair_failure_v1", status: "failed",
      episode_dir: episodeDir, visual_beat_id: spec.visual_beat_id,
      original_failed_plan_sha256: sha256(failedBytes), final_active_plan_sha256: finalPlanHash,
      final_active_approval_exists: finalApprovalExists,
      error: error instanceof Error ? error.message : String(error), created_at: new Date().toISOString() };
    await fs.writeFile(path.join(historyDir, "failure.json"), jsonBytes(failure), { flag: "wx" }).catch(() => {});
    if (finalPlanHash !== sha256(failedBytes) || finalApprovalExists) {
      throw new Error(`Density repair failed and active artifacts require triage: ${error.message}`);
    }
  }
  throw error;
} finally {
  await lock.close();
  await fs.rm(lockPath, { force: true });
}
