# Multi-zone panel pages v1 (design proposal)

Status: **design only — not implemented, not approved.** Nothing here changes current production behavior, existing run identities, or the coma-healer episode. Production behavior changes only through reviewed code, documentation and tests on the guarded artifact path (see `AGENTS.md`). No provider, planner or production command was run to prepare this document; every number below is computed from artifacts already on disk.

Scope: `manhwa_recap_v1` + `generated_visuals_v1` + `render_profile: panel_composition_v1` with the Fal Sunburst image route (`docs/workflows/panel_production_v1.md`). It does not touch other content profiles or media workflows.

## Goal

Cut generated images per episode by about half, along with the per-image review load, without losing identity continuity and **without changing the current panel presentation**. Pages are a generation-side efficiency: the composer keeps its existing layouts and simply crops each zone. Three changes do that, listed here by how much they save:

| Change | What it removes | Coma-healer effect |
| --- | --- | --- |
| 1. Multi-zone pages | One Fal request yields 2–4 croppable zones instead of one artwork | 658 → ~323 scene generations (−51%) |
| 2. Reference trimming | Standalone refs for subjects that appear on only one or two pages | 124 → 84 generated refs (−32%) |
| 3. Derived-reference promotion | Prompt-only subjects drifting across their 2–3 pages | No count change; it protects continuity for subjects that change 2 removes |

Change 2 saves little money (refs cost about $0.006 each). Its value is fewer reference approvals and fewer `manual_review` holds. The image count comes down mainly through change 1.

## Baseline: coma-healer (`2026-W43-coma-healer-fal-panel-v1/ep_01`)

Measured from `visual_reference_plan.json`, `section_image_prompts_hardened.json` and `panel_composition_recipe_reviewed_v3_ep_01.json`:

- 867 visual beats in 83 scenes. 658 unique artwork owners (`provider_submission_required`) and 209 zero-cost aliases (`reuse_prior_approved`).
- 127 reference targets: 124 `standalone_ref` (66 character states, 37 locations, 17 props, 3 UI, 1 action) and 3 `manual_review`. One generated ref (`hospital_elevator_approach`) is never attached to any owner cut.
- Ref slots per owner: 0 → 34, 1 → 143, 2 → 267, 3 → 172, 4 → 42.
- Owners per scene: median 7, p90 13, max 16.
- Composer layouts: inset 486, reveal 202, full_frame 124, page_pan 28, reaction_pair 27.
- Composer source crops are already partial: the median `source_rect` area is 0.52 of the artwork, and 24% of beats use ≤ 0.30 of it. Effective magnification (displayed px × zoom ÷ source px) is ≤ 1.0 for the median beat, 1.28 at p90 and > 2.0 for 4% of beats.
- Cost (from the brief / Fal billing): refs ≈ $0.76 (≈ $0.0061 each), scene artwork ≈ $11.58 actual (≈ $0.0176 per `edit` request at `quality: low`, 1920×1080), $12.35 total. QA flagged 331 risk cuts.

The 658 owners are mostly one artwork per beat cluster, and the composer then shows about half of each image. With pages, those halves become zones of one request.

## 1. Reference trimming rule

### Current behavior

`reference_budget.profile = llm_full_selection_v3`: the global LLM director's full selection is the library, and code never prunes it. The only cap is four refs attached per cut. That policy stays. This proposal changes **what the director is asked to select** and adds a structural validator. It never prunes the director's output after the fact.

### Proposed rule (director contract + validator)

A target may be `standalone_ref` only if at least one of these holds, with the evidence recorded on the target:

1. **Recurs across scenes:** it is attached to owners in **≥ 3 distinct scenes**.
2. **Identity-critical base:** it is the base facial identity of a canonical character whose states, taken together, appear in ≥ 2 scenes. Every recurring named person keeps one clean identity plate, so wardrobe and condition states can always re-anchor on it.
3. **Recurs across pages:** after page allocation, it appears on **≥ 3 projected pages**. About 7+ owner uses at 3–4 zones per page qualifies. This keeps single-scene subjects that a long scene spreads over several pages, such as a conference room used for 13 owners.

