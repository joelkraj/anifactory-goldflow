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
   - SFX-only is allowed when the story is stronger with clean narration and punctuation SFX instead of continuous music.
   - For SFX-only, run audio enrichment with `--sfx-only true`; the score plan is deliberately empty and no score beds are generated.
   - Local ACE-Step is the preferred production score provider. Use `ANIFACTORY_SCORE_PROVIDER=local_ace_step` or pass `--score-provider local_ace_step`.
   - Do not use ModelsLab music generation for production score unless the operator explicitly asks for a fallback.
   - Opening hook SFX should be abundant. In the first thirty seconds, target at least ten and ideally ten to twelve audible SFX or transition cues when the narration supports them: swipe-up flash, swipe-down whoosh, hard scene-card whoosh, impact flash, dark-paper title snap, manga-panel slide, system or ledger pulse, room hush, blade/blood hit, or similar beat-native accents.
   - After the opening, SFX should stay consistently present but selective. Hit scene transitions, ledger/system activations, blood/sword/contact, crowd hush/laughter, qi pressure, gates/doors, snow/water movement, and major reversals.
   - Ambience should be generated as loopable SFX, not as score. Use ten to fourteen low nonmusical environmental beds between score drops: duel memory air, clan hall room tone, winter courtyard wind, punishment courtyard cold air, ancestral ritual hall, rooftop snow, east courtyard, hidden room, underwater tunnel, ravine forest, etc.
   - Score should be moment-directed, not automatic. For stories that do not need continuous music, use drops-only scoring: `--score-mode drops_only` keeps `score_chapter_plan.json` empty and writes short dramatic accents to `score_drop_plan_<episode>.json`.
   - Score drops should land only on earned dramatic, intense, reveal, reversal, payoff, escape, and cliffhanger moments. The longform mixer fades each accent in/out and ducks overlapping chapter score beds if any exist.
   - Planning backends are Codex or local Qwen only. Do not use ModelsLab LLM endpoints for planning; ModelsLab is used for media generation.
   - Next local LLM bakeoff candidate: `yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF`, stored at `/Users/joel/AniFactoryModels/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF`. Preferred first test file for the 64 GB MacBook Pro is `gemma4-coding-Q8_0.gguf`, downloaded at about 12 GB with SHA-256 prefix `5291d70fcffe05b3869de8f1f41aa89ca361913aa7b76af22867a798999672f7`; fall back to `gemma4-coding-Q6_K.gguf` only if Q8 is too slow or memory pressure is too high. Evaluate it against local Qwen for semantic planning, visual prompt authoring, visual prompt review, and code/pipeline patch suggestions before changing defaults. The earlier `mlx-community/gemma-4-12B-it-OptiQ-4bit` pull is a secondary comparison candidate only.

13. Longform audio bed mix.
   - Mixes narration, SFX, and score into one final continuous audio track.
   - Production narration loudness starts at `--narration-volume-db 2`, with the longform limiter enabled.
   - Use `--narration-volume-db 3` only after a loudness/clip check passes. If narration competes with music, lower score beds or drops before pushing narration harder.
   - For SFX-only, pass `--skip-score true` so chapter beds and score drops are excluded from the final mix.

14. Visual beat planning.
   - Splits timed semantic scenes into image beats.
   - Current target: minimum 3 seconds, maximum 15 seconds, average near 8 seconds.
   - Each visual beat carries a local script excerpt or concrete beat action so the prompt LLM authors the specific cut moment.
   - Visual prompt authoring is manifest-first. Each cut must include a `shot_manifest` with physically visible characters, mentioned-only characters, active character-state refs, location ref, foreground action, shot job, props/UI, and forbidden refs before the prose prompt is trusted.
   - The LLM receives previous/next beat summaries for sequencing and variety, but those summaries are context only. Current `visual_beat_script_excerpt` remains the authority for what appears in the frame.

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
   - If a cut physically occurs in a real environment such as an apartment, gym, office, street, shop, corridor, boardroom, lobby, stage, or courthouse area, the LLM must choose the closest approved location ref and set `shot_manifest.location_ref_id`. Sanitation blocks physical-location prompts that omit both `location_ref_id` and a location reference instead of guessing the location.
   - Prompt bodies should describe one continuous full-frame scene by default, while intentional manga panel or split-screen layouts are allowed for montage beats, memory fragments, reaction stacks, parallel action, or UI-heavy reveals.
   - References are design guides, not visible reference panels, sheets, or backgrounds.
   - Prompts must use positive visual language only.
   - Run prompt authoring in small parent-scene-aware chunks for both Codex and local Qwen; large whole-episode batches tend to collapse into repeated hero tableaux or incomplete JSON.
   - Codex visual authoring should scale by parallel four-cut chunks, not by large single prompts. Default target is four visual units per chunk with up to six chunk calls in parallel after sample gates pass.

