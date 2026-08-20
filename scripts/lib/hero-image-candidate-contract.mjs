import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { runCodexCli } from "./codex-cli-runner.mjs";

export const HERO_CANDIDATE_PLAN_SCHEMA = "goldflow_hero_image_candidate_plan_v1";
export const HERO_CANDIDATE_SELECTION_SCHEMA = "goldflow_hero_image_candidate_selection_v1";

function cleanText(value) {
  return String(value ?? "").trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isHeroPrompt(prompt) {
  const tier = cleanText(prompt?.quality_budget?.tier ?? prompt?.beat_value?.tier).toLowerCase();
  return tier === "hero" || Number(prompt?.quality_budget?.image_candidate_count ?? 1) === 2;
}

function candidateId(imageId, label, prompt = null) {
  const sourceHash = cleanText(prompt?.prompt_hash)
    || sha256(JSON.stringify({
      prompt: prompt?.provider_prompt ?? prompt?.image_prompt ?? null,
      shot_manifest: prompt?.shot_manifest ?? null,
      reference_requirements: prompt?.reference_requirements ?? [],
    }));
  return `${cleanText(imageId)}__hero_${label.toLowerCase()}_${sourceHash.slice(0, 10)}`;
}

function variantDirection(label) {
  if (label === "A") {
    return "HERO CANDIDATE A: prioritize literal event clarity, exact contact geometry, readable identities, and immediate package-payoff comprehension.";
  }
  return "HERO CANDIDATE B: preserve every identity, state, action, count, location, and continuity fact while exploring the strongest alternate camera distance or angle for emotional force and thumbnail-readable silhouette.";
}

function candidateRow(prompt, label) {
  const basePrompt = cleanText(prompt?.provider_prompt ?? prompt?.image_prompt ?? prompt?.codex_image_prompt);
  const providerPrompt = `${basePrompt}\n\n${variantDirection(label)}`;
  return {
    ...prompt,
    image_id: candidateId(prompt.image_id, label, prompt),
    target_image_id: candidateId(prompt.image_id, label, prompt),
    provider_prompt: providerPrompt,
    image_prompt: providerPrompt,
    codex_image_prompt: prompt?.codex_image_prompt === null ? null : providerPrompt,
    modelslab_image_prompt: cleanText(prompt?.modelslab_image_prompt) ? providerPrompt : prompt?.modelslab_image_prompt ?? "",
    prompt_hash: sha256(providerPrompt),
    image_strategy: "fresh",
    reuse_source_image_id: null,
    editorial_reuse_approved: false,
    quality_budget: {
      ...(prompt?.quality_budget ?? {}),
      tier: "hero",
      image_candidate_count: 1,
      parent_candidate_count: 2,
    },
    hero_candidate: {
      schema: "goldflow_hero_image_candidate_identity_v1",
      canonical_image_id: prompt.image_id,
      candidate_label: label,
      candidate_id: candidateId(prompt.image_id, label, prompt),
      selection_blinded: true,
      story_contract_changed: false,
    },
  };
}

export function buildHeroCandidatePromptPlan(promptPlan, { sourcePath = null, sourceSha256 = null } = {}) {
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts)) {
    throw new Error("Hero candidate planning requires a passed hardened prompt plan.");
  }
  const heroPrompts = promptPlan.prompts.filter((prompt) => prompt?.image_generation_required !== false && isHeroPrompt(prompt));
  const prompts = heroPrompts.flatMap((prompt) => [candidateRow(prompt, "A"), candidateRow(prompt, "B")]);
  return {
    ...promptPlan,
    schema: HERO_CANDIDATE_PLAN_SCHEMA,
    status: "passed",
    source_prompt_plan_path: sourcePath,
    source_prompt_plan_sha256: sourceSha256,
    candidate_policy: "exactly_two_preauthorized_candidates_for_authored_hero_beats_only",
    canonical_hero_image_ids: heroPrompts.map((prompt) => prompt.image_id),
    candidate_count: prompts.length,
    prompts,
  };
}

