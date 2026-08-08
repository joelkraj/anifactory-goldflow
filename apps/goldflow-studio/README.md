# Goldflow Studio

Goldflow Studio is the local control plane for using a signed-in ChatGPT Pro browser session as an auditable Goldflow planning and image transport. It does not replace Goldflow's artifact chain. It leases work from the existing contracts and writes results back through their normal hash-bound completion functions.

## What It Adds

- An OpenAI-compatible localhost endpoint for existing Goldflow planner calls.
- A durable, content-addressed LLM queue. Identical completed calls are reused.
- A supervised Playwright desktop worker with one persistent signed-in browser profile, one fresh ChatGPT page per job, and a hard five-page limit.
- Exact image work from `goldflow imagegen codex-work`, including ordered reference uploads.
- An operator dashboard for stage status, dry-run advance previews, active manifests, workers, and failures.
- Confirmation-gated execution of exactly one automatic stage and reason-bound manual LLM requeue.
- Fail-closed behavior for account mismatch, UI drift, usage limits, rate limits, ambiguous leases, and output validation.

Goldflow Studio does **not** promise unlimited ChatGPT capacity. It uses the signed-in plan within the limits ChatGPT presents. It does not rotate accounts, hide limits, export cookies, or silently retry creative submissions.

## Start The Desktop Host

```bash
npm run studio:desktop
```

Or double-click `Goldflow Studio.command` in Finder. The launcher starts the localhost control plane and a dedicated Goldflow Chrome profile. Sign in to ChatGPT once in that window. The profile remains local under `~/.goldflow-studio/chatgpt-browser-profile` and is reused on later launches.

The desktop host is the production route. It owns the browser process, verifies authentication before leasing work, uploads references directly from Node, and keeps up to five isolated pages active without Chrome extension service-worker suspension.

Useful options:

```bash
node apps/goldflow-studio/desktop/main.mjs \
  --concurrency 3 \
  --types llm,image \
  --open-dashboard true
```

To attach only the desktop worker to an already-running Goldflow Studio server:

```bash
npm run studio:worker -- --server-url http://127.0.0.1:4317 --concurrency 3
```

## Legacy Extension Fallback

The unpacked Chrome extension remains available only as a proof and recovery fallback while the desktop host reaches production parity.

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `/Users/joel/anifactory-goldflow/apps/goldflow-studio/extension`.
5. Open the Goldflow Studio side panel, enter the pairing code, and pair.
6. Choose one to five workers, enable Planning and/or Images, then select **Save and dispatch**.

The fallback extension requests only:

- `https://chatgpt.com/*`
- `http://127.0.0.1/*`
- tabs, downloads, local extension storage, alarms, and its side panel

It does not request cookies, browsing history, all-site access, or third-party hosts.

## Route Existing Planning Stages

The desktop host pairs itself with the control plane. The dashboard displays the exact route variables for pipeline processes:

```bash
export ANIFACTORY_LLM_ROUTE=chatgpt-web
export ANIFACTORY_CHATGPT_WEB_URL=http://127.0.0.1:4317/v1
export ANIFACTORY_CHATGPT_WEB_TOKEN='<runtime admin token>'
export ANIFACTORY_CHATGPT_WEB_MODEL=gpt-5.6-sol
node bin/goldflow.mjs run advance --episode-dir /absolute/path/to/episode
```

The dashboard injects the runtime token when it launches a guarded `run advance`. Existing planner code still calls `runCodexCli`; the runner changes transport only when `ANIFACTORY_LLM_ROUTE=chatgpt-web` is explicit. Codex CLI remains the default.

## Image Work

Create the normal exact-scope manifest first, or create it from the dashboard:

```bash
node bin/goldflow.mjs imagegen codex-work \
  --episode-dir /absolute/path/to/episode \
  --action create \
  --prompts /absolute/path/to/episode/section_image_prompts_hardened.json \
  --image-ids cut_001,cut_002 \
  --max-attempts 1 \
  --lease-sec 1800
```

Activate the resulting `work_manifest.json` in the dashboard. The worker receives no arbitrary local path. References are served through authenticated localhost URLs and rechecked against their source hashes. The downloaded ChatGPT asset is decoded by Sharp, normalized to PNG, validated as 16:9, and completed through `completeWorkItem`.

## Recovery Policy

- Every LLM request is keyed by its normalized request hash.
- Every image is keyed by the existing Goldflow manifest and asset ID.
- A browser submission receives one creative attempt.
- A failure is recorded and never placed back on the queue automatically.
- An expired post-submission lease becomes `needs_triage`.
- Requeue requires an explicit operator reason from the dashboard API.
- A rate limit, usage limit, account mismatch, or ChatGPT UI-contract mismatch pauses all dispatch.

## Tests

```bash
node apps/goldflow-studio/tests/run-tests.mjs
```

The suites cover durable queue semantics, localhost auth and pairing, the planner adapter, exact image completion, desktop-host security boundaries, and extension fallback permissions.
