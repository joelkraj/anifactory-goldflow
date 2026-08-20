# Goldflow Production Direction

Living operator-direction ledger for Goldflow. This document records the current production strategy, unresolved questions, and dated decisions as requirements evolve through discussion and measured production results.

Active August implementation roadmap: [`UPDATE_AUG.md`](UPDATE_AUG.md).

This is not a frozen implementation specification. The latest explicit operator direction controls. When direction changes:

1. Update **Current Direction** to reflect the new active policy.
2. Preserve unresolved questions until measured evidence answers them.
3. Append a dated entry to **Decision Log** explaining what changed and why.
4. Promote a direction into code only after the required proof or benchmark passes.

## Current Direction

Last updated: 2026-08-19

### Operating Principle

Goldflow should be agent-led end to end. The pipeline is a flight recorder, state manager, and safety rail. It should organize artifacts, preserve hashes and provenance, keep work moving, and prevent destructive or stale operations. It should not become the creative director or force the agent to operate dozens of visible micro-stages manually.

Preserve these pipeline strengths:

- Stable run identity and exact source lineage.
- Immutable passed artifacts.
- Exact-ID recovery rather than broad regeneration.
- Deterministic structural validation.
- Provider receipts, hashes, and cost/latency telemetry.
- Explicit operator boundaries for script, release, and consequential spend.

Reduce these pipeline costs:

- Model-specific stage names and contracts.
- Repeated manual advancement through routine internal checks.
- Full-stage retries when only a small scope failed.
- Creative decisions embedded in deterministic code.
- Mandatory approval pauses for low-risk, reversible work.

### Provider Direction

Goldflow uses a multi-agent planning room. No single model should own every planning task.

| Capability | Primary route | Role |
| --- | --- | --- |
| Local execution and artifact authority | Codex | Lead production agent, repository access, orchestration, deterministic reconciliation, QA, recovery, and final artifact writes. |
| Structured concurrent planning | Antigravity CLI | Authenticated auxiliary headless worker for schema-bound chunks at measured concurrency three; eligible to become preferred after the full task-class benchmark. |
| Premium long-context planning | Gemini Web | Primary global reasoning surface for full-script analysis, research, continuity, difficult visual direction, and independent criticism. |
| Premium creative planning | ChatGPT Web | Primary creative partner for premise, story, package, global direction, audits, and difficult exceptions. |
| Still-image generation | Google Flow / Imagen + Gemini Web Imagen | Flow is the continuously topped-off five-slot bulk pool. Gemini Web supplies a concurrent three-slot pool using the same approved reference contract. |
| Generated video | Google Flow video models | Primary selective-motion provider. Google Flow replaces LTX for new productions. |
| Still-image fallback | ChatGPT Web GPT Image | Exact failed-asset fallback, comparison candidate, or deliberate hero/thumbnail alternative. It is not the default bulk route. |
| Narration | Local Qwen with the approved Adam/Joel voice identity | Primary longform narration route. Improve direction, normalization, segmentation, and exact-unit repair before paying for a hosted upgrade; retain Fish Audio and ElevenLabs as measured premium alternatives. |

Codex and Antigravity CLI are the primary execution-oriented planners. Gemini Web and ChatGPT Web are also primary planning participants, especially for global reasoning and high-value creative decisions. The goal is task routing and parallelism, not a winner-take-all model choice.

Consumer Gemini CLI is not the planned route. Google moved individual Google AI Pro and Ultra terminal access from Gemini CLI to Antigravity CLI on June 18, 2026. Gemini CLI remains relevant only if a paid API-key or enterprise route later proves worthwhile.

### Planning Allocation

- Codex remains the final local reconciler and artifact writer.
- Antigravity CLI may now receive bounded schema-bound semantic, beat, reference, and scene-prompt chunks at concurrency three. It becomes preferred only when the full task-class benchmark passes.
- Gemini Web should handle long-context full-script audits, research, continuity, global reference selection, and difficult scene direction.
- ChatGPT Web should handle premise development, story logic, emotional construction, packaging, audits, and difficult exceptions.
- Compatible chunks may be distributed concurrently across Codex and Antigravity.
- Production planning should keep Codex's structured pool and Antigravity's proven three-worker pool active together. Gemini Web and ChatGPT Web receive different global, audit, research, or difficult-exception assignments concurrently; they should not idle while bulk planning is in progress when compatible work is available.
- Web planners should not be required to author hundreds of routine scene prompts serially.
- Every provider must return the same provider-neutral structured contract.
- Deterministic validators decide structural acceptance. Codex resolves incompatible creative outputs using source evidence.
- Do not ask all four planners to independently recreate the entire episode. That increases cost, drift, and reconciliation time without proportional value.

