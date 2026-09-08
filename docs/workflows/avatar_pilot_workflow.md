# Private Avatar / Footage Pilot

Read the [shared router](../../AGENTS.md), [movie/TV editorial guidance](../pipelines/movie_tv.md), [pilot design](../designs/avatar_what_if_pilot_v1.md), and [Narration Quality V2](narration_quality_v2.md). Footage library work additionally requires [the footage workflow](footage_clipping_workflow.md).

This is a distinct **90-second proof**, not the reserved full-length movie/TV production lane. `mcu_what_if_pilot_v1` + `avatar_footage_pilot_v1` use a separate 14-stage registry. Existing manhwa/documentary identities and their 37-stage generated registry remain unchanged. Publishing, auto-advance, old generated commands and workflow bypass are unavailable for this identity.

## What Runs Now

The route validates an immutable proof identity, ingests exact source text, records separate script and factual-source approvals, and produces a canonical opening-only Joel sample for listening. After genuine opening approval, the tested remaining-only adapter can preserve that opening, synthesize the rest of the unchanged full plan, and produce a full canonical technical candidate. Separate full-narration listening approval is required before the downstream asset-plan, reviewed-media-import, typed timeline, local render and final-QA handlers. Stage inputs and decisions are hash-bound; attempts append immutable reports and execution events with a cumulative manifest. Passed or stale stages cannot be silently rerun. A blocker requires evidence inspection and a separately implemented/authorized exact-scope repair; there is no automatic retry loop. These are implementation capabilities, not a claim that real remaining audio has been generated or approved.

**Opening synthesis is narrowly released:** `create-voice-sample` is an alias for the existing opening stage only on canonical new identities. It builds the full approved-source plan, text IR and provider requests, but authorizes exactly the first two sentence-complete units (at most 60 words). Remaining units keep separate immutable phase cohorts and are not synthesized. The shared Qwen runner validates persisted gates before model load. The phase-isolated canonical finalizer checks original runner/jobs/cohort/sidecar/WAV evidence, unit and stream delivery, voice continuity, alignment-safe stitching, mastering and actual Whisper timing. Technical validation leaves listening pending.

**Remaining synthesis is separately released:** `create-narration` authenticates the real opening stage, its exact listening decision and original technical evidence, then authorizes only the frozen plan's remaining units. The two opening raw WAVs, sidecars, QA and phase identities are preserved. Full canonical QA still leaves listening pending; `approve-narration` is the separate acceptance action. Both actions map to the existing narration stage without changing the locked registry.

`import-voice-sample` and `import-narration` remain blocked: arbitrary bundles are not accepted. Still/video assets are reviewed local imports with retained actual provider evidence, not automatic Gemini/Flow dispatch. Do not fabricate receipts, substitute an arbitrary WAV, invoke old production commands directly, or call a synthetic test the Sentry pilot.

## Commands and Gates

Run `node bin/goldflow.mjs pilot preflight --episode-dir <new-absolute-dir> --identity <proof-config.json>` on clean code. The config explicitly locks channel, series_slug, week, episode, title, run_intent=`proof`, production_eligible=false, publish_allowed=false, audio_target=`commentary_with_optional_source_audio`, source_script `{path,sha256}`, and proof_scope `{start_sec:0,end_sec:90,width:1920,height:1080,fps:30,duration_frames:2700}`. It also locks `pilot_providers.stills` to Google Gemini/Flow provider/model rows, `video` to Flow/model/enabled and `narration` to the exact owned Joel provider/model/revision/voice/reference hashes. Use a private proof namespace if no public channel is selected; never infer a release destination.

New preflights also derive and hash-bind canonical narration identity fields through the existing Joel/Qwen quality and provider-policy builders: the exact dry/deadpan reference, calibrated voice checks, batch-four synthesis policy, immutable delivery-bank file, and local Whisper contract. Conflicting declared settings stop before directory creation. Status validates these fields when present; historical proof identities remain unchanged. The identity's `synthesis_authorized:false` is not a live gate: each scoped producer separately validates current approvals and records its exact phase authorization immediately before synthesis. It requires clean committed adapter code and records its runtime commit/runner hash without rewriting the run identity.

