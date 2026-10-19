# Exact post-render narration patch

Use `tts patch-final-narration` only after final QA has passed and actual listening found exact narration units whose delivery is defective (for example a final syllable cut before its natural decay). It replaces reviewed retakes inside each unit's original raw-stream window, so the picture, captions, word timing and every other narration sample keep their positions.

Rules:

- Retakes come from the locked provider, model revision, voice reference and spoken text of each unit, generated through the runner's isolated single-sequence path. Candidate WAVs and their receipt (`goldflow_narration_retake_candidates_v1`) are hash-bound in the spec.
- A retake must fit **at full length** inside the unit's window (unit samples plus the following pause) while leaving at least 50 ms of pause. There is no tempo change and no trimming; a take that does not fit stays out of the spec and is reported.
- Verify each selected take before review: final words present in ASR, natural trailing decay, and fit. Do not loop on seeds; one reviewed extra seed per unit at most.
- The spec (`goldflow_narration_final_patch_spec_v1`, `status: approved`) binds the current render report and final video, the stitch report, the raw stitched stream, the reviewer, the operator quote and note, and each unit's candidate WAV and receipt hashes.

```bash
node bin/goldflow.mjs tts patch-final-narration --episode-dir <episode-dir> --spec <episode-dir>/<approved-spec.json>
```

The command verifies that each accepted unit's exact bytes sit at their offset in the raw stream, splices the retakes, re-masters the whole stream with the standard two-pass mastering, copies the video stream and re-encodes AAC with the renderer's settings. It writes a new `render_report_<episode>-narration-patch-<id>.json` (status selects the latest report) and an immutable receipt under `reports/narration_final_patch/<id>/`. The previous render, report and audio stay untouched. Rerun status: final QA becomes stale and must be rerun and reviewed against the patched video before packaging.
