# Source Script Generation Workflow

This workflow defines the channel-level package and source-development lane before Goldflow run preflight. It is intentionally separate from episode production so weak concepts can be discarded before a run identity or media spend exists.

## Principle

Select the click promise before writing the long story, then develop that promise through a small, hash-bound writers' room. The source model should produce emotionally lived-in K-drama/manhwa-style narration from one approved package and one canon, and Goldflow ingest should preserve the operator-approved exact final hash.

The default source profile for new developments is `evidence_story_room_v2`. Its primary viewing north star is 50 percent average percentage viewed after upload. Early retention checkpoints diagnose where that percentage is lost; AVD remains a useful secondary metric, not the optimization target. Runtime helps only when each span earns its share through causal, emotional, or fantasy movement. No model score or synthetic viewer can guarantee real APV. The workflow optimizes the test by separating measured evidence, packaging, competing treatments, unified architecture, two independent complete drafts, exact-anchor diagnosis, one developmental revision, and semantic acceptance.

## Source Model Contract

Live V2 source work uses only authenticated GPT Web Pro and Gemini Web 3.7 Flash for creative source decisions. GPT Web authors the premise slate, selected architecture, one complete longform draft, and the single developmental revision. Gemini Web independently selects packages and treatments, red-teams architecture, authors the competing complete draft, selects the draft, and runs semantic acceptance. Both providers share treatment and diagnostic work concurrently. Gemini text jobs visibly select 3.7 Flash with Extended Thinking off unless a future stage contract explicitly requests it. Codex does not author, select, diagnose, or revise source prose in this lane; it only gathers exact local inputs, performs deterministic validation and lineage checks, and writes accepted artifacts. Every response is stage-routed and hash-bound. `--response-path` is retained only for deterministic fixtures and explicit imported diagnostics.

Web planners have no direct Goldflow filesystem authority. Goldflow therefore reads every local formula, evidence snapshot, stockpile, prior research report, approved package, and blueprint first and places the required contents directly in the isolated provider job. The exported response and receipt are then hash-bound locally. No web planner may mutate repository or production artifacts directly.

Keep three evidence questions separate: public and own-channel package performance asks whether viewers click; absolute early retention asks whether the opening delivers the promise; AVD/APV/watch minutes and audience response ask whether the complete story satisfies. The current versioned evidence snapshot is `docs/channel_formulas/53rebirth_source_evidence_snapshot_v1.json`.

No LLM story score can prove retention. The blueprint audience audit is a pre-prose architecture contract, not a retention prediction: it may block blueprint approval when a hash-bound audience-trust or package-payment defect is cited, but it never repairs or regenerates automatically. The optional post-script `source audit` remains a non-blocking review log and never triggers another rewrite. Actual CTR and retention results update the channel formula only after a controlled cohort.

## Evidence Story Room V2 Default Flow

