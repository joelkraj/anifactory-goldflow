import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAL_ENDPOINTS } from "../lib/fal-provider.mjs";

const script = fileURLToPath(new URL("../fal-production.mjs", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const exists = file => access(file).then(() => true, () => false);
const prompt = "A single adult character reference on a clean studio background with visible relaxed hands and no story props.";

async function fixture() {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-joey-reuse-"));
  const sourcePath = path.join(episodeDir, "approved-joey.png");
  const sourceBytes = Buffer.from("approved universal Joey fixture raster");
  await writeFile(sourcePath, sourceBytes);
  const sourceHash = sha256(sourceBytes);
  const bankPath = path.join(episodeDir, "locked-bank.json");
  const bankBytes = `${JSON.stringify({ assets: [{
    asset_id: "gf.global.character.joey_manhwa", asset_class: "character",
    approval_state: "approved", local_absolute_path: sourcePath, sha256: sourceHash,
    provider: "openart", model: "gpt-image-2-5-sunburst",
  }] }, null, 2)}\n`;
  await writeFile(bankPath, bankBytes);
  await writeFile(path.join(episodeDir, "run_identity.json"), JSON.stringify({
    image_provider: "fal_ai", visual_restart: { fork_at: "visual_reference_plan" },
    image_provider_options: { fal: {
      reference_bank_manifest: bankPath, reference_bank_manifest_sha256: sha256(bankBytes),
      production_concurrency: 10,
    } },
  }));
  const targets = [
    { ref_id: "joey_base_identity", kind: "character_state", subject: "Joey, face-only continuity anchor",
      canonical_subject_id: "joey", generation_mode: "manual_review", identity_usage: "face_only",
      required_before_imagegen: true, base_asset_id: null, state_delta: null, prompt_anchor: prompt },
    { ref_id: "joey_clinic_state", kind: "character_state", subject: "Joey in clinic clothing",
      canonical_subject_id: "joey", generation_mode: "standalone_ref", identity_usage: "full_identity",
      required_before_imagegen: true, base_asset_id: "joey_base_identity", state_delta: "clinic clothing", prompt_anchor: prompt },
  ];
  await writeFile(path.join(episodeDir, "visual_reference_plan.json"), JSON.stringify({ status: "passed", reference_targets: targets }));
  return { episodeDir, sourceBytes, sourceHash, bankPath };
}

function prepare(episodeDir) {
  return spawnSync(process.execPath, [script, "--episode-dir", episodeDir, "--action", "prepare-references"], { encoding: "utf8" });
}

test("Fal imports only the locked approved Joey face and records zero-spend lineage", async () => {
  const { episodeDir, sourceBytes, sourceHash, bankPath } = await fixture();
  try {
    const result = prepare(episodeDir);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(await readFile(path.join(episodeDir, "fal", "reference-plan.json"), "utf8"));
    const face = plan.assignments.find(row => row.ref_id === "joey_base_identity");
    const state = plan.assignments.find(row => row.ref_id === "joey_clinic_state");
    assert.equal(face.reference_mode, "approved_local_asset");
    assert.equal(face.endpoint, "local-approved-bank-reuse");
    assert.equal(face.max_cost_usd, 0);
    assert.deepEqual(face.reference_asset_ids, ["gf.global.character.joey_manhwa"]);
    assert.deepEqual(face.reference_hashes, [sourceHash]);
    assert.deepEqual(await readFile(face.output_path), sourceBytes);
    const receipt = JSON.parse(await readFile(face.result_receipt_path, "utf8"));
    assert.equal(receipt.schema, "goldflow_fal_approved_bank_reuse_v1");
    assert.equal(receipt.source_asset_id, "gf.global.character.joey_manhwa");
    assert.equal(receipt.source_bank_manifest, bankPath);
    assert.equal(receipt.source_bank_manifest_sha256, sha256(await readFile(bankPath)));
    assert.equal(receipt.source_provider, "openart");
    assert.equal(receipt.output_sha256, sourceHash);
    assert.equal(receipt.assignment_sha256, face.assignment_sha256);
    assert.equal(receipt.cost_usd, 0);
    assert.equal(receipt.request_id, null);
    assert.equal(await exists(face.submission_receipt_path), false);
    assert.equal(state.reference_mode, "separate_ordered_references");
    assert.equal(state.endpoint, FAL_ENDPOINTS.primary_edit);
    assert.equal(await exists(state.result_receipt_path), false);
    assert.equal(await exists(state.submission_receipt_path), false);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("Fal refuses to replace an existing Joey import receipt", async () => {
  const { episodeDir } = await fixture();
  try {
    assert.equal(prepare(episodeDir).status, 0);
    const receiptPath = path.join(episodeDir, "fal", "reference", "result-receipts", "joey_base_identity.json");
    const changed = { ...JSON.parse(await readFile(receiptPath, "utf8")), output_sha256: "0".repeat(64) };
    await writeFile(receiptPath, `${JSON.stringify(changed, null, 2)}\n`);
    const result = prepare(episodeDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Existing Fal artifact differs/);
    assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).output_sha256, changed.output_sha256);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("Fal refuses a changed locked bank before preparing reference assignments", async () => {
  const { episodeDir, bankPath } = await fixture();
  try {
    await writeFile(bankPath, `${await readFile(bankPath, "utf8")} `);
    const result = prepare(episodeDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Locked Fal reference bank manifest changed/);
    assert.equal(await exists(path.join(episodeDir, "fal", "reference-plan.json")), false);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});
