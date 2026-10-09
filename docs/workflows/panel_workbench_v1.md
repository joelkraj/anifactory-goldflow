# Panel workbench v1

The workbench prepares, reviews and renders private panel-editing experiments from local artifacts. It has two entry paths: import an existing approved original-story episode for a controlled editing comparison, or index comic/prose sources and develop a source-grounded adaptation candidate. The latter currently ends at a narration handoff packet.

Run commands from the repository root with `node scripts/panel-workbench.mjs`. This is a separate development adapter, not a registered production or publishing workflow. It does not complete episode stages, change existing identities, call providers, generate artwork or publish videos. The existing [panel engine proof](../designs/panel_layout_engine_v1.md) keeps its separate schema and 150-second limit. A workbench `editing_experiment` can run up to 1,800 seconds.

## Scope and prerequisites

- Source import accepts an explicit ordered list of local, static PNG/JPEG/WebP comic pages, or valid UTF-8 `.txt`, `.md` and `.markdown` text files. It has no URL downloader or PDF/EPUB extractor. Comic artwork must already have normalized orientation.
- Text indexing preserves source bytes and records paragraph/sentence spans in UTF-16 code units. Sentence boundaries are a mechanical index, not semantic adaptation. Comic ingestion accepts authored rectangles or offers the whole page as an unreviewed proposal; it does not detect panel semantics, characters, dialogue or story beats.
- An editor or agent inspects the actual source and authors narration, source references, visual intent, panel choices, crops, camera movement and reveal times. The engine validates and executes these decisions. It does not derive creative decisions from keyword rules or a repeating transition timer.
- Use new directories outside `episodes` and outside any directory with an ancestor `run_identity.json`. Existing output attempts are immutable; choose a fresh output directory for a revision. Keep reusable render caches separate from output attempts. Source packages and their original local files must remain available and unchanged for provenance checks.
- Rendering/review uses the repository Node dependencies, Sharp, FFmpeg/FFprobe and Chrome through Playwright. Optional binary overrides are `ANIFACTORY_FFMPEG_BIN`, `ANIFACTORY_FFPROBE_BIN` and `ANIFACTORY_CHROMIUM_BIN`. The Chrome default is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- Rendering expects a clean worktree. A bounded development experiment may explicitly use `--allow-dirty-worktree true --dirty-reason "<specific diagnostic reason>"`. This records a diagnostic exception; it does not unlock production.

## Path A: original-story editing comparison

### 1. Import one exact source window

Select the episode explicitly and read its recorded identity. This operation consumes existing approved artifacts without changing the source episode. It requires current script approval/lock, canonical narration and applicable QA, official Whisper word timing, approved beat grouping, and accepted generated-raster hashes. Historical narration decisions are retained with their original bindings; the importer does not create listening approval.

Create an import config. The channel, series and episode must match the source identity; the experiment ID and title describe this new private comparison. For example, the existing Mafia source has channel `53rebirth`, series `mafia-boss-ascension` and episode `ep_01`:

```json
{
  "schema": "goldflow_original_panel_experiment_config_v1",
  "id": "mafia-panel-comparison-01",
  "channel": "53rebirth",
  "series": "mafia-boss-ascension",
  "episode": "ep_01",
  "title": "Mafia original-story panel editing comparison",
  "width": 1920,
  "height": 1080,
  "fps": 30
}
```

Save it outside the episode, then import the first 20 minutes. These commands illustrate a fresh experiment directory; use an unused name for each candidate:

```sh
PANEL_WORK=/Users/joel/AniFactoryData/panel_experiments/mafia-panel-comparison-01

node scripts/panel-workbench.mjs prepare-original \
  --episode-dir /Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W35-mafia-boss-ascension-v1/episodes/ep_01 \
  --config "$PANEL_WORK/import-config.json" \
  --start-sec 0 --end-sec 1200 \
  --output-dir "$PANEL_WORK/import"
```

The source window must be positive, at most 1,800 seconds, and covered by the actual canonical narration and approved beat plan. The importer rebases source time to experiment time and clips the first/last beat at the window boundary. It preserves original word indices, source times, beat excerpts and full-script references. It never reconstructs approved prose by slicing ASR tokens.

