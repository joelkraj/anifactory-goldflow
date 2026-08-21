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
  const types = [...new Set(values.filter((entry) => ["llm", "image", "video"].includes(entry)))];
  if (!types.length) throw new Error("At least one desktop worker type is required: llm, image, or video.");
  return types;
}

export function normalizeBrowserProvider(value) {
  const normalized = String(value ?? "chatgpt").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (["chatgpt", "chatgpt-web", "openai"].includes(normalized)) return "chatgpt";
  if (["flow", "google-flow", "google", "nano-banana", "nano-banana-pro"].includes(normalized)) return "google-flow";
  if (["gemini", "google-gemini", "gemini-images", "nano-banana-2"].includes(normalized)) return "google-gemini";
  throw new Error(`Unsupported desktop browser provider: ${value}. Use chatgpt, google-flow, or google-gemini.`);
}

export function defaultChromeExecutable(platform = process.platform) {
  if (platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (platform === "win32") return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  return "/usr/bin/google-chrome";
}

export const PRODUCTION_BROWSER_CONCURRENCY_CEILING = 3;
export const GOOGLE_FLOW_BROWSER_CONCURRENCY_CEILING = 5;
export const DEFAULT_BROWSER_SUBMISSION_STAGGER_MS = 6_000;
export const MIN_BROWSER_SUBMISSION_STAGGER_MS = 5_000;
export const MAX_BROWSER_SUBMISSION_STAGGER_MS = 8_000;

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback));
}

export function desktopConfig(flags = {}, environment = process.env) {
  const stateDir = path.resolve(flags["state-dir"] ?? environment.GOLDFLOW_STUDIO_STATE_DIR ?? path.join(os.homedir(), ".goldflow-studio"));
  const browserProvider = normalizeBrowserProvider(flags.provider ?? environment.GOLDFLOW_DESKTOP_PROVIDER ?? "chatgpt");
  const browserConcurrencyCeiling = browserProvider === "google-flow"
    ? GOOGLE_FLOW_BROWSER_CONCURRENCY_CEILING
    : PRODUCTION_BROWSER_CONCURRENCY_CEILING;
  const concurrency = Math.min(browserConcurrencyCeiling, Math.max(1, Number(flags.concurrency ?? environment.GOLDFLOW_DESKTOP_CONCURRENCY ?? 3)));
  return {
    serverUrl: String(flags["server-url"] ?? environment.GOLDFLOW_STUDIO_URL ?? "http://127.0.0.1:4317").replace(/\/+$/, ""),
    stateDir,
    profileDir: path.resolve(flags["profile-dir"] ?? environment.GOLDFLOW_DESKTOP_PROFILE_DIR ?? path.join(stateDir, `${browserProvider}-browser-profile`)),
    downloadsRoot: path.resolve(flags["downloads-root"] ?? environment.GOLDFLOW_STUDIO_DOWNLOADS_ROOT ?? path.join(os.homedir(), "Downloads", "GoldflowStudio")),
    chromeExecutable: path.resolve(flags["chrome-executable"] ?? environment.GOLDFLOW_DESKTOP_CHROME_EXECUTABLE ?? defaultChromeExecutable()),
    pairingCode: flags["pairing-code"] ?? environment.GOLDFLOW_STUDIO_PAIRING_CODE ?? null,
    concurrency,
    submissionStaggerMs: boundedNumber(
      flags["submission-stagger-ms"] ?? environment.GOLDFLOW_BROWSER_SUBMISSION_STAGGER_MS,
      DEFAULT_BROWSER_SUBMISSION_STAGGER_MS,
      MIN_BROWSER_SUBMISSION_STAGGER_MS,
      MAX_BROWSER_SUBMISSION_STAGGER_MS,
    ),
    transportFailureThreshold: 3,
    transportCooldownMs: 5 * 60_000,
    rateLimitCooldownMs: 10 * 60_000,
    types: parseWorkerTypes(flags.types ?? environment.GOLDFLOW_DESKTOP_TYPES ?? (
      browserProvider === "chatgpt" ? "llm,image"
        : browserProvider === "google-gemini" ? "llm,image"
          : "image"
    )),
    headless: String(flags.headless ?? environment.GOLDFLOW_DESKTOP_HEADLESS ?? "false") === "true",
    label: String(flags.label ?? environment.GOLDFLOW_DESKTOP_LABEL ?? `${os.hostname()} Playwright`),
    browserProvider,
    browserConcurrencyCeiling,
    flowProjectUrl: flags["flow-project-url"] ?? environment.GOLDFLOW_FLOW_PROJECT_URL ?? null,
    flowPlanLabel: String(flags["flow-plan"] ?? environment.GOLDFLOW_FLOW_PLAN ?? "ULTRA"),
    flowModelLabel: String(flags["flow-model"] ?? environment.GOLDFLOW_FLOW_MODEL ?? "Nano Banana Pro"),
    flowVideoModelLabel: String(flags["flow-video-model"] ?? environment.GOLDFLOW_FLOW_VIDEO_MODEL ?? "Veo 3.1 Fast"),
    geminiPlanLabel: String(flags["gemini-plan"] ?? environment.GOLDFLOW_GEMINI_PLAN ?? "Ultra"),
    geminiModelLabel: String(flags["gemini-model"] ?? environment.GOLDFLOW_GEMINI_MODEL ?? "Nano Banana 2"),
  };
}

export function assertDesktopConfig(config) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(config.serverUrl)) throw new Error("Desktop host server URL must use http://127.0.0.1 with an explicit port.");
  const concurrencyCeiling = config.browserProvider === "google-flow"
    ? GOOGLE_FLOW_BROWSER_CONCURRENCY_CEILING
    : PRODUCTION_BROWSER_CONCURRENCY_CEILING;
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > concurrencyCeiling) {
    throw new Error(`Desktop host concurrency must be 1 through ${concurrencyCeiling} for ${config.browserProvider}.`);
  }
  const allowedTypes = config.browserProvider === "chatgpt"
    ? new Set(["llm", "image"])
    : config.browserProvider === "google-gemini"
      ? new Set(["llm", "image"])
      : new Set(["image", "video"]);
  if (config.types.some((type) => !allowedTypes.has(type))) {
    throw new Error(`${config.browserProvider} accepts only ${[...allowedTypes].join(" or ")} work.`);
  }
  if (config.browserProvider === "google-flow" && config.concurrency > 1 && config.flowProjectUrl) {
    throw new Error("Concurrent Google Flow work requires one dedicated project per persistent worker slot; omit the single shared --flow-project-url when concurrency is above one.");
  }
  return config;
}
