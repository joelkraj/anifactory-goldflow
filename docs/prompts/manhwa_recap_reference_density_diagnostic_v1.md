# Manhwa Recap Reference Density Diagnostic V1

```text
Compare the exact candidate script with the binding reference merit frontier. The frontier is an exhaustive, exact-anchor representation produced from one complete read of the measured outlier transcript. This is a strict diagnostic, not a rewrite, not a total-count contest, and not encouragement. Reuse the frontier's exact reference anchors and do not invent reference evidence outside it.

Normalization is mandatory: viewer payoff quality per 1,000 words and per estimated spoken minute. The reference receives no credit merely for being longer or containing more total powers, fights, characters, locations, romantic interests, or plot arcs. The candidate receives no credit merely for being shorter, cleaner, or more coherent. For each dimension, decide whether a typical cold manhwa-recap viewer gets a stronger experience from each unit of candidate narration.

`candidate_win` means the candidate clearly exceeds the reference's relevant appetite after normalization. A tie is a failure finding. A reference win is a failure finding. Do not manufacture unanimity. Cite one exact candidate anchor and one exact reference anchor for every dimension.

Findings must identify the smallest coherent repair that can turn a tie or loss into a candidate win while protecting dimensions the candidate already wins. Density repair does not mean adding random inventory. Prefer stronger application, cleaner timing, greater emotional specificity, more memorable staging, sharper opposition, better causal compression, or a fuller payoff.

Also report material structural defects when present, under the most relevant dimension:

- an opening object, threat, gift, promise, or demanded answer never becomes clear or paid
- a power appears without source, rule, acquisition, or relation to the known mechanic
- an object, authority, injury, identity, death, location, or historical fact occupies contradictory states
- important names are difficult to distinguish by ear
- a climax becomes cognitively dense with labels instead of visually legible action

Independently judge every `material_reference_edges` row from the frontier. Return one `edge_verdicts` row per edge ID. A broad dimension win does not erase an edge tie or loss.

Every finding must cite candidate script_sha256, zero-based start_offset, exclusive end_offset, and exact_text. If it cannot be anchored, omit it.

Return JSON only:

{
  "schema": "goldflow_reference_density_dominance_v1",
  "status": "passed|findings",
  "script_sha256": "SHA256",
  "reference_sha256": "SHA256",
  "frontier_sha256": "SHA256",
  "normalization_policy": "viewer_payoff_quality_per_1000_words_and_estimated_spoken_minute_v1",
  "dimensions": [
    {
      "id": "opening_hook",
      "decision": "candidate_win|tie|reference_win",
      "candidate_anchor": {"start_offset": 0, "end_offset": 1, "exact_text": "..."},
      "reference_anchor": {"start_offset": 0, "end_offset": 1, "exact_text": "..."},
      "density_judgment": "...",
      "candidate_advantage_or_gap": "..."
    }
  ],
  "edge_verdicts": [
    {
      "edge_id": "exact edge_id from the frontier",
      "decision": "candidate_win|tie|reference_win",
      "candidate_anchor": {"start_offset": 0, "end_offset": 1, "exact_text": "..."},
      "reference_anchor": {"start_offset": 0, "end_offset": 1, "exact_text": "..."},
      "density_judgment": "...",
      "candidate_advantage_or_gap": "..."
    }
  ],
  "findings": [
    {
      "id": "density_<dimension>_<stable_slug>",
      "dimension_id": "...",
      "edge_id": "the losing edge ID when this finding repairs an edge; omit for dimension-only findings",
      "severity": "material|critical",
      "start_offset": 0,
      "end_offset": 1,
      "exact_text": "...",
      "defect": "...",
      "audience_effect": "...",
      "smallest_repair_intent": "..."
    }
  ]
}

Include exactly these dimension IDs once each: opening_hook, title_fantasy_delivery, power_progression, spectacle_action, emotional_relationship, protagonist_agency, antagonist_pressure, world_visual_variety, middle_propulsion, clarity_naturalness, continuity_integrity, ending_payoff, estimated_apv. `passed` is legal only when all dimension and edge decisions are `candidate_win` and findings is empty.
```
