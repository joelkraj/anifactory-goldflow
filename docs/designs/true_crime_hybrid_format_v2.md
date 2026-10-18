# CrimeDungeon — existing material and cutout recreations

**Current working direction, September 8, 2026. Full production remains a design; the [bounded private proof adapter](../workflows/true_crime_proof_workflow.md) implements documentary excerpts, illustrative cutouts and local narration.** Supersedes the request-dependent production recommendation in the [v1 archive format](true_crime_archive_format_v1.md) and [first proof proposal](../../research/chandler-halderson-development/proof-to-first-upload.md). The user wants most uploads built from existing footage, documents, original audio and recreated presentation, including the cutout treatment being developed for the movie/what-if pipeline. **CrimeDungeon** is the working channel name; no channel account exists yet.

## Production model

**September 9, 2026 clarification:** CrimeDungeon's intended upload format is footage-led: open on a compelling recording and let recorded scenes carry much of the film, with original dialogue where it advances the story. Use full-screen footage for encounters, framed footage when a comparison or geographic explanation needs it, and documents, text, maps and cutout recreations as supporting passages. The user accepted this correction after reviewing [the Sinister End reference selection](../../research/crimedungeon-footage-reference-2026-09-09/README.md). The earlier document/cutout proof demonstrates an explanatory insert, not the complete target format.

The user's final clarification makes **the compelling viewer premise and package the starting point, with duration earned by the story and available material.** Ten-minute films, longer documentaries and hours-long treatments can all qualify; no fixed duration tier or minimum amount of extended footage governs discovery. Test the premise against actual source scenes, design the title and thumbnail around its promise, then develop the edit to its appropriate length. Overlapping copies and dead time are not additional coverage.

The [CrimeDungeon editorial standard](crimedungeon_editorial_standard_v1.md) records the user's ambition to beat the references in hook, pacing, rehooks, retention design, segmentation and conclusion. Thumbnail direction is a compelling actual-footage moment with minimal or no wording and restrained overlays. Compare actual cuts against the strongest relevant reference passages; measure audience performance after release rather than inferring private retention from view counts.

Choose cases whose available evidence can sustain a strong package now. Existing footage and audio, public documents, photographs, maps and source-backed recreations are the normal materials. Records requests can develop future exclusives or improve an asset; they are optional and must not become the default dependency for every upload. The previous request-dispatch question is withdrawn by this change in direction. No outreach is authorized or planned by this document.

Keep the Dr Insanity-inspired investigative progression: a specific hook, clear account, evidence that develops or tests it, and a verified outcome. Let the material determine how each scene is presented. No minimum percentage of bodycam, original interview footage or generated video applies.

Pacing should keep the investigation moving through narration and evidence. Let viewers read document highlights while the narrator explains them. The user's review of the first private cut rejected its long silences between narration sections: seven added reading holds had contributed 30 seconds. The next review edit removes almost all of those holds, retaining natural speech boundaries, a brief document-reading beat and a short ending settle. Future CrimeDungeon edits should justify an extra silent hold by a specific moment that needs it, and should not add silence to meet a duration target.

The September 8 [reference-edit comparison](../../research/dr-insanity-proof-edit-review-2026-09-08/README.md) led to a completed 64.4-second supplemental picture/sound candidate. It improved focal points and evidence reveals but retained continuous narration and no original footage scene. The September 9 direction above corrects that format mismatch. Keep those records as the history of an explanatory insert; future proof selection begins with available source scenes and writes narration around them. The existing candidate and its locked script/identity remain unchanged.

| Available material | Presentation |
|---|---|
| Useful existing video | Selected contextual excerpts with their original audio where useful; full frame or a readable evidence card |
| Original audio without useful video | Speaker identification, waveform, document/map or clearly illustrative cutout scene; preserve the audio's original status |
| Exact checked transcript or quotation | Labeled recreated reading, bound to the cited words; actor/designed voice or deliberately selected voice reference |
| Report describing an exchange without exact words | Narrator paraphrase over the record or an illustrative scene; do not turn a summary into a purported verbatim quotation |
| Photographs, documents and maps | Crops, highlights, measured pans, timelines, comparisons and cutout staging tied to supported facts |
| Missing visual coverage | A clearly identified illustration/reconstruction with modest layer motion; source facts still govern what happens |

Online availability is a discovery advantage, not a blanket reuse grant. Record the applicable use basis for the selected asset. A creator's upload can locate underlying material; our edit, commentary and factual work must be our own. One unavailable file can be replaced with another supported presentation without inventing evidence or delaying every episode for a new records request.

