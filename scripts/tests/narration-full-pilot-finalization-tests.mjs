import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildPilotRemainingExecutionFixture } from "./avatar-pilot-remaining-execution-tests.mjs";
import { buildNarrationProviderOutputManifest, narrationProviderOutputManifestSha256 } from "../lib/narration-provider-adapter.mjs";
import { narrationTtsPolicyForIdentity, validateNarrationTtsPolicy } from "../lib/narration-tts-policy.mjs";
import { validateFullPilotNarrationFinalizationInputs, validatePilotFinalizationManifestRows } from "../lib/narration-opening-finalization.mjs";
import { validateFullPilotFinalizationExecutionEvidence } from "../lib/narration-full-pilot-finalization.mjs";
import { finalizeNarrationProviderOutput } from "../narration-provider-output-finalize.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = async (file, value) => { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); await fs.writeFile(file, bytes); return hash(bytes); };
async function inventory(directory) {
  const rows = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push([file, "directory"], ...await inventory(file));
    else rows.push([file, hash(await fs.readFile(file))]);
  }
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}

// All execution, audio, QA and approval records come from the clearly marked
// synthetic fixture. The real validators run, but no model or human listening
// is represented by this test. Strict production reference pins are not read.
const fixture = await buildPilotRemainingExecutionFixture();
const opening = fixture.openingFixture;
const { root: episodeDir, identity, plan } = opening;
const remaining = fixture.options;
const policy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), { production: true });
const openingManifest = await readJson(opening.result.provider_output_manifest.path);
const remainingRun = { attempt: 1, synthesis_mode: policy.synthesis_contract.mode,
  batch_plan_sha256: plan.pilot_phase_batch_plans.remaining.batch_plan_sha256,
  report_path: fixture.execution.reportPath, report_sha256: fixture.execution.reportSha256,
  cohort_events_path: fixture.execution.cohortEventsPath, cohort_events_sha256: fixture.execution.cohortEventsSha256 };
const originals = [...opening.execution.results, ...fixture.execution.results];
const manifest = buildNarrationProviderOutputManifest({ provider: policy.primary.provider,
  modelId: policy.primary.model_id, modelRevision: policy.primary.model_revision,
  voiceId: policy.primary.voice_id, voiceSha256: policy.primary.voice_sha256,
  voiceContinuityContract: policy.primary.voice_continuity_contract,
  generationPlanSha256: plan.plan_sha256, generationPlanFileSha256: remaining.planFileSha256,
  qualityContractSha256: policy.narration_quality_contract.contract_sha256,
  providerExecution: { phase: "full_pilot", synthesis_contract: policy.synthesis_contract,
    phase_batch_plans: plan.pilot_phase_batch_plans,
    synthesis_runs: [openingManifest.provider_execution.synthesis_runs[0], remainingRun], effective_concurrency: 1 },
  units: plan.units, results: originals.map((row, index) => ({ ...row,
    audio_path: row.output_path, audio_sha256: row.output_sha256,
    runner_report_path: index < plan.pilot_opening_unit_ids.length ? opening.execution.reportPath : fixture.execution.reportPath,
    runner_report_sha256: index < plan.pilot_opening_unit_ids.length ? opening.execution.reportSha256 : fixture.execution.reportSha256 })) });
assert.equal(manifest.status, "passed");
const manifestPath = path.join(episodeDir, "full-provider-manifest-fixture.json");
const manifestFileSha256 = await writeJson(manifestPath, manifest);
const sourceFields = Object.keys(remaining.preSynthesisGate.bindings.source_artifact_hashes ?? {})
  .filter((key) => !["script_clean_sha256", "run_identity_sha256"].includes(key));
assert.deepEqual(sourceFields, [], "this fixture has no extra upstream authoring files; separate opening tests cover their exact hashes");
const phaseContext = { phase: "full_pilot", outputNamespace: path.join(episodeDir, "pilot_narration_work", "full_finalization"),
  unitIds: plan.units.map((unit) => unit.unit_id), identitySha256: remaining.identityFileSha256,
  sourceScriptSha256: remaining.scriptSha256, generationPlanFileSha256: remaining.planFileSha256,
  providerManifestFileSha256: manifestFileSha256, sourceArtifacts: {}, acceptedOpening: fixture.acceptedOpening,
  preSynthesisGatePath: remaining.preSynthesisGatePath, preSynthesisGateFileSha256: remaining.preSynthesisGateFileSha256,
  textIrPath: opening.result.spoken_text_ir.path, textIrFileSha256: opening.result.spoken_text_ir.sha256,
  spokenTextAuditPath: opening.result.spoken_text_audit.path, spokenTextAuditFileSha256: opening.result.spoken_text_audit.sha256 };
