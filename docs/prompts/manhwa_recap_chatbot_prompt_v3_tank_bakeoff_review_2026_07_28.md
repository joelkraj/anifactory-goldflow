# V3 Tank Winner Bakeoff Review

Date: 2026-07-28

## Provider Mapping

The three newest text downloads map oldest to newest as follows:

| Provider | Download time | File |
| --- | --- | --- |
| Kimi | 2026-07-28 12:38:51 | `/Users/joel/Downloads/His S-Rank Girlfriend Used Him As A Human Shield - Manhwa Recap Script.txt` |
| ChatGPT | 2026-07-28 12:41:49 | `/Users/joel/Downloads/His_S_Rank_Girlfriend_Used_Him_As_A_Human_Shield_TTS.txt` |
| Claude | 2026-07-28 12:42:03 | `/Users/joel/Downloads/his_srank_girlfriend_human_shield_strongest_tank.txt` |

## Direct Benchmark

The direct comparison is the highest-viewed recent winner in the research corpus:

`Used as a Meat Shield for Years, He Left Her & Became the Strongest Tank`

The benchmark has 14,426 timed-caption words, a 63.7-minute runtime, and a measured pace of 226.6 WPM.

| Candidate | Words | Minutes at 215 WPM | Mean sentence words | Median | P90 | 8 words or fewer | 19 words or more |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct benchmark | 14,426 | 67.1 | 9.48 | 8.5 | 17 | 50.0% | 6.7% |
| Kimi | 13,875 | 64.5 | 24.4 | 21 | 50 | 23.2% | 52.6% |
| ChatGPT | 12,539 | 58.3 | 10.2 | 9 | 17 | 43.9% | 7.2% |
| Claude | 13,835 | 64.3 | 22.8 | 21 | 43 | 22.2% | 55.3% |

ChatGPT is the only candidate whose sentence cadence closely matches this exact winner. Kimi and Claude meet the requested runtime, but their sentence profiles are much closer to literary audiobook prose than this benchmark.

## Ranking

### One: ChatGPT

ChatGPT is the closest direct winner imitation.

Strengths:

- Matches the benchmark's short, fast, third-person explanatory cadence.
- Makes the title contradiction physical immediately.
- Reaches the betrayal, refusal, mechanic, and first proof fastest.
- Maintains the clearest action-to-mechanism-to-consequence chain.
- Avoids narrator future leaks and overt thematic commentary.
- Gives the rescue allies distinct practical functions.
- Keeps Serena competent and strategically motivated.

Weaknesses:

- It is about 1,400 words short of the requested 65-minute target at 215 WPM.
- It repeats the same unknown attack, severe first hit, physics diagnosis, resistance purchase loop too often.
- It overuses one-sentence paragraphs and occasionally feels like a technical storyboard.
- The opening says there are six celebrated attackers, later shows three distant signatures, and then says Serena saved six people.
- It grants new Guard Experience after the first boss even though Joey was trapped alone and did not clearly choose to intercept that attack for another person.
- It uses more direct dialogue than the benchmark.

Verdict:

Best provider for the next controlled generation round. It needs targeted prompt correction, not replacement.

### Two: Kimi

Kimi has the strongest raw story architecture but is less faithful to the benchmark's delivery.

Strengths:

- Meets the requested runtime.
- Builds the best sustained escalation from betrayal to rescue work, engineered defeat, recovery, city-scale climax, and concrete revenge.
- Gives the supporting team useful identities and lets them materially solve the climax.
- Keeps Serena dangerous after Joey leaves instead of making her collapse immediately.
- Uses mostly indirect dialogue and limits Joey's polished comeback lines.
- Produces the most satisfying overall emotional and institutional payoff.

Weaknesses:

- The mean sentence length is 24.4 words, far above both the corpus median and the direct benchmark.
- More than half of its sentences contain at least 19 words.
- The narration frequently sounds authored, thematic, or novelistic instead of like an efficient recap.
- The opening says one recall charge can retrieve one party signature, then uses that charge to retrieve five signatures.
- Burden Reclaimed is defined as paying after danger ends, but later supplies new income during the glasswing fight and final battle.
- It includes narrator leaks such as future interviews and lines explaining what the story means.
- Its post-climax tribunal, rebuilding, training school, and future-history material runs longer than necessary.

Verdict:

Best alternate provider and best source for story ideas. A Kimi script requires a heavier cadence and continuity repair than ChatGPT.

### Three: Claude

Claude is the most polished at the sentence level but the least suitable final-script provider in this test.

Strengths:

- Meets the requested runtime.
- Creates strong thematic symmetry around consent, protection, and chosen burden.
- Gives Joey a permanent physical cost and lets the team help rebuild his fighting method.
- Builds an intelligent Serena counter and a visually packageable Warden climax.
- Uses supporting characters in the final plan.

Weaknesses:

- Its 22.8-word sentence mean is far outside the winner median and direct benchmark.
- The narrator repeatedly forecasts future events, explains themes, and comments on the story.
- It overuses metaphors, antithesis, and polished moral sentences.
- Its central climax breaks its own rule. The Verdict is defined as selecting the lowest-threat target and becoming impossible to redirect after lock. The final plan then has Joey become the highest-threat target at lock, and the Verdict suddenly locks onto the highest target.
- Because the final victory depends on that contradiction, the payoff feels mechanically cheated.
- The early fire, acid, lightning, and pressure progression still repeats the same lesson loop despite claiming the disasters are distinct.

Verdict:

Do not use Claude as the main final-script generator with the current prompt. Keep it only as an occasional ideation or critique model unless a future test removes the literary voice and enforces a mechanic ledger.

## Shared Finding

None of the three candidates is ingest-ready without repair.

The direct benchmark spends most of its first five minutes accumulating simple, concrete proof of exploitation before the abandonment. All three generated stories accelerate into the hidden boss and new mechanic sooner. Fast pacing should not mean skipping the repeated evidence that makes the betrayal emotionally expensive.

The next prompt revision should:

- Preserve the current immediate title proof.
- Require three to five concrete exploitation receipts before the abandonment without adding biography or lore.
- Distinguish varied conflicts from repeated damage-type demonstrations.
- Forbid earning delayed rewards before the danger has ended.
- Require a final mechanic proof that quotes the same target-selection rule established earlier.
- Require exact cast-count continuity from the opening through extraction.
- Require the requested word target within plus or minus three percent.
- Keep the global market cadence target near the corpus median, while allowing a premise-specific short-sentence profile when directly emulating this tank winner.

## Next Test Recommendation

Continue with ChatGPT and Kimi in the next full generation round. Drop Claude from the expensive full-script round for now. If a third provider is desired, test Gemini's strongest long-context writing model or another model only after confirming it can return the full target length in one response.
