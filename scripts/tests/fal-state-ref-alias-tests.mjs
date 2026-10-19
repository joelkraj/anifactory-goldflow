import test from "node:test";
import assert from "node:assert/strict";
import { falStateSourceMap, resolveFalApprovedRefId } from "../lib/fal-state-ref-alias.mjs";

const approved = { char_joey_carter_identity: "a".repeat(64), joey_clinic_civilian: "b".repeat(64) };
const states = falStateSourceMap({ character_state_refs: [
  { state_ref_id: "joey_base_face", source_ref_id: "char_joey_carter_identity" },
  { state_ref_id: "joey_clinic_civilian", source_ref_id: "joey_clinic_civilian" },
  { state_ref_id: "orphan_state", source_ref_id: null },
] });

test("approved target IDs resolve to themselves", () => {
  assert.equal(resolveFalApprovedRefId("joey_clinic_civilian", approved, states), "joey_clinic_civilian");
});

test("a character-state alias resolves to its linked approved source target", () => {
  assert.equal(resolveFalApprovedRefId("joey_base_face", approved, states), "char_joey_carter_identity");
});

test("unlinked or unknown IDs stay unresolved so the hash gate still refuses them", () => {
  assert.equal(resolveFalApprovedRefId("orphan_state", approved, states), "orphan_state");
  assert.equal(resolveFalApprovedRefId("not_a_ref", approved, states), "not_a_ref");
  assert.equal(approved[resolveFalApprovedRefId("orphan_state", approved, states)], undefined);
});
