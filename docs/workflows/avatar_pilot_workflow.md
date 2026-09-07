# Private Avatar / Footage Pilot

Read the [shared router](../../AGENTS.md), [movie/TV editorial guidance](../pipelines/movie_tv.md), [pilot design](../designs/avatar_what_if_pilot_v1.md), and [Narration Quality V2](narration_quality_v2.md). Footage library work additionally requires [the footage workflow](footage_clipping_workflow.md).

This is a distinct **90-second proof**, not the reserved full-length movie/TV production lane. `mcu_what_if_pilot_v1` + `avatar_footage_pilot_v1` use a separate 14-stage registry. Existing manhwa/documentary identities and their 37-stage generated registry remain unchanged. Publishing, auto-advance, old generated commands and workflow bypass are unavailable for this identity.

## What Runs Now

The route validates an immutable proof identity, ingests exact source text and records separate script and factual-source approvals. The downstream asset-plan, reviewed-media-import, typed timeline, local render and final-QA handlers are implemented, but they remain unreachable for a real episode until the narration boundary below is released. Stage inputs and decisions are hash-bound; attempts append immutable reports and execution events with a cumulative manifest. Passed or stale stages cannot be silently rerun. A blocker requires evidence inspection and a separately implemented/authorized exact-scope repair; there is no automatic retry loop.

**Narration entry is explicitly blocked:** `import-voice-sample` and `import-narration` cannot currently accept a take. A complete canonical source/IR/provider-request/pre-synthesis/QA lineage adapter must be fixture-proven first; matching declared script hashes and stub QA reports are not sufficient. A new pilot-specific Qwen synthesis adapter, including opening-sample scope and accepted-unit reuse, also needs implementation. Likewise, still/video assets are reviewed local imports with retained actual provider evidence, not automatic Gemini/Flow dispatch. Do not fabricate receipts, substitute an arbitrary WAV, invoke old production commands directly, or call a synthetic test the Sentry pilot.

## Commands and Gates

Run `node bin/goldflow.mjs pilot preflight --episode-dir <new-absolute-dir> --identity <proof-config.json>` on clean code. The config explicitly locks channel, series_slug, week, episode, title, run_intent=`proof`, production_eligible=false, publish_allowed=false, audio_target=`commentary_with_optional_source_audio`, source_script `{path,sha256}`, and proof_scope `{start_sec:0,end_sec:90,width:1920,height:1080,fps:30,duration_frames:2700}`. It also locks `pilot_providers.stills` to Google Gemini/Flow provider/model rows, `video` to Flow/model/enabled and `narration` to the exact owned Joel provider/model/revision/voice/reference hashes. Use a private proof namespace if no public channel is selected; never infer a release destination.

New preflights also derive and hash-bind canonical narration identity fields through the existing Joel/Qwen quality and provider-policy builders: the exact dry/deadpan reference, calibrated voice checks, batch-four synthesis policy, immutable delivery-bank file, and local Whisper contract. Conflicting declared settings stop before directory creation. Status validates these fields when present; historical proof identities remain unchanged. This identity contract alone does not release synthesis or import: the scoped producer, phase-preserving finalizer and complete output-lineage adapter remain unfinished.

An operator-approved script revision uses a fresh proof directory while preserving channel, series, run/week and episode IDs, for example `<run-dir>/revisions/script-v3/episodes/ep_01`. Record the superseded identity's path/hash in the new config, rerun preflight/ingest/exact script approval, and review a new script-matched evidence ledger. Never overwrite the previous identity or inherit its script approval.

After every command, inspect `node bin/goldflow.mjs run status --episode-dir <dir> --format markdown`. It supplies the next command and reports the import-only limitations. In order:

