# Manhwa Recap Story Truth IR V2

```text
Build the immutable Story Truth intermediate representation for the approved manhwa package, treatment, and architecture. This is not narration and not a second architecture. It is the compact causal and continuity truth every draft, diagnosis, revision, viewer test, and analytics pass must share.

Preserve the approved story exactly. Do not add twists, characters, powers, scenes, or outcomes. Resolve ambiguity by making the architecture's intended causal meaning explicit, never by inventing a more interesting answer.

Promise timing has three separate obligations. The clicked promise must spark early, receive visible first proof early, and may receive its complete emotional or external payoff much later. Do not confuse early proof with final resolution. Every setup must have a payoff deadline or an explicit deliberate-live deferral.

Every major causal chain must use this exact grammar:
pressure -> owned choice -> consequence -> counteraction -> changed situation.

Supporting characters need agency: a desire, pressure, a real alternative, a decision, and a consequence that changes the story. List mechanics as observable rules a listener can understand by ear. Track injury, resources, possession, authority, location, knowledge, relationships, identity, public status, and mechanic state whenever they change.

Build one retention-obligation map across the complete architecture. Every open loop, promise, question, threat, relationship pressure, and fantasy payoff needs an opening point, one or more development points, a closure point, and either a named replacement obligation or null. Closing an obligation without replacing pressure must be an intentional payoff, not a dead zone.

Write exactly one movement-quality row for every architecture movement. Every movement must change at least one of goal, danger, power, relationship, mystery, status, choice, consequence, or payoff. Name the concrete evidence or remembered object and the irreversible consequence. Mark explanation or procedural-reporting risk honestly. Where opposition is active, record who observed what, what they inferred, how they changed tactics, and what new choice they forced.

Give every recurring consequential character a voice fingerprint. Make vocabulary, sentence shape, emotional avoidance, humor, values, and decision style distinct enough that later dialogue can be tested for reassignment. Do not turn the fingerprint itself into narration.

Return JSON only:

{
  "schema": "goldflow_story_truth_ir_v2",
  "status": "locked",
  "package_sha256": "...",
  "selected_treatment_sha256": "...",
  "architecture_sha256": "...",
  "promises": [
    {
      "id": "promise_01",
      "source": "title|thumbnail|premise|treatment",
      "promise": "...",
      "visible_receipt": "what visibly proves payment",
      "spark_deadline_word": 300,
      "spark_movement_id": "...",
      "first_proof_deadline_word": 900,
      "first_proof_movement_id": "...",
      "escalation_movement_ids": ["..."],
      "full_payoff_deadline_word": 10000,
      "full_payoff_movement_id": "..."
    }
  ],
  "causal_chains": [
    {
      "id": "causal_01",
      "pressure": "...",
      "choice": "...",
      "owned_choice": true,
      "consequence": "...",
      "counter": "...",
      "changed_situation": "...",
      "movement_ids": ["..."]
    }
  ],
  "character_agency": [
    {
      "id": "agency_01",
      "character": "...",
      "desire": "...",
      "pressure": "...",
      "decision": "...",
      "alternative_rejected": "...",
      "consequence": "...",
      "movement_id": "..."
    }
  ],
  "setup_payoffs": [
    {
      "id": "setup_01",
      "setup": "...",
      "setup_movement_id": "...",
      "payoff": "...",
      "payoff_movement_id": "...",
      "payoff_deadline_word": 9000,
      "deferral": "none|deliberate_live",
      "deferral_reason": null
    }
  ],
  "mechanic_rules": [
    {
      "id": "mechanic_01",
      "spoken_name": "...",
      "trigger_or_input": "...",
      "observable_output": "...",
      "limit_or_cost": "...",
      "provenance": "...",
      "first_clear_movement_id": "..."
    }
  ],
  "state_transitions": [
    {
      "id": "state_01",
      "subject": "...",
      "state_type": "injury|resource|possession|authority|location|knowledge|relationship|identity|public_status|mechanic",
      "from": "...",
      "to": "...",
      "cause": "...",
      "movement_id": "..."
    }
  ],
  "reveals": [
    {
      "id": "reveal_01",
      "knowledge": "...",
      "knower_before": "...",
      "knower_after": "...",
      "movement_id": "...",
      "behavior_change": "..."
    }
  ],
  "retention_obligations": [
    {
      "id": "retention_01",
      "type": "open_loop|promise|question|threat|relationship_pressure|fantasy_payoff",
      "obligation": "...",
      "source_truth_ids": ["promise_01|reveal_01|setup_01|causal_01"],
      "open_deadline_word": 300,
      "open_movement_id": "...",
      "development_movement_ids": ["..."],
      "closure_deadline_word": 9000,
      "closure_movement_id": "...",
      "visible_or_spoken_receipt": "...",
      "replacement_obligation_id": "retention_02_or_null"
    }
  ],
  "movement_quality": [
    {
      "id": "movement_quality_01",
      "movement_id": "exact architecture movement id",
      "changed_dimensions": ["goal|danger|power|relationship|mystery|status|choice|consequence|payoff"],
      "new_pressure_or_reward": "...",
      "specific_evidence_or_object": "...",
      "irreversible_consequence": "...",
      "redundant_explanation_risk": "none|low|material",
      "procedural_reporting_risk": "none|low|material",
      "antagonist_counterplay": {
        "applicable": true,
        "observer": "...",
        "observation": "...",
        "inference": "...",
        "changed_tactic": "...",
        "forced_choice": "...",
        "not_applicable_reason": null
      }
    }
  ],
  "character_voice_fingerprints": [
    {
      "id": "voice_01",
      "character": "...",
      "role": "...",
      "vocabulary": "...",
      "sentence_shape": "...",
      "emotional_avoidance": "...",
      "humor": "...",
      "values": "...",
      "decision_style": "...",
      "contrast_with": "...",
      "forbidden_generic_modes": ["...", "..."]
    }
  ],
  "narration_constraints": {
    "protected_facts": ["facts no prose pass may change"],
    "spoken_clarity_rules": ["distinctions a one-pass listener must hear"],
    "pronunciation_risks": ["names or terms needing later voice attention"]
  }
}

Return every architecture movement exactly once in movement_quality. A movement that only preserves state is a defect; repair the architecture rather than disguising it with prose.
```
