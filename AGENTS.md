# AniFactory Goldflow

This repo is the clean longform production lane. It intentionally excludes legacy render paths, old visual heuristics, source-seed annotations, regex SFX production fallback, and multi-route compatibility behavior from the original AniFactory repo.

## Non-Negotiable Flow

Production moves through one artifact chain:

0. Generate or obtain a polished narration story using the source-script workflow in `docs/workflows/source_script_generation_workflow.md`.
1. Ingest a polished narration story into `script_clean.md`.
2. Optional script polish/enhancement only when the operator explicitly asks for it, before approval, with the resulting script treated as a new candidate for review.
3. Manual review and operator approval for the exact final script hash.
4. Targeted production-readiness and speakability QA from the approved script. These passes may suggest TTS-only fixes for known problem areas, pronunciation mappings, and risk notes, but must not silently rewrite the story. Broad speakability is optional and must be explicitly requested.
5. Semantic scene annotation from the locked script and bibles.
6. Narrator-only voice plan by default. Voice planning requires current `script_speakability_report.json` and `tts_spoken_overrides.json` unless explicitly run in diagnostic bypass mode.
7. ModelsLab Qwen TTS and stitch.
8. Local Whisper word timing on the final stitched narration.
9. Review TTS and timing artifacts before downstream production.
10. Timing-bound SFX and score planning from Whisper timing.
11. Longform audio bed mix.
12. Visual beat planning: split timing-bound semantic scenes into shorter image beats before prompt authoring.
13. Visual reference planning: create `character_state_refs.json` and any style/location/action reference specs from locked script, bibles, and semantic scenes.
14. Manual agent/operator review and optimization of reference prompts. Character state refs become the definitive visual identity/wardrobe/state contract.
15. Reference generation in dependency order: style ref first, then character/location/action anchors.
16. Visual prompt planning consumes approved references, current-scene facts, and visual beats.
17. Visual prompt review/fix pass checks the authored prompts against scene facts and approved refs.
18. Image generation and render.

Current migrated scope is source ingest, script approval, targeted speakability, semantic scene planning, the audio spine, Whisper timing, timing binding, SFX/score enrichment, longform audio mix, visual beat planning, visual reference planning, current-scene-only visual prompt planning, LLM visual prompt review, strict ModelsLab image generation, and a durable continuous-audio render. The full production workflow is documented in `docs/workflows/video_production_workflow.md`.

## Hard Rules

