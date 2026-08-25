# Goldflow August Update

Living speed-and-quality roadmap for the next Goldflow production cycle.

Last updated: 2026-08-23

## North Star

Goldflow should produce the strongest truthful title-thumbnail package, the most retention-efficient story, the most natural narration, and the clearest audiovisual storytelling that the available models can deliver without turning production into a serial chain of model calls.

Quality and speed are not opposing goals when the workflow:

- makes high-value global decisions early
- gives each provider the work it performs best
- preserves passed artifacts
- repairs only exact failed scope
- overlaps dependency-safe work
- measures audience-facing results rather than model confidence

Real YouTube behavior remains the final judge. Synthetic scores are useful only after calibration against CTR, 30-second retention, one-minute retention, AVD, APV, and watch-time share.

## Next-Run Fast Production Contract

The next production is a still-first speed proof. Its measured commitment is six hours target and seven hours hard ceiling from a locked, approved script and successful production-health gate to a private-ready master, final QA receipt, and upload package. Network-dependent YouTube processing is measured separately. This commitment applies to a normal episode envelope of at most 80 narration minutes, at most 700 newly generated scene stills, and at most 50 globally selected standalone references. A larger episode receives a new forecast before spend rather than inheriting a false seven-hour promise.

The 2026-W34 home-rebuild run is the baseline failure to correct. It consumed 1,226.842 elapsed minutes, but only 527.235 active-union minutes. The audit found 699.607 idle minutes, 325.326 minutes of avoidable automatic-stage idle, 38 failed invocations, and 25 repeated full-scope invocations. Healthy Flow production still accepted 500 images in about 2.63 hours, roughly 190 accepted images per hour. Existing capacity was therefore sufficient; orchestration, provider readiness, repeated work, and optional motion were the dominant problems.

### Locked Operating Rules

- Use one persistent agent director from preflight through private-ready. Do not manually launch parallel copies of stages or use workflow bypass as ordinary recovery.
- Start and verify the persistent five-slot Flow pool and three-slot Gemini pool before the production clock begins. Flow is the deadline-bearing primary capacity; healthy Gemini capacity tops off the same queue but never becomes a barrier that pauses Flow.
- Run one small all-slot provider health probe before spend. During production, use the first 100 real scene images as the throughput soak. The required Flow floor is 180 accepted scene images per hour with at least 90 percent first-pass acceptance. If the floor is missed, stop and triage immediately rather than discovering the miss after the full queue.
- Run semantic extraction and the complete narration/TTS/Whisper branch concurrently. Join only at timing bind.
- Keep reference selection creative and LLM-owned, but direct the global reference director to select only genuinely recurring identity, state, location, prop, UI, or style anchors. There is no deterministic reference cap and no per-chunk target restoration.
- Stream every accepted prompt chunk directly into one append-only Flow/Gemini image queue. Keep each free provider slot topped off while later prompts are authored. Do not run Flow and Gemini as sequential batches.
- Disable generated video on the default critical path until matched upload analytics show a repeatable retention lift. Preserve 6-7 second editorial shot density with deliberate still selection, reframes, inserts, crops, smooth Ken Burns, and inspected parallax. Generated video remains an explicit experiment, not a production requirement.
- Run deterministic geometry, readability, corruption, hash, duplicate, and final-master integrity checks across the complete episode. Limit expensive semantic/aesthetic review to the opening, hero moments, contact, reversals, identity-critical cuts, and a small deterministic sample.
- Freeze every passed artifact. A failure opens the provider circuit and creates exact-ID repair scope. Never rerun a passed full stage, never submit one asset to two providers, and never reopen a public release for an unpromoted repair.
- Start package research and thumbnail ideation during the image/render tail. Bind the final selected package to the finished master only after final QA.

### Wall-Clock Rails

