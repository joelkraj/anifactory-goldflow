# V4 Reasoning Effort Bakeoff Review

Date: 2026-07-28

## Candidate Mapping

The five downloads map oldest to newest as follows:

| Rank tested | Provider and effort | File |
| ---: | --- | --- |
| 1 | ChatGPT Medium | `/Users/joel/Downloads/His_S_Rank_Girlfriend_Used_Him_As_A_Human_Shield_TTS(1).txt` |
| 2 | ChatGPT Extra High | `/Users/joel/Downloads/His_S_Rank_Girlfriend_Used_Him_As_A_Human_Shield_TTS(2).txt` |
| 3 | ChatGPT Pro | `/Users/joel/Downloads/His_S_Rank_Girlfriend_Used_Him_As_A_Human_Shield_TTS(3).txt` |
| 4 | Kimi K3 High | `/Users/joel/Downloads/His S Rank Girlfriend Used Him As A Human Shield - Full TTS Script.txt` |
| 5 | Kimi K3 Max | `/Users/joel/Downloads/His S Rank Girlfriend Used Him As A Human Shield - Full Script.txt` |

## Benchmark

The direct benchmark is `Used as a Meat Shield for Years, He Left Her & Became the Strongest Tank`, video `L8iwCGK7rFw`.

The local clean transcript contains 14,490 analysis words. The published research measurement is 14,426 timed-caption words across 63.7 minutes, or 226.6 spoken WPM.

| Candidate | Words | Mean sentence words | Median | P90 | Sentences at 8 words or fewer | Causal markers per 1,000 words |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct benchmark | 14,490 | 9.48 | 8.5 | 17 | 50.0% | 5.45 |
| ChatGPT Medium | 14,279 | 7.26 | 6 | 12 | 70.8% | 2.45 |
| ChatGPT Extra High | 13,855 | 7.94 | 7 | 13 | 64.1% | 2.89 |
| ChatGPT Pro | 14,146 | 9.71 | 9 | 16 | 44.5% | 2.26 |
| Kimi K3 High | 14,072 | 12.65 | 11 | 23 | 35.0% | 3.41 |
| Kimi K3 Max | 14,019 | 10.66 | 10 | 20 | 43.7% | 5.21 |

All five candidates met the requested word range and passed the tested TTS-character restrictions.

## Final Ranking

### One: ChatGPT Pro

This is the best production candidate and closest direct-winner imitation.

Its sentence distribution nearly matches the benchmark. It gives the opening exploitation multiple concrete receipts, preserves the exact six-person abandonment, delays every earned payout until the relevant danger ends, limits the full unfamiliar-damage tutorial, gives Joey a costly midpoint failure, and makes the final victory use established rules. Serena remains competent, Northline materially helps, and the revenge produces concrete losses.

The one clear defect is a narrator future leak that names Nia and Mara before Joey meets them. Delete that sentence. This is a surgical repair rather than a rescue pass.

### Two: Kimi K3 Max

This is the strongest challenger and has the best causal-marker density. Its paragraph texture is smoother than ChatGPT Pro, its mechanic ledger is disciplined, and the Elias injury creates a meaningful change in Joey's behavior.

It loses first place because it is more literary and narrator-visible than the benchmark. It introduces too many proper nouns early, forecasts future knowledge, comments on the story, and adds a longer policy, clinic, training, and career montage after the real ending. It needs a focused narration and ending trim.

### Three: ChatGPT Extra High

This is structurally sound and materially better than Medium, but its sentence profile remains too chopped. The story has a useful permanent injury, competent opposition, and a coherent final engine. Its opening also grants protection credit for a warning and angle choice rather than intercepted damage, which weakens the mechanic contract.

### Four: Kimi K3 High

This version is ambitious and often smooth, but it is slower and more literary than the direct winner. It contains narrator forecasts, a malformed sentence, heavier proper-noun load, and a large city-scale second climax followed by an extended future montage. It would require a broad rescue rather than a surgical pass.

### Five: ChatGPT Medium

This version reaches the target length and tells a complete story, but it is excessively fragmented. More than seventy percent of its sentences contain eight words or fewer. It also divides continuing threats into smaller danger windows, grants payouts, and spends those rewards while the larger crisis remains active.

## Effort Finding

Higher effort helped in this controlled test.

ChatGPT improved consistently from Medium to Extra High to Pro. The Pro output made the largest useful jump because it combined benchmark-like cadence with better global continuity and mechanic discipline.

Kimi K3 Max decisively beat Kimi K3 High. Max moved much closer to the benchmark's cadence and causal density while preserving Kimi's strong story architecture.

This does not prove that maximum effort is always better for every premise. High-effort models can become more literary, add excess lore, or overbuild the ending. For this prompt and direct benchmark, however, the quality gain is large enough to stop testing lower settings.

## Production Recommendation

Use ChatGPT Pro as the default one-shot script generator when its latency and usage are acceptable. Use Kimi K3 Max as the challenger and backup. Do not spend full-script tests on ChatGPT Medium or Kimi K3 High.

For prompt development, run the same premise once through ChatGPT Pro and once through Kimi K3 Max. Judge blind against the direct benchmark, then rescue only the winner. Do not average or merge both drafts.

V4 now includes the remaining controls revealed by this round:

- Name no more than Joey, the antagonist, and one essential person in the first five minutes.
- Never mention future allies before Joey encounters or learns about them.
- Never split one continuous danger into micro-dangers to unlock delayed rewards.
- Do not count warnings, plans, or positioning as intercepted damage.
- Use at most one post-climax time jump and no supporting-cast career montage.
