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
18. Visual prompt sanitation validates LLM-authored prompt/ref manifests, resolves approved ref paths, strips forbidden or unknown refs, enforces the four-reference cap, and writes a pre-imagegen sample sheet.
19. Image generation.
20. Render with intentional beat-selected transitions, final-script subtitles timed to Whisper, and one continuous mixed audio track.
21. Final QA: spot-listen narration cuts, spot-check prompt/image/ref consistency, verify transition style, verify subtitles are final-script text timed to Whisper, then `ffprobe` the final upload-safe render.

Current migrated scope is source ingest, script approval, targeted speakability, semantic scene planning, the audio spine, Whisper timing, timing binding, SFX/score enrichment, longform audio mix, visual beat planning, visual reference planning, current-scene-only visual prompt planning, LLM visual prompt review, deterministic visual prompt sanitation, strict ModelsLab image generation, and a durable continuous-audio render. The full production workflow is documented in `docs/workflows/video_production_workflow.md`.

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
- Local LLM candidate to test on the next production run: `yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF`, downloaded under `/Users/joel/AniFactoryModels/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF`. Preferred first test file for the 64 GB MacBook Pro is `gemma4-coding-Q8_0.gguf`, downloaded at about 12 GB, SHA-256 prefix `5291d70fcffe05b3869de8f1f41aa89ca361913aa7b76af22867a798999672f7`; use `gemma4-coding-Q6_K.gguf` only if Q8 is too slow or memory pressure is too high. Test it against local Qwen for AniFactory semantic planning, visual prompt authoring, visual prompt review, and code/pipeline patch suggestions before adopting it as a default. The earlier `mlx-community/gemma-4-12B-it-OptiQ-4bit` pull is only a secondary comparison candidate, not the requested primary model.
- SFX-only is an approved production route for narration-driven humiliation/system stories. Run audio enrichment with `--sfx-only true`, generate no score beds, and mix with `--skip-score true` so the final audio is narrator plus selected SFX only.
- SFX generation prompts must describe the concrete sound source, material, action, space, duration feel, and intensity. Do not send story summaries as SFX prompts. Good prompt shape: "short cold crystalline digital transaction chime, quick attack, clean decay, subtle corporate interface texture, no melody, no speech." For crowd/room cues, request nonverbal texture such as a brief wealthy-room laugh ripple, shocked gasp wave, applause swell, or sudden room hush.
- SFX should be selective and beat-anchored. Prioritize system pings, phone buzzes, paper/card handling, glass/banquet objects, room hushes, laugh ripples, applause turns, wealth-reveal impacts, and a few signature transaction confirmations. Avoid constant literal Foley under every sentence.
- Score/music generation can use local ACE-Step 1.5 by setting `ANIFACTORY_SCORE_PROVIDER=local_ace_step` or passing `--score-provider local_ace_step`. This feeds each beat-mapped chapter `ace_step_prompt` to `/Users/joel/AniFactoryTools/ACE-Step-1.5` and writes beds under `assets/audio/ace_step_score_beds`. Default local model selection is DiT `acestep-v15-turbo` with LM `acestep-5Hz-lm-1.7B`; override with `ANIFACTORY_ACE_STEP_CONFIG_PATH` and `ANIFACTORY_ACE_STEP_LM_MODEL`.
- Score should be moment-directed, not automatic. For runs where the story is stronger without continuous music, use `--score-mode drops_only`: `score_chapter_plan.json` stays empty and `score_drop_plan_<episode>.json` places short Whisper-timed local ACE-Step riser/hit accents only on focal drama, hype, reversal, reveal, payoff, escape, and cliffhanger beats. The longform mixer fades each drop in/out; if chapter beds exist, it ducks overlapping beds instead of stacking uncontrolled volume. Target roughly 20-35 score drops for a long episode, keep them separate from physical SFX, and use them sparingly enough that they feel intentional.
- SFX should be dense in the opening hook. For the first 30 seconds, target at least 10 and ideally 10-12 audible SFX/transition cues where narration supports it: swipe-up flash, swipe-down whoosh, hard scene-card whoosh, impact flash, dark-paper title snap, manga-panel slide, system/ledger pulse, room hush, or blade/blood hit. After the hook, keep SFX consistently present but selective and beat-anchored.
- Ambience is generated as loopable SFX, not as score. Use 10-14 low nonmusical environmental beds between score drops: duel memory air, clan hall room tone, winter courtyard wind, punishment courtyard cold air, ancestral ritual hall, rooftop snow, east courtyard, hidden room, underwater tunnel, ravine forest, etc. Ambience prompts must avoid melody, rhythm, vocals, speech, or crowd dialogue and should sit around -34 to -28 dB.
- ModelsLab score generation remains available with `ANIFACTORY_SCORE_PROVIDER=modelslab` and uses `/api/v6/voice/music_gen` model_id `ai-music-generator`.
- Narrator-only is the default voice route. Character voice casting requires an explicit operator request and flag.
- Ambiguous dialogue routes to narrator.
- Render must consume one continuous final mixed audio track.
- Qwen TTS stitch must include a small inter-segment safety gap by default so unit boundaries do not clip final phonemes or smash narration beats together. Current default is `ANIFACTORY_MODELSLAB_QWEN_SEGMENT_GAP_SEC=0.22`; rerun Whisper after any stitch change.
- Narration loudness is controlled at longform mix, not by destructively editing cached TTS assets. Production starting point is `--narration-volume-db 2` with the final limiter enabled; use `3` only after a loudness/clip check passes. If narration still competes with music, lower score beds or drops before pushing narration harder.
- Visual planning must use current-scene facts only. Do not import neighboring context, stale refs, negative prompt wording, or characters not visible in the scene.
- The LLM is the creative visual author. Give it the story chunk, premise/bible context, approved refs, state contracts, current beat excerpt, and neighboring beat summaries needed to make the same character, location, composition, and ref decisions a hands-on agent would make. Deterministic production code must not creatively choose scene content, infer missing locations, add characters, rewrite action, or patch narrative intent.
- Visual prompt planning must consume `visual_beat_plan.json` when present. Semantic scenes are not image cuts; long scenes must be split into multiple visual beats before imagegen. Default beat pacing aims for an average near 8 seconds, minimum 3 seconds, maximum 15 seconds.
- Visual beats must carry local script excerpts or concrete beat actions. The LLM should author each image prompt from the beat excerpt, not from a repeated parent-scene summary.
- Visual prompt authoring is manifest-first. For every cut, the LLM must write `shot_manifest` before prose: `shot_job`, `visible_characters`, `mentioned_only_characters`, `primary_character`, `character_state_ref_ids`, `protagonist_state_ref_id`, `location_ref_id`, `foreground_action`, `visible_props`, `ui_elements`, `forbidden_ref_ids`, and `continuity_notes`. The prose prompt and `reference_requirements` must obey this manifest.
- Give the visual author the same useful context an agent uses: current visual beat excerpt/action, approved character state refs, relevant location/prop/UI refs, and previous/next beat summaries. Previous/next context is sequencing context only; it must not import characters, props, locations, or reveals into the current cut unless the current beat excerpt also includes them.
- The visual review pass must repair `shot_manifest` first, then repair prompt prose and refs. Deterministic sanitation treats manifest contradictions as validation issues before imagegen.
- Positive visual language is mandatory during LLM authoring and review. Reference anchors, character state refs, and authored scene prompts must describe what should appear, never what should be avoided. Creative guardrails belong in the LLM author/review prompt. Production sanitation only validates/sanitizes structure, refs, and paths.
- When a visual risk needs mitigation, convert it into a positive construction: write the exact garment, subject count, role, pose, frame composition, and visible action wanted.
- Required references must exist before image generation. Style ref comes first, then character/location/action anchors as needed; do not bypass missing reference requirements for production.
- Reference kinds have strict boundaries: character refs provide identity and wardrobe; location refs provide environment; UI refs provide interface design; action/effect refs provide effect shape, color, movement path, and interaction logic. Scene prompts provide the actual pose, camera angle, and current location.
- Character state references are produced before visual planning and are definitive for visual identity, wardrobe, and character state. Do not let visual planners infer wardrobe from ambiguous prose such as "gray suit"; use curated state-ref prompt anchors. For transformation arcs, separate identity from state: one approved base identity reference per character should anchor facial likeness only, while each later state contract dictates hairstyle, shave/facial hair, body shape, fitness, posture, wardrobe quality, cleanliness, wealth/status, and emotional bearing. Do not attach earlier overweight, injured, poor, dirty, weak, or young state refs as body/wardrobe references for later transformed states.
- Before image generation, the agent must manually review and optimize style, character, and key action reference prompts. Main character refs should specify identity, body type, hair, face, wardrobe state, and common model misread risks in positive production language. Character refs for scene conditioning must be single-person, single-pose, plain-background identity refs. Do not use multi-position sheets, turnaround boards, multiple face-angle grids, scene backgrounds, dramatic action poses, or composition language that can transfer into cuts.
- Generate references in a reference-only pass before scene imagegen, then inspect the files. Reject refs that contain panel grids, speech bubbles, strong scene backgrounds, cinematic poses, or any pose/background likely to carry into cuts. Regenerate failed refs selectively with `--reference-ids` instead of wiping the whole run.
- For ambiguous wardrobe states, avoid terms that trigger unwanted default garments. Use manually curated state-ref wording that describes the exact garment construction, neckline, fabric, silhouette, and production context in positive language.
- For multi-character scenes, references attach only from validated character_state_refs. Single-character shots should not attach another character's ref.
- Named human characters who physically touch, fight, shove, restrain, rescue, carry, or closely confront the protagonist must get standalone character refs before imagegen. Do not derive these identities from generated cuts; a bad first cut can poison the anchor.
- Scene reference attachment is authored by the LLM from the current beat: physically visible character refs first, then location, then prop/UI, then action/effects. Priority kind outranks required/optional flags, so a visible character ref is not displaced by a required lower-priority ref. Style refs are only attached to scene cuts when no concrete refs are available, because character, location, prop, and UI refs already carry style. For sanitized prompt plans, `section_image_prompts_hardened.json` is authoritative: imagegen must not infer or append extra character refs from stale `visible_subjects`, and it must not write runtime reference paths back into the prompt plan.
- When four visible characters consume all scene-reference slots, the LLM should keep the four character refs and report the dropped location ref in `reference_usage`; sanitation only enforces the four-ref cap.
- Continuous-location scenes should keep the active location ref attached across the whole location block when the beat physically remains there, not only on wide shots or scene starts. Dropping the hall/courtyard/location ref mid-scene causes location carry, layout drift, and style drift in long runs.
- Explicit venue words in the beat excerpt should guide the LLM's location ref selection. For example, "banquet hall floor" should keep the banquet hall ref even if the beat also mentions spirit rope or restraint.
- Offscreen sound/light from another venue must not override the visible location. A courtyard or side-corridor shot that mentions banquet hall glow, music, or sound cues stays attached to the visible courtyard/corridor location.
- Character aliasing must be resolved before imagegen. Descriptions such as "white-bearded elder," "patriarch," "envoy," "replacement heir," or "cousin attacker" must attach the matching approved character_state_ref when that person is a visible subject, especially in multi-character shots.
- Possessive name phrases do not imply a visible character. Object inserts such as "Mu-gyeol's mother's sword" should attach the prop/location refs, not Mu-gyeol's character ref, unless his body is actually visible.
- Memory/reflection beats should not put faces inside props. Stage memories as separate translucent silhouettes in open air near the object, with the object itself kept clean and readable.
- Childhood flashbacks need child-specific refs or no adult character refs. If child refs do not exist, stage the beat as child memory silhouettes with the current location ref only; adult refs contaminate age, wardrobe, and body shape.
- Ritual/document close-ups should use physical seal glow, ink, brush water, paper, and altar light before supernatural UI. Do not let a ledger/UI panel turn a prop insert into a screen shot unless the beat explicitly needs UI.
- If a cut shows subject fusion, miniature heads, duplicate protagonist faces, a face embedded in another body/prop, speech bubbles, or a UI panel covering a face, treat it as a generated-still failure. Regenerate the cut from a hardened prompt with explicit subject count, primary-subject focus, separate bodies, clean prop/UI placement, and a single continuous manhwa frame.
- Visual prompt planning must not create definitive character anchors. It may consume approved `character_state_refs`, select which refs are visible/style-critical for a cut, and report missing reference coverage as warnings or blockers.
- Image prompts that attach references must preserve positive Flux-style reference slot mapping through structured `reference_requirements.slot_order` and `slot_purpose`. The imagegen wrapper injects concise "Use image one as..." text at generation time, so authored scene prompt bodies must not duplicate those instructions. When `identity_usage` is `face_only`, attach the base character image only as a facial likeness/source anchor and write the visible transformed state directly in the scene prompt; the current prompt controls body, grooming, clothes, posture, and social status. The face-only anchor applies only to the named character. Attorneys, staff, crowds, coworkers, silhouettes, and other supporting figures must have distinct one-off faces and must not borrow the protagonist's face.
- `shot_manifest.forbidden_ref_ids` is authoritative. Any ref forbidden by the manifest must be removed before imagegen. `shot_manifest.location_ref_id` must match the attached location ref when set, and expected character state refs should be attached directly or through a declared face-only base anchor.
- If a cut physically occurs in a real environment such as an apartment, gym, office, street, shop, corridor, boardroom, lobby, stage, or courthouse area, the LLM must choose the closest approved location ref and set `shot_manifest.location_ref_id`. Sanitation should block physical-location prompts that omit both `location_ref_id` and a location reference instead of guessing the location.
- Flux Klein and Flux Kontext are both treated as four-reference models in this pipeline.
- Scene prompt bodies should request one continuous full-frame image by default, but intentional manga panel or split-screen layouts are allowed for montage beats, memory fragments, reaction stacks, parallel action, or UI-heavy reveals. Reference images guide identity, wardrobe, style, UI, props, and effects; they should not be described as visible reference panels, sheets, or background content inside the final cut.
- Image models should not be asked to render dense exact UI text. Scene prompts may request clean holographic panels, gauges, icons, simple labels, and at most one short large number or word when visually essential. Exact multi-line system text, captions, lists, and long labels belong in `ui_text_on_screen` for render/subtitle overlay.
- Scene images should not include baked speech bubbles, meme captions, or editorial title text unless the cut explicitly calls for a manga panel, broadcast card, phone screen, document, or UI insert. Subtitles and narration captions are render-layer responsibilities.
- Dialogue-heavy narration beats should be converted into silent acting prompts before imagegen. Stage the visible contempt, fear, refusal, or realization through posture, eyelines, facial expression, hand placement, prop action, and spatial blocking; do not ask the image model to visualize a "spoken line" or emphasize that someone says something loudly.
- Run visual prompt authoring and review in small parent-scene-aware chunks for both Codex and local Qwen. Codex visual authoring defaults to four-cut chunks with up to six chunk calls in parallel; scale throughput by concurrency, not by large single prompts. Large whole-episode prompt batches tend to collapse into repeated hero tableaux or incomplete JSON, while arbitrary chunks that split a scene without neighbor context hide the progression the LLM needs.
- Visual prompt review is the only LLM prompt-fix stage before imagegen. It may revise prompt wording and reference choices, but must preserve scene IDs, image IDs, timing, and source hashes. Code gates validate only structure, hashes, approved ref IDs/paths, forbidden refs, max refs, missing references, and unresolved blockers.
- Visual prompt sanitation runs after LLM review and before imagegen. The command is still `visual harden`, but production default mode is sanitation-only. It writes `section_image_prompts_hardened.json`, `visual_prompt_hardening_<episode>.json`, and `visual_prompt_hardening_sample_<episode>.md`. It validates approved ref IDs and paths, strips unknown or forbidden refs, enforces the four-ref limit, normalizes known non-creative unsafe UI label phrasing, and blocks unresolved manifest/ref contradictions. It must not creatively infer missing locations, add characters, rewrite action, choose shot jobs, insert staging clauses, or repair narrative intent. The old deterministic creative repair behavior is opt-in diagnostic mode only with `--mode repair`.
- Mixed-location scenes need beat-level location contracts from the LLM. Parent-scene continuity is not enough when a scene says "support workplace, then apartment"; each cut must lock the location from its own beat excerpt. Work/headset/manager/support-ticket beats attach or request the support-office ref, while kitchen-table/debt/fridge/home beats attach the apartment ref.
- Future-return/control beats outrank stale parent-scene locations during LLM authoring/review. If the beat says the transformed protagonist returns to the same building with attorneys, debt documents, creditor rights, board packets, or legal control, attach the current corporate tower, lobby/elevator, or boardroom location rather than carrying the earlier support-office/apartment location.
- Body-state proof beats in transformation stories should not repeat the next workplace/action shot. If the beat is about weight, shirt tension, grooming, posture, or visible physique, the LLM should stage a close body-detail or mirror/elevator/lobby composition that proves the current state before moving into the next job/gym/action location.
- Do not let location refs leak across cuts. If a workplace beat attaches an apartment ref or a home beat attaches a support-office ref, treat it as a prompt author/review failure before imagegen. Generic modern locations are opt-in from the current beat; do not use a parent scene's only location candidate as fallback when the beat itself is a montage, phone call, document insert, or abstract status beat.
- Montage parent scenes must be split into one present-tense physical location per cut before imagegen. If a scene summarizes apartment kitchen, dumpster exterior, and bedroom sleep, each cut should keep only the beat-relevant location and props; do not allow the whole montage to appear as panel grids or multi-time collages.
- Do not attach a character ref merely because the character is mentioned in a phone message, voicemail, document, profile, memory, or possessive phrase. Attach character refs only for physically staged characters in the current cut; otherwise stage the phone, document, or abstract memory effect.
- Do not attach confrontation characters during approach/setup beats before they are physically revealed. If the current beat is the protagonist entering a building, riding an elevator, carrying takeout, or hoping someone will remember him, keep the protagonist and approach location only; add the spouse/boss/rival refs only when the current beat shows them in the room.
- Phone, voicemail, cold-email, and remote-sales-call cuts may use intentional manga-style split panels when that improves readability. Keep panel roles controlled: the largest physical panel shows the local protagonist in the real current location, while small secondary panels show device close-ups, contact avatar icons, envelope icons, phone UI shapes, opportunity badges, or abstract call-flow cards. Do not stage the remote caller as a physical person, full portrait, separate office scene, or second character unless the script beat physically places that person in the room. The failure mode is uncontrolled panels that invent people, duplicate the protagonist, add speech bubbles, or turn a remote mention into a physical scene.
- Transformation stories need enough protagonist state refs to show trajectory. Do not reuse a rain-night/discarded outfit ref for later self-improvement beats. Add intermediate refs such as early discipline, emerging founder, and final owner when wardrobe/body state changes are part of the viewer promise.
- Every visual cut must have a concrete shot job from the beat excerpt: location establishment, object insert, interaction, physical action, emotional reaction, consequence, or transition. Repeated "character at desk with UI" prompts across adjacent beats are a prompt-plan failure even if the scene context is technically correct.
- Image generation uses ModelsLab Flux Klein by default. References are generated first and stored under `assets/images/references`; image cuts are stored under `assets/images`. Scene imagegen requires a hardened prompt plan by default; use `--allow-unhardened-prompts true` only for diagnostics. When ModelsLab returns a queue/rate-limit error, resume with lower `--concurrency` and keep `--force` unset so fresh refs and completed cuts are reused.
- Scene imagegen should consume `section_image_prompts_hardened.json`. For bad cuts, regenerate only the affected `--cut-ids` with cache reuse; use `--force-images true` when replacing scene cuts while keeping approved refs fresh, and use `--force-references true` only when intentionally rebuilding refs. After targeted regeneration, run one full imagegen pass to refresh the complete image report and confirm all expected cuts exist.
- Render should use the reviewed scene prompt artifact, the continuous mixed audio, and final-script subtitles timed to Whisper. Final MP4s must be upload-safe `yuv420p`; verify with `ffprobe` after render.
- Next throughput test: try higher concurrency on a fresh production run after prompt/ref quality is stable. Start at 6-12 workers, monitor queue/rate-limit behavior and output quality, then consider returning to 24 only if the provider remains stable.

