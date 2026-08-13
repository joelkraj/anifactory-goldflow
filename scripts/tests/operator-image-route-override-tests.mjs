#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { effectiveImageIdentityForEpisode } from "../lib/operator-image-route-override.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-image-route-override-"));
const identityPath = path.join(root, "run_identity.json");
const identity = { episode: "ep_01", image_provider: "chatgpt_web_gpt_image", provider_locks: {}, model_versions: {} };
await fs.writeFile(identityPath, `${JSON.stringify(identity)}\n`);
const identitySha256 = createHash("sha256").update(await fs.readFile(identityPath)).digest("hex");
const proofPath = path.resolve("docs/proofs/google_flow_speed_pool_v1.json");
const proofSha256 = createHash("sha256").update(await fs.readFile(proofPath)).digest("hex");
await fs.writeFile(path.join(root, "operator_image_route_override_ep_01.json"), `${JSON.stringify({
  schema: "goldflow_operator_image_route_override_v1",
  status: "approved",
  episode: "ep_01",
  run_identity_sha256: identitySha256,
  from_image_provider: "chatgpt_web_gpt_image",
  to_image_provider: "hybrid_chatgpt_web_style_google_flow_pool",
  chatgpt_project_url: "https://chatgpt.com/g/g-p-test/project",
  style_reference_provider: "chatgpt_web_gpt_image",
  google_flow_plan: "PLUS",
  google_flow_model: "Nano Banana Pro",
  google_flow_health_proof_path: proofPath,
  google_flow_health_proof_sha256: proofSha256,
  preserve_existing_accepted_assets: true,
  one_creative_submission_per_asset: true,
  automatic_provider_failover: "none",
})}\n`);
const effective = await effectiveImageIdentityForEpisode(root, identityPath, identity);
assert.equal(effective.status.done, true);
assert.equal(effective.identity.image_provider, "hybrid_chatgpt_web_style_google_flow_pool");
assert.equal(effective.identity.provider_locks.chatgpt_web_image_concurrency, 3);
assert.equal(effective.identity.provider_locks.google_flow_image_concurrency, 5);
assert.equal(effective.identity.provider_locks.image_automatic_retry_policy, "none");
assert.equal(effective.identity.operator_image_route_override.preserve_existing_accepted_assets, true);
console.log("operator image route override tests passed");
