import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildEditorialDirectorPrompt,
  normalizeEditorialGrouping,
  projectActiveStateConstraints,
  retimeLockedEditorialBeats,
} from "../lib/editorial-beat-director.mjs";
import { visualBeatInternalsForTests } from "../visual-beat-plan.mjs";
import { relevantReferenceTargetsForTests } from "../visual-plan.mjs";
import {
  referenceEvidenceLedgerForTests,
  referenceLocationContractLedgerForTests,
} from "../visual-reference-plan.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const literalLocation = "Rear compartment —  moving tram";
const scene = { scene_id: "scene_transit", location: literalLocation, title: "Ticket check" };
const atoms = ["The traveler checks the ticket.", "The traveler lowers the ticket."].map((text, index) => ({
  atom_id: `atom_${index}`,
  source_word_start_index: index * 5,
  source_word_end_index: index * 5 + 4,
  start_sec: 1300 + index * 2.5,
  end_sec: 1302.5 + index * 2.5,
  text,
  scene_id: scene.scene_id,
  semantic_location: literalLocation,
  semantic_scene: structuredClone(scene),
  transition_barrier_before: false,
}));
const ledger = {
  canonical_entities: [{ entity_id: "traveler", display_name: "Traveler" }],
  canonical_locations: [{ location_id: "station", display_name: "Station" }],
};
const raw = { beats: [{
  source_atom_ids: atoms.map((atom) => atom.atom_id),
  visual_job: "story_progression",
  shot_job: "object_insert",
  depiction_mode: "current_reality",
  location_id: null,
  physically_visible_entity_ids: ["traveler"],
  screen_visible_entity_ids: [],
  preview_visible_entity_ids: [],
  mentioned_only_entity_ids: [],
  primary_entity_id: "traveler",
  entity_evidence: { traveler: "The traveler" },
  props: [{ prop_id: null, label: "ticket" }],
  ui_elements: [],
  background_population: { presence: "none" },
  foreground_action: "The traveler lowers the ticket after checking it.",
  foreground_action_evidence: atoms.map((atom) => atom.text).join(" "),
  composition_intent: "Close view of the traveler and ticket against the rear compartment bench.",
  continuity_note: "Keep the bench behind the traveler.",
  visual_information_delta: {
    kind: "new_action_or_contact",
    statement: "The traveler has finished checking the ticket.",
    compared_to_previous: "The ticket moves down after the check.",
  },
  sequence_grammar: {
    shot_size: "close", camera_angle: "level", vantage: "across the bench", sequence_role: "advance",
  },
  spatial_continuity: {
    eyeline_axis: "traveler looks at the ticket", primary_screen_position: "center",
    primary_facing: "screen_right", threat_or_counterparty_position: "not_applicable",
    travel_direction: "stationary", object_geography: "ticket below the traveler’s face",
    intentional_axis_break: false, axis_break_reason: null,
  },
  beat_value: { tier: "connective", moment_types: [], reason: "A small completed action." },
  retention_reset: { kind: "none", evidence_ids: [], purpose: "Continue the ticket check." },
  audiovisual_intent: {
    motion_role: "supports_clarity", sfx_event: null, score_behavior: "hold",
    silence_behavior: "not_required", subtitle_emphasis: [], coordination_note: "Keep the ticket readable.",
  },
  editorial_cues: [],
}] };

const before = structuredClone({ raw, atoms, ledger });
const normalize = (packet = raw, sourceAtoms = atoms, factLedger = ledger) => normalizeEditorialGrouping(packet, sourceAtoms, factLedger, "ep_test");
const result = normalize();
const beat = result.beats[0];
assert.equal(beat.location_id, null);
assert.equal(beat.location, literalLocation);
assert.equal(beat.local_location, literalLocation, "literal spacing and Unicode are not rewritten");
assert.equal(beat.parent_scene_id, scene.scene_id);
assert.deepEqual(beat.source_atom_ids, raw.beats[0].source_atom_ids);
assert.equal(beat.location_provenance.schema, "goldflow_editorial_source_scene_location_v1");
assert.equal(beat.location_provenance.source, "semantic_scene.location");
assert.equal(beat.location_provenance.scene_id, scene.scene_id);
assert.equal(beat.location_provenance.location, literalLocation);
assert.deepEqual(beat.location_provenance.source_atom_ids, raw.beats[0].source_atom_ids);
assert.equal(beat.location_provenance.scene_location_sha256,
  hash(JSON.stringify({ scene_id: scene.scene_id, location: literalLocation })));
