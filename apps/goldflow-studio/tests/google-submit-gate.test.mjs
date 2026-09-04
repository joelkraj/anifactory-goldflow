import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { GoogleSubmitGate } from "../desktop/google-submit-gate.mjs";
import { browserFailureDisposition, GoldflowDesktopHost } from "../desktop/worker-host.mjs";
import { desktopConfig } from "../desktop/config.mjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "google-submit-gate-"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const gate = new GoogleSubmitGate({ directory, intervalMs: 60, pollMs: 5 });
  let clicks = 0;
  await gate.submit({ provider: "google-flow", jobId: "slow-click", click: async () => { await pause(60); clicks += 1; } });
  const first = JSON.parse(await fs.readFile(gate.statePath, "utf8"));
  const moduleUrl = new URL("../desktop/google-submit-gate.mjs", import.meta.url).href;
  const code = `import { GoogleSubmitGate } from ${JSON.stringify(moduleUrl)};
    await new GoogleSubmitGate({ directory: ${JSON.stringify(directory)}, intervalMs: 60, pollMs: 5 })
      .submit({provider: "google-gemini", jobId: "other-process", click: async () => {}});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" });
  assert.equal(await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }), 0);
  const second = JSON.parse(await fs.readFile(gate.statePath, "utf8"));
  assert.ok(Date.parse(second.attempted_at) - Date.parse(first.click_finished_at) >= 60, "independent processes and providers share post-click spacing");
  await Promise.all(["flow", "gemini", "flow2"].map((id) => new GoogleSubmitGate({ directory, intervalMs: 60, pollMs: 5 }).submit({
    provider: id === "gemini" ? "google-gemini" : "google-flow", jobId: id, click: async () => { clicks += 1; await pause(15); },
  })));
  const rows = (await fs.readFile(path.join(directory, "submissions.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 5);
  for (let i = 1; i < rows.length; i += 1) assert.ok(Date.parse(rows[i].attempted_at) - Date.parse(rows[i - 1].click_finished_at) >= 60);
  await assert.rejects(() => gate.submit({ provider: "google-flow", jobId: "ambiguous", click: async () => { clicks += 1; throw new Error("uncertain click"); } }), /uncertain click/);
  assert.equal(clicks, 5, "failed clicks are not retried");
  assert.equal(JSON.parse(await fs.readFile(gate.statePath, "utf8")).status, "ambiguous_or_failed_click");
  await gate.pause({ provider: "google-flow", until: Date.now() + 5000, reason: "rate_limit" });
  await assert.rejects(() => gate.submit({ provider: "google-gemini", jobId: "blocked", click: async () => { clicks += 1; } }), /submission paused/);
  assert.equal(clicks, 5);
  assert.ok(await gate.circuitDelayMs() > 0);
  const host = new GoldflowDesktopHost({ config: desktopConfig({ provider: "google-gemini", "state-dir": directory, "google-submit-gate-dir": directory }, {}), browser: {}, log: () => {} });
  host.running = true;
  host.schedule = () => {};
  host.client.lease = async () => assert.fail("a shared circuit must block new leases too");
  await host.tick();
  assert.equal(browserFailureDisposition(Object.assign(new Error("rate_limit from other host"), { code: "google_submit_gate_paused" })).kind, "submission_hold", "a waiting asset must not extend the account cooldown");
  await assert.rejects(() => gate.submit({ provider: "google-flow", jobId: "stopped", assertReady: async () => { throw new Error("draining"); }, click: async () => { clicks += 1; } }), /draining/);
  await fs.writeFile(gate.lockPath, JSON.stringify({ pid: 2147483647 }));
  await assert.rejects(() => gate.submit({ provider: "google-flow", jobId: "crashed", click: async () => {} }), /Interrupted Google submission lock/);
  assert.equal(clicks, 5);
  console.log("Google account submit gate tests passed (spacing, cross-process, restart persistence, circuits, drain, ambiguous click, stale lock).");
} finally { await fs.rm(directory, { recursive: true, force: true }); }
