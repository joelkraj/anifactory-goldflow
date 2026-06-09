# AniFactory Goldflow

This repo is the clean longform production lane. It intentionally excludes legacy render paths, old visual heuristics, source-seed annotations, regex SFX production fallback, and multi-route compatibility behavior from the original AniFactory repo.

## Non-Negotiable Flow

Production moves through one artifact chain:

1. Ingest a polished narration story into `script_clean.md`.
2. Optional script polish/enhancement only when the operator explicitly asks for it, before approval, with the resulting script treated as a new candidate for review.
3. Production-readiness and speakability QA from the candidate script. These passes may suggest fixes, pronunciation mappings, and risk notes, but must not silently rewrite the story.
4. Manual review and operator approval for the exact final script hash.
5. Semantic scene annotation from the locked script and bibles.
6. Narrator-only voice plan by default.
7. ModelsLab Qwen TTS and stitch.
8. Local Whisper word timing on the final stitched narration.
9. Review TTS and timing artifacts before downstream production.
10. Timing-bound SFX and score planning from Whisper timing.
11. Longform audio bed mix.
12. Reference generation, visual planning, image generation, and render.

Current migrated scope is source ingest, script approval, semantic scene planning, the audio spine, Whisper timing, timing binding, SFX/score enrichment, longform audio mix, current-scene-only visual prompt planning, strict ModelsLab image generation, and a durable continuous-audio render.

## Hard Rules

- Do not use source-seed scene annotations. Final semantic truth comes from the locked script.
- Do not creatively rewrite approved scripts with deterministic code.
- Treat the chatbot/operator-approved story as production truth. Qwen may analyze, extract, and flag issues, but it must not be trusted to improve story prose by default.
- Generic script enhancement is optional and pre-lock only. If enhancement changes the script, every downstream artifact must be regenerated from the new exact hash.
- Keep caption text, spoken TTS text, and semantic visual facts as separate layers. Captions preserve the approved script; TTS may use approved speakable equivalents; visuals use extracted scene facts.
- Protected terms need explicit speakability handling before TTS, especially ranks, UI labels, odds, decimals, currencies, acronyms, and system messages.
- Do not run SFX or score planning before final narration exists.
- Do not run SFX or score planning without current local Whisper timing.
- Segment or Qwen timing is fallback metadata only; production SFX/score plans must be stamped with `timing_source: "local_whisper_word_timing"`.
- Narrator-only is the default voice route. Character voice casting requires an explicit operator request and flag.
- Ambiguous dialogue routes to narrator.
- Render must consume one continuous final mixed audio track.
- Visual planning must use current-scene facts only. Do not import neighboring context, stale refs, negative prompt wording, or characters not visible in the scene.
- Required references must exist before image generation. Style ref comes first, then character/location/action anchors as needed; do not bypass missing reference requirements for production.
- Character state references are definitive for visual identity, wardrobe, and character state. Do not let visual planners infer wardrobe from ambiguous prose such as "gray suit"; use curated state-ref prompt anchors.
- Before image generation, the agent must manually review and optimize style, character, and key action reference prompts. Main character refs should specify identity, body type, hair, face, wardrobe state, and common model misread risks in positive production language.
- For ambiguous wardrobe states, avoid terms that trigger unwanted default garments. Use manually curated state-ref wording that describes the exact garment construction, neckline, fabric, silhouette, and production context in positive language.
- For multi-character scenes, references attach only from validated character_state_refs. Single-character shots should not attach another character's ref.

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
node bin/goldflow.mjs imagegen start --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs render start --channel <channel> --series <series> --week <week> --episode ep_01
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

## Current Test Policy

Return 7 Seconds v3 is a local-Qwen pipeline test using a final approved story. Continue it to evaluate artifact behavior, especially semantic and visual planning, but keep the quality notes attached:

- The story is treated as final.
- This test intentionally does not run a new enhancement pass.
- Existing TTS output is acceptable for pipeline timing tests, not final production quality, because rank/odds/UI pronunciation and quote-attribution normalization need hardening.
- Before a final production rerun, run speakability/readiness QA and repair protected-term spoken text before TTS.

## Worktree Discipline

Keep this repo small and revertable. Commit each migrated stage after syntax checks. Do not copy broad directories from the original repo.
