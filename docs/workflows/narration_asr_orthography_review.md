# Exact ASR orthography review

Use this only for a Qwen narration blocked by an opening or final token mismatch when both retained Small and Medium transcripts render the same complete spoken word with different spelling or spacing. It is an editorial reading of two transcripts, not a claim that anyone heard the WAV. Audio edges, omissions, extra words, different lexical words, second attempts and other blocker codes remain blocked.

First inspect `narration_unit_delivery_qa_<episode>.json`, `narration_tts_report_<episode>.json`, the locked spoken unit, both raw ASR texts and the selected WAV hash. Save **byte-identical, immutable episode-local copies** of that report, unit-delivery QA and `narration_provider_output_manifest_<episode>.json` before re-finalization or a retake. Keep the original files in place. The copies must have different paths from their canonical mutable counterparts.

Write `narration_asr_orthography_review_<episode>.json` under the episode with this shape. Every SHA-256 is a *file* hash except where the field explicitly names a canonical plan or spoken text hash.

```json
{
  "schema": "goldflow_narration_asr_orthography_review_v1",
  "status": "reviewed",
  "reviewer_kind": "editorial_text_review",
  "human_listening_performed": false,
  "authorization_origin": "user_authorized_autonomous_asr_qa",
  "reviewer": "<reviewer>",
  "reviewed_at": "<ISO UTC time>",
  "note": "<substantive explanation of the exact text-only decision>",
  "source_script_sha256": "<script_clean.md file SHA-256>",
  "run_identity_file_sha256": "<run_identity.json file SHA-256>",
  "narration_generation_plan_sha256": "<plan_sha256 in the locked plan>",
  "narration_generation_plan_file_sha256": "<narration_generation_plan.json file SHA-256>",
  "narration_quality_contract_sha256": "<identity-locked contract SHA-256>",
  "pre_review_narration_report_path": "<absolute path of the immutable report copy>",
  "pre_review_narration_report_sha256": "<file SHA-256>",
  "pre_review_unit_delivery_qa_path": "<absolute path of the immutable unit-QA copy>",
  "pre_review_unit_delivery_qa_sha256": "<file SHA-256>",
  "pre_review_provider_manifest_path": "<absolute path of the immutable provider-manifest copy>",
  "pre_review_provider_manifest_sha256": "<file SHA-256>",
  "unit_count": 1,
  "units": [
    {
      "unit_id": "<exact current blocked unit ID>",
      "edge": "opening",
      "expected_phrase": "<exact whole word(s) at that edge in the locked spoken text>",
      "observed_phrase": "<same exact whole word(s) in both ASR texts>",
      "relation": "spacing_join",
      "audio_path": "<selected first-take WAV path>",
      "audio_sha256": "<selected WAV SHA-256>",
      "synthesis_identity_sha256": "<selected synthesis identity SHA-256>",
      "intended_text_sha256": "<locked spoken unit SHA-256>",
      "intended_text": "<locked spoken unit>",
      "primary_recognized_text": "<exact retained Small text>",
      "confirmation_recognized_text": "<exact retained Medium text>",
      "reviewed_blocker_codes": ["narration_confirmed_opening_token_mismatch"],
      "review_note": "<specific spelling decision, no listening claim>"
    }
  ]
}
```

`edge` is `opening` or `final`. `relation` is `spacing_join` when letters are identical after removing the reviewed space, or `reviewed_homophone_spelling` for one reviewed word in each version. The latter must also pass the conservative spelling-key and edit-distance guard. The validator checks that replacing only that exact whole-token edge phrase in *each* ASR transcript leaves zero lexical edits against the locked spoken text. It verifies the sole current blocker, first attempt, all archive bindings, current manifest row and actual WAV SHA-256. A spelling-key match alone is never approval.

Rerun `run status` after writing the receipt. Its exact `tts finalize-provider --episode-dir ... --asr-orthography-evidence ...` command re-adjudicates without synthesis and records a warning plus the receipt hash for only reviewed units. Raw transcripts and WAVs remain unchanged. Then build exact retry evidence for the remaining blocked units using the newly blocked report. Later exact retakes automatically reuse the receipt only while every reviewed WAV and locked source binding remains unchanged. If status reports stale evidence, stop and repair the receipt or archive; do not fall back to an unscoped narration command.
