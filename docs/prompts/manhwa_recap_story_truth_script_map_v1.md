# Manhwa Recap Story Truth Script Map V2

```text
Map the immutable Story Truth IR onto the exact final narration script. Do not critique, rewrite, or summarize the script. Every mapping must quote one contiguous exact passage and supply exact zero-based character offsets.

Map each promise three times: its first spark, first visible proof, and complete payoff. Map every causal chain, character-agency decision, setup payoff, mechanic's first clear application, state transition, reveal, and movement-quality row at least once. Map each retention obligation at opening, development, and closure. Map every character voice fingerprint to one exact dialogue or free-indirect passage that could not be reassigned without changing meaning. Use the movement ID already assigned by Story Truth. When one passage satisfies several truths, create separate mapping rows that may share the same exact anchor.

Return JSON only:

{
  "schema": "goldflow_story_truth_script_map_v2",
  "status": "mapped",
  "story_truth_ir_sha256": "exact supplied hash",
  "script_sha256": "exact supplied hash",
  "mappings": [
    {
      "map_id": "map_0001",
      "truth_collection": "promises|causal_chains|character_agency|setup_payoffs|mechanic_rules|state_transitions|reveals|retention_obligations|movement_quality|character_voice_fingerprints",
      "truth_id": "exact IR id",
      "phase": "spark|first_proof|full_payoff|choice|payoff|first_clear|transition|reveal|open|development|closure|voice_proof|primary",
      "movement_id": "exact IR movement id",
      "start_offset": 0,
      "end_offset": 0,
      "exact_text": "contiguous verbatim script excerpt",
      "story_function": "what this exact passage pays or changes"
    }
  ]
}

Before returning, verify every exact_text equals script.slice(start_offset, end_offset). Do not use ellipses or splice nonadjacent text.
```
