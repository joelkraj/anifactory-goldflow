# Goldflow Time and Quality Audit

Date: 2026-07-10

Audited production:

- Run: `2026-W28-weakest-extra-plot-skill-v1/episodes/ep_01`
- Final render: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W28-weakest-extra-plot-skill-v1/episodes/ep_01/assets/renders/weakest-extra-plot-skill-system-ui-recovered-smooth-fast.mp4`
- Final QA: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W28-weakest-extra-plot-skill-v1/episodes/ep_01/final_qa_system_ui_recovery_ep_01.json`

## Executive Verdict

The finished episode is visually strong enough to publish. Its final Flux image set is varied, consistently anime/manhwa styled, correctly landscape, and free of exact duplicate images. The smooth-fast motion profile is also a keeper. The final audio is loud and stable.

The production process was not efficient. The largest avoidable costs were:

1. A failed premium scene-image route and prolonged recovery attempts.
2. A full-episode prompt-review stage that consumed about 54 minutes, changed hundreds of prompts, found very few clearly actionable blockers, and still did not prevent the action errors later caught after image generation.
3. Overbuilt reference and prompt payloads that spend model attention describing the pipeline instead of directing the frame.
4. A render path that repeatedly encodes the same full-length video and creates thousands of subtitle PNGs because the active FFmpeg lacks libass.
5. Stage-wide waiting and reruns where cut-scoped, streaming work would be faster and safer.

The best default is therefore:

**Remove full-episode LLM prompt review from the normal production path. Keep structural hardening, then spend the saved time on post-generation visual QA and scoped regeneration of actual failures.**

Generated text inside images is explicitly not treated as a quality defect in this audit. It should not block, trigger regeneration, or consume review time.

## Implementation Status

Implemented on 2026-07-10 without regenerating the audited production episode:

- Provider-native Qwen speed is locked at preflight (`1.25` default), recorded in cache/report provenance, and used for pace recovery. Post-TTS tempo normalization is emergency-only.
- Full-episode visual prompt review is removed from the default path. Harden runs first; compatible blockers route to cut-scoped review, and optional review writes a value report.
- Reference allocation now scores beat reuse and reuse span, clean conditioning-reference contracts replace busy design-sheet prompts, and conditioning paths flow through planning, approval, harden, and imagegen.
- Scene and reference cache keys include attached reference hashes.
- ModelsLab defaults to concurrency 15. Premium routes have representative probes and both scene/reference queues use a provider circuit breaker.
- Imagegen writes a cut execution ledger. Post-generation QA creates ordered contact sheets, checks structural integrity, requires first-three-minute/risk-cut approval, and routes rejected ids back to their actual provider.
- Donor-copy/hash-perturbation recovery is prohibited; explicit editorial reuse requires provenance.
- Phrase-aware subtitles reduce the audited episode from 2,616 events to 2,041, with median six words and 17 one-word events (0.83%).
- Smooth-fast Ken Burns is the default. Motion clips are hash cached, compliant concat streams skip normalization encode, audio is normalized before final mux, and Homebrew `ffmpeg-full`/libass is auto-selected when available.
- Post-QA cleanup can reclaim obsolete full-length render intermediates while preserving the motion cache. The audited episode currently reports 3.9 GB reclaimable in dry-run mode.

Deferred as separate follow-up architecture, not default-path blockers: streaming prompt chunks directly into concurrent imagegen/motion work, and automatic multi-variant generation/selection for opening hero cuts.

## Measured Baseline

| Area | Observed result |
| --- | --- |
| Final runtime | 60:03.8 |
| Final format | 1920x1080, H.264, 60 fps, AAC stereo |
| Final loudness | -13.0 LUFS, -1.7 dBFS true peak, LRA 2.8 |
| Actual spoken pace | 207.5 WPM |
| Visual cuts | 388 |
| Subtitle events | 2,616 |
| Initial end-to-end elapsed time | About 28 hours, including failed provider work and recovery |
| Initial visual prompt authoring | About 36 minutes, 97 chunks at concurrency 6 |
| Full visual prompt review | About 54 minutes, 65 base chunks plus two resolution iterations |
| Final Flux scene-image wave | About 48 minutes wall time at concurrency 15 |
| Final Flux scene-image cost | About $1.82 for 388 cuts |
| Final reference cost | About $1.92 for 24 GPT Image 2 references |
| Total accepted image cost | About $3.74 |
| Final render family | `smooth_fast_ken_burns` |
| Episode storage | About 14 GB |
| Render-work storage | About 5 GB |
| Rerun archives | About 1.9 GB |