const expectedEvidence = atoms.map((atom) => ({
  atom_id: atom.atom_id, source_word_start_index: atom.source_word_start_index,
  source_word_end_index: atom.source_word_end_index, text: atom.text, scene_id: atom.scene_id,
  semantic_location: atom.semantic_location,
  semantic_scene: { scene_id: atom.semantic_scene.scene_id, location: atom.semantic_scene.location },
}));
assert.equal(beat.location_provenance.source_atom_evidence_sha256, hash(JSON.stringify(expectedEvidence)));
assert.deepEqual({ raw, atoms, ledger }, before, "normalization never changes its source inputs");
const [projected] = projectActiveStateConstraints(result.beats, atoms, ledger, [scene]);
assert.equal(projected.active_state_constraints.location_id, null);
assert.equal(projected.local_location, literalLocation);
assert.deepEqual(projected.location_provenance, beat.location_provenance);
const retimedAtoms = structuredClone(atoms).map((atom, index) => ({
  ...atom, atom_id: `retimed_atom_${index}`,
  source_word_start_index: atom.source_word_start_index + 10,
  source_word_end_index: atom.source_word_end_index + 10,
  start_sec: atom.start_sec + 1, end_sec: atom.end_sec + 1,
}));
const [retimed] = retimeLockedEditorialBeats([beat], retimedAtoms);
assert.equal(retimed.location_id, null);
assert.equal(retimed.local_location, literalLocation);
assert.deepEqual(retimed.location_provenance.source_atom_ids, retimedAtoms.map((atom) => atom.atom_id));
assert.notEqual(retimed.location_provenance.source_atom_evidence_sha256, beat.location_provenance.source_atom_evidence_sha256);
for (const mutate of [
  (b) => { b.location_provenance.source_atom_ids = ["stale_atom"]; },
  (b) => { b.local_location = "Another setting"; },
  (b) => { b.location_id = "station"; },
  (b) => { delete b.location_provenance; },
]) {
  const stale = structuredClone(beat); mutate(stale);
  assert.throws(() => retimeLockedEditorialBeats([stale], retimedAtoms), /source scene location changed or lost/);
}
const movedAtoms = structuredClone(retimedAtoms);
for (const atom of movedAtoms) {
  atom.semantic_location = "Another setting"; atom.semantic_scene.location = "Another setting";
}
assert.throws(() => retimeLockedEditorialBeats([beat], movedAtoms), /source scene location changed or lost/);

