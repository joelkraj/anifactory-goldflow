# Policy text tracker v1 (roadmap R12)

Running tracker for every sentence in [stabilization roadmap §7](stabilization_roadmap_v1.md#7-policy-text-changes-agentsmd-and-the-pipeline-docs). A sentence lands in the same commit as its code item and never ahead of it; text that outruns code is fake coverage. Statuses:

- **landed-with-item**: the code exists on the consolidated host and the sentence is in the named file.
- **pending-item**: the sentence waits for its code item (the session that lands the item adds the text).
- **pending-Joel**: the sentence waits for an answer in roadmap §6.2.

Maintained by whoever lands the item; `scripts/tests/pipeline-guidance-tests.mjs` asserts the landed sentences and the `approve-listen` allowlist.

## AGENTS.md

| # | Bullet | Sentence (short) | Item | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| A1 | No deterministic creative rewriting… | Transport-class retries of the identical prompt hash (≤2, receipted, `transport_retry_same_prompt_same_provider_v1`, budget-debited) are not creative retries | R03 | pending-item | p1-calls-cost session |
| A2 | same | Registered deterministic exact-scope repairs run once as append-only overlays; predecessor-panel fallback stays a hold | R13 (Phase 2) | pending-item | |
| A3 | A blocker is a triage point | Autopilot driver applies the registered recovery shape once, then holds; never passes `--workflow-bypass` | R07, R08 | pending-item | partial text from gates fe4dcd0 ("at most one automatic exact-scope repair") already present; the bypass clause waits for R07/R08 |
| A4 | Production preflight requires a clean worktree | Executing HEAD recorded in every new event; a HEAD that does not contain the identity commit is refused unless `--allow-code-drift <reason-code>` appends a `code_drift` event; `run auto` never passes it | R01 | landed-with-item | 87a0e45 (code), this tracker's commit (text) |
| A5 | same | On autopilot identities a clean descendant HEAD continues with an append-only `code_drift` event, anything else is a triage; untracked files outside `scripts/ bin/ config/ docs/` do not dirty the worktree | R08 (wording final per Q4) | pending-item / pending-Joel (Q4) | `gitExecutionProvenance` counts every untracked file as dirty today; the guard is ancestry-based for all identities, not autopilot-specific |
| A6 | Never route around the workflow guard | `--bypass-reason-code` enum, no `GOLDFLOW_WORKFLOW_BYPASS` env path, `run auto` never bypasses or dispatches `run relock-tts` | R07 | pending-item | p1-guard-driver session |
| A7 | Approved scripts and accepted media are immutable | `automated_asr_v1` evidence writer, one in-process retake/boundary/finalize, hash-bound spoken-form table, listen routes legacy-only | R05 | pending-item | p1-narration session; no audio re-seed exception until Q-tail (pending-Joel) |
| A8 | Explicit new-run selection | `run preflight --source-handoff <json> --channel-preset <path>`; preset supplies only operational flags | R09 | pending-item | p1-source-bridge session |
| A9 | Packaging bullet | Dense 3840×2160 pages with 1024×576 boards are the locked scene-art route for new panel identities; strict auto-import with receipt; span path retired (Claude CLI stays a planner) | R10 | landed-with-item | d5a31fa |
| A10 | Secrets bullet | `FAL_PRIVATE_BILLING_KEY_PATH`, `cost_reconciled` receipts, `billing_status: unavailable`, caps never raised from billed data, codex token usage per call | R02 | pending-item | p1-calls-cost session |
| A11 | Human steps | Exactly two human steps remain: `run final-watch` after the private upload and `youtube publish --visibility public|scheduled --approved-by <name>`; the OAuth-audit refusal and defaults-as-pre-fill clauses | R11 | landed-with-item | f6ee032 |
| A12 | Human steps | A rejected watch routes to an exact-unit narration patch/retime + audio-only remux + re-upload, never a full re-render | R18, R22 (Phase 2/3) | pending-item | |

## docs/pipelines/generated_visuals.md

| # | Anchor | Sentence (short) | Item | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| G1 | `:120` blocked planner stage | Registered deterministic repair runs first; hand repair is the fallback | R13 | pending-item | |
| G2 | `:97-98`, `:378` final QA | The final watch is the one human review; final QA is agent-reviewed with the panel-aware freeze filter | R17 | pending-item | gates text already says final QA is `automated:final_master_integrity`; the freeze-filter sentence waits for R17 |
| G3 | `:361` listening waiver | `approve-listen` / `approve-subjective` marked legacy-contract routes | R05 | pending-item | |
| G4 | `:155` m4a | m4a produced at `run cleanup`; `longform_audio_mix` is a validator | R29 | pending-item | |
| G5 | `:343` thumbnail route | Fal `gpt-image-2.5/sunburst` reference-guided thumbnail with OCR check | R30 (pending Q57) | pending-item / pending-Joel | |
| G6 | `:144-176, 318-385, 440-451` pools | Federated/browser-pool/readiness sections archived; Fal is the image provider | R25, R36 | pending-item | |
| G7 | stage table | Regenerated from the R25 registry with profile-aware approvals and `depends_on` | R36 | pending-item | |
| G8 | provider/narration contract | Interpreter/runtime pins (python3.14, MLX venv, Chromium build id) | R04, R22 | pending-item | |
| G9 | panel composition paragraph | Dense pages as the locked route of new panel identities (the R10 paragraph) | R10 | landed-with-item | d5a31fa (`:118` follow-on paragraph) |
| G10 | step 31 publishing | Upload right after prepare, compliance record and gate, publish refusal, defaults pre-fill, pin follow-up | R11 | landed-with-item | f6ee032 |
| G11 | `:132` execution events | Executing commit recorded per event; ancestry guard; `--allow-code-drift` | R01 | landed-with-item | 87a0e45 (text landed with the code) |

## docs/pipelines/manhwa.md

| # | Anchor | Sentence (short) | Item | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| M1 | `:7`, `:107`, `:22` | Single-draft lineage + registered comprehension audit + deterministic checks approve automatically (pending Q16/Q17); auto rank-1 brief emits a non-gate notice | R09 | pending-item / pending-Joel | `:107` already carries the gates `automated:deterministic_script_checks` sentence |
| M2 | `:21-22` planner model text | `config/planner-models.json` per role (gpt-6.1-sol; claude-fable-5-1); audit model from identity provider locks | R01 (1a6a738) | landed-with-item | this tracker's commit; `docs/workflows/planner_models.md` |

## docs/workflows/video_production_workflow.md

| # | Anchor | Sentence (short) | Item | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| V1 | `:171`, `:179` mandatory listening | Legacy contracts only (C11) | R05 | pending-item | |
| V2 | `:63`, `:69` driver never auto-approves | Profile-aware (`fast_premium_v2 agent_validated_stages`) (C12) | R36 | pending-item | |
| V3 | `:63, :67, :90, :377, :520` defaults | `fast_premium_v2` + `fal_ai` (C13) | R36 | pending-item | |
| V4 | `:486-491`, `:590` Studio publish | Data-API private upload + `youtube publish`; Studio only for the pin / manual mid-roll follow-up | R11 | landed-with-item | f6ee032 (step 26 autopilot paragraph; manual steps kept for non-autopilot identities) |

## docs/workflows/source_script_generation_workflow.md

| # | Anchor | Sentence (short) | Item | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| S1 | `:11`, `:17`, `:40-47` | Single draft on Codex gpt-6.1-sol, bounded diagnose/revise/verify, `source_handoff.json` | R31, R09 | pending-item | the single-draft text landed with script-single-draft (90a0e45); the `source_handoff.json` sentence waits for R09 |

## docs/designs/panel_production_v1.md

| # | Anchor | Sentence (short) | Item | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| P1 | `:99`, `:105` composed-frame review | Deleted as a gate; pre-render long-hold check and freeze filter | R16, R17 | pending-item | |

## docs/designs/autopilot_gates_v1.md

| # | Anchor | Sentence (short) | Item | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| D1 | inventory rows | Narration evidence writer, semantic/voice/beat/harden/panel repairs, transport retry, in-process Fal loop, Fal thumbnail, driver lock/drift/timeouts, final-watch reject route | R05, R08, R13, R18, R23, R30 | pending-item | |
| D2 | `:92` "Not exercised yet" | Updated after the proof episode | proof gate (§8) | pending-item | |
| D3 | what could not be automated | OAuth audit, channel defaults, upload timing / pin follow-up contract | R11 | landed-with-item | f6ee032 |
| D4 | panel allocation row | Strict import conditions, receipt, one chunk repair | R10 | landed-with-item | d5a31fa (`docs/pipelines/generated_visuals.md`; the inventory row text still says "no blocker findings" and is widened by R10's paragraph) |

## GOLDFLOW_PRODUCTION_DIRECTION.md

| # | Anchor | Sentence (short) | Item | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| X1 | `:43-69, :186-278, :328-363`, `:139, :151`, `:74, :80-83` | Antigravity/Gemini/Flow strategy and mandatory listening archived; model text replaced by the config reference | R36 | pending-item | |

## Not in §7 but landed by Phase-1 code

| Code | Where documented | Note |
| --- | --- | --- |
| Audit model lock (1a6a738): `image_output_qa` carries no `--semantic-audit-model` literal; the model resolves from the identity's provider locks | `docs/workflows/planner_models.md`, manhwa.md M2 | no AGENTS.md sentence; §7 has none |
| Commit-per-event (87a0e45) | generated_visuals.md `:132`, AGENTS.md A4 | |

## `approve-listen` allowlist (R12 verify)

Today `approve-listen` appears only in: `docs/designs/autopilot_gates_v1.md` (mapping table), `docs/designs/pipeline_map_v1/*` (analysis), `docs/designs/stabilization_roadmap_v1.md` and this tracker (planning), and `docs/workflows/narration_quality_v2.md` (legacy contract; R05 marks it legacy-only). `pipeline-guidance-tests.mjs` fails if it appears anywhere else.

## Removed by verification (never to be written without approval)

- The "bounded tail re-seed" exception (R18) is a §6.2 question (Q-tail): pending-Joel.
- The 90-day `channel_upload_defaults.json` self-attestation (R11): removed; defaults are pre-fill only.
