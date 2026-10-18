import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexWorkSourceRowSha256 } from "../lib/codex-image-work-contract.mjs";
import { PIPELINE_STAGE_REGISTRY } from "../lib/pipeline-stage-registry.mjs";
import { partialSceneImageQaRecoveryAdmission, readPartialSceneImageQaRecoveryScope } from "../lib/partial-scene-image-recovery.mjs";
import { resolveRepairEvidence } from "../hybrid-browser-image-pool.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-partial-scene-qa-"));
const write = async (name, value) => {
  const bytes = typeof value === "string" ? value : JSON.stringify(value);
  await fs.writeFile(path.join(dir, name), bytes);
  return hash(bytes);
};
try {
  const sourceHash = await write("script_clean.md", "The exact approved narration.");
  const identity = { channel: "test", series_slug: "test", week: "test", episode: "ep_01", source_sha256: sourceHash,
    image_provider: "federated_google_web_image_pool", image_provider_options: {
      google_gemini: { model_label: "Locked Gemini model" }, google_flow: { model_label: "Locked Flow model" } } };
  const identityHash = await write("run_identity.json", identity);
  const approval = { ...identity, operator_approved: true, script_clean_hash: sourceHash };
  const approvalHash = await write("operator_script_approval.json", approval);
  const lockHash = await write("script_lock.json", approval);
  const prompts = ["bad_a", "bad_b", "good", "unsubmitted"].map(image_id => ({ image_id, provider_prompt: `Corrected current ${image_id}`, image_generation_required: true }));
  const plan = { ...identity, status: "passed", source_script_hash: sourceHash, prompts };
  const promptsHash = await write("section_image_prompts_hardened.json", plan);
  const rasterAHash = await write("bad_a.png", "visually rejected first raster");
  const rasterBHash = await write("bad_b.png", "visually rejected second raster");
  await write("good.png", "accepted existing raster");
  const imageReport = { status: "partial", results: prompts.slice(0, 3).map(row => ({ image_id: row.image_id, image_path: path.join(dir, `${row.image_id}.png`) })), missing_image_count: 1 };
  await write("imagegen_report_ep_01.json", imageReport);
  const report = { schema: "goldflow_partial_scene_image_qa_v1", status: "blocked", scope: "partial",
    source_script_hash: sourceHash, run_identity_sha256: identityHash, operator_script_approval_sha256: approvalHash,
    script_lock_sha256: lockHash, prompts_sha256: promptsHash, reviewed_by: "fixture-reviewer", reviewed_at: "2026-09-13T00:00:00Z",
    reviewed_blocker_ids: ["bad_a", "bad_b"], findings: prompts.slice(0, 2).map((row, index) => ({ severity: "blocker", image_id: row.image_id,
      code: "confirmed_identity_mismatch", review_note: "Actually inspected the fixture's wrong subject identity.",
      image_path: path.join(dir, `${row.image_id}.png`), image_sha256: index ? rasterBHash : rasterAHash,
      source_row_sha256: codexWorkSourceRowSha256(row) })) };
  const reportHash = await write("image_output_qa_ep_01.json", report);
  const status = { current_stage: "image_generation", current_stage_state: "blocked", episode_dir: dir, identity,
    stage_ledger: PIPELINE_STAGE_REGISTRY.map(row => ({ stage: row.id, state: row.id === "image_generation" ? "blocked" : "passed" })) };
  const flags = { "episode-dir": dir, "image-ids": "bad_a,bad_b", "qa-recovery": "true",
    "repair-reason": "Reviewed two confirmed identity failures in the partial batch.", "gemini-only": "true" };
  const { "gemini-only": _geminiOnly, ...defaultFlags } = flags;
  const flowFlags = { ...defaultFlags, "flow-only": "true" };
  const admission = (nextFlags = flags, nextStatus = status) => partialSceneImageQaRecoveryAdmission(nextStatus, nextFlags);
  const scope = () => readPartialSceneImageQaRecoveryScope({ episodeDir: dir, episode: "ep_01" });
  const evidence = (ids = ["bad_a"], rows = prompts) => resolveRepairEvidence({ episodeDir: dir, episode: "ep_01", mode: "scene",
    currentRows: rows, requestedIds: new Set(ids), qaRecovery: true });

  assert.equal(admission().allowed, true, "Missing unsubmitted images do not prevent exact reviewed repairs");
  assert.equal(admission(defaultFlags).allowed, true, "Default routing is unchanged");
  assert.equal(admission(flowFlags).allowed, true, "Locked Flow can perform the same exact reviewed repair");
  assert.equal(admission({ ...flowFlags, "image-ids": "bad_b" }).allowed, true);
  for (const value of ["false", "1", true, undefined]) {
    assert.equal(admission({ ...flowFlags, "flow-only": value }).allowed, false, "Flow selector must be explicit true text");
  }
  for (const changedIdentity of [
    { ...identity, image_provider: "unlocked_provider" },
    { ...identity, image_provider_options: { google_gemini: identity.image_provider_options.google_gemini } },
    { ...identity, image_provider_options: { ...identity.image_provider_options, google_flow: { model_label: " " } } },
  ]) {
    const changedHash = await write("run_identity.json", changedIdentity);
    await write("image_output_qa_ep_01.json", { ...report, run_identity_sha256: changedHash });
    assert.equal(admission(flowFlags).reason, "partial_scene_qa_flow_not_identity_locked");
  }
  await write("run_identity.json", identity);
  await write("image_output_qa_ep_01.json", report);
  assert.equal(admission({ ...flags, "image-ids": "bad_b" }).allowed, true);
  assert.deepEqual((await evidence()).authorized_asset_ids, ["bad_a"]);
  assert.deepEqual((await evidence()).records, [{ path: path.join(dir, "image_output_qa_ep_01.json"), sha256: reportHash }]);
  const sourceBefore = await fs.readFile(path.join(dir, "script_clean.md"));
  for (const key of ["source_script_hash", "run_identity_sha256", "operator_script_approval_sha256", "script_lock_sha256", "prompts_sha256"]) {
    for (const value of [undefined, "f".repeat(64)]) {
      await write("image_output_qa_ep_01.json", { ...report, [key]: value });
      assert.equal(admission().allowed, false, `${key} missing/stale must block`);
      assert.equal(admission(flowFlags).allowed, false, `Flow: ${key} missing/stale must block`);
      await assert.rejects(evidence());
    }
  }
  await write("image_output_qa_ep_01.json", report);
  for (const change of [
    { "image-ids": "good" }, { "image-ids": "unsubmitted" }, { "image-ids": "bad_a,good" }, { "image-ids": "bad_a,bad_a" },
    { "image-ids": "" }, { "qa-recovery": "false" }, { "repair-reason": "retry" }, { "gemini-only": "false" },
    { "force-images": "true" }, { "provider-migration": "true" }, { "skip-host-health-check": "true" }, { "flow-only": "true" },
    { prompts: path.join(dir, "different.json") }, { episode: "ep_02" }, { "episode-dir": path.dirname(dir) },
  ]) assert.equal(admission({ ...flags, ...change }).allowed, false, JSON.stringify(change));
  for (const change of [{ "image-ids": "good" }, { "image-ids": "unsubmitted" }, { "gemini-only": "true" },
    { "chatgpt-only": "true" }, { "flow-model-override": "Other model" }, { "skip-host-health-check": "true" }]) {
    assert.equal(admission({ ...flowFlags, ...change }).allowed, false, `Flow: ${JSON.stringify(change)}`);
  }
  for (const stage of ["script_approval", "reference_image_approval", "visual_prompt_harden"]) {
    const changed = structuredClone(status); changed.stage_ledger.find(row => row.stage === stage).state = "stale";
    assert.equal(admission(flags, changed).allowed, false, `${stage} must remain current`);
    assert.equal(admission(flowFlags, changed).allowed, false, `Flow: ${stage} must remain current`);
  }
  assert.equal(admission(flags, { ...status, stage_ledger: [] }).allowed, false);
  assert.equal(admission(flags, { ...status, current_stage_state: "passed" }).allowed, false);
  assert.equal(admission(flags, { ...status, current_stage: "image_output_qa" }).applicable, false, "Ordinary complete-image QA guard behavior unchanged");
  assert.equal(admission({ "episode-dir": dir, "image-ids": "unsubmitted" }).applicable, false, "First candidate generation unchanged");
  assert.equal(admission({ ...flags, "references-only": "true" }).applicable, false, "Reference recovery stays separate");
  const changedRows = structuredClone(prompts); changedRows[0].provider_prompt = "Unreviewed prompt";
  await assert.rejects(evidence(["bad_a"], changedRows), /corrected prompt rows/);
  const staleRow = structuredClone(report); staleRow.findings[0].source_row_sha256 = hash("stale row");
  await write("image_output_qa_ep_01.json", staleRow); assert.equal(admission().allowed, false);
  assert.equal(admission(flowFlags).allowed, false, "Flow also requires the exact corrected row hash");
  await write("image_output_qa_ep_01.json", report);

  await write("bad_a.png", "accepted replacement first raster");
  assert.deepEqual(scope().rejected_image_ids, ["bad_b"], "Replaced raster retires only its exact finding");
  assert.equal(admission().allowed, false, "Old report cannot authorize a repeat replacement");
  assert.equal(admission(flowFlags).allowed, false, "Flow cannot repair a replaced raster again");
  assert.equal(admission({ ...flags, "image-ids": "bad_b" }).allowed, true);
  assert.equal(admission({ ...flowFlags, "image-ids": "bad_b" }).allowed, true);
  await assert.rejects(evidence(["bad_a"]), /still-current rejected rasters/);
  assert.deepEqual((await evidence(["bad_b"])).authorized_asset_ids, ["bad_b"]);
  await write("bad_b.png", "accepted replacement second raster");
  assert.equal(admission().allowed, false);
  await assert.rejects(evidence(["bad_b"]), /no_current_rejected_rasters/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "image_output_qa_ep_01.json"))), report, "Historical blocked report is never rewritten as approval");
  assert.deepEqual(await fs.readFile(path.join(dir, "script_clean.md")), sourceBefore);
  assert.equal(await fs.readFile(path.join(dir, "good.png"), "utf8"), "accepted existing raster");
  console.log("PASS exact partial scene QA recovery, current provenance and retired-image protection");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
