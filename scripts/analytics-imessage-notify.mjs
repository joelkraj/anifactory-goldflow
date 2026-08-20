#!/usr/bin/env node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendAnalyticsApprovalNotification } from "./lib/analytics-imessage-notification.mjs";

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function isTrue(value) {
  return /^(true|1|yes)$/i.test(String(value ?? ""));
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
  const configPath = path.resolve(flags.config ?? process.env.GOLDFLOW_NOTIFICATION_CONFIG ?? path.join(os.homedir(), ".config", "goldflow", "notifications.json"));
  const ledgerPath = path.resolve(flags.ledger ?? path.join(dataRoot, "notifications", "analytics_approval_notification_ledger.json"));
  const message = flags["message-file"]
    ? await fs.readFile(path.resolve(flags["message-file"]), "utf8")
    : flags.message;
  const result = await sendAnalyticsApprovalNotification({
    configPath,
    ledgerPath,
    dedupeKey: flags["dedupe-key"],
    message,
    dryRun: isTrue(flags["dry-run"]),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
