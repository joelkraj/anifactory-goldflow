#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexCli } from "./lib/codex-cli-runner.mjs";
import { parseJsonObjectFromPlannerOutput } from "./lib/json-output-repair.mjs";
import {
  sourceModelContract,
  validateSourceModelReceipt,
} from "./lib/source-model-policy.mjs";
import {
  EVIDENCE_STORY_ROOM_PROFILE,
  REFERENCE_DENSITY_ROOM_PROFILE_V1,
  REFERENCE_DENSITY_ROOM_PROFILE_V2,
  REFERENCE_DENSITY_ROOM_PROFILE_V3,
  REFERENCE_DENSITY_NORMALIZATION_POLICY,
  REFERENCE_DENSITY_DIMENSION_IDS,
  bindReferenceDensityAnchors,
  bindReferenceMeritFrontierAnchors,
  bindSourceSemanticAcceptanceAnchors,
  hasDramaticColdOpenContract,
  PACKAGE_ADJUDICATION_SCHEMA,
  SOURCE_STAGE_APPROVAL_SCHEMA,
  sha256CanonicalJson,
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
  buildSourceNameFamiliarityLedgerFromDisk,
  continuationExemptNameFamiliarityLedger,
  titleSignalsContinuation,
  validateSourceNameFamiliarityLedger,
} from "./lib/source-name-familiarity.mjs";
import { validateViewerTournamentAcceptance } from "./lib/source-viewer-tournament-contract.mjs";

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
  premiseSlate: "premise_slate_v2.json",
  premiseSelection: "premise_selection_v2.json",
  packageTournamentGpt: "package_tournament_gpt.json",
  packageTournamentGemini: "package_tournament_gemini.json",
  packageTournamentConsensus: "package_tournament_consensus.json",
  packageAdjudication: "package_adjudication.json",
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
  draftGpt: "draft_gpt_web.txt",
  draftGemini: "draft_gemini_web.txt",
  draftSelection: "longform_draft_selection.json",
  initialScript: "initial_selected_script.txt",
  causalityDiagnostic: "causality_learning_diagnostic.json",
  continuityDiagnostic: "promise_continuity_diagnostic.json",
  authenticityDiagnostic: "narrative_authenticity_diagnostic.json",
  referenceDensityDiagnostic: "reference_density_dominance_diagnostic.json",
  revisedScript: "script_revised.txt",
  revisionLedger: "source_revision_ledger.json",
  semanticAcceptance: "source_semantic_acceptance.json",
  finalApproval: "final_script_approval.json",
  viewerTournamentDirectory: "viewer_tournament",
  viewerTournamentAcceptance: "viewer_tournament_acceptance.json",
  release: "source_room_release_v2.json",
});

