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

Exact payload example (two requests become one; quotation marks and punctuation are preserved):

```text
Before, request 1: “Early. Good habit.”
Before, request 2: Then he saw my sleeve. I told him what happened. Not the part about the ability. Just the stone. His expression changed before I finished.

After, request 1: “Early. Good habit.” Then he saw my sleeve. I told him what happened. Not the part about the ability. Just the stone. His expression changed before I finished.
```

## Actual bounded audio comparison

The documented standalone diagnostic ran once from clean commit `36f328c`, outside all episode folders. It synthesized three other representative excerpts, with **110 identical submitted words per arm**, one resident pinned model, the same owned dry/deadpan reference, unchanged sampling controls and the production batch-four scheduler. Regrouping changes batch membership and cohort-derived seeds; this comparison does not isolate those effects or reproduce historical takes.

| Excerpt | Original requests | Grouped requests | Original raw duration | Grouped raw duration |
| --- | ---: | ---: | ---: | ---: |
| New Game Plus — family judgment | 5 | 1 | 10.64 s | 9.92 s |
| $53 — deli checkout | 4 | 1 | 12.64 s | 11.84 s |
| Death Awakening — hand contact | 4 | 1 | 12.24 s | 11.84 s |
| Total | 13 | 3 | 35.52 s | 33.60 s |

All 16 outputs passed exact raw-output accounting; none reached the token limit. Execution took 46.685 seconds and incurred zero provider billing (local hardware/electricity costs were not estimated). Every attempt, raw WAV, payload, cohort, source binding and output hash is retained in `/Users/joel/AniFactoryData/channels/53rebirth/source_development/audio_diagnostic_2026_10_17/qwen-submission-ab-v1/`.

- Manifest SHA-256: `5ede84f60cde27fc9e612b371ea05c080294abfb957dfde152474016c81b7c0f`.
- Raw generation report SHA-256: `36dbfad6b4b83b8095d505abc273a16b14de27021dba892b7b6b5bd9e6c4bba8`.
- Listening page: [local comparison](http://127.0.0.1:8772/compare.html), saved as `listening-preview/compare.html` within that directory. All six browser audio elements loaded with the expected durations and no media errors.
- `listening_preview_manifest.json` binds each preview to the raw WAVs. Original requests are concatenated in source order with no PCM samples removed, changed or inserted. These are raw submission comparisons, not finished semantic-pause/mastering comparisons.

**No actual listening was performed, and no naturalness or stutter-resolution verdict is claimed.** Duration is measured, not a quality score. The diagnostic does not approve or replace production narration. Inside-request stutters, clone/reference effects and sustained-runtime effects remain unresolved; changing those variables requires a separate controlled comparison after listening to this one.

## Verification and deployment

Passing checks include the new grouping, contextual audit, stitch implementation and pre-synthesis suites; the existing voice-boundary/profile and complete narration-quality suites; batch-four/voice-selection/syntax tests; production-direction contracts; and repository syntax/generated-guidance checks. Tests reject missing/duplicated/reordered components, ambiguous contraction expansion without a receipt, altered payloads, crossed actual barriers, invalid short-line/boundary rationales and instruction leaks. A real synthetic WAV passes through the actual stitch helper with all PCM samples preserved when activity contradicts alignment.

Implementation lives on `codex/qwen-submission-cleanup`, based on the production checkout's `d2a3e8d`, in `/Users/joel/.codex/worktrees/qwen-submission-cleanup/anifactory-goldflow`. Root's unrelated dirty edits remain untouched. After verifying the production checkout was clean at the expected base and had no active production process, the actual production checkout was fast-forwarded to implementation commit `36f328c`:

```sh
cd /Users/joel/.codex/worktrees/three-script-slate-production/anifactory-goldflow
git merge --ff-only codex/qwen-submission-cleanup
npm run test:narration-submission
```

The complete focused submission suite passed again in that production checkout, including all eight no-model diagnostic test groups. The broader narration-quality, voice-boundary, production-direction, batch/selection, syntax and repository checks had already passed on the identical implementation; `npm run check` covered 652 modules. The dependency lockfile is unchanged. This report-only follow-up is also fast-forwarded into production; it does not change the diagnostic's locked code identity.

No code integration remains for this Qwen change. For the next script, use the normal guarded preflight and fresh local-Qwen voice-authoring route in the production checkout. Verify the new plan records `coherent_thought_groups_v1`, review its exact spoken payloads and complete the required listening gate before accepting narration. Existing episode plans, identities and accepted media were not regenerated or replaced. Do not rerun historical voice planning merely to adopt this policy. Panel-composition work remains on its separate branch and is not included in this TTS integration.
