# Channel preset and source hand-off (run preflight bridge)

This document defines the two files that let `goldflow run preflight` be driven from a finished
source script without a person assembling the ~17 operational flags by hand (roadmap R09, Part B
H5). Both files are hash-recorded in `run_identity.json`. Neither file decides the editorial
profile, the media workflow or the run intent: those three remain explicit command-line flags on
every new preflight, and a channel name never infers a content family (AGENTS.md).

```bash
node bin/goldflow.mjs run preflight --content-profile manhwa_recap_v1 --media-workflow generated_visuals_v1 --run-intent production --source-handoff <dev-dir>/revision_loop/source_handoff.json --channel-preset <AniFactoryData>/channels/53rebirth/channel_preset.json --channel 53rebirth --series <series-slug> --week <run-slug> --episode ep_01
```

## `source_handoff.json` (schema `goldflow_source_handoff_v1`)

Written by `source manufacture run` and `source manufacture revise` beside the retained script
(`revision_loop/source_handoff.json`). It is rewritten only when the retained script changes.

| Field | Meaning |
| --- | --- |
| `status` | always `ready_for_preflight` |
| `title` | the brief's title, copied byte-for-byte; `null` for a brought script without a brief (then pass `--title`) |
| `final_script_path`, `sha256` | the retained script and its SHA-256; preflight refuses a mismatch |
| `brief_sha256`, `model_lock_sha256`, `evidence_sha256` | hashes of `manufacturing_brief.json`, `manufacturing_model_lock.json` and the `--evidence` file the brief was selected from (`null` when absent) |
| `channel`, `development_dir`, `incumbent_source`, `word_count` | provenance only |
| `revision_report_path`, `revision_report_sha256` | the revision loop report the script came from |
| `supplies_preflight_flags` | `["title", "source"]` |
| `never_supplies` | `["content-profile", "media-workflow", "run-intent"]`; a hand-off carrying any of them is rejected |

Preflight takes `--title` and `--source` from the hand-off. An explicit `--source` must name the same
file; an explicit `--title` overrides the hand-off title and is recorded as
`source_handoff.title_overridden_by_cli`. The ingested script bytes are hashed and compared with
`sha256` before any identity is written.

## `channel_preset.json` (schema `goldflow_channel_preset_v1`)

An operator-authored file, one per channel, kept at
`<AniFactoryData>/channels/<channel>/channel_preset.json` and passed by explicit path. Its `flags`
object uses the exact preflight flag names (without `--`). Preflight records
`channel_preset: { path, sha256, version, authored_by, applied_flags, overridden_by_cli }` in the
run identity. An explicit command-line flag always wins over the preset and is recorded as an
override.

Allowed keys (operational flags only): planning (`planning-provider`, `planning-effort-policy`,
`planning-model`, `planning-reasoning-effort`), images (`image-provider`, `image-model`,
`reference-model`, `image-fallback-*`, `google-*`, `chatgpt-project-url`), narration
(`audio-target`, `tts-provider`, `narrator-voice-id`, `narrator-reference-variant`,
`narration-delivery-bank`), pace (`pace-policy`, `target-wpm-min`, `target-wpm-max`), render,
motion and parallax policies (`render-profile`, `motion-policy`, `generated-motion-*`,
`parallax-*`), visual beat timing (`beat-timing-enforcement`, `*-beat-sec`, `hook-*`, `ramp-*`,
`retention-ramp-sec`), and the production profile and autopilot lock (`production-profile`,
`autopilot`, `episode-budget-usd`). The full list is `CHANNEL_PRESET_OPERATIONAL_FLAGS` in
`scripts/lib/channel-preset.mjs`.

Refused keys: `content-profile`, `media-workflow`, `run-intent` (preflight fails with an explicit
message), and every per-run identity or attestation flag (`channel`, `series`, `week`, `episode`,
`title`, `source`, `evidence-ledger`, `winner-release`, `allow-dirty-worktree`, `dirty-reason`,
`confirm-episode-identity`, `allow-part-in-week`, `proof-*`, `human-checkpoints`). Unknown keys are
also refused, so a preset cannot smuggle a new flag in silently.

Both `--channel-preset` and `--source-handoff` require `--content-profile`, `--media-workflow` and
`--run-intent` on the command line.

### Example: `channels/53rebirth/channel_preset.json`

This is the shape that reproduces the 2026-W43 coma-healer baseline identity's operational fields
(the fixture `scripts/tests/fixtures/base_run_identity_fields_2026w43.json` checks it). The file
lives in AniFactoryData, authored by the operator; the repository holds only this documented
example.

```json
{
  "schema": "goldflow_channel_preset_v1",
  "channel": "53rebirth",
  "version": "2026-10-20.1",
  "authored_by": "joel",
  "note": "Operational flags only. Content profile, media workflow and run intent are passed explicitly on every preflight.",
  "flags": {
    "planning-provider": "planning_room",
    "planning-effort-policy": "planning_room_stage_routed_v1",
    "image-provider": "codex_imagegen",
    "audio-target": "narrator_only",
    "tts-provider": "qwen_local",
    "production-profile": "fast_premium_v2",
    "pace-policy": "diagnostic",
    "target-wpm-min": 180,
    "target-wpm-max": 195,
    "render-profile": "panel_composition_v1",
    "motion-policy": "selective_editorial_v1",
    "generated-motion-policy": "disabled",
    "parallax-policy": "disabled",
    "beat-timing-enforcement": "hard_max",
    "target-beat-sec": 7.5,
    "max-beat-sec": 8,
    "min-beat-sec": 3,
    "hook-duration-sec": 30,
    "hook-target-beat-sec": 3.2,
    "hook-max-beat-sec": 4.2,
    "hook-min-beat-sec": 2.2,
    "retention-ramp-sec": 1200,
    "ramp-target-beat-sec": 6,
    "ramp-max-beat-sec": 7,
    "ramp-min-beat-sec": 3.2,
    "autopilot": true,
    "episode-budget-usd": 25
  }
}
```

`autopilot: true` with `episode-budget-usd` makes new episodes autopilot identities (the production
default for generated visuals); it still needs `--run-intent production` on the command line and
the `fast_premium_v2` automated narration acceptance.