The 28-hour elapsed time is not representative of healthy provider throughput. Once the final Flux batch began, all 388 scene images completed in roughly 48 minutes. The process lost hours to provider instability, retries, stage restarts, and inspection after the fact.

## What Worked

### Final Visual Set

- All 388 accepted scene images are native 1024x576 landscape Flux Klein outputs.
- 388 unique SHA-256 hashes were present.
- Perceptual duplicate checks found no pairs at a dHash distance of 3 or less and only two pairs at 5 or less.
- The final contact sheets show broad environment, composition, and action variety.
- No meaningful photorealistic style drift remained in the accepted final set.
- The protagonist, recurring cast, and central academy visual language are generally stable.
- The 11 action failures identified after generation were repaired successfully with scoped, action-first prompts.

### Beat Pacing

- The first 30 seconds use 9 cuts at a 3.55-second average hold.
- From 30 to 180 seconds, 29 cuts average 5.31 seconds.
- After the opening, average holds settle around 9.6 to 9.9 seconds.
- The episode uses 73 distinct local location labels.
- Repeated location blocks still vary their shot jobs; the longest identical location-plus-job run is only 3 cuts.

This is a good pacing shape for longform retention: fast opening, stable middle, and enough visual variety to avoid a pure slideshow rhythm.

### Image Generation

- ModelsLab Flux at concurrency 15 was reliable once selected as the final route.
- Median provider service time was about 49 seconds per cut while 15 jobs ran in parallel.
- Reference count had only a moderate latency effect. Four-reference cuts had a median service time of about 63 seconds versus 30 seconds for text-only cuts.
- There is no reason to impose a lower reference cap solely for speed. Attach every reference that materially improves the cut, up to the existing four-reference limit.

### Motion And Audio

- The `smooth_fast_ken_burns` profile provides a useful mix of zoom-out exposure, controlled push-ins, diagonal movement, and lateral motion.
- The profile avoids the micro-shake problem seen in older motion paths.
- Final narration loudness is strong and consistent.
- Narrator-only audio worked well for this story and should remain the default unless the operator opts into sound design.
- The system-dialogue recovery reused 242 unchanged narration segments instead of regenerating the whole episode. That is exactly the resumability behavior Goldflow should preserve.

## Where Quality Is Still Being Lost

### 1. Reference Images Are Often Human-Readable Design Sheets, Not Clean Conditioning Assets

The final reference sheet is attractive, but several references contain multiple faces, multiple poses, labeled equipment, multiple silhouettes, or multi-character lineups. Those are useful for a human art bible but ambiguous for an image model.

Examples include:

- Character cards with a full body plus several face insets.
- Creature sheets with multiple silhouettes or angles.
- Prop plates with several object views and labels.
- Group references that contain several identities in one frame.

This can transfer card layouts, extra heads, unwanted panels, or mixed identities into scene cuts.

Recommended change:

- Preserve a rich `reference_master` for human review.
- Create a separate `conditioning_image` for generation.
- A character conditioning image should contain one person, one canonical pose, one wardrobe state, and a plain background.
- A creature conditioning image should contain one canonical creature silhouette and texture treatment.
- A prop conditioning image should contain one object and a clear scale cue.
- A location conditioning image should contain clean architecture with no featured people or foreground props that could contaminate later cuts.
- Only `conditioning_image` should be attached to Flux or another scene-image provider.

This improves conditioning without discarding the useful design sheets already produced.

### 2. Reference Allocation Is Unbalanced Toward Props And Away From Recurring Locations

The director inventory indexed 706 possible assets, but the final prompt-facing reference plan contained only 24 standalone targets:

- 15 character states
- 7 props
- 1 UI target
- 1 location

For a 60-minute episode, one location anchor is too little. Harden recorded 368 location-undercoverage warnings across the 388 cuts. Text prompts carried most environment continuity, and the final images happened to remain varied, but the plan left consistency to provider luck.

The fix is not a fixed location quota. Use a continuity value score:

`continuity value = cut count x story salience x drift risk x reuse span`

A courtyard used for 19 cuts, a recurring hall used for 10 cuts, or a distinctive alternate-world street used for 12 cuts should normally outrank a minor prop used once or twice.

Recommended reference balance for a similar episode is roughly:

- Keep all necessary recurring character identities and major states.
- Generate dedicated clean location anchors for the 7-12 highest-value recurring environments.
- Keep only story-critical recurring props as standalone references.
- Use text-only handling for ordinary one-scene props.
- Use derived cut anchors only for minor recurring locations where a clean first cut can be guaranteed. Major locations should receive dedicated environment-only references.