- Do not use source-seed scene annotations. Final semantic truth comes from the locked script.
- Source scripts should arrive as spoken narration prose only. Use `docs/prompts/manhwa_recap_chatbot_prompt_v1.md` for manhwa recap chatbot generation unless a newer documented template is selected.
- Chatbot prompts are versioned in `docs/prompts/`; improve those templates before adding deterministic source-prose repair to the pipeline.
- Do not creatively rewrite approved scripts with deterministic code.
- Treat the chatbot/operator-approved story as production truth. Qwen may analyze, extract, and flag issues, but it must not be trusted to improve story prose by default.
- Generic script enhancement is optional and pre-lock only. If enhancement changes the script, every downstream artifact must be regenerated from the new exact hash.
- Keep caption text, spoken TTS text, and semantic visual facts as separate layers. Captions preserve the approved script; TTS may use approved speakable equivalents; visuals use extracted scene facts.
- Protected terms need explicit speakability handling before TTS, especially ranks, UI labels, odds, decimals, currencies, acronyms, and system messages.
- Targeted script speakability is the preferred TTS guidance stage. It must not mutate `script_clean.md`; it writes `script_speakability_report.json`, `tts_spoken_overrides.json`, and `script_speakability_problem_areas_report.json`. It should fix known problem areas only, such as explicit narrator self-reference ("the narrator wants you to understand") that sounds artificial when spoken. Broad speakability can introduce unnatural rewrites and should only run on explicit operator request.
- Do not run SFX or score planning before final narration exists.
- Do not run SFX or score planning without current local Whisper timing.
- Segment or Qwen timing is fallback metadata only; production SFX/score plans must be stamped with `timing_source: "local_whisper_word_timing"`.
- Planning LLM routes are Codex or local Qwen only. Do not use ModelsLab LLM endpoints for semantic, audio, visual reference, visual prompt, or prompt review planning. ModelsLab is a media generation provider in this workflow, not a planning backend.
- Score/music generation can use local ACE-Step 1.5 by setting `ANIFACTORY_SCORE_PROVIDER=local_ace_step` or passing `--score-provider local_ace_step`. This feeds each beat-mapped chapter `ace_step_prompt` to `/Users/joel/AniFactoryTools/ACE-Step-1.5` and writes beds under `assets/audio/ace_step_score_beds`. Default local model selection is DiT `acestep-v15-turbo` with LM `acestep-5Hz-lm-1.7B`; override with `ANIFACTORY_ACE_STEP_CONFIG_PATH` and `ANIFACTORY_ACE_STEP_LM_MODEL`.
- ModelsLab score generation remains available with `ANIFACTORY_SCORE_PROVIDER=modelslab` and uses `/api/v6/voice/music_gen` model_id `ai-music-generator`.
- Narrator-only is the default voice route. Character voice casting requires an explicit operator request and flag.
- Ambiguous dialogue routes to narrator.
- Render must consume one continuous final mixed audio track.
- Visual planning must use current-scene facts only. Do not import neighboring context, stale refs, negative prompt wording, or characters not visible in the scene.
- Visual prompt planning must consume `visual_beat_plan.json` when present. Semantic scenes are not image cuts; long scenes must be split into multiple visual beats before imagegen. Default beat pacing aims for an average near 8 seconds, minimum 3 seconds, maximum 15 seconds.
- Visual beats must carry local script excerpts or concrete beat actions. The LLM should author each image prompt from the beat excerpt, not from a repeated parent-scene summary.
- Positive visual language is mandatory from inception. Reference anchors, character state refs, scene prompts, prompt reviews, and imagegen payloads must describe what should appear, never what should be avoided. Do not use clauses such as "no...", "not...", "without...", "avoid...", "exclude...", "rather than...", or "instead of..." in production prompts.
- When a visual risk needs mitigation, convert it into a positive construction: write the exact garment, subject count, role, pose, frame composition, and visible action wanted.
- Required references must exist before image generation. Style ref comes first, then character/location/action anchors as needed; do not bypass missing reference requirements for production.
- Reference kinds have strict boundaries: character refs provide identity and wardrobe; location refs provide environment; UI refs provide interface design; action/effect refs provide effect shape, color, movement path, and interaction logic. Scene prompts provide the actual pose, camera angle, and current location.
- Character state references are produced before visual planning and are definitive for visual identity, wardrobe, and character state. Do not let visual planners infer wardrobe from ambiguous prose such as "gray suit"; use curated state-ref prompt anchors.
- Before image generation, the agent must manually review and optimize style, character, and key action reference prompts. Main character refs should specify identity, body type, hair, face, wardrobe state, and common model misread risks in positive production language. Character refs should be identity-only studio sheets on a plain background with multiple face angles or simple turnaround views; avoid scene backgrounds, dramatic action poses, or composition language that can transfer into cuts.
- For ambiguous wardrobe states, avoid terms that trigger unwanted default garments. Use manually curated state-ref wording that describes the exact garment construction, neckline, fabric, silhouette, and production context in positive language.
- For multi-character scenes, references attach only from validated character_state_refs. Single-character shots should not attach another character's ref.
- Visual prompt planning must not create definitive character anchors. It may consume approved `character_state_refs`, select which refs are visible/style-critical for a cut, and report missing reference coverage as warnings or blockers.
- Image prompts that attach references must preserve positive Flux-style reference slot mapping through structured `reference_requirements.slot_order` and `slot_purpose`. The imagegen wrapper injects concise "Use image one as..." text at generation time, so authored scene prompt bodies must not duplicate those instructions.
- Scene prompt bodies should request one continuous full-frame image by default, but intentional manga panel or split-screen layouts are allowed for montage beats, memory fragments, reaction stacks, parallel action, or UI-heavy reveals. Reference images guide identity, wardrobe, style, UI, props, and effects; they should not be described as visible reference panels, sheets, or background content inside the final cut.
- Image models should not be asked to render dense exact UI text. Scene prompts may request clean holographic panels, gauges, icons, simple labels, and at most one short large number or word when visually essential. Exact multi-line system text, captions, lists, and long labels belong in `ui_text_on_screen` for render/subtitle overlay.
- Run visual prompt authoring and review in small parent-scene-preserving chunks for both Codex and local Qwen. Large whole-episode prompt batches tend to collapse into repeated hero tableaux; arbitrary chunks that split a scene hide the progression the LLM needs.
- Visual prompt review is the only LLM prompt-fix stage before imagegen. It may revise prompt wording, but must preserve scene IDs, image IDs, timing, and source hashes. Code gates validate only structure, hashes, missing references, and unresolved blockers.
- Image generation uses ModelsLab Flux Klein by default. References are generated first and stored under `assets/images/references`; image cuts are stored under `assets/images`. When ModelsLab returns a queue/rate-limit error, resume with lower `--concurrency` and keep `--force` unset so fresh refs and completed cuts are reused.

## Current Production Models And Methods

- Source: polished narration prose from the operator/chatbot, with exact-hash script approval.
- Speakability: targeted-only by default; broad speakability is opt-in.
- Voice: narrator-only default through ModelsLab Qwen TTS using the locked Joel narrator clone.
- Timing: local Whisper word timing is production truth for subtitles, SFX, score, visual beats, and render.
- Audio planning: Codex or local Qwen only. If automated planner calls are unavailable, a Codex-agent manual plan may be written with explicit provenance, current source hashes, and Whisper timing.
- SFX generation: ModelsLab `/api/v7/voice/sound-generation` assets are allowed after a Codex/local-Qwen/agent-authored plan. SFX events must use locked asset paths before mix.
- Score generation: prefer local ACE-Step 1.5 for score beds; current default local model pair is `acestep-v15-turbo` plus `acestep-5Hz-lm-1.7B`.
- Image generation: ModelsLab Flux Klein, with positive-only prompts and explicit reference slot mapping.
- Render: one continuous mixed audio track, Whisper-timed subtitles, yellow subtitle text with a small black outline and no background box.

## Commands

```bash
node bin/goldflow.mjs ingest source --channel <channel> --series <series> --week <week> --episode ep_01 --source <chatbot-output.md>
node bin/goldflow.mjs script approve --channel <channel> --series <series> --week <week> --episode ep_01 --hash <script_clean_sha256>
node bin/goldflow.mjs script targeted --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs semantic plan --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs voice plan --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs tts qwen --channel <channel> --series <series> --week <week> --episode ep_01 --suffix -modelslab-qwen
node bin/goldflow.mjs audio whisper-timing --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs timing bind --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs audio enrich-sfx-score --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs audio longform-bed --channel <channel> --series <series> --week <week> --episode ep_01
ANIFACTORY_SCORE_PROVIDER=local_ace_step node bin/goldflow.mjs audio enrich-sfx-score --channel <channel> --series <series> --week <week> --episode ep_01
ANIFACTORY_SCORE_PROVIDER=local_ace_step node bin/goldflow.mjs audio longform-bed --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs visual beats --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs visual refs --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs visual plan --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs visual review --channel <channel> --series <series> --week <week> --episode ep_01
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
