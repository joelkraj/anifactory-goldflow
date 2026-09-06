# anifactory-goldflow

The clean Goldflow longform production lane. See [production workflow](docs/workflows/video_production_workflow.md).

## Private footage clipping

Opt-in TorBox/Real-Debrid and local-file support, local subtitle timestamp search, and bounded silent 3–5 second clips are available through `node bin/goldflow.mjs footage --help`. This is a separate source-library tool, not an automatic recap renderer or an episode production stage.

Run `node bin/goldflow.mjs footage init`, put provider keys in the gitignored `.env.footage.local`, then run `node bin/goldflow.mjs footage config`. See [setup, commands, safety limits, and validation](docs/workflows/footage_clipping_workflow.md).
