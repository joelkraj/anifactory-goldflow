import assert from "node:assert/strict";
import {
  CORE_SOURCE_VIEWER_PROFILES,
  ROTATING_SOURCE_VIEWER_PROFILE_BANK,
  selectRotatingSourceViewerProfiles,
  sourceViewerPanel,
} from "../lib/source-viewer-profile-bank.mjs";

assert.equal(CORE_SOURCE_VIEWER_PROFILES.length, 5);
assert.ok(ROTATING_SOURCE_VIEWER_PROFILE_BANK.length >= 15);
const first = selectRotatingSourceViewerProfiles("room-123", 5).map((profile) => profile.id);
const second = selectRotatingSourceViewerProfiles("room-123", 5).map((profile) => profile.id);
assert.deepEqual(first, second);
assert.equal(new Set(sourceViewerPanel("room-123").map((profile) => profile.id)).size, 10);
assert.notDeepEqual(first, selectRotatingSourceViewerProfiles("room-456", 5).map((profile) => profile.id));
assert.throws(() => sourceViewerPanel(""), /panel seed/i);

console.log("source viewer profile bank tests passed");
