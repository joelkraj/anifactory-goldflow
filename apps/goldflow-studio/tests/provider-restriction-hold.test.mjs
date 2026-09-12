import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStudioServer, providerFailurePausesDispatch } from "../server.mjs";
import { GoldflowDesktopHost } from "../desktop/worker-host.mjs";
import { GoldflowWorkerClient } from "../desktop/worker-client.mjs";
import { desktopConfig } from "../desktop/config.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-provider-hold-test-"));
let studio;
try {
  studio = await createStudioServer({
    port: 0, browserProvider: "google-flow", repoRoot: path.resolve("."),
    stateDir: path.join(temp, "server"), dataRoot: path.join(temp, "data"),
    downloadsRoot: path.join(temp, "downloads"),
    adminToken: "fixture-admin", pairingCode: "123456",
  });
  const client = new GoldflowWorkerClient({ serverUrl: studio.url });
  await client.pair("123456", "fixture-worker", "google-flow");
  // Exercise the real authenticated failure/pause/lease routes, with no image
  // queue, browser or provider behind them.
  studio.bridge.failImage = async () => ({ status: "recorded_fixture_failure" });
  let leased = 0;
  studio.bridge.leaseImage = async () => {
    leased += 1;
    return { status: "leased", job: { type: "image", job_id: `fixture-${leased}` } };
  };
  const host = new GoldflowDesktopHost({
    config: desktopConfig({
      provider: "google-flow", "server-url": studio.url, concurrency: "1", types: "image",
      "state-dir": path.join(temp, "worker"), "google-submit-gate-dir": path.join(temp, "gate"),
    }, {}),
    browser: {}, log: () => {},
  });
  host.client = client;
  host.googleSubmitGate = { circuitDelayMs: async () => 0 };
  host.running = true;
  host.persistRuntime = async () => {};
  host.schedule = () => {};
  let dispatched = 0;
  host.runSlot = async (slot, lease) => {
    dispatched += 1;
    host.activeJobs.set(slot, { job: lease.job });
  };
  const resume = () => new GoldflowWorkerClient({ serverUrl: studio.url, workerToken: studio.adminToken })
    .request("/v1/dashboard/pause", { method: "POST", body: { paused: false, reason: "Explicit fixture operator resume" } });
  const reset = () => {
    host.activeJobs.clear(); host.nextLeaseAt = 0; host.submissionBurstCount = 0;
    host.providerRecoveryProbe = false; host.voluntaryBurstCooldownUntil = 0;
  };
  for (const code of ["usage_limited", "auth_required", "account_mismatch", "ui_contract_mismatch"]) {
    assert.equal(providerFailurePausesDispatch(code), true);
    reset();
    await client.fail({ type: "image", manifest_id: "fixture", asset_id: "fixture", lease_token: "fixture" }, 0, { code, message: "Fixture provider restriction" });
    assert.equal((await client.health()).paused, true);
    host.providerCircuit = { status: "open", reason: code, opened_at: new Date(0).toISOString() };
    host.dispatchCooldownUntil = Date.now() - 1;
    const priorLeases = leased, priorDispatches = dispatched;
    await host.tick();
    await host.tick();
    assert.equal(leased, priorLeases, `${code}: elapsed local cooldown cannot reach the queued lease`);
    assert.equal(dispatched, priorDispatches, `${code}: no new image submission while server held`);
    assert.equal((await client.health()).paused, true);
    await resume();
    await host.tick();
    assert.equal(leased, priorLeases + 1, "only explicit authenticated resume releases the hold");
  }
  for (const code of ["rate_limited", "provider_transient_circuit_open"]) {
    assert.equal(providerFailurePausesDispatch(code), false);
    reset();
    await client.fail({ type: "image", manifest_id: "fixture", asset_id: "fixture", lease_token: "fixture" }, 0, { code, message: "Fixture transient failure" });
    assert.equal((await client.health()).paused, false);
    host.providerCircuit = code === "provider_transient_circuit_open"
      ? { status: "open", reason: "consecutive_transient_provider_failures", opened_at: new Date(0).toISOString() }
      : null;
    host.dispatchCooldownUntil = Date.now() + 60_000;
    const priorLeases = leased;
    await host.tick();
    assert.equal(leased, priorLeases, "ordinary cooldown still prevents early leases");
    host.dispatchCooldownUntil = Date.now() - 1;
    await host.tick();
    assert.equal(leased, priorLeases + 1, "ordinary transient cooldown still permits its existing recovery policy");
  }
  host.running = false;
  console.log("provider-restriction-hold.test: PASS");
} finally {
  if (studio) await studio.close();
  await fs.rm(temp, { recursive: true, force: true });
}
