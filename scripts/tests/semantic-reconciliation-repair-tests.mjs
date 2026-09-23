import test from "node:test";
import assert from "node:assert/strict";
import { applyManualReconciliationRepairForTests } from "../semantic-scene-plan.mjs";

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