## X and TikTok footage discovery

Include X and TikTok as regular inputs for finding cases and locating material for cases already in development. Social posts can supply original eyewitness recordings, agency releases and other useful excerpts, or lead to longer recordings elsewhere. A platform is a discovery location, not a provenance or reuse classification.

Prioritize a repeatable creator network over collecting unrelated viral clips. Start from the [verified creator shortlist](../../research/crimedungeon-social-sources/creator-shortlist-2026-09-08.md), then measure how often sampled posts lead to a named case, longer contextual recording and supporting records. A cross-linked publisher account is a stronger identity lead than a matching display name; neither alone establishes recurring sourcing success.

Use this intake sequence:

1. Save the permalink, account, caption, discovery date, displayed posting date, claimed incident date/location and the story question. Keep posting and incident dates separate.
2. Trace reposts, watermarks, attribution and source links to the recording's owner and the longest useful available version. The earliest upload located is not necessarily the original. Group reposts as one source family rather than treating them as independent corroboration.
3. Check the incident and outcome against primary records or attributable reporting. Captions, comments and Community Notes provide leads; they do not establish a charge, dismissal, conviction or chronology on their own.
4. Review picture and sound separately. Identify crops, missing context, publisher narration, added music and recreated audio. Prefer a cleaner source when available. Extracted or isolated sound is not proof of an authentic original recording.
5. Before selecting an excerpt, record its source, exact time window, supported claim, audio origin and applicable use basis. Acquired files additionally need method and hashes under the eventual media workflow. Public availability or a download control is not blanket reuse permission.

Score the case for a clear hook, investigative progression, checkable outcome and enough existing material to sustain a package. Score each asset separately for provenance, context, intelligibility and reuse basis. A viral clip alone does not establish either score. Preserve useful vertical footage in a readable frame alongside documents, maps or cutouts rather than cropping away essential action or timestamps.

The first [social-source lead](../../research/crimedungeon-social-sources/README.md) demonstrates an X post leading to a 26:39 third-party YouTube presentation. This is research intake, not an implemented automated scout or a registered production route.

## The actual movie/what-if reference

Inspected the task titled **Add movie scene recap cuts**, its current renderer and retained Sentry review outputs. The task reader exposed status but no message bodies; visual conclusions below come from actual saved QA frames and the corresponding code.

- Source proof: `sentry-full90-v2`, 1920×1080, 30 fps, 90 seconds, status **awaiting_program_review**, official stage not completed. This is an existing review candidate, not final approval of that movie episode.
- Actual frames inspected: `07_interception_application.png`, `14_doom_long_route.png` and `06_sentry_film_spotlight.png` in `/Users/joel/AniFactoryData/channels/joel_proofs/weekly_runs/sentry-doomsday-pilot/revisions/script-v3/episodes/ep_01/pilot_program_reviews/sentry-full90-v2/`.
- Visible treatment: photographic/art cutouts with a light outline and soft shadow, clear separation of people/objects, cream/red/blue textured presentation boards, short headings, arrows and framed footage.
- [Program compositor](../../scripts/lib/avatar-pilot-program-renderer.mjs) authors independent entrances, lateral movement, settles, scale changes and object/label movement at exact frame cues. [Style primitives](../../scripts/lib/avatar-pilot-style-preview-renderer.mjs) supply alpha mattes, outlined stickers and placement.
- The current background boards are fixed. A generic group-camera or moving background transform is a new capability, not something verified in these frames. The movie recipe has headings but **no dialogue-caption track**; true-crime dialogue captions must be added.

Apply these presentation mechanics to CrimeDungeon: source-derived suspect portraits, an appropriate officer image or clearly illustrative officer silhouette, independently placed objects and a room/map/document background. Use a consistent lighter outline and restrained shadow if appropriate to the crime format. Character entrances, speaker emphasis, object reveals and modest position/scale changes should explain the scene. Lip-sync is not required for this first treatment.

Use readable spatial staging. A location or action placed in a scene must either be supported or presented as illustrative; a composed room is not an authentic crime-scene photograph. Do not invent a suspect's expression or incriminating action to create a reaction beat. Keep reconstruction labels visible and distinguish a conceptual movement from a verified route.

## Qwen and recreated audio

**September 9 user clarification:** include labeled AI audio recreations as a deliberate scene type, with timed transcript phrases, speaker identification and optional restrained analog/VHS texture. The [segment picture and sound specification](crimedungeon_segment_style_v1.md) defines this treatment and the associated footage, document, map, chapter, reconstruction and ending treatments. It separates verified reference observations from our proposed effects. This design direction does not expand the existing narrator-only private proof adapter or select a specific real-person clone.

