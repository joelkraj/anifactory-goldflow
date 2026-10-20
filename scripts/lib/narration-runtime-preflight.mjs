import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  LOCAL_WHISPER_PYTHON_ENV,
  LocalWhisperPythonUnresolvedError,
  localWhisperPython,
} from "./local-whisper-policy.mjs";

// Stabilization roadmap R04: resolve one explicit interpreter per narration
// tool and import its runtime modules before any model load. The result is a
// hash-bound fingerprint recorded as an additive pre-synthesis gate field (new
// runs) or as its own append-only receipt (`tts preflight-runtime`). Gates that
// lack the field read as legacy and stay valid; nothing is folded into their
// existing hashes.

export const NARRATION_RUNTIME_PREFLIGHT_SCHEMA =
  "goldflow_narration_runtime_preflight_v1";
export const NARRATION_RUNTIME_PREFLIGHT_POLICY =
  "explicit_interpreter_per_tool_import_before_model_load_v1";

export const DEFAULT_TTS_PYTHON =
  "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-kokoro-mlx-audio-0.4.6/bin/python";
export const DEFAULT_SIMILARITY_PYTHON =
  "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-speaker-similarity/bin/python";

export const NARRATION_RUNTIME_TOOLS = Object.freeze({
  asr_python: Object.freeze({
    kind: "python",
    required_modules: Object.freeze(["faster_whisper"]),
    purpose: "per-unit and full-stream Whisper QA, word timing",
  }),
  tts_python: Object.freeze({
    kind: "python",
    required_modules: Object.freeze(["mlx", "mlx_audio"]),
    purpose: "Qwen local synthesis runner",
  }),
  similarity_python: Object.freeze({
    kind: "python",
    required_modules: Object.freeze(["sherpa_onnx", "numpy", "soundfile"]),
    purpose: "speaker-similarity embeddings",
  }),
  ffmpeg: Object.freeze({ kind: "binary", purpose: "stitch, mastering, encode" }),
  ffprobe: Object.freeze({ kind: "binary", purpose: "audio inspection" }),
});

const execFileAsync = promisify(execFile);

const PYTHON_PROBE = String.raw`
import importlib, json, os, sys
modules = sys.argv[1:]
out = {"executable": os.path.realpath(sys.executable), "prefix": os.path.realpath(sys.prefix), "version": sys.version.split()[0], "modules": {}, "missing": []}
for name in modules:
    try:
        module = importlib.import_module(name)
        version = getattr(module, "__version__", None)
        if version is None:
            try:
                import importlib.metadata as metadata
                version = metadata.version(name.replace("_", "-"))
            except Exception:
                version = None
        out["modules"][name] = str(version) if version else "unknown"
    except BaseException as error:
        out["missing"].append({"module": name, "error": f"{type(error).__name__}: {error}"[:400]})
print(json.dumps(out))
`;

function canonicalize(value, omittedKeys = new Set()) {
  if (Array.isArray(value)) return value.map((child) => canonicalize(child, omittedKeys));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !omittedKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child, omittedKeys)]),
  );
}

export function narrationRuntimeFingerprintSha256(report) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(
      report?.tools ?? {},
      new Set(["elapsed_ms", "requested_path"]),
    )))
    .digest("hex");
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

