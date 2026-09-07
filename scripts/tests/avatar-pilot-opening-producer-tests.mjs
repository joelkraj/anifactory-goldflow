import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPilotOpeningProducer } from "../lib/avatar-pilot-opening-producer.mjs";
import { buildPilotOpeningExecutionFixture } from "./avatar-pilot-opening-execution-tests.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
async function writeJson(file, value) {
  const bytes = jsonBytes(value); await fs.writeFile(file, bytes);
  return { path: file, sha256: hash(bytes) };
}
async function inventory(directory) {
  const rows = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push([file, "directory"], ...await inventory(file));
    else rows.push([file, hash(await fs.readFile(file))]);
  }
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}
async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }

// The runner receipt below is synthetic fixture evidence, not an assertion of
// model execution or listening. Only the native synthesis/finalization call
// boundaries are mocked; the canonical plan, gate and execution validators run.
async function syntheticExecution(fixture, args) {
  const original = fixture.execution;
  const jobs = await readJson(original.report.jobs_path);
  assert.deepEqual(args.units.map((unit) => unit.unit_id), fixture.options.units.map((unit) => unit.unit_id));
  assert.deepEqual(args.batchPlan, fixture.options.batchPlan);
  Object.assign(jobs, {
    narration_generation_plan_path: args.planPath,
    narration_generation_plan_sha256: args.plan.plan_sha256,
    narration_generation_plan_file_sha256: args.planFileSha256,
    run_identity_path: args.identityPath, run_identity_file_sha256: args.identityFileSha256,
    source_script_path: args.scriptPath, source_script_sha256: args.scriptSha256,
    pre_synthesis_gate: { path: args.preSynthesisGatePath, file_sha256: args.preSynthesisGateFileSha256,
      gate_sha256: args.preSynthesisGate.gate_sha256 },
  });
  await fs.mkdir(args.outputDir);
  const jobsRef = await writeJson(path.join(args.outputDir, "fixture-jobs.json"), jobs);
  const results = structuredClone(original.results);
  for (const row of results) {
    const bytes = await fs.readFile(row.output_path);
    row.output_path = path.join(args.outputDir, `${row.unit_id}.wav`);
    row.sidecar_path = row.output_path.replace(/\.wav$/u, ".json");
    await fs.writeFile(row.output_path, bytes); await writeJson(row.sidecar_path, row);
  }
  const report = { ...structuredClone(original.report), results,
    jobs_path: jobsRef.path, jobs_sha256: jobsRef.sha256,
    pre_synthesis_gate_path: args.preSynthesisGatePath,
    pre_synthesis_gate_file_sha256: args.preSynthesisGateFileSha256,
    pre_synthesis_gate_sha256: args.preSynthesisGate.gate_sha256,
    cohort_event_path: path.join(args.outputDir, "fixture-cohort-events.jsonl"),
  };
  const events = args.batchPlan.cohorts.map((cohort, index) => ({
    schema: "goldflow_local_tts_cohort_event_v1", event: "cohort_complete",
    jobs_sha256: jobsRef.sha256, batch_plan_sha256: args.batchPlan.batch_plan_sha256,
    cohort_id: cohort.cohort_id, cohort_sha256: cohort.cohort_sha256, cohort_index: cohort.cohort_index,
    execution: report.cohort_executions[index],
    results: cohort.members.map((member) => results.find((row) => row.unit_id === member.unit_id)),
  }));
  const eventBytes = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await fs.writeFile(report.cohort_event_path, eventBytes);
  const reportRef = await writeJson(path.join(args.outputDir, "fixture-runner-report.json"), report);
  return { report, results, reportPath: reportRef.path, reportSha256: reportRef.sha256,
    cohortEventsPath: report.cohort_event_path, cohortEventsSha256: hash(eventBytes) };
}

