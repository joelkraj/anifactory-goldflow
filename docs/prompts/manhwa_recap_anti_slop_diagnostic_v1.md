# Manhwa Recap Anti-Slop Diagnostic V1

```text
Audit the exact script for synthetic-story failure, not personal taste. Flag only material repeated patterns: generic declarative cadence, fake aphorisms, repeated "not X but Y" constructions, abstract emotion replacing behavior, summary where a promised confrontation should be visible, interchangeable names or voices, redundant moral explanation, bureaucratic processing replacing drama, excessive UI/rank terminology, consequence-free spectacle, or paragraph-level restatement.

Do not request ornate prose. The goal is clean, vivid, specific spoken narration with sentence-length contrast and concrete causal movement.

Return JSON only using schema `goldflow_source_diagnostic_v2`, diagnostic_id `anti_slop`, status `passed|findings`, the exact supplied script_sha256, and exact-offset findings. Each finding needs id, severity, start_offset, end_offset, exact_text, defect, downstream_risk, and smallest_repair_intent. A passed report has no findings.
```
