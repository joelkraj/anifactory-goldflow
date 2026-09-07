import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPilotNarrationProducer } from "../lib/avatar-pilot-narration-producer.mjs";
import { buildPilotRemainingExecutionFixture } from "./avatar-pilot-remaining-execution-tests.mjs";
import { validateFullPilotFinalizationExecutionEvidence } from "../lib/narration-full-pilot-finalization.mjs";
import { narrationTtsPolicyForIdentity, validateNarrationTtsPolicy } from "../lib/narration-tts-policy.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
async function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); await fs.writeFile(file, bytes);
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
const paragraphs = [
  "A small light reveals the stairs ahead. The traveler waits until her companion reaches the door before they move toward the next landing.",
  "The stairs turn sharply behind a stone column. She marks their route with a piece of chalk so they can find the same exit again.",
  "A loose board creaks beneath his boot. Both travelers stop and listen, but the room beyond the wall remains silent for another long moment.",
  "Their lamp begins to dim as they reach the landing. She shields its flame with her hand while her companion opens the narrow wooden door.",
  "Inside the room they find an empty desk and a folded map. Neither traveler touches the papers until they have checked the windows and floor.",
  "They leave the room together and follow their marks back outside. This invented fixture ends without claiming that its synthetic sound is a real voice.",
];

