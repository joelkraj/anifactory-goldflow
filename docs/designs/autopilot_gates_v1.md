# Autopilot gates v1: production with two human steps

Decision (Joel, 2026-10-20): a production episode runs unattended from preflight to a finished, privately uploaded video. A human is involved only twice:

1. **Final watch.** Watch the rendered MP4 (or the private YouTube copy) and accept or reject it.
2. **Publish approval.** One command makes the private upload public or scheduled and posts the pinned comment.

Every other stop becomes an automatic decision. Each one:

- writes the **same approval artifact** the manual command writes, through the same command and validator;
- records the reviewer as `automated:<method>`;
- leaves an append-only decision receipt in `autopilot/decisions/` with hash-bound evidence;
- on rejection, routes to the existing exact-scope repair, or stops with a triage file.

This applies only to identities locked at preflight with `--autopilot true` and an episode budget (`--episode-budget-usd`). Historical identities and proof lanes keep their existing gates.

## Inventory and replacement

The **Stage** column refers to `scripts/lib/pipeline-stage-registry.mjs`. The **Before** column is what stopped for a human. The **Automatic decision** column names the `automated:<method>` reviewer.

### Registry approval gates

| Stage | Registry policy | Before | Automatic decision |
| --- | --- | --- | --- |
| `script_approval` | operator | `script approve --hash <script_clean_hash>` after an operator read the script | `automated:deterministic_script_checks`. It requires source ingest passed, then runs the same deterministic checks `script approve` enforces: the meta-contamination scan and a valid, passed power-system comprehension audit for this exact script hash. Pass → `script approve --hash <sha> --approved-by automated:…`. Any failure → triage. The script is never edited and the editorial-risk exception is never used automatically. |
| `visual_beat_plan` | operator_or_agent | `visual beats` writes `visual_beat_approval.json` (`approved_by` defaulted to `codex-agent`) | `automated:beat_plan_validator`. The same command with `--approved-by automated:beat_plan_validator`. Its own coverage, state and lock validator is the decision. Regrouping a locked plan still needs `--approve-regrouping`, which autopilot never passes. |
| `reference_plan_approval` | operator_or_agent | `visual approve-ref-plan --note "<reference plan review notes>"` (or the OpenArt `approve-plan`) | `automated:model_reviewer`. The built-in model reviewer (the planner runner) reads the hash-bound reference plan. Approve → the same command, with the reviewer and its note filled in. Reject → triage with the findings, because a reference-plan repair needs an authored exact recipe. |
| `reference_image_approval` | operator_or_agent | `visual approve-refs --cleanliness-reviewed true --note …` (a human attestation) or a Fal `review-validation` with reviewer and ids | `automated:model_reviewer`. Structural decoding (`--agent-review true`, the existing decoded-raster mode) replaces the human cleanliness attestation, and the model reviewer looks at each reference. Fal validation reviews get `--approve-ids/--reject-ids` from the model's per-image verdicts. Rejected Fal ids flow to the existing exact validation recovery. A rejected non-Fal reference → triage. |
| `image_output_qa` | risk_cut_decisions | Per-cut decisions for every risk cut, with reviewer and note, written by a human | `automated:image_qa_v1`. Cuts whose risks come only from automated checks that passed (geometry, zone-lettering OCR, semantic audit) are accepted. Only the cuts those checks flag go to the model reviewer. A rejection becomes `--critical-reject-cut-ids`, which status already routes to the page **zone repair** (`prepare-zone-repair`, with an authored request) or the Fal **owner repair** (`repair-reviewed-bulk`, with directives). Autopilot authors that request or those directives from the model's replacement prompt. Each zone or owner is repaired at most once. |
| `generated_video_motion_approval` | operator_or_agent | `visual approve-generated-motion --reviewer <name> …` | `automated:motion_coherence_audit`. Uses the existing `--agent-review true` coherence-pass-only mode. Clips without a coherence pass fall back to stills (the locked failure disposition). |
| `parallax_asset_approval` | operator_or_agent | `visual approve-parallax --reviewer <name> …` | `automated:parallax_separation_policy`. Uses the existing `--agent-review true` local separation policy. Declined candidates fall back to stills. |
| `final_qa` | operator_or_agent | `final qa --approve true --reviewed-finding-codes … --note …` | `automated:final_master_integrity`. Runs `final qa --master-scan true --agent-review true`, which approves only when there are no material blockers. With a blocker it does not approve, and autopilot writes a triage file. |
| `upload_packaging` | operator | A human authored `upload_packaging_<ep>.md` and the packaging spec, generated the thumbnail and ran `youtube approve-packaging` | `automated:packaging_validator`, for each content profile. Only `manhwa_recap_v1` (and legacy) packaging contracts exist. The packaging author (the model reviewer runner) writes the spec and markdown from the approved script and the channel's **recorded** research evidence. The thumbnail comes from the locked thumbnail route (an injected generator, from an approved provider). `validateYoutubePackagingSpec` must pass before approval. Missing research evidence or an unsupported profile → triage. Nothing is fabricated. |
| `youtube_publish_readiness` | automatic | — | Unchanged (`youtube prepare`). |
| `youtube_studio_upload` | operator | A browser upload, then `youtube record-upload` with every field verified | `automated:youtube_data_api`. `youtube auto-upload` uploads **privately** with the YouTube Data API, verifies the channel, privacy, title, description, thumbnail and audience from the API response, and writes the same upload receipt. Monetization, mid-roll and comment settings cannot be read through the Data API. They are recorded as deferred, and the publish approval must confirm them. |
| `final_watch` (new) | operator | — | **Human step 1.** Status stops with the MP4 path and the private watch URL. `run final-watch --decision accept|reject --reviewer <name> --note …` binds the decision to the final video hash. |
| `youtube_pinned_comment` | operator | `youtube record-schedule` or `record-upload`, then a browser pin and `youtube record-comment` | **Human step 2.** For autopilot runs this stage becomes the publish approval. `youtube publish --visibility public|scheduled … --approved-by <name> --studio-settings-verified true` changes visibility through the API, posts the manifest's pinned comment, and writes the publish and comment receipts. |

