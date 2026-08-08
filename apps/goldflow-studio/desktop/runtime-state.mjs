import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writePrivateJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

export class DesktopRuntimeState {
  constructor({ stateDir } = {}) {
    this.credentialsPath = path.join(stateDir, "desktop-worker-credentials.json");
    this.runtimePath = path.join(stateDir, "desktop-worker-runtime.json");
  }

  credentials() {
    return readJson(this.credentialsPath, null);
  }

  saveCredentials(value) {
    return writePrivateJson(this.credentialsPath, { schema: "goldflow_desktop_worker_credentials_v1", ...value });
  }

  runtime() {
    return readJson(this.runtimePath, { schema: "goldflow_desktop_worker_runtime_v1", active_jobs: [], events: [] });
  }

  saveRuntime(value) {
    return writePrivateJson(this.runtimePath, { schema: "goldflow_desktop_worker_runtime_v1", ...value });
  }
}
