import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  LocalWhisperPythonUnresolvedError,
  PINNED_LOCAL_WHISPER_PYTHON,
  localWhisperPython,
} from "../lib/local-whisper-policy.mjs";
import {
  narrationRuntimeFingerprintMismatch,
  narrationRuntimePreflightGateField,
  resolveNarrationRuntimeTools,
  runNarrationRuntimePreflight,
} from "../lib/narration-runtime-preflight.mjs";
import {
  buildNarrationPreSynthesisGate,
  narrationPreSynthesisGateSha256,
} from "../lib/narration-pre-synthesis-gate.mjs";


async function fakeInterpreter(name, body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-runtime-preflight-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

// A fake interpreter that behaves like the Homebrew python3 the a12 crash hit:
// it starts, but `import faster_whisper` is missing.
const MISSING_FASTER_WHISPER = `cat <<JSON
{"executable": "$0", "prefix": "/fake", "version": "3.15.0", "modules": {}, "missing": [{"module": "faster_whisper", "error": "ModuleNotFoundError: No module named 'faster_whisper'"}]}
JSON`;
const ALL_PRESENT = `cat <<JSON
{"executable": "$0", "prefix": "/fake", "version": "3.14.5", "modules": {"faster_whisper": "1.2.1", "mlx": "0.32.0", "mlx_audio": "0.4.6", "sherpa_onnx": "1.13.4", "numpy": "2.5.1", "soundfile": "0.14.0"}, "missing": []}
JSON`;

test("localWhisperPython never falls back to a bare python3 in production", () => {
  assert.equal(localWhisperPython({}, () => true), PINNED_LOCAL_WHISPER_PYTHON);
  assert.equal(localWhisperPython({ ANIFACTORY_ASR_PYTHON: "/x/py" }, () => false), "/x/py");
  assert.throws(() => localWhisperPython({}, () => false), LocalWhisperPythonUnresolvedError);
  assert.equal(localWhisperPython({}, () => false, { allowPathFallback: true }), "python3");
  assert.equal(
    localWhisperPython({ ANIFACTORY_ASR_PYTHON_DIAGNOSTIC_PATH_FALLBACK: "true" }, () => false),
    "python3",
  );
});

test("an unresolved ASR interpreter is a hard finding, not a silent fallback", () => {
  const resolved = resolveNarrationRuntimeTools({ env: { PATH: "" }, exists: () => false });
  assert.equal(resolved.tools.asr_python.requested_path, null);
  assert.deepEqual(resolved.findings.map((row) => row.code), ["runtime_interpreter_unresolved"]);
});

test("an interpreter lacking faster_whisper blocks the preflight and the gate before synthesis", async () => {
  const asr = await fakeInterpreter("python3", MISSING_FASTER_WHISPER);
  const ok = await fakeInterpreter("python", ALL_PRESENT);
  const report = await runNarrationRuntimePreflight({
    env: { PATH: process.env.PATH },
    asrPython: asr,
    ttsPython: ok,
    similarityPython: ok,
    requiredTools: ["asr_python", "tts_python", "similarity_python"],
  });
  assert.equal(report.status, "blocked");
  assert.deepEqual(
    report.findings.map((row) => [row.code, row.tool, row.module]),
    [["runtime_import_failed", "asr_python", "faster_whisper"]],
  );
  assert.equal(report.model_load_performed, false);
  assert.match(report.fingerprint_sha256, /^[a-f0-9]{64}$/u);

  const gate = buildNarrationPreSynthesisGate({
    plan: { schema: "goldflow_tts_generation_plan_v2", status: "passed", units: [] },
    runtimePreflight: narrationRuntimePreflightGateField(report),
  });
  assert.equal(gate.status, "blocked");
  assert.ok(gate.findings.some((row) => row.code === "pre_synthesis_runtime_preflight_blocked"));
  assert.equal(gate.runtime_preflight.status, "blocked");
  assert.equal(gate.runtime_preflight.tools.asr_python.modules.faster_whisper, undefined);
});

test("a complete runtime passes and its fingerprint binds interpreter identity", async () => {
  const ok = await fakeInterpreter("python", ALL_PRESENT);
  const report = await runNarrationRuntimePreflight({
    env: { PATH: process.env.PATH },
    asrPython: ok, ttsPython: ok, similarityPython: ok,
    requiredTools: ["asr_python", "tts_python", "similarity_python"],
  });
  assert.equal(report.status, "passed");
  assert.deepEqual(report.findings, []);
  assert.equal(report.tools.asr_python.modules.faster_whisper, "1.2.1");
  const field = narrationRuntimePreflightGateField(report);
  assert.deepEqual(Object.keys(field).sort(), ["findings", "fingerprint_sha256", "policy", "schema", "status", "tools"]);
  assert.equal(field.tools.asr_python.elapsed_ms, undefined);

  const changed = structuredClone(report);
  changed.tools.asr_python.modules.faster_whisper = "1.3.0";
  changed.fingerprint_sha256 = "0".repeat(64);
  const mismatch = narrationRuntimeFingerprintMismatch({ runtime_preflight: field }, changed);
  assert.equal(mismatch.code, "narration_runtime_fingerprint_mismatch");
  assert.deepEqual(mismatch.changed.map((row) => [row.tool, row.field]), [["asr_python", "modules"]]);
  assert.equal(narrationRuntimeFingerprintMismatch({ runtime_preflight: field }, report), null);
  assert.equal(narrationRuntimeFingerprintMismatch({ bindings: {} }, report), null, "legacy gates never compare");
});

test("a missing interpreter path and a missing binary fail closed", async () => {
  const report = await runNarrationRuntimePreflight({
    env: { PATH: "/nonexistent" },
    asrPython: "/nonexistent/python3.14",
    ttsPython: "/nonexistent/python",
    similarityPython: "/nonexistent/python",
    ffmpeg: "ffmpeg", ffprobe: "ffprobe",
  });
  assert.equal(report.status, "blocked");
  assert.deepEqual(
    [...new Set(report.findings.map((row) => row.code))].sort(),
    ["runtime_binary_missing", "runtime_interpreter_missing"],
  );
});

test("gates built without a runtime fingerprint hash exactly as before (legacy-safe)", () => {
  const inputs = {
    plan: { schema: "goldflow_tts_generation_plan_v2", status: "passed", units: [] },
    generatedAt: "2026-10-20T00:00:00.000Z",
  };
  const legacy = buildNarrationPreSynthesisGate(inputs);
  assert.equal(Object.hasOwn(legacy, "runtime_preflight"), false);
  assert.equal(legacy.gate_sha256, narrationPreSynthesisGateSha256(legacy));
  const fingerprinted = buildNarrationPreSynthesisGate({
    ...inputs,
    runtimePreflight: { schema: "x", status: "passed", fingerprint_sha256: "a".repeat(64), tools: {}, findings: [] },
  });
  assert.notEqual(fingerprinted.gate_sha256, legacy.gate_sha256);
  assert.equal(fingerprinted.status, legacy.status);
});

