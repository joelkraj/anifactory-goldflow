import test from "node:test";
import assert from "node:assert/strict";
import { applyManualReconciliationRepairForTests, canonicalVisibleEntityCoverageFindingsForTests } from "../semantic-scene-plan.mjs";

test("exact-scope semantic reconciliation repair accepts only bound script excerpts", () => {
  const script = "The man opened the door. He left the room. The next visitor arrived.";
  const parsed = {
    canonical_entities: [{ entity_id: "man", evidence: [{ exact_excerpt: "The man entered the door.", confidence: 0.8 }] }],
    state_transitions: [{ entity_id: "man", transition_evidence_excerpt: "He left the room.", evidence: [] }],
    scenes: [{ scene_id: "scene_001", script_excerpt_start: "The man opened the door.", script_excerpt_end: "He left the room." }],
  };
  const artifact = {
    schema: "goldflow_semantic_reconciliation_repair_v1", status: "approved",
    source_script_hash: "script", failed_checkpoint_sha256: "checkpoint", input_sha256: "prompt",
    operations: [
      { collection: "canonical_entities", row_index: 0, row_id: "man", field: "exact_excerpt", evidence_index: 0, expected_excerpt: "The man entered the door.", replacement_excerpt: "The man opened the door." },
      { collection: "scenes", row_index: 0, row_id: "scene_001", field: "script_excerpt_end", expected_excerpt: "He left the room.", replacement_excerpt: "The next visitor arrived." },
    ],
    canonical_entity_appends: [{ entity_id: "visitors", display_name: "Visitors", kind: "group", aliases: ["visitors"], evidence: [{ exact_excerpt: "The next visitor arrived.", confidence: 1 }] }],
  };
  const result = applyManualReconciliationRepairForTests(parsed, artifact, script, {
    sourceScriptHash: "script", failedCheckpointSha256: "checkpoint", inputSha256: "prompt",
  });
  assert.equal(result.canonical_entities[0].evidence[0].exact_excerpt, "The man opened the door.");
  assert.equal(result.scenes[0].script_excerpt_end, "The next visitor arrived.");
  assert.equal(result.state_transitions[0].evidence[0].exact_excerpt, "He left the room.");
  assert.equal(result.canonical_entities[1].entity_id, "visitors");
  assert.equal(parsed.canonical_entities[0].evidence[0].exact_excerpt, "The man entered the door.");
  assert.throws(() => applyManualReconciliationRepairForTests(parsed, { ...artifact, failed_checkpoint_sha256: "wrong" }, script, {
    sourceScriptHash: "script", failedCheckpointSha256: "checkpoint", inputSha256: "prompt",
  }), /stale/);
  assert.throws(() => applyManualReconciliationRepairForTests(parsed, { ...artifact, operations: [{ ...artifact.operations[0], replacement_excerpt: "invented" }] }, script, {
    sourceScriptHash: "script", failedCheckpointSha256: "checkpoint", inputSha256: "prompt",
  }), /not exact script text/);
});

test("exact-scope reconciliation can append distinct, cited people missing from visible-actor canon", () => {
  const script = "A leatherworker repaired the boot. An armorer sold the mace. The leatherworker waved. The armorer nodded.";
  const parsed = {
    canonical_entities: [],
    scenes: [
      { scene_id: "scene_001", script_excerpt_end: "An armorer sold the mace.", visible_subjects: ["leatherworker", "armorer"] },
      { scene_id: "scene_002", visible_subjects: ["leatherworker", "armorer"] },
    ],
  };
  const artifact = {
    schema: "goldflow_semantic_reconciliation_repair_v1", status: "approved",
    source_script_hash: "script", failed_checkpoint_sha256: "checkpoint", input_sha256: "prompt",
    operations: [{ collection: "scenes", row_index: 0, row_id: "scene_001", field: "script_excerpt_end", expected_excerpt: "An armorer sold the mace.", replacement_excerpt: "The leatherworker waved." }],
    canonical_entity_appends: [
      { entity_id: "leatherworker", kind: "person", display_name: "Leatherworker", aliases: ["the leatherworker"], evidence: [{ exact_excerpt: "The leatherworker waved.", confidence: 1 }] },
      { entity_id: "armorer", kind: "person", display_name: "Armorer", aliases: ["the armorer"], evidence: [{ exact_excerpt: "The armorer nodded.", confidence: 1 }] },
    ],
  };
  const context = { sourceScriptHash: "script", failedCheckpointSha256: "checkpoint", inputSha256: "prompt" };
  const repaired = applyManualReconciliationRepairForTests(parsed, artifact, script, context);
  assert.deepEqual(repaired.canonical_entities.map((row) => row.entity_id), ["leatherworker", "armorer"]);
  assert.equal(canonicalVisibleEntityCoverageFindingsForTests(repaired, repaired.scenes).length, 0);
  assert.equal(parsed.canonical_entities.length, 0);

  const invalid = (firstRow) => ({ ...artifact, canonical_entity_appends: [firstRow] });
  assert.throws(() => applyManualReconciliationRepairForTests(parsed, invalid({ ...artifact.canonical_entity_appends[0], kind: "creature" }), script, context), /Invalid evidence-backed canonical entity append/);
  assert.throws(() => applyManualReconciliationRepairForTests(parsed, invalid({ ...artifact.canonical_entity_appends[0], display_name: "Invented person" }), script, context), /missing visible actor/);
  assert.throws(() => applyManualReconciliationRepairForTests(parsed, invalid({ ...artifact.canonical_entity_appends[0], evidence: [{ exact_excerpt: "The armorer nodded.", confidence: 1 }] }), script, context), /distinct, cited identity/);
  assert.throws(() => applyManualReconciliationRepairForTests(parsed, { ...artifact, canonical_entity_appends: [artifact.canonical_entity_appends[0], { ...artifact.canonical_entity_appends[1], entity_id: "leatherworker" }] }, script, context), /Invalid evidence-backed canonical entity append/);
  assert.throws(() => applyManualReconciliationRepairForTests(parsed, { ...artifact, canonical_entity_appends: [artifact.canonical_entity_appends[0], { ...artifact.canonical_entity_appends[1], aliases: ["the leatherworker"], evidence: [{ exact_excerpt: "The leatherworker waved. The armorer nodded.", confidence: 1 }] }] }, script, context), /distinct, cited identity/);
});
