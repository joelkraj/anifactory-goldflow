import os from "node:os";
import path from "node:path";

export function parseDesktopFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[++index] : "true";
    flags[key] = value;
  }
  return flags;
}

export function parseWorkerTypes(value) {
  const values = String(value ?? "llm,image").split(",").map((entry) => entry.trim()).filter(Boolean);
  const types = [...new Set(values.filter((entry) => ["llm", "image"].includes(entry)))];
  if (!types.length) throw new Error("At least one desktop worker type is required: llm or image.");
  return types;
}

export function defaultChromeExecutable(platform = process.platform) {
  if (platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (platform === "win32") return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  return "/usr/bin/google-chrome";
}

export function desktopConfig(flags = {}, environment = process.env) {
  const stateDir = path.resolve(flags["state-dir"] ?? environment.GOLDFLOW_STUDIO_STATE_DIR ?? path.join(os.homedir(), ".goldflow-studio"));
  const concurrency = Math.min(5, Math.max(1, Number(flags.concurrency ?? environment.GOLDFLOW_DESKTOP_CONCURRENCY ?? 3)));
  return {
    serverUrl: String(flags["server-url"] ?? environment.GOLDFLOW_STUDIO_URL ?? "http://127.0.0.1:4317").replace(/\/+$/, ""),
    stateDir,
    profileDir: path.resolve(flags["profile-dir"] ?? environment.GOLDFLOW_DESKTOP_PROFILE_DIR ?? path.join(stateDir, "chatgpt-browser-profile")),
    downloadsRoot: path.resolve(flags["downloads-root"] ?? environment.GOLDFLOW_STUDIO_DOWNLOADS_ROOT ?? path.join(os.homedir(), "Downloads", "GoldflowStudio")),
    chromeExecutable: path.resolve(flags["chrome-executable"] ?? environment.GOLDFLOW_DESKTOP_CHROME_EXECUTABLE ?? defaultChromeExecutable()),
    pairingCode: flags["pairing-code"] ?? environment.GOLDFLOW_STUDIO_PAIRING_CODE ?? null,
    concurrency,
    types: parseWorkerTypes(flags.types ?? environment.GOLDFLOW_DESKTOP_TYPES),
    headless: String(flags.headless ?? environment.GOLDFLOW_DESKTOP_HEADLESS ?? "false") === "true",
    label: String(flags.label ?? environment.GOLDFLOW_DESKTOP_LABEL ?? `${os.hostname()} Playwright`),
  };
}

export function assertDesktopConfig(config) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(config.serverUrl)) throw new Error("Desktop host server URL must use http://127.0.0.1 with an explicit port.");
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 5) throw new Error("Desktop host concurrency must be 1 through 5.");
  return config;
}
