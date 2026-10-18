# Exact full-stream delivery review

Use this recovery only after inspecting a current blocked full-stream report. It accepts a human decision about each remaining, window-backed delivery finding without a broad ASR waiver. It does not approve unreviewed audio or authorize synthesis, text changes, a retake, or a new master.

First refresh derived QA separately if its comparison or consensus version changed, retaining exact audio and ASR evidence. Preserve an immutable copy of the resulting `narration_full_stream_qa_<episode>.json`; its file SHA-256 must equal the current canonical report when review is applied. A receipt for an earlier blocker set is stale even when the audio did not change.

The normal guarded continuation is:

```text
node bin/goldflow.mjs tts finalize-provider --episode-dir <episode-dir> --full-stream-review-evidence <absolute-review-json> --manual-review-evidence <existing-unit-review-json>
```

Include `--manual-review-evidence` only when the prior report names existing unit evidence, using that same path and unchanged bytes. Preserve any separately authorized existing advisory/subjective-review flags and their reason; this new flag adds no authorization for those flags. It cannot combine with `--accept-asr-delivery-blockers` and is unavailable in pilot finalization. The workflow guard remains active. Retained unit/full-stream ASR, stitch, master and encode are required; a missing or stale retained dependency requires separate triage, not rebuilding under this flag.

## Review artifact

Schema: `goldflow_narration_full_stream_manual_review_v1`. Preparation is not approval: leave `status: "prepared_not_reviewed"`, human fields unset and decisions pending until the named human actually hears the affected passages. The validator accepts only the following completed contract:

- `status: "reviewed"`, `reviewer_kind: "human"`, a nonempty `reviewer`, ISO `reviewed_at`, and `note`.
- `attestation: "human_listened_to_each_bound_affected_passage_and_individually_decided"`. This attests only the bound affected passages, not the entire narration or necessarily the whole confirmation window.
- `prior_full_stream_qa_path` and `prior_full_stream_qa_sha256`, naming the immutable report snapshot, distinct from the canonical output path.
- Copy these exact fields from that report: `source_script_hash`, `narration_generation_plan_sha256`, `narration_generation_plan_file_sha256`, `narration_quality_contract_sha256`, `audio_path`, `audio_sha256`, `intended_text_sha256`, `transcript_comparison_version`, and `delivery_consensus_version`.
- `provider_output_manifest_file_sha256`: SHA-256 of the current provider output manifest file.
- `scope`: the unchanged result of `fullStreamReviewScope(report)`, exported from `scripts/lib/narration-full-stream-manual-review.mjs`. It binds every current blocker, finding SHA, exact unit/boundary scope, confirmation-window path/hash/binding, source master hash, sample bounds and intended-text hash. This helper only constructs scope; it does not listen or approve.
- `decisions`: exactly one row for each `scope[].finding_sha256`, with no omissions, duplicates or additions.

Each decision row has:

```json
{
  "finding_sha256": "<exact scope finding SHA-256>",
  "decision": "accept",
  "human_listened": true,
  "affected_passage_complete": true,
  "intended_passage_text": "<exact contiguous span of the window's intended text>",
  "listen_note": "<the human's actual decision and observations>",
  "listened_audio": {
    "path": "<absolute file actually heard>",
    "sha256": "<SHA-256 of that file>",
    "source_window_id": "<exact window id>",
    "source_window_sha256": "<exact window WAV SHA-256>",
    "start_sample_in_window": 0,
    "end_sample_in_window": 48000
  }
}
```

`decision` is `accept` or `reject`. Never fill human booleans or acceptance from ASR, waveform inspection, clip preparation, or agent inference. The affected-passage completeness field is the human/recording attestation that the reviewed passage covers the finding; a file hash alone cannot establish that judgment.

Whole-window playback uses the exact window audio hash and `[0, sample_count)` bounds. For a short MP3 excerpt, also set `listened_audio.encoding: "ffmpeg_libmp3lame_q2_v1"`. Its exact supported recipe is:

```text
ffmpeg -i <bound-window.wav> -af atrim=start_sample=<start>:end_sample=<end>,asetpts=PTS-STARTPTS -c:a libmp3lame -q:a 2 <clip.mp3>
```

The validator first recomputes the confirmation-window binding and verifies its decoded PCM against the exact current master sample range. It then reproduces the excerpt encoding in a temporary directory and requires byte-identical SHA-256, deleting the temporary file afterward. This authenticates the existing file actually heard; it never substitutes a newly encoded file or claims the human heard it. A different encoder build/recipe may fail closed and requires triage. Source window sample rates and bounds govern the excerpt; seconds are not the receipt's timing unit.

## Result and preservation

Acceptance moves only exact reviewed blockers to warnings, preserving their original code and severity plus the review hash. Rejection retains the blocker and marks the result blocked, with `synthesis_authorized: false`. Neither decision authorizes an automatic retry. Structural/order/join/media errors cannot be accepted by this delivery review.

The finalizer records separate `full_stream_manual_review` provenance in the full-stream QA, TTS report, stitch report and checkpoint. Existing unit review records, source text, provider manifest and WAVs remain independent and unchanged. `run status` revalidates evidence, original report, listened media, exact replayed decisions/windows and current provider provenance; missing or changed evidence invalidates the reviewed result. A subsequent changed blocker/window set requires new scoped review, never automatic inheritance.

Validation: `node scripts/tests/narration-full-stream-manual-review-tests.mjs` covers acceptance/rejection, exact scopes, old unit-review preservation, stale hashes/versions, missing or duplicate decisions, unreviewed window findings, altered applied results, unrelated/shifted clips, reproducible MP3 excerpts and incompatible flags.
