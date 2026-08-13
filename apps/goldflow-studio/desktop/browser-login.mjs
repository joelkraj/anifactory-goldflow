import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const CHATGPT_LOGIN_URL = "https://chatgpt.com/?temporary-chat=true";
const GOOGLE_FLOW_LOGIN_URL = "https://labs.google/fx/tools/flow";
const GOOGLE_GEMINI_LOGIN_URL = "https://gemini.google.com/images";

function providerName(provider) {
  return provider === "google-flow" ? "Google Flow" : provider === "google-gemini" ? "Google Gemini" : "ChatGPT";
}

function loginUrl(provider) {
  return provider === "google-flow" ? GOOGLE_FLOW_LOGIN_URL : provider === "google-gemini" ? GOOGLE_GEMINI_LOGIN_URL : CHATGPT_LOGIN_URL;
}

export function loginVerificationMarkerPath(profileDir, provider = "chatgpt") {
  return path.join(profileDir, `.goldflow-${provider}-login-verified.json`);
}

export async function loginMarkerExists(profileDir, provider = "chatgpt") {
  try {
    const marker = JSON.parse(await fs.readFile(loginVerificationMarkerPath(profileDir, provider), "utf8"));
    return ["goldflow_browser_login_v1", "goldflow_chatgpt_login_v1"].includes(marker?.schema) && marker?.authenticated === true;
  } catch {
    return false;
  }
}

export async function markLoginVerified(profileDir, details = {}, provider = "chatgpt") {
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const markerPath = loginVerificationMarkerPath(profileDir, provider);
  await fs.writeFile(markerPath, `${JSON.stringify({
    schema: "goldflow_browser_login_v1",
    provider,
    authenticated: true,
    verified_at: new Date().toISOString(),
    ...details,
  }, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(markerPath, 0o600);
  return markerPath;
}

export async function clearLoginMarker(profileDir, provider = "chatgpt") {
  await fs.rm(loginVerificationMarkerPath(profileDir, provider), { force: true });
}

export async function launchNormalChromeLogin({ chromeExecutable, profileDir, browserProvider = "chatgpt", log = console.log } = {}) {
  await Promise.all([
    fs.access(chromeExecutable),
    fs.mkdir(profileDir, { recursive: true, mode: 0o700 }),
  ]);
  const displayName = providerName(browserProvider);
  log(`A normal dedicated Chrome window is opening for ${displayName} sign-in.`);
  log(`Sign in, confirm the normal ${displayName} screen appears, then quit that dedicated Chrome window completely.`);
  const child = spawn(chromeExecutable, [
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--disable-background-mode",
    "--no-first-run",
    "--no-default-browser-check",
    loginUrl(browserProvider),
  ], { env: process.env, stdio: "ignore" });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Normal Chrome login window exited from signal ${signal}.`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`Normal Chrome login window exited with status ${exitCode}.`);
}

export { CHATGPT_LOGIN_URL, GOOGLE_FLOW_LOGIN_URL };
