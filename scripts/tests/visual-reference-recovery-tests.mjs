import assert from "node:assert/strict";
import { visualReferenceRecoveryAdmission } from "../lib/visual-reference-recovery.mjs";

const base = "node bin/goldflow.mjs visual refs --channel channel --series series --week week --episode ep_01 --visual-ref-chunk-concurrency 8 --visual-ref-json-attempts 1 --visual-ref-merge-validation-attempts 1";
const baseFlags = { channel: "channel", series: "series", week: "week", episode: "ep_01",
  "visual-ref-chunk-concurrency": "8", "visual-ref-json-attempts": "1", "visual-ref-merge-validation-attempts": "1" };
const scope = { source_script_hash: "a".repeat(64), source_hash_current: true, partial_sha256: "b".repeat(64) };
const statusFor = (key, value) => ({ current_stage: "visual_reference_plan", current_stage_state: "blocked",
  visual_reference_recovery_scope: scope, next_command_shape: `${base} --${key} ${value}` });
const globalStatus = statusFor("repair-global", "true");
const globalFlags = { ...baseFlags, "repair-global": "true" };

for (const [key, value] of [["repair-global", "true"], ["repair-chunk-ids", "chunk_002,chunk_017"], ["repair-scene-ids", "scene_002,scene_009"]]) {
  const status = statusFor(key, value);
  const flags = { ...baseFlags, [key]: value };
  const admitted = visualReferenceRecoveryAdmission(status, flags);
  assert.equal(admitted.applicable, true);
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.repair_flag, key);
  assert.equal(admitted.repair_value, value);
  assert.equal(admitted.partial_sha256, scope.partial_sha256);
  assert.equal(visualReferenceRecoveryAdmission(status, Object.fromEntries(Object.entries(flags).reverse())).allowed, true, "Flag map order is immaterial");
  assert.equal(visualReferenceRecoveryAdmission(status, { ...flags, [key]: value === "true" ? "false" : "unknown_id" }).allowed, false);
}

for (const flags of [{}, baseFlags, { ...globalFlags, "repair-global": true },
  { ...globalFlags, "repair-global": "yes" }, { ...globalFlags, episode: "ep_02" },
  { ...globalFlags, "visual-ref-chunk-concurrency": "12" },
  ...["output", "script", "episode-dir", "workflow-bypass", "repair-scene-ids", "repair-chunk-ids", "unknown-override"].map(key => ({ ...globalFlags, [key]: "anything" })),
  Object.fromEntries(Object.entries(globalFlags).filter(([key]) => key !== "visual-ref-json-attempts"))]) {
  const result = visualReferenceRecoveryAdmission(globalStatus, flags);
  assert.equal(result.applicable, true);
  assert.equal(result.allowed, false, JSON.stringify(flags));
}

for (const changedScope of [null, {}, { ...scope, source_hash_current: false },
  { ...scope, source_hash_current: "true" }, { ...scope, source_script_hash: "stale" },
  { ...scope, partial_sha256: "missing" }]) {
  assert.equal(visualReferenceRecoveryAdmission({ ...globalStatus, visual_reference_recovery_scope: changedScope }, globalFlags).allowed, false);
}
for (const state of ["missing", "passed", "failed", "stale"]) {
  const status = { ...globalStatus, current_stage_state: state };
  assert.deepEqual(visualReferenceRecoveryAdmission(status, globalFlags), {
    applicable: true, allowed: false, reason: "not_a_current_blocked_visual_reference_recovery" });
}
assert.equal(visualReferenceRecoveryAdmission({ ...globalStatus, current_stage: "reference_plan_approval" }, globalFlags).allowed, false);
assert.equal(visualReferenceRecoveryAdmission({ current_stage: "visual_reference_plan", current_stage_state: "missing" }, baseFlags).applicable, false, "Initial authoring unchanged");

for (const command of [null, "Inspect the partial artifact manually.", base,
  `${base} --repair-global false`, `${base} --repair-global true --repair-scene-ids scene_001`,
  `${base} --repair-global true --repair-global true`, `${base} --repair-chunk-ids chunk_001,chunk_001`,
  `${base} --repair-scene-ids scene_001,`, `${base} --repair-global true; echo unsafe`,
  `${base} --repair-global \"true\"`, base.replace("visual refs", "visual beats") + " --repair-global true",
  base.replace(" --episode ep_01", "") + " --repair-global true"]) {
  assert.equal(visualReferenceRecoveryAdmission({ ...globalStatus, next_command_shape: command }, globalFlags).allowed, false, String(command));
}

console.log("PASS visual reference exact recovery admission");
