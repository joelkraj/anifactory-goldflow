import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COHERENT_THOUGHT_SUBMISSION_POLICY as policy, COHERENT_THOUGHT_DIRECTION_SCHEMA,
  coherentThoughtSubmissionContract, coherentNarrationGroupFindings, validateCoherentNarrationPlan, narrationSubmissionSourceConstraint,
} from "../lib/narration-submission-contract.mjs";
import { qwenGenerationPlanForTests } from "../voice-direction-gate.mjs";
import { buildNarrationTextIr, validateNarrationTextIr } from "../lib/narration-text-ir.mjs";
import { validateActionableNarrationDirection, narrationSourceRefKey } from "../lib/narration-performance-contract.mjs";
import {
  authorNarrationPerformanceDirection, narrationPerformancePacketPlanForTests, resolveNarrationSubmissionPolicy, assertCoherentNarrationEditorialContract,
} from "../lib/narration-performance-author.mjs";

const sourceHash = "a".repeat(64);
const raw = [
  { text: "I watched the guard turn away from the door.", kind: "narration", speaker: "NARRATOR" },
  { text: '"Seren told me that the old key would fit."', kind: "dialogue", speaker: "JOEY" },
  { text: "I'd seen the lock before, and I knew she was right.", kind: "narration", speaker: "NARRATOR" },
  { text: "Death.", kind: "narration", speaker: "NARRATOR" },
  { text: "I would remember that name.", kind: "narration", speaker: "NARRATOR" },
];
const segments = raw.map((unit, index) => ({
  segment_id: `voice_seg_${String(index + 1).padStart(2, "0")}`,
  delivery_mode: index === 1 ? "character_dialogue" : "exposition narration",
  performance_units: [{ ...unit, caption_text: unit.text }],
}));
const ttsOverrides = { replacements: [{ from: "Seren", to: "Seh ren", scope: "tts_spoken_text", reason: "Exact name pronunciation fixture." }] };
const draft = qwenGenerationPlanForTests(segments, { sourceScriptSha256: sourceHash, ttsOverrides, submissionPolicy: policy });
const atoms = draft._performance_authoring_atomic_units;
const refs = (rows) => rows.map((unit) => narrationSourceRefKey(unit.source_unit_refs[0]));
const intent = { energy: "controlled", tension: "neutral", intimacy: "standard", pace: "steady_forward", pause_strategy: "punctuation_led", emphasis: [], style_tags: [] };
const chapters = segments.map((row) => ({ segment_id: row.segment_id,
  dramatic_function: "Continue the exact source thought.", audience_effect: "Follow the narrator.", energy_start: 2, energy_end: 2,
  tension_peak: 2, intimacy: 2, pace: "steady_forward", reveal_weight: 1,
  transition_from_previous: "Retain narrative continuity.", avoidance: "Avoid a needless cadence restart.",
}));
const authoredGroups = [
  { source_ref_keys: refs(atoms.slice(0, 3)), spoken_text: atoms.slice(0, 3).map((row) => row.spoken_text).join(" "),
    grouping_rationale: "The guard, quoted advice and recognition of the lock form one connected escape thought.",
    dialogue_separation: "connected_narrator_delivery", boundary_after: "sentence",
    boundary_intent: { reason: "sentence_complete", rationale: "The complete escape observation ends before the isolated disclosure." }, performance_intent: intent },
  { source_ref_keys: refs(atoms.slice(3, 4)), spoken_text: "Death.", grouping_rationale: "The single word names the unexpected result.",
    short_unit_reason: { reason: "revelation", rationale: "The disclosed name carries the turn and requires an isolated performance." },
    boundary_after: "reveal", boundary_intent: { reason: "revelation", rationale: "The named result is the actual revelation in this passage." }, performance_intent: intent },
  { source_ref_keys: refs(atoms.slice(4)), spoken_text: atoms[4].spoken_text,
    grouping_rationale: "The closing vow completes the passage.", short_unit_reason: { reason: "episode_boundary", rationale: "This short closing vow ends the fixture episode." },
    boundary_after: "episode_end", boundary_intent: { reason: "episode_end", rationale: "The source episode ends after the vow." }, performance_intent: intent },
];
const artifact = { schema: COHERENT_THOUGHT_DIRECTION_SCHEMA, submission_policy: policy, submission_contract: coherentThoughtSubmissionContract(), status: "approved", source_script_sha256: sourceHash,
  authoring: { kind: "llm_authored", provider: "fixture", model: "fixture-no-network" },
  chapter_prosody_spine: { schema: "goldflow_narration_chapter_prosody_spine_v1", chapters }, units: authoredGroups };
