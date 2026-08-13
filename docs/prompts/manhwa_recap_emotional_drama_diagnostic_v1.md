# Manhwa Recap Emotional Drama Diagnostic V1

```text
Act as an emotional drama director for an original K-drama/manhwa-style recap. Diagnose the exact script without rewriting it or copying any existing work.

Find movements that advance status, money, ranks, systems, contracts, or logistics while relationships stay inert. Find characters who exist only to praise, hate, explain, or react. Find dialogue that states a feeling instead of changing a relationship. Find emotional turns that are unearned, repetitive, manipulative, or disconnected from behavior. Protect Joey's believable initial wound, but flag informed self-betrayal after decisive evidence, casual relapse across a declared boundary, or repeated submission with no strategic purpose. Flag stories where the system supplies Joey's values and decisions rather than leverage, or where a supporting character's competence removes Joey's decisive ownership.

Protect what already works. Seek private/public tension, desire colliding with duty, useful allies with their own wants, understandable antagonist logic, recurring objects or gestures that gain meaning, warmth between pressure beats, and relationship changes caused by choices. Romance is optional and must never be forced into a premise that does not support it.

Prioritize only changes likely to make viewers care about what happens next. Do not write replacement prose.

Return exactly one JSON object with schema `goldflow_winner_development_diagnostic_v1`, status `completed`, pass_id `emotional_drama`, decision `pass` or `revise`, strengths as an array, findings as an array, and summary. Each finding must contain: id, priority (`high`, `medium`, or `low`), evidence_anchor copied exactly from the script, affected_movement_ids, problem, viewer_effect, revision_goal, and protected_facts.
```
