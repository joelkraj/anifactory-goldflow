#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { generateModelslabImage } from "./modelslab-image-helper.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts_reviewed.json");
const visualReferencePlanPath = flags.referencePlan ?? flags["reference-plan"] ?? path.join(episodeDir, "visual_reference_plan.json");
const characterStateRefsPath = flags.characterStateRefs ?? flags["character-state-refs"] ?? path.join(episodeDir, "character_state_refs.json");
const imageDir = path.join(episodeDir, "assets", "images");
const referenceDir = path.join(imageDir, "references");
const reportPath = flags.output ?? path.join(episodeDir, `imagegen_report_${episode}.json`);
const concurrency = Math.max(1, Math.min(24, Number(flags.concurrency ?? process.env.ANIFACTORY_IMAGEGEN_CONCURRENCY ?? 8)));
const referenceConcurrency = Math.max(1, Math.min(8, Number(flags["reference-concurrency"] ?? process.env.ANIFACTORY_REFERENCE_IMAGEGEN_CONCURRENCY ?? 3)));
const force = flags.force === "true";
const skipReferenceGeneration = flags["skip-reference-generation"] === "true";
const maxSceneReferences = Math.max(0, Math.min(4, Number(flags["max-scene-references"] ?? 4)));

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function hashFile(filePath) {
  try {
    return sha256(await fs.readFile(filePath));
  } catch {
    return null;
  }
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requestedIds() {
  return new Set(String(flags["cut-ids"] ?? flags["image-ids"] ?? flags["image-id"] ?? "").split(",").map((row) => row.trim()).filter(Boolean));
}

function imagePathFor(prompt) {
  return path.join(imageDir, `${prompt.image_id}-modelslab-image.png`);
}

function referencePathFor(target) {
  return path.join(referenceDir, `${target.ref_id}-modelslab-reference.png`);
}

function referencePrompt(target) {
  const kind = String(target.kind ?? "");
  const kindInstruction = {
    style: "style reference sheet: anime/manhwa rendering language, line quality, color palette, lighting, and polished production finish",
    character_state: "character identity reference sheet: face, hair, age, body type, wardrobe, expression range, and material details; scene prompts will provide action pose",
    location: "location reference sheet: environment, architecture, scale, lighting, materials, and readable geography",
    prop: "prop reference sheet: object shape, surface, markings, scale, and material details",
    ui: "UI reference sheet: interface layout, typography, color, glow, panels, and exact display motif",
    action: "action and effect reference sheet: movement path, energy color, effect shape, interaction pattern, and spatial logic on a clean neutral staging field",
  }[kind] ?? "production reference image";
  const parts = [
    target.prompt_anchor,
    kindInstruction,
    target.subject ? `subject: ${target.subject}` : "",
    "clean production reference, stable visual design, cinematic anime manhwa longform frame",
  ].filter(Boolean);
  return parts.join(", ");
}

function referenceFresh(target, outputPath) {
  return promptFresh({ image_id: target.ref_id, prompt_hash: sha256(referencePrompt(target)), modelslab_image_prompt: referencePrompt(target) }, outputPath);
}

async function validateReferences(prompt) {
  const paths = [...new Set((prompt.required_reference_paths ?? []).filter(Boolean))];
  const missing = [];
  for (const refPath of paths) {
    if (!(await exists(refPath))) missing.push(refPath);
  }
  if (missing.length) {
    throw new Error(`Missing required reference(s) for ${prompt.image_id}: ${missing.join(", ")}`);
  }
  return paths;
}

function referenceSortKey(requirement, index) {
  const explicitOrder = Number(requirement.slot_order ?? requirement.order ?? requirement.image_slot ?? NaN);
  const requiredRank = requirement.required === true ? 0 : 1;
  const kind = String(requirement.kind ?? "").toLowerCase();
  const kindRank = kind.includes("character") ? 0
    : kind.includes("location") ? 1
      : kind.includes("prop") ? 2
        : kind.includes("style") ? 3
          : kind.includes("ui") ? 4
            : kind.includes("action") ? 5
              : 6;
  return {
    requiredRank,
    kindRank,
    explicitOrder: Number.isFinite(explicitOrder) ? explicitOrder : 999,
    index,
  };
}

function referenceSlotPurpose(requirement) {
  const kind = String(requirement.kind ?? "").toLowerCase();
  const subject = requirement.subject ?? requirement.ref_id;
  if (kind.includes("character")) return `character identity and wardrobe for ${subject}`;
  if (kind.includes("location")) return `location environment for ${subject}`;
  if (kind.includes("style")) return "anime manhwa style language";
  if (kind.includes("action")) return `action or effect design for ${subject}`;
  if (kind.includes("ui")) return `UI design for ${subject}`;
  if (kind.includes("prop")) return `prop design for ${subject}`;
  return `visual reference for ${subject}`;
}

function slotWord(value) {
  return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"][Number(value)] ?? String(value);
}

function referenceSlotInstruction(slots) {
  if (!slots.length) return "";
  return slots.map((slot) => `Use image ${slotWord(slot.slot)} as ${slot.purpose}.`).join(" ");
}

function normalizeName(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function characterReferenceRequirements(prompt, characterRefs, existingIds) {
  const sceneId = String(prompt.scene_id ?? "");
  const visibleText = [
    ...(Array.isArray(prompt.visible_subjects) ? prompt.visible_subjects : []),
    prompt.primary_subject,
  ].map(normalizeName).filter(Boolean).join(" | ");
  const characterBySourceRef = new Map(
    (characterRefs ?? [])
      .filter((ref) => ref.source_ref_id && (ref.character || ref.subject))
      .map((ref) => [ref.source_ref_id, normalizeName(ref.character ?? ref.subject)])
  );
  const coveredCharacters = new Set(
    [...existingIds]
      .map((refId) => characterBySourceRef.get(refId))
      .filter(Boolean)
  );
  const inferred = [];
  for (const ref of characterRefs ?? []) {
    const character = normalizeName(ref.character ?? ref.subject ?? "");
    const sourceRefId = ref.source_ref_id ?? ref.ref_id ?? null;
    if (!character || !sourceRefId || existingIds.has(sourceRefId) || !ref.reference_image_path) continue;
    if (coveredCharacters.has(character)) continue;
    if (Array.isArray(ref.scene_ids) && ref.scene_ids.length && sceneId && !ref.scene_ids.includes(sceneId)) continue;
    if (!visibleText.includes(character)) continue;
    coveredCharacters.add(character);
    inferred.push({
      ref_id: sourceRefId,
      kind: "character_state",
      required: true,
      slot_order: 0,
      slot_purpose: `character identity and wardrobe for ${ref.character ?? ref.subject ?? sourceRefId}`,
      reason: "Visible named character has an approved character_state_ref; attached to reduce multi-character identity bleed.",
      inferred_from_visible_subject: true,
    });
  }
  return inferred;
}

function attachReferencePathsToPrompts(plan, referenceById, characterRefs = []) {
  const prompts = (plan.prompts ?? []).map((prompt) => {
    const authoredRequirements = Array.isArray(prompt.reference_requirements)
      ? prompt.reference_requirements.filter((requirement) => requirement.inferred_from_visible_subject !== true)
      : [];
    const existingIds = new Set(authoredRequirements.map((requirement) => requirement.ref_id).filter(Boolean));
    const requirements = [
      ...authoredRequirements,
      ...characterReferenceRequirements(prompt, characterRefs, existingIds),
    ];
    const selected = requirements
      .map((requirement, index) => ({
        requirement,
        index,
        path: referenceById.get(requirement.ref_id),
        sortKey: referenceSortKey(requirement, index),
      }))
      .filter((row) => row.path)
      .sort((a, b) => a.sortKey.requiredRank - b.sortKey.requiredRank || a.sortKey.kindRank - b.sortKey.kindRank || a.sortKey.explicitOrder - b.sortKey.explicitOrder || a.sortKey.index - b.sortKey.index)
      .slice(0, maxSceneReferences);
    const selectedIds = new Set(selected.map((row) => row.requirement.ref_id));
    const referenceSlots = selected.map((row, index) => ({
      slot: index + 1,
      ref_id: row.requirement.ref_id,
      kind: row.requirement.kind ?? null,
      path: row.path,
      purpose: row.requirement.slot_purpose ?? referenceSlotPurpose(row.requirement),
      reason: row.requirement.reason ?? null,
    }));
    return {
      ...prompt,
      reference_requirements: requirements,
      required_reference_paths: selected.map((row) => row.path),
      reference_slots: referenceSlots,
      reference_usage: requirements.map((requirement) => {
        const refPath = referenceById.get(requirement.ref_id) ?? null;
        if (!refPath) {
          return {
            ref_id: requirement.ref_id,
            usage: requirement.required ? "missing_reference_coverage" : "not_attached_missing_optional_reference",
            reason: "Reference image path is not available.",
          };
        }
        if (!selectedIds.has(requirement.ref_id)) {
          return {
            ref_id: requirement.ref_id,
            usage: "available_not_attached_reference_limit",
            reference_image_path: refPath,
            reason: `Scene already uses the maximum ${maxSceneReferences} reference images for model stability.`,
          };
        }
        return {
          ref_id: requirement.ref_id,
          usage: "attached_reference",
          reference_image_path: refPath,
          reason: requirement.reason ?? "Referenced by reviewed scene prompt.",
        };
      }),
    };
  });
  return { ...plan, prompts, reference_paths_attached_at: new Date().toISOString(), max_scene_references: maxSceneReferences };
}

function promptWithReferenceSlots(prompt) {
  const basePrompt = String(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? "").trim();
  const slotInstruction = referenceSlotInstruction(prompt.reference_slots ?? []);
  return [slotInstruction, basePrompt].filter(Boolean).join(" ");
}

async function promptFresh(prompt, outputPath) {
  if (!(await exists(outputPath))) return false;
  const sidecar = `${outputPath}.prompt.sha256`;
  if (!(await exists(sidecar))) return false;
  const current = String(await fs.readFile(sidecar, "utf8")).trim();
  return current === (prompt.prompt_hash ?? sha256(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? ""));
}

async function runPool(items, worker, limit) {
  const results = [];
  let index = 0;
  async function next() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

async function generateOne(prompt) {
  const outputPath = imagePathFor(prompt);
  const referenceImagePaths = await validateReferences(prompt);
  const modelPrompt = promptWithReferenceSlots(prompt);
  const promptHash = sha256(modelPrompt);
  if (!force && await promptFresh({ ...prompt, prompt_hash: promptHash, modelslab_image_prompt: modelPrompt }, outputPath)) {
    return { image_id: prompt.image_id, status: "reused_fresh", image_path: outputPath, prompt_hash: promptHash };
  }
  const generated = await generateModelslabImage({
    prompt: modelPrompt,
    outputPath,
    referenceImagePaths,
    model: prompt.image_model_route ?? "flux-klein",
  });
  await fs.writeFile(`${outputPath}.prompt.sha256`, promptHash, "utf8");
  await writeJson(`${outputPath}.metadata.json`, {
    image_id: prompt.image_id,
    prompt_hash: promptHash,
    source_prompt_path: promptPath,
    reference_image_paths: referenceImagePaths,
    reference_slots: prompt.reference_slots ?? [],
    modelslab_prompt: modelPrompt,
    model: prompt.image_model_route ?? "flux-klein",
    generated,
    updated_at: new Date().toISOString(),
  });
  return { image_id: prompt.image_id, status: "generated", image_path: outputPath, prompt_hash: promptHash, generated };
}

async function generateReference(target, styleRefPath = null) {
  const outputPath = referencePathFor(target);
  const prompt = referencePrompt(target);
  const promptHash = sha256(prompt);
  if (!force && await referenceFresh(target, outputPath)) {
    return { ref_id: target.ref_id, status: "reused_fresh", image_path: outputPath, prompt_hash: promptHash };
  }
  const referenceImagePaths = target.ref_id !== "style_ref" && styleRefPath ? [styleRefPath] : [];
  const generated = await generateModelslabImage({
    prompt,
    outputPath,
    referenceImagePaths,
    model: target.image_model_route ?? "flux-klein",
  });
  await fs.writeFile(`${outputPath}.prompt.sha256`, promptHash, "utf8");
  await writeJson(`${outputPath}.metadata.json`, {
    ref_id: target.ref_id,
    kind: target.kind,
    subject: target.subject,
    prompt_hash: promptHash,
    source_reference_plan_path: visualReferencePlanPath,
    reference_image_paths: referenceImagePaths,
    model: target.image_model_route ?? "flux-klein",
    generated,
    updated_at: new Date().toISOString(),
  });
  return { ref_id: target.ref_id, status: "generated", image_path: outputPath, prompt_hash: promptHash, generated };
}

async function generateReferences() {
  const referencePlan = await readJson(visualReferencePlanPath, null);
  const characterRefs = await readJson(characterStateRefsPath, null);
  if (!referencePlan?.reference_targets?.length || skipReferenceGeneration) {
    return {
      referencePlan,
      characterRefs,
      results: [],
      referenceById: new Map([
        ...(referencePlan?.reference_targets ?? []).filter((target) => target.reference_image_path).map((target) => [target.ref_id, target.reference_image_path]),
        ...(characterRefs?.character_state_refs ?? []).filter((ref) => ref.source_ref_id && ref.reference_image_path).map((ref) => [ref.source_ref_id, ref.reference_image_path]),
      ]),
    };
  }
  await fs.mkdir(referenceDir, { recursive: true });
  const targets = referencePlan.reference_targets
    .filter((target) => target.generation_mode === "standalone_ref" || target.required_before_imagegen === true);
  const styleTarget = targets.find((target) => target.ref_id === "style_ref");
  const results = [];
  let styleRefPath = null;
  if (styleTarget) {
    const result = await generateReference(styleTarget, null);
    results.push(result);
    styleRefPath = result.image_path;
  }
  const remaining = targets.filter((target) => target.ref_id !== "style_ref");
  results.push(...await runPool(remaining, (target) => generateReference(target, styleRefPath), referenceConcurrency));
  const referenceById = new Map([
    ...results.map((row) => [row.ref_id, row.image_path]),
    ...(characterRefs?.character_state_refs ?? []).filter((ref) => ref.source_ref_id && ref.reference_image_path).map((ref) => [ref.source_ref_id, ref.reference_image_path]),
  ]);
  const updatedReferencePlan = {
    ...referencePlan,
    reference_targets: referencePlan.reference_targets.map((target) => ({
      ...target,
      reference_image_path: referenceById.get(target.ref_id) ?? target.reference_image_path ?? null,
    })),
    reference_generation_updated_at: new Date().toISOString(),
  };
  await writeJson(visualReferencePlanPath, updatedReferencePlan);
  if (characterRefs?.character_state_refs) {
    const updatedCharacterRefs = {
      ...characterRefs,
      character_state_refs: characterRefs.character_state_refs.map((ref) => ({
        ...ref,
        reference_image_path: referenceById.get(ref.source_ref_id) ?? ref.reference_image_path ?? null,
      })),
      reference_generation_updated_at: new Date().toISOString(),
    };
    await writeJson(characterStateRefsPath, updatedCharacterRefs);
  }
  return { referencePlan: updatedReferencePlan, characterRefs, results, referenceById };
}

async function main() {
  const referenceRun = await generateReferences();
  let plan = await readJson(promptPath, null);
  if (plan?.status !== "passed" || !Array.isArray(plan.prompts) || !plan.prompts.length) throw new Error(`Missing passed section image prompt plan: ${promptPath}`);
  if (referenceRun.referenceById?.size) {
    plan = attachReferencePathsToPrompts(plan, referenceRun.referenceById, referenceRun.characterRefs?.character_state_refs ?? []);
    await writeJson(promptPath, plan);
  }
  const scope = requestedIds();
  const prompts = plan.prompts
    .filter((prompt) => prompt.image_generation_required !== false)
    .filter((prompt) => !scope.size || scope.has(prompt.image_id));
  if (!prompts.length) throw new Error("No image prompts selected for generation.");
  await fs.mkdir(imageDir, { recursive: true });
  const results = await runPool(prompts, generateOne, concurrency);
  const report = {
    schema: "goldflow_imagegen_report_v1",
    status: results.every((row) => row.status === "generated" || row.status === "reused_fresh") ? "passed" : "failed",
    channel,
    series_slug: series,
    week,
    episode,
    prompt_plan_path: promptPath,
    prompt_plan_hash: await hashFile(promptPath),
    image_dir: imageDir,
    concurrency,
    image_count: results.length,
    reference_count: referenceRun.results.length,
    reference_results: referenceRun.results,
    results,
    updated_at: new Date().toISOString(),
  };
  await writeJson(reportPath, report);
  console.log(JSON.stringify({ status: report.status, report_path: reportPath, image_count: results.length }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch(async (error) => {
  await writeJson(reportPath, { schema: "goldflow_imagegen_report_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
