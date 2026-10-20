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
