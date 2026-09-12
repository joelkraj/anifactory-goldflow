# Exact reference-image QA recovery

After genuine visual review and after active generation has finished, record `reference_image_qa_<episode>.json`. Preserve the reviewed rasters, provider receipts, and prior plan before a manual repair. This report authorizes only later exact-ID replacements; it is not reference-image approval.

```json
{
  "schema": "goldflow_reference_image_qa_v1",
  "status": "blocked",
  "source_script_hash": "<current approved script SHA-256>",
  "reference_plan_contract_sha256": "<current referencePlanApprovalContractSha256(plan)>",
  "reviewed_by": "codex-agent",
  "reviewed_at": "<actual ISO timestamp>",
  "reviewed_blocker_ids": ["exact_ref_id"],
  "findings": [{
    "severity": "blocker",
    "ref_id": "exact_ref_id",
    "code": "confirmed_identity_mismatch",
    "review_note": "<actual visual evidence>",
    "image_path": "<absolute current rejected raster path>",
    "image_sha256": "<exact rejected raster SHA-256>"
  }]
}
```

Any reviewed prompt/dependency correction must retain selections and scopes, preserve prior evidence, and receive current reference-plan approval before generation. Bind the QA report to that current creative contract while identifying the rejected raster bytes that are still materialized.

Status exposes only still-current rejected IDs after ordinary missing-file and duplicate-hash checks. Run its `imagegen browser-pool` tuple command with `--references-only true --reference-ids <exact-ids> --qa-recovery true --repair-reason "<reviewed evidence>"`. A nonempty subset is valid; every requested ID must remain current and all unrequested references remain untouched. No force flag or workflow bypass is needed.

Stale source/plan reports cannot authorize repair. Findings whose raster path or hash changed are retired from current repair scope without editing their historical report or rejecting the replacement. Reference-image approval remains separate and requires actual review. The pool retains its report hash, exact-scope manifest, provider receipt, input-reference hash, and output checks.