The output contains:

| File | Purpose |
| --- | --- |
| `original_source_packet.json` | Exact source identity, approvals, script, narration, timing, selected beats, words, rasters and all authoritative source hashes |
| `experiment_identity.json` | Private, local-artifacts-only identity and locked source window |
| `baseline.json` | Static full-source control edit with unchanged narration and approved beat boundaries |
| `composition_packet.json` | Source evidence and visual inventory requiring authored panel treatment |
| `import_report.json`, `execution_events.jsonl` | Immutable import result and provenance |

The control uses each existing image with `contain`, a full-canvas static panel and a black background. This deliberately supplies a neutral comparison baseline. It is not a reconstruction of a previously published episode's complete edit.

### 2. Author the treatment

```sh
node scripts/panel-workbench.mjs composition-template \
  --timeline "$PANEL_WORK/import/baseline.json" \
  --output-dir "$PANEL_WORK/authoring"
```

Inspect `authoring_packet.json`, the actual images and narration. Fill `authoring/recipe.json`, preserving its exact `source_timeline` and `experiment_identity` bindings. Set `author`, then supply one explicit decision for every original scene. No missing layout or editorial reason is filled automatically.

Each decision selects `full_frame`, `inset`, `reveal`, `reaction_pair` or `page_pan`, a foreground `panel_id`, a `background_panel_id`, and an `editorial_reason`. Geometry is normalized:

- `source_rect` crops **within the indexed panel's crop**; it does not refer directly to the whole raster unless the original panel is full-source. Omit it to preserve the indexed crop.
- `rect` sets the on-screen viewport. `fit` is `contain` or `cover`; inspect faces, lettering and important objects before using a tighter crop.
- `camera_from` and `camera_to` contain `x`, `y` and `zoom`. Camera x/y traverse available overflow; explicit `move_start_sec`/`move_end_sec` create reading holds around a movement.
- `page_pan` requires both camera endpoints. Stationary endpoints remain a hold.
- `reveal` and `reaction_pair` require `entry` and `context`. Entry directions are `left`, `right`, `up` and `down`. Entry starts at the authored absolute experiment time and must finish before scene end. Context remains visible from scene start until `context.end_sec`, which must cover the entire entrance.

For a scene spanning 4–6 seconds, this is an illustrative reveal decision. Replace its scene/panel IDs and creative choices with ones grounded in the inspected source:

```json
{
  "scene_id": "scene-003",
  "layout": "reveal",
  "panel_id": "panel-reaction",
  "background_panel_id": "panel-previous-speaker",
  "editorial_reason": "Hold the previous speaker until the narration identifies the reaction.",
  "rect": { "x": 0.54, "y": 0.08, "width": 0.42, "height": 0.84 },
  "fit": "contain",
  "camera_from": { "x": 0.5, "y": 0.5, "zoom": 1 },
  "camera_to": { "x": 0.5, "y": 0.5, "zoom": 1 },
  "entry": { "direction": "right", "start_sec": 4.4, "duration_sec": 0.4 },
  "context": {
    "panel_id": "panel-previous-speaker",
    "rect": { "x": 0.04, "y": 0.08, "width": 0.46, "height": 0.84 },
    "fit": "contain",
    "end_sec": 5.2
  }
}
```

The compiler preserves scene order, exact scene boundaries, duration and audio. It records the result as a treatment. Whether a panel spoils a later event, the chosen background gives away a reveal, or a reaction actually matches the narration remains an editorial review requirement. The engine does not infer those relationships.

```sh
node scripts/panel-workbench.mjs compile \
  --recipe "$PANEL_WORK/authoring/recipe.json" \
  --output-dir "$PANEL_WORK/treatment-01"

node scripts/panel-workbench.mjs validate \
  --timeline "$PANEL_WORK/treatment-01/timeline.json"
```

Compilation writes a new `timeline.json` and `composition_report.json`, including the recipe hash, source hashes, author and layout counts. A changed source timeline, identity, upstream original-source dependency or raster fails validation. Keep prior recipes/candidates when revising; changing the recipe invalidates its earlier provenance binding.

### 3. Review short windows, then render the complete timeline

