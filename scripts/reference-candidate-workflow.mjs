#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { runCodexCli } from "./lib/codex-cli-runner.mjs";
import {
  candidateSelectionCoverage,
  referenceCandidateCount,
  referenceTargetUseCount,
} from "./lib/reference-candidate-contract.mjs";
import { referencePlanApprovalMatches } from "./lib/reference-plan-contract.mjs";
import { referencePromptForTarget } from "./imagegen.mjs";
import { generateModelslabImage } from "./modelslab-image-helper.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function isTrue(value) {
  return /^(?:true|1|yes)$/i.test(String(value ?? ""));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function slug(value) {
  return String(value ?? "reference")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "reference";
}

function extractJson(content) {
  const raw = String(content ?? "").trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error(`Reference candidate reviewer returned invalid JSON: ${raw.slice(0, 500)}`);
}

function referencePathValue(target) {
  return target?.conditioning_image_path ?? target?.reference_image_path ?? target?.required_reference_path ?? target?.path ?? null;
}

function officialReferencePath(episodeDir, target) {
  return referencePathValue(target)
    ?? path.join(episodeDir, "assets", "images", "references", `${target.ref_id}-modelslab-reference.png`);
}

function correctionPrompt(basePrompt, reviewerPrompt) {
  const correction = String(reviewerPrompt ?? "").trim();
  if (!correction) return basePrompt;
  return correction;
}

function reviewEvidence(target, storyFacts, visualBeats) {
  const canonicalId = String(target.canonical_subject_id ?? "");
  const entity = (storyFacts?.canonical_entities ?? []).find((row) => row.entity_id === canonicalId);
  const planned = new Set(target.planned_beat_ids ?? []);
  const beatRows = (visualBeats?.beats ?? [])
    .filter((beat) => planned.has(beat.visual_beat_id))
    .slice(0, 16)
    .map((beat) => ({
      visual_beat_id: beat.visual_beat_id,
      excerpt: beat.visual_beat_script_excerpt,
      location: beat.local_location,
      active_state_constraints: beat.active_state_constraints,
    }));
  return {
    canonical_entity: entity ?? null,
    representative_beats: beatRows,
  };
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          ...items[index],
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, consume));
  return results;
}

async function makeContactSheet(targetDir, targetId, candidates) {
  const passed = candidates.filter((row) => row.status !== "failed" && row.image_path);
  if (!passed.length) return null;
  const cellWidth = 512;
  const imageHeight = 288;
  const labelHeight = 42;
  const columns = Math.min(2, passed.length);
  const rows = Math.ceil(passed.length / columns);
  const composites = [];
  for (let index = 0; index < passed.length; index += 1) {
    const row = passed[index];
    const image = await sharp(row.image_path)
      .resize({ width: cellWidth, height: imageHeight, fit: "contain", background: "#d8d8d8" })
      .png()
      .toBuffer();
    const label = await sharp(Buffer.from(
      `<svg width="${cellWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111827"/><text x="16" y="28" fill="white" font-size="19" font-family="Arial, sans-serif">${row.candidate_id}</text></svg>`,
    )).png().toBuffer();
    const cell = await sharp({
      create: { width: cellWidth, height: imageHeight + labelHeight, channels: 3, background: "#d8d8d8" },
    }).composite([{ input: image, top: 0, left: 0 }, { input: label, top: imageHeight, left: 0 }]).png().toBuffer();
    composites.push({
      input: cell,
      left: (index % columns) * cellWidth,
      top: Math.floor(index / columns) * (imageHeight + labelHeight),
    });
  }
  const outputPath = path.join(targetDir, `${targetId}-contact-sheet.png`);
  await sharp({
    create: {
      width: columns * cellWidth,
      height: rows * (imageHeight + labelHeight),
      channels: 3,
      background: "#e5e7eb",
    },
  }).composite(composites).png().toFile(outputPath);
  return outputPath;
}

