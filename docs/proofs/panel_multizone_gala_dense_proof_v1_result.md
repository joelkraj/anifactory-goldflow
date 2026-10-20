# Dense multi-zone page proof v1: gala chapter at ~5 beats per image

Status: private proof (`production_eligible: false`). The source run was read only.

- Proof directory: `/Users/joel/AniFactoryData/proofs/multizone-gala-dense-v1`.
- Code: commit `a055aa0`, which added the P3H/P4H/P5L/P6G templates, 3×2 boards of up to 6 references, and caps of 6 references and 4 people per page.
- Spend: approved by Joel on 2026-10-20. 11 requests against a ceiling of 14 requests / $0.70. Endpoint `gpt-image-2.5/sunburst/edit` at low quality, 3840×2160. No retries. Actual billing is unknown: the API key lacks billing permission.

## Density

| | Current edit | First proof (1920) | Dense proof (3840) |
| --- | ---: | ---: | ---: |
| Generations for the chapter | 47 | 25 (13 pages + 12 singles) | **11 pages** |
| Beats per generation | ~1.2 | ~2.2 | **5.09** (56 beats) |

All 47 owners are paged, the 7 heroes included: they sit in two-thirds-width hero zones, a half-page zone, or one grid cell.

The layouts were 5 P4H, 2 P6G, 1 P5L, 1 P3H, 1 P3L and 1 P4G.

## Geometry

**11 of 11 pages passed on the first request** (topology detector v2). That includes both 6-zone grids and the 5-zone page. Every output was exactly 3840×2160, with no normalization.

## Actual visual review (operating agent, 2026-10-20)

- **Overall:**
  - Identities hold well across pages: Vanessa, Joey, Marcus, Richard, Elena, Henry, and the three friends.
  - The scene lighting is consistent within each page, and the zone crops are sharp.
  - The 3840 hero zones hold detail.
  - The lettering-heavy offer card reads cleanly in a one-third cell.
- **Better than the 1920 proof:** p04 shows Richard's stroke state, with facial droop and the hand clawing the podium. The 1920 proof missed it.
- **Defects:**
  - **Garbled small lettering on three panels:**
    - p01: "No more looking dowg down."
    - p01: "APPOINTMENT PENDING PENDING"
    - p02: "I'd queue agin. again."

    Small bubbles on large pages are the weak spot. Candidate fixes: fewer words per bubble, a larger minimum bubble size, or adding bubbles in post.
  - **Identity drift, p05 hero:** the collapsing Richard looks heavier-set and lighter-haired than his reference. This is a zone-repair candidate.
- **A/B chapter** (`review/ab/gala-dense-B.mp4`, side-by-side with the current edit):
  - Same narration, timing and layouts.
  - Zones are fitted into the current edit's crop boxes. This is a mechanical port, not re-authored crops, so some panels play smaller than in the current edit.

## Implications

- **This chapter** reached 5.09 beats per generation, against the 5.0 target.
- **The whole-episode model for coma-healer** projects about 172 generations at 5.04 beats each, versus 658 today, if every owner is paged under these caps.
- **Cost:**
  - Fal lists 3840 low at about 2.5× the 1920 price, plus the input board and prompt tokens.
  - At an assumed ~$0.025–0.03 per page, a whole episode is about $4.3–5.2 for scene art, versus $11.58 today.
  - Actual per-request cost needs the dashboard or a billing-scoped key.
- **Remaining before production use:**
  - A lettering policy for dense pages.
  - Zone repair of the p05 hero.
  - Re-authored composition (native crop authoring) for zone panels.
  - Production allocation guidance for these templates.

## Update 2026-10-20

- **Exact billed cost** (Fal billing events): 11 requests, $0.288135 in total, $0.0262 per page, $0.0051 per beat. The 1920 proof cost $0.0187 per page. The cost reports are in each proof directory.
- **Composition re-authored natively.** The repo's native image-aware author ran on zone crops (Codex CLI planner, no image provider). Inputs were the 56 beats with the retimed narration and word timing.
  - 5 of 8 chunks were authored cleanly.
  - 3 chunks failed only the viewport-fill check. Their 6 rects were reconciled by a recorded manual fix: resized to the crop aspect, centre and height kept, all other fields as authored.
  - The compiled result: 41 inset, 6 reveal, 6 full-frame, 2 reaction-pair and 1 page-pan decisions.
  - Compared with the mechanical port, panels play larger and the edit gains real punch-ins (hands, close faces).
  - Renders: `proofs/multizone-compare/gala-dense-authored.mp4`, plus side-by-sides against the mechanical port and against the 1920 version.
- **Lettering policy** added (`790b579`). It would have flagged the offer card in a small zone. The size directive targets the three garbles.
- **Pending:** the p05 hero zone repair, prepared as one 2560×1440 request (`dense_p05_hero_repair1`), awaiting spend approval.
- **Decision (Joel):** dense 3840 pages are the preferred direction.

## Repair and final chapter (2026-10-20)

- **Spend:** `dense_p05_hero_repair1` was approved by Joel and dispatched as one 2560×1440 request at low quality. Billed $0.019855. The proof total is now 12 requests and $0.30799, within the ceiling of 14 requests / $0.70.
- **Review:**
  - The repair restores Richard's identity: silver hair, square face, correct build.
  - The model added an unrequested young man running at the upper left who resembles Joey. That contradicts the later narration ("at a walk. Not a run").
  - He is excluded by cropping x 0.40–1.00 (1536×1440). That crop has the original zone's aspect, so the authored inset decision is unchanged.
  - Evidence: `review/p05-repair-review.json` and `review/p05-hero-before-after.jpg`.
- **Final chapter:**
  - Only the two affected engine parts were re-rendered; the other six were byte-identical.
  - Outputs: `proofs/multizone-compare/gala-dense-authored-repaired.mp4`, plus `current-vs-dense-final.mp4` (current edit against dense).
- **Final tally for the chapter:** 12 Fal requests and $0.308 against today's 47 images (about $0.83), at 56 beats.
