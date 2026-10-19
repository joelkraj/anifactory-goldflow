import assert from "node:assert/strict";
import { buildRetimeMap, mapSample, mapSeconds, narrationRetimeAdmission, retimeTimeline, retimeWordTiming } from "../lib/narration-retime.mjs";

// Units: 24000 (1 s) + gap 2400, 48000 (2 s) grown to 60000 + gap 1200, last 12000 unchanged.
const map = buildRetimeMap([24000, 48000, 12000], [24000, 60000, 12000], [2400, 1200]);
assert.equal(map.oldTotal, 24000 + 2400 + 48000 + 1200 + 12000);
assert.equal(map.newTotal, map.oldTotal + 12000);
assert.equal(mapSample(map, 0), 0);
assert.equal(mapSample(map, 25000), 25000, "first unit and its pause are unchanged");
assert.equal(mapSample(map, 26400), 26400, "second unit start is unchanged");
assert.equal(mapSample(map, 26400 + 24000), 26400 + 30000, "unit interior scales linearly");
assert.equal(mapSample(map, 26400 + 48000), 26400 + 60000, "pause after a grown unit starts at the new unit end");
assert.equal(mapSample(map, 26400 + 48000 + 600), 26400 + 60000 + 600, "pause samples are kept exactly");
assert.equal(mapSample(map, 26400 + 48000 + 1200), 26400 + 60000 + 1200, "next unit shifts by the growth");
assert.equal(mapSample(map, map.oldTotal), map.newTotal);
for (let s = 0; s < map.oldTotal; s += 997) assert.ok(mapSample(map, s + 997) >= mapSample(map, s), "mapping is monotonic");

const timeline = { duration_sec: map.oldTotal / 24000, audio: { path: "/old.wav", sha256: "a", offset_sec: 0 },
  scenes: [{ id: "s1", start_sec: 0, end_sec: 1.1, layers: [{ start_sec: 0, end_sec: 1.1, keyframes: [{ at_sec: 0 }, { at_sec: 1.1 }] }] },
    { id: "s2", start_sec: 1.1, end_sec: map.oldTotal / 24000, layers: [{ start_sec: 1.1, end_sec: map.oldTotal / 24000, keyframes: [{ at_sec: 2.1 }] }],
      entry: { start_sec: 1.5, duration_sec: 0.4 } }] };
const next = retimeTimeline(timeline, map, { path: "/new.wav", sha256: "b" });
assert.equal(next.duration_sec, map.newTotal / 24000);
assert.equal(next.scenes[0].end_sec, next.scenes[1].start_sec, "contiguous scenes stay contiguous");
assert.equal(next.scenes.at(-1).end_sec, next.duration_sec);
assert.equal(next.scenes[1].entry.duration_sec, 0.4, "durations are not time positions");
assert.equal(next.audio.path, "/new.wav"); assert.equal(next.audio.offset_sec, 0);
assert.equal(timeline.scenes[1].start_sec, 1.1, "input timeline is not mutated");

const words = retimeWordTiming({ words: [{ index: 0, start_sec: 1.2, end_sec: 1.6 }] }, map, { path: "/new.wav", sha256: "b" });
assert.equal(words.words[0].start_sec, mapSeconds(map, 1.2));
assert.equal(words.narration_audio_hash, "b");

const status = { identity: { schema: "goldflow_run_identity_v2", render_profile: "panel_composition_v1" }, media_workflow: { id: "generated_visuals_v1" },
  stage_ledger: [{ stage: "premium_render", state: "passed" }] };
const flags = { "episode-dir": "/e", spec: "/e/s.json" };
assert.equal(narrationRetimeAdmission(status, flags).allowed, true);
assert.equal(narrationRetimeAdmission({ ...status, stage_ledger: [{ stage: "premium_render", state: "stale" }] }, flags).allowed, false);
assert.equal(narrationRetimeAdmission(status, { ...flags, "workflow-bypass": "true" }).allowed, false);
assert.throws(() => buildRetimeMap([1], [1, 2], []), /lengths differ/);
console.log("narration-retime-tests passed");
