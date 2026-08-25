#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { referencePlanApprovalMatches } from "./lib/reference-plan-contract.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const REFERENCE_CLEANLINESS_CONTRACT_VERSION = "empty_hands_no_detachable_props_v1";
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = flags["episode-dir"]
  ? path.resolve(flags["episode-dir"])
  : path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const visualReferencePlanPath = flags.visualRefs ?? flags["visual-refs"] ?? path.join(episodeDir, "visual_reference_plan.json");
const referencePlanApprovalPath = flags["reference-plan-approval"] ?? path.join(episodeDir, "reference_plan_approval.json");
const characterStateRefsPath = flags.characterStateRefs ?? flags["character-state-refs"] ?? path.join(episodeDir, "character_state_refs.json");
// Reference approval is governed by the selected reference paths in the approved
// plan. A historical scene-image batch must never veto that separate gate.
const imagegenReportPath = flags.imagegenReport ?? flags["imagegen-report"] ?? path.join(episodeDir, `imagegen_report_codex_manual_${episode}.json`);
const approvalOutputPath = flags.output ?? path.join(episodeDir, `visual_reference_approval_${episode}.json`);

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

async function fileHash(filePath) {
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

function normalizedText(value) {
  return String(value ?? "").trim();
}

function materializedReferencePath(target) {
  const rawPath = normalizedText(target.conditioning_image_path ?? target.reference_image_path);
  if (!rawPath) return null;
  return path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(path.dirname(visualReferencePlanPath), rawPath);
}

function expectedCleanliness(target) {
  const kind = normalizedText(target.kind).toLowerCase();
  const role = normalizedText(target.conditioning_asset_role).toLowerCase();
  const generationMode = normalizedText(target.generation_mode).toLowerCase();
  const identityUsage = normalizedText(target.identity_usage).toLowerCase();
  const expectedVisibleHandsValue = target.expected_visible_hands;
  const expectedVisibleHands = expectedVisibleHandsValue !== null
    && expectedVisibleHandsValue !== undefined
    && expectedVisibleHandsValue !== ""
    && Number.isInteger(Number(expectedVisibleHandsValue))
    && Number(target.expected_visible_hands) >= 0
    ? Number(target.expected_visible_hands)
    : null;
  if (kind === "character_state" && generationMode === "source_only" && identityUsage === "face_only") {
    return {
      policy: "single_face_identity_clean_source",
      checks: [
        "one clear canonical facial identity with no second person or duplicate face",
        "facial likeness is unobstructed and suitable only as a face identity donor",
        "no visible handheld or detachable prop; hands and body are out of frame or any visible hand is empty",
        "no scene composition, UI, action, or background element likely to be treated as identity",
      ],
    };
  }
  if (kind === "character_state" && role === "creature_identity") {
    return {
      policy: "single_creature_identity_clean_plate",
      checks: [
        "exactly one canonical nonhuman actor in one coherent silhouette",
        "plain background with no unrelated story-scene contamination",
        expectedVisibleHands == null
          ? "every grasping or hand-like appendage is relaxed, readable, and empty"
          : `exactly ${expectedVisibleHands} grasping or hand-like appendages are visible as authored, readable, and empty`,
        "no detachable weapon, equipment, or carried prop",
        "signature anatomy visibly integrated at its declared body attachment point",
        "no separate duplicate anatomical prop or alternate body part",
      ],
    };
  }
  if (kind === "character_state" && role === "faction_language") {
    return {
      policy: "single_faction_language_clean_plate",
      checks: [
        "one coherent faction or uniform design language",
        "plain background with separated complete figures",
        "every visible hand is relaxed and empty",
        "uniforms, insignia, and worn armor only; no detachable weapons or carried props",
        "no story-scene action, UI, or environment contamination",
      ],
    };
  }
  if (kind === "character_state") {
    return {
      policy: "single_human_identity_empty_hands_clean_plate",
      checks: [
        "exactly one visible person in one canonical identity or state",
        "plain background with one coherent body and face",
        expectedVisibleHands == null
          ? "exact authored limb count preserved; every anatomically present visible hand relaxed and empty"
          : `exactly ${expectedVisibleHands} total natural or documented prosthetic hand endpoints are visible as authored, relaxed, and empty`,
        "no detachable weapon, shield, equipment, or carried prop",
      ],
    };
  }
  if (kind === "location") {
    return {
      policy: "unoccupied_environment_clean_plate",
      checks: [
        "one coherent environment or location",
        "no featured people or readable foreground actors",
        "no foreground prop, weapon, UI, or story-action contamination",
      ],
    };
  }
  if (kind === "prop") {
    return {
      policy: "single_unheld_prop_clean_plate",
      checks: [
        "exactly one canonical object",
        "object is unheld and isolated on a plain neutral field",
        "no hands, bodies, other props, UI, or story-scene contamination",
      ],
    };
  }
  if (kind === "ui") {
    return {
      policy: "single_ui_motif_clean_plate",
      checks: [
        "one coherent interface motif",
        "no person, hand, device, environment, or unrelated panel contamination",
      ],
    };
  }
  if (kind === "action") {
    return {
      policy: "single_action_effect_clean_plate",
      checks: [
        "one coherent action or effect language",
        "neutral field with no unrelated identity, prop, UI, or environment contamination",
      ],
    };
  }
  if (kind === "style") {
    return {
      policy: "single_style_language_clean_plate",
      checks: [
        "one coherent rendering and style language",
        "no unrelated identity sheet, prop lineup, UI panel, or multi-panel contamination",
      ],
    };
  }
  return {
    policy: "single_conditioning_concept_clean_plate",
    checks: ["one clean conditioning concept with no unrelated story-scene contamination"],
  };
}

async function materializedReferenceDecisions(targets, approvedBy, reviewNote, now, { agentReview = false } = {}) {
  const decisions = [];
  for (const target of targets) {
    const referencePath = materializedReferencePath(target);
    if (!referencePath) continue;
    const referenceImageSha256 = await fileHash(referencePath);
    if (!referenceImageSha256) {
      throw new Error(`Cannot approve: materialized reference ${target.ref_id ?? "unknown"} is missing or unreadable: ${referencePath}`);
    }
    const metadata = agentReview ? await sharp(referencePath, { failOn: "error" }).metadata() : null;
    if (agentReview && !(Number(metadata?.width) > 0 && Number(metadata?.height) > 0)) {
      throw new Error(`Cannot approve: materialized reference ${target.ref_id ?? "unknown"} has invalid raster geometry.`);
    }
    const expected = expectedCleanliness(target);
    decisions.push({
      ref_id: target.ref_id ?? null,
      kind: target.kind ?? null,
      generation_mode: target.generation_mode ?? null,
      conditioning_asset_role: target.conditioning_asset_role ?? null,
      reference_image_path: referencePath,
      reference_image_sha256: referenceImageSha256,
      expected_cleanliness_policy: expected.policy,
      expected_cleanliness_checks: expected.checks,
      structural_review: {
        readable: agentReview ? true : null,
        width: metadata?.width ?? null,
        height: metadata?.height ?? null,
        format: metadata?.format ?? null,
        channels: metadata?.channels ?? null,
        basis: agentReview ? "decoded_raster_metadata" : "operator_attestation",
      },
      cleanliness_status: "approved_clean",
      status: "approved_clean",
      decision: "approved_clean",
      reviewed_by: approvedBy,
      review_note: reviewNote,
      reviewed_at: now,
    });
  }
  return decisions;
}

async function assertCurrentPlanApprovalAndSourceHashes(visualReferencePlan, visualReferencePlanHash, planApproval) {
  if (!referencePlanApprovalMatches({
    approval: planApproval,
    plan: visualReferencePlan,
    fileSha256: visualReferencePlanHash,
  })) {
    throw new Error(`Cannot approve references: ${referencePlanApprovalPath} is missing or stale for ${visualReferencePlanPath}.`);
  }
  if (planApproval?.schema !== "goldflow_reference_plan_approval_v3") {
    throw new Error("Cannot approve references: the cleanliness contract requires a v3 reference-plan approval receipt.");
  }
  const approvedSourceById = new Map(
    (Array.isArray(planApproval?.source_reference_hashes) ? planApproval.source_reference_hashes : [])
      .map((row) => [String(row?.ref_id ?? ""), row]),
  );
  for (const target of visualReferencePlan?.reference_targets ?? []) {
    if (normalizedText(target?.generation_mode).toLowerCase() !== "source_only") continue;
    const refId = normalizedText(target?.ref_id);
    const row = approvedSourceById.get(refId);
    if (!row) throw new Error(`Cannot approve references: source-only ${refId} is absent from the v3 plan-approval receipt.`);
    const referencePath = materializedReferencePath(target);
    const approvedPath = row.reference_image_path ? path.resolve(String(row.reference_image_path)) : null;
    if (!referencePath || !approvedPath || path.resolve(referencePath) !== approvedPath) {
      throw new Error(`Cannot approve references: source-only ${refId} path differs from the approved source path.`);
    }
    const currentHash = await fileHash(referencePath);
    const approvedHash = normalizedText(row.source_reference_sha256 ?? row.reference_image_sha256).toLowerCase();
    if (!currentHash || currentHash.toLowerCase() !== approvedHash) {
      throw new Error(`Cannot approve references: source-only ${refId} changed after reference-plan approval.`);
    }
  }
}

async function main() {
  const [visualReferencePlan, characterStateRefs, imagegenReport, referencePlanApproval] = await Promise.all([
    readJson(visualReferencePlanPath, null),
    readJson(characterStateRefsPath, null),
    readJson(imagegenReportPath, null),
    readJson(referencePlanApprovalPath, null),
  ]);
  if (visualReferencePlan?.status !== "passed") {
    throw new Error(`visual_reference_plan.json must be passed before approval. Current status: ${visualReferencePlan?.status ?? "missing"}.`);
  }
  if (!Array.isArray(characterStateRefs?.character_state_refs)) {
    throw new Error(`Missing character_state_refs.json: ${characterStateRefsPath}`);
  }
  const allowedStatuses = new Set(["draft_needs_manual_review", "approved", "passed"]);
  if (!allowedStatuses.has(String(characterStateRefs.status ?? ""))) {
    throw new Error(`character_state_refs.json has unexpected status ${characterStateRefs.status ?? "missing"}.`);
  }
  const selectedTargets = Array.isArray(visualReferencePlan.reference_targets) ? visualReferencePlan.reference_targets : [];
  const cleanlinessContractVersion = normalizedText(visualReferencePlan.reference_cleanliness_contract_version);
  if (cleanlinessContractVersion && cleanlinessContractVersion !== REFERENCE_CLEANLINESS_CONTRACT_VERSION) {
    throw new Error(`Unsupported reference_cleanliness_contract_version: ${cleanlinessContractVersion}`);
  }
  const cleanlinessContractEnabled = cleanlinessContractVersion === REFERENCE_CLEANLINESS_CONTRACT_VERSION;
  const agentReview = flags["agent-review"] === "true";
  if (cleanlinessContractEnabled && flags["cleanliness-reviewed"] !== "true" && !agentReview) {
    throw new Error(`Reference cleanliness contract ${REFERENCE_CLEANLINESS_CONTRACT_VERSION} requires --cleanliness-reviewed true or --agent-review true.`);
  }
  const requiredTargets = selectedTargets.filter((target) => target.required_before_imagegen === true);
  const decisionRequiredTargets = cleanlinessContractEnabled
    ? selectedTargets.filter((target) => (
        target.required_before_imagegen === true
        || ["standalone_ref", "source_only"].includes(normalizedText(target.generation_mode).toLowerCase())
      ))
    : requiredTargets;
  const missingReferencePaths = decisionRequiredTargets
    .filter((target) => !(target.conditioning_image_path ?? target.reference_image_path))
    .map((target) => target.ref_id);
  if (missingReferencePaths.length && flags["allow-missing-reference-paths"] !== "true") {
    throw new Error(`Cannot approve: required references are missing image paths: ${missingReferencePaths.slice(0, 20).join(", ")}`);
  }
  if (imagegenReport?.reference_only === true && imagegenReport.status && imagegenReport.status !== "passed") {
    throw new Error(`Cannot approve: imagegen report exists but status is ${imagegenReport.status}.`);
  }
  const visualReferencePlanHash = await fileHash(visualReferencePlanPath);
  if (cleanlinessContractEnabled) {
    await assertCurrentPlanApprovalAndSourceHashes(
      visualReferencePlan,
      visualReferencePlanHash,
      referencePlanApproval,
    );
  }
  const now = new Date().toISOString();
  const approvedBy = flags["approved-by"] ?? "codex-agent";
  const reviewNote = flags.note ?? "Reference contact sheet and generated references reviewed; approved for visual prompt planning.";
  const referenceDecisions = cleanlinessContractEnabled
    ? await materializedReferenceDecisions(selectedTargets, approvedBy, reviewNote, now, { agentReview })
    : [];
  const referenceHashesById = Object.fromEntries(
    referenceDecisions.map((decision) => [decision.ref_id, decision.reference_image_sha256]),
  );
  const approvedRefs = {
    ...characterStateRefs,
    status: "approved",
    approved_at: now,
    approved_by: approvedBy,
    approval_note: reviewNote,
    reference_review_contact_sheet: flags["contact-sheet"] ?? null,
    source_hashes: cleanlinessContractEnabled
      ? {
          ...(characterStateRefs.source_hashes ?? {}),
          ...(visualReferencePlanHash ? { [visualReferencePlanPath]: visualReferencePlanHash } : {}),
          ...Object.fromEntries(referenceDecisions.map((decision) => [decision.reference_image_path, decision.reference_image_sha256])),
        }
      : visualReferencePlanHash
        ? { [visualReferencePlanPath]: visualReferencePlanHash }
        : (characterStateRefs.source_hashes ?? {}),
    ...(cleanlinessContractEnabled ? {
      reference_cleanliness_contract_version: cleanlinessContractVersion,
      reference_cleanliness_status: "approved_clean",
      reference_cleanliness_decisions: referenceDecisions,
    } : {}),
    character_state_refs: characterStateRefs.character_state_refs.map((ref) => ({
      ...ref,
      definitive: true,
    })),
  };
  const approvalReport = {
    schema: cleanlinessContractEnabled
      ? "goldflow_visual_reference_approval_v2"
      : "goldflow_visual_reference_approval_v1",
    status: "approved",
    channel,
    series_slug: series,
    week,
    episode,
    visual_reference_plan_path: visualReferencePlanPath,
    character_state_refs_path: characterStateRefsPath,
    visual_reference_plan_hash: visualReferencePlanHash,
    imagegen_report_path: imagegenReport ? imagegenReportPath : null,
    imagegen_status: imagegenReport?.status ?? null,
    required_reference_count: requiredTargets.length,
    character_state_ref_count: approvedRefs.character_state_refs.length,
    ...(cleanlinessContractEnabled ? {
      materialized_reference_count: referenceDecisions.length,
      reference_cleanliness_contract_version: cleanlinessContractVersion,
      cleanliness_reviewed: true,
      review_mode: agentReview ? "agent_structural_and_contract_review" : "human_visual_review",
      review_scope: agentReview
        ? "hash_lineage_readability_raster_geometry_and_single_concept_generation_contract; downstream identity-critical scene QA remains active"
        : "operator_attested_visual_cleanliness",
      reference_cleanliness_status: "approved_clean",
      reference_decisions: referenceDecisions,
      reference_hash_by_ref_id: referenceHashesById,
    } : {}),
    approved_by: approvedRefs.approved_by,
    approval_note: approvedRefs.approval_note,
    reference_review_contact_sheet: approvedRefs.reference_review_contact_sheet,
    updated_at: now,
  };
  await writeJson(characterStateRefsPath, approvedRefs);
  await writeJson(approvalOutputPath, approvalReport);
  console.log(JSON.stringify({
    status: "approved",
    character_state_refs_path: characterStateRefsPath,
    approval_report_path: approvalOutputPath,
    required_reference_count: requiredTargets.length,
    character_state_ref_count: approvedRefs.character_state_refs.length,
    ...(cleanlinessContractEnabled ? {
      materialized_reference_count: referenceDecisions.length,
      reference_cleanliness_contract_version: cleanlinessContractVersion,
    } : {}),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