async function generateCandidatesForTarget({
  episodeDir,
  target,
  candidateCount,
  iteration,
  promptOverride,
  model,
  width,
  height,
  force,
  dependencyPaths,
}) {
  const targetId = slug(target.ref_id);
  const targetDir = path.join(episodeDir, "assets", "images", "reference_candidates", targetId, `iteration_${iteration}`);
  await fs.mkdir(targetDir, { recursive: true });
  const basePrompt = referencePromptForTarget(target);
  const prompt = correctionPrompt(basePrompt, promptOverride);
  const jobs = Array.from({ length: candidateCount }, (_unused, index) => ({
    candidate_id: `${targetId}-i${String(iteration).padStart(2, "0")}-c${String(index + 1).padStart(2, "0")}`,
    candidate_index: index + 1,
  }));
  const candidates = await runPool(jobs, Math.min(candidateCount, 4), async (job) => {
    const outputPath = path.join(targetDir, `${job.candidate_id}.png`);
    const metadataPath = `${outputPath}.metadata.json`;
    const promptHash = sha256(JSON.stringify({
      prompt,
      model,
      width,
      height,
      target: target.ref_id,
      iteration,
      candidate_index: job.candidate_index,
      dependency_paths: dependencyPaths,
    }));
    const cached = await readJson(metadataPath, null);
    if (!force && cached?.prompt_hash === promptHash && await exists(outputPath)) {
      return {
        ...job,
        status: "reused_fresh",
        image_path: outputPath,
        image_sha256: cached.image_sha256 ?? await hashFile(outputPath),
        prompt_hash: promptHash,
        generated: cached.generated,
      };
    }
    const generated = await generateModelslabImage({
      prompt,
      outputPath,
      referenceImagePaths: dependencyPaths,
      model,
      width,
      height,
      enhancePrompt: false,
    });
    const imageHash = await hashFile(outputPath);
    await writeJson(metadataPath, {
      schema: "goldflow_reference_candidate_metadata_v1",
      target_ref_id: target.ref_id,
      ...job,
      iteration,
      prompt,
      prompt_hash: promptHash,
      image_sha256: imageHash,
      image_path: outputPath,
      generated,
      updated_at: new Date().toISOString(),
    });
    return {
      ...job,
      status: "generated",
      image_path: outputPath,
      image_sha256: imageHash,
      prompt_hash: promptHash,
      generated,
    };
  });
  const contactSheetPath = await makeContactSheet(targetDir, targetId, candidates);
  return {
    ref_id: target.ref_id,
    iteration,
    candidate_count: candidateCount,
    prompt,
    prompt_override_applied: Boolean(String(promptOverride ?? "").trim()),
    dependency_paths: dependencyPaths,
    candidates,
    contact_sheet_path: contactSheetPath,
  };
}

