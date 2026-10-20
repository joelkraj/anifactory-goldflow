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
- a **blocker**: no automatic decision exists, the decision rejected with no repair route, a command failed without changing status, a repair item was already repaired once, a dispatch already timed out or was interrupted once, the step limit was reached, or status asked for the operator-only `run relock-tts`;
- **code_drift**: the executing HEAD does not contain the identity commit, or the worktree is dirty (see below);
- **lock_held**: another live driver, or a driver on another host, holds `autopilot/driver.lock`;
- **child_timeout**: a stage command exceeded its wall budget (see below);
- **status_timeout**: `run status` itself failed or exceeded its budget.

This list is exhaustive (`AUTOPILOT_STOP_REASONS` in `scripts/lib/autopilot-driver.mjs`). Each stop other than the two human steps writes `autopilot/triage/<seq>_<kind>_<stage>.json`, so nothing is skipped silently. `run auto` refuses to start on any identity whose `run_intent` is not `production`, and on identities without the autopilot lock.

The driver runs only the status command shapes, so the workflow guard, provenance and rerun policies all still apply. It never adds `--workflow-bypass` and never dispatches `run relock-tts`. Repairs are bounded to one exact-scope repair per failed item, recorded in `autopilot/repair_ledger/`. A step that leaves status exactly where it was counts as a failure, and the driver does not retry it in a creative loop.

### Driver hardening (R08)

- **One driver per episode.** `autopilot/driver.lock` holds `{pid, host, started_at, head, heartbeat_at}` and is the only mutable driver state; the heartbeat is rewritten before every step and the lock is removed when the driver stops. Same host and a dead pid: the new driver takes over and appends a `lock_takeover` driver event. A live pid, or a lock from another host: `lock_held` triage, nothing runs.
- **Code drift by ancestry, never equality.** Every `driver_events.jsonl` row records the executing HEAD, whether the worktree is dirty and a hash of the dirty diff. When the identity commit is an ancestor of HEAD and the worktree is clean, the driver continues and appends one `code_drift` event per distinct HEAD listing the intervening commits. When HEAD is not a descendant, or the worktree is dirty, it writes a `code_drift` triage. `run auto --allow-code-drift <reason-code>` lets an operator continue anyway: the drift is recorded with that code, and the flag is forwarded to the stage commands only for a non-descendant HEAD (the operator passed it, the driver never invents it). The identity is never rewritten.
- **Child wall budgets.** `STAGE_WALL_BUDGETS`: max(2 × the largest successful `wall_time_sec` recorded for the stage, 900 s) from the two recorded 2026-W43 coma-healer runs (one episode each, so no p95); unmeasured stages use 1800 s, poll verbs 300 s, `run status` 600 s. Provisional until a second production episode is recorded. A timeout signals the child's whole process group (SIGTERM, then SIGKILL after 15 s), is a terminal `child_timeout` stop recorded in the driver events and the triage file, and counts against the dispatch's key in `autopilot/repair_ledger/` so it is never re-dispatched automatically. For a Fal dispatch the triage names the matching observe verb (`dispatch-bulk` → `observe-bulk`, `billing-submit-reference` → `billing-observe-reference`, …): already-submitted request IDs are observed, never resubmitted; spend authorizations stay as recorded.
- **SLO breach is an event.** `production_slo_state.json` (or, without it, the elapsed time since the autopilot lock against the 420-minute ceiling) at `breached` appends one `slo_breach` event; the driver continues the single critical path.
- **Resume.** Repair keys are written before execution and reloaded at start, so an interrupted repair is never retried. On restart the driver finds a `run` event with no `exit`, appends an `interrupted_child` event, and when that child was a paid dispatch records its dispatch key so status can only route to the observe verb.
- **Dry run.** `run auto --dry-run true` reads status once and prints the schedule from the recorded ledger: the next shape's disposition (run, prose, placeholder, repair-bound, dispatch-bound), its wall budget, the lock, the code-drift decision, the SLO state, the repair keys, the driver events and the triage files. It executes nothing, writes nothing and takes no lock.

## Implementation status (2026-10-20)

| Item | Status |
| --- | --- |
| Gate inventory (this document) | done |
| Episode budget lock: `run preflight --episode-budget-usd <usd>` → `episode_budget` in the identity | done (`scripts/lib/episode-budget.mjs`) |
| Episode cap enforced on every Fal paid submission (`submitRows`), on top of the Fal hard budget and retry cap, with append-only authorization receipts | done |
| `--confirm-spend episode_budget` accepted by `fal-production.mjs` on a budget-locked identity; exact tokens unchanged | done |
| Workflow guard mapping `episode_budget` onto the exact token that status names (`guardFlagsForEpisodeBudget`) | done; Joel approved (roadmap Q41, 2026-10-20) and R07 un-held it: preflight-locked cap, Fal hard budget and retry cap stay on top, one authorization receipt per dispatch |
| `--autopilot true` policy lock (`scripts/lib/autopilot-policy.mjs`) | done |
| Automatic gate deciders (`autopilot-gates.mjs`), model reviewer (`autopilot-reviewer.mjs`), command shapes (`autopilot-command-shape.mjs`) | done |
| `run auto` driver (`autopilot-driver.mjs`, `scripts/run-auto.mjs`) | done |
| Driver lock, ancestry code-drift events, process-group child timeouts, SLO event, interrupted-child resume, `--dry-run` (R08) | done; wall budgets provisional (n=1 episode) |
| Guard admits decision-bearing shapes without a bypass; `--bypass-reason-code` enum; no environment bypass; shared command builder (R07) | done (`scripts/lib/workflow-guard.mjs`, `workflow-bypass.mjs`, `workflow-command-builder.mjs`) |
| `final_watch` stage, `run final-watch`, `youtube auto-upload`, `youtube publish`, `youtube author-packaging` (`autopilot-publish.mjs`, `autopilot-packaging.mjs`) | done |
| Policy: AGENTS.md, generated-visuals and manhwa guides | done |
| Tests: `npm run test:autopilot` (no network; injected executors) | done |