async function resolveOnPath(name, env) {
  const candidates = String(env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of candidates) {
    const candidate = path.join(directory, name);
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return null;
}

export function resolveNarrationRuntimeTools({
  env = process.env,
  asrPython = null,
  ttsPython = null,
  similarityPython = null,
  ffmpeg = null,
  ffprobe = null,
  exists = undefined,
  allowAsrPathFallback = false,
} = {}) {
  const findings = [];
  let resolvedAsr = null;
  try {
    resolvedAsr = String(asrPython ?? "").trim()
      || localWhisperPython(env, exists, { allowPathFallback: allowAsrPathFallback });
  } catch (error) {
    if (!(error instanceof LocalWhisperPythonUnresolvedError)) throw error;
    findings.push({
      code: "runtime_interpreter_unresolved",
      tool: "asr_python",
      detail: error.message,
    });
  }
  return {
    tools: {
      asr_python: {
        requested_path: resolvedAsr,
        source: String(asrPython ?? "").trim()
          ? "flag"
          : String(env[LOCAL_WHISPER_PYTHON_ENV] ?? "").trim()
            ? `env:${LOCAL_WHISPER_PYTHON_ENV}`
            : resolvedAsr === "python3"
              ? "diagnostic_path_fallback"
              : resolvedAsr
                ? "pinned_homebrew_python3_14"
                : null,
      },
      tts_python: {
        requested_path: String(ttsPython ?? env.ANIFACTORY_LOCAL_TTS_PYTHON ?? DEFAULT_TTS_PYTHON).trim(),
        source: String(ttsPython ?? "").trim()
          ? "flag"
          : env.ANIFACTORY_LOCAL_TTS_PYTHON ? "env:ANIFACTORY_LOCAL_TTS_PYTHON" : "pinned_tts_venv",
      },
      similarity_python: {
        requested_path: String(similarityPython ?? env.ANIFACTORY_TTS_SIMILARITY_PYTHON
          ?? DEFAULT_SIMILARITY_PYTHON).trim(),
        source: String(similarityPython ?? "").trim()
          ? "flag"
          : env.ANIFACTORY_TTS_SIMILARITY_PYTHON
            ? "env:ANIFACTORY_TTS_SIMILARITY_PYTHON"
            : "pinned_similarity_venv",
      },
      ffmpeg: { requested_path: String(ffmpeg ?? "ffmpeg").trim(), source: ffmpeg ? "flag" : "path" },
      ffprobe: { requested_path: String(ffprobe ?? "ffprobe").trim(), source: ffprobe ? "flag" : "path" },
    },
    findings,
  };
}

async function probePython(toolName, requested, requiredModules, { timeoutMs }) {
  const startedAt = Date.now();
  const row = {
    kind: "python",
    requested_path: requested,
    realpath: null,
    prefix: null,
    interpreter_sha256: null,
    version: null,
    modules: {},
    status: "blocked",
    findings: [],
  };
  if (!requested) {
    row.findings.push({ code: "runtime_interpreter_unresolved", tool: toolName });
    return row;
  }
  const isPath = requested.includes(path.sep);
  const stat = isPath ? await fs.stat(requested).catch(() => null) : null;
  if (isPath && !stat?.isFile()) {
    row.findings.push({ code: "runtime_interpreter_missing", tool: toolName, path: requested });
    return row;
  }
  try {
    const { stdout } = await execFileAsync(requested, ["-I", "-c", PYTHON_PROBE, ...requiredModules], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONNOUSERSITE: "1" },
    });
    const probe = JSON.parse(String(stdout).trim().split("\n").at(-1));
    row.realpath = probe.executable;
    row.prefix = probe.prefix ?? null;
    row.version = probe.version;
    row.modules = probe.modules ?? {};
    for (const missing of probe.missing ?? []) {
      row.findings.push({
        code: "runtime_import_failed",
        tool: toolName,
        module: missing.module,
        detail: missing.error,
      });
    }
  } catch (error) {
    row.findings.push({
      code: "runtime_interpreter_probe_failed",
      tool: toolName,
      detail: String(error?.stderr || error?.message || error).slice(-600),
    });
  }
  if (row.realpath) {
    row.interpreter_sha256 = await sha256File(row.realpath).catch(() => null);
    if (!row.interpreter_sha256) {
      row.findings.push({ code: "runtime_interpreter_unreadable", tool: toolName, path: row.realpath });
    }
  }
  row.status = row.findings.length ? "blocked" : "passed";
  row.elapsed_ms = Date.now() - startedAt;
  return row;
}

