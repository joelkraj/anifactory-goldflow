#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  narrativeOverlayAuthoringRules,
  sanitizeNarrativeOverlays,
} from "../lib/narrative-overlay-contract.mjs";
import {
  buildCompactAuthorPromptForTests,
  normalizePromptPacketForTests,
} from "../visual-plan.mjs";

const progressionTreatment = "gold angular RPG status panel with luminous rank typography";
const progressionPrompt = `Joey faces the defeated boss in a 16:9 landscape anime/manhwa frame. Integrate a ${progressionTreatment} in the upper-right reading S-RANK ACHIEVED in large mobile-readable letters.`;
const progression = sanitizeNarrativeOverlays([{
  kind: "rpg_game_text",
  text: "S-RANK ACHIEVED",
  information_delta: "Confirms Joey crossed the control threshold before Dante understands it.",
  placement: "upper-right above the defeated boss",
  style: "rank_gold",
  visual_treatment: progressionTreatment,
}], {
  imageId: "ep_01-cut-001",
  sceneId: "scene_001",
  narrationText: "The meter crossed fifty-one percent, and every guard ignored Dante's order.",
  providerPrompt: progressionPrompt,
});

assert.equal(progression.overlays.length, 1);
assert.equal(progression.findings.length, 0);
assert.equal(progression.overlays[0].text, "S-RANK ACHIEVED");
assert.equal(progression.overlays[0].style, "rank_gold");
assert.equal(progression.overlays[0].placement, "upper-right above the defeated boss");

const dialogueTreatment = "white manhwa speech bubble with a thick black outline and short pointed tail";
const dialoguePrompt = `Dante lunges while the guards remain still. Add a ${dialogueTreatment} attached to Dante at frame-right, reading WHO DO YOU WORK FOR? in bold black lettering.`;
const dialogue = sanitizeNarrativeOverlays([{
  kind: "speech_bubble",
  text: "WHO DO YOU WORK FOR?",
  speaker: "Dante",
  information_delta: "Turns his command into a visible loss of authority.",
  placement: "upper-left with clear separation from both faces",
  attachment_target: "Dante at frame-right",
  style: "speech_white",
  visual_treatment: dialogueTreatment,
}], {
  imageId: "ep_01-cut-002",
  sceneId: "scene_001",
  narrationText: "Dante ordered the guards forward, but not one of them moved.",
  providerPrompt: dialoguePrompt,
});

assert.equal(dialogue.overlays.length, 1);
assert.equal(dialogue.findings.length, 0);
assert.equal(dialogue.overlays[0].attachment_target, "Dante at frame-right");

const reactionTreatment = "manhwa reaction styling with compressed shock lines and a drained expression";
const reaction = sanitizeNarrativeOverlays([{
  kind: "manhwa_reaction",
  text: null,
  information_delta: "Shows Dante realizing the room has already changed sides.",
  placement: "around Dante's face without covering his eyes",
  style: "reaction_shock",
  visual_treatment: reactionTreatment,
}], {
  imageId: "ep_01-cut-003",
  narrationText: "For the first time, Dante looked around the room.",
  providerPrompt: `Tight reaction frame of Dante with ${reactionTreatment}, keeping his eyes readable.`,
});
assert.equal(reaction.overlays.length, 1);
assert.equal(reaction.findings.length, 0);

const duplicate = sanitizeNarrativeOverlays([{
  kind: "rpg_game_text",
  text: "THE METER CROSSED FIFTY ONE PERCENT",
  information_delta: "Repeats the narration.",
  visual_treatment: "blue RPG status panel",
}], {
  imageId: "ep_01-cut-004",
  narrationText: "The meter crossed fifty-one percent.",
  providerPrompt: "A blue RPG status panel reads THE METER CROSSED FIFTY ONE PERCENT.",
});
assert.equal(duplicate.findings.some((finding) => finding.code === "narrative_overlay_duplicates_narration"), true);

const missingFromPrompt = sanitizeNarrativeOverlays(progression.overlays, {
  imageId: "ep_01-cut-005",
  narrationText: "The guards changed sides.",
  providerPrompt: "Joey faces the defeated boss in a modern urban manhwa frame.",
});
assert.equal(missingFromPrompt.findings.some((finding) => finding.code === "narrative_overlay_not_authored_in_provider_prompt"), true);

const normalizedPrompt = normalizePromptPacketForTests({
  scene_id: "scene_001",
  visual_beat_id: "beat_001",
  provider_prompt: progressionPrompt,
  narrative_overlays: progression.overlays,
  shot_manifest: null,
}, {
  scene_id: "scene_001",
  visual_beat_id: "beat_001",
  target_image_id: "ep_01-cut-001",
  visual_beat_script_excerpt: "The meter crossed fifty-one percent.",
  start_sec: 0,
  duration_sec: 5,
}, { episode: "ep_01", activeImageProvider: "modelslab" });
assert.equal(normalizedPrompt.narrative_overlays.length, 1);
assert.equal(normalizedPrompt.narrative_overlays[0].text, "S-RANK ACHIEVED");
assert.deepEqual(normalizedPrompt.narrative_overlay_findings, []);

const authorPrompt = buildCompactAuthorPromptForTests({
  compactTimedPlan: { source_unit: "visual_beats", scene_count: 1, scenes: [], animation_direction: { enabled: false } },
  compactSemanticPlan: { style_summary: "modern urban manhwa" },
  correctionDirectives: [],
  activeProvider: "modelslab",
  activeProviderOptions: {},
  contentProfile: {
    id: "manhwa_recap_v1",
    content_family: "fictional_manhwa_recap",
    visual: {
      scene_prompt_style_phrase: "16:9 landscape anime/manhwa frame",
      planner_directives: [],
      shot_jobs: [],
    },
  },
});
assert.match(authorPrompt, /Every cut must include narrative_overlays/);
assert.match(authorPrompt, /Most cuts should use one integrated narrative graphic/);
assert.match(authorPrompt, /directly inside provider_prompt/);
assert.match(authorPrompt, /rpg_game_text/);
assert.match(authorPrompt, /manhwa_reaction/);
assert.equal(narrativeOverlayAuthoringRules().length >= 6, true);

console.log("narrative overlay tests passed");