The local Qwen runtime already exists. The read-only audit verified the configured arm64 Python environment, `mlx-audio 0.4.6`, `mlx 0.32.0`, the pinned Qwen3-TTS 1.7B Base 8-bit snapshot files and the existing owned Joel reference assets. No model was loaded and no audio was generated in this audit. Large model weights were checked for existence/size, not rehashed in full.

The [current provider adapter](../../scripts/lib/narration-provider-adapter.mjs), [local worker](../../scripts/tts-local-production-runner.py) and [quality contract](../workflows/narration_quality_v2.md) provide a useful foundation. Existing production is tied to pinned narrator identities; it is not already a general suspect/officer cast switcher.

Add an explicit cast per project or scene: narrator, reconstruction voice A, reconstruction voice B. Each generated line binds its source text, role, voice/reference provenance and output. Keep original recorded audio separately identified. The user has suggested local Qwen and voice cloning. The initial private proof uses the existing owned Joel narrator as a working choice pending listening; no permanent CrimeDungeon narrator or suspect/officer clone has been selected.

Qwen Base supports reference-based voice cloning. Its separate VoiceDesign model can create character voices, but that model's local installation was not established. The current Base adapter has no effective per-line instruction/emotion or native-speed control; do not promise acting tags will change its performance. Reference delivery and text construction need auditioning. [Official Qwen model and voice documentation](https://github.com/QwenLM/Qwen3-TTS).

Prefer a deliberately cast set of owned/designed voices for the first recreated exchange. If a real person's voice is intentionally matched, record that choice and its reference/use basis, and clearly disclose the reconstruction. Label transcript readings **AUDIO RECREATION — FROM [SOURCE]**. A paraphrased passage stays narrator speech. No invented confession or new evidentiary quotation should be attributed to a real person.

YouTube requires disclosure for realistic AI alterations that make a real person appear to say/do something they did not or generate a realistic event that did not occur. Incorporate the applicable AI-use disclosure alongside scene-level labels. Disclosure itself does not make an inaccurate statement true or clear source rights. [YouTube disclosure guidance](https://support.google.com/youtube/answer/14328491?hl=en).

## Reusable engine, separate factual workflow

Extract the reusable layer compositor through reviewed code rather than copying Sentry-specific choreography, character assets, captions or story heuristics. Required scene types are archive video, archive audio with authored picture, document/map, cutout reconstruction and narrator bridge. Audio origin and picture origin need independent fields: original audio can play over recreated pictures, and recreated audio can accompany a document.

Add generic layer order, position/scale/rotation/opacity keyframes, independent and grouped movement, captions and persistent disclosure overlays. Multi-person extraction needs separate masks: the current Vision helper selects all foreground instances together, which is unsuitable for independently moving two people unless they are separately segmented. Separate portraits on an authored background are the simplest initial assets.

The existing source-footage workflow remains reserved. This hybrid design does not inherit manhwa generation requirements, movie 3–5-second limits, an avatar host requirement or the movie proof's 90-second identity. Its own identity must bind the actual source/voice/scope before media execution. Shared rendering and Qwen components can be reused through an applicable new adapter while preserving existing runs.

## Revised proof and route to upload

**Recurring direction:** use the [CrimeDungeon house style and editorial process](crimedungeon_style_bible_v1.md). The Halderson-specific proposal below is retained as historical development context, not an instruction that every new case must make that proof or use its duration. Current case selection, viewer promise and supported workflow govern each new packet.

The next editorial proof should be **approximately two minutes**, centered on one Halderson account and its evidentiary context. It should demonstrate existing material, an evidence detail, a cutout scene and Qwen/source-audio handoffs. Use the [hybrid proof brief](../../research/chandler-halderson-development/hybrid-proof-v2.md). The exact duration freezes after source/text selection; this is not a render command or permission to force-fit speech.

Once the short treatment is accepted, assemble a longer scene and then the first full episode from the available evidence. Review source context, factual claims, original contribution and the complete picture/sound. Source footage and cutout animation are ingredients; the original investigative story and explanatory edit provide the value. YouTube distinguishes substantive commentary/editing from minimally changed or repetitive reused material. [Monetization guidance](https://support.google.com/youtube/answer/1311392?hl=en).

Complete the applicable production/packaging adapter before a full production run. Final QA, exact package review, first private upload and explicit public/scheduled release remain the existing destination gates. The public channel can be created later; local development uses CrimeDungeon as its placeholder.