| Command (`goldflow pilot …`) | Required input / approval |
| --- | --- |
| `preflight` | New directory and exact private proof config |
| `ingest --script <file>` | Exact preflight-bound narration text |
| `approve-script` | Operator's exact-text review, `--accept true --reviewer --note` |
| `approve-evidence --input <file>` | Hash-matched claims ledger; exact source edition, reviewed timestamps, use basis, MCU-only factual coverage; `--reviewer --note` |
| `import-voice-sample --input <bundle>` | **Blocked pending proven canonical lineage adapter**; eventual 15–20-second owned-Joel bundle |
| `approve-voice-sample` | Exact listening review; `--accept true --reviewer --note --attestation complete_opening_listened_end_to_end` |
| `import-narration --input <bundle>` | **Blocked pending proven canonical lineage adapter**; eventual full canonical WAV, QA, Whisper and unchanged approved opening prefix |
| `plan-assets --input <plan>` | Exact script-bound asset IDs, purpose, kind, provider/model and truth mode |
| `approve-asset-plan` | Exact creative/provider scope approval |
| `import-media --input <manifest>` | Complete planned local assets, immutable receipts and exact pilot reviews |
| `timeline --input <timeline>` | Typed frame coverage, source/output mapping, complete narration/captions |
| `approve-timeline` | Exact edit/mix approval |
| `render` | All current upstream hashes, local inputs only, exactly 2700 frames |
| `final-qa` | Measured mix (-16 LUFS +/-1; <=-1.5 dBTP), complete viewing/listening; `--reviewer --note --attestation entire_90_second_program_watched_and_listened` |

Approval commands not otherwise qualified require `--accept true --reviewer <name> --note <review>`. Schema success is not proof of factual truth, human listening, provider authenticity or legal clearance. Record real reviews only.

## Imported Contracts

Schemas and provider-free examples are in `scripts/lib/avatar-pilot-artifacts.mjs` and `scripts/tests/avatar-pilot-artifact-tests.mjs`. A narration bundle retains hash-bound generation plan, TTS and stitch reports, full-stream QA, calibrated voice continuity, subjective manifest/decision, canonical audio and Whisper timing; full narration additionally references the accepted opening bundle. No arbitrary audio imports.

Every movie asset retains its source manifest, exact edition/timestamps, extraction receipt, library approval and a separate intended-pilot-use basis/review. Library approval is not pilot approval. Generated assets retain one-submission provider/model/prompt/output hashes, accepted reference bindings, actual provider evidence, and inspected output decisions. This proof permits only Gemini/Flow stills and selected Flow video. Provider audio is stripped from generated video.

The timeline schema is `goldflow_avatar_pilot_timeline_v1`: 1920x1080, 30 fps, 2700 frames; contiguous `shots` with background and independent layers; `narration`, `source_audio`, and `captions` arrays. Movie evidence and generated hypotheses cannot be mislabeled. Hypothetical visuals carry a visible label. Layer `source_in_sec` is an offset within the accepted local clip, **not** its movie timestamp. Both clocks remain recorded separately.

Movie layers play 3–5 seconds. An explicit loop uses `loop:true` plus frame-aligned `source_duration_sec` of 3–5 seconds, at most two cycles / ten seconds on screen, and no source audio. Normal cards can retain explicitly gained `under_narration` audio or a `spotlight` only while narration pauses. Video playback is independent of card entrance movement. No silent freeze or stretching.

Captions reproduce the complete approved script and carry contiguous `word_start_index` / `word_end_index_exclusive` values tied to accepted Whisper timing and narration placements. Full speech is consumed in source order; the final fractional video frame contains silence, not clipped or stretched speech. Host poses need actual alpha channels. There is no default extra score/SFX.

## Verification

`npm run test:avatar-pilot` runs isolated fixture approvals, stale/no-bypass checks, source/provider/voice import validation and an actual synthetic 90-second FFmpeg composition. The fixture tests moving evidence cards, transparent host layering, explicit loops, captions, source-audio modes, exact output frame count and measured audio. Synthetic tones/images establish implementation behavior only, never real Joel delivery or source permission.