```sh
node scripts/panel-workbench.mjs review \
  --timeline "$PANEL_WORK/treatment-01/timeline.json" \
  --start-sec 0 --end-sec 120 \
  --output-dir "$PANEL_WORK/review-opening-01"
```

Open the returned `review.html`. The default preview is up to 120 seconds; explicit review windows may span at most 150 seconds within the experiment. The player loads only artwork active in that window and a matching narration excerpt. It supports scene JSON overrides and validates a candidate before applying it. Inspect overlap, faces, reading holds, movement direction and narration synchronization through actual playback.

**Exported JSON contains the complete experiment timeline**, with absolute experiment timings and source audio offset. It is not a truncated proof. Save a review export as a new candidate, validate it, and make a new review window to inspect edits elsewhere. Review/export is not an approval record. The `timeline.json` saved beside the HTML is the initial candidate; browser edits are retained only by exporting them.

```sh
node scripts/panel-workbench.mjs render \
  --timeline "$PANEL_WORK/import/baseline.json" \
  --output-dir "$PANEL_WORK/control-render-01" \
  --cache-dir "$PANEL_WORK/picture-cache"

node scripts/panel-workbench.mjs render \
  --timeline "$PANEL_WORK/treatment-01/timeline.json" \
  --output-dir "$PANEL_WORK/treatment-render-01" \
  --cache-dir "$PANEL_WORK/picture-cache"
```

The renderer divides picture into 10-second frame ranges by default. It caches lossless RGB H.264 picture chunks in Matroska (libx264rgb, CRF 0, veryfast), keyed by relevant layout, raster hashes, identity, code and environment. A changed visual decision invalidates affected chunks; verified unchanged chunks can be reused. Reusing a cache still rechecks current source provenance and chunk media/hash receipts. The temporal lossless codec compresses repeated holds efficiently; cache storage still depends on resolution, detail and motion. Codec/version changes receive new cache keys; older cache attempts stay intact. The API can choose a 0.1–30-second chunk size; the CLI uses 10 seconds.

Identical visible frame states reuse one lossless Canvas capture while still encoding every output frame. Moving cameras, panel entrances and opacity changes receive distinct captures. Reports include capture/reuse counts; frame verification uses threaded decoding.

Narration is read once as one continuous source window during final mux. It is not stitched from the picture chunks, retimed or resynthesized. The MP4 encodes that audio to AAC, so the audio bytes differ from the canonical WAV while its content, timing and source window remain unchanged. Only video frame count is quantized to `round(duration_sec × fps)`; authored event times remain in seconds.

Each attempt writes `panel-experiment.mp4`, its portable `timeline.json`, `render_report.json`, execution events, decoded QA frames and a contact sheet. Technical QA checks frames, codec, dimensions, timing and hashes. It does not substitute for watching/listening to the actual result. Outputs and caches are local review artifacts, with `production_eligible: false`.

## Path B: comic/prose source adaptation

### 1. Index an explicit local source package

A comic config supplies ordered pages and optional authored panel rectangles. Paths resolve relative to the config file. Omit `panels` to get whole-page proposals, each still marked `needs_review`:

```json
{
  "schema": "goldflow_recap_source_config_v1",
  "id": "comic-test-01",
  "title": "Comic adaptation development",
  "source_kind": "comic",
  "files": [
    { "id": "page-001", "path": "pages/page-001.png" },
    { "id": "page-002", "path": "pages/page-002.png" }
  ],
  "panels": [
    {
      "id": "page-001-panel-01",
      "file_id": "page-001",
      "source_rect": { "x": 0, "y": 0, "width": 1, "height": 0.45 }
    }
  ]
}
```

For prose, use `source_kind: "prose"`, ordered chapter paths such as `{ "id": "chapter-001", "path": "chapters/chapter-001.txt" }`, and omit `panels`. `original_script` is also supported for a local unproduced script. These source-development modes are separate from importing an existing approved episode. Optional per-file `sha256` values enforce expected input bytes.