### Spend tokens

Every paid Fal action needed an exact per-dispatch token, for example `exact_fal_bulk_batch`, `exact_fal_zone_repair`, `exact_fal_reviewed_bulk_repair` and `exact_fal_validation_set`.

**Replacement:** one episode budget, locked into the run identity at preflight as `episode_budget.usd_cap`. On a budget-locked identity, `--confirm-spend episode_budget` authorizes any Fal dispatch whose projected episode spend stays within the cap. Each such dispatch writes an append-only authorization receipt in `episode_budget/authorizations/`. The workflow guard treats `episode_budget` as the exact token that status asks for. The existing hard caps still apply on top: the Fal contract's hard budget and the 10% paid-retry cap. The exact tokens keep working for manual use, and the episode cap is enforced for them too.

### Stops that are not registry gates

| Where | Before | Replacement |
| --- | --- | --- |
| Narration `tts approve-listen` (exact listen packet) | A human attested `exact_audio_listened_end_to_end` | Autopilot requires a narration quality contract with `acceptance_mode: automated_asr_v1`, which is the default `fast_premium_v2` profile. Under that contract, dual-ASR delivery consensus, word-timing transcript match, pace and loudness gates accept or block each unit, and the listen packet is not produced. A blocked unit is routed to the existing exact-unit repair (`tts narrate --confirmed-retry-unit-ids` or `tts repair-pronunciation-auto`). On a legacy contract, a listen request goes to triage, because autopilot will not claim it listened. |
| Narration `tts approve-subjective` | Mandatory human sampling | Not required under `automated_asr_v1`. Legacy contract → triage. |
| Narration `tts approve-narration` (avatar pilot) | Human listening | Out of scope: a proof lane. |
| Panel allocation import `visual panel-assets --plan <candidate>` | An operator reviewed the dense candidate | `automated:allocation_validator`. It runs `--action author-dense` when no candidate exists. It imports the newest `candidate_ready` report when that report has no blocker findings. The import re-validates the plan. |
| Panel composition `visual panel-plan --action compile --recipe <exact-reviewed…>` | A human-authored exact recipe after the author needed repair | Triage. A recipe with `needs_exact_repair` is creative work, and autopilot does not author it. The ready-recipe and author shapes are concrete commands and run automatically. |
| Fal review steps (`review-validation`, `review-validation-second`, `review-reference-probe-repair`) | reviewer, note and ids | `automated:model_reviewer` fills in the reviewer, the note and `--approve-ids/--reject-ids` from per-image verdicts. |
| Fal authored directives (`--directives <absolute_…json>`, transport recovery, adjudication) | A human-authored directives file | Reviewed bulk repair directives are authored from the model's replacement prompt. They run at most once per image. Transport recovery and ambiguous-submission adjudication → triage, because they need billing evidence the agent cannot see. |
| Operator holds in prose ("Operator hold: inspect…", "Triage zone repair…") | A human read the evidence | Triage file. Never a silent skip. |
| `--workflow-bypass`, dirty-worktree waivers, power-system editorial risk acceptance | Operator-approved exceptions | Never used by autopilot. |