| Deadline | Required state |
| ---: | --- |
| T+0:10 | Browser pools, Qwen, disk, source hashes, and run identity healthy |
| T+1:00 | Narration/Whisper and semantic branches complete or on a measured path that preserves the ceiling |
| T+1:40 | Visual beats and global reference direction complete |
| T+2:00 | Approved references materialized and first scene prompt wave leased |
| T+2:35 | First 100 production scene images measured; Flow floor confirmed |
| T+5:45 | Scene images complete, incremental QA drained, ordinary motion cache warm |
| T+6:35 | Master render complete; package candidates ready |
| T+7:00 | Final QA passed and private-ready package complete |

Any checkpoint that predicts a miss triggers one bounded response: remove optional generated motion, optional alternatives, and nonessential deep review; preserve accepted stills; use exact-scope repair only; and have the editorial director intentionally cover remaining timeline cuts with accepted adjacent imagery and distinct motion treatments when that is truthful. It never triggers lower narration quality, skipped structural QA, fabricated imagery, or an unbounded retry loop.

### Account-Scaling Gate

Do not add an account to compensate for idle workers. Admit a second account only after the one-account scheduler keeps the existing pool continuously fed and either two production runs meet this contract or a controlled capacity bakeoff proves the current account is saturated. The second account must improve accepted image throughput by at least 60 percent without reducing first-pass acceptance by more than five percentage points. Add a third account only when two admitted accounts are both materially utilized or simultaneous channel productions create a measured queue. Additional accounts are scaling capacity for more channels, not a substitute for a working scheduler.

Asset Afterlife, crime documentary, financial stories, and other future lanes should share this production engine through content profiles. They may add factual claim ledgers, source and rights controls, real-footage or diagram routes, and advertiser-safety checks without forking the scheduler or duplicating the artifact chain.

## Implementation Ledger

This ledger tracks implementation, not aspiration. `implemented` means the behavior is in the guarded production path with tests. Evidence-gated systems may remain advisory or retain an incumbent default until real audience or blind-listening data authorizes promotion; that operating caution is not an implementation gap. Paths name the primary evidence surface rather than every supporting file.

