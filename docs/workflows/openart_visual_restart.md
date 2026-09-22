# OpenArt visual production and shared reference bank

This explicit route supports an operator-authorized visual restart of an already
approved `manhwa_recap_v1` / `generated_visuals_v1` production. It does not change
the default provider or migrate an existing identity. Read the manhwa and
generated-visuals guides first.

## Identity and carryforward

`goldflow run restart-visuals --baseline-episode-dir <original> --week <new-run>
--openart-contract <contract.json> --approved-by <operator> --note <authorization>`
requires a clean committed checkout and a new sibling run. It verifies the old
run's gates, copies only an explicit allowlist of approved script, semantic,
voice, narration, timing, mix, and beat artifacts, and records original provenance
without re-synthesis or re-approval. Historical image files, visual approvals,
prompt plans, render results, and execution ledgers are never accepted into the
new run. The original attempt remains intact. Approved packaging is preserved
only when it exists and its contract supports carryforward; an absent package
does not become approved. Publishing retains separate approval requirements.

The new provider token is `openart_cli`; its transport is explicitly either
`openart_cli_v1` or `openart_studio_browser`. This token does not claim a CLI
discount for browser work. The contract locks the exact primary model, repair
models, live discovery evidence, global bank directory, references, concurrency,
and credit ceilings. This production route requires **Low, 1K, 16:9**. It never
raises quality automatically. Follow `run status` after each completed stage.

## CLI capability boundary

Discover exact model IDs and forms with the installed OpenArt CLI before spend.
CLI v0.1.1 lists model forms but its generation command does not expose their
quality, aspect-ratio, or resolution fields. The adapter fails closed when its
dry-run payload cannot reproduce the requested configuration. Default cost
quotes are not configured-price proof. A blocked MCP transport is not retried
through alternate identities or headers. Use an explicitly locked Studio route
when authorized and retain its actual displayed quote. Do not infer the 10%
CLI/MCP discount from a Pro subscription.

## Global assets and native Studio library

The local machine-readable manifest is authoritative. Stable asset IDs survive
episodes; each new raster receives an immutable version record, file hash,
provider receipt, generation prompt/settings/references, cost, timestamp,
relationships, tags, and supersession history. Approval changes are appended as
review receipts and manifest snapshots. Prior versions are never removed.

Characters and their named wardrobe/age states share a parent identity. The
universal protagonist is a reusable identity independent of episode clothing.
Character refs are one empty-handed person, one neutral pose, plain background,
landscape three-quarter/full body. Environments are empty location plates;
props are isolated. Canonical rasters must originate from GPT Image 2.5 Sunburst,
not historical provider images or repair models.

Each record maps both its generated OpenArt media ID and its native Studio
library ID. Register characters/wardrobes under Characters, location plates
under Backgrounds, props under Objects, and actual styles under Styles. Native
Worlds are separate derived 3D assets: record their source plate IDs, separate
cost/model/operation, local export if available, and the parent location. Do not
confuse a 3D World ID with a generated canonical background ID or budget every
location as a 3D conversion. Reuse the appropriate native asset in Studio and
verify which source image it attaches.

## Gated sequence

1. `visual openart-bank --action plan --catalog <authored.json>` validates the
   source-bound catalog; `--action approve-plan` records a concrete review.
2. The reference-generation phase admits universal Joey alone. Generate,
   inspect, approve, and register his native Character before dependent states.
3. Generate and inspect the core cast, Grand environment, dollar, and watch.
4. Generate the eight authored validation images, then inspect actual identity,
   hands, props, roulette geometry, composition, and unwanted text. A valid JSON
   file is not visual acceptance. Only the passed set unlocks remaining refs.
5. Finish the bank and native library mappings; `--action approve-refs` binds the
   complete reviewed bank. `--action bind-shots` consumes authored migration
   choices and preserves approved beats/timing; `--action harden` validates them.
6. Restart scene production at its first stable frame ID. The regular focal,
   output QA, motion, render, and final QA gates remain afterward.

The normal ordered reference selection is primary character/current state,
environment, then second character or decisive prop. The author records a reason
for additional references, and dispatch must inspect their current quote. Code
resolves exact bank versions and hashes; it does not invent story composition.

## Browser dispatch receipts

`imagegen openart --action prepare` admits exact IDs and writes immutable
assignments without spending. Use `--references-only true --scope canonical` or
`--scope validation` during bank production. Native scene generation uses
`--image-ids <ids>`. No unscoped whole-stage retry is permitted.

Before one Generate click, `--action mark-submitted --assignment <file>
--ui-receipt <file>` verifies actual prompt hash, model, Low/1K/16:9, ordered
reference IDs/hashes, one output, current displayed cost and balance, and budget.
It reserves one submission. Do not click Generate a second time after uncertainty;
inspect history and recover its existing ID. `--action import` binds the downloaded
raster, OpenArt creation/media IDs, timestamp, cost evidence, and native geometry
to that submission. `--action review` and `--action sync-library` add visual and
native-library receipts. Every command retains append-only events.

If later inspection proves that a native-library receipt captured an account or
URL path identifier instead of the asset's native record ID, correct the same
hash-bound canonical version with `supersedes_openart_library_asset_id` and a
concrete `correction_reason`. Goldflow preserves the prior receipt and ID in
`library_sync_history`; ordinary replacement IDs still require a new canonical
version.

Failures require `--action fail` with evidence followed by a separately reviewed
exact-ID triage. Nano Banana 2 and Seedream 5 Pro may be used only for an explicitly
identified noncanonical failure that the primary model could not resolve. No
automatic fallback, global retry, quality increase, donor-copy, or silent source
replacement is allowed.
