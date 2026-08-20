#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = "/Users/joel/AniFactoryData/voice_bank/proofs/2026-08-17-narration-v2-extreme-quality-v1";
const REFERENCE_MANIFEST = "/Users/joel/AniFactoryData/voice_bank/qwen/reference_samples/joel_narrator/manifest.json";
const PASSAGES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/audio/tts_bakeoff_passages.json",
);
const MODEL = {
  id: "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
  revision: "e7dd0585652209fa0d7783659aad4e8a324de11c",
};

const CONFIGS = {
  baseline_dry_batch4: {
    mode: "batch4",
    reference_id: "joel_ref_03_dry_deadpan",
    generation_parameters: { temperature: 0.6, top_p: 0.8, top_k: 50, repetition_penalty: 1.2, max_tokens: 1200 },
  },
  dry_precise_batch4: {
    mode: "batch4",
    reference_id: "joel_ref_03_dry_deadpan",
    generation_parameters: { temperature: 0.45, top_p: 0.75, top_k: 30, repetition_penalty: 1.12, max_tokens: 1200 },
  },
  tense_precise_batch4: {
    mode: "batch4",
    reference_id: "joel_ref_02_tense_narration",
    generation_parameters: { temperature: 0.45, top_p: 0.75, top_k: 30, repetition_penalty: 1.12, max_tokens: 1200 },
  },
  tense_balanced_batch4: {
    mode: "batch4",
    reference_id: "joel_ref_02_tense_narration",
    generation_parameters: { temperature: 0.5, top_p: 0.82, top_k: 40, repetition_penalty: 1.15, max_tokens: 1200 },
  },
  calm_balanced_batch4: {
    mode: "batch4",
    reference_id: "joel_ref_01_calm_narration",
    generation_parameters: { temperature: 0.5, top_p: 0.82, top_k: 40, repetition_penalty: 1.15, max_tokens: 1200 },
  },
  fast_balanced_batch4: {
    mode: "batch4",
    reference_id: "joel_ref_05_excited_fast",
    generation_parameters: { temperature: 0.5, top_p: 0.82, top_k: 40, repetition_penalty: 1.15, max_tokens: 1200 },
  },
  baseline_dry_serial: {
    mode: "serial",
    reference_id: "joel_ref_03_dry_deadpan",
    generation_parameters: { temperature: 0.6, top_p: 0.8, top_k: 50, repetition_penalty: 1.2, max_tokens: 1200 },
  },
  dry_balanced_batch4: {
    mode: "batch4",
    reference_id: "joel_ref_03_dry_deadpan",
    generation_parameters: { temperature: 0.5, top_p: 0.82, top_k: 40, repetition_penalty: 1.15, max_tokens: 1200 },
  },
};

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[++index]
      : "true";
    flags[key] = value;
  }
  return flags;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const phase = flags.phase ?? "screen";
  const proofRoot = path.resolve(flags["proof-root"] ?? DEFAULT_ROOT);
  const outputDir = path.join(proofRoot, phase, "raw");
  const manifestPath = path.resolve(
    flags.output ?? path.join(proofRoot, phase, "generation_manifest.json"),
  );
  const [referenceBytes, passagesBytes] = await Promise.all([
    fs.readFile(REFERENCE_MANIFEST),
    fs.readFile(PASSAGES_PATH),
  ]);
  const referenceManifest = JSON.parse(referenceBytes.toString("utf8"));
  const passageManifest = JSON.parse(passagesBytes.toString("utf8"));
  const referenceRows = referenceManifest.references
    ?? referenceManifest.reference_variants
    ?? referenceManifest.samples
    ?? [];
  const references = Object.fromEntries(
    referenceRows
      .filter((row) => row.status === "ready")
      .map((row) => [row.id, {
        audio_path: row.wav_path,
        audio_sha256: null,
        text: row.transcript,
        style: row.style,
      }]),
  );
  for (const reference of Object.values(references)) {
    reference.audio_sha256 = sha256(await fs.readFile(reference.audio_path));
  }
  const screenIds = new Set([
    "repeated_word_integrity",
    "terminal_tail_integrity",
    "system_ui_and_numbers",
    "names_ranks_and_initialisms",
    "emotional_cadence_shift",
    "goblin_join_combined",
  ]);
  const passages = phase === "screen"
    ? passageManifest.passages.filter((row) => screenIds.has(row.id))
    : passageManifest.passages;
  const requestedConfigs = phase === "screen"
    ? [
        "baseline_dry_batch4",
        "baseline_dry_serial",
        "dry_balanced_batch4",
        "dry_precise_batch4",
        "tense_precise_batch4",
        "fast_balanced_batch4",
      ]
    : [...new Set([
        "baseline_dry_batch4",
        flags["winner-id"] ?? "tense_balanced_batch4",
      ])];
  for (const configId of requestedConfigs) {
    if (!CONFIGS[configId]) throw new Error(`Unknown bakeoff config: ${configId}`);
  }
  const variants = requestedConfigs.map((id) => {
    const config = CONFIGS[id];
    return {
      id,
      mode: config.mode,
      seed: 73001,
      generation_parameters: config.generation_parameters,
      units: passages.map((passage) => ({
        id: passage.id,
        text: passage.text,
        category: passage.category,
        pair_id: passage.pair_id ?? null,
        side: passage.side ?? null,
        reference_id: config.reference_id,
      })),
    };
  });
  const manifest = {
    schema: "goldflow_narration_v2_bakeoff_manifest_v1",
    status: "ready",
    phase,
    diagnostic_only: true,
    output_dir: outputDir,
    model: MODEL,
    reference_manifest_path: REFERENCE_MANIFEST,
    reference_manifest_sha256: sha256(referenceBytes),
    passages_path: PASSAGES_PATH,
    passages_sha256: sha256(passagesBytes),
    references,
    variants,
  };
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status: "passed",
    phase,
    manifest_path: manifestPath,
    variant_count: variants.length,
    passage_count: passages.length,
    generation_count: variants.length * passages.length,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