export function heroCandidateGroups(candidatePlan) {
  const groups = new Map();
  for (const prompt of candidatePlan?.prompts ?? []) {
    const canonicalId = cleanText(prompt?.hero_candidate?.canonical_image_id);
    if (!canonicalId) continue;
    const rows = groups.get(canonicalId) ?? [];
    rows.push(prompt);
    groups.set(canonicalId, rows);
  }
  return [...groups.entries()].map(([canonical_image_id, prompts]) => ({
    canonical_image_id,
    prompts: prompts.sort((left, right) => cleanText(left?.hero_candidate?.candidate_label).localeCompare(cleanText(right?.hero_candidate?.candidate_label))),
  }));
}

function semanticScore(row) {
  if (!row) return { score: -100, pass: 0, fail: 0, uncertain: 0 };
  const checks = Array.isArray(row.checks) ? row.checks : [];
  const pass = checks.filter((check) => check.verdict === "pass").length;
  const fail = checks.filter((check) => check.verdict === "fail").length;
  const uncertain = checks.filter((check) => check.verdict === "uncertain").length;
  const confidence = row.confidence === "high" ? 2 : row.confidence === "medium" ? 1 : 0;
  return { score: pass * 3 - fail * 9 - uncertain * 4 + confidence, pass, fail, uncertain };
}

function parseJson(value) {
  const text = cleanText(value);
  try {
    return JSON.parse(text);
  } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error("Hero image selector did not return JSON.");
}

function selectorPrompt({ canonicalPrompt, candidateRows }) {
  return `You are selecting one production hero frame from two blinded generated candidates. Image 1 is Candidate A and Image 2 is Candidate B. Judge the actual pixels, not provider identity. The winning frame must first satisfy the exact story event, identities, state, subject count, contact geometry, object ownership, location, and screen geography. Among candidates that satisfy those, prefer immediate comprehension, emotional force, clean silhouette, focal hierarchy, depth, and editability. Do not prefer decorative detail over correctness.

CANONICAL HERO CONTRACT:
${JSON.stringify({
    image_id: canonicalPrompt?.image_id,
    visual_job: canonicalPrompt?.visual_job,
    visual_information_delta: canonicalPrompt?.visual_information_delta,
    provider_prompt: canonicalPrompt?.provider_prompt ?? canonicalPrompt?.image_prompt,
    shot_manifest: canonicalPrompt?.shot_manifest,
    audiovisual_intent: canonicalPrompt?.audiovisual_intent,
  }, null, 2)}

CANDIDATE SEMANTIC AUDITS:
${JSON.stringify(candidateRows.map((row) => ({
    label: row.label,
    semantic_audit: row.semantic_audit,
  })), null, 2)}

Return JSON only:
{
  "schema":"goldflow_blind_hero_image_selector_v1",
  "winner":"A|B",
  "story_contract":"pass|needs_review",
  "event_clarity":"A|B|tie",
  "identity_and_state":"A|B|tie",
  "contact_and_object_geometry":"A|B|tie",
  "composition_and_focal_hierarchy":"A|B|tie",
  "editability":"A|B|tie",
  "winner_visible_evidence":"specific visible evidence",
  "loser_disadvantage":"specific visible issue",
  "confidence":"low|medium|high"
}`;
}

async function defaultBlindSelector({ canonicalPrompt, candidateRows, outputPath, repoRoot, model, reasoningEffort, timeoutMs }) {
  const result = await runCodexCli({
    prompt: selectorPrompt({ canonicalPrompt, candidateRows }),
    stageName: "hero_image_blind_selection",
    repoRoot,
    outputPath,
    model,
    reasoningEffort,
    verbosity: "low",
    timeoutMs,
    provider: "codex_cli",
    extraArgs: ["--sandbox", "read-only", ...candidateRows.flatMap((row) => ["--image", row.image_path])],
  });
  return parseJson(result.content);
}