// Synthetic jobs, silence, QA and approval metadata belong only to this fixture.
// Actual source/phase/gate/runner validators remain active; no model, provider,
// genuine human approval or real proof artifact is created by this suite.
async function setup() {
  const fixture = await buildPilotRemainingExecutionFixture({ unitDurationSec: 2, remainingParagraphs: paragraphs });
  try {
    const { root: episodeDir, identity, openingFixture: opening } = fixture;
    const plan = opening.plan, sample = opening.result;
    const openingManifest = await readJson(sample.provider_output_manifest.path);
    const workRoot = path.join(episodeDir, "pilot_narration_work"), remainingRoot = path.join(workRoot, "remaining");
    const fullNamespace = path.join(workRoot, "full_finalization");
    // Preserve the shared fixture's prebuilt synthetic tail as a template. The
    // real producer must still acquire its own new remaining namespace once.
    const template = { jobs: await readJson(fixture.execution.report.jobs_path),
      report: structuredClone(fixture.execution.report), results: structuredClone(fixture.execution.results), audio: new Map() };
    for (const row of template.results) template.audio.set(row.unit_id, await fs.readFile(row.output_path));
    await fs.rename(remainingRoot, path.join(episodeDir, "synthetic-remaining-template"));
    const protectedFiles = (await inventory(episodeDir)).filter(([, value]) => value !== "directory");
    const calls = [], controls = {}, captured = {};
    const references = structuredClone(opening.gateArgs.referenceAssetHashes);
    const policy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), { production: true });
    const assertPreserved = async () => {
      for (const [file, sha256] of protectedFiles) assert.equal(hash(await fs.readFile(file)), sha256, `original fixture changed: ${file}`);
    };
    const dependencies = {
      getStatus: async (directory) => {
        calls.push("status"); assert.equal(directory, episodeDir);
        return { current_stage: controls.stage ?? "pilot_narration", allowed_command_stages: controls.allowed ?? ["pilot_narration"], identity };
      },
      inspectRuntime: async (args) => {
        calls.push("runtime"); captured.runtime = args;
        if (!controls.allowExistingRemaining) assert.equal(await exists(remainingRoot), false);
        assert.equal(args.policy.primary.model_id, policy.primary.model_id);
        assert.deepEqual(args.bank, identity.narration_delivery_reference_bank);
        if (controls.runtimeError) throw new Error("Synthetic clean-runtime gate refusal; no model called");
        if (controls.changeApproval) await fs.appendFile(fixture.acceptedOpening.approval.path, "changed at runtime boundary");
        if (controls.changeReference) await fs.writeFile(references.reference_audio.path, "changed synthetic reference");
        return { referenceAssetHashes: references, provenance: { fixture_only: true, git_commit: "b".repeat(40),
          git_branch: "codex/synthetic-full-pilot", worktree_clean: true, python_path: process.execPath,
          runner: { path: args.runnerPath, sha256: hash("synthetic runtime inspection; runner never executed") } } };
      },
      synthesize: async (args) => {
        calls.push("synthesize"); captured.synthesis = structuredClone(args);
        assert.deepEqual(args.plan, plan); assert.equal(args.plan.units.length, 8); assert.equal(args.units.length, 6);
        assert.deepEqual(args.units, plan.units.slice(2)); assert.deepEqual(args.acceptedUnitIds, plan.pilot_opening_unit_ids);
        assert.deepEqual(args.acceptedOpening, fixture.acceptedOpening);
        assert.deepEqual(args.batchPlan, plan.pilot_phase_batch_plans.remaining);
        assert.deepEqual(args.batchPlan.cohorts.map((cohort) => cohort.effective_batch_size), [4, 2]);
        assert.deepEqual(args.units.map((unit) => unit.order_index), [2, 3, 4, 5, 6, 7]);
        assert(args.units.every((unit) => unit.execution_phase === "remaining" && !plan.pilot_opening_unit_ids.includes(unit.unit_id)));
        assert.equal(args.route, "qwen"); assert.equal(args.attempt, 1); assert.equal(args.synthesisMode, policy.synthesis_contract.mode);
        assert.equal(args.outputDir, path.join(remainingRoot, "execution"));
        assert.equal(args.planPath, sample.generation_plan.path); assert.equal(args.planFileSha256, sample.generation_plan.sha256);
        assert.equal(args.planFileSha256, hash(await fs.readFile(args.planPath)));
        assert.equal(args.scriptSha256, hash(await fs.readFile(args.scriptPath)));
        assert.equal(args.identityFileSha256, hash(await fs.readFile(args.identityPath)));
        assert.equal(args.preSynthesisGateFileSha256, hash(await fs.readFile(args.preSynthesisGatePath)));
        const gate = await readJson(args.preSynthesisGatePath);
        assert.equal(gate.scope.mode, "pilot_remaining_only");
        assert.deepEqual(gate.scope.authorized_synthesis_unit_ids, args.units.map((unit) => unit.unit_id));
        assert.deepEqual(gate.scope.preserved_unit_ids, plan.pilot_opening_unit_ids);
        assert.equal(gate.scope.preserved_artifacts.length, 2);
        assert.deepEqual(gate.scope.preserved_artifacts.map((row) => row.audio_sha256), opening.execution.results.map((row) => row.output_sha256));
        assert.equal(gate.scope.evidence_path, fixture.acceptedOpening.approval.path);
        assert.equal(gate.scope.evidence_sha256, fixture.acceptedOpening.approval.sha256);
        assert.equal(gate.model_load_performed, true); assert.equal(gate.synthesis_invoked, true);
        assert(path.isAbsolute(args.python)); assert(path.isAbsolute(args.runnerPath)); assert(args.invocationId.length > 20);
        await assertPreserved();
        if (controls.synthesisError) throw new Error("Synthetic remaining-model boundary failure; no model called");
        await fs.mkdir(args.outputDir);
        const jobs = { ...structuredClone(template.jobs), pre_synthesis_gate: { path: args.preSynthesisGatePath,
          file_sha256: args.preSynthesisGateFileSha256, gate_sha256: gate.gate_sha256 } };
        const jobsRef = await writeJson(path.join(args.outputDir, "fixture-jobs.json"), jobs);
        const results = structuredClone(template.results);
        for (const row of results) {
          row.output_path = path.join(args.outputDir, `${row.unit_id}.wav`); row.sidecar_path = row.output_path.replace(/\.wav$/u, ".json");
          await fs.writeFile(row.output_path, template.audio.get(row.unit_id)); await writeJson(row.sidecar_path, row);
        }
        const report = { ...structuredClone(template.report), results, jobs_path: jobsRef.path, jobs_sha256: jobsRef.sha256,
          pre_synthesis_gate_path: args.preSynthesisGatePath, pre_synthesis_gate_file_sha256: args.preSynthesisGateFileSha256,
          pre_synthesis_gate_sha256: gate.gate_sha256, cohort_event_path: path.join(args.outputDir, "fixture-events.jsonl") };
        const events = args.batchPlan.cohorts.map((cohort, index) => ({ schema: "goldflow_local_tts_cohort_event_v1", event: "cohort_complete",
          jobs_sha256: jobsRef.sha256, batch_plan_sha256: args.batchPlan.batch_plan_sha256,
          cohort_id: cohort.cohort_id, cohort_sha256: cohort.cohort_sha256, cohort_index: cohort.cohort_index,
          execution: report.cohort_executions[index], results: cohort.members.map((member) => results.find((row) => row.unit_id === member.unit_id)) }));
        const eventBytes = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
        await fs.writeFile(report.cohort_event_path, eventBytes);
        const reportRef = await writeJson(path.join(args.outputDir, "fixture-runner.json"), report);
        const execution = { report, results, reportPath: reportRef.path, reportSha256: reportRef.sha256,
          cohortEventsPath: report.cohort_event_path, cohortEventsSha256: hash(eventBytes) };
        if (controls.badResult) execution.results.reverse();
        if (controls.mutateOpeningAfterSynthesis) await fs.appendFile(opening.execution.results[0].output_path, "changed original unit");
        captured.execution = execution;
        return execution;
      },
      finalize: async (argv, { phaseContext }) => {
        calls.push("finalize"); captured.finalizer = { argv, phaseContext };
        assert.deepEqual(argv.slice(0, 6), ["--episode-dir", episodeDir, "--script", identity.source_script.path, "--plan", sample.generation_plan.path]);
        assert.equal(argv.length, 8); assert.equal(argv[6], "--manifest");
        const manifest = await readJson(argv[7]);
        assert.equal(manifest.provider_execution.phase, "full_pilot");
        assert.equal(manifest.provider_execution.batch_plan_sha256, undefined);
        assert.deepEqual(manifest.provider_execution.phase_batch_plans, plan.pilot_phase_batch_plans);
        assert.equal(manifest.provider_execution.synthesis_runs.length, 2);
        assert.deepEqual(manifest.provider_execution.synthesis_runs[0], openingManifest.provider_execution.synthesis_runs[0]);
        assert.equal(manifest.provider_execution.synthesis_runs[1].report_sha256, captured.execution.reportSha256);
        assert.equal(manifest.provider_execution.synthesis_runs[1].batch_plan_sha256, plan.pilot_phase_batch_plans.remaining.batch_plan_sha256);
        assert.deepEqual(manifest.units.slice(0, 2), openingManifest.units);
        assert.deepEqual(manifest.units.map((row) => row.unit_id), plan.units.map((unit) => unit.unit_id));
        assert.equal(phaseContext.phase, "full_pilot"); assert.equal(phaseContext.outputNamespace, fullNamespace);
        assert.deepEqual(phaseContext.unitIds, plan.units.map((unit) => unit.unit_id));
        assert.deepEqual(phaseContext.acceptedOpening, fixture.acceptedOpening);
        assert.equal(phaseContext.providerManifestFileSha256, hash(await fs.readFile(argv[7])));
        assert.equal(phaseContext.preSynthesisGateFileSha256, captured.synthesis.preSynthesisGateFileSha256);
        assert.equal(phaseContext.preSynthesisGatePath, captured.synthesis.preSynthesisGatePath);
        for (const field of ["identitySha256", "sourceScriptSha256", "generationPlanFileSha256", "textIrPath", "textIrFileSha256",
          "spokenTextAuditPath", "spokenTextAuditFileSha256", "sourceArtifacts"]) {
          assert.deepEqual(phaseContext[field], sample.finalized.phase_context[field]);
        }
        const verified = await validateFullPilotFinalizationExecutionEvidence({ phaseContext, episodeDir, identity,
          identityPath: captured.synthesis.identityPath, scriptPath: identity.source_script.path, planPath: sample.generation_plan.path,
          plan, manifestPath: argv[7], manifest, policy });
        assert.equal(verified.scope.subjective_review_status, "pending"); await assertPreserved();
        if (controls.finalizationError) throw new Error("Synthetic full-finalizer failure");
        await fs.mkdir(fullNamespace);
        const finalized = { status: "synthetic_boundary_result_not_quality_approval", subjective_review_status: "pending",
          phase_context: phaseContext, finalization_scope: verified.scope };
        for (const key of ["final_wav", "tts_report_path", "stitch_report_path", "full_stream_qa_path", "voice_continuity_qa_path",
          "unit_delivery_qa_path", "unit_qa_path", "subjective_review_manifest_path", "timing_candidate_path"]) {
          finalized[key] = path.join(fullNamespace, `${key}.fixture.json`);
          await writeJson(finalized[key], { fixture_only: true, not_real_audio_or_qa: true });
        }
        if (controls.escapeOutput) finalized.tts_report_path = sample.finalization_artifacts.tts_report.path;
        return finalized;
      },
    };
    return { fixture, episodeDir, identity, sample, plan, calls, controls, captured, dependencies, workRoot, remainingRoot, fullNamespace,
      assertPreserved, producer: createPilotNarrationProducer(dependencies), cleanup: fixture.cleanup };
  } catch (error) { await fixture.cleanup(); throw error; }
}

