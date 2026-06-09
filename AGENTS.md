# AniFactory Goldflow

This repo is the clean longform production lane. It intentionally excludes legacy render paths, old visual heuristics, source-seed annotations, regex SFX production fallback, and multi-route compatibility behavior from the original AniFactory repo.

## Non-Negotiable Flow

Production moves through one artifact chain:

1. Raw narration script in `script_clean.md`.
2. Optional LLM enhancement before approval only.
3. Manual review and operator approval for the exact script hash.
4. Semantic scene annotation from the locked script and bibles.
5. Narrator-only voice plan by default.
6. ModelsLab Qwen TTS and stitch.
7. Local Whisper word timing on the final stitched narration.
8. Timing-bound SFX and score planning from Whisper timing.
9. Longform audio bed mix.
10. Reference generation, visual planning, image generation, and render.

Current migrated scope is source ingest, script approval, semantic scene planning, the audio spine, Whisper timing, timing binding, SFX/score enrichment, longform audio mix, and current-scene-only visual prompt planning.

## Hard Rules

- Do not use source-seed scene annotations. Final semantic truth comes from the locked script.
- Do not creatively rewrite approved scripts with deterministic code.
- Do not run SFX or score planning before final narration exists.
- Do not run SFX or score planning without current local Whisper timing.
- Segment or Qwen timing is fallback metadata only; production SFX/score plans must be stamped with `timing_source: "local_whisper_word_timing"`.
- Narrator-only is the default voice route. Character voice casting requires an explicit operator request and flag.
- Ambiguous dialogue routes to narrator.
- Render must consume one continuous final mixed audio track.

## Commands

```bash
node bin/goldflow.mjs ingest source --channel <channel> --series <series> --week <week> --episode ep_01 --source <chatbot-output.md>
node bin/goldflow.mjs script approve --channel <channel> --series <series> --week <week> --episode ep_01 --hash <script_clean_sha256>
node bin/goldflow.mjs semantic plan --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs voice plan --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs tts qwen --channel <channel> --series <series> --week <week> --episode ep_01 --suffix -modelslab-qwen
node bin/goldflow.mjs audio whisper-timing --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs timing bind --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs audio enrich-sfx-score --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs audio longform-bed --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs visual plan --channel <channel> --series <series> --week <week> --episode ep_01
```

## LLM Routing

Set `ANIFACTORY_LLM_ROUTE` before any pipeline command:

```bash
ANIFACTORY_LLM_ROUTE=codex
ANIFACTORY_LLM_ROUTE=local-qwen
ANIFACTORY_LLM_ROUTE=auto
```

Optional local Qwen overrides:

```bash
ANIFACTORY_LOCAL_LLM_URL=http://localhost:8000/v1
ANIFACTORY_LOCAL_LLM_MODEL=Qwen3-30B-A3B-MLX-4bit
```

## Worktree Discipline

Keep this repo small and revertable. Commit each migrated stage after syntax checks. Do not copy broad directories from the original repo.
