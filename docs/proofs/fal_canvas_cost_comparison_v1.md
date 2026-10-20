# Fal canvas size and cost comparison v1 (estimates; one paid test proposed)

All requests use `openai/gpt-image-2.5/sunburst/edit` at `quality: low`, with the same prompts and reference boards.

## Pricing facts

- **Fal list prices (token-billed).** These are from the model page, at low quality and "including one input image":
  - 1920×1080: $0.00441
  - 2560×1440: $0.00615 (+$0.00174)
  - 3840×2160: $0.01113 (+$0.00672)

  The rates are $5/M text input, $8/M image input and $30/M image output tokens. Fal states that longer prompts and larger images cost more.
- **What we actually pay at 1920×1080: about $0.018 per edit.**
  - Dashboard 2026-09-29: 3,088 edits for $55.76, i.e. $0.01806 each.
  - Coma-healer: $11.58 for 658, i.e. $0.0176 each.

  That is about 4× the list example. The likely causes are our long prompts (2.5–3.5k characters) and the 1920×1080 reference-board input image. Neither depends on the output canvas.
- **Our API key cannot read billing.** `/v1/models/billing-events` returns 403, and receipts carry no token counts. Exact per-request costs need a key with the BILLING preset, or a dashboard lookup by the request IDs in the proof receipts.

## Estimated cost per request

Estimate = observed $0.018 + Fal's list delta for the larger output (input cost assumed unchanged):

| Canvas | Est. per request | Zone px, 2×2 page | Zone px, half page |
| --- | ---: | --- | --- |
| 1920×1080 | ~$0.018 | ~950×530 | ~950×1080 |
| 2560×1440 | ~$0.020 | ~1270×715 | ~1270×1440 |
| 3840×2160 | ~$0.025 | ~1910×1075 (about a full 1080p frame each) | ~1910×2160 |

## Per episode (coma-healer counts)

The page and single counts are from the design projection.

| Option | Scene generations | Scene cost | Refs (84) | Episode total | vs today |
| --- | ---: | ---: | ---: | ---: | ---: |
| Today (one image per artwork) | 658 | $11.58 | $0.76 (124 refs) | $12.34 | — |
| Pages at 1920 | 203 pages + 120 singles | $5.81 | $0.51 | ~$6.3 | −49% |
| Pages at 2560 | 203 + 120 | ~$6.18 | $0.51 | ~$6.7 | −46% |
| Pages at 3840 | 203 + 120 | ~$7.19 | $0.51 | ~$7.7 | −38% |

Cost per zone works out to about $0.0067 at 1920, $0.0073 at 2560 and $0.0092 at 3840 (2.7 zones per page), versus $0.0176 per artwork today.

At 3840 a 2×2 zone is already about a full-HD panel. That could support a 6-zone (3×2) template with ~1270×1075 zones, but the ≤3-people and ≤4-reference limits would cap the real average.

The repair reserve is excluded from the table and adds about 10% in every option.

**A bigger lever is probably the reference board.** It is a 1920×1080 input image on every request, and input image tokens look like most of the gap between list and actual. A smaller board (e.g. 1024×576) is worth its own test; this is a hypothesis.

## Prepared test (no spend yet)

Two proofs, each re-drawing the same four authored gala pages (P3L p02 and P4G p08, p10, p12) with identical prompts and references:

| Proof | Folder (`/Users/joel/AniFactoryData/proofs/`) | Requests | Ceiling | Expected |
| --- | --- | ---: | ---: | ---: |
| 2560×1440 | `multizone-gala-canvas-2560x1440` | 4 | 7 requests / $0.35 | ~$0.08 |
| 3840×2160 | `multizone-gala-canvas-3840x2160` | 4 | 7 requests / $0.35 | ~$0.10 |

They will be compared against the 1920×1080 originals of the same pages on:

- geometry pass rate
- zone sharpness at the composer's display sizes
- story and identity fidelity
- actual cost per request, from the dashboard or a billing-scoped key

Code: `1074eca`. The canvas is allowlisted and proof-only; production defaults are unchanged.

## Actual billed cost (Fal billing events, 2026-10-20)

Read-only billing events were matched to the proof receipts' request IDs. Endpoint `sunburst/edit`, quality low, one 1920×1080 reference board per request.

| Proof | Requests | Billed total | Per request (range) | Beats per image | Per beat |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1920×1080 pages (`multizone-gala-v1`) | 13 | $0.2429 | $0.0187 ($0.0182–0.0192) | ~2.2 | ~$0.0085 |
| 3840×2160 dense pages (`multizone-gala-dense-v1`) | 11 | $0.2881 | $0.0262 ($0.0254–0.0273) | 5.1 | ~$0.0051 |

A 3840 page costs 1.40× a 1920 page and covers about 2.3× the beats, which makes it about 40% cheaper per beat.

Whole-episode projection at these actual prices (coma-healer counts, scene art only):

- today: 658 × $0.0176 = $11.58
- 1920 pages: ~323 × $0.0187 ≈ $6.0
- 3840 dense: ~172 × $0.0262 ≈ $4.5