1. `source evidence-registry` imports one measured, limitation-aware evidence registry. AI rankings and synthetic premise scores are not audience evidence.
2. `source package-outliers` imports a hash-bound ledger of exact measured own-channel and niche-outlier titles. Each entry keeps public demand and private viewing signals separate and retains their limitations.
3. `source ideate-v2` asks GPT Web for six materially distinct packages and Gemini Web for an independent evidence-citing screen. Every candidate must name one exact outlier source, preserve its immediately legible emotional/fantasy movie, and add one material twist that improves desirability, proof, or personal charge without adding explanation. Strong runway cannot rescue plausible click potential.
4. `source package-tournament` sends every strong-click/strong-runway candidate to GPT Web Pro and Gemini Web 3.7 Flash concurrently. Each judge compares the complete click movie, simple thumbnail receipt, measured-demand transfer, twist value, reskin risk, and 10K-word runway veto. Only the same candidate rated strong for both click and runway by both judges becomes consensus. On disagreement, `source adjudicate-package --candidate-id <eligible-id> --adjudicated-by <operator> --rationale <text>` writes an immutable, judge-hash-bound operator decision without altering the truthful disagreement artifact.
5. `source approve-package-v2` requires either strong tournament consensus or a valid operator adjudication for outlier-led rooms, then separately hash-approves the exact selected package before treatment spend. Neither machine consensus nor adjudication replaces package approval.
6. `source reference-frontier --reference <exact measured outlier transcript>` imports the complete outlier the operator selected as the story benchmark, hash-binds it, and asks Gemini Web to chart thirteen dimensions of viewer appetite plus an uncapped, non-duplicative inventory of every material reference-specific edge. It defaults to the package's mirrored outlier; pass `--reference-entry-id <package_outlier_ledger entry>` when a different measured reference is deliberately selected. Every anchor must occur exactly in the reference. The normalization unit is viewer-payoff quality per 1,000 words and estimated spoken minute, never raw runtime or raw inventory.
7. `source treatments` authors boundary-drama, adaptive-contest, and reclassification treatments concurrently across GPT Web and Gemini Web. Each receives the frontier and must propose a route to exceed every appetite without copying plot skin. `source select-treatment` asks Gemini Web to compare exact anchored passages, then `source approve-treatment` locks the selected treatment.
8. `source architecture` builds one 9,500-10,500-word story architecture with a binding `dramatic_cold_open_v2` contract, a merit-dominance contract covering every fixed dimension and every material edge, protagonist agency, relationship and opposition ladders, learning, continuity, climax proof, and complete closure. Before the call, Goldflow snapshots a release-derived supporting-name familiarity ledger with a default 12-episode TTL. Recent reuse receives a decaying soft weight, reaches zero outside the TTL, and never becomes a ban; Joey and approved recurring-series characters are exempt. Continuations are entirely exempt so established cast names remain stable: pass `--continuation true`, while titles containing Part/Episode/EP 2 or higher activate the same safety net automatically. The opening contract begins with a visible event and specifies its wound, pressure, choice, counteraction, result, next question, and exposition-release point. It may not spend the opening teaching lore or procedure before drama. `source architecture-audit` also rejects dangling opening promises, unexplained power provenance, incompatible possession/history states, auditory name collisions, missing material-edge proof, and frontier plans that substitute raw count for density. No automatic rewrite loop exists. `source approve-architecture` locks the accepted exact hash.
9. `source script-v2` submits the same approved package, treatment, architecture, evidence, and frontier to GPT Web and Gemini Web concurrently. Each writes a complete 9,500-10,500-word standalone draft. A fresh Gemini Web context reads each first 220 words independently, writes exact-anchor opening verdicts, compares both complete texts, and chooses one byte-for-byte. A draft whose opening is primarily lore, backstory, procedure, rules, or status terminology cannot win merely because its later prose is strong. A draft that concedes a frontier dimension cannot win because it is cleaner overall. The selection may not blend drafts silently.
10. `source diagnose-v2` runs causality/learning, promise/continuity, narrative-authenticity, and reference-density-dominance diagnostics concurrently across Gemini Web and GPT Web. Findings require exact source offsets and are review evidence, not freeform rewrite orders. Density ties are findings. Authenticity covers procedural narration, repeated AI-shaped language and scene equations, interchangeable character voices/archetypes, and confusing name clusters; it does not ban isolated words or rename Joey Manhwa. For an exact candidate audited outside a complete room, `source reference-density-revise` consumes the validated frontier and diagnostic once, preserves all candidate-win receipts, and writes one complete integrated revision plus a finding ledger; it never rereads the raw reference or creates one scene per checklist row. A passed but overlong external candidate may use `--production-shape-revision true` only with an explicit exact payoff anchor, maximum payoff percentage, and episode-specific repair intent; this preserves the comparative wins while enforcing the 9,500-10,500-word production shape without hardcoding story facts into the command. When a later certification has only a small finding set, `source reference-density-patch` asks GPT Web for exact, bounded find-and-replace patches and deterministically rejects missing findings, non-unique anchors, excessive rewrite scope, or an out-of-range final length.
11. `source revise-v2` permits one GPT Web developmental revision against accepted findings. An anchored opening finding is repaired structurally by moving existing drama ahead of explanation, not cosmetically by shortening the same exposition-first order. An authenticity finding repairs the recurring narrative pattern rather than swapping a few flagged words. A density finding repairs the named appetite while protecting existing wins, not by adding random inventory. A later repair must name exact finding IDs; passed prose is never regenerated by an unscoped loop.
12. `source accept-v2` asks Gemini Web to verify all semantic obligations and independently rejudge all thirteen frontier dimensions plus every material edge against the exact revised script and exact reference. It also runs an absolute cold-listener comprehension contract: every central mechanic and recurring coined term must be explainable in plain language as input/trigger, visible output, stable limit/cost, and current purpose, with adjacent terminology distinguishable by ear. Naming or repeatedly invoking a power is not proof of comprehension, and comparative clarity cannot excuse an unclear candidate. Acceptance requires `candidate_win` on every comparative row and an absolute comprehension pass; ties or explanation debt fail. Acceptance or a deliberate operator hold follows; there is no automatic second revision.
13. The hash-bound ten-viewer tournament is a hostile release gate after semantic acceptance. The raw measured reference is read in full to create `reference_merit_frontier.json`; intermediate creative and diagnostic stages consume that exhaustive exact-anchor frontier instead of repeatedly injecting the long transcript. The complete raw reference returns for this final blinded tournament. The tournament uses the same bound reference and the panel seed precommitted in `source_room_contract.json`; never reroll viewers to seek favorable votes. Audience simulations default to three topped-off workers with inputs staggered by fifteen seconds and a maximum of three new starts per five-minute rolling window; each completed report releases a worker, but the replacement waits for both stagger gates. Do not launch simultaneous input bursts merely to shorten a tournament, because they can create avoidable account cooldowns. A partial provider failure must finish sibling jobs, checkpoint successful hash-bound reports, mark the batch incomplete, and resume only missing viewers after the shared cooldown. New rooms require candidate preference from all ten viewers at every checkpoint, for APV and overall, and on every major dimension. `source viewer-accept` binds the exact final candidate, reference, manifest, panel, and all ten report hashes. A loss stops release. When only the first 30-60 seconds lose while every later checkpoint, APV, and overall vote already wins, use `source viewer-opening-repair` with an explicit unique handoff marker and title-payment deadlines; it replaces only that opening and preserves the accepted tail byte-for-byte. One isolated later loss may use `source viewer-patch`, which permits only one to three exact bounded replacements and rejects broad or non-unique edits. Broader losses use `source viewer-revise`. Any repair becomes a new final candidate hash and must receive fresh semantic acceptance and a fresh tournament from that same panel. Simulated unanimity is an aggressive challenger standard, not a promise of real APV, CTR, or views.
14. `source release-v2` binds the reference transcript, merit frontier, every approval, provider response, draft, selection, diagnostic, revision, semantic acceptance, viewer-tournament acceptance, tournament manifest, ten viewer-report hashes, and final script hash before production preflight. It recomputes the tournament verdict and refuses release when any tie or reference preference remains. Existing rooms remain readable under their recorded contract.

