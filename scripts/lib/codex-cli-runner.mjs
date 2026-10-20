import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { runChatGptWebPlanner } from "../chatgpt-web-planner-helper.mjs";
import { acquireFederatedPlannerSlot } from "./planner-capacity-pool.mjs";
import {
  planningIdentityFromProcessContext,
  planningEffortForStage,
  planningRuntimeFromProcessContext,
} from "./planning-runtime-policy.mjs";
import {
  federatedPlanningRoomEnabled,
  plannerStageClass,
  plannerStageExecutionPolicy,
} from "./planner-provider-registry.mjs";
import { plannerRouteFromRegistry } from "../../apps/goldflow-studio/lib/planning-route-registry.mjs";
import { CODEX_PLANNING_DEFAULTS, minimumCodexCliForModel } from "./model-defaults.mjs";

export const DEFAULT_CODEX_MODEL = CODEX_PLANNING_DEFAULTS.model;
export const DEFAULT_CODEX_REASONING_EFFORT = CODEX_PLANNING_DEFAULTS.reasoning_effort;
// Compatibility export for older callers; runtime gates use the model table.
export const MINIMUM_GPT56_CODEX_CLI = minimumCodexCliForModel("gpt-5.6-sol");
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
  return parseCodexVersion(minimumCodexCliForModel(model));
}

export function codexVersionSupportsModel(version, model) {
  const minimum = minimumCodexVersionForModel(model);
  if (!version || !minimum) return false;
  // Preserve the historical numeric-tuple compatibility for bundled prereleases.
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
      throw new Error(`No Codex CLI new enough for ${resolvedModel}. Need ${minimumCodexCliForModel(resolvedModel)}+; found ${found}. Upgrade @openai/codex or set ANIFACTORY_CODEX_CLI_PATH.`);
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
    && ["codex_cli", "claude_cli", "antigravity_cli"].includes(actualProvider)
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

function localStudioRequestError(providerLabel, response) {
  const payload = response?.payload;
  const payloadError = payload?.error;
  const errorMessage = typeof payloadError === "string" && payloadError.trim()
    ? payloadError
    : payloadError && typeof payloadError === "object" && String(payloadError.message ?? "").trim()
      ? payloadError.message
      : String(payload?.message ?? "").trim() || "unknown error";
  const error = new Error(`Local ${providerLabel} Studio request failed (${response?.status}): ${compactProviderError(errorMessage)}`);
  if (payload?.code != null && String(payload.code).trim()) error.code = payload.code;
  return error;
}

async function writeMetadata(outputPath, metadata) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(codexCallMetadataPath(outputPath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

// One receipt schema for every CLI/web call this module makes. Every transport
// records the same core fields; provider-specific extras are additive. Receipts
// written by the folded source-manufacture runners (codex-exec-runner.mjs and
// claude-code-print-runner.mjs) carry the same schema id and remain readable
// under their recorded transport names, listed in RECEIPT_TRANSPORT_ALIASES.
export const CODEX_CALL_METADATA_SCHEMA = "goldflow_codex_call_metadata_v1";
export const RECEIPT_TRANSPORT_ALIASES = Object.freeze({
  codex_cli: Object.freeze({ provider: "codex_cli", runner: "codex-cli-runner.mjs", role: "planner" }),
  codex_exec_cli: Object.freeze({ provider: "codex_cli", runner: "codex-exec-runner.mjs (folded into codex-cli-runner.mjs)", role: "source_manufacture" }),
  claude_code_headless_cli: Object.freeze({ provider: "claude_cli", runner: "codex-cli-runner.mjs", role: "planner" }),
  claude_code_headless_print: Object.freeze({ provider: "claude_cli", runner: "claude-code-print-runner.mjs (folded into codex-cli-runner.mjs)", role: "source_manufacture" }),
  antigravity_cli: Object.freeze({ provider: "antigravity_cli", runner: "codex-cli-runner.mjs", role: "planner" }),
  goldflow_studio_local_api: Object.freeze({ provider: "chatgpt_web|gemini_web", runner: "codex-cli-runner.mjs", role: "planner" }),
  goldflow_authenticated_browser_jobs: Object.freeze({ provider: "chatgpt_web", runner: "codex-cli-runner.mjs", role: "planner" }),
});

export function receiptTransportAlias(transport) {
  return RECEIPT_TRANSPORT_ALIASES[String(transport ?? "")] ?? null;
}

// Cost/usage fields shared by every receipt. Subscription CLIs record null
// (unrecorded), never 0; Claude's print envelope fills them when present.
function usageFields(envelope = null) {
  return {
    provider_duration_seconds: Number(envelope?.duration_ms ?? NaN) / 1000 || null,
    provider_usage: envelope?.usage ?? null,
    provider_model_usage: envelope?.modelUsage ?? null,
    provider_cost_usd: envelope?.total_cost_usd ?? null,
  };
}

// The single child-process call layer: spawn a CLI, feed the prompt on stdin,
// collect stdout/stderr, enforce one timeout, no automatic retry.
function spawnCliWithPrompt({ executable, args, cwd, prompt, timeoutMs, label, detached = false, killGrace = true }) {
  let stdout = "";
  let stderr = "";
  const done = new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      detached,
    });
    const signalChild = (signal) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    };
    const timer = setTimeout(() => {
      signalChild("SIGTERM");
      if (killGrace) setTimeout(() => signalChild("SIGKILL"), 5_000).unref();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on("error", (error) => { clearTimeout(timer); child.kill("SIGTERM"); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const error = new Error(`${label} exited ${code}: ${compactProviderError(stderr || stdout)}`);
      error.exitCode = code;
      reject(error);
    });
    child.stdin.end(String(prompt ?? ""));
  });
  return { done, output: () => ({ stdout, stderr }) };
}

