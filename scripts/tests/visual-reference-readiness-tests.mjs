import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inferredStateForTests, visualReferencePlanCompleteForTests } from "../run-status.mjs";
import { readyStageIds } from "../lib/pipeline-stage-registry.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-reference-readiness-"));
const identity = { channel: "test", series_slug: "test", week: "test", episode: "ep_01" };
const scriptHash = hash("Approved fixture text.");
const write = (name, value) => fs.writeFile(path.join(temp, name), JSON.stringify(value));
const read = () => visualReferencePlanCompleteForTests(temp, scriptHash, identity);
const ready = result => readyStageIds([
  { stage: "visual_beat_plan", state: "passed" },
  { stage: "visual_reference_plan", state: inferredStateForTests(result) },
], identity).includes("visual_reference_plan");
try {
  const first = await read();
  assert.equal(first.done, false);
  assert.equal(inferredStateForTests(first), "missing", "never-created plan and inventory are a first-authoring input, not a failed stage");
  assert.equal(ready(first), true, "completed visual beats permit first reference authoring");

  await fs.writeFile(path.join(temp, "visual_reference_plan.json"), "{broken JSON");
  const malformedPlan = await read();
  assert.equal(inferredStateForTests(malformedPlan), "failed", "an existing malformed plan must not be mistaken for never-created files");
  assert.equal(ready(malformedPlan), false);
  await fs.rm(path.join(temp, "visual_reference_plan.json"));

  await write("reference_inventory_ledger.json", { status: "failed", assets: [] });
  const invalidInventory = await read();
  assert.equal(inferredStateForTests(invalidInventory), "failed", "an existing invalid inventory remains a failure");
  assert.equal(ready(invalidInventory), false);
  await fs.rm(path.join(temp, "reference_inventory_ledger.json"));

  await write("character_state_refs.json", { status: "passed", source_script_hash: scriptHash });
  const incompleteAuthoring = await read();
  assert.equal(inferredStateForTests(incompleteAuthoring), "failed", "an existing partial authoring output must not reset the stage to first authoring");
  assert.equal(ready(incompleteAuthoring), false);
  await fs.rm(path.join(temp, "character_state_refs.json"));

  await write("visual_reference_partial_ep_01.json", {
    status: "needs_chunk_repair", passed_chunk_count: 1, source_script_hash: scriptHash,
    failed_chunks: [{ chunk_id: "reference_002", scene_ids: ["scene_002"] }],
  });
  const partial = await read();
  assert.equal(inferredStateForTests(partial), "blocked", "retained failure evidence still requires exact recovery even if final files are absent");
  assert.match(partial.next_command_shape, /--repair-chunk-ids reference_002/);
  assert.equal(ready(partial), false);
  assert.equal(partial.recovery_scope.source_hash_current, true);
  assert.match(partial.recovery_scope.partial_sha256, /^[a-f0-9]{64}$/);
  await write("visual_reference_partial_ep_01.json", { status: "needs_global_repair", source_script_hash: "0".repeat(64) });
  const stalePartial = await read();
  assert.equal(inferredStateForTests(stalePartial), "stale");
  assert.equal(stalePartial.recovery_scope, undefined);
  await write("visual_reference_partial_ep_01.json", { status: "in_progress" });
  assert.equal(inferredStateForTests(await read()), "failed", "unrecognized/incomplete partial evidence is not a brand-new stage");
  await fs.rm(path.join(temp, "visual_reference_partial_ep_01.json"));

  const inputPath = path.join(temp, "source-fixture.txt");
  await fs.writeFile(inputPath, "source version one");
  const plan = { status: "passed", source_hashes: { [inputPath]: hash("source version one") } };
  await write("visual_reference_plan.json", plan);
  await write("reference_inventory_ledger.json", { status: "passed", assets: [] });
  await write("character_state_refs.json", { status: "passed", source_script_hash: scriptHash });
  const passed = await read();
  assert.equal(passed.done, true);
  assert.equal(inferredStateForTests(passed), "passed");
  assert.equal(ready(passed), false, "a passed plan cannot become a first-authoring stage");

  await write("visual_reference_plan.json", { ...plan, status: "failed" });
  const failedPlan = await read();
  assert.equal(inferredStateForTests(failedPlan), "failed");
  assert.equal(ready(failedPlan), false);
  await write("visual_reference_plan.json", plan);
  await fs.writeFile(inputPath, "source version two");
  const stale = await read();
  assert.equal(stale.done, false);
  assert.equal(inferredStateForTests(stale), "stale", "source drift retains the existing stale classification");
  assert.equal(ready(stale), true, "existing stale-stage readiness remains unchanged; planner rerun gates still apply separately");
  console.log("visual reference readiness tests passed");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
