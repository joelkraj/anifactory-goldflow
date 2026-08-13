import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  WINNER_SCRIPT_GENERATION_REPORT_SCHEMA,
  WINNER_SOURCE_ROOM_PROFILE,
  normalizeWinnerNarration,
  sha256Text,
} from "./winner-source-contract.mjs";
import {
  WINNER_AUDIENCE_FEEDBACK_CONTRACT_VERSION,
  WINNER_DIAGNOSTIC_PASS_IDS,
  usesWinnerAudienceFeedbackContract,
  validateWinnerBlueprintAudienceAudit,
  validateWinnerBlueprintForPackage,
  validateWinnerDevelopmentDiagnostic,
  validateWinnerOpeningApproval,
  validateWinnerRetentionMap,
  validateWinnerRevisionReport,
} from "./winner-source-room-contract.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveArtifact(ownerPath, value, label) {
  const candidate = String(value ?? "").trim();
  if (!candidate) throw new Error(`Winner source room release is missing ${label}.`);
  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(path.dirname(ownerPath), candidate);
}

async function readJsonArtifact(ownerPath, value, label, expectedSha256 = null) {
  const artifactPath = resolveArtifact(ownerPath, value, label);
  const bytes = await fs.readFile(artifactPath).catch(() => null);
  if (!bytes) throw new Error(`Missing ${label}: ${artifactPath}`);
  const artifactSha256 = sha256(bytes);
  if (expectedSha256 && artifactSha256 !== expectedSha256) {
    throw new Error(`${label} hash mismatch: expected ${expectedSha256}, found ${artifactSha256}.`);
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON at ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: artifactPath, bytes, sha256: artifactSha256, document };
}

async function readTextArtifact(ownerPath, value, label, expectedSha256 = null) {
  const artifactPath = resolveArtifact(ownerPath, value, label);
  const bytes = await fs.readFile(artifactPath).catch(() => null);
  if (!bytes) throw new Error(`Missing ${label}: ${artifactPath}`);
  const artifactSha256 = sha256(bytes);
  if (expectedSha256 && artifactSha256 !== expectedSha256) {
    throw new Error(`${label} hash mismatch: expected ${expectedSha256}, found ${artifactSha256}.`);
  }
  return {
    path: artifactPath,
    bytes,
    sha256: artifactSha256,
    text: normalizeWinnerNarration(bytes.toString("utf8")),
  };
}