// ---------------------------------------------------------------------------
// Transport-class retry for the Codex CLI path (R03). A failed attempt is
// retried only when it produced no `-o` output file, exit != 0, and stderr
// carries one of the anchored transport signatures; the runner's own timeout
// and anything that produced output are never retried. Each attempt leaves
// immutable sidecars next to the output; the receipt summarises them in
// `attempts[]`. Identities without the policy lock keep one attempt.
// ---------------------------------------------------------------------------

export const TRANSPORT_RETRY_POLICY_ID = "transport_retry_same_prompt_same_provider_v1";
export const TRANSPORT_RETRY_BACKOFF_MS = Object.freeze([15_000, 60_000]);
export const TRANSPORT_RETRY_MAX_ATTEMPTS = TRANSPORT_RETRY_BACKOFF_MS.length + 1;
export const TRANSPORT_EXHAUSTED_CODE = "transport_exhausted";
export const CODEX_TRANSPORT_STDERR_PATTERN = /Transport channel closed|Reconnecting\.\.\. \d\/\d|routing discovery failed|ECONNRESET|ETIMEDOUT|stream disconnected/;
export const CODEX_CALL_ATTEMPT_SCHEMA = "goldflow_codex_call_attempt_v1";

/** Pure classifier: `transport` only when exit != 0, no `-o` output and a transport signature in stderr. */
export function classifyCodexCliFailure({ exitCode = null, outputPresent = false, stderr = "", timedOut = false } = {}) {
  if (exitCode === 0 && !timedOut) return "passed";
  if (timedOut) return "timeout";
  if (outputPresent) return "failed_with_output";
  return CODEX_TRANSPORT_STDERR_PATTERN.test(String(stderr ?? "")) ? "transport" : "failure";
}

/** The identity lock decides the attempt budget; a missing field is the legacy single attempt. */
export function transportRetryPolicyForIdentity(identity = null) {
  const recorded = identity?.provider_locks?.transport_retry_policy ?? identity?.transport_retry_policy ?? null;
  if (recorded === TRANSPORT_RETRY_POLICY_ID) {
    return { policy: TRANSPORT_RETRY_POLICY_ID, max_attempts: TRANSPORT_RETRY_MAX_ATTEMPTS, backoff_ms: [...TRANSPORT_RETRY_BACKOFF_MS] };
  }
  return { policy: null, max_attempts: 1, backoff_ms: [] };
}

