#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLLMModel, isLocalLLMRoute, localLLMAuthHeaders, localLLMChatCompletionURL } from "./lib/llm-router.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const semanticPlanPath = flags.semantic ?? path.join(episodeDir, "semantic_scene_plan.json");
const outputPath = flags.output ?? path.join(episodeDir, "visual_reference_plan.json");

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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function extractJson(text) {
  const raw = String(text ?? "").trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error(`LLM output did not contain JSON: ${raw.slice(0, 600)}`);
}

function compactScene(scene) {
  return {
    scene_id: scene.scene_id,
    title: scene.title,
    location: scene.location,
    time: scene.time,
    visible_subjects: scene.visible_subjects ?? [],
    primary_subject: scene.primary_subject ?? null,
    visual_intent: scene.visual_intent ?? "",
    character_states: scene.character_states ?? [],
    props: scene.props ?? [],
    ref_requirements: scene.ref_requirements ?? [],
    action_staging: scene.action_staging ?? "",
    continuity_notes: scene.continuity_notes ?? [],
  };
}

function buildPrompt(semanticPlan, { chunkLabel = null } = {}) {
  const compact = {
    source_script_hash: semanticPlan.source_script_hash,
    episode_summary: semanticPlan.episode_summary ?? "",
    global_reference_requirements: semanticPlan.global_reference_requirements ?? [],
    scene_count: semanticPlan.scenes?.length ?? 0,
    scenes: (semanticPlan.scenes ?? []).map(compactScene),
  };
  return `Create a visual reference strategy from this semantic scene plan.
${chunkLabel ? `\nThis is ${chunkLabel}. Identify reference needs visible in this chunk. A later LLM merge pass will combine duplicate targets across chunks.\n` : ""}

Rules:
- This stage decides reference strategy only. It does not write final image prompts.
- Identify recurring characters, character states, major locations, important props, UI motifs, and high-risk repeated action states.
- Decide whether each target needs a standalone reference, should be derived from a generated cut, needs no reference, or needs operator/manual review.
- Use generic production logic. Do not hardcode story-specific rules.
- Positive visual language is mandatory. Prompt anchors must describe what should appear, never what should be avoided.
- Do not use negative prompt clauses or mitigation phrasing such as "no", "not", "without", "avoid", "exclude", "instead of", or "rather than" in prompt_anchor fields.
- Translate source text that contains negative wording into positive visual wording. Use "windowless room" for "no windows", "single visible subject" for absent extra characters, and "plain open-collar garment" for unwanted formalwear risk.
- Convert risks into positive construction. Example: write "single visible protagonist centered in frame, plain institutional detainee jacket with open collar and flat fabric panels" rather than saying what clothing or extra characters to avoid.
- Prompt anchors must be concrete and specific enough for image generation, but they are draft anchors requiring manual review before reference generation.
- Lower-priority entities should usually use derive_from_first_clean_cut or derive_from_best_cut rather than standalone_ref.
- Major recurring characters and visually sensitive wardrobe/state changes should usually use standalone_ref or manual_review.
- Major recurring locations may use standalone_ref or derive_from_first_clean_wide_cut.
- Return only valid JSON.

SEMANTIC PLAN:
${JSON.stringify(compact, null, 2)}

Return:
{
  "reference_targets": [
    {
      "ref_id": "stable_snake_case_id",
      "kind": "style|character_state|location|prop|ui|action",
      "subject": "human readable subject",
      "scene_ids": ["scene_001"],
      "priority": "required|high|medium|low",
      "generation_mode": "standalone_ref|derive_from_first_clean_cut|derive_from_best_cut|derive_from_first_clean_wide_cut|no_ref_needed|manual_review",
      "required_before_imagegen": true,
      "reference_image_path": null,
      "prompt_anchor": "positive draft reference prompt anchor",
      "anchor_cut_policy": "none|first_clean_visible_cut|best_clean_visible_cut|first_clean_wide_cut",
      "appearance_count": 1,
      "risk_notes": ["identity blend risk, wardrobe ambiguity, scale ambiguity, etc."],
      "manual_review_required": true
    }
  ],
  "character_state_refs": [
    {
      "state_ref_id": "stable_snake_case_id",
      "character": "character name",
      "scene_ids": ["scene_001"],
      "prompt_anchor": "definitive draft character/state prompt anchor for manual review",
      "definitive": false,
      "reference_image_path": null,
      "source_ref_id": "matching reference_targets ref_id"
    }
  ],
  "warnings": []
}`;
}

