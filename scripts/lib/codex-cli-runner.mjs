import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { runChatGptWebPlanner } from "../chatgpt-web-planner-helper.mjs";
import { acquireFederatedPlannerSlot } from "./planner-capacity-pool.mjs";
import {
  planningIdentityFromProcessContext,
  planningEffortForStage,
  planningRuntimeFromProcessContext,
} from "./planning-runtime-policy.mjs";
import { federatedPlanningRoomEnabled, plannerStageClass } from "./planner-provider-registry.mjs";
import { plannerRouteFromRegistry } from "../../apps/goldflow-studio/lib/planning-route-registry.mjs";

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_REASONING_EFFORT = "medium";
export const MINIMUM_GPT56_CODEX_CLI = "0.144.0";
export const ANTIGRAVITY_CLI_MAX_CONCURRENCY = 3;

const bundledCodexPath = "/Applications/ChatGPT.app/Contents/Resources/codex";
let resolvedRuntimePromise = null;
let activeAntigravityCalls = 0;
const antigravityWaiters = [];

async function acquireAntigravitySlot() {
  if (activeAntigravityCalls >= ANTIGRAVITY_CLI_MAX_CONCURRENCY) {
    await new Promise((resolve) => antigravityWaiters.push(resolve));
  }
  activeAntigravityCalls += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeAntigravityCalls = Math.max(0, activeAntigravityCalls - 1);
    antigravityWaiters.shift()?.();
  };
}

export async function withAntigravitySlotForTests(task) {
  const releaseSlot = await acquireAntigravitySlot();
  try {
    return await task();
  } finally {
    releaseSlot();
  }
}

export function chatGptWebRouteEnabled(explicitProvider = null) {
  return planningRuntimeFromProcessContext({ explicitProvider }).provider === "chatgpt_web";
}

export function configuredCodexModel(explicitModel = null) {
  return planningRuntimeFromProcessContext({ explicitModel }).model || DEFAULT_CODEX_MODEL;
}

export function configuredCodexReasoningEffort(explicitEffort = null, stageName = null, explicitProvider = null) {
  const runtime = planningRuntimeFromProcessContext({ explicitProvider });
  return planningEffortForStage(stageName, { explicitEffort, runtime });
}

export function parseCodexVersion(value) {
  const match = String(value ?? "").match(/(?:codex(?:-cli)?\s+)?v?(\d+)\.(\d+)\.(\d+)(?:-([^\s]+))?/i);
  if (!match) return null;
  return {
    raw: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    version: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
  };
}

export function compareCodexVersions(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    const delta = Number(left?.[field] ?? 0) - Number(right?.[field] ?? 0);
    if (delta) return delta;
  }
  if (left?.prerelease && !right?.prerelease) return -1;
  if (!left?.prerelease && right?.prerelease) return 1;
  return String(left?.prerelease ?? "").localeCompare(String(right?.prerelease ?? ""));
}

export function minimumCodexVersionForModel(model) {
  return /^gpt-5\.6(?:-|$)/i.test(String(model ?? "")) ? parseCodexVersion(MINIMUM_GPT56_CODEX_CLI) : parseCodexVersion("0.0.0");
}

export function codexVersionSupportsModel(version, model) {
  const minimum = minimumCodexVersionForModel(model);
  if (!version || !minimum) return false;
  // The qualifying ChatGPT desktop build currently bundles a 0.144 prerelease.
  // Compare the numeric release tuple so that bundled 0.144.0-alpha builds pass.
  for (const field of ["major", "minor", "patch"]) {
    const delta = Number(version[field] ?? 0) - Number(minimum[field] ?? 0);
    if (delta > 0) return true;
    if (delta < 0) return false;
  }
  return true;
}

function executableVersion(executable) {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) return null;
  const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const parsed = parseCodexVersion(raw);
  return parsed ? { ...parsed, output: raw } : null;
}

function pathCodexExecutable() {
  const result = spawnSync("/usr/bin/which", ["codex"], { encoding: "utf8", timeout: 5_000 });
  return result.status === 0 ? String(result.stdout ?? "").trim() : null;
}

