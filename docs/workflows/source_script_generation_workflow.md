# Source Script Generation Workflow

This workflow defines how to generate source scripts before Goldflow ingest. It is intentionally outside pipeline code so the tactic can evolve as the channel learns.

## Principle

The chatbot should produce a polished narration script that is already close to production truth. Goldflow ingest should preserve it. Pipeline stages should analyze, time, voice, and visualize it, not rescue bad source prose.

## Default Flow

1. Operator provides a premise, target length, subgenre, and title promise. Default production narration pace is 210-220 spoken words per minute, with 215 WPM used for runtime estimates.
2. Agent selects the best prompt template from `docs/prompts/`.
3. Agent fills the template variables and returns one copy-paste prompt to the operator.
4. Operator gives the prompt to the chatbot.
5. Chatbot returns spoken narration prose only.
6. Operator or agent reviews the complete candidate with `docs/prompts/manhwa_recap_comment_criticism_release_gate_v1.md`, then checks hook timing and common TTS homograph risks.
7. If all six script gates pass with no unresolved `REPAIR` or `REJECT`, preserve the exact candidate hash and ingest into Goldflow as `script_clean.md`.
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
- A cold open that spends the first 30-60 seconds on setup instead of visible wound, hidden-power spark, first counter, and the next arc.
- Streamer/system premises where the first live/system quest, status mechanic, or next arc arrives too late for the title promise.
- TTS-ambiguous wording such as "go live" without streaming context or "content" where the intended meaning is media/clip content.
- Prose that is padded for length instead of written for the 210-220 WPM narration target.
- Joey continuing to submit to the same betrayer after understanding the harm without a visible objective, boundary, and changed conflict.
- Joey repeating a mistake after the story has already made the lesson explicit.
- A system or mechanic choosing Joey's goals, morality, or decisive action for him.
- A major result without a visible prior cause, setup, choice, cost, or rule.
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

Use `docs/prompts/manhwa_recap_chatbot_prompt_v4.md` for original long-form Joey Manhwa revenge power-fantasy stories across weak-to-strong, hunter/rank, system, regression, tower, academy, dungeon, noble revenge, and similar premises.

Every generated candidate must pass `docs/prompts/manhwa_recap_comment_criticism_release_gate_v1.md` before ingest.

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
