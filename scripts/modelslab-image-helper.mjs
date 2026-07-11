import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { isModelslabCreditExhaustion } from "./lib/image-fallback-policy.mjs";

const execFile = promisify(execFileCb);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = Number(process.env.ANIFACTORY_MODELSLAB_IMAGEGEN_TIMEOUT_MS ?? 600000);
const width = Number(process.env.ANIFACTORY_MODELSLAB_IMAGE_WIDTH ?? 1024);
const height = Number(process.env.ANIFACTORY_MODELSLAB_IMAGE_HEIGHT ?? 576);
const fluxKleinStrength = Number(process.env.ANIFACTORY_FLUX_KLEIN_IMG2IMG_STRENGTH ?? 0.72);
const fluxKleinGuidanceScale = Number(process.env.ANIFACTORY_FLUX_KLEIN_GUIDANCE_SCALE ?? 3.5);
const modelslabImageSamples = Math.min(2, Math.max(1, Number(process.env.ANIFACTORY_MODELSLAB_IMAGE_SAMPLES ?? 1) || 1));
const gptImage2Size = String(process.env.ANIFACTORY_MODELSLAB_GPT_IMAGE2_SIZE ?? "2048x1152").trim();
const gptImage2AllowSquareFallback = process.env.ANIFACTORY_MODELSLAB_GPT_IMAGE2_ALLOW_SQUARE_FALLBACK === "true";

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
  const { stdout: listStdout } = await execFile("modelslab", ["keys", "list", "-o", "json", "--no-color", "--no-update-check"], { cwd: repoRoot, maxBuffer: 1024 * 1024 });
  const list = JSON.parse(listStdout);
  const keys = list?.data?.items ?? [];
  const selected = keys.find((key) => key.is_default === 1 || key.is_default === true) ?? keys[0];
  if (!selected?.id) throw new Error("No ModelsLab API key available. Set MODELSLAB_API_KEY or login with the ModelsLab CLI.");
  const { stdout: getStdout } = await execFile("modelslab", ["keys", "get", "--id", String(selected.id), "-o", "json", "--no-color", "--no-update-check"], { cwd: repoRoot, maxBuffer: 1024 * 1024 });
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
      if (isModelslabCreditExhaustion(error instanceof Error ? error.message : error)) throw error;
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

function isGptImage2Model(model) {
  return /^gpt[-_]?image[-_]?2/i.test(String(model ?? ""));
}

function gptImage2ModelForRequest(model, referenceCount) {
  if (!isGptImage2Model(model)) return model;
  if (referenceCount > 0) return "gpt-image-2-i2i";
  return "gpt-image-2-t2i";
}

function gptImage2OutputSize() {
  const supported = new Set([
    "1536x1024",
    "2048x1152",
    "3840x2160",
  ]);
  const normalized = gptImage2Size.replace(/\s+/g, "");
  return supported.has(normalized) ? normalized : "2048x1152";
}

function prepareGptImage2Prompt(prompt) {
  const text = String(prompt ?? "").trim();
  return {
    prompt: text,
    compacted: false,
    original_length: text.length,
    submitted_length: text.length,
  };
}

export function prepareGptImage2PromptForTests(prompt) {
  return prepareGptImage2Prompt(prompt);
}

export function gptImage2OutputSizeForTests() {
  return gptImage2OutputSize();
}

