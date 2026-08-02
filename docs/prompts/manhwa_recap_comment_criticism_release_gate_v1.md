# Manhwa Recap Comment-Criticism Release Gate V1

Use this gate on the complete source script before Goldflow ingest.

## Evidence Basis

The July twenty-seventh Joey channel audit inspected 257 audience comments across 28 videos. Directional keyword coding found:

- 45 comments across eight videos criticizing a weak, irrational, submissive, or non-learning protagonist.
- 11 comments across five videos criticizing broken logic, causality, or payoff.
- 14 comments across eight videos criticizing slow, repetitive, overlong, or skippable storytelling.
- Three comments across two videos saying the system replaced the protagonist's competence.
- 21 comments across 15 videos praising story quality, character growth, emotional arcs, or complete endings.

The keyword audit is directional evidence rather than a perfect sentiment classifier. The repeated failure modes are still specific enough to use as a release gate.

## Required Inputs

- Complete candidate script.
- Exact title and thumbnail promise.
- Premise.
- Canonical mechanic rules.
- Intended spoken WPM and target runtime.
- Narration profile or direct benchmark.

## Review Output

Write a review artifact named `comment_criticism_gate_<candidate>.md`.

For every gate, record `PASS`, `REPAIR`, or `REJECT`, followed by word-position evidence and short excerpts.

Use `PASS` only when all script-level gates pass.

Use `REPAIR` when the story is sound and every failure can be corrected locally without changing the central plot.

Use `REJECT` when Joey's agency, core causality, mechanic integrity, middle-story engine, or ending requires a broad rewrite.

## Gate One: Joey Competence And Learning

Pass only when:

- Joey's opening exploitation is understandable without making him seem voluntarily foolish for most of the runtime.
- The opening produces an irreversible refusal, boundary, escape, counter, or changed strategy.
- Once Joey recognizes the betrayal, he does not repeatedly re-enter the same harmful arrangement for approval, romance, status, or another obvious test.
- Any later contact with the antagonist serves Joey's stated objective and preserves a visible boundary.
- Joey may relapse once into an established flaw, but the consequence is direct, he owns it without excuses, and his later behavior visibly changes.
- Joey does not repeat the same mistake after the lesson is explicit.
- Joey's strongest moments come from observation, preparation, communication, restraint, courage, and execution rather than polished insults.

Automatic failure questions:

- Why is Joey still doing what the betrayer wants?
- Why did Joey learn this lesson and then immediately forget it?
- Why should the viewer respect Joey after this choice?

## Gate Two: Plot Logic And Payoff

Pass only when:

- Every major result follows from a visible prior fact, action, choice, mechanic output, resource, or setup. A cost is not required.
- Every major proof or decisive victory shows the obstacle or tell, the exact mechanic output or granted capability, Joey's execution bridge, his concrete tactic and action, the opponent or environment response, the result, and a visible comparison proving his margin of dominance.
- Intelligence or analysis is not treated as strength, reflexes, motor memory, tools, capital, credentials, authority, or labor unless the story establishes an execution bridge such as accelerated training, physical enhancement, equipment, specialists, funding, authority, or infrastructure.
- The antagonist acts only on evidence they could possess.
- Cast counts, injuries, locations, knowledge, resources, promises, and time order remain consistent.
- The mechanic's trigger, payout timing, exclusions, costs, and limits never change for convenience.
- A serious defeat follows directly from the exact information, resource, or limitation Joey concealed or misjudged.
- The climax uses seeded rules and techniques rather than a surprise immunity, hidden menu, unexplained evolution, or convenient rescue.
- The title's promised reversal and revenge happen visibly.

Automatic failure questions:

- Why did that work?
- Where did that power, object, permission, or knowledge come from?
- Would this setback have happened even if Joey had made the correct choice?
- Did the ending fulfill the title, or merely announce that it did?
- What exactly did Joey notice, receive, and do, why did the obstacle respond that way, and what proves the win was dominance rather than luck?

## Gate Three: Pacing And Non-Repetition

Pass only when:

- The first thirty seconds make the title contradiction visible.
- The opening reaches its irreversible choice or boundary around the first five minutes.
- A betrayal-system premise proves its core advantage between approximately six and eight minutes.
- Every substantial movement changes the objective, pressure, relationship, resource, status, information, or environment.
- No two substantial sequences repeat the same humiliation, mechanic lesson, rescue shape, refusal, exposure, or revenge beat.
- Routine movement, hearings, contracts, reports, training, reactions, and already-understood procedures are compressed.
- Institutional procedure supports at most one compact reversal and one brief confirmation.
- The story does not continue after the primary physical and emotional ending.
- Sentence cadence matches the selected benchmark without becoming trailer fragments or literary paragraphs.

Automatic failure questions:

- Have I already heard this scene with different names?
- Can I skip this section without losing a cause, choice, consequence, or relationship change?
- Did the story end several minutes ago?

## Gate Four: Joey Agency With Power

Pass only when:

- The system or mechanic creates options, information, constraints, or resources rather than goals and morality.
- Joey decides whom to help, what risk to accept, what boundary to enforce, and what plan to execute.
- The system does not issue repetitive quests that replace character motivation.
- No decisive victory happens automatically when a meter fills.
- No decisive victory is summarized only as using intelligence, using the system, using advanced tactics, easily winning, or outsmarting everyone. One to three concrete decisive facts should explain how it worked without turning the story into a technical lecture.
- At least one ally materially changes the plan, defeat, rescue, comeback, or climax.
- Joey sometimes accepts correction, protection, or information from others.

Automatic failure questions:

- Did Joey win, or did the system win while Joey watched?
- Would Joey make any meaningful decision if the system instructions disappeared?

## Gate Five: First-Time Viewer Clarity

Pass only when a first-time viewer can state, throughout the script:

- Joey's current objective.
- The immediate obstacle.
- The mechanic's relevant capability and limit.
- Joey's choice.
- What changed because of that choice.

Also require:

- Functions are explained before unnecessary proper labels.
- New names and mechanics arrive only when needed.
- Joey receives a simple human reaction before dense tactical explanation.
- The narrator never forecasts future scenes, explains the theme, or comments on the writing.

Automatic failure questions:

- Who is this person, and why do they matter now?
- Is this a new rule or the old rule described differently?
- What exactly is Joey trying to accomplish in this scene?

## Gate Six: Growth, Revenge, And Closure

Pass only when:

- Joey's final behavior visibly contrasts with the behavior that enabled the opening exploitation.
- Revenge causes concrete loss tied to the original harm.
- The decisive revenge occurs in an active physical or social scene.
- Records, rankings, money, or official rulings may confirm the result but do not create it.
- The ending performs only the antagonist's concrete loss, Joey's final boundary, and one concise equilibrium.
- The script has a complete ending without sequel confusion.

## Production Criticism Gates

Passing the source-script gate does not claim that production complaints are solved.

Before publication:

- Pronunciation and artificial-voice risk must pass targeted speakability, TTS ASR, and spot-listening for the opening, protected terms, names, ranks, mechanics, and final boundary.
- Narrator-only audio is the default. Music and SFX remain opt-in and must never mask or distract from narration.
- Visual beats must cover the full narration with fresh images at new locations, actions, reveals, emotional pivots, and status turns.
- Image QA must reject repetitive, unsynchronized, continuity-breaking, crowded, or structurally confusing shots.

## Final Decision

Do not ingest a candidate with any `REJECT`.

Do not ingest a candidate with unresolved `REPAIR`.

Once all six script gates pass, preserve the exact candidate hash and continue to normal Goldflow preflight and ingest.
