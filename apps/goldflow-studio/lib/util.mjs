import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export async function pathExists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then(() => true).catch(() => false);
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomToken(8)}.tmp`);
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

export function ensureInside(candidate, allowedRoot, label = "path") {
  const root = path.resolve(allowedRoot);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside ${root}.`);
  }
  return resolved;
}

export function safeSegment(value, label = "value") {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}.`);
  return text;
}

export function compactError(error, maxChars = 4000) {
  const text = error instanceof Error ? error.stack || error.message : String(error ?? "unknown error");
  return text.length <= maxChars ? text : `${text.slice(-maxChars)}\n[truncated from ${text.length} chars]`;
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parseCsv(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}
