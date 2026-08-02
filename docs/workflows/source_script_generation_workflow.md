# Source Script Generation Workflow

This workflow defines the channel-level package and source-development lane before Goldflow run preflight. It is intentionally separate from episode production so weak concepts can be discarded before a run identity or media spend exists.

## Principle

Select the click promise before writing the long story. The source model should produce clean conversational narration from one approved package, and Goldflow ingest should preserve the operator-approved exact hash.

No LLM story score can prove retention. Automated criticism is a review log only. It never blocks release, triggers automatic repair, or regenerates a script. Actual CTR and retention results update the channel formula only after a controlled cohort.

## Premise Stockpile

The channel's durable operator-curated queue lives at `/Users/joel/AniFactoryData/channels/53rebirth/source_development/premise_stockpile.json`, with a readable mirror in `premise_stockpile.md`. After each ideation batch, add only operator-accepted packages, preserve their source scores, and re-rank the complete active list by current editorial priority. Keep rejected concepts in the ledger so future ideation does not resurface or lightly reskin them. Research concepts remain in `pending_research` with no active editorial rank until the operator accepts them. The complete imported 100-concept directional pool lives under `source_development/research/2026-08-01-winner-concepts-v1/`. A stockpiled or pending premise is not an approved script or production run.

## Default Flow

1. Generate six finalists from a private pool of twelve ideas with the active channel formula. Every candidate must use the same chassis: concrete betrayal or humiliation, one reversal engine, early visible proof, a hyper-scaling but causally explained ascent, and visible payback. The mechanic does not need to counter or mirror the betrayal; it launches Joey's new path. Betrayal is not one lane beside mechanics. There are no fixed engine lanes, quotas, power ceilings, or mandatory nerfs: search freely across systems, lotteries, genius, hidden identities, supernatural partners, genies, wishing objects, skills, jobs, luck, contracts, unfamiliar original mechanics, and anything else that creates a stronger premise. Ground the explanation rather than limiting the power: preserve both the macro scale ladder and at least two concrete application chains showing obstacle, mechanic output, execution bridge, Joey's tactic, response, result, and visible dominance proof. Explore materially different engines in the private pool, but let diversity break ties rather than override the strongest concepts. Preserve supplied operator seeds as genuine finalists. Feed the active stockpile, pending research, and rejected ledger into both author and selector so AI ideas challenge rather than duplicate them. An independent selection pass—not the ideator—scores and pairwise-ranks them against own-channel winners, current niche outliers, negative channel evidence, and recent uploads. Score thresholds and diversity observations are advisory warnings; structural defects and explicit hard rejects are blockers.
2. Review the package board. The operator approves one exact title, additive thumbnail contract, premise, simple source of leverage, antagonist loss, and ending.
3. Generate one complete narration with `docs/prompts/manhwa_recap_chatbot_prompt_v6_light.md`. V6 Light deliberately avoids compliance-heavy beat writing and uses the approved package as its main constraint.
4. Read or listen to the exact candidate. Optional `source audit` may create a word-positioned criticism log, but its findings are non-blocking.
5. The operator releases the exact source hash. The release binds the title, package, formula, script, and operator identity.
6. Create the production run identity with the released title, source, and release receipt. Ingest revalidates all hashes before writing `script_clean.md`.
7. Run targeted readiness/speakability only for pronunciation and known TTS risks.

## Commands

```bash
node bin/goldflow.mjs source ideate \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01

node bin/goldflow.mjs source approve-package \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01 \
  --candidate-id <candidate_id> \
  --approve true \
  --approved-by joel

node bin/goldflow.mjs source script \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01

# Optional diagnostic. It never blocks release.
node bin/goldflow.mjs source audit \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01

node bin/goldflow.mjs source release \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01 \
  --approve true \
  --approved-by joel
```

The release command prints the exact `run preflight` command shape with `--source` and `--winner-release`. Do not create an episode folder before that point.

The selector is advisory, not sovereign. If the operator deliberately chooses a candidate the score marked ineligible, `source approve-package` supports `--approve-risk true --risk-reason <reason>` and records the override and original findings in the package receipt.

## Source Script Acceptance Checklist

Review or revise the source before operator release if it contains:

