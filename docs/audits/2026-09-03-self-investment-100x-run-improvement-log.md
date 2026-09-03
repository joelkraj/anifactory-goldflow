# Self-Investment 100X Production Improvement Log

Status: live run retrospective; update again after the private-ready render

Snapshot date: 2026-09-03

Run: `53rebirth/2026-W36-self-investment-100x-revenge-v1/ep_01`

Episode: `My Wife Cheated With Her Boss. Every $1 I Spent on Myself Came Back 100X | Manhwa Recap`

## Purpose

Capture what this production proves while the evidence is fresh, without changing the active run. The final update should distinguish measured improvements from hypotheses and convert only proven changes into pipeline defaults.

Next-run target: private-ready in under 12 hours, with 6-7 hours as the stretch target, while preserving story quality, reference continuity, an absolute 8-second visual-hold ceiling, and a reviewable upload package.

## Current Snapshot

- The approved narration is 69:28 with 12,774 Whisper words at approximately 183.9 WPM.
- The visual plan contains 798 cuts. The opening peaks at 3.52 seconds, the first 20 minutes at 6.92 seconds, and the complete episode at the locked 8.0-second ceiling.
- All 64 selected character, state, location, prop, and UI references were generated and approved.
- Visual-prompt planning produced 373 chunks with 12 concurrent Codex Medium workers in approximately 33 minutes. One blocked cut was repaired exactly; no full planner rerun was needed.
- Main still generation was configured as five persistent Flow projects plus three persistent Gemini image chats, but live testing showed that Flow and Gemini on the same Google account do not behave like eight independent throughput lanes. A Flow unusual-activity circuit coincided with immediate Gemini `1095` failures, so admission control must operate at the Google-account level.
- At the 19:00 UTC snapshot, the active 793-item browser work manifest contains 610 completed cuts, 109 untouched cuts, zero active leases, and 74 exact deadletters. Completed queue work is split between 405 Flow and 205 Gemini outputs. Together with five earlier accepted cuts, the official episode report now contains 615 of 798 images; all 615 current files match their recorded hashes and none are byte-identical duplicates. These are moving counts, not the final run totals.
- Short submission bursts repeatedly triggered Google's unusual-activity circuit. Continuous 45-second and 30-second dispatch passed bounded soaks; a 20-second tier failed immediately after the preceding traffic. Flow later returned a usage-limit message even after a full rest, and Gemini's image surface requires sign-in. Both generation queues are paused rather than repeatedly submitting into these blockers.
- Generated video is intentionally disabled for this run. Accepted stills will use directed single-plane motion and safe parallax where available.

## Measured Comparison With Faster Runs

The operator's recollection that a comparable production finished in roughly seven hours is correct.

| Run | Runtime | Visual cuts | Average cut duration | Preflight to render | Recorded image-stage span |
| --- | ---: | ---: | ---: | ---: | ---: |
| `2026-W32-goth-vampire-v1` | 78.9 min | 548 | 8.64 sec | 6.97 hr | 2.06 hr |
| `2026-W34-home-rebuild-100x-v1` | 75.3 min | 550 | 8.21 sec | 17.73 hr | 6.47 hr |
| `2026-W35-mafia-boss-ascension-v1` | 49.7 min | 622 | 4.79 sec | 15.88 hr | 5.22 hr |
| Current run | 69.5 min | 798 | 5.22 sec | In progress | In progress |

The current episode has 46% more cuts than the seven-hour Goth Vampire run despite being 12% shorter. That explains part of the larger workload, but it is not authorization to reduce the current 798-cut scope. The operator explicitly chose to preserve this density and solve the current bottleneck through higher accepted Imagen throughput.

Planning was not broadly slower than the seven-hour run: semantic planning was 24.2 versus 24.9 minutes, visual-beat planning was 45.1 versus 43.5 minutes, and visual-prompt planning was 45.9 versus 73.6 minutes. The avoidable pre-image losses were concentrated in Qwen/TTS, 86.3 versus 18.0 minutes, and reference generation, 60.3 versus 21.3 minutes.