export async function selectHeroCandidate({
  canonicalPrompt,
  candidates,
  semanticAuditRows = [],
  outputPath,
  repoRoot,
  model = null,
  reasoningEffort = "medium",
  timeoutMs = 600_000,
  blindSelector = defaultBlindSelector,
  selectedAt = new Date(),
} = {}) {
  const rows = (candidates ?? []).map((candidate) => {
    const semantic = semanticAuditRows.find((row) => row.image_id === candidate.image_id) ?? null;
    const label = cleanText(candidate?.candidate_label ?? candidate?.hero_candidate?.candidate_label);
    return { ...candidate, label, semantic_audit: semantic, semantic_score: semanticScore(semantic) };
  }).filter((row) => ["A", "B"].includes(row.label) && row.image_path && row.image_sha256);
  if (!rows.length) throw new Error(`Hero selection has no materialized candidates for ${canonicalPrompt?.image_id}.`);
  let winner;
  let selectionMethod;
  let blindResult = null;
  if (rows.length === 1) {
    winner = rows[0];
    selectionMethod = "degraded_single_materialized_candidate";
  } else {
    const ordered = [...rows].sort((left, right) => right.semantic_score.score - left.semantic_score.score || left.label.localeCompare(right.label));
    const scoreDelta = ordered[0].semantic_score.score - ordered[1].semantic_score.score;
    if (scoreDelta >= 5) {
      winner = ordered[0];
      selectionMethod = "semantic_contract_dominance";
    } else {
      try {
        blindResult = await blindSelector({ canonicalPrompt, candidateRows: rows, outputPath, repoRoot, model, reasoningEffort, timeoutMs });
        const winnerLabel = cleanText(blindResult?.winner).toUpperCase();
        winner = rows.find((row) => row.label === winnerLabel) ?? ordered[0];
        selectionMethod = rows.some((row) => row.label === winnerLabel) ? "blind_visual_selector" : "blind_selector_invalid_fallback_to_semantic_score";
      } catch (error) {
        winner = ordered[0];
        selectionMethod = "blind_selector_unavailable_fallback_to_semantic_score";
        blindResult = { error: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  const loser = rows.find((row) => row.image_id !== winner.image_id) ?? null;
  return {
    schema: HERO_CANDIDATE_SELECTION_SCHEMA,
    status: selectionMethod === "degraded_single_materialized_candidate" ? "selected_degraded" : "selected",
    canonical_image_id: canonicalPrompt?.image_id,
    selection_method: selectionMethod,
    selected_at: selectedAt.toISOString(),
    selected_candidate: {
      label: winner.label,
      image_id: winner.image_id,
      image_path: winner.image_path,
      image_sha256: winner.image_sha256,
      browser_provider: winner.browser_provider ?? null,
      provider_receipt_path: winner.provider_receipt_path ?? null,
      provider_receipt_sha256: winner.provider_receipt_sha256 ?? null,
      semantic_score: winner.semantic_score,
    },
    rejected_candidate: loser ? {
      label: loser.label,
      image_id: loser.image_id,
      image_path: loser.image_path,
      image_sha256: loser.image_sha256,
      browser_provider: loser.browser_provider ?? null,
      provider_receipt_path: loser.provider_receipt_path ?? null,
      provider_receipt_sha256: loser.provider_receipt_sha256 ?? null,
      semantic_score: loser.semantic_score,
    } : null,
    blind_selector: blindResult,
    candidate_count: rows.length,
    story_contract_changed: false,
  };
}

export async function writeCanonicalHeroSelectionReceipt({ selection, outputPath, canonicalPromptPlanPath, canonicalPromptPlanSha256 }) {
  const selected = selection?.selected_candidate;
  if (!selected?.image_path || !selected?.image_sha256) throw new Error("Canonical hero receipt requires a selected candidate raster.");
  const sourceReceiptSha256 = selected.provider_receipt_path
    ? await fs.readFile(selected.provider_receipt_path).then((bytes) => sha256(bytes)).catch(() => null)
    : null;
  if (selected.provider_receipt_sha256 && sourceReceiptSha256 !== selected.provider_receipt_sha256) {
    throw new Error(`Selected hero candidate provider receipt changed for ${selection.canonical_image_id}.`);
  }
  const receipt = {
    schema: "goldflow_canonical_hero_image_selection_receipt_v1",
    status: "selected",
    asset_id: selection.canonical_image_id,
    browser_provider: selected.browser_provider,
    accepted_png_sha256: selected.image_sha256,
    canonical_prompt_plan_path: canonicalPromptPlanPath,
    canonical_prompt_plan_sha256: canonicalPromptPlanSha256,
    selection,
    source_candidate_provider_receipt_path: selected.provider_receipt_path,
    source_candidate_provider_receipt_sha256: sourceReceiptSha256,
    created_at: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { receipt, sha256: await fs.readFile(outputPath).then((bytes) => sha256(bytes)) };
}
