#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexCli } from "./lib/codex-cli-runner.mjs";
import { parseJsonObjectFromPlannerOutput } from "./lib/json-output-repair.mjs";
import {
  SOURCE_DRAFT_CANDIDATE_SPECS,
  sourceDraftCandidateContract,
  sourceModelContract,
  validateSourceModelReceipt,
} from "./lib/source-model-policy.mjs";
import {
  EVIDENCE_STORY_ROOM_PROFILE,
  FIRST_CLASS_STORY_ROOM_PROFILE_V4,
  REFERENCE_DENSITY_ROOM_PROFILE_V1,
  REFERENCE_DENSITY_ROOM_PROFILE_V2,
  REFERENCE_DENSITY_ROOM_PROFILE_V3,
  REFERENCE_DENSITY_NORMALIZATION_POLICY,
  REFERENCE_DENSITY_DIMENSION_IDS,
  bindReferenceDensityAnchors,
  bindReferenceMeritFrontierAnchors,
  bindSourceSemanticAcceptanceAnchors,
  bindTreatmentSelectionAnchors,
  hasDramaticColdOpenContract,
  PACKAGE_ADJUDICATION_SCHEMA,
  PACKAGE_OUTLIER_LEDGER_SCHEMA_V2,
  PACKAGE_OUTLIER_LEDGER_SCHEMA_V3,
  PREMISE_SLATE_V3_SCHEMA,
  SOURCE_STAGE_APPROVAL_SCHEMA,
  sha256CanonicalJson,
  projectPackageOutlierEntries,
  validateArchitectureRedteam,
  validateLongformDraftSelection,
  validatePackageTournament,
  validatePackageTournamentConsensus,
  validatePackageAdjudication,
  validatePremiseSelectionV2,
  validateReferenceDensityDominance,
  validateReferenceMeritFrontier,
  validatePremiseSlateV2,
  validatePackageOutlierLedger,
  validateSourceDiagnosticV2,
  validateSourceEvidenceRegistry,
  validateSourceRevisionLedger,
  validateSourceRoomReleaseV2,
  validateSourceSemanticAcceptance,
  validateSourceStageApproval,
  validateStoryArchitecture,
  validateTreatmentBakeoff,
  validateTreatmentSelection,
} from "./lib/winner-source-room-v2-contract.mjs";
import {
  LONGFORM_DRAFT_PORTFOLIO_SCHEMA,
  NARRATION_REVISION_LEDGER_SCHEMA,
  PREMISE_BLIND_SELECTION_V3_SCHEMA,
  PREMISE_POOL_V3_SCHEMA,
  STORY_TRUTH_AUDIT_SCHEMA,
  STORY_TRUTH_IR_SCHEMA,
  STORY_TRUTH_SCRIPT_MAP_SCHEMA,
  sha256CanonicalStoryJson,
  validateLongformDraftPortfolio,
  validateNarrationRevisionLedger,
  validatePremiseBlindSelectionV3,
  validatePremisePoolV3,
  validateStoryTruthAudit,
  validateStoryTruthIr,
  validateStoryTruthScriptMap,
} from "./lib/first-class-story-contract.mjs";
import { validateStoryWriterPacket } from "./lib/story-writer-packet-contract.mjs";
import {
  buildSourceNameFamiliarityLedgerFromDisk,
  continuationExemptNameFamiliarityLedger,
  titleSignalsContinuation,
  validateSourceNameFamiliarityLedger,
} from "./lib/source-name-familiarity.mjs";
import { validateViewerTournamentAcceptance } from "./lib/source-viewer-tournament-contract.mjs";
import {
  validateOpeningAudioAuditionManifest,
  validateOpeningAudioAuditionReview,
} from "./lib/source-opening-audio-audition-contract.mjs";
import {
  aggregateMixedViewerShadow,
  validateMixedViewerShadowManifest,
  validateMixedViewerShadowReport,
} from "./lib/source-mixed-viewer-shadow-contract.mjs";
import { validateMixedViewerCalibrationPolicy } from "./lib/source-mixed-viewer-calibration-contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const action = process.argv[2] ?? "help";
const flags = parseFlags(process.argv.slice(3));
const channel = String(flags.channel ?? "53rebirth").trim();
const developmentSlug = String(flags["development-slug"] ?? flags.slug ?? "").trim();
const timeoutMs = positiveInteger(flags["timeout-ms"], 1_800_000);

const FILES = Object.freeze({
  evidence: "source_evidence_registry.json",
  evidenceReceipt: "source_evidence_registry_receipt.json",
  packageOutliers: "package_outlier_ledger.json",
  packageOutliersReceipt: "package_outlier_ledger_receipt.json",
  premiseSlateGpt: "premise_slate_gpt_v3.json",
  premiseSlateGemini: "premise_slate_gemini_v3.json",
  premiseMovieSlateA: "premise_movie_slate_a.json",
  premiseMovieSlateB: "premise_movie_slate_b.json",
  premiseMoviePool: "premise_movie_pool.json",
  premiseMovieSelection: "premise_movie_selection.json",
  premiseMoviePromotion: "premise_movie_operator_promotion.json",
  premisePool: "premise_pool_v3.json",
  premiseBlindSelection: "premise_blind_selection_v3.json",
  premiseFinalistLineage: "premise_finalist_lineage_v3.json",
  premiseSlate: "premise_slate_v2.json",
  premiseSelection: "premise_selection_v2.json",
  packageTournamentGpt: "package_tournament_gpt.json",
  packageTournamentGemini: "package_tournament_gemini.json",
  packageTournamentConsensus: "package_tournament_consensus.json",
  packageAdjudication: "package_adjudication.json",
  packageOperatorRevision: "package_operator_revision.json",
  packageApproval: "package_selection_approval.json",
  referenceTranscript: "reference_outlier_transcript.txt",
  referenceReceipt: "reference_outlier_receipt.json",
  referenceMeritFrontier: "reference_merit_frontier.json",
  roomContract: "source_room_contract.json",
  treatmentBakeoff: "treatment_bakeoff.json",
  treatmentSelection: "treatment_selection.json",
  treatmentApproval: "treatment_selection_approval.json",
  architecture: "story_architecture.json",
  nameFamiliarity: "source_name_familiarity_ledger.json",
  architectureRedteam: "architecture_redteam.json",
  architectureApproval: "story_architecture_approval.json",
  storyTruthIr: "story_truth_ir.json",
  storyTruthAudit: "story_truth_audit.json",
  storyTruthScriptMap: "story_truth_script_map.json",
  writerPacket: "story_writer_packet.json",
  draftGpt: "draft_gpt_web.txt",
  draftGemini: "draft_gemini_web.txt",
  draftPortfolio: "longform_draft_portfolio.json",
  draftSelection: "longform_draft_selection.json",
  initialScript: "initial_selected_script.txt",
  causalityDiagnostic: "causality_learning_diagnostic.json",
  continuityDiagnostic: "promise_continuity_diagnostic.json",
  authenticityDiagnostic: "narrative_authenticity_diagnostic.json",
  openingStressDiagnostic: "opening_stress_diagnostic.json",
  characterAgencyDiagnostic: "character_agency_diagnostic.json",
  antiSlopDiagnostic: "anti_slop_diagnostic.json",
  referenceDensityDiagnostic: "reference_density_dominance_diagnostic.json",
  revisedScript: "script_revised.txt",
  revisionLedger: "source_revision_ledger.json",
  narrationPolishedScript: "script_narration_polished.txt",
  narrationRevisionLedger: "narration_revision_ledger.json",
  semanticAcceptance: "source_semantic_acceptance.json",
  finalApproval: "final_script_approval.json",
  viewerTournamentDirectory: "viewer_tournament",
  viewerTournamentAcceptance: "viewer_tournament_acceptance.json",
  openingAudioAuditionDirectory: "opening_audio_audition",
  mixedViewerPanelDirectory: "mixed_viewer_panel",
  release: "source_room_release_v2.json",
});

const PROMPTS = Object.freeze({
  premiseAuthor: "manhwa_recap_premise_slate_v2.md",
  premiseAuthorV3: "manhwa_recap_premise_slate_v3.md",
  premiseMovieDiscovery: "manhwa_recap_premise_movie_discovery_v1.md",
  premiseMovieSelector: "manhwa_recap_premise_movie_selector_v1.md",
  premiseSelector: "manhwa_recap_premise_selector_v2.md",
  premiseBlindSelector: "manhwa_recap_premise_blind_selector_v3.md",
  packageTournament: "manhwa_recap_package_tournament_v1.md",
  referenceMeritFrontier: "manhwa_recap_reference_merit_frontier_v1.md",
  treatments: "manhwa_recap_treatment_bakeoff_v1.md",
  treatmentSelector: "manhwa_recap_treatment_selector_v1.md",
  architecture: "manhwa_recap_story_architecture_v1.md",
  architectureRedteam: "manhwa_recap_architecture_redteam_v1.md",
  storyTruthIr: "manhwa_recap_story_truth_ir_v1.md",
  storyTruthAudit: "manhwa_recap_story_truth_audit_v1.md",
  storyTruthScriptMap: "manhwa_recap_story_truth_script_map_v1.md",
  writerPacket: "manhwa_recap_story_writer_packet_v1.md",
  longform: "manhwa_recap_longform_writer_v8.md",
  longformSelectorLegacy: "manhwa_recap_longform_draft_selector_v1.md",
  longformSelector: "manhwa_recap_longform_draft_selector_v2.md",
  causalityDiagnostic: "manhwa_recap_causality_learning_diagnostic_v2.md",
  continuityDiagnostic: "manhwa_recap_promise_continuity_diagnostic_v2.md",
  authenticityDiagnostic: "manhwa_recap_narrative_authenticity_diagnostic_v1.md",
  openingStressDiagnostic: "manhwa_recap_opening_stress_diagnostic_v1.md",
  characterAgencyDiagnostic: "manhwa_recap_character_agency_diagnostic_v1.md",
  antiSlopDiagnostic: "manhwa_recap_anti_slop_diagnostic_v1.md",
  referenceDensityDiagnostic: "manhwa_recap_reference_density_diagnostic_v1.md",
  revision: "manhwa_recap_developmental_revision_v2.md",
  narrationRevision: "manhwa_recap_narration_revision_v1.md",
  acceptance: "manhwa_recap_semantic_acceptance_v1.md",
});

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = parts[index + 1];
    const value = next && !next.startsWith("--") ? next : "true";
    if (parsed[key] === undefined) parsed[key] = value;
    else parsed[key] = `${parsed[key]},${value}`;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function isTrue(value) {
  return /^(?:true|1|yes)$/i.test(String(value ?? ""));
}

function positiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`Expected a positive integer, received ${value}.`);
  return number;
}

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`Missing required ${label}.`);
  return normalized;
}

function developmentDirectory() {
  if (flags["development-dir"]) return path.resolve(flags["development-dir"]);
  required(developmentSlug, "--development-slug <stable-slug>");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(developmentSlug)) {
    throw new Error(`Invalid --development-slug ${developmentSlug}.`);
  }
  return path.join(dataRoot, "channels", channel, "source_development", developmentSlug);
}

function artifactPath(name) {
  return path.join(developmentDirectory(), name);
}

