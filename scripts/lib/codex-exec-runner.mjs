import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareCodexVersions, parseCodexVersion } from "./codex-cli-runner.mjs";

// Source-manufacture GPT calls through `codex exec` with an explicit model and effort. This is a
// thin, stage-policy-free wrapper: no planning-room routing, provider pooling or effort
// rewriting. The call runs in a read-only sandbox inside an empty scratch directory, ignores the
// user's config.toml (auth still comes from CODEX_HOME), keeps no session, has a timeout and no
// automatic retry. Flags were checked against `codex exec --help` (codex-cli 0.163.0).
export const CODEX_EXEC_PROVIDER = "codex_cli";
export const CODEX_EXEC_TRANSPORT = "codex_exec_cli";
export const CODEX_EXEC_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

// Minimum CLI release whose bundled catalog lists the model (gpt-6.1-sol entered in 0.159.1,
// as recorded on codex/planner-model-integration). Unlisted models have no floor.
export const CODEX_MINIMUM_CLI_BY_MODEL = Object.freeze([
  Object.freeze({ pattern: /^gpt-6\.1(?:-|$)/i, minimum: "0.159.1" }),
  Object.freeze({ pattern: /^gpt-5\.6(?:-|$)/i, minimum: "0.144.0" }),
]);

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function compact(value, maxChars = 4000) {
  const raw = String(value ?? "");
  return raw.length <= maxChars ? raw : `${raw.slice(-maxChars)}\n[truncated from ${raw.length} chars]`;
}

export function minimumCodexCliForModel(model) {
  return CODEX_MINIMUM_CLI_BY_MODEL.find((row) => row.pattern.test(String(model ?? "")))?.minimum ?? null;
}

export function codexExecExecutable() {
  const explicit = String(process.env.ANIFACTORY_CODEX_CLI_PATH ?? process.env.CODEX_CLI_PATH ?? "").trim();
  if (explicit) return explicit;
  const found = spawnSync("/usr/bin/which", ["codex"], { encoding: "utf8", timeout: 5_000 });
  return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : "codex";
}

function codexVersion(executable) {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) return null;
  return parseCodexVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

export function codexExecArgs({ model, effort, workdir, lastMessagePath }) {
  const value = String(model ?? "").trim();
  if (!value) throw new Error("Codex exec calls need an explicit model.");
  const level = String(effort ?? "").trim().toLowerCase();
  if (!CODEX_EXEC_EFFORTS.includes(level)) throw new Error(`Unsupported Codex reasoning effort: ${effort}`);
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--sandbox", "read-only",
    "--color", "never",
    "-C", workdir,
    "-m", value,
    "-c", `model_reasoning_effort="${level}"`,
    "-o", lastMessagePath,
    "-",
  ];
}

async function writeReceipt(outputPath, metadata) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(`${outputPath}.meta.json`, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

// Same contract as runCodexCli and runClaudeCodePrint: writes the raw output once and its
// .meta.json receipt, and returns { content, ...metadata }.
export async function runCodexExec({ prompt, stageName, outputPath, model, reasoningEffort, timeoutMs = 2_400_000 }) {
  // A passed output is immutable; refuse before spending a call rather than after.
  if (await fs.stat(outputPath).then(() => true, () => false)) {
    throw new Error(`EEXIST: ${outputPath} already exists; resume reuses it instead of submitting again.`);
  }
  const executable = codexExecExecutable();
  const startedAt = new Date().toISOString();
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-codex-exec-"));
  const lastMessagePath = path.join(workdir, "last_message.txt");
  const args = codexExecArgs({ model, effort: reasoningEffort, workdir, lastMessagePath });
  const version = codexVersion(executable);
  const common = {
    schema: "goldflow_codex_call_metadata_v1",
    stage_name: stageName,
    provider: CODEX_EXEC_PROVIDER,
    transport: CODEX_EXEC_TRANSPORT,
    model: String(model).trim(),
    reasoning_effort: String(reasoningEffort).trim().toLowerCase(),
    sandbox: "read-only",
    codex_cli_path: executable,
    codex_cli_version: version?.version ?? null,
    prompt_sha256: sha256(prompt),
    output_path: outputPath,
    timeout_ms: timeoutMs,
    started_at: startedAt,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  let stdout = "";
  let stderr = "";
  try {
    const minimum = minimumCodexCliForModel(model);
    if (minimum && (!version || compareCodexVersions(version, parseCodexVersion(minimum)) < 0)) {
      throw new Error(`Codex CLI ${version?.version ?? "unknown"} at ${executable} is older than ${minimum}, the first release listing ${model}.`);
    }
    await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: workdir, env: { ...process.env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5_000).unref();
        reject(new Error(`Codex ${stageName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.stdin.on("error", (error) => { clearTimeout(timer); child.kill("SIGTERM"); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`Codex ${stageName} exited ${code}: ${compact(stderr || stdout)}`));
      });
      child.stdin.end(String(prompt ?? ""));
    });
    const content = await fs.readFile(lastMessagePath, "utf8").catch(() => "");
    if (!content.trim()) throw new Error(`Codex ${stageName} returned no final message.`);
    await fs.writeFile(outputPath, content, { encoding: "utf8", flag: "wx" });
    const metadata = { ...common, status: "passed", output_sha256: sha256(content), completed_at: new Date().toISOString() };
    await writeReceipt(outputPath, metadata);
    return { content, outputPath, ...metadata };
  } catch (error) {
    await writeReceipt(outputPath, {
      ...common,
      status: "failed",
      failed_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