The director inventory should remain value-driven rather than capped. Thirty useful references are better than twenty-four references allocated to the wrong things.

### 3. Prompt Authoring Is Overloaded

The authored ModelsLab prompts average about 1,084 characters. The submitted payload averages about 1,676 characters and 248 words after provider wrapping. The wrapper adds about 592 characters per cut.

Observed duplication includes:

- 351 prompts containing redundant `Name: Name` constructions.
- 354 prompts repeating the same final style suffix.
- Character identity and wardrobe instructions appearing both in authored prose and again in the provider reference-role wrapper.
- Human-specific reference vocabulary being applied to creatures and groups.

The prompt author currently receives a very large static instruction block plus long few-shot examples. This makes every call slower and increases the chance that the LLM follows a secondary formatting rule instead of the exact story beat.

Recommended author contract:

1. Show the exact local narration excerpt.
2. State the single visual job of the cut.
3. Provide visible characters, exact states, action, current location, and selected reference roles.
4. Ask for one coherent frame with the best composition for that moment.
5. Keep the anime/manhwa style instruction concise and present once.
6. Add special guidance only when the cut actually has contact geometry, a crowd, multiple characters, a UI focal point, or another known risk.

Target a submitted Flux prompt of roughly 90-180 words for normal cuts. This is a complexity target, not a hard truncation limit. Difficult action cuts may be longer.

Provider reference-role language should be type-aware:

- Human: face, hair, body, wardrobe, and identity.
- Creature: anatomy, silhouette, texture, markings, and eyes.
- Group/faction: uniform palette, insignia, equipment, and silhouette variety.
- Location: architecture, materials, layout, scale, and lighting language.
- Prop: shape, material, scale, and defining markings.

The deterministic layer may assemble these approved fields, but it must not invent creative content.

### 4. Action Geometry Is Best Judged After Generation

Post-generation inspection found 11 meaningful action failures, or about 2.8% of the episode. Scoped action-first regeneration repaired them.

The critical lesson is that prompt correctness does not prove image correctness. A reviewer can approve a perfect description of a person lifting a carriage while the generated image still places the body, axle, and hands incorrectly.

Post-generation QA should compare the actual output against:

- Exact beat excerpt.
- Visible-character list.
- Character state and wardrobe refs.
- Physical action and contact geometry.
- Current location.
- Subject count and role placement.
- Anime/manhwa style.

The first three minutes and all high-risk physical-action cuts should receive direct frame-by-frame inspection. The remaining cuts can be checked through ordered contact sheets, with scoped full-resolution inspection for anything suspicious.

### 5. TTS Reaches The Right Pace Through Too Much Tempo Correction

The raw stitched narration was approximately 161 WPM. It was normalized by a factor of about 1.289 to reach 207.5 WPM.

The final result is acceptable, but a 29% tempo increase can thin the voice, compress emotional beats, and make long episodes tiring. Goldflow should still target 195-220 actual spoken WPM, but it should obtain more of that pace from the TTS performance itself.

Recommended change:

- Keep actual WPM as the production measure.
- Add a diagnostic warning when tempo correction exceeds approximately 1.18x.
- Improve Qwen pacing direction, segment size, and narrator delivery before relying on a larger atempo correction.
- Preserve the original narrator identity and loudness recipe.
- Always rerun Whisper timing after any stitch or tempo change.

### 6. Subtitle Grouping Is Too Fragmented

The final render has 2,616 subtitle events:

- Average: 4.35 words per event.
- Median: 4 words.
- 405 one-word events.
- 830 events with two words or fewer.

Many one-word events are accidental articles, prepositions, or sentence fragments. This creates visual flicker and makes the edit feel more automated than the images and motion deserve.

Recommended subtitle post-pass:

- Merge accidental one- and two-word fragments with a neighboring phrase when the result remains under about 10 words and 3.2 seconds.
- Avoid orphan articles, conjunctions, and prepositions.
- Preserve intentional one-word emphasis.
- Keep bracketed system lines together as atomic phrases when possible.
- Target a median of 6-7 words per event and fewer than 2% accidental one-word events.

This would improve readability and reduce subtitle render work substantially.

### 7. Render Performs Too Much Full-Length Work

The current render path creates or retains:

- About 1.1 GB of motion clips.
- A 944 MB silent video.
- A 1.0 GB normalized silent video.
- A 1.4 GB pre-final-audio MP4.
- A 542 MB subtitle overlay movie.
- Thousands of rendered subtitle PNGs.

