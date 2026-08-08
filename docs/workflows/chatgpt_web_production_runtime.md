# ChatGPT Web Production Runtime

Status: bounded production calibration in progress

Snapshot date: 2026-08-08

## Purpose

This document records observed ChatGPT Web behavior for Goldflow. It is an evidence ledger, not a claim that a ChatGPT subscription is equivalent to an API or guarantees unattended throughput.

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