| ID | Requirement | State | Primary evidence |
| --- | --- | --- | --- |
| P1 | Early hash-stable Flow-video wavefront | implemented | `scripts/run-visual-wavefront.mjs`, per-cut direction hashes in `scripts/lib/generated-motion-contract.mjs`, idempotent Studio reuse |
| P2 | Five-GPT/five-Gemini calibrated viewer panel | implemented | Mandatory advisory panel, multi-episode calibration, and explicit hash-bound authority promotion in `scripts/source-mixed-viewer-shadow.mjs` and `scripts/source-mixed-viewer-calibration.mjs` |
| P3 | Episode-size p50/p90 wall-clock forecast | implemented | `scripts/lib/production-forecast.mjs`, `run performance-audit` |
| P4 | Generated-reference ROI report | implemented | `scripts/lib/reference-roi-audit.mjs`, `run reference-roi` |
| PK1 | Separate demand-transfer dimensions | implemented | Package-evidence V3 in `scripts/lib/winner-source-room-v2-contract.mjs` |
| PK2 | Nearest-neighbor title-thumbnail package analysis | implemented | V3 package neighbors, convergence, novelty axis, and fatal-veto contract |
| PK3 | Comment-language evidence | implemented | V3 requires 25 anonymized comments across five source videos and four evidence classes |
| PK4 | Package proof and payoff deadlines | implemented | Story Truth promises plus final story map |
| PK5 | Package before story and confirmation after render | implemented | Source-room package gate plus upload packaging after final QA |
| ST1 | Retention-obligation map | implemented | Story Truth V2 open/develop/close/replace obligations in `scripts/lib/first-class-story-contract.mjs` |
| ST2 | Story-movement density audit | implemented | Story Truth V2 movement rows classify changed dimensions and explanation/procedure risk |
| ST3 | Antagonist adaptation and counterplay | implemented | Structured observation-to-inference-to-tactic-to-choice chain in Story Truth V2 |
| ST4 | Character-voice fingerprints | implemented | Structured vocabulary, syntax, avoidance, humor, value, and decision fingerprints |
| ST5 | Specificity and irreversible-consequence audit | implemented | Concrete evidence/object and irreversible-consequence receipts in Story Truth V2 |
| ST6 | Opening audio audition of top two finalists | implemented | Mandatory advisory release gate through `source opening-audio-audition` with exact locked Qwen/Joel blinded excerpts |
| ST7 | Whole-draft selection without blending | implemented | Six blind complete drafts, one byte-for-byte winner, scoped revisions |
| ST8 | Two-to-three-hour source-room SLO | implemented | Creative calls are reserved for premise/architecture/prose; Story Truth compiles deterministically, failed exact candidates recover independently, and stage latency stops for triage instead of unbounded retries |
| AU1 | Same-speaker delivery-reference bank | implemented | Hash-bound five-delivery bank in `config/narration_delivery_reference_bank.json`; unpromoted deliveries safely fall back to the unchanged neutral reference |
| AU2 | Chapter-level prosody spine | implemented | Narration direction V3 authors a content-addressed global chapter spine before local units |
| AU3 | Pronunciation and homograph ledger | implemented | Exact source/spoken previews for names, possessives, ranks, acronyms, currencies, numbers, and homographs |
| AU4 | Boundary listening and spectral-edge diagnostics | implemented | Semantic-join QA measures impulse, energy, spectral-edge, and noise-floor resets as listening warnings |
| AU5 | Pipelined synthesis and QA | implemented | Qwen cohort JSONL events overlap resident synthesis with CPU acoustic QA; full-stream QA remains final |
| AU6 | Blind longform provider bakeoffs | implemented | `tts provider-bakeoff` plus production-preflight promotion receipt; Qwen remains incumbent until a challenger passes blind, fatigue, repeatability, identity, cost, and operator gates |
| AU7 | Full-episode subjective listen sampling | implemented | Mandatory hash-bound manifest and decision covering opening, boundaries, risks, midpoint, climax, and ending before TTS stage completion |
| VB1 | Visual-information delta per cut | implemented | `scripts/lib/visual-beat-quality-contract.mjs`, guarded `visual-beat-plan.mjs` validation |
| VB2 | Sequence-level shot grammar | implemented | Structured shot size, angle, vantage, sequence role, and repeated-framing diagnostics |
| VB3 | Eyeline, screen direction, and geography continuity | implemented | Beat-bound spatial continuity and explicit intentional-axis-break contract |
| VB4 | Beat-value tiers | implemented | Hero/priority/connective tiers plus package proof, reveal, reversal, climax, and payoff classes |
| VB5 | Analytics-earned retention resets | implemented | `retention_reset_evidence.json` binding with evidence-ID validation and story-earned fallback |
| VB6 | Beat-level audiovisual intent | implemented | Beat-bound motion role, semantic SFX, score, silence, subtitle emphasis, and coordination note |
| PR1 | Neutral shot manifest plus provider compilers | implemented | Versioned provider-neutral manifest and `scripts/lib/visual-prompt-compiler.mjs` receipts |
| PR2 | Locked hard-cut prompt benchmark | implemented | `scripts/fixtures/visual_prompt_hard_cut_benchmark_v1.json`, `scripts/visual-prompt-benchmark.mjs` |
| PR3 | Minimum-sufficient prompt specificity | implemented | Compiler budgets, ordered prompt clauses, deduplication, and benchmark diagnostics |
| PR4 | Prompt-to-raster semantic audit | implemented | `scripts/lib/image-semantic-audit.mjs` integrated into hash-bound image QA |
| PR5 | Deliberate two-candidate hero cuts | implemented | `scripts/lib/hero-image-candidate-contract.mjs` and exact candidate handling in the image pool |
| VM1 | Clean single-concept reusable references | implemented | Global reference contracts and separate approval gate |
| VM2 | Accepted-raster parallax decision | implemented | Inspected separability, mask, and rear-plate policy |
| VM3 | Generated-video motion coherence review | implemented | Five-frame vision audit, usable trim window, and exact human override in `scripts/lib/generated-motion-coherence-audit.mjs` |
| VM4 | Motion allocated by story emphasis | implemented | Beat value and motion role feed animation selection, critical-path priority, and still fallback |
| SR1 | One audiovisual emphasis spine | implemented | `audiovisual_emphasis_spine_<episode>.json` coordinates picture, motion, SFX, score, silence, and subtitle emphasis |
| SR2 | Semantic purpose required for SFX | implemented | Event/cause binding and generic beep/whoosh/impact rejection in `audio-sfx-score-enrichment.mjs` |
| SR3 | Continuous narration-first music | implemented | Stable ducked-bed contract and no phrase-gap rebound |
| SR4 | Phrase-aware restrained subtitles | implemented | Final-script/Whisper subtitles and focal-safe rendering |
| SR5 | Automated final-master integrity scan | implemented | Full decode, black/freeze/silence checks, subtitle lineage, and generated-motion delivery verification in `scripts/lib/final-master-integrity.mjs` |
| SP1 | Dependency-aware critical-path scheduler | implemented | Priority leasing for style/identity references, opening/hero/animation cuts, package proof, and payoff work |
| SP2 | Adaptive planner chunking | implemented | Visual prompts self-tune; semantic, beat, and reference chunks emit the same telemetry and remain fixed until their stage-scoped eligibility audit finds a useful stable signal |
| SP3 | Resource reservations | implemented | Short-lived ChatGPT/Gemini planning reservations in Studio without permanently idling image capacity |
| SP4 | Quality-budget allocation | implemented | One beat-value budget drives alternatives, reference priority, motion, semantic SFX, and QA depth |
| SP5 | Immutable partial completion and exact repair | implemented | Content-addressed units, append-only events, and exact-ID recovery |
| SP6 | Provider/task-class telemetry | implemented | `scripts/lib/provider-task-telemetry.mjs` plus performance-audit p50/p90 queue/service, acceptance, repair, quota, and concurrency rows |
| SP7 | Operator checkpoint wait telemetry | implemented | Ready-to-review p50/p90, approval-type splits, and review-toll candidates in `scripts/lib/run-performance-audit.mjs` |
| QA1 | Episode quality-to-outcome calibration | implemented | `scripts/lib/episode-quality-outcome.mjs` binds prompt/raster, hero, motion, narration, package, and analytics evidence; aggregate learning remains operator-reviewed |