An operator-approved script revision uses a fresh proof directory while preserving channel, series, run/week and episode IDs, for example `<run-dir>/revisions/script-v3/episodes/ep_01`. Record the superseded identity's path/hash in the new config, rerun preflight/ingest/exact script approval, and review a new script-matched evidence ledger. Never overwrite the previous identity or inherit its script approval.

After every command, inspect `node bin/goldflow.mjs run status --episode-dir <dir> --format markdown`. It supplies the next command and distinguishes pending technical candidates, listening gates and blocked arbitrary imports. In order:

| Command (`goldflow pilot …`) | Required input / approval |
| --- | --- |
| `preflight` | New directory and exact private proof config |
| `ingest --script <file>` | Exact preflight-bound narration text |
| `approve-script` | Operator's exact-text review, `--accept true --reviewer --note` |
| `approve-evidence --input <file>` | Hash-matched claims ledger; exact source edition, reviewed timestamps, use basis, MCU-only factual coverage; `--reviewer --note` |
| `create-voice-sample --input <editorial.json>` | Canonical identity and current script/evidence approvals; exact full-source spans, unchanged-source speakability review, two opening units; 15–20-second sample target without cutting or speeding speech |
| `import-voice-sample --input <bundle>` | **Blocked**; arbitrary audio bundles are not accepted |
| `approve-voice-sample` | Exact listening review; `--accept true --reviewer --note --attestation complete_opening_listened_end_to_end` |
| `create-narration` | Current canonical opening approval; reuse the exact original full plan, preserve the two opening raw units, synthesize only frozen remaining cohorts; full technical QA produces a pending candidate, not an accepted stage |
| `review-narration` | Only a retained raw candidate with exact-listen warnings; complete raw listening with `--accept true --reviewer --note --attestation entire_raw_proof_narration_listened_end_to_end`; resolves those warnings and finalizes in a fresh namespace without synthesis or restitching |
| `approve-narration` | Separate complete-narration listening; `--accept true --reviewer --note --attestation entire_proof_narration_listened_end_to_end`; accepts the exact candidate, subjective decision and canonical Whisper mapping |
| `import-narration --input <bundle>` | **Blocked**; the scoped producer is not an arbitrary full-audio import route |
| `plan-assets --input <plan>` | Exact script-bound asset IDs, purpose, kind, provider/model and truth mode |
| `revise-asset-plan --input <plan>` | One guarded pre-approval revision; exact `--prior-stage-sha256`, `--affected-asset-ids` (comma-separated), `--reviewer` and `--note`; original plan preserved, no generation or approval |
| `approve-asset-plan` | Exact creative/provider scope approval |
| `revise-host-design --input <request>` | One guarded post-approval host-only amendment after the first neutral candidate is explicitly rejected; `--accept true --reviewer --note`; preserves the first attempt and authorizes exactly one replacement neutral submission |
| `approve-host-identity --input <request>` | Accept the exact replacement neutral plus its inspected real-alpha cutout; `--accept true --reviewer --note`; releases only the five already-planned dependent pose IDs, one first submission each |
| `use-local-concept-fallback --input <request>` | One post-refusal amendment: bind both retained no-output provider results and replace all three concept stills with source-cutout local editorial composites; `--accept true --reviewer --note`; zero provider submissions |
| `import-media --input <manifest>` | Complete planned local assets, immutable receipts and exact pilot reviews |
| `timeline --input <timeline>` | Typed frame coverage, source/output mapping, complete narration, optional separate captions |
| `approve-timeline` | Exact edit/mix approval |
| `render` | All current upstream hashes, local inputs only, exactly 2700 frames |
| `final-qa` | Measured mix (-16 LUFS +/-1; <=-1.5 dBTP), complete viewing/listening; `--reviewer --note --attestation entire_90_second_program_watched_and_listened` |