### Proof lanes

The avatar pilot (`pilot …`), the CrimeDungeon proofs (`crime-proof …`, `crime-footage-*`) and any identity with `run_intent` other than `production` keep their gates. `--autopilot true` is refused for non-production intents. A proof still stops for approval before scaling.

## Driver

`goldflow run auto --episode-dir <dir>` loops: read status → execute the next valid command shape → read status again. It stops only at:

- `final_watch`, printing the MP4 path;
- the publish approval (`youtube_pinned_comment` on an autopilot identity);
- a **budget stop**: the episode cap or a Fal hard cap refuses a dispatch;
- a **blocker**: no automatic decision exists, the decision rejected with no repair route, a command failed without changing status, or a repair item was already repaired once.

Each stop writes `autopilot/triage/<timestamp>_<stage>.json`, so nothing is skipped silently.

The driver runs only the status command shapes, so the workflow guard, provenance and rerun policies all still apply. It never adds `--workflow-bypass`. Repairs are bounded to one exact-scope repair per failed item, recorded in `autopilot/repair_ledger/`. A step that leaves status exactly where it was counts as a failure, and the driver does not retry it in a creative loop.

## Implementation status (2026-10-20)

| Item | Status |
| --- | --- |
| Gate inventory (this document) | done |
| Episode budget lock: `run preflight --episode-budget-usd <usd>` → `episode_budget` in the identity | done (`scripts/lib/episode-budget.mjs`) |
| Episode cap enforced on every Fal paid submission (`submitRows`), on top of the Fal hard budget and retry cap, with append-only authorization receipts | done |
| `--confirm-spend episode_budget` accepted by `fal-production.mjs` on a budget-locked identity; exact tokens unchanged | done |
| Workflow guard mapping `episode_budget` onto the exact token that status names (`guardFlagsForEpisodeBudget`) | done after Joel's explicit approval |
| `--autopilot true` policy lock (`scripts/lib/autopilot-policy.mjs`) | done |
| Automatic gate deciders (`autopilot-gates.mjs`), model reviewer (`autopilot-reviewer.mjs`), command shapes (`autopilot-command-shape.mjs`) | done |
| `run auto` driver (`autopilot-driver.mjs`, `scripts/run-auto.mjs`) | done |
| `final_watch` stage, `run final-watch`, `youtube auto-upload`, `youtube publish`, `youtube author-packaging` (`autopilot-publish.mjs`, `autopilot-packaging.mjs`) | done |
| Policy: AGENTS.md, generated-visuals and manhwa guides | done |
| Tests: `npm run test:autopilot` (no network; injected executors) | done |

**Not exercised yet:** a real episode end to end, the live Data API publish script (`scripts/youtube-data-api-publish.py`, which needs a one-time `youtube.force-ssl` consent), and real model-reviewer prompts against production artifacts. The first autopilot episode should be watched closely.

## What could not be safely automated

- **Pinning the comment.** The YouTube Data API can post a comment but has no pin endpoint. `youtube publish` posts it and records `pinned: false` with `pin_method: manual_studio_followup`. The status evidence then says to pin it in Studio. This is the only follow-up after publish.
- **Studio-only settings.** The Data API cannot read monetization, mid-roll or comment settings, so the human confirms them as part of the publish approval (`--studio-settings-verified true`).
- **Legacy narration contracts** (exact listen and subjective sampling) go to triage instead of a fake listening attestation.
- **Creative recoveries that need authored artifacts**: reference-plan repair recipes, panel composition repair recipes, Fal transport recovery and no-job adjudication. These go to triage, with the model's findings attached where it gave any.
