import assert from "node:assert/strict";
import {
  buildEditorialDirectorPrompt,
  editorialRetentionRailFindings,
  normalizeEditorialGrouping,
} from "../lib/editorial-beat-director.mjs";
import {
  mergeEditorialRecoveryBeatsForTests,
  retentionBeatDensityFindingsForTests,
} from "../visual-beat-plan.mjs";

const atom = {
  atom_id: "atom_w000000_w000004",
  source_word_start_index: 0,
  source_word_end_index: 4,
  start_sec: 1300,
  end_sec: 1304,
  duration_sec: 4,
  text: "Joey repairs Aria's damaged knee.",
  scene_id: "scene_shop",
  semantic_location: "Mara's shop",
  semantic_scene: { scene_id: "scene_shop", location: "Mara's shop" },
  transition_barrier_before: false,
};

const ledger = {
  canonical_entities: [
    { entity_id: "joey", display_name: "Joey", aliases: [], kind: "person" },
    { entity_id: "aria", display_name: "Aria", aliases: [], kind: "synthetic_person" },
  ],
  canonical_locations: [{ location_id: "maras_shop", display_name: "Mara's shop", aliases: [] }],
  canonical_props: [],
  canonical_ui_motifs: [],
};

const raw = {
  beats: [{
    source_atom_ids: [atom.atom_id],
    visual_job: "physical_action",
    shot_job: "physical_action",
    depiction_mode: "current_reality",
    location_id: "maras_shop",
    physically_visible_entity_ids: ["joey", "aria"],
    screen_visible_entity_ids: [],
    preview_visible_entity_ids: [],
    mentioned_only_entity_ids: [],
    primary_entity_id: "joey",
    entity_evidence: {
      joey: "Joey",
      aria: "Aria",
    },
    props: [],
    ui_elements: [],
    background_population: { presence: "none" },
    foreground_action: "Joey repairs Aria's damaged knee.",
    foreground_action_evidence: "Joey repairs Aria's damaged knee.",
    composition_intent: "Joey and Aria beside the opened knee joint.",
    continuity_note: "",
    editorial_cues: ["physical_action"],
    rail_exception: null,
  }],
};

const normalized = normalizeEditorialGrouping(raw, [atom], ledger, "ep_01");
assert.equal(normalized.beats.length, 1);
assert.equal(normalized.beats[0].duration_sec, 4);
assert.equal(normalized.findings.some((finding) => (
  finding.code === "editorial_retention_timing_goal_miss" && finding.severity === "warning"
)), true);

const applied = editorialRetentionRailFindings(normalized.beats);
assert.equal(applied.length, 1);
assert.equal(applied[0].severity, "warning");
assert.equal(applied[0].code, "editorial_applied_hold_timing_goal_miss");

const density = retentionBeatDensityFindingsForTests([
  { visual_beat_id: "hook", start_sec: 0, end_sec: 30, duration_sec: 30 },
  { visual_beat_id: "ramp", start_sec: 30, end_sec: 180, duration_sec: 150 },
]);
assert.equal(density.length, 2);
assert.equal(density.every((finding) => finding.severity === "warning"), true);

const later = { ...normalized.beats[0], visual_beat_id: "beat_later", source_word_start_index: 5, source_word_end_index: 9 };
const merged = mergeEditorialRecoveryBeatsForTests([later], normalized.beats);
assert.deepEqual(merged.map((beat) => beat.visual_beat_id), [normalized.beats[0].visual_beat_id, "beat_later"]);
assert.throws(() => mergeEditorialRecoveryBeatsForTests(normalized.beats, normalized.beats), /duplicate beat/i);

const prompt = buildEditorialDirectorPrompt([atom], ledger, [atom.semantic_scene]);
assert.match(prompt, /Retention timing is an editorial goal, never a validity gate/i);
assert.match(prompt, /a 4-second beat is valid in any band/i);

console.log("visual beat advisory policy tests passed");