Approval commands not otherwise qualified require `--accept true --reviewer <name> --note <review>`. Schema success is not proof of factual truth, human listening, provider authenticity or legal clearance. Record real reviews only.

## Imported Contracts

The opening editorial schema is `goldflow_avatar_pilot_narration_editorial_v1`: `source_script_sha256`, current `script_approval` and `evidence_approval` path/hash bindings, `opening_unit_count:2`, full-source `editorial_units` with exact UTF-16 spans and authored boundary classes, plus `targeted_speakability` recording reviewer, unchanged source and empty spoken overrides. Performance intent stays metadata; unsupported provider direction is reported, not spoken. The opening producer exclusively creates `pilot_narration_work`; its existence without a passed stage blocks another attempt and requires manual triage. Do not delete it to rerun. A technical failure preserves all first takes and never authorizes creative retries. Duration outside the sample window is a review/triage point, not an instruction to cut or speed up speech.

Opening artifacts stay in `pilot_narration_work/opening_finalization`. Its Whisper artifact is only an opening timing candidate, not official full narration timing. Only after the operator listens to the entire exact sample may `approve-voice-sample` record the canonical subjective decision covering its contained review windows. This never approves remaining speech, final mix, media or release.

## Remaining Narration and Full Listening

`create-narration --episode-dir <dir>` uses the exact plan, text IR, spoken audit, source and reference bindings created before the opening. It does not replan or rewrite the approved script. The pre-synthesis gate uses `pilot_remaining_only`: authorized IDs are exactly the full plan's tail, preserved IDs are exactly its two-unit opening prefix, and authority evidence is the current `pilot_voice_sample_approval.json` path/hash. `accepted_opening` binds both the original sample and approval **stage artifacts**, not substitute audio files. The runner's actual pre-model validators verify preserved WAV/sidecar hashes and check them again after synthesis.

Opening and remaining execution retain separate original batch-plan hashes, cohorts, seeds, runner reports and event files. The full provider manifest joins those two real execution receipts in source order; it never invents a global batch or rewrites an opening synthesis identity. Reuse means the exact approved **raw unit WAVs and sidecars**, not a copy of the separately mastered opening sample. Fresh full-program stitching/mastering can change the master prefix while the accepted raw inputs stay byte-identical. No tempo adjustment, speech truncation, automatic retry or provider failover is allowed.

Remaining inputs/execution stay under `pilot_narration_work/remaining`; full finalization stays under `pilot_narration_work/full_finalization`. The complete candidate is `pilot_narration_work/narration_producer_result.json`. If remaining work exists without a valid candidate, status requires exact blocker triage; do not delete it or rerun synthesis. If a candidate is present, status directs the operator to listening approval, never another `create-narration`. Full QA authenticates original execution provenance, unit delivery, voice continuity, source order, exact stitch accounting, mastering, stream consensus and actual Whisper observations. Overlong or failed speech requires triage, not automatic rewriting or speed changes.

When zero hard blockers remain but exact-listen warnings defer mastering, status offers `review-narration`. It records the actual operator approval of the complete raw take and proves how each flagged unit's speech maps into that stream. This is not a claim that original unit files were heard in isolation or that a future master has already been heard. The continuation retains every original file, clones the authenticated checkpoint in memory, reads the exact existing raw stitch, and writes only new review receipts and `full_finalization_reviewed` outputs. Restitching, synthesis, CLI waivers and replay of an incomplete continuation are blocked. Canonical mastering and master-bound full-stream QA/timing then produce `narration_reviewed_result.json`; the final mastered subjective listening gate remains separate.

`approve-narration --episode-dir <dir> --accept true --reviewer <name> --note <review> --attestation entire_proof_narration_listened_end_to_end` requires listening to the entire exact narration candidate. It records a canonical subjective decision covering the contained review windows and validates the full technical result again. It then accepts `pilot_narration.json` and a pilot-specific `pilot_word_timing.json` mapping the exact canonical Whisper observations to the compositor's `start`/`end` fields, without a second ASR run. The unapproved candidate and opening timing candidate cannot complete this stage. The later 90-second rendered-program listening/viewing and mix approval are still separate.

