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

### Live cadence experiment - 2026-09-05

The operator explicitly restored the live Gemini shared submission gate from 90 seconds to 30 seconds for the prison skill-copy episode. The change was applied by updating the durable account gate only: the same three authenticated persistent Gemini tabs continued, Flow remained paused, and no accepted or failed cut was requeued. The first post-change admission was accepted at the exact 30,000 ms interval. Treat this as a live throughput observation, not proof of sustainable capacity, until a longer completion/error window is measured.

First bounded sample: over the verified five-minute observation window, accepted outputs rose from 42 to 51 with deadletters remaining at 2, all three leases occupied, zero transport failures, and no provider circuit. That is roughly 108 accepted unique images per hour at this three-tab, 30-second configuration. Keep the configuration for this run; it is above the one-pool under-12-hour planning threshold, though still below the two-pool 6-7-hour target.

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

The targeted review of those 12 unbound outputs confirmed nine wrong scene images and three usable images. The exact image hashes and decisions are preserved in `manual_blocker_triage_image_generation_ep_01_20260903_gemini.json`. The nine must be carried into official critical-cut QA and exact-ID recovery; the triage file alone does not invalidate them automatically.

### Gemini upload completion, not just preview retention

At 19:33-19:35 UTC three submissions returned to an empty Gemini home page without a retained request or response. Pre-submit evidence showed the attachment loading spinner even though Send was enabled. The earlier sub-three-second proof measured local preview retention, not completed uploads, and must not be treated as end-to-end upload readiness.

The browser now waits for the exact attachment count and no visible upload spinner for 750 ms, then rechecks readiness immediately before submission. Modern `.gem-attachment-content.loading` indicators are included. An upload-only four-reference proof completed in 7.775 seconds with all four hashes and ordered slots retained and no pending uploads (`uploads-fully-processed.json`); no creative submission was made. Unit tests cover a visible preview that is still loading, missing attachments, and completed uploads. A submit that lands on an empty home page now fails after 60 seconds instead of consuming the full 15-minute image timeout, without automatic resubmission. The old three waiters drained before restarting the host.

The one-cut live probe on commit `e11791b` passed: `ep_01-w007986-w008001` completed at 19:52:52 UTC, 24.1 seconds after its lease. Visual inspection confirmed the diligence folders, Joey's ringless hand/navy cuff, office setting, and requested system label. Two ordered references were retained. All 16 Studio suites and the Gemini-specific browser suite passed. This is recovery evidence, not a sustained throughput measurement. Restore three persistent Gemini slots at the existing 30-second lease stagger; leave the explicitly quota-limited Flow lane stopped.

The first three cuts after restoring the three-slot ceiling completed without transport failures: `ep_01-w008130-w008139` (two refs, 19.2 seconds), `ep_01-w008934-w008953` (four refs, 48.0 seconds), and `ep_01-w009001-w009015` (three refs, 18.6 seconds). All three were visually inspected and match their scene intent. Minor composition/count differences remain advisory. These short latencies do not prove three simultaneous generations: the 30-second admission stagger required only one or two occupied slots during this sample. The untouched queue remains running, with prior exact-ID failures preserved for later repair.

### Post-fix Gemini soak

From 19:54:37 to 20:21:04 UTC the unchanged three-slot/30-second lane collected 49 new outputs and recorded two terminal cut failures, over 26.44 minutes (111.2 collected outputs per hour). The failures were one disappearing Upload & tools control and one Gemini generation error; the next cut completed after the existing pre-submit stale-composer reset. No host restart, automatic cut resubmission, or pacing change was used during this interval. All three slots were occupied briefly when individual generations exceeded a minute. These counts measure successfully collected, hash-bound outputs, not final per-cut image-QA approval or a quota guarantee.

The staged manifest stood at 669 completions, 80 deadletters, and 44 untouched queued/active items. The 78 older failures were individually reviewed and saved in `manual_blocker_triage_image_generation_ep_01_20260903_recovery.json`; the two new failures must be added after the live queue drains. Retain the separate nine confirmed wrong-scene hashes for official critical QA and scoped replacement.

### False provider cooldown from prompt text

The original queue drained at 20:42 UTC with 712 completions and 81 exact failures (five other cuts were already materialized outside that queue). A reviewed 81-ID Gemini-only recovery collected six more outputs before a local false rate-limit classification stopped it at 20:46 UTC. The detector searched the entire page, including our prompt, and `/rate limit/` matched the substring in "separate limitation notices". This was not evidence of a Gemini limit. The 74 unsubmitted repair items remain eligible without repeating the six completions.

The detector now requires whole-word quota phrases and reads visible provider text excluding user prompts, editable composers, hidden content, and previous model responses. Regression tests preserve real rate/quota errors and cover the exact false-positive wording. All 16 Studio suites and the Gemini browser suite passed. The stopped cut's image actually completed in its existing conversation; it was retrieved without another creative request, with original prompt, ordered reference map, response ID, source URL, and raster saved under `review_samples/gemini_upload_retention_20260903/false-cooldown-retrieved-result.json`. Retrieval is not yet an accepted production import.

Only this proven local false cooldown may be cleared when restarting patched code after all jobs have drained. Flow's separate explicit usage-limit evidence remains authoritative; leave that provider stopped.

The recovered image was then imported through the guarded manual-import route with `browser_provider: google-gemini`, an exact original prompt/reference receipt and a separately labeled manual-collection receipt. The original failed lease/deadletter was not rewritten. This restored one cut with zero new creative requests.

At 21:08 UTC, a separate Gemini slot was observed waiting on the visible terminal response "I'm having a hard time fulfilling your request. Can I help you with something else instead?" No generated image existed. The detector now recognizes that refusal and "I seem to be encountering an error" as terminal generation errors, not quota evidence or proven policy violations. Regression fixtures cover both. An equivalent filtered-status wrapper may be applied to the live host to release this waiter without restarting other active jobs; failed IDs still require manual triage before any later resubmission.

### Completed 30-second Gemini recovery lane

The 74-item recovery manifest `codex-work-ffe9a4f8ff212df2b356d856` drained without restarting the host: 73 collected outputs, one terminal generation failure, no remaining leases or pending items. Successful leases ran from 20:57:28.960 to 21:34:52.925 UTC, 37.40 minutes: **117.1 collected outputs/hour**, with lease-to-completion p50 **21.37 seconds**, p90 **71.51 seconds**, and maximum **99.17 seconds**. The failed waiter is excluded from those success-latency percentiles but included in elapsed throughput. These are collection metrics, not final QA acceptance or future quota guarantees.

