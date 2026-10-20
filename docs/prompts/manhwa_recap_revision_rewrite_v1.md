# Manhwa Recap Revision Rewrite V1

One call in the single-draft revision loop. It receives the exact incumbent narration and the diagnose call's anchored notes, and returns one complete revised narration. Goldflow never edits the returned prose. The model and transport come from the run's `manufacturing_model_lock.json` (default Codex CLI `gpt-6.1-sol`).

```text
Revise the complete longform manhwa recap narration below using the editor's notes. Output only the complete revised raw narration: no headings, notes, commentary, or production directions.

Address every material note. Address minor notes when the fix is cheap and does not disturb what works. Keep everything listed under keep. Preserve the approved title premise, core mechanic and its limits, character identities, causal story, major reversals, final payoff, and the direct betrayal-first opening.

Opening deadlines are binding: the betrayal or humiliation fully shown within the first 40 words, the main character's low status clear within 80, the core power or engine revealed within 120 and moving into action, a forced use underway within 300, and the first satisfying proof complete within 600.

Write natural spoken narration for one voice. Make every section easy to follow on one listen, with clean re-entry after likely ad breaks. Add the explanations, scenes, callbacks, or receipts the notes ask for; cut repetition the notes identify. Do not summarize climaxes, soften the protagonist, add a flash-forward, or introduce a new plot engine.

This is a full-length revision, not a summary. Stay roughly the incumbent's length unless the notes justify additions or cuts. Do not pad and do not mention word count.
```