19. Visual prompt review/fix.
   - One LLM review/fix pass before imagegen.
   - Review repairs `shot_manifest` first, then prompt prose and references. Mentioned-only characters stay out of the visible prompt and do not attach refs.
   - Checks subject focus, identity blending risk, unnecessary refs, missing refs, action direction, literalized metaphors, wardrobe ambiguity, and contradictions with semantic facts.
   - Blocks metadata-style prompts, duplicated reference-slot text, reference-sheet/turnaround scene prompts, and repeated tableaux across visual beats.
   - Code gates validate structure and blockers; they do not creatively author.

20. Visual prompt sanitation.
   - Run after LLM review and before any scene image generation.
   - Writes `section_image_prompts_hardened.json`, `visual_prompt_hardening_<episode>.json`, and `visual_prompt_hardening_sample_<episode>.md`.
   - The command remains `visual harden`, but production default mode is sanitation-only. It validates approved ref IDs and paths, strips unknown or forbidden refs, enforces the four-reference model limit, normalizes known non-creative unsafe UI label phrasing, validates `shot_manifest` ref/location contradictions, and blocks unresolved ref risks.
   - The LLM is the creative visual author. It must receive the story chunk, premise/bible context, approved refs, state contracts, current beat excerpt, and neighboring beat summaries needed to choose visible characters, location, composition, shot job, and necessary refs. Deterministic production sanitation must not creatively infer missing locations, add characters, rewrite action, choose shot jobs, insert staging clauses, or repair narrative intent.
   - The old deterministic creative repair behavior is diagnostic only with `--mode repair`. Do not use repair mode as the production default.
   - Mixed-location scenes must be resolved at beat level by the author/reviewer. If a parent scene contains "support workplace, then apartment kitchen table", each cut receives its own location contract from the beat excerpt. The workplace cut must attach or request the support-office location, while the debt cut must attach the apartment location.
   - Beat-level location contracts override parent-scene location fallbacks during LLM authoring/review. A current cut that says "went to work", "headset", "manager", or "support tickets" is a support-office shot even if the parent scene later returns to the apartment.
   - Montage scenes must be authored as one present-tense location per cut. If a parent scene mentions apartment kitchen, dumpster exterior, and bedroom sleep, the individual cuts should become kitchen cleanup, dumpster victory, system reward, or bedroom sleep frames, not uncontrolled panel grids or multi-time collages.
   - Unattached character mentions are sanitized when they are phone, text, voicemail, document, profile, or memory mentions. A character reference is attached only when the LLM physically stages that character in the current cut.
   - Communication-heavy beats can use intentional manga-style split panels when useful. The LLM should assign strict panel roles: largest panel is the local protagonist in the real current location; smaller panels are device close-ups, contact avatar icons, email/envelope icons, call-flow cards, opportunity badges, or abstract system glyphs. Do not let a phone call, voicemail, cold email, or remote sales call become a physical remote-person scene unless the script places that person in the room.
   - Dialogue-heavy beats are authored/reviewed as silent acting frames. Prompts should stage emotion through posture, eyelines, expressions, hand placement, prop action, and blocking rather than phrases like "spoken line", "says", or "says loudly", which can produce speech bubbles and caption artifacts.
   - Every cut gets a shot job from the beat excerpt, such as location establishment, object insert, interaction, physical action, or emotional reaction. This prevents adjacent cuts from collapsing into repeated hero portraits or repeated desk-and-UI tableaux.
   - If four visible character refs consume all available slots, the LLM should keep the four character refs and report the dropped location ref in `reference_usage`. Sanitation enforces the cap but should not creatively reprioritize content.
   - The LLM author/reviewer handles known Flux failure classes with positive construction: duplicate protagonist copies, foreground close-up plus tiny secondary overlays, reflected faces inside props, speech bubbles/dialogue lettering, UI panels covering faces, or UI panels reading as solid censor blocks.
   - UI, system, and ledger text accuracy is not a blocker by itself. Treat UI as a problem only when it becomes physically destructive, covers the subject/action, creates duplicate figures, or changes the shot into a prop/device shot. Exact story-critical words can still be added during render as overlays when intentionally needed.
   - Supernatural UI and ledger panels should remain immaterial floating light panels with a visible air gap from hands. They must not become books, laptops, tablets, phones, monitors, keyboards, scrolls, boards, or other physical held objects.
   - Abstract energy, memory, and aura effects should be phrased positively as ribbon-like light, empty glow, silhouettes, or abstract shapes. Avoid negative ghost/face/body wording in prompts because image models often render the forbidden subject named in the negative phrase.
   - Review the markdown sample sheet before spending full imagegen budget. It must include risky examples such as the hook, one location-anchor cut, elder/patriarch/envoy aliases, crowded multi-character shots, action/combat, UI/prop/document, and a late-episode continuity cut.

