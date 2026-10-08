# Panel layout engine: bounded editing proof

The panel compositor turns indexed artwork and an authored, narration-timed timeline into a 16:9 video. A panel has a crop in its source image; a layer places that panel in a screen rectangle. Those are independent coordinates. Multiple layers can remain visible, enter from different directions, expand, or scroll through a tall page while one continuous narration track plays.

This is a reusable local **engine proof**, limited to 150 seconds, alongside the existing renderer. It does not register a new production workflow, migrate run identities, complete episode stages, generate media, or publish. Keep its inputs and outputs outside episode folders. It uses explicit `manhwa_recap_v1` content intent, `engine_proof` scope, local raster/audio paths and SHA-256 hashes. Existing production routing remains authoritative.

## What works

- Directional panel entry while an earlier panel remains visible.
- Color-matched, blurred source artwork behind sharp foreground panels. The background source is explicitly selected so a future reveal need not appear early.
- Camera moves and zooms inside clipped panels, with linear, smooth or held interpolation.
- Overlapping reaction panels, independently timed and ordered by `z`.
- Continuous vertical page movement: camera `y` traverses the available image overflow from top (`0`) to bottom (`1`). Repeated keys preserve reading holds.
- Expansion from an inset to a large payoff panel, or rapid sequential cuts with deliberate impact holds.
- Local review player with scrubbing, scene JSON overrides and timeline export. The player and video exporter use the same frame evaluator and Canvas compositor.
- Supplied continuity artwork can be indexed with `origin: continuity_generated`; it follows the same source hash/crop/timing contract. This engine makes no image-generation calls.

There is no transition clock, keyword-based scene classifier, automatic pan, default crossfade, or story rewrite. The author supplies the composition and exact times. Native panel segmentation, character extraction, vision-assisted matching, gap-fill generation, captions, and full-length production integration are later adapters, not implemented capabilities. Source rectangles can already index multiple panels in a single supplied page without creating duplicate image files.

## Commands

Requirements: Node dependencies from this repository, FFmpeg/FFprobe, and local Chrome. `ANIFACTORY_CHROMIUM_BIN`, `ANIFACTORY_FFMPEG_BIN` and `ANIFACTORY_FFPROBE_BIN` override executable locations. Chrome runs headlessly and offline during export; no remote page or provider is contacted.

```bash
node scripts/panel-layout-proof.mjs validate --manifest /absolute/path/timeline.json
node scripts/panel-layout-proof.mjs review --manifest /absolute/path/timeline.json --output-dir /absolute/path/new-review
node scripts/panel-layout-proof.mjs render --manifest /absolute/path/timeline.json --output-dir /absolute/path/new-render
node scripts/panel-layout-review-server.mjs --directory /absolute/path/proof-folder
```

The optional preview server binds only `127.0.0.1`, prints its local URL, and supports byte-range requests for reliable video/audio scrubbing. Open `/review.html` for a review output or `/compare.html` for the local comparison artifact. Local HTML files may also be opened directly.

For code-development proofs in an already dirty checkout, explicitly add:

```bash
--allow-dirty-worktree true --dirty-reason "Bounded panel-engine development proof; existing episode and production artifacts are unchanged"
```

Every output directory must be new. Successful and failed attempts are retained. An edited timeline is a new candidate and needs a fresh validation/render directory. Outputs include a timeline snapshot, MP4, sampled frames/contact sheet, immutable report and append-only execution events. Reports bind source and implementation hashes, Git state, scope, elapsed time, local software versions, zero provider spend and `production_eligible: false`. Technical pass is not an editorial or production approval.

## Timeline contract

Top-level fields:

