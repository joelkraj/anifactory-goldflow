# Exact visible-identity binding after blocked hardening

Use `visual repair-identity-binding` only when status names it after a reviewed
prompt harden has unresolved `required_source_identity_ambiguous` findings.
Inspect the locked beat, the image-facing prompt, the current character state,
all candidate approved references, the four-slot budget, and any continuity
conflict before writing a spec. The command changes structured reference and
staging fields in exact cut rows. The optional pre-event correction changes
only explicitly reviewed prompt spans and related state notes when a later
injury was placed before its source event. Other provider prompts, source
excerpts, beat IDs, image IDs, and all untouched rows remain byte-identical.
It makes no provider call and cannot change the approved reference plan or
rasters.

The reviewed JSON spec uses schema `goldflow_visual_identity_binding_repair_v1`.
`episode` is the episode folder name. `expected` contains SHA-256 hashes for
`run_identity`, `script`, `beat_plan`, `beat_approval`, `reference_plan`,
`reference_plan_approval`, `reference_image_approval`, `base_prompt_plan`,
`reviewed_prompt_plan`, `harden_report`, and `manual_review`; filenames match
the repair module. `bindings` contains one row for every original ambiguous
identity blocker and any exactly bounded current-state conflict:

```json
{
  "image_id": "<exact cut>",
  "visual_beat_id": "<locked beat>",
  "character": "<visible character>",
  "ref_id": "<selected approved in-scope character ref>",
  "replace_ref_id": null,
  "stale_staging_ref_id": null,
  "remove_forbidden_ref_id": null,
  "slot_order": 2,
  "old_row_sha256": "<current reviewed-row JSON SHA-256>",
  "approved_reference_sha256": "<approved raster SHA-256>",
  "wardrobe_from": "<reviewed current beat or selected full-state wardrobe>",
  "reason": "<source-backed selection>",
  "temporal_correction": null
}
```

Set `replace_ref_id` only to the exact old attached identity for a continuity
correction. A face-only replacement must keep current clothing/injury in the
existing image prompt and set `wardrobe_from` to a current-beat description
that explicitly says the new ref supplies facial likeness only. Use
`stale_staging_ref_id` when a dropped out-of-scope ID remains in staging.
`remove_forbidden_ref_id` is accepted only for the chosen face-only ref when
the old full-state reference is being replaced, or for the reviewed intact
full-state ref in a pre-event correction. The exact new ID must be in the
current row's forbidden list. No other prohibition may be removed.

`continuity_scope` names the exact character, canonical subject ID, old and
new reference IDs, and the literal active wardrobe state. The guard scans all
reviewed cuts and requires every matching conflict to be in `bindings`; it
refuses unrelated cuts. Each binding must match a current beat, approved
reference target, approved raster hash, and old row hash. Original ambiguous
blockers must all be covered. `temporal_scope` names a source beat where an
injury first occurs, the literal preceding active wardrobe state, and the
wrongly selected wounded/intact refs. The guard scans all earlier cuts with
that exact contradiction. Each such binding supplies one to three exact
`prompt_changes` (`before`/`to` spans), a complete `replacement_prompt` equal
to only those changes, a reviewed `continuity_notes` patch, and an optional
exact `body_invariant` patch. It rejects any still-visible future wound. The
command rejects started transition/image
stages and any over-cap or duplicate slot. It snapshots the old reviewed plan,
spec, and append-only receipt under
`reports/stages/visual_prompt_blocker_repair/exact_identity_binding/`.

Run the exact command from status:

An optional `editorial_repairs` array may contain disjoint exact cuts with
source-fact prompt errors discovered during the same blocked review. Each row
names `image_id`, `visual_beat_id`, the SHA-256 of its current reviewed row,
an exact `source_quote` in that cut's locked beat excerpt, a concrete `reason`,
and a complete `replacement_row`. A lexical correction supplies one to three
unique literal `text_changes`; the complete new prompt must equal precisely
those substitutions. A memory cut may instead set
`manual_full_prompt_reviewed: true` to correct earlier scene geography,
clothing, and cast. A full replacement is admitted only when the original
`depiction_mode` is `memory_or_flashback`. All selected rasters must be
approved, scene-scoped, and hash-valid. The guard checks active references,
the four-slot limit, visible cast, and all immutable cut fields. A memory's
current-time state projection remains as provenance; its reviewed prompt and
continuity note explicitly specify the earlier depicted time. This path
does not change the beat or approved reference plan.

```bash
node bin/goldflow.mjs visual repair-identity-binding --episode-dir <episode-dir> --repair-spec <reviewed-json>
```

Rerun status, then `visual harden` against the reviewed plan it names. The
historical blocked reports remain evidence; passing harden and later image QA
are still required.