async function isExecutable(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath, 1);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCodexRuntime({ model = null, refresh = false } = {}) {
  const resolvedModel = configuredCodexModel(model);
  if (!refresh && resolvedRuntimePromise) {
    const runtime = await resolvedRuntimePromise;
    if (codexVersionSupportsModel(runtime.parsed_version, resolvedModel)) return runtime;
  }
  resolvedRuntimePromise = (async () => {
    const explicit = process.env.ANIFACTORY_CODEX_CLI_PATH ?? process.env.CODEX_CLI_PATH ?? null;
    const candidates = explicit
      ? [explicit]
      : [pathCodexExecutable(), bundledCodexPath];
    const inspected = [];
    for (const candidate of [...new Set(candidates.filter(Boolean))]) {
      if (!(await isExecutable(candidate))) continue;
      const version = executableVersion(candidate);
      if (version) inspected.push({ executable: candidate, parsed_version: version, version: version.version });
    }
    if (explicit && !inspected.length) throw new Error(`ANIFACTORY_CODEX_CLI_PATH is not executable or has no readable version: ${explicit}`);
    const compatible = inspected.filter((candidate) => codexVersionSupportsModel(candidate.parsed_version, resolvedModel));
    compatible.sort((left, right) => compareCodexVersions(right.parsed_version, left.parsed_version));
    const selected = compatible[0];
    if (!selected) {
      const found = inspected.map((candidate) => `${candidate.executable} (${candidate.version})`).join(", ") || "none";
      throw new Error(`No Codex CLI new enough for ${resolvedModel}. Need ${MINIMUM_GPT56_CODEX_CLI}+; found ${found}. Upgrade @openai/codex or set ANIFACTORY_CODEX_CLI_PATH.`);
    }
    return selected;
  })();
  return resolvedRuntimePromise;
}

export function codexCallMetadataPath(outputPath) {
  return `${outputPath}.meta.json`;
}

export async function readCodexCallMetadata(outputPath) {
  try {
    return JSON.parse(await fs.readFile(codexCallMetadataPath(outputPath), "utf8"));
  } catch {
    return null;
  }
}

export function isCodexCacheCompatible(metadata, {
  model = null,
  reasoningEffort = null,
  promptHash = null,
  provider = null,
  stageName = null,
  planningOverrideStage = null,
} = {}) {
  if (!metadata || metadata.status !== "passed") return false;
  const resolvedStageName = stageName ?? metadata.stage_name ?? null;
  const actualProvider = String(metadata.provider ?? "codex_cli");
  const identity = planningIdentityFromProcessContext().identity;
  const pooledProvider = !provider
    && federatedPlanningRoomEnabled(identity)
    && plannerStageClass(resolvedStageName) === "structured_planning"
    && ["codex_cli", "antigravity_cli"].includes(actualProvider)
      ? actualProvider
      : provider;
  const runtime = planningRuntimeFromProcessContext({
    explicitProvider: pooledProvider,
    explicitModel: model,
    overrideStage: planningOverrideStage,
  });
  const expectedProvider = runtime.provider;
  if (actualProvider !== expectedProvider) return false;
  if (String(metadata.model ?? "") !== runtime.model) return false;
  const expectedEffort = planningEffortForStage(resolvedStageName, { explicitEffort: reasoningEffort, runtime });
  if (String(metadata.reasoning_effort ?? "") !== expectedEffort) return false;
  if (String(metadata.planning_effort_policy ?? runtime.effortPolicy) !== runtime.effortPolicy) return false;
  if (promptHash && String(metadata.prompt_sha256 ?? "") !== String(promptHash)) return false;
  return true;
}

function compactProviderError(value, maxChars = 4000) {
  const raw = String(value ?? "");
  return raw.length <= maxChars ? raw : `${raw.slice(-maxChars)}\n[truncated from ${raw.length} chars]`;
}