export function codexCallAttemptPaths(outputPath, attempt) {
  const stem = `${outputPath}.attempt-${attempt}`;
  return { meta: `${stem}.meta.json`, stderr: `${stem}.stderr.txt`, events: `${stem}.events.jsonl` };
}

/** Old receipts without `attempts[]` read as one attempt of their recorded status. */
export function receiptAttempts(metadata = null) {
  if (Array.isArray(metadata?.attempts) && metadata.attempts.length) return metadata.attempts;
  if (!metadata) return [];
  return [{ attempt: 1, class: metadata.status === "passed" ? "passed" : "failure", legacy_single_attempt: true }];
}

// Only diagnostic lines reach error messages and execution events; the full
// stderr (which may echo the prompt) stays in the per-attempt sidecar.
const STDERR_DIAGNOSTIC_LINE = /^(?:\d{4}-\d{2}-\d{2}T\S+\s+)?(?:ERROR|WARN|error:|warning:|panic|thread '.*' panicked)/;
export function codexStderrDiagnosticLines(stderr, { maxLines = 40, maxChars = 4000 } = {}) {
  const lines = String(stderr ?? "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  let kept = lines.filter((line) => STDERR_DIAGNOSTIC_LINE.test(line));
  if (!kept.length) kept = lines.slice(-3).map((line) => line.slice(0, 600));
  const text = kept.slice(-maxLines).join("\n");
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

// `codex exec --json` streams JSONL events on stdout. Usage/token events stay
// in the receipt; item events (agent message text) go to the events sidecar only.
const CODEX_RECEIPT_EVENT_TYPE = /^(thread\.started|turn\.(started|completed|failed)|error)$/;
export function codexExecEventsFromStdout(stdout) {
  const events = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try { events.push(JSON.parse(text)); } catch {}
  }
  const usageEvents = events.filter((event) => event && typeof event === "object" && event.usage && typeof event.usage === "object");
  const usage = usageEvents.length ? usageEvents[usageEvents.length - 1].usage : null;
  const receiptEvents = events.filter((event) => CODEX_RECEIPT_EVENT_TYPE.test(String(event?.type ?? "")) || event?.usage);
  const threadId = events.find((event) => event?.type === "thread.started")?.thread_id ?? null;
  return { events, usage, usage_events: usageEvents, receipt_events: receiptEvents, thread_id: threadId };
}

function codexUsageFields(parsedEvents) {
  return {
    ...usageFields(null),
    provider_usage: parsedEvents?.usage ?? null,
    // Subscription CLI: tokens are recorded, dollars are unrecorded (null), never 0.
    provider_cost_usd: null,
    provider_usage_source: parsedEvents?.usage ? "codex_exec_json_events" : null,
    provider_events: parsedEvents?.receipt_events ?? [],
    provider_conversation_id: parsedEvents?.thread_id ?? null,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fileExists(filePath) { return fs.stat(filePath).then((stat) => stat.isFile(), () => false); }
async function writeImmutable(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
}

/**
 * Runs one Codex CLI call with the identity's transport-retry budget. Resolves
 * with { attempts, stdout, stderr, events } on success. On failure throws an
 * error carrying `attempts`, `failure_class`, `stderr_path` and, once the budget
 * is spent on transport failures, `code: "transport_exhausted"`. Never retries a
 * timeout, an exit that produced output, or a non-transport failure.
 */
async function runCodexWithTransportRetry({
  executable, args, cwd, prompt, timeoutMs, label, detached = false,
  outputPath, providerOutputPath, retry, backoffMsForTests = null,
}) {
  const backoff = Array.isArray(backoffMsForTests) ? backoffMsForTests : retry.backoff_ms;
  const attempts = [];
  for (let attempt = 1; attempt <= retry.max_attempts; attempt += 1) {
    const paths = codexCallAttemptPaths(outputPath, attempt);
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let failure = null;
    let output = { stdout: "", stderr: "" };
    try {
      const call = spawnCliWithPrompt({ executable, args, cwd, prompt, timeoutMs, label, detached });
      try { await call.done; } finally { output = call.output(); }
    } catch (error) {
      failure = error;
    }
    const timedOut = Boolean(failure) && /timed out after/.test(failure.message ?? "");
    const outputPresent = await fileExists(providerOutputPath);
    const klass = failure ? classifyCodexCliFailure({ exitCode: failure.exitCode ?? null, outputPresent, stderr: output.stderr, timedOut }) : "passed";
    await writeImmutable(paths.stderr, output.stderr ?? "").catch(() => {});
    const parsedEvents = codexExecEventsFromStdout(output.stdout);
    let eventsPath = null;
    if (parsedEvents.events.length) {
      eventsPath = paths.events;
      await writeImmutable(eventsPath, parsedEvents.events.map((event) => JSON.stringify(event)).join("\n") + "\n").catch(() => {});
    }
    const willRetry = klass === "transport" && attempt < retry.max_attempts;
    const record = {
      schema: CODEX_CALL_ATTEMPT_SCHEMA,
      attempt,
      class: klass,
      exit_code: failure ? failure.exitCode ?? null : 0,
      timed_out: timedOut,
      output_present: outputPresent,
      elapsed_ms: Date.now() - t0,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      stderr_path: paths.stderr,
      events_path: eventsPath,
      error_lines: failure ? codexStderrDiagnosticLines(output.stderr || failure.message) : null,
      backoff_ms_before_next: willRetry ? backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 0 : null,
    };
    await writeImmutable(paths.meta, `${JSON.stringify(record, null, 2)}\n`).catch(() => {});
    attempts.push(record);
    if (!failure) return { attempts, stdout: output.stdout, stderr: output.stderr, events: parsedEvents };
    if (willRetry) {
      await sleep(record.backoff_ms_before_next);
      continue;
    }
    const exhausted = klass === "transport";
    const error = new Error(
      `${label} ${timedOut ? "timed out" : `exited ${failure.exitCode ?? "?"}`} (${klass}) after ${attempts.length} attempt(s)`
      + `${exhausted ? `; ${TRANSPORT_EXHAUSTED_CODE}` : ""}; full stderr: ${paths.stderr}\n${record.error_lines ?? ""}`,
    );
    if (exhausted) error.code = TRANSPORT_EXHAUSTED_CODE;
    error.failure_class = klass;
    error.attempts = attempts;
    error.stderr_path = paths.stderr;
    error.exitCode = failure.exitCode ?? null;
    throw error;
  }
  throw new Error(`${label}: transport retry budget is empty.`);
}

function attemptSummaryFields(retry, attempts) {
  return {
    transport_retry_policy: retry.policy,
    transport_retry_max_attempts: retry.max_attempts,
    attempts: attempts.map(({ attempt, class: klass, exit_code, elapsed_ms, stderr_path, events_path, backoff_ms_before_next }) =>
      ({ attempt, class: klass, exit_code, elapsed_ms, stderr_path, events_path, backoff_ms_before_next })),
  };
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
      throw localStudioRequestError("ChatGPT Web", response);
    }
    const content = String(payload?.choices?.[0]?.message?.content ?? "");
    if (!content.trim()) throw new Error("Local ChatGPT Web Studio returned an empty completion.");
    return {
      content,
      transport: "goldflow_studio_local_api",
      studio_job_id: payload?.goldflow_job_id ?? null,
      studio_timing: payload?.goldflow_timing ?? null,
      bridge_duration_ms: payload?.goldflow_timing?.total_ms ?? null,
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
      throw localStudioRequestError("Gemini Web", response);
    }
    const content = String(payload?.choices?.[0]?.message?.content ?? "");
    if (!content.trim()) throw new Error("Local Gemini Web Studio returned an empty completion.");
    return {
      content,
      studio_job_id: payload?.goldflow_job_id ?? null,
      studio_timing: payload?.goldflow_timing ?? null,
    };
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
      studio_timing: result.studio_timing ?? null,
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
      error_code: error?.code ?? null,
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
        model: resolvedModel,
        effort: resolvedEffort,
        projectUrl: runtime.identity?.chatgpt_web_project?.url
          ?? runtime.identity?.provider_locks?.chatgpt_web_project_url
          ?? null,
        timeoutMs,
        rateClass: stageName.startsWith("winner_source_script_v3_")
          || stageName.startsWith("winner_source_script_improvement_edit_")
          ? "source_revision"
          : stageName.startsWith("winner_source_script_improvement_judge_")
            ? "audience_staggered"
            : stageName.startsWith("winner_source_prompt_strategy_ab_")
            ? "audience_evaluation"
            : null,
        minimumStartIntervalMs: stageName.startsWith("winner_source_script_improvement_judge_")
          ? 15_000
          : null,
      });
    const content = String(result.content ?? "");
    await fs.writeFile(outputPath, content, "utf8");
    const outputSha256 = createHash("sha256").update(content).digest("hex");
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
      studio_timing: result.studio_timing ?? null,
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
      output_sha256: outputSha256,
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
      error_code: normalized?.code ?? null,
      error: normalized instanceof Error ? normalized.message : String(normalized),
    }).catch(() => {});
    throw normalized;
  }
}

