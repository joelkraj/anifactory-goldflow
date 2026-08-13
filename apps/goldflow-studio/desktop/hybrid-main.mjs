#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";

import { createStudioServer } from "../server.mjs";
import { launchNormalChromeLogin, loginMarkerExists } from "./browser-login.mjs";
import { assertDesktopConfig, desktopConfig, parseDesktopFlags } from "./config.mjs";
import { GoldflowDesktopHost } from "./worker-host.mjs";
import { removePlanningRouteRegistry, writePlanningRouteRegistry } from "../lib/planning-route-registry.mjs";

const CHATGPT_PORT = 4317;
const GOOGLE_FLOW_PORT = 4318;
const GOOGLE_GEMINI_PORT = 4319;
const CHATGPT_CONCURRENCY = 3;
const GOOGLE_FLOW_CONCURRENCY = 5;
const GOOGLE_GEMINI_CONCURRENCY = 3;

function boolFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(?:true|1|yes)$/i.test(String(value));
}

function positiveMilliseconds(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function providerConfig(flags, { provider, port, concurrency, profileFlag }) {
  const types = provider === "google-flow" ? "image,video" : "llm,image";
  const stateProbe = desktopConfig({
    ...flags,
    provider,
    types,
    concurrency: String(concurrency),
  });
  const profileDir = path.resolve(
    flags[profileFlag]
      ?? path.join(stateProbe.stateDir, `${provider}-browser-profile`),
  );
  return assertDesktopConfig(desktopConfig({
    ...flags,
    provider,
    types,
    concurrency: String(concurrency),
    "profile-dir": profileDir,
    "server-url": `http://127.0.0.1:${port}`,
    label: flags[`${provider}-label`] ?? flags.label,
  }));
}

async function bootstrapLogin(config, flags, forceFlag) {
  const forceLogin = boolFlag(flags[forceFlag], boolFlag(flags.login, false));
  const loginBootstrap = boolFlag(flags["login-bootstrap"], true);
  const hasMarker = await loginMarkerExists(config.profileDir, config.browserProvider);
  if (!forceLogin && hasMarker) return;
  if (!loginBootstrap) {
    if (config.headless) {
      throw new Error(`Cannot start headless ${config.browserProvider}: its persistent profile has no verified login marker.`);
    }
    return;
  }
  if (config.headless) {
    throw new Error(`Cannot bootstrap ${config.browserProvider} authentication in headless mode.`);
  }
  await launchNormalChromeLogin(config);
}

function openDashboard(url) {
  if (process.platform !== "darwin") return;
  spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
}

async function main() {
  const flags = parseDesktopFlags(process.argv.slice(2));
  if (flags.provider || flags.types || flags.concurrency || flags.port || flags["profile-dir"] || flags["server-url"]) {
    throw new Error([
      "studio:hybrid fixes all three provider lanes for production safety.",
      "Do not pass --provider, --types, --concurrency, --port, --profile-dir, or --server-url;",
      "use --chatgpt-profile-dir, --google-flow-profile-dir, or --google-gemini-profile-dir only when a non-default persistent profile is required.",
    ].join(" "));
  }

  const chatGptConfig = providerConfig(flags, {
    provider: "chatgpt",
    port: CHATGPT_PORT,
    concurrency: CHATGPT_CONCURRENCY,
    profileFlag: "chatgpt-profile-dir",
  });
  const googleFlowConfig = providerConfig(flags, {
    provider: "google-flow",
    port: GOOGLE_FLOW_PORT,
    concurrency: GOOGLE_FLOW_CONCURRENCY,
    profileFlag: "google-flow-profile-dir",
  });
  const googleGeminiConfig = providerConfig(flags, {
    provider: "google-gemini",
    port: GOOGLE_GEMINI_PORT,
    concurrency: GOOGLE_GEMINI_CONCURRENCY,
    profileFlag: "google-gemini-profile-dir",
  });
  const profileDirs = [chatGptConfig, googleFlowConfig, googleGeminiConfig].map((config) => path.resolve(config.profileDir));
  if (new Set(profileDirs).size !== profileDirs.length) {
    throw new Error("ChatGPT, Google Flow, and Google Gemini must use separate persistent Chrome profiles.");
  }

  // Login windows share the foreground desktop. Bootstrap them serially so the
  // operator never has to distinguish two simultaneous sign-in windows.
  await bootstrapLogin(chatGptConfig, flags, "chatgpt-login");
  await bootstrapLogin(googleFlowConfig, flags, "google-flow-login");
  await bootstrapLogin(googleGeminiConfig, flags, "google-gemini-login");

  let chatGptStudio = null;
  let googleFlowStudio = null;
  let googleGeminiStudio = null;
  let chatGptHost = null;
  let googleFlowHost = null;
  let googleGeminiHost = null;
  const drainMs = positiveMilliseconds(flags["drain-ms"], 300_000);

  async function shutdown({ drain = true, reason = "shutdown" } = {}) {
    process.stdout.write(`\nDraining Goldflow hybrid image workers (${reason})...\n`);
    const hostDrainMs = drain ? drainMs : 0;
    await Promise.allSettled([
      chatGptHost?.stop({ drainMs: hostDrainMs }),
      googleFlowHost?.stop({ drainMs: hostDrainMs }),
      googleGeminiHost?.stop({ drainMs: hostDrainMs }),
    ].filter(Boolean));
    await removePlanningRouteRegistry().catch(() => {});
    await Promise.allSettled([
      chatGptStudio?.close(),
      googleFlowStudio?.close(),
      googleGeminiStudio?.close(),
    ].filter(Boolean));
  }

  try {
    chatGptStudio = await createStudioServer({
      port: CHATGPT_PORT,
      stateDir: flags["state-dir"],
      dataRoot: flags["data-root"],
      downloadsRoot: flags["downloads-root"],
      browserProvider: "chatgpt",
    });
    googleFlowStudio = await createStudioServer({
      port: GOOGLE_FLOW_PORT,
      stateDir: flags["state-dir"],
      dataRoot: flags["data-root"],
      downloadsRoot: flags["downloads-root"],
      browserProvider: "google-flow",
      flowPlanLabel: googleFlowConfig.flowPlanLabel,
      flowModelLabel: googleFlowConfig.flowModelLabel,
      flowVideoModelLabel: googleFlowConfig.flowVideoModelLabel,
    });
    googleGeminiStudio = await createStudioServer({
      port: GOOGLE_GEMINI_PORT,
      stateDir: flags["state-dir"],
      dataRoot: flags["data-root"],
      downloadsRoot: flags["downloads-root"],
      browserProvider: "google-gemini",
      geminiPlanLabel: googleGeminiConfig.geminiPlanLabel,
      geminiModelLabel: googleGeminiConfig.geminiModelLabel,
    });
    await writePlanningRouteRegistry({
      chatgpt_web: chatGptStudio.routeEnvironment(),
      gemini_web: googleGeminiStudio.routeEnvironment(),
    });

    chatGptHost = new GoldflowDesktopHost({
      config: desktopConfig({
        ...flags,
        provider: "chatgpt",
        types: "llm,image",
        concurrency: String(CHATGPT_CONCURRENCY),
        "profile-dir": chatGptConfig.profileDir,
        "server-url": chatGptStudio.url,
        "pairing-code": chatGptStudio.pairingCode,
      }),
    });
    googleFlowHost = new GoldflowDesktopHost({
      config: desktopConfig({
        ...flags,
        provider: "google-flow",
        types: "image,video",
        concurrency: String(GOOGLE_FLOW_CONCURRENCY),
        "profile-dir": googleFlowConfig.profileDir,
        "server-url": googleFlowStudio.url,
        "pairing-code": googleFlowStudio.pairingCode,
      }),
    });
    googleGeminiHost = new GoldflowDesktopHost({
      config: desktopConfig({
        ...flags,
        provider: "google-gemini",
        types: "llm,image",
        concurrency: String(GOOGLE_GEMINI_CONCURRENCY),
        "profile-dir": googleGeminiConfig.profileDir,
        "server-url": googleGeminiStudio.url,
        "pairing-code": googleGeminiStudio.pairingCode,
      }),
    });

    await Promise.all([chatGptHost.start(), googleFlowHost.start(), googleGeminiHost.start()]);
    process.stdout.write([
      "",
      "Goldflow hybrid media host is ready.",
      `ChatGPT planning + idle images: ${chatGptStudio.url} (${CHATGPT_CONCURRENCY} slots; ${chatGptHost.config.profileDir})`,
      `Google Flow images + video: ${googleFlowStudio.url} (${GOOGLE_FLOW_CONCURRENCY} shared slots; ${googleFlowHost.config.profileDir})`,
      `Google Gemini planning + idle images: ${googleGeminiStudio.url} (${GOOGLE_GEMINI_CONCURRENCY} slots; ${googleGeminiHost.config.profileDir})`,
      "The providers keep separate persistent sessions. Text planning leases before images on ChatGPT and Gemini; Flow slots four and five prefer queued video work.",
      "Press Ctrl+C to stop leasing new work and drain active generations.",
      "",
    ].join("\n"));

    if (boolFlag(flags["open-dashboard"], true)) {
      openDashboard(chatGptStudio.url);
      openDashboard(googleFlowStudio.url);
      openDashboard(googleGeminiStudio.url);
    }

    const signal = await new Promise((resolve) => {
      process.once("SIGINT", () => resolve("SIGINT"));
      process.once("SIGTERM", () => resolve("SIGTERM"));
    });
    await shutdown({ drain: true, reason: signal });
  } catch (error) {
    await shutdown({ drain: false, reason: "startup failure" }).catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
