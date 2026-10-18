import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { promoteApprovedFalReferences } from "../lib/fal-portable-bank.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const bytes = value => `${JSON.stringify(value, null, 2)}\n`;
const exists = file => access(file).then(() => true, () => false);
async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes(value));
  return sha(bytes(value));
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-transport-bank-"));
  const episodeDir = path.join(root, "episode");
  const referenceRoot = path.join(episodeDir, "fal", "reference");
  const identity = { image_provider: "fal_ai", visual_restart: { fork_at: "visual_reference_plan" },
    series_slug: "generic-series", episode: "ep_01" };
  const identityHash = await save(path.join(episodeDir, "run_identity.json"), identity);
  const sourceBankPath = path.join(root, "source-bank.json");
  const sourceBankHash = await save(sourceBankPath, { assets: [] });
  const contract = { reference_bank_manifest: sourceBankPath, reference_bank_manifest_sha256: sourceBankHash };
  const rows = [];
  const targets = [];
  const approval = { status: "approved", reference_hash_by_ref_id: {} };
  const recoveredIds = ["manny_borrowed_jacket_ref", "luis_chef_ref"];
  for (const [index, id] of ["ordinary_ref", ...recoveredIds].entries()) {
    const originalOutput = path.join(episodeDir, "assets", "images", "references", `${id}.png`);
    const originalRequestId = `original-request-${id}`;
    const prompt = `A single reference subject number ${index} against a clean neutral backdrop.`;
    const core = { image_id: id, ref_id: id, endpoint: "openai/gpt-image-2.5/sunburst/text-to-image",
      prompt, prompt_sha256: sha(prompt), run_identity_sha256: identityHash,
      reference_mode: "text_only", reference_asset_ids: [], reference_hashes: [],
      board_path: null, board_sha256: null, board_manifest_path: null,
      max_cost_usd: 1, asset_class: "location", subject: id };
    const original = { ...core, assignment_sha256: sha(JSON.stringify(core)),
      submission_receipt_path: path.join(referenceRoot, "submission-receipts", `${id}.json`),
      result_receipt_path: path.join(referenceRoot, "result-receipts", `${id}.json`),
      output_path: originalOutput,
      upload_receipt_path: path.join(referenceRoot, "upload-receipts", `${id}.json`) };
    const assignmentPath = path.join(referenceRoot, "assignments", `${id}.json`);
    await save(assignmentPath, original);
    rows.push({ ...original, assignment_path: assignmentPath });
    const originalSubmission = { schema: "goldflow_fal_submission_receipt_v1", image_id: id,
      assignment_sha256: original.assignment_sha256, prompt_sha256: original.prompt_sha256,
      endpoint: original.endpoint, request_id: originalRequestId };
    const originalSubmissionHash = await save(original.submission_receipt_path, originalSubmission);

    let outputPath = originalOutput;
    let requestId = originalRequestId;
    if (recoveredIds.includes(id)) {
      const holdPath = path.join(referenceRoot, "transport-holds", `${id}.json`);
      const holdHash = await save(holdPath, { schema: "goldflow_fal_transport_hold_v1", image_id: id,
        assignment_sha256: original.assignment_sha256, endpoint: original.endpoint, request_id: originalRequestId });
      const observationPath = path.join(referenceRoot, "hold-observation-receipts", `${id}.json`);
      const observationHash = await save(observationPath, {
        schema: "goldflow_fal_reference_hold_observation_v1", image_id: id,
        original_assignment_sha256: original.assignment_sha256, original_request_id: originalRequestId,
        original_submission_receipt_sha256: originalSubmissionHash,
        original_transport_hold_sha256: holdHash,
        outcome: id === "manny_borrowed_jacket_ref" ? "transport_pending" : "provider_failed",
      });
      const recoveryCore = { ...original, previous_request_id: originalRequestId,
        previous_assignment_sha256: original.assignment_sha256,
        original_transport_hold_sha256: holdHash,
        hold_observation_receipt_sha256: observationHash,
        transport_recovery_reason: "Original exact provider request failed after a no-spend recheck." };
      for (const key of ["assignment_sha256", "assignment_path", "submission_receipt_path", "result_receipt_path", "output_path", "upload_receipt_path"]) delete recoveryCore[key];
      outputPath = path.join(episodeDir, "assets", "images", "reference-repairs", `${id}-transport.png`);
      requestId = `recovery-request-${id}`;
      const recovery = { ...recoveryCore, assignment_sha256: sha(JSON.stringify(recoveryCore)),
        submission_receipt_path: path.join(referenceRoot, "transport-recovery-submission-receipts", `${id}.json`),
        result_receipt_path: path.join(referenceRoot, "transport-recovery-result-receipts", `${id}.json`),
        output_path: outputPath,
        upload_receipt_path: path.join(referenceRoot, "transport-recovery-upload-receipts", `${id}.json`) };
      await save(path.join(referenceRoot, "transport-recovery-assignments", `${id}.json`), recovery);
      await save(recovery.submission_receipt_path, { schema: "goldflow_fal_submission_receipt_v1", image_id: id,
        assignment_sha256: recovery.assignment_sha256, prompt_sha256: recovery.prompt_sha256,
        endpoint: recovery.endpoint, request_id: requestId });
    }
    const raster = await sharp({ create: { width: 8, height: 8, channels: 3,
      background: { r: 40 + index * 50, g: 80, b: 120 } } }).png().toBuffer();
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, raster);
    const outputHash = sha(raster);
    const receiptPath = recoveredIds.includes(id)
      ? path.join(referenceRoot, "transport-recovery-result-receipts", `${id}.json`)
      : original.result_receipt_path;
    await save(receiptPath, { schema: "goldflow_fal_result_receipt_v1", image_id: id,
      endpoint: original.endpoint, request_id: requestId, output_path: outputPath,
      output_sha256: outputHash, completed_at: "2026-10-01T00:00:00.000Z" });
    targets.push({ ref_id: id, kind: "location", subject: id, prompt_anchor: prompt,
      reference_image_path: outputPath, conditioning_image_path: outputPath });
    approval.reference_hash_by_ref_id[id] = outputHash;
  }
  await save(path.join(episodeDir, "visual_reference_plan.json"), { reference_targets: targets });
  await save(path.join(episodeDir, "fal", "reference-plan.json"), { assignments: rows });
  const previousDataRoot = process.env.ANIFACTORY_DATA_ROOT;
  process.env.ANIFACTORY_DATA_ROOT = path.join(root, "data");
  return { root, episodeDir, identity, contract, approval, referenceRoot,
    manifestPath: path.join(root, "data", "global_reference_bank", "portable", "manifest.json"),
    restore() { if (previousDataRoot === undefined) delete process.env.ANIFACTORY_DATA_ROOT;
      else process.env.ANIFACTORY_DATA_ROOT = previousDataRoot; } };
}

