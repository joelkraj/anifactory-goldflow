import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const CHATGPT_LOGIN_URL = "https://chatgpt.com/?temporary-chat=true";

export function loginVerificationMarkerPath(profileDir) {
  return path.join(profileDir, ".goldflow-chatgpt-login-verified.json");
}

export async function loginMarkerExists(profileDir) {
  try {
    const marker = JSON.parse(await fs.readFile(loginVerificationMarkerPath(profileDir), "utf8"));
    return marker?.schema === "goldflow_chatgpt_login_v1" && marker?.authenticated === true;
  } catch {
    return false;
  }
}

export async function markLoginVerified(profileDir, details = {}) {
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const markerPath = loginVerificationMarkerPath(profileDir);
  await fs.writeFile(markerPath, `${JSON.stringify({
    schema: "goldflow_chatgpt_login_v1",
    authenticated: true,
    verified_at: new Date().toISOString(),
    ...details,
  }, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(markerPath, 0o600);
  return markerPath;
}

export async function clearLoginMarker(profileDir) {
  await fs.rm(loginVerificationMarkerPath(profileDir), { force: true });
}

export async function launchNormalChromeLogin({ chromeExecutable, profileDir, log = console.log } = {}) {
  await Promise.all([
    fs.access(chromeExecutable),
    fs.mkdir(profileDir, { recursive: true, mode: 0o700 }),
  ]);
  log("A normal dedicated Chrome window is opening for ChatGPT sign-in.");
  log("Sign in, confirm your normal ChatGPT home screen appears, then quit that dedicated Chrome window completely.");
  const child = spawn(chromeExecutable, [
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--disable-background-mode",
    "--no-first-run",
    "--no-default-browser-check",
    CHATGPT_LOGIN_URL,
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

export { CHATGPT_LOGIN_URL };
