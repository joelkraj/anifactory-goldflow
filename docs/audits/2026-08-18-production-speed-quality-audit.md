# Goldflow Production Speed and Quality Audit

Audit date: 2026-08-18

Measured run: `53rebirth/2026-W33-maintenance-founder-acquisition-v1/ep_01`

## Executive Finding

The pipeline has strong artifact safety but was operated like a collection of jobs rather than one continuously driven production. The measured run took 20.43 hours wall clock. Only 7.34 hours contained any active stage work, leaving 13.08 hours idle and 35.95% utilization. Improving orchestration and provider reliability is therefore worth more than weakening quality gates.

The current 180-minute target is a stretch target, not a credible service-level expectation for a 400-plus-cut, selective-video episode at measured provider throughput. A future SLO should scale with required still count, generated-motion count, and provider health rather than use one fixed number for every format.

## Ranked Findings

### P0 - Automatic work stopped after recoverable holds

The agent driver stopped after an early semantic failure and was not consistently re-entered after scoped repairs. The run contained 415.9 minutes of avoidable forward-pipeline idle. The largest unexplained automatic-stage gaps were 199.0 minutes before generated motion and 51.4 minutes before scene image generation. A separate 98.8 minutes occurred during backward stage movement for rerender or other out-of-order rework and is reported separately rather than blamed on normal advancement.

Implemented: every director refresh writes a performance audit, and blocker holds print a canonical `run director --action advance` re-entry command.

### P0 - ChatGPT Image degraded both throughput and planning capacity

| Provider | Attempts | Failures | Failure rate |
| --- | ---: | ---: | ---: |
| Google Flow | 295 | 26 | 8.81% |
| Gemini Web | 269 | 23 | 8.55% |
| ChatGPT Web | 41 | 26 | 63.41% |

Ten ChatGPT failures were rate limits, and the image jobs used the same scarce browser/account surface needed by premium GPT-5.5/5.6 story work.

Implemented: new `resource_aware_google_web_pool_v2` identities automatically use Flow-five plus Gemini-three. ChatGPT Image is explicit exact-ID fallback only. Legacy V1 identities remain valid and unchanged.

### P0 - The planner pool kept leasing to an unauthenticated provider

The planner chunk ledger contained 37 failed entries: 16 Antigravity authentication or eligibility failures, 7 planner timeouts, and 12 malformed-output or contract failures. After Antigravity authentication expired, new chunks continued reaching it and repeatedly waited for OAuth timeout.

Implemented: the federated planner pool now opens a provider-local circuit immediately for fatal auth or eligibility failures and after three consecutive transient transport failures. Already-leased failures remain exact-scope repair work; only not-yet-leased chunks use the remaining healthy capacity.

### P0 - Status falsely invalidated completed legacy narration

Legacy TTS artifacts bind the exact narration-plan file hash. The newer quality contract also embeds a separate canonical plan hash. Status compared legacy artifacts against the new canonical hash and incorrectly sent an uploaded run back to TTS.

Implemented: status selects the correct binding by narration contract. The completed run now correctly reports only `youtube_pinned_comment` as missing.

### P1 - Package authors could self-eliminate the best premise

Only candidates the author labeled strong-click and strong-runway reached independent judges. That leaked author confidence into selection and hid plausible-but-mislabeled winners.

Implemented: both independent judges now compare all six finalists. Author grades remain visible evidence but have no admission authority.

The tournament prompt no longer tells judges that every finalist already passed a strong author screen. A selected candidate must now carry strong top-level click and runway judgments plus a passing candidate-specific runway finding.

### P1 - Outlier evidence was prose-only and source-order dependent

The old ledger stored performance in free text, then selected the first twelve public and first twelve own-channel rows. It could not reliably rank freshness, VPD, breakout multiple, or package diversity.

Implemented: optional V2 outlier ledgers carry exact structured measurements and thumbnail evidence. Projection ranks verified breakout/VPD/views evidence and caps package-grammar concentration before backfill. V1 remains readable.

### P1 - Developmental revision receipts did not prove their excerpts

The revision ledger required every diagnostic ID but previously accepted invented `source_anchor` or `revised_anchor` strings and extra unrequested repair IDs.

Implemented: every developmental repair ID must now be unique, expected, and backed by an exact excerpt present in both the source and revised scripts.

### P1 - Generated motion starts too late

Flow video took only 22.7 active minutes once started, but began 199 minutes after animation planning. The wavefront currently prebuilds still-motion caches, not official generated video.

Pending redesign: create a cumulative, hash-stable partial animation-direction ledger so an accepted first frame can enter Flow immediately without later full-plan finalization invalidating its clip lineage.

### P1 - Viewer simulation is correlated and overconfident

Ten personas currently use the same model family and require unanimous victory on every checkpoint and dimension. Persona labels do not create ten independent estimators, while unanimity can drive expensive repair loops.

Pending operator decision: benchmark a mixed GPT/Gemini panel against real 30-second, one-minute, AVD, and APV outcomes. Use a robust majority plus catastrophic-veto rule for acceptance; retain 10-0 as an exceptional-confidence label rather than an uncalibrated production requirement.

### P1 - One fixed wall-clock target cannot represent all Goldflow lanes

Asset Afterlife, ten-minute explainers, one-hour manhwa, and two-hour manhwa have radically different cut and motion counts. A fixed 180-minute target makes telemetry noisy and can encourage unsafe shortcuts.

Pending redesign: define target wall clock as a function of episode duration, required stills, generated-motion moments, current provider health, and measured p50/p90 latency. Keep a separate stretch target.

## Quality Strategy

1. Treat title-thumbnail demand evidence as structured input before story ideation.
2. Keep package, Story Truth, full-draft selection, developmental revision, narration polish, and exact story mapping as distinct responsibilities.
3. Calibrate simulated viewers against real retention rather than trusting synthetic consensus by itself.
4. Route premium models to global decisions and difficult exceptions; use Codex and Antigravity for bounded structured volume.
5. Preserve first-pass diversity, then select whole drafts before revising. Do not blend six drafts into committee prose.
6. Map 24-hour, 72-hour, and 7-day analytics back to exact title promises, opening deadlines, narration passages, visual density, and Story Truth functions.

## Speed Strategy

1. Keep the director active until a true approval or blocker.
2. Re-enter the director immediately after every scoped repair.
3. Keep Flow and Gemini topped off while prompt waves arrive.
4. Reserve ChatGPT Web for premium text and explicit image exceptions.
5. Start hash-safe Flow clips as soon as their accepted first frames exist.
6. Measure queue wait and service time separately for every web-planner job.
7. Use performance audits after every macro phase and compare p50/p90 by task class.

## Evidence

- Performance JSON: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W33-maintenance-founder-acquisition-v1/episodes/ep_01/reports/performance/performance_audit_ep_01.json`
- Performance Markdown: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W33-maintenance-founder-acquisition-v1/episodes/ep_01/reports/performance/performance_audit_ep_01.md`
