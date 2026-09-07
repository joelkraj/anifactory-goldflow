import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildPilotNarrationPlans, validatePilotNarrationPlanPolicy } from "../lib/avatar-pilot-narration-plan.mjs";
import { buildPilotNarrationIdentityFields } from "../lib/avatar-pilot-narration-contract.mjs";
import { QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK as JOEL } from "../lib/narration-tts-policy.mjs";
import { buildNarrationPreSynthesisGate, canonicalNarrationPlanSha256 } from "../lib/narration-pre-synthesis-gate.mjs";
import { buildNarrationTextIr } from "../lib/narration-text-ir.mjs";
import { buildTtsSpokenTextAudit } from "../lib/tts-spoken-text-audit.mjs";
import { validateQwenLiamBatchPlan, qwenBatchBindingByUnit } from "../lib/qwen-liam-batch-contract.mjs";
import { classifyNarrationBoundary, planNarrationBoundary } from "../lib/narration-boundary-editor.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const bytesOf = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const bankPath = fileURLToPath(new URL("../../config/narration_delivery_reference_bank.json", import.meta.url));
const deliveryBank = { path: bankPath, bytes: await readFile(bankPath) };
const narrationLock = { provider: JOEL.provider, model: JOEL.model_id, model_revision: JOEL.model_revision,
  voice_id: JOEL.voice_id, voice_sha256: JOEL.voice_sha256, reference_audio_sha256: JOEL.reference_audio_sha256,
  reference_text_sha256: JOEL.reference_text_sha256 };
// Deliberately synthetic prose. No sound is generated and no listening/QA is
// represented by this fixture; it establishes only exact source/plan contracts.
const paragraphs = [
  "A traveler reaches for the device. The guard moves him outside before he can touch it.",
  "That’s where our imagined encounter begins. We’re changing one decision, while keeping the evidence separate from the theory. The outcome is still uncertain.",
  "The earlier demonstration gives us the starting point. The guard moves a heavy object through a window and brings it back. Here, he would keep the device away from the attacker.",
  "Instead of approaching again, the attacker blocks the exit. The guard must choose whether to protect the object or help the people trapped inside the damaged room.",
  "The guard waits in the doorway. This gives the others a chance to escape.",
  "The evidence does not tell us how another opponent would respond. In our version, the attacker takes the longer route, avoiding a contest he cannot confidently win.",
  "The guard stays in place instead of advancing. Following the attacker would reopen the route his friends are using.",
  "Those few seconds are enough. The group carries the device clear before the attacker can reach them.",
  "That is why this decision matters. The diversion moves the guard, but it does not divide the team. He protects his friends and changes the result.",
  "The display reads 12 percent. That is evidence, not proof of unlimited control.",
];
const sourceText = `${paragraphs.join("\n\n")}\n`;
const sourceBytes = Buffer.from(sourceText);
const sourceScriptSha256 = digest(sourceBytes);
const identity = {
  schema: "goldflow_avatar_pilot_identity_v1", media_workflow: "avatar_footage_pilot_v1",
  content_profile: "mcu_what_if_pilot_v1", run_intent: "proof", production_eligible: false, publish_allowed: false,
  source_script: { path: "/fixture/approved.md", sha256: sourceScriptSha256 },
  pilot_providers: { narration: narrationLock },
  ...buildPilotNarrationIdentityFields({ narrationLock, deliveryBank }),
};
const identityBytes = bytesOf(identity);
const identityFileSha256 = digest(identityBytes);
let position = 0;
const spans = paragraphs.map((paragraph) => {
  const start = sourceText.indexOf(paragraph, position); position = start + paragraph.length;
  return [start, position];
});
const groups = [[0], [1], [2], [3], [4], [5], [6, 7], [8, 9]];
const editorialUnits = groups.map((group, index) => ({
  source_start_utf16: spans[group[0]][0], source_end_utf16: spans[group.at(-1)][1],
  boundary_class: index === groups.length - 1 ? "episode_end" : "paragraph",
  performance_intent: { energy: "controlled", emphasis: index === 0 ? ["before"] : [], pause_strategy: "punctuation_led" },
}));
const sourceArtifactHashes = { pilot_script_approval_sha256: digest("fixture script approval binding"), pilot_evidence_approval_sha256: digest("fixture evidence approval binding") };
const inputs = { sourceBytes, sourceScriptSha256, identity, identityBytes, identityFileSha256,
  deliveryBank, editorialUnits, openingUnitCount: 2, sourceArtifactHashes };
