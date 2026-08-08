import path from "node:path";

import { nowIso, randomToken, readJson, sha256, writeJsonAtomic } from "./util.mjs";

export class WorkerRegistry {
  constructor({ stateDir } = {}) {
    this.statePath = path.join(path.resolve(stateDir), "workers.json");
  }

  async init() {
    const state = await readJson(this.statePath);
    if (!state) await writeJsonAtomic(this.statePath, { schema: "goldflow_studio_workers_v1", workers: [] });
    return this;
  }

  async state() {
    return readJson(this.statePath, { schema: "goldflow_studio_workers_v1", workers: [] });
  }

  async pair(label = "Chrome worker") {
    const state = await this.state();
    const workerId = `worker-${randomToken(9)}`;
    const token = randomToken(32);
    const worker = {
      worker_id: workerId,
      label: String(label ?? "Chrome worker").trim().slice(0, 80) || "Chrome worker",
      token_sha256: sha256(token),
      status: "paired",
      paired_at: nowIso(),
      last_seen_at: nowIso(),
    };
    state.workers.push(worker);
    await writeJsonAtomic(this.statePath, { ...state, updated_at: nowIso() });
    return { worker: this.publicWorker(worker), token };
  }

  publicWorker(worker) {
    const { token_sha256: _token, ...publicFields } = worker;
    return publicFields;
  }

  async authenticate(token) {
    const tokenSha = sha256(String(token ?? ""));
    const state = await this.state();
    const index = state.workers.findIndex((worker) => worker.token_sha256 === tokenSha);
    if (index < 0) return null;
    state.workers[index] = { ...state.workers[index], status: "online", last_seen_at: nowIso() };
    await writeJsonAtomic(this.statePath, { ...state, updated_at: nowIso() });
    return this.publicWorker(state.workers[index]);
  }

  async list() {
    const state = await this.state();
    return state.workers.map((worker) => this.publicWorker(worker));
  }
}
