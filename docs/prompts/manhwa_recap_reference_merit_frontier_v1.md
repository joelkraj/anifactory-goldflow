# Manhwa Recap Reference Merit Frontier V1

```text
Read the complete measured outlier transcript and chart the strongest full-story frontier that the locked package must beat. This is an evidence extraction pass, not a candidate score, rewrite, imitation exercise, or raw event count.

Normalize every judgment by viewer payoff quality per 1,000 words and per estimated spoken minute. A longer reference does not win because it contains more fights, powers, locations, heroines, twists, or total watch minutes. Ask what each unit of narration makes a cold manhwa-recap viewer understand, desire, feel, anticipate, or remember. The fixed dimensions are not permission to ignore a reference-specific advantage: place every material edge under its closest dimension and name it explicitly in that row or in `cross_dimension_priorities`.

For every required dimension:

- cite one exact reference anchor with zero-based start_offset, exclusive end_offset, and exact_text
- identify the specific viewer appetite that anchor satisfies
- state the reference's strongest execution advantage
- state the reference's weakness or dilution after normalization
- write a concrete candidate obligation that would exceed the appetite without copying characters, world, wording, scenes, or plot skin
- define the non-copying boundary

The candidate obligation must be usable by a treatment architect and longform writer. “Be more exciting,” “add more powers,” and “improve retention” are invalid. Prefer obligations such as earlier proof, more ingenious reuse of one mechanic, a more intimate rescue, a cleaner antagonist adaptation, a fresher visual arena, stronger romantic reciprocity, a more legible causal turn, or a more complete payoff.

Return JSON only:

{
  "schema": "goldflow_reference_merit_frontier_v1",
  "status": "charted",
  "package_sha256": "SHA256",
  "selected_package_title": "...",
  "source_outlier_id": "...",
  "reference_title": "...",
  "reference_path": "...",
  "reference_sha256": "SHA256",
  "reference_word_count": 0,
  "normalization_policy": "viewer_payoff_quality_per_1000_words_and_estimated_spoken_minute_v1",
  "dimensions": [
    {
      "id": "opening_hook",
      "reference_anchor": {"start_offset": 0, "end_offset": 1, "exact_text": "..."},
      "viewer_appetite": "...",
      "reference_strength": "...",
      "reference_weakness": "...",
      "candidate_dominance_obligation": "...",
      "non_copying_boundary": "..."
    }
  ],
  "material_reference_edges": [
    {
      "edge_id": "stable_reference_specific_slug",
      "dimension_id": "one required dimension ID",
      "reference_anchor": {"start_offset": 0, "end_offset": 1, "exact_text": "..."},
      "viewer_appetite": "...",
      "reference_advantage": "one distinct advantage; do not bundle unlike edges",
      "candidate_dominance_obligation": "...",
      "non_copying_boundary": "..."
    }
  ],
  "cross_dimension_priorities": ["at least three concrete priorities"]
}

Include exactly these dimension IDs once each: opening_hook, title_fantasy_delivery, power_progression, spectacle_action, emotional_relationship, protagonist_agency, antagonist_pressure, world_visual_variety, middle_propulsion, clarity_naturalness, continuity_integrity, ending_payoff, estimated_apv. `material_reference_edges` is dynamic and exhaustive: include at least one distinct material edge per dimension, plus every additional reference-specific edge a viewer could reasonably prefer. Do not cap it at thirteen and do not split one advantage into cosmetic duplicates.
```
