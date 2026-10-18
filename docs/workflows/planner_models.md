# Planner Model Defaults

Default planner models for **new** runs live in [`config/planner-models.json`](../../config/planner-models.json), read by `scripts/lib/model-defaults.mjs`. Existing run identities keep the model recorded in `run_identity.json`; this file never migrates them.

## When a new model ships

1. Edit `providers.<provider>.model` in `config/planner-models.json` (`codex_cli` or `claude_cli`).
2. For Codex, add a `minimum_cli_by_model` row only if the model needs a newer Codex CLI. An unlisted model has no minimum, so a missing row skips the early version check but does not block the run.
3. Update the one test assertion that names the old default (`scripts/goldflow-fixture-tests.mjs`, `testPinnedCodexRuntimeContracts`).
4. Run `npm run test:planner-models`.

The per-provider `reasoning_effort` is used for new single-provider identities and standalone calls. Explicit flags win over the corresponding `ANIFACTORY_CODEX_*` or `ANIFACTORY_CLAUDE_*` model/effort environment setting, which wins over this config. Existing identity locks still win at execution.

## Aliases

`--planning-model latest` (also `default`, `current`) and `ANIFACTORY_CODEX_MODEL=latest` / `ANIFACTORY_CLAUDE_MODEL=latest` resolve to the configured default at preflight. The identity records the concrete model, never the alias.

## Selecting a provider

`--planning-provider codex_cli` or `--planning-provider claude_cli` creates a single-provider identity. `claude_cli` runs Claude Code headless (`claude -p`) behind the shared runner, so it gets the same `.meta.json` receipts, cache rules and provider lock. Built-in and MCP tools are disabled explicitly; malformed JSON envelopes fail without retry. It is in no default planning-room route. A room must explicitly include it in the relevant `planning_room.stage_routes`; structured-pool dispatch additionally requires positive `claude_cli_structured_concurrency`. Capacity alone does not authorize a route.

## Version evidence

The [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) distinguishes built-in tools from MCP tools, so the runner disables both and supplies an empty strict MCP config. It also disables slash commands and [user/project/plugin hooks](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks) for this call; administrator-managed policy still applies. Authentication is retained. These controls do not authorize any additional provider call.

The official [Codex changelog](https://learn.chatgpt.com/docs/changelog) records that CLI 0.159.1 added GPT-6.1 Sol to the bundled catalog on September 29, 2026. This is Goldflow's supported catalog floor, not proof that every earlier CLI rejects an explicit model ID. Unknown models retain the existing no-minimum behavior. `MINIMUM_GPT56_CODEX_CLI` is retained as a compatibility export derived from the table; it no longer controls every model's gate.

## Not covered here

ChatGPT Web planning stays at the integration line's existing `gpt-6-sol` pin (matched against the browser picker label), as do the source-development model policies and any historical identity. This change does not promote GPT-6.1 Sol into that browser adapter.
