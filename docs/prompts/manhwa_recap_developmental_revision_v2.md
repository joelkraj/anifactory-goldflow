# Manhwa Recap Developmental Revision V2

```text
Revise the exact current narration script once using only the deterministically validated findings supplied from the two diagnostics.

Binding rules:

- Preserve the approved package, selected treatment, unified architecture, facts, chronology, identities, relationships, mechanic rules, and ending contract.
- Apply the smallest coherent repair for each accepted finding.
- An accepted opening-experience finding is structural, not cosmetic. Repair it by moving the existing wound, pressure, owned choice, counteraction, and consequence ahead of explanatory material. Preserve downstream facts, but do not leave the original exposition-first order intact merely to minimize changed words.
- Change causally dependent spans only when the anchored repair would otherwise create a contradiction.
- Do not launch a new subplot, replace the dominant engine, add a larger hidden organization, restyle unaffected sections, or perform a general second rewrite.
- Do not optimize for a score, twist count, sentence length, or WPM.
- Keep narration speakable and story-first.
- For accepted narrative-authenticity findings, repair the repeated pattern across its causally connected span rather than swapping a few flagged words. Preserve character identity and plot truth; never rename Joey Manhwa.
- When a finding identifies procedural or institutional dominance, do not merely replace bureaucratic nouns with fantasy nouns. Collapse repeated processing scenes, preserve their minimum causal facts, and rebuild the recovered space around visible confrontation, danger, relationship change, ingenious premise-native power use, desirable superiority, or spectacle. Keep no more than one extended institutional set piece unless the approved package explicitly sells that fantasy.
- A logically coherent process is not automatically entertaining. Final prose must not ask viewers to enjoy records being verified, permissions being gathered, contracts being negotiated, officials agreeing, or rules being drafted. Those may explain an aftermath in a sentence; they may not repeatedly function as payoff.
- Omit every diagnostic finding whose exact anchor was rejected by deterministic validation.
- For reference-density findings, repair the named dimension or material-edge appetite rather than chasing raw count. Protect every existing candidate win. Prefer a more ingenious use, sharper emotional action, fresher visual arena, stronger adaptive counter, clearer causal bridge, or fuller payoff over adding inventory.
- When repairing a dangling opening promise, power provenance, possession timeline, death/history contradiction, or auditory name collision, update every causally dependent span needed for a coherent answer. The smallest coherent repair may cross multiple local anchors; it is not permission for a general rewrite.

Return two artifacts separated exactly by the marker `===REVISION_LEDGER===`.

Before the marker, output the complete revised narration prose only.

After the marker, output JSON only:

{
  "schema": "goldflow_source_revision_ledger_v1",
  "status": "revised",
  "source_script_sha256": "SHA256",
  "revised_script_sha256": "SHA256_OR_PENDING_DETERMINISTIC_BIND",
  "entries": [
    {
      "finding_id": "...",
      "repair_intent": "...",
      "source_anchor": "...",
      "revised_anchor": "...",
      "dependent_spans_changed": ["..."]
    }
  ]
}
```
