import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadSourceRoomReleaseV2Binding } from "../lib/winner-source-room-v2-lineage.mjs";
import {
  FRONTIER_SEMANTIC_ACCEPTANCE_REQUIREMENT_IDS,
  REFERENCE_DENSITY_DIMENSION_IDS,
  REFERENCE_DENSITY_NORMALIZATION_POLICY,
  REFERENCE_DENSITY_ROOM_PROFILE_V3,
  SEMANTIC_ACCEPTANCE_REQUIREMENT_IDS,
} from "../lib/winner-source-room-v2-contract.mjs";
import { sourceViewerPanel } from "../lib/source-viewer-profile-bank.mjs";
import { evaluateViewerTournament } from "../lib/source-viewer-tournament-contract.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function anchor(text, exactText) {
  const start = text.indexOf(exactText);
  assert.ok(start >= 0);
  return { start_offset: start, end_offset: start + exactText.length, exact_text: exactText };
}

async function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await fs.writeFile(filePath, bytes);
  return sha256(bytes);
}

async function writeText(filePath, value) {
  const bytes = Buffer.from(value);
  await fs.writeFile(filePath, bytes);
  return sha256(bytes);
}

function viewerReport(persona, candidateLabel, candidateText, referenceText) {
  const referenceLabel = candidateLabel === "SCRIPT A" ? "SCRIPT B" : "SCRIPT A";
  const preference = candidateLabel.replace("SCRIPT ", "");
  const aAnchor = candidateLabel === "SCRIPT A"
    ? "Joey makes the stronger choice."
    : "The reference delivers a visible reversal.";
  const bAnchor = candidateLabel === "SCRIPT B"
    ? "Joey makes the stronger choice."
    : "The reference delivers a visible reversal.";
  assert.ok(candidateText.includes("Joey makes the stronger choice."));
  assert.ok(referenceText.includes("The reference delivers a visible reversal."));
  return {
    schema: "goldflow_simulated_manhwa_viewer_v2",
    persona_id: persona.id,
    script_label_map: { candidate: candidateLabel, reference: referenceLabel },
    checkpoint_preferences: ["30_seconds", "60_seconds", "3_minutes", "5_minutes", "middle", "ending", "overall"]
      .map((checkpoint) => ({ checkpoint, preference, a_anchor: aAnchor, b_anchor: bAnchor })),
    earliest_leave_risk: {
      A: { exact_anchor: aAnchor, reason: "Fixture reason." },
      B: { exact_anchor: bAnchor, reason: "Fixture reason." },
    },
    estimated_percentage_viewed: candidateLabel === "SCRIPT A"
      ? { A: 70, B: 50, rationale: "Candidate retains a larger fraction." }
      : { A: 50, B: 70, rationale: "Candidate retains a larger fraction." },
    apv_preference: preference,
    dimension_preferences: [
      "opening_quality",
      "average_percentage_viewed_potential",
      "emotional_satisfaction",
      "power_fantasy_satisfaction",
      "clarity",
      "freshness",
      "ending_payoff",
    ].map((dimension) => ({
      dimension,
      preference,
      a_anchor: aAnchor,
      b_anchor: bAnchor,
      reason: "Candidate wins the normalized experience.",
    })),
    overall_preference: preference,
    confidence: "high",
    weaker_script: referenceLabel.replace("SCRIPT ", ""),
    revision_notes: [],
    one_sentence_verdict: "The candidate wins this fixed-panel comparison.",
  };
}

