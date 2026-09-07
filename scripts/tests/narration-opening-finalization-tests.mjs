import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildPilotNarrationPlans } from "../lib/avatar-pilot-narration-plan.mjs";
import { buildPilotNarrationIdentityFields } from "../lib/avatar-pilot-narration-contract.mjs";
import { QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK as JOEL, narrationTtsPolicyForIdentity, validateNarrationTtsPolicy } from "../lib/narration-tts-policy.mjs";
import { buildNarrationPreSynthesisGate, authorizeNarrationPreSynthesisGate, narrationPreSynthesisGateSha256 } from "../lib/narration-pre-synthesis-gate.mjs";
import { buildNarrationSubjectiveReviewManifest, validateNarrationSubjectiveReviewManifest } from "../lib/narration-subjective-review.mjs";
import { validateOpeningNarrationFinalizationInputs, validateOpeningFinalizationNamespace, validateOpeningFinalizationFlags } from "../lib/narration-opening-finalization.mjs";
import { finalizeNarrationProviderOutput } from "../narration-provider-output-finalize.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-opening-finalization-test-"));
const episodeDir = await fs.realpath(scratch);
const workRoot = path.join(episodeDir, "pilot_narration_work");
await fs.mkdir(workRoot);
const tests = [];
const test = (name, body) => tests.push([name, body]);

// Synthetic text and metadata only: these fixtures never load a voice/model,
// synthesize or decode audio, or claim that any real person listened.
const paragraphs = [
  "A traveler approaches the sealed door. A guard steps between him and the control panel before the warning light changes.",
  "This is an invented test of a decision. The guard can keep the door closed, but cannot know what waits outside.",
  "He chooses to wait for the others. The example ends without claiming that a technical test proves the quality of a human performance.",
];
const sourceBytes = Buffer.from(`${paragraphs.join("\n\n")}\n`);
const scriptPath = path.join(episodeDir, "approved.md");
await fs.writeFile(scriptPath, sourceBytes);
const bankPath = fileURLToPath(new URL("../../config/narration_delivery_reference_bank.json", import.meta.url));
const deliveryBank = { path: bankPath, bytes: await fs.readFile(bankPath) };
const narrationLock = { provider: JOEL.provider, model: JOEL.model_id, model_revision: JOEL.model_revision,
  voice_id: JOEL.voice_id, voice_sha256: JOEL.voice_sha256, reference_audio_sha256: JOEL.reference_audio_sha256,
  reference_text_sha256: JOEL.reference_text_sha256 };
const identity = {
  schema: "goldflow_avatar_pilot_identity_v1", media_workflow: "avatar_footage_pilot_v1", content_profile: "mcu_what_if_pilot_v1",
  episode: "ep_fixture", run_intent: "proof", production_eligible: false, publish_allowed: false,
  source_script: { path: scriptPath, sha256: digest(sourceBytes) }, pilot_providers: { narration: narrationLock },
  ...buildPilotNarrationIdentityFields({ narrationLock, deliveryBank }),
};
const identityPath = path.join(episodeDir, "run_identity.json");
await fs.writeFile(identityPath, jsonBytes(identity));
const identityFileSha256 = digest(jsonBytes(identity));
const approvalPath = path.join(episodeDir, "synthetic-source-evidence.json");
const approvalBytes = jsonBytes({ fixture_only: true, not_a_real_approval: true });
await fs.writeFile(approvalPath, approvalBytes);
const sourceArtifacts = { pilot_script_approval_sha256: { path: approvalPath, sha256: digest(approvalBytes) } };
const sourceArtifactHashes = Object.fromEntries(Object.entries(sourceArtifacts).map(([key, value]) => [key, value.sha256]));
let offset = 0;
const editorialUnits = paragraphs.map((paragraph, index) => {
  const start = sourceBytes.toString().indexOf(paragraph, offset); offset = start + paragraph.length;
  return { source_start_utf16: start, source_end_utf16: offset,
    boundary_class: index === paragraphs.length - 1 ? "episode_end" : "paragraph",
    performance_intent: { energy: "controlled", emphasis: [], pause_strategy: "punctuation_led" } };
});
const built = buildPilotNarrationPlans({ sourceBytes, sourceScriptSha256: digest(sourceBytes), identity,
  identityBytes: jsonBytes(identity), identityFileSha256, deliveryBank, editorialUnits, openingUnitCount: 2, sourceArtifactHashes });