for (const value of [undefined, "", " ", "null", "unknown_room", {}, false, 0]) {
  const packet = structuredClone(raw);
  if (value === undefined) delete packet.beats[0].location_id;
  else packet.beats[0].location_id = value;
  assert.throws(() => normalize(packet), /editorial_unknown_location/, `reject ${JSON.stringify(value)}`);
}
for (const mutate of [
  (a) => { delete a[0].semantic_scene; },
  (a) => { delete a[1].semantic_location; },
  (a) => { a[1].semantic_location = "Different compartment"; },
  (a) => { a[1].semantic_scene.location = "Different compartment"; },
  (a) => { a[1].semantic_scene.scene_id = "another_scene"; },
  (a) => { a[1].scene_id = "another_scene"; a[1].semantic_scene.scene_id = "another_scene"; },
  (a) => { for (const atom of a) { atom.scene_id = ""; atom.semantic_scene.scene_id = ""; } },
  (a) => { for (const atom of a) { atom.semantic_location = " "; atom.semantic_scene.location = " "; } },
  (a) => { for (const atom of a) { atom.semantic_location = null; atom.semantic_scene.location = null; } },
  (a) => { a[1].semantic_location = literalLocation.replace("  ", " "); },
  (a) => { a[1].semantic_scene.location = { label: literalLocation }; },
]) {
  const changed = structuredClone(atoms); mutate(changed);
  assert.throws(() => normalize(raw, changed), /editorial_unknown_location/);
}
const crossing = structuredClone(atoms); crossing[1].transition_barrier_before = true;
assert.throws(() => normalize(raw, crossing), /editorial_crossed_transition_barrier/);
const badCoverage = structuredClone(raw); badCoverage.beats[0].source_atom_ids.pop();
assert.throws(() => normalize(badCoverage), /editorial_atom_coverage_mismatch/);
for (const canonicalLocation of [
  { location_id: "rear_compartment_moving_tram", display_name: "Transit compartment" },
  { location_id: "transit", display_name: literalLocation },
  { location_id: "transit", display_name: "Transit compartment", aliases: [literalLocation] },
]) {
  const known = { ...ledger, canonical_locations: [canonicalLocation] };
  assert.throws(() => normalize(raw, atoms, known), /editorial_unknown_location/,
    "a known canonical ID, label or alias requires its canonical ID instead of null");
}
const ambiguous = { ...ledger, canonical_locations: [
  { location_id: "one", aliases: [literalLocation] }, { location_id: "two", aliases: [literalLocation] },
] };
assert.throws(() => normalize(raw, atoms, ambiguous), /editorial_unknown_location/);

const untrustedLabels = structuredClone(raw);
Object.assign(untrustedLabels.beats[0], {
  location: "Invented venue", local_location: "Invented venue",
  location_provenance: { scene_id: "invented", location: "Invented venue" },
});
assert.deepEqual(normalize(untrustedLabels).beats, result.beats, "raw labels/provenance cannot replace source evidence");
const canonical = structuredClone(raw); canonical.beats[0].location_id = "station";
const canonicalBeat = normalize(canonical).beats[0];
assert.equal(canonicalBeat.location_id, "station");
assert.equal(canonicalBeat.location, "Station");
assert.equal(canonicalBeat.local_location, "Station");
assert.equal(canonicalBeat.location_provenance, undefined, "existing canonical behavior is unchanged");
const changedText = structuredClone(atoms); changedText[0].text += " Carefully.";
assert.notEqual(normalize(raw, changedText).beats[0].location_provenance.source_atom_evidence_sha256,
  beat.location_provenance.source_atom_evidence_sha256, "provenance binds the source atom text");

const broadScene = { ...scene, ref_requirements: [{
  ref_id: "station_ref", kind: "location", description: "Rear compartment moving tram display at the station",
}] };
const refNeeds = visualBeatInternalsForTests.localBeatReferenceNeeds(broadScene, beat);
const localNeed = refNeeds.find((need) => need.kind === "location");
assert.ok(localNeed);
assert.notEqual(localNeed.ref_id, "station_ref", "do not inherit an unrelated broad scene reference");
assert.equal(localNeed.subject, literalLocation);
assert.equal(localNeed.required_before_imagegen, false, "source location evidence does not require a new image anchor");
const scopedBeat = { ...beat, ref_needs: refNeeds, beat_ref_requirements: refNeeds };
const scoped = { scenes: [{ ...broadScene, visual_beats: [scopedBeat] }] };
const overlappingLedger = structuredClone(ledger);
overlappingLedger.canonical_locations[0].evidence = [{ exact_excerpt: literalLocation }];
const inventory = referenceEvidenceLedgerForTests(scoped, overlappingLedger);
const locationAssets = inventory.assets.filter((asset) => asset.kind === "location" && asset.beat_ids.includes(beat.visual_beat_id));
assert.ok(locationAssets.length);
assert.ok(locationAssets.every((asset) => asset.subject === literalLocation && asset.canonical_subject_id === null),
  "source-derived locations cannot be remapped by evidence aliases/containment or token overlap");
