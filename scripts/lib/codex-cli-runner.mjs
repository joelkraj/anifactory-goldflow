import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_REASONING_EFFORT = "medium";
export const MINIMUM_GPT56_CODEX_CLI = "0.144.0";

const bundledCodexPath = "/Applications/ChatGPT.app/Contents/Resources/codex";
let resolvedRuntimePromise = null;

export function configuredCodexModel(explicitModel = null) {
  return String(explicitModel ?? process.env.ANIFACTORY_CODEX_MODEL ?? DEFAULT_CODEX_MODEL).trim() || DEFAULT_CODEX_MODEL;
}

export function configuredCodexReasoningEffort(explicitEffort = null) {
  return String(explicitEffort ?? process.env.ANIFACTORY_CODEX_REASONING_EFFORT ?? DEFAULT_CODEX_REASONING_EFFORT).trim() || DEFAULT_CODEX_REASONING_EFFORT;
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
} = {}) {
  if (!metadata || metadata.status !== "passed") return false;
  if (String(metadata.model ?? "") !== configuredCodexModel(model)) return false;
  if (String(metadata.reasoning_effort ?? "") !== configuredCodexReasoningEffort(reasoningEffort)) return false;
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
} = {}) {
  if (!outputPath) throw new Error("runCodexCli requires outputPath.");
  const resolvedModel = configuredCodexModel(model);
  const resolvedEffort = configuredCodexReasoningEffort(reasoningEffort);
  const runtime = await resolveCodexRuntime({ model: resolvedModel });
  const promptHash = createHash("sha256").update(String(prompt ?? "")).digest("hex");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
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
  const startedAt = new Date().toISOString();
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
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
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
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
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

export async function codexRuntimeSummary({ model = null, reasoningEffort = null } = {}) {
  const resolvedModel = configuredCodexModel(model);
  const runtime = await resolveCodexRuntime({ model: resolvedModel });
  return {
    status: "passed",
    model: resolvedModel,
    reasoning_effort: configuredCodexReasoningEffort(reasoningEffort),
    codex_cli_path: runtime.executable,
    codex_cli_version: runtime.version,
    minimum_cli_version: minimumCodexVersionForModel(resolvedModel)?.version ?? null,
    user_config_model_is_overridden: true,
  };
}
