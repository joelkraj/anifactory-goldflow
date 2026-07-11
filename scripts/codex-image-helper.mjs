import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  configuredCodexModel,
  configuredCodexReasoningEffort,
  resolveCodexRuntime,
} from "./lib/codex-cli-runner.mjs";

const execFile = promisify(execFileCb);
const supportedImageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const timeoutMs = Number(process.env.ANIFACTORY_CODEX_IMAGEGEN_TIMEOUT_MS ?? 600000);

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function generatedImagesDir() {
  return path.join(codexHome(), "generated_images");
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function parseCodexSessionId(text) {
  return String(text ?? "").match(/session\s+id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] ?? null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function extractJson(text) {
  const raw = String(text ?? "").trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  return null;
}

async function listGeneratedImageCandidates(root, jobStartTimeMs) {
  const candidates = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!supportedImageExtensions.has(extension)) continue;
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile() || stat.size <= 0) continue;
      const createdAtMs = Math.max(stat.birthtimeMs || 0, stat.ctimeMs || 0, stat.mtimeMs || 0);
      if (createdAtMs + 1000 < jobStartTimeMs) continue;
      if (/mock|placeholder/i.test(path.basename(filePath))) continue;
      candidates.push({ sourcePath: filePath, extension, sizeBytes: stat.size, createdAtMs, modifiedAtMs: stat.mtimeMs });
    }
  }
  await walk(root);
  return candidates.sort((a, b) => b.createdAtMs - a.createdAtMs || b.modifiedAtMs - a.modifiedAtMs);
}

async function verifyRasterImage(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!supportedImageExtensions.has(extension)) throw new Error(`Unsupported generated image extension: ${extension}`);
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`Generated image is missing or empty: ${filePath}`);
  if (/mock|placeholder/i.test(path.basename(filePath))) throw new Error(`Generated image appears to be a mock/placeholder: ${filePath}`);
  if (extension !== ".png") return;
  const file = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(8);
    await file.read(buffer, 0, 8, 0);
    if (!buffer.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error(`Generated PNG failed magic-byte validation: ${filePath}`);
    }
  } finally {
    await file.close();
  }
}

async function readPngDimensions(filePath) {
  if (path.extname(filePath).toLowerCase() !== ".png") return null;
  const file = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(24);
    await file.read(buffer, 0, 24, 0);
    if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height, aspect_ratio: Number((width / height).toFixed(4)) };
  } finally {
    await file.close();
  }
}

function buildCodexPrompt(prompt, referenceImagePaths) {
  const referenceLedger = referenceImagePaths.map((imagePath, index) => `- Image ${index + 1}: ${path.basename(imagePath)} (${imagePath})`).join("\n");
  const referenceRules = referenceImagePaths.length
    ? `\nReference usage:\n${referenceLedger}\n- Follow the prompt's attached reference slot instructions exactly.\n- Character references are face/identity anchors only unless the prompt explicitly says wardrobe/body should match.\n- The current prompt controls body state, grooming, outfit, action, location, emotion, and composition.\n- Do not copy extra people, alternate poses, panel layouts, backgrounds, or text from references.\n`
    : "";
  return `Use built-in image generation to create exactly one real raster image for this AniFactory video cut.

Prompt:
${prompt}
${referenceRules}
Image requirements:
- 16:9 landscape still for 1920x1080 video.
- Bright vibrant anime/manhwa styling, clean line art, cinematic lighting, polished color.
- No photorealism, no 3D render, no western comic style, no surreal corporate blue wash unless explicitly requested.
- No speech bubbles, no subtitles, no readable watermark, no UI text unless the prompt explicitly requires a UI insert.
- Generate the image with the built-in image generation tool; do not answer from text alone, do not write project files yourself, and do not report success unless the image tool actually produced a raster file.
- Leave the generated image in CODEX_HOME/generated_images so the caller can import it.

Return exactly one JSON object after generation:
{ "status": "success", "message": "image generation completed", "model": "observable model or unknown" }

If image generation is unavailable or rate-limited, return:
{ "status": "unavailable", "message": "brief reason" } or { "status": "rate_limited", "message": "brief reason" }`;
}