The single failure `ep_01-w012654-w012670` was manually reviewed as a generic terminal error without a raster or explicit quota/policy evidence. Its one exact-ID repair completed at 21:35:56 UTC. All 798 scene images were then materialized; focal analysis passed immediately afterward. Nine previously inspected gallery-reference captures remain explicitly critical-rejected for official QA and replacement, not accepted scene truth.

At a global 30-second admission stagger, three slots are already sufficient for most measured completions; faster admissions, not more idle tabs, are the likely next experimental variable. This is an inference from this soak, not approval to lower the current production delay. Test one variable at a time with collected unique images/hour, actual critical acceptance, error rate, and circuit count. Preserve the working lane during the current finish.

Thumbnail benchmark hygiene also caught two English-titled videos whose fetched artwork says HINDI. Replaced them before evaluation. The shelf now uses five own-channel winners and three niche comparators, exact verified titles, and uniformly hidden age/view/runtime/channel metadata. Synthetic scores remain preference diagnostics, never CTR predictions.

### Final image QA: reference captures versus aesthetic noise

The completed 798-image reference comparison found 25 near-identical reference rasters after geometry normalization. Visual inspection confirmed those captures; adding the earlier wrong UI capture produces **26 exact critical replacements**, not nine. This expands the earlier receipt-only finding, not the full episode's generation scope. Evidence lives in `manual_blocker_triage_image_output_qa_ep_01_reference_captures.json` and `review_samples/gemini_upload_retention_20260903/reference-capture-candidates.json`. The 26-item Gemini repair uses the unchanged three persistent slots and 30-second admission delay.

Official QA performed 393 cached semantic raster audits and produced 360 review rows. The first pass took approximately half an hour. Many findings concern visible-hand counts, hand laterality, object-edge contacts, background extras, exact framing, and inability to verify a reference that the audit did not receive. These are not equivalent to missing scenes or swapped principal identities. The parent reviewed all 393 verdict/discrepancy summaries plus selected sheets and exact ambiguous rasters; it did not claim to have separately opened all 798 full-resolution files. The hash-bound disposition retains those minor issues as advisories and repairs reference captures only.

One upstream exception is explicitly retained: the approved board-chair reference appears masculine, while the script later uses she/her. The scene outputs follow the approved reference. Repeating those prompts with the same reference would not fix the disagreement. Record this continuity weakness instead of silently calling it a perfect match or triggering a multi-stage rebuild during the finish. Future reference approval should check explicit source pronouns before generation.

Next-run candidates, not yet promoted defaults:

- Add a cheap normalized-reference duplicate screen at collection, with manual confirmation before rejection. A changed PNG encoding must not hide a reference echo.
- Audit real scene presence, decisive identity, critical object/action, and structural usability first. Do not turn every exact finger/hand/framing discrepancy into mandatory review.
- Give identity audits the relevant approved identity evidence, or explicitly classify unverifiable identity as uncertainty rather than failure.
- Keep successful semantic audits content-addressed. The expanded critical disposition reused all 393 audit rows without another model pass.

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

### Queue Drain Fix (September 3, 22:30 UTC)

- The 26-cut reference-capture repair completed 18, failed two with Gemini's generic 1095 error, and left six unsubmitted.
- Root cause for the six untouched jobs: the controller stopped after 15 seconds with zero leases whenever any deadletter existed. That is shorter than the configured 30-second admission stagger.
- Removed time-based idle completion. Pending work now continues after isolated failures; the controller still stops for drained work, failed required verification, a real provider circuit, runtime failure, or its overall timeout.
- Four regression tests cover staggered pending work, terminal draining, failed verification, and verification bypass. No browser restart or provider-rate increase is needed.
- Eighteen new rasters were visually reviewed on three replacement sheets. Eight exact IDs remain for recovery; no accepted assets will be resubmitted.
- The next exact-eight attempt stopped correctly on the real provider circuit, not an idle interval: two Gemini 1095 failures and six unsubmitted. After the full cooldown and one failed-home tab reload, a single previously unsubmitted cut also returned 1095 at 22:51:57 UTC. No account quota, policy cause, or stale-response cause has been established from that generic error.
- Provider submissions are stopped pending a changed condition or explicit exact-ID fallback approval. Asked the operator about Codex generation for only eight repairs and ten new thumbnails. Existing 790 usable scene rasters remain immutable; render is still gated by eight critical reference captures, not by aesthetic QA.
- At 23:08 UTC, a controlled attempt in another previously successful tab again returned to empty home and failed. Code inspection exposed a second local defect: persistent image workers accepted only `/images`, not the `/app/<conversation-id>` URL produced by a successful request. Thus tab reuse was real but conversation reuse was not. Fixed the persistent-surface predicate to retain actual conversation URLs while continuing to verify the Images mode before every submission. Fresh prewarm still requires `/images`; empty `/app`, foreign hosts, authentication checks, and new-response output binding remain unchanged. Added regression coverage for the real post-generation URL, not just the initial gallery URL. Whether this resolves 1095 remains unproven until the next post-cooldown live check.
- At 23:24:49 UTC, the post-fix exact-cut test retained its original conversation URL but still returned 1095. This proves the conversation-reuse fix works and does not prove provider recovery. Stopped submissions; waiting for the already-requested bounded fallback approval or external recovery. Scene readiness remains 790 usable / 798 total, with eight confirmed captures still blocking render.

### Operator-approved bounded Codex finish

The operator approved Codex built-in Imagen for exactly the eight remaining scene repairs and ten thumbnail candidates. The scoped approval and actual tool-source receipts are under `review_samples/codex_fallback_approved/`. This is not a global provider-route migration. All eight repairs succeeded in one creative submission each; all 790 other scene paths and file hashes were verified unchanged. The eight image-tool calls consumed approximately 399 seconds in aggregate, excluding review/import/handoff time. Ten separate reference-free thumbnail calls consumed approximately 280 seconds in aggregate. These timings are this bounded fallback's observations, not a demonstrated bulk production SLA.