## What Is Working

### Speed

- Medium is sufficient for high-volume semantic and visual-prompt translation. Premium reasoning is not required on every cut.
- Twelve-way prompt planning reduced a 373-chunk stage to roughly half an hour without losing contract coverage.
- Wavefront planning allows generation-ready cuts to reach the image queue before every later prompt has finished.
- Persistent Flow and Gemini lanes eliminate repeated login, project creation, tab startup, and chat setup.
- Exact-scope repair preserves hundreds of passed artifacts and avoids catastrophic full-stage reruns.

### Quality

- The reference library is producing visibly stronger character and location consistency than reference-light runs.
- The 798-cut plan comfortably satisfies the requested visual density instead of relying on long 14-second holds.
- Narration pace is inside the current 180-195 WPM production target.
- Early generated-scene inspection showed coherent manhwa styling and recognizable recurring identities.
- Thumbnail ideation is separated from scene imagery and will use ten packages, title-thumbnail pairing, measured winner/outlier context, and a simulated shelf test.

### Reliability

- Provider-local leases prevent the same cut from being submitted concurrently to Flow and Gemini.
- Completed artifacts are immutable and hash-bound.
- Deadletters identify exact cuts rather than invalidating the whole episode.
- URL and pixel fingerprint checks now catch some stale browser results that previously appeared to be new generations.
- Structural QA remains blocking while ordinary aesthetic preferences remain advisory, preventing taste-driven retry spirals.

## Problems Observed

### P0 - Imagen throughput is below the required production rate

The current run proves that visible tab concurrency and durable accepted throughput are different measurements. Five Flow projects plus three Gemini chats on one login can display eight workers, but they still encounter a shared or strongly coupled Google-account admission limit. Fast burst-and-rest dispatch produced high short-term utilization, then lost more time to 15-minute unusual-activity circuits and exact repair work.

Current-run decision:

- Preserve all 798 planned cuts. Do not recover time by thinning this episode or extending visual holds.
- Use the provisional 30-second continuous interval only after provider access is restored; evaluate sustained accepted throughput before promoting it as a next-run default. A 15-minute local circuit is a recovery policy, not evidence of the provider's quota reset. Stop when a single recovery probe still returns a usage limit.
- Keep the same persistent projects and chats; do not create a new tab, project, or conversation per cut.
- Treat Flow and Gemini as two surfaces behind one account-level admission controller until a controlled soak proves independent rate capacity.
- Count only accepted, downloaded, hash-unique outputs when comparing strategies. Submitted jobs and occupied tabs are not throughput.

Next-run improvement:

- Add an account-level adaptive dispatcher that learns a safe rolling rate from accepted completions, slows before a circuit opens, and ramps back through one recovery probe.
- Prewarm and authenticate every browser pool before Imagen becomes critical path, then run a bounded throughput soak before releasing the full queue.
- Shard each cut to exactly one account and provider before lease. Never duplicate a creative submission merely to keep a second account busy.
- Add a second independently authenticated Google plan/profile when scaling. Measure it as independent capacity before counting it in ETA; two surfaces on the same login do not qualify.
- Keep Flow and Gemini available inside each account pool, but route according to recent accepted p50/p90 service time, stale-output rate, and circuit state.
- Maintain an operator-approved non-Google exact-ID fallback only as optional overflow; do not silently change the production image route.

Capacity requirement:

- An 798-cut episode plus approximately 64 fresh references contains roughly 862 generated still assets before repairs and thumbnails.
- To finish from script lock to private-ready in 6-7 hours while reserving 2-3 hours for audio, planning, render, and final QA, Imagen must sustain approximately 215-250 accepted unique assets per hour across the complete federated pool.
- One healthy Google account historically produced roughly 100-130 accepted scene images per hour on comparable runs. Therefore the 6-7 hour stretch target requires two genuinely independent healthy account pools, or equivalent approved overflow capacity.
- The under-12-hour target is achievable with one healthy pool near 90-110 accepted assets per hour, provided browser circuits, handoff idle, broad QA, and retry loops stay controlled.