const built = buildPilotNarrationPlans(inputs);
assert.equal(built.planPolicy.status, "passed");
assert.equal(built.synthesis_authorized, false);
assert.equal(built.measured_duration_sec, null);
assert.equal(built.plan.units.length, 8);
assert.equal(built.phases.opening.units.length, 2);
assert.equal(built.phases.remaining.units.length, 6);
assert.equal(built.phases.opening.batch_plan.cohorts[0].effective_batch_size, 2);
assert.deepEqual(built.phases.remaining.batch_plan.cohorts.map((row) => row.effective_batch_size), [4, 2]);
assert.deepEqual(built.phases.remaining.units.map((row) => row.order_index), [2, 3, 4, 5, 6, 7]);
assert.deepEqual(buildPilotNarrationPlans(inputs), built, "same exact inputs freeze identical source/request/cohort hashes");
for (const phase of Object.values(built.phases)) {
  assert.equal(validateQwenLiamBatchPlan(phase.batch_plan, phase.units, built.policy.synthesis_contract).status, "passed");
  const bindings = qwenBatchBindingByUnit(phase.batch_plan);
  for (const unit of phase.units) {
    assert.deepEqual(unit, built.plan.units[unit.order_index]);
    assert.deepEqual(unit.synthesis_cohort, bindings.get(unit.unit_id));
    assert.equal(unit.provider_request.request.seed, unit.synthesis_cohort.batch_seed);
    assert.equal(unit.provider_request.request.text, unit.spoken_text);
    assert.equal(unit.provider_request.request.instruction, undefined);
    assert.ok(unit.provider_request.capability_losses.some((row) => row.control === "performance_intent"));
    assert.equal(unit.caption_text, sourceText.slice(unit.editorial_unit.source_start_utf16, unit.editorial_unit.source_end_utf16));
  }
}
assert.match(built.plan.units.at(-1).spoken_text, /twelve percent/u);
assert.match(built.plan.units.at(-1).caption_text, /12 percent/u);
assert.equal(built.plan.units[0].spoken_text, built.plan.units[0].source_text, "unchanged source punctuation remains unchanged");
assert.ok(built.plan.units[6].source_text.includes("\n\n"), "grouped source/caption bytes retain the actual paragraph separator");
assert.ok(!built.plan.units[6].spoken_text.includes("\n"), "canonical whitespace compilation has an exact receipt");
for (const [index, unit] of built.plan.units.entries()) {
  assert.equal(unit.boundary_after, unit.editorial_unit.boundary_class);
  assert.equal(classifyNarrationBoundary(unit, built.plan.units[index + 1] ?? null), unit.editorial_unit.boundary_class);
}
for (const boundaryClass of ["paragraph", "reveal"]) {
  const boundaryEditorial = structuredClone(editorialUnits);
  boundaryEditorial[1].boundary_class = boundaryClass;
  const directedBoundary = buildPilotNarrationPlans({ ...inputs, editorialUnits: boundaryEditorial });
  const left = directedBoundary.phases.opening.units.at(-1);
  const right = directedBoundary.phases.remaining.units[0];
  assert.equal(classifyNarrationBoundary(left, right), boundaryClass, "authored boundary survives the opening-to-remaining phase handoff");
  const join = planNarrationBoundary({ leftUnit: left, rightUnit: right,
    leftPrepared: { retained_trailing_silence_sample_count: 0 },
    rightPrepared: { retained_leading_silence_sample_count: 0 }, contract: built.policy.narration_quality_contract });
  assert.equal(join.status, "passed");
  assert.equal(join.target_pause_ms, built.policy.narration_quality_contract.boundary_classes[boundaryClass].target_ms);
  assert.equal(left.spoken_text, built.plan.units[1].spoken_text, "stitch direction does not rewrite spoken words or punctuation");
  assert.equal(classifyNarrationBoundary(left, null), "episode_end", "standalone sample has no imaginary remaining join");
}

