#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_NARRATOR_VOICE_ID,
  qwenPrimaryLockForVoice,
} from "./lib/narration-tts-policy.mjs";
import {
  OPENING_AUDIO_AUDITION_MANIFEST_SCHEMA,
  extractOpeningAuditionText,
  sentenceCompleteAuditionUnits,
  validateOpeningAudioAuditionManifest,
  validateOpeningAudioAuditionReview,
} from "./lib/source-opening-audio-audition-contract.mjs";

const DATA_ROOT = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const DEFAULT_PYTHON = "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-kokoro-mlx-audio-0.4.6/bin/python";

function flagsFrom(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index].startsWith("--")) continue;
    const key = parts[index].slice(2);
    const next = parts[index + 1];
    flags[key] = next && !next.startsWith("--") ? next : "true";
    if (flags[key] !== "true") index += 1;
  }
  return flags;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function writeExclusive(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { flag: "wx" });
}

async function exists(filePath) {
  return fs.stat(filePath).then(() => true).catch(() => false);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function stableLabels(rows, seed) {
  return [...rows]
    .sort((left, right) => sha256(`${seed}\0${left.draft_id}`).localeCompare(sha256(`${seed}\0${right.draft_id}`)))
    .map((row, index) => ({ draft_id: row.draft_id, blind_label: index === 0 ? "A" : "B" }));
}

async function stitchVariant(variant, outputPath) {
  const inputPaths = variant.results.map((row) => row.output_path);
  const args = [];
  for (const inputPath of inputPaths) args.push("-i", inputPath);
  const padded = inputPaths.map((_, index) => `[${index}:a]apad=pad_dur=${index === inputPaths.length - 1 ? 0 : 0.08}[a${index}]`).join(";");
  const concatInputs = inputPaths.map((_, index) => `[a${index}]`).join("");
  args.push(
    "-filter_complex", `${padded};${concatInputs}concat=n=${inputPaths.length}:v=0:a=1[out]`,
    "-map", "[out]",
    "-ar", "24000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    "-y",
    outputPath,
  );
  run("ffmpeg", args);
}

async function main() {
  const flags = flagsFrom(process.argv.slice(2));
  const channel = String(flags.channel ?? "53rebirth").trim();
  const developmentSlug = String(flags["development-slug"] ?? "").trim();
  if (!developmentSlug && !flags["development-dir"]) throw new Error("Use --development-slug <slug> or --development-dir <path>.");
  const developmentDir = path.resolve(
    flags["development-dir"]
      ?? path.join(DATA_ROOT, "channels", channel, "source_development", developmentSlug),
  );
  const roomContract = JSON.parse(await fs.readFile(
    path.join(developmentDir, "source_room_contract.json"),
    "utf8",
  ));
  const productionGate = roomContract?.opening_audio_audition_required === true;
  const mode = productionGate ? "mandatory_advisory" : "shadow_non_blocking";
  const outputDir = path.join(developmentDir, "opening_audio_audition");
  const manifestPath = path.join(outputDir, "opening_audio_audition_manifest.json");
  const reviewSource = flags.review ? path.resolve(flags.review) : null;

  if (reviewSource) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const review = JSON.parse(await fs.readFile(reviewSource, "utf8"));
    const validation = validateOpeningAudioAuditionReview(review, {
      manifestSha256: await fileSha256(manifestPath),
      allowedLabels: manifest.finalists.map((row) => row.blind_label).sort(),
      requireProductionGate: productionGate,
    });
    if (!validation.done) throw new Error(`Opening audition review blocked: ${validation.blockers.join(", ")}`);
    const target = path.join(outputDir, "opening_audio_audition_review.json");
    await writeExclusive(target, `${JSON.stringify(review, null, 2)}\n`);
    console.log(JSON.stringify({
      status: "reviewed",
      review_path: target,
      advisory_selection_evidence: true,
      next_action: "diagnose-v2",
    }, null, 2));
    return;
  }

  const [portfolioBytes, selectionBytes] = await Promise.all([
    fs.readFile(path.join(developmentDir, "longform_draft_portfolio.json")),
    fs.readFile(path.join(developmentDir, "longform_draft_selection.json")),
  ]);
  const portfolio = JSON.parse(portfolioBytes.toString("utf8"));
  const selection = JSON.parse(selectionBytes.toString("utf8"));
  const rankings = [...(selection.draft_rankings ?? [])].sort((left, right) => Number(left.rank) - Number(right.rank));
  if (rankings.length < 2 || Number(rankings[0].rank) !== 1 || Number(rankings[1].rank) !== 2) {
    throw new Error("Top-two draft rankings are required before opening audio audition.");
  }
  const portfolioByBlindId = new Map(portfolio.candidates.map((row) => [row.blind_id, row]));
  const draftRows = [];
  for (const ranking of rankings.slice(0, 2)) {
    const portfolioRow = portfolioByBlindId.get(ranking.draft_id);
    if (!portfolioRow) throw new Error(`Missing ranked draft ${ranking.draft_id} in portfolio.`);
    const text = await fs.readFile(path.resolve(portfolioRow.output_path), "utf8");
    const excerpt = extractOpeningAuditionText(text);
    draftRows.push({
      draft_id: ranking.draft_id,
      text_rank: Number(ranking.rank),
      draft_sha256: portfolioRow.output_sha256,
      draft_text: text,
      excerpt,
      unitTexts: sentenceCompleteAuditionUnits(excerpt.text),
    });
  }
  const labelSeed = sha256(selectionBytes);
  const labels = new Map(stableLabels(draftRows, labelSeed).map((row) => [row.draft_id, row.blind_label]));
  const voice = qwenPrimaryLockForVoice(DEFAULT_NARRATOR_VOICE_ID);
  if (await fileSha256(voice.reference_audio_path) !== voice.reference_audio_sha256) {
    throw new Error("Locked narrator reference hash mismatch.");
  }
  const finalists = draftRows.map((row) => ({
    draft_id: row.draft_id,
    text_rank: row.text_rank,
    blind_label: labels.get(row.draft_id),
    draft_sha256: row.draft_sha256,
    excerpt_text: row.excerpt.text,
    excerpt_word_count: row.excerpt.word_count,
    excerpt_sha256: row.excerpt.sha256,
    units: row.unitTexts.map((text, index) => ({
      unit_id: `${row.draft_id}_opening_${String(index + 1).padStart(2, "0")}`,
      text,
    })),
  }));
  const manifest = {
    schema: OPENING_AUDIO_AUDITION_MANIFEST_SCHEMA,
    status: "prepared",
    mode,
    selection_authority: "none_until_calibrated",
    draft_portfolio_sha256: sha256(portfolioBytes),
    draft_selection_sha256: sha256(selectionBytes),
    requested_window_sec: [60, 90],
    label_seed_sha256: labelSeed,
    voice_lock: {
      provider: voice.provider,
      model_id: voice.model_id,
      model_revision: voice.model_revision,
      voice_id: voice.voice_id,
      reference_variant_id: voice.reference_variant_id ?? null,
      reference_audio_path: voice.reference_audio_path,
      reference_audio_sha256: voice.reference_audio_sha256,
      reference_text: voice.reference_text,
      reference_text_sha256: voice.reference_text_sha256,
      generation_parameters: {
        temperature: voice.temperature,
        top_p: voice.top_p,
        top_k: voice.top_k,
        repetition_penalty: voice.repetition_penalty,
        max_tokens: voice.max_tokens,
      },
    },
    finalists,
    prepared_at: new Date().toISOString(),
  };
  if (await exists(manifestPath)) {
    const existing = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.prepared_at = existing.prepared_at;
  }
  const expectedDrafts = Object.fromEntries(draftRows.map((row) => [row.draft_id, {
    sha256: row.draft_sha256,
    text: row.draft_text,
  }]));
  const validation = validateOpeningAudioAuditionManifest(manifest, {
    draftSelectionSha256: sha256(selectionBytes),
    expectedDrafts,
    requireProductionGate: productionGate,
  });
  if (!validation.done) throw new Error(`Opening audition manifest blocked: ${validation.blockers.join(", ")}`);
  await fs.mkdir(outputDir, { recursive: true });
  if (!await exists(manifestPath)) {
    await writeExclusive(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } else if (await fileSha256(manifestPath) !== sha256(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))) {
    throw new Error("Existing opening audio audition manifest differs; refusing overwrite.");
  }
  if (String(flags["prepare-only"] ?? "false") === "true") {
    console.log(JSON.stringify({ status: "prepared", manifest_path: manifestPath, non_blocking: true }, null, 2));
    return;
  }

  const generationManifestPath = path.join(outputDir, "qwen_generation_manifest.json");
  const generationReportPath = path.join(outputDir, "qwen_generation_report.json");
  const generationManifest = {
    schema: "goldflow_narration_v2_bakeoff_manifest_v1",
    status: "ready",
    phase: "opening_audio_audition",
    diagnostic_only: true,
    output_dir: path.join(outputDir, "raw"),
    model: { id: voice.model_id, revision: voice.model_revision },
    references: {
      production_default: {
        audio_path: voice.reference_audio_path,
        audio_sha256: voice.reference_audio_sha256,
        text: voice.reference_text,
        style: voice.reference_variant_id ?? "production_default",
      },
    },
    variants: finalists.map((row) => ({
      id: `blind_${row.blind_label}`,
      mode: "batch4",
      seed: Number.parseInt(sha256(`${labelSeed}\0${row.blind_label}`).slice(0, 8), 16),
      generation_parameters: manifest.voice_lock.generation_parameters,
      units: row.units.map((unit) => ({
        id: unit.unit_id,
        text: unit.text,
        reference_id: "production_default",
      })),
    })),
  };
  const generationManifestText = `${JSON.stringify(generationManifest, null, 2)}\n`;
  if (!await exists(generationManifestPath)) await writeExclusive(generationManifestPath, generationManifestText);
  else if (await fileSha256(generationManifestPath) !== sha256(Buffer.from(generationManifestText))) {
    throw new Error("Existing opening audition generation manifest differs; refusing overwrite.");
  }
  if (!await exists(generationReportPath)) {
    run(process.env.ANIFACTORY_QWEN_PYTHON || DEFAULT_PYTHON, [
      path.resolve("scripts/tts-narration-v2-bakeoff-runner.py"),
      "--manifest", generationManifestPath,
      "--report", generationReportPath,
    ]);
  }
  const generationReport = JSON.parse(await fs.readFile(generationReportPath, "utf8"));
  const reviewRows = [];
  for (const variant of generationReport.variants) {
    const label = variant.id.replace(/^blind_/, "");
    const outputPath = path.join(outputDir, `blind_${label}.wav`);
    if (!await exists(outputPath)) await stitchVariant(variant, outputPath);
    reviewRows.push({
      blind_label: label,
      audio_path: outputPath,
      audio_sha256: await fileSha256(outputPath),
      generated_duration_sec: variant.generated_audio_sec,
    });
  }
  const reviewPacketPath = path.join(outputDir, "opening_audio_audition_blind_review_packet.json");
  const reviewPacket = {
    schema: "goldflow_opening_audio_audition_blind_packet_v1",
    status: "ready",
    audition_manifest_sha256: await fileSha256(manifestPath),
    decision_authority: productionGate ? "mandatory_advisory" : "shadow_only",
    audio: reviewRows.sort((left, right) => left.blind_label.localeCompare(right.blind_label)),
    score_scale: "1 poor, 5 excellent",
    criteria: ["spoken_cadence", "name_density", "exposition_control", "emotional_clarity", "immediate_click_satisfaction"],
    required_review_schema: "goldflow_opening_audio_audition_review_v1",
  };
  if (!await exists(reviewPacketPath)) {
    await writeExclusive(reviewPacketPath, `${JSON.stringify(reviewPacket, null, 2)}\n`);
  }
  console.log(JSON.stringify({
    status: "generated",
    manifest_path: manifestPath,
    generation_report_path: generationReportPath,
    blind_review_packet_path: reviewPacketPath,
    advisory_selection_evidence: true,
    next_action: "submit a blind review, then diagnose-v2",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