function estimatedModelslabCost(model) {
  const normalized = String(model ?? "").trim().toLowerCase();
  if (isGptImage2Model(normalized)) {
    return {
      estimated_cost_usd: 0.08,
      cost_basis: "modelslab_model_detail_info_per_image_2026-07-09",
      cost_confidence: "dashboard_confirmed",
    };
  }
  if (normalized === "flux-klein" || normalized === "midjourney" || normalized.includes("diffusion") || normalized.includes("flux")) {
    return {
      estimated_cost_usd: 0.0047,
      cost_basis: "modelslab_catalog_model_price_per_generation",
      cost_confidence: "catalog",
    };
  }
  return {
    estimated_cost_usd: null,
    cost_basis: "unknown_model_price",
    cost_confidence: "unknown",
  };
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

async function assertLandscapeOutput(outputPath, requestedWidth, requestedHeight) {
  const metadata = await sharp(outputPath).metadata();
  const actualWidth = Number(metadata.width ?? 0);
  const actualHeight = Number(metadata.height ?? 0);
  if (!(actualWidth > 0 && actualHeight > 0)) {
    throw new Error(`ModelsLab output has unreadable dimensions: ${outputPath}`);
  }
  const actualAspect = actualWidth / actualHeight;
  const requestedAspect = requestedWidth / requestedHeight;
  if (actualWidth <= actualHeight || Math.abs(actualAspect - requestedAspect) > 0.08) {
    throw new Error(
      `ModelsLab returned non-landscape output for ${outputPath}: ` +
      `${actualWidth}x${actualHeight}, requested ${requestedWidth}x${requestedHeight}. ` +
      "Retry the cut; do not render portrait or square frames into the 16:9 YouTube lane.",
    );
  }
  return {
    actual_width: actualWidth,
    actual_height: actualHeight,
    actual_aspect: Number(actualAspect.toFixed(6)),
  };
}

async function fitOutputToRequestedLandscape(outputPath, requestedWidth, requestedHeight) {
  const metadata = await sharp(outputPath).metadata();
  const actualWidth = Number(metadata.width ?? 0);
  const actualHeight = Number(metadata.height ?? 0);
  if (!(actualWidth > 0 && actualHeight > 0) || !(requestedWidth > requestedHeight)) return false;
  const actualAspect = actualWidth / actualHeight;
  const requestedAspect = requestedWidth / requestedHeight;
  if (actualWidth > actualHeight && Math.abs(actualAspect - requestedAspect) <= 0.08) return false;

  const original = await fs.readFile(outputPath);
  const background = await sharp(original)
    .resize({ width: requestedWidth, height: requestedHeight, fit: "cover" })
    .blur(18)
    .modulate({ brightness: 0.82, saturation: 0.85 })
    .png()
    .toBuffer();
  const foreground = await sharp(original)
    .resize({ width: requestedWidth, height: requestedHeight, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp(background)
    .composite([{ input: foreground, gravity: "center" }])
    .png()
    .toFile(`${outputPath}.landscape-fit.tmp.png`);
  await fs.rename(`${outputPath}.landscape-fit.tmp.png`, outputPath);
  return true;
}

async function imageGeometry(outputPath) {
  const metadata = await sharp(outputPath).metadata();
  const actualWidth = Number(metadata.width ?? 0);
  const actualHeight = Number(metadata.height ?? 0);
  if (!(actualWidth > 0 && actualHeight > 0)) {
    throw new Error(`ModelsLab output has unreadable native dimensions: ${outputPath}`);
  }
  return {
    width: actualWidth,
    height: actualHeight,
    aspect: Number((actualWidth / actualHeight).toFixed(6)),
  };
}

async function prepareReferenceForUpload(filePath, uploadDir, {
  width: requestedWidth = width,
  height: requestedHeight = height,
} = {}) {
  if (!(requestedWidth > requestedHeight)) return filePath;
  const preparedDir = path.join(uploadDir, "prepared_landscape_refs");
  await ensureDir(preparedDir);
  const preparedPath = path.join(preparedDir, `${path.basename(filePath, path.extname(filePath))}-${requestedWidth}x${requestedHeight}.png`);
  await sharp(filePath)
    .resize({
      width: requestedWidth,
      height: requestedHeight,
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toFile(preparedPath);
  return preparedPath;
}

async function uploadModelslabReference(filePath, uploadDir, geometry = {}) {
  const uploadPath = await prepareReferenceForUpload(filePath, uploadDir, geometry);
  const ext = path.extname(uploadPath).replace(".", "").toLowerCase() || "png";
  const mimeExt = ext === "jpg" ? "jpeg" : ext;
  await ensureDir(uploadDir);
  const base64 = (await fs.readFile(uploadPath)).toString("base64");
  const json = await postModelslabJson("/api/v6/base64_to_url", { base64_string: `data:image/${mimeExt};base64,${base64}` }, `upload ${path.basename(uploadPath)}`, 2);
  const url = modelslabOutputs(json)[0];
  if (!url) throw new Error(`ModelsLab upload returned no URL for ${uploadPath}`);
  return url;
}

export async function generateModelslabImage({
  prompt,
  outputPath,
  referenceImagePaths = [],
  model = process.env.ANIFACTORY_REFERENCE_MODEL || process.env.ANIFACTORY_IMAGE_MODEL || "flux-klein",
  width: requestedWidth = width,
  height: requestedHeight = height,
  enhancePrompt = false,
}) {
  const startedAtMs = Date.now();
  const outputDir = path.join(path.dirname(outputPath), ".modelslab-downloads", path.basename(outputPath, path.extname(outputPath)));
  const uploadDir = path.join(outputDir, "uploads");
  await ensureDir(outputDir);
  const referenceUrls = [];
  const maxReferences = 4;
  for (const refPath of referenceImagePaths.slice(0, maxReferences)) {
    referenceUrls.push(await uploadModelslabReference(refPath, uploadDir, { width: requestedWidth, height: requestedHeight }));
  }
  if (isGptImage2Model(model)) {
    const selectedModel = gptImage2ModelForRequest(model, referenceUrls.length);
    const endpoint = referenceUrls.length ? "/api/v7/images/image-to-image" : "/api/v7/images/text-to-image";
    const submittedPrompt = prepareGptImage2Prompt(prompt);
    const payload = {
      model_id: selectedModel,
      prompt: submittedPrompt.prompt,
      size: gptImage2OutputSize(),
      track_id: `anifactory-${path.basename(outputPath, path.extname(outputPath))}`,
      ...(referenceUrls.length ? { init_image: referenceUrls } : {}),
    };
    const initial = await postModelslabJson(endpoint, payload, `${selectedModel} image`, 2);
    const resolved = await resolveModelslabImage(initial, "/api/v7/images/fetch", `${selectedModel} image`);
    const imageUrl = await download(modelslabOutputs(resolved), outputPath);
    const nativeGeometry = await imageGeometry(outputPath);
    const requestedAspect = requestedWidth / requestedHeight;
    const nativeLandscape = nativeGeometry.width > nativeGeometry.height;
    const nativeAspectMatch = Math.abs(nativeGeometry.aspect - requestedAspect) <= 0.08;
    if (!nativeLandscape && !gptImage2AllowSquareFallback) {
      throw new Error(
        `GPT Image 2 returned square or portrait output ${nativeGeometry.width}x${nativeGeometry.height} ` +
        `for requested provider size ${payload.size}. Retry native landscape; set ` +
        `ANIFACTORY_MODELSLAB_GPT_IMAGE2_ALLOW_SQUARE_FALLBACK=true only after a documented landscape failure.`,
      );
    }
    const landscape_fit_applied = nativeAspectMatch
      ? false
      : await fitOutputToRequestedLandscape(outputPath, requestedWidth, requestedHeight);
    const actualGeometry = await assertLandscapeOutput(outputPath, requestedWidth, requestedHeight);
    return {
      downloaded_path: outputPath,
      image_url: imageUrl,
      requested_width: requestedWidth,
      requested_height: requestedHeight,
      ...actualGeometry,
      modelslab_output_dir: outputDir,
      modelslab_elapsed_ms: Date.now() - startedAtMs,
      modelslab_endpoint: endpoint,
      modelslab_reference_count: referenceUrls.length,
      modelslab_request_id: initial.id ?? resolved.id ?? null,
      modelslab_model_id: selectedModel,
      modelslab_size: payload.size,
      modelslab_native_width: nativeGeometry.width,
      modelslab_native_height: nativeGeometry.height,
      modelslab_native_aspect: nativeGeometry.aspect,
      modelslab_native_landscape: nativeLandscape,
      modelslab_native_aspect_match: nativeAspectMatch,
      modelslab_landscape_fit_applied: landscape_fit_applied,
      modelslab_square_fallback_allowed: gptImage2AllowSquareFallback,
      modelslab_submitted_prompt: submittedPrompt.prompt,
      modelslab_prompt_compacted: submittedPrompt.compacted,
      modelslab_original_prompt_length: submittedPrompt.original_length,
      modelslab_submitted_prompt_length: submittedPrompt.submitted_length,
      ...estimatedModelslabCost(selectedModel),
    };
  }
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
    enhance_prompt: Boolean(enhancePrompt),
    guidance_scale: model === "flux-klein" ? fluxKleinGuidanceScale : Number(process.env.ANIFACTORY_MODELSLAB_IMAGE_GUIDANCE_SCALE ?? 3.5),
    track_id: `anifactory-${path.basename(outputPath, path.extname(outputPath))}`,
  };
  const payload = referenceUrls.length
    ? {
        ...commonPayload,
        init_image: referenceUrls,
        strength: model === "flux-klein" ? fluxKleinStrength : 0.72,
      }
    : { ...commonPayload };
  const initial = await postModelslabJson(endpoint, payload, `${model} image`, 2);
  const resolved = await resolveModelslabImage(initial, "/api/v6/images/fetch", `${model} image`);
  const imageUrl = await download(modelslabOutputs(resolved), outputPath);
  const actualGeometry = await assertLandscapeOutput(outputPath, requestedWidth, requestedHeight);
  return {
    downloaded_path: outputPath,
    image_url: imageUrl,
    requested_width: requestedWidth,
    requested_height: requestedHeight,
    ...actualGeometry,
    modelslab_output_dir: outputDir,
    modelslab_elapsed_ms: Date.now() - startedAtMs,
    modelslab_endpoint: endpoint,
    modelslab_reference_count: referenceUrls.length,
    modelslab_request_id: initial.id ?? resolved.id ?? null,
    modelslab_model_id: model,
    ...estimatedModelslabCost(model),
  };
}