Actual reference inspection exposed mismatched approved inputs: the public-portfolio reference displayed an access badge; the hotel-room reference displayed a conference room; the improved gym reference displayed an expo; the testing-lab reference displayed a hotel bedroom; the pledged-share reference displayed a property dossier; and the diagnostic-dashboard reference displayed an ownership register. The final replacement scenes follow their textual scene requirements and were inspected accordingly. Merely verifying attachment names and hashes did not establish semantic reference correctness. Next-run reference approval must compare the actual raster with its intended concept before it enters the library. Do not launch a full accepted-scene regeneration during this finish.

Final image QA passed 798 images with zero unresolved blockers and preserved prior exact-hash decisions. The eight changed outputs were visually inspected. Minor framing, incidental text, and nonessential numerical decoration remain advisory, not claims of perfect compliance. No automatic image retry was used.

The selective parallax pass produced one candidate. Its mask separated Joey, but the locked `local_blur_legacy` rear plate visibly retained his blurred silhouette. The agent declined it rather than permit ghosting or silently purchase a different background route. Motion planning passed all 798 cuts with zero static holds and zero layered parallax. Veo remains disabled. Full rendering started at four workers with `smooth_subpixel_ken_burns`; completion and final spot checks must still be recorded below.

The ten title-thumbnail candidates were rendered directly by the image model, including text and arrows, without reference images or post-composited typography. The blinded shelf test uses 20 evaluation calls with five synthetic personas each, not 100 independent human viewers. Results are directional preference rankings, not CTR estimates or a guarantee of audience performance.

The first simulator fanout failed before any valid result: its structured-output schema used unsupported `uniqueItems`. Dispatch incorrectly continued across all 20 batches and the CLI incurred websocket retry delays. Preserve those failure receipts. Recovery removed that keyword, enforced uniqueness locally, bound the schema hash, required exact batch IDs, and stopped dispatch on failure. One corrected five-persona batch passed before the remaining 19 batches were submitted. Future schema-bound panels must smoke-test one batch before fanout.

The initial render spent 2,033 seconds building motion caches, then failed at caption assembly. Five zero-duration punctuated Whisper groups had caused script words to be discarded by the caption filter. The generic repair joins collapsed groups to an adjacent anchored group without modifying Whisper, story, audio, images, or motion. Full-episode validation now preserves all 12,805 approved beat-caption tokens in 1,810 positive, nonoverlapping caption events; script versus beat-caption differences are punctuation/whitespace normalization, with identical ordered letters and digits. Caption validation now precedes motion rendering. The recovered render resumes through a new hash-bound failed-render receipt, not workflow bypass or a successful-render replacement.

Focused collapsed-caption and failed-render-resume regression tests passed, and `npm run check` passed 342 module syntax checks plus generated-workflow validation. The broader media suite reached an unrelated legacy ModelsLab credential lookup and failed with HTTP 403; it did not complete, and no media-test generation succeeded. Do not report the whole media suite as passed.

### Final render and technical QA completed

The full 69:28.41 master passed render at September 4, 01:16:13 UTC and final technical QA at 01:26:47 UTC (September 3 Eastern time). The output is 1920x1080, 60 fps, H.264/yuv420p with AAC audio, 1,804,212,530 bytes. Final SHA-256: `9e10b81abd07b0b9bee56f4fb00951060e276d5827d3b4c1cfa553bf03e47718`. All 798 cuts and 138 planned transitions are present. No generated video or parallax is included.

The recovered render took 748.45 seconds, reused all 798 motion clips and all 104 cached crossfade groups, and generated zero replacement motion clips. Including the initial failed render, render work consumed 46.36 active minutes across a 60.25-minute span. The caption fix and failed-render recovery are committed as `52ae81f`; preserving those caches avoided repeating the expensive motion work.

The full decode/black/freeze/silence scan took 429.04 seconds. It found no black intervals and no unexpected silence intervals. Its only advisory is a 2.1-second near-static span at 50:30, inside a 5.06-second gym reaction cut. Direct extracted-frame inspection shows a subtle horizontal move and a normal caption ending, not a missing image or a density breach. The separate final-review addendum records acceptance. The final audio keeps its prior narration QA waiver; no new subjective human listening pass is claimed.

Actual wall clock from exact script approval to the render was **19h31m22s**, and to technical QA completion was **19h41m57s**. This run missed both the 6-7-hour target and the under-12-hour fallback. The stage audit reports 411.44 active-union minutes and 772.01 idle/unattributed minutes from preflight to QA. Do not present that entire remainder as proven wasted time: four orphaned starts, browser activity outside guarded stage intervals, manual review, account recovery, and explicit operator holds limit the classification. The detailed stage table and gap classifications remain under `reports/performance/`. Thumbnail-panel time is separate and continues after technical QA.

The unchanged visual plan has 13 cuts beginning before 30 seconds (maximum 3.52 seconds), 247 from 30 seconds through the first 20 minutes (maximum 6.92 seconds), and 538 later cuts (maximum 8.00 seconds). No image-density reduction was used to finish faster.

All ten original thumbnail rasters are preserved. Upload-ready copies are 1280x720 JPEGs, each below 2 MiB, with source/output hashes in `assets/thumbnails/upload_ready/normalization_receipts.json`. Only geometry and encoding changed; lettering and arrows remain image-model rendered.

The official workflow now stops at `upload_packaging`, pending the operator's title/thumbnail and final-video review. No upload or public release has occurred. The next run still needs a controlled account-level actual-submit pacing test; the productive short soaks do not establish independent Flow/Gemini quotas or a guaranteed end-to-end production SLA.

### Completed package comparison

All twenty accepted evaluator responses validate: one hundred unique synthetic persona IDs, ten shelves per persona, unique complete rankings of nine cards, exact shelf membership, and consistent first-choice/rank-one fields. The reports bind accepted result hashes and the screenshot manifest; all original failures remain inspectable. A package-prefix metadata mismatch in the first local aggregate was corrected without changing any evaluator choices or rerunning a model.

Primary rank-point order is **P04 > P08 > P07 > P10 > P03 > P01 > P02 > P05 > P09 > P06**. P04 scored 166 points with 78 simulated first choices; P08 scored 192 with 79 first choices. The one-vote first-choice edge is effectively a tie. The relationship cohort favored P08 and the system cohort favored P04. These are correlated judgments from one model family, not one hundred independent humans, not predicted CTR, and not proof that all candidates beat real-channel winners.