21. Image generation.
   - Uses the approved prompt plan.
   - Flux Klein is the preferred image model when available.
   - Flux Klein and Flux Kontext are both treated as four-reference models in this pipeline.
   - Generate required references first: style reference, then character, location, UI, action, and prop references.
   - Scene attachment prioritizes visible character refs first, then location, then prop/UI, then action/effects. Priority kind outranks required/optional flags. Style refs are only attached to scene cuts when no concrete refs are available.
   - When all four reference slots are needed for visible characters, keep those character refs and drop location first.
   - For sanitized prompt plans, `section_image_prompts_hardened.json` is authoritative. Imagegen must not infer extra character refs from stale `visible_subjects`, and it must not write runtime reference paths or inferred refs back into the hardened prompt plan.
   - Continuous-location scenes keep the active location ref attached across the whole location block, not only on wide shots or scene starts. Hall, courtyard, rooftop, ravine, and similar sequences need the same location anchor on every continuity-sensitive cut.
   - Explicit venue words in the cleaned scene prompt override contextual prop or action cues when selecting location refs. A banquet-hall restraint beat should keep the banquet hall ref even if it mentions spirit rope.
   - Offscreen sound or light from another venue must not override the visible staging. If a courtyard or side-corridor shot mentions banquet hall glow, music, or sound cues, keep the visible courtyard/corridor location ref.
   - Character aliases must be resolved before imagegen. Role labels such as "white-bearded elder," "patriarch," "envoy," "replacement heir," and "cousin attacker" attach the matching approved character_state_ref when visible.
   - Possessive name phrases do not imply visible characters. Object inserts such as "Mu-gyeol's mother's sword" should attach prop and location refs, not Mu-gyeol's character ref, unless his body is actually visible.
   - Memory/reflection beats should stage memories as separate translucent silhouettes near the prop, not as faces embedded in basins, mirrors, blades, documents, or bodies.
   - Childhood flashbacks need child-specific refs or no adult character refs. If child refs are unavailable, stage the beat as child memory silhouettes with the current location ref only, because adult refs contaminate age, wardrobe, and body shape.
   - Ritual/document close-ups should favor physical seal glow, ink, brush water, paper, and altar light. Add supernatural UI only when the beat explicitly calls for a ledger/interface reveal.
   - Subject fusion, miniature heads, duplicate protagonist faces, or faces embedded in another body are generated-still failures. Regenerate those cuts with positive staging language: separate complete bodies, clear spacing, distinct face placement, visible robe and shoulder boundaries, one continuous manhwa frame.
   - If ModelsLab returns a queue, rate-limit, fetch failure, or long stuck tail, rerun the affected `--cut-ids` with lower concurrency and leave `--force` unset unless intentionally replacing a bad cut. Completed good images should be reused.
   - Use the hardened prompt artifact for production scene imagegen. Imagegen rejects non-hardened prompt plans by default; `--allow-unhardened-prompts true` is diagnostic only.
   - For bad scene cuts, regenerate only affected `--cut-ids` with cache reuse.
   - After targeted cut regeneration, run one full no-force imagegen pass to refresh the complete report and confirm all expected images exist.
   - Babysit new productions through staged visual gates before trusting full automation: reference QA, sanitized prompt sample QA, first small image batches, and periodic contact-sheet checks through high-risk sections. Promote to lower-touch runs only after several consecutive batches show no duplicate protagonist, subject fusion, destructive UI, wrong refs, or major location/style drift.

