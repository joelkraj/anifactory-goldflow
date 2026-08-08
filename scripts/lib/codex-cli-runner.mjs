import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runChatGptWebPlanner } from "../chatgpt-web-planner-helper.mjs";
import {
  planningEffortForStage,
  planningRuntimeFromProcessContext,
} from "./planning-runtime-policy.mjs";

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_REASONING_EFFORT = "medium";
export const MINIMUM_GPT56_CODEX_CLI = "0.144.0";

const bundledCodexPath = "/Applications/ChatGPT.app/Contents/Resources/codex";
let resolvedRuntimePromise = null;

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
} = {}) {
  if (!metadata || metadata.status !== "passed") return false;
  const runtime = planningRuntimeFromProcessContext({ explicitProvider: provider, explicitModel: model });
  const expectedProvider = runtime.provider;
  const actualProvider = String(metadata.provider ?? "codex_cli");
  if (actualProvider !== expectedProvider) return false;
  if (String(metadata.model ?? "") !== runtime.model) return false;
  const resolvedStageName = stageName ?? metadata.stage_name ?? null;
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

function chatGptWebLocalApiConfig() {
  const rawUrl = String(process.env.ANIFACTORY_CHATGPT_WEB_URL ?? "").trim();
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
  const token = String(process.env.ANIFACTORY_CHATGPT_WEB_TOKEN ?? "").trim();
  if (!token) throw new Error("ANIFACTORY_CHATGPT_WEB_TOKEN is required for the local Studio API.");
  return {
    baseUrl: parsed.toString().replace(/\/+$/g, ""),
    token,
  };
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages: [{ role: "user", content: String(prompt ?? "") }],
        stream: false,
        timeout_ms: timeoutMs,
        metadata: {
          stage_name: stageName,
          reasoning_effort: resolvedEffort,
        },
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
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
  } finally {
    clearTimeout(timer);
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

export async function runCodexCli({
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
} = {}) {
  if (!outputPath) throw new Error("runCodexCli requires outputPath.");
  const planningRuntime = planningRuntimeFromProcessContext({ explicitProvider: provider, explicitModel: model });
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
