# Reviewed prompt correction after a rejected orphan download

This opt-in applies only to a first-attempt scene download that was actually
reviewed and rejected, whose original lease is closed with a
`lease_expired_max_attempts` deadletter and no completion receipt. It bridges
the preserved original source row to an explicitly reviewed anatomy/staging
correction. It does not import the rejected image, change provider policy,
reclassify a submitted attempt as a first candidate, or approve image QA.

Keep an immutable, episode-local receipt with schema
`goldflow_reviewed_orphan_prompt_patch_v1`, `status: approved`, exact
`episode_dir`/`image_id`, reviewer/time and substantive reason. Include:

- `source_script_sha256` and `current_source_row_sha256`.
- Hash-bound `{path, sha256}` records named `identity`, `approval`, `lock`,
  `current_raw`, `current_hardened`, `before_raw`, `before_hardened`,
  `manifest`, `assignment`, `deadletter`, `rejected_raster`,
  `rejected_candidate_review`, `application` and `proposal`.
- The existing `goldflow_manual_failed_image_candidate_review_v1` review
  must truthfully bind the original submitted job/download, preserved raster,
  original assignment/source row and actual visual rejection.
- The existing `goldflow_reviewed_manual_scene_prompt_repair_v1`
  application and its exact before/after proposal must replay to the current
  raw plan. The hardener may synchronize only the derived provider mirror.
  Every other row, narration, timing, reference and overlay remains unchanged.

The patch permits only provider/image prose and their hash, anatomical hand
invariants, equipment hand assignment, character pose/screen position and
object geography. It does not permit narration, timing, reference selection,
overlay copy or other source metadata changes. It requires the same ordered
reference IDs, paths and bytes as the rejected attempt.

Explicitly select that receipt in
`reviewed_orphan_prompt_repairs_<episode>.json`:

```json
{
  "schema": "goldflow_reviewed_orphan_prompt_repair_index_v1",
  "status": "approved",
  "entries": [{
    "image_id": "exact_cut_id",
    "receipt_path": "/absolute/episode/reports/manual_repairs/immutable-receipt.json",
    "receipt_sha256": "<SHA-256 of that approved receipt>"
  }]
}
```

Reread public run status, then use the existing exact command:
`goldflow imagegen browser-pool --episode-dir <episode-dir> --image-ids <exact-id> --repair-reason "<reviewed defect and correction>"`.
Do not use `--qa-recovery` for this unmaterialized rejected download. Current
stage, identity, provider restrictions and scheduling gates still apply.

The receipt authorizes one later candidate under the corrected row. A current
materialized image, live original lease, original completion or prior attempt
under the corrected row rejects it. A later actual provider failure under that
same corrected row continues through the existing ordinary deadletter route.
No index or no matching entry preserves historical behavior; the existing
content-policy-rejection branch is unchanged. Index and aggregate hashes are
checked during admission but are not retained as provider input dependencies,
so later imports or index additions cannot invalidate accepted repair evidence.
