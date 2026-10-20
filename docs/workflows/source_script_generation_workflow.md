# Manhwa Source Script Generation Workflow

This workflow defines the **manhwa-only** channel-level package and source-development lane before Goldflow run preflight. Read [the manhwa guide](../pipelines/manhwa.md) first. It is intentionally separate from episode production so weak concepts can be discarded before a run identity or media spend exists.

All `source manufacture` commands and the fiction templates/rooms below are specific to `manhwa_recap_v1`. They are not factual-documentary research or movie/TV commentary tools. Route Asset Afterlife/lost-luggage work to [the documentary guide](../pipelines/documentary.md); route movie/TV work to [the design-only editorial guide](../pipelines/movie_tv.md). Existing manufacturer commands retain their manhwa default and do not require new profile/workflow flags. The CLI rejects an explicitly conflicting content profile or targeted non-manhwa run identity; this is not a claim that every free-form brief field is automatically audited.

After exact-source review, new episode preflight must explicitly select `--content-profile manhwa_recap_v1 --media-workflow generated_visuals_v1`; both choices are mandatory. Source `direct_manufacturer_v1` and writer policies name source-development methods, not the media workflow. Existing production identities are not rewritten by this requirement.

## Principle

Use measured winners and outliers to find a simple clickable premise, take the shortlist's rank-one title and story promise automatically, then send the filled retention prompt to one Pro writer. Improve that single draft with directed editorial passes (diagnose, revise, verify; at most two rounds) instead of a script tournament. The only human steps are the final watch and the publish approval downstream.

The default profile is `direct_manufacturer_v1`. Its north star is measured upload average percentage viewed, with title/opening agreement and the first two minutes treated as the most important pre-upload risks. No model score or simulated viewer can guarantee real APV. The pipeline records creative work; it does not manufacture intermediate bureaucracy around it.

## Source Model Contract

Effective October 20, 2026, new portfolios use `single_6_sol_pro_v1`: exactly one authenticated ChatGPT Web `gpt-6-sol` writer at visible Pro (`draft_56_1`), the same per-writer model contract as the previous three-writer default. There is no selector. Ideation stays Medium; the revision loop's diagnose and rewrite calls default to High and its verify call to Medium, never Pro. Every page verifies its model and effort before submission.

Historical portfolios remain readable under their recorded contracts without relabeling: `three_6_sol_pro_v1` and `three_56_pro_v1` (three Pro drafts), `six_dual_pro_v1`, and `six_56_6_pro_v1`. A portfolio without a recorded `writer_policy` is inferred from its candidates (three drafts stay a three-writer portfolio). An operator can still request a multi-draft policy explicitly with `--writer-policy`; that portfolio then uses the historical `select`/`improve` path.

## Source Wall-Clock SLO

An explicit operator-requested comparison may use `six_56_6_pro_v1`: three GPT-5.6 Sol Web Pro drafts and three GPT-6 Web Pro drafts, with the same compact prompt, three concurrent writers, and the existing shared start gate. Bind `writer_policy` in the approved manufacturing brief and pass `--writer-policy six_56_6_pro_v1` to `source manufacture write`. The default remains `single_6_sol_pro_v1`; this never reactivates GPT-5.5 or changes historical portfolios. The browser must select models by visible identity, not menu position. GPT-6 through the rolling Latest choice is accepted only when the picker explicitly verifies `6 Pro`; an unavailable or changed identity blocks rather than silently substituting a model. Six requested drafts do not authorize automatic editing, ingest, or production.

GPT-6 picker diagnostics must read the complete `composer-intelligence-picker-content` enclosing the selected model panel. The generic menu selector can resolve to a nested model-only group that omits the sibling `6 Pro` description. Preserve strict identity checks; verify fixes with zero-send UI selection before exact-ID recovery of unsubmitted drafts.

An operator may explicitly request an agent-directed GPT-6 edit/review loop on a chosen source candidate. Use the shared runner with explicit `gpt-6-astra` and named `winner_source_script_v3_directed_edit_gpt6_<scope>` / `winner_source_script_v3_directed_review_gpt6_<scope>` stages only before a production identity exists. Preserve the baseline, every full response and receipt, and an agent decision between calls. This does not alter default editors or authorize automatic extra rounds. Verify the actual visible model at the requested effort: the September 6 live picker showed Latest/High resolving to `5.6 High`, whereas Latest/Pro showed `6 Pro`; obtain the operator's model-versus-effort choice rather than substituting silently.

