# Manhwa Recap Treatment Bakeoff V1

Use this prompt after one exact package hash is approved. The three treatments must preserve the package while testing different human engines.

```text
You are a developmental story architect. Write three anonymous treatments for the exact approved package. Each treatment must be 800-1,200 words. These are compact causal stories, not narration, beat lists, or prose samples.

Locked across all treatments:

- title and thumbnail receipt
- central contradiction
- protagonist's human desire
- first owned choice
- literal title-payment obligation
- established world/mechanic constraints

When a reference merit frontier is supplied, each treatment must describe a route to beat every fixed dimension and every dynamic material reference edge by viewer-payoff quality per unit of narration. Raw quantity is irrelevant: do not answer a longer reference with more powers, more fights, more locations, or more characters. Win through stronger applications, sharper human turns, more memorable staging, cleaner escalation, and fuller payoff while preserving an original plot.

The treatments must differ materially in:

- causal engine and source of escalating pressure
- opposition logic and how it learns
- central relationship and cost
- midpoint reclassification
- climax causality
- local closure

Changing locations, monsters, ranks, fights, or supporting-character names is not meaningful variation.

Treatment A is a Boundary Drama. Ask what happens when the protagonist stops accepting the old relationship contract.

Treatment B is an Adaptive Contest. Ask what the opponent does after the protagonist proves the previous tactic no longer works. Every counter-move must alter a relationship, value, obligation, or choice.

Treatment C is a Reclassification Drama. Ask what the protagonist discovers near the midpoint that changes the meaning of the opening wound and victory. Do not use a generic bigger conspiracy.

Every treatment must include:

- the first causal unit through approximately five spoken minutes
- one accumulating central relationship with an independently motivated character
- one opposition ladder with memory
- changing uses of the title engine
- a relationship rupture caused by choices
- protagonist learning that changes a later method
- a midpoint that changes objective, responsibility, identity, or meaning
- a climax caused by planted choices, evidence, relationships, and learning
- external, relational, internal, and ordinary-future closure
- the treatment's primary failure risk

Return JSON only:

{
  "schema": "goldflow_treatment_bakeoff_v1",
  "status": "planned",
  "package_sha256": "SHA256",
  "treatments": [
    {
      "id": "treatment_a",
      "engine": "boundary_drama",
      "treatment": "800-1,200 word treatment",
      "central_relationship": "...",
      "opposition_learning_pattern": "...",
      "midpoint_reclassification": "...",
      "climax_causality": "...",
      "closure_contract": "...",
      "primary_failure_risk": "..."
    },
    {
      "id": "treatment_b",
      "engine": "adaptive_contest",
      "treatment": "..."
    },
    {
      "id": "treatment_c",
      "engine": "reclassification_drama",
      "treatment": "..."
    }
  ]
}
```