Success measure: at least 220 accepted unique assets per hour for the 6-7-hour profile, fewer than 1% stale/duplicate failures, fewer than 2% provider deadletters, and no account-level circuit during a 60-minute production soak.

### P0 - Browser result causality is still too weak

Flow can expose an old gallery result under a changed media URL. Pixel fingerprinting catches many stale responses, but duplicate outputs still reached the completion guard. The completion guard protected the episode, but every miss creates an avoidable repair cut.

Next-run improvement:

- Bind harvesting to a submission-specific DOM or network event, generation identifier, and submission timestamp instead of selecting the newest visible image alone.
- Record the pre-submit gallery fingerprints and reject every matching result, not only the currently selected preview.
- Require a post-submit loading-to-complete state transition in the same worker project before harvesting.
- Keep the final SHA-256 duplicate guard as the last line of defense.

Success measure: fewer than 1% stale or duplicate-result failures, with zero wrong-image acceptances.

### P0 - Restarting a provider with active leases creates artificial failures

A Flow host restart closed active browser contexts and deadlettered five otherwise valid in-flight cuts. Restarting can be necessary for a code change, but it must never happen as an ordinary live recovery action.

Next-run improvement:

- Add an explicit drain mode that stops new leases, waits for active leases to finish, checkpoints every slot, and only then restarts.
- Block host restart while active leases exist unless an operator explicitly chooses emergency termination.
- Keep code fixes queued for the next run when the current provider is still making forward progress.

Success measure: zero restart-induced deadletters.

### P0 - Production still depends too much on manual observation and handoff

The queue runs continuously once started, but stage completion, blocker triage, exact repair, and the next guarded command still depend on an agent noticing state changes promptly.

Next-run improvement:

- Emit a durable completion wake event when a manifest drains or a provider circuit opens.
- Have the orchestrator immediately run `run status`, classify deadletters, and prepare the exact next command.
- Auto-advance through automatic stages after a clean completion; stop only at genuine creative/operator gates or reviewed blockers.
- Display one live run dashboard with stage age, active slots, pending count, service rate, ETA, and blocker count.

Success measure: less than five minutes of unexplained idle time between automatic stages.

### P1 - Provider routing is not yet latency-aware or account-aware

Gemini is currently faster and more stable than Flow for many cuts, while Flow remains useful deadline capacity. Static five-plus-three allocation does not exploit live differences in service rate or failure rate.

Next-run improvement:

- Preserve persistent Flow and Gemini lanes, but group them by authenticated account and prioritize each newly ready cut for the healthy account/provider pair with the best recent accepted p50 completion time and lowest local failure rate.
- Keep one creative submission per asset; routing occurs before lease and never duplicates a cut.
- Open a provider-local circuit after repeated stale, transport, authentication, or rate-limit failures while the healthy provider continues.
- Allow reviewed repair batches to target the healthier provider without treating that as automatic blind failover.

Success measure: at least 90% slot utilization while work remains, with provider-specific p50/p90 latency and failure rates recorded.

### P1 - Reference quality is strong, but reference latency needs its own wavefront

Sixty-four references support continuity, and reducing them blindly would sacrifice a quality advantage the operator values. The speed problem is scheduling, not simply reference count.

Next-run improvement:

- Generate the style reference first as a hard barrier, then immediately release independent character, location, prop, and UI references across all healthy lanes.
- Begin beat and prompt work for scopes whose required references are already approved instead of waiting for the complete library.
- Cache immutable recurring identity and visual-language references across episodes when their exact contracts have not changed.
- Generate new state references only when a visually meaningful state change cannot be expressed safely from an existing approved identity.

Success measure: preserve reference continuity while reducing reference-stage critical-path time by at least 40%.

### P1 - QA must stay essential and asynchronous

Previous productions lost hours to broad aesthetic review and retries. This run correctly treats structural defects as blocking and most taste concerns as advisory, but downstream QA should begin as soon as accepted images arrive.

Next-run improvement:

- Run deterministic geometry, readability, hash, and duplicate checks on every image immediately after harvest.
- Apply semantic inspection only to the opening, title-critical payoffs, identity/contact scenes, and a deterministic sample of ordinary cuts.
- Never regenerate for incidental text, mild anatomy, or prettier composition unless the image is story-critical or structurally unusable.
- Build ordinary motion caches for QA-passed single-plane cuts while image generation continues.

Success measure: image QA adds less than 10% to image-generation wall clock and triggers only exact critical repairs.

### P1 - Visual motion quality needs intentional variety without generated video

No Veo is being used in this run, so motion quality depends on directed framing. Generic repeated zooms would make 798 good images feel automated.

Next-run improvement:

- Bind movement to each cut's authored action and focal point: push toward power reveals, pull away for loss, lateral moves for social confrontation, and locked frames for decisive reversals.
- Use crop-safe aggressive Ken Burns rather than tiny default zooms.
- Use parallax only when the accepted raster separates cleanly; expand the rear plate so foreground motion never reveals a ghost image.
- Detect repeated adjacent motion vectors and vary them before render.

Success measure: no obvious ghosting, no repeated three-cut movement streaks, and no accidental static holds above the locked density ceiling.

### P1 - Packaging evaluation must remain a proxy, not a claimed CTR forecast

Simulated viewers can rank packages and expose confusion, but they cannot produce a reliable real-world CTR percentage without calibration against channel outcomes.

Next-run improvement:

- Generate ten genuinely different title-thumbnail packages rather than ten cosmetic variants.
- Use one candidate at a time on a fixed mock YouTube shelf populated with measured channel winners and niche outliers.
- Randomize shelf position and compare first-click share, mean rank, and Borda score across at least 100 simulated choices.
- Keep thumbnail art simple: one to three subjects, one legible transformation or status reversal, short labels, and arrows only when they clarify a relationship or before/after change.
- Report a directional click-share proxy and confidence spread, never fabricated expected CTR.
- Save the operator's ranking separately from the simulated ranking and compare both to actual 24-hour, 72-hour, and 7-day performance after publication.

Success measure: every package communicates betrayal plus the status/power payoff at mobile size without merely repeating the title.

### Measured continuous-dispatch pacing on the active Google account

The September 3 production queue was used as a live throughput soak without reducing its 798-cut visual plan. Results are account-specific and should be revalidated after material provider changes.

- `45 seconds x 3 persistent Flow projects` passed 10 consecutive unique completions without an unusual-activity breaker. Observed accepted throughput was approximately 72-80 images per hour.
- `30 seconds x 3 persistent Flow projects` passed 15 consecutive unique completions without a breaker or creative-generation failure. Observed accepted throughput was approximately 105-120 images per hour.
- `20 seconds x 3 persistent Flow projects` opened Flow's unusual-activity circuit on its first completed submission after the preceding soak. A second request that was already in flight completed successfully. This tier was not isolated by a fresh account reset, so the result cannot separate the shorter interval from cumulative account traffic; it is sufficient evidence not to use 20 seconds during this production.
- The 20-second failure requires the full 15-minute account recovery before another clean comparison. Gemini is not a valid no-wait overflow on the same login because earlier probes showed strongly coupled account throttling.
- `30 seconds x 5 persistent Flow projects` passed 10 unique completions after full recovery. Only slots one through three were used; slots four and five remained idle. Accepted cadence matched the three-tab baseline, so the extra tabs produced no measured speed gain.
- Additional tabs cannot raise the 30-second theoretical submission ceiling of 120 per hour. They help only when long-tail generation latency leaves the smaller pool saturated; they are not independent provider rate lanes.

The five-tab soak continued to 32 accepted unique outputs before Flow returned "You've reached your usage limit" at 18:28 UTC. A single one-slot recovery probe at 18:44 UTC, after the full 15-minute rest, returned the same usage-limit message. This differs from the earlier unusual-activity warning. The quota period is unknown; it is not evidence that faster pacing or more tabs will restore access. The host was drained and stopped.