## Operational Evidence Followups

The August implementation backlog is complete. These are continuing measurement and promotion duties; none authorizes an automatic default change.

### 1. Calibrate The Mixed-Model Viewer Panel

Run five GPT and five Gemini viewer judgments as a mandatory, hash-bound release artifact. Until its predictions have been compared with real audience data across multiple uploads, its verdict remains advisory and cannot block release; only an explicitly promoted calibration policy may give the panel decision authority.

Measure:

- predicted leave point versus actual retention drop
- predicted package preference versus CTR and watch-time share
- predicted first-30-second strength versus actual 30-second retention
- predicted one-minute strength versus actual one-minute retention
- predicted full-story satisfaction versus APV and AVD
- agreement, disagreement, false-positive, and false-negative rates by model family

The implemented calibration contract may be explicitly promoted only after its multi-episode thresholds pass:

- robust mixed-model majority for ordinary acceptance
- catastrophic-veto handling for clear deception, incoherence, missing payoff, or severe confusion
- 10-0 agreement retained as an exceptional-confidence label, not a universal requirement

### 2. Populate And Blind-Promote The Same-Speaker Delivery Bank

The five-slot bank and fallback behavior are implemented. Record or curate owned Joel references for urgent, intimate, cold-reveal, and restrained-grief delivery, then run representative 8-10-minute blinded comparisons plus a 20-30-minute fatigue soak before activating any additional reference. Voice identity stability is a veto. Until then, every requested style uses the existing neutral-forward reference.

