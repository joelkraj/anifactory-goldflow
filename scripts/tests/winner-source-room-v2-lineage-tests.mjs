import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadSourceRoomReleaseV2Binding } from "../lib/winner-source-room-v2-lineage.mjs";
import {
  FIRST_CLASS_STORY_ROOM_PROFILE_V4,
  FRONTIER_SEMANTIC_ACCEPTANCE_REQUIREMENT_IDS,
  REFERENCE_DENSITY_DIMENSION_IDS,
  REFERENCE_DENSITY_NORMALIZATION_POLICY,
  SEMANTIC_ACCEPTANCE_REQUIREMENT_IDS,
} from "../lib/winner-source-room-v2-contract.mjs";
import {
  LONGFORM_DRAFT_PORTFOLIO_SCHEMA,
  NARRATION_REVISION_LEDGER_SCHEMA,
  STORY_TRUTH_AUDIT_SCHEMA,
  STORY_TRUTH_IR_SCHEMA,
  STORY_TRUTH_SCRIPT_MAP_SCHEMA,
} from "../lib/first-class-story-contract.mjs";
import { SOURCE_DRAFT_CANDIDATE_SPECS } from "../lib/source-model-policy.mjs";
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-source-room-v4-"));
  try {
    const candidateText = `Joey makes the stronger choice. ${Array.from({ length: 9_995 }, (_, index) => `story${index}`).join(" ")}\n`;
    const referenceText = "The reference delivers a visible reversal. The rival reacts.\n";
    const candidateAnchor = anchor(candidateText, "Joey makes the stronger choice.");
    const referenceAnchor = anchor(referenceText, "The reference delivers a visible reversal.");
    const finalScriptPath = path.join(root, "script_narration_polished.txt");
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

    const movementIds = Array.from({ length: 10 }, (_, index) => `movement_${index + 1}`);
    const packageSha256 = "1".repeat(64);
    const selectedTreatmentSha256 = "3".repeat(64);
    const architectureDocument = {
      package_sha256: packageSha256,
      selected_treatment_sha256: selectedTreatmentSha256,
      opening_semantic_contract: {},
      movements: movementIds.map((id) => ({ id })),
    };
    const simpleArtifacts = [
      ["premise_selection_v2.json", { selected: "candidate" }],
      ["package_selection_approval.json", { approved: true }],
      ["treatment_selection.json", { selected: "treatment" }],
      ["treatment_selection_approval.json", { approved: true }],
      ["story_architecture.json", architectureDocument],
      ["story_architecture_approval.json", { approved: true }],
      ["longform_draft_selection.json", { selected: "draft" }],
      ["source_revision_ledger.json", { revised: true }],
    ];
    const hashes = {};
    for (const [name, document] of simpleArtifacts) hashes[name] = await writeJson(path.join(root, name), document);

    const diagnosticPaths = {};
    const diagnosticSha256s = {};
    for (const id of ["causality_learning", "promise_continuity", "narrative_authenticity", "opening_stress", "character_agency", "anti_slop", "reference_density_dominance"]) {
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

    const promise = {
      id: "promise_title",
      source: "title",
      promise: "Joey makes a stronger choice and reverses the betrayal.",
      visible_receipt: "The betrayer witnesses the reversal.",
      spark_deadline_word: 250,
      spark_movement_id: movementIds[0],
      first_proof_deadline_word: 800,
      first_proof_movement_id: movementIds[1],
      escalation_movement_ids: [movementIds[4]],
      full_payoff_deadline_word: 9_500,
      full_payoff_movement_id: movementIds[9],
    };
    const storyTruth = {
      schema: STORY_TRUTH_IR_SCHEMA,
      status: "locked",
      package_sha256: packageSha256,
      selected_treatment_sha256: selectedTreatmentSha256,
      architecture_sha256: hashes["story_architecture.json"],
      promises: [promise, { ...promise, id: "promise_thumbnail", source: "thumbnail" }],
      causal_chains: movementIds.slice(0, 6).map((movementId, index) => ({
        id: `causal_${index + 1}`,
        pressure: "The rival applies pressure.",
        choice: "Joey chooses a counter.",
        owned_choice: true,
        consequence: "The balance changes.",
        counter: "The rival adapts.",
        changed_situation: "Joey must solve a harder problem.",
        movement_ids: [movementId],
      })),
      character_agency: [1, 2].map((number) => ({
        id: `agency_${number}`,
        character: number === 1 ? "Joey" : "Serena",
        desire: "Control the outcome.",
        pressure: "The other side closes an option.",
        decision: "Choose the costly path.",
        alternative_rejected: "Retreat.",
        consequence: "The relationship changes.",
        movement_id: movementIds[number],
      })),
      setup_payoffs: [1, 2, 3, 4].map((number) => ({
        id: `setup_${number}`,
        setup: "A usable constraint is planted.",
        setup_movement_id: movementIds[number - 1],
        payoff: "Joey uses the planted constraint.",
        payoff_movement_id: movementIds[number + 4],
        payoff_deadline_word: 8_000,
        deferral: "none",
        deferral_reason: null,
      })),
      mechanic_rules: [{
        id: "mechanic_1",
        spoken_name: "Reversal",
        trigger_or_input: "Joey chooses the costly counter.",
        observable_output: "The marked advantage changes hands.",
        limit_or_cost: "It can be used once per contest.",
        provenance: "Approved treatment.",
        first_clear_movement_id: movementIds[1],
      }],
      state_transitions: movementIds.slice(0, 6).map((movementId, index) => ({
        id: `state_${index + 1}`,
        subject: "Joey",
        state_type: "knowledge",
        from: `before ${index}`,
        to: `after ${index}`,
        cause: "His chosen counter reveals new evidence.",
        movement_id: movementId,
      })),
      reveals: [1, 2].map((number) => ({
        id: `reveal_${number}`,
        knowledge: "The betrayal has a hidden cost.",
        knower_before: "Serena",
        knower_after: "Joey",
        movement_id: movementIds[number],
        behavior_change: "Joey changes tactics.",
      })),
      narration_constraints: {
        protected_facts: ["Joey owns the decisive choice."],
        spoken_clarity_rules: ["Keep names distinct by ear."],
        pronunciation_risks: [],
      },
    };
    const storyTruthPath = path.join(root, "story_truth_ir.json");
    const storyTruthSha256 = await writeJson(storyTruthPath, storyTruth);
    const storyTruthAuditPath = path.join(root, "story_truth_audit.json");
    const storyTruthAuditSha256 = await writeJson(storyTruthAuditPath, {
      schema: STORY_TRUTH_AUDIT_SCHEMA,
      status: "passed",
      story_truth_ir_sha256: storyTruthSha256,
      findings: [],
    });

    const draftsDir = path.join(root, "drafts");
    await fs.mkdir(draftsDir);
    const portfolioCandidates = [];
    for (const spec of SOURCE_DRAFT_CANDIDATE_SPECS) {
      const outputPath = path.join(draftsDir, `${spec.id}.txt`);
      const outputSha256 = await writeText(outputPath, candidateText);
      const promptSha256 = sha256(`prompt:${spec.id}`);
      const receiptPath = `${outputPath}.meta.json`;
      const receiptSha256 = await writeJson(receiptPath, {
        schema: "goldflow_codex_call_metadata_v1",
        status: "passed",
        stage_name: `winner_source_script_v3_${spec.id}`,
        provider: spec.provider,
        transport: spec.provider === "chatgpt_web" ? "goldflow_studio_local_api" : "codex_cli",
        model: spec.model,
        reasoning_effort: spec.reasoning_effort,
        prompt_sha256: promptSha256,
        output_sha256: outputSha256,
      });
      portfolioCandidates.push({
        ...spec,
        prompt_sha256: promptSha256,
        output_path: outputPath,
        output_sha256: outputSha256,
        receipt_path: receiptPath,
        receipt_sha256: receiptSha256,
        word_count: 10_000,
        word_count_target: { minimum: 9_500, maximum: 10_500, enforcement: "advisory" },
        word_count_status: "within_target",
      });
    }
    const draftPortfolioPath = path.join(root, "longform_draft_portfolio.json");
    const draftPortfolioSha256 = await writeJson(draftPortfolioPath, {
      schema: LONGFORM_DRAFT_PORTFOLIO_SCHEMA,
      status: "completed",
      package_sha256: packageSha256,
      architecture_sha256: hashes["story_architecture.json"],
      story_truth_ir_sha256: storyTruthSha256,
      candidate_count: 6,
      candidates: portfolioCandidates,
    });

    const developmentalScriptPath = path.join(root, "script_revised.txt");
    const developmentalScriptSha256 = await writeText(developmentalScriptPath, candidateText);
    assert.equal(developmentalScriptSha256, finalScriptSha256);
    const narrationRevisionPath = path.join(root, "narration_revision_ledger.json");
    const narrationRevisionSha256 = await writeJson(narrationRevisionPath, {
      schema: NARRATION_REVISION_LEDGER_SCHEMA,
      status: "polished",
      source_script_sha256: developmentalScriptSha256,
      polished_script_sha256: finalScriptSha256,
      story_truth_ir_sha256: storyTruthSha256,
      source_word_count: 10_000,
      polished_word_count: 10_000,
      story_facts_changed: false,
      events_reordered: false,
      ending_changed: false,
      changes: [],
    });
    const mapAnchorText = "Joey makes the stronger choice.";
    const mapAnchor = anchor(candidateText, mapAnchorText);
    const mappings = [];
    const addMapping = (truthCollection, truthId, phase, movementId) => mappings.push({
      map_id: `map_${mappings.length + 1}`,
      truth_collection: truthCollection,
      truth_id: truthId,
      phase,
      movement_id: movementId,
      ...mapAnchor,
      story_function: phase === "full_payoff" ? "final_payoff" : "causal_proof",
    });
    for (const row of storyTruth.promises) {
      for (const phase of ["spark", "first_proof", "full_payoff"]) addMapping("promises", row.id, phase, row.first_proof_movement_id);
    }
    for (const collection of ["causal_chains", "character_agency", "setup_payoffs", "mechanic_rules", "state_transitions", "reveals"]) {
      for (const row of storyTruth[collection]) {
        addMapping(collection, row.id, "primary", row.movement_ids?.[0] ?? row.movement_id ?? row.first_clear_movement_id ?? row.setup_movement_id);
      }
    }
    const storyTruthMapPath = path.join(root, "story_truth_script_map.json");
    const storyTruthMapSha256 = await writeJson(storyTruthMapPath, {
      schema: STORY_TRUTH_SCRIPT_MAP_SCHEMA,
      status: "mapped",
      story_truth_ir_sha256: storyTruthSha256,
      script_sha256: finalScriptSha256,
      mappings,
    });

    const firstClassArtifactPaths = {
      premise_slate_gpt: path.join(root, "premise_slate_gpt.json"),
      premise_slate_gemini: path.join(root, "premise_slate_gemini.json"),
      premise_pool: path.join(root, "premise_pool_v3.json"),
      premise_blind_selection: path.join(root, "premise_blind_selection_v3.json"),
      premise_finalist_lineage: path.join(root, "premise_finalist_lineage.json"),
      story_truth_ir: storyTruthPath,
      story_truth_audit: storyTruthAuditPath,
      story_truth_script_map: storyTruthMapPath,
      longform_draft_portfolio: draftPortfolioPath,
      developmental_revised_script: developmentalScriptPath,
      narration_revision_ledger: narrationRevisionPath,
    };
    const firstClassArtifactSha256s = {
      premise_slate_gpt: await writeJson(firstClassArtifactPaths.premise_slate_gpt, { source: "gpt_web" }),
      premise_slate_gemini: await writeJson(firstClassArtifactPaths.premise_slate_gemini, { source: "gemini_web" }),
      premise_pool: await writeJson(firstClassArtifactPaths.premise_pool, { pooled: true }),
      premise_blind_selection: await writeJson(firstClassArtifactPaths.premise_blind_selection, { selected: "blind_a" }),
      premise_finalist_lineage: await writeJson(firstClassArtifactPaths.premise_finalist_lineage, { finalists: 6 }),
      story_truth_ir: storyTruthSha256,
      story_truth_audit: storyTruthAuditSha256,
      story_truth_script_map: storyTruthMapSha256,
      longform_draft_portfolio: draftPortfolioSha256,
      developmental_revised_script: developmentalScriptSha256,
      narration_revision_ledger: narrationRevisionSha256,
    };

    const roomContractPath = path.join(root, "source_room_contract.json");
    const roomContractSha256 = await writeJson(roomContractPath, {
      schema: "goldflow_source_room_contract_v1",
      profile: FIRST_CLASS_STORY_ROOM_PROFILE_V4,
      reference_density_required: true,
      material_reference_edges_required: true,
      viewer_tournament_required: true,
      viewer_panel_seed: "fixed-fixture-panel",
      independent_premise_room_required: true,
      story_truth_ir_required: true,
      six_draft_portfolio_required: true,
      narration_revision_required: true,
      post_upload_learning_required: true,
      draft_blind_seed: "fixed-fixture-draft-seed",
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
      source_room_profile: FIRST_CLASS_STORY_ROOM_PROFILE_V4,
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
      first_class_artifact_paths: firstClassArtifactPaths,
      first_class_artifact_sha256s: firstClassArtifactSha256s,
      post_upload_learning_contract: {
        schema: "goldflow_post_upload_story_learning_contract_v1",
        status: "pending_observation",
        observation_windows: ["24h", "72h", "7d"],
        policy: "Observational only.",
      },
      released_at: "2026-08-12T18:00:00.000Z",
    };
    await writeJson(releasePath, release);

    const binding = await loadSourceRoomReleaseV2Binding(releasePath, {
      expectedChannel: "53rebirth",
      expectedTitle: "Fixture challenger",
      expectedSourcePath: finalScriptPath,
    });
    assert.equal(binding.source_room_profile, FIRST_CLASS_STORY_ROOM_PROFILE_V4);
    assert.equal(binding.story_truth_ir_sha256, storyTruthSha256);
    assert.equal(binding.longform_draft_portfolio_sha256, draftPortfolioSha256);
    assert.equal(binding.viewer_tournament_report_sha256s[panel[0].id], reportSha256s[panel[0].id]);

    const tamperedReportPath = path.join(viewerDir, `${panel[0].id}.json`);
    const originalReport = await fs.readFile(tamperedReportPath);
    await fs.writeFile(tamperedReportPath, `${originalReport.toString("utf8").trim()} \n`);
    await assert.rejects(() => loadSourceRoomReleaseV2Binding(releasePath), /Viewer report .* hash mismatch|viewer.*hash/i);
    await fs.writeFile(tamperedReportPath, originalReport);

    const tamperedDraftPath = portfolioCandidates[0].output_path;
    const originalDraft = await fs.readFile(tamperedDraftPath);
    await fs.writeFile(tamperedDraftPath, `${originalDraft.toString("utf8").trim()} changed\n`);
    await assert.rejects(() => loadSourceRoomReleaseV2Binding(releasePath), /Draft portfolio .* output hash mismatch/i);
    await fs.writeFile(tamperedDraftPath, originalDraft);

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