function buildMergePrompt(semanticPlan, chunkPlans) {
  const compact = {
    source_script_hash: semanticPlan.source_script_hash,
    episode_summary: semanticPlan.episode_summary ?? "",
    global_reference_requirements: semanticPlan.global_reference_requirements ?? [],
    scene_count: semanticPlan.scenes?.length ?? 0,
    scene_ids: (semanticPlan.scenes ?? []).map((scene) => scene.scene_id),
  };
  const compactChunkPlans = chunkPlans.map((plan, index) => ({
    chunk: index + 1,
    reference_targets: (plan.reference_targets ?? []).map((target) => ({
      ref_id: target.ref_id,
      kind: target.kind,
      subject: target.subject,
      scene_ids: target.scene_ids ?? [],
      priority: target.priority,
      generation_mode: target.generation_mode,
      required_before_imagegen: target.required_before_imagegen,
      prompt_anchor: String(target.prompt_anchor ?? "").slice(0, 280),
      anchor_cut_policy: target.anchor_cut_policy,
      appearance_count: target.appearance_count,
      risk_notes: (target.risk_notes ?? []).slice(0, 2).map((note) => String(note).slice(0, 120)),
      manual_review_required: target.manual_review_required,
    })),
    character_state_refs: (plan.character_state_refs ?? []).map((ref) => ({
      state_ref_id: ref.state_ref_id,
      character: ref.character,
      scene_ids: ref.scene_ids ?? [],
      prompt_anchor: String(ref.prompt_anchor ?? "").slice(0, 280),
      source_ref_id: ref.source_ref_id,
    })),
    warnings: (plan.warnings ?? []).slice(0, 5),
  }));
  return `Merge chunked visual reference strategy outputs into one coherent episode-level visual reference plan.

Rules:
- Qwen authors the merged plan. Code will only validate schema and blockers.
- Merge duplicate character/location/prop/UI/action targets across chunks.
- Preserve all relevant scene_ids from the chunk plans.
- Keep generation_mode decisions coherent at episode level.
- Positive visual language is mandatory. Prompt anchors must describe what should appear, never what should be avoided.
- Do not use negative prompt clauses or mitigation phrasing such as "no", "not", "without", "avoid", "exclude", "instead of", or "rather than" in prompt_anchor fields.
- Translate source text that contains negative wording into positive visual wording. Use "windowless room" for "no windows", "single visible subject" for absent extra characters, and "plain open-collar garment" for unwanted formalwear risk.
- Convert risks into positive construction: exact visible subject count, role, pose, action direction, wardrobe construction, frame composition, and location details.
- Major recurring characters and visually sensitive wardrobe/state changes should usually use standalone_ref or manual_review.
- Lower-priority entities should usually use derive_from_first_clean_cut or derive_from_best_cut rather than standalone_ref.
- Return only valid JSON.

EPISODE SUMMARY:
${JSON.stringify(compact, null, 2)}

CHUNK PLANS:
${JSON.stringify(compactChunkPlans, null, 2)}

Return:
{
  "reference_targets": [
    {
      "ref_id": "stable_snake_case_id",
      "kind": "style|character_state|location|prop|ui|action",
      "subject": "human readable subject",
      "scene_ids": ["scene_001"],
      "priority": "required|high|medium|low",
      "generation_mode": "standalone_ref|derive_from_first_clean_cut|derive_from_best_cut|derive_from_first_clean_wide_cut|no_ref_needed|manual_review",
      "required_before_imagegen": true,
      "reference_image_path": null,
      "prompt_anchor": "positive draft reference prompt anchor",
      "anchor_cut_policy": "none|first_clean_visible_cut|best_clean_visible_cut|first_clean_wide_cut",
      "appearance_count": 1,
      "risk_notes": ["identity blend risk, wardrobe ambiguity, scale ambiguity, etc."],
      "manual_review_required": true
    }
  ],
  "character_state_refs": [
    {
      "state_ref_id": "stable_snake_case_id",
      "character": "character name",
      "scene_ids": ["scene_001"],
      "prompt_anchor": "definitive draft character/state prompt anchor for manual review",
      "definitive": false,
      "reference_image_path": null,
      "source_ref_id": "matching reference_targets ref_id"
    }
  ],
  "warnings": []
}`;
}

