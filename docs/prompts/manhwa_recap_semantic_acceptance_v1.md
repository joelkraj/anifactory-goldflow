# Manhwa Recap Semantic Acceptance V1

```text
Perform final semantic acceptance on the exact revised script. This is a binary verification pass, not a rewrite and not a scorecard.

Verify all requirements:

- `opening_event_before_exposition`: the first sentence depicts a visible event, and broad explanation does not precede active conflict
- `opening_dramatic_loop_complete`: the first approximately 220 words contain a continuous visible wound, active pressure, and meaningful dramatic turn rather than a milestone summary, and the complete owned-choice-to-counter-to-result loop closes by its package-specific architecture deadline
- `opening_engine_deadline_met`: the package-native reversal engine activates or unmistakably sparks within the approved opening deadline
- title and thumbnail promise is literally and emotionally paid
- title event remains consequential afterward
- major state changes follow from owned protagonist choices
- decisive evidence is remembered and acted upon
- major loops alter the conflict equation
- learning changes later choices and contributes to the climax
- opposition adapts to observed events
- identities, relationships, knowledge, injuries, possessions, rules, and public facts remain continuous
- midpoint changes objective, strategy, responsibility, identity, or meaning
- climax is caused by planted evidence, accumulated relationships, learned tactics, and the protagonist's defining choice
- external conflict receives local resolution
- central relationship receives changed-state resolution
- internal contradiction receives an answer
- ordinary-future behavior proves change
- unresolved world questions invite continuation without an abrupt cutoff
- `procedural_scene_share_acceptable`: unless the approved package explicitly sells an institutional fantasy, no more than one major story movement is primarily a hearing, council, audit, negotiation, contract, trial, records review, permission-gathering sequence, or comparable administrative process
- `procedure_not_victory_engine`: paperwork, authentication, votes, rulings, official permission, or bureaucratic compliance never supplies the decisive satisfying defeat of a major opponent
- `planning_artifacts_absent_from_prose`: internal ledgers, evidence structures, continuity tracking, proof obligations, governance rules, and responsibility frameworks do not leak into repeated narration patterns or polished policy dialogue
- `title_fantasy_sustained`: every major act, including the middle and ending, contains a visible title-native application, superiority turn, escalation, or spectacle payoff rather than replacing the clicked fantasy with reflection or administration
- `human_voice_over_policy_voice`: recurring characters primarily speak and act from distinct desire, fear, resentment, affection, pride, shame, or self-interest rather than sharing an abstract ethics-and-governance vocabulary
- `opening_promises_resolved`: every salient opening promise, demanded answer, gift, prop, threat, or mystery is clarified, used, paid, or deliberately deferred as a live question
- `power_provenance_clear`: every decisive power is clearly innate, stolen, learned, derived, or granted before its second decisive use
- `cold_listener_comprehension`: at narration speed, every central mechanic and recurring coined term has one stable plain-language mental model: input or trigger, observable output, limit or cost, and present story purpose. Naming or repeatedly using a mechanic is not an explanation. A later expansion must visibly follow or explicitly update the established rule.
- `terminology_unambiguous_by_ear`: technique names, steps, timing units, costs, failure states, and ordinary uses of the same word remain distinguishable in one forward listen. The listener never needs to reread or wait for later context to decode the current action.
- `story_orientation_continuous`: throughout the opening, early story, middle, and ending, a one-pass listener can state the protagonist's current goal, immediate obstacle, and present location or situation, plus the change that ended the prior loop. A later explanation cannot retroactively repair a confusing current scene.
- `possession_and_history_continuity`: possession, authority, injury, identity, death, location, and historical states are mutually compatible
- `auditory_name_distinction`: important recurring names are distinguishable when heard once at narration speed
- `reference_density_dominance`: when a reference frontier is supplied, the revised candidate wins every required dimension and material edge by viewer-payoff quality per 1,000 words and per estimated spoken minute; raw runtime and raw event totals never count

When a reference frontier is supplied, independently rejudge all thirteen frontier dimensions and every dynamic material reference edge against the exact revised script and exact reference transcript. Return `reference_density_verdicts` for dimensions and `reference_edge_verdicts` for edges using the same exact-anchor structure as the density diagnostic. Add one requirement row named `reference_density_<dimension_id>` for every dimension and `reference_edge_<edge_id>` for every edge. Acceptance requires `candidate_win` on all rows; a tie is a failure.

Every failed requirement must cite exact script_sha256, zero-based start_offset, exclusive end_offset, and exact_text. Unanchored failures are invalid.

Return JSON only:

{
  "schema": "goldflow_source_semantic_acceptance_v1",
  "status": "accepted|repair",
  "script_sha256": "SHA256",
  "reference_sha256": "SHA256 when a frontier is supplied",
  "reference_merit_frontier_sha256": "SHA256 when a frontier is supplied",
  "reference_density_diagnostic_sha256": "SHA256 when a frontier is supplied",
  "requirements": [{"id": "...", "decision": "pass|fail"}],
  "cold_listener_comprehension": {
    "decision": "pass|fail",
    "current_objective_plain_language": "what the protagonist is trying to accomplish now",
    "central_concepts": [{
      "spoken_name": "exact recurring mechanic or coined term",
      "input_or_trigger": "plain-language activation or supplied input",
      "observable_output": "what the audience can see it do",
      "limit_or_cost": "stable boundary, tradeoff, or none established",
      "why_it_matters_now": "connection to the current objective",
      "first_clear_anchor": {"start_offset": 0, "end_offset": 1, "exact_text": "..."},
      "distinct_from": ["adjacent terms a listener must not confuse with this one"]
    }],
    "orientation_checkpoints": [{
      "section_label": "opening|early_story|middle|ending",
      "current_goal": "plain-language immediate goal",
      "immediate_obstacle": "plain-language immediate opposition",
      "current_location_or_context": "where or under what present situation this occurs",
      "what_changed": "the changed fact that moved the story here",
      "anchor": {"start_offset": 0, "end_offset": 1, "exact_text": "..."}
    }],
    "confusion_points": [{"start_offset": 0, "end_offset": 1, "exact_text": "...", "reason": "..."}]
  },
  "reference_density_verdicts": [
    {
      "id": "opening_hook",
      "decision": "candidate_win|tie|reference_win",
      "candidate_anchor": {"start_offset": 0, "end_offset": 1, "exact_text": "..."},
      "reference_anchor": {"start_offset": 0, "end_offset": 1, "exact_text": "..."},
      "density_judgment": "...",
      "candidate_advantage_or_gap": "..."
    }
  ],
  "reference_edge_verdicts": [
    {
      "edge_id": "exact edge_id from the frontier",
      "decision": "candidate_win|tie|reference_win",
      "candidate_anchor": {"start_offset": 0, "end_offset": 1, "exact_text": "..."},
      "reference_anchor": {"start_offset": 0, "end_offset": 1, "exact_text": "..."},
      "density_judgment": "...",
      "candidate_advantage_or_gap": "..."
    }
  ],
  "anchored_failures": []
}

When a frontier is supplied, each `reference_density_<dimension_id>` and `reference_edge_<edge_id>` requirement must be `pass` exactly when its verdict is `candidate_win`, and `reference_density_dominance` must be `pass` exactly when every dimension and edge wins. Acceptance requires every requirement to pass.

`cold_listener_comprehension` is absolute, not comparative. A candidate cannot pass it merely by being clearer than the reference. Set its decision to `fail`, set all comprehension requirements to `fail`, and anchor every material confusion point when a first-time listener cannot correctly explain a recurring concept or current story orientation at the moment it governs a choice or result. Include at least one orientation checkpoint for opening, early story, middle, and ending.
```
