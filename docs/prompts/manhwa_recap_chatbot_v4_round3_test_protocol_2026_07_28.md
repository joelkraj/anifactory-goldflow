# V4 Round Three Test Protocol

Date: 2026-07-28

## Decision

Round three is complete. Do not generate another full candidate.

The complete comparison is recorded in `docs/prompts/manhwa_recap_chatbot_v4_round3_four_candidate_review_2026_07_28.md`.

Select the new-prompt Kimi K3 Max script for one bounded rescue pass:

- Source: `/Users/joel/Downloads/His S Rank Girlfriend Used Him As A Human Shield (2).txt`
- SHA-256: `84a621f51d26bfa5c2a46da47383b2dd20185e3365abc4ee2ab62985270f0eee`
- Status: `REPAIR`, not ingest-ready.

The script is the closest direct-winner match because its sentence cadence, short-sentence distribution, lexical simplicity, causal defeat, protagonist agency, active revenge, and ending shape beat the other three candidates.

The bounded rescue must:

- Compress the opening so Joey refuses near word one thousand, proves Burden Reclaimed by roughly word one thousand six hundred, and enters the Lantern objective by roughly word two thousand one hundred fifty.
- Resolve the live-feed versus missing-footage contradiction.
- Correct the post-death Lantern cast count.
- Correct the elapsed-time and Sef-age contradictions.
- Replace Brin's impossible burial with an explicit empty memorial.
- Use stable names for available and pending Guard Experience.
- Make Joey accept a visible trust restriction before he earns his lead role back.

After rescue, run all six release gates against the exact repaired hash. Do not ingest while any gate remains `REPAIR` or `REJECT`.

## Evaluation

Compare both new scripts against the preserved Kimi fallback and the direct winner.

Hard requirements:

- All six gates in `docs/prompts/manhwa_recap_comment_criticism_release_gate_v1.md` pass.
- Thirteen thousand eight hundred to fourteen thousand three hundred words.
- Complete standalone ending.
- No TTS-forbidden punctuation or production text.
- No continuity or mechanic-rule failure.
- No narrator future forecasts.
- The permanent defeat follows directly from information Joey hid or misstated.

Winner-direction diagnostics:

- Burden Reclaimed awakens and receives physical proof between six and seven and a half minutes.
- Sentence median lands near eight to ten words.
- Sentence P90 lands near seventeen to nineteen words.
- Forty to fifty-five percent of sentences contain eight words or fewer.
- Procedure vocabulary falls materially from the round-two rate of roughly eleven terms per one thousand words.
- Joey's immediate reactions and realizations rise materially toward the direct winner.
- Institutional procedure remains one compact pressure sequence and one brief confirmation.
- The climax produces the decisive physical or social revenge.
- The ending performs only Serena's concrete loss, Joey's final boundary, and one concise equilibrium.

## Stop Rule

The stop rule has fired.

Do not run a third model or another full generation round before producing the selected episode.

Rescue only the selected new-prompt Kimi candidate. Preserve its source unchanged, write the repaired candidate separately, and ingest only the exact repaired hash after every release gate passes.