Long contexts above the audited inline limit travel to GPT Web and Gemini Web as one exact UTF-8 text attachment whose filename binds the complete SHA-256 and byte count. The browser worker verifies visible retention before the single submission. A missing, truncated, or changed attachment blocks the call.

The opening must be experienced before it is explained. A cold viewer should see a person suffer or act under pressure, encounter a meaningful turn, and understand the next question before being asked to learn the world's history, institutions, bloodlines, rankings, procedures, or mechanic manual. Named-event timing alone is insufficient: an opening can hit every milestone and still fail when its connective experience is explanatory rather than dramatic.

Source-room request scheduling is shared across revision and audience calls. The audience panel may keep three workers topped off with 15-second staggering, but the measured safe budget is three new source-room starts per 15-minute rolling window. A revision submitted inside the same window consumes one of those start slots; panel concurrency is not separate provider capacity.

## Premise Stockpile

The channel's durable operator-curated queue lives at `/Users/joel/AniFactoryData/channels/53rebirth/source_development/premise_stockpile.json`, with a readable mirror in `premise_stockpile.md`. After each ideation batch, add only operator-accepted packages, preserve their source scores, and re-rank the complete active list by current editorial priority. Keep rejected concepts in the ledger so future ideation does not resurface or lightly reskin them. Research concepts remain in `pending_research` with no active editorial rank until the operator accepts them. The complete imported 100-concept directional pool lives under `source_development/research/2026-08-01-winner-concepts-v1/`. A stockpiled or pending premise is not an approved script or production run.

## Legacy Retention Room Flow

The following V1 flow remains readable for existing developments. Do not start new source work here unless the operator explicitly requests a legacy comparison.

