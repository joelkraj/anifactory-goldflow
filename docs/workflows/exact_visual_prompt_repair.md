# Exact visual prompt correction before hardening

Use this optional route only when `visual_prompt_plan` passed and the next
stage is the still-missing `visual_prompt_harden`. It fixes one reviewed cut's
prompt wording without another planner or provider call. It cannot change the
cut's image or beat ID, timing, narration, references, state, manifest,
overlays, provider route, or other cuts. Review the source beat and all attached
reference scopes before writing the replacement. The subsequent normal
`visual harden` command remains the structural and continuity gate.

Run `goldflow run status` first. Write a JSON spec outside the canonical plan:

```json
{
  "schema": "goldflow_visual_prompt_exact_repair_v1",
  "episode": "ep_01",
  "expected": {
    "run_identity_sha256": "<SHA-256 of run_identity.json>",
    "source_script_sha256": "<SHA-256 of script_clean.md>",
    "visual_beat_plan_sha256": "<SHA-256 of visual_beat_plan.json>",
    "visual_reference_plan_sha256": "<SHA-256 of visual_reference_plan.json>",
    "reference_plan_approval_sha256": "<SHA-256 of reference_plan_approval.json>",
    "reference_image_approval_sha256": "<SHA-256 of visual_reference_approval_ep_01.json>",
    "prompt_plan_sha256": "<SHA-256 of section_image_prompts.json>"
  },
  "image_id": "<one exact image_id>",
  "visual_beat_id": "<that row's visual_beat_id>",
  "old_row_sha256": "<SHA-256 of JSON.stringify(row, null, 2) plus newline>",
  "replacement": {
    "provider_prompt": "<complete corrected prompt>",
    "image_prompt": "<identical complete corrected prompt>"
  },
  "reviewer": "<reviewer>",
  "note": "<specific defect and source-supported correction>",
  "scope_reviewed": true
}
```

Then execute `node bin/goldflow.mjs visual repair-prompt --episode-dir
<episode-dir> --repair-spec <reviewed-json>`. The command checks the current
status, every expected hash, the original row hash, all current source
bindings and the unchanged in-scope reference IDs. It refuses a previously
started harden, transition, or image stage. An append-only receipt and the
complete original prompt plan are saved under
`reports/stages/visual_prompt_plan/exact_repairs/<id>/` before the corrected
plan replaces the canonical file. The changed plan hash becomes the normal
downstream provenance input. Rerun status and execute its next command.

This route requires one canonical prompt variant. If the row has divergent
provider-specific prompt text, use the existing scoped visual review instead.
Do not use it after image dispatch or for a structural/ref change.
