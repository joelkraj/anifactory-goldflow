import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createFalClient } from "@fal-ai/client";

export const FAL_ENDPOINTS = Object.freeze({
  primary_text: "openai/gpt-image-2.5/sunburst/text-to-image",
  primary_edit: "openai/gpt-image-2.5/sunburst/edit",
  seedream_repair: "bytedance/seedream/v5/lite/edit",
  nano_banana_repair: "fal-ai/nano-banana-2/edit",
});
export const FAL_PRIMARY_PARAMS = Object.freeze({
  quality: "low", image_size: Object.freeze({ width: 1920, height: 1080 }),
  output_format: "png", num_images: 1, background: "opaque", sync_mode: false,
});
export const FAL_EPISODE_BUDGET = Object.freeze({ warning_usd: 30, hard_usd: 35 });
export const FAL_PRIVATE_KEY_PATH = path.join(process.env.HOME ?? "", ".config/anifactory/fal_key");

const hash = (value) => createHash("sha256").update(value).digest("hex");
const timestamp = () => new Date().toISOString();
const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
function need(condition, message) { if (!condition) throw new Error(message); }
async function absent(file) { try { await fs.lstat(file); throw new Error(`Refusing to overwrite ${file}`); } catch (error) { if (error.code !== "ENOENT") throw error; } }
async function fileHash(file) { const digest = createHash("sha256"); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest("hex"); }
async function atomicJson(file, value) { await absent(file); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, jsonBytes(value), { flag: "wx" }); return { path: file, sha256: hash(jsonBytes(value)) }; }
function trustedMediaUrl(value) {
  const url = new URL(value);
  need(url.protocol === "https:" && /(^|\.)fal\.(media|ai)$/.test(url.hostname), "Fal returned an untrusted media URL.");
  return url;
}
function sanitized(value) {
  if (Array.isArray(value)) return value.map(sanitized);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(url|signed_url|authorization|credentials|key)$/i.test(key)).map(([key, item]) => [key, sanitized(item)]));
}
async function falCredential() {
  if (process.env.FAL_KEY?.trim()) return process.env.FAL_KEY.trim();
  const stat = await fs.stat(FAL_PRIVATE_KEY_PATH).catch(() => null);
  need(stat?.isFile() && (stat.mode & 0o077) === 0, "Fal private credential is missing or has unsafe permissions.");
  const key = (await fs.readFile(FAL_PRIVATE_KEY_PATH, "utf8")).trim();
  need(/^[^:\s]+:[^:\s]+$/.test(key), "Fal private credential is malformed.");
  return key;
}

export function buildFalImageInput({ prompt, referenceUrls = [], separateReferences = false } = {}) {
  need(typeof prompt === "string" && prompt.trim(), "Fal prompt is required.");
  need(Array.isArray(referenceUrls) && referenceUrls.length <= 16, "Fal supports at most sixteen references.");
  need(referenceUrls.every((url) => typeof url === "string" && /^https:\/\//.test(url)), "Fal references must be uploaded HTTPS URLs.");
  const endpoint = referenceUrls.length ? FAL_ENDPOINTS.primary_edit : FAL_ENDPOINTS.primary_text;
  const input = { prompt, ...structuredClone(FAL_PRIMARY_PARAMS), partial_images: 0 };
  if (!referenceUrls.length) delete input.partial_images;
  else input.image_urls = referenceUrls;
  return { endpoint, input, reference_mode: separateReferences ? "separate_ordered_references" : referenceUrls.length ? "one_positional_collage" : "text_only" };
}

function runJson(binary, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: { ...env, GENMEDIA_NO_ANALYTICS: "1", GENMEDIA_NO_GALLERY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("close", (code) => {
      if (code !== 0) return reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `genmedia exited ${code}`), { code: "fal_genmedia_failed" }));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("genmedia returned non-JSON output.")); }
    });
  });
}

