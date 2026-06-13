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
   - Stitching includes a small inter-segment safety gap by default to protect clipped final phonemes and preserve narration beat separation.
   - If the stitched audio changes, rerun Whisper timing and every timing-dependent downstream artifact.
   - Do not destructively amplify cached TTS segments. Narration loudness is raised later in the longform mix.

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
   - Local ACE-Step is the preferred production score provider. Use `ANIFACTORY_SCORE_PROVIDER=local_ace_step` or pass `--score-provider local_ace_step`.
   - Do not use ModelsLab music generation for production score unless the operator explicitly asks for a fallback.
   - Current score implementation creates chapter score beds as the base emotional floor.
   - Optional score-drop layer: add twenty to thirty-five short ACE-Step riser/hit accents on Whisper-timed drama, hype, reversal, reveal, and payoff beats. These accents are defined in `score_drop_plan_<episode>.json`; the longform mixer fades each accent in/out and ducks overlapping chapter score beds so they blend into the music instead of stacking uncontrolled volume.
   - Planning backends are Codex or local Qwen only. Do not use ModelsLab LLM endpoints for planning; ModelsLab is used for media generation.

13. Longform audio bed mix.
   - Mixes narration, SFX, and score into one final continuous audio track.
   - Production narration loudness starts at `--narration-volume-db 2`, with the longform limiter enabled.
   - Use `--narration-volume-db 3` only after a loudness/clip check passes. If narration competes with music, lower score beds or drops before pushing narration harder.

14. Visual beat planning.
   - Splits timed semantic scenes into image beats.
   - Current target: minimum 3 seconds, maximum 15 seconds, average near 8 seconds.
   - Each visual beat carries a local script excerpt or concrete beat action so the prompt LLM authors the specific cut moment.

15. Visual reference planning.
   - Plans style, character state, location, UI, action, and effect refs.
   - Character state refs are the definitive identity/wardrobe/state contract.
   - Style ref comes first, then character/location/action anchors.
   - Lower-priority anchors can be generated as standalone refs or derived from selected generated cuts when appropriate.
   - Named human characters in physical contact or close confrontation with the protagonist should use standalone refs before imagegen, even for one-scene appearances.

16. Manual reference prompt review.
   - Agent/operator reviews and optimizes style, character, and key action reference prompts before image generation.
   - Keep this positive-only and specific.
   - Character refs for scene conditioning must be single-person, single-pose, plain-background identity refs.
   - Do not use multi-position sheets, turnaround boards, multiple face-angle grids, scene backgrounds, dramatic action poses, or composition language that can transfer into cuts.

17. Reference generation and approval.
   - Generate required references before scene imagegen.
   - Do not bypass missing production refs.
   - Run references first with a reference-only imagegen pass.
   - Manually inspect generated refs before any scene cut generation.
   - Reject refs with panel grids, speech bubbles, multi-position character layouts, strong scene backgrounds, cinematic action poses, or pose/background elements likely to transfer into cuts.
   - Regenerate failed refs selectively with `--reference-ids`; do not wipe approved refs.

18. Visual prompt planning.
   - Consumes approved refs, current-scene facts, and visual beats.
   - Uses current-scene context only.
   - Prompts must preserve attached reference slots in structured order through `reference_requirements.slot_order` and `slot_purpose`.
   - The imagegen wrapper injects reference slot mapping, so the authored prompt body should not duplicate the same "Use image..." sentences.
   - Prompt bodies should describe one continuous full-frame scene by default, while intentional manga panel or split-screen layouts are allowed for montage beats, memory fragments, reaction stacks, parallel action, or UI-heavy reveals.
   - References are design guides, not visible reference panels, sheets, or backgrounds.
   - Prompts must use positive visual language only.
   - Run prompt authoring in small parent-scene-preserving chunks for both Codex and local Qwen; large whole-episode batches tend to collapse into repeated hero tableaux.

19. Visual prompt review/fix.
   - One LLM review/fix pass before imagegen.
   - Checks subject focus, identity blending risk, unnecessary refs, missing refs, action direction, literalized metaphors, wardrobe ambiguity, and contradictions with semantic facts.
   - Blocks metadata-style prompts, duplicated reference-slot text, reference-sheet/turnaround scene prompts, and repeated tableaux across visual beats.
   - Code gates validate structure and blockers; they do not creatively author.

20. Image generation.
   - Uses the approved prompt plan.
   - Flux Klein is the preferred image model when available.
   - Flux Klein and Flux Kontext are both treated as four-reference models in this pipeline.
   - Generate required references first: style reference, then character, location, UI, action, and prop references.
   - Scene attachment prioritizes visible character refs first, then location, then prop/UI, then action/effects. Priority kind outranks required/optional flags. Style refs are only attached to scene cuts when no concrete refs are available.
   - If an approved character_state_ref exists for a visible named character in that scene, imagegen may attach it even when the prompt planner omitted it. It should not attach multiple state refs for the same character in one cut.
   - If ModelsLab returns a queue or rate-limit error, rerun imagegen with lower concurrency and leave `--force` unset so existing references and completed cuts are reused.
   - Use the reviewed prompt artifact for production scene imagegen.
   - For bad scene cuts, regenerate only affected `--cut-ids` with cache reuse.
   - After targeted cut regeneration, run one full no-force imagegen pass to refresh the complete report and confirm all expected images exist.