const PROMPTS = Object.freeze({
  premiseAuthor: "manhwa_recap_premise_slate_v2.md",
  premiseSelector: "manhwa_recap_premise_selector_v2.md",
  packageTournament: "manhwa_recap_package_tournament_v1.md",
  referenceMeritFrontier: "manhwa_recap_reference_merit_frontier_v1.md",
  treatments: "manhwa_recap_treatment_bakeoff_v1.md",
  treatmentSelector: "manhwa_recap_treatment_selector_v1.md",
  architecture: "manhwa_recap_story_architecture_v1.md",
  architectureRedteam: "manhwa_recap_architecture_redteam_v1.md",
  longform: "manhwa_recap_longform_writer_v8.md",
  longformSelector: "manhwa_recap_longform_draft_selector_v1.md",
  causalityDiagnostic: "manhwa_recap_causality_learning_diagnostic_v2.md",
  continuityDiagnostic: "manhwa_recap_promise_continuity_diagnostic_v2.md",
  authenticityDiagnostic: "manhwa_recap_narrative_authenticity_diagnostic_v1.md",
  referenceDensityDiagnostic: "manhwa_recap_reference_density_diagnostic_v1.md",
  revision: "manhwa_recap_developmental_revision_v2.md",
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
  const entries = ledger.document.entries;
  const projectedEntries = [
    ...entries.filter((entry) => entry.source_type === "public_niche_outlier").slice(0, 12),
    ...entries.filter((entry) => entry.source_type === "own_channel").slice(0, 12),
  ];
  return {
    schema: "goldflow_premise_outlier_projection_v1",
    source_ledger_sha256: ledger.sha256,
    projection_policy: "top_12_public_plus_top_12_own_channel_in_source_order",
    limitations: ledger.document.limitations ?? [],
    entries: projectedEntries.map((entry) => ({
      entry_id: entry.entry_id,
      title: entry.title,
      source_type: entry.source_type,
      performance_signal: entry.performance_signal,
    })),
  };
}

function providerFlags(provider) {
  return { provider };
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

async function resumeModelResponse({ outputPath, stageName, prompt, provider }) {
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
    const contract = sourceModelContract(providerFlags(provider), { stageName });
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
}) {
  const outputPath = directOutputPath ?? rawResponsePath(id);
  const resumed = await resumeModelResponse({ outputPath, stageName, prompt, provider });
  if (resumed) return resumed;
  if (responsePath) return importedResponse({ sourcePath: responsePath, outputPath, stageName, prompt, provider });

  const contract = sourceModelContract(providerFlags(provider), { stageName });
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
    if (![REFERENCE_DENSITY_ROOM_PROFILE_V1, REFERENCE_DENSITY_ROOM_PROFILE_V2, REFERENCE_DENSITY_ROOM_PROFILE_V3].includes(roomContract?.profile)) blockers.push("source_room_contract_profile_invalid");
    if (roomContract?.reference_density_required !== true) blockers.push("source_room_contract_frontier_not_required");
    if ([REFERENCE_DENSITY_ROOM_PROFILE_V2, REFERENCE_DENSITY_ROOM_PROFILE_V3].includes(roomContract?.profile) && roomContract?.material_reference_edges_required !== true) {
      blockers.push("source_room_contract_material_edges_not_required");
    }
    if (roomContract?.profile === REFERENCE_DENSITY_ROOM_PROFILE_V3 && roomContract?.viewer_tournament_required !== true) {
      blockers.push("source_room_contract_viewer_tournament_not_required");
    }
    if (roomContract?.profile === REFERENCE_DENSITY_ROOM_PROFILE_V3 && !String(roomContract?.viewer_panel_seed ?? "").trim()) {
      blockers.push("source_room_contract_viewer_panel_seed_missing");
    }
    if (roomContract?.evidence_registry_sha256 !== evidence.sha256) blockers.push("source_room_contract_evidence_hash_mismatch");
    if (blockers.length) throw new Error(`Source room contract is blocked: ${blockers.join(", ")}`);
  }
  return { ...evidence, receiptPath, receipt, receiptSha256: await fileSha256(receiptPath), roomContract, roomContractPath };
}