const contracts = referenceLocationContractLedgerForTests(scoped);
const broadContract = contracts.contracts.find((contract) => contract.location_contract_id === "station_ref");
assert.deepEqual(broadContract.beat_ids, [], "broad semantic fallback must not attach source-derived beats");
const localContract = contracts.contracts.find((contract) => contract.location_contract_id === localNeed.ref_id);
assert.ok(localContract, "source-derived advisory location is available as a textual contract");
assert.equal(localContract.description, literalLocation);
assert.equal(localContract.prompt_anchor, literalLocation);
assert.deepEqual(localContract.beat_ids, [beat.visual_beat_id]);
assert.deepEqual(localContract.location_provenance, beat.location_provenance);
assert.equal(localContract.semantic_ref_id, null);
const target = (refId, contractIds) => ({
  ref_id: refId, kind: "location", subject: refId,
  scene_ids: [scene.scene_id], location_contract_ids: contractIds,
  generation_mode: "standalone_ref", attachable: true,
  reference_image_path: `/fixture/${refId}.png`,
});
const targets = [
  target("station_ref", ["station_ref"]),
  target("generic_scene_plate", []),
  target("tram_plate", [localNeed.ref_id]),
  target(localNeed.ref_id, []),
];
assert.deepEqual(relevantReferenceTargetsForTests(scopedBeat, { reference_targets: targets }, {})
  .map((ref) => ref.ref_id), ["tram_plate", localNeed.ref_id],
"prompt authoring must exclude inherited scene-only images and accept only the exact source location contract/ref ID");
assert.deepEqual(relevantReferenceTargetsForTests({ ...scopedBeat, ref_needs: [], beat_ref_requirements: [] },
  { reference_targets: targets }, {}), [], "missing local location hints do not admit every scene-scoped plate");
const canonicalNeeds = visualBeatInternalsForTests.localBeatReferenceNeeds(broadScene, canonicalBeat);
assert.equal(canonicalNeeds.find((need) => need.kind === "location").ref_id, "station_ref",
  "existing canonical reference selection remains unchanged");
const canonicalScope = { scenes: [{ ...broadScene, visual_beats: [{
  ...canonicalBeat, ref_needs: canonicalNeeds, beat_ref_requirements: canonicalNeeds,
}] }] };
const canonicalInventory = referenceEvidenceLedgerForTests(canonicalScope, ledger);
const canonicalContracts = referenceLocationContractLedgerForTests(canonicalScope);
delete canonicalInventory.updated_at;
delete canonicalContracts.updated_at;
// Canonical-path snapshots from the unmodified base commit; only report times
// are excluded from the reference-ledger byte comparisons.
assert.equal(hash(JSON.stringify(canonicalBeat)), "0f0e159efa9caa5a5775742aab5fe8dcb6dcbae39f15f260c72f983932abc9a0");
assert.equal(hash(JSON.stringify(canonicalNeeds)), "6a3b5d18755d76fd3b37a610cc264b813d744431a793c6370c300aa0cf09f80b");
assert.equal(hash(JSON.stringify(canonicalInventory)), "7655f9b8f94ae3220632c97c406b1e44a4d5d2e981762be703c32681f29e5804");
assert.equal(hash(JSON.stringify(canonicalContracts)), "4908786e646a03a4d5aa26ed7d6547fe668e0b15eb8df1c676073d5b839c6ab7");

// This digest was verified against the adapter's unmodified base commit. Retained raw
// packets keep their exact planner prompt/cache identity.
const prompt = buildEditorialDirectorPrompt(atoms, ledger, [scene]);
assert.equal(hash(prompt), "bb485fe16a0a2e13de180922ef1338c59c87fda9834a1fa85f739130c8fdcb74");
console.log("editorial source scene location tests passed");