const planPath = path.join(workRoot, "plan.json");
const textIrPath = path.join(workRoot, "ir.json");
const spokenTextAuditPath = path.join(workRoot, "audit.json");
const manifestPath = path.join(workRoot, "manifest.json");
const manifest = { fixture_only: true, units: [] }; // Core input check does not assert runner/audio acceptance.
for (const [file, value] of [[planPath, built.plan], [textIrPath, built.textIr], [spokenTextAuditPath, built.spokenTextAudit], [manifestPath, manifest]]) {
  await fs.writeFile(file, jsonBytes(value));
}
const preSynthesisGatePath = path.join(workRoot, "authorized-gate.json");
const validationGate = buildNarrationPreSynthesisGate({ plan: built.plan, planPath, planFileSha256: digest(jsonBytes(built.plan)),
  identityPath, identityFileSha256, scriptPath, scriptSha256: digest(sourceBytes), policy: built.policy, planPolicy: built.planPolicy,
  sourceArtifactHashes, textIr: built.textIr, textIrPath, textIrFileSha256: digest(jsonBytes(built.textIr)),
  spokenTextAudit: built.spokenTextAudit, spokenTextAuditPath, spokenTextAuditFileSha256: digest(jsonBytes(built.spokenTextAudit)),
  synthesisScope: { mode: "pilot_opening_only", authorized_synthesis_unit_ids: built.phases.opening.unit_ids,
    preserved_unit_ids: [], preserved_artifacts: [], evidence_path: approvalPath, evidence_sha256: digest(approvalBytes) } });
assert.equal(validationGate.status, "passed", JSON.stringify(validationGate.findings));
const authorizedGate = authorizeNarrationPreSynthesisGate(validationGate);
await fs.writeFile(preSynthesisGatePath, jsonBytes(authorizedGate));
const phaseContext = { phase: "opening", outputNamespace: path.join(workRoot, "opening_finalization"),
  unitIds: built.phases.opening.unit_ids, identitySha256: identityFileSha256, sourceScriptSha256: digest(sourceBytes),
  generationPlanFileSha256: digest(jsonBytes(built.plan)), providerManifestFileSha256: digest(jsonBytes(manifest)),
  preSynthesisGatePath, preSynthesisGateFileSha256: digest(jsonBytes(authorizedGate)), textIrPath,
  textIrFileSha256: digest(jsonBytes(built.textIr)), spokenTextAuditPath,
  spokenTextAuditFileSha256: digest(jsonBytes(built.spokenTextAudit)), sourceArtifacts };
const policy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), { production: true });
const options = { phaseContext, episodeDir, identityPath, identity, scriptPath, planPath, plan: built.plan, manifestPath, manifest, policy };
const argv = ["--episode-dir", episodeDir, "--script", scriptPath, "--plan", planPath, "--manifest", manifestPath];
async function inventory(directory = episodeDir) {
  const rows = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) rows.push([file, "directory"], ...await inventory(file));
    else if (item.isSymbolicLink()) rows.push([file, "symlink", await fs.readlink(file)]);
    else rows.push([file, digest(await fs.readFile(file))]);
  }
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}
async function noWrites(body, expected) {
  const before = await inventory();
  // mkdir is the first effect before the finalizer imports its QA helper. Trap
  // it as well as comparing files, so a rejected input cannot enter that lane.
  const originalMkdir = fs.mkdir;
  let mkdirCalls = 0;
  fs.mkdir = async () => { mkdirCalls++; throw new Error("Unexpected pre-QA output creation"); };
  try { await assert.rejects(body, expected); }
  finally { fs.mkdir = originalMkdir; }
  assert.equal(mkdirCalls, 0, "blocked input must stop before first output/QA boundary");
  assert.deepEqual(await inventory(), before);
}