The active FFmpeg build lacks the `ass`/`subtitles` filter, so Goldflow falls back to Sharp-generated PNG subtitles and a large qtrle overlay movie. It also performs redundant full-length normalization and final mux stages.

Recommended change:

- Use an FFmpeg build with libass.
- Skip the normalized-silent-video encode when motion clips already share the required stream properties.
- Normalize the final audio before the final mux.
- Burn ASS subtitles and mux final audio in one final video encode.
- Cache motion clips by image hash, timing, and motion-profile hash.
- Run safe cleanup after final QA to remove regenerable render intermediates.

The target for a healthy 60-minute episode is a 30-45 minute final render and less than 2 GB of retained render work after cleanup.

## Was Full Visual Prompt Review Worth It?

For this run, no.

Measured review behavior:

- About 54 minutes of wall time.
- 65 base chunks plus two auto-resolution iterations.
- 957 findings.
- 341 of 388 records changed in some field.
- 265 ModelsLab image prompts changed.
- Only about two blockers looked clearly actionable after manual audit.
- Several blockers were generic-group, layout, or missing-location false positives.
- The review still finished blocked and required manual repair.
- Eleven actual action failures were discovered only after image generation.

The review demonstrated activity, but not enough proven output improvement. Changing 265 prompts is not itself value. The useful metric is how many bad final images or costly regenerations the review prevented, and this run did not produce evidence that justified the time.

### New Default Review Policy

1. Do not run full-episode LLM prompt review by default.
2. Run deterministic structural validation and harden only.
3. If harden finds a real blocker, send only those cut IDs to a small LLM repair pass.
4. Optionally run risk-only prompt review for:
   - The first three minutes.
   - Difficult physical-contact actions.
   - Identity-sensitive real-person or public-figure cuts.
   - Dense multi-character frames using four references.
5. Generate images.
6. Move the main quality budget to post-generation frame inspection and scoped repair.
7. Keep full prompt review as an explicit diagnostic mode after a planner or provider change, not as a production toll on every episode.

Every optional review should write a `review_value_report.json` containing calls, wall time, prompt changes, blockers fixed, and downstream regenerations avoided. If avoided failures cannot be demonstrated, the review has not earned a permanent place in the default path.

## Provider Strategy

### Default Scene Provider

Flux Klein through ModelsLab should remain the normal production scene-image route for now:

- It completed all 388 images in about 48 minutes at concurrency 15.
- It cost about $1.82 for the episode's scene cuts.
- It maintained landscape format and anime/manhwa style.
- It produced excellent image diversity.

GPT Image 2 can remain valuable for references, hero cuts, or targeted repairs, but it should not receive a whole episode until the exact reference-count payloads pass a provider health test.

### Provider Circuit Breaker

Before committing a full episode to a premium provider, run four representative probes:

- Text-only cut.
- One-reference character cut.
- Two-reference character-plus-location cut.
- Four-reference multi-character action cut.

Trip the circuit breaker after three consecutive gateway failures or a failed representative wave. Preserve completed cut IDs and switch only the missing queue to an operator-approved fallback.

Never satisfy a missing image ID by copying a nearby donor image and changing pixels only to avoid a duplicate hash. That occurred during an intermediate recovery attempt in this run. The final Flux wave replaced those files, so the current render is safe, but the recovery behavior must be prohibited. Deliberate editorial image reuse is allowed only when it is explicitly recorded as reuse and the image actually fits the beat.

## Faster Quality-First Workflow

Recommended production path:

1. Lock script hash and run targeted speakability.
2. Generate Qwen narration, stitch, Whisper-time, and pace-check.
3. Build transcript-first visual beats with exact excerpts and local story truth.
4. Build the director inventory and value-ranked reference plan.
5. Generate reference masters plus clean conditioning images.
6. Author scene prompts once, with short core instructions and conditional risk modules.
7. Run structural harden. Repair only blocked cut IDs.
8. Stream hardened chunks into image generation instead of waiting for the entire episode plan.
9. Inspect generated frames in five-minute contact-sheet batches while later images continue.
10. Regenerate only failed cut IDs.
11. Build motion clips as soon as each image passes QA.
12. Perform one final concat, subtitle burn, audio mux, and encode.
13. Run final visual, subtitle, audio, duration, and codec QA.
14. Clean regenerable intermediates after approval.

### Cut Execution Ledger

Add a per-cut execution ledger with:

- `beat_hash`
- `prompt_hash`
- selected reference IDs and hashes
- provider and model
- image hash
- image QA status
- motion-profile hash
- motion-clip hash