const tests = [];
const test = (name, body) => tests.push([name, body]);
async function withFixture(body) { const f = await setup(); try { await body(f); } finally { await f.cleanup(); } }
async function zeroSpend(f, expected) {
  const before = await inventory(f.episodeDir);
  await assert.rejects(() => f.producer({ episodeDir: f.episodeDir }), expected);
  assert(!f.calls.includes("synthesize")); assert(!f.calls.includes("finalize"));
  assert.deepEqual(await inventory(f.episodeDir), before);
}

test("wrong stage or unavailable full command stops before runtime or writes", async () => {
  for (const control of [{ stage: "pilot_voice_sample_approval" }, { allowed: [] }]) await withFixture(async (f) => {
    Object.assign(f.controls, control); await zeroSpend(f, /not authorized/); assert.deepEqual(f.calls, ["status"]);
  });
});
test("clean-runtime gate refusal precedes any remaining namespace or model call", async () => {
  await withFixture(async (f) => { f.controls.runtimeError = true; await zeroSpend(f, /clean-runtime gate refusal/); assert.deepEqual(f.calls, ["status", "runtime"]); });
});
test("changed approved source, full plan, approval or canonical listening decision stops before runtime", async () => {
  for (const key of ["source", "plan", "approval", "decision"]) await withFixture(async (f) => {
    const files = { source: f.identity.source_script.path, plan: f.sample.generation_plan.path,
      approval: f.fixture.acceptedOpening.approval.path, decision: f.fixture.accepted.approval.subjective_decision.path };
    if (key === "approval") {
      const stage = await readJson(files.approval); stage.payload.review.approved = false; await writeJson(files.approval, stage);
    } else await fs.appendFile(files[key], "changed bound fixture bytes");
    await zeroSpend(f, /hash|approval|listening|artifact/); assert(!f.calls.includes("runtime"));
  });
});
test("changes after runtime inspection are rechecked before remaining synthesis", async () => {
  for (const control of [{ changeApproval: true }, { changeReference: true }]) await withFixture(async (f) => {
    Object.assign(f.controls, control);
    await assert.rejects(() => f.producer({ episodeDir: f.episodeDir }), /hash|opening|reference|JSON/);
    assert(!f.calls.includes("synthesize")); assert(!f.calls.includes("finalize"));
    assert.equal(await exists(path.join(f.remainingRoot, "inputs", "pre_synthesis_authorized.json")), false);
  });
});
test("full orchestration synthesizes only frozen six-unit tail and finalizes two original execution phases", async () => {
  await withFixture(async (f) => {
    const result = await f.producer({ episodeDir: f.episodeDir });
    assert.deepEqual(f.calls, ["status", "runtime", "synthesize", "finalize"]);
    assert.equal(result.phase, "full_pilot"); assert.equal(result.production_eligible, false); assert.equal(result.publish_allowed, false);
    assert.equal(result.subjective_approval, null); assert.equal(result.finalized.subjective_review_status, "pending");
    assert.deepEqual(result.accepted_opening, f.fixture.acceptedOpening);
    assert.deepEqual(result.generation_plan, f.sample.generation_plan);
    assert.deepEqual(result.spoken_text_ir, f.sample.spoken_text_ir); assert.deepEqual(result.spoken_text_audit, f.sample.spoken_text_audit);
    assert.equal(Object.keys(result.finalization_artifacts).length, 9);
    for (const ref of Object.values(result.finalization_artifacts)) assert.equal(ref.sha256, hash(await fs.readFile(ref.path)));
    assert.deepEqual(await readJson(path.join(f.workRoot, "narration_producer_result.json")), result);
    await f.assertPreserved();
    f.calls.length = 0; f.controls.allowExistingRemaining = true;
    await zeroSpend(f, /EEXIST|existing|already/);
  });
});
test("relative episode directory is normalized before status and all downstream calls", async () => {
  await withFixture(async (f) => {
    const originalCwd = process.cwd(); process.chdir(path.dirname(f.episodeDir));
    try { await f.producer({ episodeDir: path.basename(f.episodeDir) }); }
    finally { process.chdir(originalCwd); }
    assert.deepEqual(f.calls, ["status", "runtime", "synthesize", "finalize"]);
  });
});
test("existing remaining work preserves history and blocks another phase submission", async () => {
  await withFixture(async (f) => {
    await fs.mkdir(f.remainingRoot); await writeJson(path.join(f.remainingRoot, "preserved-attempt.json"), { preserve: true });
    // Runtime inspection remains read-only when the exclusive directory lock
    // subsequently refuses replay.
    f.controls.allowExistingRemaining = true;
    await zeroSpend(f, /EEXIST|existing|already/);
  });
});
test("a failed model boundary never retries or enters full finalization", async () => {
  await withFixture(async (f) => {
    f.controls.synthesisError = true;
    await assert.rejects(() => f.producer({ episodeDir: f.episodeDir }), /remaining-model boundary failure/);
    assert.equal(f.calls.filter((call) => call === "synthesize").length, 1); assert(!f.calls.includes("finalize"));
    await f.assertPreserved(); f.calls.length = 0; f.controls.allowExistingRemaining = true;
    await zeroSpend(f, /EEXIST|existing|already/);
  });
});
test("stale opening after synthesis and invalid new results cannot reach the full finalizer", async () => {
  for (const control of [{ badResult: true }, { mutateOpeningAfterSynthesis: true }]) await withFixture(async (f) => {
    Object.assign(f.controls, control);
    await assert.rejects(() => f.producer({ episodeDir: f.episodeDir }), /report|hash|opening technical/);
    assert.equal(f.calls.filter((call) => call === "synthesize").length, 1); assert(!f.calls.includes("finalize"));
  });
});
test("full-finalizer error or escaped opening path cannot produce a success receipt", async () => {
  for (const control of [{ finalizationError: true }, { escapeOutput: true }]) await withFixture(async (f) => {
    Object.assign(f.controls, control);
    await assert.rejects(() => f.producer({ episodeDir: f.episodeDir }), /full-finalizer failure|escaped/);
    assert.equal(await exists(path.join(f.workRoot, "narration_producer_result.json")), false);
    assert.equal(f.calls.filter((call) => call === "synthesize").length, 1); await f.assertPreserved();
  });
});

for (const [name, body] of tests) { await body(); process.stdout.write(`PASS ${name}\n`); }
process.stdout.write(`full pilot narration producer tests passed (${tests.length}); synthetic boundaries only, no models or real listening\n`);