The panel spanned 67m21s from the first attempted request to the last accepted result, mostly overlapping render and QA. Its corrected-schema phase still took 42m53s. It used twenty schema-rejected requests, seven timed-out corrected requests, and twenty accepted requests. At 600 seconds, completed responses were preserved and only exact failed or never-submitted batches continued at 1200 seconds. Future panels need one schema/latency smoke test before fanout; more synthetic personas must not be sold as more real-world certainty. Do not make this expensive panel an additional mandatory production gate.

The final gallery passed desktop/mobile browser checks: ten loaded images, correct rank/package sorting, working image/shelf/upload-JPEG links, and zero page errors. All twenty original/upload thumbnail hashes match their normalization receipt. Selection and publication remain unapproved. The operator ranking and real 24h/72h/7d outcomes must be appended later, not fabricated from this test.

- [x] Record total wall clock from approved script to technically ready render.
- [x] Save stage active time and idle/handoff classifications, retaining the attribution limits above.
- [x] Record guarded-stage duration and repeated-call cost in the performance audit; uninstrumented browser/manual work is not silently counted as zero.
- [ ] Record Flow and Gemini submissions, completions, p50/p90 latency, stale outputs, transport failures, rate limits, and auth failures.
- [ ] Identify every deadletter by root cause, including failures induced by provider restart.
- [x] Measure collected still throughput before and after persistent-worker fixes, separately from final semantic acceptance.
- [ ] Compare burst/rest dispatch with continuous 60-second human-paced dispatch using accepted unique assets per hour and circuit count.
- [x] Record that same-account quota independence remains unproven; account-level rolling throttling appears coupled in the observed probes.
- [ ] Calculate the number of independently authenticated account pools required to sustain at least 220 accepted unique assets per hour.
- [ ] Record reference-stage critical-path time and cache-reuse opportunity.
- [x] Record image-QA results: 26 confirmed reference/scene captures were replaced, with the final eight using the approved Codex route; 798 final images passed.
- [x] Spot-check final opening, middle, climax, ending, and caption-recovery frames; record narration's existing listening waiver rather than claiming fresh listening.
- [x] Record render duration, cache hit rate, and the caption-failure recovery cause.
- [x] Save all ten package images, paired titles, and complete simulated shelf results.
- [x] Record the exact final package selection: operator chose P04 with "Upload with po4"; no complete operator ranking was supplied.
- [ ] Decide which proposed changes become defaults, experiments, or rejected ideas.
- [ ] After publication, append 24-hour, 72-hour, and 7-day CTR, AVD, APV, traffic-source, and retention-cliff evidence.

### P04 upload preparation and explicit blockers

The operator selected P04's exact title and reference-free thumbnail for private-first upload. The upload-ready JPEG SHA-256 is `45b780e64abc170706127c4b676c93cfe5a23c6a1978914d07903bb829fe062d`. The package spec records the actual `codex_imagegen` provider instead of relabeling it as the originally requested Flow route. Public release, native A/B testing, and comment posting are not approved by this request.

Two small compatibility fixes passed the YouTube publish contract tests: accepting the explicitly approved Codex full-raster thumbnail provider while retaining the zero-reference/no-local-compositing checks, and reading final runtime from ffprobe's `media_probe.format.duration` as well as the older flattened fields. The default thumbnail route is unchanged.

Official packaging approval stopped only at `channel_experiment_runtime_below_range`: the final 4168.41-second video is 31.59 seconds below the existing 70-minute experiment minimum. No padding, render change, global experiment edit, or unapproved waiver was applied. Proposed ad breaks remain three manual sentence boundaries at 1092.20, 2120.45, and 3052.60 seconds, with automatic midrolls off.

Chrome also reported that JavaScript from Apple Events is disabled. Operator enablement was requested; no browser permission was changed. No upload, channel verification, public release, or comment action has occurred. Exact evidence and the narrow recovery are saved in `manual_blocker_triage_upload_packaging_ep_01.json`. Detect runtime eligibility immediately after the audio-duration stage and publishing browser readiness before the final upload handoff in future runs, rather than discovering them at release time.

### Future-run priorities after the final Gemini failures

The last eight cuts were not established prompt-policy refusals. Captured attempts returned generic `1095` errors, including after cooldown and a verified conversation-reuse fix. An earlier generic inability response is not proof of safety rejection either. Do not recategorize these as quota, moderation, or prompt complexity without new evidence. Confirmed local defects and unresolved provider behavior must remain separate in the failure ledger.

| Priority | Improvement | Evidence and next acceptance check |
| --- | --- | --- |
| P0 | Preserve the actual conversation, not only the browser tab. | The `/images`-only predicate navigated successful chats away from `/app/<conversation-id>`. The predicate fix landed, but `1095` persisted. A multi-cut soak must show stable tab and conversation IDs without per-cut navigation. |
| P0 | Finish reference uploads before submission. | Previews appeared before upload completion. Keep ordered identity/hash verification, exact attachment count, no loading indicator, and the immediate pre-send readiness check. Include slow uploads and extension changes in regressions. Do not reduce the selected reference library to make the test look faster. |
| P0 | Bind collection to the new generated reply. | Gallery/reference captures created 26 critical replacements. Retain newest-response evidence, reject pre-existing reply IDs, and add an inexpensive reference-echo check at collection so bad captures are caught before end-of-episode QA. Preserve the response and file for manual triage rather than automatically generating again. |
| P0 | Classify errors from provider messages only. | The old full-page matcher read `rate limit` inside our phrase `separate limitation notices`. Keep prompts, editors, hidden elements, and previous responses outside the error detector. Classify authentication, explicit policy refusal, explicit quota, generic generation error, upload failure, and collection failure separately. |
| P0 | Keep the queue alive through configured admission delays. | A 15-second idle stop abandoned six pending repairs under a 30-second stagger. The queue-drain fix landed. Regression-test pending work after an isolated failure and prove that a real provider circuit still stops dispatch. |
| P0 | Pace actual Generate clicks at account level. | Three-slot/30-second recovery collected 117.1 images/hour, not the 220/hour planning target. Preparation and upload time can bunch later clicks. Log lease, refs-ready, actual submission, response-ready, and collection independently; share admission/circuit state across Flow and Gemini on the same account until independence is demonstrated. |
| P1 | Isolate the unresolved error with a bounded diagnostic, not blind production retries. | On a healthy account, compare one benign prompt and identical references manually versus the automation path. If useful, separately compare full versus simpler wording, then reference-free versus referenced input. Change one variable at a time, label scope/latency/success, and stop on explicit provider limits. This is a proposed test, not a proven fix or authorization to evade moderation. |
| P1 | Stop repair escalation before it consumes the evening. | Preserve accepted assets and original failed receipts. After a terminal error, inspect evidence; after recovery wait, use one bounded health probe only when a condition changed. If it still fails, seek an exact-ID fallback once rather than repeatedly reloading or restarting. The eight-cut Codex finish succeeded, but it does not establish bulk-provider reliability. |
| P1 | Keep QA essential and incremental. | Continue per-file integrity, geometry, hash, reference-echo, and confirmed identity/story checks. Use cached/risk-selected semantic checks rather than turning hand-count or composition advice into a full episode retry. The 393-audit/360-review-row pass cost roughly half an hour; measure critical defects found per QA minute. Preserve the <=8-second cut ceiling. |
| P1 | Make handoffs event-driven and recoverable. | Persist completion/failure events and wake the next eligible stage immediately. Keep provider workers resident; never restart a host with active leases. Reuse accepted prompt, image, motion, and crossfade caches. Measure ready-to-start delay separately from active compute before introducing a local organizing model. |
| P1 | Remove packaging and publishing surprises from the finish. | Verify the publishing browser/channel before render ends; check experiment runtime after final audio timing. Record a video-specific exception when approved rather than padding or silently changing the experiment. Keep thumbnail comparisons bounded: the 100-persona panel took 67m21s and is not measured CTR or a mandatory production gate. |