1. Refresh or inspect the active evidence snapshot. Measured outlier/analytics evidence controls demand claims. The synthetic premise pool is duplicate/reskin context only; its AI ranks and editorial scores are not audience evidence.
2. When current web evidence is needed, run `source research`. The planning room prefers authenticated Gemini Web research, falls back only through the approved source-research route, and writes `source_web_research_report.md` plus a hash-bound provider receipt. Review its raw URLs and curate accepted measured findings into the versioned evidence snapshot; hypotheses may still travel to ideation but must remain labeled as hypotheses.
3. Generate six finalists from a private pool of twelve ideas with the active channel formula. For the current 53rebirth core lane, concrete betrayal or humiliation plus one reversal engine remains the strongest own-channel prior. External research also supports visible proof/status contradiction and direct-premise openings, so test those as deliberate challengers rather than claiming betrayal is a universal niche law. Ground the explanation rather than limiting the power: preserve both the macro scale ladder and at least two concrete application chains showing obstacle, mechanic output, execution bridge, Joey's tactic, response, result, and visible dominance proof. Preserve only operator seeds explicitly named in the current creative brief; active stockpile and pending-research entries are historical context and duplicate guards, not mandatory finalists. For a proven-demand-twist batch, bind each challenger to one measured winning package grammar and change one or two meaningful axes without copying plot skin. Feed the evidence snapshot, current cited research report, stockpile, pending research, published/rejected exclusions, and recent titles into both author and selector. An independent selection pass—not the ideator—pairwise-ranks the packages. Model scores are advisory; structural defects and explicit hard rejects are blockers.
4. Review the package board. The operator approves one exact title, additive thumbnail contract, premise, simple source of leverage, antagonist loss, and ending.
5. Author a dramatic blueprint with `docs/prompts/manhwa_recap_story_blueprint_v2.md`. It locks POV/tense, the human dramatic engine, recurring-character desires and contradictions, canon, enough causal movements for the approved runtime, relationship turns, setup/payoff pairs, midpoint transformation, climax, ending, and procedural-compression risks.
6. Run `source blueprint-audit`. This is an independent architecture check against the exact package, blueprint, and versioned audience evidence. It tests evidence-to-behavior change, system-versus-Joey agency, domain/stakes relevance, literal title and thumbnail payment, question progression, continuity/closure, and supporting-character balance. It never writes prose or repairs automatically.
7. Review and hash-approve the exact blueprint. A marker-bearing blueprint requires a current `pass` audit. If the audit says `revise`, repair only its cited fields or movements and rerun the audit. An operator may deliberately accept a known architecture risk only with `--approve-risk true --risk-reason <reason>`; the override is hash-bound through release, preflight, and ingest.
8. Convert the blueprint into `winner_retention_map.json`. This map gives every opening window and movement a live question, visible event, delivered answer or change, relationship turn, freshness source, compression target, and natural next question. The question-payment ledger gives every question a stable ID, opening movement, payment movement, answer, and optional replacement. It does not draft prose or claim to predict retention.
9. Write only the exact first five minutes with `docs/prompts/manhwa_recap_opening_writer_v1.md`, then review and hash-approve it. The blueprint must first choose a package-matched delivery mode: `linear_title_event`, `direct_premise`, or `outcome_choice_rewind`. The last mode is the proven outcome-first pattern: one concrete later result, one satisfying Joey choice, then one clean rewind that adds causality instead of replaying the preview. Its first thirty seconds use at most one new proper name and two unexplained story terms. The opening must deliver the title contradiction, consequence, Joey's first meaningful choice, one action-response-result loop, and an irreversible five-minute endpoint before full-script spend.
10. Generate only the continuation with `docs/prompts/manhwa_recap_longform_writer_v7.md`. Goldflow deterministically joins it after the approved opening, so the writer cannot replay, dilute, or silently alter the cold open.
11. Run three independent diagnosis passes against the same exact candidate: causal flow, emotional drama, and retention/repetition. They cite exact script anchors and never rewrite prose. These existing passes also verify the audience-trust, title-payment, critical-state, and question-payment contracts; do not add a fourth full-script review toll for the same concerns.
12. Run one integrated revision from all grounded findings. The package, blueprint, retention map, opening, immutable facts, setup/payoff ledger, and ending outrank every suggestion. This is the only developmental rewrite after the initial draft.
13. Run one final line-and-flow polish. It may improve spoken cadence, causal bridges, repetition, and AI-sounding prose, but it may not change plot, facts, movement order, relationships, climax, or ending.
14. Read or listen to `script_final.md`. Optional `source audit` may create a held-out criticism log, but its findings remain non-blocking and never trigger another automatic rewrite.
15. The operator releases the exact source hash. The release binds the title, package, audience-audited dramatic blueprint, retention map, approved opening, diagnostic manifest, integrated revision, final polish, formula, and operator identity.
16. Create the production run identity with the released title, source, and release receipt. Preflight and ingest revalidate the entire source-room lineage before writing `script_clean.md`.
17. Run targeted readiness/speakability only for pronunciation and known TTS risks.

