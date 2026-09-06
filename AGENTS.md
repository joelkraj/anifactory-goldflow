# AniFactory Goldflow

Goldflow shares production infrastructure across distinct editorial lanes. Do not infer a content family from a channel name, an example episode, or the availability of a renderer. Do not copy legacy render paths, source-seed annotations, or story-specific heuristics into the shared pipeline.

## Required Reading Router

Read this file first. Before operating on an episode, read the complete guide for its locked **content profile** and **media workflow**, plus any workflow document that guide requires. For code-only maintenance, read the guides relevant to the changed behavior; do not invent an episode or run production commands merely to obtain a status.

| Task or identity | Required guidance | Status |
| --- | --- | --- |
| `manhwa_recap_v1` + `generated_visuals_v1` | [Manhwa](docs/pipelines/manhwa.md), then [generated visuals](docs/pipelines/generated_visuals.md) | Operational; existing manhwa behavior preserved |
| `asset_afterlife_v1` + `generated_visuals_v1` | [Factual documentary](docs/pipelines/documentary.md), [Asset Afterlife profile](docs/workflows/asset_afterlife_profile.md), then [generated visuals](docs/pipelines/generated_visuals.md) | Generated production available; new-run packaging blocked pending a documentary adapter; hybrid proofs remain separate |
| Reserved `movie_tv_commentary_v1` + `source_footage_v1` | [Movie/TV editorial design](docs/pipelines/movie_tv.md) | Design-only; episode preflight/production blocked pending implementation |
| Standalone `footage` commands | [Private footage clipping](docs/workflows/footage_clipping_workflow.md) | Library-only; no episode-stage completion or publishing authority |
| Existing identity without `media_workflow` | Its recorded content profile and [generated visuals](docs/pipelines/generated_visuals.md) | Legacy generated route; no implicit migration |

Source development with `source manufacture` is **manhwa-only** and additionally requires [the source-script workflow](docs/workflows/source_script_generation_workflow.md). Never send factual-documentary or movie/TV work through the fiction manufacturer. Custom content-profile JSONs need an explicit, applicable editorial contract; they do not silently inherit manhwa rules.

## Explicit New-Run Selection

New `goldflow run preflight` calls require both `--content-profile` and `--media-workflow`; a command missing either flag is an error. Populate those explicit flags from the operator's clearly stated content and format intent. Ask for the missing choice only when intent is ambiguous; do not infer it from a title, channel, old example, or previous task. For an existing run, inspect its immutable identity instead of retrofitting new flags.

- Content profile defines editorial intent, source/evidence requirements, style, and packaging. Existing built-ins remain `manhwa_recap_v1` and `asset_afterlife_v1`; `movie_tv_commentary_v1` is a reserved editorial ID, not an operational planner profile.
- Media workflow defines the artifact chain and supported media. `generated_visuals_v1` is operational; `source_footage_v1` is reserved and production-blocked.
- New identities bind `media_workflow` and `workflow_contract: { schema: "goldflow_media_workflow_v1", id, version, stage_registry_version, sha256 }`. The resolved contract is identity-locked. Missing workflow fields on a historical identity retain the legacy generated route; never rewrite that identity or reinterpret it as source-footage production.
- Unsupported content/workflow combinations stop before episode creation, provider spend, or media work. Footage library approval cannot satisfy generated-image gates or authorize an unsupported production workflow.

## Shared Non-Negotiables

- Run identity and scope are production gates. Lock channel, stable series/run slugs, exact episode id, title, source, profile/workflow, providers, audio target, and proof-vs-production intent before ingest, generation, rendering, or episode-folder creation. Episode numbers belong in `--episode`, not the run/week slug.
- Production preflight requires a clean worktree. A dirty worktree is allowed only for an explicit diagnostic/proof with both `--allow-dirty-worktree true` and a meaningful `--dirty-reason`.
- Before continuing an episode, run `node bin/goldflow.mjs run status --episode-dir <episode-dir> --format markdown`. State the current unresolved stage and next artifact. After every completed stage, reread status and execute only its next valid command shape.
- Episode commands require an explicit target: use `--episode-dir` where supported, or complete `--channel`, `--week`, and `--episode` flags. Older tuple-only commands reject `--episode-dir`; follow the status command shape rather than relying on implicit default paths. Routing and unsupported-profile gates are not bypassable stage-order checks.
- Never route around the workflow guard by calling underlying production scripts directly. `--workflow-bypass true` requires explicit operator-approved diagnostic/recovery scope and an explanation of why it is safe.
- A blocker is a triage point, not a rerun order. Inspect evidence, preserve passed artifacts, record the narrowest structured repair, exact-ID recovery, supported waiver, or operator hold, then rerun status. Do not skip approvals, required media, current hashes, or spend/scope gates.
- Proof means proof: honor exact windows/IDs, keep proof-specific outputs separate, and stop for approval before scaling. A proof result becomes durable production behavior only through reviewed code, documentation, tests, and the guarded artifact path.
- Approved scripts and accepted media are immutable. Keep source/caption text, approved TTS-only spoken text, and visual facts separate. No deterministic creative rewriting, automatic provider failover, creative retry loops, or whole-stage reruns to repair isolated failures.
- Every stage and exact-scope repair retains append-only execution events, immutable reports, source hashes, identity, scope, cost, and timing. Cached artifacts require exact current provenance; current-batch success is not complete-episode success.
- Script approval verifies the exact production text, not external factual truth. Documentary claims require the separate factual evidence/reviewer contract; schema or hash success alone never proves a claim.
- Never store keys, cookies, bearer tokens, signed media URLs, or browser session state in tracked files or production receipts. Use the documented private credential path. Do not print secrets.
- Packaging follows the selected content profile, not a global manhwa title/style recipe. New workflow-locked non-manhwa runs stop at an explicit unsupported-packaging gate until their adapter exists; never fabricate betrayal/revenge metadata to pass it. Historical identities keep their existing validation behavior. Final QA, exact package approval, private-first upload, explicit public/scheduled release approval, and separately approved pinned-comment actions remain required.
- Keep changes small, tested, and revertable. Preserve unrelated user edits and existing run identities. Do not copy broad directories from the original repository.

Detailed provider, narration, timing, image, motion, render, and scoped-recovery contracts live in the required generated-visuals guide; they have been relocated, not removed.
