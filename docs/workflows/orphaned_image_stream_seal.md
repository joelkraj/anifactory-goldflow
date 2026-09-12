# Seal a confirmed orphaned image stream

When a wavefront append owner has crashed, let independent planning finish and reach the current `image_generation` stage. Pause provider admissions and wait for all existing leases to drain. Preserve provider restrictions. This recovery does not pause, activate, resume or call a provider, and does not launch a planner or change queued work.

Retain a reviewed JSON receipt under the episode's `reports/manual_repairs/` directory:

```json
{
  "schema": "goldflow_orphaned_image_stream_seal_review_v1",
  "status": "reviewed",
  "episode_dir": "/absolute/episode",
  "manifest_path": "/absolute/episode/assets/images/codex_worker_staging/codex-work-ID/work_manifest.json",
  "manifest_id": "codex-work-ID",
  "manifest_sha256": "CURRENT_FILE_SHA256",
  "manifest_content_sha256": "CURRENT_MANIFEST_CONTENT_SHA256",
  "manifest_revision": 132,
  "stream_id": "EXACT_EXISTING_STREAM_ID",
  "source_script_hash": "CURRENT_APPROVED_SCRIPT_CLEAN_SHA256",
  "run_identity_sha256": "CURRENT_IDENTITY_FILE_SHA256",
  "operator_script_approval_sha256": "CURRENT_APPROVAL_FILE_SHA256",
  "script_lock_sha256": "CURRENT_SCRIPT_LOCK_FILE_SHA256",
  "producer": {
    "role": "wavefront_append_owner",
    "pid": 51512,
    "attempt_dir": "/absolute/episode/reports/visual-wavefront/2026-09-12T23-05-30-353Z-51512",
    "hybrid_report_path": "/absolute/episode/reports/visual-wavefront/2026-09-12T23-05-30-353Z-51512/batch_0001/batch_0001.hybrid-pool.json",
    "hybrid_report_sha256": "RETAINED_BATCH_REPORT_SHA256"
  },
  "reviewed_by": "operator or agent reviewer",
  "reviewed_at": "2026-09-13T00:00:00.000Z",
  "reason": "Exact reviewed incident, ended append owner and preserved queue recovery."
}
```

Use only the guarded public entry point, with the reason matching the receipt exactly:

```sh
node bin/goldflow.mjs imagegen codex-work --action seal-orphaned --episode-dir /absolute/episode --manifest /absolute/episode/assets/images/codex_worker_staging/codex-work-ID/work_manifest.json --recovery-receipt /absolute/episode/reports/manual_repairs/review.json --recovery-reason 'Exact reviewed incident, ended append owner and preserved queue recovery.'
```

The original batch report must bind this manifest and stream to the PID-named attempt. Every queued item must retain a passed, hash-current batch plan from that attempt with the same approved script and episode identity. The live process check accepts only `ESRCH`; an alive or unverifiable owner blocks sealing. The check is repeated under the existing manifest lock, together with exact file hashes and zero lease entries (including expired or malformed leases).

The seal changes only stream seal fields, revision and the manifest content hash. It preserves all items, prompts, completed images, pending work, attempts and deadletters, and appends an immutable `stream_sealed` event containing the reviewed receipt hash and validation provenance. It does not claim any separate planner child has ended. After sealing, use normal public pool deactivation/reconciliation and status-directed exact image recovery; sealing itself is not image-generation completion or permission to retry a restricted provider.