## Dramatic Standard

Original K-drama/manhwa dramaturgy means human causality, not imported plot skin or forced romance. Preserve Joey's understandable initial wound, then make decisive evidence change his behavior. Most movements change both the external situation and a relationship, belief, or emotional obligation. A rare bridge may carry a necessary durable external or knowledge change without inventing a false emotional turn, but bridges are not consecutive and cannot become procedure stretched to fill runtime. Joey has an outer goal, inner need, behavior-producing wound, and visible change. Recurring characters have desires, fears, contradictions, useful capabilities, and decisions that can alter Joey's plan without taking his decisive ownership. The antagonist acts from understandable human logic and only from evidence they could possess.

Money, ranks, systems, contracts, hearings, acquisitions, transfers, training, and institutions are leverage. They are not drama by themselves. Compress routine procedure into the shortest causal bridge that preserves logic, then dramatize the betrayal, temptation, discovery, useful gesture, sacrifice, confrontation, refusal, alliance, or consequence it creates. Romance is optional. Emotional movement is mandatory.

The system is leverage rather than Joey's conscience. It may expose facts, present options, quantify danger, or unlock capability; Joey must still choose the goal, tactic, boundary, and title-native decisive action. Once he has decisive evidence of betrayal, later contact follows the blueprint's strategic-contact rule. This protects the audience's trust without flattening him into an instantly invulnerable power fantasy.

## Commands

Live ideation author and selector calls honor `--timeout-ms` and default to sixty minutes. A provider throttle or transport failure before submission is not a creative attempt; inspect the provider receipt and wait for the applicable cooldown before starting one intentional replacement call. If the author passed and only the independent selector failed, rerun `source ideate` with the same inputs plus `--resume-selector true`; Goldflow hash-verifies and reuses the passed author output without another author submission.

```bash
node bin/goldflow.mjs source adjudicate-package \
  --channel 53rebirth \
  --development-slug winner_story_room_private_retention_2026_08_12_v3 \
  --candidate-id candidate_03 \
  --adjudicated-by joel \
  --rationale "Operator selected the stronger complete click movie after reviewing both judges."

node bin/goldflow.mjs source approve-package-v2 \
  --channel 53rebirth \
  --development-slug winner_story_room_private_retention_2026_08_12_v3 \
  --approved-by joel
```

`adjudicate-package` is available only for a truthful tournament disagreement. It names an already eligible candidate and never edits model judgments or grants package approval.

