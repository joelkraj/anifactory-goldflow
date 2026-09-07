import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildPilotNarrationReviewFixture } from "./avatar-pilot-narration-review-tests.mjs";
import { createPilotNarrationReviewProducer } from "../lib/avatar-pilot-narration-review-producer.mjs";
import { PILOT_RAW_NARRATION_REVIEW_ATTESTATION,
  validatePilotNarrationReviewAuthorization } from "../lib/avatar-pilot-narration-review.mjs";
import { validateFullPilotFinalizationExecutionEvidence } from "../lib/narration-full-pilot-finalization.mjs";
import { narrationTtsPolicyForIdentity, validateNarrationTtsPolicy } from "../lib/narration-tts-policy.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
async function inventory(directory) {
  const rows = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...await inventory(file));
    else rows.push([file, hash(await fs.readFile(file))]);
  }
  return rows.sort(([left], [right]) => left.localeCompare(right));
}
async function preserved(rows) {
  for (const [file, sha256] of rows) assert.equal(hash(await fs.readFile(file)), sha256, `Original artifact changed: ${file}`);
}
async function absent(file) { await assert.rejects(() => fs.stat(file), { code: "ENOENT" }); }

// Only status, clean-runtime inspection and finalizer execution are structural
// mocks. All source, opening, remaining, PCM, review and checkpoint validators
// are real. This does not load a voice/ASR model or approve real media.
async function harness(controls = {}) {
  const fixture = await buildPilotNarrationReviewFixture();
  const { root: episodeDir, identity, result: priorResult, plan, manifest } = fixture;
  const workRoot = path.join(episodeDir, "pilot_narration_work");
  const reviewRoot = path.join(workRoot, "narration_review");
  // A shared fixture may have already materialized its example authorization.
  // Move only that owned synthetic directory so the real producer claims a
  // genuinely fresh namespace; leave all original narration evidence in place.
  try { await fs.rename(reviewRoot, path.join(episodeDir, "synthetic-review-template")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const original = await inventory(episodeDir);
  const counts = { status: 0, runtime: 0, finalizer: 0 };
  const calls = [];
  const outputNamespace = path.join(workRoot, "full_finalization_reviewed");
  const outputResult = path.join(workRoot, "narration_reviewed_result.json");
  const provenance = { fixture_only: true, git_commit: "f".repeat(40), git_dirty: false };
  const producer = createPilotNarrationReviewProducer({
    getStatus: async (received) => {
      counts.status++; calls.push("status"); assert.equal(received, episodeDir);
      return { identity, current_stage: controls.wrongStage ? "pilot_asset_plan" : "pilot_narration",
        allowed_command_stages: ["pilot_narration"], next_command_shape: "node bin/goldflow.mjs pilot review-narration --episode-dir <fixture>" };
    },
    inspectRuntime: async ({ policy, bank, runnerPath }) => {
      counts.runtime++; calls.push("runtime");
      assert.equal(policy.primary.voice_id, identity.pilot_providers.narration.voice_id);
      assert.deepEqual(bank, identity.narration_delivery_reference_bank);
      assert.equal(path.basename(runnerPath), "tts-local-production-runner.py");
      if (counts.runtime === 1) { await absent(reviewRoot); await absent(outputNamespace); }
      if (controls.runtimeMutation) await controls.runtimeMutation(fixture);
      if (controls.runtimeFailure) throw new Error("synthetic runtime is not clean");
      return { provenance, referenceAssetHashes: { fixture_only: true } };
    },
    finalize: async (argv, { phaseContext }) => {
      counts.finalizer++; calls.push("finalizer");
      assert.equal(counts.finalizer, 1, "No automatic finalization retry");
      assert.deepEqual(argv, ["--episode-dir", episodeDir, "--script", identity.source_script.path,
        "--plan", priorResult.generation_plan.path, "--manifest", priorResult.provider_output_manifest.path]);
      assert.equal(phaseContext.phase, "full_pilot");
      assert.equal(phaseContext.outputNamespace, outputNamespace);
      const { reviewContinuation, outputNamespace: ignored, ...unchanged } = phaseContext;
      const { outputNamespace: oldNamespace, ...oldContext } = priorResult.finalized.phase_context;
      assert.deepEqual(unchanged, oldContext);
      assert.deepEqual(Object.keys(reviewContinuation).sort(), ["checkpoint", "listenDecision", "priorResult", "rawAudio", "reviewReceipt"]);
      assert.equal(reviewContinuation.priorResult.path, path.join(workRoot, "narration_producer_result.json"));
      assert.deepEqual(reviewContinuation.rawAudio, priorResult.finalization_artifacts.audio);
      assert.equal(reviewContinuation.checkpoint.path, priorResult.finalized.checkpoint_path);
      const authorization = await validatePilotNarrationReviewAuthorization({ reviewContinuation, episodeDir, identity });
      assert.equal(authorization.synthesis_authorized, false);
      assert.equal(authorization.mastered_audio_listened, false);
      assert.equal(authorization.mastered_subjective_review_status, "pending");
      const policy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), { production: true });
      const checked = await validateFullPilotFinalizationExecutionEvidence({ phaseContext, episodeDir, identity,
        identityPath: path.join(episodeDir, "run_identity.json"), scriptPath: identity.source_script.path,
        plan, planPath: priorResult.generation_plan.path, manifest, manifestPath: priorResult.provider_output_manifest.path, policy });
      assert.deepEqual(checked.synthesisRuns, manifest.provider_execution.synthesis_runs);
      assert.deepEqual(checked.scope.review_continuation, reviewContinuation);
      await preserved(original);
      if (controls.finalizerFailure) throw new Error("synthetic mastering failed; do not retry");
      await fs.mkdir(outputNamespace);
      const finalized = { status: "synthetic_finalization_boundary_only", phase_context: phaseContext,
        finalization_scope: checked.scope, subjective_review_status: "pending",
        raw_wav: priorResult.finalized.raw_wav, raw_wav_sha256: priorResult.finalized.raw_wav_sha256 };
      for (const key of ["final_wav", "tts_report_path", "stitch_report_path", "full_stream_qa_path",
        "voice_continuity_qa_path", "unit_delivery_qa_path", "unit_qa_path", "subjective_review_manifest_path", "timing_candidate_path"]) {
        finalized[key] = path.join(outputNamespace, `${key}.fixture.json`);
        await fs.writeFile(finalized[key], JSON.stringify({ fixture_only: true, not_real_audio_or_qa: true }));
      }
      if (controls.escapeOutput) finalized.tts_report_path = priorResult.finalization_artifacts.tts_report.path;
      return finalized;
    },
  });
  const args = { episodeDir, reviewer: "synthetic fixture reviewer",
    note: "Synthetic test only; no real listening approval.", attestation: PILOT_RAW_NARRATION_REVIEW_ATTESTATION };
  return { fixture, original, producer, args, counts, calls, reviewRoot, outputNamespace, outputResult, priorResult, provenance };
}
async function withHarness(controls, body) {
  const h = await harness(controls);
  try { await body(h); } finally { await h.fixture.cleanup(); }
}
const tests = [];
const test = (name, body) => tests.push([name, body]);
test("one exact raw-review continuation preserves original files and emits only a pending new candidate", () => withHarness({}, async (h) => {
  const result = await h.producer(h.args);
  assert.deepEqual(h.calls, ["status", "runtime", "finalizer"]);
  assert.equal(result.creative_submissions, 0); assert.equal(result.synthesis_invoked, false);
  assert.equal(result.subjective_approval, null); assert.equal(result.finalized.subjective_review_status, "pending");
  assert.deepEqual(result.runtime_provenance, h.provenance);
  for (const key of ["generation_plan", "spoken_text_ir", "spoken_text_audit", "pre_synthesis_gate", "provider_output_manifest",
    "runner_report", "cohort_events", "accepted_opening", "unit_ids", "source_script_sha256", "identity_sha256"]) {
    assert.deepEqual(result[key], h.priorResult[key]);
  }
  assert.deepEqual(await readJson(h.outputResult), result);
  await preserved(h.original);
  const retained = await inventory(h.reviewRoot);
  await assert.rejects(() => h.producer(h.args), { code: "EEXIST" });
  assert.equal(h.counts.finalizer, 1);
  assert.deepEqual(await readJson(h.outputResult), result);
  await preserved(retained); await preserved(h.original);
}));
test("wrong stage or incomplete raw listening approval stops before runtime or output", async () => {
  await withHarness({ wrongStage: true }, async (h) => {
    await assert.rejects(() => h.producer(h.args), /current exact delivery-review/);
    assert.equal(h.counts.runtime, 0); assert.equal(h.counts.finalizer, 0); await absent(h.reviewRoot);
  });
  for (const change of [{ reviewer: "" }, { note: " " }, { attestation: "complete_opening_listened_end_to_end" }]) {
    await withHarness({}, async (h) => {
      await assert.rejects(() => h.producer({ ...h.args, ...change }), /listening approval required/);
      assert.equal(h.counts.runtime, 0); assert.equal(h.counts.finalizer, 0); await absent(h.reviewRoot);
    });
  }
});
test("stale original raw audio or approved opening fails before runtime", async () => {
  for (const select of [(h) => h.priorResult.finalization_artifacts.audio.path, (h) => h.priorResult.accepted_opening.approval.path]) {
    await withHarness({}, async (h) => {
      await fs.appendFile(select(h), "stale synthetic input");
      await assert.rejects(() => h.producer(h.args), /Pending raw narration invalid/);
      assert.equal(h.counts.runtime, 0); assert.equal(h.counts.finalizer, 0); await absent(h.reviewRoot);
    });
  }
});
test("unclean runtime stops without creating review or mastering artifacts", () => withHarness({ runtimeFailure: true }, async (h) => {
  await assert.rejects(() => h.producer(h.args), /runtime is not clean/);
  assert.equal(h.counts.finalizer, 0); await absent(h.reviewRoot); await absent(h.outputNamespace);
  await preserved(h.original);
}));
test("checkpoint changed during runtime inspection stops before output", () => withHarness({
  runtimeMutation: async (fixture) => fs.appendFile(fixture.result.finalized.checkpoint_path, "\n"),
}, async (h) => {
  await assert.rejects(() => h.producer(h.args), /Bound input hash changed/);
  assert.equal(h.counts.finalizer, 0); await absent(h.reviewRoot); await absent(h.outputNamespace);
}));
test("failed finalization retains immutable review evidence and cannot automatically replay", () => withHarness({ finalizerFailure: true }, async (h) => {
  await assert.rejects(() => h.producer(h.args), /mastering failed/);
  const approval = await inventory(h.reviewRoot);
  await assert.rejects(() => h.producer(h.args), { code: "EEXIST" });
  assert.equal(h.counts.finalizer, 1); await absent(h.outputResult);
  await preserved(h.original); await preserved(approval);
}));
test("a finalizer output outside the reviewed namespace cannot publish a result", () => withHarness({ escapeOutput: true }, async (h) => {
  await assert.rejects(() => h.producer(h.args), /escaped its fresh namespace/);
  await absent(h.outputResult); await preserved(h.original);
}));
test("relative episode input resolves consistently without changing original receipt paths", () => withHarness({}, async (h) => {
  const result = await h.producer({ ...h.args, episodeDir: path.relative(process.cwd(), h.args.episodeDir) });
  assert.equal(result.review_continuation.priorResult.path, path.join(h.args.episodeDir, "pilot_narration_work", "narration_producer_result.json"));
  await preserved(h.original);
}));

for (const [name, body] of tests) { await body(); console.log(`PASS ${name}`); }
console.log(`Pilot narration review producer tests passed (${tests.length} groups; synthetic fixtures, no synthesis/mastering/provider calls).`);
