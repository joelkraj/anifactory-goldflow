#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    flags[token.slice(2)] = value;
    index += 1;
  }
  return flags;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function wordCount(value) {
  return value.trim() ? value.trim().split(/\s+/u).length : 0;
}

function spokenText(sourceText) {
  const replacements = [
    [/\b2024\b/gu, "twenty twenty-four"],
    [/\b33\.4\b/gu, "thirty-three point four"],
    [/\b99\.5\b/gu, "ninety-nine point five"],
    [/\b0\.03\b/gu, "zero point zero three"],
    [/\b753\b/gu, "seven fifty-three"],
    [/\b41\b/gu, "forty-one"],
    [/\b80\b/gu, "eighty"],
  ];
  return replacements.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), sourceText);
}

function sentenceRows(script) {
  const rows = [];
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const paragraphs = script.trim().split(/\n\s*\n/u);
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex].replace(/\s+/gu, " ").trim();
    for (const sentence of segmenter.segment(paragraph)) {
      const text = sentence.segment.trim();
      if (!text) continue;
      rows.push({
        paragraph_index: paragraphIndex,
        text,
        word_count: wordCount(text),
        spoken_word_count: wordCount(spokenText(text)),
      });
    }
  }
  return rows;
}

function packUnits(sentences, targetMin = 45, hardMax = 60) {
  for (const sentence of sentences) {
    if (sentence.spoken_word_count > hardMax) {
      throw new Error(`Sentence exceeds ${hardMax} words: ${sentence.text}`);
    }
  }

  function solve(allowShortUnits) {
    const best = Array(sentences.length + 1).fill(null);
    best[sentences.length] = { cost: 0, groups: [] };
    for (let start = sentences.length - 1; start >= 0; start -= 1) {
      let words = 0;
      for (let end = start; end < sentences.length; end += 1) {
        words += sentences[end].spoken_word_count;
        if (words > hardMax) break;
        if (words < targetMin && !allowShortUnits) continue;
        if (!best[end + 1]) continue;
        const underTargetPenalty = words < targetMin
          ? 1000 + ((targetMin - words) ** 2)
          : 0;
        const centerPenalty = words >= targetMin ? ((words - 52) ** 2) * 0.02 : 0;
        const next = sentences[end + 1];
        const endsAtParagraph = !next || next.paragraph_index !== sentences[end].paragraph_index;
        const paragraphPenalty = endsAtParagraph ? 0 : 0.35;
        const cost = underTargetPenalty + centerPenalty + paragraphPenalty + best[end + 1].cost;
        if (!best[start] || cost < best[start].cost) {
          best[start] = {
            cost,
            groups: [[start, end], ...best[end + 1].groups],
          };
        }
      }
    }
    return best[0];
  }

  const solution = solve(false) ?? solve(true);
  if (!solution) throw new Error("Could not construct sentence-complete TTS units.");
  return solution.groups.map(([start, end]) => {
    const rows = sentences.slice(start, end + 1);
    const sourceText = rows.map((row) => row.text).join(" ");
    return {
      sentence_start_index: start,
      sentence_end_index: end,
      paragraph_start_index: rows[0].paragraph_index,
      paragraph_end_index: rows.at(-1).paragraph_index,
      source_text: sourceText,
      word_count: wordCount(sourceText),
    };
  });
}

const flags = parseFlags(process.argv.slice(2));
for (const required of ["script", "approval", "reference-manifest", "output"]) {
  if (!flags[required]) throw new Error(`Missing --${required}`);
}

const scriptPath = path.resolve(flags.script);
const approvalPath = path.resolve(flags.approval);
const referenceManifestPath = path.resolve(flags["reference-manifest"]);
const outputPath = path.resolve(flags.output);
const [script, approvalRaw, referenceRaw] = await Promise.all([
  fs.readFile(scriptPath, "utf8"),
  fs.readFile(approvalPath, "utf8"),
  fs.readFile(referenceManifestPath, "utf8"),
]);
const approval = JSON.parse(approvalRaw);
const referenceManifest = JSON.parse(referenceRaw);
const scriptSha256 = await sha256File(scriptPath);
if (approval.status !== "approved" || approval.script_sha256 !== scriptSha256) {
  throw new Error("Proof script approval does not match the exact candidate hash.");
}