export async function discoverFalContract({ outputDir, genmedia = path.join(process.env.HOME ?? "", ".local/bin/genmedia"), run = runJson } = {}) {
  need(path.isAbsolute(outputDir ?? ""), "Fal discovery needs an absolute output directory.");
  const credential = await falCredential();
  await fs.mkdir(outputDir, { recursive: true });
  const observedAt = timestamp();
  const endpoints = Object.values(FAL_ENDPOINTS);
  const [models, primarySchema, primaryPricing, seedreamSchema, nanoSchema] = await Promise.all([
    run(genmedia, ["models", "--endpoint_id", endpoints.join(","), "--limit", "10", "--expand", "openapi-3.0", "--json"], { ...process.env, FAL_KEY: credential }),
    run(genmedia, ["schema", FAL_ENDPOINTS.primary_edit, "--format", "openapi", "--json"], { ...process.env, FAL_KEY: credential }),
    run(genmedia, ["pricing", FAL_ENDPOINTS.primary_edit, "--json"], { ...process.env, FAL_KEY: credential }),
    run(genmedia, ["schema", FAL_ENDPOINTS.seedream_repair, "--format", "openapi", "--json"], { ...process.env, FAL_KEY: credential }),
    run(genmedia, ["schema", FAL_ENDPOINTS.nano_banana_repair, "--format", "openapi", "--json"], { ...process.env, FAL_KEY: credential }),
  ]);
  const snapshots = {};
  for (const [name, value] of Object.entries({ models, primary_schema: primarySchema, primary_pricing: primaryPricing, seedream_schema: seedreamSchema, nano_banana_schema: nanoSchema })) {
    snapshots[name] = await atomicJson(path.join(outputDir, `${name}.json`), sanitized(value));
  }
  const strings = JSON.stringify({ models, primarySchema, primaryPricing, seedreamSchema, nanoSchema });
  for (const endpoint of endpoints) need(strings.includes(endpoint), `Live discovery did not contain ${endpoint}.`);
  const schemaExpansionSucceeded = ![primarySchema, seedreamSchema, nanoSchema].some((row) => row?.error?.code === "expansion_failed");
  if (schemaExpansionSucceeded) for (const required of ["low", "quality", "image_urls", "output_format", "png", "image_size"]) need(strings.includes(required), `Live Sunburst schema lacks ${required}.`);
  const record = {
    schema: "goldflow_fal_discovery_v1", observed_at: observedAt, genmedia_binary: genmedia,
    endpoints: FAL_ENDPOINTS, primary_params: FAL_PRIMARY_PARAMS, maximum_primary_references: 16,
    snapshots, schema_expansion_succeeded: schemaExpansionSucceeded,
    schema_verification: schemaExpansionSucceeded ? "live_genmedia_openapi" : "live_catalog_plus_exact_paid_probe_required",
    credentials_persisted: false, signed_urls_persisted: false,
  };
  return { ...record, receipt: await atomicJson(path.join(outputDir, "discovery.json"), record) };
}

export async function uploadFalReference({ localPath, expectedSha256, receiptPath, client } = {}) {
  need(path.isAbsolute(localPath ?? "") && /^[a-f0-9]{64}$/.test(expectedSha256 ?? ""), "Fal upload requires an absolute hash-bound file.");
  need(await fileHash(localPath) === expectedSha256, "Fal upload input hash changed.");
  const bytes = await fs.readFile(localPath); const metadata = await sharp(bytes).metadata();
  need(metadata.width && metadata.height && ["png", "jpeg", "webp"].includes(metadata.format), "Fal upload input is not a readable image.");
  const fal = client ?? createFalClient({ credentials: await falCredential() });
  const mime = metadata.format === "png" ? "image/png" : metadata.format === "jpeg" ? "image/jpeg" : "image/webp";
  const remoteUrl = await fal.storage.upload(new Blob([bytes], { type: mime }), { lifecycle: { expiresIn: "7d" } });
  trustedMediaUrl(remoteUrl);
  const record = { schema: "goldflow_fal_upload_receipt_v1", created_at: timestamp(), local_path: localPath, sha256: expectedSha256, width: metadata.width, height: metadata.height, mime_type: mime, remote_url_sha256: hash(remoteUrl), remote_url_persisted: false };
  return { remoteUrl, record, receipt: await atomicJson(receiptPath, record) };
}

