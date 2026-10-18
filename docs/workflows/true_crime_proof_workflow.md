# CrimeDungeon private hybrid proof

This dedicated adapter implements a private audiovisual review candidate for the [hybrid editorial format](../designs/true_crime_hybrid_format_v2.md). It is separate from the reserved `source_footage_v1` production route and from the avatar pilot. It does not enable a full episode, approve a candidate, or publish. Its contract is `true_crime_proof_v1` + `true_crime_hybrid_proof_v1`, version `2026-09-08.1`.

The initial proof uses narrator paraphrase, an exact document reading, documentary excerpts and illustrative cutouts. It does not synthesize a suspect or officer voice. The program budget is 90–150 seconds at 1920×1080, 30 fps. Narration may be shorter; actual measured speech and purposeful reading time determine the edit. No stretch, forced 120-second duration or silent substitution is authorized.

## Guarded API

[The workflow module](../../scripts/lib/true-crime-proof-workflow.mjs) exposes these entry points for the CLI/controller:

```js
await preflightTrueCrimeProof({ proofDir, repoDir, identity,
  allowDirtyWorktree: false, dirtyReason: "" });
await trueCrimeProofStatus({ proofDir });
await runTrueCrimeProofStage({ proofDir, stage, inputs: [], producer });
```

The stage order is `source_assets` → `narration` → `program_review`. Every call uses an explicit absolute proof directory. Status rechecks current identity, source, code, result and upstream artifact hashes. A successful source-assets stage records `candidate_ready`; narration and program remain `awaiting_review`. A narration candidate may feed the private program candidate so the whole program can receive a joint listening/viewing review. No stage grants approval or production/release eligibility.

The injected producer receives `{identity, identity_sha256, plan, scriptText, proofDir, stage, outputDir, inputs, upstream}`. It must independently enforce its media/provider contract and return actual files under the supplied empty output directory:

```js
{
  artifacts: [{ id, path, sha256, kind, source_ids?, source_text_sha256? }],
  metadata: { /* stage-specific evidence described below */ },
  cost_usd: 0,
  acquired_sources: []
}
```

The controller records the attempt before invoking a producer. It validates returned files, rechecks inputs, retains an immutable producer result and stage receipt, and appends immutable reports plus an execution event. A thrown producer or failed validation preserves partial outputs and records `needs_triage`. The existing attempt cannot run again automatically. The first implementation offers no generic repair, override, approval or publishing action.

Report an actual known nonnegative `cost_usd`. For source assets only, a built-in tool that supplies no dollar cost uses `cost_usd:null` with `metadata.cost_status:"provider_cost_not_reported"`; an unavailable cost must not be recorded as zero.

`loadTrueCrimeProofIdentity({proofDir})` is a read-only helper for an injected producer's independent identity/source checks. `trueCrimeProofFileRef(absolutePath)` hashes a regular local file. `formatTrueCrimeProofStatus(report)` provides the text status view.

## Preflight identity

`run_identity.json` records the exact CrimeDungeon channel, stable series/run slugs, episode, title, plan and spoken-script file hashes, selected sources, selected voice/model/reference files, explicit audio targets and source-text authorization. The script must reproduce the plan's spoken lines in order; the editorial Markdown table is not a TTS input.

The requested identity has these fields:

- `schema: "goldflow_true_crime_proof_identity_v1"`, the exact profile/workflow pair, `channel: "crimedungeon"`, `channel_name: "CrimeDungeon"`, `series_slug`, `run_slug`, `episode`, `title`.
- `run_intent: "proof"`, `production_eligible: false`, `publish_allowed: false`.
- `plan` and `script`: `{path, sha256}`. `authorization`: `{operator, authorized_at, note, plan_sha256, script_sha256}`, recording the actual operator instruction and exact reviewed text/plan.
- `sources`: unique `{id, acquisition, locator, use_basis, ...binding}` rows. An existing `research_copy` binds `{path,sha256}`; a selected `pending` source binds its exact public `url` before acquisition; `evidence_only` binds a citation URL and does not require acquired media. No signed URLs, cookies or credentials enter identities or receipts.
- `narration`: `{provider:"qwen_local", model, model_revision, voice_id, voice_sha256, reference_audio:{path,sha256}, reference_text:{path,sha256}}`. No silent provider/voice fallback.
- `audio_target: "narration_with_document_reading"`; `audio_mastering: {sample_rate_hz:24000, channels:1, integrated_lufs:-16, true_peak_dbtp:-1.5}`. These are selected proof targets, not measurements of a reference channel.
- `proof_scope: {min_duration_sec:90, max_duration_sec:150, fps:30, width:1920, height:1080}`.
- Optional `code_files` bind the actual producer/controller implementation files in addition to the workflow and editorial validator automatically bound at preflight.