const gateInputs = {
  plan: built.plan, planPath: "/fixture/narration_generation_plan.json", planFileSha256: digest(bytesOf(built.plan)),
  identityPath: "/fixture/run_identity.json", identityFileSha256,
  scriptPath: "/fixture/approved.md", scriptSha256: sourceScriptSha256,
  policy: built.policy, planPolicy: built.planPolicy, sourceArtifactHashes,
  textIr: built.textIr, textIrPath: "/fixture/narration_text_ir.json", textIrFileSha256: digest(bytesOf(built.textIr)),
  spokenTextAudit: built.spokenTextAudit, spokenTextAuditPath: "/fixture/spoken_audit.json", spokenTextAuditFileSha256: digest(bytesOf(built.spokenTextAudit)),
  synthesisScope: { mode: "pilot_opening_only", authorized_synthesis_unit_ids: built.phases.opening.unit_ids,
    preserved_unit_ids: [], preserved_artifacts: [], evidence_path: "/fixture/pilot_narration_editorial_input.json",
    evidence_sha256: digest(bytesOf(editorialUnits)) },
};
const gate = buildNarrationPreSynthesisGate(gateInputs);
assert.equal(gate.status, "passed", JSON.stringify(gate.findings));
assert.equal(gate.model_load_performed, false);
assert.equal(gate.synthesis_invoked, false);
assert.equal(gate.bindings.script_sha256, sourceScriptSha256);
assert.equal(gate.unit_count, 8, "opening authorization is validated against the complete approved source plan");
assert.deepEqual(gate.scope.authorized_synthesis_unit_ids, built.phases.opening.unit_ids);

assert.throws(() => buildPilotNarrationPlans({ ...inputs, sourceBytes: Buffer.concat([sourceBytes, Buffer.from("Changed.")]) }), /source_hash_mismatch/u);
assert.throws(() => buildPilotNarrationPlans({ ...inputs, identityBytes: Buffer.from("{}") }), /identity_file_hash_mismatch/u);
assert.throws(() => buildPilotNarrationPlans({ ...inputs, identity: { ...identity, tts_native_speed: 1.1 } }), /identity_bytes_object_mismatch/u);
assert.throws(() => buildPilotNarrationPlans({ ...inputs, openingUnitCount: 8 }), /proper_prefix/u);
assert.throws(() => buildPilotNarrationPlans({ ...inputs, openingUnitCount: 0 }), /proper_prefix/u);
assert.throws(() => buildPilotNarrationPlans({ ...inputs, openingUnitCount: 4 }), /exceeds_three_complete_units/u);
assert.throws(() => buildPilotNarrationPlans({ ...inputs, openingUnitCount: 7 }), /exceeds_three_complete_units/u);

