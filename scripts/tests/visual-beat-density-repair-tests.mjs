import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { groupingLockHash } from "../lib/editorial-beat-director.mjs";
import { commandStageFor } from "../lib/pipeline-stage-registry.mjs";
import { reviewedChunkInputHash, splitReviewedVisualBeat, validateDensityRepairSpec,
  visualBeatDensityRepairAdmission } from "../lib/visual-beat-density-repair.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const location = "/tmp/episode";
const target = "beat_w002401_w002424";
const atomIds = ["atom_w002401_w002406", "atom_w002407_w002414",
  "atom_w002415_w002417", "atom_w002418_w002424"];
const atoms = [
  { atom_id: atomIds[0], source_word_start_index: 2401, source_word_end_index: 2406,
    start_sec: 749.88, end_sec: 751, text: "I felt my right hand close" },
  { atom_id: atomIds[1], source_word_start_index: 2407, source_word_end_index: 2414,
    start_sec: 751, end_sec: 752.68, text: "before I realized what had set it off." },
  { atom_id: atomIds[2], source_word_start_index: 2415, source_word_end_index: 2417,
    start_sec: 753.08, end_sec: 753.96, text: "The same sentence," },
  { atom_id: atomIds[3], source_word_start_index: 2418, source_word_end_index: 2424,
    start_sec: 754.4, end_sec: 756.52, text: "different person expected to make the sacrifice." },
];
const firstFrame = {
  visual_beat_action: "Joey's right hand closes as he hears Voss.",
  visual_beat_action_evidence: "I felt my right hand close",
  visual_beat_focus: "Joey's closed right hand dominates the foreground.",
  visual_job: "consequence", suggested_shot_job: "body_state_proof",
  local_continuity_note: "Voss and Tessa remain across the reception axis.",
  visual_information_delta: { kind: "new_character_state", statement: "Joey reacts physically." },
  sequence_grammar: { shot_size: "close", sequence_role: "react" },
  spatial_continuity: { primary_screen_position: "left", primary_facing: "screen_right" },
  audiovisual_intent: { subtitle_emphasis: [], score_behavior: "silence" },
};
const secondFrame = {
  visual_beat_action: "Joey recognizes the sentence and sees who must pay.",
  visual_beat_action_evidence: "The same sentence, different person expected to make the sacrifice.",
  visual_beat_focus: "Joey's expression registers recognition with Tessa and Voss beyond.",
  visual_job: "consequence", suggested_shot_job: "emotional_reaction",
  local_continuity_note: "Stay in reception; the recognition follows Joey's hand closing.",
  visual_information_delta: { kind: "new_relationship_evidence", statement: "The sacrifice would fall on Tessa." },
  sequence_grammar: { shot_size: "close", sequence_role: "reveal" },
  spatial_continuity: { primary_screen_position: "left", primary_facing: "screen_right" },
  audiovisual_intent: { subtitle_emphasis: ["same sentence"], score_behavior: "silence" },
};
const spec = {
  schema: "goldflow_visual_beat_density_repair_v1", status: "approved", episode_dir: location,
  run_identity_sha256: hash("identity"), source_script_sha256: hash("script"),
  timed_scene_plan_sha256: hash("timed"), word_timing_sha256: hash("word"),
  story_fact_ledger_sha256: hash("facts"), failed_visual_beat_plan_sha256: hash("failed"),
  planner_chunk_ledger_sha256: hash("ledger"), visual_beat_id: target,
  source_atom_ids: atomIds, split_after_atom_id: atomIds[1],
  first_frame: firstFrame, second_frame: secondFrame,
  approved_by: "Codex operator", review_note: "The closed hold exceeds the hard cap across a chunk boundary.",
};
const original = { visual_beat_id: target, image_id_hint: "ep_01-w002401-w002424",
  source_atom_ids: atomIds, source_word_start_index: 2401, source_word_end_index: 2424,
  start_sec: 749.88, end_sec: 756.52, duration_sec: 6.64,
  visual_beat_script_excerpt: atoms.map((atom) => atom.text).join(" "),
  visual_beat_action: "Joey's hand closes.", visual_beat_action_evidence: "I felt my right hand close",
  visual_beat_focus: "Hand focus", visual_novelty_directive: "Hand focus",
  location_id: "morrow_factory_reception",
  visual_information_delta: { kind: "new_character_state", statement: "Joey reacts physically.",
    compared_to_previous: "Voss's phrase has just landed." },
  sequence_grammar: { shot_size: "close", camera_angle: "hand level", vantage: "beside Joey", sequence_role: "react" },
  spatial_continuity: { primary_screen_position: "left", primary_facing: "screen_right" },
  beat_value: { tier: "hero", moment_types: ["relationship_turn"], reason: "The phrase links past and present." },
  retention_reset: { kind: "story_earned", evidence_ids: [], purpose: "The confrontation becomes personal." },
  audiovisual_intent: { emphasis_moment_ids: [], motion_role: "changes_emotion", sfx_event: null,
    score_behavior: "silence", silence_behavior: "preserve_both", subtitle_emphasis: [],
    coordination_note: "Hold the reaction without an impact cue." },
};
const next = { visual_beat_id: "beat_w002425_w002431", image_id_hint: "ep_01-w002425-w002431",
  source_atom_ids: ["atom_w002425_w002431"], source_word_start_index: 2425,
  source_word_end_index: 2431, start_sec: 757.1, end_sec: 759.52 };
