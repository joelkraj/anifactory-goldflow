# Exact scene repairs while generation is incomplete

An actual inspected story/identity-critical or structural image failure may be repaired before every episode image exists. This narrow recovery requires `image_generation` to be the first unfinished stage, with every earlier gate current. It does not approve partial QA or advance the episode to final image QA.

Preserve the original raster, provider receipts, reviewed prompt changes and QA evidence. Record the following canonical `image_output_qa_<episode>.json` only after actual visual review. Bind the corrected current `section_image_prompts_hardened.json` and its rows separately from the rejected raster bytes that are still materialized in `imagegen_report_<episode>.json`.

```json
{
  "schema": "goldflow_partial_scene_image_qa_v1",
  "status": "blocked",
  "scope": "partial",
  "source_script_hash": "<current script_clean.md SHA-256>",
  "run_identity_sha256": "<current run_identity.json SHA-256>",
  "operator_script_approval_sha256": "<current operator_script_approval.json SHA-256>",
  "script_lock_sha256": "<current script_lock.json SHA-256>",
  "prompts_sha256": "<current section_image_prompts_hardened.json SHA-256>",
  "reviewed_by": "codex-agent",
  "reviewed_at": "<actual ISO timestamp>",
  "reviewed_blocker_ids": ["exact_cut_id"],
  "findings": [{
    "severity": "blocker",
    "image_id": "exact_cut_id",
    "code": "confirmed_identity_mismatch",
    "review_note": "<substantive actual visual evidence>",
    "image_path": "<absolute current rejected raster path>",
    "image_sha256": "<exact rejected raster SHA-256>",
    "source_row_sha256": "<codexWorkSourceRowSha256(corrected current prompt row)>"
  }]
}
```

After rereading status, use `goldflow imagegen browser-pool --episode-dir <absolute-dir> --image-ids <exact-reviewed-ids> --qa-recovery true --repair-reason "<substantive reviewed evidence>"`. A complete matching channel/week/episode tuple is also supported. Either `--gemini-only true` or `--flow-only true` is allowed only when the selected provider and its model are already part of the locked federated identity; the selectors are mutually exclusive and do not change the identity, models, scheduling or provider restriction state. Default provider routing is unchanged. No override, force, alternate plan, model, output, concurrency, migration, health-skip or workflow-bypass flags enter this admission.

A nonempty subset of still-current rejected IDs is valid. An old finding whose raster path or hash has changed cannot authorize another take and does not block repair of other unchanged findings. First-candidate missing images are excluded from QA recovery. The browser pool rechecks the same exact evidence before creating the ordinary one-attempt repair manifest and retains the reviewed report hash. Full image materialization, official focal analysis, complete image QA and final approval remain required.