export async function submitFalImage({ assignment, referenceUrls = [], receiptPath, client } = {}) {
  need(assignment?.image_id && assignment?.assignment_sha256 && assignment?.run_identity_sha256 && assignment?.prompt_sha256 === hash(assignment.prompt ?? ""), "Fal assignment binding is invalid.");
  need(Number.isFinite(assignment.max_cost_usd) && assignment.max_cost_usd > 0, "Fal assignment needs a positive cost ceiling.");
  const request = buildFalImageInput({ prompt: assignment.prompt, referenceUrls, separateReferences: assignment.reference_mode === "separate_ordered_references" });
  need(request.endpoint === assignment.endpoint, "Fal assignment endpoint changed.");
  const fal = client ?? createFalClient({ credentials: await falCredential() });
  const submittedAt = timestamp();
  const response = await fal.queue.submit(request.endpoint, { input: request.input });
  const requestId = response?.request_id ?? response?.requestId;
  need(typeof requestId === "string" && requestId, "Fal returned no request ID.");
  const record = {
    schema: "goldflow_fal_submission_receipt_v1", submitted_at: submittedAt, image_id: assignment.image_id,
    assignment_sha256: assignment.assignment_sha256, run_identity_sha256: assignment.run_identity_sha256,
    endpoint: request.endpoint, prompt_sha256: assignment.prompt_sha256, params: FAL_PRIMARY_PARAMS,
    reference_mode: request.reference_mode, reference_hashes: assignment.reference_hashes,
    remote_reference_url_hashes: referenceUrls.map(hash), request_id: requestId,
    max_cost_usd: assignment.max_cost_usd, automatic_creative_retry: false, automatic_failover: false,
  };
  return { requestId, record, receipt: await atomicJson(receiptPath, record) };
}

export async function observeFalImage({ endpoint, requestId, outputPath, receiptPath, client, fetchImpl = fetch } = {}) {
  need(Object.values(FAL_ENDPOINTS).includes(endpoint) && typeof requestId === "string" && requestId, "Exact Fal endpoint and request ID are required.");
  const fal = client ?? createFalClient({ credentials: await falCredential() });
  const status = await fal.queue.status(endpoint, { requestId, logs: false });
  if (status?.status !== "COMPLETED") return { complete: false, status: sanitized(status) };
  const result = await fal.queue.result(endpoint, { requestId });
  const images = result?.data?.images ?? result?.images ?? [];
  need(images.length === 1 && images[0]?.url, "Fal result must contain exactly one image.");
  const mediaUrl = trustedMediaUrl(images[0].url);
  const response = await fetchImpl(mediaUrl, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  need(response.ok, `Fal output download failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer()); const metadata = await sharp(bytes).metadata();
  need(metadata.width === 1920 && [1072, 1080].includes(metadata.height) && metadata.format === "png", `Fal output has unexpected raster ${metadata.width}x${metadata.height} ${metadata.format}.`);
  const rawPath = outputPath.replace(/\.png$/i, ".provider.png");
  await absent(rawPath); await absent(outputPath); await fs.mkdir(path.dirname(outputPath), { recursive: true }); await fs.writeFile(rawPath, bytes, { flag: "wx" });
  const normalized = metadata.height === 1080 ? bytes : await sharp(bytes).resize(1920, 1080, { fit: "fill" }).png().toBuffer();
  const normalizedMetadata = await sharp(normalized).metadata();
  need(normalizedMetadata.width === 1920 && normalizedMetadata.height === 1080 && normalizedMetadata.format === "png", "Fal normalization failed to produce the locked raster.");
  await fs.writeFile(outputPath, normalized, { flag: "wx" });
  const record = { schema: "goldflow_fal_result_receipt_v1", completed_at: timestamp(), endpoint, request_id: requestId,
    provider_output_path: rawPath, provider_output_sha256: hash(bytes), provider_width: metadata.width, provider_height: metadata.height, provider_format: metadata.format,
    normalization: metadata.height === 1080 ? "none" : "resize_1920x1072_to_1920x1080_png",
    output_path: outputPath, output_sha256: hash(normalized), width: normalizedMetadata.width, height: normalizedMetadata.height, format: normalizedMetadata.format,
    source_url_sha256: hash(images[0].url), source_url_persisted: false, provider_metadata: sanitized(result) };
  return { complete: true, record, receipt: await atomicJson(receiptPath, record) };
}

export { fileHash as falFileSha256, hash as falObjectSha256 };