22. Render.
   - Uses the final mixed audio track, Whisper-timed subtitles, and generated image beats.
   - Current render style uses full-frame profile-based Ken Burns motion by default. Use the blurred foreground mode only as a deliberate style override.
   - For longform episodes, render motion clips with bounded concurrency and a moderate Ken Burns overscale multiplier. Motion should stay visible and intentional without serial 4K intermediates becoming the bottleneck for 1080p delivery. Use `--motion fill_pan` when `zoompan` is too slow for a full still-image episode.
   - Motion should vary by beat: action pushes, reveal pushes, wide drifts, emotional holds, and steady pushes. Aggressive motion should not mean constant random movement.
   - Transitions should be hand-picked by beat, not default fade-to-black. Use smooth FFmpeg transitions such as wipes, pushes, slides, flashes, and manga-panel swipes where they match the moment.
   - Transition SFX should be bound to the actual transition timestamp on selected cuts. The opening thirty seconds should use frequent noticeable transition cues such as swipe-up flash, swipe-down whoosh, scene-card whoosh, impact flash, and manga-panel slide; after the hook, use them selectively so they feel intentional.
   - Subtitles should be yellow text with small black outline and no box/background.
   - Subtitle text should come from the final approved/stitch script; Whisper provides timing anchors only.
   - Use the hardened prompt artifact so render image lookup matches approved scene prompts.
   - Final MP4s must be upload-safe `yuv420p`; verify format, duration, fps, audio codec, and size after render.
   - Extract QA frames and spot-check final prompt/image/ref consistency before treating the render as publishable.

## Current Model And Provider Choices