export function claudeNativeArgsForTests({ model, effort }) {
  const args = [
    "-p",
    "--output-format", "json",
    "--no-session-persistence",
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--disallowedTools", "*",
    "--disable-slash-commands",
    "--settings", '{"disableAllHooks":true}',
    "--effort", normalizedClaudeEffort(effort),
  ];
  if (String(model ?? "").trim()) args.push("--model", String(model).trim());
  return args;
}

function normalizedClaudeEffort(effort) {
  const value = String(effort ?? "medium").trim().toLowerCase();
  if (!["low", "medium", "high", "xhigh", "max"].includes(value)) throw new Error(`Unsupported Claude planning effort: ${effort}`);
  return value;
}

export function claudeContentFromStdoutForTests(stdout) {
  const text = String(stdout ?? "").trim();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("Claude print request returned invalid JSON.");
  }
  if (envelope?.is_error === true || (envelope?.subtype && String(envelope.subtype).startsWith("error"))) {
    throw new Error(`Claude print request failed: ${compactProviderError(envelope?.result ?? envelope?.subtype ?? "unknown error")}`);
  }
  if (envelope?.type !== "result" || typeof envelope.result !== "string" || !envelope.result.trim()) {
    throw new Error("Claude print request returned no valid result text.");
  }
  return { content: envelope.result, envelope };
}

