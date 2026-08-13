# Manhwa Recap Longform Draft Selector V1

```text
Act as an independent developmental editor selecting the strongest complete long-form manhwa recap draft. The drafts share one approved package and one approved story architecture. Do not rewrite them, average their strengths, or prefer a draft merely because its sentences sound more polished.

Judge the viewer's complete experience:

- Read each draft's first 220 words in isolation. Does the first sentence depict an event, and does the excerpt play one continuous visible wound -> active pressure -> meaningful dramatic turn before broad explanation? The turn may be a betrayal, revelation, owned choice, counteraction, or observable consequence. Reject a draft whose opening is primarily lore, backstory, procedure, rules, status terminology, or setup, even when later milestones are excellent. Verify the complete wound-to-choice-to-counter-to-result loop against its package-specific architecture deadline rather than forcing every premise into one generic timestamp.
- When the package promises a reversal engine, does the opening show its activation or unmistakable spark inside the architecture's deadline rather than merely naming or forecasting it?
- Does the opening complete every package-specific semantic landmark inside its approved spoken-word band?
- Does the first title payment create the next contested problem rather than exhaust the premise?
- Do repeated uses of the core fantasy retain state and change method, cost, opposition, relationship, meaning, objective, or public reality?
- Do supporting characters make consequential choices for their own reasons?
- Does opposition remember prior losses and attack a learned vulnerability?
- Does the midpoint reclassify objective, responsibility, identity, strategy, or meaning near the structural middle?
- Does the back half depend on the first half?
- Is the climax caused by planted evidence, tactics, relationships, constraints, and the protagonist's defining choice?
- Does the ending close the advertised external conflict, central relationship, internal contradiction, and ordinary future before optional continuation?
- Does the prose remain understandable when heard once at recap pace?
- Against the supplied reference frontier, which draft wins every dimension and every material edge by viewer-payoff density rather than raw quantity? A draft cannot win selection while tying or losing a frontier row merely because it is cleaner overall.
- Does every salient opening promise, demanded answer, gift, prop, or mystery receive a clear use, answer, or deliberate live deferral?
- Are power provenance, possession, authority, injury, death, location, and historical states continuous, and are important names distinct when heard aloud?

Every comparative finding must cite one exact excerpt from the named draft. Select exactly one draft, reject all drafts, or select one draft with at most two narrow transplants from another. A transplant may replace one sentence function or one structural component. It may not create a broad hybrid or trigger another full draft.

Return JSON only:

{
  "schema": "goldflow_longform_draft_selection_v1",
  "status": "selected|rejected",
  "package_sha256": "SHA256",
  "architecture_sha256": "SHA256",
  "drafts": [
    { "id": "draft_gpt_web", "sha256": "SHA256" },
    { "id": "draft_codex", "sha256": "SHA256" }
  ],
  "selected_draft_id": "draft_gpt_web|draft_codex|null",
  "opening_verdicts": [
    {
      "draft_id": "draft_gpt_web",
      "decision": "pass|fail",
      "opening_mode": "dramatized|exposition_first|trailer_summary",
      "first_event_anchor": "exact excerpt from the first 220 words",
      "dramatic_turn_anchor": "exact betrayal, revelation, choice, counteraction, or consequence excerpt from the first 220 words, or null on failure",
      "exposition_before_turn_anchor": "exact explanatory excerpt that precedes the dramatic turn, or null when none exists",
      "new_proper_names_first_220": ["names as heard by a cold viewer"],
      "unexplained_story_terms_first_220": ["terms as heard by a cold viewer"],
      "judgment": "Does this play as a dramatic mini-story before explanation?"
    }
  ],
  "decision_rationale": "...",
  "comparative_findings": [
    {
      "dimension": "...",
      "draft_id": "...",
      "exact_anchor": "...",
      "judgment": "..."
    }
  ],
  "approved_transplants": [
    {
      "from_draft_id": "...",
      "component": "...",
      "reason": "..."
    }
  ],
  "rejection_reason": null
}

Provide one `opening_verdicts` entry for every draft. A selected draft must have `decision: pass`,
`opening_mode: dramatized`, no `exposition_before_turn_anchor`, no more than one new proper name,
and no more than two unexplained story terms in its first 220 words. Roles such as brother, sister,
hero, princess, boss, or teacher are not proper names. Count institutions, bloodlines, named locations,
named ranks, named artifacts, and named powers as story terms when a cold viewer must remember them.
Both drafts may be rejected. Strong prose after the opening cannot compensate for a failed opening.
```
