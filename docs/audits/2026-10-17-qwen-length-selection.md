# Qwen request-size selection — 2026-10-17

Joel selected approximately 40-word complete-thought requests after comparing the length-test previews. This supersedes the earlier provisional preference for 100 words and closes the larger-submission experiment. No 1,000-word request was dispatched.

Exact user decision:

> i think we stick with 40. it feels the best for delivery, flow is jumpy. but larger submissions fix the jumpy flow but begin to drone/stutter. i think 40 is our best option

Use the existing `coherent_thought_groups_v1` production policy for the next Manhwa Joey video: preferred 20–42 words, soft ceiling 48, hard ceiling 60, with authored complete-thought boundaries and justified short/long exceptions. Approximately 40 is a target, not an exact splitter or a new hard maximum. The tested ~40 arm contained 24 requests of 28–57 words over the same 1,050-word passage.

This decision selects request size and preferred delivery. It does not assert complete-passage listening, accept a future episode's audio, prove the cause of stuttering or resolve the reported jumpy flow. Future flow work should inspect pauses, cadence and continuity within requests and at joins; preserve speech and approved text. Do not expand request lengths merely to mask those symptoms.

No runtime code, model/reference settings, batch-four scheduling, 1,200-token production cap or accepted media changed. No new synthesis was needed. The current production policy already supports this direction. Comparison audio and earlier listening observations remain available unchanged.

Evidence directory: `/Users/joel/AniFactoryData/channels/53rebirth/source_development/audio_diagnostic_2026_10_17/qwen-length-ab-v1`

- Manifest SHA-256: `f5b59e0f3622d916f9da14e2e2ae2ee2fe01ed09e8bb796abcb857a8fd30a373`
- Selected ~40 preview SHA-256: `0568f2ce1f04ebe0df9580d52aa41209cb970c7f7981d1264da04201a97f306c`
- Selected ~40 raw report SHA-256: `96960a6d54083e6bba4d78bf34c18a4a054a4e0a2c9ab7671eb910b3fe9b2678`
- Selected ~40 ASR report SHA-256: `37c93c4e7ab1e5a7ba418d65d2833f755f746fb62f7c03271308726a54bcf7a8`

The append-only listening observations under that directory retain both the provisional and final size decisions. ASR coverage remains distinct from Joel's delivery judgment. The assistant records the user's listening feedback and does not claim to have listened independently.
