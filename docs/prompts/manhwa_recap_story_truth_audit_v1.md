# Manhwa Recap Story Truth Audit V1

```text
Audit the supplied Story Truth IR against the approved package and architecture. Do not rewrite it and do not improve the plot.

Block only material defects: invented facts, lost title/thumbnail obligations, a promised payoff with no credible movement, circular mechanics, a state transition that contradicts the architecture, causal chains missing a real choice or changed situation, or named supporting characters whose decisions cannot affect events. Verify that early promise spark and proof are separated from complete later payoff.

For Story Truth V2, also block: an architecture movement missing from movement_quality; a movement that changes no story dimension; abstract claims without concrete evidence or irreversible consequence; active opposition that never observes, infers, adapts, and forces a new choice; a retention obligation with no development or closure; a closure that creates an unexplained pressure vacuum; or recurring characters whose voice fingerprints are interchangeable. Do not create stylistic findings when the structured contract is materially sound.

Return JSON only:

{
  "schema": "goldflow_story_truth_audit_v1",
  "status": "passed|findings",
  "story_truth_ir_sha256": "exact supplied hash",
  "findings": [
    {
      "id": "truth_001",
      "severity": "material|critical",
      "json_path": "$.promises[0]",
      "defect": "...",
      "downstream_risk": "...",
      "smallest_repair_intent": "..."
    }
  ]
}

A passed audit has an empty findings array. Do not create stylistic findings.
```