async function runPromotion(f) {
  return promoteApprovedFalReferences({ episodeDir: f.episodeDir, identity: f.identity,
    contract: f.contract, approval: f.approval });
}

test("portable promotion preserves ordinary and two transport-recovered reference receipts", async () => {
  const f = await fixture();
  try {
    const result = await runPromotion(f);
    assert.equal(result.promoted, 3);
    const manifest = JSON.parse(await readFile(f.manifestPath, "utf8"));
    assert.equal(manifest.assets.length, 3);
    for (const id of ["manny_borrowed_jacket_ref", "luis_chef_ref"]) {
      const record = manifest.assets.find(row => row.asset_id.endsWith(`.${id}`));
      const receiptPath = path.join(f.referenceRoot, "transport-recovery-result-receipts", `${id}.json`);
      assert.equal(record.providers.fal.result_receipt_path, receiptPath);
      assert.equal(record.providers.fal.result_receipt_sha256, sha(await readFile(receiptPath)));
      assert.equal(record.providers.fal.request_id, `recovery-request-${id}`);
      assert.equal(record.sha256, f.approval.reference_hash_by_ref_id[id]);
    }
    assert.equal(manifest.assets.find(row => row.asset_id.endsWith(".ordinary_ref")).providers.fal.request_id,
      "original-request-ordinary_ref");
  } finally { f.restore(); await rm(f.root, { recursive: true, force: true }); }
});

test("portable promotion refuses a recovered result from the wrong request", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.referenceRoot, "transport-recovery-result-receipts", "manny_borrowed_jacket_ref.json");
    const receipt = JSON.parse(await readFile(file, "utf8"));
    await save(file, { ...receipt, request_id: "a-different-request" });
    await assert.rejects(runPromotion(f), /result lineage changed/);
    assert.equal(await exists(f.manifestPath), false);
  } finally { f.restore(); await rm(f.root, { recursive: true, force: true }); }
});

test("portable promotion refuses an altered recovery assignment", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.referenceRoot, "transport-recovery-assignments", "manny_borrowed_jacket_ref.json");
    const assignment = JSON.parse(await readFile(file, "utf8"));
    await save(file, { ...assignment, prompt: `${assignment.prompt} Changed.` });
    await assert.rejects(runPromotion(f), /assignment changed/);
    assert.equal(await exists(f.manifestPath), false);
  } finally { f.restore(); await rm(f.root, { recursive: true, force: true }); }
});

test("portable promotion refuses changed original hold lineage", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.referenceRoot, "transport-holds", "manny_borrowed_jacket_ref.json");
    const hold = JSON.parse(await readFile(file, "utf8"));
    await save(file, { ...hold, request_id: "not-the-original-request" });
    await assert.rejects(runPromotion(f), /hold lineage changed/);
    assert.equal(await exists(f.manifestPath), false);
  } finally { f.restore(); await rm(f.root, { recursive: true, force: true }); }
});

test("portable promotion refuses changed approval paths and recovered raster bytes", async () => {
  const f = await fixture();
  try {
    const target = JSON.parse(await readFile(path.join(f.episodeDir, "visual_reference_plan.json"), "utf8"));
    target.reference_targets.find(row => row.ref_id === "manny_borrowed_jacket_ref").reference_image_path = "/some/other/reference.png";
    await save(path.join(f.episodeDir, "visual_reference_plan.json"), target);
    await assert.rejects(runPromotion(f), /Approved Fal reference changed/);
    const actual = target.reference_targets.find(row => row.ref_id === "manny_borrowed_jacket_ref");
    actual.reference_image_path = actual.conditioning_image_path;
    await save(path.join(f.episodeDir, "visual_reference_plan.json"), target);
    await writeFile(actual.reference_image_path, Buffer.from("changed raster"));
    await assert.rejects(runPromotion(f), /Approved Fal reference changed/);
    assert.equal(await exists(f.manifestPath), false);
  } finally { f.restore(); await rm(f.root, { recursive: true, force: true }); }
});

test("portable promotion refuses a changed approved reference hash", async () => {
  const f = await fixture();
  try {
    f.approval.reference_hash_by_ref_id.manny_borrowed_jacket_ref = "0".repeat(64);
    await assert.rejects(runPromotion(f), /Approved Fal reference changed/);
    assert.equal(await exists(f.manifestPath), false);
  } finally { f.restore(); await rm(f.root, { recursive: true, force: true }); }
});