function claudeCliVersion(executable) {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || result.stderr || "").trim() || null;
}

async function runClaudeCompletion({
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
  if (extraArgs.length) throw new Error("Claude planner does not accept Codex CLI extraArgs.");
  const executable = String(process.env.ANIFACTORY_CLAUDE_CLI_PATH ?? "claude").trim();
  const args = claudeNativeArgsForTests({ model: resolvedModel, effort: resolvedEffort });
  const common = {
    schema: CODEX_CALL_METADATA_SCHEMA,
    stage_name: stageName,
    provider: "claude_cli",
    transport: "claude_code_headless_cli",
    model: resolvedModel,
    reasoning_effort: resolvedEffort,
    planning_effort_policy: runtime.effortPolicy,
    planning_room_provider_lock: runtime.providerLock ?? null,
    run_identity_path: runtime.identityPath,
    verbosity,
    executable,
    prompt_sha256: promptHash,
    output_path: outputPath,
    started_at: startedAt,
  };
  try {
    const call = spawnCliWithPrompt({ executable, args, cwd, prompt, timeoutMs, label: `Claude ${stageName}`, killGrace: false });
    await call.done;
    const parsed = claudeContentFromStdoutForTests(call.output().stdout);
    if (!String(parsed.content).trim()) throw new Error(`Claude ${stageName} returned no output.`);
    await fs.writeFile(outputPath, parsed.content, "utf8");
    const version = claudeCliVersion(executable);
    const metadata = {
      ...common,
      status: "passed",
      claude_cli_version: version,
      cli_version: version,
      ...usageFields(parsed.envelope),
      provider_conversation_id: parsed.envelope?.session_id ?? null,
      output_sha256: createHash("sha256").update(parsed.content).digest("hex"),
      completed_at: new Date().toISOString(),
    };
    await writeMetadata(outputPath, metadata);
    return { content: parsed.content, outputPath, ...metadata };
  } catch (error) {
    await writeMetadata(outputPath, {
      ...common,
      status: "failed",
      failed_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  }
}


// ---------------------------------------------------------------------------
// Source-manufacture transports (folded from scripts/lib/codex-exec-runner.mjs
// and scripts/lib/claude-code-print-runner.mjs). These take an explicit model
// and effort from the per-run manufacturing model lock and never consult the
// planning-room routing above. Same receipt schema, same single call layer.
// ---------------------------------------------------------------------------

export const CODEX_EXEC_PROVIDER = "codex_cli";
export const CODEX_EXEC_TRANSPORT = "codex_exec_cli";
export const CODEX_EXEC_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
export const CLAUDE_CODE_PROVIDER = "claude_cli";
export const CLAUDE_CODE_TRANSPORT = "claude_code_headless_print";
export const CLAUDE_CODE_EFFORTS = CODEX_EXEC_EFFORTS;

function sha256Text(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

async function refuseExistingOutput(outputPath) {
  // A passed output is immutable; refuse before spending a call rather than after.
  if (await fs.stat(outputPath).then(() => true, () => false)) {
    throw new Error(`EEXIST: ${outputPath} already exists; resume reuses it instead of submitting again.`);
  }
}

function failedReceipt(common, error) {
  return {
    ...common,
    status: "failed",
    failed_at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
}

// `codex exec` in a read-only sandbox inside an empty scratch directory, ignoring the user's
// config.toml (auth still comes from CODEX_HOME), no session, one timeout, no retry. Flags were
// checked against `codex exec --help` (codex-cli 0.163.0).
export function codexExecExecutable() {
  const explicit = String(process.env.ANIFACTORY_CODEX_CLI_PATH ?? process.env.CODEX_CLI_PATH ?? "").trim();
  if (explicit) return explicit;
  const found = spawnSync("/usr/bin/which", ["codex"], { encoding: "utf8", timeout: 5_000 });
  return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : "codex";
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
    "--json",
    "-o", lastMessagePath,
    "-",
  ];
}

// Writes the raw output once and its .meta.json receipt, and returns { content, ...metadata }.
// `identity` (optional) supplies the transport-retry lock; without it the call has one attempt.
export async function runCodexExec({ prompt, stageName, outputPath, model, reasoningEffort, timeoutMs = 2_400_000, identity = null, transportBackoffMsForTests = null }) {
  await refuseExistingOutput(outputPath);
  const executable = codexExecExecutable();
  const startedAt = new Date().toISOString();
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-codex-exec-"));
  const lastMessagePath = path.join(workdir, "last_message.txt");
  const args = codexExecArgs({ model, effort: reasoningEffort, workdir, lastMessagePath });
  const version = executableVersion(executable);
  const common = {
    schema: CODEX_CALL_METADATA_SCHEMA,
    stage_name: stageName,
    provider: CODEX_EXEC_PROVIDER,
    transport: CODEX_EXEC_TRANSPORT,
    model: String(model).trim(),
    reasoning_effort: String(reasoningEffort).trim().toLowerCase(),
    sandbox: "read-only",
    codex_cli_path: executable,
    codex_cli_version: version?.version ?? null,
    cli_version: version?.version ?? null,
    prompt_sha256: sha256Text(prompt),
    output_path: outputPath,
    timeout_ms: timeoutMs,
    started_at: startedAt,
  };
  const retry = transportRetryPolicyForIdentity(identity);
  let callAttempts = [];
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    // The configured per-model floor (config/planner-models.json) is the first CLI release
    // whose bundled catalog lists the model; refuse an older CLI before any submission.
    const minimum = minimumCodexVersionForModel(model);
    if (minimum && minimum.version !== "0.0.0" && (!version || compareCodexVersions(version, minimum) < 0)) {
      throw new Error(`Codex CLI ${version?.version ?? "unknown"} at ${executable} is older than ${minimum.version}, the first release listing ${model}.`);
    }
    const call = await runCodexWithTransportRetry({
      executable, args, cwd: workdir, prompt, timeoutMs, label: `Codex ${stageName}`,
      outputPath, providerOutputPath: lastMessagePath, retry, backoffMsForTests: transportBackoffMsForTests,
    });
    callAttempts = call.attempts;
    const content = await fs.readFile(lastMessagePath, "utf8").catch(() => "");
    if (!content.trim()) throw new Error(`Codex ${stageName} returned no final message.`);
    await fs.writeFile(outputPath, content, { encoding: "utf8", flag: "wx" });
    const metadata = {
      ...common, status: "passed", ...codexUsageFields(call.events), ...attemptSummaryFields(retry, call.attempts),
      output_sha256: sha256Text(content), completed_at: new Date().toISOString(),
    };
    await writeMetadata(outputPath, metadata);
    return { content, outputPath, ...metadata };
  } catch (error) {
    await writeMetadata(outputPath, {
      ...failedReceipt(common, error),
      error_code: error?.code ?? null,
      failure_class: error?.failure_class ?? null,
      ...attemptSummaryFields(retry, error?.attempts ?? callAttempts),
    }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

// Claude Code headless print mode (`claude -p`), not the Anthropic API. Read-only: built-in
// tools, MCP servers, slash commands/skills and hooks are disabled, no session is persisted,
// no retry. Flags were checked against `claude --help` (Claude Code 2.1.302).
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

// One Claude print-envelope parser for both Claude transports.
export const claudeCodeResultFromStdout = claudeContentFromStdoutForTests;

// Same contract as runCodexCli: writes the raw output once and its .meta.json receipt and
// returns { content, ...metadata }. The receipt records provider, model and effort for resume checks.
export async function runClaudeCodePrint({ prompt, stageName, outputPath, model, reasoningEffort, timeoutMs = 2_400_000, cwd = process.cwd() }) {
  const executable = claudeCodeExecutable();
  const args = claudeCodePrintArgs({ model, effort: reasoningEffort });
  const startedAt = new Date().toISOString();
  const common = {
    schema: CODEX_CALL_METADATA_SCHEMA,
    stage_name: stageName,
    provider: CLAUDE_CODE_PROVIDER,
    transport: CLAUDE_CODE_TRANSPORT,
    model: String(model).trim(),
    reasoning_effort: String(reasoningEffort).trim().toLowerCase(),
    executable,
    args,
    prompt_sha256: sha256Text(prompt),
    output_path: outputPath,
    timeout_ms: timeoutMs,
    started_at: startedAt,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await refuseExistingOutput(outputPath);
  try {
    const call = spawnCliWithPrompt({ executable, args, cwd, prompt, timeoutMs, label: `Claude Code ${stageName}`, killGrace: false });
    await call.done;
    const parsed = claudeCodeResultFromStdout(call.output().stdout);
    await fs.writeFile(outputPath, parsed.content, { encoding: "utf8", flag: "wx" });
    const version = claudeCliVersion(executable);
    const metadata = {
      ...common,
      status: "passed",
      claude_cli_version: version,
      cli_version: version,
      ...usageFields(parsed.envelope),
      provider_conversation_id: parsed.envelope?.session_id ?? null,
      output_sha256: sha256Text(parsed.content),
      completed_at: new Date().toISOString(),
    };
    await writeMetadata(outputPath, metadata);
    return { content: parsed.content, outputPath, ...metadata };
  } catch (error) {
    await writeMetadata(outputPath, failedReceipt(common, error)).catch(() => {});
    throw error;
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
  transportBackoffMsForTests = null,
} = {}) {
  if (!outputPath) throw new Error("runCodexCli requires outputPath.");
  const planningRuntime = planningRuntimeFromProcessContext({
    explicitProvider: provider,
    explicitModel: model,
    overrideStage: planningOverrideStage ?? stageName,
  });
  const resolvedModel = planningRuntime.model;
  const resolvedEffort = planningEffortForStage(stageName, { explicitEffort: reasoningEffort, runtime: planningRuntime });
  const executionPolicy = plannerStageExecutionPolicy(stageName);
  const effectiveTimeoutMs = planningRuntime.provider === "chatgpt_web" && executionPolicy.advisory
    ? Math.min(Number(timeoutMs) || executionPolicy.max_timeout_ms, executionPolicy.max_timeout_ms)
    : timeoutMs;
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
      timeoutMs: effectiveTimeoutMs,
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
  if (planningRuntime.provider === "claude_cli") {
    return runClaudeCompletion({
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
    "--json",
    "-o",
    outputPath,
  ];
  const retry = transportRetryPolicyForIdentity(planningRuntime.identity);
  let callAttempts = [];
  try {
    const call = await runCodexWithTransportRetry({
      executable: runtime.executable, args, cwd, prompt, timeoutMs, label: `Codex ${stageName}`, detached,
      outputPath, providerOutputPath: outputPath, retry, backoffMsForTests: transportBackoffMsForTests,
    });
    callAttempts = call.attempts;
    // With --json, stdout carries events rather than the answer; the `-o` file is the output.
    const content = await fs.readFile(outputPath, "utf8").catch(() => "");
    if (!content.trim()) throw new Error(`Codex ${stageName} returned no final message.`);
    const outputSha256 = createHash("sha256").update(content).digest("hex");
    const metadata = {
      schema: CODEX_CALL_METADATA_SCHEMA,
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
      cli_version: runtime.version,
      ...codexUsageFields(call.events),
      ...attemptSummaryFields(retry, call.attempts),
      prompt_sha256: promptHash,
      output_sha256: outputSha256,
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
      error_code: error?.code ?? null,
      failure_class: error?.failure_class ?? null,
      ...attemptSummaryFields(retry, error?.attempts ?? callAttempts),
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
    const result = await runCodexCliWithResolvedProvider({
      ...options,
      provider: slot?.provider ?? options.provider ?? null,
    });
    slot?.recordSuccess();
    return result;
  } catch (error) {
    slot?.recordFailure(error);
    throw error;
  } finally {
    slot?.release();
  }
}

export async function runOptionalPlannerAdvisory(options = {}) {
  const executionPolicy = plannerStageExecutionPolicy(options.stageName);
  if (!executionPolicy.advisory) {
    throw new Error(`Stage ${options.stageName ?? "unknown"} is not registered as an optional planner advisory.`);
  }
  try {
    const result = await runCodexCli({
      ...options,
      provider: "chatgpt_web",
      reasoningEffort: "medium",
      timeoutMs: Math.min(
        Number(options.timeoutMs) || executionPolicy.max_timeout_ms,
        executionPolicy.max_timeout_ms,
      ),
    });
    return { ...result, status: "passed", advisory: true, blocking: false };
  } catch (error) {
    return {
      schema: "goldflow_optional_planner_advisory_v1",
      status: "omitted",
      advisory: true,
      blocking: false,
      stage_name: options.stageName ?? null,
      provider: "chatgpt_web",
      reasoning_effort: "medium",
      timeout_ms: executionPolicy.max_timeout_ms,
      disposition: executionPolicy.timeout_disposition,
      content: null,
      error: error instanceof Error ? error.message : String(error),
    };
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
  if (planningRuntime.provider === "claude_cli") {
    const executable = String(process.env.ANIFACTORY_CLAUDE_CLI_PATH ?? "claude").trim();
    const version = claudeCliVersion(executable);
    if (!version) throw new Error(`Claude CLI is unavailable or unreadable: ${executable}`);
    return {
      status: "passed",
      provider: "claude_cli",
      transport: "claude_code_headless_cli",
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      planning_effort_policy: planningRuntime.effortPolicy,
      run_identity_path: planningRuntime.identityPath,
      claude_cli_path: executable,
      claude_cli_version: version,
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
