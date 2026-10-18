import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertCodexWorkDependenciesAcyclic,
  createCodexWorkManifest,
} from "../lib/codex-image-work-contract.mjs";

const item = (asset_id, ...dependency_asset_ids) => ({ asset_id, dependency_asset_ids });
const cycleError = (ids) => (error) => {
  assert.equal(error.code, "image_work_dependency_cycle");
  assert.deepEqual(error.cycle_asset_ids, ids);
  assert.ok(error.message.includes(ids.join(" -> ")));
  return true;
};

for (const valid of [
  [],
  [item("base"), item("state", "base"), item("later", "state")],
  [item("base"), item("left", "base"), item("right", "base"), item("top", "left", "right")],
  [item("state", "already_materialized_base"), item("later", "state", "external_style")],
]) {
  const before = structuredClone(valid);
  assert.doesNotThrow(() => assertCodexWorkDependenciesAcyclic(valid));
  assert.deepEqual(valid, before, "dependency validation must not rewrite selection or edges");
}

const mothballed = "reclaimer_mothballed_state_ref";
const restored = "reclaimer_restored_identity_ref";
assert.throws(() => assertCodexWorkDependenciesAcyclic([
  item(mothballed, restored), item(restored, mothballed),
]), cycleError([mothballed, restored, mothballed]));
assert.throws(() => assertCodexWorkDependenciesAcyclic([
  item("unrelated"), item("a", "b"), item("b", "c"), item("c", "a"),
]), cycleError(["a", "b", "c", "a"]));
assert.throws(() => assertCodexWorkDependenciesAcyclic([item("self", "self")]), cycleError(["self", "self"]));
// Each side alone has an external dependency; validating the append union is
// necessary to catch a newly internal cycle.
const existing = [item("a", "b")];
const incoming = [item("b", "a")];
assert.doesNotThrow(() => assertCodexWorkDependenciesAcyclic(existing));
assert.doesNotThrow(() => assertCodexWorkDependenciesAcyclic(incoming));
assert.throws(() => assertCodexWorkDependenciesAcyclic([...existing, ...incoming]), cycleError(["a", "b", "a"]));

// Reproduce the observed canonical-alias/explicit-parent cycle at the real
// creation boundary. Failure must precede any manifest/runtime directory write.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-dependency-cycle-test-"));
try {
  const referencePlanPath = path.join(temp, "references.json");
  const characterStateRefsPath = path.join(temp, "states.json");
  const stagingRoot = path.join(temp, "staging");
  const target = (ref_id) => ({
    ref_id, inventory_asset_id: "char_reclaimer_identity", canonical_subject_id: "reclaimer",
    base_asset_id: "char_reclaimer_identity", generation_mode: "standalone_ref",
    kind: "character_state", prompt_anchor: "One isolated salvage barge on a plain background.",
  });
  await fs.writeFile(referencePlanPath, JSON.stringify({ status: "passed", reference_targets: [target(mothballed), target(restored)] }));
  await fs.writeFile(characterStateRefsPath, JSON.stringify({
    status: "draft_needs_manual_review",
    character_state_refs: [
      { state_ref_id: mothballed, source_ref_id: mothballed, base_identity_ref_id: restored },
      { state_ref_id: restored, source_ref_id: restored },
    ],
  }));
  await assert.rejects(createCodexWorkManifest({
    mode: "reference", episodeDir: temp, referencePlanPath, characterStateRefsPath,
    referenceIds: [mothballed, restored], stagingRoot,
  }), cycleError([mothballed, restored, mothballed]));
  await assert.rejects(fs.access(stagingRoot), { code: "ENOENT" });
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

console.log("image-work-dependency-cycle-tests: PASS");