### Source Story Direction

- New manhwa source development defaults to `direct_manufacturer_v1`, not the V4 story room.
- Ideation uses measured own-channel winners and external outlier titles in one GPT-5.6 Medium one-hundred-title pool, followed by one fresh GPT-5.6 Medium ten-title shortlist. The operator approves one exact title and plain-language premise.
- One Medium call fills the operator's versioned direct writer template. Do not create mandatory treatments, architecture, Story Truth, writer packets, diagnostics, revision, narration polish, or simulated-unanimity gates.
- Drafting uses six complete independent candidates from the same filled prompt: three authenticated GPT-5.6 Sol Web Pro drafts and three authenticated GPT-5.5 Web Pro drafts selected through Advanced.
- Every source-development call other than those six complete writers uses Medium.
- Every browser page selects and verifies its exact GPT model and visible Pro effort before submission. Receipts must preserve the selected model; never substitute GPT-5.6 while labeling it 5.5 or vice versa.
- A fresh Medium context uses one fixed twenty-viewer psychographic panel, predicted leave points, and opening survival checkpoints to select one complete blinded draft byte-for-byte using calibrated expected average percentage viewed only. Word count is a target, not a selection criterion or hard gate; a one-hundred-viewer synthetic panel is prohibited as false precision.
- The operator's template binds first-40/80/120/300/600-word deadlines for betrayal, status, mechanic, forced use, and first proof. These direct deadlines replace inferred opening architecture.
- Analytics at 24 hours, 72 hours, and 7 days may propose one controlled template addendum after enough distinct uploads support it. No upload or automation silently edits the prompt.
- `first_class_story_room_v4` remains an explicit optional diagnostic/research mode for unusual cases and existing rooms; it is not the production default.

### Image Direction

- Google Flow / Imagen is the default continuously saturated five-slot bulk image route.
- Gemini Web Imagen is the automatic concurrent three-slot image pool, not merely a post-failure fallback. It remains fail-closed while sustained quota and account-counter behavior are measured.
- Use the same approved reference map and ordered attachment contract across every provider.
- Generate reusable style and identity anchors before dependent scene cuts.
- Keep the provider pool topped off while later prompt chunks are still being authored.
- ChatGPT Web GPT Image is a fallback or deliberate alternative, not a routine second submission for every cut.
- Preserve ChatGPT Web capacity for premium planning. New V2 federated identities use Flow-five plus Gemini-three automatically; GPT Image is an operator-approved exact-ID fallback, hero/thumbnail comparison, or deliberate alternative and never joins bulk dispatch automatically.
- A passed image remains immutable unless the operator explicitly requests an exact-ID alternative.
- Provider routing must be selected before submission. Do not silently fail over and create two paid creative attempts for one asset.

### Generated-Video Direction

- Replace `selective_ltx23` with a provider-neutral selective generated-motion policy.
- Google Flow video models are the production primary.
- Use generated motion selectively for the opening, major reveals, action peaks, emotional reversals, and climaxes.
- Ordinary connective scenes retain directed single-plane motion or inspected parallax.
- Plan motion intent while authoring the still so the accepted image is a viable first frame.
- Start eligible Flow video work as soon as an important still passes image QA; do not wait for every episode image.
- Review and hash-bind every accepted generated clip before render.
- Preserve still-image fallback when a video clip fails, drifts, or is rejected.

### Agent-Led Macro Flow

The user-facing and agent-facing workflow should expose eight macro phases while retaining detailed internal receipts:

1. Package and story
2. Script and audio
3. Semantic and visual direction
4. References and images
5. Motion and audio design
6. Render and QA
7. Publish and A/B test
8. Analytics feedback

Routine internal stages should advance automatically under the active production profile. The agent should inspect blockers and choose the narrowest valid recovery without repeatedly asking the operator to manage implementation details.

