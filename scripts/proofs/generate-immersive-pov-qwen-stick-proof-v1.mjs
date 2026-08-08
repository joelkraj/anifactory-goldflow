#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { generateModelslabImage } from "../modelslab-image-helper.mjs";

const DEFAULT_EPISODE_DIR = "/Users/joel/AniFactoryData/channels/immersivepov/weekly_runs/2026-W32-immersive-pov-illegal-brothel-proof-v1/episodes/ep_01";
const DEFAULT_STRESS_INDICES = [1, 2, 4, 7, 18, 40];
const RENDERED_STILL_INDICES = [
  1, 2, 3, 4, 5, 6, 7, 9, 13, 15, 16, 17, 18, 19, 21, 25, 26, 27,
  29, 31, 35, 36, 38, 39, 40, 43, 44,
];

const flags = parseFlags(process.argv.slice(2));
const episodeDir = path.resolve(flags["episode-dir"] ?? DEFAULT_EPISODE_DIR);
const proofDir = path.resolve(flags["proof-dir"] ?? path.join(
  episodeDir,
  "review_samples/qwen_stick_style_probe_v1",
));
const styleReference = path.resolve(flags["style-reference"] ?? path.join(
  proofDir,
  "channel_style_reference_qwen_v1_clean.png",
));
const recipe = String(flags.recipe ?? "v1").replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
const outputDir = path.resolve(flags["output-dir"] ?? path.join(proofDir, "qwen_stills"));
const promptPlanPath = path.join(episodeDir, "section_image_prompts_hardened.json");
// Qwen's unlimited lane can advertise a larger parallel allowance while its
// fetch queue still throttles under sustained image-to-image work.
const concurrency = Math.max(1, Math.min(15, Number(flags.concurrency ?? 4)));
const imageStrength = Math.max(0, Math.min(1, Number(flags.strength ?? 0.9)));
const fixedSeed = Number(flags.seed ?? 1837);
const selectedIndices = flags.all === "true"
  ? RENDERED_STILL_INDICES
  : parseIndices(flags.indices ?? DEFAULT_STRESS_INDICES.join(","));

const STYLE_LOCK = `Use the attached image ONLY as the immutable channel art-style reference for line, palette, round geometry, and paper texture. Recompose the new scene below from scratch.

STYLE LOCK: use uniform hand-inked black outlines, flat 2D shapes, very subtle paper grain, generous negative space, and a strict palette of warm ivory, charcoal black, muted brick red, muted olive, muted tan, plus muted police blue only when the scene explicitly requires emergency light. Brick red is reserved for one focal warning accent. Keep environments sparse and icon-like while preserving the requested physical action and composition. Maintain this exact visual grammar in every scene.`;

const FIGURE_STYLE_LOCK = `Every visible adult without exception uses the same construction: perfectly round white head, two tiny black dot eyes, one tiny curved mouth when visible, no nose, no ears, no hair unless the scene requires one minimal identifying shape, short flat charcoal torso, thin single-stroke charcoal arms and legs, and tiny rounded hands and feet. Keep all figures unmistakably adult and equally simplified.`;

const BASE_NEGATIVE_PROMPT = "words, letters, numbers, logos, labels, arrows, panels, borders, watermark, photorealism, 3D, anime, painterly rendering, gradients, cinematic shading, realistic anatomy, detailed face, different illustration style, style drift, extra limbs, malformed hands";

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = parts[index + 1];
    parsed[key] = next && !next.startsWith("--") ? next : "true";
    if (parsed[key] !== "true") index += 1;
  }
  return parsed;
}