New source development targets **about two to two and a half hours with no operator wait**; this is a target, not guaranteed provider latency. Budget 15-25 minutes for premise work (two Medium calls), up to 10 minutes for prompt preparation (or zero model calls for an imported prompt), 45-90 minutes for one Pro draft, and 30-50 minutes per revision round (High diagnose 5-10, High complete rewrite 20-30, Medium verify 5-10), with a second round only when verify reports remaining material issues. Do not add rounds when behind schedule. Provider delays remain visible and require triage, not duplicate submissions.

Code may validate completeness, exact opening-contract sentences, hashes, model receipts, and lineage, but it must not compose, summarize, patch, or rewrite creative story material. Passed prompts and drafts remain immutable; recovery names only the failed exact call or candidate. Provider queue time, operator deliberation, and active generation time are recorded separately.

Web planners have no direct Goldflow filesystem authority. Goldflow embeds only the compact evidence, approved brief, template, or blind scripts required by the current call, then hash-binds the exported response and receipt locally. No web planner may mutate repository or production artifacts directly.

Keep three evidence questions separate: public and own-channel package performance asks whether viewers click; absolute early retention asks whether the opening delivers the promise; AVD/APV/watch minutes and audience response ask whether the complete story satisfies. The current versioned evidence snapshot is `docs/channel_formulas/53rebirth_source_evidence_snapshot_v1.json`.

No LLM score can prove retention. Predicted APV is a consistent pre-upload comparison tool, not audience evidence and not permission for an automatic rewrite. Actual CTR and retention results may propose a controlled prompt change only after a measured cohort and operator approval.

## Direct Manufacturer V1 Default Flow

The default runs from ideation to the final script file with no operator stop. One command does all of it:

```bash
node bin/goldflow.mjs source manufacture run --development-slug <slug> --evidence <evidence.md>
```

1. Prepare one compact evidence file containing measured own-channel winner titles and a small current set of verified external outlier titles (with URLs). Titles and metrics are evidence; AI commentary is optional.
2. **Ideate.** One GPT-6 Sol Medium context creates exactly thirty original title-only premises. A fresh independent Medium context shortlists ten using story-led hook comparison, click clarity, emotional stakes, a simple engine or situation, title-to-opening compatibility, and longform runway. Shortlists use `story_led_hooks_v1` and retain the winning hook rationale and promised payment scenes.
3. **Auto-title.** Goldflow copies the shortlist's rank-one title, premise, opening target, hook contract, genre elements and reference outlier byte-for-byte into `manufacturing_brief.json` with `status: "auto_selected"` and a `selection_basis` recording rank 1, the selector's `why_it_can_win` rationale, the shortlist path and SHA-256, and the evidence hash. Code never edits the title or premise. An existing brief is never replaced, so an operator who wants a different premise supplies `--brief <json>` (an operator-approved brief keeps its original `approved_by` contract) before `write`.
4. **Prepare.** One Medium context fills `docs/prompts/manhwa_recap_manufacturing_template_v1.txt` (or the approved channel template) while preserving its binding first-40/80/120/300/600-word deadlines and reversal ladder.
5. **Write one draft.** One isolated `gpt-6-sol` Web Pro writer writes one complete narration (`manufactured_drafts/draft_56_1.txt`, recorded in `manufacturing_portfolio.json` with `writer_policy: single_6_sol_pro_v1`). Target word count is advisory. `--recover-browser-jobs <json>` can adopt a matching existing browser job without another submission.
6. **Revise.** The draft enters `revision_loop/` as `v00_incumbent.txt`. Each round is exactly three calls:
   - **diagnose** (`manhwa_recap_revision_diagnose_v1.md`, High): concrete notes anchored by exact quotations, covering continuity and logic, cold-viewer explanation and world-building, pacing and repetition, the opening deadlines (checked against exact word windows Goldflow slices from the script), storytelling, payoff, and useful additions. Each note is `material` or `minor`. Notes whose anchors mostly fail to match the script block the round.
   - **revise** (`manhwa_recap_revision_rewrite_v1.md`, High): one complete revised narration from those notes. A result outside 0.8-1.3 times the incumbent's length is treated as truncated and reverted without a verify call.
   - **verify** (`manhwa_recap_revision_verify_v1.md`, Medium): compares revision against incumbent on the same dimensions, checks regressions, and decides `keep_revision` or `revert` with reasons, then lists remaining material issues in the kept version.
   A second round runs only when verify reports remaining material issues; its diagnose call sees those issues and any regressions. The hard cap is two rounds (`--max-rounds 1` limits it further). A diagnose that finds every dimension fine ends the loop without a rewrite. There are no A/B judge panels, no selector, and no automatic retries.