export async function generateCodexImage({ prompt, outputPath, referenceImagePaths = [], allowGlobalFallback = false }) {
  const jobStartTimeMs = Date.now();
  const runDir = path.join(path.dirname(outputPath), ".codex-imagegen", path.basename(outputPath, path.extname(outputPath)));
  await ensureDir(runDir);
  const stamp = `${Date.now()}-${sha256(prompt).slice(0, 12)}`;
  const promptPath = path.join(runDir, `${stamp}-prompt.txt`);
  const outputLogPath = path.join(runDir, `${stamp}-output.txt`);
  const codexPrompt = buildCodexPrompt(prompt, referenceImagePaths);
  await fs.writeFile(promptPath, codexPrompt, "utf8");
  const imageArgs = [];
  for (const imagePath of referenceImagePaths.slice(0, 4)) {
    if (!(await exists(imagePath))) throw new Error(`Missing Codex image reference: ${imagePath}`);
    imageArgs.push("--image", shellQuote(imagePath));
  }
  const orchestratorModel = configuredCodexModel(process.env.ANIFACTORY_CODEX_IMAGEGEN_ORCHESTRATOR_MODEL ?? null);
  const orchestratorReasoningEffort = configuredCodexReasoningEffort(process.env.ANIFACTORY_CODEX_IMAGEGEN_REASONING_EFFORT ?? null);
  const codexRuntime = await resolveCodexRuntime({ model: orchestratorModel });
  const command = [
    shellQuote(codexRuntime.executable),
    "exec",
    "--enable",
    "image_generation",
    "--skip-git-repo-check",
    "-C",
    shellQuote(process.cwd()),
    "-m",
    shellQuote(orchestratorModel),
    "-c",
    shellQuote(`model_reasoning_effort="${orchestratorReasoningEffort}"`),
    "--sandbox",
    "read-only",
    "--add-dir",
    shellQuote(path.dirname(outputPath)),
    "--add-dir",
    "/Users/joel/AniFactoryData",
    ...imageArgs,
    "-o",
    '"$ANIFACTORY_CODEX_IMAGEGEN_OUTPUT_FILE"',
    '< "$ANIFACTORY_CODEX_IMAGEGEN_PROMPT_FILE"',
  ].join(" ");
  const { stdout, stderr } = await execFile("bash", ["-lc", command], {
    cwd: process.cwd(),
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      NO_COLOR: "1",
      ANIFACTORY_CODEX_IMAGEGEN_PROMPT_FILE: promptPath,
      ANIFACTORY_CODEX_IMAGEGEN_OUTPUT_FILE: outputLogPath,
    },
  });
  const outputLog = await fs.readFile(outputLogPath, "utf8").catch(() => "");
  const combinedOutput = [stdout, stderr, outputLog].filter(Boolean).join("\n");
  const parsed = extractJson(outputLog || stdout || stderr);
  const status = String(parsed?.status ?? "success").toLowerCase();
  if (status === "rate_limited" || /usage limit|rate limit/i.test(combinedOutput)) throw new Error(parsed?.message ?? "Codex image generation is rate-limited");
  if (status === "unavailable" || status === "failed") throw new Error(parsed?.message ?? `Codex image generation returned ${status}`);
  const sessionId = parseCodexSessionId(combinedOutput);
  if (!sessionId && !allowGlobalFallback) {
    throw new Error(`Codex image generation completed but no session id was found; refusing global import during concurrent-safe run. Log: ${outputLogPath}`);
  }
  const searchRoot = sessionId ? path.join(generatedImagesDir(), sessionId) : generatedImagesDir();
  const candidates = await listGeneratedImageCandidates(searchRoot, jobStartTimeMs);
  if (!candidates.length) throw new Error(`Codex image generation completed but no generated raster image was found under ${searchRoot}. Log: ${outputLogPath}`);
  const chosen = candidates[0];
  await verifyRasterImage(chosen.sourcePath);
  await ensureDir(path.dirname(outputPath));
  await fs.copyFile(chosen.sourcePath, outputPath);
  await verifyRasterImage(outputPath);
  return {
    downloaded_path: outputPath,
    codex_source_path: chosen.sourcePath,
    codex_output_path: outputLogPath,
    codex_prompt_path: promptPath,
    codex_elapsed_ms: Date.now() - jobStartTimeMs,
    codex_session_id: sessionId,
    codex_import_selection_mode: sessionId ? "session_folder" : "global_job_start_time_fallback",
    codex_reference_count: referenceImagePaths.length,
    codex_orchestrator_model: orchestratorModel,
    codex_orchestrator_reasoning_effort: orchestratorReasoningEffort,
    codex_cli_path: codexRuntime.executable,
    codex_cli_version: codexRuntime.version,
    model: parsed?.model ?? "codex_image_generation",
    source_dimensions: await readPngDimensions(chosen.sourcePath),
    output_dimensions: await readPngDimensions(outputPath),
  };
}