Narration schemas and provider-free examples are in the opening/remaining execution, full finalization, validation and acceptance modules and their tests. `scripts/lib/avatar-pilot-artifacts.mjs` retains the other reviewed-asset contracts and the blocked arbitrary-import boundary. Structural fixtures never count as real speech, operator listening or provider/source permission.

## Reviewed Media and Timeline Contracts

### One Pre-Approval Asset-Plan Revision

While the original plan passes and its approval is missing, `revise-asset-plan` can register one operator-requested visual revision. Every approval/downstream stage artifact and any `pilot_media_work`, `pilot_render_work` or rendered proof must be absent. Use a separate new candidate file; never edit the imported V1 candidate or `pilot_asset_plan.json`. Status exposes the optional revision command with the current original-stage hash.

```sh
node bin/goldflow.mjs pilot revise-asset-plan --episode-dir <episode-dir> \
  --input <revised-plan.json> --prior-stage-sha256 <original-stage-sha256> \
  --affected-asset-ids analysis_room,host_room --reviewer <name> --note <operator-revision-reason>
```

Affected IDs must exactly identify every changed, added or removed asset row; a rename names both old and new IDs. All other asset rows and their relative order remain unchanged. Only global `intent`, `art_direction`, `generation_order`, `edit_intent` and `revision` presentation metadata may also change. Schema, source/identity bindings, other scope fields and the locked provider/model checks remain enforced.

The command uses the ordinary stage lease and append-only execution audit, with zero generation/spend and no approval. It writes a new `pilot_asset_plan_revision/revision.json`, effective `pilot_asset_plan_revision/pilot_asset_plan.json`, and hash-bound activation record. The original stage, V1 input and old audit reports remain byte-identical. Status, `approve-asset-plan` and `import-media` resolve the same effective plan; approval binds that revised stage's exact path/hash. The 14-stage identity/registry is unchanged.

An incomplete, stale or already-used revision is a triage point, not another attempt. Missing revision evidence never silently falls back to V1. A second revision, a revision after approval/downstream work, `--accept` on the revision command, automatic generation and approval are unavailable. Review the effective plan separately before `approve-asset-plan`.

### One Rejected-Neutral Host Design Amendment

At `pilot_media`, before a media manifest, timeline or render exists, `revise-host-design` can record one operator-requested replacement when the first `host_neutral` image has been reviewed and rejected. This is not a generic retry. The request binds the current effective plan and approval; the first generation request, submission observation, result, operator rejection and output; a separate replacement plan and prompt; and at most one local external inspiration image. The first output and all upstream stages remain immutable.

The replacement plan keeps every asset ID, order, kind, provider, model, truth mode, reference relationship and non-host row unchanged. Only the two host art-direction strings, exact six host-pose purpose strings and the declared external inspiration binding may change. The action writes a new effective plan and approval plus an exact replacement authority: only `host_neutral`, attempt two, one new creative submission, lifetime count two. It still does not dispatch Gemini or accept the output. Dependent poses remain blocked until the actual replacement neutral asset is separately reviewed.

The replacement provider receipt must record `creative_submission_count: 2`, `attempt_number: 2`, `creative_submissions_this_attempt: 1`, the exact `replacement_authority`, replacement prompt hash and external inspiration binding. Later host poses remain their own single first submissions and bind the same `host_design_authority` plus their planned accepted-neutral reference. Stale, partial, deleted or repeated amendment evidence blocks rather than falling back. Other assets keep the ordinary one-submission rule.