```sh
RECAP_WORK=/Users/joel/AniFactoryData/panel_experiments/comic-test-01

node scripts/panel-workbench.mjs import-source \
  --config "$RECAP_WORK/source-config.json" \
  --output-dir "$RECAP_WORK/source-package"

node scripts/panel-workbench.mjs check-source \
  --source-package "$RECAP_WORK/source-package/source_package.json"
```

Packages accept 1–2,000 explicit files, at most 100 MiB each and 1 GiB total. The fresh package contains source copies, `source_package.json`, `text_index.json`, `panel_inventory.json`, `adaptation_packet.json`, `adaptation_template.json`, `review.html` and an ingestion report. Ingestion never accepts a panel-review decision. Open the source review and inspect the actual pages/text before adaptation.

### 2. Author exact narration and source references

```sh
node scripts/panel-workbench.mjs prepare-adaptation \
  --source-package "$RECAP_WORK/source-package/source_package.json" \
  --target-wpm 185 \
  --output-dir "$RECAP_WORK/adaptation-authoring"
```

Fill a draft based on `draft_template.json`, whose schema is `goldflow_recap_adaptation_draft_v1`. Retain its `source_package_sha256`. Save the completed draft as `adaptation-authoring/draft.json` for the commands below. `target_wpm` supplies only a diagnostic duration estimate; it is not a TTS rate or a timing plan. Every unit needs a unique ID, exact authored `narration_text`, ordered source references and explicit `visual_intent`.

Comic unit example using an actual indexed panel ID:

```json
{
  "id": "unit-001",
  "narration_text": "The hall falls silent as he enters.",
  "source_refs": [
    { "kind": "panel", "id": "page-001-panel-01" }
  ],
  "visual_intent": {
    "panel_ids": ["page-001-panel-01"],
    "needs_artwork": false
  }
}
```

This narration is illustrative; author only what the inspected source supports. Panel references must omit `quote`: the package has no verified OCR transcript. Every `visual_intent.panel_ids` entry must also be cited in that unit's `source_refs`.

Text references use `kind: "text"`, an exact paragraph/sentence ID from `text_index.json`, and a nonempty `quote` copied exactly from that indexed source. A prose unit requires an artwork plan, for example:

```json
{
  "id": "unit-001",
  "narration_text": "He reaches the empty hall before dawn.",
  "source_refs": [
    {
      "kind": "text",
      "id": "chapter-001-p000001",
      "quote": "<replace with an exact excerpt from this indexed paragraph>"
    }
  ],
  "visual_intent": {
    "panel_ids": [],
    "needs_artwork": true,
    "brief": "Establish the empty hall at the time and with the details stated in the source."
  }
}
```

Place authored units in the template's `draft_units` array. References cannot reverse source order, and every unit must name existing panels or explicitly require missing artwork with a brief. These structural checks do not establish narrative fidelity: inspect causality, cast, meaning and reveal order yourself. No automatic summarizer, fiction manufacturer, narration rewrite or artwork generator runs here.

```sh
node scripts/panel-workbench.mjs check-adaptation \
  --source-package "$RECAP_WORK/source-package/source_package.json" \
  --draft "$RECAP_WORK/adaptation-authoring/draft.json"

node scripts/panel-workbench.mjs import-adaptation \
  --source-package "$RECAP_WORK/source-package/source_package.json" \
  --draft "$RECAP_WORK/adaptation-authoring/draft.json" \
  --output-dir "$RECAP_WORK/adaptation-01"
```

Import preserves each narration unit exactly and inserts only two newline separators between units. It writes `script_candidate.txt`, the exact draft copy, `visual_requirements.json`, `adaptation_report.json` and events. Visual requirements retain source references, script character/UTF-8 byte spans, existing-panel IDs and missing-art briefs. These spans are not narrated word timestamps.

### 3. Record source/adaptation review and retain the handoff

After actual comparison of the complete candidate against its source, record that exact review. Use the real reviewer identity and a specific note:

```sh
node scripts/panel-workbench.mjs review-adaptation \
  --adaptation-dir "$RECAP_WORK/adaptation-01" \
  --reviewer "<reviewer name>" \
  --note "<specific source fidelity, ordering and visual coverage review>" \
  --attestation source_and_adaptation_reviewed
```

