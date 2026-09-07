# Private Avatar / Footage Pilot

Read the [shared router](../../AGENTS.md), [movie/TV editorial guidance](../pipelines/movie_tv.md), [pilot design](../designs/avatar_what_if_pilot_v1.md), and [Narration Quality V2](narration_quality_v2.md). Footage library work additionally requires [the footage workflow](footage_clipping_workflow.md).

This is a distinct **90-second proof**, not the reserved full-length movie/TV production lane. `mcu_what_if_pilot_v1` + `avatar_footage_pilot_v1` use a separate 14-stage registry. Existing manhwa/documentary identities and their 37-stage generated registry remain unchanged. Publishing, auto-advance, old generated commands and workflow bypass are unavailable for this identity.

## What Runs Now

The route validates an immutable proof identity, ingests exact source text, records separate script and factual-source approvals, and produces a canonical opening-only Joel sample for listening. The downstream asset-plan, reviewed-media-import, typed timeline, local render and final-QA handlers are implemented, but they remain unreachable for a real episode until the remaining-narration adapter is released. Stage inputs and decisions are hash-bound; attempts append immutable reports and execution events with a cumulative manifest. Passed or stale stages cannot be silently rerun. A blocker requires evidence inspection and a separately implemented/authorized exact-scope repair; there is no automatic retry loop.

**Opening synthesis is narrowly released:** `create-voice-sample` is an alias for the existing opening stage only on canonical new identities. It builds the full approved-source plan, text IR and provider requests, but authorizes exactly the first two sentence-complete units (at most 60 words). Remaining units keep separate immutable phase cohorts and are not synthesized. The shared Qwen runner validates persisted gates before model load. The phase-isolated canonical finalizer checks original runner/jobs/cohort/sidecar/WAV evidence, unit and stream delivery, voice continuity, alignment-safe stitching, mastering and actual Whisper timing. Technical validation leaves listening pending.

`import-voice-sample` and `import-narration` remain blocked: arbitrary bundles are not accepted and the remaining-narration producer with accepted-opening reuse is not yet implemented. Still/video assets are reviewed local imports with retained actual provider evidence, not automatic Gemini/Flow dispatch. Do not fabricate receipts, substitute an arbitrary WAV, invoke old production commands directly, or call a synthetic test the Sentry pilot.

## Commands and Gates

Run `node bin/goldflow.mjs pilot preflight --episode-dir <new-absolute-dir> --identity <proof-config.json>` on clean code. The config explicitly locks channel, series_slug, week, episode, title, run_intent=`proof`, production_eligible=false, publish_allowed=false, audio_target=`commentary_with_optional_source_audio`, source_script `{path,sha256}`, and proof_scope `{start_sec:0,end_sec:90,width:1920,height:1080,fps:30,duration_frames:2700}`. It also locks `pilot_providers.stills` to Google Gemini/Flow provider/model rows, `video` to Flow/model/enabled and `narration` to the exact owned Joel provider/model/revision/voice/reference hashes. Use a private proof namespace if no public channel is selected; never infer a release destination.

New preflights also derive and hash-bind canonical narration identity fields through the existing Joel/Qwen quality and provider-policy builders: the exact dry/deadpan reference, calibrated voice checks, batch-four synthesis policy, immutable delivery-bank file, and local Whisper contract. Conflicting declared settings stop before directory creation. Status validates these fields when present; historical proof identities remain unchanged. The identity's `synthesis_authorized:false` is not a live gate: the scoped producer separately validates current approvals and records exact opening authorization immediately before synthesis. It requires clean committed adapter code and records its runtime commit/runner hash without rewriting the run identity.

An operator-approved script revision uses a fresh proof directory while preserving channel, series, run/week and episode IDs, for example `<run-dir>/revisions/script-v3/episodes/ep_01`. Record the superseded identity's path/hash in the new config, rerun preflight/ingest/exact script approval, and review a new script-matched evidence ledger. Never overwrite the previous identity or inherit its script approval.

After every command, inspect `node bin/goldflow.mjs run status --episode-dir <dir> --format markdown`. It supplies the next command and reports the import-only limitations. In order:

| Command (`goldflow pilot …`) | Required input / approval |
| --- | --- |
| `preflight` | New directory and exact private proof config |
| `ingest --script <file>` | Exact preflight-bound narration text |
| `approve-script` | Operator's exact-text review, `--accept true --reviewer --note` |
| `approve-evidence --input <file>` | Hash-matched claims ledger; exact source edition, reviewed timestamps, use basis, MCU-only factual coverage; `--reviewer --note` |
| `create-voice-sample --input <editorial.json>` | Canonical identity and current script/evidence approvals; exact full-source spans, unchanged-source speakability review, two opening units; 15–20-second sample target without cutting or speeding speech |
| `import-voice-sample --input <bundle>` | **Blocked**; arbitrary audio bundles are not accepted |
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

The opening editorial schema is `goldflow_avatar_pilot_narration_editorial_v1`: `source_script_sha256`, current `script_approval` and `evidence_approval` path/hash bindings, `opening_unit_count:2`, full-source `editorial_units` with exact UTF-16 spans and authored boundary classes, plus `targeted_speakability` recording reviewer, unchanged source and empty spoken overrides. Performance intent stays metadata; unsupported provider direction is reported, not spoken. The opening producer exclusively creates `pilot_narration_work`; its existence without a passed stage blocks another attempt and requires manual triage. Do not delete it to rerun. A technical failure preserves all first takes and never authorizes creative retries. Duration outside the sample window is a review/triage point, not an instruction to cut or speed up speech.

Opening artifacts stay in `pilot_narration_work/opening_finalization`. Its Whisper artifact is only an opening timing candidate, not official full narration timing. Only after the operator listens to the entire exact sample may `approve-voice-sample` record the canonical subjective decision covering its contained review windows. This never approves remaining speech, final mix, media or release.

Schemas and provider-free examples are in `scripts/lib/avatar-pilot-artifacts.mjs` and `scripts/tests/avatar-pilot-artifact-tests.mjs`. A narration bundle retains hash-bound generation plan, TTS and stitch reports, full-stream QA, calibrated voice continuity, subjective manifest/decision, canonical audio and Whisper timing; full narration additionally references the accepted opening bundle. No arbitrary audio imports.

Every movie asset retains its source manifest, exact edition/timestamps, extraction receipt, library approval and a separate intended-pilot-use basis/review. Library approval is not pilot approval. Generated assets retain one-submission provider/model/prompt/output hashes, accepted reference bindings, actual provider evidence, and inspected output decisions. This proof permits only Gemini/Flow stills and selected Flow video. Provider audio is stripped from generated video.

The timeline schema is `goldflow_avatar_pilot_timeline_v1`: 1920x1080, 30 fps, 2700 frames; contiguous `shots` with background and independent layers; `narration`, `source_audio`, and `captions` arrays. Movie evidence and generated hypotheses cannot be mislabeled. Hypothetical visuals carry a visible label. Layer `source_in_sec` is an offset within the accepted local clip, **not** its movie timestamp. Both clocks remain recorded separately.

Movie layers play 3–5 seconds. An explicit loop uses `loop:true` plus frame-aligned `source_duration_sec` of 3–5 seconds, at most two cycles / ten seconds on screen, and no source audio. Normal cards can retain explicitly gained `under_narration` audio or a `spotlight` only while narration pauses. Video playback is independent of card entrance movement. No silent freeze or stretching.

Captions reproduce the complete approved script and carry contiguous `word_start_index` / `word_end_index_exclusive` values tied to accepted Whisper timing and narration placements. Full speech is consumed in source order; the final fractional video frame contains silence, not clipped or stretched speech. Host poses need actual alpha channels. There is no default extra score/SFX.

## Verification

`npm run test:avatar-pilot` runs isolated fixture approvals, stale/no-bypass checks, source/provider/voice import validation and an actual synthetic 90-second FFmpeg composition. `npm run test:avatar-pilot-opening` additionally covers full-source planning, phase gates and actual Python pre-model checks, original execution provenance, opening finalization, technical validation and producer/workflow orchestration without models or paid calls. Fixtures establish implementation behavior only, never real Joel delivery, listening acceptance or source permission.
