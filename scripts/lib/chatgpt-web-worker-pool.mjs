import { promises as fs } from "node:fs";
import path from "node:path";

function boundedWorkerLimit(value, fallback) {
  const configured = Number(value ?? fallback);
  return Number.isInteger(configured)
    ? Math.max(1, Math.min(20, configured))
    : fallback;
}

export const CHATGPT_WEB_TEXT_WORKER_LIMIT = boundedWorkerLimit(
  process.env.GOLDFLOW_CHATGPT_WEB_TEXT_WORKER_LIMIT,
  10,
);
export const CHATGPT_WEB_IMAGE_WORKER_LIMIT = boundedWorkerLimit(
  process.env.GOLDFLOW_CHATGPT_WEB_IMAGE_WORKER_LIMIT,
  3,
);
export const CHATGPT_WEB_DEEP_TEXT_WORKER_LIMIT = boundedWorkerLimit(
  process.env.GOLDFLOW_CHATGPT_WEB_DEEP_TEXT_WORKER_LIMIT,
  3,
);
export const CHATGPT_WEB_BROWSER_WORKER_LIMIT = boundedWorkerLimit(
  process.env.GOLDFLOW_CHATGPT_BROWSER_TAB_LIMIT,
  10,
);

const leaseRoot = process.env.GOLDFLOW_CHATGPT_WEB_LEASE_DIR
  || path.join(process.env.HOME || "/Users/joel", ".codex-chatgpt-web", "runtime", "goldflow-worker-leases");
