# Manhwa Recap Manufacturing APV Selector

```text
Select one blinded manhwa recap script using one ranking metric only: predicted average percentage viewed on a normally monetized longform YouTube upload with ordinary pre-roll and automatic mid-roll ads.

Candidate display order is randomized and has no meaning. Evaluate each candidate independently before comparing scores; never reward the first or last candidate merely because of position.

Do not consider word count, manuscript length, author identity, model identity, or production cost. Story qualities matter only through their expected effect on percentage viewed. Calibrate absolute estimates to the supplied own-channel APV observations. Do not invent flattering seventy-to-one-hundred-percent longform APV predictions.

For every candidate, independently simulate exactly twenty fixed psychographic viewers. Do not invent demographics or treat them as measured audience shares:

1. `core_binge_fast`: established recap fan who expects causal movement immediately.
2. `core_binge_payoff`: established recap fan who tolerates setup only when payoffs arrive repeatedly.
3. `core_binge_progression`: established recap fan focused on concrete upgrades and escalating ceilings.
4. `core_binge_revenge`: established recap fan focused on betrayer consequences and status reversal.
5. `casual_mobile_impatient`: distracted mobile viewer who leaves during slow setup.
6. `casual_mobile_distracted`: mobile viewer who needs clean re-entry hooks after attention breaks.
7. `casual_mobile_title_literal`: clicked for the exact title and expects it to begin immediately.
8. `casual_mobile_low_lore`: leaves when names, ranks, institutions, or terminology pile up.
9. `betrayal_fantasy`: stays for a legible personal wound and emotionally credible boundary.
10. `revenge_payoff`: stays only if enemies suffer escalating, specific consequences.
11. `system_progression`: needs one easy mechanic with clear inputs, outputs, limits, and proof.
12. `power_scaling`: needs visible weak-to-overpowered growth and new ceilings.
13. `emotional_relationship`: needs allies and relationships with agency beyond praising Joey.
14. `strategic_outplay`: prefers planted tactics, counters, and earned reversals over raw strength.
15. `longform_completion`: accepts long runtime when arcs change the situation and the ending closes the promise.
16. `ad_break_sensitive`: watches with normal ads and midrolls and needs strong re-entry hooks.
17. `repetition_sensitive`: exits when training, revenge, explanations, or victories repeat the same function.
18. `ai_slop_skeptic`: exits on generic phrasing, fake profundity, convenient stupidity, or interchangeable characters.
19. `cold_listener`: knows only the title and must understand the opening on one spoken pass.
20. `late_payoff_skeptic`: exits when the title payoff or first proof is deferred.

Estimate the percentage each viewer watches before exiting or finishing. Give each viewer one concise `predicted_exit_point` and one primary reason. Average the twenty percentages arithmetically. Rank candidates from highest to lowest average.

For every candidate, estimate a coherent opening survival curve with percentages remaining at thirty seconds, sixty seconds, two minutes, and five minutes. These checkpoints diagnose the opening but do not create another ranking metric. Final rank still uses only mean predicted average percentage viewed.

Pay special attention to whether the first two minutes rapidly deliver the title premise, betrayal, low status, core mechanic, immediate use, and proof while creating forward questions. Then judge whether reversals, progression, revenge, clarity, callbacks, and post-ad re-entry sustain attention through the middle and ending.

Return JSON only:

{
  "schema": "goldflow_manhwa_manufacturing_selection_v1",
  "status": "selected",
  "selected_blind_id": "candidate_a",
  "rankings": [
    {
      "blind_id": "candidate_a",
      "rank": 1,
      "opening_survival_curve": {
        "thirty_seconds": 0,
        "sixty_seconds": 0,
        "two_minutes": 0,
        "five_minutes": 0
      },
      "viewer_simulation": [
        { "viewer_id": "core_binge_fast", "predicted_percentage_viewed": 0, "predicted_exit_point": "completion or concise point", "reason": "..." }
      ],
      "predicted_average_percentage_viewed": 0,
      "retention_reason": "..."
    }
  ],
  "decision_rationale": "..."
}
```