async function loadPackageOutliers() {
  const ledger = await validatedJson(FILES.packageOutliers, validatePackageOutlierLedger);
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

async function loadPremiseRoom() {
  const evidence = await loadEvidence();
  const hasOutlierLedger = await exists(artifactPath(FILES.packageOutliers));
  const packageOutliers = hasOutlierLedger ? await loadPackageOutliers() : null;
  const slate = await validatedJson(FILES.premiseSlate, validatePremiseSlateV2, {
    evidenceRegistry: evidence.document,
    evidenceRegistrySha256: evidence.sha256,
    packageOutlierLedger: packageOutliers?.document ?? null,
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
  const candidate = slate.document.candidates.find((row) => row.id === selectedCandidateId);
  if (!candidate) throw new Error(`Selected premise ${selectedCandidateId} is absent.`);
  const packageSha256 = sha256CanonicalJson(candidate);
  return { evidence, packageOutliers, slate, selection, tournamentConsensus, packageAdjudication, candidate, packageSha256 };
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
  return [REFERENCE_DENSITY_ROOM_PROFILE_V2, REFERENCE_DENSITY_ROOM_PROFILE_V3].includes(room.evidence?.roomContract?.profile)
    && room.evidence?.roomContract?.material_reference_edges_required === true;
}

function viewerTournamentRequiredForRoom(room) {
  return room.evidence?.roomContract?.profile === REFERENCE_DENSITY_ROOM_PROFILE_V3
    && room.evidence?.roomContract?.viewer_tournament_required === true;
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

async function loadDraftRoom() {
  const room = await loadArchitecture({ requireApproval: true });
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
    if (words < 9_500 || words > 10_500) throw new Error(`${id} has ${words} words; expected 9500-10500.`);
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
  return { ...room, scriptText, scriptSha256, causality, continuity, authenticity, referenceDensity };
}

async function loadRevision() {
  const room = await loadDiagnostics();
  const revisedPath = artifactPath(FILES.revisedScript);
  if (!await exists(revisedPath)) throw new Error(`Missing revised script: ${revisedPath}`);
  const revisedText = await readText(revisedPath);
  const revisedSha256 = await fileSha256(revisedPath);
  const words = countWords(revisedText);
  if (words < 9_500 || words > 10_500) throw new Error(`Revised script has ${words} words; expected 9500-10500.`);
  const acceptedFindingIds = [
    ...room.causality.validation.accepted_findings,
    ...room.continuity.validation.accepted_findings,
    ...room.authenticity.validation.accepted_findings,
    ...(room.referenceDensity?.validation.accepted_findings ?? []),
  ].map((finding) => finding.id);
  const revisionLedger = await validatedJson(FILES.revisionLedger, validateSourceRevisionLedger, {
    sourceScriptSha256: room.scriptSha256,
    revisedScriptSha256: revisedSha256,
    acceptedFindingIds,
  });
  return { ...room, revisedPath, revisedText, revisedSha256, revisionLedger, acceptedFindingIds };
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
  const roomContract = {
    schema: "goldflow_source_room_contract_v1",
    profile: REFERENCE_DENSITY_ROOM_PROFILE_V3,
    reference_density_required: true,
    material_reference_edges_required: true,
    viewer_tournament_required: true,
    viewer_panel_seed: sha256Text(`${channel}\0${developmentSlug || path.basename(developmentDirectory())}\0source-viewer-panel-v3`),
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
    const matchesCurrent = existing?.profile === roomContract.profile
      && existing?.reference_density_required === true
      && existing?.material_reference_edges_required === true
      && existing?.viewer_tournament_required === true
      && existing?.viewer_panel_seed === roomContract.viewer_panel_seed
      && existing?.evidence_registry_sha256 === outputSha256;
    if (!recognizedLegacy && !recognizedEdgeComplete && !matchesCurrent) {
      throw new Error("Existing source room contract does not match the reference-density frontier profile.");
    }
  }
  printResult({ status: "passed", registry_path: outputPath, registry_sha256: outputSha256, next_action: "package-outliers" });
}

async function packageOutliers() {
  await loadEvidence();
  const sourcePath = path.resolve(required(flags.ledger, "--ledger <path>"));
  const sourceBytes = await readBytes(sourcePath);
  const sourceDocument = JSON.parse(sourceBytes.toString("utf8"));
  assertValid("package outlier ledger", validatePackageOutlierLedger(sourceDocument));
  if (sourceDocument.channel !== channel) throw new Error(`Outlier ledger channel ${sourceDocument.channel} does not match ${channel}.`);
  const outputPath = artifactPath(FILES.packageOutliers);
  if (await exists(outputPath)) {
    const current = await readJson(outputPath);
    assertValid("existing package outlier ledger", validatePackageOutlierLedger(current));
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
  printResult({ status: "passed", ledger_path: outputPath, ledger_sha256: outputSha256, next_action: "ideate-v2" });
}

async function ideateV2() {
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

async function packageTournament() {
  const evidence = await loadEvidence();
  const packageOutliers = await loadPackageOutliers();
  const slate = await validatedJson(FILES.premiseSlate, validatePremiseSlateV2, {
    evidenceRegistry: evidence.document,
    evidenceRegistrySha256: evidence.sha256,
    packageOutlierLedger: packageOutliers.document,
  });
  await validatedJson(FILES.premiseSelection, validatePremiseSelectionV2, {
    premiseSlate: slate.document,
    premiseSlateSha256: slate.sha256,
    evidenceRegistry: evidence.document,
    evidenceRegistrySha256: evidence.sha256,
  });
  const eligibleCandidates = slate.document.candidates.filter((candidate) => (
    candidate?.click_judgment?.decision === "strong" && candidate?.runway_judgment?.decision === "strong"
  ));
  if (!eligibleCandidates.length) throw new Error("No package clears both the strong-click and strong-runway screens.");

  const template = await promptTemplate(PROMPTS.packageTournament);
  const tournamentInput = {
    schema: "goldflow_package_tournament_input_v1",
    premise_slate_sha256: slate.sha256,
    eligible_candidate_ids: eligibleCandidates.map((candidate) => candidate.id),
    candidates: eligibleCandidates,
  };
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
  const packageOutliers = await loadPackageOutliers();
  const slate = await validatedJson(FILES.premiseSlate, validatePremiseSlateV2, {
    evidenceRegistry: evidence.document,
    evidenceRegistrySha256: evidence.sha256,
    packageOutlierLedger: packageOutliers.document,
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
  printResult({ status: "passed", approval_path: approval.path, architecture_sha256: room.architecture.sha256, next_action: "script-v2" });
}

function geminiDraftProvider() {
  return "gemini_web";
}

async function scriptV2() {
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
    if (wordCount < 9_500 || wordCount > 10_500) throw new Error(`${id} has ${wordCount} words; expected 9500-10500.`);
    return [id, { text, path: draftPath, sha256: await fileSha256(draftPath), word_count: wordCount }];
  })));

  const selectorTemplate = await promptTemplate(PROMPTS.longformSelector);
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
  if (room.referenceMeritFrontier) assignments.push({ id: "reference_density_dominance", fileName: FILES.referenceDensityDiagnostic, promptName: PROMPTS.referenceDensityDiagnostic, provider: "chatgpt_web", responseFlag: "reference-density-response-path", densityDiagnostic: true });
  const results = await Promise.all(assignments.map(async (assignment) => {
    const template = await promptTemplate(assignment.promptName);
    const prompt = template.text
      + embedded("APPROVED PACKAGE JSON", room.candidate)
      + embedded("APPROVED STORY ARCHITECTURE JSON", room.architecture.document)
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

async function reviseV2() {
  const room = await loadDiagnostics();
  const ledgerPath = artifactPath(FILES.revisionLedger);
  const revisedPath = artifactPath(FILES.revisedScript);
  const allFindings = [
    ...room.causality.validation.accepted_findings,
    ...room.continuity.validation.accepted_findings,
    ...room.authenticity.validation.accepted_findings,
    ...(room.referenceDensity?.validation.accepted_findings ?? []),
  ];
  const allIds = allFindings.map((finding) => finding.id);
  if (await exists(ledgerPath)) {
    if (!await exists(revisedPath)) throw new Error("Revision ledger exists without script_revised.txt.");
    const revisedSha256 = await fileSha256(revisedPath);
    const existing = await readJson(ledgerPath);
    const validation = validateSourceRevisionLedger(existing, { sourceScriptSha256: room.scriptSha256, revisedScriptSha256: revisedSha256, acceptedFindingIds: allIds });
    if (validation.done) {
      if (isTrue(flags["exact-repair"])) throw new Error("A passed revision already exists; exact repair may not overwrite it.");
      printResult({ status: "passed", revised_script_path: revisedPath, revision_ledger_path: ledgerPath, resumed: true, next_action: "accept-v2" });
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
    assertValid(FILES.revisionLedger, validateSourceRevisionLedger(ledger, { sourceScriptSha256: room.scriptSha256, revisedScriptSha256: revisedSha256, acceptedFindingIds: [] }));
    await writeJsonExclusive(ledgerPath, ledger);
    printResult({ status: "passed", revised_script_path: revisedPath, revision_ledger_path: ledgerPath, revision_kind: "no_findings_byte_copy", next_action: "accept-v2" });
    return;
  }

  const template = await promptTemplate(PROMPTS.revision);
  const prompt = template.text
    + embedded("APPROVED PACKAGE JSON", room.candidate)
    + embedded("APPROVED STORY ARCHITECTURE JSON", room.architecture.document)
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
  if (words < 9_500 || words > 10_500) throw new Error(`Revised script has ${words} words; expected 9500-10500.`);
  const scriptBytes = Buffer.from(`${parsed.script.trim()}\n`, "utf8");
  const revisedSha256 = sha256(scriptBytes);
  parsed.ledger.source_script_sha256 = room.scriptSha256;
  parsed.ledger.revised_script_sha256 = revisedSha256;
  assertValid(FILES.revisionLedger, validateSourceRevisionLedger(parsed.ledger, { sourceScriptSha256: room.scriptSha256, revisedScriptSha256: revisedSha256, acceptedFindingIds: requestedIds }));
  await writeExclusive(revisedPath, scriptBytes);
  await writeJsonExclusive(ledgerPath, parsed.ledger);
  printResult({ status: "passed", revised_script_path: revisedPath, revised_script_sha256: revisedSha256, revision_ledger_path: ledgerPath, repaired_finding_ids: requestedIds, next_action: "accept-v2" });
}

async function acceptV2() {
  const room = await loadRevision();
  const template = await promptTemplate(PROMPTS.acceptance);
  const prompt = template.text
    + embedded("APPROVED PACKAGE JSON", room.candidate)
    + embedded("APPROVED STORY ARCHITECTURE JSON", room.architecture.document)
    + embedded("REVISION LEDGER JSON", room.revisionLedger.document)
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
    next_action: viewerTournamentRequiredForRoom(room) ? "viewer-tournament" : "release-v2",
  });
}

async function releaseV2() {
  const room = await loadRevision();
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
  const sourceRoomContractPath = room.evidence.roomContractPath;
  const sourceRoomContractSha256 = sourceRoomContractPath
    ? await fileSha256(sourceRoomContractPath)
    : null;
  const outputPath = artifactPath(FILES.release);
  const diagnosticSha256s = {
    causality_learning: room.causality.sha256,
    promise_continuity: room.continuity.sha256,
    narrative_authenticity: room.authenticity.sha256,
    ...(room.referenceDensity ? { reference_density_dominance: room.referenceDensity.sha256 } : {}),
  };
  const diagnosticPaths = {
    causality_learning: room.causality.path,
    promise_continuity: room.continuity.path,
    narrative_authenticity: room.authenticity.path,
    ...(room.referenceDensity ? { reference_density_dominance: room.referenceDensity.path } : {}),
  };
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
    sourceRoomContractSha256,
    sourceRoomProfile: room.evidence.roomContract?.profile ?? null,
    requireSourceRoomContract: Boolean(room.evidence.roomContract),
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
  console.log("New outlier-led rooms require package-tournament after ideate-v2 and before approve-package-v2.\n");
  console.log(`Winner Source Room V2\n\nUsage:\n  node scripts/winner-source-room-v2.mjs <action> --development-dir <path> [flags]\n  node scripts/winner-source-room-v2.mjs <action> --channel <id> --development-slug <slug> [flags]\n\nActions:\n  evidence-registry      --registry <json>\n  package-outliers       --ledger <json>\n  ideate-v2              [--author-response-path <json>] [--selector-response-path <json>]\n  package-tournament     [--gpt-response-path <json>] [--gemini-response-path <json>]\n  adjudicate-package     --candidate-id <id> --adjudicated-by <operator> --rationale <text>\n  approve-package-v2     --approved-by <operator>\n  reference-frontier     --reference <exact measured outlier transcript> [--reference-entry-id <ledger-id>] [--response-path <json>]\n  treatments             [--boundary-response-path <json>] [--adaptive-response-path <json>] [--reclassification-response-path <json>]\n  select-treatment       [--response-path <json>]\n  approve-treatment      --approved-by <operator>\n  architecture           [--response-path <json>]\n  architecture-audit     [--response-path <json>]\n  approve-architecture   --approved-by <operator>\n  script-v2              [--gpt-response-path <txt>] [--gemini-response-path <txt>] [--selector-response-path <json>]\n  diagnose-v2            [--causality-response-path <json>] [--continuity-response-path <json>] [--authenticity-response-path <json>] [--reference-density-response-path <json>]\n  revise-v2              [--response-path <txt>] [--exact-repair true --finding-ids <ids>]\n  accept-v2              --approved-by <operator> [--response-path <json>]\n  release-v2             [--series <slug>] [--week <slug>] [--episode ep_01]\n\nFinal viewer gate for new rooms:\n  node bin/goldflow.mjs source viewer-tournament --candidate <development-dir>/script_revised.txt --reference <development-dir>/reference_outlier_transcript.txt --output-dir <development-dir>/viewer_tournament --panel-seed <source_room_contract.viewer_panel_seed> --candidate-title <approved-title> --reference-title <reference-title>\n  node bin/goldflow.mjs source viewer-accept --candidate <development-dir>/script_revised.txt --reference <development-dir>/reference_outlier_transcript.txt --viewer-dir <development-dir>/viewer_tournament --output <development-dir>/viewer_tournament_acceptance.json\n\nLongform provider contract:\n  draft_gpt_web uses ChatGPT Web Pro; draft_gemini_web and independent selection use Gemini Web 3.7 Flash.\n  Codex never authors, selects, diagnoses, or revises source prose in this lane; it only orchestrates and validates local artifacts.\n  Gemini transport failure is blocking and has no silent provider fallback.\n\nBehavior:\n  Passed artifacts are immutable and resumed. Upstream hashes are revalidated on every action.\n  Tournament disagreement requires an immutable operator adjudication before separate package approval.\n  New rooms bind one complete measured reference frontier before treatment spend. Comparison is viewer-payoff density, never raw runtime or raw event count.\n  New rooms also precommit one ten-viewer panel; release-v2 requires its exact accepted, hash-bound verdict.\n  Independent treatments, drafts, and diagnostics use Promise.all. No automatic rewrite loop exists.\n`);
}

const ACTIONS = {
  "evidence-registry": evidenceRegistry,
  "package-outliers": packageOutliers,
  "ideate-v2": ideateV2,
  "package-tournament": packageTournament,
  "adjudicate-package": adjudicatePackage,
  "approve-package-v2": approvePackageV2,
  "reference-frontier": referenceFrontier,
  treatments,
  "select-treatment": selectTreatment,
  "approve-treatment": approveTreatment,
  architecture,
  "architecture-audit": architectureAudit,
  "approve-architecture": approveArchitecture,
  "script-v2": scriptV2,
  "diagnose-v2": diagnoseV2,
  "revise-v2": reviseV2,
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