Preflight checks all existing file hashes and the source/plan/script relationship before any directory or report write. It then adds the canonical workflow contract, actual git commit/branch and a hash of tracked differences plus untracked file contents. Dirty code requires explicit `allowDirtyWorktree:true` and a meaningful `dirtyReason` for this isolated proof. It never overwrites an existing proof. Existing runs keep their own identity and workflow.

## Source assets and external image tools

An existing local research PDF is already acquired; its selected display crop still needs exact output provenance and a use/context review. A URL-only source must be selected at preflight before a producer acquires it. The source-assets result binds newly acquired bytes as `acquired_sources:[{id,url,path,sha256}]`, with the exact selected URL and regular files inside the current attempt. Every pending media source needs this binding; citation-only sources do not.

Every source asset records `source_ids`. An authored silhouette or board may have an empty array; the recipe and labeling must accurately identify it as authored or illustrative. An asset's source provenance and a scene's factual claim references remain separate.

The built-in image tool can be orchestrated across tool calls using:

```js
const started = await beginTrueCrimeProofStage({proofDir, stage:"source_assets", inputs:[]});
// Record the exact request, call the selected tool, inspect and retain the actual outputs.
await finishTrueCrimeProofStage({proofDir, stage:"source_assets",
  attempt_token:started.attempt_token, result});
// On failure, preserve evidence and close this attempt for triage:
// await failTrueCrimeProofStage({proofDir, stage:"source_assets", attempt_token:started.attempt_token});
```

Only `source_assets` exposes this external lifecycle. A durable operation lock and the exact attempt token prevent a concurrent start, wrong-token finish or completed-stage overwrite. An open attempt is reported as `running`; a failed closed attempt requires triage.

If selected, the identity's `providers.stills` is exactly `{provider:"openai_builtin_imagegen", model:"tool_managed", operations:["background_extraction","illustrative_detective"], max_submissions:2}`. Other image providers, duplicate operations and extra submissions are unavailable. Before each actual tool call, retain the source-bound request under the attempt. The result's `metadata.generation_submissions` binds each `{operation,provider,model,request:{path,sha256},result:{path,sha256},output:{path,sha256}}`. The controller verifies these receipts again on continuation. Tool outputs and actual asset quality still require inspection; recording a result is not approval of it.

## Narration and program candidates

Narration production preserves the [narration-quality contract](narration_quality_v2.md), exact script words, voice/model/reference lineage, one creative submission per scoped unit and retained raw outputs. A producer's technical checks cannot record a listener's subjective decision.

The narration result includes `narration_audio` and `narration_receipt` artifact kinds. Its metadata binds `source_text_sha256`, the exact `{provider,model,model_revision,voice_id,voice_sha256}`, positive `measured_duration_sec` no greater than 150, `tempo:1`, and `technical_qa:"passed"|"needs_review"`. It remains a complete narration candidate awaiting listening. Unit, reference, ASR, edge and waveform validation belongs in the actual narration producer; this orchestration contract does not mistake a JSON field for a media measurement.

The program result includes `program_video` and `program_qa` kinds. Metadata binds the same script hash, measured 90–150-second duration, `tempo:1`, `whole_narration_preserved:true` and explicit technical QA state. The actual renderer must validate complete source-order speech coverage, real durations, readable labels, purposeful holds, independent layer movement and final frame/audio integrity. It retains the measured timeline and QA evidence. The final candidate requires whole-program viewing/listening; successful encoding does not complete that review.

## Separate recovery of the first retained program

The first CrimeDungeon program attempt retained a correct 2,802-frame/93.4-second video but an incorrect 46.7-second AAC stream, plus clipped labels on four cards in S05/S06. Its identity, source-assets receipt, narration receipt, attempted render input, timeline and failed output remain immutable. The original workflow records `program_review: needs_triage`; its frozen code is not changed while recovering this candidate.

[The separate layout/audio repair helper](../../scripts/true-crime-proof-layout-repair.mjs) implements only the exact scope `S05_S06_card_line_layout_and_program_audio_only`. It requires a closed failed program attempt, current identity/upstream hashes, the retained 2,802-frame video and expected half-duration AAC fault. The recipe binds the failed start record, video, original manifest/timeline, complete source narration and visual QA frame evidence. It refuses an active operation, changed card text/geometry/choreography, a different proof shape or an existing recovery directory.

