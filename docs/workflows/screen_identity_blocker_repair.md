# Exact promotional-screen identity correction after blocked hardening

Use `visual repair-screen-identity` only when Goldflow status names it after a
single `visible_character_ref_scope_missing` blocker, and manual review of the
approved script and beat shows that a generic robot depicted on a promotional
screen was falsely tagged as a named recurring character. The command changes
one reviewed prompt row, removes one invented speech bubble attributed to the
false character, and costs no provider calls. It leaves the locked script,
approved beat and reference plans, generated refs, and all other cuts intact.
The discrepancy in the approved beat's entity tag is recorded in the receipt;
the script excerpt and beat's local continuity note are required evidence.

Run `goldflow run status` and inspect the exact cut, source excerpt, current
manual review, hardening report, and reference slots. Write a reviewed spec:

```json
{
  "schema": "goldflow_visual_screen_identity_blocker_repair_v1",
  "episode": "ep_01",
  "expected": {
    "run_identity": "<SHA-256 of run_identity.json>",
    "script": "<SHA-256 of script_clean.md>",
    "beat_plan": "<SHA-256 of visual_beat_plan.json>",
    "beat_approval": "<SHA-256 of visual_beat_approval.json>",
    "reference_plan": "<SHA-256 of visual_reference_plan.json>",
    "reference_plan_approval": "<SHA-256 of reference_plan_approval.json>",
    "reference_image_approval": "<SHA-256 of visual_reference_approval_ep_01.json>",
    "base_prompt_plan": "<SHA-256 of section_image_prompts.json>",
    "reviewed_prompt_plan": "<SHA-256 of section_image_prompts_reviewed.json>",
    "harden_report": "<SHA-256 of visual_prompt_hardening_ep_01.json>",
    "manual_review": "<SHA-256 of visual_manual_agent_review_ep_01.json>"
  },
  "image_id": "<one exact image ID>",
  "visual_beat_id": "<its beat ID>",
  "old_row_sha256": "<SHA-256 of JSON.stringify(row, null, 2) plus newline>",
  "false_entity_id": "<wrong named entity ID in the beat and row>",
  "false_name": "<wrong display name in the row>",
  "generic_subject": "unnamed promotional robot",
  "replacement_prompt": "<complete source-faithful image prompt with no named character or invented speech>",
  "reviewer": "<reviewer>",
  "note": "<specific source evidence and why the original identity is false>",
  "source_erratum_reviewed": true
}
```

Execute the exact command reported by status:

```bash
node bin/goldflow.mjs visual repair-screen-identity --episode-dir <episode-dir> --repair-spec <reviewed-json>
```

The command binds all source, approval, blocker, and reviewed-plan hashes. It
requires a single matching blocker, one screen-visible false identity, a source
excerpt about a robot on a screen without the false name, and a beat note that
explicitly describes the generic promotional robot. The reviewed row must have
no attached character ref. It updates the prompt, prompt hash, generic subject
metadata, and the named anatomy/equipment/staging owner; clears the wrong
screen entity ID and the invented bubble; and refuses if the false name remains.
It snapshots the original reviewed plan and stores the spec and append-only
receipt under `reports/stages/visual_prompt_blocker_repair/exact_screen_identity/`.
The historical failed review and hardening reports stay intact.

Rerun status. It should name the normal `visual harden` command against
`section_image_prompts_reviewed.json`. Run that guarded command and require its
full cut set to pass. Any remaining blocker requires fresh exact triage;
do not waive a true identity or scope error.
