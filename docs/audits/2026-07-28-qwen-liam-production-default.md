# Qwen/Liam production narration decision

Date: 2026-07-28

## Decision

Goldflow's standard narrator is local Qwen3-TTS 1.7B Base conditioned by the
exact pinned Liam reference audio and transcript.

- Model: `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit`
- Model revision: `e7dd0585652209fa0d7783659aad4e8a324de11c`
- Voice mode: Base-model reference-audio ICL
- Narrator identity: Liam reference clone
- Unit shape: sentence-complete, target 45-60 spoken words, hard maximum 60
- Join: 80 ms at every selected-unit boundary
- Continuous longform requests: forbidden
- Native-speed control: unsupported and not applied
- Post-TTS tempo processing: forbidden
- Automatic alternate voice/provider fallback: none

Every first take and retry must use the same model, revision, runtime, Liam
reference audio, Liam reference transcript, and exact spoken-text hash. Puck,
Fenrir, and Puck-cloned Qwen are historical bake-off or legacy-run
compatibility routes, not current production fallbacks.

## Pinned Liam reference

- Audio:
  `/Users/joel/AniFactoryData/voice_bank/proofs/2026-07-27-qwen-liam-clone-delivery-v1/liam_reference/liam_clone_reference.wav`
- Audio SHA-256:
  `6200eb0dcc2d5f9c9d0ab52a2532d033a3db126e9d1570e78d4463cc282ee0af`
- Transcript SHA-256:
  `2630f1d234dd38762cf538ee7b817026711f2c9642a26dd3678242647e5a720c`
- Duration: 12.875 seconds at 24 kHz
- Reference source voice hash:
  `66b65a96e16c3d91035a6e9019d9986ed524d27ce35b487270cdf61c99e3ebad`

The reference is a fixed conditioning asset. Its generation provenance remains
recorded, but production narration is synthesized by Qwen Base, not by the
reference source model.

## Listening proof

The operator compared Kokoro Liam with Qwen's Liam-reference clone on the same
144-word passage. The unitized Qwen proof used sentence-complete units of 52,
55, and 37 words, 80 ms joins, and no tempo or loudness processing. It measured
41.040 seconds, approximately 210.5 WPM.

All Qwen unit outputs passed the proof's Liam speaker-similarity floor, with
WeSpeaker cosine scores from `0.887995` to `0.915026`. Scores near the warning
floor remain useful spot-listen evidence; they are not retry orders by
themselves.

Medium Whisper reported one apparent missing word, `deedholder`, but the
operator confirmed that the audio contained it. That is direct evidence that an
isolated ASR omission must remain warning-only until listening confirms an
audible defect.

The continuous Qwen request produced a real tail stutter around 41 seconds. The
unitized version rendered the same ending cleanly. This is why production never
sends continuous longform requests.

Proof artifacts:

- Review:
  `/Users/joel/AniFactoryData/voice_bank/proofs/2026-07-27-qwen-liam-clone-delivery-v1/REVIEW.md`
- Qwen run:
  `/Users/joel/AniFactoryData/voice_bank/proofs/2026-07-27-qwen-liam-clone-delivery-v1/qwen_liam_clone/run.json`
- Unit stitch:
  `/Users/joel/AniFactoryData/voice_bank/proofs/2026-07-27-qwen-liam-clone-delivery-v1/qwen_liam_clone/qwen_liam_clone_large_unit_stitch.wav`
- Unit-stitch SHA-256:
  `638f62b99ead731c5c360ec0cee9884635505ca6a35751dbc72fb71d2bfe2b27`

## Production QA and retry policy

1. Preserve the approved script exactly while keeping captions, source text,
   and TTS-only spoken text separate.
2. Form sentence-complete source-bound units targeting 45-60 spoken words with
   a hard maximum of 60. Shorter system/UI, dialogue, performance, speaker, SFX,
   explicit-merge, and segment-barrier units stay atomic.
3. Synthesize units sequentially with the resident Qwen model and the exact
   Liam conditioning hashes. Never synthesize the episode as one long request.
4. Run waveform QA and ASR for evidence on every unit.
5. Retry an exact unit only when listening confirms a skip, truncation, or
   stutter. A synthesis failure, empty output, or objectively too-short output
   counts as confirmed truncation and may receive one automatic same-identity
   retry. Other acoustic or voice-identity blockers stop for review rather
   than triggering a blind retry.
6. Treat isolated ASR deletions, substitutions, low-confidence words, aggregate
   WER, and low-margin speaker-similarity warnings as review signals only. They
   do not authorize an automatic retry.
7. Bind human retry evidence to the exact pre-retry narration-report hash,
   selected attempt, audio SHA-256, and synthesis-identity SHA-256.
8. Repair a confirmed pronunciation problem through the narrowest TTS-only
   spoken-text override, then regenerate only that exact unit with the same
   Qwen/Liam identity. Never leak the pronunciation spelling into captions.
9. Apply 8 ms edge fades and exactly 80 ms at every selected-unit join,
   including source-segment boundaries.
10. Validate exact unit order, hashes, opening/final retention, audible joins,
   and the final stitched stream before local Whisper timing.
11. Do not apply native-speed or post-TTS tempo processing. If cadence needs to
    change, approve a new bounded listening proof and synthesis contract.

## Superseded decision

`docs/audits/2026-07-27-puck-production-default.md` documents the preceding
Puck-first policy for historical compatibility. It no longer defines new
production behavior.
