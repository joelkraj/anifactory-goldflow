import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCb);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = Number(process.env.ANIFACTORY_MODELSLAB_IMAGEGEN_TIMEOUT_MS ?? 600000);
const width = Number(process.env.ANIFACTORY_MODELSLAB_IMAGE_WIDTH ?? 1024);
const height = Number(process.env.ANIFACTORY_MODELSLAB_IMAGE_HEIGHT ?? 576);
const fluxKleinStrength = Number(process.env.ANIFACTORY_FLUX_KLEIN_IMG2IMG_STRENGTH ?? 0.72);
const modelslabImageSamples = Math.min(2, Math.max(1, Number(process.env.ANIFACTORY_MODELSLAB_IMAGE_SAMPLES ?? 1) || 1));

export function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

let cachedModelslabApiKey = null;
async function modelslabApiKey() {
  if (cachedModelslabApiKey) return cachedModelslabApiKey;
  const fromEnv = process.env.MODELSLAB_API_KEY || process.env.API_KEY;
  if (fromEnv) {
    cachedModelslabApiKey = fromEnv;
    return cachedModelslabApiKey;
  }
  const { stdout: listStdout } = await execFile("modelslab", ["keys", "list", "-o", "json"], { cwd: repoRoot, maxBuffer: 1024 * 1024 });
  const list = JSON.parse(listStdout);
  const keys = list?.data?.items ?? [];
  const selected = keys.find((key) => key.is_default === 1 || key.is_default === true) ?? keys[0];
  if (!selected?.id) throw new Error("No ModelsLab API key available. Set MODELSLAB_API_KEY or login with the ModelsLab CLI.");
  const { stdout: getStdout } = await execFile("modelslab", ["keys", "get", "--id", String(selected.id), "-o", "json"], { cwd: repoRoot, maxBuffer: 1024 * 1024 });
  const detail = JSON.parse(getStdout);
  if (!detail?.data?.key) throw new Error(`ModelsLab key ${selected.id} did not return a key value.`);
  cachedModelslabApiKey = detail.data.key;
  return cachedModelslabApiKey;
}

async function postModelslabJson(endpoint, body, label, retries = 2) {
  const key = await modelslabApiKey();
  let lastError = null;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`https://modelslab.com${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, ...body }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`${label} returned non-JSON ${response.status}: ${text.slice(0, 600)}`);
      }
      if (json.status === "error" && /rate limit|queue|too many|try again/i.test(String(json.message ?? "")) && attempt <= retries) {
        await sleep(10_000 * attempt);
        continue;
      }
      if (!response.ok || json.status === "error" || json.status === "failed") {
        throw new Error(`${label} failed ${response.status}: ${JSON.stringify(json).slice(0, 1200)}`);
      }
      return json;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt <= retries) await sleep(4000 * attempt);
    }
  }
  throw lastError;
}

function modelslabOutputs(json) {
  return [
    ...(Array.isArray(json.output) ? json.output : []),
    ...(Array.isArray(json.proxy_links) ? json.proxy_links : []),
  ].filter(Boolean);
}

async function pollModelslabImage(fetchEndpoint, id, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const json = await postModelslabJson(`${fetchEndpoint}/${id}`, {}, `${label} fetch`, 1);
    if (json.status === "success" && modelslabOutputs(json).length) return json;
    if (json.status === "failed" || json.status === "error") throw new Error(`${label} failed while polling: ${JSON.stringify(json).slice(0, 1000)}`);
    await sleep(7000);
  }
  throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
}

async function resolveModelslabImage(json, fetchEndpoint, label) {
  if (json.status === "success" && modelslabOutputs(json).length) return json;
  if (json.id) return pollModelslabImage(fetchEndpoint, json.id, label);
  throw new Error(`${label} returned no output/id: ${JSON.stringify(json).slice(0, 1000)}`);
}

async function download(urls, outputPath) {
  let lastError = null;
  for (let round = 1; round <= 8; round += 1) {
    for (const url of urls) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(String(response.status));
        await ensureDir(path.dirname(outputPath));
        await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
        return url;
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(2500 * round);
  }
  throw lastError ?? new Error(`Could not download ModelsLab output for ${outputPath}`);
}

async function uploadModelslabReference(filePath, uploadDir) {
  const ext = path.extname(filePath).replace(".", "").toLowerCase() || "png";
  const mimeExt = ext === "jpg" ? "jpeg" : ext;
  await ensureDir(uploadDir);
  const base64 = (await fs.readFile(filePath)).toString("base64");
  const json = await postModelslabJson("/api/v6/base64_to_url", { base64_string: `data:image/${mimeExt};base64,${base64}` }, `upload ${path.basename(filePath)}`, 2);
  const url = modelslabOutputs(json)[0];
  if (!url) throw new Error(`ModelsLab upload returned no URL for ${filePath}`);
  return url;
}

export async function generateModelslabImage({
  prompt,
  outputPath,
  referenceImagePaths = [],
  model = process.env.ANIFACTORY_REFERENCE_MODEL || process.env.ANIFACTORY_IMAGE_MODEL || "flux-klein",
  width: requestedWidth = width,
  height: requestedHeight = height,
}) {
  const startedAtMs = Date.now();
  const outputDir = path.join(path.dirname(outputPath), ".modelslab-downloads", path.basename(outputPath, path.extname(outputPath)));
  const uploadDir = path.join(outputDir, "uploads");
  await ensureDir(outputDir);
  const referenceUrls = [];
  const maxReferences = model === "flux-klein" ? 4 : 8;
  for (const refPath of referenceImagePaths.slice(0, maxReferences)) referenceUrls.push(await uploadModelslabReference(refPath, uploadDir));
  const endpoint = referenceUrls.length ? "/api/v6/images/img2img" : "/api/v6/images/text2img";
  if (model === "flux-klein" && referenceUrls.length && endpoint !== "/api/v6/images/img2img") {
    throw new Error("flux-klein references require /api/v6/images/img2img; text2img would discard init_image references.");
  }
  const commonPayload = {
    model_id: model,
    prompt,
    width: requestedWidth,
    height: requestedHeight,
    samples: modelslabImageSamples,
    base64: false,
    track_id: `anifactory-${path.basename(outputPath, path.extname(outputPath))}`,
  };
  const payload = referenceUrls.length
    ? {
        ...commonPayload,
        init_image: referenceUrls,
        strength: model === "flux-klein" ? fluxKleinStrength : 0.72,
        enhance_prompt: false,
      }
    : { ...commonPayload };
  const initial = await postModelslabJson(endpoint, payload, `${model} image`, 2);
  const resolved = await resolveModelslabImage(initial, "/api/v6/images/fetch", `${model} image`);
  const imageUrl = await download(modelslabOutputs(resolved), outputPath);
  return {
    downloaded_path: outputPath,
    image_url: imageUrl,
    modelslab_output_dir: outputDir,
    modelslab_elapsed_ms: Date.now() - startedAtMs,
    modelslab_endpoint: endpoint,
    modelslab_reference_count: referenceUrls.length,
    modelslab_request_id: initial.id ?? resolved.id ?? null,
  };
}