7. **Hand-off.** The retained script is written once to `revision_loop/final_script.txt`; the command prints its path and SHA-256 for `goldflow run preflight --content-profile manhwa_recap_v1 --media-workflow generated_visuals_v1 ... --source <final_script_path>` and ingest.
8. At 24 hours, 72 hours, and 7 days, record CTR and retention outcomes. After enough distinct uploads support one concrete change, propose one complete revised manufacturing template. Only explicit operator approval may activate that version at the channel level (`source manufacture learn`). Learning replaces the complete prompt template with a versioned, rollback-safe template; it never appends an addendum or extra context to a writer call.

**Brought scripts.** An operator-supplied script gets the same passes:

```bash
node bin/goldflow.mjs source manufacture revise --script <script.txt> [--development-dir <dir>] [--brief <json>]
```

Without `--development-dir` the loop writes to a sibling `<script-name>_revision/` folder. The brought file is copied to `v00_incumbent.txt` and never modified; if verify does not judge a revision better, the original is the final script. A brief is optional; without one, diagnose infers the promise from the script. One development folder holds one brought script.

**Artifacts and receipts.** Every round folder keeps `incumbent.txt`, `notes.json`, `revision.txt`, `verdict.json`, `decision.json`, and each raw response with its `.meta.json` receipt, all written exclusively. `revision_loop_report.json` summarizes rounds, decisions and the final hash; `revision_timing_report.json` records per-call timing; `manufacturing_timing_report.json` covers ideation through revision. Rerunning any command resumes from hash-verified receipts without new spend; a changed prompt or incumbent stops rather than overwriting.

**Model calls per ideation run.** Old default: 2 ideation + 1 prepare + 3 Pro drafts + 1 selector + 4-8 improvement calls (one editor plus three blind judges per round) = 11-15 calls, plus an operator title approval and exact-script review. New default: 2 + 1 + 1 Pro draft + 3-6 revision calls = 7-10 calls, no operator stop.

**Per-run model choice.** The first `write` (or `revise`) writes `manufacturing_model_lock.json` once: provider, model and effort for the `writer`, `diagnose`, `revise` and `verify` roles. Every later stage and resume uses it; a flag that disagrees with it stops the command. Choose with `--writer-model`, `--revision-model` (all three revision roles), or per role with `--diagnose-model`, `--revise-model`, `--verify-model`. Supported models:

- `chatgpt_web`: `gpt-6-sol` (default for every role; the writer runs at visible Pro).
- `claude_cli`: `claude-fable-5-1`, `claude-opus-5-5`, run through Claude Code headless print mode (`claude -p --output-format json --model <model> --effort <level>`) with the prompt on stdin. Built-in tools, MCP servers, slash commands and hooks are disabled and no session is persisted, so the call is read-only. It has a timeout, no automatic retry, and writes the same raw output and `.meta.json` receipt (provider, transport, model, effort, CLI version, hashes) as the ChatGPT Web path. `ANIFACTORY_CLAUDE_CLI_PATH` overrides the executable.

Ideation, shortlist and template filling keep their existing ChatGPT Web contract. A portfolio written before the lock existed keeps the writer recorded in the portfolio. GPT-6.1 Sol is not yet selectable: the ChatGPT Web picker contract (`apps/goldflow-studio/lib/chatgpt-ui-contract.mjs`) has no verified visible label for it, and `gpt-6.1-sol` is only a confirmed Codex CLI slug. Add it to that contract and to `SUPPORTED_SOURCE_MODELS` in `scripts/lib/source-model-lock.mjs` once the picker label is verified. A side-by-side such as `--writer-model claude-fable-5-1` on one premise uses a separate development folder per writer.

**Separate commands** remain for checkpoints and recovery: `ideate`, `prepare`, `write`, `revise`. Existing multi-draft portfolios keep `select`, `improve`, `compare-prompts`, `audition` and `promote`, and `run` on such a folder keeps its historical select/improve behavior.

