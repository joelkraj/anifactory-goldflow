import { createHash } from "node:crypto";

import { sourceViewerPanel } from "./source-viewer-profile-bank.mjs";

export const SOURCE_VIEWER_TOURNAMENT_SCHEMA = "goldflow_simulated_manhwa_viewer_tournament_v2";
export const SOURCE_VIEWER_ACCEPTANCE_SCHEMA = "goldflow_simulated_manhwa_viewer_acceptance_v2";
export const REQUIRED_SOURCE_VIEWER_CHECKPOINTS = Object.freeze([
  "30_seconds",
  "60_seconds",
  "3_minutes",
  "5_minutes",
  "middle",
  "ending",
  "overall",
]);
export const REQUIRED_SOURCE_VIEWER_DIMENSIONS = Object.freeze([
  "opening_quality",
  "average_percentage_viewed_potential",
  "emotional_satisfaction",
  "power_fantasy_satisfaction",
  "clarity",
  "freshness",
  "ending_payoff",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedLabel(value) {
  return String(value ?? "").replace(/^SCRIPT\s+/i, "").trim().toUpperCase();
}

function normalizedDimension(value) {
  return String(value ?? "").trim().toLowerCase().replaceAll("-", "_").replace(/\s+/g, "_");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStringMap(left, right) {
  if (!left || typeof left !== "object" || Array.isArray(left)) return false;
  if (!right || typeof right !== "object" || Array.isArray(right)) return false;
  return sameJson(
    Object.entries(left).sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(right).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function scriptForLabel(report, label, candidateText, referenceText) {
  const normalized = normalizedLabel(label);
  if (normalized === normalizedLabel(report?.script_label_map?.candidate)) return candidateText;
  if (normalized === normalizedLabel(report?.script_label_map?.reference)) return referenceText;
  return null;
}

function normalizeQuotedEvidence(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

function exactExcerptExists(value, text) {
  const excerpt = String(value ?? "").trim();
  if (!excerpt) return false;
  const source = String(text ?? "");
  if (source.includes(excerpt)) return true;
  const normalizedExcerpt = normalizeQuotedEvidence(excerpt);
  if (!normalizedExcerpt) return false;
  const normalizedSource = normalizeQuotedEvidence(source);
  const first = normalizedSource.indexOf(normalizedExcerpt);
  return first >= 0 && normalizedSource.indexOf(normalizedExcerpt, first + normalizedExcerpt.length) < 0;
}

export function exactViewerExcerptExistsForTests(value, text) {
  return exactExcerptExists(value, text);
}

export function mapViewerPreference(report, preference) {
  const label = normalizedLabel(preference);
  if (label === normalizedLabel(report?.script_label_map?.candidate)) return "candidate";
  if (label === normalizedLabel(report?.script_label_map?.reference)) return "reference";
  return "tie";
}

export function evaluateViewerTournament(reports, {
  candidateText = null,
  referenceText = null,
  requireExactAnchors = false,
} = {}) {
  const expectedViewerCount = 10;
  const checkpointTallies = Object.fromEntries(
    REQUIRED_SOURCE_VIEWER_CHECKPOINTS.map((checkpoint) => [checkpoint, { candidate: 0, reference: 0, tie: 0 }]),
  );
  const dimensionTallies = {};
  const overallTallies = { candidate: 0, reference: 0, tie: 0 };
  const apvTallies = { candidate: 0, reference: 0, tie: 0 };
  const blockers = [];

  if (reports.length !== expectedViewerCount) blockers.push(`viewer_count_${reports.length}_not_${expectedViewerCount}`);
  const personaIds = reports.map((report) => String(report?.persona_id ?? "").trim());
  if (new Set(personaIds).size !== reports.length || personaIds.some((id) => !id)) blockers.push("viewer_persona_ids_invalid");

  for (const report of reports) {
    if (report?.schema !== "goldflow_simulated_manhwa_viewer_v2") blockers.push(`viewer_schema_invalid_${report?.persona_id ?? "unknown"}`);
    const seen = new Set();
    const checkpointRows = Array.isArray(report?.checkpoint_preferences) ? report.checkpoint_preferences : [];
    if (checkpointRows.length !== REQUIRED_SOURCE_VIEWER_CHECKPOINTS.length) {
      blockers.push(`viewer_${report?.persona_id ?? "unknown"}_checkpoint_count_invalid`);
    }
    for (const row of checkpointRows) {
      if (!checkpointTallies[row.checkpoint]) {
        blockers.push(`viewer_${report?.persona_id ?? "unknown"}_checkpoint_${row.checkpoint ?? "unknown"}_invalid`);
        continue;
      }
      if (seen.has(row.checkpoint)) {
        blockers.push(`viewer_${report?.persona_id ?? "unknown"}_checkpoint_${row.checkpoint}_duplicate`);
        continue;
      }
      seen.add(row.checkpoint);
      checkpointTallies[row.checkpoint][mapViewerPreference(report, row.preference)] += 1;
      if (requireExactAnchors) {
        const aScript = scriptForLabel(report, "A", candidateText, referenceText);
        const bScript = scriptForLabel(report, "B", candidateText, referenceText);
        if (!exactExcerptExists(row?.a_anchor, aScript)) blockers.push(`viewer_${report?.persona_id ?? "unknown"}_checkpoint_${row.checkpoint}_a_anchor_invalid`);
        if (!exactExcerptExists(row?.b_anchor, bScript)) blockers.push(`viewer_${report?.persona_id ?? "unknown"}_checkpoint_${row.checkpoint}_b_anchor_invalid`);
      }
    }
    for (const checkpoint of REQUIRED_SOURCE_VIEWER_CHECKPOINTS) {
      if (!seen.has(checkpoint)) blockers.push(`viewer_${report?.persona_id ?? "unknown"}_checkpoint_${checkpoint}_missing`);
    }
    overallTallies[mapViewerPreference(report, report?.overall_preference)] += 1;
    apvTallies[mapViewerPreference(report, report?.apv_preference)] += 1;
    const candidateLabel = normalizedLabel(report?.script_label_map?.candidate).replace(/^SCRIPT\s+/, "");
    const referenceLabel = normalizedLabel(report?.script_label_map?.reference).replace(/^SCRIPT\s+/, "");
    if (!["A", "B"].includes(candidateLabel) || !["A", "B"].includes(referenceLabel) || candidateLabel === referenceLabel) {
      blockers.push(`viewer_${report?.persona_id ?? "unknown"}_script_label_map_invalid`);
    }
    for (const label of ["A", "B"]) {
      const percentage = Number(report?.estimated_percentage_viewed?.[label]);
      if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
        blockers.push(`viewer_${report?.persona_id ?? "unknown"}_percentage_viewed_${label}_invalid`);
      }
    }
    const candidatePercentage = Number(report?.estimated_percentage_viewed?.[candidateLabel]);
    const referencePercentage = Number(report?.estimated_percentage_viewed?.[referenceLabel]);
    const apvPreference = mapViewerPreference(report, report?.apv_preference);
    if (
      Number.isFinite(candidatePercentage)
      && Number.isFinite(referencePercentage)
      && (
        (apvPreference === "candidate" && candidatePercentage <= referencePercentage)
        || (apvPreference === "reference" && referencePercentage <= candidatePercentage)
        || (apvPreference === "tie" && candidatePercentage !== referencePercentage)
      )
    ) blockers.push(`viewer_${report?.persona_id ?? "unknown"}_apv_preference_estimate_mismatch`);
    if (requireExactAnchors) {
      for (const label of ["A", "B"]) {
        const script = scriptForLabel(report, label, candidateText, referenceText);
        if (!exactExcerptExists(report?.earliest_leave_risk?.[label]?.exact_anchor, script)) {
          blockers.push(`viewer_${report?.persona_id ?? "unknown"}_earliest_leave_${label.toLowerCase()}_anchor_invalid`);
        }
      }
      const weakerLabel = normalizedLabel(report?.weaker_script);
      const revisionNotes = Array.isArray(report?.revision_notes) ? report.revision_notes : [];
      if (weakerLabel === "NEITHER" && revisionNotes.length > 0) {
        blockers.push(`viewer_${report?.persona_id ?? "unknown"}_revision_notes_with_no_weaker_script`);
      } else if (["A", "B"].includes(weakerLabel)) {
        const weakerScript = scriptForLabel(report, weakerLabel, candidateText, referenceText);
        for (const [index, note] of revisionNotes.entries()) {
          if (!exactExcerptExists(note?.exact_anchor, weakerScript)) {
            blockers.push(`viewer_${report?.persona_id ?? "unknown"}_revision_note_${index}_anchor_invalid`);
          }
        }
      } else {
        blockers.push(`viewer_${report?.persona_id ?? "unknown"}_weaker_script_invalid`);
      }
    }

    const dimensionRows = Array.isArray(report?.dimension_preferences) ? report.dimension_preferences : [];
    if (dimensionRows.length !== REQUIRED_SOURCE_VIEWER_DIMENSIONS.length) {
      blockers.push(`viewer_${report?.persona_id ?? "unknown"}_dimension_count_invalid`);
    }
    const seenDimensions = new Set();
    for (const row of dimensionRows) {
      const dimension = normalizedDimension(row.dimension);
      if (!REQUIRED_SOURCE_VIEWER_DIMENSIONS.includes(dimension)) {
        blockers.push(`viewer_${report?.persona_id ?? "unknown"}_dimension_${dimension || "unknown"}_invalid`);
        continue;
      }
      if (seenDimensions.has(dimension)) {
        blockers.push(`viewer_${report?.persona_id ?? "unknown"}_dimension_${dimension}_duplicate`);
        continue;
      }
      seenDimensions.add(dimension);
      dimensionTallies[dimension] ??= { candidate: 0, reference: 0, tie: 0 };
      dimensionTallies[dimension][mapViewerPreference(report, row.preference)] += 1;
      if (requireExactAnchors) {
        const aScript = scriptForLabel(report, "A", candidateText, referenceText);
        const bScript = scriptForLabel(report, "B", candidateText, referenceText);
        if (!exactExcerptExists(row?.a_anchor, aScript)) blockers.push(`viewer_${report?.persona_id ?? "unknown"}_dimension_${dimension}_a_anchor_invalid`);
        if (!exactExcerptExists(row?.b_anchor, bScript)) blockers.push(`viewer_${report?.persona_id ?? "unknown"}_dimension_${dimension}_b_anchor_invalid`);
      }
    }
    for (const dimension of REQUIRED_SOURCE_VIEWER_DIMENSIONS) {
      if (!seenDimensions.has(dimension)) blockers.push(`viewer_${report?.persona_id ?? "unknown"}_dimension_${dimension}_missing`);
    }
  }

  for (const [checkpoint, tally] of Object.entries(checkpointTallies)) {
    if (tally.candidate !== expectedViewerCount || tally.reference !== 0 || tally.tie !== 0) {
      blockers.push(`candidate_lacks_unanimous_dominance_${checkpoint}`);
    }
  }
  if (overallTallies.candidate !== expectedViewerCount) {
    blockers.push(`candidate_not_overall_choice_for_all_viewers_${overallTallies.candidate}_of_${expectedViewerCount}`);
  }
  if (apvTallies.candidate !== expectedViewerCount) {
    blockers.push(`candidate_not_apv_choice_for_all_viewers_${apvTallies.candidate}_of_${expectedViewerCount}`);
  }
  for (const dimension of REQUIRED_SOURCE_VIEWER_DIMENSIONS) {
    const tally = dimensionTallies[dimension];
    if (!tally) {
      blockers.push(`required_dimension_${dimension}_missing`);
      continue;
    }
    if (tally.candidate !== expectedViewerCount || tally.reference !== 0 || tally.tie !== 0) {
      blockers.push(`candidate_lacks_unanimous_dominance_dimension_${dimension}`);
    }
  }

  return {
    status: blockers.length === 0 ? "accepted" : "repair",
    checkpoint_tallies: checkpointTallies,
    dimension_tallies: dimensionTallies,
    overall_tallies: overallTallies,
    apv_tallies: apvTallies,
    blockers,
  };
}

export function validateViewerTournamentAcceptance(document, {
  candidateSha256 = null,
  referenceSha256 = null,
  candidateText = null,
  referenceText = null,
  manifest = null,
  manifestFileSha256 = null,
  reports = [],
  reportSha256s = null,
  requireAccepted = false,
} = {}) {
  const blockers = [];
  const expectedReportHashes = reportSha256s && typeof reportSha256s === "object" && !Array.isArray(reportSha256s)
    ? reportSha256s
    : null;
  if (document?.schema !== SOURCE_VIEWER_ACCEPTANCE_SCHEMA) blockers.push("viewer_acceptance_schema_invalid");
  if (!["accepted", "repair"].includes(document?.status)) blockers.push("viewer_acceptance_status_invalid");
  if (candidateSha256 && document?.candidate_sha256 !== candidateSha256) blockers.push("viewer_acceptance_candidate_hash_mismatch");
  if (referenceSha256 && document?.reference_sha256 !== referenceSha256) blockers.push("viewer_acceptance_reference_hash_mismatch");

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    blockers.push("viewer_acceptance_manifest_missing");
  } else {
    if (manifest.schema !== SOURCE_VIEWER_TOURNAMENT_SCHEMA) blockers.push("viewer_acceptance_manifest_schema_invalid");
    if (!String(manifest.panel_seed ?? "").trim()) blockers.push("viewer_acceptance_panel_seed_missing");
    if (manifest.viewer_count !== 10 || manifest.control_viewer_count !== 5 || manifest.rotating_viewer_count !== 5) {
      blockers.push("viewer_acceptance_panel_counts_invalid");
    }
    if (candidateSha256 && manifest.candidate_sha256 !== candidateSha256) blockers.push("viewer_acceptance_manifest_candidate_hash_mismatch");
    if (referenceSha256 && manifest.reference_sha256 !== referenceSha256) blockers.push("viewer_acceptance_manifest_reference_hash_mismatch");
    if (String(manifest.panel_seed ?? "").trim()) {
      const expectedProfileIds = sourceViewerPanel(manifest.panel_seed).map((profile) => profile.id);
      if (!sameJson(manifest.panel_profile_ids, expectedProfileIds)) blockers.push("viewer_acceptance_panel_profile_ids_mismatch");
    }
    const manifestReceipts = Array.isArray(manifest.receipts) ? manifest.receipts : [];
    if (manifestReceipts.length !== 10) blockers.push("viewer_acceptance_manifest_receipt_count_invalid");
    const receiptIds = manifestReceipts.map((receipt) => String(receipt?.persona_id ?? "").trim());
    if (new Set(receiptIds).size !== receiptIds.length) blockers.push("viewer_acceptance_manifest_receipt_ids_duplicate");
    for (const personaId of manifest.panel_profile_ids ?? []) {
      const receipt = manifestReceipts.find((row) => row?.persona_id === personaId);
      if (!receipt) {
        blockers.push(`viewer_acceptance_manifest_receipt_${personaId}_missing`);
        continue;
      }
      if (expectedReportHashes && receipt.output_sha256 !== expectedReportHashes[personaId]) {
        blockers.push(`viewer_acceptance_manifest_receipt_${personaId}_hash_mismatch`);
      }
    }
    const canonicalManifestSha256 = sha256(JSON.stringify(manifest));
    if (document?.viewer_manifest_sha256 !== canonicalManifestSha256) blockers.push("viewer_acceptance_manifest_canonical_hash_mismatch");
    if (manifestFileSha256 && document?.viewer_manifest_file_sha256 !== manifestFileSha256) {
      blockers.push("viewer_acceptance_manifest_file_hash_mismatch");
    }
  }

  if (!expectedReportHashes || Object.keys(expectedReportHashes).length !== 10) {
    blockers.push("viewer_acceptance_report_hashes_missing");
  } else if (!sameStringMap(document?.viewer_report_sha256s, expectedReportHashes)) {
    blockers.push("viewer_acceptance_report_hashes_mismatch");
  }
  if (manifest && expectedReportHashes) {
    const reportIds = Object.keys(expectedReportHashes).sort();
    const panelIds = [...(manifest.panel_profile_ids ?? [])].sort();
    if (!sameJson(reportIds, panelIds)) blockers.push("viewer_acceptance_report_ids_panel_mismatch");
  }

  const evaluation = evaluateViewerTournament(Array.isArray(reports) ? reports : [], {
    candidateText,
    referenceText,
    requireExactAnchors: candidateText != null && referenceText != null,
  });
  for (const [field, expected] of [
    ["status", evaluation.status],
    ["checkpoint_tallies", evaluation.checkpoint_tallies],
    ["dimension_tallies", evaluation.dimension_tallies],
    ["overall_tallies", evaluation.overall_tallies],
    ["apv_tallies", evaluation.apv_tallies],
    ["blockers", evaluation.blockers],
  ]) {
    if (!sameJson(document?.[field], expected)) blockers.push(`viewer_acceptance_${field}_mismatch`);
  }
  if (requireAccepted && (document?.status !== "accepted" || evaluation.status !== "accepted")) {
    blockers.push("viewer_acceptance_not_accepted");
  }
  return { done: blockers.length === 0, blockers, evaluation };
}