const options = { phaseContext, episodeDir, identity, identityPath: remaining.identityPath,
  scriptPath: remaining.scriptPath, planPath: remaining.planPath, plan, manifestPath, manifest, policy };
const argv = ["--episode-dir", episodeDir, "--script", remaining.scriptPath, "--plan", remaining.planPath, "--manifest", manifestPath];

async function noWrites(body, expected) {
  const before = await inventory(episodeDir);
  const originalMkdir = fs.mkdir; let attempts = 0;
  fs.mkdir = async () => { attempts++; throw new Error("Unexpected full-finalization output creation"); };
  try { await assert.rejects(body, expected); }
  finally { fs.mkdir = originalMkdir; }
  assert.equal(attempts, 0, "rejection must precede output creation and new-stream QA");
  assert.deepEqual(await inventory(episodeDir), before);
}
async function changedManifest(mutate, body) {
  const changed = structuredClone(manifest); mutate(changed);
  changed.manifest_sha256 = narrationProviderOutputManifestSha256(changed);
  const sha256 = await writeJson(manifestPath, changed);
  const changedOptions = { ...options, manifest: changed, phaseContext: { ...phaseContext, providerManifestFileSha256: sha256 } };
  try { await body(changedOptions); } finally { await writeJson(manifestPath, manifest); }
}
const tests = [];
const test = (name, body) => tests.push([name, body]);
test("both authentic phases retain full order, original opening bytes and pending full listening", async () => {
  const before = await inventory(episodeDir);
  const checked = await validateFullPilotFinalizationExecutionEvidence(options);
  assert.deepEqual(checked.units, plan.units);
  assert.deepEqual(checked.synthesisRuns, manifest.provider_execution.synthesis_runs);
  assert.deepEqual(checked.phaseBatchPlans, plan.pilot_phase_batch_plans);
  assert.equal(checked.scope.phase, "full_pilot"); assert.equal(checked.scope.complete_episode, true);
  assert.equal(checked.scope.production_eligible, false); assert.equal(checked.scope.subjective_review_status, "pending");
  assert.deepEqual(checked.scope.preserved_unit_ids, plan.pilot_opening_unit_ids);
  assert.deepEqual(checked.scope.newly_synthesized_unit_ids, remaining.units.map((unit) => unit.unit_id));
  assert.deepEqual(checked.scope.accepted_opening, fixture.acceptedOpening);
  assert.equal(checked.scope.opening_reuse_contract, "original_raw_unit_wav_and_synthesis_identity_v1");
  assert.equal(Object.hasOwn(checked.scope, "batch_plan_sha256"), false);
  assert.deepEqual(await inventory(episodeDir), before);
});
test("full scope rejects prefix-only, remaining-only, reordered and unknown phase contexts", async () => {
  for (const context of [ { ...phaseContext, phase: "full" },
    { ...phaseContext, unitIds: [...phaseContext.unitIds].reverse() },
    { ...phaseContext, unitIds: plan.pilot_opening_unit_ids },
    { ...phaseContext, unitIds: remaining.units.map((unit) => unit.unit_id) } ]) {
    await noWrites(() => validateFullPilotNarrationFinalizationInputs({ ...options, phaseContext: context }), /phase|scope|source order/);
  }
});
test("full finalization cannot overwrite opening evidence or an existing full output namespace", async () => {
  await noWrites(() => validateFullPilotNarrationFinalizationInputs({ ...options, phaseContext: {
    ...phaseContext, outputNamespace: path.join(episodeDir, "pilot_narration_work", "opening_finalization") } }), /must be new|separate/);
  await fs.mkdir(phaseContext.outputNamespace);
  try { await noWrites(() => finalizeNarrationProviderOutput(argv, { phaseContext }), /must be new/); }
  finally { await fs.rmdir(phaseContext.outputNamespace); }
});
test("actual finalizer rejects stale source and canonical full-plan inputs before writes or models", async () => {
  for (const key of ["identitySha256", "generationPlanFileSha256", "providerManifestFileSha256", "preSynthesisGateFileSha256",
    "textIrFileSha256", "spokenTextAuditFileSha256"]) {
    await noWrites(() => finalizeNarrationProviderOutput(argv, { phaseContext: { ...phaseContext, [key]: "0".repeat(64) } }), /hash is stale/);
  }
  const original = await fs.readFile(options.scriptPath);
  await fs.appendFile(options.scriptPath, " Unapproved new words.");
  try { await noWrites(() => finalizeNarrationProviderOutput(argv, { phaseContext }), /actual approved script/); }
  finally { await fs.writeFile(options.scriptPath, original); }
});
test("fictitious aggregate batches, swapped phase plans or incomplete run receipts stop before QA", async () => {
  for (const mutate of [
    (row) => { row.provider_execution.batch_plan_sha256 = plan.pilot_phase_batch_plans.opening.batch_plan_sha256; },
    (row) => { row.provider_execution.phase_batch_plans.remaining = row.provider_execution.phase_batch_plans.opening; },
    (row) => { row.provider_execution.synthesis_runs.reverse(); },
    (row) => { row.provider_execution.synthesis_runs.pop(); },
    (row) => { row.provider_execution.phase = "opening"; },
    (row) => { row.units.reverse(); },
  ]) await changedManifest(mutate, async (changed) => {
    await noWrites(() => finalizeNarrationProviderOutput(argv, { phaseContext: changed.phaseContext }), /frozen phase|execution|source order/);
  });
});
test("stale or missing genuine opening stage/listening approval cannot finalize the full pilot", async () => {
  for (const context of [ { ...phaseContext, acceptedOpening: null },
    { ...phaseContext, acceptedOpening: { ...fixture.acceptedOpening, approval: { ...fixture.acceptedOpening.approval, sha256: "0".repeat(64) } } },
    { ...phaseContext, acceptedOpening: { ...fixture.acceptedOpening, sample: { ...fixture.acceptedOpening.sample, sha256: "0".repeat(64) } } } ]) {
    await noWrites(() => finalizeNarrationProviderOutput(argv, { phaseContext: context }), /accepted opening|approval|artifact hash/);
  }
});
test("changed raw opening units and changed sidecars invalidate reuse before new-stream QA", async () => {
  for (const file of [opening.execution.results[0].output_path, opening.execution.results[0].sidecar_path]) {
    const original = await fs.readFile(file); await fs.appendFile(file, "changed original fixture evidence");
    try { await noWrites(() => validateFullPilotFinalizationExecutionEvidence(options), /opening technical evidence|sidecar|hash/); }
    finally { await fs.writeFile(file, original); }
  }
});
test("identical-byte copied opening audio and changed per-unit execution metadata are not original-unit reuse", async () => {
  const copy = path.join(episodeDir, "copied-not-original-opening.wav");
  await fs.copyFile(opening.execution.results[0].output_path, copy);
  for (const mutate of [
    (row) => { row.units[0].audio_path = copy; },
    (row) => { row.units[0].duration_sec += 0.1; },
    (row) => { row.units[0].cohort_id = "not-original"; },
    (row) => { row.units[0].runner_report_sha256 = remainingRun.report_sha256; },
  ]) await changedManifest(mutate, async (changed) => {
    await noWrites(() => validateFullPilotFinalizationExecutionEvidence(changed), /approved opening provider units|original runner|provider manifest contract/);
  });
});
test("every raw manifest row retains its exact report, phase cohort, identity and timing", async () => {
  const outputRows = manifest.units.slice(plan.pilot_opening_unit_ids.length);
  validatePilotFinalizationManifestRows(outputRows, fixture.execution.report, remainingRun);
  for (const field of ["audio_sha256", "synthesis_identity_sha256", "cohort_sha256", "batch_plan_sha256", "runner_report_path"]) {
    const changed = structuredClone(outputRows); changed[0][field] = "changed";
    assert.throws(() => validatePilotFinalizationManifestRows(changed, fixture.execution.report, remainingRun), /original/);
  }
});
test("full finalization cannot inherit opening listening approval or accept QA waiver flags", async () => {
  for (const flag of ["workflow-bypass", "skip-subjective-review", "accept-asr-delivery-blockers", "accept-review-warnings",
    "manual-review-evidence", "listen-decision", "output-dir", "checkpoint"]) {
    await noWrites(() => finalizeNarrationProviderOutput([...argv, `--${flag}`, "false"], { phaseContext }), /unavailable/);
  }
});

try {
  for (const [name, body] of tests) { await body(); process.stdout.write(`PASS ${name}\n`); }
  process.stdout.write(`full-pilot finalization tests passed (${tests.length}); synthetic evidence only, no synthesis or fresh QA models\n`);
} finally { await fixture.cleanup(); }
