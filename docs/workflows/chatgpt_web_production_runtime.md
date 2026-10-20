# ChatGPT Web Production Runtime

Status: opt-in writer transport for the single-draft source flow; the browser host itself is not running and needs repair before unattended use (see the 2026-10-20 inventory below). The 2026-08-08 calibration ledger that follows it is retained unchanged.

Snapshot dates: 2026-10-20 (runtime inventory, opt-in writer), 2026-08-08 (calibration ledger)

## Purpose

This document records observed ChatGPT Web behavior for Goldflow. It is an evidence ledger, not a claim that a ChatGPT subscription is equivalent to an API or guarantees unattended throughput.

## Runtime Inventory (2026-10-20)

What a `source manufacture run --transport chatgpt_web --writer-model gpt-6-astra` call needs on this machine, and what was actually found. Nothing here was repaired; it is the state to fix before an unattended draft.

| Component | What it does | State found 2026-10-20 |
| --- | --- | --- |
| Goldflow Studio desktop host (`npm run studio:desktop`, `apps/goldflow-studio/desktop/main.mjs`) | Localhost OpenAI-compatible queue on `127.0.0.1:4317`, owns the Playwright Chrome, verifies the signed-in plan, selects model/effort visibly, submits once per job | Not running. The last recorded worker process (pid 4765, started 2026-09-09) is gone; nothing listens on 4317/4318/4319 |
| Planning route registry (`~/.goldflow-studio/planning-routes.json`, `apps/goldflow-studio/lib/planning-route-registry.mjs`) | Publishes the Studio URL/token/model so the planner runner finds the local API without env vars | File present (updated 2026-09-09) but its pid is dead, so `readPlanningRouteRegistrySync` returns null and the runner ignores it. Rewritten automatically when the host starts |
| Studio ChatGPT profile (`~/.goldflow-studio/chatgpt-browser-profile`, Chrome at `/Applications/Google Chrome.app`) | Persistent signed-in ChatGPT session (Pro plan) | Present and still signed in (login marker 2026-09-09; a read-only probe on 2026-10-20 reached the composer without a sign-in page) |
| Studio ChatGPT UI adapter (`apps/goldflow-studio/desktop/chatgpt-browser.mjs`, `lib/chatgpt-ui-contract.mjs`) | Composer, power-menu and model-picker selectors; label contract per model slug | Drifted: the composer selectors, the power-button selector, the "Advanced"/"Model" rows and the "Effort <label>" text no longer match chatgpt.com. Details in `docs/proofs/chatgpt_web_picker_probe_2026-10-20.json`. Label contract updated for `gpt-6-astra` -> "GPT-6" |
| External runner fallback (`/Users/joel/codex-chatgpt-web-goldflow/.goldflow-runtime/goldflow-jobs.mjs`, `scripts/chatgpt-web-planner-helper.mjs`) | Used only when no Studio route is registered; drives its own Chrome from a launcher descriptor | Runner file present (2026-09-06 build) but `~/.codex-chatgpt-web/runtime/launcher-browser.json` is missing, so the helper fails at `fs.access` before any submission. Its model table already knows `gpt-6-astra` and accepts the labels "Latest", "GPT-6" and "GPT-6 Astra" at Pro only |
| Shared throttle state (`~/.codex-chatgpt-web/runtime/goldflow-browser-throttle.json`, `scripts/lib/chatgpt-web-throttle-state.mjs`) | 15-minute browser cooldown after any observed rate limit; checked before every browser submission | Present; last cooldown 2026-08-13, expired. The one-resubmit policy below waits `CHATGPT_WEB_THROTTLE_COOLDOWN_MS` (floor 60 s, default 15 min) |
| Worker leases (`~/.codex-chatgpt-web/runtime/goldflow-worker-leases/`) | Text/deep-text/browser slot leases for the external runner | Directories present, empty |

Live picker, read from the Studio profile on 2026-10-20: the composer control labelled "Select ChatGPT model" opens one menu with a "Power" slider ("Pro, 5 of 5" at maximum) and a "Select model" view holding exactly two choices, **"GPT-6"** (selected) and **"GPT-5.6 Sol"**. No "GPT Astra", "GPT-6 Sol", "GPT Sol 6.1", "GPT-5.5" or "Latest" entry exists. The slug `gpt-6-astra` therefore maps to the label "GPT-6"; `gpt-6.1-sol` has no web label and stays a Codex CLI model.

### What must be running for an unattended browser draft

1. Chrome installed at the default path and the Studio profile signed in (`npm run studio:login` once if the marker is stale).
2. `npm run studio:desktop` (or `studio:hybrid`) alive for the whole run: it registers the route, owns the browser and serves `127.0.0.1:4317`. Without it the runner falls through to the external runner, which currently cannot start (missing launcher descriptor).
3. The Studio ChatGPT adapter repaired against the current chatgpt.com DOM (composer, "Select ChatGPT model" trigger, "Select model" view, power slider). Until then `verifyUiContract` fails closed with `ui_contract_mismatch` and no draft is submitted.
4. `GOLDFLOW_STUDIO_CHATGPT_MODEL_LABEL` left at its default or set to a label that exists ("GPT-6"); the default in `apps/goldflow-studio/server.mjs` is still "GPT-6 Sol", which the picker no longer shows.
5. The Goldflow command itself, with the explicit flags below. Keep the machine awake; the Pro draft can take over an hour.

## Opt-In Autonomous Drafting (single-draft flow)

`goldflow source manufacture run|write|revise --development-slug <slug> --transport chatgpt_web --writer-model gpt-6-astra [--writer-fallback claude-fable-5-1|claude-opus-5-5|gpt-6.1-sol|gpt-6-sol]`

