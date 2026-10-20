# Multi-zone page proof v1: coma-healer gala chapter

Status: private proof (`production_eligible: false`). It does not approve production use. Source run `2026-W43-coma-healer-fal-panel-v1/ep_01` was read only; nothing in it changed.

- Proof directory: `/Users/joel/AniFactoryData/proofs/multizone-gala-v1`. It holds the authored plan, the proof identity, the assignments, the boards, the outputs, the geometry receipts and the `review/` sheets.
- Code: commit `0f78721` (clean), run as `scripts/panel-multizone-proof.mjs`.
- Spend: approved by Joel on 2026-10-20. 13 requests were dispatched against a ceiling of 16 requests / $0.80. All went to `gpt-image-2.5/sunburst/edit` at low quality, 1920×1080. There were no retries and no failover. Actual billing has not been checked yet; the run's observed unit cost suggests about $0.25.

## Generation count

| | Baseline chapter | Proof |
| --- | ---: | ---: |
| Scene artworks generated | 47 | 25 (13 pages + 12 unchanged singles) |
| Of which new requests in this proof | — | 13 |

- The 12 singles are 7 hero splashes plus 5 owners that could not honestly share a page: a different location, more than three people, or a lettering-heavy card. They keep their accepted images.
- 35 owners became 35 zones on 13 pages. This chapter's scene generations fall by 47%.

## Geometry (deterministic detector)

- **Every page** has the requested number of separate panels and continuous, full-length white gutters.
- **9 of 13 passed** the ±4% template-placement tolerance as written.
- **4 failed only on placement, not structure.** The model drew a correct, clean layout with an off-centre split:

  | Page | Template | Split |
  | --- | --- | --- |
  | p03 | P2V | ≈ 42/58 |
  | p07 | P2H | ≈ 54/46 |
  | p11 | P3L | ≈ 44/56 |
  | p13 | P2V | ≈ 37/63 |

  Their zones crop cleanly.
- **Recommendation:** match pages on topology (zone count, arrangement, continuous gutters, a minimum zone size) instead of nominal edge positions. Under that rule all 13 pages pass. Policy change pending review.

## Actual visual review (operating agent, 2026-10-20)

- **Overall:**
  - Clean panels, no figure crossing a gutter, consistent lighting within each page.
  - Identities stay consistent across pages: Vanessa, Joey, Richard, Marcus, Elena and Henry.
  - In-panel thought bubbles and captions mostly render with the exact requested text.
- **Zones that would need review or repair:**
  - **p06 left** (`w009181-w009196`): Richard is drawn healthy at the podium. The required stroke state (facial droop, hand clawing the podium) is missing. This is a story-fidelity failure and a zone-repair candidate.
  - **p08 bottom-left** (`w009253-w009276`): the thought-bubble text is garbled ("Not you. Pl… Please."). Minor lettering defect.
  - **p11:** an unrequested "COAT CHECK" sign appears on the wall. Minor.
  - **p07 top:** Richard's facial droop is barely readable at band size. Advisory.
- **Not yet reviewed:** composed playback. Zones have not been cut into the panel compositor for an A/B of the chapter against the current edit.

## Sheets

- `review/pages.jpg`: all 13 pages.
- `review/zones-1.jpg`, `zones-2.jpg`, `zones-3.jpg`: every zone crop with its source owner ID. These are review-only crops from the detected rectangles, with a 1% inset. Crops in each row are in detection order, which for 2×2 pages is column-major.
