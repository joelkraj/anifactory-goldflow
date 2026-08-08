#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const sourcePath = args.get("--source");
const outputPath = args.get("--output");
const manifestPath = args.get("--manifest");
const styleRefPath = args.get("--style-ref");
const startIndex = Number.parseInt(args.get("--start-index") ?? "0", 10);

if (!sourcePath || !outputPath || !manifestPath || !styleRefPath) {
  throw new Error(
    "Usage: --source <section_image_prompts_hardened.json> --output <prompts.txt> " +
      "--manifest <manifest.json> --style-ref <image.png> [--start-index <zero-based>]",
  );
}

if (!Number.isInteger(startIndex) || startIndex < 0) {
  throw new Error(`Invalid --start-index: ${startIndex}`);
}

const STYLE_CONTRACT = [
  "Create a new 16:9 cartoon image using the attached image only as a STYLE reference:",
  "friendly imperfect black marker outlines, large simple open shapes, hand-drawn wobble,",
  "messy childlike wax-crayon coloring, visible layered strokes, uneven pressure, occasional",
  "coloring outside the lines, bright white paper background, minimal detail, and blank",
  "featureless faces. Every depicted human must read unmistakably as an ADULT. Do not copy",
  "any character, pose, prop, panel, label, text, or layout from the style sheet.",
].join(" ");

const STYLE_AVOID = [
  "Render the requested scene as one coherent wide composition.",
  "No photorealism, glossy 3D, anime styling, stick figures, generated words, letters,",
  "numbers, labels, logos, watermark, or style-sheet layout.",
].join(" ");

function stripLegacyStyle(prompt) {
  return prompt
    .replace(/16:9 landscape premium minimalist stick-figure editorial simulation/gi, "16:9 landscape")
    .replace(/premium minimalist stick-figure editorial simulation/gi, "cartoon staging")
    .replace(/polished editorial realism/gi, "clear editorial staging")
    .replace(/premium editorial realism/gi, "clear editorial staging")
    .replace(/restrained editorial noir/gi, "restrained dramatic staging")
    .replace(/cinematic editorial lighting/gi, "dramatic lighting")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const sourceBuffer = await readFile(sourcePath);
const source = JSON.parse(sourceBuffer.toString("utf8"));
const styleRefBuffer = await readFile(styleRefPath);
const selected = source.prompts.slice(startIndex);

if (selected.length === 0) {
  throw new Error(`No prompts selected from start index ${startIndex}`);
}

const rows = selected.map((item) => {
  if (!item.image_id || !item.provider_prompt) {
    throw new Error(`Malformed prompt at image_id=${item.image_id ?? "missing"}`);
  }
  const prompt = `${STYLE_CONTRACT} SCENE CONTRACT: ${stripLegacyStyle(item.provider_prompt)} ${STYLE_AVOID}`;
  if (prompt.includes("\n")) {
    throw new Error(`Prompt contains newline: ${item.image_id}`);
  }
  return {
    image_id: item.image_id,
    visual_beat_id: item.visual_beat_id,
    ordinal: source.prompts.indexOf(item) + 1,
    start_sec: item.start_sec,
    duration_sec: item.duration_sec,
    script_excerpt: item.visual_beat_script_excerpt,
    prompt,
    prompt_sha256: sha256(Buffer.from(prompt, "utf8")),
  };
});

const text = `${rows.map((row) => row.prompt).join("\n")}\n`;
await mkdir(path.dirname(outputPath), { recursive: true });
await mkdir(path.dirname(manifestPath), { recursive: true });
await writeFile(outputPath, text, "utf8");

const manifest = {
  schema_version: "goldflow_crayon_extension_prompt_export_v1",
  intent: "proof_only",
  source_path: path.resolve(sourcePath),
  source_sha256: sha256(sourceBuffer),
  style_reference_path: path.resolve(styleRefPath),
  style_reference_sha256: sha256(styleRefBuffer),
  start_index_zero_based: startIndex,
  first_ordinal_one_based: rows[0].ordinal,
  prompt_count: rows.length,
  prompt_file_path: path.resolve(outputPath),
  prompt_file_sha256: sha256(Buffer.from(text, "utf8")),
  cuts: rows.map(({ prompt, ...row }) => row),
};

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, manifestPath, promptCount: rows.length }, null, 2)}\n`);