These are implementation/proof priorities, not a claim that the next run now guarantees 6-7 hours. Code-level fixes already noted above still need sustained browser validation. Do not increase tab count or buy another account until actual-submit throughput, errors, and accepted unique images/hour show the bottleneck. Keep visual density and approved reference consistency intact.

### Renewed upload instruction

After disclosure of the 31.59-second runtime shortfall, the operator again requested upload and this audit update. The unchanged 69:28.41 master is now recorded as a video-hash-bound runtime exception; the global 70-80-minute experiment remains unchanged. Preserve this protocol deviation in analysis, the three manual ad opportunities, and private-first visibility. Runtime-exception validation rejects a different video hash, duration, experiment, missing approval metadata, or unapproved state, and does not waive ad-setting checks. Focused publish-contract tests passed.

P04 packaging approval and publish readiness both passed through the guarded CLI. The publish manifest re-verified the unchanged final video and selected JPEG and preserves the runtime deviation. Official status now names `youtube_studio_upload`.

Chrome's JavaScript-from-Apple-Events permission remained off at the latest check. No upload has started, no video ID has been created, and no permission was changed silently. The next action is browser enablement and visible Manhwa Joey verification, not more image generation or rendering. The upload-stage hold is recorded in `manual_blocker_triage_youtube_studio_upload_ep_01.json`; the older packaging hold remains historical.

### Publishing-browser correction and upload started

The operator correctly reported that the permission had already been enabled. The earlier checks targeted the separate Gemini automation Chrome process (PID 32580), not the normal user Chrome process (PID 705). JavaScript from Apple Events works in the normal Chrome session. The previous blanket browser-blocked conclusion was an agent routing error, not an unresolved operator setup task. No permission was changed.

The recovery targeted the correct running Chrome process, reused its existing Studio tab, and visibly verified Manhwa Joey and channel ID `UCZah1gv3wyUfEIvJdTacWjw` before selecting the exact hash-approved video. Studio created video ID `s50ZgQ_GZwc`; transfer has started. The episode-local `youtube_upload_in_progress_ep_01.json` records this ID so interruption recovery must resume the existing upload rather than create a duplicate. P04, title, description, tags, audience, and comment settings have been checked in the upload UI. Transfer, checks, manual ad configuration, and final private-save verification are still in progress at this entry; this is not a completed-upload receipt.

Future publishing preflight must enumerate running browser instances, bind to the existing verified Studio tab and process, and distinguish permission failure in that process from a failure in an unrelated media worker. Do not ask the operator to repeat a permission change based on an unbound app-name check. Scope controls to the active upload dialog rather than background catalog controls, bring the intended tab forward before native file selection, and preserve all unrelated tabs and workers. Add a two-Chrome-instance regression/proof before calling this a durable fix. Startup/channel readiness should be checked before the render handoff, and transfer/processing time should be reported separately from production and agent configuration time.

Native keyboard entry also needs an immediate foreground check in the same action: one timestamp was sent to Codex instead of the browser after focus changed. The corrected action activates the exact Chrome process and tab, focuses the observed input, enters the value, and rereads that field. The accidental chat text is not an operator change to the plan. Studio now shows three manual slots (`0:18:12:06`, `0:35:20:14`, `0:50:52:18`) and automatic slots off. Its editor exposes frame timecodes; retain these observed values alongside the planned second positions, including the second position's frame-rounding difference, rather than claiming arbitrary subframe precision. Final saved-page verification is still required.

### Private upload saved; provider checks pending

At 05:03:02 UTC on September 4, Studio confirmed the complete transfer and private save of `s50ZgQ_GZwc`. The exact P04 image, title, description, tags, non-child audience, no age restriction, approved fictional-content disclosure setting, and comments-on state were read back on the saved video. Copyright subsequently reported no claims and no copyrighted content found. Ad suitability still says `Checking`; do not mark the official upload receipt complete until that check resolves. No public release or pinned comment occurred.

The saved monetization page confirms manual-only midrolls. After processing, the ad editor switched from its provisional 30fps display to 60fps and shows `0:18:12:12`, `0:35:20:28`, and `0:50:52:36`. These correspond to 1092.20, 2120.4667, and 3052.60 seconds. The middle slot remained one-sixtieth second later than the planned 2120.45 even after a precise edit and reopen. Preserve that small observed UI quantization in analytics rather than silently asserting exact arbitrary-second support. Future planned slots should use the editor's reliably persisted grid and verify after processing; this is not a reason for a new render, extra ad opportunity, or extended retry loop.

### September 4 narrow next-run implementation