Every director refresh writes a performance audit. After any manual or scoped blocker repair, immediately re-enter `goldflow run director --action advance`; do not leave the remaining automatic stages waiting for a human to remember the pipeline.

The audit measures prerequisite-ready-to-review-start wait separately from the operator's actual deliberation. It reports p50/p90 by approval type and identifies possible review tolls without labeling a careful decision as wasted time. Semantic, beat, and reference planners emit the same adaptive telemetry as visual prompts, but only visual prompts self-tune today; another stage may activate only through an explicit stage-scoped eligibility decision backed by enough stable samples and a useful control signal.

Normal operator stops:

- Winner package and final script approval.
- Core style and identity approval.
- Opening audiovisual proof approval.
- Hash-bound whole-episode narration sample approval.
- Final master approval.
- Release and A/B-test approval.

### Narration Direction

- Keep local Qwen as the production primary while its quality remains good enough for audience testing.
- Improve Qwen at the direction layer before changing models: clean reference conditioning, sentence-complete 20-42-word preferred units (48 soft/60 hard), deliberate punctuation, stable cohort settings, alignment-safe semantic joins, calibrated delivery/continuity QA, and exact-unit listening repairs.
- Treat pronunciation and cadence defects as pipeline evidence first. Audit the exact spoken-text plan before blaming synthesis, because deterministic normalization can create errors such as converting the pronoun `IT` into `I T`.
- Keep caption text separate from provider-neutral spoken text. Every source component must close through exact text-bearing lineage receipts, and the exact final spoken hash must bind the provider request. Pronunciation normalization must be token- and context-aware; do not expand ordinary words merely because source dialogue is uppercase. Delivery tags and performance instructions remain metadata and are never spoken.
- Fish Audio is the low-cost hosted challenger. ElevenLabs is the quality-first premium challenger. Neither replaces Qwen without a blind longform benchmark showing a material audience-facing improvement.
- Preflight hash-binds the owned same-speaker delivery bank. A requested urgent, intimate, cold-reveal, or restrained-grief delivery falls back to the unchanged neutral-forward reference until blind preference, fatigue, and voice-drift evidence explicitly promotes that reference.
- External provider production additionally requires an exact provider/model/revision/voice/hash promotion receipt from the blind representative, fatigue, repeatability, identity, and economics bakeoff. A tie or incomplete evidence retains Qwen.
- Automated WER and continuity checks do not replace listening. Every production requires a hash-bound subjective review of the complete opening, every chapter boundary, all system/pronunciation risks, a middle fatigue sample, the climax, and final minute before narration completion.
- Never mix providers within an episode. Exact-unit repairs use the episode's locked provider, model, voice identity, and generation settings.
- A provider migration after narration lock requires chapter-level or full-episode regeneration so voice identity and cadence do not change mid-video.

Optional hosted-upgrade bakeoff packet:

- Twelve representative excerpts totaling roughly 8-10 minutes: hook, exposition, dialogue, action, grief, quiet tension, system text, names, ranks, numbers, and difficult initialisms.
- Three independent generations of the most failure-prone excerpts to measure consistency rather than cherry-picking one take.
- Blind scoring for naturalness, narrator identity, cadence, emotional control, pronunciation, sentence-boundary joins, longform fatigue, ASR error rate, truncation, latency, throughput, and cost.
- A 20-30 minute finalist soak before changing the production default.

### Packaging and Analytics

