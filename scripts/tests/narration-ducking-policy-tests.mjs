import assert from "node:assert/strict";

import {
  DEFAULT_NARRATION_DUCKING_POLICY,
  narrationDuckingFilter,
  narrationDuckingFilterChain,
  resolveNarrationDuckingPolicy,
} from "../lib/narration-ducking-policy.mjs";

assert.equal(DEFAULT_NARRATION_DUCKING_POLICY.release_ms, 390);
assert.deepEqual(resolveNarrationDuckingPolicy(), {
  threshold: 0.022,
  ratio: 7,
  attack_ms: 12,
  release_ms: 390,
  silence_surge_cap: {
    threshold: 0.016,
    ratio: 6,
    attack_ms: 20,
    release_ms: 200,
  },
});
assert.equal(
  narrationDuckingFilter(),
  "sidechaincompress=threshold=0.022:ratio=7:attack=12:release=390",
);
assert.equal(
  narrationDuckingFilter({ release_ms: 2500 }),
  "sidechaincompress=threshold=0.022:ratio=7:attack=12:release=2500",
);
assert.equal(
  narrationDuckingFilterChain(),
  "sidechaincompress=threshold=0.022:ratio=7:attack=12:release=390,acompressor=threshold=0.016:ratio=6:attack=20:release=200",
);
assert.throws(() => resolveNarrationDuckingPolicy({ release_ms: 10000 }), /between 0.01 and 9000/);

console.log("narration ducking policy tests passed");