export const CHATGPT_WEB_GLOBAL_START_INTERVAL_MS = Math.max(
  0,
  Number(process.env.GOLDFLOW_CHATGPT_WEB_START_INTERVAL_MS ?? 1_250) || 0,
);
export const CHATGPT_WEB_TEXT_START_INTERVAL_MS = Math.max(
  0,
  Number(process.env.GOLDFLOW_CHATGPT_WEB_TEXT_START_INTERVAL_MS ?? CHATGPT_WEB_GLOBAL_START_INTERVAL_MS) || 0,
);
export const CHATGPT_WEB_IMAGE_START_INTERVAL_MS = Math.max(
  0,
  Number(process.env.GOLDFLOW_CHATGPT_WEB_IMAGE_START_INTERVAL_MS ?? 45_000) || 0,
);
export const CHATGPT_WEB_REASONING_STARTS_PER_WINDOW = boundedWorkerLimit(
  process.env.GOLDFLOW_CHATGPT_WEB_REASONING_STARTS_PER_WINDOW,
  2,
);
export const CHATGPT_WEB_REASONING_WINDOW_MS = Math.max(
  10_000,
  Number(process.env.GOLDFLOW_CHATGPT_WEB_REASONING_WINDOW_MS ?? 900_000) || 900_000,
);
export const CHATGPT_WEB_AUDIENCE_STARTS_PER_WINDOW = boundedWorkerLimit(
  process.env.GOLDFLOW_CHATGPT_WEB_AUDIENCE_STARTS_PER_WINDOW,
  5,
);
export const CHATGPT_WEB_AUDIENCE_WINDOW_MS = Math.max(
  10_000,
  Number(process.env.GOLDFLOW_CHATGPT_WEB_AUDIENCE_WINDOW_MS ?? 900_000) || 900_000,
);
export const CHATGPT_WEB_STAGGERED_AUDIENCE_STARTS_PER_WINDOW = boundedWorkerLimit(
  process.env.GOLDFLOW_CHATGPT_WEB_STAGGERED_AUDIENCE_STARTS_PER_WINDOW,
  3,
);
export const CHATGPT_WEB_STAGGERED_AUDIENCE_WINDOW_MS = Math.max(
  30_000,
  Number(process.env.GOLDFLOW_CHATGPT_WEB_STAGGERED_AUDIENCE_WINDOW_MS ?? 900_000) || 900_000,
);
export const CHATGPT_WEB_SOURCE_ROOM_STARTS_PER_WINDOW = boundedWorkerLimit(
  process.env.GOLDFLOW_CHATGPT_WEB_SOURCE_ROOM_STARTS_PER_WINDOW,
  3,
);
export const CHATGPT_WEB_SOURCE_ROOM_WINDOW_MS = Math.max(
  30_000,
  Number(process.env.GOLDFLOW_CHATGPT_WEB_SOURCE_ROOM_WINDOW_MS ?? 900_000) || 900_000,
);
export const CHATGPT_WEB_MEDIUM_REASONING_START_INTERVAL_MS = Math.max(
  0,
  Number(process.env.GOLDFLOW_CHATGPT_WEB_MEDIUM_REASONING_START_INTERVAL_MS ?? 45_000) || 0,
);
export const CHATGPT_WEB_MEDIUM_REASONING_STARTS_PER_WINDOW = boundedWorkerLimit(
  process.env.GOLDFLOW_CHATGPT_WEB_MEDIUM_REASONING_STARTS_PER_WINDOW,
  1,
);
export const CHATGPT_WEB_MEDIUM_REASONING_WINDOW_MS = Math.max(
  10_000,
  Number(process.env.GOLDFLOW_CHATGPT_WEB_MEDIUM_REASONING_WINDOW_MS ?? 360_000) || 360_000,
);
export const CHATGPT_WEB_IMAGE_STARTS_PER_WINDOW = boundedWorkerLimit(
  process.env.GOLDFLOW_CHATGPT_WEB_IMAGE_STARTS_PER_WINDOW,
  12,
);
export const CHATGPT_WEB_IMAGE_WINDOW_MS = Math.max(
  10_000,
  Number(process.env.GOLDFLOW_CHATGPT_WEB_IMAGE_WINDOW_MS ?? 300_000) || 300_000,
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function rollingWindowReadyMs(startedMsValues, nowMs, limit, windowMs) {
  const recentStarts = (Array.isArray(startedMsValues) ? startedMsValues : [])
    .map(Number)
    .filter((startedMs) => Number.isFinite(startedMs) && startedMs > nowMs - windowMs)
    .sort((left, right) => left - right);
  const readyMs = recentStarts.length >= limit
    ? recentStarts[recentStarts.length - limit] + windowMs
    : 0;
  return { recentStarts, readyMs };
}

export function rollingWindowReadyMsForTests(startedMsValues, nowMs, limit, windowMs) {
  return rollingWindowReadyMs(startedMsValues, nowMs, limit, windowMs);
}

export function chatGptWebWorkerPoolForKind(kind = "planner") {
  const normalized = String(kind ?? "planner").trim().toLowerCase();
  if (normalized === "browser" || normalized === "browser_host" || normalized === "browser-host") {
    return { id: "browser", limit: CHATGPT_WEB_BROWSER_WORKER_LIMIT };
  }
  if (normalized === "deep_text" || normalized === "deep-text") {
    return { id: "deep-text", limit: CHATGPT_WEB_DEEP_TEXT_WORKER_LIMIT };
  }
  const imagePool = normalized === "image" || normalized === "reference";
  return imagePool
    ? { id: "image", limit: CHATGPT_WEB_IMAGE_WORKER_LIMIT }
    : { id: "text", limit: CHATGPT_WEB_TEXT_WORKER_LIMIT };
}

async function reapDeadLease(slotPath, staleMs) {
  const leasePath = path.join(slotPath, "lease.json");
  const [lease, stat] = await Promise.all([
    fs.readFile(leasePath, "utf8").then(JSON.parse).catch(() => null),
    fs.stat(slotPath).catch(() => null),
  ]);
  const ageMs = stat ? Date.now() - stat.mtimeMs : Infinity;
  if ((lease?.pid && !processIsAlive(Number(lease.pid))) || ageMs > staleMs) {
    await fs.rm(slotPath, { recursive: true, force: true }).catch(() => {});
    return true;
  }
  return false;
}

export async function acquireChatGptWebWorkerLease({
  kind = "planner",
  workId = "goldflow",
  timeoutMs = 3_600_000,
  pollMs = 250,
  staleMs = 7_200_000,
} = {}) {
  await fs.mkdir(leaseRoot, { recursive: true });
  const pool = chatGptWebWorkerPoolForKind(kind);
  const poolRoot = path.join(leaseRoot, `${pool.id}-workers`);
  await fs.mkdir(poolRoot, { recursive: true });
  const waitStartedMs = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let slot = 1; slot <= pool.limit; slot += 1) {
      const slotPath = path.join(poolRoot, `slot-${slot}`);
      try {
        await fs.mkdir(slotPath);
        const lease = {
          schema: "goldflow_chatgpt_web_worker_lease_v2",
          pool: pool.id,
          pool_limit: pool.limit,
          slot,
          pid: process.pid,
          kind,
          work_id: String(workId),
          acquired_at: new Date().toISOString(),
          waited_ms: Date.now() - waitStartedMs,
        };
        await fs.writeFile(path.join(slotPath, "lease.json"), `${JSON.stringify(lease, null, 2)}\n`, "utf8");
        let released = false;
        return {
          ...lease,
          path: slotPath,
          async release() {
            if (released) return;
            released = true;
            await fs.rm(slotPath, { recursive: true, force: true }).catch(() => {});
          },
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await reapDeadLease(slotPath, staleMs);
      }
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for one of ${pool.limit} ChatGPT Web ${pool.id} workers.`);
}

export async function waitForChatGptWebStartWindow({
  kind = "planner",
  workId = "goldflow",
  rateClass = "ordinary",
  minimumIntervalMs,
  timeoutMs = 120_000,
  pollMs = 50,
  staleGateMs = 30_000,
} = {}) {
  await fs.mkdir(leaseRoot, { recursive: true });
  const pool = chatGptWebWorkerPoolForKind(kind);
  const laneIntervalMs = Math.max(0, Number(minimumIntervalMs ?? (
    pool.id === "image" ? CHATGPT_WEB_IMAGE_START_INTERVAL_MS : CHATGPT_WEB_TEXT_START_INTERVAL_MS
  )) || 0);
  const gatePath = path.join(leaseRoot, "start-gate");
  const statePath = path.join(leaseRoot, "last-start.json");
  const mediumReasoningWindowApplies = pool.id === "text" && rateClass === "medium_reasoning";
  const laneStateSuffix = mediumReasoningWindowApplies ? "-medium-reasoning" : "";
  const laneStatePath = path.join(leaseRoot, `last-start-${pool.id}${laneStateSuffix}.json`);
  const reasoningStatePath = path.join(leaseRoot, "recent-starts-reasoning-text.json");
  const audienceStatePath = path.join(leaseRoot, "recent-starts-audience-text.json");
  const staggeredAudienceStatePath = path.join(leaseRoot, "recent-starts-audience-staggered-text.json");
  const sourceRoomStatePath = path.join(leaseRoot, "recent-starts-source-room-text.json");
  const mediumReasoningStatePath = path.join(leaseRoot, "recent-starts-medium-reasoning-text.json");
  const imageStatePath = path.join(leaseRoot, "recent-starts-image.json");
  const reasoningWindowApplies = pool.id === "text" && rateClass === "reasoning";
  const audienceWindowApplies = pool.id === "text" && rateClass === "audience_evaluation";
  const staggeredAudienceWindowApplies = pool.id === "text" && rateClass === "audience_staggered";
  const sourceRoomWindowApplies = pool.id === "text"
    && ["source_revision", "audience_staggered"].includes(rateClass);
  const imageWindowApplies = pool.id === "image";
  const waitStartedMs = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.mkdir(gatePath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fs.stat(gatePath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleGateMs) {
        await fs.rm(gatePath, { recursive: true, force: true }).catch(() => {});
      } else {
        await sleep(pollMs);
      }
      continue;
    }
    let retryAfterMs = 0;
    try {
      const [previousGlobal, previousLane, reasoningState, audienceState, staggeredAudienceState, sourceRoomState, mediumReasoningState, imageState] = await Promise.all([
        fs.readFile(statePath, "utf8").then(JSON.parse).catch(() => null),
        fs.readFile(laneStatePath, "utf8").then(JSON.parse).catch(() => null),
        reasoningWindowApplies
          ? fs.readFile(reasoningStatePath, "utf8").then(JSON.parse).catch(() => null)
          : null,
        audienceWindowApplies
          ? fs.readFile(audienceStatePath, "utf8").then(JSON.parse).catch(() => null)
          : null,
        staggeredAudienceWindowApplies
          ? fs.readFile(staggeredAudienceStatePath, "utf8").then(JSON.parse).catch(() => null)
          : null,
        sourceRoomWindowApplies
          ? fs.readFile(sourceRoomStatePath, "utf8").then(JSON.parse).catch(() => null)
          : null,
        mediumReasoningWindowApplies
          ? fs.readFile(mediumReasoningStatePath, "utf8").then(JSON.parse).catch(() => null)
          : null,
        imageWindowApplies
          ? fs.readFile(imageStatePath, "utf8").then(JSON.parse).catch(() => null)
          : null,
      ]);
      const nowMs = Date.now();
      const globalReadyMs = Number(previousGlobal?.started_ms ?? 0) + CHATGPT_WEB_GLOBAL_START_INTERVAL_MS;
      const laneReadyMs = Number(previousLane?.started_ms ?? 0) + laneIntervalMs;
      const reasoningWindow = reasoningWindowApplies
        ? rollingWindowReadyMs(
            reasoningState?.started_ms,
            nowMs,
            CHATGPT_WEB_REASONING_STARTS_PER_WINDOW,
            CHATGPT_WEB_REASONING_WINDOW_MS,
          )
        : { recentStarts: [], readyMs: 0 };
      const mediumReasoningWindow = mediumReasoningWindowApplies
        ? rollingWindowReadyMs(
            mediumReasoningState?.started_ms,
            nowMs,
            CHATGPT_WEB_MEDIUM_REASONING_STARTS_PER_WINDOW,
            CHATGPT_WEB_MEDIUM_REASONING_WINDOW_MS,
          )
        : { recentStarts: [], readyMs: 0 };
      const audienceWindow = audienceWindowApplies
        ? rollingWindowReadyMs(
            audienceState?.started_ms,
            nowMs,
            CHATGPT_WEB_AUDIENCE_STARTS_PER_WINDOW,
            CHATGPT_WEB_AUDIENCE_WINDOW_MS,
          )
        : { recentStarts: [], readyMs: 0 };
      const staggeredAudienceWindow = staggeredAudienceWindowApplies
        ? rollingWindowReadyMs(
            staggeredAudienceState?.started_ms,
            nowMs,
            CHATGPT_WEB_STAGGERED_AUDIENCE_STARTS_PER_WINDOW,
            CHATGPT_WEB_STAGGERED_AUDIENCE_WINDOW_MS,
          )
        : { recentStarts: [], readyMs: 0 };
      const sourceRoomWindow = sourceRoomWindowApplies
        ? rollingWindowReadyMs(
            sourceRoomState?.started_ms,
            nowMs,
            CHATGPT_WEB_SOURCE_ROOM_STARTS_PER_WINDOW,
            CHATGPT_WEB_SOURCE_ROOM_WINDOW_MS,
          )
        : { recentStarts: [], readyMs: 0 };
      const imageWindow = imageWindowApplies
        ? rollingWindowReadyMs(
            imageState?.started_ms,
            nowMs,
            CHATGPT_WEB_IMAGE_STARTS_PER_WINDOW,
            CHATGPT_WEB_IMAGE_WINDOW_MS,
          )
        : { recentStarts: [], readyMs: 0 };
      const waitMs = Math.max(0, Math.max(
        globalReadyMs,
        laneReadyMs,
        reasoningWindow.readyMs,
        audienceWindow.readyMs,
        staggeredAudienceWindow.readyMs,
        sourceRoomWindow.readyMs,
        mediumReasoningWindow.readyMs,
        imageWindow.readyMs,
      ) - nowMs);
      if (waitMs) {
        retryAfterMs = waitMs;
      } else {
        const startedMs = Date.now();
        const state = {
          schema: "goldflow_chatgpt_web_start_gate_v1",
          pid: process.pid,
          pool: pool.id,
          kind,
          work_id: String(workId),
          minimum_interval_ms: laneIntervalMs,
          lane_minimum_interval_ms: laneIntervalMs,
          global_minimum_interval_ms: CHATGPT_WEB_GLOBAL_START_INTERVAL_MS,
          rate_class: rateClass,
          reasoning_window_limit: reasoningWindowApplies ? CHATGPT_WEB_REASONING_STARTS_PER_WINDOW : null,
          reasoning_window_ms: reasoningWindowApplies ? CHATGPT_WEB_REASONING_WINDOW_MS : null,
          audience_window_limit: audienceWindowApplies ? CHATGPT_WEB_AUDIENCE_STARTS_PER_WINDOW : null,
          audience_window_ms: audienceWindowApplies ? CHATGPT_WEB_AUDIENCE_WINDOW_MS : null,
          staggered_audience_window_limit: staggeredAudienceWindowApplies ? CHATGPT_WEB_STAGGERED_AUDIENCE_STARTS_PER_WINDOW : null,
          staggered_audience_window_ms: staggeredAudienceWindowApplies ? CHATGPT_WEB_STAGGERED_AUDIENCE_WINDOW_MS : null,
          source_room_window_limit: sourceRoomWindowApplies ? CHATGPT_WEB_SOURCE_ROOM_STARTS_PER_WINDOW : null,
          source_room_window_ms: sourceRoomWindowApplies ? CHATGPT_WEB_SOURCE_ROOM_WINDOW_MS : null,
          medium_reasoning_window_limit: mediumReasoningWindowApplies ? CHATGPT_WEB_MEDIUM_REASONING_STARTS_PER_WINDOW : null,
          medium_reasoning_window_ms: mediumReasoningWindowApplies ? CHATGPT_WEB_MEDIUM_REASONING_WINDOW_MS : null,
          image_window_limit: imageWindowApplies ? CHATGPT_WEB_IMAGE_STARTS_PER_WINDOW : null,
          image_window_ms: imageWindowApplies ? CHATGPT_WEB_IMAGE_WINDOW_MS : null,
          waited_ms: startedMs - waitStartedMs,
          started_ms: startedMs,
          started_at: new Date(startedMs).toISOString(),
        };
        const writes = [
          fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8"),
          fs.writeFile(laneStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8"),
        ];
        if (reasoningWindowApplies) {
          writes.push(fs.writeFile(reasoningStatePath, `${JSON.stringify({
            schema: "goldflow_chatgpt_web_reasoning_start_window_v1",
            limit: CHATGPT_WEB_REASONING_STARTS_PER_WINDOW,
            window_ms: CHATGPT_WEB_REASONING_WINDOW_MS,
            started_ms: [...reasoningWindow.recentStarts, startedMs],
            updated_at: new Date(startedMs).toISOString(),
          }, null, 2)}\n`, "utf8"));
        }
        if (audienceWindowApplies) {
          writes.push(fs.writeFile(audienceStatePath, `${JSON.stringify({
            schema: "goldflow_chatgpt_web_audience_start_window_v1",
            limit: CHATGPT_WEB_AUDIENCE_STARTS_PER_WINDOW,
            window_ms: CHATGPT_WEB_AUDIENCE_WINDOW_MS,
            started_ms: [...audienceWindow.recentStarts, startedMs],
            updated_at: new Date(startedMs).toISOString(),
          }, null, 2)}\n`, "utf8"));
        }
        if (staggeredAudienceWindowApplies) {
          writes.push(fs.writeFile(staggeredAudienceStatePath, `${JSON.stringify({
            schema: "goldflow_chatgpt_web_staggered_audience_start_window_v1",
            limit: CHATGPT_WEB_STAGGERED_AUDIENCE_STARTS_PER_WINDOW,
            window_ms: CHATGPT_WEB_STAGGERED_AUDIENCE_WINDOW_MS,
            started_ms: [...staggeredAudienceWindow.recentStarts, startedMs],
            updated_at: new Date(startedMs).toISOString(),
          }, null, 2)}\n`, "utf8"));
        }
        if (sourceRoomWindowApplies) {
          writes.push(fs.writeFile(sourceRoomStatePath, `${JSON.stringify({
            schema: "goldflow_chatgpt_web_source_room_start_window_v1",
            limit: CHATGPT_WEB_SOURCE_ROOM_STARTS_PER_WINDOW,
            window_ms: CHATGPT_WEB_SOURCE_ROOM_WINDOW_MS,
            started_ms: [...sourceRoomWindow.recentStarts, startedMs],
            updated_at: new Date(startedMs).toISOString(),
          }, null, 2)}\n`, "utf8"));
        }
        if (mediumReasoningWindowApplies) {
          writes.push(fs.writeFile(mediumReasoningStatePath, `${JSON.stringify({
            schema: "goldflow_chatgpt_web_medium_reasoning_start_window_v1",
            limit: CHATGPT_WEB_MEDIUM_REASONING_STARTS_PER_WINDOW,
            window_ms: CHATGPT_WEB_MEDIUM_REASONING_WINDOW_MS,
            started_ms: [...mediumReasoningWindow.recentStarts, startedMs],
            updated_at: new Date(startedMs).toISOString(),
          }, null, 2)}\n`, "utf8"));
        }
        if (imageWindowApplies) {
          writes.push(fs.writeFile(imageStatePath, `${JSON.stringify({
            schema: "goldflow_chatgpt_web_image_start_window_v1",
            limit: CHATGPT_WEB_IMAGE_STARTS_PER_WINDOW,
            window_ms: CHATGPT_WEB_IMAGE_WINDOW_MS,
            started_ms: [...imageWindow.recentStarts, startedMs],
            updated_at: new Date(startedMs).toISOString(),
          }, null, 2)}\n`, "utf8"));
        }
        await Promise.all(writes);
        return state;
      }
    } finally {
      await fs.rm(gatePath, { recursive: true, force: true }).catch(() => {});
    }
    if (retryAfterMs) await sleep(Math.min(retryAfterMs, Math.max(pollMs, 1_000)));
  }
  throw new Error("Timed out waiting for the shared ChatGPT Web launch stagger gate.");
}