function openingScopeInputs(wordCounts) {
  const sections = wordCounts.map((count) => `${Array.from({ length: count }, () => "word").join(" ")}.`);
  const text = `${sections.join("\n\n")}\n`;
  const source = Buffer.from(text);
  const scriptHash = digest(source);
  const fixtureIdentity = { ...identity, source_script: { ...identity.source_script, sha256: scriptHash } };
  const fixtureIdentityBytes = bytesOf(fixtureIdentity);
  let offset = 0;
  const fixtureUnits = sections.map((section, index) => {
    const start = offset; offset += section.length + 2;
    return { source_start_utf16: start, source_end_utf16: start + section.length,
      boundary_class: index === sections.length - 1 ? "episode_end" : "paragraph" };
  });
  return { ...inputs, sourceBytes: source, sourceScriptSha256: scriptHash,
    identity: fixtureIdentity, identityBytes: fixtureIdentityBytes, identityFileSha256: digest(fixtureIdentityBytes),
    editorialUnits: fixtureUnits };
}
const sixtyWords = openingScopeInputs([20, 20, 20, 5]);
const boundedOpening = buildPilotNarrationPlans({ ...sixtyWords, openingUnitCount: 3 });
assert.equal(boundedOpening.phases.opening.word_count, 60, "three complete units and exactly sixty spoken words remain in scope");
assert.equal(boundedOpening.measured_duration_sec, null, "scope limits do not fabricate measured audio duration");
const fourShortUnits = openingScopeInputs([15, 15, 15, 15, 5]);
assert.throws(() => buildPilotNarrationPlans({ ...fourShortUnits, openingUnitCount: 4 }), /exceeds_three_complete_units/u);
const sixtyOneWords = openingScopeInputs([30, 31, 5]);
assert.throws(() => buildPilotNarrationPlans({ ...sixtyOneWords, openingUnitCount: 2 }), /exceeds_sixty_spoken_words/u);
// Revalidation must enforce scope independently; refreshed self-declared hashes
// cannot turn a previously bounded plan into a larger opening authorization.
for (const [fixture, validCount, expandedCount, code] of [
  [fourShortUnits, 3, 4, "pilot_plan_opening_exceeds_three_complete_units"],
  [sixtyOneWords, 1, 2, "pilot_plan_opening_exceeds_sixty_spoken_words"],
]) {
  const initial = buildPilotNarrationPlans({ ...fixture, openingUnitCount: validCount });
  const expanded = structuredClone(initial.plan);
  expanded.pilot_opening_unit_ids = expanded.units.slice(0, expandedCount).map((unit) => unit.unit_id);
  expanded.plan_sha256 = canonicalNarrationPlanSha256(expanded);
  const checked = validatePilotNarrationPlanPolicy(expanded, initial.policy, {
    sourceBytes: fixture.sourceBytes, identityFileSha256: fixture.identityFileSha256,
    textIr: initial.textIr, spokenTextAudit: initial.spokenTextAudit,
  });
  assert.equal(checked.status, "blocked");
  assert.ok(checked.findings.some((finding) => finding.code === code), JSON.stringify(checked.findings));
}
assert.throws(() => buildPilotNarrationPlans({ ...inputs, sourceArtifactHashes: { script_clean_sha256: digest("wrong") } }), /script_conflict/u);
const omitted = structuredClone(editorialUnits); omitted.splice(2, 1);
assert.throws(() => buildPilotNarrationPlans({ ...inputs, editorialUnits: omitted }), /source_gap/u);
const truncated = structuredClone(editorialUnits); truncated.at(-1).source_end_utf16 = spans[8][1];
assert.throws(() => buildPilotNarrationPlans({ ...inputs, editorialUnits: truncated }), /tail_missing/u);
const partialWord = structuredClone(editorialUnits); partialWord[0].source_start_utf16 = 2;
assert.throws(() => buildPilotNarrationPlans({ ...inputs, editorialUnits: partialWord }), /source_gap/u);
const directed = structuredClone(editorialUnits);
directed[0].direction = { spoken_text: built.plan.units[0].spoken_text.replace("device.", "device!"), author: "Fixture editorial author", reason: "Explicit punctuation-only emphasis test" };
const punctuation = buildPilotNarrationPlans({ ...inputs, editorialUnits: directed });
assert.equal(punctuation.planPolicy.status, "passed");
assert.equal(punctuation.plan.units[0].caption_text, built.plan.units[0].caption_text);
assert.notEqual(punctuation.plan.units[0].provider_request.request_sha256, built.plan.units[0].provider_request.request_sha256);
directed[0].direction.spoken_text += " The guard secretly wins.";
assert.throws(() => buildPilotNarrationPlans({ ...inputs, editorialUnits: directed }), /must_not_rewrite_words/u);

// Even after an attacker refreshes self-declared plan/IR/audit hashes, arbitrary
// spoken words or new batch assignments cannot replace source-derived units.
for (const mutate of [
  (plan) => { plan.units[0].spoken_text = "Different words entirely."; },
  (plan) => { plan.units[0].provider_request.request.text = "Unapproved speech."; },
  (plan) => { plan.units[0].synthesis_cohort.batch_seed += 1; },
  (plan) => { plan.units[0].execution_phase = "remaining"; },
  (plan) => { plan.pilot_opening_unit_ids.reverse(); },
  (plan) => { plan.pilot_phase_batch_plans.opening.cohorts[0].members.reverse(); },
  (plan) => { plan.units[0].source_unit_refs[0].source_text = "Different approved words."; },
  (plan) => { plan.units[0].boundary_after = "sentence"; },
  (plan) => { delete plan.units[0].boundary_after; },
]) {
  const plan = structuredClone(built.plan); mutate(plan);
  plan.plan_sha256 = canonicalNarrationPlanSha256(plan);
  const textIr = buildNarrationTextIr({ sourceScriptSha256, generationPlanSha256: plan.plan_sha256, units: plan.units });
  const spokenTextAudit = buildTtsSpokenTextAudit({ plan, sourceScriptSha256, generatedAt: null });
  assert.equal(validatePilotNarrationPlanPolicy(plan, built.policy, { sourceBytes, identityFileSha256, textIr, spokenTextAudit }).status, "blocked");
}
assert.equal(buildNarrationPreSynthesisGate({ ...gateInputs, plan: { ...built.plan, source_script_hash: digest("other") } }).status, "blocked");
console.log("avatar pilot narration plan tests passed (canonical source/IR/request/phase gate; no media/provider/model work)");