| Field | Contract |
| --- | --- |
| `schema` | `goldflow_panel_timeline_v1` |
| `id`, `intent`, `content_profile` | Explicit ID, `engine_proof`, `manhwa_recap_v1` |
| `width`, `height`, `fps` | Even 16:9 canvas up to 1920×1080; 24, 25, 30 or 60 fps. Small canvases support inexpensive fixtures. |
| `duration_sec` | Greater than zero, at most 150 seconds; no global timing stretch. |
| `audio_target`, `audio` | `narrator_only` with `{path, sha256, offset_sec}`, or `silent_fixture` with no audio. |
| `assets` | Unique `{id, path, sha256, origin, provenance}` rows. Supported origins: `original_generated`, `existing_artwork`, `continuity_generated`, `test_fixture`. Local static PNG/JPEG/WebP only. |
| `panels` | Unique `{id, asset_id, source_rect, metadata}` rows. Crop coordinates are normalized to the orientation-corrected source raster. Metadata can retain page/scene order, characters, emotion, narration excerpt, and source word spans. |
| `scenes` | Contiguous, non-overlapping coverage of the exact authored duration, each with background and layers. |

One example layer inside a scene that lasts from `0` to `4` seconds:

```json
{
  "id": "reaction_enters",
  "panel_id": "reaction_crop",
  "start_sec": 1.8,
  "end_sec": 4,
  "z": 2,
  "fit": "cover",
  "border_px": 4,
  "keyframes": [
    {"at_sec": 1.8, "rect": {"x": 1.02, "y": 0.12, "width": 0.32, "height": 0.76}, "camera": {"x": 0.5, "y": 0.5, "zoom": 1}, "opacity": 1, "easing": "smooth"},
    {"at_sec": 2.2, "rect": {"x": 0.61, "y": 0.12, "width": 0.32, "height": 0.76}, "camera": {"x": 0.5, "y": 0.5, "zoom": 1}, "opacity": 1, "easing": "hold"},
    {"at_sec": 4, "rect": {"x": 0.61, "y": 0.12, "width": 0.32, "height": 0.76}, "camera": {"x": 0.5, "y": 0.5, "zoom": 1}, "opacity": 1, "easing": "hold"}
  ]
}
```

The background is `{panel_id, blur_px, brightness}`. A panel source crop is `{x, y, width, height}` within `[0,1]`, fully inside the source image. Layer rectangles use normalized canvas coordinates and may start offscreen. Keys use absolute seconds, strictly increase, and span the layer's exact lifetime. `camera.x/y` select the horizontal/vertical overflow position, `camera.zoom` is at least one. `contain` preserves the complete crop with gutters; `cover` fills the viewport. The renderer never invents a focal point beyond the supplied camera path.

Intervals are half-open: a layer is visible at its `start_sec` and absent at its `end_sec`. A scene change occurs on the first output frame at or after its authored boundary. Only the final video frame count is rounded to the nearest frame; narration offsets and editorial events retain their exact seconds. Audio is a source-time slice with a single final AAC encode, no gain, time stretch, or effects. FFprobe validates output frame count, dimensions, FPS, H.264, `yuv420p`, AAC when requested, and duration within one frame.

## Test and promotion boundary

```bash
node scripts/tests/panel-layout-tests.mjs
npm run test:workflow-routing
node scripts/tests/render-duration-integrity-tests.mjs
```

The panel suite includes source-hash rejection, geometry, authored holds, exact reveal boundaries, tall-page traversal, real encoded pixel samples, audio window checks, fractional-duration handling and retained-output protection. These test renderer behavior; they do not establish retention improvement or equality with another channel's editing.

A useful first editorial comparison uses the same short original sequence, audio and image sources in both a full-frame baseline and panel version. Portrait crops of landscape illustrations are labeled as such; they are not evidence about native webcomic extraction. Inspect the actual moving result in addition to frame sheets. Before extending to 20–30 minutes, review the short proof, then add the production adapter, durable artifact validation and guarded command route without changing existing episode identities. A Canvas/JPEG frame pipe is suitable for bounded proofs; full-length throughput, lossless intermediate transport and caching still require measurement before production use.