The Google desktop hosts now share a durable final image-submit gate under `google-account-submit-gate` in their shared state directory. Preparation can overlap, but the gate holds a cross-process lock through the actual click and spaces the next click at least thirty seconds after that click finishes. A common `--google-submit-gate-dir` is required if Flow and Gemini use different state roots for the same account. `--google-submit-interval-ms` supports thirty to sixty seconds; the existing lease stagger remains preparation admission, not proof of actual submission spacing.

Rate-limit and opened transient-failure circuits persist across both providers and host restart. A shared pause stops new leases and prevents prepared jobs from clicking; those exact jobs are recorded for triage, never automatically regenerated. Authentication and explicit usage-budget holds remain provider-specific because quota independence is unresolved. Crashed submission locks fail closed for manual inspection rather than being assumed safe to click again. No new account, concurrency increase, quota bypass, or creative retry was introduced.

Completion receipts now distinguish lease, refs-ready, submit, result-ready and collection timestamps, with the account-gate receipt attached. The change preserves persistent tabs/projects, selected references, prompt content, cut density, Qwen, and disabled Veo. Flow generated-result evidence is retained when the collector supplies it; this does not claim the gallery fallback is fully causal or that every source reference is semantically correct. Actual raster-to-concept review remains required.

Regression tests cover two independent Node processes sharing pacing, concurrent readiness, slow clicks, durable intervals, shared circuit admission, host drain, ambiguous clicks without retry, and interrupted locks. The Studio suite and source-manufacturer tests passed before this addendum; full syntax/workflow checks passed. This is implementation evidence, not a live throughput result. Before bulk references/cuts, use the first bounded set of required assets to verify stable worker surfaces, correct uploaded concepts and real click spacing. Do not repeat accepted assets as a benchmark or claim a six-hour SLA from unit tests.

The source editor also accepts compact, exact-script-hash-bound director notes. The current prison source keeps its three GPT-5.6 Pro candidates, Medium comparison and Medium/High revision policy. Director review runs between useful rounds, preserving the incumbent instead of accepting simulated numerical gains alone.

The prison High edit exposed an additional source-stage transport loss: two 82K-character requests timed out in composer insertion before Send. The external Electron adapter still used a 100K inline threshold, unlike Studio's 24K threshold. Its source now uses 24K and the standalone jobs bundle was rebuilt without restarting Electron. Long inputs use the existing exact UTF-8 attachment route, not a condensed script. A paragraph-heavy regression verifies byte equality; 100 browser/harness/job tests passed under Bun 1.3.14. This is a transport fix, not evidence that the High model generated a better story. Only the failed exact editor scope may resume; passed drafts and comparisons remain preserved. The external bridge already had unrelated uncommitted work, which was not reverted or committed with Goldflow.

Deployment check: the installed Electron browser helper, not just the jobs bundle, must contain the changed threshold. The first bundle-only attempt still used the installed old helper and failed before Send. After backing up and rebuilding that exact helper without an app restart, the next same-prompt High request visibly retained its task attachment, submitted one user message, and began generating at approximately 16:37 UTC. This proves recovery of submission only; output quality and total latency still require the final receipt.

### September 5 prison-run regression: repeated Gemini 1095

The prison episode reached 199 materialized cuts out of 906 after reconciling one recovered success. A broad recovery produced one success and sixteen failures before its background manifest was fully stopped. Stopping the CLI monitor alone did not stop desktop dispatch; pause the controller and deactivate unfinished manifests, then verify active jobs are empty. Never describe a queue as stopped based solely on the monitor process exiting.

The attempted speed fix classified every generic Gemini generation error as asset-local. That let repeated numbered `Something went wrong (1095)` failures drain the queue. The worker now counts numbered service errors toward the existing three-failure transport circuit and shared Google pause; unnumbered image inability stays local. All 16 Studio suites pass, including a simulated three-cut Gemini failure sequence that verifies circuit opening and the shared pause. The resident host predates the fix and must reload before sustained dispatch; passing tests do not establish live provider recovery.

At 03:31:48 UTC a single untouched document cut, `ep_01-w005963-w005969`, also failed with 1095. Its pre-submit screenshot showed the correct single UI reference, enabled Send, Images mode, and a retained successful conversation. The reference receipt reports an exact pixel match. This rules out missing attachments for that attempt and shows failures are not restricted to multi-reference scenes. The cause remains unverified; do not relabel 1095 as a policy refusal, quota exhaustion, or proven account restriction.

Gemini and Flow are paused. There are 707 missing cuts and no defensible fixed finish time until an authorized lane recovers. Thirty-second pacing gives a theoretical ceiling of two submissions per minute, not a guarantee of two accepted images per minute. A second account would require its own measured capacity and authorization; do not promise that it fixes the error or doubles throughput.

Episode evidence: `2026-W36-prison-skill-copy-revenge-v1/episodes/ep_01/manual_blocker_triage_image_generation_ep_01_1095_recovery.json` and manifest `codex-work-237cdfc895f681e0a07131e5`.

### September 5 Flow recovery and persistent-picker defect

At 04:07 UTC Flow completed a post-idle exact-cut check. A three-slot six-cut wave then completed six of six between 04:09:51 and 04:12:18, taking the materialized count to 206/906. Gemini's post-idle check still returned 1095 and remained paused. Keep these provider outcomes separate; this does not establish independent quotas or account-wide recovery.

The six-cut wave exposed a local reference defect before bulk expansion: the first composer attachment for `ep_01-w002200-w002216` was the prior job's dining hall, not Noah. The media picker retained a prior selected item while the new filename and enabled Add to prompt were both visible. The former receipt proved chip count/order but could mislabel the selected raster. `selectUploadedPreview` now explicitly selects the exact new upload before accepting Add, preserving an already selected row. All 17 Studio suites pass, including a stale-enabled-selection regression. Flow was reloaded once at 04:16 UTC for a bounded three-cut verification using four references per cut. Existing outputs remain preserved for exact provenance review, not broad regeneration.

At 04:19:44 UTC the post-fix four-reference wave passed 3/3. All three pre-submit composer screenshots were inspected and showed the correctly mapped attachment order; a resulting speakerphone scene was also inspected. The queue is resuming only 652 untouched missing IDs on the three persistent Flow projects. The remaining 45 previously attempted missing IDs stay separate for scoped recovery. A chronological receipt audit also flagged 32 earlier Flow cuts with contradictory media/source mappings; preserve their images and resolve their exact provenance rather than regenerate the entire episode.