function parseIndices(value) {
  const values = String(value)
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  if (!values.length) throw new Error("No valid one-based prompt indices supplied.");
  return [...new Set(values)];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function mapLimit(values, limit, callback) {
  const results = Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await callback(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

async function main() {
  const [plan, styleReferenceHash, promptPlanHash] = await Promise.all([
    readJson(promptPlanPath),
    sha256File(styleReference),
    sha256File(promptPlanPath),
  ]);
  const prompts = plan.prompts ?? plan.cuts ?? plan.images ?? plan;
  if (!Array.isArray(prompts) || prompts.length !== 46) {
    throw new Error(`Expected 46 hardened prompts, found ${prompts?.length ?? "none"}.`);
  }
  const selected = selectedIndices.map((oneBasedIndex) => {
    const prompt = prompts[oneBasedIndex - 1];
    if (!prompt) throw new Error(`Prompt index ${oneBasedIndex} does not exist.`);
    return { oneBasedIndex, prompt };
  });
  await fs.mkdir(outputDir, { recursive: true });

  const rows = await mapLimit(selected, concurrency, async ({ oneBasedIndex, prompt }) => {
    const outputPath = path.join(outputDir, `${prompt.image_id}-modelslab-image.png`);
    if (await fileExists(outputPath)) {
      return {
        prompt_index: oneBasedIndex,
        image_id: prompt.image_id,
        status: "reused_immutable",
        output_path: outputPath,
        output_sha256: await sha256File(outputPath),
      };
    }
    const sourcePrompt = prompt.modelslab_image_prompt ?? prompt.provider_prompt ?? prompt.image_prompt;
    const action = String(prompt.visual_beat_action ?? "");
    const allowsPeople = /adult|customer|worker|protagonist|victor|person|occupant|mara|landlord|inspector/iu.test(action);
    const allowsCash = /cash|money|dollar|pay|profit|income|revenue|safe|owed/iu.test(action);
    const allowsPhone = /call|phone|message/iu.test(action);
    const negativePrompt = [
      BASE_NEGATIVE_PROMPT,
      "desk, chair",
      allowsPhone ? null : "telephone, handset, smartphone, wall phone",
      allowsCash ? null : "cash, banknotes, coins, money stack",
      allowsPeople ? null : "person, face, body, silhouette, human figure",
    ].filter(Boolean).join(", ");
    const conciseScenePrompt = [
      `Action: ${action}`,
      prompt.visual_novelty_directive ? `Composition: ${prompt.visual_novelty_directive}` : null,
      prompt.location ? `Setting: ${prompt.location}` : null,
      "Depict only the people and objects necessary for this action.",
    ].filter(Boolean).join("\n");
    const submittedPrompt = `${STYLE_LOCK}${allowsPeople ? `\n\n${FIGURE_STYLE_LOCK}` : ""}\n\nNEW SCENE TO DEPICT:\n${conciseScenePrompt}`;
    const generation = await generateModelslabImage({
      prompt: submittedPrompt,
      negativePrompt,
      outputPath,
      referenceImagePaths: [styleReference],
      model: "qwen",
      width: 1024,
      height: 576,
      enhancePrompt: false,
      strength: imageStrength,
      seed: fixedSeed,
    });
    return {
      prompt_index: oneBasedIndex,
      image_id: prompt.image_id,
      visual_beat_action: prompt.visual_beat_action,
      status: "generated",
      output_path: outputPath,
      output_sha256: await sha256File(outputPath),
      source_prompt_sha256: sha256(String(sourcePrompt)),
      concise_scene_prompt: conciseScenePrompt,
      negative_prompt: negativePrompt,
      submitted_prompt_sha256: sha256(submittedPrompt),
      provider_request_id: generation.modelslab_request_id,
      provider_model_id: generation.modelslab_model_id,
      provider_endpoint: generation.modelslab_endpoint,
      provider_reference_count: generation.modelslab_reference_count,
      provider_elapsed_ms: generation.modelslab_elapsed_ms,
      provider_native_geometry: {
        width: generation.actual_width,
        height: generation.actual_height,
        aspect: generation.actual_aspect,
      },
      provider_account: generation.modelslab_account,
    };
  });

  const reportPath = path.join(
    proofDir,
    flags.all === "true" ? `qwen_full_still_generation_report_${recipe}.json` : `qwen_stress_generation_report_${recipe}.json`,
  );
  const report = {
    schema: "goldflow_immersive_pov_qwen_stick_proof_v1",
    status: "generated_pending_visual_review",
    proof_only: true,
    official_pipeline_artifacts_modified: false,
    created_at: new Date().toISOString(),
    model: "qwen",
    model_access: "modelslab_open_source_unlimited",
    recipe,
    image_to_image_strength: imageStrength,
    fixed_seed: fixedSeed,
    style_reference_path: styleReference,
    style_reference_sha256: styleReferenceHash,
    prompt_plan_path: promptPlanPath,
    prompt_plan_sha256: promptPlanHash,
    selected_prompt_indices: selectedIndices,
    output_dir: outputDir,
    rows,
  };
  await writeJson(reportPath, report);
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    output_dir: outputDir,
    generated_count: rows.filter((row) => row.status === "generated").length,
    reused_count: rows.filter((row) => row.status === "reused_immutable").length,
    report_path: reportPath,
  }, null, 2)}\n`);
}

await main();
