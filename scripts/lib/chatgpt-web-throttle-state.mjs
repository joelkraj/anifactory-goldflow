import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const runtimeRoot = process.env.GOLDFLOW_CHATGPT_WEB_RUNTIME_ROOT
  || path.join(process.env.HOME || "/Users/joel", ".codex-chatgpt-web", "runtime");

export const CHATGPT_WEB_THROTTLE_STATE_PATH = process.env.GOLDFLOW_CHATGPT_WEB_THROTTLE_STATE_PATH
  || path.join(runtimeRoot, "goldflow-browser-throttle.json");
export const CHATGPT_WEB_MAINTENANCE_LOCK_PATH = process.env.GOLDFLOW_CHATGPT_WEB_MAINTENANCE_LOCK_PATH
  || path.join(runtimeRoot, "goldflow-browser-maintenance-lock");
export const CHATGPT_WEB_THROTTLE_COOLDOWN_MS = Math.max(
  60_000,
  Number(process.env.GOLDFLOW_CHATGPT_WEB_THROTTLE_COOLDOWN_MS ?? 900_000) || 900_000,
);

export function isChatGptWebRateLimitError(value) {
  return /too many requests|requests? (?:are )?being made too quickly|chatgpt rate limit/i.test(String(value ?? ""));
}

export function chatGptWebCooldownRemainingMs(state, nowMs = Date.now()) {
  const untilMs = Date.parse(String(state?.cooldown_until ?? ""));
  return Number.isFinite(untilMs) ? Math.max(0, untilMs - nowMs) : 0;
}

async function readState() {
  return fs.readFile(CHATGPT_WEB_THROTTLE_STATE_PATH, "utf8").then(JSON.parse).catch(() => null);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function chatGptWebMaintenanceActive() {
  const stat = await fs.stat(CHATGPT_WEB_MAINTENANCE_LOCK_PATH).catch(() => null);
  if (!stat) return false;
  const lease = await fs.readFile(path.join(CHATGPT_WEB_MAINTENANCE_LOCK_PATH, "lease.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (processIsAlive(Number(lease?.pid))) return true;
  if (lease?.pid || Date.now() - stat.mtimeMs > 60_000) {
    await fs.rm(CHATGPT_WEB_MAINTENANCE_LOCK_PATH, { recursive: true, force: true }).catch(() => {});
    return false;
  }
  return true;
}

async function atomicWriteState(state) {
  await fs.mkdir(path.dirname(CHATGPT_WEB_THROTTLE_STATE_PATH), { recursive: true });
  const temporaryPath = `${CHATGPT_WEB_THROTTLE_STATE_PATH}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, CHATGPT_WEB_THROTTLE_STATE_PATH);
}

export async function recordChatGptWebCooldown({
  lane,
  workId,
  reason,
  cooldownMs = CHATGPT_WEB_THROTTLE_COOLDOWN_MS,
}) {
  const nowMs = Date.now();
  const previous = await readState();
  const previousUntilMs = Date.parse(String(previous?.cooldown_until ?? ""));
  const cooldownUntilMs = Math.max(
    Number.isFinite(previousUntilMs) ? previousUntilMs : 0,
    nowMs + Math.max(60_000, Number(cooldownMs) || CHATGPT_WEB_THROTTLE_COOLDOWN_MS),
  );
  const state = {
    schema: "goldflow_chatgpt_web_throttle_state_v1",
    lane: String(lane ?? "unknown"),
    work_id: String(workId ?? "unknown"),
    triggered_at: new Date(nowMs).toISOString(),
    cooldown_until: new Date(cooldownUntilMs).toISOString(),
    error: String(reason ?? "ChatGPT Web cooldown requested").slice(0, 1_000),
  };
  await atomicWriteState(state);
  return state;
}

export async function assertChatGptWebCooldownClear({
  operation = "browser request",
  allowMaintenance = false,
} = {}) {
  if (!allowMaintenance && await chatGptWebMaintenanceActive()) {
    throw new Error(`ChatGPT Web maintenance is active before ${operation}`);
  }
  const state = await readState();
  const remainingMs = chatGptWebCooldownRemainingMs(state);
  if (!remainingMs) return state;
  throw new Error(
    `ChatGPT Web cooldown active for ${Math.ceil(remainingMs / 1000)} more seconds before ${operation}`,
  );
}

export async function recordChatGptWebRateLimit({ lane, workId, error, cooldownMs = CHATGPT_WEB_THROTTLE_COOLDOWN_MS }) {
  if (!isChatGptWebRateLimitError(error)) return null;
  return recordChatGptWebCooldown({
    lane,
    workId,
    reason: error instanceof Error ? error.message : error,
    cooldownMs,
  });
}
