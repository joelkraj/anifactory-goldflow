import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { referencePlanApprovalContractSha256 } from "../lib/reference-plan-contract.mjs";
import { readReferenceImageQaRecoveryScope, referenceImageQaRecoveryAdmission } from "../lib/reference-image-recovery.mjs";
import { referenceGenerationCompleteForTests } from "../run-status.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-reference-image-recovery-"));
try {
  const identity = { channel: "test", series_slug: "test", week: "test", episode: "ep_01", image_provider: "federated_google_web_image_pool" };
  const scriptHash = hash("approved source");
  const images = [path.join(dir, "state_a.png"), path.join(dir, "state_b.png")];
  await fs.writeFile(images[0], "rejected a");
  await fs.writeFile(images[1], "rejected b");
  const plan = { status: "passed", source_script_hash: scriptHash, reference_targets: images.map((imagePath, index) => ({
    ref_id: `state_${index}`, kind: "character_state", generation_mode: "standalone_ref", required_before_imagegen: true,
    prompt_anchor: `Reviewed state ${index}`, conditioning_image_path: imagePath,
  })) };
  const planPath = path.join(dir, "visual_reference_plan.json");
  const reportPath = path.join(dir, "reference_image_qa_ep_01.json");
  const write = (file, value) => fs.writeFile(file, JSON.stringify(value));
  await write(planPath, plan);
  const report = { schema: "goldflow_reference_image_qa_v1", status: "blocked", source_script_hash: scriptHash,
    reference_plan_contract_sha256: referencePlanApprovalContractSha256(plan), reviewed_by: "fixture-reviewer",
    reviewed_at: "2026-09-12T21:45:00Z", reviewed_blocker_ids: ["state_0", "state_1"],
    findings: images.map((imagePath, index) => ({ severity: "blocker", ref_id: `state_${index}`,
      code: "confirmed_identity_mismatch", review_note: "Fixture reviewed mismatch", image_path: imagePath,
      image_sha256: hash(index ? "rejected b" : "rejected a") })) };
  const read = (currentPlan = plan, currentHash = scriptHash) => readReferenceImageQaRecoveryScope({ episodeDir: dir, episode: "ep_01", plan: currentPlan, currentScriptHash: currentHash });
  await write(reportPath, report);
  const scope = await read();
  assert.deepEqual(scope.rejected_ref_ids, ["state_0", "state_1"]);
  const status = { current_stage: "reference_generation", current_stage_state: "blocked", episode_dir: dir, identity,
    reference_image_qa_recovery_scope: scope };
  const flags = { channel: "test", series: "test", week: "test", episode: "ep_01", "references-only": "true",
    "reference-ids": "state_0,state_1", "qa-recovery": "true", "repair-reason": "Reviewed two exact identity mismatches" };
  assert.equal(referenceImageQaRecoveryAdmission(status, flags).allowed, true);
  const subset = referenceImageQaRecoveryAdmission(status, { ...flags, "reference-ids": "state_1" });
  assert.equal(subset.allowed, true);
  assert.deepEqual(subset.requested_ref_ids, ["state_1"]);
  assert.deepEqual(scope.rejected_ref_ids, ["state_0", "state_1"], "A subset must not clear the other blocker");
  for (const changed of [{}, { ...flags, "reference-ids": "" }, { ...flags, "reference-ids": "state_0,unknown" },
    { ...flags, "reference-ids": "state_0,state_0" }, { ...flags, "reference-ids": "state_0," },
    { ...flags, "qa-recovery": "false" }, { ...flags, "repair-reason": "" }, { ...flags, episode: "ep_02" },
    { ...flags, "reference-plan": "/other/plan.json" }, { ...flags, "image-ids": "scene_001" },
    { ...flags, "force-references": "true" }]) assert.equal(referenceImageQaRecoveryAdmission(status, changed).allowed, false);
  for (const stage of ["reference_plan_approval", "reference_image_approval", "image_generation"]) {
    assert.equal(referenceImageQaRecoveryAdmission({ ...status, current_stage: stage }, flags).allowed, false, "Other approval/stage gates remain required");
  }
  for (const state of ["passed", "missing", "stale"]) assert.equal(referenceImageQaRecoveryAdmission({ ...status, current_stage_state: state }, flags).allowed, false);
  assert.equal(referenceImageQaRecoveryAdmission({ current_stage: "reference_generation", current_stage_state: "missing" }, { "references-only": "true" }).applicable, false, "Initial generation unchanged");
  assert.equal(referenceImageQaRecoveryAdmission({ current_stage: "image_output_qa", current_stage_state: "blocked" }, { "references-only": "false", "qa-recovery": "true", "image-ids": "cut_001" }).applicable, false, "Scene-image QA remains governed by its own guard");
  assert.equal(referenceImageQaRecoveryAdmission({ ...status, reference_image_qa_recovery_scope: null }, flags).allowed, false);

  const validation = await referenceGenerationCompleteForTests(dir, identity, scriptHash);
  assert.equal(validation.state, "blocked");
  assert.match(validation.next_command_shape, /--references-only true --reference-ids state_0,state_1 --qa-recovery true --repair-reason/);
  assert.deepEqual(validation.reference_image_qa_recovery_scope.rejected_ref_ids, scope.rejected_ref_ids);

  for (const change of [
    row => { row.source_script_hash = "f".repeat(64); },
    row => { row.reference_plan_contract_sha256 = "f".repeat(64); },
    row => { row.reviewed_by = ""; }, row => { row.reviewed_at = "not a date"; },
    row => { row.reviewed_blocker_ids = ["state_0"]; },
    row => { row.findings[0].image_sha256 = "missing"; },
    row => { row.reviewed_blocker_ids[0] = "unknown"; row.findings[0].ref_id = "unknown"; },
  ]) {
    const changed = structuredClone(report); change(changed); await write(reportPath, changed);
    assert.equal(await read(), null, "Incomplete, stale or unknown evidence must not authorize repair");
    assert.equal((await referenceGenerationCompleteForTests(dir, identity, scriptHash)).done, true, "Stale QA must not invalidate existing rasters");
  }
  await write(reportPath, report);
  assert.equal(await read(plan, "e".repeat(64)), null);
  const changedPlan = structuredClone(plan); changedPlan.reference_targets[0].prompt_anchor = "New creative direction";
  assert.equal(await read(changedPlan), null);
  const stalePathReport = structuredClone(report); stalePathReport.findings[0].image_path = path.join(dir, "old.png");
  await write(reportPath, stalePathReport);
  assert.deepEqual((await read()).rejected_ref_ids, ["state_1"], "An old path retires only its finding");
  await write(reportPath, report);

  await fs.writeFile(images[0], "accepted replacement a");
  const remaining = await read();
  assert.deepEqual(remaining.rejected_ref_ids, ["state_1"], "Replaced image must leave current repair scope");
  assert.equal(referenceImageQaRecoveryAdmission({ ...status, reference_image_qa_recovery_scope: remaining }, flags).allowed, false);
  assert.equal(referenceImageQaRecoveryAdmission({ ...status, reference_image_qa_recovery_scope: remaining }, { ...flags, "reference-ids": "state_1" }).allowed, true);
  await fs.writeFile(images[1], "accepted replacement b");
  assert.equal(await read(), null);
  assert.equal((await referenceGenerationCompleteForTests(dir, identity, scriptHash)).done, true, "Old rejected bytes must not block accepted replacements");
  assert.deepEqual(JSON.parse(await fs.readFile(reportPath, "utf8")), report, "Read-only scope checks preserve historical findings");

  await fs.writeFile(images[1], "accepted replacement a");
  const duplicate = await referenceGenerationCompleteForTests(dir, identity, scriptHash);
  assert.equal(duplicate.state, "blocked"); assert.match(duplicate.evidence, /duplicate_hashes/);
  assert.equal(duplicate.reference_image_qa_recovery_scope, undefined);
  await fs.rm(images[1]);
  const missing = await referenceGenerationCompleteForTests(dir, identity, scriptHash);
  assert.equal(missing.done, false); assert.match(missing.evidence, /missing=state_1/);
  assert.equal(missing.reference_image_qa_recovery_scope, undefined);
  await fs.rm(planPath);
  assert.match((await referenceGenerationCompleteForTests(dir, identity, scriptHash)).evidence, /visual_reference_plan.json missing/);
  console.log("PASS current reference-image QA exact recovery and retirement");
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