const prior = { visual_beat_id: "beat_w002394_w002400", image_id_hint: "ep_01-w002394-w002400",
  source_atom_ids: ["atom_w002394_w002400"], source_word_start_index: 2394,
  source_word_end_index: 2400, start_sec: 746.38, end_sec: 749.28 };
const beats = [prior, original, next];
const timing = { enforcement: "hard_max", hook_duration_sec: 30, retention_ramp_sec: 1200,
  hook_max_beat_sec: 4.2, ramp_max_beat_sec: 7, max_beat_sec: 8 };

assert.equal(commandStageFor("visual", "repair-beat-density", {}, {}), "visual_beat_plan");
const status = { episode_dir: location, identity: { schema: "goldflow_run_identity_v2" },
  media_workflow: { id: "generated_visuals_v1" }, current_stage: "visual_beat_plan",
  current_stage_state: "failed", stage_ledger: [
    { stage: "visual_beat_plan", state: "failed" }, { stage: "visual_reference_plan", state: "missing" },
  ] };
const flags = { "episode-dir": location, "repair-spec": "/tmp/spec.json", "beat-ids": target };
assert.equal(visualBeatDensityRepairAdmission(status, flags).allowed, true);
for (const denied of [
  { ...flags, "beat-ids": `${target},beat_w000000_w000001` },
  { ...flags, "workflow-bypass": "true" },
]) assert.equal(visualBeatDensityRepairAdmission(status, denied).allowed, false);
for (const denied of [
  { ...status, current_stage: "visual_reference_plan" },
  { ...status, current_stage_state: "blocked" },
  { ...status, stage_ledger: [status.stage_ledger[0], { stage: "visual_reference_plan", state: "passed" }] },
]) assert.equal(visualBeatDensityRepairAdmission(denied, flags).allowed, false);

validateDensityRepairSpec(spec, target);
const split = splitReviewedVisualBeat(beats, atoms, spec, "ep_01", timing);
assert.deepEqual(split.new_visual_beat_ids, ["beat_w002401_w002414", "beat_w002415_w002424"]);
assert.deepEqual(split.hold_seconds, [3.2, 4.02]);
assert.deepEqual(split.beats[0], prior);
assert.deepEqual(split.beats.at(-1), next);
assert.equal(split.beats[1].visual_beat_script_excerpt, "I felt my right hand close before I realized what had set it off.");
assert.equal(split.beats[2].visual_beat_script_excerpt, "The same sentence, different person expected to make the sacrifice.");
assert.equal(split.beats[1].visual_novelty_directive, firstFrame.visual_beat_focus);
assert.equal(split.beats[2].visual_novelty_directive, secondFrame.visual_beat_focus);
assert.equal(split.beats[1].visual_information_delta.compared_to_previous,
  original.visual_information_delta.compared_to_previous);
assert.equal(split.beats[2].audiovisual_intent.motion_role, original.audiovisual_intent.motion_role);
assert.notEqual(groupingLockHash(split.beats), groupingLockHash(beats), "unapproved failed-plan split changes grouping only at target");
assert.equal(reviewedChunkInputHash({ basePrompt: "exact packet", recoveryGeneration: 0 }), hash("exact packet"));
assert.equal(reviewedChunkInputHash({ basePrompt: "exact packet", recoveryGeneration: 1,
  priorError: "one error" }), hash("exact packet\n\nExact failed-atom recovery 1: the prior packet for only these atoms failed structural validation with: one error. Return one complete corrected JSON packet for these same atoms. Timing goals remain advisory; repair only structural coverage, ordering, transition, identity, evidence, or state-contract errors."));

for (const mutate of [
  (value) => { value.run_identity_sha256 = "wrong"; },
  (value) => { value.split_after_atom_id = atomIds.at(-1); },
  (value) => { value.source_atom_ids = [atomIds[0], atomIds[2]]; },
  (value) => { value.second_frame.visual_beat_action_evidence = "not in script"; },
]) {
  const changed = structuredClone(spec);
  mutate(changed);
  assert.throws(() => splitReviewedVisualBeat(beats, atoms, changed, "ep_01", timing));
}
assert.deepEqual(beats, [prior, original, next], "manual split does not mutate reviewed source beats");
console.log("visual-beat-density-repair-tests passed");
