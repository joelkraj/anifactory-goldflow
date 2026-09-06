import { createHash, randomUUID } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { sha256File } from "./file-hash.mjs";

export const FOOTAGE_SOURCE_SCHEMA = "goldflow_footage_source_v1";
export const FOOTAGE_CLIP_SCHEMA = "goldflow_footage_clip_v1";
export const FOOTAGE_SEARCH_SCHEMA = "goldflow_footage_search_v1";
export const FOOTAGE_ENCODING_CONTRACT = "h264_yuv420p_silent_3_to_5_seconds_v1";
export const footageHash = (value) => createHash("sha256").update(
  typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value),
).digest("hex");

export function footageLibraryRoot(value, env = process.env) {
  let root = path.resolve(value ?? path.join(env.ANIFACTORY_DATA_ROOT || path.join(os.homedir(), "AniFactoryData"), "footage_library"));
  // Resolve the nearest existing ancestor so a symlink cannot disguise an
  // episode directory, even when the requested leaf does not exist yet.
  let ancestor = root;
  const suffix = [];
  for (;;) {
    try { root = path.join(realpathSync(ancestor), ...suffix); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  if (root.split(path.sep).includes("episodes")) throw new Error("Footage development artifacts must stay outside production episode directories.");
  return root;
}

export async function readFootageJson(filePath, maxBytes = 10 * 1024 * 1024) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error("Footage artifact is not a regular file within the size limit.");
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch { throw new Error("Footage artifact is not valid JSON."); }
}

// Atomic, no-clobber publication, including competing processes and reruns.
export async function writeImmutableFootageJson(filePath, value) {
  footageLibraryRoot(filePath);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  footageLibraryRoot(filePath);
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    await fs.link(temporary, filePath);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (await fs.readFile(filePath, "utf8") !== bytes) {
      throw new Error("Refusing to overwrite an existing footage artifact with different content.");
    }
  } finally {
    await fs.unlink(temporary);
  }
  return filePath;
}

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 2000 || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`${label} must be nonempty single-line text, at most 2000 characters.`);
  }
  return value.trim();
}

export function createFootageSource({ identity, title, edition, rightsNote }) {
  if (!["torbox", "real_debrid", "local"].includes(identity.provider)) throw new Error("Unknown footage source provider.");
  if (!Number.isSafeInteger(identity.bytes) || identity.bytes <= 0) throw new Error("A source needs a known positive file size.");
  if (identity.provider !== "local" && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(identity.source_hash ?? "")) {
    throw new Error("Remote registration requires a provider-reported content hash; ambiguous file identity is not accepted.");
  }
  const core = {
    schema: FOOTAGE_SOURCE_SCHEMA,
    provider: identity.provider,
    source_id: nonempty(identity.source_id == null ? "" : String(identity.source_id), "Source ID"),
    file_id: nonempty(identity.file_id == null ? "" : String(identity.file_id), "File ID"),
    source_hash: identity.source_hash ?? null,
    filename: nonempty(identity.filename, "Source filename"),
    bytes: identity.bytes,
    ...(identity.provider === "local" ? { local_path: identity.local_path, local_sha256: identity.local_sha256 } : {}),
    title: nonempty(title, "Title"),
    edition: nonempty(edition, "Exact release/edition"),
    rights: { operator_confirmed: true, note: nonempty(rightsNote, "Rights note") },
  };
  const source = { ...core, id: `src_${footageHash(core).slice(0, 24)}` };
  return { ...source, manifest_sha256: footageHash(source) };
}

export async function readFootageSource(filePath) {
  const value = await readFootageJson(filePath);
  const { manifest_sha256: digest, ...body } = value;
  if (value.schema !== FOOTAGE_SOURCE_SCHEMA || footageHash(body) !== digest) throw new Error("Source manifest is malformed or its hash is stale. Register a new source; do not hand-edit it.");
  const rebuilt = createFootageSource({ identity: value, title: value.title, edition: value.edition, rightsNote: value.rights?.note });
  if (JSON.stringify(rebuilt) !== JSON.stringify(value)) throw new Error("Source manifest has unknown fields or an invalid identity.");
  if (value.provider === "local") {
    if (!path.isAbsolute(value.local_path ?? "") || !/^[a-f0-9]{64}$/u.test(value.local_sha256 ?? "")) throw new Error("Invalid local source identity.");
  }
  return value;
}

export async function validateLocalFootageSource(source) {
  const stat = await fs.stat(source.local_path);
  if (!stat.isFile() || stat.size !== source.bytes || await sha256File(source.local_path) !== source.local_sha256) {
    throw new Error("Local source changed since registration. Register the new exact file before clipping.");
  }
}

export function validateResolvedFootageSource(source, resolved) {
  if (resolved.provider !== source.provider
    || String(resolved.source_id) !== source.source_id
    || String(resolved.file_id) !== source.file_id
    || resolved.source_hash !== source.source_hash
    || resolved.bytes !== source.bytes
    || resolved.filename !== source.filename) {
    throw new Error("Provider source no longer matches the registered exact file. No edition or provider substitution is allowed.");
  }
}

export function footageClipIdentity(source, startSec, durationSec, subtitleEvidence = null) {
  if (!Number.isFinite(startSec) || startSec < 0 || !Number.isFinite(durationSec) || durationSec < 3 || durationSec > 5) {
    throw new Error("Clip start must be nonnegative and duration must be between 3 and 5 seconds.");
  }
  return {
    source_manifest_sha256: source.manifest_sha256,
    start_sec: startSec,
    duration_sec: durationSec,
    encoding_contract: FOOTAGE_ENCODING_CONTRACT,
    subtitle_evidence: subtitleEvidence,
  };
}

export async function validateFootageClipReceipt(receiptPath) {
  const receipt = await readFootageJson(receiptPath);
  const { receipt_sha256: digest, ...body } = receipt;
  if (receipt.schema !== FOOTAGE_CLIP_SCHEMA || footageHash(body) !== digest
    || !/^[a-f0-9]{64}$/u.test(receipt.clip_sha256 ?? "")
    || !/^[a-f0-9]{64}$/u.test(receipt.source_manifest_sha256 ?? "")
    || receipt.request?.source_manifest_sha256 !== receipt.source_manifest_sha256
    || receipt.request?.encoding_contract !== FOOTAGE_ENCODING_CONTRACT
    || receipt.id !== `clip_${footageHash(receipt.request)}`
    || !Number.isFinite(receipt.request?.start_sec) || receipt.request.start_sec < 0
    || !Number.isFinite(receipt.request?.duration_sec) || receipt.request.duration_sec < 3 || receipt.request.duration_sec > 5
    || !Number.isSafeInteger(receipt.width) || receipt.width <= 0
    || !Number.isSafeInteger(receipt.height) || receipt.height <= 0
    || receipt.production_eligible !== false
    || !Number.isFinite(receipt.actual_duration_sec)
    || Math.abs(receipt.actual_duration_sec - receipt.request?.duration_sec) > 0.15) {
    throw new Error("Clip receipt is malformed or stale.");
  }
  // Never follow a receipt-supplied external asset path during review/reuse.
  const clipPath = path.join(path.dirname(receiptPath), "clip.mp4");
  if (await sha256File(clipPath) !== receipt.clip_sha256) throw new Error("Cached clip bytes no longer match their receipt.");
  return { receipt, clipPath };
}