export async function loadWinnerSourceRoomLineage({
  release,
  releasePath,
  packageContract,
  packageSha256,
  blueprintDocument,
  blueprintPath,
  blueprintSha256,
  releasedSourceScriptSha256,
}) {
  if (packageContract?.source_workflow_profile !== WINNER_SOURCE_ROOM_PROFILE) return null;

  const blueprintValidation = validateWinnerBlueprintForPackage(blueprintDocument, {
    packageContract,
    packageSha256,
  });
  if (!blueprintValidation.done) {
    throw new Error(`Invalid winner source room blueprint: ${blueprintValidation.blockers.join(", ")}`);
  }

  let blueprintAudienceAudit = null;
  if (usesWinnerAudienceFeedbackContract(blueprintDocument)) {
    if (release.audience_feedback_contract_version !== WINNER_AUDIENCE_FEEDBACK_CONTRACT_VERSION) {
      throw new Error("Winner source release audience-feedback contract is missing or stale.");
    }
    blueprintAudienceAudit = await readJsonArtifact(
      releasePath,
      release.winner_blueprint_audience_audit_path,
      "winner blueprint audience audit",
      release.winner_blueprint_audience_audit_sha256,
    );
    const auditValidation = validateWinnerBlueprintAudienceAudit(blueprintAudienceAudit.document, {
      packageContract,
      packageSha256,
      blueprint: blueprintDocument,
      blueprintSha256,
    });
    if (!auditValidation.done) {
      throw new Error(`Invalid winner blueprint audience audit: ${auditValidation.blockers.join(", ")}`);
    }
    if (release.winner_blueprint_audience_audit_decision !== blueprintAudienceAudit.document.decision) {
      throw new Error("Winner source release blueprint audience-audit decision is stale.");
    }
    if (blueprintAudienceAudit.document.decision !== "pass"
      && (!release.winner_blueprint_audience_audit_risk_override?.approved
        || !String(release.winner_blueprint_audience_audit_risk_override?.reason ?? "").trim())) {
      throw new Error("Winner source release carries an unresolved blueprint audience-audit revision decision.");
    }
    const blueprintApproval = await readJsonArtifact(
      releasePath,
      release.winner_story_blueprint_approval_path,
      "winner story blueprint approval",
    );
    if (blueprintApproval.document?.winner_blueprint_audience_audit_sha256 !== blueprintAudienceAudit.sha256
      || blueprintApproval.document?.winner_blueprint_audience_audit_decision !== blueprintAudienceAudit.document.decision
      || blueprintApproval.document?.audience_feedback_contract_version !== WINNER_AUDIENCE_FEEDBACK_CONTRACT_VERSION) {
      throw new Error("Winner story blueprint approval is not bound to the current audience audit.");
    }
  }

  const retention = await readJsonArtifact(
    releasePath,
    release.winner_retention_map_path,
    "winner retention map",
    release.winner_retention_map_sha256,
  );
  const retentionValidation = validateWinnerRetentionMap(retention.document, {
    blueprint: blueprintDocument,
    blueprintSha256,
    packageContract,
    packageSha256,
  });
  if (!retentionValidation.done) {
    throw new Error(`Invalid winner retention map: ${retentionValidation.blockers.join(", ")}`);
  }

  const opening = await readTextArtifact(
    releasePath,
    release.winner_opening_path,
    "winner opening",
    release.winner_opening_sha256,
  );
  const openingApproval = await readJsonArtifact(
    releasePath,
    release.winner_opening_approval_path,
    "winner opening approval",
  );
  const openingApprovalValidation = validateWinnerOpeningApproval(openingApproval.document, {
    openingSha256: opening.sha256,
    retentionMapSha256: retention.sha256,
    blueprintSha256,
  });
  if (!openingApprovalValidation.done) {
    throw new Error(`Invalid winner opening approval: ${openingApprovalValidation.blockers.join(", ")}`);
  }

  const generation = await readJsonArtifact(
    releasePath,
    release.script_generation_report_path,
    "winner script generation report",
    release.script_generation_report_sha256,
  );
  if (generation.document?.schema !== WINNER_SCRIPT_GENERATION_REPORT_SCHEMA
    || generation.document?.status !== "passed") {
    throw new Error("Winner script generation report is not passed.");
  }
  if (generation.document.winner_story_blueprint_sha256 !== blueprintSha256
    || generation.document.winner_retention_map_sha256 !== retention.sha256
    || generation.document.winner_opening_sha256 !== opening.sha256) {
    throw new Error("Winner script generation report is stale for the released source room artifacts.");
  }
  const candidate = await readTextArtifact(
    generation.path,
    generation.document.source_script_path,
    "winner generated script candidate",
  );
  if (sha256Text(candidate.text) !== generation.document.source_script_sha256) {
    throw new Error("Winner generated script candidate hash does not match its report.");
  }

  const diagnostics = await readJsonArtifact(
    releasePath,
    release.winner_development_diagnostics_manifest_path,
    "winner development diagnostics manifest",
    release.winner_development_diagnostics_manifest_sha256,
  );
  if (diagnostics.document?.status !== "passed"
    || diagnostics.document?.source_script_sha256 !== generation.document.source_script_sha256) {
    throw new Error("Winner development diagnostics manifest is stale for the generated script.");
  }
  for (const passId of WINNER_DIAGNOSTIC_PASS_IDS) {
    const row = (diagnostics.document.reports ?? []).find((entry) => entry.pass_id === passId);
    if (!row) throw new Error(`Winner diagnostics manifest is missing ${passId}.`);
    const diagnostic = await readJsonArtifact(
      diagnostics.path,
      row.report_path,
      `winner ${passId} diagnostic`,
      row.report_sha256,
    );
    const validation = validateWinnerDevelopmentDiagnostic(diagnostic.document, {
      passId,
      sourceScriptSha256: generation.document.source_script_sha256,
      scriptText: candidate.text,
    });
    if (!validation.done) {
      throw new Error(`Invalid winner ${passId} diagnostic: ${validation.blockers.join(", ")}`);
    }
  }

  const revision = await readJsonArtifact(
    releasePath,
    release.winner_integrated_revision_report_path,
    "winner integrated revision report",
    release.winner_integrated_revision_report_sha256,
  );
  const revisedScript = await readTextArtifact(
    revision.path,
    revision.document.output_script_path,
    "winner revised script",
  );
  const revisionValidation = validateWinnerRevisionReport(revision.document, {
    expectedStage: "integrated_revision",
    sourceScriptSha256: generation.document.source_script_sha256,
    outputScriptSha256: sha256Text(revisedScript.text),
    openingSha256: opening.sha256,
  });
  if (!revisionValidation.done
    || revision.document.source_script_sha256 !== generation.document.source_script_sha256
    || revision.document.winner_story_blueprint_sha256 !== blueprintSha256
    || revision.document.winner_retention_map_sha256 !== retention.sha256
    || revision.document.diagnostics_manifest_sha256 !== diagnostics.sha256) {
    throw new Error(`Invalid winner integrated revision lineage: ${revisionValidation.blockers.join(", ")}`);
  }

  const polish = await readJsonArtifact(
    releasePath,
    release.winner_line_flow_polish_report_path,
    "winner line-flow polish report",
    release.winner_line_flow_polish_report_sha256,
  );
  if (release.script_development_report_path !== release.winner_line_flow_polish_report_path
    || release.script_development_report_sha256 !== polish.sha256) {
    throw new Error("Winner source release development report must be the exact line-flow polish report.");
  }
  const polishedScript = await readTextArtifact(
    polish.path,
    polish.document.output_script_path,
    "winner polished script",
  );
  const polishValidation = validateWinnerRevisionReport(polish.document, {
    expectedStage: "line_flow_polish",
    sourceScriptSha256: sha256Text(revisedScript.text),
    outputScriptSha256: sha256Text(polishedScript.text),
    openingSha256: opening.sha256,
  });
  if (!polishValidation.done
    || polish.document.source_script_sha256 !== sha256Text(revisedScript.text)
    || polish.document.winner_story_blueprint_sha256 !== blueprintSha256
    || polish.document.winner_retention_map_sha256 !== retention.sha256) {
    throw new Error(`Invalid winner line-flow polish lineage: ${polishValidation.blockers.join(", ")}`);
  }
  if (sha256Text(polishedScript.text) !== releasedSourceScriptSha256) {
    throw new Error("Winner polished script does not match the released narration hash.");
  }
  if (!polishedScript.text.startsWith(opening.text.trim())) {
    throw new Error("Winner polished script does not preserve the approved opening.");
  }

  return {
    source_workflow_profile: WINNER_SOURCE_ROOM_PROFILE,
    winner_story_blueprint_path: blueprintPath,
    winner_story_blueprint_sha256: blueprintSha256,
    audience_feedback_contract_version: blueprintDocument.audience_feedback_contract_version ?? null,
    winner_blueprint_audience_audit_path: blueprintAudienceAudit?.path ?? null,
    winner_blueprint_audience_audit_sha256: blueprintAudienceAudit?.sha256 ?? null,
    winner_blueprint_audience_audit_decision: blueprintAudienceAudit?.document?.decision ?? null,
    winner_retention_map_path: retention.path,
    winner_retention_map_sha256: retention.sha256,
    winner_opening_path: opening.path,
    winner_opening_sha256: opening.sha256,
    winner_opening_approval_path: openingApproval.path,
    winner_opening_approval_sha256: openingApproval.sha256,
    script_generation_report_path: generation.path,
    script_generation_report_sha256: generation.sha256,
    winner_development_diagnostics_manifest_path: diagnostics.path,
    winner_development_diagnostics_manifest_sha256: diagnostics.sha256,
    winner_integrated_revision_report_path: revision.path,
    winner_integrated_revision_report_sha256: revision.sha256,
    winner_line_flow_polish_report_path: polish.path,
    winner_line_flow_polish_report_sha256: polish.sha256,
  };
}
