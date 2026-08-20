import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export const LOCAL_NOTIFICATION_CONFIG_SCHEMA = "goldflow_local_notification_config_v1";
export const ANALYTICS_NOTIFICATION_LEDGER_SCHEMA = "goldflow_analytics_approval_notification_ledger_v1";

const APPLESCRIPT = `on run argv
  set targetAddress to item 1 of argv
  set messageText to item 2 of argv
  tell application "Messages"
    set targetService to first service whose service type = iMessage
    set targetBuddy to buddy targetAddress of targetService
    send messageText to targetBuddy
  end tell
end run`;

function clean(value) {
  return String(value ?? "").trim();
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

function validateConfig(config, configPath) {
  if (config?.schema !== LOCAL_NOTIFICATION_CONFIG_SCHEMA) {
    throw new Error(`Local notification config missing or invalid: ${configPath}`);
  }
  if (config?.imessage?.enabled !== true) {
    throw new Error("Local iMessage notifications are disabled.");
  }
  const recipient = clean(config?.imessage?.recipient);
  if (!/^\+[1-9]\d{7,14}$/.test(recipient)) {
    throw new Error("Local iMessage recipient must use normalized E.164 form.");
  }
  return recipient;
}

function sendViaMessages({ recipient, message }) {
  const result = spawnSync("/usr/bin/osascript", ["-e", APPLESCRIPT, "--", recipient, message], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(clean(result.stderr) || clean(result.stdout) || `Messages exited ${result.status}.`);
  }
  return { status: "sent" };
}

export async function sendAnalyticsApprovalNotification({
  configPath,
  ledgerPath,
  dedupeKey,
  message,
  dryRun = false,
  now = new Date(),
  sender = sendViaMessages,
} = {}) {
  const normalizedMessage = clean(message);
  const normalizedDedupeKey = clean(dedupeKey);
  if (!clean(configPath)) throw new Error("Analytics notification requires configPath.");
  if (!clean(ledgerPath)) throw new Error("Analytics notification requires ledgerPath.");
  if (!normalizedDedupeKey) throw new Error("Analytics notification requires a non-empty dedupe key.");
  if (!normalizedMessage) throw new Error("Analytics notification requires a non-empty message.");
  if (normalizedMessage.length > 3_500) throw new Error("Analytics notification message exceeds 3500 characters.");
  const sentAt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(sentAt.getTime())) throw new Error("Analytics notification requires a valid timestamp.");

  const config = await readJson(path.resolve(configPath));
  const recipient = validateConfig(config, path.resolve(configPath));
  const resolvedLedgerPath = path.resolve(ledgerPath);
  const existing = await readJson(resolvedLedgerPath);
  const ledger = existing?.schema === ANALYTICS_NOTIFICATION_LEDGER_SCHEMA
    ? existing
    : {
        schema: ANALYTICS_NOTIFICATION_LEDGER_SCHEMA,
        status: "active",
        entries: [],
        policy: "Send one iMessage per exact approval-packet key. Never send routine no-change scans or auto-apply a recommendation.",
        created_at: sentAt.toISOString(),
      };
  const prior = ledger.entries.find((entry) => entry.dedupe_key === normalizedDedupeKey && entry.status === "sent");
  const recipientFingerprint = sha256(recipient).slice(0, 12);
  if (prior) {
    return {
      status: "deduplicated",
      dedupe_key: normalizedDedupeKey,
      recipient_fingerprint: recipientFingerprint,
      prior_sent_at: prior.sent_at,
      ledger_path: resolvedLedgerPath,
    };
  }
  if (dryRun) {
    return {
      status: "dry_run",
      dedupe_key: normalizedDedupeKey,
      recipient_fingerprint: recipientFingerprint,
      message_sha256: sha256(normalizedMessage),
      ledger_path: resolvedLedgerPath,
    };
  }

  await sender({ recipient, message: normalizedMessage });
  ledger.entries.push({
    status: "sent",
    dedupe_key: normalizedDedupeKey,
    recipient_fingerprint: recipientFingerprint,
    message_sha256: sha256(normalizedMessage),
    sent_at: sentAt.toISOString(),
  });
  ledger.updated_at = sentAt.toISOString();
  await writeJsonAtomic(resolvedLedgerPath, ledger);
  return {
    status: "sent",
    dedupe_key: normalizedDedupeKey,
    recipient_fingerprint: recipientFingerprint,
    message_sha256: sha256(normalizedMessage),
    sent_at: sentAt.toISOString(),
    ledger_path: resolvedLedgerPath,
  };
}
