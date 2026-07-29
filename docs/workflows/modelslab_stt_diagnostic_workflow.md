# ModelsLab STT Diagnostic Bake-Off

ModelsLab speech-to-text is an opt-in diagnostic candidate in Goldflow. It does
not replace local Whisper, does not satisfy the `local_whisper_word_timing`
stage, and cannot write or promote
`narration_word_timing_<episode>.json`. The run-identity-locked local Whisper
artifact remains the canonical production timing source. The target episode
must already have a valid `run_identity.json`; this diagnostic cannot create a
new episode.

New locked identities require the same-audio baseline to match
`local_whisper_word_timing_v2` exactly: faster-whisper `small.en`, CPU,
`int8_float32`, `OMP_NUM_THREADS=12`, `cpu_threads=0`, English, beam size five,
word timestamps enabled, and VAD disabled. Medium is not an automatic fallback;
it is available only through the production workflow's explicit manual blocker
recovery path. Historical identities without an explicit local-Whisper lock
remain compatible with passed same-audio faster-whisper `medium`, `small`, or
`small.en` artifacts.

Use this path only when an operator wants a same-audio transcription/timestamp
bake-off. It requires both an explicit diagnostic flag and an explicit spend
confirmation:

```bash
node bin/goldflow.mjs audio modelslab-stt-candidate \
  --episode-dir <episode-dir> \
  --provider v6_standard \
  --diagnostic true \
  --confirm-spend true \
  --label v6-word-timing-bakeoff-YYYYMMDDTHHMMSSZ
```

The default `v6_standard` profile calls
`POST https://modelslab.com/api/v6/voice/speech_to_text` with:

- `model_id: "speech-to-text"`
- a public `init_audio` URL
- `language: "en"`
- `timestamp_level: "word"`

The narration report must hash-own the selected audio when its transcript is
used as validation truth. For an explicit `--audio` override, also pass
`--expected-transcript <path>` unless that exact audio hash is already bound by
the report.

The STT endpoint accepts audio from five seconds through one hour per request,
but the reused ModelsLab base64 upload gateway has a separate 5 MB ceiling.
The adapter therefore prepares supported 16 kHz mono 64 kbps MP3 requests,
defaults to 400-second chunks, and refuses chunks over 420 seconds. It also
measures every prepared file before upload and enforces conservative 3.5 MB
source / 4.7 MB base64 limits. Longer audio is split and word timestamps are
merged back onto the source timeline. Chunk overlap is included in submitted
audio seconds and the resulting cost estimate. ModelsLab documents word
timestamps as less reliable than sentence timestamps, so candidate word timing
must be compared against the intended transcript and, for promotion eligibility
evidence, a same-audio local-Whisper artifact.

The separate premium candidate uses ModelsLab v7 `scribe_v1`. It is never the
default and requires an additional premium-cost confirmation:

```bash
node bin/goldflow.mjs audio modelslab-stt-candidate \
  --episode-dir <episode-dir> \
  --provider v7_scribe \
  --diagnostic true \
  --confirm-spend true \
  --confirm-premium-cost true \
  --label v7-scribe-word-timing-bakeoff-YYYYMMDDTHHMMSSZ
```

The v7 candidate records an estimated cost at `$0.001` per submitted audio
second. The v6 adapter does not assert a price when one is not supplied by the
provider documentation.

## Artifacts and validation

Each run is constrained to write under:

`<episode-dir>/review_samples/modelslab_stt/<label>/`

Labels are immutable. A repeated label fails before upload or provider spend;
choose a new label for every bake-off.

The candidate report is bound to the exact source-audio SHA-256 and retains:

- provider profile, model, endpoint, language, timestamp level, and request
  provenance;
- secret-redacted request payloads, upload responses, initial/resolved
  responses, and downloaded result payloads;
- per-chunk audio hashes, request IDs, request latency, provider-reported
  generation time when available, submitted audio seconds, and estimated cost;
- an append-only request-event ledger written before each provider submission,
  plus accepted/ambiguous request and cost bounds in a failure report;
- normalized transcript and source-timeline word timestamps;
- transcript error rate, word-count ratio, timestamp structure checks, and
  optional same-audio local-Whisper timing deltas;
- the canonical timing artifact's before/after hash and an explicit record that
  no promotion occurred.

Deterministic validation requires nonempty, finite, monotonic timestamps within
the source duration and close agreement with the intended narration transcript.
A candidate without a current same-audio local-Whisper baseline may be useful
for listening, but it is not promotion-eligible evidence. Even a passing
candidate cannot promote itself: Goldflow intentionally provides no ModelsLab
production-timing writer. For a locked identity, baseline validation binds the
complete local-Whisper execution contract from `run_identity.json`; the
historical compatibility adapter applies only when that identity has no
explicit lock.

Provider submission is single-attempt. Goldflow does not automatically resubmit
after a timeout or ambiguous provider response because ModelsLab does not
document `track_id` as an idempotency key and a retry could create a second
billable job. Inspect the request-event ledger and provider account before
starting a new labeled run.

The command rejects `--promote`, `--promote-to-production-timing`,
`--replace-production-timing`, `--canonical-output`, `--output-dir`, and
`--report-output`. Transcript/timing acceptance thresholds are fixed and cannot
be loosened by CLI flags. The diagnostic is not part of `run advance`, the
stage registry, or the production command order.

Official provider references:

- [ModelsLab v6 speech-to-text](https://docs.modelslab.com/voice-cloning/speech-to-text)
- [ModelsLab base64-to-URL upload](https://docs.modelslab.com/general-api/base64-to-url)
- [ModelsLab model selection](https://docs.modelslab.com/guides/model-selection)