export async function runWinnerSourceRoomV2LineageTests() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-source-room-v3-"));
  try {
    const candidateText = "Joey makes the stronger choice. The inheritance changes hands.\n";
    const referenceText = "The reference delivers a visible reversal. The rival reacts.\n";
    const candidateAnchor = anchor(candidateText, "Joey makes the stronger choice.");
    const referenceAnchor = anchor(referenceText, "The reference delivers a visible reversal.");
    const finalScriptPath = path.join(root, "script_revised.txt");
    const referencePath = path.join(root, "reference_outlier_transcript.txt");
    const finalScriptSha256 = await writeText(finalScriptPath, candidateText);
    const referenceSha256 = await writeText(referencePath, referenceText);

    const frontier = {
      schema: "goldflow_reference_merit_frontier_v1",
      status: "charted",
      package_sha256: "1".repeat(64),
      selected_package_title: "Fixture challenger",
      source_outlier_id: "fixture_reference",
      reference_title: "Fixture measured reference",
      reference_path: referencePath,
      reference_sha256: referenceSha256,
      reference_word_count: referenceText.trim().split(/\s+/).length,
      normalization_policy: REFERENCE_DENSITY_NORMALIZATION_POLICY,
      dimensions: REFERENCE_DENSITY_DIMENSION_IDS.map((id) => ({
        id,
        reference_anchor: referenceAnchor,
        viewer_appetite: `${id} appetite`,
        reference_strength: `${id} strength`,
        reference_weakness: `${id} weakness`,
        candidate_dominance_obligation: `${id} obligation`,
        non_copying_boundary: `${id} boundary`,
      })),
      material_reference_edges: REFERENCE_DENSITY_DIMENSION_IDS.map((id) => ({
        edge_id: `${id}_edge`,
        dimension_id: id,
        reference_anchor: referenceAnchor,
        viewer_appetite: `${id} edge appetite`,
        reference_advantage: `${id} exact advantage`,
        candidate_dominance_obligation: `${id} exact obligation`,
        non_copying_boundary: `${id} exact boundary`,
      })),
      cross_dimension_priorities: ["Immediate proof", "Causal escalation", "Complete payoff"],
    };
    const frontierPath = path.join(root, "reference_merit_frontier.json");
    const frontierSha256 = await writeJson(frontierPath, frontier);

    const simpleArtifacts = [
      ["premise_selection_v2.json", { selected: "candidate" }],
      ["package_selection_approval.json", { approved: true }],
      ["treatment_selection.json", { selected: "treatment" }],
      ["treatment_selection_approval.json", { approved: true }],
      ["story_architecture.json", { opening_semantic_contract: {} }],
      ["story_architecture_approval.json", { approved: true }],
      ["longform_draft_selection.json", { selected: "draft" }],
      ["source_revision_ledger.json", { revised: true }],
    ];
    const hashes = {};
    for (const [name, document] of simpleArtifacts) hashes[name] = await writeJson(path.join(root, name), document);

    const diagnosticPaths = {};
    const diagnosticSha256s = {};
    for (const id of ["causality_learning", "promise_continuity", "narrative_authenticity", "reference_density_dominance"]) {
      const filePath = path.join(root, `${id}_diagnostic.json`);
      diagnosticPaths[id] = filePath;
      diagnosticSha256s[id] = await writeJson(filePath, { diagnostic_id: id, fixture: true });
    }

    const semanticAcceptance = {
      schema: "goldflow_source_semantic_acceptance_v1",
      status: "accepted",
      script_sha256: finalScriptSha256,
      reference_sha256: referenceSha256,
      reference_merit_frontier_sha256: frontierSha256,
      reference_density_diagnostic_sha256: diagnosticSha256s.reference_density_dominance,
      requirements: [
        ...SEMANTIC_ACCEPTANCE_REQUIREMENT_IDS,
        ...FRONTIER_SEMANTIC_ACCEPTANCE_REQUIREMENT_IDS,
        ...REFERENCE_DENSITY_DIMENSION_IDS.map((id) => `reference_density_${id}`),
        ...REFERENCE_DENSITY_DIMENSION_IDS.map((id) => `reference_edge_${id}_edge`),
      ].map((id) => ({ id, decision: "pass" })),
      reference_density_verdicts: REFERENCE_DENSITY_DIMENSION_IDS.map((id) => ({
        id,
        decision: "candidate_win",
        candidate_anchor: candidateAnchor,
        reference_anchor: referenceAnchor,
        density_judgment: `${id} candidate density win`,
        candidate_advantage_or_gap: `${id} candidate advantage`,
      })),
      reference_edge_verdicts: REFERENCE_DENSITY_DIMENSION_IDS.map((id) => ({
        edge_id: `${id}_edge`,
        decision: "candidate_win",
        candidate_anchor: candidateAnchor,
        reference_anchor: referenceAnchor,
        density_judgment: `${id} edge candidate density win`,
        candidate_advantage_or_gap: `${id} edge candidate advantage`,
      })),
      anchored_failures: [],
    };
    const semanticAcceptancePath = path.join(root, "source_semantic_acceptance.json");
    const semanticAcceptanceSha256 = await writeJson(semanticAcceptancePath, semanticAcceptance);
    const finalApprovalPath = path.join(root, "final_script_approval.json");
    const finalApprovalSha256 = await writeJson(finalApprovalPath, {
      schema: "goldflow_source_stage_approval_v1",
      stage_id: "final_script",
      source_sha256: finalScriptSha256,
      approved: true,
      approved_by: "fixture_operator",
      approved_at: "2026-08-12T18:00:00.000Z",
      selected_id: null,
    });

    const roomContractPath = path.join(root, "source_room_contract.json");
    const roomContractSha256 = await writeJson(roomContractPath, {
      schema: "goldflow_source_room_contract_v1",
      profile: REFERENCE_DENSITY_ROOM_PROFILE_V3,
      reference_density_required: true,
      material_reference_edges_required: true,
      viewer_tournament_required: true,
      viewer_panel_seed: "fixed-fixture-panel",
      evidence_registry_sha256: "2".repeat(64),
      created_at: "2026-08-12T18:00:00.000Z",
    });

    const viewerDir = path.join(root, "viewer_tournament");
    await fs.mkdir(viewerDir);
    const panel = sourceViewerPanel("fixed-fixture-panel");
    const reports = panel.map((persona, index) => viewerReport(
      persona,
      index % 2 === 0 ? "SCRIPT A" : "SCRIPT B",
      candidateText,
      referenceText,
    ));
    const reportSha256s = {};
    for (const report of reports) {
      reportSha256s[report.persona_id] = await writeJson(path.join(viewerDir, `${report.persona_id}.json`), report);
    }
    const manifest = {
      schema: "goldflow_simulated_manhwa_viewer_tournament_v2",
      candidate_path: finalScriptPath,
      candidate_sha256: finalScriptSha256,
      reference_path: referencePath,
      reference_sha256: referenceSha256,
      candidate_title: "Fixture challenger",
      reference_title: "Fixture measured reference",
      panel_seed: "fixed-fixture-panel",
      panel_profile_ids: panel.map((persona) => persona.id),
      control_viewer_count: 5,
      rotating_viewer_count: 5,
      viewer_count: 10,
      execution_concurrency: 5,
      receipts: reports.map((report) => ({ persona_id: report.persona_id, output_sha256: reportSha256s[report.persona_id] })),
      completed_at: "2026-08-12T18:00:00.000Z",
    };
    const manifestPath = path.join(viewerDir, "manifest.json");
    const manifestSha256 = await writeJson(manifestPath, manifest);
    const evaluation = evaluateViewerTournament(reports);
    assert.equal(evaluation.status, "accepted");
    const viewerAcceptancePath = path.join(root, "viewer_tournament_acceptance.json");
    const viewerAcceptanceSha256 = await writeJson(viewerAcceptancePath, {
      schema: "goldflow_simulated_manhwa_viewer_acceptance_v2",
      ...evaluation,
      candidate_path: finalScriptPath,
      candidate_sha256: finalScriptSha256,
      reference_path: referencePath,
      reference_sha256: referenceSha256,
      viewer_manifest_path: manifestPath,
      viewer_manifest_sha256: sha256(JSON.stringify(manifest)),
      viewer_manifest_file_sha256: manifestSha256,
      viewer_report_sha256s: reportSha256s,
      evaluated_at: "2026-08-12T18:00:00.000Z",
    });

    const releasePath = path.join(root, "source_room_release_v2.json");
    const release = {
      schema: "goldflow_source_room_release_v2",
      status: "released",
      source_workflow_profile: "evidence_story_room_v2",
      source_room_profile: REFERENCE_DENSITY_ROOM_PROFILE_V3,
      source_room_contract_path: roomContractPath,
      source_room_contract_sha256: roomContractSha256,
      channel: "53rebirth",
      development_slug: "fixture-v3-room",
      selected_title: "Fixture challenger",
      final_script_path: finalScriptPath,
      final_script_sha256: finalScriptSha256,
      evidence_registry_sha256: "2".repeat(64),
      package_selection_path: path.join(root, "premise_selection_v2.json"),
      package_selection_sha256: hashes["premise_selection_v2.json"],
      package_selection_approval_path: path.join(root, "package_selection_approval.json"),
      package_selection_approval_sha256: hashes["package_selection_approval.json"],
      treatment_selection_path: path.join(root, "treatment_selection.json"),
      treatment_selection_sha256: hashes["treatment_selection.json"],
      treatment_selection_approval_path: path.join(root, "treatment_selection_approval.json"),
      treatment_selection_approval_sha256: hashes["treatment_selection_approval.json"],
      architecture_path: path.join(root, "story_architecture.json"),
      architecture_sha256: hashes["story_architecture.json"],
      architecture_approval_path: path.join(root, "story_architecture_approval.json"),
      architecture_approval_sha256: hashes["story_architecture_approval.json"],
      longform_draft_selection_path: path.join(root, "longform_draft_selection.json"),
      longform_draft_selection_sha256: hashes["longform_draft_selection.json"],
      diagnostic_paths: diagnosticPaths,
      diagnostic_sha256s: diagnosticSha256s,
      revision_ledger_path: path.join(root, "source_revision_ledger.json"),
      revision_ledger_sha256: hashes["source_revision_ledger.json"],
      semantic_acceptance_path: semanticAcceptancePath,
      semantic_acceptance_sha256: semanticAcceptanceSha256,
      final_script_approval_path: finalApprovalPath,
      final_script_approval_sha256: finalApprovalSha256,
      reference_path: referencePath,
      reference_sha256: referenceSha256,
      reference_merit_frontier_path: frontierPath,
      reference_merit_frontier_sha256: frontierSha256,
      viewer_tournament_acceptance_path: viewerAcceptancePath,
      viewer_tournament_acceptance_sha256: viewerAcceptanceSha256,
      viewer_tournament_manifest_path: manifestPath,
      viewer_tournament_manifest_sha256: manifestSha256,
      viewer_tournament_report_sha256s: reportSha256s,
      released_at: "2026-08-12T18:00:00.000Z",
    };
    await writeJson(releasePath, release);

    const binding = await loadSourceRoomReleaseV2Binding(releasePath, {
      expectedChannel: "53rebirth",
      expectedTitle: "Fixture challenger",
      expectedSourcePath: finalScriptPath,
    });
    assert.equal(binding.source_room_profile, REFERENCE_DENSITY_ROOM_PROFILE_V3);
    assert.equal(binding.viewer_tournament_report_sha256s[panel[0].id], reportSha256s[panel[0].id]);

    const tamperedReportPath = path.join(viewerDir, `${panel[0].id}.json`);
    const originalReport = await fs.readFile(tamperedReportPath);
    await fs.writeFile(tamperedReportPath, `${originalReport.toString("utf8").trim()} \n`);
    await assert.rejects(() => loadSourceRoomReleaseV2Binding(releasePath), /Viewer report .* hash mismatch|viewer.*hash/i);
    await fs.writeFile(tamperedReportPath, originalReport);

    await fs.writeFile(finalScriptPath, `${candidateText.trim()} changed\n`);
    await assert.rejects(() => loadSourceRoomReleaseV2Binding(releasePath), /final script hash mismatch/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runWinnerSourceRoomV2LineageTests();
  console.log("winner source room v2 lineage tests passed");
}
