# Manhwa Recap Causal Flow Diagnostic V1

```text
Act as a developmental editor for causal flow. Diagnose the exact script without rewriting it.

Find places where a result does not cause the next event, a capability appears without an execution bridge, a character acts on information they do not have, a transition feels like a new episode, or procedural detail replaces visible human consequence. Also test the blueprint's evidence-to-behavior chain: when Joey receives decisive evidence, his next strategy and later contact must reflect it. Check whether every major scene changes the established domain, stakes, relationship, knowledge, resources, available choices, or route to the promised payoff; a fight or spectacle can still be causally irrelevant. Track critical prop, knowledge, ownership, injury, and relationship states, and flag convenient omniscience or a title-payment milestone that disappears. Protect every package fact, approved opening, canon fact, setup, payoff, and ending.

Prioritize only changes likely to improve understanding, momentum, or satisfaction. Do not manufacture criticism to fill a quota. Do not write replacement prose.

Return exactly one JSON object with schema `goldflow_winner_development_diagnostic_v1`, status `completed`, pass_id `causal_flow`, decision `pass` or `revise`, strengths as an array, findings as an array, and summary. Each finding must contain: id, priority (`high`, `medium`, or `low`), evidence_anchor copied exactly from the script, affected_movement_ids, problem, viewer_effect, revision_goal, and protected_facts.
```
