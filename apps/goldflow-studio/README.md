# Goldflow Studio

Goldflow Studio is the local control plane for using signed-in ChatGPT, Google Flow, and Google Gemini browser sessions as auditable Goldflow transports. It does not replace Goldflow's artifact chain. It leases work from the existing contracts and writes results back through their normal hash-bound completion functions.

## What It Adds

- An OpenAI-compatible localhost endpoint for existing Goldflow planner calls.
- A durable, content-addressed LLM queue. Identical completed calls are reused.
- Per-job visible effort verification. A `max` job must visibly select ChatGPT `Pro`; Instant, Medium, High, and Extra High jobs retain their exact requested setting.
- Supervised Playwright desktop workers with separate persistent signed-in profiles for ChatGPT, Google Flow, and Google Gemini.
- First-party Google Flow and Gemini media workers for Imagen stills plus selective Flow video. They use real clipboard paste events, ordered uploads, and the same one-attempt lease policy; no Chrome extension is involved.
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

The desktop host is the production route. It owns each browser process, verifies authentication before leasing work, uploads references directly from Node, and keeps isolated provider pages active without Chrome extension service-worker suspension.

For the complete production planning and media pool, launch all three signed-in surfaces together:

```bash
npm run studio:hybrid
```

This starts ChatGPT planning plus idle-image capacity on `127.0.0.1:4317`, shared Google Flow image/video work on `127.0.0.1:4318`, and Gemini planning plus idle-image capacity on `127.0.0.1:4319`. Each web provider is hard-capped at three active browser workers. New submissions are staggered by 20 seconds and each completed slot is topped off individually; the launcher never opens a simultaneous submission burst. Repeated transport failures pause that provider for five minutes, while a rate limit pauses it for ten. LLM leases take priority over image leases on ChatGPT and Gemini. The launcher keeps separate persistent profiles, bootstraps missing sign-ins one at a time, publishes the live planning routes to a local process-owned registry, and drains active work before shutdown. Production manifests still control exact eligible assets.

For the initial bounded Google Flow proof, start one image slot and sign in once in its separate profile:

```bash
npm run studio:flow
```

Flow defaults to the Ultra plan with `Nano Banana Pro` for stills and `Veo 3.1 Fast` for video, verifies the visible plan/model/geometry surfaces, and intentionally starts at concurrency 1 for a new bounded proof. Production uses the measured five-slot ceiling; change it only after a new stop-on-first-failure quota/concurrency proof.

```bash
node apps/goldflow-studio/desktop/main.mjs \
  --provider google-flow \
  --types image \
  --concurrency 2 \
  --flow-plan ULTRA \
  --flow-model "Nano Banana Pro"
```

The worker pastes through the browser clipboard because Flow does not reliably enable Create after synthetic `fill` or `insertText`. A rate limit, unusual-activity notice, disabled Create control, or ambiguous restart is recorded against the exact leased item and is never automatically resubmitted.

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

The hybrid launcher also publishes its ChatGPT and Gemini localhost routes to `~/.goldflow-studio/planning-routes.json`; normal Goldflow commands discover that process-owned registry without manual exports. New identities use planning-room v2: routine structured chunks share an eleven-slot weighted pool across Codex (eight) and authenticated Antigravity CLI (three), Gemini Web handles global/long-context reasoning, and ChatGPT Web handles premium creative work. Every route returns the same provider-neutral structured contract, while Codex remains the local reconciler and artifact authority.

High-value source development may still explicitly lock authenticated ChatGPT Web or Gemini Web when the stage route requires it. Routine schema-bound volume should not consume premium web planners serially when Codex or a benchmark-approved Antigravity route can produce the same contract.

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

Activate the resulting `work_manifest.json` in the dashboard. The worker receives no arbitrary local path. References are served through authenticated localhost URLs and rechecked against their source hashes. New fast-premium runs dispatch each asset once across Flow (five), Gemini (three), and idle ChatGPT image capacity (three); style references use Gemini first, and ChatGPT image slots remain planning-first. Downloaded stills are decoded by Sharp, normalized to PNG, validated as 16:9, and completed through `completeWorkItem`. Flow video jobs use the separate durable media ledger, exactly one first-frame reference, output-hash validation, and normalized silent 1920x1080 clips.

## Recovery Policy

- Every LLM request is keyed by its normalized request hash.
- Every image is keyed by the existing Goldflow manifest and asset ID.
- Every generated clip is keyed by the accepted first-frame hash, exact prompt, model, duration, and cut ID.
- A browser submission receives one creative attempt.
- A failure is recorded and never placed back on the queue automatically.
- An expired post-submission lease becomes `needs_triage`.
- Requeue requires an explicit operator reason from the dashboard API.
- A rate limit, usage limit, account mismatch, or ChatGPT UI-contract mismatch pauses all dispatch.

## Tests

```bash
node apps/goldflow-studio/tests/run-tests.mjs
```

The suites cover durable queue semantics, localhost auth and pairing, the federated planner adapter, exact image completion, three-provider dispatch limits, desktop-host security boundaries, and extension fallback permissions.
