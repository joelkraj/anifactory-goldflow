import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexWorkManifest, codexWorkSourceRowSha256, sha256File } from "../lib/codex-image-work-contract.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-state-source-dependency-"));
try {
  const referencePlanPath = path.join(temp, "references.json");
  const characterStateRefsPath = path.join(temp, "states.json");
  const target = (ref_id, extra = {}) => ({ ref_id, kind: "character_state", generation_mode: "standalone_ref",
    prompt_anchor: `One isolated adult ${ref_id} identity on a plain background.`, ...extra });
  const base = target("person_base_ref", { inventory_asset_id: "char_person_identity" });
  const opening = target("person_opening_ref", { base_asset_id: null });
  const later = target("person_later_ref", { base_asset_id: "char_person_identity" });
  const other = target("other_identity_ref");
  const targets = [base, opening, later, other];
  const state = { state_ref_id: "person_opening_state", source_ref_id: opening.ref_id, base_identity_ref_id: base.ref_id };
  const writeInputs = async (states = [state]) => {
    await fs.writeFile(referencePlanPath, JSON.stringify({ status: "passed", reference_targets: targets }));
    await fs.writeFile(characterStateRefsPath, JSON.stringify({ status: "draft_needs_manual_review", character_state_refs: states }));
  };
  const create = (name, referenceIds) => createCodexWorkManifest({ mode: "reference", episodeDir: temp,
    referencePlanPath, characterStateRefsPath, referenceIds, stagingRoot: path.join(temp, name) });
  await writeInputs();
  const sourceHashes = await Promise.all([referencePlanPath, characterStateRefsPath].map(sha256File));
  const queued = (await create("queued", targets.map(row => row.ref_id))).manifest;
  const byId = new Map(queued.items.map(row => [row.asset_id, row]));
  assert.deepEqual(byId.get(opening.ref_id).dependency_asset_ids, [base.ref_id], "differently named state must gate its generated source target on the base");
  assert.deepEqual(byId.get(later.ref_id).dependency_asset_ids, [base.ref_id], "existing canonical inventory alias remains supported");
  assert.deepEqual(byId.get(base.ref_id).dependency_asset_ids, []);
  assert.deepEqual(byId.get(other.ref_id).dependency_asset_ids, []);
  for (const row of targets) {
    assert.equal(byId.get(row.ref_id).source_row_sha256, codexWorkSourceRowSha256(row));
    assert.equal(byId.get(row.ref_id).neutral_prompt, row.prompt_anchor);
  }
  assert.deepEqual(await Promise.all([referencePlanPath, characterStateRefsPath].map(sha256File)), sourceHashes);

  // A later exact repair must attach the already accepted base bytes without
  // requeueing that base or the already completed sibling state.
  const baseImagePath = path.join(temp, "accepted-base.png");
  const laterImagePath = path.join(temp, "accepted-later.png");
  await fs.writeFile(baseImagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3xoAAAAASUVORK5CYII=", "base64"));
  await fs.copyFile(baseImagePath, laterImagePath);
  base.reference_image_path = baseImagePath;
  later.reference_image_path = laterImagePath;
  await writeInputs();
  const acceptedHashes = await Promise.all([baseImagePath, laterImagePath].map(sha256File));
  const repair = (await create("exact-repair", [opening.ref_id])).manifest;
  assert.deepEqual(repair.items.map(row => row.asset_id), [opening.ref_id]);
  assert.deepEqual(repair.items[0].dependency_asset_ids, [], "materialized base outside this exact queue is an input, not a new job");
  assert.deepEqual(repair.items[0].ordered_references.map(row => ({ ref_id: row.ref_id, path: row.path, sha256: row.sha256 })),
    [{ ref_id: base.ref_id, path: baseImagePath, sha256: acceptedHashes[0] }]);
  assert.equal(repair.items[0].source_row_sha256, byId.get(opening.ref_id).source_row_sha256);
  assert.equal(repair.items[0].neutral_prompt_sha256, byId.get(opening.ref_id).neutral_prompt_sha256);
  assert.deepEqual(await Promise.all([baseImagePath, laterImagePath].map(sha256File)), acceptedHashes);

  // Equivalent aliases may describe the same parent; contradictory parents
  // must fail before writing any queue rather than silently choosing one.
  await writeInputs([state, { ...state, state_ref_id: "equivalent_state", base_identity_ref_id: "char_person_identity" }]);
  assert.equal((await create("equivalent", [opening.ref_id])).manifest.items[0].ordered_references[0].ref_id, base.ref_id);
  await writeInputs([state, { ...state, state_ref_id: "conflicting_state", base_identity_ref_id: other.ref_id }]);
  await assert.rejects(create("ambiguous", [opening.ref_id]), error => {
    assert.equal(error.code, "reference_state_dependency_ambiguous");
    assert.ok(error.message.includes(opening.ref_id));
    return true;
  });
  await assert.rejects(fs.access(path.join(temp, "ambiguous")), { code: "ENOENT" });

  await writeInputs([{ state_ref_id: opening.ref_id, base_identity_ref_id: base.ref_id }]);
  assert.equal((await create("legacy-state-id", [opening.ref_id])).manifest.items[0].ordered_references[0].ref_id, base.ref_id);
  await writeInputs([{ ref_id: opening.ref_id, base_identity_ref_id: base.ref_id }]);
  assert.equal((await create("legacy-ref-id", [opening.ref_id])).manifest.items[0].ordered_references[0].ref_id, base.ref_id);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
console.log("reference-state-source-dependency-tests: PASS");
