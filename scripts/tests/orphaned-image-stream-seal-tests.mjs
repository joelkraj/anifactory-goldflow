import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCodexImageWork } from "../codex-image-work.mjs";
import { orphanedImageStreamSealAdmission, sealReviewedOrphanedImageStream } from "../lib/orphaned-image-stream-seal.mjs";
import { sha256File, sealCodexWorkManifestStream } from "../lib/codex-image-work-contract.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-orphan-seal-"));
const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`); };
const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
const deadPid = child.pid;
await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });

async function fixture(name, pid = deadPid) {
  const episodeDir = path.join(temp, name);
  const tuple = { channel: "fixture", series_slug: "fixture-series", week: "2026-W37-fixture", episode: "ep_01" };
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), "The exact approved fixture text.\n");
  const sourceHash = await sha256File(path.join(episodeDir, "script_clean.md"));
  await write(path.join(episodeDir, "run_identity.json"), { ...tuple, source_sha256: sourceHash });
  for (const name of ["operator_script_approval.json", "script_lock.json"]) await write(path.join(episodeDir, name), {
    ...tuple, operator_approved: true, script_clean_hash: sourceHash,
  });
  const attemptDir = path.join(episodeDir, "reports", "visual-wavefront", `2026-09-12T23-05-30-353Z-${pid}`);
  const planPath = path.join(attemptDir, "batch_0001", "batch_0001.hardened.json");
  await write(planPath, { schema: "goldflow_section_image_prompts_wavefront_batch_v1", status: "passed", ...tuple,
    source_script_hash: sourceHash, prompts: ["pending", "completed", "failed"].map(image_id => ({ image_id, prompt: `Exact ${image_id} prompt` })) });
  const manifestPath = path.join(episodeDir, "assets", "images", "codex_worker_staging", "codex-work-fixture", "work_manifest.json");
  const manifestDir = path.dirname(manifestPath);
  for (const dir of ["leases", "completions", "deadletters", "attempts", "closed-leases", "hash-claims", "append-events"]) await fs.mkdir(path.join(manifestDir, dir), { recursive: true });
  const identityHash = await sha256File(path.join(episodeDir, "run_identity.json"));
  const manifest = { schema: "goldflow_codex_image_work_manifest_v1", mode: "scene", episode_dir: episodeDir,
    manifest_id: "codex-work-fixture", manifest_path: manifestPath, item_count: 3, content_sha256: "a".repeat(64),
    sources: { run_identity: { path: path.join(episodeDir, "run_identity.json"), sha256: identityHash } },
    streaming_queue: { appendable: true, sealed: false, stream_id: "fixture-stream", revision: 3, append_count: 3 },
    items: await Promise.all(["pending", "completed", "failed"].map(async asset_id => ({ asset_id,
      prompt: `Exact ${asset_id} prompt`, source_plan_path: planPath, source_plan_sha256: await sha256File(planPath) }))) };
  await write(manifestPath, manifest);
  const hybridPath = path.join(attemptDir, "batch_0001", "batch_0001.hybrid-pool.json");
  await write(hybridPath, { schema: "goldflow_wavefront_stream_batch_v1", status: "partial", stream_id: "fixture-stream",
    manifest_id: manifest.manifest_id, manifest_path: manifestPath, exact_asset_ids: ["pending", "completed", "failed"] });
  await write(path.join(manifestDir, "completions", "completed.json"), { asset_id: "completed", sha256: "b".repeat(64), source_path: "/fixture/retained.png" });
  await write(path.join(manifestDir, "deadletters", "failed.json"), { asset_id: "failed", error: "usage_limited", attempts: 1 });
  await fs.writeFile(path.join(manifestDir, "attempts", "retained-image.png"), "unchanged fixture raster bytes");
  const recoveryReceiptPath = path.join(episodeDir, "reports", "manual_repairs", "orphan-seal", "review.json");
  const recoveryReason = "Reviewed exact crashed append owner; seal without changing any queued work.";
  const receipt = { schema: "goldflow_orphaned_image_stream_seal_review_v1", status: "reviewed", episode_dir: episodeDir,
    manifest_path: manifestPath, manifest_id: manifest.manifest_id, manifest_sha256: await sha256File(manifestPath),
    manifest_content_sha256: manifest.content_sha256, manifest_revision: 3, stream_id: "fixture-stream", source_script_hash: sourceHash,
    run_identity_sha256: identityHash, operator_script_approval_sha256: await sha256File(path.join(episodeDir, "operator_script_approval.json")),
    script_lock_sha256: await sha256File(path.join(episodeDir, "script_lock.json")), producer: { role: "wavefront_append_owner", pid,
      attempt_dir: attemptDir, hybrid_report_path: hybridPath, hybrid_report_sha256: await sha256File(hybridPath) },
    reviewed_by: "fixture reviewer", reviewed_at: "2026-09-13T00:00:00.000Z", reason: recoveryReason };
  await write(recoveryReceiptPath, receipt);
  return { episodeDir, manifestPath, recoveryReceiptPath, recoveryReason, manifestDir, manifest, receipt, planPath };
}

try {
  const f = await fixture("normal");
  const flags = { action: "seal-orphaned", "episode-dir": f.episodeDir, manifest: f.manifestPath,
    "recovery-receipt": f.recoveryReceiptPath, "recovery-reason": f.recoveryReason };
  const ready = { current_stage: "image_generation", current_stage_state: "blocked", allowed_command_stages: [] };
  assert.equal(orphanedImageStreamSealAdmission(ready, flags).allowed, true);
  for (const stage of ["reference_plan_approval", "section_image_prompts", "image_output_qa", "complete"]) {
    assert.equal(orphanedImageStreamSealAdmission({ ...ready, current_stage: stage }, flags).allowed, false);
  }
  assert.equal(orphanedImageStreamSealAdmission({ ...ready, current_stage_state: "passed" }, flags).allowed, false);
  for (const extra of ["workflow-bypass", "references-only", "gemini-only", "image-ids"]) {
    assert.equal(orphanedImageStreamSealAdmission(ready, { ...flags, [extra]: "true" }).allowed, false);
  }
  const unscoped = { ...flags }; delete unscoped.manifest;
  assert.equal(orphanedImageStreamSealAdmission(ready, unscoped).allowed, false);
  assert.equal(orphanedImageStreamSealAdmission(ready, { action: "status" }).applicable, false);
  await assert.rejects(() => sealReviewedOrphanedImageStream({ ...f, recoveryReason: "A different reviewed reason." }), /exact substantive/);
  const beforeHash = await sha256File(f.manifestPath);
  await fs.mkdir(path.join(f.manifestDir, "leases", "pending.lock"));
  await write(path.join(f.manifestDir, "leases", "pending.lock", "lease.json"), { asset_id: "pending", expires_at: "2000-01-01T00:00:00Z" });
  await assert.rejects(() => sealReviewedOrphanedImageStream(f), /zero lease entries/);
  assert.equal(await sha256File(f.manifestPath), beforeHash);
  await fs.rm(path.join(f.manifestDir, "leases", "pending.lock"), { recursive: true });

  const alive = await fixture("alive", process.pid);
  await assert.rejects(() => sealReviewedOrphanedImageStream(alive), /still alive/);
  assert.equal(await sha256File(alive.manifestPath), alive.receipt.manifest_sha256);
  await assert.rejects(() => sealCodexWorkManifestStream({ manifestPath: f.manifestPath, orphanRecovery: {
    manifest_sha256: beforeHash, file_bindings: [], producer_pid: process.pid,
  } }), /still alive/, "producer is checked again under the dispatch lock");
  await assert.rejects(() => sealCodexWorkManifestStream({ manifestPath: f.manifestPath, orphanRecovery: {
    manifest_sha256: "0".repeat(64), file_bindings: [], producer_pid: deadPid,
  } }), /manifest changed/, "reviewed manifest must remain exact under the lock");

  for (const [field, value] of [["source_script_hash", "0".repeat(64)], ["run_identity_sha256", "0".repeat(64)],
    ["manifest_revision", 4], ["manifest_path", path.join(f.episodeDir, "other.json")]]) {
    await write(f.recoveryReceiptPath, { ...f.receipt, [field]: value });
    await assert.rejects(() => sealReviewedOrphanedImageStream(f), /mismatch/);
    assert.equal(await sha256File(f.manifestPath), beforeHash);
  }
  await write(f.recoveryReceiptPath, f.receipt);
  const originalPlan = await fs.readFile(f.planPath);
  await fs.appendFile(f.planPath, " ");
  await assert.rejects(() => sealReviewedOrphanedImageStream(f), /file hash mismatch/);
  await fs.writeFile(f.planPath, originalPlan);
  const protectedPaths = ["completions/completed.json", "deadletters/failed.json", "attempts/retained-image.png"];
  const hashes = await Promise.all(protectedPaths.map(file => sha256File(path.join(f.manifestDir, file))));
  const reviewHash = await sha256File(f.recoveryReceiptPath);
  const result = await runCodexImageWork(flags);
  assert.equal(result.status, "sealed"); assert.equal(result.provider_calls, 0); assert.equal(result.new_work_items, 0);
  const after = JSON.parse(await fs.readFile(f.manifestPath, "utf8"));
  assert.deepEqual(after.items, f.manifest.items);
  assert.deepEqual({ ...after, streaming_queue: f.manifest.streaming_queue, content_sha256: f.manifest.content_sha256 }, f.manifest);
  assert.deepEqual(after.streaming_queue, { ...f.manifest.streaming_queue, appendable: false, sealed: true, revision: 4, sealed_at: after.streaming_queue.sealed_at });
  assert.deepEqual(await Promise.all(protectedPaths.map(file => sha256File(path.join(f.manifestDir, file)))), hashes);
  assert.equal(await sha256File(f.recoveryReceiptPath), reviewHash);
  const event = JSON.parse(await fs.readFile(result.receipt_path, "utf8"));
  assert.equal(event.event_type, "stream_sealed"); assert.deepEqual(event.asset_ids, ["pending", "completed", "failed"]);
  assert.equal(event.orphan_recovery.review_receipt_sha256, reviewHash);
  assert.equal(event.orphan_recovery.producer_check, "ESRCH");
  assert.equal(event.orphan_recovery.active_lease_count, 0);
  assert.equal(event.orphan_recovery.planner_child_completion_asserted, false);
  assert.equal(event.orphan_recovery.manifest_after_sha256, await sha256File(f.manifestPath));
  await assert.rejects(() => runCodexImageWork(flags), /unsealed/);
  assert.equal(await sha256File(result.receipt_path), result.receipt_sha256);
  console.log("orphaned-image-stream-seal-tests: PASS");
} finally { await fs.rm(temp, { recursive: true, force: true }); }
