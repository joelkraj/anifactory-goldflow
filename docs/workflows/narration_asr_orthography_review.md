# Exact ASR orthography review

Use this only for a Qwen narration blocked by an opening or final token mismatch when both retained Small and Medium transcripts render the same complete spoken word with different spelling or spacing. It is an editorial reading of two transcripts, not a claim that anyone heard the WAV. Audio edges, omissions, extra words, different lexical words and other blocker codes remain blocked. The v1 receipt below accepts first takes only; the narrowly bound amendment described at the end can review a selected second take after an exact automated retake.

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

## One selected second-take amendment

Only after an exact automated delivery retake has produced and selected a second-take WAV, a separate `goldflow_narration_asr_orthography_amendment_v1` receipt may add **one** unit to an existing v1 receipt. Leave the v1 receipt and its snapshots unchanged. The current blocked report must already record the v1 receipt hash. Archive byte-identical, episode-local copies of the **current** blocked report, delivery QA and passed provider manifest. The second-take unit must have only `narration_confirmed_final_token_mismatch` in both report and QA; any acoustic edge, omission, insertion, differing word or other blocker remains a repair case.

Write `narration_asr_orthography_review_<episode>_v2.json` under the episode. Keep the v1 reviewer/source/identity/plan/quality and `pre_review_*` fields, point `predecessor_evidence_path` and `predecessor_evidence_sha256` to the immutable v1 receipt, and set `unit_count: 1`. Its single row carries the v1 unit text/audio/ASR/blocker fields, plus `selected_attempt: 2`, `runner_report_path`, `runner_report_sha256`, `selected_recovery_provenance_sha256` (the canonical JSON hash of the selected manifest row's recovery provenance), and exactly two `joins`:

```json
[
  {"position":"interior","expected_phrase":"ironjaw","observed_phrase":"iron jaw","relation":"spacing_join"},
  {"position":"final","expected_phrase":"headfirst","observed_phrase":"head first","relation":"spacing_join"}
]
```

The row's top-level `edge: "final"`, `relation: "spacing_join"`, `expected_phrase` and `observed_phrase` name the final join. These example words describe the current narrow case; the validator does not substitute them automatically. It requires the selected WAV bytes and synthesis identity to match the current and archived manifests, the original exact-retake evidence file and passed attempt-two runner to match their stored hashes, and both raw Small and Medium transcripts to become the **entire** locked spoken text after exactly those two unique whole-word spacing joins. The first join must be interior and the second final. A second-take homophone claim or extra lexical difference fails closed.

Rerun status and use only its exact `tts finalize-provider --asr-orthography-evidence <v2 receipt>` command. It performs no synthesis. The amended receipt chains to the v1 review; both reviews remain tied to their selected WAVs. No listening attestation is created. A later exact retake that changes either reviewed WAV invalidates this route.
