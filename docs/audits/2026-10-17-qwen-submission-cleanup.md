# Qwen submission cleanup — 17 October 2026

The evidence supports fixing two different layers first: fragmented text submission and unsafe aligned edge trimming. It does not establish that replacing hardware, changing the clone, restarting the resident model or increasing model size will resolve the reported stutters.

## Findings

The actual selected production outputs use `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit`, revision `e7dd0585652209fa0d7783659aad4e8a324de11c`, MLX Audio 0.4.6, and the owned **dry/deadpan Joel reference**. Some planning metadata mentions a different reference; selected runner/output provenance is authoritative. This change does not alter the model, clone, sampling controls or batch-four production lock.

| Actual plan | Requests | Under 10 words | Under 20 words | Median words | Preserved edge conflicts in replay |
| --- | ---: | ---: | ---: | ---: | ---: |
| New Game Plus | 970 | 226 | 491 | 19 | 111 |
| $53 Purchase Return | 909 | 308 | 590 | 14 | 163 |
| Death Awakening | 941 | 317 | 605 | 14 | 117 |

Word counts here use whitespace-separated spoken words, matching the production diagnostic. A short unit is not automatically a defect. Full-episode editorial review has not classified every short request as avoidable.

1. **Fragmentation is built into the old planner.** The author prompt and both validators prohibit crossing a `voice_seg`. Those segments can arise from paragraph/dialogue and voice-contrast planning decisions. Dialogue/non-narration flags and any pronunciation override are also automatic merge barriers, even when the actual voice remains the same narrator. The nominal 20–42-word preference cannot override these rules. In the three measured plans there are no explicit source merge barriers, but 1,486 derived merge barriers.
2. **Pauses accumulate at those boundaries.** The three edited streams contain 2,817 joins and 543.115 seconds of inserted silence. The maximum effective planned join is 600 ms, with no planned joins above 700 ms. These figures do not demonstrate multi-second stitch gaps or prove that every pause is excessive. Short isolated requests also invite a fresh model cadence, which requires listening to assess.
3. **Edge editing demonstrably discards waveform activity.** The existing diagnostic identified 391 tails where activity extends more than 20 ms beyond the aligned trim. The implemented editor replay preserves all 391, using the retained alignment/metrics for all 2,820 units. These are conflict candidates, not 391 listener-confirmed missing words. The $53 “fifty-three dollars” example discards about 350 ms of activity; its phonetic impact still requires listening. Activity now vetoes a trim; it never supplies a new amplitude-based cut.
4. **Text integrity is otherwise strong.** All three source-to-spoken IRs pass, and every compiled payload matches its recorded spoken text. The source plans already spell every number out and use empty targeted replacement/pronunciation maps. Their actual recorded transformations are 1,273 outer-quote removals, 309 authored punctuation receipts and one ordinary all-caps normalization. Currency/decimal/initialism compiler cases are tested separately as fixtures, not misrepresented as fixes measured on these episodes.
5. **Some stutters remain unexplained.** The reported prison timestamp falls inside a 43-word request, not a join. ASR reports no word errors there but cannot rule out an audible stutter. Existing evidence does not isolate Qwen generation, reference conditioning, batch behavior or sustained runtime as its cause. Current hardware is an M5 Pro with 64 GiB; there is no historical utilization trace supporting a hardware diagnosis. New Game Plus recorded 970 successful first submissions and no selected token-limit output.

## Implemented change

[The new submission contract](../workflows/qwen_submission_v1.md) applies to fresh local-Qwen voice authoring. The LLM/agent owns grouping, punctuation, dramatic exceptions and boundary intent. Deterministic code validates coverage, order, limits, actual source/voice barriers, closed component lineage and exact provider payloads. It does not invent connective text or merge thoughts creatively. New final payloads also receive a context/hash-bound risk inventory and reject instruction markup and unresolved currency/percent symbols. There is no blanket contraction expansion, punctuation flattening, name rewriting or repetition removal.

Existing episode plans, captions, scripts, identities and media remain unchanged. The old compiler and historical prompt/cache behavior remain replayable. New and historical schema handling is explicit. The alignment safeguard is the narrow existing uncommitted root fix, preserved in root and ported into the clean production-based checkout. Semantic-stitch cache keys now bind the plan plus editor/helper hashes, preventing stale gaps or trims from being reused while preserving raw synthesis and ASR caches.

## Read-only regression evidence

Evidence directory: `/Users/joel/anifactory-goldflow/scratch/qwen-text-submission-audit-2026-10-17/`.

- `measurements.json`: full three-plan distributions, boundaries, transformations and payload checks.
- `full-legacy-regression-replay.json`: recompiling the original segments and old authored artifacts reproduces all 2,820 IDs, source/caption/spoken strings, exact payloads and component IDs; every rebuilt IR passes and all three historical episodes retain legacy policy selection.
- `authored-samples.json` and `real-grouping-validator-replay.json`: six explicitly reviewed contiguous excerpts, passed through the actual new group application, plan validator, IR validator and provider compiler. All 42 original source-component objects remain byte-identical.
- `implemented-edge-replay.json`: current editor applied read-only to every retained alignment/metric pair, with source report hashes; 111/163/117 conflicts preserved.

The six excerpts contain **203 unchanged words: 21 requests become seven**. Under-20 requests decrease from 17 to one, and the median request grows from six to 33 words. Six groups contain 20–42 words; the deliberate one-word “Death.” reveal remains separate. Fourteen internal request boundaries are removed. The old selected excerpts contain 1.920 seconds of inserted internal silence; new audible pauses and delivery quality cannot be inferred from this text-only arithmetic.

One example joins the three-word greeting “Early. Good habit.” to its immediate sleeve observation and explanation, producing one 28-word thought across a planning-segment boundary. Another retains the isolated ability-name revelation and groups the explanatory follow-through. No lexical material is added or removed. For isolated validator replay, the excerpt endpoint receives a diagnostic-only `episode_end`; historical episode boundary metadata is not changed.

## Verification and deployment

Passing checks include the new grouping, contextual audit, stitch implementation and pre-synthesis suites; the existing voice-boundary/profile and complete narration-quality suites; batch-four/voice-selection/syntax tests; production-direction contracts; and repository syntax/generated-guidance checks. Tests reject missing/duplicated/reordered components, ambiguous contraction expansion without a receipt, altered payloads, crossed actual barriers, invalid short-line/boundary rationales and instruction leaks. A real synthetic WAV passes through the actual stitch helper with all PCM samples preserved when activity contradicts alignment.

Implementation lives on `codex/qwen-submission-cleanup`, based on the production checkout's `d2a3e8d`, in `/Users/joel/.codex/worktrees/qwen-submission-cleanup/anifactory-goldflow`. Root's unrelated dirty edits and the production checkout are untouched. Before starting the next production run, integrate this branch into the intended clean checkout, run `npm ci --ignore-scripts`, `npm run test:narration-submission`, `npm run test:narration-quality`, `npm run test:voice-boundary` and `npm run check`, then use the normal guarded preflight/voice-plan route. A new Qwen plan must contain `coherent_thought_groups_v1`. Do not rerun historical voice planning or replace historical audio to adopt it. Exact integration commands and bounded audio results are recorded with the final handoff.
