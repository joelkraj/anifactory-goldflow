#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QWEN_LIAM_PRIMARY_LOCK } from "./lib/narration-tts-policy.mjs";
import { hasTtsTerminalPunctuation } from "./lib/tts-text-boundaries.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PYTHON =
  "/Users/joel/AniFactoryData/voice_bank/bakeoff/"
  + ".venv-kokoro-mlx-audio-0.4.6/bin/python";
const DEFAULT_SIMILARITY_PYTHON =
  "/Users/joel/AniFactoryData/voice_bank/bakeoff/"
  + ".venv-speaker-similarity/bin/python";
const MODES = Object.freeze([
  Object.freeze({ mode_id: "serial", batch_size: 1 }),
  Object.freeze({ mode_id: "batch_2", batch_size: 2 }),
  Object.freeze({ mode_id: "batch_4", batch_size: 4 }),
]);

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[index + 1]
      : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function boolFlag(value, fallback = false) {
  if (value == null) return fallback;
  return /^(true|1|yes)$/iu.test(String(value));
}

function safeLabel(value) {
  const text = String(value ?? "").trim();
  if (!text || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(text)) {
    throw new Error(
      "--label must be 1-80 safe filename characters "
      + "(letters, numbers, dot, underscore, hyphen)",
    );
  }
  return text;
}