Everything else is `prompt_only`: a textual description (the existing `scene_prompt_anchor` / location contract) carried in each zone brief. Two tiers apply:

- **Used on exactly 1 projected page:** prompt-only. The single generation keeps it coherent within the page.
- **Used on 2 projected pages (about 4–6 owner uses):** prompt-only, marked `derived_promotion_candidate: true` (see §3).

Each director target gains `selection_basis` (`cross_scene` | `identity_base` | `cross_page`) plus counts. The validator rejects a `standalone_ref` whose recorded basis is false against the beat/allocation inputs, and the director must re-author it. Code never downgrades it silently. `manual_review` / `source_only` behavior is unchanged.

**Ordering consequence:** basis 3 needs the page allocation, which today runs after reference approval. Two options:

- Run a **provisional allocation pass before the reference plan.** Allocation only needs approved beats, so this is possible.
- Or evaluate basis 3 with the proxy "≥ 7 owner-candidate uses in the beat plan."

The proxy is recommended for v1: there is no stage reorder, and the count is reconciled after allocation as a non-blocking report.

### Coma-healer projection

| Bucket | Count | Notes |
| --- | ---: | --- |
| Kept: ≥ 3 scenes | 64 | 27 character states, 21 locations, 14 props, 1 UI, 1 action |
| Kept: identity base of a recurring character | 9 | e.g. base plates for characters whose states each sit in < 3 scenes |
| Kept: ≥ 7 owner uses (≈ ≥ 3 pages) | 11 | `loc_sam_firm_conference_room_ref` (13), `firefighter_spinal_recovery` (12), `vanessa_brunch_host` (9), `vanessa_after_necklace_surrender` (9), `loc_clinic_back_room_ref` (9), `joey_paper_gown` (8), `vanessa_gala_emerald_silk` (8), `linden_porch_threshold` (8), `loc_emergency_hearing_room_ref` (8), `marcus_camel_coat` (7), `loc_hotel_private_room_ref` (7) |
| **Generated refs** | **84** | was 124 |
| Prompt-only, derived-promotion candidates (4–6 uses) | 16 | e.g. `vanessa_opening_visit`, `richard_gala_stroke`, `loc_city_bus_ref`, `loc_gala_coat_check_ref` |
| Prompt-only, single page (≤ 3 uses) | 24 | one-off patients and guests, minor props/UI, plus the unused elevator ref |

A pure "≥ 3 scenes" rule without bases 2–3 would drop 60 refs and remove a ref from 226 owner cuts. That includes wardrobe states used for 8–12 cuts inside a single long scene, which is the worst place for drift. **That rule is not recommended.** With all three bases, refs drop to 84 (≈ $0.51), and 40 fewer refs need generation, review and approval.

## 2. Multi-zone page allocation

### Precedent

The opening-montage repair `fal/bulk/review-repair-outputs/ep_01-w000037-w000041-v2.png` came from one `gpt-image-2.5/sunburst/edit` request at `quality: low`, 1920×1080, with one location ref. It produced a present-day Joey half and four separate memory panels on thin white gutters, with no lettering. Each region crops cleanly. The prompt named each panel's position, demanded "fully separate and readable as individual crops", and banned text everywhere. The same request also carried the shared board instruction "Do not reproduce the board, borders, gutters…". That line contradicts a page request, so page assignments need their own instruction block (below).

### Page templates (closed set for v1)

Gutters are solid, near-white, about 1.0% of the page width (≈ 16–20 px), straight, and span the full page. Pages have no outer frame and contain no text.

| Template | Zones (nominal, normalized) | Zone px at 1920×1080 | Use |
| --- | --- | --- | --- |
| `P2V` | two vertical halves | ≈ 950×1080 (0.88:1) | two characters / reaction pair, portrait insets |
| `P2H` | two horizontal bands | ≈ 1920×530 (3.6:1) | establishing strip + detail strip, page_pan |
| `P3L` | left half + right two stacked | 950×1080, 2 × 950×530 | hero-ish beat + two inserts |
| `P4G` | 2×2 grid | 4 × ≈ 950×530 (≈16:9) | object inserts, UI, reactions, body-state proof |