Current provisional setting after access recovery: three active slots and a nominal 30-second continuous interval. The shorter clean tests do not establish sustainable full-production throughput. Gemini's general chat authentication check passed, but its actual images page redirected to sign-in before any work was leased. The dedicated normal-Chrome login window remains open for the operator; verify the actual image composer before a single pending-item health probe. Do not silently migrate failed Flow cuts to Gemini.

Important implementation finding: `submissionStaggerMs` currently spaces **lease admission**, before reference upload and composer preparation, not the final Generate click. Among the first 32 accepted outputs of the five-tab soak, pre-submit reference-binding receipt gaps ranged from 7.721 to 61.962 seconds, with a 29.758-second median; three gaps were under 20 seconds despite the nominal 30-second setting. These receipt timestamps are a close pre-click proxy, not network submission timestamps. Variable preparation time can therefore bunch real submissions and confound the nominal pacing test.

Next durable fix: separate bounded preparation concurrency from one account-level Generate-click admission gate shared by Flow and Gemini. Record lease, references-ready, actual submit, result-ready, and completion timestamps independently. Queued prepared work must honor an open account circuit without another creative click, and a restart must restore the gate state rather than reset its clock. Validate that change in a bounded proof before replacing the currently productive live lane.

Next controlled comparison, only after access recovers: establish the actual-click 30-second/three-tab baseline first, then test 25 seconds with the same three tabs. Add tabs only in a separate test if all three are demonstrably saturated. Compare accepted unique images per wall-clock hour including failures and cooldowns, not occupied tabs or requests sent. Stop on provider limit/protection messages; retain the full cut and reference scope.

### Zero-spend reconciliation recovery

The 18:53 UTC reconciliation materialized passed work but correctly rejected `ep_01-w007336-w007348`: its staged PNG no longer matched the original completion hash. The retained provider download, normalized with the same Sharp PNG conversion as the bridge, reproduced the exact recorded hash. The changed file was preserved under a hash-named quarantine filename, original bytes were restored, and an exact-ID guarded reconciliation imported the cut without another creative submission or any receipt rewrite. The cause of the post-completion file change remains unproven.

Evidence: episode-local `manual_blocker_triage_image_generation_ep_01_20260903_reconcile.json`, original assignment/completion/provider receipt, and immutable reconcile-only stage reports. The episode remains incomplete with 183 missing cuts; a successful import batch is not image-stage completion.

### Gemini reference-retention recovery after sign-in

At 19:21 UTC the dedicated Gemini profile passed authentication and the actual Images composer check. The preceding one-cut probe had stopped before Generate because the local upload verifier did not recognize the new attachment UI. Gemini can display a JPEG filename for an uploaded PNG, and modern attachment previews no longer require a `gem-attachment` element. The old verifier also inspected unrelated gallery images, allowing slow downloads to consume its upload-check deadline.

The repaired verifier counts visible legacy or modern attachment previews, checks only newly added composer previews, and retains the exact hash-bearing filename observation while pixels load. A converted filename permits bounded preview compression drift only when its exact slot/ref/hash stem and attachment count match. Generated-output reference-echo detection remains unchanged.

An upload-only live proof retained one reference in 0.967 seconds and four references in 2.878 seconds, in the correct order. Source bytes remained SHA-256 verified; pixel differences ranged from 0 to 0.397 in this proof. No prompt was submitted and no image quota was spent. Evidence: episode `review_samples/gemini_upload_retention_20260903/proof.json` and `four-reference-composer.png`. Unit tests cover changed extensions, wrong slot/hash/name rejection, both attachment layouts, and exclusion of unrelated or unloaded previews. Real-generation health must still pass before restoring three active workers.

The subsequent two-reference production probe completed in 17.7 seconds and visually matched its scene. During the resumed three-slot queue, a spot-check found `ep_01-w004734-w004742` held an unrelated empty gym instead of Elaine at the expo dashboard. Its receipt had no `generated_result` and the page was still at `/app`, not a conversation. New dispatch was paused and active jobs drained. The cause was the old full-page image fallback, which could accept a lazily loaded gallery raster after its URL or compression changed. Faster apparent completion was not valid throughput.