Code may validate completeness, hashes, receipts, anchors and lineage and slice exact word windows, but every creative word (titles, premises, notes, revisions) comes from a model call.

## Optional First-Class Story Room V4

The prior room remains available as an explicit advanced diagnostic or research mode. It is not the default and is not required before production.

1. `source evidence-registry` imports one measured, limitation-aware evidence registry. AI rankings and synthetic premise scores are not audience evidence.
2. `source package-outliers` imports a hash-bound ledger of exact measured own-channel and niche-outlier titles. Each entry keeps public demand and private viewing signals separate and retains their limitations.
3. `source premise-discover` runs two isolated ChatGPT Web raw-movie scouts and one blind hostile selector before any title or thumbnail authoring. The scouts receive measured audience desires and a hard internal produced-premise exclusion ledger, but no title formula. Each movie must survive noun stripping, produce one phone-readable power receipt, preserve protagonist agency, and open a consequential escalation frontier. The selector advances exactly six unchanged movies or rejects the pool. Use `--premise-reasoning-effort medium` for the default fast discovery pass; this is an editorial speed choice, not audience evidence.
4. `source ideate-v2` packages each selected raw movie exactly once per independent author. GPT Web and Gemini Web work in isolated contexts, but neither may invent a replacement premise or mutate the chosen wound, owned action, advantage, or escalation frontier. Goldflow hash-binds every package to its raw-movie ID, seals the twelve executions behind deterministic blind IDs, and requires a fresh Gemini judge to advance exactly one package per movie without provider identity. Every package must name one exact outlier source, transfer its measured desire rather than its plot skin, and express the raw movie with one simple title-thumbnail receipt. Strong runway cannot rescue weak click potential.
5. `source package-tournament` sends all six blind-screen finalists to GPT Web Pro and Gemini Web 3.7 Flash concurrently. Author-written click and runway grades remain evidence but have no admission authority. Each judge compares the complete click movie, simple thumbnail receipt, measured-demand transfer, twist value, reskin risk, and 10K-word runway veto. Only the same candidate rated strong for both click and runway by both judges becomes consensus. On disagreement, `source adjudicate-package --candidate-id <eligible-id> --adjudicated-by <operator> --rationale <text>` writes an immutable, judge-hash-bound operator decision without altering the truthful disagreement artifact.
6. `source approve-package-v2` requires either strong tournament consensus or a valid operator adjudication for outlier-led rooms, then separately hash-approves the exact selected package before treatment spend. Neither machine consensus nor adjudication replaces package approval.
7. `source reference-frontier --reference <exact measured outlier transcript>` imports the complete outlier the operator selected as the story benchmark, hash-binds it, and asks Gemini Web to chart thirteen dimensions of viewer appetite plus an uncapped, non-duplicative inventory of every material reference-specific edge. It defaults to the package's mirrored outlier; pass `--reference-entry-id <package_outlier_ledger entry>` when a different measured reference is deliberately selected. Every anchor must occur exactly in the reference. The normalization unit is viewer-payoff quality per 1,000 words and estimated spoken minute, never raw runtime or raw inventory.
8. `source treatments` authors boundary-drama, adaptive-contest, and reclassification treatments concurrently across GPT Web and Gemini Web. Each receives the frontier and must propose a route to exceed every appetite without copying plot skin. `source select-treatment` asks Gemini Web to compare exact anchored passages, then `source approve-treatment` locks the selected treatment.
9. `source architecture` builds one 9,500-10,500-word story architecture with a binding `dramatic_cold_open_v2` contract, a merit-dominance contract covering every fixed dimension and every material edge, protagonist agency, relationship and opposition ladders, learning, continuity, climax proof, and complete closure. Before the call, Goldflow snapshots a release-derived supporting-name familiarity ledger with a default 12-episode TTL. Recent reuse receives a decaying soft weight, reaches zero outside the TTL, and never becomes a ban; Joey and approved recurring-series characters are exempt. Continuations are entirely exempt so established cast names remain stable: pass `--continuation true`, while titles containing Part/Episode/EP 2 or higher activate the same safety net automatically. The opening contract begins with a visible event and specifies its wound, pressure, choice, counteraction, result, next question, and exposition-release point. It may not spend the opening teaching lore or procedure before drama. `source architecture-audit` also rejects dangling opening promises, unexplained power provenance, incompatible possession/history states, auditory name collisions, missing material-edge proof, and frontier plans that substitute raw count for density. No automatic rewrite loop exists. `source approve-architecture` locks the accepted exact hash.
10. `source story-truth` asks an LLM at Medium to author the model-neutral Story Truth IR from the approved architecture and compact package receipt. Story Truth binds title and thumbnail promises to spark, first-proof, escalation, and full-payoff deadlines; records every causal chain as pressure -> owned choice -> consequence -> counter -> changed situation; and tracks agency, setup/payoff, mechanics, resources, possession, knowledge, relationships, public status, and reveals. `source story-truth-audit` independently inspects the exact authored hash.
11. `source writer-packet` asks an independent Medium LLM editor to condense the approved package, treatment, and architecture into a natural 1,200-4,000-word editorial packet capped at 32,000 serialized characters. Code validates hashes, cast, mechanics, every movement, payoffs, and size but does not write or summarize the packet.
12. `source script-v2` sends only the LLM-authored writer packet plus the short prose instruction to six isolated authenticated ChatGPT Web writers concurrently: three GPT-5.6 Sol Pro drafts and three GPT-5.5 Pro drafts selected through Advanced. The three creative lenses emphasize reversal velocity, relationship pressure, and strategic outplay once per model. Every draft is 9,500-10,500 words and receives exactly one creative submission. A fresh Medium Gemini context receives the packet, blind IDs, and exact texts, then selects one draft byte-for-byte. It cannot transplant or blend prose.
12. `source opening-audio-audition` synthesizes blinded 60-90-second excerpts from the top two ranked complete drafts with the exact locked Qwen/Joel production voice. A reviewer records cadence, name density, exposition drag, emotional clarity, and immediate click satisfaction. The manifest and review are mandatory release lineage; the preference remains advisory unless a later multi-episode calibration explicitly promotes decision authority.
13. `source diagnose-v2` runs causality/learning, promise/continuity, narrative-authenticity, opening-stress, character-agency, anti-slop, and reference-density diagnostics concurrently. Findings require exact source offsets and are review evidence, not freeform rewrite orders. The new lanes explicitly catch exposition-first openings, convenient accidents, unexplained stupidity, generic humiliation, repeated sentence equations, fake profundity, interchangeable supporting characters, repeated mechanic explanations, and administrative conflict replacing title-native spectacle.
14. `source revise-v2` permits one GPT Web developmental revision against accepted exact-anchor findings. It repairs the named structural defect while preserving passed Story Truth obligations and existing frontier wins. A later repair must name exact finding IDs; passed prose is never regenerated by an unscoped loop.
15. `source narration-revise-v2` applies one plot-locked narration pass for breath length, cadence, sentence contrast, pronunciation, spoken clarity, and join safety. It may change at most five percent of the word count and may not change facts, reorder events, alter the ending, or create new story material.
16. `source story-map-v2` maps every Story Truth promise and obligation to exact byte offsets in the final narration. Promises require separate spark, first-proof, and full-payoff anchors. This map lets later retention data identify the exact story function viewers were hearing.
17. `source accept-v2` asks Gemini Web to verify all semantic obligations, Story Truth mappings, cold-listener comprehension, every frontier dimension, and every material edge against the exact narration-polished script. Acceptance requires a candidate win on every comparative row and an absolute comprehension pass; ties or explanation debt fail. There is no automatic second revision.
18. `source mixed-viewer-panel` runs the precommitted five-GPT/five-Gemini panel against the exact final candidate and measured reference. All ten reports, provider receipts, the aggregate, the panel seed, and the current calibration policy are mandatory release lineage. Before promotion, the panel is advisory evidence only. After an explicit hash-bound multi-episode calibration promotion, a non-accept result stops for operator triage rather than silently rewriting the story.
19. The hash-bound ten-viewer tournament is a separate hostile release gate after the mixed-model panel. It uses the same precommitted panel and raw measured reference; never reroll viewers to seek favorable votes. New rooms require candidate preference from all ten viewers at every checkpoint, for APV and overall, and on every major dimension. Partial provider failure checkpoints passed reports and resumes only missing viewers after cooldown. Any repair creates a new candidate hash and requires fresh semantic acceptance, mixed-panel evidence, and a fresh tournament from the same panel. Simulated unanimity is an aggressive challenger standard, not a promise of real APV, CTR, or views.
20. `source release-v2` binds every raw premise slate, movie pool and selection, package slate, blind pool and decision, Story Truth artifact, all six draft bytes and provider receipts, selection, opening-audio audition, diagnostics, both revision ledgers, semantic acceptance, mixed-model panel and calibration policy, viewer tournament, and exact final script. The loader reopens every draft and checks its real hash, word count, prompt hash, provider, model, effort, and transport. Existing V1-V3 rooms remain readable under their recorded contracts.
21. At 24 hours, 72 hours, and 7 days, `youtube-analytics-feedback` maps retention points through Whisper timing to exact script passages, Story Truth functions, simulated-viewer leave predictions, and the episode's hash-bound prompt/raster, hero, motion, narration-review, and package evidence. It writes `episode_quality_outcome_<episode>_<window>.json`; `analytics aggregate --learning-output <channel-ledger>` creates observational calibration evidence for the next premise room. One upload never changes a default; operator review is not eligible until at least three distinct episodes exist.

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

