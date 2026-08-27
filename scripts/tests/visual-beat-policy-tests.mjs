import assert from "node:assert/strict";
import {
  buildEditorialDirectorPrompt,
  editorialRetentionRailFindings,
  normalizeEditorialGrouping,
} from "../lib/editorial-beat-director.mjs";
import {
  mergeEditorialRecoveryBeatsForTests,
  retentionResetEvidenceForTests,
  retentionBeatDensityFindingsForTests,
} from "../visual-beat-plan.mjs";
import {
  visualBeatQualityContractFindings,
} from "../lib/visual-beat-quality-contract.mjs";

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
    visual_information_delta: {
      kind: "new_action_or_contact",
      statement: "The repair is physically visible at Aria's opened knee joint.",
      compared_to_previous: "The sequence moves from diagnosis to direct repair contact.",
    },
    sequence_grammar: {
      shot_size: "medium",
      camera_angle: "level three-quarter angle",
      vantage: "Joey's working side",
      sequence_role: "advance",
    },
    spatial_continuity: {
      eyeline_axis: "Joey looks down toward Aria's knee",
      primary_screen_position: "Joey left, Aria right",
      primary_facing: "screen_right",
      threat_or_counterparty_position: "not_applicable",
      travel_direction: "stationary",
      object_geography: "opened knee joint between both characters",
      intentional_axis_break: false,
      axis_break_reason: null,
    },
    beat_value: {
      tier: "priority",
      moment_types: [],
      reason: "The repair proves capability but is not a package-scale hero moment.",
    },
    retention_reset: {
      kind: "story_earned",
      evidence_ids: [],
      purpose: "Visible repair action changes the scene state.",
    },
    audiovisual_intent: {
      motion_role: "supports_clarity",
      sfx_event: null,
      score_behavior: "hold",
      silence_behavior: "not_required",
      subtitle_emphasis: [],
      coordination_note: "Keep the repair readable without decorative effects.",
    },
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
assert.match(prompt, /State exactly what new visual information each beat adds/i);
const hardTimingOptions = {
  beatTimingEnforcement: "hard_max",
  timingContract: {
    enforcement: "hard_max",
    target_beat_sec: 7.5,
    max_beat_sec: 8,
    min_beat_sec: 3,
    hook_duration_sec: 30,
    hook_target_beat_sec: 3.2,
    hook_max_beat_sec: 4.2,
    hook_min_beat_sec: 2.2,
    retention_ramp_sec: 1200,
    ramp_target_beat_sec: 6,
    ramp_max_beat_sec: 7,
    ramp_min_beat_sec: 3.2,
  },
};
const hardPrompt = buildEditorialDirectorPrompt([atom], ledger, [atom.semantic_scene], hardTimingOptions);
assert.match(hardPrompt, /structural validity gate/i);
assert.match(hardPrompt, /NEVER exceed 8s/i);
const overlongClosedBeat = [{ ...normalized.beats[0], start_sec: 1300, end_sec: 1308.1, duration_sec: 8.1 }];
const hardFindings = editorialRetentionRailFindings(overlongClosedBeat, hardTimingOptions);
assert.equal(hardFindings[0].severity, "blocker");
assert.equal(hardFindings[0].code, "editorial_applied_hold_hard_max_exceeded");
assert.equal(normalized.beats[0].quality_budget.tier, "priority");
const analyticsEvidence = retentionResetEvidenceForTests({
  video_id: "video_1",
  significant_drops: [{ elapsed_sec: 42, delta_from_previous_pct: -7.5 }],
}, "/tmp/analytics.json", "a".repeat(64));
assert.equal(analyticsEvidence[0].evidence_id, "retention_drop_001");
const invalidAnalyticsReset = structuredClone(raw.beats);
invalidAnalyticsReset[0].retention_reset = {
  kind: "analytics_earned",
  evidence_ids: ["invented_drop"],
  purpose: "Claim a measured reset without measured evidence.",
};
assert.equal(visualBeatQualityContractFindings(invalidAnalyticsReset, {
  analyticsEvidenceIds: analyticsEvidence.map((row) => row.evidence_id),
}).some((finding) => finding.code === "visual_retention_reset_evidence_invalid"), true);

console.log("visual beat advisory policy tests passed");