async function probeBinary(toolName, requested, env, { timeoutMs }) {
  const startedAt = Date.now();
  const row = {
    kind: "binary",
    requested_path: requested,
    realpath: null,
    binary_sha256: null,
    version: null,
    status: "blocked",
    findings: [],
  };
  const located = requested.includes(path.sep)
    ? requested
    : await resolveOnPath(requested, env);
  if (!located || !(await fs.stat(located).catch(() => null))?.isFile()) {
    row.findings.push({ code: "runtime_binary_missing", tool: toolName, path: requested });
    return row;
  }
  try {
    row.realpath = await fs.realpath(located);
    row.binary_sha256 = await sha256File(row.realpath);
    const { stdout } = await execFileAsync(located, ["-version"], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    row.version = String(stdout).split("\n")[0].trim() || null;
  } catch (error) {
    row.findings.push({
      code: "runtime_binary_probe_failed",
      tool: toolName,
      detail: String(error?.message ?? error).slice(-400),
    });
  }
  row.status = row.findings.length ? "blocked" : "passed";
  row.elapsed_ms = Date.now() - startedAt;
  return row;
}

export async function runNarrationRuntimePreflight({
  env = process.env,
  asrPython = null,
  ttsPython = null,
  similarityPython = null,
  ffmpeg = null,
  ffprobe = null,
  tools = NARRATION_RUNTIME_TOOLS,
  requiredTools = Object.keys(NARRATION_RUNTIME_TOOLS),
  timeoutMs = 60_000,
  generatedAt = new Date().toISOString(),
  allowAsrPathFallback = false,
} = {}) {
  const resolved = resolveNarrationRuntimeTools({
    env, asrPython, ttsPython, similarityPython, ffmpeg, ffprobe, allowAsrPathFallback,
  });
  const probes = await Promise.all(requiredTools.map(async (toolName) => {
    const spec = tools[toolName];
    const requested = resolved.tools[toolName]?.requested_path ?? null;
    const row = spec.kind === "python"
      ? await probePython(toolName, requested, spec.required_modules, { timeoutMs })
      : await probeBinary(toolName, requested, env, { timeoutMs });
    row.source = resolved.tools[toolName]?.source ?? null;
    row.purpose = spec.purpose;
    if (spec.kind === "python") row.required_modules = [...spec.required_modules];
    return [toolName, row];
  }));
  const report = {
    schema: NARRATION_RUNTIME_PREFLIGHT_SCHEMA,
    policy: NARRATION_RUNTIME_PREFLIGHT_POLICY,
    generated_at: generatedAt,
    status: "pending",
    model_load_performed: false,
    tools: Object.fromEntries(probes),
    findings: [
      ...resolved.findings,
      ...probes.flatMap(([, row]) => row.findings),
    ],
  };
  report.status = report.findings.length ? "blocked" : "passed";
  report.fingerprint_sha256 = narrationRuntimeFingerprintSha256(report);
  return report;
}

// The additive gate field: enough to compare at resume and to show in status,
// never the probe timings.
export function narrationRuntimePreflightGateField(report) {
  if (!report) return null;
  return {
    schema: report.schema,
    policy: report.policy,
    status: report.status,
    fingerprint_sha256: report.fingerprint_sha256,
    tools: Object.fromEntries(Object.entries(report.tools ?? {}).map(([name, row]) => [name, {
      realpath: row.realpath ?? null,
      ...(row.kind === "python"
        ? { prefix: row.prefix ?? null, interpreter_sha256: row.interpreter_sha256 ?? null, version: row.version ?? null, modules: row.modules ?? {} }
        : { binary_sha256: row.binary_sha256 ?? null, version: row.version ?? null }),
    }])),
    findings: structuredClone(report.findings ?? []),
  };
}

// Only runs whose retained gate carries the field compare at resume; a gate
// without it is legacy and is never reinterpreted.
export function narrationRuntimeFingerprintMismatch(priorGate, currentReport) {
  const prior = priorGate?.runtime_preflight;
  if (!prior?.fingerprint_sha256 || !currentReport?.fingerprint_sha256) return null;
  if (prior.fingerprint_sha256 === currentReport.fingerprint_sha256) return null;
  const changed = [];
  for (const [name, row] of Object.entries(currentReport.tools ?? {})) {
    const before = prior.tools?.[name] ?? null;
    const fields = ["realpath", "prefix", "interpreter_sha256", "binary_sha256", "version"];
    for (const field of fields) {
      if (JSON.stringify(before?.[field] ?? null) !== JSON.stringify(row?.[field] ?? null)) {
        changed.push({ tool: name, field, prior: before?.[field] ?? null, current: row?.[field] ?? null });
      }
    }
    if (JSON.stringify(before?.modules ?? null) !== JSON.stringify(row?.modules ?? null) && row?.kind === "python") {
      changed.push({ tool: name, field: "modules", prior: before?.modules ?? null, current: row?.modules ?? null });
    }
  }
  return {
    code: "narration_runtime_fingerprint_mismatch",
    prior_fingerprint_sha256: prior.fingerprint_sha256,
    current_fingerprint_sha256: currentReport.fingerprint_sha256,
    changed,
  };
}