function reviewerPrompt({ target, evidence, generation }) {
  const candidateMap = generation.candidates
    .filter((row) => row.image_path && row.status !== "failed")
    .map((row, index) => ({ attached_image_number: index + 1, candidate_id: row.candidate_id, image_path: row.image_path }));
  return `You are Goldflow's senior manhwa reference casting director. Review the attached candidate images against the evidence and reference contract. This is an image-selection task, not a prose-only review.

REFERENCE TARGET:
${JSON.stringify({
    ref_id: target.ref_id,
    kind: target.kind,
    subject: target.subject,
    prompt_anchor: target.prompt_anchor,
    clean_plate_contract: target.clean_plate_contract,
    reference_value_reason: target.reference_value_reason,
    risk_notes: target.risk_notes,
    estimated_use_count: referenceTargetUseCount(target),
  }, null, 2)}

STORY EVIDENCE:
${JSON.stringify(evidence, null, 2)}

GENERATION PROMPT:
${generation.prompt}

CANDIDATE IMAGE ORDER:
${JSON.stringify(candidateMap, null, 2)}

Score every candidate from 1-10 on:
- story_contract_accuracy: the visible person/object/environment matches the role and persistent state supported by evidence.
- identity_or_design_quality: attractive, memorable, coherent design suitable for reuse.
- conditioning_cleanliness: clean single conditioning concept without unrelated people, props, scenery, temporary damage, or ambiguous contamination.
- contract_specificity: the visible design communicates this exact role, institution, object, interface, or place rather than a generic genre default.
- visual_appeal: polished focal design that will support a premium manhwa episode.
- style_fit: polished 2D anime/manhwa appearance rather than photorealism, 3D, or unfinished concept art.

For character references, inspect age read, face, body, wardrobe silhouette, garment construction, palette, materials, institutional/faction markers, cleanliness, and social read. Abstract low rank, weakness, debt, humiliation, or disposability must not become dirt, rags, homelessness, or beggar styling unless exact evidence makes that a persistent visible state. When the contract names an institutional role, a generic villager, peasant, drifter, martial-artist, or plain wrapped robe without professional design language scores at most 6 for contract_specificity. A low-ranked institutional worker should read as modest and junior through restrained tailoring and trim while remaining clean, maintained, and visibly affiliated.

Select a candidate only when all six scores are at least 7 and there is no hard contradiction. If none qualify, return repair_required and author one complete replacement generation prompt. The replacement prompt must positively describe the desired visible result with concrete construction, palette, material, status, affiliation, and cleanliness details. Preserve story facts; do not invent powers, props, injuries, or social roles. You may design concrete wardrobe construction, restrained palette, trim, and institutional motifs needed to visually communicate a role already established by the evidence.

Return exactly one JSON object:
{
  "status": "selected" | "repair_required",
  "selected_candidate_id": "candidate id or null",
  "selection_reason": "brief visual rationale",
  "candidate_scores": [
    {
      "candidate_id": "exact id",
      "story_contract_accuracy": 1,
      "identity_or_design_quality": 1,
      "conditioning_cleanliness": 1,
      "contract_specificity": 1,
      "visual_appeal": 1,
      "style_fit": 1,
      "hard_reject_reasons": [],
      "notes": "brief"
    }
  ],
  "correction_directive": "brief observed failure and desired correction, or null",
  "revised_generation_prompt": "complete replacement generation prompt, or null"
}`;
}

function normalizeReview(parsed, generation) {
  const validIds = new Set(generation.candidates.filter((row) => row.status !== "failed").map((row) => row.candidate_id));
  const rows = Array.isArray(parsed?.candidate_scores) ? parsed.candidate_scores.map((row) => ({
    candidate_id: String(row?.candidate_id ?? ""),
    story_contract_accuracy: Number(row?.story_contract_accuracy ?? 0),
    identity_or_design_quality: Number(row?.identity_or_design_quality ?? 0),
    conditioning_cleanliness: Number(row?.conditioning_cleanliness ?? 0),
    contract_specificity: Number(row?.contract_specificity ?? 0),
    visual_appeal: Number(row?.visual_appeal ?? 0),
    style_fit: Number(row?.style_fit ?? 0),
    hard_reject_reasons: Array.isArray(row?.hard_reject_reasons) ? row.hard_reject_reasons.map(String) : [],
    notes: String(row?.notes ?? ""),
  })).filter((row) => validIds.has(row.candidate_id)) : [];
  const requestedId = String(parsed?.selected_candidate_id ?? "");
  const selectedScore = rows.find((row) => row.candidate_id === requestedId);
  const scorePass = selectedScore
    && selectedScore.story_contract_accuracy >= 7
    && selectedScore.identity_or_design_quality >= 7
    && selectedScore.conditioning_cleanliness >= 7
    && selectedScore.contract_specificity >= 7
    && selectedScore.visual_appeal >= 7
    && selectedScore.style_fit >= 7
    && selectedScore.hard_reject_reasons.length === 0;
  return {
    status: parsed?.status === "selected" && validIds.has(requestedId) && scorePass ? "selected" : "repair_required",
    selected_candidate_id: parsed?.status === "selected" && validIds.has(requestedId) && scorePass ? requestedId : null,
    selection_reason: String(parsed?.selection_reason ?? ""),
    candidate_scores: rows,
    correction_directive: parsed?.correction_directive ? String(parsed.correction_directive) : null,
    revised_generation_prompt: parsed?.revised_generation_prompt ? String(parsed.revised_generation_prompt).trim() : null,
  };
}

