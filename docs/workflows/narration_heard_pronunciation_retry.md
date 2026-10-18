# Explicit heard-pronunciation retake

An operator who actually hears a pronunciation error in an exact selected clip may authorize one unchanged-text retake through the existing guarded `tts narrate` exact-retry route. This exception requires the Qwen batch-cohort route so the replacement carries the original cohort and exact recovery provenance. `evidence_basis: "operator_confirmed_pronunciation"` is an explicit per-invocation exception, not a change to the identity-locked skip/truncation/stutter retry contract. It does not permit automatic retries, phonetic source edits, different voices, or acceptance of the replacement without normal QA and applicable listening review.

Record the actual operator statement, not an inferred listening result. Author an episode-local JSON receipt with these fields:

```json
{
  "schema": "goldflow_confirmed_tts_retry_evidence_v2",
  "evidence_basis": "operator_confirmed_pronunciation",
  "human_listening_performed": true,
  "attestation": "operator_heard_pronunciation_in_exact_selected_audio",
  "operator_quote": "<actual operator statement>",
  "operator_reason": "<substantive reason for this exact one-unit retake>",
  "authorized_by": "<reviewer>",
  "authorized_at": "<ISO UTC timestamp>",
  "maximum_attempts_per_unit": 1,
  "source_script_sha256": "<current source SHA-256>",
  "narration_generation_plan_sha256": "<canonical plan SHA-256>",
  "narration_generation_plan_file_sha256": "<serialized plan file SHA-256>",
  "pre_retry_narration_report_path": "<absolute immutable snapshot path, separate from the canonical report>",
  "pre_retry_narration_report_sha256": "<exact current blocked report SHA-256>",
  "confirmed_units": [{
    "unit_id": "<exact unit ID>",
    "defect_type": "pronunciation",
    "listen_note": "<what the operator heard in this selected clip>",
    "expected_spoken_word": "<one verbatim word from the unchanged spoken unit>",
    "heard_pronunciation": "<distinct pronunciation actually heard>",
    "spoken_text_sha256": "<exact unchanged spoken unit SHA-256>",
    "selected_attempt": 1,
    "audio_sha256": "<selected first-take WAV SHA-256>",
    "synthesis_identity_sha256": "<selected first-take synthesis identity SHA-256>"
  }]
}
```

Exactly one requested ID and one evidence row are allowed. The selected report, current audio, synthesis identity and unchanged spoken word must match. Missing hearing claims, stale hashes, an unsupported defect, broader scope or an already attempted retake stop before synthesis. No ASR-consensus diagnosis is substituted for the human statement. The expected/heard fields document the defect; neither becomes provider input.

Preserve the original blocked reports and audio hashes before recovery. All unrequested units must already have valid accepted selections; unresolved units cannot be silently approved to preserve them. If the operator accepted other blocked clips but rejected this one, materialize those exact mixed review decisions through provider finalization first. The rejected clip stays blocked while the accepted clips become eligible for unchanged preservation.

Then follow the guarded exact-scope command shape from status:

```bash
node bin/goldflow.mjs tts narrate \
  --channel <channel> --series <series> --week <week> --episode <episode> \
  --confirmed-retry-unit-ids <one-exact-ID> \
  --confirmed-retry-evidence <heard-pronunciation-evidence.json>
```

The request uses the original spoken plan, provider, model and voice reference. All other WAVs are hash-verified and retained. The replacement is the second and final permitted take for this unit; a failed replacement requires triage, not a loop. Recovery provenance records `operator_confirmed_pronunciation`, `human_listening_performed: true`, the originating audio/synthesis hashes and the evidence hash. Report policy lists `operator_confirmed_pronunciation_exceptions` and truthfully sets `retry_only_confirmed_skip_truncation_or_stutter: false` for that explicit exception. Required delivery, continuity, boundary, stitch and final-stream checks remain in effect.
