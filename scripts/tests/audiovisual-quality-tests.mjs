import assert from "node:assert/strict";

import {
  audiovisualEmphasisFindingsForTests,
  semanticSfxEventFindingsForTests,
} from "../audio-sfx-score-enrichment.mjs";

const emphasis = [{
  moment_id: "emphasis_001",
  segment_id: "voice_seg_01",
  target_phrase: "the contract turned red",
  story_function: "first visible betrayal proof",
  value_tier: "hero",
  visual_change: "the contract panel changes from white to red",
  motion_role: "changes_understanding",
  sfx_event_id: "sfx_001",
  score_behavior: "drop",
  silence_behavior: "preserve_before",
  subtitle_emphasis: ["red"],
  coordination_note: "Silence clears the phrase before one dry panel confirmation lands.",
}];

assert.deepEqual(audiovisualEmphasisFindingsForTests(emphasis), []);
assert.deepEqual(semanticSfxEventFindingsForTests([{
  event_id: "sfx_001",
  semantic_event_id: "emphasis_001",
  physical_or_editorial_cause: "the visible contract panel changes from white to red",
}], ["emphasis_001"]), []);

const generic = semanticSfxEventFindingsForTests([{
  event_id: "sfx_bad",
  semantic_event_id: "emphasis_001",
  physical_or_editorial_cause: "whoosh",
}], ["emphasis_001"]);
assert.equal(generic.some((finding) => finding.code === "sfx_physical_or_editorial_cause_missing"), true);

const unbound = semanticSfxEventFindingsForTests([{
  event_id: "sfx_unbound",
  semantic_event_id: "made_up",
  physical_or_editorial_cause: "the visible vault door locks against its steel frame",
}], ["emphasis_001"]);
assert.equal(unbound.some((finding) => finding.code === "sfx_semantic_event_binding_missing_or_invalid"), true);

console.log("audiovisual quality tests passed");