v1 caps pages at **4 zones**. The precedent's 5-zone layout (a half plus a 2×2 inside the other half) is out of contract for v1: its zones are about 470×530 px.

### Allocation contract (`goldflow_panel_asset_plan_v2`)

`visual panel-assets` stays authored editorial work: there is no quota, keyword grouping or automatic packing. v2 adds an optional page form next to v1 single-artwork orders:

```json
{
  "asset_id": "page_0042",
  "kind": "page",
  "page_template": "P3L",
  "scene_id": "scene_046",
  "owner_beat_id": "<earliest beat bound to any zone>",
  "page_brief": "<shared location, time, lighting, palette, who is present; one coherent scene>",
  "editorial_reason": "<why these beats belong on one generation>",
  "zones": [
    { "zone_id": "page_0042_z1", "slot": "left", "beat_ids": ["..."], "visual_brief": "...",
      "editorial_reason": "...", "intended_display": "inset_large|inset|insert|reaction|establishing" },
    { "zone_id": "page_0042_z2", "slot": "right_top", "beat_ids": ["..."], "visual_brief": "...", "editorial_reason": "...", "intended_display": "insert" },
    { "zone_id": "page_0042_z3", "slot": "right_bottom", "beat_ids": ["..."], "visual_brief": "...", "editorial_reason": "...", "intended_display": "reaction" }
  ]
}
```

Beat bindings then name `asset_id` **and** `zone_id`. The structural validator, which makes no editorial inferences, enforces:

- The template is in the closed set; the zone count and slots match the template exactly; zone IDs are unique and safe.
- Every beat is bound exactly once, in source order. Each zone's `beat_ids` are contiguous **within that zone**. Different zones on a page need not be adjacent beats.
- All zones belong to **one semantic scene** in v1 (same location contract and time), so one page brief can light them consistently.
- The union of attached refs across zones is **≤ 4**, matching the existing native four-reference limit. At most **3 distinct human identities** may be visible on one page; more people on one generation raise the risk of identity bleed between them.
- `owner_beat_id` is the earliest bound beat; the page is dispatched when its owner is.

