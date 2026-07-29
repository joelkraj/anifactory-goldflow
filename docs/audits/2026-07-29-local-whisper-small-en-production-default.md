# Local Whisper `small.en` production default

Date: 2026-07-29

## Decision

New Goldflow production identities use the exact configuration measured in the
20-minute Human Shield soak:

- engine: `faster_whisper`
- model: `small.en`
- device: `cpu`
- compute type: `int8_float32`
- `OMP_NUM_THREADS=12`
- `WhisperModel(cpu_threads=0)` (CTranslate2 automatic thread argument)
- language: English
- beam size: five
- word timestamps: enabled
- VAD: disabled

The production contract deliberately does not use the unmeasured
`WhisperModel(cpu_threads=12)` variant.

## Evidence

On the exact first 1,200 seconds of the current production narration,
`small.en` completed in 165.032 seconds (RTF 0.137526), peaked at 2.663 GB RSS,
and averaged 12.165 CPU cores. Intended-transcript WER was 0.3705%, compared
with 0.9956% for the existing medium reference. Adjudication found no genuine
missing, duplicate, or reordered word event. Timestamp drift against medium was
80 ms median, 140 ms p95, 210 ms p99, and 370 ms maximum.

The soak emitted 48 zero-duration word rows (1.109%). They are preserved as
warning-only review evidence because ordering, transcript coverage, and
surrounding timing remained valid.

## Compatibility and recovery

The current Human Shield episode is not relocked or regenerated. Its existing
passed medium timing report and all older run identities without an explicit
local-Whisper lock remain valid.

For an older identity whose timing is genuinely missing, the guarded command
uses the new `small.en` default. Goldflow never retries or falls back to medium
automatically. Medium is available only through explicit, hash-bound manual
structural recovery after blocker review.