function words(value) {
  return String(value ?? "").trim().split(/\s+/u).filter(Boolean);
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}`,
  );
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

function run(command, args, { cwd = repoRoot, maxCaptureChars = 128 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-maxCaptureChars);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-maxCaptureChars);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(
        `${command} exited ${code ?? "null"} signal ${signal ?? "null"}\n`
        + `${stdout}\n${stderr}`,
      ));
    });
  });
}

async function commandOutput(command, args) {
  try {
    return (await run(command, args)).stdout.trim();
  } catch {
    return null;
  }
}

function isPathWithin(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertDiagnosticOutputPathForTests(outputDir, episodeDir) {
  const reviewRoot = path.resolve(
    episodeDir,
    "review_samples",
    "tts-throughput-bakeoff",
  );
  if (!isPathWithin(outputDir, reviewRoot) || path.resolve(outputDir) === reviewRoot) {
    throw new Error(
      "Throughput bake-off output must be a labeled child of "
      + "<episode>/review_samples/tts-throughput-bakeoff",
    );
  }
  return reviewRoot;
}

export function groupSimilarLengthUnitsForTests(units, batchSize) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("batchSize must be a positive integer");
  }
  const ordered = [...units].sort((left, right) => (
    Number(left.word_count) - Number(right.word_count)
    || Number(left.input_index) - Number(right.input_index)
    || String(left.unit_id).localeCompare(String(right.unit_id))
  ));
  const groups = [];
  for (let index = 0; index < ordered.length; index += batchSize) {
    const members = ordered.slice(index, index + batchSize);
    groups.push({
      group_id: `g${String(groups.length + 1).padStart(2, "0")}`,
      unit_ids: members.map((unit) => unit.unit_id),
      word_counts: members.map((unit) => unit.word_count),
      word_count_spread: Math.max(...members.map((unit) => unit.word_count))
        - Math.min(...members.map((unit) => unit.word_count)),
    });
  }
  return groups;
}

function lockFinding(sourceRun) {
  const expected = QWEN_LIAM_PRIMARY_LOCK;
  const checks = [
    ["provider", sourceRun.provider, expected.provider],
    ["model_id", sourceRun.model_id, expected.model_id],
    ["model_revision", sourceRun.model_revision, expected.model_revision],
    ["model_weights_sha256", sourceRun.model_weights_sha256, expected.model_weights_sha256],
    ["model_config_sha256", sourceRun.model_config_sha256, expected.model_config_sha256],
    ["voice_id", sourceRun.voice_id, expected.voice_id],
    ["voice_sha256", sourceRun.voice_sha256, expected.voice_sha256],
    [
      "voice_continuity_contract",
      sourceRun.voice_continuity_contract,
      expected.voice_continuity_contract,
    ],
    [
      "reference_audio_sha256",
      sourceRun.reference_audio_sha256,
      expected.reference_audio_sha256,
    ],
    [
      "reference_text_sha256",
      sourceRun.reference_text_sha256,
      expected.reference_text_sha256,
    ],
    [
      "mlx_audio_version",
      sourceRun.runtime?.mlx_audio_version,
      expected.runtime_version,
    ],
  ];
  const mismatch = checks.find(([, actual, wanted]) => actual !== wanted);
  return mismatch
    ? { field: mismatch[0], actual: mismatch[1], expected: mismatch[2] }
    : null;
}

export function validateSourceRunReportForTests(sourceRun, requestedUnitIds) {
  if (sourceRun?.schema !== "goldflow_local_tts_production_run_v1"
    || sourceRun?.status !== "passed") {
    throw new Error("Source must be a passed local production TTS run report");
  }
  if (Number(sourceRun.effective_concurrency) !== 1
    || Number(sourceRun.model_load_count) !== 1) {
    throw new Error("Source run is not the production serial/model-loaded-once baseline");
  }
  const mismatch = lockFinding(sourceRun);
  if (mismatch) {
    throw new Error(
      `Source run ${mismatch.field} is not pinned Qwen/Liam: `
      + `${mismatch.actual ?? "missing"} vs ${mismatch.expected}`,
    );
  }
  if (requestedUnitIds.length < 2 || requestedUnitIds.length > 8) {
    throw new Error("--unit-ids must contain 2-8 unique exact unit IDs");
  }
  if (new Set(requestedUnitIds).size !== requestedUnitIds.length) {
    throw new Error("--unit-ids contains duplicates");
  }
  const byId = new Map();
  for (const row of sourceRun.results ?? []) {
    const unitId = String(row?.unit_id ?? "");
    if (!unitId) continue;
    if (byId.has(unitId)) throw new Error(`Source run has duplicate unit ${unitId}`);
    byId.set(unitId, row);
  }
  const units = requestedUnitIds.map((unitId, inputIndex) => {
    const row = byId.get(unitId);
    if (!row || row.status === "failed" || !row.output_path || !row.output_sha256) {
      throw new Error(`Source run lacks a usable exact result for ${unitId}`);
    }
    const spokenText = String(row.spoken_text ?? "").trim();
    const wordCount = words(spokenText).length;
    if (!spokenText || wordCount > 60) {
      throw new Error(
        `Unit ${unitId} is empty or exceeds the 60-word production hard maximum`,
      );
    }
    if (!hasTtsTerminalPunctuation(spokenText)) {
      throw new Error(`Unit ${unitId} is not sentence-complete`);
    }
    const identity = row.synthesis_identity ?? {};
    if (identity.provider !== QWEN_LIAM_PRIMARY_LOCK.provider
      || identity.model_revision !== QWEN_LIAM_PRIMARY_LOCK.model_revision
      || identity.reference_audio_sha256
        !== QWEN_LIAM_PRIMARY_LOCK.reference_audio_sha256
      || identity.reference_text_sha256
        !== QWEN_LIAM_PRIMARY_LOCK.reference_text_sha256
      || identity.voice !== QWEN_LIAM_PRIMARY_LOCK.voice_id
      || identity.post_tts_tempo_processing !== false) {
      throw new Error(`Unit ${unitId} has stale or non-Liam synthesis identity`);
    }
    return {
      unit_id: unitId,
      input_index: inputIndex,
      spoken_text: spokenText,
      spoken_text_sha256: row.spoken_text_sha256,
      word_count: wordCount,
      serial_seed: Number(row.seed),
      source_audio_path: row.output_path,
      source_audio_sha256: row.output_sha256,
      source_generation_time_sec: Number(row.generation_time_sec ?? 0),
      source_duration_sec: Number(row.duration_sec ?? 0),
      source_status: row.status,
      source_synthesis_identity_sha256: row.synthesis_identity_sha256,
    };
  });
  return units;
}

function percentile(values, probability) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(probability * ordered.length) - 1),
  )];
}

export function summarizeBakeoffForTests(runnerReport, similarityReport = null) {
  const serial = (runnerReport?.modes ?? []).find((mode) => mode.mode_id === "serial");
  if (!serial) throw new Error("Runner report lacks serial baseline");
  const similarityByPath = new Map(
    (similarityReport?.candidates ?? [])
      .map((row) => [path.resolve(row.audio_path), row]),
  );
  return (runnerReport.modes ?? []).map((mode) => {
    const similarityRows = mode.units
      .map((unit) => similarityByPath.get(path.resolve(unit.output_path)))
      .filter(Boolean);
    const similarities = similarityRows.map((row) => Number(row.cosine_similarity));
    const audioThroughput = (
      Number(mode.audio_duration_sum_sec)
      / Math.max(Number(mode.model_call_wall_sec), 1e-9)
    );
    const serialAudioThroughput = (
      Number(serial.audio_duration_sum_sec)
      / Math.max(Number(serial.model_call_wall_sec), 1e-9)
    );
    const waveformRows = mode.units.map((unit) => unit.waveform_metrics ?? {});
    return {
      mode_id: mode.mode_id,
      requested_batch_size: mode.requested_batch_size,
      unit_count: mode.unit_count,
      audio_duration_sum_sec: mode.audio_duration_sum_sec,
      model_call_wall_sec: mode.model_call_wall_sec,
      end_to_end_wall_sec: mode.end_to_end_wall_sec,
      model_call_speedup_vs_serial: Number(
        (
          Number(serial.model_call_wall_sec)
          / Math.max(Number(mode.model_call_wall_sec), 1e-9)
        ).toFixed(6),
      ),
      end_to_end_speedup_vs_serial: Number(
        (
          Number(serial.end_to_end_wall_sec)
          / Math.max(Number(mode.end_to_end_wall_sec), 1e-9)
        ).toFixed(6),
      ),
      audio_throughput_x: Number(audioThroughput.toFixed(6)),
      audio_throughput_speedup_vs_serial: Number(
        (audioThroughput / Math.max(serialAudioThroughput, 1e-9)).toFixed(6),
      ),
      peak_memory_gib: Number(
        (Number(mode.peak_memory_bytes) / (1024 ** 3)).toFixed(3),
      ),
      exact_source_hash_match_count: mode.units.filter(
        (unit) => unit.matches_source_serial_wav_sha256,
      ).length,
      acoustic_metrics: {
        status: "diagnostic_metrics_only",
        clipping_sample_count: waveformRows.reduce(
          (sum, metrics) => sum + Number(metrics.clipping_sample_count ?? 0),
          0,
        ),
        units_with_large_sample_steps: waveformRows.filter(
          (metrics) => Number(metrics.large_sample_step_count ?? 0) > 0,
        ).length,
        units_with_isolated_impulses: waveformRows.filter(
          (metrics) => Number(metrics.isolated_impulse_count ?? 0) > 0,
        ).length,
        units_reaching_token_limit: mode.units.filter(
          (unit) => unit.token_limit_reached === true,
        ).length,
      },
      speaker_similarity: similarities.length
        ? {
            status: similarityRows.some((row) => row.status === "blocked")
              ? "blocked"
              : "passed",
            count: similarities.length,
            minimum: Math.min(...similarities),
            median: percentile(similarities, 0.5),
            mean: Number(
              (
                similarities.reduce((sum, value) => sum + value, 0)
                / similarities.length
              ).toFixed(6),
            ),
            warning_below_count: similarityRows.filter(
              (row) => row.warnings?.length,
            ).length,
            blocked_count: similarityRows.filter(
              (row) => row.status === "blocked",
            ).length,
          }
        : {
            status: "not_run",
            count: 0,
          },
    };
  });
}

function reportMarkdown(report) {
  const lines = [
    "# Qwen/Liam throughput bake-off",
    "",
    `Status: \`${report.status}\``,
    "",
    "This is an isolated diagnostic. Production remains serial Qwen/Liam "
      + "concurrency 1. Fixed batches do not preserve per-unit serial RNG "
      + "streams and are not production-eligible from latency alone.",
    "",
    "| Mode | Model-call sec | Wall speedup | Audio throughput | End-to-end sec | Peak GiB | Liam similarity | Source hash matches |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of report.summary) {
    const similarity = row.speaker_similarity.status === "not_run"
      ? "not run"
      : `${row.speaker_similarity.minimum.toFixed(3)} min / `
        + `${row.speaker_similarity.mean.toFixed(3)} mean`;
    lines.push(
      `| ${row.mode_id} | ${row.model_call_wall_sec.toFixed(3)} | `
      + `${row.model_call_speedup_vs_serial.toFixed(3)}x | `
      + `${row.audio_throughput_x.toFixed(3)}x `
      + `(${row.audio_throughput_speedup_vs_serial.toFixed(3)}x baseline) | `
      + `${row.end_to_end_wall_sec.toFixed(3)} | `
      + `${row.peak_memory_gib.toFixed(3)} | ${similarity} | `
      + `${row.exact_source_hash_match_count}/${row.unit_count} |`,
    );
  }
  lines.push(
    "",
    `Model load: ${report.runner.model_load_wall_sec.toFixed(3)} sec; `
      + `Liam waveform preload: ${report.runner.reference_load_wall_sec.toFixed(6)} sec.`,
    "",
    "Listening sequences insert 80 ms of zeros between untouched outputs. "
      + "They do not trim native endpoint silence and are not production stitches.",
    "",
    "Waveform checks count clipping, large sample steps, isolated impulses, "
      + "and generation token-cap hits. These metrics cannot rule out an "
      + "audible skip or stutter; listening remains required.",
    "",
  );
  for (const mode of report.runner.modes) {
    lines.push(
      `- ${mode.mode_id}: ${mode.listening_sequence_m4a_path ?? mode.listening_sequence_path}`,
    );
  }
  lines.push(
    "",
    "Adoption gate: listen for skips, truncations, stutters, pronunciation, "
      + "delivery, and voice continuity. ASR uncertainty alone must not select "
      + "or reject a mode.",
    "",
  );
  return lines.join("\n");
}

