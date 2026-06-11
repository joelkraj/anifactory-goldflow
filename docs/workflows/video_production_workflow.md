# Goldflow Video Production Workflow

This is the current production path for longform recap videos in the distilled Goldflow repo.

## Core Principle

The approved narration script is production truth. The pipeline should extract, time, voice, score, visualize, and render that truth. It should not creatively repair a weak source script after approval.

## Full Flow

1. Generate or obtain a polished source narration script.
   - Use `docs/workflows/source_script_generation_workflow.md`.
   - Use `docs/prompts/manhwa_recap_chatbot_prompt_v1.md` for manhwa recap source generation unless a newer template is selected.
   - The source should be spoken narration prose only.

2. Manually review the source script before ingest.
   - Reject obvious source-prose issues before pipeline ingest.
   - Watch for narrator self-reference, headings, bracketed notes, screenplay labels, production notes, delayed title payoff, and unnatural UI dumps.

3. Ingest source.
   - Writes `operator_source_story.md`, `script_clean.md`, `source_story_ingest_report.json`, and `operator_story_lock.json`.

4. Optional pre-lock script polish.
   - Only run if the operator explicitly asks.
   - Any changed script becomes a new candidate and needs a new exact hash approval.
   - Do not treat broad LLM enhancement as a default production stage.

5. Manual review and operator approval.
   - Approve the exact `script_clean.md` hash.
   - Writes `manual_agent_script_review.json`, `operator_script_approval.json`, and `script_lock.json`.

6. Targeted speakability.
   - Preferred over broad speakability for polished scripts.
   - Requires the approved/locked script hash.
   - Writes `script_speakability_report.json`, `tts_spoken_overrides.json`, and `script_speakability_problem_areas_report.json`.
   - Use for TTS-only risks: protected terms, ranks, UI text, numbers, currencies, pronunciations, and known problem phrases.
   - It must not mutate `script_clean.md`.

7. Semantic scene plan.
   - Extracts semantic scenes from locked script and bibles.
   - This is story/visual meaning, not word timing.

8. Voice plan.
   - Narrator-only by default.
   - Character voice casting requires an explicit operator request.
   - Voice plan requires current speakability artifacts unless running a diagnostic bypass.

9. TTS generation and stitch.
   - Uses ModelsLab Qwen TTS.
   - Generates one continuous narration track and generation metadata.

10. Whisper timing.
   - Run local Whisper word timing on the final stitched narration.
   - Whisper timing is production timing truth for subtitles, SFX, scoring, semantic timing, visual beats, and render.
   - Qwen/segment timing is fallback metadata only.

11. Timing bind.
   - Binds semantic scenes to Whisper timing.

12. SFX and score planning/generation.
   - Must run after Whisper timing.
   - SFX should be noticeable but controlled.
   - Score should sit below SFX and narration.
   - Local ACE-Step can be selected with `ANIFACTORY_SCORE_PROVIDER=local_ace_step`.

13. Longform audio bed mix.
   - Mixes narration, SFX, and score into one final continuous audio track.

14. Visual beat planning.
   - Splits timed semantic scenes into image beats.
   - Current target: minimum 3 seconds, maximum 15 seconds, average near 8 seconds.

15. Visual reference planning.
   - Plans style, character state, location, UI, action, and effect refs.
   - Character state refs are the definitive identity/wardrobe/state contract.
   - Style ref comes first, then character/location/action anchors.
   - Lower-priority anchors can be generated as standalone refs or derived from selected generated cuts when appropriate.

16. Manual reference prompt review.
   - Agent/operator reviews and optimizes style, character, and key action reference prompts before image generation.
   - Keep this positive-only and specific.

17. Reference generation and approval.
   - Generate required references before scene imagegen.
   - Do not bypass missing production refs.

18. Visual prompt planning.
   - Consumes approved refs, current-scene facts, and visual beats.
   - Uses current-scene context only.
   - Prompts must name attached reference slots in order, for example: "Use image one as character identity for Kang Jiwoo; use image two as the dungeon location."
   - Prompts must use positive visual language only.

19. Visual prompt review/fix.
   - One LLM review/fix pass before imagegen.
   - Checks subject focus, identity blending risk, unnecessary refs, missing refs, action direction, literalized metaphors, wardrobe ambiguity, and contradictions with semantic facts.
   - Code gates validate structure and blockers; they do not creatively author.

20. Image generation.
   - Uses the approved prompt plan.
   - Flux Klein is the preferred image model when available.

21. Render.
   - Uses the final mixed audio track, Whisper-timed subtitles, and generated image beats.
   - Current render style uses sharper foreground image over a blurred full-frame background with more aggressive Ken Burns motion.
   - Subtitles should be yellow text with small black outline and no box/background.

## Command Order

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
node bin/goldflow.mjs visual beats --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs visual refs --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs visual plan --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs visual review --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs imagegen start --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs render start --channel <channel> --series <series> --week <week> --episode ep_01
```

## Change Policy

When a better tactic is discovered:

1. Document it here or in the relevant prompt/workflow doc.
2. Keep the pipeline philosophy intact: LLM authors, agent/operator reviews, code validates.
3. Prefer prompt/workflow improvements before deterministic creative repair.
4. Commit small, revertable changes.
