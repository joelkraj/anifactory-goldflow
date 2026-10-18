import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, randomInt } from "node:crypto";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gateError = (message, code = "google_submit_gate_paused") => Object.assign(new Error(message), { code });

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  await fs.rename(temporary, file);
}

// One shared directory per Google account, independent of provider and worker tab.
// A crashed lock fails closed for manual inspection; it never authorizes a re-click.
export class GoogleSubmitGate {
  constructor({ directory, intervalMs = 30_000, jitterMaxMs = 0, pollMs = 250, sampleJitter = randomInt } = {}) {
    if (!Number.isInteger(jitterMaxMs) || jitterMaxMs < 0 || jitterMaxMs > 5_000) throw new Error("Google submit jitter must be an integer from zero through 5000 milliseconds.");
    this.directory = directory;
    this.intervalMs = intervalMs;
    this.jitterMaxMs = jitterMaxMs;
    this.sampleJitter = sampleJitter;
    this.pollMs = pollMs;
    this.lockPath = path.join(directory, "submit.lock");
    this.statePath = path.join(directory, "submit-state.json");
  }

  async acquire(assertReady) {
    await fs.mkdir(this.directory, { recursive: true });
    while (true) {
      await assertReady();
      let handle;
      try { handle = await fs.open(this.lockPath, "wx", 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        let owner;
        try { owner = await readJson(this.lockPath, null); }
        catch (readError) { if (!(readError instanceof SyntaxError)) throw readError; }
        if (owner?.pid) {
          try { process.kill(owner.pid, 0); }
          catch (probe) { if (probe.code === "ESRCH") throw gateError("Interrupted Google submission lock: inspect submit.lock and its exact job before recovery.", "ui_contract_mismatch"); }
        } else {
          const stat = await fs.stat(this.lockPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
          if (stat && Date.now() - stat.mtimeMs > 5000) throw gateError("Incomplete Google submission lock; manual inspection required.", "ui_contract_mismatch");
        }
        await sleep(this.pollMs);
        continue;
      }
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })); }
      catch (error) { await handle.close(); await fs.unlink(this.lockPath); throw error; }
      await handle.close();
      return () => fs.unlink(this.lockPath);
    }
  }

  async pause({ provider, until, reason }) {
    if (!["google-flow", "google-gemini"].includes(provider)) throw new Error("Invalid Google gate provider.");
    await fs.mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, `${provider}-circuit.json`);
    const previous = await readJson(file, {});
    await atomicJson(file, { provider, reason, blocked_until: Math.max(until, previous.blocked_until ?? 0), recorded_at: new Date().toISOString() });
  }

  async circuitDelayMs() {
    let until = 0;
    for (const name of ["google-flow", "google-gemini"]) {
      const circuit = await readJson(path.join(this.directory, `${name}-circuit.json`), {});
      until = Math.max(until, circuit.blocked_until ?? 0);
    }
    return Math.max(0, until - Date.now());
  }

  async submit({ provider, jobId, click, assertReady = async () => {}, onWait = async () => {} }) {
    while (true) {
      const release = await this.acquire(assertReady);
      let waitMs = 0;
      try {
        const state = await readJson(this.statePath, {});
        for (const name of ["google-flow", "google-gemini"]) {
          const circuit = await readJson(path.join(this.directory, `${name}-circuit.json`), {});
          if (circuit.blocked_until > Date.now()) throw gateError(`Google account submission paused by ${name} until ${new Date(circuit.blocked_until).toISOString()}: ${circuit.reason}`);
        }
        const previousClickAt = Date.parse(state.click_finished_at ?? state.attempted_at ?? "");
        const currentMinimumAt = Number.isFinite(previousClickAt)
          ? previousClickAt + Math.max(this.intervalMs, state.interval_ms ?? 0) + (state.jitter_ms ?? 0)
          : 0;
        // A stricter replacement host must honor its minimum on the first click too.
        waitMs = Math.max(0, Math.max(state.next_submit_at ?? 0, currentMinimumAt) - Date.now());
        if (waitMs === 0) {
          await assertReady();
          const attemptedAt = Date.now();
          const interval = Math.max(this.intervalMs, state.interval_ms ?? 0);
          const jitterMax = Math.max(this.jitterMaxMs, state.jitter_max_ms ?? 0);
          const jitter = jitterMax > 0 ? this.sampleJitter(0, jitterMax + 1) : 0;
          if (!Number.isInteger(jitter) || jitter < 0 || jitter > jitterMax) throw new Error("Invalid Google submit jitter sample.");
          const spacing = interval + jitter;
          const receipt = { provider, job_id: jobId, pid: process.pid, interval_ms: interval, jitter_max_ms: jitterMax, jitter_ms: jitter, spacing_ms: spacing, attempted_at: new Date(attemptedAt).toISOString(), status: "attempting" };
          await atomicJson(this.statePath, { ...receipt, next_submit_at: attemptedAt + spacing });
          try {
            await click();
            receipt.status = "submitted";
          } catch (error) {
            receipt.status = "ambiguous_or_failed_click";
            receipt.error_code = error.code ?? error.name;
            throw error;
          } finally {
            const endedAt = Date.now();
            receipt.click_finished_at = new Date(endedAt).toISOString();
            // Space from completion, not pre-upload admission or click invocation.
            await atomicJson(this.statePath, { ...receipt, next_submit_at: endedAt + spacing });
            await fs.appendFile(path.join(this.directory, "submissions.jsonl"), JSON.stringify(receipt) + "\n", { mode: 0o600 });
          }
          return receipt;
        }
      } finally { await release(); }
      await onWait(waitMs);
      await sleep(Math.min(waitMs, this.pollMs));
    }
  }
}