21. Render.
   - Uses the final mixed audio track, Whisper-timed subtitles, and generated image beats.
   - Current render style uses sharper foreground image over a blurred full-frame background with intentional profile-based Ken Burns motion.
   - Motion should vary by beat: action pushes, reveal pushes, wide drifts, emotional holds, and steady pushes. Aggressive motion should not mean constant random movement.
   - Subtitles should be yellow text with small black outline and no box/background.
   - Subtitle text should come from the final approved/stitch script; Whisper provides timing anchors only.
   - Use the reviewed prompt artifact so render image lookup matches approved scene prompts.
   - Final MP4s must be upload-safe `yuv420p`; verify format, duration, fps, audio codec, and size after render.
   - Extract QA frames and spot-check final prompt/image/ref consistency before treating the render as publishable.

## Current Model And Provider Choices

- Narration TTS: ModelsLab Qwen TTS with the operator-locked Joel narrator clone.
- Voice route: narrator-only unless the operator explicitly requests character voice casting.
- Timing: local Whisper word timing on the final stitched narration.
- SFX assets: ModelsLab `/api/v7/voice/sound-generation` may generate or reuse locked assets after a Codex/local-Qwen/agent-authored plan.
- Score beds: local ACE-Step 1.5 is preferred for production score generation. Current default model pair is DiT `acestep-v15-turbo` and LM `acestep-5Hz-lm-1.7B`. ModelsLab music generation is not the preferred production score path.
- Score drops: optional second layer of twenty to thirty-five short ACE-Step riser/hit accents, timed from Whisper and mixed by ducking the base bed at focal beats.
- Image model: ModelsLab Flux Klein.
- Visual prompts: positive-only, current-scene-only, one prompt per visual beat, with explicit reference slot mapping.
- Render audio: one continuous longform mix containing narration, SFX, and score.
- Render loudness: narration raised at longform mix with `--narration-volume-db 2` as the production starting point.
- Render subtitles: final approved/stitch script text timed by Whisper, not Whisper recognition text.

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
ANIFACTORY_SCORE_PROVIDER=local_ace_step node bin/goldflow.mjs audio enrich-sfx-score --channel <channel> --series <series> --week <week> --episode ep_01
ANIFACTORY_SCORE_PROVIDER=local_ace_step node bin/goldflow.mjs audio longform-bed --channel <channel> --series <series> --week <week> --episode ep_01 --sfx-boost-db -4 --score-volume-db -27 --narration-volume-db 2
node bin/goldflow.mjs visual beats --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs visual refs --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs imagegen start --channel <channel> --series <series> --week <week> --episode ep_01 --references-only true --reference-concurrency 6
node bin/goldflow.mjs visual plan --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs visual review --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs imagegen start --channel <channel> --series <series> --week <week> --episode ep_01 --prompts <episode-dir>/section_image_prompts_reviewed.json --concurrency 6 --reference-concurrency 6
node bin/goldflow.mjs render start --channel <channel> --series <series> --week <week> --episode ep_01 --prompts <episode-dir>/section_image_prompts_reviewed.json
```

## Next Production Run Checklist

Use this checklist before spending generation time:

1. Source script
   - Start from polished spoken narration prose.
   - Remove production labels, narrator self-reference, bracketed notes, and screenplay metadata before ingest.
   - Ingest, manually review `script_clean.md`, then approve the exact hash.

2. Speakability
   - Run targeted speakability only by default.
   - Fix known TTS hazards before full TTS: dangling ellipses, clipped sentence endings, dense UI text, ranks, currencies, acronyms, and number pronunciation.
   - Do not let speakability rewrite the story broadly unless explicitly requested.

3. Audio spine
   - Generate narrator-only Qwen TTS.
   - Review a few risk windows before committing downstream.
   - Run local Whisper timing after final stitched audio.
   - If any TTS unit is regenerated or the stitch changes, rerun Whisper and all timing-dependent stages.

4. SFX and scoring
   - Run SFX/score planning only after Whisper timing.
   - Use local ACE-Step for score beds:
     `ANIFACTORY_SCORE_PROVIDER=local_ace_step`.
   - Keep SFX audible but controlled. Current mix starting point:
     `--sfx-boost-db -4 --score-volume-db -27 --narration-volume-db 2`.
   - Check the final longform mix for clipping and intelligibility. Use `--narration-volume-db 3` only if the limiter/loudness check passes.
   - Do not generate production score beds with ModelsLab music unless explicitly requested.
   - Optional score-drop layer: add twenty to thirty-five short ACE-Step riser/hit accents on focal beats, mixed by ducking the base score bed.

5. Visuals
   - Run visual beats before prompt authoring.
   - Target beat duration: minimum 3 seconds, maximum 15 seconds, average near 8 seconds.
   - Generate and manually inspect style, character, location, prop/UI, and action refs before scene imagegen.
   - Use reference-only generation first, then selectively regenerate failed refs with `--reference-ids`.
   - Character state refs are definitive for identity and wardrobe.
   - Use positive-only scene prompts. Do not use negative prompt wording.
   - Reference priority: visible characters, location, prop/UI, action/effects, style only when no concrete refs are available.
   - For multi-character scenes, spot check attached refs before bulk imagegen.
   - If Flux times out or a sample fails, resume missing or rejected `--cut-ids` only. Keep completed good cuts cached.
   - Start imagegen concurrency around 6-12 on a fresh production run; raise only after quality and queue stability are confirmed.

6. Render
   - Render from the continuous mixed audio track.
   - Use final-script subtitles timed to Whisper, not Whisper-recognized text.
   - Subtitle style: yellow text, small black outline, no background box.
   - Motion style: fast transitions and intentional profile-based Ken Burns, not random movement.
   - Verify final MP4 codec/pixel format with `ffprobe`, especially `yuv420p` for upload compatibility.

## Change Policy

When a better tactic is discovered:

1. Document it here or in the relevant prompt/workflow doc.
2. Keep the pipeline philosophy intact: LLM authors, agent/operator reviews, code validates.
3. Prefer prompt/workflow improvements before deterministic creative repair.
4. Commit small, revertable changes.
