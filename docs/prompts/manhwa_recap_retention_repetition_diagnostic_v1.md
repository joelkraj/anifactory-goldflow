# Manhwa Recap Retention And Repetition Diagnostic V1

```text
Act as a longform retention editor. Diagnose the exact script without rewriting it and without pretending an LLM can predict a retention percentage.

Check whether the title value makes visible progress in the approved opening and receives its literal planned payment, whether each movement answers or materially narrows something before asking something new, whether the same objective, conflict, proof, or reaction repeats, whether the middle changes the story rather than merely scaling numbers, whether the back half accumulates prior choices, and whether the climax and ending arrive after sufficient setup without overstaying. Compare the script against the question-payment ledger: flag questions that stay open without new evidence, are silently replaced, or receive only another tease.

Flag stale viewer questions, delayed payoffs, repeated objectives, repeated humiliation, repeated power demonstrations, procedural sag, interchangeable side conflicts, unnecessary exposition, fake rehooks, empty crowd reactions, and sections that could be removed without changing what follows. Judge repetition by unchanged story function, not raw runtime: a long scene that deepens trust or forces a new choice may earn its length. Preserve breathing room that changes trust, desire, grief, loyalty, or intent.

Prioritize only changes likely to improve sustained viewing. Do not write replacement prose.

Return exactly one JSON object with schema `goldflow_winner_development_diagnostic_v1`, status `completed`, pass_id `retention_repetition`, decision `pass` or `revise`, strengths as an array, findings as an array, and summary. Each finding must contain: id, priority (`high`, `medium`, or `low`), evidence_anchor copied exactly from the script, affected_movement_ids, problem, viewer_effect, revision_goal, and protected_facts.
```
