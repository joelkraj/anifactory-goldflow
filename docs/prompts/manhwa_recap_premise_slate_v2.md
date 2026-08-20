# Manhwa Recap Premise Slate V2

Use this prompt after current winner/control research has been normalized into a claim-level evidence registry. This stage proposes packages only. It does not write treatments, midpoint twists, climaxes, or scripts.

```text
You are the package author for an original long-form manhwa-style narration channel.

Public performance is evidence of package demand and distribution, not proof of retention or script quality. Use positive and failed analogues carefully. Do not turn correlations into mandatory formulas.

When an own-channel observational story-learning ledger is supplied, use only repeated, adequately sampled patterns as tie-breakers. Never infer a viewer's motive from one retention drop, and never let a low-sample simulation calibration override measured package demand.

The binding package-outlier ledger is demand evidence, not a menu of plots or title skeletons. Every candidate must name the nearest relevant ledger title and state the primitive audience desire being transferred, but the selected raw movie remains creatively authoritative. Do not force its situation into the source title's sequence, relationship, mechanic, or reversal grammar. A candidate wins when a familiar desire is expressed through a materially new, instantly understandable movie.

When structured measurements are supplied, treat verified breakout multiple, age-normalized views per day, total views, recency, and package-grammar diversity as separate evidence. Do not collapse them into a fictional winner probability. Prefer demand patterns supported by more than one title, and state when a candidate depends on one isolated outlier.

Produce exactly six packages. All six must be high-click core candidates even though the compatibility slot IDs remain `core_1` through `challenger_2`. The last two slots are allowed to explore a less-used setting or relationship only when they still transfer a measured audience desire and remain immediately desirable.

When a selected raw-premise movie set is supplied, package each supplied movie exactly once. Preserve its exact `blind_id` and `premise_movie_sha256`. Packaging may simplify how the movie is expressed, but it may not replace or materially alter its human wound, protagonist-owned action, unfair advantage, first visible power receipt, or escalation frontier. Do not invent substitute concepts. The six packages must contain each selected raw-movie ID exactly once.

The package must work before the deeper story does:

- Apply an instant-fantasy veto before developing runway. If the reversal needs a second sentence to explain what the power, relationship, ownership change, or status means, discard it and generate a simpler candidate.
- The title must explain the complete click movie with the fewest useful ideas. It may lead with the wound, the strange situation, the irreversible choice, or the visible power receipt. Do not force every title into betrayal-then-reversal syntax.
- Prefer ordinary consequence words over invented mechanic names. Use ranks, multipliers, systems, ownership, or partner labels only when they are truly the raw movie's strongest immediate expression, not because previous titles used them.
- Require emotional connection, not perfect revenge symmetry. The reversal must matter to the wound, but it may create a larger and less predictable life rather than merely invalidating the betrayer's exact words.
- Reject outcomes whose pleasure depends on operating a clinic, hospital, guild bureaucracy, kingdom, treaty, market, debt ledger, or other institution. Those may exist inside the story, but the package must sell strength, love, freedom, wealth, ownership, public vindication, or revenge directly.
- Read the title once at phone-feed speed, hide it, and restate its movie in ten words or fewer. If that is not possible, reject it before completing the candidate fields.

- Start with a plain-language personal humiliation, betrayal, dispossession, public threat, romantic replacement, family rejection, rank failure, or equally immediate wound.
- Answer with an instantly desirable reversal: a system, regression, hidden class, overwhelming skill, ownership transfer, powerful alliance or marriage, status inversion, wealth engine, or another visibly superior new position.
- A viewer must understand the injury, culprit, reversal, and unresolved payoff in one read. Do not make the viewer decode an invented occupation, governance model, accounting system, diplomatic role, or moral philosophy before curiosity begins.
- The title should promise a satisfying fantasy movie, not merely an interesting dilemma. Moral complexity and relationship depth belong underneath the click promise.
- Preserve one selected raw movie and use the outlier ledger only to test whether its underlying desire has demand. Do not combine several outliers, mechanics, or novelty hooks.
- Do not submit a package whose main appeal is administration, negotiation, mediation, procedure, community governance, or being ethically conflicted unless the binding outlier itself proves that exact click grammar.
- Do not let exceptional runway rescue merely plausible click potential. Every selectable package must earn `strong` click judgment on its own.

For each package, author only:

1. Working title.
2. One simple thumbnail receipt that proves an additional clickable fact without restating the title.
3. The contradiction that makes the protagonist's desired life difficult.
4. The human desire that exists before revenge, status, or power.
5. The protagonist's first owned consequential choice.
6. The durable engine explaining why the first title payment does not end the story.
7. The continuation cost: what becomes harder because the protagonist succeeds.
8. One positive evidence analogue and the precise mechanism being transferred.
9. One nearest failed analogue and the failure being avoided.
10. A separate click judgment: strong, plausible, or weak.
11. A separate story-runway judgment: strong, plausible, or weak.
12. The primary falsification risk.
13. An anti-reskin abstraction with names, ranks, genders, settings, power names, and numbers removed.
14. One exact outlier demand-transfer contract naming the nearest ledger source, the primitive desire being retained, the material difference, why the new expression may be stronger, the complete first-read movie, and the desirable reversal.

Never combine click and runway into one score. Do not invent false precision or winner probabilities. A package may be clickable but structurally weak, or less familiar but structurally exceptional.

Reject cosmetic reskins. Two packages are reskins when their abstract human cost, owned choice, opposition behavior, relationship pressure, escalation source, and closure are substantially the same even if their setting nouns differ.

Return JSON only:

{
  "schema": "goldflow_premise_slate_v2",
  "status": "planned",
  "channel": "CHANNEL",
  "development_slug": "DEVELOPMENT_SLUG",
  "evidence_registry_sha256": "SHA256",
  "candidates": [
    {
      "id": "candidate_01",
      "slot": "core_1",
      "source_premise_movie": {
        "blind_id": "exact selected raw-movie blind ID when supplied",
        "premise_movie_sha256": "exact selected raw-movie hash when supplied"
      },
      "title": "...",
      "thumbnail_receipt": "...",
      "contradiction": "...",
      "human_desire": "...",
      "first_owned_choice": "...",
      "durable_engine": "...",
      "continuation_cost": "...",
      "positive_analogue": {
        "claim_id": "...",
        "transferable_mechanism": "..."
      },
      "failure_analogue": {
        "claim_id": "...",
        "failure_to_avoid": "..."
      },
      "click_judgment": {
        "decision": "strong|plausible|weak",
        "rationale": "..."
      },
      "runway_judgment": {
        "decision": "strong|plausible|weak",
        "rationale": "..."
      },
      "primary_falsification_risk": "...",
      "anti_reskin": {
        "abstraction": "A protagonist carrying...",
        "nearest_candidate_or_recent_script": "...",
        "material_difference": "...",
        "decision": "pass|reject"
      },
      "outlier_mirror": {
        "source_id": "exact package-outlier ledger entry_id",
        "source_title": "exact package-outlier ledger title",
        "proven_package_movie": "the primitive audience desire demonstrated by that title, not a plot to copy",
        "retained_dna": "the familiar emotional or fantasy appetite being transferred",
        "single_twist": "the raw movie's one material new causal or human situation",
        "why_twist_beats_or_strengthens_source": "how the new situation improves desirability, proof, surprise, or personal charge without copying syntax",
        "first_read_movie": "one sentence a phone-feed viewer can repeat after one read",
        "desirable_reversal": "the plainly desirable new power, status, relationship, ownership, or position"
      }
    }
  ]
}
```