async function encodeListeningSequences(runnerReport) {
  const encoded = [];
  for (const mode of runnerReport.modes ?? []) {
    const outputPath = mode.listening_sequence_path.replace(/\.wav$/iu, ".m4a");
    const started = performance.now();
    await run("ffmpeg", [
      "-y",
      "-nostdin",
      "-v", "error",
      "-i", mode.listening_sequence_path,
      "-c:a", "aac",
      "-b:a", "160k",
      outputPath,
    ]);
    encoded.push({
      mode_id: mode.mode_id,
      output_path: outputPath,
      output_sha256: await sha256File(outputPath),
      encode_wall_sec: Number(((performance.now() - started) / 1000).toFixed(6)),
    });
  }
  return encoded;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!boolFlag(flags["workflow-bypass"])) {
    throw new Error(
      "tts throughput-bakeoff is diagnostic-only and requires "
      + "--workflow-bypass true",
    );
  }
  if (!flags["episode-dir"]) throw new Error("--episode-dir is required");
  if (!flags["source-run-report"]) {
    throw new Error("--source-run-report is required");
  }
  if (!flags["unit-ids"]) {
    throw new Error("--unit-ids is required with 2-8 exact comma-separated IDs");
  }
  const episodeDir = path.resolve(flags["episode-dir"]);
  const sourceRunPath = path.resolve(flags["source-run-report"]);
  const unitIds = String(flags["unit-ids"])
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const label = safeLabel(
    flags.label
      ?? `qwen-liam-batch-${new Date().toISOString().replace(/[-:.TZ]/gu, "")}`,
  );
  const outputDir = path.resolve(
    episodeDir,
    "review_samples",
    "tts-throughput-bakeoff",
    label,
  );
  const reviewRoot = assertDiagnosticOutputPathForTests(outputDir, episodeDir);
  const existing = await fs.readdir(outputDir).catch(() => []);
  if (existing.length) {
    throw new Error(
      `Refusing to overwrite existing throughput bake-off output: ${outputDir}`,
    );
  }

  const sourceRun = await readJson(sourceRunPath, null);
  const units = validateSourceRunReportForTests(sourceRun, unitIds);
  for (const unit of units) {
    if (await sha256File(unit.source_audio_path) !== unit.source_audio_sha256) {
      throw new Error(`Source serial audio hash mismatch for ${unit.unit_id}`);
    }
  }
  for (const [assetPath, expected, labelName] of [
    [
      QWEN_LIAM_PRIMARY_LOCK.reference_audio_path,
      QWEN_LIAM_PRIMARY_LOCK.reference_audio_sha256,
      "Liam reference",
    ],
    [
      QWEN_LIAM_PRIMARY_LOCK.speaker_similarity_model_path,
      QWEN_LIAM_PRIMARY_LOCK.speaker_similarity_model_sha256,
      "speaker similarity model",
    ],
  ]) {
    if (await sha256File(assetPath) !== expected) {
      throw new Error(`${labelName} hash mismatch`);
    }
  }

  const runnerPath = path.resolve(
    flags.runner
      ?? path.join(repoRoot, "scripts", "tts-qwen-throughput-bakeoff-runner.py"),
  );
  const python = path.resolve(
    flags.python
      ?? process.env.ANIFACTORY_LOCAL_TTS_PYTHON
      ?? DEFAULT_PYTHON,
  );
  const similarityPython = path.resolve(
    flags["similarity-python"]
      ?? process.env.ANIFACTORY_TTS_SIMILARITY_PYTHON
      ?? DEFAULT_SIMILARITY_PYTHON,
  );
  const similarityRunner = path.resolve(
    flags["similarity-runner"]
      ?? path.join(repoRoot, "scripts", "tts-speaker-similarity.py"),
  );
  for (const [filePath, labelName] of [
    [python, "Qwen Python"],
    [runnerPath, "throughput runner"],
    [similarityPython, "similarity Python"],
    [similarityRunner, "similarity runner"],
  ]) {
    if (!(await fs.stat(filePath).catch(() => null))?.isFile()) {
      throw new Error(`${labelName} is missing: ${filePath}`);
    }
  }

  await fs.mkdir(outputDir, { recursive: true });
  const sourceRunSha256 = await sha256File(sourceRunPath);
  const gitHead = await commandOutput("git", ["rev-parse", "HEAD"]);
  const gitStatus = await commandOutput("git", ["status", "--porcelain=v1", "-z"]);
  const modes = MODES.map((mode) => ({
    ...mode,
    groups: mode.mode_id === "serial"
      ? units.map((unit, index) => ({
          group_id: `g${String(index + 1).padStart(2, "0")}`,
          unit_ids: [unit.unit_id],
          word_counts: [unit.word_count],
          word_count_spread: 0,
        }))
      : groupSimilarLengthUnitsForTests(units, mode.batch_size),
  }));
  const manifestPath = path.join(outputDir, "manifest.json");
  const runnerReportPath = path.join(outputDir, "runner-report.json");
  const manifest = {
    schema: "goldflow_qwen_throughput_bakeoff_manifest_v1",
    status: "ready",
    diagnostic_only: true,
    production_eligible: false,
    production_default_unchanged: true,
    created_at: new Date().toISOString(),
    episode_dir: episodeDir,
    review_root: reviewRoot,
    output_dir: outputDir,
    source_run_report_path: sourceRunPath,
    source_run_report_sha256: sourceRunSha256,
    source_jobs_path: sourceRun.jobs_path ?? null,
    source_jobs_sha256: sourceRun.jobs_sha256 ?? null,
    selected_units: units,
    modes,
    model: {
      provider: QWEN_LIAM_PRIMARY_LOCK.provider,
      model_id: QWEN_LIAM_PRIMARY_LOCK.model_id,
      source: QWEN_LIAM_PRIMARY_LOCK.model_id,
      revision: QWEN_LIAM_PRIMARY_LOCK.model_revision,
      weights_sha256: QWEN_LIAM_PRIMARY_LOCK.model_weights_sha256,
      config_sha256: QWEN_LIAM_PRIMARY_LOCK.model_config_sha256,
      sample_rate_hz: QWEN_LIAM_PRIMARY_LOCK.sample_rate_hz,
    },
    reference: {
      voice_id: QWEN_LIAM_PRIMARY_LOCK.voice_id,
      voice_sha256: QWEN_LIAM_PRIMARY_LOCK.voice_sha256,
      audio_path: QWEN_LIAM_PRIMARY_LOCK.reference_audio_path,
      audio_sha256: QWEN_LIAM_PRIMARY_LOCK.reference_audio_sha256,
      text: QWEN_LIAM_PRIMARY_LOCK.reference_text,
      text_sha256: QWEN_LIAM_PRIMARY_LOCK.reference_text_sha256,
      continuity_contract: QWEN_LIAM_PRIMARY_LOCK.voice_continuity_contract,
    },
    generation_parameters: {
      temperature: QWEN_LIAM_PRIMARY_LOCK.temperature,
      top_p: QWEN_LIAM_PRIMARY_LOCK.top_p,
      top_k: QWEN_LIAM_PRIMARY_LOCK.top_k,
      repetition_penalty: QWEN_LIAM_PRIMARY_LOCK.repetition_penalty,
      max_tokens: QWEN_LIAM_PRIMARY_LOCK.max_tokens,
      native_speed: null,
      post_tts_tempo_processing: false,
    },
    runtime: {
      mlx_audio_version: QWEN_LIAM_PRIMARY_LOCK.runtime_version,
      python_path: python,
      runner_path: runnerPath,
      runner_sha256: await sha256File(runnerPath),
    },
    production_default: {
      provider: "qwen_local",
      model_id: QWEN_LIAM_PRIMARY_LOCK.model_id,
      voice_id: QWEN_LIAM_PRIMARY_LOCK.voice_id,
      concurrency: 1,
      unit_target_words: "45-60",
      hard_max_words: 60,
      join_ms: 80,
      continuous_longform_requests: false,
      post_tempo_processing: false,
    },
    stochastic_contract: {
      serial_per_unit_seed_preserved: true,
      fixed_batch_per_unit_seed_preserved: false,
      batch_seed_policy: "sha256(mode_id,group_id,unit_ids,serial_seeds)",
      warning: (
        "mlx-audio batch_generate exposes one global MLX RNG and no "
        + "per-sequence seeds. Batch outputs are deterministic by group but "
        + "are not expected to reproduce serial unit samples."
      ),
    },
    api_contract: {
      fixed_batch_api: "Model.batch_generate",
      fixed_batch_icl_expected_supported: true,
      continuous_batch_icl_expected_supported: false,
      shared_reference_required: true,
      batch_icl_text_derived_max_token_cap_expected: true,
    },
    listening_sequence: {
      inserted_gap_sec: 0.08,
      production_stitch_equivalent: false,
      no_trimming_or_tempo_processing: true,
    },
    provenance: {
      git_commit: gitHead,
      git_status_sha256: gitStatus == null
        ? null
        : createHash("sha256").update(gitStatus).digest("hex"),
      worktree_dirty: Boolean(gitStatus),
      command: process.argv.map((value) => (
        value === QWEN_LIAM_PRIMARY_LOCK.reference_text ? "<reference-text>" : value
      )),
    },
  };
  await writeJson(manifestPath, manifest);
  if (boolFlag(flags["plan-only"])) {
    console.log(JSON.stringify({
      status: "planned_diagnostic_only",
      manifest_path: manifestPath,
      selected_unit_count: units.length,
      production_default_unchanged: true,
    }, null, 2));
    return;
  }

  const runnerStarted = performance.now();
  await run(python, [
    runnerPath,
    "--manifest", manifestPath,
    "--report", runnerReportPath,
  ], { maxCaptureChars: 512 * 1024 });
  const runnerWallSec = Number(((performance.now() - runnerStarted) / 1000).toFixed(6));
  const runnerReport = await readJson(runnerReportPath, null);
  if (runnerReport?.schema !== "goldflow_qwen_throughput_bakeoff_run_v1"
    || runnerReport?.status !== "passed"
    || runnerReport?.manifest_sha256 !== await sha256File(manifestPath)
    || runnerReport?.production_default_unchanged !== true) {
    throw new Error(`Invalid throughput runner report: ${runnerReportPath}`);
  }
  const allOutputPaths = runnerReport.modes.flatMap(
    (mode) => mode.units.map((unit) => unit.output_path),
  );
  for (const mode of runnerReport.modes) {
    for (const unit of mode.units) {
      if (!isPathWithin(unit.output_path, outputDir)
        || unit.output_sha256 !== await sha256File(unit.output_path)) {
        throw new Error(`Invalid isolated output for ${mode.mode_id}/${unit.unit_id}`);
      }
    }
  }

  const listeningEncodes = await encodeListeningSequences(runnerReport);
  for (const mode of runnerReport.modes) {
    const encode = listeningEncodes.find((row) => row.mode_id === mode.mode_id);
    mode.listening_sequence_m4a_path = encode.output_path;
    mode.listening_sequence_m4a_sha256 = encode.output_sha256;
    mode.listening_sequence_m4a_encode_wall_sec = encode.encode_wall_sec;
  }

  const speakerQaEnabled = boolFlag(flags["speaker-qa"], true);
  const similarityPath = path.join(outputDir, "speaker-similarity.json");
  let similarityReport = null;
  let similarityWallSec = null;
  if (speakerQaEnabled) {
    const similarityStarted = performance.now();
    await run(similarityPython, [
      similarityRunner,
      "--model", QWEN_LIAM_PRIMARY_LOCK.speaker_similarity_model_path,
      "--reference", QWEN_LIAM_PRIMARY_LOCK.reference_audio_path,
      ...allOutputPaths.flatMap((outputPath) => ["--candidate", outputPath]),
      "--output", similarityPath,
      "--minimum-similarity",
      String(QWEN_LIAM_PRIMARY_LOCK.minimum_cosine_similarity),
      "--warning-below-similarity",
      String(QWEN_LIAM_PRIMARY_LOCK.warning_below_cosine_similarity),
      "--reference-voice-id", QWEN_LIAM_PRIMARY_LOCK.reference_voice_id,
      "--reference-voice-sha256", QWEN_LIAM_PRIMARY_LOCK.reference_voice_sha256,
    ]);
    similarityWallSec = Number(
      ((performance.now() - similarityStarted) / 1000).toFixed(6),
    );
    similarityReport = await readJson(similarityPath, null);
    if (!["passed", "blocked"].includes(similarityReport?.status)
      || similarityReport?.model_sha256
        !== QWEN_LIAM_PRIMARY_LOCK.speaker_similarity_model_sha256
      || similarityReport?.candidate_count !== allOutputPaths.length) {
      throw new Error(`Invalid speaker similarity report: ${similarityPath}`);
    }
  }

  const summary = summarizeBakeoffForTests(runnerReport, similarityReport);
  const report = {
    schema: "goldflow_qwen_throughput_bakeoff_report_v1",
    status: similarityReport?.status === "blocked"
      ? "completed_with_voice_identity_blockers"
      : "completed_requires_listening",
    diagnostic_only: true,
    production_eligible: false,
    production_default_unchanged: true,
    created_at: new Date().toISOString(),
    output_dir: outputDir,
    manifest_path: manifestPath,
    manifest_sha256: await sha256File(manifestPath),
    runner_report_path: runnerReportPath,
    runner_report_sha256: await sha256File(runnerReportPath),
    runner_process_wall_sec: runnerWallSec,
    runner: runnerReport,
    listening_encodes: listeningEncodes,
    speaker_similarity: {
      enabled: speakerQaEnabled,
      report_path: similarityReport ? similarityPath : null,
      report_sha256: similarityReport ? await sha256File(similarityPath) : null,
      wall_sec: similarityWallSec,
      report: similarityReport,
    },
    summary,
    measured_claim_policy: {
      speedups_derive_only_from_current_run: true,
      no_projected_speedup_reported_as_actual: true,
      source_report_generation_time_is_context_only: true,
      acoustic_waveform_metrics_recorded_per_output: true,
      asr_run: false,
      asr_policy: "not_run_in_throughput_harness; uncertain_asr_never_selects_mode",
    },
    adoption_gate: {
      status: "operator_listening_required",
      production_concurrency_remains: 1,
      production_default_change_authorized: false,
      required_review: [
        "all three listening sequences",
        "skips truncations and stutters",
        "pronunciation and sentence-final completion",
        "Liam identity and delivery steadiness",
        "waveform metrics and speaker similarity",
        "measured latency and peak memory",
      ],
    },
  };
  const reportPath = path.join(outputDir, "report.json");
  const markdownPath = path.join(outputDir, "report.md");
  await writeJson(reportPath, report);
  await fs.writeFile(markdownPath, reportMarkdown(report), "utf8");
  console.log(JSON.stringify({
    status: report.status,
    diagnostic_only: true,
    production_default_unchanged: true,
    report_path: reportPath,
    markdown_path: markdownPath,
    summary,
  }, null, 2));
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
