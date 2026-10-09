# Panel workbench v1 — local integration result

Recorded October 8–9, 2026. See the [operating workflow](../workflows/panel_workbench_v1.md) for schemas and commands.

## Delivered comparison

The existing approved Mafia original story supplies a private three-minute control/treatment pair. Both use the same 44 source images, approved beat boundaries and canonical narrator-only audio window, 0–180 seconds. Source episode files, approvals and identity were not modified. No provider calls, new narration or new image generation occurred.

The treatment contains 11 full-frame decisions, 24 inset decisions, 5 reveals and 4 reaction pairs. Every decision was authored from the actual narration and inspected artwork. No timer or keyword rule chooses transitions. Page scrolling remains covered by dedicated tall-artwork fixtures; this source consists of existing landscape illustrations.

Local output root:

```text
/Users/joel/anifactory-goldflow/scratch/panel-workbench/joey-original-3min
```

| Artifact | Path under that root |
| --- | --- |
| Synchronized comparison player | `compare.html` |
| Control MP4 | `control-render-v3/panel-experiment.mp4` |
| Panel treatment MP4 | `treatment-render-v3/panel-experiment.mp4` |
| Complete authored timeline | `treatment-v3/timeline.json` |
| Exact recipe | `authoring-v1/recipe-authored-v3.json` |
| Editable 0–90 second preview | `review-opening-v3/review.html` |
| Editable 90–180 second preview | `review-ending-v3/review.html` |
| Audio/media comparison receipt | `comparison-check-v3.json` |
| Browser transport check | `browser-check-v3.json` |

Serve the workbench root with:

```sh
node scripts/panel-layout-review-server.mjs \
  --directory /Users/joel/anifactory-goldflow/scratch/panel-workbench \
  --port 8770
```

Then open `http://127.0.0.1:8770/joey-original-3min/compare.html`.

Both MP4s passed 1920×1080, 30 fps, 5,400 frames, exactly 180 seconds, H.264/yuv420p and AAC checks. Demuxed AAC was byte-identical across the two edits:

```text
4b448769f3a671b36eb982bc04ea3063954a068967800f562064e0b2b318267c
```

Final file hashes:

```text
control:   6bc7fd480fa7d9b9811a5290143b1d925533cd870a1d8c52c9ec2d24a192bd91
treatment: 67d4ed89c834807861687a0875a77e85a4f407ec75758fa82e5b87e488e465ac
```

Composition previews and decoded MP4 frames were inspected. Crops that clipped native lettering were revised without modifying source artwork. Browser checks exercised synchronized playback, seeking and focus controls. These checks are technical and sampled visual QA, not an end-to-end audience/editorial listening approval or evidence of retention improvement.

## Longform preparation

`scratch/panel-workbench/joey-original-20min/import-v1` contains an independently bound 0–1,200-second control timeline, 269 accepted rasters and 3,743 timed words. `authoring-v1` contains the exact source evidence and 269 required composition decisions. This is a prepared experiment packet; the full 20-minute treatment has not been authored or rendered.

The private experiment contract supports up to 1,800 seconds. The existing engine-proof contract remains capped at 150 seconds. Neither is a registered production/publishing workflow.

## Measured render behavior

Full-size integration exposed redundant PNG capture and serial FFV1 verification. The retained first control attempt was interrupted after preserving completed chunks; its interruption event/report remains under `control-render-v1`. Two verified optimizations now apply: reuse captures for identical visible states, and threaded media verification. Lossless RGB H.264 replaced FFV1 for new cache entries; old entries remain intact under their earlier keys.

The final three-minute control took 108.778 seconds with 122,681,737 bytes of picture cache. Its earlier FFV1 attempt took 191.967 seconds with 6,786,604,484 bytes. These local timings include different concurrent activity and are diagnostic observations, not a throughput guarantee.

The first complete RGB-cache treatment took 274.611 seconds. A subsequent three-scene crop correction rebuilt four affected ten-second chunks and reused fourteen unchanged chunks. Its final render/verification took 106.531 seconds and used 1,253,781,485 bytes of picture cache. Narration remained one continuous source window through both exports.

The cache codec is tested for exact decoded RGB equality against Canvas and FFV1 through camera movement, panel entry, borders/shadows, blur and partial opacity. Final YouTube-shaped MP4 encoding remains H.264/AAC; intermediate losslessness does not mean that final delivery encoding is lossless.

## Source adaptation preparation

Two real local intake examples were created under `scratch/panel-workbench/source-examples`: the existing original script as a text package, and three existing original illustrations as a comic-input example with authored crops. They demonstrate intake and indexing, not an adaptation of a newly selected comic/light novel. The text example preserves one source paragraph and 1,078 sentence spans; comic crops remain review proposals.

Comics/prose can now move through local source indexing, an authored reference-linked narration draft, structural checks, exact candidate import, source/adaptation review and a narration handoff packet. No first external title was supplied for an actual adaptation test. Canonical TTS execution, authored unit-to-Whisper word spans and source-panel binding still require the next integration; this workbench does not automatically produce a narrated video from its adaptation handoff.

## Verification

69 test groups passed: 18 existing panel-engine, 10 original import, 9 composition, 10 experiment renderer, 7 workbench/browser, 9 source-package and 6 adaptation tests. `npm run check` passed syntax for 505 modules and verified generated workflow guidance. The actual three-minute outputs also passed frame/audio/hash checks; browser receipts and decoded QA frames are retained beside them.

Relevant suites are `npm run test:panel-layout`, `npm run test:panel-workbench` and `npm run test:recap-source`. Existing production routing was not changed by this work.