**Not exercised yet:** a real episode end to end, the live Data API publish script (`scripts/youtube-data-api-publish.py`, which needs a one-time `youtube.force-ssl` consent), and real model-reviewer prompts against production artifacts. The first autopilot episode should be watched closely.

## What could not be safely automated

- **Pinning the comment.** The YouTube Data API can post a comment but has no pin endpoint. `youtube publish` posts it and records `pinned: false` with `pin_method: manual_studio_followup`. The status evidence then says to pin it in Studio. This is the only follow-up after publish.
- **OAuth compliance audit (Q54, R11).** `config/youtube_api_compliance.json` (`{audited: true|false|"unknown", verified_at, verified_by, notes}`) records whether the Data API project has passed the YouTube API Services compliance audit. `youtube auto-upload` binds that record into the upload receipt (`api_compliance`, `publish_path`). While `audited` is not `true`, the upload stops at an explicit unsupported-publish-path gate before any upload (the driver writes a triage), unless the operator declares the run private-review-only with `--private-review-only true`; `youtube publish` then refuses to make the video public or scheduled, with a message that the visibility flip stays a Studio step (record it with `record-schedule` / `record-comment`). A private-review-only upload never becomes a Data API release later, even after the audit is recorded. The repo config currently says `"unknown"`.
- **Checking the audit status (Q54 procedure, R11).** Joel does not know the status (2026-10-20), so the config says `"unknown"`, which `youtube publish` and `youtube auto-upload` treat exactly like not audited. The empirical check, run by a person outside any production session and never by autopilot: upload a 10-second test MP4 through the same OAuth project (`scripts/youtube-data-api-upload.py` credentials) with `privacyStatus: "unlisted"`, then open the video in YouTube Studio. If YouTube has forced it to **private** and Studio shows a "locked as private" notice, the project has not passed the API Services compliance audit: record `audited: false` with `verified_at`, `verified_by` and the notice text in `notes`. If the video stays unlisted, record `audited: true` with the same fields. Either way delete the test video in Studio afterwards and keep the test out of episode receipts (a proof-scoped note, not an upload receipt). The check is the roadmap's bounded R11 verification and needs Joel's explicit go-ahead in chat before anyone runs it.
- **Channel upload defaults (R11).** An optional `channels/<channel>/channel_upload_defaults.json` (`goldflow_channel_upload_defaults_v1`: `monetization` on|off, `mid_roll_mode` automatic|manual, `comments` on|off|held_for_review, `notes`, `updated_at`) pre-fills the Studio-only values the approver is asked to confirm; the refusal message and the publish receipt (`studio_settings.prefilled_from_defaults`) show them. It never satisfies `--studio-settings-verified true`, which stays a per-publish human flag recorded as `confirmed_by_approver`, never as API-verified.
- **Upload timing.** The private upload starts as soon as final QA, automated packaging and `youtube prepare` have passed, with no human step in between, so YouTube's processing overlaps the final watch. The watch stop prints the local MP4 path and the processing status; the registry order is unchanged (`final_watch` after `youtube_studio_upload`). The pinned-comment contract itself accepts `pinned: false` + `pin_method` for autopilot identities (`pinFollowupAllowed`); historical identities keep the `pinned: true` check.
- **Studio-only settings.** The Data API cannot read monetization, mid-roll or comment settings, so the human confirms them as part of the publish approval (`--studio-settings-verified true`).
- **Legacy narration contracts** (exact listen and subjective sampling) go to triage instead of a fake listening attestation.
- **Creative recoveries that need authored artifacts**: reference-plan repair recipes, panel composition repair recipes, Fal transport recovery and no-job adjudication. These go to triage, with the model's findings attached where it gave any.

## First unattended episode: setup checklist (2026-10-20)

Operator setup, once per channel (none of it is an approval gate):

1. `<AniFactoryData>/channels/<channel>/channel_preset.json` (schema `goldflow_channel_preset_v1`, see `docs/workflows/channel_preset.md`) with `image-provider: fal_ai`, `fal-contract`, the narrator voice id, `autopilot: true` and `episode-budget-usd`.
2. `<AniFactoryData>/channels/<channel>/autopilot_packaging.json` (schema `goldflow_autopilot_packaging_config_v1`): at least three recorded `research_evidence` rows observed within 120 days, `youtube_channel` {expected_name, expected_handle, expected_channel_id} and `publish_settings`.
3. YouTube Data API consent, one time, in the research venv: the upload token (`youtube.upload` + `youtube.readonly`) is obtained by the first `youtube auto-upload`; the publish token (`youtube.force-ssl`) is obtained without touching any video by `python scripts/youtube-data-api-publish.py --authorize-only` (opens a browser consent, writes `youtube_publish_manage_token.json`).
4. `config/youtube_api_compliance.json`: leave `audited: "unknown"` until the YouTube API Services audit result is known; the public flip then stays in Studio.

Run:

```bash
node bin/goldflow.mjs run preflight --content-profile manhwa_recap_v1 --media-workflow generated_visuals_v1 --run-intent production --source-handoff <dev-dir>/revision_loop/source_handoff.json --channel-preset <AniFactoryData>/channels/<channel>/channel_preset.json --channel <channel> --series <series-slug> --week <run-slug> --episode ep_01
node bin/goldflow.mjs run auto --episode-dir <episode-dir>
```
