# CrimeDungeon private footage proof

This isolated adapter implements the September 9, 2026 request to build a new Lindsay Clancy proof from existing recordings. It does not change the retained Halderson identity, narrator-only proof, renderer or recovery artifacts. Its identity is `goldflow_crime_footage_proof_identity_v1`, with `true_crime_proof_v1` + `crime_footage_private_proof_v1`, version `2026-09-09.1`. This is a dedicated private entry point, not an override of `source_footage_v1` or permission to run generic production stages.

The supported program is 90–150 seconds, 1920×1080, 30 fps. It uses selected original courtroom video/audio, short source-backed bridges from the existing owned Joel Qwen narrator, authored graphics and original-audio transcript cards. It does not synthesize the 911 call or any suspect, officer, witness or other real-person voice. No new image provider, automatic media dispatch, creative retry, upload or publishing action is enabled.

## Identity and editorial input

Before acquisition or synthesis, lock the exact channel, run, episode, title, editorial plan, narrator-only text, public source URLs, bounded source windows, scoped use basis and pinned narrator/model/reference files. The complete `execution_authorization` records the actual user instruction and its scope. It is **not** exact-script approval or a claim that the user has heard the narration. Stored review fields remain false.

The new plan schema is `goldflow_crime_footage_proof_plan_v1`. Its `narration_units` hold only words to synthesize, each with an ID and factual source references. Its scenes independently declare `picture_origin` and `audio_origin`, selected source-window references and narrator-unit assignments. Every narrator unit must be assigned exactly once in order. Actual program timing follows measured source and narration durations; the plan budget is not a reason to add silence.

Selected video windows have exact public URLs and start/end seconds. There are at most 16 windows, each at most 150 seconds, with at most 300 selected source seconds. Evidence-only sources have no media windows. Source acquisition returns exact bytes and durations for those windows. A measured end-of-source deficit of at most one second is accepted only with an explicit `end_of_source_truncated:true` and matching `actual_duration_sec`; this does not authorize a renderer to read beyond the actual file.

An original-audio transcript may remain unselected when the plan is locked, so footage can be acquired and listened to first. Before rendering, retain a separate, hash-bound transcript-review array with exact `scene_id`, `text`, `speaker`, `source_id`, `window_id`, `verified:true`, `reviewer` and `method`. That check attests the selected words against their source; it is not whole-program approval. The final transcript card must use those exact words and original recorded audio.

## Commands and guarded external lifecycle

Only the new entry point runs this identity:

```sh
node scripts/crime-footage-proof.mjs preflight --identity /absolute/identity.json --episode-dir /absolute/new-proof --allow-dirty-worktree true --dirty-reason "Explicit isolated private footage proof; preserve concurrent work."
node scripts/crime-footage-proof.mjs status --episode-dir /absolute/new-proof --format markdown
node scripts/crime-footage-proof.mjs begin --episode-dir /absolute/new-proof --stage source_assets --inputs /absolute/input-refs.json
node scripts/crime-footage-proof.mjs finish --episode-dir /absolute/new-proof --stage source_assets --attempt-token EXACT_TOKEN --result /absolute/result.json
```

The stage order is `source_assets` → `narration` → `program_review`. Use the returned next stage; reread this adapter's status after completion. `--inputs` is a JSON array of exact `{path,sha256}` file bindings. Bind source acquisition recipes, producer code, narrator code, render manifests and transcript reviews before their corresponding dispatch. The controller and CLI are automatically hash-bound at preflight. Adding a producer in a stage's input set avoids changing a preflight identity while still binding the exact code used for that stage.

`begin` creates the exclusive attempt marker, empty output directory and operation lock and returns the exact token. An external tool or dedicated producer runs only after this point. The producers independently call `loadCrimeFootageProofAttempt({proofDir,stage,attemptToken})` before media work. They preserve partial results if interrupted. `finish` verifies files, input hashes, scope and actual media durations before recording immutable candidate receipts. It does not approve them.

Use the same lifecycle for `narration` and `program_review`. The Qwen producer generates only exact selected narrator units through the existing generic pre-synthesis and quality components. It cannot use the old seven-scene compiler or substitute recorded dialogue into narrator metadata. The renderer binds every final source subwindow to an accepted source asset and every narrator passage to a complete retained unit WAV. Original audio and generated narration retain separate provenance.

A failed producer is closed for triage with:

```sh
node scripts/crime-footage-proof.mjs fail --episode-dir /absolute/new-proof --stage source_assets --attempt-token EXACT_TOKEN --note "Describe the actual failure and retained outputs."
```

There is no restart or overwrite command. A result-validation refusal keeps the current attempt and files inspectable; correcting receipt data does not authorize another creative or acquisition submission. A closed failed attempt remains `needs_triage`.

## Result contracts

Every result has `artifacts`, `metadata` and `cost_usd`. Artifact rows are `{id,path,sha256,kind,source_ids}` and must live below the current attempt output directory. Record actual known cost. Only source acquisition may record `cost_usd:null`, with `metadata.cost_status:"provider_cost_not_reported"`. Never replace an unavailable cost with zero, or retain signed download URLs or credentials.

Source metadata includes `source_windows` rows binding `source_id`, `window_id`, `artifact_id`, `public_url`, `acquisition_method`, selected `source_start_sec`/`source_end_sec`, `audio_origin:"original"` and measured duration. The corresponding artifact kind is `source_video`; both its video and audio streams are probed.

Narration metadata includes the script hash, exact voice/model lock, `tempo:1`, technical QA state and ordered `units` rows `{id,artifact_id,text,text_sha256,measured_duration_sec}`. Each `narration_unit` artifact must be actual 24 kHz mono PCM16 WAV. Preserve a `provider_receipt` and actual Qwen lineage/QA artifacts. Program assembly preserves every complete unit; synthesis is never stretched to fit a paper budget.

Program metadata includes the exact script hash, `tempo:1`, `whole_narration_preserved:true`, `original_audio_preserved:true`, measured duration, technical QA, the pre-bound `render_manifest` reference and, when needed, `transcript_review`. Required artifact kinds are `program_video` and `program_qa`. The controller independently probes dimensions, frame rate and aligned picture/audio durations and validates the manifest's source/narrator bindings. The producer supplies additional sample accounting, text measurements, preview frames and render checks.

## Verification and review boundary

```sh
node scripts/tests/crime-footage-proof-workflow-tests.mjs --source-only
node scripts/tests/crime-footage-proof-workflow-tests.mjs
```

Provider-free tests exercise actual synthetic MP4/WAV files, invalid preflight with no writes, exact text/source bounds, stage order, wrong tokens, immutable completed stages, separate audio origins, a complete private source-footage flow and failed-attempt preservation. They do not load Qwen, acquire real footage, verify Clancy facts, measure real narration quality or establish listener approval.

All completed narration/program stages remain `awaiting_review`; a complete program is `awaiting_program_review`. Encoding success and an operator's instruction to build are distinct from whole-cut viewing/listening acceptance. The adapter provides no full production, channel creation, release or publishing authority.

## Retained Clancy audio correction

The Clancy proof-v1 HD acquisition selected an Arabic alternate track for V03 because its frozen acquisition runner sorted audio formats by bitrate without language. Do not reuse that artifact as original court audio or treat that runner as a general production downloader. The original English same-window recording is retained in the initial source preview. The [specific proof-v2 carry-forward repair](crime_footage_carry_forward_repair.md) preserves valid footage and already generated narration, verifies picture correspondence, and copies the original English audio stream into the HD picture without new acquisition or synthesis. Its retained language audit and packet/decoded-audio checks are required provenance for the corrected candidate.
