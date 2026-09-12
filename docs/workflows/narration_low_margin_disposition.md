# Exact passing low-margin voice disposition

This optional operator policy refinement reduces redundant exact-unit listening for specifically named speaker measurements that pass the unchanged calibrated minimum. It is not a bug correction, listening approval, voice promotion, or permission to regenerate audio. The default still requires every low-margin review.

After inspecting the current provider and similarity reports, run:

```sh
node bin/goldflow.mjs tts low-margin-disposition --episode-dir <episode-dir> --unit-ids-file <exact-unit-ids.json> --reviewer <name> --reason "<substantive reason for this exact passing low-margin scope>"
```

The ID file must be a JSON array of exact unit IDs; `--unit-ids id1,id2` is also supported. No automatic all-unit selection is provided. The immutable `narration_low_margin_disposition_<episode>.json` binds the source, run identity, canonical and file plan hashes, provider manifest, raw speaker report, exact WAV hashes and scores. It requires the complete current candidate/reference identity, finite scores at or above the unchanged calibrated minimum and below its warning boundary, and a passed aggregate. Below-floor, unknown, stale and duplicate IDs fail closed. The reason must contain at least 40 characters.

Only `narration_voice_similarity_low_margin` becomes advisory for those IDs. Raw measurements and reports remain unchanged. Every other warning on the same units, all below-minimum scores, missing identity/coverage, tail/endpoint and ASR/join checks remain under their original requirements. The mandatory hash-bound subjective opening, source chapters, system/pronunciation, midpoint, climax and final-minute sample review remains required. The receipt explicitly records that no listening was performed and no synthesis is authorized.

Run status after recording the receipt. If a finalizer was already running, let it exit; do not start a second worker. Then use the guarded `tts finalize-provider --episode-dir <episode-dir>` shape supplied by status. It recomputes decisions from retained waveform, speaker and Small/Medium checkpoints and preserves accepted WAVs. The receipt is bound into the derived QA and TTS report; adding, changing or removing it invalidates prior review provenance. Any changed exact-listen packet needs its own actual listening decision. This command does not use the broad `--accept-review-warnings` waiver, change the locked quality contract, or claim that a representative sample proves every clip was heard.