Default manhwa source manufacture (no operator stop; see the default flow above):

```bash
# Full chain: ideate -> auto-title -> prepare -> one Pro draft -> diagnose/revise/verify (<= 2 rounds)
node bin/goldflow.mjs source manufacture run --development-slug <slug> --evidence <evidence.md>

# The same stages one at a time (each resumes from hash-verified receipts)
node bin/goldflow.mjs source manufacture ideate --development-slug <slug> --evidence <evidence.md>
node bin/goldflow.mjs source manufacture prepare --development-slug <slug>
node bin/goldflow.mjs source manufacture write --development-slug <slug>
node bin/goldflow.mjs source manufacture revise --development-slug <slug> [--max-rounds 1]

# Operator-supplied script through the same revision passes
node bin/goldflow.mjs source manufacture revise --script /absolute/path/to/script.txt
```

Revision efforts default to `--diagnose-effort high --revise-effort high --verify-effort medium`; each accepts only `medium` or `high`. Models default to `gpt-6-sol`; `--writer-model claude-fable-5-1` or `--revision-model claude-opus-5-5` selects the Claude Code CLI provider and is locked for the folder. `--target-word-count` (default 10000) sets the auto-selected brief's advisory length.

The room commands below are the optional First-Class Story Room and legacy retention room.

