# Harden Mutation Audit Phase 1

Measured on four real reviewed prompt plans in scratch:

- `2026-W25-reincarnated-simp-world-part-2-v1/episodes/ep_02`
- `2026-W25-law-school-regression-ledger-v1/episodes/ep_01`
- `2026-W25-joey-mercer-ascension-v1/episodes/ep_01`
- `2026-W25-anti-simp-system-codex-imagen-v1/episodes/ep_01`

Modes:

- `sanitize`
- `repair`

Scratch outputs:

- `scratch/harden-mutation-audit-run2/summary.json`
- `scratch/harden-mutation-audit-run2/summary.md`

Classification summary:

| Function | Class | Changed | Matched | Calls |
| --- | --- | ---: | ---: | ---: |
| `ensurePromptClauses` | `live` | 3169 | 3169 | 3720 |
| `applyNamedCharacterMultiplicityContract` | `live` | 1860 | 1860 | 1860 |
| `applyShotContract` | `live` | 1860 | 1860 | 1860 |
| `enforceSingleMomentComposition` | `live` | 1860 | 1860 | 1860 |
| `primaryVisualFocusInjection` | `live` | 1455 | 1455 | 1455 |
| `applyLocationContract` | `live` | 1134 | 1134 | 1860 |
| `joeyProgressionClause` | `live` | 1095 | 1095 | 1860 |
| `resolveCharacterStateConflicts` | `live` | 681 | 681 | 1860 |
| `stripEmbeddedNegativePromptPayloadSyntax` | `live` | 405 | 405 | 1860 |
| `sanitizeModelSafeBeautyLanguage` | `live` | 293 | 293 | 1860 |
| `removeConflictingSingleLocationClauses` | `live` | 65 | 65 | 1860 |
| `stripDialogueCueLanguage` | `live` | 15 | 15 | 3720 |
| `sanitizeUnattachedCharacterMentions` | `live` | 1 | 1 | 1860 |
| `removeConflictingVisibleLocationClauses` | `dead` | 0 | 0 | 1860 |

Read:

- The `repair` path is still a large prose authoring system and is heavily live on real prompts.
- The production `sanitize` path was not prose-stable in this historical audit: it mutated authored text through old prompt-payload/negation handling, beauty-language rewriting, multiplicity-clause injection, and other clause appenders. The current policy is narrower: normal prompt prose stays creative-author-owned; only standalone or embedded provider-exclusion payload syntax is sanitation scope.
- `removeConflictingVisibleLocationClauses` was dead on this sample and is the only measured dead prose mutator.

Representative examples are stored in `scratch/harden-mutation-audit-run2/summary.md`.