const baseDir = path.dirname(referenceManifestPath);
const referenceAudioPath = path.resolve(baseDir, referenceManifest.reference.audio_path);
const referenceTextPath = path.resolve(baseDir, referenceManifest.reference.transcript_path);
const [referenceAudioSha256, referenceTextFileSha256, referenceTextRaw] = await Promise.all([
  sha256File(referenceAudioPath),
  sha256File(referenceTextPath),
  fs.readFile(referenceTextPath, "utf8"),
]);
const referenceText = referenceTextRaw.trim();
if (
  referenceAudioSha256 !== referenceManifest.reference.audio_sha256
  || referenceTextFileSha256 !== referenceManifest.reference.transcript_file_sha256
  || referenceText !== referenceManifest.reference.transcript
) {
  throw new Error("Adam reference audio or transcript no longer matches its manifest.");
}

const sentences = sentenceRows(script);
const packed = packUnits(sentences);
const seedBase = 20260803;
const units = packed.map((unit, index) => {
  const text = spokenText(unit.source_text);
  return {
    unit_id: `adam_qwen_full_${String(index + 1).padStart(3, "0")}`,
    input_index: index,
    sentence_start_index: unit.sentence_start_index,
    sentence_end_index: unit.sentence_end_index,
    paragraph_start_index: unit.paragraph_start_index,
    paragraph_end_index: unit.paragraph_end_index,
    source_text: unit.source_text,
    source_text_sha256: sha256Text(unit.source_text),
    spoken_text: text,
    spoken_text_sha256: sha256Text(text),
    source_word_count: unit.word_count,
    spoken_word_count: wordCount(text),
    seed: seedBase + index,
  };
});

const reconstructed = units.map((unit) => unit.source_text).join(" ");
const normalizedScript = script.replace(/\s+/gu, " ").trim();
if (reconstructed !== normalizedScript) throw new Error("Packed TTS units do not reconstruct the approved script.");

const manifest = {
  schema: "goldflow_private_proof_qwen_narration_manifest_v1",
  status: "approved_for_synthesis",
  proof_only: true,
  script_path: scriptPath,
  script_sha256: scriptSha256,
  script_word_count: wordCount(script),
  approval_path: approvalPath,
  approval_sha256: await sha256File(approvalPath),
  reference_manifest_path: referenceManifestPath,
  reference_manifest_sha256: await sha256File(referenceManifestPath),
  reference_audio_path: referenceAudioPath,
  reference_audio_sha256: referenceAudioSha256,
  reference_text_path: referenceTextPath,
  reference_text_file_sha256: referenceTextFileSha256,
  reference_text: referenceText,
  reference_text_sha256: sha256Text(referenceText),
  model: {
    provider: "qwen_local",
    model_id: "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
    revision: "e7dd0585652209fa0d7783659aad4e8a324de11c",
    sample_rate_hz: 24000,
  },
  generation: {
    temperature: 0.6,
    top_p: 0.8,
    top_k: 50,
    repetition_penalty: 1.2,
    max_tokens: 1200,
    native_speed: 1.0,
    post_tts_tempo_processing: false,
  },
  unit_contract: {
    sentence_complete: true,
    target_words_min: 45,
    target_words_max: 60,
    hard_words_max: 60,
    continuous_requests: false,
    short_units_are_advisory: true,
    under_target_unit_ids: units
      .filter((unit) => unit.spoken_word_count < 45)
      .map((unit) => unit.unit_id),
    hard_max_passed: units.every((unit) => unit.spoken_word_count <= 60),
  },
  stitch_contract: {
    join_silence_ms: 80,
    trim_native_endpoints: false,
    fade_units: false,
    normalize_units: false,
  },
  sentence_count: sentences.length,
  unit_count: units.length,
  units,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.tmp-${process.pid}`;
await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await fs.rename(temporaryPath, outputPath);
console.log(JSON.stringify({
  status: "passed",
  output: outputPath,
  script_sha256: scriptSha256,
  sentence_count: sentences.length,
  unit_count: units.length,
  minimum_unit_words: Math.min(...units.map((unit) => unit.spoken_word_count)),
  maximum_unit_words: Math.max(...units.map((unit) => unit.spoken_word_count)),
}, null, 2));