Throughput accounting: the shared 30-second actual-submit gate caps total dispatch at 120/hour even if both Google providers are enabled. More tabs cannot exceed that configured ceiling. With about 700 missing images, 5h50m is a no-overhead/no-failure submission floor, not a private-upload ETA. Measure sustained usable completions after reference verification before quoting a shorter production window.

The sustained check did not hold: manifest `codex-work-475c2826a9472d744f3afdaf` imported 13 more successes, then Flow returned `usage_limited` / unusual activity at 04:27:48 UTC. Two other leased cuts were cancelled before Generate, and 636 remained unclaimed. Both controllers were paused and the episode manifest deactivated; the terminal process imported all 13 successes. Total materialized images reached 222/906, with 684 missing. The 16 post-fix Flow completions have no cross-source media UUID conflicts. This supports the attachment fix, not provider reliability. Withdraw the provisional 8-11 hour finish projection. The five-minute local cooldown is not a promise that Google permits generation again after five minutes; do not cycle broad retries or lower the submit interval against active usage protection.

At 04:35:46 UTC, one exact unchanged cut still returned unusual activity after more than seven minutes idle. This bounded check followed [official Flow guidance](https://support.google.com/flow/answer/16353333) to wait a few minutes before retrying; system/process proxy checks showed no configured proxy, and no account/network settings were changed. Manifest `codex-work-0b9e0717f9826e1b5a11baf2` failed cleanly and was deactivated. Both queues remain paused. All 222 materialized rasters match recorded hashes, and no completed scene is stranded in staging. Further broad dispatch is not authorized by a timer expiry alone.

### September 5 resumed recovery after a longer idle

The goal resumed at 05:12 UTC. Both live controllers were still paused, with no episode work in flight. After more than 36 minutes since the last actual Flow failure, exact-cut manifest `codex-work-9cee5e3aaf88fbf4fe907b6a` completed one unchanged two-reference scene. Its actual raster and composer attachments were inspected. A subsequent one/three/four-reference wave, `codex-work-fbdf2b4736807ef5de0e3620`, passed 3/3, reaching 226 materialized images. One slot required pre-submission upload recovery; it did not submit a second creative generation.

Only the 633 untouched missing cuts were resumed in `codex-work-25fe440f126849d7cdfd2dd6`, using the existing three Flow slots, continuous top-off, and 30-second shared actual-submit spacing. At 05:34 UTC the live batch had 21 completed, three leased, 609 pending, and zero deadletters. Gemini remains paused; 47 previously attempted missing IDs remain a separate exact-repair scope. These staged completions are not yet part of the 226 materialized count: the current browser-pool command imports them at terminal reconciliation. Preserve that distinction when reporting progress or ETA.

While generation ran, all 32 historical attachment-conflict screenshots were reviewed against their ordered reference assets. Each showed a wrong or misordered required attachment. The episode-local `manual_blocker_triage_flow_reference_collision_confirmed_ep_01.json` binds every affected raster, provider receipt, and screenshot hash. At official image QA, carry these exact IDs into required-reference-binding rejection and scoped recovery, not broad regeneration or rewritten old receipts. No new cross-source media UUID conflict was detected in the post-fix completions scanned at 05:32 UTC. This supports the picker correction but does not prove uninterrupted long-run provider availability.

### September 5 renewed stop and ETA correction

Manifest `codex-work-25fe440f126849d7cdfd2dd6` stopped on Flow unusual activity at 05:41:49 UTC. Terminal reconciliation imported all 36 successes: 262/906 images are materialized, 644 are missing, and 32 older materialized cuts separately require the confirmed reference-binding recovery. The manifest has three failures and 594 unclaimed cuts. One failure is usage protection, one cancellation before Generate, and one exact uploaded-reference preview timeout before Generate. Both controllers are paused with zero active jobs and no current-episode manifest registered. Do not mistake the expired local timer for restored provider access.

The 36 completions from manifest creation at 05:22:54 to the last completion at 05:41:41 represent 114.96 saved images/hour over an 18.79-minute window, not sustained full-run reliability or final semantic acceptance. The 676 remaining generations including known replacements have a 5.63-hour submission floor at the shared 30-second gate and a 5.88-hour short-window projection before outages, repairs, QA, motion, render, packaging, and upload. No fixed completion deadline is supported while generation is paused.

Google's [Flow help](https://support.google.com/flow/answer/16353333) now explicitly states that per-minute generation allowance can decrease after many daily generations. This supports adaptive pacing as a candidate, not a diagnosis of this exact error. Proposed next bounded comparison after recovery: retain three persistent slots and test 45-second actual-submit spacing against accepted output per elapsed hour including downtime. Do not add tabs, shorten spacing, silently switch providers, reduce cuts or drop required references. The comparison is not yet executed or promoted.

At 05:58 UTC, the single exact recovery `codex-work-1e86865b335cf4f66cdc3b88` returned the same unusual-activity error after sixteen minutes idle. The shared durable gate was increased to 45 seconds without reopening workers, and the immutable submission receipt confirms that setting; this was a failed access check, not a successful 45-second throughput test. Both controllers were paused again and the manifest deactivated. Counts remain 262 materialized and 644 missing. All 36 successes from the preceding bulk batch now have a saved exact-raster/ordered-reference verification report with no post-fix media-ID collisions. These checks do not waive the 32 older confirmed reference failures or final image QA. Stop repeated goal polling and immediate probes at the three-turn blocker threshold until provider access or authorized routing changes.

### September 5 first overnight wake: transient recovery only

At the 07:08 UTC scheduled wake, both hosts were alive and paused, no image job was active, and the last actual failed generation was more than an hour old. The unchanged zero-reference cut passed in `codex-work-ff1269a293b7dc0ff81be4d0`. An inspected one/two/four-reference wave then passed 3/3 in `codex-work-ef9860bfbc022695066c4bd8`. Each actual raster hash and ordered-reference source hash matched; the shared 45-second minimum was present in every submission receipt.

The 591 never-attempted missing cuts entered `codex-work-c523bff82afecac5257d1b6a` without touching passed assets or prior failures. Only two more completed before Flow returned unusual activity at 07:20:59 UTC. The other two active items cancelled before Generate, 586 stayed unsubmitted, and terminal reconciliation preserved all successes. Both controllers were paused and the episode manifest deactivated. Current totals: 268/906 materialized, 638 missing (586 unattempted plus 52 attempted), with the same 32 older reference-binding replacements still separately required.

This wake added six usable rasters, but 45-second pacing did not establish reliable sustained access. Do not report the successful verification wave as a recovered production lane. The next reviewed single recovery check must be no earlier than 08:20:59 UTC. Keep hourly monitoring quiet, preserve exact failures, and do not use the five-minute local circuit expiry as permission to cycle submissions. Episode evidence: `manual_blocker_triage_image_generation_overnight_20260905_0712.json`.

### September 5 second overnight wake: conservative admission backoff

The 08:08 UTC wake slept until the one-hour minimum after the 07:20:59 failure, then the unchanged one-reference recovery `codex-work-eb88f840eb5430593c5d34f4` passed. After inspecting its raster and exact reference receipt, the shared durable submission minimum increased from 45 to 90 seconds while no jobs were active. Hosts, profiles, worker-slot count, prompts, reference attachments and cut density were unchanged. This is operational backoff after repeated protection, not a claim that a particular cadence bypasses or resolves Google limits.

A zero/two/four-reference continuation passed 3/3 in `codex-work-7a23d6eb3c5ed762d341065d`; actual rasters, hashes and ordered attachment receipts were inspected. Materialization reached 272/906. Only 583 never-attempted missing cuts entered `codex-work-c3c3b4ec7b77ad7e322de758`, preserving 51 prior attempted missing IDs and the 32 older binding-repair scopes. At 08:41 UTC, that exact live batch had six staged completions, three active leases, 574 pending and no failures. Exec session 92876 remains the owning process. Do not confuse staged successes with the unchanged aggregate report before terminal import, or launch a duplicate batch from a scheduled wake. No finish ETA is established by this short window.

### September 5 third overnight wake: sustained access still unproven

The preceding batch terminated at 08:44:52 UTC after eight saved outputs. Flow returned usage protection at 08:44:34; two prepared jobs stopped before Generate and 572 cuts were never submitted. All eight successes were imported, leaving 280 materialized and 626 missing. The earlier 08:41 live observation above is historical, not current process state. The 90-second interval also failed to establish sustained access.

The 09:08 wake reconciled that terminal batch and paused both controllers, then slept until more than one hour after the actual failure. The unchanged four-reference recovery `codex-work-d47d207580aa94c2de7ba54d` passed at 09:47 UTC. Its raster and exact 4/4 reference hashes were inspected; materialization reached 281/906. Three never-attempted three-reference cuts entered bounded continuation `codex-work-67f1eafb54ac68d903a5ed88`, retaining the same hosts and 90-second minimum. The hourly heartbeat now explicitly preserves that stricter gate. A passed recovery is not permission to report stable throughput or a finish deadline.

At 09:58 UTC, that bounded continuation passed 3/3 with inspected rasters and exact ordered-reference receipts. The episode has 284 materialized cuts and 622 missing. Only 569 never-attempted missing IDs entered `codex-work-fb92381c1863409584df3210` (exec session 12859); 53 prior attempted missing IDs and the 32 older materialized binding failures remain held for scoped recovery. At 10:00:29 UTC the queue was live with three leases, 566 pending, and no completed or failed items yet. The next wake must follow this exact process rather than create another queue. The 90-second minimum remains unchanged.

At 11:47 UTC the same queue terminated after 71 saved images, taking materialization to 355/906. One earlier exact reference-upload preview timeout occurred before Generate; the terminal stop was renewed Flow unusual activity, followed by two pre-Generate cancellations. All 71 raster hashes and ordered-reference hashes matched and every actual-submit receipt retained 90-second spacing. The queue stayed active for roughly 108 minutes, longer than previous recovery windows, but still did not establish unrestricted or full-episode reliability. Keep 494 never-attempted missing IDs, 57 attempted missing IDs and the 32 older materialized reference repairs separate. At the 12:09 wake, all successes were imported, no jobs remained and both controllers were paused. One reviewed recovery may occur no earlier than 12:47:24.841 UTC; no broad rerun or provider switch is authorized by the local five-minute timer.

The 12:48 UTC exact-cut recovery followed more than one hour without submissions but still returned unusual activity at 12:49:52.254 UTC (`codex-work-128cd0ed77def85ba7b93935`). Its actual-submit receipt confirms the unchanged 90-second gate. No image was added, both controllers were paused again, and the exact manifest was deactivated. Counts remain 355 materialized and 551 missing; do not immediately expand or retry from the expired local cooldown. The next reviewed scheduled check must be no earlier than 13:49:52.254 UTC.

### September 5 morning handoff

The final scheduled recovery, after another hour without submissions, failed with the same Flow unusual-activity message at 13:52:40 UTC (`codex-work-413a0d1ffb55d4f268f9cae0`). Both controllers are paused, no active episode manifest remains, and there are no in-flight jobs. The overnight window added 93 materialized images, from 262 to 355/906. There are 551 missing images (494 never attempted and 57 attempted), plus the unchanged 32 older materialized reference-binding repairs. Narration, script, density and all successful rasters remain preserved; render and upload were not reached. The 90-second gate produced one longer 71-image window but did not remove provider protection. No further automatic recovery is scheduled in this overnight window and no finish ETA is defensible while blocked.

Episode handoff: `manual_blocker_triage_image_generation_overnight_20260905_1351.json` and the latest pointer in `manual_blocker_triage_image_generation_ep_01_1095_recovery.json`.

## Evidence Locations

- Episode directory: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W36-self-investment-100x-revenge-v1/episodes/ep_01`
- Run identity: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W36-self-investment-100x-revenge-v1/episodes/ep_01/run_identity.json`
- Execution history: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W36-self-investment-100x-revenge-v1/episodes/ep_01/execution_events.jsonl`
- Visual beats: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W36-self-investment-100x-revenge-v1/episodes/ep_01/visual_beat_plan.json`
- Hardened prompts: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W36-self-investment-100x-revenge-v1/episodes/ep_01/section_image_prompts_hardened.json`
- Image execution ledger: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W36-self-investment-100x-revenge-v1/episodes/ep_01/cut_execution_ledger.json`
- Pre-render package hypotheses: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W36-self-investment-100x-revenge-v1/episodes/ep_01/thumbnail_package_hypotheses_pre_render.json`