The command revalidates source/candidate hashes and appends a review receipt plus a `goldflow_recap_narration_handoff_v1` file under `reviews`. Its status, `ready_for_guarded_narration_preparation`, describes the next integration boundary. It does not mean narration exists or that a production stage is approved.

Remaining integration is explicit:

1. Establish a fresh applicable narration identity and scope, then approve the exact candidate script through the guarded shared path.
2. Bind the shared voice plan, approved spoken-text lineage and narration quality contract. Generate/reuse narration only through that supported path and its actual review requirements.
3. Produce current canonical Whisper word timing. Author a unit-to-word-span mapping against the approved narration; do not equate source character offsets with ASR token indices.
4. Bind inspected source panels and any separately created missing artwork to those authored units/word spans. Build an identity-bound panel experiment timeline, then author/review its composition.

There is currently no workbench command that automatically turns the adaptation handoff into canonical narration, timed panel bindings or a complete video. Source fidelity review is separate from exact-script approval, narration listening review, image review and final playback review.

## Comparison protocol

First compare two edits of the same short source sequence, then use a 20–30-minute experiment once the treatment holds up in playback. Keep the exact narration, voice, source window and story constant between the static control and panel treatment. Test an alternate voice separately. Record which candidate/hash each reviewer watched and collect concrete feedback on comprehension, visual engagement, reading time and distracting movement.

If the format later reaches an independently approved channel experiment, compare first-30-second retention, retention at five and ten minutes, average percentage viewed and impressions-to-views performance. Keep packaging and audience differences in the analysis; comparing different uploads cannot isolate editing from story, title, thumbnail or audience effects. The workbench itself does not upload, collect retention or claim a format win from a successful render.

## API and verification references

| Module | Public entry points |
| --- | --- |
| `scripts/lib/panel-original-import.mjs` | `prepareOriginalPanelExperiment({ episodeDir, startSec, endSec, configPath, outputDir })` |
| `scripts/lib/panel-composition-authoring.mjs` | `createPanelCompositionTemplate({ timelinePath, outputDir })`, pure `compilePanelComposition(timeline, recipe)`, `writePanelComposition({ recipePath, outputDir })` |
| `scripts/lib/panel-experiment-contract.mjs` | `validatePanelExperimentTimeline(timeline)`, `loadPanelExperimentTimeline(timelinePath, options)` |
| `scripts/lib/panel-experiment-review.mjs` | `writePanelExperimentReview({ timelinePath, outputDir, startSec, endSec })` |
| `scripts/lib/panel-experiment-renderer.mjs` | `renderPanelExperiment({ timelinePath, outputDir, cacheDir, allowDirtyWorktree, dirtyReason, onProgress, chunkDurationSec })` |
| `scripts/lib/recap-source-package.mjs` | `createRecapSourcePackage({ configPath, outputDir })`, `loadRecapSourcePackage(packagePath, { verifyOriginals })`, `indexRecapText(text, fileId, fileOrder)` |
| `scripts/lib/recap-adaptation.mjs` | `prepareRecapAdaptation`, `checkRecapAdaptation`, `importRecapAdaptation`, `loadRecapAdaptation`, `recordRecapAdaptationReview`, pure `validateRecapAdaptationDraft` |

The CLI accepts only the listed flags for each command and rejects duplicate, unknown or missing flags. Its render command uses the default chunk duration; `chunkDurationSec` is an API option. Review dimensions and time scope are separate: experiments use even 16:9 dimensions from 160×90 through 1920×1080 and 24/25/30/60 fps, while each review window remains bounded.

Relevant executable tests:

```sh
node scripts/tests/panel-original-import-tests.mjs
node scripts/tests/panel-composition-authoring-tests.mjs
node scripts/tests/panel-workbench-tests.mjs
node scripts/tests/panel-experiment-renderer-tests.mjs
node scripts/tests/recap-source-package-tests.mjs
node scripts/tests/recap-adaptation-tests.mjs
```

The importer tests exact source/ASR separation, approvals, stale hashes and immutable originals. Composition tests cover authored layouts, timing/overlap, geometry and source/output immutability. Workbench and renderer tests cover the integrated private adapter and cached picture behavior. Technical fixtures are test evidence, not editorial approval or a new voice take.
