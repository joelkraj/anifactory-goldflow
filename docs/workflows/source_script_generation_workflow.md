# Source Script Generation Workflow

This workflow defines how to generate source scripts before Goldflow ingest. It is intentionally outside pipeline code so the tactic can evolve as the channel learns.

## Principle

The chatbot should produce a polished narration script that is already close to production truth. Goldflow ingest should preserve it. Pipeline stages should analyze, time, voice, and visualize it, not rescue bad source prose.

## Default Flow

1. Operator provides a premise, target length, subgenre, and title promise.
2. Agent selects the best prompt template from `docs/prompts/`.
3. Agent fills the template variables and returns one copy-paste prompt to the operator.
4. Operator gives the prompt to the chatbot.
5. Chatbot returns spoken narration prose only.
6. Operator or agent reviews the first page and a few random sections for source-prose violations.
7. If acceptable, ingest into Goldflow as `script_clean.md`.
8. Run targeted readiness/speakability only for pronunciation and known TTS risks.

## Source Script Acceptance Checklist

Reject or revise the chatbot output before ingest if it contains:

- Markdown headings, scene labels, block labels, narrator labels, or bracketed production notes.
- Narrator self-reference, such as "the narrator wants you to understand" or "the narrator will tell you."
- Editor-facing instructions for visuals, music, SFX, subtitles, or voice acting.
- Raw annotation blocks mixed into the narration.
- Broad, generic recap filler that delays the title promise.
- Long UI dumps that will sound unnatural when spoken.
- Dialogue formatted like a screenplay instead of prose.
- A cold open that does not pay off the title/thumbnail promise quickly.

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

## Current Recommended Template

Use `docs/prompts/manhwa_recap_chatbot_prompt_v1.md` for weak-to-strong manhwa, hunter/rank, system, regression, tower, academy, dungeon, noble revenge, and similar recap premises.

## Notes From Current Niche Research

Search and caption samples show that high-performing videos in this niche usually combine:

- betrayal or disposal
- rank/status insult
- visible hidden mechanic
- sudden rank/value reversal
- public proof
- revenge or institutional disruption

The strongest titles often promise the transformation in one sentence: betrayed trash becomes rank one, a discarded hunter gains a system, a regressed player returns with a cheat, or a weak character exposes an entire guild.

That title promise should appear in the script immediately, not twenty minutes later.

