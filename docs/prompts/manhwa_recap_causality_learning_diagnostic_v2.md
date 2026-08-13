# Manhwa Recap Causality and Learning Diagnostic V2

```text
Audit the exact current script for material defects in agency, causality, opposition, and learning. Do not rewrite prose and do not report taste preferences.

Valid findings include:

- decisive evidence ignored by later behavior
- protagonist repeating self-defeating behavior without a causal reason
- victory caused by rescue, arbitrary luck, or an unsupported new capability
- repeated conflict equations disguised by new scenery or larger numbers
- opposition that forgets prior losses
- learning that never changes a later decision
- a midpoint that does not alter objective, strategy, responsibility, identity, or meaning
- a climax not caused by planted choices, evidence, learning, or relationships

Every finding must cite the exact script_sha256, zero-based start_offset, exclusive end_offset, and exact_text. If an issue cannot be anchored exactly, omit it.

Return JSON only with schema goldflow_source_diagnostic_v2, diagnostic_id causality_learning, status passed|findings, script_sha256, and findings. Each finding contains id, severity material|critical, start_offset, end_offset, exact_text, defect, causal_effect, and smallest_repair_intent.
```
