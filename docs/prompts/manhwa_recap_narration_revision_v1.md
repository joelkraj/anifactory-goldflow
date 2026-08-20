# Manhwa Recap Narration Revision V1

```text
Perform one narration-only polish of the exact revised manhwa script. Preserve the Story Truth IR, event order, facts, mechanics, decisions, payoffs, ending, and every approved dramatic result. This is not developmental rewriting.

Improve only what a listener hears:

- sentence-length contrast and cadence
- breathable clause boundaries
- clean antecedents and one-pass clarity
- pronunciation-safe phrasing around names, abbreviations, ranks, and UI terms
- joins that do not begin or end on dependent fragments
- removal of accidental repetitions, fake profundity, and mechanically repeated syntax
- natural emphasis without adding stage directions

Do not insert SSML, pronunciation brackets, headings, notes, or dialogue labels. Keep 9,500-10,500 words and stay within five percent of the source word count.

Output the complete polished narration prose, then this exact marker on its own line:

===NARRATION_REVISION_LEDGER===

After the marker, return JSON only:

{
  "schema": "goldflow_narration_revision_ledger_v1",
  "status": "polished",
  "source_script_sha256": "filled by Goldflow",
  "polished_script_sha256": "filled by Goldflow",
  "story_truth_ir_sha256": "exact supplied hash",
  "source_word_count": 0,
  "polished_word_count": 0,
  "story_facts_changed": false,
  "events_reordered": false,
  "ending_changed": false,
  "changes": [
    {
      "change_type": "cadence|breath|sentence_contrast|spoken_clarity|pronunciation|join_safety",
      "source_anchor": "short exact original excerpt",
      "polished_anchor": "short exact polished excerpt",
      "narration_reason": "..."
    }
  ]
}
```
