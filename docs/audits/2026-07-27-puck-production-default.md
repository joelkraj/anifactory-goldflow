# Historical Puck production narration decision

Date: 2026-07-27

> Historical compatibility record. This policy was superseded on 2026-07-28 by
> local Qwen3-TTS 1.7B Base with the exact Liam reference clone. Nothing below
> defines the current default. See
> `docs/audits/2026-07-28-qwen-liam-production-default.md`.

## Decision at the time

Goldflow's standard narrator at the time was the exact pinned Kokoro `am_puck`
preset at native speed `1.2`.

- Puck was the sole production narrator identity. `am_fenrir` remained a
  bakeoff-only comparison and could not be selected by production preflight or
  used as an automatic fallback.
- `am_michael` was rejected for production.
- Local Qwen3-TTS 1.7B Base 8-bit was a failed-unit fallback only. It had to receive
  the identical spoken-text hash and the pinned Puck-generated reference
  audio/transcript so it clones Puck rather than introducing another narrator
  identity. It never replaced a whole episode automatically.
- Existing legacy Qwen identities remained readable and resumable, while
  preflights created under this historical policy selected Puck.

This decision weighted the operator's actual listening preference above the
machine-only reliability index. The operator heard Puck as fast, clean, coherent,
and free of audible clicks in the proof.

## Audited Puck proof

The bounded proof used seventeen real Goblin Queen production-derived narration
units:

| Measurement | Result |
| --- | ---: |
| Final duration | 179.227 seconds |
| Intended words | 722 |
| Delivered pace | 242.375 WPM |
| Generation throughput | 11.73x realtime |
| Unit blockers | 0 |
| Retry or edge-repair units | 0 |
| Joins | 16 passed |
| Full-stream medium-Whisper WER | 1.105% |
| Opening/final-token loss | 0 |

Proof artifacts:

- `/Users/joel/AniFactoryData/voice_bank/proofs/2026-07-26-five-model-3min-v1/kokoro_bf16_am_puck/proof_report.json`
- `/Users/joel/AniFactoryData/voice_bank/proofs/2026-07-26-five-model-3min-v1/kokoro_bf16_am_puck/full_stream_medium_qa.json`
- `/Users/joel/AniFactoryData/voice_bank/proofs/2026-07-26-five-model-3min-v1/kokoro_bf16_am_puck/kokoro_bf16_am_puck_3min_proof.m4a`

The proof's 242.375 WPM is retained as a diagnostic. The operator judged the
delivery speed correct, so it does not trigger tempo processing or automatic
regeneration.

## Historical Puck-cloned Qwen fallback reference

Qwen's exact-unit fallback was locked to a byte-identical copy of audited Puck
proof unit `stp_voice_seg_10_5_2630f1d234dd`:

- audio: `/Users/joel/AniFactoryData/voice_bank/kokoro/reference_samples/am_puck/am_puck_qwen_fallback_reference_v1.wav`
- audio SHA-256: `934de29bed0d3da6b8c8fb2a6c611202a967498422702f8c30f85b4bb10019d0`
- transcript SHA-256: `2630f1d234dd38762cf538ee7b817026711f2c9642a26dd3678242647e5a720c`
- manifest: `/Users/joel/AniFactoryData/voice_bank/kokoro/reference_samples/am_puck/am_puck_qwen_fallback_reference_v1.json`
- manifest SHA-256: `e51394242bdac5e604e629ac1a575673fb4f857a15dd32317aeeee59bddb9955`

The adjacent JSON metadata and text file preserve the source-unit and transcript
provenance. The previous Joel microphone reference is not part of the current
generic narration fallback lock.

### Voice-continuity calibration

The historical production speaker gate was calibrated on the same seventeen passages:

| Candidate family | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: |
| Native Puck | 0.9134 | 0.9687 | 1.0000 |
| Qwen with the Puck reference | 0.8885 | 0.9267 | 0.9432 |
| Fenrir | 0.8021 | 0.8460 | 0.8634 |
| Michael | 0.4386 | 0.4832 | 0.5176 |

The hard cosine floor is `0.88`: all seventeen Puck-referenced Qwen candidates
passed, while no Fenrir or Michael candidate passed. Scores from `0.88` through
`0.90` retain a visible `review_required` warning. Speaker similarity never
overrides waveform or exact-transcript QA.

- calibration:
  `/Users/joel/AniFactoryData/voice_bank/kokoro/reference_samples/am_puck/am_puck_qwen_fallback_similarity_calibration_v1.json`
- calibration SHA-256:
  `f71deace6283c58cc28564e3a40772f907d8fb1040d3d6bbe3a9b1dc3f53bb55`

## Historical Puck controls added after the proof

That production route was stricter than the listening proof:

1. Preserve exact locked-script coverage while keeping caption, source, and
   TTS-only spoken text separate.
2. Group only adjacent same-speaker narration into stable 24-50-word units, with
   a hard merge cap of 60 words. System/UI, dialogue, performance turns,
   overrides, source gaps, and segment boundaries remain atomic.
3. Synthesize sequentially with the pinned model, voice, runtime, revision, and
   asset hashes.
4. Retry a blocked unit once with Puck, then try Qwen only for that unresolved
   exact unit.
5. Run waveform and small-Whisper QA per candidate. Any transcript discrepancy,
   protected value, or system/UI unit requires medium-Whisper adjudication.
6. Reject confirmed omissions, insertions, substitutions, repetitions, clipping,
   severe impulses, unexplained active noise, and unsafe endpoints.
7. For every Qwen repair, verify the exact pinned Puck reference and speaker
   model hashes, then reject similarity below `0.88` and flag the `0.88-0.90`
   warning band for spot-listening.
8. Stitch only selected passing units, retaining 50 ms of verified edge silence,
   applying 8 ms fades, and using 80 ms intra-segment or 160 ms inter-segment
   gaps.
9. Require passing join QA, exact unit order, and a medium-Whisper full-stream
   transcript check before Goldflow considers narration complete.
10. Bind every plan, selected unit, fallback, QA report, stitch, and final audio
   file by path and SHA-256 so stale or tampered artifacts cannot satisfy the
   stage.

Kokoro has no instruction channel. Puck's delivery therefore comes from the
approved prose, punctuation, careful unit boundaries, fixed voice, and native
speed—not from unsubmitted style directions. The locked Qwen Base fallback also
uses reference-audio ICL only; it must report
`base_icl_reference_audio_only`.

Automated QA reduces detectable skips, stutters, noise, and bad joins, but does
not replace the required final human spot-listen.
