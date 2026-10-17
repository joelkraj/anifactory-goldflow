# Coherent narration submission

New local-Qwen voice plans use `submission_policy: coherent_thought_groups_v1` and a hash-bound submission contract. The narration performance author groups whole, ordered source components into connected thoughts. Preferred length is 20–42 spoken words, 48 is a soft ceiling, and 60 is a hard ceiling. There is no minimum: an intentional short line stays short with an authored reason. This applies to fresh Qwen authoring; accepted historical plans/audio and other providers retain their contracts.

Joel's [October 17 listening decision](../audits/2026-10-17-qwen-length-selection.md) selects approximately 40-word requests for the next Manhwa Joey video. Retain this existing policy: aim near 40 when a connected thought supports it, preserve intentional short lines, and end at natural thought boundaries rather than enforcing exactly 40 words. The larger-request experiment is closed without adopting 100-, 200-, or 500-word groups; the 1,000-word arm was not run. The model, reference, batch scheduling and token limits remain unchanged.

The selected delivery still has reported jumpy flow. Subsequent investigation should locate pause/cadence discontinuities within requests and across joins while keeping this request-size direction. The size decision does not establish that joins cause every discontinuity, approve an episode's narration, or authorize trimming voiced edges to hide it.

Planning segments, visual changes, source character labels in a single-narrator performance, and approved pronunciation overrides do not themselves require another synthesis request. Explicit source barriers, system announcements, chapter/delivery transitions, and actual synthesis voice/reference changes remain barriers. A real story transition also requires the author to end the thought. Each group records its grouping rationale, any short/long exception, and the intended semantic boundary with a rationale. A request ending is not automatically a paragraph break or revelation. No deterministic merger chooses dramatic meaning or changes approved prose.

The author preserves each component exactly once in order. Existing per-component source/caption/spoken text, transformation receipts and hashes survive grouping. Only a separate punctuation-only receipt may change the joined spoken text. The compiled provider request must equal that final spoken text exactly. Dropped, duplicated, reordered, altered, oversized or barrier-crossing components block before synthesis. Existing unit/model/reference locks, cohort accounting, one-attempt policy, and provider-output verification still apply.

Qwen Base has no effective natural-language instruction channel. Performance intent is metadata. Its supported delivery inputs are the exact spoken text, punctuation, grouping and pinned reference; stitch boundaries are applied after synthesis. Do not submit emotion labels, speaker labels, `[pause]`, SSML or instructions as narration. The adapter records unsupported controls explicitly.

## Spoken-form review

The new audit keeps an exact source-offset/context/hash inventory for currency, decimals, percentages, letter ranks, initialisms, ambiguous contractions, protected names/terms, quotes, ellipses, dashes, line breaks, repeated words and short components. It does not rewrite these automatically. For example, `I'd paid` may mean `I had paid` while `I'd pay` may mean `I would pay`; either contraction may also remain as approved. An exact TTS-only override must have the surrounding phrase and existing hash-bound provenance. Do not expand every contraction, invent phonetic spellings for names, flatten punctuation, or delete intentional repetition. Formatting line breaks alone do not warrant pauses.

The existing spoken compiler remains version-stable so historical receipts can be replayed. Digits, unresolved currency/percent symbols and instruction markup in new final payloads block. Context-sensitive forms must be resolved through the existing TTS-only override path. Captions and approved source remain unchanged. The old audit's below-45-word warning is retained only for historical hash compatibility; the new audit reports the actual 20–42 preference and 48-word soft maximum.

## Compatibility and audio edges

An existing narration editorial marker, aggregate artifact or interrupted packet history retains its original prompt/schema/cache contract. New authoring does not silently reinterpret or resubmit historical packets. Accepted narration is immutable. Installing this code does not repair previously rendered videos.

The alignment editor now preserves the entire raw unit if waveform activity extends more than 20 ms beyond a proposed aligned trim. Activity can veto a cut, but cannot select a replacement trim point. This also disables fades on the preserved unit. Exact editor and stitch-helper hashes participate in the semantic-stitch checkpoint key; raw generation and ASR caches remain reusable. A reviewed continuation cannot silently rebuild media beneath its approved evidence. Historical repairs require their existing exact-scope workflow and new downstream timing/render provenance.

## Validation

Run the submission contract, contextual audit, pre-synthesis gate, edge/cache, voice-boundary and narration-quality suites. Use actual production plans read-only for coverage, payload, lineage, distribution and boundary regression. Distinguish full-plan baseline metrics from a small agent-authored regrouping sample. Fewer requests prove changed submission structure; they do not prove improved audible delivery. ASR and waveform checks are not a listening verdict.

Never run a new production episode merely to test this code. A bounded synthesis diagnostic must first lock exact source excerpts, both payload sets, the actual model revision and owned dry Joel reference, batch settings, immutable attempts and fresh output paths outside episode folders. Do not use the Liam throughput comparison for a Joel submission experiment, switch providers, overwrite accepted media or automatically retry a creative take.

## Bounded raw comparison

The standalone `scripts/tts-submission-diagnostic.mjs` wrapper accepts an authored `goldflow_qwen_submission_diagnostic_recipe_v1` with one to three contiguous excerpts. Each sample binds the exact generation-plan and selected narration-report file hashes, explicit source unit IDs, and authored grouped requests with full component lineage. It permits at most 180 spoken words per arm, 60 words per request and 120 seconds of successful raw output per arm. The current three-story recipe contains 110 words per arm: 13 original requests and three grouped requests.

Prepare only after the code is reviewed, committed and clean. The output parent must already exist; the final directory must be new and outside episode folders and the checkout. Preparation validates the exact canonical source script, operator approval, script lock, run identity, speakability report, spoken overrides, selected payloads, local runtime, cached model files and actual dry Joel reference. It does not load the model.

```sh
node scripts/tts-submission-diagnostic.mjs --action prepare \
  --recipe /Users/joel/anifactory-goldflow/scratch/qwen-text-submission-audit-2026-10-17/bounded-synthesis-recipe.json \
  --output-dir /Users/joel/AniFactoryData/channels/53rebirth/source_development/audio_diagnostic_2026_10_17/qwen-submission-ab-v1

node scripts/tts-submission-diagnostic.mjs --action run \
  --manifest /Users/joel/AniFactoryData/channels/53rebirth/source_development/audio_diagnostic_2026_10_17/qwen-submission-ab-v1/manifest.json
```

Execution revalidates every binding and reserves an exclusive attempt marker before the first model load. Both arms use one resident pinned Qwen model, the same owned dry Joel reference, unchanged sampling parameters, and the existing batch-four scheduler. The scheduler records every cohort, length/byte ordering and cohort-derived seed. Regrouping necessarily changes cohorts and seeds. Historical serial-resume selections are recorded as such; this is a fresh original-versus-grouped payload comparison, not a recreation of historical audio.

The Python runner is an internal backend for this wrapper. It retains raw native 24 kHz WAVs and per-request receipts after each cohort, restores source order in its report and never trims, inserts pauses, masters, updates episode artifacts or submits a replacement take. Invalid samples, token limits or an over-duration arm stop further submissions and preserve received evidence. Any existing attempt, partial output or failed run blocks rerunning that output directory. There is no automatic retry, provider fallback or promotion path. Completion reports local elapsed time and zero provider billing, and always records `listening_performed: false`; listening conclusions require a separate actual review.

Run `node scripts/tests/tts-submission-diagnostic-tests.mjs` for no-model regressions covering payload/lineage drift, changed locks, incomplete provenance, stale source approvals, request bounds, refusal to overwrite, and raw output accounting. Successful generation is not a naturalness or production-acceptance result.
