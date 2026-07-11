# Manhwa Recap Chatbot Prompt Template v1

Use this when the operator gives a premise and wants a chatbot to produce a directly ingestible narration script for the Goldflow pipeline.

## Research Basis

This template is based on current manhwa recap search/title patterns and a small caption-structure sample from longform weak-to-strong, betrayal, hunter/rank, and system recap videos.

Observed winners in the sampled niche emphasize:

- A clickable promise built from betrayal, rank/status insult, hidden system/cheat, and revenge/payoff.
- A cold open that delivers the title promise within the first 98-110 words and turns the hidden power into a visible counter by about 45 seconds.
- A protagonist who is underestimated in public, then proves the world wrong through a concrete mechanic.
- Short-to-medium spoken sentences, generally around 13-18 words.
- Frequent consequence loops: insult, reveal, proof, public reaction, escalation.
- System/status text that is readable aloud and folded into narration.
- Minimal direct channel banter once the story starts.

Research sample URLs:

- https://www.youtube.com/watch?v=CbVRxENCKaE
- https://www.youtube.com/watch?v=2r6xu8KAjs0
- https://www.youtube.com/watch?v=JUjVW3oU5QQ
- https://www.youtube.com/watch?v=K49rTuVl-JA
- https://www.youtube.com/watch?v=aNMer6V_frI
- https://www.youtube.com/watch?v=gecmpeZXDos
- https://www.youtube.com/watch?v=153_p1txwGI

## Operator Fill-Ins

- `PREMISE`: Story idea or outline.
- `TARGET_WORD_COUNT`: Desired length.
- `POV`: Usually third person past tense. Use first person only for intentional cold-open confession.
- `TONE`: Default: dramatic, controlled, coldly satisfying.
- `SUBGENRE`: Hunter/rank, tower, academy, regression, reincarnation, noble revenge, murim, apocalypse, dungeon economy, etc.
- `TITLE_PROMISE`: The exact payoff the title/thumbnail sells.

## Copy-Paste Prompt

