# Panel layout engine: first rendered comparison

Date: 2026-10-08. Scope: local editing-engine proof, not an episode continuation or production approval.

## Delivered

- [Comparison player](../../scratch/panel-engine/compare.html): synchronized full-frame baseline and panel candidate, with single-view toggles.
- [Panel candidate v2](../../scratch/panel-engine/panel-v2/panel-proof.mp4).
- [Full-frame baseline](../../scratch/panel-engine/baseline-v1/panel-proof.mp4).
- [Editable panel review](../../scratch/panel-engine/editor-v2/review.html).
- [Candidate timeline](../../scratch/panel-engine/root-source/timeline-v2.json) and [decoded frame sheet](../../scratch/panel-engine/panel-v2/contact-sheet.jpg).
- [Reusable engine contract and commands](../designs/panel_layout_engine_v1.md).

The local media is ignored by Git; code, contract, tests and this result are tracked. Both edits reuse eight existing original-story images and the same 0–24.12-second canonical narrator-only audio window from `2026-W35-mafia-boss-ascension-v1/ep_01`. Source assets and episode artifacts were read without modification. Their precise paths and hashes are bound in each retained render report.

## Verified result

Both videos pass 1920×1080, 30 fps, 724 frames, H.264, `yuv420p`, AAC, and duration checks within one frame. Video duration is approximately 24.133 seconds; narration remains the authored 24.12-second slice without tempo or gain changes. Extracted AAC streams are byte-identical between the two edits:

`c43e79141fb3a10824d8db1e1f83d1fb54a39fa697e3406cfcfdfc7d736ee555`

The v2 candidate rendered in 21.992 seconds locally, with zero provider calls/spend. Its video SHA-256 is:

`8d9f9fe47871607099d978b771c52b6d1f36a12d95918d9b6b80475bdc20e758`

The first candidate remains retained. Review of decoded frames found clipped image-native lettering in the arrival and couple viewports; v2 changes only those crops/layout geometry and preserves source hashes and narration times. The final decoded sheet was inspected for face readability, overlap, object detail and payoff framing. Browser checks verify synchronized playback and seeking; this is not a recorded end-to-end listening approval.

All 18 panel test groups pass, including actual encoded pixels, page traversal, exact reveal boundaries, audio offsets, immutable outputs, source hash checks, nested-playlist rejection, invalid edit preservation, and correct grouped opacity. `npm run check`, workflow-routing tests and render-duration-integrity tests pass. The preview server was separately checked for successful byte-range reads, invalid-range rejection and exact 16.95-second browser seeking.

## Editorial limits

The promising moment is the command/reaction pairing at roughly 15.4–17.84 seconds: the security chief appears while the commander's face stays visible. The foreground pin detail then gives way to the full-room consequence. This is an editing hypothesis, not audience-retention evidence.

These are authored crops of landscape illustrations, not extracted native vertical manhwa pages. Continuous page movement is implemented and tested with a synthetic tall-page fixture, but is not demonstrated by this story excerpt. No new continuity art, automated segmentation, captions, or full production adapter was added. No Manhwa Fresh frames were measured, so this result makes no claim to reproduce that channel's exact editing parameters.
