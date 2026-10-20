import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { applyFalContractOverlay, validateFalContract } from "../lib/fal-visual-restart.mjs";
import { FAL_ENDPOINTS, FAL_EPISODE_BUDGET, FAL_PRIMARY_PARAMS } from "../lib/fal-provider.mjs";
import { CHANNEL_PRESET_OPERATIONAL_FLAGS, validateChannelPreset } from "../lib/channel-preset.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
async function fixtureContract() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fal-contract-"));
  const bank = path.join(dir, "bank.json"), discovery = path.join(dir, "discovery.json");
  const bankBytes = JSON.stringify({ schema: "goldflow_fal_reference_bank_snapshot_v1", assets: [] }), discoveryBytes = JSON.stringify({ schema: "goldflow_fal_discovery_v1" });
  await fs.writeFile(bank, bankBytes); await fs.writeFile(discovery, discoveryBytes);
  return { ...contract(), reference_bank_manifest: bank, reference_bank_manifest_sha256: sha(bankBytes), discovery_receipt: discovery, discovery_receipt_sha256: sha(discoveryBytes) };
}
const contract = () => ({
  schema: "goldflow_fal_image_contract_v1", endpoints: { ...FAL_ENDPOINTS }, primary_params: structuredClone(FAL_PRIMARY_PARAMS),
  normal_reference_mode: "one_positional_collage", maximum_references: 16, automatic_creative_retry: false, automatic_failover: false,
  validation_concurrency: 8, production_concurrency: 20, warning_budget_usd: FAL_EPISODE_BUDGET.warning_usd, hard_budget_usd: FAL_EPISODE_BUDGET.hard_usd,
  reference_bank_manifest: "/tmp/bank.json", reference_bank_manifest_sha256: "a".repeat(64), discovery_receipt: "/tmp/discovery.json", discovery_receipt_sha256: "b".repeat(64),
});

test("a fresh preflight identity gets the same Fal binding the visual-restart fork writes", async () => {
  const valid = await validateFalContract(await fixtureContract());
  const identity = { image_provider: "fal_ai", provider_locks: { image_provider: "codex_imagegen", image_model: "x", planning_provider: "planning_room" }, model_versions: { image_model: "x" }, production_profile_config: { media: { default_image_provider: "codex_imagegen", image_concurrency: 4 } } };
  applyFalContractOverlay(identity, { contract: valid, createdAt: "2026-10-20T00:00:00.000Z", contractPath: "/x/fal_contract.json", contractSha256: "c".repeat(64) });
  assert.equal(identity.image_provider_options.fal.endpoints.primary_edit, FAL_ENDPOINTS.primary_edit);
  assert.equal(identity.image_provider_options.fal.contract_sha256, "c".repeat(64));
  assert.ok(identity.image_provider_options.fal.per_request_caps_usd, "per-request caps are locked at preflight");
  assert.equal(identity.provider_locks.reference_image_provider, "fal_ai");
  assert.equal(identity.provider_locks.image_model, FAL_ENDPOINTS.primary_edit);
  assert.equal(identity.provider_locks.image_automatic_retry_policy, "transport_only_no_billable_output");
  assert.equal(identity.provider_locks.planning_provider, "planning_room", "non-image locks are untouched");
  assert.equal(identity.model_versions.image_provider_models.fal_ai.reference_model, FAL_ENDPOINTS.primary_edit);
  assert.deepEqual(identity.production_profile_config.media, { default_image_provider: "fal_ai", image_concurrency: 20, reference_concurrency: 8 });
  assert.equal(identity.image_output_qa_required, true);
});

test("the channel preset may carry fal-contract as an operational flag", () => {
  assert.ok(CHANNEL_PRESET_OPERATIONAL_FLAGS.includes("fal-contract"));
  const preset = { schema: "goldflow_channel_preset_v1", channel: "c", version: "1", authored_by: "joel", flags: { "image-provider": "fal_ai", "fal-contract": "/data/fal_discovery/x/fal_contract.json", "autopilot": true, "episode-budget-usd": 10 } };
  assert.deepEqual(validateChannelPreset(preset), { done: true, blockers: [] });
});