```text
You are writing a longform anime/manhwa recap narration script for a YouTube video.

PREMISE:
[PASTE PREMISE HERE]

TARGET WORD COUNT:
[TARGET_WORD_COUNT]

TARGET NARRATION PACE:
195-220 spoken words per minute. Estimate runtime from word count at a 208 WPM midpoint. Write tight spoken prose that can be narrated quickly without sounding rushed.

Opening hook default: condense story beats, not WPM. At 208 WPM, use roughly 98-110 words per 30 seconds. In the opening of the full script, make the first 60 seconds carry the whole click promise: 0-10 seconds public wound/title payoff, 10-20 seconds enemy or beneficiary pressure, 20-30 seconds hidden-power spark or impossible contradiction, 30-45 seconds explicit counter/reversal action, and 45-60 seconds first proof or clear transformation promise. For streamer/system humiliation stories, the first live/system quest should complete by about 45 seconds when the premise supports it, the core status mechanic should be understandable before or around that completion, and the next major arc should start by about 60 seconds. By 90 seconds the first enemy and objective should be clear; by 180 seconds the first public test, status challenge, forced choice, or visible consequence should already be underway.

SUBGENRE:
[SUBGENRE]

TITLE PROMISE:
[TITLE_PROMISE]

POV:
[POV]

TONE:
[TONE]

PRIMARY GOAL:
Write a polished, production-ready narration script that can be read directly by TTS and ingested directly into a video pipeline. The script should feel like a high-retention manhwa recap: dramatic, clear, emotionally direct, fast-moving, and built around weak-to-strong payoff.

OUTPUT FORMAT:
Output only spoken narration prose.

Do not output:
- title
- markdown headings
- bullet points
- scene labels
- chapter labels
- block labels
- narrator labels
- character voice labels
- bracketed directions
- production notes
- visual notes
- SFX notes
- music notes
- explanations before or after the script

CRITICAL PROSE RULES:
- The narrator must never refer to himself.
- Do not write phrases like "the narrator says," "the narrator wants you to understand," "the narrator will tell you," "the narrator notes," "the narrator confirms," or any equivalent.
- If a fact matters, state the fact directly.
- Do not say "this scene," "this story," "dear viewers," "our protagonist," "the audience," or "as we can see."
- Do not use screenplay formatting.
- Do not use raw outline language.
- Do not include instructions for visuals, editing, music, or voice acting.
- Do not include meta-analysis lines such as "that was the hook", "viewer anticipation verified", "the audience should stay", or any other creator-facing retention diagnosis.

STYLE:
- Modern manhwa/anime recap narration.
- Clear, dramatic, controlled.
- Serious, addictive, and emotionally legible.
- Cold satisfaction over loud hype.
- Target 195-220 spoken words per minute; avoid filler, repeated attribution, and slow throat-clearing.
- Avoid ambiguous TTS homographs when a clearer phrase is available. In streamer stories, prefer "livestreaming", "livestream", "live broadcast", "stream videos", or "livestream video content" when you mean live-streaming/media, not just "live", "streaming live", "live stream", "live content", or "stream content" in a context where TTS may choose the wrong pronunciation. Write "clip", "stream videos", or "video content" when you mean media content, not emotional satisfaction.
- Sentence length should usually be short to medium.
- Most sentences should be speakable in one breath.
- Use strong contrast lines after major reversals.
- Avoid overexplaining obvious emotions.
- Avoid metaphor stacking.
- Avoid filler and channel banter.

RETENTION STRUCTURE:

1. Cold open.
Start with the strongest crisis, betrayal, death, humiliation, impossible odds, or system reveal. Deliver the title promise quickly. The viewer should understand why they clicked within the first 98-110 words.

For the first three minutes, use this timing shape unless the operator gives a different one:
- First 0-30 seconds, about 98-110 words: visible wound, title promise, enemy pressure, hidden power spark.
- First 30-60 seconds, about 195-220 total words: pain turns into curiosity, first counter/reversal action, and one concrete reason the protagonist can now fight back.
- First 60-90 seconds, about 293-330 total words: explain the simple power/status rule, name the first enemy, and make the first payoff obvious.
- First 90-180 seconds, about 585-660 total words: minimal backstory, first objective, first obstacle, public witnesses, and the first visible status challenge.

2. The wound.
Show what the world called the protagonist, who used them, what they lost, and why the old system felt impossible to fight.

3. The mechanic.
Reveal the hidden advantage as a concrete rule. It can be a regression memory, stored kill count, debt ledger, skill, system shop, copy ability, contract, curse, class, tower reward, or market edge. Make the mechanic simple enough to explain in three sentences.

4. First proof.
Create an early public test where someone underestimates the protagonist. The protagonist wins through the mechanic, not random power. The result should create witnesses, rumors, screenshots, rankings, guild alerts, or official records.

5. Escalating proof loops.
Repeat this rhythm with variation:
Someone insults or exploits him.
The rules say he should lose.
He uses the mechanic calmly.
The opponent realizes too late.
The public or institution reacts.
The win creates a stronger enemy.

6. Institutional reveal.
Show that the true enemy is larger than one bully or party: a guild, academy, association, noble house, market, empire, sect, god, tower, family, or system.

7. Episode payoff.
Deliver one satisfying victory that proves the protagonist is no longer disposable.

8. Final hook.
End with a larger threat, mystery, debt list, next target, sealed entity, market opportunity, or enemy who finally understands that the protagonist is dangerous.

MANHWA RECAP DEVICES TO USE:
- rank/status insult
- public humiliation becoming public proof
- system window as a dramatic reveal
- phones, broadcasts, comments, guild alerts, ranking screens, academy records, or market lines reacting
- quiet protagonist confidence
- repeated callback lines
- numbers that matter: rank, count, debt, kills, odds, reward, level, floor, score, views
- consequence beats after every big action

SYSTEM/UI TEXT RULES:
Use system text only when it strengthens the story. Write it in speakable narration.

Good format:
The system displayed one line: Final settlement in progress.
Then another: Stored kills, one million.
Then the last line appeared: Redeem?

Avoid long raw UI dumps unless the premise absolutely needs them.

DIALOGUE RULES:
- Dialogue is allowed, but keep it sparse and sharp.
- Attribute dialogue naturally in prose.
- Do not format as a script.
- Do not use speaker labels.
- Important dialogue should either reveal cruelty, expose fear, or trigger a reversal.

PROTAGONIST RULES:
- The protagonist should not sound whiny.
- They can be angry, cold, tired, patient, or amused.
- They should prove things through action.
- Their strongest moments should feel earned by memory, suffering, preparation, or a rule the viewer understands.

ANTAGONIST RULES:
- Antagonists should represent the world's logic: rank, money, bloodline, guild value, doctrine, noble hierarchy, divine law, or public reputation.
- Give each major antagonist a reason to underestimate the protagonist.
- Make their loss damage more than their body: reputation, doctrine, market value, rank, authority, future plan, or public image.

ENDING RULES:
- Do not end with a generic "like and subscribe."
- Do not summarize the moral.
- End on a clean next-episode hook.
- The final line should be memorable and directly tied to the protagonist's new leverage.

FINAL SELF-CHECK BEFORE OUTPUT:
Before writing the final answer, silently check:
- Does the first 250 words deliver the title promise?
- Is the hidden mechanic concrete and easy to understand?
- Does every major sequence have a consequence?
- Are there public reactions or institutional reactions after big wins?
- Is the script directly speakable by TTS?
- Did you avoid all narrator self-reference?
- Did you avoid headings, labels, annotations, and production notes?
- Did you output only the spoken narration?

Now write the complete narration script.
```
