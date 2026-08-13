import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizeWinnerNarration } from "./winner-source-contract.mjs";
import {
  REFERENCE_DENSITY_ROOM_PROFILE_V1,
  REFERENCE_DENSITY_ROOM_PROFILE_V2,
  REFERENCE_DENSITY_ROOM_PROFILE_V3,
  SOURCE_ROOM_RELEASE_V2_SCHEMA,
  hasDramaticColdOpenContract,
  validateReferenceMeritFrontier,
  validateSourceRoomReleaseV2,
  validateSourceSemanticAcceptance,
  validateSourceStageApproval,
} from "./winner-source-room-v2-contract.mjs";
import { validateViewerTournamentAcceptance } from "./source-viewer-tournament-contract.mjs";

const SOURCE_ROOM_PROFILES = new Set([
  REFERENCE_DENSITY_ROOM_PROFILE_V1,
  REFERENCE_DENSITY_ROOM_PROFILE_V2,
  REFERENCE_DENSITY_ROOM_PROFILE_V3,
]);

const DIAGNOSTIC_FILE_NAMES = Object.freeze({
  causality_learning: "causality_learning_diagnostic.json",
  promise_continuity: "promise_continuity_diagnostic.json",
  narrative_authenticity: "narrative_authenticity_diagnostic.json",
  reference_density_dominance: "reference_density_dominance_diagnostic.json",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveArtifact(ownerPath, value, label) {
  const candidate = String(value ?? "").trim();
  if (!candidate) throw new Error(`Source-room release is missing ${label}.`);
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(path.dirname(ownerPath), candidate);
}

async function readBytes(filePath, label) {
  const bytes = await fs.readFile(filePath).catch(() => null);
  if (!bytes) throw new Error(`Missing ${label}: ${filePath}`);
  return bytes;
}

async function readJson(filePath, label) {
  const bytes = await readBytes(filePath, label);
  try {
    return { path: filePath, bytes, sha256: sha256(bytes), document: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    throw new Error(`Invalid ${label} JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readBoundArtifact(release, releasePath, pathField, hashField, label, { json = false } = {}) {
  const artifactPath = resolveArtifact(releasePath, release[pathField], pathField);
  const bytes = await readBytes(artifactPath, label);
  const actualSha256 = sha256(bytes);
  if (release[hashField] !== actualSha256) {
    throw new Error(`${label} hash mismatch: release records ${release[hashField]}, current file is ${actualSha256}.`);
  }
  if (!json) return { path: artifactPath, bytes, sha256: actualSha256 };
  try {
    return { path: artifactPath, bytes, sha256: actualSha256, document: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    throw new Error(`Invalid ${label} JSON at ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertValid(label, validation) {
  if (!validation?.done) throw new Error(`${label} is blocked: ${(validation?.blockers ?? []).join(", ")}`);
}

function requireSame(label, actual, expected) {
  if (expected != null && actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, found ${actual}.`);
  }
}

function diagnosticPathFor(release, releasePath, diagnosticId) {
  const explicit = release?.diagnostic_paths?.[diagnosticId];
  if (explicit) return resolveArtifact(releasePath, explicit, `diagnostic_paths.${diagnosticId}`);
  const fileName = DIAGNOSTIC_FILE_NAMES[diagnosticId];
  if (!fileName) throw new Error(`Source-room release has no path contract for diagnostic ${diagnosticId}.`);
  return path.join(path.dirname(releasePath), fileName);
}

export async function loadSourceRoomReleaseV2Binding(releaseFilePath, {
  expectedChannel = null,
  expectedTitle = null,
  expectedSourcePath = null,
  expectedSourceText = null,
  expectedRawSourceSha256 = null,
  identityBinding = null,
} = {}) {
  const releasePath = path.resolve(releaseFilePath);
  const releaseArtifact = await readJson(releasePath, "source-room release");
  const release = releaseArtifact.document;
  if (release?.schema !== SOURCE_ROOM_RELEASE_V2_SCHEMA) {
    throw new Error(`Expected ${SOURCE_ROOM_RELEASE_V2_SCHEMA}, found ${release?.schema ?? "missing schema"}.`);
  }
  if (release.status !== "released") throw new Error("Source-room release is not released.");
  const adjacentRoomContractPath = path.join(path.dirname(releasePath), "source_room_contract.json");
  const adjacentRoomContractExists = await fs.stat(adjacentRoomContractPath).then((stat) => stat.isFile()).catch(() => false);
  if (adjacentRoomContractExists && (!release.source_room_contract_path || !release.source_room_contract_sha256 || !release.source_room_profile)) {
    throw new Error("Source-room release omits the adjacent source_room_contract.json binding.");
  }

  const source = await readBoundArtifact(
    release,
    releasePath,
    "final_script_path",
    "final_script_sha256",
    "source-room final script",
  );
  const sourceText = source.bytes.toString("utf8");
  const normalizedSourceSha256 = sha256(normalizeWinnerNarration(sourceText));
  if (expectedSourcePath) {
    const requestedBytes = await readBytes(path.resolve(expectedSourcePath), "requested production source");
    requireSame("Requested production source byte hash", sha256(requestedBytes), source.sha256);
  }
  if (expectedSourceText != null) {
    requireSame("Ingest source byte hash", sha256(Buffer.from(String(expectedSourceText), "utf8")), source.sha256);
  }
  if (expectedRawSourceSha256) requireSame("Run-identity source byte hash", source.sha256, expectedRawSourceSha256);
  requireSame("Source-room channel", release.channel, expectedChannel);
  requireSame("Source-room title", release.selected_title, expectedTitle);

  const boundSpecs = [
    ["package_selection_path", "package_selection_sha256", "package selection"],
    ["package_selection_approval_path", "package_selection_approval_sha256", "package selection approval"],
    ["treatment_selection_path", "treatment_selection_sha256", "treatment selection"],
    ["treatment_selection_approval_path", "treatment_selection_approval_sha256", "treatment selection approval"],
    ["architecture_path", "architecture_sha256", "story architecture"],
    ["architecture_approval_path", "architecture_approval_sha256", "story architecture approval"],
    ["longform_draft_selection_path", "longform_draft_selection_sha256", "longform draft selection"],
    ["revision_ledger_path", "revision_ledger_sha256", "source revision ledger"],
    ["semantic_acceptance_path", "semantic_acceptance_sha256", "source semantic acceptance"],
    ["final_script_approval_path", "final_script_approval_sha256", "final script approval"],
  ];
  const artifacts = {};
  for (const [pathField, hashField, label] of boundSpecs) {
    artifacts[pathField] = await readBoundArtifact(release, releasePath, pathField, hashField, label, { json: true });
  }

  const actualDiagnosticSha256s = {};
  for (const [diagnosticId, expectedSha256] of Object.entries(release.diagnostic_sha256s ?? {})) {
    const diagnosticPath = diagnosticPathFor(release, releasePath, diagnosticId);
    const bytes = await readBytes(diagnosticPath, `${diagnosticId} diagnostic`);
    const actualSha256 = sha256(bytes);
    requireSame(`${diagnosticId} diagnostic hash`, actualSha256, expectedSha256);
    actualDiagnosticSha256s[diagnosticId] = actualSha256;
  }

  let roomContract = null;
  if (release.source_room_contract_path || release.source_room_profile) {
    roomContract = await readBoundArtifact(
      release,
      releasePath,
      "source_room_contract_path",
      "source_room_contract_sha256",
      "source-room contract",
      { json: true },
    );
    const contract = roomContract.document;
    if (contract?.schema !== "goldflow_source_room_contract_v1") throw new Error("Source-room contract schema is invalid.");
    if (!SOURCE_ROOM_PROFILES.has(contract?.profile)) throw new Error(`Unknown source-room profile ${contract?.profile}.`);
    requireSame("Source-room profile", contract.profile, release.source_room_profile);
    requireSame("Source-room evidence hash", contract.evidence_registry_sha256, release.evidence_registry_sha256);
    if ([REFERENCE_DENSITY_ROOM_PROFILE_V2, REFERENCE_DENSITY_ROOM_PROFILE_V3].includes(contract.profile)
      && contract.material_reference_edges_required !== true) {
      throw new Error("Source-room contract does not require the complete material-reference edge inventory.");
    }
    if (contract.profile === REFERENCE_DENSITY_ROOM_PROFILE_V3) {
      if (contract.reference_density_required !== true || contract.viewer_tournament_required !== true) {
        throw new Error("V3 source-room contract does not require density dominance and the viewer tournament.");
      }
      if (!String(contract.viewer_panel_seed ?? "").trim()) throw new Error("V3 source-room contract is missing its precommitted viewer panel seed.");
    }
  }
  const sourceRoomProfile = roomContract?.document?.profile ?? release.source_room_profile ?? null;
  const requiresViewerTournament = sourceRoomProfile === REFERENCE_DENSITY_ROOM_PROFILE_V3;
  if (requiresViewerTournament && !roomContract) throw new Error("V3 source-room release is missing its hash-bound source-room contract.");

  let reference = null;
  let frontier = null;
  if (release.reference_path || release.reference_merit_frontier_path || requiresViewerTournament) {
    reference = await readBoundArtifact(release, releasePath, "reference_path", "reference_sha256", "measured reference transcript");
    const referenceText = reference.bytes.toString("utf8");
    frontier = await readBoundArtifact(
      release,
      releasePath,
      "reference_merit_frontier_path",
      "reference_merit_frontier_sha256",
      "reference merit frontier",
      { json: true },
    );
    assertValid("Reference merit frontier", validateReferenceMeritFrontier(frontier.document, {
      referenceText,
      referenceSha256: reference.sha256,
      referencePath: reference.path,
      requireMaterialEdges: [REFERENCE_DENSITY_ROOM_PROFILE_V2, REFERENCE_DENSITY_ROOM_PROFILE_V3].includes(sourceRoomProfile),
    }));
  }

  const architecture = artifacts.architecture_path.document;
  const semanticAcceptance = artifacts.semantic_acceptance_path.document;
  assertValid("Final semantic acceptance", validateSourceSemanticAcceptance(semanticAcceptance, {
    scriptText: sourceText,
    scriptSha256: source.sha256,
    requireDramaticOpeningAcceptance: hasDramaticColdOpenContract(architecture),
    requireReferenceDensityDominance: Boolean(frontier),
    referenceText: reference?.bytes.toString("utf8") ?? "",
    referenceSha256: reference?.sha256 ?? null,
    referenceMeritFrontierSha256: frontier?.sha256 ?? null,
    referenceDensityDiagnosticSha256: actualDiagnosticSha256s.reference_density_dominance ?? null,
    referenceMeritFrontier: frontier?.document ?? null,
  }));
  if (semanticAcceptance.status !== "accepted") throw new Error("Final semantic acceptance did not accept the released script.");
  assertValid("Final script approval", validateSourceStageApproval(artifacts.final_script_approval_path.document, {
    stageId: "final_script",
    sourceSha256: source.sha256,
    selectedId: null,
  }));

  let viewerTournament = null;
  if (requiresViewerTournament) {
    const acceptance = await readBoundArtifact(
      release,
      releasePath,
      "viewer_tournament_acceptance_path",
      "viewer_tournament_acceptance_sha256",
      "viewer tournament acceptance",
      { json: true },
    );
    const manifest = await readBoundArtifact(
      release,
      releasePath,
      "viewer_tournament_manifest_path",
      "viewer_tournament_manifest_sha256",
      "viewer tournament manifest",
      { json: true },
    );
    requireSame("Viewer tournament panel seed", manifest.document.panel_seed, roomContract.document.viewer_panel_seed);
    const reports = [];
    const reportSha256s = {};
    for (const personaId of manifest.document.panel_profile_ids ?? []) {
      const reportPath = path.join(path.dirname(manifest.path), `${personaId}.json`);
      const report = await readJson(reportPath, `viewer report ${personaId}`);
      if (report.document?.persona_id !== personaId) throw new Error(`Viewer report identity mismatch for ${personaId}.`);
      reports.push(report.document);
      reportSha256s[personaId] = report.sha256;
    }
    assertValid("Viewer tournament acceptance", validateViewerTournamentAcceptance(acceptance.document, {
      candidateSha256: source.sha256,
      referenceSha256: reference?.sha256 ?? null,
      candidateText: sourceText,
      referenceText: reference?.bytes.toString("utf8") ?? "",
      manifest: manifest.document,
      manifestFileSha256: manifest.sha256,
      reports,
      reportSha256s,
      requireAccepted: true,
    }));
    for (const [personaId, reportSha256] of Object.entries(release.viewer_tournament_report_sha256s ?? {})) {
      requireSame(`Viewer report ${personaId} hash`, reportSha256s[personaId], reportSha256);
    }
    viewerTournament = { acceptance, manifest, reportSha256s };
  }

  const releaseValidationOptions = {
    finalScriptSha256: source.sha256,
    packageSelectionSha256: artifacts.package_selection_path.sha256,
    packageSelectionApprovalSha256: artifacts.package_selection_approval_path.sha256,
    treatmentSelectionSha256: artifacts.treatment_selection_path.sha256,
    treatmentSelectionApprovalSha256: artifacts.treatment_selection_approval_path.sha256,
    architectureSha256: artifacts.architecture_path.sha256,
    architectureApprovalSha256: artifacts.architecture_approval_path.sha256,
    longformDraftSelectionSha256: artifacts.longform_draft_selection_path.sha256,
    diagnosticSha256s: actualDiagnosticSha256s,
    revisionLedgerSha256: artifacts.revision_ledger_path.sha256,
    semanticAcceptanceSha256: artifacts.semantic_acceptance_path.sha256,
    finalScriptApprovalSha256: artifacts.final_script_approval_path.sha256,
    referenceMeritFrontierSha256: frontier?.sha256 ?? null,
    referenceSha256: reference?.sha256 ?? null,
    viewerTournamentAcceptanceSha256: viewerTournament?.acceptance.sha256 ?? null,
    viewerTournamentManifestSha256: viewerTournament?.manifest.sha256 ?? null,
    viewerTournamentReportSha256s: viewerTournament?.reportSha256s ?? null,
    requireViewerTournamentAcceptance: requiresViewerTournament,
    sourceRoomContractSha256: roomContract?.sha256 ?? null,
    sourceRoomProfile,
    requireSourceRoomContract: Boolean(roomContract),
  };
  assertValid("Source-room release", validateSourceRoomReleaseV2(release, releaseValidationOptions));

  if (identityBinding) {
    requireSame("Run-identity release hash", releaseArtifact.sha256, identityBinding.release_sha256);
    requireSame("Run-identity released script hash", source.sha256, identityBinding.released_final_script_sha256 ?? identityBinding.source_file_sha256);
    requireSame("Run-identity normalized script hash", normalizedSourceSha256, identityBinding.source_script_sha256);
    requireSame("Run-identity source-room profile", sourceRoomProfile, identityBinding.source_room_profile ?? null);
  }

  return {
    schema: "goldflow_run_identity_source_room_release_binding_v2",
    release_schema: SOURCE_ROOM_RELEASE_V2_SCHEMA,
    release_path: releasePath,
    release_sha256: releaseArtifact.sha256,
    channel: release.channel,
    development_slug: release.development_slug,
    selected_title: release.selected_title,
    source_path: source.path,
    source_file_sha256: source.sha256,
    source_script_sha256: normalizedSourceSha256,
    released_final_script_sha256: source.sha256,
    source_workflow_profile: release.source_workflow_profile,
    source_room_profile: sourceRoomProfile,
    source_room_contract_path: roomContract?.path ?? null,
    source_room_contract_sha256: roomContract?.sha256 ?? null,
    reference_path: reference?.path ?? null,
    reference_sha256: reference?.sha256 ?? null,
    reference_merit_frontier_path: frontier?.path ?? null,
    reference_merit_frontier_sha256: frontier?.sha256 ?? null,
    semantic_acceptance_path: artifacts.semantic_acceptance_path.path,
    semantic_acceptance_sha256: artifacts.semantic_acceptance_path.sha256,
    viewer_tournament_acceptance_path: viewerTournament?.acceptance.path ?? null,
    viewer_tournament_acceptance_sha256: viewerTournament?.acceptance.sha256 ?? null,
    viewer_tournament_manifest_path: viewerTournament?.manifest.path ?? null,
    viewer_tournament_manifest_sha256: viewerTournament?.manifest.sha256 ?? null,
    viewer_tournament_report_sha256s: viewerTournament?.reportSha256s ?? null,
    released_at: release.released_at,
    bound_at: new Date().toISOString(),
  };
}