The packet instructions add the following. Group onto one page only beats from the same scene whose characters, wardrobe, location and state are simultaneously true. Give each zone its own drawable subject. Reserve single-artwork orders (`kind: "single"`, today's v1 shape) for beats that need a full-frame wide action, payoff or reveal. Never put a future reveal on a page whose earlier zones serve the setup when the reveal's own art would spoil it on screen (see disclosure below).

### Prompt shape

Prompt planning authors **one `provider_prompt` per page**. The prompt has three fixed sections, kept separate so hardening and QA can check each:

1. **Page frame.** Generated from the template and never paraphrased: "One 16:9 landscape anime/manhwa page divided into `<N>` fully separate rectangular panels by straight solid white gutters of equal width that run edge to edge. `<slot geometry sentence>`. Nothing — no limb, hair, prop, light streak or effect — crosses a gutter. No captions, speech bubbles, sound effects, numbers, logos or lettering anywhere, including inside gutters."
2. **Shared page context.** From `page_brief`: location contract, lighting, palette and the visible cast with their identity/wardrobe anchors, stated once.
3. **Per-zone content,** in slot order: "Panel `<k>` (`<slot>`): …" from each zone's `visual_brief`, using the zone's beat entities. Each panel names who is in it and who is **not**.

Page assignments replace the board line "Do not reproduce … gutters" with a page variant that still forbids copying the reference board layout but requires the declared gutters. Without that change the two instructions contradict each other.

The hardener runs its existing per-beat checks (active state, identity binding, props/hands) **per zone**, and adds page checks: the cast union matches the refs, and the zone count in the prompt equals the template.

### Zone geometry: declared, then measured

The model will not place gutters at exact coordinates, so zone rectangles come in two steps:

- **Declared:** the template's nominal rectangles, stored on the allocation.
- **Measured:** after the raster arrives, a deterministic gutter detector (no model) finds full-span near-uniform light rows and columns. It derives the actual panel rectangles and records `page_geometry_<asset_id>.json` (`goldflow_panel_page_geometry_v1`) with the raster sha256, the detected rectangles, the gutter widths and the detector version.

Structural acceptance requires:

- The detected panel count equals the template's zone count.
- Each detected rectangle is within ±4% of the page dimension of its nominal edges.
- Each gutter is continuous for ≥ 98% of its span. A shorter gutter means something crosses it.
- The **safe rectangle** of each zone is the detected rectangle inset by 1% of the zone dimension on each side.

Implemented (Phase 0 piece 2) in `scripts/lib/panel-page-geometry.mjs` (`guillotine_light_gutter_v1`). It splits the page recursively at full-span light runs: luminance ≥ 200 over ≥ 98% of the span, gutter width between 2 px and 5% of the dimension. Light runs touching the page edge are trimmed as borders. It then matches the detected regions to the template within ±4%, and writes `goldflow_panel_page_geometry_v1` plus pixel-exact review crops. On the coma-healer montage precedent it measured the five regions exactly (gutters at x 1066–1070 and 1460–1463, y 508–512), and correctly rejected them against `P3L`. Known limit: a thin, full-height light streak inside a panel registers as an extra gutter. That fails the page; it is never silently accepted.

A geometry failure fails the page's structural QA as **one exact-scope finding**. Nothing is retried automatically: triage chooses either a zone-scoped repair (below) or one reviewed page regeneration under existing retry and spend limits.

### Binding zones to the composer (existing `panel.source_rect`)

The composer already supports panel-level crops: `panel-production-plan.mjs` creates each panel as `{ asset_id, source_rect: full }`. `panel-production-author.mjs` checks fill with `asset.width × panel.source_rect.width × decision.source_rect.width`. `panel-composition-authoring.mjs` composes nested crops. Zones therefore need **no new renderer concept**:

- For a beat bound to a zone, the plan creates its panel with `source_rect = zone safe rectangle` (page-normalized) and `metadata.page_asset_id` / `zone_id` / `page_geometry_sha256`.
- The recipe's per-decision `source_rect` stays **relative to the panel**, which is now the zone. A decision crop therefore cannot leave its zone by construction. The author never sees the gutter.
- Composition provenance adds the page geometry hash. If the geometry file changes, every dependent plan is invalidated.

Composer validator changes:

- **Magnification is reported, not capped.** Effective magnification (displayed px × max zoom ÷ zone-crop source px) is written to the composition report for review. It does not block. Operator decision (2026-10-19): stretching a zone to fill the frame is acceptable; image count matters more than maximum sharpness. The existing camera zoom limit (1–4) and the renderer's high-quality resampling stay as they are.
- **Disclosure across zones.** A page carries future zones. No decision, background or context panel may show any pixel of a zone before that zone's first bound beat starts. A background or context panel may use only zones that are already disclosed. The existing rule "a later panel cannot be disclosed before its beat" is extended from panels to zones, using the zone rectangles.

### Resolution and quality

Locked: 1920×1080 at `quality: low`, the same request settings as today. There is no higher-resolution or higher-quality arm (operator decision, 2026-10-19). The adapter's 1920×1080 output check stays unchanged.

### Presentation: unchanged

Operator decision (2026-10-19): keep the current panel look. Pages change only how artwork is generated. Each beat still gets an ordinary panel through the existing layouts (`full_frame`, `inset`, `reveal`, `reaction_pair`, `page_pan`) over the blurred background. The only difference is that the panel's source is a zone of a page instead of a whole image. The viewer never sees a page as a page, so there is no new layout and no page reveal. Wide single images remain for beats whose recipe needs a large full-frame wide shot.

### Optional style ideas (separate from this change)

Observed on Manhwa Fresh (`@manhwa_fresh`, recap `CSLYvUejF3w`), the leading channel in the niche, as ideas for our own style. They are not part of this proposal and not a target format:

- Shots last 2–4 s, and 1–2 s in action bursts. Our beats average about 5.4 s. Two or three authored crops within one long beat would quicken the rhythm, and zones make extra crops cheap.
- The screen shakes on hits, explosions and shocks. That would need a small authored camera-shake feature.
- Faces get slow push-ins on reactions and revelations, and wide reveals get pull-outs. Our camera paths already support both.
- Sound-effect lettering and system/stat windows stay on screen. Our prompts currently ban lettering, so keeping it would be an editorial choice.

### Image QA: page vs zones

1. **Page structural QA (deterministic):** geometry as above. Also check for lettering in gutters (a variance check on the gutter strips) and for exact duplicate zones.
2. **Page semantic QA (one model review per page):**
   - the cast on the page matches the union of the zone manifests
   - no identity bleed between people across zones
   - consistent lighting and palette for the shared scene
   - no text
   - no subject cut by a gutter

   This replaces N separate whole-image reviews with one page review.
3. **Zone acceptance (per zone, unchanged semantics):** today's per-beat checks run on a **lossless review crop** of the zone safe rectangle, materialized as `…/<asset_id>/<zone_id>.png` and hash-bound to the page sha256 and the geometry. The checks are focal analysis, semantic audit, active state, identity and hands/props. These crops exist for QA and review only. The renderer still reads the page with `panel.source_rect`, so there is a single source of truth. Every alias beat of a zone is still accepted per beat, as today.
4. **Accept or reject per zone.** A page is "accepted" only as the set of its accepted zones. Rejecting one zone does not reject its siblings.

### Zone-scoped repair

Diffusion edits cannot guarantee untouched pixels, so a rejected zone is **never** repaired by re-editing the page. The reviewed repair re-binds that zone's beats to a new `kind: "single"` artwork order, generated at the zone's aspect through the existing exact-ID repair route. Accepted sibling zones and the page raster stay immutable. If a page has ≥ 2 rejected zones, or fails structure, triage may choose **one** reviewed page regeneration under the existing retry/spend ceilings. Nothing is regenerated automatically and there is no third candidate.

### Coma-healer projection

Starting from the 658 owners:

- Treat as **hero singles** the 120 owners whose reviewed recipe used `full_frame` on > 60% of the artwork.
- Pack the remaining 538 owners into pages within their scene, first-fit in source order, under the ref-union and zone limits.

| Packing limits | Pages | + hero singles | Scene generations | Change |
| --- | ---: | ---: | ---: | ---: |
| ≤ 3 zones, ref union ≤ 4 | 229 | 120 | 349 | −47% |
| ≤ 4 zones, ref union ≤ 4 (**recommended v1**) | 203 | 120 | **323** | **−51%** |
| ≤ 4 zones, ref union ≤ 6 | 170 | 120 | 290 | −56% |

Under the recommended limits, 51 pages hold a single zone (equivalent to today's singles) and 80 hold four. An editor who merges same-location singles across adjacent scenes, or who uses fewer hero singles, would push this further. Those are authored editorial choices, not automatic packing.

## 3. Derived-reference promotion

### Current state

`imagegen promote-derived-refs` (`scripts/imagegen.mjs`, `promoteDerivedReferences`) copies a **whole** generated story cut into `<ref_id>-derived-reference.png`. It does this for legacy `derive_from_*` targets, without a crop, without review and without a re-anchor rule. `docs/pipelines/generated_visuals.md` forbids using an ordinary story cut as a full human or creature identity reference. It allows `source_only` recovery only for an unoccupied location, an isolated unheld prop or a UI motif. The proposal keeps that prohibition and adds a narrower, reviewed role. **This is a policy amendment that needs explicit operator approval.**

### Proposed route: `imagegen promote-zone-ref` (new, guarded)

Input: a reviewed spec, `goldflow_zone_reference_promotion_v1`, with:

- `ref_id`: must be a `derived_promotion_candidate` from §1, or a kept ref's **state-continuity** companion.
- `source`: page `asset_id`, `zone_id`, page raster sha256, geometry sha256, and a tight `crop_rect` inside the zone safe rectangle.
- `role`, one of:
  - `location_continuity`: architecture and materials. People may be present but are masked out of use by the instruction.
  - `prop_continuity`: an isolated prop crop.
  - `ui_continuity`
  - `state_continuity`: wardrobe, condition, hair and grooming for a character **state**. Never facial identity.
- `actual_review: true`, `reviewer`, a substantive `note`, and the zone's own accepted image-QA receipt.
- `valid_scene_ids`: the exact later scenes where the state still holds, taken from active-state constraints. The promoted ref expires at the next state change.

Drift guards:

1. **Always re-anchor.** A `state_continuity` ref attaches only **together with** that character's original standalone identity plate, which sits in an earlier slot. The board instruction reads: "Face and identity come only from the identity plate; the continuity crop supplies wardrobe/condition only." A state ref without its identity plate is a validation error. Location continuity refs are anchored on the location contract text.
2. **One generation deep.** A crop may be promoted only from a zone whose conditioning for that subject used **original** standalone refs or text only, never another promoted ref. So page 3 is conditioned on the crop from page 1, never on a crop from page 2. This stops copy-of-copy drift.
3. **Reviewed clean crops only.** The source zone must have passed zone acceptance, and the crop must not contain a second person's face for `state_continuity`. A deterministic check rejects crops whose rectangle reaches outside the safe zone.
4. **Slot budget.** Promoted refs count toward the four-ref union, and identity plates always take priority.
5. **Immutable provenance.** The promotion writes a new receipt and a new copy. It never mutates the accepted page, the zone, or the original standalone ref. The reference plan gains an appended `derived_refs[]` entry, and dependent page prompts for the valid later scenes are re-hashed through the existing exact reviewed-repair path before their dispatch. Pages already dispatched are not rewritten.

Order of work: dispatch the first page of each candidate subject, review it, promote, then dispatch later pages. This is a natural wavefront, since panel profiles already disable ordinary prefetch. It adds a dependency edge per candidate subject, not a global barrier.

In coma-healer terms: the 16 two-page candidates would each get at most one promoted crop. Wardrobe states with ≥ 3 pages stay as standalone refs under basis 3 and keep re-anchoring on their base identity, as they do today.

## Estimated totals for coma-healer

Unit prices from the run: ref ≈ $0.0061, scene `edit` ≈ $0.0176 at low. The repair reserve assumes 10% of the 538 zones need a single-zone replacement. That is an assumption, not a measurement.

| | Baseline (actual) | Proposed v1 (estimate) |
| --- | ---: | ---: |
| Generated refs | 124 ($0.76) | 84 (≈ $0.51) |
| Scene generations | 658 ($11.58) | 323 (≈ $5.68) |
| Zone repair reserve | — | ≈ 54 (≈ $0.95) |
| **Total generations** | **782** | **≈ 461 (−41%)**; ≈ 407 (−48%) with no repairs |
| **Total cost** | **$12.35** | **≈ $7.1 (−42%)** |
| Whole-image semantic reviews | 658 | 323 (page reviews), plus per-zone acceptance on crops |

Request settings are unchanged (1920×1080, `quality: low`), so the per-request price is assumed to match the run's. Pages attach the union of their zones' refs, which may add a little input cost per request.

## Risks

| Risk | Mitigation |
| --- | --- |
| Model ignores geometry: merged panels, missing gutters, limbs crossing gutters | Closed templates, fixed frame sentence, deterministic gutter detection, zone-scoped repair; measured in the proof |
| Stretched zones look soft | Stretching is accepted by the operator; magnification is reported, and playback review judges it |
| Future zone leaks before its beat (spoiler) | Zone-level disclosure rule in the composer validator; whole-page pans only after full disclosure |
| Identity bleed between people on one page | ≤ 3 human identities and ≤ 4 refs per page; page semantic QA checks bleed explicitly |
| Larger repair blast radius | Siblings stay accepted; rejected zones re-bind to singles; at most one reviewed page regeneration |
| Contradictory board instruction ("do not reproduce gutters") | Page-specific board instruction variant |
| Zone crops feel repetitive | Allocation gives each zone its own drawable subject; the existing layouts, crops and camera paths vary the edit |
| Prompt-only subjects drift across pages | Bases 2–3 keep cross-page subjects as refs; two-page subjects get one reviewed promoted crop, re-anchored |
| Policy conflict with "no story cut as identity ref" | `state_continuity` never supplies identity; requires explicit operator approval of the amendment |
| Editorial over-packing to hit a count | No quota; the validator checks structure only; the proof compares edits by actual playback |

## Proof plan: one chapter, private and separate

**Chapter:** the gala, `scene_046`–`scene_050` (45:06–50:30, about 5.4 min). It has 54 beats, 47 current owners and 7 hero singles. Projected: 15 pages at ≤ 3 zones, or fewer at 4. It stresses everything this design changes:

- multiple characters (Joey, Vanessa, Marcus, Richard, Elena, Henry, a guest)
- wardrobe states that the trim makes prompt-only or cross-page (`vanessa_gala_emerald_silk`, `richard_gala_stroke`, `elena_gala_navy_dress`, `henry_gala_formalwear`)
- trimmed locations (`loc_gala_coat_check_ref`, `gala_entrance_aisle`, `gala_bar_area`)
- an action payoff (the stroke)

The existing accepted coma-healer chapter is the A/B control.

**Identity and isolation.**

- A new private proof identity and output directory, e.g. `…/2026-W43-coma-healer-multizone-proof/`. It reads coma-healer's approved script, beats, timing and accepted refs **read-only by hash**.
- The coma-healer run identity, its artifacts and its accepted media are not modified.
- `run_intent` is proof. Outputs cannot satisfy any production stage.
- Committed, reviewed adapter code (the page allocation schema, geometry detector, zone binding and validator rules) runs behind tests before any spend.

**Steps** (each stops for review before the next spend):

1. **No-spend:**
   - Author the chapter's page allocation (v2) and the trimmed ref set for these scenes; prompt-plan and harden the pages.
   - Unit-test the gutter detector on the existing precedent PNG and on synthetic rasters.
2. **Generate pages** at locked 1920×1080 `quality: low`, using only the chapter's kept refs. Expected about 15 generations. Budget ceiling: 24 requests × $0.05 = $1.20.
3. **Structural and semantic QA:** page geometry pass rate, then zone acceptance on review crops. Record per-zone findings.
4. **Promote derived refs** (`location_continuity` / `state_continuity`) from first-page zones for two-page subjects, reviewed and re-anchored. Then generate those subjects' later pages.
5. **Zone repairs** for rejected zones as singles: at most one per zone, within the ceiling.
6. **Compose** the chapter through the normal panel author/compile path in the proof directory, using the existing layouts and the zone validator rules. **Render** a chapter-length proof with the existing chapter narration.

**Measured outcomes** (written to `docs/proofs/panel_multizone_pages_v1_result.md`):

- Generations: pages + repairs + promotions versus 47 baseline owners; actual Fal receipts versus baseline cost.
- Page geometry pass rate, zone acceptance rate, and zone rejection reasons by category: geometry, bleed, identity, state, text.
- Identity/wardrobe drift across pages for prompt-only and promoted subjects, against the baseline chapter.
- The zone magnification distribution, for review only.
- QA reviewer effort: page reviews plus zone findings, versus the baseline chapter's risk cuts.
- **Actual playback review** of the proof chapter against the baseline chapter: whether it looks as good as the current panels, disclosure order, variety, crop quality. Technical pass rates do not approve the format.

**Pass bar to scale:**

- ≥ 45% fewer scene generations on the chapter
- ≥ 85% of pages structurally valid on the first request
- zone acceptance ≥ baseline per-image acceptance
- no disclosure-rule violations
- operator playback approval

Anything short of that is a triage point, not a rerun order.

## Implementation outline (after approval; each a small, tested change)

1. `panel-production-assets.mjs`: the `goldflow_panel_asset_plan_v2` page form and structural validator; v1 plans stay valid.
2. Prompt planning and hardening: page prompt sections, the page board instruction variant, and per-zone hardening.
3. Fal adapter: page assignments at the existing locked request settings.
4. A new `panel-page-geometry` module: deterministic gutter detection, the geometry receipt, and review crops.
5. Image QA: page structural and semantic checks, zone acceptance on crops, and zone-scoped repair rebinding.
6. `panel-production-plan.mjs` / author validator: zone `source_rect` binding, magnification reporting and zone disclosure. The renderer is unchanged.
7. Reference director contract: `selection_basis` and the validator, `prompt_only` / `derived_promotion_candidate`.
8. `imagegen promote-zone-ref`: the guarded promotion route and the receipts, plus the policy amendment in `generated_visuals.md` once approved.
9. Docs: a `panel_production_v1.md` section and run-status routing for the new stages.
