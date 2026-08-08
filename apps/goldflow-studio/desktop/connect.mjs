#!/usr/bin/env node

import { desktopConfig, parseDesktopFlags } from "./config.mjs";
import { GoldflowDesktopHost } from "./worker-host.mjs";

async function pairingCode(serverUrl) {
  const response = await fetch(`${serverUrl}/app-config.js`);
  if (!response.ok) throw new Error(`Goldflow Studio app config returned HTTP ${response.status}.`);
  const source = await response.text();
  const match = source.match(/^window\.GOLDFLOW_STUDIO_CONFIG=(.+);\s*$/s);
  if (!match) throw new Error("Goldflow Studio app config is malformed.");
  return JSON.parse(match[1]).pairingCode;
}

async function main() {
  const flags = parseDesktopFlags(process.argv.slice(2));
  const preliminary = desktopConfig(flags);
  const config = desktopConfig({ ...flags, "pairing-code": flags["pairing-code"] ?? await pairingCode(preliminary.serverUrl) });
  const host = new GoldflowDesktopHost({ config });
  const stop = async () => {
    await host.stop().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await host.start();
  await host.waitUntilStopped();
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
