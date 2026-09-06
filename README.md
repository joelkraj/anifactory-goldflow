# anifactory-goldflow

Goldflow's shared longform production infrastructure, with separate editorial guidance and explicit media workflows. Start with [the required-reading router](AGENTS.md).

| Editorial lane | Media workflow | Guidance |
| --- | --- | --- |
| Manhwa recap (`manhwa_recap_v1`) | `generated_visuals_v1` — operational | [Manhwa](docs/pipelines/manhwa.md) |
| Factual Asset Afterlife/lost-luggage documentary (`asset_afterlife_v1`) | `generated_visuals_v1` — generated production available; new-run packaging blocked pending adapter | [Documentary](docs/pipelines/documentary.md) |
| Movie/TV commentary (`movie_tv_commentary_v1`, reserved) | `source_footage_v1` — production blocked | [Movie/TV design](docs/pipelines/movie_tv.md) |

New `run preflight` commands require explicit `--content-profile` and `--media-workflow`; neither is inferred. Existing identities retain their recorded behavior, and missing historical workflow fields mean the legacy generated route. The [generated-visuals contract](docs/pipelines/generated_visuals.md) and [detailed production workflow](docs/workflows/video_production_workflow.md) preserve the shared narration, provider, approval, recovery, and render rules. `source manufacture` remains manhwa-only.

## Private footage clipping

Opt-in TorBox/Real-Debrid and local-file support, local subtitle timestamp search, and bounded 3–5 second clips (silent by default, with optional source audio) are available through `node bin/goldflow.mjs footage --help`. This is a separate source-library tool, not an automatic recap renderer or an episode production stage.

Run `node bin/goldflow.mjs footage init`, put provider keys in the gitignored `.env.footage.local`, then run `node bin/goldflow.mjs footage config`. See [setup, commands, safety limits, and validation](docs/workflows/footage_clipping_workflow.md).
