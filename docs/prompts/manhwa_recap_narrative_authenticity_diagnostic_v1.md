# Manhwa Recap Narrative Authenticity Diagnostic V1

```text
Audit the exact current script for material signs of synthetic, templated, or procedurally narrated storytelling. Do not rewrite prose, score isolated words, or report taste preferences.

Judge the script as spoken entertainment. A valid finding must identify a repeated or concentrated pattern that makes a cold viewer feel the narrator is processing an outline instead of telling a dramatic story.

Valid findings include:

- procedure, logistics, rankings, meetings, inventories, rules, or system output narrated as the entertainment rather than compressed around a consequential choice
- repeated narrator interpretation after the scene has already shown the point
- habitual AI-shaped constructions such as serial antithesis, aphoristic verdicts, fragment stacks, rhetorical reversals, or repeated "not X, but Y" sentence architecture
- repeated scene equations such as explanation, receipt, crowd reaction, status update, and consequence with only names or numbers changed
- generic crowd gasps, praise, humiliation, dominance, or reaction montages that do not alter a named relationship or decision
- dialogue in which different characters share the same polished explanatory voice
- recurring characters whose desires, behavior, names, or roles are so generic or interchangeable that they feel generated from stock archetypes
- a cluster of names that is confusing at narration speed, implausibly stylized for the established world, or too similar to distinguish by ear
- repeated supporting-character names carrying high weight in the supplied channel familiarity ledger without story-specific justification; this is a soft freshness concern, never an automatic ban
- narrator self-commentary, writing-room language, retention language, hook labels, chapter planning, or claims about what the story is doing
- faux-specificity: exact numbers, ranks, documents, or named mechanics that add administrative texture without changing action, danger, emotion, or strategy
- repeated institutional resolution: the story cycles through hearings, ledgers, audits, councils, contracts, permissions, testimony, authentication, or official review, even when each individual scene is causally defensible
- planning-artifact leakage: internal ledger, proof, continuity, verification, consent, governance, or responsibility structures become the language and conflict rhythm of the narration
- procedural intelligence substitution: Joey is repeatedly called clever because he preserves records, wins clauses, follows procedure, or persuades officials instead of setting traps, reading people, improvising under danger, or using his premise-native ability ingeniously
- moral-policy dialogue: multiple characters speak like polished ethics reviewers discussing authority, consent, evidence, responsibility, systems, and fairness rather than people with conflicting desires, temperaments, shame, attraction, fear, anger, or self-interest

This is a release-level defect, not a taste note, when institutional or procedural conflict dominates more than one major movement, repeats as the route to victory, occupies the middle at the expense of title-native fantasy, or supplies the climax's decisive proof. Do not excuse it merely because the procedure is logically necessary. Ask whether the same causality could be carried by one short bridge followed by a more visible and emotionally charged event.

Do not file a finding merely because a name appeared somewhere in channel history, a name is common, a familiar trope appears, a sentence is short, a system message exists, or the prose is clear and direct. Respect the ledger's TTL and decay weights. Joey Manhwa is channel canon and must not be renamed. Genre conventions are allowed when the script gives them story-specific behavior and consequence.

Prefer one finding that anchors a representative span and describes the recurring pattern over many duplicate findings. Every finding must cite the exact script_sha256, zero-based start_offset, exclusive end_offset, and exact_text. If an issue cannot be anchored exactly, omit it.

Return JSON only with schema goldflow_source_diagnostic_v2, diagnostic_id narrative_authenticity, status passed|findings, script_sha256, and findings. Each finding contains id, severity material|critical, start_offset, end_offset, exact_text, defect, causal_effect, and smallest_repair_intent.
```
