#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";
import { CHATGPT_WEB_ARCHIVE_QUEUE_PATH } from "./lib/chatgpt-web-archive-queue.mjs";
import {
  assertChatGptWebCooldownClear,
  CHATGPT_WEB_MAINTENANCE_LOCK_PATH,
  chatGptWebMaintenanceActive,
  CHATGPT_WEB_THROTTLE_STATE_PATH,
  chatGptWebCooldownRemainingMs,
  recordChatGptWebRateLimit,
} from "./lib/chatgpt-web-throttle-state.mjs";

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = "true";
    }
  }
  return flags;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonLines(filePath) {
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

async function appendReceipt(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
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

async function assertNoActiveProductionWorkers(runtimeRoot) {
  const active = [];
  for (const pool of ["text-workers", "image-workers", "browser-workers"]) {
    const poolPath = path.join(runtimeRoot, "goldflow-worker-leases", pool);
    for (const entry of await fs.readdir(poolPath, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const slotPath = path.join(poolPath, entry.name);
      const lease = await fs.readFile(path.join(slotPath, "lease.json"), "utf8").then(JSON.parse).catch(() => null);
      if (processIsAlive(Number(lease?.pid))) {
        active.push(`${pool}/${entry.name}:${lease.kind ?? "unknown"}:${lease.work_id ?? "unknown"}`);
      } else {
        await fs.rm(slotPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  if (active.length) {
    throw new Error(`Archive cleanup is maintenance-only; active ChatGPT workers: ${active.join(", ")}`);
  }
}

async function rateLimitMessage(page) {
  const dialog = page.locator('[role="dialog"]').filter({ hasText: /Too many requests/i }).last();
  if (!await dialog.isVisible().catch(() => false)) return null;
  return String(await dialog.textContent().catch(() => "Too many requests")).trim().slice(0, 500);
}

async function archiveConversation(page, conversationUrl) {
  await page.goto(conversationUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1_500);
  const existingLimit = await rateLimitMessage(page);
  if (existingLimit) throw new Error(`rate_limit: ${existingLimit}`);
  const moreByTestId = page.getByTestId("conversation-options-button");
  const moreByLabel = page.locator('button[aria-label="More"]');
  const more = moreByTestId.or(moreByLabel).last();
  await more.waitFor({ state: "visible", timeout: 30_000 });
  await more.click();
  const archive = page.getByRole("menuitem", { name: "Archive", exact: true }).last();
  await archive.waitFor({ state: "visible", timeout: 20_000 });
  await archive.click();
  await page.waitForTimeout(1_000);
  const newLimit = await rateLimitMessage(page);
  if (newLimit) throw new Error(`rate_limit: ${newLimit}`);
  await page.waitForURL((url) => url.href !== conversationUrl, { timeout: 30_000 });
}

const flags = parseFlags(process.argv.slice(2));
if (flags.help === "true" || process.argv.slice(2).includes("-h")) {
  console.log(`Usage: goldflow run web-archive-cleanup [options]

Archives queued GPT Image conversations through a serialized maintenance lane.

Options:
  --max <count>                    Maximum conversations to archive (default: 1)
  --interval-ms <milliseconds>     Delay between mutations (minimum: 900000)
  --rate-limit-cooldown-ms <ms>    Cooldown after a recorded throttle (default: 900000)
  --queue <path>                   Override the archive queue path
  --receipts <path>                Override the append-only receipt path
  --descriptor <path>              Override the launcher browser descriptor
  --status true                    Print queue/cooldown status without opening Chrome
`);
  process.exit(0);
}
const queuePath = path.resolve(flags.queue ?? CHATGPT_WEB_ARCHIVE_QUEUE_PATH);
const receiptPath = path.resolve(flags.receipts ?? `${queuePath}.receipts.jsonl`);
const descriptorPath = path.resolve(
  flags.descriptor
    ?? path.join(process.env.HOME || "/Users/joel", ".codex-chatgpt-web", "runtime", "launcher-browser.json"),
);
const intervalMs = Math.max(900_000, Number(flags["interval-ms"] ?? 900_000) || 900_000);
const rateLimitCooldownMs = Math.max(
  60_000,
  Number(flags["rate-limit-cooldown-ms"] ?? 900_000) || 900_000,
);
// ChatGPT currently permits one conversation archive mutation per observed
// 15-minute window. Keep one as the safe default and enforce that spacing even
// when a larger explicit maintenance batch is requested.
const maxItems = Math.max(1, Number(flags.max ?? 1) || 1);
const lockPath = CHATGPT_WEB_MAINTENANCE_LOCK_PATH;

if (flags.status === "true" || flags["dry-run"] === "true") {
  const queued = await readJsonLines(queuePath);
  const receipts = await readJsonLines(receiptPath);
  const browserThrottle = await fs.readFile(CHATGPT_WEB_THROTTLE_STATE_PATH, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const archived = new Set(receipts
    .filter((row) => row.status === "archived")
    .map((row) => row.conversation_url));
  const pending = new Map(queued
    .filter((row) => row?.conversation_url && !archived.has(row.conversation_url))
    .map((row) => [row.conversation_url, row]));
  const lastCooldownTrigger = receipts
    .filter((row) => row.status === "archived"
      || (row.status === "deferred" && /rate_limit/i.test(String(row.error ?? ""))))
    .at(-1);
  const elapsedSinceCooldownTriggerMs = lastCooldownTrigger?.completed_at
    ? Date.now() - Date.parse(lastCooldownTrigger.completed_at)
    : null;
  const cooldownRemainingMs = Number.isFinite(elapsedSinceCooldownTriggerMs)
    ? Math.max(0, rateLimitCooldownMs - elapsedSinceCooldownTriggerMs)
    : 0;
  const cooldownUntil = lastCooldownTrigger?.completed_at && cooldownRemainingMs > 0
    ? new Date(Date.parse(lastCooldownTrigger.completed_at) + rateLimitCooldownMs).toISOString()
    : null;
  console.log(JSON.stringify({
    queue_path: queuePath,
    receipt_path: receiptPath,
    queued_records: queued.length,
    archived_conversations: archived.size,
    pending_conversations: pending.size,
    cooldown_remaining_ms: cooldownRemainingMs,
    cooldown_until: cooldownUntil,
    browser_throttle_remaining_ms: chatGptWebCooldownRemainingMs(browserThrottle),
    browser_throttle_until: browserThrottle?.cooldown_until ?? null,
    maintenance_active: await chatGptWebMaintenanceActive(),
    last_receipt: receipts.at(-1) ?? null,
  }, null, 2));
  process.exit(0);
}

await fs.mkdir(path.dirname(queuePath), { recursive: true });
await fs.mkdir(path.dirname(lockPath), { recursive: true });
await fs.mkdir(lockPath).catch((error) => {
  if (error?.code === "EEXIST") throw new Error(`Archive cleanup is already running: ${lockPath}`);
  throw error;
});
await fs.writeFile(path.join(lockPath, "lease.json"), `${JSON.stringify({
  schema: "goldflow_chatgpt_web_maintenance_lease_v1",
  pid: process.pid,
  acquired_at: new Date().toISOString(),
}, null, 2)}\n`, "utf8");

let browser;
let page;
const results = [];
try {
  await assertNoActiveProductionWorkers(path.dirname(descriptorPath));
  await assertChatGptWebCooldownClear({ operation: "archive cleanup", allowMaintenance: true });
  const descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
  const queued = await readJsonLines(queuePath);
  const receipts = await readJsonLines(receiptPath);
  const lastCooldownTrigger = receipts
    .filter((row) => row.status === "archived"
      || (row.status === "deferred" && /rate_limit/i.test(String(row.error ?? ""))))
    .at(-1);
  if (lastCooldownTrigger?.completed_at) {
    const elapsedMs = Date.now() - Date.parse(lastCooldownTrigger.completed_at);
    if (Number.isFinite(elapsedMs) && elapsedMs < rateLimitCooldownMs) {
      throw new Error(
        `Archive cleanup cooling down for ${Math.ceil((rateLimitCooldownMs - elapsedMs) / 1000)} more seconds after the previous archive mutation or rate limit.`,
      );
    }
  }
  const archived = new Set(receipts.filter((row) => row.status === "archived").map((row) => row.conversation_url));
  const uniquePending = [...new Map(
    queued
      .filter((row) => row?.conversation_url && !archived.has(row.conversation_url))
      .map((row) => [row.conversation_url, row]),
  ).values()].slice(0, maxItems);
  browser = await chromium.connectOverCDP(descriptor.endpoint);
  const context = browser.contexts()[0];
  page = context.pages().find((candidate) => candidate.url().includes("chatgpt.com")) ?? await context.newPage();
  for (let index = 0; index < uniquePending.length; index += 1) {
    const row = uniquePending[index];
    const startedAt = new Date().toISOString();
    try {
      await archiveConversation(page, row.conversation_url);
      const receipt = {
        schema: "goldflow_chatgpt_web_archive_receipt_v1",
        queue_id: row.queue_id,
        conversation_url: row.conversation_url,
        status: "archived",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      };
      await appendReceipt(receiptPath, receipt);
      results.push(receipt);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 1_000);
      const receipt = {
        schema: "goldflow_chatgpt_web_archive_receipt_v1",
        queue_id: row.queue_id,
        conversation_url: row.conversation_url,
        status: "deferred",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        error: message,
      };
      await appendReceipt(receiptPath, receipt);
      await recordChatGptWebRateLimit({
        lane: "archive",
        workId: row.queue_id,
        error,
        cooldownMs: rateLimitCooldownMs,
      }).catch(() => null);
      results.push(receipt);
      if (/rate_limit/i.test(message)) break;
    }
    if (index < uniquePending.length - 1) await sleep(intervalMs);
  }
  await page.goto("https://chatgpt.com/?temporary-chat=true", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  const archivedCount = results.filter((row) => row.status === "archived").length;
  console.log(JSON.stringify({
    queue_path: queuePath,
    receipt_path: receiptPath,
    attempted: results.length,
    archived: archivedCount,
    deferred: results.length - archivedCount,
  }, null, 2));
  if (results.some((row) => row.status !== "archived")) process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
}