`approve-host-identity` is the separate post-generation release gate. Its request hash-binds the replacement request, browser submission and provider observations, native output, operator identity acceptance, deterministic alpha-extraction receipt and inspected real-alpha PNG. It writes an immutable approval authority without changing the prior host-design authorization. Each of the five dependent poses must bind that approval and the exact accepted alpha-neutral path/hash, uses attempt one with one creative submission, and cannot inherit the external inspiration image. Missing or stale approval evidence blocks media import and pose authority; the action performs no generation and cannot be replayed.

### Asset and Edit Evidence

Every movie asset retains its source manifest, exact edition/timestamps, extraction receipt, library approval and a separate intended-pilot-use basis/review. Library approval is not pilot approval. Generated assets retain one-submission provider/model/prompt/output hashes, accepted reference bindings, actual provider evidence, and inspected output decisions. This proof permits only Gemini/Flow stills and selected Flow video. Provider audio is stripped from generated video.

The one local concept fallback is available only at `pilot_media`, before a media manifest or timeline exists, and only after the first concept has retained one technical failure and one explicit provider refusal with no output. Its effective plan keeps every non-concept asset byte-for-byte identical and changes the three concept rows together to `editorial_composite` / `local_compositor` / `source_cutout_composite_v1`. Each resulting still binds its exact planned movie-clip sources, deterministic local recipe, output hash and operator review. It authorizes no model call and cannot legitimize an arbitrary or untracked still.

The timeline schema is `goldflow_avatar_pilot_timeline_v1`: 1920x1080, 30 fps, 2700 frames; contiguous `shots` with background and independent layers; `narration`, `source_audio`, and `captions` arrays. Movie evidence and generated hypotheses cannot be mislabeled. Hypothetical visuals carry a visible label. Layer `source_in_sec` is an offset within the accepted local clip, **not** its movie timestamp. Both clocks remain recorded separately.

A plain backdrop is native timeline data: use `background_color: "#RRGGBB"` without a `background_asset_id`. It needs no generated image or provider receipt. A recurring illustrated room instead uses its approved background asset; keep the host as a separate transparent pose layer.

Movie layers play 3–5 seconds. An explicit loop uses `loop:true` plus frame-aligned `source_duration_sec` of 3–5 seconds, at most two cycles / ten seconds on screen, and no source audio. Normal cards can retain explicitly gained `under_narration` audio or a `spotlight` only while narration pauses. Video playback is independent of card entrance movement. No silent freeze or stretching.

The `captions` array may be empty for this format. When captions are selected, they reproduce the complete approved script and carry contiguous `word_start_index` / `word_end_index_exclusive` values tied to accepted Whisper timing and narration placements. Captions remain separate timeline overlays and are never baked into generated backgrounds or other source assets. Full speech is consumed in source order; the final fractional video frame contains silence, not clipped or stretched speech. Host poses need actual alpha channels. There is no default extra score/SFX.

## Verification

`npm run test:avatar-pilot-asset-revision` verifies synthetic pre-approval revisions, exact changed-row scope, locked providers, immutable original inputs, stale/incomplete refusal, effective-plan approval/media binding and zero provider spend. It does not revise a real episode or generate media.

`npm run test:avatar-pilot-review` covers the retained raw-review candidate, exact PCM listening mapping, no-restitch finalization, no-synthesis producer, and workflow continuation. It never records a real listening decision or calls a speech provider.

`npm run test:avatar-pilot` runs isolated fixture approvals, stale/no-bypass checks, source/provider/voice import validation and an actual synthetic 90-second FFmpeg composition. `npm run test:avatar-pilot-opening` additionally covers full-source planning, phase gates and actual Python pre-model checks, original execution provenance, opening finalization, technical validation and producer/workflow orchestration without models or paid calls. `npm run test:avatar-pilot-narration` runs seven provider-free suites: remaining execution/preservation, full finalization, full technical validation, listening/timing acceptance, producer orchestration, workflow state transitions and accepted-narration media validation. They cover stale approvals, exact preserved opening bytes, separate real phase identities, pending candidates, full listening, immutable timing, and no replay. Fixtures establish implementation behavior only, never real Joel delivery, listening acceptance or source permission.
