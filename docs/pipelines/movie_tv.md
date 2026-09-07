# Movie and TV Editorial Guidance — Full Production Reserved

This guide defines the intended editorial boundary for movie/TV recaps and criticism. Read [the private footage clipping workflow](../workflows/footage_clipping_workflow.md) before using its standalone library commands.

## Explicitly Not an Operational Production Lane

`movie_tv_commentary_v1` is a reserved editorial ID. It is not a registered operational planner/content-profile JSON. `source_footage_v1` is the corresponding reserved media workflow. New episode preflight and production for this combination are blocked pending an implemented, validated artifact chain. Supplying these names does not create an episode, enable a source planner, skip image gates, or authorize provider spend.

Do not work around the block by selecting `manhwa_recap_v1`, selecting `generated_visuals_v1`, calling production scripts directly, or using a workflow bypass. A movie/TV lane needs its own source-footage contracts; the generated-image registry must not silently masquerade as that workflow. Historical identities without `media_workflow` remain legacy generated-visuals identities, not movie/TV runs.

## What Is Available Now

The standalone `goldflow footage` commands can use explicitly supplied local MP4/MKV files or supported exact files in the operator's TorBox/Real-Debrid account, bind source identity, search supplied local subtitles, and extract bounded 3–5 second clips. Silent output is default; retaining the first source-audio track is explicit. Account/file availability, byte/time budgets, and provider terms still constrain the operation.

All source, search, clip, and approval artifacts remain in the private footage library, outside episode directories. `footage approve` is a hash-bound library review and retains `production_eligible: false`. It does not approve a recap, satisfy a Goldflow episode stage, grant reuse rights, or authorize publishing. Neither API key provides a universal movie catalog; no movie discovery or automatic acquisition is implied.

## Bounded Avatar What-If Pilot

The operator has authorized one exactly 90-second, non-publishing avatar-and-footage pilot. Its creative requirements are in [the avatar what-if pilot design](../designs/avatar_what_if_pilot_v1.md); the first subject is [MCU Sentry mastering his powers before Doomsday](../briefs/sentry_doomsday_90s.md). Read both and [the pilot workflow](../workflows/avatar_pilot_workflow.md). The separate `mcu_what_if_pilot_v1` / `avatar_footage_pilot_v1` route now supports guarded proof identity and script/evidence approvals, with implemented local asset/timeline/compositor handlers downstream. Narration entry remains explicitly blocked until canonical text/audio lineage import is fixture-proven. New narration synthesis and automatic media generation are not implemented. Full-length production and publishing remain disabled.

This format uses the owned Joel clone as an assured, audience-facing analyst narrating a reasoned alternate encounter, reviewed 3–5 second movie excerpts primarily in moving cards, an original reusable host pose/background library, and optional clearly identified AI concept imagery/motion. The current direction demonstrates opinion through concrete decisions and consequences, without requiring question-heavy conversation. Historical identities retain their embedded direction. Gemini/Flow are selected for all generated stills; Flow/Veo for selected hypothetical sequences. Explicit silent excerpt loops are supported with the bounded pilot limits; motion/looping is not a rights determination. It does not inherit manhwa cadence, obligatory generated scenes, or a comic-book power set. The synthetic compositor fixture proves layout/audio behavior, not a completed Sentry pilot or narrator quality.

## Intended Editorial Contract

- Identify the exact film edition or series, season, episode, release, language, and source file. Preserve source/file IDs, hashes or declared identity limitations, and source timestamps. Never substitute another edition or provider silently.
- Subtitle matching locates dialogue candidates only. It cannot prove the visual action, synchronization, shot boundary, narrative context, or best edit. Preview the exact scene and explicitly adjust offsets/timing; silent action needs another reviewed locator.
- Keep two clocks distinct: source timestamps locate the excerpt inside the exact movie/episode file; finished-video timestamps place that excerpt against the new narration and edit. A subtitle offset or frame-rate scale corrects source synchronization only—it does not assign an output-timeline position. Preserve both intervals and their explicit mapping in any future edit contract; narration/Whisper timing must not overwrite source timecodes.
- Write original commentary or criticism with a clear purpose for each excerpt. Keep plot facts, quoted dialogue, interpretation, and opinion distinct. Do not invent scenes, quotes, motivations, or facts to fit a generated-fiction template.
- Review the rights/access basis and intended use for each source and excerpt. A provider subscription, an official trailer's availability, or a 3–5 second duration is not automatic permission to download, republish, or monetize it. Record the operator's basis without claiming the program made a legal determination.
- Decide source-audio retention per excerpt so dialogue, music, commentary tracks, and the new narration do not conflict. The current helper selects only the first source-audio track when explicitly requested; it has no alternate-language selector.
- Keep clip inspection, subtitle synchronization, editorial acceptance, rights review, narration approval, timeline binding, final QA, and publishing decisions distinct. A technical extraction pass is not editorial or release approval.

## Work Required Before Production Can Be Enabled

A future implementation must define and test the source-footage stage registry and versioned workflow contract; exact-source/subtitle/clip lineage; bounded source acquisition and caching; original commentary approval; timeline/cut/audio contracts; clip rights/editorial decisions; render integration; final QA; and profile-appropriate packaging/publishing gates. Approval invalidation and exact-scope repairs must preserve accepted work and historical evidence.

For full-length movie/TV work, use only the standalone library operations explicitly requested by the operator until that lane is implemented. The separate bounded proof may follow its dedicated commands and approvals. Do not run `source manufacture` for movie/TV work or treat a library clip as production footage automatically.
