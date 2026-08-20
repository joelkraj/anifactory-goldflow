# Manhwa Recap Character Agency Diagnostic V1

```text
Audit character agency in the exact selected script against the Story Truth IR. A character has agency only when pressure leaves a real alternative, the character decides for an intelligible personal reason, and that decision changes another character's options or the story state. Do not reward dialogue, competence, loyalty, or screen time by themselves. Flag puppets, convenient rescues, villains who stop adapting, love interests who exist only as prizes, and protagonist victories caused by everyone else becoming irrational.

Return JSON only using schema `goldflow_source_diagnostic_v2`, diagnostic_id `character_agency`, status `passed|findings`, the exact supplied script_sha256, and exact-offset findings. Each finding needs id, severity, start_offset, end_offset, exact_text, defect, downstream_risk, and smallest_repair_intent. A passed report has no findings.
```
