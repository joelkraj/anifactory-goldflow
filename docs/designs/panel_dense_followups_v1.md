# Dense pages: follow-up tracker v1

Decision (Joel, 2026-10-20): dense 3840 pages are the panel-production direction. They proved better and cheaper on the gala chapter: 5.09 beats per image at $0.0262 per page.

This tracker lists the ten agreed follow-ups. Each item lands as a reviewed, tested commit on `claude/panel-multizone-pages-v1`, and this file is updated in the same commit.

| # | Item | Status | Commit / evidence |
| --- | --- | --- | --- |
| 1 | Several shots per beat: 2–3 authored crops of one zone within a long beat | **done** | Optional `cuts` on inset, full_frame and page_pan decisions: at most 2 cuts, each shot at least 1.2 s, all from the same main artwork. The author validates each cut and snaps its rect, and the compiler turns cuts into sequential derived-crop layers. Not yet exercised by a real author run. |
| 2 | More cuts between zones of the same page (reaction pairs and contexts across siblings) in the author prompt | **done** | The author prompt explains sibling zones (a shared `page_asset_id`) and prefers reaction_pair, reveal or a cut against an already-shown sibling. Earlier siblings from previous chunks are offered as panels; they add aliases, not extra images. Later siblings are never offered. |
| 3 | Impact beats: an authored screen-shake window and quick cut bursts | **done** | Optional `impact` (0.15–0.6 s, amplitude 0.004–0.03) inserts a decaying linear shake into a held main shot and settles back exactly. Cuts that overlap the 1.5 s after an impact may be as short as 0.35 s, but the last shot keeps the 1.2 s minimum. The author prompt keeps impact for real blows only. |
| 4 | Snap author rects to the crop aspect deterministically (removes manual fill reconciliation) | **done** | `snapPanelAuthorRects` in the native author, with snaps recorded per chunk. All 3 gala chunks that had failed pass with it. |
| 5 | Garbled-text detection on zone crops, routed to crop-out or zone repair | **done** | `panel-zone-lettering.mjs`: tesseract (psm 11) reads each zone crop whose section requests lettering, and the result is aligned with the requested text. A finding means an extra word echoing a requested one (a doubled or misspelled repeat). It adds the `zone_lettering_garbled` risk reason, so the beat needs manual review: crop out, or reject for zone repair. Gala check: all 3 known garbles flagged and 0 false positives across about 53 lettered zones (dense and 1920). Unread text is recorded but is not a risk (tesseract misses about 40% of stylized bubbles). Missing OCR never blocks. |
| 6 | Cast rule: exactly the named characters, no lookalikes; anonymous passive background population stays welcome; no unrequested text | **done** | A fixed cast sentence in every page frame, plus a blocking `page_cast_anchor_missing` check. The gala dense plan still passes (only the known offer-card lettering finding). |
| 7 | Dense page allocation planner: templates, caps, ~5 beats per image target, full episode | **done** (tuned: 4.84 beats per image) | 7a: page canvas carried from allocation to Fal (`887cbee`). 7b: allocation-time constraints and caps (`panel-page-allocation.mjs`). Only required person/location references can block a page. The proven gala plan gets only accurate warnings. 7c: native planner `visual panel-assets --action author-dense` (`panel-page-allocation-author.mjs`). It works in scene-whole chunks of about 40 beats, validates each chunk structurally and against the caps, and writes a candidate for the normal `--plan` import; it never imports. 7d: dry run on coma-healer (`docs/proofs/dense_allocation_dryrun_coma_healer_v1.md`): 214 generations at 4.05 beats each, no blockers, about $5.4 against $11.58, with 28 planner calls and no Fal. Tuned with per-scene budgets (`9b9fdf5`): 179 pages and 0 singles at **4.84** beats each, about $4.7, all 26 chunks valid first time. |
| 8 | Smaller reference board cost test (1024×576 versus 1920×1080) | pending | |
| 9 | Reference trimming (124 → 84) and derived-reference promotion (design §1 and §3) | pending | |
| 10 | Review and PR the branch onto its base | pending | |

## Notes

- **Item 6 (corrected).** A blanket "no one else" would empty public places, so it is not the rule.
  - Named or recognizable characters are exactly those the section lists, with no lookalikes and no extra people performing story actions.
  - Anonymous background people may appear where the location implies them. They must be passive and visually distinct from the named cast.
  - Signs, labels and captions appear only where a section requests them.