async function reviewCandidates({ episodeDir, episode, target, evidence, generation, iteration, model, reasoningEffort }) {
  const passed = generation.candidates.filter((row) => row.status !== "failed" && row.image_path);
  if (!passed.length) return {
    status: "repair_required",
    selected_candidate_id: null,
    candidate_scores: [],
    correction_directive: "Provider returned no reviewable candidate images.",
    revised_generation_prompt: null,
  };
  const callDir = path.join(episodeDir, "assets", "review", "reference_candidate_calls");
  await fs.mkdir(callDir, { recursive: true });
  const outputPath = path.join(callDir, `${slug(target.ref_id)}-iteration-${iteration}-review.txt`);
  const call = await runCodexCli({
    prompt: reviewerPrompt({ target, evidence, generation }),
    stageName: `${episode}_reference_candidate_${slug(target.ref_id)}_iteration_${iteration}`,
    repoRoot,
    outputPath,
    model,
    reasoningEffort,
    verbosity: "medium",
    timeoutMs: Number(process.env.ANIFACTORY_REFERENCE_CANDIDATE_REVIEW_TIMEOUT_MS ?? 900_000),
    detached: true,
    extraArgs: passed.flatMap((row) => ["--image", row.image_path]),
  });
  return {
    ...normalizeReview(extractJson(call.content), generation),
    reviewer: "codex-agent-vision",
    reviewer_model: call.model,
    reviewer_reasoning_effort: call.reasoning_effort,
    reviewer_output_path: outputPath,
  };
}

async function archiveExistingReference(officialPath, candidateRoot) {
  if (!(await exists(officialPath))) return null;
  const existingHash = await hashFile(officialPath);
  const archiveDir = path.join(candidateRoot, "_previous_official");
  await fs.mkdir(archiveDir, { recursive: true });
  const outputPath = path.join(archiveDir, `${path.basename(officialPath, path.extname(officialPath))}-${existingHash.slice(0, 12)}${path.extname(officialPath) || ".png"}`);
  if (!(await exists(outputPath))) await fs.copyFile(officialPath, outputPath);
  return { path: outputPath, sha256: existingHash };
}

async function promoteCandidate({ episodeDir, target, generation, review }) {
  const selected = generation.candidates.find((row) => row.candidate_id === review.selected_candidate_id);
  if (!selected?.image_path) throw new Error(`Selected candidate ${review.selected_candidate_id} is missing for ${target.ref_id}.`);
  const officialPath = officialReferencePath(episodeDir, target);
  const candidateRoot = path.join(episodeDir, "assets", "images", "reference_candidates", slug(target.ref_id));
  const previousOfficial = await archiveExistingReference(officialPath, candidateRoot);
  await fs.mkdir(path.dirname(officialPath), { recursive: true });
  const stagingPath = `${officialPath}.candidate-promotion.tmp`;
  await fs.copyFile(selected.image_path, stagingPath);
  await sharp(stagingPath).metadata();
  await fs.rename(stagingPath, officialPath);
  const promotedHash = await hashFile(officialPath);
  await writeJson(`${officialPath}.metadata.json`, {
    schema: "goldflow_promoted_reference_candidate_v1",
    ref_id: target.ref_id,
    selected_candidate_id: selected.candidate_id,
    selected_candidate_path: selected.image_path,
    selected_candidate_sha256: selected.image_sha256 ?? await hashFile(selected.image_path),
    promoted_reference_path: officialPath,
    promoted_reference_sha256: promotedHash,
    generation_prompt: generation.prompt,
    generation_prompt_hash: selected.prompt_hash,
    reviewer: review.reviewer,
    reviewer_model: review.reviewer_model,
    candidate_scores: review.candidate_scores,
    selection_reason: review.selection_reason,
    previous_official: previousOfficial,
    promoted_at: new Date().toISOString(),
  });
  return {
    official_reference_path: officialPath,
    official_reference_sha256: promotedHash,
    previous_official: previousOfficial,
  };
}

