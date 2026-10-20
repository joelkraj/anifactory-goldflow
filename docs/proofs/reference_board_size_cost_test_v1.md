# Reference board size cost test v1 (follow-up 8): prepared, not dispatched

**Hypothesis.** The 1920×1080 reference board uploaded with every request is most of the gap between Fal's list price and what we pay. Evidence: billed cost per dense page barely moves with prompt length or reference count ($0.0254–0.0273), and a 3840 page costs only about $0.0075 more than a 1920 page.

## Setup

| | Control (already billed) | Test |
| --- | --- | --- |
| Proof | `multizone-gala-dense-v1` | `multizone-gala-dense-board-1024x576` |
| Pages | p02 P6G (5 refs), p04 P4H (4), p08 P6G (6), p11 P4G (3) | same |
| Canvas | 3840×2160, low quality | same |
| References | same hashes | same |
| Board | 1920×1080 PNG (3.0–4.2 MB) | **1024×576** PNG (0.97–1.27 MB) |
| Billed | $0.02689, $0.02565, $0.02727, $0.02537 (total $0.10518) | ? |

- **Board method.** The board layout, cell positions and prompt guidance are identical. The 1920 composition is downscaled with Lanczos before upload (code `7027e95`).
- **Confound.**
  - The test prompts are 518 characters longer, because the cast-rule and lettering-size sentences landed after the control was drawn.
  - For cost this is about 130 text tokens, roughly $0.0007 a request at $5/M, so it is noted rather than controlled.
  - For quality those sentences may help, so identity and lettering comparisons are only indicative.

## Spend lock

- 4 requests, plus 3 repair allowance unused by default.
- Ceiling: **7 requests / $0.35**. Expected about $0.06–0.11.
- Token `exact_fal_multizone_page_proof`. No retries, no failover.

## Read-out after dispatch

- Billed cost per request against the control (Fal billing events by request ID).
- Geometry pass rate.
- Identity fidelity per person. 6-face grid cells are about 340×288 on a 1024 board.
- Lettering checked with the new zone OCR (#5).

## Decision rule

- If cost drops by at least ~15% with identities held, the smaller board becomes the production default. That change goes through code and tests.
- If identity degrades on 5–6-reference pages, keep 1920 boards for those pages only.

## Result (dispatched 2026-10-20, approved by Joel)

4 requests, no retries. Geometry passed on **4 of 4** pages; every output was 3840×2160.

| Page | Refs | 1920 board (billed) | 1024 board (billed) | Change |
| --- | ---: | ---: | ---: | ---: |
| p02 P6G | 5 | $0.026885 | $0.020235 | −24.7% |
| p04 P4H | 4 | $0.025650 | $0.019000 | −25.9% |
| p08 P6G | 6 | $0.027265 | $0.020615 | −24.4% |
| p11 P4G | 3 | $0.025365 | $0.018810 | −25.8% |
| **Total** | | **$0.105165** | **$0.078660** | **−25.2%** |

The saving is a flat ~$0.0066 per request, whatever the reference count. That is consistent with input-image tokens scaling with board pixels: 1024×576 is 28% of the pixels.

**Quality** (operating agent, side by side: `review/*-orig-top-small-bottom.jpg`):

- **Identity held on every page**, the 6-reference p08 included: Joey, Marcus, Richard, Vanessa, the three friends and Henry. Faces, hair, ages and wardrobe match their originals.
- **Scene composition is equivalent**: the same staging per zone, and the same lighting and palette.
- **Lost details:** the "412" door number on p08's memory panel, and the podium crest on p04. Both are minor, and neither is narrated.
- **Lettering:**
  - Bubbles are larger and bolder in the new pages. This is the confound: the lettering-size sentence was added after the control.
  - p02's "BORROWED RANK" card doubled its second word as "RAINK". The zone OCR check (#5) caught it after a fragment-merge fix.
  - Across all three proofs the check now flags all 4 real garbles with no false positives.

## Decision input

The 1024×576 board cuts ~25% per page with no visible identity loss. At the tuned planner's 179 pages, scene art for the episode drops from about $4.69 to about **$3.52**, against $11.58 today. Recommended:

- make 1024×576 the board default for page generations, through reviewed code and tests;
- keep the option to revert per page if a later review shows identity drift.
