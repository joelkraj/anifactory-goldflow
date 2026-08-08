#!/usr/bin/env node

import { spawn } from "node:child_process";

import { createStudioServer } from "../server.mjs";
import { launchNormalChromeLogin, loginMarkerExists } from "./browser-login.mjs";
import { desktopConfig, parseDesktopFlags } from "./config.mjs";
import { GoldflowDesktopHost } from "./worker-host.mjs";

async function main() {
  const flags = parseDesktopFlags(process.argv.slice(2));
  const preliminaryConfig = desktopConfig(flags);
  const forceLogin = String(flags.login ?? "false") === "true";
  const loginBootstrap = String(flags["login-bootstrap"] ?? "true") === "true";
  if (loginBootstrap && (forceLogin || !await loginMarkerExists(preliminaryConfig.profileDir))) {
    await launchNormalChromeLogin(preliminaryConfig);
  }
  const studio = await createStudioServer({
    port: flags.port ? Number(flags.port) : undefined,
    stateDir: flags["state-dir"],
    dataRoot: flags["data-root"],
    downloadsRoot: flags["downloads-root"],
  });
  const config = desktopConfig({
    ...flags,
    "server-url": studio.url,
    "pairing-code": studio.pairingCode,
  });
  const host = new GoldflowDesktopHost({ config });
  process.stdout.write([
    "",
    "Goldflow Studio desktop host is starting.",
    `Dashboard: ${studio.url}`,
    `Profile: ${config.profileDir}`,
    `Browser slots: ${config.concurrency}`,
    "Sign in inside the dedicated Goldflow Chrome window if prompted.",
    "Press Ctrl+C to drain active work and stop.",
    "",
  ].join("\n"));
  if (String(flags["open-dashboard"] ?? "true") === "true" && process.platform === "darwin") {
    spawn("open", [studio.url], { detached: true, stdio: "ignore" }).unref();
  }
  const stop = async () => {
    await host.stop().catch(() => {});
    await studio.close().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await host.start();
    await host.waitUntilStopped();
  } catch (error) {
    await host.stop({ drainMs: 0 }).catch(() => {});
    await studio.close().catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
