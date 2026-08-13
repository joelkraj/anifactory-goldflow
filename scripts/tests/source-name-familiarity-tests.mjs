import assert from "node:assert/strict";
import {
  buildSourceNameFamiliarityLedger,
  continuationExemptNameFamiliarityLedger,
  familiarityWeight,
  titleSignalsContinuation,
  validateSourceNameFamiliarityLedger,
} from "../lib/source-name-familiarity.mjs";

const releases = Array.from({ length: 14 }, (_, index) => ({
  schema: "goldflow_source_room_release_v2",
  status: "released",
  released_at: new Date(Date.UTC(2026, 7, 14 - index)).toISOString(),
  character_name_usage: [
    { name: index === 0 ? "Marcus" : `Supporting ${index}`, role: "rival" },
    { name: "Joey Manhwa", role: "protagonist" },
  ],
}));
releases[0].character_name_usage.push({ name: "Sera", role: "continuing ally", reuse_disposition: "series_recurring" });
const ledger = buildSourceNameFamiliarityLedger(releases);
assert.equal(validateSourceNameFamiliarityLedger(ledger).done, true);
assert.ok(ledger.names.find((row) => row.name === "Marcus").familiarity_weight > 0.8);
assert.equal(ledger.names.some((row) => row.name === "Joey Manhwa"), false);
assert.equal(ledger.names.some((row) => row.name === "Supporting 12"), false);
assert.equal(ledger.names.some((row) => row.name === "Sera"), false);
assert.ok(familiarityWeight(0) > familiarityWeight(6));
assert.equal(familiarityWeight(12), 0);
assert.equal(titleSignalsContinuation("Capital Run (Part 2)"), true);
assert.equal(titleSignalsContinuation("Revenge System Episode Three"), true);
assert.equal(titleSignalsContinuation("Part 1: The Beginning"), false);
assert.equal(titleSignalsContinuation("A complete standalone story"), false);
const continuationLedger = continuationExemptNameFamiliarityLedger();
assert.equal(validateSourceNameFamiliarityLedger(continuationLedger).done, true);
assert.equal(continuationLedger.applies, false);

console.log("source name familiarity tests passed");