- Package ideation begins during premise selection, not after render.
- The script must introduce or preview the title-thumbnail promise early enough to satisfy the click.
- Post-render packaging confirms the strongest truthful package using the finished story and current niche evidence.
- Use native YouTube A/B testing when multiple strong packages remain.
- Track the upload at 24 hours, 72 hours, and 7 days.
- Classify each upload independently by `production_lineage` and `script_origin`. Pipeline-produced episodes with externally supplied narration are `pipeline_native` plus `external_ingest`; only a complete winner-source release is `goldflow_native` source-room evidence.
- Run the local analytics monitor every 72 hours and collect every uncaptured checkpoint that has become due since its prior scan. Preserve the intended checkpoint label and capture lateness rather than pretending the sample was taken exactly on time.
- Capture impressions, browse CTR, suggested CTR, first-30-second retention, first-minute retention, average view duration, average percentage viewed, traffic sources, new versus returning viewers, and native A/B watch-time results.
- Feed measured results into the premise, script, opening, visual, and packaging directors.
- Each checkpoint also writes an `episode_quality_outcome_<episode>_<window>.json` record binding prompt/raster first-pass evidence, hero choices, motion coherence, narration listening, mixed-viewer predictions, and final packaging to the observed metrics. It never pretends a final accepted asset reveals what happened on the first attempt.
- Cross-episode correlations remain operator-reviewed and require at least three distinct episodes. They may justify a later policy promotion but never auto-tune production from one upload.
- External-ingest episodes can improve downstream packaging, narration, visual, motion, pacing, and audience-preference rules. They cannot promote or condemn native premise generation, drafting, selection, diagnosis, or revision; those source-room decisions require at least three distinct `goldflow_native` releases.
- Deduplicate 24-hour, 72-hour, and 7-day snapshots by episode before learning. Prefer the latest mature snapshot so one upload never receives three votes. Native source-room proposals require at least three distinct `goldflow_native` episodes with 72-hour or 7-day CTR/impression and retention/watch-time evidence.
- Separate learning into packaging, downstream production, and source-room domains. An eligible pattern becomes a hash-bound proposal containing evidence, counterevidence, one controlled change, a validation plan, and a rollback plan; it does not edit any prompt, policy, profile, or production artifact.
- A new actionable proposal may trigger one deduplicated iMessage to the locally configured operator. The message includes the domain, concise proposed test, proposal path, and SHA-256, then directs the operator back to Codex. Messages and message replies are alert-only and never constitute approval.
- Only Joel's explicit approval of the exact proposal hash in Codex may create a learning approval artifact. That approval authorizes a controlled test only; promoting the result to a default requires measured test evidence and a separate explicit decision.
- Analytics collection should not block the next production.

## Quota Model

### Documented Facts

- Gemini Apps use compute-based limits that refresh every five hours until a weekly limit is reached. Prompt complexity, model, feature, and conversation length affect consumption.
- Google Flow has a dedicated monthly generation-credit allocation based on the Google AI plan.
- Flow credits are shared across the signed-in account and charged per generation, not merely per request.
- Google says each product has its own AI usage limits.
- Purchased overflow AI credits can currently be used across Google Flow and Google Antigravity.
- Flow credit activity identifies product/category usage, allowing controlled experiments to observe deductions.

Official references:

