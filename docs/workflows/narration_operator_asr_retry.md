# Explicit operator ASR-consensus retake

For an error actually heard by the operator, use the separate [heard-pronunciation exception](narration_heard_pronunciation_retry.md). Do not describe a listening decision as an ASR-only authorization.

When the operator explicitly waives listening and authorizes a bounded retake, the existing `tts narrate` exact-retry route accepts `evidence_basis: "operator_authorized_asr_consensus"`. This is a per-invocation exception to the identity's usual heard skip/truncation/stutter repair rule, not a changed identity, listening approval, automatic retry or ASR-blocker waiver. Existing heard-evidence behavior remains unchanged.

The evidence JSON uses schema `goldflow_confirmed_tts_retry_evidence_v2` and requires:

- `evidence_basis: "operator_authorized_asr_consensus"`, `human_listening_performed: false`, `maximum_attempts_per_unit: 1`; no listening `attestation`.
- The actual `operator_quote`, a substantive `operator_reason`, `authorized_by` and ISO `authorized_at`.
- Exact `source_script_sha256`, canonical `narration_generation_plan_sha256`, serialized `narration_generation_plan_file_sha256` and `pre_retry_narration_report_sha256`.
- `confirmed_units` must cover exactly the requested IDs once. Each row has `unit_id`, `defect_type`, `evidence_note` (no listening claim), `selected_attempt: 1`, `audio_sha256`, `synthesis_identity_sha256`, `reviewed_blocker_codes` and `selected_delivery_qa_sha256`. Compute the last hash with `canonicalQwenBatchSha256` over the selected report row's `selected_qa.delivery` object.

Only two independently confirmed Small/Medium delivery cases are admitted: `unexpected_words` requires `narration_confirmed_unexpected_word`; `truncation` requires `narration_confirmed_final_word_missing`, optionally accompanied by `narration_confirmed_word_omission`. Every reviewed blocker must exactly match the current blocked report and selected delivery evidence. Unconfirmed differences, another defect type, a changed source/report/take, or a take that already used its second attempt stop before synthesis.

After recording the real operator authorization, run the guarded command with the exact reviewed IDs:

```bash
node bin/goldflow.mjs tts narrate \
  --channel <channel> --series <series> --week <week> --episode <episode> \
  --confirmed-retry-unit-ids <exact-ids> \
  --confirmed-retry-evidence <evidence.json>
```

The command retains unaffected WAVs, submits only the exact requested first takes once, and reruns required delivery/end-boundary QA. Provenance says `operator_authorized_asr_consensus`, with `human_listening_performed: false`; report policy lists the explicit exception. An independently authorized review-warning/subjective-listening waiver is separate and does not waive ASR blockers.