The one recovery directory is `program_review_repairs/card-layout-audio-v1/` beneath the existing proof. The helper records its request, recipe hash, adapter/helper hashes and started event before local rendering, and preserves failed recovery outputs for triage. Its operations are:

1. Replace four exact card swept rectangles only during S05/S06. Retain the words and authored entrances; render two-line text after measuring its bounds. The existing encoded video is reencoded once, with sampled masked PSNR checking picture quality outside those rectangles. This is not a rerun of every scene through the original renderer.
2. Use the [pure program-PCM repair helper](../../scripts/lib/true-crime-proof-program-audio-repair.mjs) to copy each original 24 kHz narration sample exactly once, in order, around the already authored holds. For this attempt, 63.38 seconds of complete narration plus 30 seconds of holds and 0.02 seconds of frame padding produces 93.4 seconds of program PCM. No resampling, gain, tempo change or speech synthesis occurs in this placement step.
3. Encode new AAC from the complete program PCM, verify audio/video duration and frame count, inspect bounded output frames, then rehash original inputs and repair code before writing the final repair report. Original speech remains at its retained unmastered level; this operation does not resolve narration delivery/mastering review.

The exact request is invoked only through this guarded recovery entry point after inspecting the retained failure:

```sh
node scripts/true-crime-proof-layout-repair.mjs /absolute/proof/program-layout-audio-repair-request-v1.json
```

This is a specifically scoped recovery adapter, not a workflow bypass, generic retry or permission to invoke other underlying production scripts. It creates no `program_review.json`, changes no existing identity/receipt and grants no approval or publishing authority. Its append-only local events, immutable `request.json`, `program-audio-accounting.json` and `repair-report.json` preserve the recovery evidence separately.

A successful repair report has `status: candidate_ready_needs_review` and `repair_technical_qa: passed`. It separately binds `source_narration_stage` and carries its actual `narration_technical_qa`, mastering state and absent human listening decision. Thus a scoped repair pass cannot conceal the retained narration's `needs_review` findings. The recovered output is still awaiting whole-program viewing/listening.

Read the frozen `run status` and the current recovery receipt together. Base state remains `needs_triage`; the separate receipt identifies a recovered candidate only after the report exists and its source/output hashes verify. A supplemental read-only candidate index or status reader may expose both states and the output link. It must not rewrite the original stage, claim the repair report itself is a final approval or silently select an unverified output file. The [execution README](../../research/chandler-halderson-development/proof-execution-v1/README.md) records the current attempt and actual completion state.

## User-directed pacing revision

After viewing the corrected 93.4-second cut, the user explicitly requested shorter gaps: “why is it o slow between narrations. too much silence. we need to cut those down.” This authorizes a separate private pacing revision that removes most of the 30 seconds of added post-speech holds. It does not authorize changing spoken words, speeding up narration, new synthesis, mastering or publication.

The selected remaining post-speech holds for S01–S07 are `[0, 0, 0, 0.35, 0, 0, 0.5]` seconds. Preserve the complete 63.38-second source narration, including its existing internal joins. Round each scene's new duration upward to complete 30 fps frames. The resulting planned scene frame counts are `[297, 328, 201, 125, 282, 369, 330]`: **1,932 frames / 64.4 seconds**, comprising 63.38 seconds of unchanged source audio, 0.85 seconds of selected holds and 0.17 seconds of frame rounding.

This shorter duration is an explicit supplemental change requested after the user saw the proof. It does not rewrite the original identity's 90–150-second scope or change what its frozen validator accepts. Record the exact user feedback, new scope, corrected source MP4/repair-report hashes, source narration and source/new frame mapping in a new guarded revision receipt. The 93.4-second recovered version and every preceding artifact remain available.

The [separate guarded pacing helper](../../scripts/true-crime-proof-pacing-revision.mjs) binds the corrected candidate, repair report/index, original narration, source timeline and exact user feedback. It writes to one new `program_review_repairs/pacing-v2/` directory and preserves every earlier attempt. Its scene-window selection retains every source speech sample and all caption-bearing speech windows, takes video only from the corresponding corrected scenes, and bounds picture phase adjustment at each new join to less than one 30 fps frame without cumulative drift. The only material removed is the specified added silence.