### 3. Make Subjective Narration Sampling Explicit

Use the implemented hash-bound review manifest on every R4 production. It covers the complete opening, every chapter boundary, system-heavy and pronunciation-risk passages, a middle fatigue sample, the climax, and final minute. A human-confirmed issue repairs only the exact affected TTS units.

### 4. Calibrate Quality Passes Against Outcomes

For each comparable upload, retain the generated `episode_quality_outcome_<episode>_<window>.json`. Promote only checks that repeatedly predict blind preference, reduce repair, or improve CTR/retention. A final accepted raster is never retroactively counted as a measured first pass.

### 5. Expand Adaptive Control Only Where Evidence Supports It

Visual prompt authoring remains the only active self-tuning planner. Semantic, beat, and reference chunks now emit the same telemetry, but their controllers stay fixed unless the performance audit reports enough samples, a stable failure rate, and a useful stage-specific control signal. Activation remains explicit and stage-scoped; there is no global auto-tuner.

## Implemented Quality Contracts

The sections below preserve the rationale and operating rules for the quality systems now in the guarded path. Imperative wording describes the continuing production standard; the implementation ledger above remains authoritative for `implemented`, `shadow`, and `open` status.

### Premise And Package

1. Add a structured demand-transfer score before drafting.

The score should keep separate evidence for recent demand, breakout multiple, package clarity, emotional familiarity, novelty, 10K-word runway, production feasibility, and saturation. Do not hide a fatal weakness inside one combined average.

2. Add nearest-neighbor package analysis.

Compare each proposed title-thumbnail movie with recent niche winners and the channel's own catalog. Flag accidental title cloning, thumbnail convergence, repeated betrayal mechanics, and weak novelty. The goal is recognizable demand with one meaningful new axis, not novelty without demand or a reskinned winner.

3. Add comment-language evidence.

Capture requests, unresolved questions, anger, fantasy desire, confusion, and quoted viewer language from relevant winners. Feed recurring audience wording into premise ideation without copying a creator's script.

4. Bind the package promise to story and visual deadlines.

Every selected package should declare the first narrated confirmation, first visible proof, first reversal payoff, and final satisfaction point. Those obligations should survive Story Truth, drafting, beat planning, prompt authoring, and final QA.

5. Keep package ideation before story and confirmation after render.

The early package creates demand discipline. The final packaging pass confirms the strongest truthful expression supported by the finished video and current market evidence.

### Story Architecture And Writing

1. Add a retention-obligation map.

Track every open loop, promise, question, threat, relationship pressure, and fantasy payoff with an open point, expected development points, and closure point. Flag long spans that introduce no new pressure, proof, choice, consequence, or reward.

2. Add a story-movement density audit.

For each narration span, classify whether it advances goal, danger, power, relationship, mystery, status, choice, consequence, or payoff. Detect repeated explanations, procedural reporting, redundant reactions, and scenes that preserve state rather than change it.

3. Add antagonist adaptation and counterplay checks.

The opposition should observe, infer, change tactics, and force a new choice. A protagonist feels stronger when defeating capable resistance rather than static villains.

4. Add character-voice fingerprints.

Measure vocabulary, sentence shape, emotional avoidance, humor, values, and decision style for major characters. Flag dialogue that could be reassigned without changing meaning.

5. Add specificity and consequence audits.

Prefer concrete decisions, physical evidence, irreversible costs, visible status changes, and remembered objects over abstract claims that someone is powerful, humiliated, brilliant, or loved.

6. Run a mandatory advisory opening audio audition.

Synthesize the first 60-90 seconds of the top two full-draft finalists with the locked production narrator. Blind-listen for spoken cadence, name density, exposition drag, emotional clarity, and immediate click satisfaction. Release requires the hash-bound audition artifact; its preference remains advisory until calibrated authority is explicitly promoted.

