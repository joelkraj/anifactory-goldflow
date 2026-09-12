import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_VISUAL_BEAT_CONTRACT_VERSION } from "../lib/visual-beat-contract.mjs";
import { readVisualBeatRecoveryScope, visualBeatFailedRecoveryScope, visualBeatRecoveryAdmission } from "../lib/visual-beat-recovery.mjs";
import { visualBeatRecoveryCommandForTests } from "../run-status.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-beat-recovery-"));
try {
  const identity = { channel: "c", series_slug: "s", week: "w", episode: "ep_01",
    visual_beat_timing_contract: { enforcement: "hard_max", max_beat_sec: 8 } };
  const script = "One two three four five six seven.";
  const sourceHash = hash(script);
  const sourceHashes = {};
  for (const name of ["script_clean.md", "story_fact_ledger.json", "timed_scene_plan.json", "narration_word_timing_ep_01.json"]) {
    const content = name === "script_clean.md" ? script : "{}\n";
    await fs.writeFile(path.join(temp, name), content);
    sourceHashes[path.join(temp, name)] = hash(content);
  }
  const preserved = { visual_beat_id: "beat_w000000_w000002", source_atom_ids: ["atom_w000000_w000002"] };
  const descriptor = { chunk_id: "editorial_002", ordinal: 2, recovery_generation: 0,
    input_sha256: "a".repeat(64), atom_ids: ["atom_w000003_w000004", "atom_w000005_w000006"],
    source_word_start_index: 3, source_word_end_index: 6, error: "invalid enum" };
  const artifact = { schema: "goldflow_visual_beat_plan_v2", status: "blocked",
    visual_beat_contract_version: CURRENT_VISUAL_BEAT_CONTRACT_VERSION,
    channel: "c", series_slug: "s", week: "w", episode: "ep_01", source_script_hash: sourceHash,
    source_hashes: sourceHashes, beats: [preserved], editorial_director: { atom_count: 3, chunk_count: 2,
      partial_failure: { failed_chunk_count: 1, failed_chunk_ids: [descriptor.chunk_id],
        failed_atom_ids: descriptor.atom_ids, failed_chunks: [descriptor],
        preserved_passed_beat_ids: [preserved.visual_beat_id],
        passed_chunks: [{ chunk_id: "editorial_001", atom_ids: preserved.source_atom_ids, beat_ids: [preserved.visual_beat_id] }] } } };
  const planPath = path.join(temp, "visual_beat_plan.json");
  const save = value => fs.writeFile(planPath, JSON.stringify(value));
  await save(artifact);
  const read = () => readVisualBeatRecoveryScope({ episodeDir: temp, sourceScriptHash: sourceHash, identity });
  const scope = await read();
  assert.ok(scope);
  assert.deepEqual(scope.failed_chunk_ids, ["editorial_002"]);
  assert.deepEqual(scope.failed_atom_ids, descriptor.atom_ids);
  assert.equal(scope.visual_beat_plan_sha256, hash(JSON.stringify(artifact)));
  const status = { current_stage: "visual_beat_plan", current_stage_state: "blocked", visual_beat_recovery_scope: scope };
  const flags = { "resume-incomplete-chunks": "true" };
  assert.equal(visualBeatRecoveryAdmission(status, flags).allowed, true);
  assert.equal(visualBeatRecoveryAdmission(status, { ...flags, "max-beat-sec": "8", "beat-timing-enforcement": "hard_max" }).allowed, true);
  const command = visualBeatRecoveryCommandForTests(scope, identity);
  assert.match(command, /visual beats .*--resume-incomplete-chunks true$/);
  assert.equal((command.match(/--resume-incomplete-chunks/g) ?? []).length, 1);
  assert.doesNotMatch(command, /workflow-bypass/);
  assert.equal(visualBeatRecoveryCommandForTests(null, identity), null);

  for (const deniedFlags of [{}, { "resume-incomplete-chunks": "false" }, { "resume-incomplete-chunks": "yes" },
    ...["chunk-ids", "beat-ids", "editorial-chunk-ids", "only-scenes", "scope-end-sec", "output", "script",
      "word-timing", "timed", "story-fact-ledger", "approve-regrouping", "retime-locked-grouping",
      "reproject-active-state-only"].map(name => ({ ...flags, [name]: "unknown" })),
    { ...flags, "reuse-codex-calls": "false" }, { ...flags, "max-beat-sec": "9" },
    { ...flags, "beat-timing-enforcement": "advisory" }]) {
    assert.equal(visualBeatRecoveryAdmission(status, deniedFlags).allowed, false, JSON.stringify(deniedFlags));
  }
  for (const changedScope of [null, {}, { ...scope, source_hashes_current: false },
    { ...scope, failed_chunk_ids: ["editorial_001"] }, { ...scope, failed_chunk_ids: ["unknown"] },
    { ...scope, failed_atom_ids: ["atom_w000000_w000002"] }, { ...scope, visual_beat_plan_sha256: "b".repeat(64) }]) {
    assert.equal(visualBeatRecoveryAdmission({ ...status, visual_beat_recovery_scope: changedScope }, flags).allowed, false);
  }
  for (const changedStatus of [{ ...status, current_stage: "voice_plan" },
    { ...status, current_stage_state: "passed" }, { ...status, current_stage_state: "stale" }]) {
    assert.equal(visualBeatRecoveryAdmission(changedStatus, flags).allowed, false);
  }
  const invalidArtifacts = [null, {}, { ...artifact, status: "passed" }, { ...artifact, source_script_hash: "b".repeat(64) }];
  for (const mutate of [
    a => { a.editorial_director.partial_failure.failed_chunks[0].ordinal = 99; },
    a => { a.editorial_director.partial_failure.failed_chunks[0].chunk_id = "unknown"; },
    a => { a.editorial_director.partial_failure.failed_chunks[0].source_word_end_index = 999; },
    a => { a.editorial_director.partial_failure.failed_chunks[0].recovery_generation = -1; },
    a => { a.editorial_director.partial_failure.failed_atom_ids = ["atom_w000003_w000006"]; },
    a => { a.editorial_director.partial_failure.passed_chunks[0].chunk_id = "editorial_002"; },
    a => { a.beats[0].source_atom_ids = descriptor.atom_ids; },
    a => { a.editorial_director.partial_failure.preserved_passed_beat_ids = []; },
    a => { a.editorial_director.atom_count = 4; },
  ]) { const changed = structuredClone(artifact); mutate(changed); invalidArtifacts.push(changed); }
  for (const invalid of invalidArtifacts) assert.equal(visualBeatFailedRecoveryScope(invalid, sourceHash), null);

  await fs.writeFile(path.join(temp, "timed_scene_plan.json"), "{\"changed\":true}");
  assert.equal(await read(), null, "a changed upstream artifact cannot admit recovery");
  await fs.writeFile(path.join(temp, "timed_scene_plan.json"), "{}\n");
  await save({ ...artifact, source_hashes: { [path.join(temp, "script_clean.md")]: sourceHash } });
  assert.equal(await read(), null, "required canonical source bindings cannot be omitted");
  await save(artifact);
  assert.equal(await readVisualBeatRecoveryScope({ episodeDir: temp, sourceScriptHash: sourceHash,
    identity: { ...identity, episode: "ep_02" } }), null, "identity mismatch remains blocked");
  assert.ok(await read(), "restored current exact scope remains admissible");
  assert.deepEqual(JSON.parse(await fs.readFile(planPath, "utf8")).beats, [preserved], "validation never changes passed beats");
  console.log("visual beat recovery tests passed");
} finally { await fs.rm(temp, { recursive: true, force: true }); }