function rawResponsePath(id, extension = "txt") {
  return path.join(developmentDirectory(), ".model_responses", `${id}.${extension}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value) {
  return sha256(Buffer.from(String(value), "utf8"));
}

function countWords(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readBytes(filePath) {
  return fs.readFile(filePath);
}

async function readText(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readText(filePath));
  } catch (error) {
    throw new Error(`Invalid JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fileSha256(filePath) {
  return sha256(await readBytes(filePath));
}

async function writeExclusive(filePath, bytes) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Refusing to overwrite existing artifact: ${filePath}`);
    throw error;
  }
}

async function writeJsonExclusive(filePath, value) {
  await writeExclusive(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertValid(label, validation) {
  if (!validation?.done) throw new Error(`${label} is blocked: ${(validation?.blockers ?? ["unknown_validation_failure"]).join(", ")}`);
  return validation;
}

async function validatedJson(fileName, validator, options = {}) {
  const filePath = artifactPath(fileName);
  if (!await exists(filePath)) throw new Error(`Missing required artifact: ${filePath}`);
  const document = await readJson(filePath);
  const validation = validator(document, options);
  assertValid(fileName, validation);
  return { path: filePath, document, sha256: await fileSha256(filePath), validation };
}

async function promptTemplate(fileName) {
  const filePath = path.join(repoRoot, "docs", "prompts", fileName);
  const markdown = await readText(filePath);
  const fenced = markdown.match(/```text\s*\n([\s\S]*?)\n```/i);
  if (!fenced) throw new Error(`Prompt template has no text fence: ${filePath}`);
  return { path: filePath, text: fenced[1].trim(), sha256: sha256Text(markdown) };
}

function embedded(label, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return `\n\n===== ${label} =====\n${text}`;
}

function premiseEvidenceProjection(evidence) {
  return {
    schema: "goldflow_premise_evidence_projection_v1",
    source_registry_sha256: evidence.sha256,
    claims: evidence.document.claims.map((claim) => ({
      claim_id: claim.claim_id,
      claim: claim.claim,
      limitation: claim.limitation,
    })),
  };
}

function premiseOutlierProjection(ledger) {
  const projectedEntries = projectPackageOutlierEntries(ledger.document);
  const structuredV2 = [PACKAGE_OUTLIER_LEDGER_SCHEMA_V2, PACKAGE_OUTLIER_LEDGER_SCHEMA_V3].includes(ledger.document.schema);
  const commentLanguageV3 = ledger.document.schema === PACKAGE_OUTLIER_LEDGER_SCHEMA_V3;
  return {
    schema: "goldflow_premise_outlier_projection_v1",
    source_ledger_sha256: ledger.sha256,
    projection_policy: structuredV2
      ? commentLanguageV3
        ? "verified_breakout_plus_anonymized_comment_language_v3"
        : "verified_breakout_vpd_views_rank_with_package_grammar_cap_3_v2"
      : "legacy_top_12_public_plus_top_12_own_channel_in_source_order",
    limitations: ledger.document.limitations ?? [],
    entries: projectedEntries.map((entry) => ({
      entry_id: entry.entry_id,
      title: entry.title,
      source_type: entry.source_type,
      performance_signal: entry.performance_signal,
      ...(structuredV2 ? {
        video_id: entry.video_id,
        channel_title: entry.channel_title,
        published_at: entry.published_at,
        captured_at: entry.captured_at,
        views: Number(entry.views),
        views_per_day: Number(entry.views_per_day),
        previous_ten_median_views: entry.previous_ten_median_views,
        breakout_multiple: entry.breakout_multiple,
        measurement_status: entry.measurement_status,
        package_grammar: entry.package_grammar,
        thumbnail_reference: entry.thumbnail_reference,
      } : {}),
    })),
    comment_language_evidence: commentLanguageV3
      ? ledger.document.comment_language_evidence
        .filter((row) => projectedEntries.some((entry) => entry.entry_id === row.source_entry_id))
        .map((row) => ({
          evidence_id: row.evidence_id,
          source_entry_id: row.source_entry_id,
          source_video_id: row.source_video_id,
          category: row.category,
          exact_comment: row.exact_comment,
          production_use: row.production_use,
        }))
      : [],
  };
}

async function internalPremiseExclusionProjection() {
  const weeklyRoot = path.join(dataRoot, "channels", channel, "weekly_runs");
  const entries = [];
  const seen = new Set();
  const runDirectories = await fs.readdir(weeklyRoot, { withFileTypes: true }).catch(() => []);
  for (const runDirectory of runDirectories.filter((row) => row.isDirectory())) {
    const episodesRoot = path.join(weeklyRoot, runDirectory.name, "episodes");
    const episodeDirectories = await fs.readdir(episodesRoot, { withFileTypes: true }).catch(() => []);
    for (const episodeDirectory of episodeDirectories.filter((row) => row.isDirectory() && /^ep_\d+$/.test(row.name))) {
      const identityPath = path.join(episodesRoot, episodeDirectory.name, "run_identity.json");
      const identity = await readJson(identityPath).catch(() => null);
      const title = String(identity?.title ?? "").trim();
      if (!title) continue;
      const key = title.toLocaleLowerCase("en-US");
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        title,
        run_slug: runDirectory.name,
        episode: episodeDirectory.name,
        run_intent: identity?.run_intent ?? null,
        identity_path: identityPath,
      });
    }
  }
  return {
    schema: "goldflow_internal_premise_exclusion_projection_v1",
    policy: "canonical_weekly_run_identities_only_no_recovery_copies",
    entries: entries.sort((left, right) => left.run_slug.localeCompare(right.run_slug)),
  };
}

const PREMISE_MOVIE_FIELDS = Object.freeze([
  "id",
  "story_movie",
  "human_wound",
  "strange_specific_situation",
  "protagonist_owned_action",
  "desirable_reversal",
  "power_fantasy_receipt",
  "escalation_frontier",
  "visual_icon",
  "unresolved_consequence",
  "emotional_symmetry",
  "nearest_outlier_id",
  "retained_demand_dna",
  "novelty_axis",
]);

function validatePremiseMovieSlate(document, { evidenceSha256, outlierSha256, outlierIds }) {
  const blockers = [];
  if (document?.schema !== "goldflow_premise_movie_slate_v1") blockers.push("premise_movie_slate_schema_invalid");
  if (document?.status !== "discovered") blockers.push("premise_movie_slate_status_invalid");
  if (document?.evidence_registry_sha256 !== evidenceSha256) blockers.push("premise_movie_slate_evidence_hash_mismatch");
  if (document?.package_outlier_ledger_sha256 !== outlierSha256) blockers.push("premise_movie_slate_outlier_hash_mismatch");
  const candidates = Array.isArray(document?.candidates) ? document.candidates : [];
  if (candidates.length !== 12) blockers.push(`premise_movie_slate_count_${candidates.length}_not_12`);
  const ids = [];
  for (const [index, candidate] of candidates.entries()) {
    for (const field of PREMISE_MOVIE_FIELDS) {
      if (!String(candidate?.[field] ?? "").trim()) blockers.push(`premise_movie_${index}_${field}_missing`);
    }
    ids.push(String(candidate?.id ?? ""));
    if (!outlierIds.has(candidate?.nearest_outlier_id)) blockers.push(`premise_movie_${index}_outlier_unknown`);
    if (candidate?.noun_swap_test?.decision !== "pass") blockers.push(`premise_movie_${index}_noun_swap_not_passed`);
    for (const field of ["abstraction", "closest_supplied_movie", "material_difference"]) {
      if (!String(candidate?.noun_swap_test?.[field] ?? "").trim()) blockers.push(`premise_movie_${index}_noun_swap_${field}_missing`);
    }
  }
  if (new Set(ids).size !== ids.length) blockers.push("premise_movie_slate_ids_duplicate");
  return { done: blockers.length === 0, blockers };
}

function validatePremiseMovieSelection(document, { poolSha256, evidenceSha256, blindIds }) {
  const blockers = [];
  if (document?.schema !== "goldflow_premise_movie_selection_v1") blockers.push("premise_movie_selection_schema_invalid");
  if (!['selected', 'rejected'].includes(document?.status)) blockers.push("premise_movie_selection_status_invalid");
  if (document?.premise_movie_pool_sha256 !== poolSha256) blockers.push("premise_movie_selection_pool_hash_mismatch");
  if (document?.evidence_registry_sha256 !== evidenceSha256) blockers.push("premise_movie_selection_evidence_hash_mismatch");
  const selected = Array.isArray(document?.selected_blind_ids) ? document.selected_blind_ids : [];
  if (document?.status === "selected" && selected.length !== 6) blockers.push(`premise_movie_selection_selected_count_${selected.length}_not_6`);
  if (document?.status === "rejected" && selected.length !== 0) blockers.push("premise_movie_selection_rejected_has_selected_ids");
  if (new Set(selected).size !== selected.length) blockers.push("premise_movie_selection_selected_ids_duplicate");
  for (const id of selected) if (!blindIds.has(id)) blockers.push(`premise_movie_selection_selected_${id}_unknown`);
  const rankings = Array.isArray(document?.rankings) ? document.rankings : [];
  if (rankings.length !== blindIds.size) blockers.push("premise_movie_selection_ranking_count_mismatch");
  const rankedIds = rankings.map((row) => row?.blind_id);
  if (new Set(rankedIds).size !== rankedIds.length) blockers.push("premise_movie_selection_ranking_ids_duplicate");
  for (const [index, row] of rankings.entries()) {
    if (!blindIds.has(row?.blind_id)) blockers.push(`premise_movie_selection_ranking_${index}_unknown`);
    if (!Number.isInteger(row?.rank) || row.rank < 1 || row.rank > blindIds.size) blockers.push(`premise_movie_selection_ranking_${index}_rank_invalid`);
    for (const field of ["specificity", "emotional_clarity", "desirability", "power_fantasy", "agency", "second_question", "demand_transfer", "formulaic_risk", "decisive_reason"]) {
      if (!String(row?.[field] ?? "").trim()) blockers.push(`premise_movie_selection_ranking_${index}_${field}_missing`);
    }
  }
  if (!String(document?.selection_rationale ?? "").trim()) blockers.push("premise_movie_selection_rationale_missing");
  if (document?.status === "selected" && document?.rejection_reason !== null) blockers.push("premise_movie_selection_selected_rejection_reason_not_null");
  if (document?.status === "rejected" && !String(document?.rejection_reason ?? "").trim()) blockers.push("premise_movie_selection_rejection_reason_missing");
  return { done: blockers.length === 0, blockers };
}

function validatePremiseMoviePromotion(document, { discovery }) {
  const blockers = [];
  if (document?.schema !== "goldflow_premise_movie_operator_promotion_v1") blockers.push("premise_movie_promotion_schema_invalid");
  if (document?.status !== "promoted") blockers.push("premise_movie_promotion_status_invalid");
  if (document?.premise_movie_pool_sha256 !== discovery?.poolSha256) blockers.push("premise_movie_promotion_pool_hash_mismatch");
  if (document?.premise_movie_selection_sha256 !== discovery?.selectionSha256) blockers.push("premise_movie_promotion_selection_hash_mismatch");
  const selected = discovery?.selectedMovies?.find((row) => row.blind_id === document?.selected_blind_id);
  if (!selected) blockers.push("premise_movie_promotion_selected_id_unknown");
  if (selected && document?.selected_premise_movie_sha256 !== selected.premise_movie_sha256) blockers.push("premise_movie_promotion_movie_hash_mismatch");
  for (const field of ["promoted_by", "rationale", "canon_clarification", "promoted_at"]) {
    if (!String(document?.[field] ?? "").trim()) blockers.push(`premise_movie_promotion_${field}_missing`);
  }
  return { done: blockers.length === 0, blockers };
}

function providerFlags(provider, stageName = null) {
  const premiseEffort = flags["premise-reasoning-effort"];
  const treatmentEffort = flags["treatment-reasoning-effort"];
  const architectureEffort = flags["architecture-reasoning-effort"];
  const storyTruthEffort = flags["story-truth-reasoning-effort"];
  const premiseStage = /^winner_source_(?:ideate|premise|package_tournament)/.test(String(stageName ?? ""));
  const treatmentStage = /^winner_source_creative_treatment_/.test(String(stageName ?? ""));
  const architectureStage = String(stageName ?? "") === "winner_source_story_architecture_creative";
  const storyTruthStage = String(stageName ?? "") === "winner_source_story_truth_ir_v2";
  return {
    provider,
    ...(provider === "chatgpt_web" && premiseStage && premiseEffort
      ? { "reasoning-effort": premiseEffort }
      : {}),
    ...(provider === "chatgpt_web" && treatmentStage && treatmentEffort
      ? { "reasoning-effort": treatmentEffort }
      : {}),
    ...(provider === "chatgpt_web" && architectureStage && architectureEffort
      ? { "reasoning-effort": architectureEffort }
      : {}),
    ...(provider === "codex_cli" && storyTruthStage && storyTruthEffort
      ? { "reasoning-effort": storyTruthEffort }
      : {}),
  };
}

async function importedResponse({ sourcePath, outputPath, stageName, prompt, provider }) {
  const resolved = path.resolve(sourcePath);
  const content = await readText(resolved);
  await writeExclusive(outputPath, content);
  const metadata = {
    schema: "goldflow_external_model_response_v1",
    status: "passed",
    stage_name: stageName,
    provider: "external_response",
    transport: "fixture_response_import",
    prompt_sha256: sha256Text(prompt),
    output_sha256: sha256Text(content),
    response_source_path: resolved,
    response_source_sha256: await fileSha256(resolved),
    output_path: outputPath,
    intended_provider: provider,
    imported_at: new Date().toISOString(),
  };
  await writeJsonExclusive(`${outputPath}.meta.json`, metadata);
  return { content, metadata, imported: true };
}

async function resumeModelResponse({ outputPath, stageName, prompt, provider, expectedContract = null }) {
  const metadataPath = `${outputPath}.meta.json`;
  if (!await exists(outputPath) && !await exists(metadataPath)) return null;
  if (!await exists(outputPath) || !await exists(metadataPath)) {
    throw new Error(`Partial model artifact for ${stageName}; refusing to resubmit or overwrite.`);
  }
  const [content, metadata] = await Promise.all([readText(outputPath), readJson(metadataPath)]);
  const blockers = [];
  if (metadata?.status !== "passed") blockers.push("model_response_not_passed");
  if (metadata?.stage_name !== stageName) blockers.push("model_response_stage_mismatch");
  if (metadata?.prompt_sha256 !== sha256Text(prompt)) blockers.push("model_response_prompt_hash_mismatch");
  const recordedOutputHash = metadata?.output_sha256 ?? metadata?.normalized_output_sha256 ?? null;
  if (recordedOutputHash && recordedOutputHash !== sha256Text(content)) blockers.push("model_response_output_hash_mismatch");
  if (metadata?.provider !== "external_response") {
    const contract = expectedContract ?? sourceModelContract(providerFlags(provider, stageName), { stageName });
    blockers.push(...validateSourceModelReceipt(metadata, { expectedContract: contract }).blockers);
  }
  if (blockers.length) throw new Error(`Cannot resume ${stageName}: ${blockers.join(", ")}`);
  return { content, metadata, resumed: true };
}

async function modelResponse({
  id,
  prompt,
  stageName,
  provider,
  responsePath = null,
  directOutputPath = null,
  timeout = timeoutMs,
  expectedContract = null,
}) {
  const outputPath = directOutputPath ?? rawResponsePath(id);
  const resumed = await resumeModelResponse({ outputPath, stageName, prompt, provider, expectedContract });
  if (resumed) return resumed;
  if (responsePath) return importedResponse({ sourcePath: responsePath, outputPath, stageName, prompt, provider });

  const contract = expectedContract ?? sourceModelContract(providerFlags(provider, stageName), { stageName });
  const response = await runCodexCli({
    prompt,
    stageName,
    repoRoot,
    outputPath,
    provider: contract.provider,
    model: contract.model,
    reasoningEffort: contract.reasoning_effort,
    verbosity: flags.verbosity ?? "medium",
    timeoutMs: timeout,
  });
  assertValid(
    `${stageName} source model receipt`,
    validateSourceModelReceipt(response, { expectedContract: contract }),
  );
  return { content: response.content, metadata: response, resumed: false };
}

function parseModelJson(content, label) {
  try {
    return parseJsonObjectFromPlannerOutput(content).value;
  } catch (error) {
    throw new Error(`${label} did not return usable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function materializeModelJson({ fileName, validator, validatorOptions, call, normalizeDocument = null }) {
  const target = artifactPath(fileName);
  if (await exists(target)) {
    const document = await readJson(target);
    const validation = validator(document, validatorOptions);
    assertValid(fileName, validation);
    return { path: target, document, sha256: await fileSha256(target), validation, resumed: true };
  }
  const response = await call();
  const parsedDocument = parseModelJson(response.content, fileName);
  const document = normalizeDocument ? normalizeDocument(parsedDocument) : parsedDocument;
  const validation = validator(document, validatorOptions);
  assertValid(fileName, validation);
  if (response.imported || response.metadata?.provider === "external_response") {
    try {
      const exactDocument = JSON.parse(response.content);
      if (sha256CanonicalJson(exactDocument) === sha256CanonicalJson(document)) {
        await writeExclusive(target, response.content);
      } else {
        await writeJsonExclusive(target, document);
      }
    } catch {
      await writeJsonExclusive(target, document);
    }
  } else {
    await writeJsonExclusive(target, document);
  }
  return { path: target, document, sha256: await fileSha256(target), validation, resumed: false };
}

function selectedCandidate(slate, selection) {
  const candidate = slate.candidates.find((row) => row.id === selection.selected_candidate_id);
  if (!candidate) throw new Error(`Selected premise ${selection.selected_candidate_id} is absent.`);
  return candidate;
}

function selectedTreatment(bakeoff, selection) {
  const treatment = bakeoff.treatments.find((row) => row.id === selection.selected_treatment_id);
  if (!treatment) throw new Error(`Selected treatment ${selection.selected_treatment_id} is absent.`);
  return treatment;
}

async function loadEvidence() {
  const evidence = await validatedJson(FILES.evidence, validateSourceEvidenceRegistry);
  const receiptPath = artifactPath(FILES.evidenceReceipt);
  if (!await exists(receiptPath)) throw new Error(`Missing evidence registry receipt: ${receiptPath}`);
  const receipt = await readJson(receiptPath);
  const blockers = [];
  if (receipt?.schema !== "goldflow_source_evidence_registry_receipt_v1") blockers.push("evidence_receipt_schema_invalid");
  if (receipt?.status !== "passed") blockers.push("evidence_receipt_not_passed");
  if (receipt?.registry_sha256 !== evidence.sha256) blockers.push("evidence_receipt_registry_hash_mismatch");
  if (receipt?.channel !== channel) blockers.push("evidence_receipt_channel_mismatch");
  if (blockers.length) throw new Error(`Evidence registry receipt is blocked: ${blockers.join(", ")}`);
  let roomContract = null;
  const roomContractPath = artifactPath(FILES.roomContract);
  if (await exists(roomContractPath)) {
    roomContract = await readJson(roomContractPath);
    const blockers = [];
    if (roomContract?.schema !== "goldflow_source_room_contract_v1") blockers.push("source_room_contract_schema_invalid");
    if (![REFERENCE_DENSITY_ROOM_PROFILE_V1, REFERENCE_DENSITY_ROOM_PROFILE_V2, REFERENCE_DENSITY_ROOM_PROFILE_V3, FIRST_CLASS_STORY_ROOM_PROFILE_V4].includes(roomContract?.profile)) blockers.push("source_room_contract_profile_invalid");
    if (roomContract?.reference_density_required !== true) blockers.push("source_room_contract_frontier_not_required");
    if ([REFERENCE_DENSITY_ROOM_PROFILE_V2, REFERENCE_DENSITY_ROOM_PROFILE_V3, FIRST_CLASS_STORY_ROOM_PROFILE_V4].includes(roomContract?.profile) && roomContract?.material_reference_edges_required !== true) {
      blockers.push("source_room_contract_material_edges_not_required");
    }
    if ([REFERENCE_DENSITY_ROOM_PROFILE_V3, FIRST_CLASS_STORY_ROOM_PROFILE_V4].includes(roomContract?.profile) && roomContract?.viewer_tournament_required !== true) {
      blockers.push("source_room_contract_viewer_tournament_not_required");
    }
    if ([REFERENCE_DENSITY_ROOM_PROFILE_V3, FIRST_CLASS_STORY_ROOM_PROFILE_V4].includes(roomContract?.profile) && !String(roomContract?.viewer_panel_seed ?? "").trim()) {
      blockers.push("source_room_contract_viewer_panel_seed_missing");
    }
    if (roomContract?.profile === FIRST_CLASS_STORY_ROOM_PROFILE_V4) {
      for (const field of [
        "independent_premise_room_required",
        "story_truth_ir_required",
        "six_draft_portfolio_required",
        "narration_revision_required",
        "post_upload_learning_required",
      ]) {
        if (roomContract?.[field] !== true) blockers.push(`source_room_contract_${field}_missing`);
      }
      if (!String(roomContract?.draft_blind_seed ?? "").trim()) blockers.push("source_room_contract_draft_blind_seed_missing");
      if (roomContract?.source_quality_gates_version === "aug_2026_v1") {
        if (roomContract?.opening_audio_audition_required !== true) blockers.push("source_room_contract_opening_audio_audition_not_required");
        if (roomContract?.mixed_viewer_panel_required !== true) blockers.push("source_room_contract_mixed_viewer_panel_not_required");
        if (!String(roomContract?.mixed_viewer_panel_seed ?? "").trim()) blockers.push("source_room_contract_mixed_viewer_panel_seed_missing");
      }
      if (roomContract?.source_learning_ledger_path || roomContract?.source_learning_ledger_sha256) {
        const learningPath = path.resolve(String(roomContract.source_learning_ledger_path ?? ""));
        const learningDocument = await readJson(learningPath).catch(() => null);
        const learningSha256 = await fileSha256(learningPath).catch(() => null);
        if (learningDocument?.schema !== "goldflow_source_learning_ledger_v1" || learningDocument?.status !== "observational") blockers.push("source_room_contract_learning_ledger_invalid");
        if (learningSha256 !== roomContract.source_learning_ledger_sha256) blockers.push("source_room_contract_learning_ledger_hash_mismatch");
      }
    }
    if (roomContract?.evidence_registry_sha256 !== evidence.sha256) blockers.push("source_room_contract_evidence_hash_mismatch");
    if (blockers.length) throw new Error(`Source room contract is blocked: ${blockers.join(", ")}`);
  }
  return { ...evidence, receiptPath, receipt, receiptSha256: await fileSha256(receiptPath), roomContract, roomContractPath };
}

async function loadPackageOutliers({ requireCommentLanguage = null } = {}) {
  const roomContractPath = artifactPath(FILES.roomContract);
  const roomContract = await exists(roomContractPath) ? await readJson(roomContractPath) : null;
  const requireComments = requireCommentLanguage ?? roomContract?.profile === FIRST_CLASS_STORY_ROOM_PROFILE_V4;
  const ledger = await validatedJson(FILES.packageOutliers, validatePackageOutlierLedger, {
    requireCommentLanguage: requireComments,
  });
  const receiptPath = artifactPath(FILES.packageOutliersReceipt);
  if (!await exists(receiptPath)) throw new Error(`Missing package outlier ledger receipt: ${receiptPath}`);
  const receipt = await readJson(receiptPath);
  const blockers = [];
  if (receipt?.schema !== "goldflow_package_outlier_ledger_receipt_v1") blockers.push("package_outlier_receipt_schema_invalid");
  if (receipt?.status !== "passed") blockers.push("package_outlier_receipt_not_passed");
  if (receipt?.ledger_sha256 !== ledger.sha256) blockers.push("package_outlier_receipt_hash_mismatch");
  if (receipt?.channel !== channel) blockers.push("package_outlier_receipt_channel_mismatch");
  if (blockers.length) throw new Error(`Package outlier ledger receipt is blocked: ${blockers.join(", ")}`);
  return { ...ledger, receiptPath, receipt, receiptSha256: await fileSha256(receiptPath) };
}

async function loadPremiseMovieDiscoveryIfPresent(evidence) {
  const poolPath = artifactPath(FILES.premiseMoviePool);
  const selectionPath = artifactPath(FILES.premiseMovieSelection);
  const poolExists = await exists(poolPath);
  const selectionExists = await exists(selectionPath);
  if (!poolExists && !selectionExists) return null;
  if (!poolExists || !selectionExists) {
    throw new Error("Premise movie discovery is partial; both pool and selection artifacts are required.");
  }
  const poolDocument = await readJson(poolPath);
  const selectionDocument = await readJson(selectionPath);
  const poolSha256 = await fileSha256(poolPath);
  const blindIds = new Set((poolDocument.candidates ?? []).map((row) => row.blind_id));
  assertValid("premise movie selection", validatePremiseMovieSelection(selectionDocument, {
    poolSha256,
    evidenceSha256: evidence.sha256,
    blindIds,
  }));
  const selectedMovies = selectionDocument.selected_blind_ids.map((blindId) => {
    const row = poolDocument.candidates.find((candidate) => candidate.blind_id === blindId);
    if (!row) throw new Error(`Selected premise movie ${blindId} is missing from the pool.`);
    return {
      blind_id: blindId,
      premise_movie_sha256: row.candidate_sha256,
      ...row.candidate,
    };
  });
  return {
    poolPath,
    poolSha256,
    poolDocument,
    selectionPath,
    selectionSha256: await fileSha256(selectionPath),
    selectionDocument,
    selectedMovies,
    bindings: new Map(selectedMovies.map((row) => [row.blind_id, row.premise_movie_sha256])),
  };
}

async function loadPremiseMoviePromotionIfPresent(discovery) {
  if (!discovery) return null;
  const promotionPath = artifactPath(FILES.premiseMoviePromotion);
  if (!await exists(promotionPath)) return null;
  const document = await readJson(promotionPath);
  assertValid("premise movie operator promotion", validatePremiseMoviePromotion(document, { discovery }));
  return { path: promotionPath, sha256: await fileSha256(promotionPath), document };
}

async function loadPremiseRoom() {
  const evidence = await loadEvidence();
  const premiseMovieDiscovery = await loadPremiseMovieDiscoveryIfPresent(evidence);
  const premiseMoviePromotion = await loadPremiseMoviePromotionIfPresent(premiseMovieDiscovery);
  const hasOutlierLedger = await exists(artifactPath(FILES.packageOutliers));
  const packageOutliers = hasOutlierLedger ? await loadPackageOutliers({
    requireCommentLanguage: evidence.roomContract?.profile === FIRST_CLASS_STORY_ROOM_PROFILE_V4,
  }) : null;
  const slate = await validatedJson(FILES.premiseSlate, validatePremiseSlateV2, {
    evidenceRegistry: evidence.document,
    evidenceRegistrySha256: evidence.sha256,
    packageOutlierLedger: packageOutliers?.document ?? null,
    premiseMovieBindings: premiseMovieDiscovery?.bindings ?? null,
  });
  const selection = await validatedJson(FILES.premiseSelection, validatePremiseSelectionV2, {
    premiseSlate: slate.document,
    premiseSlateSha256: slate.sha256,
    evidenceRegistry: evidence.document,
    evidenceRegistrySha256: evidence.sha256,
  });
  if (selection.document.status !== "selected") throw new Error("Premise selector rejected the slate.");
  let tournamentConsensus = null;
  let packageAdjudication = null;
  let selectedCandidateId = selection.document.selected_candidate_id;
  if (packageOutliers) {
    const gptTournament = await validatedJson(FILES.packageTournamentGpt, validatePackageTournament, {
      premiseSlate: slate.document,
      premiseSlateSha256: slate.sha256,
    });
    const geminiTournament = await validatedJson(FILES.packageTournamentGemini, validatePackageTournament, {
      premiseSlate: slate.document,
      premiseSlateSha256: slate.sha256,
    });
    tournamentConsensus = await validatedJson(FILES.packageTournamentConsensus, validatePackageTournamentConsensus, {
      premiseSlateSha256: slate.sha256,
      gptTournament: gptTournament.document,
      gptTournamentSha256: gptTournament.sha256,
      geminiTournament: geminiTournament.document,
      geminiTournamentSha256: geminiTournament.sha256,
    });
    if (tournamentConsensus.document.status === "consensus") {
      selectedCandidateId = tournamentConsensus.document.selected_candidate_id;
    } else {
      packageAdjudication = await validatedJson(FILES.packageAdjudication, validatePackageAdjudication, {
        premiseSlate: slate.document,
        premiseSlateSha256: slate.sha256,
        tournamentConsensus: tournamentConsensus.document,
        tournamentConsensusSha256: tournamentConsensus.sha256,
        gptTournamentSha256: gptTournament.sha256,
        geminiTournamentSha256: geminiTournament.sha256,
      });
      selectedCandidateId = packageAdjudication.document.selected_candidate_id;
    }
  }
  const baseCandidate = slate.document.candidates.find((row) => row.id === selectedCandidateId);
  if (!baseCandidate) throw new Error(`Selected premise ${selectedCandidateId} is absent.`);
  if (premiseMoviePromotion && baseCandidate?.source_premise_movie?.blind_id !== premiseMoviePromotion.document.selected_blind_id) {
    throw new Error("Selected package does not preserve the operator-promoted raw premise movie.");
  }
  const basePackageSha256 = sha256CanonicalJson(baseCandidate);
  let packageOperatorRevision = null;
  let candidate = baseCandidate;
  const revisionPath = artifactPath(FILES.packageOperatorRevision);
  if (await exists(revisionPath)) {
    const document = await readJson(revisionPath);
    const blockers = [];
    if (document?.schema !== "goldflow_package_operator_revision_v1") blockers.push("package_operator_revision_schema_invalid");
    if (document?.status !== "revised") blockers.push("package_operator_revision_status_invalid");
    if (document?.base_package_sha256 !== basePackageSha256) blockers.push("package_operator_revision_base_hash_mismatch");
    if (document?.selected_candidate_id !== baseCandidate.id) blockers.push("package_operator_revision_candidate_mismatch");
    if (document?.field !== "thumbnail_receipt") blockers.push("package_operator_revision_field_invalid");
    for (const field of ["thumbnail_receipt", "revised_by", "rationale", "revised_at"]) {
      if (!String(document?.[field] ?? "").trim()) blockers.push(`package_operator_revision_${field}_missing`);
    }
    if (blockers.length) throw new Error(`package_operator_revision.json is blocked: ${blockers.join(", ")}`);
    packageOperatorRevision = { path: revisionPath, sha256: await fileSha256(revisionPath), document };
    candidate = {
      ...baseCandidate,
      thumbnail_receipt: document.thumbnail_receipt,
      operator_package_revision: {
        revision_sha256: packageOperatorRevision.sha256,
        base_package_sha256: basePackageSha256,
        revised_by: document.revised_by,
        rationale: document.rationale,
      },
    };
  }
  const packageSha256 = sha256CanonicalJson(candidate);
  return {
    evidence, premiseMovieDiscovery, premiseMoviePromotion, packageOutliers, slate, selection,
    tournamentConsensus, packageAdjudication, packageOperatorRevision, baseCandidate,
    basePackageSha256, candidate, packageSha256,
  };
}

async function loadApprovedPackage() {
  const room = await loadPremiseRoom();
  const approval = await validatedJson(FILES.packageApproval, validateSourceStageApproval, {
    stageId: "package_selection",
    sourceSha256: room.packageSha256,
    selectedId: room.candidate.id,
  });
  return { ...room, approval };
}

async function frontierRequiredForRoom(room) {
  return room.evidence?.roomContract?.reference_density_required === true
    || await exists(artifactPath(FILES.referenceMeritFrontier));
}

function materialReferenceEdgesRequiredForRoom(room) {
  return [REFERENCE_DENSITY_ROOM_PROFILE_V2, REFERENCE_DENSITY_ROOM_PROFILE_V3, FIRST_CLASS_STORY_ROOM_PROFILE_V4].includes(room.evidence?.roomContract?.profile)
    && room.evidence?.roomContract?.material_reference_edges_required === true;
}

function viewerTournamentRequiredForRoom(room) {
  return [REFERENCE_DENSITY_ROOM_PROFILE_V3, FIRST_CLASS_STORY_ROOM_PROFILE_V4].includes(room.evidence?.roomContract?.profile)
    && room.evidence?.roomContract?.viewer_tournament_required === true;
}

function firstClassStoryRoom(room) {
  return room.evidence?.roomContract?.profile === FIRST_CLASS_STORY_ROOM_PROFILE_V4;
}

function augustSourceQualityGatesRequired(room) {
  return firstClassStoryRoom(room)
    && room.evidence?.roomContract?.source_quality_gates_version === "aug_2026_v1";
}

function selectedOutlierContract(room, requestedSourceId = null) {
  const mirror = room.candidate?.outlier_mirror;
  const sourceId = String(requestedSourceId ?? mirror?.source_id ?? "").trim();
  const sourceTitle = String(requestedSourceId ? "" : mirror?.source_title ?? "").trim();
  if (!sourceId || !sourceTitle) {
    if (!sourceId) throw new Error("The selected package has no default outlier_mirror source_id; pass --reference-entry-id <ledger-entry-id>.");
  }
  const entry = room.packageOutliers?.document?.entries?.find((row) => row?.entry_id === sourceId) ?? null;
  if (!entry) throw new Error(`Selected outlier ${sourceId} is absent from package_outlier_ledger.json.`);
  if (sourceTitle && entry.title !== sourceTitle) throw new Error(`Selected outlier title drift for ${sourceId}.`);
  return { sourceId, sourceTitle: entry.title, entry };
}

async function loadReferenceMeritFrontier() {
  const room = await loadApprovedPackage();
  const transcriptPath = artifactPath(FILES.referenceTranscript);
  const receiptPath = artifactPath(FILES.referenceReceipt);
  if (!await exists(transcriptPath) || !await exists(receiptPath)) {
    throw new Error("Missing reference frontier input. Run source reference-frontier --reference <exact measured outlier transcript> before treatments.");
  }
  const [referenceText, receipt] = await Promise.all([readText(transcriptPath), readJson(receiptPath)]);
  const outlier = selectedOutlierContract(room, receipt?.source_outlier_id);
  const referenceSha256 = await fileSha256(transcriptPath);
  const receiptBlockers = [];
  if (receipt?.schema !== "goldflow_reference_outlier_receipt_v1") receiptBlockers.push("reference_receipt_schema_invalid");
  if (receipt?.status !== "passed") receiptBlockers.push("reference_receipt_not_passed");
  if (receipt?.package_sha256 !== room.packageSha256) receiptBlockers.push("reference_receipt_package_hash_mismatch");
  if (receipt?.source_outlier_id !== outlier.sourceId) receiptBlockers.push("reference_receipt_outlier_id_mismatch");
  if (receipt?.reference_title !== outlier.sourceTitle) receiptBlockers.push("reference_receipt_title_mismatch");
  if (receipt?.reference_sha256 !== referenceSha256) receiptBlockers.push("reference_receipt_hash_mismatch");
  if (receiptBlockers.length) throw new Error(`Reference receipt is blocked: ${receiptBlockers.join(", ")}`);
  const frontier = await validatedJson(FILES.referenceMeritFrontier, validateReferenceMeritFrontier, {
    packageSha256: room.packageSha256,
    referenceText,
    referenceSha256,
    referencePath: transcriptPath,
    referenceTitle: outlier.sourceTitle,
    requireMaterialEdges: materialReferenceEdgesRequiredForRoom(room),
  });
  return {
    ...room,
    outlier,
    referenceText,
    referencePath: transcriptPath,
    referenceSha256,
    referenceReceiptPath: receiptPath,
    referenceReceipt: receipt,
    referenceReceiptSha256: await fileSha256(receiptPath),
    referenceMeritFrontier: frontier,
  };
}

async function loadTreatmentRoom() {
  const approvedPackage = await loadApprovedPackage();
  const packageRoom = await frontierRequiredForRoom(approvedPackage)
    ? await loadReferenceMeritFrontier()
    : approvedPackage;
  const bakeoff = await validatedJson(FILES.treatmentBakeoff, validateTreatmentBakeoff, {
    packageSha256: packageRoom.packageSha256,
  });
  const selection = await validatedJson(FILES.treatmentSelection, validateTreatmentSelection, {
    packageSha256: packageRoom.packageSha256,
    treatmentBatch: bakeoff.document,
    treatmentBatchSha256: bakeoff.sha256,
  });
  if (selection.document.status !== "selected") throw new Error("Treatment selector rejected all treatments.");
  const treatment = selectedTreatment(bakeoff.document, selection.document);
  const treatmentSha256 = sha256CanonicalJson(treatment);
  return { ...packageRoom, bakeoff, treatmentSelection: selection, treatment, treatmentSha256 };
}

async function loadApprovedTreatment() {
  const room = await loadTreatmentRoom();
  const treatmentApproval = await validatedJson(FILES.treatmentApproval, validateSourceStageApproval, {
    stageId: "treatment_selection",
    sourceSha256: room.treatmentSha256,
    selectedId: room.treatment.id,
  });
  return { ...room, treatmentApproval };
}

async function loadArchitecture({ requireAudit = false, requireApproval = false } = {}) {
  const room = await loadApprovedTreatment();
  const nameFamiliarityPath = artifactPath(FILES.nameFamiliarity);
  const nameFamiliaritySha256 = await exists(nameFamiliarityPath) ? await fileSha256(nameFamiliarityPath) : null;
  const architecture = await validatedJson(FILES.architecture, validateStoryArchitecture, {
    packageSha256: room.packageSha256,
    selectedTreatmentSha256: room.treatmentSha256,
    treatmentBatchSha256: room.bakeoff.sha256,
    treatmentSelectionSha256: room.treatmentSelection.sha256,
    nameFamiliarityLedgerSha256: nameFamiliaritySha256,
    requireMeritDominanceContract: Boolean(room.referenceMeritFrontier),
    referenceMeritFrontierSha256: room.referenceMeritFrontier?.sha256 ?? null,
    referenceMeritFrontier: room.referenceMeritFrontier?.document ?? null,
  });
  const architectureText = await readText(architecture.path);
  let architectureRedteam = null;
  if (requireAudit || requireApproval) {
    architectureRedteam = await validatedJson(FILES.architectureRedteam, validateArchitectureRedteam, {
      architectureText,
      architectureSha256: architecture.sha256,
    });
    if (architectureRedteam.document.status !== "passed") {
      throw new Error(`Architecture red team has unresolved findings for ${architecture.sha256}.`);
    }
  }
  let architectureApproval = null;
  if (requireApproval) {
    architectureApproval = await validatedJson(FILES.architectureApproval, validateSourceStageApproval, {
      stageId: "story_architecture",
      sourceSha256: architecture.sha256,
      selectedId: null,
    });
  }
  return { ...room, architecture, architectureText, architectureRedteam, architectureApproval };
}

async function loadStoryTruth({ requireAudit = true } = {}) {
  const room = await loadArchitecture({ requireApproval: true });
  if (!firstClassStoryRoom(room)) return { ...room, storyTruthIr: null, storyTruthAudit: null };
  const storyTruthIr = await validatedJson(FILES.storyTruthIr, validateStoryTruthIr, {
    packageSha256: room.packageSha256,
    selectedTreatmentSha256: room.treatmentSha256,
    architectureSha256: room.architecture.sha256,
    architecture: room.architecture.document,
  });
  let storyTruthAudit = null;
  if (requireAudit) {
    storyTruthAudit = await validatedJson(FILES.storyTruthAudit, validateStoryTruthAudit, {
      storyTruthIrSha256: storyTruthIr.sha256,
    });
    if (storyTruthAudit.document.status !== "passed") throw new Error("Story Truth audit has unresolved material findings.");
  }
  return { ...room, storyTruthIr, storyTruthAudit };
}

async function loadWriterPacket() {
  const room = await loadStoryTruth({ requireAudit: true });
  const writerPacket = await validatedJson(FILES.writerPacket, validateStoryWriterPacket, {
    packageSha256: room.packageSha256,
    selectedTreatmentSha256: room.treatmentSha256,
    architectureSha256: room.architecture.sha256,
    architecture: room.architecture.document,
  });
  return { ...room, writerPacket };
}

async function loadDraftRoom() {
  const architectureRoom = await loadArchitecture({ requireApproval: true });
  if (firstClassStoryRoom(architectureRoom)) {
    const room = await loadWriterPacket();
    const portfolio = await validatedJson(FILES.draftPortfolio, validateLongformDraftPortfolio, {
      packageSha256: room.packageSha256,
      architectureSha256: room.architecture.sha256,
      storyTruthIrSha256: room.storyTruthIr.sha256,
      writerPacketSha256: room.writerPacket.sha256,
      expectedCandidates: SOURCE_DRAFT_CANDIDATE_SPECS,
    });
    const drafts = {};
    for (const candidate of portfolio.document.candidates) {
      const draftPath = path.resolve(candidate.output_path);
      if (!await exists(draftPath)) throw new Error(`Missing portfolio draft: ${draftPath}`);
      if (await fileSha256(draftPath) !== candidate.output_sha256) throw new Error(`Portfolio draft hash drift: ${candidate.id}`);
      const receiptPath = path.resolve(candidate.receipt_path);
      if (!await exists(receiptPath) || await fileSha256(receiptPath) !== candidate.receipt_sha256) throw new Error(`Portfolio receipt hash drift: ${candidate.id}`);
      const text = await readText(draftPath);
      const words = countWords(text);
      if (words !== candidate.word_count || words < 1) throw new Error(`Portfolio draft word-count drift: ${candidate.id}`);
      drafts[candidate.blind_id] = {
        path: draftPath,
        text,
        sha256: candidate.output_sha256,
        word_count: words,
        source_id: candidate.id,
      };
    }
    const selection = await validatedJson(FILES.draftSelection, validateLongformDraftSelection, {
      packageSha256: room.packageSha256,
      architectureSha256: room.architecture.sha256,
      expectedDrafts: drafts,
      requireOpeningVerdicts: true,
      requireRankings: true,
    });
    if (selection.document.status !== "selected") throw new Error("Longform selector rejected all six portfolio drafts.");
    if ((selection.document.approved_transplants ?? []).length) throw new Error("Longform selector proposed a transplant, but V4 requires byte-for-byte winner materialization.");
    const selected = drafts[selection.document.selected_draft_id];
    const initialPath = artifactPath(FILES.initialScript);
    if (!await exists(initialPath)) await writeExclusive(initialPath, await readBytes(selected.path));
    else if (await fileSha256(initialPath) !== selected.sha256) throw new Error("initial_selected_script.txt is stale for the selected portfolio draft.");
    return { ...room, drafts, draftPortfolio: portfolio, draftSelection: selection, selectedDraft: selected, initialPath };
  }
  const room = architectureRoom;
  const draftPaths = {
    draft_gpt_web: artifactPath(FILES.draftGpt),
    draft_gemini_web: artifactPath(FILES.draftGemini),
  };
  for (const draftPath of Object.values(draftPaths)) {
    if (!await exists(draftPath)) throw new Error(`Missing longform draft: ${draftPath}`);
  }
  const drafts = Object.fromEntries(await Promise.all(Object.entries(draftPaths).map(async ([id, draftPath]) => {
    const text = await readText(draftPath);
    const words = countWords(text);
    if (words < 1) throw new Error(`${id} is empty.`);
    return [id, { path: draftPath, text, sha256: await fileSha256(draftPath), word_count: words }];
  })));
  const selection = await validatedJson(FILES.draftSelection, validateLongformDraftSelection, {
    packageSha256: room.packageSha256,
    architectureSha256: room.architecture.sha256,
    expectedDrafts: drafts,
    requireOpeningVerdicts: hasDramaticColdOpenContract(room.architecture.document),
  });
  if (selection.document.status !== "selected") throw new Error("Longform selector rejected both drafts.");
  if ((selection.document.approved_transplants ?? []).length) {
    throw new Error("Longform selector proposed a transplant, but script-v2 requires byte-for-byte winner materialization.");
  }
  const selected = drafts[selection.document.selected_draft_id];
  const initialPath = artifactPath(FILES.initialScript);
  if (!await exists(initialPath)) await writeExclusive(initialPath, await readBytes(selected.path));
  else if (await fileSha256(initialPath) !== selected.sha256) throw new Error("initial_selected_script.txt is stale for the selected draft.");
  return { ...room, drafts, draftSelection: selection, selectedDraft: selected, initialPath };
}

async function loadDiagnostics() {
  const room = await loadDraftRoom();
  const scriptText = await readText(room.initialPath);
  const scriptSha256 = await fileSha256(room.initialPath);
  const causality = await validatedJson(FILES.causalityDiagnostic, validateSourceDiagnosticV2, { scriptText, scriptSha256 });
  const continuity = await validatedJson(FILES.continuityDiagnostic, validateSourceDiagnosticV2, { scriptText, scriptSha256 });
  const authenticity = await validatedJson(FILES.authenticityDiagnostic, validateSourceDiagnosticV2, { scriptText, scriptSha256 });
  const openingStress = firstClassStoryRoom(room)
    ? await validatedJson(FILES.openingStressDiagnostic, validateSourceDiagnosticV2, { scriptText, scriptSha256 })
    : null;
  const characterAgency = firstClassStoryRoom(room)
    ? await validatedJson(FILES.characterAgencyDiagnostic, validateSourceDiagnosticV2, { scriptText, scriptSha256 })
    : null;
  const antiSlop = firstClassStoryRoom(room)
    ? await validatedJson(FILES.antiSlopDiagnostic, validateSourceDiagnosticV2, { scriptText, scriptSha256 })
    : null;
  const referenceDensity = room.referenceMeritFrontier
    ? await validatedJson(FILES.referenceDensityDiagnostic, validateReferenceDensityDominance, {
      scriptText,
      scriptSha256,
      referenceText: room.referenceText,
      referenceSha256: room.referenceSha256,
      frontierSha256: room.referenceMeritFrontier.sha256,
      referenceMeritFrontier: room.referenceMeritFrontier.document,
    })
    : null;
  if (causality.document.diagnostic_id !== "causality_learning") throw new Error("Causality diagnostic has the wrong diagnostic_id.");
  if (continuity.document.diagnostic_id !== "promise_continuity") throw new Error("Continuity diagnostic has the wrong diagnostic_id.");
  if (authenticity.document.diagnostic_id !== "narrative_authenticity") throw new Error("Narrative authenticity diagnostic has the wrong diagnostic_id.");
  if (openingStress && openingStress.document.diagnostic_id !== "opening_stress") throw new Error("Opening stress diagnostic has the wrong diagnostic_id.");
  if (characterAgency && characterAgency.document.diagnostic_id !== "character_agency") throw new Error("Character agency diagnostic has the wrong diagnostic_id.");
  if (antiSlop && antiSlop.document.diagnostic_id !== "anti_slop") throw new Error("Anti-slop diagnostic has the wrong diagnostic_id.");
  return { ...room, scriptText, scriptSha256, causality, continuity, authenticity, openingStress, characterAgency, antiSlop, referenceDensity };
}

async function loadRevision() {
  const room = await loadDiagnostics();
  const revisedPath = artifactPath(FILES.revisedScript);
  if (!await exists(revisedPath)) throw new Error(`Missing revised script: ${revisedPath}`);
  const revisedText = await readText(revisedPath);
  const revisedSha256 = await fileSha256(revisedPath);
  const words = countWords(revisedText);
  if (words < 1) throw new Error("Revised script is empty.");
  const acceptedFindingIds = [
    ...room.causality.validation.accepted_findings,
    ...room.continuity.validation.accepted_findings,
    ...room.authenticity.validation.accepted_findings,
    ...(room.openingStress?.validation.accepted_findings ?? []),
    ...(room.characterAgency?.validation.accepted_findings ?? []),
    ...(room.antiSlop?.validation.accepted_findings ?? []),
    ...(room.referenceDensity?.validation.accepted_findings ?? []),
  ].map((finding) => finding.id);
  const revisionLedger = await validatedJson(FILES.revisionLedger, validateSourceRevisionLedger, {
    sourceScriptSha256: room.scriptSha256,
    revisedScriptSha256: revisedSha256,
    acceptedFindingIds,
  });
  return { ...room, revisedPath, revisedText, revisedSha256, revisionLedger, acceptedFindingIds };
}

async function loadFinalScriptRoom() {
  const room = await loadRevision();
  if (!firstClassStoryRoom(room)) return room;
  const polishedPath = artifactPath(FILES.narrationPolishedScript);
  if (!await exists(polishedPath)) throw new Error(`Missing narration-polished script: ${polishedPath}`);
  const polishedText = await readText(polishedPath);
  const polishedSha256 = await fileSha256(polishedPath);
  const polishedWordCount = countWords(polishedText);
  const sourceWordCount = countWords(room.revisedText);
  const narrationRevisionLedger = await validatedJson(FILES.narrationRevisionLedger, validateNarrationRevisionLedger, {
    sourceScriptSha256: room.revisedSha256,
    polishedScriptSha256: polishedSha256,
    storyTruthIrSha256: room.storyTruthIr.sha256,
    sourceWordCount,
    polishedWordCount,
  });
  return {
    ...room,
    developmentalRevisedPath: room.revisedPath,
    developmentalRevisedText: room.revisedText,
    developmentalRevisedSha256: room.revisedSha256,
    revisedPath: polishedPath,
    revisedText: polishedText,
    revisedSha256: polishedSha256,
    narrationRevisionLedger,
  };
}

async function loadMappedFinalScriptRoom() {
  const room = await loadFinalScriptRoom();
  if (!firstClassStoryRoom(room)) return room;
  const storyTruthScriptMap = await validatedJson(FILES.storyTruthScriptMap, validateStoryTruthScriptMap, {
    storyTruthIr: room.storyTruthIr.document,
    storyTruthIrSha256: room.storyTruthIr.sha256,
    scriptText: room.revisedText,
    scriptSha256: room.revisedSha256,
  });
  return { ...room, storyTruthScriptMap };
}

async function loadViewerTournamentAcceptance(room) {
  const acceptancePath = artifactPath(FILES.viewerTournamentAcceptance);
  const viewerDirectory = artifactPath(FILES.viewerTournamentDirectory);
  const manifestPath = path.join(viewerDirectory, "manifest.json");
  if (!await exists(acceptancePath)) throw new Error(`Missing final viewer-tournament acceptance: ${acceptancePath}`);
  if (!await exists(manifestPath)) throw new Error(`Missing final viewer-tournament manifest: ${manifestPath}`);
  const [acceptance, manifestBytes] = await Promise.all([readJson(acceptancePath), readBytes(manifestPath)]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (path.resolve(String(acceptance.candidate_path ?? "")) !== path.resolve(room.revisedPath)) {
    throw new Error("Viewer-tournament acceptance candidate path does not match script_revised.txt.");
  }
  if (path.resolve(String(acceptance.reference_path ?? "")) !== path.resolve(room.referencePath)) {
    throw new Error("Viewer-tournament acceptance reference path does not match the bound reference.");
  }
  if (path.resolve(String(acceptance.viewer_manifest_path ?? "")) !== path.resolve(manifestPath)) {
    throw new Error("Viewer-tournament acceptance points to a different manifest.");
  }
  if (manifest.panel_seed !== room.evidence.roomContract.viewer_panel_seed) {
    throw new Error("Viewer-tournament manifest does not use the source room's precommitted panel seed.");
  }
  const expectedProfileIds = Array.isArray(manifest.panel_profile_ids) ? manifest.panel_profile_ids : [];
  const reports = [];
  const reportSha256s = {};
  for (const personaId of expectedProfileIds) {
    const reportPath = path.join(viewerDirectory, `${personaId}.json`);
    const bytes = await readBytes(reportPath).catch(() => null);
    if (!bytes) throw new Error(`Missing viewer report for ${personaId}: ${reportPath}`);
    const report = JSON.parse(bytes.toString("utf8"));
    if (report?.persona_id !== personaId) throw new Error(`Viewer report identity mismatch for ${personaId}.`);
    reports.push(report);
    reportSha256s[personaId] = sha256(bytes);
  }
  const validation = validateViewerTournamentAcceptance(acceptance, {
    candidateSha256: room.revisedSha256,
    referenceSha256: room.referenceSha256,
    candidateText: room.revisedText,
    referenceText: room.referenceText,
    manifest,
    manifestFileSha256: sha256(manifestBytes),
    reports,
    reportSha256s,
    requireAccepted: true,
  });
  assertValid(FILES.viewerTournamentAcceptance, validation);
  return {
    path: acceptancePath,
    document: acceptance,
    sha256: await fileSha256(acceptancePath),
    manifestPath,
    manifestSha256: await fileSha256(manifestPath),
    reportSha256s,
  };
}

async function loadOpeningAudioAuditionGate(room) {
  const directory = artifactPath(FILES.openingAudioAuditionDirectory);
  const manifestPath = path.join(directory, "opening_audio_audition_manifest.json");
  const reviewPath = path.join(directory, "opening_audio_audition_review.json");
  const [manifestBytes, reviewBytes] = await Promise.all([
    readBytes(manifestPath).catch(() => null),
    readBytes(reviewPath).catch(() => null),
  ]);
  if (!manifestBytes || !reviewBytes) {
    throw new Error(`August source quality gate requires opening audition manifest and blind review in ${directory}.`);
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const review = JSON.parse(reviewBytes.toString("utf8"));
  assertValid("opening audio audition manifest", validateOpeningAudioAuditionManifest(manifest, {
    draftSelectionSha256: room.draftSelection.sha256,
    requireProductionGate: true,
  }));
  assertValid("opening audio audition review", validateOpeningAudioAuditionReview(review, {
    manifestSha256: sha256(manifestBytes),
    allowedLabels: manifest.finalists.map((row) => row.blind_label).sort(),
    requireProductionGate: true,
  }));
  return {
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    reviewPath,
    reviewSha256: sha256(reviewBytes),
  };
}

async function loadMixedViewerPanelGate(room) {
  const directory = artifactPath(FILES.mixedViewerPanelDirectory);
  const manifestPath = path.join(directory, "manifest.json");
  const aggregatePath = path.join(directory, "aggregate.json");
  const calibrationPolicyPath = path.join(directory, "calibration_policy.json");
  const [manifestBytes, aggregateBytes, calibrationBytes] = await Promise.all([
    readBytes(manifestPath).catch(() => null),
    readBytes(aggregatePath).catch(() => null),
    readBytes(calibrationPolicyPath).catch(() => null),
  ]);
  if (!manifestBytes || !aggregateBytes || !calibrationBytes) {
    throw new Error(`August source quality gate requires mixed-viewer manifest, aggregate, and calibration policy in ${directory}.`);
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const aggregate = JSON.parse(aggregateBytes.toString("utf8"));
  const calibrationPolicy = JSON.parse(calibrationBytes.toString("utf8"));
  const calibrationSha256 = sha256(calibrationBytes);
  assertValid("mixed viewer calibration policy", validateMixedViewerCalibrationPolicy(calibrationPolicy, {
    learningLedgerSha256: room.evidence.roomContract?.source_learning_ledger_sha256 ?? null,
  }));
  assertValid("mixed viewer panel manifest", validateMixedViewerShadowManifest(manifest, {
    requireProductionGate: true,
    calibrationPolicySha256: calibrationSha256,
  }));
  if (manifest.panel_seed !== room.evidence.roomContract.mixed_viewer_panel_seed) throw new Error("Mixed-viewer panel seed does not match the source-room contract.");
  if (manifest.candidate_sha256 !== room.revisedSha256 || manifest.reference_sha256 !== room.referenceSha256) throw new Error("Mixed-viewer panel script lineage does not match the final candidate and measured reference.");
  if (manifest.aggregate_sha256 !== sha256(aggregateBytes) || path.resolve(manifest.aggregate_path) !== path.resolve(aggregatePath)) throw new Error("Mixed-viewer manifest aggregate binding is stale.");
  const reports = [];
  const reportSha256s = {};
  for (const receipt of manifest.receipts ?? []) {
    const reportBytes = await readBytes(path.resolve(receipt.report_path));
    const report = JSON.parse(reportBytes.toString("utf8"));
    assertValid(`mixed viewer report ${receipt.persona_id}`, validateMixedViewerShadowReport(report, {
      candidateText: room.revisedText,
      referenceText: room.referenceText,
    }));
    if (sha256(reportBytes) !== receipt.report_sha256) throw new Error(`Mixed-viewer report hash mismatch for ${receipt.persona_id}.`);
    reports.push(report);
    reportSha256s[receipt.persona_id] = receipt.report_sha256;
  }
  const recomputed = aggregateMixedViewerShadow(reports, {
    candidateSha256: room.revisedSha256,
    referenceSha256: room.referenceSha256,
    mode: manifest.mode,
  });
  if (sha256CanonicalJson(recomputed) !== sha256CanonicalJson(aggregate)) throw new Error("Mixed-viewer aggregate does not match its ten bound reports.");
  if (calibrationPolicy.status === "active" && recomputed.calibrated_decision !== "accept") {
    throw new Error(`Calibrated mixed-viewer decision is ${recomputed.calibrated_decision}; source release requires operator triage.`);
  }
  return {
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    aggregatePath,
    aggregateSha256: sha256(aggregateBytes),
    calibrationPolicyPath,
    calibrationPolicySha256: calibrationSha256,
    reportSha256s,
    mode: manifest.mode,
  };
}

async function evidenceRegistry() {
  const registrySource = path.resolve(required(flags.registry, "--registry <path>"));
  const sourceBytes = await readBytes(registrySource);
  const sourceDocument = JSON.parse(sourceBytes.toString("utf8"));
  assertValid("source evidence registry", validateSourceEvidenceRegistry(sourceDocument));
  if (sourceDocument.channel !== channel) throw new Error(`Registry channel ${sourceDocument.channel} does not match ${channel}.`);
  const outputPath = artifactPath(FILES.evidence);
  if (await exists(outputPath)) {
    const current = await readJson(outputPath);
    assertValid("existing source evidence registry", validateSourceEvidenceRegistry(current));
    if (sha256CanonicalJson(current) !== sha256CanonicalJson(sourceDocument)) {
      throw new Error("A different passed evidence registry already exists; refusing overwrite.");
    }
  } else {
    await writeJsonExclusive(outputPath, sourceDocument);
  }
  const outputSha256 = await fileSha256(outputPath);
  const receiptPath = artifactPath(FILES.evidenceReceipt);
  const receipt = {
    schema: "goldflow_source_evidence_registry_receipt_v1",
    status: "passed",
    channel,
    development_slug: developmentSlug || path.basename(developmentDirectory()),
    source_path: registrySource,
    source_sha256: sha256(sourceBytes),
    registry_path: outputPath,
    registry_sha256: outputSha256,
    imported_at: new Date().toISOString(),
  };
  if (!await exists(receiptPath)) await writeJsonExclusive(receiptPath, receipt);
  else if ((await readJson(receiptPath)).registry_sha256 !== outputSha256) throw new Error("Evidence receipt is stale.");
  const roomContractPath = artifactPath(FILES.roomContract);
  const requestedLearningPath = flags["learning-ledger"]
    ? path.resolve(flags["learning-ledger"])
    : path.join(dataRoot, "channels", channel, "analytics", "source_learning_ledger.json");
  const learningLedgerExists = await exists(requestedLearningPath);
  if (flags["learning-ledger"] && !learningLedgerExists) throw new Error(`Missing requested source learning ledger: ${requestedLearningPath}`);
  let learningLedgerSha256 = null;
  if (learningLedgerExists) {
    const learningLedger = await readJson(requestedLearningPath);
    if (learningLedger?.schema !== "goldflow_source_learning_ledger_v1" || learningLedger?.status !== "observational") {
      throw new Error(`Invalid source learning ledger: ${requestedLearningPath}`);
    }
    learningLedgerSha256 = await fileSha256(requestedLearningPath);
  }
  const roomContract = {
    schema: "goldflow_source_room_contract_v1",
    profile: FIRST_CLASS_STORY_ROOM_PROFILE_V4,
    reference_density_required: true,
    material_reference_edges_required: true,
    viewer_tournament_required: true,
    independent_premise_room_required: true,
    story_truth_ir_required: true,
    six_draft_portfolio_required: true,
    narration_revision_required: true,
    post_upload_learning_required: true,
    source_quality_gates_version: "aug_2026_v1",
    opening_audio_audition_required: true,
    mixed_viewer_panel_required: true,
    viewer_panel_seed: sha256Text(`${channel}\0${developmentSlug || path.basename(developmentDirectory())}\0source-viewer-panel-v4`),
    mixed_viewer_panel_seed: sha256Text(`${channel}\0${developmentSlug || path.basename(developmentDirectory())}\0source-mixed-viewer-panel-aug-2026-v1`),
    draft_blind_seed: sha256Text(`${channel}\0${developmentSlug || path.basename(developmentDirectory())}\0source-draft-blind-v1`),
    source_learning_ledger_path: learningLedgerExists ? requestedLearningPath : null,
    source_learning_ledger_sha256: learningLedgerSha256,
    evidence_registry_sha256: outputSha256,
    created_at: new Date().toISOString(),
  };
  if (!await exists(roomContractPath)) await writeJsonExclusive(roomContractPath, roomContract);
  else {
    const existing = await readJson(roomContractPath);
    const recognizedLegacy = existing?.profile === REFERENCE_DENSITY_ROOM_PROFILE_V1
      && existing?.reference_density_required === true
      && existing?.evidence_registry_sha256 === outputSha256;
    const recognizedEdgeComplete = existing?.profile === REFERENCE_DENSITY_ROOM_PROFILE_V2
      && existing?.reference_density_required === true
      && existing?.material_reference_edges_required === true
      && existing?.evidence_registry_sha256 === outputSha256;
    const recognizedTournament = existing?.profile === REFERENCE_DENSITY_ROOM_PROFILE_V3
      && existing?.reference_density_required === true
      && existing?.material_reference_edges_required === true
      && existing?.viewer_tournament_required === true
      && existing?.evidence_registry_sha256 === outputSha256;
    const recognizedV4BeforeAugustGates = existing?.profile === FIRST_CLASS_STORY_ROOM_PROFILE_V4
      && existing?.source_quality_gates_version == null
      && existing?.reference_density_required === true
      && existing?.material_reference_edges_required === true
      && existing?.viewer_tournament_required === true
      && existing?.evidence_registry_sha256 === outputSha256;
    const matchesCurrent = existing?.profile === roomContract.profile
      && existing?.reference_density_required === true
      && existing?.material_reference_edges_required === true
      && existing?.viewer_tournament_required === true
      && existing?.viewer_panel_seed === roomContract.viewer_panel_seed
      && existing?.draft_blind_seed === roomContract.draft_blind_seed
      && existing?.independent_premise_room_required === true
      && existing?.story_truth_ir_required === true
      && existing?.six_draft_portfolio_required === true
      && existing?.narration_revision_required === true
      && existing?.post_upload_learning_required === true
      && existing?.source_quality_gates_version === roomContract.source_quality_gates_version
      && existing?.opening_audio_audition_required === true
      && existing?.mixed_viewer_panel_required === true
      && existing?.mixed_viewer_panel_seed === roomContract.mixed_viewer_panel_seed
      && (existing?.source_learning_ledger_path ?? null) === roomContract.source_learning_ledger_path
      && (existing?.source_learning_ledger_sha256 ?? null) === roomContract.source_learning_ledger_sha256
      && existing?.evidence_registry_sha256 === outputSha256;
    if (!recognizedLegacy && !recognizedEdgeComplete && !recognizedTournament && !recognizedV4BeforeAugustGates && !matchesCurrent) {
      throw new Error("Existing source room contract does not match the reference-density frontier profile.");
    }
  }
  printResult({ status: "passed", registry_path: outputPath, registry_sha256: outputSha256, next_action: "package-outliers" });
}

async function packageOutliers() {
  const evidence = await loadEvidence();
  const sourcePath = path.resolve(required(flags.ledger, "--ledger <path>"));
  const sourceBytes = await readBytes(sourcePath);
  const sourceDocument = JSON.parse(sourceBytes.toString("utf8"));
  const requireCommentLanguage = evidence.roomContract?.profile === FIRST_CLASS_STORY_ROOM_PROFILE_V4;
  assertValid("package outlier ledger", validatePackageOutlierLedger(sourceDocument, { requireCommentLanguage }));
  if (sourceDocument.channel !== channel) throw new Error(`Outlier ledger channel ${sourceDocument.channel} does not match ${channel}.`);
  const outputPath = artifactPath(FILES.packageOutliers);
  if (await exists(outputPath)) {
    const current = await readJson(outputPath);
    assertValid("existing package outlier ledger", validatePackageOutlierLedger(current, { requireCommentLanguage }));
    if (sha256CanonicalJson(current) !== sha256CanonicalJson(sourceDocument)) {
      throw new Error("A different passed package outlier ledger already exists; refusing overwrite.");
    }
  } else {
    await writeJsonExclusive(outputPath, sourceDocument);
  }
  const outputSha256 = await fileSha256(outputPath);
  const receiptPath = artifactPath(FILES.packageOutliersReceipt);
  const receipt = {
    schema: "goldflow_package_outlier_ledger_receipt_v1",
    status: "passed",
    channel,
    development_slug: developmentSlug || path.basename(developmentDirectory()),
    source_path: sourcePath,
    source_sha256: sha256(sourceBytes),
    ledger_path: outputPath,
    ledger_sha256: outputSha256,
    imported_at: new Date().toISOString(),
  };
  if (!await exists(receiptPath)) await writeJsonExclusive(receiptPath, receipt);
  else if ((await readJson(receiptPath)).ledger_sha256 !== outputSha256) throw new Error("Package outlier receipt is stale.");
  printResult({ status: "passed", ledger_path: outputPath, ledger_sha256: outputSha256, next_action: "premise-discover" });
}

async function premiseDiscover() {
  const evidence = await loadEvidence();
  const packageOutlierLedger = await loadPackageOutliers();
  const evidenceProjection = premiseEvidenceProjection(evidence);
  const outlierProjection = premiseOutlierProjection(packageOutlierLedger);
  const internalPremiseExclusions = await internalPremiseExclusionProjection();
  const outlierIds = new Set(outlierProjection.entries.map((entry) => entry.entry_id));
  const discoveryTemplate = await promptTemplate(PROMPTS.premiseMovieDiscovery);
  const basePrompt = discoveryTemplate.text
    .replaceAll("EVIDENCE_SHA256", evidence.sha256)
    .replaceAll("OUTLIER_SHA256", packageOutlierLedger.sha256)
    + embedded("BINDING EVIDENCE REGISTRY PROJECTION JSON", evidenceProjection)
    + embedded("BINDING PACKAGE OUTLIER LEDGER PROJECTION JSON", outlierProjection)
    + embedded("INTERNAL PRODUCED PREMISE EXCLUSION LEDGER", internalPremiseExclusions)
    + "\n\nAny movie materially equivalent to an internal produced premise is a noun-swap failure and must not be returned.";
  const discover = ({ fileName, id, role, responsePath }) => materializeModelJson({
    fileName,
    validator: validatePremiseMovieSlate,
    validatorOptions: {
      evidenceSha256: evidence.sha256,
      outlierSha256: packageOutlierLedger.sha256,
      outlierIds,
    },
    call: () => modelResponse({
      id,
      prompt: `${basePrompt}\n\nDISCOVERY ROLE: ${role}. Work independently. Do not infer or imitate another discovery slate.`,
      stageName: `winner_source_premise_discovery_${role}`,
      provider: "chatgpt_web",
      responsePath,
    }),
  });
  const [slateA, slateB] = await Promise.all([
    discover({
      fileName: FILES.premiseMovieSlateA,
      id: "premise_movie_slate_a",
      role: "manhwa_power_fantasy_scout_a",
      responsePath: flags["movie-a-response-path"],
    }),
    discover({
      fileName: FILES.premiseMovieSlateB,
      id: "premise_movie_slate_b",
      role: "betrayal_fantasy_scout_b",
      responsePath: flags["movie-b-response-path"],
    }),
  ]);
  const blindSeed = evidence.roomContract?.draft_blind_seed ?? sha256Text(`${evidence.sha256}\0${packageOutlierLedger.sha256}`);
  const poolRows = [
    ...slateA.document.candidates.map((candidate) => ({ author_slot: "a", candidate })),
    ...slateB.document.candidates.map((candidate) => ({ author_slot: "b", candidate })),
  ].map((row) => ({
    ...row,
    source_id: `${row.author_slot}:${row.candidate.id}`,
    candidate_sha256: sha256CanonicalStoryJson(row.candidate),
  })).sort((left, right) => sha256Text(`${blindSeed}\0${left.source_id}`)
    .localeCompare(sha256Text(`${blindSeed}\0${right.source_id}`)))
    .map((row, index) => ({ ...row, blind_id: `blind_movie_${String(index + 1).padStart(2, "0")}` }));
  const poolDocument = {
    schema: "goldflow_premise_movie_pool_v1",
    status: "pooled",
    evidence_registry_sha256: evidence.sha256,
    package_outlier_ledger_sha256: packageOutlierLedger.sha256,
    source_slate_sha256s: { a: slateA.sha256, b: slateB.sha256 },
    candidates: poolRows,
    created_at: new Date().toISOString(),
  };
  const poolPath = artifactPath(FILES.premiseMoviePool);
  if (!await exists(poolPath)) await writeJsonExclusive(poolPath, poolDocument);
  else if (sha256CanonicalJson(await readJson(poolPath)) !== sha256CanonicalJson(poolDocument)) {
    throw new Error("Existing premise movie pool differs from the sealed discovery slates.");
  }
  const poolSha256 = await fileSha256(poolPath);
  const selectorTemplate = await promptTemplate(PROMPTS.premiseMovieSelector);
  const blindedPool = poolRows.map((row) => ({ blind_id: row.blind_id, movie: row.candidate }));
  const selectorPrompt = selectorTemplate.text
    .replaceAll("POOL_SHA256", poolSha256)
    .replaceAll("EVIDENCE_SHA256", evidence.sha256)
    + embedded("BLINDED RAW PREMISE MOVIE POOL", blindedPool)
    + embedded("BINDING PACKAGE OUTLIER LEDGER PROJECTION JSON", outlierProjection)
    + embedded("INTERNAL PRODUCED PREMISE EXCLUSION LEDGER", internalPremiseExclusions)
    + "\n\nAuthor slots are intentionally hidden. Judge the underlying situations, not prose polish.";
  const blindIds = new Set(poolRows.map((row) => row.blind_id));
  const selection = await materializeModelJson({
    fileName: FILES.premiseMovieSelection,
    validator: validatePremiseMovieSelection,
    validatorOptions: { poolSha256, evidenceSha256: evidence.sha256, blindIds },
    call: () => modelResponse({
      id: "premise_movie_selection",
      prompt: selectorPrompt,
      stageName: "winner_source_premise_movie_selection",
      provider: "chatgpt_web",
      responsePath: flags["movie-selector-response-path"],
    }),
  });
  if (selection.document.status !== "selected") {
    throw new Error(`Premise movie selector rejected the pool: ${selection.document.rejection_reason}`);
  }
  const selectedMovies = selection.document.selected_blind_ids.map((blindId) => {
    const row = poolRows.find((candidate) => candidate.blind_id === blindId);
    return { blind_id: blindId, ...row.candidate };
  });
  printResult({
    status: "passed",
    movie_pool_path: poolPath,
    movie_pool_sha256: poolSha256,
    selection_path: selection.path,
    selected_movies: selectedMovies.map((row) => ({ blind_id: row.blind_id, story_movie: row.story_movie })),
    next_action: "ideate-v2",
  });
}

async function promotePremiseMovie() {
  const evidence = await loadEvidence();
  const discovery = await loadPremiseMovieDiscoveryIfPresent(evidence);
  if (!discovery) throw new Error("Premise discovery must pass before an operator can promote a raw movie.");
  const selectedBlindId = required(flags["movie-id"] ?? flags["premise-movie-id"], "--movie-id <blind_movie_id>");
  const selected = discovery.selectedMovies.find((row) => row.blind_id === selectedBlindId);
  if (!selected) throw new Error(`Raw premise movie ${selectedBlindId} is not in the selected six.`);
  const document = {
    schema: "goldflow_premise_movie_operator_promotion_v1",
    status: "promoted",
    premise_movie_pool_sha256: discovery.poolSha256,
    premise_movie_selection_sha256: discovery.selectionSha256,
    selected_blind_id: selectedBlindId,
    selected_premise_movie_sha256: selected.premise_movie_sha256,
    selected_story_movie: selected.story_movie,
    promoted_by: required(flags["promoted-by"] ?? flags["approved-by"], "--promoted-by <operator-id>"),
    rationale: required(flags.rationale, "--rationale <operator rationale>"),
    canon_clarification: required(flags["canon-clarification"], "--canon-clarification <approved causal clarification>"),
    promoted_at: new Date().toISOString(),
  };
  assertValid("premise movie operator promotion", validatePremiseMoviePromotion(document, { discovery }));
  const outputPath = artifactPath(FILES.premiseMoviePromotion);
  if (await exists(outputPath)) {
    const existing = await readJson(outputPath);
    assertValid("existing premise movie operator promotion", validatePremiseMoviePromotion(existing, { discovery }));
    if (existing.selected_blind_id !== document.selected_blind_id) {
      throw new Error("A different raw premise movie is already operator-promoted; refusing overwrite.");
    }
  } else {
    await writeJsonExclusive(outputPath, document);
  }
  printResult({
    status: "promoted",
    promotion_path: outputPath,
    promotion_sha256: await fileSha256(outputPath),
    selected_blind_id: selectedBlindId,
    story_movie: selected.story_movie,
    next_action: "ideate-v2",
  });
}

async function ideateLegacyV2() {
  const evidence = await loadEvidence();
  const packageOutlierLedger = await loadPackageOutliers();
  const evidenceProjection = premiseEvidenceProjection(evidence);
  const outlierProjection = premiseOutlierProjection(packageOutlierLedger);
  const authorTemplate = await promptTemplate(PROMPTS.premiseAuthor);
  const developmentId = developmentSlug || path.basename(developmentDirectory());
  const authorPrompt = authorTemplate.text
    .replaceAll("CHANNEL", channel)
    .replaceAll("DEVELOPMENT_SLUG", developmentId)
    .replaceAll("SHA256", evidence.sha256)
    + embedded("BINDING EVIDENCE REGISTRY PROJECTION JSON", evidenceProjection)
    + embedded("BINDING PACKAGE OUTLIER LEDGER PROJECTION JSON", outlierProjection);
  const slate = await materializeModelJson({
    fileName: FILES.premiseSlate,
    validator: validatePremiseSlateV2,
    validatorOptions: {
      evidenceRegistry: evidence.document,
      evidenceRegistrySha256: evidence.sha256,
      packageOutlierLedger: packageOutlierLedger.document,
    },
    call: () => modelResponse({
      id: "premise_slate_v2_author",
      prompt: authorPrompt,
      stageName: "winner_source_ideate_v2",
      provider: "chatgpt_web",
      responsePath: flags["author-response-path"],
    }),
  });

  const selectorTemplate = await promptTemplate(PROMPTS.premiseSelector);
  const selectorPrompt = selectorTemplate.text
    .replace('"premise_slate_sha256": "SHA256"', `"premise_slate_sha256": "${slate.sha256}"`)
    .replace('"evidence_registry_sha256": "SHA256"', `"evidence_registry_sha256": "${evidence.sha256}"`)
    + embedded("BINDING PREMISE SLATE JSON", slate.document)
    + embedded("BINDING EVIDENCE REGISTRY PROJECTION JSON", evidenceProjection)
    + embedded("BINDING PACKAGE OUTLIER LEDGER PROJECTION JSON", outlierProjection)
    + `\n\nUse premise_slate_sha256 ${slate.sha256} and evidence_registry_sha256 ${evidence.sha256}.`;
  const selection = await materializeModelJson({
    fileName: FILES.premiseSelection,
    validator: validatePremiseSelectionV2,
    validatorOptions: {
      premiseSlate: slate.document,
      premiseSlateSha256: slate.sha256,
      evidenceRegistry: evidence.document,
      evidenceRegistrySha256: evidence.sha256,
    },
    call: () => modelResponse({
      id: "premise_selection_v2_selector",
      prompt: selectorPrompt,
      stageName: "winner_source_premise_selection_audit_v2",
      provider: "gemini_web",
      responsePath: flags["selector-response-path"],
    }),
  });
  if (selection.document.status !== "selected") throw new Error("Premise selector rejected the slate.");
  printResult({ status: "passed", slate_path: slate.path, selection_path: selection.path, screened_id: selection.document.selected_candidate_id, next_action: "package-tournament" });
}

function premisePoolRows({ gptSlate, geminiSlate, blindSeed }) {
  const rows = [
    ...gptSlate.document.candidates.map((candidate) => ({ author: "gpt_web", candidate })),
    ...geminiSlate.document.candidates.map((candidate) => ({ author: "gemini_web", candidate })),
  ].map(({ author, candidate }) => ({
    source_candidate_id: `${author}:${candidate.id}`,
    author,
    candidate_sha256: sha256CanonicalStoryJson(candidate),
    candidate,
  }));
  rows.sort((left, right) => sha256Text(`${blindSeed}\0${left.source_candidate_id}`)
    .localeCompare(sha256Text(`${blindSeed}\0${right.source_candidate_id}`)));
  return rows.map((row, index) => ({ ...row, blind_id: `blind_${String.fromCharCode(97 + index)}` }));
}

async function ideateFirstClassV4(evidence, packageOutlierLedger) {
  const evidenceProjection = premiseEvidenceProjection(evidence);
  const outlierProjection = premiseOutlierProjection(packageOutlierLedger);
  const authorTemplate = await promptTemplate(PROMPTS.premiseAuthorV3);
  const developmentId = developmentSlug || path.basename(developmentDirectory());
  const learningLedger = evidence.roomContract.source_learning_ledger_path
    ? await readJson(evidence.roomContract.source_learning_ledger_path)
    : null;
  const premiseMovieDiscovery = await loadPremiseMovieDiscoveryIfPresent(evidence);
  if (!premiseMovieDiscovery) {
    throw new Error("First-Class Story Room V4 requires raw premise discovery before packaging. Run source premise-discover first.");
  }
  const selectedPremiseMovies = premiseMovieDiscovery?.selectedMovies ?? null;
  const premiseMoviePromotion = await loadPremiseMoviePromotionIfPresent(premiseMovieDiscovery);
  const authorPrompt = (authorRole) => authorTemplate.text
    .replaceAll("CHANNEL", channel)
    .replaceAll("DEVELOPMENT_SLUG", developmentId)
    .replaceAll("SHA256", evidence.sha256)
    + `\n\nAUTHOR ROLE: ${authorRole}. Work in a fresh independent context. Do not assume, imitate, or compare another author's slate.`
    + embedded("BINDING EVIDENCE REGISTRY PROJECTION JSON", evidenceProjection)
    + embedded("BINDING PACKAGE OUTLIER LEDGER PROJECTION JSON", outlierProjection)
    + (selectedPremiseMovies ? embedded("SELECTED RAW PREMISE MOVIES TO PACKAGE EXACTLY ONCE EACH", selectedPremiseMovies) : "")
    + (premiseMoviePromotion ? embedded("OPERATOR-PROMOTED PREMISE AND BINDING CANON CLARIFICATION", premiseMoviePromotion.document) : "")
    + (selectedPremiseMovies
      ? "\n\nDo not invent replacement concepts. Produce exactly one title-thumbnail package for each selected raw movie, preserving its strange specific situation while applying simple winner packaging only afterward."
      : "")
    + (learningLedger ? embedded("OBSERVATIONAL OWN-CHANNEL STORY LEARNING LEDGER", learningLedger) : "");
  const authorCall = ({ fileName, provider, id, authorRole, responsePath }) => materializeModelJson({
    fileName,
    validator: validatePremiseSlateV2,
    validatorOptions: {
      evidenceRegistry: evidence.document,
      evidenceRegistrySha256: evidence.sha256,
      packageOutlierLedger: packageOutlierLedger.document,
      premiseMovieBindings: premiseMovieDiscovery?.bindings ?? null,
    },
    call: () => modelResponse({
      id,
      prompt: authorPrompt(authorRole),
      stageName: `winner_source_ideate_v3_${authorRole}`,
      provider,
      responsePath,
    }),
  });
  const [gptSlate, geminiSlate] = await Promise.all([
    authorCall({
      fileName: FILES.premiseSlateGpt,
      provider: "chatgpt_web",
      id: "premise_slate_v3_gpt",
      authorRole: flags["premise-reasoning-effort"] === "medium"
        ? "gpt_web_medium_independent_author"
        : "gpt_web_pro_independent_author",
      responsePath: flags["gpt-author-response-path"] ?? flags["author-response-path"],
    }),
    authorCall({
      fileName: FILES.premiseSlateGemini,
      provider: "gemini_web",
      id: "premise_slate_v3_gemini",
      authorRole: "gemini_web_independent_author",
      responsePath: flags["gemini-author-response-path"],
    }),
  ]);

  const blindSeed = evidence.roomContract.draft_blind_seed;
  const poolDocument = {
    schema: PREMISE_POOL_V3_SCHEMA,
    status: "pooled",
    evidence_registry_sha256: evidence.sha256,
    author_slate_sha256s: {
      gpt_web: gptSlate.sha256,
      gemini_web: geminiSlate.sha256,
    },
    source_learning_ledger_sha256: evidence.roomContract.source_learning_ledger_sha256,
    candidates: premisePoolRows({ gptSlate, geminiSlate, blindSeed }),
    created_at: new Date().toISOString(),
  };
  const poolPath = artifactPath(FILES.premisePool);
  if (!await exists(poolPath)) await writeJsonExclusive(poolPath, poolDocument);
  const pool = await validatedJson(FILES.premisePool, validatePremisePoolV3, {
    gptSlate: gptSlate.document,
    gptSlateSha256: gptSlate.sha256,
    geminiSlate: geminiSlate.document,
    geminiSlateSha256: geminiSlate.sha256,
    evidenceRegistrySha256: evidence.sha256,
  });

  const blindSelectorTemplate = await promptTemplate(PROMPTS.premiseBlindSelector);
  const blindedCandidates = pool.document.candidates.map((row) => ({
    blind_id: row.blind_id,
    candidate: row.candidate,
  }));
  const selectorPrompt = blindSelectorTemplate.text
    + embedded("BLINDED TWELVE-PACKAGE POOL", {
      premise_pool_sha256: pool.sha256,
      evidence_registry_sha256: evidence.sha256,
      candidates: blindedCandidates,
    })
    + embedded("BINDING EVIDENCE REGISTRY PROJECTION JSON", evidenceProjection)
    + embedded("BINDING PACKAGE OUTLIER LEDGER PROJECTION JSON", outlierProjection)
    + (learningLedger ? embedded("OBSERVATIONAL OWN-CHANNEL STORY LEARNING LEDGER", learningLedger) : "")
    + "\n\nAuthor identities and model origins are intentionally withheld. Judge only the packages.";
  const blindSelection = await materializeModelJson({
    fileName: FILES.premiseBlindSelection,
    validator: validatePremiseBlindSelectionV3,
    validatorOptions: {
      premisePool: pool.document,
      premisePoolSha256: pool.sha256,
      evidenceRegistrySha256: evidence.sha256,
      requireOneFinalistPerPremiseMovie: Boolean(premiseMovieDiscovery),
    },
    call: () => modelResponse({
      id: "premise_blind_selection_v3",
      prompt: selectorPrompt,
      stageName: "winner_source_premise_blind_selection_v3",
      provider: "gemini_web",
      responsePath: flags["selector-response-path"],
    }),
  });
  if (blindSelection.document.status !== "selected") throw new Error("Fresh blinded premise judge rejected the complete candidate pool.");

  const poolByBlindId = new Map(pool.document.candidates.map((row) => [row.blind_id, row]));
  const slotIds = ["core_1", "core_2", "core_3", "core_4", "challenger_1", "challenger_2"];
  const canonicalRows = blindSelection.document.finalist_blind_ids.map((blindId, index) => {
    const source = poolByBlindId.get(blindId);
    if (!source) throw new Error(`Blind finalist ${blindId} is missing from the premise pool.`);
    return {
      ...source.candidate,
      id: `candidate_${String(index + 1).padStart(2, "0")}`,
      slot: slotIds[index],
      ...(premiseMoviePromotion && source.candidate?.source_premise_movie?.blind_id === premiseMoviePromotion.document.selected_blind_id ? {
        operator_premise_canon: {
          promotion_sha256: premiseMoviePromotion.sha256,
          canon_clarification: premiseMoviePromotion.document.canon_clarification,
        },
      } : {}),
    };
  });
  const slateDocument = {
    schema: PREMISE_SLATE_V3_SCHEMA,
    status: "planned",
    channel,
    development_slug: developmentId,
    evidence_registry_sha256: evidence.sha256,
    candidates: canonicalRows,
  };
  assertValid(FILES.premiseSlate, validatePremiseSlateV2(slateDocument, {
    evidenceRegistry: evidence.document,
    evidenceRegistrySha256: evidence.sha256,
    packageOutlierLedger: packageOutlierLedger.document,
    premiseMovieBindings: premiseMovieDiscovery?.bindings ?? null,
  }));
  const slatePath = artifactPath(FILES.premiseSlate);
  if (!await exists(slatePath)) await writeJsonExclusive(slatePath, slateDocument);
  else if (sha256CanonicalJson(await readJson(slatePath)) !== sha256CanonicalJson(slateDocument)) throw new Error("Existing finalist premise slate differs from the blinded selection.");
  const slateSha256 = await fileSha256(slatePath);

  const canonicalByBlindId = new Map(blindSelection.document.finalist_blind_ids.map((blindId, index) => [blindId, canonicalRows[index]]));
  const selectedCandidate = premiseMoviePromotion
    ? canonicalRows.find((candidate) => candidate?.source_premise_movie?.blind_id === premiseMoviePromotion.document.selected_blind_id)
    : canonicalByBlindId.get(blindSelection.document.selected_blind_id);
  if (!selectedCandidate) throw new Error("The promoted raw premise movie has no canonical finalist package.");
  const rankingByBlindId = new Map(blindSelection.document.rankings.map((row) => [row.blind_id, row]));
  const selectionDocument = {
    schema: "goldflow_premise_selection_v2",
    status: "selected",
    premise_slate_sha256: slateSha256,
    evidence_registry_sha256: evidence.sha256,
    selected_candidate_id: selectedCandidate.id,
    rejection_reason: null,
    selection_rationale: premiseMoviePromotion
      ? `Operator-promoted raw premise ${premiseMoviePromotion.document.selected_blind_id}; blind selector chose the strongest package execution for each raw movie. ${blindSelection.document.selection_rationale}`
      : blindSelection.document.selection_rationale,
    comparative_findings: blindSelection.document.finalist_blind_ids.map((blindId) => {
      const candidate = canonicalByBlindId.get(blindId);
      const ranking = rankingByBlindId.get(blindId);
      return {
        candidate_id: candidate.id,
        claim_ids: [...new Set([candidate.positive_analogue.claim_id, candidate.failure_analogue.claim_id])],
        click_judgment: ranking.click_judgment,
        runway_judgment: ranking.runway_judgment,
        decisive_reason: ranking.decisive_reason,
      };
    }),
  };
  assertValid(FILES.premiseSelection, validatePremiseSelectionV2(selectionDocument, {
    premiseSlate: slateDocument,
    premiseSlateSha256: slateSha256,
    evidenceRegistry: evidence.document,
    evidenceRegistrySha256: evidence.sha256,
  }));
  const selectionPath = artifactPath(FILES.premiseSelection);
  if (!await exists(selectionPath)) await writeJsonExclusive(selectionPath, selectionDocument);
  else if (sha256CanonicalJson(await readJson(selectionPath)) !== sha256CanonicalJson(selectionDocument)) throw new Error("Existing canonical premise selection differs from the blinded selection.");

  const lineageDocument = {
    schema: "goldflow_premise_finalist_lineage_v3",
    status: "bound",
    premise_pool_sha256: pool.sha256,
    blind_selection_sha256: blindSelection.sha256,
    canonical_slate_sha256: slateSha256,
    finalists: blindSelection.document.finalist_blind_ids.map((blindId, index) => {
      const source = poolByBlindId.get(blindId);
      return {
        canonical_candidate_id: canonicalRows[index].id,
        blind_id: blindId,
        source_candidate_id: source.source_candidate_id,
        source_candidate_sha256: source.candidate_sha256,
        author_slate_sha256: source.author === "gpt_web" ? gptSlate.sha256 : geminiSlate.sha256,
        ...(source.candidate.source_premise_movie ? { source_premise_movie: source.candidate.source_premise_movie } : {}),
      };
    }),
  };
  const lineagePath = artifactPath(FILES.premiseFinalistLineage);
  if (!await exists(lineagePath)) await writeJsonExclusive(lineagePath, lineageDocument);
  else if (sha256CanonicalJson(await readJson(lineagePath)) !== sha256CanonicalJson(lineageDocument)) throw new Error("Existing premise finalist lineage differs from the sealed pool.");

  printResult({
    status: "passed",
    author_slate_paths: [gptSlate.path, geminiSlate.path],
    premise_pool_path: pool.path,
    blind_selection_path: blindSelection.path,
    finalist_slate_path: slatePath,
    selection_path: selectionPath,
    screened_id: selectedCandidate.id,
    next_action: "package-tournament",
  });
}

async function ideateV2() {
  const evidence = await loadEvidence();
  const packageOutlierLedger = await loadPackageOutliers();
  if (firstClassStoryRoom({ evidence })) {
    await ideateFirstClassV4(evidence, packageOutlierLedger);
    return;
  }
  await ideateLegacyV2();
}

async function packageTournament() {
  const evidence = await loadEvidence();
  const premiseMovieDiscovery = await loadPremiseMovieDiscoveryIfPresent(evidence);
  const premiseMoviePromotion = await loadPremiseMoviePromotionIfPresent(premiseMovieDiscovery);
  const packageOutliers = await loadPackageOutliers();
  const slate = await validatedJson(FILES.premiseSlate, validatePremiseSlateV2, {
    evidenceRegistry: evidence.document,
    evidenceRegistrySha256: evidence.sha256,
    packageOutlierLedger: packageOutliers.document,
    premiseMovieBindings: premiseMovieDiscovery?.bindings ?? null,
  });
  await validatedJson(FILES.premiseSelection, validatePremiseSelectionV2, {
    premiseSlate: slate.document,
    premiseSlateSha256: slate.sha256,
    evidenceRegistry: evidence.document,
    evidenceRegistrySha256: evidence.sha256,
  });
  // The author grades click/runway inside its own slate, but those grades are
  // evidence rather than admission tickets. Independent judges must see every
  // finalist or an author can accidentally screen out the actual winner.
  const eligibleCandidates = slate.document.candidates;
  if (!eligibleCandidates.length) throw new Error("The package slate contains no tournament candidates.");

  const template = await promptTemplate(PROMPTS.packageTournament);
  const tournamentInput = {
    schema: "goldflow_package_tournament_input_v1",
    premise_slate_sha256: slate.sha256,
    eligible_candidate_ids: eligibleCandidates.map((candidate) => candidate.id),
    candidates: eligibleCandidates,
    operator_promoted_candidate_id: premiseMoviePromotion
      ? eligibleCandidates.find((candidate) => candidate?.source_premise_movie?.blind_id === premiseMoviePromotion.document.selected_blind_id)?.id ?? null
      : null,
  };
  if (premiseMoviePromotion && !tournamentInput.operator_promoted_candidate_id) {
    throw new Error("The operator-promoted raw movie is absent from the finalist package slate.");
  }
  const tournamentCall = ({ providerRole, provider, fileName, responsePath }) => materializeModelJson({
    fileName,
    validator: validatePackageTournament,
    validatorOptions: { premiseSlate: slate.document, premiseSlateSha256: slate.sha256 },
    call: () => modelResponse({
      id: `package_tournament_${providerRole}`,
      prompt: template.text
        .replaceAll("PROVIDER_ROLE", providerRole)
        .replaceAll("PREMISE_SLATE_SHA256", slate.sha256)
        + embedded("BINDING ELIGIBLE PACKAGE TOURNAMENT INPUT JSON", tournamentInput)
        + embedded("BINDING PACKAGE OUTLIER LEDGER PROJECTION JSON", premiseOutlierProjection(packageOutliers)),
      stageName: `winner_source_package_tournament_${providerRole}`,
      provider,
      responsePath,
    }),
  });
  const [gptTournament, geminiTournament] = await Promise.all([
    tournamentCall({
      providerRole: "gpt_web_pro",
      provider: "chatgpt_web",
      fileName: FILES.packageTournamentGpt,
      responsePath: flags["gpt-response-path"],
    }),
    tournamentCall({
      providerRole: "gemini_web_3_6_flash",
      provider: "gemini_web",
      fileName: FILES.packageTournamentGemini,
      responsePath: flags["gemini-response-path"],
    }),
  ]);
  if (premiseMoviePromotion) {
    for (const tournament of [gptTournament, geminiTournament]) {
      if (tournament.document.selected_candidate_id !== null
        && tournament.document.selected_candidate_id !== tournamentInput.operator_promoted_candidate_id) {
        throw new Error("A package judge attempted to replace the operator-promoted raw premise.");
      }
    }
  }

  const sameWinner = gptTournament.document.selected_candidate_id
    && gptTournament.document.selected_candidate_id === geminiTournament.document.selected_candidate_id;
  const strongConsensus = Boolean(sameWinner)
    && gptTournament.document.click_confidence === "strong"
    && geminiTournament.document.click_confidence === "strong"
    && gptTournament.document.runway_screen === "strong"
    && geminiTournament.document.runway_screen === "strong";
  const consensusDocument = {
    schema: "goldflow_package_tournament_consensus_v1",
    status: strongConsensus ? "consensus" : "disagreement",
    premise_slate_sha256: slate.sha256,
    gpt_tournament_sha256: gptTournament.sha256,
    gemini_tournament_sha256: geminiTournament.sha256,
    selected_candidate_id: strongConsensus ? gptTournament.document.selected_candidate_id : null,
    consensus_click_confidence: strongConsensus ? "strong" : null,
    consensus_runway_screen: strongConsensus ? "strong" : null,
    created_at: new Date().toISOString(),
  };
  const consensusPath = artifactPath(FILES.packageTournamentConsensus);
  if (!await exists(consensusPath)) await writeJsonExclusive(consensusPath, consensusDocument);
  const consensus = await validatedJson(FILES.packageTournamentConsensus, validatePackageTournamentConsensus, {
    premiseSlateSha256: slate.sha256,
    gptTournament: gptTournament.document,
    gptTournamentSha256: gptTournament.sha256,
    geminiTournament: geminiTournament.document,
    geminiTournamentSha256: geminiTournament.sha256,
  });
  printResult({
    status: consensus.document.status,
    consensus_path: consensus.path,
    selected_id: consensus.document.selected_candidate_id,
    next_action: consensus.document.status === "consensus" ? "approve-package-v2" : "operator-adjudication",
  });
}

async function adjudicatePackage() {
  const evidence = await loadEvidence();
  const premiseMovieDiscovery = await loadPremiseMovieDiscoveryIfPresent(evidence);
  const premiseMoviePromotion = await loadPremiseMoviePromotionIfPresent(premiseMovieDiscovery);
  const packageOutliers = await loadPackageOutliers();
  const slate = await validatedJson(FILES.premiseSlate, validatePremiseSlateV2, {
    evidenceRegistry: evidence.document,
    evidenceRegistrySha256: evidence.sha256,
    packageOutlierLedger: packageOutliers.document,
    premiseMovieBindings: premiseMovieDiscovery?.bindings ?? null,
  });
  const gptTournament = await validatedJson(FILES.packageTournamentGpt, validatePackageTournament, {
    premiseSlate: slate.document,
    premiseSlateSha256: slate.sha256,
  });
  const geminiTournament = await validatedJson(FILES.packageTournamentGemini, validatePackageTournament, {
    premiseSlate: slate.document,
    premiseSlateSha256: slate.sha256,
  });
  const consensus = await validatedJson(FILES.packageTournamentConsensus, validatePackageTournamentConsensus, {
    premiseSlateSha256: slate.sha256,
    gptTournament: gptTournament.document,
    gptTournamentSha256: gptTournament.sha256,
    geminiTournament: geminiTournament.document,
    geminiTournamentSha256: geminiTournament.sha256,
  });
  if (consensus.document.status !== "disagreement") {
    throw new Error("Package adjudication is available only when the GPT/Gemini tournament records disagreement.");
  }
  const selectedCandidateId = required(flags["candidate-id"], "--candidate-id <candidate-id>");
  if (premiseMoviePromotion) {
    const candidate = slate.document.candidates.find((row) => row.id === selectedCandidateId);
    if (candidate?.source_premise_movie?.blind_id !== premiseMoviePromotion.document.selected_blind_id) {
      throw new Error("Operator adjudication cannot replace the promoted raw premise movie.");
    }
  }
  const adjudicatedBy = required(flags["adjudicated-by"] ?? flags["approved-by"], "--adjudicated-by <operator-id>");
  const rationale = required(flags.rationale, "--rationale <operator rationale>");
  const outputPath = artifactPath(FILES.packageAdjudication);
  const document = {
    schema: PACKAGE_ADJUDICATION_SCHEMA,
    status: "adjudicated",
    premise_slate_sha256: slate.sha256,
    tournament_consensus_sha256: consensus.sha256,
    gpt_tournament_sha256: gptTournament.sha256,
    gemini_tournament_sha256: geminiTournament.sha256,
    selected_candidate_id: selectedCandidateId,
    adjudicated_by: adjudicatedBy,
    rationale,
    adjudicated_at: new Date().toISOString(),
  };
  assertValid("package adjudication", validatePackageAdjudication(document, {
    premiseSlate: slate.document,
    premiseSlateSha256: slate.sha256,
    tournamentConsensus: consensus.document,
    tournamentConsensusSha256: consensus.sha256,
    gptTournamentSha256: gptTournament.sha256,
    geminiTournamentSha256: geminiTournament.sha256,
  }));
  if (await exists(outputPath)) {
    const existing = await readJson(outputPath);
    assertValid("existing package adjudication", validatePackageAdjudication(existing, {
      premiseSlate: slate.document,
      premiseSlateSha256: slate.sha256,
      tournamentConsensus: consensus.document,
      tournamentConsensusSha256: consensus.sha256,
      gptTournamentSha256: gptTournament.sha256,
      geminiTournamentSha256: geminiTournament.sha256,
    }));
    if (sha256CanonicalJson(existing) !== sha256CanonicalJson(document)) {
      throw new Error("A different valid package adjudication already exists; refusing overwrite.");
    }
  } else {
    await writeJsonExclusive(outputPath, document);
  }
  printResult({
    status: "adjudicated",
    adjudication_path: outputPath,
    selected_id: selectedCandidateId,
    next_action: "approve-package-v2",
  });
}

async function writeApproval({ fileName, stageId, sourceSha256, selectedId = null }) {
  const approvedBy = required(flags["approved-by"], "--approved-by <operator-id>");
  const outputPath = artifactPath(fileName);
  if (await exists(outputPath)) {
    const current = await readJson(outputPath);
    assertValid(fileName, validateSourceStageApproval(current, { stageId, sourceSha256, selectedId }));
    return { path: outputPath, document: current, sha256: await fileSha256(outputPath), resumed: true };
  }
  const approval = {
    schema: SOURCE_STAGE_APPROVAL_SCHEMA,
    stage_id: stageId,
    source_sha256: sourceSha256,
    selected_id: selectedId,
    approved: true,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
  };
  assertValid(fileName, validateSourceStageApproval(approval, { stageId, sourceSha256, selectedId }));
  await writeJsonExclusive(outputPath, approval);
  return { path: outputPath, document: approval, sha256: await fileSha256(outputPath), resumed: false };
}

async function approvePackageV2() {
  const room = await loadPremiseRoom();
  const approval = await writeApproval({
    fileName: FILES.packageApproval,
    stageId: "package_selection",
    sourceSha256: room.packageSha256,
    selectedId: room.candidate.id,
  });
  printResult({ status: "passed", approval_path: approval.path, package_sha256: room.packageSha256, next_action: "reference-frontier" });
}

async function revisePackageThumbnail() {
  const room = await loadPremiseRoom();
  const thumbnailReceipt = required(flags["thumbnail-receipt"], "--thumbnail-receipt <exact simplified thumbnail contract>");
  const revisedBy = required(flags["revised-by"] ?? flags["approved-by"], "--revised-by <operator-id>");
  const rationale = required(flags.rationale, "--rationale <operator rationale>");
  const outputPath = artifactPath(FILES.packageOperatorRevision);
  const document = {
    schema: "goldflow_package_operator_revision_v1",
    status: "revised",
    base_package_sha256: room.basePackageSha256,
    selected_candidate_id: room.baseCandidate.id,
    field: "thumbnail_receipt",
    thumbnail_receipt: thumbnailReceipt,
    revised_by: revisedBy,
    rationale,
    revised_at: new Date().toISOString(),
  };
  if (await exists(outputPath)) {
    const existing = await readJson(outputPath);
    const comparable = { ...existing, revised_at: document.revised_at };
    if (sha256CanonicalJson(comparable) !== sha256CanonicalJson(document)) {
      throw new Error("A different package operator revision already exists; refusing overwrite.");
    }
  } else {
    await writeJsonExclusive(outputPath, document);
  }
  const revisedRoom = await loadPremiseRoom();
  printResult({
    status: "revised",
    revision_path: outputPath,
    package_sha256: revisedRoom.packageSha256,
    thumbnail_receipt: revisedRoom.candidate.thumbnail_receipt,
    next_action: "approve-package-v2",
  });
}

async function referenceFrontier() {
  const room = await loadApprovedPackage();
  const outlier = selectedOutlierContract(room, String(flags["reference-entry-id"] ?? "").trim() || null);
  const sourcePath = path.resolve(required(flags.reference, "--reference <exact measured outlier transcript>"));
  const sourceBytes = await readBytes(sourcePath);
  const sourceText = sourceBytes.toString("utf8");
  if (countWords(sourceText) < 500) throw new Error("Reference transcript is too short to establish a full-story merit frontier.");
  const transcriptPath = artifactPath(FILES.referenceTranscript);
  if (await exists(transcriptPath)) {
    if (await fileSha256(transcriptPath) !== sha256(sourceBytes)) throw new Error("A different reference transcript is already bound to this room.");
  } else {
    await writeExclusive(transcriptPath, sourceBytes);
  }
  const referenceSha256 = await fileSha256(transcriptPath);
  const receiptPath = artifactPath(FILES.referenceReceipt);
  const receipt = {
    schema: "goldflow_reference_outlier_receipt_v1",
    status: "passed",
    package_sha256: room.packageSha256,
    source_outlier_id: outlier.sourceId,
    reference_title: outlier.sourceTitle,
    source_path: sourcePath,
    source_sha256: sha256(sourceBytes),
    reference_path: transcriptPath,
    reference_sha256: referenceSha256,
    reference_word_count: countWords(sourceText),
    imported_at: new Date().toISOString(),
  };
  if (await exists(receiptPath)) {
    const existing = await readJson(receiptPath);
    if (sha256CanonicalJson(existing) !== sha256CanonicalJson(receipt)) {
      const comparable = { ...existing, imported_at: receipt.imported_at };
      if (sha256CanonicalJson(comparable) !== sha256CanonicalJson(receipt)) throw new Error("Existing reference receipt does not match the current source.");
    }
  } else {
    await writeJsonExclusive(receiptPath, receipt);
  }
  const template = await promptTemplate(PROMPTS.referenceMeritFrontier);
  const prompt = template.text
    + embedded("LOCKED PACKAGE JSON", room.candidate)
    + embedded("EXACT MEASURED OUTLIER TRANSCRIPT", sourceText)
    + `\n\nUse package_sha256 ${room.packageSha256}, reference_sha256 ${referenceSha256}, reference_path ${transcriptPath}, source_outlier_id ${outlier.sourceId}, reference_title ${JSON.stringify(outlier.sourceTitle)}, reference_word_count ${countWords(sourceText)}, and normalization_policy ${REFERENCE_DENSITY_NORMALIZATION_POLICY}. Include exactly these dimension IDs: ${REFERENCE_DENSITY_DIMENSION_IDS.join(", ")}.`;
  const frontier = await materializeModelJson({
    fileName: FILES.referenceMeritFrontier,
    validator: validateReferenceMeritFrontier,
    validatorOptions: {
      packageSha256: room.packageSha256,
      referenceText: sourceText,
      referenceSha256,
      referencePath: transcriptPath,
      referenceTitle: outlier.sourceTitle,
      requireMaterialEdges: materialReferenceEdgesRequiredForRoom(room),
    },
    call: () => modelResponse({
      id: "reference_merit_frontier",
      prompt,
      stageName: "winner_source_reference_merit_frontier_audit",
      provider: "gemini_web",
      responsePath: flags["response-path"],
      timeout: positiveInteger(flags["reference-timeout-ms"], 3_600_000),
    }),
    normalizeDocument: (document) => bindReferenceMeritFrontierAnchors(document, { referenceText: sourceText }),
  });
  printResult({
    status: "passed",
    reference_path: transcriptPath,
    reference_sha256: referenceSha256,
    frontier_path: frontier.path,
    frontier_sha256: frontier.sha256,
    next_action: "treatments",
  });
}

function singleTreatmentFromResponse(content, expected) {
  const parsed = parseModelJson(content, `${expected.engine} treatment`);
  const candidates = Array.isArray(parsed?.treatments) ? parsed.treatments : [parsed?.treatment_record ?? parsed];
  if (candidates.length !== 1) throw new Error(`${expected.engine} author must return exactly one treatment.`);
  const treatment = candidates[0];
  if (treatment?.id !== expected.id || treatment?.engine !== expected.engine) {
    throw new Error(`${expected.engine} treatment identity mismatch; expected ${expected.id}/${expected.engine}.`);
  }
  const words = countWords(treatment?.treatment);
  if (words < 800 || words > 1_200) throw new Error(`${expected.engine} treatment has ${words} words; expected 800-1200.`);
  for (const field of ["central_relationship", "opposition_learning_pattern", "midpoint_reclassification", "climax_causality", "closure_contract", "primary_failure_risk"]) {
    if (!String(treatment?.[field] ?? "").trim()) throw new Error(`${expected.engine} treatment is missing ${field}.`);
  }
  return treatment;
}

async function treatments() {
  const approvedPackage = await loadApprovedPackage();
  const room = await frontierRequiredForRoom(approvedPackage) ? await loadReferenceMeritFrontier() : approvedPackage;
  const target = artifactPath(FILES.treatmentBakeoff);
  if (await exists(target)) {
    const existing = await readJson(target);
    assertValid(FILES.treatmentBakeoff, validateTreatmentBakeoff(existing, { packageSha256: room.packageSha256 }));
    printResult({ status: "passed", treatment_bakeoff_path: target, resumed: true, next_action: "select-treatment" });
    return;
  }
  const template = await promptTemplate(PROMPTS.treatments);
  const assignments = [
    { id: "treatment_a", engine: "boundary_drama", provider: "chatgpt_web", responseFlag: "boundary-response-path" },
    { id: "treatment_b", engine: "adaptive_contest", provider: "gemini_web", responseFlag: "adaptive-response-path" },
    { id: "treatment_c", engine: "reclassification_drama", provider: "chatgpt_web", responseFlag: "reclassification-response-path" },
  ];
  const authored = await Promise.all(assignments.map(async (assignment) => {
    const prompt = `${template.text}\n\nYou are assigned ONLY ${assignment.engine}. Return one JSON treatment object, not a three-treatment batch. Its id MUST be ${assignment.id}; its engine MUST be ${assignment.engine}. Do not borrow or discuss the other engines.`
      + embedded("LOCKED PACKAGE JSON", room.candidate)
      + embedded("BINDING EVIDENCE REGISTRY JSON", room.evidence.document)
      + (room.referenceMeritFrontier ? embedded("BINDING REFERENCE MERIT FRONTIER JSON", room.referenceMeritFrontier.document) : "")
      + `\n\nBINDING PACKAGE SHA256: ${room.packageSha256}`;
    const response = await modelResponse({
      id: `treatment_${assignment.engine}`,
      prompt,
      stageName: `winner_source_creative_treatment_${assignment.engine}`,
      provider: assignment.provider,
      responsePath: flags[assignment.responseFlag],
    });
    return singleTreatmentFromResponse(response.content, { ...assignment, packageSha256: room.packageSha256 });
  }));
  const bakeoff = { schema: "goldflow_treatment_bakeoff_v1", status: "planned", package_sha256: room.packageSha256, treatments: authored };
  assertValid(FILES.treatmentBakeoff, validateTreatmentBakeoff(bakeoff, { packageSha256: room.packageSha256 }));
  await writeJsonExclusive(target, bakeoff);
  printResult({ status: "passed", treatment_bakeoff_path: target, treatment_count: authored.length, next_action: "select-treatment" });
}

async function selectTreatment() {
  const approvedPackage = await loadApprovedPackage();
  const room = await frontierRequiredForRoom(approvedPackage) ? await loadReferenceMeritFrontier() : approvedPackage;
  const bakeoff = await validatedJson(FILES.treatmentBakeoff, validateTreatmentBakeoff, { packageSha256: room.packageSha256 });
  const template = await promptTemplate(PROMPTS.treatmentSelector);
  const prompt = template.text
    .replace('"package_sha256": "SHA256"', `"package_sha256": "${room.packageSha256}"`)
    .replace('"treatment_batch_sha256": "SHA256"', `"treatment_batch_sha256": "${bakeoff.sha256}"`)
    + embedded("LOCKED PACKAGE JSON", room.candidate)
    + embedded("TREATMENT BAKEOFF JSON", bakeoff.document)
    + (room.referenceMeritFrontier ? embedded("BINDING REFERENCE MERIT FRONTIER JSON", room.referenceMeritFrontier.document) : "")
    + `\n\nUse package_sha256 ${room.packageSha256} and treatment_batch_sha256 ${bakeoff.sha256}.`;
  const selection = await materializeModelJson({
    fileName: FILES.treatmentSelection,
    validator: validateTreatmentSelection,
    validatorOptions: { packageSha256: room.packageSha256, treatmentBatch: bakeoff.document, treatmentBatchSha256: bakeoff.sha256 },
    call: () => modelResponse({
      id: "treatment_selection",
      prompt,
      stageName: "winner_source_treatment_selection_audit",
      provider: "gemini_web",
      responsePath: flags["response-path"],
    }),
    normalizeDocument: (document) => bindTreatmentSelectionAnchors(document, {
      treatmentBatch: bakeoff.document,
    }),
  });
  if (selection.document.status !== "selected") throw new Error("Treatment selector rejected all treatments.");
  printResult({ status: "passed", selection_path: selection.path, selected_id: selection.document.selected_treatment_id, next_action: "approve-treatment" });
}

async function approveTreatment() {
  const room = await loadTreatmentRoom();
  const approval = await writeApproval({ fileName: FILES.treatmentApproval, stageId: "treatment_selection", sourceSha256: room.treatmentSha256, selectedId: room.treatment.id });
  printResult({ status: "passed", approval_path: approval.path, treatment_sha256: room.treatmentSha256, next_action: "architecture" });
}

async function architecture() {
  const room = await loadApprovedTreatment();
  const nameFamiliarityPath = artifactPath(FILES.nameFamiliarity);
  let nameFamiliarity;
  if (await exists(nameFamiliarityPath)) {
    nameFamiliarity = await readJson(nameFamiliarityPath);
  } else {
    const continuation = isTrue(flags.continuation) || titleSignalsContinuation(room.candidate.title);
    nameFamiliarity = continuation
      ? continuationExemptNameFamiliarityLedger({ ttlEpisodes: positiveInteger(flags["name-ttl-episodes"], 12) })
      : await buildSourceNameFamiliarityLedgerFromDisk(
        path.join(dataRoot, "channels", channel, "source_development"),
        {
          excludeDirectory: developmentDirectory(),
          ttlEpisodes: positiveInteger(flags["name-ttl-episodes"], 12),
        },
      );
    assertValid(FILES.nameFamiliarity, validateSourceNameFamiliarityLedger(nameFamiliarity));
    await writeJsonExclusive(nameFamiliarityPath, nameFamiliarity);
  }
  assertValid(FILES.nameFamiliarity, validateSourceNameFamiliarityLedger(nameFamiliarity));
  const nameFamiliaritySha256 = await fileSha256(nameFamiliarityPath);
  const template = await promptTemplate(PROMPTS.architecture);
  const prompt = template.text
    + embedded("APPROVED PACKAGE JSON", room.candidate)
    + embedded("SELECTED TREATMENT JSON", room.treatment)
    + embedded("TREATMENT SELECTION JSON", room.treatmentSelection.document)
    + embedded("BINDING EVIDENCE REGISTRY JSON", room.evidence.document)
    + (room.referenceMeritFrontier ? embedded("BINDING REFERENCE MERIT FRONTIER JSON", room.referenceMeritFrontier.document) : "")
    + embedded("CHANNEL SUPPORTING-NAME FAMILIARITY LEDGER", nameFamiliarity)
    + `\n\nUse package_sha256 ${room.packageSha256}, selected_treatment_sha256 ${room.treatmentSha256}, name_familiarity_ledger_sha256 ${nameFamiliaritySha256}, and target_word_range {"minimum":9500,"maximum":10500}. Include selected_treatment_contract with treatment_source_sha256 ${room.bakeoff.sha256} and selection_source_sha256 ${room.treatmentSelection.sha256}.`
    + (room.referenceMeritFrontier ? ` Include reference_merit_frontier_sha256 ${room.referenceMeritFrontier.sha256} and merit_dominance_contract with normalization_policy ${REFERENCE_DENSITY_NORMALIZATION_POLICY}, one obligation for every required frontier dimension, and one edge_obligations row for every material_reference_edges edge_id.` : "");
  const result = await materializeModelJson({
    fileName: FILES.architecture,
    validator: validateStoryArchitecture,
    validatorOptions: {
      packageSha256: room.packageSha256,
      selectedTreatmentSha256: room.treatmentSha256,
      treatmentBatchSha256: room.bakeoff.sha256,
      treatmentSelectionSha256: room.treatmentSelection.sha256,
      requireDramaticOpeningContract: true,
      requireCharacterNamePlan: true,
      nameFamiliarityLedgerSha256: nameFamiliaritySha256,
      requireMeritDominanceContract: Boolean(room.referenceMeritFrontier),
      referenceMeritFrontierSha256: room.referenceMeritFrontier?.sha256 ?? null,
      referenceMeritFrontier: room.referenceMeritFrontier?.document ?? null,
      requireMechanicComprehensionContract: true,
    },
    call: () => modelResponse({
      id: "story_architecture",
      prompt,
      stageName: "winner_source_story_architecture_creative",
      provider: "chatgpt_web",
      responsePath: flags["response-path"],
    }),
  });
  printResult({ status: "passed", architecture_path: result.path, architecture_sha256: result.sha256, next_action: "architecture-audit" });
}

async function architectureAudit() {
  const room = await loadArchitecture();
  const auditPath = artifactPath(FILES.architectureRedteam);
  if (await exists(auditPath)) {
    const existing = await readJson(auditPath);
    if (existing?.architecture_sha256 !== room.architecture.sha256) {
      const preservedPath = `${auditPath}.for-${String(existing?.architecture_sha256 ?? "unknown").slice(0, 16)}.json`;
      if (await exists(preservedPath)) throw new Error(`Cannot preserve stale architecture audit; destination exists: ${preservedPath}`);
      await fs.rename(auditPath, preservedPath);
    }
  }
  const template = await promptTemplate(PROMPTS.architectureRedteam);
  const prompt = template.text
    + embedded("EXACT SERIALIZED ARCHITECTURE INPUT", room.architectureText)
    + embedded("APPROVED PACKAGE JSON", room.candidate)
    + embedded("SELECTED TREATMENT JSON", room.treatment)
    + (room.referenceMeritFrontier ? embedded("BINDING REFERENCE MERIT FRONTIER JSON", room.referenceMeritFrontier.document) : "")
    + `\n\nBINDING ARCHITECTURE SHA256: ${room.architecture.sha256}`;
  const audit = await materializeModelJson({
    fileName: FILES.architectureRedteam,
    validator: validateArchitectureRedteam,
    validatorOptions: { architectureText: room.architectureText, architectureSha256: room.architecture.sha256 },
    call: () => modelResponse({
      id: `architecture_redteam_${room.architecture.sha256.slice(0, 16)}`,
      prompt,
      stageName: "winner_source_architecture_redteam_audit",
      provider: "gemini_web",
      responsePath: flags["response-path"],
    }),
  });
  printResult({ status: audit.document.status, architecture_redteam_path: audit.path, architecture_sha256: room.architecture.sha256, next_action: audit.document.status === "passed" ? "approve-architecture" : "manual architecture repair and a fresh exact-hash audit" });
  if (audit.document.status !== "passed") throw new Error("Architecture red team found material defects; no automatic rewrite was attempted.");
}

async function approveArchitecture() {
  const room = await loadArchitecture({ requireAudit: true });
  const approval = await writeApproval({ fileName: FILES.architectureApproval, stageId: "story_architecture", sourceSha256: room.architecture.sha256, selectedId: null });
  printResult({ status: "passed", approval_path: approval.path, architecture_sha256: room.architecture.sha256, next_action: firstClassStoryRoom(room) ? "story-truth" : "script-v2" });
}

async function storyTruth() {
  const room = await loadArchitecture({ requireApproval: true });
  if (!firstClassStoryRoom(room)) throw new Error("story-truth is available only for first_class_story_room_v4 rooms.");
  const template = await promptTemplate(PROMPTS.storyTruthIr);
  const packageReceipt = {
    package_sha256: room.packageSha256,
    package_id: room.candidate.id,
    title: room.candidate.title,
    thumbnail_receipt: room.candidate.thumbnail_receipt,
  };
  const prompt = template.text
    + embedded("APPROVED PACKAGE RECEIPT", packageReceipt)
    + embedded("APPROVED STORY ARCHITECTURE JSON", room.architecture.document)
    + `\n\nUse package_sha256 ${room.packageSha256}, selected_treatment_sha256 ${room.treatmentSha256}, and architecture_sha256 ${room.architecture.sha256}.`;
  const result = await materializeModelJson({
    fileName: FILES.storyTruthIr,
    validator: validateStoryTruthIr,
    validatorOptions: {
      packageSha256: room.packageSha256,
      selectedTreatmentSha256: room.treatmentSha256,
      architectureSha256: room.architecture.sha256,
      architecture: room.architecture.document,
    },
    call: () => modelResponse({
      id: "story_truth_ir",
      prompt,
      stageName: "winner_source_creative_story_truth_ir_v2",
      provider: "gemini_web",
      responsePath: flags["response-path"],
    }),
  });
  printResult({ status: "passed", story_truth_ir_path: result.path, story_truth_ir_sha256: result.sha256, authoring_mode: "llm_authored_medium", next_action: "story-truth-audit" });
}

async function storyTruthAudit() {
  const room = await loadStoryTruth({ requireAudit: false });
  const template = await promptTemplate(PROMPTS.storyTruthAudit);
  const prompt = template.text
    + embedded("APPROVED PACKAGE JSON", room.candidate)
    + embedded("APPROVED STORY ARCHITECTURE JSON", room.architecture.document)
    + embedded("STORY TRUTH IR JSON", room.storyTruthIr.document)
    + `\n\nBINDING STORY TRUTH IR SHA256: ${room.storyTruthIr.sha256}`;
  const result = await materializeModelJson({
    fileName: FILES.storyTruthAudit,
    validator: validateStoryTruthAudit,
    validatorOptions: { storyTruthIrSha256: room.storyTruthIr.sha256 },
    call: () => modelResponse({
      id: `story_truth_audit_${room.storyTruthIr.sha256.slice(0, 16)}`,
      prompt,
      stageName: "winner_source_story_truth_audit_v1",
      provider: "gemini_web",
      responsePath: flags["response-path"],
    }),
  });
  printResult({ status: result.document.status, story_truth_audit_path: result.path, next_action: result.document.status === "passed" ? "script-v2" : "manual Story Truth repair and fresh exact-hash audit" });
  if (result.document.status !== "passed") throw new Error("Story Truth audit found material defects; no automatic rewrite was attempted.");
}

async function writerPacket() {
  const room = await loadArchitecture({ requireApproval: true });
  if (!firstClassStoryRoom(room)) throw new Error("writer-packet is available only for first_class_story_room_v4 rooms.");
  const template = await promptTemplate(PROMPTS.writerPacket);
  const prompt = template.text
    + embedded("APPROVED PACKAGE JSON", room.candidate)
    + embedded("SELECTED TREATMENT JSON", room.treatment)
    + embedded("APPROVED STORY ARCHITECTURE JSON", room.architecture.document)
    + `\n\nUse package_sha256 ${room.packageSha256}, selected_treatment_sha256 ${room.treatmentSha256}, and architecture_sha256 ${room.architecture.sha256}.`;
  const result = await materializeModelJson({
    fileName: FILES.writerPacket,
    validator: validateStoryWriterPacket,
    validatorOptions: {
      packageSha256: room.packageSha256,
      selectedTreatmentSha256: room.treatmentSha256,
      architectureSha256: room.architecture.sha256,
      architecture: room.architecture.document,
    },
    call: () => modelResponse({
      id: "story_writer_packet",
      prompt,
      stageName: "winner_source_creative_story_writer_packet_v1",
      provider: "gemini_web",
      responsePath: flags["response-path"],
    }),
  });
  printResult({
    status: "passed",
    writer_packet_path: result.path,
    writer_packet_sha256: result.sha256,
    serialized_characters: JSON.stringify(result.document).length,
    next_action: "script-v2",
  });
}

function geminiDraftProvider() {
  return "gemini_web";
}

async function scriptLegacyV2() {
  const room = await loadArchitecture({ requireApproval: true });
  const template = await promptTemplate(PROMPTS.longform);
  const common = template.text
    + embedded("APPROVED PACKAGE JSON", room.candidate)
    + embedded("SELECTED TREATMENT JSON", room.treatment)
    + embedded("APPROVED STORY ARCHITECTURE JSON", room.architecture.document)
    + embedded("BINDING EVIDENCE REGISTRY JSON", room.evidence.document)
    + (room.referenceMeritFrontier ? embedded("BINDING REFERENCE MERIT FRONTIER JSON", room.referenceMeritFrontier.document) : "")
    + "\n\nWrite 9500-10500 words. Output narration prose only.";
  const geminiProvider = geminiDraftProvider();
  const [gptResponse, geminiResponse] = await Promise.all([
    modelResponse({
      id: "draft_gpt_web",
      prompt: `${common}\n\nYou are Draft G. Work independently; do not compare against another draft.`,
      stageName: "winner_source_script_v2_gpt_web",
      provider: "chatgpt_web",
      responsePath: flags["gpt-response-path"],
      directOutputPath: artifactPath(FILES.draftGpt),
      timeout: positiveInteger(flags["draft-timeout-ms"], 3_600_000),
    }),
    modelResponse({
      id: "draft_gemini_web",
      prompt: `${common}\n\nYou are Draft M. Work independently; do not compare against another draft.`,
      stageName: "winner_source_script_v2_gemini_web",
      provider: geminiProvider,
      responsePath: flags["gemini-response-path"],
      directOutputPath: artifactPath(FILES.draftGemini),
      timeout: positiveInteger(flags["draft-timeout-ms"], 3_600_000),
    }),
  ]);
  void gptResponse;
  void geminiResponse;

  const drafts = Object.fromEntries(await Promise.all([
    ["draft_gpt_web", artifactPath(FILES.draftGpt)],
    ["draft_gemini_web", artifactPath(FILES.draftGemini)],
  ].map(async ([id, draftPath]) => {
    const text = await readText(draftPath);
    const wordCount = countWords(text);
    if (wordCount < 1) throw new Error(`${id} is empty.`);
    return [id, { text, path: draftPath, sha256: await fileSha256(draftPath), word_count: wordCount }];
  })));

  const selectorTemplate = await promptTemplate(PROMPTS.longformSelectorLegacy);
  const providerAdaptedSelector = selectorTemplate.text
    .replaceAll("draft_codex", "draft_gemini_web")
    .replace('"package_sha256": "SHA256"', `"package_sha256": "${room.packageSha256}"`)
    .replace('"architecture_sha256": "SHA256"', `"architecture_sha256": "${room.architecture.sha256}"`)
    .replace('{ "id": "draft_gpt_web", "sha256": "SHA256" }', `{ "id": "draft_gpt_web", "sha256": "${drafts.draft_gpt_web.sha256}" }`)
    .replace('{ "id": "draft_gemini_web", "sha256": "SHA256" }', `{ "id": "draft_gemini_web", "sha256": "${drafts.draft_gemini_web.sha256}" }`);
  const selectorPrompt = providerAdaptedSelector
    + embedded("APPROVED PACKAGE JSON", room.candidate)
    + embedded("APPROVED STORY ARCHITECTURE JSON", room.architecture.document)
    + (room.referenceMeritFrontier ? embedded("BINDING REFERENCE MERIT FRONTIER JSON", room.referenceMeritFrontier.document) : "")
    + embedded("DRAFT GPT WEB EXACT TEXT", drafts.draft_gpt_web.text)
    + embedded("DRAFT GEMINI WEB EXACT TEXT", drafts.draft_gemini_web.text)
    + `\n\nUse package_sha256 ${room.packageSha256}, architecture_sha256 ${room.architecture.sha256}, draft_gpt_web sha256 ${drafts.draft_gpt_web.sha256}, and draft_gemini_web sha256 ${drafts.draft_gemini_web.sha256}. For this action approved_transplants must be an empty array so the winner can be materialized byte-for-byte.`;
  const selection = await materializeModelJson({
    fileName: FILES.draftSelection,
    validator: validateLongformDraftSelection,
    validatorOptions: {
      packageSha256: room.packageSha256,
      architectureSha256: room.architecture.sha256,
      expectedDrafts: drafts,
      requireOpeningVerdicts: hasDramaticColdOpenContract(room.architecture.document),
    },
    call: () => modelResponse({
      id: "longform_draft_selection",
      prompt: selectorPrompt,
      stageName: "winner_source_longform_draft_selection_audit",
      provider: "gemini_web",
      responsePath: flags["selector-response-path"],
      timeout: positiveInteger(flags["selector-timeout-ms"], 1_800_000),
    }),
  });
  if (selection.document.status !== "selected") throw new Error("Longform selector rejected both drafts.");
  if ((selection.document.approved_transplants ?? []).length) throw new Error("Longform selector returned transplants; byte-for-byte materialization requires none.");
  const selected = drafts[selection.document.selected_draft_id];
  const initialPath = artifactPath(FILES.initialScript);
  if (!await exists(initialPath)) await writeExclusive(initialPath, await readBytes(selected.path));
  else if (await fileSha256(initialPath) !== selected.sha256) throw new Error("Existing initial_selected_script.txt does not match the selected draft hash.");
  printResult({ status: "passed", draft_paths: { gpt_web: drafts.draft_gpt_web.path, gemini_web: drafts.draft_gemini_web.path }, selection_path: selection.path, selected_draft_id: selection.document.selected_draft_id, initial_script_path: initialPath, next_action: "diagnose-v2" });
}

function commaSeparatedPaths(value) {
  return String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean).map(path.resolve);
}

function draftLensInstruction(lens) {
  if (lens === "velocity_reversal") {
    return "Favor visible pressure, fast owned decisions, concrete reversals, and frequent changed situations. Emotional meaning must emerge through action rather than summary.";
  }
  if (lens === "relationship_pressure") {
    return "Favor consequential relationship choices, conflicting loyalties, earned intimacy, and betrayals whose costs alter later tactics. Preserve spectacle and title-native superiority.";
  }
  return "Favor evidence-based strategy, adaptive opposition, planted constraints, and victories caused by remembered learning. Keep tactics immediately legible to a one-pass listener.";
}

async function scriptFirstClassV4() {
  const room = await loadWriterPacket();
  const template = await promptTemplate(PROMPTS.longform);
  const common = template.text
    + embedded("LLM-AUTHORED BINDING STORY WRITER PACKET", room.writerPacket.document)
    + `\n\nBINDING WRITER PACKET SHA256: ${room.writerPacket.sha256}. Write 9500-10500 words. Output narration prose only.`;
  const gpt56ResponsePaths = commaSeparatedPaths(flags["gpt56-response-paths"] ?? flags["gpt-response-paths"]);
  const gpt55ResponsePaths = commaSeparatedPaths(flags["gpt55-response-paths"]);
  const responsePathFor = (spec, indexWithinModel) => spec.model === "gpt-6-sol"
    ? gpt56ResponsePaths[indexWithinModel] ?? null
    : gpt55ResponsePaths[indexWithinModel] ?? null;
  const modelIndexes = new Map();
  const candidateRuns = SOURCE_DRAFT_CANDIDATE_SPECS.map((spec) => {
    const modelIndex = modelIndexes.get(spec.model) ?? 0;
    modelIndexes.set(spec.model, modelIndex + 1);
    const stageName = `winner_source_script_v3_${spec.id}`;
    const contract = sourceDraftCandidateContract(spec, { stageName });
    const outputPath = artifactPath(path.join("drafts", `${spec.id}.txt`));
    const prompt = `${common}\n\nPORTFOLIO ASSIGNMENT ${spec.id}: ${draftLensInstruction(spec.creative_lens)} Work independently in a fresh context. Do not compare against, anticipate, or imitate another candidate.`;
    return {
      spec,
      contract,
      prompt,
      outputPath,
      responsePath: responsePathFor(spec, modelIndex),
      run: () => modelResponse({
        id: spec.id,
        prompt,
        stageName,
        provider: spec.provider,
        responsePath: responsePathFor(spec, modelIndex),
        directOutputPath: outputPath,
        timeout: positiveInteger(flags["draft-timeout-ms"], 3_600_000),
        expectedContract: contract,
      }),
    };
  });
  await Promise.all(candidateRuns.map((candidate) => candidate.run()));

  const finalizedCandidates = await Promise.all(candidateRuns.map(async (candidate) => {
    const writerText = await readText(candidate.outputPath);
    const writerWordCount = countWords(writerText);
    const writerReceiptPath = `${candidate.outputPath}.meta.json`;
    if (!await exists(writerReceiptPath)) throw new Error(`Missing model receipt for ${candidate.spec.id}: ${writerReceiptPath}`);
    const writerOutputSha256 = await fileSha256(candidate.outputPath);
    const text = writerText;
    const outputPath = candidate.outputPath;
    const receiptPath = writerReceiptPath;
    const wordCount = writerWordCount;
    if (wordCount < 1) throw new Error(`${candidate.spec.id} is empty.`);
    const outputSha256 = writerOutputSha256;
    return {
      portfolioCandidate: {
      id: candidate.spec.id,
      blind_id: candidate.spec.blind_id,
      provider: candidate.contract.provider,
      model: candidate.contract.model,
      reasoning_effort: candidate.contract.reasoning_effort,
      visible_effort: candidate.contract.visible_effort,
      transport: candidate.contract.transport_requirement,
      creative_lens: candidate.spec.creative_lens,
      prompt_sha256: sha256Text(candidate.prompt),
      writer_output_path: candidate.outputPath,
      writer_output_sha256: writerOutputSha256,
      writer_receipt_path: writerReceiptPath,
      writer_receipt_sha256: await fileSha256(writerReceiptPath),
      writer_word_count: writerWordCount,
      output_path: outputPath,
      output_sha256: outputSha256,
      receipt_path: receiptPath,
      receipt_sha256: await fileSha256(receiptPath),
      word_count: wordCount,
        word_count_target: { minimum: 9_500, maximum: 10_500, enforcement: "advisory" },
        word_count_status: wordCount < 9_500 ? "below_target" : wordCount > 10_500 ? "above_target" : "within_target",
      },
      blindId: candidate.spec.blind_id,
      blindedDraft: {
        text,
        path: outputPath,
        sha256: outputSha256,
        word_count: wordCount,
        source_id: candidate.spec.id,
      },
    };
  }));
  const portfolioCandidates = finalizedCandidates.map((row) => row.portfolioCandidate);
  const blindedDrafts = Object.fromEntries(finalizedCandidates.map((row) => [row.blindId, row.blindedDraft]));
  const portfolioDocument = {
    schema: LONGFORM_DRAFT_PORTFOLIO_SCHEMA,
    status: "completed",
    package_sha256: room.packageSha256,
    architecture_sha256: room.architecture.sha256,
    story_truth_ir_sha256: room.storyTruthIr.sha256,
    writer_packet_sha256: room.writerPacket.sha256,
    blind_seed_sha256: sha256Text(room.evidence.roomContract.draft_blind_seed),
    candidate_count: portfolioCandidates.length,
    candidates: portfolioCandidates,
    completed_at: new Date().toISOString(),
  };
  assertValid(FILES.draftPortfolio, validateLongformDraftPortfolio(portfolioDocument, {
    packageSha256: room.packageSha256,
    architectureSha256: room.architecture.sha256,
    storyTruthIrSha256: room.storyTruthIr.sha256,
    writerPacketSha256: room.writerPacket.sha256,
    expectedCandidates: SOURCE_DRAFT_CANDIDATE_SPECS,
  }));
  const portfolioPath = artifactPath(FILES.draftPortfolio);
  if (!await exists(portfolioPath)) await writeJsonExclusive(portfolioPath, portfolioDocument);
  const portfolio = await validatedJson(FILES.draftPortfolio, validateLongformDraftPortfolio, {
    packageSha256: room.packageSha256,
    architectureSha256: room.architecture.sha256,
    storyTruthIrSha256: room.storyTruthIr.sha256,
    writerPacketSha256: room.writerPacket.sha256,
    expectedCandidates: SOURCE_DRAFT_CANDIDATE_SPECS,
  });

  const selectorTemplate = await promptTemplate(PROMPTS.longformSelector);
  const ownChannelApvCalibration = {
    observed_uploads: (room.packageOutliers?.document?.entries ?? [])
      .filter((entry) => entry?.source_type === "own_channel")
      .map((entry) => ({
        entry_id: entry.entry_id,
        title: entry.title,
        performance_signal: entry.performance_signal,
      })),
    retention_claims: (room.evidence?.document?.claims ?? [])
      .filter((claim) => claim?.claim_id === "own_retention_favors_transaction_and_changed_state"),
    forecasting_rule: "Rank only by predicted APV. Anchor absolute predictions to observed own-channel APV; do not reward or punish manuscript length.",
  };
  const selectorManifest = portfolio.document.candidates.map((candidate) => ({
    id: candidate.blind_id,
    sha256: candidate.output_sha256,
  }));
  let selectorPrompt = selectorTemplate.text
    + embedded("LLM-AUTHORED BINDING STORY WRITER PACKET", room.writerPacket.document)
    + embedded("OWN-CHANNEL APV CALIBRATION EVIDENCE", ownChannelApvCalibration)
    + embedded("BLINDED DRAFT MANIFEST", selectorManifest);
  for (const candidate of selectorManifest) {
    selectorPrompt += embedded(`BLINDED DRAFT ${candidate.id} EXACT TEXT`, blindedDrafts[candidate.id].text);
  }
  selectorPrompt += `\n\nUse package_sha256 ${room.packageSha256} and architecture_sha256 ${room.architecture.sha256}. Return all six blind IDs and exact hashes from the manifest. Author/model identities are intentionally withheld. approved_transplants must be an empty array so the winner can be materialized byte-for-byte.`;
  const selection = await materializeModelJson({
    fileName: FILES.draftSelection,
    validator: validateLongformDraftSelection,
    validatorOptions: {
      packageSha256: room.packageSha256,
      architectureSha256: room.architecture.sha256,
      expectedDrafts: blindedDrafts,
      requireOpeningVerdicts: true,
      requireRankings: true,
    },
    call: () => modelResponse({
      id: "longform_draft_selection_v2_blind",
      prompt: selectorPrompt,
      stageName: "winner_source_longform_draft_selection_v2_blind",
      provider: "gemini_web",
      responsePath: flags["selector-response-path"],
      timeout: positiveInteger(flags["selector-timeout-ms"], 1_800_000),
    }),
  });
  if (selection.document.status !== "selected") throw new Error("Blinded longform selector rejected all six drafts.");
  if ((selection.document.approved_transplants ?? []).length) throw new Error("Longform selector returned transplants; byte-for-byte materialization requires none.");
  const selected = blindedDrafts[selection.document.selected_draft_id];
  const initialPath = artifactPath(FILES.initialScript);
  if (!await exists(initialPath)) await writeExclusive(initialPath, await readBytes(selected.path));
  else if (await fileSha256(initialPath) !== selected.sha256) throw new Error("Existing initial_selected_script.txt does not match the selected portfolio draft hash.");
  printResult({
    status: "passed",
    portfolio_path: portfolio.path,
    draft_paths: Object.fromEntries(Object.entries(blindedDrafts).map(([id, draft]) => [id, draft.path])),
    selection_path: selection.path,
    selected_blind_id: selection.document.selected_draft_id,
    selected_source_id: selected.source_id,
    initial_script_path: initialPath,
    ...(augustSourceQualityGatesRequired(room)
      ? { required_quality_action: "opening-audio-audition" }
      : { optional_shadow_action: "opening-audio-audition" }),
    next_action: augustSourceQualityGatesRequired(room)
      ? "opening-audio-audition"
      : "diagnose-v2",
  });
}

async function scriptV2() {
  const room = await loadArchitecture({ requireApproval: true });
  if (firstClassStoryRoom(room)) {
    await scriptFirstClassV4();
    return;
  }
  await scriptLegacyV2();
}

async function diagnoseV2() {
  const room = await loadDraftRoom();
  const scriptText = await readText(room.initialPath);
  const scriptSha256 = await fileSha256(room.initialPath);
  const nameFamiliarity = await readJson(artifactPath(FILES.nameFamiliarity)).catch(() => null);
  if (nameFamiliarity) assertValid(FILES.nameFamiliarity, validateSourceNameFamiliarityLedger(nameFamiliarity));
  const assignments = [
    { id: "causality_learning", fileName: FILES.causalityDiagnostic, promptName: PROMPTS.causalityDiagnostic, provider: "gemini_web", responseFlag: "causality-response-path" },
    { id: "promise_continuity", fileName: FILES.continuityDiagnostic, promptName: PROMPTS.continuityDiagnostic, provider: "chatgpt_web", responseFlag: "continuity-response-path" },
    { id: "narrative_authenticity", fileName: FILES.authenticityDiagnostic, promptName: PROMPTS.authenticityDiagnostic, provider: "gemini_web", responseFlag: "authenticity-response-path" },
  ];
  if (firstClassStoryRoom(room)) {
    assignments.push(
      { id: "opening_stress", fileName: FILES.openingStressDiagnostic, promptName: PROMPTS.openingStressDiagnostic, provider: "gemini_web", responseFlag: "opening-stress-response-path" },
      { id: "character_agency", fileName: FILES.characterAgencyDiagnostic, promptName: PROMPTS.characterAgencyDiagnostic, provider: "chatgpt_web", responseFlag: "character-agency-response-path" },
      { id: "anti_slop", fileName: FILES.antiSlopDiagnostic, promptName: PROMPTS.antiSlopDiagnostic, provider: "gemini_web", responseFlag: "anti-slop-response-path" },
    );
  }
  if (room.referenceMeritFrontier) assignments.push({ id: "reference_density_dominance", fileName: FILES.referenceDensityDiagnostic, promptName: PROMPTS.referenceDensityDiagnostic, provider: "chatgpt_web", responseFlag: "reference-density-response-path", densityDiagnostic: true });
  const results = await Promise.all(assignments.map(async (assignment) => {
    const template = await promptTemplate(assignment.promptName);
    const prompt = template.text
      + embedded("APPROVED PACKAGE JSON", room.candidate)
      + embedded("APPROVED STORY ARCHITECTURE JSON", room.architecture.document)
      + (room.storyTruthIr ? embedded("BINDING STORY TRUTH IR JSON", room.storyTruthIr.document) : "")
      + (room.referenceMeritFrontier ? embedded("BINDING REFERENCE MERIT FRONTIER JSON", room.referenceMeritFrontier.document) : "")
      + (nameFamiliarity ? embedded("CHANNEL SUPPORTING-NAME FAMILIARITY LEDGER", nameFamiliarity) : "")
      + embedded("EXACT SCRIPT TEXT", scriptText)
      + `\n\nBINDING SCRIPT SHA256: ${scriptSha256}`
      + (assignment.densityDiagnostic
        ? `\nThe bound frontier is the exhaustive downstream representation of the measured reference. Reuse its exact reference anchors; do not invent reference evidence outside it.\nBINDING REFERENCE SHA256: ${room.referenceSha256}\nBINDING FRONTIER SHA256: ${room.referenceMeritFrontier.sha256}\nNORMALIZATION POLICY: ${REFERENCE_DENSITY_NORMALIZATION_POLICY}\nREQUIRED DIMENSIONS: ${REFERENCE_DENSITY_DIMENSION_IDS.join(", ")}`
        : "");
    const validator = assignment.densityDiagnostic ? validateReferenceDensityDominance : validateSourceDiagnosticV2;
    const validatorOptions = assignment.densityDiagnostic
      ? { scriptText, scriptSha256, referenceText: room.referenceText, referenceSha256: room.referenceSha256, frontierSha256: room.referenceMeritFrontier.sha256, referenceMeritFrontier: room.referenceMeritFrontier.document }
      : { scriptText, scriptSha256 };
    const result = await materializeModelJson({
      fileName: assignment.fileName,
      validator,
      validatorOptions,
      call: () => modelResponse({
        id: assignment.id,
        prompt,
        stageName: `winner_source_${assignment.id}_diagnostic_v2`,
        provider: assignment.provider,
        responsePath: flags[assignment.responseFlag],
      }),
      normalizeDocument: assignment.densityDiagnostic
        ? (document) => bindReferenceDensityAnchors(document, { scriptText, referenceText: room.referenceText })
        : null,
    });
    if (!assignment.densityDiagnostic && result.document.diagnostic_id !== assignment.id) throw new Error(`${assignment.id} diagnostic returned the wrong ID.`);
    return result;
  }));
  printResult({ status: "passed", diagnostic_paths: results.map((result) => result.path), accepted_finding_counts: Object.fromEntries(results.map((result) => [result.document.diagnostic_id ?? "reference_density_dominance", result.validation.accepted_findings.length])), next_action: "revise-v2" });
}

function parseFindingIds(value) {
  return [...new Set(String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function parseRevisionResponse(content) {
  const marker = "===REVISION_LEDGER===";
  const index = String(content).indexOf(marker);
  if (index < 0) throw new Error(`Revision response is missing ${marker}.`);
  const script = String(content).slice(0, index).trim();
  const ledger = parseModelJson(String(content).slice(index + marker.length), "revision ledger");
  if (!script) throw new Error("Revision response has no revised script before the ledger marker.");
  return { script, ledger };
}

function parseNarrationRevisionResponse(content) {
  const marker = "===NARRATION_REVISION_LEDGER===";
  const index = String(content).indexOf(marker);
  if (index < 0) throw new Error(`Narration revision response is missing ${marker}.`);
  const script = String(content).slice(0, index).trim();
  const ledger = parseModelJson(String(content).slice(index + marker.length), "narration revision ledger");
  if (!script) throw new Error("Narration revision response has no polished script before the ledger marker.");
  return { script, ledger };
}

async function reviseV2() {
  const room = await loadDiagnostics();
  const ledgerPath = artifactPath(FILES.revisionLedger);
  const revisedPath = artifactPath(FILES.revisedScript);
  const allFindings = [
    ...room.causality.validation.accepted_findings,
    ...room.continuity.validation.accepted_findings,
    ...room.authenticity.validation.accepted_findings,
    ...(room.openingStress?.validation.accepted_findings ?? []),
    ...(room.characterAgency?.validation.accepted_findings ?? []),
    ...(room.antiSlop?.validation.accepted_findings ?? []),
    ...(room.referenceDensity?.validation.accepted_findings ?? []),
  ];
  const allIds = allFindings.map((finding) => finding.id);
  if (await exists(ledgerPath)) {
    if (!await exists(revisedPath)) throw new Error("Revision ledger exists without script_revised.txt.");
    const revisedText = await readText(revisedPath);
    const revisedSha256 = await fileSha256(revisedPath);
    const existing = await readJson(ledgerPath);
    const validation = validateSourceRevisionLedger(existing, {
      sourceScriptSha256: room.scriptSha256,
      revisedScriptSha256: revisedSha256,
      acceptedFindingIds: allIds,
      sourceScriptText: room.scriptText,
      revisedScriptText: revisedText,
    });
    if (validation.done) {
      if (isTrue(flags["exact-repair"])) throw new Error("A passed revision already exists; exact repair may not overwrite it.");
      printResult({ status: "passed", revised_script_path: revisedPath, revision_ledger_path: ledgerPath, resumed: true, next_action: firstClassStoryRoom(room) ? "narration-revise-v2" : "accept-v2" });
      return;
    }
    const requested = parseFindingIds(flags["finding-ids"] ?? flags["finding-id"]);
    if (!isTrue(flags["exact-repair"]) || requested.length < 1) {
      throw new Error(`Revision ledger is blocked (${validation.blockers.join(", ")}); exact repair requires --exact-repair true --finding-ids <ids>.`);
    }
    for (const id of requested) if (!allIds.includes(id)) throw new Error(`Unknown exact repair finding ID: ${id}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.rename(ledgerPath, `${ledgerPath}.blocked-${stamp}`);
    await fs.rename(revisedPath, `${revisedPath}.blocked-${stamp}`);
  }

  const requestedIds = isTrue(flags["exact-repair"])
    ? parseFindingIds(flags["finding-ids"] ?? flags["finding-id"])
    : allIds;
  if (isTrue(flags["exact-repair"]) && requestedIds.length < 1) throw new Error("Exact repair requires --finding-ids <ids>.");
  const selectedFindings = allFindings.filter((finding) => requestedIds.includes(finding.id));
  if (selectedFindings.length !== requestedIds.length) throw new Error("One or more exact repair finding IDs are invalid.");

  if (selectedFindings.length === 0) {
    await writeExclusive(revisedPath, await readBytes(room.initialPath));
    const revisedSha256 = await fileSha256(revisedPath);
    const ledger = { schema: "goldflow_source_revision_ledger_v1", status: "revised", source_script_sha256: room.scriptSha256, revised_script_sha256: revisedSha256, entries: [] };
    assertValid(FILES.revisionLedger, validateSourceRevisionLedger(ledger, {
      sourceScriptSha256: room.scriptSha256,
      revisedScriptSha256: revisedSha256,
      acceptedFindingIds: [],
      sourceScriptText: room.scriptText,
      revisedScriptText: room.scriptText,
    }));
    await writeJsonExclusive(ledgerPath, ledger);
    printResult({ status: "passed", revised_script_path: revisedPath, revision_ledger_path: ledgerPath, revision_kind: "no_findings_byte_copy", next_action: firstClassStoryRoom(room) ? "narration-revise-v2" : "accept-v2" });
    return;
  }

  const template = await promptTemplate(PROMPTS.revision);
  const prompt = template.text
    + embedded("APPROVED PACKAGE JSON", room.candidate)
    + embedded("APPROVED STORY ARCHITECTURE JSON", room.architecture.document)
    + (room.storyTruthIr ? embedded("BINDING STORY TRUTH IR JSON", room.storyTruthIr.document) : "")
    + embedded("ACCEPTED EXACT-ANCHOR FINDINGS JSON", selectedFindings)
    + (room.referenceMeritFrontier ? embedded("BINDING REFERENCE MERIT FRONTIER JSON", room.referenceMeritFrontier.document) : "")
    + (room.referenceDensity ? embedded("REFERENCE DENSITY DIAGNOSTIC JSON", room.referenceDensity.document) : "")
    + embedded("EXACT CURRENT SCRIPT", room.scriptText)
    + `\n\nThe bound frontier and density diagnostic are the exhaustive downstream representation of the measured reference. Preserve their exact viewer appetites and repair obligations without copying reference story facts.\nBINDING SOURCE SCRIPT SHA256: ${room.scriptSha256}. Preserve 9500-10500 words.`;
  const response = await modelResponse({
    id: isTrue(flags["exact-repair"]) ? `developmental_revision_exact_${sha256Text(requestedIds.join(",")).slice(0, 12)}` : "developmental_revision",
    prompt,
    stageName: "winner_source_revise_v2",
    provider: "chatgpt_web",
    responsePath: flags["response-path"],
    timeout: positiveInteger(flags["revision-timeout-ms"], 3_600_000),
  });
  const parsed = parseRevisionResponse(response.content);
  const words = countWords(parsed.script);
  if (words < 1) throw new Error("Revised script is empty.");
  const scriptBytes = Buffer.from(`${parsed.script.trim()}\n`, "utf8");
  const revisedSha256 = sha256(scriptBytes);
  parsed.ledger.source_script_sha256 = room.scriptSha256;
  parsed.ledger.revised_script_sha256 = revisedSha256;
  assertValid(FILES.revisionLedger, validateSourceRevisionLedger(parsed.ledger, {
    sourceScriptSha256: room.scriptSha256,
    revisedScriptSha256: revisedSha256,
    acceptedFindingIds: requestedIds,
    sourceScriptText: room.scriptText,
    revisedScriptText: parsed.script,
  }));
  await writeExclusive(revisedPath, scriptBytes);
  await writeJsonExclusive(ledgerPath, parsed.ledger);
  printResult({ status: "passed", revised_script_path: revisedPath, revised_script_sha256: revisedSha256, revision_ledger_path: ledgerPath, repaired_finding_ids: requestedIds, next_action: firstClassStoryRoom(room) ? "narration-revise-v2" : "accept-v2" });
}

async function narrationReviseV2() {
  const room = await loadRevision();
  if (!firstClassStoryRoom(room)) throw new Error("narration-revise-v2 is available only for first_class_story_room_v4 rooms.");
  const polishedPath = artifactPath(FILES.narrationPolishedScript);
  const ledgerPath = artifactPath(FILES.narrationRevisionLedger);
  if (await exists(polishedPath) || await exists(ledgerPath)) {
    if (!await exists(polishedPath) || !await exists(ledgerPath)) throw new Error("Partial narration revision artifact; refusing overwrite.");
    const polishedText = await readText(polishedPath);
    const validation = validateNarrationRevisionLedger(await readJson(ledgerPath), {
      sourceScriptSha256: room.revisedSha256,
      polishedScriptSha256: await fileSha256(polishedPath),
      storyTruthIrSha256: room.storyTruthIr.sha256,
      sourceWordCount: countWords(room.revisedText),
      polishedWordCount: countWords(polishedText),
    });
    assertValid(FILES.narrationRevisionLedger, validation);
    printResult({ status: "passed", narration_polished_script_path: polishedPath, narration_revision_ledger_path: ledgerPath, resumed: true, next_action: "story-map-v2" });
    return;
  }
  const template = await promptTemplate(PROMPTS.narrationRevision);
  const prompt = template.text
    + embedded("BINDING STORY TRUTH IR JSON", room.storyTruthIr.document)
    + embedded("EXACT DEVELOPMENTALLY REVISED SCRIPT", room.revisedText)
    + `\n\nBINDING SOURCE SCRIPT SHA256: ${room.revisedSha256}. BINDING STORY TRUTH IR SHA256: ${room.storyTruthIr.sha256}.`;
  const response = await modelResponse({
    id: "narration_revision_v1",
    prompt,
    stageName: "winner_source_narration_revision_v1",
    provider: "chatgpt_web",
    responsePath: flags["response-path"],
    timeout: positiveInteger(flags["revision-timeout-ms"], 3_600_000),
  });
  const parsed = parseNarrationRevisionResponse(response.content);
  const sourceWordCount = countWords(room.revisedText);
  const polishedWordCount = countWords(parsed.script);
  const polishedBytes = Buffer.from(`${parsed.script.trim()}\n`, "utf8");
  const polishedSha256 = sha256(polishedBytes);
  parsed.ledger.source_script_sha256 = room.revisedSha256;
  parsed.ledger.polished_script_sha256 = polishedSha256;
  parsed.ledger.story_truth_ir_sha256 = room.storyTruthIr.sha256;
  parsed.ledger.source_word_count = sourceWordCount;
  parsed.ledger.polished_word_count = polishedWordCount;
  for (const [index, change] of (parsed.ledger.changes ?? []).entries()) {
    if (!room.revisedText.includes(String(change?.source_anchor ?? ""))) throw new Error(`Narration revision change ${index} source anchor is not exact.`);
    if (!parsed.script.includes(String(change?.polished_anchor ?? ""))) throw new Error(`Narration revision change ${index} polished anchor is not exact.`);
  }
  assertValid(FILES.narrationRevisionLedger, validateNarrationRevisionLedger(parsed.ledger, {
    sourceScriptSha256: room.revisedSha256,
    polishedScriptSha256: polishedSha256,
    storyTruthIrSha256: room.storyTruthIr.sha256,
    sourceWordCount,
    polishedWordCount,
  }));
  await writeExclusive(polishedPath, polishedBytes);
  await writeJsonExclusive(ledgerPath, parsed.ledger);
  printResult({ status: "passed", narration_polished_script_path: polishedPath, narration_polished_script_sha256: polishedSha256, narration_revision_ledger_path: ledgerPath, next_action: "story-map-v2" });
}

async function storyMapV2() {
  const room = await loadFinalScriptRoom();
  if (!firstClassStoryRoom(room)) throw new Error("story-map-v2 is available only for first_class_story_room_v4 rooms.");
  const template = await promptTemplate(PROMPTS.storyTruthScriptMap);
  const prompt = template.text
    + embedded("BINDING STORY TRUTH IR JSON", room.storyTruthIr.document)
    + embedded("EXACT FINAL NARRATION SCRIPT", room.revisedText)
    + `\n\nBINDING STORY TRUTH IR SHA256: ${room.storyTruthIr.sha256}. BINDING SCRIPT SHA256: ${room.revisedSha256}.`;
  const result = await materializeModelJson({
    fileName: FILES.storyTruthScriptMap,
    validator: validateStoryTruthScriptMap,
    validatorOptions: {
      storyTruthIr: room.storyTruthIr.document,
      storyTruthIrSha256: room.storyTruthIr.sha256,
      scriptText: room.revisedText,
      scriptSha256: room.revisedSha256,
    },
    call: () => modelResponse({
      id: "story_truth_script_map_v2",
      prompt,
      stageName: "winner_source_story_truth_script_map_v2",
      provider: "gemini_web",
      responsePath: flags["response-path"],
    }),
  });
  printResult({ status: "passed", story_truth_script_map_path: result.path, story_truth_script_map_sha256: result.sha256, next_action: "accept-v2" });
}

async function acceptV2() {
  const room = await loadMappedFinalScriptRoom();
  const template = await promptTemplate(PROMPTS.acceptance);
  const prompt = template.text
    + embedded("APPROVED PACKAGE JSON", room.candidate)
    + embedded("APPROVED STORY ARCHITECTURE JSON", room.architecture.document)
    + (room.storyTruthIr ? embedded("BINDING STORY TRUTH IR JSON", room.storyTruthIr.document) : "")
    + (room.storyTruthScriptMap ? embedded("BINDING STORY TRUTH SCRIPT MAP JSON", room.storyTruthScriptMap.document) : "")
    + embedded("REVISION LEDGER JSON", room.revisionLedger.document)
    + (room.narrationRevisionLedger ? embedded("NARRATION REVISION LEDGER JSON", room.narrationRevisionLedger.document) : "")
    + (room.referenceMeritFrontier ? embedded("BINDING REFERENCE MERIT FRONTIER JSON", room.referenceMeritFrontier.document) : "")
    + (room.referenceDensity ? embedded("PRE-REVISION REFERENCE DENSITY DIAGNOSTIC JSON", room.referenceDensity.document) : "")
    + embedded("EXACT REVISED SCRIPT", room.revisedText)
    + `\n\nBINDING SCRIPT SHA256: ${room.revisedSha256}`
    + (room.referenceMeritFrontier
      ? `\nThe bound frontier is the exhaustive downstream representation of the measured reference. Reuse its exact reference anchors; do not invent reference evidence outside it.\nBINDING REFERENCE SHA256: ${room.referenceSha256}\nBINDING FRONTIER SHA256: ${room.referenceMeritFrontier.sha256}\nBINDING PRE-REVISION DENSITY DIAGNOSTIC SHA256: ${room.referenceDensity.sha256}\nRejudge every frontier dimension and material edge against the revised script. Acceptance requires candidate_win on all ${REFERENCE_DENSITY_DIMENSION_IDS.length} dimensions and every edge after normalization; raw runtime and raw event totals do not count.`
      : "");
  const acceptance = await materializeModelJson({
    fileName: FILES.semanticAcceptance,
    validator: validateSourceSemanticAcceptance,
    validatorOptions: {
      scriptText: room.revisedText,
      scriptSha256: room.revisedSha256,
      requireDramaticOpeningAcceptance: hasDramaticColdOpenContract(room.architecture.document),
      requireReferenceDensityDominance: Boolean(room.referenceMeritFrontier),
      referenceText: room.referenceText ?? "",
      referenceSha256: room.referenceSha256 ?? null,
      referenceMeritFrontierSha256: room.referenceMeritFrontier?.sha256 ?? null,
      referenceDensityDiagnosticSha256: room.referenceDensity?.sha256 ?? null,
      referenceMeritFrontier: room.referenceMeritFrontier?.document ?? null,
      requireColdListenerComprehension: true,
    },
    call: () => modelResponse({
      id: "source_semantic_acceptance",
      prompt,
      stageName: "winner_source_semantic_acceptance_audit",
      provider: "gemini_web",
      responsePath: flags["response-path"],
    }),
    normalizeDocument: (document) => bindSourceSemanticAcceptanceAnchors(document, {
      scriptText: room.revisedText,
      referenceText: room.referenceText ?? "",
    }),
  });
  if (acceptance.document.status !== "accepted") {
    printResult({ status: "repair", acceptance_path: acceptance.path, anchored_failures: acceptance.validation.valid_failures.length, next_action: "operator triage; no automatic second revision" });
    throw new Error("Semantic acceptance requires repair; no automatic rewrite loop was started.");
  }
  const finalApproval = await writeApproval({ fileName: FILES.finalApproval, stageId: "final_script", sourceSha256: room.revisedSha256, selectedId: null });
  printResult({
    status: "passed",
    acceptance_path: acceptance.path,
    final_script_approval_path: finalApproval.path,
    final_script_sha256: room.revisedSha256,
    next_action: augustSourceQualityGatesRequired(room)
      ? "mixed-viewer-panel"
      : viewerTournamentRequiredForRoom(room) ? "viewer-tournament" : "release-v2",
  });
}

async function releaseV2() {
  const room = await loadMappedFinalScriptRoom();
  const acceptance = await validatedJson(FILES.semanticAcceptance, validateSourceSemanticAcceptance, {
    scriptText: room.revisedText,
    scriptSha256: room.revisedSha256,
    requireDramaticOpeningAcceptance: hasDramaticColdOpenContract(room.architecture.document),
    requireReferenceDensityDominance: Boolean(room.referenceMeritFrontier),
    referenceText: room.referenceText ?? "",
    referenceSha256: room.referenceSha256 ?? null,
    referenceMeritFrontierSha256: room.referenceMeritFrontier?.sha256 ?? null,
    referenceDensityDiagnosticSha256: room.referenceDensity?.sha256 ?? null,
    referenceMeritFrontier: room.referenceMeritFrontier?.document ?? null,
    requireColdListenerComprehension: Boolean(room.architecture.document?.mechanic_comprehension_contract),
  });
  if (acceptance.document.status !== "accepted") throw new Error("Final semantic acceptance is not accepted.");
  const finalApproval = await validatedJson(FILES.finalApproval, validateSourceStageApproval, { stageId: "final_script", sourceSha256: room.revisedSha256, selectedId: null });
  const viewerTournament = viewerTournamentRequiredForRoom(room)
    ? await loadViewerTournamentAcceptance(room)
    : null;
  const openingAudioAudition = augustSourceQualityGatesRequired(room)
    ? await loadOpeningAudioAuditionGate(room)
    : null;
  const mixedViewerPanel = augustSourceQualityGatesRequired(room)
    ? await loadMixedViewerPanelGate(room)
    : null;
  const sourceRoomContractPath = room.evidence.roomContractPath;
  const sourceRoomContractSha256 = sourceRoomContractPath
    ? await fileSha256(sourceRoomContractPath)
    : null;
  const outputPath = artifactPath(FILES.release);
  const diagnosticSha256s = {
    causality_learning: room.causality.sha256,
    promise_continuity: room.continuity.sha256,
    narrative_authenticity: room.authenticity.sha256,
    ...(room.openingStress ? { opening_stress: room.openingStress.sha256 } : {}),
    ...(room.characterAgency ? { character_agency: room.characterAgency.sha256 } : {}),
    ...(room.antiSlop ? { anti_slop: room.antiSlop.sha256 } : {}),
    ...(room.referenceDensity ? { reference_density_dominance: room.referenceDensity.sha256 } : {}),
  };
  const diagnosticPaths = {
    causality_learning: room.causality.path,
    promise_continuity: room.continuity.path,
    narrative_authenticity: room.authenticity.path,
    ...(room.openingStress ? { opening_stress: room.openingStress.path } : {}),
    ...(room.characterAgency ? { character_agency: room.characterAgency.path } : {}),
    ...(room.antiSlop ? { anti_slop: room.antiSlop.path } : {}),
    ...(room.referenceDensity ? { reference_density_dominance: room.referenceDensity.path } : {}),
  };
  const firstClassArtifactPaths = firstClassStoryRoom(room) ? {
    ...(room.premiseMovieDiscovery ? {
      premise_movie_slate_a: artifactPath(FILES.premiseMovieSlateA),
      premise_movie_slate_b: artifactPath(FILES.premiseMovieSlateB),
      premise_movie_pool: room.premiseMovieDiscovery.poolPath,
      premise_movie_selection: room.premiseMovieDiscovery.selectionPath,
      ...(room.premiseMoviePromotion ? { premise_movie_operator_promotion: room.premiseMoviePromotion.path } : {}),
      ...(room.packageOperatorRevision ? { package_operator_revision: room.packageOperatorRevision.path } : {}),
    } : {}),
    premise_slate_gpt: artifactPath(FILES.premiseSlateGpt),
    premise_slate_gemini: artifactPath(FILES.premiseSlateGemini),
    premise_pool: artifactPath(FILES.premisePool),
    premise_blind_selection: artifactPath(FILES.premiseBlindSelection),
    premise_finalist_lineage: artifactPath(FILES.premiseFinalistLineage),
    story_truth_ir: room.storyTruthIr.path,
    story_truth_audit: room.storyTruthAudit.path,
    story_truth_script_map: room.storyTruthScriptMap.path,
    longform_draft_portfolio: room.draftPortfolio.path,
    developmental_revised_script: room.developmentalRevisedPath,
    narration_revision_ledger: room.narrationRevisionLedger.path,
  } : null;
  const firstClassArtifactSha256s = firstClassArtifactPaths
    ? Object.fromEntries(await Promise.all(Object.entries(firstClassArtifactPaths).map(async ([id, filePath]) => [id, await fileSha256(filePath)])))
    : null;
  const release = {
    schema: "goldflow_source_room_release_v2",
    status: "released",
    source_workflow_profile: EVIDENCE_STORY_ROOM_PROFILE,
    ...(room.evidence.roomContract ? {
      source_room_profile: room.evidence.roomContract.profile,
      source_room_contract_path: sourceRoomContractPath,
      source_room_contract_sha256: sourceRoomContractSha256,
    } : {}),
    channel,
    development_slug: developmentSlug || path.basename(developmentDirectory()),
    selected_title: room.candidate.title,
    final_script_path: room.revisedPath,
    final_script_sha256: room.revisedSha256,
    evidence_registry_path: room.evidence.path,
    evidence_registry_sha256: room.evidence.sha256,
    premise_slate_path: room.slate.path,
    premise_slate_sha256: room.slate.sha256,
    package_selection_path: room.selection.path,
    package_selection_sha256: room.selection.sha256,
    package_selection_approval_path: room.approval.path,
    package_selection_approval_sha256: room.approval.sha256,
    treatment_bakeoff_path: room.bakeoff.path,
    treatment_bakeoff_sha256: room.bakeoff.sha256,
    treatment_selection_path: room.treatmentSelection.path,
    treatment_selection_sha256: room.treatmentSelection.sha256,
    treatment_selection_approval_path: room.treatmentApproval.path,
    treatment_selection_approval_sha256: room.treatmentApproval.sha256,
    architecture_path: room.architecture.path,
    architecture_sha256: room.architecture.sha256,
    name_familiarity_ledger_path: artifactPath(FILES.nameFamiliarity),
    name_familiarity_ledger_sha256: await fileSha256(artifactPath(FILES.nameFamiliarity)),
    architecture_redteam_path: room.architectureRedteam.path,
    architecture_redteam_sha256: room.architectureRedteam.sha256,
    architecture_approval_path: room.architectureApproval.path,
    architecture_approval_sha256: room.architectureApproval.sha256,
    longform_draft_selection_path: room.draftSelection.path,
    longform_draft_selection_sha256: room.draftSelection.sha256,
    ...(room.referenceMeritFrontier ? {
      reference_path: room.referencePath,
      reference_sha256: room.referenceSha256,
      reference_receipt_path: room.referenceReceiptPath,
      reference_receipt_sha256: room.referenceReceiptSha256,
      reference_merit_frontier_path: room.referenceMeritFrontier.path,
      reference_merit_frontier_sha256: room.referenceMeritFrontier.sha256,
    } : {}),
    diagnostic_sha256s: diagnosticSha256s,
    diagnostic_paths: diagnosticPaths,
    ...(firstClassArtifactPaths ? {
      first_class_artifact_paths: firstClassArtifactPaths,
      first_class_artifact_sha256s: firstClassArtifactSha256s,
      post_upload_learning_contract: {
        schema: "goldflow_post_upload_story_learning_contract_v1",
        status: "pending_observation",
        observation_windows: ["24h", "72h", "7d"],
        policy: "Retention is mapped to exact narration passages and Story Truth functions; one upload never changes defaults automatically.",
      },
    } : {}),
    character_name_usage: (room.architecture.document.character_name_plan ?? []).map((row) => ({
      name: row.name,
      role: row.role,
      reuse_disposition: row.reuse_disposition,
    })),
    revision_ledger_path: room.revisionLedger.path,
    revision_ledger_sha256: room.revisionLedger.sha256,
    semantic_acceptance_path: acceptance.path,
    semantic_acceptance_sha256: acceptance.sha256,
    final_script_approval_path: finalApproval.path,
    final_script_approval_sha256: finalApproval.sha256,
    ...(viewerTournament ? {
      viewer_tournament_acceptance_path: viewerTournament.path,
      viewer_tournament_acceptance_sha256: viewerTournament.sha256,
      viewer_tournament_manifest_path: viewerTournament.manifestPath,
      viewer_tournament_manifest_sha256: viewerTournament.manifestSha256,
      viewer_tournament_report_sha256s: viewerTournament.reportSha256s,
    } : {}),
    ...(openingAudioAudition ? {
      opening_audio_audition_manifest_path: openingAudioAudition.manifestPath,
      opening_audio_audition_manifest_sha256: openingAudioAudition.manifestSha256,
      opening_audio_audition_review_path: openingAudioAudition.reviewPath,
      opening_audio_audition_review_sha256: openingAudioAudition.reviewSha256,
    } : {}),
    ...(mixedViewerPanel ? {
      mixed_viewer_panel_mode: mixedViewerPanel.mode,
      mixed_viewer_panel_manifest_path: mixedViewerPanel.manifestPath,
      mixed_viewer_panel_manifest_sha256: mixedViewerPanel.manifestSha256,
      mixed_viewer_panel_aggregate_path: mixedViewerPanel.aggregatePath,
      mixed_viewer_panel_aggregate_sha256: mixedViewerPanel.aggregateSha256,
      mixed_viewer_calibration_policy_path: mixedViewerPanel.calibrationPolicyPath,
      mixed_viewer_calibration_policy_sha256: mixedViewerPanel.calibrationPolicySha256,
      mixed_viewer_panel_report_sha256s: mixedViewerPanel.reportSha256s,
    } : {}),
    released_at: new Date().toISOString(),
  };
  const validationOptions = {
    finalScriptSha256: room.revisedSha256,
    packageSelectionSha256: room.selection.sha256,
    packageSelectionApprovalSha256: room.approval.sha256,
    treatmentSelectionSha256: room.treatmentSelection.sha256,
    treatmentSelectionApprovalSha256: room.treatmentApproval.sha256,
    architectureSha256: room.architecture.sha256,
    architectureApprovalSha256: room.architectureApproval.sha256,
    longformDraftSelectionSha256: room.draftSelection.sha256,
    diagnosticSha256s,
    revisionLedgerSha256: room.revisionLedger.sha256,
    semanticAcceptanceSha256: acceptance.sha256,
    finalScriptApprovalSha256: finalApproval.sha256,
    referenceMeritFrontierSha256: room.referenceMeritFrontier?.sha256 ?? null,
    referenceSha256: room.referenceSha256 ?? null,
    viewerTournamentAcceptanceSha256: viewerTournament?.sha256 ?? null,
    viewerTournamentManifestSha256: viewerTournament?.manifestSha256 ?? null,
    viewerTournamentReportSha256s: viewerTournament?.reportSha256s ?? null,
    requireViewerTournamentAcceptance: viewerTournamentRequiredForRoom(room),
    requireAugustSourceQualityGates: augustSourceQualityGatesRequired(room),
    openingAudioAuditionManifestSha256: openingAudioAudition?.manifestSha256 ?? null,
    openingAudioAuditionReviewSha256: openingAudioAudition?.reviewSha256 ?? null,
    mixedViewerPanelManifestSha256: mixedViewerPanel?.manifestSha256 ?? null,
    mixedViewerPanelAggregateSha256: mixedViewerPanel?.aggregateSha256 ?? null,
    mixedViewerCalibrationPolicySha256: mixedViewerPanel?.calibrationPolicySha256 ?? null,
    mixedViewerPanelReportSha256s: mixedViewerPanel?.reportSha256s ?? null,
    sourceRoomContractSha256,
    sourceRoomProfile: room.evidence.roomContract?.profile ?? null,
    requireSourceRoomContract: Boolean(room.evidence.roomContract),
    firstClassArtifactSha256s,
  };
  if (await exists(outputPath)) {
    const existing = await readJson(outputPath);
    assertValid(FILES.release, validateSourceRoomReleaseV2(existing, validationOptions));
  } else {
    assertValid(FILES.release, validateSourceRoomReleaseV2(release, validationOptions));
    await writeJsonExclusive(outputPath, release);
  }
  const series = String(flags.series || developmentSlug || path.basename(developmentDirectory())).trim();
  const week = String(flags.week ?? "<stable-run-slug>").trim();
  const episode = String(flags.episode ?? "ep_01").trim();
  const preflight = `node bin/goldflow.mjs run preflight --channel ${shellQuote(channel)} --series ${shellQuote(series)} --week ${shellQuote(week)} --episode ${shellQuote(episode)} --title ${shellQuote(room.candidate.title)} --source ${shellQuote(room.revisedPath)} --winner-release ${shellQuote(outputPath)} --production-profile fast-premium`;
  printResult({ status: "released", release_path: outputPath, release_sha256: await fileSha256(outputPath), final_script_path: room.revisedPath, production_preflight_shape: preflight });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function printResult(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`Winner Source Room V4 (legacy V1-V3 compatible)

Actions:
  evidence-registry      --registry <json>
  package-outliers       --ledger <json>
  premise-discover       [--premise-reasoning-effort medium] [three optional response paths]
  promote-premise-movie  --movie-id <blind_movie_id> --promoted-by <operator> --rationale <text> --canon-clarification <text>
  ideate-v2              [--gpt-author-response-path <json>] [--gemini-author-response-path <json>] [--selector-response-path <json>]
  package-tournament     [--gpt-response-path <json>] [--gemini-response-path <json>]
  adjudicate-package     --candidate-id <id> --adjudicated-by <operator> --rationale <text>
  revise-package-thumbnail --thumbnail-receipt <text> --revised-by <operator> --rationale <text>
  approve-package-v2     --approved-by <operator>
  reference-frontier     --reference <exact measured outlier transcript> [--reference-entry-id <ledger-id>]
  treatments             [--treatment-reasoning-effort medium] [three optional response paths]
  select-treatment       [--response-path <json>]
  approve-treatment      --approved-by <operator>
  architecture           [--architecture-reasoning-effort medium] [--response-path <json>]
  architecture-audit     [--response-path <json>]
  approve-architecture   --approved-by <operator>
  story-truth            [--story-truth-reasoning-effort medium|high] [--response-path <json>]
  story-truth-audit      [--response-path <json>]
  writer-packet          [--response-path <json>]
  script-v2              [--gpt56-response-paths <three txt paths>] [--gpt55-response-paths <three txt paths>] [--selector-response-path <json>]
  opening-audio-audition Run separately through goldflow; mandatory advisory top-two locked-narrator test
  diagnose-v2            [diagnostic response paths]
  revise-v2              [--response-path <txt>] [--exact-repair true --finding-ids <ids>]
  narration-revise-v2    [--response-path <txt>]
  story-map-v2           [--response-path <json>]
  accept-v2              --approved-by <operator> [--response-path <json>]
  release-v2             [--series <slug>] [--week <slug>] [--episode ep_01]

V4 draft portfolio:
  Three candidates use authenticated ChatGPT Web GPT-5.6 Sol at visible Pro.
  Three candidates use authenticated ChatGPT Web GPT-5.5 at visible Pro through Advanced model selection.
  A fresh Gemini context sees only blind IDs. No model substitution or cosmetic relabeling is allowed.

Final V4 viewer gate candidate:
  <development-dir>/script_narration_polished.txt

Passed artifacts are immutable. Blockers stop for exact-scope triage; there is no automatic creative rewrite loop.`);
}

const ACTIONS = {
  "evidence-registry": evidenceRegistry,
  "package-outliers": packageOutliers,
  "premise-discover": premiseDiscover,
  "promote-premise-movie": promotePremiseMovie,
  "ideate-v2": ideateV2,
  "package-tournament": packageTournament,
  "adjudicate-package": adjudicatePackage,
  "revise-package-thumbnail": revisePackageThumbnail,
  "approve-package-v2": approvePackageV2,
  "reference-frontier": referenceFrontier,
  treatments,
  "select-treatment": selectTreatment,
  "approve-treatment": approveTreatment,
  architecture,
  "architecture-audit": architectureAudit,
  "approve-architecture": approveArchitecture,
  "story-truth": storyTruth,
  "story-truth-audit": storyTruthAudit,
  "writer-packet": writerPacket,
  "script-v2": scriptV2,
  "diagnose-v2": diagnoseV2,
  "revise-v2": reviseV2,
  "narration-revise-v2": narrationReviseV2,
  "story-map-v2": storyMapV2,
  "accept-v2": acceptV2,
  "release-v2": releaseV2,
  help: async () => printHelp(),
};

async function main() {
  const handler = ACTIONS[action];
  if (!handler) {
    printHelp();
    throw new Error(`Unknown action: ${action}`);
  }
  if (action !== "help") await fs.mkdir(developmentDirectory(), { recursive: true });
  await handler();
}

main().catch((error) => {
  console.error(`winner-source-room-v2: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
