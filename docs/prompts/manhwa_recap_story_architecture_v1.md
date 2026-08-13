# Manhwa Recap Story Architecture V1

```text
Build one unified architecture for an approximately 10,000-word spoken manhwa-style story. Consume the approved package, selected treatment, evidence registry, and relevant story bibles. Do not produce narration.

Use 10-14 flexible movements. They do not need equal word quotas. Do not pad or amputate the story to hit an exact number.

The architecture must preserve:

- title and thumbnail promise
- literal early, repeated, and final title payments
- protagonist contradiction, human desire, value, vulnerability, and owned-choice pattern
- mechanic/world constraints and facts the story must never contradict
- one accumulating central relationship
- an opposition ladder that remembers and changes tactics
- a learning ledger connecting discovery, cost, and later changed behavior
- a midpoint reclassification
- a climax caused by earlier choices, evidence, learning, and relationships
- external, relational, internal, and ordinary-future closure

The supplied reference merit frontier is binding whenever present. Build a `merit_dominance_contract` that exceeds every frontier dimension and every dynamic `material_reference_edges` row by viewer-payoff quality per 1,000 words and per estimated spoken minute. Raw quantity never satisfies this contract: more total powers, fights, locations, heroines, twists, or runtime do not count unless each unit of narration delivers a stronger experience. Map every dimension and every material edge to concrete movements and a visible proof shape. Preserve the reference's viewer appetite while changing its plot skin, characters, world, wording, and scene design.

Internal planning artifacts are not story content. A `learning_ledger`, `continuity_ledger`, proof obligation, or state contract may help the writer remember causality, but the architecture must not turn those structures into repeated hearings, audits, councils, contracts, legal review, authenticated records, permissions, testimony, or paperwork scenes. Unless the approved package and measured outlier prove that bureaucracy itself is the clicked fantasy, institutional procedure may appear only as a brief causal bridge into a visible confrontation, dangerous choice, intimate rupture, ingenious power use, betrayal, rescue, or public reversal. Do not use procedure as a recurring conflict mode, escalation ladder, midpoint engine, climax solution, or primary proof that Joey is intelligent.

Across the movements, administrative conflict may support at most one major dramatic set piece. If facts or receipts matter afterward, reveal or contest them through physical discovery, live supernatural proof, a character betraying another, a public power demonstration, or an opponent's observable reaction. Compress subsequent processing to one or two causal sentences. Design at least one title-native power application or desirable superiority turn in every major act, including the middle, and make the final emotional resolution follow a concrete spectacle payoff rather than replace it.

Use the supplied channel name-familiarity ledger as a soft recency signal. Higher weights mean prefer a different natural, story-appropriate supporting-character name when choices are otherwise equal. No name is forbidden, and names outside the TTL carry no penalty. Reuse is valid when the name materially suits the character or identifies an approved recurring series character. Joey Manhwa is fixed channel canon.

Use stateful repetition. A recurring fantasy is allowed only when it retains and changes consequences, allies, enemies, knowledge, obligations, injuries, public facts, or relationships. A new location, rank, object, or payout does not make a repeated equation new.

The opening contract is a binding dramatic cold-open contract, not a milestone checklist. Set
`opening_semantic_contract.version` to `dramatic_cold_open_v2` and specify all of the following:

- `first_sentence_event`: the visible action, injury, humiliation, threat, impossible result, or bodily consequence happening in the first sentence. A setting description, family history, rule, status label, or unexplained fantasy noun is not an event.
- `cold_open_loop`: one continuous `visible_wound`, `active_pressure`, `owned_choice`, `counteraction`, `observable_result`, and `next_question`. The viewer must experience this miniature story before receiving broad world, bloodline, institutional, mechanic, or historical explanation.
- `by_approximately_30_seconds`: the title-native wound or contradiction is visible, someone is doing something under pressure, and the protagonist has immediate direction.
- `by_approximately_60_seconds`: the protagonist has made an owned choice and begun a counteraction. When the package promises a system, stolen talent, regression, hidden identity, supernatural bond, or comparable reversal engine, its reveal or first unmistakable spark belongs here unless the package's cited winning analogue proves a later reveal while sustaining active danger.
- `by_approximately_90_seconds`: the cold-open loop has produced an observable changed state and opened the next contested question. The opening may continue escalating, but it may no longer be pure setup.
- `by_approximately_3_minutes`: the package engine has produced visible proof rather than only a label, forecast, explanation, or UI announcement.
- `by_approximately_5_minutes`: the first larger causal unit closes in a changed state and the second contested loop begins.
- `exposition_release_point`: the exact result after which broader lore may enter, plus the minimum causal facts needed before that point. Before it, use no more than one new proper name, two unexplained story terms, and one short explanatory sentence at a time.

Do not design an opening that requires the viewer to understand inheritance procedure, faction hierarchy,
bloodline history, legal rules, rank taxonomy, or a system manual before the counteraction. If those facts are
important, reveal them after the viewer has watched the protagonist suffer, choose, act, and change something.

Return JSON only using schema goldflow_story_architecture_v1. Include package_sha256, selected_treatment_sha256, name_familiarity_ledger_sha256, target_word_range, opening_semantic_contract, protagonist_contract, character_name_plan, mechanic_and_world_constraints, relationship_ladder, opposition_ladder, learning_ledger, continuity_ledger, climax_proof_obligations, closure_contract, and movements. When a reference frontier is supplied, also include `reference_merit_frontier_sha256` and `merit_dominance_contract` with the exact normalization policy, one `dimension_obligations` row per required frontier dimension, and one `edge_obligations` row per supplied material edge. Dimension rows contain `id`, `candidate_strategy`, `proof_shape`, and valid `movement_ids`; edge rows use `edge_id` with those same fields.

`character_name_plan` contains every recurring named character with `name`, `role`, `voice_or_behavior_distinction`, `reuse_disposition` (`new`, `intentional_reuse`, or `series_recurring`), and `selection_rationale`. A recent familiar name may still be selected, but `intentional_reuse` must explain why it fits better than a natural alternative. Do not include unnamed crowds or one-line functionaries.

Every movement has exactly these creative fields:

- id
- entering_state
- protagonist_choice
- consequence_and_changed_state
- relationship_opposition_or_learning_change
- promise_or_viewer_question_movement
- continuity_constraints

Do not duplicate the architecture into a second retention map.
```