async function setup() {
  const fixture = await buildPilotOpeningExecutionFixture();
  // Normalize the macOS temporary-directory alias once so assertions compare
  // invocation paths, not an incidental /var versus /private/var spelling.
  const episodeDir = await fs.realpath(fixture.root);
  const identity = { ...fixture.identity, episode: "ep_fixture", proof_scope: { duration_frames: 2700 } };
  await writeJson(path.join(episodeDir, "run_identity.json"), identity);
  const scriptApproval = await writeJson(path.join(episodeDir, "pilot_script_approval.json"), { fixture_only: true, not_real_operator_approval: true });
  const evidenceApproval = await writeJson(path.join(episodeDir, "pilot_evidence.json"), { fixture_only: true, not_real_evidence_approval: true });
  const editorialPath = path.join(episodeDir, "editorial-fixture.json");
  const editorial = { schema: "goldflow_avatar_pilot_narration_editorial_v1", source_script_sha256: identity.source_script.sha256,
    opening_unit_count: 2, script_approval: scriptApproval, evidence_approval: evidenceApproval,
    targeted_speakability: { source_text_unchanged: true, spoken_overrides: [], reviewer: "synthetic fixture; no listening" },
    editorial_units: structuredClone(fixture.plan.pilot_editorial_units) };
  await writeJson(editorialPath, editorial);
  const calls = [];
  const captured = {};
  const controls = {};
  const runtimeReferences = structuredClone(fixture.gateArgs.referenceAssetHashes);
  const workRoot = path.join(episodeDir, "pilot_narration_work");
  const dependencies = {
    getStatus: async (directory) => {
      calls.push("status"); assert.equal(directory, episodeDir);
      return { current_stage: controls.stage ?? "pilot_voice_sample", allowed_command_stages: controls.allowed ?? ["pilot_voice_sample"], identity };
    },
    inspectRuntime: async (...args) => {
      calls.push("runtime"); captured.runtimeArgs = args;
      if (controls.runtimeError) throw new Error(controls.runtimeError);
      if (controls.changeReference) await fs.writeFile(runtimeReferences.reference_audio.path, "stale synthetic reference bytes");
      if (controls.changeApproval) await fs.writeFile(scriptApproval.path, "stale synthetic approval bytes");
      return { referenceAssetHashes: runtimeReferences,
        provenance: { fixture_only: true, git_commit: "a".repeat(40), git_branch: "codex/synthetic-fixture", worktree_clean: true,
          python_path: process.execPath, runner: { path: fixture.execution.report.jobs_path, sha256: fixture.execution.report.jobs_sha256 } } };
    },
    synthesize: async (args) => {
      calls.push("synthesize"); captured.synthesis = structuredClone(args);
      assert.equal(args.route, "qwen"); assert.equal(args.attempt, 1);
      assert.equal(args.synthesisMode, args.policy.synthesis_contract.mode);
      assert.equal(args.outputDir, path.join(workRoot, "opening_execution"));
      assert.equal(args.plan.units.length, 3); assert.equal(args.units.length, 2);
      assert.deepEqual(args.units, args.plan.units.slice(0, 2));
      assert.deepEqual(args.acceptedUnitIds, []);
      assert.deepEqual(args.units.map((unit) => unit.execution_phase), ["opening", "opening"]);
      assert.equal(args.plan.units[2].execution_phase, "remaining");
      assert.equal(args.planPath, path.join(workRoot, "inputs", "narration_generation_plan.json"));
      assert.equal(args.planFileSha256, hash(await fs.readFile(args.planPath)));
      assert.equal(args.identityFileSha256, hash(await fs.readFile(args.identityPath)));
      assert.equal(args.scriptSha256, hash(await fs.readFile(args.scriptPath)));
      assert.equal(args.preSynthesisGateFileSha256, hash(await fs.readFile(args.preSynthesisGatePath)));
      const gate = await readJson(args.preSynthesisGatePath);
      assert.equal(gate.model_load_performed, true); assert.equal(gate.synthesis_invoked, true);
      assert.deepEqual(gate.scope.authorized_synthesis_unit_ids, args.plan.pilot_opening_unit_ids);
      assert.equal(gate.scope.mode, "pilot_opening_only");
      assert.equal(typeof args.invocationId, "string"); assert(args.invocationId.length > 20);
      assert(path.isAbsolute(args.python)); assert(path.isAbsolute(args.runnerPath));
      if (controls.synthesisError) throw new Error(controls.synthesisError);
      const execution = await syntheticExecution(fixture, args);
      if (controls.badResult) execution.results.reverse();
      if (controls.changeExternalEditorial) await fs.writeFile(editorialPath, "caller changed the original editorial after submission");
      return execution;
    },
    finalize: async (argv, { phaseContext }) => {
      calls.push("finalize"); captured.finalizer = { argv, phaseContext };
      assert.deepEqual(argv.slice(0, 4), ["--episode-dir", episodeDir, "--script", identity.source_script.path]);
      assert.equal(argv.length, 8); assert.equal(argv[4], "--plan"); assert.equal(argv[6], "--manifest");
      assert.equal(phaseContext.phase, "opening");
      assert.equal(phaseContext.outputNamespace, path.join(workRoot, "opening_finalization"));
      assert.equal(await exists(phaseContext.outputNamespace), false);
      const plan = await readJson(argv[5]); const manifest = await readJson(argv[7]);
      assert.equal(plan.units.length, 3); assert.deepEqual(manifest.units.map((row) => row.unit_id), plan.pilot_opening_unit_ids);
      assert.deepEqual(phaseContext.unitIds, plan.pilot_opening_unit_ids);
      assert.equal(phaseContext.generationPlanFileSha256, hash(await fs.readFile(argv[5])));
      assert.equal(phaseContext.providerManifestFileSha256, hash(await fs.readFile(argv[7])));
      assert.equal(manifest.provider_execution.phase, "opening");
      assert.equal(manifest.provider_execution.effective_concurrency, 1);
      assert.equal(manifest.provider_execution.synthesis_runs.length, 1);
      assert.equal(manifest.provider_execution.synthesis_runs[0].attempt, 1);
      assert.equal(manifest.provider_execution.synthesis_runs[0].synthesis_mode, captured.synthesis.policy.synthesis_contract.mode);
      assert.equal(phaseContext.sourceArtifacts.script_speakability_report_sha256.path, path.join(workRoot, "inputs", "editorial_input.json"));
      for (const ref of Object.values(phaseContext.sourceArtifacts)) assert.equal(ref.sha256, hash(await fs.readFile(ref.path)));
      if (controls.finalizationError) throw new Error(controls.finalizationError);
      await fs.mkdir(phaseContext.outputNamespace);
      const output = { status: "synthetic_boundary_result_not_quality_approval", subjective_review_status: "pending" };
      for (const key of ["final_wav", "tts_report_path", "stitch_report_path", "full_stream_qa_path", "voice_continuity_qa_path",
        "unit_delivery_qa_path", "unit_qa_path", "subjective_review_manifest_path", "timing_candidate_path"]) {
        output[key] = path.join(phaseContext.outputNamespace, `${key}.fixture.json`);
        await writeJson(output[key], { fixture_only: true, not_real_audio_or_qa: true });
      }
      if (controls.escapeOutput) output.tts_report_path = editorialPath;
      return output;
    },
  };
  return { fixture, episodeDir, identity, editorialPath, editorial, scriptApproval, evidenceApproval, workRoot,
    calls, controls, captured, dependencies, producer: createPilotOpeningProducer(dependencies), cleanup: fixture.cleanup };
}