const validate = (value, atomicUnits = atoms) => validateActionableNarrationDirection({ artifact: value, atomicUnits, sourceScriptSha256: sourceHash });
assert.equal(validate(artifact).status, "passed");
assert.ok(atoms[1].risk_flags.includes("tts_override_applied"));
assert.ok(atoms[1].risk_flags.includes("speaker_or_performance_turn"));
const plan = qwenGenerationPlanForTests(segments, { ttsOverrides, actionableDirectionArtifact: artifact, sourceScriptSha256: sourceHash, submissionPolicy: policy });
assert.equal(plan.status, "passed", JSON.stringify(plan.sentence_unit_boundary_integrity));
assert.equal(plan.units.length, 3);
assert.equal(plan.units[0].source_segment_ids.length, 3);
assert.equal(plan.units[0].spoken_text_lineage.components.length, 3);
assert.equal(plan.sentence_unit_boundary_integrity.within_voice_segment_boundary_count, 2);
assert.equal(plan.sentence_unit_boundary_integrity.within_submission_boundary_count, 3);
assert.equal(validateCoherentNarrationPlan(plan).status, "passed");
const ir = buildNarrationTextIr({ sourceScriptSha256: sourceHash, units: plan.units });
assert.equal(validateNarrationTextIr(ir, plan.units).status, "passed");
for (const unit of plan.units) {
  assert.equal(unit.provider_request.request.text, unit.spoken_text);
  assert.equal(unit.provider_request.request.instruction, undefined);
  assert.equal(unit.provider_request.request.native_speed, undefined);
}
assert.match(plan.units[0].spoken_text, /I'd seen/);
assert.match(plan.units[0].spoken_text, /Seh ren/);
assert.match(plan.units[0].source_text, /Seren/);
assert.equal(plan.units[1].spoken_text, "Death.");
assert.deepEqual(plan.units.flatMap((unit) => unit.source_unit_refs.map((ref) => ref.source_unit_id)), atoms.flatMap((unit) => unit.source_unit_refs.map((ref) => ref.source_unit_id)));

for (const change of [
  (x) => x.units[0].source_ref_keys.pop(),
  (x) => x.units[0].source_ref_keys.push(x.units[0].source_ref_keys[0]),
  (x) => x.units[0].source_ref_keys.reverse(),
  (x) => { x.units[0].spoken_text = x.units[0].spoken_text.replace("I'd", "I would"); },
  (x) => { x.units[0].spoken_text += " [calm]"; },
  (x) => { delete x.units[1].short_unit_reason; },
  (x) => { x.units[1].boundary_intent.reason = "request_limit"; },
  (x) => { x.submission_contract.hard_words_max = 99; },
]) {
  const invalid = structuredClone(artifact); change(invalid);
  assert.equal(validate(invalid).status, "blocked");
}
for (const change of [
  (x) => { x[1].submission_source_constraint.atomic = true; },
  (x) => { x[1].submission_source_constraint.before = "chapter"; },
  (x) => { x[1].submission_source_constraint.chapter_id = "two"; },
  (x) => { x[1].submission_source_constraint.delivery_id = "whisper"; },
  (x) => { x[1].speaker = "OTHER_ACTUAL_VOICE"; },
]) {
  const invalid = structuredClone(atoms); change(invalid);
  assert.equal(validate(artifact, invalid).status, "blocked");
}
const planTamper = structuredClone(plan); planTamper.units[0].source_unit_refs[1].submission_source_constraint.atomic = true;
assert.equal(validateCoherentNarrationPlan(planTamper).status, "blocked");
assert.equal(narrationSubmissionSourceConstraint({ kind: "mc_internal", metadata_tags: ["MC_INTERNAL"] }).delivery_id, "source_mc_internal");
assert.equal(narrationSubmissionSourceConstraint({ kind: "dialogue", speaker: "JOEY" }).delivery_id, null);
const internalAtoms = structuredClone(atoms);
internalAtoms[1].submission_source_constraint = narrationSubmissionSourceConstraint({ kind: "mc_internal" });
assert.equal(validate(artifact, internalAtoms).status, "blocked");
const standalone = { ...authoredGroups[1], spoken_text: "New rank unlocked." };
assert.equal(coherentNarrationGroupFindings(standalone, [{ submission_source_constraint: { atomic: true } }]).length, 0);

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-coherent-submission-"));
try {
  assert.equal(await resolveNarrationSubmissionPolicy({ episodeDir: scratch }), policy);
  const result = await authorNarrationPerformanceDirection({ atomicUnits: atoms, sourceScriptSha256: sourceHash, episodeDir: scratch, repoRoot: scratch, submissionPolicy: policy,
    plannerExecutor: async ({ prompt }) => {
      const marker = JSON.parse(await fs.readFile(path.join(scratch, "narration_editorial_contract.json"), "utf8"));
      assert.equal(marker.mode, policy);
      assert.match(prompt, /NOT a chapter, visual cut or mandatory speech boundary/);
      assert.match(prompt, /ambiguous_contraction/);
      return { provider: "fixture", model: "fixture-no-network", content: JSON.stringify({ chapters, units: authoredGroups }) };
    },
  });
  assert.equal(result.artifact.submission_policy, policy);
  assert.equal(result.artifact.schema, COHERENT_THOUGHT_DIRECTION_SCHEMA);
  await assertCoherentNarrationEditorialContract({ episodeDir: scratch, artifact: result.artifact, atomicUnits: atoms, sourceScriptSha256: sourceHash, contentProfile: null });
  await assert.rejects(() => assertCoherentNarrationEditorialContract({ episodeDir: scratch, artifact: result.artifact, atomicUnits: atoms, sourceScriptSha256: "b".repeat(64), contentProfile: null }), /editorial contract/);
  assert.equal(await resolveNarrationSubmissionPolicy({ episodeDir: scratch }), policy);
  const oldDir = path.join(scratch, "historical"); await fs.mkdir(oldDir);
  await fs.writeFile(path.join(oldDir, "narration_generation_plan.json"), "{}");
  assert.equal(await resolveNarrationSubmissionPolicy({ episodeDir: oldDir }), null);
  const historicalPackets = narrationPerformancePacketPlanForTests(atoms);
  const newPackets = narrationPerformancePacketPlanForTests(atoms, { submissionPolicy: policy });
  assert.notEqual(newPackets[0].packet_id, historicalPackets[0].packet_id);
  assert.match(historicalPackets[0].prompt, /Keep each output unit inside one segment_id/);
  assert.equal(createHash("sha256").update(newPackets[0].prompt).digest("hex"), newPackets[0].prompt_sha256);
  await fs.unlink(path.join(scratch, "narration_editorial_contract.json"));
  await assert.rejects(() => resolveNarrationSubmissionPolicy({ episodeDir: scratch }), /original editorial contract marker/);
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
console.log("Coherent narration submission tests passed: cross-segment dialogue/override grouping, exact IR/payload, barriers, short reveals, immutable legacy selection.");