```bash
node bin/goldflow.mjs source research \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01 \
  --brief /absolute/path/to/research_question.md

node bin/goldflow.mjs source ideate \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01

node bin/goldflow.mjs source approve-package \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01 \
  --candidate-id <candidate_id> \
  --approve true \
  --approved-by joel

node bin/goldflow.mjs source blueprint \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01

node bin/goldflow.mjs source blueprint-audit \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01

node bin/goldflow.mjs source approve-blueprint \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01 \
  --approve true \
  --approved-by joel

node bin/goldflow.mjs source retention-map \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01

node bin/goldflow.mjs source opening \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01

node bin/goldflow.mjs source approve-opening \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01 \
  --approve true \
  --approved-by joel

node bin/goldflow.mjs source script \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01

node bin/goldflow.mjs source diagnose \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01

node bin/goldflow.mjs source revise \
  --channel 53rebirth \
  --development-slug 2026-08-01-batch-01

node bin/goldflow.mjs source polish \
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
- A final line that ends mid-sentence or lacks terminal sentence punctuation.
- Broad, generic recap filler that delays the title promise.
- Long UI dumps that will sound unnatural when spoken.
- Dialogue formatted like a screenplay instead of prose.
- A cold open that does not pay off the title/thumbnail promise quickly.
- A cold open that spends the first 30-60 seconds on setup instead of visible wound, hidden-power spark, first counter, and the next arc.
- Streamer/system premises where the first live/system quest, status mechanic, or next arc arrives too late for the title promise.
- TTS-ambiguous wording such as "go live" without streaming context or "content" where the intended meaning is media/clip content.
- Prose that is padded for length instead of written for the 180-195 WPM narration target.
- A story whose only state changes are money, rank, ownership, contracts, hearings, transfers, training numbers, or system values while human relationships remain inert.
- Recurring characters who exist only to praise Joey, hate Joey, explain rules, deliver evidence, or react to his power without pursuing wants or changing his plan.
- A technically coherent middle that can be removed without changing trust, loyalty, desire, responsibility, information, available choices, or the cause of the next movement.
- K-drama/manhwa emotion represented only by gasps, silence, tears, crowd shock, aphorisms, or repeated humiliation rather than choices and consequences.
- Joey continuing to submit to the same betrayer after understanding the harm without a visible objective, boundary, and changed conflict.
- Joey repeating a mistake after the story has already made the lesson explicit.
- A central viewer question being replaced by a new tease before the prior question receives a concrete answer.
- A literal title or thumbnail promise with no named payment movement and visible proof.
- A reversal engine choosing Joey's goals, morality, or decisive action for him.
- A major result without a visible prior cause, setup, application, resource bridge, choice, or mechanic rule. A cost is not required.
- A major proof or decisive victory summarized as Joey using his brain, intelligence, the system, advanced tactics, luck, or raw power without showing the obstacle or tell, relevant mechanic output, execution bridge, concrete tactic and action, obstacle response, result, and visible margin of dominance.
- Intelligence or analysis producing unsupported strength, reflexes, motor memory, professional technique, tools, capital, credentials, authority, labor, or infrastructure. Establish how Joey acquires the capability needed to execute the solution; this is explanation, not a nerf.
- A serious defeat blamed on Joey even though it would have happened without his mistake.
- Two substantial sequences that teach the same lesson with different names.
- Institutional procedure becoming the middle-story engine or creating the decisive revenge.
- More than one major hearing, council, audit, contract, negotiation, trial, records-review, or permission-gathering movement when the approved package does not explicitly sell an institutional fantasy.
- Internal workflow ledgers leaking into narration vocabulary, repeated proof/authentication scenes, policy-voice dialogue, or a climax won because officials validate the correct process.
- Joey repeatedly proving intelligence through paperwork, clauses, records, or compliance instead of perception, strategy, bait, improvisation, sacrifice, or ingenious use of his premise-native power.
- A middle or ending that replaces desirable title-native mastery and spectacle with governance, ethics explanation, or administrative aftermath.
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

- a familiar personal betrayal, rejection, abandonment, theft, curse, framing, firing, disowning, cheating, or public humiliation as the strongest current 53rebirth core lane
- deliberate adjacent tests built around visible proof/status contradiction or a direct singular mechanic, because the broader niche corpus does not support mandatory betrayal as a universal rule
- one irreversible Joey choice
- one singular, easy-to-explain reversal engine that launches Joey's post-betrayal ascent; it does not need to mirror the wound
- freedom to discover explicit systems, lotteries or material windfalls, genius/skill/hidden identity, supernatural partners, genies, wishing objects, original mechanics, and unfamiliar combinations without quotas
- overpowered, compounding, or uncapped growth supported by a clear causal ladder from first proof to increasingly large results
- locally explained decisive applications that show what the mechanic supplied, what Joey did, why the obstacle responded, what changed, and how the viewer can see his margin of dominance
- a literal reversal that removes the betrayer's access, relationship, status, property, authority, or control of the public story
- one simple additive thumbnail proof

For the core lane, the working formula is wound plus advantage, not wound versus advantage. A title such as betrayal then system, betrayal then lottery, betrayal then genius reveal, or betrayal then supernatural relationship is one combined premise. The advantage does not need to be a corrective answer to the wound. It can be an enormous, compounding power that sends Joey somewhere entirely new. Ground the explanation rather than the power. At the macro level, show the important bridges that turn intelligence into inventions, inventions into capital and teams, and teams into the promised scale. At the local level, explain decisive wins through obstacle, mechanic output, execution capability, concrete action, response, result, and dominance proof. The negative channel example is Ninety-Nine Gates: it passed formal checks but produced a 3.2% click-through rate and 368-second average view duration, far below the channel's typical 1,062-1,362 seconds. That result rejects lore-heavy gates as a substitute for emotion; it does not reject systems or manhwa mechanics as a category.

The lesson is not to add a stricter checklist. It is to select a more emotionally legible package, write it naturally, and let upload data judge the result.