async function callLocal(prompt, stageName, maxTokens = null) {
  const attempts = Number(flags["visual-ref-json-attempts"] ?? 3);
  let lastError = null;
  let lastContent = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const retryPrompt = attempt === 1 ? prompt : `${prompt}\n\nReturn one complete valid JSON object only. No markdown fences, commentary, trailing commas, or partial objects.`;
    const response = await fetch(localLLMChatCompletionURL(stageName), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...localLLMAuthHeaders() },
      body: JSON.stringify({
        model: getLLMModel(stageName),
        messages: [
          { role: "system", content: "Return only valid JSON. You are a visual reference strategy planner for longform anime/manhwa production. Use positive visual language only: describe what should appear, never what should be avoided." },
          { role: "user", content: retryPrompt },
        ],
        temperature: attempt === 1 ? Number(flags["llm-temperature"] ?? 0.12) : 0,
        max_tokens: Number(maxTokens ?? flags["llm-max-tokens"] ?? 14000),
      }),
      signal: AbortSignal.timeout(Number(process.env.ANIFACTORY_VISUAL_REF_PLAN_TIMEOUT_MS ?? 1_200_000)),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`local-qwen visual refs HTTP ${response.status}: ${raw.slice(0, 1000)}`);
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content ?? raw;
    lastContent = content;
    try {
      return { provider: "local-qwen", model: getLLMModel(stageName), content, parsed: extractJson(content), json_attempt: attempt };
    } catch (error) {
      lastError = error;
      console.error(`visual refs ${stageName}: invalid JSON attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`local-qwen visual refs returned invalid JSON after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}; content preview: ${lastContent.slice(0, 600)}`);
}

async function callCodex(prompt, stageName) {
  const callDir = path.join(weekDir, "_codex_calls");
  await fs.mkdir(callDir, { recursive: true });
  const outputPath = path.join(callDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${stageName}-output.txt`);
  await new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", "--ephemeral", "--skip-git-repo-check", "-C", repoRoot, "-o", outputPath], { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`codex visual refs exited ${code}: ${stderr}`)));
    child.stdin.end(prompt);
  });
  const content = await fs.readFile(outputPath, "utf8");
  return { provider: "codex", model: "codex_cli_default", output_path: outputPath, content, parsed: extractJson(content) };
}