Live ideation author and selector calls honor `--timeout-ms` and default to sixty minutes. A provider throttle or transport failure before submission is not a creative attempt; inspect the provider receipt and wait for the applicable cooldown before starting one intentional replacement call. If the author passed and only the independent selector failed, rerun `source ideate` with the same inputs plus `--resume-selector true`; Goldflow hash-verifies and reuses the passed author output without another author submission.

For a new First-Class Story Room V4 premise batch, run discovery before packaging:

```bash
node bin/goldflow.mjs source premise-discover \
  --channel 53rebirth \
  --development-slug <stable-development-slug> \
  --premise-reasoning-effort medium

node bin/goldflow.mjs source promote-premise-movie \
  --channel 53rebirth \
  --development-slug <stable-development-slug> \
  --movie-id <blind_movie_id> \
  --promoted-by <operator> \
  --rationale <operator rationale> \
  --canon-clarification <approved causal clarification>

node bin/goldflow.mjs source ideate-v2 \
  --channel 53rebirth \
  --development-slug <stable-development-slug> \
  --premise-reasoning-effort medium
```

The first command writes two immutable discovery slates, a blinded 24-movie pool, and a six-movie selection. The second command must package those six hashes exactly once per author and advance one package per movie. New V4 ideation refuses to run when the discovery artifacts are absent.

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

When the operator keeps the judged title/story package but simplifies its thumbnail before approval, use `source revise-package-thumbnail`. The immutable revision binds the original judged package hash and changes only `thumbnail_receipt`; downstream approval hashes the revised package without rewriting tournament history.

Treatment planning may use `--treatment-reasoning-effort medium` for the ChatGPT boundary and reclassification authors. This speed override never applies to the six final longform draft candidates, which remain locked to their declared Pro model contracts.

Structured story architecture may likewise use `--architecture-reasoning-effort medium`. The architecture remains evidence-bound and independently audited; this planning-speed override never changes the six final longform draft candidates, which remain locked to their declared Pro model contracts.

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