test("verified full source/IR/audit produces the original read-only prefix without authoring a phase plan", async () => {
  const before = await inventory();
  const result = await validateOpeningNarrationFinalizationInputs(options);
  assert.deepEqual(result.units, built.plan.units.slice(0, 2));
  assert.equal(result.planPolicy.status, "passed");
  assert.equal(result.outputNamespace, phaseContext.outputNamespace);
  assert.deepEqual(await inventory(), before);
  assert.equal(built.plan.units.length, 3);
  assert.deepEqual(result.units.map((unit) => unit.synthesis_cohort), built.phases.opening.units.map((unit) => unit.synthesis_cohort));
});
test("full phase, empty/gapped/reordered opening and altered policy fail before writes", async () => {
  for (const context of [ { ...phaseContext, phase: "full" }, { ...phaseContext, unitIds: [] },
    { ...phaseContext, unitIds: [...phaseContext.unitIds].reverse() },
    { ...phaseContext, unitIds: [built.plan.units[0].unit_id, built.plan.units[2].unit_id] } ]) {
    await noWrites(() => validateOpeningNarrationFinalizationInputs({ ...options, phaseContext: context }), /Opening finalization/);
  }
  await noWrites(() => validateOpeningNarrationFinalizationInputs({ ...options, policy: { ...policy, primary: { ...policy.primary, voice_id: "different" } } }), /canonical identity/);
});
test("all QA waiver, history and output overrides are rejected, including false values", async () => {
  for (const flag of ["workflow-bypass", "accept-asr-delivery-blockers", "accept-review-warnings", "skip-subjective-review",
    "delivery-waiver-reason", "manual-review-evidence", "listen-decision", "output-dir", "checkpoint"]) {
    assert.throws(() => validateOpeningFinalizationFlags({ [flag]: "false" }), /unavailable/);
    await noWrites(() => finalizeNarrationProviderOutput([...argv, `--${flag}`, "false"], { phaseContext }), /unavailable/);
  }
});
test("actual finalizer refuses stale source before output creation, QA import or model execution", async () => {
  await fs.writeFile(scriptPath, Buffer.concat([sourceBytes, Buffer.from(" Changed.")]));
  try { await noWrites(() => finalizeNarrationProviderOutput(argv, { phaseContext }), /actual approved script/); }
  finally { await fs.writeFile(scriptPath, sourceBytes); }
});
test("actual finalizer refuses stale plan/identity/manifest/IR/audit/gate hashes before any QA", async () => {
  for (const key of ["identitySha256", "generationPlanFileSha256", "providerManifestFileSha256", "textIrFileSha256",
    "spokenTextAuditFileSha256", "preSynthesisGateFileSha256"]) {
    await noWrites(() => finalizeNarrationProviderOutput(argv, { phaseContext: { ...phaseContext, [key]: "0".repeat(64) } }), /hash is stale/);
  }
});
test("generic invocation cannot finalize a pilot or infer an opening context", async () => {
  await noWrites(() => finalizeNarrationProviderOutput(argv), /guarded opening-phase/);
});
test("the finalizer cannot substitute a same-byte source at another path", async () => {
  const alternateScript = path.join(workRoot, "unapproved-source-copy.md");
  await fs.writeFile(alternateScript, sourceBytes);
  await noWrites(() => validateOpeningNarrationFinalizationInputs({ ...options, scriptPath: alternateScript }), /immutable pilot identity/);
});
test("source approval and upstream map changes cannot survive declared hashes", async () => {
  await noWrites(() => validateOpeningNarrationFinalizationInputs({ ...options, phaseContext: { ...phaseContext, sourceArtifacts: {} } }), /upstream/);
  await fs.writeFile(approvalPath, "changed fixture evidence");
  try { await noWrites(() => finalizeNarrationProviderOutput(argv, { phaseContext }), /upstream.*stale/); }
  finally { await fs.writeFile(approvalPath, approvalBytes); }
});
test("gate authorization must preserve exact opening scope and recorded model state", async () => {
  for (const update of [ { model_load_performed: false }, { synthesis_invoked: false },
    { scope: { ...authorizedGate.scope, authorized_synthesis_unit_ids: built.plan.units.map((unit) => unit.unit_id) } } ]) {
    const gate = { ...authorizedGate, ...update };
    gate.gate_sha256 = narrationPreSynthesisGateSha256(gate);
    await fs.writeFile(preSynthesisGatePath, jsonBytes(gate));
    try { await noWrites(() => validateOpeningNarrationFinalizationInputs({ ...options,
      phaseContext: { ...phaseContext, preSynthesisGateFileSha256: digest(jsonBytes(gate)) } }), /authorized opening/); }
    finally { await fs.writeFile(preSynthesisGatePath, jsonBytes(authorizedGate)); }
  }
});
test("namespace is a fresh child and never crosses existing evidence or symlinks", async () => {
  await assert.rejects(validateOpeningFinalizationNamespace(episodeDir, episodeDir), /strict episode child/);
  await assert.rejects(validateOpeningFinalizationNamespace(episodeDir, path.dirname(episodeDir)), /strict episode child/);
  await assert.rejects(validateOpeningFinalizationNamespace(episodeDir, workRoot), /must be new/);
  const alias = path.join(episodeDir, "symlink-output");
  await fs.symlink(workRoot, alias);
  await assert.rejects(validateOpeningFinalizationNamespace(episodeDir, path.join(alias, "opening")), /symlinks/);
});
test("opening subjective manifest covers the complete sample and remains review-required", () => {
  const units = built.plan.units.slice(0, 2);
  const stitch = { prepared_inputs: units.map((unit) => ({ unit_id: unit.unit_id, sample_count: 240000 })), boundaries: [] };
  const review = buildNarrationSubjectiveReviewManifest({ plan: { ...built.plan, units }, stitch,
    audioPath: path.join(phaseContext.outputNamespace, "audio", "synthetic-not-materialized.wav"), audioSha256: digest("not actual audio"),
    generationPlanSha256: built.plan.plan_sha256, generationPlanFileSha256: phaseContext.generationPlanFileSha256,
    qualityContractSha256: policy.narration_quality_contract.contract_sha256 });
  assert.equal(validateNarrationSubjectiveReviewManifest(review).status, "passed");
  assert.equal(review.status, "review_required");
  assert.equal(review.duration_sec, 20);
  const opening = review.samples.find((sample) => sample.coverage_class === "complete_opening");
  assert.equal(opening.start_sample, 0); assert.equal(opening.end_sample_exclusive, 480000);
  assert.deepEqual(opening.unit_ids, phaseContext.unitIds);
  assert.equal(review.narration_generation_plan_sha256, built.plan.plan_sha256);
});

try {
  for (const [name, body] of tests) { await body(); process.stdout.write(`PASS ${name}\n`); }
  process.stdout.write(`opening finalization tests passed (${tests.length}); zero media/model/provider work\n`);
} finally {
  await fs.rm(episodeDir, { recursive: true, force: true });
}
