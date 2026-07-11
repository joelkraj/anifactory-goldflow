# Goldflow Pipeline Remediation Proof

Date: 2026-07-11  
Branch: `codex/goldflow-pipeline-remediation`  
Runtime commit locked by `run_identity_v2`: `0eb4b6d44110a3b7590adf60abe371a9132d9876`  
Stage registry: `2026-07-11.3`

## Verdict

The isolated 0-300 second remediation proof passed every production stage through final QA. Upload packaging was intentionally not created because it is outside the proof contract. No official full episode was regenerated or rewritten.

The upload-safe proof render is:

`/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W28-weakest-extra-remediation-proof-v1/episodes/ep_01/assets/renders/ep_01-53rebirth-goldflow.mp4`

SHA-256: `74af45f77719b373094bbf78d9bbbf1dcfe180f7aec30ccbcf0f664696dcdb4d`

## Scope And Identity

- Run intent: bounded proof.
- Proof scope: `0.000-300.000` seconds.
- Image provider: ModelsLab Flux Klein for references and scene cuts.
- Planning model: `gpt-5.6-sol`, medium reasoning.
- Audio target: narrator-only; SFX, score, ambience, and transition SFX disabled.
- Render profile: `smooth_fast_ken_burns`.
- Source script SHA-256: `0bb90840c25e9b7a56842968295e12792481141a499ba932d2c84730ea88444b`.
- Imported baseline audio and Whisper timing were bounded through `goldflow run import-proof-baseline`; provider calls for the imported baseline were zero.

## Acceptance Results

| Contract | Result |
| --- | --- |
| Transcript coverage | 144 exact Whisper-bound atoms, 1,022 covered words, zero alignment findings |
| Beat continuity | 62 stable span-derived beats, zero time gaps/overlaps, zero word gaps/overlaps |
| Retention rails | 53 holds inside rails, 9 explicit indivisible-beat exceptions, zero unwaived violations |
| Semantic continuity | 12 scenes; 9 entities, 10 locations, 12 props, 8 UI motifs, and 13 state transitions; zero evidence findings |
| Reference Director v2 | 16 selected assets: 5 character states, 6 locations, 2 props, 2 UI motifs, and 1 optional action study |
| Generated references | 15 required standalone refs, all unique native 1024x576 landscape assets |
| Scene image generation | 62/62 complete, all unique native 1024x576 landscape assets |
| Image QA | 51/51 risk cuts explicitly accepted; 11/11 low-risk cuts passed structural QA; zero unresolved blockers |
| Motion | 62 directed intents; 36 slow push-ins, 10 reveal zoom-outs, 7 lateral follows, 9 focus shifts; zero trace blockers |
| Transitions | 47 planned and 47 applied; the remaining 14 beat boundaries are hard cuts; transition SFX disabled |
| Subtitles | 157 events using approved visual-beat script text timed by Whisper |
| Render integrity | 62 images checked, zero duplicate hashes, zero donor recovery, 18,636 motion-trace frames |
| Final QA | Passed with zero stale source hashes and zero blockers |

Nine beats are shorter or longer than their normal retention band only because an indivisible sentence/UI payoff or explicit transition barrier prevents a truthful merge. Each has a recorded `rail_exception`; there are no silent rail violations.

## Media Result

- Duration: `299.983333` seconds.
- Video: H.264 High, 1920x1080, 60 fps, `yuv420p`.
- Audio: AAC LC, 96 kHz stereo.
- File size: 132,840,700 bytes.
- Average bitrate: 3,542,615 bps.
- Narration pace: 204.4 measured WPM under diagnostic policy.
- Narrator-only mix: +3 dB narration gain, -13 LUFS target, -1 dB true-peak target.
- Encoded audio measurement: -15.8 dB mean, -1.7 dB max.
- Final cached replay: 62 motion clips reused, zero generated.

## Provenance And Cost

The append-only execution history contains failed probes and retries as history rather than erasing them after success:

- 110 completed stage calls after the final identity refresh.
- 24 historical failed stage calls retained.
- 83 scoped/repeated calls retained.
- 9 immutable imagegen batches: 6 passed and 3 failed.
- 84 generated image operations: 16 reference operations and 68 scene operations including six scoped scene replacements.
- ModelsLab reference spend: USD 0.0752.
- ModelsLab initial scene spend: USD 0.2914.
- ModelsLab scoped scene-retry spend: USD 0.0282.
- Cumulative image spend: USD 0.3948.
- Immutable imagegen batch wall time: 556.058 seconds.

`production_manifest.json` now treats immutable media batches as the cost authority and subtracts imagegen event cost before combining totals, preventing both missing reference spend and double-counting.

Post-QA cleanup reclaimed 103,062,885 bytes (98.3 MB) by deleting only the silent render and loudnorm staging audio. The final MP4, motion cache, TTS/audio sources, generated media, review sheets, and immutable reports were preserved.

## Official Baseline Integrity

The proof imported a bounded copy from the official `weakest-extra-plot-skill` run. Current official hashes still match the import provenance:

- `script_clean.md`: `0bb90840c25e9b7a56842968295e12792481141a499ba932d2c84730ea88444b`
- `narration_word_timing_ep_01.json`: `e2f1ce9c3b79f4e373d27347b0fba81776e3b23e639a4d17d0d14d0fe874e042`
- `longform_audio_bed_report_ep_01.json`: `97dbd28fb2ef820da07b6c882d47827e74c8787ead176507ef99cc13292b2fe0`
- official narrator-only M4A: `fa6bb4a9a1caa5d5a867e598c2544fba8fb4850b47cb83a90b05ad40b7676e39`

## Bounded Warnings

The 300-second scope ends at a source boundary that leaves a later semantic excerpt truncated. The fact ledger records this and refuses to infer facts beyond the fragment. It also preserves explicit uncertainty around unstated physical traits, Arielle's injury severity, and Leon Raze being mentioned but not physically present. These are evidence constraints, not unresolved blockers.

Generated-image spelling was not used as a rejection criterion, matching the operator-approved QA policy.

## Evidence Paths

- Final QA: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W28-weakest-extra-remediation-proof-v1/episodes/ep_01/final_qa_ep_01.json`
- Production manifest: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W28-weakest-extra-remediation-proof-v1/episodes/ep_01/production_manifest.json`
- Image QA: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W28-weakest-extra-remediation-proof-v1/episodes/ep_01/image_output_qa_ep_01.json`
- Motion plan: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W28-weakest-extra-remediation-proof-v1/episodes/ep_01/motion_edit_plan_ep_01.json`
- Render report: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W28-weakest-extra-remediation-proof-v1/episodes/ep_01/render_report_ep_01.json`
- Opening caption contact sheet: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W28-weakest-extra-remediation-proof-v1/episodes/ep_01/review_samples/final_qa/opening_0_30_locked_captions.jpg`
- Full five-minute contact sheet: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W28-weakest-extra-remediation-proof-v1/episodes/ep_01/review_samples/final_qa/full_5min_contact.jpg`

## Verification

The final evidence gate passed:

- `npm run check`: passed, 68 modules and generated workflow guidance current.
- `npm run test:stage-contract`: passed, 22 tests.
- `npm run test:planner`: passed, 64 tests.
- `npm run test:media`: passed, 23 tests.
- `npm run test:integration`: passed, provider-free preflight through final QA.
- `git diff --check`: passed.
- Post-cleanup `goldflow run status`: every stage through `final_qa` passed; upload packaging intentionally remains missing.
