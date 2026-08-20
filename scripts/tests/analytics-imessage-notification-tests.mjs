#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ANALYTICS_NOTIFICATION_LEDGER_SCHEMA,
  LOCAL_NOTIFICATION_CONFIG_SCHEMA,
  sendAnalyticsApprovalNotification,
} from "../lib/analytics-imessage-notification.mjs";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-imessage-notify-"));
try {
  const configPath = path.join(tempDir, "notifications.json");
  const ledgerPath = path.join(tempDir, "notification-ledger.json");
  await writeJson(configPath, {
    schema: LOCAL_NOTIFICATION_CONFIG_SCHEMA,
    imessage: { enabled: true, recipient: "+15555550123" },
  });
  const sent = [];
  const sender = async (payload) => {
    sent.push(payload);
    return { status: "sent" };
  };

  const first = await sendAnalyticsApprovalNotification({
    configPath,
    ledgerPath,
    dedupeKey: "aggregate-sha:recommendation-a",
    message: "Goldflow found one evidence-backed improvement for approval.",
    now: "2026-08-18T15:00:00.000Z",
    sender,
  });
  assert.equal(first.status, "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].recipient, "+15555550123");
  assert.equal(first.recipient_fingerprint.length, 12);
  assert.ok(!JSON.stringify(first).includes("+15555550123"));

  const duplicate = await sendAnalyticsApprovalNotification({
    configPath,
    ledgerPath,
    dedupeKey: "aggregate-sha:recommendation-a",
    message: "Goldflow found one evidence-backed improvement for approval.",
    now: "2026-08-18T16:00:00.000Z",
    sender,
  });
  assert.equal(duplicate.status, "deduplicated");
  assert.equal(sent.length, 1);

  const dryRun = await sendAnalyticsApprovalNotification({
    configPath,
    ledgerPath,
    dedupeKey: "aggregate-sha:recommendation-b",
    message: "A second recommendation.",
    dryRun: true,
    sender,
  });
  assert.equal(dryRun.status, "dry_run");
  assert.equal(sent.length, 1);

  const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
  assert.equal(ledger.schema, ANALYTICS_NOTIFICATION_LEDGER_SCHEMA);
  assert.equal(ledger.entries.length, 1);
  assert.ok(!JSON.stringify(ledger).includes("+15555550123"));
  assert.ok(!JSON.stringify(ledger).includes("evidence-backed improvement"));

  console.log("analytics iMessage notification tests passed");
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