- Narration TTS: ModelsLab Qwen TTS with the operator-locked Joel narrator clone.
- Voice route: narrator-only unless the operator explicitly requests character voice casting.
- Timing: local Whisper word timing on the final stitched narration.
- SFX assets: ModelsLab `/api/v7/voice/sound-generation` may generate or reuse locked assets after a Codex/local-Qwen/agent-authored plan.
- SFX prompting: concrete source/material/action/space prompts, short clean effects, no story-summary prompts, no melody, no speech, no crowd dialogue.
- Ambience assets: generated with the SFX model as loopable nonmusical beds. Plans should mark them with `recurrence_class: "ambience"`, `loop: true`, short `asset_duration_sec`, longer timeline `duration_sec`, and low gain around -34 to -28 dB.
- Score beds: local ACE-Step 1.5 is preferred when intentionally using chapter score beds. Current default model pair is DiT `acestep-v15-turbo` and LM `acestep-5Hz-lm-1.7B`. ModelsLab music generation is not the preferred production score path.
- Score drops: preferred scoring mode for narration-led recaps when music should be sparse. Use twenty to thirty-five short ACE-Step riser/hit accents, timed from Whisper, on focal drama, hype, reveal, reversal, payoff, escape, and cliffhanger beats.
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
ANIFACTORY_SCORE_PROVIDER=local_ace_step node bin/goldflow.mjs audio enrich-sfx-score --channel <channel> --series <series> --week <week> --episode ep_01 --score-mode drops_only --sfx-target-count 90 --score-target-drops 24
ANIFACTORY_SCORE_PROVIDER=local_ace_step node bin/goldflow.mjs audio longform-bed --channel <channel> --series <series> --week <week> --episode ep_01 --sfx-boost-db -4 --score-volume-db -27 --narration-volume-db 2
node bin/goldflow.mjs visual beats --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs visual refs --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs imagegen start --channel <channel> --series <series> --week <week> --episode ep_01 --references-only true --reference-concurrency 6
node bin/goldflow.mjs visual plan --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs visual review --channel <channel> --series <series> --week <week> --episode ep_01
node bin/goldflow.mjs visual harden --channel <channel> --series <series> --week <week> --episode ep_01 --prompts <episode-dir>/section_image_prompts_reviewed.json --sample-count 14
node bin/goldflow.mjs imagegen start --channel <channel> --series <series> --week <week> --episode ep_01 --prompts <episode-dir>/section_image_prompts_hardened.json --concurrency 6 --reference-concurrency 6
node bin/goldflow.mjs render start --channel <channel> --series <series> --week <week> --episode ep_01 --prompts <episode-dir>/section_image_prompts_hardened.json
```

Small-batch visual authoring test:

```bash
node bin/goldflow.mjs visual plan --channel <channel> --series <series> --week <week> --episode ep_01 --limit 6 --dry-run-prompt true --output <episode-dir>/section_image_prompts_sample_001_006_dry_run.json
node bin/goldflow.mjs visual plan --channel <channel> --series <series> --week <week> --episode ep_01 --limit 6 --output <episode-dir>/section_image_prompts_sample_001_006.json
node bin/goldflow.mjs visual review --channel <channel> --series <series> --week <week> --episode ep_01 --prompts <episode-dir>/section_image_prompts_sample_001_006.json --output <episode-dir>/section_image_prompts_sample_001_006_reviewed.json
node bin/goldflow.mjs visual harden --channel <channel> --series <series> --week <week> --episode ep_01 --prompts <episode-dir>/section_image_prompts_sample_001_006_reviewed.json --output <episode-dir>/section_image_prompts_sample_001_006_hardened.json --report-output <episode-dir>/visual_prompt_hardening_sample_001_006.json --sample-output <episode-dir>/visual_prompt_hardening_sample_001_006.md
```

Use `--dry-run-prompt true` before LLM calls when testing new batch scopes. It verifies selected cut IDs and prompt packet size without spending an authoring call.

SFX-only audio variant:

```bash
node bin/goldflow.mjs audio enrich-sfx-score --channel <channel> --series <series> --week <week> --episode ep_01 --sfx-only true --sfx-target-count 45
node bin/goldflow.mjs audio longform-bed --channel <channel> --series <series> --week <week> --episode ep_01 --skip-score true --sfx-boost-db -4 --narration-volume-db 2 --outputBase ep_01-<channel>-qwen-sfx-only --reportSuffix -sfx-only
node bin/goldflow.mjs render start --channel <channel> --series <series> --week <week> --episode ep_01 --audio <episode-dir>/assets/audio/longform_mix/ep_01-<channel>-qwen-sfx-only.m4a --prompts <episode-dir>/section_image_prompts_reviewed.json --output <episode-dir>/assets/renders/<title>-sfx-only.mp4 --report-output <episode-dir>/render_report_ep_01-sfx-only.json
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
   - For narration-led humiliation/system stories, test SFX-only first: narrator plus system pings, phone buzzes, paper/object sounds, room hushes, laugh ripples, applause turns, and wealth-reveal impacts.
   - SFX prompts must name the source, material, action, space, and intensity. Example: `short cold crystalline digital transaction chime, quick attack, clean decay, subtle corporate interface texture`.
   - Use local ACE-Step for score drops or any intentional score beds:
     `ANIFACTORY_SCORE_PROVIDER=local_ace_step`.
   - Default for this style should be drops-only scoring:
     `--score-mode drops_only --sfx-target-count 90 --score-target-drops 24`.
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
   - LLM-authored scene prompts should be positive-only. Creative visual decisions belong to LLM authoring/review. Deterministic production sanitation should only validate and sanitize approved refs, paths, max-count limits, forbidden refs, and non-creative unsafe UI label phrasing.
   - Reference priority: visible characters, location, prop/UI, action/effects, style only when no concrete refs are available.
   - For multi-character scenes, spot check attached refs before bulk imagegen. Check for wrong character refs, stale visible-subject refs, duplicate MC, face/body fusion, prop-embedded faces, speech bubbles, UI covering faces, and location drift.
   - If Flux times out or a sample fails, resume missing or rejected `--cut-ids` only. Keep completed good cuts cached.
   - Start imagegen concurrency around 6-12 on a fresh production run; raise only after quality and queue stability are confirmed.
   - Babysit the next run through staged visual gates before trusting full automation: manually review references, review the sanitized prompt sample, generate and contact-sheet the first small image batches, then keep periodic contact-sheet spot checks through high-risk sections.

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
3. Prefer prompt/workflow improvements before deterministic creative repair. Production default is LLM authorship plus deterministic sanitation, not deterministic creative repair.
4. Commit small, revertable changes.