This makes invalidation precise:

- A timing-only change invalidates timing, subtitles, and motion clips, not images or prompts.
- A single prompt repair invalidates one image and one motion clip.
- A reference change invalidates only cuts that attached that reference.
- A failed provider request resumes from the failed image IDs.

This prevents the expensive pattern where one blocker causes a full visual-plan or image-generation rerun.

## Better Use Of The Saved Review Budget

Removing the default 54-minute prompt review creates room for work viewers can actually see:

- Generate two variants for 12-20 opening, thumbnail-like, reveal, or payoff cuts.
- Select the better frame manually or with a narrow visual comparison pass.
- Inspect every first-three-minute frame against its exact narration beat.
- Inspect every difficult action frame at full resolution.
- Repair identity, wardrobe, action, location, or style failures only.

At the observed Flux price, twenty extra variants cost less than ten cents. This is a much better retention investment than rewriting hundreds of already-usable prompts.

## Priority Roadmap

### P0: Immediate Policy Changes

1. Remove full-episode visual prompt review from the default happy path.
2. Keep blocker-only scoped prompt repair.
3. Require post-generation QA for the first three minutes and all high-risk action cuts.
4. Prohibit donor-copy/hash-perturbation image recovery.
5. Add provider health probes and a circuit breaker before premium full-episode generation.
6. Keep `smooth_fast_ken_burns` as the default premium motion profile.

### P1: Highest Quality Returns

1. Split rich reference masters from clean provider conditioning images.
2. Rebalance standalone refs toward high-value recurring locations.
3. Simplify visual author instructions and make reference-role wrappers type-aware.
4. Add phrase-aware subtitle grouping.
5. Add a tempo-correction diagnostic warning and improve native TTS delivery speed.

### P2: Largest Time Returns

1. Stream prompt chunks into image generation and motion rendering.
2. Add the cut execution ledger and hash-scoped invalidation.
3. Install/use FFmpeg with libass.
4. Collapse the final render into one full-length encode where practical.
5. Add safe post-QA cleanup for render and failed-provider intermediates.

### P3: Retention Upgrades

1. Generate alternate frames for the opening and major reversals.
2. Use provider escalation only for stubborn hero/action cuts.
3. Preserve fast opening holds and slower longform holds after the hook.
4. Keep visible transitions editorially selected rather than applying a conspicuous transition at every early boundary.

## Target Production Budget

For a healthy 60-minute episode with a locked script and stable provider:

| Stage | Target wall time |
| --- | --- |
| Narration, stitch, timing, pace | 35-55 minutes |
| Beats, director inventory, refs, prompt authoring | 45-75 minutes |
| Scene image generation | 40-60 minutes |
| QA and scoped repairs | 15-30 minutes |
| Motion, subtitles, final render | 30-45 minutes |

Sequentially, this is roughly 3-4.5 hours. With prompt authoring, image generation, image QA, and motion generation streamed safely through the cut ledger, a realistic target is about 2.5-4 hours from locked script to upload-safe render.

This target assumes no script rewrite, no provider outage, and no operator-requested alternate full mix. The important improvement is not merely faster models. It is preventing healthy completed work from being invalidated or held behind unrelated unfinished work.

## Production Acceptance Criteria

A production should be ready when:

- The first three minutes have been checked cut by cut against exact narration.
- Every difficult physical action has correct subject placement and contact geometry.
- Recurring identities and wardrobe states match their conditioning refs.
- Major recurring locations have continuity anchors or deliberately approved text-only handling.
- All images are native landscape and match the episode's anime/manhwa style.
- No unrelated donor image was substituted for a failed cut.
- Exact duplicate detection passes.
- Only failed image IDs were regenerated.
- Motion is smooth, intentional, and free of micro-shake.
- Accidental one-word subtitle events are below 2%.
- Final narration is approximately -13 LUFS with safe true peak and remains clearly intelligible.
- `ffprobe` confirms final duration, 1920x1080 format, expected frame rate, video codec, and continuous audio.
- Final QA records actual provider cost, wall time, repairs, and any waived defects.

## Final Recommendation

Goldflow does not need more universal gates. It needs better allocation of judgment.

Use the LLM to author strong local visual intent. Use deterministic code to validate structure and routing. Let the image provider generate quickly at full concurrency. Then judge the artifact viewers will actually see and repair only the frames that failed.

For this episode, the full prompt review was not worth its 54-minute cost. The post-generation action pass was. That should become the new default production philosophy.
