# Manhwa Recap Manufacturing Prompt Filler

```text
Fill the supplied operator template for the supplied approved premise.

Return the complete filled writer prompt only. Do not write the story. Do not return JSON, commentary, headings, or a summary.

Preserve every non-placeholder instruction from the operator template. Replace every bracketed placeholder with a concrete, simple, internally consistent choice. Use plain viewer-facing language. Keep the core mechanic understandable in one sentence and no more than five short rules. Make the opening deadlines literal: the betrayal must be visible within forty words, low status clear within eighty, the mechanic revealed within one hundred twenty, forced use underway within three hundred, and the first satisfying proof complete within six hundred.

Use the approved title and core premise exactly. Favor fast power scaling, readable revenge, concrete upgrades, delayed callback payoffs, and escalating threats. Do not add administrative process, abstract theme language, or complicated terminology. The prompt must be sufficient for a writer working in a fresh context with no other packet.

Run a simplicity compression before returning the prompt:

- Keep the betrayal, progression loop, revenge target, and final payoff explainable in one sentence each.
- The final threat must grow directly from the original betrayers, rival, buyer, guild, or organization already implied by the title. Do not invent an ancient intelligence, cosmic manipulator, secret god, world-ending origin, unrelated conspiracy, or second story engine unless the approved premise explicitly requires it.
- For a target near ten thousand words, use no more than eight recurring proper names. Combine antagonist and ally roles instead of filling every template example with a new person. An original betrayer may also be the fake leader, late rival, and final antagonist. If a listed optional role is unnecessary, fill it with a plain instruction to omit that role rather than inventing another character.
- Preserve exact party and relationship counts across the complete prompt. Count the protagonist separately from their teammates: four teammates plus Joey is a five-person party, never a four-person party.
- Make Joey become visibly overpowered quickly through the title mechanic, while keeping later opponents dangerous through counters, constraints, and smarter use of the same core conflict.
- Keep revenge physical, emotional, public, and easy to follow. Do not replace it with hearings, policy reform, abstract self-discovery, or a world-saving plot.
- Fill the public status-reversal examples as one escalating ladder rather than five interchangeable shocks. Give the central betrayer or principal rival multiple distinct reversals at increasing scale. For every major reversal, specify the wrongdoer's fresh source of confidence, the witnesses, Joey's decisive and easily understood receipt, the wrongdoer's visible break, the tangible loss, and the new story opportunity. Use an old-status acquaintance for a short reversal only when that encounter advances the active plot; never invent a disposable snide cameo that exists only to look shocked.
- End on concrete consequences, status, relationships, and Joey's next chosen action. Avoid fake-profound identity claims such as saying his present self belongs to him or that an abstract inner victory matters more than the promised external payoff.

If an approved learning addendum is supplied, incorporate its behavioral lessons without weakening or deleting the base template.
```