## Current Production Models And Methods

- Source: polished narration prose from the operator/chatbot, with exact-hash script approval.
- Speakability: targeted-only by default; broad speakability is opt-in.
- Voice: narrator-only default through ModelsLab Qwen TTS using the locked Joel narrator clone.
- Timing: local Whisper word timing is production truth for subtitles, SFX, score, visual beats, and render.
- Audio planning: Codex or local Qwen only. If automated planner calls are unavailable, a Codex-agent manual plan may be written with explicit provenance, current source hashes, and Whisper timing.
- SFX generation: ModelsLab `/api/v7/voice/sound-generation` assets are allowed after a Codex/local-Qwen/agent-authored plan. SFX events must use locked asset paths before mix.
- Ambience generation: also ModelsLab sound-generation, represented as loopable SFX events with `recurrence_class: "ambience"`, `loop: true`, short generated `asset_duration_sec`, and longer timeline `duration_sec`.
- Score generation: prefer local ACE-Step 1.5 for moment score drops and any intentionally chosen chapter beds; current default local model pair is `acestep-v15-turbo` plus `acestep-5Hz-lm-1.7B`. Score drops are short Whisper-timed ACE-Step riser/hit accents for 20-35 drama, hype, reveal, and payoff beats, mixed by ducking the base score bed if one exists.
- SFX-only mix: use `--sfx-only true` during audio enrichment and `--skip-score true` during longform-bed when the story is stronger with clean narration and punctuation SFX instead of score.
- Image generation: ModelsLab Flux Klein, with positive-only prompts and explicit reference slot mapping.
- Render: one continuous mixed audio track, final-script subtitle text timed by Whisper, yellow subtitle text with a small black outline and no background box. Ken Burns motion is full-frame, profile-based, visible, and intentional by default: hook bursts, action pushes, reveal pushes, wide drifts, emotional holds, and steady pushes. Use blurred foreground drift only as a deliberate override. Transitions should be hand-picked by beat; do not default every scene change to fade-to-black. Use smooth FFmpeg transitions such as wipes, pushes, slides, flashes, and manga-panel swipes where they match the scene energy, with transition SFX bound to the actual transition on selected cuts, especially throughout the opening thirty seconds. Extract final QA frames and spot-check prompt/image/ref consistency before treating the render as publishable.

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