const tests = [];
const test = (name, body) => tests.push([name, body]);
async function fixtureTest(body) { const setupResult = await setup(); try { await body(setupResult); } finally { await setupResult.cleanup(); } }
async function zeroSpend(f, error) {
  const before = await inventory(f.episodeDir);
  await assert.rejects(() => f.producer({ episodeDir: f.episodeDir, editorialPath: f.editorialPath }), error);
  assert(!f.calls.includes("synthesize")); assert(!f.calls.includes("finalize"));
  assert.deepEqual(await inventory(f.episodeDir), before);
}

test("blocked stage or unavailable command never reaches runtime, writes or synthesis", async () => {
  for (const control of [{ stage: "pilot_evidence" }, { allowed: [] }]) await fixtureTest(async (f) => {
    Object.assign(f.controls, control); await zeroSpend(f, /not authorized/); assert.deepEqual(f.calls, ["status"]);
  });
});
test("stale editorial source, changed approval, invalid scope and missing speakability stop before spend", async () => {
  for (const mutate of [
    (v) => { v.source_script_sha256 = "0".repeat(64); },
    (v) => { v.script_approval.sha256 = "0".repeat(64); },
    (v) => { v.opening_unit_count = 3; },
    (v) => { v.targeted_speakability.spoken_overrides = [{ from: "door", to: "wall" }]; },
    (v) => { v.editorial_units[1].source_start_utf16++; },
    (v) => { v.authorization = "synthetic forbidden header; not a credential"; },
  ]) await fixtureTest(async (f) => {
    mutate(f.editorial); await writeJson(f.editorialPath, f.editorial); await zeroSpend(f, /stale|changed|two complete|unchanged-source|pilot_plan|private credentials/);
    assert(!f.calls.includes("runtime"));
  });
});
test("runtime refusal and preexisting work namespace are no-spend and preserve all evidence", async () => {
  await fixtureTest(async (f) => { f.controls.runtimeError = "Synthetic stale runtime reference"; await zeroSpend(f, /stale runtime/); });
  await fixtureTest(async (f) => { await fs.mkdir(f.workRoot); await writeJson(path.join(f.workRoot, "preserved.json"), { preserve: true }); await zeroSpend(f, /EEXIST|existing|attempt|already/); });
});
test("changed source or identity bytes cannot reach the runtime boundary", async () => {
  await fixtureTest(async (f) => {
    await fs.writeFile(f.identity.source_script.path, "Different source words.");
    await zeroSpend(f, /hash changed/); assert(!f.calls.includes("runtime"));
  });
  await fixtureTest(async (f) => {
    await writeJson(path.join(f.episodeDir, "run_identity.json"), { ...f.identity, episode: "different_episode" });
    await zeroSpend(f, /identity/); assert(!f.calls.includes("runtime"));
  });
});
test("actual shared validation rejects changed runtime reference bytes before authorization", async () => {
  await fixtureTest(async (f) => {
    f.controls.changeReference = true;
    await assert.rejects(() => f.producer({ episodeDir: f.episodeDir, editorialPath: f.editorialPath }), /reference|hash/);
    assert(!f.calls.includes("synthesize")); assert(!f.calls.includes("finalize"));
    assert.equal(await exists(path.join(f.workRoot, "inputs", "pre_synthesis_authorized.json")), false);
  });
});
test("changed approval at the runtime boundary is rechecked before any model call", async () => {
  await fixtureTest(async (f) => {
    f.controls.changeApproval = true;
    await assert.rejects(() => f.producer({ episodeDir: f.episodeDir, editorialPath: f.editorialPath }), /hash changed/);
    assert(!f.calls.includes("synthesize")); assert(!f.calls.includes("finalize"));
    assert.equal(await exists(path.join(f.workRoot, "inputs", "pre_synthesis_authorized.json")), false);
  });
});
test("whole producer preserves full source and phase while dispatching only two original opening units", async () => {
  await fixtureTest(async (f) => {
    f.controls.changeExternalEditorial = true;
    const result = await f.producer({ episodeDir: f.episodeDir, editorialPath: f.editorialPath });
    assert.deepEqual(f.calls, ["status", "runtime", "synthesize", "finalize"]);
    assert.equal(result.phase, "opening"); assert.equal(result.production_eligible, false);
    assert.equal(result.publish_allowed, false); assert.equal(result.subjective_approval, null);
    assert.equal(Object.keys(result.finalization_artifacts).length, 9);
    for (const ref of Object.values(result.finalization_artifacts)) assert.equal(ref.sha256, hash(await fs.readFile(ref.path)));
    assert.deepEqual(await readJson(path.join(f.workRoot, "opening_producer_result.json")), result);
    f.calls.length = 0;
    // Restore the caller's editorial input so the durable work namespace, not a
    // deliberately stale caller file, is what prevents a second submission.
    await writeJson(f.editorialPath, f.editorial);
    const rerunBefore = await inventory(f.episodeDir);
    await assert.rejects(() => f.producer({ episodeDir: f.episodeDir, editorialPath: f.editorialPath }), /EEXIST|existing|attempt|already/);
    assert(!f.calls.includes("synthesize")); assert.deepEqual(await inventory(f.episodeDir), rerunBefore);
  });
});
test("relative caller paths are normalized before status, gating and finalization", async () => {
  await fixtureTest(async (f) => {
    const originalCwd = process.cwd(); process.chdir(path.dirname(f.episodeDir));
    try { await f.producer({ episodeDir: path.basename(f.episodeDir), editorialPath: path.relative(process.cwd(), f.editorialPath) }); }
    finally { process.chdir(originalCwd); }
    assert.deepEqual(f.calls, ["status", "runtime", "synthesize", "finalize"]);
  });
});
test("failed synthesis does not finalize, retry, or lose its immutable attempt barrier", async () => {
  await fixtureTest(async (f) => {
    f.controls.synthesisError = "Synthetic model-boundary failure; no model called";
    await assert.rejects(() => f.producer({ episodeDir: f.episodeDir, editorialPath: f.editorialPath }), /model-boundary failure/);
    assert.equal(f.calls.filter((call) => call === "synthesize").length, 1); assert(!f.calls.includes("finalize"));
    f.calls.length = 0;
    await zeroSpend(f, /EEXIST|existing|attempt|already/);
  });
});
test("malformed actual runner results cannot enter the finalizer", async () => {
  await fixtureTest(async (f) => {
    f.controls.badResult = true;
    await assert.rejects(() => f.producer({ episodeDir: f.episodeDir, editorialPath: f.editorialPath }), /runner report|runner results|out of order|incomplete/);
    assert(!f.calls.includes("finalize"));
  });
});
test("finalizer failure or escaped output cannot publish a producer success artifact", async () => {
  for (const control of [{ finalizationError: "Synthetic finalizer failure" }, { escapeOutput: true }]) await fixtureTest(async (f) => {
    Object.assign(f.controls, control);
    await assert.rejects(() => f.producer({ episodeDir: f.episodeDir, editorialPath: f.editorialPath }), /finalizer failure|escaped/);
    assert.equal(f.calls.filter((call) => call === "synthesize").length, 1);
    assert.equal(await exists(path.join(f.workRoot, "opening_producer_result.json")), false);
  });
});

for (const [name, body] of tests) { await body(); process.stdout.write(`PASS ${name}\n`); }
process.stdout.write(`opening producer tests passed (${tests.length}); synthetic boundaries only, no models or listening\n`);