- [Gemini Apps limits](https://support.google.com/gemini/answer/16275805?hl=en)
- [Google Flow credits](https://support.google.com/flow/answer/16526234?hl=en)
- [Google AI credit management](https://support.google.com/googleone/answer/16287445?hl=en-en)
- [Antigravity transition](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)

### Working Hypothesis

Gemini Web text planning and the dedicated Google Flow media allocation appear to use separate primary product limits. Antigravity and Flow may draw from their own included product allowances first, with purchased AI credits acting as shared overflow. Gemini Web image generation may use Gemini App compute limits rather than the dedicated Flow credit counter.

This remains unverified for the exact account and current model choices. Do not design production capacity around the hypothesis until the controlled test is complete.

### Required Quota Test

Record screenshots or structured receipts before and after each isolated test:

1. Record Gemini Web usage status, Flow credit balance, Antigravity usage status, and Google AI credit activity.
2. Run a bounded Gemini Web text-planning batch without media generation.
3. Recheck every counter and activity category.
4. Run a bounded Gemini Web image batch.
5. Recheck every counter and activity category.
6. Run a bounded Google Flow image batch.
7. Recheck every counter and activity category.
8. Run a bounded Google Flow video batch using the intended production model.
9. Recheck every counter and activity category.
10. Run a bounded Antigravity CLI planning batch after installation and authentication.
11. Recheck every counter and activity category.
12. Record refresh windows, throttling, concurrency, failures, and whether failed generations return credits.

The resulting proof must distinguish included product limits, shared purchased credits, concurrency limits, and cooldown behavior.

## Planner Benchmark

Before Antigravity becomes a locked production dependency, compare Codex, Antigravity CLI, Gemini Web, and ChatGPT Web on identical source-bound work.

Test workloads:

- Three semantic extraction chunks.
- Three editorial beat chunks.
- Three reference-direction chunks.
- Three 15-cut scene-prompt batches.
- One global continuity reconciliation.
- One package and opening audit.

Measure:

- First-pass schema validity.
- Source fidelity and unsupported invention.
- Cross-chunk continuity.
- Editorial usefulness.
- Latency and throughput.
- Safe concurrency.
- Cost or quota consumption.
- Determinism and recoverability.
- Required human correction time.

The benchmark should choose task-specific routing. It does not need to declare one universally superior model.

## Implementation Status

The architecture is implemented behind hash-bound contracts. Antigravity installation, authentication, structured output, source fidelity, and concurrency three are measured; higher concurrency, sustained quota, and preferred task-class routing remain measurement gates rather than assumed facts.

| Direction | Status | Production meaning |
| --- | --- | --- |
| Provider-neutral planner registry | Implemented | `planning_room` routes Codex, Antigravity CLI, Gemini Web, and ChatGPT Web by task class; Codex remains final local reconciler and artifact writer. |
| Antigravity structured planner | Auxiliary route proven, preference benchmark-gated | Official `agy` 1.1.12 is authenticated on Google AI Ultra. Gemini 3.6 Flash Medium passed one source-bound runner proof and three concurrent semantic/beat/prompt jobs with zero validation findings. The route is capped at concurrency three and becomes preferred only after `goldflow benchmark planners` produces task-specific comparative evidence. Proof: `docs/proofs/antigravity_cli_worker_proof_v1.json`. |
| Federated planner provider circuit | Implemented | Fatal authentication or eligibility failures open the affected provider immediately; three consecutive transient transport failures do the same. Already-leased failed chunks stay exact-scope repair work, while new leases use healthy capacity. |
| Federated still-image pool | Implemented V2; V1 compatible | New `fast_premium_v1` identities default to five Flow plus three Gemini automatic slots. GPT Image is exact-ID fallback only, preserving premium text capacity. Existing V1 identities retain their original eleven-slot lock. |
| Production performance audit | Implemented | `goldflow run performance-audit` reports active-union time, wall-clock idle, approval waits, blocker recovery, unexplained automatic-stage gaps, stage failures, provider failures, and target overrun. The agent director refreshes it automatically. |
| Gemini Web concurrent still pool | Implemented at bounded concurrency three; sustained soak pending | The authenticated Google Gemini browser generates reference-bound images, writes provider receipts, and participates automatically. Quota telemetry may lower future capacity, but an unmeasured limit fails the exact asset closed rather than silently moving it. |
| Provider-neutral generated motion | Implemented | New artifacts and `visual generated-motion` commands use Flow video; legacy LTX identities dispatch through a compatibility adapter. |
| Durable Flow video transport | Implemented, live-proof pending | The five-slot Flow host shares image/video work, requires exactly one first-frame reference, and records prompt/model/input/output hashes with no automatic creative retry. |
| Eight-phase agent director | Implemented | `goldflow run director` projects the detailed ledger into eight macro phases and advances routine work only to the next checkpoint or blocker. |
| Qwen spoken-text hardening | Implemented | Qwen remains primary. New runs require a standalone hash-bound audit for digits, sentence boundaries, source/caption separation, stage-tag leakage, word limits, and context-aware `IT`. |
| Native YouTube A/B | Implemented | Two or three approved title-thumbnail pairs can be bound into the publish manifest; when present, the upload stage cannot pass until the native test receipt is verified. |
| 24h / 72h / 7d analytics | Implemented with 72-hour monitor | Upload recording creates a non-blocking release-anchored follow-up plan. The recurring monitor discovers every due checkpoint, records lateness, preserves hash-bound receipts, and sends only deduplicated operator-approval alerts. |
| Quota separation proof | Harness implemented, evidence pending | `goldflow benchmark quota` records isolated before/after counters, screenshots, throughput, cooldowns, and failed-credit behavior. No quota claim becomes production policy before measurement. |
| Planner benchmark | Harness implemented, evidence pending | Fourteen identical workloads across four providers are scored for quality, fidelity, continuity, speed, quota, recovery, and correction time. |
| First-class story room V4 | Implemented and fixture-proven | Independent package slates, Story Truth, six exact draft candidates, blinded whole-draft selection, expanded diagnostics, narration polish, exact script mapping, and analytics calibration are hash-bound while V1-V3 releases remain readable. |

Exact-ID recovery, append-only execution events, immutable passed outputs, provider selection before submission, and deterministic structural validation remain mandatory across every route.

## Decision Log

### 2026-08-19 - Direct Source Manufacturer Replaces the Default Story Room

The nine-hour source-room attempt produced a slower, less title-faithful opening than the operator's prior direct chatbot workflow. Goldflow had optimized intermediate architecture instead of enforcing the writer prompt's explicit opening deadlines. New source work therefore uses a lean title-pool and shortlist, one operator-approved premise, one Medium template-fill call, six parallel Web Pro scripts split evenly between GPT-5.6 Sol and GPT-5.5, and one Medium APV-only selector. The V4 room remains optional for explicit diagnostics and existing lineage. Prompt learning occurs through operator-approved, evidence-backed addenda rather than new mandatory stages.

### 2026-08-18 - Production Speed and Quality Audit

The completed 53rebirth production consumed 1,225.5 wall-clock minutes but only 440.6 minutes of overlapping active work, for 35.95% utilization. Of 784.9 idle minutes, 415.9 occurred between forward automatic stages without a recorded approval gate or failed predecessor; another 98.8 minutes belonged to backward rerender or out-of-order rework and is tracked separately. The largest gap was 199 minutes between animation planning and generated motion, although generated motion later required only 22.7 active minutes. Goldflow now emits a durable performance audit and an explicit director re-entry command after blocker resolution.

Provider evidence also changed the default image route. Flow failed 26 of 295 submissions (8.81%), Gemini failed 23 of 269 (8.55%), and ChatGPT Image failed 26 of 41 (63.41%), including ten rate limits. New federated V2 identities therefore run Flow-five plus Gemini-three automatically and reserve ChatGPT Image for operator-approved exact-ID fallback. Legacy V1 identities keep their original locked eleven-slot behavior.

The planner ledger contained 37 failed chunks, including 16 Antigravity authentication or eligibility failures. The federated planner now opens a provider-local circuit after a fatal auth failure or three consecutive transient failures so unleased work does not repeat an already-proven infrastructure defect.

Premise selection no longer trusts author self-screening or source-file order. All six finalist packages reach independent judges, selected-package click/runway verdicts must be internally consistent, and the optional V2 outlier ledger ranks verified measurements while limiting package-grammar concentration. Developmental revision receipts now bind real before/after excerpts and reject invented repair IDs. The remaining high-value redesigns are early hash-stable Flow-video prefetch, a mixed-model/calibrated viewer panel, and an episode-size-aware wall-clock SLO.

### 2026-08-17 - Six-Draft First-Class Story Room

New manhwa source development now uses six complete candidates rather than two: three GPT-5.6 Sol Web Pro drafts and three GPT-5.5 Web Pro drafts selected through Advanced. The two models receive matched creative lenses, and a fresh Gemini context selects blindly from exact texts. Story Truth, opening stress, agency, anti-slop, narration polish, exact script mapping, and the post-upload retention loop were promoted into the source lineage. The live Web selector and per-page contract verification provide receipt-backed proof for both model routes.

### 2026-08-11 - Use Every Compatible Production Resource Concurrently

Production should not serialize work through one model or one media surface. Codex and Antigravity run separate source-bound structured planning chunks through an eleven-slot weighted pool, while Gemini Web and ChatGPT Web receive distinct global, research, audit, packaging, or difficult-exception assignments. Flow remains continuously topped off with five slots for bulk stills and generated video. Gemini Web Imagen supplies three concurrent still slots. ChatGPT Web contributes up to three image slots only after premium text-planning demand is clear, or for an explicitly prioritized hero, repair, or thumbnail asset. No cut is submitted to two providers speculatively, and Codex remains the final reconciler and artifact writer.

This image-capacity paragraph records the original V1 policy. The 2026-08-18 V2 decision supersedes it for new identities: ChatGPT Image is exact-ID fallback or deliberate comparison only and does not enter automatic bulk dispatch.

### 2026-08-11 - Qwen Remains Production Primary

The hosted-TTS comparison does not justify replacing a free narrator that is already good enough for channel testing. Qwen remains the production default while Goldflow improves reference conditioning, punctuation, spoken-text normalization, segmentation, and exact-unit repair. Fish Audio and ElevenLabs remain optional benchmark candidates when narration quality is a measured retention constraint or a premium episode justifies the recurring cost.

### 2026-08-11 - Hosted TTS Upgrade

Fish Audio and ElevenLabs were identified as hosted upgrade candidates, with ElevenLabs treated as the quality-first option and Fish as the cost-and-throughput challenger. This was an evaluation direction rather than a permanent provider lock and was superseded by the decision to improve Qwen before incurring recurring hosted narration costs.

The uppercase pronoun `IT` exposed a deterministic normalization defect: the voice plan expanded every uppercase `IT` to `I T`, including ordinary sentence-final pronouns. The normalizer is now context-aware and regression-tested; existing locked narration is not silently mutated.

### 2026-08-11 - Agent-Led Pipeline

The pipeline should serve the production agent rather than act as the creative decision-maker. Keep detailed internal controls, but simplify normal operation into eight macro phases and fewer operator stops.

### 2026-08-11 - Google Visual Stack Becomes Primary

Google Flow / Imagen and Gemini Web Imagen form the primary still-image pool. Google Flow video models replace LTX for new selective-motion production. ChatGPT Web GPT Image is reserved for operator-approved exact-ID fallback, hero or thumbnail comparison, or a deliberate alternative rather than automatic bulk capacity.

### 2026-08-11 - Four-Model Planning Room

Codex and Antigravity CLI become the primary execution-oriented planners. Gemini Web and ChatGPT Web remain primary premium planning participants for global reasoning, creative direction, research, audits, and difficult exceptions. A provider-neutral benchmark must determine task-level routing.

### 2026-08-11 - Antigravity CLI Auxiliary Worker Proven

The official `agy` 1.1.12 CLI was installed and authenticated on the current Google AI Ultra account. Gemini 3.6 Flash Medium passed a source-bound Goldflow runner proof in 5.25 provider seconds, then semantic, beat, and scene-prompt jobs passed concurrently at three workers in 9.17 wall seconds with zero schema, ID-order, or unsupported-specificity findings. Goldflow now uses the real non-interactive `agy --print` plan-mode contract and records model, CLI version, provider timing, usage, conversation, prompt, and output lineage. Concurrency three is approved for auxiliary structured work; preferred-provider promotion still requires the full comparative benchmark.

### 2026-08-11 - Quota Separation Requires Measurement

Official documentation suggests separate product limits for Gemini Apps and Google Flow, with purchased credits shared across Flow and Antigravity. The exact behavior of Gemini Web text, Gemini Web images, Flow media, and Antigravity on the current account must be measured before production capacity is assumed.

### 2026-08-11 - Analytics Becomes Production Feedback

Every upload should receive 24-hour, 72-hour, and 7-day analytics review. Native YouTube A/B results and retention data should update premise, opening, visual, and packaging direction.

### 2026-08-18 - Analytics Monitor Runs Every Three Days

Goldflow scans all upload follow-up plans every 72 hours and catches every overdue uncaptured 24-hour, 72-hour, or 7-day checkpoint. It records the real timing delta, refuses to fabricate unavailable Studio metrics, and sends one deduplicated local iMessage only when repeated evidence produces a concrete operator-review-eligible improvement. Production defaults remain unchanged until explicit operator approval.

The upload registry separately tracks production and script origin. As of this decision, all nine canonical recorded uploads are pipeline-native productions with external-ingest scripts. Their downstream production outcomes remain valuable, but they are excluded from native source-room performance claims until hash-bound winner-source releases reach the required cohort.

### 2026-08-11 - Direction Implemented, Measurement Still Required

The provider-neutral planning room, federated still-image pool, Flow video route, eight-phase agent director, Qwen spoken-text audit, native A/B receipts, analytics follow-ups, quota proof harness, and planner benchmark harness are implemented. This does not convert unmeasured sustained Google quotas or provider quality into facts. Conservative caps, fail-closed receipts, and exact-ID recovery remain in force while telemetry accumulates.
