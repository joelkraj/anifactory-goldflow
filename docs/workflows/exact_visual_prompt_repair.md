# Exact visual prompt correction before hardening

Use this optional route only when `visual_prompt_plan` passed and the next
stage is the still-missing `visual_prompt_harden`. It fixes one reviewed cut's
prompt and contradictory prose metadata without another planner or provider
call. The route cannot change the cut's image or beat ID, timing, narration,
visible cast, location contract, character/reference roles, overlay identities or placement,
provider route, or
other cuts. Review the source beat and all attached reference scopes before
writing the replacement. The subsequent normal
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

If the defect also affects structured metadata, `replacement` may include a
`staging_patch` targeting one exact character name with reviewed
`{ "before": "...", "to": "..." }` pairs for `wardrobe_from`, `pose`, or
`screen_position`. Use `staging_patches` for multiple distinct characters in
one cut; do not supply singular and plural forms together.
`manifest_text_patch` may correct `foreground_action` and
`continuity_notes`; `depth_background_plane` corrects one exact depth candidate
description when the physical background changes. `reference_text_patch` binds one already-attached `ref_id`
and may correct its `slot_purpose` or `reason` in the requirement and matching
manifest slot. `anatomy_contract_patch` binds one exact `entity` and
`identity_ref_id` and may correct `body_invariant` or `reason`. Use
`anatomy_contract_patches` for multiple distinct entity/reference pairs in
one cut. Add
`assert_absent_terms` to fail if rejected wording remains anywhere in the
corrected row. All prose patches require exact before/after text; no ID, role,
reference set, timing or other row may change.

For a source-inconsistent on-image amount, one existing overlay's `text` and
optionally its `information_delta` may be corrected with
`narrative_overlay_patch: { "index": 0, "before": "<exact old text>",
"old_overlay_sha256": "<SHA-256 of JSON.stringify(the overlay, null, 2) plus newline>",
"to": "<exact new text>", "information_delta": { "before": "<exact old delta>",
"to": "<reviewed new delta>" }, "source_quotes": ["<exact source quote>"] }`.
Every quote must occur in the hash-bound source script, and at least one must
occur in that cut's approved beat excerpt. Include all quotes needed to support
the correction, such as both the purchase amount and the return rule. The new
overlay text must also appear exactly in the corrected provider/image prompt.
For a matching `shot_manifest.ui_elements` string, use
`ui_element_patch: { "index": 1, "before": "<exact old label>",
"to": "<exact new label>" }`. Up to four distinct indexed strings may instead
use `ui_element_patches: [...]`; do not provide both singular and plural forms.
The new labels must appear exactly in the corrected provider/image prompt.
When no overlay changes, add `ui_element_source_quotes: ["<exact source quote>"]`.
Every quote must occur in the hash-bound script, and at least one must occur in
the selected beat excerpt. This permits a UI-only correction without changing
the number or order of UI elements. When an overlay changes, its own
`source_quotes` supply that evidence and `ui_element_source_quotes` is omitted.
Use `manifest_text_patch` for any contradictory foreground action or continuity
prose in that same cut. The command preserves the other overlay fields and UI
elements, rejects stale old text or hashes, and records the before/after overlay
and UI strings plus source quotes in its append-only receipt. This route does not add or remove
overlays or author a new story event.

When a reviewed later beat no longer depicts one formerly carried object, the
replacement may remove its stale `shot_manifest.equipment_contracts` entry
with `equipment_contract_removal: { "owner": "<exact owner>", "item":
"<exact item>", "expected_contract_sha256": "<SHA-256 of that contract's
JSON.stringify(contract, null, 2) plus newline>" }`. The command requires
exactly one matching current contract and preserves every other equipment
contract. Correct the prompt and any staging/continuity/anatomy prose in the
same reviewed spec so the removed object is not still depicted. This does not
alter the source beat's projected state or permit reference changes.
If the same object is listed in `shot_manifest.visible_props`, include
`visible_prop_removal: "<exact current prop label>"`; it must match one and
only one visible prop, leaving the other props untouched.
`visible_prop_removals` accepts up to three distinct exact prop labels when a
reviewed wrong room contributed more than one stale prop. Use either singular
or plural form, never both.

An exact sublocation mistake may use `location_reference_patch: {
"from_ref_id": "<attached location ref>", "to_ref_id": "<approved location ref>",
"approved_reference_sha256": "<approved raster SHA-256>",
"source_quotes": ["<verbatim source evidence>"] }`. This keeps the current
location contract, cast, timing, reference slot order and roles. It changes
only one already-attached environment location reference in its requirement,
usage, anchor, manifest slot and `location_ref_id`. The replacement target must
be explicitly planned for the selected beat, approved, in scene scope and
hash-identical to its on-disk raster. Both targets must share the current
location contract, or share a source location asset when the new reference is
a narrower adjacent sublocation; the normal harden reports any resulting
contract/ref warning. Include `reference_text_patch` to replace stale room
purpose/reason, `visible_prop_removal(s)` for stale furniture, and exact
prompt/continuity/depth wording in the same repair. When a screen's
`holder_state` mentions the old room, a location correction may include
`equipment_contract_text_patch: { "owner": "...", "item": "...",
"expected_contract_sha256": "...", "holder_state": { "before": "...",
"to": "..." }, "contact_target": { "before": "...", "to": "..." } }`.
Either holder state or contact target may be omitted when unchanged. The old
reference ID must disappear entirely from the
corrected row. This route does not select a new location based on prose and
cannot change an unplanned or unapproved location image.

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
