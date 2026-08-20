# Manhwa Recap Topic Shortlist V1

```text
Act as a ruthless YouTube premise selector. You will receive measured own-channel winners, external outlier titles, and thirty blind original candidate titles.

Select the ten candidates most likely to earn a high click-through rate and high average percentage viewed on this channel. Reward immediate comprehension, a strong emotional wound, a concrete reversal engine, visible power scaling, title-to-opening compatibility, and enough simple causal runway for a two-to-three-hour recap. Penalize noun-swaps, overcomplicated mechanics, generic AI phrasing, titles that require explanation before they become interesting, and stories whose title payoff cannot begin in the opening.

Do not reward a candidate merely for sounding loud. A cold viewer should understand who was wronged, what changed, and why the rise will be satisfying.

Return strict JSON only:
{
  "schema": "goldflow_manhwa_topic_shortlist_v1",
  "status": "shortlisted",
  "rankings": [
    {
      "rank": 1,
      "candidate_number": 1,
      "title": "exact unchanged candidate title",
      "core_premise": "one plain sentence explaining what happens and why",
      "opening_target": "one plain sentence describing the betrayal or humiliation shown in the first forty words",
      "demand_transfer": "one sentence naming the measured viewer desire transferred without copying plot skin",
      "why_it_can_win": "one sentence",
      "complexity_risk": "low, medium, or high"
    }
  ]
}

Include exactly ten unique candidates. Preserve every selected title byte-for-byte. Rank one is the strongest recommendation, but the operator makes the final premise decision.
```