- The browser transport is writer-only. `gpt-6-astra` is the only `chatgpt_web` slug in `SUPPORTED_SOURCE_MODELS`; planning, diagnose, revise and verify refuse it and stay on the CLI roles recorded in `manufacturing_model_lock.json`. The lock records `writer_transport`, `writer_resubmit_policy` and `writer_fallback` (null unless named) once; later flags that disagree stop the command.
- The draft stage is the same `winner_source_script_v3_draft_56_1` call with the same prompt, `max` effort, `.meta.json` receipt (provider `chatgpt_web`, transport `goldflow_studio_local_api` or `goldflow_authenticated_browser_jobs`), portfolio row, revision loop and `revision_loop/source_handoff.json` as the CLI transports.
- Throttle policy (`chatgpt_web_writer_one_resubmit_then_locked_fallback_v1`): a rate limit, usage limit or active-cooldown error gets exactly one resubmit after the shared cooldown. Any other failure, or a second throttle, goes to the locked `--writer-fallback` CLI writer with the identical prompt; with no fallback locked the stage stops with `manufacturing_candidate_failures.json`. There is never a third browser submission.
- Receipts stay append-only: each failed receipt is moved to `manufactured_drafts/failed_receipts/` before the next submission, and every attempt (submit, cooldown, resubmit, fallback, stop) is appended to `manufactured_drafts/writer_transport_ledger.json`. A fallback-written portfolio row records `writer_fallback_used: true`, `requested_writer` and `writer_transport_attempts`, and validates against the lock on reload.
- Tests: `scripts/tests/source-chatgpt-web-writer-tests.mjs` (injected executors, no browser). No live smoke draft has been run through this path; the first one needs Joel's approval in that session and a running, repaired Studio host.

## Current Lane Contract

- Text queue: 10 logical workers.
- GPT Image queue: 3 logical workers.
- Browser host: 10 live surfaces shared by both queues.
- Deep text: 1 serialized Extra High or Pro worker.
- Production-sized reasoning: at most 2 starts in a rolling 15-minute window.
- Global UI launch gap: 1,250 ms.
- Any observed rate limit: all text, image, and archive work stops locally for 15 minutes.
- Successful conversation archive: only the archive lane waits 15 minutes before another mutation.
- Archive cleanup is maintenance-only and owns a browser-wide lock while the mutation is active. Releasing that lock resumes ordinary work immediately unless ChatGPT displayed an actual rate-limit response.

Queue capacity is not request concurrency. Ten planner units may wait in the text queue while only the currently eligible effort and pacing lanes reach ChatGPT.

## Measured Results

### GPT Image

- Three concurrent referenced 16:9 image jobs passed 3/3.
- Wall time: 91.746 seconds.
- Output geometry: 1672x941 for all three accepted rasters.
- Evidence: `/Users/joel/AniFactoryData/diagnostics/chatgpt-web-concurrency/image3-prod-shape-v1/concurrency_report.json`.

### Tiny Medium Text

- Ten small Medium JSON requests passed 10/10 in approximately 31.5 seconds.
- This proves a small-request path only. It does not authorize ten production-sized reasoning starts.

### Production-Sized Reasoning

- One Extra High and one High request can overlap and complete successfully.
- A third production-sized reasoning request was rate-limited when started immediately after the first deep request completed.
- Adding one serialized deep-text worker did not remove the third-start rate limit.
- A two-start rolling 60-second gate still failed on the third request at approximately 62 seconds.
- Evidence:
  - `/Users/joel/AniFactoryData/diagnostics/chatgpt-web-concurrency/text3-deep-semaphore-v1/concurrency_report.json`
  - `/Users/joel/AniFactoryData/diagnostics/chatgpt-web-concurrency/text3-reasoning-window-v1/concurrency_report.json`

The safe heavy-request contract is therefore two starts per observed 15-minute reset window unless later clean evidence supports a narrower window.

## Pending Tests

- Production-sized Medium text at controlled higher concurrency.
- GPT Image inside a dedicated run-scoped ChatGPT Project, including raster download and proof that the resulting `/g/g-p-.../c/...` chat never enters the legacy archive queue.
- GPT Image in Temporary Chat remains an optional isolation comparison.
- Mixed production run after the separate text and image behaviors pass independently.

## Production Decision Rule

Use the highest reasoning effort that materially benefits the artifact, not the highest selectable effort everywhere.

- Pro: source authoring, winner synthesis, and global decisions where one long response replaces substantial downstream rework.
- Extra High: difficult evidence reconciliation only when High is insufficient.
- High: important bounded editorial and visual decisions.
- Medium: utility or high-volume chunk work only after production-sized calibration passes.

If the Web lane cannot meet a production deadline without pressing against a guardrail, use an authorized API or local/provider lane. Do not bypass the cooldown with extra profiles, sessions, or stagger tricks.

## Conversation Hygiene

Per-image archive is not a scalable production strategy. At one archive mutation per 15 minutes, 500 image chats would require more than five days of cleanup.

Preferred order:

1. One dedicated ChatGPT Project per Goldflow run, locked in `run_identity.json` with `--chatgpt-project-url`. Planning and GPT Image jobs create independent chats inside that project, while local artifacts and receipts remain canonical.
2. Temporary Chat when strict isolation matters and live GPT Image support has passed.
3. Serialized archive only for legacy regular chats during an intentional idle maintenance window.

ChatGPT exposes project deletion, not project-level archiving. Deleting a project permanently removes its project chats, files, and instructions, so Goldflow never does it automatically. Cleanup requires operator approval after all expected outputs, hashes, receipts, and QA artifacts are locked locally. Project memory can influence sibling chats; project prompts must remain self-contained, and a project should never mix channels or episodes.