7. Preserve whole-draft selection.

Do not blend six drafts into committee prose. Select one complete draft, diagnose exact problems, perform one developmental revision, and then perform one plot-locked narration polish.

### Narration And TTS

1. Use the calibrated same-speaker delivery-reference bank.

The bank declares neutral-forward, urgent, intimate, cold-reveal, and restrained-grief slots from the same owned narrator identity. Only neutral-forward is active today. Promote another conditioning reference only if blind listening improves expressiveness without measurable voice drift or chapter-to-chapter identity changes; otherwise the plan records the requested delivery and safely uses neutral-forward.

2. Add a chapter-level prosody spine.

Plan energy, tension, intimacy, pace, and reveal weight across chapters before unit-level punctuation direction. This prevents locally acceptable units from producing a globally flat or randomly theatrical hour.

3. Expand the pronunciation and homograph ledger.

Keep context-aware entries for names, ranks, acronyms, currencies, possessives, plural forms, and words with multiple pronunciations. Require an exact spoken-text preview for risky tokens before synthesis.

4. Add boundary-listening and spectral-edge diagnostics.

The current sample accounting protects against cut words. Add non-blocking detection for clicks, abrupt noise-floor changes, room-tone discontinuity, and unnatural prosodic resets at joins. Confirm defects by listening before repair.

5. Pipeline synthesis and QA.

Keep the resident Qwen model generating cohorts while completed cohorts enter waveform, ASR, and continuity analysis on separate capacity. Final full-stream QA still runs after the canonical stitch.

6. Keep provider bakeoffs blind and longform.

Qwen remains primary until Fish Audio or ElevenLabs wins a representative 8-10-minute blind test, repeatability test, and 20-30-minute fatigue soak by enough margin to justify cost and latency.

7. Require full-episode subjective review sampling.

Always listen to the complete opening, every chapter boundary, every system-heavy passage, every pronunciation risk, a middle fatigue sample, the climax, and the final minute. Automated WER cannot measure charisma or listener fatigue.

### Visual Beats And Shot Direction

1. Add a visual-information-delta field.

Every cut should state what new visual information it adds. A new image that merely restates the previous composition should be merged, reframed, or assigned a different job.

2. Add a sequence-level shot grammar.

Track wide, medium, close, insert, reaction, over-shoulder, silhouette, UI, location, and consequence shots. Avoid repeated framing streaks while preserving spatial clarity and emotional point of view.

3. Add eyeline, screen-direction, and geography continuity.

Store who faces whom, where the threat is, entry direction, travel direction, and major object position for confrontation and action sequences. Let deliberate reversals break continuity only when the beat calls for disorientation.

4. Add beat-value tiers.

Mark package proof, opening reversal, major reveal, relationship turn, power demonstration, climax, and final payoff as hero moments. Use the tier to allocate references, image alternatives, generated motion, SFX, and QA attention.

5. Add retention resets from real analytics.

Use channel-specific retention drops to place earned visual, sonic, or story changes. Do not insert arbitrary movement every fixed number of seconds.

6. Bind audio and motion intent at the beat stage.

High-value beats should declare visual change, motion opportunity, SFX purpose, score behavior, and silence needs together. This prevents late audio decoration from fighting the edit.

### Prompt Quality

1. Keep one provider-neutral shot manifest and compile provider-specific prompts.

The creative contract should remain stable, but Flow and Gemini may benefit from different prompt ordering, verbosity, reference wording, and negative constraints. Provider adapters must not change story content.

2. Create a hard-cut prompt benchmark.

Maintain 25-40 representative cuts covering one, two, and four references; physical contact; crowded scenes; UI; location continuity; unusual camera angles; injuries; vehicles; and emotional close-ups. Compare prompt compiler versions and providers on the same locked manifests.

3. Prefer minimum sufficient specificity.

Prompts should lead with subject, decisive action/contact geometry, composition, camera, environment, lighting, continuity state, and essential exclusions. Remove repeated adjectives and long identity prose already supplied by references.

