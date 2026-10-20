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

## Retime when good takes do not fit

When reviewed complete takes are longer than their windows, use `tts retime-final-narration` instead of trimming. It requires a passed panel composition plan and a final QA that passed on this production. The `goldflow_narration_retime_spec_v1` spec binds the current panel plan and timeline, canonical word timing, audio bed report, stitch report and raw stream, plus each unit's candidate WAV and receipt.

```bash
node bin/goldflow.mjs tts retime-final-narration --episode-dir <episode-dir> --spec <episode-dir>/<approved-retime-spec.json>
```

The command rebuilds the narration from original unit bytes or reviewed retakes, keeping every pause's exact original samples, and masters it with the standard two-pass mastering. It maps every time with a monotonic sample-exact map: pauses keep their sample counts and each retaken unit's interior scales linearly to its new length. It writes a retimed panel timeline and word timing (captions follow beat word indices) and an immutable receipt under `reports/narration_retime/<id>/`. No planner, image, tempo or trimming change is made, and original artifacts stay untouched and hash-bound.

Render the retimed variant through the normal renderer with `--narration-retime-receipt <receipt.json>` (a passed render needs the operator-approved full-stage rerun override). The renderer still validates every original panel input, then verifies that the receipt binds those exact originals before substituting the retimed timeline, word timing and master. The master passes the same mastering passthrough check. Then rerun and review final QA.


## Operator-selected complete voice replacement

The same `tts retime-final-narration` command accepts a spec with
`mode: operator_selected_voice_replacement_v1` and `replacement` bindings for a
separate production episode's accepted Qwen identity, unchanged script, generation
plan, stitch, delivery QA, word timing, mastered WAV and mastering report. Each
binding has an absolute `path` and exact `sha256`; `episode_dir` and `voice_id` are
also explicit. The source episode must pass every narration/timing/audio stage.
This uses already generated and accepted narration; it makes no provider calls.

The original composition, accepted artwork and caption word-index domain stay
immutable. A monotonic map uses exact recognized-word starts from the two takes
of the same approved script, requiring at least 98% exact alignment and no
unmatched span over three words. Only picture/keyframe/caption times move.
Differences and every anchor are retained. The entire replacement master is copied
byte for byte, without trimming, tempo adjustment or second mastering. The old
render stays in place; render the replacement to a distinct output/report path.

A Fal fork may verify a changed baseline source against its own identity-bound
carryforward copy, or an exact narration relock archive listed by the current
baseline identity. Archives must retain the hash-valid previous identity and an
applicable passed relock report. An audio-bed alias may resolve to identical
archived master bytes. No changed byte is accepted, and files outside the locked
baseline cannot use this recovery. The renderer records the resolved immutable
paths so final QA checks actual retained sources rather than superseded pointers.