function normalizeTarget(target, index) {
  const refId = String(target.ref_id ?? `${target.kind ?? "ref"}_${index + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const mode = String(target.generation_mode ?? "manual_review");
  return {
    ref_id: refId,
    kind: target.kind ?? "unknown",
    subject: target.subject ?? refId,
    scene_ids: Array.isArray(target.scene_ids) ? target.scene_ids : [],
    priority: target.priority ?? "medium",
    generation_mode: ["standalone_ref", "derive_from_first_clean_cut", "derive_from_best_cut", "derive_from_first_clean_wide_cut", "no_ref_needed", "manual_review"].includes(mode) ? mode : "manual_review",
    required_before_imagegen: Boolean(target.required_before_imagegen),
    prompt_anchor: String(target.prompt_anchor ?? "").trim(),
    anchor_cut_policy: target.anchor_cut_policy ?? "none",
    appearance_count: Number(target.appearance_count ?? 0),
    risk_notes: Array.isArray(target.risk_notes) ? target.risk_notes : [],
    manual_review_required: target.manual_review_required !== false,
    reference_image_path: target.reference_image_path ?? target.path ?? null,
  };
}

function normalizeStateRef(ref, index) {
  const character = String(ref.character ?? ref.character_name ?? ref.name ?? `character_${index + 1}`).trim();
  const stateRefId = String(ref.state_ref_id ?? ref.ref_id ?? `${character}_${index + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return {
    state_ref_id: stateRefId,
    character,
    scene_ids: Array.isArray(ref.scene_ids) ? ref.scene_ids : [],
    prompt_anchor: String(ref.prompt_anchor ?? "").trim(),
    definitive: false,
    reference_image_path: ref.reference_image_path ?? null,
    source_ref_id: ref.source_ref_id ?? ref.ref_id ?? null,
  };
}

function negativeLanguageMatches(value) {
  const text = String(value ?? "").toLowerCase();
  const patterns = [
    /\bno\b/,
    /\bnot\b/,
    /\bwithout\b/,
    /\bavoid\b/,
    /\bexclude\b/,
    /\binstead\s+of\b/,
    /\brather\s+than\b/,
    /\bdo\s+not\b/,
    /\bdon't\b/,
    /--no\b/,
    /\bnegative\s+prompt\b/,
  ];
  return patterns.filter((pattern) => pattern.test(text)).map(String);
}

function assertPositiveAnchors(referenceTargets, characterStateRefs) {
  const failures = [];
  for (const target of referenceTargets) {
    const matches = negativeLanguageMatches(target.prompt_anchor);
    if (matches.length) failures.push(`reference_targets.${target.ref_id}.prompt_anchor contains negative visual language: ${matches.join(", ")}`);
  }
  for (const ref of characterStateRefs) {
    const matches = negativeLanguageMatches(ref.prompt_anchor);
    if (matches.length) failures.push(`character_state_refs.${ref.state_ref_id}.prompt_anchor contains negative visual language: ${matches.join(", ")}`);
  }
  if (failures.length) {
    throw new Error(`Visual reference plan violates positive-language-only contract:\n${failures.slice(0, 20).join("\n")}`);
  }
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function createReferencePlan(semanticPlan, stageName) {
  const useChunking = isLocalLLMRoute(stageName)
    && flags["visual-ref-chunking"] !== "false"
    && semanticPlan.scenes.length > Number(flags["visual-ref-single-call-max-scenes"] ?? 12);
  if (!useChunking) {
    const prompt = buildPrompt(semanticPlan);
    return isLocalLLMRoute(stageName) ? await callLocal(prompt, stageName) : await callCodex(prompt, stageName);
  }

  const sceneChunks = chunkArray(semanticPlan.scenes, Number(flags["visual-ref-chunk-scenes"] ?? 8));
  const chunkPlans = [];
  for (let index = 0; index < sceneChunks.length; index += 1) {
    console.error(`visual refs chunk ${index + 1}/${sceneChunks.length}: ${sceneChunks[index].length} scenes`);
    const chunkSemanticPlan = {
      ...semanticPlan,
      scenes: sceneChunks[index],
      scene_count: sceneChunks[index].length,
    };
    const prompt = buildPrompt(chunkSemanticPlan, { chunkLabel: `chunk ${index + 1} of ${sceneChunks.length}` });
    const llm = await callLocal(prompt, `${stageName}_chunk_${String(index + 1).padStart(2, "0")}`, Number(flags["visual-ref-chunk-max-tokens"] ?? 7000));
    if (!Array.isArray(llm.parsed.reference_targets) || !llm.parsed.reference_targets.length) {
      throw new Error(`Visual reference chunk ${index + 1}/${sceneChunks.length} returned no reference_targets.`);
    }
    chunkPlans.push(llm.parsed);
    console.error(`visual refs chunk ${index + 1}/${sceneChunks.length}: accepted ${llm.parsed.reference_targets.length} targets`);
  }
  console.error(`visual refs merge: ${chunkPlans.length} chunk plans`);
  const mergePrompt = buildMergePrompt(semanticPlan, chunkPlans);
  const merged = await callLocal(mergePrompt, `${stageName}_merge`, Number(flags["visual-ref-merge-max-tokens"] ?? 8000));
  return {
    provider: "local-qwen",
    model: getLLMModel(stageName),
    chunked: true,
    chunk_count: sceneChunks.length,
    parsed: merged.parsed,
    json_attempt: merged.json_attempt,
  };
}

async function main() {
  const semanticPlan = await readJson(semanticPlanPath, null);
  if (semanticPlan?.status !== "passed" || !Array.isArray(semanticPlan.scenes) || !semanticPlan.scenes.length) throw new Error(`Missing passed semantic scene plan: ${semanticPlanPath}`);
  const stageName = `${episode}_visual_reference_plan`;
  const llm = await createReferencePlan(semanticPlan, stageName);
  const referenceTargets = (Array.isArray(llm.parsed.reference_targets) ? llm.parsed.reference_targets : []).map(normalizeTarget);
  if (!referenceTargets.length) throw new Error("Visual reference planner returned no reference_targets.");
  const characterStateRefs = (Array.isArray(llm.parsed.character_state_refs) ? llm.parsed.character_state_refs : []).map(normalizeStateRef);
  assertPositiveAnchors(referenceTargets, characterStateRefs);
  const report = {
    schema: "goldflow_visual_reference_plan_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: semanticPlan.source_script_hash,
    source_artifact_paths: [semanticPlanPath],
    source_hashes: Object.fromEntries((await Promise.all([semanticPlanPath].map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
    planner: { provider: llm.provider, model: llm.model ?? null, output_path: llm.output_path ?? null, chunked: llm.chunked ?? false, chunk_count: llm.chunk_count ?? null },
    policy: "Reference strategy only. Manual review must approve prompt anchors before reference generation or production imagegen.",
    reference_targets: referenceTargets,
    character_state_refs: characterStateRefs,
    warnings: llm.parsed.warnings ?? [],
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  await writeJson(path.join(episodeDir, "character_state_refs.json"), {
    schema: "goldflow_character_state_refs_v1",
    status: "draft_needs_manual_review",
    source_visual_reference_plan_path: outputPath,
    source_script_hash: semanticPlan.source_script_hash,
    character_state_refs: report.character_state_refs,
    updated_at: report.updated_at,
  });
  console.log(JSON.stringify({ status: "passed", output_path: outputPath, reference_target_count: referenceTargets.length, character_state_ref_count: report.character_state_refs.length }, null, 2));
}

main().catch(async (error) => {
  await writeJson(outputPath, { schema: "goldflow_visual_reference_plan_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
