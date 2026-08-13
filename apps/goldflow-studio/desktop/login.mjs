#!/usr/bin/env node

import { clearLoginMarker, launchNormalChromeLogin } from "./browser-login.mjs";
import { desktopConfig, parseDesktopFlags } from "./config.mjs";

async function main() {
  const config = desktopConfig(parseDesktopFlags(process.argv.slice(2)));
  await clearLoginMarker(config.profileDir, config.browserProvider);
  await launchNormalChromeLogin(config);
  process.stdout.write(`${config.browserProvider} login window closed. Start Goldflow Studio to verify and store the session.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
