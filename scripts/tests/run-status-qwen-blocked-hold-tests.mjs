import assert from "node:assert/strict";
import { stageForTests } from "../run-status.mjs";

const identity = {
  channel: "test",
  series_slug: "narration-hold",
  week: "test-week",
  episode: "ep_01",
};
const blocked = stageForTests("qwen_tts_stitch",
  { done: false, evidence: "narration_tts_report_ep_01.json status=blocked" }, identity);
assert.equal(blocked.state, "blocked");
assert.match(blocked.next_command_shape, /^Operator hold:/);
assert.doesNotMatch(blocked.next_command_shape, /tts narrate/);

const exact = "node bin/goldflow.mjs tts narrate --episode-dir /tmp/ep_01 --confirmed-retry-unit-ids unit_a --confirmed-retry-evidence /tmp/review.json";
assert.equal(stageForTests("qwen_tts_stitch",
  { state: "blocked", next_command_shape: exact }, identity).next_command_shape, exact);
assert.equal(stageForTests("qwen_tts_stitch",
  { done: true }, identity).next_command_shape, null);

console.log("PASS blocked narration defaults to operator hold while preserving exact recovery commands");
