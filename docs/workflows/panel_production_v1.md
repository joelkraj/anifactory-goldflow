# Panel composition for original manhwa production

`panel_composition_v1` is an explicit render option for a **new** `manhwa_recap_v1` / `generated_visuals_v1` production identity. It uses the compositor exercised in the Joey editing experiment, with the official narration, approved-script captions, image acceptance, render report and final-QA path. Existing identities and private editing experiments retain their contracts.

The initial option locks 1920×1080 at 30 fps, narrator-only continuous audio, generated video disabled and parallax disabled. The timeline authors its own reveals and overlaps. Incompatible options fail before preflight creates an episode. This option supports original generated artwork; external recap ingestion into production remains a separate adapter.

## Starting the next run

Wait for the operator's final script. Lock the actual channel, series, stable run slug, episode, title, exact source, selected providers and production intent through normal preflight from clean committed code. Add these options to that complete preflight command:

```text
--content-profile manhwa_recap_v1
--media-workflow generated_visuals_v1
--render-profile panel_composition_v1
--audio-target narrator_only
--generated-motion-policy disabled
--parallax-policy disabled
--run-intent production
```

Use the identity's normal narrator and image provider selection. No provider or voice switch is implied. Never retrofit these fields onto an existing run. Read `run status` before continuing and after each completed stage; use its exact next command.

## Plan artwork before generation

After approved visual beats and reference images, the panel asset stage prepares a source-bound authoring packet and draft. An editor/agent groups only beats that can be told faithfully from the same artwork. Every unique artwork order names its owner beat, covered beats, visual brief and editorial reason; every beat keeps an explicit binding. There is no reuse quota, keyword grouping, or timer-based transition cycle.

`visual panel-assets --episode-dir <episode-dir>` prepares the draft. Author it against approved story and reference context, then use `visual panel-assets --episode-dir <episode-dir> --plan <authored-candidate.json>` to validate and import it. This is editorial work for the operating agent; the user need not fill a JSON template.

Visual prompt planning authors only unique artwork orders, with their covered beats as context. The validated plan expands those orders back into the original beat IDs and timing. Reused rows do not receive provider leases or creative submissions. Materialization records the exact source asset and plan hash, zero generation cost, and separate per-beat acceptance. Missing or failed source art stops that scope; it never silently becomes a fresh paid request. Ordinary wavefront prefetch is disabled for this first profile because it can dispatch before allocation is complete.

If an import is interrupted after a source image was accepted, status can select `imagegen panel-reconcile --episode-dir <episode-dir>` to restore missing derivative panels and their ledger rows with zero provider calls. A failed source image is repaired by its exact owner ID. Changed or conflicting accepted bytes stop for triage.

Measure savings as unique scene artwork orders versus covered beats, then compare actual provider receipts. Reference images still have their own cost. Do not claim a savings percentage from the three-minute experiment, which reused artwork already generated for an earlier edit.

## Author composition after image QA

The normal motion-edit stage becomes `visual panel-plan` for this profile:

```bash
node bin/goldflow.mjs visual panel-plan --episode-dir <episode-dir> --action prepare
node bin/goldflow.mjs visual panel-plan --episode-dir <episode-dir> --action compile --recipe <authored-recipe.json>
```

Preparation writes `panel_composition_packet_<episode>.json` and `panel_composition_recipe_<episode>.json`. The packet includes exact narration excerpts, original Whisper indices, beat boundaries and accepted artwork. Inspect the artwork and author every decision. Blank or missing decisions cannot pass.

Layouts are `full_frame`, `inset`, `reveal`, `reaction_pair` and `page_pan`. Crop, placement, entry direction/time, overlap duration, camera path and reading holds are explicit. Main panels stay bound to their current beats. Background/context panels may carry earlier artwork forward; a later panel cannot be disclosed as context before its beat. The compiler preserves all internal beat boundaries and keeps source, caption and spoken text separate.

Compilation writes the official `panel_timeline_<episode>.json` and `panel_composition_plan_<episode>.json`, plus immutable candidate snapshots. Current script approval, narration, word timing, grouping approval, allocation, hardened prompts, accepted images, focal analysis, review decisions and per-cut ledger are hash-bound. A changed source or recipe invalidates its dependent plan. Recipe corrections recompile through the guarded stage, preserving earlier snapshots.

## Render and review

Continue through the exact `run status` render command. The panel backend supplies silent picture to the existing render path. Script-faithful captions, one continuous final audio master, final mux, upload-safe encoding and `goldflow_render_report_v2` remain authoritative.

Picture caching uses absolute frame ranges and only artwork/keys affecting each range. It preserves interpolation across chunk boundaries. Changed composition rebuilds affected chunks; narration is never cut into chunks. Private proof outputs cannot satisfy the production render stage.

Full production timelines are independent of the private workbench's 30-minute limit. The production backend validates an 80-minute timeline and renders up to four picture chunks concurrently, retaining source order before concatenation and a single continuous audio mux. Each chunk retains its own verified lossless cache. A failed chunk stops admission and preserves completed chunks for the normal reviewed render recovery.

For Fal Sunburst, use the supported early visual fork after the approved nonvisual/beat baseline. The resulting new Fal identity retains the panel contract and generates its references through the Fal adapter. Validation and bulk dispatch select only authored unique artwork owners. Finalization verifies each owner's Fal result receipt and raster, writes allocation-bound metadata, and materializes every reused panel locally with zero additional provider calls. Native per-beat image acceptance still checks all aliases; a paid owner-only completion cannot satisfy a missing or changed panel alias. The ordinary `imagegen panel-reconcile` route can restore lost derived aliases from current accepted owners.

After an exact reviewed Fal owner repair, reviewed-bulk finalization refreshes that owner's metadata and dependent panel copies in the new repair output directory. Only those ledger rows return to pending image QA. Prior rasters and unrelated metadata, results and QA remain unchanged. An alias-specific rejection still requires review of its allocation and finding before any paid owner regeneration; it is not an automatic repair order.

If the first edited face-reference probe copies its source board instead of producing the approved single-person plate, record an actual rejection in `fal/reference-probe-review.json` (`goldflow_fal_reference_probe_review_v1`). Bind the source, identity, native reference plan, provider reference plan, rejected assignment/raster and exact unsubmitted same-identity variant IDs. Status holds all other references and directs preparation, one budgeted same-model repair, observation, and actual visual review. This appends only the single-figure output instruction and preserves the original identity input. After inspection, `review-reference-probe-repair --reviewer <name> --note <actual review>` binds the accepted raster and updates only those unsubmitted variants to use that clean identity plate. Original assignments and rasters remain archived; no submitted variant, unrelated reference, approved creative plan or provider may change. A failed repair stops for triage, and neither technical completion nor the probe decision approves the complete reference set.

Panel composition accepts the original timing identity only through that verified early Fal carryforward. It checks the immutable restart receipt, original baseline identity, unchanged nonvisual contract, approved status-snapshot hash, and exact original and copied timing bytes, and adds those dependencies to the composition provenance. An unrelated, changed or chained timing identity cannot use this route. Narration and timing are not rewritten or regenerated for the visual fork.

Review the opening with sound and sample dialogue, revelations, action, reused-art transitions and later sections. Check face crops, reading time, disclosure order, captions and synchronization. Run normal final QA after playback review. Fixture tests do not approve an episode. Packaging, upload, release and comment gates remain separate.
