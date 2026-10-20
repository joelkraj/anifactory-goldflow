import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// Source-manufacture calls through Claude Code headless print mode (`claude -p`), not the
// Anthropic API. Flags were checked against `claude --help` (Claude Code 2.1.302). The call
// is read-only: built-in tools, MCP servers, slash commands/skills and hooks are disabled,
// and no session is persisted. There is no automatic retry.
export const CLAUDE_CODE_PROVIDER = "claude_cli";
export const CLAUDE_CODE_TRANSPORT = "claude_code_headless_print";
export const CLAUDE_CODE_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function compact(value, maxChars = 4000) {
  const raw = String(value ?? "");
  return raw.length <= maxChars ? raw : `${raw.slice(-maxChars)}\n[truncated from ${raw.length} chars]`;
}

export function claudeCodeExecutable() {
  return String(process.env.ANIFACTORY_CLAUDE_CLI_PATH ?? "claude").trim();
}

export function claudeCodePrintArgs({ model, effort }) {
  const value = String(model ?? "").trim();
  if (!value) throw new Error("Claude Code calls need an explicit --model.");
  const level = String(effort ?? "").trim().toLowerCase();
  if (!CLAUDE_CODE_EFFORTS.includes(level)) throw new Error(`Unsupported Claude Code effort: ${effort}`);
  return [
    "-p",
    "--output-format", "json",
    "--model", value,
    "--effort", level,
    "--no-session-persistence",
    "--tools", "",
    "--disallowedTools", "*",
    "--strict-mcp-config",
    "--mcp-config", "{\"mcpServers\":{}}",
    "--disable-slash-commands",
    "--settings", "{\"disableAllHooks\":true}",
  ];
}

export function claudeCodeResultFromStdout(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(String(stdout ?? "").trim());
  } catch {
    throw new Error("Claude Code print call returned invalid JSON.");
  }
  if (envelope?.is_error === true || String(envelope?.subtype ?? "").startsWith("error")) {
    throw new Error(`Claude Code print call failed: ${compact(envelope?.result ?? envelope?.subtype ?? "unknown error")}`);
  }
  if (envelope?.type !== "result" || typeof envelope.result !== "string" || !envelope.result.trim()) {
    throw new Error("Claude Code print call returned no result text.");
  }
  return { content: envelope.result, envelope };
}

function claudeCodeVersion(executable) {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || result.stderr || "").trim() || null;
}

async function writeReceipt(outputPath, metadata) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(`${outputPath}.meta.json`, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

// Same contract as runCodexCli: writes the raw output and its .meta.json receipt and returns
// { content, ...metadata }. The receipt records provider, model and effort for resume checks.
export async function runClaudeCodePrint({ prompt, stageName, outputPath, model, reasoningEffort, timeoutMs = 2_400_000, cwd = process.cwd() }) {
  const executable = claudeCodeExecutable();
  const args = claudeCodePrintArgs({ model, effort: reasoningEffort });
  const startedAt = new Date().toISOString();
  const common = {
    schema: "goldflow_codex_call_metadata_v1",
    stage_name: stageName,
    provider: CLAUDE_CODE_PROVIDER,
    transport: CLAUDE_CODE_TRANSPORT,
    model: String(model).trim(),
    reasoning_effort: String(reasoningEffort).trim().toLowerCase(),
    executable,
    args,
    prompt_sha256: sha256(prompt),
    output_path: outputPath,
    timeout_ms: timeoutMs,
    started_at: startedAt,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  let stdout = "";
  let stderr = "";
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Claude Code ${stageName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.stdin.on("error", (error) => { clearTimeout(timer); child.kill("SIGTERM"); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`Claude Code ${stageName} exited ${code}: ${compact(stderr || stdout)}`));
      });
      child.stdin.end(String(prompt ?? ""));
    });
    const parsed = claudeCodeResultFromStdout(stdout);
    await fs.writeFile(outputPath, parsed.content, { encoding: "utf8", flag: "wx" });
    const metadata = {
      ...common,
      status: "passed",
      claude_cli_version: claudeCodeVersion(executable),
      provider_duration_seconds: Number(parsed.envelope?.duration_ms ?? NaN) / 1000 || null,
      provider_usage: parsed.envelope?.usage ?? null,
      provider_model_usage: parsed.envelope?.modelUsage ?? null,
      provider_cost_usd: parsed.envelope?.total_cost_usd ?? null,
      output_sha256: sha256(parsed.content),
      completed_at: new Date().toISOString(),
    };
    await writeReceipt(outputPath, metadata);
    return { content: parsed.content, outputPath, ...metadata };
  } catch (error) {
    await writeReceipt(outputPath, {
      ...common,
      status: "failed",
      failed_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  }
}