A completed pacing candidate needs actual frame/audio-duration verification, inherited narration QA warnings and fresh whole-cut review; the expected 64.4-second calculation alone is not a completed render. Its `pacing-report.json` records the supplemental duration exception and actual source/output bindings. The supplemental candidate index may point to this version only after that receipt and its outputs verify. Base workflow status remains unchanged.

The actual pacing-v2 render subsequently passed its video/audio-duration, complete-source PCM, AAC alignment and mapped-frame checks. Its retained `pacing-candidate-index-v2.json` identifies the 64.4-second private review candidate. Listening and final mixing remain pending; this completed edit grants no production or release eligibility.

## Reference-informed picture and sound revision

The user then accepted the [reference study and edit plan](../../research/dr-insanity-proof-edit-review-2026-09-08/README.md) with “lets do it.” The separate [editorial revision adapter](../../scripts/true-crime-proof-editorial-revision.mjs) preserves the pacing candidate's exact 64.4-second program, all 191 spoken words, the original narrator waveform and 28 caption intervals. It authors 18 picture shots using only the seven retained source/illustration assets. It adds focused source strips, independent cutout motion, a stable document reading and a date comparison revealed at retained spoken-word cues. No additional case facts, faces or dialogue are generated.

This supplemental request binds the earlier candidate/index/receipt, approved script and source assets, reference brief, retained ASR/timing evidence and the exact original audio recipe. It writes only to the new `program_review_repairs/editorial-v3/` directory. Preparation records measured layouts, preview frames, caption PNGs, an original locally synthesized underscore, one soft tonal accent and separate PCM stems. Every narrator sample remains at unity gain: subtracting the retained accompaniment from the mix recovers the input program PCM exactly. The bed is set 20 dB below measured active narration, dips a further 9 dB during the document reading and has one accent at 52.1667 seconds. There are no provider calls or new voice synthesis.

```sh
node scripts/true-crime-proof-editorial-revision.mjs prepare /absolute/proof/program-editorial-revision-request-v3.json
node scripts/true-crime-proof-editorial-revision.mjs render /absolute/proof/program-editorial-revision-request-v3.json /absolute/proof/program_review_repairs/editorial-v3/preview-review.json
```

The second command requires a hash-bound technical review of actual prepared previews, then renders into a separate empty picture directory and muxes the new mix. It checks 1,932 picture frames, 64.4 seconds of video/AAC, source and code hashes, and the unchanged canonical status. Existing preparation/render directories cannot be rerun or overwritten. The retained caption text is rendered through measured PNG overlays, so FFmpeg does not require libass. Encoded QA frames must also be inspected because prepared previews omit captions.

The actual editorial-v3 candidate completed with scoped technical checks passing. Its `editorial-report.json` and supplemental `editorial-candidate-index-v3.json` identify the review version without creating a canonical `program_review.json` or changing the original identity. Independent PCM and AAC checks and sampled encoded-picture review remain separately recorded. Narration delivery findings and mastering remain unresolved; successful composition and encoding do not establish whole-program viewing/listening approval or release eligibility.

Focused provider-free tests are `scripts/tests/true-crime-proof-editorial-{audio,visuals,revision}-tests.mjs`. They cover reversible sample accounting and levels, delayed evidence markers, measured text and real synthetic caption/motion encoding, and no-write request refusals. Fixtures are distinct from actual proof QA.

## Verification and later production

Run `node scripts/tests/true-crime-proof-workflow-tests.mjs`. Provider-free fixtures cover invalid preflight/no writes, explicit dirty proof scope, exact text/source/code binding, stage order, stale media, failed-attempt preservation, no retries, acquisition provenance, external attempt tokens and image-receipt integrity. These tests use synthetic byte files and never call models or claim actual narration/render quality; producer tests supply their own media/quality verification.

The recovery has separate provider-free tests: `node scripts/tests/true-crime-proof-layout-repair-tests.mjs` verifies exact card scope, text/motion refusal, measured text bounds and a synthetic FFmpeg patch; `node scripts/tests/true-crime-proof-program-audio-repair-tests.mjs` verifies sample order, all authored silence positions, exact final padding and invalid timeline/sample-rate refusal. These fixtures do not establish completion or acceptance of the real recovered program.

Accepting a private treatment does not enable a full upload. Full production needs its applicable true-crime workflow and packaging contracts, factual/source-context review, exact script/media/package decisions, final QA and the established private-first upload/public-release chain. This private adapter has no command that grants those authorities.