4. Add a prompt-to-raster semantic audit.

Use a vision reviewer to compare the accepted raster with the shot manifest for identity, action, location, state, count, composition, and forbidden elements. Keep aesthetic taste advisory; allow story-critical mismatch to become an exact-cut repair.

5. Add deliberate hero-cut alternatives.

At preflight, authorize a small fixed set of package, opening, reversal, climax, and final-payoff cuts for two candidates. Generate those candidates concurrently and select blindly for story truth, mobile readability, composition, and continuity. The ordinary one-submission rule remains unchanged for all other cuts.

### References, Images, And Motion

1. Generate clean reusable references, not attractive scene art.

Conditioning assets should isolate one identity, state, location, prop, UI motif, faction language, or effect language without contaminating later compositions.

2. Use the accepted raster, not planner confidence, to decide parallax.

Only clean separations receive masks and rear-plate reconstruction. Tangled images retain single-plane motion.

3. Score generated video for motion coherence.

Review identity stability, reachable action, contact, anatomy, background stability, camera intent, terminal composition, and next-shot compatibility. Reject morphing even when movement looks impressive.

4. Build motion around story emphasis.

Use Flow video on moments where motion changes understanding or emotion. Do not spend it on connective shots that a well-directed still can communicate faster and more reliably.

### Sound, Music, Subtitles, And Render

1. Create one audiovisual emphasis spine.

Mark the limited moments where score, SFX, motion, subtitle emphasis, and transition should reinforce one another. Preserve silence before important reveals instead of filling every gap.

2. Require semantic purpose for SFX.

Every planned effect should identify the physical or editorial event it supports. Reject generic beeps, whooshes, or impacts that have no visible or narrative cause.

3. Keep music under narration continuously.

Use stable narrator-first gain, controlled ducking attack/release, and no loud rebounds between phrases. Raise music only in deliberately narration-free sections.

4. Use subtitles as a readability layer, not a second thumbnail.

Preserve exact final-script text and Whisper timing. Keep line breaks phrase-aware, respect focal safe zones, and use emphasis sparingly for names, numbers, reversals, and system terms.

5. Add automated final-master integrity scans.

Check black frames, frozen-frame streaks, duplicated adjacent cuts, subtitle overflow, clipping, loudness, accidental music jumps, missing generated clips, stale hashes, geometry, and duration before human final QA.

## Implemented Speed And Efficiency Contracts

These are now default production behaviors where the implementation ledger marks them complete. They remain measurable policies rather than permission to skip approvals or weaken lineage.

### Critical-Path Scheduler

Represent the production as a dependency graph rather than a stage list. Always lease the ready task with the greatest downstream critical-path impact while respecting provider quotas and creative priority.

Priority examples:

- style and protagonist references before dependent cuts
- opening hero stills before ordinary late connective stills
- accepted hero frames before Flow video
- TTS cohorts and semantic chunks concurrently
- focal/structural QA while the next image batch generates
- render cache construction while final media approvals continue

### Adaptive Chunking

Choose planner chunk size from measured provider latency, schema-failure rate, context size, and task type. Shrink after timeout or malformed-output clusters; grow only after sustained first-pass success. Never change passed chunk content.

### Resource Reservations

Reserve separate capacity for:

- premium global text decisions
- structured bulk planning
- bulk still generation
- generated video
- QA and artifact writing

Do not let low-value image work consume the browser surface needed for story or package decisions.

### Quality-Budget Allocation

Spend disproportionate time and generation budget on:

- title-thumbnail proof
- first 30 seconds
- first visible payoff
- major emotional reversal
- power demonstration
- climax
- final satisfaction image

Connective beats should remain clear, consistent, and efficient rather than receiving equal creative spend.

### Immutable Partial Completion

Every worker should emit accepted content-addressed units as soon as they pass. Later failures should leave completed units reusable. A recovery invocation names only unresolved IDs.