SFX-only audio variant:

```bash
node bin/goldflow.mjs audio enrich-sfx-score --channel <channel> --series <series> --week <week> --episode ep_01 --sfx-only true --sfx-target-count 45
node bin/goldflow.mjs audio longform-bed --channel <channel> --series <series> --week <week> --episode ep_01 --skip-score true --sfx-boost-db -4 --narration-volume-db 2 --outputBase ep_01-<channel>-qwen-sfx-only --reportSuffix -sfx-only
node bin/goldflow.mjs render start --channel <channel> --series <series> --week <week> --episode ep_01 --audio <episode-dir>/assets/audio/longform_mix/ep_01-<channel>-qwen-sfx-only.m4a --prompts <episode-dir>/section_image_prompts_reviewed.json --output <episode-dir>/assets/renders/<title>-sfx-only.mp4 --report-output <episode-dir>/render_report_ep_01-sfx-only.json
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

## Next Run Policy

- Treat the operator/chatbot-provided polished narration story as the candidate source of truth.
- Do not run broad enhancement by default. Use targeted speakability and readiness checks after approval, and only apply TTS-only overrides or explicitly approved script edits.
- Use narrator-only voice unless the operator explicitly requests character casting.
- Use local Whisper word timing before SFX, score, visual beats, subtitles, or render.
- Use local ACE-Step for production score beds. ModelsLab music generation is a fallback only when explicitly requested.
- Use the optional score-drop layer when the run needs retention accents: twenty to thirty-five Whisper-timed local ACE-Step riser/hit accents mixed by ducking the base score bed.
- For humiliation/system-finance stories, consider an SFX-only audio pass before committing to score. Clean narration plus selective SFX may retain better than continuous beds.
- For imagegen, prioritize reference quality and spot checks over raw throughput. Start concurrency around 6-12 on the next full run, then raise only after references and prompt quality look stable.
- Babysit the next run through staged visual gates before trusting full automation: manually review references, review the sanitized prompt sample, generate and contact-sheet the first small image batches, then keep periodic contact-sheet spot checks through high-risk sections. Do not treat imagegen as set-and-forget until several consecutive batches show no duplicate protagonist, subject fusion, destructive UI, wrong refs, or major location/style drift.
- If generation times out, count missing references/cuts and resume only those IDs with cache reuse. Do not force-regenerate completed good images.
- Keep narration competitively loud from the longform mix using `--narration-volume-db 2`, then verify clipping and intelligibility against score beds and drops.

## Worktree Discipline

Keep this repo small and revertable. Commit each migrated stage after syntax checks. Do not copy broad directories from the original repo.
