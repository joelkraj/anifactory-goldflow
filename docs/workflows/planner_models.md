# Planner Model Defaults

Default planner models for **new** runs live in [`config/planner-models.json`](../../config/planner-models.json), read by `scripts/lib/model-defaults.mjs`. Existing run identities keep the model recorded in `run_identity.json`; this file never migrates them.

## When a new model ships

1. Edit `providers.<provider>.model` in `config/planner-models.json` (`codex_cli` or `claude_cli`).
2. For Codex, add a `minimum_cli_by_model` row only if the model needs a newer Codex CLI. An unlisted model has no minimum, so a missing row skips the early version check but does not block the run.
3. Update the one test assertion that names the old default (`scripts/goldflow-fixture-tests.mjs`, `testPinnedCodexRuntimeContracts`).
4. Run `npm run test:planner-models`.

No other code changes are needed for new runs.

## Aliases

`--planning-model latest` (also `default`, `current`) and `ANIFACTORY_CODEX_MODEL=latest` / `ANIFACTORY_CLAUDE_MODEL=latest` resolve to the configured default at preflight. The identity records the concrete model, never the alias.

## Selecting a provider

`--planning-provider codex_cli` or `--planning-provider claude_cli` creates a single-provider identity. `claude_cli` runs Claude Code headless (`claude -p`) behind the shared runner, so it gets the same `.meta.json` receipts, cache rules and provider lock. It is in no default planning-room route; an identity opts into it through `planning_room.stage_routes` or `claude_cli_structured_concurrency`.

## Not covered here

ChatGPT Web planning stays pinned (its model is matched against the browser picker label), as do the source-development model policies and any historical identity.