### Performance Telemetry

The production audit now tracks by provider and task class:

- queue wait
- service time
- first-pass acceptance
- timeout rate
- malformed-output rate
- rate-limit rate
- exact-repair rate
- operator review time
- downstream reuse
- cost or quota consumption

Queue, service, and total latency use p50 and p90 rather than averages. Planner calls, still-image attempts, and generated-motion attempts feed the first production version. Operator review latency and downstream audience-value attribution remain calibration work rather than guessed metrics.

## Next Validation Order

| Order | Change | Primary outcome | Risk |
| ---: | --- | --- | --- |
| 1 | Full regression and one clean end-to-end production | Prove all new contracts cooperate under real load | Medium integration risk |
| 2 | Same-speaker delivery-reference bakeoff | Better narration expressiveness without identity drift | Medium voice-drift risk |
| 3 | Full-episode subjective listening manifest | Catch charisma, fatigue, and join defects automation cannot hear | Low operator-time cost |
| 4 | Mixed GPT/Gemini panel analytics calibration | Learn which synthetic judgments predict real viewers | Low while advisory-only |
| 5 | Prompt/raster/motion outcome calibration | Retain only quality checks that prevent rework or improve viewing | Low |
| 6 | Extend adaptive chunks to other planner stages if measured | Further speed without global instability | Medium if generalized too early |

## Promotion Rule

A new quality pass becomes mandatory only when it:

- catches meaningful defects missed by the current workflow
- predicts real audience behavior or improves blind human preference
- adds less time than the rework or performance loss it prevents
- preserves exact lineage and scoped recovery
- does not create redundant model consensus theater

## Post-Upload Monitor

The analytics feedback lane runs as a local Codex monitor every 72 hours. It discovers all due checkpoints across channels, keeps the original 24-hour, 72-hour, and 7-day labels, records actual capture lateness, and leaves unanchored private uploads visible for release verification. Learning deduplicates snapshots by episode and separates packaging, downstream production, and native source-room evidence. Native writing proposals require at least three distinct `goldflow_native` episodes with mature 72-hour or 7-day CTR/impression and retention/watch-time evidence. An eligible pattern becomes a hash-bound controlled-test proposal with counterevidence, validation, and rollback, not a default edit. One deduplicated iMessage may alert Joel with the proposal path and SHA-256, but replies are never approval; only explicit hash approval inside the Goldflow Codex task can authorize the test. Missing Studio data, routine scans, held domains, and unchanged recommendations produce no message.

`youtube_script_origin_registry.json` prevents source provenance from being conflated with production provenance. A complete Goldflow-produced episode may still carry `script_origin: external_ingest`; it remains eligible for downstream production and audience learning, while native premise/draft system promotion is held until at least three episodes carry complete hash-bound `goldflow_native` winner-source releases.

## Completion Audit

Implementation audit completed on 2026-08-18. Every ledger item is present in the guarded path or an explicitly evidence-gated advisory/promotion contract. Continuing blind-listening, upload, and multi-episode calibration work is operating evidence collection, not unfinished implementation and not permission for automatic default changes.

The completion run passed:

- `npm run check` across 298 JavaScript modules plus generated workflow guidance
- `npm run test:fixtures`, including 43 stage-contract, 90 planner, 38 media, production-direction, performance, narration, analytics, and provider-free end-to-end integration tests
- `npm run test:quality`, covering source, narration, prompt/raster, hero alternatives, generated motion, final-master integrity, scheduler, telemetry, analytics, and audiovisual emphasis
- `npm run test:studio`, covering all 12 Studio suites plus ChatGPT and Gemini browser contracts
- `npm run docs:workflow:check`
- `git diff --check`

The next clean live production is a systems validation run, not another implementation phase. It should preserve all artifacts and telemetry so the first real calibration cohort begins immediately.

A speed optimization is accepted only when it preserves current structural, identity, story-truth, and approval guarantees.