async function writeMetadata(outputPath, metadata) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(codexCallMetadataPath(outputPath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function postLocalJson(url, token, body, timeoutMs) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let document = null;
        try { document = text ? JSON.parse(text) : null; } catch {}
        resolve({ ok: Number(response.statusCode) >= 200 && Number(response.statusCode) < 300, status: Number(response.statusCode), payload: document });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Local Studio request exceeded ${timeoutMs} ms.`)));
    request.on("error", reject);
    request.end(payload);
  });
}

function chatGptWebLocalApiConfig() {
  const registered = plannerRouteFromRegistry("chatgpt_web");
  const rawUrl = String(process.env.ANIFACTORY_CHATGPT_WEB_URL ?? registered?.ANIFACTORY_CHATGPT_WEB_URL ?? "").trim();
  if (!rawUrl) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("ANIFACTORY_CHATGPT_WEB_URL must be a valid 127.0.0.1 URL.");
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("ANIFACTORY_CHATGPT_WEB_URL must use the local http://127.0.0.1 Studio API.");
  }
  const token = String(process.env.ANIFACTORY_CHATGPT_WEB_TOKEN ?? registered?.ANIFACTORY_CHATGPT_WEB_TOKEN ?? "").trim();
  if (!token) throw new Error("ANIFACTORY_CHATGPT_WEB_TOKEN is required for the local Studio API.");
  return {
    baseUrl: parsed.toString().replace(/\/+$/g, ""),
    token,
  };
}

function geminiWebLocalApiConfig() {
  const registered = plannerRouteFromRegistry("gemini_web");
  const rawUrl = String(process.env.ANIFACTORY_GEMINI_WEB_URL ?? registered?.ANIFACTORY_GEMINI_WEB_URL ?? "").trim();
  if (!rawUrl) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("ANIFACTORY_GEMINI_WEB_URL must be a valid 127.0.0.1 URL.");
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("ANIFACTORY_GEMINI_WEB_URL must use the local http://127.0.0.1 Studio API.");
  }
  const token = String(process.env.ANIFACTORY_GEMINI_WEB_TOKEN ?? registered?.ANIFACTORY_GEMINI_WEB_TOKEN ?? "").trim();
  if (!token) throw new Error("ANIFACTORY_GEMINI_WEB_TOKEN is required for the local Gemini Studio API.");
  return { baseUrl: parsed.toString().replace(/\/+$/g, ""), token };
}

async function runChatGptWebLocalApi({
  prompt,
  stageName,
  resolvedModel,
  resolvedEffort,
  timeoutMs,
}) {
  const config = chatGptWebLocalApiConfig();
  if (!config) return null;
  const response = await postLocalJson(`${config.baseUrl}/chat/completions`, config.token, {
        model: resolvedModel,
        messages: [{ role: "user", content: String(prompt ?? "") }],
        stream: false,
        timeout_ms: timeoutMs,
        metadata: {
          stage_name: stageName,
          reasoning_effort: resolvedEffort,
        },
      }, timeoutMs);
    const payload = response.payload;
    if (!response.ok) {
      throw new Error(`Local ChatGPT Web Studio request failed (${response.status}): ${compactProviderError(payload?.error?.message ?? payload?.message ?? "unknown error")}`);
    }
    const content = String(payload?.choices?.[0]?.message?.content ?? "");
    if (!content.trim()) throw new Error("Local ChatGPT Web Studio returned an empty completion.");
    return {
      content,
      transport: "goldflow_studio_local_api",
      studio_job_id: payload?.goldflow_job_id ?? null,
      bridge_duration_ms: null,
    };
}

async function runGeminiWebLocalApi({ prompt, stageName, resolvedModel, resolvedEffort, timeoutMs }) {
  const config = geminiWebLocalApiConfig();
  if (!config) throw new Error("Gemini Web planning requires ANIFACTORY_GEMINI_WEB_URL and ANIFACTORY_GEMINI_WEB_TOKEN from a paired Goldflow Studio Gemini worker.");
  const response = await postLocalJson(`${config.baseUrl}/chat/completions`, config.token, {
        model: resolvedModel,
        messages: [{ role: "user", content: String(prompt ?? "") }],
        stream: false,
        timeout_ms: timeoutMs,
        metadata: { stage_name: stageName, reasoning_effort: resolvedEffort },
      }, timeoutMs);
    const payload = response.payload;
    if (!response.ok) {
      throw new Error(`Local Gemini Web Studio request failed (${response.status}): ${compactProviderError(payload?.error?.message ?? payload?.message ?? "unknown error")}`);
    }
    const content = String(payload?.choices?.[0]?.message?.content ?? "");
    if (!content.trim()) throw new Error("Local Gemini Web Studio returned an empty completion.");
    return { content, studio_job_id: payload?.goldflow_job_id ?? null };
}

async function runGeminiWebCompletion({
  prompt,
  stageName,
  outputPath,
  resolvedModel,
  resolvedEffort,
  verbosity,
  timeoutMs,
  promptHash,
  startedAt,
  extraArgs,
  runtime,
}) {
  if (extraArgs.length) throw new Error("Gemini web planner transport does not accept Codex CLI extraArgs.");
  try {
    const result = await runGeminiWebLocalApi({ prompt, stageName, resolvedModel, resolvedEffort, timeoutMs });
    await fs.writeFile(outputPath, result.content, "utf8");
    const metadata = {
      schema: "goldflow_codex_call_metadata_v1",
      status: "passed",
      stage_name: stageName,
      provider: "gemini_web",
      transport: "goldflow_studio_local_api",
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      planning_effort_policy: runtime.effortPolicy,
      planning_room_provider_lock: runtime.providerLock ?? null,
      run_identity_path: runtime.identityPath,
      legacy_identity_adapter: runtime.legacyIdentityAdapter,
      verbosity,
      codex_cli_path: null,
      codex_cli_version: null,
      studio_job_id: result.studio_job_id,
      prompt_sha256: promptHash,
      output_path: outputPath,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    };
    await writeMetadata(outputPath, metadata);
    return { content: result.content, outputPath, ...metadata };
  } catch (error) {
    await writeMetadata(outputPath, {
      schema: "goldflow_codex_call_metadata_v1",
      status: "failed",
      stage_name: stageName,
      provider: "gemini_web",
      transport: "goldflow_studio_local_api",
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      planning_effort_policy: runtime.effortPolicy,
      planning_room_provider_lock: runtime.providerLock ?? null,
      run_identity_path: runtime.identityPath,
      verbosity,
      prompt_sha256: promptHash,
      output_path: outputPath,
      started_at: startedAt,
      failed_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  }
}

function normalizedAntigravityEffort(value) {
  const effort = String(value ?? "medium").trim().toLowerCase();
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high";
}

function antigravityEffortForModel(model, effort) {
  const normalized = normalizedAntigravityEffort(effort);
  const modelName = String(model ?? "").trim().toLowerCase();
  // Antigravity's medium model rejects high effort before submission. Keep the
  // locked model and use its highest compatible effort instead.
  if (modelName.endsWith("-medium") && normalized === "high") return "medium";
  return normalized;
}

export function antigravityNativeArgsForTests({ prompt, model, effort, timeoutMs = 600_000 }) {
  const args = [
    "--print", String(prompt ?? ""),
    "--mode", "plan",
    "--sandbox",
    "--output-format", "json",
    "--effort", antigravityEffortForModel(model, effort),
    "--print-timeout", `${Math.max(30, Math.ceil(Number(timeoutMs) / 1000))}s`,
  ];
  if (String(model ?? "").trim() && String(model).trim().toLowerCase() !== "auto") {
    args.push("--model", String(model).trim());
  }
  return args;
}

function antigravityArgs({ prompt, promptPath, outputPath, model, effort, stageName, timeoutMs }) {
  const raw = String(process.env.ANIFACTORY_ANTIGRAVITY_ARGS_JSON ?? "").trim();
  if (!raw) return antigravityNativeArgsForTests({ prompt, model, effort, timeoutMs });
  let values;
  try { values = JSON.parse(raw); } catch { throw new Error("ANIFACTORY_ANTIGRAVITY_ARGS_JSON must be a JSON array."); }
  if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== "string")) {
    throw new Error("ANIFACTORY_ANTIGRAVITY_ARGS_JSON must be a non-empty string array.");
  }
  const replacements = {
    "{prompt_path}": promptPath,
    "{output_path}": outputPath,
    "{model}": model,
    "{effort}": effort,
    "{stage_name}": stageName,
  };
  return values.map((value) => Object.entries(replacements).reduce((result, [needle, replacement]) => result.replaceAll(needle, replacement), value));
}

export function antigravityContentFromStdoutForTests(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return { content: "", envelope: null };
  try {
    const envelope = JSON.parse(text);
    if (envelope?.status && String(envelope.status).toUpperCase() !== "SUCCESS") {
      throw new Error(`Antigravity print request status=${envelope.status}`);
    }
    const content = envelope?.structured_output != null
      ? `${JSON.stringify(envelope.structured_output, null, 2)}\n`
      : String(envelope?.response ?? "");
    return { content, envelope };
  } catch (error) {
    if (error instanceof SyntaxError) return { content: text, envelope: null };
    throw error;
  }
}

function antigravityCliVersion(executable) {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || result.stderr || "").trim() || null;
}

async function runAntigravityCompletion({
  prompt,
  stageName,
  outputPath,
  resolvedModel,
  resolvedEffort,
  verbosity,
  timeoutMs,
  promptHash,
  startedAt,
  extraArgs,
  runtime,
  cwd,
}) {
  if (extraArgs.length) throw new Error("Antigravity planner uses ANIFACTORY_ANTIGRAVITY_ARGS_JSON instead of Codex CLI extraArgs.");
  const executable = String(process.env.ANIFACTORY_ANTIGRAVITY_CLI_PATH ?? "agy").trim();
  const promptPath = `${outputPath}.prompt.txt`;
  await fs.writeFile(promptPath, String(prompt ?? ""), "utf8");
  const args = antigravityArgs({ prompt, promptPath, outputPath, model: resolvedModel, effort: resolvedEffort, stageName, timeoutMs });
  let stdout = "";
  let stderr = "";
  try {
    await withAntigravitySlotForTests(async () => {
      await new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`Antigravity ${stageName} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("exit", (code) => {
          clearTimeout(timer);
          code === 0 ? resolve() : reject(new Error(`Antigravity ${stageName} exited ${code}: ${compactProviderError(stderr || stdout)}`));
        });
      });
    });
    const providerFile = await fs.readFile(outputPath, "utf8").catch(() => null);
    const parsedOutput = providerFile == null
      ? antigravityContentFromStdoutForTests(stdout)
      : { content: providerFile, envelope: null };
    const content = parsedOutput.content;
    if (!String(content).trim()) throw new Error(`Antigravity ${stageName} returned no output.`);
    if (providerFile == null) await fs.writeFile(outputPath, content, "utf8");
    const cliVersion = antigravityCliVersion(executable);
    const metadata = {
      schema: "goldflow_codex_call_metadata_v1",
      status: "passed",
      stage_name: stageName,
      provider: "antigravity_cli",
      transport: "antigravity_cli",
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      planning_effort_policy: runtime.effortPolicy,
      planning_room_provider_lock: runtime.providerLock ?? null,
      run_identity_path: runtime.identityPath,
      verbosity,
      executable,
      antigravity_cli_version: cliVersion,
      provider_duration_seconds: Number(parsedOutput.envelope?.duration_seconds ?? null),
      provider_usage: parsedOutput.envelope?.usage ?? null,
      provider_conversation_id: parsedOutput.envelope?.conversation_id ?? null,
      prompt_path: promptPath,
      prompt_sha256: promptHash,
      output_path: outputPath,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    };
    await writeMetadata(outputPath, metadata);
    return { content, outputPath, ...metadata };
  } catch (error) {
    await writeMetadata(outputPath, {
      schema: "goldflow_codex_call_metadata_v1",
      status: "failed",
      stage_name: stageName,
      provider: "antigravity_cli",
      transport: "antigravity_cli",
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      planning_effort_policy: runtime.effortPolicy,
      planning_room_provider_lock: runtime.providerLock ?? null,
      run_identity_path: runtime.identityPath,
      verbosity,
      executable,
      prompt_path: promptPath,
      prompt_sha256: promptHash,
      output_path: outputPath,
      started_at: startedAt,
      failed_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  }
}

async function runChatGptWebCompletion({
  prompt,
  stageName,
  outputPath,
  resolvedModel,
  resolvedEffort,
  verbosity,
  timeoutMs,
  promptHash,
  startedAt,
  extraArgs,
  runtime,
}) {
  if (extraArgs.length) throw new Error("ChatGPT web planner transport does not accept Codex CLI extraArgs.");
  try {
    const result = await runChatGptWebLocalApi({
      prompt,
      stageName,
      resolvedModel,
      resolvedEffort,
      timeoutMs,
    }) ?? await runChatGptWebPlanner({
        prompt,
        outputPath,
        workId: stageName,
        effort: resolvedEffort,
        projectUrl: runtime.identity?.chatgpt_web_project?.url
          ?? runtime.identity?.provider_locks?.chatgpt_web_project_url
          ?? null,
        timeoutMs,
      });
    const content = String(result.content ?? "");
    await fs.writeFile(outputPath, content, "utf8");
    const metadata = {
      schema: "goldflow_codex_call_metadata_v1",
      status: "passed",
      stage_name: stageName,
      provider: "chatgpt_web",
      transport: result.transport,
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      planning_effort_policy: runtime.effortPolicy,
      run_identity_path: runtime.identityPath,
      legacy_identity_adapter: runtime.legacyIdentityAdapter,
      verbosity,
      codex_cli_path: null,
      codex_cli_version: null,
      bridge_run_report_path: result.bridge_run_report_path,
      bridge_receipt_path: result.bridge_receipt_path,
      bridge_duration_ms: result.bridge_duration_ms,
      studio_job_id: result.studio_job_id ?? null,
      browser_worker_pool: result.browser_worker_pool,
      browser_worker_slot: result.browser_worker_slot,
      browser_worker_wait_ms: result.browser_worker_wait_ms,
      browser_reasoning_pool: result.browser_reasoning_pool,
      browser_reasoning_slot: result.browser_reasoning_slot,
      browser_reasoning_wait_ms: result.browser_reasoning_wait_ms,
      browser_host_pool: result.browser_host_pool,
      browser_host_slot: result.browser_host_slot,
      browser_host_wait_ms: result.browser_host_wait_ms,
      browser_start_gate: result.browser_start_gate,
      chatgpt_project_url: result.chatgpt_project_url,
      bridge_source_sha256: result.source_sha256,
      normalized_output_sha256: result.normalized_output_sha256,
      response_normalization: result.response_normalization,
      prompt_sha256: promptHash,
      output_path: outputPath,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    };
    await writeMetadata(outputPath, metadata);
    return { content, outputPath, ...metadata };
  } catch (error) {
    const normalized = error;
    await writeMetadata(outputPath, {
      schema: "goldflow_codex_call_metadata_v1",
      status: "failed",
      stage_name: stageName,
      provider: "chatgpt_web",
      transport: String(process.env.ANIFACTORY_CHATGPT_WEB_URL ?? "").trim()
        ? "goldflow_studio_local_api"
        : "goldflow_authenticated_browser_jobs",
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      planning_effort_policy: runtime.effortPolicy,
      run_identity_path: runtime.identityPath,
      legacy_identity_adapter: runtime.legacyIdentityAdapter,
      verbosity,
      codex_cli_path: null,
      codex_cli_version: null,
      prompt_sha256: promptHash,
      output_path: outputPath,
      started_at: startedAt,
      failed_at: new Date().toISOString(),
      error: normalized instanceof Error ? normalized.message : String(normalized),
    }).catch(() => {});
    throw normalized;
  }
}

async function runCodexCliWithResolvedProvider({
  prompt,
  stageName,
  repoRoot,
  outputPath,
  model = null,
  reasoningEffort = null,
  verbosity = "medium",
  timeoutMs = 600_000,
  cwd = repoRoot,
  detached = false,
  extraArgs = [],
  provider = null,
  planningOverrideStage = null,
} = {}) {
  if (!outputPath) throw new Error("runCodexCli requires outputPath.");
  const planningRuntime = planningRuntimeFromProcessContext({
    explicitProvider: provider,
    explicitModel: model,
    overrideStage: planningOverrideStage ?? stageName,
  });
  const resolvedModel = planningRuntime.model;
  const resolvedEffort = planningEffortForStage(stageName, { explicitEffort: reasoningEffort, runtime: planningRuntime });
  const promptHash = createHash("sha256").update(String(prompt ?? "")).digest("hex");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const startedAt = new Date().toISOString();
  if (planningRuntime.provider === "chatgpt_web") {
    return runChatGptWebCompletion({
      prompt,
      stageName,
      outputPath,
      resolvedModel,
      resolvedEffort,
      verbosity,
      timeoutMs,
      promptHash,
      startedAt,
      extraArgs,
      runtime: planningRuntime,
    });
  }
  if (planningRuntime.provider === "gemini_web") {
    return runGeminiWebCompletion({
      prompt, stageName, outputPath, resolvedModel, resolvedEffort, verbosity,
      timeoutMs, promptHash, startedAt, extraArgs, runtime: planningRuntime,
    });
  }
  if (planningRuntime.provider === "antigravity_cli") {
    return runAntigravityCompletion({
      prompt, stageName, outputPath, resolvedModel, resolvedEffort, verbosity,
      timeoutMs, promptHash, startedAt, extraArgs, runtime: planningRuntime, cwd,
    });
  }
  if (planningRuntime.provider === "local_qwen") {
    throw new Error(`Stage ${stageName} selected local_qwen but reached the Codex/Web runner. Use the stage's local LLM adapter.`);
  }
  const runtime = await resolveCodexRuntime({ model: resolvedModel });
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    repoRoot,
    "-m",
    resolvedModel,
    "-c",
    `model_reasoning_effort="${resolvedEffort}"`,
    "-c",
    `model_verbosity="${verbosity}"`,
    ...extraArgs,
    "-o",
    outputPath,
  ];
  let stdout = "";
  let stderr = "";
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(runtime.executable, args, {
        cwd,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        detached,
      });
      const timer = setTimeout(() => {
        try {
          if (detached && child.pid) process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          try {
            if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {}
        }, 5_000).unref();
        reject(new Error(`Codex ${stageName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`Codex ${stageName} exited ${code}: ${compactProviderError(stderr || stdout)}`));
      });
      child.stdin.end(prompt);
    });
    const content = await fs.readFile(outputPath, "utf8").catch(() => stdout || stderr);
    const metadata = {
      schema: "goldflow_codex_call_metadata_v1",
      status: "passed",
      stage_name: stageName,
      provider: "codex_cli",
      transport: "codex_cli",
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      planning_effort_policy: planningRuntime.effortPolicy,
      run_identity_path: planningRuntime.identityPath,
      operator_planning_route_override: planningRuntime.operatorPlanningRouteOverride
        ? {
            path: planningRuntime.operatorPlanningRouteOverride.path,
            sha256: planningRuntime.operatorPlanningRouteOverride.sha256,
            stage: planningRuntime.operatorPlanningRouteOverride.stage,
          }
        : null,
      legacy_identity_adapter: planningRuntime.legacyIdentityAdapter,
      verbosity,
      codex_cli_path: runtime.executable,
      codex_cli_version: runtime.version,
      prompt_sha256: promptHash,
      output_path: outputPath,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    };
    await writeMetadata(outputPath, metadata);
    return { content, outputPath, ...metadata };
  } catch (error) {
    await writeMetadata(outputPath, {
      schema: "goldflow_codex_call_metadata_v1",
      status: "failed",
      stage_name: stageName,
      provider: "codex_cli",
      transport: "codex_cli",
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      planning_effort_policy: planningRuntime.effortPolicy,
      run_identity_path: planningRuntime.identityPath,
      operator_planning_route_override: planningRuntime.operatorPlanningRouteOverride
        ? {
            path: planningRuntime.operatorPlanningRouteOverride.path,
            sha256: planningRuntime.operatorPlanningRouteOverride.sha256,
            stage: planningRuntime.operatorPlanningRouteOverride.stage,
          }
        : null,
      legacy_identity_adapter: planningRuntime.legacyIdentityAdapter,
      verbosity,
      codex_cli_path: runtime.executable,
      codex_cli_version: runtime.version,
      prompt_sha256: promptHash,
      output_path: outputPath,
      started_at: startedAt,
      failed_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  }
}

export async function runCodexCli(options = {}) {
  const slot = await acquireFederatedPlannerSlot({
    stageName: options.stageName,
    explicitProvider: options.provider,
  });
  try {
    return await runCodexCliWithResolvedProvider({
      ...options,
      provider: slot?.provider ?? options.provider ?? null,
    });
  } finally {
    slot?.release();
  }
}

export async function codexRuntimeSummary({ model = null, reasoningEffort = null, stageName = "goldflow_planner_doctor_probe", provider = null } = {}) {
  const planningRuntime = planningRuntimeFromProcessContext({ explicitProvider: provider, explicitModel: model });
  const resolvedModel = planningRuntime.model;
  const resolvedEffort = planningEffortForStage(stageName, { explicitEffort: reasoningEffort, runtime: planningRuntime });
  if (planningRuntime.provider === "chatgpt_web") {
    const localApi = chatGptWebLocalApiConfig();
    return {
      status: "passed",
      provider: "chatgpt_web",
      transport: localApi ? "goldflow_studio_local_api" : "goldflow_authenticated_browser_jobs",
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      planning_effort_policy: planningRuntime.effortPolicy,
      run_identity_path: planningRuntime.identityPath,
      codex_cli_path: null,
      codex_cli_version: null,
      minimum_cli_version: null,
      user_config_model_is_overridden: true,
    };
  }
  if (planningRuntime.provider === "local_qwen") {
    return {
      status: "passed",
      provider: "local_qwen",
      transport: "stage_local_llm_adapter",
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      planning_effort_policy: planningRuntime.effortPolicy,
      run_identity_path: planningRuntime.identityPath,
      codex_cli_path: null,
      codex_cli_version: null,
      minimum_cli_version: null,
      user_config_model_is_overridden: true,
    };
  }
  if (planningRuntime.provider === "antigravity_cli") {
    const executable = String(process.env.ANIFACTORY_ANTIGRAVITY_CLI_PATH ?? "agy").trim();
    const version = antigravityCliVersion(executable);
    if (!version) throw new Error(`Antigravity CLI is unavailable or unreadable: ${executable}`);
    return {
      status: "passed",
      provider: "antigravity_cli",
      transport: "antigravity_cli",
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      planning_effort_policy: planningRuntime.effortPolicy,
      run_identity_path: planningRuntime.identityPath,
      antigravity_cli_path: executable,
      antigravity_cli_version: version,
      user_config_model_is_overridden: true,
    };
  }
  const codexRuntime = await resolveCodexRuntime({ model: resolvedModel });
  return {
    status: "passed",
    provider: "codex_cli",
    transport: "codex_cli",
    model: resolvedModel,
    reasoning_effort: resolvedEffort,
    planning_effort_policy: planningRuntime.effortPolicy,
    run_identity_path: planningRuntime.identityPath,
    codex_cli_path: codexRuntime.executable,
    codex_cli_version: codexRuntime.version,
    minimum_cli_version: minimumCodexVersionForModel(resolvedModel)?.version ?? null,
    user_config_model_is_overridden: true,
  };
}