- Markdown headings, scene labels, block labels, narrator labels, or bracketed production notes.
- Narrator self-reference, such as "the narrator wants you to understand" or "the narrator will tell you."
- Editor-facing instructions for visuals, music, SFX, subtitles, or voice acting.
- Raw annotation blocks mixed into the narration.
- Broad, generic recap filler that delays the title promise.
- Long UI dumps that will sound unnatural when spoken.
- Dialogue formatted like a screenplay instead of prose.
- A cold open that does not pay off the title/thumbnail promise quickly.
- A cold open that spends the first 30-60 seconds on setup instead of visible wound, hidden-power spark, first counter, and the next arc.
- Streamer/system premises where the first live/system quest, status mechanic, or next arc arrives too late for the title promise.
- TTS-ambiguous wording such as "go live" without streaming context or "content" where the intended meaning is media/clip content.
- Prose that is padded for length instead of written for the 180-195 WPM narration target.
- Joey continuing to submit to the same betrayer after understanding the harm without a visible objective, boundary, and changed conflict.
- Joey repeating a mistake after the story has already made the lesson explicit.
- A reversal engine choosing Joey's goals, morality, or decisive action for him.
- A major result without a visible prior cause, setup, application, resource bridge, choice, or mechanic rule. A cost is not required.
- A major proof or decisive victory summarized as Joey using his brain, intelligence, the system, advanced tactics, luck, or raw power without showing the obstacle or tell, relevant mechanic output, execution bridge, concrete tactic and action, obstacle response, result, and visible margin of dominance.
- Intelligence or analysis producing unsupported strength, reflexes, motor memory, professional technique, tools, capital, credentials, authority, labor, or infrastructure. Establish how Joey acquires the capability needed to execute the solution; this is explanation, not a nerf.
- A serious defeat blamed on Joey even though it would have happened without his mistake.
- Two substantial sequences that teach the same lesson with different names.
- Institutional procedure becoming the middle-story engine or creating the decisive revenge.
- A second ending after the promised physical and emotional payoff is complete.

## Research And Revision Loop

When a better tactic is discovered:

1. Add a short note to the relevant prompt file under "Research Basis" or create a new prompt version.
2. Keep old versions instead of rewriting history if the change is meaningfully different.
3. Update this workflow only when the process changes, not for every prompt wording tweak.
4. Test the new prompt on a premise and inspect:
   - first 250 words
   - system/UI phrasing
   - dialogue formatting
   - narrator self-reference
   - payoff density
   - TTS speakability
   - first 30/45/60/90/180 second story milestones
   - ambiguous streamer homographs such as "live", "streaming live", "live stream", "live content", and media "content"
   - the six hostile-viewer questions in `docs/prompts/manhwa_recap_comment_criticism_release_gate_v1.md`

## Current Recommended Template

For packaging-first source development, use `docs/prompts/manhwa_recap_chatbot_prompt_v6_light.md` with the `CONVERSATIONAL WINNER` profile. V6 Light keeps title truth, conversational delivery, causal continuity, mechanic integrity, and a concise payoff while removing the large compliance checklist that made scripts sound engineered.

`docs/prompts/manhwa_recap_chatbot_prompt_v5.md` remains available for diagnostics or an explicit operator-selected comparison. `docs/prompts/manhwa_recap_comment_criticism_release_gate_v1.md` and the machine retention audit are optional review tools, not release gates.

## Notes From Current Niche Research

Current own-channel and niche evidence favors:

- a familiar personal betrayal, rejection, abandonment, theft, curse, framing, firing, disowning, cheating, or public humiliation in every candidate
- one irreversible Joey choice
- one singular, easy-to-explain reversal engine that launches Joey's post-betrayal ascent; it does not need to mirror the wound
- freedom to discover explicit systems, lotteries or material windfalls, genius/skill/hidden identity, supernatural partners, genies, wishing objects, original mechanics, and unfamiliar combinations without quotas
- overpowered, compounding, or uncapped growth supported by a clear causal ladder from first proof to increasingly large results
- locally explained decisive applications that show what the mechanic supplied, what Joey did, why the obstacle responded, what changed, and how the viewer can see his margin of dominance
- a literal reversal that removes the betrayer's access, relationship, status, property, authority, or control of the public story
- one simple additive thumbnail proof

The research formula is wound plus advantage, not wound versus advantage. A title such as betrayal then system, betrayal then lottery, betrayal then genius reveal, betrayal then demon marriage, or betrayal then genie is one combined premise. The advantage does not need to be a corrective answer to the wound. It can be an enormous, compounding power that sends Joey somewhere entirely new. Ground the explanation rather than the power. At the macro level, show the important bridges that turn intelligence into inventions, inventions into capital and teams, and teams into a space company, empire, kingdom, or other promised scale. At the local level, explain decisive wins through obstacle, mechanic output, execution capability, concrete action, response, result, and dominance proof. The negative channel example is Ninety-Nine Gates: it passed formal checks but produced a 3.2% click-through rate and 368-second average view duration, far below the channel's typical 1,062-1,362 seconds. That result rejects lore-heavy gates as a substitute for emotion; it does not reject systems or manhwa mechanics as a category.

The lesson is not to add a stricter checklist. It is to select a more emotionally legible package, write it naturally, and let upload data judge the result.