Result acquisition now accepts only AI-generated images inside the newest `model-response`, excluding message-content IDs present before submission. Full-page/gallery and upload-preview output fallbacks are removed. Receipt audit identified 12 earlier Gemini completions without response evidence, including this cut; those exact hashes need review before final QA, not an episode-wide regeneration. The other provider outputs remain untouched. Tests cover delayed real output, exclusion of old response IDs despite changed URLs, and never consulting gallery candidates.

## Proposed Next-Run Operating Sequence

1. Preflight the episode and both provider profiles before script lock; verify authentication, model surface, three Gemini chats, five Flow projects, storage, and one harmless smoke generation.
2. Start semantic planning and the resident narration branch immediately after targeted speakability.
3. Run all bounded planning calls at Medium by default; reserve higher effort for the writer, global creative arbitration, difficult repairs, and final packaging judgment.
4. Materialize the style reference, then fan out all remaining references and release prompt scopes as dependencies clear.
5. Keep every healthy persistent image lane topped off through an account-level adaptive rate controller. Do not assume five Flow plus three Gemini surfaces on one login provide eight independent rate lanes, and do not open or close tabs per cut.
6. Perform incremental structural QA and motion-cache building while images continue.
7. Drain before any provider restart. Repair only reviewed exact IDs after the untouched queue finishes.
8. Auto-advance through focal analysis, structural QA, parallax decision, motion planning, render, and final technical QA.
9. Generate and evaluate ten title-thumbnail packages after final story truth and strongest visual payoffs are known.
10. Stop at the private-ready review gate before upload.

## End-of-Run Update Checklist

Complete this section after the private-ready render exists.

- [ ] Record total wall clock from approved script to private-ready render.
- [ ] Record active work time, idle/handoff time, and operator-wait time separately.
- [ ] Record duration and retry cost for every pipeline stage.
- [ ] Record Flow and Gemini submissions, completions, p50/p90 latency, stale outputs, transport failures, rate limits, and auth failures.
- [ ] Identify every deadletter by root cause, including failures induced by provider restart.
- [ ] Measure effective still throughput before and after persistent-worker fixes.
- [ ] Compare burst/rest dispatch with continuous 60-second human-paced dispatch using accepted unique assets per hour and circuit count.
- [ ] Record whether Flow and Gemini quota and rolling rate limits are actually independent on the same Google account.
- [ ] Calculate the number of independently authenticated account pools required to sustain at least 220 accepted unique assets per hour.
- [ ] Record reference-stage critical-path time and cache-reuse opportunity.
- [ ] Record image-QA sample results and the number of true critical repairs.
- [ ] Inspect the opening, three middle windows, climax, and final minute for visual continuity, motion variety, subtitles, and narration joins.
- [ ] Record render duration, cache hit rate, and any rerender cause.
- [ ] Save all ten package images, paired titles, simulated shelf results, operator ranking, and final selection.
- [ ] Decide which proposed changes become defaults, experiments, or rejected ideas.
- [ ] After publication, append 24-hour, 72-hour, and 7-day CTR, AVD, APV, traffic-source, and retention-cliff evidence.

## Evidence Locations

- Episode directory: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W36-self-investment-100x-revenge-v1/episodes/ep_01`
- Run identity: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W36-self-investment-100x-revenge-v1/episodes/ep_01/run_identity.json`
- Execution history: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W36-self-investment-100x-revenge-v1/episodes/ep_01/execution_events.jsonl`
- Visual beats: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W36-self-investment-100x-revenge-v1/episodes/ep_01/visual_beat_plan.json`
- Hardened prompts: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W36-self-investment-100x-revenge-v1/episodes/ep_01/section_image_prompts_hardened.json`
- Image execution ledger: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W36-self-investment-100x-revenge-v1/episodes/ep_01/cut_execution_ledger.json`
- Pre-render package hypotheses: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W36-self-investment-100x-revenge-v1/episodes/ep_01/thumbnail_package_hypotheses_pre_render.json`