function selectedCandidateRow(result) {
  const finalIteration = result.iterations[result.iterations.length - 1];
  return finalIteration?.generation?.candidates?.find((row) => row.candidate_id === finalIteration?.review?.selected_candidate_id) ?? null;
}

async function updateReferenceArtifacts({ visualReferencePlanPath, characterStateRefsPath, results }) {
  const [plan, characterRefs] = await Promise.all([
    readJson(visualReferencePlanPath, null),
    readJson(characterStateRefsPath, null),
  ]);
  const byId = new Map(results.filter((row) => row.status === "selected").map((row) => [row.ref_id, row]));
  if (plan?.reference_targets) {
    plan.reference_targets = plan.reference_targets.map((target) => {
      const result = byId.get(target.ref_id);
      if (!result) return target;
      const candidate = selectedCandidateRow(result);
      return {
        ...target,
        reference_image_path: result.promotion.official_reference_path,
        conditioning_image_path: result.promotion.official_reference_path,
        candidate_selection: {
          status: "selected",
          selected_candidate_id: candidate?.candidate_id ?? null,
          selected_candidate_sha256: candidate?.image_sha256 ?? result.promotion.official_reference_sha256,
          promoted_reference_sha256: result.promotion.official_reference_sha256,
          selection_report_path: result.selection_report_path,
        },
      };
    });
    plan.reference_candidate_selection_updated_at = new Date().toISOString();
    await writeJson(visualReferencePlanPath, plan);
  }
  if (characterRefs?.character_state_refs) {
    characterRefs.character_state_refs = characterRefs.character_state_refs.map((ref) => {
      const result = byId.get(ref.source_ref_id);
      return result ? {
        ...ref,
        reference_image_path: result.promotion.official_reference_path,
        conditioning_image_path: result.promotion.official_reference_path,
        candidate_selection: {
          status: "selected",
          selected_candidate_id: selectedCandidateRow(result)?.candidate_id ?? null,
          promoted_reference_sha256: result.promotion.official_reference_sha256,
        },
      } : ref;
    });
    characterRefs.reference_candidate_selection_updated_at = new Date().toISOString();
    await writeJson(characterStateRefsPath, characterRefs);
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const channel = flags.channel ?? "53rebirth";
  const series = flags.series ?? flags.seriesSlug ?? "series";
  const week = flags.week ?? "current";
  const episode = flags.episode ?? "ep_01";
  const episodeDir = flags["episode-dir"]
    ? path.resolve(flags["episode-dir"])
    : path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
  const visualReferencePlanPath = flags["visual-refs"] ?? path.join(episodeDir, "visual_reference_plan.json");
  const characterStateRefsPath = flags["character-state-refs"] ?? path.join(episodeDir, "character_state_refs.json");
  const approvalPath = flags["reference-plan-approval"] ?? path.join(episodeDir, "reference_plan_approval.json");
  const storyFactsPath = flags["story-facts"] ?? path.join(episodeDir, "story_fact_ledger.json");
  const visualBeatsPath = flags["visual-beats"] ?? path.join(episodeDir, "visual_beat_plan.json");
  const reportPath = flags.output ?? path.join(episodeDir, `reference_candidate_selection_${episode}.json`);
  const generationReportPath = flags["generation-output"] ?? path.join(episodeDir, `reference_candidate_generation_${episode}.json`);
  const [plan, characterRefs, approval, storyFacts, visualBeats] = await Promise.all([
    readJson(visualReferencePlanPath, null),
    readJson(characterStateRefsPath, null),
    readJson(approvalPath, null),
    readJson(storyFactsPath, null),
    readJson(visualBeatsPath, null),
  ]);
  if (!plan?.reference_targets?.length) throw new Error(`Missing reference targets: ${visualReferencePlanPath}`);
  const planHash = await hashFile(visualReferencePlanPath);
  if (!referencePlanApprovalMatches({ approval, plan, fileSha256: planHash }) && !isTrue(flags["allow-stale-reference-plan-approval"])) {
    throw new Error("Reference candidate casting refused: reference plan approval is missing or stale.");
  }
  const requestedIds = new Set(String(flags["reference-ids"] ?? flags["reference-id"] ?? "")
    .split(",").map((row) => row.trim()).filter(Boolean));
  const targets = plan.reference_targets
    .filter((target) => target.generation_mode === "standalone_ref" || target.required_before_imagegen === true || requestedIds.has(target.ref_id))
    .filter((target) => !requestedIds.size || requestedIds.has(target.ref_id));
  if (!targets.length) throw new Error("No matching standalone reference targets for candidate casting.");
  const explicitCount = flags["candidate-count"] !== undefined ? Number(flags["candidate-count"]) : null;
  const maxIterations = Math.max(1, Math.min(3, Number(flags["max-resolve-iterations"] ?? 2)));
  const autoResolve = flags["auto-resolve"] === undefined ? true : isTrue(flags["auto-resolve"]);
  const model = flags["reference-image-model"] ?? process.env.ANIFACTORY_REFERENCE_MODEL ?? "flux-klein";
  if (model !== "flux-klein") throw new Error(`visual cast-refs currently requires ModelsLab flux-klein; received ${model}.`);
  const width = Number(flags.width ?? flags["reference-image-width"] ?? 1024);
  const height = Number(flags.height ?? flags["reference-image-height"] ?? 576);
  const reviewerModel = flags.model ?? flags["llm-model"] ?? null;
  const reasoningEffort = flags["reasoning-effort"] ?? "medium";
  const force = isTrue(flags.force);
  const generationRows = [];
  const results = [];
  const targetById = new Map(plan.reference_targets.map((target) => [target.ref_id, target]));
  const resolvedReferencePaths = new Map(plan.reference_targets
    .map((target) => [target.ref_id, referencePathValue(target)])
    .filter(([, targetPath]) => targetPath));
  for (const target of targets) {
    const candidateCount = referenceCandidateCount(target, explicitCount);
    const stateRef = (characterRefs?.character_state_refs ?? []).find((ref) => ref.source_ref_id === target.ref_id);
    const dependencyIds = [stateRef?.base_identity_ref_id, target.identity_ref_id, target.source_identity_ref_id]
      .filter(Boolean)
      .filter((id, index, rows) => rows.indexOf(id) === index && id !== target.ref_id);
    const dependencyPathCandidates = dependencyIds
      .map((id) => resolvedReferencePaths.get(id) ?? referencePathValue(targetById.get(id)))
      .filter(Boolean);
    const dependencyPaths = [];
    for (const dependencyPath of dependencyPathCandidates) {
      if (await exists(dependencyPath)) dependencyPaths.push(dependencyPath);
    }
    const evidence = reviewEvidence(target, storyFacts, visualBeats);
    const iterations = [];
    let promptOverride = null;
    let selected = null;
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const generation = await generateCandidatesForTarget({
        episodeDir,
        target,
        candidateCount,
        iteration,
        promptOverride,
        model,
        width,
        height,
        force,
        dependencyPaths,
      });
      generationRows.push({ ref_id: target.ref_id, ...generation });
      const review = await reviewCandidates({
        episodeDir,
        episode,
        target,
        evidence,
        generation,
        iteration,
        model: reviewerModel,
        reasoningEffort,
      });
      iterations.push({ generation, review });
      if (review.status === "selected") {
        const promotion = await promoteCandidate({ episodeDir, target, generation, review });
        selected = { promotion, iteration, review };
        resolvedReferencePaths.set(target.ref_id, promotion.official_reference_path);
        break;
      }
      if (!autoResolve || iteration >= maxIterations || !review.revised_generation_prompt) break;
      promptOverride = review.revised_generation_prompt;
    }
    results.push({
      ref_id: target.ref_id,
      status: selected ? "selected" : "blocked",
      candidate_count: candidateCount,
      iterations,
      promotion: selected?.promotion ?? null,
      selected_iteration: selected?.iteration ?? null,
      selection_report_path: reportPath,
    });
  }
  const previousGenerationReport = await readJson(generationReportPath, null);
  const previousSelectionReport = await readJson(reportPath, null);
  const generatedRefIds = new Set(generationRows.map((row) => String(row.ref_id)));
  const mergedGenerationRows = [
    ...(previousGenerationReport?.target_batches ?? []).filter((row) => !generatedRefIds.has(String(row.ref_id))),
    ...generationRows,
  ];
  const selectedRefIds = new Set(results.map((row) => String(row.ref_id)));
  const mergedResults = [
    ...(previousSelectionReport?.targets ?? []).filter((row) => !selectedRefIds.has(String(row.ref_id))),
    ...results,
  ];
  await writeJson(generationReportPath, {
    schema: "goldflow_reference_candidate_generation_v1",
    status: mergedGenerationRows.every((row) => row.candidates.some((candidate) => candidate.status !== "failed")) ? "passed" : "failed",
    current_batch_status: generationRows.every((row) => row.candidates.some((candidate) => candidate.status !== "failed")) ? "passed" : "failed",
    episode_dir: episodeDir,
    visual_reference_plan_path: visualReferencePlanPath,
    visual_reference_plan_sha256: planHash,
    model,
    target_batches: mergedGenerationRows,
    updated_at: new Date().toISOString(),
  });
  const coverage = candidateSelectionCoverage(
    plan.reference_targets.filter((target) => target.generation_mode === "standalone_ref" || target.required_before_imagegen === true),
    { targets: mergedResults },
  );
  const currentBatchStatus = results.every((row) => row.status === "selected") ? "passed" : "blocked";
  const report = {
    schema: "goldflow_reference_candidate_selection_v1",
    status: coverage.passed ? "passed" : "blocked",
    current_batch_status: currentBatchStatus,
    episode_dir: episodeDir,
    visual_reference_plan_path: visualReferencePlanPath,
    visual_reference_plan_sha256_before_selection: planHash,
    reference_plan_approval_path: approvalPath,
    generation_report_path: generationReportPath,
    auto_resolve: autoResolve,
    max_resolve_iterations: maxIterations,
    reviewer: "codex-agent-vision",
    selection_coverage: coverage,
    targets: mergedResults,
    updated_at: new Date().toISOString(),
  };
  await writeJson(reportPath, report);
  await updateReferenceArtifacts({ visualReferencePlanPath, characterStateRefsPath, results });
  console.log(JSON.stringify({
    status: report.status,
    current_batch_status: report.current_batch_status,
    report_path: reportPath,
    generation_report_path: generationReportPath,
    targets: results.map((row) => ({
      ref_id: row.ref_id,
      status: row.status,
      selected_candidate_id: selectedCandidateRow(row)?.candidate_id ?? null,
      official_reference_path: row.promotion?.official_reference_path ?? null,
    })),
  }, null, 2));
  if (report.current_batch_status !== "passed") process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
